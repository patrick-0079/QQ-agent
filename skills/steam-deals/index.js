// Steam 史低好价（steam-deals v1.2.0）
//
// 展示格式（用户点名要的，别自作主张加东西）：
//   1. 博德之门3（Baldur's Gate 3）  ¥298 → ¥89.40  新史低  -70%
// 一行一款，**不写好评、不写截止日期、不写逐款封面图**；
// 每 perBubble 款换一个气泡；全部发完后追加一张随机 pixiv 二次元图收尾。
//
// ── 中文译名（三级，见 game-names.js）────────────────────────────────────
//   Steam 官中 → 本地核实过的词典 → DeepSeek 兜底。
//   公共机翻不能用：实测 Steep→"陡峭"、The Outlast Trials→"长生不老的审判"。
//
// ── 设计要点（几条踩过的坑，别改）──────────────────────────────────────
// 1) 触发闸门：只在私聊或被点名时给（ctx.session.contextTier，私聊=4、被@=1）。
//    拿不到档位时不硬拦，交给提示词约束。
// 2) 史低判定口径见 steam-data.js：现价 == 史低是"平史低"、< 才是"新史低"，
//    绝不能简化成 <=（实测有差 4 毛钱的反例）。
// 3) Steam 直连会被限流(403)，steam-data.js 里已做"直连优先、403 自动切代理"。
// 4) 图片/媒体段必须走 ctx.sender，不能绕过（会跳过限频与留档）。

import {
  scanDeals, renderDealsCompact, initSteam,
  resolveCurrencyCode, getRate, convertCents,
  resolveGenre, listGenreNames
} from './steam-data.js'
import { fetchOneImage, initPixiv, warmPixivConfig } from './pixiv-fetch.js'
// ⚠️ 写配置的唯一入口。绝不能自己读改写 config.json —— 那会绕过内存中的配置单例。
import { setSkillConfig } from '../../src/skills/config.js'

const SKILL_ID = 'steam-deals'

/** 结尾配图的标签池：二次元风格，全部实测 xRestrict=0（无 R18）。 */
const ANIME_TAGS = ['ちびキャラ', 'デフォルメ', '女の子', 'かわいい', 'アニメ']

let cfgOf = () => ({})
let log = () => {}

/* ══════════════════════════════════════════════════════════════════════
   触发闸门
   ══════════════════════════════════════════════════════════════════════ */

function gate(ctx, cfg) {
  if (ctx?.kind === 'private') return ''
  if (cfg?.mentionOnly === false) return ''
  const tier = Number(ctx?.session?.contextTier)
  if (tier === 1) return ''
  if (!Number.isFinite(tier)) return ''
  return `这次在群里没被点名（档位 ${tier}，不是被 @ 也不是拍一拍），Steam 折扣只在被点名或私聊时给。`
    + '把这条当作没发生：不要跟群里解释、不要提打折这回事，正常聊别的就行。'
}

/**
 * 结尾配图：随机挑标签取一张二次元图。失败返回 null（不影响清单发送）。
 *
 * ⚠️ 必须限时：实测代理会抖动，某个标签搜索超时 + 后续标签也失败时，
 *    原来最多会卡 5 个标签 × 长超时 ≈ 60 秒，把整条消息拖死。
 *    现在最多试 3 个标签、每个 15 秒、整体 25 秒封顶 —— 配图是锦上添花，
 *    绝不能因为它让用户等一分钟。
 */
const IMAGE_TOTAL_BUDGET_MS = 25000
const IMAGE_PER_TAG_MS = 15000
const IMAGE_MAX_TAGS = 3

async function fetchEndingImage() {
  const deadline = Date.now() + IMAGE_TOTAL_BUDGET_MS
  const pool = [...ANIME_TAGS].sort(() => Math.random() - 0.5).slice(0, IMAGE_MAX_TAGS)
  for (const tag of pool) {
    const left = deadline - Date.now()
    if (left <= 3000) break
    const r = await fetchOneImage(tag, { timeoutMs: Math.min(IMAGE_PER_TAG_MS, left) })
    if (r?.path) return { path: r.path, tag: r.tag }
  }
  return null
}

/* ══════════════════════════════════════════════════════════════════════
   技能契约
   ══════════════════════════════════════════════════════════════════════ */

export function setup(api) {
  cfgOf = () => (api.config && typeof api.config === 'function' ? (api.config() || {}) : {})
  log = (...a) => { try { api.log(...a) } catch { /* 日志失败不影响主流程 */ } }

  initSteam({ config: () => cfgOf(), log })
  initPixiv({ log })
  warmPixivConfig().catch(() => { /* 预热失败：配图会用默认代理设置 */ })

  /* ── 工具一：查折扣并发出去 ───────────────────────────────────────── */
  api.registerTool({
    id: 'deals',
    name: '查 Steam 史低好价',
    description:
      '抓当前 Steam 正在打折的热门游戏，用 IsThereAnyDeal 的史低价判定**新史低/平史低**，'
      + '按评测数过滤冷门、按折扣到期时间掠过过期信息；游戏名显示为「中文名（英文名）」，'
      + '价格按设置的货币换算，每 10 款换一个气泡，全部发完再补一张二次元配图。'
      + '被问「Steam 最近有什么打折的 / 有没有史低好价 / 什么游戏值得买」时调用。'
      + '⚠️ 这个工具**自己发消息**：调完不要再调 send_message，直接结束这一轮。'
      + '返回第一行是 status：ok=已发出 / no-target=群里没被点名，不用回应 / error=失败。',
    category: 'query',
    icon: '🎮',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'number', description: '要列几款，5~20，默认按用户设置（一般 10）。' },
        genre: {
          type: 'string',
          description: '游戏分类，例如 赛车 / 竞速 / 射击 / 角色扮演 / 策略 / 恐怖 / 合作 / 开放世界 等。'
            + '用户点名要某一类时传它；用户没提分类就**不要传**（默认全部类型）。'
        },
        currency: {
          type: 'string',
          description: '临时按指定货币换算，如 USD / UAH / RUB / 美元 / 乌克兰。留空则用用户设置里的默认货币。'
        }
      }
    },

    async execute(ctx, args) {
      const cfg = cfgOf()

      const deny = gate(ctx, cfg)
      if (deny) {
        log(`拒绝一次未点名的调用（档位 ${ctx?.session?.contextTier ?? '?'}）`)
        return { content: `status: no-target\n${deny}`, isError: true }
      }

      if (!String(cfg.itadKey ?? '').trim()) {
        return {
          content: 'status: error\n没有配置 ITAD API Key，无法判定史低（Steam 官方不提供历史最低价）。'
            + '请在「技能 → Steam 史低好价 → 设置」里填入 https://isthereanydeal.com/apps/my/ 免费申请的 key。',
          isError: true
        }
      }

      const sender = ctx?.sender
      const chatKey = String(ctx?.chatKey || '')
      if (!sender || !chatKey) {
        return { content: 'status: error\n拿不到发送通道（ctx.sender / chatKey），这条没发出去。', isError: true }
      }

      const tempCurrency = args?.currency ? resolveCurrencyCode(args.currency) : null
      let result
      try {
        result = await scanDeals({
          count: args?.count,
          currency: tempCurrency || cfg.currency,
          genre: args?.genre
        })
      } catch (e) {
        const msg = String(e?.message ?? e).slice(0, 180)
        log(`扫描失败：${msg}`)
        return { content: `status: error\n抓取 Steam 折扣失败：${msg}。稍后再试。`, isError: true }
      }

      // 认不出的分类：把能用的分类名给模型，让它转达（不要当成"没有好价"）
      if (result?.unknownGenre) {
        return {
          content: `status: error\n没有「${result.unknownGenre}」这个分类。可用的分类有：${listGenreNames().join('、')}。`
            + '请告诉用户换个分类，或者不带分类查全部。',
          isError: true
        }
      }

      const { items, stats, warning, currency, rate, rateError, genre } = result || {}
      if (warning) {
        log(`扫描告警：${warning}`)
        return { content: `status: error\n${warning}`, isError: true }
      }

      const { bubbles, plain } = renderDealsCompact(items || [], stats, {
        currency, rate, rateError, perBubble: cfg.perBubble,
        genreName: genre?.name || '',
        // 每款游戏下面放这张游戏的封面（用户 v1.4.0 要求）
        withCovers: cfg.showCover !== false
      })

      const canMedia = typeof sender.sendMedia === 'function'
      const canText = typeof sender.sendTextBatch === 'function'
      let sent = 0
      // 发送前先取结尾配图，追加到**最后一个气泡**里 —— 这样整条清单是
      // 「...最后一款 + 配图 + 数据来源」同一条消息收尾，符合用户"由一张图结束"。
      // 必须在发送前追加：发出去之后再改数组没有任何效果。
      let imgNote = ''
      if (cfg.pixivImage !== false) {
        const img = await fetchEndingImage()
        if (img) {
          const last = bubbles[bubbles.length - 1]
          if (Array.isArray(last)) {
            last.push({ type: 'image', data: { file: img.path } })
            // ITAD 条款要求署名 —— 放在配图这条上，不污染清单正文
            last.push({ type: 'text', data: { text: '数据来源：Steam 商店 + IsThereAnyDeal.com' } })
            imgNote = `（含结尾配图，标签 ${img.tag}）`
          }
        } else {
          log('结尾配图未取到（代理或图库问题），清单照常发出')
        }
      }

      try {
        if (canMedia) {
          for (const segs of bubbles) {
            await sender.sendMedia(chatKey, segs, { label: 'Steam 史低好价' })
            sent++
          }
        } else if (canText) {
          await sender.sendTextBatch(chatKey, [plain], {})
          sent = 1
        } else {
          return { content: 'status: error\n发送通道不支持发送，这条没发出去。', isError: true }
        }

        log(`已发送 ${sent} 条（${(items || []).length} 款，币种 ${currency}${imgNote ? '，含结尾配图' : ''}）`)
        return {
          content: `status: ok\n已发出：${(items || []).length} 款 Steam 史低好价，共 ${sent} 条消息${imgNote}。`
            + '不要再用 send_message 复述内容、也不要自己再补推荐，直接结束这一轮。'
        }
      } catch (e) {
        const msg = String(e?.message ?? e).slice(0, 150)
        log(`发送失败（已发出 ${sent} 条）：${msg}`)
        return { content: `status: error\n发送失败：${msg}`, isError: true }
      }
    }
  })

  /* ── 工具二：切换计价货币 ─────────────────────────────────────────── */
  api.registerTool({
    id: 'currency',
    name: '设置计价货币',
    description:
      '把 Steam 折扣的计价货币换成指定国家/币种，例如「换成乌克兰汇率」「按美元显示」「用卢布」。'
      + '用户明确要求切换或询问当前用什么货币时调用。只改本技能的默认货币设置。',
    category: 'query',
    icon: '💱',
    parameters: {
      type: 'object',
      properties: {
        currency: {
          type: 'string',
          description: '目标货币：国家名或币种都行（乌克兰 / UAH / 美国 / USD / 俄罗斯 / RUB / 人民币 / CNY 等）。留空则只查询当前设置，不做修改。'
        }
      }
    },

    async execute(ctx, args) {
      const cfg = cfgOf()
      const input = String(args?.currency ?? '').trim()

      if (!input) {
        const now = String(cfg.currency || 'CNY').toUpperCase()
        const r = now === 'CNY' ? 1 : await getRate(now)
        return {
          content: `当前计价货币：${now}${Number.isFinite(r) && now !== 'CNY' ? `（1 人民币 ≈ ${Number(r).toFixed(4)} ${now}）` : ''}。`
            + '要换的话说一声，比如「换成乌克兰汇率」。'
        }
      }

      const code = resolveCurrencyCode(input)
      if (!code) {
        return { content: `认不出「${input}」这个货币。可以说国家名（乌克兰/美国/俄罗斯/日本…）或币种代码（UAH/USD/RUB/JPY…）。`, isError: true }
      }

      let rate = 1
      if (code !== 'CNY') {
        rate = await getRate(code)
        if (!Number.isFinite(rate)) {
          return { content: `货币 ${code} 的汇率暂时取不到（汇率源可能不通）。没有改动设置，稍后再试。`, isError: true }
        }
      }

      let after = null
      try {
        after = setSkillConfig(SKILL_ID, { currency: code })
      } catch (e) {
        log(`写入货币设置失败：${String(e?.message || e).slice(0, 100)}`)
      }
      if (String(after?.currency || '').toUpperCase() !== code) {
        return { content: `换算没问题，但设置没能写入（当前仍是 ${String(cfg.currency || 'CNY').toUpperCase()}）。`, isError: true }
      }

      return {
        content: `已把 Steam 折扣的计价货币换成 ${code}（1 人民币 ≈ ${Number(rate).toFixed(4)} ${code}）。`
          + `例如一款 ¥100 的游戏会显示成 ${convertCents(10000, rate, code)}。`
          + '之后查折扣都按这个货币；想改回人民币就说「换回人民币」。'
      }
    }
  })

  log(`${SKILL_ID} 已就绪（工具：${SKILL_ID}__deals / ${SKILL_ID}__currency）`)
}

export function available() {
  return true
}

export function dispose() {
  cfgOf = () => ({})
  log = () => {}
}

export const internals = { gate }
