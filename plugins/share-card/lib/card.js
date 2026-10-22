// 分享卡片（OneBot json 段）解析：把 QQ 卡片 payload 变成「可读文字 + 内容链接」。
//
// 与 plugins\forward-summary\media.js 的 parseCard 同源思路（深走 JSON、按字段名归类），
// 但这里多两件事：
//   1) **一定**吐出一个「最像内容页」的链接 —— 后面要靠它去打开网页读正文；
//   2) 卡片里没有链接时，退回到整段文本里正则挖（JSON.parse 失败也要能用）。
//
// 卡片结构各家不同（B站/抖音/米游社/贴吧/小程序/音乐…），所以只按「字段名像什么」归类，
// 不假设固定路径：meta.detail_1.title、meta.news.title、meta.detail_1.qqdocurl… 都能吃到。

const MAX_CARD_CHARS = 65536;
const MAX_LINES = 24;

/** 不是内容页的链接：QQ 自己的内链、二维码、头像等。 */
const SKIP_HOST = /(^|\.)(qun\.qq\.com|vip\.qq\.com|docs\.qq\.com|im\.qq\.com|wpa\.qq\.com|idqqimg\.com|qpic\.cn|qlogo\.cn|gtimg\.cn|gstatic\.com|qq\.com)$/i;

/** 明确是「分享内容页」的站，排序时优先。 */
const CONTENT_HOST = /(bilibili\.com|b23\.tv|bili2233\.cn|douyin\.com|iesdouyin\.com|miyoushe\.com|mihoyo\.com|tieba\.baidu\.com|zhihu\.com|weibo\.(com|cn)|xiaohongshu\.com|xhslink\.com|kuaishou\.com|ksurl\.cn|douban\.com|acfun\.cn|pd\.qq\.com|v\.qq\.com|tajiduo\.com|kurobbs\.com|skland\.com|qq\.com\/cgi-bin)/i;

/** 已知平台识别（resolve.js 也用它，避免两处各写一份正则）。 */
const PLATFORM_RULES = [
  // 顺序说明：先具体、后宽泛。QQ 的两个子域（pd.qq.com / v.qq.com）虽然是「内容页」，
  // 但域名尾巴恰好是 qq.com —— 下面 SKIP_HOST 的判定必须给它让路，见 parseCardPayload。
  ['qq-channel', /(?:pd\.qq\.com|qun\.qq\.com\/qqweb\/qunpro)/i],
  ['qq-video', /(?:v\.qq\.com|m\.v\.qq\.com|h5\.video\.qq\.com|video\.qq\.com)/i],
  ['bilibili', /(?:bilibili\.com|b23\.tv|bili2233\.cn)/i],
  ['douyin', /(?:douyin\.com|iesdouyin\.com)/i],
  ['miyoushe', /(?:miyoushe\.com|mihoyo\.com|bh3\.com)/i],
  ['tieba', /tieba\.baidu\.com/i],
  ['kuaishou', /(?:kuaishou\.com|ksurl\.cn)/i],
  ['xiaohongshu', /(?:xiaohongshu\.com|xhslink\.com)/i],
  ['tajiduo', /tajiduo\.com/i],
  ['kurobbs', /(?:kurobbs\.com|kurogame\.com)/i],
  ['skland', /skland\.com/i],
  ['generic', /./]
];

export function detectPlatform(url) {
  const s = String(url || '');
  if (!s) return 'generic';
  for (const [name, re] of PLATFORM_RULES) if (re.test(s)) return name;
  return 'generic';
}

function clean(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

function httpish(value) {
  try {
    const raw = String(value ?? '').trim().replace(/[，。！？、；：）】"'<>]+$/u, '');
    const u = new URL(raw);
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : '';
  } catch { return ''; }
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

/**
 * 把卡片 json 段解析成可读信息。
 * @param {string|object} raw 段里的 data.data（字符串或已解析对象）
 * @returns {{ app:string, title:string, desc:string, url:string, platform:string, images:string[], lines:string[], partial:boolean }}
 */
export function parseCardPayload(raw) {
  let obj = null;
  if (raw && typeof raw === 'object') obj = raw;
  else if (typeof raw === 'string' && raw.length <= MAX_CARD_CHARS) {
    try { obj = JSON.parse(raw); } catch { obj = null; }
  }

  const lines = [];
  const seen = new Set();
  const push = (label, value) => {
    const t = clean(value);
    if (!t || lines.length >= MAX_LINES) return;
    const key = `${label}\u0000${t}`;
    if (seen.has(key)) return;
    seen.add(key);
    lines.push(`${label}：${t}`);
  };

  const urls = [];
  const images = [];

  const walk = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 6) return;
    for (const [key, v] of Object.entries(value).slice(0, 60)) {
      if (v && typeof v === 'object') { walk(v, depth + 1); continue; }
      if (typeof v !== 'string') continue;
      const k = String(key).toLowerCase();
      if (/^(title|desc|description|summary|prompt|brief|content|text)$/.test(k)) push(k === 'title' ? '标题' : '文字', v);
      else if (/^(source|tag|app|name|nick|nickname)$/.test(k)) push('来源', v);
      else if (/^(url|jumpurl|jump_url|qqdocurl|docurl|targeturl)$/.test(k)) { const u = httpish(v); if (u) urls.push(u); }
      else if (/^(preview|cover|image|imageurl|pic|picture)$/.test(k)) { const u = httpish(v); if (u && images.length < 6) images.push(u); }
    }
  };
  if (obj) walk(obj);

  // 兜底：整段文本里正则挖链接（JSON 解析失败、或链接藏在未识别的字段里）
  const text = typeof raw === 'string' ? raw : (obj ? JSON.stringify(obj) : '');
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>\\)\]]+/g)) {
    const u = httpish(m[0]);
    if (u) urls.push(u);
  }

  // 选「最像内容页」的那条：命中已知平台 > 非 QQ 内链 > 其余
  // 注意顺序：**先认内容页、再排 QQ 内链**。
  // `pd.qq.com`（QQ频道）与 `v.qq.com`（腾讯视频）的域名尾巴就是 `qq.com`，
  // 若先过 SKIP_HOST 就会被当成 QQ 内链整条丢掉 —— 新加的这两个平台永远选不出链接。
  const scored = urls
    .filter((u) => (CONTENT_HOST.test(u) ? true : !SKIP_HOST.test(hostOf(u))))
    .map((u) => ({ u, score: (CONTENT_HOST.test(u) ? 2 : 0) + (u.length > 24 ? 1 : 0) }))
    .sort((a, b) => b.score - a.score);
  const url = scored[0]?.u || '';

  const app = clean(obj?.prompt || obj?.app || lines.find((l) => l.startsWith('来源：'))?.slice(3) || '');
  const title = lines.find((l) => l.startsWith('标题：'))?.slice(3) || '';
  const desc = lines.find((l) => l.startsWith('文字：'))?.slice(3) || '';

  return {
    app,
    title,
    desc,
    url,
    platform: detectPlatform(url),
    images,
    lines,
    partial: lines.length === 0 && !url
  };
}

/**
 * 一行的展示形式（写进消息文本，让模型能看见卡片说了什么）。
 * 卡片解析不出来时退回原来的 [卡片消息]，不制造噪音。
 */
export function cardToText(raw) {
  const card = parseCardPayload(raw);
  if (!card.url && !card.lines.length) return '[卡片消息]';
  const head = [card.app, card.title].filter(Boolean).join('：');
  const tail = card.url ? ` ${card.url}` : '';
  return `[卡片消息${head ? `｜${head}` : ''}${tail}]`;
}
