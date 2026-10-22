// 离线自检：不连 QQ、不发任何真实请求、不调真实模型，只验证插件的判定与调度逻辑。
//
// 用法（Node 18+）：
//   node plugins/msg-reaction/selftest.mjs
//
// 覆盖：候选选择（自己的 / 被回复的 / 两者随机）、私聊跳过、AI 挑 0/1/2 个、
//       一条最多 2 个的硬上限、会话冷却、每小时上限、概率 0、跳过名单、
//       补丁契约、连续失败熔断、状态面板能力、关闭档。
import assert from 'node:assert/strict';

const mod = await import(new URL('./index.js', import.meta.url).href);

const sends = [];
const logs = [];
const registered = [];
let cfg = {};
mod.setup({
  config: () => cfg,
  log: (...a) => logs.push(['log', a.join(' ')]),
  warn: (...a) => logs.push(['warn', a.join(' ')]),
  registerTool: (def) => { registered.push(def); return def.id; }
});
assert.equal(registered.length, 1, '应注册 1 个工具');
assert.equal(registered[0].id, 'react');

const S = globalThis.__msgReactionState;
// 上一次自检如果中途崩了，会留下带计数的 state.json（loadState 会读进来）——
// 测试要从零开始，否则断言会被上次的残留污染。
S.stats = { attempts: 0, sent: 0, onDemand: 0, blocked: 0, skipped: 0, failed: 0, lastAt: 0, lastEmoji: '', lastReason: '' };
S.chats.clear();
S.pausedUntil = 0;
S.failStreak = 0;
S.transport = async (messageId, emojiId) => { sends.push([Number(messageId), String(emojiId)]); };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reset = () => { S.chats.clear(); sends.length = 0; S.seen.clear(); };

/** 模拟协议端发出一条消息成功 → 出站补丁回调。replyId 非 0 表示引用了别人。 */
const sent = (groupId, ownId, replyId = 0, text = '你行你上啊') => {
  const message = [];
  if (replyId) message.push({ type: 'reply', data: { id: String(replyId) } });
  message.push({ type: 'text', data: { text } });
  mod.internals.handleSent('send_group_msg', { group_id: groupId, message }, ownId);
};

const BASE = { enabled: true, probabilityPercent: 100, delayMinSec: 0, delayMaxSec: 0, minGapSec: 0 };

// ══ ① 纯函数 ══════════════════════════════════════════════════════════════
assert.equal(mod.replyTargetOf({ message: [{ type: 'reply', data: { id: '799' } }] }), 799);
assert.equal(mod.replyTargetOf({ message: [{ type: 'text', data: { text: 'x' } }] }), 0);
assert.equal(mod.replyTargetOf({ message: 'CQ:reply,id=5 文字' }), 0, '字符串 CQ 码不解析');
assert.equal(mod.sentIdOf({ message_id: 55501 }), 55501);
assert.equal(mod.sentIdOf({ message_id: -1234 }), -1234, '负 id 合法');
assert.equal(mod.sentIdOf({ message_id: 0 }), 0);
assert.equal(mod.internals.textOf({ message: [{ type: 'at', data: { qq: '1' } }, { type: 'text', data: { text: ' 滚  ' } }] }), '滚');
assert.equal(mod.internals.textOf({ message: '[CQ:reply,id=5]哈' }), '哈');
assert.equal(mod.internals.emojiCharOf('128514'), '😂');
assert.equal(mod.internals.emojiCharOf('14'), '#14', '经典小黄脸没有码点字符');
assert.ok(S.installed && S.patchedCall?.__msgReaction, '出站观测补丁应已安装');
assert.equal(typeof S.dispatch, 'function', '补丁转发口应指向当前实例');
console.log('① 纯函数 + 补丁安装 ✓');

// ══ ② 随机模式：给自己的消息贴 1 个 ═══════════════════════════════════════
cfg = { ...BASE, mode: '随机贴一个' };
reset(); sent(10001, 55501); await sleep(60);
assert.equal(sends.length, 1, '随机模式一次只贴 1 个');
assert.equal(sends[0][0], 55501);
console.log('② 随机模式 → 已贴', sends[0]);

// ══ ③ 私聊一律跳过（协议不支持）══════════════════════════════════════════
reset();
mod.internals.handleSent('send_private_msg', { user_id: 20001, message: [{ type: 'text', data: { text: 'x' } }] }, 701);
await sleep(60);
assert.equal(sends.length, 0);
console.log('③ 私聊 → 跳过 ✓');

// ══ ④ target=被回复的消息 ════════════════════════════════════════════════
reset();
cfg = { ...BASE, mode: '随机贴一个', target: '被回复的消息' };
sent(10003, 801, 799);
await sleep(60);
assert.deepEqual([sends[0][0]], [799]);
console.log('④ 被回复的消息 → 贴了 799');

// ══ ⑤ target=被回复的消息 但没引用 → 默认退回贴自己那条 ══════════════════════
//   v1.4 改的：以前这种情况直接静默不贴，结果"概率 100% 却一条都贴不出来"。
reset(); sent(10004, 802); await sleep(60);
assert.equal(sends.length, 1, '默认应退回贴自己的消息');
assert.equal(sends[0][0], 802, '贴的是自己刚发的那条');
console.log('⑤ 没引用 → 退回贴自己那条 ✓');

// ══ ⑥ 两者随机：一次仍只贴一个 ═══════════════════════════════════════════
reset();
cfg = { ...BASE, mode: '随机贴一个', target: '两者随机' };
sent(10011, 901, 899);
await sleep(60);
assert.equal(sends.length, 1);
assert.ok([901, 899].includes(sends[0][0]));
console.log('⑥ 两者随机 → 只贴了', sends[0][0]);

// ══ ⑦ AI 说"不用贴" → 一个都不贴，且不算失败 ══════════════════════════════
reset();
cfg = { ...BASE, mode: 'AI 决定' };
S.pickFn = async () => [];
sent(10020, 1001, 0, '今天的报价是 3.2 元一公斤。');
await sleep(60);
assert.equal(sends.length, 0, 'AI 回 none → 不贴');
assert.equal(S.stats.failed, 0, 'AI 不贴不算失败');
console.log('⑦ AI 回 none → 不贴 ✓');

// ══ ⑧ AI 挑 2 个 → 都贴上 ════════════════════════════════════════════════
reset();
S.pickFn = async () => ['128514', '128079'];
sent(10021, 1002, 0, '哈哈行吧你赢了');
await sleep(80);
assert.deepEqual(sends.map((s) => s[1]), ['128514', '128079']);
assert.deepEqual(sends.map((s) => s[0]), [1002, 1002], '两个表情贴在同一条消息上');
console.log('⑧ AI 挑 2 个 → 都贴上 ✓');

// ══ ⑨ 超过设置的上限则截断（默认 maxEmojis=2）═════════════════════════════
reset();
S.pickFn = async () => ['128077', '128514', '129300', '128517', '128563'];
cfg = { ...BASE, maxEmojis: 2 };
sent(10022, 1003);
await sleep(80);
assert.equal(sends.length, 2, '一条消息最多按设置来（默认 2 个）');
console.log('⑨ 上限截断 → 只贴 2 个 ✓');

// ══ ⑩ maxEmojis 是用户可调旋钮（1~5），不再是焊死的 2 ══════════════════════
cfg = { ...BASE, maxEmojis: 5 };
assert.equal(mod.internals.settings().maxEmojis, 5, '用户写了 5 就该是 5');
cfg = { ...BASE, maxEmojis: 0 };
assert.equal(mod.internals.settings().maxEmojis, 1, '写 0 也至少给 1');
cfg = { ...BASE, maxEmojis: 99 };
assert.equal(mod.internals.settings().maxEmojis, 5, '99 也封顶到 5（别把整排占满）');
cfg = { ...BASE, maxEmojis: 4 };
S.pickFn = async () => ['128077', '128514', '129300', '128517', '128563'];
reset();
sent(10023, 1004);
await sleep(80);
assert.equal(sends.length, 4, '设了 4 就最多贴 4 个');
S.pickFn = null;
console.log('⑩ maxEmojis 可调 1~5 ✓');

// ══ ⑪ 会话冷却 ═══════════════════════════════════════════════════════════
reset();
cfg = { ...BASE, mode: '随机贴一个', minGapSec: 600 };
sent(10005, 901); await sleep(60); sent(10005, 902); await sleep(60);
assert.equal(sends.length, 1, '冷却期内第二次不应贴');
console.log('⑪ 会话冷却 → 只贴了 1 次 ✓');

// ══ ⑫ 每小时上限 ═════════════════════════════════════════════════════════
reset();
cfg = { ...BASE, mode: '随机贴一个', maxPerHour: 2 };
for (const id of [11, 12, 13, 14]) sent(10006, id);
await sleep(180);
assert.equal(sends.length, 2);
console.log('⑫ 每小时上限 → 只贴了 2 次 ✓');

// ══ ⑬ 概率 0 → 永不贴 ════════════════════════════════════════════════════
reset();
cfg = { enabled: true, mode: '随机贴一个', probabilityPercent: 0, delayMinSec: 0, delayMaxSec: 0 };
sent(10007, 21); await sleep(60);
assert.equal(sends.length, 0);
console.log('⑬ 概率 0 → 不贴 ✓');

// ══ ⑭ 跳过名单 ═══════════════════════════════════════════════════════════
reset();
cfg = { ...BASE, mode: '随机贴一个', skipChats: 'group:10008' };
sent(10008, 31); await sleep(60);
assert.equal(sends.length, 0);
console.log('⑭ 跳过名单 → 不贴 ✓');

// ══ ⑮ 关闭档 → 完全不动作 ════════════════════════════════════════════════
reset();
cfg = { ...BASE, mode: '关闭' };
sent(10030, 41); await sleep(60);
assert.equal(sends.length, 0);
console.log('⑮ 模式=关闭 → 不贴 ✓');

// ══ ⑯ 全链路：真实走一遍「调 OneBot 发送 → 补丁观测 → 贴表情」═══════════════
// 起一个假的协议端 HTTP 服务，用真的 OneBotClient 发一条消息，
// 验证补丁确实拦到、dispatch 转发到最新实例、并且真的去贴了。
{
  const http = await import('node:http');
  const { OneBotClient } = await import(new URL('../../src/onebot.js', import.meta.url).href);

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 424242 } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  reset();
  cfg = { ...BASE, mode: 'AI 决定' };
  S.pickFn = async () => ['128514'];
  const r = await new OneBotClient({ httpUrl: `http://127.0.0.1:${port}` })
    .call('send_group_msg', { group_id: 88001, message: [{ type: 'text', data: { text: '哈哈' } }] });
  assert.equal(r.message_id, 424242, '补丁不能改变原返回值');
  await sleep(80);
  assert.deepEqual(sends, [[424242, '128514']], '全链路应贴到刚发出的那条消息上');
  S.pickFn = null;
  server.close();
  console.log('⑯ 全链路：发送 → 观测 → 贴表情 ✓');
}

// ══ ⑰ 连续失败熔断 ═══════════════════════════════════════════════════════
reset(); S.pausedUntil = 0; S.failStreak = 0; S.stats.failed = 0;
let attempts = 0;
S.transport = async () => { attempts += 1; throw new Error('retcode=1404 unknown action'); };
cfg = { ...BASE, mode: '随机贴一个', maxPerHour: 0, maxPerDay: 0 };
for (let i = 0; i < 6; i++) sent(10010, 1000 + i);
await sleep(250);
assert.equal(attempts, 4, '失败 4 次后熔断');
assert.equal(S.stats.failed, 4);
assert.ok(S.pausedUntil > Date.now(), '应处于熔断期');
console.log('⑰ 连续失败 → 第 4 次后熔断 ✓');

// ══ ⑱ 状态面板能力 ═══════════════════════════════════════════════════════
const st = mod.providers['status.msg-reaction']();
assert.equal(st.title, '消息表情回应');
assert.ok(Array.isArray(st.lines) && st.lines.length <= 8);
// 三条路的计数必须在面板上分开显示，否则用户看不出是谁贴的
const labels = st.lines.map(([k]) => k).join('|');
assert.ok(labels.includes('自动贴'), '面板应有「自动贴」');
assert.ok(labels.includes('被点名贴'), '面板应有「被点名贴」');
assert.ok(labels.includes('拦下的'), '面板应有「拦下的」');
assert.ok(st.tips.some((t) => t.includes('熔断')));
console.log('⑱ 状态面板能力 → 正常（三条路分开统计）');

// ══ ⑲ 工具（按需贴）：默认贴到"最近一条别人发的消息" ══════════════════════
// ⑰ 把熔断与传输层都改了，这里恢复干净状态
S.pausedUntil = 0; S.failStreak = 0;
S.transport = async (messageId, emojiId) => { sends.push([Number(messageId), String(emojiId)]); };
const TOOL = mod.internals.reactTool;
const mkCtx = (chatKey, msgs = []) => ({
  chatKey,
  store: {
    recent: () => msgs,
    findByMid: (_k, mid) => msgs.find((m) => String(m.mid) === String(mid)) || null
  }
});
{
  reset();
  cfg = { ...BASE, mode: 'AI 决定' };
  S.pickFn = null;
  const ctx = mkCtx('group:70001', [
    { mid: 501, self: false, text: '你好呀' },
    { mid: 502, self: true, text: '嗯' },
    { mid: 503, self: false, text: '给我贴个赞' }
  ]);
  const r = await TOOL.execute(ctx, {});
  assert.ok(!r.isError, `工具不应报错：${r.content}`);
  assert.equal(sends.length, 1, '应贴 1 个');
  assert.equal(sends[0][0], 503, '应贴到最近一条别人发的消息上');
  console.log('⑲ 按需贴 → 贴到最近一条别人的消息', sends[0]);
}

// ══ ⑳ emoji 参数的三种写法都认；不在表情池里也照贴（别人点名要的）═══════════
assert.deepEqual(mod.internals.parseEmojiSpec('👍'), ['128077']);
assert.deepEqual(mod.internals.parseEmojiSpec('128514'), ['128514']);
assert.deepEqual(mod.internals.parseEmojiSpec('赞'), ['128077']);
assert.deepEqual(mod.internals.parseEmojiSpec('笑哭, 鼓掌'), ['128514', '128079']);
assert.deepEqual(mod.internals.parseEmojiSpec(''), []);
{
  reset();
  cfg = { ...BASE, mode: 'AI 决定', emojiIds: '128077' };   // 池子里只有 👍
  const ctx = mkCtx('group:70002', [{ mid: 511, self: false, text: '给我贴个笑哭' }]);
  const r = await TOOL.execute(ctx, { emoji: '😂' });
  assert.ok(!r.isError, r.content);
  assert.deepEqual(sends, [[511, '128514']], '显式指定的表情即使不在池里也要贴');
  console.log('⑳ emoji 三种写法 + 池外表情照贴 ✓');
}

// ══ ㉑ 私聊 / 非群聊 → 明确报错（不要静默失败）═════════════════════════════
{
  reset();
  const r = await TOOL.execute(mkCtx('private:20001', [{ mid: 601, self: false, text: 'x' }]), {});
  assert.ok(r.isError && /群聊/.test(r.content), `私聊应报错：${r.content}`);
  assert.equal(sends.length, 0);
  console.log('㉑ 私聊 → 明确报错 ✓');
}

// ══ ㉒ 同会话 5 秒内连点第二次 → 拦住（防模型重复调用）═════════════════════
{
  reset();
  cfg = { ...BASE, mode: 'AI 决定' };
  const ctx = mkCtx('group:70003', [{ mid: 701, self: false, text: '给我贴个表情' }]);
  await TOOL.execute(ctx, { emoji: '👍' });
  const r2 = await TOOL.execute(ctx, { emoji: '👍' });
  assert.equal(sends.length, 1, '第二次不应再贴');
  assert.ok(!r2.isError, '防连点不算错误，只是不用再贴');
  console.log('㉒ 防连点 → 第二次拦住 ✓');
}

// ══ ㉓ 按需贴不受概率/冷却/日上限约束（用户点名要的就得照做）═══════════════
{
  reset();
  cfg = { enabled: true, mode: 'AI 决定', probabilityPercent: 0, minGapSec: 86400, maxPerDay: 0, maxPerHour: 0 };
  const chatKey = 'group:70004';
  const st = S.chats.get(chatKey);
  void st;
  const ctx = mkCtx(chatKey, [{ mid: 801, self: false, text: '贴个表情' }]);
  const r = await TOOL.execute(ctx, { emoji: '👏' });
  assert.ok(!r.isError, `概率 0 / 冷却 1 天时，按需贴仍应成功：${r.content}`);
  assert.deepEqual(sends, [[801, '128079']]);
  console.log('㉓ 按需贴不受限频约束 ✓');
}

// ══ ㉔ 显式传 messageId 时贴指定的那条 ═════════════════════════════════════
{
  reset();
  cfg = { ...BASE, mode: 'AI 决定' };
  const ctx = mkCtx('group:70005', [{ mid: 901, self: false, text: '别贴这条' }, { mid: 902, self: false, text: '贴这条' }]);
  await TOOL.execute(ctx, { emoji: '👍', messageId: 901 });
  assert.deepEqual(sends, [[901, '128077']], '应贴到显式指定的 messageId');
  console.log('㉔ 指定 messageId ✓');
}

// ══ ㉕ 「没明说要贴」→ 硬拦下（模型自己想贴也不行）═════════════════════════
//   这是用户明确要的规则：单纯 @ 一下、夸一句、聊个天，都不算要求贴表情。
//   只写在提示词里不够（模型会擅自调用），所以做成代码级拦截，这里压它。
assert.equal(mod.internals.isReactionRequest('给我贴个赞'), true);
assert.equal(mod.internals.isReactionRequest('回我个表情'), true);
assert.equal(mod.internals.isReactionRequest('贴一下这条'), true);
assert.equal(mod.internals.isReactionRequest('给我个👍'), true);
assert.equal(mod.internals.isReactionRequest('反应一下'), true);
assert.equal(mod.internals.isReactionRequest('给我贴个哈基米'), true);
// ↓ 这些都必须判为"没要求"：@ 不算，夸人不算，日常聊天不算
assert.equal(mod.internals.isReactionRequest('@机器人 你好啊'), false);
assert.equal(mod.internals.isReactionRequest('谁叫你每次都点名'), false);
assert.equal(mod.internals.isReactionRequest('你真厉害'), false);
assert.equal(mod.internals.isReactionRequest('今天天气不错'), false);
assert.equal(mod.internals.isReactionRequest('我好难受'), false);
assert.equal(mod.internals.isReactionRequest('回一下消息'), false,   // 量词规则不能误伤日常用语
  '「回一下消息」不算要表情');
assert.equal(mod.internals.isReactionRequest(''), false);
console.log('㉕ 「要表情」判定 → 正面 5 条 / 负面 6 条都正确');

S.stats.blocked = 0;
{
  reset();
  cfg = { ...BASE, mode: 'AI 决定' };
  const ctx = mkCtx('group:70006', [{ mid: 1001, self: false, text: '在吗' }, { mid: 1002, self: false, text: '今天天气不错' }]);
  const r = await TOOL.execute(ctx, { emoji: '👍' });
  assert.ok(r.isError, '没人要求贴时，工具必须拦下');
  assert.equal(sends.length, 0, '一次都不许贴出去');
  assert.equal(S.stats.blocked, 1, '应计入"拦下的"');
  console.log('㉕ 没人要求贴 → 硬拦下 ✓', `（${r.content.slice(0, 18)}…）`);
}

// ══ ㉖ 关掉 requireExplicit 后放行（设置项本身要真的能用）════════════════════
{
  reset();
  cfg = { ...BASE, mode: 'AI 决定', requireExplicit: false };
  const ctx = mkCtx('group:70007', [{ mid: 1101, self: false, text: '今天天气不错' }]);
  const r = await TOOL.execute(ctx, { emoji: '👍' });
  assert.ok(!r.isError, `关掉校验后应放行：${r.content}`);
  assert.deepEqual(sends, [[1101, '128077']]);
  console.log('㉖ 关掉「必须明说才贴」→ 放行 ✓');
}

// ══ ㉗ 按需贴完全不碰自动路径的配额旋钮 ══════════════════════════════════════
{
  reset();
  cfg = { ...BASE, mode: 'AI 决定', probabilityPercent: 30, minGapSec: 300, maxPerHour: 3, maxPerDay: 15 };
  const chatKey = 'group:70008';
  const before = { lastReactAt: 0, dayCount: 0, hourStamps: [] };
  const onDemandBefore = S.stats.onDemand;
  const sentBefore = S.stats.sent;
  const ctx = mkCtx(chatKey, [{ mid: 1201, self: false, text: '给我回个表情' }]);
  await TOOL.execute(ctx, { emoji: '😂' });
  const st = S.chats.get(chatKey);
  assert.equal(st.lastReactAt, before.lastReactAt, '不能刷新冷却时间戳');
  assert.equal(st.dayCount, before.dayCount, '不能消耗每日额度');
  assert.deepEqual(st.hourStamps, before.hourStamps, '不能占用每小时额度');
  assert.ok(st.lastToolAt > 0, '只记按需路径自己的时间戳');
  assert.deepEqual(st.reactedMids.map(String), ['1201'], '记住这条贴过了');
  const d = S.stats.onDemand - onDemandBefore;
  assert.equal(d, 1, '计入"被点名贴"');
  assert.equal(S.stats.sent - sentBefore, 0, '不能计入"自动贴"');
  console.log('㉗ 按需贴不碰自动配额，两条路计数分开 ✓');
}

// ══ ㉘ v1.4：一次发送只掷一次概率（补丁叠加也不失真）═══════════════════════
//   线上实测：同一次发送会打到两次观测回调（热重载让补丁套了两层），
//   概率等于被掷两遍 —— 填 20% 实际变成 36%，设置里的数字就失真了。
//   这里直接把同一个 dispatch 连打两次，断言只产生一次决策/一次发送。
{
  reset();
  cfg = { ...BASE, mode: '随机贴一个', maxEmojis: 2 };
  S.pickFn = null;
  const chatKey = 'group:70009';
  const params = { group_id: 70009, message: [{ type: 'text', data: { text: '测试去重' } }] };
  S.dispatch('send_group_msg', params, { message_id: 2001 });   // 第 1 次（真实）
  S.dispatch('send_group_msg', params, { message_id: 2001 });   // 第 2 次（补丁叠加产生的重复）
  await sleep(80);
  assert.equal(sends.length, 1, '同一条发送只应产生 1 次贴表情，实际 ' + sends.length);
  console.log('㉘ 同一条发送 → 只决策一次 ✓');
}

// ══ ㉙ v1.4：目标是「被回复的消息」但没引用 → 退回贴自己那条 ═════════════════
{
  reset();
  cfg = { ...BASE, mode: '随机贴一个', target: '被回复的消息', fallbackToSelf: true };
  sent(10040, 3001, 0, '没有引用任何人');
  await sleep(80);
  assert.equal(sends.length, 1, '应退回贴自己的消息');
  assert.equal(sends[0][0], 3001, '消息 id 应为自己那条');
  console.log('㉙ 没引用时 → 退回贴自己那条 ✓');

  reset();
  cfg = { ...BASE, mode: '随机贴一个', target: '被回复的消息', fallbackToSelf: false };
  sent(10041, 3002, 0, '没有引用任何人');
  await sleep(80);
  assert.equal(sends.length, 0, '关掉退回后应什么都不贴');
  console.log('㉙ 关掉退回 → 确实什么都不贴 ✓');
}

// ══ ㉚ v1.4：概率是"真"的（统计意义上贴合设定值）═══════════════════════════
{
  reset();
  cfg = { ...BASE, mode: '随机贴一个', probabilityPercent: 50, minGapSec: 0, maxPerHour: 0, maxPerDay: 0 };
  const N = 3000;
  let hits = 0;
  for (let i = 0; i < N; i++) {
    sends.length = 0;
    sent(10050, 4000 + i, 0, '抽样');
    await sleep(0);
    if (sends.length) hits += 1;
  }
  const rate = hits / N;
  // 二项分布 n=3000 p=0.5，±3σ ≈ ±0.027 —— 给到 0.045 的宽松带
  assert.ok(Math.abs(rate - 0.5) < 0.045, `50% 概率实测 ${(rate * 100).toFixed(1)}%，偏离过大`);
  console.log(`㉚ 概率校准 → 设 50% 实测 ${(rate * 100).toFixed(1)}% ✓`);
}

// 收尾：清掉自检写入的状态文件，避免污染真实统计
try {
  mod.dispose?.();
  const { DATA_DIR } = await import(new URL('../../src/config.js', import.meta.url).href);
  const fs = await import('node:fs');
  const path = await import('node:path');
  fs.rmSync(path.join(DATA_DIR, 'msg-reaction'), { recursive: true, force: true });
} catch { /* ignore */ }

console.log('\n全部 30 项自检通过 ✅');
