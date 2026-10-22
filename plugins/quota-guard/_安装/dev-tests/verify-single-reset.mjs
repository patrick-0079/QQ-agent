/**
 * 单人重置是否有效 —— 按"你机器上的实际状态"验证。
 *
 * 关键：你的 ledger.json **不存在**（插件是后装的，今天的历史消耗只在会话存档里）。
 * 这正是旧代码里"重置是空操作"的那个场景，所以要专门按这个前提测。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-single-'));
process.env.QQ_AGENT_DATA_DIR = TMP;
const QG = 'file:///E:/dsqqbot/QQ%20Agent/resources/app/plugins/quota-guard/index.js';
const cfgMod = await import('file:///E:/dsqqbot/QQ%20Agent/resources/app/src/config.js');
cfgMod.setRuntimeConfig(cfgMod.loadConfig());

const SESS = path.join(TMP, 'sessions');
fs.mkdirSync(SESS, { recursive: true });
const msg = (id, n) => ({ id: Math.random(), senderId: String(id), senderName: n, text: 'x' });
const now = Date.now();

// 今天三场对话，含多人分摊
// ① 甲3条 + 乙1条 = 4000  → 甲3000 乙1000
fs.writeFileSync(path.join(SESS, 'a.json'), JSON.stringify({
  id: 'a', chatKey: 'group:1', startedAt: now, usage: { totalTokens: 4000, calls: 1 },
  trigger: [msg(9001, '甲'), msg(9001, '甲'), msg(9001, '甲'), msg(9002, '乙')]
}), 'utf8');
// ② 甲1条 = 2000 → 甲2000
fs.writeFileSync(path.join(SESS, 'b.json'), JSON.stringify({
  id: 'b', chatKey: 'group:1', startedAt: now, usage: { totalTokens: 2000, calls: 1 },
  trigger: [msg(9001, '甲')]
}), 'utf8');
// ③ 丙2条 = 8000 → 丙8000（别人，用来看有没有被牵连）
fs.writeFileSync(path.join(SESS, 'c.json'), JSON.stringify({
  id: 'c', chatKey: 'group:1', startedAt: now, usage: { totalTokens: 8000, calls: 1 },
  trigger: [msg(9003, '丙'), msg(9003, '丙')]
}), 'utf8');
// ④ 昨天的 5000（总消耗的一部分，重置绝不该动它）
fs.writeFileSync(path.join(SESS, 'old.json'), JSON.stringify({
  id: 'old', chatKey: 'group:1', startedAt: now - 30 * 3600 * 1000, usage: { totalTokens: 5000, calls: 1 },
  trigger: [msg(9001, '甲')]
}), 'utf8');

const qg = await import(QG + '?t=' + Date.now());
let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

async function settle() {
  let b = await qg.handleUiRequest({ action: 'cumulative' });
  for (let i = 0; i < 80 && (b.board.scan.running || b.board.scan.partial); i++) {
    await new Promise((r) => setTimeout(r, 50));
    b = await qg.handleUiRequest({ action: 'cumulative' });
  }
  return b.board;
}
const state = () => qg.handleUiRequest({ action: 'state' });
const usedOf = (st, qq) => (st.rows.find((r) => r.userId === qq) || {}).used;

console.log('=== 前提确认：模拟你现在的状态（没有 ledger.json）===');
console.log('  ledger 存在:', fs.existsSync(path.join(TMP, 'quota-guard', 'ledger.json')));
await settle();
let st = await state();
console.log(`  今日来源=${st.todaySource}  今日合计=${Number(st.todayTotal).toLocaleString()}`);
console.log(`  甲=${usedOf(st, '9001')}  乙=${usedOf(st, '9002')}  丙=${usedOf(st, '9003')}`);

console.log('\n── 甲的三段用量：①3000 + ②2000 + ④昨天的（不算今天）= 今天 5000 ──');
t('甲今日 = 5000', usedOf(st, '9001'), 5000);
t('乙今日 = 1000', usedOf(st, '9002'), 1000);
t('丙今日 = 8000', usedOf(st, '9003'), 8000);
t('今日合计 = 14000', Number(st.todayTotal), 14000);
let bd = await settle();
t('总消耗 = 19000（今天 14000 + 昨天 5000）', bd.totals.tokens, 19000);

console.log('\n── ① 只重置甲，看是否真的生效 ──');
st = await qg.handleUiRequest({ action: 'reset', payload: { userId: '9001' } });
t('★ 甲今日 = 0（真的清零了）', usedOf(st, '9001'), 0);
t('乙不受影响 = 1000', usedOf(st, '9002'), 1000);
t('丙不受影响 = 8000', usedOf(st, '9003'), 8000);
t('今日合计跟着变成 9000（0+1000+8000）', Number(st.todayTotal), 9000);
t('来源标记为 ledger（已有实时记账）', st.todaySource, 'ledger');

bd = await settle();
t('★ 总消耗仍是 19000（重置碰不到）', bd.totals.tokens, 19000);
t('★ 甲的历史总消耗仍是 10000（①3000 + ②2000 + ④5000）',
  bd.rows.find((r) => r.userId === '9001').tokens, 10000);
t('★ 累计榜的「今日」列里甲 = 0', bd.rows.find((r) => r.userId === '9001').usedToday, 0);

console.log('\n── ② 关键：刷新/重载后不能自己长回来 ──');
{
  const fresh = await import(QG + '?t=' + Date.now());
  const st2 = await fresh.handleUiRequest({ action: 'state' });
  t('★ 重载后甲仍是 0', usedOf(st2, '9001'), 0);
  t('重载后乙、丙不变', [usedOf(st2, '9002'), usedOf(st2, '9003')], [1000, 8000]);
  t('重载后今日合计仍是 9000', Number(st2.todayTotal), 9000);
  const bd2 = (await fresh.handleUiRequest({ action: 'cumulative' })).board;
  t('★ 重载后总消耗仍是 19000', bd2.totals.tokens, 19000);
}

console.log('\n── ③ 重置后甲再说话，应该从 0 开始重新累 ──');
{
  const api = { config: () => ({}), log: () => {}, isSkillActive: () => true };
  // 实时记账（进当日账本）
  qg.hooks['before-context']({ ...api, chatKey: 'group:1', sessionId: 'new1', triggerEntries: [msg(9001, '甲'), msg(9001, '甲')] });
  qg.hooks['after-response']({
    ...api,
    session: { id: 'new1', chatKey: 'group:1', usage: { totalTokens: 600, calls: 1 } },
    response: { usage: { total_tokens: 600 } }
  });
  // 同时落一份会话存档 —— 总消耗只认存档（实时记账和存档分工不同，是刻意的）
  fs.writeFileSync(path.join(SESS, 'new1.json'), JSON.stringify({
    id: 'new1', chatKey: 'group:1', startedAt: Date.now(), usage: { totalTokens: 600, calls: 1 },
    trigger: [msg(9001, '甲'), msg(9001, '甲')]
  }), 'utf8');

  st = await state();
  t('甲从 0 重新计到 600', usedOf(st, '9001'), 600);
  t('今日合计 = 600+1000+8000 = 9600', Number(st.todayTotal), 9600);
  bd = await settle();
  t('★ 总消耗随新消耗增长到 19600', bd.totals.tokens, 19600);
}

console.log('\n── ④ 再重置一次甲（第二次也要有效）──');
{
  st = await qg.handleUiRequest({ action: 'reset', payload: { userId: '9001' } });
  t('甲再次归零', usedOf(st, '9001'), 0);
  t('总消耗不受影响 = 19600', (await settle()).totals.tokens, 19600);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
