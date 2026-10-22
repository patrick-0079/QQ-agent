// 自测：用假的 api 和假的货币能力跑一遍签到逻辑，不碰真实账本。
// 运行：node selftest.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-'));
process.env.QQ_AGENT_DATA_DIR = tmp;

const mod = await import(pathToFileURL(path.join(import.meta.dirname, 'index.js')).href);

// ── 假货币能力 ──────────────────────────────────────────────────────────────
const ledger = { balances: new Map(), receipts: new Map(), credits: 0 };
let permission = true;
const wallet = {
  apiVersion: 1,
  balances: ledger.balances,
  get credits() { return ledger.credits; },
  info: () => ({ apiVersion: 1, currencyName: '金币' }),
  balance: ({ scope, userId }) => ({ ok: true, balance: ledger.balances.get(`${scope}/${userId}`) || 0, held: 0, available: ledger.balances.get(`${scope}/${userId}`) || 0, currencyName: '金币' }),
  credit: ({ scope, userId, amount, requestId, reason }) => {
    if (!permission) return { ok: false, code: 'FORBIDDEN', message: '扩展 daily-checkin 未获 credit 权限' };
    const key = `${scope}/${userId}/${requestId}`;
    if (ledger.receipts.has(key)) return { ok: true, currencyName: '金币', receipt: { ...ledger.receipts.get(key), replayed: true } };
    ledger.balances.set(`${scope}/${userId}`, (ledger.balances.get(`${scope}/${userId}`) || 0) + amount);
    ledger.credits += 1;
    const receipt = { id: `r${ledger.credits}`, sequence: ledger.credits, amount, requestId, reason, replayed: false };
    ledger.receipts.set(key, receipt);
    return { ok: true, currencyName: '金币', receipt: { ...receipt } };
  }
};

// ── 假 api ──────────────────────────────────────────────────────────────────
let tool = null;
const api = {
  config: () => ({ triggerWords: '签到\n打卡', baseReward: 10, streakBonus: 2, maxStreakBonus: 30, firstBonus: 0, timeZone: 'Asia/Shanghai' }),
  registerTool: (def) => { tool = def; return 'daily-checkin__checkin'; },
  isSkillActive: () => true,
  capability: (name) => (name === 'currency.v1' ? wallet : undefined),
  log: () => {}, warn: () => {}, error: () => {}
};

mod.setup(api);

console.log('可行（available）:', JSON.stringify(mod.available()));
console.log('注册的工具名:', tool?.id, '| 分类:', tool?.category);

const ctxFor = (senderId, chatId = '881694249') => ({
  chatKey: `group:${chatId}`, kind: 'group', chatId, selfId: '10000',
  session: { id: 's1', status: 'running', trigger: [{ id: 1, senderId, text: '签到', ts: Date.now() }] }
});

const call = async (ctx, args = { action: 'checkin' }) => {
  const raw = await tool.execute(ctx, args);
  const text = String(raw.content);
  const first = text.split('\n')[0];
  if (first.trim().startsWith('{')) return JSON.parse(first);
  // 失败分支是可读文案，形如：签到没有完成（CODE）：说明…
  const m = /^签到没有完成（([A-Z_]+)）：([\s\S]*)$/.exec(text);
  return { error: { code: m ? m[1] : 'UNKNOWN', message: m ? m[2] : text }, isError: raw.isError };
};

let pass = 0, failCount = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++; else failCount++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: 实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
};
const beijing = (iso) => Date.parse(iso);

// ① 首次签到
let r = await call(ctxFor('3342377964'));
check('首次签到发币', r.reward, 10);
check('首次签到连签=1', r.streak, 1);
check('首次签到余额', r.balance, 10);
check('首次签到已入账', r.rewardIssued, true);
check('首次签到重复标记', r.alreadyCheckedInToday, false);

// ② 同一天重复签到：不能重复发币
r = await call(ctxFor('3342377964'));
check('同日重复:不重复发币', r.rewardIssued, false);
check('同日重复:入账笔数', wallet.credits, 1);
check('同日重复:余额不变', r.balance, 10);

// ③ 防冒领：发言人必须是消息条目的真实发送者
const other = ctxFor('3342377964');
other.session.trigger = [{ id: 2, senderId: '20001', text: '签到', ts: Date.now() }];
r = await call(other);
check('以消息真实发送者记账（不是被引用的对象）', r.streak, 1);

const two = ctxFor('3342377964');
two.session.trigger = [
  { id: 3, senderId: '3342377964', text: '签到', ts: Date.now() },
  { id: 4, senderId: '20001', text: '我也签', ts: Date.now() }
];
r = await call(two);
check('两位发言人被拒', r.error?.code, 'AMBIGUOUS_REQUESTER');

const selfOnly = ctxFor('3342377964');
selfOnly.session.trigger = [{ id: 5, senderId: '10000', text: '签到', ts: Date.now(), self: true }];
r = await call(selfOnly);
check('只有机器人自己发言被拒', r.error?.code, 'INVALID_CONTEXT');

// ④ 没有发币权限（用一个全新的人，避免走到“今天已签到”分支）
permission = false;
Date.now = () => beijing('2026-10-12T09:00:00+08:00');
r = await call(ctxFor('20099'));
check('缺权限返回 FORBIDDEN 提示', r.error?.code, 'FORBIDDEN');
check('缺权限给的是可执行建议', /credit/.test(r.error?.message || ''), true);
permission = true;

// ⑤ 跨天连签：同一个人「30001」验证连签递增与断签重置
const realNow = Date.now;
const plan = [
  { t: '2026-10-12T09:00:00+08:00', streak: 1, reward: 10 },
  { t: '2026-10-13T09:00:00+08:00', streak: 2, reward: 12 },
  { t: '2026-10-14T09:00:00+08:00', streak: 3, reward: 14 },
  { t: '2026-10-17T09:00:00+08:00', streak: 1, reward: 10 }   // 断签重置
];
for (const step of plan) {
  Date.now = () => beijing(step.t);
  r = await call(ctxFor('30001'));
  check(`${step.t} 连签=${step.streak}`, r.streak, step.streak);
  check(`${step.t} 奖励=${step.reward}`, r.reward, step.reward);
}

// 逐日连签 + 加成封顶 + 断签后累计天数继续增长
Date.now = () => beijing('2026-10-12T09:00:00+08:00');
r = await call(ctxFor('40001')); check('连签第1天', r.streak, 1);
Date.now = () => beijing('2026-10-13T09:00:00+08:00');
r = await call(ctxFor('40001')); check('连签第2天', r.streak, 2);
Date.now = () => beijing('2026-10-14T09:00:00+08:00');
r = await call(ctxFor('40001')); check('连签第3天', r.streak, 3);
Date.now = () => beijing('2026-10-15T09:00:00+08:00');
r = await call(ctxFor('40001')); check('连签第4天奖励封顶', r.reward, 10 + Math.min(3 * 2, 30));
Date.now = () => beijing('2026-10-20T09:00:00+08:00'); // 断了 5 天
r = await call(ctxFor('40001')); check('断签后重置为1', r.streak, 1);
check('断签后累计天数仍增长', r.totalDays, 5);

// ⑥ 每个群的账互相独立；时区边界（用一个全新的人 50002）
Date.now = () => beijing('2026-10-12T09:00:00+08:00');
r = await call(ctxFor('50001', '111111111')); check('A群余额独立', r.balance, 10);
r = await call(ctxFor('50001', '222222222')); check('B群余额独立', r.balance, 10);
r = await call(ctxFor('50002')); check('跨零点前先签一次', r.streak, 1);
// 北京时间 10-13 00:30 = UTC 10-12 16:30：按 UTC 日期会错判成“今天已签到”
Date.now = () => beijing('2026-10-13T00:30:00+08:00');
r = await call(ctxFor('50002'));
check('北京时间跨零点判为新的一天', r.alreadyCheckedInToday, false);
check('北京时间跨零点连签+1', r.streak, 2);
check('跨零点按北京日期记账', r.date, '2026-10-13');

// ⑦ status 查询与参数校验（用 50002 —— 它在北京 10-13 00:30 签过到）
Date.now = () => beijing('2026-10-13T10:00:00+08:00');
r = await call(ctxFor('50002'), { action: 'status' });
check('status 已签到', r.checkedInToday, true);
check('status 带余额', r.balance > 0, true);
r = await call(ctxFor('50002'), { action: 'status', userId: '20001' });
check('status 不能查别人', r.error?.code, 'FORBIDDEN');
r = await call(ctxFor('50002'), { action: 'checkin', 谁: '20001' });
check('checkin 传未知参数被拒', r.error?.code, 'INVALID_ARGUMENT');
r = await call(ctxFor('50002'), { action: 'nonsense' });
check('非法 action 被拒', r.error?.code, 'INVALID_ARGUMENT');

// ⑧ 状态文件损坏 / 时区非法
Date.now = realNow;
const goodState = fs.readFileSync(path.join(tmp, 'daily-checkin.json'), 'utf8');
fs.writeFileSync(path.join(tmp, 'daily-checkin.json'), '{ 坏掉的 json', 'utf8');
mod.dispose();
check('数据文件损坏被检出', mod.available().ok, false);
fs.writeFileSync(path.join(tmp, 'daily-checkin.json'), goodState, 'utf8');
mod.dispose();
check('修好后自动恢复可用', mod.available(), true);

const badZoneApi = { ...api, config: () => ({ ...api.config(), timeZone: '不是时区' }) };
mod.setup(badZoneApi);
r = await call(ctxFor('60001'));
check('非法时区被拒且给出可读原因', r.error?.code, 'INVALID_CONFIG');
check('非法时区提示可读', /Asia\/Shanghai/.test(r.error?.message || ''), true);
check('非法时区不会让插件加载失败', typeof mod.available === 'function', true);

// ⑨ 提示词注入（钩子）
mod.setup(api);
const hookCtx = { sessionId: 's1', proactive: false, messages: [], triggerEntries: [{ id: 9, senderId: '70001', text: '我来签到了', ts: Date.now() }] };
mod.hooks['before-llm-messages'](hookCtx);
check('关键词命中注入一条任务提示', hookCtx.messages.length, 1);
check('提示里带了真实工具名', /daily-checkin__checkin/.test(hookCtx.messages[0]?.content || ''), true);
mod.hooks['before-llm-messages'](hookCtx);
check('同一会话不重复注入', hookCtx.messages.length, 1);
const quiet = { sessionId: 's2', proactive: false, messages: [], triggerEntries: [{ id: 10, senderId: '70001', text: '今天天气不错', ts: Date.now() }] };
mod.hooks['before-llm-messages'](quiet);
check('未命中关键词不注入', quiet.messages.length, 0);
const prompt = mod.promptSections();
check('常驻提示片段非空', prompt.length > 0 && prompt[0].content.length > 20, true);

console.log(`\n结果：${pass} 通过 / ${failCount} 失败`);
console.log('状态文件:', fs.existsSync(path.join(tmp, 'daily-checkin.json')) ? '已生成' : '未生成');
fs.rmSync(tmp, { recursive: true, force: true });
console.log('已清理临时目录:', tmp);
process.exit(failCount ? 1 : 0);
