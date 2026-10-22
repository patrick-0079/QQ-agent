// 搜图：两个免 Key 来源，互相补位。
//
// 为什么不用核心的 searchImages（src/web-search.js）：
//   它走 safeFetch，而 safeFetch 只读前 50000 个字符 —— 百度图片页现在远超这个长度，
//   结果 `objURL` 根本不在前 50KB 里，解析永远为空（实测：两个来源都返回 0 条）。
//   这里用技能自己的 fetch（已声明 web_fetch 权限）拿完整响应，下载图片时再走
//   核心 safeFetchBinary（SSRF 防护 + 体积上限照旧生效）。
//
// 两个来源的实测差异（2026-10 在本机跑通）：
//   · 百度 acjson：JSON、约 58KB、返回 img*.baidu.com 的 500px WebP 缩略图，稳定、体积小
//   · Bing async：约 150KB、返回原图直链（murl），清晰但部分站点会 403 / 连接被重置
// 所以结果按「Bing 一条、百度一条」交替排列：先给清晰的原图，挂了还有稳的兜底。

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const decodeEntities = (value) => String(value)
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&');

const stripTags = (value) => String(value ?? '').replace(/<[^>]*>/g, '').trim();

/** 百度图片 JSON 接口。失败抛错，由上层决定是否回退 Bing。 */
export async function searchBaidu(fetchImpl, query, limit) {
  const rn = Math.min(30, Math.max(12, limit * 4));
  const url = 'https://image.baidu.com/search/acjson?tn=resultjson_com&ipn=rj'
    + `&word=${encodeURIComponent(query)}&pn=0&rn=${rn}`;
  const res = await fetchImpl(url, {
    headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9', referer: 'https://image.baidu.com/' },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`百度图片 HTTP ${res.status}`);
  const text = await res.text();

  let items = [];
  try {
    const data = JSON.parse(text);
    if (Array.isArray(data?.data)) items = data.data.filter(Boolean);
  } catch { /* 百度偶尔返回带非法转义的 JSON，下面用正则兜底 */ }

  if (!items.length) {
    const seen = new Set();
    for (const m of text.matchAll(/"(?:middleURL|thumbURL|hoverURL)"\s*:\s*"([^"]+)"/g)) {
      const u = m[1].replace(/\\\//g, '/');
      if (seen.has(u)) continue;
      seen.add(u);
      items.push({ middleURL: u });
    }
  }

  const out = [];
  const seen = new Set();
  for (const item of items) {
    const url0 = item?.middleURL || item?.thumbURL || item?.hoverURL;
    if (typeof url0 !== 'string' || !/^https?:\/\//i.test(url0) || seen.has(url0)) continue;
    seen.add(url0);
    out.push({
      title: stripTags(decodeEntities(item?.fromPageTitleEnc || '')).slice(0, 40) || query,
      url: url0,
      source: 'baidu',
      width: Number(item?.width) || undefined,
      height: Number(item?.height) || undefined
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Bing 图片异步接口（HTML 片段里带 murl / turl 的 JSON）。 */
export async function searchBing(fetchImpl, query, limit) {
  const count = Math.min(60, Math.max(35, limit * 6));
  const url = 'https://www.bing.com/images/async'
    + `?q=${encodeURIComponent(query)}&first=0&count=${count}&mkt=zh-CN&datsrc=N_I&layout=RowBased&mmasync=1`;
  const res = await fetchImpl(url, {
    headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`Bing 图片 HTTP ${res.status}`);
  const text = decodeEntities(await res.text());

  const out = [];
  const seen = new Set();
  for (const m of text.matchAll(/"murl":"([^"]+)"/g)) {
    const u = m[1];
    if (!/^https?:\/\//i.test(u) || seen.has(u)) continue;
    seen.add(u);
    out.push({ title: query, url: u, source: 'bing' });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 合并两个来源：交替排列，按 url 去重。
 * 两个都失败才抛错，并把两边的失败原因一起带上（便于判断是网络问题还是改版）。
 */
export async function searchImages(fetchImpl, query, limit = 5) {  const q = String(query ?? '').trim();
  if (!q) throw new Error('搜索关键词为空');
  const n = Math.min(8, Math.max(1, Number(limit) || 5));
  if (typeof fetchImpl !== 'function') throw new Error('没有网络权限（需要在 skill.json 的 permissions 里声明 web_fetch）');

  const errors = [];
  const [bing, baidu] = await Promise.all([
    searchBing(fetchImpl, q, n).catch((error) => { errors.push(`Bing：${error?.message ?? error}`); return []; }),
    searchBaidu(fetchImpl, q, n).catch((error) => { errors.push(`百度：${error?.message ?? error}`); return []; })
  ]);

  const merged = [];
  const seen = new Set();
  const push = (item) => {
    if (!item || seen.has(item.url) || merged.length >= n) return;
    seen.add(item.url);
    merged.push(item);
  };
  for (let i = 0; i < Math.max(bing.length, baidu.length); i++) {
    push(bing[i]);
    push(baidu[i]);
  }

  if (!merged.length) throw new Error(`两个来源都没搜到 —— ${errors.join('；') || '返回内容里没有图片链接'}`);
  return merged.slice(0, n);
}

// ── Pixiv ──────────────────────────────────────────────────────────────────
//
// 本机实测（2026-10）：pixiv.net 直连不通，也没有任何本地代理端口在监听，
// 所以走「懒猫」公开接口按 Pixiv 标签检索（大陆可直连）；图片用 pixiv.re 的
// PID 简写取（它不受 i.pximg.net 的 Referer 防盗链限制）。
//
// 内容分级：**只取全年龄**（r18=0），并在本地再按标签复核一遍 ——
// 群聊场景默认不该出现成人内容，所以这里不提供开关。

const ADULT_TAG = /^(r-?18g?|r18|成人向?|エロ|guro|リョナ|グロ)/i;
const PIXIV_API = 'https://api.lolicon.app/setu/v2';
// 人气档位（Pixiv 民间约定标签）与单次搜索的请求上限（防止穷举拖慢整轮对话）
const POPULAR_TIERS = [1000, 500];
const MAX_CALLS = 5;

export const hasKana = (value) => /[\u3040-\u309f\u30a0-\u30ff]/.test(String(value ?? ''));
export const hasCjk = (value) => /[\u4e00-\u9fff]/.test(String(value ?? ''));

/**
 * 中文 → Pixiv 标签（日文）的解析。
 *
 * 查找顺序：去掉括号备注后的原名 → 原名 → 去掉「酱 / ちゃん / さん」后缀再查。
 * **只做精确匹配**：查不到就原样返回，绝不猜 —— 错映射比搜不到更糟（会静默给出
 * 完全无关的作品）。
 *
 * @param {string} query 用户/模型给的名字
 * @param {Record<string,string>|null} dict 中日词典（种子 + 学到的）
 * @returns {{tag:string, mapped:boolean, from:string}}
 */
export function resolvePixivTag(query, dict) {
  const raw = String(query ?? '').trim();
  const clean = raw.replace(/[（(][^)）]*[)）]/g, '').trim() || raw;
  const lookup = (key) => (dict && Object.prototype.hasOwnProperty.call(dict, key) ? String(dict[key]).trim() : '');

  for (const candidate of [clean, raw]) {
    const hit = lookup(candidate);
    if (hit) return { tag: hit, mapped: true, from: candidate };
  }
  for (const candidate of [clean, raw]) {
    const base = candidate.replace(/(酱|醬|ちゃん|さん)$/u, '').trim();
    if (base && base !== candidate) {
      const hit = lookup(base);
      if (hit) return { tag: hit, mapped: true, from: base };
    }
  }
  return { tag: raw, mapped: false, from: raw };
}

export async function searchPixiv(fetchImpl, query, limit = 5, {
  apiUrl = PIXIV_API, dict = null, popular = true, isSeen = null, windowDays = 30
} = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('Pixiv 搜图需要关键词或标签');
  if (typeof fetchImpl !== 'function') throw new Error('没有网络权限（需要在 skill.json 的 permissions 里声明 web_fetch）');
  const n = Math.min(20, Math.max(6, (Number(limit) || 5) * 3));

  const call = async (mode, value) => {
    const url = `${String(apiUrl || PIXIV_API).trim()}?${mode}=${encodeURIComponent(value)}&num=${n}&r18=0`;
    const res = await fetchImpl(url, {
      headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error(`Pixiv 检索接口 HTTP ${res.status}`);
    const data = await res.json().catch(() => null);
    if (!data) throw new Error('Pixiv 检索接口返回的不是 JSON');
    if (data.error) throw new Error(`Pixiv 检索接口报错：${data.error}`);
    return Array.isArray(data.data) ? data.data : [];
  };

  // ── 检索计划 ──────────────────────────────────────────────────────────
  // ① 中文名先换成日文标签（词典）；
  // ② 人气优先：先搜「{标签} 1000users入り」，不够再降 500，最后才用裸标签。
  //    这是 Pixiv 上的民间约定标签，实测「初音ミク 500users入り」前几张收藏都在 500~900，
  //    比"最新优先"的裸标签靠谱得多（裸标签翻几页最高才 400 多）。
  //    注意它只是"更容易捞到"：有人会乱打标签，所以不能当成精确排序。
  // ③ 全部走完还没结果，再试关键词模糊搜。
  const resolved = resolvePixivTag(q, dict);
  const tags = [];
  if (resolved.mapped && resolved.tag !== q) tags.push(resolved.tag);
  tags.push(q);

  const plan = [];
  for (const tag of tags) {
    if (popular) for (const step of POPULAR_TIERS) plan.push(`${tag} ${step}users入り`);
    plan.push(tag);
  }

  const out = [];
  const seenPid = new Set();
  let rawCount = 0;
  let calls = 0;

  const collect = (items) => {
    for (const item of items) {
      const pid = String(item?.pid ?? '').trim();
      if (!/^\d{4,12}$/.test(pid) || seenPid.has(pid)) continue;
      const itemTags = Array.isArray(item?.tags) ? item.tags.map(String) : [];
      // 接口自称全年龄，但标题/标签里带 R-18 的一律再挡一次
      if (item?.r18 === true || itemTags.some((t) => ADULT_TAG.test(t.trim()))) continue;
      rawCount += 1;
      const url = `https://pixiv.re/${pid}.png`;
      // 发过的图直接跳过：这样"就算搜到同一批，也不会再发一遍"
      if (typeof isSeen === 'function' && isSeen(url)) continue;
      seenPid.add(pid);
      const title = String(item?.title ?? '').trim() || '（无题）';
      const author = String(item?.author ?? '').trim() || '未知作者';
      out.push({
        title: `${title} — ${author}`.slice(0, 60),
        url,
        source: 'pixiv',
        page: `https://www.pixiv.net/artworks/${pid}`
      });
      if (out.length >= limit) break;
    }
  };

  for (const value of plan) {
    if (out.length >= limit || calls >= MAX_CALLS) break;
    calls += 1;
    collect(await call('tag', value));
  }
  // 完全没有原始结果时才去试关键词；有结果但全被历史过滤掉的话，说明这个标签"发完了"
  if (out.length < limit && rawCount === 0 && calls < MAX_CALLS) {
    calls += 1;
    collect(await call('keyword', q));
  }

  if (!out.length) {
    if (rawCount > 0) {
      throw new Error(`这个标签最近 ${windowDays} 天发过的都重复了（${rawCount} 张全被过滤）。换个角色或更具体的词，或者过几天再试`);
    }
    const via = resolved.mapped && resolved.tag !== q ? `（中文「${q}」已按日文「${resolved.tag}」搜过）` : '';
    throw new Error(`Pixiv 上没搜到这个标签的全年龄作品${via}（换日文标签再试，比如「初音ミク」「博麗霊夢」）`);
  }
  return out;
}
