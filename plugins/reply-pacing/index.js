/**
 * 回应节奏（reply-pacing）—— QQ Agent 插件
 *
 * ── 她解决什么问题 ────────────────────────────────────────────────────────
 * 内核原本的防抖是「固定的 2 秒倒计时，进入后不被任何因素重置」：
 *   对方连发 3 条 → 第 1 条启动倒计时，第 2 条只入库，2 秒到点就跑 →
 *   第 3 条变成"未读"，要等 drain（1.2 秒）再跑一轮。
 * 表现出来就是**她打断你**，或者同一个意思分两次回答。
 *
 * 本插件把等待改成"安静窗口"：
 *   · 每来一条新消息就把倒计时往后推（安静 silenceMs 才回）
 *   · 看着"话没说完"（收在逗号/省略号、特别短）→ 再多等 extraWaitMs
 *   · 换人了就不延长（别人的话不并进这一批）
 *   · 总等待封顶 maxWaitMs（对方刷屏也不能永远不回）
 *
 * ⚠️ 执行那一半在内核 src/orchestrator.js 里（插件拿不到"取消本轮回复"的钩子，
 *    所以必须由编排器执行）。插件负责：配置、判断口径的说明、以及"只回一个人"
 *    的上下文隔离。内核通过 config.skills['reply-pacing'] 读参数 —— 只依赖配置，
 *    插件没装或关着时内核一切照旧。
 *
 * ── 这个插件自己做的事 ────────────────────────────────────────────────────
 *   before-context      ：记下本轮触发消息（谁说的、说了什么、什么时间）
 *   before-llm-messages ：注入【这一轮只回一个人】的说明 —— 明确最后发言者，
 *                         并要求把他连着说的几句当成一件事整体回应
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../../src/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_TAG = '回应节奏';
const BUILD_TAG = 'v1.0.0';

const DEFAULTS = {
  enabled: true,
  silenceMs: 5000,
  extraWaitMs: 3000,
  maxWaitMs: 45000,
  holdIfUnfinished: true,
  sameSenderOnly: true,
  isolatePrompt: true,
  onlyOwner: false,
  targets: ''
};

let api = null;
let log = (...a) => { try { api?.log?.(...a); } catch { /* ignore */ } };
let warn = (...a) => { try { api?.warn?.(...a); } catch { /* ignore */ } };
let loggerReady = false;

async function ensureLogger() {
  if (loggerReady) return;
  try {
    const { logger } = await import('../../src/logger.js');
    if (logger?.info) {
      log = (t) => { try { logger.info(LOG_TAG, String(t)); } catch { /* ignore */ } };
      warn = (t) => { try { logger.warn(LOG_TAG, String(t)); } catch { /* ignore */ } };
    }
  } catch { /* 用 api.log */ }
  loggerReady = true;
}

/* ── 配置 ── */
const num = (v, d, min = 0, max = 600000) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : d;
};

function settings() {
  let raw = {};
  try {
    raw = (typeof api?.config === 'function' ? api.config() : null) || {};
  } catch { raw = {}; }
  return {
    enabled: raw.enabled !== false,
    silenceMs: num(raw.silenceMs, DEFAULTS.silenceMs, 0, 600000),
    extraWaitMs: num(raw.extraWaitMs, DEFAULTS.extraWaitMs, 0, 600000),
    maxWaitMs: num(raw.maxWaitMs, DEFAULTS.maxWaitMs, 0, 3600000),
    holdIfUnfinished: raw.holdIfUnfinished !== false,
    sameSenderOnly: raw.sameSenderOnly !== false,
    isolatePrompt: raw.isolatePrompt !== false,
    onlyOwner: raw.onlyOwner === true,
    targets: String(raw.targets ?? '')
  };
}

const parseIds = (s) => [...new Set(String(s ?? '').split(/[,，;；\s]+/)
  .map((x) => x.replace(/[^0-9]/g, '')).filter(Boolean))];

/** 主人号（伴侣认证 → 关系与好感 → 主人识别旧键）。 */
function ownerIds() {
  const cfg = getConfig() || {};
  return parseIds(cfg.skills?.soulmate?.ids
    || cfg.skills?.bond?.ownerQq
    || cfg.skills?.['owner-identity']?.ids);
}

/** 这个会话要不要走"等他先说完"。 */
function activeFor(chatKey, senderIds = []) {
  const s = settings();
  if (!s.enabled) return false;
  const targets = parseIds(s.targets);
  const key = String(chatKey || '');
  const ids = senderIds.length
    ? senderIds
    : (key.startsWith('private:') ? [key.slice('private:'.length)] : []);
  if (targets.length) return ids.some((id) => targets.includes(id));
  if (s.onlyOwner) {
    const owners = ownerIds();
    return owners.length > 0 && ids.some((id) => owners.includes(id));
  }
  return true;
}

/* ── 本轮触发消息的记账（before-context 拿得到 triggerEntries）── */
const lastBatch = new Map();          // sessionId -> { entries, at, chatKey }
const BATCH_TTL_MS = 10 * 60 * 1000;

function rememberBatch(ctx = {}) {
  const sid = String(ctx?.sessionId || '');
  if (!sid) return null;
  const entries = (Array.isArray(ctx?.triggerEntries) ? ctx.triggerEntries : [])
    .filter((e) => e && !e.self)
    .map((e) => ({
      senderId: String(e?.senderId ?? '').replace(/[^0-9]/g, ''),
      senderName: String(e?.senderName ?? '').slice(0, 24),
      text: String(e?.text ?? '').slice(0, 300),
      at: Number(e?.ts ?? e?.at ?? 0) || 0
    }));
  const rec = { entries, at: Date.now(), chatKey: String(ctx?.chatKey || '') };
  lastBatch.set(sid, rec);
  // 清过期
  if (lastBatch.size > 200) {
    for (const [k, v] of lastBatch) if (Date.now() - v.at > BATCH_TTL_MS) lastBatch.delete(k);
  }
  return rec;
}

/**
 * 本轮"该回谁"：最后一条触发消息的发送者。
 * 只认号码 —— 名字会改会撞，同 speaker-identity/owner-identity 的口径。
 */
function focusOf(entries = []) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (e?.senderId) return e;
  }
  return null;
}

/** 组装【这一轮只回一个人】的说明。 */
function isolateText(entries = [], s = settings()) {
  const focus = focusOf(entries);
  if (!focus) return '';
  const who = focus.senderName ? `${focus.senderName}（QQ ${focus.senderId}）` : `QQ ${focus.senderId}`;
  const mine = entries.filter((e) => e.senderId === focus.senderId);
  const others = entries.filter((e) => e.senderId && e.senderId !== focus.senderId);
  const lines = [
    `【这一轮只回一个人：${who}】`,
    `- 这批消息里最后说话的是他。**只回应他说的话**，别人在这批里的发言只是背景，不要接、不要回应，`
      + '也不要把别人的话当成他说的、或缝进对他的回答里。'
  ];
  if (mine.length > 1) {
    lines.push(`- 他连着说了 ${mine.length} 句：那是**一件事的几段**，合起来当成一个整体来回应 —— `
      + '不要逐条回、不要漏掉前半句、也不要重复应答同一个意思。');
    lines.push('  他说的几句（按时间）：' + mine.map((m) => `「${m.text}」`).join(' → '));
  }
  if (others.length) {
    lines.push(`- 同一批里还有 ${others.length} 句来自别人，那些**不需要你回应**`
      + '（如果确实要提，也只能当成旁人的话一笔带过，别当成他在说）。');
  }
  return lines.join('\n');
}

/* ── 钩子 ── */
export const hooks = {
  'before-context'(ctx = {}) {
    try {
      const s = settings();
      if (!s.enabled) return;
      rememberBatch(ctx);
    } catch (e) {
      warn(`记账失败（不影响本轮）：${e?.message ?? e}`);
    }
  },

  'before-llm-messages'(ctx = {}) {
    try {
      const s = settings();
      if (!s.enabled || !s.isolatePrompt) return;
      const messages = ctx?.messages;
      if (!Array.isArray(messages) || !messages.length) return;
      const sid = String(ctx?.sessionId || '');
      const rec = sid ? lastBatch.get(sid) : null;
      const entries = rec?.entries || [];
      if (!entries.length) return;
      if (!activeFor(ctx?.chatKey, [...new Set(entries.map((e) => e.senderId).filter(Boolean))])) return;

      const text = isolateText(entries, s);
      if (!text) return;

      // 追加到最后一条 user 消息（与 desire / thinking-cn 同一手法：不碰系统提示，
      // 免得把前缀缓存打崩）。重试路径去重。
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i];
        if (!m || m.role !== 'user') continue;
        if (typeof m.content !== 'string') return;
        if (m.content.includes('【这一轮只回一个人')) return;
        m.content = `${m.content}\n\n${text}`;
        return;
      }
    } catch (e) {
      warn(`注入失败（不影响本轮）：${e?.message ?? e}`);
    }
  }
};

/* ── 生命周期 ── */
export function setup(a) {
  api = a;
  ensureLogger().then(() => {
    const s = settings();
    log(`已加载（${BUILD_TAG}）：安静 ${s.silenceMs}ms 才回｜没说完再多等 ${s.extraWaitMs}ms`
      + `｜最长等 ${s.maxWaitMs}ms｜同人连发才延长 ${s.sameSenderOnly ? '开' : '关'}`
      + `｜只回一个人提示 ${s.isolatePrompt ? '开' : '关'}`
      + `｜范围 ${s.targets ? `仅 ${s.targets}` : (s.onlyOwner ? '仅主人' : '所有会话')}`);
    if (!s.enabled) log('当前未启用：内核按原本的固定倒计时走。');
  });
}

export function available() {
  return settings().enabled !== false;
}

export function deactivate() {
  lastBatch.clear();
}

export function dispose() {
  lastBatch.clear();
}

/* ── 面板 ── */
export const providers = {
  'status.reply-pacing': () => {
    const s = settings();
    const owners = ownerIds();
    return {
      icon: '⏳',
      title: '回应节奏',
      priority: 58,
      lines: [
        ['状态', s.enabled ? '运行中（等他说完再回）' : '已关闭（内核按固定倒计时走）'],
        ['安静窗口', `${s.silenceMs} 毫秒：他每发一条就把倒计时重置成这个值`],
        ['没说完', s.holdIfUnfinished
          ? `开：收在逗号/省略号、或少于 12 字时再多等 ${s.extraWaitMs} 毫秒`
          : '关：不做语义判断'],
        ['最长等待', `${s.maxWaitMs} 毫秒（超过就直接回，防止对方刷屏让她永不开口）`],
        ['同人连发才延长', s.sameSenderOnly ? '开（换人说话就让这批照常处理，别人的话不并进来）' : '关'],
        ['只回一个人提示', s.isolatePrompt ? '开（明确最后发言者，要求整体回应他的连发）' : '关'],
        ['生效范围', s.targets
          ? `仅 ${s.targets}`
          : (s.onlyOwner ? `仅主人（${owners.join('、') || '未读到主人号'}）` : '所有会话')]
      ]
    };
  }
};

export const internals = {
  BUILD_TAG,
  settings,
  ownerIds,
  activeFor,
  rememberBatch,
  focusOf,
  isolateText,
  lastBatch
};
