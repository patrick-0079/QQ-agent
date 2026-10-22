// Steam 查价 —— 查游戏价格/折扣/好评率/发售日，外加每日打折播报（确定性型，放 plugins/）
//
// ── 它干什么 ──────────────────────────────────────────────────────────
// 群里发「\steam 艾尔登法环」，机器人查 Steam 回一张卡片（或纯文字）：
// 当前价、原价、折扣、好评率、发售日、支持平台。也支持直接给 appid。
// 另带「打折播报」：填一份关注列表，每天定时批量查价，折扣到线了自动播报到群里。
//
// ── 为什么一个密钥都不用 ───────────────────────────────────────────────
// Steam 的数据分两套：**商店接口**（store.steampowered.com/api/…）不需要任何认证，
// 商店前端自己就在用；**官方 Web API**（api.steampowered.com）查玩家数据才要 key。
// 本插件只做「游戏」维度，完全不碰玩家数据，所以零配置。
//
// ⚠️ 但商店接口有个国内特有的麻烦，见下面 fetchJson 的注释 —— **必须带重试**。
//
// ── 接口清单（2026-10-02 在本机逐条实测过，不是照抄文档）────────────────
//   搜索：store.steampowered.com/api/storesearch/?term=&cc=&l=   → id/name/price/metascore
//         ⚠️ 别用 /search/results/?json=1 —— 那个 items 里**只有 name 和 logo，没有 appid**，
//            看着像能用，实际拿不到 id（实测踩过）。
//   详情：store.steampowered.com/api/appdetails?appids=&cc=&l=   → price_overview/评价数/发售日/平台
//   评价：store.steampowered.com/appreviews/<appid>?json=1       → query_summary（好评率）
//
// ⚠️ 三个字段坑（实测确认）：
//   1. 价格是**整数分**：29800 是 ¥298.00，一律除 100 再显示。
//   2. **免费游戏没有 price_overview 字段**（Dota2/CS2 都没有）—— 不先判 is_free 会崩。
//   3. 折扣字段叫 discount_percent（0~100），现价在 final，原价在 initial。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const COMMAND = 'steam';

const DEFAULTS = {
  enabled: true,
  countryCode: 'cn',
  language: 'schinese',
  timeoutMs: 10000,
  retries: 3,
  maxPerMinute: 8,
  showReviews: true,
  renderCard: true,
  theme: 'dark',
  watchList: '',
  broadcastTime: '',
  broadcastTargets: '',
  minDiscountPercent: 25,
  // ── 以下需要 Steam Web API Key（见文件末尾「玩家接口」一节）──
  apiKey: '',
  playWatchEnabled: false,
  playWatchIntervalMin: 30,
  playWatchTargets: ''
};

// Steam 对无 UA 的请求不友好（部分端点会直接拒），统一带上
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const EP_SEARCH = 'https://store.steampowered.com/api/storesearch/';
const EP_DETAIL = 'https://store.steampowered.com/api/appdetails';
const EP_REVIEW = 'https://store.steampowered.com/appreviews/';

let cfgFn = () => ({});
let log = () => {};

/** 最近一次查询（只给状态卡用，内存态）。 */
let lastQuery = null;
/** 限频滑动窗口。 */
const hits = [];

// ── 配置 ────────────────────────────────────────────────────────────────
function readSettings() {
  const c = cfgFn() || {};
  const num = (v, d, lo, hi) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return d;
    return Math.min(hi, Math.max(lo, Math.round(n)));
  };
  const str = (v, d) => (typeof v === 'string' && v.trim() ? v.trim() : d);
  return {
    enabled: c.enabled !== false,
    countryCode: str(c.countryCode, DEFAULTS.countryCode).slice(0, 8),
    language: str(c.language, DEFAULTS.language).slice(0, 12),
    timeoutMs: num(c.timeoutMs, DEFAULTS.timeoutMs, 2000, 60000),
    retries: num(c.retries, DEFAULTS.retries, 1, 8),
    maxPerMinute: num(c.maxPerMinute, DEFAULTS.maxPerMinute, 1, 60),
    showReviews: c.showReviews !== false,
    renderCard: c.renderCard !== false,
    // 只认 light，其余一律当 dark（配置里手打错字也不该把卡片弄成没配色）
    theme: themeOf(c),
    watchList: String(c.watchList ?? ''),
    broadcastTime: String(c.broadcastTime ?? '').trim(),
    broadcastTargets: String(c.broadcastTargets ?? '').trim(),
    minDiscountPercent: num(c.minDiscountPercent, DEFAULTS.minDiscountPercent, 0, 99),
    apiKey: String(c.apiKey ?? '').trim(),
    playWatchEnabled: c.playWatchEnabled === true,
    playWatchIntervalMin: num(c.playWatchIntervalMin, DEFAULTS.playWatchIntervalMin, 5, 720),
    playWatchTargets: String(c.playWatchTargets ?? '').trim()
  };
}

/**
 * 每分钟限频：滑动窗口（固定桶在整点边界会放进两倍流量）。
 */
function takeRateSlot(now, maxPerMinute) {
  const win = 60_000;
  while (hits.length && now - hits[0] > win) hits.shift();
  if (hits.length >= maxPerMinute) return false;
  hits.push(now);
  return true;
}
function resetRate() { hits.length = 0; }

// ── 请求 ────────────────────────────────────────────────────────────────
/**
 * 带重试的 JSON 请求。**这是本插件最不能省的一段**。
 *
 * 为什么必须重试（2026-10-02 实测，不是理论担心）：
 *   Steam 的域名在国内不是"整体通/整体不通"，而是**按解析到的 IP 分别表现**。
 *   连续请求 api.steampowered.com 的实测曲线是这样的：
 *       #1 ✗ 6014ms   #2 ✗ 6015ms   #3 ✗ 6011ms   #4 ✗ 6010ms
 *       #5 ✓  921ms   #6 ✓  103ms   #7 ✓  104ms  ...  #10 ✗ 6005ms
 *   —— 失败不是"慢"，是**卡满超时**；一旦轮到可用 IP，100ms 就回来了。
 *   所以单发成功率约 50%，重试等于重新解析一次域名、重新赌一次 IP。
 *   实测重试 3 次能稳定取到数据；不重试则一半概率直接失败。
 */
let fetchImpl;                 // undefined = 还没探测过；null = 没有 Electron，用全局 fetch

/**
 * 用哪个 fetch 发请求。
 *
 * **优先用 Electron 的 `net.fetch`** —— 它走的是 **Chromium 的网络栈**，而 Chromium 在
 * Windows 上使用**系统根证书库**，于是能穿过 Steam 加速器（Watt Toolkit / Steam++ 之类）
 * 的本地反代；Node 自带的 fetch（undici + 内置 CA）不认加速器那张证书，会全盘失败。
 *
 * 为什么要专门适配（2026-10-03 实测）：用户开了 Watt Toolkit 之后，hosts 里
 * `store.steampowered.com` / `steamcommunity.com` 等被写死到 `127.0.0.1`，
 * 由它自己的进程监听 80/443 做反代 —— 浏览器里一切正常，但插件的请求全是
 * `UNABLE_TO_VERIFY_LEAF_SIGNATURE`。插件跑在主进程，用的就是 Node 的 fetch，
 * 所以用户"浏览器能打开 Steam"不代表插件能用。
 *
 * 拿不到（纯 node 环境、离线测试）就退回全局 fetch —— 测试里打桩 `globalThis.fetch`
 * 依然生效，因为这里读到的是**运行时**的全局值。
 */
async function getFetch() {
  if (fetchImpl !== undefined) return fetchImpl || fetch;
  try {
    const mod = await import('electron');
    const e = mod?.default ?? mod;
    fetchImpl = typeof e?.net?.fetch === 'function' ? e.net.fetch.bind(e.net) : null;
    if (fetchImpl) log('[Steam] 请求走 Electron 网络栈（可穿过 Steam 加速器的本地反代）');
  } catch { fetchImpl = null; }
  return fetchImpl || fetch;
}

async function fetchJson(url, { timeoutMs = DEFAULTS.timeoutMs, retries = DEFAULTS.retries, init = {} } = {}) {
  let lastError = null;
  const tries = Math.max(1, retries);
  const doFetch = await getFetch();
  for (let i = 0; i < tries; i++) {
    try {
      const res = await doFetch(url, {
        ...init,
        headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9', ...(init.headers || {}) },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (error) {
      lastError = error;
      // 最后一次失败就不用再等了
      if (i < tries - 1) log(`[Steam] 第 ${i + 1}/${tries} 次失败（${shortError(error)}），重试中…`);
    }
  }
  throw lastError;
}

/**
 * 错误压成人话，顺带保证内部栈/URL 不外流到群里。
 *
 * ⚠️ 必须连 `cause` 一起读：undici 把真实错误包在 `TypeError: fetch failed` 里，
 *    真正的原因（`UNABLE_TO_VERIFY_LEAF_SIGNATURE` 之类）在 `error.cause.code`。
 *    只看 `message` 的话，所有网络/TLS 故障都会显示成笼统的"fetch failed"，
 *    用户没法判断是"Steam 挂了"还是"自己网络的问题"（2026-10-03 实测踩到）。
 */
function shortError(error) {
  const msg = String(error?.cause?.code || error?.cause?.message || error?.message || error);
  // TLS 证书验证失败：本机网络受限导致（通常是证书吊销检查连不出去），
  // 表现是**所有请求 0ms 立即失败** —— 用户很容易误以为插件坏了或 Steam 挂了。
  if (/UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_|SELF_SIGNED|DEPTH_ZERO|certificate/i.test(msg)) {
    return '本机 TLS 证书验证失败 —— 不是 Steam 的问题。\n'
      + '最常见的原因是**开着 Steam 加速器**（Watt Toolkit / Steam++ 之类）：它会把 Steam 域名'
      + '劫持到 127.0.0.1 并用它自己的证书，Node 不认。先关掉加速器再试 —— '
      + 'Steam 商店和 API 在国内通常能直连，只有社区页（申请密钥用）才需要加速。';
  }
  if (/abort|timeout/i.test(msg)) return '请求超时';
  if (/HTTP 4\d\d/.test(msg)) return `Steam 拒绝了这次请求（${msg}，接口可能变了）`;
  if (/HTTP 5\d\d/.test(msg)) return 'Steam 服务端出错';
  if (/fetch failed|ENOTFOUND|ECONN|EAI_AGAIN|UND_ERR/i.test(msg)) return '连不上 Steam（网络问题）';
  return msg.slice(0, 60);
}

// ── 三个查询 ────────────────────────────────────────────────────────────
/** 按名字搜游戏，返回最多 10 条（Steam 该接口的硬上限）。 */
async function searchApp(keyword, s) {
  const url = `${EP_SEARCH}?term=${encodeURIComponent(keyword)}&cc=${encodeURIComponent(s.countryCode)}&l=${encodeURIComponent(s.language)}`;
  const json = await fetchJson(url, { timeoutMs: s.timeoutMs, retries: s.retries });
  const items = Array.isArray(json?.items) ? json.items : [];
  return items.map((it) => ({
    id: String(it?.id ?? '').trim(),
    name: String(it?.name ?? '').trim(),
    type: String(it?.type ?? '').trim(),
    metascore: Number(it?.metascore) || null,
    // tiny_image 是商店缩略图（有外链，但卡片不用它，避免离屏渲染等外链图片）
    image: String(it?.tiny_image ?? '').trim(),
    price: normalizePrice(it?.price)
  })).filter((it) => it.id && it.name);
}

/** price 对象（storesearch 与 appdetails 都有）→ 统一形状。价格一律除 100。 */
function normalizePrice(p) {
  if (!p || typeof p !== 'object') return null;
  const initial = Number(p.initial);
  const final = Number(p.final);
  if (!Number.isFinite(final)) return null;
  return {
    currency: String(p.currency ?? '').trim(),
    initial: Number.isFinite(initial) ? initial / 100 : null,
    final: final / 100,
    discount: Number(p.discount_percent) || 0,
    // 有折扣时 Steam 会给这个现成字符串，没有就自己拼
    formatted: String(p.final_formatted ?? '').trim() || null
  };
}

/** 查详情。appids 传数组可批量（配合 filters=price_overview，实测 4 个一起返回正常）。 */
async function fetchDetails(appids, s, { priceOnly = false } = {}) {
  const ids = (Array.isArray(appids) ? appids : [appids]).map(String).filter(Boolean);
  if (!ids.length) return {};
  const filters = priceOnly ? '&filters=price_overview' : '';
  const url = `${EP_DETAIL}?appids=${ids.join(',')}&cc=${encodeURIComponent(s.countryCode)}&l=${encodeURIComponent(s.language)}${filters}`;
  const json = await fetchJson(url, { timeoutMs: s.timeoutMs, retries: s.retries });
  const out = {};
  for (const id of ids) {
    const entry = json?.[id];
    if (!entry || entry.success !== true || !entry.data) { out[id] = null; continue; }
    const d = entry.data;
    out[id] = {
      id,
      name: String(d.name ?? '').trim(),
      type: String(d.type ?? '').trim(),
      isFree: d.is_free === true,
      // ⚠️ 免费游戏**没有** price_overview —— 上面 isFree 就是为这个判断存在的
      price: normalizePrice(d.price_overview),
      // 未发售时 price_overview 也可能缺席，用 coming_soon 区分
      comingSoon: d.release_date?.coming_soon === true,
      releaseDate: String(d.release_date?.date ?? '').trim(),
      developers: (d.developers || []).map(String).slice(0, 3),
      publishers: (d.publishers || []).map(String).slice(0, 3),
      genres: (d.genres || []).map((g) => String(g?.description ?? '')).filter(Boolean).slice(0, 4),
      platforms: {
        windows: d.platforms?.windows === true,
        mac: d.platforms?.mac === true,
        linux: d.platforms?.linux === true
      },
      metacritic: Number(d.metacritic?.score) || null,
      recommendations: Number(d.recommendations?.total) || null,
      shortDescription: String(d.short_description ?? '').trim(),
      // 卡片上用 header_image 会引入外链依赖（离屏渲染要等图），这里只留 URL 备用
      headerImage: String(d.header_image ?? '').trim(),
      storeUrl: `https://store.steampowered.com/app/${id}/`
    };
  }
  return out;
}

/** 查好评率。num_per_page=0 表示不要具体评论，只要汇总（省流量）。 */
async function fetchReviewSummary(appid, s) {
  const url = `${EP_REVIEW}${appid}?json=1&num_per_page=0&language=all&purchase_type=all`;
  const json = await fetchJson(url, { timeoutMs: s.timeoutMs, retries: s.retries });
  const q = json?.query_summary;
  if (!json?.success || !q) return null;
  const total = Number(q.total_reviews) || 0;
  const pos = Number(q.total_positive) || 0;
  if (!total) return null;
  return {
    scoreDesc: String(q.review_score_desc ?? '').trim(),
    total,
    positive: pos,
    percent: Math.round((pos / total) * 100)
  };
}

// ── 玩家接口（需要 Steam Web API Key）──────────────────────────────────
// 与上面的商店接口**完全不同的两套东西**：商店接口查"游戏"，不需要任何认证；
// 这里查"人"，必须有 key，而且**只能看到对方公开的资料**（隐私设置是硬门槛，
// 对方设了"仅好友可见"，你的 key 再对也拿不到数据 —— 这不是 bug，是 Steam 的规则）。
//
// ⚠️ 全部走 api.steampowered.com，而该域名在国内是**间歇可用**的（见 fetchJson 注释），
//    所以这里每个请求都复用了重试逻辑，失败也不会把整个指令带崩。
//
// ⚠️ 密钥留空 = 这一整块自动关闭（绑定/谁在玩/我的 会回一句"没配密钥"），
//    不影响查价和打折播报 —— 两者互不依赖。

const EP_API = 'https://api.steampowered.com';

/** 组一个带 key 的 Web API URL。key 只进 query，不进日志（log 里一律不打印 URL）。 */
function apiUrl(pathname, params, key) {
  const u = new URL(EP_API + pathname);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  }
  u.searchParams.set('key', key);
  u.searchParams.set('format', 'json');
  return u.toString();
}

/** SteamID64 形状：17 位、7656119 开头。 */
const isSteamId64 = (s) => /^7656119\d{10}$/.test(String(s || '').trim());

/**
 * 自定义 ID（个人资料 URL 里 /id/ 后面那段）→ SteamID64。
 * 已经是 SteamID64 就直接返回，省一次请求。
 */
async function resolveVanity(raw, s) {
  const v = String(raw || '').trim();
  if (isSteamId64(v)) return v;
  const json = await fetchJson(apiUrl('/ISteamUser/ResolveVanityURL/v1/', { vanityurl: v }, s.apiKey),
    { timeoutMs: s.timeoutMs, retries: s.retries });
  const r = json?.response;
  if (r?.success === 1 && r.steamid) return String(r.steamid);
  return null;
}

const PERSONA_STATE = {
  0: '离线', 1: '在线', 2: '忙碌', 3: '离开', 4: '打盹', 5: '想交易', 6: '想玩游戏'
};

/** 批量查资料。一次最多 100 个 steamid，够用。 */
async function fetchPlayers(steamids, s) {
  const ids = (Array.isArray(steamids) ? steamids : [steamids]).filter(Boolean).slice(0, 100);
  if (!ids.length) return [];
  const json = await fetchJson(apiUrl('/ISteamUser/GetPlayerSummaries/v2/', { steamids: ids.join(',') }, s.apiKey),
    { timeoutMs: s.timeoutMs, retries: s.retries });
  const players = json?.response?.players;
  if (!Array.isArray(players)) return [];
  return players.map((p) => ({
    steamid: String(p?.steamid ?? ''),
    name: String(p?.personaname ?? ''),
    profileUrl: String(p?.profileurl ?? ''),
    avatar: String(p?.avatarfull ?? p?.avatarmedium ?? ''),
    state: Number(p?.personastate) || 0,
    stateText: PERSONA_STATE[Number(p?.personastate) || 0] || '未知',
    // 正在玩的游戏名（只有"公开 + 正在玩"才有这两个字段）
    game: String(p?.gameextrainfo ?? '').trim(),
    gameId: String(p?.gameid ?? '').trim(),
    // 3 = 公开。非公开时 GetOwnedGames 会返回空，提前告诉用户比让他猜好
    public: Number(p?.communityvisibilitystate) === 3
  }));
}

/** 拥有游戏数 + 总时长 + 等级。注意总时长可能因隐私设置拿不到，全部按可选处理。 */
async function fetchPlayerStats(steamid, s) {
  const out = { games: null, playtimeHours: null, level: null, recent: [] };
  try {
    const owned = await fetchJson(apiUrl('/IPlayerService/GetOwnedGames/v1/',
      { steamid, include_appinfo: 1, include_played_free_games: 1 }, s.apiKey),
      { timeoutMs: s.timeoutMs, retries: s.retries });
    const r = owned?.response;
    if (r && Number.isFinite(Number(r.game_count))) out.games = Number(r.game_count);
    if (Array.isArray(r?.games)) {
      const total = r.games.reduce((n, g) => n + (Number(g?.playtime_forever) || 0), 0);
      if (total > 0) out.playtimeHours = Math.round((total / 60) * 10) / 10;
    }
  } catch (e) { log(`[Steam] 拥有游戏查询失败：${shortError(e)}`); }
  try {
    const lv = await fetchJson(apiUrl('/IPlayerService/GetSteamLevel/v1/', { steamid }, s.apiKey),
      { timeoutMs: s.timeoutMs, retries: s.retries });
    const n = Number(lv?.response?.player_level);
    if (Number.isFinite(n)) out.level = n;
  } catch (e) { log(`[Steam] 等级查询失败：${shortError(e)}`); }
  try {
    const rec = await fetchJson(apiUrl('/IPlayerService/GetRecentlyPlayedGames/v1/', { steamid, count: 5 }, s.apiKey),
      { timeoutMs: s.timeoutMs, retries: s.retries });
    const g = rec?.response?.games;
    if (Array.isArray(g)) {
      out.recent = g.slice(0, 5).map((x) => ({
        name: String(x?.name ?? ''),
        twoWeeks: Math.round(((Number(x?.playtime_2weeks) || 0) / 60) * 10) / 10
      })).filter((x) => x.name);
    }
  } catch (e) { log(`[Steam] 最近游玩查询失败：${shortError(e)}`); }
  return out;
}

// ── 绑定管理（QQ ↔ SteamID）─────────────────────────────────────────────
// 落盘在 data/steam-query-state.json 的 bindings 里。为什么不放配置里：
// 那是**用户数据**不是配置，混进 config.json 会被「发布脱敏」当成个人信息清掉
// （sanitize-release 会清 memberNotes 一类），而且 QQ 号本来也不该进配置。
function getBindings() {
  const b = readState().bindings;
  return b && typeof b === 'object' ? b : {};
}
function setBinding(qq, patch) {
  const b = { ...getBindings(), [String(qq)]: { ...(getBindings()[String(qq)] || {}), ...patch } };
  writeState({ bindings: b });
  return b[String(qq)];
}
function removeBinding(qq) {
  const b = { ...getBindings() };
  const had = Boolean(b[String(qq)]);
  delete b[String(qq)];
  writeState({ bindings: b });
  return had;
}

/** 取发起人的 QQ（从触发批最后一条非自己消息里）。 */
function senderIdFrom(ctx) {
  const entries = ctx?.session?.trigger || ctx?.session?.triggerEntries || [];
  const src = (Array.isArray(entries) ? entries : []).filter((m) => m && !m.self).slice(-1)[0];
  return String(src?.senderId ?? src?.userId ?? '').trim();
}

/** key 没配时的统一回复（把"怎么配"说清楚，别让人猜）。 */
const NO_KEY_HINT = '🔑 这个功能需要 Steam Web API Key，当前没配。\n'
  + '到控制台 → 插件 → Steam 查价 → 「Steam API 密钥」里填上即可。\n'
  + '申请地址：https://steamcommunity.com/dev/apikey（需要能访问 Steam 社区，可能要开代理）\n'
  + '⚠️ 申请需要非受限账号（消费过的号）；填好域名一栏可以写 localhost。\n'
  + '查价格、查折扣不需要密钥，现在就能用。';

/** 绑定：\steam 绑定 <自定义ID 或 SteamID64> */
async function bindReply(ctx, arg, s) {
  if (!s.apiKey) return { _directText: NO_KEY_HINT };
  const qq = senderIdFrom(ctx);
  if (!qq) return { _directText: '❌ 认不出你的 QQ 号，绑定失败。' };
  const raw = cleanKeyword(arg);
  if (!raw) {
    return { _directText: `用法：\\${COMMAND} 绑定 <你的 Steam 自定义 ID 或 SteamID64>\n`
      + `自定义 ID 就是你个人资料链接 steamcommunity.com/id/<这一段> 里的那串。\n`
      + `例：\\${COMMAND} 绑定 gaben` };
  }
  try {
    const steamid = await resolveVanity(raw, s);
    if (!steamid) return { _directText: `❌ 找不到「${raw}」这个 Steam 账号。检查一下自定义 ID 有没有写错。` };
    const [p] = await fetchPlayers([steamid], s);
    if (!p) return { _directText: '❌ 查到了 ID 但拿不到资料，稍后再试。' };
    setBinding(qq, { steamid, name: p.name, boundAt: Date.now() });
    const warn = p.public ? '' : '\n⚠️ 你的 Steam 资料不是公开的 —— 「谁在玩」「游戏时长」这类信息拿不到。'
      + '\n（Steam → 个人资料 → 编辑 → 隐私设置 → 把「游戏详情」改成公开）';
    return { _directText: `✅ 绑定成功：${p.name}（${steamid}）${warn}` };
  } catch (error) {
    return { _directText: `❌ 绑定失败：${shortError(error)}`, isError: true };
  }
}

function unbindReply(ctx) {
  const qq = senderIdFrom(ctx);
  if (!qq) return { _directText: '❌ 认不出你的 QQ 号，解绑失败。' };
  return { _directText: removeBinding(qq) ? '✅ 已解绑。' : '你还没绑定过 Steam 账号。' };
}

/** \steam 谁在玩 —— 列出绑定成员里"正在玩游戏"的人。 */
async function whoIsPlayingReply(s) {
  if (!s.apiKey) return { _directText: NO_KEY_HINT };
  const bindings = getBindings();
  const qqs = Object.keys(bindings);
  if (!qqs.length) {
    return { _directText: `还没有人绑定 Steam 账号。\n让想开黑的人在群里发：\\${COMMAND} 绑定 <你的 Steam 自定义 ID>` };
  }
  try {
    const ids = qqs.map((q) => bindings[q].steamid).filter(Boolean);
    const players = await fetchPlayers(ids, s);
    const byId = new Map(players.map((p) => [p.steamid, p]));
    const lines = [];
    const playing = [];
    const idle = [];
    const hidden = [];
    for (const qq of qqs) {
      const b = bindings[qq];
      const p = byId.get(b.steamid);
      if (!p) { idle.push(`${b.name || b.steamid}（查不到资料）`); continue; }
      if (p.game) { playing.push(`🎮 ${p.name} 正在玩《${p.game}》`); continue; }
      // ⚠️ 资料未公开的成员**不能显示成"离线"** —— 他很可能正在玩，只是 Steam 不告诉外人。
      //    把他混进"离线"里等于报错信息，2026-10-03 发现这个分支漏了（bindReply /
      //    myProfileReply 都提示过隐私问题，就这里没有）。
      if (!p.public) { hidden.push(`${p.name}（Steam 资料未公开，看不到在玩什么）`); continue; }
      idle.push(`${p.name} ${p.state === 0 ? '离线' : p.stateText}`);
    }
    lines.push(`🎮 群友 Steam 状态（${qqs.length} 人绑定）`);
    if (playing.length) lines.push('', ...playing);
    else if (hidden.length) lines.push('', '看不到有人在玩游戏（下面有成员的资料未公开）。');
    else lines.push('', '现在没有人在玩游戏。');
    if (hidden.length) lines.push('', ...hidden.map((x) => `· ${x}`));
    if (idle.length) lines.push('', ...idle.map((x) => `· ${x}`));
    return { _directText: lines.join('\n') };
  } catch (error) {
    return { _directText: `❌ 查询失败：${shortError(error)}`, isError: true };
  }
}

/** \steam 我的 —— 查自己的资料、等级、游戏数、最近在玩。 */
async function myProfileReply(ctx, s) {
  if (!s.apiKey) return { _directText: NO_KEY_HINT };
  const qq = senderIdFrom(ctx);
  const b = getBindings()[String(qq)];
  if (!b?.steamid) {
    return { _directText: `你还没绑定 Steam 账号。\n发一句：\\${COMMAND} 绑定 <你的 Steam 自定义 ID>` };
  }
  try {
    const [p] = await fetchPlayers([b.steamid], s);
    const stats = await fetchPlayerStats(b.steamid, s);
    const lines = [`🎮 ${p?.name || b.name || '未知'}${stats.level != null ? ` · Lv.${stats.level}` : ''}`];
    if (p) lines.push(`状态：${p.game ? `正在玩《${p.game}》` : p.stateText}`);
    if (stats.games != null) lines.push(`游戏库：${stats.games} 款${stats.playtimeHours != null ? ` · 累计 ${stats.playtimeHours} 小时` : ''}`);
    if (stats.recent.length) {
      lines.push('', '最近两周：');
      for (const g of stats.recent) lines.push(`· ${g.name}${g.twoWeeks ? ` — ${g.twoWeeks} 小时` : ''}`);
    }
    // ⚠️ 资料不公开时，游戏库/时长/最近游玩**必然**是空的（Steam 的隐私规则，不是故障）。
    //    不解释一句，用户只会看到"什么都没有"，以为插件坏了 ——
    //    2026-10-03 拿公开账号实测确认了这个分支（公开资料=否 → GetOwnedGames 返回空对象）。
    if (p && !p.public && stats.games == null && !stats.recent.length) {
      lines.push('', '⚠️ 你的 Steam 资料不是公开的，所以游戏库、时长、最近在玩都拿不到。');
      lines.push('（Steam → 个人资料 → 编辑 → 隐私设置 → 把「游戏详情」设为公开）');
    }
    if (b.steamid) lines.push('', `https://steamcommunity.com/profiles/${b.steamid}`);
    return { _directText: lines.join('\n') };
  } catch (error) {
    return { _directText: `❌ 查询失败：${shortError(error)}`, isError: true };
  }
}

// ── 展示 ────────────────────────────────────────────────────────────────
const money = (n, cur = 'CNY') => {
  if (n == null) return '—';
  const sym = cur === 'CNY' ? '¥' : cur === 'USD' ? '$' : '';
  const v = Number(n);
  return `${sym}${Number.isInteger(v) ? v : v.toFixed(2)}${sym ? '' : ` ${cur}`}`;
};

const platformText = (p) => {
  if (!p) return '—';
  const on = [];
  if (p.windows) on.push('Windows');
  if (p.mac) on.push('macOS');
  if (p.linux) on.push('Linux');
  return on.length ? on.join(' / ') : '—';
};

/** 价格那一行的文案（免费 / 未发售 / 折扣 / 原价 四种情况）。 */
function priceText(d) {
  if (d.comingSoon) return `尚未发售${d.releaseDate ? `（${d.releaseDate}）` : ''}`;
  if (d.isFree) return '免费游玩';
  if (!d.price) return '暂无价格信息';
  const p = d.price;
  if (p.discount > 0 && p.initial != null) {
    return `${money(p.final, p.currency)}（原价 ${money(p.initial, p.currency)}，-${p.discount}%）`;
  }
  return money(p.final, p.currency);
}

/** 纯文字版（渲染失败时的兜底，也是 renderCard 关掉时的输出）。 */
function formatText(d, review, s) {
  const lines = [`🎮 ${d.name}`];
  const meta = [d.type === 'dlc' ? 'DLC' : '', d.genres.join('、'), d.releaseDate].filter(Boolean);
  if (meta.length) lines.push(meta.join(' · '));
  lines.push(`💰 ${priceText(d)}`);
  if (s.showReviews && review) {
    lines.push(`⭐ ${review.scoreDesc || '评价'} · 好评率 ${review.percent}%（${review.total.toLocaleString('zh-CN')} 条）`);
  }
  if (d.metacritic) lines.push(`📊 Metacritic ${d.metacritic}`);
  lines.push(`🖥️ ${platformText(d.platforms)}`);
  if (d.developers.length) lines.push(`🏢 ${d.developers.join('、')}`);
  if (d.shortDescription) {
    const desc = d.shortDescription.length > 110 ? `${d.shortDescription.slice(0, 110)}…` : d.shortDescription;
    lines.push('', desc);
  }
  lines.push('', d.storeUrl);
  return lines.join('\n');
}

/**
 * 价格列表。
 *
 * `showAll` 区分两种场景，别混：
 *   · 手动查（\steam 打折 / 关注列表）→ showAll=true：**没打折的也要列出来**。
 *     用户打「关注列表」是想确认"我关注了啥"，只回一句"当前都没有打折"等于没回答
 *     （2026-10-03 实测：整条回复里一个游戏名都没有）。
 *   · 自动播报 → showAll=false：只列达线的，不然每天推一堆没打折的纯噪音。
 */
/** 文字版：一次多个游戏（卡片渲染不出来时的兜底，也是 renderCard 关掉时的输出）。 */
function formatTextItems(items, s, misses = []) {
  const tail = misses && misses.length ? `\n\n（没查到：${misses.join('、')}）` : '';
  if (items.length === 1) return formatText(items[0].d, items[0].review, s) + tail;
  const blocks = items.map(({ d, review }) => {
    const lines = [`🎮 ${d.name}`, `💰 ${priceText(d)}`];
    if (s.showReviews && review) {
      lines.push(`⭐ 好评率 ${review.percent}%（${review.total.toLocaleString('zh-CN')} 条）`);
    }
    lines.push(`🖥️ ${platformText(d.platforms)} · 发售 ${d.releaseDate || '—'}`);
    return lines.join('\n');
  });
  return blocks.join('\n\n') + tail;
}

function formatDealList(rows, { title, threshold = 0, showAll = false } = {}) {
  if (!rows.length) return `${title}\n关注列表里没有能查到价格的在售游戏。`;
  const onSale = rows.filter((r) => r.discount >= Math.max(1, threshold));
  const lines = [title];
  if (!onSale.length) {
    lines.push(threshold ? `暂无折扣达到 ${threshold}% 的游戏。` : '当前都没有打折。');
  } else {
    onSale.sort((a, b) => b.discount - a.discount);
    for (const r of onSale) {
      lines.push(`· ${r.name} — ${money(r.final, r.currency)}（原价 ${money(r.initial, r.currency)}，**-${r.discount}%**）`);
    }
  }
  const rest = rows.filter((r) => !onSale.includes(r));
  if (showAll && rest.length) {
    const cap = 15;
    lines.push('', '没打折的：');
    for (const r of rest.slice(0, cap)) {
      lines.push(`· ${r.name} — ${r.final != null ? money(r.final, r.currency) : '暂无价格'}`);
    }
    if (rest.length > cap) lines.push(`  ……另有 ${rest.length - cap} 个`);
  }
  lines.push(`（关注 ${rows.length} 个，查到价格 ${rows.filter((r) => r.final != null).length} 个）`);
  return lines.join('\n');
}

// ── 图片卡片 ────────────────────────────────────────────────────────────
// 渲染方式与 weather-card / mc-status 完全一致：离屏 BrowserWindow 载 HTML → capturePage。
// 骨架照抄 weather-card 的 renderPng（含两处实测踩出来的坑，注释保留）。
const CARD_W = 480;
let rendering = false;

// 深浅两套配色（2026-10-03 加，与 weather-card / mc-status 同款做法）。
// ⚠️ 折扣绿和品牌蓝在两种底色上要**分别调**：亮绿 #a4d007 放在白卡上根本看不清，
//    深蓝 #66c0f4 在白底上也发飘 —— 所以不是简单地把前景色反过来。
const THEMES = {
  dark: {
    pageBg: '#12161d',
    cardBg: '#1a2029',
    border: '#2b3441',
    title: '#eef2f7',
    text: '#c6cedb',
    dim: '#7d8797',
    accent: '#66c0f4',   // Steam 品牌蓝（深色底上提亮）
    sale: '#a4d007',     // Steam 折扣绿
    saleBg: '#2a3a0f'
  },
  light: {
    pageBg: '#eef1f5',
    cardBg: '#ffffff',
    border: '#dfe4ec',
    title: '#1c2430',
    text: '#3a4453',
    dim: '#6a7484',
    accent: '#1b6ab8',   // 白底上要压暗，否则发飘
    sale: '#4f8a00',     // 亮绿在白卡上看不清，压成深绿
    saleBg: '#e8f4d4'
  }
};
const DARK = THEMES.dark;

/**
 * 从配置/设置对象里取主题名 —— **只认 light，其余一律 dark**。
 * 抽出来是让 readSettings / buildCardHtml / renderPng 三处用同一个判据：
 * 早先只有 readSettings 做了 trim+小写，直接调 buildCardHtml 传 ' LIGHT ' 会掉进深色，
 * 表现为"配置填了浅色但卡片还是黑的"（测试抓到的）。
 */
const themeOf = (s) => (String(s?.theme ?? '').trim().toLowerCase() === 'light' ? 'light' : 'dark');

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * 生成卡片 HTML。支持**一次多个游戏**：items = [{ d, review }]。
 *
 *   · 1 个游戏 → 详细卡（价格 / 好评率 / Metacritic / 发售 / 平台 / 开发 / 简介）
 *   · 多个游戏 → 紧凑卡（每个游戏一块：名称 + 价格 + 好评率 + 发售·平台），块间一条分隔线
 *
 * ⚠️ 卡片宽度就是 CARD_W，**窗口也必须按 CARD_W 开**（见 renderPng）。
 *    早先窗口开了 `CARD_W * 2` 而内容只有 CARD_W —— 右边整整空掉一半，
 *    2026-10-03 主人报障"右边的空白太多了"。抄渲染代码时最容易只抄一半。
 */
function buildCardHtml(items, s) {
  const t = THEMES[themeOf(s)] || DARK;
  const list = (Array.isArray(items) ? items : [items]).filter((x) => x && x.d);
  const single = list.length === 1;

  const blocks = list.map(({ d, review }) => {
    const parts = [];
    parts.push(`<div class="head"><div class="name">${esc(d.name)}</div>`
      + `<div class="sub">${esc([d.type === 'dlc' ? 'DLC' : '', d.genres.join('、')].filter(Boolean).join(' · '))}</div></div>`);

    // ── 价格 ──
    if (d.comingSoon) {
      parts.push(`<div class="price"><div class="free">尚未发售</div><div class="rdate">${esc(d.releaseDate || '')}</div></div>`);
    } else if (d.isFree) {
      parts.push('<div class="price"><div class="free">免费游玩</div></div>');
    } else if (d.price) {
      const p = d.price;
      if (p.discount > 0 && p.initial != null) {
        parts.push(`<div class="price"><span class="off">-${p.discount}%</span>`
          + `<span class="old">${esc(money(p.initial, p.currency))}</span>`
          + `<span class="now">${esc(money(p.final, p.currency))}</span></div>`);
      } else {
        parts.push(`<div class="price"><span class="now">${esc(money(p.final, p.currency))}</span></div>`);
      }
    } else {
      parts.push('<div class="price"><span class="dimtxt">暂无价格信息</span></div>');
    }

    // ── 评价 ──
    if (s.showReviews && review) {
      parts.push(`<div class="row"><span class="k">好评率</span><span class="v">${review.percent}%`
        + `<span class="dimtxt"> · ${esc(review.scoreDesc || '')} · ${review.total.toLocaleString('zh-CN')} 条</span></span></div>`);
    }

    if (single) {
      if (d.metacritic) parts.push(`<div class="row"><span class="k">Metacritic</span><span class="v">${d.metacritic}</span></div>`);
      parts.push(`<div class="row"><span class="k">发售</span><span class="v">${esc(d.releaseDate || '—')}</span></div>`);
      parts.push(`<div class="row"><span class="k">平台</span><span class="v">${esc(platformText(d.platforms))}</span></div>`);
      if (d.developers.length) parts.push(`<div class="row"><span class="k">开发</span><span class="v">${esc(d.developers.join('、'))}</span></div>`);
      if (d.shortDescription) {
        const desc = d.shortDescription.length > 130 ? `${d.shortDescription.slice(0, 130)}…` : d.shortDescription;
        parts.push(`<div class="desc">${esc(desc)}</div>`);
      }
      parts.push(`<div class="foot">steamcommunity · appid ${esc(d.id)}</div>`);
    } else {
      // 多游戏时一行塞下"发售 · 平台"，别再堆字段 —— 否则一张卡长得没法看
      parts.push(`<div class="row"><span class="k">发售</span><span class="v">${esc(d.releaseDate || '—')}`
        + `<span class="dimtxt"> · ${esc(platformText(d.platforms))}</span></span></div>`);
    }

    return `<div class="block">${parts.join('')}</div>`;
  });

  // 查不到的游戏单独列在末尾（别静默吞掉，用户会以为漏查）
  const missRow = list.misses && list.misses.length
    ? `<div class="block miss">没查到的：${esc(list.misses.join('、'))}</div>`
    : '';

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:${t.pageBg};font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;padding:12px}
    .card{width:${CARD_W}px;background:${t.cardBg};border:1px solid ${t.border};border-radius:14px;padding:16px;color:${t.text}}
    .block+.block{border-top:1px solid ${t.border};margin-top:15px;padding-top:15px}
    .block.miss{color:${t.dim};font-size:12px}
    .head{border-bottom:1px solid ${t.border};padding-bottom:10px;margin-bottom:12px}
    .name{font-size:19px;font-weight:600;color:${t.title};line-height:1.3}
    .block+.block .name{font-size:17px}
    .sub{font-size:12px;color:${t.dim};margin-top:5px}
    .price{display:flex;align-items:baseline;gap:9px;margin-bottom:13px;flex-wrap:wrap}
    .off{background:${t.saleBg};color:${t.sale};font-size:14px;font-weight:600;padding:3px 8px;border-radius:5px}
    .old{color:${t.dim};font-size:13px;text-decoration:line-through}
    .now{color:${t.title};font-size:24px;font-weight:600}
    .free{color:${t.sale};font-size:22px;font-weight:600}
    .rdate{color:${t.dim};font-size:13px}
    .row{display:flex;gap:10px;font-size:13px;line-height:1.9}
    .k{color:${t.dim};width:72px;flex:none}
    .v{color:${t.text};flex:1}
    .dimtxt{color:${t.dim}}
    .desc{font-size:12px;color:${t.dim};line-height:1.65;margin-top:11px;padding-top:11px;border-top:1px solid ${t.border}}
    .foot{margin-top:11px;font-size:11px;color:${t.dim};text-align:right}
  </style></head><body><div class="card${single ? '' : ' multi'}">${blocks.join('')}${missRow}</div></body></html>`;
}

/**
 * 渲染成 PNG。返回 null 表示渲染不可用（非 Electron 环境、或出错了），
 * 调用方据此降级到文字版 —— 绝不因为"图没出来"就什么都不发。
 */
async function renderPng(items, s) {
  const t = THEMES[themeOf(s)] || DARK;
  let electron = null;
  try {
    const mod = await import('electron');
    electron = mod?.default ?? mod;
  } catch { return null; }
  if (!electron || typeof electron.BrowserWindow !== 'function') return null;
  if (rendering) return null;               // 单并发：避免同时开多个离屏窗口
  rendering = true;
  let win = null;
  try {
    win = new electron.BrowserWindow({
      show: false, skipTaskbar: true, frame: false, useContentSize: true,
      // ⚠️ 初始高度必须给小（220）。默认 800×600，而下面量高度用的 scrollHeight
      //    在**内容比视口矮**时返回视口高度 —— 矮卡会按 600 截图，下面一大截空白。
      width: CARD_W, height: 220,   // ⚠️ 必须等于内容宽度（见 buildCardHtml 的注释）
      // ⚠️ 必须设窗口背景色：scrollHeight 是整数，实际渲染高度可能带亚像素，
      //    窗口按整数设就差一点点，右/下会露出 1~2px 白线（Electron 默认窗口背景是白的）。
      // ⚠️ 窗口底色必须跟着主题走：浅色卡配深色窗口边框，截出来会露出一圈深边。
      backgroundColor: t.pageBg,
      webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: false, contextIsolation: true, nodeIntegration: false }
    });
    const tmpHtml = path.join(os.tmpdir(), 'qq-agent-steam-card.html');
    fs.writeFileSync(tmpHtml, buildCardHtml(items, s));
    await win.loadFile(tmpHtml);
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      win.webContents.once('paint', finish);
      setTimeout(finish, 400);
    });
    const h = await win.webContents.executeJavaScript(`(() => {
      const b = document.body;
      const card = document.querySelector('.card');
      const pad = parseFloat(getComputedStyle(b).paddingBottom || 0);
      const cardBottom = card ? card.getBoundingClientRect().bottom + pad : 0;
      return Math.ceil(Math.max(b.scrollHeight, b.offsetHeight, cardBottom));
    })()`);
    win.setContentSize(CARD_W, Math.max(120, (Number(h) || 600) + 1));   // +1 亚像素余量
    await new Promise((r) => setTimeout(r, 80));
    const png = (await win.webContents.capturePage()).toPNG();
    if (!png || png.length < 1000) throw new Error('截图为空');
    return png;
  } catch (error) {
    log(`Steam 卡片渲染失败：${error?.message ?? error}`);
    return null;
  } finally {
    try { win?.destroy?.(); } catch { /* 忽略 */ }
    rendering = false;
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────
/**
 * 从触发批里取指令之后的**全文**（游戏名带空格是常态，路由只取第一个词）。
 *
 * ⚠️ 必须**从后往前找"含这条指令的那一条"**，不能图省事取"批内最后一条"。
 *    QQ 群里消息是**成批**到达的：实测 2026-10-03 01:21:01 那个触发批是
 *      [「我准备眠了（）」, 「\Steam 死亡搁浅2」, 「[图片]」]
 *    —— 用户发完指令，别人紧跟着发了张图，于是"最后一条"变成了 `[图片]`，
 *    这里取不到 `\steam` → raw 为空 → 回一句**帮助页**。
 *    现象极具误导性：指令门槛明明命中了（批内确实有 `\steam`），会话里
 *    finishReason 也写着"指令直达"，用户看到的却是"我明明下了指令，它却回了帮助"。
 *    agent-task 早用同样思路修过（它的 commandEntryFrom），这里当时漏了。
 */
function fullBodyFrom(ctx) {
  const entries = ctx?.session?.trigger || ctx?.session?.triggerEntries || [];
  const list = (Array.isArray(entries) ? entries : []).filter((m) => m && !m.self);
  // 从后往前找第一条**带指令**的（[图片]、纯聊天的都会被跳过）
  const src = [...list].reverse().find((m) => /[\\/\uFF0F\uFF3C]\s*steam\b/i.test(String(m?.text || '')));
  const text = String(src?.text || '');
  if (!text) return '';
  // 半角 \ /、全角 ／ ＼ 都要认；带 i 是因为指令门槛会把命令转小写
  const m = /[\\/\uFF0F\uFF3C]\s*steam\b/i.exec(text);
  if (!m) return '';
  return cleanKeyword(text.slice(m.index + m[0].length));
}

/** 清洗用户输入：剥首尾成对尖括号（提示里写 <游戏名>，用户会把括号一起打进来）。 */
function cleanKeyword(raw) {
  let s = String(raw ?? '').trim();
  s = s.replace(/^[<\uFF1C\u300A\u300C\u3010]+/, '').replace(/[>\uFF1E\u300B\u300D\u3011]+$/, '');
  s = s.replace(/^[\s:\uFF1A,\uFF0C\u3001]+/, '').trim();
  return s.slice(0, 120);
}

/** 一次最多查几个 —— 再多就成了刷屏，而且每个都要过一遍搜索+评价接口。 */
const MAX_GAMES = 5;

/**
 * 把用户输入拆成多个游戏名。
 *
 * ⚠️ **只按逗号/顿号/分号拆，绝不按空格拆** —— 游戏名里带空格是常态
 *    （"Death Stranding 2"、"地铁 离乡"），按空格拆会把一个完整游戏名劈成两个。
 *    需求来自主人：`\steam 死亡搁浅2,死亡搁浅,地铁:离乡`。
 * ⚠️ 冒号**不拆** —— "地铁:离乡" 的冒号是游戏名的一部分（官方写法就带）。
 */
function parseKeywords(raw) {
  return String(raw || '')
    .split(/[,，、;；]+/)
    .map((x) => cleanKeyword(x))
    .filter(Boolean)
    .slice(0, MAX_GAMES);
}

/** 查询主流程。返回 { _directText } 时直达链路原样发回；返回 { image } 时发图。 */
async function runQuery(ctx, args = {}) {
  const s = readSettings();
  if (!s.enabled) return { content: 'Steam 查价已停用', isError: true };

  const raw = cleanKeyword(args?.keyword) || fullBodyFrom(ctx);
  if (!raw) return { _directText: usageText() };

  // ── 子命令：在查游戏之前先分流，避免把「关注/打折」当成游戏名去搜 ──
  if (/^(打折|特惠|关注列表|列表|我在关注|关注了啥|deal|deals|list)$/i.test(raw)) {
    return { _directText: await dealsReply(s) };
  }
  if (/^(谁在玩|谁在玩什么|开黑|who)$/i.test(raw)) return whoIsPlayingReply(s);
  if (/^(我的|我的资料|me|profile)$/i.test(raw)) return myProfileReply(ctx, s);
  if (/^(解绑|unbind)$/i.test(raw)) return unbindReply(ctx);
  {
    // 绑定：\steam 绑定 <id>。「绑定」和 id 之间允许有空格
    const m = /^(?:绑定|bind)\s+([\s\S]+)$/i.exec(raw);
    if (m) return bindReply(ctx, m[1], s);
    if (/^(?:绑定|bind)$/i.test(raw)) return bindReply(ctx, '', s);
  }
  {
    // 口头关注：\steam 关注 艾尔登法环
    // ⚠️ 必须放在「取关」之前无关紧要，但**必须放在查游戏之前** ——
    //    否则「关注」会被当成游戏名去搜，回一句"没搜到关注"。
    const m = /^(?:关注|订阅|盯一下|watch|add)\s+([\s\S]+)$/i.exec(raw);
    if (m) return watchAddReply(ctx, m[1], s);
    if (/^(?:关注|订阅|watch|add)$/i.test(raw)) return watchAddReply(ctx, '', s);
  }
  {
    // 取关：\steam 取关 艾尔登法环（参数可省，省了就把现有列表列出来让用户挑）
    const m = /^(?:取关|取消关注|不关注了?|移除|删掉|unwatch|remove|del)\s*([\s\S]*)$/i.exec(raw);
    if (m) return watchRemoveReply(ctx, m[1], s);
  }

  const now = Date.now();
  if (!takeRateSlot(now, s.maxPerMinute)) {
    return { _directText: `⏳ 查得太快了，每分钟最多 ${s.maxPerMinute} 次，缓一下再试。` };
  }

  try {
    // ── 支持一次多个游戏：`\steam A,B,C`（逗号/顿号/分号分隔，最多 MAX_GAMES 个）──
    const keywords = parseKeywords(raw);
    const misses = [];

    // 1) 逐个解析成 appid —— 搜索这步省不掉，得先拿到 id 才能查详情
    //    ⚠️ 要**按 appid 去重**：两个关键词解析到同一个游戏是常事
    //    （实测：国区搜「死亡搁浅」只返回一条，就是「死亡搁浅2」—— 原作在国区商店不可见），
    //    不去重的话同一张卡上会出现两遍同样的游戏，看着像 bug。
    const resolved = [];
    const seenAppid = new Set();
    for (const kw of keywords) {
      if (/^\d{3,10}$/.test(kw)) {
        if (seenAppid.has(kw)) continue;
        seenAppid.add(kw);
        resolved.push({ kw, appid: kw, name: '' });
        continue;
      }
      try {
        const found = await searchApp(kw, s);
        if (!found.length) { misses.push(kw); continue; }
        const hit = found[0];
        if (seenAppid.has(hit.id)) {
          log(`[Steam]「${kw}」解析到的是《${hit.name}》（${hit.id}），与前面重复，跳过`);
          continue;
        }
        seenAppid.add(hit.id);
        resolved.push({ kw, appid: hit.id, name: hit.name });
      } catch (e) {
        log(`[Steam]「${kw}」搜索失败：${shortError(e)}`);
        misses.push(kw);
      }
    }
    if (!resolved.length) {
      lastQuery = { keyword: raw, at: now, error: true };
      return {
        _directText: `🔍 Steam 没搜到「${keywords.join('、')}」。\n`
          + '换个写法试试：英文名通常更准（如 Elden Ring），或者少写副标题。'
      };
    }

    // 2) 逐个查详情。
    // ⚠️ 别想当然用批量：`appdetails` **只在带 filters 时才支持多个 appid**
    //    （`&filters=price_overview` 批量没问题，打折播报就是这么干的）；
    //    不带 filters 传多个 → **HTTP 400**，2026-10-03 真机实测踩到 ——
    //    而且它长得像"Steam 挂了"，其实是我们自己把请求拼错了。
    //    5 个游戏也就 5 次请求，逐个来最稳。
    const details = {};
    for (const r of resolved) {
      try {
        const one = await fetchDetails(r.appid, s);
        if (one[r.appid]) details[r.appid] = one[r.appid];
      } catch (e) {
        log(`[Steam]「${r.name || r.kw}」详情查询失败：${shortError(e)}`);
      }
    }

    // 3) 逐个补好评率（评价接口不支持批量，只能一个个来；失败不影响其它游戏）
    const items = [];
    for (const r of resolved) {
      const d = details[r.appid];
      if (!d) { misses.push(r.name || r.kw); continue; }
      let review = null;
      if (s.showReviews) {
        try { review = await fetchReviewSummary(r.appid, s); }
        catch (e) { log(`[Steam] 好评率查询失败（${r.name || r.kw}）：${shortError(e)}`); }
      }
      items.push({ d, review });
    }
    if (!items.length) {
      lastQuery = { keyword: raw, at: now, error: true };
      return { _directText: '❌ 拿不到这些游戏的详情（可能已下架，或该地区不可见）。' };
    }

    // 数组也是对象 —— 把"没查到的"挂上去，卡片和文字版都能读到（别静默吞掉）
    items.misses = misses;

    lastQuery = { keyword: raw, name: items[0].d.name, at: now, count: items.length, error: false };
    log(`[Steam]「${raw}」→ ${items.map((x) => `${x.d.name}(${x.d.id})${x.d.price ? ` ${priceText(x.d)}` : ''}`).join('；')}`
      + (misses.length ? ` ｜没查到：${misses.join('、')}` : ''));

    if (s.renderCard && !args?.noCard) {
      const png = await renderPng(items, s);
      if (png) {
        // ⚠️ 卡片必须**在这里自己发**，然后返回 `_cardSent: true`（2026-10-03 踩到）：
        //    直达链路只认 `_directText` / `_cardSent`（src/skills/command-router.js 的
        //    pickDirectText），**不认识 `image` 字段** —— 早先这里写成
        //    "把图塞进返回值交给链路"，结果卡片渲染成功时反而一条消息都不发：
        //    群里表现为"查了没反应"，而失败路径（网络错）会回文字，所以只有成功路径翻车，
        //    极难自查。正确姿势与 mc-status / weather-card 一致：工具内 sendImage + _cardSent。
        if (ctx?.sender?.sendImage && ctx?.chatKey) {
          try {
            await ctx.sender.sendImage(ctx.chatKey, { dataUrl: `base64://${png.toString('base64')}` }, { note: 'Steam 查价' });
            return { content: items.map((x) => x.d.name).join('、'), _cardSent: true };
          } catch (e) {
            log(`[Steam] 发卡失败，降级成文字：${shortError(e)}`);
          }
        } else {
          log('[Steam] 当前上下文没有 sender（如老框架兜底），降级成文字');
        }
      }
    }
    return { _directText: formatTextItems(items, s, misses) };
  } catch (error) {
    lastQuery = { keyword: raw, at: now, error: true };
    log(`[Steam]「${raw}」失败：${shortError(error)}`);
    return { _directText: `❌ 查询失败：${shortError(error)}`, isError: true };
  }
}

function usageText() {
  return `🎮 Steam 查价\n`
    + `· 查游戏：\\${COMMAND} 艾尔登法环　（也可以直接给 appid：\\${COMMAND} 1091500）\n`
    + `· 关注游戏：\\${COMMAND} 关注 艾尔登法环　（关注了才会进打折播报）\n`
    + `· 取消关注：\\${COMMAND} 取关 艾尔登法环\n`
    + `· 看折扣：\\${COMMAND} 打折　（列出关注列表里当前的折扣）\n`
    + `\n以下需要先配 Steam API 密钥：\n`
    + `· 绑定账号：\\${COMMAND} 绑定 <自定义ID>\n`
    + `· 我的资料：\\${COMMAND} 我的\n`
    + `· 谁在玩：\\${COMMAND} 谁在玩`;
}

// ── 打折播报 ────────────────────────────────────────────────────────────
function parseTargets(raw) {
  return String(raw || '').split(/[\s,，;；]+/).map((x) => x.trim()).filter((x) => /^\d{5,12}$/.test(x));
}

/**
 * 关注列表 → appid 列表。
 * 支持直接写 appid，也支持写名字（名字要过一次搜索）。
 * 名字解析结果**落盘缓存**，避免每次播报都重新搜一遍（也降低触发限流的概率）。
 */
// ── 关注列表：配置 + 口头，两份合一 ─────────────────────────────────────
// 为什么要两份：
//   · 配置里的 watchList 是"基础关注"（控制台填的，批量维护方便）
//   · 口头关注（群里 \steam 关注 xxx）是运行时数据
// 为什么不把口头关注直接写回配置：插件改配置要走 POST /api/config
// （直接改 data/config.json 不生效 —— 内存有缓存，而且控制台旧页面一保存就覆盖回去，
//  项目真实踩过这个坑）。口头关注和「绑定表」一样属于运行时数据，落 state 更自然。
//
// 最终列表 = (配置 watchList + state.watch) − state.hidden
//   hidden 这一层是**必需的**：否则口头取关不掉配置里配的那几项，
//   用户会以为取关坏了（"我明明取关了它还在播"）。
function getWatchState() {
  const st = readState();
  return {
    watch: Array.isArray(st.watch) ? st.watch.filter((x) => x && x.appid) : [],
    hidden: Array.isArray(st.hidden) ? st.hidden.map(String) : []
  };
}

/** 合并后的原始关注项（可能含"待解析的名字"，所以这里不保证有 appid）。 */
function effectiveWatch(s) {
  const { watch, hidden } = getWatchState();
  const cfgRaw = String(s.watchList || '').split(/[\r\n,，;；]+/).map((x) => x.trim()).filter(Boolean);
  const out = [];
  const seen = new Set();
  for (const x of watch) {
    const id = String(x.appid);
    if (seen.has(id) || hidden.includes(id)) continue;
    seen.add(id);
    out.push({ appid: id, name: String(x.name || '').trim(), from: '口头', by: String(x.by || '') });
  }
  for (const raw of cfgRaw) {
    if (/^\d{3,10}$/.test(raw)) {
      if (seen.has(raw) || hidden.includes(raw)) continue;
      seen.add(raw);
      out.push({ appid: raw, name: '', from: '配置' });
    } else {
      out.push({ raw, from: '配置' });          // 名字，留给 resolveWatchList 解析
    }
  }
  // 最多 80 个：防止有人塞几百条把接口打爆
  return out.slice(0, 80);
}

async function resolveWatchList(s) {
  const items = effectiveWatch(s);
  if (!items.length) return [];
  const { hidden } = getWatchState();
  const cache = readState().nameCache || {};
  const out = [];
  let dirty = false;
  for (const item of items) {
    // 已经知道 appid（口头关注的、或配置里直接写 appid 的）
    if (item.appid) { out.push({ appid: item.appid, name: item.name, from: item.from }); continue; }
    const key = String(item.raw).toLowerCase();
    if (cache[key]) {
      if (!hidden.includes(String(cache[key].appid))) {
        out.push({ appid: cache[key].appid, name: cache[key].name, from: item.from });
      }
      continue;
    }
    try {
      const found = await searchApp(item.raw, s);
      if (found.length) {
        cache[key] = { appid: found[0].id, name: found[0].name };
        dirty = true;
        if (!hidden.includes(found[0].id)) {
          out.push({ appid: found[0].id, name: found[0].name, from: item.from });
        }
        log(`[Steam] 关注列表：解析「${item.raw}」→ ${found[0].name}（${found[0].id}）`);
      } else {
        log(`[Steam] 关注列表：搜不到「${item.raw}」，跳过`);
      }
    } catch (e) {
      log(`[Steam] 关注列表：「${item.raw}」解析失败 ${shortError(e)}`);
    }
  }
  if (dirty) writeState({ nameCache: cache });
  // 去重（同一个游戏既写名字又写 appid 的情况）
  const seen = new Set();
  return out.filter((x) => (seen.has(x.appid) ? false : seen.add(x.appid)));
}

/** 批量查价（按 appid 去重，分批以免 URL 过长）。返回带名字的价格行。 */
async function checkDeals(s) {
  const watch = await resolveWatchList(s);
  if (!watch.length) return [];
  const rows = [];
  for (let i = 0; i < watch.length; i += 40) {                 // 每批 40 个，URL 不会太长
    const batch = watch.slice(i, i + 40);
    const details = await fetchDetails(batch.map((x) => x.appid), s, { priceOnly: true });
    for (const item of batch) {
      const d = details[item.appid];
      if (!d) continue;
      rows.push({
        appid: item.appid,
        // filters=price_overview 时**不返回 name**，所以名字优先用关注列表里记的
        name: d.name || item.name || `appid ${item.appid}`,
        from: item.from || '',
        isFree: d.isFree,
        currency: d.price?.currency || '',
        initial: d.price?.initial ?? null,
        final: d.price?.final ?? null,
        discount: d.price?.discount || 0
      });
    }
  }
  return rows;
}

async function dealsReply(s) {
  try {
    const rows = await checkDeals(s);
    if (!rows.length) {
      return `📋 关注列表还是空的。\n`
        + `在群里说一句就能加：\\${COMMAND} 关注 艾尔登法环\n`
        + `（也可以到控制台 → 插件 → Steam 查价 → 「打折关注列表」里批量填）`;
    }
    const from = rows.filter((r) => r.from === '口头').length;
    const tail = from ? `（其中 ${from} 个是群里口头关注的）` : '';
    return formatDealList(rows, {
      title: `🎮 关注列表（${rows.length} 个）${tail}：`,
      threshold: 0,
      showAll: true          // 手动查：没打折的也要列，否则用户看不到自己关注了啥
    });
  } catch (error) {
    return `❌ 查折扣失败：${shortError(error)}`;
  }
}

/**
 * 口头关注一个游戏：\steam 关注 艾尔登法环（也认 appid）。
 * 名字会先过一次搜索解析成 appid —— 这样播报时不用每次都搜。
 */
async function watchAddReply(ctx, arg, s) {
  const raw = cleanKeyword(arg);
  if (!raw) {
    return { _directText: `用法：\\${COMMAND} 关注 <游戏名 或 appid>\n`
      + `例：\\${COMMAND} 关注 艾尔登法环\n`
      + `看好之后用 \\${COMMAND} 打折 随时看折扣。` };
  }
  try {
    let appid = ''; let name = '';
    if (/^\d{3,10}$/.test(raw)) {
      appid = raw;
    } else {
      const found = await searchApp(raw, s);
      if (!found.length) {
        return { _directText: `🔍 Steam 没搜到「${raw}」。\n英文名通常更准（如 Elden Ring），或者少写副标题。` };
      }
      appid = found[0].id;
      name = found[0].name;
    }

    // 已经关注了就别重复加（把配置里的也算进去，不然会出现"加了但列表没变"）
    const now = await resolveWatchList(s);
    const dup = now.find((x) => x.appid === appid);
    if (dup) {
      return { _directText: `👌 《${dup.name || name || appid}》已经在关注列表里了（共 ${now.length} 个）。` };
    }

    const { watch, hidden } = getWatchState();
    const next = watch.filter((x) => String(x.appid) !== appid);
    next.push({ appid, name: name || raw, by: senderIdFrom(ctx) || '', at: Date.now() });
    // 顺便把"曾经取关过"的痕迹清掉 —— 否则重新关注会被 hidden 挡回去（列表里看不到）
    writeState({ watch: next, hidden: hidden.filter((h) => h !== appid) });
    log(`[Steam] 口头关注：${name || raw}（${appid}），现共 ${next.length} 个口头关注`);

    // 顺手查个当前价格，让"关注成功"这句话有信息量
    let price = '';
    try {
      const d = (await fetchDetails(appid, s))[appid];
      if (d) price = `\n当前：${priceText(d)}`;
      if (!name && d?.name) name = d.name;
    } catch { /* 查价失败不影响关注本身 */ }
    return { _directText: `✅ 已关注《${name || appid}》（appid ${appid}）${price}\n`
      + `现共关注 ${now.length + 1} 个 · 用 \\${COMMAND} 打折 看全部折扣` };
  } catch (error) {
    return { _directText: `❌ 关注失败：${shortError(error)}`, isError: true };
  }
}

/** 口头取关：\steam 取关 艾尔登法环。名字支持部分匹配（打几个字就行）。 */
async function watchRemoveReply(ctx, arg, s) {
  const raw = cleanKeyword(arg);
  if (!raw) {
    const items = await resolveWatchList(s);
    return { _directText: items.length
      ? `要取关哪个？当前关注：\n${items.map((x, i) => `${i + 1}. ${x.name || `appid ${x.appid}`}`).join('\n')}\n`
        + `用法：\\${COMMAND} 取关 <名字>`
      : `关注列表本来就是空的，没什么可取关的。` };
  }
  try {
    const items = await resolveWatchList(s);
    if (!items.length) return { _directText: '关注列表是空的，没什么可取关的。' };

    const key = raw.toLowerCase();
    const hit = /^\d{3,10}$/.test(raw)
      ? items.find((x) => x.appid === raw)
      : items.find((x) => (x.name || '').toLowerCase() === key)
        || items.find((x) => (x.name || '').toLowerCase().includes(key));

    if (!hit) {
      return { _directText: `关注列表里没有「${raw}」。\n当前关注：${items.map((x) => x.name || x.appid).join('、')}` };
    }

    const { watch, hidden } = getWatchState();
    // 两件事一起做：
    //   ① 从口头列表里删掉；
    //   ② 记进 hidden —— 这样**配置里配的那一项也会被屏蔽**（否则用户取关不掉，以为坏了）
    writeState({
      watch: watch.filter((x) => String(x.appid) !== hit.appid),
      hidden: [...new Set([...hidden, hit.appid])]
    });
    log(`[Steam] 口头取关：${hit.name || hit.appid}（${hit.appid}），剩 ${items.length - 1} 个`);
    return { _directText: `✅ 已取消关注《${hit.name || hit.appid}》\n`
      + `（配置里配过的同名游戏也一并屏蔽了；要恢复就再 \\${COMMAND} 关注 一次）` };
  } catch (error) {
    return { _directText: `❌ 取关失败：${shortError(error)}`, isError: true };
  }
}

// ── 播报状态落盘 ────────────────────────────────────────────────────────
// 为什么落盘：① 每日播报要记住"今天已经报过了"，否则重启就会重播；
// ② 名字→appid 的解析结果缓存，避免每次播报都重新搜一遍。
function dataDir() { return process.env.QQ_AGENT_DATA_DIR || path.join(ROOT, 'data'); }
function statePath() { return path.join(dataDir(), 'steam-query-state.json'); }
function readState() {
  try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')) || {}; } catch { return {}; }
}
function writeState(patch) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    const next = { ...readState(), ...patch };
    fs.writeFileSync(statePath(), JSON.stringify(next, null, 2), 'utf8');
  } catch (e) { log(`[Steam] 状态落盘失败：${e?.message ?? e}`); }
}

/** 本地日期字符串。⚠️ 不能用 toISOString —— 那是 UTC，北京时间凌晨会拿到前一天。 */
function localDay(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

let timer = null;
let broadcasting = false;

/** 到点了吗？返回 true 表示该播报了（同一分钟只触发一次，靠 lastRun 去重）。 */
function dueForBroadcast(s, now) {
  const t = String(s.broadcastTime || '').trim();
  if (!/^\d{1,2}:\d{2}$/.test(t)) return false;
  const [hh, mm] = t.split(':').map(Number);
  if (hh > 23 || mm > 59) return false;
  if (now.getHours() !== hh || now.getMinutes() !== mm) return false;
  const st = readState();
  const key = `${localDay(now)} ${t}`;
  return st.lastBroadcastKey !== key;
}

/** 执行一次播报。sender 由调用方给（setup 时拿不到）。 */
async function runBroadcast(s, sender, { force = false } = {}) {
  if (broadcasting) return;
  const targets = parseTargets(s.broadcastTargets);
  if (!targets.length) return;
  if (!sender?.sendTextBatch) return;
  broadcasting = true;
  try {
    const rows = await checkDeals(s);
    const onSale = rows.filter((r) => !r.isFree && r.discount >= Math.max(1, s.minDiscountPercent));
    const title = `🎮 Steam 打折播报（${localDay()}）`;
    const body = onSale.length
      ? formatDealList(rows, { title, threshold: s.minDiscountPercent })
      : `${title}\n关注列表里没有折扣达到 ${s.minDiscountPercent}% 的游戏。`;
    for (const chatKey of targets) {
      try {
        await sender.sendTextBatch(`group:${chatKey}`, [body], {});
      } catch (e) {
        log(`[Steam] 播报到 ${chatKey} 失败：${shortError(e)}`);
      }
    }
    if (!force) writeState({ lastBroadcastKey: `${localDay()} ${s.broadcastTime}` });
    log(`[Steam] 播报完成：${onSale.length} 个达线 / 共 ${rows.length} 个关注，目标 ${targets.length} 个群`);
  } catch (error) {
    log(`[Steam] 播报失败：${shortError(error)}`);
  } finally {
    broadcasting = false;
  }
}

/**
 * 开黑播报：定时看一眼绑定的群友有没有"刚开始玩某个游戏"，有就报一句。
 *
 * 为什么记 lastPlayState 而不是每次都报：Steam 的"正在玩"是个**状态**不是**事件**，
 * 每 30 分钟无脑播一次等于刷屏。只有"从没玩/换了个游戏"才算新事件。
 * 首次运行时 prev 是空的 → 会把当前正在玩的都当成新事件报一轮，这是想要的行为
 * （等于给群里一张"现在谁在玩"的初始快照）；之后重启也不会重报，因为状态已落盘。
 */
async function runPlayWatch(s, sender) {
  const targets = parseTargets(s.playWatchTargets || s.broadcastTargets);
  if (!targets.length || !sender?.sendTextBatch) return;
  const bindings = getBindings();
  const ids = Object.values(bindings).map((b) => b.steamid).filter(Boolean);
  if (!ids.length) return;
  try {
    const players = await fetchPlayers(ids, s);
    const prev = readState().lastPlayState || {};
    const next = {};
    const fresh = [];
    for (const p of players) {
      if (!p.steamid) continue;
      next[p.steamid] = p.game || '';
      const was = String(prev[p.steamid] ?? '');
      if (p.game && p.game !== was) fresh.push(p);
    }
    writeState({ lastPlayState: next, lastPlayCheck: Date.now() });
    if (!fresh.length) return;
    const body = fresh.length === 1
      ? `🎮 ${fresh[0].name} 开始玩《${fresh[0].game}》了，来开黑？`
      : `🎮 开黑播报\n${fresh.map((p) => `· ${p.name} 正在玩《${p.game}》`).join('\n')}`;
    for (const chatKey of targets) {
      try { await sender.sendTextBatch(`group:${chatKey}`, [body], {}); }
      catch (e) { log(`[Steam] 开黑播报发到 ${chatKey} 失败：${shortError(e)}`); }
    }
    log(`[Steam] 开黑播报：${fresh.map((p) => `${p.name}→${p.game}`).join('、')}`);
  } catch (error) {
    // 失败不写 lastPlayCheck —— 否则会白白跳过一整个检查周期
    log(`[Steam] 开黑播报失败：${shortError(error)}`);
  }
}

/** 距上次检查够久了吗（间隔可配，默认 30 分钟）。 */
function dueForPlayWatch(s) {
  const last = Number(readState().lastPlayCheck) || 0;
  return Date.now() - last >= s.playWatchIntervalMin * 60_000;
}

/** 每 30 秒看一眼有没有到点（和 weather-card 同一套做法，不精确定时不占资源）。 */
function startTimer(api) {
  stopTimer();
  timer = setInterval(() => {
    try {
      const s = readSettings();
      if (!s.enabled) return;
      if (dueForBroadcast(s, new Date())) runBroadcast(s, api?.sender).catch(() => {});
      if (s.playWatchEnabled && s.apiKey && dueForPlayWatch(s)) runPlayWatch(s, api?.sender).catch(() => {});
    } catch (e) { log(`[Steam] 定时检查出错：${e?.message ?? e}`); }
  }, 30 * 1000);
  // ⚠️ unref 不是可选项，漏了会拖垮整条测试链 —— 2026-10-02 实测踩到：
  //    `test/skill-test.mjs` 会 import 并加载**所有**插件，加载完就该退出；
  //    这个 timer 没 unref 就把进程钉在事件循环里，表现为 `npm test` 跑 10 分钟
  //    不结束（正常 3 分半），**而且没有任何报错**，极难定位。
  //    项目里其它所有带定时器的插件（weather-card / reminder / budget-guard /
  //    sticker-tagger / agent-task …）都加了 —— 新插件照抄时最容易漏掉这一行。
  //    unref 只影响"进程能否自然退出"，定时触发照常。
  timer.unref?.();
}
function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

// ── 生命周期 ────────────────────────────────────────────────────────────
// ⚠️ 这两个必须在 setup 之前声明（否则 setup 里赋值会踩 let 的暂时性死区）
let ROOT = '';
let senderRef = null;

export function setup(api) {
  cfgFn = api.config;
  log = (...a) => api.log?.(...a);
  ROOT = process.env.QQ_AGENT_PROJECT_DIR || process.cwd();
  // sender 由宿主注入到 api 上（weather-card 同款）；没有也能跑，只是不播报
  senderRef = api.sender || null;

  api.registerTool({
    id: 'steam_query',
    name: '查 Steam 游戏',
    description: '按名字或 appid 查 Steam 游戏的价格、折扣、好评率、发售日、平台。'
      + '由指令直达链路调用（用户发 @机器人 \\steam 游戏名），模型一般不会见到它。',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '游戏名或 appid。留空则从触发原文里取。' }
      }
    },
    async execute(ctx, args) {
      return runQuery(ctx, args);
    }
  });

  const s = readSettings();
  startTimer({ sender: senderRef });
  if (!s.enabled) log('已加载：当前未启用');
  else if (!s.watchList.trim()) log(`已加载（指令直达：@机器人 \\${COMMAND} 游戏名）。关注列表为空，打折播报未启用`);
  else if (!parseTargets(s.broadcastTargets).length) log(`已加载。关注列表有内容，但没填播报群号 → 只能手动 \\${COMMAND} 打折`);
  else if (!/^\d{1,2}:\d{2}$/.test(s.broadcastTime)) log('已加载。关注列表与群号都有，但没填播报时间 → 只支持手动查');
  else log(`已加载。每日 ${s.broadcastTime} 播报 ${parseTargets(s.broadcastTargets).length} 个群，折扣门槛 ${s.minDiscountPercent}%`);
  log(s.apiKey
    ? `  · 已配 API 密钥 → 绑定/谁在玩/我的 可用${s.playWatchEnabled ? `，开黑播报每 ${s.playWatchIntervalMin} 分钟检查一次` : ''}`
    : '  · 未配 API 密钥 → 只启用查价与打折播报（绑定/谁在玩/我的 需要密钥）');
}

export function deactivate() {
  stopTimer();
  resetRate();
  lastQuery = null;
  senderRef = null;
}

export const providers = {
  /** 状态卡「插件状态」区的一行。协议名固定 status.<目录名>，ai-status 按名字探测。 */
  'status.steam-query': () => {
    const s = readSettings();
    if (!s.enabled) return null;
    const { watch: oralWatch } = getWatchState();
    const cfgN = String(s.watchList || '').split(/[\r\n,，;；]+/).filter((x) => x.trim()).length;
    const bindN = Object.keys(getBindings()).length;
    return {
      icon: '🎮',
      title: 'Steam 查价',
      priority: 50,
      lines: [
        ['指令', `@机器人 \\${COMMAND} 游戏名`],
        ['最近查询', lastQuery
          ? `${lastQuery.keyword}${lastQuery.error ? '（失败）' : lastQuery.name ? ` → ${lastQuery.name}` : ''}`
          : '无'],
        ['关注', cfgN + oralWatch.length
          ? `${cfgN + oralWatch.length} 个（口头 ${oralWatch.length} / 配置 ${cfgN}）`
          : '还没关注任何游戏'],
        ['打折播报', s.broadcastTime ? `每日 ${s.broadcastTime}` : '未设时间'],
        ['玩家功能', s.apiKey ? `已配密钥 · ${bindN} 人绑定` : '未配密钥（绑定/谁在玩 不可用）']
      ]
    };
  }
};

// 内部函数暴露给离线测试（不对外提供能力，别依赖）
export const internals = {
  readSettings,
  takeRateSlot,
  resetRate,
  fetchJson,
  searchApp,
  fetchDetails,
  fetchReviewSummary,
  normalizePrice,
  priceText,
  platformText,
  formatText,
  formatDealList,
  buildCardHtml,
  parseKeywords,
  formatTextItems,
  MAX_GAMES,
  cleanKeyword,
  fullBodyFrom,
  parseTargets,
  resolveWatchList,
  effectiveWatch,
  getWatchState,
  watchAddReply,
  watchRemoveReply,
  checkDeals,
  dealsReply,
  runQuery,
  runBroadcast,
  runPlayWatch,
  dueForPlayWatch,
  localDay,
  shortError,
  // 玩家接口（需密钥）
  apiUrl,
  isSteamId64,
  resolveVanity,
  fetchPlayers,
  fetchPlayerStats,
  getBindings,
  setBinding,
  removeBinding,
  senderIdFrom,
  bindReply,
  unbindReply,
  whoIsPlayingReply,
  myProfileReply,
  readState,
  writeState,
  COMMAND,
  DEFAULTS
};

// ── 老框架兼容兜底 ──────────────────────────────────────────────────────
// 背景（同 netease-song-id / pc-control-l3）：插件是要分发的，别人的 QQ-agent
// 未必有「反斜杠指令接收」和「指令直达」。两者都失效时 \steam 没人接 ——
// 表现为"插件装了但指令没反应"，且不报错。这里手动接管。
//
// ⚠️ 判断必须是"键存在且为 true"：老框架 config 里根本没这个键，
//    写成 `!== false` 会把 undefined 当成"直达可用"而退位 —— 恰好在最需要兜底处不兜底。
let getConfigFn = null;
try {
  const m = await import('../../src/config.js');
  getConfigFn = typeof m.getConfig === 'function' ? m.getConfig : null;
} catch { /* 更老的框架：按"直达不可用"处理，走兜底 */ }

function directRouteAvailable() {
  let c = null;
  try { c = getConfigFn ? getConfigFn() : null; } catch { return false; }
  if (!c) return false;
  return typeof c.commandDirect === 'boolean' ? c.commandDirect === true : false;
}

function extractText(ev) {
  if (Array.isArray(ev?.message)) {
    return ev.message.map((s) => (s?.type === 'text' ? String(s?.data?.text ?? '') : '')).join('');
  }
  return String(ev?.raw_message ?? '');
}

const CMD_RE = /[\\/\uFF0F\uFF3C]\s*steam\b/i;

export const hooks = {
  // 基础 0.4 **没有 onMessage 钩子**，只有 before-context 是一直存在的。
  // before-context 拿不到 sender，所以把结果改写进命中消息的文本让模型转述。
  'before-context': (ctx) => {
    try {
      if (directRouteAvailable()) return;
      const entries = Array.isArray(ctx?.triggerEntries) ? ctx.triggerEntries : [];
      const hit = entries.filter((m) => m && !m.self).slice(-1)[0];
      if (!hit) return;
      const text = String(hit.text || '');
      if (!CMD_RE.test(text)) return;
      const fakeCtx = { chatKey: ctx.chatKey, kind: ctx.kind, session: { trigger: entries } };
      Promise.resolve()
        .then(() => runQuery(fakeCtx, { noCard: true }))      // 拿不到 sender，不出图
        .then((r) => {
          const out = r?._directText || (r?.isError ? r?.content : '');
          if (out) {
            hit.text = `${text}\n（系统提示：用户刚查了 Steam 游戏，结果是——\n${out}\n`
              + '请把上面这段结果原样转述给用户，不要解释机制，不要提"插件/钩子"这类词。）';
          }
        })
        .catch((e) => log('（老框架兜底）查价出错：' + (e?.message ?? e)));
    } catch (error) {
      log('（老框架兜底）before-context 出错：' + (error?.message ?? error));
    }
  },

  'onMessage': (ctx = {}) => {
    try {
      if (directRouteAvailable()) return;      // 直达可用 → 退位，避免双重回复
      const ev = ctx?.event || {};
      if (ev.post_type && ev.post_type !== 'message') return;
      const kind = ev.message_type === 'group' && ev.group_id != null ? 'group'
        : ev.message_type === 'private' && ev.user_id != null ? 'private' : '';
      if (!kind) return;
      const chatKey = kind === 'private' ? `private:${ev.user_id}` : `group:${ev.group_id}`;
      const text = extractText(ev).trim();
      if (!CMD_RE.test(text)) return;
      const senderId = String(ev.sender?.user_id ?? ev.user_id ?? '').trim();
      // 钩子在回复链路上**绝不能 await**：即发即走
      const fakeCtx = { chatKey, kind, session: { trigger: [{ self: false, senderId, text }] } };
      Promise.resolve()
        .then(() => runQuery(fakeCtx, {}))
        .then((r) => {
          const t = r?._directText || (r?.isError ? r?.content : '');
          if (t) ctx.sender?.sendTextBatch?.(chatKey, [t], {});
        })
        .catch((e) => log('onMessage 兜底出错：' + (e?.message ?? e)));
    } catch (error) {
      log('onMessage 兜底出错：' + (error?.message ?? error));
    }
  }
};
