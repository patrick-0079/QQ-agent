// 功能介绍（skill-summary）—— 把机器人**当前真正生效**的技能，自动汇总成
// 1.2.3.4.5… 的简洁清单，并配一张随机的 Pixiv Q 版二次元图，
// 文字与图片**合并成同一条消息**（一个气泡：列表在上、图在下）发出去。
//
// ── 设计要点（几条踩过的坑，别改）──────────────────────────────────────
//
// 1) **清单是"自动汇总"，不是写死的文案**
//    数据源是核心的 skillManager（../../../src/skills/manager.js），
//    只取 `active === true` 的条目 —— 也就是"设置里已启用 + 依赖满足"的。
//    于是：关掉的技能、加载失败的残留目录，都不会出现在清单里；
//    用户以后装上新技能，这个清单会自动跟上，不用回来改代码。
//    （已在真机验证：29 个已加载条目里正确筛出 18 个生效的。）
//
// 2) **触发闸门：只在私聊或被点名时给**（与 daily-fortune 同一套判据）
//    宿主在 ctx.session.contextTier 里给了触发档位（src/orchestrator.js:853，
//    档位定义见 src/prompt.js 的 resolveContextTier / config.js:265）：
//      私聊 = tier 4「私聊消息」；被 @ / 拍了拍我 = tier 1。
//    群里随机接话是 tier 2/3，这时拒绝并让模型别声张 —— 否则一接话就报菜单，群里会烦。
//    ⚠️ 拿不到档位信息时（宿主换了实现）**不硬拦**，交给提示词约束：
//       宁可极端情况下偶尔多说一句，也不要让整个功能静默失效。
//
// 3) **配图复用 pixiv 插件那套**（见 pixiv-fetch.js）
//    不依赖 skills/pixiv-search（那东西本机根本没有），也不需要装 Python。
//    代理、v2rayN 目录、内容分级都从核心配置的 skills['pixiv-image-tagsearch'] 读，
//    用户不用再填一遍；代理没开会自动拉起 sing-box。
//
// 4) **"每次问都随机换一张"**
//    每次执行都从 Q 版标签池里随机挑一个标签，再在命中的前几条里随机挑一条，
//    所以同一天连问两次也会换图（这是用户明确要的，别改成"按日期固定"）。
//    兜底标签固定为「女の子」，保证主标签搜不到时还有图，不至于空手。

import fs from 'node:fs'
import { fetchOneImage, initPixiv, warmPixivConfig } from './pixiv-fetch.js'

const SKILL_ID = 'skill-summary'

/** Q 版标签池：全部实测能搜到结果、且 xRestrict 全为 0（无 R18，实测 2026-10-02）。 */
const CHIBI_TAGS = ['ちびキャラ', 'デフォルメ', 'ちび', 'SD']

/**
 * 默认排掉两类技能：
 *   ① 纯框架内部件 —— 念给用户听不出价值（缓存复用、token 节流）；
 *   ② 名字带 _1 _2 _3 的重复副本 —— 同一个技能在磁盘上装了好几份，
 *      列出来会变成"点歌、点歌、点歌"。
 * 用户可在技能设置里改（清空 = 全都列出来）。
 */
const DEFAULT_EXCLUDE = [
  'cache-stability', 'token-saver', 'skill-summary',
  'affinity_1', 'affinity_2',
  'music_1', 'music_2', 'music_3',
  'trpg_1',
  'verify-first_1', 'verify-first_2', 'verify-first_3',
  'pixiv-image-tagsearch_1',
  'ai-image_1', 'bili-share_1',
  'daily-fortune_1', 'daily-fortune_2', 'daily-fortune_3'
]

// ── 宿主注入的引用 ────────────────────────────────────────────────────
let cfgOf = () => ({})
let log = () => {}

/** 核心 skillManager 模块（拿不到时清单功能降级，但工具本身照常可用）。 */
let coreSkillsRef = null

/* ══════════════════════════════════════════════════════════════════════
   一、触发闸门（见文件头第 2 条）
   ══════════════════════════════════════════════════════════════════════ */

function gate(ctx, cfg) {
  if (ctx?.kind === 'private') return ''          // 私聊不拦
  if (cfg?.mentionOnly === false) return ''       // 用户主动关掉了"只被点名时给"

  const tier = Number(ctx?.session?.contextTier)
  if (tier === 1) return ''                       // 被 @ / 拍了拍我
  if (!Number.isFinite(tier)) return ''           // 宿主没给档位：不硬拦，交给提示词

  return `这次在群里没被点名（档位 ${tier}，不是被 @ 也不是拍一拍），功能清单只在被点名或私聊时给。`
    + '把这条当作没发生：不要跟群里解释、不要提功能清单这回事，正常聊别的就行。'
}

/* ══════════════════════════════════════════════════════════════════════
   二、读技能清单
   ══════════════════════════════════════════════════════════════════════ */

/**
 * 取核心 skillManager。
 * ⚠️ 路径深度：本文件是 app/skills/skill-summary/index.js，退**两**层到 app
 *    再进 src/ 才是 app/src/skills/manager.js。写成 ../../../src 会跑到
 *    resources/src（不存在），表现为"读不到技能注册表"。
 * 拿不到时返回 null（清单会降级成一句提示，不抛错）。
 */
export async function warmSkillManager() {
  if (coreSkillsRef) return coreSkillsRef
  try {
    coreSkillsRef = await import('../../src/skills/manager.js')
  } catch (error) {
    coreSkillsRef = null
    log(`读不到核心技能注册表（清单会降级）：${describe(error)}`)
  }
  return coreSkillsRef
}

/** 解析排除名单：优先用用户设置，留空 = 用默认（见文件头）。 */
function excludeSet(cfg) {
  const raw = cfg?.excludeIds
  if (raw === undefined || raw === null) return new Set(DEFAULT_EXCLUDE)
  const items = String(raw)
    .split(/[,，、;；\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  return new Set(items)
}

/**
 * 当前真正生效的技能（active = 已启用 + 依赖满足）。
 * 读不到注册表或表是空的，都算"拿不到" → 由调用方降级处理。
 *
 * 兜底：正常启动流程里 plugin-loader 必然先跑过（技能就是它加载的），此时 list()
 * 直接有值。万一将来加载顺序变了、表是空的，这里补调一次 loadPlugins 再试一次 ——
 * 总比对着用户报"读不到技能注册表"强。只会在表为空时付这个代价。
 */
async function collectActive(cfg) {
  // 自己补齐：setup 里那句预热是 fire-and-forget，调用时未必已经完成。
  // 不能依赖"加载到用户提问之间的时间差"，必须在这里自己 await 一次（幂等）。
  const ref = await warmSkillManager()
  if (!ref || typeof ref.skillManager?.list !== 'function') return null

  let list = []
  try {
    list = ref.skillManager.list() || []
  } catch (error) {
    log(`列技能失败：${describe(error)}`)
    return null
  }

  if (!list.length) {
    try {
      const loader = await import('../../src/plugin-loader.js')
      if (typeof loader?.loadPlugins === 'function') {
        await loader.loadPlugins()
        list = ref.skillManager.list() || []
      }
    } catch (error) {
      log(`补加载技能失败：${describe(error)}`)
    }
  }
  if (!list.length) return null

  const skip = excludeSet(cfg)
  return list.filter((s) => s && s.active === true && !skip.has(String(s.id)))
}

/** 简介：压空白 → 用句号切出第一句 → 去掉括号补充 → 超长截断。 */
function briefing(description, maxChars) {
  let d = String(description || '')
    .replace(/\*\*/g, '')                 // markdown 粗体标记
    .replace(/\s+/g, '')                  // 聊天里不要换行和多余空格
    .trim()
  d = d.split(/[。；;！!？?]/)[0] || ''    // 只留第一句
  d = d.replace(/[（(][^）)]*[）)]/g, '')  // 去掉括号补充说明
  d = d.replace(/[，,、]$/, '').trim()     // 去掉结尾残留的顿号
  const max = Math.max(6, Number(maxChars) || 22)
  if (d.length > max) d = `${d.slice(0, max)}…`
  return d
}

/**
 * 组装清单文案。返回 { text, count, total } 或 { error }。
 * 编号固定 1.2.3.4.5…；超出上限时只报总数，不逐条列（免得刷一屏）。
 */
async function buildSummaryText(ctx, cfg) {
  const items = await collectActive(cfg)
  if (!items) {
    return { error: '读不到技能注册表，这次列不出功能清单（不影响聊天）。' }
  }

  const total = items.length
  const max = Math.max(1, Math.floor(Number(cfg?.maxItems) || 20))
  const shown = items.slice(0, max)
  const briefMax = Number(cfg?.briefLength) || 22

  const who = String(ctx?.botName || ctx?.selfNickname || '我').trim()
  const lines = shown.map((s, i) => {
    const name = String(s.name || s.id).trim()
    const brief = briefing(s.description, briefMax)
    return `${i + 1}. ${name}${brief ? `：${brief}` : ''}`
  })

  const head = `【${who} 现在会的 ${total} 项】`
  const tail = total > max
    ? `\n…另外还有 ${total - max} 项，想细问哪一类直接说。`
    : ''
  return { text: `${head}\n${lines.join('\n')}${tail}`, count: shown.length, total }
}

/* ══════════════════════════════════════════════════════════════════════
   三、配图
   ══════════════════════════════════════════════════════════════════════ */

/**
 * 随机取一张 Q 版图。返回 { path, tag } 或 { error }。
 * 每次调用都随机换标签 + 随机挑条目，所以同一天连问两次也会换图。
 */
async function fetchChibiImage(timeoutMs) {
  const pool = [...CHIBI_TAGS].sort(() => Math.random() - 0.5)   // 打乱，优先试到的标签也随机
  const tried = []
  for (const tag of pool) {
    const r = await fetchOneImage(tag, { timeoutMs })
    if (r?.path) return { path: r.path, tag: r.tag }
    tried.push(`${tag}: ${String(r?.error || '没拿到图').slice(0, 80)}`)
  }
  return { error: tried.join('；') || '没拿到图' }
}

/* ══════════════════════════════════════════════════════════════════════
   四、技能契约
   ══════════════════════════════════════════════════════════════════════ */

export function setup(api) {
  cfgOf = () => (api.config && typeof api.config === 'function' ? (api.config() || {}) : {})
  log = (...a) => { try { api.log(...a) } catch { /* 日志失败不影响主流程 */ } }

  // 配图模块：接日志 + 预热核心配置；技能注册表也提前拿一次，省得第一次调用时才读
  initPixiv({ log })
  warmPixivConfig().catch(() => { /* 预热失败：配图时会退回默认代理设置 */ })
  warmSkillManager().catch(() => { /* 预热失败：调用时会再试一次 */ })

  api.registerTool({
    id: 'summary',
    // ⚠️ 上游 registerTool 强制要求 name，少了它整个 setup 中断、工具一个都注册不上
    name: '发送功能介绍',
    description:
      '把机器人**当前生效**的技能自动整理成 1.2.3.4.5… 的简洁清单，'
      + '并配一张随机 Q 版二次元图，合并成**同一条消息**发出。'
      + '被问「你会什么 / 有什么功能 / 技能列表」时调用。'
      + '⚠️ 这个工具**自己发消息**：调完不要再调 send_message，直接结束这一轮。'
      + '返回第一行是 status：ok=已发出 / no-target=群里没被点名，不用回应 / error=失败。',
    category: 'system',
    icon: '📋',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '可选的简短开场白（清单与配图由工具生成）。留空则不带开场白。' }
      }
    },

    async execute(ctx, args) {
      const cfg = cfgOf()

      // ① 闸门：群里没被点名就拒绝，并让模型别声张
      const deny = gate(ctx, cfg)
      if (deny) {
        log(`拒绝一次未点名的调用（档位 ${ctx?.session?.contextTier ?? '?'}）`)
        return { content: `status: no-target\n${deny}`, isError: true }
      }

      // ② 生成清单
      const built = await buildSummaryText(ctx, cfg)
      if (built?.error) return { content: `status: error\n${built.error}`, isError: true }

      const opening = String(args?.text ?? '').replace(/\r/g, '').trim().slice(0, 80)
      const text = opening ? `${opening}\n${built.text}` : built.text

      // ③ 发送
      const sender = ctx?.sender
      const chatKey = String(ctx?.chatKey || '')
      if (!sender || !chatKey) {
        return { content: 'status: error\n拿不到发送通道（ctx.sender / chatKey），这条没发出去。', isError: true }
      }

      // 配图失败不影响发清单（失败就退化成纯文字一条）
      let img = null
      let imgErr = ''
      if (cfg.imageEnabled !== false) {
        const r = await fetchChibiImage(Number(cfg.imageTimeoutMs) || 30000)
        if (r?.path) img = r
        else {
          imgErr = String(r?.error || '没拿到图').slice(0, 200)
          log(`配图没拿到：${imgErr}`)
        }
      }

      try {
        // 同一批 segments = 同一条消息：列表在上、图在下
        if (img && typeof sender.sendMedia === 'function') {
          await sender.sendMedia(chatKey, [
            { type: 'text', data: { text } },
            { type: 'image', data: { file: img.path } }
          ], { label: '功能介绍（图文）' })
          log(`已发送（图文一条，共 ${built.total} 项，标签 ${img.tag}）`)
          return {
            content: `status: ok\n已发出：一条消息，含 ${built.total} 项功能清单与 1 张配图（标签「${img.tag}」）。`
              + '不要再用 send_message 复述清单内容，也不要向用户解释配图是怎么来的。'
          }
        }

        // 没图 / 通道不支持媒体段：退化成纯文字，**仍然是一条**
        if (typeof sender.sendTextBatch === 'function') {
          await sender.sendTextBatch(chatKey, [text], {})
        } else {
          return { content: 'status: error\n发送通道不支持发送，这条没发出去。', isError: true }
        }
        log(`已发送（仅文字，配图未取到：${imgErr || '未开启'}）`)
        return {
          // 失败原因写进返回值不只是日志：本机日志不落文件，截图就能带出来
          content: `status: ok\n已发出：一条纯文字清单（${built.total} 项）。不要再用 send_message 复述。`
            + (imgErr ? `\n（配图这次没拿到，原因：${imgErr}。别再为它重试或解释，就当没有图。）` : '')
        }
      } catch (e) {
        const msg = String(e?.message ?? e).slice(0, 150)
        log(`发送失败：${msg}`)
        return { content: `status: error\n发送失败：${msg}`, isError: true }
      }
    }
  })

  log(`${SKILL_ID} 已就绪（工具：${SKILL_ID}__summary）`)
}

/** 可用性自检：同步返回，绝不做 IO。 */
export function available() {
  return true
}

export function dispose() {
  cfgOf = () => ({})
  log = () => {}
}

// 便于自检直接打纯函数（不打网络、不碰宿主）
export const internals = {
  gate,
  briefing,
  buildSummaryText,
  collectActive,
  excludeSet,
  CHIBI_TAGS,
  DEFAULT_EXCLUDE,
  fetchChibiImage
}

function describe(error) {
  if (!error) return '未知错误'
  return String(error?.message || error)
}
