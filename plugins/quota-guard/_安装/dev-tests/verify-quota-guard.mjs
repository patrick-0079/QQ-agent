/**
 * quota-guard 插件验证（一次性脚本，不属于项目）。
 *
 * 直接 import 落盘的插件模块本身，用真实调用顺序驱动它：
 *   before-context → after-response（可能多次） → chat.quota-gate
 * 并检查账本落盘、跨天重置、分摊精度、超额剔除。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ── 用临时数据目录跑，绝不碰用户真实的 data/ ──────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-test-'));
process.env.QQ_AGENT_DATA_DIR = TMP;

const APP = 'E:\\dsqqbot\\QQ Agent\\resources\\app';
const PLUGIN = path.join(APP, 'plugins/quota-guard/index.js');
const url = 'file:///' + PLUGIN.replace(/\\/g, '/').replace(/ /g, '%20');

// 插件用 import.meta 无法重定向 DATA_DIR，所以这里同时改环境变量并直接检查
// 插件写出的文件位置（插件 import 的是 ../../src/config.js 的 DATA_DIR）。
// config.js 的 DATA_DIR 读 process.env.QQ_AGENT_DATA_DIR，故上面先设好。
const qg = await import(url);

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const ok = (name, cond) => t(name, !!cond, true);

// ── 假的 api（模拟核心给插件的那个对象）────────────────────────────────
// config() 返回设置；核心会把 manifest.settings 合并进来，这里手动模拟。
let settings = { resetHour: 4, defaultDailyLimit: 0, perUser: {}, notifyOnBlock: false, notifyText: '' };
const api = { config: () => settings, log: () => {}, isSkillActive: () => true };

// 插件读的是**真 config**（src/skills/config.js 的 getSkillConfig），
// 所以测试必须通过同一套 API 写设置 —— 造假 api().config() 是没用的，
// 插件只在 UI 路径上用它，运行期一律现读配置。
const cfgMod = await import('file:///E:/dsqqbot/QQ%20Agent/resources/app/src/config.js');
const skMod = await import('file:///E:/dsqqbot/QQ%20Agent/resources/app/src/skills/config.js');
const LEDGER = path.join(cfgMod.DATA_DIR, 'quota-guard', 'ledger.json');
const readLedger = () => JSON.parse(fs.readFileSync(LEDGER, 'utf8'));

/** 造一条消息条目（形状与 store.appendIncoming 写进存档的一致）。 */
const msg = (senderId, senderName, text) => ({ id: Math.random(), senderId: String(senderId), senderName, text });

/**
 * 把账本清空到干净状态。
 *
 * ⚠️ 必须在每段测试**开始前**调用：插件按"每人每日累计"设计，账本是跨运行累加的
 *    （这正是它的功能）。不重置的话，上一段的用量会叠进下一段，断言就会算成
 *    "插件多记了账"——那是测试口径问题，不是缺陷。
 */
function resetLedger() {
  try { fs.rmSync(path.join(TMP, 'quota-guard'), { recursive: true, force: true }); } catch { /* 不存在就算了 */ }
  // 插件内部有内存缓存，重建实例才能真的读回空账
  return import(url + '?t=' + Date.now());
}
/** 每段测试独立的做法：重载模块 + 清账本 + 把设置写进真 config。 */
let QG = qg;
async function fresh(settingsOverride) {
  settings = { resetHour: 4, defaultDailyLimit: 0, perUser: {}, notifyOnBlock: false, notifyText: '', ...settingsOverride };
  skMod.setSkillConfig('quota-guard', settings);          // ← 与界面保存走同一条路
  QG = await resetLedger();
  QG.activate();
}
/** 用当前实例跑一整轮。 */
function run({ chatKey, sessionId, batch, calls, tier = 4 }) {
  const triggerEntries = [...batch];
  QG.hooks['before-context']({ ...api, chatKey, sessionId, triggerEntries, store: {}, memory: {} });
  const session = { id: sessionId, chatKey, usage: { totalTokens: 0 }, sent: [] };
  for (const u of calls) {
    session.usage.totalTokens += u;
    QG.hooks['after-response']({ ...api, response: { usage: { total_tokens: u, prompt_tokens: u - 10, completion_tokens: 10 } }, session });
  }
  const decision = QG.providers['chat.quota-gate']({ ...api, chatKey, triggerEntries, tier, willRespond: true });
  return { decision, triggerEntries };
}

console.log('── 1. 默认额度 0 = 不限：不拦人，但照样记账 ──');
await fresh({});
{
  const r = run({ chatKey: 'group:1', sessionId: 's1', batch: [msg(1001, '甲', 'a'), msg(1002, '乙', 'b')], calls: [1000] });
  t('不限时不拦截', r.decision, null);
  t('触发批原样保留', r.triggerEntries.length, 2);
  // 「不限」是额度口径，不是「不统计」——用量页要能看见谁在用
  const led = readLedger();
  t('不限也照样记账（各 500）', [led.users['1001'].used, led.users['1002'].used], [500, 500]);
}

console.log('\n── 2. 按发言条数分摊（权重）──');
await fresh({ perUser: { 1001: { limit: 100000 }, 1002: { limit: 100000 } } });
{
  // 甲说 3 条、乙说 1 条 → 权重 3/4 : 1/4；一次调用 4000 token
  run({
    chatKey: 'group:2', sessionId: 's2',
    batch: [msg(1001, '甲', 'a'), msg(1001, '甲', 'b'), msg(1001, '甲', 'c'), msg(1002, '乙', 'd')],
    calls: [4000]
  });
  const led = readLedger();
  const key = led.users['1001'].dayKey;
  t('甲拿到 3/4 = 3000', led.users['1001'].used, 3000);
  t('乙拿到 1/4 = 1000', led.users['1002'].used, 1000);
  t('分摊之和精确等于实际消耗', led.users['1001'].used + led.users['1002'].used, 4000);
  t('当日总计一致', led.totals[key], 4000);
}

console.log('\n── 3. 多次调用按次累加（不是按轮重复算累计值）──');
await fresh({ perUser: { 2001: { limit: 1000000 } } });
{
  // 三次调用：100 / 200 / 300 → 总计 600，全部归 2001
  run({ chatKey: 'group:3', sessionId: 's3', batch: [msg(2001, '丙', 'x')], calls: [100, 200, 300] });
  t('三次调用累加得到 600', readLedger().users['2001'].used, 600);
}

console.log('\n── 4. 精度：不能因为四舍五入丢 token ──');
await fresh({ perUser: { 3001: { limit: 1000000 }, 3002: { limit: 1000000 }, 3003: { limit: 1000000 } } });
{
  // 三人各 1 条 → 各 1/3；一次调用 1000 → 333.33 各。最大余额法应给出 334/333/333
  run({
    chatKey: 'group:4', sessionId: 's4',
    batch: [msg(3001, 'p', 'a'), msg(3002, 'q', 'b'), msg(3003, 'r', 'c')],
    calls: [1000]
  });
  const led = readLedger();
  const sum = led.users['3001'].used + led.users['3002'].used + led.users['3003'].used;
  t('三人分摊之和精确 = 1000（不丢不多）', sum, 1000);
  ok('三人的值都在合理范围（333/334）', [led.users['3001'].used, led.users['3002'].used, led.users['3003'].used].every((v) => v >= 333 && v <= 334));
}

console.log('\n── 5. 超额剔除：他的消息不进触发批，也不计他的账 ──');
await fresh({ perUser: { 4001: { limit: 500 }, 4002: { limit: 1000000 } } });
{
  // 先把 4001 用到超额
  run({ chatKey: 'group:5a', sessionId: 's5a', batch: [msg(4001, '超额者', 'x')], calls: [600] });
  t('4001 已被封顶在额度 500（不是 600）', readLedger().users['4001'].used, 500);

  // 再来一轮：4001 与 4002 都发言
  const r = run({
    chatKey: 'group:5b', sessionId: 's5b',
    batch: [msg(4001, '超额者', '还在说'), msg(4002, '正常者', '你好')],
    calls: [1000],
    tier: 4
  });
  t('超额者的消息被剔除，触发批只剩 1 条', r.triggerEntries.length, 1);
  t('剩下的是没超额的那个人', r.triggerEntries[0].senderId, '4002');
  t('还有人没超额 → 这一轮照常响应（不拦）', r.decision, null);
  const led = readLedger();
  t('超额者没有被继续计账', led.users['4001'].used, 500);
  t('这一轮的 1000 全记在没超额的人头上', led.users['4002'].used, 1000);
}

console.log('\n── 6. 全员超额 → 让核心跳过这一轮（零消耗）──');
await fresh({ perUser: { 5001: { limit: 100 }, 5002: { limit: 100 } } });
{
  const r = run({
    chatKey: 'group:6', sessionId: 's6',
    batch: [msg(5001, '甲', 'a'), msg(5002, '乙', 'b')],
    calls: [500],          // 500 分摊 → 各 250，都超过 100
    tier: 4
  });
  ok('给出 skip 决定', r.decision && r.decision.skip === true);
  ok('理由里点明了是额度问题', /额度/.test(r.decision?.reason || ''));
  ok('理由里带上了超额的人', /甲|乙/.test(r.decision?.reason || ''));
  const led = readLedger();
  t('超额后用量封顶在额度（不虚报）', led.users['5001'].used, 100);
  t('另一个同样封顶', led.users['5002'].used, 100);
}

console.log('\n── 7. 档位已决定不回时不插手 ──');
await fresh({ perUser: { 6001: { limit: 1 } } });
{
  run({ chatKey: 'group:7a', sessionId: 's7a', batch: [msg(6001, '甲', 'a')], calls: [10] });
  const d = QG.providers['chat.quota-gate']({
    ...api, chatKey: 'group:7b',
    triggerEntries: [msg(6001, '甲', 'a')], tier: 1, willRespond: false
  });
  t('willRespond=false 时返回 null（不越权）', d, null);
}

console.log('\n── 8. 主动机会（没人发言）不拦 ──');
{
  const d = QG.providers['chat.quota-gate']({ ...api, chatKey: 'group:8', triggerEntries: [], tier: 4, willRespond: true });
  t('空触发批 → 不拦', d, null);
}

console.log('\n── 9. 机器人自己的消息不计任何人的账 ──');
await fresh({ perUser: { 7001: { limit: 1000000 } } });
{
  run({
    chatKey: 'group:9', sessionId: 's9',
    batch: [msg(7001, '甲', 'a'), { id: 1, senderId: 'self', senderName: '机器人', text: '我自己说的', self: true }],
    calls: [800]
  });
  const led = readLedger();
  t('self 不参与分摊，全部 800 归真实发言人', led.users['7001'].used, 800);
  ok('账本里没有 self 这条', led.users['self'] === undefined);
}

console.log('\n── 10. 默认额度（没有单独设置的人）──');
await fresh({ defaultDailyLimit: 1000, perUser: { 8001: { limit: 0 } } });
{
  // 8001 显式设为 0 = 不限；8002 没设置 → 用默认 1000
  run({ chatKey: 'group:10a', sessionId: 's10a', batch: [msg(8002, '新人', 'a')], calls: [1500] });
  t('未单独设置的人用默认额度并封顶', readLedger().users['8002'].used, 1000);

  const r = run({ chatKey: 'group:10b', sessionId: 's10b', batch: [msg(8001, '不限者', 'a')], calls: [99999] });
  t('显式设为 0 的人不受默认额度约束', readLedger().users['8001'].used, 99999);
  t('不限的人不会被拦', r.decision, null);
}

console.log('\n── 11. 跨天自动重置（额度周期按 resetHour 切）──');
await fresh({ resetHour: 4, perUser: { 9001: { limit: 100 } } });
{
  run({ chatKey: 'group:11a', sessionId: 's11a', batch: [msg(9001, '甲', 'a')], calls: [100] });
  t('当天用满', readLedger().users['9001'].used, 100);

  // 把账本里的日期改成过去，模拟"额度周期已经翻篇"
  const led = readLedger();
  led.users['9001'].dayKey = '2000-01-01';
  fs.writeFileSync(LEDGER, JSON.stringify(led), 'utf8');
  // 插件有内存缓存：重载模块才能读到外部改动
  QG = await import(url + '?t=' + Date.now());
  const snap = await QG.handleUiRequest({ action: 'state' });
  const row = (snap.rows || []).find((x) => x.userId === '9001');
  t('旧周期的用量在新周期显示为 0', row.used, 0);
  ok('新周期里他还没超额', row.over === false);
}

console.log('\n── 12. UI 动作：设额度 / 清空 / 重置 ──');
await fresh({});
{
  // ⚠️ 测试进程里的 config.js 是**从磁盘加载后就常驻内存**的（真程序里
  //    updateConfig 会同步更新那份内存对象，所以没这个问题）。而这里的写入方
  //    是插件自己的 setSkillConfig，测试进程读到的仍是旧快照 —— 所以每次调用
  //    插件前先从磁盘重载一次，模拟"运行中的程序看到的永远是最新配置"。
  const call = async (body) => { cfgMod.loadConfig(); return QG.handleUiRequest(body); };

  let snap = await call({ action: 'state' });
  ok('state 返回结构完整', snap.ok && Array.isArray(snap.rows) && typeof snap.dayKey === 'string');

  snap = await call({ action: 'setLimit', payload: { userId: '123456', limit: 5000, name: '测试' } });
  ok('setLimit 后该用户出现在榜单', (snap.rows || []).some((r) => r.userId === '123456' && r.limit === 5000));

  snap = await call({ action: 'setLimit', payload: { userId: 'abc', limit: 1 } });
  t('非法 QQ 号被拒绝', snap.ok, false);

  snap = await call({ action: 'removeUser', payload: { userId: '123456' } });
  // 移除的是**额度**，不是他的用量记录（那行该留着，否则当天已烧掉的账就"看不见"了）
  {
    const row = (snap.rows || []).find((r) => r.userId === '123456');
    ok('removeUser 后额度回到"不限"', !row || row.limit === 0);
  }

  // 先制造点用量，再验证"清空"
  run({ chatKey: 'group:12', sessionId: 's12', batch: [msg(4242, '某人', 'hi')], calls: [1234] });
  snap = await call({ action: 'state' });
  ok('清空前确实有用量', snap.totalUsed > 0);
  snap = await call({ action: 'reset', payload: {} });
  // 今日用量与余额是同一个数：重置余额 = 把今日用量清零，两者一起归零。
  t('★ 清空后余额扣减量归零（余额回满）', snap.totalCharged, 0);
  ok('★ 今日用量作为事实保留（> 0）', snap.totalUsed > 0);

  snap = await call({ action: '不存在' });
  t('未知动作返回错误而不是崩', snap.ok, false);
}

console.log('\n── 13. 坏数据不能把插件搞崩 ──');
await fresh({});
{
  fs.mkdirSync(path.dirname(LEDGER), { recursive: true });
  fs.writeFileSync(LEDGER, '{ 这不是合法 JSON', 'utf8');
  QG = await import(url + '?t=' + Date.now());
  const snap = await QG.handleUiRequest({ action: 'state' });
  ok('账本损坏时仍能返回状态（从空账开始）', snap.ok === true);
}

console.log('\n── 14. 落盘位置 ──');
{
  QG = await resetLedger();
  QG.activate();
  run({ chatKey: 'group:14', sessionId: 's14', batch: [msg(9999, '甲', 'a')], calls: [10] });
  ok('账本写在 <DATA_DIR>/quota-guard/ledger.json', fs.existsSync(LEDGER));
  ok('没写过别的奇怪文件', fs.readdirSync(path.dirname(LEDGER)).every((f) => f === 'ledger.json' || f.endsWith('.tmp')));
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log('临时数据目录：' + TMP);
process.exit(fail ? 1 : 0);
