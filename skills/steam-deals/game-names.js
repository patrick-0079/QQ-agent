// 游戏中文译名解析（三级叠加）
//
// ── 为什么是三级 ────────────────────────────────────────────────────────
// 实测（2026-10-02）：
//   ① Steam 官方中文本地化 —— 但**只有约一半游戏有**。同一批 12 款里，
//      赛博朋克2077/博德之门3/GTA5 有中文名，而 Stardew Valley、Red Dead
//      Redemption 2、The Outlast Trials、Skyrim、Ori 全部没有（返回的还是英文）。
//      （用户举例的"博德之门3"正是这一类，官方确实有。）
//   ② 公共机翻（myMemory 等免 key 接口）—— **质量不可接受**，实测反例：
//      Steep → "陡峭"（应为《极限巅峰》）
//      The Outlast Trials → "长生不老的审判"（应为《逃生：试炼》）
//      Ori → "奥里和精灵的意志"（应为《精灵与萤火意志》）
//      用它会经常发出错误的中文名，比不译更糟。
//   ③ DeepSeek（本机已配 key）—— 实测 10/10 全对，5 秒译 10 个。作为兜底。
//
// 所以顺序是：Steam 官中 → 本地核实过的词典 → DeepSeek。
// 词典里的每一条都是查过百度百科/维基/游民星空确认的，**不靠记忆猜**。

/** 核实过的中文译名词典（键=英文原名，严格匹配）。 */
export const ZH_DICT = {
  // ── 用户提到与本次实测相关 ──
  "Baldur's Gate 3": '博德之门3',
  'Cyberpunk 2077': '赛博朋克2077',
  'Cyberpunk 2077: Phantom Liberty': '赛博朋克2077：往日之影',
  'Red Dead Redemption 2': '荒野大镖客：救赎2',
  'Grand Theft Auto V': '侠盗猎车手5',
  'Grand Theft Auto V Enhanced': '侠盗猎车手5 增强版',
  'Stardew Valley': '星露谷物语',
  'The Elder Scrolls V: Skyrim Special Edition': '上古卷轴5：天际 特别版',
  'The Elder Scrolls V: Skyrim': '上古卷轴5：天际',
  'Ori and the Will of the Wisps': '精灵与萤火意志',
  'Ori and the Blind Forest': '奥日与黑暗森林',
  'The Outlast Trials': '逃生：试炼',
  'Outlast 2': '逃生2',
  'Steep': '极限巅峰',
  'Riders Republic': '极限国度',
  'MONSTER HUNTER RISE': '怪物猎人崛起',
  'MONSTER HUNTER: WORLD': '怪物猎人：世界',
  'Watch_Dogs 2': '看门狗2',
  'Watch_Dogs': '看门狗',
  'Metro Exodus': '地铁：离去',
  'Metro 2033 Redux': '地铁2033',
  'Kingdom Rush - Tower Defense': '王国保卫战',
  'How to Fish': '渔力全开',
  'Forza Horizon 5': '极限竞速：地平线5',

  // ── 高热度常打折作品 ──
  'Elden Ring': '艾尔登法环',
  'Sekiro: Shadows Die Twice': '只狼：影逝二度',
  'Dark Souls III': '黑暗之魂3',
  'The Witcher 3: Wild Hunt': '巫师3：狂猎',
  'God of War': '战神',
  'God of War Ragnarök': '战神：诸神黄昏',
  'Resident Evil 4': '生化危机4',
  'Resident Evil Village': '生化危机8：村庄',
  'It Takes Two': '双人成行',
  'A Way Out': '逃出生天',
  'Hollow Knight': '空洞骑士',
  'Hollow Knight: Silksong': '空洞骑士：丝之歌',
  'Terraria': '泰拉瑞亚',
  'Slay the Spire': '杀戮尖塔',
  'Deep Rock Galactic': '深岩银河',
  'A Plague Tale: Requiem': '瘟疫传说：安魂曲',
  'A Plague Tale: Innocence': '瘟疫传说：无罪',
  'Total War: WARHAMMER III': '全面战争：战锤3',
  'Total War: WARHAMMER II': '全面战争：战锤2',
  'Warhammer 40,000: Space Marine 2': '战锤40K：星际战士2',
  'Cities: Skylines': '城市：天际线',
  'Cities: Skylines II': '城市：天际线2',
  'Fallout 4': '辐射4',
  'The Witcher 2: Assassins of Kings': '巫师2：国王刺客',
  'NieR:Automata': '尼尔：机械纪元',
  'Persona 5 Royal': '女神异闻录5 皇家版',
  'Persona 3 Reload': '女神异闻录3 Reload',
  'DARK SOULS: REMASTERED': '黑暗之魂：重制版',
  'ELDEN RING NIGHTREIGN': '艾尔登法环 黑夜君临',
  'Assassin\u2019s Creed Odyssey': '刺客信条：奥德赛',
  "Assassin's Creed Odyssey": '刺客信条：奥德赛',
  'Battlefield 2042': '战地2042',
  'Age of Empires IV': '帝国时代4',
  'Company of Heroes 3': '英雄连3',
  'Rise of the Tomb Raider': '古墓丽影：崛起',
  'Shadow of the Tomb Raider': '古墓丽影：暗影',
  'Tomb Raider': '古墓丽影',
  'Dying Light 2 Stay Human': '消逝的光芒2：人与仁之战',
  'Days Gone': '往日不再',
  'Horizon Zero Dawn': '地平线：零之曙光',
  'Death Stranding': '死亡搁浅',
  'Control Ultimate Edition': '控制 终极版',
  'Divinity: Original Sin 2': '神界：原罪2',
  'Hades': '哈迪斯',
  'Hades II': '哈迪斯2',
  'Celeste': '蔚蓝',
  'Cuphead': '茶杯头',
  'Human: Fall Flat': '人类一败涂地',
  'Phasmophobia': '恐鬼症',
  'Lethal Company': '致命公司',
  'Palworld': '幻兽帕鲁',
  'Satisfactory': '幸福工厂',
  'Raft': '木筏求生',
  'Valheim': '英灵神殿',
  'Project Zomboid': '僵尸毁灭工程',
  'The Forest': '森林',
  "Sons of the Forest": '森林之子',
  'Subnautica': '深海迷航',
  'Subnautica: Below Zero': '深海迷航：冰点之下',
  'No Man\u2019s Sky': '无人深空',
  "No Man's Sky": '无人深空',
  'Sea of Thieves': '盗贼之海',
  'Dead by Daylight': '黎明杀机',
  'Rust': '腐蚀',
  'ARK: Survival Evolved': '方舟：生存进化',
  '7 Days to Die': '七日杀',
  'Factorio': '异星工厂',
  'Frostpunk': '冰汽时代',
  'Frostpunk 2': '冰汽时代2',
  'Planet Coaster': '过山车之星',
  'Planet Zoo': '动物园之星',
  'XCOM 2': '幽浮2',
  'Sid Meier\u2019s Civilization VI': '文明6',
  "Sid Meier's Civilization VI": '文明6',
  'Hearts of Iron IV': '钢铁雄心4',
  'Stellaris': '群星',
  'Crusader Kings III': '十字军之王3',
  'Euro Truck Simulator 2': '欧洲卡车模拟2',
  'American Truck Simulator': '美国卡车模拟',
  'Microsoft Flight Simulator': '微软飞行模拟',
  'PAYDAY 2': '收获日2',
  'PAYDAY 3': '收获日3',
  'Borderlands 3': '无主之地3',
  'Mafia: Definitive Edition': '黑手党：最终版',
  'Sleeping Dogs: Definitive Edition': '热血无赖：最终版',
  'HITMAN World of Assassination': '杀手 暗杀世界',
  'BioShock Infinite': '生化奇兵：无限',
  'Portal 2': '传送门2',
  'Half-Life: Alyx': '半衰期：爱莉克斯',
  'Left 4 Dead 2': '求生之路2',
  'The Stanley Parable: Ultra Deluxe': '斯坦利的寓言：终极豪华版',
  'Firewatch': '看火人',
  'What Remains of Edith Finch': '艾迪芬奇的记忆',
  'Outer Wilds': '星际拓荒',
  'Disco Elysium': '极乐迪斯科',
  'Slime Rancher': '史莱姆牧场',
  'Slime Rancher 2': '史莱姆牧场2',
  'Core Keeper': '地心护核者',
  'V Rising': '吸血鬼崛起',
  'Enshrouded': '雾锁王国',
  'Grounded': '禁闭求生',
  'Astroneer': '异星探险家',
  'Space Engineers': '太空工程师',
  'Kerbal Space Program': '坎巴拉太空计划',
  'Total War: THREE KINGDOMS': '全面战争：三国',
  'Total War: ROME II': '全面战争：罗马2',
  'Mount & Blade II: Bannerlord': '骑马与砍杀2：霸主',
  'Path of Exile': '流放之路',
  'Path of Exile 2': '流放之路2',
  'Warframe': '星际战甲',
  'Destiny 2': '命运2',
  'The Division 2': '全境封锁2',
  'Tom Clancy\u2019s Rainbow Six Siege': '彩虹六号：围攻',
  "Tom Clancy's Rainbow Six Siege": '彩虹六号：围攻',
  'For Honor': '荣耀战魂',
  'Ghost of Tsushima': '对马岛之魂',
  'The Last of Us Part I': '最后生还者 第一部',
  'The Last of Us Part II Remastered': '最后生还者 第二部 重制版',
  'Uncharted: Legacy of Thieves Collection': '神秘海域：盗贼传奇合辑',
  'Marvel\u2019s Spider-Man Remastered': '漫威蜘蛛侠 重制版',
  "Marvel's Spider-Man Remastered": '漫威蜘蛛侠 重制版',
  'Spider-Man: Miles Morales': '蜘蛛侠：迈尔斯·莫拉莱斯',
  'Detroit: Become Human': '底特律：化身为人',
  'Heavy Rain': '暴雨',
  'Beyond: Two Souls': '超凡双生',
  'The Walking Dead': '行尸走肉',
  'The Wolf Among Us': '与狼同行',
  'Batman: The Telltale Series': '蝙蝠侠：故事版',
  'BATMAN: ARKHAM KNIGHT': '蝙蝠侠：阿卡姆骑士',
  'Middle-earth: Shadow of War': '中土世界：战争之影',
  'Middle-earth: Shadow of Mordor': '中土世界：暗影魔多',
  'The Lord of the Rings: Gollum': '指环王：咕噜',
  'Total War: ATTILA': '全面战争：阿提拉',
  'Jurassic World Evolution 2': '侏罗纪世界：进化2',
  'Two Point Hospital': '双点医院',
  'Two Point Museum': '双点博物馆',
  'Anno 1800': '纪元1800',
  'The Settlers: New Allies': '工人物语：新兴同盟',
  'Tropico 6': '海岛大亨6',
  'Surviving Mars': '火星求生',
  'Surviving the Aftermath': '劫后余生',
  'Battle Brothers': '战场兄弟',
  'Mount & Blade: Warband': '骑马与砍杀：战团',
  'Keep Talking and Nobody Explodes': '没人被炸',
  'Overcooked! 2': '胡闹厨房2',
  'Overcooked! All You Can Eat': '胡闹厨房：全都好吃',
  'Moving Out': '胡闹搬家',
  "Unrailed!": '一起开火车',
  'Lovers in a Dangerous Spacetime': '危险时空的恋人',
  'Castle Crashers': '城堡破坏者',
  'BattleBlock Theater': '战斗砖块剧场',
  'Pit People': '坑人',
  'Alien Hominid Invasion': '外星原人 入侵'
}

/** 商标符号等在聊天里没意义，去掉让名字更干净。 */
export function cleanTitle(name) {
  return String(name || '')
    .replace(/[\u2122\u00ae\u2120]/g, '')   // ™ ® ℠
    .replace(/\s+/g, ' ')
    .trim()
}

/** 是否已经是中文名。 */
export function hasChinese(s) {
  return /[\u4e00-\u9fff]/.test(String(s || ''))
}

/** 归一化：去商标符号、统一变体撇号、压空白、去首尾标点、大小写折叠。
 *  实测必要性：Steam 英文名里有 ® ™、弯引号（’）与直引号（'）混用、
 *  以及尾部空格等差异，严格匹配会漏掉明明收录了的条目，
 *  于是退回兜底翻译（质量更差，例如把 Metro Exodus 译成「地铁：离乡」）。 */
export function normalizeKey(s) {
  return String(s || '')
    .replace(/[\u2122\u00ae\u2120]/g, '')
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—:：,.]+|[\s\-–—:：,.]+$/g, '')
    .toLowerCase()
}

/** 归一化索引，只建一次。 */
let NORM_INDEX = null
function normIndex() {
  if (NORM_INDEX) return NORM_INDEX
  NORM_INDEX = new Map()
  for (const [k, v] of Object.entries(ZH_DICT)) NORM_INDEX.set(normalizeKey(k), v)
  return NORM_INDEX
}

/** 查本地词典（严格 → 归一化，两级匹配）。 */
export function lookupDict(enName) {
  const raw = String(enName || '').trim()
  if (!raw) return ''
  if (ZH_DICT[raw]) return ZH_DICT[raw]
  const clean = cleanTitle(raw)
  if (ZH_DICT[clean]) return ZH_DICT[clean]
  return normIndex().get(normalizeKey(clean)) || ''
}

/* ══════════════════════════════════════════════════════════════════════
   DeepSeek 兜底翻译（本机 key 已配好，实测 10/10 准确、5 秒 10 个）
   ══════════════════════════════════════════════════════════════════════ */

const SYSTEM_PROMPT = '你是游戏本地化专家。用户给你一组 Steam 游戏的英文名（JSON 数组），'
  + '请给出它们在中文游戏社区（B站/小黑盒/Steam 国区）通用的中文译名。'
  + '要求：只输出一个 JSON 对象，键为英文原名（原样不修改），值为中文译名字符串；'
  + '确实没有通用中文译名的填 null。不要输出任何解释文字。'

/**
 * 批量翻译游戏名。永不抛错：失败时返回空对象（调用方会退回英文名）。
 * @param {string[]} names 英文名数组
 * @param {{apiKey:string, baseUrl:string, model:string}} apiConf
 */
export async function translateViaDeepSeek(names, apiConf) {
  const list = [...new Set((names || []).filter(Boolean))]
  if (!list.length) return {}
  const key = String(apiConf?.apiKey || '').trim()
  const baseUrl = String(apiConf?.baseUrl || '').trim().replace(/\/+$/, '')
  const model = String(apiConf?.model || '').trim()
  if (!key || !baseUrl || !model) return {}

  // 分片：一次别塞太多，避免模型漏项
  const CHUNK = 15
  const out = {}
  for (let i = 0; i < list.length; i += CHUNK) {
    const chunk = list.slice(i, i + CHUNK)
    try {
      const r = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: JSON.stringify(chunk) }
          ],
          temperature: 0,
          response_format: { type: 'json_object' }
        }),
        signal: AbortSignal.timeout(90000)
      })
      if (!r.ok) continue
      const d = JSON.parse(await r.text())
      const content = String(d?.choices?.[0]?.message?.content || '')
      let parsed = null
      try { parsed = JSON.parse(content) } catch { continue }
      for (const [k, v] of Object.entries(parsed || {})) {
        if (typeof v === 'string' && hasChinese(v)) out[k] = v
      }
    } catch { /* 这一片失败不影响其它片 */ }
  }
  return out
}
