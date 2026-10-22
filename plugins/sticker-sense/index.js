// sticker-sense —— 表情包只读情绪（确定性插件，放在 plugins/）
//
// 目标：机器人对表情包的反应要像群友，而不是像图像识别模型。
//   · 认得出：群友发的表情包是**表情**，不是一份要分析的材料；
//   · 不分析：不描述画面、不猜内容、不给它写说明（图片也不上传，省识图 token）；
//   · 有情绪：顺着情绪接一句，或者回一张表情 —— 表达情绪、活跃气氛。
//
// ── 为什么做成插件而不是 Skill ────────────────────────────────────────────
// 这三件事都是"规则能写死"的：表情包有确定的协议特征（OneBot image 段的
// summary = "[动画表情]" 或 subType = 1），"不该看图"也是硬约束 —— 满足条件
// 就必须执行，不能交给模型自己判断要不要遵守。所以走 plugins/ + hooks。
//
// ── 三个钩子各自干什么 ───────────────────────────────────────────────────
//   before-context      每轮运行开始时，把本轮触发消息里的表情包挑出来（纯本地
//                       判断，不下载图片），连存档引用一起留在会话状态里。
//   before-llm-messages ① 把即将发给模型的文本里、属于表情包消息的 [图片]
//                       改写成 [表情包]（只改这一份，存档原文不动）；
//                       ② 本轮真有表情包时，在最后一条 user 消息末尾加一小段
//                       提示：只当情绪看、别描述画面、顺情绪接话/回一张表情。
//   before-tool         模型对表情包消息调用 get_message_images 时直接拦下，
//                       工具结果换成一句「这是表情包，不用分析画面」——
//                       图片字节一个都不上传（省时间、省识图 token）。
//
// ── 关键事实（读源码确认，决定了实现方式）────────────────────────────────
//   · 收消息时图片只渲染成 [图片] 占位（src/onebot.js segmentsToText），
//     模型不会自动看到图；唯一入口是核心工具 get_message_images。
//     ⇒ "不分析内容" 只需在这一处拦下，不必碰任何媒体链路。
//   · 图片占位符对表情包和截图是同一个 [图片]，模型无从区分。
//     ⇒ 所以要在提示词里先把身份标出来（[表情包]），否则它会自己去看图。
//     标注只在"整条消息的图全是表情包"时做 —— 混着截图的消息不猜、不改写。
//   · before-context 拿得到 triggerEntries 和 store；before-llm-messages 只拿
//     得到 messages；before-tool 只有 toolName + argsRaw。三者共享的只有
//     sessionId/chatKey ⇒ 会话状态（表情包清单 + store 引用）必须在这里传递。
//   · before-tool 返回 { block: true, reason } 时，orchestrator 把 reason 原样
//     当作工具结果文本回给模型（src/orchestrator.js 里 executeTool 的 blocked
//     分支）—— 所以那句话要写成"对模型说的话"，而不是报错堆栈。
//   · 钩子只在一次模型运行内触发：没被触发会话的消息看不见。
//     ⇒ 插件天然只在"要发言/要决定发不发言"的那一刻介入，不产生额外开销。
//
// ── 边界 ────────────────────────────────────────────────────────────────
//   · 全部钩子内部 try/catch：插件出任何问题都只是"没生效"，绝不打断对话。
//   · 零网络、零第三方依赖、不写任何文件、不碰 data/stickers.json。
//   · 关掉本插件 = 完全恢复原样（改写与拦截都不再发生）。
//   · 与「表情包记忆库」(sticker-memory) 不冲突：本插件拦下的是"看图"这一步，
//     记忆库拦下的是"已知表情"的看图；但本插件拦得更早、更硬 —— 它按
//     "这条消息是不是表情包"判定，不看图库里存了什么。

const PLUGIN_ID = 'sticker-sense';
const MAX_SESSION_STATES = 64;
const SESSION_TTL_MS = 30 * 60 * 1000;
const IMAGE_TOKEN = '[图片]';
const STICKER_TOKEN = '[表情包]';
const FACE_TOKEN_RE = /\[表情\d*\]/g;
const MID_IN_LINE_RE = /#(-?\d+)\s/;

/** 与 plugin.json 的 settings 保持一致（留一份是为了加载顺序与容错）。 */
const DEFAULTS = {
  enabled: true,
  markText: true,
  blockLookup: true,
  runHint: true,
  countFace: true
};

let readConfig = () => ({ ...DEFAULTS });
let log = () => {};
let warn = () => {};

/** sessionId（或 chatKey）→ { chatKey, store, stickers: Map<mid, info>, touchedAt } */
const sessions = new Map();

// ─────────────────────────────────────────────── 配置

function conf() {
  let merged = { ...DEFAULTS };
  try {
    const raw = readConfig();
    if (raw && typeof raw === 'object') merged = { ...merged, ...raw };
  } catch { /* 配置读不到就用默认值 */ }
  return {
    enabled: merged.enabled !== false,
    markText: merged.markText !== false,
    blockLookup: merged.blockLookup !== false,
    runHint: merged.runHint !== false,
    countFace: merged.countFace !== false
  };
}

function nowMs() {
  return Date.now();
}

/**
 * 取/建一次运行的会话状态。
 * 上限 + TTL 双保险：sessionId 每次运行都是新的，不清会随会话数无限增长。
 */
function stateOf(key) {
  const k = String(key ?? 'default');
  const cutoff = nowMs() - SESSION_TTL_MS;
  for (const [sk, sv] of sessions) {
    if ((sv.touchedAt || 0) < cutoff) sessions.delete(sk);
  }
  let st = sessions.get(k);
  if (!st) {
    if (sessions.size >= MAX_SESSION_STATES) {
      let oldestKey = null;
      let oldest = Infinity;
      for (const [sk, sv] of sessions) {
        if ((sv.touchedAt || 0) < oldest) { oldest = sv.touchedAt || 0; oldestKey = sk; }
      }
      if (oldestKey) sessions.delete(oldestKey);
    }
    st = { chatKey: '', store: null, stickers: new Map(), touchedAt: nowMs() };
    sessions.set(k, st);
  }
  st.touchedAt = nowMs();
  return st;
}

// ─────────────────────────────────────────────── 识别

// QQ 表情包下发的 summary 是 "[动画表情]"（SnowLuma：subType===1 时兜底就写这个，
// 实测群里 35/61 条图片消息是它）。少数协议端还会给 "[表情]"、"[梗图]" 之类，
// 正则一并兜住；"animated / sticker / meme" 是给别的协议端留的口子。
const STICKER_SUMMARY_RE = /(动画表情|動畫表情|表情包|梗图|梗圖|meme|sticker|animated)/i;

/** 一个 media 条目是不是"表情包"（不是普通图片/截图）。 */
function isStickerImage(media) {
  if (!media || typeof media !== 'object') return false;
  if (media.kind === 'sticker') return true;      // 部分协议端直接给 sticker 段
  if (media.kind !== 'image') return false;
  const sub = Number(media.subType ?? media.sub_type ?? media.subtype);
  if (sub === 1) return true;                     // OneBot 语义：sub_type=1 表情包
  return STICKER_SUMMARY_RE.test(String(media.summary ?? ''));
}

/**
 * 分类一条存档消息：里面有多少表情包、多少 QQ 小表情、能不能安全改写/拦截。
 * 纯函数（只看 entry 的 media/text），便于自测直接驱动。
 *
 * onlyStickers 是安全闸：只有"整条消息的图**全是**表情包"才改写文本、才拦看图。
 * 混着截图/照片的消息一律不动 —— 把截图标成表情包、或拦下它的看图，
 * 都是把一个能看懂的图硬变成看不懂，比不生效更糟。
 */
function classify(entry, { countFace = true } = {}) {
  if (!entry || typeof entry !== 'object') return null;
  const media = Array.isArray(entry.media) ? entry.media : [];
  const images = media.filter((m) => m && m.kind === 'image');
  const stickerImages = images.filter(isStickerImage).length;
  const faceFromMedia = media.filter((m) => m && m.kind === 'face').length;
  const faceFromText = (String(entry.text ?? '').match(FACE_TOKEN_RE) || []).length;
  const faces = countFace ? Math.max(faceFromMedia, faceFromText) : 0;
  if (!stickerImages && !faces) return null;

  // 去掉占位符后还剩字 → 这轮表情包不是"孤立的一张图"，是配着话发的
  const bare = String(entry.text ?? '').replace(/\[[^\]]*\]/g, '').trim() === '';

  return {
    mid: String(entry.mid ?? ''),
    localId: String(entry.id ?? ''),
    senderName: String(entry.senderName ?? ''),
    stickerImages,
    faces,
    onlyStickers: stickerImages > 0 && stickerImages === images.length,
    bare
  };
}

/** 工具名去掉 Skill 前缀（sticker-memory__remember_image → remember_image）。 */
function shortToolName(name) {
  const s = String(name ?? '');
  const i = s.indexOf('__');
  if (i >= 0) return s.slice(i + 2);
  return s.includes(':') ? s.split(':').pop() : s;
}

function safeParse(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw ?? '{}')); } catch { return null; }
}

// ─────────────────────────────────────────────── 文本改写

/**
 * 把一行聊天记录里属于表情包消息的 [图片] 换成 [表情包]。
 *
 * 为什么从**末尾**往前替换：引用块里的占位符排在正文前面
 * （`[引用 张三：[图片]]正文[图片]`），一条消息有几个表情包就只换最后几个，
 * 这样被引用的那张截图不会被误标成表情包。
 */
function markLine(line, info) {
  if (!info || !info.onlyStickers || !info.stickerImages) return line;
  if (!line.includes(IMAGE_TOKEN)) return line;
  let out = line;
  let left = info.stickerImages;
  while (left > 0) {
    const at = out.lastIndexOf(IMAGE_TOKEN);
    if (at < 0) break;
    out = out.slice(0, at) + STICKER_TOKEN + out.slice(at + IMAGE_TOKEN.length);
    left -= 1;
  }
  return out;
}

/** 逐行改写一段文本（按行里的 #消息id 找到对应消息再决定改不改）。 */
export function rewriteText(text, lookup) {
  const src = String(text ?? '');
  if (!src || !src.includes(IMAGE_TOKEN)) return src;
  return src.split('\n').map((line) => {
    const m = MID_IN_LINE_RE.exec(line);
    if (!m) return line;
    let info = null;
    try { info = lookup(String(m[1])); } catch { info = null; }
    return markLine(line, info);
  }).join('\n');
}

/** 对一条 message 的所有文本部件做改写（content 可能是字符串或 parts 数组）。 */
function eachTextPart(message, fn) {
  if (!message || typeof message !== 'object') return;
  if (typeof message.content === 'string') {
    message.content = fn(message.content);
    return;
  }
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part && part.type === 'text' && typeof part.text === 'string') part.text = fn(part.text);
    }
  }
}

// ─────────────────────────────────────────────── 本轮提示

/**
 * 生成本轮的表情包提示（只在真的有表情包时返回非空串）。
 * 短短三行：谁发的 / 别分析 / 怎么回。
 */
export function buildRunHint(infos) {
  const items = (Array.isArray(infos) ? infos : []).filter((i) => i && i.stickerImages > 0);
  if (!items.length) return '';
  const total = items.reduce((sum, i) => sum + i.stickerImages, 0);
  const who = items.slice(0, 6).map((i) => {
    const bits = [`${i.stickerImages} 张表情包`];
    if (i.faces) bits.push(`${i.faces} 个 QQ 小表情`);
    const name = i.senderName || '有人';
    return `${name}${i.mid ? `(#${i.mid})` : ''}：${bits.join(' + ')}`;
  }).join('；');
  const more = items.length > 6 ? ` 等 ${items.length} 条` : '';

  const lines = [
    `【本轮表情包】${who}${more}，一共 ${total} 张。`,
    '这是表情，不是要你"看懂"的图片：不要描述画面、不要猜里面画了什么、也别给它写说明 —— 看图工具对这类消息已经关掉了。',
    '像群友一样顺着情绪接一句就够（笑、无语、吐槽、附和都行），想接梗就顺手回一张表情。别把"这是表情包"这类说明当成回复说出去。'
  ];
  if (items.some((i) => i.bare)) {
    lines.push('其中有人只丢了一张表情、没说话：那是在等你反应，别追问"你发的啥"，直接接这个情绪。');
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────── 查表

/** 建一个 mid → info 的查表器：先看本轮触发批，再回落到存档。 */
function makeLookup(st, chatKey, c) {
  const cache = new Map();
  return (mid) => {
    const key = String(mid ?? '');
    if (!key) return null;
    if (cache.has(key)) return cache.get(key);
    let info = st.stickers.get(key) || null;
    if (!info && st.store && typeof st.store.findByMid === 'function') {
      try {
        info = classify(st.store.findByMid(chatKey || st.chatKey, key), { countFace: c.countFace });
      } catch { info = null; }
    }
    cache.set(key, info);
    return info;
  };
}

// ─────────────────────────────────────────────── 钩子

export const hooks = {
  /**
   * 组装提示词之前：把本轮触发消息里的表情包挑出来。
   * 纯本地判断（只读 media 的 summary / subType），不下载、不联网、不改存档。
   */
  'before-context': async ({ triggerEntries, store, chatKey, sessionId }) => {
    try {
      const c = conf();
      if (!c.enabled) return;
      const st = stateOf(sessionId ?? chatKey);
      st.chatKey = String(chatKey || st.chatKey || '');
      if (store) st.store = store;
      st.stickers = new Map();
      for (const entry of Array.isArray(triggerEntries) ? triggerEntries : []) {
        const info = classify(entry, { countFace: c.countFace });
        if (!info) continue;
        const key = info.mid || info.localId;
        if (key) st.stickers.set(key, info);
      }
      if (st.stickers.size) {
        const n = [...st.stickers.values()].reduce((sum, i) => sum + i.stickerImages, 0);
        log(`本轮识别到 ${st.stickers.size} 条消息带表情包（${n} 张）：只当情绪，不进看图工具`);
      }
    } catch (error) {
      warn(`before-context 识别失败（不影响对话）：${error?.message ?? error}`);
    }
  },

  /**
   * 发给模型之前：① 把表情包的 [图片] 标成 [表情包]；② 本轮有表情包就加提示。
   * 只改即将发出去的那份文本，存档里的原文一个字都不动
   * （改了会污染历史，也会让"看图工具按 #消息id 取图"这件事对不上）。
   */
  'before-llm-messages': async ({ messages, chatKey, sessionId }) => {
    try {
      const c = conf();
      if (!c.enabled) return;
      const list = Array.isArray(messages) ? messages : [];
      if (!list.length) return;
      const st = stateOf(sessionId ?? chatKey);
      if (!st.chatKey) st.chatKey = String(chatKey || '');
      const lookup = makeLookup(st, chatKey, c);

      if (c.markText) {
        for (const msg of list) eachTextPart(msg, (text) => rewriteText(text, lookup));
      }

      if (c.runHint) {
        // 只提示"本轮触发批"里的表情包：历史里的表情已经翻篇了，逐条提醒只会涨 token。
        const triggerInfos = [...st.stickers.values()];
        const hint = buildRunHint(triggerInfos);
        if (hint) {
          const idx = lastUserIndex(list);
          if (idx >= 0) appendToMessage(list[idx], `\n\n${hint}`);
        }
      }
    } catch (error) {
      warn(`before-llm-messages 处理失败（不影响对话）：${error?.message ?? error}`);
    }
  },

  /**
   * 工具执行之前：拦下对表情包消息的看图调用。
   * 模型拿到的不是报错，而是"这是一张表情包，不用分析画面"这句说明 ——
   * 它会顺势接情绪，而不是继续尝试看图。
   */
  'before-tool': async ({ toolName, argsRaw, chatKey, sessionId }) => {
    try {
      const c = conf();
      if (!c.enabled || !c.blockLookup) return;
      if (shortToolName(toolName) !== 'get_message_images') return;
      const args = safeParse(argsRaw) || {};
      const mid = String(args.messageId ?? args.message_id ?? '').trim();
      if (!mid) return;
      const st = stateOf(sessionId ?? chatKey);
      const info = makeLookup(st, chatKey, c)(mid);
      if (!info || !info.onlyStickers || !info.stickerImages) return;
      log(`拦下对表情包消息 #${mid} 的看图调用（不上传图片）`);
      return {
        block: true,
        reason: '这是一张表情包，不用分析画面内容：表情包表达的是情绪，不是要读懂的内容。'
          + '顺着这个情绪接一句（或者回一张表情）就行。'
      };
    } catch (error) {
      warn(`before-tool 判定失败（放行，不影响对话）：${error?.message ?? error}`);
      return;
    }
  }
};

function lastUserIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return i;
  }
  return -1;
}

function appendToMessage(message, extra) {
  if (!message || !extra) return;
  if (typeof message.content === 'string') {
    message.content += extra;
    return;
  }
  if (Array.isArray(message.content)) {
    const lastText = [...message.content].reverse().find((p) => p && p.type === 'text');
    if (lastText) lastText.text += extra;
    else message.content.push({ type: 'text', text: extra });
  }
}

// ─────────────────────────────────────────────── 生命周期

export async function setup(api) {
  readConfig = typeof api?.config === 'function' ? api.config : (() => ({ ...DEFAULTS }));
  log = typeof api?.log === 'function' ? api.log : (() => {});
  warn = typeof api?.warn === 'function' ? api.warn : (() => {});
  const c = conf();
  log(
    `表情包只读情绪已加载：${[
      c.markText ? '标成 [表情包]' : '不改写文本',
      c.blockLookup ? '拦下看图' : '不拦看图',
      c.runHint ? '加本轮提示' : '不加提示',
      c.countFace ? '小表情算情绪' : '只听表情包'
    ].join('；')}`
  );
}

/** 自检：纯本地判断，没有外部依赖。 */
export function available() {
  return { ok: true };
}

export function deactivate() {
  sessions.clear();
}

export function dispose() {
  sessions.clear();
  readConfig = () => ({ ...DEFAULTS });
  log = () => {};
  warn = () => {};
}

/** 排障/自测用（不声明成 capability：没有别的 Skill 会消费它）。 */
export const internals = {
  conf,
  classify,
  isStickerImage,
  rewriteText,
  buildRunHint,
  shortToolName,
  stateOf,
  get sessionCount() { return sessions.size; }
};
