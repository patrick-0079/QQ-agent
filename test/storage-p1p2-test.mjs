// P1（消息快照+JSONL）+ P2（会话索引+gzip 归档/运行中摘要）回归测试。
// 纯离线：临时数据目录，不碰真实 data/。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-storage-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  api: { baseUrl: '', apiKey: '', model: 'test-model' },
  server: { port: 3397 },
  store: { maxMessagesPerChat: 0, keepSessionFiles: 0 }
}));

let pass = 0;
let fail = 0;
const check = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  ✓ ${name}`); }
  catch (e) { fail += 1; console.error(`  ✗ ${name}\n      ${e.stack || e.message}`); }
};
const stat = (f) => { try { return fs.statSync(f); } catch { return null; } };
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const tick = () => new Promise((r) => setImmediate(r));

const { ChatStore } = await import('../src/store.js');
const { chatPaths, compactChat } = await import('../src/storage/chatlog.js');
const { SessionRegistry } = await import('../src/sessions.js');
const {
  archiveFile, indexFile, legacyFile, readIndexEntries, runningFile, writeArchive
} = await import('../src/storage/session-files.js');

console.log('\n[1] 消息：旧快照兼容 + JSONL 增量');

// 造一个旧版快照
const msgDir = path.join(dataDir, 'messages');
fs.mkdirSync(msgDir, { recursive: true });
fs.writeFileSync(path.join(msgDir, 'group_1.json'), JSON.stringify({
  chatKey: 'group:1',
  nextLocalId: 3,
  messages: [
    { id: 1, mid: 11, ts: 1000, senderId: 'u1', senderName: '甲', text: '旧消息1', self: false, read: true, reply: null, media: [] },
    { id: 2, mid: 12, ts: 2000, senderId: 'u2', senderName: '乙', text: '旧消息2', self: false, read: false, reply: null, media: [] }
  ]
}));

let store = new ChatStore(0);
await check('旧 .json 直接当快照读，计数/未读正确', () => {
  const meta = store.getChatMeta('group:1');
  assert.equal(meta.total, 2);
  assert.equal(meta.unread, 1);
  assert.equal(store.recent('group:1', { limit: 10 }).length, 2);
});

await check('追加消息只写 .jsonl，不重写快照', () => {
  const snap = chatPaths('group:1').snapshot;
  const before = stat(snap);
  store.appendIncoming('group:1', { mid: 13, ts: 3000, senderId: 'u3', senderName: '丙', text: '新消息' });
  const after = stat(snap);
  assert.equal(after.size, before.size, '快照不应被改写');
  assert.equal(store.getChatMeta('group:1').total, 3);
  const delta = fs.readFileSync(chatPaths('group:1').delta, 'utf8').trim().split('\n');
  assert.equal(delta.length, 1, 'delta 应只有一行');
  assert.equal(JSON.parse(delta[0]).t, 'm');
});

await check('重新加载：快照 + 回放得到一致状态', () => {
  const s2 = new ChatStore(0);
  const meta = s2.getChatMeta('group:1');
  assert.equal(meta.total, 3);
  assert.equal(meta.lastText, '新消息');
  assert.equal(s2.unreadCount('group:1'), 2, '旧未读 1 条 + 新消息 1 条');
});

await check('已读 / 撤回 / 编辑 / 删除事件可回放', () => {
  const id = store.recent('group:1', { limit: 1 })[0].id;
  store.markEntryRead('group:1', id);
  store.updateByMid('group:1', 13, { text: '改过的文本', appendMedia: [{ kind: 'image', url: 'http://x/1.png' }] });
  store.markRecalled('group:1', 12);
  assert.equal(store.findByMid('group:1', 12).recalled, true);
  const s2 = new ChatStore(0);
  const m = s2.findByMid('group:1', 13);
  assert.equal(m.text, '改过的文本');
  assert.equal(m.media.length, 1);
  assert.equal(s2.findByMid('group:1', 12).recalled, true);
  store.removeByLocalIds('group:1', [m.id]);
  assert.equal(new ChatStore(0).getChatMeta('group:1').total, 2);
});

await check('clear 会立刻压缩成空快照', () => {
  store.clearChat('group:1');
  const snap = readJson(chatPaths('group:1').snapshot);
  assert.equal(snap.messages.length, 0);
  const d = stat(chatPaths('group:1').delta);
  assert.ok(!d || d.size === 0, '空 delta 应被清掉或为 0 字节');
});

await check('压缩后 seq 生效：重复回放不会重复', async () => {
  for (let i = 0; i < 30; i += 1) {
    store.appendIncoming('group:1', { mid: 100 + i, senderId: 'u', senderName: 'x', text: `m${i}` });
  }
  compactChat('group:1', store.chats.get('group:1'));
  const s2 = new ChatStore(0);
  assert.equal(s2.getChatMeta('group:1').total, 30);
});

await check('崩溃半行：忽略尾部坏行，后续追加仍可读', () => {
  const delta = chatPaths('group:1').delta;
  fs.appendFileSync(delta, '{"seq":99999,"t":"m"', 'utf8');   // 模拟写一半
  const s2 = new ChatStore(0);
  assert.equal(s2.getChatMeta('group:1').total, 30, '坏尾行不应影响已有数据');
  s2.appendIncoming('group:1', { mid: 999, senderId: 'u', senderName: 'x', text: '断裂后第一条' });
  const s3 = new ChatStore(0);
  assert.equal(s3.getChatMeta('group:1').total, 31);
  assert.equal(s3.recent('group:1', { limit: 1 })[0].text, '断裂后第一条');
});

console.log('\n[2] 会话：摘要热写 + gzip 归档 + 索引');

let sessions = new SessionRegistry(0);
let sid = null;
await check('create：只写 running 摘要，不含提示词/消息', () => {
  const s = sessions.create({ chatKey: 'group:2', trigger: '测试', triggerSummary: '测试触发' });
  sid = s.id;
  const rf = runningFile(sid);
  assert.ok(fs.existsSync(rf), 'running 摘要应存在');
  assert.ok(stat(rf).size < 5000, `running 摘要应很小，实际 ${stat(rf).size}`);
  const summary = readJson(rf);
  assert.equal(summary.status, 'running');
  assert.equal(summary.systemPrompt, undefined);
  assert.equal(summary.messages, undefined);
});

await check('get 返回克隆体，外部修改不污染内部', () => {
  const a = sessions.get(sid);
  a.trigger = '被改坏';
  assert.notEqual(sessions.get(sid).trigger, '被改坏');
});

await check('finish：写 gzip 档案 + 索引行，删除 running', () => {
  const s = sessions.current.get(sid);
  s.systemPrompt = 'S'.repeat(5000);
  s.userPrompt = 'U'.repeat(3000);
  s.messages = [{ raw: { created: Math.floor(Date.now() / 1000), model: 'test-model', usage: { prompt_tokens: 1000, completion_tokens: 200 } } }];
  s.usage = { promptTokens: 1000, completionTokens: 200, totalTokens: 1200, cachedTokens: 0, calls: 1 };
  sessions.finish(sid, 'done');
  assert.ok(fs.existsSync(archiveFile(sid)), 'gzip 档案应存在');
  assert.ok(!fs.existsSync(runningFile(sid)), 'running 应删除');
  const idx = readIndexEntries();
  const row = idx.find((e) => e.id === sid);
  assert.ok(row, '索引应包含该会话');
  assert.equal(row.status, 'done');
  assert.equal(row.usageRows.length, 1);
  assert.equal(row.usageRows[0].p, 1000);
});

await check('get 从 gzip 档案读回完整内容', () => {
  const s = sessions.get(sid);
  assert.equal(s.systemPrompt.length, 5000);
  assert.equal(s.status, 'done');
  assert.equal(s.usage.totalTokens, 1200);
});

await check('新实例只读索引即可列出会话', () => {
  const s2 = new SessionRegistry(0);
  const row = s2.listSummaries(50).find((e) => e.id === sid);
  assert.ok(row);
  assert.equal(row.chatKey, 'group:2');
});

await check('旧版 sessions/<id>.json 后台迁移为 gzip 并删除原文件', async () => {
  fs.mkdirSync(path.join(dataDir, 'sessions'), { recursive: true });
  const oldId = 'legacy-1';
  fs.writeFileSync(legacyFile(oldId), JSON.stringify({
    id: oldId,
    chatKey: 'group:legacy',
    startedAt: Date.now() - 3600000,
    endedAt: Date.now() - 3500000,
    status: 'done',
    model: 'test-model',
    vendor: 'v',
    messages: [],
    sent: [],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedTokens: 0, calls: 1 }
  }));
  const s2 = new SessionRegistry(0);
  await s2.reconcileInBackground();
  assert.ok(fs.existsSync(archiveFile(oldId)), '应生成 gzip');
  assert.ok(!fs.existsSync(legacyFile(oldId)), '校验通过后应删除旧文件');
  const row = readIndexEntries().find((e) => e.id === oldId);
  assert.ok(row, '索引应补上旧会话');
  assert.equal(s2.get(oldId).chatKey, 'group:legacy');
});

await check('孤儿档案：有 gzip 但索引缺行时后台补索引', async () => {
  const orphanId = 'orphan-1';
  writeArchive({
    id: orphanId, chatKey: 'group:orphan', startedAt: Date.now() - 7200000,
    endedAt: Date.now() - 7100000, status: 'done', model: 'test-model',
    messages: [], sent: [], usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4, cachedTokens: 0, calls: 1 }
  });
  const s2 = new SessionRegistry(0);
  await s2.reconcileInBackground();
  assert.ok(readIndexEntries().some((e) => e.id === orphanId), '孤儿档案应补进索引');
  assert.equal(s2.get(orphanId).chatKey, 'group:orphan');
});

await check('运行中遗留：启动回收为 aborted 的 partial 档案', () => {
  const zid = 'zombie-1';
  fs.mkdirSync(path.join(dataDir, 'sessions', 'running'), { recursive: true });
  fs.writeFileSync(runningFile(zid), JSON.stringify({
    id: zid, chatKey: 'group:z', startedAt: Date.now() - 1000, status: 'running',
    usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10, cachedTokens: 0, calls: 1 }
  }));
  const s2 = new SessionRegistry(0);
  const row = s2.listSummaries(50).find((e) => e.id === zid);
  assert.ok(row, '僵尸应出现在列表');
  assert.equal(row.status, 'aborted');
  assert.equal(s2.get(zid).partial, true);
  assert.ok(!fs.existsSync(runningFile(zid)));
});

await check('remove / clearFinished 会同步删除档案与索引', () => {
  const s2 = new SessionRegistry(0);
  assert.equal(s2.remove(sid), true);
  assert.ok(!fs.existsSync(archiveFile(sid)));
  assert.ok(!readIndexEntries().some((e) => e.id === sid));
  const removed = s2.clearFinished();
  assert.ok(removed >= 1);
});

await check('keepSessionFiles：只保留最近 N 个已结束会话', () => {
  const s = new SessionRegistry(2);
  for (let i = 0; i < 5; i += 1) {
    const c = s.create({ chatKey: `group:k${i}`, trigger: `t${i}` });
    s.finish(c.id, 'done');
  }
  assert.ok(s.listSummaries(50).length <= 2, `应只保留 2 个，实际 ${s.listSummaries(50).length}`);
  const archives = fs.readdirSync(path.join(dataDir, 'sessions', 'archive')).filter((f) => f.endsWith('.json.gz'));
  assert.ok(archives.length <= 2, `档案应 <=2，实际 ${archives.length}`);
});

console.log(`\n结果：${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
