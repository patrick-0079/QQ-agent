// 回复引用保护（确定性型插件）
//
// 场景：机器人准备回群友 A 的消息，生成期间群友 B 又发了一句。
// 这时直接发出去会被看成在回 B；本插件在 after-response 里查最新聊天记录，
// 如果 A 那条已经被顶掉，就给这一轮的文字回复补上对 A 原消息的引用。
// 模型自己已引用、目标仍是最新、或私聊时不干预。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';

const MESSAGES_DIR = path.join(DATA_DIR, 'messages');
const MAX_SESSIONS = 300;

let api = null;
const targets = new Map();   // sessionId -> { chatKey, mid, id, ts, senderName, text }

const settings = () => (api && typeof api.config === 'function' ? api.config() : {}) || {};
const log = (...args) => { try { api?.log?.(...args); } catch { /* ignore */ } };
const warn = (...args) => { try { api?.warn?.(...args); } catch { /* ignore */ } };
const num = (v, d, min, max) => { const n = Number(v); const x = Number.isFinite(n) ? n : d; return Math.min(max, Math.max(min, Math.round(x))); };
const clip = (s, n = 50) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const validMid = (v) => v !== null && v !== undefined && /^-?[1-9]\d*$/.test(String(v).trim());

function chatFile(chatKey) {
  const [kind, id] = String(chatKey || '').split(':');
  if (!kind || !id) return null;
  return path.join(MESSAGES_DIR, `${kind}_${id}.json`);
}
function readMessages(chatKey) {
  const file = chatFile(chatKey);
  if (!file) return [];
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(j?.messages) ? j.messages : [];
  } catch { return []; }
}

function isAddressed(e) {
  return !!(e && (e.atMe === true || e.isPoke === true));
}

function chooseTarget(context = {}) {
  const s = settings();
  const kind = String(context.kind || '');
  if (kind !== 'group' && s.onlyGroups !== false) return null;
  const entries = (Array.isArray(context.triggerEntries) ? context.triggerEntries : [])
    .filter((e) => e && !e.self && validMid(e.mid));
  if (!entries.length) return null;
  const addressed = entries.filter(isAddressed);
  const picked = s.preferAddressed !== false && addressed.length
    ? addressed[addressed.length - 1]
    : entries[entries.length - 1];
  return {
    chatKey: String(context.chatKey || ''),
    mid: String(picked.mid),
    id: Number(picked.id) || null,
    ts: Number(picked.ts) || 0,
    senderName: String(picked.senderName || ''),
    text: clip(picked.text, 50)
  };
}

/** 目标消息之后又来了几条"别人的"新消息。 */
function newMessagesAfter(target, chatKey) {
  if (!target) return 0;
  const list = readMessages(chatKey || target.chatKey);
  if (!list.length) return 0;
  let idx = -1;
  if (target.id != null) idx = list.findIndex((m) => Number(m?.id) === Number(target.id));
  if (idx < 0) idx = list.findIndex((m) => String(m?.mid ?? '') === String(target.mid));
  let after;
  if (idx >= 0) after = list.slice(idx + 1);
  else {
    // 找不到目标时按时间/本地 id 兜底
    after = list.filter((m) => (Number(m?.ts) || 0) > Number(target.ts || 0)
      || (target.id != null && Number(m?.id) > Number(target.id)));
  }
  return after.filter((m) => m && !m.self).length;
}

function findTextCalls(response) {
  const calls = Array.isArray(response?.message?.tool_calls) ? response.message.tool_calls : [];
  return calls.filter((c) => String(c?.function?.name || '') === 'send_message');
}

function quoteCall(call, mid) {
  const raw = call?.function?.arguments;
  let args = {};
  try { args = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {}); } catch { return false; }
  if (args.replyToMessageId !== null && args.replyToMessageId !== undefined && String(args.replyToMessageId).trim() !== '') return false;
  args.replyToMessageId = /^-?\d+$/.test(String(mid)) ? Number(mid) : String(mid);
  call.function.arguments = JSON.stringify(args);
  return true;
}

export function setup(hostApi) {
  api = hostApi;
  log('回复引用保护已加载（要回的那条被顶掉时自动补引用）');
}

export function activate() {
  if (!api) api = { config: () => ({}) };
}

export function deactivate() {
  targets.clear();
}

export function available() {
  return true;
}

export const hooks = {
  'before-context': (context = {}) => {
    try {
      const target = chooseTarget(context);
      const key = String(context.sessionId || context.chatKey || '');
      if (!target || !key) return;
      targets.set(key, target);
      while (targets.size > MAX_SESSIONS) {
        const first = targets.keys().next().value;
        if (first === undefined) break;
        targets.delete(first);
      }
    } catch (error) { warn('回复引用目标记录失败：%s', error?.message ?? error); }
  },

  'after-response': ({ response, sessionId, chatKey } = {}) => {
    try {
      if (!response || typeof response !== 'object' || !response.message) return;
      const key = String(sessionId || '');
      const target = key ? targets.get(key) : null;
      if (!target) return;
      const count = newMessagesAfter(target, String(chatKey || target.chatKey));
      const need = num(settings().minNewMessages, 1, 1, 20);
      if (count < need) return;

      // 只给文字回复补引用；模型已经自己引用过的保持原样。
      let signed = false;
      for (const call of findTextCalls(response)) {
        if (quoteCall(call, target.mid)) { signed = true; break; }
      }
      // 如果设置了图片也引用：给本轮第一个图片/表情发送也补上
      if (!signed && settings().quoteMedia === true) {
        const calls = Array.isArray(response.message.tool_calls) ? response.message.tool_calls : [];
        for (const call of calls) {
          const n = String(call?.function?.name || '');
          if (!/send_image|send_sticker|sticker-steal__send_sticker_steal/i.test(n)) continue;
          if (quoteCall(call, target.mid)) { signed = true; break; }
        }
      }
      if (signed && settings().logChanges === true) {
        log('自动引用：%s → #%s（被 %d 条新消息顶掉）', target.senderName || target.chatKey, target.mid, count);
      }
    } catch (error) { warn('回复引用保护失败：%s', error?.message ?? error); }
  }
};

/* ── 测试辅助 ─────────────────────────────────────────────────────────── */
export const __test = {
  chooseTarget,
  newMessagesAfter,
  targets: () => targets,
  reset: () => targets.clear()
};
