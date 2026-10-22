// 看B站视频（bilibili-peek v1.0.0）—— 本地自制技能
//
// 思路：**不下载视频、不用 ffmpeg**，靠 B 站自己提供的两个公开接口"看见"画面：
//   1) x/web-interface/view     → 标题 / UP主 / 时长 / 统计 / 简介 / 分P / 封面
//   2) x/player/videoshot       → **缩略图雪碧图**：B 站已按时间点把视频抽成
//                                 若干画面帧、拼成网格图。等于官方替我们抽好了帧。
//
// 两条图片随工具结果一起返回，由核心（orchestrator）作为多模态 user 消息补发，
// 模型因此能"看"到真实画面 —— 见 src/orchestrator.js
//   media = result.content.filter(p => p.type === 'image_url' || p.type === 'video_url')
//
// ⚠️ 约定（照抄核心的规矩，别改）：
//   · 媒体一律走 parts（{type:'image_url'}），**绝不能**把 base64 塞进 text ——
//     那样模型看不到图却要为几十万 token 付钱。
//   · 工具结果文本以 `status: ok` / `status: error` 开头，模型据此判断成败。
//   · 只用公开只读接口，不发任何需要登录态的请求。

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com/'

const SKILL_ID = 'bilibili-peek'

/** 从任意输入里认出 BV 号或 av 号。返回 {bvid} 或 {aid} 或 null。 */
function parseId(input) {
  const s = String(input ?? '').trim()
  if (!s) return null
  const bv = s.match(/BV[0-9A-Za-z]{10}/)
  if (bv) return { bvid: bv[0] }
  const av = s.match(/av(\d{1,12})/i)
  if (av) return { aid: av[1] }
  // 纯数字也当 aid（用户可能只丢个数字）
  if (/^\d{1,12}$/.test(s)) return { aid: s }
  return null
}

function cfgOf(ctx) {
  const raw = ctx?.skillConfig ?? ctx?.config?.skills?.[SKILL_ID] ?? {}
  return {
    includeCover: raw.includeCover !== false,
    includeStoryboard: raw.includeStoryboard !== false,
    maxStoryboards: Math.max(0, Math.min(6, Number(raw.maxStoryboards) || 2)),
    maxBytes: Math.max(1, Number(raw.maxImageMB) || 4) * 1024 * 1024,
    timeoutMs: Math.max(5000, Number(raw.timeoutMs) || 30000)
  }
}

async function fetchJson(url, timeoutMs) {
  const res = await fetch(url, {
    headers: {
      'user-agent': UA,
      referer: REFERER,
      accept: 'application/json, text/plain, */*'
    },
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/**
 * 解析 b23.tv 等短链：跟着重定向拿到最终 URL，再从里面认 BV 号。
 * 背景：用户几乎总是发 App 分享出来的 b23.tv 短链，里面**没有** BV 号；
 * 不解析的话模型得自己换 web_fetch 再重试（实测多花 2 次工具调用）。
 */
async function resolveShortLink(input, timeoutMs) {
  const s = String(input ?? '').trim()
  if (!/^https?:\/\//i.test(s)) return ''
  try {
    const res = await fetch(s, {
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs)
    })
    const finalUrl = String(res.url || '')
    if (/BV[0-9A-Za-z]{10}/.test(finalUrl)) return finalUrl
    // 有些短链跳到落地页后 BV 只出现在正文里，兜底扫一遍前 64KB
    const text = (await res.text()).slice(0, 65536)
    const m = text.match(/BV[0-9A-Za-z]{10}/)
    return m ? m[0] : ''
  } catch {
    return ''
  }
}

/** 下载图片转 data URL。超限/失败抛错，由调用方决定是否降级。 */
async function toDataUrl(url, timeoutMs, maxBytes) {
  if (!url) return null
  const u = String(url).startsWith('//') ? `https:${url}` : String(url)
  const res = await fetch(u, {
    headers: { 'user-agent': UA, referer: REFERER },
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (!buf.length) throw new Error('空图片')
  if (buf.length > maxBytes) throw new Error(`图片 ${(buf.length / 1048576).toFixed(1)}MB 超过上限`)
  const ct = String(res.headers.get('content-type') || 'image/jpeg').split(';')[0]
  return `data:${ct};base64,${buf.toString('base64')}`
}

function fmtDuration(sec) {
  const s = Math.max(0, Number(sec) || 0)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = Math.floor(s % 60)
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `${m}:${String(ss).padStart(2, '0')}`
}

function fmtCount(n) {
  const v = Number(n) || 0
  if (v >= 100000000) return `${(v / 100000000).toFixed(2)} 亿`
  if (v >= 10000) return `${(v / 10000).toFixed(1)} 万`
  return String(v)
}

function stripHtml(s) {
  return String(s ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
}

export function setup(api) {
  api.registerTool({
    id: 'peek',
    name: '看B站视频',
    description:
      '给一个 B 站视频链接或 BV 号，抓取标题、UP主、时长、播放/弹幕/点赞、简介、分P，'
      + '并把**封面**和 **B 站官方的视频画面帧（缩略图雪碧图）**作为图片返回给你直接"看"。'
      + '所以你能真的看到视频里有哪些画面。用户发 B 站链接、让你总结/评价/判断视频内容、'
      + '或者问"这个视频讲了啥"的时候调用。'
      + '返回第一行是 status：ok=拿到了 / error=失败（原因在下一行）。',
    category: 'query',
    icon: '📺',
    requiresVision: true,
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'B 站视频链接、BV 号或 av 号，例如 https://www.bilibili.com/video/BV1GJ411x7h7'
        }
      },
      required: ['url']
    },

    async execute(ctx, args) {
      const cfg = cfgOf(ctx)
      let id = parseId(args?.url)
      if (!id) {
        // 短链（b23.tv 等）里没有 BV 号，跟一次重定向再认
        const resolved = await resolveShortLink(args?.url, cfg.timeoutMs)
        if (resolved) id = parseId(resolved)
      }
      if (!id) {
        return {
          content: 'status: error\n没能从参数里认出 B 站视频（需要 BV 号、av 号或完整链接，'
            + '例如 https://www.bilibili.com/video/BV1GJ411x7h7；b23.tv 短链也可以）。',
          isError: true
        }
      }

      const q = id.bvid ? `bvid=${encodeURIComponent(id.bvid)}` : `aid=${encodeURIComponent(id.aid)}`
      const bvid = id.bvid || ''

      // ── 1. 视频信息 ────────────────────────────────────────────
      let view
      try {
        view = await fetchJson(`https://api.bilibili.com/x/web-interface/view?${q}`, cfg.timeoutMs)
      } catch (e) {
        return { content: `status: error\n请求 B 站接口失败：${e?.message ?? e}`, isError: true }
      }
      if (Number(view?.code) !== 0 || !view?.data) {
        return {
          content: `status: error\nB 站接口返回 code=${view?.code} ${view?.message || ''}`
            + '（视频可能被删、被锁或需要登录）。',
          isError: true
        }
      }

      const d = view.data
      const stat = d.stat || {}
      const owner = d.owner || {}
      const pages = Array.isArray(d.pages) ? d.pages : []
      const realBvid = String(d.bvid || bvid)
      const lines = [
        'status: ok',
        `标题：${d.title || '(无)'}`,
        `UP主：${owner.name || '(未知)'}${owner.mid ? ` (uid ${owner.mid})` : ''}`,
        `时长：${fmtDuration(d.duration)}（${d.duration} 秒）  `
          + `发布：${d.pubdate ? new Date(d.pubdate * 1000).toLocaleDateString('zh-CN') : '(未知)'}`,
        `数据：播放 ${fmtCount(stat.view)} · 弹幕 ${fmtCount(stat.danmaku)} · `
          + `点赞 ${fmtCount(stat.like)} · 投币 ${fmtCount(stat.coin)} · 收藏 ${fmtCount(stat.favorite)}`,
        `链接：https://www.bilibili.com/video/${realBvid}`
      ]
      if (pages.length > 1) {
        lines.push(`分P（共 ${pages.length} 个，只列前 8 个）：`)
        for (const p of pages.slice(0, 8)) {
          lines.push(`  P${p.page} ${stripHtml(p.part)}  ${fmtDuration(p.duration)}`)
        }
      }
      const desc = stripHtml(d.desc)
      if (desc && desc !== '-') lines.push(`简介：${desc.slice(0, 400)}`)
      lines.push('')
      lines.push('下面的图片：第 1 张是视频封面；其余是 B 站官方按时间点抽好的画面帧网格图'
        + '（网格里每小格 = 视频某一时刻的画面，时间点均匀分布）。请据此描述视频画面内容。')

      const parts = [{ type: 'text', text: lines.join('\n') }]

      // ── 2. 封面 ────────────────────────────────────────────────
      const notes = []
      if (cfg.includeCover) {
        try {
          const u = await toDataUrl(d.pic, cfg.timeoutMs, cfg.maxBytes)
          if (u) parts.push({ type: 'image_url', image_url: { url: u } })
        } catch (e) {
          notes.push(`封面取不到（${e?.message ?? e}）`)
        }
      }

      // ── 3. 视频画面帧（官方雪碧图）────────────────────────────
      if (cfg.includeStoryboard && cfg.maxStoryboards > 0) {
        try {
          const vs = await fetchJson(
            `https://api.bilibili.com/x/player/videoshot?${q}&index=1`, cfg.timeoutMs)
          if (Number(vs?.code) === 0) {
            const imgs = Array.isArray(vs?.data?.image) ? vs.data.image : []
            const idx = Array.isArray(vs?.data?.index) ? vs.data.index : []
            if (!imgs.length) {
              notes.push('B 站没有给出画面帧（可能是番剧/付费内容）')
            } else {
              let got = 0
              for (const u of imgs.slice(0, cfg.maxStoryboards)) {
                try {
                  const du = await toDataUrl(u, cfg.timeoutMs, cfg.maxBytes)
                  if (du) { parts.push({ type: 'image_url', image_url: { url: du } }); got += 1 }
                } catch (e) {
                  notes.push(`画面帧取不到（${e?.message ?? e}）`)
                }
              }
              if (got && idx.length) {
                // 注：videoshot 的 index 单位口径不统一（实测为相对偏移量，直接换算成秒会出错），
                // 因此只报"帧数"，不报时间区间，避免给模型错误的时间信息。
                parts[0].text += `\n（该雪碧图含 ${idx.length} 格画面，均匀分布在整段视频上）`
              }
            }
          } else {
            notes.push(`画面帧接口 code=${vs?.code} ${vs?.message || ''}`)
          }
        } catch (e) {
          notes.push(`画面帧请求失败（${e?.message ?? e}）`)
        }
      }

      if (notes.length) parts[0].text += `\n\n【部分降级】${notes.join('；')}`

      const imgCount = parts.filter((p) => p.type === 'image_url').length
      if (!imgCount) {
        parts[0].text += '\n\n（这次一张图都没取到，只能依据上面的文字信息回答，'
          + '不要编造画面内容。）'
      }

      return { content: parts }
    }
  })
}

export function available() {
  return true
}
