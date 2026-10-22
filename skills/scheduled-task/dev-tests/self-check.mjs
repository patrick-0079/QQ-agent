// 离线自检：不启动应用、不联网，只验这个技能自己的逻辑。
//
//   node skills/scheduled-task/dev-tests/self-check.mjs
//
// 覆盖三块容易写错、又看不出错的地方：
//   1. 时间：跨天/跨周/周期推进（算错就是"提醒晚了一天"这种最难查的毛病）
//   2. 存储：落盘/到点/结束/上限计数
//   3. 宿主补丁：打 → 幂等 → 摘 → 逐字节还原；锚点不对时宁可不打

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { parseHHMM, parseAtTime, planSchedule, nextDueAfter, formatDue, describeRepeat, nextWeeklyFrom } from '../lib/time.mjs';
import { TaskStore } from '../lib/store.mjs';
import { hostPatchStatus, applyHostPatch, revertHostPatch } from '../host-patch.mjs';
import { setup, activate, deactivate, hooks, internals } from '../index.js';

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}\n       ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}\n       ${error?.stack ?? error?.message ?? error}`);
    process.exitCode = 1;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-task-check-'));
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

// ⚠️ 这个自检跑在应用自己的目录里。不把补丁根指到别处的话，下面那个"拿不到编排器"
// 的用例会真的去改当前项目的 src/app.js —— 检查工具不该有副作用。
process.env.SCHEDULED_TASK_ROOT = path.join(tmp, 'no-such-host');

// 假的 skill api：自检只关心技能自己的逻辑，不碰真实注册表。
const tools = {};
setup({
  registerTool: (def) => { tools[def.id] = def; },
  config: () => ({}),
  log: () => {},
  warn: (...a) => console.log('   [warn]', ...a),
  error: () => {}
});

console.log('时间');

check('parseHHMM 认 "8:05"、拒 "25:00"', () => {
  assert.deepEqual(parseHHMM('8:05'), { h: 8, m: 5 });
  assert.equal(parseHHMM('25:00'), null);
  assert.equal(parseHHMM(''), null);
});

check('parseAtTime 只给 HH:MM 时，过了今天就用明天', () => {
  const now = at(2026, 9, 29, 10, 0);
  assert.equal(parseAtTime('18:30', now), at(2026, 9, 29, 18, 30));
  assert.equal(parseAtTime('08:00', now), at(2026, 9, 30, 8, 0));
  assert.equal(parseAtTime('2026-10-01 07:15', now), at(2026, 10, 1, 7, 15));
  assert.equal(parseAtTime('明天早上', now), null);
});

check('planSchedule：一次性 delayMinutes', () => {
  const now = at(2026, 9, 29, 10, 0);
  const p = planSchedule({ delayMinutes: 10 }, now);
  assert.equal(p.repeat, 'once');
  assert.equal(p.dueAt, now + 10 * 60000);
});

check('planSchedule：每天用 atTime 的时:分，今天过了就排到明天', () => {
  const now = at(2026, 9, 29, 10, 0);
  const today = planSchedule({ repeat: 'daily', atTime: '18:00' }, now);
  assert.equal(today.dueAt, at(2026, 9, 29, 18, 0));
  const tomorrow = planSchedule({ repeat: 'daily', atTime: '08:00' }, now);
  assert.equal(tomorrow.dueAt, at(2026, 9, 30, 8, 0));
  assert.equal(tomorrow.repeat, 'daily');
});

// 2026-09-29 是周二
check('planSchedule：每周挑最近的匹配日（周二设"周一/周四"→ 周四）', () => {
  const now = at(2026, 9, 29, 10, 0);
  const p = planSchedule({ repeat: 'weekly', atTime: '09:00', weekdays: [1, 4] }, now);
  assert.equal(new Date(p.dueAt).getDay(), 4);   // 周四
  assert.equal(p.dueAt, at(2026, 10, 1, 9, 0));
  // 当天就有匹配日、但时间已过 → 顺延到下周同一天
  const late = planSchedule({ repeat: 'weekly', atTime: '09:00', weekdays: [2] }, now);
  assert.equal(late.dueAt, at(2026, 10, 6, 9, 0));
});

check('planSchedule：每周缺 weekdays、周期间隔太密都要报错', () => {
  const now = at(2026, 9, 29, 10, 0);
  assert.match(planSchedule({ repeat: 'weekly', atTime: '09:00' }, now).error, /weekdays/);
  assert.match(planSchedule({ repeat: 'interval', intervalMinutes: 1 }, now, { minIntervalMinutes: 5 }).error, /最小间隔/);
  assert.match(planSchedule({ repeat: '乱写', atTime: '09:00' }, now).error, /repeat/);
  assert.match(planSchedule({}, now).error, /delayMinutes/);
});

check('nextDueAfter：周期任务从"现在"往后推，不补历史批次', () => {
  const task = { repeat: 'interval', intervalMinutes: 30, dueAt: at(2026, 9, 29, 8, 0) };
  // 停机三天后起来：下一次必须是未来，而不是把错过的 100 多次都补一遍
  const next = nextDueAfter(task, at(2026, 9, 30, 10, 20));
  assert.equal(next, at(2026, 9, 30, 10, 30));
  assert.equal(nextDueAfter({ repeat: 'once' }, Date.now()), null);
  assert.equal(nextDueAfter({ repeat: 'daily', timeOfDay: { h: 8, m: 0 }, dueAt: 0 }, at(2026, 9, 29, 10, 0)), at(2026, 9, 30, 8, 0));
});

check('nextWeeklyFrom 在夏令时切日那天不会跳过一个日历日', () => {
  // 用本机时区跑：这里只要求"一周内一定有一个结果，且落在指定星期"
  const from = at(2026, 3, 7, 12, 0);
  const t = nextWeeklyFrom([1, 2, 3, 4, 5, 6, 7], { h: 9, m: 0 }, from);
  assert.ok(t > from && t - from <= 8 * 24 * 3600_000, `实际 ${new Date(t).toString()}`);
});

check('formatDue / describeRepeat 说人话', () => {
  const now = at(2026, 9, 29, 10, 0);
  assert.equal(formatDue(at(2026, 9, 29, 18, 30), now), '18:30');
  assert.equal(formatDue(at(2026, 9, 30, 8, 0), now), '明天 08:00');
  assert.equal(formatDue(at(2026, 10, 3, 8, 0), now), '10月3日 08:00');
  assert.equal(describeRepeat({ repeat: 'weekly', weekdays: [1, 3], timeOfDay: { h: 8, m: 0 } }), '每周一、周三 08:00');
});

console.log('存储');

const storeFile = path.join(tmp, 'scheduled-tasks.json');

check('落盘 → 重新打开还在；到点取出来；触发后一次性任务结束', () => {
  const s = new TaskStore(storeFile);
  const now = at(2026, 9, 29, 10, 0);
  const a = s.add({ chatKey: 'group:123', text: '提醒吃药', dueAt: now - 1000, repeat: 'once', createdBy: '42' });
  const b = s.add({ chatKey: 'group:123', text: '每天早安', dueAt: now + 3600_000, repeat: 'daily', timeOfDay: { h: 8, m: 0 }, createdBy: '7' });
  assert.equal(s.due(now).length, 1);
  assert.equal(s.pending('group:123').length, 2);

  const reopened = new TaskStore(storeFile);
  assert.equal(reopened.all().length, 2);

  reopened.markFired(a.id, nextDueAfter(a, now));
  assert.equal(reopened.byId(a.id).done, true);
  reopened.markFired(b.id, nextDueAfter(b, now));
  assert.equal(reopened.byId(b.id).done, false);
  assert.ok(reopened.byId(b.id).dueAt > now);
  assert.equal(reopened.byId(b.id).firedCount, 1);
});

check('上限计数按会话 / 按人分别算', () => {
  const s = new TaskStore(path.join(tmp, 'counts.json'));
  const now = Date.now();
  s.add({ chatKey: 'group:1', text: 'a', dueAt: now + 1000, createdBy: '7' });
  s.add({ chatKey: 'group:1', text: 'b', dueAt: now + 1000, createdBy: '7' });
  s.add({ chatKey: 'group:1', text: 'c', dueAt: now + 1000, createdBy: '9' });
  s.add({ chatKey: 'group:2', text: 'd', dueAt: now + 1000, createdBy: '7' });
  assert.equal(s.countIn('group:1'), 3);
  assert.equal(s.countByUser('group:1', '7'), 2);
  assert.equal(s.countByUser('group:2', '7'), 1);
});

check('remove 删得掉，prune 只留最近的已结束任务', () => {
  const s = new TaskStore(path.join(tmp, 'prune.json'));
  const now = Date.now();
  const keep = s.add({ chatKey: 'group:1', text: '留着', dueAt: now + 1000, createdBy: '1' });
  const gone = s.add({ chatKey: 'group:1', text: '删掉', dueAt: now + 1000, createdBy: '1' });
  assert.equal(s.remove(gone.id), true);
  assert.equal(s.remove('t_不存在'), false);

  for (let i = 0; i < 12; i++) {
    const t = s.add({ chatKey: 'group:1', text: `完成 ${i}`, dueAt: now + 1000, createdBy: '1' });
    s.markFired(t.id, null);
  }
  assert.equal(s.prune(5), true);
  assert.equal(s.all().filter((t) => t.done).length, 5);
  assert.ok(s.byId(keep.id), '没结束的任务不该被清掉');
});

console.log('工具（模型看到的那一面）');

await checkAsync('排任务：空文本/超长文本/时间写错都要当场报错', async () => {
  const dataRoot = path.join(tmp, 'tools-data-1');
  activate({ config: { dataDir: dataRoot } });
  const ctx = { chatKey: 'group:777', kind: 'group', selfId: '999', session: { trigger: [{ senderId: '42', senderName: '小林' }] } };

  assert.deepEqual(Object.keys(tools).sort(), ['cancel_scheduled_task', 'list_scheduled_tasks', 'schedule_task']);
  assert.equal((await tools.schedule_task.execute(ctx, { text: '   ' })).isError, true);
  assert.equal((await tools.schedule_task.execute(ctx, { text: 'x'.repeat(900) })).isError, true);
  assert.match((await tools.schedule_task.execute(ctx, { text: '提醒喝水' })).content, /delayMinutes/);
  assert.match((await tools.schedule_task.execute(ctx, { text: '提醒喝水', delayMinutes: -1 })).content, /delayMinutes/);
  assert.match((await tools.schedule_task.execute(ctx, { text: '提醒喝水', atTime: '昨天' })).content, /格式/);
  assert.match((await tools.schedule_task.execute(ctx, { text: '提醒喝水', repeat: 'weekly', atTime: '09:00' })).content, /weekdays/);
  deactivate({ reason: 'reload' });
});

await checkAsync('排任务：落盘、能在列表里看见、到上限就拒绝', async () => {
  const dataRoot = path.join(tmp, 'tools-data-2');
  activate({ config: { dataDir: dataRoot } });
  const ctx = { chatKey: 'group:777', kind: 'group', selfId: '999', session: { trigger: [{ senderId: '42', senderName: '小林' }] } };

  const first = await tools.schedule_task.execute(ctx, { text: '提醒小林吃药', delayMinutes: 30 });
  assert.equal(first.isError, undefined);
  assert.match(first.content, /"set": true/);
  const id = JSON.parse(first.content).id;

  // 同一人最多 3 条（manifest settings 的默认值）
  await tools.schedule_task.execute(ctx, { text: '第二条', delayMinutes: 30 });
  await tools.schedule_task.execute(ctx, { text: '第三条', delayMinutes: 30 });
  const fourth = await tools.schedule_task.execute(ctx, { text: '第四条', delayMinutes: 30 });
  assert.equal(fourth.isError, true);
  assert.match(fourth.content, /上限/);

  const listed = await tools.list_scheduled_tasks.execute(ctx, {});
  assert.match(listed.content, /还有 3 条/);
  assert.match(listed.content, /提醒小林吃药/);
  assert.match(listed.content, /你设的/);

  // 别人设的任务：不认识的人删不掉，说清楚是主人就能删
  const other = { ...ctx, session: { trigger: [{ senderId: '77', senderName: '路人' }] } };
  const denied = await tools.cancel_scheduled_task.execute(other, { id });
  assert.equal(denied.isError, true);
  assert.match(denied.content, /不是你设的/);
  const byOwner = await tools.cancel_scheduled_task.execute(other, { id, asOwner: true });
  assert.equal(byOwner.isError, undefined);
  assert.match(byOwner.content, /已取消/);

  assert.equal((await tools.cancel_scheduled_task.execute(ctx, { id: 't_没有这个' })).isError, true);
  assert.equal((await tools.schedule_task.execute({ ...ctx, chatKey: '' }, { text: '没会话', delayMinutes: 5 })).isError, true);
  deactivate({ reason: 'reload' });
});

console.log('宿主补丁');

// 造一个"0.4.0 这类宿主"的最小现场：结构对上就够了，不需要真能跑起来。
const fixtureRoot = path.join(tmp, 'host');
fs.mkdirSync(path.join(fixtureRoot, 'src'), { recursive: true });
const ORIGINAL = [
  'export function createApp({ log = console.log } = {}) {',
  '  const store = {};',
  '  const reminders = {};',
  '  const orchestrator = new Orchestrator({ store, reminders });',
  '',
  '  async function reloadSkills() {',
  '    for (const st of skillManager.list()) {',
  '      if (st.enabled && st.loaded) {',
  '        try { skillManager.activate(st.id); } catch (error) { log(`失败：${error?.message ?? error}`); }',
  '      }',
  '    }',
  '  }',
  '  return { orchestrator, reloadSkills };',
  '}',
  ''
].join('\n');
const appFile = path.join(fixtureRoot, 'src', 'app.js');
fs.writeFileSync(appFile, ORIGINAL, 'utf8');

check('打补丁：插辅助函数 + 给调用点补上下文参数', () => {
  const st = hostPatchStatus({ root: fixtureRoot });
  assert.equal(st.supported, true, st.reason);
  assert.equal(st.applied, false);
  const r = applyHostPatch({ root: fixtureRoot });
  assert.equal(r.ok, true, r.conflict);
  const text = fs.readFileSync(appFile, 'utf8');
  assert.match(text, /\[\[scheduled-task:host-context\]\]/);
  assert.match(text, /\[\[scheduled-task:activate-context\]\]/);
  assert.match(text, /skillManager\.activate\(st\.id, __scheduledTaskHostContext\(\)\)/);
  assert.match(text, /function __scheduledTaskHostContext\(\)/);
  assert.equal(hostPatchStatus({ root: fixtureRoot }).applied, true);
});

check('打补丁是幂等的：第二次调用不重复插', () => {
  const r = applyHostPatch({ root: fixtureRoot });
  assert.equal(r.alreadyApplied, true);
  const text = fs.readFileSync(appFile, 'utf8');
  assert.equal(text.match(/\[\[scheduled-task:host-context\]\]/g).length, 1);
});

check('摘补丁：逐字节还原成原文件', () => {
  const r = revertHostPatch({ root: fixtureRoot });
  assert.equal(r.reverted, true);
  assert.equal(fs.readFileSync(appFile, 'utf8'), ORIGINAL);
  assert.equal(hostPatchStatus({ root: fixtureRoot }).applied, false);
});

check('锚点不对时宁可不打（报 conflict，一个字节都不写）', () => {
  const weird = path.join(tmp, 'weird');
  fs.mkdirSync(path.join(weird, 'src'), { recursive: true });
  const weirdFile = path.join(weird, 'src', 'app.js');
  fs.writeFileSync(weirdFile, 'export const nothing = 1;\n', 'utf8');
  const st = hostPatchStatus({ root: weird });
  assert.equal(st.supported, false);
  const r = applyHostPatch({ root: weird });
  assert.equal(r.ok, false);
  assert.equal(fs.readFileSync(weirdFile, 'utf8'), 'export const nothing = 1;\n');
});

check('调用点不止一处时也不打（改错地方比不改更糟）', () => {
  const many = path.join(tmp, 'many');
  fs.mkdirSync(path.join(many, 'src'), { recursive: true });
  fs.writeFileSync(path.join(many, 'src', 'app.js'), [
    'const orchestrator = new Orchestrator({});',
    'skillManager.activate(st.id);',
    'skillManager.activate(other.id);',
    ''
  ].join('\n'), 'utf8');
  assert.equal(hostPatchStatus({ root: many }).supported, false);
  assert.equal(applyHostPatch({ root: many }).ok, false);
});

// 上游加注释、挪位置是家常便饭，这几种都该照打不误。
check('上下游加了注释/空行/无关代码，照样命中', () => {
  const moved = path.join(tmp, 'moved');
  fs.mkdirSync(path.join(moved, 'src'), { recursive: true });
  const withComments = ORIGINAL
    .replace('  const orchestrator = new Orchestrator({ store, reminders });',
      '  // 2026-10 上游加的一句解释\n  // 再来一行\n\n  const orchestrator = new Orchestrator({ store, reminders });')
    .replace('        try { skillManager.activate(st.id); }',
      '        // 顺手加个注释\n        try { skillManager.activate(st.id); }');
  const file = path.join(moved, 'src', 'app.js');
  fs.writeFileSync(file, withComments, 'utf8');

  assert.equal(hostPatchStatus({ root: moved }).supported, true);
  assert.equal(applyHostPatch({ root: moved }).ok, true);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /skillManager\.activate\(st\.id, __scheduledTaskHostContext\(\)\)/);
  assert.equal(revertHostPatch({ root: moved }).reverted, true);
  assert.equal(fs.readFileSync(file, 'utf8'), withComments, '有注释时也该逐字节还原');
});

// 这条是这一版特意补的口子：上游把构造改成跨行写法后，锚点仍会命中第一行，
// 但插进去会落进调用的参数中间 —— 要求"整句结尾"就不会挑到半截，改用下一个候选。
check('构造被改成跨行写法时，不挑那一行，改用备用锚点', () => {
  const multiline = path.join(tmp, 'multiline');
  fs.mkdirSync(path.join(multiline, 'src'), { recursive: true });
  const file = path.join(multiline, 'src', 'app.js');
  fs.writeFileSync(file, [
    'export function createApp() {',
    '  const orchestrator = new Orchestrator({',
    '    store,',
    '    reminders',
    '  });',
    '',
    '  async function reloadSkills() {',
    '    try { skillManager.activate(st.id); } catch (error) { log(error); }',
    '  }',
    '  return { orchestrator };',
    '}',
    ''
  ].join('\n'), 'utf8');

  assert.equal(hostPatchStatus({ root: multiline }).supported, true);
  assert.equal(applyHostPatch({ root: multiline }).ok, true);
  const text = fs.readFileSync(file, 'utf8');
  // 辅助函数必须落在 reloadSkills 之后（作用域内、且没插进参数中间）
  assert.ok(text.indexOf('function __scheduledTaskHostContext') > text.indexOf('async function reloadSkills'), text);
  assert.match(text, /skillManager\.activate\(st\.id, __scheduledTaskHostContext\(\)\)/);
  assert.equal(revertHostPatch({ root: multiline }).reverted, true);
});

console.log('唤醒说明');

check('说明里带着原话与时间，并且点明"这是你当时答应的"', () => {
  const block = internals.buildInjection({ text: '提醒群友该吃药了', dueAt: at(2026, 9, 29, 18, 30), createdByName: '小林', createdBy: '42' });
  assert.match(block, /【定时任务】（18:30）/);
  assert.match(block, /小林（QQ:42）/);
  assert.match(block, /提醒群友该吃药了/);
  assert.match(block, /当时要求说明的事项/);
  const late = internals.buildInjection({ text: 'x', dueAt: at(2026, 9, 29, 18, 30) }, { late: true });
  assert.match(late, /延迟触发/);
});

check('只认主动唤醒的那一轮，正常消息驱动的轮次不插手', () => {
  assert.equal(internals.looksLikeProactiveTurn({ proactive: true }), true);
  assert.equal(internals.looksLikeProactiveTurn({ session: { trigger: [] } }), true);
  assert.equal(internals.looksLikeProactiveTurn({ session: { trigger: [{ text: '在吗' }] } }), false);
  assert.equal(internals.looksLikeProactiveTurn({ session: { triggerSummary: '主动机会（冷场开话题）' } }), true);
  assert.equal(internals.looksLikeProactiveTurn({}), false);
});

console.log('整条链路（假宿主）');

// 这一段把技能当成真的在应用里跑：activate 拿到假宿主 → 到点 → wake → 钩子注入。
// 真正难查的 bug 都在这一段（wake 参数、注入时机、失败重试、触发后才改状态）。
await checkAsync('到点会唤醒编排器，并把说明注入那一轮的消息里', async () => {
  const dataRoot = path.join(tmp, 'flow-data');
  const calls = [];
  const sent = [];
  const host = {
    orchestrator: { wake: async (chatKey, opts) => { calls.push({ chatKey, opts }); return true; } },
    sender: { sendTextBatch: async (chatKey, texts) => { sent.push({ chatKey, texts }); return { sent: texts.map((t) => ({ text: t })) }; } },
    config: { dataDir: dataRoot, get: () => ({}), patch: () => {} }
  };

  const now = Date.now();
  const st = new TaskStore(path.join(dataRoot, 'scheduled-tasks.json'));
  st.add({ chatKey: 'group:555', text: '提醒大家喝水', dueAt: now - 1000, repeat: 'once', createdBy: '42', createdByName: '小林' });
  st.add({ chatKey: 'group:555', text: '每天早安', dueAt: now - 1000, repeat: 'daily', timeOfDay: { h: 8, m: 0 }, createdBy: '42' });

  activate(host);
  await internals.tick();

  assert.equal(calls.length, 2, '两个到点任务都该唤醒');
  assert.equal(calls[0].chatKey, 'group:555');
  assert.equal(calls[0].opts.proactive, true);
  assert.equal(calls[0].opts.proactiveReason, 'scheduled-task');
  assert.equal(sent.length, 0, '有编排器就不该退化发文本');

  // 唤醒之后，那一轮的模型消息里应该出现说明（模拟核心调钩子）
  const messages = [{ role: 'system', content: '你是…' }, { role: 'user', content: '【过去状态】…' }];
  hooks['before-llm-messages']({ chatKey: 'group:555', session: { trigger: [] }, messages });
  assert.match(messages[1].content, /【定时任务】/);
  assert.match(messages[1].content, /提醒大家喝水|每天早安/);

  // 真人消息驱动的那一轮不该被注入
  const other = [{ role: 'user', content: '在吗' }];
  hooks['before-llm-messages']({ chatKey: 'group:555', session: { trigger: [{ text: '在吗' }] }, messages: other });
  assert.equal(other[0].content, '在吗');

  // 触发过的：一次性任务结束，每天的算到下一次
  const after = new TaskStore(path.join(dataRoot, 'scheduled-tasks.json'));
  const pending = after.pending('group:555');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].text, '每天早安');
  assert.ok(pending[0].dueAt > now);

  // 第二次 tick 不该重复触发（已经不在 due 里）
  calls.length = 0;
  await internals.tick();
  assert.equal(calls.length, 0);

  deactivate({ reason: 'reload' });   // 热重载：只停表，不动补丁
});

await checkAsync('拿不到编排器时，退化成发一条文本', async () => {
  const dataRoot = path.join(tmp, 'flow-data-2');
  const sent = [];
  const st = new TaskStore(path.join(dataRoot, 'scheduled-tasks.json'));
  st.add({ chatKey: 'private:9', text: '该吃药了', dueAt: Date.now() - 1000, repeat: 'once', createdBy: '9' });

  activate({ sender: { sendTextBatch: async (chatKey, texts) => { sent.push({ chatKey, texts }); return { sent: [] }; } }, config: { dataDir: dataRoot } });
  await internals.tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0].texts[0], /到点了|该吃药了/);
  assert.match(sent[0].texts[0], /该吃药了/);
  deactivate({});
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} 项通过${process.exitCode ? '（有失败）' : '，没有失败'}`);
