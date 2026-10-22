// 猪猪图片（pig-hub）—— 从 pighub.top 取猪猪图，先存本地、再发到当前会话。
//
// ── 这个模块为什么放在 plugins/ ───────────────────────────────────────────
// 按项目 README「扩展」一节的判据：规则能写死 → plugins/；要理解人话 → skills/。
// 本模块**注册的是工具**（registerTool），"什么时候该发猪猪图"由模型看语境决定，
// 所以它其实是 LLM 型；放进 plugins/ 也能正常加载（两种清单走同一条 normalizeManifest，
// 目录只决定语义分类）。放在这里是因为用户要求放在插件目录。
//
// ── 数据源 ───────────────────────────────────────────────────────────────
//   https://www.pighub.top/api/images?sort=N —— 免 Key、免鉴权。
//     sort=2 → 全量 + 随机序（网站首页默认）；sort=3 → 按下载热度。
//     形状：{ code, message, data: [ { id, title, filename, mtime,
//             view_count, download_count, image_url: "/images/xxx.webp" } ] }
//   实测 1361 条；图片直链在 /images/ 下，带 Referer + 浏览器 UA 才稳定 200。
//   实测踩过的坑：**Content-Type 报的是 image/jpeg，但文件其实是 RIFF/WEBP** ——
//   所以下面一律认魔数、不认 Content-Type，认不出就不发（宁可少发，不发裂图）。
//
// ── 本地优先（本模块的核心行为）──────────────────────────────────────────
//   第一次要某张图：下载到 data/pig-hub/images/<id>.<ext>，再从**本地文件**发出去。
//   以后再要同一张：直接发本地那份，**完全不联网**（省流量、也快，网站挂了也发得出）。
//
// ── 照 src/plugin-loader.js 的规矩 ────────────────────────────────────────
//   · 工具必须在 setup(api) 执行期间注册；写到别的函数里等于静默失效；
//   · promptSections 必须模块顶层 export（api 上没有注册提示词的方法）；
//   · 缓存/状态一律落在 DATA_DIR/pig-hub/ 下，绝不能用 process.cwd() 当锚点；
//   · 要联网就必须在 plugin.json 里声明 permissions: ["web_fetch"]，否则 api.fetch 只会 reject。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';
import { getSkillConfig } from '../../src/skills/config.js';

const PLUGIN_ID = 'pig-hub';
const SITE = 'https://www.pighub.top';
const API_URL = `${SITE}/api/images?sort=2`;
const SITE_NAME = 'PigHub';

/** 与 plugin.json 的 settings 保持一致（留一份是为了加载顺序与容错）。 */
const DEFAULTS = {
  enabled: true,
  maxCount: 1,
  maxPerHour: 6,
  maxPerDay: 30,
  prefer: 'random',
  dedupe: true,
  firstDownloadMax: 2,
  refreshHours: 6
};

const DIR = path.join(DATA_DIR, PLUGIN_ID);
const IMAGES_DIR = path.join(DIR, 'images');
const CATALOG_FILE = path.join(DIR, 'catalog.json');
const STATE_FILE = path.join(DIR, 'state.json');

/** 带真实 UA + Referer：这个站点对裸请求会拒（实测）。 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** 单次工具调用的下载预算：够试几张，又不至于把一轮对话拖死。 */
const DOWNLOAD_BUDGET_MS = 20000;
const MAX_BYTES = 12 * 1024 * 1024;

let cfg = () => ({ ...DEFAULTS });
let log = () => {};
let warn = () => {};
let httpFetch = null;

// ─────────────────────────────────────────────── 小工具
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, lo, hi, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

function clean(s, max = 200) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normText(s) {
  return String(s ?? '').toLowerCase().replace(/\s+/g, '');
}

function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    warn(`写盘失败（${path.basename(file)}）：${e?.message ?? e}`);
    return false;
  }
}

function abortAfter(ms) {
  return (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function')
    ? AbortSignal.timeout(ms)
    : undefined;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
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

// ─────────────────────────────────────────────── 图片识别（认魔数，不认 Content-Type）
function sniffSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { format: 'png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { format: 'gif', w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }
  if (buf[0] === 0x42 && buf[1] === 0x4d) {
    return { format: 'bmp', w: Math.abs(buf.readInt32LE(18)), h: Math.abs(buf.readInt32LE(22)) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) return sniffJpeg(buf);
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    return sniffWebp(buf);
  }
  return null;
}

function sniffJpeg(buf) {
  let p = 2;
  while (p + 9 < buf.length) {
    if (buf[p] !== 0xff) { p += 1; continue; }
    const marker = buf[p + 1];
    if (marker === 0xff) { p += 1; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
    const len = buf.readUInt16BE(p + 2);
    if (len < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { format: 'jpeg', h: buf.readUInt16BE(p + 5), w: buf.readUInt16BE(p + 7) };
    p += 2 + len;
  }
  return null;
}

function sniffWebp(buf) {
  const fourcc = buf.toString('latin1', 12, 16);
  try {
    if (fourcc === 'VP8X') {
      return {
        format: 'webp',
        w: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
        h: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16))
      };
    }
    if (fourcc === 'VP8 ') {
      for (let i = 20; i < Math.min(buf.length - 9, 40); i++) {
        if (buf[i] === 0x9d && buf[i + 1] === 0x01 && buf[i + 2] === 0x2a) {
          return {
            format: 'webp',
            w: buf.readUInt16LE(i + 3) & 0x3fff,
            h: buf.readUInt16LE(i + 5) & 0x3fff
          };
        }
      }
    }
    if (fourcc === 'VP8L') {
      const bits = buf.readUInt32LE(21);
      return { format: 'webp', w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
    }
  } catch { /* 结构异常就当认不出 */ }
  return null;
}

function extOfFormat(format) {
  return ({ jpeg: 'jpg', png: 'png', gif: 'gif', webp: 'webp', bmp: 'bmp' })[format] || 'img';
}

/** 列表里的编号：优先用站点 id，保持和网站上一致。 */
function idOf(entry) {
  return clean(entry?.id ?? '', 24) || clean(path.basename(String(entry?.url || ''), path.extname(String(entry?.url || ''))), 40);
}

// ─────────────────────────────────────────────── 图库清单
/** 内存缓存：{ at, fetchedAt, items:[{id,title,url,filename,mtime,downloads,views}] } */
let catalog = null;
let catalogPromise = null;

function ttlMs() {
  const h = num(cfg().refreshHours, DEFAULTS.refreshHours);
  return h > 0 ? h * 3600 * 1000 : Infinity;
}

function normalizeCatalog(json) {
  const raw = Array.isArray(json) ? json : (json?.data || json?.images || []);
  const items = [];
  const seen = new Set();
  for (const node of (Array.isArray(raw) ? raw : [])) {
    const rel = String(node?.image_url || node?.url || '').trim();
    if (!rel) continue;
    const url = /^https?:\/\//i.test(rel) ? rel : `${SITE}${rel.startsWith('/') ? '' : '/'}${rel}`;
    if (!isPublicHttpUrl(url)) continue;
    const id = idOf(node);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const filename = clean(node?.filename || '', 120);
    const title = clean(node?.title || filename.replace(/\.[a-z0-9]+$/i, ''), 60);
    const ext = (filename.match(/\.([a-z0-9]+)$/i) || [])[1] || '';
    items.push({
      id,
      title,
      filename: filename || `${id}.${ext || 'jpg'}`,
      url,
      ext,
      mtime: num(node?.mtime, 0),
      downloads: num(node?.download_count, 0),
      views: num(node?.view_count, 0)
    });
  }
  return { at: Date.now(), site: SITE, fetchedAt: new Date().toISOString(), count: items.length, items };
}

async function fetchCatalog() {
  if (typeof httpFetch !== 'function') throw new Error('没有网络权限（web_fetch）');
  const resp = await httpFetch(API_URL, {
    method: 'GET',
    redirect: 'follow',
    headers: { 'User-Agent': UA, Accept: 'application/json,*/*', Referer: `${SITE}/` },
    signal: abortAfter(15000)
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = await resp.json();
  const next = normalizeCatalog(json);
  if (!next.items.length) throw new Error('图库清单里没有可用条目');
  return next;
}

/**
 * 取图库清单：内存 → 网络 → 磁盘缓存，逐级降级。
 * 网络失败时**不报错**，只要有磁盘缓存就照常工作（本地已下载的图仍然发得出去）。
 */
async function loadCatalog({ force = false } = {}) {
  if (!force && catalog && catalog.items.length && (Date.now() - catalog.at) < ttlMs()) return catalog;
  if (catalogPromise) return catalogPromise;
  catalogPromise = (async () => {
    try {
      const fresh = await fetchCatalog();
      catalog = fresh;
      writeJson(CATALOG_FILE, fresh);
      log(`图库清单已刷新：${fresh.items.length} 张猪猪`);
      return catalog;
    } catch (e) {
      const disk = readJson(CATALOG_FILE, null);
      if (disk && Array.isArray(disk.items) && disk.items.length) {
        catalog = disk;
        warn(`图库清单刷新失败（${e?.message ?? e}），改用本地缓存（${disk.items.length} 张）`);
        return catalog;
      }
      throw new Error(`图库清单拿不到，本地也没有缓存：${e?.message ?? e}`);
    }
  })().finally(() => { catalogPromise = null; });
  return catalogPromise;
}

// ─────────────────────────────────────────────── 状态（额度 / 本会话发过哪几张）
function stateRead() {
  const s = readJson(STATE_FILE, null);
  if (!s || typeof s !== 'object') return { sent: [] };
  return { sent: Array.isArray(s.sent) ? s.sent : [] };
}

function stateWrite(s) {
  return writeJson(STATE_FILE, { sent: (s.sent || []).slice(-800) });
}

function sentIn(s, chatKey) {
  return (s.sent || []).filter((x) => x && x.chatKey === chatKey);
}

/** 按会话算额度：每小时 / 每天各自独立，取更紧的那个。 */
function quotaOf(s, chatKey) {
  const c = cfg();
  const mine = sentIn(s, chatKey);
  const today = dayKey();
  const since = Date.now() - 3600 * 1000;
  const perHour = Math.max(0, num(c.maxPerHour, DEFAULTS.maxPerHour));
  const perDay = Math.max(0, num(c.maxPerDay, DEFAULTS.maxPerDay));
  const usedHour = mine.filter((x) => num(x.ts, 0) >= since).length;
  const usedDay = mine.filter((x) => x.day === today).length;
  const leftHour = Math.max(0, perHour - usedHour);
  const leftDay = Math.max(0, perDay - usedDay);
  return { perHour, perDay, usedHour, usedDay, leftHour, leftDay, left: Math.min(leftHour, leftDay) };
}

function recordSent(chatKey, item, via) {
  const s = stateRead();
  s.sent.push({ ts: Date.now(), day: dayKey(), chatKey, id: item.id, title: clean(item.title, 40), via });
  stateWrite(s);
}

// ─────────────────────────────────────────────── 本地图片（下载 + 复用）
function localFileFor(id, ext) {
  return path.join(IMAGES_DIR, `${clean(id, 60)}.${clean(ext || 'jpg', 6)}`);
}

/** 本地已有的那份（任意扩展名都认，避免"扩展名猜错就当没有、重复下载"）。 */
function findLocal(id) {
  try {
    const base = clean(id, 60);
    for (const name of fs.readdirSync(IMAGES_DIR)) {
      if (name === base || name.startsWith(`${base}.`)) {
        const file = path.join(IMAGES_DIR, name);
        const st = fs.statSync(file);
        if (st.isFile() && st.size > 0) return { file, bytes: st.size };
      }
    }
  } catch { /* 目录不存在 = 本地没有 */ }
  return null;
}

/** 下载并校验一张图；失败抛错（调用方换下一张）。 */
async function downloadImage(url, timeoutMs) {
  if (typeof httpFetch !== 'function') throw new Error('没有网络权限（web_fetch）');
  const resp = await httpFetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'User-Agent': UA,
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Referer: `${SITE}/`
    },
    signal: abortAfter(timeoutMs)
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const declared = Number(resp.headers?.get?.('content-length') || 0);
  if (declared && declared > MAX_BYTES) throw new Error(`文件过大（${Math.round(declared / 1048576)}MB）`);

  const buf = Buffer.from(await resp.arrayBuffer());
  if (!buf.length) throw new Error('空响应');
  if (buf.length > MAX_BYTES) throw new Error(`文件过大（${Math.round(buf.length / 1048576)}MB）`);

  const size = sniffSize(buf);
  if (!size) {
    const head = buf.toString('latin1', 0, 24).replace(/[\x00-\x1f]/g, ' ').trim();
    throw new Error(`不是可识别的图片（开头是 ${JSON.stringify(head)}）`);
  }
  if (!size.w || !size.h) throw new Error('尺寸异常');
  if (size.w > 20000 || size.h > 20000) throw new Error(`尺寸异常（${size.w}x${size.h}）`);
  return { buf, w: size.w, h: size.h, format: size.format, bytes: buf.length };
}

function saveLocal(buf, id, format) {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  const file = localFileFor(id, extOfFormat(format));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
  return file;
}

/**
 * 拿到一张可发送的本地文件：**本地优先**，没有才联网下载。
 * @returns {{file, bytes, w?, h?, format?, local: boolean}}
 */
async function ensureLocal(item, { download, timeoutMs }) {
  const hit = findLocal(item.id);
  if (hit) return { ...hit, local: true };
  if (!download) return null;
  const d = await downloadImage(item.url, timeoutMs);
  const file = saveLocal(d.buf, item.id, d.format);
  return { file, bytes: d.bytes, w: d.w, h: d.h, format: d.format, local: false };
}

// ─────────────────────────────────────────────── 选图
/**
 * 从清单里挑候选：关键词过滤 → 挑图偏好 → 本会话去重。
 * 去重只影响顺序（发过 的排最后），所以永远不会"因为都发过就发不出图"。
 */
function pickCandidates(cat, { keyword, chatKey, want }) {
  const c = cfg();
  const kw = normText(keyword);
  let pool = cat.items;
  let note = '';

  if (kw) {
    const hit = pool.filter((it) => normText(it.title).includes(kw) || normText(it.filename).includes(kw));
    if (hit.length) pool = hit;
    else note = `图库里没有标题带「${clean(keyword, 20)}」的猪猪，从全部猪猪里挑。`;
  }

  const prefer = String(c.prefer || DEFAULTS.prefer);
  let ordered;
  if (prefer === 'new') ordered = pool.slice().sort((a, b) => num(b.mtime, 0) - num(a.mtime, 0));
  else if (prefer === 'popular') ordered = pool.slice().sort((a, b) => num(b.downloads, 0) - num(a.downloads, 0));
  else ordered = shuffle(pool); // random：接口本身就是随机序，再打散一次避免总拿前几张

  if (prefer === 'random' && kw && ordered.length > 40) ordered = ordered.slice(0, 40);

  const dedupe = c.dedupe !== false;
  const mine = new Set(dedupe ? sentIn(stateRead(), chatKey).map((x) => String(x.id)) : []);
  const fresh = ordered.filter((it) => !mine.has(String(it.id)));
  const items = (fresh.length ? fresh : ordered).slice(0, Math.max(1, want) * 6);
  return { items, note, exhausted: dedupe && !fresh.length && ordered.length > 0 };
}

// ─────────────────────────────────────────────── 发送
/**
 * 逐张"确保本地有 → 发本地文件"。联网下载的张数受 firstDownloadMax 限制，
 * 本地已有的图直接发、不占下载额度。
 */
async function sendItems(ctx, items, { want, why }) {
  const c = cfg();
  const downloadMax = clamp(c.firstDownloadMax ?? DEFAULTS.firstDownloadMax, 0, 5, DEFAULTS.firstDownloadMax);
  const deadline = Date.now() + DOWNLOAD_BUDGET_MS;

  const sent = [];
  const errors = [];
  let downloads = 0;
  let reused = 0;

  for (const item of items) {
    if (sent.length >= want) break;

    const localHit = findLocal(item.id);
    if (!localHit && downloads >= downloadMax) {
      errors.push(`${item.id}：本轮联网下载额度用完（本地也没有）`);
      continue;
    }
    if (!localHit && Date.now() > deadline) {
      errors.push('超出本轮下载时限');
      break;
    }

    let got = null;
    try {
      got = await ensureLocal(item, {
        download: !localHit,
        timeoutMs: Math.min(8000, Math.max(1500, deadline - Date.now()))
      });
    } catch (e) {
      errors.push(`${item.id}: ${String(e?.message ?? e).slice(0, 60)}`);
      continue;
    }
    if (!got) continue;
    if (!localHit) downloads += 1;
    else reused += 1;

    try {
      await ctx.sender.sendImage(ctx.chatKey, { file: got.file }, { note: why || `${SITE_NAME}猪猪图` });
      sent.push({ item, ...got });
      recordSent(ctx.chatKey, item, got.local ? 'local' : 'download');
      log(`已发送 ${item.id}（${got.local ? '本地缓存' : `新下载 ${Math.round((got.bytes || 0) / 1024)}KB`}）`);
    } catch (e) {
      errors.push(`发送失败：${String(e?.message ?? e).slice(0, 80)}`);
    }
  }
  return { sent, errors, downloads, reused };
}

/** 与内置发送工具保持一致：记进会话，让控制台会话页能看到这条图。 */
function noteToSession(ctx, sent) {
  if (!sent.length) return;
  try {
    for (const s of sent) {
      ctx.session?.sent?.push({
        type: 'image',
        text: `[图片:${SITE_NAME} ${s.item.title || s.item.id}${s.local ? '（本地）' : ''}]`,
        at: new Date().toLocaleTimeString('zh-CN', { hour12: false })
      });
    }
    ctx.emit?.('session-update', ctx.session?.id);
  } catch { /* 留档失败不影响发送结果 */ }
}

// ─────────────────────────────────────────────── 工具实现
async function doSendPig(ctx, args) {
  const c = cfg();
  if (c.enabled === false) {
    return { content: '错误：猪猪图片这个插件已经被关掉了，现在不能发图。', isError: true };
  }
  if (!ctx?.sender?.sendImage) {
    return { content: '错误：当前环境拿不到发送图片的能力，这张先不发了。', isError: true };
  }
  if (!ctx?.chatKey) {
    return { content: '错误：不知道要发到哪个会话。', isError: true };
  }

  const keyword = clean(args?.keyword ?? '', 40);
  const pick = clean(args?.pick ?? args?.id ?? '', 24).replace(/^#/, '');
  const why = clean(args?.why ?? '', 60);
  const cap = clamp(c.maxCount ?? DEFAULTS.maxCount, 1, 3, DEFAULTS.maxCount);
  const want = clamp(args?.count ?? cap, 1, cap, 1);

  const quota = quotaOf(stateRead(), ctx.chatKey);
  if (quota.left <= 0) {
    const whyQ = quota.leftDay <= 0
      ? `这个会话今天已经发了 ${quota.perDay} 张`
      : `这个会话这个小时已经发了 ${quota.perHour} 张`;
    return { content: `错误：${whyQ}，先不发了（等一会儿再说）。这一轮不要重试。`, isError: true };
  }

  let cat;
  try {
    cat = await loadCatalog();
  } catch (e) {
    return { content: `错误：猪猪图库现在拿不到（${e?.message ?? e}）。请只回一句“猪猪图这会儿连不上”，不要编造图片。`, isError: true };
  }

  let candidates;
  let note = '';
  if (pick) {
    const hit = cat.items.find((it) => it.id === pick);
    if (!hit) {
      return {
        content: `错误：图库里没有编号 ${pick} 这张猪猪。可以先用 pig-hub__list_pigs 列一下候选再挑。`,
        isError: true
      };
    }
    candidates = [hit];
  } else {
    const picked = pickCandidates(cat, { keyword, chatKey: ctx.chatKey, want });
    candidates = picked.items;
    note = picked.note || '';
    if (picked.exhausted) note = `${note}（本会话已经把可选项发完了，这一张是重复使用）`.trim();
  }

  if (!candidates.length) {
    return {
      content: `错误：图库里没找到可发的猪猪${keyword ? `（关键词：${keyword}）` : ''}。换个关键词再试一次；不要编造图片。`,
      isError: true
    };
  }

  const { sent, errors, downloads, reused } = await sendItems(ctx, candidates, {
    want: Math.min(want, quota.left),
    why
  });

  if (!sent.length) {
    const detail = errors.slice(0, 3).join('；') || '所有候选图都下载/发送失败';
    return {
      content: `错误：这次一张都没发出去（${detail}）。请只回一句“猪猪图这会儿发不出去，稍后再试”，不要编造。`,
      isError: true
    };
  }

  noteToSession(ctx, sent);

  const after = quotaOf(stateRead(), ctx.chatKey);
  const head = sent.map((s) => {
    const size = s.w && s.h ? `（${s.w}x${s.h} ${s.format || ''}）`.replace(' ）', '）') : '';
    return `#${s.item.id} ${s.item.title}${size}｜${s.local ? '本地缓存' : '本次新下载到本地'}`;
  });
  const lines = [
    `已发出 ${sent.length} 张「${SITE_NAME}」猪猪图：`,
    ...head.map((h) => `  - ${h}`)
  ];
  if (note) lines.push(`（${note}）`);
  lines.push(`来源统计：本地缓存 ${reused} 张、本次新下载 ${downloads} 张（下载后已存到本机，下次直接用本地）。`);
  lines.push(`本会话今天还剩 ${after.leftDay} 张额度，这个小时还剩 ${after.leftHour} 张。`);
  lines.push('接下来：不要在回复里描述或复述图里画的是什么；顺着话头说一句就行，别硬解释。');
  return { content: lines.join('\n') };
}

async function doListPigs(ctx, args) {
  const c = cfg();
  if (c.enabled === false) {
    return { content: '错误：猪猪图片这个插件已经被关掉了。', isError: true };
  }
  const keyword = clean(args?.keyword ?? '', 40);
  const limit = clamp(args?.limit ?? 8, 1, 15, 8);

  let cat;
  try {
    cat = await loadCatalog();
  } catch (e) {
    return { content: `错误：猪猪图库现在拿不到（${e?.message ?? e}）。请只回一句“猪猪图库这会儿连不上”。`, isError: true };
  }

  const cached = (() => {
    try { return new Set(fs.readdirSync(IMAGES_DIR).map((n) => n.replace(/\.[a-z0-9]+$/i, ''))); } catch { return new Set(); }
  })();

  const lines = [`「${SITE_NAME}」图库共 ${cat.items.length} 张猪猪（清单更新于 ${clean(cat.fetchedAt, 30) || '未知'}）。`];
  lines.push(`本机已下载 ${cached.size} 张（这些直接发本地文件，不用联网）。`);

  const picked = pickCandidates(cat, { keyword, chatKey: ctx?.chatKey || '', want: limit });
  const items = picked.items.slice(0, limit);
  if (!items.length) {
    lines.push('', `没有找到贴「${keyword}」的猪猪。换个词再试。`);
    return { content: lines.join('\n') };
  }

  lines.push('', keyword ? `贴「${keyword}」的候选：` : '随机候选：');
  for (const it of items) {
    const mark = cached.has(String(it.id)) ? '［本地已有］' : '';
    lines.push(`  - 编号=${it.id}｜${it.title}${mark}`);
  }
  if (picked.note) lines.push(`（${picked.note}）`);
  lines.push('', '把选中的编号填进 pig-hub__send_pig 的 pick 参数即可发出。');
  return { content: lines.join('\n') };
}

async function doPigStats() {
  const c = cfg();
  const cat = catalog && catalog.items.length ? catalog : readJson(CATALOG_FILE, null);
  let images = 0;
  let bytes = 0;
  try {
    for (const name of fs.readdirSync(IMAGES_DIR)) {
      try {
        const st = fs.statSync(path.join(IMAGES_DIR, name));
        if (st.isFile()) { images += 1; bytes += st.size; }
      } catch { /* 单个文件失败忽略 */ }
    }
  } catch { /* 目录不存在 = 0 张 */ }

  const s = stateRead();
  const lines = [
    `【${SITE_NAME} 猪猪图 状态】`,
    `· 图库清单：${cat?.items?.length ? `${cat.items.length} 张` : '还没有（第一次发图时会自动拉取）'}`,
    `· 本机已缓存：${images} 张，共 ${(bytes / 1048576).toFixed(1)} MB`,
    `· 缓存目录：${IMAGES_DIR}`,
    `· 额度设置：一次最多 ${clamp(c.maxCount ?? 1, 1, 3, 1)} 张；每会话 ${num(c.maxPerHour, 6)} 张/小时、${num(c.maxPerDay, 30)} 张/天`,
    `· 挑图偏好：${clean(c.prefer || 'random', 10)}；同一会话不重发同一张：${c.dedupe !== false ? '开' : '关'}`,
    `· 累计发送记录：${s.sent.length} 条`
  ];
  return { content: lines.join('\n') };
}

// ─────────────────────────────────────────────── 提示词
export function promptSections() {
  try {
    const c = cfg();
    if (c.enabled === false) return [];
    const known = catalog && catalog.items.length ? `${catalog.items.length} 张` : '未知（首次发图时自动拉取）';
    const lines = [`【${SITE_NAME}猪猪图库】共 ${known}，图会先从本机缓存发；本机没有的才联网下载并缓存下来。`];
    lines.push(`默认每次最多 ${clamp(c.maxCount ?? 1, 1, 3, 1)} 张，同一会话不重发同一张（${c.dedupe !== false ? '开' : '关'}）。`);
    lines.push('有人点名要猪猪图、或你自己的话配一张猪猪正合适时才发；没合适的别硬凑。');
    return [{
      id: `${PLUGIN_ID}-library`,
      title: `${SITE_NAME}猪猪图库`,
      priority: 46,
      content: lines.join('\n')
    }];
  } catch (e) {
    warn(`生成图库提示失败：${e?.message ?? e}`);
    return [];
  }
}

// ─────────────────────────────────────────────── 入口
export function setup(api) {
  log = api?.log || (() => {});
  warn = api?.warn || (() => {});
  httpFetch = typeof api?.fetch === 'function' ? api.fetch : null;

  cfg = () => {
    try {
      return { ...DEFAULTS, ...(typeof api?.config === 'function' ? (api.config() || {}) : {}) };
    } catch {
      return { ...DEFAULTS };
    }
  };

  try { fs.mkdirSync(IMAGES_DIR, { recursive: true }); } catch (e) { warn(`缓存目录建不出来：${e?.message ?? e}`); }

  const c = cfg();
  log(
    `猪猪图片已加载：一次最多 ${clamp(c.maxCount ?? 1, 1, 3, 1)} 张；每会话 `
    + `${num(c.maxPerHour, DEFAULTS.maxPerHour)} 张/小时、${num(c.maxPerDay, DEFAULTS.maxPerDay)} 张/天；`
    + `缓存放在 data/${PLUGIN_ID}/images/`
  );
  if (!httpFetch) {
    warn('没有声明 web_fetch 权限，拿不到网络能力 —— 本机没缓存的图会下载失败。请检查 plugin.json 的 permissions。');
  }

  // 工具必须在 setup 执行期间注册（loader 只认这个时机注册的工具）
  api.registerTool({
    id: 'send_pig',
    name: '发猪猪图',
    description:
      '从「PigHub」（pighub.top）挑猪猪图直接发到当前会话（一步到位，不用再调别的发送工具）。'
      + '图先从本机缓存发：本地没有的会先下载下来存到本机，下次直接用本地那份。'
      + '什么时候用：① 群友要猪猪图（“来张猪猪”“发个猪图”“来点猪”“有没有搞笑的猪”），keyword 从对方原话里提炼；'
      + '② 你自己这句话有明显情绪、配一张猪猪正好替你把话说完。不是每条消息都要发图 —— 没合适的就别调。'
      + '想让群友先挑，就先用 pig-hub__list_pigs 列候选，对方点了哪张再把编号填进 pick。',
    category: 'sticker',
    icon: '🐖',
    requiresVision: false,
    parameters: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: '可选，标题关键词，例如“搞笑”“可爱”“生气”“摸鱼”。不填就从全库按设置里的偏好随机挑。'
        },
        pick: {
          type: 'string',
          description: '可选，指定编号（群友点图用）。编号来自 pig-hub__list_pigs 返回的「编号=xxx」。'
        },
        count: {
          type: 'number',
          description: '可选，发几张，1~3，默认按设置（通常 1）。'
        },
        why: {
          type: 'string',
          description: '可选，一句话说明为什么这张贴切（只用于记录，不发给群友）。'
        }
      }
    },
    async execute(ctx, args) {
      return doSendPig(ctx, args);
    }
  });

  api.registerTool({
    id: 'list_pigs',
    name: '翻猪猪图库',
    description:
      '只列候选、不发送：返回若干张猪猪图（编号 + 标题，已经缓存在本机的会标出来）。'
      + '用途：群友想先看看再挑一张的时候，用这个列出候选，对方点了哪张，再把那张编号交给 pig-hub__send_pig 的 pick 发出去。',
    category: 'sticker',
    icon: '🐖',
    requiresVision: false,
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '可选，标题关键词；不填就随机列几张。' },
        limit: { type: 'integer', description: '可选，最多列几条，1~15，默认 8。' }
      }
    },
    async execute(ctx, args) {
      return doListPigs(ctx, args);
    }
  });

  api.registerTool({
    id: 'pig_stats',
    name: '猪猪图状态',
    description:
      '看看猪猪图插件现在什么情况：图库一共多少张、本机已经缓存了多少张（占多大）、缓存在哪个目录、'
      + '当前的额度设置（一次最多几张、每会话每小时/每天几张）、挑图偏好，以及累计发送条数。群友问“你图库有多少图”时也可以用它回答。',
    category: 'sticker',
    icon: '📊',
    requiresVision: false,
    parameters: { type: 'object', properties: {} },
    async execute() {
      return doPigStats();
    }
  });

  // 预热图库清单（不 await —— 不能因为它拖慢启动；失败静默，发图时会再试）
  try {
    Promise.resolve(loadCatalog()).catch(() => {});
  } catch { /* 忽略 */ }
}

/** 状态页展示：拿得到网络能力、且没被设置关掉，就算可用。 */
export function available() {
  const c = cfg();
  if (c.enabled === false) return { ok: false, reason: '在设置里被关掉了' };
  if (typeof httpFetch !== 'function') return { ok: false, reason: '未声明 web_fetch 权限，无法下载新图（本地已缓存的图仍可发）' };
  return { ok: true };
}

/** 卸载/关闭时清掉内存缓存（加载器支持 dispose）。 */
export function dispose() {
  catalog = null;
  catalogPromise = null;
}
