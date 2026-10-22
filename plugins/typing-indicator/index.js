// plugins/typing-indicator/index.js
//
// 私聊「正在输入」提示：机器人在**准备回话**的这段时间里，
// 让对方 QQ 顶栏显示「对方正在输入…」—— 像真人边打边发。
//
// ── 为什么能做得到（不是模拟，是真协议）────────────────────────────────────
// QQ NT 里这是 **C2C 输入状态通知**：上行 oidb 0xcd4 subcmd 1（SetInputStatus），
// 对方收到的是 0x210-0x115 推送。本机协议端 snowluma 已经把它做成 OneBot action：
//
//     POST /set_input_status   { user_id: 123456, event_type: 1 }
//
// event_type = 1 是「正在输入」（3 是「正在讲话」，即语音录制）。
// 依据：snowluma 接收侧解码把 3 读成「对方正在讲话...」、其余读成「对方正在输入...」
// （index.mjs decodeInputStatus/inputStatusText），NapCat 的 set_input_status 示例同样用 1。
// 所以插件不用改协议端、不用动核心，只要在对的时机发这个包。
//
// ── 什么时候发（本插件的全部逻辑）─────────────────────────────────────────
// 「开始准备」在核心里是可见的：私聊来消息 → 档位判定（私聊恒响应）→ 起一次 run()，
// 而 run() 一开头就跑 before-context 钩子 —— 插件从这里开始计时（+ firstDelayMs 亮起）。
// 之后模型想多久、调多少工具，靠 pingIntervalMs 一次的刷新把提示点亮着
// （真人打字也是一直在刷新的；QQ 那边的「正在输入」是会过期的，不刷新会中途熄灭）。
//
// 收尾有四条线，先到先算：
//   · 模型调 finish            → 立刻收（明确收尾，不必等）
//   · 最后一条消息发出后       → 再等 postSendTailMs（机器人常连着发两三条，这期间继续亮着）
//   · 一直没发出消息的静默     → silentGraceMs 后撤掉（模型想完决定不说话时别一直吊着对方）
//   · 单轮硬上限 maxTypingMs   → 兜底，防卡死轮次里无限刷新
//
// ── 为什么只做私聊 ────────────────────────────────────────────────────────
// 这个状态通知是 C2C 的（oidb 请求里 chatType=0），群里 QQ 根本不显示「正在输入」。
// 所以群聊一律跳过：发了也是白发，还白多一次请求。
//
// ── 零 token / 零提示词 ──────────────────────────────────────────────────
// 不改提示词、不注册工具、不叫模型。只有几个 HTTP 状态包，成本可忽略。
//
// ── 两个坑（照抄 typo-sim 的教训，别踩第二遍）─────────────────────────────
//   ① 热重载会给插件开**新的模块实例**：状态与定时器若存在模块作用域，
//      重载后会多出一个 ticker、账也分成两份。所以全部状态挂 globalThis。
//   ② 补丁是某个实例装的：它闭包里引用的配置/日志出口必须走共享状态，
//      否则新实例的日志接不上旧补丁，警告被静默吞掉。

import fs from 'node:fs';
import path from 'node:path';
import { getConfig, DATA_DIR } from '../../src/config.js';
import { OneBotClient } from '../../src/onebot.js';
import { logger } from '../../src/logger.js';

const ID = 'typing-indicator';
const EVENT_TYPING = 1;          // 0xcd4 eventType：1=正在输入（3=正在讲话/录音）
const PING_TIMEOUT_MS = 6000;    // 状态包本身很快；超过就当协议端没连上
const FAIL_LIMIT = 3;            // 连续失败这么多次就放弃这一轮（别对着死端口每 3.5 秒敲一次）
const TICK_MS = 1000;            // 调度粒度（不是刷新间隔，刷新间隔看配置）
const SEND_TOOLS = new Set(['send_message', 'send_sticker', 'send_image']);

const STATE_DIR = path.join(DATA_DIR, ID);
const STATE_FILE = path.join(STATE_DIR, 'state.json');

// ── 共享状态（热重载安全）─────────────────────────────────────────────────
const G = (globalThis.__typingIndicatorState = globalThis.__typingIndicatorState || {
  cfgOf: null,
  logFn: null,
  warnFn: null,
  sessions: new Map(),     // chatKey('private:<qq>') -> 会话状态
  ticker: null,
  transport: null,         // 离线自检注入用；线上为 null → 走 defaultTransport
  clock: null,             // 离线自检注入用假时钟
  client: null,            // 自建的 OneBot HTTP 客户端（只发状态包）
  clientKey: '',           // httpUrl|token，变了就重建
  patchedCall: null,
  installed: false,
  stats: { turns: 0, pings: 0, fails: 0, lastDurationMs: 0, lastReason: '' },
  lastSaveAt: 0
});

const nowMs = () => (typeof G.clock === 'function' ? Number(G.clock()) : Date.now());
const log = (...a) => { try { (G.logFn || (() => {}))(...a); } catch { /* 日志不能反过来弄坏发送 */ } };
const warn = (...a) => { try { ((G.warnFn || G.logFn) || (() => {}))(...a); } catch { /* 同上 */ } };

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ── 设置 ──────────────────────────────────────────────────────────────────
function settings() {
  let c = {};
  try { c = (typeof G.cfgOf === 'function' ? G.cfgOf() : null) || {}; } catch { c = {}; }
  const n = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    enabled: c.enabled !== false,
    firstDelayMs: clamp(n(c.firstDelayMs, 400), 0, 10000),
    pingIntervalMs: clamp(n(c.pingIntervalMs, 3500), 800, 60000),
    postSendTailMs: clamp(n(c.postSendTailMs, 2500), 0, 60000),
    silentGraceMs: clamp(n(c.silentGraceMs, 60000), 5000, 600000),
    maxTypingMs: clamp(n(c.maxTypingMs, 120000), 10000, 1800000),
    skipChats: String(c.skipChats ?? '').trim(),
    logPings: c.logPings === true
  };
}
const skipSet = () => new Set(String(settings().skipChats).split(/[,，、;；\s]+/).filter(Boolean));

// ── 传输层：只为发状态包而存在的轻量 OneBot HTTP 客户端 ────────────────────
// 为什么不复用核心那个实例：核心实例在插件加载时机上拿不到（钩子上下文里没有 onebot），
// 而 HTTP 是无状态的 —— 自己按配置建一个，url/token 变了自动重建，比"抓核心实例"稳。
function snl() {
  const cfg = getConfig() || {};
  return cfg.snowluma || {};
}

function clientFor(sn) {
  const key = `${sn.httpUrl || ''}|${sn.httpAccessToken || sn.accessToken || ''}`;
  if (G.client && G.clientKey === key) return G.client;
  G.client = new OneBotClient({
    wsUrl: sn.wsUrl,
    httpUrl: sn.httpUrl,
    accessToken: sn.accessToken,
    httpToken: sn.httpAccessToken || sn.accessToken,
    onEvent: () => {}
  });
  G.clientKey = key;
  return G.client;
}

async function defaultTransport(userId, eventType) {
  const sn = snl();
  if (!String(sn.httpUrl || '').trim()) throw new Error('没有配置 snowluma.httpUrl');
  const onebot = clientFor(sn);
  await onebot.call('set_input_status', {
    user_id: Number(userId),
    event_type: Number(eventType)
  }, PING_TIMEOUT_MS);
}

function sendStatus(userId, eventType) {
  if (typeof G.transport === 'function') return G.transport(userId, eventType);
  return defaultTransport(userId, eventType);
}

// ── 会话状态 ──────────────────────────────────────────────────────────────
const chatKeyOf = (ctx) => String(
  ctx?.chatKey || (ctx?.kind && ctx?.chatId != null ? `${ctx.kind}:${ctx.chatId}` : '')
);
const isPrivateKey = (key) => /^private:\d+$/.test(String(key));
const userIdOfKey = (key) => String(key).replace(/^private:/, '');

function startSession(chatKey, userId, source = 'run') {
  const now = nowMs();
  const prev = G.sessions.get(chatKey);
  if (prev) { prev.lastActivityAt = now; return prev; }
  const st = settings();
  const s = {
    chatKey,
    userId: String(userId),
    source,                                            // run=靠对话轮次起的；capability=别的插件点名要的
    startedAt: now,
    lastActivityAt: now,
    lastPingAt: 0,
    // 亮起延迟 + 一点点抖动：真人不是"消息一到就开始打字"
    nextPingAt: now + st.firstDelayMs + Math.floor(Math.random() * 400),
    lastSendAt: 0,
    sends: 0,
    pings: 0,
    fails: 0,
    pinging: false
  };
  G.sessions.set(chatKey, s);
  if (st.logPings) log(`开始准备回话，亮起「正在输入」：${chatKey}（${source}）`);
  return s;
}

function stopSession(chatKey, reason) {
  const s = G.sessions.get(chatKey);
  if (!s) return;
  G.sessions.delete(chatKey);
  const dur = Math.max(0, nowMs() - s.startedAt);
  G.stats.lastDurationMs = dur;
  G.stats.lastReason = String(reason || '');
  if (s.source === 'run') G.stats.turns += 1;
  log(`收尾（${reason}）：${chatKey} 亮了 ${(dur / 1000).toFixed(1)} 秒、刷新 ${s.pings} 次`
    + `${s.sends ? `、发出 ${s.sends} 条` : ''}`);
  saveStats();
}

/** 标记"这条会话刚发出了一条私聊消息"（由补丁调用，参数已确认为私聊）。 */
function markSent(chatKey) {
  const s = G.sessions.get(chatKey);
  if (!s) return;
  const now = nowMs();
  s.sends += 1;
  s.lastSendAt = now;
  s.lastActivityAt = now;
}

function touch(chatKey) {
  const s = G.sessions.get(chatKey);
  if (s) s.lastActivityAt = nowMs();
}

// ── 刷新 ──────────────────────────────────────────────────────────────────
async function ping(s) {
  if (s.pinging) return;                              // 上一次还没回来就别叠
  s.pinging = true;
  s.lastPingAt = nowMs();
  const st = settings();
  try {
    await sendStatus(Number(s.userId), EVENT_TYPING);
    s.pings += 1;
    s.fails = 0;
    G.stats.pings += 1;
    if (st.logPings) log(`刷新「正在输入」：${s.chatKey}（第 ${s.pings} 次）`);
  } catch (error) {
    s.fails += 1;
    G.stats.fails += 1;
    // 失败日志限流：第 1 次 + 每 10 次一条，别把日志刷爆
    if (s.fails === 1 || s.fails % 10 === 0) {
      warn(`发送输入状态失败（连续 ${s.fails} 次）：${error?.message ?? error}`);
    }
    if (s.fails >= FAIL_LIMIT) stopSession(s.chatKey, `连续 ${s.fails} 次发不出状态包`);
  } finally {
    s.pinging = false;
    // 下一次按**派发时间**起算 ±20% 抖动（不受响应快慢影响，也不像节拍器）
    const jitter = 0.8 + Math.random() * 0.4;
    s.nextPingAt = s.lastPingAt + Math.max(500, Math.round(st.pingIntervalMs * jitter));
  }
}

/** 一秒一次的心跳：负责四条收尾线 + 到点刷新。 */
export function tick(now = nowMs()) {
  if (!G.sessions.size) return;
  const st = settings();
  if (!st.enabled) {
    for (const key of [...G.sessions.keys()]) stopSession(key, '插件已关闭');
    return;
  }
  for (const [chatKey, s] of [...G.sessions]) {
    if (now - s.startedAt >= st.maxTypingMs) {
      stopSession(chatKey, `单轮超过 ${Math.round(st.maxTypingMs / 1000)} 秒`);
      continue;
    }
    if (s.sends > 0 && now - s.lastSendAt >= st.postSendTailMs) {
      stopSession(chatKey, '消息已发出');
      continue;
    }
    if (s.sends === 0 && now - s.lastActivityAt >= st.silentGraceMs) {
      stopSession(chatKey, '一直没发出消息');
      continue;
    }
    if (now >= s.nextPingAt) ping(s);
  }
}

function ensureTicker() {
  if (G.ticker) return;
  G.ticker = setInterval(() => {
    try { tick(); } catch (error) { warn(`刷新出错：${error?.message ?? error}`); }
  }, TICK_MS);
  // 不能因为这个定时器把进程吊住（退出时要能正常退）
  if (typeof G.ticker.unref === 'function') G.ticker.unref();
}

function stopTicker() {
  if (G.ticker) { clearInterval(G.ticker); G.ticker = null; }
}

// ── 发送观测（唯一的核心补丁）────────────────────────────────────────────
// 挂在 OneBotClient.prototype.call 上而不是 sendText：这样文本、表情、图片
// 以及核心/其它插件绕过 SendQueue 的直接发送**全都看得见**，而且是精确的
// kind + id（不会把"发给别人的消息"算到当前会话头上）。
// 补丁只做观测，原样转发 —— 《观测失败绝不能影响发送本身》。
function installSendHook() {
  const proto = OneBotClient?.prototype;
  if (!proto || typeof proto.call !== 'function') return false;
  // 已经有人装过（含热重载前的旧实例）→ 直接认领，不叠第二层
  if (proto.call.__typingIndicator) { G.patchedCall = proto.call; G.installed = true; return true; }
  const original = proto.call;
  const patched = function (...args) {
    try {
      const [action, params] = args;
      if (action === 'send_private_msg' && params && params.user_id != null) {
        const key = `private:${params.user_id}`;
        if (G.sessions.has(key)) markSent(key);
      }
    } catch { /* 观测失败不能影响发送 */ }
    return original.apply(this, args);
  };
  patched.__typingIndicator = true;
  G.patchedCall = patched;
  proto.call = patched;
  G.installed = true;
  return true;
}

// ── 生命周期钩子 ──────────────────────────────────────────────────────────
// 起：before-context —— run() 的第一件事，就是"要准备回话了"这一刻。
function onRunStart(ctx) {
  const st = settings();
  if (!st.enabled) return;
  const chatKey = chatKeyOf(ctx);
  if (!isPrivateKey(chatKey)) return;                 // 群聊没有这个提示，跳过
  if (skipSet().has(chatKey)) return;
  startSession(chatKey, userIdOfKey(chatKey), 'run');
}

function onToolEnd(ctx) {
  const chatKey = chatKeyOf(ctx);
  if (!isPrivateKey(chatKey)) return;
  const s = G.sessions.get(chatKey);
  if (!s) return;
  const name = String(ctx?.toolName || '');
  if (name === 'finish') { stopSession(chatKey, '模型收尾'); return; }
  const now = nowMs();
  s.lastActivityAt = now;
  // 发送类工具：把"刚发出去"记下来（真正计数交给 OneBot 补丁，这里只负责时间线，
  // 因为被去重/失败拦下的发送也要收尾，否则会一直亮到静默上限）
  if (SEND_TOOLS.has(name)) s.lastSendAt = now;
}

export const hooks = {
  'before-context': (ctx) => { onRunStart(ctx); },
  'before-llm-messages': (ctx) => { touch(chatKeyOf(ctx)); },
  'after-response': (ctx) => { touch(chatKeyOf(ctx)); },
  'before-tool': (ctx) => { touch(chatKeyOf(ctx)); },
  'after-tool': (ctx) => { onToolEnd(ctx); }
};

// ── 对外能力 ──────────────────────────────────────────────────────────────
export const providers = {
  // ai-status 面板用：必须同步、零 IO
  [`status.${ID}`]: () => {
    const st = settings();
    const tips = st.enabled ? [] : ['「正在输入」已关闭'];
    if (!G.stats.turns) {
      return { icon: '💬', title: '正在输入', lines: [['状态', st.enabled ? '还没触发过' : '已关闭']], tips, priority: 58 };
    }
    return {
      icon: '💬',
      title: '正在输入',
      lines: [
        ['已触发轮次', `${G.stats.turns} 轮`],
        ['状态包', `${G.stats.pings} 个`],
        ['当前活跃', G.sessions.size ? `${G.sessions.size} 个私聊` : '无'],
        ['上次时长', G.stats.lastDurationMs
          ? `${(G.stats.lastDurationMs / 1000).toFixed(1)} 秒（${G.stats.lastReason || '—'}）`
          : '—']
      ],
      tips,
      priority: 58
    };
  },
  // 软依赖接口：别的插件也能让"某个私聊"亮起正在输入（比如自己刚好要延迟几秒才发）
  'typing.indicate': (args = {}) => {
    const st = settings();
    if (!st.enabled) return false;
    const chatKey = String(args?.chatKey || (args?.userId != null ? `private:${String(args.userId)}` : ''));
    if (!isPrivateKey(chatKey) || skipSet().has(chatKey)) return false;
    startSession(chatKey, userIdOfKey(chatKey), 'capability');
    return true;
  }
};

// ── 统计落盘（只写数据目录；写不了也不影响功能）────────────────────────────
function loadStats() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (raw && typeof raw === 'object') {
      const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
      G.stats = {
        turns: n(raw.turns),
        pings: n(raw.pings),
        fails: n(raw.fails),
        lastDurationMs: n(raw.lastDurationMs),
        lastReason: String(raw.lastReason || '')
      };
    }
  } catch { /* 首次运行 */ }
}

function saveStats() {
  const now = nowMs();
  if (now - G.lastSaveAt < 3000) return;    // 每轮都写盘没必要
  G.lastSaveAt = now;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...G.stats, updatedAt: Date.now() }, null, 1), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } catch { /* 写不了就算了：这只是统计 */ }
}

// ── 生命周期 ──────────────────────────────────────────────────────────────
export function setup(api) {
  G.cfgOf = typeof api?.config === 'function' ? api.config : () => ({});
  // 日志出口走真实 logger：插件的 api.log 只到 console，落不到 data/logs/*.log，
  // 而这个功能的验收方式就是"对着日志看时间线"
  G.logFn = (...a) => {
    try { logger.info(ID, ...a); } catch { try { api?.log?.(...a); } catch { /* ignore */ } }
  };
  G.warnFn = (...a) => {
    try { logger.warn(ID, ...a); } catch { try { (api?.warn ?? api?.log)?.(...a); } catch { /* ignore */ } }
  };

  loadStats();
  const hooked = installSendHook();
  ensureTicker();

  const st = settings();
  if (!hooked) warn('挂不上发送钩子（OneBotClient.prototype.call 不在）：发出消息的收尾只能靠工具钩子，仍然可用');
  log(`已上线：私聊准备回话时亮起「正在输入」，每 ${(st.pingIntervalMs / 1000).toFixed(1)} 秒刷新一次`
    + `；${Math.round(st.firstDelayMs)}ms 后亮起，发出消息后 ${Math.round(st.postSendTailMs)}ms 收尾`
    + `，单轮上限 ${Math.round(st.maxTypingMs / 1000)} 秒`
    + `；群聊不生效${st.skipChats ? `；跳过名单 ${st.skipChats}` : ''}`
    + `${st.enabled ? '' : '；当前是关闭状态（设置里打开才生效）'}`);
}

/** 自检：能不能发得出去（不检查协议端在不在线 —— 那是运行期的事）。 */
export function available() {
  let sn = {};
  try { sn = snl(); } catch { sn = {}; }
  if (!String(sn.httpUrl || '').trim()) {
    return { ok: false, reason: '配置里没有 SnowLuma 的 HTTP 地址（snowluma.httpUrl），发不出输入状态' };
  }
  const proto = OneBotClient?.prototype;
  if (!proto || typeof proto.call !== 'function') {
    return { ok: false, reason: '这个版本的核心没有 OneBotClient.call，发不出输入状态' };
  }
  return { ok: true };
}

export function activate() {
  loadStats();
  installSendHook();
  ensureTicker();
}

export function deactivate() {
  stopTicker();
  G.sessions.clear();   // 在途的提示不再刷新：对方客户端会自己过期
}

export function dispose() {
  deactivate();
}

// ── 给离线自检用（不对外提供能力，别依赖）──────────────────────────────────
export const internals = {
  settings, skipSet, tick, ping, startSession, stopSession, markSent, touch,
  chatKeyOf, isPrivateKey, userIdOfKey, installSendHook, ensureTicker, stopTicker,
  defaultTransport, clientFor,
  sessions: () => G.sessions,
  stats: () => G.stats,
  // 离线自检的注入点：假时钟 + 假传输（绝不打真网络）
  setClock: (fn) => { G.clock = fn; },
  setTransport: (fn) => { G.transport = fn; },
  setConfigGetter: (fn) => { G.cfgOf = fn; },
  setLog: (fn) => { G.logFn = fn; },
  isPatched: () => Boolean(OneBotClient?.prototype?.call?.__typingIndicator),
  reset: () => {
    stopTicker();
    G.sessions.clear();
    G.stats = { turns: 0, pings: 0, fails: 0, lastDurationMs: 0, lastReason: '' };
    G.transport = null;
    G.clock = null;
  },
  STATE_FILE
};
