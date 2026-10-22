// 防崩溃和记忆断层（guardian）
//
// 一个插件做两件事，都是"机器人不在了"造成的麻烦：
//
// ① 崩溃自愈
//    插件本身跑在 QQ Agent 进程里 —— 进程挂了它也就没了，**所以它不能自己救自己**。
//    做法：启动时把一个**独立于本进程**的看门狗（watchdog.cjs）以 detached 方式拉起来，
//    看门狗每 15 秒看一次主程序还在不在：
//      · 主程序活着                        → 继续看着
//      · 主程序没了 + 锁文件也没了          → **正常关闭**（用户自己关的）→ 看门狗退出，不动手
//      · 主程序没了 + 锁文件还在（陈旧 PID）→ **异常退出** → 自动重新拉起 + QQ 私聊通知
//    为什么靠锁文件判定：核心的 instance-lock.js 只在 `process.on('exit')` 里删锁，
//    正常退出必删、崩溃/被强杀必留 —— 这是现成的、可靠的"是否善终"信号。
//
// ② 记忆断层
//    程序关掉到再打开这段时间的消息机器人收不到，而核心不感知这件事（提示词里只有消息
//    时间戳，没有「你不在线」这句话）。于是模型会以为对话是连续的，接着上一轮的话题说，
//    还跟现在的内容混在一起 —— 表现出来就是「答得毫不相干」。
//    做法：每轮记下「上次处理这个会话的时间」（跨重启存盘），隔太久就在提示词里补一句提醒。
//
// 注入位置是刻意的：**追加到最后一条 user 消息的末尾**。若改到 system 消息里，
// 会把它后面的历史与当前消息整体错位，那一段缓存全部失效；加在末尾则只有这句自己是新的。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_START = Date.now();

const DEFAULTS = {
  // 默认关闭：扩展被加载（即使未启用）时不能直接起心跳/看门狗子进程。
  // 要用的用户在设置里显式打开（总开关），setup 才会启动守护。
  enabled: false,
  gapEnabled: true,
  gapMinutes: 30,
  longGapHours: 6,
  silentHint: true,
  crashGuardEnabled: true,
  maxRestarts: 2,
  restartWindowHours: 6,
  notifyOnRestart: true
};

let api = null;
let log = () => {};
let dataDir = '';
let statePath = '';
let heartbeatPath = '';
let watchdogScript = '';
let watchdogCfgFile = '';
let watchdogPidPath = '';
let state = { gaps: {}, restarts: [] };
let gapPending = new Map();
let dirty = false;
let beatTimer = null;

function settings() {
  try {
    const c = api && typeof api.config === 'function' ? api.config() : null;
    return Object.assign({}, DEFAULTS, c || {});
  } catch { return Object.assign({}, DEFAULTS); }
}

/** 找数据目录：优先注入进来的，否则按扩展目录回推（<app>/plugins/guardian → 程序根/data）。 */
function resolveDataDir(injected) {
  const cands = [];
  const fromInject = injected && (injected.dataDir || (injected.paths && injected.paths.data));
  if (fromInject) cands.push(String(fromInject));
  cands.push(path.join(HERE, '..', '..', '..', '..', 'data'));
  cands.push(path.join(HERE, 'data'));
  cands.push(HERE);
  for (const p of cands) {
    try {
      fs.mkdirSync(p, { recursive: true });
      fs.accessSync(p, fs.constants.W_OK);
      return p;
    } catch { /* 试下一个 */ }
  }
  return HERE;
}

function loadState() {
  try {
    const j = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state = {
      gaps: (j && j.gaps && typeof j.gaps === 'object') ? j.gaps : {},
      restarts: Array.isArray(j && j.restarts) ? j.restarts : []
    };
  } catch { state = { gaps: {}, restarts: [] }; }
}

function saveState() {
  if (!dirty) return;
  try {
    const keys = Object.keys(state.gaps);
    if (keys.length > 200) {
      const keep = {};
      for (const k of keys.sort((a, b) => (state.gaps[b] || 0) - (state.gaps[a] || 0)).slice(0, 200)) keep[k] = state.gaps[k];
      state.gaps = keep;
    }
    fs.writeFileSync(statePath, JSON.stringify({ updatedAt: Date.now(), gaps: state.gaps, restarts: state.restarts }), 'utf8');
    dirty = false;
  } catch (e) { log('[guardian] 状态写入失败：' + (e && e.message)); }
}

// ── 崩溃自愈：拉起/复用看门狗 ─────────────────────────────────────────────

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

function readPidFile(p) {
  try { return Number(String(fs.readFileSync(p, 'utf8')).trim()) || 0; } catch { return 0; }
}

function ensureWatchdog(s) {
  try {
    if (!fs.existsSync(watchdogScript)) { log('[guardian] 看门狗脚本缺失，跳过崩溃自愈：' + watchdogScript); return; }
    const running = readPidFile(watchdogPidPath);
    if (running && pidAlive(running)) {
      log(`[guardian] 看门狗已在运行（PID ${running}），不重复启动`);
      return;
    }
    // 看门狗要用的全部信息都写进配置，它才能脱离本进程独立工作
    const cfg = {
      enabled: true,
      appPid: process.pid,
      exePath: process.execPath,
      workDir: path.join(dataDir, '..'),
      lockFile: path.join(dataDir, 'qq-agent.lock'),
      heartbeatFile: heartbeatPath,
      pluginFile: path.join(HERE, 'index.js'),
      pluginEnabled: s.enabled !== false,
      stateFile: statePath,
      configFile: path.join(dataDir, 'config.json'),
      heartbeatTimeoutMs: 15 * 60 * 1000,
      intervalMs: 15000,
      maxRestarts: Math.max(1, Number(s.maxRestarts) || 2),
      restartWindowHours: Math.max(1, Number(s.restartWindowHours) || 6),
      notifyOnRestart: s.notifyOnRestart !== false,
      restartOnErrorBurst: s.restartOnErrorBurst !== false,
      errorBurstThreshold: Math.max(3, Number(s.errorBurstThreshold) || 8)
    };
    fs.writeFileSync(watchdogCfgFile, JSON.stringify(cfg), 'utf8');

    const child = spawn(process.execPath, [watchdogScript, watchdogCfgFile], {
      detached: true,
      stdio: 'ignore',
      cwd: HERE,
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' })
    });
    // 🔥 占位：必须在 child.unref() 之前把 PID 写进 pidfile。
    //    否则并发/连续的多次 setup（热重载会连续触发）之间有空窗，
    //    每个都会看到"没有看门狗"→ 拉起多个看门狗（实测出现过两个并存）。
    //    看门狗自己启动后会用真实 PID 覆盖它。
    try { fs.writeFileSync(watchdogPidPath, String(child.pid), 'utf8'); } catch { /* 忽略 */ }
    child.on('error', (e) => { try { fs.unlinkSync(watchdogPidPath); } catch { /* 忽略 */ } log('[guardian] 看门狗启动出错：' + (e && e.message)); });
    child.unref();
    log(`[guardian] 看门狗已拉起（PID ${child.pid}）| 崩溃后自动重启，正常关闭不动手`);
  } catch (e) {
    log('[guardian] 看门狗启动失败（不影响聊天）：' + (e && e.message));
  }
}

/** 心跳：看门狗据此判断"插件还在不在"（插件被关掉/删掉后它会自己退出，不留野进程）。 */
function startHeartbeat() {
  const beat = () => { try { fs.writeFileSync(heartbeatPath, String(Date.now()), 'utf8'); } catch { /* 忽略 */ } };
  beat();
  if (beatTimer) clearInterval(beatTimer);
  beatTimer = setInterval(beat, 60000);
  if (beatTimer.unref) beatTimer.unref();
}

// ── 记忆断层 ──────────────────────────────────────────────────────────────

function appendToTail(messages, text) {
  if (!Array.isArray(messages) || !text) return false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') { m.content = m.content + '\n\n' + text; return true; }
    if (Array.isArray(m.content)) { m.content.push({ type: 'text', text }); return true; }
  }
  for (const m of messages) {
    if (m && m.role === 'system' && typeof m.content === 'string') { m.content = m.content + '\n\n' + text; return true; }
  }
  return false;
}

function humanGap(ms, s) {
  if (ms >= (Number(s.longGapHours) || 6) * 3600000) {
    const h = Math.round(ms / 3600000);
    return h >= 24 ? `已隔了很久（约 ${Math.round(h / 24)} 天）` : `已隔了很久（约 ${h} 小时）`;
  }
  return `已过约 ${Math.max(1, Math.round(ms / 60000))} 分钟`;
}

function buildNote(info, s) {
  const lines = [
    '【内部提示·不要对群友说出来】',
    `这个会话距你上次处理${humanGap(info.gapMs, s)}，这期间的消息你**没有收到** ——`
      + `你记得的上一轮和现在这条之间是断开的${info.justStarted ? '（你刚启动过）' : ''}。`,
    '所以这轮请注意：',
    '1. 不要接着之前的话题继续说，也不要把旧话题和现在的内容混在一起；',
    '2. 只针对现在这条消息回应。如果它明显在接一个你没看到的话题，宁可少说一句、或者只回个“？”式短句，也不要硬接；',
    '3. 想要背景就用 get_recent_messages 往前翻真实聊天记录，别凭印象猜。'
  ];
  if (s.silentHint !== false) lines.push('（以上只是给你的提醒。不要提「我刚重启」「我看不到消息」这类话。）');
  return lines.join('\n');
}

// ── 生命周期 ─────────────────────────────────────────────────────────────

export function setup(injected) {
  api = injected || {};
  log = (api && api.log) || (() => {});
  const s = settings();
  dataDir = resolveDataDir(api);
  statePath = path.join(dataDir, 'guardian-state.json');
  heartbeatPath = path.join(dataDir, 'guardian-heartbeat');
  watchdogScript = path.join(HERE, 'watchdog.cjs');
  watchdogCfgFile = path.join(dataDir, 'guardian-watchdog.json');
  watchdogPidPath = path.join(dataDir, 'guardian-watchdog.pid');
  loadState();
  if (s.enabled === false) { log('[guardian] 总开关关闭，不做任何事'); return; }
  startHeartbeat();
  if (s.crashGuardEnabled !== false) ensureWatchdog(s);
  log(`[guardian] 就绪 | 数据目录 ${dataDir} | 断层阈值 ${s.gapMinutes} 分钟 | 崩溃自愈 ${s.crashGuardEnabled !== false ? '开' : '关'}`);
}

/**
 * 被启用时再启动守护（setup 已经启动过的场景是幂等的）。
 * 注意：deactivate 故意不停止心跳/看门狗 —— 心跳一停，看门狗会把应用当成
 * 崩了而拉起重启。要彻底关守护，请在设置里关闭 crashGuardEnabled 后重启应用。
 */
export function activate() {
  const s = settings();
  if (s.enabled === false) { log('[guardian] 总开关关闭，不启动'); return; }
  startHeartbeat();
  if (s.crashGuardEnabled !== false) ensureWatchdog(s);
  log('[guardian] 已启用守护');
}

export const hooks = {
  /** 每轮开始：算"这个会话隔了多久"，并记下本轮时间（跨重启保留）。 */
  async 'before-context'(ctx = {}) {
    try {
      const s = settings();
      if (s.enabled === false || s.gapEnabled === false) return;
      const chatKey = String(ctx.chatKey || '');
      if (!chatKey) return;
      const key = String(ctx.sessionId || chatKey);
      const now = Date.now();
      const prev = Number(state.gaps[chatKey]) || 0;
      const gapMs = prev > 0 ? now - prev : 0;
      if (prev > 0 && gapMs >= Math.max(0, Number(s.gapMinutes) || 0) * 60000) {
        gapPending.set(key, { gapMs, chatKey, justStarted: (now - APP_START) < 5 * 60 * 1000 });
      }
      state.gaps[chatKey] = now;
      dirty = true;
      if (gapPending.size > 50) gapPending.delete(gapPending.keys().next().value);
      saveState();
    } catch (e) { log('[guardian] before-context 出错（已忽略）：' + (e && e.message)); }
  },

  /** 真正注入：追加到最后一条 user 消息末尾（对缓存最友好，见文件头）。 */
  async 'before-llm-messages'(ctx = {}) {
    try {
      const key = String(ctx.sessionId || ctx.chatKey || '');
      const info = gapPending.get(key);
      gapPending.delete(key);
      if (!info) return;
      if (appendToTail(ctx.messages, buildNote(info, settings()))) {
        log(`[guardian] ${info.chatKey} 断层 ${Math.round(info.gapMs / 60000)} 分钟 → 已提醒（别接旧话题）`);
      }
    } catch (e) { log('[guardian] 注入失败（已忽略）：' + (e && e.message)); }
  }
};
