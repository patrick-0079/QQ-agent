// kb-hub —— 多知识库中心
//
// ── 为什么放在 plugins/（确定性型）而不是 skills/（LLM 型）────────────────
// 按本项目的目录语义（src/skills/manifest.js 的 DIR_KIND）：
//   plugins/ = 确定性型：靠**钩子**或**能力**插进主流程，满足条件必然执行，模型想忽略也忽略不掉
//   skills/  = LLM 型：只注册工具，用不用、什么时候用由模型自己判断
//
// 这个功能两半都要，而且第二半只有 plugins/ 给得了：
//   ① 自动那一半：群友那句话命中知识库时必须把内容带上 —— 不能指望模型每次都记得调工具，
//      所以走 hooks['before-llm-messages']（确定性）；
//   ② 主动那一半：模型也可以自己决定去翻库 —— 所以同时 registerTool（工具 id 由加载器加
//      `kb-hub__` 前缀，插件里写短名即可）；
//   ③ 管理界面：新建/编辑多个知识库需要一个页面，而 /plugin-ui/ 的静态资源**只从
//      plugins/<id>/ui/ 取**（app.js 里写死 PLUGINS_DIR），skills/ 里做不出这个页面。
// 三者都指向 plugins/，所以这里是插件；同时它既是“容器”（多本库）也是“检索器”。
//
// ── 数据放哪（重要）──────────────────────────────────────────────────────
// 知识库正文一律存 DATA_DIR/knowledge/，**不放在插件目录里**：
//   插件目录会在应用升级/重装插件时被整体替换，用户攒的资料不能跟着陪葬。
//   DATA_DIR 是宿主的数据根（data/ 或 data-N/），升级不丢。
//
// ── 两种库，随你放 ──────────────────────────────────────────────────────
//   DATA_DIR/knowledge/*.json      结构化库（控制台页面里编辑，一条条问答或段落）
//   DATA_DIR/knowledge/docs/*.md|txt  文档库（一个文件 = 一本库，按标题或空行自动切条目）
// 文档库是给“我手上就有一篇资料”准备的：把文件丢进去就生效，不用改任何代码。
//
// ── 缓存策略 ────────────────────────────────────────────────────────────
// 宿主的热重载**只监听 skills/ 与 plugins/**，不会监听 DATA_DIR —— 所以“丢文件进去就生效”
// 必须由本插件自己保证：每次检索前用 (文件名, 大小, mtime) 拼一个签名，签名没变才用缓存。
// 这样编辑知识库后**不需要重启程序**，也不会有“改了没反应”的静默故障。
//
// ── 排障入口 ────────────────────────────────────────────────────────────
//   控制台页面：插件卡片上的 📚 按钮（或 /plugin-ui/kb-hub/index.html），里面有「命中测试」；
//   设置里打开「打印命中日志」，每轮会在日志里写“查了什么/命中几条/注入了没有”。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR } from '../../src/config.js';

const ID = 'kb-hub';
/** 工具在模型眼里是带前缀的（加载器加的）：kb-hub__kb_search。提示词里要写全名。 */
const TOOL_PREFIX = 'kb-hub__';
const TOOL_IDS = { search: 'kb_search', list: 'kb_list', read: 'kb_read' };

const KB_DIR = path.join(DATA_DIR, 'knowledge');
const DOC_DIR = path.join(KB_DIR, 'docs');
const DOC_EXT = new Set(['.md', '.markdown', '.txt', '.text']);
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/i;

/**
 * 调用计数的存放位置。
 *
 * ⚠️ 必须放在 knowledge/ **之外**：knowledge/ 下所有 .json 都会被当成一本知识库加载，
 *    统计文件放进去会变成一本名叫 kb-hub-stats 的"幽灵库"。也不能放 docs/（同理）。
 */
const STATS_FILE = path.join(DATA_DIR, 'kb-hub-stats.json');
/** 写入节流：命中是热路径，不能每命中一次就写盘。 */
const STATS_FLUSH_MS = 4000;

let cfg = () => ({});
let log = () => {};

// ── 调用计数（纯观测，**不参与任何打分**）────────────────────────────────
//
// 设计约定（这条是需求的核心）：
//   · 计数只在 search() 返回**之后**记录，绝不进入 scoreEntry / search 的排序逻辑；
//   · 排行只用于"看哪些知识在被用、哪些从没被用过"，用来决定该补什么、该删什么；
//   · 因此改坏计数最多是数字不准，不可能让某个条目变得更容易/更难命中。
//
// 计数分两种来源，合起来才是"总调用"：
//   inject —— 被自动带入（机器人回答前自动塞进上下文）
//   search —— 被 kb_search 工具主动查到
// kb_read 读整本时按**库**计数（不摊到每条，否则会把所有条目都刷一遍）。
const callStats = {
  version: 1,
  updatedAt: 0,
  entries: {},   // "baseId/entryId" -> { inject, search, lastAt }
  bases: {}      // baseId -> { inject, search, read, lastAt }
};
let statsDirty = false;
let statsTimer = null;

function loadCallStats() {
  try {
    const raw = JSON.parse(readText(STATS_FILE));
    if (raw && typeof raw === 'object') {
      callStats.entries = (raw.entries && typeof raw.entries === 'object') ? raw.entries : {};
      callStats.bases = (raw.bases && typeof raw.bases === 'object') ? raw.bases : {};
      callStats.updatedAt = Number(raw.updatedAt) || 0;
    }
  } catch { /* 首次运行没有文件，或文件坏了：从零开始，不影响主流程 */ }
}

function flushCallStats({ force = false } = {}) {
  if (!statsDirty && !force) return;
  try {
    callStats.updatedAt = Date.now();
    fs.writeFileSync(STATS_FILE, `${JSON.stringify(callStats, null, 2)}\n`, 'utf8');
    statsDirty = false;
  } catch (error) {
    log(`统计写入失败（不影响检索）：${error?.message ?? error}`);
  }
}

function scheduleFlush() {
  statsDirty = true;
  if (statsTimer) return;
  statsTimer = setTimeout(() => {
    statsTimer = null;
    flushCallStats();
  }, STATS_FLUSH_MS);
  // 不因为一个待写盘的定时器把进程吊住
  if (typeof statsTimer.unref === 'function') statsTimer.unref();
}

const entryKey = (baseId, entryId) => `${baseId}/${entryId}`;

/** 记一次命中。source: 'inject' | 'search'。 */
function recordHits(hits, source) {
  if (!Array.isArray(hits) || !hits.length) return;
  const now = Date.now();
  for (const h of hits) {
    const baseId = h?.base?.id;
    const entryId = h?.entry?.id;
    if (!baseId || !entryId) continue;
    const key = entryKey(baseId, entryId);
    if (!callStats.entries[key]) callStats.entries[key] = { inject: 0, search: 0, lastAt: 0 };
    const row = callStats.entries[key];
    if (source === 'search') row.search += 1; else row.inject += 1;
    row.lastAt = now;
    if (!callStats.bases[baseId]) callStats.bases[baseId] = { inject: 0, search: 0, read: 0, lastAt: 0 };
    const b = callStats.bases[baseId];
    if (source === 'search') b.search += 1; else b.inject += 1;
    b.lastAt = now;
  }
  scheduleFlush();
}

/** 记一次读整本（按库计）。 */
function recordBaseRead(baseId) {
  if (!baseId) return;
  if (!callStats.bases[baseId]) callStats.bases[baseId] = { inject: 0, search: 0, read: 0, lastAt: 0 };
  callStats.bases[baseId].read += 1;
  callStats.bases[baseId].lastAt = Date.now();
  scheduleFlush();
}

function entryCallCount(baseId, entryId) {
  const row = callStats.entries[entryKey(baseId, entryId)];
  return row ? { inject: row.inject || 0, search: row.search || 0, total: (row.inject || 0) + (row.search || 0), lastAt: row.lastAt || 0 } : { inject: 0, search: 0, total: 0, lastAt: 0 };
}

/**
 * 排行数据。**只读**，不参与检索 —— 排序只发生在展示层。
 * @param {object} opt { limit, sortBy: 'total'|'inject'|'search', includeZero }
 */
function buildRanking({ limit = 50, sortBy = 'total', includeZero = false } = {}) {
  const bases = loadBases();
  const rows = [];
  for (const base of bases) {
    for (const entry of base.entries) {
      const c = entryCallCount(base.id, entry.id);
      if (!includeZero && c.total === 0) continue;
      rows.push({
        baseId: base.id,
        baseName: base.name,
        entryId: entry.id,
        question: entry.question || entry.title || '(无标题)',
        inject: c.inject,
        search: c.search,
        total: c.total,
        lastAt: c.lastAt
      });
    }
  }
  const key = sortBy === 'inject' ? 'inject' : (sortBy === 'search' ? 'search' : 'total');
  rows.sort((a, b) => (b[key] - a[key]) || (b.lastAt - a.lastAt));
  const totalEntries = bases.reduce((n, b) => n + b.entries.length, 0);
  const allCalls = Object.values(callStats.entries).reduce((n, r) => n + (r.inject || 0) + (r.search || 0), 0);
  const usedEntries = Object.values(callStats.entries).filter((r) => (r.inject || 0) + (r.search || 0) > 0).length;
  return {
    updatedAt: callStats.updatedAt,
    totals: {
      calls: allCalls,
      entriesCalled: usedEntries,
      entriesTotal: totalEntries,
      neverCalled: Math.max(0, totalEntries - usedEntries)
    },
    bases: bases.map((b) => {
      const s = callStats.bases[b.id] || {};
      return {
        id: b.id, name: b.name, entries: b.entries.length,
        inject: s.inject || 0, search: s.search || 0, read: s.read || 0,
        total: (s.inject || 0) + (s.search || 0), lastAt: s.lastAt || 0
      };
    }).sort((a, b) => b.total - a.total),
    rows: rows.slice(0, Math.max(1, Math.min(500, limit)))
  };
}

// ── 分词 ────────────────────────────────────────────────────────────────
// 中文没有空格，纯 JS 里最可靠的近似是**字符二元组（bigram）**：
//   “群规是什么” → 群规 / 规是 / 是什 / 什么
// 停用词只剔除**问句套话**（什么/怎么/可以…），不剔实词 —— 剔多了会出现
// “问的是群规，却因为整句被剔空而查不到”（这个坑在 graph-memory 里踩过）。
const STOP_BIGRAMS = new Set([
  '什么', '怎么', '为什', '可以', '是否', '有没有', '没有', '我们', '你们', '他们', '这个', '那个',
  '一下', '一个', '知道', '请问', '告诉', '帮我', '多少', '哪里', '哪个', '时候', '现在', '今天',
  '明天', '昨天', '还是', '就是', '不是', '的话', '一下', '而且', '然后', '因为', '所以', '但是'
]);

function tokenize(text) {
  const s = String(text ?? '').toLowerCase();
  const out = new Set();
  for (const w of s.match(/[a-z0-9_]{2 }/g) || []) out.add(w);
  for (const run of s.match(/[\u4e00-\u9fff]+/g) || []) {
    if (run.length === 1) { out.add(run); continue; }
    for (let i = 0; i + 1 < run.length; i += 1) {
      const bg = run.slice(i, i + 2);
      if (!STOP_BIGRAMS.has(bg)) out.add(bg);
    }
  }
  return out;
}

/**
 * 不过滤停用词的二元组，专门用来算"关键词与提问的字面重合度"。
 * 与 tokenize 的区别很重要：算覆盖率时不能剔停用词，否则「发芽土豆」这类
 * 关键词会被剔成空集，覆盖率判定直接失效。
 */
function rawBigrams(text) {
  const s = String(text ?? '').toLowerCase();
  const out = [];
  for (const run of s.match(/[\u4e00-\u9fff]+/g) || []) {
    if (run.length === 1) { out.push(run); continue; }
    for (let i = 0; i + 1 < run.length; i += 1) out.push(run.slice(i, i + 2));
  }
  for (const w of s.match(/[a-z0-9_]{2 }/g) || []) out.push(w);
  return out;
}

// ── 读写与规范化 ────────────────────────────────────────────────────────

function ensureDirs() {
  try { fs.mkdirSync(DOC_DIR, { recursive: true }); } catch { /* 建不出来时下面的读写会各自报错 */ }
}

function clip(s, max) {
  const t = String(s ?? '');
  return t.length > max ? `${t.slice(0, max)}…（已截断）` : t;
}

/** 一个条目：问答、段落、或纯字符串都能收。 */
function normalizeEntry(raw, i) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    const text = raw.trim();
    return text ? { id: `e${i + 1}`, title: '', question: '', answer: text, keywords: [], tags: [] } : null;
  }
  if (Array.isArray(raw)) {
    const [q, a] = raw;
    const answer = String(a ?? '').trim();
    if (!answer) return null;
    return { id: `e${i + 1}`, title: '', question: String(q ?? '').trim(), answer, keywords: [], tags: [] };
  }
  if (typeof raw !== 'object') return null;
  const answer = String(raw.answer ?? raw.a ?? raw.content ?? raw.text ?? '').trim();
  const question = String(raw.question ?? raw.q ?? raw.title ?? '').trim();
  if (!answer && !question) return null;
  const asArr = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
  return {
    id: String(raw.id || `e${i + 1}`),
    title: String(raw.title ?? '').trim(),
    question,
    answer: answer || question,
    keywords: asArr(raw.keywords ?? raw.keys),
    tags: asArr(raw.tags)
  };
}

function normalizeBase(raw, { file, source, fallbackId }) {
  const id = String(raw.id || fallbackId || '').trim() || fallbackId;
  const entries = (Array.isArray(raw.entries) ? raw.entries : [])
    .map((e, i) => normalizeEntry(e, i))
    .filter(Boolean);
  return {
    id,
    name: String(raw.name || raw.title || id).trim() || id,
    description: String(raw.description ?? '').trim(),
    keywords: Array.isArray(raw.keywords) ? raw.keywords.map((k) => String(k).trim()).filter(Boolean) : [],
    always: raw.always === true,
    enabled: raw.enabled !== false,
    // 生效范围：all（默认，所有会话）/ private（只在私聊）/ groups（只在列出的会话）/
    // except（除列出的会话以外都生效）。会话标识沿用宿主的 chatKey：group:<群号> / private:<QQ>。
    scope: SCOPE_MODES.has(String(raw.scope)) ? String(raw.scope) : 'all',
    scopeChats: Array.isArray(raw.scopeChats) ? raw.scopeChats.map((c) => String(c).trim()).filter(Boolean) : [],
    source,
    file,
    entries,
    updatedAt: raw.updatedAt || 0
  };
}

/** 允许的作用域取值。写错的取值一律回退成 all，避免"限定失效"这种静默故障。 */
const SCOPE_MODES = new Set(['all', 'private', 'groups', 'except']);

/**
 * 这本库在当前会话里该不该生效。
 *
 * 为什么需要它：有些库（例如成人类）不该在群里冒出来。判定放在**检索这一层**而不是
 * 提示词层——只要这里拦住，自动注入、主动检索、清单提示三处同时失效，不会有漏网的路径。
 *
 * 拿不到会话标识时（例如控制台页面里不带会话测试）只放行 all：
 * 宁可"限定过的库测不出命中"，也不要"限定过的库在某个没想到的路径上泄漏"。
 */
function inScope(base, chatKey) {
  const scope = base.scope || 'all';
  if (scope === 'all') return true;
  const key = String(chatKey || '').trim();
  if (!key) return false;
  const isPrivate = key.startsWith('private:');
  const id = key.slice(key.indexOf(':') + 1);
  const list = base.scopeChats || [];
  const listed = list.includes(id) || list.includes(key);
  if (scope === 'private') return isPrivate;
  if (scope === 'groups') return listed;
  if (scope === 'except') return !listed;
  return true;
}

/** 去掉 UTF-8 BOM —— 记事本/Out-File 写的 JSON 带 BOM，JSON.parse 会直接抛错。 */
function readText(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

/**
 * 文档库切条目：
 *   有 `#`/`##` 标题 → 一个标题一段；
 *   没有标题 → 按空行分段；
 *   段里如果同时有「问：/答：」或「Q:/A:」→ 按问答收。
 */
function parseDoc(text, baseName) {
  const clean = String(text).replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
  const entries = [];
  const push = (title, body) => {
    const t = String(title || '').trim();
    const b = String(body || '').trim();
    if (!t && !b) return;
    const m = b.match(/^\s*(?:问|Q)\s*[:：]\s*([\s\S]*?)\n\s*(?:答|A)\s*[:：]\s*([\s\S]*)$/i);
    if (m) {
      entries.push({ id: `e${entries.length + 1}`, title: t, question: m[1].trim(), answer: m[2].trim(), keywords: [], tags: [] });
      return;
    }
    entries.push({ id: `e${entries.length + 1}`, title: t, question: t, answer: b || t, keywords: [], tags: [] });
  };

  const lines = clean.split('\n');
  let title = '';
  let buf = [];
  let sawHeading = false;
  for (const line of lines) {
    const h = line.match(/^(#{1,4})\s+(.*\S)\s*$/);
    if (h) {
      sawHeading = true;
      push(title, buf.join('\n'));
      title = h[2];
      buf = [];
      continue;
    }
    buf.push(line);
  }
  push(title, buf.join('\n'));

  if (!sawHeading) {
    // 没有标题：按空行重新切一遍，第 1 段当说明丢掉（文件名已经是库名了）
    const paras = clean.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    if (paras.length > 1 && paras[0].length <= 40 && !/[。！？!?]$/.test(paras[0])) paras.shift();
    entries.length = 0;
    for (const p of paras) push('', p);
  }
  const out = entries.filter((e) => (e.answer || e.question).trim().length > 1);
  return {
    id: `doc:${baseName}`,
    name: baseName,
    description: '',
    keywords: [],
    always: false,
    enabled: true,
    source: 'doc',
    entries: out
  };
}

// ── 载入 + 缓存（签名 = 文件名:大小:mtime，任何一个变了就重读）─────────────

let cache = { sig: '', at: 0, bases: [], errors: [] };

const META_SUFFIX = '.meta.json';

function scan() {
  const parts = [];
  const errors = [];
  const bases = [];
  const metas = new Map();   // 文档文件名 → 旁注（说明/常驻/停用）

  const statOf = (file) => {
    try { const st = fs.statSync(file); return st.isFile() ? st : null; } catch { return null; }
  };

  let kbNames = [];
  try { kbNames = fs.readdirSync(KB_DIR).sort(); } catch { kbNames = []; }

  // ① 先读旁注。文档库的正文在 .md/.txt 里，而“说明/常驻/停用”这些小设置需要一个落脚点，
  //    放 <文件名>.meta.json。它**必须**在结构化库之前读出来，且自己不能被当成一本库。
  for (const name of kbNames) {
    if (!name.toLowerCase().endsWith(META_SUFFIX)) continue;
    const file = path.join(KB_DIR, name);
    const st = statOf(file);
    if (!st) continue;
    parts.push(`meta/${name}:${st.size}:${Math.round(st.mtimeMs)}`);
    try {
      const raw = JSON.parse(readText(file));
      metas.set(String(raw.metaFor || name.slice(0, -META_SUFFIX.length)), raw);
    } catch (error) {
      errors.push(`${name}：${error?.message ?? error}`);
    }
  }

  // ② 结构化库：DATA_DIR/knowledge/*.json
  for (const name of kbNames) {
    if (name.toLowerCase().endsWith(META_SUFFIX)) continue;
    const file = path.join(KB_DIR, name);
    if (path.extname(name).toLowerCase() !== '.json') continue;
    const st = statOf(file);
    if (!st) continue;
    parts.push(`json/${name}:${st.size}:${Math.round(st.mtimeMs)}`);
    try {
      const raw = JSON.parse(readText(file));
      bases.push(normalizeBase(raw, { file, source: 'json', fallbackId: path.basename(name, '.json') }));
    } catch (error) {
      // 单本库坏了不能拖垮其它库：记下来，控制台页面会把它显示成一条红字
      errors.push(`${name}：${error?.message ?? error}`);
    }
  }

  // ③ 文档库：DATA_DIR/knowledge/docs/*.md|.txt（一个文件 = 一本库）
  let docNames = [];
  try { docNames = fs.readdirSync(DOC_DIR).sort(); } catch { docNames = []; }
  for (const name of docNames) {
    const file = path.join(DOC_DIR, name);
    const ext = path.extname(name).toLowerCase();
    if (!DOC_EXT.has(ext)) continue;
    const st = statOf(file);
    if (!st) continue;
    parts.push(`doc/${name}:${st.size}:${Math.round(st.mtimeMs)}`);
    try {
      const baseName = path.basename(name, ext);
      const base = normalizeBase(parseDoc(readText(file), baseName), { file, source: 'doc', fallbackId: `doc:${baseName}` });
      const meta = metas.get(name);
      if (meta) {
        if (meta.description !== undefined) base.description = String(meta.description).trim();
        if (meta.keywords !== undefined) base.keywords = splitList(meta.keywords);
        base.always = meta.always === true;
        base.enabled = meta.enabled !== false;
        base.name = String(meta.name || base.name).trim() || base.name;
      }
      bases.push(base);
    } catch (error) {
      errors.push(`${name}：${error?.message ?? error}`);
    }
  }

  return { sig: parts.join('|'), bases, errors };
}

/** 取当前全部知识库。签名没变就直接用缓存（避免每轮都全量 parse）。 */
function loadBases({ force = false } = {}) {
  const now = Date.now();
  // 1.2s 内的重复调用不再碰磁盘：一轮对话里这个函数会被检索、目录、提示词各问一次。
  if (!force && now - cache.at < 1200) return cache.bases;
  const { sig, bases, errors } = scan();
  if (!force && sig === cache.sig) {
    cache.at = now;
    return cache.bases;
  }
  const changed = sig !== cache.sig;
  const prev = cache;
  cache = { sig, at: now, bases, errors, ready: true };
  if (changed && prev.ready) {
    log(`知识库已更新：${bases.length} 本 / ${bases.reduce((n, b) => n + b.entries.length, 0)} 条`);
  }
  return bases;
}

function allBases() { return loadBases({ force: true }); }

function matchBase(base, want) {
  const w = String(want || '').trim().toLowerCase();
  if (!w) return true;
  return base.id.toLowerCase() === w
    || base.name.toLowerCase() === w
    || base.id.toLowerCase().includes(w)
    || base.name.toLowerCase().includes(w);
}

// ── 检索打分 ────────────────────────────────────────────────────────────

/**
 * 「通用词」黑名单：这些词在任何领域都会出现，单独命中它说明不了任何事。
 *
 * 为什么需要（实测两次）：
 *   · 成人库里「阳痿/不行」的「不行」把「解冻用热水行不行」整句拉走，
 *     而且分数并列时按加载顺序还排在正确条目前面；
 *   · 反过来说「解冻」这种**实词**又必须照常命中，不能被一刀切降权。
 * 所以规则按词性区分：通用词要有更强的整句佐证才算命中，实词照旧。
 * 判错的代价不对称：漏掉一条只是少带一次资料，误带一条会让机器人答错话题。
 */
const GENERIC_KEYWORDS = new Set([
  '不行', '不行了', '可以', '怎么', '什么', '知道', '想要', '给我', '给我吧', '进来', '进来吧',
  '下面', '挑选', '好吃', '能吃', '能做', '有没有', '多少', '一个', '我们', '你们', '这个', '那个',
  '事情', '东西', '时间', '问题', '方法', '使用', '需要', '感觉', '样子', '时候', '为什么', '如何',
  '正常', '重要', '应该', '可能', '真的', '一直', '有点', '以后', '以前', '最近', '喜欢', '讨厌',
  '吃什么', '推荐', '哪个好', '什么好', '怎么办', '怎么弄', '怎么做', '怎么说', '是什么', '有什么',
  '多大', '多长', '多高', '多远', '多久', '几点', '在哪', '哪里', '几个', '多少年',
  // 领域词但很泛：「好吃的」能出现在任何一句问美食的话里，单独命中它不该压过
  // 真正带着地名的条目（「陕西有什么好吃的」应该给陕西小吃，而不是给「陕西省」或别的省）。
  '好吃的', '美食', '小吃推荐'
]);

function scoreEntry(base, entry, qRaw, qTok) {
  let score = 0;
  const why = [];

  // ① 先算字面重合度：后面判「关键词可不可信」要用到它，所以顺序不能反。
  //
  // ⚠️ 这里**只算条目自身**（标题/问题/答案/条目关键词），不把库名与库说明算进去。
  //    算进去的后果实测过：问「主仆关系的规则怎么定」时，整个主仆库的**每一条**都因为
  //    库说明里有「关系」「规则」而拿到同样的覆盖率，条目之间被拉平，
  //    最后谁排第一取决于加载顺序 —— 那是随机，不是相关。
  const hay = `${entry.title} ${entry.question} ${entry.answer} ${(entry.keywords || []).join(' ')}`;
  const hTok = tokenize(hay);
  let hits = 0;
  for (const t of qTok) if (hTok.has(t)) hits += 1;
  const cov = qTok.size ? hits / qTok.size : 0;
  // 库名出现在提问里时给一点领域提示（比如提问里带「主仆」），但它只是一个加数，
  // 不参与覆盖率，避免污染条目之间的排序。
  if (base.name && qRaw.includes(String(base.name).toLowerCase())) score += 2;

  // ② 关键词命中
  const keywords = [...(base.keywords || []), ...(entry.keywords || [])];
  for (const k of keywords) {
    const kk = String(k).trim().toLowerCase();
    // ⚠️ 单字关键词（上 / 干 / 停 / 湿）一律不计分。
    //    实测过的坑：「床上怎么叫对方」被一条 keywords 里含 "上" 的条目抢走，
    //    「好舒服 别停」把无关的条目也带出来 —— 单字在中文里几乎必然误命中，
    //    而真正该命中的词组会由下面的二元组重合度接住。
    if (kk.length < 2) continue;
    if (qRaw.includes(kk)) {
      if (!GENERIC_KEYWORDS.has(kk) || cov >= 0.35) {
        // 长关键词更具体，给的权重也更高：「面包硬了」应该压过「面包」。
        // 没有这一条时两者同分，并列就按加载顺序决出胜负 —— 那是随机而不是相关。
        score += kk.length >= 4 ? 8 : 6;
        why.push(`词:${kk}`);
      } else { score += 2; why.push(`弱:${kk}`); }
      continue;
    }
    // 词序容忍：中文里同一个词有多种顺序（关键词写「发芽土豆」，群友打「土豆发芽了」）。
    // 长词按二元组覆盖率判一次弱命中（+3），避免"意思明明对上了却没命中"。
    if (kk.length >= 3 && qRaw.length >= 3) {
      const parts = rawBigrams(kk);
      if (parts.length) {
        const hit = parts.filter((t) => qRaw.includes(t)).length;
        if (hit / parts.length >= 0.6) { score += 3; why.push(`近:${kk}`); }
      }
    }
  }

  // ③ 问法命中：条目的「问题」整串出现在提问里（或反过来）
  for (const t of [entry.question, entry.title].filter(Boolean)) {
    const tt = String(t).trim().toLowerCase();
    if (tt.length >= 2 && (qRaw.includes(tt) || (qRaw.length >= 2 && tt.includes(qRaw)))) {
      score += 8;
      why.push('问法命中');
      break;
    }
  }

  score += cov * 10;
  if (cov >= 0.5) why.push(`重合${Math.round(cov * 100)}%`);

  return { score, hits, cov, why };
}

/**
 * 检索。
 * @param {string} query 用户那句话
 * @param {object} opt { kb, limit, minScore, chatKey }
 *   chatKey：当前会话（group:xxx / private:xxx），用来筛掉"不在此会话生效"的库
 * @returns {Array<{base, entry, score, hits, cov, why}>}
 */
function search(query, { kb = '', limit = 5, minScore = 1.5, chatKey = '' } = {}) {
  const qRaw = String(query ?? '').trim().toLowerCase();
  if (!qRaw) return [];
  const qTok = tokenize(qRaw);
  const want = String(kb || '').trim();
  const hits = [];

  for (const base of loadBases()) {
    if (!base.enabled) continue;
    if (!inScope(base, chatKey)) continue;
    if (want && !matchBase(base, want)) continue;
    for (const entry of base.entries) {
      const r = scoreEntry(base, entry, qRaw, qTok);
      // 至少要有一个二元组真的对上，纯靠关键词表命中的也算（hits 可能为 0）
      if (r.score < minScore) continue;
      if (r.hits < 1 && !r.why.includes('问法命中') && !r.why.some((w) => w.startsWith('词:'))) continue;
      hits.push({ base, entry, ...r });
    }
  }

  hits.sort((a, b) => b.score - a.score);
  // 取结果用**按库轮转**（round-robin）：先让每本命中的库各出一条，再回头补第二条、第三条。
  //
  // 早先写的是“同一本库最多 2 条”，在有十几本小库时看着没问题，但只要用户把资料
  // 全塞进**一本大库**，这个上限就把结果饿死在 2 条 —— 一本几百条的库，
  // 问“玩具有哪些”永远只能看到 2 个条目。轮转既保留了“多本库都有机会露脸”
  // 的初衷，又不会惩罚大库。
  const byBase = new Map();
  for (const h of hits) {
    if (!byBase.has(h.base.id)) byBase.set(h.base.id, []);
    byBase.get(h.base.id).push(h);
  }
  const out = [];
  for (let round = 0; out.length < limit; round += 1) {
    let added = false;
    for (const list of byBase.values()) {
      if (round >= list.length) continue;
      out.push(list[round]);
      added = true;
      if (out.length >= limit) break;
    }
    if (!added) break;
  }
  return out;
}

function renderHits(hits, maxChars) {
  const lines = [];
  for (const h of hits) {
    const q = h.entry.question || h.entry.title;
    const head = q ? `· 【${h.base.name}】${q}` : `· 【${h.base.name}】`;
    lines.push(head);
    lines.push(`  ${h.entry.answer.split('\n').join('\n  ')}`);
  }
  return clip(lines.join('\n'), maxChars);
}

function renderAlways(bases, maxChars) {
  const lines = [];
  for (const b of bases) {
    for (const e of b.entries) {
      const q = e.question || e.title;
      lines.push(q ? `· 【${b.name}】${q}\n  ${e.answer}` : `· 【${b.name}】${e.answer}`);
    }
  }
  return clip(lines.join('\n'), maxChars);
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) return m.content.map((p) => p?.text || '').join(' ');
    return '';
  }
  return '';
}

function summarize(base) {
  const b = callStats.bases[base.id] || {};
  return {
    calls: (b.inject || 0) + (b.search || 0),
    callsInject: b.inject || 0,
    callsSearch: b.search || 0,
    callsRead: b.read || 0,
    lastCallAt: b.lastAt || 0,
    id: base.id,
    name: base.name,
    description: base.description,
    keywords: base.keywords,
    always: base.always,
    enabled: base.enabled,
    scope: base.scope || 'all',
    scopeChats: base.scopeChats || [],
    scopeLabel: scopeLabel(base),
    source: base.source,
    entryCount: base.entries.length,
    file: path.basename(base.file || '')
  };
}

/** 给页面/日志用的一句话作用域描述。 */
function scopeLabel(base) {
  const list = base.scopeChats || [];
  switch (base.scope || 'all') {
    case 'private': return '仅私聊';
    case 'groups': return list.length ? `仅 ${list.length} 个会话` : '仅指定会话（还没填）';
    case 'except': return list.length ? `除 ${list.length} 个会话外` : '排除列表（还没填）';
    default: return '全部会话';
  }
}

// 运行期计数（控制台页面显示“到底有没有在工作”）
const stats = { loads: 0, searches: 0, injectRuns: 0, injectHits: 0, lastQuery: '', lastHitCount: 0, lastInjectAt: 0 };
let disposed = false;

export function setup(api) {
  cfg = api.config || (() => ({}));
  log = (...a) => { try { api.log(...a); } catch { /* 日志失败不影响主流程 */ } };
  disposed = false;
  ensureDirs();
  cache = { sig: '', at: 0, bases: [], errors: [] };
  stats.loads += 1;
  loadCallStats();

  const bases = loadBases({ force: true });
  const total = bases.reduce((n, b) => n + b.entries.length, 0);
  const called = Object.values(callStats.entries).filter((r) => (r.inject || 0) + (r.search || 0) > 0).length;
  log(`已加载：${bases.length} 本知识库 / ${total} 条（目录 ${KB_DIR}）`);
  if (called) log(`调用统计：${called} 条知识被调用过（累计 ${Object.values(callStats.entries).reduce((n, r) => n + (r.inject || 0) + (r.search || 0), 0)} 次）—— 只统计，不影响命中`);
  if (cache.errors.length) log(`⚠️ 有 ${cache.errors.length} 个文件读不了：${cache.errors.join('；')}`);
  if (!bases.length) {
    log('还没有任何知识库。打开控制台页面（插件卡片上的 📚）新建一本，'
      + `或把 .md/.txt 文件丢进 ${DOC_DIR}`);
  }

  // ── 工具 1：检索 ──────────────────────────────────────────────────────
  api.registerTool({
    id: TOOL_IDS.search,
    name: '查知识库',
    description:
      '在所有知识库里检索资料（群规、设定、常见问题、产品与项目资料等）。'
      + '当问题可能踩到库里的固定内容、专有名词、规矩或既定说法时先用它查一次，别凭印象答。'
      + 'query 用群友原话里最关键的几个词；不确定是哪本库就别填 kb，全库一起查。',
    category: 'knowledge',
    icon: '📚',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词：把问题里最关键的人名/名词/说法放进来' },
        kb: { type: 'string', description: '可选：只查某一本库，填库的 id 或名字（不确定就留空）' },
        limit: { type: 'integer', description: '最多返回几条，默认用设置里的值', minimum: 1, maximum: 20 }
      },
      required: ['query']
    },
    execute(ctx, args) {
      try {
        const q = String(args?.query ?? '').trim();
        if (!q) return { content: '没给检索词。把问题里最关键的名词发我。', isError: true };
        const c = cfg();
        const chatKey = ctx?.chatKey || '';
        const limit = clampInt(args?.limit, 1, 20, clampInt(c.toolLimit, 1, 20, 5));
        // 指定了某一本库但它在这个会话里不生效时，必须**明说**而不是当作"没查到" ——
        // 否则模型会回答"知识库里没有"，用户以为资料丢了。
        const want = String(args?.kb || '').trim();
        if (want) {
          const target = loadBases().find((b) => matchBase(b, want));
          if (target && (!target.enabled || !inScope(target, chatKey))) {
            return { content: `《${target.name}》在当前会话里不生效（已停用或限定了生效范围），换个问题或按你自己的判断回答。` };
          }
        }
        stats.searches += 1;
        stats.lastQuery = q;
        const hits = search(q, { kb: want, limit, minScore: 1.5, chatKey });
        stats.lastHitCount = hits.length;
        if (!hits.length) {
          const names = loadBases().filter((b) => b.enabled && inScope(b, chatKey)).map((b) => b.name);
          return {
            content: names.length
              ? `知识库里没有关于「${q}」的内容（当前可用 ${names.length} 本：${names.join('、')}）。按你自己的判断回答，不要提知识库。`
              : '当前会话没有可用的知识库。按你自己的判断回答，不要提知识库。'
          };
        }
        if (c.debugLog) log(`[工具] 查「${q}」命中 ${hits.length} 条：${hits.map((h) => `${h.base.name}/${h.entry.id}(${h.score.toFixed(1)})`).join(', ')}`);
        // 计数在**取完结果之后**记：它读的是 hits，不参与 hits 的产生
        recordHits(hits, 'search');
        return {
          content: `从知识库里查到 ${hits.length} 条（按相关度排序，直接用里面的说法回答，不要念"知识库"三个字）：\n`
            + renderHits(hits, 2000)
        };
      } catch (error) {
        return { content: `查知识库失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 工具 2：列目录 ────────────────────────────────────────────────────
  api.registerTool({
    id: TOOL_IDS.list,
    name: '列出知识库',
    description: '列出目前有哪些知识库、各自是干什么的、有多少条。不确定该查哪本、或想知道有没有相关资料时用它。',
    category: 'knowledge',
    icon: '📚',
    parameters: { type: 'object', properties: {} },
    execute(ctx, args) {
      try {
        void args;
        // 只列**当前会话可用**的库：列出一本用不了的，模型会去查它然后扑空
        const bases = loadBases().filter((b) => inScope(b, ctx?.chatKey || ''));
        if (!bases.length) return { content: '当前会话没有可用的知识库。' };
        const body = bases.map((b) => {
          const flags = [b.enabled ? '' : '（已停用）', b.always ? '（常驻）' : '', b.source === 'doc' ? '（文档库）' : ''].join('');
          return `· ${b.name}（${b.id}）${flags}：${b.description || '无说明'} — ${b.entries.length} 条`;
        }).join('\n');
        return { content: `共有 ${bases.length} 本知识库：\n${body}` };
      } catch (error) {
        return { content: `读取失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 工具 3：读整本 ────────────────────────────────────────────────────
  api.registerTool({
    id: TOOL_IDS.read,
    name: '读取整本知识库',
    description: '把某一本知识库的全文读出来。需要完整照着念（比如群规全文、完整设定）时用它；先 kb_list 拿到库 id。',
    category: 'knowledge',
    icon: '📚',
    parameters: {
      type: 'object',
      properties: {
        kb: { type: 'string', description: '库的 id 或名字' },
        maxChars: { type: 'integer', description: '最多读多少字，默认 1500', minimum: 100, maximum: 6000 }
      },
      required: ['kb']
    },
    execute(ctx, args) {
      try {
        const want = String(args?.kb ?? '').trim();
        if (!want) return { content: '要读哪一本？填库的 id 或名字。', isError: true };
        const base = loadBases().find((b) => matchBase(b, want));
        if (base && !base.enabled) return { content: `《${base.name}》已被停用。`, isError: true };
        if (base && !inScope(base, ctx?.chatKey || '')) {
          return { content: `《${base.name}》在当前会话里不生效（限定了生效范围）。`, isError: true };
        }
        if (!base) {
          const names = loadBases().filter((b) => inScope(b, ctx?.chatKey || '')).map((b) => `${b.name}（${b.id}）`).join('、');
          return { content: `没有叫「${want}」的知识库。当前可用：${names || '（没有）'}`, isError: true };
        }
        const maxChars = clampInt(args?.maxChars, 100, 6000, 1500);
        const body = base.entries
          .map((e) => (e.question || e.title ? `${e.question || e.title}\n${e.answer}` : e.answer))
          .join('\n---\n');
        // 读整本按**库**计数，不摊到每条（否则读一次就把整本条目全刷一遍，排行失去意义）
        recordBaseRead(base.id);
        return { content: `《${base.name}》全文：\n${clip(body, maxChars)}` };
      } catch (error) {
        return { content: `读取失败：${error?.message ?? error}`, isError: true };
      }
    }
  });
}

// ── 钩子 1：接住可用的时机（顺带刷新缓存 + 一次性状态日志）─────────────────
export const hooks = {
  async 'before-context'() {
    if (disposed) return;
    try { loadBases(); } catch { /* 读不到就让下面的注入自己降级 */ }
  },

  // ── 钩子 2：确定性注入 ────────────────────────────────────────────────
  // 为什么用 before-llm-messages 而不是 before-context：
  //   宿主给每个钩子的上下文**不一样**（orchestrator.js 里逐个写死）——
  //      before-context      → { ...skillContext, triggerEntries, store, memory }
  //      before-llm-messages → { ...skillContext, messages }   ← 只有它能直接改 messages
  //   注入必须落在 messages 上，所以只能用这个钩子。往数组末尾 push 一条 system 消息，
  //   不改动核心提示词，也不抢占它的位置（与 graph-memory 同一做法）。
  async 'before-llm-messages'(context = {}) {
    if (disposed) return;
    try {
      const c = cfg();
      if (c.enabled === false) return;
      const messages = context?.messages;
      if (!Array.isArray(messages) || !messages.length) return;

      const chatKey = context?.chatKey || '';
      // 只考虑**在当前会话生效**的库：作用域在检索这一层就拦住，
      // 自动注入、主动检索、清单提示三条路径同时收口，不会有一条漏网。
      const bases = loadBases().filter((b) => inScope(b, chatKey));
      if (!bases.length) return;
      const query = lastUserText(messages).trim();
      if (!query) return;

      stats.injectRuns += 1;
      const parts = [];

      // ① 常驻库：每轮都带上（群规这类“必须一直遵守”的）
      const always = bases.filter((b) => b.enabled && b.always && b.entries.length);
      if (always.length) {
        parts.push('【常驻知识（始终遵守，和当前话题无关也要照做）】\n'
          + renderAlways(always, clampInt(c.alwaysMaxChars, 200, 6000, 1200)));
      }

      // ② 命中即带：门槛由设置里的“最低相关度”控制
      if (c.autoInject !== false) {
        const hits = search(query, {
          limit: clampInt(c.maxInjectHits, 1, 10, 3),
          minScore: clampInt(c.autoInjectMinScore, 1, 30, 6),
          chatKey
        });
        if (hits.length) {
          stats.injectHits += 1;
          stats.lastInjectAt = Date.now();
          stats.lastQuery = query;
          stats.lastHitCount = hits.length;
          // 只统计：这里读的是已经算好的 hits，计数不参与任何排序
          recordHits(hits, 'inject');
          parts.push('【知识库参考（与当前话题相关，按这里说的回答；不要念出来，也不要提知识库）】\n'
            + renderHits(hits, clampInt(c.maxInjectChars, 100, 6000, 900)));
          if (c.debugLog) log(`注入 ${hits.length} 条：${hits.map((h) => `${h.base.name}/${h.entry.id}(${h.score.toFixed(1)})`).join(', ')}｜查的是「${clip(query, 40)}」`);
        } else if (c.debugLog && always.length === 0) {
          log(`本轮没有命中知识库｜查的是「${clip(query, 40)}」`);
        }
      }

      if (!parts.length) return;
      messages.push({ role: 'system', content: parts.join('\n\n') });
    } catch (error) {
      log(`注入失败（本轮跳过）：${error?.message ?? error}`);
    }
  }
};

// ── 动态提示词：知识库清单 ───────────────────────────────────────────────
// 让模型“知道有哪几本库”才会想起来查。只在库真的变了的时候内容才变，
// 所以不会破坏系统提示的前缀缓存。
export function promptSections(context = {}) {
  try {
    const c = cfg();
    if (c.enabled === false || c.catalogInPrompt === false) return [];
    // 清单也要按会话过滤：在群里不该让模型知道"有一本只在私聊能用的库"，
    // 否则它会去查、查不到，然后回答"资料里没有"。
    const bases = loadBases().filter((b) => b.enabled && inScope(b, context?.chatKey || ''));
    if (!bases.length) return [];
    const lines = bases.map((b) => `· ${b.name}（${b.id}）${b.always ? '［常驻］' : ''}：${b.description || '无说明'} — ${b.entries.length} 条`);
    return [{
      id: 'kb-hub-catalog',
      title: '我的知识库清单',
      priority: 42,
      content: `你现在可以查这些知识库：\n${lines.join('\n')}\n`
        + `问题可能踩到库里内容时，用 ${TOOL_PREFIX}${TOOL_IDS.search} 查（带 kb 参数可只查某一本）；`
        + `不确定有哪些库就先 ${TOOL_PREFIX}${TOOL_IDS.list}；要整本通读用 ${TOOL_PREFIX}${TOOL_IDS.read}。`
    }];
  } catch {
    return [];
  }
}

/** 永远可用：没有库的时候也要能加载，否则用户会看到“依赖未就绪”却不知道去建库。 */
export function available() { return true; }

export function activate() { disposed = false; }
export function deactivate() {
  // 本插件没有定时器/监听器；这里只标记状态，避免热重载期间旧实例继续注入。
  disposed = true;
  // 热重载/禁用/退出前把还没落盘的统计写掉，否则最近的调用计数会丢
  flushCallStats({ force: true });
}
export function dispose() {
  disposed = true;
  flushCallStats({ force: true });
}

// ── 控制台页面动作（POST /api/plugin-ui/kb-hub/action）────────────────────
// 页面**不做任何判定**，数据全部来自这里 —— 保证“界面显示的”和“实际生效的”同源。
export async function handleUiRequest(body = {}) {
  const action = String(body.action || '').trim();
  const payload = body.payload || {};

  switch (action) {
    case 'state': {
      const bases = allBases();
      return {
        ok: true,
        dirs: { kb: KB_DIR, docs: DOC_DIR },
        settings: cfg(),
        stats: { ...stats, totalEntries: bases.reduce((n, b) => n + b.entries.length, 0) },
        bases: bases.map(summarize),
        errors: cache.errors
      };
    }

    case 'get': {
      const base = allBases().find((b) => matchBase(b, payload.id));
      if (!base) return { ok: false, error: `没有这本库：${payload.id}` };
      // 顺手把这条库每条知识的调用次数带上，页面里直接标注（编辑器不做二次请求）
      const calls = {};
      for (const e of base.entries) calls[e.id] = entryCallCount(base.id, e.id);
      return { ok: true, base: { ...base, file: path.basename(base.file || '') }, calls };
    }

    // ── 调用统计（只读展示，**不影响检索**）──────────────────────────────
    case 'stats': {
      const limit = clampInt(payload.limit, 1, 500, 50);
      const sortBy = ['total', 'inject', 'search'].includes(payload.sortBy) ? payload.sortBy : 'total';
      flushCallStats();   // 读之前先落一次盘，避免刚调用完刷新页面看到旧数字
      return { ok: true, ...buildRanking({ limit, sortBy, includeZero: payload.includeZero === true }), file: STATS_FILE };
    }

    case 'stats-reset': {
      callStats.entries = {};
      callStats.bases = {};
      statsDirty = true;
      flushCallStats({ force: true });
      log('调用统计已清零');
      return { ok: true };
    }

    case 'create': {
      ensureDirs();
      const name = String(payload.name || '').trim();
      if (!name) return { ok: false, error: '库名不能为空' };
      const rawId = String(payload.id || '').trim() || slugify(name);
      if (!ID_RE.test(rawId)) return { ok: false, error: `id 只能用小写英文/数字/._-（当前：${rawId}）` };
      const file = path.join(KB_DIR, `${rawId}.json`);
      if (fs.existsSync(file)) return { ok: false, error: `已经有一本 id 叫 ${rawId} 的库了，换个 id 或直接编辑它` };
      const base = {
        id: rawId,
        name,
        description: String(payload.description || '').trim(),
        keywords: splitList(payload.keywords),
        always: payload.always === true,
        enabled: true,
        scope: SCOPE_MODES.has(String(payload.scope)) ? String(payload.scope) : 'all',
        scopeChats: splitList(payload.scopeChats),
        entries: [],
        updatedAt: Date.now()
      };
      writeBase(file, base);
      loadBases({ force: true });
      return { ok: true, base: summarize(allBases().find((b) => b.id === rawId) || { ...base, file, source: 'json' }) };
    }

    case 'save': {
      const raw = payload.base;
      if (!raw || typeof raw !== 'object') return { ok: false, error: '没有收到要保存的内容' };
      const existing = allBases().find((b) => String(b.id) === String(raw.id));
      if (existing?.source === 'doc') {
        return { ok: false, error: '这是文档库（一个 .md/.txt 文件），正文请在文件里改；页面里只能改它的说明和常驻开关（用“保存文档库设置”）' };
      }
      const id = String(raw.id || '').trim();
      if (!ID_RE.test(id)) return { ok: false, error: `id 不合法：${id}` };
      const entries = (Array.isArray(raw.entries) ? raw.entries : [])
        .map((e, i) => normalizeEntry(e, i))
        .filter(Boolean);
      const base = {
        id,
        name: String(raw.name || id).trim(),
        description: String(raw.description || '').trim(),
        keywords: splitList(raw.keywords),
        always: raw.always === true,
        enabled: raw.enabled !== false,
        scope: SCOPE_MODES.has(String(raw.scope)) ? String(raw.scope) : 'all',
        scopeChats: splitList(raw.scopeChats),
        entries,
        updatedAt: Date.now()
      };
      writeBase(path.join(KB_DIR, `${id}.json`), base);
      loadBases({ force: true });
      return { ok: true, saved: summarize(allBases().find((b) => b.id === id) || { ...base, file: '', source: 'json' }) };
    }

    case 'save-meta': {
      // 只改“说明/关键词/常驻/停用”，不动条目。
      // 文档库（.md/.txt）的正文在文件里，这几点只能写进 <文件名>.meta.json 旁注；
      // 结构化库则直接回写自己的 json —— 两条路都对，调用方不必先判断类型。
      const base = allBases().find((b) => matchBase(b, payload.id));
      if (!base) return { ok: false, error: `没有这本库：${payload.id}` };
      const pick = (v, dflt) => (v === undefined ? dflt : v);
      if (base.source === 'doc') {
        const meta = {
          id: `meta:${path.basename(base.file)}`,
          name: String(pick(payload.name, base.name)),
          description: String(pick(payload.description, base.description)).trim(),
          keywords: splitList(pick(payload.keywords, base.keywords)),
          always: payload.always === undefined ? base.always : payload.always === true,
          enabled: payload.enabled === undefined ? base.enabled : payload.enabled !== false,
          scope: SCOPE_MODES.has(String(pick(payload.scope, base.scope))) ? String(pick(payload.scope, base.scope)) : 'all',
          scopeChats: splitList(pick(payload.scopeChats, base.scopeChats)),
          entries: [],
          updatedAt: Date.now(),
          // 标记：这是文档库的旁注，不要被当成一本空库显示
          metaFor: path.basename(base.file)
        };
        writeBase(path.join(KB_DIR, `${path.basename(base.file)}${META_SUFFIX}`), meta);
      } else {
        const raw = JSON.parse(readText(base.file));
        if (payload.name !== undefined) raw.name = String(payload.name).trim();
        if (payload.description !== undefined) raw.description = String(payload.description).trim();
        if (payload.keywords !== undefined) raw.keywords = splitList(payload.keywords);
        if (payload.always !== undefined) raw.always = payload.always === true;
        if (payload.enabled !== undefined) raw.enabled = payload.enabled !== false;
        if (payload.scope !== undefined && SCOPE_MODES.has(String(payload.scope))) raw.scope = String(payload.scope);
        if (payload.scopeChats !== undefined) raw.scopeChats = splitList(payload.scopeChats);
        raw.id = base.id;
        raw.entries = Array.isArray(raw.entries) ? raw.entries : [];
        raw.updatedAt = Date.now();
        writeBase(base.file, raw);
      }
      loadBases({ force: true });
      return { ok: true };
    }

    case 'delete': {
      const base = allBases().find((b) => matchBase(b, payload.id));
      if (!base) return { ok: false, error: `没有这本库：${payload.id}` };
      const target = path.resolve(base.file || '');
      const inKb = target.startsWith(path.resolve(KB_DIR) + path.sep);
      if (!inKb) return { ok: false, error: '拒绝删除：文件不在知识库目录内' };
      try {
        fs.rmSync(target, { force: true });
        const meta = path.join(KB_DIR, `${path.basename(target)}.meta.json`);
        if (fs.existsSync(meta)) fs.rmSync(meta, { force: true });
      } catch (error) {
        return { ok: false, error: `删除失败：${error?.message ?? error}` };
      }
      loadBases({ force: true });
      return { ok: true, deleted: base.name };
    }

    case 'import': {
      ensureDirs();
      const name = String(payload.name || '').trim();
      const text = String(payload.text || '').trim();
      if (!name) return { ok: false, error: '给这本库起个名字' };
      if (!text) return { ok: false, error: '要导入的正文是空的' };
      const rawId = String(payload.id || '').trim() || slugify(name);
      if (!ID_RE.test(rawId)) return { ok: false, error: `id 只能用小写英文/数字/._-（当前：${rawId}）` };
      const file = path.join(KB_DIR, `${rawId}.json`);
      if (fs.existsSync(file)) return { ok: false, error: `已经有一本 id 叫 ${rawId} 的库了` };
      const parsed = parseDoc(text, name);
      const base = {
        id: rawId,
        name,
        description: String(payload.description || '').trim(),
        keywords: splitList(payload.keywords),
        always: payload.always === true,
        enabled: true,
        scope: SCOPE_MODES.has(String(payload.scope)) ? String(payload.scope) : 'all',
        scopeChats: splitList(payload.scopeChats),
        entries: parsed.entries,
        updatedAt: Date.now()
      };
      writeBase(file, base);
      loadBases({ force: true });
      return { ok: true, id: rawId, entries: base.entries.length };
    }

    case 'test': {
      const query = String(payload.query || '').trim();
      if (!query) return { ok: false, error: '先打一句话' };
      const c = cfg();
      // 页面可以带一个"模拟会话"（group:群号 / private:QQ）来验证作用域；
      // 不带会话时只放行 scope=all 的库 —— 与真实链路的口径保持一致，
      // 不然会出现"页面说会命中、群里其实被作用域挡掉了"这种最坑人的偏差。
      const chatKey = String(payload.chatKey || '').trim();
      const all = loadBases();
      const usable = all.filter((b) => b.enabled && inScope(b, chatKey));
      const blocked = all.filter((b) => b.enabled && !inScope(b, chatKey));
      const hits = search(query, {
        limit: clampInt(c.maxInjectHits, 1, 10, 3),
        minScore: clampInt(c.autoInjectMinScore, 1, 30, 6),
        chatKey
      });
      const always = usable.filter((b) => b.always && b.entries.length);
      const parts = [];
      if (always.length) parts.push('【常驻知识】\n' + renderAlways(always, clampInt(c.alwaysMaxChars, 200, 6000, 1200)));
      if (hits.length) parts.push('【知识库参考】\n' + renderHits(hits, clampInt(c.maxInjectChars, 100, 6000, 900)));
      return {
        ok: true,
        hits: hits.map((h) => ({
          base: h.base.name, id: h.entry.id, question: h.entry.question || h.entry.title,
          answer: clip(h.entry.answer, 200), score: Number(h.score.toFixed(2)), why: h.why
        })),
        threshold: clampInt(c.autoInjectMinScore, 1, 30, 6),
        chatKey: chatKey || '(未指定，只测全部会话的库)',
        usableBases: usable.map((b) => b.name),
        blockedBases: blocked.map((b) => `${b.name}（${scopeLabel(b)}）`),
        injected: parts.join('\n\n')
      };
    }

    case 'reload': {
      const bases = loadBases({ force: true });
      return { ok: true, bases: bases.length, entries: bases.reduce((n, b) => n + b.entries.length, 0), errors: cache.errors };
    }

    case 'open-dir': {
      const which = payload.which === 'docs' ? DOC_DIR : KB_DIR;
      ensureDirs();
      try {
        spawn('explorer.exe', [which], { detached: true, stdio: 'ignore' }).unref();
      } catch (error) {
        return { ok: false, error: `打不开文件夹：${error?.message ?? error}` };
      }
      return { ok: true, dir: which };
    }

    default:
      return { ok: false, error: `未知动作：${action || '(空)'}` };
  }
}

// ── 小工具 ──────────────────────────────────────────────────────────────

function writeBase(file, base) {
  ensureDirs();
  fs.writeFileSync(file, `${JSON.stringify(base, null, 2)}\n`, 'utf8');
}

function clampInt(v, lo, hi, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

function splitList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  return String(v ?? '').split(/[,，、\n\r;；\s]+/).map((x) => x.trim()).filter(Boolean);
}

function slugify(name) {
  const ascii = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (ascii && ID_RE.test(ascii)) return ascii;
  // 中文名 → kb-时间戳，保证 id 合法且不撞车
  return `kb-${Date.now().toString(36)}`;
}
