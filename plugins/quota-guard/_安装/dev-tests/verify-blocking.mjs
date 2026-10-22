/**
 * 拦截与计数的回归测试。
 *
 * 钉死三条不变量（都曾经是坏的）：
 *   ① 额度充足的人，消息绝不能被拦；
 *   ② 全部参与者都超额时，**整轮必须被拦**（不能花冤枉钱）；
 *   ③ 每个被拦的人都要计数 —— 无论他是被"剔除"还是整轮被跳。
 *
 * 另外验一遍多人分摊：额度按发言条数分，且各人之和 = 该轮总消耗。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-blkverify-'));
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
/**
 * 跑一轮真实链路。perMsg = 每条消息分摊的 token（默认 400）。
 * @returns {{skipped:boolean, code:string, reason:string, spent:number}}
 */
function run(entries, perMsg = 400) {
  seq++;
  const sid = 's' + seq;
  const batch = entries.slice();
  qg.hooks['before-context']({ ...api, chatKey: 'group:1', sessionId: sid, triggerEntries: batch });
  // sessionId 必须传：核心就是这么传的（曾漏传，导致插件取不到状态、判定失效）
  const g = gate({ chatKey: 'group:1', sessionId: sid, triggerEntries: batch, willRespond: true, tier: 4, sendState: { ok: true } });
  const skipped = !!(g && g.skip);
  let spent = 0;
  if (!skipped) {
    spent = perMsg * entries.length;
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
  return { skipped, code: g ? g.code : '', reason: g ? g.reason : '', spent };
}
const row = async (qq) => (await qg.handleUiRequest({ action: 'state' })).rows.find((r) => r.userId === qq) || {};
const setLimit = (qq, limit, name) => qg.handleUiRequest({ action: 'setLimit', payload: { userId: qq, limit, name } });

await setLimit('9001', 1000, '甲');       // 额度很小，好灌满
await setLimit('9002', 1000000, '乙');    // 额度充足
await setLimit('9003', 0, '丙');          // 不限额

console.log('── ① 额度充足的人单独发言：绝不能被拦 ──');
{
  let r = run([msg(9002, '乙'), msg(9002, '乙')]);
  t('乙没被拦', r.skipped, false);
  t('这一轮确实花了钱', r.spent, 800);
  r = run([msg(9003, '丙')]);
  t('不限额的丙也没被拦', r.skipped, false);
}

console.log('\n── ② 超额的人 + 额度充足的人同场：整轮放行，只剔除超额者 ──');
{
  // 先把甲灌满
  for (let i = 0; i < 3; i++) run([msg(9001, '甲')]);
  const a = await row('9001');
  t('甲已用满', a.used, 1000);
  ok('甲已超额', a.over === true);

  const before = (await row('9001')).blockedCount;
  const r = run([msg(9001, '甲'), msg(9002, '乙')]);
  t('整轮没被拦（乙还有额度）', r.skipped, false);
  const after = await row('9001');
  t('甲的被拦次数 +1', after.blockedCount, before + 1);
  const b = await row('9002');
  ok('乙照常记账（额度没受影响）', b.used > 0 && !b.over);
}

console.log('\n── ③ 只有超额的人发言：整轮必须被拦（这是花钱的漏洞）──');
{
  const before = (await row('9001')).blockedCount;
  const r = run([msg(9001, '甲'), msg(9001, '甲')]);
  t('★ 整轮被拦', r.skipped, true);
  t('★ 原因是额度用尽', r.code, 'quota-exhausted');
  t('★ 没有花任何钱', r.spent, 0);
  ok('理由里点了名', r.reason.includes('9001'));
  t('★ 被拦次数 +1（以前是 0）', (await row('9001')).blockedCount, before + 1);
}

console.log('\n── ④ 两个人同时超额：整轮被拦，两个人都计数 ──');
{
  await setLimit('9004', 1000, '丁');
  for (let i = 0; i < 3; i++) run([msg(9004, '丁')]);
  const a0 = (await row('9001')).blockedCount;
  const d0 = (await row('9004')).blockedCount;
  ok('两个人都已超额', (await row('9001')).over === true && (await row('9004')).over === true);

  const r = run([msg(9001, '甲'), msg(9004, '丁')]);
  t('★ 整轮被拦', r.skipped, true);
  t('★ 没有花钱', r.spent, 0);
  t('甲计数 +1', (await row('9001')).blockedCount, a0 + 1);
  t('丁计数 +1', (await row('9004')).blockedCount, d0 + 1);
}

console.log('\n── ⑤ 主动机会（本来没人发言）：不该拦 ──');
{
  seq++;
  const sid = 'idle' + seq;
  const empty = [];
  qg.hooks['before-context']({ ...api, chatKey: 'group:1', sessionId: sid, triggerEntries: empty });
  const g = gate({ chatKey: 'group:1', sessionId: sid, triggerEntries: empty, willRespond: true, tier: 1, sendState: { ok: true } });
  t('没人发言时不拦（走核心原有路径）', g, null);
}

console.log('\n── ⑥ 档位已决定不回：不越权拦 ──');
{
  const r = gate({ chatKey: 'group:1', sessionId: 'x', triggerEntries: [msg(9001, '甲')], willRespond: false, tier: 1, sendState: { ok: true } });
  t('willRespond=false 时返回 null', r, null);
}

console.log('\n── ⑦ 多人分摊：按发言条数分，各人之和 = 本轮消耗 ──');
{
  // ⚠️ 用**增量**断言，不要手算前几轮留下的累计值 —— 手算容易漏掉某一轮，
  //    失败时会误以为是分摊算错了（这个坑踩过）。
  const cBefore = (await row('9003')).used;
  const bBefore = (await row('9002')).used;

  // 4 条消息、每条 1000 → 本轮消耗 4000；丙 3 条、乙 1 条 → 丙 3000 / 乙 1000
  // ⚠️ perMsg 是**每条消息**的消耗，不是整轮的：4 条 × 1000 = 4000（曾看错导致断言写错）
  const r = run([msg(9003, '丙'), msg(9003, '丙'), msg(9003, '丙'), msg(9002, '乙')], 1000);
  t('整轮放行（两人都有额度）', r.skipped, false);
  t('本轮消耗 4000', r.spent, 4000);

  const dC = (await row('9003')).used - cBefore;
  const dB = (await row('9002')).used - bBefore;
  t('丙按 3/4 分摊 = 3000', dC, 3000);
  t('乙按 1/4 分摊 = 1000', dB, 1000);
  t('★ 两人之和精确等于本轮消耗 4000', dC + dB, 4000);
  t('★ 没有因为四舍五入丢 token', dC + dB, r.spent);
}

console.log('\n── ⑧ 三人不均等分摊：5 条消息 3/1/1，消耗 10000 ──');
{
  await setLimit('9005', 0, '戊');
  // 先把基线读出来（必须在 setLimit 之后读：戊原本不在列表里，读不到）
  const before = {
    a: (await row('9003')).used, b: (await row('9002')).used, c: (await row('9005')).used
  };
  // 5 条消息 × 2000 = 10000
  const r = run([
    msg(9003, '丙'), msg(9003, '丙'), msg(9003, '丙'),
    msg(9002, '乙'), msg(9005, '戊')
  ], 2000);
  t('整轮放行', r.skipped, false);
  t('本轮消耗 10000', r.spent, 10000);
  const dA = (await row('9003')).used - before.a;
  const dB = (await row('9002')).used - before.b;
  const dC = (await row('9005')).used - before.c;
  t('丙 3/5 = 6000', dA, 6000);
  t('乙 1/5 = 2000', dB, 2000);
  t('戊 1/5 = 2000', dC, 2000);
  t('★ 三人之和 = 10000（最大余额法不丢账）', dA + dB + dC, 10000);
}

console.log('\n── ⑨ 旧版核心不传 sessionId 时，兜底也要能拦（否则白花钱）──');
{
  // 场景：核心版本较旧，gate 的上下文里没有 sessionId。
  // 若插件只按 sessionId 查状态就会落空 → 退化成"永远放行"。
  // 这里故意不传 sessionId，验证按 chatKey 的短期兜底生效。
  const b = [msg(9001, '甲')];
  qg.hooks['before-context']({ ...api, chatKey: 'group:1', sessionId: 'noSidRun', triggerEntries: b });
  const g = gate({ chatKey: 'group:1', triggerEntries: b, willRespond: true, tier: 4, sendState: { ok: true } });
  ok('★ 不传 sessionId 也拦住了', g && g.skip === true);
  t('原因码正确', g && g.code, 'quota-exhausted');
}

console.log('\n── ⑩ 兜底不会误伤：另一个会话不受影响 ──');
{
  const b = [msg(9002, '乙')];
  qg.hooks['before-context']({ ...api, chatKey: 'group:OTHER', sessionId: 'otherRun', triggerEntries: b });
  const g = gate({ chatKey: 'group:OTHER', triggerEntries: b, willRespond: true, tier: 4, sendState: { ok: true } });
  t('别的会话照常放行', g, null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
