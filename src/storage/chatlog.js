// 聊天存档的物理格式：
//   messages/<chat>.json    快照（旧版本就是这个文件，天然向后兼容）
//   messages/<chat>.jsonl   快照之后的增量事件，只追加
//
// 为什么不直接改快照：一条消息就重写整个数组是 O(n) 写放大；
// 追加一行事件是 O(1)，只有压缩时才整写快照。
//
// 事件协议（每行一个 JSON，seq 单调递增）：
//   { t:'m',      seq, n, m }                 追加一条消息（n = 新的 nextLocalId）
//   { t:'read',   seq, ids?:[], all?:true }   标记已读
//   { t:'unread', seq, ids:[] }               标记未读（重试）
//   { t:'recall', seq, mid }                  按 QQ 消息 id 标记撤回
//   { t:'edit',   seq, id, text?, media? }    改写文本/媒体
//   { t:'del',    seq, ids:[] }               删除消息
//   { t:'trim',   seq, minId }                丢弃 id < minId 的旧消息
//   { t:'clear',  seq }                       清空消息（保留 nextLocalId）
//
// 崩溃恢复：快照写成功后才会截断 delta；如果进程在两者之间退出，
// 重放时靠 seq <= snapshot.seq 跳过已合并事件，不会重复。delta 末尾
// 允许是半行，readJsonl 会忽略它，下一次 append 前自动补换行。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import {
  appendJsonl, ensureDir, fileSize, readJsonl, readJsonSafe, writeJsonAtomic
} from './atomic.js';

const MESSAGES_DIR = path.join(DATA_DIR, 'messages');
const SNAPSHOT_VERSION = 2;

/** 压缩阈值：delta 事件数 / 字节数，任一命中就折叠进快照。 */
export const COMPACT_EVENT_THRESHOLD = 2000;
export const COMPACT_BYTE_THRESHOLD = 2 * 1024 * 1024;

// 非枚举的内部索引：加速重放/查找，不会进 JSON。
const IDS = Symbol('chatIds');
const BYID = Symbol('chatById');

function safeName(chatKey) {
  return String(chatKey).replace(/[^a-z0-9_]/gi, '_');
}

/** 存档根目录（列表/迁移用）。 */
export function messagesDir() {
  return MESSAGES_DIR;
}

/** 某会话的快照/增量文件路径。 */
export function chatPaths(chatKey) {
  const base = path.join(MESSAGES_DIR, safeName(chatKey));
  return { base, snapshot: `${base}.json`, delta: `${base}.jsonl` };
}

export function emptyChatState(chatKey) {
  return { version: SNAPSHOT_VERSION, chatKey: String(chatKey), seq: 0, nextLocalId: 1, messages: [] };
}

function idSet(state) {
  if (!state[IDS]) state[IDS] = new Set(state.messages.map((m) => m.id));
  return state[IDS];
}

function byId(state) {
  if (!state[BYID]) state[BYID] = new Map(state.messages.map((m) => [m.id, m]));
  return state[BYID];
}

function rebuildIndex(state) {
  state[IDS] = new Set(state.messages.map((m) => m.id));
  state[BYID] = new Map(state.messages.map((m) => [m.id, m]));
}

function normalizeSnapshot(raw, chatKey) {
  const state = emptyChatState(chatKey);
  if (raw && typeof raw === 'object') {
    state.version = Number(raw.version) || 1;
    state.seq = Number(raw.seq) || 0;
    state.nextLocalId = Math.max(1, Number(raw.nextLocalId) || 1);
    state.messages = Array.isArray(raw.messages)
      ? raw.messages
        .filter((m) => m && Number.isFinite(Number(m.id)))
        .map((m) => ({ ...m, id: Number(m.id) }))
      : [];
  }
  let maxId = 0;
  for (const m of state.messages) maxId = Math.max(maxId, Number(m.id) || 0);
  state.nextLocalId = Math.max(state.nextLocalId, maxId + 1);
  rebuildIndex(state);
  return state;
}

/**
 * 把一条事件应用到内存状态。幂等：seq 已合并过的事件直接忽略。
 * @param {object} state
 * @param {object} event
 */
export function applyChatEvent(state, event) {
  if (!event || typeof event !== 'object') return false;
  const seq = Number(event.seq) || 0;
  if (seq && seq <= (Number(state.seq) || 0)) return false;
  const ids = idSet(state);
  const map = byId(state);

  switch (event.t) {
    case 'm': {
      const raw = event.m;
      if (!raw || !Number.isFinite(Number(raw.id))) break;
      const m = { ...raw, id: Number(raw.id) };
      if (!ids.has(m.id)) {
        state.messages.push(m);
        ids.add(m.id);
        map.set(m.id, m);
      }
      state.nextLocalId = Math.max(
        Number(state.nextLocalId) || 1,
        Number(event.n) || 0,
        m.id + 1
      );
      break;
    }
    case 'read': {
      if (event.all) {
        for (const m of state.messages) m.read = true;
      } else {
        for (const id of event.ids || []) {
          const m = map.get(Number(id));
          if (m) m.read = true;
        }
      }
      break;
    }
    case 'unread': {
      for (const id of event.ids || []) {
        const m = map.get(Number(id));
        if (m && !m.self) m.read = false;
      }
      break;
    }
    case 'recall': {
      const target = String(event.mid);
      for (const m of state.messages) {
        if (String(m.mid) === target) { m.recalled = true; m.read = true; }
      }
      break;
    }
    case 'edit': {
      const m = map.get(Number(event.id));
      if (m) {
        if (event.text != null) m.text = String(event.text);
        if (Array.isArray(event.media)) m.media = event.media;
      }
      break;
    }
    case 'del': {
      const drop = new Set((event.ids || []).map(Number));
      if (!drop.size) break;
      state.messages = state.messages.filter((m) => !drop.has(m.id));
      rebuildIndex(state);
      break;
    }
    case 'trim': {
      const minId = Number(event.minId) || 0;
      if (!minId) break;
      state.messages = state.messages.filter((m) => m.id >= minId);
      rebuildIndex(state);
      break;
    }
    case 'clear': {
      state.messages = [];
      rebuildIndex(state);
      break;
    }
    default:
      break;
  }
  if (seq) state.seq = Math.max(Number(state.seq) || 0, seq);
  return true;
}

/**
 * 读一个会话的完整状态（快照 + 增量回放）。
 * @returns {{ state: object, deltaCount: number, deltaBytes: number, badLines: number }}
 */
export function loadChatState(chatKey) {
  const { snapshot, delta } = chatPaths(chatKey);
  const state = normalizeSnapshot(readJsonSafe(snapshot, null), chatKey);
  const events = readJsonl(delta);
  for (const event of events) applyChatEvent(state, event);
  return {
    state,
    deltaCount: events.length,
    deltaBytes: fileSize(delta),
    badLines: Number(events.badLines) || 0
  };
}

/** 追加一条事件（自动分配 seq，并同步应用到传入的 state）。 */
export function appendChatEvent(chatKey, state, event) {
  const seq = (Number(state.seq) || 0) + 1;
  const full = { seq, ...event };
  applyChatEvent(state, full);
  appendJsonl(chatPaths(chatKey).delta, full);
  return full;
}

/** 把当前状态写成快照并清空增量；返回快照字节数。 */
export function compactChat(chatKey, state) {
  const { snapshot, delta } = chatPaths(chatKey);
  const payload = {
    version: SNAPSHOT_VERSION,
    chatKey: String(state.chatKey ?? chatKey),
    seq: Number(state.seq) || 0,
    nextLocalId: Number(state.nextLocalId) || 1,
    messages: state.messages
  };
  writeJsonAtomic(snapshot, payload, { pretty: 1 });
  ensureDir(path.dirname(delta));
  // 确保文件存在再截断（不存在时 truncate 会 ENOENT）；空 delta 直接删掉，少一个文件
  fs.closeSync(fs.openSync(delta, 'a'));
  fs.truncateSync(delta, 0);
  try { fs.rmSync(delta, { force: true }); } catch { /* ignore */ }
  return fileSize(snapshot);
}

/** 只读便捷入口：给插件/脚本用。 */
export function readChatState(chatKey) {
  return loadChatState(chatKey).state;
}
