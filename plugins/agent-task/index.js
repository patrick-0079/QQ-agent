// AI 任务 —— 在 QQ 里用大白话给本机的 AI agent（CLI 型）布置任务
//
// ── 它干什么 ──────────────────────────────────────────────────────────
// 群里/私聊发「\任务 帮我看看 E:\xxx 的日志有没有报错」，机器人把**整句话**交给
// 某个 CLI agent 执行，完成后把它的最终回答发回原会话。
//
// ── 为什么要支持"多后端"（2026-09-30 用户提的）────────────────────────────
// 初版叫 dsh-task、只认 DSH。用户问得对："如果能用多个 agent 的话真的要叫 dsh 任务吗"
// —— 指令 `\任务` 本来就是中性的，插件名/后端却绑死了 DSH。现在改成：
//   · 插件 id `agent-task`、显示名「AI 任务」、指令只剩 `\任务`（去掉 `\dsh` 别名）；
//   · 后端由设置项 `backends` **声明**（每行「名字=命令模板」），默认只给 DSH 一行；
//   · 默认走 `defaultBackend`；想指定就发「\任务 -名字 你的任务」。
// 加一个新 agent 只需要在设置里加一行，不用改代码。
//
// ── ⚠️ 这是本仓库里权限最大的插件，安全设计必须对齐 L3 ────────────────────
// DSH 的 headless profile 装载的是一个**完整的 coding agent**（tool-bash /
// tool-fs / skill-filesystem 等），能在本机**任意读写文件、执行命令**；
// 其它 CLI agent 基本也是同一性质。「口头布置任务」= 「用自然语言遥控电脑」，
// 所以设了三道闸：
//   ① 插件默认**关闭**（enabledByDefault: false）；
//   ② 只认主人（ownerIds 或「主人识别」能力）+ 主人私聊 / 显式允许的群；
//   ③ 第二道锁 armed（默认关）：发「\任务 解锁」后按窗口/次数自动上锁。
// 另加：每小时次数上限、单任务超时、全局单并发（同一时间只跑一个 agent）。
//
// ── 为什么走「指令直达」─────────────────────────────────────────────────
// 与 pc-control-l3 / netease-song-id 同一套路：manifest 里 commandOnly + commandRoute，
// 命中 \任务 由系统直接执行，0 token、不经过模型。这里尤其重要 ——
// 不能让模型"看到"这个工具后自己决定去调它（那等于把遥控权交给模型）。
// 工具内还会校验 __agentTask 来源标记，模型即使想办法调到也会被拒。
//
// ── 为什么要异步 + 主动回传（而不是把结果当返回值）──────────────────────
// 直达链路是 `await executeTool(...)` 然后才结束会话 —— 而 agent 跑一个任务
// 可能几十秒到十几分钟。如果在这里 await，QQ 侧会一直挂着、还会撞会话超时。
// 所以：工具**立刻**返回一句「已受理」，真正的执行走 spawn，
// 跑完后用捕获到的 sender 主动把结果发回原会话（与 L3 的钩子路径同一手法）。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// ── 框架依赖一律「动态 + 容错」导入（分发友好）───────────────────────────
// 插件要发给别人，而别人的 QQ-agent 未必有本项目这些模块（src/skills/config.js
// 是后加的；老框架可能只有 src/config.js）。**静态 import 一旦找不到就是整个插件
// 加载失败** —— 表现成"插件装了但完全不出现"，最难排查。
// 动态 import + try/catch 后，缺什么只让对应能力降级，插件本体照旧加载。
let setSkillConfigFn = null;   // 写插件设置（armed 等）
let getConfigFn = null;        // 读整份运行时配置（判断直达是否可用）
try {
  const m = await import('../../src/skills/config.js');
  setSkillConfigFn = typeof m.setSkillConfig === 'function' ? m.setSkillConfig : null;
} catch { /* 老框架没有这个模块：armed 只存在内存里，功能不受影响 */ }
try {
  const m = await import('../../src/config.js');
  getConfigFn = typeof m.getConfig === 'function' ? m.getConfig : null;
} catch { /* 连 config 模块都没有：更老的框架，兜底判据会按"直达不可用"处理 */ }

/** 写插件设置；框架没这个能力时退化成"只改内存"（本次进程内有效）。 */
function setSkillConfig(id, patch) {
  if (setSkillConfigFn) {
    try { setSkillConfigFn(id, patch); return; } catch { /* 落到内存兜底 */ }
  }
  memCfg = { ...memCfg, ...(patch || {}) };
}
let memCfg = {};               // 没有配置落盘能力时的内存副本

/** 读整份运行时配置（老框架没有就返回 null）。 */
function getConfig() {
  try { return getConfigFn ? getConfigFn() : null; } catch { return null; }
}

const PLUGIN_ID = 'agent-task';
const COMMAND = '任务';

/**
 * 设置项里展示的模板（**不写真实路径**）。
 *
 * ⚠️ 为什么不能把某个绝对路径写进默认值（2026-09-30 用户指出）：
 *    插件是要**分发给别人**的 —— 作者机器上的绝对路径在别人那里既不对，
 *    又暴露了作者的环境。默认 `backends` 一律留空，由 guessDshBin() 在运行时
 *    按常见位置猜（见下），猜不到就让用户自己填。
 */
const BACKENDS_HINT = [
  '# 每行一个：名字=命令模板（也可以用分号分隔写在同一行）；{task} 会被替换成任务（整句作为一个参数）',
  '# 命令第一个词是 node 时会自动换成可用的 node 绝对路径',
  '# 例（把路径换成你自己的 DSH 安装位置）：',
  '#   dsh=node D:/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --profile headless {task}',
  '#   cc=claude -p {task}'
].join('\n');

/**
 * 猜 DSH 的安装位置（**分发友好**：不写死作者机器的路径）。
 * 只查"常见位置"，命中就用作默认后端；命中不了就返回空串，让用户去设置里填。
 */
function guessDshBin() {
  const rel = path.join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const cands = [];
  for (const d of ['C', 'D', 'E', 'F', 'G', 'H']) cands.push(`${d}:/dsh/${rel.replace(/\\/g, '/')}`);
  if (home) {
    cands.push(path.join(home, 'dsh', rel));
    cands.push(path.join(home, '.dsh', rel));
    cands.push(path.join(home, 'AppData', 'Roaming', 'npm', rel));
  }
  cands.push('/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js');
  cands.push('/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js');
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch { /* 单个候选读不到就跳过 */ }
  }
  return '';
}

/** 指令里可用的子命令（其余内容一律当作任务正文）。 */
const SUB = {
  help: ['帮助', 'help', '?'],
  unlock: ['解锁', 'unlock'],
  lock: ['上锁', '锁定', 'lock'],
  status: ['状态', 'status'],
  backends: ['后端', 'backends', '列表']
};

let cfg = () => ({});
let log = () => {};
let apiRef = null;
let armedTimer = null;
let runningChild = null;      // 当前正在跑的 agent 进程（全局单并发）
let runningName = '';         // 当前在跑的后端名（状态展示用）
const runTimes = [];          // 限频滑动窗口（毫秒时间戳）

// ── 主人判定（与 pc-control-l3 同源）────────────────────────────────────
function makeOwnerChecker() {
  const explicit = String(cfg().ownerIds || '').split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean);
  if (explicit.length) return (uid) => explicit.includes(String(uid));
  const cap = apiRef?.capability;
  if (typeof cap !== 'function') return null;
  return (uid) => {
    let r;
    try { r = cap('message.owner-check', { userId: Number(uid) || uid }); } catch { return false; }
    return !!r && typeof r.then !== 'function' && r.isOwner === true;
  };
}

// ── 触发批里"哪一条是本次指令" ──────────────────────────────────────────
/** 只认 `\任务`（`/`、`／`、`＼` 也算；`\dsh` 别名已随改名去掉）。 */
const CMD_RE = /[\\/\uFF0F\uFF3C]\s*\u4EFB\u52A1/i;

/** 批内**非自己**的消息（按到达顺序）。 */
function foreignEntries(ctx) {
  const entries = ctx?.session?.trigger || ctx?.session?.triggerEntries || [];
  return (Array.isArray(entries) ? entries : []).filter((m) => m && !m.self);
}

/** 批内最后一条非自己的消息（兜底用）。 */
function lastForeignEntry(ctx) {
  return foreignEntries(ctx).slice(-1)[0] || null;
}

/**
 * 批内**带 `\任务` 指令**的那条消息 —— 从后往前找第一条命中的。
 *
 * ⚠️ 为什么不能直接用"最后一条"（2026-10-01 实测）：
 *    真实群聊里一批消息常常是「\任务 xxx」+ 之后别人插话 + 自己又回一句。
 *    只取最后一条 → 正文取不到 → `!body` → 回**帮助**（用户明明下了任务指令）；
 *    主人判定也会拿错人的 QQ → 直接静默忽略。
 */
function commandEntryFrom(ctx) {
  const list = foreignEntries(ctx);
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (CMD_RE.test(String(list[i]?.text || ''))) return list[i];
  }
  return null;
}

/**
 * 取本次触发者的 QQ 号。
 *
 * ⚠️ 不能从 chatKey 拆（2026-09-30 自查发现的坑）：
 *    `chatKey` 是 `private:<对方QQ>` / `group:<群号>` —— 群聊时冒号后面是
 *    **群号**，拿它当主人 QQ 判，等于"群里任何人的号都被当成群号去比对"，
 *    要么全员通过要么全员拒绝。直达链路的 ctx 里也**没有** senderId 字段。
 *    正确来源是「**带指令的那条消息**」的 senderId —— 与 fullBodyFrom 同源。
 *
 * ⚠️ 为什么不能取"批内最后一条"（2026-10-01 实测的坑）：
 *    一批里 `\任务` 之后还会有别的消息（别人插话、自己又补一句）。
 *    取最后一条会有两个后果：①正文取不到 → 回"帮助"（用户明明下了指令）；
 *    ②主人判定用了**别人**的 QQ → 静默忽略，连提示都没有。
 */
function senderIdFrom(ctx) {
  const src = commandEntryFrom(ctx) || lastForeignEntry(ctx);
  const fromTrigger = String(src?.senderId ?? src?.userId ?? '').trim();
  if (fromTrigger) return fromTrigger;
  const chatKey = String(ctx?.chatKey || '');
  return chatKey.startsWith('private:') ? String(chatKey.split(':')[1] || '') : '';
}

/** 允许的会话：主人的私聊永久允许；群必须在 extraChatIds 里。 */
function isAllowedChat(ctx) {
  const kind = String(ctx?.kind || '');
  if (kind === 'private') return true;                     // 私聊已由主人判定把关
  if (kind !== 'group') return false;
  const allow = String(cfg().extraChatIds || '').split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean);
  if (!allow.length) return false;
  return allow.includes(String(ctx?.chatId || ''));
}

// ── 审计（独立文件，与 L3 同规格）───────────────────────────────────────
// ⚠️ 改名（dsh-task → agent-task）时审计文件名也跟着换：旧文件 data/dsh-task-audit.log
//    刻意**不迁移也不删除** —— 它是历史事实，删了就查不到"改名之前谁布置过什么"。
function auditFile() {
  const base = process.env.QQ_AGENT_DATA_DIR || path.resolve('data');
  return path.join(base, 'agent-task-audit.log');
}
function audit(action, detail) {
  try {
    const f = auditFile();
    try {
      if (fs.existsSync(f) && fs.statSync(f).size > 2 * 1048576) fs.renameSync(f, f.replace(/\.log$/, '.old'));
    } catch { /* 轮转失败不影响执行 */ }
    fs.appendFileSync(f, `${new Date().toISOString()} ${action} => ${String(detail).slice(0, 600)}\n`, 'utf8');
  } catch { /* 审计失败绝不影响执行 */ }
}

// ── 设置 ────────────────────────────────────────────────────────────────
function num(v, dflt, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}
function readSettings() {
  const c = cfg() || {};
  return {
    armed: c.armed === true,
    lockMode: ['off', 'window', 'custom'].includes(c.lockMode) ? c.lockMode : 'window',
    armedTTL: num(c.armedTTL, 300, 0, 86400),
    maxRuns: num(c.maxRuns, 0, 0, 1000),
    armedAt: Number(c.armedAt) || 0,
    armedRuns: num(c.armedRuns, 0, 0, 100000),
    maxPerHour: num(c.maxPerHour, 10, 1, 500),
    timeoutSec: num(c.timeoutSec, 600, 10, 7200),
    workDir: String(c.workDir || '').trim(),
    nodePath: String(c.nodePath || '').trim(),
    maxReplyChars: num(c.maxReplyChars, 1500, 100, 20000),
    maxReplyParts: num(c.maxReplyParts, 6, 1, 20),
    announceOnStart: c.announceOnStart !== false,
    // ── 进度回传（默认开，但**刻意压得很省**）──
    progress: c.progress !== false,
    progressMax: num(c.progressMax, 3, 0, 10),        // 一个任务最多发几条（0 = 不发）
    progressGapSec: num(c.progressGapSec, 25, 5, 600), // 两条之间至少隔多久
    progressAfterSec: num(c.progressAfterSec, 20, 0, 600) // 跑够这么久才开始报（快任务完全不打扰）
  };
}

// ── 进度回传 ────────────────────────────────────────────────────────────
//
// 为什么**不改命令行参数**去要进度（2026-10-01）：
//   `--output-format stream-json` 能拿到实时事件，但那样**结果也得从流里解析** ——
//   本机没外网，我无法实测它的事件结构，猜错了就会让"本来能正常出结果的任务"变成空输出。
//   结果通道是已经跑通的功能，不拿它冒险。
//
// 改用**只读旁路**：codebuddy 无论哪种输出格式都会把过程写进
//   ~/.codebuddy/projects/<目录>/<sessionId>.jsonl
// （已实测：无头 `-p` 任务也会写，里面有 `function_call` 条目，如 PowerShell / Glob / Read）。
//   我们**只读**这个文件、按行增量解析；读不到就一条进度都不发 —— 优雅降级，绝不影响结果。
const PROJECTS_DIR = path.join(process.env.USERPROFILE || process.env.HOME || '', '.codebuddy', 'projects');

/** 把一条 function_call 压成人话（短、可读、不贴长命令）。 */
function progressLabel(entry) {
  const name = String(entry?.name || '').trim() || '工具';
  let args = {};
  try { args = JSON.parse(String(entry?.arguments || '{}')); } catch { args = {}; }
  const s = (v) => String(v || '').trim().replace(/\s+/g, ' ');
  const short = (v, n = 48) => { const t = s(v); return t.length > n ? t.slice(0, n) + '…' : t; };
  if (name === 'PowerShell' || name === 'Bash') return `执行命令：${short(args.command)}`;
  if (name === 'Glob') return `搜索文件 ${short(args.pattern || args.path, 40)}`;
  if (name === 'Grep') return `搜索内容 ${short(args.pattern, 40)}`;
  if (name === 'Read') return `读文件 ${short(args.file_path || args.path, 40)}`;
  if (name === 'Write') return `写文件 ${short(args.file_path || args.path, 40)}`;
  if (name === 'Edit') return `改文件 ${short(args.file_path || args.path, 40)}`;
  if (name === 'WebFetch' || name === 'WebSearch') return `查网上资料：${short(args.url || args.query, 40)}`;
  return `用工具：${name}`;
}

/**
 * codebuddy 把某个工作目录的会话记在 `projects/<slug>/` 下。
 * 举例：`<你的工作目录>`（形如 `<用户主目录>\WorkBuddy`）
 * ⚠️ 别写成带盘符和 `Users` 的样子 —— 出包自检的「本机绝对路径」规则会命中它
 *    （2026-10-03 又踩一次：占位符本身长得像真实路径，照样算残留）。
 *   会落成 `c-Users-<用户名>-WorkBuddy`（盘符小写、冒号与分隔符都换成 `-`）。
 */
function slugForCwd(cwd) {
  return String(cwd || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .replace(/^([A-Za-z]):\//, (m, c) => `${c.toLowerCase()}-`)
    .replace(/\//g, '-');
}

/**
 * 找一个"本次任务在写"的会话记录文件。
 * 判据：mtime 晚于任务开始时间 —— 不猜 sessionId，也就不会被 CLI 改文件名/改目录打挂。
 *
 * ⚠️ 必须**先按 workDir 收敛到它自己的项目目录**（2026-10-01，ZCode 审查指出，已修）：
 *    原来是在 `~/.codebuddy/projects` 下"挑 mtime 最新的 .jsonl" ——
 *    主人自己开着 codebuddy 敲命令时，那个会话同样在写文件且可能更"新"，
 *    于是**手动会话的动作会被当成任务进度报进 QQ 群**（串台）。
 *    现在只在工作目录对应的目录里找；该目录不存在时才退回全盘扫（并记一条日志）。
 */
function findActiveTranscript(startedAt, workDir = '') {
  try {
    if (!fs.existsSync(PROJECTS_DIR)) return null;
    const slug = slugForCwd(workDir);
    const scoped = slug ? path.join(PROJECTS_DIR, slug) : '';
    const dirs = [];
    if (scoped && fs.existsSync(scoped)) dirs.push(scoped);
    else {
      if (scoped) log(`[AI 任务] 进度：未找到工作目录对应的记录目录 ${slug}，退回全盘查找（可能串台）`);
      for (const d0 of fs.readdirSync(PROJECTS_DIR)) dirs.push(path.join(PROJECTS_DIR, d0));
    }
    let best = null;
    for (const dir of dirs) {
      const d = dir;
      let st;
      try { st = fs.statSync(d); } catch { continue; }
      if (!st.isDirectory()) continue;
      for (const f of fs.readdirSync(d)) {
        if (!f.endsWith('.jsonl')) continue;
        const p = path.join(d, f);
        try {
          const s2 = fs.statSync(p);
          if (s2.mtimeMs >= startedAt - 1000 && (!best || s2.mtimeMs > best.mtimeMs)) {
            best = { file: p, mtimeMs: s2.mtimeMs, size: s2.size };
          }
        } catch { /* 单个文件读不到就跳过 */ }
      }
    }
    return best;
  } catch { return null; }
}

/**
 * 起一个只读的进度哨兵。onLabel(label) 会被**已经节流过**地回调。
 * 返回 stop() —— 任务结束必须调，否则定时器泄漏。
 */
function startProgressWatcher({ startedAt, s, onLabel }) {
  let timer = null;
  let current = null;      // 当前盯的文件
  let offset = 0;          // 已读字节
  let sent = 0;            // 已发条数
  let lastAt = 0;          // 上次发送时刻
  const seen = new Set();  // 已报过的 label（同一动作不重复报）
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } };

  if (!s.progress || s.progressMax <= 0) return { stop };

  timer = setInterval(() => {
    try {
      if (sent >= s.progressMax) { stop(); return; }
      const now = Date.now();
      // ① 快任务不打扰：没跑够 progressAfterSec 就一条都不发
      if (now - startedAt < s.progressAfterSec * 1000) return;
      // ② 两条之间至少隔 progressGapSec
      if (lastAt && now - lastAt < s.progressGapSec * 1000) return;

      if (!current) {
        const found = findActiveTranscript(startedAt, s.workDir);
        if (!found) return;                 // 还没开始写 / 找不到 → 下次再看
        current = found;
        offset = 0;
      }
      let size = 0;
      try { size = fs.statSync(current.file).size; } catch { return; }
      if (size <= offset) return;
      const buf = fs.readFileSync(current.file, 'utf8');
      offset = Buffer.byteLength(buf, 'utf8');
      const lines = buf.split('\n');
      // 只看**最后几条**：早期步骤早就过去了，报出来没意义
      for (const line of lines.slice(-12)) {
        if (!line.trim()) continue;
        let o = null;
        try { o = JSON.parse(line); } catch { continue; }
        if (o?.type !== 'function_call') continue;
        const label = progressLabel(o);
        if (seen.has(label)) continue;
        seen.add(label);
        sent += 1;
        lastAt = now;
        try { onLabel(label); } catch { /* 回调抛错不能影响任务 */ }
        return;                              // 一轮只报一条，绝不刷屏
      }
    } catch { /* 哨兵任何异常都吞掉 —— 它只是锦上添花 */ }
  }, 3000);
  try { timer.unref?.(); } catch { /* ignore */ }
  return { stop };
}

// ── armed（上锁/解锁：与 L3 同一套语义，用户已熟悉）─────────────────────
function patchArmed(patch) {
  try { setSkillConfig(PLUGIN_ID, patch); }
  catch (e) { log('写入 armed 状态失败：' + (e?.message ?? e)); }
}
function lockNow(why) {
  patchArmed({ armed: false, armedAt: 0, armedRuns: 0 });
  log(`[自动上锁] ${why}`);
}
/** 授权判定：{ ok:true, remainMs } 或 { ok:false, why }。 */
function armedWindow() {
  const s = readSettings();
  if (!s.armed) return { ok: false, why: 'locked' };
  if (s.lockMode === 'off') return { ok: true, remainMs: Infinity };
  if (!s.armedAt) {                                        // 刚解锁：起表 + 计数清零
    patchArmed({ armedAt: Date.now(), armedRuns: 0 });
    return { ok: true, remainMs: s.armedTTL * 1000 };
  }
  if (s.lockMode === 'custom' && s.maxRuns > 0 && s.armedRuns >= s.maxRuns) {
    lockNow(`自定义模式次数已用完（${s.maxRuns} 次）`);
    return { ok: false, why: `本次解锁的任务次数已用完（最多 ${s.maxRuns} 个），已自动上锁。` };
  }
  if (s.armedTTL > 0) {
    const elapsed = Date.now() - s.armedAt;
    if (elapsed >= s.armedTTL * 1000) {
      lockNow(`解锁窗口已过（${s.armedTTL} 秒）`);
      return { ok: false, why: `解锁窗口已过（${s.armedTTL} 秒），已自动上锁。请重新发「\\${COMMAND} 解锁」。` };
    }
    return { ok: true, remainMs: s.armedTTL * 1000 - elapsed };
  }
  return { ok: true, remainMs: Infinity };
}
function startArmedWatch() {
  stopArmedWatch();
  armedTimer = setInterval(() => {
    try {
      if (cfg().armed !== true) {
        if (Number(cfg().armedAt) || Number(cfg().armedRuns)) patchArmed({ armedAt: 0, armedRuns: 0 });
        return;
      }
      armedWindow();                                        // 起表 / 到点上锁
    } catch (e) { log('armed 看门狗出错：' + (e?.message ?? e)); }
  }, 20000);
  try { armedTimer.unref?.(); } catch { /* 无 unref 不影响功能 */ }
}
function stopArmedWatch() {
  if (armedTimer) { clearInterval(armedTimer); armedTimer = null; }
}

// ── 限频 ────────────────────────────────────────────────────────────────
function takeSlot(maxPerHour) {
  const win = 3600_000;
  const now = Date.now();
  while (runTimes.length && now - runTimes[0] > win) runTimes.shift();
  if (runTimes.length >= maxPerHour) return false;
  runTimes.push(now);
  return true;
}

// ── 正文提取 ────────────────────────────────────────────────────────────
/**
 * 取「\任务」之后的**全文**（含空格、含换行）。
 *
 * ⚠️ 不能依赖路由给的 args.line —— 路由的参数提取规则是"只取第一个词"
 *    （src/skills/command-router.js 的 restAfterCommand）。任务描述必然是
 *    一整句话（"帮我看看日志里有没有报错"），被截成第一个词就彻底没用。
 *    同款坑与修法见 pc-control-l3 的 fullBodyFrom。
 */
function fullBodyFrom(ctx) {
  const src = commandEntryFrom(ctx);
  const text = String(src?.text || '');
  if (!text) return '';
  const m = CMD_RE.exec(text);
  if (!m) return '';
  return text.slice(m.index + m[0].length).trim();
}

/** 正文是不是某个子命令（"解锁"/"状态"…），只认**整词相等**。 */
function matchSub(body) {
  const b = String(body || '').trim().toLowerCase();
  if (!b) return '';
  for (const [key, words] of Object.entries(SUB)) {
    if (words.some((w) => b === String(w).toLowerCase())) return key;
  }
  return '';
}

// ── 帮助 / 状态文案 ─────────────────────────────────────────────────────
function helpText() {
  const s = readSettings();
  const names = [...readBackends().keys()];
  const def = String(cfg().defaultBackend || names[0] || '').trim();
  return [
    '🎯 AI 任务（把大白话交给本机的 AI agent 执行）',
    '',
    `用法：\\${COMMAND} 要说的话`,
    // ⚠️ 示例里不写作者的项目路径（2026-10-01 出包自检抓到）：别人的机器上根本没有
    //    那个盘符目录，照抄只会得到一个不存在的路径。
    `例：\\${COMMAND} 帮我看看 <项目目录>\\data\\logs 里今天有没有报错`,
    '',
    `指定后端：\\${COMMAND} -名字 要说的话`,
    `  例：\\${COMMAND} -dsh 统计一下代码行数`,
    `可用后端：${names.length ? names.join('、') : '（还没配）'} ｜ 默认：${def || '（无）'}`,
    '',
    '子命令：',
    `  \\${COMMAND} 解锁    松第二道锁（${lockModeText()}）`,
    `  \\${COMMAND} 上锁    立刻上锁`,
    `  \\${COMMAND} 状态    看当前状态`,
    `  \\${COMMAND} 后端    列出所有后端`,
    `  \\${COMMAND} 帮助    这一页`,
    '',
    '⚠️ 每个任务都是一次完整的 agent 会话：它会真的读写文件、执行命令，也会消耗 token。'
  ].join('\n');
}
function lockModeText() {
  const s = readSettings();
  if (s.lockMode === 'off') return '不自动锁';
  if (s.lockMode === 'window') return `解锁后 ${s.armedTTL > 0 ? s.armedTTL + ' 秒' : '不限时'}`;
  return `${s.armedTTL > 0 ? s.armedTTL + ' 秒' : '不限时'} / ${s.maxRuns > 0 ? '最多 ' + s.maxRuns + ' 次' : '不限次数'}`;
}
/** 列出所有后端（名字 + 命令模板）。 */
function backendListText() {
  const map = readBackends();
  if (!map.size) return '（后端列表是空的 —— 到插件设置里填「agent 后端列表」）';
  const def = String(cfg().defaultBackend || '').trim();
  const lines = [...map.values()].map((b) => {
    const mark = b.name === def ? ' ★默认' : '';
    return `· ${b.name}${mark}\n    ${b.template}`;
  });
  return [`🎯 可用后端（共 ${map.size} 个）：`, ...lines, '',
    `指定用某个：\\${COMMAND} -名字 你的任务`].join('\n');
}

function statusText() {
  const s = readSettings();
  const w = armedWindow();
  const alive = runningChild ? `有任务在跑（${runningName}）` : '空闲';
  const names = [...readBackends().keys()];
  const def = String(cfg().defaultBackend || names[0] || '').trim();
  return [
    `🎯 AI 任务：${s.armed ? '已解锁' : '已上锁'}`,
    `上锁模式：${lockModeText()}`,
    s.armed && w.ok ? `剩余窗口：${w.remainMs === Infinity ? '不限时' : Math.ceil(w.remainMs / 1000) + ' 秒'}` : '',
    `当前：${alive}`,
    `本小时已用 ${runTimes.length}/${s.maxPerHour}`,
    `后端：${names.length ? names.join('、') : '（未配置）'} ｜ 默认 ${def || '（无）'} ｜ 超时 ${s.timeoutSec} 秒`,
    s.workDir ? `工作目录：${s.workDir}` : '工作目录：继承机器人启动目录'
  ].filter(Boolean).join('\n');
}

/**
 * 找可用的 node 可执行文件。
 *
 * 为什么需要它（2026-09-30 用户问"绝对路径怎么填"）：
 *   机器人跑在 electron 里，`process.execPath` 是 **electron.exe 不是 node**，
 *   所以不能拿它跑 dsh。而 electron 进程继承的 PATH 未必包含用户 shell 里的 node ——
 *   一旦 `spawn('node')` 报 ENOENT，用户就得手填绝对路径。
 *   可用户的机器上 node 往往只有一个（本机就是 WorkBuddy 托管的那个），
 *   手填还容易写错、且**版本目录变化后立刻失效**。所以这里按优先级自动找：
 *     ① 设置里的 nodePath（用户显式指定，最高优先）
 *     ② NODE_BIN 环境变量
 *     ③ WorkBuddy 托管目录（<USERPROFILE>/.workbuddy/binaries/node/versions/<ver>/）
 *     ④ 常见安装位置
 *     ⑤ 兜底：直接交给 PATH（spawn 时用 'node'）
 */
function resolveNode(s) {
  if (s.nodePath) return s.nodePath;
  const isWin = process.platform === 'win32';
  const exe = isWin ? 'node.exe' : 'bin/node';
  const cands = [];
  if (process.env.NODE_BIN) cands.push(process.env.NODE_BIN);
  // WorkBuddy 托管目录：本机唯一的 node 就在这里
  try {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const base = path.join(home, '.workbuddy', 'binaries', 'node', 'versions');
    if (fs.existsSync(base)) {
      for (const v of fs.readdirSync(base)) cands.push(path.join(base, v, exe));
    }
  } catch { /* 目录不存在就算了 */ }
  cands.push(
    'C:/Program Files/nodejs/node.exe',
    'C:/Program Files (x86)/nodejs/node.exe',
    '/usr/local/bin/node',
    '/usr/bin/node'
  );
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch { /* 单个候选读不到就跳过 */ }
  }
  return 'node';                       // ⑤ 交给 PATH
}

// ── 后端（多 agent 支持）─────────────────────────────────────────────────
/**
 * 把命令模板切成 argv。
 *
 * 支持用双引号/单引号把含空格的参数包起来（Windows 路径里空格很常见）：
 *   `node "C:/Program Files/x/bin.js" -p {task}` → ['node', 'C:/Program Files/x/bin.js', '-p', '{task}']
 *
 * ⚠️ 这里**只做拆分，不经过 shell**。任务文本最终是**独立的一个 argv**，
 *    所以任务里写 `; rm -rf` 或 `&& xxx` 都只是普通文字，不会被当命令执行。
 *    这是"不许拼 shell 字符串"那条铁律的落点。
 */
function parseCmdline(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(s ?? '')))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * 读后端表：每行「名字=命令模板」，`#` 开头是注释，空行忽略。
 * 坏了行（没有 `=`）跳过并记日志 —— 不因为一行写错就整个不可用。
 */
/** 最近一次解析时被丢弃的后端及原因（供"没有可用后端"的错误文案带出来）。 */
let lastBackendProblems = [];

function readBackends() {
  const map = new Map();
  lastBackendProblems = [];
  const cfgRaw = String(cfg().backends ?? '').trim();
  // 没配 → 自动猜一个 DSH 当默认（分发友好：默认值里不留作者机器的路径）
  if (!cfgRaw) {
    const bin = guessDshBin();
    if (bin) {
      const template = `node ${bin} --profile headless {task}`;
      map.set('dsh', { name: 'dsh', template, argv: ['node', bin, '--profile', 'headless', '{task}'] });
    }
    return map;
  }
  // ⚠️ 分隔符同时认换行**和分号**（2026-10-01）：
  //    设置表单历史上把多行文本渲染成 `<input>`（存不了换行），一保存两条后端就粘连成一条。
  //    换行仍是推荐写法（可读），分号是兜底 —— 单行写法 `a=…;b=…` 也能正确切开，
  //    即使哪天换行再被吃掉，也不会出现"两个后端并成一个、参数互相污染"的怪错误。
  for (const line of cfgRaw.split(/\r?\n|;/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) { log(`[AI 任务] 跳过无法解析的后端行：${t.slice(0, 60)}`); continue; }
    const name = t.slice(0, i).trim();
    const template = t.slice(i + 1).trim();
    if (!name || !template) continue;
    const argv = parseCmdline(template);
    // ── 粘连检测：宁可不用这个后端，也绝不执行一条被拼坏的命令 ──
    // 实测形态：两条后端之间的分隔符丢了 → `wb=… -p {task} -ydsh=node <其它后端的命令行>`
    // 于是 codebuddy 收到 dsh 的 --profile → unknown option → 任务失败，
    // 而报错看上去跟"配置被改写"毫无关系，极难定位。
    // 判据：第一个词之后又出现 `xxx=node` 这种"下一条后端开头"的词 → 认定被粘连。
    const fused = argv.slice(1).find((a) => /^[A-Za-z0-9_.-]+=(node|npx)(\.exe)?$/i.test(a));
    if (fused) {
      const why = `「${name}」的模板疑似被粘连（出现 ${fused}），已跳过：${template.slice(0, 80)}`;
      log(`[AI 任务] ${why}`);
      lastBackendProblems.push(why + ' —— 到插件设置里检查「agent 后端列表」，两条之间要有换行或分号');
      continue;
    }
    map.set(name, { name, template, argv });
  }
  return map;
}

/** 当前该用哪个后端：显式指定 > defaultBackend > 表里第一个。 */
function resolveBackend(name) {
  const map = readBackends();
  if (!map.size) {
    return {
      ok: false,
      why: '没有可用的后端。到插件设置里填「agent 后端列表」，例如：\n'
        + '  dsh=node <你的DSH目录>/node_modules/@deepseek-ai/dsh/lib/bin.js --profile headless {task}'
        // 解析时若有被丢弃的后端，把原因一起说出来 —— 否则用户只看到"没有可用后端"，
        // 不知道是自己那条配置被并成了一条（2026-10-01 实测：这条提示能省掉一轮排查）。
        + (lastBackendProblems.length ? `\n\n当前配置有 ${lastBackendProblems.length} 条被判定为无效：\n` + lastBackendProblems.join('\n') : '')
    };
  }
  const want = String(name || cfg().defaultBackend || '').trim();
  if (want && map.has(want)) return { ok: true, backend: map.get(want) };
  if (want) {
    return { ok: false, why: `没有叫「${want}」的后端。现有：${[...map.keys()].join('、')}` };
  }
  return { ok: true, backend: map.values().next().value };
}

/**
 * 用任务文本把模板落成最终 argv。
 * · `{task}` 占位 → 替换成任务（**整体作为一个元素**）
 * · 模板里没写 `{task}` → 追加到末尾
 * · 第一个元素是裸 `node` → 换成自动探测出来的 node 绝对路径
 *   （机器人跑在 electron 里，PATH 未必有 node，见 resolveNode 的注释）
 */
function buildArgv(backend, task, s) {
  const out = [];
  let used = false;
  for (const a of backend.argv) {
    if (a === '{task}') { out.push(task); used = true; } else out.push(a);
  }
  if (!used) out.push(task);
  if (out[0] === 'node') out[0] = resolveNode(s);
  return out;
}

/**
 * 从句首提取可选的后端指定：「-名字 任务内容」→ { backendName, task }。
 *
 * 为什么用 `-` 而不是 `@`：QQ 里 `@xxx` 会被协议端换成 `[CQ:at,qq=...]`，
 * 到插件手里已经不是原文了；`-` 是纯文本，不会被任何一层加工。
 * 正文以 `-` 开头但不是后端名时（如「-1 是什么意思」），resolveBackend 会
 * 明确回"没有叫 -1 的后端"，不会静默吞掉任务。
 */
function splitBackendPrefix(body) {
  const t = String(body || '').trim();
  const m = /^[-—–]\s*([A-Za-z0-9_\u4e00-\u9fa5]{1,24})\s+([\s\S]*)$/.exec(t);
  if (!m) return { backendName: '', task: t };
  return { backendName: m[1], task: m[2].trim() };
}

// ── 执行 ────────────────────────────────────────────────────────────────
/**
 * 跑一个任务。**不 await** —— 调用方立刻返回"已受理"，
 * 结果在 close 事件里主动发回会话。
 */
function runBackend({ task, backend, chatKey, s, sender = null }) {
  const argv = buildArgv(backend, task, s);
  if (!argv.length || !argv[0]) {
    return Promise.resolve({ ok: false, text: `❌ 后端「${backend.name}」的命令模板是空的，请到插件设置里检查。` });
  }
  const [bin, ...args] = argv;
  const opts = {
    cwd: s.workDir && fs.existsSync(s.workDir) ? s.workDir : undefined,
    windowsHide: true,
    // DSH_HOME 只对 DSH 有意义；设了对其余 agent 无害（会被忽略）
    env: { ...process.env, DSH_HOME: process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh') }
  };

  return new Promise((resolve) => {
    let child;
    try {
      // ⚠️ 绝不加 shell: true —— 任务文本是**单个 argv**，让系统自己处理引号；
      //    拼 shell 字符串等于开一个命令注入的口子（任务文本里写个 ; 就完了）。
      child = spawn(bin, args, opts);
    } catch (e) {
      return resolve({ ok: false, text: `❌ 启动后端「${backend.name}」失败：${e?.message || e}` });
    }
    runningChild = child;
    runningName = backend.name;
    let out = '';
    let err = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGKILL'); } catch { /* 已经退了 */ }
    }, s.timeoutSec * 1000);
    try { timer.unref?.(); } catch { /* ignore */ }

    // ── 进度哨兵（只读旁路，见 startProgressWatcher 的说明）──
    // 有发送通道才开：没有通道的话，进度消息本身也发不出去，开了纯属自娱自乐。
    const startedAt = Date.now();
    const watcher = sender?.sendTextBatch
      ? startProgressWatcher({
        startedAt,
        s,
        onLabel: (label) => {
          sender.sendTextBatch(chatKey, [`⏳ ${backend.name}：${label}`], {})
            .catch((e) => log('[AI 任务] 进度回传失败：' + (e?.message ?? e)));
        }
      })
      : { stop: () => {} };

    child.stdout?.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr?.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => {
      clearTimeout(timer);
      watcher.stop();
      runningChild = null;
      runningName = '';
      resolve({
        ok: false,
        text: `❌ 后端「${backend.name}」启动失败：${e?.message || e}\n`
          + `执行的命令：${bin} ${args.join(' ').slice(0, 200)}\n`
          + '（若提示找不到 node，可留空「node 可执行文件」让它自动探测，或手填绝对路径）'
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      watcher.stop();            // 任务结束立刻停哨兵，不留定时器
      runningChild = null;
      runningName = '';
      if (killed) {
        resolve({ ok: false, text: `⏰ 任务超时（${s.timeoutSec} 秒），已终止。\n可以调大「单个任务超时」或把任务拆小一点。` });
        return;
      }
      const body = String(out || '').trim();
      if (!body) {
        const tail = String(err || '').trim().split(/\r?\n/).slice(-6).join('\n');
        // ⚠️ 把**实际执行的命令行**打出来（2026-10-01）：
        //    实测踩过一次 —— 配置里两个后端之间的换行被表单压平，
        //    wb 的模板变成 `… -p {task} -ydsh=node <另一条后端的命令行>`，
        //    codebuddy 收到 dsh 的 `--profile` 报 unknown option 退出。
        //    当时只回「没有输出内容 + 日志尾部」，日志里全是无关的 Git Bash 提示，
        //    根本看不出是命令行被拼坏了 —— 排查绕了一大圈。
        //    失败信息里带上命令，这类"配置被改写"的问题一眼就能定位。
        const cmd = `${bin} ${args.join(' ')}`;
        // 退出码 null = 进程被信号/外部终止（不是正常退出）——
        // 实测（2026-10-03 00:18）：codebuddy 收到任务后 7 秒内死亡、转录只有输入、
        // 无 stderr 报错；手动重跑同一命令正常 → 是该次运行被外部结束（WorkBuddy
        // 对托管 workspace 的管理动作 / CLI 崩溃），属临时故障，重发即可。
        const nullHint = code === null
          ? '\n⚠️ 进程是被异常终止的（不是正常退出）—— 多为 CLI 崩溃或被宿主管理动作结束'
            + '（如 WorkBuddy 更新/重启 codebuddy）。**直接重发一次即可**；反复出现就在终端手动跑上面这条命令看报错。'
          : '';
        resolve({
          ok: code === 0,
          text: `⚠️ 后端「${backend.name}」没有输出内容（退出码 ${code}）。${nullHint}\n执行的命令：${cmd.slice(0, 300)}`
            + `${tail ? `\n日志尾部：\n${tail}` : ''}`
        });
        return;
      }
      resolve({ ok: true, text: body });
    });
  });
}

/** 结果整形：抬头（含后端名）+ 截断。 */
function formatReply(task, text, s, backendName = '') {
  const head = `🎯 任务完成${backendName ? `（${backendName}）` : ''}：`
    + (task.length > 40 ? task.slice(0, 40) + '…' : task);
  let body = String(text || '').trim();
  if (body.length > s.maxReplyChars) {
    body = body.slice(0, s.maxReplyChars) + `\n……（已截断，共 ${body.length} 字）`;
  }
  return `${head}\n\n${body}`;
}

/**
 * 读一个 `{...}` 分组（支持嵌套），返回内容与其后 `}` 的位置。
 * 给下面的 LaTeX 转换用 —— `\frac{a}{b}` 的两个参数必须成对取出来。
 */
function readGroup(s, openIdx) {
  if (s[openIdx] !== '{') return null;
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth === 0) return { body: s.slice(openIdx + 1, i), end: i };
    }
  }
  return null;
}

// LaTeX 命令 → Unicode / 普通写法。QQ 不会渲染公式，原样发出去就是一坨"乱码"
// （2026-10-01 群里实测：结果里的 $$\frac{...}$$ 被群友问"乱码了？""latex没渲染"）。
const TEX_SYMBOLS = [
  [/\\d?frac/g, ''],                                    // 单独处理，占位避免被后面的规则吃掉
  [/\\left|\\right|\\displaystyle|\\limits|\\!/g, ''],
  [/\\(?:quad|,|;|:| |hspace\{[^}]*})/g, ' '],
  [/\\to\b\s*|\\rightarrow\b\s*|\\longrightarrow\b\s*/g, '→'],
  [/\\Rightarrow\b/g, '⇒'], [/\\Leftarrow\b/g, '⇐'],
  [/\\cdot\s*/g, '·'], [/\\times\s*/g, '×'], [/\\div\s*/g, '÷'], [/\\pm\s*/g, '±'],
  [/\\leq\b\s*|\\le\b\s*/g, '≤'], [/\\geq\b\s*|\\ge\b\s*/g, '≥'], [/\\neq\b\s*|\\ne\b\s*/g, '≠'],
  [/\\approx\s*/g, '≈'], [/\\equiv/g, '≡'], [/\\infty\s*/g, '∞'],
  [/\\sum/g, '∑'], [/\\prod/g, '∏'], [/\\int/g, '∫'], [/\\partial/g, '∂'],
  [/\\sqrt/g, '√'],
  [/\\Delta\s*/g, 'Δ'], [/\\delta\s*/g, 'δ'], [/\\varepsilon\s*|\\epsilon\s*/g, 'ε'],
  [/\\alpha\s*/g, 'α'], [/\\beta\s*/g, 'β'], [/\\gamma\s*/g, 'γ'], [/\\theta\s*/g, 'θ'],
  [/\\lambda\s*/g, 'λ'], [/\\mu\s*/g, 'μ'], [/\\pi\s*/g, 'π'], [/\\sigma\s*/g, 'σ'],
  [/\\phi\s*/g, 'φ'], [/\\omega\s*/g, 'ω'], [/\\rho\s*/g, 'ρ'], [/\\tau\s*/g, 'τ'],
  [/\\nabla\s*/g, '∇'],
  [/\\sin/g, 'sin'], [/\\cos/g, 'cos'], [/\\tan/g, 'tan'], [/\\cot/g, 'cot'],
  [/\\ln/g, 'ln'], [/\\log/g, 'log'], [/\\exp/g, 'exp'],
  [/\\max/g, 'max'], [/\\min/g, 'min'], [/\\lim/g, 'lim'],
  [/\\mathbb\{[A-Z]\}/g, (m) => m.slice(8, -1)],        // ℝ → R
];
// ⚠️ 别叫 SUP/SUB —— 文件里已经有同名的**子命令表**（第 113 行），会撞车
const TEX_SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', n: 'ⁿ' };
const TEX_SUB = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉' };

/** 把一段 LaTeX 表达式翻成"QQ 里能读懂"的纯文本。 */
function texToPlain(src) {
  let s = String(src || '');

  // 0. 无花括号的分数：\frac1x 也是合法 LaTeX（单字符参数），
  //    不先处理的话后面"删掉未识别命令"会把 \frac 整段吃掉，只剩 1x（真机踩到）。
  s = s.replace(/\\(?:d|t)?frac\s*([A-Za-z0-9])\s*([A-Za-z0-9])/g, '($1)/($2)');

  // 1. 分数：从最内层往外化，\frac{a}{b} → (a)/(b)（a、b 里还能再套分数）
  for (let guard = 0; guard < 30; guard++) {
    const m = /\\(?:d|t)?frac\s*\{/.exec(s);
    if (!m) break;
    const open1 = m.index + m[0].length - 1;
    const g1 = readGroup(s, open1);
    if (!g1) { s = s.slice(0, m.index) + s.slice(m.index + m[0].length); continue; }
    const open2 = s.indexOf('{', g1.end);
    const g2 = open2 >= 0 ? readGroup(s, open2) : null;
    if (!g2) { s = s.slice(0, m.index) + g1.body + s.slice(g1.end + 1); continue; }
    s = s.slice(0, m.index) + `(${g1.body})/(${g2.body})` + s.slice(g2.end + 1);
  }

  // 2. 根号：\sqrt{x} → √(x)。⚠️ 必须用 readGroup 找配对的 `}` ——
  //    早期版本只把开头的 `{` 换成 `(` 就完事，结果是 `√(4.01}` 这种半边括号。
  for (let guard = 0; guard < 20; guard++) {
    const m = /\\sqrt\s*(\[[^\]]*\])?\s*\{/.exec(s);
    if (!m) break;
    const open = m.index + m[0].length - 1;
    const g = readGroup(s, open);
    if (!g) { s = `${s.slice(0, m.index)}√${s.slice(open + 1)}`; continue; }
    s = `${s.slice(0, m.index)}${m[1] ? m[1].slice(1, -1) : ''}√(${g.body})${s.slice(g.end + 1)}`;
  }

  // 3. 命令 → 符号
  for (const [re, to] of TEX_SYMBOLS) s = s.replace(re, to);

  // 4. 上标 / 下标：^{...} → ^(...)，x^2 → x²，x_0 → x₀
  s = s.replace(/\^\{([^{}]*)\}/g, (m, g) => `^(${g})`);
  s = s.replace(/_\{([^{}]*)\}/g, (m, g) => `_(${g})`);
  s = s.replace(/\^([0-9n])\b/g, (m, c) => TEX_SUP[c] || m);
  s = s.replace(/_([0-9])\b/g, (m, c) => TEX_SUB[c] || m);
  //    lim/sum/∫ 这类后面的 _(...) 写成 (...) 更顺：lim_(x→0) → lim(x→0)
  s = s.replace(/\b(lim|∑|∏|∫|max|min|log|ln)\s*_\(([^)]*)\)/g, '$1($2)');

  // 5. 收尾：去掉没认出来的命令的反斜杠、空括号、多余空格
  s = s.replace(/\\([A-Za-z]+)/g, '$1');
  s = s.replace(/\{\}/g, '');
  s = s.replace(/[ \t]{2,}/g, ' ');
  return s.trim();
}

/**
 * 把结果里的数学公式降级成纯文本（QQ 不渲染 LaTeX，原样发就是一团乱码）。
 * 只认真正的公式定界符（$$…$$、$…$、\[…\]、\(…\)），且内容要带 LaTeX 特征
 * （反斜杠命令 / ^ _ { }）才动手 —— 免得把「$5」这种金额也改了。
 */
function plainMathText(text) {
  let s = String(text || '');
  const isMath = (g) => /\\[A-Za-z]+|[_^{}]/.test(g);
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (m, g) => (isMath(g) ? `\n${texToPlain(g)}\n` : m));
  s = s.replace(/\\\[([\s\S]+?)\\\]/g, (m, g) => (isMath(g) ? `\n${texToPlain(g)}\n` : m));
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, (m, g) => texToPlain(g));
  // ⚠️ 行内 `$…$` 不能沿用 isMath —— 真机里 `$s(t)$`、`$(af+bg)'=af'+bg'$`
  //    这种"没有反斜杠"的公式占了大半，不转的话满屏还是 `$`，照样像乱码。
  //    改用"短且不含标点空格"判据：`5 到 ` 这种金额区间因为带空格被排除在外。
  s = s.replace(/\$([^$\n]+?)\$/g, (m, g) => (isMath(g) || /^[^，。；！？、\s]{1,40}$/.test(g) ? texToPlain(g) : m));
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 把任务结果切成**多条**（2026-10-01 用户要求：别截断，分几条发完）。
 *
 * 为什么改：以前只有 formatReply 一条路 —— 超过 maxReplyChars 就直接砍掉尾巴，
 * 用户拿到的是半截结果（`\n……（已截断，共 2091 字）`）。AI 任务的输出本来就长，
 * 砍掉的那半截往往正是结论。真正的发送通道 `sender.sendTextBatch(chatKey, [ ... ])`
 * **本来就吃数组**（会排队一条条发、自带限频），所以只要把文本切成数组就行。
 *
 * 切法：先按行拼（尽量不在句子中间断开），单行超长才硬切。
 * 每段都带 `（i/n）` 序号 —— 手机上多条消息是分开的气泡，没有序号看不出顺序。
 * 超过 maxReplyParts（默认 6）就不再往下发，最后补一句"还有多少字没发"，
 * 避免一个话痨任务把群刷屏。
 */
function splitReply(task, text, s, backendName = '') {
  const head = `🎯 任务完成${backendName ? `（${backendName}）` : ''}：`
    + (task.length > 40 ? task.slice(0, 40) + '…' : task);
  // LaTeX → 纯文本（QQ 不渲染公式，原样发出去群友看到的就是"乱码"）。
  // 开关默认开；想保留原始 LaTeX 就到插件设置里关掉。
  const raw = String(text || '').trim();
  const body = s.plainMath === false ? raw : plainMathText(raw);
  const per = Math.max(100, Number(s.maxReplyChars) || 1500);
  const maxParts = Math.max(1, Math.min(20, Number(s.maxReplyParts) || 6));

  // ── 均衡分段（2026-10-01）──────────────────────────────────────────
  // 旧写法是"贪心填满一段就断"，真机实测把结果切成了 1395 字 + 353 字 ——
  // 群里看着像"第二条被截断了"。现在先算出**该分几段**，再按目标长度从行开始切：
  //   段数 n = ceil(总长 / 单条上限)（最少几条装得下），目标 = 总长 / n。
  // ⚠️ 不能在"先按上限切成块、再把块分组"上打补丁 —— 那样最后总会剩一个零头块
  //    （试过：切出 1507 / 79，更难看）。必须从行级重新分。
  const lines = String(body).split('\n');
  const totalLen = String(body).length;
  const n = Math.min(maxParts, Math.max(1, Math.ceil(totalLen / per)));
  const target = Math.ceil(totalLen / n);

  const chunks = [];
  let cur = '';
  for (const line of lines) {
    const cand = cur ? `${cur}\n${line}` : line;
    const slotsLeft = n - chunks.length - 1;                 // 后面还能再开几段
    if (cur && (cand.length > per || (cur.length >= target && slotsLeft > 0))) {
      chunks.push(cur); cur = line; continue;
    }
    cur = cand;
  }
  if (cur) chunks.push(cur);

  const parts = [];
  for (const c of chunks) {
    if (c.length <= per) { parts.push(c); continue; }
    for (let i = 0; i < c.length; i += per) parts.push(c.slice(i, i + per));   // 单行超长的硬切
  }
  if (!parts.length) return [`${head}\n\n（任务没有返回内容）`];

  const shown = parts.slice(0, maxParts);
  const total = Math.min(parts.length, maxParts);
  const out = shown.map((p, i) => `${head}${total > 1 ? `（${i + 1}/${total}）` : ''}\n\n${p}`);
  if (parts.length > maxParts) {
    const rest = parts.slice(maxParts).join('\n').length;
    out.push(`……还有 ${parts.length - maxParts} 段（约 ${rest} 字）没发，超过「最多分几条」的上限。`
      + '想看全就让任务写短一点，或把上限调大。');
  }
  return out;
}

// ── 指令路由 ────────────────────────────────────────────────────────────
async function route(ctx, args) {
  // ⚠️ 来源标记：只有指令直达链路会带上 plugin.json 里配的 __agentTask。
  // 为什么必须校验：commandOnly 的"工具可见性"由「批内是否含 \任务」决定 ——
  // 群友发一句 \任务 就能让本工具出现在**模型的工具列表**里；模型若为此调用它，
  // 就等于模型可以自己往 agent 里塞任务。标记字段不在工具 schema 里、描述里也不提。
  if (args?.__agentTask !== 'direct-route') {
    return { content: '（AI 任务只接受指令直达调用，已忽略本次调用）', isError: true };
  }

  const uid = senderIdFrom(ctx);
  const isOwnerFn = makeOwnerChecker();
  const isOwner = isOwnerFn ? isOwnerFn(uid) : false;
  // 非主人：**静默**（不提示、不回话）—— 别让群里知道这里有个遥控口
  if (!isOwner) return { silent: true };
  if (!isAllowedChat(ctx)) {
    audit('拒绝', `${ctx?.chatKey} 非允许会话`);
    return { _directText: '本群未在「AI 任务」的允许列表里，已忽略。' };
  }

  const body = fullBodyFrom(ctx);
  const sub = matchSub(body);

  if (sub === 'help' || (!body && !sub)) return { _directText: helpText() };
  if (sub === 'backends') return { _directText: backendListText() };

  if (sub === 'unlock') {
    patchArmed({ armed: true, armedAt: Date.now(), armedRuns: 0 });
    audit('解锁', `${ctx?.chatKey} ${uid}`);
    log('[AI 任务] 已解锁');
    return { _directText: `🔓 已解锁：${lockModeText()}。\n现在可以发「\\${COMMAND} 要说的话」。` };
  }
  if (sub === 'lock') {
    patchArmed({ armed: false, armedAt: 0, armedRuns: 0 });
    audit('上锁', `${ctx?.chatKey} ${uid}`);
    return { _directText: '🔒 已上锁。' };
  }
  if (sub === 'status') return { _directText: statusText() };

  // ── 布置任务 ──
  const s = readSettings();
  const w = armedWindow();
  if (!w.ok) {
    if (w.why === 'locked') {
      return { _directText: `🔒 当前已上锁。先发「\\${COMMAND} 解锁」（或在控制台打开「上锁开关」）再布置任务。` };
    }
    return { _directText: `🔒 ${w.why}` };
  }
  if (runningChild) {
    return { _directText: '⏳ 上一个任务还在跑，等它完成再说（同一时间只跑一个，避免把机器拖满）。' };
  }

  // 后端解析放在限频之前：后端名写错了要立刻告诉用户，不该先占掉一个名额
  const picked = splitBackendPrefix(body);
  const pickedBackend = resolveBackend(picked.backendName);
  if (!pickedBackend.ok) return { _directText: `⚠️ ${pickedBackend.why}` };
  const backend = pickedBackend.backend;
  if (!picked.task) {
    return { _directText: `用法：\\${COMMAND} ${picked.backendName ? '-' + picked.backendName + ' ' : ''}要说的话\n（只说了后端名，没说任务内容）` };
  }
  if (!takeSlot(s.maxPerHour)) {
    return { _directText: `⏳ 本小时的任务次数已达上限（${s.maxPerHour} 个），缓一缓。` };
  }

  patchArmed({ armedRuns: readSettings().armedRuns + 1 });
  audit('布置任务', `${ctx?.chatKey} ${uid} [${backend.name}] :: ${picked.task}`);
  log(`[AI 任务] 受理（${backend.name}）：${picked.task.slice(0, 80)}`);

  const chatKey = String(ctx?.chatKey || '');
  const sender = ctx?.sender;

  // ⚠️ 没有回传通道就**别启动任务**（2026-10-01）：任务是"先受理、几分钟后结果自己回来"
  //    的模式，结果只能通过 ctx.sender 发。基础 0.4 的 before-context 钩子拿不到 sender
  //    （它只能改写消息文本让模型转述），那种情况下启动任务 = 用户永远看不到结果。
  //    所以这里明确拒绝并说明原因，比"受理了却什么也不回来"诚实得多。
  if (!sender?.sendTextBatch) {
    return {
      _directText: '⚠️ 拿不到发送通道（当前框架没把 sender 传给本插件），任务**没有启动** —— '
        + '结果是几分钟后才回来的，没有通道就等于白发。请升级 QQ Agent 或用支持指令直达的版本。'
    };
  }

  // 不 await：立刻回"已受理"，结果在 close 时主动发回
  runBackend({ task: picked.task, backend, chatKey, s, sender })
    .then(async (r) => {
      // 长结果切成多条发（不再截断，见 splitReply）
      const parts = r.ok ? splitReply(picked.task, r.text, s, backend.name) : [String(r.text || '任务失败')];
      audit('任务结果', `${chatKey} [${backend.name}] :: ${r.ok ? 'ok' : 'fail'} :: ${String(r.text).slice(0, 200)}`);
      try {
        await sender.sendTextBatch(chatKey, parts, {});
      } catch (e) { log('[AI 任务] 结果回传失败：' + (e?.message ?? e)); }
    })
    .catch((e) => log('[AI 任务] 执行异常：' + (e?.message ?? e)));

  const shown = picked.task.length > 60 ? picked.task.slice(0, 60) + '…' : picked.task;
  return s.announceOnStart
    ? { _directText: `🎯 已受理（${backend.name}），正在处理…（完成后我会把结果发上来）\n任务：${shown}` }
    : { _directText: '' };
}

export function setup(api) {
  // ⚠️ 框架 API 一律做存在性防御：老框架不一定有 config()，缺了就用内存副本兜底，
  //    而不是让插件抛错加载失败。
  cfg = () => {
    try {
      if (api && typeof api.config === 'function') return api.config() || {};
    } catch { /* 落到内存 */ }
    return memCfg;
  };
  log = (...a) => { try { api?.log?.(...a); } catch { /* 日志失败不影响功能 */ } };
  apiRef = api;

  api.registerTool({
    id: 'task_route',
    name: 'AI 任务路由',
    description: '处理 \\任务 指令（帮助 / 解锁 / 上锁 / 状态 / 后端列表 / 布置任务）。由指令直达链路调用，模型不可见。',
    parameters: { type: 'object', properties: {} },
    async execute(ctx, args) {
      return route(ctx, args);
    }
  });

  startArmedWatch();
  const s = readSettings();
  const names = [...readBackends().keys()];
  log('[AI 任务] 已加载（指令直达：\\' + COMMAND + '；'
    + (s.armed ? '已解锁' : '上锁中') + '；' + lockModeText()
    + `；后端 ${names.length ? names.join('/') : '（未配置）'}；`
    + `只认主人 + 私聊/指定群；单任务上限 ${s.timeoutSec} 秒）`);
}

export function deactivate() {
  stopArmedWatch();
  try { runningChild?.kill('SIGKILL'); } catch { /* ignore */ }
  runningChild = null;
  runningName = '';
}
export function dispose() { deactivate(); }

// ── 老框架兼容兜底（hooks.onMessage）────────────────────────────────────
// 背景（2026-09-30 用户指出）：插件是要**分发**的，别人的 QQ-agent 未必有
// 「反斜杠指令接收（commandOnly）」和「指令直达（commandRoute）」这两个机制。
// 那两个机制都失效时，`\任务` 就没人接 —— 表现为"插件装了但指令没反应"。
// 这里用最早就存在的 `onMessage` 钩子手动接管，保证在只有基础能力的老框架上也能用。
//
// ⚠️ 判断条件不能写成 `getConfig().commandDirect !== false`（L3 的老写法）：
//    老框架的 config 里**根本没有** commandDirect 这个键，`undefined !== false` 为真
//    → 钩子会以为"直达可用"而退位 → 恰恰在最需要兜底的地方不兜底。
//    正确判据：这个键必须**确实存在且为 true**。
function directRouteAvailable() {
  let c = null;
  try { c = getConfig() || {}; } catch { return false; }   // 连 getConfig 都没有 = 更老的框架
  return typeof c.commandDirect === 'boolean' ? c.commandDirect === true : false;
}

/** 从 OneBot 事件里取纯文本（群/私聊通用）。 */
function extractText(ev) {
  if (Array.isArray(ev?.message)) {
    return ev.message.map((s) => (s?.type === 'text' ? String(s?.data?.text ?? '') : '')).join('');
  }
  return String(ev?.raw_message ?? '');
}

export const hooks = {
  // ── 老框架兜底（基础 0.4 走这条）──────────────────────────────────────
  // ⚠️ 为什么必须挂 before-context（2026-10-01 补）：基础 0.4 支持的钩子只有
  //    before-context / before-llm-messages / after-response / before-tool / after-tool
  //    —— **没有 onMessage**（新版 2026-09-26 才加）。本插件原来只挂了 onMessage，
  //    是 §四十二 那批"死兜底"里**唯一漏网**的（其余 7 个插件都已改挂）。
  // ⚠️ 代价：before-context **拿不到 sender** → 这里只能接"即时答复"类指令
  //    （帮助 / 解锁 / 上锁 / 状态 / 后端列表 / 各类拒绝提示），它们都返回 _directText，
  //    改写进命中消息让模型转述即可；
  //    **布置任务**这种几分钟后才出结果的，route() 会明确回"没有发送通道、任务没启动"
  //    —— 总比"受理了却永远不回来"诚实。
  'before-context': (ctx = {}) => {
    try {
      if (directRouteAvailable()) return;      // 直达可用 → 退位，交给系统
      if (!ctx || (ctx.kind !== 'group' && ctx.kind !== 'private')) return;
      const entries = Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries : [];
      const hit = entries.filter((m) => m && !m.self).slice(-1)[0];
      if (!hit) return;
      const text = String(hit.text || '');
      if (!/[\\/\uFF0F\uFF3C]\s*\u4EFB\u52A1/i.test(text)) return;   // \任务
      // 钩子在回复链路上**绝不能 await**：即发即走
      Promise.resolve(route(
        {
          chatKey: ctx.chatKey, kind: ctx.kind, chatId: ctx.chatId,
          sender: null,                        // ← 拿不到；route 会据此拒绝长任务
          session: { trigger: entries }
        },
        { __agentTask: 'direct-route' }
      ))
        .then((r) => {
          const t = r?._directText || '';
          if (!t) return;                      // silent（非主人）→ 不改写
          hit.text = `${text}\n（系统提示：${t}\n请把上面这段原样转述给用户，不要解释机制。）`;
        })
        .catch((e) => log('[AI 任务] before-context 兜底出错：' + (e?.message ?? e)));
    } catch (error) {
      log('[AI 任务] before-context 兜底出错：' + (error?.message ?? error));
    }
  },

  // ── 新版优先（有 onMessage 就用它：拿得到 sender，长任务也能回传结果）──
  'onMessage': (ctx = {}) => {
    try {
      // 直达链路可用 → 系统处理，钩子退位（避免双重回复）
      if (directRouteAvailable()) return;

      const ev = ctx?.event || {};
      if (ev.post_type && ev.post_type !== 'message') return;
      const kind = ev.message_type === 'group' && ev.group_id != null ? 'group'
        : ev.message_type === 'private' && ev.user_id != null ? 'private' : '';
      if (!kind) return;
      const chatKey = kind === 'private' ? `private:${ev.user_id}` : `group:${ev.group_id}`;
      const text = extractText(ev).trim();
      // 与直达链路同一套指令词匹配（兼容四种斜杠写法）
      const m = /[\\/\uFF0F\uFF3C]\s*\u4EFB\u52A1/i.exec(text);
      if (!m) return;
      const senderId = String(ev.sender?.user_id ?? ev.user_id ?? '').trim();

      // ⚠️ 钩子在回复链路上，**绝不能 await**：即发即走，结果自己发回会话
      route(
        {
          chatKey, kind, chatId: String(kind === 'private' ? ev.user_id : ev.group_id),
          senderId,
          session: { trigger: [{ self: false, senderId, text }] },
          sender: ctx?.sender
        },
        { __agentTask: 'direct-route' }        // 老框架下钩子即"直达链路"本身
      )
        .then((r) => {
          const t = r?._directText || (r?.isError ? r?.content : '');
          if (t) ctx.sender?.sendTextBatch?.(chatKey, [t], {});
        })
        .catch((e) => log('[AI 任务] 兜底路径出错：' + (e?.message ?? e)));
    } catch (error) {
      log('[AI 任务] onMessage 兜底出错：' + (error?.message ?? error));
    }
  }
};

export const internals = {
  fullBodyFrom, matchSub, readSettings, armedWindow, lockNow, takeSlot,
  makeOwnerChecker, isAllowedChat, senderIdFrom, resolveNode,
  commandEntryFrom, lastForeignEntry, CMD_RE,
  progressLabel, findActiveTranscript, startProgressWatcher, slugForCwd,
  parseCmdline, readBackends, resolveBackend, guessDshBin, buildArgv, splitBackendPrefix,
  helpText, statusText, backendListText, formatReply, splitReply, route,
  plainMathText, texToPlain, readGroup,
  SUB, COMMAND, PLUGIN_ID, BACKENDS_HINT
};
