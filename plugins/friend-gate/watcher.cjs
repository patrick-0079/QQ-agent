// 好友申请盯梢（friend-gate 的独立小进程）
//
// 为什么需要它：**这版 SnowLuma 不推 OneBot 的 request 事件**，所以核心收不到"有人加你好友"。
// 但它自己会把这件事写进日志（实测）。
// 于是这里盯它的日志：抓到就 ① 记进待处理表（给插件 friend-gate 用）② **直接调 OneBot 接口私聊机主**。
//
// 用法：node watcher.cjs            常驻（每 10 秒看一眼）
//       node watcher.cjs --once     只跑一次（用来验证/排错）
//       node watcher.cjs --once --no-send   只解析不发消息（干跑）
//
// 注意：本文件**不能被 JSON 覆盖**（guardian 踩过：把配置写到脚本路径上，脚本被覆盖成 JSON 就静默失效）。

const fs = require('node:fs');
const path = require('node:path');

const ARGS = process.argv.slice(2);
const ONCE = ARGS.includes('--once');
const NO_SEND = ARGS.includes('--no-send');

/** 程序根目录：resources/app/plugins/friend-gate/watcher.cjs → 往上 2 级是 resources/app */
const HERE = __dirname;
const APP_ROOT = path.resolve(HERE, '..', '..');                 // resources/app
const PROG_ROOT = path.resolve(APP_ROOT, '..', '..');            // QQ Agent（程序根）
const DATA = path.join(PROG_ROOT, 'data');
const SL_DIRS_TRY = [
  path.join(__dirname, '..', '..', 'snowluma', 'logs'),
  path.join(__dirname, '..', '..', '..', 'snowluma', 'logs'),
  path.join(DATA, '..', 'snowluma', 'logs'),
  'D:\\QQagnet\\QQ Agent\\resources\\app\\snowluma\\logs'
].filter((x) => { try { return fs.existsSync(x) && fs.readdirSync(x).some((f) => /\.log$/.test(f)); } catch { return false; } });
const SL_LOG_DIR = path.join(APP_ROOT, 'snowluma', 'logs');
const STATE_FILE = path.join(DATA, 'friend-watch-state.json');
const PENDING_FILE = path.join(DATA, 'pending-friend-requests.json');
const WATCH_LOG = path.join(DATA, 'friend-watch.log');
const NOTIFIED_FILE = path.join(DATA, 'friend-watch-notified.json');   // 通知过的 QQ（不依赖待处理表，避免"条目被清掉就漏加白名单"）

function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN')}] ${msg}\n`;
  try { fs.appendFileSync(WATCH_LOG, line, 'utf8'); } catch { /* 忽略 */ }
  if (ONCE) process.stdout.write(line);
}

function readJson(p, dft) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dft; }
}

function writeJson(p, v) {
  try { fs.writeFileSync(p, JSON.stringify(v, null, 1), 'utf8'); } catch (e) { log('写文件失败 ' + p + '：' + e.message); }
}

/** 机主 QQ：在 data/config.json 里递归找 ownerQq/owners/admins */
function owners() {
  const cfg = readJson(path.join(DATA, 'config.json'), {});
  const found = [];
  const walk = (o, d) => {
    if (!o || typeof o !== 'object' || d > 4) return;
    for (const [k, v] of Object.entries(o)) {
      if (/^(ownerQq|owners|admins|ownerId)$/i.test(k) && typeof v === 'string' && /\d{5,}/.test(v)) found.push(v);
      else if (v && typeof v === 'object') walk(v, d + 1);
    }
  };
  walk(cfg, 0);
  return Array.from(new Set(found.flatMap((x) => String(x).split(/[^\d]+/).filter(Boolean))));
}

/** OneBot 的 accessToken + 端口（从 snowluma 的配置里读） */
function onebotConf() {
  const dir = path.join(APP_ROOT, 'snowluma', 'config');
  let token = '', port = 3000;
  try {
    const f = fs.readdirSync(dir).find((x) => /^onebot_.*\.json$/.test(x));
    if (f) {
      const j = readJson(path.join(dir, f), {});
      const hs = (j.networks && j.networks.httpServers) || [];
      const ws = (j.networks && j.networks.wsServers) || [];
      token = String((hs[0] && hs[0].accessToken) || (ws[0] && ws[0].accessToken) || '');
      port = Number((hs[0] && hs[0].port) || 3000);
    }
  } catch (e) { log('读 onebot 配置失败：' + e.message); }
  return { token, port };
}

async function sendPrivate(userId, text) {
  const { token, port } = await pickWorkingOnebot();
  const res = await fetch(`http://127.0.0.1:${port}/send_private_msg`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify({ user_id: Number(userId), message: text })
  });
  const body = await res.json().catch(() => ({}));
  if (body.status !== 'ok' && body.retcode !== 0) throw new Error('OneBot 返回：' + JSON.stringify(body).slice(0, 120));
  return body;
}

/** 今天的 SnowLuma 日志里，最后的"请求添加你为好友" */
function scanLog() {
  const today = new Date();
  const f = path.join(SL_LOG_DIR, `snowluma-${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}.log`);
  let text = '';
  try {
    const stat = fs.statSync(f);
    const start = Math.max(0, stat.size - 256 * 1024);       // 只读最后 256KB
    const fd = fs.openSync(f, 'r');
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch (e) { return []; }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!/请求添加你为好友/.test(line)) continue;
    const qq = (line.match(/私聊\s+(\d+)/) || [])[1] || '';
    const id = (line.match(/ID:\s*(-?\d+)/) || [])[1] || '';
    if (!qq && !id) continue;
    out.push({ qq, id, key: `${qq}|${id}`, raw: line.trim().slice(0, 200) });
  }
  return out;
}

/** 当前好友列表（QQ 号集合）：已经通过过的申请绝不再通知一遍。 */
async function friendSet() {
  const { token, port } = await pickWorkingOnebot();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/get_friend_list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: '{}'
    });
    const body = await res.json().catch(() => ({}));
    const arr = Array.isArray(body.data) ? body.data : [];
    return new Set(arr.map((x) => String((x && x.user_id) != null ? x.user_id : x)).filter(Boolean));
  } catch (e) { log('取好友列表失败（这轮就不跳过任何人）：' + e.message); return null; }
}

const SETTINGS_FILE = path.join(DATA, 'config.json');

/** 读插件自己的设置（好友申请管家 → autoApprove 等） */
function pluginCfg() {
  try {
    const c = readJson(SETTINGS_FILE, {});
    const s = (c.skills && c.skills['friend-gate'] && c.skills['friend-gate'].settings) || {};
    return Object.assign({ autoApprove: false, maxPerHour: 10, notifyQq: '' }, s);
  } catch { return { autoApprove: false, maxPerHour: 10, notifyQq: '' }; }
}

function isBlocked(qq) {
  try {
    const c = readJson(SETTINGS_FILE, {});
    const g = new Set(((c.globalBlocklist) || []).map(String));
    const d = new Set((((c.deny || {}).private) || []).map(String));
    return g.has(String(qq)) || d.has(String(qq));
  } catch { return false; }
}

const acceptedAt = [];
function allowThisHour(max) {
  const now = Date.now();
  while (acceptedAt.length && now - acceptedAt[0] > 3600000) acceptedAt.shift();
  return acceptedAt.length < Math.max(1, Number(max) || 10);
}

/** 真·全自动：用 **QQ 号**当 flag 调 set_friend_add_request（SnowLuma 会把数字解析成 UID ✅） */
async function autoApproveNow(qq) {
  const conf = await pickWorkingOnebot();
  const body = JSON.stringify({ flag: String(qq), approve: true });
  const res = await fetch(`http://127.0.0.1:${conf.port}/set_friend_add_request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: 'Bearer ' + conf.token },
    body
  });
  const j = await res.json().catch(() => ({}));
  const ok = j.status === 'ok' || j.retcode === 0;
  if (ok) acceptedAt.push(Date.now());
  log(`自动通过 QQ ${qq} → ${ok ? '成功 ✅' : '失败 ❌ ' + JSON.stringify(j).slice(0, 120)}`);
  return ok;
}

/** 汇报对象：默认=机主；填了 notifyQq 就只汇报给这几个号（机主要求：可以指定而不是机主）。 */
function notifyTargets() {
  try {
    const s = pluginCfg();
    const raw = String(s.notifyQq || '').trim();
    if (raw) {
      const list = raw.split(/[^\d]+/).filter((x) => x.length >= 5);
      if (list.length) { log(`汇报对象：指定 ${list.join('/')}（不是机主）`); return list; }
    }
  } catch (e) { /* 忽略 */ }
  return owners();
}

/** 挑一份**能用的** SnowLuma 配置：目录里可能有多份账号配置，第一份的令牌未必有效。 */
async function pickWorkingOnebot() {
  const dirs = [];
  try {
    dirs.push(path.join(__dirname, '..', '..', 'snowluma', 'config'));
    dirs.push(path.join(__dirname, '..', '..', '..', 'snowluma', 'config'));
    dirs.push('D:\\QQagnet\\QQ Agent\\resources\\app\\snowluma\\config');
  } catch (e) { /* 忽略 */ }
  const cands = [];
  for (const d of dirs) {
    try {
      if (!fs.existsSync(d)) continue;
      for (const f of fs.readdirSync(d)) {
        if (!/^onebot_.*\.json$/.test(f)) continue;
        const j = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
        const hs = (j.networks && j.networks.httpServers) || [];
        const ws = (j.networks && j.networks.wsServers) || [];
        cands.push({
          base: 'http://127.0.0.1:' + Number((hs[0] && hs[0].port) || 3000),
          token: String((hs[0] && hs[0].accessToken) || (ws[0] && ws[0].accessToken) || ''),
          file: f
        });
      }
      if (cands.length) break;
    } catch (e) { /* 下一个目录 */ }
  }
  const withPort = (c) => ({ token: c.token, port: Number((c.base.match(/:(\d+)$/) || [])[1] || 3000), file: c.file, base: c.base });
  if (!cands.length) return { token: '', port: 3000, file: '(默认)' };
  if (cands.length === 1) return withPort(cands[0]);
  for (const c of cands) {
    try {
      const r = await fetch(c.base + '/get_login_info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(c.token ? { Authorization: 'Bearer ' + c.token } : {}) },
        body: '{}'
      });
      const b = await r.json().catch(() => ({}));
      if (b.status === 'ok' || b.retcode === 0) { log('令牌探活：用 ' + c.file + ' ✅'); return withPort(c); }
      log('令牌探活：' + c.file + ' 不可用（' + ((b && b.wording) || r.status) + '）→ 试下一份');
    } catch (e) { log('令牌探活：' + c.file + ' 异常 ' + (e && e.message)); }
  }
  return withPort(cands[0]);
}

async function tick() {
  const hits = scanLog();
  const friends = await friendSet();
  // 优化：不只是"日志命中的那些"要跳过 —— 待处理表里凡是**已经变成好友**的，一律清掉
  // （机主的要求：已通过的别再打扰他；表里留着也会让 friend_pending 报错数）
  try {
    const pend0 = readJson(PENDING_FILE, { list: [] });
    const list0 = Array.isArray(pend0.list) ? pend0.list : [];
    if (friends && list0.length) {
      const became = list0.filter((x) => x && x.userId && friends.has(String(x.userId)));
      const kept = list0.filter((x) => !(x && x.userId && friends.has(String(x.userId))));
      if (became.length) {
        // 机主已经手动点了"添加" → 顺手把这个 QQ 加进**聊天白名单**（否则机器人不会理他）
        try {
          const cfgW = readJson(path.join(DATA, 'config.json'), {});
          const arr = Array.isArray(cfgW.allow && cfgW.allow.private) ? cfgW.allow.private.map(String) : [];
          const add = became.map((x) => String(x.userId)).filter((q) => q && !arr.includes(q));
          if (add.length) {
            const next = arr.concat(add);
            const res = await fetch('http://127.0.0.1:3210/api/config', {
              method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
              body: JSON.stringify({ allow: { private: next } })
            });
            log(`已把 ${add.join('/')} 加进聊天白名单（HTTP ${res.status}）`);
          }
        } catch (e) { log('加白名单失败：' + e.message); }
        writeJson(PENDING_FILE, { list: kept });
        log(`清理待处理表：${became.length} 条已经成了好友`);
      }
    }
  } catch (e) { /* 清理失败不影响下面 */ }
  // 整理：同一个 QQ 只留最新那条申请（旧 flag 已失效，留着会让"同意"点空）
  try {
    const pend1 = readJson(PENDING_FILE, { list: [] });
    const l1 = Array.isArray(pend1.list) ? pend1.list : [];
    const seenQ = new Set();
    const kept = l1.filter((x) => {
      const q = String((x && (x.userId || x.groupId)) || '');
      if (!q) return false;
      if (seenQ.has(q)) return false;
      seenQ.add(q);
      return true;
    });
    if (kept.length !== l1.length) {
      writeJson(PENDING_FILE, { list: kept });
      log(`整理待处理表：${l1.length - kept.length} 条重复（同一人多次申请）删掉`);
    }
  } catch (e) { /* 忽略 */ }
  // 通知过的 QQ 只要**变成好友**了 → 就把他加进聊天白名单（不依赖"待处理条目还在"，避免漏掉）
  try {
    if (friends) {
      const nf = readJson(NOTIFIED_FILE, { list: [] });
      const nl = Array.isArray(nf.list) ? nf.list : [];
      const became = nl.filter((x) => x && friends.has(String(x.qq)));
      if (became.length) {
        const cfgW = readJson(path.join(DATA, 'config.json'), {});
        const arr = Array.isArray(cfgW.allow && cfgW.allow.private) ? cfgW.allow.private.map(String) : [];
        const add = became.map((x) => String(x.qq)).filter((q) => q && !arr.includes(q));
        if (add.length) {
          try {
            const res = await fetch('http://127.0.0.1:3210/api/config', {
              method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
              body: JSON.stringify({ allow: { private: arr.concat(add) } })
            });
            log(`已把 ${add.join('/')} 加进聊天白名单（HTTP ${res.status}）`);
          } catch (e) { log('加白名单失败：' + e.message); }
        }
        writeJson(NOTIFIED_FILE, { list: nl.filter((x) => !became.includes(x)) });
      }
    }
  } catch (e) { /* 忽略 */ }
  if (!hits.length) return 0;
  const state = readJson(STATE_FILE, { seen: [] });
  const seen = new Set(Array.isArray(state.seen) ? state.seen : []);
  let acted = 0;
  for (const h of hits) {
    if (seen.has(h.key)) continue;
    // 已经由 WS 那一路抓到过了（它有真 flag，通知也发过了）→ 这一路闭嘴，别重复打扰
    try {
      const pj = readJson(PENDING_FILE, { list: [] });
      const dup = (Array.isArray(pj.list) ? pj.list : []).some((x) => x && x.from === 'ws' && String(x.userId || '') === String(h.qq));
      if (dup) { seen.add(h.key); continue; }
    } catch (e) { /* 忽略 */ }
    // 已经在好友列表里 = 这个申请早就通过了（或本来就是好友）→ 别打扰机主
    if (friends && h.qq && friends.has(String(h.qq))) {
      seen.add(h.key);
      log(`跳过：QQ ${h.qq} 已经是好友（申请早通过了）`);
      const pend0 = readJson(PENDING_FILE, { list: [] });
      writeJson(PENDING_FILE, { list: (Array.isArray(pend0.list) ? pend0.list : []).filter((x) => String(x.userId || '') !== String(h.qq)) });
      continue;
    }
    seen.add(h.key);
    acted++;
    try { const nf = readJson(NOTIFIED_FILE, { list: [] }); const nl = Array.isArray(nf.list) ? nf.list : []; if (!nl.some((x) => String(x.qq) === String(h.qq))) { nl.unshift({ qq: h.qq, at: Date.now() }); writeJson(NOTIFIED_FILE, { list: nl.slice(0, 200) }); } } catch (e) { /* 忽略 */ }
    log(`发现好友申请：QQ ${h.qq}（ID ${h.id}）`);
    // ① 记进待处理表（插件 friend-gate 的 friend_decide 靠这个 flag 去点同意）
    const pend = readJson(PENDING_FILE, { list: [] });
    let list = Array.isArray(pend.list) ? pend.list : [];
    // 同一个人申请多次：只留最新那条（旧 flag 已经失效，留着会让"同意"点空）
    list = list.filter((x) => String(x.userId || '') !== String(h.qq));
    if (!list.some((x) => String(x.flag || '') === String(h.id))) {
      list.unshift({ type: 'friend', userId: h.qq, groupId: '', comment: '(SnowLuma 日志抓到)', flag: String(h.qq), at: Date.now(), from: 'log' });
      writeJson(PENDING_FILE, { list: list.slice(0, 50) });
    }
    // ② 私聊通知机主（顺带标出"在不在聊天白名单里" —— 影响的是"同意后机器人理不理他"）
    if (!NO_SEND) {
      let wlNote = '';
      try {
        const cfg2 = readJson(path.join(DATA, 'config.json'), {});
        const arr = Array.isArray(cfg2.allow && cfg2.allow.private) ? cfg2.allow.private.map(String) : [];
        wlNote = arr.length === 0
          ? '（聊天白名单是空的 = 谁都能聊）'
          : (arr.includes(String(h.qq)) ? '（已经在聊天白名单里）' : '（**还不在聊天白名单里** —— 你回「同意」我会顺手把他加进去）');
      } catch (e) { /* 忽略 */ }
      const msg = `有人要加你好友：QQ ${h.qq}\n${wlNote}\n回我一句「同意」我就帮你点通过（点完会把他加进聊天白名单）；不想加就说「拒绝」`;
      // ── 真·全自动：用 **QQ 号**当 flag 调 set_friend_add_request（SnowLuma 会把数字解析成 UID ✅）──
      const pc = pluginCfg();
      let autoNote = '';
      if (pc.autoApprove !== false) {
        if (isBlocked(h.qq)) {
          autoNote = '\n（这个号在**黑名单**里 —— 我没有自动通过）';
        } else if (!allowThisHour(pc.maxPerHour)) {
          autoNote = '\n（这一小时自动通过已达上限 ' + pc.maxPerHour + ' 个 —— 这条留给你手点）';
        } else {
          const okAuto = await autoApproveNow(h.qq);
          autoNote = okAuto ? '\n✅ **已经自动帮你通过了**（接着会加进聊天白名单）' : '\n⚠️ 自动通过没成功，你手点一下「添加」';
        }
      }
        + `\n（这版 SnowLuma 不给"同意"用的凭证，所以我点不了；你点完我会自动把他加进聊天白名单）`;
      for (const o of notifyTargets()) {
        try { await sendPrivate(o, msg + autoNote); log(`已私聊通知 ${o}`); } catch (e) { log(`通知 ${o} 失败：${e.message}`); }
      }
    }
  }
  writeJson(STATE_FILE, { seen: Array.from(seen).slice(-500) });
  return acted;
}

(async () => {
  log(`盯梢启动 | 数据 ${DATA} | 日志目录 ${SL_LOG_DIR}`);
  if (ONCE) {
    const n = await tick();
    log(`跑了一次：处理 ${n} 条`);
    return;
  }
  for (;;) {
    try { await tick(); } catch (e) { log('tick 出错：' + (e && e.message)); }
    await new Promise((r) => setTimeout(r, 10000));
  }
})();