// read_forward 逐层展开 + 引用转发 回归测试（纯离线）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-forward-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  api: { baseUrl: '', apiKey: '', model: 'test' },
  server: { port: 3396 }
}));

const { ChatStore } = await import('../src/store.js');
const { buildToolDefs } = await import('../src/tools.js');

const store = new ChatStore(0);
const tool = buildToolDefs().find((t) => t.id === 'read_forward');
assert.ok(tool, 'read_forward 应存在');

const calls = [];
const onebot = {
  async call(method, params) {
    calls.push({ method, params });
    const key = params.id ?? params.message_id;
    if (method === 'get_forward_msg') {
      if (key === 100) return { messages: [
        { sender: { nickname: 'A' }, message: [
          { type: 'text', data: { text: '一层内容' } },
          { type: 'image', data: { file: 'onlyfile.png' } }
        ] },
        { sender: { nickname: 'B' }, message: [{ type: 'forward', data: { id: 'n1' } }] }
      ] };
      if (key === 'n1') return { messages: [
        { sender: { nickname: 'C' }, message: [
          { type: 'text', data: { text: '二层内容' } },
          { type: 'image', data: { url: 'http://x/n1.png', file: 'n1.png' } },
          { type: 'forward', data: { id: 'n2' } }
        ] }
      ] };
      if (key === 'n2') return { messages: [
        { sender: { nickname: 'D' }, message: [{ type: 'text', data: { text: '三层内容' } }] }
      ] };
      if (key === 'q1') return { messages: [
        { sender: { nickname: 'Q' }, message: [
          { type: 'text', data: { text: '引用里的内容' } },
          { type: 'image', data: { url: 'http://x/q1.png', file: 'q1.png' } }
        ] }
      ] };
      throw new Error(`no forward ${key}`);
    }
    if (method === 'get_msg') {
      if (key === 200) return { message: [{ type: 'reply', data: { id: '300' } }] };
      if (key === 300) return { message: [{ type: 'forward', data: { id: 'q1' } }] };
      throw new Error(`no msg ${key}`);
    }
    throw new Error(`unexpected ${method}`);
  }
};

let pass = 0; let fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  ✓ ${name}`); }
  catch (e) { fail += 1; console.error(`  ✗ ${name}\n      ${e.message}`); }
};
const parse = (r) => JSON.parse(r.content);

console.log('\n[1] 直接转发逐层展开');
store.appendIncoming('group:1', { mid: 100, ts: Date.now(), senderId: '1', senderName: '张三', text: '[合并转发聊天记录]' });
const ctx = { chatKey: 'group:1', sessionId: 's1', store, onebot };

let r1;
await check('首次只返回一层，并给出 recordId=n1', async () => {
  r1 = await tool.execute(ctx, { messageId: 100 });
  assert.ok(!r1.isError, r1.content);
  const body = parse(r1);
  assert.ok(body.text.includes('一层内容'));
  assert.ok(body.text.includes('recordId=n1'));
  assert.ok(!body.text.includes('二层内容'), '不应自动展开二层');
  assert.deepEqual(body.nested.map((n) => n.recordId), ['n1']);
  assert.equal(body.nested[0].depth, 1);
  assert.ok(store.findByMid('group:1', 100).text.startsWith('[合并转发 共'));
  assert.ok(store.findByMid('group:1', 100).media.some((m) => m.file === 'onlyfile.png'), 'file 型图片不能丢');
});

await check('传 recordId=n1 只展开二层，并给出 n2', async () => {
  const r = await tool.execute(ctx, { recordId: 'n1' });
  assert.ok(!r.isError, r.content);
  const body = parse(r);
  assert.ok(body.text.includes('二层内容'));
  assert.ok(body.text.includes('recordId=n2'));
  assert.ok(!body.text.includes('三层内容'));
  assert.equal(body.depth, 1);
  assert.deepEqual(body.nested.map((n) => n.recordId), ['n2']);
  assert.equal(body.nested[0].depth, 2);
  assert.equal(body.imageMessageId, 100, '嵌套层图片应挂到根消息');
  assert.ok(store.findByMid('group:1', 100).media.some((m) => m.url === 'http://x/n1.png'), '嵌套层图片应进根消息 media');
});

await check('传 recordId=n2 展开三层', async () => {
  const r = await tool.execute(ctx, { recordId: 'n2' });
  assert.ok(!r.isError, r.content);
  const body = parse(r);
  assert.ok(body.text.includes('三层内容'));
  assert.equal(body.depth, 2);
  assert.equal(body.nested.length, 0);
});

await check('重复展开同一 recordId 被拒绝', async () => {
  const r = await tool.execute(ctx, { recordId: 'n2' });
  assert.equal(r.isError, true);
  assert.ok(r.content.includes('已经展开过'));
});

await check('未知 recordId 被拒绝（不允许读别的记录）', async () => {
  const r = await tool.execute(ctx, { recordId: 'other' });
  assert.equal(r.isError, true);
  assert.ok(r.content.includes('不在本轮已展开的转发里'));
});

await check('再次传 messageId 读存档，并提示嵌套已展开', async () => {
  const r = await tool.execute(ctx, { messageId: 100 });
  assert.ok(!r.isError, r.content);
  const body = parse(r);
  assert.ok(body.note.includes('读的是存档'));
});

await check('refresh=true 可重拉已展开的旧存档，检查嵌套标记', async () => {
  const r = await tool.execute(ctx, { messageId: 100, refresh: true });
  assert.ok(!r.isError, r.content);
  const body = parse(r);
  assert.ok(body.text.includes('recordId=n1'), '重拉后应重新出现嵌套 recordId');
});

console.log('\n[2] 引用聊天记录');
store.appendIncoming('group:1', { mid: 200, ts: Date.now(), senderId: '2', senderName: '李四', text: '[引用 张三：[合并转发聊天记录]（可用 read_forward 查看）]' });
await check('传引用消息自己的 #数字，能顺着 reply 找到被引用记录', async () => {
  const r = await tool.execute({ ...ctx, sessionId: 's2' }, { messageId: 200 });
  assert.ok(!r.isError, r.content);
  const body = parse(r);
  assert.ok(body.text.includes('引用里的内容'));
  assert.ok(body.note.includes('不覆盖原消息'));
  assert.equal(body.imageMessageId, 200, '引用转发图片应挂到引用消息');
  assert.ok(store.findByMid('group:1', 200).media.some((m) => m.url === 'http://x/q1.png'), '引用转发图片应进 media');
});

await check('引用转发不覆盖原消息文本', () => {
  const entry = store.findByMid('group:1', 200);
  assert.ok(String(entry.text).startsWith('[引用'), '原引用文本必须保留');
});

await check('没有 messageId / recordId 时给出参数提示', async () => {
  const r = await tool.execute(ctx, {});
  assert.equal(r.isError, true);
  assert.ok(r.content.includes('messageId'));
});

console.log(`\n结果：${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
