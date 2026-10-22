// 表情包记忆库（sticker-memory）—— 同一个表情包只让模型认一次。
//
// ══════════════════════════════════════════════════════════════════════════
// 一、为什么是**插件**（plugins/，确定性型），不是技能（skills/）
// ══════════════════════════════════════════════════════════════════════════
// 按 doc/extend_development/skill-development.md §0 的三问判断法：
//
//   第一问「触发时机能用 if 描述吗？」
//     if (模型正要调 get_message_images / get_sticker_image)        → ✅ 能，死条件
//     if (这条消息里的图片指纹已经在记忆库里)                        → ✅ 能，死条件
//   第二问「漏触发一次的代价是什么？」
//     漏一次 = 白白多花一次识图 token、多等一次模型。这不是"少个花活"，
//     而是这个功能的存在意义本身（省时间、省 token）。→ 必须每次都跑
//   第三问「参数从哪来？」
//     参数全是系统给的：会话、消息 id、媒体 url/file、图片字节。→ 插件
//
//   三问一致 → 插件。所以它用 hooks + 工具（不声明任何自建能力）：钩子由核心
//   在固定时机必然调用，"想不想省"不由模型决定；模型只负责一件事 —— 第一次
//   看完图后把含义记下来（remember_image 工具），那是"要不要写笔记"的语义判断。
//
//   （为什么没有 providers：`plugin-development.md` §5 写得很清楚 —— 自建能力名
//     核心不认识，只有别的 Skill 会用 api.capability() 找它。本插件没有这样的
//     消费方，声明成 capability 只会被审计报成"公开能力、暂无消费方"。）
//
// ⚠️ 关键事实（读源码 + 文档确认，决定了整个设计）：
//   · 收消息时图片只渲染成 [图片] 占位（src/onebot.js segmentsToText），
//     模型**不会**自动看到图 —— 唯一的看图入口是核心工具
//     get_message_images（别人的图）与 get_sticker_image（自己的收藏）。
//     所以"跳过图像识别"= 在这两个工具执行前拦下它。
//   · 5 个 hook 只在**一次模型会话运行**里触发（orchestrator.js 的 #runAgent），
//     没触发会话的消息看不见 —— 恰好本功能只在"要看图"时才需要介入。
//   · before-tool 能返回 { block: true, reason }，顶层会把 reason 原样当作
//     工具结果文本回给模型（orchestrator.js:1147）。所以缓存命中的含义就是
//     这样"零成本地"喂给模型的：不是报错，而是一句说明。
//
// ══════════════════════════════════════════════════════════════════════════
// 二、指纹与命中率（这一节是"能不能真省下来"的关键）
// ══════════════════════════════════════════════════════════════════════════
// 同一个表情包，QQ 每次下发的 url 往往带不同的 rkey（会过期），所以**不能只
// 靠 url 认图**。这里的键有三层，任意一层命中即算认识：
//   src:<内容 sha1>   图片字节的哈希 —— 最可靠，跨群跨人通用（首选）
//   file:<file 字段>  OneBot 给的图片标识（文件名或资源 id）
//   st:<表情 id/resId> 机器人自己的收藏表情身份
// 首见一张图要下载一次字节才能算 src 键（此后永久有效，老图库也自动受益）。
// 为了不拖慢对话：解析带预算（默认 2.8 秒，见 maxDownloadMs 设置），超预算就
// **本轮不拦截**（照常看图），但下载在后台继续 —— 下一次再遇到就已经命中了。
//
// 命中的有效期按"同一个会话 / 跨会话"分两档（recheckSameChatHours 默认 24h、
// recheckCrossChatDays 默认 7 天），过期会自动重新确认一次，避免群友改用法后
// 一直用旧含义。两档都可以设成 0 = 永不重新确认（最省 token）。
//
// ══════════════════════════════════════════════════════════════════════════
// 三、边界（都不会让对话出错）
// ══════════════════════════════════════════════════════════════════════════
//   · 所有 hook 内部全程 try/catch：本插件出任何问题都只是"没生效"，
//     绝不中断对话（hook 超时/抛错本身也只记日志、跳过该 Skill）。
//   · 网络：清单声明了 permissions: ["web_fetch"]，但优先走核心的
//     safe-fetch.safeFetchBinary —— 与项目其它联网模块同一套 SSRF 口径
//     （DNS 全记录内网检查 + 固定 IP 防 rebinding）。只有拿不到核心模块时，
//     才退回自带的护栏下载器（只放行公网 http(s)、限 12MB、8 秒超时、只收图片）。
//   · 只读别人，不写别人的库：不改 data/stickers.json（那是 StickerManager
//     的内存态，外部写会互相覆盖）。表情库的备注走模型自己的 sticker_note。
//   · stickerOnly（默认开）：只缓存表情包/动图表情；截图、照片、带文字的图
//     不缓存 —— 那些图再发一次内容可能已经变了，复用旧含义会答错。
//   · 缓存落在 data/sticker-memory/，不用 process.cwd() 当锚点。
//   · 不写任何密钥/Cookie：全部数据都在本机 data/sticker-memory/cache.json。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';

const PLUGIN_ID = 'sticker-memory';
const DIR = path.join(DATA_DIR, PLUGIN_ID);
const CACHE_FILE = path.join(DIR, 'cache.json');
const FLUSH_DEBOUNCE_MS = 8000;
const MAX_BYTES = 12 * 1024 * 1024;
const MIN_VIEW_LINK_MS = 10 * 60 * 1000;      // "刚看过"的关联有效期（10 分钟）
const MAX_PENDING_PER_CHAT = 6;
const MAX_NOTE_CHARS = 200;
const MAX_VALUE_CHARS = 40;

/** 与 plugin.json 的 settings 保持一致（留一份是为了加载顺序与容错）。 */
const DEFAULTS = {
  enabled: true,
  stickerOnly: true,
  maxCacheEntries: 2000,
  recheckSameChatHours: 24,
  recheckCrossChatDays: 7,
  skipThreshold: 0.5,
  maxDownloadMs: 2800
};

let cfg = () => ({ ...DEFAULTS });
let log = () => {};
let warn = () => {};
let safeFetchBinary = null;
let apiFetch = null;

// ─────────────────────────────────────────────── 配置

function conf() {
  let merged = { ...DEFAULTS };
  try {
    const raw = cfg();
    if (raw && typeof raw === 'object') merged = { ...merged, ...raw };
  } catch { /* 配置读不到就用默认值 */ }
  return {
    enabled: merged.enabled !== false,
    stickerOnly: merged.stickerOnly !== false,
    maxCacheEntries: clamp(Number(merged.maxCacheEntries), 50, 20000, DEFAULTS.maxCacheEntries),
    recheckSameChatHours: Math.max(0, num(merged.recheckSameChatHours, DEFAULTS.recheckSameChatHours)),
    recheckCrossChatDays: Math.max(0, num(merged.recheckCrossChatDays, DEFAULTS.recheckCrossChatDays)),
    skipThreshold: clamp(Number(merged.skipThreshold), 0, 1, DEFAULTS.skipThreshold),
    maxDownloadMs: clamp(Number(merged.maxDownloadMs), 200, 4500, DEFAULTS.maxDownloadMs)
  };
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, lo, hi, fallback) {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

// ─────────────────────────────────────────────── 小工具

function clean(s, max = MAX_NOTE_CHARS) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 提示词里的值要防注入：去掉换行/方括号，避免被当成系统指令。 */
function safeValue(s) {
  return clean(s, MAX_VALUE_CHARS).replace(/[[\]{}<>]/g, '').trim();
}

function nowMs() {
  return Date.now();
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, file);
}

/** 只放行公网 http(s) 直链（与项目里其它联网模块的 SSRF 口径一致）。 */
function isPublicHttpUrl(u) {
  if (!/^https?:\/\//i.test(String(u || ''))) return false;
  let host = '';
  try { host = new URL(u).hostname.toLowerCase(); } catch { return false; }
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (/^(127|10|0)\./.test(host)) return false;
  if (/^192\.168\./.test(host)) return false;
  if (/^169\.254\./.test(host)) return false;
  const m = host.match(/^172\.(\d{1,3})\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return false;
  if (host.includes(':')) return false;
  return true;
}

function fileUriToPath(raw) {
  const value = String(raw ?? '').trim();
  if (!value.toLowerCase().startsWith('file:///')) return '';
  try {
    let pathname = decodeURIComponent(new URL(value).pathname);
    if (/^\/[A-Za-z]:[\\/]/.test(pathname)) pathname = pathname.slice(1);
    return pathname;
  } catch {
    return '';
  }
}

function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 32);
}

function isAnimationMarker(summary) {
  const s = String(summary ?? '');
  return /动画表情|動畫表情|animated|sticker|表情包|meme/i.test(s);
}

// ─────────────────────────────────────────────── 记忆库存储层

/** 内存库：entry = { src,file,st,chatKey,note,source,createdAt,usedAt,useCount,hits } */
const store = {
  entries: new Map(),
  byKey: new Map(),
  loadedAt: 0,
  dirty: false,
  lastFlush: 0
};

function keysOf(entry) {
  const keys = [];
  if (entry.src) keys.push(`src:${entry.src}`);
  if (entry.file) keys.push(`file:${entry.file}`);
  if (entry.st) keys.push(`st:${entry.st}`);
  return keys;
}

function indexEntry(entry) {
  for (const k of keysOf(entry)) store.byKey.set(k, entry);
}

function unindexEntry(entry) {
  for (const k of keysOf(entry)) {
    if (store.byKey.get(k) === entry) store.byKey.delete(k);
  }
}

function loadStore() {
  if (store.loadedAt) return;
  store.loadedAt = nowMs();
  const raw = readJson(CACHE_FILE, null);
  const list = Array.isArray(raw?.entries) ? raw.entries : [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const note = clean(item.note);
    if (!note) continue;
    const entry = {
      src: clean(item.src, 64),
      file: clean(item.file, 200),
      st: clean(item.st, 120),
      chatKey: clean(item.chatKey, 60),
      note,
      source: item.source === 'model' ? 'model' : 'observed',
      createdAt: num(item.createdAt, nowMs()),
      usedAt: num(item.usedAt, 0),
      useCount: Math.max(0, num(item.useCount, 0)),
      hits: Math.max(0, num(item.hits, 0))
    };
    if (!entry.src && !entry.file && !entry.st) continue;
    store.entries.set(`${entry.src}|${entry.file}|${entry.st}|${entry.createdAt}`, entry);
    indexEntry(entry);
  }
  if (list.length) log(`记忆库已加载：${store.entries.size} 条（${path.basename(CACHE_FILE)}）`);
}

function flushStore(force = false) {
  if (!store.dirty) return false;
  const now = nowMs();
  if (!force && now - store.lastFlush < FLUSH_DEBOUNCE_MS) return false;
  store.lastFlush = now;
  store.dirty = false;
  try {
    trimStore();
    writeJsonAtomic(CACHE_FILE, {
      version: 1,
      savedAt: new Date(now).toISOString(),
      entries: [...store.entries.values()].map((e) => ({
        src: e.src, file: e.file, st: e.st, chatKey: e.chatKey,
        note: e.note, source: e.source,
        createdAt: e.createdAt, usedAt: e.usedAt, useCount: e.useCount, hits: e.hits
      }))
    });
    return true;
  } catch (error) {
    warn(`记忆库写盘失败：${error?.message ?? error}`);
    store.dirty = true;
    return false;
  }
}

function trimStore() {
  const limit = conf().maxCacheEntries;
  if (store.entries.size <= limit) return;
  const sorted = [...store.entries.entries()].sort((a, b) => score(a[1]) - score(b[1]));
  const drop = store.entries.size - limit;
  for (let i = 0; i < drop; i++) {
    const [id, entry] = sorted[i];
    unindexEntry(entry);
    store.entries.delete(id);
  }
  store.dirty = true;
  log(`记忆库超过上限，淘汰 ${drop} 条最久未用的条目`);
}

/** 排序分：用得多的、最近用过的留下。 */
function score(e) {
  return (e.useCount || 0) * 1e12 + (e.usedAt || e.createdAt || 0);
}

function putEntry({ keys = [], note, chatKey = '', source = 'observed', onlyIfEmpty = false }) {
  loadStore();
  const cleanNote = clean(note);
  if (!cleanNote) return { ok: false, reason: 'note 为空' };
  const src = clean(keys.find((k) => String(k).startsWith('src:'))?.slice(4) || '', 64);
  const file = clean(keys.find((k) => String(k).startsWith('file:'))?.slice(5) || '', 200);
  const st = clean(keys.find((k) => String(k).startsWith('st:'))?.slice(3) || '', 120);
  if (!src && !file && !st) return { ok: false, reason: '没有可用的指纹' };

  // 先看是不是已经认识这个表情（命中任意键即同一条）
  const hit = lookupByKeys({ src, file, st });
  if (hit) {
    if (onlyIfEmpty && hit.note) return { ok: true, entry: hit, unchanged: true };
    hit.note = cleanNote;
    hit.source = source;
    hit.usedAt = nowMs();
    hit.useCount = (hit.useCount || 0) + 1;
    if (src && !hit.src) hit.src = src;
    if (file && !hit.file) hit.file = file;
    if (st && !hit.st) hit.st = st;
    if (chatKey) hit.chatKey = chatKey;
    indexEntry(hit);
    store.dirty = true;
    return { ok: true, entry: hit, updated: true };
  }

  const entry = {
    src, file, st,
    chatKey: clean(chatKey, 60),
    note: cleanNote,
    source,
    createdAt: nowMs(),
    usedAt: nowMs(),
    useCount: 0,
    hits: 0
  };
  store.entries.set(`${src}|${file}|${st}|${entry.createdAt}`, entry);
  indexEntry(entry);
  store.dirty = true;
  return { ok: true, entry, created: true };
}

function lookupByKeys({ src = '', file = '', st = '' } = {}) {
  loadStore();
  if (src) { const e = store.byKey.get(`src:${src}`); if (e) return e; }
  if (file) { const e = store.byKey.get(`file:${file}`); if (e) return e; }
  if (st) { const e = store.byKey.get(`st:${st}`); if (e) return e; }
  return null;
}

function forgetEntry(keys = []) {
  loadStore();
  const hit = lookupByKeys({
    src: clean(keys.find((k) => String(k).startsWith('src:'))?.slice(4) || '', 64),
    file: clean(keys.find((k) => String(k).startsWith('file:'))?.slice(5) || '', 200),
    st: clean(keys.find((k) => String(k).startsWith('st:'))?.slice(3) || '', 120)
  });
  if (!hit) return false;
  unindexEntry(hit);
  for (const [id, e] of store.entries) {
    if (e === hit) store.entries.delete(id);
  }
  store.dirty = true;
  return true;
}

// ─────────────────────────────────────────────── 指纹解析

/** key → Promise<keys[]|null>，同一个图只算一次。 */
const keyCache = new Map();
const inflight = new Map();

function rememberKeys(keys) {
  if (!Array.isArray(keys) || !keys.length) return;
  for (const k of keys) keyCache.set(k, Promise.resolve(keys));
}

/**
 * 把一张 incoming 图片解析成一组键。带预算：超时返回 null（本轮不拦截，
 * 但后台的 Promise 会继续跑完并把结果写进 keyCache，所以下次就命中了）。
 */
async function resolveMediaKeys(media, budgetMs) {
  if (!media || typeof media !== 'object') return null;
  loadStore();

  const file = clean(media.file, 200);
  const url = String(media.url || '').trim();
  const direct = [];
  if (file) direct.push(`file:${file}`);
  if (file) direct.push(`src:${file.toLowerCase()}`);

  // 0) 内存键缓存（最快路径：上一轮已经算过）
  for (const k of direct) {
    const cached = keyCache.get(k);
    if (cached) return cached;
  }
  // 1) 直接命中记忆库（不下载）
  if (lookupByKeys({ file })) return direct.length ? direct : null;

  // 2) 需要下载字节算 src 键（或命中本机已存在的文件）
  const local = fileUriToPath(url);
  const cacheKey = url || file;
  let job = inflight.get(cacheKey);
  if (!job) {
    job = (async () => {
      const buf = await fetchImageBytes({ url, file, local });
      if (!buf || !buf.length) return null;
      const keys = [];
      if (file) keys.push(`file:${file}`);
      keys.push(`src:${sha1(buf)}`);
      return keys;
    })();
    job.then((keys) => {
      if (keys && keys.length) rememberKeys(keys);
    }).catch(() => { /* 下载失败：本轮不拦截 */ }).finally(() => {
      inflight.delete(cacheKey);
    });
    inflight.set(cacheKey, job);
  }

  const keys = await withBudget(job, budgetMs);
  if (keys && keys.length) {
    rememberKeys(keys);
    return keys;
  }
  return null;
}

function withBudget(promise, ms) {
  if (!(ms > 0)) return promise;
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, ms);
    promise.then(
      (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
      () => { if (!done) { done = true; clearTimeout(timer); resolve(null); } }
    );
  });
}

/**
 * 取图片字节。四条来源，依次尝试：
 *   ① data: URL（模型看过图后 store 里可能是这个）
 *   ② 本机 file:/// 路径（自己收藏的表情、QQ 本地缓存）
 *   ③ OneBot get_image 指到的本地文件（协议端缓存）
 *   ④ 公网直链：优先走核心 safe-fetch（SSRF 防护与全项目同源），
 *      拿不到 core 时才退回自己那一份带护栏的 fetch
 */
async function fetchImageBytes({ url = '', file = '', local = '' } = {}) {
  const dataUrl = String(url || '');
  if (/^data:image\//i.test(dataUrl)) {
    const idx = dataUrl.indexOf('base64,');
    if (idx > 0) {
      try { return Buffer.from(dataUrl.slice(idx + 7), 'base64'); } catch { return null; }
    }
    return null;
  }

  const candidates = [];
  if (local) candidates.push(local);
  if (!local && file && (/^[A-Za-z]:[\\/]/.test(file) || file.startsWith('/'))) candidates.push(file);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        const buf = fs.readFileSync(p);
        if (buf.length) return buf;
      }
    } catch { /* 试下一个来源 */ }
  }

  // 协议端缓存：get_image 能把 file 换成可读的本地路径 / 下载地址
  if (file) {
    try {
      const onebot = currentOnebot();
      if (onebot?.call) {
        const ret = await onebot.call('get_image', { file: String(file) });
        const p = ret?.file ? String(ret.file) : '';
        if (p && fs.existsSync(p)) {
          const buf = fs.readFileSync(p);
          if (buf.length) return buf;
        }
        const got = String(ret?.url || '');
        if (got && isPublicHttpUrl(got)) return await downloadPublic(got);
      }
    } catch { /* 落到直链 */ }
  }

  if (url && isPublicHttpUrl(url)) return await downloadPublic(url);
  return null;
}

async function downloadPublic(url) {
  if (typeof safeFetchBinary === 'function') {
    try {
      const { buffer } = await safeFetchBinary(String(url), MAX_BYTES);
      return buffer?.length ? buffer : null;
    } catch {
      // 走核心失败（网络/超时/被 SSRF 口径拦下）：不再自己重试一次，
      // 避免"核心说不行、插件偏要试"这种绕过安全口径的行为。
      return null;
    }
  }
  return downloadGuarded(url);
}

/**
 * 退路下载器（只有拿不到核心 safe-fetch 时才走到）：清单声明了 web_fetch 权限，
 * 所以这里才有 api.fetch。护栏照抄项目口径：只放行公网 http(s)、限 12MB、
 * 8 秒超时、只接受图片响应。
 *
 * ⚠️ 与核心 safe-fetch 的差距要说清：核心会做 DNS 全记录内网检查并固定 IP
 *    防 rebinding，这里只做主机名字面量检查。这是"核心模块缺失时仍可用"的
 *    权衡，不是替代品 —— 正常部署里永远走核心那条路。
 */
async function downloadGuarded(url) {
  if (typeof apiFetch !== 'function') return null;
  if (!isPublicHttpUrl(url)) return null;
  try {
    const resp = await apiFetch(String(url), {
      method: 'GET',
      redirect: 'follow',
      headers: { accept: 'image/*,*/*;q=0.8' },
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(8000) : undefined
    });
    if (!resp?.ok) return null;
    const type = String(resp.headers?.get?.('content-type') || '');
    if (type && !/^image\//i.test(type) && !/octet-stream/i.test(type)) return null;
    const declared = Number(resp.headers?.get?.('content-length') || 0);
    if (declared && declared > MAX_BYTES) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length || buf.length > MAX_BYTES) return null;
    return buf;
  } catch {
    return null;
  }
}

let onebotRef = null;

function currentOnebot() {
  return onebotRef;
}

// ─────────────────────────────────────────────── 有效性判定

function validForChat(entry, chatKey) {
  if (!entry) return false;
  const c = conf();
  const age = nowMs() - (entry.usedAt || entry.createdAt || 0);
  const sameChat = entry.chatKey && entry.chatKey === chatKey;
  const ttl = sameChat
    ? (c.recheckSameChatHours > 0 ? c.recheckSameChatHours * 3600 * 1000 : Infinity)
    : (c.recheckCrossChatDays > 0 ? c.recheckCrossChatDays * 86400 * 1000 : Infinity);
  if (age <= ttl) return true;
  // 过期：从索引上摘掉（条目本身留着，重新看图后再覆盖）
  unindexEntry(entry);
  store.dirty = true;
  return false;
}

function markHit(entry, chatKey) {
  entry.usedAt = nowMs();
  entry.useCount = (entry.useCount || 0) + 1;
  entry.hits = (entry.hits || 0) + 1;
  if (chatKey) entry.chatKey = entry.chatKey || clean(chatKey, 60);
  store.dirty = true;
  flushStore();
}

// ─────────────────────────────────────────────── 会话内状态（进程内、不落盘）

// sessionId -> { chatKey, resolved:Map<entryId,{keys,media}>, viewed:Map, byMid:Map,
//                saved:[], injected:bool, store:ChatStore|null, stickers:StickerManager|null }
const sessions = new Map();

function sessionState(sessionId, chatKey) {
  const id = String(sessionId || chatKey || 'unknown');
  let st = sessions.get(id);
  if (!st) {
    st = {
      chatKey: String(chatKey || ''),
      resolved: new Map(),
      viewed: new Map(),
      byMid: new Map(),
      saved: [],
      injected: false,
      store: null,
      stickers: null,
      at: nowMs()
    };
    sessions.set(id, st);
    // 保留最近 200 个会话状态，防止长跑内存增长
    if (sessions.size > 200) {
      const oldest = [...sessions.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) sessions.delete(oldest[0]);
    }
  }
  st.at = nowMs();
  if (!st.chatKey && chatKey) st.chatKey = String(chatKey);
  return st;
}

function pruneSessions() {
  const cutoff = nowMs() - 6 * 3600 * 1000;
  for (const [id, st] of sessions) {
    if (st.at < cutoff) sessions.delete(id);
  }
}

// ─────────────────────────────────────────────── 收藏表情索引（供集合表情复用）

const stickerIndex = new Map();   // key(id / resId / emojiId / qqFile) -> { id, note }
let stickerIndexAt = 0;

/**
 * 从运行期的 StickerManager 快照里建"表情身份 → 已有备注"索引。
 * 只用读，不写回：data/stickers.json 的权威持有者是 StickerManager 自己
 * （它有内存态，外部写会互相覆盖）。TTL 60 秒，避免每轮都重建。
 * 这样"机器人要看自己的收藏表情"这条链也能命中库里的 desc/localNote。
 */
function refreshStickerIndex(manager) {
  const entries = manager && Array.isArray(manager.entries) ? manager.entries : null;
  if (!entries) return false;
  const now = nowMs();
  if (now - stickerIndexAt < 60000 && stickerIndex.size) return true;
  stickerIndexAt = now;
  try {
    stickerIndex.clear();
    for (const e of entries) {
      if (!e) continue;
      const note = clean(e.localNote || e.desc);
      if (!note) continue;
      for (const k of [e.id, e.resId, e.emojiId, e.qqFile]) {
        const key = clean(k, 120);
        if (key) stickerIndex.set(key, { id: e.id, note });
      }
    }
    return true;
  } catch (error) {
    warn(`收藏表情索引刷新失败：${error?.message ?? error}`);
    return false;
  }
}

// ─────────────────────────────────────────────── hook：before-context

export const hooks = {
  /**
   * 组装提示词之前：把本轮触发消息里的图片解析成指纹（会顺手预热缓存）。
   * 这里只"预解析"，不改消息内容 —— 改文本会干扰核心的档位/关键词判定。
   * 真正给模型看的东西在 before-llm-messages 里注入。
   */
  'before-context': async ({ triggerEntries, store: chatStore, chatKey, sessionId }) => {
    try {
      const c = conf();
      if (!c.enabled) return;
      loadStore();
      flushStore();
      pruneSessions();
      const st = sessionState(sessionId, chatKey);
      if (chatStore && typeof chatStore.findByMid === 'function') st.store = chatStore;
      const budget = Math.min(c.maxDownloadMs, 4000);
      const deadline = nowMs() + Math.max(600, budget);

      for (const entry of Array.isArray(triggerEntries) ? triggerEntries : []) {
        const localId = String(entry?.id ?? '');
        const mid = String(entry?.mid ?? '');
        if (localId && mid) st.byMid.set(mid, localId);
        const media = Array.isArray(entry?.media) ? entry.media : [];
        for (const m of media) {
          if (!m || (m.kind !== 'image' && m.kind !== 'sticker')) continue;
          if (!isLikelySticker(m) && c.stickerOnly) continue;
          const left = deadline - nowMs();
          if (left < 300) return;             // 预算用完：剩下的交给下一次（后台仍在算）
          const keys = await resolveMediaKeys(m, left);
          if (keys && keys.length) st.resolved.set(localId || mid, { keys, media: m });
        }
      }
    } catch (error) {
      warn(`before-context 预解析失败（不影响对话）：${error?.message ?? error}`);
    }
  },

  /**
   * 发消息给模型之前：
   *   ① 把命中记忆库的图片含义**内联**进触发消息（模型不用调任何工具就知道了）；
   *   ② 追加一段系统说明，明确告诉它别再调看图工具。
   */
  'before-llm-messages': async ({ messages, chatKey, sessionId, triggerEntries }) => {
    try {
      const c = conf();
      if (!c.enabled) return;
      loadStore();
      const st = sessionState(sessionId, chatKey);
      if (st.injected) return;               // 每次运行只注入一次

      const known = [];
      for (const [entryId, rec] of st.resolved) {
        const entry = lookupByKeys(keysToObject(rec.keys));
        if (!entry || !validForChat(entry, chatKey)) continue;
        if (!entry.note) continue;
        known.push({ entryId, note: entry.note, keys: rec.keys, entry });
      }

      // 收藏表情那条链：触发消息里没有图，但模型接下来可能要看某个收藏表情。
      // 这里不做主动注入（那会污染上下文），交给 before-tool 拦截。

      if (!known.length) return;
      st.injected = true;
      st.saved = known.map((k) => k.entryId);

      // ① 内联进触发消息文本：把 [图片] 换成 [图片·已知表情包：含义]
      for (const k of known) {
        const target = (Array.isArray(triggerEntries) ? triggerEntries : [])
          .find((e) => String(e?.id ?? e?.mid) === String(k.entryId));
        if (!target) continue;
        const tag = `[图片·已知表情包：${safeValue(k.note)}]`;
        const text = String(target.text || '');
        target.text = text.includes('[图片]')
          ? text.replace('[图片]', tag)
          : `${text}${text ? ' ' : ''}${tag}`;
        // 让模型在用 get_message_images 前就有完整信息：把媒体标记成"已知"
        if (Array.isArray(target.media)) {
          for (const m of target.media) { if (m && (m.kind === 'image' || m.kind === 'sticker')) m.knownMeaning = k.note; }
        }
      }

      // ② 追加系统说明（只改最后一条 user 消息，不动 system 规则）
      const idx = lastUserIndex(messages);
      if (idx >= 0) {
        const lines = [
          `【表情包记忆库】本轮消息里的 ${known.length} 张图片已经在库里，含义如下（直接用，不用再看图）：`,
          ...known.slice(0, 8).map((k) => `- 消息 #${k.entryId}：${safeValue(k.note)}`)
        ];
        lines.push('这些图不要调用 get_message_images / get_sticker_image —— 系统会拦下这次调用，看图也会白花时间和 token。');
        lines.push('只有上下文里没有「已知表情包」提示的图，才是第一次见：看过之后请用 remember_image 把含义记下来，以后就不用再看了。');
        appendToMessage(messages[idx], `\n\n${lines.join('\n')}`);
      }

      for (const k of known) markHit(k.entry, chatKey);
      log(`命中记忆库 ${known.length} 张表情包，已跳过看图`);
    } catch (error) {
      warn(`before-llm-messages 注入失败（不影响对话）：${error?.message ?? error}`);
    }
  },

  /**
   * 工具执行之前：真正省 token 的地方。
   * 命中记忆库 → 拦下 get_message_images / get_sticker_image，
   * 把含义当"工具结果文本"还给模型（orchestrator 会把 reason 原样透出）。
   * 未命中 → 放行（模型照常看图），并把"刚看过哪些图"记下来，
   * 等模型看完调 remember_image 时就能对上号。
   */
  'before-tool': async ({ toolName, argsRaw, chatKey, sessionId, session }) => {
    try {
      const c = conf();
      if (!c.enabled) return;
      loadStore();
      const name = shortToolName(toolName);
      if (name !== 'get_message_images' && name !== 'get_sticker_image') return;

      const st = sessionState(sessionId, chatKey);
      const args = safeParse(argsRaw) || {};

      if (name === 'get_message_images') {
        const mid = String(args.messageId ?? args.message_id ?? '').trim();
        if (!mid) return;
        const record = findChatEntry(st, mid);
        const media = (Array.isArray(record?.media) ? record.media : [])
          .filter((m) => m && (m.kind === 'image' || m.kind === 'sticker'));

        const resolved = [];
        let known = 0;
        let unreadable = 0;
        const localId = String(record?.id ?? '');
        for (const m of media) {
          // 不是表情包（截图/照片）就不拦 —— 让模型自己看图。
          // ⚠️ 例外：如果这张图本身就命中记忆库（说明以前明确记过它），
          //    即使这次看不出来是表情包也照拦 —— 命中的含义就是它自己的含义。
          const looksSticker = isLikelySticker(m);
          if (!looksSticker && c.stickerOnly) {
            const recPeek = localId ? st.resolved.get(localId) : null;
            const earlyKeys = (recPeek && recPeek.media === m) ? recPeek.keys : null;
            if (!earlyKeys || !lookupByKeys(keysToObject(earlyKeys))) { unreadable += 1; continue; }
          }
          const rec = localId ? st.resolved.get(localId) : null;
          const keys = (rec && rec.media === m) ? rec.keys : await resolveMediaKeys(m, Math.min(c.maxDownloadMs, 2500));
          if (!keys) { unreadable += 1; continue; }
          const entry = lookupByKeys(keysToObject(keys));
          if (entry && validForChat(entry, chatKey)) {
            known += 1;
            resolved.push({ keys, entry });
          }
        }

        const usable = media.length - unreadable;
        if (known > 0 && usable > 0 && known / usable >= c.skipThreshold) {
          for (const r of resolved) markHit(r.entry, chatKey);
          // 顺手把"刚看过这张（已认识的）图"记下来，并把指纹留在会话状态里：
          // ① 模型若想用 remember_image 改写含义（群友纠正过），这次调用能对上号；
          // ② 这一轮里再有人（模型）想调 get_message_images，零成本就能再次拦下。
          const firstMedia = media.find((m) => isLikelySticker(m)) || media[0];
          if (localId && firstMedia) st.resolved.set(localId, { keys: resolved[0].keys, media: firstMedia });
          st.viewed.set(mid, { at: nowMs(), localId: localId || '', keys: resolved[0].keys });
          const list = resolved.map((r) => `「${safeValue(r.entry.note)}」`).join('、');
          const extra = resolved.length < usable ? `（另有 ${usable - resolved.length} 张本轮还没算出指纹，需要的话再看）` : '';
          return {
            block: true,
            reason: `系统：已跳过看图 —— 这些图片已经在【表情包记忆库】里，含义是 ${list}${extra}。`
              + '请直接用上面的含义理解并回应。'
              + '如果这次它们的用法明显和记的不一样，用 remember_image 传新含义覆盖它。'
          };
        }
        // 没拦下：交给 after-tool 算指纹，等模型看完图调 remember_image
        st.viewed.set(mid, { at: nowMs(), localId: localId || '' });
        return;
      }

      // get_sticker_image：自己的收藏表情。库里有备注就别花 token 再看一次图。
      const stickerRef = String(args.stickerId ?? args.sticker_id ?? args.id ?? '').trim();
      if (!stickerRef) return;
      const known = stickerNoteOf(stickerRef);
      if (known) {
        return {
          block: true,
          reason: `系统：这个收藏表情已经在你的表情库里，含义/备注是「${safeValue(known.note)}」。`
            + '不需要再看图 —— 直接用这个理解决定要不要发、发给谁。'
            + '如果这次你觉得含义记错了，用 sticker_note 更新备注，或用 remember_image 覆盖记忆库。'
        };
      }
      st.viewed.set(`sticker:${stickerRef}`, { sticker: stickerRef, at: nowMs(), chatKey: String(chatKey || '') });
    } catch (error) {
      warn(`before-tool 拦截判定失败（放行，不影响对话）：${error?.message ?? error}`);
      return;
    }
  },

  /**
   * 工具执行之后：模型刚"看过"哪张图，在这里把它的指纹算出来记下，
   * 等模型看完图调 remember_image 时就能对上号。
   * 此时图片已经发给模型了，"花多久算指纹"不再影响这一轮 —— 但仍然给预算，
   * 免得 hook 撞上 5 秒上限。
   */
  'after-tool': async ({ toolName, result, argsRaw, session, chatKey, sessionId }) => {
    try {
      const c = conf();
      if (!c.enabled) return;
      if (result?.isError) return;
      const name = shortToolName(toolName);
      if (name !== 'get_message_images' && name !== 'get_sticker_image') return;

      const st = sessionState(sessionId, chatKey);
      st.at = nowMs();
      const args = safeParse(argsRaw);

      if (name === 'get_sticker_image') {
        const ref = String(args.stickerId ?? args.sticker_id ?? args.id ?? '').trim();
        if (ref) st.viewed.set(`sticker:${ref}`, { sticker: ref, at: nowMs() });
        return;
      }

      const mid = String(args.messageId ?? args.message_id ?? '').trim();
      if (!mid) return;
      const record = findChatEntry(st, mid);
      const media = (Array.isArray(record?.media) ? record.media : [])
        .filter((m) => m && (m.kind === 'image' || m.kind === 'sticker'));
      if (!media.length) return;

      const localId = String(record?.id ?? '');
      st.viewed.set(mid, { at: nowMs(), localId });
      for (const m of media) {
        const rec = localId ? st.resolved.get(localId) : null;
        if (rec && rec.media === m) {
          rememberKeys(rec.keys);
          continue;
        }
        // 顺手把这条消息的指纹补进会话状态（下一次同图就是零成本命中）
        const keys = await resolveMediaKeys(m, Math.min(c.maxDownloadMs, 2500));
        if (keys && keys.length && localId) st.resolved.set(localId, { keys, media: m });
      }
      void session;
    } catch (error) {
      warn(`after-tool 记录指纹失败（不影响对话）：${error?.message ?? error}`);
    }
  }
};

function keysToObject(keys) {
  const out = { src: '', file: '', st: '' };
  for (const k of Array.isArray(keys) ? keys : []) {
    const s = String(k);
    if (s.startsWith('src:')) out.src = s.slice(4);
    else if (s.startsWith('file:')) out.file = s.slice(5);
    else if (s.startsWith('st:')) out.st = s.slice(3);
  }
  return out;
}

function shortToolName(toolName) {
  const s = String(toolName || '');
  const idx = s.lastIndexOf('__');
  return idx >= 0 ? s.slice(idx + 2) : s;
}

function safeParse(text) {
  try {
    const v = JSON.parse(String(text ?? '{}'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function lastUserIndex(messages) {
  if (!Array.isArray(messages)) return -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return i;
  }
  return -1;
}

/** 往一条消息追加文本（content 可能是字符串或 parts 数组，两种都要照顾）。 */
function appendToMessage(message, text) {
  if (!message) return;
  if (typeof message.content === 'string') { message.content += text; return; }
  if (Array.isArray(message.content)) {
    const last = message.content[message.content.length - 1];
    if (last && last.type === 'text') last.text = `${last.text ?? ''}${text}`;
    else message.content.push({ type: 'text', text: String(text).trim() });
  }
}

function findChatEntry(st, mid) {
  const key = String(mid ?? '').trim();
  if (!key) return null;
  const localId = st?.byMid?.get(key);
  const storeApi = st?.store;
  if (!storeApi?.findByMid) return null;
  try {
    if (localId) {
      const byLocal = storeApi.findByLocalId?.(st.chatKey, localId);
      if (byLocal) return byLocal;
    }
  } catch { /* 落到按 mid 查 */ }
  try {
    return storeApi.findByMid(st.chatKey, key) || null;
  } catch {
    return null;
  }
}

/** 该图片像不像表情包（stickerOnly 生效时用）。不确定时**倾向不缓存**。 */
function isLikelySticker(m) {
  // ① OneBot 对"QQ 表情/动图表情"常带这类 summary 标记 —— 最强信号
  if (isAnimationMarker(m?.summary)) return true;
  const url = String(m?.url || '');
  const file = String(m?.file || '');
  // ② QQ 表情图床 / 明确的表情字样
  if (/qq_expression|gxh\.vip\.qq\.com|[/_-]emoji|表情/i.test(`${url} ${file}`)) return true;
  // ③ 动图基本都是表情包
  if (/\.gif(\?|$)/i.test(`${url} ${file}`)) return true;
  // ④ 拿到了尺寸就按"表情包一般不大"判；尺寸不满足就明确不缓存
  const w = Number(m?.width || m?.w || 0);
  const h = Number(m?.height || m?.h || 0);
  if (w > 0 && h > 0) return Math.min(w, h) <= 400 && Math.max(w, h) <= 600;
  // ⑤ 啥线索都没有（老存档 media 字段不全）：不缓存，让模型自己用 remember_image
  //    决定 —— 宁可少省一点，也不要拿一张截图/照片的旧含义去糊弄群友。
  return false;
}

// ─────────────────────────────────────────────── 收藏表情备注查询

function stickerNoteOf(ref) {
  const key = String(ref || '').trim();
  if (!key) return null;
  const cached = stickerIndex.get(key) || stickerIndex.get(key.replace(/^#/, ''));
  if (cached) return cached;
  // 记忆库兜底：这个表情以前被别人发过、或者被记过含义
  const entry = lookupByKeys({ st: key, file: key });
  return entry ? { id: key, note: entry.note, from: 'memory' } : null;
}

/**
 * 把运行期才拿得到的引用记进会话状态（hook 的载荷里没有 stickers/onebot 这两个对象）：
 *   ctx.store    —— ChatStore，按消息 id 找回 media；
 *   ctx.stickers —— StickerManager，收藏表情的备注来源（顺带刷新备注索引）；
 *   ctx.onebot   —— 下载兜底（get_image 换本地文件）。
 * 全是只读引用，不改变它们的任何状态。
 */
function captureRuntimeRefs(st, ctx) {
  if (!st || !ctx) return;
  if (ctx.store && typeof ctx.store.findByMid === 'function') st.store = ctx.store;
  if (ctx.stickers && Array.isArray(ctx.stickers.entries)) {
    st.stickers = ctx.stickers;
    try { refreshStickerIndex(ctx.stickers); } catch { /* 索引失败不影响主流程 */ }
  }
  if (ctx.onebot && typeof ctx.onebot.call === 'function') onebotRef = ctx.onebot;
}

// ─────────────────────────────────────────────── 工具

function registerStickerMemoryTools(api) {
  api.registerTool({
    id: 'remember_image',
    name: '记住图片/表情包的含义',
    description:
      '把你刚看过的表情包（或图片）的含义记进【表情包记忆库】，以后同一张图再出现时系统直接用这个含义，'
      + '不用再看图（省时间、省识图 token）。'
      + '什么时候用：① 你刚用 get_message_images / get_sticker_image 看过一张**以前没见过**的表情包或梗图；'
      + '② 群友说你之前记的含义不对，要改写。'
      + '什么时候不要用：截图、照片、带文字的图、内容会变的图（再发一次可能已经不是一回事了）——这些不要记。'
      + 'note 写「画面里是什么 + 适合什么场合」，一句话，例如「举着白旗的道歉猫，服软/认错时用」。',
    category: 'sticker',
    icon: '🧠',
    parameters: {
      type: 'object',
      properties: {
        note: {
          type: 'string',
          description: '这个表情包/图片的含义与适用场合，一句话，例如「举白旗的猫，服软认错时用」。'
        },
        scope: {
          type: 'string',
          enum: ['chat', 'global'],
          description: 'chat = 只在当前会话复用（表情包在本群有特定用法时选它）；global = 所有会话通用（默认）。'
        },
        overwrite: {
          type: 'boolean',
          description: '留空或 false 时，库里已有含义就不覆盖（只记第一次的理解）；true = 用这次的覆盖旧含义（群友纠正过的情形）。'
        }
      },
      required: ['note']
    },
    async execute(ctx, args) {
      try {
        const c = conf();
        if (!c.enabled) return { content: '错误：表情包记忆库已经被关掉了，这次不记录。', isError: true };
        const note = clean(args?.note);
        if (!note || note.length < 2) {
          return { content: '错误：note 太短了。请写一句「画面里是什么 + 适合什么场合」。', isError: true };
        }

        const st = sessionState(ctx?.session?.id, ctx?.chatKey);
        captureRuntimeRefs(st, ctx);
        const keys = await collectFreshKeys(st);
        if (!keys.length) {
          return {
            content: '错误：没找到你刚看过的图片（可能这一轮你没调用看图工具，或者那张图的指纹还没算出来）。'
              + '先调用 get_message_images / get_sticker_image 看过图之后再调本工具，或者稍后再试一次。',
            isError: true
          };
        }

        const scope = String(args?.scope || 'global').toLowerCase() === 'chat' ? 'chat' : 'global';
        const overwrite = args?.overwrite === true;
        const res = putEntry({
          keys,
          note,
          chatKey: scope === 'chat' ? String(ctx?.chatKey || '') : '',
          source: 'model',
          onlyIfEmpty: !overwrite
        });
        if (!res.ok) return { content: `错误：没能记下来（${res.reason}）。`, isError: true };
        flushStore(true);
        log(`已记住一张图的含义（${res.created ? '新增' : res.updated ? '更新' : '未改动'}）：${note.slice(0, 40)}`);
        return {
          content: `已记进表情包记忆库（${res.created ? '新增' : res.updated ? '已覆盖旧含义' : '库里已有更早的含义，未改动'}）。`
            + '以后同一张图再出现，系统会直接把这条含义给你，不会再看图。'
        };
      } catch (error) {
        return { content: `记录失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'list_cached_images',
    name: '查看表情包记忆库',
    description:
      '列出【表情包记忆库】里已经记住的图片/表情包及其含义（含使用次数）。'
      + '用途：想确认"这个表情包我是不是已经记过了"、或者要挑一个贴切的表情包时翻一翻。'
      + '它是只读的，不会消耗识图 token。',
    category: 'sticker',
    icon: '📒',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '可选，按含义里的关键词过滤。' },
        limit: { type: 'integer', description: '最多返回几条，1~50，默认 20。' }
      }
    },
    async execute(_ctx, args) {
      try {
        loadStore();
        const q = clean(args?.query, 40).toLowerCase();
        const limit = clamp(Number(args?.limit), 1, 50, 20);
        const all = [...store.entries.values()]
          .filter((e) => (q ? String(e.note).toLowerCase().includes(q) : true))
          .sort((a, b) => (b.usedAt || b.createdAt) - (a.usedAt || a.createdAt));
        if (!all.length) {
          return { content: q ? `记忆库里没有含义包含「${q}」的图。` : '表情包记忆库现在是空的（还没记过任何图）。' };
        }
        const lines = [
          `表情包记忆库共 ${store.entries.size} 条，以下是最新的 ${Math.min(limit, all.length)} 条：`
        ];
        for (const e of all.slice(0, limit)) {
          const id = (e.src || e.file || e.st || '').slice(0, 10);
          lines.push(`- ${e.note}（用过 ${e.useCount || 0} 次，指纹 ${id}）`);
        }
        lines.push('要删掉某条用 forget_cached_image（传含义里的关键词即可）。');
        return { content: lines.join('\n') };
      } catch (error) {
        return { content: `读取失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'forget_cached_image',
    name: '忘掉某个图片的记忆',
    description:
      '把某张图从【表情包记忆库】里删掉，下次它再出现时会重新看图识别。'
      + '什么时候用：群友说某个表情包记的含义完全不对、或者这个表情包改用法了，而你又不想现在就写新含义时。'
      + 'query 传含义里的关键词（如「白旗」）就能定位到那条。',
    category: 'sticker',
    icon: '🗑️',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要忘掉的那条记忆的关键词（含义里出现过的词）。' }
      },
      required: ['query']
    },
    async execute(_ctx, args) {
      try {
        loadStore();
        const q = clean(args?.query, 40).toLowerCase();
        if (!q) return { content: '错误：请给一个关键词，例如「白旗」。', isError: true };
        const hits = [...store.entries.values()].filter((e) => String(e.note).toLowerCase().includes(q));
        if (!hits.length) return { content: `记忆库里没有含义包含「${q}」的图，可能已经删过了。` };
        if (hits.length > 5) {
          return {
            content: `关键词「${q}」匹配到 ${hits.length} 条，太宽了，请换个更具体的词。`
              + `\n例如：${hits.slice(0, 3).map((e) => e.note.slice(0, 20)).join(' / ')}`,
            isError: true
          };
        }
        let removed = 0;
        for (const e of hits) { if (forgetEntry(keysOf(e))) removed += 1; }
        flushStore(true);
        return { content: `已忘掉 ${removed} 条记忆：${hits.map((e) => e.note.slice(0, 20)).join(' / ')}。下次它们再出现会重新看图。` };
      } catch (error) {
        return { content: `删除失败：${error?.message ?? error}`, isError: true };
      }
    }
  });
}

/** 找出"模型刚看过、但库里还没有"的图的指纹（用于 remember_image 对上号）。 */
async function collectFreshKeys(st) {
  const out = [];
  const push = (keys) => {
    for (const k of keys) if (!out.includes(k)) out.push(k);
  };
  for (const [, rec] of st.viewed) {
    if (!rec || nowMs() - rec.at > MIN_VIEW_LINK_MS) continue;
    if (rec.sticker) { push([`st:${rec.sticker}`]); continue; }
    if (rec.localId) {
      const resolved = st.resolved.get(String(rec.localId));
      if (resolved && Array.isArray(resolved.keys)) push(resolved.keys);
    }
  }
  // 单次最多关联 24 个指纹（一次批量看图时够用，又不会把库撑爆）
  return out.slice(0, MAX_PENDING_PER_CHAT * 4);
}

// ─────────────────────────────────────────────── 生命周期

export async function setup(api) {
  cfg = typeof api?.config === 'function' ? api.config : (() => ({ ...DEFAULTS }));
  log = typeof api?.log === 'function' ? api.log : (() => {});
  warn = typeof api?.warn === 'function' ? api.warn : (() => {});
  // 清单声明了 permissions: ["web_fetch"]，这才是 loader 真的给了 fetch；
  // 没声明时拿到的是一个"调用即 reject"的占位函数，这里判掉。
  apiFetch = typeof api?.fetch === 'function' ? api.fetch : null;

  try {
    const mod = await import('../../src/safe-fetch.js');
    safeFetchBinary = typeof mod?.safeFetchBinary === 'function' ? mod.safeFetchBinary : null;
  } catch (error) {
    safeFetchBinary = null;
    warn(`拿不到核心 safe-fetch，改用自带的护栏下载器：${error?.message ?? error}`);
  }
  if (!safeFetchBinary && typeof apiFetch !== 'function') {
    warn('既没有核心 safe-fetch 也没有 web_fetch 权限：首见图将无法算指纹（其余功能不受影响）。');
  }

  registerStickerMemoryTools(api);

  // 懒加载：启动时只读一次文件，不联网、不下图
  try {
    loadStore();
  } catch (error) {
    warn(`记忆库加载失败（将当作空库）：${error?.message ?? error}`);
  }

  const c = conf();
  log(
    `表情包记忆库已加载：${store.entries.size} 条记忆；`
    + `同会话 ${c.recheckSameChatHours}h / 跨会话 ${c.recheckCrossChatDays} 天 内复用`
    + `${c.stickerOnly ? '；只记表情包' : '；全部图片都尝试记'}；缓存放在 data/${PLUGIN_ID}/`
  );
}

/** 同步自检：拿不到网络/图片字节也能工作（只是首见图算不出指纹）。 */
export function available() {
  return { ok: true };
}

export function activate() {
  loadStore();
  flushStore(true);
}

export function deactivate() {
  flushStore(true);
}

export function dispose() {
  try { flushStore(true); } catch { /* 卸载时写盘失败无所谓 */ }
  for (const job of inflight.values()) { void job; }
  inflight.clear();
  keyCache.clear();
  sessions.clear();
  stickerIndex.clear();
  store.entries.clear();
  store.byKey.clear();
  store.loadedAt = 0;
  onebotRef = null;
}

/**
 * 排障/测试用。**故意不放进 providers**：`plugin-development.md` §5 说得很清楚，
 * 自建能力名核心不认识、也没人消费 —— 声明成 capability 只会被审计报成
 * "公开能力（暂无外部消费方）"。本插件的价值全在 hooks + 工具上。
 */
export const internals = {
  get size() { return store.entries.size; },
  keysOf,
  lookupByKeys,
  putEntry,
  forgetEntry,
  flushStore,
  isLikelySticker,
  shortToolName,
  conf,
  sessionState
};
