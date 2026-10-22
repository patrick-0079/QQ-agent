// 图源适配层：把各家图片搜索的返回搓成统一的候选格式。
//
// 候选格式：{ url, w, h, title, source, tier }
//   w/h   —— 搜索接口**标称**的尺寸，只用来排序。真实尺寸要下载后量（见 image.js）。
//           百度就很会骗人：标称 3552x4720，实际发过来一张 500x664。
//   tier  —— 可信度分层，排序时**层优先于尺寸**：
//             0 原图直链（清晰度上限最高，但可能防盗链约一半会 403）
//             1 必在的相关图（必应缩略图服务 ~1600px、百度 CDN 500~800px）
//             2 小图（360 缩略图只有 240px，仅为"总得有一张真图"）
//             3 最后保险（与关键词无关的随机图，只在前面全挂时用）
//
// 各源实测结论（2026-09 于本机，国内网络）：
//   · 360 image.so.com/j  —— 一次给 84~198 条、带原图直链和尺寸，**主力**
//   · 百度 acjson         —— 30 条，只有 500px 缩略图稳定可用（原图 replaceUrl 多半 403），**补充**
//   · Bing 网页抓 murl    —— 已失效（返回 JS 空壳页，0 条结果），**已移除**
//   · Bing tse2.mm.bing.net/th —— 任何关键词都返回 200 + JPEG，且**内容高度相关**
//     （实测「樱花」出樱花、「土星」出土星、「橘猫」出橘猫），~1600px，**担当主力+兜底**
import { isPublicHttpUrl, UA, abortAfter } from './image.js';

/** 各源列表页的随机起点：同关键词多次搜索时拿到**不同**的候选，这是"每次不同"的第一道保障。 */
const RANDOM_STARTS = [0, 30, 60];

function pickStart() {
  return RANDOM_STARTS[Math.floor(Math.random() * RANDOM_STARTS.length)];
}

/**
 * 汇总所有图源。任何单源失败都只记录、不影响其它源。
 * @param {object} opts { sources, allowRandom, want }
 * @returns {Promise<{ candidates: Array, errors: string[] }>}
 */
export async function collectCandidates(httpFetch, keyword, opts = {}) {
  const errors = [];
  const wanted = opts.sources || null;         // null = 全都试
  const jobs = [];
  if (!wanted || wanted.includes('360')) jobs.push(['360', () => qihoo(httpFetch, keyword)]);
  if (!wanted || wanted.includes('baidu')) jobs.push(['百度', () => baidu(httpFetch, keyword)]);
  if (!wanted || wanted.includes('bing')) jobs.push(['必应', () => bingThumb(httpFetch, keyword, opts.want)]);

  const results = await Promise.allSettled(jobs.map(([, run]) => run()));
  const out = [];
  results.forEach((r, i) => {
    const name = jobs[i][0];
    if (r.status === 'fulfilled') out.push(...r.value);
    else errors.push(`${name}: ${r.reason?.message ?? r.reason}`);
  });

  // 随机图端点：只有当搜索类图源**一条都没拿到**时才补，免得污染正常结果
  const searchable = out.filter((c) => c.tier <= 1);
  if (!searchable.length && opts.allowRandom !== false) out.push(...randomFallbacks());

  return { candidates: dedupeByUrl(out), errors };
}

function dedupeByUrl(list) {
  const seen = new Set();
  const out = [];
  for (const c of list) {
    if (!c?.url || seen.has(c.url)) continue;
    seen.add(c.url);
    out.push(c);
  }
  return out;
}

/** 解析 "111KB" / "1.2MB" / "70547KB" 这类标称体积。解析不出返回 0。 */
function parseSize(text) {
  const m = String(text || '').match(/([\d.]+)\s*(KB|MB|B)/i);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2].toUpperCase();
  return Math.round(n * (unit === 'MB' ? 1048576 : unit === 'KB' ? 1024 : 1));
}

/** 360 图搜：带原图直链 + 尺寸 + 体积，候选质量最好。 */
async function qihoo(httpFetch, keyword) {
  const pn = pickStart();
  const url = 'https://image.so.com/j'
    + `?q=${encodeURIComponent(keyword)}&pn=${pn}&rn=60&src=srp`;
  const resp = await httpFetch(url, {
    method: 'GET',
    headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'zh-CN,zh;q=0.9' },
    signal: abortAfter(8000)
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = parseMaybeJsonp(await resp.text());
  const list = Array.isArray(data?.list) ? data.list : [];
  const out = [];
  for (const it of list) {
    if (!it) continue;
    const title = String(it.title || it.litetitle || '').slice(0, 60);
    if (isPublicHttpUrl(it.img)) {
      out.push({
        url: it.img,
        w: Number(it.width) || 0,
        h: Number(it.height) || 0,
        bytes: parseSize(it.imgsize),
        title,
        source: '360图搜',
        tier: 0
      });
    }
    // 360 自己的缩略图 CDN：极稳但只有 240px，达不到清晰度下限，
    // 所以放 tier 2 而不是 tier 1 —— 让它只在前面的原图全挂时作为最后的真图出现，
    // 别去挤占正常候选的下载额度。
    if (isPublicHttpUrl(it.thumb)) {
      out.push({
        url: it.thumb,
        w: Number(it.thumbWidth) || 240,
        h: Number(it.thumbHeight) || 240,
        bytes: 0,
        title,
        source: '360缩略图',
        tier: 2
      });
    }
  }
  return out;
}

/**
 * 百度图搜。
 *
 * 注意三点：

 *  · 缺 Referer 会返回一个 `200 + 空 data` 的空壳 JSON，看起来像"没搜到"，
 *    其实是没带对头 —— 这类问题极难排查，所以 Referer 必须带。
 *  · thumbURL / middleURL / hoverURL **是同一张 500px 图**（`w=500&h=664`），
 *    指望它"高清"是错觉。真正能拿到更大的只有 replaceUrl 里的原图地址。
 *  · replaceUrl 的原图多半 403（图床防盗链），所以它排原图档但**不能只靠它**。
 */
async function baidu(httpFetch, keyword) {
  const pn = pickStart();
  const url = 'https://image.baidu.com/search/acjson'
    + `?tn=resultjson_com&ipn=rj&word=${encodeURIComponent(keyword)}&pn=${pn}&rn=30`;
  const resp = await httpFetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': UA,
      'Referer': 'https://image.baidu.com/search/index',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9'
    },
    signal: abortAfter(8000)
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json().catch(() => null);
  const items = Array.isArray(data?.data) ? data.data : [];
  const out = [];
  for (const it of items) {
    if (!it) continue;
    const title = String(it.fromPageTitleEnc || it.title || '').slice(0, 60);
    const w = Number(it.width) || 0;
    const h = Number(it.height) || 0;
    // 原图档：replaceUrl[0].ObjURL / ObjUrl 是**未加密**的原图地址
    const rep = Array.isArray(it.replaceUrl) ? it.replaceUrl[0] : null;
    const original = rep?.ObjURL || rep?.ObjUrl || '';
    if (isPublicHttpUrl(original)) {
      out.push({ url: original, w, h, bytes: 0, title, source: '百度原图', tier: 0 });
    }
    // 中档档：百度自家 CDN，实测必在（尺寸不给标称值，排序时自然靠后）
    const mid = it.middleURL || it.thumbURL || it.hoverURL || '';
    if (isPublicHttpUrl(mid)) {
      out.push({ url: mid, w: 0, h: 0, bytes: 0, title, source: '百度图', tier: 1 });
    }
  }
  return out;
}

/**
 * Bing 缩略图服务：**任何**关键词都返回一张相关 JPEG（实测「樱花」出樱花、
 * 「土星」出土星、连乱码都返回 45KB 图片），尺寸 1200~1920px。
 *
 * 它在两条路上都用得上，所以不是"纯兜底"：
 *   · 正常搜索：作为**必在的相关图**参与竞争（360/百度被限流时全靠它）
 *   · 全挂兜底：前面一条结果都没有时，它守住"必定出图"这条底线
 *
 * 同一个 q 返回的图是确定的，所以"每次不同"不靠它 —— 靠关键词后缀换查询
 * （`樱花` / `樱花 高清` / `樱花 壁纸` 是三张不同的图），以及其它图源的轮换。
 */
const BING_QUERY_FORMS = ['', ' 高清', ' 壁纸'];

async function bingThumb(httpFetch, keyword, want) {
  const count = Math.max(1, Math.min(3, Number(want) || 1));
  const forms = shuffleLocal(BING_QUERY_FORMS.slice()).slice(0, count);
  const sizes = [[1600, 1200], [1280, 960], [1920, 1080]];

  const jobs = forms.map(async (suffix) => {
    const q = `${keyword}${suffix}`.trim();
    const [w, h] = sizes[Math.floor(Math.random() * sizes.length)];
    const url = 'https://tse2.mm.bing.net/th'
      + `?q=${encodeURIComponent(q)}&w=${w}&h=${h}&c=7&rs=1&p=0&dpr=1&pid=1.7&mkt=zh-CN&adlt=off`;
    const resp = await httpFetch(url, {
      method: 'GET',
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal: abortAfter(8000)
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length < 1024) throw new Error('响应过小');
    return { url, w, h, bytes: buf.length, title: q, source: '必应', tier: 1 };
  });

  const results = await Promise.allSettled(jobs);
  const out = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (!out.length) {
    const why = results.find((r) => r.status === 'rejected')?.reason;
    throw new Error(why?.message ?? '无结果');
  }
  return out;
}

/** 小规模洗牌（sources 里只需要"别每次都挑同一个查询形式"）。 */
function shuffleLocal(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * 最后保险：与关键词无关的随机图。
 * 只有"搜索源全挂 + Bing 也挂"才会走到这里（一般意味着网络出了大问题）。
 */
export function randomFallbacks() {
  const n = Math.floor(Math.random() * 100000);
  return [
    // 1600x900 的随机真实照片，永远 200
    { url: `https://picsum.photos/1600/900?random=${n}`, w: 1600, h: 900, bytes: 0, title: '', source: '随机图', tier: 3 },
    { url: `https://picsum.photos/1280/720?random=${n + 1}`, w: 1280, h: 720, bytes: 0, title: '', source: '随机图', tier: 3 }
  ];
}

/** 360 有时回 JSONP（`callback({...})`），两种都吃。 */
function parseMaybeJsonp(text) {
  const s = String(text || '').trim();
  try { return JSON.parse(s); } catch { /* 继续试 JSONP */ }
  const m = s.match(/^[^(]*\((.*)\)[;\s]*$/s);
  if (m) { try { return JSON.parse(m[1]); } catch { /* 放弃 */ } }
  return null;
}

/**
 * 关键词变体：原词搜不到时，逐级放宽再搜。
 *
 * 这是"什么图都能配"的第一道保障。用户/模型可能丢过来一句长话
 * （「来张橘猫的图片」「三体里那个罗辑的高清壁纸」），直接拿去搜命中率低，
 * 剥到核心名词（「橘猫」「罗辑」）就很容易出图。
 *
 * 只做**减法**、不换语义，且**原词永远排在第一个** —— 变体只是"原词搜不到时的后备"，
 * 不会抢在原词前面把结果改掉。
 *
 * ⚠️ 剥词表必须**按长度降序**匹配，否则「来张」会被「来」先吃掉、留下「张橘猫」。
 * 这个坑我在测试里踩到过，所以下面用排序而不是手写顺序来保证。
 */
const LEAD_WORDS = [
  '请帮我', '麻烦你', '麻烦', '帮我', '给我',
  '来一张', '来一个', '来张', '来个', '来点', '来',
  '整一个', '整张', '整个', '搞一张', '搞张', '搞个',
  '搜索一下', '搜一下', '搜一搜', '搜索', '搜',
  '查看一下', '查一下', '查一查', '查',
  '找一张', '找一下', '找个', '找张', '找',
  '发一张', '发一下', '发张', '发个', '发',
  '有没有', '有么', '要一张', '要一下', '要个', '要张', '要来', '想要', '想看',
  '能不能', '可不可以', '可以', '求'
];
const TRAIL_WORDS = [
  '的表情包', '表情包', '的图片', '的相片', '的照片', '的壁纸', '的插画', '的配图',
  '图片', '相片', '照片', '壁纸', '插画', '头像', '配图', '的图', '图'
];
const MODIFIERS = /(高清|超高清|超清|蓝光|高画质|4k|8k|1080p|720p|2k|清晰|好看|漂亮|可爱|最新|横屏|竖屏)/gi;
/** 指示/领属词：剥掉后剩下的才像"要搜的东西"（「那个罗辑」→「罗辑」）。 */
const DETERMINERS = /^(这个|那个|这些|那些|一个|一张|一只|一群|一份|某个|这|那)+/g;

// 按长度降序，保证"最长优先"匹配（见上面 ⚠️）
const LEAD_SORTED = [...LEAD_WORDS].sort((a, b) => b.length - a.length);
const TRAIL_SORTED = [...TRAIL_WORDS].sort((a, b) => b.length - a.length);

function stripLeading(text) {
  let s = text;
  for (let round = 0; round < 4; round++) {
    const hit = LEAD_SORTED.find((w) => s.startsWith(w));
    if (!hit) break;
    s = s.slice(hit.length).trim();
  }
  return s;
}

function stripTrailing(text) {
  let s = text;
  for (let round = 0; round < 4; round++) {
    const hit = TRAIL_SORTED.find((w) => s.endsWith(w));
    if (!hit) break;
    s = s.slice(0, s.length - hit.length).trim();
  }
  // 去掉剥词留下的悬空「的」
  return s.replace(/[的]+$/g, '').trim();
}

export function keywordVariants(keyword) {
  const out = [];
  const push = (s) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    if (t && t.length >= 1 && !out.includes(t)) out.push(t);
  };

  const raw = String(keyword || '').trim();
  push(raw);   // ★ 原词永远第一顺位

  // 去引号/装饰符/emoji（这些字符进搜索词只会干扰）
  let s = raw
    .replace(/[「」『』“”"'‘’（）()\[\]【】<>《》]/g, ' ')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  push(s);

  // 去请求语气 + 去尾部的"图/图片/壁纸/表情包"
  s = stripTrailing(stripLeading(s));
  push(s);

  // 去修饰词（高清/好看/最新…）
  s = s.replace(MODIFIERS, ' ').replace(/\s+/g, ' ').trim();
  s = stripTrailing(s);
  push(s);

  // 「…那个X」「…的X」→ X（中文核心名词常在末尾，这是最有效的一条）
  const tail = s.match(/(?:那个|这个|那些|这些|的|中|里)([^\s的那个这个那些这些中里]{2,8})$/);
  if (tail) push(tail[1]);

  // 按「的/和/与」切分：取最后一段（通常是中心词），再取最长一段
  const parts = s.split(/[的和与及或]/)
    .map((x) => x.trim().replace(DETERMINERS, '').trim())
    .filter((x) => x.length >= 1);
  if (parts.length > 1) {
    push(parts[parts.length - 1]);
    push([...parts].sort((a, b) => b.length - a.length)[0]);
  }

  // 去开头的指示/领属词（「那个罗辑」→「罗辑」）
  push(s.replace(DETERMINERS, '').replace(/^[的]+/g, '').trim());

  // 最后一招：取尾部若干字。中文的"中心词"基本都在词尾，
  // 「三体里那个罗辑」这种没有可切分标记的长串只能靠它兜住。
  // 只对中文做 —— 英文按字数截尾只会截出 "ura"/"ra" 这种噪声。
  if (/[\u4e00-\u9fff]/.test(s)) {
    for (const n of [3, 2]) {
      if (s.length > n + 1) push(s.slice(-n));
    }
  }

  return out.slice(0, 7);
}
