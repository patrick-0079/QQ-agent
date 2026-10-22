// 独立看门狗（由 guardian 插件以 detached 方式拉起）
//
// 为什么必须独立：插件跑在 QQ Agent 进程里，进程崩了插件也一起没了 —— 它救不了自己。
// 这个脚本是单独的 Node 进程，主程序挂掉它照样活着，负责把主程序拉起来。
//
// 判据（不猜，靠核心自己的锁文件）：
//   主程序活着                          → 继续盯着
//   主程序没了 + qq-agent.lock 也没了    → **正常关闭**（用户自己关的）→ 退出，绝不动手
//   主程序没了 + 锁文件还在（陈旧 PID）  → **异常退出**（崩溃/被强杀）→ 自动拉起 + QQ 通知
//
// 退出条件（避免留下野进程）：
//   · 插件心跳过期（插件被关掉/删掉）  → 退出
//   · 主程序正常关闭                   → 退出
//   · 时间窗内自动重启次数用尽          → 退出（且通知一次，避免重启循环）
//
// 只用 node 内置模块，不依赖任何第三方包。

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CFG_PATH = process.argv[2];
const MY_PID = process.pid;

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); } }
function readLockPid(p) { try { return Number(String(fs.readFileSync(p, 'utf8')).trim()) || 0; } catch { return 0; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cfg = readJson(CFG_PATH);
if (!cfg || cfg.enabled === false) process.exit(0);

const baseDir = path.dirname(cfg.stateFile || __filename);
const PID_FILE = path.join(baseDir, 'guardian-watchdog.pid');
const LOG_FILE = path.join(baseDir, 'guardian-watchdog.log');

function say(msg) {
  const line = `[${new Date().toLocaleString('zh-CN')}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line, 'utf8'); } catch { /* 忽略 */ }
  try { process.stdout.write(line); } catch { /* 忽略 */ }
}

// ── 单实例：已经有一个看门狗就不重复开 ───────────────────────────────────
try {
  const old = Number(String(fs.readFileSync(PID_FILE, 'utf8')).trim()) || 0;
  if (old && old !== MY_PID && alive(old)) process.exit(0);
} catch { /* 没有就继续 */ }
try { fs.writeFileSync(PID_FILE, String(MY_PID), 'utf8'); } catch { /* 忽略 */ }

// ── 通知：用 OneBot 的 HTTP 接口私聊机主（OneBot 是独立进程，主程序挂了它也能发）──
function resolveNotifyTarget() {
  const conf = readJson(cfg.configFile);
  if (!conf) return null;
  let token = (conf.snowluma && conf.snowluma.httpAccessToken) || '';
  let port = Number((conf.snowluma && conf.snowluma.httpPort) || 3000);
  if (!token) {
    // 通用性兜底（同步做法，不联网）：控制台里没填令牌时，从 SnowLuma 的账号配置里挑一份 ——
    // 优先"文件名里的 QQ 跟控制台配置里的账号一致"的那份，其次唯一/最新改动的那个。
    // （踩过：目录里有多份账号配置，第一份的令牌可能是失效的，硬取第一份会导致通知永远发不出去）
    try {
      const root = path.resolve(__dirname, '..', '..');
      const dirs = [path.join(root, 'snowluma', 'config'), path.join(root, 'resources', 'snowluma', 'config'), path.join(root, '..', 'snowluma', 'config')];
      for (const d of dirs) {
        try {
          if (!fs.existsSync(d)) continue;
          const files = fs.readdirSync(d).filter((f) => /^onebot_.*\.json$/.test(f));
          if (!files.length) continue;
          const mine = String((conf.snowluma && (conf.snowluma.qq || conf.snowluma.uin || conf.snowluma.selfId)) || '');
          let pick = files.find((f) => mine && f.includes(mine)) || '';
          if (!pick) {
            const withTime = files.map((f) => { let t = 0; try { t = fs.statSync(path.join(d, f)).mtimeMs; } catch (e) { } return { f, t }; }).sort((a, b) => b.t - a.t);
            pick = withTime[0].f;
          }
          const j = JSON.parse(fs.readFileSync(path.join(d, pick), 'utf8'));
          const hs = (j.networks && j.networks.httpServers) || [];
          const ws = (j.networks && j.networks.wsServers) || [];
          token = String((hs[0] && hs[0].accessToken) || (ws[0] && ws[0].accessToken) || '');
          port = Number((hs[0] && hs[0].port) || 3000);
          if (token) log('通知令牌来自 SnowLuma 配置：' + pick);
          break;
        } catch (e) { /* 下一个目录 */ }
      }
    } catch (e) { /* 忽略 */ }
  }
  if (!token) { log('[guardian] ⚠️ 没拿到 OneBot 令牌 —— 崩溃通知会发不出去（去控制台把 SnowLuma 令牌填好）'); return null; }
  let admins = [];
  // 【机器人的插件设置】各插件的配置在 config.json 的 skills["<插件id>"] 这一层
  const roster = (conf.skills && conf.skills['admin-roster']) || {};
  const owners = (roster.settings && roster.settings.owners) || roster.owners || conf.owners || conf.owner || '';
  admins = String(owners).split(/[^\d]+/).filter((s) => s.length >= 5);
  if (!admins.length) {
    const me = (conf.persona && conf.persona.ownerQq) || '';
    admins = String(me).split(/[^\d]+/).filter((s) => s.length >= 5);
  }
  if (!admins.length) return null;
  const http = (conf.snowluma && conf.snowluma.httpUrl) || 'http://127.0.0.1:3000';
  return { token, admins, http };
}

async function notify(text) {
  if (cfg.notifyOnRestart === false) return;
  try {
    const t = resolveNotifyTarget();
    if (!t) { say('没找到通知目标（token/机主 QQ），跳过通知'); return; }
    for (const qq of t.admins) {
      try {
        const r = await fetch(`${t.http}/send_private_msg`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${t.token}`, 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ user_id: Number(qq), message: text })
        });
        say(`已通知 ${qq}（HTTP ${r.status}）`);
      } catch (e) { say(`通知 ${qq} 失败：${e && e.message}`); }
    }
  } catch (e) { say('通知流程出错：' + (e && e.message)); }
}

/**
 * 带重试的通知。
 *
 * 为什么必须重试：SnowLuma（OneBot）是主程序**拉起的子进程** —— 主程序崩溃时它一起没了，
 * 所以崩溃当下那个 HTTP 请求必然失败（实测：fetch failed）。等主程序把 SnowLuma 重新带起来
 * 之后再发，才发得出去。
 */
async function notifyWithRetry(text, tries = 12, gapMs = 10000) {
  if (cfg.notifyOnRestart === false) return;
  for (let i = 0; i < tries; i++) {
    const t = resolveNotifyTarget();
    if (t) {
      try {
        const r = await fetch(`${t.http}/get_login_info`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${t.token}`, 'Content-Type': 'application/json' },
          body: '{}'
        });
        if (r.ok) { await notify(text); return; }
      } catch { /* OneBot 还没起来，等下一轮 */ }
    }
    await sleep(gapMs);
  }
  say('通知重试次数用尽（OneBot 一直没回来）');
}

// ── 重启预算（防崩溃循环）──────────────────────────────────────────────
function loadState() {
  const j = readJson(cfg.stateFile);
  if (!j) return { updatedAt: 0, gaps: {}, restarts: [] };
  return { updatedAt: j.updatedAt || 0, gaps: j.gaps || {}, restarts: Array.isArray(j.restarts) ? j.restarts : [] };
}

function recentRestarts(state) {
  const win = (Number(cfg.restartWindowHours) || 6) * 3600000;
  return state.restarts.filter((t) => Date.now() - Number(t) < win);
}

// ── "冒红"检测：日志里短时间一堆 ERROR = 它自己出问题了，主程序还活着也要自己救一次 ──
//
// 为什么不靠心跳/时间：像"扩展全部加载失败""模型接口一直报错"这类问题，进程是活的、
// 心跳也正常，但机器人实际上是瘫的。用户的原话是"冒红了自己叫醒自己"。
let lastLogKey = '';
function errorBurst() {
  try {
    const dir = path.join(path.dirname(cfg.lockFile), 'logs');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.log')).sort();
    if (!files.length) return 0;
    const p = path.join(dir, files[files.length - 1]);
    const st = fs.statSync(p);
    if (Date.now() - st.mtimeMs > 10 * 60 * 1000) return 0;      // 日志 10 分钟没动 = 现在没活动
    const key = p + '|' + st.size;
    if (key === lastLogKey) return 0;                            // 日志没长新行 → 不用重复解析
    lastLogKey = key;
    const tail = fs.readFileSync(p, 'utf8').slice(-131072);      // 只读最后 128KB（够看最近 300 行）
    const lines = tail.split('\n').filter(Boolean).slice(-300);
    let n = 0;
    for (const l of lines) {
      if (/\[ERROR\s*\]/.test(l)) n++;
      else if (/加载失败|启动失败|调用失败|self signed certificate/.test(l)) n++;
    }
    return n;
  } catch { return 0; }
}

function spawnApp(label) {
  try {
    const env = Object.assign({}, process.env);
    delete env.ELECTRON_RUN_AS_NODE;   // 不清掉它，Electron 会以"node 模式"跑、秒退无窗口
    const child = spawn(cfg.exePath, [], { detached: true, stdio: 'ignore', cwd: cfg.workDir, env });
    child.on('error', (e) => say('拉起出错：' + (e && e.message)));
    child.unref();
    say(`${label}：已拉起（PID ${child.pid}）`);
    return true;
  } catch (e) {
    say(`${label}：拉起失败（${e && e.message}）`);
    return false;
  }
}

// ── 主循环 ───────────────────────────────────────────────────────────────
(async () => {
  say(`看门狗启动（PID ${MY_PID}）→ 盯着主程序 PID ${cfg.appPid}，每 ${Math.round((cfg.intervalMs || 15000) / 1000)} 秒看一次`);
  const interval = Number(cfg.intervalMs) || 15000;
  let staleLogged = false;      // 心跳过期只提示一次，别每 15 秒刷一行
  let ticks = 0;
  let lastRedRestart = 0;       // "冒红"自动重启的冷却（20 分钟）

  for (;;) {
    await sleep(interval);

    // 0) 每 ~5 分钟重读一次配置（按循环次数，不额外开定时器）：
    //    用户后来改了设置（关掉插件、改重启上限、关通知）能生效；
    //    但不必每 15 秒去解析那个几百 KB 的 config.json。
    if (++ticks % 20 === 0) {
      const c2 = readJson(CFG_PATH);
      if (c2) {
        if (c2.enabled === false) { say('配置里看门狗已关闭 → 退出'); process.exit(0); }
        cfg = Object.assign({}, cfg, c2);
      }
    }

    // 1) 插件还在吗？—— 用「插件文件 + 设置开关」判定，**绝不用时间去判定**
    //    （为什么：电脑睡眠时整个进程被冻结，心跳必然过期；一觉醒来按时间判会误判成
    //     "插件被删了"然后自退 —— 崩溃保护就这么静默丢了。改成看文件是否存在，睡眠无关。）
    if (cfg.pluginFile && !fs.existsSync(cfg.pluginFile)) {
      say('guardian 插件文件已不在 → 看门狗退出');
      process.exit(0);
    }
    if (cfg.pluginEnabled === false) {
      say('guardian 已在设置里关掉 → 看门狗退出');
      process.exit(0);
    }
    // 心跳只用来"看一眼状态"，不再当退出依据
    try {
      const mt = fs.statSync(cfg.heartbeatFile).mtimeMs;
      const staleMin = Math.round((Date.now() - mt) / 60000);
      if (staleMin > Math.round((Number(cfg.heartbeatTimeoutMs) || 900000) / 60000)) {
        if (!staleLogged) { say(`插件心跳已 ${staleMin} 分钟没更新（电脑睡过也会这样）—— 主程序还在就继续盯，不退出`); staleLogged = true; }
      } else { staleLogged = false; }
    } catch { /* 心跳文件暂时没有也不退出：主程序死活由锁文件判定 */ }

    // 2) 主程序还在吗？用**锁文件里的 PID** 判定（比记 pid 更准：主程序重启后 PID 会变）
    const lockPid = readLockPid(cfg.lockFile);
    if (lockPid && alive(lockPid)) {
      // 进程活着也可能"瘫着"（一堆报错、扩展全没加载）—— 这就是"冒红"，自己救一次
      // 日志检查节流：每 4 轮（≈1 分钟）看一眼就够，不用每 15 秒去读日志文件
      if (cfg.restartOnErrorBurst !== false && ticks % 4 === 0 && Date.now() - lastRedRestart > 20 * 60 * 1000) {
        const burst = errorBurst();
        if (burst >= Math.max(3, Number(cfg.errorBurstThreshold) || 8)) {
          const st = loadState();
          const used = recentRestarts(st);
          const maxR = Math.max(1, Number(cfg.maxRestarts) || 2);
          if (used.length < maxR) {
            lastRedRestart = Date.now();
            say(`日志冒红（最近 ${burst} 条 ERROR）→ 自己重启一次`);
            st.restarts = used.concat([Date.now()]);
            try { fs.writeFileSync(cfg.stateFile, JSON.stringify(Object.assign({}, st, { updatedAt: Date.now() })), 'utf8'); } catch { /* 忽略 */ }
            try { fs.unlinkSync(cfg.lockFile); } catch { /* 忽略 */ }
            spawnApp('日志冒红，自动重启');
            await notifyWithRetry('QQ Agent 日志里出现一串报错（冒红了），看门狗自己帮你重启了一次 —— 醒来瞄一眼日志吧。');
            await sleep(25000);
            continue;
          } else {
            say(`日志冒红，但时间窗内已重启 ${used.length} 次（上限 ${maxR}）→ 不再自动重启`);
          }
        }
      }
      continue;
    }

    // 3) 主程序没了：区分正常关闭 / 异常退出
    if (!fs.existsSync(cfg.lockFile)) {
      say('主程序已正常关闭（锁已释放）→ 看门狗退出，不重启');
      process.exit(0);
    }

    // 异常退出（锁里留着已死进程的 PID）
    const state = loadState();
    const used = recentRestarts(state);
    const max = Math.max(1, Number(cfg.maxRestarts) || 2);
    if (used.length >= max) {
      say(`时间窗内已自动重启 ${used.length} 次（上限 ${max}）→ 不再重启，避免崩溃循环`);
      await notify(`QQ Agent 反复异常退出（${cfg.restartWindowHours} 小时内已重启 ${used.length} 次），看门狗已停止自动重启。\n需要看一下日志：${path.join(path.dirname(cfg.stateFile), 'logs')}`);
      process.exit(0);
    }

    // 清掉陈旧锁：不清的话，若那个 PID 恰好被别的进程复用，主程序会误判"已有实例"而拒绝启动
    try { fs.unlinkSync(cfg.lockFile); } catch { /* 忽略 */ }

    say('检测到异常退出 → 正在拉起主程序');
    try {
      const env = Object.assign({}, process.env);
      delete env.ELECTRON_RUN_AS_NODE;   // 不清掉它，Electron 会以"node 模式"跑、秒退无窗口
      const child = spawn(cfg.exePath, [], { detached: true, stdio: 'ignore', cwd: cfg.workDir, env });
      child.on('error', (e) => say('拉起出错：' + (e && e.message)));
      child.unref();
      say(`已拉起（PID ${child.pid}）`);
    } catch (e) {
      say('拉起失败：' + (e && e.message));
      await notify('QQ Agent 崩溃了，但自动重启失败：' + (e && e.message));
      process.exit(0);
    }

    state.restarts = used.concat([Date.now()]);
    try { fs.writeFileSync(cfg.stateFile, JSON.stringify(Object.assign({}, state, { updatedAt: Date.now() })), 'utf8'); } catch { /* 忽略 */ }
    await notifyWithRetry('QQ Agent 疑似异常退出（崩溃或被强杀），看门狗已自动帮你重新启动 —— 请留意它有没有恢复正常。');

    // 等它起来，再继续盯
    await sleep(25000);
    const newPid = readLockPid(cfg.lockFile);
    say(newPid && alive(newPid) ? `主程序已恢复（PID ${newPid}）` : '主程序似乎没起来（下一轮继续观察）');
  }
})();
