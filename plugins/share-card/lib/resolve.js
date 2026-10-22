// 分享链接「打开网页读正文」的各平台解析器。
//
// 设计原则：
//   1) **没有一家平台的私有接口是必须的** —— 每个平台都先试自己的接口，失败一律退回
//      通用的 og: 元信息解析。这样接口变了不会整个功能失效，只是回退成"标题+摘要"。
//   2) 解析器只做纯 HTTP，不碰 core、不碰 onebot。抓回来的东西统一裁剪成短文本。
//   3) 所有网络调用都带超时；任何异常都收敛成 { ok:false, error }，绝不外抛。
//
// 返回结构（统一）：
//   { ok, platform, url(最终地址), title, author, text, stats, images[], via }

import { detectPlatform } from './card.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const MAX_HTML = 900 * 1024;

// 米游社的 bbs-api 不带头就 403；这几个头是它认的最小集合。
const MIYOUSHE_HEADERS = {
  referer: 'https://www.miyoushe.com/',
  'x-rpc-app_version': '2.71.1',
  'x-rpc-client_type': '4',
  'x-rpc-language': 'zh-cn'
};

/** 平台 id → 中文名（写进给模型看的文本里，比英文 id 好读）。 */
const PLATFORM_LABEL = {
  bilibili: 'B站',
  douyin: '抖音',
  miyoushe: '米游社',
  tieba: '贴吧',
  'qq-channel': 'QQ频道',
  'qq-video': '腾讯视频',
  kuaishou: '快手',
  xiaohongshu: '小红书',
  tajiduo: '塔吉多',
  kurobbs: '库街区',
  skland: '森空岛',
  generic: '网页'
};

export function platformLabel(name) {
  return PLATFORM_LABEL[String(name || '')] || String(name || '网页');
}

/**
 * 站点外壳页的识别用特征词。
 * 起因：库街区/森空岛/快手这些站对未登录访问会返回「JS 外壳」，外壳里**也有** og 元信息，
 * 但内容是站点自我介绍（「森空岛是鹰角网络官方社区…」「快手是一款国民级短视频App…」）。
 * 若把它当成正文，模型会以为帖子内容就是这句广告 —— 比直接说「读不到」更糟。
 */
const SHELL_PROMO = {
  skland: /森空岛|skland/i,
  kurobbs: /库街区|库洛游戏|kuro/i,
  kuaishou: /快手/,
  xiaohongshu: /小红书/
};

/** 判定「读到的是不是站点外壳页」：标题只有站点名、且描述就是站点自我介绍。 */
function shellPage(platform, meta) {
  const title = String(meta?.title || '').trim();
  const desc = String(meta?.desc || '').trim();
  const promo = SHELL_PROMO[platform];
  const titleIsSite = !title || (!!promo && promo.test(title));
  const descIsPromo = !!desc && !!promo && promo.test(desc.slice(0, 60));
  return { titleIsSite, descIsPromo, shell: (titleIsSite && descIsPromo) || (titleIsSite && !meta?.desc) };
}

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) => {
      const code = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&amp;/g, '&');
}

function squash(s, max = 1200) {
  return decodeEntities(String(s ?? ''))
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** 米游社帖子的 content 有时是一段 JSON（{"describe":"…","imgs":[…] }），扒成人话。 */
function unwrapJsonText(raw) {
  const s = String(raw ?? '').trim();
  if (!s.startsWith('{') && !s.startsWith('[')) return squash(s, 900);
  try {
    const obj = JSON.parse(s);
    const bits = [];
    const walk = (v, depth) => {
      if (depth > 3 || v == null) return;
      if (typeof v === 'string') { const t = squash(v, 400); if (t && !/^https?:/i.test(t)) bits.push(t); return; }
      if (Array.isArray(v)) { v.slice(0, 6).forEach((x) => walk(x, depth + 1)); return; }
      if (typeof v === 'object') { for (const k of ['describe', 'text', 'content', 'title', 'desc']) walk(v[k], depth + 1); }
    };
    walk(obj, 0);
    const joined = [...new Set(bits)].join(' / ').trim();
    if (joined) return joined.slice(0, 900);
  } catch { /* 不是 JSON，按纯文本处理 */ }
  return squash(s, 900);
}

/**
 * SPA 页面里捞正文：QQ频道 / 腾讯视频 / 森空岛这类站首屏 HTML 把数据塞在一段 JSON 里，
 * 没有 og 也没有像样的 <title>。这里扫所有「比较长的字符串字面量」，按中文字数挑最像正文的一条。
 * 宁可不返回，也不往上下文里灌垃圾 —— 所以过滤掉 URL、纯 ASCII／base64、代码片段。
 */
function pickBodyText(html, { minCjk = 16, max = 800 } = {}) {
  let best = '';
  let bestCjk = 0;
  for (const m of String(html).matchAll(/"([^"\\]{24,1500})"/g)) {
    const raw = m[1];
    if (/^(https?:|\/\/|\/|data:|#)/.test(raw)) continue;
    if (/^[A-Za-z0-9+/=_.-]{24,}$/.test(raw)) continue;
    if (/(?:function\s|=>\s*\{|;\s*$|\{\s*"|rgba?\(|\d+px)/.test(raw)) continue;
    const text = squash(raw, max);
    const cjk = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    if (cjk < minCjk || cjk <= bestCjk) continue;
    best = text;
    bestCjk = cjk;
  }
  return best;
}

// 反爬 / 风控页识别。这类页面「长得像正常网页」——有 <title>、有正文，
// 但内容全是「百度安全验证」之类；若当成成功，模型会以为帖子标题就叫「百度安全验证」，
// 比直接报「打不开」更糟。所以宁可拒绝，也不给假信息。
const BLOCK_TITLE_RE = /(百度安全验证|安全验证|请输入验证码|请完成验证|访问过于频繁|请求过于频繁|Access Denied|Attention Required|Just a moment|403 Forbidden|网页无法访问|页面不存在)/i;
const BLOCK_BODY_RE = /(百度安全验证|cf-browser-verification|challenge-platform|__cf_chl)/i;

/** 从 HTML 里挖 og: / twitter: / <title> / description。 */
export function metaFromHtml(html) {
  const out = { title: '', desc: '', site: '', images: [] };
  const grab = (re) => {
    const m = html.match(re);
    return m ? decodeEntities(m[1] ?? m[2] ?? '') : '';
  };
  out.title = grab(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i)
    || grab(/<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:title["']/i)
    || grab(/<title[^>]*>([\s\S]*?)<\/title>/i);
  out.desc = grab(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i)
    || grab(/<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:description["']/i)
    || grab(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i);
  out.site = grab(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']*)["']/i);
  for (const m of html.matchAll(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']*)["']/gi)) {
    if (out.images.length < 4) out.images.push(decodeEntities(m[1]));
  }
  const title = squash(out.title, 200);
  const blocked = BLOCK_TITLE_RE.test(title) || BLOCK_BODY_RE.test(html.slice(0, 8000));
  return { title, desc: squash(out.desc, 1200), site: squash(out.site, 60), images: out.images, blocked };
}

/** 判定一次解析结果是不是「反爬页伪装的成功」。命中返回 `{error}`，否则 null。 */
function judgeBlocked(r) {
  if (!r) return null;
  const title = String(r.title || '');
  const probe = String(r.text || '').slice(0, 500);
  if (r.blocked || BLOCK_TITLE_RE.test(title) || BLOCK_BODY_RE.test(probe)) {
    return { error: `被网站反爬拦截（${title || '安全验证页'}）` };
  }
  return null;
}

async function readText(fetchImpl, url, { timeoutMs, headers = {}, redirect = 'follow', cookie = '' } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      redirect,
      signal: ac.signal,
      headers: {
        'user-agent': UA,
        'accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9',
        ...(cookie ? { cookie } : {}),
        ...headers
      }
    });
    const status = res.status;
    const finalUrl = res.url || url;
    const buf = Buffer.from(await res.arrayBuffer());
    return { status, finalUrl, location: res.headers.get('location') || '', text: buf.subarray(0, MAX_HTML).toString('utf8'), bytes: buf.length, contentType: res.headers.get('content-type') || '' };
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(fetchImpl, url, { timeoutMs, headers = {} } = {}) {
  const r = await readText(fetchImpl, url, { timeoutMs, headers: { accept: 'application/json, text/plain, */*', ...headers } });
  if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
  return { ...r, json: JSON.parse(r.text) };
}

/**
 * 短链展开：**手动重定向**只读 Location 响应头，绝不去抓那页 HTML。
 * 原因：b23.tv / v.douyin.com 的落地页带风控，直接 GET 会 412，而 302 本身是干净的。
 */
async function expandShort(fetchImpl, url, timeoutMs, tries = []) {
  const candidates = [url, ...tries];
  for (const u of candidates) {
    try {
      const r = await readText(fetchImpl, u, { timeoutMs, redirect: 'manual' });
      const loc = r.location;
      if (loc) return loc.startsWith('//') ? `https:${loc}` : loc;
    } catch { /* 换下一种写法 */ }
  }
  return '';
}

function pickBvid(s) {
  return (String(s).match(/\/video\/(BV[0-9A-Za-z]+)/) || [])[1]
    || (String(s).match(/\b(BV[0-9A-Za-z]{10})\b/) || [])[1]
    || (String(s).match(/[?&]bvid=(BV[0-9A-Za-z]+)/) || [])[1]
    || '';
}

function fmtDuration(sec) {
  const n = Number(sec) || 0;
  if (!n) return '';
  const m = Math.floor(n / 60);
  const s = n % 60;
  return `${m}分${String(s).padStart(2, '0')}秒`;
}

function fmtCount(n) {
  const v = Number(n) || 0;
  if (v >= 100000000) return `${(v / 100000000).toFixed(1)}亿`;
  if (v >= 10000) return `${(v / 10000).toFixed(1)}万`;
  return String(v);
}

// ── B站 ────────────────────────────────────────────────────────────────────
async function bilibili(url, ctx) {
  const { fetchImpl, timeoutMs } = ctx;
  let finalUrl = url;
  let bvid = pickBvid(url);
  if (!bvid) {
    const expanded = await expandShort(fetchImpl, url, timeoutMs, [
      url.replace(/^https?:\/\/b23\.tv/i, 'https://www.bilibili.com'),
      url.replace(/^https?:\/\/(b23\.tv|bili2233\.cn)/i, 'https://m.bilibili.com')
    ]);
    if (expanded) { finalUrl = expanded; bvid = pickBvid(expanded); }
  }
  if (bvid) {
    try {
      // 注意：api.bilibili.com **带 Referer 反而 412**，必须裸请求 —— 实测确认过。
      const r = await readJson(fetchImpl, `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { timeoutMs });
      const d = r.json?.data;
      if (r.json?.code === 0 && d) {
        const stats = `播放 ${fmtCount(d.stat?.view)} · 弹幕 ${fmtCount(d.stat?.danmaku)} · 点赞 ${fmtCount(d.stat?.like)}`;
        const text = [
          `UP主：${d.owner?.name || '?'}`,
          d.tname ? `分区：${d.tname}` : '',
          d.duration ? `时长：${fmtDuration(d.duration)}` : '',
          d.pubdate ? `发布：${new Date(Number(d.pubdate) * 1000).toLocaleDateString('zh-CN')}` : '',
          d.desc ? `简介：${squash(d.desc, 500)}` : ''
        ].filter(Boolean).join('\n');
        // 展示用链接要收敛成干净的规范地址：短链展开后那条 URL 带一长串埋点参数，灌给模型只是噪音。
        return { ok: true, platform: 'bilibili', url: `https://www.bilibili.com/video/${bvid}`, title: d.title || '', author: d.owner?.name || '', text, stats, images: [d.pic].filter(Boolean), via: 'api/view' };
      }
    } catch { /* 回退 og */ }
  }
  // 动态 / 专栏 / 番剧 / 小游戏：退回 og。短链不要抓（会 412），直接放弃。
  if (/b23\.tv|bili2233\.cn/i.test(finalUrl)) {
    return { ok: false, platform: 'bilibili', url: finalUrl, error: '短链没能展开成视频地址' };
  }
  const r = await readText(fetchImpl, finalUrl, { timeoutMs, cookie: String(ctx.cookies?.bilibili || '').trim() });
  const meta = metaFromHtml(r.text);
  const extra = (() => {
    const m = r.text.match(/__INITIAL_STATE__\s*=\s*(\{[\s\S]{0,20000}?\})\s*;/) || r.text.match(/window\.__playinfo__\s*=\s*(\{[\s\S]{0,20000}?\})\s*;?/);
    return m ? '' : '';
  })();
  return { ok: !!meta.title, platform: 'bilibili', url: r.finalUrl, title: meta.title, author: '', text: meta.desc + extra, stats: '', images: meta.images, via: 'og' };
}

// ── 抖音 ──────────────────────────────────────────────────────────────────
async function douyin(url, ctx) {
  const { fetchImpl, timeoutMs } = ctx;
  const cookie = String(ctx.cookies?.douyin || '').trim();
  let finalUrl = url;
  let id = (url.match(/\/(?:video|note|slides|share\/video)\/(\d{6,})/) || [])[1] || '';
  if (!id) {
    const expanded = await expandShort(fetchImpl, url, timeoutMs);
    if (expanded) {
      finalUrl = expanded;
      id = (expanded.match(/\/(?:video|note|slides)\/(\d{6,})/) || [])[1]
        || (expanded.match(/[?&](?:vid|aweme_id|modal_id)=(\d{6,})/) || [])[1] || '';
    }
  }
  if (id) {
    try {
      const r = await readJson(fetchImpl, `https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=${id}`, { timeoutMs, headers: { referer: 'https://www.douyin.com/', ...(cookie ? { cookie } : {}) } });
      const it = r.json?.item_list?.[0];
      if (it) {
        const stats = `点赞 ${fmtCount(it.statistics?.digg_count)} · 评论 ${fmtCount(it.statistics?.comment_count)} · 收藏 ${fmtCount(it.statistics?.collect_count)}`;
        const text = [
          `作者：${it.author?.nickname || '?'}`,
          it.desc ? `文案：${squash(it.desc, 500)}` : '',
          it.video?.duration ? `时长：${fmtDuration(Math.round(it.video.duration / 1000))}` : ''
        ].filter(Boolean).join('\n');
        return { ok: true, platform: 'douyin', url: finalUrl, title: squash(it.desc, 120), author: it.author?.nickname || '', text, stats, images: [it.video?.cover?.url_list?.[0]].filter(Boolean), via: 'iesdouyin/iteminfo' };
      }
    } catch { /* 接口常被封，退回 og */ }
  }
  if (/v\.douyin\.com|douyin\.com\/share/i.test(finalUrl)) {
    return { ok: false, platform: 'douyin', url: finalUrl, error: '抖音短链没能展开成视频地址（接口风控）' };
  }
  const r = await readText(fetchImpl, finalUrl, { timeoutMs, cookie });
  const meta = metaFromHtml(r.text);
  return { ok: !!meta.title, platform: 'douyin', url: r.finalUrl, title: meta.title, author: '', text: meta.desc, stats: '', images: meta.images, via: 'og' };
}

// ── 米游社 ────────────────────────────────────────────────────────────────
function pickMiyoushePostId(url) {
  const s = String(url);
  return (s.match(/\/article\/(\d+)/) || [])[1]
    || (s.match(/\/post\/(\d+)/) || [])[1]
    || (s.match(/#\/article\/(\d+)/) || [])[1]
    || (s.match(/[?&]post_id=(\d+)/) || [])[1]
    || (s.match(/\/(\d{6,})(?:[/?#]|$)/) || [])[1]
    || '';
}

/**
 * 米游社热评。
 * 实测（2026-10-01）：`getPostReplies` **只认 `order=2&is_hot=true`** ——
 * `order=1` 或不传 order 一律返回 `{"data":null,"message":"不支持的排序类型","retcode":-1}`。
 * 返回 `{ lines, total }`：lines 是排好序的短文本，total 是帖子总回复数。
 */
async function miyousheReplies(fetchImpl, postId, timeoutMs, size = 8) {
  try {
    const r = await readJson(
      fetchImpl,
      `https://bbs-api.miyoushe.com/post/wapi/getPostReplies?post_id=${postId}&size=${size}&last_id=0&order=2&is_hot=true`,
      { timeoutMs, headers: MIYOUSHE_HEADERS }
    );
    const list = r.json?.data?.list || [];
    const total = Number(r.json?.data?.total_reply_num) || 0;
    const lines = list.map((c) => {
      const body = squash(c?.reply?.content, 200);
      if (!body) return '';
      const who = c?.user?.nickname || '?';
      const like = Number(c?.stat?.like_num) || 0;
      const sub = Number(c?.sub_reply_count) || 0;
      const floor = Number(c?.reply?.floor_id) || 0;
      return `· ${who}${floor ? `（${floor} 楼）` : ''}${like ? `（赞 ${fmtCount(like)}）` : ''}：${body}${sub ? `　〔还有 ${sub} 条楼中楼〕` : ''}`;
    }).filter(Boolean);
    return { lines, total };
  } catch {
    return { lines: [], total: 0 };
  }
}

async function miyoushe(url, ctx) {
  const { fetchImpl, timeoutMs } = ctx;
  const postId = pickMiyoushePostId(url);
  if (postId) {
    try {
      const r = await readJson(fetchImpl, `https://bbs-api.miyoushe.com/post/wapi/getPostFull?post_id=${postId}&read=1`, {
        timeoutMs,
        headers: MIYOUSHE_HEADERS
      });
      const t = r.json?.data?.post || {};
      const p = t.post;
      if (r.json?.retcode === 0 && p) {
        // 注意字段层级（实测确认）：统计在 **t.stat**，不在 p.stat；版块在 **t.forum.name**，不在 t.topic。
        const stats = `点赞 ${fmtCount(t.stat?.like_num)} · 回复 ${fmtCount(t.stat?.reply_num)} · 浏览 ${fmtCount(t.stat?.view_num)}`;
        const imgCount = (p.image_list || p.images || []).length;
        const body = [
          t.forum?.name ? `版块：${t.forum.name}` : '',
          t.user?.nickname ? `作者：${t.user.nickname}` : '',
          p.subject ? `标题：${squash(p.subject, 200)}` : '',
          p.created_at ? `发布：${new Date(Number(p.created_at) * 1000).toLocaleString('zh-CN')}` : '',
          p.max_floor ? `楼层：${p.max_floor}` : '',
          imgCount ? `配图：${imgCount} 张` : '',
          p.content ? `正文：${unwrapJsonText(p.content)}` : ''
        ].filter(Boolean).join('\n');
        // 评论区单独一次请求；失败不影响正文，只是少一段。
        // 热评**单独放在 comments 字段**而不是拼进 text —— text 会被 formatResolved 按
        // maxChars 截断，拼进去就会被正文挤掉，评论区等于白拿。
        const { lines: hot, total } = await miyousheReplies(fetchImpl, postId, timeoutMs);
        return {
          ok: true,
          platform: 'miyoushe',
          url: `https://www.miyoushe.com/ys/article/${postId}`,
          title: squash(p.subject, 120) || `米游社帖子 ${postId}`,
          author: t.user?.nickname || '',
          text: body,
          comments: hot,
          commentTotal: total || Number(t.stat?.reply_num) || 0,
          stats,
          images: (p.image_list || p.images || []).slice(0, 4),
          via: hot.length ? 'bbs-api/getPostFull+getPostReplies' : 'bbs-api/getPostFull'
        };
      }
    } catch { /* 有些帖子接口要签名，退回 og */ }
  }
  const r = await readText(fetchImpl, url, { timeoutMs });
  const meta = metaFromHtml(r.text);
  const fallbackTitle = meta.title && !/^原神社区|^米游社/.test(meta.title) ? meta.title : (postId ? `米游社帖子 ${postId}` : meta.title);
  return { ok: !!(fallbackTitle || meta.desc), platform: 'miyoushe', url: r.finalUrl, title: fallbackTitle, author: '', text: meta.desc, stats: '', images: meta.images, via: 'og' };
}

// ── 贴吧 ──────────────────────────────────────────────────────────────────
async function tieba(url, ctx) {
  const { fetchImpl, timeoutMs } = ctx;
  const cookie = String(ctx.cookies?.tieba || '').trim();
  const tid = (url.match(/\/p\/(\d+)/) || [])[1] || (url.match(/[?&]tid=(\d+)/) || [])[1] || '';
  const target = tid ? `https://tieba.baidu.com/p/${tid}` : url;
  // 有登录 Cookie 时用 PC UA（桌面页才有 d_post_content 首楼），没 Cookie 时手机页更容易出内容。
  const r = await readText(fetchImpl, target, { timeoutMs, headers: { 'user-agent': cookie ? UA : MOBILE_UA }, cookie });
  const meta = metaFromHtml(r.text);
  // 首楼正文：PC 页里是 <div class="d_post_content">…</div>
  const floor = squash((r.text.match(/<div[^>]+class="d_post_content[^"]*"[^>]*>([\s\S]{0,4000}?)<\/div>/i) || [])[1] || '', 600);
  const mobile = squash((r.text.match(/<div[^>]+class="[^"]*post_content[^"]*"[^>]*>([\s\S]{0,4000}?)<\/div>/i) || [])[1] || '', 600);
  const body = floor || mobile;
  const text = [meta.site ? `吧名：${meta.site}` : '', body ? `首楼：${body}` : (meta.desc ? `摘要：${meta.desc}` : '')].filter(Boolean).join('\n');
  return { ok: !!(meta.title || body), platform: 'tieba', url: r.finalUrl, title: meta.title, author: '', text: body ? text : meta.desc, stats: '', images: meta.images, via: 'og' };
}

// ── QQ频道 ────────────────────────────────────────────────────────────────
// 实测（2026-10-02）：`pd.qq.com/g/<guild>/post/<post>` 与短链 `pd.qq.com/s/<code>` 都是
// 服务端直出的 HTML（短链 302 到真实帖），og:title 是帖子标题、og:description 里带
// 「由X发布在腾讯频道【Y】…版块」，首屏 JSON 里还有完整正文 —— 所以不用任何接口。
async function qqChannel(url, ctx) {
  const { fetchImpl, timeoutMs } = ctx;
  const r = await readText(fetchImpl, url, { timeoutMs });
  const meta = metaFromHtml(r.text);
  const parsed = meta.desc.match(/由(.{1,40}?)发布在腾讯频道【(.{1,40}?)】(.{0,24}?)版块/);
  const body = pickBodyText(r.text);
  const text = [
    parsed ? `频道：${parsed[2]}${parsed[3] ? ` · ${parsed[3]}` : ''}` : '',
    meta.desc && !parsed ? `简介：${meta.desc}` : '',
    body && body !== meta.desc ? `正文：${body}` : ''
  ].filter(Boolean).join('\n');
  if (!meta.title && !text) {
    return { ok: false, platform: 'qq-channel', url: r.finalUrl, noFallback: true, error: '频道页面里没读到内容（可能是频道邀请链接，或者帖子已删除）' };
  }
  return { ok: true, platform: 'qq-channel', url: r.finalUrl, title: meta.title, author: parsed?.[1] || '', text, stats: '', images: meta.images, via: 'og' };
}

// ── 腾讯视频（QQ 分享的腾讯视频卡片） ──────────────────────────────────────
async function qqVideo(url, ctx) {
  const { fetchImpl, timeoutMs } = ctx;
  // 说明：腾讯视频的播放页是 JS 渲染的（拿假 id 试过 —— 200 但连 <title> 都空），
  // 真实页一般有 og:title/og:description（剧集名 + 简介）。所以 og 优先，再从首屏 JSON 里补一句。
  const r = await readText(fetchImpl, url, { timeoutMs });
  const meta = metaFromHtml(r.text);
  const body = pickBodyText(r.text);
  const text = [
    meta.desc ? `简介：${meta.desc}` : '',
    body && body !== meta.desc ? `补充：${body}` : ''
  ].filter(Boolean).join('\n');
  if (!meta.title && !text) {
    return { ok: false, platform: 'qq-video', url: r.finalUrl, noFallback: true, error: '腾讯视频页面是 JS 渲染的，没读到标题与简介（只能看到分享卡片自带的信息）' };
  }
  return { ok: true, platform: 'qq-video', url: r.finalUrl, title: meta.title, author: '', text, stats: '', images: meta.images, via: 'og' };
}

// ── 塔吉多（完美世界 Hotta Studio 官方社区） ──────────────────────────────
function pickTajiduoPostId(url) {
  const s = String(url);
  return (s.match(/[?&]postId=(\d+)/i) || [])[1]
    || (s.match(/htapp:\/\/article\/(\d+)/i) || [])[1]
    || (s.match(/\/(?:article|post)\/(\d+)/i) || [])[1]
    || (s.match(/\b(\d{5,})\b/) || [])[1]
    || '';
}

async function tajiduo(url, ctx) {
  const { fetchImpl, timeoutMs } = ctx;
  const postId = pickTajiduoPostId(url);
  if (postId) {
    try {
      // 实测：公开接口、不需要登录。假 id 回 {"code":2007,"msg":"贴子不存在或者已经删除","ok":false}。
      const r = await readJson(fetchImpl, `https://bbs-api.tajiduo.com/bbs/wapi/getPostFull?postId=${postId}`, {
        timeoutMs,
        headers: { referer: 'https://www.tajiduo.com/' }
      });
      const data = r.json?.data || {};
      const p = data.post;
      if (r.json?.code === 0 && p) {
        // 作者：post.uid → data.users 里同 uid 的记录（实测字段名是 uid，不是 userId）。
        const me = (data.users || []).find((u) => String(u?.uid) === String(p.uid)) || data.users?.[0] || {};
        const stat = p.postStat || {};
        const body = squash(p.content, 900);
        const images = (p.images || []).map((x) => (typeof x === 'string' ? x : x?.url || '')).filter(Boolean);
        let cover = '';
        try { cover = JSON.parse(p.cover || '{}')?.url || ''; } catch { /* cover 不是 JSON 就算了 */ }
        const topics = (data.topics || []).map((t) => t?.topicName || t?.name || '').filter(Boolean);
        const text = [
          me.nickname ? `作者：${me.nickname}${me.officialMaster ? '（官方）' : ''}` : '',
          topics.length ? `话题：${topics.slice(0, 3).join('、')}` : '',
          p.region ? `地区：${p.region}` : '',
          p.createTime ? `发布：${new Date(Number(p.createTime)).toLocaleString('zh-CN')}` : '',
          images.length ? `配图：${images.length} 张` : '',
          body ? `正文：${body}` : ''
        ].filter(Boolean).join('\n');
        return {
          ok: true,
          platform: 'tajiduo',
          url: `https://www.tajiduo.com/post?postId=${postId}`,
          // 塔吉多帖子多数没有标题字段，就用正文开头当标题。
          title: squash(p.subject, 60) || squash(body, 40) || `塔吉多帖子 ${postId}`,
          author: me.nickname || '',
          text,
          stats: `点赞 ${fmtCount(stat.likeNum)} · 评论 ${fmtCount(stat.commentNum)} · 阅读 ${fmtCount(stat.readNum)}`,
          images: [cover, ...images].filter(Boolean).slice(0, 4),
          via: 'bbs-api/getPostFull'
        };
      }
      if (Number(r.json?.code) === 2007) {
        return { ok: false, platform: 'tajiduo', url, noFallback: true, error: '这个塔吉多帖子不存在或已被删除' };
      }
    } catch { /* 接口变了就退回 og */ }
  }
  const r = await readText(fetchImpl, url, { timeoutMs });
  const meta = metaFromHtml(r.text);
  const body = pickBodyText(r.text);
  if (!meta.title && !body) {
    return { ok: false, platform: 'tajiduo', url: r.finalUrl, noFallback: true, error: '没能从塔吉多网页里读到内容（可能是帖子页需要从社区里点开）' };
  }
  return { ok: true, platform: 'tajiduo', url: r.finalUrl, title: meta.title || squash(body, 40), author: '', text: [meta.desc, body].filter(Boolean).join('\n'), stats: '', images: meta.images, via: 'og' };
}

// ── 库街区（库洛游戏官方社区）：需要登录，优雅降级 ────────────────────────
async function kurobbs(url, ctx) {
  const { fetchImpl, timeoutMs } = ctx;
  // 实测（2026-10-02）：详情接口 `/forum/detail`、`/forum/post/detail` 路径都在，但不带登录态一律
  // {"code":220,"msg":"访问令牌不能为空"}（`/forum/app/topic/detail` 回 code 102）；主包里没有
  // user_token / devcode 常量，token 存在 localStorage —— 所以未登录读不到正文，只能降级成卡片信息。
  const r = await readText(fetchImpl, url, { timeoutMs });
  const meta = metaFromHtml(r.text);
  if (!shellPage('kurobbs', meta).shell && (meta.title || meta.desc)) {
    return { ok: true, platform: 'kurobbs', url: r.finalUrl, title: meta.title, author: '', text: meta.desc, stats: '', images: meta.images, via: 'og' };
  }
  return { ok: false, platform: 'kurobbs', url: r.finalUrl, noFallback: true, error: '库街区帖子正文需要登录令牌，未登录读不到（只能看到分享卡片自带的信息）' };
}

// ── 森空岛（鹰角官方社区）：需要设备签名，优雅降级 ────────────────────────
async function skland(url, ctx) {
  const { fetchImpl, timeoutMs } = ctx;
  // 实测：`zonai.skland.com/web/v2/item?id=1` → {"code":10001,"message":"设备信息无效"}。
  // 把 main bundle 与 15 个 chunk 全下下来找过签名参数，只有打包进来的 crypto-browserify
  // （createHmac/md5 是库本身），没有盐、没有固定 key → 签名无法复现，所以只试 og。
  const r = await readText(fetchImpl, url, { timeoutMs });
  const meta = metaFromHtml(r.text);
  const shell = shellPage('skland', meta);
  const body = shell.shell ? '' : pickBodyText(r.text);
  if (!shell.shell && (meta.title || body)) {
    return { ok: true, platform: 'skland', url: r.finalUrl, title: meta.title, author: '', text: [meta.desc, body].filter(Boolean).join('\n'), stats: '', images: meta.images, via: 'og' };
  }
  return { ok: false, platform: 'skland', url: r.finalUrl, noFallback: true, error: '森空岛接口要求设备签名，网页又是 JS 外壳，未登录读不到正文（只能看到分享卡片自带的信息）' };
}

// ── 快手：JS 壳 + graphql 要 Cookie，优雅降级 ─────────────────────────────
async function kuaishou(url, ctx) {
  const { fetchImpl, timeoutMs } = ctx;
  let finalUrl = url;
  // 实测：`v.kuaishou.com/<code>` 302 到 live.kuaishou.com/u/…（带 share 参数）。短链先展开再试 og。
  if (/v\.kuaishou\.com|ksurl\.cn/i.test(url)) {
    const expanded = await expandShort(fetchImpl, url, timeoutMs);
    if (expanded) finalUrl = expanded;
  }
  const r = await readText(fetchImpl, finalUrl, { timeoutMs });
  const meta = metaFromHtml(r.text);
  if (!shellPage('kuaishou', meta).shell && (meta.title || meta.desc)) {
    return { ok: true, platform: 'kuaishou', url: r.finalUrl, title: meta.title, author: '', text: meta.desc, stats: '', images: meta.images, via: 'og' };
  }
  return { ok: false, platform: 'kuaishou', url: r.finalUrl, noFallback: true, error: '快手分享页是纯 JS 渲染（未登录时 graphql 也不给数据），没读到正文（只能看到分享卡片自带的信息）' };
}

// ── 小红书：反爬壳，优雅降级 ──────────────────────────────────────────────
async function xiaohongshu(url, ctx) {
  const { fetchImpl, timeoutMs } = ctx;
  let finalUrl = url;
  if (/xhslink\.com/i.test(url)) {
    const expanded = await expandShort(fetchImpl, url, timeoutMs);
    if (expanded) finalUrl = expanded;
  }
  // 实测：笔记页桌面 UA 拿 97KB、移动 UA 拿 24.7KB，都是反爬壳 —— og 0 命中、没有
  // __INITIAL_STATE__、<title> 为空。真能出内容时它会给 __INITIAL_STATE__，所以也顺手接一下。
  const r = await readText(fetchImpl, finalUrl, { timeoutMs });
  const html = r.text || '';
  const meta = metaFromHtml(html);
  const shell = shellPage('xiaohongshu', meta);
  const state = (html.match(/__INITIAL_STATE__\s*=\s*(\{[\s\S]{0,200000}?\})\s*<\/script>/) || [])[1] || '';
  const body = shell.shell ? '' : (state ? pickBodyText(state) : '');
  const title = shell.shell ? '' : ((/^小红书$/.test(meta.title) ? '' : meta.title) || squash((state.match(/"title"\s*:\s*"([^"]{2,80})"/) || [])[1] || '', 80));
  if (title || body) {
    return { ok: true, platform: 'xiaohongshu', url: finalUrl, title, author: '', text: [meta.desc, body].filter(Boolean).join('\n'), stats: '', images: meta.images, via: state ? 'initial-state' : 'og' };
  }
  return { ok: false, platform: 'xiaohongshu', url: finalUrl, noFallback: true, error: '小红书笔记页未登录会返回反爬壳（没有 og、没有正文），读不到（只能看到分享卡片自带的信息）' };
}

// ── 通用（og 兜底，所有平台最后都走它） ────────────────────────────────────
async function generic(url, ctx) {
  const { fetchImpl, timeoutMs } = ctx;
  const r = await readText(fetchImpl, url, { timeoutMs });
  const meta = metaFromHtml(r.text);
  const text = [meta.site ? `站点：${meta.site}` : '', meta.desc || ''].filter(Boolean).join('\n');
  return { ok: !!meta.title, platform: 'generic', url: r.finalUrl, title: meta.title, author: '', text, stats: '', images: meta.images, via: 'og' };
}

const HANDLERS = {
  bilibili,
  douyin,
  miyoushe,
  tieba,
  // 新增平台（2026-10-02）。键名必须与 card.js 的 PLATFORM_RULES 名称一致：
  // 'qq-channel' QQ频道、'qq-video' 腾讯视频、tajiduo 塔吉多、kurobbs 库街区、
  // skland 森空岛、kuaishou 快手、xiaohongshu 小红书。
  'qq-channel': qqChannel,
  'qq-video': qqVideo,
  tajiduo,
  kurobbs,
  skland,
  kuaishou,
  xiaohongshu
};

/**
 * 打开一条分享链接并读出正文摘要。
 * @param {string} url
 * @param {{ fetchImpl: Function, timeoutMs?: number, platform?: string }} ctx
 */
export async function resolveShare(url, ctx) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) return { ok: false, error: '不是 http(s) 链接', url: target };
  const fast = { fetchImpl: ctx.fetchImpl, timeoutMs: Math.max(2000, Number(ctx.timeoutMs) || 12000), cookies: ctx.cookies || {} };
  const platform = ctx.platform || detectPlatform(target);
  const handler = HANDLERS[platform] || generic;
  try {
    const r = await handler(target, fast);
    const bad = judgeBlocked(r);
    if (bad) return { ok: false, platform, url: target, error: bad.error };
    if (r.ok && (r.title || r.text)) return r;
    // 自家解析器没读出东西 → 通用兜底再来一次。
    // 例外：handler 明确说 noFallback（例如「库街区未登录读不到正文」）时不再兜底 ——
    // 那种页面连 og 都是壳，兜底只会把站点名（「快手」）当成标题塞给模型，不如老实说读不到。
    if (handler !== generic && !r?.noFallback) {
      const g = await generic(target, fast);
      const gBad = judgeBlocked(g);
      if (gBad) return { ok: false, platform, url: target, error: gBad.error };
      if (g.ok && (g.title || g.text)) return { ...g, platform };
    }
    return { ok: false, platform, url: target, error: r?.error || '网页里没有可读的标题或摘要' };
  } catch (error) {
    const msg = String(error?.message || error || '');
    if (/abort/i.test(msg)) return { ok: false, platform, url: target, error: '读取超时' };
    return { ok: false, platform, url: target, error: msg.slice(0, 120) };
  }
}

/** 把解析结果排成一段给模型看的文本。 */
export function formatResolved(r, { maxChars = 900 } = {}) {
  if (!r?.ok) return `（打不开：${r?.error || '未知原因'}）`;
  const head = [`【${platformLabel(r.platform)}】${r.title || '(无标题)'}`];
  if (r.author) head.push(`作者：${r.author}`);
  if (r.stats) head.push(r.stats);
  head.push(`链接：${r.url}`);
  const body = String(r.text || '').slice(0, maxChars);
  // 热评独立于 maxChars：正文再长也不该把评论区挤掉。
  const comments = Array.isArray(r.comments) && r.comments.length
    ? `\n热评（全帖共 ${fmtCount(r.commentTotal)} 条回复，下面是热度最高的 ${r.comments.length} 条）：\n${r.comments.join('\n')}`
    : '';
  return `${head.join('\n')}${body ? `\n${body}` : ''}${comments}`;
}

export const __internals = { expandShort, pickBvid, pickMiyoushePostId, unwrapJsonText, MIYOUSHE_HEADERS, miyousheReplies, pickTajiduoPostId, pickBodyText, platformLabel };
