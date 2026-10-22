// 印象档案 · 数据层（长期 / 短期双层印象的本地存储）
//
// 分工（重要）：
//   · **长期印象的正文不在这里** —— 它就是核心自带的记忆（data/memory/…），
//     由核心的 MemoryStore 独占读写（工具里通过 ctx.memory 写、控制台走
//     /api/memory-files/*）。这样「记忆」页、记忆整理、memory_append 工具
//     全都还认它，本插件只是给它加了一层"标签 / 类型 / 提及频率"的旁注。
//   · **短期印象在这里**：临时观察、会过期、带提及频率与标签。
//   · 旁注数据（longMeta）：按内容哈希给长期印象挂上 kind / tags / 提及次数。
//
// 为什么长期印象不复制一份到自己这儿：核心的 MemoryStore 有内存缓存，
// 绕过它直接改磁盘会被下一次写入"复活"（auto-clean 的注释里踩过同一个坑）。
// 所以长期印象的写入口只有两处：模型调用本插件的工具（拿到活的 ctx.memory）、
// 或控制台面板直接调核心自己的 HTTP 接口。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../../../src/config.js';

const MP_DIR = path.join(DATA_DIR, 'memory-plus');
const STATE_FILE = path.join(MP_DIR, 'state.json');
const BACKUP_FILE = path.join(MP_DIR, 'state.json.bak');

/** 单条记忆的类型。约定类（appointment）永远优先、且注入时用原文。 */
export const KINDS = ['general', 'appointment', 'preference', 'fact', 'relation'];

/** 类型的中文名（界面下拉与列表都用它，避免用户看不懂英文枚举）。 */
export const KIND_LABELS = {
  general: '一般观察',
  appointment: '约定/待办',
  preference: '偏好',
  fact: '事实',
  relation: '关系'
};

const DEFAULT_STATE = () => ({ v: 1, chats: {}, archive: { lastSweepAt: 0, purges: [] }, stats: {} });

let cache = null;

function readJson(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/** 读整份状态（进程内缓存，按 mtime+size 感知外部改动）。 */
export function load() {
  if (cache) {
    try {
      const st = fs.statSync(STATE_FILE);
      if (`${st.mtimeMs}:${st.size}` === cache.key) return cache.state;
    } catch {
      return cache.state;
    }
  }
  const state = readJson(STATE_FILE, null) || DEFAULT_STATE();
  if (!state.chats || typeof state.chats !== 'object') state.chats = {};
  if (!state.archive || typeof state.archive !== 'object') state.archive = { lastSweepAt: 0, purges: [] };
  if (!Array.isArray(state.archive.purges)) state.archive.purges = [];
  if (!state.stats || typeof state.stats !== 'object') state.stats = {};
  let key = '0:0';
  try {
    const st = fs.statSync(STATE_FILE);
    key = `${st.mtimeMs}:${st.size}`;
  } catch { key = '0:0'; }
  cache = { state, key };
  return state;
}

/** 落盘（原子写 + 保留一份上一版备份）。 */
export function save() {
  if (!cache) return;
  const state = cache.state;
  try {
    fs.mkdirSync(MP_DIR, { recursive: true });
    try {
      if (fs.existsSync(STATE_FILE) && fs.statSync(STATE_FILE).size < 8 * 1024 * 1024) {
        fs.copyFileSync(STATE_FILE, BACKUP_FILE);
      }
    } catch { /* 备份失败不阻塞 */ }
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
    try {
      const st = fs.statSync(STATE_FILE);
      cache.key = `${st.mtimeMs}:${st.size}`;
    } catch { cache.key = `${Date.now()}:0`; }
  } catch (error) {
    console.warn('[memory-plus] 写状态失败:', error?.message ?? error);
  }
}

export function dataDir() { return MP_DIR; }

/** 某个会话的状态容器（不存在则建）。 */
export function chatState(chatKey, { create = true } = {}) {
  const state = load();
  const key = String(chatKey || '');
  if (!key) return null;
  let chat = state.chats[key];
  if (!chat) {
    if (!create) return null;
    chat = { members: {}, questions: [], lastConsolidatedAt: 0, lastIdleSweepAt: 0, pendingPrune: [] };
    state.chats[key] = chat;
  }
  if (!chat.members || typeof chat.members !== 'object') chat.members = {};
  if (!Array.isArray(chat.questions)) chat.questions = [];
  if (!Array.isArray(chat.pendingPrune)) chat.pendingPrune = [];
  if (!chat.lastConsolidatedAt) chat.lastConsolidatedAt = 0;
  return chat;
}

export function listChats() {
  const state = load();
  return Object.keys(state.chats || {});
}

function memberOf(chat, userId, name = '', { create = true } = {}) {
  const uid = String(userId || '').trim();
  if (!uid) return null;
  let m = chat.members[uid];
  if (!m) {
    if (!create) return null;
    m = { name: String(name || uid), short: [], labels: [] };
    chat.members[uid] = m;
  }
  if (!Array.isArray(m.short)) m.short = [];
  if (!Array.isArray(m.labels)) m.labels = [];
  if (name) m.name = String(name).slice(0, 60);
  return m;
}

/**
 * 花名册：只要**在群里说过话**就建一条成员记录（并累计发言数、首末次时间）。
 * 为什么需要：以前成员只有在"被模型记了一条"之后才会出现在记忆页里，
 * 结果 23 个发过言的人里只有 11 个有记忆，剩下 12 个像从没来过（用户实测反馈）。
 * 这条不花任何模型调用：谁说话谁就在册，印象/标签之后再慢慢长。
 * @returns {boolean} 是否新建了成员（调用方可据此决定要不要保存）
 */
export function touchMemberSeen(chatKey, userId, name = '', ts = 0) {
  const chat = chatState(chatKey);
  if (!chat) return false;
  const existed = !!chat.members[String(userId || '').trim()];
  const m = memberOf(chat, userId, name);
  if (!m) return false;
  const t = Number(ts) || Date.now();
  const seen = m.seen && typeof m.seen === 'object' ? m.seen : (m.seen = { count: 0, firstAt: 0, lastAt: 0 });
  seen.count = (Number(seen.count) || 0) + 1;
  if (!seen.firstAt || t < seen.firstAt) seen.firstAt = t;
  if (!seen.lastAt || t > seen.lastAt) seen.lastAt = t;
  return !existed;
}

/** 某会话里"还没有任何记忆"的成员（按发言数从多到少），给提取时优先照顾。 */
export function membersWithoutMemory(chatKey, limit = 8) {
  const chat = chatState(chatKey, { create: false });
  if (!chat) return [];
  return Object.entries(chat.members || {})
    .filter(([, m]) => !(m.short || []).length && !(m.labels || []).length)
    .map(([uid, m]) => ({ userId: uid, name: String(m.name || uid), count: Number(m.seen?.count) || 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, Math.max(0, Number(limit) || 8));
}

export function getMember(chatKey, userId) {
  const chat = chatState(chatKey, { create: false });
  if (!chat) return null;
  return memberOf(chat, userId, '', { create: false });
}

/** 整个会话的成员表：{ [userId]: { name, short:[], labels:[] } }（只读快照）。 */
export function chatMembers(chatKey) {
  const chat = chatState(chatKey, { create: false });
  if (!chat) return {};
  const out = {};
  for (const [uid, m] of Object.entries(chat.members || {})) {
    out[uid] = {
      name: String(m.name || uid),
      short: (m.short || []).map((s) => ({ ...s })),
      labels: (m.labels || []).map((l) => ({ ...l })),
      seen: m.seen ? { count: Number(m.seen.count) || 0, firstAt: Number(m.seen.firstAt) || 0, lastAt: Number(m.seen.lastAt) || 0 } : null
    };
  }
  return out;
}

/** 会话级的待办标记（整理排队 / 上次整理时间）。patch 为空时**不创建**会话条目。 */
export function chatFlags(chatKey, patch = null) {
  const chat = chatState(chatKey, { create: !!patch });
  if (!chat) return { lastConsolidatedAt: 0, pendingConsolidateAt: 0, lastAutoExtractAt: 0, lastRosterAt: 0, pendingPrune: [] };
  if (patch) {
    Object.assign(chat, patch);
    save();
  }
  // ⚠️ 这里是**白名单**返回：以前漏了 lastAutoExtractAt，导致"上次自动提取时间"永远读成 0，
  //    3 小时间隔形同虚设（会每 10 分钟就提取一次、白烧 token）。新增字段记得加进来。
  return {
    lastConsolidatedAt: Number(chat.lastConsolidatedAt) || 0,
    pendingConsolidateAt: Number(chat.pendingConsolidateAt) || 0,
    lastAutoExtractAt: Number(chat.lastAutoExtractAt) || 0,
    lastRosterAt: Number(chat.lastRosterAt) || 0,
    pendingPrune: (chat.pendingPrune || []).map((p) => ({ ...p }))
  };
}

// ── 标签压缩的排队队列 ──────────────────────────────────────────────────
//
// 为什么要持久化：批量压缩标签是"一个人一次模型调用"，网关限流（429）时如果就地失败，
// 用户看到的就是"整批标签都是空的"。所以改成"排队模式"：一次一个人、间隔 30 秒，
// 进度与失败名单都能在界面上看到。写进 state.json 才能扛住热重载/重启。

export function getLabelQueue(chatKey) {
  const chat = chatState(chatKey, { create: false });
  const q = chat?.labelQueue;
  if (!q) return { uids: [], done: [], failed: [], active: false, startedAt: 0, nextAt: 0, updatedAt: 0 };
  return {
    uids: Array.isArray(q.uids) ? [...q.uids] : [],
    done: Array.isArray(q.done) ? [...q.done] : [],
    failed: Array.isArray(q.failed) ? q.failed.map((f) => ({ ...f })) : [],
    active: q.active !== false && (Array.isArray(q.uids) && q.uids.length > 0),
    startedAt: Number(q.startedAt) || 0,
    nextAt: Number(q.nextAt) || 0,
    updatedAt: Number(q.updatedAt) || 0
  };
}

export function setLabelQueue(chatKey, uids = [], { done = [], failed = [], delayMs = 0 } = {}) {
  const chat = chatState(chatKey);
  chat.labelQueue = {
    uids: (Array.isArray(uids) ? uids : []).map(String).filter(Boolean),
    done: (Array.isArray(done) ? done : []).map(String),
    failed: (Array.isArray(failed) ? failed : []).map((f) => (typeof f === 'string' ? { userId: f, error: '' } : { userId: String(f?.userId || ''), error: String(f?.error || '').slice(0, 200) })),
    active: (Array.isArray(uids) ? uids.length : 0) > 0,
    startedAt: Number(chat.labelQueue?.startedAt) || Date.now(),
    // 刚被限流过就等一下再开工（否则立刻又被打回 429）；手动排队则立即开始
    nextAt: Date.now() + Math.max(0, Number(delayMs) || 0),
    updatedAt: Date.now()
  };
  save();
  return getLabelQueue(chatKey);
}

/** 取队首一个人并把它从队列里摘掉（同时记录结果与下一次的时间）。 */
export function shiftLabelQueue(chatKey, { result = '', error = '' } = {}) {
  const chat = chatState(chatKey, { create: false });
  if (!chat?.labelQueue) return null;
  const q = chat.labelQueue;
  const uid = (q.uids || [])[0] || '';
  if (!uid) return null;
  q.uids = q.uids.slice(1);
  if (error) q.failed = [...(q.failed || []), { userId: uid, error: String(error).slice(0, 200), at: Date.now() }];
  else q.done = [...(q.done || []), uid];
  if (result) q.lastResult = String(result).slice(0, 300);
  q.active = q.uids.length > 0;
  q.nextAt = Date.now() + 30000;          // 下一个在 30 秒后
  q.updatedAt = Date.now();
  save();
  return { uid, queue: getLabelQueue(chatKey) };
}

export function clearLabelQueue(chatKey) {
  const chat = chatState(chatKey, { create: false });
  if (!chat) return false;
  chat.labelQueue = { uids: [], done: [], failed: [], active: false, startedAt: 0, nextAt: 0, updatedAt: Date.now() };
  save();
  return true;
}

/** 哪些会话还有没跑完的标签队列（插件激活时用它把队列接着跑完）。 */
export function chatsWithLabelQueue() {
  const state = load();
  const out = [];
  for (const [chatKey, chat] of Object.entries(state.chats || {})) {
    if (chat?.labelQueue && Array.isArray(chat.labelQueue.uids) && chat.labelQueue.uids.length) out.push(chatKey);
  }
  return out;
}

// ── 内容归一与相似判定（用于"同一件事被反复提到"的累加）────────────────

/** 归一化：去掉空白、标点、以及常见的语气词，便于比对同一件事。 */
export function normalizeContent(raw) {
  return String(raw || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？、；：""''（）()【】\[\]…—～~,.!?;:'"`]/g, '')
    .toLowerCase();
}

/** 两条印象是不是"同一件事"。宁可判松一点：漏合并会让人物档案越来越碎。 */
export function sameImpression(a, b) {
  const x = normalizeContent(a);
  const y = normalizeContent(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length >= 4 && y.length >= 4 && (x.includes(y) || y.includes(x))) return true;
  // 字符二元组 Jaccard 相似度：处理"换了语序/加了个形容词"的同一件事
  if (x.length < 4 || y.length < 4) return false;
  const grams = (s) => {
    const out = new Set();
    for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
    return out;
  };
  const A = grams(x);
  const B = grams(y);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  const union = A.size + B.size - inter;
  return union > 0 && inter / union >= 0.72;
}

export function contentHash(content) {
  return crypto.createHash('sha1').update(normalizeContent(content)).digest('hex').slice(0, 12);
}

function newId(prefix) {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// ── 约定类识别（长期印象里没有类型字段，只能按文本兜底识别）──────────────

const APPOINTMENT_HINTS = [
  '约定', '说好', '讲好', '约好', '答应', '承诺', '保证', '别忘了', '别忘记', '记得',
  '提醒我', '提醒你', '到时候', '明天', '后天', '大后天', '下周', '下个月', '周六', '周日',
  '几点', '见面', '一起玩', '一起打', '请客', '欠', '生日', '纪念日', '考试', '见面', '赴约'
];

/** 文本看起来是不是"约定/承诺/待办"类。用于给历史遗留印象补类型。 */
export function looksLikeAppointment(content) {
  const t = String(content || '');
  if (!t) return false;
  return APPOINTMENT_HINTS.some((k) => t.includes(k));
}

// ── 短期印象读写 ────────────────────────────────────────────────────────

/**
 * 记一条短期记忆。同一件事重复记录 → 不新增，改为累加提及次数（hits）并刷新时间。
 *
 * 提及次数的口径（用户明确要求）：
 *   · 手工记的（source='manual'）从 **0** 开始 —— 手工记的是"你要它记住"，不是"群里提到过"；
 *     界面上 0 不显示提及，再记一次变 1 才开始显示。
 *   · 模型记的（source='tool'/'archive'）从 **1** 开始 —— 它已经是一次真实观察了。
 * @returns {{ item: object, merged: boolean }}
 */
export function addShort(chatKey, userId, name, { content, kind = 'general', tags = [], source = 'tool', note = '', hits = null } = {}) {
  const text = String(content || '').trim();
  if (!text) throw new Error('记忆内容为空');
  const chat = chatState(chatKey);
  const member = memberOf(chat, userId, name);
  if (!member) throw new Error('缺少有效的 userId');
  const k = KINDS.includes(kind) ? kind : 'general';
  const now = Date.now();
  const src = String(source || 'tool').slice(0, 20);
  const hit = member.short.find((s) => sameImpression(s.content, text));
  if (hit) {
    hit.hits = (Number(hit.hits) || 0) + 1;
    hit.lastHitAt = now;
    hit.updatedAt = now;
    // 类型一旦升级成"约定"就保持约定（约定比一般观察更硬）
    if (k === 'appointment') hit.kind = 'appointment';
    if (note) hit.note = String(note).slice(0, 200);
    const addTags = Array.isArray(tags) ? tags : [];
    for (const t of addTags) {
      const tag = String(t || '').trim().slice(0, 12);
      if (tag && !hit.tags.includes(tag)) hit.tags.push(tag);
    }
    save();
    return { item: { ...hit }, merged: true };
  }
  const startHits = hits === null || hits === undefined
    ? (src === 'manual' ? 0 : 1)
    : Math.max(0, Number(hits) || 0);
  const item = {
    id: newId('s'),
    content: text.slice(0, 400),
    kind: k,
    tags: (Array.isArray(tags) ? tags : []).map((t) => String(t || '').trim().slice(0, 12)).filter(Boolean).slice(0, 6),
    createdAt: now,
    updatedAt: now,
    hits: startHits,
    lastHitAt: now,
    source: src,
    note: note ? String(note).slice(0, 200) : ''
  };
  member.short.push(item);
  // 单人短期印象不设死上限，但超过 60 条时丢最旧且提及最少的（防长期无人整理时无限膨胀）
  if (member.short.length > 60) {
    member.short.sort((a, b) => (b.hits - a.hits) || (b.lastHitAt - a.lastHitAt));
    member.short = member.short.slice(0, 60);
  }
  save();
  return { item: { ...item }, merged: false };
}

export function removeShort(chatKey, userId, shortId) {
  const chat = chatState(chatKey, { create: false });
  if (!chat) return false;
  const member = memberOf(chat, userId, '', { create: false });
  if (!member) return false;
  const before = member.short.length;
  member.short = member.short.filter((s) => s.id !== shortId);
  const removed = member.short.length !== before;
  if (removed) save();
  return removed;
}

/** 改一条短期记忆的类型（面板用）。 */
export function setShortKind(chatKey, userId, shortId, kind) {
  const chat = chatState(chatKey, { create: false });
  if (!chat) return null;
  const member = memberOf(chat, userId, '', { create: false });
  if (!member) return null;
  const item = (member.short || []).find((s) => s.id === shortId);
  if (!item) return null;
  item.kind = KINDS.includes(kind) ? kind : 'general';
  item.updatedAt = Date.now();
  save();
  return { ...item };
}

/**
 * 晋升：把一条短期记忆转成长期记忆。
 *
 * 落点（用户明确要求）：
 *   · **短期那条直接删掉** —— 晋升之后它已经是长期记忆了，不再留一行"已晋升（可降级）"；
 *     长期记忆只能删、不能降级。
 *   · 长期侧的旁注（类型 / 提及次数 / 晋升理由）按正文挂上去，提及次数**原样带过去**
 *     （不再额外 +1，避免"提及 2 的短期"变成"提及 4 的长期"）。
 * @returns {{content:string, kind:string, hits:number, reason:string}|null}
 */
export function promoteShortItem(chatKey, userId, shortId, { reason = '', by = 'model' } = {}) {
  const chat = chatState(chatKey, { create: false });
  if (!chat) return null;
  const member = memberOf(chat, userId, '', { create: false });
  if (!member) return null;
  const idx = (member.short || []).findIndex((s) => s.id === shortId);
  if (idx < 0) return null;
  const item = member.short[idx];
  const content = String(item.content || '').slice(0, 300);
  const reasonText = String(reason || '').slice(0, 200);
  const hits = Math.max(0, Number(item.hits) || 0);
  const kind = item.kind === 'appointment' || looksLikeAppointment(content) ? 'appointment' : (item.kind || 'general');
  const map = longMetaMap(chatKey);
  const key = contentHash(content);
  const prev = map[key] || {};
  map[key] = {
    ...prev,
    content,
    kind,
    tags: Array.isArray(item.tags) ? item.tags : (prev.tags || []),
    hits,
    reason: reasonText || prev.reason || '',
    promotedAt: Date.now(),
    promotedBy: String(by).slice(0, 20),
    updatedAt: Date.now()
  };
  // 短期那条就此消失（它已经是长期记忆了）
  member.short.splice(idx, 1);
  save();
  return { content, kind, hits, reason: reasonText };
}

// ── 标签（印象压缩成刻板印象词汇）──────────────────────────────────────

export function setLabels(chatKey, userId, tags = [], { sourceIds = [], pinned = false } = {}) {
  const chat = chatState(chatKey);
  const member = memberOf(chat, userId);
  if (!member) return [];
  const now = Date.now();
  const seen = new Set();
  const next = [];
  for (const raw of tags) {
    const tag = String(raw || '').trim().replace(/^[·、,，\s]+|[·、,，\s]+$/g, '').slice(0, 12);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    const old = member.labels.find((l) => l.tag === tag);
    next.push({
      tag,
      createdAt: old?.createdAt || now,
      pinned: old ? old.pinned === true : false,
      sourceIds: Array.isArray(sourceIds) && sourceIds.length ? sourceIds.slice(0, 40) : (old?.sourceIds || [])
    });
  }
  // 手工钉住的标签永远保留
  for (const l of member.labels) {
    if (l.pinned && !seen.has(l.tag)) { next.push(l); seen.add(l.tag); }
  }
  member.labels = next;
  save();
  return member.labels.map((l) => ({ ...l }));
}

export function addLabel(chatKey, userId, tag, { pinned = false } = {}) {
  const member = getMember(chatKey, userId);
  if (!member) return null;
  const t = String(tag || '').trim().slice(0, 12);
  if (!t) return null;
  const existing = member.labels.find((l) => l.tag === t);
  if (existing) {
    if (pinned) existing.pinned = true;
  } else {
    member.labels.push({ tag: t, createdAt: Date.now(), pinned: !!pinned, sourceIds: [] });
  }
  save();
  return member.labels.map((l) => ({ ...l }));
}

export function removeLabel(chatKey, userId, tag) {
  const chat = chatState(chatKey, { create: false });
  if (!chat) return false;
  const member = memberOf(chat, userId, '', { create: false });
  if (!member) return false;
  const before = member.labels.length;
  member.labels = member.labels.filter((l) => l.tag !== tag);
  if (member.labels.length !== before) { save(); return true; }
  return false;
}

// ── 长期印象的旁注（类型 / 标签 / 提及次数）────────────────────────────

export function longMetaMap(chatKey) {
  const chat = chatState(chatKey, { create: false });
  if (!chat) return {};
  if (!chat.longMeta || typeof chat.longMeta !== 'object') chat.longMeta = {};
  return chat.longMeta;
}

export function getLongMeta(chatKey, content) {
  return longMetaMap(chatKey)[contentHash(content)] || null;
}

export function setLongMeta(chatKey, content, patch = {}) {
  const map = longMetaMap(chatKey);
  const key = contentHash(content);
  const prev = map[key] || { content: String(content).slice(0, 300) };
  map[key] = { ...prev, ...patch, content: String(content).slice(0, 300), updatedAt: Date.now() };
  return map[key];
}

export function forgetLongMeta(chatKey, content) {
  const map = longMetaMap(chatKey);
  const key = contentHash(content);
  if (!map[key]) return false;
  delete map[key];
  save();
  return true;
}

/** 给长期印象累加一次"被提到"（模型主动汇报或重复记录时调用）。 */
export function bumpLongMeta(chatKey, content, kind = '') {
  const meta = setLongMeta(chatKey, content, {});
  meta.hits = (Number(meta.hits) || 0) + 1;
  meta.lastHitAt = Date.now();
  if (kind && KINDS.includes(kind)) meta.kind = kind;
  if (!meta.kind) meta.kind = looksLikeAppointment(content) ? 'appointment' : 'general';
  save();
  return meta;
}

// ── 过期清理 ────────────────────────────────────────────────────────────

/**
 * 删除超过 ttlDays 天、且没有被晋升的短期印象。
 * @returns {{ removed: number, chats: number }}
 */
export function expireShort(ttlDays, now = Date.now()) {
  const ttl = Math.max(1, Number(ttlDays) || 14) * 86400000;
  const state = load();
  let removed = 0;
  let chats = 0;
  for (const chat of Object.values(state.chats || {})) {
    let touched = false;
    for (const member of Object.values(chat.members || {})) {
      const before = member.short.length;
      member.short = member.short.filter((s) => {
        const base = Number(s.createdAt) || 0;
        return now - base < ttl;
      });
      if (member.short.length !== before) { removed += before - member.short.length; touched = true; }
    }
    if (touched) chats += 1;
  }
  if (removed) {
    state.stats = state.stats || {};
    state.stats.expired = (Number(state.stats.expired) || 0) + removed;
    save();
  }
  return { removed, chats };
}

// ── 待主人裁决的问题 ────────────────────────────────────────────────────

export function addQuestion(chatKey, { userId = '', name = '', shortId = '', question = '' } = {}) {
  const chat = chatState(chatKey);
  const q = {
    id: newId('q'),
    userId: String(userId || '').slice(0, 20),
    name: String(name || '').slice(0, 60),
    shortId: String(shortId || '').slice(0, 40),
    question: String(question || '').slice(0, 300),
    askedAt: Date.now(),
    status: 'pending',
    answer: '',
    answeredAt: 0,
    decision: ''
  };
  chat.questions.unshift(q);
  if (chat.questions.length > 50) chat.questions = chat.questions.slice(0, 50);
  save();
  return { ...q };
}

export function listQuestions(chatKey, { status = '' } = {}) {
  const chat = chatState(chatKey, { create: false });
  if (!chat) return [];
  return chat.questions
    .filter((q) => (status ? q.status === status : true))
    .map((q) => ({ ...q }));
}

/** 找最近一次发出的问题（用于把主人的回话对上去）。 */
export function latestPendingQuestion(chatKey) {
  const chat = chatState(chatKey, { create: false });
  if (!chat) return null;
  const q = chat.questions.find((x) => x.status === 'pending');
  return q ? { ...q } : null;
}

export function answerQuestion(chatKey, questionId, answer) {
  const chat = chatState(chatKey, { create: false });
  if (!chat) return null;
  const q = chat.questions.find((x) => x.id === questionId);
  if (!q) return null;
  q.answer = String(answer || '').slice(0, 600);
  q.answeredAt = Date.now();
  q.status = 'answered';
  save();
  return { ...q };
}

export function resolveQuestion(chatKey, questionId, decision, { shortId = '', action = '' } = {}) {
  const chat = chatState(chatKey, { create: false });
  if (!chat) return null;
  const q = chat.questions.find((x) => x.id === questionId);
  if (!q) return null;
  q.decision = String(decision || '').slice(0, 300);
  q.resolvedAt = Date.now();
  q.status = 'resolved';
  q.resolvedAction = String(action || '').slice(0, 40);
  save();
  void shortId;
  return { ...q };
}

/** 全局最近一次询问时间（按 userId 记冷却）。 */
export function lastAskAt(chatKey, userId) {
  const chat = chatState(chatKey, { create: false });
  if (!chat) return 0;
  const list = chat.questions.filter((q) => String(q.userId) === String(userId));
  return list.reduce((n, q) => Math.max(n, Number(q.askedAt) || 0), 0);
}

// ── 待执行的存档清理（人工在面板上指定时间段 → 该会话下次运行时生效）────

export function addPendingPrune(chatKey, { from = 0, to = 0, note = '' } = {}) {
  const chat = chatState(chatKey);
  chat.pendingPrune.push({ id: newId('p'), from: Number(from) || 0, to: Number(to) || 0, note: String(note || '').slice(0, 120), createdAt: Date.now() });
  save();
  return chat.pendingPrune.length;
}

export function takePendingPrune(chatKey) {
  const chat = chatState(chatKey, { create: false });
  if (!chat || !chat.pendingPrune.length) return [];
  const out = chat.pendingPrune.map((p) => ({ ...p }));
  chat.pendingPrune = [];
  save();
  return out;
}

export function listPendingPrune(chatKey) {
  const chat = chatState(chatKey, { create: false });
  return chat ? chat.pendingPrune.map((p) => ({ ...p })) : [];
}

// ── 整理与清理的时间戳 ──────────────────────────────────────────────────

export function setLastConsolidated(chatKey, at = Date.now()) {
  const chat = chatState(chatKey);
  chat.lastConsolidatedAt = Number(at) || Date.now();
  save();
}

export function setArchiveSweep(at = Date.now()) {
  const state = load();
  state.archive.lastSweepAt = Number(at) || Date.now();
  save();
}

export function archiveSweepState() {
  const state = load();
  return { lastSweepAt: Number(state.archive?.lastSweepAt) || 0, purges: (state.archive?.purges || []).slice(0, 50) };
}

export function recordPurge(entry) {
  const state = load();
  state.archive.purges.unshift({ at: Date.now(), ...entry });
  state.archive.purges = state.archive.purges.slice(0, 200);
  state.stats = state.stats || {};
  state.stats.purged = (Number(state.stats.purged) || 0) + (Number(entry?.removed) || 0);
  save();
}

export function stats() {
  const state = load();
  const st = { short: 0, labels: 0, members: 0, chats: 0, promoted: 0, expired: 0, purged: 0, pendingQuestions: 0 };
  for (const chat of Object.values(state.chats || {})) {
    st.chats += 1;
    for (const member of Object.values(chat.members || {})) {
      st.members += 1;
      st.short += (member.short || []).length;
      st.labels += (member.labels || []).length;
      st.promoted += (member.short || []).filter((s) => s.promotedAt).length;
    }
    st.pendingQuestions += (chat.questions || []).filter((q) => q.status === 'pending').length;
  }
  st.expired = Number(state.stats?.expired) || 0;
  st.purged = Number(state.stats?.purged) || 0;
  return st;
}

/** 测试用：丢掉进程内缓存。 */
export function _resetCache() { cache = null; }
