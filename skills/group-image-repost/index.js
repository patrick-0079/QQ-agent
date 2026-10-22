/**
 * group-image-repost —— 群图转发（LLM 型技能 / API v1）
 *
 * ── 为什么是技能（skills/），不是插件（plugins/）────────────────────────────
 * 判据（src/skills/manifest.js 的 DIR_KIND + README「扩展（两型）」）：
 *   plugins/  确定性型 —— 条件满足**必然执行**，不经过 LLM
 *   skills/   LLM 型   —— registerTool，用不用、什么时候用**由模型判断**
 *
 * 「这张图该不该发回去、该发哪一张」是语境判断题：同一张图，接梗时发很合适、
 * 别人正说正事时发就是捣乱。这种判断写不成死规则 → 只能交给模型。
 * 所以本技能**只注册工具**：不挂钩子、不声明能力。
 * （「两个人连发同一张图就自动复读」那种零模型的机械行为是**另一个** plugins/
 *   下的确定性插件，与这里互补 —— 别把两件事塞进一个扩展里。）
 *
 * ── 补的是哪条缺口 ────────────────────────────────────────────────────────
 * 收消息时图片只存成 entry.media（{ kind:'image', url, file, summary }，见
 * src/onebot.js 的 extractMediaFromSegments）。核心已经有：
 *   · 看 —— get_message_images（把别人的图喂进视觉）
 *   · 发 —— ctx.sender.sendImage（本地库/网图都能发）
 * 但没有任何地方能把「群友刚发的那张图」原样再发出去 —— 想复读一张图只能干瞪眼。
 * 本技能就是把这两条接起来：
 *   ctx.store.findByMid(chatKey, 消息号) → entry.media[i] → sendImage({ url })
 *
 * ── 踩坑备忘 ─────────────────────────────────────────────────────────────
 *   · mid 可能是负数或超大整数：store.findByMid 内部按 String() 比较，
 *     所以这里也一律 String() 后再传，别做 Number() 转换（大数会被抹精度）。
 *   · 群图的 url 带 rkey，**会过期**：所以默认只转最近 maxAgeMin 分钟内的图，
 *     过期的宁可让模型重新挑一张，也不要发出去变成裂图。
 *   · 核心发送管道自带按图去重：同一张图刚发过会抛「这张图刚刚发过，已跳过」。
 *     那是防刷屏的保护，不是故障 —— 这里翻译成人话再返回，免得模型以为坏了重试。
 *   · 转发的是独立气泡，不能和图外文字同气泡（发送管道决定的），
 *     所以工具说明里明确写了「想说话先 send_message」。
 */

import fs from 'node:fs';
import path from 'node:path';

const BUILD_TAG = 'v1.0.0';

let cfg = () => ({});
let log = () => {};
let warn = () => {};
let fetchImpl = null;

const DEFAULTS = {
  enabled: true,
  maxLookback: 60,
  maxItems: 12,
  includeSelf: false,
  maxAgeMin: 60,
  defaultReply: false
};

// ───────────────────────────── 小工具 ─────────────────────────────

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function str(v, dflt = '') {
  const s = String(v ?? '').trim();
  return s || dflt;
}

function clip(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function settings() {
  const s = (typeof cfg === 'function' ? cfg() : null) || {};
  const pick = (k) => (s[k] === undefined || s[k] === null || s[k] === '' ? DEFAULTS[k] : s[k]);
  return {
    enabled: s.enabled !== false,
    maxLookback: Math.max(10, Math.min(300, Math.round(num(pick('maxLookback'), DEFAULTS.maxLookback)))),
    maxItems: Math.max(1, Math.min(40, Math.round(num(pick('maxItems'), DEFAULTS.maxItems)))),
    includeSelf: s.includeSelf === true,
    maxAgeMin: Math.max(0, Math.min(1440, Math.round(num(pick('maxAgeMin'), DEFAULTS.maxAgeMin)))),
    defaultReply: s.defaultReply === true
  };
}

function parseArgs(raw) {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return raw || {};
}

function ok(content) { return { content: String(content) }; }
function fail(message) { return { content: `错误：${message}`, isError: true }; }

/** 「3 分钟前」这种人话，比时间戳更适合塞进模型上下文。 */
function ago(ts, now = Date.now()) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return '时间未知';
  const sec = Math.max(0, Math.round((now - t) / 1000));
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.round(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  return `${Math.round(hour / 24)} 天前`;
}

/** 一条消息里所有「能当图发」的媒体（视频/语音/戳一戳不算）。 */
function imagesOf(entry) {
  const media = Array.isArray(entry?.media) ? entry.media : [];
  return media.filter((m) => m && (m.kind === 'image' || m.kind === 'sticker'));
}

/**
 * 把媒体项解析成 sendImage 能吃的引用。
 * 优先 http(s) 直链（让协议端自己下载，body 只有几十字节）；
 * 没有直链时才退回本地绝对路径（协议端同机时能直接读盘）。
 */
function resolveSource(m) {
  const url = str(m?.url);
  if (/^https?:\/\//i.test(url)) return { url };
  const dataUrl = str(m?.dataUrl);
  if (/^data:/i.test(dataUrl)) return { dataUrl };
  const file = str(m?.file);
  if (file && path.isAbsolute(file)) {
    try { if (fs.existsSync(file)) return { file }; } catch { /* 无权限就当没有 */ }
  }
  return null;
}

/** 该不该出现在列表里：撤回的不要、按设置决定要不要包含自己发的。 */
function isUsable(entry, s) {
  if (!entry || entry.recalled === true) return false;
  if (entry.self && !s.includeSelf) return false;
  if (!imagesOf(entry).length) return false;
  return true;
}

// ───────────────────────────── 工具 ─────────────────────────────

export function setup(api) {
  if (typeof api?.config === 'function') cfg = api.config;
  if (typeof api?.log === 'function') log = api.log;
  if (typeof api?.warn === 'function') warn = api.warn;
  fetchImpl = typeof api?.fetch === 'function' ? api.fetch : null;

  api.registerTool({
    id: 'list_group_images',
    name: '看群友发过哪些图',
    description: '列出**当前会话最近带图片/表情包的消息**（谁发的、什么时候、里面有几张、#消息号是多少），'
      + '用来挑一张「可以复读 / 可以用来接话」的图。'
      + '什么时候用：① 你想转发表情包或复读群友的图，但不确定最近有什么、或者记不清是哪条消息；'
      + '② 群里刚才有人发了一张很合适的图，你要拿到它。'
      + '怎么用：不带参数 = 最近的一批；offset 翻页看更早的。拿到 #消息号后调 repost_image 转发。'
      + '注意：本工具**只列消息清单、不下载图片**（省时间省 token）。想知道某张图长什么样，'
      + '用核心的 get_message_images 传 #消息号去看。'
      + '列表里的 #消息号就是聊天记录里的那个号，可以直接照抄。',
    category: 'media',
    icon: '🖼️',
    defaultEnabled: true,
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '最多列几条带图的消息，默认 12。' },
        offset: { type: 'number', description: '跳过最近几条（翻页用），默认 0。' },
        includeSelf: { type: 'boolean', description: '是否也列出机器人自己发过的图，默认跟随设置（通常 false）。' }
      }
    },
    async execute(ctx, args) {
      const raw = parseArgs(args);
      const s = settings();
      if (!s.enabled) return fail('「群图转发」技能已被关闭。去 QQ Agent 的技能页把它打开（技能 id：group-image-repost）。');
      if (!ctx?.store || typeof ctx.store.recent !== 'function') {
        return fail('拿不到会话消息存档（核心版本可能变了），本工具当前不可用。');
      }

      const wantSelf = raw.includeSelf === true || (raw.includeSelf === undefined && s.includeSelf);
      const limit = Math.max(1, Math.min(s.maxItems, Math.round(num(raw.limit, s.maxItems))));
      const offset = Math.max(0, Math.round(num(raw.offset, 0)));

      let rows;
      try {
        rows = ctx.store.recent(ctx.chatKey, { limit: s.maxLookback, includeSelf: true }) || [];
      } catch (error) {
        return fail(`读取会话记录失败：${error?.message ?? error}`);
      }

      const now = Date.now();
      const hits = rows
        .filter((e) => isUsable(e, { ...s, includeSelf: wantSelf }))
        .filter((e) => {
          if (!s.maxAgeMin) return true;
          const t = Number(e.ts);
          return !Number.isFinite(t) || t <= 0 || (now - t) <= s.maxAgeMin * 60_000;
        })
        .reverse();   // 最近的在最前面

      if (!hits.length) {
        const why = [];
        if (!rows.length) why.push('这个会话还没有存档消息');
        else {
          if (s.maxAgeMin) why.push(`最近 ${s.maxAgeMin} 分钟内没有带图的消息`);
          if (!wantSelf) why.push('（机器人自己发的图默认不算）');
        }
        return ok(`【群图转发】最近没有可用于转发的图。${why.join('；')}。\n`
          + '这时就别转发了，正常用文字回；或者用 send_image 发本地库/网图。');
      }

      const page = hits.slice(offset, offset + limit);
      if (!page.length) {
        return ok(`【群图转发】offset=${offset} 已经翻过所有候选（共 ${hits.length} 条带图消息）。`
          + '把 offset 调小一点再试。');
      }

      const L = [];
      L.push(`【群图转发】最近 ${s.maxAgeMin ? `${s.maxAgeMin} 分钟` : '一段时间'}内带图的消息，共 ${hits.length} 条候选：`);
      page.forEach((e, i) => {
        const imgs = imagesOf(e);
        const kinds = imgs.map((m) => (m.kind === 'sticker' ? '表情包' : '图片')).join('+');
        const who = e.self ? '我' : (str(e.senderName) || '某人');
        const text = clip(e.text, 30);
        L.push(`· 第 ${offset + i + 1} 条 —— #${e.mid}｜${who}｜${ago(e.ts, now)}｜${imgs.length} 张（${kinds}）`
          + `${text ? `｜配文：${text}` : ''}`);
      });
      L.push('');
      L.push('怎么用：挑一条，调 repost_image 传它的 #消息号（messageId）就能把那张图原样发出去；'
        + '一条里有好几张时用 index 指定第几张（从 1 开始，默认 1）。');
      L.push('发之前想清楚合不合适：**别人的自拍、私人照片、聊天截图不要转**（要用先文字问一句）；'
        + '表情包、梗图随便转。同一张图别反复发 —— 发送管道会按图去重挡下来。');
      if (hits.length > offset + page.length) {
        L.push(`（还有更早的：offset 传 ${offset + page.length} 继续翻。）`);
      }
      return ok(L.join('\n'));
    }
  });

  api.registerTool({
    id: 'repost_image',
    name: '转发群友的图',
    description: '把**群里某条消息里的图片/表情包原样再发一次**（独立气泡）。这是「复读群友的图」的正解：'
      + '机器人本来只能看图、不能把别人的图再发出去，这个工具补的就是这一环。'
      + '什么时候用：① 群里两个人发了同一张图，你想跟着复读；② 别人的图正好能接你的话（吐槽/附和/认输）；'
      + '③ 有人发图挑衅，你用他这张图回敬他。'
      + '怎么用：messageId 传聊天记录里那条消息的 #号（拿不准就先 list_group_images 列一遍）；'
      + '一条消息里有好几张图时用 index 指定第几张（从 1 开始）。'
      + '**别当复读机**：同一张图别反复发（发送管道按图去重，重复发会直接报错，那是保护不是故障）；'
      + '私聊照片、自拍、聊天截图、证件/二维码这类涉及隐私的图不要转，真想用先用文字问一句。'
      + '图是独立气泡，没法和图外文字同气泡：想说话先用 send_message。',
    category: 'media',
    icon: '📤',
    defaultEnabled: true,
    parameters: {
      type: 'object',
      properties: {
        messageId: {
          type: ['integer', 'string'],
          description: '要转发的那条消息的 QQ 消息号（聊天记录里的 #数字，可能是负数）。'
        },
        index: {
          type: 'number',
          description: '这条消息里的第几张图，从 1 开始，默认 1。'
        },
        reply: {
          type: 'boolean',
          description: 'true = 带上引用回复，指向原消息（群友一眼看出复读的是谁那张）。默认跟随技能设置。'
        },
        atUserId: {
          type: ['integer', 'string'],
          description: '可选：同时 @ 某个人（QQ 号）。一般不用。'
        }
      },
      required: ['messageId']
    },
    async execute(ctx, args) {
      const raw = parseArgs(args);
      const s = settings();
      if (!s.enabled) return fail('「群图转发」技能已被关闭。去 QQ Agent 的技能页把它打开（技能 id：group-image-repost）。');

      if (!ctx?.store || typeof ctx.store.findByMid !== 'function') {
        return fail('拿不到会话消息存档（核心版本可能变了），本工具当前不可用。');
      }
      if (!ctx?.sender || typeof ctx.sender.sendImage !== 'function') {
        return fail('发送通道不可用（ctx.sender.sendImage 缺失），请检查核心版本。');
      }

      const mid = raw.messageId;
      if (mid === undefined || mid === null || String(mid).trim() === '') {
        return fail('必须传 messageId（那条消息的 #号）。先调 list_group_images 看看有哪些候选。');
      }

      const entry = ctx.store.findByMid(ctx.chatKey, String(mid).trim());
      if (!entry) {
        return fail(`当前会话里找不到消息 #${mid}。它可能已经被存档清理掉了 —— `
          + '调 list_group_images 看现在还能转发哪些图。');
      }
      if (entry.recalled === true) {
        return fail(`#${mid} 已经被撤回了，不能再转发。挑别的图吧。`);
      }
      if (entry.self && !s.includeSelf) {
        return fail(`#${mid} 是机器人自己发的，按设置不能转发自己的图（如确实需要，`
          + '去技能设置里打开「允许转发自己发过的图」）。');
      }

      const imgs = imagesOf(entry);
      if (!imgs.length) {
        const kinds = (Array.isArray(entry.media) ? entry.media : []).map((m) => m?.kind).filter(Boolean);
        return fail(`#${mid} 里没有图片/表情包${kinds.length ? `（只有 ${[...new Set(kinds)].join('、')}）` : ''}。`
          + '换一条带图的消息。');
      }

      // 只转发新鲜的：QQ 的图片链接带 rkey 会过期，转过旧的图发出去是裂图。
      const ts = Number(entry.ts);
      if (s.maxAgeMin && Number.isFinite(ts) && ts > 0 && (Date.now() - ts) > s.maxAgeMin * 60_000) {
        return fail(`#${mid} 是 ${ago(ts)}发的，超过了「只转发最近 ${s.maxAgeMin} 分钟内」的限制 —— `
          + 'QQ 的图片链接会过期，转旧图发出去多半是裂图。挑一张新一点的，'
          + '或者去技能设置里把「只转发最近多少分钟内的图」调大/填 0。');
      }

      const idx = Math.max(1, Math.round(num(raw.index, 1)));
      const picked = imgs[idx - 1];
      if (!picked) {
        return fail(`#${mid} 里只有 ${imgs.length} 张图，没有第 ${idx} 张。index 从 1 开始。`);
      }

      const src = resolveSource(picked);
      if (!src) {
        return fail(`#${mid} 的第 ${idx} 张图拿不到可用的地址（协议端可能还没落盘，或链接已失效）。`
          + '过一会儿重试，或者换一张图。');
      }

      const opts = {
        note: raw.note ? clip(raw.note, 40) : undefined,
        replyToMessageId: raw.reply === true || (raw.reply === undefined && s.defaultReply) ? entry.mid ?? null : null,
        atUserId: str(raw.atUserId) || null
      };

      try {
        const result = await ctx.sender.sendImage(ctx.chatKey, src, opts);
        log(`转发群图：${ctx.chatKey} #${mid} 第 ${idx} 张（${src.url ? 'url' : (src.file ? 'file' : 'dataUrl')}）`);
        // 记进本次会话的发送记录（和核心 send_image 工具保持一致，会话页才看得到）。
        try {
          ctx.session?.sent?.push({
            type: 'image',
            text: `[图片:转发群友${entry.self ? '（自己）' : ` ${clip(entry.senderName, 16)}`}的 #${mid}]`,
            at: new Date().toLocaleTimeString('zh-CN', { hour12: false })
          });
          if (ctx.session?.id) ctx.emit?.('session-update', ctx.session.id);
        } catch { /* 记录失败不影响发送结果 */ }
        return ok(`已把 #${mid} 的第 ${idx} 张图原样转发到当前会话${opts.replyToMessageId ? '（带引用回复）' : ''}。`
          + `messageId=${result?.message_id ?? '未知'}。`
          + '这是一条独立气泡；如果还想说话，用 send_message 另外发。');
      } catch (error) {
        const msg = String(error?.message ?? error);
        // 按图去重是保护措施，单独翻译，免得模型以为工具坏了反复重试。
        if (/刚刚发过|已跳过/.test(msg)) {
          return ok(`这张图刚发过了，发送管道按图去重挡了下来（防止刷屏）。`
            + '换个说法用文字接话，或者挑别的图；同一个梗连着刷两遍反而不好笑。');
        }
        warn(`转发群图失败 #${mid} 第 ${idx} 张：${msg}`);
        return fail(`图片发送失败：${msg}`);
      }
    }
  });

  log(`群图转发已加载（${BUILD_TAG}）｜工具 list_group_images / repost_image｜`
    + `回看 ${settings().maxLookback} 条、只转 ${settings().maxAgeMin || '不限'} 分钟内的图`);
}

/** 测试/排障用导出。 */
export const __internals = { settings, imagesOf, resolveSource, isUsable, ago, parseArgs };
