// 好友申请管家（friend-gate）
//
// 机主要的效果（一条闭环）：
//   ① 有人加好友/拉群 → 私聊通知机主（**核心** `src/app.js` 的 handleAddRequestInline 负责通知+落盘）
//   ② 机主在私聊说「同意 / 拒绝」→ 机器人调 OneBot 的 set_*_add_request 去点
//   ③ 同意之后，机主再说「给他用小鲸鱼人设」→ 只给**那一个人**按会话覆盖人设（不动全局）
//   ④ 只有机主能操作：别人调这几个工具一律拦掉
//
// 为什么用插件 + 工具，而不是纯钩子：**插件本体拿不到 onebot**（发消息/调接口都在工具上下文里），
// 所以"点同意"这件事必须由一个工具去做；钩子负责"在机主的私聊里塞一句待处理提示"。
//
// 踩过的坑：入口必须**具名导出** `setup` + `hooks`，写成 export default 会被核心拒绝。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';          // 之前漏了这行 → 报 "fileURLToPath is not defined"
import { spawn } from 'node:child_process';         // 拉盯梢/ WS 监听用

const DEFAULTS = {
  // 默认关闭：加载扩展时不能直接拉起 watcher / WS 盯梢进程。
  // 要用的人在设置里打开「总开关」，setup/activate 才会启动后台监听。
  enabled: false,
  ownerOnly: true,
  owners: '',              // ★ 本插件自己的机主名单（首要；只填这里就能用，不用装别的插件）
  extraOwnerQq: '',        // 本插件自己的机主名单（不依赖别的插件；逗号分隔）
  acceptAdmins: false,     // 是否把 admin-roster 的「普通管理员」也算机主（默认否 —— 只有机主能拍板）
  approveWords: '同意,通过,批准,加他,加上,准了',
  autoWhitelist: true,
  autoApprove: false,        // 机主要求：**他拍板了才点**（默认等他说「同意」）
  rejectWords: '拒绝,不同意,拒了,别加,pass'
};

let api = null;
let log = () => {};
let dataDirNow = '';
// 自我审查发现的两个问题：① 原来 lastResult 是全局的，多个机主会话会串台；
// ② 上一轮办的结论如果没被消费掉，会残留到下一轮。→ 改成按会话存 + 记时间，只认 2 分钟内的。
const lastResultByKey = new Map();
function setResult(ctx, text) {
  const k = String((ctx && (ctx.sessionId || ctx.chatKey)) || 'global');
  lastResultByKey.set(k, { text, at: Date.now() });
  if (lastResultByKey.size > 50) lastResultByKey.delete(lastResultByKey.keys().next().value);
}
function takeResult(ctx) {
  const k = String((ctx && (ctx.sessionId || ctx.chatKey)) || 'global');
  const r = lastResultByKey.get(k);
  lastResultByKey.delete(k);
  if (!r || Date.now() - r.at > 120000) return '';
  return r.text;
}

function settings() {
  try {
    const c = api && typeof api.config === 'function' ? api.config() : null;
    return Object.assign({}, DEFAULTS, c || {});
  } catch { return Object.assign({}, DEFAULTS); }
}

function dataDir() {
    if (dataDirNow) return dataDirNow;
    // ⚠️ 顺序很重要（踩过）：**必须优先用程序自己给的数据目录**。
    //    以前把绝对路径写第一个 —— 换台机器（装在用户目录下的）就会
    //    指向一个不存在的目录，状态文件写不进去，表现就是"插件装上却毫无反应"。
    const cands = [];
    try {
      cands.push(
        (api && api.dataDir),
        (api && api.paths && api.paths.dataDir),
        (api && api.dataPath),
        (api && api.data && api.data.dir),
        process.env.QQ_AGENT_DATA,
        path.join(process.cwd(), 'data')
      );
      // 兜底：从插件目录往上找（不同安装方式的层级不一样，都列上，最后用存在的那个）
      const here = path.dirname(fileURLToPath(import.meta.url));
      cands.push(
        path.join(here, '..', '..', '..', '..', 'data'),
        path.join(here, '..', '..', '..', 'data'),
        path.join(here, '..', '..', 'data')
      );
    } catch { /* 忽略 */ }
    for (const c of cands) {
      try {
        if (!c) continue;
        const p = String(c);
        // 必须"存在且可写"才算数 —— 否则继续找下一个
        if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
          fs.accessSync(p, fs.constants.W_OK);
          dataDirNow = p;
          log('[friend-gate] 数据目录：' + p);
          return p;
        }
      } catch { /* 下一个 */ }
    }
    dataDirNow = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
    try { fs.mkdirSync(dataDirNow, { recursive: true }); } catch { /* 忽略 */ }
    log('[friend-gate] ⚠️ 没找到可写的数据目录，退到插件自己的 data/ 目录：' + dataDirNow);
    return dataDirNow;
  }

/** 读核心写的待处理申请（核心负责写，本插件负责读+处理完删）。 */
function loadPending() {
  try {
    const p = path.join(dataDir(), 'pending-friend-requests.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(j.list) ? j.list : [];
  } catch { return []; }
}

function savePending(list) {
  try {
    const p = path.join(dataDir(), 'pending-friend-requests.json');
    fs.writeFileSync(p, JSON.stringify({ list: Array.isArray(list) ? list : [] }, null, 1), 'utf8');
  } catch (e) { log('[friend-gate] 写待处理表失败：' + (e && e.message)); }
}

/** 读全局配置（ownerQq / persona.overrides 等）。 */
function appCfg() {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir(), 'config.json'), 'utf8'));
  } catch { return {}; }
}

function owners() {
  try {
    const c = appCfg() || {};
    const s = settings();
    const out = [];
    const push = (v) => {
      if (v == null) return;
      // ⚠️ 空串必须当作"没填" —— 否则 out.length 被空串撑成 1，下面的"回落"分支永远不执行（自己踩过）
      if (typeof v === 'string' && !v.trim()) return;
      if (typeof v === 'string' || typeof v === 'number') out.push(String(v));
      else if (Array.isArray(v)) v.forEach((x) => { if (x != null && String(x).trim()) out.push(String(x)); });
    };
    // ① **本插件自己的名单**（首选！—— 这样不用装"管理员名单"也能用，一看就懂）
    push(s.owners);
    push(s.extraOwnerQq);          // 兼容旧字段名
    // ② 只有本插件没填时，才回落到核心/别的插件（保持老配置还能用）
    if (!out.length) {
      push(c.ownerQq);
      push(c.ownerId);
      const ar = (c.skills && c.skills['admin-roster']) || null;
      if (ar && ar.enabled !== false) {
        const st = Object.assign({}, ar, ar.settings || {});
        push(st.owners);
        if (s.acceptAdmins === true) push(st.admins);
      }
    }
    const list = Array.from(new Set(out.flatMap((x) => String(x).split(/[^\d]+/).filter((n) => n.length >= 5))));
    if (!list.length) {
      // 一个人的名单都没配 → 保持"关着"（不乱放行），并留下痕迹让机主知道要配
      log('[friend-gate] ⚠️ 机主名单是空的：请在「管理员名单」里填 owners，或在本插件设置里填 extraOwnerQq');
    }
    return list;
  } catch { return []; }
}

function isOwner(ctx) {
  try {
    if (String(ctx.kind || '') !== 'private') return false;
    const me = String(ctx.chatId == null ? '' : ctx.chatId);
    return owners().includes(me);
  } catch { return false; }
}

/** 工具上下文里翻出 onebot（不同核心版本可能把参数顺序/位置放得不一样，全试一遍）。 */
function onebotOf() {
  for (const a of Array.from(arguments)) {
    if (a && a.onebot && typeof a.onebot.call === 'function') return a.onebot;
    if (a && a.call && typeof a.call === 'function' && a.call.length >= 1 && a.onebot) return a.onebot;
  }
  return null;
}

function describe(it) {
  const who = it.type === 'group' ? ('群 ' + (it.groupId || '')) : ('QQ ' + (it.userId || ''));
  return who + (it.comment ? ('「' + it.comment + '」') : '');
}

/** 拉起/复用"盯 SnowLuma 日志"的小进程（幂等：pidfile 里那个还活着就不重复拉）。 */
function ensureWatcher() {
  try {
    const pidFile = path.join(dataDir(), 'friend-watch.pid');
    let pid = 0;
    try { pid = Number(String(fs.readFileSync(pidFile, 'utf8')).trim()) || 0; } catch { pid = 0; }
    if (pid) { try { process.kill(pid, 0); return; } catch { /* 已死，重新拉 */ } }
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'watcher.cjs');
    if (!fs.existsSync(script)) return;
    const child = spawn(process.execPath, [script], {
      detached: true, stdio: 'ignore', windowsHide: true,
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' })
    });
    if (child && typeof child.unref === 'function') child.unref();
    try { fs.writeFileSync(pidFile, String(child.pid), 'utf8'); } catch { /* 忽略 */ }
    log('[friend-gate] 盯梢进程已拉起 pid=' + (child && child.pid));
  } catch (e) { log('[friend-gate] 拉盯梢进程失败：' + (e && e.message)); }
}

// 2026-10-21：旧 config.allow 已迁移成 chatProfiles 并删除；
// 现在“加白名单”= 给这个会话建 profile（默认会话之外唯一准入方式）。
async function addToWhitelist(kind, id) {
  const target = String(id || '').trim();
  if (!/^\d{5 }$/.test(target)) return false;
  try {
    const res = await fetch('http://127.0.0.1:3210/api/chat-profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ kind: kind === 'group' ? 'group' : 'private', id: target })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return true;
  } catch (e) { log('[friend-gate] 加白名单失败：' + (e && e.message)); return false; }
}

/** OneBot 的 token+端口（从 SnowLuma 配置读）——插件本体没有 onebot，但可以直接打它的 HTTP 接口。
 *  原因：实测模型会"嘴上说同意了"却不调工具（两次），所以这条关键动作改由插件**自己**做。 */
function onebotConf() {
    const s = settings();
    // ① 设置里写了就用它（万能口子）
    const raw = String(s.onebotHttp || '').trim();
    if (raw) {
      let base = raw.replace(/\/+$/, '');
      if (!/^https?:\/\//i.test(base)) base = 'http://' + base;
      return { base, token: String(s.onebotToken || '').trim(), from: 'settings' };
    }
    // ② 读 SnowLuma 的配置。⚠️ **一个目录里可能有多份账号配置**（onebot_<QQ>.json），
    //    以前 find() 直接取第一个 —— 万一那份是**换个号留下的旧配置**，令牌就是失效的，
    //    结果：好友列表拿不到、私聊通知 unauthorized、点同意也调不动（实测踩过）。
    //    现在：先把所有候选挑出来，再**逐个探活**，用真正能用的那份。
    const cands = [];
    try {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const appRoot = path.resolve(here, '..', '..');
      const dirs = [
        path.join(appRoot, 'snowluma', 'config'),
        path.join(appRoot, 'resources', 'snowluma', 'config'),
        path.join(appRoot, '..', 'snowluma', 'config'),
      ];
      for (const dir of dirs) {
        try {
          if (!dir || !fs.existsSync(dir)) continue;
          for (const f of fs.readdirSync(dir)) {
            if (!/^onebot_.*\.json$/.test(f)) continue;
            try {
              const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
              const hs = (j.networks && j.networks.httpServers) || [];
              const ws = (j.networks && j.networks.wsServers) || [];
              const port = Number((hs[0] && hs[0].port) || 3000);
              const tk = String((hs[0] && hs[0].accessToken) || (ws[0] && ws[0].accessToken) || '');
              const num = (f.match(/onebot_(\d+)/) || [])[1] || '';
              cands.push({ base: 'http://127.0.0.1:' + port, token: tk, file: f, qq: num });
            } catch { /* 跳过坏文件 */ }
          }
          if (cands.length) break;   // 找到一个有效目录就够了
        } catch { /* 下一个目录 */ }
      }
    } catch { /* 忽略 */ }
    if (!cands.length) {
      log('[friend-gate] ⚠️ 没找到任何 SnowLuma 配置 → 按标准 http://127.0.0.1:3000 试（要改就在设置里填）');
      return { base: 'http://127.0.0.1:3000', token: String(s.onebotToken || '').trim(), from: 'default' };
    }
    // 记住"哪份好用"，省得每次都探
    const key = cands.map((c) => c.file).join(',');
    if (onebotPick && onebotPick.key === key && cands.some((c) => c.file === onebotPick.file)) {
      const c = cands.find((x) => x.file === onebotPick.file);
      return { base: c.base, token: c.token, from: 'snowluma-cached:' + c.file };
    }
    return { base: cands[0].base, token: cands[0].token, from: 'snowluma-candidate:' + cands[0].file, cands, key };
  }

  /** 逐个探活（get_login_info）：哪份配置的令牌是好的、并且账号号数对得上，就用它。
   *  这一步是异步的，所以单独一个函数；探不到就退回第一份（至少跟以前一样）。 */
  let onebotPick = null;
  async function onebotProbe() {
    const c = onebotConf();
    if (!c || !c.cands || c.cands.length <= 1) return c;
    for (const cand of c.cands) {
      try {
        const r = await fetch(cand.base + '/get_login_info', {
          method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', ...(cand.token ? { Authorization: 'Bearer ' + cand.token } : {}) },
          body: '{}'
        });
        const b = await r.json().catch(() => ({}));
        const uid = String((b && b.data && (b.data.user_id || b.data.uin)) || '');
        if ((b.status === 'ok' || b.retcode === 0) && (!cand.qq || uid === cand.qq)) {
          onebotPick = { file: cand.file, key: c.key };
          log('[friend-gate] 令牌探活：用 ' + cand.file + '（账号 ' + (uid || cand.qq) + '）✅ 其余跳过');
          return { base: cand.base, token: cand.token, from: 'snowluma-probed:' + cand.file };
        }
      } catch { /* 下一个 */ }
    }
    log('[friend-gate] ⚠️ 所有 SnowLuma 配置的令牌都没探通，退回 ' + c.cands[0].file);
    return c;
  }

async function onebotPost(action, params) {
  const c = await onebotProbe();
  if (!c) return { ok: false, err: '读不到 OneBot 配置' };
  try {
    const res = await fetch(`${c.base}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...(c.token ? { Authorization: 'Bearer ' + c.token } : {}) },
      body: JSON.stringify(params || {})
    });
    const body = await res.json().catch(() => ({}));
    const ok = body.status === 'ok' || body.retcode === 0;
    return { ok, body };
  } catch (e) { return { ok: false, err: (e && e.message) || '请求失败' }; }
}

/** 拉起"真 flag 监听器"（ws_watch.py，挂 SnowLuma 的 WS 收 request 事件）。
 *  它比日志那路可靠：手里有**协议要的真 flag** → 机主说"同意"就能真点。 */
function ensureWsWatch() {
  try {
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ws_watch.py');
    if (!fs.existsSync(script)) return;
    const pidFile = path.join(dataDir(), 'ws-watch.pid');
    let pid = 0;
    try { pid = Number(String(fs.readFileSync(pidFile, 'utf8')).trim()) || 0; } catch { pid = 0; }
    if (pid) { try { process.kill(pid, 0); return; } catch { /* 已死 */ } }
    const s = settings();
    const py = String(s.pythonPath || '').trim();

    if (!py) { log('[friend-gate] 没配 Python 路径 → 跳过 WebSocket 监听器（主通道不受影响）'); return; }
    const libs = String(s.pythonLibPath || '');
    const child = spawn(py, [script], {
      detached: true, stdio: 'ignore', windowsHide: true,
      env: Object.assign({}, process.env, { PYTHONPATH: libs, PYTHONIOENCODING: 'utf-8' })
    });
    if (child && typeof child.unref === 'function') child.unref();
    try { fs.writeFileSync(pidFile, String(child.pid), 'utf8'); } catch { /* 忽略 */ }
    log('[friend-gate] WS 监听器已拉起 pid=' + (child && child.pid));
  } catch (e) { log('[friend-gate] 拉 WS 监听器失败：' + (e && e.message)); }
}

/** 判定机主说了"同意"还是"拒绝"。
 *  ⚠️ 两轮外部审查抓到的问题（都已修）：
 *   ① 「不同意」曾因 approveWords 含「同意」而被判成同意 → 改为**取最长匹配**，同长拒绝优先；
 *   ② 普通否定句（不通过 / 没通过 / 别同意 / 不能加他）仍会命中「通过/同意/加他」→ 再加一层
 *      **否定前缀判定**：命中词前面 3 个字内出现否定词（不/没/别/甭/勿/非/无/拒/免/不用/不要）就翻转成拒绝。
 */
function judgeOwnerSay(s, text) {
  const words = (str, type) => String(str || '').split(/[,，]/).map((x) => x.trim()).filter(Boolean).map((w) => ({ w, type }));
  const all = words(s.approveWords, 'yes').concat(words(s.rejectWords, 'no'));
  const NEG = /(不|没|别|甭|勿|非|无|拒|免|莫|休想|拒绝|不用|不要)/;
  let best = null;
  for (const it of all) {
    if (!it.w || !text.includes(it.w)) continue;
    let type = it.type;
    // 否定前缀：命中词出现的位置往前看 1~3 个字，有否定词就翻转
    const at = text.indexOf(it.w);
    const before = text.slice(Math.max(0, at - 3), at);
    if (type === 'yes' && NEG.test(before)) type = 'no';
    else if (type === 'no' && NEG.test(before)) type = 'no';   // 已经是拒绝，保持
    const cand = { w: it.w, type };
    if (!best || cand.w.length > best.w.length) best = cand;
    else if (cand.w.length === best.w.length && cand.type === 'no') best = cand;
  }
  if (!best) return { yes: false, no: false, word: '' };
  return { yes: best.type === 'yes', no: best.type === 'no', word: best.w };
}

/** 从机主的话里挑出他指的是哪一条申请（多条并存时不能瞎选第一条）。
 *  返回 { item, ambiguous }：说了 QQ 号就按号找；只说了"同意"而待处理不止一条 → ambiguous，让上层别乱动。 */
function pickTarget(list, text) {
  const ids = String(text).match(/\d{5,12}/g) || [];
  for (const n of ids) {
    const hit = list.find((x) => String(x.userId || '') === n);
    if (hit) return { item: hit, ambiguous: false };
  }
  if (list.length === 1) return { item: list[0], ambiguous: false };
  return { item: null, ambiguous: true };
}

export function setup(injected) {
  api = injected || {};
  log = (api && api.log) || (() => {});
  dataDirNow = '';
  log('[friend-gate] 好友申请管家已就绪');
  if (settings().enabled !== false) { ensureWatcher(); if (settings().enableWsWatch === true) ensureWsWatch(); }

  const reg = (spec) => { try { api.registerTool(spec); } catch (e) { log('[friend-gate] 注册工具失败：' + (e && e.message)); } };

  // ── 工具 1：看有哪些待处理 ──────────────────────────────────────────
  reg({
    id: 'friend_pending',
    name: '看好友申请',
    description: '列出还没处理的好友申请/入群邀请（含对方 QQ、验证消息）。机主问"谁要加我""还有谁申请"时用它。',
    parameters: { type: 'object', properties: {} },
    async execute(...args) {
      const list = loadPending();
      if (!list.length) return '现在没有待处理的好友申请。';
      return '待处理 ' + list.length + ' 条：\n' + list.map((x, i) => `${i + 1}. ${describe(x)}`).join('\n')
        + '\n（机主说"同意/拒绝"就用 friend_decide 处理）';
    }
  });

  // ── 工具 2：同意/拒绝（真去调 OneBot）────────────────────────────────
  reg({
    id: 'friend_decide',
    name: '同意或拒绝好友申请',
    description: '按机主的意思同意/拒绝一个好友申请（或入群邀请）。机主说"同意/通过"就 action=approve，说"拒绝/别加"就 action=reject。**只有机主能调**。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'approve=同意，reject=拒绝' },
        userId: { type: 'string', description: '对方 QQ 号（好友申请用）' },
        groupId: { type: 'string', description: '群号（入群邀请用）' },
        remark: { type: 'string', description: '可选：同意时给对方的备注' }
      },
      required: ['action']
    },
    async execute(...args) {
      const ctx = args.find((a) => a && (a.onebot || a.chatId != null)) || {};
      const params = args.find((a) => a && typeof a === 'object' && (a.action || a.userId || a.groupId)) || {};
      const s = settings();
      if (s.ownerOnly !== false && !isOwner(ctx)) {
        return '只有机主能决定加不加好友哦。';
      }
      // ⚠️ 实测：**插件注册的工具里拿不到 ctx.onebot**（跟技能不一样），所以这里统一改走
      //    插件自己的 HTTP 通道（onebotPost）—— 跟盯梢同一套，可靠。
      const ob = onebotOf(...args);      // 能拿到就用（便宜），拿不到也不拦
      const act = String(params.action || '').toLowerCase();
      // 动作解析（自我审查加强）：只认明确的 approve / reject，含糊的**不再默认当同意**
      let approve;
      if (/^(approve|yes|ok|true|同意|通过|批准)/.test(act)) approve = true;
      else if (/^(reject|no|false|拒绝|不同意|别加)/.test(act)) approve = false;
      else return `action 只能是 approve（同意）或 reject（拒绝），你给的是「${act}」——重新调一次。`;
      const list = loadPending();
      // 找对应那条（按 QQ 或群号；**没指明且不止一条时不猜** —— 自我审查发现原来会默认取第 0 条，可能点错人）
      let idx = -1;
      if (params.userId) idx = list.findIndex((x) => String(x.userId || '') === String(params.userId));
      if (idx < 0 && params.groupId) idx = list.findIndex((x) => String(x.groupId || '') === String(params.groupId));
      if (idx < 0) {
        if (list.length === 1) idx = 0;
        else if (list.length > 1) return '待处理里有 ' + list.length + ' 条申请，你得告诉我处理哪一条（把 QQ 号给我）：' + list.map((x) => String(x.userId || x.groupId)).join('、');
      }
      const it = list[idx];
      if (!it) return '没有待处理的申请，无从下手。';
      if (!it.flag) return '这条申请没记到 flag（没法调接口），让机主自己去 QQ 里点一下。';
      try {
        let rr;
        if (it.type === 'group') {
          rr = ob ? await ob.call('set_group_add_request', { flag: it.flag, sub_type: 'invite', approve }, 20000)
                  : await onebotPost('set_group_add_request', { flag: it.flag, sub_type: 'invite', approve });
        } else {
          const p = { flag: it.flag, approve };
          if (approve && params.remark) p.remark = String(params.remark);
          rr = ob ? await ob.call('set_friend_add_request', p, 20000) : await onebotPost('set_friend_add_request', p);
        }
        if (rr && rr.ok === false) throw new Error(JSON.stringify(rr.body || rr.err || rr).slice(0, 160));
        list.splice(idx, 1);
        savePending(list);
        // 同意之后**顺手加进聊天白名单**，否则机器人不会理他（机主实测：白名单里没名字 = 加了也白加）
        let wlNote = '';
        if (s.autoWhitelist !== false) {
          const okWl = await addToWhitelist(it.type === 'group' ? 'group' : 'private', it.type === 'group' ? (it.groupId || '') : (it.userId || ''));
          wlNote = okWl
            ? '\n（已经把他加进聊天白名单了 —— 这样我才会搭理他）'
            : '\n（加白名单没成功，可能要你在控制台里手动加一下）';
        }
        log(`[friend-gate] 已${approve ? '同意' : '拒绝'}：${describe(it)}`);
        return (approve ? '已经点同意了 ✅' : '已经点拒绝了 ✅') + '：' + describe(it) + wlNote
          + (approve ? '\n（要给他指定人设就说「给他用 XX 人设」，我来切）' : '');
      } catch (e) {
        return '调接口失败了：' + ((e && e.message) || '未知错误') + '\n（可能对方已撤回申请，或者这版协议不支持）';
      }
    }
  });

  // ── 工具 3：给某个人/某个群指定人设 ─────────────────────────────────
  reg({
    id: 'persona_for',
    name: '给指定的人/群换人设',
    description: '给**某一个 QQ 或某个群**单独指定人设（只影响那个会话，不动全局人设）。机主说"给他用小鲸鱼人设""把这个人换成 XX 人设"时用它。',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: '对方 QQ 号（私聊人设）' },
        groupId: { type: 'string', description: '群号（群人设）' },
        personaKey: { type: 'string', description: '人设标识（如 xiaojingyu；不确定就留空）' },
        text: { type: 'string', description: '可选：直接给一段人设文本（比 personaKey 更明确）' },
        note: { type: 'string', description: '可选：一句话备注，比如"这是群里的XX"' }
      }
    },
    async execute(...args) {
      const ctx = args.find((a) => a && (a.onebot || a.chatId != null)) || {};
      const params = args.find((a) => a && typeof a === 'object' && (a.userId || a.groupId)) || {};
      const s = settings();
      if (s.ownerOnly !== false && !isOwner(ctx)) return '只有机主能改人设。';
      const key = String(params.userId || params.groupId || '');
      if (!key) return '要指定给谁——给我个 QQ 号或群号。';
      if (!params.personaKey && !params.text) return '要换成什么人设？说清楚（或给我一段人设文本）。';
      // 限制（外部审查提醒 + 机主铁律）：
      //  · 人设文本限长，避免被塞进超长提示词把上下文顶爆；
      //  · **绝不改动 customRules**（那 6 条是机主的硬要求，谁也改不了）。
      const roleText = params.text ? String(params.text) : '';
      if (roleText.length > 6000) return '这段人设太长了（超过 6000 字），截短一点再说。';
      if (params.customRules) return 'customRules（机主那 6 条铁律）不允许通过这里改，只能机主在控制台手动改。';
      try {
        const p = path.join(dataDir(), 'config.json');
        const c = JSON.parse(fs.readFileSync(p, 'utf8'));
        c.persona = c.persona || {};
        c.persona.overrides = c.persona.overrides || {};
        const patch = {};
        if (params.personaKey) patch.personaKey = String(params.personaKey);
        if (roleText) patch.roleText = roleText;
        if (params.note) patch.note = String(params.note);
        c.persona.overrides[key] = Object.assign({}, c.persona.overrides[key] || {}, patch);
        fs.writeFileSync(p, JSON.stringify(c, null, 2), 'utf8');
        log(`[friend-gate] 已给 ${key} 指定人设：${JSON.stringify(patch)}`);
        return `已经给 ${key} 单独设好这个人设了 ✅（只影响他，别人不变）\n⚠️ 这一步可能要**重启一次程序**才生效（核心读配置的时机），我这边会顺手重载一次。`;
      } catch (e) {
        return '改配置失败了：' + ((e && e.message) || '未知错误');
      }
    }
  });
}

export const hooks = {
  /** 机主一句话就**由插件自己点同意/拒绝**（不再指望模型调工具 —— 它两次都只嘴上说）。 */
  async 'before-context'(ctx = {}) {
    try {
      const s = settings();
      if (s.enabled === false) return;
      if (!isOwner(ctx)) return;
      const list = loadPending();
      if (!list.length) return;
      const text = (Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries.map((e) => (e && e.text) || '').join(' ') : '')
        + ' ' + String(ctx.text || '');
      const j = judgeOwnerSay(s, text);
      const yes = j.yes, no = j.no;   // 取最长匹配 + 否定前缀翻转
      if (!yes && !no) return;
      // 多条申请并存时**按 QQ 号选对人**；只说了"同意"而待处理不止一条 → 不乱动，交给模型去问
      const picked = pickTarget(list, text);
      if (!picked.item) {
        setResult(ctx, '⚠️ 待处理里有 ' + list.length + ' 条申请，我不知道你说的是哪一个 —— **先问机主是哪一条（给他列 QQ 号）**，别自己挑。');
        log('[friend-gate] 多条申请且没指明 QQ → 不乱动');
        return;
      }
      const it = picked.item;
      if (!it || !it.flag) {
        setResult(ctx, '⚠️ 这条申请没记到能用的 flag，得你自己去 QQ「新朋友」里点一下。');
        return;
      }
      log(`[friend-gate] 机主${yes ? '同意' : '拒绝'} → 插件自己点：${describe(it)}`);
      const r = it.type === 'group'
        ? await onebotPost('set_group_add_request', { flag: it.flag, sub_type: 'invite', approve: yes })
        : await onebotPost('set_friend_add_request', { flag: it.flag, approve: yes });
      const rest = loadPending().filter((x) => String(x.flag || '') !== String(it.flag));
      savePending(rest);
      let extra = '';
      if (yes && r.ok) {
        const wlOk = await addToWhitelist(it.type === 'group' ? 'group' : 'private', it.type === 'group' ? (it.groupId || '') : (it.userId || ''));
        extra = wlOk ? '，并且加进聊天白名单了' : '（白名单没加上，要手动加）';
      }
      const verdict = r.ok
        ? `✅ 已${yes ? '同意' : '拒绝'}：${describe(it)}${extra}`
        : `❌ 点失败了（flag 可能不对）：${JSON.stringify(r.body || r.err).slice(0, 160)}`;
      setResult(ctx, verdict);
      log('[friend-gate] 结果：' + verdict);
    } catch (e) { log('[friend-gate] before-context 出错：' + (e && e.message)); }
  },

  /** 机主的私聊里塞一句待处理提示（别人不塞）。 */
  async 'before-llm-messages'(ctx = {}) {
    try {
      const s = settings();
      if (s.enabled === false) return;
      if (!isOwner(ctx)) return;
      const resultNow = takeResult(ctx);
      const list = loadPending();
      if (!list.length && !resultNow) return;
      // 决定性一刀：机主刚说了"同意/拒绝" → 直接下死命令，不许模型只嘴上说"同意了"（实测它真干过）
      let wordNote = '';
      try {
        const s2 = settings();
        const text = (Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries.map((e) => (e && e.text) || '').join(' ') : '')
          + ' ' + String(ctx.text || '');
        const j2 = judgeOwnerSay(s2, text);
        const yes = j2.yes, no = j2.no;
        if (yes || no) {
          wordNote = `\n\n⚠️ **机主刚刚${yes ? '说要同意' : '说要拒绝'}了** —— 你**必须立刻调用工具** `
            + `friend_decide（action=${yes ? 'approve' : 'reject'}），把上面第 1 条那个申请处理掉。`
            + `**绝对不许只在嘴上说"同意了/点好了"而不调工具**（你之前这么干过，机主在 QQ 里看到申请还挂在那儿）。`
            + `调完把工具的返回原样告诉机主（里面会写成功还是失败）。`;
        }
      } catch (e) { /* 忽略 */ }
      const msgs = ctx.messages;
      if (!Array.isArray(msgs)) return;
      const note = '\n\n【内部提示·好友申请】现在有 ' + list.length + ' 条待处理：\n'
        + list.map((x, i) => `${i + 1}. ${describe(x)}`).join('\n')
        + '\n机主说"同意/拒绝"你就调 friend_decide（action=approve/reject）；说"给他用 XX 人设"就调 persona_for。'
        + '机主没表态就别自作主张。' + wordNote
        + (resultNow ? ('\n\n✅ **这件事我已经替你办好了，别再去调工具**：' + resultNow + '\n你只要**原样转达这句话**给机主（可以稍微口语化），不要添油加醋、不要说你"点过了"。') : '');
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m && m.role === 'user' && typeof m.content === 'string') { m.content += note; return; }
      }
    } catch (e) { log('[friend-gate] 注入失败（已忽略）：' + (e && e.message)); }
  },

  /** 非机主调这三个工具 → 一律拦住（模型绕不过工具）。 */
  async 'before-tool'(ctx = {}) {
    try {
      const s = settings();
      if (s.enabled === false || s.ownerOnly === false) return undefined;
      const tool = String(ctx.toolName || ctx.name || ctx.tool || ctx.id || (ctx.call && ctx.call.name) || '');
      if (!/(friend_pending|friend_decide|persona_for)$/.test(tool)) return undefined;
      if (isOwner(ctx)) return undefined;
      return { block: true, reason: '这事只有机主能定，别人的话不算。' };
    } catch { return undefined; }
  }
};  /** 把清单里新增、而配置里还没有的设置键补进去（否则控制台看不到这些框）。
   *  只在真有缺的键时才发请求；失败静默（控制台没开也不影响功能）。 */
  let _settingsSynced = false;
  async function ensureSettingsVisible() {
    if (_settingsSynced) return;
    try {
      const s = settings();
      const want = { onebotHttp: '', onebotToken: '', owners: '', notifyQq: '', consoleApi: 'http://127.0.0.1:3210' };
      const missing = Object.keys(want).filter((k) => s[k] === undefined);
      if (!missing.length) { _settingsSynced = true; return; }
      const api = String(s.consoleApi || 'http://127.0.0.1:3210').replace(/\/+$/, '');
      const patch = {}; missing.forEach((k) => { patch[k] = want[k]; });
      await fetch(api + '/api/skills/friend-gate', {
        method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ settings: patch })
      });
      log('[friend-gate] 已把缺的设置项补进配置：' + missing.join(', '));
      _settingsSynced = true;
    } catch { /* 控制台没开就算了 */ }
  }

export function activate() {
  if (settings().enabled === false) { log('[friend-gate] 总开关关闭，不启动盯梢'); return; }
  ensureWatcher();
  if (settings().enableWsWatch === true) ensureWsWatch();
}
