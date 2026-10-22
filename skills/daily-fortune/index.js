// 每日运势 —— Skill（QQ Agent 规范）
//
// 两个工具，分工明确：
//   daily-fortune__today  抽签：返回结构化结果（等级/分/宜忌/幸运项/配图标签）
//   daily-fortune__send   把**模型写好的文案** + 一张配图，合并成**一条消息**发出去
//
// ── 为什么要拆成两步 ─────────────────────────────────────────────────────
// 运势的措辞得是机器人自己的口吻（那才是这个人设的味道），所以文案必须由模型写；
// 但"文字 + 图"要落在**同一条气泡**里，就必须由同一次发送完成 —— 模型自己调
// send_message 发字、再让别处发图，必然是两条。于是：模型写、本技能发。
//
// ── 三条踩过的坑，别改 ──────────────────────────────────────────────────
//
// 1) **同一天同一个人，签必须固定**
//    「每日运势」问两次变一次就成笑话了。用 `日期|人名` 做种子的 FNV-1a +
//    mulberry32，纯函数、可复现、不落盘。rng() 的调用顺序也是结果的一部分：
//    幸运项即使不显示也照样抽，否则改个开关整支签会变样。
//
// 2) **配图标签必须是「单个词」**
//    实测（2026-09-30，lolicon 索引）：
//        女の子 / 制服 / かわいい / 笑顔 / 桜 / 猫 / 雨 …  → 全部有结果
//        「桜 女の子」「制服 かわいい」「散步 女の子」    → **一条都搜不到**
//    这个索引把整个 query 当**一个标签**匹配，带空格就必然落空。
//    所以词库里只放单词标签，imageQuery2 固定给最宽的「女の子」兜底。
//
// 3) **触发闸门：只在私聊或被点名时给**
//    宿主在工具 ctx 里给了 session.contextTier（见 src/prompt.js 的
//    resolveContextTier）：私聊 = tier 4「私聊消息」，被艾特 / 拍了拍我 = tier 1。
//    群里随机接话是 tier 2/3，这时拒绝并让模型别声张 —— 否则一接话就抽签，群里会烦。
//
// ── 配图复用谁 ─────────────────────────────────────────────────────────
//  不重复实现爬虫：直接调 pixiv-search 技能里的 py/cli.py（那是原作者的纯标准库工具，
//  它自己那份 index.js 也是这么调的）。本技能只做"取一个地址 → 下一个文件 → 交发送管道"。

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_ID = 'daily-fortune'
const HERE = path.dirname(fileURLToPath(import.meta.url))
// ── 本地修正：临时图**不能**放在技能目录里 ────────────────────────────────
// 核心的热重载是 `fs.watch(skills/, { recursive: true })`（src/plugin-loader.js），
// 技能目录里的**任何**写入都会触发一次全量重扫 —— 所有技能被重新加载一遍。
// 实测证据（data/logs）：`检测到变化：pixiv-search\.tmp，重新扫描…`。
// 配图是每次抽签都要写文件的，放在技能目录里等于"每抽一次签就热重载一次"。
// 所以落到系统临时目录（不在监听范围内）。
const TMP_DIR = path.join(os.tmpdir(), 'qqa-daily-fortune')
// 同理：pixiv.py 的搜索缓存也不能落在技能目录里（它默认写在 py/.cache/，
// 一样在监听范围内）。指向系统临时目录，见 py/pixiv.py 顶部那条本地修改。
const PIXIV_CACHE_DIR = path.join(os.tmpdir(), 'qqa-pixiv-cache')
const PIXIV_DIR = path.resolve(HERE, '..', 'pixiv-search')
const PIXIV_CLI = path.join(PIXIV_DIR, 'py', 'cli.py')
const KEEP_TMP = 12          // 临时图最多留几个，超出按时间删旧的
const PICK_FROM = 5          // 从搜索结果前几条里随机挑，避免同标签每天同一张

/* ══════════════════════════════════════════════════════════════════════
   一、签位表与词库
   ══════════════════════════════════════════════════════════════════════ */

// 权重合计 100。吉多凶少；小凶的箴言一律往「低调点反而顺」写，不吓人。
// keywords 全部是**实测能搜到的单个标签**（见文件头第 2 条）。
const LEVELS = [
  {
    key: 'daikichi', name: '大吉', stars: '★★★★★', score: [93, 99], weight: 8,
    mottos: [
      '想做的事今天推一把，会比平时顺很多。',
      '好运气适合分出去，别自己留着。',
      '今天你说的话别人容易听进去，重要的事挑今天说。',
      '该出手就出手，今天不是犹豫的日子。'
    ],
    keywords: ['桜', '青空', 'ひまわり', '花火']
  },
  {
    key: 'kichi', name: '吉', stars: '★★★★', score: [82, 92], weight: 20,
    mottos: [
      '按自己的节奏来就好，今天没人会为难你。',
      '顺手的事顺手做掉，今天回报来得快。',
      '遇到的人都还算好说话，别自己先紧张。',
      '今天适合把想说的话说清楚。'
    ],
    keywords: ['笑顔', 'ひまわり', '風', '空']
  },
  {
    key: 'chukichi', name: '中吉', stars: '★★★★', score: [72, 81], weight: 26,
    mottos: [
      '不大不小的顺，适合把拖着的小事清掉。',
      '今天不会有惊喜，但也不会出岔子，稳。',
      '想找的人大概能找到，想做的事大概能成。',
      '适合收拾一下手边乱七八糟的东西。'
    ],
    keywords: ['カフェ', '読書', '散歩', 'お茶']
  },
  {
    key: 'shokichi', name: '小吉', stars: '★★★', score: [62, 71], weight: 22,
    mottos: [
      '小确幸藏在细节里，留意一下。',
      '今天的好事都不大，但确实是好事。',
      '慢半拍也没关系，今天不用抢。',
      '留意一下别人随口说的话，那里面有好东西。'
    ],
    keywords: ['猫', 'お菓子', 'パジャマ', '日常']
  },
  {
    key: 'suekichi', name: '末吉', stars: '★★', score: [52, 61], weight: 14,
    mottos: [
      '慢一点没关系，今天不用抢。',
      '前半程一般，后半程会松快起来。',
      '今天适合守成，不适合开新坑。',
      '把期望放低一点，反而会有意外之喜。'
    ],
    keywords: ['のんびり', '縁側', '和服', 'お茶']
  },
  {
    key: 'hei', name: '平', stars: '★★', score: [45, 51], weight: 6,
    mottos: [
      '平平淡淡就是稳，别给自己加戏。',
      '今天没什么特别的，正好用来休息。',
      '不适合做决定，适合什么都不做。',
      '今天的事今天了，别往后拖。'
    ],
    keywords: ['部屋', '音楽', '窓辺', '本棚']
  },
  {
    key: 'kyo', name: '小凶', stars: '★', score: [35, 44], weight: 4,
    mottos: [
      '今天低调点，少做决定多观察，反而顺。',
      '容易在小事上卡住，深呼吸，别较劲。',
      '今天说的话容易被误解，重要的事明天再说。',
      '诸事不宜急，慢就是快。'
    ],
    keywords: ['雨', '傘', '夜', '雪']
  }
]

// 每个签位配一个开场 emoji。放在**工具返回的数据里**而不是只写进提示词 ——
// 模型改写时会把数据里的表情自然带过去，纯文字才不会太单调。
const LEVEL_EMOJI = {
  daikichi: '🎉', kichi: '🌟', chukichi: '✨',
  shokichi: '🍀', suekichi: '🌱', hei: '🌙', kyo: '🌧️'
}

// 配图兜底标签：最宽、实测必出结果。主标签搜不到时用它的。
const FALLBACK_TAG = '女の子'

const YI = [
  '摸鱼', '早睡', '喝奶茶', '和朋友聊天', '吃顿好的', '出门走走',
  '听歌', '整理桌面', '给群友点赞', '看番', '读点书', '运动一下',
  '晒晒太阳', '撸猫', '写点东西', '把拖很久的事做掉', '主动找人搭话',
  '学个新词', '拍张照', '夸夸别人', '多喝水', '发条空间说说',
  '换个路线回家', '给自己买点小东西'
]

const JI = [
  '熬夜', '拖延', '和人抬杠', '冲动消费', '吃太撑', '空腹喝咖啡',
  '刷手机到半夜', '借钱给别人', '做重大决定', '临时改需求', '当众立 flag',
  '把话说太满', '翻旧账', '凌晨三点发消息', '边吃饭边打游戏',
  '逞强搬重物', '忘记回消息', '出门不带伞', '跟客服较劲',
  '在群里发长语音', '大晚上喝浓茶', '同时开三个新坑'
]

const COLORS = [
  '樱花粉', '月光银', '靛蓝', '暖橙', '青竹绿', '奶油白',
  '丁香紫', '琥珀金', '雾霾蓝', '赤红', '薄荷绿', '深灰'
]

const DIRS = ['正东', '东南', '正南', '西南', '正西', '西北', '正北', '东北']

/* ══════════════════════════════════════════════════════════════════════
   二、确定性随机（见文件头第 1 条）
   ══════════════════════════════════════════════════════════════════════ */

function hash32(str) {
  let h = 2166136261 >>> 0
  const s = String(str)
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), 1 | t)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 从数组里不放回地抽 n 个（同一份结果里不出现重复项）。 */
function pickSome(rng, arr, n) {
  const pool = arr.slice()
  const out = []
  for (let i = 0; i < n && pool.length; i++) {
    out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0])
  }
  return out
}

function pickLevel(rng) {
  const total = LEVELS.reduce((s, l) => s + l.weight, 0)
  let r = rng() * total
  for (const l of LEVELS) {
    r -= l.weight
    if (r < 0) return l
  }
  return LEVELS[LEVELS.length - 1]
}

/* ══════════════════════════════════════════════════════════════════════
   三、日期与人名
   ══════════════════════════════════════════════════════════════════════ */

/** 本地日期（不能用 toISOString —— 那是 UTC，晚上 8 点后会串到第二天）。 */
function dayInfo(offsetDays) {
  const d = new Date()
  d.setDate(d.getDate() + (Number(offsetDays) || 0))
  const p = (n) => String(n).padStart(2, '0')
  const label = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  return { key: label, label, week: '周' + '日一二三四五六'[d.getDay()] }
}

/** 昵称清洗：去控制字符、压空白、限长 —— 它会被写进回复，别让换行撑破排版。 */
function cleanWho(v) {
  return String(v ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24)
}

/* ══════════════════════════════════════════════════════════════════════
   四、抽签
   ══════════════════════════════════════════════════════════════════════ */

/** rng() 顺序即结果：每项照抽不误，显示与否只影响渲染。 */
function buildFortune({ who, offsetDays, showLucky, imageEnabled }) {
  const day = dayInfo(offsetDays)
  const rng = mulberry32(hash32(`${day.key}|${who || 'self'}|fortune-v1`))

  const level = pickLevel(rng)
  const score = level.score[0] + Math.floor(rng() * (level.score[1] - level.score[0] + 1))
  const good = pickSome(rng, YI, 3)
  const bad = pickSome(rng, JI, 2)
  const color = pickSome(rng, COLORS, 1)[0]
  const num = Math.floor(rng() * 10)
  const dir = pickSome(rng, DIRS, 1)[0]
  const motto = pickSome(rng, level.mottos, 1)[0]
  const kws = pickSome(rng, level.keywords, 2)

  const when = offsetDays ? '明日' : '今日'
  const lines = [
    `🔮【${when}运势】${day.label} ${day.week} · 为「${who || '你'}」抽的签`,
    `${LEVEL_EMOJI[level.key] || '✨'} 签位：${level.name} ${level.stars} · 综合 ${score} 分`,
    `✅ 宜：${good.join('、')}`,
    `🚫 忌：${bad.join('、')}`
  ]
  if (showLucky) lines.push(`🍀 幸运色：${color} · 🔢 幸运数字：${num} · 🧭 幸运方位：${dir}`)
  lines.push(`💫 一句话：${motto}`)

  if (imageEnabled) {
    lines.push('')
    lines.push(`配图标签（主）：${kws[0]}`)
    lines.push(`配图标签（备）：${FALLBACK_TAG}`)
    lines.push(`imageQuery: ${kws[0]}`)
    lines.push(`imageQuery2: ${FALLBACK_TAG}`)
  }

  return { day, level, score, good, bad, color, num, dir, motto, kws, text: lines.join('\n') }
}

/* ══════════════════════════════════════════════════════════════════════
   五、触发闸门（见文件头第 3 条）
   ══════════════════════════════════════════════════════════════════════ */

function gate(ctx, cfg) {
  if (ctx?.kind === 'private') return ''
  if (cfg?.mentionOnly === false) return ''

  const tier = Number(ctx?.session?.contextTier)
  const reason = String(ctx?.session?.contextReason || '')
  if (tier === 1) return ''
  // 宿主没给档位信息（换了实现）：不硬拦，交给提示词约束 ——
  // 宁可极端情况下偶尔多说一句，也不要让整个功能静默失效。
  if (!Number.isFinite(tier)) return ''

  return `这次在群里没被点名（档位 ${tier}${reason ? '：' + reason : ''}，不是被 @ 也不是拍一拍），运势只在被点名或私聊时给。`
    + '把这条当作没发生：不要跟群里解释、不要提运势这回事，正常聊别的就行。'
}

/* ══════════════════════════════════════════════════════════════════════
   六、配图：调 pixiv-search 的 cli.py（复用，不重写爬虫）
   ══════════════════════════════════════════════════════════════════════ */

/** 找 Python：本技能 .venv → 隔壁 pixiv-search 的 .venv → 隔壁 jmcomic 的 .venv。 */
function resolvePython() {
  const override = String(cfgOf().python || '').trim()
  if (override) return override
  const cands = [
    path.join(HERE, '.venv', 'Scripts', 'python.exe'),
    path.join(HERE, '.venv', 'bin', 'python3'),
    path.join(PIXIV_DIR, '.venv', 'Scripts', 'python.exe'),
    path.join(PIXIV_DIR, '.venv', 'bin', 'python3'),
    path.resolve(HERE, '..', 'jmcomic', '.venv', 'Scripts', 'python.exe'),
    path.resolve(HERE, '..', 'jmcomic', '.venv', 'bin', 'python3')
  ]
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c } catch { /* 继续试 */ }
  }
  return ''   // 交给 spawn 用 PATH 里的 python 赌一把
}

/** 跑一次 cli.py。永不抛，统一返回 { ok, data?, error? }。 */
function runCli(args, timeoutMs) {
  return new Promise((resolve) => {
    let child
    try {
      // ── 本地修正：必须显式把 Python 的 stdout 钉成 UTF-8 ──────────────────
      // 这个 CLI 输出的是日文标题/标签。应用进程里**没有** PYTHONIOENCODING，
      // Python 就按系统码页（中文 Windows 是 GBK）编码 stdout，碰到编不出来的
      // 字符直接 UnicodeEncodeError 崩掉 → 没有 JSON → 配图失败。
      // 症状极具迷惑性：在终端里手测是好的（shell 恰好设了这个变量），
      // 只有从应用里跑才必坏。pixiv-search 那份跑通的实现就是这么设的，
      // 连同 setEncoding('utf8') 一起照抄过来。
      child = spawn(resolvePython() || 'python', [PIXIV_CLI, ...args], {
        cwd: PIXIV_DIR,
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
          PIXIV_CACHE_DIR
        }
      })
    } catch (e) {
      return resolve({ ok: false, error: `启动 Python 失败：${String(e?.message ?? e).slice(0, 110)}` })
    }
    let out = ''
    let err = ''
    let settled = false
    let timer = null
    const done = (v) => { if (!settled) { settled = true; if (timer) clearTimeout(timer); resolve(v) } }
    timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      done({ ok: false, error: '调用超时' })
    }, Math.max(5000, Number(timeoutMs) || 30000))

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (d) => { out += d })
    child.stderr?.on('data', (d) => { err += d })
    child.on('error', (e) => done({
      ok: false,
      error: e?.code === 'ENOENT' ? '机器上找不到 python' : String(e?.message ?? e).slice(0, 110)
    }))
    child.on('close', (code) => {
      const text = String(out).trim()
      const m = text.match(/\{[\s\S]*\}/)          // 前面可能有机器的杂音，取第一个大括号块
      if (!m) {
        // 把 stderr 尾巴带上 —— 不然只剩一句"没输出"，排障时无从下手
        const tail = String(err || '').trim().split('\n').slice(-2).join(' ').slice(0, 160)
        return done({ ok: false, error: `搜索没有返回可解析的结果（退出码 ${code}）${tail ? '：' + tail : ''}` })
      }
      try { done({ ok: true, data: JSON.parse(m[0]) }) } catch { done({ ok: false, error: '返回不是合法 JSON' }) }
    })
  })
}

/** 清掉多余的临时图（按时间从旧到新删）。 */
function pruneTmp() {
  try {
    const files = fs.readdirSync(TMP_DIR)
      .map((n) => path.join(TMP_DIR, n))
      .filter((p) => { try { return fs.statSync(p).isFile() } catch { return false } })
      .map((p) => ({ p, t: (() => { try { return fs.statSync(p).mtimeMs } catch { return 0 } })() }))
      .sort((a, b) => a.t - b.t)
    while (files.length > KEEP_TMP) {
      const f = files.shift()
      try { fs.unlinkSync(f.p) } catch { /* ignore */ }
    }
  } catch { /* 目录不存在就算了 */ }
}

/**
 * 拿一张图的本地文件。返回 { path, tag, bytes } 或 { error }。
 * 标签必须是单词（文件头第 2 条）；主标签不行就用最宽的兜底标签，再不行才放弃。
 */
async function fetchOneImage(tag, timeoutMs) {
  const tags = [String(tag || '').trim(), FALLBACK_TAG].filter(Boolean)
  const tried = []
  for (const t of tags) {
    // 带空格的标签在这个索引上必然 0 结果，直接跳过、换兜底。
    if (/\s/.test(t)) { tried.push(`「${t}」含空格（索引只认单个标签），跳过`); continue }
    const r = await runCli(['search', '--query', t, '--limit', String(PICK_FROM * 2), '--mode', 'safe'], timeoutMs)
    if (!r.ok) { tried.push(`${t}: ${r.error}`); continue }

    const items = (Array.isArray(r.data?.results) ? r.data.results : []).filter((it) => it && it.r18 !== true)
    if (!items.length) { tried.push(`${t}: 没有结果`); continue }

    // 前几条里随机挑，免得同一档签老是同一张图
    const pool = items.slice(0, PICK_FROM)
    const start = Math.floor(Math.random() * pool.length)
    for (let i = 0; i < pool.length; i++) {
      const item = pool[(start + i) % pool.length]
      const url = String(item?.images?.[0]?.regular || item?.images?.[0]?.original || '')
      if (!/^https?:\/\//i.test(url)) continue
      try {
        fs.mkdirSync(TMP_DIR, { recursive: true })
        const out = path.join(TMP_DIR, `${Date.now()}_${String(item?.id || 'x').replace(/[^\w-]/g, '')}.jpg`)
        const d = await runCli(['download', '--url', url, '--out', out], timeoutMs)
        if (!d.ok) { tried.push(`${t}: 下载失败 ${d.error}`); continue }
        const size = (() => { try { return fs.statSync(out).size } catch { return 0 } })()
        if (!size) { try { fs.unlinkSync(out) } catch { /* ignore */ } tried.push(`${t}: 下回来是空的`); continue }
        pruneTmp()
        return { path: out, tag: t, bytes: size, title: String(item?.title || ''), artist: String(item?.artist?.name || '') }
      } catch (e) {
        tried.push(`${t}: ${String(e?.message ?? e).slice(0, 60)}`)
      }
    }
    tried.push(`${t}: 这几条都取不到图`)
  }
  return { error: tried.join('；') || '没拿到图' }
}

/* ══════════════════════════════════════════════════════════════════════
   七、技能契约
   ══════════════════════════════════════════════════════════════════════ */

let cfgOf = () => ({})
let log = () => {}

export function setup(api) {
  cfgOf = () => (api.config && typeof api.config === 'function' ? (api.config() || {}) : {})
  log = (...a) => { try { api.log(...a) } catch { /* 日志失败不影响主流程 */ } }

  // ── 工具一：抽签（只给数据，不发消息）────────────────────────────────
  api.registerTool({
    id: 'today',
    // ⚠️ 上游 registerTool **强制要求 name**（src/tool-registry.js 会抛
    //    「工具 X 必须提供 name」），少了它整个 setup 中断、工具一个都注册不上。
    name: '抽今日运势',
    description: '给指定的人抽今天（或明天）的运势：签位等级、综合分、宜、忌、幸运色/数字/方位、一句话，'
      + '并附一个合气氛的配图标签。**本工具不发消息** —— 拿到结果后用你自己的口吻改写成一条消息，'
      + '再调 daily-fortune__send 把它连同配图一起发出去（那样才是同一条气泡）。'
      + '同一天同名结果固定；只在私聊或被 @ / 拍了拍时可用。',
    // ⚠️ 分类必须是本机**开着**的那一类。分类开关（config.tools.categories）会把整类工具
    //    从模型的工具列表里摘掉，但提示词片段照旧注入 —— 于是模型读着提示词去调一个
    //    没给它的工具，报「未知工具 xxx」。这台机器 utility 是关的、fun 是开的。
    category: 'query',
    icon: '🔮',
    parameters: {
      type: 'object',
      properties: {
        who: { type: 'string', description: '给谁抽，填对方昵称（群里问就填问的人）。不填则给自己抽。' },
        day: { type: 'string', enum: ['today', 'tomorrow'], description: '抽哪一天，默认 today；只有对方明说要看明天才填 tomorrow。' }
      }
    },
    async execute(ctx, args) {
      const cfg = cfgOf()
      const deny = gate(ctx, cfg)
      if (deny) {
        log(`[${SKILL_ID}] 拒绝一次未点名的调用（档位 ${ctx?.session?.contextTier ?? '?'}）`)
        return { content: deny, isError: true }
      }

      const who = cleanWho(args?.who) || cleanWho(ctx?.botName || ctx?.selfNickname) || '你'
      const offsetDays = String(args?.day || 'today').toLowerCase() === 'tomorrow' ? 1 : 0
      const f = buildFortune({
        who,
        offsetDays,
        showLucky: cfg.showLucky !== false,
        imageEnabled: cfg.imageEnabled !== false
      })

      log(`[${SKILL_ID}] ${f.day.label} ${who} → ${f.level.name} ${f.score} 分`)
      return { content: f.text }
    }
  })

  // ── 工具二：合并发送（文字 + 一张图 = 一条消息）──────────────────────
  api.registerTool({
    id: 'send',
    name: '发送运势（文字配图合并成一条）',
    description: '把**你写好的运势文案**和一张配图合并成**同一条消息**发到当前会话。'
      + 'text 填你已经改写成自己口吻的那段话（不要照抄工具的原始表格）；query 填 daily-fortune__today '
      + '返回的 imageQuery（单个日文标签）。配图失败时会只发文字，仍然是**一条**，不会拆成多条。',
    category: 'query',
    icon: '📮',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要发出去的完整文案（你自己的口吻，已经是最终稿）。' },
        query: { type: 'string', description: '配图标签，填 daily-fortune__today 给的 imageQuery。留空则只发文字。' }
      },
      required: ['text']
    },
    async execute(ctx, args) {
      const cfg = cfgOf()
      const deny = gate(ctx, cfg)
      if (deny) return { content: deny, isError: true }

      const text = String(args?.text ?? '').replace(/\r/g, '').trim().slice(0, 1200)
      if (!text) return { content: '要发送的文案是空的。', isError: true }

      const sender = ctx?.sender
      const chatKey = String(ctx?.chatKey || '')
      if (!sender || !chatKey) return { content: '拿不到发送通道（ctx.sender / chatKey），这条没发出去。', isError: true }

      // ① 先试着配一张图（失败不影响发文字）
      let img = null
      let imgErr = ''
      if (cfg.imageEnabled !== false && String(args?.query || '').trim()) {
        const r = await fetchOneImage(args.query, Number(cfg.imageTimeoutMs) || 30000)
        if (r?.path) img = r
        else {
          imgErr = String(r?.error || '没拿到图').slice(0, 200)
          log(`[${SKILL_ID}] 配图没拿到：${imgErr}`)
        }
      }

      // ② 合并发送：同一批 segments = 同一条消息里的两个段
      try {
        if (img && typeof sender.sendMedia === 'function') {
          await sender.sendMedia(chatKey, [
            { type: 'text', data: { text } },
            { type: 'image', data: { file: img.path } }
          ], { label: '每日运势（图文）' })
          log(`[${SKILL_ID}] 已发送（图文一条，标签 ${img.tag}）`)
          return { content: `已发送：一条消息，含文字与 1 张配图（标签「${img.tag}」）。不要再用 send_message 复述运势内容。` }
        }

        // 没图 / 发送通道不支持媒体段：退化成纯文字，**仍然是一条**
        if (typeof sender.sendTextBatch === 'function') {
          await sender.sendTextBatch(chatKey, [text], {})
        } else {
          return { content: '发送通道不支持发送，这条没发出去。', isError: true }
        }
        log(`[${SKILL_ID}] 已发送（仅文字${img ? '' : '，配图未取到'}）`)
        return {
          // 失败原因**写进返回值**（不只是日志）：本机的日志不落文件，
          // 只记日志的话出了事完全看不到原因。写在这里，用户截图就能带出来。
          content: `已发送：一条纯文字消息。不要再用 send_message 复述运势内容。`
            + (imgErr ? `\n（配图这次没拿到，原因：${imgErr}。别再为它重试或解释，就当没有图。）` : '')
        }
      } catch (e) {
        const msg = String(e?.message ?? e).slice(0, 150)
        log(`[${SKILL_ID}] 发送失败：${msg}`)
        return { content: `发送失败：${msg}`, isError: true }
      }
    }
  })

  log(`[${SKILL_ID}] 每日运势已就绪（工具：${SKILL_ID}__today / ${SKILL_ID}__send）`)
}

export function available() {
  return true
}

export function dispose() {
  cfgOf = () => ({})
  log = () => {}
}

// 便于自检直接打纯函数（不打网络、不碰宿主）
export const internals = {
  buildFortune,
  gate,
  dayInfo,
  cleanWho,
  hash32,
  mulberry32,
  resolvePython,
  fetchOneImage,
  LEVELS,
  YI,
  JI,
  FALLBACK_TAG
}
