/**
 * 「重置额度用量」不破坏总消耗 —— 回归测试。
 *
 * 为什么值得单独测：重置是唯一会**主动改动账本**的操作，一旦写错就会把
 * 用户攒了很久的累计数据抹掉，而且很难发现（过一天才看出来）。
 * 这里把三条不变量钉死：
 *   ① 重置只影响"今天"，**总消耗一动不动**；
 *   ② 重置只影响指定的人，别人不受牵连；
 *   ③ 重置要**真的生效**（插件后装、账本里没这个人时也不能是空操作）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-reset-verify-'));
process.env.QQ_AGENT_DATA_DIR = TMP;
const QG = 'file:///E:/dsqqbot/QQ%20Agent/resources/app/plugins/quota-guard/index.js';
const cfgMod = await import('file:///E:/dsqqbot/QQ%20Agent/resources/app/src/config.js');
cfgMod.setRuntimeConfig(cfgMod.loadConfig());

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const ok = (n, c) => t(n, !!c, true);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SESS = path.join(TMP, 'sessions');
fs.mkdirSync(SESS, { recursive: true });
const msg = (id, n) => ({ id: Math.random(), senderId: String(id), senderName: n, text: 'x' });
const now = Date.now();
// 今天：甲 3 条 + 乙 1 条 = 4000（甲 3000 / 乙 1000）
fs.writeFileSync(path.join(SESS, 't1.json'), JSON.stringify({
  id: 't1', chatKey: 'group:1', startedAt: now,
  usage: { totalTokens: 4000, calls: 1 },
  trigger: [msg(9001, '甲'), msg(9001, '甲'), msg(9001, '甲'), msg(9002, '乙')]
}), 'utf8');
// 昨天：丙 2 条 = 8000（历史总消耗，重置绝不能碰）
fs.writeFileSync(path.join(SESS, 't2.json'), JSON.stringify({
  id: 't2', chatKey: 'group:1', startedAt: now - 30 * 3600 * 1000,
  usage: { totalTokens: 8000, calls: 1 },
  trigger: [msg(9003, '丙'), msg(9003, '丙')]
}), 'utf8');

let qg = await import(QG + '?t=' + Date.now());
const settle = async (mod = qg) => {
  let b = await mod.handleUiRequest({ action: 'cumulative' });
  for (let i = 0; i < 60 && (b.board.scan.running || b.board.scan.partial); i++) {
    await sleep(100);
    b = await mod.handleUiRequest({ action: 'cumulative' });
  }
  return b;
};
const state = () => qg.handleUiRequest({ action: 'state' });
const used = (st, qq) => (st.rows.find((r) => r.userId === qq) || {}).used;

await settle();
await qg.handleUiRequest({ action: 'setLimit', payload: { userId: '9001', limit: 100000 } });
await qg.handleUiRequest({ action: 'setLimit', payload: { userId: '9002', limit: 100000 } });

console.log('── 1. 起始状态 ──');
let st = await state();
t('今日合计 4000', st.todayTotal, 4000);
t('甲 3000', used(st, '9001'), 3000);
t('乙 1000', used(st, '9002'), 1000);
let bd = (await qg.handleUiRequest({ action: 'cumulative' })).board;
t('总消耗 12000（今天 4000 + 昨天 8000）', bd.totals.tokens, 12000);

console.log('\n── 2. 重置甲：只动甲、只动今天 ──');
st = await qg.handleUiRequest({ action: 'reset', payload: { userId: '9001' } });
t('甲归零', used(st, '9001'), 0);
t('乙不受牵连', used(st, '9002'), 1000);
t('今日合计变成 1000', st.todayTotal, 1000);
bd = (await qg.handleUiRequest({ action: 'cumulative' })).board;
t('★ 总消耗仍是 12000（重置碰不到它）', bd.totals.tokens, 12000);
t('★ 总榜上甲的历史消耗不变（3000）', bd.rows.find((r) => r.userId === '9001').tokens, 3000);
t('★ 总榜上丙的历史消耗不变（8000）', bd.rows.find((r) => r.userId === '9003').tokens, 8000);
t('★ 累计里的「今日」列也归零', bd.rows.find((r) => r.userId === '9001').usedToday, 0);

console.log('\n── 3. 重置必须真的生效：刷新/重载后不能自己长回来 ──');
{
  // 重载插件（模拟重启/热重载后重新读盘）
  const fresh = await import(QG + '?t=' + Date.now());
  const st2 = await fresh.handleUiRequest({ action: 'state' });
  t('重载后甲仍是 0（没被存档兜底填回来）', used(st2, '9001'), 0);
  t('重载后今日合计仍是 1000', st2.todayTotal, 1000);
  t('重载后来源仍是 ledger（已有实时记账）', st2.todaySource, 'ledger');
  const bd2 = (await fresh.handleUiRequest({ action: 'cumulative' })).board;
  t('重载后总消耗仍是 12000', bd2.totals.tokens, 12000);
  // 反复取也不该变
  for (let i = 0; i < 3; i++) await fresh.handleUiRequest({ action: 'cumulative' });
  const bd3 = (await fresh.handleUiRequest({ action: 'cumulative' })).board;
  t('反复取总消耗不会漂移', bd3.totals.tokens, 12000);
}

console.log('\n── 4. 重置后新增的消耗照常从 0 开始累计 ──');
{
  const api = { config: () => ({}), log: () => {}, isSkillActive: () => true };
  qg.hooks['before-context']({ ...api, chatKey: 'group:1', sessionId: 's2', triggerEntries: [msg(9001, '甲')] });
  qg.hooks['after-response']({
    ...api,
    session: { id: 's2', chatKey: 'group:1', usage: { totalTokens: 700, calls: 1 } },
    response: { usage: { total_tokens: 700 } }
  });
  st = await state();
  t('甲从 0 开始重新计到 700', used(st, '9001'), 700);
  t('今日合计 = 700 + 乙 1000 = 1700', st.todayTotal, 1700);
}

console.log('\n── 5. 全局重置：当天清零，总消耗不动 ──');
{
  st = await qg.handleUiRequest({ action: 'reset', payload: {} });
  t('今日合计归零', st.todayTotal, 0);
  t('甲归零', used(st, '9001'), 0);
  t('乙归零', used(st, '9002'), 0);
  bd = (await qg.handleUiRequest({ action: 'cumulative' })).board;
  t('★ 总消耗依然是 12000', bd.totals.tokens, 12000);
  t('★ 甲的历史消耗依然是 3000', bd.rows.find((r) => r.userId === '9001').tokens, 3000);
}

console.log('\n── 6. 重置一个人不该影响别人的额度设置 ──');
{
  const cfg = cfgMod.getConfig().skills['quota-guard'];
  t('甲的额度还在', cfg.perUser['9001']?.limit, 100000);
  t('乙的额度还在', cfg.perUser['9002']?.limit, 100000);
}

console.log('\n── 7. 累计账本文件本身没被重置逻辑写过 ──');
{
  const cumFile = path.join(TMP, 'quota-guard', 'cumulative.json');
  const c = JSON.parse(fs.readFileSync(cumFile, 'utf8'));
  t('cumulative 里的总消耗 = 12000', c.totals.tokens, 12000);
  t('cumulative 里甲的历史 = 3000', c.users['9001'].tokens, 3000);
  const led = JSON.parse(fs.readFileSync(path.join(TMP, 'quota-guard', 'ledger.json'), 'utf8'));
  const floors = led.userFloors && Object.values(led.userFloors)[0];
  ok('ledger 里按人记录了"今天被重置过"', floors && floors['9001'] === true);
  t('ledger 里甲是 0', led.users['9001'].used, 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
