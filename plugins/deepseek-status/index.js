// =============================================================================
//  plugins/deepseek-status/index.js
//  DeepSeek 峰谷状态牌 —— 按 DeepSeek 的错峰时段切换 QQ 在线状态
//
//  机制：DeepSeek 的高峰时段是北京时间「工作日 9:00–12:00、14:00–18:00」，
//        其余时间都是错峰（空闲）价，并且周末全天按错峰算。
//        插件到点把机器人的 QQ 在线状态换成「错峰牌」（默认摸鱼中），
//        高峰开始再换回「高峰牌」（默认忙碌）。
//        （口径与 DSH 的小鲸鱼挂件 DeepSeek-Balance-Whale-Widget 一致。）
//
//  怎么改状态：core/onebot.js 的 OneBotClient.call('set_online_status', {
//                status: <10=在线 / 20=忙碌 / 30=离开 / 40=隐身 / 50=请勿打扰>,
//                ext_status: <0=无扩展 / 1000=我的电量 / 1001=信号弱 ...
//                            1010=学习中 / 1020=吃饭中 / 1030=搬砖中 /
//                            1040=摸鱼中 / 1050=睡觉中 / 1060=听歌中 /
//                            1070=无聊中 / 1080=看剧中 / 1090=游戏中>
//              })
//              1000 以下和 2000 以上（企鹅/运动等）需要对应客户端的数字字段，
//              我们不碰，只用 ext_status 表达「在干嘛」。
//
//  用法（用户视角）：
//    1. 「插件」页找到 DeepSeek 峰谷状态牌 → 打开「启用」；
//    2. 在设置里选高峰/错峰各显示什么状态；
//    3. 之后不用管，它自己到点换牌子。
//
//  说明：本插件只改「QQ 在线状态」，不改变 DeepSeek 的计费口径，
//        也不会替你省钱；它只是把当前时段标出来。
// =============================================================================

import { getConfig } from '../../src/config.js';
import { OneBotClient } from '../../src/onebot.js';


const ID = 'deepseek-status';
// 高峰时段（北京时间），其余时间都是错峰价：
//   工作日（周一–周五）9:00–12:00 与 14:00–18:00；
//   周末（周六、周日）全天不设高峰。
const PEAK_WINDOWS = [[9 * 60, 12 * 60], [14 * 60, 18 * 60]];
const MAX_RETRY = 3;

/**
 * QQ 在线状态「状态码」表。
 *   status      基础状态：10 在线 / 20 忙碌 / 30 离开 / 40 隐身 / 50 请勿打扰
 *   ext_status  扩展状态（在干嘛）：只支持 set_online_status 这一种写法，
 *               1000 以下或 2000 以上（企鹅、运动步数等）需要对应客户端的数字字段，我们不碰。
 */
const CODE_LABELS = { 10: '在线', 20: '忙碌', 30: '离开', 40: '隐身', 50: '请勿打扰' };

const EXT_LABELS = {
  1000: '我的电量',
  1010: '学习中',
  1020: '吃饭中',
  1030: '搬砖中',
  1040: '摸鱼中',
  1050: '睡觉中',
  1060: '听歌中',
  1070: '无聊中',
  1080: '看剧中',
  1090: '游戏中'
};

/** 人类可读的名字，例如 20/1040 → 「摸鱼中」；20/0 → 「忙碌」。 */
function pairLabel(code, ext) {
  const c = Number(code);
  const e = Number(ext) || 0;
  if (e && EXT_LABELS[e]) return EXT_LABELS[e];
  return CODE_LABELS[c] || `状态 ${c}`;
}

/**
 * 下拉选项文本 → [status, ext_status]。
 * 选项文本本身就是键，所以 UI 里选的字符串一定会被正确翻译成状态码，
 * 不会再出现「下拉写着搬砖中、实际发出去的是忙碌」这种错位。
 */
const STATUS_PAIRS = {
  '在线': [10, 0],
  '忙碌': [20, 0],
  '离开': [30, 0],
  '请勿打扰': [50, 0],
  '学习中': [20, 1010],
  '吃饭中': [20, 1020],
  '搬砖中': [20, 1030],
  '摸鱼中': [20, 1040],
  '睡觉中': [30, 1050],
  '听歌中': [30, 1060],
  '无聊中': [30, 1070],
  '看剧中': [30, 1080],
  '游戏中': [30, 1090],
  '我的电量': [10, 1000]
};

const STATUS_OPTION_KEYS = Object.keys(STATUS_PAIRS);

/** 从任意文本里取出第一个数字（"20 搬砖中" → 20，纯数字也认）。 */
function parseStatusValue(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v);
  const m = /(-?\d{1,4})/.exec(String(v ?? ''));
  return m ? Number(m[1]) : 0;
}

/** 把一个下拉选项文本解析成可下发的 {code, ext, label}。 */
function resolvePair(v) {
  const s = String(v ?? '').trim();
  if (STATUS_PAIRS[s]) {
    const [code, ext] = STATUS_PAIRS[s];
    return { code, ext, label: s };
  }
  // 容错：万一是 "20 搬砖中" 或纯数字（比如控制台直接改了 config），退化成基础状态
  if (/\d/.test(s)) {
    const code = parseStatusValue(s);
    if (ALLOWED_STATUS_CODES.includes(code)) {
      const extMatch = /(10\d0)/.exec(s);
      const ext = extMatch ? Number(extMatch[1]) : 0;
      return { code, ext, label: pairLabel(code, ext) };
    }
  }
  return null;
}

const DEFAULTS = {
  enabled: false,
  mode: 'apply',
  peakStatus: '忙碌',
  offpeakStatus: '睡觉中',   // 错峰的默认牌子
  timezoneOffset: 8,
  checkIntervalSec: 60,
  reassertSec: 0,
  applyOnStart: true,
  verbose: false
};

// 状态码只在 QQ 允许的这几个里选（40 是隐身，不做时段状态，怕机器人对好友隐身）
const ALLOWED_STATUS_CODES = [10, 20, 30, 50];

/**
 * 拿「默认值」那把尺子去校验并收窄一个配置值。
 * api.config() 在插件首次注册前可能只返回 {} —— 这种半成品配置必须补上默认值。
 */
function coerceMode(v, dflt) {
  const s = String(v ?? '');
  return (s === 'apply' || s === 'notify') ? s : dflt;
}

/** 状态配置项：必须能解析成合法状态码，否则退回默认选项文本。 */
function coerceCode(v, dflt) {
  return resolvePair(v) ? String(v) : dflt;
}

function coerceNum(v, dflt, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function coerceBool(v, dflt) {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 1 || v === '1') return true;
  if (v === 'false' || v === 0 || v === '0') return false;
  return dflt;
}

// ── 日志 ─────────────────────────────────────────────────────────────────────
function log(...args) {
  console.log(`[${ID}]`, ...args);
}

function warn(...args) {
  console.warn(`[${ID}]`, ...args);
}

// ── 热重载安全：状态挂在 globalThis 上 ──────────────────────────────────────
// 开发模式每次保存文件都会重新 import 本模块，模块级变量会归零；
// 如果全局状态也跟着归零，就可能出现两套定时器同时跑、重复发请求。
function state() {
  if (!globalThis.__dsStatusState) {
    globalThis.__dsStatusState = { timer: null, client: null, clientWs: '', applied: null, appliedAt: 0, lastError: '' };
  }
  return globalThis.__dsStatusState;
}

// ── 设置读取 ─────────────────────────────────────────────────────────────────
/** 核心在 setup(api) 时把安全 API 交给我们；用它读设置最准（默认值已合并）。 */
function apiRef() {
  const st = state();
  return (st.api && typeof st.api.config === 'function') ? st.api : null;
}

function settings() {
  // 首选：核心的 api.config()（getSkillConfig(id, manifest.settings) 的结果）。
  // 兜底：直接读全局配置 config.skills[id] —— setup 早于注册，此时 api 可能还没有。
  let raw = null;
  const api = apiRef();
  if (api) {
    try { raw = api.config(); } catch { raw = null; }
  }
  if (raw == null) {
    try {
      const c = getConfig();
      raw = (c?.skills && typeof c.skills === 'object' ? c.skills[ID] : null) ?? null;
    } catch { raw = null; }
  }
  if (raw == null) raw = {};
  if (typeof raw === 'boolean') raw = { enabled: raw };
  if (typeof raw !== 'object') raw = {};
  if (raw.settings && typeof raw.settings === 'object') {
    raw = { ...raw.settings, enabled: raw.enabled ?? raw.settings.enabled };
  }

  const out = { ...DEFAULTS };
  out.enabled = coerceBool(raw.enabled, DEFAULTS.enabled);
  out.mode = coerceMode(raw.mode, DEFAULTS.mode);
  out.peakStatus = coerceCode(raw.peakStatus, DEFAULTS.peakStatus);
  out.offpeakStatus = coerceCode(raw.offpeakStatus, DEFAULTS.offpeakStatus);
  out.timezoneOffset = coerceNum(raw.timezoneOffset, DEFAULTS.timezoneOffset, -12, 14);
  out.checkIntervalSec = coerceNum(raw.checkIntervalSec, DEFAULTS.checkIntervalSec, 15, 3600);
  out.reassertSec = coerceNum(raw.reassertSec, DEFAULTS.reassertSec, 0, 1800);
  out.applyOnStart = coerceBool(raw.applyOnStart, DEFAULTS.applyOnStart);
  out.verbose = coerceBool(raw.verbose, DEFAULTS.verbose);
  return out;
}

/** 这个插件有没有被用户配置过（用来决定是否输出"还没设置"的日志）。 */
function configured() {
  try {
    const c = getConfig()?.skills;
    if (!c || typeof c !== 'object') return false;
    const keys = Object.keys(c);
    if (!keys.includes(ID)) return keys.length > 0;
    const e = c[ID];
    return !!e && typeof e === 'object';
  } catch {
    return false;
  }
}

// ── 时段计算 ─────────────────────────────────────────────────────────────────
/** 把某个 UTC 毫秒数按指定 UTC 偏移换算成「当天的第几分钟」和「星期几」。 */
function minutesOfDay(ms, offsetHours = 8) {
  const d = new Date(ms + offsetHours * 3600000);
  const day = d.getUTCDay();                 // 0=周日
  const weekday = day === 0 ? 7 : day;       // 1=周一 … 7=周日
  return { minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), weekday };
}

/** 周末（周六、周日）不设高峰，全天按错峰算。 */
function isWeekend(weekday) {
  return weekday === 6 || weekday === 7;
}

/**
 * 是否处于 DeepSeek 高峰时段：工作日 9:00–12:00、14:00–18:00（北京时间）。
 * 其余时间（含整天周末）都是错峰优惠价。ms 缺省取当前时间。
 */
function isPeak(ms = Date.now(), offsetHours = 8) {
  const { minutes, weekday } = minutesOfDay(ms, offsetHours);
  if (isWeekend(weekday)) return false;
  return PEAK_WINDOWS.some(([start, end]) => minutes >= start && minutes < end);
}

/** 是否处于 DeepSeek 错峰优惠时段（高峰之外的任何时间，含整个周末）。 */
function isOffPeak(ms = Date.now(), offsetHours = 8) {
  return !isPeak(ms, offsetHours);
}

/**
 * 下一个最近的状态切换时刻（毫秒时间戳，取整到分钟）。
 * 逐个窗口往后找第一个「高峰与否」跟现在不同的窗口边界；
 * 周末没有任何高峰窗口，所以自然落在「周五 18:00 之后」和「周一 9:00」这两个边界上。
 */
function nextSwitchAt(ms = Date.now(), offsetHours = 8) {
  const startOfDay = (t) => {
    const d = new Date(t + offsetHours * 3600000);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
      - offsetHours * 3600000;
  };
  const nowPeak = isPeak(ms, offsetHours);
  let base = startOfDay(ms);
  for (let day = 0; day < 8; day++) {
    for (const [start, end] of PEAK_WINDOWS) {
      for (const boundary of [base + start * 60000, base + end * 60000]) {
        if (boundary > ms && isPeak(boundary, offsetHours) !== nowPeak) return boundary;
      }
    }
    base += 24 * 3600000;   // 北京时间不用夏令时，直接加一天
  }
  return null;
}

/** 当前该挂哪块牌子。 */
function desiredStatusAt(ms, s) {
  return isOffPeak(ms, s.timezoneOffset) ? s.offpeakStatus : s.peakStatus;
}

function windowText(ms, s) {
  return isOffPeak(ms, s.timezoneOffset) ? '错峰（优惠中）' : '高峰';
}

function hhmm(ms, offsetHours) {
  const d = new Date(ms + offsetHours * 3600000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

// ── 连接 ─────────────────────────────────────────────────────────────────────
function activeClient() {
  const st = state();
  try {
    const onebot = globalThis.__ONE_BOT__;
    if (onebot && (onebot.connected === true || typeof onebot.call === 'function')) return onebot;
  } catch { /* ignore */ }
  let cfg = {};
  try { cfg = getConfig()?.snowluma || {}; } catch { cfg = {}; }
  const wsUrl = String(cfg.wsUrl || 'ws://127.0.0.1:3001');
  if (!st.client || st.clientWs !== wsUrl) {
    try { st.client?.disconnect?.(); } catch { /* ignore */ }
    st.client = new OneBotClient({
      wsUrl,
      httpUrl: String(cfg.httpUrl || 'http://127.0.0.1:3000'),
      accessToken: String(cfg.accessToken || ''),
      httpToken: String(cfg.httpAccessToken || cfg.accessToken || ''),
      onEvent: (ev) => {
        if (ev?.type === 'status') {
          const s = state();
          if (ev.connected) {
            // 重连后服务端状态可能被重置，允许下次检查重新下发一遍
            s.applied = null;
            s.appliedAt = 0;
          }
        }
      }
    });
    st.clientWs = wsUrl;
  }
  try { st.client.connect?.(); } catch (error) { warn('连接 SnowLuma 失败：', error?.message ?? error); }
  return st.client;
}

// ── 真正的状态切换 ───────────────────────────────────────────────────────────
function describeError(error) {
  const msg = String(error?.message ?? error ?? '');
  if (!msg) return '未知错误';
  if (/fetch failed/i.test(msg)) return `${msg}（SnowLuma 似乎没在运行，或 httpUrl 填错了：请到 SnowLuma 页签确认已启动）`;
  if (/HTTP 401|401/.test(msg)) return `${msg}（令牌不对：检查 SnowLuma 的 accessToken / httpAccessToken）`;
  if (/HTTP 403|403/.test(msg)) return `${msg}（协议端拒绝：该账号可能没有改状态的权限）`;
  if (/HTTP 426/.test(msg)) return `${msg}（端口填反了：httpUrl 应指向 OneBot HTTP API，不是 WebSocket 端口）`;
  if (/retcode=1\b|retcode: 1\b/.test(msg)) return `${msg}（协议端说参数不合法，多半是当前状态码它不支持）`;
  return msg;
}

async function applyStatus(target, s, reason) {
  const st = state();
  const spec = resolvePair(target);
  if (!spec) {
    st.lastError = `无法识别的状态设置：${target}`;
    warn(st.lastError);
    return false;
  }
  const { code, ext, label } = spec;

  // 防御：隐身（40）会让机器人对所有好友都看不见，不能当时段状态下发
  if (code === 40) {
    const why = '「隐身」不能作为时段状态使用（会让机器人对好友隐身）';
    st.lastError = why;
    warn(why);
    return false;
  }
  if (!ALLOWED_STATUS_CODES.includes(code) || !Number.isFinite(ext) || ext < 0) {
    const why = `状态码不合法：status=${code} ext_status=${ext}`;
    st.lastError = why;
    warn(why);
    return false;
  }

  if (s.mode === 'notify') {
    log(`[只提醒] 现在应切到「${label}」（status=${code} ext=${ext}），原因：${reason}`);
    st.applied = target;
    st.appliedAt = Date.now();
    st.lastError = '';
    return true;
  }

  const client = activeClient();
  if (!client) {
    st.lastError = '拿不到 OneBot 客户端';
    warn(st.lastError);
    return false;
  }

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      await client.call('set_online_status', { status: code, ext_status: ext }, 15000);
      const prev = st.applied;
      st.applied = target;
      st.appliedAt = Date.now();
      st.lastError = '';
      log(`已设置 QQ 在线状态：${prev ? `${prev} → ` : ''}${label}`
        + `（status=${code} ext=${ext}；${windowText(Date.now(), s)}；${reason}）`);
      return true;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRY) await new Promise((r) => setTimeout(r, attempt * 1200));
    }
  }

  st.lastError = describeError(lastError);
  warn(`设置状态失败（已重试 ${MAX_RETRY} 次）：${st.lastError}`);
  return false;
}

// ── 一次检查 ─────────────────────────────────────────────────────────────────
async function tick(reason = 'check') {
  const s = settings();
  if (!s.enabled && reason !== 'manual') {
    if (s.verbose) log('未启用，跳过');
    return { ok: true, skipped: 'disabled' };
  }
  const st = state();
  const now = Date.now();
  const target = desiredStatusAt(now, s);
  const off = isOffPeak(now, s.timezoneOffset);

  if (st.applied === target) {
    const reassert = s.reassertSec > 0 && now - (st.appliedAt || 0) >= s.reassertSec * 1000;
    if (!reassert) {
      if (s.verbose) log(`无需变更：仍是「${target}」（${windowText(now, s)}）`);
      return { ok: true, status: target, changed: false };
    }
    if (s.mode !== 'apply') {
      if (s.verbose) log(`无需变更：仍是「${target}」`);
      return { ok: true, status: target, changed: false };
    }
  }

  const why = reason === 'manual'
    ? `手动触发（当前${off ? '错峰优惠中' : '高峰'}）`
    : `到点切换（当前${windowText(now, s)}，${hhmm(now, s.timezoneOffset)}）`;
  const ok = await applyStatus(target, s, why);
  return { ok, status: target, changed: ok };
}

// ── 定时器 ───────────────────────────────────────────────────────────────────
function stopTicker() {
  const st = state();
  if (st.timer) {
    clearInterval(st.timer);
    st.timer = null;
    log('定时检查已停止');
  }
}

function ensureTicker(reason = 'activate') {
  const st = state();
  const s = settings();
  const ms = s.checkIntervalSec * 1000;
  if (st.timer) return st.timer;
  st.timer = setInterval(() => { tick('timer').catch((error) => warn('检查出错：', error?.message ?? error)); }, ms);
  try { st.timer.unref?.(); } catch { /* ignore */ }
  const next = nextSwitchAt(Date.now(), s.timezoneOffset);
  log(`定时检查已启动：每 ${s.checkIntervalSec} 秒一次（${reason}）`
    + `；下一次换牌子约在 ${next == null ? '—' : hhmm(next, s.timezoneOffset)}（${s.timezoneOffset >= 0 ? '+' : ''}${s.timezoneOffset} 时区）`);
  return st.timer;
}

// ── 生命周期：setup / activate / deactivate ─────────────────────────────────
export function setup(api) {
  const st = state();
  st.lastError = '';
  st.api = api || null;          // 核心给的安全 API，api.config() 用来读本插件设置
  log('已加载。状态会按 DeepSeek 高峰时段（工作日 9:00–12:00、14:00–18:00，周末全天错峰）在高峰/错峰两套牌子之间切换。');
  if (!configured()) {
    log('控制台还没保存过这个插件的设置，先按默认值待命（默认「不启用」）。'
      + '到「插件」页把「启用」打开即可开始工作。');
  }
  try { api?.log?.(`${ID} 就绪`); } catch { /* ignore */ }
  try { stopTicker(); } catch { /* ignore */ }
  // 2026-10-21：启动时不再主动 tick —— setup 在“未启用”时也会执行，
  // 这里 tick 会提前连 OneBot 并改状态（曾导致测试进程直接崩）。改由 activate() 负责。
  return true;
}

/** 启用时被核心调用：挂定时器，并按设置立刻校正一次。 */
export function activate() {
  const s = settings();
  ensureTicker('enable');
  if (s.applyOnStart) {
    tick('activate').catch((error) => warn('启用时校正失败：', error?.message ?? error));
  }
  return true;
}

/** 停用时被核心调用：一定要停掉定时器，否则禁用后还在发请求。 */
export function deactivate() {
  stopTicker();
  const st = state();
  st.applied = null;
  st.appliedAt = 0;
  return true;
}

// ── 状态面板上报（ai-status 的 status.<id> 协议）────────────────────────────
export const providers = {
  [`status.${ID}`]: () => {
    const s = settings();
    const st = state();
    const now = Date.now();
    const target = desiredStatusAt(now, s);
    const next = nextSwitchAt(now, s.timezoneOffset);
    const peak = resolvePair(s.peakStatus);
    const offpeak = resolvePair(s.offpeakStatus);
    const lines = [
      ['时段', `${windowText(now, s)}（${s.timezoneOffset >= 0 ? '+' : ''}${s.timezoneOffset} 时区 ${hhmm(now, s.timezoneOffset)}）`],
      ['高峰牌', peak ? `${peak.label}（status=${peak.code} ext=${peak.ext}）` : s.peakStatus],
      ['错峰牌', offpeak ? `${offpeak.label}（status=${offpeak.code} ext=${offpeak.ext}）` : s.offpeakStatus],
      ['当前应为', target],
      ['实际状态', s.mode !== 'apply'
        ? '只提醒模式，未改状态'
        : st.applied
          ? `${st.applied}（${new Date(st.appliedAt).toLocaleTimeString('zh-CN')} 设置）`
          : '尚未设置'],
      ['下次换牌', next == null
        ? '—'
        : `${hhmm(next, s.timezoneOffset)}（约 ${Math.max(1, Math.round((next - now) / 60000))} 分钟后）`]
    ];
    if (st.lastError) lines.push(['最近错误', st.lastError]);
    return {
      icon: '🌗',
      title: 'DeepSeek 峰谷状态牌',
      priority: 46,
      lines
    };
  }
};

// ── 内部函数暴露给离线测试（不对外提供能力，别依赖）────────────────────────
export const internals = {
  settings,
  isPeak,
  isOffPeak,
  nextSwitchAt,
  desiredStatusAt,
  minutesOfDay,
  windowText,
  resolvePair,
  parseStatusValue,
  applyStatus,
  tick,
  STATUS_PAIRS,
  STATUS_OPTION_KEYS,
  CODE_LABELS,
  EXT_LABELS,
  DEFAULTS
};
