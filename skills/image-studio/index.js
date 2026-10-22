// 「图片工坊」—— LLM 型 Skill（放在 skills/ 下，靠 registerTool 让模型自己判断何时用）。
//
// 它解决的是一条完整链路：搜图 → 加工（旋转 / 翻转 / 黑白 / 缩放）→ 先预览 → 发到聊天，
// 以及把选中的那张图设成**机器人自己账号**的 QQ 头像。
//
// 为什么是 Skill 而不是插件：
//   「什么时候该搜图」「要转 90° 还是 180°」「这句话是在让我换头像吗」全是人话判断，
//   规则写不死；插件（providers/hooks）根本不经过模型，做不了这种事。
//
// 安全边界（与核心工具同一套）：
//   · 只接受 http(s) 图片直链或当前聊天里的图片，不接受本机文件路径
//   · 下载走核心 safe-fetch：SSRF 防护、逐跳校验、体积上限、浏览锁定
//   · 默认「先预览再发」，换头像同样必须先预览过
//   · 发送走 ctx.sender.sendImage：限频、去重、留档一个都不少
//
// 图像处理依赖 Electron 的 nativeImage（Chromium 解码器）：
//   项目没有 sharp/jimp，用户机器上也未必有 ffmpeg，而桌面端本来就带 Chromium。
//   纯 Node（headless server）环境下会明确报「不支持」，不会静默失效。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
// ⚠️ 带 ?v= 版本号不是装饰：热重载只给**入口**加时间戳，相对导入的子模块
// 会按 URL 命中 Node 的模块缓存 —— 改了 lib/ 里的文件而不改这里的 ?v=，
// 热重载后仍在跑旧代码（表现为「明明改了却没反应」）。改 lib 时同步改这里的版本号。
import { detectMime, makePreview, normalizeDegrees, transformImage } from './lib/imaging.js?v=1.3.0';
import { searchImages, searchPixiv, hasCjk, hasKana } from './lib/search.js?v=1.3.0';
import { DEFAULT_WINDOW_DAYS, itemKey, loadHistory, saveHistory, seenSet } from './lib/history.js?v=1.3.0';

// 项目约定：以模块自身位置为锚点（skills/<id>/index.js → ../.. = resources/app）
const APP_ROOT = globalThis.__qqAgentRoot
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// ── 核心模块：懒加载 ────────────────────────────────────────────────────────
// 懒加载的好处：核心模块万一改名，技能本身仍然能加载出来、在技能页可见，
// 报错会出现在工具调用时（而不是变成「加载失败」让用户完全无从下手）。
let corePromise = null;
function core() {
  if (!corePromise) {
    corePromise = (async () => {
      const load = (rel) => import(pathToFileURL(path.join(APP_ROOT, rel)).href);
      const [config, safeFetch] = await Promise.all([
        load('src/config.js'),
        load('src/safe-fetch.js')
      ]);
      return {
        getConfig: config.getConfig,
        DATA_DIR: config.DATA_DIR,
        safeFetchBinary: safeFetch.safeFetchBinary,
        validateImageUrl: safeFetch.validateImageUrl,
        browseLockState: safeFetch.browseLockState
      };
    })().catch((error) => {
      corePromise = null;
      throw new Error(`核心模块加载失败：${error?.message ?? error}`);
    });
  }
  return corePromise;
}

// ── Electron nativeImage：懒加载 + 只探一次 ─────────────────────────────────
let electronPromise = null;
function nativeImageApi() {
  if (!electronPromise) {
    electronPromise = (async () => {
      let mod;
      try {
        mod = await import('electron');
      } catch (importError) {
        // 少数 Electron 版本里 ESM 解析内建模块会失败，退回 CJS require
        try {
          const { createRequire } = await import('node:module');
          mod = createRequire(import.meta.url)('electron');
        } catch (requireError) {
          throw new Error(`图片处理需要桌面版运行（拿不到 Electron）：${requireError?.message ?? importError?.message ?? requireError}`);
        }
      }
      const ni = mod?.nativeImage ?? mod?.default?.nativeImage;
      if (!ni || typeof ni.createFromBuffer !== 'function') {
        throw new Error('图片处理需要桌面版运行（当前进程没有 Electron nativeImage）');
      }
      return ni;
    })().catch((error) => {
      electronPromise = null;
      throw error;
    });
  }
  return electronPromise;
}

// ── 小工具 ─────────────────────────────────────────────────────────────────
const ok = (value) => ({ content: typeof value === 'string' ? value : JSON.stringify(value) });
const err = (message) => ({ content: `图片工坊：${message}`, isError: true });
const human = (e) => String(e?.message ?? e ?? '未知错误').slice(0, 300);
const clampInt = (value, lo, hi, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
};
const sha = (text) => createHash('sha256').update(String(text)).digest('hex');

// 每次运行的状态挂在 ctx 上（WeakMap，ctx 变了自然回收，不污染会话存档）
const STATES = new WeakMap();
function stateOf(ctx) {
  let s = STATES.get(ctx);
  if (!s) {
    s = { entries: new Map(), tokens: new Map(), previewedUrls: new Set(), sends: 0, previews: 0 };
    STATES.set(ctx, s);
  }
  return s;
}

function opsOf(args) {
  return {
    rotate: normalizeDegrees(args?.rotate),
    flip: args?.flip === 'horizontal' || args?.flip === 'vertical' ? args.flip : 'none',
    grayscale: args?.grayscale === true,
    maxSize: clampInt(args?.max_size, 0, 4096, 0)
  };
}

function opsLabel(ops) {
  const parts = [];
  if (ops.rotate) parts.push(`旋转 ${ops.rotate}°`);
  if (ops.flip === 'horizontal') parts.push('水平翻转');
  if (ops.flip === 'vertical') parts.push('垂直翻转');
  if (ops.grayscale) parts.push('黑白');
  if (ops.maxSize) parts.push(`长边缩到 ${ops.maxSize}px`);
  return parts.length ? parts.join(' / ') : '原样（只重新编码）';
}

const opsKey = (url, ops) => sha(`${url}|${ops.rotate}|${ops.flip}|${ops.grayscale}|${ops.maxSize}`);

// ── 缓存目录（写在 data/ 下，绝不写进 skills/ —— 那会触发热重载死循环）────────
// 注意：安装版的数据目录跟着 exe 走（<安装目录>\data），所以临时图片只落在
// **项目所在的那块盘**上，不会经过系统盘 / 用户临时目录。
const PREVIEW_TTL_MS = 10 * 60 * 1000;      // 预览了没发：10 分钟后清掉
const CACHE_ORPHAN_MS = 60 * 60 * 1000;     // 进程崩溃留下的孤儿：1 小时后清
const CACHE_MAX_BYTES = 200 * 1024 * 1024;  // 整个缓存目录最多占 200MB

let cacheChecked = false;
async function cacheDir() {
  const { DATA_DIR } = await core();
  const dir = path.join(DATA_DIR, 'image-studio', 'cache');
  fs.mkdirSync(dir, { recursive: true });
  if (!cacheChecked) {
    cacheChecked = true;
    pruneCacheDir(dir);
  }
  return dir;
}

/** 首用清理：超过 1 小时的孤儿全删；总量超 200MB 时从最旧的开始删到额度内。 */
function pruneCacheDir(dir) {
  try {
    const files = fs.readdirSync(dir)
      .filter((name) => /^[a-f0-9]{64}\.(png|jpg|webp|gif|avif)$/.test(name))
      .map((name) => {
        const file = path.join(dir, name);
        try {
          const stat = fs.statSync(file);
          return { file, size: stat.size, mtime: stat.mtimeMs };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => a.mtime - b.mtime);
    const now = Date.now();
    let total = files.reduce((sum, f) => sum + f.size, 0);
    for (const item of files) {
      if (now - item.mtime > CACHE_ORPHAN_MS || total > CACHE_MAX_BYTES) {
        try { fs.unlinkSync(item.file); total -= item.size; } catch { /* 单个失败不影响其它 */ }
      }
    }
  } catch { /* 清理失败不影响功能 */ }
}

// 扩展名必须跟着**真实 mime** 走：原图直通时字节不重编码，webp 存成 .jpg
// 会让协议端按扩展名猜格式（有的实现会因此拒收）。
const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };

async function saveImage(buffer, mime) {
  const hash = sha(buffer);
  const ext = EXT_BY_MIME[mime] || 'img';
  const file = path.join(await cacheDir(), `${hash}.${ext}`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, buffer);
  return { file, hash };
}

// ── 下载与来源解析 ─────────────────────────────────────────────────────────
async function download(url, maxBytes) {
  const { safeFetchBinary, browseLockState } = await core();
  let result;
  try {
    result = await safeFetchBinary(url, maxBytes, { browseLocked: browseLockState().enabled });
  } catch (error) {
    const message = human(error);
    if (/HTTP 404/.test(message) && /pixiv\.re$/i.test(new URL(url).hostname)) {
      throw new Error(`图片下载失败：${message}（这张作品可能被作者删除，或不允许转载；换搜索结果里的下一条）`);
    }
    throw new Error(`图片下载失败：${message}`);
  }
  const buffer = result?.buffer;
  if (!buffer?.length) throw new Error('图片内容为空');
  // safeFetchBinary 读到上限就截断并返回，不会报错 —— 截断的图解码必失败，
  // 不如在这里说清楚（Pixiv 原图动辄 10MB+，很容易撞上）。
  if (buffer.length >= maxBytes) {
    throw new Error(`图片超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限（Pixiv 原图可在设置里调「Pixiv 原图上限」），换一张或调大上限`);
  }
  const mime = detectMime(buffer);
  if (!mime) {
    const head = buffer.subarray(0, 160).toString('utf8').trim().toLowerCase();
    if (head.startsWith('<!doctype') || head.startsWith('<html')) {
      throw new Error('这个地址返回的是网页，不是图片直链（要整条图片地址，不是网页地址）');
    }
    throw new Error(`这个地址返回的不是图片（Content-Type: ${result?.contentType || '未知'}）`);
  }
  return { buffer, mime };
}

/** 解析图片来源：url 与 messageId 二选一。 */
async function resolveSource(ctx, args) {
  const { validateImageUrl } = await core();
  const rawUrl = String(args?.url ?? '').trim();
  const mid = args?.messageId != null ? String(args.messageId).trim() : '';
  if (rawUrl && mid) throw new Error('url 和 messageId 只能给一个');
  if (rawUrl) {
    if (!/^https?:\/\//i.test(rawUrl)) throw new Error('只支持 http(s) 图片直链（不支持本机文件路径）');
    return { url: await validateImageUrl(rawUrl), label: '网图' };
  }
  if (mid) {
    const entry = ctx?.store?.findByMid?.(ctx.chatKey, mid);
    if (!entry) throw new Error(`当前聊天里没有 id 为 ${mid} 的消息`);
    const images = (entry.media || []).filter((m) => m?.kind === 'image');
    if (!images.length) throw new Error('这条消息里没有图片');
    const media = images[0];
    let url = String(media.url || '').trim();
    if (!url && media.file) {
      const got = await ctx.onebot.call('get_image', { file: String(media.file) });
      url = String(got?.url || '').trim();
    }
    if (!url) throw new Error('这张图片的地址拿不到，换一张或用图片直链');
    return { url: await validateImageUrl(url), label: '聊天图片' };
  }
  throw new Error('需要 url（图片直链）或 messageId（当前聊天里的图片消息 id）');
}

/** 有没有真正的图像操作。全都没有 = 原图直通（一个像素都不重编码）。 */
export function hasEdits(ops) {
  if (!ops) return false;
  return ops.rotate !== 0
    || (typeof ops.flip === 'string' && ops.flip !== 'none')
    || ops.grayscale === true
    || Number(ops.maxSize) > 0;
}

function isPixivHost(url) {
  try { return /(^|\.)pixiv\.re$/i.test(new URL(url).hostname); } catch { return false; }
}

/** 单个来源的体积上限：Pixiv 原图单独一档（默认 20MB），普通网图仍用 6MB。 */
function capBytesFor(url, cfg) {
  const pixiv = isPixivHost(url);
  const fallback = pixiv ? 20 : 6;
  const mb = Math.max(1, Number(pixiv ? cfg?.pixivMaxBytesMB ?? fallback : cfg?.maxBytesMB ?? fallback) || fallback);
  return mb * 1024 * 1024;
}

async function buildEntry(ctx, source, ops, state, cfg) {
  const { buffer, mime } = await download(source.url, capBytesFor(source.url, cfg));
  const nativeImage = await nativeImageApi();

  const edited = hasEdits(ops);
  let finalBuffer = buffer;
  let finalMime = mime;
  let width;
  let height;
  let preview;
  try {
    if (edited) {
      const processed = transformImage(nativeImage, buffer, mime, ops);
      finalBuffer = processed.buffer;
      finalMime = processed.mime;
      width = processed.width;
      height = processed.height;
      preview = makePreview(nativeImage, finalBuffer, finalMime, { maxSide: 1024 });
    } else {
      // 原图直通：最终发出去的就是下载到的原始字节（PNG 逐字节一致、JPEG 不掉质量），
      // 只额外生成一张 ≤1024 的缩略图给模型「看一眼」。
      preview = makePreview(nativeImage, buffer, mime, { maxSide: 1024 });
      width = preview.width;
      height = preview.height;
    }
  } catch (error) {
    throw new Error(`图片处理失败：${human(error)}`);
  }

  const saved = await saveImage(finalBuffer, finalMime);
  const token = saved.hash.slice(0, 12);
  const entry = {
    token,
    url: source.url,
    label: source.label,
    ops,
    mime: finalMime,
    width,
    height,
    file: saved.file,
    bytes: finalBuffer.length,
    edited,
    at: Date.now(),
    // 只留缩略图的 data URL：整图字节留在磁盘（发送时协议端自己读），
    // 这样一次运行里缓存十几张 20MB 原图也不会把内存顶爆。
    preview: {
      dataUrl: `data:${preview.mime};base64,${preview.buffer.toString('base64')}`,
      bytes: preview.buffer.length
    }
  };
  state.entries.set(opsKey(source.url, ops), entry);
  state.tokens.set(token, entry);
  state.previewedUrls.add(source.url);
  state.previews += 1;
  // 只保留最近 12 个（现在每条只是一个路径 + 缩略图，很轻）
  while (state.entries.size > 12) {
    const oldestKey = state.entries.keys().next().value;
    const old = state.entries.get(oldestKey);
    state.entries.delete(oldestKey);
    if (old && state.tokens.get(old.token) === old) state.tokens.delete(old.token);
  }
  return entry;
}

function requirePreview(cfg) {
  return cfg?.requirePreview !== false;
}

/** 删掉一条预览记录：本地文件 + token + 索引一起清，避免“删了文件还留着 token”。 */
function dropEntry(state, entry) {
  if (!entry) return;
  try { fs.unlinkSync(entry.file); } catch { /* 已经被清掉就算了 */ }
  state.tokens.delete(entry.token);
  for (const [key, value] of state.entries) {
    if (value === entry) state.entries.delete(key);
  }
}

/** 清掉超过 TTL 还没发出去的预览（图存着但没人要，最占磁盘的就是这种）。 */
function sweepPreviews(state) {
  const cutoff = Date.now() - PREVIEW_TTL_MS;
  for (const [key, entry] of [...state.entries]) {
    if ((entry.at || 0) < cutoff) dropEntry(state, entry);
  }
}

const fmtSize = (bytes) => (bytes >= 1024 * 1024
  ? `${(bytes / 1024 / 1024).toFixed(1)}MB`
  : `${Math.max(1, Math.round(bytes / 1024))}KB`);

// ── 中→日标签词典：内置种子词表 + 模型教给我们的映射 ──────────────────────
// 为什么需要：Pixiv 的标签绝大多数是日文，群友说的是中文（还常带昵称、带「酱」）。
// 查找顺序是「模型给的日文 tag → 词典 → 原文再搜」，词典只是补位，不瞎猜。
const TAG_DICT_URL = new URL('./lib/tag-dict.json', import.meta.url);
let seedDictCache = null;
function seedDict() {
  if (!seedDictCache) {
    try {
      const raw = JSON.parse(fs.readFileSync(TAG_DICT_URL, 'utf8'));
      seedDictCache = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    } catch { seedDictCache = {}; }
  }
  return seedDictCache;
}

let learnedCache = null;
async function learnedDictFile() {
  const { DATA_DIR } = await core();
  return path.join(DATA_DIR, 'image-studio', 'tag-dict.json');
}

async function learnedDict() {
  if (learnedCache) return learnedCache;
  try {
    const raw = JSON.parse(fs.readFileSync(await learnedDictFile(), 'utf8'));
    learnedCache = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  } catch { learnedCache = {}; }
  return learnedCache;
}

/** 种子 + 学到的合并；学到的优先（更贴近这个群自己的叫法）。 */
async function tagDict() {
  return { ...seedDict(), ...(await learnedDict()) };
}

/**
 * 模型同时给了中文名和日文标签时，把这层映射记下来 —— 下次它只给中文也能搜到。
 * 只在「中文含汉字且不含假名、日文含假名」时学习，避免把乱七八糟的值写进词典。
 */
async function rememberTag(zh, ja) {
  const from = String(zh ?? '').trim();
  const to = String(ja ?? '').trim();
  if (!from || !to || from === to) return;
  if (!hasCjk(from) || hasKana(from)) return;
  if (!hasKana(to)) return;
  if (from.length > 20 || to.length > 40) return;
  const learned = await learnedDict();
  if (learned[from] === to) return;
  learned[from] = to;
  try {
    const file = await learnedDictFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(learned, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch { /* 学不进去不影响本次搜索 */ }
}

// ── 发送历史：防重发 ───────────────────────────────────────────────────────
// 只记「发过什么」的键和时间，不存图片；默认 30 天内的算"发过"。
let historyCache = null;

async function historyFile() {
  const { DATA_DIR } = await core();
  return path.join(DATA_DIR, 'image-studio', 'history.json');
}

async function sentHistory() {
  if (!historyCache) historyCache = loadHistory(await historyFile());
  return historyCache;
}

/** 发送成功后记账。失败只记日志，绝不能因为它把已经发出去的图报成失败。 */
async function markSent(url) {
  try {
    const items = await sentHistory();
    items.push({ key: itemKey(url), at: Date.now() });
    historyCache = saveHistory(await historyFile(), items);
  } catch { /* 去重是锦上添花 */ }
}

// ── Skill 入口 ─────────────────────────────────────────────────────────────
export function setup(api) {
  const cfg = () => api.config() || {};
  // 只有声明了 web_fetch 权限，api.fetch 才是真的 fetch（否则是个永远 reject 的占位）
  const httpFetch = typeof api.fetch === 'function' ? (...args) => api.fetch(...args) : null;

  api.registerTool({
    id: 'find_images',
    name: '搜图',
    description: '按关键词搜网图，返回可直接使用的图片直链（不用配搜索服务）。source=web 搜普通网图；source=pixiv 搜 Pixiv 插画（中文角色名会自动换成日文标签，内置词典）。要发图时：先搜，再把挑中的 url 交给 image-studio__edit_image 预览，确认后发送。',
    category: 'media',
    icon: '🔎',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词，越具体越准（如「橘猫 趴在键盘上」）' },
        limit: { type: 'integer', description: '返回几条候选，1~8，默认 5' },
        source: { type: 'string', enum: ['web', 'pixiv'], description: 'web（默认）= 普通网图；pixiv = Pixiv 插画' },
        tag: { type: 'string', description: '仅 source=pixiv：Pixiv 标签，优先于 query。知道日文名就填日文（如「初音ミク」）；填中文也会自动换算' }
      },
      required: ['query'],
      additionalProperties: false
    },
    async execute(ctx, args) {
      try {
        const c = cfg();
        const query = String(args?.query ?? '').trim();
        if (!query) return err('query 不能为空：要搜什么图？');
        const limit = clampInt(args?.limit, 1, 8, 5);
        const source = args?.source === 'pixiv' ? 'pixiv' : 'web';

        const avoidRepeat = c.avoidRepeat !== false;
        const windowDays = clampInt(c.repeatWindowDays, 1, 365, DEFAULT_WINDOW_DAYS);
        const seen = avoidRepeat ? seenSet(await sentHistory(), windowDays) : new Set();

        let list;
        if (source === 'pixiv') {
          if (c.pixivEnabled === false) return err('Pixiv 搜图已在设置里关闭。');
          const tag = String(args?.tag ?? '').trim();
          // 模型同时给了中文名和日文标签 → 顺手把这层映射记下来
          if (tag) await rememberTag(query, tag);
          list = await searchPixiv(httpFetch, tag || query, limit, {
            apiUrl: c.pixivApiUrl,
            dict: await tagDict(),
            popular: c.popularFirst !== false,
            isSeen: avoidRepeat ? (url) => seen.has(itemKey(url)) : null,
            windowDays
          });
        } else {
          // 网图没有热度数据（搜索引擎只给相关性排序），这里只做去重：
          // 多要一倍候选，筛掉发过的之后再截到 limit。
          const raw = await searchImages(httpFetch, query, Math.min(8, Math.max(limit, limit * 2)));
          list = raw.filter((item) => !avoidRepeat || !seen.has(itemKey(item.url))).slice(0, limit);
          if (!list.length && raw.length) {
            return ok(`「${query}」搜到的图最近 ${windowDays} 天都发过了，换个更具体的词再试。`);
          }
        }

        if (!Array.isArray(list) || !list.length) {
          return ok(`「${query}」没搜到图，换个更具体的词再试一次。`);
        }
        // 刻意用纯文本而不是 JSON：JSON 的键名、引号和 page 字段每轮都要重发，
        // 5 条候选能差出两三百 token。这里只留“序号 + 短标题 + 直链”。
        const lines = list.slice(0, limit).map((item, index) => {
          const title = String(item?.title ?? '').trim().slice(0, 30);
          return `${index + 1}. ${title ? `${title} | ` : ''}${String(item?.url ?? '')}`;
        });
        return ok([
          `「${query}」${lines.length} 条${source === 'pixiv' ? '（Pixiv，全年龄）' : ''}：`,
          ...lines,
          '把选中的 url 原样传给 image-studio__edit_image（先预览，send:true 才发）；下载失败就换下一条。'
        ].join('\n'));
      } catch (error) {
        const hint = args?.source === 'pixiv'
          ? '（用日文标签更准，如「初音ミク」；不行就换 source=web）'
          : '（可以让群友直接给图片链接）';
        return err(`搜图失败：${human(error)}${hint}`);
      }
    }
  });

  api.registerTool({
    id: 'edit_image',
    name: '处理图片',
    description: '下载一张网图并按参数加工（旋转 / 翻转 / 黑白 / 缩放），默认只返回预览给模型看、不发送；确认效果后用返回的 token 加 send:true 才发到当前聊天。发图前必须先预览一次。',
    category: 'media',
    icon: '🎛️',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '图片 http(s) 直链；和 messageId 二选一' },
        messageId: { type: 'string', description: '当前聊天里某条带图消息的 id（聊天记录里的 #数字）；和 url 二选一' },
        rotate: { type: 'integer', enum: [0, 90, 180, 270], description: '顺时针旋转角度，默认 0（不转）' },
        flip: { type: 'string', enum: ['none', 'horizontal', 'vertical'], description: '翻转方向，默认 none' },
        grayscale: { type: 'boolean', description: 'true = 转黑白' },
        max_size: { type: 'integer', description: '把长边缩到这个像素内（64~4096），0 = 不缩放' },
        send: { type: 'boolean', description: 'false（默认）= 只预览不发送；true = 发到当前聊天' },
        token: { type: 'string', description: '预览时返回的 token；发送时带上它，保证发的是看过的那张' },
        note: { type: 'string', description: '发图时配的一句话（可选）' }
      },
      additionalProperties: false
    },
    async execute(ctx, args) {
      try {
        const c = cfg();
        const state = stateOf(ctx);
        sweepPreviews(state);
        const ops = opsOf(args);
        const token = String(args?.token ?? '').trim();
        const wantedSend = args?.send === true;

        // 先认 token：发送那一步通常只带 token 回来，不该再要求它重传 url
        let entry = token ? state.tokens.get(token) : null;
        let source = null;
        if (!entry) {
          if (token && args?.url == null && args?.messageId == null) {
            return err('token 失效（预览超过 10 分钟，或这张已经发过了）。重新预览一次。');
          }
          source = await resolveSource(ctx, args);
          entry = state.entries.get(opsKey(source.url, ops));
        }

        if (!entry && wantedSend) {
          if (requirePreview(c)) return err('发图前先预览：调 image-studio__edit_image（不带 send）拿 token。');
          entry = await buildEntry(ctx, source, ops, state, c);
        }
        if (!entry) entry = await buildEntry(ctx, source, ops, state, c);

        if (!wantedSend) {
          const text = `预览 ${entry.width}×${entry.height}｜${fmtSize(entry.bytes)}｜${entry.edited ? opsLabel(entry.ops) : '原图直通'}`
            + `｜要发就带 token=${entry.token}、send=true`;
          return {
            content: [
              { type: 'text', text },
              { type: 'image_url', image_url: { url: entry.preview.dataUrl } }
            ]
          };
        }

        const limit = Math.max(1, Math.round(Number(c.maxSendsPerRun) || 3));
        if (state.sends >= limit) {
          return err(`本次已发 ${state.sends} 张，达到上限（设置里可调）。`);
        }

        // 预览文件可能已被 TTL 清掉：重下一份再发，别让模型白跑一轮
        if (!fs.existsSync(entry.file)) {
          entry = await buildEntry(ctx, { url: entry.url, label: entry.label }, entry.ops, state, c);
        }

        const note = String(args?.note ?? '').trim().slice(0, 40);
        const options = note ? { note } : {};
        let result;
        try {
          // 只传路径：协议端自己读盘，HTTP body 只有几十字节。
          // （20MB 图 base64 后 27MB，实测这个量级必撞发送超时。）
          result = await ctx.sender.sendImage(ctx.chatKey, { file: entry.file }, options);
        } catch (error) {
          // 路径读不到（协议端不在同一台机器 / 权限问题）才退回内联，且临时读盘
          try {
            const b64 = `base64://${fs.readFileSync(entry.file).toString('base64')}`;
            result = await ctx.sender.sendImage(ctx.chatKey, { dataUrl: b64 }, options);
          } catch (retryError) {
            return err(`发送失败：${human(error)}；内联重试也失败：${human(retryError)}`);
          }
        }
        state.sends += 1;
        // 发出去了：立刻删本地文件（图只在项目盘上停留这几秒）
        dropEntry(state, entry);
        // 记账：下一次搜图会自动避开它（默认 30 天）
        await markSent(entry.url);

        try {
          ctx.session?.sent?.push({
            type: 'image',
            text: `[图片${note ? `:${note}` : ''}]`,
            at: new Date().toLocaleTimeString('zh-CN', { hour12: false })
          });
          ctx.emit?.('session-update', ctx.session?.id);
        } catch { /* 会话统计失败不影响已发出的图 */ }

        return ok(`已发送 ${entry.width}×${entry.height}（${fmtSize(entry.bytes)}${entry.edited ? '，已处理' : '，原图未重编码'}）。本地文件已删除，不用复述图片内容。`);
      } catch (error) {
        return err(human(error));
      }
    }
  });

  api.registerTool({
    id: 'set_qq_avatar',
    name: '换机器人头像',
    description: '把一张图片设成机器人**自己账号**的 QQ 头像。只能改自己，不能改别人。必须先调用过 image-studio__edit_image 预览这张图（或带上预览返回的 token），否则会被拒绝。',
    category: 'media',
    icon: '🪞',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '图片 http(s) 直链；和 messageId 二选一' },
        messageId: { type: 'string', description: '当前聊天里某条带图消息的 id；和 url 二选一' },
        token: { type: 'string', description: '预览返回的 token（推荐）：直接用它做头像，带上处理效果' }
      },
      additionalProperties: false
    },
    async execute(ctx, args) {
      try {
        const c = cfg();
        if (c.allowAvatar === false) {
          return err('换头像已在技能设置的「允许换头像」里关闭。');
        }
        if (!ctx?.onebot) return err('拿不到 OneBot 客户端，换不了头像。');

        const state = stateOf(ctx);
        sweepPreviews(state);
        const token = String(args?.token ?? '').trim();
        const tokenEntry = token ? state.tokens.get(token) : null;

        let source = null;
        let bytes = null;
        let mime = null;

        if (tokenEntry) {
          try { bytes = fs.readFileSync(tokenEntry.file); } catch { bytes = null; }
          if (!bytes) return err('预览缓存已过期（或已发过），重新预览一次再换头像。');
          mime = tokenEntry.mime;
        } else {
          source = await resolveSource(ctx, args);
          if (requirePreview(c) && !state.previewedUrls.has(source.url)) {
            return err('换头像前先预览：先调 image-studio__edit_image 看一眼。');
          }
          const downloaded = await download(source.url, capBytesFor(source.url, c));
          bytes = downloaded.buffer;
          mime = downloaded.mime;
        }

        // 头像不需要原图：超过 4MB 就缩到长边 1024（质量 90），既快又不会撑爆上传
        if (bytes.length > 4 * 1024 * 1024) {
          const nativeImage = await nativeImageApi();
          try {
            const small = makePreview(nativeImage, bytes, mime, { maxSide: 1024, quality: 90 });
            bytes = small.buffer;
            mime = small.mime;
          } catch (error) {
            return err(`头像图片处理失败：${human(error)}`);
          }
        }
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) {
          return err(`这个格式（${mime}）不能当头像，换 png / jpg / webp 的图。`);
        }
        if (bytes.length > 4 * 1024 * 1024) {
          return err('头像图仍超过 4MB，换一张小点的。');
        }

        // 优先内联 base64：图已经在我们手里，协议端不用再去下载；
        // 失败再退回让协议端自己按 URL 取（少数协议端不认 base64 形态）。
        let firstError = null;
        try {
          await ctx.onebot.call('set_qq_avatar', { file: `base64://${bytes.toString('base64')}` }, 90000);
        } catch (error) {
          firstError = error;
          const fallback = source?.url || tokenEntry?.url;
          if (!fallback) {
            return err(`换头像失败：${human(firstError)}`);
          }
          try {
            await ctx.onebot.call('set_qq_avatar', { file: fallback }, 90000);
          } catch (secondError) {
            return err(`换头像失败：${human(firstError)}；换用链接再试也失败：${human(secondError)}`);
          }
        }

        // 头像换完，预览缓存也就没用了
        if (tokenEntry) dropEntry(state, tokenEntry);

        try {
          ctx.session?.sent?.push({
            type: 'profile',
            text: '[换头像]',
            at: new Date().toLocaleTimeString('zh-CN', { hour12: false })
          });
          ctx.emit?.('session-update', ctx.session?.id);
        } catch { /* 忽略统计失败 */ }

        return ok('QQ 已接受新头像（以客户端显示为准，可能有几分钟缓存）。');
      } catch (error) {
        return err(human(error));
      }
    }
  });
}

export function available() {
  return true;
}
