// 与真实「货币系统」插件的端到端联调：直接调用真插件的 provider，
// 数据全部写在临时目录（QQ_AGENT_DATA_DIR），不动真实账本。
// 运行：node livetest.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-live-'));
process.env.QQ_AGENT_DATA_DIR = tmp;

// 本插件在 plugins/daily-checkin/，同级就是其它插件，不写死盘符。
const pluginsRoot = path.resolve(import.meta.dirname, '..');
const load = (p) => import(pathToFileURL(path.join(pluginsRoot, p)).href);

const currency = await load('currency/index.js');
const checkin = await load('daily-checkin/index.js');

// 货币系统读的是宿主配置：这里就是货币插件设置页里那两个字段。
const currencyConfig = {
  currencyName: '金币',
  ownerQq: '',
  transfersEnabled: true,
  // audit 只是本脚本用来直接读账的假 consumer。
  integrationPermissions: '{"daily-checkin":["credit"],"audit":["transfer"]}'
};
let currencyActive = true;
const currencyApi = {
  config: () => currencyConfig,
  isSkillActive: (id) => (id === 'currency' ? currencyActive : true),
  registerTool: () => 'currency__x',
  log: () => {}, warn: () => {}, error: () => {}
};
currency.setup(currencyApi);
currency.activate();

let tool = null;
const checkinConfig = {
  triggerWords: '签到', baseReward: 10, streakBonus: 2, maxStreakBonus: 30, firstBonus: 0, timeZone: 'Asia/Shanghai'
};
const checkinApi = {
  config: () => checkinConfig,
  registerTool: (def) => { tool = def; return 'daily-checkin__checkin'; },
  isSkillActive: (id) => (id === 'daily-checkin' ? true : id === 'currency' ? currencyActive : true),
  capability: (name, args) => currency.providers[name]?.(args),
  log: () => {}, warn: () => {}, error: () => {}
};
checkin.setup(checkinApi);

const call = async (ctx, args = { action: 'checkin' }) => {
  const raw = await tool.execute(ctx, args);
  const text = String(raw.content);
  const first = text.split('\n')[0];
  if (first.trim().startsWith('{')) return JSON.parse(first);
  const m = /^签到没有完成（([A-Z_]+)）：([\s\S]*)$/.exec(text);
  return { error: { code: m ? m[1] : 'UNKNOWN', message: m ? m[2] : text } };
};
const at = (iso) => Date.parse(iso);
const ctxFor = (senderId) => ({
  chatKey: 'group:881694249', kind: 'group', chatId: '881694249', selfId: '10000',
  session: { id: 's', status: 'running', trigger: [{ id: 1, senderId, text: '签到', ts: Date.now() }] }
});

let pass = 0, fails = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? pass++ : fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: 实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
};

// 直接从真实货币系统的账本读余额，验证“工具说的话”与“账本真的变了”一致
const money = currency.providers['currency.v1']({ consumer: 'audit' });
const rawBalance = (userId) => money.balance({ scope: 'group:881694249', userId }).balance;

const realNow = Date.now;
Date.now = () => at('2026-10-12T09:00:00+08:00');
let r = await call(ctxFor('3342377964'));
check('真实账本：签到到账', rawBalance('3342377964'), 10);
check('工具回报余额与账本一致', r.balance, 10);
check('首次连签=1', r.streak, 1);
check('货币名来自货币插件', r.currencyName, '金币');

r = await call(ctxFor('3342377964'));
check('重复签到不再发币（账本）', rawBalance('3342377964'), 10);
check('重复签到标记', r.alreadyCheckedInToday, true);
check('重复签到回报首次奖励', r.reward, 10);

Date.now = () => at('2026-10-13T09:00:00+08:00');
r = await call(ctxFor('3342377964'));
check('连续第 2 天到账 +12', rawBalance('3342377964'), 22);
check('连续第 2 天连签', r.streak, 2);

Date.now = () => at('2026-10-14T09:00:00+08:00');
r = await call(ctxFor('3342377964'));
check('连续第 3 天到账 +14', rawBalance('3342377964'), 36);

// 转账是货币系统自带的能力：确认与签到共用同一本账
const transfer = money.transfer({ scope: 'group:881694249', fromUserId: '3342377964', toUserId: '20001', amount: 5, requestId: 'audit:1', reason: '测试转账' });
check('货币系统转账成功', transfer.ok, true);
check('签到账户扣款后余额', rawBalance('3342377964'), 31);
check('收款方余额（与签到同一本账）', rawBalance('20001'), 5);

// 授权被取消后必须拒绝，且账本不能被改动
currencyConfig.integrationPermissions = '{}';
Date.now = () => at('2026-10-15T09:00:00+08:00');
r = await call(ctxFor('3342377964'));
check('取消授权后拒绝发币', r.error?.code, 'FORBIDDEN');
check('拒绝时账本未变', rawBalance('3342377964'), 31);
currencyConfig.integrationPermissions = '{"daily-checkin":["credit"]}';

// 货币系统被停用 → 给出可读提示，而不是崩
currency.deactivate();
currencyActive = false;
Date.now = () => at('2026-10-16T09:00:00+08:00');
r = await call(ctxFor('3342377964'));
check('货币系统停用时给出可读提示', /金币系统/.test(r.error?.message || ''), true);
currencyActive = true;

Date.now = realNow;
console.log(`\n真实联调结果：${pass} 通过 / ${fails} 失败`);
console.log('隔离数据目录内容:', fs.readdirSync(tmp).join(', ') || '（空）');
fs.rmSync(tmp, { recursive: true, force: true });
console.log('已清理:', tmp);
console.log('真实账本 currency.json:', fs.existsSync(path.resolve(import.meta.dirname, '../../../data/currency.json')) ? '存在' : '不存在');
process.exit(fails ? 1 : 0);
