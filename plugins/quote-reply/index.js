// quote-reply —— 引用与 @ 规范（引不引用由她自己判断）
//
// 群主的诉求（2026-10-07 修订版）：**引不引用交给 AI 自己判断**，不要每条都硬性引用；
// 但"用引用表达在回谁、不要再用 @ 代替引用"这条要保持 —— 引用了某条消息、又 @ 那条
// 消息的发送者时，群里就会多出一行重复的"回复 @某人"。
//
// 为什么做成**插件**（plugins/，确定性型 hooks）而不是技能：
//   核心提示词 prompt.js 的 quoteAndAt() 已经写了"引用和 @ 不要叠满"和判断标准，
//   但那只写在提示词里 —— 是**请求**不是**保证**（模型服从度有限）。
//   本插件用 before-tool 钩子在发送工具真正执行**之前**做代码级检查，命中就打回，
//   并把原因原样交回给她（orchestrator.js:1147 变成「错误：…」的工具结果），
//   她照着重发即可，不是禁言。（同款做法见 plugins/reply-guard。）
//
// 默认只做两件确定性的事：
//   ① 引用了某条消息，又 @ 那条消息的发送者 → 打回（同上，"回复 @"重复）。
//   ② 引用的 id 写法不对（写成 #123、带引号…）→ 打回并给出正确写法。
//      （onebot.js 的 reply 段校验遇到这种会直接抛错、发送失败；与其让她撞一次失败，
//       不如在这里打回并说清楚。）
// 想要"每条都必须引用"的旧行为：把设置里的「每条回复都必须带引用」打开即可（requireQuote）。
//
// 三道防死循环闸门（最坏结果是偶尔漏一条，绝不能出现"她整轮说不出话"）：
//   · 同会话 10 分钟内最多打回 maxBlocksPerChat 次；
//   · 只剩最后一轮 LLM 调用时不打回；
//   · 插件自己出错一律放行。
//
// 引用目标与发言人映射只放内存（不落盘：零 IO 风险；进程重启归零，可接受）。
import { getConfig } from '../../src/config.js';

const LOG_PREFIX = '[quote-reply]';

/** 参与检查的发送工具：说话 / 表情 / 网图。 */
const TEXT_TOOLS = ['send_message'];
const MEDIA_TOOLS = ['send_sticker', 'send_image'];

/** 打回计数的统计窗口：窗口内打回次数达到上限后一律放行（防死循环）。 */
const WINDOW_MS = 10 * 60 * 1000;
/** "可引用目标"的保鲜期：比自己太旧的消息不再拿来提示/拦截（引用很久以前的消息很怪）。 */
const STALE_MS = 6 * 60 * 60 * 1000;
/** 最后 N 轮不打回：轮次快用完时打回，可能让她再也发不出话 —— 宁可漏一次。 */
const PROTECT_LAST_ROUNDS = 1;

let getCfg = () => ({});   // api.config()：本插件的设置（已合并 manifest 默认值）
let logFn = () => {};      // api.log()

const targets = new Map();      // chatKey -> { mid, senderId, senderName, snippet, ts }
const senders = new Map();      // chatKey -> Map(mid -> senderId)，判断"@的是不是被引用的那个人"
const blockCounts = new Map();  // chatKey -> { since, count }

const errText = (error) => String(error?.message ?? error ?? '未知错误');

function chatKeyOf(ctx) {
  return String(ctx?.chatKey || ctx?.session?.chatKey || ctx?.session?.key || 'default');
}

/**
 * 解析消息 id。
 *
 * 合法形态 = 非零整数（可为负），与 onebot.js 的 #replyAtSegments 同一口径 ——
 * 那边遇到不合法会直接抛错、发送失败；与其让她撞一次失败，不如在这里打回并给出正确写法。
 * @returns {{state: 'ok'|'missing'|'invalid', mid: string}}
 */
function midState(value) {
  if (value === null || value === undefined) return { state: 'missing', mid: '' };
  const s = String(value).trim();
  if (!s) return { state: 'missing', mid: '' };
  return /^-?[1-9]\d*$/.test(s) ? { state: 'ok', mid: s } : { state: 'invalid', mid: s };
}

/** 从一批消息里挑"最后一条别人发的、且有 id 的"——这就是被回复的那条。 */
function pickTarget(entries) {
  const list = Array.isArray(entries) ? entries : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const e = list[i];
    if (!e || e.self) continue;
    const { state, mid } = midState(e.mid);
    if (state !== 'ok') continue;
    return {
      mid,
      senderId: String(e.senderId || ''),
      senderName: String(e.senderName || e.senderId || '对方'),
      snippet: String(e.text || '').replace(/\s+/g, ' ').trim().slice(0, 24),
      ts: Number(e.ts) || Date.now()
    };
  }
  return null;
}

/** 记下 mid → 发言人，供"@的是不是被引用的那个人"判断使用。 */
function rememberSenders(chatKey, entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) return;
  const map = senders.get(chatKey) || new Map();
  for (const e of list) {
    const { state, mid } = midState(e?.mid);
    if (state === 'ok') map.set(mid, e?.self ? 'self' : String(e?.senderId || ''));
  }
  // 别让它无限长：只保留最近 200 条（超出的按插入顺序丢掉最老的）
  if (map.size > 200) {
    const keep = new Set([...map.keys()].slice(-200));
    for (const k of [...map.keys()]) if (!keep.has(k)) map.delete(k);
  }
  senders.set(chatKey, map);
}

function coveredTools(cfg) {
  const list = [...TEXT_TOOLS];
  if (cfg.coverMediaSends === true) list.push(...MEDIA_TOOLS);
  return list;
}

function safeParseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  try {
    const v = JSON.parse(String(raw ?? '{}'));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;   // 参数读不出来就不拦（拦了也给不出有用的提示）
  }
}

function describe(t) {
  if (!t) return '';
  const who = t.senderName || '对方';
  return t.snippet ? `${who} 发的「${t.snippet}」` : `${who} 发的那条`;
}

/** 本批要引用的目标：优先用 before-context 记下的，其次从本次会话的触发批里现找。 */
function resolveTarget(ctx, chatKey) {
  const cached = targets.get(chatKey);
  if (cached && Date.now() - cached.ts <= STALE_MS) return cached;
  const fresh = pickTarget(ctx?.session?.trigger);
  if (fresh) { targets.set(chatKey, fresh); return fresh; }
  return null;
}

/** 含本轮还剩几轮 LLM 调用（最后几轮不打回，见 PROTECT_LAST_ROUNDS）。 */
function roundsLeft(ctx) {
  try {
    const maxRounds = Math.max(1, Number(getConfig()?.api?.maxRounds) || 12);
    const done = Math.max(0, Number(ctx?.session?.rounds) || 0);
    return Math.max(1, maxRounds - done + 1);
  } catch {
    return Number.POSITIVE_INFINITY;   // 读不到就当作"还很宽裕"，不影响正常拦截
  }
}

/**
 * 决定"这次到底拦不拦"。三种情况一律放行：
 *   · 观察模式（dryRun）
 *   · 本会话窗口内已打回到上限（maxBlocksPerChat）
 *   · 只剩最后 PROTECT_LAST_ROUNDS 轮（打回可能让她再也发不出话）
 * @returns {{block: true, reason: string}|undefined}
 */
function gate(cfg, ctx, toolName, reason) {
  const chatKey = chatKeyOf(ctx);
  if (cfg.dryRun === true) {
    logFn(`${LOG_PREFIX}（观察模式）本该拦下 ${toolName}：${reason}`);
    return undefined;
  }
  if (roundsLeft(ctx) <= PROTECT_LAST_ROUNDS) {
    logFn(`${LOG_PREFIX} 只剩最后一轮，这次不打回（宁可漏一次，也不能让她说不出话）：${reason}`);
    return undefined;
  }
  const now = Date.now();
  const rec = blockCounts.get(chatKey);
  const used = rec && now - rec.since < WINDOW_MS ? Number(rec.count) || 0 : 0;
  const max = Math.max(1, Number(cfg.maxBlocksPerChat) || 2);
  if (used >= max) {
    logFn(`${LOG_PREFIX} ${chatKey} 在 ${Math.round(WINDOW_MS / 60000)} 分钟内已打回 ${used} 次，达上限，这次放行：${reason}`);
    return undefined;
  }
  blockCounts.set(chatKey, { since: used ? rec.since : now, count: used + 1 });
  logFn(`${LOG_PREFIX} 已打回 ${toolName}：${reason}`);
  return { block: true, reason };
}

export const hooks = {
  /**
   * 运行开始（提示词组装之前）：记下"这批消息最后一条别人发的"是谁、id 多少。
   *
   * 这里拿得到 ctx.store / ctx.triggerEntries（orchestrator.js:776），
   * 所以主动搭话（没有触发批）时也能从最近历史里找到可引用的对象、以及 mid→发言人。
   */
  'before-context': (ctx) => {
    try {
      const chatKey = chatKeyOf(ctx);
      let recent = [];
      try {
        recent = ctx?.store?.recent?.(chatKey, { limit: 40, offset: 0, includeSelf: true }) || [];
      } catch { recent = []; }

      rememberSenders(chatKey, ctx?.triggerEntries);
      rememberSenders(chatKey, recent);

      const target = pickTarget(ctx?.triggerEntries) || pickTarget(recent);
      if (target) targets.set(chatKey, target);
      // 找不到可引用对象（全新会话、群里还没人说话）就清掉旧记录：
      // 宁可这次不拦，也不能让她去引用上一轮的旧消息。
      else targets.delete(chatKey);
    } catch (error) {
      logFn(`${LOG_PREFIX} 记录引用目标失败（不影响运行）：${errText(error)}`);
    }
  },

  /**
   * 发送前检查（before-tool）。
   *
   * 默认（requireQuote = false，AI 自己判断要不要引用）只拦两种形态：
   *   · 引用了某条消息、又 @ 那条消息的发送者（群里重复的"回复 @"）
   *   · 引用的 id 写法不对（发送必失败，提前纠正）
   * 打开「每条回复都必须带引用」后，再额外拦"没带引用"。
   */
  'before-tool': async (ctx) => {
    try {
      const cfg = getCfg() || {};
      if (cfg.enabled === false) return undefined;

      const toolName = String(ctx?.toolName || '');
      if (!coveredTools(cfg).includes(toolName)) return undefined;

      const args = safeParseArgs(ctx?.argsRaw);
      if (!args) return undefined;

      const chatKey = chatKeyOf(ctx);
      rememberSenders(chatKey, ctx?.session?.trigger);
      const target = resolveTarget(ctx, chatKey);

      const quote = midState(args.replyToMessageId);
      const atRaw = String(args.atUserId ?? '').trim();

      // ── 检查 1：引用的 id 写法不对（写成 #123、带引号、中文数字…）──
      if (quote.state === 'invalid') {
        return gate(cfg, ctx, toolName,
          `replyToMessageId 要填消息 id 的数字本身（聊天记录里每条消息前面的 #数字，去掉 # 号），你填的是「${quote.mid}」。`
          + (target ? `这次直接填：replyToMessageId: ${target.mid}（${describe(target)}）。` : '')
          + '正文不用改，重发一次。');
      }

      // ── 检查 2（只在"强制引用"模式下）：没带引用 → 打回，并告诉她该引用哪条 ──
      if (cfg.requireQuote === true && quote.state === 'missing') {
        if (!target) {
          // 没有任何可引用的消息（群里还没人说过话）：拦下来她也没东西可引用
          logFn(`${LOG_PREFIX} 本次没有可引用的消息，放行 ${toolName}`);
          return undefined;
        }
        return gate(cfg, ctx, toolName,
          `这条消息没有带引用。请重新调用 ${toolName}：正文一个字都不用改，只补一个参数 `
          + `replyToMessageId: ${target.mid}（就是 ${describe(target)} 那条；要引用别的消息就填那条消息前面的 #数字）。`);
      }

      // ── 检查 3：@ 被引用的那个人（引用已经表达过了，再 @ 是重复）──
      if (cfg.forbidAt !== false && atRaw) {
        if (cfg.forbidAnyAt === true) {
          return gate(cfg, ctx, toolName,
            '本部署不允许用 @ 叫人：请去掉 atUserId，改用 replyToMessageId 引用你要回的那条消息'
            + '（引用气泡已经能看出在回谁）。正文不用改，重发一次。');
        }
        const quotedMid = quote.state === 'ok' ? quote.mid : '';
        const quotedSender = quotedMid ? (senders.get(chatKey)?.get(quotedMid) || '') : '';
        if (quotedSender && quotedSender !== 'self' && quotedSender === atRaw) {
          return gate(cfg, ctx, toolName,
            `不要 @ 被引用的那个人：引用气泡已经显示你在回 ${describe(target) || '他'}，`
            + '再 @ 一次，群里就会多出一行重复的"回复 @某人"。请去掉 atUserId（replyToMessageId 保留），正文不用改，重发一次。');
        }
      }
      return undefined;
    } catch (error) {
      // 本插件自己出问题绝不能拦住她说话：记一笔，放行
      try { logFn(`${LOG_PREFIX} 检查出错（已放行）：${errText(error)}`); } catch { /* 忽略 */ }
      return undefined;
    }
  }
};

/**
 * 提示词片段。
 *
 * 默认模式下只**顺着**核心规则补充用法（引不引用她自己判断；不要用 @ 代替引用），
 * 不覆盖核心的"不要每条都引用"；打开强制引用后才写成硬规则、并明确覆盖相反说法。
 * 顺手把本批可引用的 #id 给她，省掉一次查 id 的动作。
 *
 * priority 取 31/30（偏低）是刻意的：skill 片段按 priority **降序**插入，越低越靠后 ——
 * 含"随会话变化"的动态行放最后，才不会把其它 skill 片段的字节位置推来推去
 * （见 prompt.js 里关于前缀缓存的约定：静态段在前，动态段殿后）。
 */
export function promptSections(ctx = {}) {
  try {
    const cfg = getCfg() || {};
    if (cfg.enabled === false) return [];
    const sections = [];
    if (cfg.requireQuote === true) {
      sections.push({
        id: 'quote-reply-rule',
        title: '强制引用回复（本部署规则，覆盖上文相反的说法）',
        priority: 31,
        content: [
          '本部署的群主开启了「强制引用回复」：',
          '1. 你**每一条**发给群友的消息都必须带 QQ 引用 —— 调用 send_message 时参数里必须有 replyToMessageId，填消息 id 的数字（聊天记录里每条消息前面的 #数字，例如 #12345 就填 12345）；要引用别的消息就填那条的 #数字，不要自己编。messages 传数组时，只在第一条上带引用就够，整批都算引用过。',
          '2. 前面【引用与点名】里"普通对话不必引用"、人设里"不要每条都引用"的旧规则，在本部署**不生效**，以本条为准。',
          '3. 不要用 atUserId 来表达"我在回谁"：引用气泡已经显示了对象，再 @ 一次群里会多出一行重复的"回复 @某人"。只有要点名一个**不是**被引用对象的人时，才用 @。',
          '4. 如果代码层打回了你（你会看到"错误：这条消息没有带引用…"），照着里面给的 replyToMessageId 数值补上重发即可，正文不用改，也不要因此换成别的说法。'
        ].join('\n')
      });
    } else {
      sections.push({
        id: 'quote-reply-rule',
        title: '引用与 @ 的用法（引不引用由你自己判断）',
        priority: 31,
        content: [
          '引不引用由你自己判断，按上文【引用与点名】的标准来就行：需要明确"我在回哪句、回谁"时才引用。',
          '但有一条硬规则：**不要用 @ 去表达"我在回谁"** —— 你要回的人就在你引用的那条消息里，引用气泡已经显示了对象，再 @ 一次，群里就会多出一行重复的"回复 @某人"。引用了某条消息，就不要再 @ 那条消息的发送者。',
          '要点名一个**不是**被引用对象的人时，才单独 @ 他。',
          '如果代码层因此打回了你（你会看到"错误：不要 @ 被引用的那个人…"），去掉 atUserId 重发即可，正文不用改。'
        ].join('\n')
      });
    }
    const target = resolveTarget(ctx, chatKeyOf(ctx));
    if (target) {
      sections.push({
        id: 'quote-reply-target',
        title: '',
        priority: 30,
        content: `本次这批消息里，最后一条别人发的是 #${target.mid}（${describe(target)}）——如果你决定引用最新那条，用 replyToMessageId: ${target.mid}。`
      });
    }
    return sections;
  } catch (error) {
    try { logFn(`${LOG_PREFIX} 生成提示词片段失败：${errText(error)}`); } catch { /* 忽略 */ }
    return [];
  }
}

export function setup(api = {}) {
  getCfg = typeof api.config === 'function' ? api.config : () => ({});
  logFn = typeof api.log === 'function' ? api.log : () => {};
  const cfg = getCfg() || {};
  logFn(`${LOG_PREFIX} 已加载：引不引用由她自己判断`
    + `${cfg.requireQuote === true ? '（当前为强制引用模式：每条都必须带引用）' : ''}`
    + '；引用了某条消息又 @ 同一个人会被打回'
    + `${cfg.coverMediaSends === true ? '；表情/网图也一并检查' : ''}`
    + `${cfg.dryRun === true ? '；当前是观察模式（只记日志不拦截）' : ''}`);
}

export function dispose() {
  targets.clear();
  senders.clear();
  blockCounts.clear();
}
