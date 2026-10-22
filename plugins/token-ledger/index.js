// plugins/token-ledger/index.js
//
// Token 账本：**实时查出每个技能/插件/工具花了多少 token**。
//
// ── 为什么是插件（plugins/）而不是技能 ────────────────────────────────────
// 它干的事是"读本地文件 → 算加减乘除 → 输出一张账"：规则完全能写死，不需要理解人话，
// 所以按项目规矩放 plugins/。（它**顺带**注册一个工具，好让群友/主人问"谁最费钱"时能现查。）
//
// ── 花不花 token？────────────────────────────────────────────────────────
// 不花。数据全在本地现成文件里：
//   · data/usage-today.json       今日真实用量（核心实时写）
//   · data/sessions/*.json        每个会话的真实记账 + 每个工具调用的返回内容
//   · data/telemetry-totals.json  历史累计 + 各工具调用次数
// 定时推送给主人的那份报告是 100% 零 token（自己的定时器算完直接发）。
// 只有"人在群里问一句"这种情况才需要模型回话 —— 那是聊天本身的开销，跟本插件无关。
//
// ── 只读 ─────────────────────────────────────────────────────────────────
// 本插件**只读** data/sessions 与那两个统计文件，一个字都不写回去；
// 自己的状态只写 data/token-ledger/（绝不写插件目录 —— 那会触发核心全量热重扫）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, getConfig } from '../../src/config.js';
import { listLegacyFiles, readIndexEntries, readSessionFull } from '../../src/storage/session-files.js';
import { estimateTokens, ownerOf, summarize, summarizePrompts, renderText, human } from './lib/ledger.js';

const ID = 'token-ledger';
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
// 本文件在 <app>/plugins/token-ledger/index.js，往上两级就是 app 根。
// import.meta.dirname 是 Node 20.11+ 才有的，这里带个兜底（老运行时/离线测试也能跑）。
const HERE = import.meta.dirname || path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, '..', '..');   // resources/app
const STATE_DIR = path.join(DATA_DIR, ID);
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const TICK_MS = 60 * 1000;          // 每分钟看一眼（要不要发日报）

let cfgOf = () => ({});
let log = () => {};
let warn = () => {};
let apiRef = null;
let senderRef = null;               // 发送通道：只能在工具被调用时抓到（核心的边界）
let timer = null;
let cache = { at: 0, key: '', value: null };   // 同一分钟内重复查就直接用缓存

const pad = (n) => String(n).padStart(2, '0');

function settings() {
  const c = cfgOf() || {};
  const n = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    windowDays: Math.max(1, Math.min(90, Math.round(n(c.windowDays, 3)))),
    maxSessions: Math.max(20, Math.min(5000, Math.round(n(c.maxSessions, 800)))),
    topN: Math.max(3, Math.min(20, Math.round(n(c.topN, 6)))),
    dailyReport: c.dailyReport !== false,
    reportHour: Math.max(0, Math.min(23, Math.round(n(c.reportHour, 23)))),
    reportMinute: Math.max(0, Math.min(59, Math.round(n(c.reportMinute, 50)))),
    graceMinutes: Math.max(0, Math.min(59, Math.round(n(c.graceMinutes, 10)))),
    reportTargets: String(c.reportTargets ?? '').trim(),
    audit: c.audit !== false
  };
}

/** 主人名单（和别的功能同一套：owner-identity）。 */
function ownerIds() {
  try {
    return String(getConfig()?.skills?.['owner-identity']?.ids ?? '')
      .split(/[,，、;；\s]+/).map((x) => x.trim()).filter((x) => /^\d{5 }$/.test(x));
  } catch { return []; }
}

function readerIdOf(ctx) {
  const entries = ctx?.session?.trigger ?? ctx?.session?.triggerEntries ?? [];
  const last = [...(Array.isArray(entries) ? entries : [])].reverse().find((e) => e && !e.self);
  return String(last?.senderId ?? '');
}

// ── 状态（只写数据目录）──────────────────────────────────────────────────
let state = { firedKeys: [], lastReport: null };

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (raw && typeof raw === 'object') {
      state = {
        firedKeys: Array.isArray(raw.firedKeys) ? raw.firedKeys.slice(-90) : [],
        lastReport: raw.lastReport ?? null,
        lastStats: raw.lastStats ?? null
      };
    }
  } catch { /* 首次运行 */ }
}
function saveState() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) { warn(`状态写盘失败：${e?.message ?? e}`); }
}

// ── 读会话 + 汇总 ─────────────────────────────────────────────────────────
// 会话已改为「索引 + gzip 档案」：先按 index.jsonl 筛时间窗，
// 只解压被选中的会话（最多 maxSessions 个），不再全量扫目录。
function collect({ windowDays, maxSessions }) {
  const since = Date.now() - windowDays * 86400000;
  const sessions = [];
  const seen = new Set();
  let broken = 0;
  let scanned = 0;

  const entries = readIndexEntries()
    .filter((e) => (Number(e.startedAt) || 0) >= since)
    .slice(0, maxSessions);
  for (const e of entries) {
    scanned += 1;
    const full = readSessionFull(e.id);
    if (full && typeof full === 'object') sessions.push(full);
    else {
      // 档案损坏/未写完：用索引摘要至少保住 token 真实记账
      sessions.push({ ...e, messages: [] });
      broken += 1;
    }
    seen.add(String(e.id));
  }

  // 旧版 sessions/<id>.json（尚未迁移完的）
  for (const f of listLegacyFiles()) {
    if (sessions.length >= maxSessions) break;
    const id = f.replace(/\.json$/, '');
    if (seen.has(id)) continue;
    try {
      const st = fs.statSync(path.join(SESSIONS_DIR, f));
      if (st.mtimeMs < since) continue;
      const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
      if (s && typeof s === 'object') { sessions.push(s); seen.add(id); scanned += 1; }
    } catch { broken += 1; }
  }
  return { sessions, scanned, broken };
}

/** 汇总（带一分钟缓存，免得连着问几次把磁盘读爆）。brief=给工具用的精简版。 */
function report({ windowDays, maxSessions, topN, scope = 'skill', brief = false }) {
  const key = `${windowDays}|${maxSessions}|${topN}|${scope}|${brief ? 'b' : 'f'}`;
  if (cache.value && cache.key === key && Date.now() - cache.at < 60000) return cache.value;
  const got = collect({ windowDays, maxSessions });
  const sum = summarize(got.sessions, { topN });
  sum.prompts = summarizePrompts(promptFootprints(), { calls: sum.totals.calls, topN });
  const text = renderText(sum, { topN, scope, days: windowDays, brief });
  const value = { ...sum, text, scanned: got.scanned, broken: got.broken, windowDays, scope, at: Date.now() };
  cache = { at: Date.now(), key, value };
  // 顺手把"最近一次统计"记下来给状态上报用（同步读、零 IO）
  state.lastStats = {
    at: value.at, sessions: sum.totals.sessions, calls: sum.totals.calls,
    totalTokens: sum.totals.totalTokens, resendTokens: sum.totals.resendTokens,
    top: (scope === 'tool' ? sum.tools : sum.skills).slice(0, 3).map((r) => `${r.name}:${human(r.resendTokens)}`)
  };
  saveState();
  return value;
}

/** 各技能往系统提示词里塞了多少字（读 manifest；不改任何文件）。 */
function promptFootprints() {
  const rows = [];
  for (const [folder, kind] of [['skills', 'skill'], ['plugins', 'plugin']]) {
    const dir = path.join(APP_DIR, folder);
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { continue; }
    for (const name of names) {
      const file = path.join(dir, name, kind === 'skill' ? 'skill.json' : 'plugin.json');
      let m = null;
      try { m = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
      if (!m?.id) continue;
      const sections = Array.isArray(m.prompt?.sections) ? m.prompt.sections : [];
      const chars = sections.reduce((a, s) => a + String(s?.content ?? '').length + String(s?.title ?? '').length, 0);
      let enabled = m.enabledByDefault !== false;
      try {
        const c = getConfig()?.skills?.[m.id];
        if (c && c.enabled !== undefined) enabled = c.enabled !== false;
      } catch { /* 拿不到配置就按 manifest 默认 */ }
      rows.push({ id: m.id, dir: name, name: m.name || m.id, kind, chars, enabled, sections: sections.length });
    }
  }
  return rows;
}

/** 今日真实用量（核心实时写的那个文件）。 */
function todayUsage() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'usage-today.json'), 'utf8'));
    return {
      dayKey: String(j.dayKey || ''), totalTokens: Number(j.totalTokens) || 0,
      cachedTokens: Number(j.cachedTokens) || 0, runs: Number(j.runs) || 0
    };
  } catch { return null; }
}

// ── 推送 ──────────────────────────────────────────────────────────────────
/** 推给谁：设置里填了就用它，否则私聊所有主人。 */
function targets() {
  const s = settings();
  const explicit = s.reportTargets.split(/[,，、;；\s]+/).map((x) => x.trim()).filter((x) => /^\d{5 }$/.test(x));
  const ids = explicit.length ? explicit : ownerIds();
  return ids.map((id) => `private:${id}`);
}

async function pushReport({ reason = '', scope = 'skill' } = {}) {
  const s = settings();
  const list = targets();
  if (!list.length) {
    warn('账本该推送了，但不知道推给谁（没配主人名单、reportTargets 也空着）');
    return { ok: false, error: '没有推送对象' };
  }
  if (!senderRef || typeof senderRef.sendTextBatch !== 'function') {
    warn('账本该推送了，但还没拿到发送通道（在群里说句话、或问一次「谁最费 token」即可接上）');
    return { ok: false, error: '没有发送通道' };
  }
  const r = report({ windowDays: s.windowDays, maxSessions: s.maxSessions, topN: s.topN, scope, brief: false });
  const today = todayUsage();
  const lines = [r.text];
  if (today) lines.push('', `今日真实用量：${human(today.totalTokens)} token / ${today.runs} 次请求`
    + `${today.cachedTokens ? `（缓存命中 ${human(today.cachedTokens)}）` : ''}`);
  const sent = [];
  const skipped = [];
  for (const key of list) {
    try { await senderRef.sendTextBatch(key, [lines.join('\n')]); sent.push(key); }
    catch (e) { skipped.push(`${key}（${e?.message ?? e}）`); }
  }
  if (sent.length) {
    state.lastReport = { at: Date.now(), sent: sent.length, scope, reason };
    saveState();
    log(`账本已推送：${sent.join('、')}（${reason || '手动'}）`
      + `｜扫了 ${r.scanned} 个会话文件，真实 ${human(r.totals.totalTokens)} token，工具重发账 ${human(r.totals.resendTokens)}`);
  }
  for (const x of skipped) warn(`账本推送失败 ${x}`);
  return { ok: sent.length > 0, sent, skipped };
}

// ── 定时（每天一次）───────────────────────────────────────────────────────
const dayKeyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 现在到点了吗（纯函数，便于离线断言）。 */
function whichDue(now = new Date()) {
  const s = settings();
  if (!s.dailyReport) return { due: false, key: '', reason: '' };
  const key = `report:${dayKeyOf(now)}`;
  if (state.firedKeys.includes(key)) return { due: false, key, reason: '' };
  const target = s.reportHour * 60 + s.reportMinute;
  const cur = now.getHours() * 60 + now.getMinutes();
  if (cur < target || cur > target + s.graceMinutes) return { due: false, key, reason: '' };
  return { due: true, key, reason: `${pad(s.reportHour)}:${pad(s.reportMinute)} 日报` };
}

async function tick(now = new Date()) {
  try {
    if (!apiRef) return;
    let active = true;
    try { active = apiRef.isSkillActive(ID) !== false; } catch { active = true; }
    if (!active) return;
    const due = whichDue(now);
    if (!due.due) return;
    // 先记账再发：发失败也不会一分钟一次地重试刷屏（当天就这么一次机会）
    state.firedKeys = [...state.firedKeys, due.key].slice(-90);
    saveState();
    await pushReport({ reason: due.reason });
  } catch (e) { warn(`账本定时检查出错：${e?.message ?? e}`); }
}

function ensureTimer() {
  if (timer) return;
  timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  timer.unref?.();
}
function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

// ── 生命周期 ──────────────────────────────────────────────────────────────
export function setup(api) {
  apiRef = api;
  cfgOf = api.config;
  log = (...a) => api.log?.(...a);
  warn = (...a) => (api.warn ?? api.log)?.(...a);
  loadState();

  api.registerTool({
    id: 'report',
    name: 'Token 账本',
    description: '查"哪个技能/工具最费 token"。读本机会话存档统计：真实 token 记账 + 每个工具输出'
      + '被反复重发造成的开销（估算）。适用：主人问「谁最费 token」「这个月花了多少」「哪个功能最烧钱」。'
      + '参数：scope=skill|tool（默认 skill）、days=统计最近几天（默认按设置）、send=true 把报告私聊给主人。'
      + '不需要联网、不花 token。',
    category: 'system',
    icon: '📒',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['skill', 'tool'], description: '按技能汇总（默认）还是按单个工具汇总' },
        days: { type: 'number', description: '统计最近几天，默认用设置里的天数' },
        send: { type: 'boolean', description: 'true = 顺手把报告私聊给主人（只有主人能用）' }
      }
    },
    async execute(ctx, args = {}) {
      if (ctx?.sender && typeof ctx.sender.sendTextBatch === 'function') senderRef = ctx.sender;
      const s = settings();
      const scope = String(args?.scope || 'skill').toLowerCase() === 'tool' ? 'tool' : 'skill';
      const days = Math.max(1, Math.min(90, Math.round(Number(args?.days) || s.windowDays)));
      const r = report({ windowDays: days, maxSessions: s.maxSessions, topN: s.topN, scope, brief: true });
      const today = todayUsage();
      const head = `扫了 ${r.scanned} 个会话文件（近 ${days} 天）`
        + `${r.broken ? `，${r.broken} 个正在写、跳过` : ''}`
        + `${today ? `；今日真实用量 ${human(today.totalTokens)} token` : ''}。`;
      const content = `${r.text}\n\n${head}\n（数字口径：真实记账的是会话级 token；分到哪个技能是按"工具输出被重发几轮"估算的，缓存命中的部分实际更便宜。）`;

      if (args?.send === true) {
        const ids = ownerIds();
        const me = readerIdOf(ctx);
        if (!ids.length || !me || !ids.includes(me)) {
          return { content: `${content}\n\n（要私聊推送得是主人，且这一句由主人说 —— 定时推送不受影响，已按设置每天自动发。）` };
        }
        const pushed = await pushReport({ reason: '主人要的（手动）', scope });
        return { content: `${content}\n\n${pushed.ok ? `已私聊推送给 ${pushed.sent.join('、')}` : `推送没成功：${pushed.error}（有可能是发送通道还没接上）`}` };
      }
      return { content };
    }
  });

  ensureTimer();
  const s = settings();
  log(`已加载：读 ${SESSIONS_DIR}（近 ${s.windowDays} 天、最多 ${s.maxSessions} 个文件）`
    + `；${s.dailyReport ? `每天 ${pad(s.reportHour)}:${pad(s.reportMinute)} 自动私聊账本` : '自动日报已关'}`
    + `；推送对象 ${targets().join('、') || '（没有：先配主人名单）'}`
    + `；发送通道${senderRef ? '已就绪' : '待激活（群里说句话或问一次即可接上）'}`);
}

export function available() {
  if (!fs.existsSync(SESSIONS_DIR)) {
    return { ok: false, reason: `还没有会话存档（${SESSIONS_DIR} 不存在）—— 机器人聊过天之后就能用了` };
  }
  return { ok: true };
}

export function activate() { loadState(); ensureTimer(); }
export function deactivate() { stopTimer(); }
export function dispose() { stopTimer(); cache = { at: 0, key: '', value: null }; }

/** 内部函数暴露给离线测试（不对外提供能力，别依赖）。 */
export const internals = {
  settings, report, collect, summarize, summarizePrompts, renderText, promptFootprints,
  estimateTokens, ownerOf,
  whichDue, tick, pushReport, targets, todayUsage, ownerIds, readerIdOf, stateFile: () => STATE_FILE,
  SESSIONS_DIR, getState: () => state,
  setState: (patch) => { state = { ...state, ...(patch || {}) }; },
  setSender: (fn) => { senderRef = fn; },
  resetCache: () => { cache = { at: 0, key: '', value: null }; }
};

/** 状态上报（给 ai-status 的状态面板用）：**必须同步、零 IO**，只回内存里的缓存值。 */
export const providers = {
  [`status.${ID}`]: () => {
    const s = settings();
    const st = state.lastStats;
    if (!st) {
      return { icon: '📒', title: 'Token 账本', lines: [['状态', '还没统计过（到点或问一次即出）']], tips: [], priority: 58 };
    }
    return {
      icon: '📒',
      title: 'Token 账本',
      lines: [
        ['统计范围', `${st.sessions} 会话 / ${st.calls} 次请求`],
        ['真实用量', `${human(st.totalTokens)} token`],
        ['工具重发账', `${human(st.resendTokens)}（估算）`],
        ['最费', st.top.join('　') || '—']
      ],
      tips: s.dailyReport ? [] : ['自动日报已关'],
      priority: 58
    };
  }
};
