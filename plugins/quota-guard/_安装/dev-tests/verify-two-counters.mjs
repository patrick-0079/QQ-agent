/**
 * 「今日用量」与「当前余额」是两个独立的东西 —— 回归测试。
 *
 * 用户明确的口径（我之前反复搞错）：
 *   ① 今日用量 = 今天真实花了多少 **完全不同** 于当前余额
 *   ② 「重置」只重置**当前余额**（余额回满），**不动今日用量**
 *   ③ 拦不拦消息**只由当前余额决定**
 *   ④ 到设定时刻（resetHour），两者随新的一天**一起**归零
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-two-'));
process.env.QQ_AGENT_DATA_DIR = TMP;
const QG = 'file:///E:/dsqqbot/QQ%20Agent/resources/app/plugins/quota-guard/index.js';
const cfgMod = await import('file:///E:/dsqqbot/QQ%20Agent/resources/app/src/config.js');
cfgMod.setRuntimeConfig(cfgMod.loadConfig());

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};
const ok = (n, c) => t(n, !!c, true);

const qg = await import(QG + '?t=' + Date.now());
const api = { config: () => ({}), log: () => {}, isSkillActive: () => true };
const msg = (id, n) => ({ id: Math.random(), senderId: String(id), senderName: n, text: 'x' });
const gate = qg.providers['chat.quota-gate'];
const SESS = path.join(TMP, 'sessions');
fs.mkdirSync(SESS, { recursive: true });

let seq = 0;
function run(entries, perMsg = 500) {
  seq++;
  const sid = 'r' + seq;
  const batch = entries.slice();
  qg.hooks['before-context']({ ...api, chatKey: 'group:1', sessionId: sid, triggerEntries: batch });
  const g = gate({ chatKey: 'group:1', sessionId: sid, triggerEntries: batch, willRespond: true, tier: 4, sendState: { ok: true } });
  const skipped = !!(g && g.skip);
  const spent = skipped ? 0 : perMsg * entries.length;
  if (!skipped) {
    qg.hooks['after-response']({
      ...api,
      session: { id: sid, chatKey: 'group:1', usage: { totalTokens: spent, calls: 1 } },
      response: { usage: { total_tokens: spent } }
    });
    fs.writeFileSync(path.join(SESS, sid + '.json'), JSON.stringify({
      id: sid, chatKey: 'group:1', startedAt: Date.now(),
      usage: { totalTokens: spent, calls: 1 }, trigger: entries
    }), 'utf8');
  }
  return { skipped, spent };
}
const row = async (qq) => (await qg.handleUiRequest({ action: 'state' })).rows.find((r) => r.userId === qq) || {};
const reset = (qq) => qg.handleUiRequest({ action: 'reset', payload: qq ? { userId: qq } : {} });

await qg.handleUiRequest({ action: 'setLimit', payload: { userId: '9001', limit: 2000, name: '甲' } });

console.log('── 1. 没重置过时：两个数相等 ──');
{
  run([msg(9001, '甲'), msg(9001, '甲'), msg(9001, '甲')], 500);   // 1500
  const r = await row('9001');
  t('今日用量 = 1500', r.spent, 1500);
  t('当前余额 = 2000 - 1500 = 500', r.remaining, 500);
  t('余额扣减量也是 1500（此时两者相同）', r.used, 1500);
}

console.log('\n── 2. ★ 重置余额：余额回满，今日用量**纹丝不动** ──');
{
  await reset('9001');
  const r = await row('9001');
  t('★★ 当前余额回到 2000', r.remaining, 2000);
  t('★★ 今日用量**仍是 1500**（没有被重置）', r.spent, 1500);
  t('★ 两个数已经分叉（这就是它们不是同一个东西的证据）', r.spent !== r.used, true);
  t('★ 余额扣减量归零', r.used, 0);
  ok('★ 不再算作超额（余额决定）', r.over === false);
}

console.log('\n── 3. ★ 重置后能说话，且消耗从满额余额里扣 ──');
{
  t('放行', run([msg(9001, '甲')]).skipped, false);   // 500
  const r = await row('9001');
  t('今日用量累加：1500 + 500 = 2000', r.spent, 2000);
  t('余额 = 2000 - 500 = 1500', r.remaining, 1500);
}

console.log('\n── 4. ★ 拦不拦只由余额决定：余额耗尽就拦，与今日用量无关 ──');
{
  // 再把余额用掉 1500 → 余额 0
  run([msg(9001, '甲'), msg(9001, '甲'), msg(9001, '甲')], 500);
  let r = await row('9001');
  t('余额扣减量到顶 2000', r.used, 2000);
  t('当前余额 0', r.remaining, 0);
  ok('已超额', r.over === true);
  t('今日用量此时是 3500', r.spent, 3500);

  const g = run([msg(9001, '甲')]);
  t('★ 余额耗尽 → 被拦', g.skipped, true);

  // 关键：重置余额后，**虽然今日用量很大（3500）**，也应该放行
  await reset('9001');
  r = await row('9001');
  t('重置后余额回满', r.remaining, 2000);
  t('重置后今日用量仍是 3500（没被清）', r.spent, 3500);
  t('★ 余额回来了 → 放行（尽管今日用量 3500 > 额度 2000）', run([msg(9001, '甲')]).skipped, false);
}

console.log('\n── 5. 界面拿到的两个数确实分别来自两个计数器 ──');
{
  const st = await qg.handleUiRequest({ action: 'state' });
  const r = st.rows.find((x) => x.userId === '9001');
  ok('行里有 spent（今日用量）', typeof r.spent === 'number');
  ok('行里有 used（余额扣减量）', typeof r.used === 'number');
  ok('行里有 remaining（当前余额）', typeof r.remaining === 'number');
  t('totalUsed（今日合计）= 各人 spent 之和', st.totalUsed, st.rows.reduce((a, x) => a + x.spent, 0));
  t('totalCharged（余额口径）= 各人 used 之和', st.totalCharged, st.rows.reduce((a, x) => a + x.used, 0));
  ok('★ 重置过的人：spent ≠ used', r.spent !== r.used);
}

console.log('\n── 6. 重置不会动总消耗（那是独立的历史账）──');
{
  let b = await qg.handleUiRequest({ action: 'cumulative' });
  for (let i = 0; i < 80 && (b.board.scan.running || b.board.scan.partial); i++) {
    await new Promise((r) => setTimeout(r, 50));
    b = await qg.handleUiRequest({ action: 'cumulative' });
  }
  const totalBefore = b.board.totals.tokens;
  await reset('9001');
  b = await qg.handleUiRequest({ action: 'cumulative' });
  t('★ 总消耗不变', b.board.totals.tokens, totalBefore);
  ok('累计榜里他的历史还在', b.board.rows.find((x) => x.userId === '9001').tokens > 0);
}

console.log('\n── 7. 到设定时刻：两个数随新的一天一起归零 ──');
{
  const r1 = await row('9001');
  ok('跨天前今日用量 > 0', r1.spent > 0);

  // 把 dayKey 改成"昨天"，模拟跨过 resetHour
  const L = path.join(TMP, 'quota-guard', 'ledger.json');
  const j = JSON.parse(fs.readFileSync(L, 'utf8'));
  for (const id of Object.keys(j.users)) j.users[id].dayKey = '2000-01-01';
  fs.writeFileSync(L, JSON.stringify(j), 'utf8');

  const fresh = await import(QG + '?t=' + Date.now());
  const st = await fresh.handleUiRequest({ action: 'state' });
  const r = st.rows.find((x) => x.userId === '9001');
  t('★ 跨天后今日用量归零', r.spent, 0);
  t('★ 跨天后余额也回满', r.remaining, r.limit);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
