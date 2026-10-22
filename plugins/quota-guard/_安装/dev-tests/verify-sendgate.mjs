/**
 * 「发送限流前置」验证（一次性脚本，不属于项目）。
 *
 * 两件事分开验：
 *   ① 核心的 sender.canSend —— **只读**，不占额度；满了说满，没满说没满；
 *   ② 插件里的策略 —— 核心把 sendState 交过来后，插件据此决定拦不拦。
 *
 * 为什么这个功能值得单独测：它的全部价值就是"省掉一次白花的 token"，
 * 一旦 canSend 偷偷占了额度、或者判定写反，后果是"消息发不出去"或"白花钱"，
 * 两种都很难在使用中察觉。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const APP = 'E:\\dsqqbot\\QQ Agent\\resources\\app';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-sendgate-'));
process.env.QQ_AGENT_DATA_DIR = TMP;

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const ok = (n, c) => t(n, !!c, true);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── ① sender.canSend ────────────────────────────────────────────────────
console.log('── 1. sender.canSend：只读判断 ──');
const { SendQueue } = await import('file:///E:/dsqqbot/QQ%20Agent/resources/app/src/sender.js');
const cfgMod = await import('file:///E:/dsqqbot/QQ%20Agent/resources/app/src/config.js');
cfgMod.setRuntimeConfig(cfgMod.loadConfig());

const q = new SendQueue({ onebot: {}, store: { appendSelf() {} } });
const KEY = 'group:1';

// 用一份明确的发送配置（每分钟 3 条、每小时 500 条）
cfgMod.setRuntimeConfig(cfgMod.deepMerge(cfgMod.getConfig(), {
  send: { perChat: false, minGapMs: 200, maxGapMs: 300, byLengthMs: 0, maxPerMinute: 3, maxPerHour: 500, hardSplitAt: 4000, dedupeWindowMs: 8000 }
}));

{
  const c = q.canSend(KEY);
  t('空队列时可以发', c.ok, true);
  t('剩余分钟额度 = 3', c.remainingMinute, 3);
  t('剩余小时额度 = 500', c.remainingHour, 500);
  t('没被拦时 scope 为空', c.scope, null);
}

console.log('\n── 2. canSend 反复调用不该吃掉额度（关键：它必须只读）──');
{
  for (let i = 0; i < 10; i++) q.canSend(KEY);
  const c = q.canSend(KEY);
  t('调了 11 次，剩余分钟额度仍是 3', c.remainingMinute, 3);
}

console.log('\n── 3. 额度用尽后如实说满，并指出是哪一档 ──');
{
  // 直接用发送管道把 3 条吃掉（走真实的 #checkRate）
  const fake = new SendQueue({ onebot: { sendText: async () => ({ message_id: 1 }) }, store: { appendSelf() {} } });
  cfgMod.setRuntimeConfig(cfgMod.deepMerge(cfgMod.getConfig(), {
    send: { perChat: false, minGapMs: 200, maxGapMs: 200, byLengthMs: 0, maxPerMinute: 3, maxPerHour: 500, hardSplitAt: 0, dedupeWindowMs: 8000 }
  }));
  ok('发之前可以发', fake.canSend(KEY).ok);
  await fake.sendTextBatch(KEY, ['a', 'b', 'c']);
  const c = fake.canSend(KEY);
  t('发满 3 条后 canSend 说不行', c.ok, false);
  t('指出是分钟档', c.scope, 'minute');
  ok('理由里说明了每分钟上限', /每分钟最多 3 条/.test(c.reason));
  t('剩余分钟额度为 0', c.remainingMinute, 0);

  // 小时档也要能单独触发
  cfgMod.setRuntimeConfig(cfgMod.deepMerge(cfgMod.getConfig(), {
    send: { perChat: false, minGapMs: 200, maxGapMs: 200, byLengthMs: 0, maxPerMinute: 100, maxPerHour: 2, hardSplitAt: 0, dedupeWindowMs: 8000 }
  }));
  const fake2 = new SendQueue({ onebot: { sendText: async () => ({ message_id: 1 }) }, store: { appendSelf() {} } });
  await fake2.sendTextBatch(KEY, ['x', 'y']);
  const c2 = fake2.canSend(KEY);
  t('小时档用尽时说 scope=hour', c2.scope, 'hour');
  ok('理由里说明了每小时上限', /每小时最多 2 条/.test(c2.reason));
}

console.log('\n── 4. 时间窗过去后重新可用 ──');
{
  cfgMod.setRuntimeConfig(cfgMod.deepMerge(cfgMod.getConfig(), {
    send: { perChat: false, minGapMs: 200, maxGapMs: 200, byLengthMs: 0, maxPerMinute: 1, maxPerHour: 500, hardSplitAt: 0, dedupeWindowMs: 8000 }
  }));
  const f3 = new SendQueue({ onebot: { sendText: async () => ({ message_id: 1 }) }, store: { appendSelf() {} } });
  await f3.sendTextBatch(KEY, ['only-one']);
  t('发满 1 条后不能发', f3.canSend(KEY).ok, false);
  // 把时间戳往前拨 61 秒，模拟窗口滑过去（不用真等一分钟）
  const past = f3.minuteTimes.get(KEY).map((x) => x - 61000);
  f3.minuteTimes.set(KEY, past);
  t('分钟窗滑过后又能发了', f3.canSend(KEY).ok, true);
}

// ── ② 插件策略 ──────────────────────────────────────────────────────────
console.log('\n── 5. 插件：sendState 说满了就该拦，且不请求模型 ──');
const cfgPath = path.join(APP, 'plugins/quota-guard/index.js');
const QG = 'file:///' + cfgPath.replace(/\\/g, '/').replace(/ /g, '%20');
const skMod = await import('file:///E:/dsqqbot/QQ%20Agent/resources/app/src/skills/config.js');
const qg = await import(QG);

const msg = (id, n) => ({ id: Math.random(), senderId: String(id), senderName: n, text: 'x' });
const gateCtx = (over = {}) => ({
  chatKey: 'group:1', triggerEntries: [msg(9001, '甲')], willRespond: true, tier: 4,
  ...over
});

const FULL = { ok: false, scope: 'minute', reason: '发送频率超限（每分钟最多 8 条）', remainingMinute: 0, remainingHour: 492, maxPerMinute: 8, maxPerHour: 500 };
const FREE = { ok: true, scope: null, reason: '', remainingMinute: 7, remainingHour: 492, maxPerMinute: 8, maxPerHour: 500 };

{
  skMod.setSkillConfig('quota-guard', { defaultDailyLimit: 0, blockWhenSendLimited: true, perUser: {} });
  const gate = qg.providers['chat.quota-gate'];

  const r1 = gate(gateCtx({ sendState: FULL }));
  ok('限流满了 → 给出 skip', r1 && r1.skip === true);
  ok('理由里说明了是发送频率', /发送频率超限/.test(r1.reason || ''));
  ok('理由里点明"不请求模型"', /不请求模型/.test(r1.reason || ''));
  t('带上结构化原因码 code=rate-limited', r1.code, 'rate-limited');

  const r2 = gate(gateCtx({ sendState: FREE }));
  t('没满 → 不拦', r2, null);

  // 关掉这个开关就该退回核心原有行为（照常问模型）
  skMod.setSkillConfig('quota-guard', { defaultDailyLimit: 0, blockWhenSendLimited: false, perUser: {} });
  const r3 = gate(gateCtx({ sendState: FULL }));
  t('关掉开关后即使限流满了也不拦（退回原行为）', r3, null);

  // 核心没给 sendState（旧版本核心）也不能崩、不能误拦
  skMod.setSkillConfig('quota-guard', { defaultDailyLimit: 0, blockWhenSendLimited: true, perUser: {} });
  const r4 = gate(gateCtx({ sendState: undefined }));
  t('没有 sendState 时不拦、也不报错', r4, null);
  const r5 = gate(gateCtx({ sendState: null }));
  t('sendState 为 null 时同样不拦', r5, null);
}

console.log('\n── 6. 两种拦截互不干扰（限流 / 额度）──');
{
  skMod.setSkillConfig('quota-guard', { defaultDailyLimit: 100, blockWhenSendLimited: true, perUser: { 9001: { limit: 100 } } });
  const gate = qg.providers['chat.quota-gate'];
  // 先把额度用满（直接走 hook 记账）
  const api = { config: () => ({}), log: () => {}, isSkillActive: () => true };
  const batch = [msg(9001, '甲')];
  qg.hooks['before-context']({ ...api, chatKey: 'g9', sessionId: 's9', triggerEntries: batch });
  qg.hooks['after-response']({ ...api, response: { usage: { total_tokens: 9999 } }, session: { id: 's9', chatKey: 'g9', usage: { totalTokens: 9999 } } });

  const both = gate(gateCtx({ sendState: FULL }));
  ok('两种都命中时也只需要一个 skip', both && both.skip === true);
  ok('优先报发送限流（它是更直接的原因）', /发送频率超限/.test(both.reason || ''));

  const onlyQuota = gate(gateCtx({ sendState: FREE }));
  ok('限流没满、额度满了 → 报额度', /额度已用尽/.test(onlyQuota?.reason || ''));
  t('额度拦截的原因码是 quota-exhausted', onlyQuota?.code, 'quota-exhausted');
}

console.log('\n── 7. 档位决定不回时不插手 ──');
{
  const gate = qg.providers['chat.quota-gate'];
  t('willRespond=false 时返回 null（不越权）', gate(gateCtx({ willRespond: false, sendState: FULL })), null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
