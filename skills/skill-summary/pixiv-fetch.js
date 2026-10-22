// 配图取图模块（本地改造版）—— 把「每日运势」的配图接到**已装的 pixiv 插件**上。
//
// ── 为什么要有这个文件 ──────────────────────────────────────────────────
// 原版 daily-fortune 的配图是去调**同级 skills/pixiv-search/py/cli.py** 这个 Python CLI。
// 本机没有 pixiv-search 这个技能，所以那条路整条是断的：每次抽签都白跑一次、
// 拿不到图，再退化成纯文字。
//
// 这个文件把取图换成**用户已经装好、已经配好代理的那套 pixiv 实现**
// （skills/pixiv-image-tagsearch）：同样的接口、同样的 curl + 代理、同样的落盘方式。
// Pixiv 在国内必须走代理，而 Node 的 undici（globalThis.fetch）不支持 socks5，
// 所以这里照抄它的做法 —— shell 出 curl.exe。
//
// ── 配置从哪来（关键：不重复让用户填一遍）────────────────────────────────
// 直接读**核心配置**里的 `skills['pixiv-image-tagsearch']` 一节。
// 用户在 pixiv 插件设置里填过的代理、v2rayN 目录、图库目录、分级、收藏门槛，
// 这里原样复用；一个都不用再填。
//
// ── 与「一个气泡」的关系 ────────────────────────────────────────────────
// 本模块只负责「拿到一个本地图片文件路径」，**不发消息**。
// 把文字段和图片段合并成一条气泡，由调用方（index.js 的 send 工具）用
// ctx.sender.sendMedia 完成。

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const PIXIV_REFERER = 'https://www.pixiv.net/'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])

/** 临时图落在这里（系统临时目录）。不能放技能目录 —— 那会触发核心热重载。 */
const TMP_DIR = path.join(os.tmpdir(), 'qqa-daily-fortune')

/** 兜底标签：最宽、实测必出结果。主标签搜不到时用它的。 */
export const FALLBACK_TAG = '女の子'

const DEFAULT_API_BASE = 'https://www.pixiv.net'
const DEFAULT_PROXY = 'socks5h://127.0.0.1:10808'

// 与 index.js 对齐：从搜索结果前几条里随机挑，避免同一档签老是同一张图。
const PICK_FROM = 5
// 临时图最多留几张，超出按时间删旧的。
const KEEP_TMP = 12

let logFn = () => {}

/** index.js 的 setup 里调一次，把技能自己的日志函数接进来。 */
export function initPixiv({ log } = {}) {
  if (typeof log === 'function') logFn = log
}

function log(...a) {
  try { logFn(...a) } catch { /* 日志失败不影响取图 */ }
}

/* ══════════════════════════════════════════════════════════════════════
   一、读 pixiv 插件的配置（不重复让用户填）
   ══════════════════════════════════════════════════════════════════════ */

/**
 * 从核心配置里取 pixiv 那套设置。
 *
 * 为什么用静态 import：本技能是 ESM 且 import 路径固定（../../src/config.js），
 * 与 tts-say 的做法一致；拿不到时全部退回默认值，绝不因为读配置失败而中断抽签。
 *
 * ⚠️ 路径深度：本文件是 app/skills/skill-summary/pixiv-fetch.js，退**两**层到 app，
 * 再进 src/ 才是 app/src/config.js。写成 ../../../src 会跑到 resources/src（不存在），
 * 表现为"读不到核心配置"，配图就用不上用户填的代理设置。
 */
let coreCfgRef = null
export async function warmPixivConfig() {
  if (coreCfgRef) return coreCfgRef
  try {
    coreCfgRef = await import('../../src/config.js')
  } catch (error) {
    coreCfgRef = null
    log(`读不到核心配置（配图会退回默认代理设置）：${describe(error)}`)
  }
  return coreCfgRef
}

/** pixiv 插件那一节设置。读不到 = 空对象（调用方一律按默认值兜底）。 */
export function pixivSettings() {
  try {
    const c = typeof coreCfgRef?.getConfig === 'function' ? coreCfgRef.getConfig() : null
    const s = c?.skills?.['pixiv-image-tagsearch']
    return (s && typeof s === 'object') ? s : {}
  } catch {
    return {}
  }
}

/** 把设置里的用户填值 + 合理默认值合成一份可用的取图参数。 */
export function resolvePixivOptions(override) {
  const s = pixivSettings()
  const num = (v, d, min, max) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return d
    return Math.min(max, Math.max(min, n))
  }
  return {
    apiBase: String(s.apiBase ?? '').trim().replace(/\/+$/, '') || DEFAULT_API_BASE,
    proxy: String(s.proxy ?? '').trim() || DEFAULT_PROXY,
    autoStartProxy: s.autoStartProxy === true,
    proxyCoreDir: String(s.proxyCoreDir ?? '').trim(),
    mode: String(s.mode ?? '').trim() || 'safe',
    type: String(s.type ?? '').trim() || 'artwork',
    skipMultiPage: s.skipMultiPage !== false,
    timeoutMs: num(override?.timeoutMs ?? s.timeoutMs, 25000, 5000, 60000)
  }
}

/* ══════════════════════════════════════════════════════════════════════
   二、代理保活（移植自 pixiv-image-tagsearch，同一套 sing-box 拉起逻辑）
   ══════════════════════════════════════════════════════════════════════ */

function curl(url, { proxy = '', referer = '', timeoutMs = 25000, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-sS', '-L', '--max-time', String(Math.max(3, Math.ceil(timeoutMs / 1000)))]
    if (proxy) args.push('--proxy', proxy)
    args.push('-H', `User-Agent: ${UA}`)
    args.push('-H', `Referer: ${referer || PIXIV_REFERER}`)
    args.push('-H', 'X-Requested-With: XMLHttpRequest')
    args.push(url)
    execFile('curl.exe', args, {
      maxBuffer: 48 * 1024 * 1024,
      encoding: binary ? 'buffer' : 'utf8',
      windowsHide: true,
      timeout: timeoutMs + 8000
    }, (err, stdout) => {
      if (err) return reject(err)
      resolve(stdout)
    })
  })
}

/** 代理地址抽 host:port（socks5h://127.0.0.1:10808 → 127.0.0.1:10808）。 */
function proxyHostPort(proxy) {
  const s = String(proxy || '').trim()
  if (!s) return null
  const m = /^(?:[a-z0-9+.-]+:\/\/)?([^:/@]+):(\d+)/i.exec(s)
  if (!m) return null
  return { host: m[1], port: Number(m[2]) }
}

function probeTcp(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port })
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
  })
}

async function waitPort(host, port, totalMs) {
  const deadline = Date.now() + totalMs
  while (Date.now() < deadline) {
    if (await probeTcp(host, port, 600)) return true
    await new Promise((r) => setTimeout(r, 700))
  }
  return false
}

// 节流 60s + 单飞锁：连着抽几次签时不能每次都去 spawn 一次核心（第二次会因端口占用失败）。
let lastEnsureTs = 0
let lastEnsureOk = null
let ensureInFlight = null

/**
 * 确保代理端口可连；端口没开且开了 autoStart 时后台静默拉起 sing-box。
 * ⚠️ 用的是动态 import('node:child_process') —— 与 tts-say 同款写法，
 * 避免为了一个 spawn 在模块顶部再引一次（本文件静态 import 只留 execFile）。
 */
async function ensureProxy({ proxy, autoStart, coreDir }) {
  const hp = proxyHostPort(proxy)
  if (!hp) return { ok: false, started: false, reason: '代理地址解析不出来' }

  if (await probeTcp(hp.host, hp.port)) {
    lastEnsureOk = true
    return { ok: true, started: false }
  }
  if (!autoStart) {
    return { ok: false, started: false, reason: `代理端口 ${hp.host}:${hp.port} 没在监听，且未开启自动拉起` }
  }
  if (ensureInFlight) return ensureInFlight
  if (Date.now() - lastEnsureTs < 60000 && lastEnsureOk === false) {
    return { ok: false, started: false, reason: '60 秒内已尝试过拉起代理且失败，先不重复试' }
  }
  lastEnsureTs = Date.now()

  ensureInFlight = (async () => {
    const dir = String(coreDir || '').trim()
    const exe = dir ? path.join(dir, 'bin', 'sing_box', 'sing-box.exe') : ''
    const conf = dir ? path.join(dir, 'binConfigs', 'config.json') : ''
    if (!dir || !fs.existsSync(exe) || !fs.existsSync(conf)) {
      lastEnsureOk = false
      return { ok: false, started: false, reason: `找不到 sing-box 核心或配置（${dir || '未配置 v2rayN 目录'}）` }
    }
    try {
      const cp = await import('node:child_process')
      const spawn = (cp.default || cp).spawn
      const child = spawn(exe, ['run', '-c', conf], {
        cwd: path.dirname(exe),
        detached: true,          // 代理是基础设施，不跟着 QQ Agent 一起死
        stdio: 'ignore',         // 不弹窗、不占管道
        windowsHide: true
      })
      child.unref()
    } catch (e) {
      lastEnsureOk = false
      return { ok: false, started: false, reason: `启动 sing-box 失败：${describe(e)}` }
    }
    const up = await waitPort(hp.host, hp.port, 15000)
    lastEnsureOk = up
    return up
      ? { ok: true, started: true }
      : { ok: false, started: true, reason: 'sing-box 已启动，但 15 秒内端口仍未就绪' }
  })()

  try { return await ensureInFlight } finally { ensureInFlight = null }
}

/* ══════════════════════════════════════════════════════════════════════
   三、搜索与下载（照抄 pixiv-image-tagsearch 的接口用法）
   ══════════════════════════════════════════════════════════════════════ */

function normalizeExt(url) {
  const ext = path.extname(String(url).split('?')[0]).toLowerCase()
  return IMG_EXT.has(ext) ? ext : '.jpg'
}

/**
 * 把接口给的地址改成**真能下到的大图**地址，改不出来就返回空串。
 *
 * ⚠️ 这里踩过一个真实的坑，别凭直觉改：
 *   `/ajax/search/illustrations/` 返回的只有缩略图字段 `url`，
 *   形如 https://i.pximg.net/c/250x250_80_a2/img-master/img/....._square1200.jpg
 *   而且**没有** urls 对象、没有尺寸字段（详情接口 /ajax/illust/<id> 才有 urls.regular）。
 *
 *   把 `/c/250x250_80_a2/` 替换成 `'/'` 是**错的** —— 那会多留一个斜杠，
 *   把域名和路径粘成 `https://i.pximg.netimg-master/...`，下载直接失败。
 *   正确做法是**连同结尾的斜杠一起删掉**（实测 2026-10-02）：
 *     /c/250x250_80_a2/ + img-master/... → /img-master/...  ≈ 390 KB ✅
 *     改成 /c/1200x1200_80_a2/           → 返回 0.5 KB 的 HTML 错误页 ❌
 *     img-original 原图                   → ≈ 715 KB（更大更慢，没必要）
 *
 * 删掉尺寸前缀后还要把它从"按尺寸压缩的缩略图"改成 master1200 大图，
 * 否则 /img-master/ 下找 _square1200.jpg 同样 404。
 */
function toDownloadable(rawUrl) {
  const s = String(rawUrl || '').trim()
  if (!/^https?:\/\//i.test(s)) return ''
  // ⚠️ 搜索串**不能带结尾的斜杠**：写成 '/c/250x250_80_a2/' → '' 会把
  //    `https://i.pximg.net/c/...` 里的 `//` 也吃掉，变成 `https:/i.pximg.net`。
  //    写成 '/c/250x250_80_a2' → '' 才会得到正确的
  //    `https://i.pximg.net/img-master/img/...`（多出来的那个 `/` 正好是路径分隔符）。
  let u = s.replace('/c/250x250_80_a2', '')
  u = u.replace('_square1200.', '_master1200.')
  // 万一接口以后只给文件名不带尺寸前缀：至少把"压缩缩略图"改成大图，别再动路径
  if (u.includes('/c/') && !u.includes('/img-master/')) return ''
  return /^https?:\/\/[^/]+\/.+/i.test(u) ? u : ''
}

/** 取一页搜索结果（不含详情，所以此时还没有收藏数）。 */
async function searchPage(query, page, opt) {
  const { proxy, timeoutMs, mode, type, skipMultiPage, apiBase } = opt
  const kw = encodeURIComponent(query)
  const url = `${apiBase}/ajax/search/illustrations/${kw}`
    + `?word=${kw}&order=date_d&mode=${mode}&p=${page}&s_mode=s_tag&type=${type}&lang=zh`
  let data
  try { data = JSON.parse(await curl(url, { proxy, timeoutMs })) } catch { return [] }
  const body = data?.body || {}
  const items = body.illust?.data || body.illustManga?.data || []
  const out = []
  for (const it of items) {
    const id = String(it?.id ?? '')
    if (!id) continue
    let u = it?.urls?.regular || it?.url || ''
    if (!u) continue
    u = toDownloadable(u)
    if (!u) continue
    const pageCount = Number(it?.pageCount) || 1
    if (skipMultiPage && pageCount > 1) continue
    out.push({ id, url: u, pageCount })
  }
  return out
}

/** 清掉多余的临时图（按时间从旧到新删），别让 temp 目录无限长。 */
function pruneTmp() {
  try {
    const files = fs.readdirSync(TMP_DIR)
      .map((n) => ({ p: path.join(TMP_DIR, n), t: (() => { try { return fs.statSync(path.join(TMP_DIR, n)).mtimeMs } catch { return 0 } })() }))
      .sort((a, b) => a.t - b.t)
    while (files.length > KEEP_TMP) {
      const f = files.shift()
      try { fs.unlinkSync(f.p) } catch { /* ignore */ }
    }
  } catch { /* 目录不存在就算了 */ }
}

/** 把一个图片 URL 下到临时目录，返回本地文件路径。 */
async function downloadToTmp(url, { proxy, timeoutMs, pageCount = 1 } = {}) {
  let realUrl = String(url || '')
  // 多页图集随机抽一页：全下会把体积和耗时乘上页数
  if (Number(pageCount) > 1) {
    const idx = Math.floor(Math.random() * Number(pageCount))
    realUrl = realUrl.replace(/_p\d+_/, `_p${idx}_`)
  }
  // 兜底：searchPage 已经保证这里是可下载的大图地址；万一别处传进来还是压缩缩略图
  // （/c/ 前缀 + _square1200），这里再改一次。已经是 img-master 大图的不会被重复改写。
  if (realUrl.includes('/c/') && realUrl.includes('_square1200.')) {
    realUrl = toDownloadable(realUrl)
  }
  if (!realUrl) return null
  const ext = normalizeExt(realUrl)
  fs.mkdirSync(TMP_DIR, { recursive: true })
  const dest = path.join(TMP_DIR, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`)
  const buf = await curl(realUrl, { proxy, referer: PIXIV_REFERER, timeoutMs, binary: true })
  if (!buf || buf.length < 200) return null   // 太小的基本是错误页
  fs.writeFileSync(dest, buf)
  return dest
}

/* ══════════════════════════════════════════════════════════════════════
   四、对外唯一入口
   ══════════════════════════════════════════════════════════════════════ */

/**
 * 拿一张图的本地文件。返回 { path, tag, bytes } 或 { error }。
 * 主标签不行就用最宽的兜底标签，再不行才放弃（放弃时由调用方退化成纯文字）。
 *
 * 标签必须是**单个词**：这套索引把整个 query 当一个标签匹配，带空格必然 0 结果。
 */
export async function fetchOneImage(tag, override) {
  const opt = resolvePixivOptions(override)
  const want = String(tag ?? '').trim()

  // 代理可能没开：先探测，必要时按 pixiv 插件里的设置把 sing-box 拉起来。
  // ⚠️ 字段名必须映射对：ensureProxy 要的是 { proxy, autoStart, coreDir }，
  //    而配置里叫 autoStartProxy / proxyCoreDir。写成同名会在代理没开时
  //    永远报「未开启自动拉起」—— 配图静默变纯文字，最难查的那种。
  const pre = await ensureProxy({
    proxy: opt.proxy,
    autoStart: opt.autoStartProxy,
    coreDir: opt.proxyCoreDir
  })
  if (!pre.ok) {
    return { error: `代理不可用：${pre.reason || '未知原因'}（配图需要走代理访问 Pixiv）` }
  }

  const tried = []
  const tags = [want, FALLBACK_TAG].filter(Boolean)
  for (const t of tags) {
    if (/\s/.test(t)) { tried.push(`「${t}」含空格（索引只认单个标签），跳过`); continue }
    let items = []
    try {
      items = await searchPage(t, 1, opt)
    } catch (e) {
      tried.push(`${t}: 搜索失败 ${describe(e)}`)
      continue
    }
    if (!items.length) { tried.push(`${t}: 没有结果`); continue }

    // 前几条里随机挑，免得同一档签老是同一张图
    const pool = items.slice(0, PICK_FROM)
    const start = Math.floor(Math.random() * pool.length)
    for (let i = 0; i < pool.length; i++) {
      const item = pool[(start + i) % pool.length]
      if (!/^https?:\/\//i.test(item.url)) continue
      try {
        const file = await downloadToTmp(item.url, { ...opt, pageCount: item.pageCount })
        if (!file) { tried.push(`${t}: 下回来是空的`); continue }
        const size = (() => { try { return fs.statSync(file).size } catch { return 0 } })()
        if (!size) { try { fs.unlinkSync(file) } catch { /* ignore */ } tried.push(`${t}: 下回来是空的`); continue }
        pruneTmp()
        return { path: file, tag: t, bytes: size }
      } catch (e) {
        tried.push(`${t}: ${String(e?.message ?? e).slice(0, 60)}`)
      }
    }
    tried.push(`${t}: 这几条都取不到图`)
  }
  return { error: tried.join('；') || '没拿到图' }
}

function describe(error) {
  if (!error) return '未知错误'
  return String(error?.message || error)
}

// 便于自检直接打纯函数（不打网络、不碰宿主）
export const internals = { proxyHostPort, normalizeExt, pruneTmp, toDownloadable, curl }
