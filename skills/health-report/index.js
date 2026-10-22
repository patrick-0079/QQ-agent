// 体检报告（health-report）
//
// ── 为什么做这个插件 ──────────────────────────────────────────────────────
// 用户的原话：「整合成一个日志报告的形式，为程序和脚本减负」。
// 此前想知道"机器人现在到底怎么样"，得跑一堆一次性脚本、翻十几个文件：
//   会话 JSON（几百 KB × N）、data/logs 整天日志、看门狗状态、崩溃文件、
//   内存快照、扩展加载结果、代理/线路状态…… 每个问题写一个脚本，脚本本身又成了负担。
//
// 本插件把这些**现有数据源**收进一处，定时（默认 6 小时）产出一份报告，
// 每个数据源都只读**最省**的那一份：
//   · 扩展状态  → 核心的 skillManager.list()（内存里的注册表，零 IO）
//   · 运行结果  → 当日日志里的结构化行 `运行结束 status=…`（一次文件读，不碰会话 JSON）
//   · 报错/崩溃 → 当日日志的 ❌/[ERROR 计数 + data/logs/crash.log 的存在与最后一条
//   · 自愈情况  → 看门狗状态文件里的 restarts（近 24 小时）
//   · 内存      → process.memoryUsage + v8 堆上限（就是"能不能撑住"的现场）
//   · 网络线路  → network.download-route / network.proxy-config 两个能力（软依赖，没有就跳过）
//
// 产出：`data/reports/health-YYYY-MM-DD.md` —— **一天一个文件、每次追加一节**，
// 外加**一条**汇总日志行。要看就看这一个文件，或者直接对机器人说"出个体检报告"。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ID = 'health-report';
const BUILD_TAG = 'v1.0.0';
const TIMER_KEY = '__healthReportTimer';
const LOG_LOOKBACK_LINES = 4000;   // 只读当日日志的尾部：报告要便宜，不要扫全文件

const DEFAULTS = {
  enabled: true,
  intervalHours: 6,
  startDelaySec: 120,
  keepDays: 30,
  maxRunLines: 500
};

let api = null;
let log = () => {};
let warn = () => {};
let cfg = () => ({});
let dataDir = '';
let lastReport = null;

function settings() {
  let raw = {};
  try { raw = cfg() || {}; } catch { raw = {}; }
  const num = (k, d) => { const n = Number(raw[k]); return Number.isFinite(n) ? n : d; };
  return {
    enabled: raw.enabled === undefined || raw.enabled === null ? DEFAULTS.enabled : raw.enabled !== false && raw.enabled !== 'false',
    intervalHours: Math.max(1, Math.min(72, num('intervalHours', DEFAULTS.intervalHours))),
    startDelaySec: Math.max(5, Math.min(3600, num('startDelaySec', DEFAULTS.startDelaySec))),
    keepDays: Math.max(1, Math.min(365, num('keepDays', DEFAULTS.keepDays))),
    maxRunLines: Math.max(50, Math.min(5000, num('maxRunLines', DEFAULTS.maxRunLines)))
  };
}

function resolveDataDir(injected) {
  const cands = [];
  if (process.env.QQ_AGENT_DATA_DIR) cands.push(process.env.QQ_AGENT_DATA_DIR);
  const fromInject = injected && (injected.dataDir || (injected.paths && injected.paths.data));
  if (fromInject) cands.push(String(fromInject));
  cands.push(path.join(HERE, '..', '..', '..', '..', 'data'));
  for (const c of cands) { try { if (c && fs.existsSync(c)) return c; } catch { /* 下一个 */ } }
  return cands[cands.length - 1];
}

// ── 各数据源（每个都尽量"一次读、只读小的"）──────────────────────────────

/** 扩展状态：直接问核心的内存注册表（零 IO）。拿不到就退回数目录。 */
function collectExtensions() {
  const out = { total: null, active: 0, failed: 0, disabled: 0, failedIds: [], warning: '' };
  try {
    const list = globalThis.__skillManagerRef?.list?.();
    if (Array.isArray(list)) {
      out.total = list.length;
      for (const s of list) {
        const id = s?.manifest?.id || '';
        if (s?.loadError) { out.failed += 1; out.failedIds.push(id); continue; }
        if (s?.available === false) { out.disabled += 1; continue; }
        out.active += 1;
      }
      return out;
    }
  } catch { /* 退回目录计数 */ }
  try {
    const count = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).length; } catch { return 0; } };
    out.total = count(path.join(dataDir, '..', 'resources', 'app', 'plugins')) + count(path.join(dataDir, '..', 'resources', 'app', 'skills'));
    out.warning = '（核心注册表不可用，这里是目录数，未区分启用/失败）';
  } catch { out.warning = '（扩展计数也拿不到）'; }
  return out;
}

/** 当日日志里的结构化运行行 + 报错计数（一次读尾部）。 */
function collectToday() {
  const out = {
    logFile: '', runs: 0, byStatus: {}, avgRounds: 0, avgTools: 0, totalSent: 0,
    errors: 0, lastErrors: [], crash: null
  };
  try {
    const logsDir = path.join(dataDir, 'logs');
    const today = new Date().toISOString().slice(0, 10);
    const file = path.join(logsDir, `qq-agent-${today}.log`);
    out.logFile = file;
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      const lines = raw.split(/\r?\n/);
      const tail = lines.slice(Math.max(0, lines.length - LOG_LOOKBACK_LINES));
      let runCount = 0;
      let rounds = 0;
      let tools = 0;
      let sent = 0;
      const status = {};
      for (const line of tail) {
        const m = line.match(/运行结束 status=(\S+).*?轮次=(\d+).*?发出=(\d+).*?工具=(\d+)/);
        if (m) {
          runCount += 1;
          status[m[1]] = (status[m[1]] || 0) + 1;
          rounds += Number(m[2]) || 0;
          sent += Number(m[3]) || 0;
          tools += Number(m[4]) || 0;
          continue;
        }
        if (line.includes('❌') || line.includes('[ERROR')) {
          out.errors += 1;
          if (out.lastErrors.length < 3) out.lastErrors.push(line.trim().slice(0, 160));
        }
      }
      out.runs = runCount;
      out.byStatus = status;
      out.avgRounds = runCount ? Math.round((rounds / runCount) * 10) / 10 : 0;
      out.avgTools = runCount ? Math.round((tools / runCount) * 10) / 10 : 0;
      out.totalSent = sent;
    }
    const crashFile = path.join(logsDir, 'crash.log');
    if (fs.existsSync(crashFile)) {
      const raw = fs.readFileSync(crashFile, 'utf8').trim();
      const stamps = raw.match(/\[\d{4}-\d{2}-\d{2}T[^\]]+\]/g) || [];
      // 报告里要写清"是哪种崩溃" + 首行堆栈（最有信息量的一行），
      // 只给个时间戳对排查没有帮助。
      const kinds = raw.match(/\]\s*(uncaughtException|unhandledRejection)/g) || [];
      const kind = kinds.length ? kinds[kinds.length - 1].replace(/^\]\s*/, '') : '';
      const at = kind ? raw.lastIndexOf(kind) : -1;
      const after = at >= 0 ? raw.slice(at + kind.length).trim() : '';
      const firstLine = after.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || '';
      out.crash = {
        entries: stamps.length,
        last: stamps.length ? stamps[stamps.length - 1] : '',
        kind,
        tail: firstLine.slice(0, 200)
      };
    }
  } catch (error) { out.warning = String(error?.message ?? error); }
  return out;
}

/** 看门狗自愈：近 24 小时重启次数（状态文件里是个时间戳数组）。 */
function collectWatchdog() {
  const out = { restarts24h: null, lastAt: null };
  try {
    // 状态文件在 guardian-state.json（guardian 插件写的）；后面两个是历史/兼容名字，
    // 顺序遍历，认哪个都行 —— 认不出来就如实写"不可用"，绝不编数字。
    for (const name of ['guardian-state.json', 'guardian-watchdog-state.json', 'guardian-watchdog.json']) {
      const p = path.join(dataDir, name);
      if (!fs.existsSync(p)) continue;
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const arr = Array.isArray(j?.restarts) ? j.restarts : (Array.isArray(j?.state?.restarts) ? j.state.restarts : null);
      if (!arr) continue;
      const cutoff = Date.now() - 86400000;
      const recent = arr.filter((t) => Number(t) > cutoff);
      out.restarts24h = recent.length;
      out.lastAt = arr.length ? Number(arr[arr.length - 1]) : null;
      break;
    }
  } catch { /* 没有就算了 */ }
  return out;
}

/** 内存现场。 */
function collectMemory() {
  const out = {};
  try {
    const m = process.memoryUsage();
    out.rssMB = Math.round(m.rss / 1048576);
    out.heapUsedMB = Math.round(m.heapUsed / 1048576);
    out.externalMB = Math.round((m.external || 0) / 1048576);
    out.uptimeMin = Math.round(process.uptime() / 60);
  } catch { /* ignore */ }
  return out;
}

/** 网络线路与代理（软依赖：没有对应插件就跳过）。 */
function collectNetwork() {
  const out = { proxy: null, route: null };
  try {
    const pfn = globalThis.__capProbe?.('network.proxy-config');
    const p = typeof pfn === 'function' ? pfn() : null;
    if (p?.url) out.proxy = { url: p.url, mode: p.mode || 'fallback' };
  } catch { /* ignore */ }
  try {
    const rfn = globalThis.__capProbe?.('network.download-route');
    const r = typeof rfn === 'function' ? rfn() : null;
    if (r?.route) out.route = { route: r.route, reason: r.reason || '' };
  } catch { /* ignore */ }
  return out;
}

// ── 组装与落盘 ────────────────────────────────────────────────────────────

function statusLine(byStatus) {
  const keys = Object.keys(byStatus || {});
  if (!keys.length) return '无';
  return keys.map((k) => `${k} ${byStatus[k]}`).join(' / ');
}

export function buildReport() {
  const ext = collectExtensions();
  const today = collectToday();
  const wd = collectWatchdog();
  const mem = collectMemory();
  const net = collectNetwork();
  const now = new Date();
  const hhmm = now.toTimeString().slice(0, 5);

  const summary = [
    `扩展 ${ext.total ?? '?'} 个（失败 ${ext.failed}${ext.disabled ? `、停用 ${ext.disabled}` : ''}）`,
    `今日运行 ${today.runs} 次（${statusLine(today.byStatus)}）`,
    mem.rssMB ? `内存 RSS ${mem.rssMB}MB / 堆 ${mem.heapUsedMB}MB` : '内存未知',
    wd.restarts24h === null ? '自愈记录不可用' : `近 24h 自动重启 ${wd.restarts24h} 次`,
    today.crash ? `崩溃记录 ${today.crash.entries} 条` : '无崩溃记录'
  ].join('｜');

  const md = [
    `## ${hhmm} 体检`,
    '',
    `**${summary}**`,
    '',
    '| 项目 | 现状 |',
    '| --- | --- |',
    `| 扩展 | 共 ${ext.total ?? '?'}：可用 ${ext.active}、失败 ${ext.failed}、停用 ${ext.disabled}${ext.warning ? ` ${ext.warning}` : ''} |`,
    `| 今日运行 | ${today.runs} 次 → ${statusLine(today.byStatus)}；平均 ${today.avgRounds} 轮 / ${today.avgTools} 个工具调用，共发出 ${today.totalSent} 条 |`,
    `| 今日报错 | ${today.errors} 条${today.lastErrors.length ? `；最近：${today.lastErrors[0].slice(0, 90)}` : ''} |`,
    `| 崩溃现场 | ${today.crash ? `${today.crash.entries} 条，最后一次 ${today.crash.last}（${today.crash.kind || '未知类型'}：${today.crash.tail || '无堆栈'}）` : '无（data/logs/crash.log 不存在）'} |`,
    `| 自愈 | ${wd.restarts24h === null ? '不可用' : `近 24 小时自动重启 ${wd.restarts24h} 次`}${wd.lastAt ? `（最后一次 ${new Date(wd.lastAt).toLocaleString('zh-CN')}）` : ''} |`,
    `| 内存 | RSS ${mem.rssMB ?? '?'}MB、堆已用 ${mem.heapUsedMB ?? '?'}MB、external ${mem.externalMB ?? '?'}MB；进程已跑 ${mem.uptimeMin ?? '?'} 分钟 |`,
    `| 网络 | ${net.proxy ? `代理 ${net.proxy.url}（${net.proxy.mode}）` : '未启用代理'}${net.route ? `；当前线路指定：${net.route.route}（${net.route.reason}）` : ''} |`,
    ''
  ].join('\n');

  return { summary, md, ext, today, wd, mem, net, at: Date.now() };
}

function reportsDir() { return path.join(dataDir, 'reports'); }

function saveReport(md) {
  const dir = reportsDir();
  fs.mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, `health-${day}.md`);
  const header = fs.existsSync(file) ? '' : `# QQ Agent 体检报告 ${day}\n\n（每 ${settings().intervalHours} 小时自动追加一节；也可以随时对机器人说「出个体检报告」）\n\n`;
  fs.appendFileSync(file, `${header}${md}\n`, 'utf8');
  // 顺手清理过期报告（一天一个文件，数量很小，但仍然按保留天数收拾）
  try {
    const keep = settings().keepDays;
    const files = fs.readdirSync(dir).filter((f) => /^health-\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
    if (files.length > keep) {
      for (const f of files.slice(0, files.length - keep)) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ } }
    }
  } catch { /* ignore */ }
  return file;
}

function runReport({ save = true, reason = '定时' } = {}) {
  const r = buildReport();
  lastReport = r;
  let file = '';
  if (save) { try { file = saveReport(r.md); } catch (error) { warn(`报告落盘失败：${error?.message ?? error}`); } }
  log(`体检（${reason}）：${r.summary}${file ? `｜写入 ${path.relative(path.join(dataDir, '..'), file)}` : ''}`);
  return { ...r, file };
}

function schedule() {
  const conf = settings();
  if (typeof globalThis[TIMER_KEY] === 'object' && globalThis[TIMER_KEY]) {
    try { clearTimeout(globalThis[TIMER_KEY]); } catch { /* ignore */ }
    globalThis[TIMER_KEY] = null;
  }
  if (!conf.enabled) return;
  const first = setTimeout(() => {
    try { runReport({ reason: '启动后首次' }); } catch (error) { warn(`报告失败：${error?.message ?? error}`); }
    const every = setInterval(() => {
      try { runReport({ reason: '定时' }); } catch (error) { warn(`报告失败：${error?.message ?? error}`); }
    }, conf.intervalHours * 3600000);
    every.unref?.();
    globalThis[TIMER_KEY] = every;
  }, conf.startDelaySec * 1000);
  first.unref?.();
  globalThis[TIMER_KEY] = first;   // 卸载时能清掉
}

// ── 生命周期 ──────────────────────────────────────────────────────────────

export async function setup(injected) {
  api = injected || null;
  cfg = typeof api?.config === 'function' ? api.config : () => ({});
  log = typeof api?.log === 'function' ? api.log : () => {};
  warn = typeof api?.warn === 'function' ? api.warn : log;
  dataDir = resolveDataDir(api);
  // 核心模块的引用（软）：拿不到就不影响报告生成，只影响"扩展状态"这一节的精度
  try {
    const m = await import('../../src/skills/manager.js');
    globalThis.__skillManagerRef = m.skillManager || null;
  } catch { /* 不影响 */ }
  try {
    if (!globalThis.__capProbe) {
      const m2 = await import('../../src/skills/manager.js');
      globalThis.__capProbe = (name, args = {}) => {
        const p = m2.skillManager?.getCapabilityProviders?.(name, args)?.[0];
        return p ? p.fn : null;
      };
    }
  } catch { /* 不影响 */ }

  const conf = settings();
  if (!conf.enabled) {
    log('已加载（%s）：当前为停用状态（不产出体检报告）。', BUILD_TAG);
    return;
  }
  if (typeof api?.registerTool === 'function') {
    api.registerTool({
      id: 'report',
      name: '体检报告',
      description: '生成一份 QQ Agent 的现状体检报告：扩展加载情况、今天运行了多少次/结果分布、报错与崩溃记录、自动重启次数、内存占用、代理与下载线路。用于回答「你现在状态怎么样」「今天干了多少活」「为什么没回消息」这类问题，也可用于排查。默认同时写入 data/reports/ 下的当日报告文件。',
      category: 'query',
      icon: '🩺',
      parameters: {
        type: 'object',
        properties: {
          save: { type: 'boolean', description: '是否写入报告文件，默认 true' }
        }
      },
      async execute(args = {}) {
        try {
          const r = runReport({ save: args.save !== false, reason: '按需' });
          return { content: `${r.summary}\n\n详细报告：${r.file ? path.relative(path.join(dataDir, '..'), r.file) : '（未落盘）'}`, isError: false };
        } catch (error) {
          return { content: `生成报告失败：${error?.message ?? error}`, isError: true };
        }
      }
    });
  }
  schedule();
  log('已加载（%s）：每 %s 小时产出一份体检报告（启动后 %s 秒首次），写入 data/reports/。',
    BUILD_TAG, conf.intervalHours, conf.startDelaySec);
}

export function available() { return true; }

export function activate() { if (settings().enabled) log(`体检报告已激活（${BUILD_TAG}）。`); }

export function deactivate() {
  const t = globalThis[TIMER_KEY];
  if (t) { try { clearTimeout(t); clearInterval(t); } catch { /* ignore */ } globalThis[TIMER_KEY] = null; }
}

export function dispose() { deactivate(); }

/** 测试与排障用（不是宿主 API）。 */
export const __internals = {
  settings,
  buildReport,
  saveReport,
  runReport,
  collectExtensions,
  collectToday,
  collectWatchdog,
  collectMemory,
  setConfig: (fn) => { cfg = fn; },
  setDataDir: (d) => { dataDir = d; },
  get lastReport() { return lastReport; }
};

export { BUILD_TAG, PLUGIN_ID };
