// Steam 折扣抓取模块 —— 「近期史低好价」技能的数据层。
//
// ── 数据来源（全部实测通过，2026-10-02）────────────────────────────────
//
//  ① Steam 官方接口（直连即可，**不需要代理**）：
//     · /api/featuredcategories?cc=cn&l=schinese
//         → top_sellers（畅销榜，带 discount_percent / original_price / final_price）
//         → specials（特惠位，带 discount_expiration 折扣到期时间戳）
//     · /search/results/?specials=1&filter=topsellers&infinite=1
//         → total_count 约 8400 个打折游戏；results_html 里能抽 appid/标题/折扣/价格
//     · /appreviews/<appid>?json=1&language=all&purchase_type=all&num_per_page=0
//         → query_summary.total_reviews / review_score_desc，用来判"冷门"
//           实测并发 6 个仅 366ms，所以批量筛冷门很便宜
//
//  ② IsThereAnyDeal（ITAD）—— **史低的唯一来源**，Steam 官方不提供历史价：
//     · POST /lookup/id/shop/61/v1   body: ["app/730"]      → ITAD UUID
//     · POST /games/prices/v3        body: [uuid,...]       → historyLow + deals
//         historyLow.all.amountInt  = 全部时间历史最低（货币最小单位，CNY 即分）
//         deals[].price.amountInt   = 当前价
//         deals[].storeLow.amountInt= 该商店历史最低
//         deals[].expiry            = 折扣到期时间（用于掠过过期信息）
//     ⚠️ ITAD 条款要求注明数据来源并保留链接 —— 输出里必须带 IsThereAnyDeal 署名。
//     ⚠️ key 通过 query ?key= 或请求头 ITAD-API-Key 都可以（两种都实测 200）。
//
// ── 史低判定（这里是本项目最容易写错的地方，别凭直觉改）─────────────────
//   实测反例：赛博朋克 2077 某次 现价 8940 / 全部史低 8900 —— 只差 4 毛钱。
//   写成 `现价 <= 史低` 就会把它错标成"新史低"。正确口径是：
//     现价 <  全部史低 → newLow 「新史低」（首次跌破）
//     现价 == 全部史低 → tieLow 「平史低」（与历史最低持平）
//     现价 >  全部史低 → null（只是普通折扣，不许标史低）

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// 中文译名解析：Steam 官中 → 核实过的词典 → DeepSeek（见 game-names.js 文件头）
import { cleanTitle, hasChinese, lookupDict, translateViaDeepSeek } from './game-names.js'

const STEAM = 'https://store.steampowered.com'
const ITAD = 'https://api.isthereanydeal.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

/** 封面图与汇率缓存的落盘目录：系统临时目录（不能写技能目录，会触发核心热重载）。 */
const CACHE_DIR = path.join(os.tmpdir(), 'qqa-steam-deals')

let cfgOf = () => ({})
let log = () => {}
/** 核心配置模块（用于读 pixiv 插件里已配好的代理；在文件后段预热）。 */
let coreCfgRef = null

export function initSteam({ config, log: logFn } = {}) {
  if (typeof config === 'function') cfgOf = config
  if (typeof logFn === 'function') log = logFn
}

async function getJson(url, timeoutMs = 25000) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return JSON.parse(await r.text())
}

/* ══════════════════════════════════════════════════════════════════════
   一·B、带代理兜底的请求
   ══════════════════════════════════════════════════════════════════════ */

/**
 * Steam 请求：**直连优先，被限流就自动切代理**。
 *
 * ⚠️ 实测（2026-10-02）：连续抓取一段时间后，Steam 会对本机直连 IP 返回 403
 *    （三个接口同时 403），而换代理出口立刻恢复 200。所以不能假设"直连永远通"。
 *    代理直接复用用户在 pixiv 插件里已配好的那个（socks5h://127.0.0.1:10808），
 *    不用额外填。只在直连失败时才动用它。
 *
 * 用 curl 而不是 fetch 的原因：curl 支持 socks5 代理，Node 的 undici 不支持。
 */
function curlJson(url, proxy, timeoutMs) {
  return new Promise((resolve) => {
    const args = ['-sS', '-L', '--max-time', String(Math.max(3, Math.ceil(timeoutMs / 1000))),
      '--ssl-no-revoke',                       // 本机证书吊销检查过不去，见 downloadCover 注释
      '-H', `User-Agent: ${UA}`,
      '-H', 'Accept-Language: zh-CN,zh;q=0.9']
    if (proxy) args.push('--proxy', proxy)
    args.push(url)
    execFile('curl.exe', args, { maxBuffer: 32 * 1024 * 1024, encoding: 'utf8', windowsHide: true, timeout: timeoutMs + 8000 },
      (err, stdout) => {
        if (err) return resolve({ ok: false, error: String(err.message || err).slice(0, 120) })
        const text = String(stdout || '')
        if (!text) return resolve({ ok: false, error: '空响应' })
        // curl -sS 对 4xx/5xx 不报错，所以自己看响应体判断
        if (/^\s*<(!doctype|html)/i.test(text) && /403|Forbidden|Access Denied/i.test(text.slice(0, 800))) {
          return resolve({ ok: false, error: 'HTTP 403', forbidden: true })
        }
        try {
          return resolve({ ok: true, data: JSON.parse(text) })
        } catch {
          return resolve({ ok: false, error: '响应不是 JSON' })
        }
      })
  })
}

/** 代理地址：复用 pixiv 插件里已经配好的那个（用户不用再填一遍）。 */
let lastProxy403 = 0
async function warmCoreConfig() {
  if (coreCfgRef) return coreCfgRef
  try {
    coreCfgRef = await import('../../src/config.js')
  } catch (e) {
    coreCfgRef = null
    log(`读不到核心配置（代理将用默认地址）：${String(e?.message || e).slice(0, 80)}`)
  }
  return coreCfgRef
}

function steamProxy() {
  try {
    const core = coreCfgRef?.getConfig?.()
    const p = String(core?.skills?.['pixiv-image-tagsearch']?.proxy || '').trim()
    return p || 'socks5h://127.0.0.1:10808'
  } catch {
    return 'socks5h://127.0.0.1:10808'
  }
}

/**
 * 抓 Steam 的 JSON。直连优先；一旦直连被 403，**60 秒内后续请求直接用代理**，
 * 不再每次白撞一次（连续查询时能省掉一半往返）。
 */
async function steamJson(url, timeoutMs = 25000) {
  const proxy = steamProxy()
  const recentlyBlocked = Date.now() - lastProxy403 < 60000

  if (!recentlyBlocked) {
    const direct = await curlJson(url, '', timeoutMs)
    if (direct.ok) return direct.data
    if (direct.forbidden) {
      lastProxy403 = Date.now()
      log('直连被 Steam 限流(403)，改用代理重试')
    } else if (!proxy) {
      throw new Error(direct.error)
    }
  }

  const viaProxy = await curlJson(url, proxy, timeoutMs)
  if (viaProxy.ok) return viaProxy.data
  throw new Error(viaProxy.error || '代理请求失败')
}

async function itadPost(path, body, query = {}, timeoutMs = 30000) {
  const key = String(cfgOf()?.itadKey ?? '').trim()
  if (!key) return { ok: false, error: '没有配置 ITAD API Key（技能设置里的「ITAD API Key」）' }
  const url = new URL(`${ITAD}${path}`)
  url.searchParams.set('key', key)
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v))
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    })
    const text = await r.text()
    if (!r.ok) {
      let reason = `HTTP ${r.status}`
      try { reason = JSON.parse(text)?.reason_phrase || reason } catch { /* 非 JSON */ }
      return { ok: false, error: reason }
    }
    return { ok: true, data: JSON.parse(text) }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
}

/* ══════════════════════════════════════════════════════════════════════
   〇、游戏分类（Steam tags）
   ══════════════════════════════════════════════════════════════════════ */

/**
 * 分类 → Steam tag id。
 *
 * ⚠️ 必须用 **tags**，不能用 genre：实测（2026-10-02）
 *    `search/results?...&genre=9`（竞速）返回 total_count=8446、前几名是
 *    赛博朋克2077/极限竞速/星露谷 —— 跟不传 genre 完全一样，等于**没生效**；
 *    而 `&tags=699`（竞速）返回 301 条，前几名是极限竞速5/6、GTA V、极限国度、
 *    Steep —— 这才是真赛车。所以分类筛选一律走 tags。
 *
 * 另外实测：appdetails **不返回 tags 字段**，商店页面 HTML 里也抽不到
 * `/tags/<id>/<名称>` 链接（都是 JS 渲染的），所以 tag id 只能内置映射表。
 * 下面每个 id 都用"查询总数 + 前几名对照"验证过是合理分类（见开发时的实测记录）。
 */
export const GENRE_TAGS = {
  action:        { id: 19,   name: '动作',     aliases: ['动作', '动作游戏', 'act', 'action', 'act游戏'] },
  adventure:     { id: 21,   name: '冒险',     aliases: ['冒险', 'adventure', 'avg'] },
  rpg:           { id: 122,  name: '角色扮演', aliases: ['角色扮演', 'rpg', '扮演', 'jrpg', 'arpg', 'roleplay', 'role playing', '角色扮演游戏'] },
  strategy:      { id: 1742, name: '策略',     aliases: ['策略', '战略', 'strategy', 'slg', 'rts'] },
  simulation:    { id: 599,  name: '模拟',     aliases: ['模拟', 'simulation', 'sim', '经营', '模拟经营'] },
  racing:        { id: 699,  name: '竞速',     aliases: ['竞速', '赛车', '赛车游戏', 'racing', 'race', '驾驶', '开车'] },
  sports:        { id: 701,  name: '体育',     aliases: ['体育', '运动', 'sports'] },
  shooter:       { id: 1774, name: '射击',     aliases: ['射击', 'fps', 'shooter', '枪战', '打枪'] },
  indie:         { id: 492,  name: '独立',     aliases: ['独立', 'indie'] },
  casual:        { id: 597,  name: '休闲',     aliases: ['休闲', 'casual', '轻松'] },
  horror:        { id: 1667, name: '恐怖',     aliases: ['恐怖', '惊悚', 'horror', '吓人'] },
  puzzle:        { id: 1664, name: '解谜',     aliases: ['解谜', 'puzzle', '解密'] },
  openworld:     { id: 1695, name: '开放世界', aliases: ['开放世界', '沙盒', 'openworld', 'open world', '沙箱'] },
  coop:          { id: 1685, name: '合作',     aliases: ['合作', '联机', 'coop', 'co-op', '多人合作'] },
  anime:         { id: 4085, name: '动漫',     aliases: ['动漫', '二次元', 'anime', '日系'] },
  roguelike:     { id: 1716, name: 'Roguelike', aliases: ['roguelike', 'rogue', '肉鸽', '类rogue'] },
  sandbox:       { id: 3810, name: '沙盒建造', aliases: ['建造', '沙盒建造', 'craft', 'crafting', 'production'] },
  survival:      { id: 1662, name: '生存',     aliases: ['生存', 'survival', '求生'] },
  moba:          { id: 1718, name: 'MOBA',     aliases: ['moba', 'dota', 'lol'] },
  mmo:           { id: 128,  name: '大型多人在线', aliases: ['mmo', 'mmorpg', '网游'] },
  visualnovel:   { id: 3799, name: '视觉小说', aliases: ['视觉小说', 'galgame', 'gal', 'visual novel'] },
  platformer:    { id: 1625, name: '平台跳跃', aliases: ['平台', '平台跳跃', 'platformer', '跳跃'] },
  fighting:      { id: 1743, name: '格斗',     aliases: ['格斗', 'ftg', 'fighting', '拳皇'] },
  stealth:       { id: 1687, name: '潜行',     aliases: ['潜行', 'stealth', '暗杀'] },
  citybuilder:   { id: 4321, name: '城市营造', aliases: ['城建', '城市营造', 'city', '城市建造'] },
  farming:       { id: 8791, name: '农场模拟', aliases: ['农场', '种田', 'farming', 'agriculture'] },
  soulslike:     { id: 29482, name: '魂类',    aliases: ['魂类', 'souls', 'soulslike', '类魂'] },
  deckbuilder:   { id: 32322, name: '卡牌构筑', aliases: ['卡牌', '卡牌构筑', 'deck', 'deckbuilder', 'rouge卡牌'] },
  tps:           { id: 1827, name: '第三人称射击', aliases: ['tps', '第三人称射击'] },
  arcade:        { id: 1773, name: '街机',     aliases: ['街机', 'arcade'] },
  party:         { id: 5375, name: '派对',     aliases: ['派对', 'party', '聚会'] },
  psychological: { id: 21978, name: '心理恐怖', aliases: ['心理恐怖'] },
  bullethell:    { id: 3944, name: '弹幕射击', aliases: ['弹幕', '弹幕射击', 'bullet'] },
  boardgame:     { id: 4763, name: '桌游',     aliases: ['桌游', 'board game'] },
  pixel:         { id: 3964, name: '像素图形', aliases: ['像素', '像素风', 'pixel'] },
  cyberpunk:     { id: 4094, name: '赛博朋克', aliases: ['赛博朋克', 'cyberpunk'] },
  martialarts:   { id: 6915, name: '武侠',     aliases: ['武侠', '功夫', 'martial'] },
  space:         { id: 12472, name: '太空',     aliases: ['太空', 'space', '星际'] },
  detective:     { id: 2533, name: '推理',     aliases: ['推理', '探案', 'detective'] },
  music:         { id: 1752, name: '音乐/节奏', aliases: ['音乐', '音游', '节奏', 'rhythm', 'music'] },
  fishing:       { id: 23984, name: '钓鱼',    aliases: ['钓鱼', 'fishing'] }
}

/** 归一化分类输入，便于模糊匹配。 */
function normGenre(s) {
  return String(s || '').toLowerCase().replace(/[\s_\-·、,，。.]/g, '').trim()
}

/**
 * 把用户说的分类解析成 { key, id, name }。认不出返回 null。
 * 支持：中文风格名（"赛车"）、分类 key（"racing"）、英文别名（"race"）。
 */
export function resolveGenre(input) {
  const raw = normGenre(input)
  if (!raw) return null
  // 精确别名
  for (const [key, meta] of Object.entries(GENRE_TAGS)) {
    if (normGenre(key) === raw) return { key, id: meta.id, name: meta.name }
    for (const a of meta.aliases) if (normGenre(a) === raw) return { key, id: meta.id, name: meta.name }
  }
  // 包含匹配（"来个赛车的" / "我想玩射击类"）
  for (const [key, meta] of Object.entries(GENRE_TAGS)) {
    if (raw.includes(normGenre(meta.name))) return { key, id: meta.id, name: meta.name }
    for (const a of meta.aliases) {
      const na = normGenre(a)
      if (na.length >= 2 && raw.includes(na)) return { key, id: meta.id, name: meta.name }
    }
  }
  return null
}

/** 列出可用的分类名（给"有哪些分类"这类提问用）。 */
export function listGenreNames() {
  return Object.values(GENRE_TAGS).map((m) => m.name)
}

/* ══════════════════════════════════════════════════════════════════════
   一、Steam 候选池
   ══════════════════════════════════════════════════════════════════════ */

// 列表缓存：畅销榜/特惠/搜索列表 10 分钟内不会变，没必要每次查询都重抓。
// 实测：不缓存时每次查询要多花 6~8 秒在这三组请求上。
const LIST_TTL = 10 * 60 * 1000
const listCache = new Map()

async function cachedList(key, loader) {
  const hit = listCache.get(key)
  if (hit && Date.now() - hit.at < LIST_TTL) return hit.value
  const value = await loader()
  if (value && value.length) listCache.set(key, { at: Date.now(), value })
  return value
}

/** 畅销榜 + 特惠位。返回 [{ appid, name, cut, final, original, expiry, from }] */
async function fetchFeatured() {
  return cachedList('featured', async () => {
    const out = []
    try {
      const d = await steamJson(`${STEAM}/api/featuredcategories?cc=cn&l=schinese`)
      for (const [key, tag] of [['top_sellers', '畅销榜'], ['specials', '特惠']]) {
        for (const it of d?.[key]?.items || []) {
          const cut = Number(it.discount_percent) || 0
          if (cut <= 0) continue          // 没打折的直接跳过
          out.push({
            appid: Number(it.id),
            name: String(it.name || '').trim(),
            cut,
            final: Number(it.final_price) || 0,
            original: Number(it.original_price) || 0,
            expiry: Number(it.discount_expiration) || 0,
            from: tag
          })
        }
      }
    } catch (e) {
      log(`取畅销榜/特惠失败：${e?.message || e}`)
    }
    return out
  })
}

// 「每次换一批」的轮转状态：记录每个分类（或"全部"）已经被查询过多少次，
// 据此在候选排序结果里做偏移，让每次 @ 出来的那批游戏不一样。
// 进程内计数即可 —— 重启后从第一批重新开始是可接受的。
const rotationCounter = new Map()
function nextRotation(key) {
  const n = rotationCounter.get(key) || 0
  rotationCounter.set(key, n + 1)
  return n
}

/**
 * 按销量排序的特惠搜索。抽 HTML 片段里的 appid / 标题 / 折扣 / 价格。
 * ⚠️ 这个接口只返回 results_html（没有结构化字段），只能抽 HTML —— 实测可用。
 * ⚠️ 分类必须用 tags 而不是 genre（原因见 GENRE_TAGS 注释）。
 *
 * @param {number} pages 往里翻几页（每页 50）
 * @param {number|null} tagId Steam tag id；null = 不筛分类（全部）
 * @param {number} offset  额外跳过的条数，用于"每次换一批"
 */
async function fetchSearchSpecials(pages = 3, tagId = null, offset = 0) {
  return cachedList(`search:${pages}:${tagId || 'all'}:${offset}`, async () => {
    const out = []
    for (let p = 0; p < pages; p++) {
      const start = offset + p * 50
      let u = `${STEAM}/search/results/?query&start=${start}&count=50&specials=1`
        + `&filter=topsellers&infinite=1&cc=cn&l=schinese`
      if (tagId) u += `&tags=${tagId}`
      try {
        const d = await steamJson(u)
        const html = String(d?.results_html || '')
        for (const block of html.split('</a>')) {
          if (!block.includes('data-ds-appid')) continue
          const appid = Number(/data-ds-appid="(\d+)"/.exec(block)?.[1])
          if (!appid) continue
          const name = /<span class="title">([^<]+)<\/span>/.exec(block)?.[1]
          const cut = Number(/-(\d+)%/.exec(block)?.[1]) || 0
          if (cut <= 0) continue
          // 价格行：第一个是原价，第二个是现价（实测顺序）
          const prices = [...block.matchAll(/<div class="(?:discount_original_price|discount_final_price)">([^<]+)<\/div>/g)]
            .map((m) => m[1])
          const toInt = (s) => {
            const m = /([\d,]+(?:\.\d+)?)/.exec(String(s || '').replace(/,/g, ''))
            return m ? Math.round(Number(m[1]) * 100) : 0
          }
          out.push({
            appid,
            name: String(name || '').trim(),
            cut,
            original: toInt(prices[0]),
            final: toInt(prices[1]),
            expiry: 0,
            from: '热销特惠'
          })
        }
      } catch (e) {
        log(`搜索第 ${p + 1} 页失败：${e?.message || e}`)
      }
    }
    return out
  })
}

/** 取评测数/好评率，用来筛冷门。并发跑，单个失败不拖垮整批。 */
async function fetchReviews(appids, concurrency = 6) {
  const map = new Map()
  let cursor = 0
  const worker = async () => {
    while (cursor < appids.length) {
      const id = appids[cursor++]
      try {
        const d = await steamJson(`${STEAM}/appreviews/${id}?json=1&language=all&purchase_type=all&num_per_page=0`, 15000)
        const s = d?.query_summary || {}
        map.set(id, {
          total: Number(s.total_reviews) || 0,
          positive: Number(s.total_positive) || 0,
          desc: String(s.review_score_desc || '')
        })
      } catch {
        map.set(id, { total: 0, positive: 0, desc: '' })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, appids.length) }, worker))
  return map
}

/* ══════════════════════════════════════════════════════════════════════
   二、ITAD：历史最低
   ══════════════════════════════════════════════════════════════════════ */

/** Steam appid 数组 → { "app/730": "uuid", ... } */
async function lookupItadIds(appids) {
  if (!appids.length) return { ok: true, map: {} }
  const r = await itadPost('/lookup/id/shop/61/v1', appids.map((id) => `app/${id}`))
  if (!r.ok) return { ok: false, error: r.error, map: {} }
  return { ok: true, map: r.data || {} }
}

/** UUID 数组 → { uuid: {lowAll, lowY1, cur, regular, cut, expiry, storeLow, hasDeal} } */
async function fetchItadPrices(uuids, country = 'CN') {
  if (!uuids.length) return { ok: true, map: new Map() }
  const r = await itadPost('/games/prices/v3', uuids, { country, deals: true })
  if (!r.ok) return { ok: false, error: r.error, map: new Map() }
  const map = new Map()
  for (const entry of Array.isArray(r.data) ? r.data : []) {
    // Steam 商店 id = 61；有多个 deal 时优先取 Steam 的
    const deal = (entry.deals || []).find((d) => d?.shop?.id === 61) || (entry.deals || [])[0] || null
    map.set(entry.id, {
      lowAll: numOrNull(entry.historyLow?.all?.amountInt),
      lowY1: numOrNull(entry.historyLow?.y1?.amountInt),
      lowM3: numOrNull(entry.historyLow?.m3?.amountInt),
      cur: numOrNull(deal?.price?.amountInt),
      regular: numOrNull(deal?.regular?.amountInt),
      cut: numOrNull(deal?.cut),
      expiry: String(deal?.expiry || ''),
      storeLow: numOrNull(deal?.storeLow?.amountInt),
      hasDeal: Boolean(deal)
    })
  }
  return { ok: true, map }
}

/* ══════════════════════════════════════════════════════════════════════
   二·B、中文名（Steam 官方本地化名）
   ══════════════════════════════════════════════════════════════════════ */

/**
 * 批量取"中文本地化名 + 封面图地址"。
 *
 * ⚠️ 实测（2026-10-02）appdetails 的中国区名称**只有官方做过中文的才有中文**：
 *      全面战争：战锤3        ✅ 有中文
 *      Watch_Dogs® 2 / Skyrim / MONSTER HUNTER RISE  → 返回的仍是英文原名
 *    所以不能假设"带上 l=schinese 就一定有中文名"。渲染时要做去重：
 *    中文名和英文名相同（或中文名里没有汉字）就只显示一次，避免出现
 *    「Watch_Dogs® 2（Watch_Dogs® 2）」这种重复。
 */
async function fetchNamesAndImages(appids, concurrency = 6) {
  const map = new Map()

  // ── 本地缓存：游戏名与封面地址很少变，没必要每轮都查 ──────────────────
  // 实测：不做缓存时每次查询要打 20 次 appdetails，整个流程 35 秒。
  // 缓存 7 天，命中后重复查询能快一个数量级。
  const CACHE_FILE = path.join(CACHE_DIR, 'meta-cache.json')
  const TTL = 7 * 24 * 3600 * 1000
  let cache = {}
  try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) || {} } catch { cache = {} }

  const missing = []
  for (const id of appids) {
    const hit = cache[id]
    if (hit && Date.now() - (Number(hit.at) || 0) < TTL) {
      map.set(id, { zhName: hit.zhName, enName: hit.enName, image: hit.image, type: hit.type })
    } else {
      missing.push(id)
    }
  }

  let cursor = 0
  const worker = async () => {
    while (cursor < missing.length) {
      const id = missing[cursor++]
      try {
        const [zh, en] = await Promise.all([
          steamJson(`${STEAM}/api/appdetails?appids=${id}&cc=cn&l=schinese`, 20000),
          steamJson(`${STEAM}/api/appdetails?appids=${id}&cc=us&l=english`, 20000)
        ])
        const zd = zh?.[id]?.data
        const ed = en?.[id]?.data
        const info = {
          zhName: String(zd?.name || '').trim(),
          enName: String(ed?.name || zd?.name || '').trim(),
          // header.jpg 是 460x215 的横版图，比 capsule(231x87) 清楚得多
          image: String(zd?.header_image || ed?.header_image || '').trim(),
          type: String(zd?.type || '')
        }
        map.set(id, info)
        cache[id] = { ...info, at: Date.now() }
      } catch {
        map.set(id, { zhName: '', enName: '', image: '', type: '' })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, missing.length) }, worker))

  if (missing.length) {
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true })
      const tmp = `${CACHE_FILE}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(cache), 'utf8')
      fs.renameSync(tmp, CACHE_FILE)     // 原子写，避免半截 JSON
    } catch { /* 缓存写不进去不影响本次结果 */ }
  }
  return map
}

/* ══════════════════════════════════════════════════════════════════════
   二·C、封面图下载
   ══════════════════════════════════════════════════════════════════════ */

function curlDownload(url, outFile, extraArgs = []) {
  return new Promise((resolve) => {
    execFile('curl.exe', [
      '-sS', '-L', '--max-time', '25',
      '-H', `User-Agent: ${UA}`,
      ...extraArgs,
      '-o', outFile, url
    ], { windowsHide: true, timeout: 32000 }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: String(stderr || err.message || err).slice(0, 120) })
      try {
        const size = fs.statSync(outFile).size
        if (size < 500) return resolve({ ok: false, error: `文件过小(${size}B)` })
        return resolve({ ok: true, size })
      } catch (e) {
        return resolve({ ok: false, error: String(e?.message || e).slice(0, 120) })
      }
    })
  })
}

/** 封面图专用：直连失败也走一次代理（图床与接口同源，限流时一起挂）。 */
async function curlDownloadWithFallback(url, outFile, extraArgs = []) {
  let r = await curlDownload(url, outFile, extraArgs)
  if (r.ok) return r
  const proxy = steamProxy()
  if (!proxy) return r
  const r2 = await curlDownload(url, outFile, [...extraArgs, '--proxy', proxy])
  return r2.ok ? r2 : r
}

/**
 * 下载一张封面图到缓存目录，返回本地路径。
 *
 * ⚠️ 本机踩过的坑：直接下 Steam 图床会失败 ——
 *    `curl: (35) schannel: CRYPT_E_NO_REVOCATION_CHECK`
 *    即 Windows 的 TLS 吊销列表检查过不去（不是网络不通，域名能解析）。
 *    解法是带 `--ssl-no-revoke` 重试（实测能下到正常 JPEG）。
 *
 * 两个性能/可读性优化：
 *   ① 首次成功后**记住这个主机需要跳过吊销检查**，后续直接用它 ——
 *      否则每张图都要先失败一次再重试，10 张图就是 10 条错误日志 + 双倍往返。
 *   ② 单张失败只记一条简短日志，不把 curl 的完整报错刷进日志。
 */
const NO_REVOKE_HOSTS = new Set()

async function downloadCover(url, appid) {
  if (!/^https?:\/\//i.test(String(url || ''))) return null
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true })
  } catch { return null }
  const safe = String(appid).replace(/[^\w-]/g, '')
  const out = path.join(CACHE_DIR, `cover-${safe}.jpg`)
  // 缓存命中：同一款游戏反复查询不必重复下载
  try {
    if (fs.statSync(out).size > 500) return out
  } catch { /* 缓存没有，继续下 */ }

  let host = ''
  try { host = new URL(url).host } catch { /* 用空串兜底 */ }

  let r
  if (host && NO_REVOKE_HOSTS.has(host)) {
    r = await curlDownloadWithFallback(url, out, ['--ssl-no-revoke'])
  } else {
    r = await curlDownloadWithFallback(url, out)
    if (!r.ok) {
      r = await curlDownloadWithFallback(url, out, ['--ssl-no-revoke'])
      if (r.ok && host) NO_REVOKE_HOSTS.add(host)   // 记住：这台机器需要跳过吊销检查
    }
  }
  if (!r.ok) {
    try { fs.unlinkSync(out) } catch { /* ignore */ }
    log(`封面图下载失败 appid=${appid}`)
    return null
  }
  return out
}

/** 并发给所有条目下载封面图（串行会明显拖慢：10 张图 ≈ 多花 10 秒）。 */
async function attachCovers(items, concurrency = 6) {
  let cursor = 0
  const worker = async () => {
    while (cursor < items.length) {
      const it = items[cursor++]
      it.coverPath = it.imageUrl ? await downloadCover(it.imageUrl, it.appid) : null
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return items
}

/* ══════════════════════════════════════════════════════════════════════
   二·C-2、中文译名解析
   ══════════════════════════════════════════════════════════════════════ */

/**
 * 给每条结果定下 zhTitle/enTitle 两个名字。
 *
 * 顺序（**用户明确要求：有官中就用官中，没有才找翻译**）：
 *   ① Steam 官方中文本地化名 —— 官方译名就是这款游戏的正名，最不容易出错
 *   ② 本地核实过的词典 —— 官中没有时，用中文社区（B站/小黑盒/百科）通用译名
 *   ③ DeepSeek 兜底 —— 前两者都没有时才翻译
 *
 * 实测背景：Steam 官中只覆盖约一半游戏（12 款里 6 款），
 * 且公共机翻质量不可接受（Steep→"陡峭"、The Outlast Trials→"长生不老的审判"），
 * 所以②③是必要的补充，但都排在官中之后。
 */
async function resolveChineseTitles(items) {
  for (const it of items) {
    it.enTitle = cleanTitle(it.enName || it.name)
    it.steamZh = cleanTitle(it.zhName)
    it.zhTitle = ''
  }

  // ① Steam 官中优先（官方返回的 name 含汉字即为官中名）
  let steamHit = 0
  for (const it of items) {
    if (hasChinese(it.steamZh)) { it.zhTitle = it.steamZh; steamHit++ }
  }

  // ② 词典补缺（归一化匹配）
  let dictHit = 0
  for (const it of items) {
    if (it.zhTitle) continue
    const hit = lookupDict(it.enTitle)
    if (hit) { it.zhTitle = hit; dictHit++ }
  }

  // ③ DeepSeek 兜底（只把还缺的送去译）
  const rest = items.filter((it) => !it.zhTitle && it.enTitle)
  if (!rest.length) {
    log(`译名：Steam 官中 ${steamHit} 款、词典 ${dictHit} 款`)
    return
  }
  try {
    const map = await translateViaDeepSeek(rest.map((it) => it.enTitle), coreApiConf())
    let filled = 0
    for (const it of rest) {
      const t = cleanTitle(map[it.enTitle])
      if (t && hasChinese(t)) { it.zhTitle = t; filled++ }
    }
    log(`译名：Steam 官中 ${steamHit} 款、词典 ${dictHit} 款、DeepSeek 补 ${filled}/${rest.length} 款`)
  } catch (e) {
    log(`译名兜底失败（将只显示英文名）：${String(e?.message || e).slice(0, 80)}`)
  }
}

/** 从核心配置里取对话模型的 key/baseUrl（复用用户已配好的，不额外要 key）。 */
function coreApiConf() {
  try {
    const c = coreCfgRef?.getConfig?.()
    const providerId = String(c?.api?.provider || '')
    const byProvider = c?.dshProviderKeys?.[providerId]
    const apiKey = String(byProvider || c?.api?.apiKey || '').trim()
    // DeepSeek 官方 baseUrl 不带 /v1，chat/completions 在根路径下
    let baseUrl = String(c?.api?.baseUrl || '').trim()
    if (baseUrl && !/\/v\d+$/.test(baseUrl) && !baseUrl.includes('/chat/completions')) {
      baseUrl = baseUrl.replace(/\/+$/, '')
    }
    return { apiKey, baseUrl, model: String(c?.api?.model || '').trim() }
  } catch {
    return { apiKey: '', baseUrl: '', model: '' }
  }
}


/* ══════════════════════════════════════════════════════════════════════
   二·D、汇率换算
   ══════════════════════════════════════════════════════════════════════ */

/**
 * 支持的目标货币（用户随口说的国家名/币种都能对上）。
 * 汇率数据源：jsdelivr 上的 currency-api —— 免 key、340 种币种（实测），
 * 兜底用 open.er-api.com（166 种）。两个都实测可直连。
 */
export const CURRENCIES = {
  CNY: { symbol: '¥', name: '人民币', aliases: ['中国', '人民币', '元', 'rmb', 'cny', 'chinese'] },
  USD: { symbol: '$', name: '美元', aliases: ['美国', '美元', 'usd', 'dollar', 'usa', '美刀'] },
  UAH: { symbol: '₴', name: '乌克兰格里夫纳', aliases: ['乌克兰', 'uah', 'hryvnia', '格里夫纳'] },
  RUB: { symbol: '₽', name: '俄罗斯卢布', aliases: ['俄罗斯', '俄国', '卢布', 'rub', 'ruble', 'rouble'] },
  EUR: { symbol: '€', name: '欧元', aliases: ['欧元', '欧盟', 'eur', 'euro'] },
  JPY: { symbol: '¥', name: '日元', aliases: ['日本', '日元', 'jpy', 'yen'] },
  KRW: { symbol: '₩', name: '韩元', aliases: ['韩国', '韩元', 'krw', 'won'] },
  GBP: { symbol: '£', name: '英镑', aliases: ['英国', '英镑', 'gbp', 'pound'] },
  HKD: { symbol: 'HK$', name: '港币', aliases: ['香港', '港币', 'hkd'] },
  TWD: { symbol: 'NT$', name: '新台币', aliases: ['台湾', '新台币', 'twd'] },
  BRL: { symbol: 'R$', name: '巴西雷亚尔', aliases: ['巴西', 'brl', 'real'] },
  TRY: { symbol: '₺', name: '土耳其里拉', aliases: ['土耳其', 'try', 'lira'] },
  INR: { symbol: '₹', name: '印度卢比', aliases: ['印度', 'inr', 'rupee'] },
  ARS: { symbol: 'AR$', name: '阿根廷比索', aliases: ['阿根廷', 'ars', 'peso'] }
}

/** 把用户说的"乌克兰/美国/卢布/USD"这类说法解析成货币代码。 */
export function resolveCurrency(input) {
  const raw = String(input ?? '').trim()
  if (!raw) return null
  const upper = raw.toUpperCase()
  if (CURRENCIES[upper]) return upper
  const low = raw.toLowerCase()
  for (const [code, meta] of Object.entries(CURRENCIES)) {
    if (meta.aliases.some((a) => a.toLowerCase() === low)) return code
  }
  // 再宽松一点：包含关系（"换成乌克兰的"也能命中）
  for (const [code, meta] of Object.entries(CURRENCIES)) {
    if (meta.aliases.some((a) => a.length >= 2 && low.includes(a.toLowerCase()))) return code
  }
  // 3 个字母的代码即使不在表里也接受（汇率源可能支持）
  if (/^[A-Z]{3}$/.test(upper)) return upper
  return null
}

let rateCache = null   // { at, code, rates }

/** CNY → 目标货币的汇率（1 CNY = ? target）。失败返回 null。 */
export async function getRate(code) {
  const target = String(code || 'CNY').toUpperCase()
  if (target === 'CNY') return 1
  if (rateCache && rateCache.code === 'CNY' && Date.now() - rateCache.at < 6 * 3600 * 1000) {
    const hit = rateCache.rates?.[target]
    if (Number.isFinite(hit)) return hit
  }
  const sources = [
    ['jsdelivr currency-api', 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/cny.json', (d) => d?.cny],
    ['open.er-api.com', 'https://open.er-api.com/v6/latest/CNY', (d) => d?.rates]
  ]
  for (const [name, url, pick] of sources) {
    try {
      const d = await getJson(url, 20000)
      const rates = pick(d) || {}
      const rate = rates[target] ?? rates[target.toLowerCase()]
      const n = Number(rate)
      if (Number.isFinite(n) && n > 0) {
        rateCache = { at: Date.now(), code: 'CNY', rates: normalizeRates(rates) }
        return n
      }
      log(`${name} 没有 ${target} 的汇率`)
    } catch (e) {
      log(`${name} 汇率获取失败：${String(e?.message || e).slice(0, 80)}`)
    }
  }
  return null
}

function normalizeRates(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj || {})) {
    if (typeof v === 'object' && v) {
      const r = Number(v.rate)          // floatrates 风格
      if (Number.isFinite(r)) out[String(k).toUpperCase()] = r
    } else {
      const r = Number(v)
      if (Number.isFinite(r)) out[String(k).toUpperCase()] = r
    }
  }
  return out
}

/** 按汇率把"分"换算成目标货币的面值字符串。 */
export function convertCents(cents, rate, code) {
  if (cents == null) return '—'
  const meta = CURRENCIES[code] || { symbol: '', name: code }
  const y = (Number(cents) / 100) * (Number(rate) || 1)
  // 大额货币（日元/韩元/里拉）没有小数，小额货币保留两位
  const digits = y >= 100 ? 0 : 2
  return `${meta.symbol}${y.toFixed(digits)}`
}

function numOrNull(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/* ══════════════════════════════════════════════════════════════════════
   三、史低判定（口径见文件头，别简化成 <=）
   ══════════════════════════════════════════════════════════════════════ */

export function classifyLow(cur, lowAll, lowY1) {
  if (cur == null) return { level: null, label: '' }
  if (lowAll != null) {
    if (cur < lowAll) return { level: 'newLow', label: '🆕 新史低' }
    if (cur === lowAll) return { level: 'tieLow', label: '🎯 平史低' }
    // 高于历史最低：哪怕是一年内最低，也不算"史低"，别往上贴标签
    return { level: null, label: '' }
  }
  if (lowY1 != null && cur <= lowY1) return { level: 'y1Low', label: '📉 一年内最低' }
  return { level: null, label: '' }
}

/* ══════════════════════════════════════════════════════════════════════
   四、主流程
   ══════════════════════════════════════════════════════════════════════ */

const yuan = (cents) => (cents == null ? '—' : `¥${(cents / 100).toFixed(2).replace(/\.00$/, '')}`)

function fmtExpiry(expiry) {
  if (!expiry) return ''
  const d = new Date(expiry)
  if (Number.isNaN(d.getTime())) return ''
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  return `${mm}/${dd} ${hh}:00`
}

/**
 * 扫一遍当前折扣，返回排好序的结果。
 *
 * @param {object} opts
 *   count       要几款
 *   currency    临时货币
 *   genre       分类：中文名（"赛车"）或 key（"racing"）；留空=全部分类
 *   rotationKey 轮转键（内部用）；不同群/不同分类各自轮转
 * @returns {{ items, stats, warning, genre }}
 */
export async function scanDeals(opts = {}) {
  await warmCoreConfig()          // 先拿到代理地址（直连被限流时要用）
  const cfg = cfgOf() || {}
  const wantCount = clampInt(opts.count ?? cfg.maxItems, 5, 20, 10)
  const minReviews = clampInt(opts.minReviews ?? cfg.minReviews, 0, 500000, 5000)
  const maxCandidates = clampInt(cfg.maxCandidates, 10, 200, 70)
  const pages = clampInt(cfg.searchPages, 1, 6, 2)

  // ⓪ 分类：用户点名就要那一类的畅销折扣；不点名 = 全部
  const genre = opts.genre ? resolveGenre(opts.genre) : null
  if (opts.genre && !genre) {
    return {
      items: [], stats: {}, warning: '',
      genre: null,
      unknownGenre: String(opts.genre),
      knownGenres: listGenreNames()
    }
  }

  // 「每次换一批」：按分类（或"全部"）分别记数，据此做偏移。
  //
  // ⚠️ 偏移**不能太深**：实测翻到第 3 页（offset=100）时榜单尾部会混进
  //    SimplePlanes / Easy Delivery Co. 这类小品游戏 —— 那就不叫"畅销"了。
  //    所以按「Steam 畅销榜前 N 名」里轮转（默认 2 页 ≈ 100 名），
  //    并给用户留了 rotatePages 设置可以调。
  const rotKey = `${genre ? genre.key : 'all'}`
  const rotN = nextRotation(rotKey)
  const OFFSET_PAGES = clampInt(cfg.rotatePages, 1, 5, 2)
  const offset = (rotN % OFFSET_PAGES) * 50

  // ① 候选池
  //    · 指定分类：只用该 tag 的"打折 + 按销量排序"列表
  //    · 不指定分类：畅销榜 + 特惠位 + 全站按销量排序的打折列表（覆盖面最广）
  const parts = []
  if (!genre) parts.push(...await fetchFeatured())
  parts.push(...await fetchSearchSpecials(pages, genre ? genre.id : null, offset))
  // 偏移翻到底了（该分类打折的翻完）就回到第一批，避免空白
  if (genre && parts.length < 5 && offset > 0) {
    parts.push(...await fetchSearchSpecials(pages, genre.id, 0))
  }

  const seen = new Map()
  for (const c of parts) {
    if (!c.appid || !c.name) continue
    // 同一个 appid 可能同时出现在多个来源：保留折扣信息更全的那条
    const prev = seen.get(c.appid)
    if (!prev || (!prev.expiry && c.expiry) || (!prev.final && c.final)) seen.set(c.appid, c)
  }
  let cands = [...seen.values()]

  // ② 过期的直接掠过（用当前时间比对折扣到期时间）
  const now = Date.now()
  const expired = cands.filter((c) => c.expiry && c.expiry * 1000 < now)
  cands = cands.filter((c) => !(c.expiry && c.expiry * 1000 < now))

  // ③ 排序（**这一步决定"畅销"还是"折扣猛"**）
  //
  // ⚠️ 两种情况要分开处理，否则会违背用户意图：
  //    · **指定分类时保持 Steam 的畅销榜顺序**（接口本来就是 filter=topsellers）。
  //      如果还按折扣力度重排，会把榜单顺序打乱、把低折扣的冷门顶到前面 ——
  //      用户要的是"这个分类里的畅销游戏"，不是"折扣最狠的"。
  //    · 不指定分类时按折扣力度排（全站榜单前 50 名是固定的，
  //      不重排的话每次都是同一批，也就谈不上"挑畅销折扣"）。
  //    两种情况都保留原来的过期过滤；折扣为 0 的（免费的）排除。
  const live = cands.filter((c) => c.cut > 0)
  if (!genre) live.sort((a, b) => b.cut - a.cut)
  const need = Math.min(maxCandidates, Math.max(12, wantCount * 4))
  cands = live.slice(0, need)

  // ④ 评测数筛冷门 —— **分批取够即停**
  //
  // ⚠️ 这里原来是"对全部候选逐个查评测"，实测 40 次请求就是扫描的主要成本
  //    （经代理 5~8 秒，且代理抖动时会拖到十几秒）。
  //    改成按批查询；不指定分类时"够数就停"，指定分类时**必须跑完** ——
  //    因为候选是按畅销榜顺序排的，提前收手会在排行榜中间截断，
  //    后面的畅销游戏就全看不到了。
  const LIVE_BATCH = 16
  const reviews = new Map()
  const popular = []
  for (let i = 0; i < cands.length; i += LIVE_BATCH) {
    const batch = cands.slice(i, i + LIVE_BATCH)
    const got = await fetchReviews(batch.map((c) => c.appid))
    for (const [k, v] of got) reviews.set(k, v)
    for (const c of batch) {
      const total = reviews.get(c.appid)?.total || 0
      if (total >= minReviews) popular.push({ ...c, reviewTotal: total })
    }
    // 分类模式：必须按榜序跑完；否则够数就收手
    if (!genre && popular.length >= wantCount * 1.5) break
  }

  // 全部候选都没过门槛时**不清空**：宁可放宽也不返回空结果
  // （只有前几批被查过是正常的，后面的没查不等于不达标）
  let dropped = 0
  if (!popular.length) {
    for (const c of cands) {
      const total = reviews.get(c.appid)?.total || 0
      popular.push({ ...c, reviewTotal: total })
    }
    dropped = 0
    log('所有候选都没达到评测门槛，本次已放宽（避免返回空结果）')
  } else {
    dropped = reviews.size - popular.length
  }

  // ⑤ ITAD：历史最低
  const look = await lookupItadIds(popular.map((c) => c.appid))
  if (!look.ok) {
    return { items: [], stats: { candidates: cands.length, popular: popular.length }, warning: `ITAD 查询失败：${look.error}` }
  }
  const steamToUuid = new Map()
  for (const [k, uuid] of Object.entries(look.map)) {
    const m = /^app\/(\d+)$/.exec(k)
    if (m && uuid) steamToUuid.set(Number(m[1]), uuid)
  }
  const priceRes = await fetchItadPrices([...steamToUuid.values()])
  if (!priceRes.ok) {
    return { items: [], stats: { candidates: cands.length, popular: popular.length }, warning: `ITAD 价格查询失败：${priceRes.error}` }
  }
  const uuidToSteam = new Map()
  for (const [appid, uuid] of steamToUuid) uuidToSteam.set(uuid, appid)

  // ⑥ 组装 + 判定（_rank = 在畅销榜里的原始位次，分类模式下用它保序）
  const items = []
  for (const [uuid, p] of priceRes.map) {
    const appid = uuidToSteam.get(uuid)
    if (!appid) continue
    const cand = popular.find((c) => c.appid === appid)
    if (!cand) continue
    const cur = p.cur ?? cand.final
    const regular = p.regular ?? cand.original
    const cut = p.cut ?? cand.cut
    if (!cur || cut <= 0) continue
    // ITAD 的 expiry 更权威；拿不到就用 Steam 的时间戳
    const expiryText = p.expiry || (cand.expiry ? new Date(cand.expiry * 1000).toISOString() : '')
    const low = classifyLow(cur, p.lowAll, p.lowY1)
    const rev = reviews.get(appid) || { total: cand.reviewTotal || 0, desc: '' }
    items.push({
      appid, name: cand.name, cut, cur, regular,
      savings: regular > cur ? regular - cur : 0,
      lowAll: p.lowAll, lowY1: p.lowY1,
      lowLabel: low.label, lowLevel: low.level,
      expiryText, expiryMs: expiryText ? new Date(expiryText).getTime() : 0,
      reviews: rev.total, reviewDesc: rev.desc,
      from: cand.from,
      _rank: popular.indexOf(cand)
    })
  }

  // ⑦ 排序
  //
  // ⚠️ 分类模式**必须保持畅销榜顺序**（候选原本就是 filter=topsellers 的顺序）。
  //    如果这里还按"新史低优先"重排，榜尾的新史低会跑到榜首，
  //    用户看到的就不是"这个分类的畅销游戏"了。
  //    不指定分类时才按 史低 → 折扣 → 热度 排（那是"挑好价"的语义）。
  const rank = { newLow: 0, tieLow: 1, y1Low: 2 }
  if (genre) {
    items.sort((a, b) => (a._rank ?? 1e9) - (b._rank ?? 1e9))
  } else {
    items.sort((a, b) => {
      const ra = rank[a.lowLevel] ?? 3
      const rb = rank[b.lowLevel] ?? 3
      if (ra !== rb) return ra - rb
      if (b.cut !== a.cut) return b.cut - a.cut
      return b.reviews - a.reviews
    })
  }

  // ⑦ 中文名 + 封面图
  // ⚠️ 封面图按需下载：新的精简格式（renderDealsCompact）**不显示逐款封面**，
  //    默认 showCover=false 时还去下 10 张图纯属浪费（实测占扫描耗时的一大半）。
  const names = await fetchNamesAndImages(items.map((i) => i.appid))
  for (const it of items) {
    const n = names.get(it.appid) || {}
    it.zhName = n.zhName || ''
    it.enName = n.enName || it.name
    it.imageUrl = n.image || ''
  }
  if (cfg.showCover === true) {
    await attachCovers(items)
  } else {
    for (const it of items) it.coverPath = null
  }

  // ⑦·B 中文译名：Steam 官中 → 核实过的词典 → DeepSeek 兜底
  await resolveChineseTitles(items)

  // ⑧ 汇率（默认人民币；用户可以让机器人换成任意国家货币）
  const code = String(cfg.currency || 'CNY').toUpperCase()
  let rate = 1
  let rateError = ''
  if (code !== 'CNY') {
    const r = await getRate(code)
    if (Number.isFinite(r)) rate = r
    else rateError = `拿不到 ${code} 的汇率，已按人民币显示`
  }

  return {
    items: items.slice(0, wantCount),
    stats: {
      candidates: cands.length,
      popular: popular.length,
      expiredDropped: expired.length,
      coldDropped: dropped,
      scanned: items.length
    },
    genre: genre ? { key: genre.key, name: genre.name } : null,
    currency: code,
    rate,
    rateError,
    warning: ''
  }
}

function clampInt(v, min, max, dflt) {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return dflt
  return Math.min(max, Math.max(min, n))
}

/**
 * 精简渲染（用户点名的格式，v1.2.0 起为默认）：
 *
 *   1. 博德之门3（Baldur's Gate 3）  ¥298 → ¥89.40  新史低  -70%
 *
 * 一行一款；**不写好评、不写截止日期、不写封面图**；
 * 结尾追加一张随机 pixiv 二次元图（由调用方发送时附上）。
 * 每 perBubble 款封一个气泡。
 */
export function renderDealsCompact(items, stats, opts = {}) {
  const code = String(opts.currency || 'CNY').toUpperCase()
  const rate = Number.isFinite(opts.rate) ? opts.rate : 1
  const perBubble = clampInt(opts.perBubble, 1, 10, 10)

  const curOf = (cents) => convertCents(cents, rate, code)

  const pickName = (it) => {
    const zh = cleanTitle(it.zhTitle)
    const en = cleanTitle(it.enTitle || it.enName || it.name)
    if (zh && en) return `${zh}（${en}）`
    return zh || en
  }

  // 史低标签压成 1 个字：新 / 平。
  // 每行原本写"平史低"3 个字，10 行就重复 10 次"史低" —— 改成表头写一次图例，
  // 行内只留 1 个字（这是用户点名要的"优化 token/长度"的一部分）。
  const lowTag = (it) => {
    if (it.lowLevel === 'newLow') return '新'
    if (it.lowLevel === 'tieLow') return '平'
    return ''
  }

  const body = (it, i) => {
    // 价格区间：折扣为 0 或原价缺失时只显示一个价格
    const showRange = it.regular != null && it.regular > it.cur
    const price = showRange ? `${curOf(it.regular)}→${curOf(it.cur)}` : curOf(it.cur)
    const tag = lowTag(it)
    return `${i + 1}. ${pickName(it)}  ${price}${tag ? ` ${tag}` : ''} -${it.cut}%`
  }

  if (!items.length) {
    const t = '这轮没扫到符合条件的好价（要么折扣都过期了，要么热门游戏没在打折）。过一会儿再问。'
    return { bubbles: [[{ type: 'text', data: { text: t } }]], plain: t }
  }

  const lines = []
  const bubbles = []
  let cur = []
  let inBubble = 0

  const headerText = `🎮 Steam 史低好价${opts.genreName ? ` · ${opts.genreName}类` : ''} · ${items.length} 款`
    + `（新=新史低 平=平史低）`

  items.forEach((it, i) => {
    const line = body(it, i)
    lines.push(line)
    // 表头只在第一条气泡出现（多条气泡时重复标题显得冗余）
    if (cur.length === 0 && bubbles.length === 0) {
      cur.push({ type: 'text', data: { text: headerText } })
    }
    cur.push({ type: 'text', data: { text: line } })
    // 封面**紧跟在这一行后面** —— 这就是"每个游戏下面放这款游戏的封面"。
    // 顺序很重要：文字段、图片段、文字段、图片段… 一旦把图放到最后，
    // QQ 端会先显示完全部文字再显示全部图片，就不是"图在对应游戏下面"了。
    if (opts.withCovers === true && it.coverPath) {
      cur.push({ type: 'image', data: { file: it.coverPath } })
    }
    inBubble++
    if (inBubble >= perBubble || i === items.length - 1) {
      bubbles.push(cur)
      cur = []
      inBubble = 0
    }
  })

  // 结尾**不**在清单里加任何说明：用户要的是干净的「一行一款」。
  // ITAD 条款要求的署名改由调用方放在配图那条消息里（见 index.js）。
  const plain = [headerText, '', ...lines].join('\n')
  return { bubbles, plain }
}

/**
 * 拼成"每条游戏 = 文字段 + 封面图段"的段数组，按每气泡游戏数分组成多个气泡。
 *
 * @returns {{ bubbles: Array<Array<segment>>, plain: string }}
 *   bubbles 直接喂给 sender.sendMedia（同一批段 = 同一个气泡）；
 *   plain 是纯文字摘要，供日志/降级用。
 */
export function renderDeals(items, stats, opts = {}) {
  const code = String(opts.currency || 'CNY').toUpperCase()
  const rate = Number.isFinite(opts.rate) ? opts.rate : 1
  const showLink = opts?.showLink === true
  const perBubble = clampInt(opts.perBubble, 1, 10, 10)
  const withCovers = opts.withCovers !== false

  if (!items.length) {
    const t = '这轮没扫到符合条件的好价（要么折扣都过期了，要么热门游戏没在打折）。过一会儿再问。'
    return { bubbles: [[{ type: 'text', data: { text: t } }]], plain: t }
  }

  const brief = []
  const bits = []
  if (stats?.expiredDropped) bits.push(`已掠过 ${stats.expiredDropped} 个过期折扣`)
  if (stats?.coldDropped) bits.push(`已过滤 ${stats.coldDropped} 个冷门`)
  if (opts.rateError) bits.push(opts.rateError)

  const bubbles = []
  let cur = []
  let inBubble = 0                 // 当前气泡里已放了几款（必须独立计数：
                                   // 用"累计款数 % perBubble"会让第二个气泡切不出来）
  const totalBubbles = Math.ceil(items.length / perBubble)

  items.forEach((it, i) => {
    const lines = []

    // 中文名（英文名）：两名字相同就只显示一次，避免「A（A）」重复
    const title = displayTitle(it)
    lines.push(`${i + 1}. ${title}${it.lowLabel ? `  ${it.lowLabel}` : ''}`)

    // 价格：换算到目标货币；折扣百分比是币种无关的
    const curTxt = convertCents(it.cur, rate, code)
    const regTxt = convertCents(it.regular, rate, code)
    lines.push(`💰 ${regTxt} → ${curTxt}  (-${it.cut}%)`)

    const meta = []
    if (it.lowAll != null) meta.push(`史低 ${convertCents(it.lowAll, rate, code)}`)
    if (it.reviews) {
      meta.push(`${it.reviewDesc || '评价'} ${it.reviews > 10000 ? `${(it.reviews / 10000).toFixed(1)}万` : it.reviews} 条`)
    }
    if (it.expiryMs > Date.now()) meta.push(`截止 ${fmtExpiry(it.expiryText)}`)
    if (meta.length) lines.push(`📊 ${meta.join(' · ')}`)
    if (showLink && it.appid) lines.push(`🔗 https://store.steampowered.com/app/${it.appid}/`)

    const text = lines.join('\n')
    brief.push(text)
    // 第一段前加个表头（只在第一个气泡出现一次）
    const isFirst = i === 0
    const textWithHead = isFirst
      ? `🎮 近期史低好价 · 精选 ${items.length} 款` + (code !== 'CNY' ? `（按 ${code} 换算）` : '') + '\n\n' + text
      : text

    cur.push({ type: 'text', data: { text: textWithHead } })
    if (withCovers && it.coverPath) cur.push({ type: 'image', data: { file: it.coverPath } })
    inBubble++

    // 攒够 perBubble 条就封一个气泡
    const last = i === items.length - 1
    if (cur.length && (inBubble >= perBubble || last)) {
      bubbles.push(cur)
      cur = []
      inBubble = 0
    }
  })

  // 结尾的统计与署名，追加到最后一个气泡（ITAD 条款要求署名）
  const tail = []
  if (bits.length) tail.push(`（${bits.join('，')}）`)
  tail.push('数据来源：Steam 商店 + IsThereAnyDeal.com')
  if (bubbles.length) {
    bubbles[bubbles.length - 1].push({ type: 'text', data: { text: '\n' + tail.join('\n') } })
  }

  const plain = [
    `🎮 近期史低好价 · 精选 ${items.length} 款（分 ${totalBubbles} 条发送）`,
    '',
    ...brief,
    '',
    ...tail
  ].join('\n')
  return { bubbles, plain, stats }
}

/** 显示名：中文名（英文名）；没有中文名或两者相同则只显示一个。 */
export function displayTitle(it) {
  const zh = String(it?.zhName || '').trim()
  const en = String(it?.enName || it?.name || '').trim()
  if (!zh) return en
  if (!en || zh === en) return zh
  return `${zh}（${en}）`
}

export const internals = {
  classifyLow, yuan, fmtExpiry,
  fetchFeatured, fetchSearchSpecials, fetchReviews,
  fetchNamesAndImages, downloadCover, displayTitle,
  CURRENCIES, resolveCurrency, getRate, convertCents
}

// 汇率相关也单独导出别名：主文件按 resolveCurrencyCode 这个名字导入
export { CURRENCIES as SUPPORTED_CURRENCIES }
export { resolveCurrency as resolveCurrencyCode }
