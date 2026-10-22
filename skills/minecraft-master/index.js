// 我的世界大师 —— LLM 型技能（skills/minecraft-master/）
//
// 三块组成：
//   ① 联网工具：查 zh.minecraft.wiki（MediaWiki API）—— 先搜条目，再读正文
//   ② 联网工具：搜 B 站攻略视频 —— 候选逐个取「播放 / 投币 / 收藏」，综合只挑一条最优
//   ③ 内置速查库（kb/）：离线、秒回 —— 生存流程、资源合成、附魔酿造、红石装置、
//      生物打法、常用指令、版本平台差异、社区梗与黑话
//   ④ 触发闸门：默认「被 @ / 戳一戳 / 私聊」才启用，平时连工具都不出现在模型面前
//
// 遵循本机安装版（resources/app）的硬约束，逐条核对过源码：
//   · 工具 id 只用 [a-zA-Z0-9_-]；loader 自动加 minecraft-master__ 前缀，
//     且总长 ≤ 64（plugin-loader.js:80-84）。用 ":" 或 "." 会被严格端点 400 拒掉整个请求。
//   · 联网只走 api.fetch（清单必须声明 permissions: ["web_fetch"]），不碰 globalThis.fetch。
//   · 配置一律在执行时用 cfg() 读，不在 setup 时快照 —— 否则改了设置要重启才生效。
//   · 所有失败路径 return { content, isError: true }，绝不把异常抛给上层。
//   · ⚠️ 逻辑全部写在**入口文件**里是有意的：热重载只给入口 index.js 加防缓存参数
//     （plugin-loader.js:305），子模块会被 Node 的 ESM 缓存住 —— 拆到 lib/ 的文件
//     改完必须重启 QQ Agent 才生效。kb/ 是纯数据、用 fs 读盘，所以放外面没问题。
//
// 闸门依据的本机事实（orchestrator.js / store.js）：
//   · before-context 载荷 = skillContext + { triggerEntries, store, memory }；skillContext 含 chatKey / kind / sessionId
//   · 触发批条目字段：atMe(boolean|null) / isPoke / text / atNames / reply
//   · 工具可用性判定在钩子之后、且用同一个 skillContext，所以同一轮 sessionId 一定对得上

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const KB_DIR = path.join(SKILL_DIR, 'kb');

// ── 外部接口 ────────────────────────────────────────────────────────────────
const WIKI_HOST = 'https://zh.minecraft.wiki';
const WIKI_API = `${WIKI_HOST}/api.php`;
const BILI_SEARCH_API = 'https://api.bilibili.com/x/web-interface/search/type';
const BILI_DETAIL_API = 'https://api.bilibili.com/x/web-interface/view';

// MediaWiki 对 UA 有要求（不带 UA 会被拒绝/限流），这里明确自报家门。
const WIKI_HEADERS = {
  accept: 'application/json',
  'user-agent': 'QQAgentSkill/1.0 (minecraft-master; +https://zh.minecraft.wiki)'
};

const BILI_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  referer: 'https://www.bilibili.com/',
  accept: 'application/json, text/plain, */*'
};

const WIKI_TIMEOUT_MS = 15000;
const BILI_TIMEOUT_MS = 12000;
const MAX_RESPONSE_CHARS = 400000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 40;

const WIKI_ORDER_HINT = '（表格类内容 —— 合成配方表、掉落表、数据值表 —— TextExtracts 抽不出来，需要时让群友点来源链接看原页面。）';

// 运行期注入
let cfg = () => ({});
let log = () => {};
let net = null; // api.fetch（清单声明 web_fetch 权限后才有真身）

const wikiCache = new Map(); // url -> { at, data }

// ── 小工具 ─────────────────────────────────────────────────────────────────

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 去掉 HTML 标签与实体（搜索摘要里带 <span class="searchmatch">）。 */
function stripHtml(input) {
  return String(input ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 数字转「1.8万 / 3.2亿」这种中文习惯写法。 */
function formatCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)}亿`;
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return String(Math.round(n));
}

function formatDurationSec(sec) {
  const n = Math.max(0, Math.round(Number(sec) || 0));
  if (!n) return '';
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/** 限并发执行（B 站详情一次全并发容易触发风控）。 */
async function mapLimit(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  const out = new Array(list.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, async () => {
    while (cursor < list.length) {
      const i = cursor;
      cursor += 1;
      try {
        out[i] = await fn(list[i], i);
      } catch {
        out[i] = null;
      }
    }
  });
  await Promise.all(workers);
  return out;
}

/** 联网可用性（同步判断，决定是走网络还是只答本地库）。 */
function networkState() {
  const c = cfg() || {};
  if (c.allowNetwork === false) {
    return { ok: false, reason: '设置里关掉了「允许联网查 MC Wiki / B 站」' };
  }
  if (typeof net !== 'function') {
    return { ok: false, reason: '本技能没拿到联网权限（清单缺少 permissions: ["web_fetch"]）' };
  }
  return { ok: true, reason: '' };
}

const NO_NET_HINT = '（现在只能用内置速查库回答，并说明「内置库可能不是最新版本」。）';

// ── ① MC Wiki（MediaWiki）────────────────────────────────────────────────────

/** 页面链接（给模型/群友点开用）。 */
function wikiPageUrl(title) {
  const t = String(title ?? '').trim().replace(/\s+/g, '_');
  return `${WIKI_HOST}/w/${encodeURIComponent(t)}`;
}

function cacheGet(url) {
  const hit = wikiCache.get(url);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    wikiCache.delete(url);
    return null;
  }
  return hit.data;
}

function cachePut(url, data) {
  if (wikiCache.size >= CACHE_MAX) {
    const oldest = wikiCache.keys().next().value;
    if (oldest !== undefined) wikiCache.delete(oldest);
  }
  wikiCache.set(url, { at: Date.now(), data });
}

/** 发一个 MediaWiki API 请求。带超时、长度保护与短时缓存。 */
async function wikiApiGet(params, { timeoutMs = WIKI_TIMEOUT_MS } = {}) {
  if (typeof net !== 'function') throw new Error('没有可用的联网通道');
  const qs = new URLSearchParams({ format: 'json', formatversion: '2', ...params });
  const url = `${WIKI_API}?${qs.toString()}`;

  const cached = cacheGet(url);
  if (cached) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await net(url, { method: 'GET', headers: WIKI_HEADERS, signal: controller.signal });
    if (!res || typeof res.text !== 'function') throw new Error('联网通道返回了异常对象');
    if (!res.ok) throw new Error(`zh.minecraft.wiki 返回 HTTP ${res.status}`);
    let text = await res.text();
    if (text.length > MAX_RESPONSE_CHARS) text = text.slice(0, MAX_RESPONSE_CHARS);
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('zh.minecraft.wiki 返回的不是合法 JSON');
    }
    if (data?.error) throw new Error(`zh.minecraft.wiki 报错：${data.error.info || data.error.code || '未知错误'}`);
    cachePut(url, data);
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('请求 zh.minecraft.wiki 超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 关键词检索条目：返回 [{ title, snippet }]。
 *
 * 为什么同时用**标题前缀检索 + 全文检索**（实测 2026-10 对比）：
 *   搜「下界合金」 → 全文检索给「群骑纷争」（一条更新公告，正文反复出现这个词）；
 *   搜「刷铁机」   → 全文检索给「生产」「Java版1.8」，完全跑偏；
 *   两者用 prefixsearch 都能直接命中同名条目。
 * 中文全文检索的分词很差，而群友问的几乎总是"那个条目"。所以：
 *   标题命中优先，全文只作补充（自然语言长句、正文关键词这类前缀检索查不到的情况）。
 */
async function wikiSearch(query, limit = 5) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('检索关键词为空');
  const size = clampInt(limit, 1, 10, 5);

  const [preRes, fullRes] = await Promise.allSettled([
    wikiPrefixSearch(q, size),
    wikiFullTextSearch(q, size)
  ]);
  if (preRes.status === 'rejected' && fullRes.status === 'rejected') throw preRes.reason;

  const pre = preRes.status === 'fulfilled' ? preRes.value : [];
  const full = fullRes.status === 'fulfilled' ? fullRes.value : [];

  const seen = new Set();
  const merged = [];
  for (const h of [...pre, ...full]) {
    const key = h.title.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(h);
  }
  return rankWikiHits(merged, q).slice(0, size);
}

/** 标题前缀检索（对中文条目名最准）。不返回摘要，只有标题。 */
async function wikiPrefixSearch(query, limit) {
  const data = await wikiApiGet({
    action: 'query',
    list: 'prefixsearch',
    pssearch: query,
    pslimit: String(clampInt(limit, 1, 10, 5))
  });
  const hits = Array.isArray(data?.query?.prefixsearch) ? data.query.prefixsearch : [];
  return hits
    .map((h) => ({ title: String(h?.title ?? '').trim(), snippet: '' }))
    .filter((h) => h.title);
}

/** 全文检索（带摘要），用于前缀检索没命中、或关键词出现在正文里的情况。 */
async function wikiFullTextSearch(query, limit) {
  const data = await wikiApiGet({
    action: 'query',
    list: 'search',
    srsearch: query,
    srlimit: String(clampInt(limit, 1, 10, 5)),
    srprop: 'snippet'
  });
  const hits = Array.isArray(data?.query?.search) ? data.query.search : [];
  return hits
    .map((h) => ({ title: String(h?.title ?? '').trim(), snippet: stripHtml(h?.snippet ?? '').slice(0, 220) }))
    .filter((h) => h.title);
}

/**
 * 把「标题和关键词对得上」的条目排到前面。
 *
 * 为什么需要：MediaWiki 的默认排序看正文命中次数 —— 搜「下界合金」时，
 * 一条更新公告因为正文反复出现这个词就排到了《下界合金》条目本身前面。
 * 群友问的几乎总是那个条目，所以标题精确 / 包含命中的必须优先。
 */
/** 标题里是否含有 query 的任意两字片段（用来判断"这次检索到底对上了没有"）。 */
function sharesTitleTerm(title, query) {
  const t = String(title ?? '');
  const q = String(query ?? '').trim();
  if (!q) return false;
  if (q.length <= 2) return t.includes(q);
  for (let i = 0; i + 2 <= q.length; i++) {
    if (t.includes(q.slice(i, i + 2))) return true;
  }
  return false;
}

function rankWikiHits(hits, query) {
  const q = String(query ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (!q) return hits;
  const scoreOf = (title) => {
    const t = String(title ?? '').toLowerCase().replace(/\s+/g, '');
    if (!t) return 0;
    if (t === q) return 100;          // 完全同名
    if (t.startsWith(q)) return 80;   // 「附魔台」→「附魔台」类前缀命中
    if (t.includes(q)) return 60;     // 标题里有关键词
    if (q.includes(t) && t.length >= 2) return 40; // 关键词比标题更长，但包含了标题
    return 0;
  };
  return hits
    .map((h, i) => ({ h, i, s: scoreOf(h.title) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.h);
}

/**
 * 取第一个页面对象。
 * formatversion=2 时 pages 是数组；万一拿到旧格式（对象，键为 pageid）也兜住，
 * 否则会静默解析出 undefined。
 */
function firstPage(data) {
  const pages = data?.query?.pages;
  if (Array.isArray(pages)) return pages[0] ?? null;
  if (pages && typeof pages === 'object') return Object.values(pages)[0] ?? null;
  return null;
}

/** 读页面正文纯文本（TextExtracts）。 */
async function wikiPageExtract(title, maxChars = 3000) {
  const t = String(title ?? '').trim();
  if (!t) throw new Error('页面标题为空');
  const cap = clampInt(maxChars, 500, 12000, 3000);
  const data = await wikiApiGet({
    action: 'query',
    prop: 'extracts',
    explaintext: '1',
    redirects: '1',
    titles: t
  });
  const page = firstPage(data);
  if (!page || page.missing) return { missing: true };
  const text = String(page.extract ?? '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) return { empty: true, title: String(page.title ?? t) };
  const truncated = text.length > cap;
  return {
    title: String(page.title ?? t),
    text: truncated ? text.slice(0, cap) : text,
    truncated,
    total: text.length
  };
}

// ── ② B 站（搜索 + 详情 + 综合评分）─────────────────────────────────────────

const BILI_ORDER_MAP = {
  综合: 'totalrank',
  最多播放: 'click',
  最新: 'pubdate',
  弹幕最多: 'dm',
  收藏最多: 'stow'
};
const BILI_ORDER_CHOICES = Object.keys(BILI_ORDER_MAP);

function biliSearchUrl(keyword) {
  return `https://search.bilibili.com/all?keyword=${encodeURIComponent(String(keyword ?? ''))}`;
}

async function biliGetJson(url, { timeoutMs = BILI_TIMEOUT_MS, headers = BILI_HEADERS } = {}) {
  if (typeof net !== 'function') throw new Error('没有可用的联网通道');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await net(url, { method: 'GET', headers, signal: controller.signal });
    if (!res || typeof res.text !== 'function') throw new Error('联网通道返回了异常对象');
    if (!res.ok) throw new Error(`B 站接口返回 HTTP ${res.status}`);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('B 站接口返回的不是合法 JSON');
    }
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('请求 B 站超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 搜索视频（拿候选）。
 * ⚠️ 用老的 /x/web-interface/search/type：实测新版 wbi 签名接口对匿名请求会返回
 * data.v_voucher（人机验证挑战）。这里同时准备「直接请求」和「带 buvid3 cookie」两次尝试。
 */
async function biliSearch(keyword, { limit = 8, order = '综合' } = {}) {
  const kw = String(keyword ?? '').trim();
  if (!kw) throw new Error('搜索关键词为空');
  const size = clampInt(limit, 1, 10, 8);
  const ord = BILI_ORDER_MAP[String(order ?? '').trim()] || BILI_ORDER_MAP['综合'];
  const params = new URLSearchParams({
    search_type: 'video',
    keyword: kw,
    page: '1',
    page_size: String(size),
    order: ord
  });
  const url = `${BILI_SEARCH_API}?${params.toString()}`;

  let lastError = '';
  // 两次尝试的头只差一个 buvid3 cookie：B 站对匿名请求偶尔会挑一次，带上它常常就能过。
  const attempts = [
    BILI_HEADERS,
    { ...BILI_HEADERS, cookie: `buvid3=${Math.random().toString(36).slice(2, 12).toUpperCase()}-infoc` }
  ];

  for (const headers of attempts) {
    try {
      const data = await biliGetJson(url, { headers });
      const code = Number(data?.code);
      const list = Array.isArray(data?.data?.result) ? data.data.result : [];
      if (code === 0 && list.length) {
        return {
          keyword: kw,
          order: order,
          fallbackUrl: biliSearchUrl(kw),
          items: list.map((v) => {
            const bvid = stripHtml(v?.bvid);
            return {
              title: stripHtml(v?.title),
              author: stripHtml(v?.author),
              play: formatCount(v?.play),
              playRaw: Number(v?.play) || 0,
              danmaku: formatCount(v?.video_review),
              duration: String(v?.duration ?? '').replace(/[^\d:]/g, ''),
              date: (() => {
                const ts = Number(v?.pubdate);
                if (!Number.isFinite(ts) || ts <= 0) return '';
                const d = new Date(ts * 1000);
                return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
              })(),
              bvid,
              url: bvid ? `https://www.bilibili.com/video/${bvid}` : stripHtml(v?.arcurl)
            };
          })
        };
      }
      lastError = code === 0
        ? 'B 站返回了 0 条结果'
        : `B 站接口 code=${code}${data?.message ? `（${data.message}）` : ''}${data?.data?.v_voucher ? '，触发了人机验证' : ''}`;
    } catch (error) {
      lastError = error?.message ?? String(error);
    }
  }

  return { keyword: kw, order, fallbackUrl: biliSearchUrl(kw), items: [], note: lastError || '没有拿到结果' };
}

/**
 * 综合评分：播放 + 投币 + 收藏，全部取 log10 加权。
 * 为什么取对数：播放量级（百万）会把投币（万级）完全压死，直接相加等于只按播放排序。
 * 权重：投币最"贵"（一个用户一天只能投几个币）给 2.0；收藏是"有用"的最强信号给 1.5；播放 1.0。
 */
function scoreVideo({ view = 0, coin = 0, favorite = 0 } = {}) {
  const l = (n) => Math.log10(Math.max(0, Number(n) || 0) + 1);
  return 1.0 * l(view) + 2.0 * l(coin) + 1.5 * l(favorite);
}

/** 取单个视频详情（播放/投币/收藏/点赞）。失败返回 null，由调用方降级。 */
async function biliVideoDetail(bvid, { timeoutMs = 10000 } = {}) {
  const id = String(bvid ?? '').trim();
  if (!id) return null;
  try {
    const data = await biliGetJson(`${BILI_DETAIL_API}?bvid=${encodeURIComponent(id)}`, { timeoutMs });
    if (Number(data?.code) !== 0 || !data?.data) return null;
    const stat = data.data.stat || {};
    return {
      bvid: id,
      title: stripHtml(data.data.title),
      author: stripHtml(data.data.owner?.name),
      view: Number(stat.view) || 0,
      coin: Number(stat.coin) || 0,
      like: Number(stat.like) || 0,
      favorite: Number(stat.favorite) || 0,
      danmaku: Number(stat.danmaku) || 0,
      durationSec: Number(data.data.duration) || 0
    };
  } catch {
    return null;
  }
}

/**
 * 搜一条最值得发的视频（只返回 1 条）。
 * 流程：搜索拿候选 → 限并发取详情（失败降级为只用播放量）→ 综合分排序 → 取第一。
 */
async function biliSearchBest(keyword, { candidates = 8, order = '综合' } = {}) {
  const pool = clampInt(candidates, 1, 10, 8);
  const search = await biliSearch(keyword, { limit: pool, order });
  if (!search.items.length) return { ...search, best: null, candidates: [] };

  // 详情限并发 4：一次开 8 条连接更容易被 B 站风控。
  const withDetail = await mapLimit(search.items, 4, async (item) => {
    const d = await biliVideoDetail(item.bvid);
    if (!d) {
      // 详情拿不到（抖动/风控）→ 退化成只用搜索给的播放量排序，并在结果里标注
      return { ...item, view: item.playRaw, coin: null, favorite: null, degraded: true };
    }
    return {
      bvid: d.bvid,
      title: d.title || item.title,
      author: d.author || item.author,
      url: `https://www.bilibili.com/video/${d.bvid}`,
      view: d.view,
      coin: d.coin,
      favorite: d.favorite,
      like: d.like,
      danmaku: d.danmaku,
      duration: formatDurationSec(d.durationSec) || item.duration,
      date: item.date,
      play: formatCount(d.view)
    };
  });

  const ranked = withDetail
    .filter(Boolean)
    .map((v) => ({ ...v, score: scoreVideo({ view: v.view, coin: v.coin ?? 0, favorite: v.favorite ?? 0 }) }))
    .sort((a, b) => b.score - a.score);

  return {
    keyword: search.keyword,
    order: search.order,
    fallbackUrl: search.fallbackUrl,
    best: ranked[0] || null,
    candidates: ranked,
    note: ranked.length && ranked.every((v) => v.degraded)
      ? '没能取到投币/收藏数，这次只按播放量排序'
      : search.note
  };
}

// ── ③ 内置速查库（kb/*.md，离线）────────────────────────────────────────────

let kbCache = null;

function readKbDocs() {
  if (kbCache) return kbCache;
  const docs = [];
  try {
    for (const name of fs.readdirSync(KB_DIR)) {
      if (!name.toLowerCase().endsWith('.md')) continue;
      let text = '';
      try {
        text = fs.readFileSync(path.join(KB_DIR, name), 'utf8');
      } catch {
        continue;
      }
      if (!text.trim()) continue;
      const title = (text.match(/^#\s+(.+)$/m) || [])[1]?.trim() || name.replace(/\.md$/i, '');
      const source = (text.match(/^>\s*来源：(\S+)/m) || [])[1] || wikiPageUrl(title);
      // 检索片段里不要再重复这两行元数据：标题由【资料 N】给出，来源单独展示。
      // 不剥掉的话，每次检索都会白送模型一行「# 标题」和一行「> 来源：…」。
      const body = text
        .replace(/^\uFEFF?#[^\n]*\n+/, '')
        .replace(/^>\s*来源：[^\n]*\n?/m, '')
        .trim() || text.trim();
      docs.push({ file: name, title, source, text: body, lower: body.toLowerCase() });
    }
  } catch {
    // 没有 kb 目录：技能仍可完全靠联网工作
  }
  docs.sort((a, b) => a.title.localeCompare(b.title, 'zh'));
  kbCache = docs;
  return docs;
}

function kbCatalog() {
  return readKbDocs().map((d) => d.title);
}

function countOccurrences(haystack, needle, cap = 60) {
  if (!needle) return { count: 0, first: -1 };
  let count = 0;
  let first = -1;
  let from = 0;
  while (count < cap) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    if (first < 0) first = at;
    count += 1;
    from = at + needle.length;
  }
  return { count, first };
}

/**
 * 梗类资料（标题含"梗/黑话/彩蛋/标语"）是否走「行级检索」。
 *
 * 为什么必须区别对待：梗库是**一行一条**的清单，条目之间没有连贯上下文。
 * 若沿用"从首个命中处截 900 字符"，一次只能看到命中点附近的几条，
 * 库越大越捡不到想要的条目（实测：60 条时命中窗口只覆盖 20%）。
 * 梗类改成"抽出所有命中行 + 它们所属的小标题"，让每条都能独立被看到。
 */
const MEME_DOC_RE = /梗|黑话|彩蛋|标语/;

/** 抽出命中的行，并带上所属小标题，便于模型知道这条属于哪一类。 */
function pickMatchedLines(doc, terms, budget = 1600) {
  const lines = doc.text.split('\n');
  const out = [];
  const seenHead = new Set();
  const seenText = new Set();
  const HEAD_RE = /^#{2,3}\s/;
  const push = (s) => {
    const t = s.trim();
    if (!t || seenText.has(t)) return;
    seenText.add(t);
    out.push(t);
  };
  const size = () => out.reduce((n, s) => n + s.length + 1, 0);

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (!terms.some((t) => raw.toLowerCase().includes(t))) continue;
    const isHead = HEAD_RE.test(raw);
    const line = raw.trim();
    if (!line) continue;

    if (isHead) {
      // 命中的是小标题（如查「彩蛋」命中"## 一、命名触发的彩蛋"）：
      // 只给标题对模型没用，顺手带上这一节的前几条内容。
      if (seenHead.has(line)) continue;
      seenHead.add(line);
      push(line);
      let added = 0;
      for (let j = i + 1; j < lines.length && added < 4; j += 1) {
        if (HEAD_RE.test(lines[j])) break;
        const c = lines[j].trim();
        if (!c) continue;
        push(c);
        added += 1;
      }
    } else {
      // 普通行：往上找最近的 ##/### 小标题，作为这条的归类
      let head = '';
      for (let j = i - 1; j >= 0 && j > i - 30; j -= 1) {
        if (HEAD_RE.test(lines[j])) { head = lines[j].trim(); break; }
      }
      if (head && !seenHead.has(head)) {
        seenHead.add(head);
        push(head);
      }
      push(line);
    }
    if (size() >= budget) break;
  }
  return out.join('\n');
}

/** 中文常见虚词：拆二元组时含这些字的组合要丢掉，否则"在哪""什么"会到处命中。 */
const STOP_CHARS = new Set('的了是在吗呢吧啊和与或么什怎哪多少几个这那你我他她要能会可很就都也还要想把被给对从到'.split(''));

/**
 * 整句中文查询的兜底拆分。
 *
 * 起因：工具描述里举例「钻石在哪挖」，但库文件里写的是「钻石」。
 * 剪贴板式整句在库里必然一次也命中不了（实测：返回"没有直接相关内容"）。
 * 这里把长中文词切成二元组，丢掉含虚词的组合，让「钻石在哪挖」能落回「钻石」。
 */
function expandChineseBigrams(terms) {
  const out = new Set(terms);
  for (const term of terms) {
    const chars = [...term];
    if (chars.length < 4) continue;
    for (let i = 0; i + 1 < chars.length; i += 1) {
      const a = chars[i];
      const b = chars[i + 1];
      if (!/[\u4e00-\u9fa5]/.test(a) || !/[\u4e00-\u9fa5]/.test(b)) continue;
      if (STOP_CHARS.has(a) || STOP_CHARS.has(b)) continue;
      out.add(a + b);
    }
  }
  return [...out].slice(0, 14);
}

/** 对一批词给所有文档打分。 */
function scoreDocs(docs, terms, { downweightMeme = false } = {}) {
  const scored = [];
  for (const doc of docs) {
    let score = 0;
    let first = -1;
    for (const term of terms) {
      const { count, first: at } = countOccurrences(doc.lower, term);
      if (!count) continue;
      score += count * (term.length >= 2 ? 2 : 1);
      if (doc.title.toLowerCase().includes(term)) score += 8;
      if (at >= 0 && (first < 0 || at < first)) first = at;
    }
    // 不是冲着梗来的技术提问（如「附魔台怎么摆」里也有"附魔"），梗库不让它抢头名
    if (score > 0 && downweightMeme && MEME_DOC_RE.test(doc.title)) score *= 0.6;
    if (score > 0) scored.push({ doc, score, first });
  }
  scored.sort((a, b) => b.score - a.score || a.doc.title.localeCompare(b.doc.title, 'zh'));
  return scored;
}

/** 查询本身是否在问梗/黑话/出处（决定要不要给梗库降权）。 */
const MEME_INTENT_RE = /梗|黑话|彩蛋|外号|出处|啥意思|什么意思|抽象|名场面|接龙|口头禅/;

/**
 * 查询是不是「技术型问句」（怎么摆 / 为什么炸 / 在哪挖）。
 *
 * 只有这种问句才给梗库降权：像「附魔台怎么摆」里也有"附魔"，梗库不该抢头名；
 * 但「挖三填一」「creeper」「村民提款机」本身就是梗词，降权会让答案跑偏到别的文档。
 */
const ASK_RE = /怎么|怎样|如何|为什么|为啥|在哪|哪里|是什么|哪个|多少|能不能|有没有/;

/** 资料库检索：按词频打分，返回最相关文档的原文片段（梗类返回命中行）。 */
function searchKb(query, limit = 3, snippetChars = 900) {
  const docs = readKbDocs();
  const catalog = docs.map((d) => d.title);
  const raw = String(query ?? '')
    .split(/[\s,，、;；/|]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 6);
  if (!docs.length || !raw.length) return { hits: [], catalog, total: docs.length };

  let terms = raw;
  const q = String(query ?? '');
  const downweightMeme = !MEME_INTENT_RE.test(q) && ASK_RE.test(q);
  let scored = scoreDocs(docs, terms, { downweightMeme });
  if (!scored.length) {
    // 整句在库里一次都没命中 → 用二元组再试一轮
    const expanded = expandChineseBigrams(raw);
    if (expanded.length > terms.length) {
      terms = expanded;
      scored = scoreDocs(docs, terms, { downweightMeme });
    }
  }

  const hits = scored.slice(0, Math.max(1, Math.min(6, limit))).map(({ doc, score, first }) => {
    if (MEME_DOC_RE.test(doc.title)) {
      const lines = pickMatchedLines(doc, terms);
      if (lines) return { title: doc.title, source: doc.source, score, snippet: lines, byLines: true };
    }
    const start = Math.max(0, (first < 0 ? 0 : first) - Math.floor(snippetChars / 4));
    const snippet = doc.text.slice(start, start + snippetChars).replace(/\n{3,}/g, '\n\n').trim();
    return { title: doc.title, source: doc.source, score, snippet };
  });
  return { hits, catalog, total: docs.length };
}

// ── ④ 触发闸门 ──────────────────────────────────────────────────────────────
//
// 两道确定性闸门（都由核心代码执行，模型绕不过去）：
//   ① providers['tool.guard']：本轮没被叫到时否决本技能的工具 → 模型连工具定义都看不到
//   ② promptSections(ctx)：本轮没被叫到时干脆不注入大师提示词 → 顺便省 token
// 二者都靠 before-context 钩子在本轮开始时记下的「本轮是什么性质」来判定。

const FLAG_TTL_MS = 10 * 60 * 1000;
const MAX_FLAGS = 300;

const flags = new Map(); // sessionId -> { addressed, topic, at }
const lastAddressedAt = new Map(); // chatKey -> ts（宽限窗口用）
const self = { id: '', nickname: '', botName: '' };

const TRIGGER_MODES = ['被@或戳一戳时', '聊到我的世界时', '总是'];
const DEFAULT_TRIGGER_MODE = TRIGGER_MODES[0];

/** MC 话题词（用于「聊到我的世界时」模式）。只收歧义小的词。 */
const TOPIC_WORDS = [
  '我的世界', 'Minecraft', '麦块', 'creeper', 'aww man', 'herobrine', 'steve',
  '苦力怕', '爬行者', '僵尸', '骷髅', '末影',
  '下界', '地狱门', '末地', '末影龙', '凋灵', '红石', '附魔', '经验修补',
  '钻石', '下界合金', '黑曜石', '基岩版', 'Java版', '创造模式', '生存模式',
  '刷怪塔', '村民', '铁傀儡', '工作台', '熔炉', '方块', '整合包', '材质包',
  '起床战争', '空岛战争', 'Hypixel', 'bedwars', 'skyblock', '网易版', '国际版', '挖三填一',
  'technoblade', '2b2t', 'minecraft movie', '苦力怕娘',
  '服务器', 'mod', '光影', '启动器', '种子'
];

function normalizeMode(value) {
  const v = String(value ?? '').trim();
  if (!v) return DEFAULT_TRIGGER_MODE;
  if (TRIGGER_MODES.includes(v)) return v;
  if (/总是|全部|always|any/i.test(v)) return TRIGGER_MODES[2];
  if (/聊到|话题|topic|关键词/i.test(v)) return TRIGGER_MODES[1];
  return DEFAULT_TRIGGER_MODE;
}

/** 顺手记下机器人自己的身份（只用于 atMe === null 的旧记录兜底）。 */
function learnSelf(ctx) {
  try {
    if (ctx?.selfId) self.id = String(ctx.selfId);
    if (ctx?.selfNickname) self.nickname = String(ctx.selfNickname);
    if (ctx?.botName) self.botName = String(ctx.botName);
  } catch { /* 记不到就算了 */ }
}

/** 这条消息是不是在叫机器人（atMe 有值以标记为准，null 才回落文本匹配）。 */
function entryAddressesBot(entry) {
  if (!entry || typeof entry !== 'object') return false;

  if (entry.atMe === true) return true;
  if (entry.atMe !== false) {
    const text = String(entry.text ?? '');
    if (self.id && text.includes(`[CQ:at,qq=${self.id}]`)) return true;
    for (const name of [self.nickname, self.botName]) {
      const n = String(name ?? '').trim();
      if (n && text.includes(`@${n}`)) return true;
    }
  }
  // 拍一拍 = 轻量召唤
  if (entry.isPoke && /拍了拍\s*我/.test(String(entry.text ?? ''))) return true;
  // 引用回复机器人自己的消息也算
  const reply = entry.reply;
  if (reply && typeof reply === 'object') {
    if (reply.self === true) return true;
    const rid = String(reply.senderId ?? '');
    if (rid === 'self' || (self.id && rid === String(self.id))) return true;
  }
  return false;
}

/** 文本里有没有 MC 话题。 */
function textHasMinecraftTopic(text) {
  const t = String(text ?? '');
  if (!t) return false;
  const lower = t.toLowerCase();
  for (const w of TOPIC_WORDS) {
    const word = String(w);
    if (/^[a-z0-9 ]+$/i.test(word)) {
      if (lower.includes(word.toLowerCase())) return true;
    } else if (t.includes(word)) {
      return true;
    }
  }
  // 单独的 "mc"：要求词边界，避免命中 "mcbbs" 以外的杂词（mcbbs 归话题，也符合预期）
  if (/(^|[^a-z0-9])mc([^a-z0-9]|$)/i.test(t)) return true;
  return false;
}

function rememberTurn(ctx, info = {}) {
  const sid = String(ctx?.sessionId ?? '').trim();
  const now = Date.now();
  if (sid) {
    flags.set(sid, { addressed: Boolean(info.addressed), topic: Boolean(info.topic), at: now });
    if (flags.size > MAX_FLAGS) {
      for (const [key, value] of flags) {
        if (now - value.at > FLAG_TTL_MS) flags.delete(key);
      }
      while (flags.size > MAX_FLAGS) {
        const oldest = flags.keys().next().value;
        if (oldest === undefined) break;
        flags.delete(oldest);
      }
    }
  }
  if (info.addressed) {
    const ck = String(ctx?.chatKey ?? '').trim();
    if (ck) lastAddressedAt.set(ck, now);
  }
}

function flagOf(ctx) {
  const sid = String(ctx?.sessionId ?? '').trim();
  if (!sid) return null;
  const hit = flags.get(sid);
  if (!hit) return null;
  if (Date.now() - hit.at > FLAG_TTL_MS) {
    flags.delete(sid);
    return null;
  }
  return hit;
}

/** 本轮允不允许启用（工具与提示词共用这一个判断，口径一致）。 */
function decide(ctx, { mode, graceMinutes } = {}) {
  const m = normalizeMode(mode);
  const kind = String(ctx?.kind ?? '');
  const chatKey = String(ctx?.chatKey ?? '');

  if (m === TRIGGER_MODES[2]) return { allow: true, why: '设置为总是启用' };
  // 私聊是 1v1：消息本来就是对着机器人说的
  if (kind === 'private') return { allow: true, why: '私聊直接对话' };

  const graceRaw = Number(graceMinutes);
  const graceMs = (Number.isFinite(graceRaw) ? Math.max(0, graceRaw) : 3) * 60000;
  const lastAt = chatKey ? (lastAddressedAt.get(chatKey) || 0) : 0;
  const inGrace = graceMs > 0 && lastAt > 0 && Date.now() - lastAt < graceMs;

  const flag = flagOf(ctx);
  if (flag) {
    if (flag.addressed) return { allow: true, why: '本轮被叫到' };
    if (m === TRIGGER_MODES[1] && flag.topic) return { allow: true, why: '本轮聊到我的世界' };
    if (inGrace) return { allow: true, why: `上次被叫到后 ${Math.round((Date.now() - lastAt) / 1000)} 秒内` };
    return {
      allow: false,
      why: m === TRIGGER_MODES[1]
        ? '本轮既没被叫到、也没聊到我的世界'
        : '本轮没有被 @ 或戳一戳（可在设置里改成"聊到我的世界时"或"总是"）'
    };
  }

  // 拿不到本轮信息（控制台预览、工具页列举等）→ 放行，
  // 否则界面会显示成"工具不可用"，看起来像技能坏了。
  if (inGrace) return { allow: true, why: '上次被叫到后不久', unknown: true };
  return { allow: true, why: '没有本轮触发信息（放行）', unknown: true };
}

// ── ⑤ 提示词正文（只在闸门放行时注入）───────────────────────────────────────

function buildGuideText() {
  const c = cfg() || {};
  const lines = [
    '本轮群友是在跟你说话（@ 你、戳你、私聊你，或刚才叫过你），聊到《我的世界》时按老玩家水准作答：',
    '1) 事实优先：MC 版本更新频繁，配方、数值、机制、生物行为很容易记错。问具体条目（方块/物品/生物/附魔/结构/命令）先查证 —— 先用 kb_search 查内置速查库（离线、快），没有再 wiki_search 找条目、wiki_page 读正文。绝不凭印象编数值、配方或版本号；查不到就直说查不到，并说明资料可能没跟上最新版本。',
    '2) 分清平台与版本：Java 版 / 基岩版 / 网易中国版在红石机制、刷怪条件、村民交易、附魔上都可能有差异；群友没说清就顺口问一句「你是 Java 还是基岩」。版本号（如 1.21.x）别猜。',
    '3) 像老玩家说话：先给结论再给理由，1~4 句说完；萌新问"怎么开始"就给最小可执行步骤（砍树→工作台→木镐→石头→石镐→床），老玩家问数据就说关键数字。不要长篇大论、不要堆 Markdown 表格，也不必每次念资料出处。',
    '4) 群友想找视频（实况/教程/红石/建筑/模组/PVP/版本解读/搞笑）时用 bilibili_search：它只会给你一条（按播放+投币+收藏综合挑的最优），把那一条链接发出去就行，不要自己再挑几条、也不要主动刷视频。'
  ];
  if (c.memeEnabled !== false) {
    lines.push(
      '5) 可以接梗，但要接得自然：一次最多一句，锦上添花、别硬塞，更不要抢了正事。'
      + '特别注意「接龙梗」：群友只甩一个词、又没在问具体问题时，那是在点梗等你接下半句 —— 直接接上，别解释、别反问「这是什么」、也别扯回刚才的话题。'
      + '例：「Creeper?」接「aww man」（CaptainSparklez《Revenge》开篇，官方 1.16 把它做成主菜单标语第 399 条）；「这不是 bug」接「这是特性」；「嘶——」接「要炸了」；对方说「aww man」就把「Creeper?」接回去。'
      + '内置速查库有四篇梗资料：《梗与黑话》（接龙梗、外号、玩法黑话、口头禅）、《梗库：游戏内梗》（这是特性、翻译事故、操作习惯、赤石科技、界面提示与死亡信息、床与传送门）、《梗库：圈子与主播》（还是 PVP 大佬、珍珠炮炸膛、创哥理赔、外挂黑话、缩写称呼）、《官方彩蛋与出处》（命名牌彩蛋、Minceraft、Technoblade、唱片声谱图等，全部可考证）。'
      + '标了【慎用】的梗（引战话题、涉及真人的争议、带侮辱性的外号）不要主动提；群友问起就只解释词义，不评价人、不站队。'
      + '遇到人名、外号、黑话、缩写、梗词，或群友问「这是不是官方梗 / 出处是什么」时，先 kb_search 查一次（直接用那个词查：creeper / 彩蛋 / Technoblade / 挖三填一），别当字面词硬答，更别编出处。'
      + '官方彩蛋想查更多可 wiki_page("彩蛋")、wiki_page("闪烁标语")、wiki_page("愚人节玩笑")。'
    );
  } else {
    lines.push('5) 这轮不要用梗，正常说事。');
  }
  lines.push('6) 没聊到我的世界时不要主动往 MC 上扯；没被叫到时也不要提这些工具。');
  return lines.join('\n');
}

// ── ⑥ 工具注册 ──────────────────────────────────────────────────────────────

export function setup(api) {
  cfg = api.config;
  log = api.log || (() => {});
  net = typeof api.fetch === 'function' ? api.fetch : null;

  // ── 工具 1：检索 MC Wiki ───────────────────────────────────────────────────
  api.registerTool({
    id: 'wiki_search',
    name: '检索我的世界 Wiki',
    description:
      '在《我的世界》中文 Wiki（zh.minecraft.wiki）里检索条目，返回标题、摘要与链接。'
      + '**优先返回标题命中的条目**（中文条目名最准：如「下界合金」「末影龙」「刷铁机」「村民交易」），'
      + '前缀查不到时再按正文关键词全文检索。'
      + '当要查某个具体条目 —— 方块、物品、生物、魔咒、药水、结构、地形、命令、版本更新、模组概念 —— '
      + '而内置速查库里没有或需要最新数据时先用它；拿到条目名后再用 wiki_page 读正文。'
      + '关键词尽量用条目名而不是整句话（「刷铁机」比「怎么做一个刷铁机」准得多）。',
    category: 'web',
    icon: '🔎',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词，越具体越准，如「下界合金」「附魔台」「经验修补」「远古城市」。' },
        limit: { type: 'integer', description: '返回几条结果，1~10，不填用设置里的默认值（默认 5）。' }
      },
      required: ['query']
    },
    async execute(_ctx, args) {
      learnSelf(_ctx);
      const query = String(args?.query ?? '').trim();
      if (!query) return { content: '缺少 query 参数：请给出要检索的关键词。', isError: true };
      const ns = networkState();
      if (!ns.ok) return { content: `联网检索不可用：${ns.reason}。${NO_NET_HINT}`, isError: true };
      const c = cfg() || {};
      const limit = clampInt(args?.limit, 1, 10, clampInt(c.searchLimit, 1, 10, 5));
      try {
        const hits = await wikiSearch(query, limit);
        if (!hits.length) {
          return { content: `zh.minecraft.wiki 里没检索到「${query}」。换个关键词再试（中文条目名通常最准，比如把「刷铁机」换成「铁傀儡」）。` };
        }
        const withSource = c.includeSource !== false;
        const top = hits[0];
        const direct = top && top.title.trim().toLowerCase() === query.trim().toLowerCase();
        let tail = direct
          ? `\n（「${top.title}」就是同名条目，直接用 wiki_page 读它。）`
          : '\n（确认要查哪个条目后，用 wiki_page 读它的正文。）';
        if (!direct && top && !sharesTitleTerm(top.title, query)) {
          tail += '\n（提示：这些结果里没有标题直接对上的条目 —— 关键词太长或太口语了。换成更短的中文条目名再搜一次通常就准，比如「钻石」「刷铁机」「附魔台」。）';
        }
        return {
          content: `MC Wiki 检索「${query}」的结果：\n`
            + hits.map((h, i) => `${i + 1}. ${h.title}${h.snippet ? `\n   ${h.snippet}` : ''}${withSource ? `\n   ${wikiPageUrl(h.title)}` : ''}`).join('\n')
            + tail
        };
      } catch (error) {
        return { content: `检索失败：${error?.message ?? error}。${NO_NET_HINT}`, isError: true };
      }
    }
  });

  // ── 工具 2：读 Wiki 页面正文 ───────────────────────────────────────────────
  api.registerTool({
    id: 'wiki_page',
    name: '读我的世界 Wiki 页面',
    description:
      '读取 zh.minecraft.wiki 某个条目的正文纯文本。已经知道条目名（或刚用 wiki_search 查到的标题）时用它拿细节：'
      + '获取方式、用途、机制说明、历史版本变化、掉落、交易、繁殖、数据值等。'
      + '参数 title 只写条目名，不要带 https:// 前缀，也不要带方括号。'
      + '注意：合成配方表、掉落概率表、数据值表这类**表格内容**正文抽取拿不到（会看到「Java版：」「基岩版：」后面空着），'
      + '这种情况直接告诉群友去看来源链接，不要自己把配方凭记忆补上。',
    category: 'web',
    icon: '📄',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '条目名，如「钻石」「末影龙」「红石电路」「附魔」。' },
        maxChars: { type: 'integer', description: '返回正文的字符上限，500~12000，不填用设置里的默认值（默认 3000）。' }
      },
      required: ['title']
    },
    async execute(_ctx, args) {
      learnSelf(_ctx);
      const title = String(args?.title ?? '')
        .replace(/^https?:\/\/zh\.minecraft\.wiki\/w\//i, '')
        .replace(/[[\]]/g, '')
        .trim();
      if (!title) return { content: '缺少 title 参数：请给出条目名。', isError: true };
      const ns = networkState();
      if (!ns.ok) return { content: `读取 Wiki 页面不可用：${ns.reason}。${NO_NET_HINT}`, isError: true };
      const c = cfg() || {};
      const cap = clampInt(args?.maxChars, 500, 12000, clampInt(c.maxPageChars, 500, 12000, 3000));
      try {
        const res = await wikiPageExtract(title, cap);
        if (res.missing) {
          const hits = await wikiSearch(title, 5).catch(() => []);
          return {
            content: `Wiki 上没有「${title}」这个条目。`
              + (hits.length
                ? `相近的检索结果：\n${hits.map((h, i) => `${i + 1}. ${h.title}`).join('\n')}\n（用 wiki_page 读其中一个。）`
                : '换个关键词用 wiki_search 找找。')
          };
        }
        if (res.empty) {
          return { content: `「${res.title}」没有可提取的正文（多半是纯表格/图鉴页）。原页：${wikiPageUrl(res.title)}` };
        }
        const tail = res.truncated
          ? `\n…（已截断：本次返回 ${cap} 字符，原文共约 ${res.total} 字符；需要更多就调大 maxChars。）`
          : '';
        const withSource = c.includeSource !== false;
        return {
          content: `《${res.title}》正文（zh.minecraft.wiki）：\n${res.text}${tail}`
            + (withSource ? `\n\n来源：${wikiPageUrl(res.title)}\n${WIKI_ORDER_HINT}` : '')
        };
      } catch (error) {
        return { content: `读取「${title}」失败：${error?.message ?? error}。${NO_NET_HINT}`, isError: true };
      }
    }
  });

  // ── 工具 3：内置速查库（离线）──────────────────────────────────────────────
  api.registerTool({
    id: 'kb_search',
    name: '查我的世界速查库',
    description:
      '在机器人内置的《我的世界》速查库里检索（离线、秒回、不联网）：生存流程与第一天怎么做、工具等级与矿石分布、'
      + '常用合成、附魔与酿造、红石元件与常见装置、生物与打法、常用指令、Java/基岩/网易版差异、**梗与黑话**（接龙梗/外号）、**游戏内梗**（特性、翻译事故、赤石科技、死亡信息）、**圈子与主播梗**（还是 PVP 大佬、珍珠炮、外挂黑话、慎用清单）、**官方彩蛋与出处**。'
      + '当群友问机制怎么运作、萌新怎么开始、某个说法/黑话/外号什么意思、某句梗的出处、某个东西怎么用、该挖到多深这类问题时优先用它；'
      + '**群友甩梗、说黑话、发外号、或问「这是不是官方彩蛋」时，先用它查一次再回，不要凭印象硬猜。**'
      + '查具体条目的详细数据与版本改动请改用 wiki_search / wiki_page。',
    category: 'knowledge',
    icon: '📚',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词，不要太长：如「第一天」「钻石在哪挖」「附魔」「红石中继器」「梗」「creeper」「彩蛋」「Technoblade」。' },
        limit: { type: 'integer', description: '返回几段资料，1~6，默认 3。' }
      },
      required: ['query']
    },
    async execute(_ctx, args) {
      learnSelf(_ctx);
      const query = String(args?.query ?? '').trim();
      const limit = clampInt(args?.limit, 1, 6, 3);
      try {
        if (!query) {
          const catalog = kbCatalog();
          return { content: `内置速查库当前有这些主题（${catalog.length} 个）：\n${catalog.map((t) => `· ${t}`).join('\n')}\n请给出更具体的检索词。` };
        }
        const { hits, catalog, total } = searchKb(query, limit, 900);
        if (!hits.length) {
          return {
            content: `内置速查库里没有和「${query}」直接相关的内容（当前共 ${total} 个主题）：\n`
              + catalog.map((t) => `· ${t}`).join('\n')
              + '\n可以换个说法再查一次，或者用 wiki_search 联网找条目。'
              + (networkState().ok ? '' : ` ${NO_NET_HINT}`)
          };
        }
        log(`速查库命中 ${hits.length} 段（query=${query}）`);
        return {
          content: hits.map((h, i) => `【资料 ${i + 1}】${h.title}\n${h.snippet}\n（来源：${h.source}）`).join('\n\n')
        };
      } catch (error) {
        return { content: `速查库检索失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 工具 4：B 站视频（按播放 + 投币 + 收藏挑一条）──────────────────────────
  api.registerTool({
    id: 'bilibili_search',
    name: '搜 B 站 MC 视频',
    description:
      '在 B 站搜索《我的世界》相关视频，并**只返回一个**最值得发的：先搜出候选，再逐个取播放量、投币数、收藏数，'
      + '按「播放 + 2×投币 + 1.5×收藏」的对数综合分排序取第一名（投币与收藏是比播放更"贵"的信号）。'
      + '适用于生存实况、红石教程、建筑教学、模组与整合包推荐、PVP 技巧、版本更新解读、萌新入门、搞笑梗视频。'
      + '当群友说「找个教程」「红石怎么学」「有没有建筑教学」「B 站上有没有…」时使用。'
      + '返回值已包含标题/UP/播放/投币/收藏/时长/链接，直接把这一个链接发出去即可（不要另外再挑、不要主动刷视频、不要照抄长标题）。',
    category: 'web',
    icon: '📺',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词，带上具体对象更准：「我的世界 生存 教程」「红石 中继器 教学」「我的世界 建筑 教程」。' },
        candidates: { type: 'integer', description: '候选池大小，1~10，默认用设置里的值（默认 8）。' },
        order: { type: 'string', enum: BILI_ORDER_CHOICES, description: '检索时的排序偏好，默认「综合」。最终选哪一条由播放+投币+收藏综合分决定。' }
      },
      required: ['query']
    },
    async execute(_ctx, args) {
      learnSelf(_ctx);
      const query = String(args?.query ?? '').trim();
      if (!query) return { content: '缺少 query 参数：请给出要搜的关键词。', isError: true };
      const ns = networkState();
      if (!ns.ok) return { content: `搜索 B 站不可用：${ns.reason}。${NO_NET_HINT}`, isError: true };
      const c = cfg() || {};
      const candidates = clampInt(args?.candidates, 1, 10, clampInt(c.biliCandidates, 1, 10, 8));
      const order = BILI_ORDER_CHOICES.includes(String(args?.order)) ? String(args.order) : '综合';
      try {
        const res = await biliSearchBest(query, { candidates, order });
        if (res.best) {
          log(`B 站挑出 1 条：${res.best.bvid}（播放 ${res.best.play}、投币 ${res.best.coin}、收藏 ${res.best.favorite}，候选 ${res.candidates.length}）`);
        }
        return { content: formatBiliResult(res) };
      } catch (error) {
        return {
          content: `搜索 B 站失败：${error?.message ?? error}。可以让群友自己去这里搜：${biliSearchUrl(query)}`,
          isError: true
        };
      }
    }
  });
}

/** 把 B 站搜索结果渲染成给模型看的文本（只给挑好的那一条）。 */
function formatBiliResult(res) {
  if (!res.best) {
    return `B 站没搜到「${res.keyword}」${res.note ? `（${res.note}）` : ''}。可以让群友自己在这里搜：${res.fallbackUrl}`;
  }
  const b = res.best;
  const bits = [
    b.author ? `UP：${b.author}` : '',
    b.play ? `播放 ${b.play}` : '',
    b.coin === null || b.coin === undefined ? '投币：未取到' : `投币 ${formatCount(b.coin)}`,
    b.favorite === null || b.favorite === undefined ? '收藏：未取到' : `收藏 ${formatCount(b.favorite)}`,
    b.duration ? `时长 ${b.duration}` : '',
    b.date
  ].filter(Boolean);
  const lines = [
    `B 站搜「${res.keyword}」→ 已从 ${res.candidates.length} 个候选里按「播放 + 投币 + 收藏」综合挑出 1 个（${res.order}检索）：`,
    b.title,
    bits.join(' · '),
    b.url,
    '（只发这一条就行，不用再挑；也别照抄长标题，用一句话说清它是什么。）'
  ];
  if (res.note) lines.push(`（提示：${res.note}）`);
  return lines.join('\n');
}

/** 自检必须同步；本技能没有硬依赖：kb 缺失也能靠联网工作，联网关了也能靠 kb 工作。 */
export function available() {
  return true;
}

// ── 钩子：记录本轮性质 ─────────────────────────────────────────────────────

export const hooks = {
  'before-context': (ctx) => {
    try {
      const entries = Array.isArray(ctx?.triggerEntries) ? ctx.triggerEntries : [];
      learnSelf(ctx);
      const addressed = entries.some((e) => entryAddressesBot(e));
      const text = entries
        .map((e) => `${e?.text ?? ''} ${Array.isArray(e?.atNames) ? e.atNames.join(' ') : ''}`)
        .join('\n');
      const topic = textHasMinecraftTopic(text);
      rememberTurn(ctx, { addressed, topic });
      if (addressed || topic) {
        log(`闸门：${ctx?.chatKey ?? '?'} 本轮 ${addressed ? '被叫到' : ''}${addressed && topic ? ' + ' : ''}${topic ? '聊到 MC' : ''}`);
      }
    } catch {
      // 钩子失败绝不影响主流程（最坏情况是这一轮按"没有触发信息"放行）
    }
  }
};

/** 动态提示词：只有闸门放行时才把「我的世界大师」这段注入系统提示。 */
export function promptSections(ctx) {
  try {
    const c = cfg() || {};
    const verdict = decide(ctx || {}, {
      mode: normalizeMode(c.triggerMode),
      graceMinutes: c.graceMinutes
    });
    if (!verdict.allow) return [];
    return [{
      id: 'minecraft-master-guide',
      title: '我的世界大师',
      priority: 45,
      content: buildGuideText()
    }];
  } catch {
    return [];
  }
}

export const providers = {
  // 本轮没被叫到时直接否决本技能的工具（返回 { ok:false } 即否决）
  'tool.guard': ({ toolId, context }) => {
    if (!String(toolId ?? '').startsWith('minecraft-master__')) return null; // 不归我管
    try {
      const c = cfg() || {};
      const verdict = decide(context || {}, {
        mode: normalizeMode(c.triggerMode),
        graceMinutes: c.graceMinutes
      });
      if (verdict.allow) return null;
      return { ok: false, reason: `我的世界大师：${verdict.why}` };
    } catch {
      return null;
    }
  }
};
