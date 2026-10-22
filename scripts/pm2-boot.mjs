// 登录引导 + 常驻：等应用 Web 服务就绪后，拉起 SnowLuma 与便携 QQ，
// 然后保持在线（PM2 记为 online），这样 `pm2 resurrect` 每次登录都会拉起它。
//
// 为什么单独一个 PM2 进程：
//   · 应用本身只负责 Web/编排/OneBot，不负责在开机时拉起协议端与 QQ；
//   · 本脚本会轮询 /api/status，所以不怕应用慢；
//   · 引导完成后不退出，`pm2 save` 会把它存成 online，用户原有的
//     “PM2 Resurrect on Logon” 任务就能在登录时自动恢复它。
//
// 失败不抛未捕获异常：日志写到 logs/pm2-boot.out.log，应用本身仍可用；
// QQ 需要扫码时这里会超时，但进程保持在线，UI 里仍可手动启动。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = String(process.env.QQ_AGENT_BASE_URL || 'http://127.0.0.1:3210').replace(/\/+$/, '');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.resolve(HERE, '..');
const log = (...args) => console.log(new Date().toISOString(), '[pm2-boot]', ...args);

async function call(method, pathname, body) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${pathname} -> HTTP ${res.status} ${data?.error || ''}`.trim());
  return data;
}

async function waitFor(label, timeoutMs, fn, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${label} 等待超时${lastError ? `：${lastError.message}` : ''}`);
}

/** SnowLuma 需要 hookAutoLoad=true，QQ 才会被注入 OneBot。 */
function ensureHookAutoLoad() {
  const file = path.join(SOURCE, 'snowluma', 'config', 'runtime.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cfg.hookAutoLoad === true) return;
    cfg.hookAutoLoad = true;
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    log('已把 snowluma/config/runtime.json 的 hookAutoLoad 置为 true');
  } catch (error) {
    log(`检查 hookAutoLoad 失败（继续）：${error?.message || error}`);
  }
}

try {
  log(`等待应用就绪：${BASE}`);
  await waitFor('应用服务', 180000, async () => {
    try { return await call('GET', '/api/status'); } catch { return null; }
  });
  log('应用已就绪');

  ensureHookAutoLoad();

  let status = await call('GET', '/api/status');
  if (status?.snowluma?.running) {
    log(`SnowLuma 已在运行（pid=${status.snowluma.pid}）`);
  } else {
    log('SnowLuma 未运行，尝试启动');
    try {
      const r = await call('POST', '/api/snowluma/launch', {});
      log(`launch 已受理${r?.pid ? `（pid=${r.pid}）` : ''}`);
    } catch (error) {
      log(`launch 请求失败（继续等待）：${error.message}`);
    }
    await waitFor('SnowLuma WebUI', 120000, async () => {
      const s = await call('GET', '/api/status');
      return s?.snowluma?.running ? s : null;
    });
    log('SnowLuma 已运行');
  }

  const qq = await call('GET', '/api/qq-portable/status');
  if (qq?.running) {
    log(`便携 QQ 已在运行（pid=${qq.pid}）`);
  } else if (!qq?.ready) {
    log('便携 QQ 未安装/未就绪，跳过');
  } else {
    log('便携 QQ 未运行，尝试启动');
    try {
      const r = await call('POST', '/api/qq-portable/launch', {});
      log(`QQ 启动已受理${r?.pid ? `（pid=${r.pid}）` : ''}`);
    } catch (error) {
      log(`QQ 启动请求失败（继续等待）：${error.message}`);
    }
    await waitFor('便携 QQ', 60000, async () => {
      const s = await call('GET', '/api/qq-portable/status');
      return s?.running ? s : null;
    });
    log('便携 QQ 已运行');
  }

  log('等待 OneBot 连接（如需扫码请在弹出的 QQ 窗口登录）');
  try {
    const connected = await waitFor('OneBot 连接', 120000, async () => {
      const s = await call('GET', '/api/status');
      return s?.onebot?.connected ? s : null;
    }, 1500);
    log(`OneBot 已连接：${connected.onebot?.self?.nickname || '?'}（${connected.onebot?.self?.userId || '?'}）`);
  } catch (error) {
    log(`OneBot 未在超时内连接（可稍后在控制台手动启动/登录）：${error.message}`);
  }
} catch (error) {
  log(`引导失败：${error?.message || error}`);
}

// 引导流程结束：保持一个长效定时器让事件循环存活，PM2 才会记为 online。
// 不要 process.exit —— 否则 pm2 save 会存成 stopped，登录时 resurrect 不会启动它。
log('引导流程结束，保持在线等待下次 PM2 重启');
setInterval(() => {}, 6 * 60 * 60 * 1000);
