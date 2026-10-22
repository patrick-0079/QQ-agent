// pixiv 图源：经「lolicon 图库 API + 图片反代」取 pixiv 原图。
//
// 为什么必须是这个组合（2026-09 于本机、国内网络实测）：
//   · www.pixiv.net / app-api.pixiv.net / i.pximg.net 直连**完全不通**
//     （curl 返回 000，DNS 污染）→ 官方网页搜索和官方 App API 两条路都走死；
//   · 但图片反代 **i.pixiv.re / i.pixiv.nl 通**，且取图**不需要 Referer**
//     （实测 206 + PNG 魔数正确；首访 5~17s 因为要回源，反代缓存命中后 1.4s）；
//   · **api.lolicon.app** 通，它的 `keyword` 能在 pixiv 作品库里检索，
//     一次性返回 pid / tags / 真实尺寸 / **反代直链** —— 这正是缺的那一环。
//
// 所以 pixiv 这条路真的能走通，代价是"比普通图搜慢几秒、且只覆盖 ACG 题材"。
//
// ⚠️ 两个必须自己兜住的坑（不写就会"静默出错图"，都是实测出来的）：
//
//   ① `keyword` 是**模糊匹配 tag**，不是关键词搜索：
//      搜「橘猫」→ 返回的却是"猫耳 / 萝莉 / 白丝"；
//      搜「电脑」→ 返回的是"凝光(原神)"。
//      所以**不能**"有结果就用"，必须逐条校验 tags 里真的含有查询词（见 matchesQuery）。
//      实测这个校验非常干净：
//        ACG 词：初音 20/20、原神 20/20、明日方舟 20/20、赛马娘 20/20、
//                崩坏星穹铁道 20/20、学园偶像大师 17/17 全部通过；
//        非 ACG：橘猫 9 条返回→命中 0、三体 0、土星 0 → 全部自动让给普通图搜。
//
//   ② 接口有**严格限流**（滑动窗口，连发几次就中），触发时返回
//      `429` 或 `200 + {"error":"请求的太快啦","data":[]}`。
//      两种情况都表现为"空结果"，正好当"这次没有"静默跳过 ——
//      后面还有搜索引擎兜底，用户完全无感，不会因为限流就发不出图。
//
// 安全：源上强制 `r18=0`（pixiv 官方非 R18），但实测仍有**官方非 R18 却打
// R18 标签**的擦边图混进来（例：搜「初音」返回的第一条 tag 里就有 R-18、
// アナルチラ）。发给 QQ 群的东西不能赌这个，所以本地再加一道 tag 黑名单。
import { UA, abortAfter, isPublicHttpUrl } from './image.js';
import { keywordVariants } from './sources.js';

const PIXIV_API = 'https://api.lolicon.app/setu/v2';

/** 图片反代：主用 re、备用 nl（都实测连通）。下载失败会自动换下一个 —— 反代之间不共享缓存。 */
const MIRRORS = ['i.pixiv.re', 'i.pixiv.nl'];

/** 一次取多少条元数据。接口上限就是 20（实测 num=60 直接返回 0 条）。 */
const NUM = 20;

/**
 * 擦边/色情 tag 黑名单（小写、子串匹配）。
 *
 * 取舍说明：**只收"明确露骨"的词**，不收「ロリ / 萝莉 / 下着」这类
 * "可能擦边但正常作品也大量使用"的词 —— 收进来会把碧蓝档案之类的
 * 正常角色图成片误杀，反而让 ACG 词不出图。安全优先，但不做过度过滤。
 */
const NSFW_TAGS = [
  'r-18', 'r18', 'r-18g', 'r18g', '18禁',
  'えっち', 'エロ', 'エッチ', 'hentai',
  '全裸', '半裸', '裸体', 'ヌード', 'nude', '裸エプロン',
  'おっぱい', '巨乳', '爆乳', '微乳', '貧乳', '乳首', '乳房', '授乳', '胸チラ',
  '下着', 'ぱんつ', 'パンツ', 'ブラジャー', 'ノーブラ', '内衣', '内裤', '胖次', '胸罩',
  'パンチラ', 'ブラチラ', 'お尻',
  'ちんこ', 'まんこ', 'おまんこ', 'ペニス', 'マンコ',
  '触手', '痴漢', 'レイプ', '調教', '陵辱', '寝取', 'ntr', '中出し', '精液', '潮吹き', '放尿',
  'グロ', 'リョナ', '着エロ', 'マイクロビキニ', '极小比基尼',
  '妊娠', '孕ませ', '緊縛', '縛り',
  // 未成年形象：判据是**标签**而不是"这角色几岁"，所以正常向的角色图也可能被打上。
  // 收它是因为这张图要发到公开的 QQ 群里，宁可少几张也不踩线
  // （实测影响可控：搜「原神甘雨」被滤掉 1 条，仍有 6 条可用）。
  'ロリ', 'loli', '萝莉', '幼女'
];

/**
 * 查询词候选：最多 2 个，按优先级试。
 *
 * 第一个用"剥掉请求语气 + 尾部图/壁纸"的那一版（keywordVariants 的第 3 项），
 * 它最接近"用户真正想搜的东西"。第二个只对**连写的长中文词**才补 ——
 * 「原神甘雨」这种没有分隔符的串，中文的中心词在词尾，截尾两字再搜一次命中率高得多
 * （「原神甘雨」→「甘雨」）。短词和已命中的词不会浪费第二次调用（要省限流额度）。
 */
function queryWords(keyword) {
  const v = keywordVariants(keyword);
  const core = String(v[Math.min(2, v.length - 1)] || keyword).trim();
  const out = [core];
  if (core.length >= 4 && !/[\s,，、/·]/.test(core)) {
    const tail = core.slice(-2);
    if (tail && tail !== core) out.push(tail);
  }
  return out.filter(Boolean).slice(0, 2);
}

/** 查询词切词块：「原神 甘雨」→ ['原神','甘雨']（中文没空格时就是一个词块）。 */
function termsOf(query) {
  return String(query || '')
    .split(/[\s,，、/·和与及＆&]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * 相关性校验（这是本模块最重要的一行逻辑）。
 * 要求查询词的**每个词块**都出现在作品 tag 里。
 *   单块：「初音」→ 命中 tag「初音ミク」✓ ；「橘猫」→ 无 tag 含「橘猫」✗
 *   多块：「原神 甘雨」→ 命中 tag「甘雨(原神)」（两块都在）✓
 */
function matchesQuery(tags, query) {
  const terms = termsOf(query);
  if (!terms.length) return false;
  const lower = tags.map((t) => String(t).toLowerCase());
  return terms.every((term) => lower.some((tag) => tag.includes(term)));
}

/** 任一条 tag 命中黑名单即判为不适合发出。 */
function isNsfw(tags) {
  for (const t of tags) {
    const s = String(t).toLowerCase();
    if (NSFW_TAGS.some((w) => s.includes(w))) return true;
  }
  return false;
}

/**
 * 主入口：按关键词取 pixiv 候选。
 *
 * 固定取**常规图**（`_master1200`，长边 1200）。不提供原图选项是有实测依据的：
 * 原图 3~10MB，反代要回源，实测 4.5MB 的图要 19.9s —— 给足时间就没法在
 * 一轮对话里同时保住出图速度，给不够时间又必然全部超时（实测 8~13 条候选全挂），
 * 白白拖慢十几秒再掉回通用图搜。与其留一个"选了没效果"的开关，不如不给。
 *
 * @param {Function} httpFetch api.fetch
 * @param {string} keyword
 * @param {{ excludeAI?: boolean }} opts
 * @returns {Promise<{ candidates: Array, errors: string[] }>}
 *          注意：**空数组是正常结果**（非 ACG 词 / 限流 / 网络不通），
 *          调用方应当静默回落到其它图源，不要报错、也不要提示用户。
 */
export async function pixivCandidates(httpFetch, keyword, opts = {}) {
  const errors = [];

  for (const word of queryWords(keyword)) {
    let data = [];
    try {
      data = await query(httpFetch, word, opts.excludeAI === true);
    } catch (error) {
      // 网络层失败（超时/非 429 的 HTTP 错）：再试第二个词也是白搭，直接收手
      errors.push(`pixiv: ${error?.message ?? error}`);
      break;
    }
    if (!data.length) continue;   // 限流或确实没有

    const out = [];
    for (const it of data) {
      if (!it) continue;
      const tags = Array.isArray(it.tags) ? it.tags.map(String) : [];
      if (!matchesQuery(tags, word)) continue;   // ★ 挡住"模糊匹配带回来的无关图"
      if (isNsfw(tags)) continue;                // ★ 挡住擦边
      if (String(it.ext || '').toLowerCase() === 'gif') continue;   // 动图体积不可控
      const url = it.urls?.regular || it.urls?.original || it.urls?.thumb;
      if (!isPublicHttpUrl(url)) continue;
      out.push({
        url,
        mirrors: mirrorUrls(url),
        w: Number(it.width) || 0,
        h: Number(it.height) || 0,
        bytes: 0,
        title: String(it.title || '').slice(0, 60),
        source: 'pixiv',
        tier: 0,
        pixiv: true,          // 下载时据此换用 pixiv 的下载计划（见 index.js/pixivPlan）
        pid: it.pid,
        author: String(it.author || '').slice(0, 40)
      });
    }
    if (out.length) return { candidates: dedupeByPid(out), errors };
  }

  return { candidates: [], errors };
}

/**
 * 单次 API 调用（含一次短重试）。
 * 限流有两种表现：HTTP 429，以及 200 + error"请求的太快啦" + 空 data —— 都要认。
 * 每次等待 1.3s 是因为实测限流窗口很短（间隔 2s 连发就能成功）。
 */
async function query(httpFetch, word, excludeAI) {
  const params = new URLSearchParams({
    num: String(NUM),
    r18: '0',
    size: 'regular',
    proxy: MIRRORS[0],
    keyword: word
  });
  if (excludeAI) params.set('excludeAI', 'true');
  const url = `${PIXIV_API}?${params}`;

  for (let attempt = 0; ; attempt++) {
    const resp = await httpFetch(url, {
      method: 'GET',
      headers: { 'User-Agent': UA, 'Accept': 'application/json, text/plain, */*' },
      signal: abortAfter(9000)
    });

    if (!resp.ok) {
      if (resp.status === 429 && attempt === 0) { await sleep(1300); continue; }
      throw new Error(`HTTP ${resp.status}`);
    }

    const body = await resp.json().catch(() => null);
    const data = Array.isArray(body?.data) ? body.data : [];
    const throttled = /太快|太快啦|rate/i.test(String(body?.error || ''));
    if (!data.length && attempt === 0 && (throttled || !body)) {
      await sleep(1300);
      continue;
    }
    return data;
  }
}

/** 同一张图的反代备用地址（下载失败时换一个域名再试）。 */
function mirrorUrls(url) {
  const out = [];
  let u;
  try { u = new URL(url); } catch { return out; }
  for (const host of MIRRORS) {
    if (u.hostname === host) continue;
    out.push(`${u.protocol}//${host}${u.pathname}${u.search}`);
  }
  return out;
}

function dedupeByPid(list) {
  const seen = new Set();
  const out = [];
  for (const c of list) {
    const key = c.pid != null ? `pid:${c.pid}` : c.url;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
