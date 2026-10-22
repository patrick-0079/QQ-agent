// 睡觉时间（sleep-schedule）—— 确定性型插件 / plugins/
//
// ── 为什么是插件而不是技能 ────────────────────────────────────────────────
// 用户的原话是「晚上到点实行睡觉行为，不会回复任何消息」。
// 这是一条**能写死的规则**（只看时间），而且要求是「保证不回」——
// 正好是文档说的「规则能写死 → plugins/」。
// 反过来做成技能会有两个致命问题：
//   ① 技能是"给模型一个工具"，模型得先被叫醒、先烧 token，才可能决定"我不回"；
//      睡觉期间每次有人说话都要花一次调用，而这笔钱本来一分都不用花。
//   ② 被 @ 时核心规则要求它必须回 —— 技能的提示词优先级被强制压在核心规则之下，
//      想覆盖也覆盖不掉。插件是核心按能力取用、满足条件必然执行，模型忽略不掉。
//
// ── 静默是怎么真正做到"一个 token 都不花"的 ───────────────────────────────
// 靠 `chat.ban-state` 能力。orchestrator.wake() 在建会话之前会问这个能力：
//   「这个群现在能不能发消息？」── 说不能，就把未读标记为已读后 **直接 return**，
// 不创建会话、不调模型。于是睡觉期间模型压根没被叫醒。
// ⚠️ 这个能力原本是为"机器人被禁言"设计的。这里复用它做作息，语义上略宽，
//    所以：① 有开关可关；② 另外用 before-tool 兜一层硬拦发送类工具，
//    不把"不回复"这件事全押在一个能力的未来实现上。
//
// ── 两段式：先道别，再彻底静默 ────────────────────────────────────────────
// 用户要的是「如果正在和人聊天，会说困了然后去睡」。一刀切会显得很突兀，所以：
//   刚进入睡觉时段 → 进「道别窗口」（默认 10 分钟）。窗口内模型仍会被叫醒，
//                     并收到一条指令：用你自己的口气说一句困了、先去睡了。
//   它真的说过一句之后 → 本段睡眠立刻转为静默（后面全被 chat.ban-state 挡住）。
//   窗口过后还没说    → 也直接转静默（没人在聊就别冒出来道别了）。
// 判断"它说过了"不靠状态文件：直接看聊天记录里有没有它自己发的消息 ——
// 所以插件本身完全无状态，热重载、重复 setup 都无害，也没有写盘竞态。
//
// ── 睡前的"没人理就别道别" ────────────────────────────────────────────────
// 只有窗口内还有人在说话（最后一条非自己的消息在 minGapMinutes 之内）才道别；
// 否则凌晨三点突然来一句「我先睡了」会很怪。

import { getConfig } from '../../src/config.js';

let api = null;

const MINUTE = 60000;

/** 发送类工具：睡觉时必须发不出去（兜底那一层）。 */
const SEND_TOOLS = new Set(['send_message', 'send_to', 'send_sticker', 'send_poke', 'send_image']);

/** 设置读取 + 归一化。任何一项写错都不该让插件炸掉，一律回落到默认值。 */
function settings() {
  const raw = (api && typeof api.config === 'function' ? api.config() : null) || {};
  const num = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const grace = Math.max(0, num(raw.graceMinutes, 10));
  return {
    enabled: raw.enabled !== false,
    sleepStart: parseHm(raw.sleepStart, 23 * 60),
    sleepEnd: parseHm(raw.sleepEnd, 7 * 60),
    graceMinutes: grace,
    // 私聊窗口不能比群里的道别窗口还短：那样会出现「群里刚说完困了，
    // 私聊立刻变哑巴」的割裂感。取两者较大值。
    privateGraceMinutes: Math.max(grace, Math.max(0, num(raw.privateGraceMinutes, 30))),
    ownerCallable: raw.ownerCallable !== false,
    // 睡着时说话要不要"迷迷糊糊"（短、带错别字、语句不完整）
    sleepTalk: raw.sleepTalk !== false,
    sleepTalkTypoChance: Math.max(0, Math.min(80, num(raw.sleepTalkTypoChance, 25))),
    minGapMinutes: Math.max(0, num(raw.minGapMinutes, 15)),
    goodnight: raw.goodnight !== false,
    jitterMinutes: Math.max(0, num(raw.jitterMinutes, 60)),
    blockSendTools: raw.blockSendTools !== false,
    chatKeys: String(raw.chatKeys ?? '').split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean)
  };
}

function parseHm(value, fallback) {
  const m = String(value ?? '').trim().match(/^(\d{1,2})\s*[:：]\s*(\d{1,2})$/);
  if (!m) return fallback;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!(h >= 0 && h <= 23 && min >= 0 && min <= 59)) return fallback;
  return h * 60 + min;
}

const pad2 = (n) => String(n).padStart(2, '0');
const hm = (minutes) => `${pad2(Math.floor((minutes % 1440) / 60))}:${pad2(minutes % 60)}`;
const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const clock = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

/** 本地时间的"当天分钟数"，带秒，便于和时段做精确比较。 */
const nowMinutes = (now) => now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;

/** 稳定散列：同一天同一个会话得到同一个偏移，所以同一天内不会来回抖。 */
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 当天生效的睡觉/起床时刻（都带浮动）。
 * 跨午夜由核心侧处理：跨夜时"睡点"取昨天那一次 —— 在凌晨 1 点，你说的 23:00
 * 指的必然是**昨天**的 23:00，写成今天的 23:00 会算出 0 点才入睡。
 */
function effectiveWindow(cfg, now, chatKey = '') {
  const offset = cfg.jitterMinutes > 0
    ? (hash(`${dayKey(now)}|${chatKey}`) % (cfg.jitterMinutes * 2 + 1)) - cfg.jitterMinutes
    : 0;
  const crosses = cfg.sleepStart >= cfg.sleepEnd;
  const startDay = crosses && nowMinutes(now) < cfg.sleepEnd
    ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
    : now;
  const startDate = new Date(startDay.getFullYear(), startDay.getMonth(), startDay.getDate());
  const endDay = crosses
    ? new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + 1)
    : startDate;

  const at = (base, minutes) => {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
    d.setMinutes(minutes);
    return d;
  };
  const start = at(startDate, cfg.sleepStart + offset);
  const end = at(endDay, cfg.sleepEnd + offset);
  return { start, end, offset };
}

function isSleeping(cfg, now, chatKey = '') {
  const w = effectiveWindow(cfg, now, chatKey);
  const t = now.getTime();
  return t >= w.start.getTime() && t < w.end.getTime();
}

/** 这个会话要不要受作息管（chatKeys 留空 = 全管）。 */
function inScope(cfg, chatKey) {
  if (!cfg.chatKeys.length) return true;
  const key = String(chatKey || '');
  const id = key.split(':')[1] || '';
  return cfg.chatKeys.some((k) => k === key || (id && k.split(':')[1] === id));
}

// ── 主人判定（"单独开个口"）─────────────────────────────────────────────
//
// 优先问 owner-identity 插件的能力 —— 这样"谁是主人"只有一处口径，
// 主人在「插件 → 主人识别」里改号码、关插件、改 scope，这里立刻跟着变，
// 不会出现两套身份判断打架。拿不到能力时才回落到直接读它的配置。
//
// ⚠️ 只在睡觉时被调用（每条消息至多一次），不是热路径，可以放心读配置。

/** 回落路径：直接读该插件的 ids 配置（带 2 秒缓存，免得睡觉时每条消息都读盘）。 */
let ownerCache = { at: 0, ids: [] };
function ownerIdsFromConfig() {
  const now = Date.now();
  if (now - ownerCache.at < 2000) return ownerCache.ids;
  let ids = [];
  try {
    const conf = getConfig()?.skills?.['owner-identity'] || {};
    if (conf.enabled !== false) {
      ids = String(conf.ids ?? '')
        .split(/[,，;；\s]+/)
        .map((s) => s.trim())
        .filter((s) => /^\d{5,12}$/.test(s));
    }
  } catch {
    ids = [];
  }
  ownerCache = { at: now, ids };
  return ids;
}

/**
 * 说话的人是不是主人（= 可以把它叫醒的人）。
 * @param {object} ctx hook 上下文（要有 store / chatKey / triggerEntries）
 * @returns {boolean}
 */
function isOwnerCall(ctx = {}) {
  const selfId = String(ctx.selfId ?? '');
  const chatKey = String(ctx.chatKey || '');
  const isPrivate = chatKey.startsWith('private:') || ctx.kind === 'private';

  // 自己先判一遍（号码 × "在叫机器人"）。
  // ⚠️ 不把这件事全托给 message.owner-check：那条能力是否判得出私聊，取决于
  //    **别人的实现**有没有把 kind/chatKey 传对 —— 实测中能力方若拿不到
  //    chatKey，私聊就会被误判成"没在叫机器人"。这是别人代码的假设，不该由
  //    本插件承担，所以这里自带一份判定，能力只当加速器。
  const ownedByMe = (() => {
    try {
      const ids = ownerIdsFromConfig();
      if (!ids.length) return false;
      for (const m of ctx.triggerEntries || []) {
        if (!m || m.self) continue;
        const sid = String(m.senderId ?? '');
        if (!sid || sid === 'self' || !ids.includes(sid)) continue;
        if (m.atMe === true || m.atAll === true || isPrivate) return true;
        if (selfId && String(m.reply?.senderId ?? '') === selfId) return true;
      }
    } catch { /* 读不到就交给能力 */ }
    return false;
  })();
  if (ownedByMe) return true;

  try {
    const r = api?.capability?.('message.owner-check', {
      triggerEntries: ctx.triggerEntries,
      kind: isPrivate ? 'private' : 'group',
      chatKey,
      selfId,
      store: ctx.store
    });
    if (r) return true;      // 能力在、且判定为"主人在跟机器人说话"
  } catch { /* 能力坏了就用上面那一份判定 */ }
  return false;
}

// ── "它说过话了吗"：从聊天记录里看，不落盘 ─────────────────────────────────

let storeRef = null;
let lastSpoke = { chatKey: '', at: 0, value: false };

/**
 * 本段睡眠开始后，机器人自己有没有发过消息。
 * 用来判断"道别已经说完了" —— 说了就从"允许道别"转成"彻底静默"。
 * 结果缓存 1 秒：这个函数会被每条消息问到，不能每次翻聊天记录。
 */
function hasSpokenSince(store, chatKey, since) {
  const now = Date.now();
  if (storeRef === store && lastSpoke.chatKey === chatKey && now - lastSpoke.at < 1000) {
    return lastSpoke.value;
  }
  let value = false;
  try {
    const recent = store?.recent?.(chatKey, { limit: 20, includeSelf: true }) || [];
    for (const m of recent) {
      if (!m?.self) continue;
      if (Number(m.ts || 0) > Number(since || 0)) { value = true; break; }
    }
  } catch {
    value = false;   // 读不到就当没说过（最多多说一句道别，不会漏睡）
  }
  storeRef = store;
  lastSpoke = { chatKey, at: now, value };
  return value;
}

/**
 * 睡眠状态判定（唯一口径）。
 *
 * phase 三档（顺序即优先级）：
 *   'off'      不在睡觉时段 —— 照常
 *   'owner'    主人在说话 —— 单独开的那个口，照常回（除非关掉 ownerCallable）
 *   'goodnight' 刚睡下：允许它说那句"困了"，私聊窗口更长
 *   'silent'   睡熟了 —— 群里零成本硬闸，私聊仍然会被叫醒但一个字不发
 *
 * @param {object} cfg
 * @param {string} chatKey
 * @param {Date}   now
 * @param {object} store
 * @param {boolean|null} ownerSpeaking  主人是否在说话（null = 不判/不适用）
 */
function sleepState(cfg, chatKey, now, store, ownerSpeaking = null) {
  const window = effectiveWindow(cfg, now, chatKey);
  if (!isSleeping(cfg, now, chatKey)) {
    return { sleeping: false, quieted: false, phase: 'off', window, graceEnd: 0, untilWake: 0 };
  }

  // ⚠️ 这里**不要**再自己推算一次日期。
  //    effectiveWindow 返回的 sleepStart 已经带正确日期了：凌晨 1 点时它就是
  //    **昨天** 23:00。曾经在这里用"今天"重建了一次时间戳，于是跨午夜后
  //    graceEnd 变成"今天 23:10"（还在未来）→ quieted 恒为 false →
  //    整晚都卡在道别窗口里继续回话。干跑时表现为 01:00 和 06:59 都不静默。
  const privateChat = String(chatKey).startsWith('private:');
  const graceMinutes = privateChat ? cfg.privateGraceMinutes : cfg.graceMinutes;
  const graceEnd = window.start.getTime() + graceMinutes * MINUTE;
  const t = now.getTime();

  if (cfg.ownerCallable && ownerSpeaking === true) {
    return { sleeping: true, quieted: false, phase: 'owner', window, graceEnd, untilWake: window.end.getTime() - t };
  }

  // 道别是"给这个会话里正在聊的人"的：只有还没说过、且开着道别，才算刚睡下。
  const spoke = hasSpokenSince(store, chatKey, window.start.getTime());
  const quieted = !cfg.goodnight || t >= graceEnd || spoke;
  return {
    sleeping: true,
    quieted,
    phase: quieted ? 'silent' : 'goodnight',
    window,
    graceEnd,
    untilWake: window.end.getTime() - t
  };
}

/**
 * 主人最近有没有在这个会话里说过话。
 *
 * 为什么需要它：核心问「能不能发消息」时**不告诉我们是谁在说话**
 * （它只传 chatKey），所以查不到"主人正在 @ 我"。退一步用"主人刚开口过"
 * 来近似 —— 半夜主人在群里 @ 一下，这一次就会被放行。
 *
 * ⚠️ 这个窗口**就是"别人能蹭到多久"的窗口**，刻意收得很短（默认 1 分钟）：
 *    实测 4 分钟时，主人 00:08:03 一开口，别人 00:08:30 和 00:08:44 的消息
 *    也全被放行了 —— 用户要的是"只对主人开口"，不是"叫醒后陪所有人聊"。
 */
const OWNER_WINDOW_MS = 60 * 1000;
function ownerRecentlySpoke(store, chatKey, nowMs, windowMs = OWNER_WINDOW_MS) {
  try {
    const ids = ownerIdsFromConfig();
    if (!ids.length) return false;
    const recent = store?.recent?.(chatKey, { limit: 12, includeSelf: true }) || [];
    for (const m of recent) {
      if (!m || m.self) continue;
      const sid = String(m.senderId ?? '');
      if (!ids.includes(sid)) continue;
      if (nowMs - Number(m.ts || 0) <= windowMs) return true;
    }
  } catch { /* 读不到就当不是主人 */ }
  return false;
}

// ── 睡着时的"迷迷糊糊"────────────────────────────────────────────────────
//
// 两个手段：
//   ① 提示词层：告诉模型用很短、很困、说不利索的方式回（before-llm-messages 里注入）
//   ② 发送层：给文字真打几个错别字（下面 patchSendQueue）
//
// ⚠️ ②是给 SendQueue.prototype 打补丁 —— 与现有「打字模拟」插件同一套做法，
//    差别是**判定按需**：只有"睡着且还没睡死"（phase='goodnight'）才动手，
//    而且每次发送都重新读设置。这样热重载后旧闭包留在原型上也无害。
//
// ⚠️ 绝不能直接 import 打字模拟插件的 makeTypo：它没导出，而且两个插件互相
//    依赖会导致一方重载时另一方静默失效。自带一份小表，互不牵连。

/** 中文输入法下最常见的同音/形近手滑。 */
const HOMOPHONES = [
  ['在', '再'], ['的', '得'], ['已', '己'], ['应', '因'], ['那', '哪'],
  ['是', '事'], ['候', '后'], ['象', '像'], ['困', '昆'], ['睡', '水'],
  ['说了', '说乐'], ['睡啦', '水啦'], ['不要', '不药'], ['明天', '名天'], ['晚安', '玩安']
];

const TYPO_MARK = Symbol.for('sleep-schedule.sendPatch');

function randInt(n) { return Math.floor(Math.random() * n); }

/** 造一个错字版本。返回 {text, kind} 或 null（造不出来）。 */
function makeSleepTypo(text) {
  const s = String(text ?? '');
  const arr = [...s];
  if (arr.length < 2) return null;
  const styles = ['swap', 'swap', 'homophone', 'drop'];
  const style = styles[randInt(styles.length)];

  if (style === 'homophone') {
    const hits = HOMOPHONES.filter(([from]) => s.includes(from));
    if (hits.length) {
      const [from, to] = hits[randInt(hits.length)];
      const at = s.indexOf(from);
      return { text: s.slice(0, at) + to + s.slice(at + from.length), kind: '同音字' };
    }
  }
  if (style === 'swap') {
    const i = randInt(arr.length - 1);
    if (arr[i] !== arr[i + 1] && !/\s/.test(arr[i]) && !/\s/.test(arr[i + 1])) {
      const out = [...arr];
      [out[i], out[i + 1]] = [out[i + 1], out[i]];
      return { text: out.join(''), kind: '两个字打反' };
    }
  }
  if (style === 'drop' && arr.length > 3) {
    const cands = arr.map((ch, i) => (/[\u4e00-\u9fa5]/.test(ch) ? i : -1)).filter((i) => i >= 0);
    if (cands.length) {
      const i = cands[randInt(cands.length)];
      return { text: arr.filter((_, k) => k !== i).join(''), kind: '漏打一个字' };
    }
  }
  if (arr.length >= 2) {
    const out = [...arr];
    [out[0], out[1]] = [out[1], out[0]];
    if (out.join('') !== s) return { text: out.join(''), kind: '两个字打反' };
  }
  return null;
}

let sendCache = null;    // 原方法（跨热重载共用，靠原型上的标记判断是否已打）
function patchSendQueue() {
  if (!sendCache) {
    try {
      const proto = api?.sender?.constructor?.prototype;
      if (proto && typeof proto.sendTextBatch === 'function' && !proto[TYPO_MARK]) {
        const orig = proto.sendTextBatch;
        proto.sendTextBatch = function patchedSendTextBatch(chatKey, messages, options) {
          try {
            const cfg = settings();
            if (cfg.enabled && cfg.sleepTalk) {
              const key = String(chatKey || '');
              if (inScope(cfg, key)) {
                const phase = sleepState(cfg, key, new Date(), storeRef, isOwnerCall({ chatKey: key })).phase;
                // 只在"刚睡下、还没睡死"时迷糊；主人开口和完全睡死都不动手
                if (phase === 'goodnight') {
                  const list = (Array.isArray(messages) ? messages : [messages]).map((m) => {
                    const s = String(m ?? '');
                    if (s.length < 2 || s.length > 30) return m;
                    if (Math.random() * 100 >= cfg.sleepTalkTypoChance) return m;
                    const t = makeSleepTypo(s);
                    if (t) log(`睡着时说糊涂话（${t.kind}）：「${t.text}」`);
                    return t ? t.text : m;
                  });
                  return orig.call(this, chatKey, list, options);
                }
              }
            }
          } catch (error) {
            log('睡眠错字补丁出错（按原样发送）：%s', error?.message ?? error);
          }
          return orig.call(this, chatKey, messages, options);
        };
        Object.defineProperty(proto, TYPO_MARK, { value: true, enumerable: false });
      }
      sendCache = proto?.sendTextBatch ?? null;
    } catch (error) {
      log('挂睡眠错字补丁失败（不影响睡觉本身）：%s', error?.message ?? error);
      sendCache = null;
    }
  }
  return Boolean(sendCache);
}

// ── 插件入口 ──────────────────────────────────────────────────────────────

export function setup(injected) {
  api = injected;
  const cfg = settings();
  const now = new Date();
  const w = effectiveWindow(cfg, now, '');
  const state = cfg.enabled ? '已启用' : '已关闭';
  const patched = patchSendQueue();
  api.log?.(
    `睡觉时间${state}：睡 ${hm(cfg.sleepStart)} → 醒 ${hm(cfg.sleepEnd)}`
    + `（每日浮动 ±${cfg.jitterMinutes} 分）`
    + `；道别窗口 群 ${cfg.graceMinutes} 分 / 私聊 ${cfg.privateGraceMinutes} 分${cfg.goodnight ? '' : '（已关道别）'}`
    + `；主人开口 ${cfg.ownerCallable ? '开（窗口 1 分钟）' : '关'}`
    + `；迷糊话 ${cfg.sleepTalk ? `开（手滑概率 ${cfg.sleepTalkTypoChance}%${patched ? '' : '，但发送补丁没挂上'}）` : '关'}`
    + `；${cfg.chatKeys.length ? `只管 ${cfg.chatKeys.join('、')}` : '所有群与私聊'}`
    + `；今天这一段：${w.start.toLocaleString('zh-CN', { hour12: false })} 睡 → `
    + `${w.end.toLocaleString('zh-CN', { hour12: false })} 醒`
  );
}

export const providers = {
  /**
   * 核心在建会话之前问「这个群现在能发消息吗」。说不能 → 核心标记已读后直接返回，
   * 不创建会话、不调模型。这就是"睡觉期间 0 token"的所在。
   *
   * ⚠️ 只在 group: 会话上被问（核心那一处判断是 startsWith('group:')）。
   *    私聊靠下面的 before-tool 兜底。
   */
  'chat.ban-state': (ctx = {}) => {
    const cfg = settings();
    if (!cfg.enabled) return { known: true, muted: false };
    const chatKey = String(ctx.chatKey || '');
    if (!inScope(cfg, chatKey)) return { known: true, muted: false };
    // 主人开口：这里有两条路 ——
    //   ① 上面那段（能查到是谁）走能力判定；
    //   ② 查不到时，看主人最近有没有在这个会话里说过话（默认 1 分钟），
    //      这样"群里主人 @ 一下就能把它薅起来"也能生效。窗口收得很短，
    //      是为了不让别人蹭着主人的口子一起被放行（实测过 4 分钟太宽）。
    const ownerSpeaking = cfg.ownerCallable
      ? (isOwnerCall(ctx) || ownerRecentlySpoke(ctx.store, chatKey, Date.now()))
      : false;
    const st = sleepState(cfg, chatKey, new Date(), storeRef, ownerSpeaking);
    if (!st.sleeping || !st.quieted) return { known: true, muted: false };
    return { known: true, muted: true, reason: '睡觉时间', untilWake: st.untilWake };
  },

  /** 控制台的「能力」列表里能看到它在干什么（顺带证明插件真的加载了）。 */
  'status.sleep-schedule': () => {
    const cfg = settings();
    if (!cfg.enabled) {
      return { icon: '😴', title: '睡觉时间', lines: [['状态', '已关闭']], tips: [], priority: 55 };
    }
    const now = new Date();
    const st = sleepState(cfg, '', now, storeRef);
    if (!st.sleeping) {
      return {
        icon: '🙂',
        title: '睡觉时间',
        lines: [
          ['状态', `醒着（${hm(cfg.sleepStart)} 睡）`],
          ['私聊', cfg.privateGraceMinutes > 0
            ? `刚睡下 ${cfg.privateGraceMinutes} 分钟内还会回`
            : '睡觉期间完全不回']
        ],
        tips: [], priority: 55
      };
    }
    if (st.quieted) {
      const mins = Math.max(0, Math.round(st.untilWake / MINUTE));
      return {
        icon: '😴',
        title: '睡觉时间',
        lines: [
          ['状态', `睡着中（还有约 ${mins} 分钟醒）`],
          ['醒来', clock(st.window.end)],
          ['现在', cfg.ownerCallable ? '只有主人说话它会醒' : '谁说话都不理']
        ],
        tips: [], priority: 90
      };
    }
    return {
      icon: '🥱',
      title: '睡觉时间',
      lines: [['状态', '准备睡（道别窗口内）']],
      tips: ['说一句困了就去睡了'], priority: 80
    };
  }
};

export const hooks = {
  /**
   * 抓一个 store 引用（before-context 是插件最早能拿到核心 store 的地方）。
   */
  'before-context': (ctx) => {
    if (ctx?.store) storeRef = ctx.store;
  }
};

/**
 * 睡觉时段的两段式提示词注入（一个 hook 名只能挂一个函数，所以两段逻辑在这里合并）。
 *
 *   道别窗口内 → 让模型用自己的口气说一句"困了"（用户明确要的效果）
 *   已转入静默 → 明确告诉它别说话，直接 finish
 */
hooks['before-llm-messages'] = (ctx = {}) => {
  const cfg = settings();
  if (!cfg.enabled) return;
  const chatKey = String(ctx.chatKey || '');
  if (!inScope(cfg, chatKey)) return;
  const now = new Date();
  if (!isSleeping(cfg, now, chatKey)) return;

  const messages = ctx.messages;
  if (!Array.isArray(messages)) return;
  const st = sleepState(cfg, chatKey, now, storeRef, cfg.ownerCallable && isOwnerCall(ctx));

  // 主人开口：什么都别注入，照常回（这就是"单独开的那个口"）
  if (st.phase === 'owner') return;

  if (st.phase === 'silent') {
    if (String(chatKey).startsWith('group:')) return;   // 群聊根本走不到这里（上面已硬闸）
    messages.push({
      role: 'system',
      content: '【睡觉时间】现在是你的睡觉时段，你已经睡下了。'
        + '这一轮**不要发送任何消息**（不要调用发送类工具），也不要道别、不要解释、不要回复。'
        + '直接调用 finish 结束，理由写"睡觉中"。'
        + '消息都还在存档里，醒了再看。'
    });
    return;
  }

  // ── phase === 'goodnight'：刚睡下，允许那句"困了" ──
  if (!cfg.goodnight) return;
  // 没人正在聊就别冒出来道别（凌晨三点突然说"我先睡了"会很怪）
  const gapMs = cfg.minGapMinutes * MINUTE;
  let someoneTalking = true;
  try {
    const recent = ctx.store?.recent?.(chatKey, { limit: 10, includeSelf: true }) || [];
    let lastOther = 0;
    for (const m of recent) {
      if (m?.self) continue;
      lastOther = Math.max(lastOther, Number(m.ts || 0));
    }
    someoneTalking = lastOther > 0 && (now.getTime() - lastOther) <= gapMs;
  } catch {
    someoneTalking = true;   // 读不到就别拦着它道别
  }
  if (!someoneTalking) {
    messages.push({
      role: 'system',
      content: '【睡觉时间】现在是你的睡觉时段，该睡了。这会儿没人在跟你说话，'
        + '所以**什么都不用发**，直接调用 finish 结束，理由写"睡觉中"。'
    });
    return;
  }

  const privateChat = String(chatKey).startsWith('private:');
  const sleepy = cfg.sleepTalk
    ? '\n【此刻的状态：半睡半醒】你现在是**迷迷糊糊、话都说不利索**的状态，所以：'
      + '句子要**特别短**（三五个字就够，别超过十个字）；'
      + '可以用"唔…""嗯……""困"这种没头没尾的；'
      + '**可以有错别字、打反字、说胡话、说到一半就没了**（比如"我睡啦…你也早点水"）；'
      + '不要解释、不要总结、不要逻辑通顺的长句 —— 说得越利索越不像睡着的人。'
    : '';
  messages.push({
    role: 'system',
    content: '【睡觉时间】现在到你的睡觉点了' + (someoneTalking ? '，你正跟人聊着天' : '') + '。'
      + '按你的性格说一句要睡了 —— 比如"困了""我先去睡了"这种，一句话，别解释、别总结今天、别挨个道晚安。'
      + sleepy
      + (privateChat
        // 私聊的"刚睡下"窗口比群里长（默认 30 分钟），所以措辞要允许它在半睡半醒间
        // 再回一两句短话；过了这个窗口就彻底睡死（那时候会走上面的 silent 分支）。
        ? '**说完这句就结束**。接下来一小会儿如果对方还跟你说话，你可以用很短、很困的语气应一声（"嗯…""明天说好不好"），但别展开聊；过了这一小会儿你就彻底睡死，不再回任何消息。'
        : '**说完这句就结束**（调用 finish），随后你就真的睡了，今晚不会再回任何消息。')
      + '如果你判断这里没必要说话，也可以直接 finish 什么都不发。'
  });
};

/**
 * 兜底硬闸：睡觉时段里，任何发送类工具一律拒绝。
 *
 * 为什么还需要它（chat.ban-state 已经挡住了群聊）：
 *   ① 私聊那条路核心没挂 ban-state 钩子；
 *   ② 别的扩展（定时任务、主动发言之类）可能绕过正常唤醒路径再次叫醒模型；
 *   ③ 万一将来核心改了 chat.ban-state 的实现，不回复这件事不该跟着一起失效。
 * 三层里任何一层单独成立都能保证"一个字都发不出去"。
 */
hooks['before-tool'] = (ctx = {}) => {
  const cfg = settings();
  if (!cfg.enabled || !cfg.blockSendTools) return;
  const toolName = String(ctx.toolName || '');
  if (!SEND_TOOLS.has(toolName)) return;
  const chatKey = String(ctx.chatKey || '');
  if (!inScope(cfg, chatKey)) return;
  const now = new Date();
  if (!isSleeping(cfg, now, chatKey)) return;
  const st = sleepState(cfg, chatKey, now, storeRef, cfg.ownerCallable && isOwnerCall(ctx));
  // 主人开口（'owner'）与道别窗口（'goodnight'）都放行，
  // 只有真正睡熟（'silent'）才拒绝 —— 逻辑与 before-llm-messages 完全一致。
  if (st.phase !== 'silent') return;
  return {
    block: true,
    reason: '现在是睡觉时间，不能发送消息。消息都还在存档里，醒了再看。'
  };
};

/** 自测用：不注册任何东西，直接调这些纯函数。 */
export const internals = {
  settings,
  parseHm,
  effectiveWindow,
  isSleeping,
  sleepState,
  inScope,
  hasSpokenSince,
  isOwnerCall,
  ownerIdsFromConfig,
  ownerRecentlySpoke,
  makeSleepTypo,
  SEND_TOOLS
};
