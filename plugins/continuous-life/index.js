// 持续的生活（plugins/continuous-life）—— 确定性插件
//
// ── 它做什么、不做什么 ────────────────────────────────────────────────────
// 做：在设定的时间段内，按间隔**给机器人开一轮**（空闲唤醒）。没有人说话也开。
// 不做：不代替模型决定说什么、不调用任何技能、不发消息。
//      这一轮里做什么（或什么都不做）完全由模型决定 —— 这是"确定性"与
//      "让模型自己想"的分界线，插件只负责把那一轮**点着**。
//
// ── 为什么需要核心配合（重要）────────────────────────────────────────────
// 扩展靠 registerTool 与 hooks 工作：工具要模型调用才生效，钩子只在**某一轮已经
// 跑起来之后**才触发。没有新消息 → 没有轮次 → 钩子永远不触发。而"开一轮"的入口
// wake() 是核心私有的调度方法，没有暴露给扩展（也没有 wake 类能力、没有对外的
// wake 端点）。所以插件自己**点不着**那一轮。
//
// 解法是核心提供的一个能力接口（方向与项目既有约定一致：核心按能力名取用，
// 不认识任何具体插件）：
//
//   能力名 session.idle-wake
//   核心每 30 秒问一次：provider({ chats, runningChats, paused }) → chatKey | chatKey[] | null
//   核心拿到 key 后自己去调 wake(chatKey, { proactive: true }) —— 开轮的动作在核心手里。
//
// provider 必须是**同步**的、立即返回：不做网络、不做 IO 等待（只读内存状态 + 写一个小 JSON）。
// 关掉本插件 → 核心的能力查表自动过滤 → 核心那边零残留。
//
// ── 这一轮的提示词怎么变成"唤醒说明" ──────────────────────────────────────
// 核心在 proactive 轮次里会把 user message 拼成：
//     `${userPrompt}\n\n【未读信息】（主动机会）群里已经安静了一会儿。…`
// 这不是我们想要的措辞（它明说"抛个话题"，而我们要的是"可以什么都不做"）。
// 所以本插件用 before-llm-messages 钩子把那个尾巴**精确换掉**：
// 从【未读信息】那一段起，整段替换成设置里的唤醒说明。
// 只动我们这一轮（用 sessionId 认领），不碰正常消息触发的任何一轮。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BUILD_TAG = 'v1.0.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 唤醒说明的默认值：与 plugin.json 里的 settings 一致（用户改过就用用户的）。 */
const DEFAULT_NOTE = '现在是空闲唤醒，没有人等回复。你可以什么都不做，也可以主动调用任意技能或发送想发的消息。'
  + '多数时候什么都不做，有时只做一件事，很少同时做复数事情。没有想做的事就结束，不必发消息。';

/**
 * 设置默认值**唯一来源**。
 *
 * 之前这里和 plugin.json 各写了一份，结果只改了一边（manifest 挡了工具、代码没挡），
 * 表现是"设置页写着默认禁用、实际没生效"而且不报错。现在 plugin.json 的 settings
 * 只是这份默认值的副本，自测里有一条专门核对两边逐字一致（防止再漂移）。
 */
export const SETTINGS_DEFAULTS = {
  enabled: false,
  startTime: '08:00',
  endTime: '20:00',
  minIntervalMinutes: 120,
  maxPerDay: 5,
  wakeNote: DEFAULT_NOTE
};

/**
 * 状态文件落点。
 *
 * 为什么不用相对路径："当前目录"在 Electron 里随启动方式变化（打包后是安装目录、
 * 开发时是仓库根），写错地方会导致状态每次重启都清零 —— 表现是"每天次数限制没生效"。
 * 所以按"插件目录 → 猜数据目录"的顺序探测（与其它插件同一套做法）。
 */
const DATA_DIR = process.env.QQ_AGENT_DATA_DIR || (() => {
  const guesses = [
    path.resolve(HERE, '..', '..', 'data'),                    // resources/app/plugins/x → resources/app/data
    path.resolve(HERE, '..', '..', '..', 'data'),               // 兼容多一层
  ];
  for (const g of guesses) {
    try { if (fs.existsSync(path.join(g, 'config.json')) || fs.existsSync(path.join(g, 'messages'))) return g; } catch { /* 继续猜 */ }
  }
  return guesses[0];
})();
const STORE_DEFAULT = path.join(DATA_DIR, 'continuous-life.json');
// 状态文件路径（自测可临时改指向，见 __setStorePathForTest）
let STORE = STORE_DEFAULT;

const MIN_INTERVAL_FLOOR = 30;      // 最小间隔硬下限（分钟）
const MAX_PER_DAY_RANGE = [1, 100];
// 一次"请求开轮"的认领有效期：核心静默丢弃时靠它自动过期，不会永久占着
const WAKE_CLAIM_TTL_MS = 10 * 60 * 1000;

// ── 时间与状态的小工具（纯函数，便于自测直接驱动）────────────────────────

/** "8:00" / "08:00" / "800" / "0800" → 当天分钟数；看不懂返回 null。 */
export function parseHHMM(value) {
  const t = String(value ?? '').trim();
  if (!t) return null;
  let m = /^(\d{1,2})\s*[:：]\s*(\d{1,2})$/.exec(t);
  if (m) {
    const h = Number(m[1]);
    const mm = Number(m[2]);
    if (h > 23 || mm > 59) return null;
    return h * 60 + mm;
  }
  m = /^(\d{3,4})$/.exec(t);
  if (m) {
    const s = m[1];
    const h = Number(s.slice(0, s.length - 2));
    const mm = Number(s.slice(-2));
    if (h > 23 || mm > 59) return null;
    return h * 60 + mm;
  }
  return null;
}

/**
 * 现在是否落在 [start, end] 内（按系统本地时区）。
 *
 * `includeEnd`：结束时刻那一分钟算不算在内。判定"该醒了"时要算（正好 20:00 还在窗口里），
 * 判定"已经过了窗口"时不算（20:00 整就该停了）。这样边界不会出现"刚好卡在结束点不动"。
 */
export function inWindow(now, startMin, endMin, { includeEnd = true } = {}) {
  const d = new Date(now);
  const cur = d.getHours() * 60 + d.getMinutes();
  if (startMin === null || endMin === null) return false;
  if (startMin === endMin) return true;                     // 相等 = 不限制时间
  if (startMin < endMin) {
    return includeEnd ? (cur >= startMin && cur <= endMin) : (cur >= startMin && cur < endMin);
  }
  // 跨零点：22:00–06:00
  return includeEnd ? (cur >= startMin || cur <= endMin) : (cur >= startMin || cur < endMin);
}

/** 本地日期键（YYYY-MM-DD）。过了 0 点这个值变了 → 当天次数自然清零。 */
export function dayKeyOf(now) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 把设置里的原始值收成可信的配置（越界/写错都退回默认，绝不让它抛）。 */
export function normalizeSettings(raw = {}) {
  const num = (v, fallback, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  };
  const startMin = parseHHMM(raw.startTime);
  const endMin = parseHHMM(raw.endTime);
  return {
    // 只在**显式**写了 true 时才算启用（fail closed）。
    // 不能用 `raw.enabled !== false`：那样在 config() 抛错、raw 退回 {} 时会被判定为"启用"，
    // 插件会静默变成默认开 —— 这是个会主动唤醒机器人发言的插件，默认必须是关。
    enabled: raw.enabled === true,
    startMin,
    endMin,
    // 时间写法看不懂时退回默认时段，并留下标记供状态面板显示
    badStart: raw.startTime != null && String(raw.startTime).trim() !== '' && startMin === null,
    badEnd: raw.endTime != null && String(raw.endTime).trim() !== '' && endMin === null,
    effStartMin: startMin === null ? 8 * 60 : startMin,
    effEndMin: endMin === null ? 20 * 60 : endMin,
    minIntervalMinutes: num(raw.minIntervalMinutes, 120, MIN_INTERVAL_FLOOR, 24 * 60),
    maxPerDay: num(raw.maxPerDay, 5, MAX_PER_DAY_RANGE[0], MAX_PER_DAY_RANGE[1]),
    note: String(raw.wakeNote ?? '').trim() || DEFAULT_NOTE
  };
}

// ── 状态存档 ─────────────────────────────────────────────────────────────

export const emptyState = () => ({ version: 1, chats: {} });
let cache = { mtimeMs: 0, data: null };

export function readState() {
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(STORE).mtimeMs; } catch { /* 还没写过 */ }
  if (cache.data && cache.mtimeMs === mtimeMs) return cache.data;
  let data = emptyState();
  try {
    const j = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    if (j && typeof j === 'object' && j.chats && typeof j.chats === 'object') {
      data = { ...emptyState(), ...j, chats: j.chats };
    }
  } catch (e) {
    if (e?.code !== 'ENOENT') {
      // 坏档就备份重建：不能让一个坏 JSON 让插件永远静默
      try { fs.renameSync(STORE, `${STORE}.broken-${Date.now()}`); } catch { /* ignore */ }
      api?.warn?.(`状态档损坏，已备份重建：${e?.message ?? e}`);
    }
  }
  cache = { mtimeMs, data };
  return data;
}

export function writeState(state) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${STORE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
    fs.renameSync(tmp, STORE);
    cache = { mtimeMs: -1, data: null };
    return true;
  } catch (e) {
    api?.warn?.(`状态写入失败：${e?.message ?? e}`);
    return false;
  }
}

/** 只给排障/测试：状态文件落在哪。 */
export const stateFile = () => STORE;

// ── 核心的决策：这一轮该怎么判 ───────────────────────────────────────────

/**
 * 纯决策函数：给定会话清单、状态、设置与当前时刻，算出**该唤醒哪些会话**。
 *
 * 抽成纯函数是因为验收项全是"该不该醒"的边界（开关/时段/间隔/次数/有人等回复），
 * 这些必须能被测试直接打，而不是靠起整个应用去撞时间。
 *
 * @returns {{wake: string[], skipped: Array<{chatKey:string, reason:string}>}}
 */
export function decide({ chats = [], state = emptyState(), settings, runningChats = [], now = Date.now() } = {}) {
  const wake = [];
  const skipped = [];
  const cfg = settings || normalizeSettings();
  const running = new Set(runningChats.map(String));

  if (!cfg.enabled) {
    return { wake, skipped: chats.map((c) => ({ chatKey: c.chatKey, reason: '总开关关着' })) };
  }
  // 该醒的时刻用 includeEnd（正好卡在结束点也算在窗口内），这样边界不会漏一次
  if (!inWindow(now, cfg.effStartMin, cfg.effEndMin, { includeEnd: true })) {
    return { wake, skipped: chats.map((c) => ({ chatKey: c.chatKey, reason: '不在时间段内' })) };
  }

  const dayKey = dayKeyOf(now);
  for (const chat of chats) {
    const chatKey = String(chat.chatKey || '');
    if (!chatKey) continue;
    const st = state.chats?.[chatKey] || {};
    // 过了 0 点：当天次数清零（读的时候算，不依赖有没有写盘）
    const usedToday = st.dayKey === dayKey ? Number(st.dayCount) || 0 : 0;

    // ① 已经有人在等回复 / 这一轮正在跑 → 跳过，且**不算进当天次数**
    //    （这正是"不打扰"：有人等着就先让那一轮跑完，本次作废而不是排队）
    if (Number(chat.unread) > 0) { skipped.push({ chatKey, reason: `有 ${chat.unread} 条没处理的消息（有人在等回复）` }); continue; }
    if (running.has(chatKey)) { skipped.push({ chatKey, reason: '这一轮正在跑' }); continue; }

    // ② 间隔未到
    const lastAt = Number(st.lastWakeAt) || 0;
    const elapsedMin = lastAt > 0 ? (now - lastAt) / 60000 : Infinity;
    if (elapsedMin < cfg.minIntervalMinutes) {
      skipped.push({ chatKey, reason: `距上次唤醒 ${Math.floor(elapsedMin)} 分钟 < 最小间隔 ${cfg.minIntervalMinutes} 分钟` });
      continue;
    }

    // ③ 当天次数用完
    if (usedToday >= cfg.maxPerDay) {
      skipped.push({ chatKey, reason: `今天已唤醒 ${usedToday} 次，达到上限 ${cfg.maxPerDay}` });
      continue;
    }

    wake.push(chatKey);
  }
  return { wake, skipped };
}

/** 记录一次唤醒（真正开轮后调用）。 */
export function markWoken(state, chatKey, now, note) {
  const dayKey = dayKeyOf(now);
  const prev = state.chats[chatKey] || {};
  const usedToday = prev.dayKey === dayKey ? Number(prev.dayCount) || 0 : 0;
  state.chats[chatKey] = {
    ...prev,
    lastWakeAt: now,
    dayKey,
    dayCount: usedToday + 1,
    lastResult: '已开轮',
    wakeNote: note
  };
  return state.chats[chatKey];
}

// ── 日志与状态 ───────────────────────────────────────────────────────────

let api = null;

function settings() {
  let raw = {};
  try { raw = (typeof api?.config === 'function' ? api.config() : null) || {}; } catch { raw = {}; }
  return normalizeSettings(raw);
}

/** 最近一次询问的结论，供状态面板/排障一眼看明白"为什么没醒"。 */
let lastCheck = { at: 0, asked: 0, woken: [], skipSample: [] };

// ── 提示词改写：把核心那套"主动机会"措辞换成我们要的唤醒说明 ──────────────

/** 本插件当次真正唤醒的会话（chatKey → { at, sessionId }），用于精确认领这一轮。 */
const pendingRounds = new Map();

/** 核心在 proactive 轮次里给 user message 追加的尾巴前缀（两种版本都要兼容）。 */
const CORE_IDLE_MARKERS = ['【未读信息】（主动机会-空闲唤醒）', '【未读信息】（主动机会）'];

/**
 * 把 user message 里的核心尾巴换成唤醒说明。
 * 只替换"从标记开始到结尾"的整段，前面的正文（群聊记录/记忆/规则）一字不动。
 * 找不到标记时**不硬塞**：宁可这一轮用核心默认措辞，也不能把提示词拼坏。
 */
export function applyWakeNote(content, note) {
  const text = String(content ?? '');
  const body = String(note ?? '').trim();
  if (!body) return text;
  let hit = -1;
  for (const marker of CORE_IDLE_MARKERS) {
    const idx = text.indexOf(marker);
    if (idx >= 0 && (hit < 0 || idx < hit)) hit = idx;
  }
  if (hit < 0) return text;
  return `${text.slice(0, hit)}【未读信息】（空闲唤醒）${body}`;
}

// ── 能力：核心每 30 秒问一次"现在要不要开轮" ─────────────────────────────

/**
 * provider 必须**同步**且立刻返回（核心在它的一次定时回调里串行调用）。
 * 这里只做：读设置 → 纯决策 → 记账 → 返回要开的轮。
 * 真正的开轮由核心用 wake(chatKey, { proactive: true }) 完成。
 */
function idleWakeProvider({ chats = [], runningChats = [] } = {}) {
  const cfg = settings();
  const now = Date.now();
  const state = readState();

  // 先清掉过期的"待开轮"：核心在少数情况下会**静默丢弃**这次请求
  // （并发已满 / 机器人被禁言 / 模型未配置），那几次不该永远挂着。
  for (const [key, pend] of pendingRounds) {
    if (now - Number(pend.at || 0) > WAKE_CLAIM_TTL_MS) pendingRounds.delete(key);
  }

  const { wake, skipped } = decide({ chats, state, settings: cfg, runningChats, now });

  lastCheck = { at: now, asked: chats.length, woken: [...wake], skipSample: skipped.slice(0, 6) };

  for (const chatKey of wake) {
    // ⚠️ 这里**先不记账**：核心可能静默丢弃这次请求，那样当天次数会被白扣，
    // 表现是"到点却不醒"。次数等这一轮真的跑起来再 +1（见 confirmWoken）。
    pendingRounds.set(chatKey, { at: now, sessionId: null, counted: false });
    const st = state.chats?.[chatKey] || {};
    const willBe = (st.dayKey === dayKeyOf(now) ? Number(st.dayCount) || 0 : 0) + 1;
    api?.log?.(`空闲唤醒 → ${chatKey}（请求开轮，成功才计入今天的第 ${willBe}/${cfg.maxPerDay} 次）`);
  }
  return wake;
}

/**
 * 这一轮确认跑起来了 → 正式记账（当天次数 +1、记住唤醒说明、刷新间隔起点）。
 * 由 before-context（核心开轮后跑的第一个钩子）调用；同一轮只记一次。
 */
function confirmWoken(chatKey, pend, now) {
  if (!pend || pend.counted) return;
  const state = readState();
  const st = markWoken(state, chatKey, now, settings().note);
  writeState(state);
  pend.counted = true;
  api?.log?.(`空闲唤醒 → ${chatKey}（已开轮，今天第 ${st.dayCount}/${settings().maxPerDay} 次）`);
}

// ── 生命周期 ─────────────────────────────────────────────────────────────

export function setup(a) {
  api = a;
  api.log(`持续的生活已加载（${BUILD_TAG}）｜只负责到点开一轮，开什么由模型决定｜状态 ${STORE}`);
}

export function available() {
  const cfg = settings();
  // 与 normalizeSettings 同一口径：只有显式启用才对外声称"可用"。
  // 用 `!== false` 的话，配置读不到时会照样声称可用、宿主照样来点名（fail open）。
  return cfg.enabled === true;
}

export function activate() {
  api?.log?.(`持续的生活已启用（${BUILD_TAG}）：`
    + `${String(api?.config?.()?.startTime ?? '08:00')}–${String(api?.config?.()?.endTime ?? '20:00')}`
    + `，每 ${settings().minIntervalMinutes} 分钟以上一次，每天最多 ${settings().maxPerDay} 次`);
}

export function deactivate() {
  pendingRounds.clear();
  lastCheck = { at: 0, asked: 0, woken: [], skipSample: [] };
}

/** 能力导出：核心按能力名 session.idle-wake 取用（见 src/orchestrator.js 的 idleWakeTick）。 */
export const providers = {
  'session.idle-wake': (ctx) => idleWakeProvider(ctx)
};

export const hooks = {
  /**
   * 认领这一轮：如果是我们刚点的空闲唤醒，记下它的 sessionId。
   * 认领一次**整轮有效**（提示词替换 + 工具闸 + 收尾记账都用它），
   * 直到 after-response 把这一轮交还为止。
   */
  'before-context'(ctx = {}) {
    if (!ctx.proactive || !ctx.chatKey) return;
    const chatKey = String(ctx.chatKey);
    const pend = pendingRounds.get(chatKey);
    if (!pend) return;
    pend.sessionId = ctx.sessionId ? String(ctx.sessionId) : null;
    pend.at = Date.now();
    // 开轮是真的 → 现在才计入当天次数（核心丢弃请求时不会走到这里）
    confirmWoken(chatKey, pend, Date.now());
  },

  /** 把核心那句"主动抛个话题"换成设置里的唤醒说明（只改我们认领的这一轮）。 */
  'before-llm-messages'(ctx = {}) {
    if (!ctx.proactive || !Array.isArray(ctx.messages)) return;
    const pend = claimFor(ctx);
    if (!pend) return;
    const last = ctx.messages[ctx.messages.length - 1];
    if (!last || last.role !== 'user') return;
    const note = settings().note;
    const next = applyWakeNote(last.content, note);
    if (next !== last.content) {
      last.content = next;
      api?.log?.(`空闲唤醒了 ${ctx.chatKey}：唤醒说明已写入这一轮提示词（${note.length} 字）`);
    }
  },

  /**
   * 这一轮收尾：交还认领状态，并如实记下"什么都没做"这个结果。
   *
   * 为什么要记：核心对"模型决定不说话"没有任何日志（它本来就不该发消息），
   * 于是控制台里那次唤醒看起来像"什么都没发生"。记一行"本轮未发消息"，
   * 才能把"到点真的开过一轮"和"根本没开轮"区分开 —— 这是验收时最关键的一条证据。
   */
  'after-response'(ctx = {}) {
    if (!ctx.proactive || !ctx.chatKey) return;
    const chatKey = String(ctx.chatKey);
    const pend = claimFor(ctx);
    if (!pend) return;
    pendingRounds.delete(chatKey);            // 整轮结束，交还
    const sent = Array.isArray(ctx.session?.sent) ? ctx.session.sent.length : null;
    const didNothing = sent === 0;
    try {
      const state = readState();
      if (state.chats?.[chatKey]) {
        state.chats[chatKey].lastResult = didNothing ? '未发消息（模型选择什么都不做）' : `发了 ${sent} 条`;
        state.chats[chatKey].lastResultAt = Date.now();
        writeState(state);
      }
    } catch { /* 记账失败不影响这一轮 */ }
    api?.log?.(`空闲唤醒收尾 ${chatKey}：${didNothing ? '本轮未发消息（什么都没做，符合预期）' : `本轮发了 ${sent} 条`}`);
  }
};

/**
 * 判断某个钩子上下文是不是"我们认领的这一轮"。
 * 优先按 sessionId 精确比对；拿不到 sessionId（老核心）时退回"proactive + 2 分钟内"。
 */
function claimFor(ctx = {}) {
  const chatKey = String(ctx.chatKey || '');
  if (!chatKey) return null;
  const pend = pendingRounds.get(chatKey);
  if (!pend) return null;
  const sameSession = pend.sessionId && ctx.sessionId ? String(ctx.sessionId) === pend.sessionId : true;
  if (!sameSession) return null;
  if (!pend.sessionId && Date.now() - Number(pend.at || 0) > 120_000) return null;
  return pend;
}

/**
 * 状态面板：一眼看出"开没开、为什么还没醒、今天醒了几次"。
 * 这是排查"到点没反应"的第一现场，所以把**没醒的原因**也摆出来。
 */
export const status = () => {
  const cfg = settings();
  const state = readState();
  const now = Date.now();
  const dayKey = dayKeyOf(now);
  const rows = Object.entries(state.chats || {}).map(([chatKey, st]) => {
    const usedToday = st.dayKey === dayKey ? Number(st.dayCount) || 0 : 0;
    const lastAt = Number(st.lastWakeAt) || 0;
    const mins = lastAt ? Math.floor((now - lastAt) / 60000) : null;
    return `${chatKey.replace('group:', '')}：今天 ${usedToday}/${cfg.maxPerDay} 次`
      + (mins === null ? '｜还没唤醒过' : `｜上次 ${mins} 分钟前`)
      + (st.lastResult ? `｜上次结果：${st.lastResult}` : '');
  });
  return {
    icon: '🫧',
    title: '持续的生活',
    priority: 55,
    lines: [
      ['状态', cfg.enabled === false ? '已关闭' : '运行中'],
      ['时间段', `${String(api?.config?.()?.startTime ?? '08:00')}–${String(api?.config?.()?.endTime ?? '20:00')}`
        + (inWindow(now, cfg.effStartMin, cfg.effEndMin, { includeEnd: true }) ? '（现在在时段内）' : '（现在在时段外）')
        + (cfg.badStart || cfg.badEnd ? ' ⚠️ 时间写法看不懂，已按默认 08:00–20:00 处理' : '')],
      ['节奏', `至少隔 ${cfg.minIntervalMinutes} 分钟一次，每天最多 ${cfg.maxPerDay} 次`],
      ['核心是否在询问', lastCheck.at ? `${Math.floor((now - lastCheck.at) / 1000)} 秒前问过（候选 ${lastCheck.asked} 个群）` : '还没被问过（核心未接 session.idle-wake？）'],
      ['本次询问结论', lastCheck.woken.length ? `唤醒 ${lastCheck.woken.length} 个：${lastCheck.woken.map((k) => k.replace('group:', '')).join('、')}` : '未唤醒'],
      ...(lastCheck.skipSample.length
        ? [['未唤醒原因（抽样）', lastCheck.skipSample.map((s) => `${s.chatKey.replace('group:', '')}：${s.reason}`).join('\n')]]
        : []),
      ...(rows.length ? [['各群今天', rows.join('\n')]] : []),
      ['职责边界', '只到点开一轮；这一轮做什么（含空间、浏览器）全由她自己决定，什么都不做就不发消息']
    ]
  };
};

// 只给排障/自测用的出口
export const internals = {
  STORE, DEFAULT_NOTE, CORE_IDLE_MARKERS,
  readState, writeState, emptyState, idleWakeProvider,
  pendingRounds, lastCheckRef: () => lastCheck
};

/** 只给排障/自测用：清掉"认领中的轮次"，让用例之间互不串味。 */
export function __resetPending() {
  pendingRounds.clear();
  lastCheck = { at: 0, asked: 0, woken: [], skipSample: [] };
}

/**
 * 只给自测用：把状态文件临时指到别处（默认是 data/continuous-life.json）。
 * 有它自测才能在**不碰真实状态**的前提下验证落盘/读回/坏档自愈；
 * 生产路径不会调用它。
 */
export function __setStorePathForTest(p) {
  STORE = p ? String(p) : STORE_DEFAULT;
  cache = { mtimeMs: 0, data: null };
}
