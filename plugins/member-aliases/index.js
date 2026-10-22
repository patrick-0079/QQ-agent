// 群友外号对照（确定性型 / plugins/，纯 hooks）
//
// 上游是 0.2 的 config.memberAliases：一张"QQ 号 → 外号数组"的表，进提示词让模型知道
// 「某某大王 = 某某」「大某某 = 小某某」这类称呼关系。
// 0.4 只保留了 memberNotes（备注名，prompt.js 的发言人标签已经在用），没有外号概念，
// 所以这里补回来，**不改核心**：
//
//   before-context        记下本轮触发内容（外号扫描需要文本）
//   before-llm-messages   命中时追加【称呼对照】几行（没命中就一个字不加）
//   providers             member.alias-list / member.alias-set，给维护用
//
// 为什么是插件而不是核心改动：称呼表是"知识"，和 group-reports 一样属于可插拔的
// 确定性能力；关掉它，聊天照常工作，只是模型又会把外号当成陌生人。
//
// 数据文件：data/member-aliases.json（默认）
//   { "version": 1, "aliases": { "123456789": ["某某大王", "某某"] } }
// 迁移来源：迁移自0.2/v0.2-独有配置-0.4无.json 的 memberAliases（2026-09-20 搬回）。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from '../../src/config.js';
import * as promptCore from '../../src/prompt.js';

/**
 * 把外号对照注入到请求**末尾**（别动 system 前缀，否则整条缓存作废）。
 *
 * ⚠️ 可移植性：`appendDynamicTail` 是较新的 0.4 核心才有的函数。装在旧版上时
 * 命名导入不报错、**调用时**才抛 "is not a function"，插件会整个失效。
 * 所以做存在性回退：有就用核心的，没有就自己追加到最后一条 user 消息。
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
  scanMentions: true,
  maxLines: 12,
  aliasesFile: 'member-aliases.json'
};

let api = null;
/** 缓存：{ file, mtimeMs, aliases } —— 每次读盘太重，按 mtime 失效。 */
let cache = { file: '', mtimeMs: 0, aliases: {} };
/** 本轮触发内容（before-context 收集，before-llm-messages 消费）。 */
const pendingTrigger = new Map();

function settings() {
  const raw = (api && typeof api.config === 'function' ? api.config() : null) || {};
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

function filePath() {
  const name = String(settings().aliasesFile || DEFAULTS.aliasesFile).replace(/[\\/]/g, '');
  return path.join(DATA_DIR, name || DEFAULTS.aliasesFile);
}

/** 读外号表（按 mtime 缓存；文件坏了当空表，绝不让它影响对话）。 */
function loadAliases() {
  const file = filePath();
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { /* 没文件 */ }
  if (cache.file === file && cache.mtimeMs === mtimeMs) return cache.aliases;
  let aliases = {};
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const raw = data && typeof data === 'object' ? (data.aliases || data) : {};
    for (const [uid, list] of Object.entries(raw)) {
      if (!/^\d+$/.test(String(uid))) continue;
      const arr = (Array.isArray(list) ? list : [list])
        .map((x) => String(x ?? '').trim())
        .filter(Boolean);
      if (arr.length) aliases[String(uid)] = [...new Set(arr)];
    }
  } catch (error) {
    if (mtimeMs) api?.warn?.(`外号表读取失败（当作空表）：${error?.message ?? error}`);
  }
  cache = { file, mtimeMs, aliases };
  return aliases;
}

function saveAliases(aliases) {
  const file = filePath();
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: Date.now(), aliases }, null, 1), 'utf8');
    fs.renameSync(tmp, file);
    cache = { file: '', mtimeMs: 0, aliases: {} };   // 让下次读取重新加载
    return { ok: true, aliases };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 文本里是否出现了这个外号。
 *
 * 分两档，因为中文不用空格分词：
 *   · 纯中文外号（"某某"）或长度 ≥3 的：直接包含判断 —— 用"词边界"会把
 *     "某某今天怎么没来" 这种正常句子判成没命中。
 *   · **含 ASCII 字母数字的短外号**（"99"）：只在 ASCII 字母数字边界上判断，
 *     否则 "99" 会命中 "1990"/"2990"；而中文紧邻不算越界（"99来了" 照样命中）。
 */
function textHasAlias(text, alias) {
  const t = String(text || '');
  const a = String(alias || '').trim();
  if (!a || !t) return false;
  const hasAsciiAlnum = /[0-9A-Za-z]/.test(a);
  if (!hasAsciiAlnum || a.length >= 3) return t.includes(a);
  const re = new RegExp(`(?<![0-9A-Za-z])${escapeRe(a)}(?![0-9A-Za-z])`, 'i');
  return re.test(t);
}

/** 展示名：与聊天记录同口径 —— 管理员备注优先，其次第一个外号，最后 QQ 号。 */
function labelOf(uid, aliases) {
  let note = '';
  try { note = String(getConfig()?.memberNotes?.[uid] || '').trim(); } catch { /* 配置没就绪 */ }
  return note || aliases[uid]?.[0] || `QQ:${uid}`;
}

// 注入位置由 prompt.js 的 appendDynamicTail 决定（请求最末尾），不再动 system 前缀。
// ── 生命周期 ──────────────────────────────────────────────────────────────

export function setup(a) {
  api = a;
}

export function activate() {
  const aliases = loadAliases();
  const people = Object.keys(aliases).length;
  const total = Object.values(aliases).reduce((n, v) => n + v.length, 0);
  api?.log?.(`外号对照已启用：${people} 个人 / ${total} 个外号（文件 ${filePath()}）`);
}

export function available() {
  return settings().enabled !== false;
}

// ── 钩子 ──────────────────────────────────────────────────────────────────

export const hooks = {
  /** 记下本轮触发内容。 */
  async 'before-context'(ctx = {}) {
    try {
      const entries = Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries : [];
      pendingTrigger.set(String(ctx.sessionId || ctx.chatKey || ''), entries.map((e) => ({
        senderId: String(e?.senderId ?? ''),
        text: String(e?.text ?? '')
      })));
      if (pendingTrigger.size > 50) {
        const first = pendingTrigger.keys().next().value;
        pendingTrigger.delete(first);
      }
    } catch { /* 收集失败只是少几行对照 */ }
  },

  /** 命中才加行：谁在说话 / 谁被提到了。 */
  async 'before-llm-messages'(ctx = {}) {
    const s = settings();
    if (s.enabled === false) return;
    const aliases = loadAliases();
    if (!Object.keys(aliases).length) return;

    const key = String(ctx.sessionId || ctx.chatKey || '');
    const entries = pendingTrigger.get(key) || [];
    pendingTrigger.delete(key);
    if (!entries.length) return;

    const lines = [];
    const seen = new Set();

    // ① 本轮说话的人里，有外号的
    for (const e of entries) {
      if (!e.senderId || !aliases[e.senderId] || seen.has(`s:${e.senderId}`)) continue;
      seen.add(`s:${e.senderId}`);
      lines.push(`· 正在说话的 ${labelOf(e.senderId, aliases)}(QQ:${e.senderId}) 也叫：${aliases[e.senderId].join('、')}`);
    }

    // ② 本轮消息里提到的外号（说话的不是本人）
    if (s.scanMentions !== false) {
      for (const [uid, list] of Object.entries(aliases)) {
        if (seen.has(`s:${uid}`)) continue;
        const hit = list.find((a) => entries.some((e) => textHasAlias(e.text, a)));
        if (!hit || seen.has(`m:${uid}`)) continue;
        seen.add(`m:${uid}`);
        lines.push(`· 有人提到「${hit}」= ${labelOf(uid, aliases)}(QQ:${uid})（外号：${list.join('、')}）`);
      }
    }

    if (!lines.length) return;
    const max = Math.max(1, Number(s.maxLines) || 12);
    const block = [
      '【称呼对照】群友的外号（只是帮你认人，别在回复里刻意解释这些对应关系）：',
      ...lines.slice(0, max)
    ].join('\n');
    appendToSystem(ctx.messages, block);
  }
};

// ── 能力：维护外号表 ─────────────────────────────────────────────────────

export const providers = {
  /** 列出全部外号（可按 uid 过滤）。 */
  'member.alias-list': (args = {}) => {
    const aliases = loadAliases();
    const uid = String(args?.uid || '');
    if (uid) return { ok: true, uid, aliases: aliases[uid] || [], all: aliases };
    return { ok: true, count: Object.keys(aliases).length, all: aliases, file: filePath() };
  },

  /**
   * 改某人的外号。
   * mode: 'add'（默认，去重追加）| 'remove'（删指定）| 'set'（整体替换）| 'delete'（删掉这个人）
   */
  'member.alias-set': (args = {}) => {
    const uid = String(args?.uid || '').trim();
    if (!/^\d+$/.test(uid)) return { ok: false, error: '需要数字 QQ 号作为 uid' };
    const aliases = { ...loadAliases() };
    const list = (Array.isArray(args?.aliases) ? args.aliases : [args?.alias])
      .map((x) => String(x ?? '').trim())
      .filter(Boolean);
    const mode = String(args?.mode || 'add');
    if (mode === 'delete') {
      delete aliases[uid];
      return saveAliases(aliases);
    }
    if (!list.length) return { ok: false, error: '缺少 aliases' };
    if (mode === 'set') aliases[uid] = [...new Set(list)];
    else if (mode === 'remove') aliases[uid] = (aliases[uid] || []).filter((a) => !list.includes(a));
    else aliases[uid] = [...new Set([...(aliases[uid] || []), ...list])];
    if (!aliases[uid].length) delete aliases[uid];
    return saveAliases(aliases);
  },

  /** 自检用：纯函数暴露出来，测试可以直接打。 */
  'member.alias-match': (args = {}) => ({
    ok: true,
    hit: textHasAlias(String(args?.text || ''), String(args?.alias || ''))
  })
};
