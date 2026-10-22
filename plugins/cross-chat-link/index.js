// 跨会话认人（确定性型 / plugins/，纯 hooks）
//
// ── 解决的问题（用户实测反馈）────────────────────────────────────────────
// 群友在群里聊熟了，转头私聊她，再回群里问她"刚才私聊说的那个" —— 她认不出这是
// 同一个人，两边的态度、称呼、记忆全对不上。原因是 0.4 的记忆是**按会话**存的：
//   data/memory/<chatKey>/<uid>.json  →  { userId, name, impressions[] }
// 群里的印象只挂在 group:xxx 下，私聊时读不到，反之亦然。
//
// ── 做法 ──────────────────────────────────────────────────────────────────
// 谁这轮说话，就把**他在别的会话里**的印象摘要一起带进提示词，并说明当前在哪个会话：
//   【这个人你也认识】某某(QQ:123456789) · 现在是私聊
//   · 你在「群 123456789」里对他的印象：常聊某类游戏，熟悉某个术语…｜爱调侃昵称…
//   · 他在群里的最后一句话（23:10）：…
//   · 私聊内容属于隐私：群里别复述他私聊说过的话
//
// 为什么不用别的会话的**聊天记录**：那是 MB 级的大文件（本机群记录 2.1MB），
// 每轮解析太浪费；而 memory/*/uid.json 只有几百字节，且本来就是"印象"。
// 所以这里只读小文件：memory 目录下的按人印象 + （小会话的）最后一句。
//
// 不变量：没有跨会话记忆的人 → 一个字都不加；关掉插件 → 行为回到 0.4 原生。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from '../../src/config.js';
import * as promptCore from '../../src/prompt.js';

/**
 * 把人物卡注入到请求**末尾**（保住 system 的缓存前缀）。
 *
 * ⚠️ 可移植性（上传市场前必须处理）：`appendDynamicTail` 是较新的 0.4 核心才有
 * 的函数（为前缀缓存命中率而加）。装到没有它的版本上时，命名导入不会报错，
 * 但**调用那一刻**会抛 "appendDynamicTail is not a function"，整个插件失效。
 * 所以这里做存在性回退：有就用核心的，没有就自己追加到最后一条 user 消息。
 */
const appendToSystem = typeof promptCore.appendDynamicTail === 'function'
  ? promptCore.appendDynamicTail
  : (messages, text) => {
    if (!Array.isArray(messages) || !text) return false;
    const block = `\n\n${String(text).trim()}`;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (!m || m.role !== 'user') continue;
      if (typeof m.content === 'string') { m.content += block; return true; }
      if (Array.isArray(m.content)) { m.content.push({ type: 'text', text: block }); return true; }
    }
    messages.push({ role: 'user', content: block.trim() });
    return true;
  };

/** 出厂默认值（与 plugin.json 的 settings 保持一致）。 */
const DEFAULTS = {
  enabled: true,
  maxImpressions: 3,
  maxOtherChats: 2,
  includeRecentLine: true,
  privacyNote: true
};

const MEMORY_DIR = path.join(DATA_DIR, 'memory');
const MESSAGES_DIR = path.join(DATA_DIR, 'messages');
/** 大文件不做整段解析（KB 级以内才取最后一句）。 */
const RECENT_LINE_MAX_BYTES = 512 * 1024;

let api = null;
/** 本轮触发的人（before-context 收集，before-llm-messages 消费）。 */
const pendingPeople = new Map();
/** 目录列表缓存：会话集合变化很慢，按 30 秒失效。 */
let chatDirCache = { at: 0, chats: [] };

function settings() {
  const raw = (api && typeof api.config === 'function' ? api.config() : null) || {};
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

const chatLabel = (chatKey) => {
  const [kind, id] = String(chatKey || '').split(':');
  if (kind === 'group') return `群 ${id}`;
  if (kind === 'private') return `私聊 ${id}`;
  return String(chatKey || '?');
};

/** data/memory 下有哪些会话目录（排掉 backups）。 */
function listMemoryChats() {
  const now = Date.now();
  if (now - chatDirCache.at < 30000 && chatDirCache.chats.length) return chatDirCache.chats;
  const chats = [];
  try {
    for (const e of fs.readdirSync(MEMORY_DIR, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (e.name === 'backups') continue;
      if (!/^(group|private)_\d+$/.test(e.name)) continue;
      const [kind, id] = e.name.split('_');
      chats.push({ chatKey: `${kind}:${id}`, dir: path.join(MEMORY_DIR, e.name) });
    }
  } catch { /* 没有记忆目录 */ }
  chatDirCache = { at: now, chats };
  return chats;
}

/**
 * 候选会话 = 有记忆的 ∪ 有消息记录的。
 *
 * 为什么两边都要（2026-09-20 补）：印象是**定时巩固**出来的（默认 10 分钟一次），
 * 而用户最常遇到的场景恰恰是"刚私聊完就回群里问" —— 那时私聊还没有印象文件，
 * 只看 memory 目录会漏掉最新鲜的那段，等于没修。消息文件是即时写的，用它兜底。
 */
function listKnownChats() {
  const map = new Map();
  for (const c of listMemoryChats()) map.set(c.chatKey, { ...c, hasMemory: true });
  try {
    for (const f of fs.readdirSync(MESSAGES_DIR)) {
      const m = /^(group|private)_(\d+)\.json$/.exec(f);
      if (!m) continue;
      const chatKey = `${m[1]}:${m[2]}`;
      const cur = map.get(chatKey);
      if (cur) cur.hasMessages = true;
      else map.set(chatKey, { chatKey, dir: null, hasMemory: false, hasMessages: true });
    }
  } catch { /* 没有消息目录 */ }
  return [...map.values()];
}

/** 读某人在某个会话里的印象（小文件，失败当没有）。 */
function readPersonMemory(chat, uid) {
  if (!chat.dir) return null;
  try {
    const file = path.join(chat.dir, `${uid}.json`);
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const impressions = (Array.isArray(data?.impressions) ? data.impressions : [])
      .map((x) => String(x?.content ?? x ?? '').trim())
      .filter(Boolean);
    return { chatKey: chat.chatKey, name: String(data?.name || ''), impressions, updatedAt: Number(data?.updatedAt) || 0 };
  } catch {
    return null;
  }
}

/** 小会话里取对方最后一句（大文件直接跳过）。 */
function lastLineFrom(chatKey, uid) {
  const [kind, id] = String(chatKey).split(':');
  const file = path.join(MESSAGES_DIR, `${kind}_${id}.json`);
  try {
    const st = fs.statSync(file);
    if (st.size > RECENT_LINE_MAX_BYTES) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(data?.messages) ? data.messages : [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const m = list[i];
      if (!m || m.self || m.isPoke) continue;
      if (String(m.senderId) !== String(uid)) continue;
      const text = String(m.text || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const d = new Date(Number(m.ts) || 0);
      const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      return { text: text.slice(0, 60), at: hhmm };
    }
  } catch { /* 没记录 */ }
  return null;
}

/**
 * 组装一个人的跨会话卡片。没有"别的会话里的记忆"就返回 null——
 * 这是本插件最重要的不变量：认不出就不加字，绝不凭空编。
 */
function buildPersonCard(uid, currentChatKey, s) {
  const notes = (() => { try { return getConfig()?.memberNotes || {}; } catch { return {}; } })();
  const others = [];
  for (const chat of listKnownChats()) {
    if (chat.chatKey === currentChatKey) continue;
    const mem = readPersonMemory(chat, uid);
    const last = s.includeRecentLine !== false ? lastLineFrom(chat.chatKey, uid) : null;
    // 印象或最近发言，有一样就算"你在别处认识他"（刚私聊完还没巩固出印象时靠后者兜底）
    if (!mem && !last) continue;
    if (mem && !mem.impressions.length && !mem.name && !last) continue;
    others.push({ chatKey: chat.chatKey, name: mem?.name || '', impressions: mem?.impressions || [], updatedAt: mem?.updatedAt || 0, last });
  }
  if (!others.length) return null;
  // 有印象的、且印象新的排前面；只有最近发言的排后面
  others.sort((a, b) => (b.impressions.length - a.impressions.length) || ((b.updatedAt || 0) - (a.updatedAt || 0)));

  const pick = others.slice(0, Math.max(1, Number(s.maxOtherChats) || 2));
  const lines = [];
  const who = notes[uid] || pick.find((m) => m.name)?.name || `QQ:${uid}`;
  // 当前会话怎么称呼：私聊里对面就是他本人，群里则要点明是哪个群
  const where = String(currentChatKey).startsWith('private:')
    ? '你们现在是私聊'
    : `你现在在${chatLabel(currentChatKey)}里跟他说话`;
  lines.push(`【这个人你也认识】${who}(QQ:${uid}) · ${where}`);

  for (const mem of pick) {
    const imps = mem.impressions.slice(-Math.max(1, Number(s.maxImpressions) || 3));
    if (imps.length) {
      lines.push(`· 你在「${chatLabel(mem.chatKey)}」里对他的印象：${imps.map((x) => x.slice(0, 60)).join('｜')}`);
    } else if (mem.name) {
      lines.push(`· 你在「${chatLabel(mem.chatKey)}」里见过他（${mem.name}）`);
    }
    if (mem.last) lines.push(`· 他最近在${chatLabel(mem.chatKey)}说过（${mem.last.at}）：「${mem.last.text}」`);
  }

  // 私聊内容不进群：这是隐私，不是记忆同步
  const otherIsPrivate = pick.some((m) => String(m.chatKey).startsWith('private:'));
  if (s.privacyNote !== false && otherIsPrivate && String(currentChatKey).startsWith('group:')) {
    lines.push('· 私聊内容属于隐私：在群里**别复述**他私聊说过的话，只当自己知道这个人。');
  }
  lines.push('（同一个人的两边记忆要一致：称呼、态度、你已知的事都按上面来，别当成两个陌生人。）');
  return lines.join('\n');
}

// 注入位置由 prompt.js 的 appendDynamicTail 决定（请求最末尾），不再动 system 前缀。
// ── 生命周期 ──────────────────────────────────────────────────────────────

export function setup(a) {
  api = a;
}

export function activate() {
  const chats = listMemoryChats();
  api?.log?.(`跨会话认人已启用：记忆里 ${chats.length} 个会话（${chats.map((c) => chatLabel(c.chatKey)).join('、') || '暂无'}）`);
}

export function available() {
  return settings().enabled !== false;
}

// ── 钩子 ──────────────────────────────────────────────────────────────────

export const hooks = {
  /** 记下本轮说话的人（只留 uid，别的都不需要）。 */
  async 'before-context'(ctx = {}) {
    try {
      const entries = Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries : [];
      const uids = [];
      for (const e of entries) {
        const uid = String(e?.senderId ?? '').trim();
        if (uid && uid !== 'self' && !uids.includes(uid)) uids.push(uid);
      }
      pendingPeople.set(String(ctx.sessionId || ctx.chatKey || ''), {
        chatKey: String(ctx.chatKey || ''),
        uids
      });
      if (pendingPeople.size > 50) {
        const first = pendingPeople.keys().next().value;
        pendingPeople.delete(first);
      }
    } catch { /* 收集失败只是少一张人物卡 */ }
  },

  /** 命中才加行：这个人你在别的会话里认识。 */
  async 'before-llm-messages'(ctx = {}) {
    const s = settings();
    if (s.enabled === false) return;
    const key = String(ctx.sessionId || ctx.chatKey || '');
    const info = pendingPeople.get(key) || null;
    pendingPeople.delete(key);
    if (!info || !info.uids.length) return;
    const chatKey = info.chatKey || String(ctx.chatKey || '');

    const cards = [];
    for (const uid of info.uids.slice(0, 3)) {
      const card = buildPersonCard(uid, chatKey, s);
      if (card) cards.push(card);
    }
    if (!cards.length) return;
    appendToSystem(ctx.messages, cards.join('\n\n'));
  }
};

// ── 能力：排查用 ─────────────────────────────────────────────────────────

export const providers = {
  /** 看某人现在能凑出什么样的跨会话卡片（args: { uid, chatKey }）。 */
  'memory.person-card': (args = {}) => {
    const uid = String(args?.uid || '').trim();
    const chatKey = String(args?.chatKey || '');
    if (!uid) return { ok: false, error: '需要 uid' };
    const card = buildPersonCard(uid, chatKey, settings());
    return {
      ok: true,
      uid,
      chatKey,
      known: Boolean(card),
      card,
      chats: listMemoryChats().map((c) => c.chatKey)
    };
  }
};
