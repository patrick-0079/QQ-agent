// 宿主句柄补丁：打 / 摘 / 查。
//
// 为什么技能要改核心文件 —— 只有一种情况：
//   「到点唤醒 AI」必须调用运行中的编排器（orchestrator.wake）。整合版在
//   activate(ctx) 里把核心实例直接交给技能，零侵入；而 0.4.0 及更早的宿主只传
//   一个空对象（A2/A10 里确认过：不侵入拿不到句柄），技能到点就只能发一条死文本。
//
// 所以这里补一处最小侵入：把整合版已有的那份「扩展上下文」搬一份给这个宿主，
// 形状完全一致（sender / onebot / store / memory / orchestrator / sessions /
// stickers / reminders / videoReader / emit / log / config）。
//
// 三条自我约束（与项目里「指令前置」插件的补丁机制同源，见它的 docs/adr/0005）：
//   1. **标记块**：插入的每一段都用 `[[scheduled-task:<id>]]` 包起来 ——
//      幂等（已在就不重复插）、可检测、可按块精确摘除，绝不整文件覆盖。
//   2. **原子**：锚点找不到、或找到不止一处 → 一个字都不写，报 conflict 让人处理。
//      宁可不打，也不留半残的核心文件。
//   3. **写盘前语法门禁**：补丁文本先落到同目录的临时文件跑一次 `node --check`，
//      语法不过就不写盘。核心文件被改坏 = 用户的机器人起不来。
//
// 补丁正文没有单独放 patches/ 目录（指令前置是那么放的）：这个补丁只有两块，
// 其中一块还必须按"现场抓到的那一行"生成，静态文件反而说不清它到底替换了什么。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MARK = 'scheduled-task';
const TARGET = 'src/app.js';

/** 默认对"技能所在项目的根目录"动手；测试用 SCHEDULED_TASK_ROOT 指到临时目录。 */
export function defaultRoot() {
  return process.env.SCHEDULED_TASK_ROOT
    ? path.resolve(process.env.SCHEDULED_TASK_ROOT)
    : path.resolve(HERE, '..', '..');
}

const open = (id) => `[[${MARK}:${id}]]`;
const close = (id) => `[[/${MARK}:${id}]]`;

/** 插进核心文件里的辅助函数（紧跟在编排器构造之后，作用域里该有的句柄都有）。 */
const HELPER_LINES = [
  '',
  `  // ── ${open('host-context')} 「定时任务」技能自动维护，不要手改这一段 ──`,
  '  // 技能要「到点唤醒 AI」，必须拿到运行中的编排器（orchestrator.wake）。',
  '  // 整合版在 activate(ctx) 里直接给；这个宿主只传空对象，技能拿不到，到点就',
  '  // 只能发一条死文本。这里补上同一份上下文，形状与整合版保持一致。',
  '  // 停用「定时任务」技能时，这一段连同下面的调用点会被 host-patch.mjs 原样摘掉。',
  '  function __scheduledTaskHostContext() {',
  '    return {',
  '      sender, onebot, store, memory, orchestrator, sessions, stickers, reminders, videoReader, emit, log,',
  '      config: { get: () => getConfig(), patch: (patch) => updateConfig(patch), dataDir: DATA_DIR }',
  '    };',
  '  }',
  `  // ── ${close('host-context')} ──`
];

/**
 * 插辅助函数的位置，按顺序试。每个候选都要同时满足三条：
 *   · 这一行**只出现一次**（不唯一就不打 —— 改错地方比不改更糟）；
 *   · 这一行是一条**完整语句的边界**（`requireEnd`）：`;` 结尾的整句，
 *     或 `{` 结尾的函数声明。这条是防"上游把它改成了跨行写法"——
 *     比如 `new Orchestrator({` 后面才换行，锚点仍会命中那一行，
 *     但插进去就落进了调用的参数中间。要求整句结尾，就不会挑到半截。
 *   · 插进去的辅助函数只读同一个作用域里的变量（sender/store/orchestrator…），
 *     所以它必须落在 createApp 的函数体里 —— 这也是为什么锚点挑的是
 *     "编排器构造"和"reloadSkills 定义"这两个必定在同层的东西。
 */
const HELPER_ANCHORS = [
  { re: /^\s*const orchestrator = new Orchestrator\(/, requireEnd: ';' },
  { re: /^\s*(async\s+)?function reloadSkills\(/, requireEnd: '{' }
];

function readLines(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/);
}

function countMatches(lines, re) {
  const hits = [];
  lines.forEach((line, i) => { if (re.test(line)) hits.push(i); });
  return hits;
}

/** 某个候选锚点在文件里唯一且落在完整语句边界上时，返回行号。 */
function findAnchor(lines) {
  for (const { re, requireEnd } of HELPER_ANCHORS) {
    const hits = countMatches(lines, re);
    if (hits.length !== 1) continue;
    const line = lines[hits[0]].trim();
    if (!line.endsWith(requireEnd)) continue;
    return hits[0];
  }
  return undefined;
}

function findBlock(lines, id) {
  const openIdx = lines.findIndex((l) => l.includes(open(id)));
  if (openIdx < 0) return null;
  const closeIdx = lines.findIndex((l, i) => i > openIdx && l.includes(close(id)));
  if (closeIdx < 0) return { open: openIdx, close: -1 };
  return { open: openIdx, close: closeIdx };
}

/**
 * 状态文件放哪：正常就放在技能目录里（跟着技能走）。
 * 演练（root 指到别处）时跟着那个 root 走 —— 否则一次演练会往真实技能目录里
 * 塞进"别处的备份"，下次真打补丁还原的就是错的行。
 */
function stateFileFor(root = defaultRoot()) {
  return path.resolve(root) === path.resolve(defaultRoot())
    ? path.join(HERE, '.host-patch.json')
    : path.join(root, '.scheduled-task-patch.json');
}

function readState(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFileFor(root), 'utf8'));
    if (parsed && typeof parsed === 'object') return parsed;
  } catch { /* 没有状态文件是正常情况 */ }
  return null;
}

function writeState(root, state) {
  fs.writeFileSync(stateFileFor(root), JSON.stringify(state, null, 1), 'utf8');
}

function clearState(root) {
  try { fs.rmSync(stateFileFor(root), { force: true }); } catch { /* ignore */ }
}

/** 写盘前的语法门禁：临时文件放在同目录，才能继承同一个 package.json 的 "type"。 */
function syntaxOk(file, text) {
  const probe = path.join(path.dirname(file), `.scheduled-task-check-${process.pid}.js`);
  try {
    fs.writeFileSync(probe, text, 'utf8');
    const r = spawnSync(process.execPath, ['--check', probe], { encoding: 'utf8' });
    return { ok: r.status === 0, detail: String(r.stderr || r.stdout || '').trim().split('\n')[0] || '' };
  } catch (error) {
    return { ok: false, detail: String(error?.message ?? error) };
  } finally {
    try { fs.rmSync(probe, { force: true }); } catch { /* ignore */ }
  }
}

/** 当前状态：能不能打、打没打上、有没有半打状态。 */
export function hostPatchStatus({ root = defaultRoot() } = {}) {
  const file = path.join(root, TARGET);
  if (!fs.existsSync(file)) return { supported: false, applied: false, file, reason: `找不到 ${TARGET}` };
  const lines = readLines(file);
  const helper = findBlock(lines, 'host-context');
  const call = findBlock(lines, 'activate-context');
  if (helper && call) return { supported: true, applied: true, file, reason: '' };
  if (helper || call) return { supported: true, applied: false, file, conflict: '文件里只有半个标记块（打补丁中途被打断过），请手工清掉后重试' };
  const anchorIdx = findAnchor(lines);
  if (anchorIdx === undefined) return { supported: false, applied: false, file, reason: '这个宿主的 src/app.js 结构与已知版本都对不上（锚点行找不到、不唯一，或已经被改成了跨行写法）' };
  const calls = findActivateCalls(lines);
  if (calls.length !== 1) {
    return { supported: false, applied: false, file, reason: calls.length === 0 ? '没有找到 skillManager.activate 调用点（宿主版本可能已经原生支持，或结构变化太大）' : `找到 ${calls.length} 处 skillManager.activate 调用点，无法确定改哪一处` };
  }
  return { supported: true, applied: false, file, reason: '' };
}

/** 需要打补丁的调用点：没有第二个参数、且不是我们自己打的。 */
function findActivateCalls(lines) {
  const hits = [];
  lines.forEach((line, i) => {
    if (!/skillManager\.activate\(/.test(line)) return;
    if (line.includes(open('activate-context'))) return;
    if (/skillManager\.activate\([^)]*,/.test(line)) return;   // 已经带上下文了
    hits.push(i);
  });
  return hits;
}

/**
 * 打补丁。返回 { ok, changed?, alreadyApplied?, conflict? }。
 * 只在宿主真的缺句柄时才该被调用（判断在 index.js 的 ensureHostContext）。
 */
export function applyHostPatch({ root = defaultRoot(), now = new Date() } = {}) {
  const file = path.join(root, TARGET);
  const st = hostPatchStatus({ root });
  if (st.applied) return { ok: true, alreadyApplied: true, file };
  if (!st.supported) return { ok: false, conflict: st.reason || '宿主不支持', file };

  const lines = readLines(file);
  const anchorIdx = findAnchor(lines);
  const callIdx = findActivateCalls(lines)[0];
  if (anchorIdx === undefined || callIdx === undefined) return { ok: false, conflict: '锚点定位失败', file };

  const original = lines[callIdx];
  const indent = (/^\s*/.exec(original) || [''])[0];
  if (!/skillManager\.activate\([^)]*\)/.test(original)) return { ok: false, conflict: '调用点形状不认识，放弃', file };
  const patchedCall = original.replace(/skillManager\.activate\(([^)]*)\)/, 'skillManager.activate($1, __scheduledTaskHostContext())');
  const callBlock = [
    `${indent}// ── ${open('activate-context')} 「定时任务」技能自动维护，不要手改这一段 ──`,
    patchedCall,
    `${indent}// ── ${close('activate-context')} ──`
  ];

  // 先插辅助函数（在锚点之后），再改调用点：两次都在同一个数组上做，
  // 索引按"改完之后"重新取，避免前一次插入把后一次的索引顶歪。
  const out = [...lines.slice(0, anchorIdx + 1), ...HELPER_LINES, ...lines.slice(anchorIdx + 1)];
  const shiftedCallIdx = callIdx > anchorIdx ? callIdx + HELPER_LINES.length : callIdx;
  out.splice(shiftedCallIdx, 1, ...callBlock);

  const text = out.join('\n');
  const gate = syntaxOk(file, text);
  if (!gate.ok) return { ok: false, conflict: `补丁写盘前语法检查没过：${gate.detail}`, file };

  fs.writeFileSync(file, text, 'utf8');
  writeState(root, { patchVersion: 1, file: TARGET, originalLine: original, appliedAt: now.toISOString() });
  return { ok: true, changed: true, file };
}

/** 摘补丁：先按状态文件还原那一行，再删两个标记块。 */
export function revertHostPatch({ root = defaultRoot() } = {}) {
  const file = path.join(root, TARGET);
  if (!fs.existsSync(file)) return { ok: true, skipped: true, file };
  let lines = readLines(file);
  const helper = findBlock(lines, 'host-context');
  const call = findBlock(lines, 'activate-context');
  if (!helper && !call) return { ok: true, alreadyReverted: true, file };

  const state = readState(root);
  if (call && call.close > call.open) {
    // 优先用状态文件里的原行（逐字节还原）；状态丢了就退而求其次，
    // 把多加的那个参数去掉 —— 行为等价，只是那一行的排版跟原来可能差一点。
    const body = lines.slice(call.open + 1, call.close);
    const originalLine = state?.originalLine
      || body.find((l) => /skillManager\.activate\(/.test(l))?.replace(/,\s*__scheduledTaskHostContext\(\)/, '')
      || '';
    lines.splice(call.open, call.close - call.open + 1, ...(originalLine ? [originalLine] : body));
  }
  const helper2 = findBlock(lines, 'host-context');
  if (helper2 && helper2.close > helper2.open) {
    // 连带它前面那一行空行一起删（那是插进来时加的）
    const from = helper2.open > 0 && lines[helper2.open - 1].trim() === '' ? helper2.open - 1 : helper2.open;
    lines.splice(from, helper2.close - from + 1);
  }

  const text = lines.join('\n');
  const gate = syntaxOk(file, text);
  if (!gate.ok) return { ok: false, conflict: `摘补丁后语法检查没过（已保持原样）：${gate.detail}`, file };
  fs.writeFileSync(file, text, 'utf8');
  clearState(root);
  return { ok: true, reverted: true, file };
}

/**
 * 补丁打在磁盘上，而当前进程早就把 src/app.js 加载进内存了 —— 这次启动吃不到。
 * 与其让用户自己去关掉软件重开，不如自己重开一次（用户要的"当场生效"）。
 *
 * 调用方必须自己防重启循环：只在"刚打完补丁"时调，并靠 .restart-pending 标记
 * 保证同一个坑只重启一次。
 */
export async function requestRestart({ delayMs = 1500 } = {}) {
  let app = null;
  try {
    ({ app } = await import('electron'));
  } catch {
    return { ok: false, reason: '当前不是 Electron 主进程（多半是用 node 直接跑的），没法自动重启' };
  }
  if (!app?.relaunch) return { ok: false, reason: 'Electron 没有暴露 app.relaunch' };
  const t = setTimeout(() => {
    try { app.relaunch(); app.exit(0); } catch { /* 重启失败就让用户手工重开 */ }
  }, delayMs);
  t.unref?.();
  return { ok: true };
}
