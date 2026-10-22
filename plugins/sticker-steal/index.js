// 更好的表情包收集和发送（sticker-steal）—— 自动收集 + 自动打标签 + 按上下文挑一张发出去。
//
// ══════════════════════════════════════════════════════════════════════════
// 一、为什么是**插件**（plugins/，确定性型）
// ══════════════════════════════════════════════════════════════════════════
// 按 doc/extend_development/skill-development.md §0 的三问判断法：
//
//   第一问「触发时机能用 if 描述吗？」
//     if (这条消息里有图片/表情 && 库里还没有这张)  → ✅ 能，死条件
//     if (同一张表情的字节哈希已经在库里)            → ✅ 能，死条件
//   第二问「漏触发一次的代价是什么？」
//     漏一次 = 这张表情包永远进不了库 —— 这正是"自动收集"这个功能本身。
//     不是"少个花活"，而是功能的存在意义。→ 必须每次都跑
//   第三问「参数从哪来？」
//     参数全是系统给的：会话、消息、媒体 url/file、图片字节。→ 插件
//
//   三问一致 → 插件（plugins/）。所以它用 hooks 做**确定性收集**，
//   同时 registerTool 给模型**决定权**的那两件事（挑哪张、要不要贫一句）。
//
// ⚠️ 这里有一条文档没说尽、必须自己守的边界：
//   `skill-reference.md` §9.4 与 `plugin-development.md` §3.2 都写明钩子里
//   **不能发请求、不能发消息、不能调模型**（单钩子 5 秒超时，超时直接跳过）。
//   而"理解表情包上的字、判断它适合什么场合"本质上需要模型看图 ——
//   所以**绝不在钩子里调模型**。分工是：
//     钩子  只做机械动作：去重、下载、落盘、建索引（纯 if/哈希，不需要理解）
//     工具  需要理解的部分：看图打标签、按情绪挑图、按概率贫一句
//   这也是文档 §1.7「要满足条件一定发生 → 钩子；要让模型判断 → 工具」的直译。
//
// ══════════════════════════════════════════════════════════════════════════
// 二、与项目里既有能力的分工（避免重复造轮子）
// ══════════════════════════════════════════════════════════════════════════
//   · `plugins/sticker-memory`（已装，默认开）管的是"**看过的图别再看第二遍**"：
//     它把图片含义内联进上下文、拦下重复识图，省 token。它**不存图片字节**。
//   · 本插件管的是"**把表情包收成自己的库，并在合适的时候发出去**"。
//     两者是上下游：sticker-memory 让模型"认识"这张图，本插件把它"收进柜子"。
//   · 去重只认**图片字节的 sha1**（不是 url）：QQ 每次下发的图片直链常带会过期的
//     rkey，靠 url 认图必然重复收录同一张。所以入库前一定要拿到字节算哈希。
//   · 核心自带的 collect_sticker / send_sticker 走的是 **QQ 收藏表情**，
//     本插件刻意**不走那条路**（用户选择：偷来的表情只存本机，不动 QQ 收藏）。
//
// ══════════════════════════════════════════════════════════════════════════
// 四、动图（GIF）为什么要自己解码
// ══════════════════════════════════════════════════════════════════════════
//   本项目处理 GIF 的正规管道是 `src/gif-to-video.js`（GIF → ≤24 帧 mp4 → 按视频
//   部件发给模型），但它整条链依赖 **ffmpeg**。本机实测 `spawn('ffmpeg')` 与
//   `spawn('ffmpeg.exe')` 都是 ENOENT —— 所以那条路在这里**一直是失效的**：
//   GIF 只会以静态图片形态送进模型，看到的永远是第一帧。而表情包的信息量恰恰
//   在后续帧里（动作、表情变化、后几帧才出现的文字）。
//
//   做法：本插件自带一个**纯 JS 的 GIF 解码器**（LZW 解压自己写、PNG 用 Node 内置
//   zlib 编码，零原生依赖），把动图抽成最多 6 张连续画面，按 image_url 部件一起
//   交给模型 —— 对**任何**视觉模型都成立，不依赖 video_url 支持。
//
//   三个闸门保证畸形/炸弹 GIF 不会拖垮对话：块扫描步数上限、LZW 输出上限、
//   画布像素上限（见 GIF 解码器那一节）。任何一条触发都只是"这次看不了动图"。
//
// ══════════════════════════════════════════════════════════════════════════
// 六、为什么要把"与别的表情系统的边界"写进提示词
// ══════════════════════════════════════════════════════════════════════════
//   上线后用户反馈"实际不怎么配图"。查 `data/sessions/*.json`（会话存档里有完整
//   提示词与模型的 reasoning_content）发现根因**既不是频率也不是闸门**：
//   · freqBlocked = 0 —— 频率闸门一次都没拦过，说明模型连"想发"都没想过；
//   · 10 个会话里 pick_sticker 只被调用 1 次、send_sticker_steal 0 次；
//   · 而模型的思考原文写着："表情包库里说『暂时没有可用的』……一个技能说表情包库
//     没配好，另一个说 QQ 收藏有 3 个。混乱。""算了，为降风险，只发文字，不配图。"
//
//   也就是说：另一套表情技能（sticker-vault 提示"图片库文件夹没配置"）的告警
//   让模型以为**整个机器人没有表情可用**，于是主动放弃了配图。
//   教训：同一个机器人里存在多套相似功能时，"各系统边界"必须显式告诉模型，
//   否则它会用 A 的状态去否决 B 的能力 —— 而这种错在代码里完全看不出来。
//
//   附带教训：这类"模型行为层"的问题**只能从会话存档里看**，光看自己的日志
//   （加载成功、自检通过）永远发现不了。
//
// ══════════════════════════════════════════════════════════════════════════
// 七、边界与安全（全部 try/catch，出问题只会"没生效"，绝不打断对话）
// ══════════════════════════════════════════════════════════════════════════
//   · 只读 `data/` 下自己的目录，只写 `data/sticker-steal/`。
//   · 下载只走核心 `safeFetchBinary`（与全项目同一套 SSRF 口径）；拿不到核心
//     时才退回自带护栏（只放行公网 http(s)、限体积、超时、只收图片）。
//   · 发表情一律走 `ctx.sender.sendImage`（串行/限频/去重/留档全在里面），
//     不直接碰 `onebot.send*`。
//   · 改标签 / 删表情有权限判断（群主、群管理员、机器人主人、配置里额外授权的 QQ）。
//   · 不写任何密钥：全部数据就是 `data/sticker-steal/` 下的图片和一个 index.json。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DATA_DIR } from '../../src/config.js';

// 直接引用核心的 LLM 调用与配置：这样本插件能**自己**看图打标签（一键整理、收录时识图），
// 不必依赖模型主动去调工具 —— 那是"能不能自动"的关键差别。
import { chatCompletion } from '../../src/llm.js';
import { getConfig } from '../../src/config.js';

/** 延迟到 activate 时再 import（加载期不碰子进程模块）。 */
let safeFetchBinary = null;   // 延迟到 activate 时再 import，加载期不碰网络模块
let nodeSpawn = null;         // 延迟到 activate 时再 import（打开文件管理器用）

const PLUGIN_ID = 'sticker-steal';
const DIR = path.join(DATA_DIR, PLUGIN_ID);
const IMG_DIR = path.join(DIR, 'images');
// 插件自己的所在目录（`resources/app/plugins/sticker-steal`）→ 上两级是 app 根。
// 用于扫描"还有哪些相似的表情包插件"（见 isSimilarStickerSkill）。
const APP_DIR = path.resolve(import.meta.dirname, '..', '..');
const INDEX_FILE = path.join(DIR, 'index.json');

const FLUSH_DEBOUNCE_MS = 2000;
const QUEUE_INTERVAL_MS = 500;
const HARD_MAX_ITEM_BYTES = 12 * 1024 * 1024;
const MAX_TEXT_CHARS = 160;
const MAX_NOTE_CHARS = 200;
const MAX_TAG_CHARS = 12;
const MAX_TAGS = 8;
const MAX_SOURCES = 6;
/**
 * "聊天时顺带收"每轮最多收几张；以及「往回翻聊天记录找表情」不指定数量时的默认值。
 * 曾经它们是同一个用户设置（每次最多偷几张），但那个设置已被移除（用户要求精简界面）。
 * 提成显式常量是为了避免"删一个开关、三个功能的默认值跟着乱"这种连锁问题。
 */
const DEFAULT_COLLECT_PER_RUN = 3;
const DEFAULT_SCAN_LIMIT = 5;
/**
 * 「一键整理 / 翻记录补标签」的行为常量。
 *
 * 曾经这四个是用户设置（每批看几张、认不出怎么办、认不出几次才删、每轮补几张），
 * 用户要求精简界面后**固定为常量**。仍然是常量而不是散落的字面量，原因：
 *   · 改一处就能调整全部行为，不会"这里改了那里忘了"；
 *   · 需要时改回用户设置只要动这几行。
 */
const DEFAULT_ORGANIZE_BATCH = 4;        // 一次请求发给模型几张图
const DAY_MS = 86400000;                 // 一天（itemScore 的新鲜度/耗尽衰减都用它）
const DEFAULT_TAG_FAIL_ATTEMPTS = 2;     // 认不出来累计几次算"确认无意义"
const DEFAULT_TAG_FAIL_ACTION = 'delete'; // 达到次数后：delete 删掉 / keep 只记账
const DEFAULT_AUTO_TAG_BUDGET = 8;       // 自动补标签每轮最多看几张 / 整理默认张数

/** 与 plugin.json 的 settings 保持一致（留一份是为了加载顺序与容错）。 */
const DEFAULTS = {
  enabled: true,
  // 注：这里**不再有** maxCollectPerRun —— 那个用户设置已移除，逻辑统一用常量
  //     DEFAULT_COLLECT_PER_RUN / DEFAULT_SCAN_LIMIT（见上方注释）。
  collectWindowMin: 30,
  stickerOnly: true,
  maxLibrarySize: 800,
  maxLibraryMb: 96,
  maxItemMb: 6,
  sendMinIntervalSec: 30,
  sendDailyLimit: 40,
  sendGlobalIntervalSec: 15,
  stealQuipChance: 35,
  adminOnly: true,
  adminIds: '',
  showTextInContext: true,
  keepRecentCount: 5,
  gifFramesWant: 2,
  stickerFrequency: 'occasional',
  autoTagAfterScan: true,
  collectEveryHours: 12,
  collectTopHours: 24,
  collectTopCount: 10,
  deleteOldestCount: 25,
  deleteOldestKeep: 10,
  // ── 屏蔽"其它表情系统"的总开关（用户要求把两个开关合并成一个）──
  //
  // 一个开关同时管两件事（见下方 providers['tool.guard']）：
  //   ① QQ Agent **原有的收藏表情工具**（send_sticker / list_stickers / collect_sticker …）
  //   ② **其它"与表情包相似"的插件/技能**的工具（sticker-vault / whale-memes / trendy-memes …）
  //
  // 为什么合并：这两件事目的完全一样 —— "发表情只走本插件的库"。
  // 拆成两个开关只会让人不知道该开哪个（这也是用户的直接反馈）。
  //
  // ⚠️ 这个键必须同时出现在 DEFAULTS 和 conf() 的返回对象里 ——
  //    漏掉 conf() 那一步会让守卫永远读到 undefined（这个坑在本文件踩过三次）。
  blockOtherSticker: true,
  // 收录时立刻识图（用户要求 B 方案）：新收的图马上让模型看一遍，
  // 把「图上的文字 + 适合什么场合」记下来。代价是每张新图一次视觉调用。
  recognizeOnIngest: true,
  recognizeIngestBudget: 20,     // 每天最多这样识图多少张（防失控烧 token）
  // 下面两个设置项已按用户要求**停用**（保留键位只为兼容老配置，代码里不再读取）：
  //   sendChanceOnPlain —— 原"值不值得发"的 45% 概率闸门（硬性拦截，已撤）
  //   stickerEveryNthReply —— 原"每 N 条文字强制配图"（硬性强制，已撤）
  // 用户要的是**纯软性**：靠奖励评分排序引导，不靠概率拦人。详见 sendGate 的注释。
  sendChanceOnPlain: 1,
  stickerEveryNthReply: 0
};

/** 固定情绪词表（闭合集合）。理由同 sticker-vault：自由发挥会立刻碎片化。 */
const MOODS = [
  '开心', '无奈', '生气', '难过', '害羞', '惊讶', '嘲讽',
  '赞同', '拒绝', '打招呼', '关心', '沙雕',
  '发呆', '困', '偷看', '紧张', '插画', '其他'
];

/**
 * 「聊天配图」的四档频率 —— 这是本插件唯一一处频率来源。
 *
 * 与核心的关系（重要，避免左右脑互搏）：
 *   `src/stickers.js` 的 buildStickerStrategyHint 管的是**QQ 收藏表情**的频率引导，
 *   档位是 config.sticker.encourage 的 0~3（不鼓励/偶尔/较积极/表情包爱好者）。
 *   本插件管的是**偷来的本地库**，所以自己带一套闸门；语义刻意与核心对齐
 *   （"偶尔"= 大约每 3~5 轮来一张），用户看到的档位含义在全项目里是一致的。
 *
 * 为什么要有概率闸门而不是只靠间隔：只靠间隔的话，"很少"会表现成
 * "攒够时间就必发一张"，节奏仍然很机械。加一道概率才是真人的感觉。
 */
const FREQ_LEVELS = {
  rare: {
    label: '很少',
    // 用户定义："很少每天 15" —— 每群每天最多 15 张。
    // 同群间隔 60 分钟：15 张摊在一天里约 96 分钟一张；不设间隔的话它可能一口气把额度发完。
    prompt: '表情包是备选项，不勉强；纯文字回应完全没问题。',
    perChatDaily: 15, minIntervalMin: 60, perMinute: 0, chance: 0.35
  },
  occasional: {
    label: '偶尔',
    // 用户定义："偶尔每天可以 30 张" —— 每群每天最多 30 张。
    // 同群间隔 20 分钟：30 张摊在一天里约 48 分钟一张，保留间隔避免连续刷屏。
    prompt: '频率：普通闲聊不用每次都配图；大约每 2~3 轮配一张就够，热闹/玩梗时可以更密一些，但不要连续刷屏。',
    perChatDaily: 30, minIntervalMin: 20, perMinute: 0, chance: 0.6
  },
  normal: {
    label: '一般',
    // 用户定义："normal 每分钟最多两张" —— 这是这个档位的**硬上限**
    prompt: '频率：回应、吐槽、接梗时优先考虑配一张贴切的图，让对话更有活人感；但**每分钟最多两张**，别连着刷。',
    perChatDaily: 0, minIntervalMin: 0, perMinute: 2, chance: 0.85
  },
  often: {
    label: '经常',
    // 用户定义："often 就是无限制" —— 不限每群每日、不限间隔、不限每分钟、不掷概率骰子。
    // 也就是说这个档位**插件侧不做任何频率限制**（全靠软排序轮换 + 提示词自觉）。
    prompt: '频率：你是表情包爱好者——能配图的地方尽量配，接梗/调侃/附和时几乎都会带一张。**不要连续发同一张**（换着用），但不用刻意克制数量。',
    perChatDaily: 0, minIntervalMin: 0, perMinute: 0, chance: 1
  }
};

function levelOf(name) {
  return FREQ_LEVELS[String(name || '')] || FREQ_LEVELS.occasional;
}

// ─────────────────────────────────────────────── 活跃度（决定"发得多不多、集不集中"）
//
// 用户要求："让他按照活跃度来，活跃度越高发的表情越集中"。
//
// 含义：把档位的额度与间隔**按当前聊天有多热闹**做缩放 ——
//   · 冷清时：额度收紧、间隔拉长（别在没人说话时自言自语地发图）
//   · 热闹时：额度放宽、间隔缩短（趁大家正在聊，集中配几张）
// 这正是真人的做法：话题正热时表情满天飞，冷场时谁还发表情。
//
// 判定完全用本地聊天记录（不花 token）：数最近 ACTIVITY_WINDOW_MIN 分钟内
// **别人**说了多少条。等级越高 → 额度倍率越大、间隔倍率越小。

const ACTIVITY_WINDOW_MIN = 30;
/** 活跃度分档：[阈值(条/30分钟), key, 名称, 额度倍率, 间隔倍率] */
const ACTIVITY_LEVELS = [
  { min: 0, key: 'quiet', label: '冷清', budget: 0.5, interval: 2.0 },
  { min: 4, key: 'low', label: '一般', budget: 0.8, interval: 1.2 },
  { min: 12, key: 'mid', label: '较活跃', budget: 1.0, interval: 1.0 },
  { min: 30, key: 'high', label: '很活跃', budget: 1.5, interval: 0.6 },
  { min: 70, key: 'hot', label: '爆聊', budget: 2.0, interval: 0.35 }
];

/**
 * 算这个会话当前的活跃度。
 * @returns {{key:string,label:string,budget:number,interval:number,count:number}}
 */
function activityOf(chatKey) {
  const fallback = ACTIVITY_LEVELS[2];               // 取不到聊天记录 → 按"较活跃"中性处理
  let count = 0;
  try {
    const store = runtimeStore;
    if (!store?.recent || !chatKey) return { ...fallback, count: 0 };
    const since = Date.now() - ACTIVITY_WINDOW_MIN * 60000;
    const list = store.recent(chatKey, { limit: 400, includeSelf: false }) || [];
    count = list.filter((e) => num(e?.ts ?? e?.at, 0) >= since).length;
  } catch { return { ...fallback, count: 0 }; }
  let lvl = ACTIVITY_LEVELS[0];
  for (const l of ACTIVITY_LEVELS) if (count >= l.min) lvl = l;
  return { ...lvl, count };
}

/** 把档位额度与间隔按活跃度缩放（返回这一轮实际生效的限制）。 */
function effectiveLimits(lvl, activity) {
  const daily = lvl.perChatDaily > 0
    ? Math.max(1, Math.round(lvl.perChatDaily * activity.budget))
    : 0;
  const intervalMin = lvl.minIntervalMin > 0
    ? Math.max(1, Math.round(lvl.minIntervalMin * activity.interval))
    : 0;
  return { daily, intervalMin, perMinute: lvl.perMinute };
}

// ─────────────────────────────────────────────── 自己发了几条文字（诊断用）
//
// 这个计数器原来驱动"每 N 条文字强制配一张表情"的硬机制，
// 用户明确说"不要这种硬性机制" → 强制逻辑已撤掉。
// 函数保留下来只用于**排障与统计**（看它最近到底发了几条纯文字），不再参与放行判定。

/** 上一次发表情之后，机器人自己发了几条纯文字消息（只读，不做任何判定）。 */
function selfTextsSinceLastSticker(chatKey) {
  try {
    const st = chatStat(loadLib(), chatKey);
    const since = num(st?.lastStickerAt, 0);
    const store = runtimeStore;
    if (!store?.recent || !chatKey) return 0;
    const list = store.recent(chatKey, { limit: 400, includeSelf: true }) || [];
    return list.filter((e) => e?.self === true && num(e?.ts ?? e?.at, 0) > since).length;
  } catch { return 0; }
}

/** 记一次"表情包发出去了"的时间（供上面的统计用，不驱动任何强制逻辑）。 */
function markStickerSent(chatKey) {
  const st = chatStat(loadLib(), chatKey);
  if (st) { st.lastStickerAt = Date.now(); libDirty = true; }
}

let cfg = () => ({ ...DEFAULTS });

/**
 * 读技能设置（**三级兜底**，这是踩过大坑的地方）。
 *
 * ⚠️ 原来的实现是 `cfg = api.config`（在 setup 里赋值），而**加载器在热重载路径上
 *    不会调用 setup()** —— 于是每次热重载之后 cfg 都退回默认值，
 *    用户在界面上改的设置（配图档位、每日额度、发送间隔…）**全部静默失效**。
 *    实测证据：配置里档位是 often、发送间隔是 0（不限），而 conf() 读到的是
 *    occasional / 每天 40 张 / 30 秒间隔 —— 也就是说它一直在按默认值运行。
 *
 * 现在改成：
 *   ① 优先用 api.config()（加载器注入的，正常路径）
 *   ② 拿不到就直接从核心 config.json 里按 skill id 取（热重载后也能读到）
 *   ③ 都不行才回退 DEFAULTS（并且这种情况已经等于"配置全丢"，属于异常）
 *
 * 为什么②能成立：核心的 getConfig() 读的就是 data/config.json，
 * 而技能设置本来就存在 config.skills[id] —— 与 api.config() 同源，不会读错。
 */
function skillConfig() {
  try {
    const viaApi = apiRef?.config;
    if (typeof viaApi === 'function') {
      const v = viaApi();
      if (v && typeof v === 'object' && Object.keys(v).length) return v;
    }
  } catch { /* 继续走兜底 */ }
  try {
    const all = getConfig();
    const mine = all?.skills?.['sticker-steal'];
    if (mine && typeof mine === 'object') return mine;
  } catch { /* 继续走兜底 */ }
  return { ...DEFAULTS };
}
cfg = skillConfig;
let log = () => {};
let warn = () => {};
let apiRef = null;
let apiFetch = null;
let onebotRef = null;
let senderRef = null;
/**
 * 最近一次看到的聊天存档实例。
 * 定时收集要遍历**所有会话**，但只有钩子/工具的上下文里才拿得到 store，
 * 所以在这里缓存一份（钩子每次都会刷新它）。拿不到时定时收集会明确跳过并说明原因。
 */
let runtimeStore = null;

// ─────────────────────────────────────────────── 配置

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 给一个 Promise 加时间预算；超时返回 null（用于后台活，绝不能让网络拖住队列）。 */
function withBudget(promise, ms) {
  if (!(ms > 0)) return promise;
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, ms);
    promise.then(
      (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
      () => { if (!done) { done = true; clearTimeout(timer); resolve(null); } }
    );
  });
}

function clamp(n, lo, hi, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, v));
}

function conf() {
  let merged = { ...DEFAULTS };
  try {
    const raw = cfg();
    if (raw && typeof raw === 'object') merged = { ...merged, ...raw };
  } catch { /* 读不到就用默认值 */ }
  return {
    enabled: merged.enabled !== false,
    collectWindowMin: Math.round(clamp(merged.collectWindowMin, 5, 1440, DEFAULTS.collectWindowMin)),
    stickerOnly: merged.stickerOnly !== false,
    maxLibrarySize: Math.round(clamp(merged.maxLibrarySize, 100, 5000, DEFAULTS.maxLibrarySize)),
    maxLibraryMb: clamp(merged.maxLibraryMb, 8, 2048, DEFAULTS.maxLibraryMb),
    maxItemMb: clamp(merged.maxItemMb, 1, 12, DEFAULTS.maxItemMb),
    sendMinIntervalSec: Math.round(clamp(merged.sendMinIntervalSec, 0, 86400, DEFAULTS.sendMinIntervalSec)),
    sendDailyLimit: Math.round(clamp(merged.sendDailyLimit, 0, 1000, DEFAULTS.sendDailyLimit)),
    sendGlobalIntervalSec: Math.round(clamp(merged.sendGlobalIntervalSec, 0, 86400, DEFAULTS.sendGlobalIntervalSec)),
    stealQuipChance: Math.round(clamp(merged.stealQuipChance, 0, 100, DEFAULTS.stealQuipChance)),
    adminOnly: merged.adminOnly !== false,
    adminIds: String(merged.adminIds ?? ''),
    showTextInContext: merged.showTextInContext !== false,
    keepRecentCount: Math.round(clamp(merged.keepRecentCount, 1, 8, DEFAULTS.keepRecentCount)),
    gifFramesWant: Math.round(clamp(merged.gifFramesWant, 1, 6, DEFAULTS.gifFramesWant)),
    stickerFrequency: FREQ_LEVELS[String(merged.stickerFrequency || '')] ? String(merged.stickerFrequency) : DEFAULTS.stickerFrequency,
    autoTagAfterScan: merged.autoTagAfterScan !== false,
    // 定时按频率收集：0 = 关闭定时
    collectEveryHours: clamp(merged.collectEveryHours, 0, 720, DEFAULTS.collectEveryHours),
    collectTopHours: clamp(merged.collectTopHours, 1, 8760, DEFAULTS.collectTopHours),
    collectTopCount: Math.round(clamp(merged.collectTopCount, 1, 60, DEFAULTS.collectTopCount)),
    // 「删除最早的表情」按钮：删几张、以及无论怎样都至少留下几张（防手滑清空）
    deleteOldestCount: Math.round(clamp(merged.deleteOldestCount, 1, 500, DEFAULTS.deleteOldestCount)),
    deleteOldestKeep: Math.round(clamp(merged.deleteOldestKeep, 0, 1000, DEFAULTS.deleteOldestKeep)),
    // 屏蔽"其它表情系统"（原有收藏表情工具 + 其它相似插件）—— 合并后的单一开关。
    // ⚠️ 这个返回对象是**白名单**：DEFAULTS 里加了字段还不够，必须在这里也列出来，
    //    否则 conf().xxx 永远是 undefined。这个坑在这个文件里踩过三次
    //    （blockBuiltinSticker / chatStats 的字段 / 本行），症状都是"功能静默失效"。
    //
    // 兼容旧键：老配置里可能只有 blockBuiltinSticker 或 blockSimilarSticker。
    // 只要**任一旧键被显式关掉**，就以"关"为准 —— 用户关过屏蔽，说明他不想被接管。
    // `!== false` 的写法让"缺字段"等同于保留默认（开），不会因为字段缺失而误关。
    blockOtherSticker: merged.blockOtherSticker !== false
      && merged.blockBuiltinSticker !== false
      && merged.blockSimilarSticker !== false,
    recognizeOnIngest: merged.recognizeOnIngest !== false,
    recognizeIngestBudget: Math.round(clamp(merged.recognizeIngestBudget, 0, 500, DEFAULTS.recognizeIngestBudget)),
    sendChanceOnPlain: 1,
    stickerEveryNthReply: 0,
    // 以下四项**曾是用户设置**，用户要求精简界面后固定为常量 —— 见文件顶部
    // DEFAULT_ORGANIZE_* / DEFAULT_TAG_FAIL_* / DEFAULT_AUTO_TAG_BUDGET 的注释。
    // 仍然从 conf() 暴露（值恒定），这样消费方代码一行都不用改。
    organizeBatchSize: DEFAULT_ORGANIZE_BATCH,
    organizeOnTagFail: DEFAULT_TAG_FAIL_ACTION,
    organizeMaxAttempts: DEFAULT_TAG_FAIL_ATTEMPTS,
    autoTagBudget: DEFAULT_AUTO_TAG_BUDGET
  };
}

/** 额外授权的 QQ 号（逗号/空格/分号分隔）。 */
function adminIdSet() {
  return new Set(
    String(conf().adminIds || '')
      .split(/[\s,，;；]+/)
      .map((s) => s.trim())
      .filter((s) => /^\d{4,12}$/.test(s))
  );
}

// ─────────────────────────────────────────────── 文本清洗

/**
 * 清洗一切会进入模型上下文或落盘的文本。
 *
 * 为什么必须做：note/text/tags 是**模型自己生成**的，又会被拼回挑图上下文喂给模型。
 * 一条 note 里带个换行，就能在候选列表里**伪造出额外条目行**，等于自己给自己开了
 * 一个提示词注入口子。收口放在写入和读取两处，手改过 index.json 也算。
 */
function clean(s, max = MAX_NOTE_CHARS) {
  return String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanTag(s) {
  return clean(s, MAX_TAG_CHARS).replace(/[\[\]【】]/g, '');
}

/**
 * 从"这张图出现的上下文"推断它适合什么场合 —— **完全不看图片、不花 token**。
 *
 * 为什么有用（用户提的思路）：没标签的图并非"一无所知"——我们记着它从哪来、
 * 当时群里在聊什么。真人发表情也是这么判断的（在玩梗的场景收的图，多半就是玩梗用的）。
 * 这比让模型逐张看图便宜得多，也让"没标签的图"变得可判断。
 *
 * @param {object|string} src 聊天条目（有 text / senderName / chatName）或一段现成文字
 * @returns {string} 例如「2026/10/10 从"某某群"收集；当时在聊：老板又画饼了」
 */
function describeSource(src) {
  try {
    if (typeof src === 'string') return clean(src, 120);
    if (!src || typeof src !== 'object') return '';
    const text = clean(src.text, 70);
    const who = clean(src.senderName, 14);
    const chat = clean(src.chatName, 18);
    const bits = [];
    if (chat) bits.push(`来自「${chat}」`);
    if (text) bits.push(`当时在聊：${text}`);
    else if (who) bits.push(`${who} 发的`);
    return bits.join('；').slice(0, 120);
  } catch { return ''; }
}

/**
 * 弱兜底线索：连"当时在聊什么"都没有的图（本功能上线前收的），
 * 至少给出"来自哪个群、什么时候收的"——**不花 token**，但比什么都没有强：
 * 模型能据此知道它出自什么氛围的群、是不是老图。
 */
function describeHint(it) {
  try {
    const bits = [];
    if (it?.chatName) bits.push(`来自「${clean(it.chatName, 10)}」`);
    if (it?.createdAt) {
      const d = new Date(num(it.createdAt, 0));
      // 用"多久之前"比"几月几号"信息量大：能反映它是新梗还是老图
      const days = Math.floor((Date.now() - d.getTime()) / 86400000);
      bits.push(days <= 0 ? '今天收的' : days === 1 ? '昨天收的' : `${days}天前收的`);
    }
    // 这里**不写"动图"**：调用处已经会附帧数，写两遍会变成"动图 动图33帧"
    return bits.join(' ').slice(0, 60);
  } catch { return ''; }
}

/** 把一个标签对齐到固定词表；不认识的标签不丢（可能是"猫娘"这类有用关键词）。 */
function normalizeTag(raw) {
  const t = cleanTag(raw);
  if (!t) return '';
  // 「无意义」是**系统专用标记**（整理时判定"这张图看不出内容"），必须原样保留：
  // 它不能被子串匹配改写成别的词（"无意义"里没有 MOODS 词，但显式挡一道更保险）。
  if (t === '无意义') return t;
  if (MOODS.includes(t)) return t;
  const hit = MOODS.find((m) => m !== '其他' && (t.includes(m) || m.includes(t)));
  return hit || t;
}

/** 这张图是否被标为"无意义"（挑图时要排除它）。 */
function isMeaningless(it) {
  return Array.isArray(it?.tags) && it.tags.includes('无意义');
}

// ─────────────────────────────────────────────── IO

function readJson(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);   // BOM 会直接让 JSON.parse 抛错
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (error) {
    warn(`写盘失败：${error?.message ?? error}`);
    return false;
  }
}

function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

/** 从字节里认图片格式。扩展名可以骗人，字节不会。 */
function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return '';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.slice(0, 3).toString('latin1') === 'GIF') return 'gif';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  return '';
}

function extFromName(name) {
  const m = /\.([a-z0-9]{3,4})$/i.exec(String(name || ''));
  const ext = m ? m[1].toLowerCase() : '';
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext) ? ext : '';
}

function humanMb(bytes) {
  return `${(Number(bytes || 0) / 1048576).toFixed(1)}MB`;
}

// ═══════════════════════════════════════════════════════════════════════════
// GIF 动图：自己解码，把多帧交给模型看
// ═══════════════════════════════════════════════════════════════════════════
//
// 【为什么必须自己写】
//   本项目处理 GIF 的正规管道是 `src/gif-to-video.js`（GIF → ≤24 帧 mp4 → 按视频
//   部件发给模型），但它整条链依赖 **ffmpeg**。实测这台机器上
//   `spawn('ffmpeg')` 与 `spawn('ffmpeg.exe')` 都是 ENOENT —— 也就是说
//   核心的 GIF→视频、`video.frames` 抽帧在这里**一直是失效的**，GIF 只会以
//   "静态图片"形态送进模型，看到的永远是第一帧。动图的信息量恰恰在后续帧里
//   （动作、表情变化、后几帧才出现的文字），这正是要补的洞。
//
// 【为什么可以不用 ffmpeg】
//   GIF 是最简单的位图动画格式：调色板 + LZW 压缩的索引像素。解码只需要
//   LZW 解压（自己写，约 40 行）和 zlib（Node 内置）编码 PNG，
//   不需要任何原生依赖。代价是我们要自己保证不被打爆（见下面的闸门）。
//
// 【三个必须守住的闸门（畸形/炸弹 GIF 不会拖垮对话）】
//   1. 块扫描有步数上限：数据流被打断时不能死循环（MAX_GIF_STEPS）
//   2. LZW 输出上限：maxCodes 算出来的像素数封顶，超了立刻停
//   3. 画布像素上限：w*h 超过 MAX_CANVAS_PIXELS 直接拒绝渲染（只给元信息）
//   任何一个触发都只是"这次看不了动图"，不影响其它功能。

const MAX_GIF_STEPS = 2_000_000;        // 解析块的最大步数
const MAX_GIF_FRAMES = 400;             // 统计帧数的上限
// 部署标记：热重载出问题时，日志/自检里能看到到底是哪一版在跑（排查过"改的不是生效的那份"）
const PLUGIN_VERSION = '5.5.1';
const MAX_CANVAS_PIXELS = 4_194_304;    // 4096×1024，超过就不渲染
let MAX_PNG_DIM = 320;                  // 抽帧后最长边上限（只缩不放）。用 let：测量代码要临时改它对比尺寸
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** CRC32（PNG 每个块都要）。 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 把 RGBA 像素编码成 PNG。 */
function encodePngRgba(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;                                    // 每行的 filter 字节
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4)
      .copy(raw, y * (width * 4 + 1) + 1);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;      // 位深
  ihdr[9] = 6;      // 颜色类型 6 = RGBA
  return Buffer.concat([
    PNG_MAGIC,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/**
 * LZW 解码一个 GIF 帧的数据。
 *
 * 用教科书式实现（GIF 规范附录 F 的做法）：字典项 = (前缀码, 后缀像素)，
 * 输出时沿前缀链回溯展开。上一版我试图"把整串存进字典"来省一次回溯，
 * 结果 KwKwK 特例（码指向"还没建立的下一项"）和码宽增长都对不上 ——
 * 那种错会照样出图、只是画面全花，所以这里宁可写慢一点、写标准一点。
 *
 * ⚠️ 上限是硬要求：坏流会让字典/输出无限膨胀。输出缓冲按本帧应有像素数分配。
 */
function lzwDecode(data, minCodeSize, pixelCount) {
  if (!data || !data.length || !(pixelCount > 0)) return null;
  const CLEAR = 1 << minCodeSize;
  const END = CLEAR + 1;
  const out = new Uint8Array(pixelCount);
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  // ⚠️ 根码必须显式标成"链的末端"（prefix = -1）。
  //   踩过的坑：Int32Array 默认值是 0，于是码 0 的前缀还是 0 —— 回溯时
  //   0 → 0 → 0… 原地打转，结果整帧像素全变成索引 0（画面全黑/全一色，
  //   而且不抛错）。这种错只能靠"逐像素比对"发现，出图本身不会失败。
  for (let i = 0; i < 4096; i += 1) {
    if (i < CLEAR) { prefix[i] = -1; suffix[i] = i; } else { prefix[i] = -1; }
  }
  let next = CLEAR + 2;
  let codeSize = minCodeSize + 1;
  let bitPos = 0;
  let prev = -1;
  let o = 0;
  const totalBits = data.length * 8;
  const str = new Uint8Array(4096);            // 回溯用的临时缓冲
  let steps = 0;
  const maxSteps = pixelCount + 5000;

  while (bitPos + codeSize <= totalBits) {
    if ((steps += 1) > maxSteps) break;
    let code = 0;
    for (let i = 0; i < codeSize; i += 1) {
      const b = bitPos + i;
      if ((data[b >> 3] >> (b & 7)) & 1) code |= 1 << i;
    }
    bitPos += codeSize;
    if (code === CLEAR) { next = CLEAR + 2; codeSize = minCodeSize + 1; prev = -1; continue; }
    if (code === END) break;

    let len = 0;
    const c = code;
    // 回溯起点：普通码从自己开始，KwKwK 从"上一串"开始（沿前缀链展开）
    let x = (c === next && prev >= 0) ? prev : c;
    if (c === next && prev >= 0) {
      while (x >= 0 && len < str.length) { str[len++] = suffix[x]; x = prefix[x]; }
      const first = str[len - 1];
      for (let i = 0; i < (len >> 1); i += 1) { const t = str[i]; str[i] = str[len - 1 - i]; str[len - 1 - i] = t; }
      if (len < str.length) str[len++] = first;      // KwKwK：再接上自己的首像素
    } else {
      if (c >= next) break;                          // 非法码：坏流，停
      while (x >= 0 && len < str.length) { str[len++] = suffix[x]; x = prefix[x]; }
      for (let i = 0; i < (len >> 1); i += 1) { const t = str[i]; str[i] = str[len - 1 - i]; str[len - 1 - i] = t; }
    }
    if (!len) break;

    for (let i = 0; i < len; i += 1) {
      if (o >= out.length) break;
      out[o++] = str[i];
    }

    if (prev >= 0 && next < 4096) {
      prefix[next] = prev;
      suffix[next] = str[0];
      next += 1;
      if (next === (1 << codeSize) && codeSize < 12) codeSize += 1;
    }
    prev = code;
    if (o >= out.length) break;
  }
  return { pixels: out, written: o };
}

/**
 * 扫描 GIF 的块结构，取出元信息与每帧的定位信息。
 * 只走块结构，不碰像素 —— 所以又快又安全（也是"看一眼就知道是不是动图"的依据）。
 */
function parseGifStructure(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 14) return null;
  const sig = buf.slice(0, 6).toString('latin1');
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return null;

  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  const packed = buf[10];
  const hasGct = (packed & 0x80) !== 0;
  const gctSize = hasGct ? 3 * (1 << ((packed & 0x07) + 1)) : 0;
  const gct = hasGct ? buf.slice(13, 13 + gctSize) : null;

  const frames = [];
  let loop = null;
  let p = 13 + gctSize;
  let steps = 0;
  // ⚠️ GCE 必须作为**待用**状态，不能挂到已有的最后一帧上：GCE 描述的是**下一帧**。
  //    （这里踩过一次：把处置方式和透明色写到前一帧上，多帧合成的画面会整体错位。）
  let pending = { delayCs: 10, disposal: 0, transparentIndex: -1 };

  while (p < buf.length) {
    if ((steps += 1) > MAX_GIF_STEPS) break;
    const block = buf[p];
    if (block === 0x3b) break;                       // trailer
    if (block === 0x21) {                            // 扩展块
      if (p + 1 >= buf.length) break;
      const label = buf[p + 1];
      if (label === 0xf9) {                          // 图形控制扩展
        if (p + 7 >= buf.length) break;
        const size = buf[p + 2];
        const flags = buf[p + 3];
        pending = {
          delayCs: buf.readUInt16LE(p + 4),
          disposal: (flags >> 2) & 0x07,
          transparentIndex: (flags & 0x01) ? buf[p + 6] : -1
        };
        p += 3 + size;
        p = skipSubBlocks(buf, p);
      } else if (label === 0xff) {                   // 应用扩展：NETSCAPE 循环次数
        if (p + 2 >= buf.length) break;
        const size = buf[p + 2];
        if (p + 2 + size + 4 < buf.length && buf.slice(p + 3, p + 14).toString('latin1').startsWith('NETSCAPE')) {
          // 结构：[块大小][NETSCAPE2.0][子块大小=3][1][loop 低字节][loop 高字节]
          loop = buf.readUInt16LE(p + 2 + size + 3);
        }
        p += 3 + size;
        p = skipSubBlocks(buf, p);
      } else {
        p += 2;
        p = skipSubBlocks(buf, p);
      }
      continue;
    }
    if (block === 0x2c) {                            // 图像描述符
      if (p + 9 >= buf.length) break;
      const left = buf.readUInt16LE(p + 1);
      const top = buf.readUInt16LE(p + 3);
      const w = buf.readUInt16LE(p + 5);
      const h = buf.readUInt16LE(p + 7);
      const ip = buf[p + 9];
      const hasLct = (ip & 0x80) !== 0;
      const lctSize = hasLct ? 3 * (1 << ((ip & 0x07) + 1)) : 0;
      const lct = hasLct ? buf.slice(p + 10, p + 10 + lctSize) : null;
      let q = p + 10 + lctSize;
      if (q >= buf.length) break;
      const minCodeSize = buf[q];
      q += 1;
      const data = [];
      while (q < buf.length) {
        if ((steps += 1) > MAX_GIF_STEPS) break;
        const sub = buf[q];
        q += 1;
        if (!sub) break;
        data.push(buf.slice(q, q + sub));
        q += sub;
      }
      frames.push({
        left, top, w, h,
        interlaced: (ip & 0x40) !== 0,
        palette: lct || gct,
        minCodeSize,
        data: Buffer.concat(data),
        delayCs: pending.delayCs,
        disposal: pending.disposal,
        transparentIndex: pending.transparentIndex
      });
      pending = { delayCs: 10, disposal: 0, transparentIndex: -1 };   // 用完就复位
      if (frames.length > MAX_GIF_FRAMES) break;
      p = q;
      continue;
    }
    p += 1;                                          // 未知块：跳过一字节，别死循环
  }

  return {
    version: sig,
    width,
    height,
    frames,
    loop,
    gct,
    animated: frames.length > 1
  };
}

/** 跳过一串子块（每块 1 字节长度 + 数据，长度 0 结束）。 */
function skipSubBlocks(buf, p) {
  let q = p;
  let guard = 0;
  while (q < buf.length && (guard += 1) < MAX_GIF_STEPS) {
    const size = buf[q];
    q += 1;
    if (!size) break;
    q += size;
  }
  return q;
}

/** 元信息（不解码像素）：动图与否、多少帧、多大、多少秒、循环几次。 */
function gifInfo(buf) {
  try {
    const g = parseGifStructure(buf);
    if (!g) return null;
    const totalCs = g.frames.reduce((s, f) => s + (f.delayCs || 10), 0);
    return {
      animated: g.animated,
      frames: g.frames.length,
      width: g.width,
      height: g.height,
      loop: g.loop,
      durationSec: Math.round((totalCs / 100) * 10) / 10
    };
  } catch {
    return null;
  }
}

/**
 * GIF 的隔行扫描行序：帧内像素按 8/8/4/2 的步长分四遍存放。
 * 不还原的话画面会变成横条纹 —— 这种"看着有图但明显不对"的输出最容易被当成
 * "模型看错了"，其实是我们解码错了，所以必须按行序还原。
 */
const INTERLACE_PASSES = [[0, 8], [4, 8], [2, 4], [1, 2]];

/** 把一格像素写进画布。 */
function putPixel(canvas, cw, ch, cx, cy, pal, palIdx) {
  if (cx < 0 || cy < 0 || cx >= cw || cy >= ch) return;
  if (palIdx + 2 >= pal.length) return;
  const o = (cy * cw + cx) * 4;
  canvas[o] = pal[palIdx];
  canvas[o + 1] = pal[palIdx + 1];
  canvas[o + 2] = pal[palIdx + 2];
  canvas[o + 3] = 255;
}

/** 把一帧画到画布上（含透明索引、隔行还原与三种处置方式）。 */
function drawFrame(canvas, cw, ch, frame, G) {
  if (frame.disposal === 2) {                        // 处置=2：先把本帧区域清空再画
    for (let y = 0; y < frame.h; y += 1) {
      const cy = frame.top + y;
      if (cy < 0 || cy >= ch) continue;
      for (let x = 0; x < frame.w; x += 1) {
        const cx = frame.left + x;
        if (cx < 0 || cx >= cw) continue;
        const i = (cy * cw + cx) * 4;
        canvas[i] = 0; canvas[i + 1] = 0; canvas[i + 2] = 0; canvas[i + 3] = 0;
      }
    }
  }
  const dec = lzwDecode(frame.data, frame.minCodeSize, frame.w * frame.h);
  if (!dec) return null;
  const px = dec.pixels;
  const pal = frame.palette || G.gct;
  if (!pal) return null;

  // 隔行：算出每个"显示行"对应数据里的第几行
  let rowOf = null;
  if (frame.interlaced) {
    rowOf = new Int32Array(frame.h).fill(-1);
    let r = 0;
    for (const [start, step] of INTERLACE_PASSES) {
      for (let y = start; y < frame.h; y += step) { if (r < frame.h) rowOf[r++] = y; }
    }
  }

  for (let y = 0; y < frame.h; y += 1) {
    const srcRow = frame.interlaced && rowOf ? rowOf[y] : y;
    if (srcRow < 0) continue;
    for (let x = 0; x < frame.w; x += 1) {
      const src = srcRow * frame.w + x;
      if (src >= px.length) continue;
      const idx = px[src];
      if (idx === frame.transparentIndex) continue;  // 透明像素：保留画布上原有内容
      putPixel(canvas, cw, ch, frame.left + x, frame.top + y, pal, idx * 3);
    }
  }
  return dec;
}

/**
 * 抽帧：均匀取 want 帧，**去掉观感重复的帧**，每帧渲染成 PNG dataUrl。
 *
 * 为什么必须去重（实测驱动）：一张 200×200 的动图，480/320/240 三种上限产出**完全一样**
 * （scaleRgba 只缩不放），所以"降分辨率"对小贴纸一点不省；真正省的是**少发帧**。
 * 实测同一张图 3 帧 → 2 帧体积降 35%，而且指纹比对显示"3 帧里本来就只有 2 帧不同"。
 * 对模型来说，两张几乎一样的画面不提供任何额外信息 —— 发 2 张和发 3 张理解力相同。
 *
 * @returns {Array<{index:number, total:number, dataUrl:string}>}
 */
function extractGifFrames(buf, want = 3) {
  const G = parseGifStructure(buf);
  if (!G || !G.frames.length) return [];
  const cw = G.width;
  const ch = G.height;
  if (!(cw > 0 && ch > 0) || cw * ch > MAX_CANVAS_PIXELS) return [];   // 闸门 3

  const total = G.frames.length;
  const targets = [];
  if (want <= 1 || total <= 1) {
    targets.push(total - 1);                     // 单帧：最后一帧（合成完成态）最完整
  } else {
    const n = Math.min(want, total);
    for (let k = 0; k < n; k += 1) targets.push(Math.round((k * (total - 1)) / (n - 1)));
  }
  const wanted = [...new Set(targets)].sort((a, b) => a - b);
  const need = wanted[wanted.length - 1];

  const canvas = new Uint8Array(cw * ch * 4);
  const out = [];
  // 处置方式 3 = "画下一帧前，把本帧区域还原成画本帧之前的样子"。
  // 所以要在画每一帧之前把它那块区域**存下来**，下一帧开画前再贴回去。
  // （只清空是不对的：底色会被擦成透明，画面发黑/发白。）
  let savedRect = null;
  let lastRgba = null;                             // 去重用的"上一张已选画面"
  let lastW = 0;
  let lastH = 0;
  for (let i = 0; i <= need && i < total; i += 1) {
    const frame = G.frames[i];

    if (i > 0) {
      const pd = G.frames[i - 1].disposal;
      const pf = G.frames[i - 1];
      if (pd === 2) {                              // 2：把上一帧区域清空
        for (let y = 0; y < pf.h; y += 1) {
          for (let x = 0; x < pf.w; x += 1) {
            const cx = pf.left + x; const cy = pf.top + y;
            if (cx < 0 || cy < 0 || cx >= cw || cy >= ch) continue;
            const o = (cy * cw + cx) * 4;
            canvas[o] = 0; canvas[o + 1] = 0; canvas[o + 2] = 0; canvas[o + 3] = 0;
          }
        }
      } else if (pd === 3 && savedRect && savedRect.i === i - 1) {   // 3：还原暂存
        const { x0, y0, w: sw, h: sh, data } = savedRect;
        for (let y = 0; y < sh; y += 1) {
          for (let x = 0; x < sw; x += 1) {
            const cx = x0 + x; const cy = y0 + y;
            if (cx < 0 || cy < 0 || cx >= cw || cy >= ch) continue;
            const so = (y * sw + x) * 4;
            const o = (cy * cw + cx) * 4;
            canvas[o] = data[so]; canvas[o + 1] = data[so + 1];
            canvas[o + 2] = data[so + 2]; canvas[o + 3] = data[so + 3];
          }
        }
      }
    }

    // 暂存本帧区域（只有下一帧可能用到处置 3 时才需要）
    const nextDisposal = i + 1 < total ? G.frames[i + 1].disposal : 0;
    if (nextDisposal === 3) {
      const x0 = Math.max(0, frame.left);
      const y0 = Math.max(0, frame.top);
      const w = Math.min(frame.w, cw - x0);
      const h = Math.min(frame.h, ch - y0);
      if (w > 0 && h > 0) {
        const data = new Uint8Array(w * h * 4);
        for (let y = 0; y < h; y += 1) {
          for (let x = 0; x < w; x += 1) {
            const o = ((y0 + y) * cw + (x0 + x)) * 4;
            const d = (y * w + x) * 4;
            data[d] = canvas[o]; data[d + 1] = canvas[o + 1];
            data[d + 2] = canvas[o + 2]; data[d + 3] = canvas[o + 3];
          }
        }
        savedRect = { i, x0, y0, w, h, data };
      } else {
        savedRect = null;
      }
    }

    const dec = drawFrame(canvas, cw, ch, frame, G);
    if (!dec) continue;
    if (wanted.includes(i)) {
      // 质量闸门：LZW 中途断掉时画面会走形，而"看着能出图"最容易被当成模型看错。
      // 解不满 60% 像素就整张判为不可用 —— 调用方会退回"只发第一帧"并如实说明。
      const expected = frame.w * frame.h;
      if (expected <= 0 || dec.written / expected < 0.6) return [];
      const scaled = scaleRgba(canvas, cw, ch, MAX_PNG_DIM);
      // 去重：与上一张已选画面**逐像素相同**就跳过。这不会丢信息
      // （一模一样的画面给模型看第二遍不增加任何理解），纯粹是省 token。
      if (lastRgba && scaled.w === lastW && scaled.h === lastH && sameRgba(scaled.px, lastRgba)) {
        continue;
      }
      lastRgba = Uint8Array.from(scaled.px);
      lastW = scaled.w;
      lastH = scaled.h;
      out.push({
        index: i + 1,
        total,
        dataUrl: `data:image/png;base64,${encodePngRgba(scaled.w, scaled.h, scaled.px).toString('base64')}`
      });
      if (out.length >= Math.max(1, want)) break;     // 够了就不再浪费后面的解码
    }
  }
  return out;
}

/** 两份 RGBA 是否逐字节相同。 */
function sameRgba(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** 最近邻缩放（表情包不需要插值，够看）。 */
function scaleRgba(src, w, h, maxDim) {
  const scale = Math.min(1, maxDim / Math.max(w, h));
  if (scale >= 1) return { w, h, px: src };
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const dst = new Uint8Array(nw * nh * 4);
  for (let y = 0; y < nh; y += 1) {
    const sy = Math.min(h - 1, Math.floor(y / scale));
    for (let x = 0; x < nw; x += 1) {
      const sx = Math.min(w - 1, Math.floor(x / scale));
      const s = (sy * w + sx) * 4;
      const d = (y * nw + x) * 4;
      dst[d] = src[s]; dst[d + 1] = src[s + 1]; dst[d + 2] = src[s + 2]; dst[d + 3] = src[s + 3];
    }
  }
  return { w: nw, h: nh, px: dst };
}

// ─────────────────────────────────────────────── 记忆库（index.json）

let lib = null;          // { version, bornAt, items:[], lastSendAt, lastGlobalSendAt, sentDay, sentToday, sentTotal, counters }
let libDirty = false;
let lastFlush = 0;

function emptyLib() {
  return {
    version: 1,
    bornAt: Date.now(),
    items: [],
    lastSendAt: 0,
    lastGlobalSendAt: 0,
    sentDay: '',
    sentToday: 0,
    sentTotal: 0,
    // 「上次给出基础奖励 E 的时刻」——奖励系统用它实现"每 20 秒最多给一次"，
    // 防连发几十张刷分。⚠️ 必须在**默认值 + 加载 + 保存**三处都出现，
    // 漏任何一处都会让它静默丢失（踩过：保存是白名单式的，漏了就等于没记）。
    lastBaseRewardAt: 0,
    chatStats: {},        // chatKey → { day, sentToday, lastAt, sentTotal }（每个群的配图频率）
    counters: { collected: 0, duplicates: 0, skipped: 0, evicted: 0, failed: 0, sent: 0, quips: 0, lookFailed: 0, freqBlocked: 0 }
  };
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const src = clean(raw.src, 64);
  const file = clean(raw.file, 120);
  if (!src && !file) return null;
  return {
    key: src ? `src:${src}` : `file:${String(file).toLowerCase()}`,
    src,
    file,
    path: clean(raw.path, 400),
    bytes: Math.max(0, num(raw.bytes, 0)),
    ext: clean(raw.ext, 8),
    tags: Array.isArray(raw.tags) ? raw.tags.map(cleanTag).filter(Boolean).slice(0, MAX_TAGS) : [],
    note: clean(raw.note, MAX_NOTE_CHARS),
    text: clean(raw.text, MAX_TEXT_CHARS),
    source: raw.source === 'model' ? 'model' : 'observed',
    chatKey: clean(raw.chatKey, 60),
    chatName: clean(raw.chatName, 60),
    createdAt: num(raw.createdAt, Date.now()),
    usedAt: num(raw.usedAt, 0),
    useCount: Math.max(0, num(raw.useCount, 0)),
    sentCount: Math.max(0, num(raw.sentCount, 0)),
    sources: Array.isArray(raw.sources) ? raw.sources.map((s) => clean(s, 60)).filter(Boolean).slice(0, MAX_SOURCES) : [],
    // ── 动图与"看过"的记账（只做缓存判断，不影响业务） ──
    animated: raw.animated === true,
    gifFrames: Math.max(0, num(raw.gifFrames, 0)),
    gifDurationSec: Math.max(0, num(raw.gifDurationSec, 0)),
    gifWidth: Math.max(0, num(raw.gifWidth, 0)),
    gifHeight: Math.max(0, num(raw.gifHeight, 0)),
    framesReady: Math.max(0, num(raw.framesReady, 0)),
    viewedAt: num(raw.viewedAt, 0),
    viewCount: Math.max(0, num(raw.viewCount, 0)),
    // 「来源上下文」：收它时群里在聊什么（不花 token 就能推断适用场景）
    srcHint: clean(raw.srcHint, 120),
    // 反馈奖励（R）：发出去之后群里的反应（正=有回应、负=冷场）。权重小，只做微调。
    feedback: num(raw.feedback, 0),
    feedbackAt: num(raw.feedbackAt, 0),
    // 互动统计（用户奖励方案）：这张图发过几次、累计带来多少不同群友回应、多少条回复。
    // 下次选图时按它的历史互动率给分 —— 这就是"奖励影响下一次选择"。
    interactShown: num(raw.interactShown, 0),
    interactUsers: num(raw.interactUsers, 0),
    interactReplies: num(raw.interactReplies, 0),
    interactAt: num(raw.interactAt, 0),
    lastReward: num(raw.lastReward, 0),
    rewardHistory: Array.isArray(raw.rewardHistory) ? raw.rewardHistory.slice(-20) : [],
    // 「整理表情库」用：自动识别失败了几次。攒够阈值还认不出来 → 按设置删掉或留着。
    tagFails: Math.max(0, num(raw.tagFails, 0)),
    tagTriedAt: num(raw.tagTriedAt, 0),
    tagFp: clean(raw.tagFp, 80),
    // 按会话记"这个群最近发过这张"（chatKey → 时间戳）—— 硬性轮换的依据。
    sentTo: (raw.sentTo && typeof raw.sentTo === 'object' && !Array.isArray(raw.sentTo))
      ? Object.fromEntries(Object.entries(raw.sentTo).slice(0, 8).map(([k, v]) => [String(k).slice(0, 60), num(v, 0)]))
      : {}
  };
}

function loadLib() {
  if (lib) return lib;
  lib = emptyLib();
  const raw = readJson(INDEX_FILE, null);
  if (raw && typeof raw === 'object') {
    for (const item of Array.isArray(raw.items) ? raw.items : []) {
      const norm = normalizeItem(item);
      if (norm) lib.items.push(norm);
    }
    lib.bornAt = num(raw.bornAt, lib.bornAt);
    lib.lastSendAt = num(raw.lastSendAt, 0);
    lib.lastGlobalSendAt = num(raw.lastGlobalSendAt, 0);
    lib.sentDay = clean(raw.sentDay, 20);
    lib.sentToday = Math.max(0, num(raw.sentToday, 0));
    lib.sentTotal = Math.max(0, num(raw.sentTotal, 0));
    lib.lastBaseRewardAt = Math.max(0, num(raw.lastBaseRewardAt, 0));
    if (raw.counters && typeof raw.counters === 'object') {
      for (const k of Object.keys(lib.counters)) lib.counters[k] = Math.max(0, num(raw.counters[k], 0));
    }
    // 每个会话的配图记账（老索引里没有这个字段 → 从空对象开始，不影响使用）
    if (raw.chatStats && typeof raw.chatStats === 'object') {
      for (const [k, v] of Object.entries(raw.chatStats)) {
        if (!v || typeof v !== 'object') continue;
        lib.chatStats[String(k)] = {
          day: clean(v.day, 20),
          sentToday: Math.max(0, num(v.sentToday, 0)),
          lastAt: num(v.lastAt, 0),
          sentTotal: Math.max(0, num(v.sentTotal, 0)),
          // ⚠️ 下面这三个字段**必须在这里显式搬过来**。
          //    这个加载是"白名单"式的：没列出来的字段读盘时就被丢掉。
          //    原来漏了它们三个，后果是：
          //      · recentIds（最近 N 次发过的编号）→ 每次读盘归零，"先排除最近 5 次"形同不存在
          //      · recentAt（发送时间戳）→ "每分钟最多 N 张"永远读到空数组
          //      · lastStickerAt → 统计"距上次表情多久"永远是 0
          //    表现就是"功能写了但看不到效果"，而且**不报错**，极难排查。
          recentIds: Array.isArray(v.recentIds) ? v.recentIds.map((x) => clean(x, 80)).filter(Boolean).slice(-8) : [],
          recentAt: Array.isArray(v.recentAt) ? v.recentAt.map((x) => num(x, 0)).filter(Boolean).slice(-120) : [],
          lastStickerAt: num(v.lastStickerAt, 0)
        };
      }
    }
    log(`记忆库已加载：${lib.items.length} 张（${path.basename(INDEX_FILE)}）`);
  }
  return lib;
}

function flushLib(force = false) {
  if (!lib || !libDirty) return false;
  const now = Date.now();
  if (!force && now - lastFlush < FLUSH_DEBOUNCE_MS) return false;
  lastFlush = now;
  libDirty = false;
  const ok = writeJsonAtomic(INDEX_FILE, {
    version: 1,
    savedAt: new Date(now).toISOString(),
    bornAt: lib.bornAt,
    items: lib.items,
    lastSendAt: lib.lastSendAt,
    lastGlobalSendAt: lib.lastGlobalSendAt,
    sentDay: lib.sentDay,
    sentToday: lib.sentToday,
    sentTotal: lib.sentTotal,
    lastBaseRewardAt: num(lib.lastBaseRewardAt, 0),
    chatStats: lib.chatStats,
    counters: lib.counters
  });
  if (!ok) libDirty = true;
  return ok;
}

function findItem(key) {
  if (!key) return null;
  return loadLib().items.find((it) => it.key === key) || null;
}

function findBySrc(src) {
  if (!src) return null;
  return loadLib().items.find((it) => it.src && it.src === src) || null;
}

/**
 * 编号 → 库条目。
 * 编号很长（sha1 有 40 位），模型抄写出错是常态，所以按"精确 → 前缀 → 唯一子串"
 * 三级匹配；命中多个时**明确要求它重挑**而不是替它猜 —— 挑错图发出去比报错难查。
 */
function resolveItem(rawInput) {
  const raw = clean(rawInput, 80).replace(/^#/, '');
  if (!raw) return { error: '缺少 stickerId' };

  const exact = findItem(raw) || findItem(raw.startsWith('src:') || raw.startsWith('file:') ? raw : `src:${raw}`);
  if (exact) return { item: exact };

  const needle = raw.replace(/^(src|file):/i, '').toLowerCase();
  if (needle.length >= 4) {
    const hits = loadLib().items.filter((it) =>
      (it.src && it.src.toLowerCase().startsWith(needle))
      || (it.file && it.file.toLowerCase().includes(needle)));
    if (hits.length === 1) return { item: hits[0] };
    if (hits.length > 1) return { error: `编号 ${raw} 能对上 ${hits.length} 张（太短了），请用「挑一张表情包」重新拿完整编号` };
  }
  return { error: `库里找不到表情包 ${raw}。请先用「挑一张表情包」或「看看表情包库」拿到正确编号，不要自己编。` };
}

/** 展示用的短编号：模型只需抄 10 位，够用且不易错。 */
function shortId(it) {
  const body = String(it?.key || '').replace(/^(src|file):/i, '');
  return body.slice(0, 10);
}

function addItem(item) {
  loadLib().items.push(item);
  libDirty = true;
  return item;
}

function removeItem(key) {
  const l = loadLib();
  const idx = l.items.findIndex((it) => it.key === key);
  if (idx < 0) return null;
  const [item] = l.items.splice(idx, 1);
  libDirty = true;
  try {
    if (item.path && isInsideStore(item.path)) fs.unlinkSync(item.path);
  } catch (error) {
    warn(`删除图片文件失败（索引已删）：${error?.message ?? error}`);
  }
  return item;
}

function totalBytes() {
  return loadLib().items.reduce((sum, it) => sum + (it.bytes || 0), 0);
}

/** 淘汰：库容量或磁盘占用超限时，先扔"从没被用过、也没人发过"的老条目。 */
function evictIfNeeded() {
  const c = conf();
  const limit = c.maxLibrarySize;
  const byteCap = c.maxLibraryMb * 1048576;
  while (lib.items.length > limit || (lib.items.length > 1 && totalBytes() > byteCap)) {
    const victim = [...lib.items]
      .sort((a, b) => (a.sentCount || 0) - (b.sentCount || 0) || (a.usedAt || a.createdAt) - (b.usedAt || b.createdAt))[0];
    if (!victim) break;
    removeItem(victim.key);
    lib.counters.evicted += 1;
  }
}

// ─────────────────────────────────────────────── 图片字节的来源

/** data/sticker-steal 里是不是自己的文件（删除/发送前的自检，防越界）。 */
function isInsideStore(p) {
  try {
    const root = path.resolve(IMG_DIR) + path.sep;
    return path.resolve(String(p)).startsWith(root);
  } catch {
    return false;
  }
}

function isPublicHttpUrl(u) {
  const s = String(u || '').trim();
  if (!/^https?:\/\//i.test(s)) return false;
  try {
    const host = new URL(s).hostname.toLowerCase();
    if (!host || host === 'localhost' || host.endsWith('.local')) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const [a, b] = host.split('.').map(Number);
      if (a === 10 || a === 127 || a === 0) return false;
      if (a === 192 && b === 168) return false;
      if (a === 172 && b >= 16 && b <= 31) return false;
      if (a === 169 && b === 254) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function fileUriToPath(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (!s.toLowerCase().startsWith('file://')) return '';
  try {
    let p = decodeURIComponent(s.replace(/^file:\/\/\/?/i, ''));
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    return p.replace(/\//g, path.sep);
  } catch {
    return '';
  }
}

/**
 * 退路下载器（只有拿不到核心 safe-fetch 时才走到）。
 * 清单声明了 web_fetch 权限，所以才拿得到 api.fetch。护栏照抄 sticker-memory 的口径。
 */
async function downloadGuarded(url, maxBytes) {
  if (typeof apiFetch !== 'function') return null;
  if (!isPublicHttpUrl(url)) return null;
  try {
    const resp = await apiFetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { accept: 'image/*,*/*;q=0.8' },
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(8000) : undefined
    });
    if (!resp?.ok) return null;
    const type = String(resp.headers?.get?.('content-type') || '');
    if (type && !/^image\//i.test(type) && !/octet-stream/i.test(type)) return null;
    const declared = Number(resp.headers?.get?.('content-length') || 0);
    if (declared && declared > maxBytes) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length || buf.length > maxBytes) return null;
    return buf;
  } catch {
    return null;
  }
}

/** 取一张媒体对应的图片字节。四条来源，依次尝试（与 sticker-memory 同口径）。 */
async function fetchImageBytes(media, maxBytes) {
  const url = String(media?.url || '').trim();
  const file = String(media?.file || '').trim();

  // ① data: URL
  if (/^data:image\//i.test(url)) {
    const i = url.indexOf('base64,');
    if (i > 0) {
      try {
        const buf = Buffer.from(url.slice(i + 7), 'base64');
        if (buf.length && buf.length <= maxBytes) return buf;
      } catch { /* 落到后面 */ }
    }
  }

  // ② 本机路径（协议端缓存、表情包仓库的本地文件）
  const local = fileUriToPath(url) || (/^[A-Za-z]:[\\/]/.test(file) || file.startsWith('/') ? file : '');
  if (local) {
    try {
      if (fs.existsSync(local) && fs.statSync(local).isFile()) {
        const st = fs.statSync(local);
        if (st.size > 0 && st.size <= maxBytes) {
          const buf = fs.readFileSync(local);
          if (buf.length) return buf;
        }
      }
    } catch { /* 试下一个来源 */ }
  }

  // ③ OneBot get_image：把 file 换成可读的本地路径或下载地址。
  //    带 4 秒预算：这是后台活，不能让一次慢查询把后面排队的表情全堵住。
  if (file && onebotRef?.call) {
    try {
      const ret = await withBudget(onebotRef.call('get_image', { file }), 4000);
      const p = ret?.file ? String(ret.file) : '';
      if (p && fs.existsSync(p)) {
        const st = fs.statSync(p);
        if (st.size > 0 && st.size <= maxBytes) {
          const buf = fs.readFileSync(p);
          if (buf.length) return buf;
        }
      }
      const got = String(ret?.url || '');
      if (got && isPublicHttpUrl(got)) {
        const buf = await downloadPublic(got, maxBytes);
        if (buf) return buf;
      }
    } catch { /* 落到直链 */ }
  }

  // ④ 公网直链
  if (url && isPublicHttpUrl(url)) return downloadPublic(url, maxBytes);
  return null;
}

async function downloadPublic(url, maxBytes) {
  if (typeof safeFetchBinary === 'function') {
    try {
      const { buffer } = await safeFetchBinary(String(url), maxBytes);
      return buffer?.length ? buffer : null;
    } catch {
      // 走核心失败（网络/超时/被 SSRF 口径拦下）：不再自己重试一次，
      // 避免"核心说不行、插件偏要试"这种绕过安全口径的行为。
      return null;
    }
  }
  return downloadGuarded(url, maxBytes);
}

/**
 * 回填旧条目的元信息。
 *
 * 为什么要它：动图标记是后加的，之前收进来的图（比如插件刚上线那会儿偷到的）
 * 索引里 gifFrames=0、animated=false —— 不补的话它们会被当成静态图，
 * "动图必须多帧看"这条规则对它们失效。所以启动时补一次，幂等。
 */
function backfillMeta() {
  try {
    loadLib();
    let filled = 0;
    for (const it of lib.items) {
      if (it.gifFrames > 0 || !it.path) continue;
      try {
        if (!fs.existsSync(it.path)) continue;
        const st = fs.statSync(it.path);
        if (!st.isFile() || !st.size) continue;
        const buf = fs.readFileSync(it.path);
        Object.assign(it, mediaMeta(buf, it.ext || sniffImage(buf)));
        if (!it.bytes) it.bytes = st.size;
        filled += 1;
      } catch { /* 单条失败不影响其它条目 */ }
    }
    if (filled) {
      libDirty = true;
      flushLib(true);
      log(`已回填 ${filled} 条旧表情的元信息（动图标记等）`);
    }
    return filled;
  } catch (error) {
    warn(`回填元信息失败（不影响使用）：${error?.message ?? error}`);
    return 0;
  }
}

/**
 * 启动自检：现场构造一张 2 帧的最小 GIF，解出来做**结构性断言**。
 *
 * 为什么挂在这里而不是 activate()：加载器在加载路径上**不会**调 activate
 * （实测：日志里 [sticker-steal] 一行都不出现），挂 activate 里等于永远不执行。
 *
 * ⚠️ 这段代码的字节布局是被咬过之后才对的，三个坑按踩到的顺序记在这里：
 *   ① 声明了"有全局色表"就必须**真的把色表拼进去**。漏了那 12 字节后，解析器按声明
 *      跳过长度的动作就全错位——表现为"只认出 1 帧 + 像素解成 3,2,1,0"，
 *      而报错信息完全指不到色表。**这是最初失败的真正原因。**
 *   ② 图像描述符是 **11 字节**：0x2C + 左/上/宽/高（各 2 字节 LE）+ packed + minCodeSize。
 *      少写 2 字节同样会"只认出 1 帧"。
 *   ③ 帧数据必须包成"子块"：长度字节 + 数据 + 0 结束字节。
 *
 * ⚠️ 判据必须是**结构性**的（帧数 / PNG 尺寸 / 两帧内容必须不同）：
 *    拿手算的字节去当"期望像素"完全不可靠 —— 我手算过三次，三次结果都不一样，
 *    反而把自己带沟里。插件本身的解析器与解码器**从头到尾都是对的**，
 *    三次"失败"全是这个测试夹具自己写错了。
 */
function selfCheckGifDecoder() {
  try {
    const gct = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]);   // 4 色
    const header = Buffer.concat([
      Buffer.from('GIF89a', 'latin1'),
      Buffer.from([2, 0, 2, 0]),            // 画布 2×2
      Buffer.from([0x80 | 0x01]),            // 有全局色表、4 色（0x01 → 2^(1+1)=4）
      Buffer.from([0, 0]),                   // 背景索引 / 像素比
      gct                                    // ← 坑 ①：这一行漏掉过
    ]);
    // 每写一个像素就发一个 CLEAR：码宽恒为 3 位，字典永不增长，最笨但完全可控
    const frame = (indices) => {
      const codes = [];
      for (const px of indices) codes.push(4, px);     // CLEAR = 1<<2 = 4
      codes.push(5);                                    // END = 5
      const bits = [];
      for (const c of codes) for (let i = 0; i < 3; i += 1) bits.push((c >> i) & 1);
      const bytes = [];
      for (let i = 0; i < bits.length; i += 8) {
        let b = 0;
        for (let j = 0; j < 8; j += 1) if (bits[i + j]) b |= 1 << j;
        bytes.push(b);
      }
      return Buffer.concat([
        Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00]),        // 图形控制扩展
        Buffer.from([0x2c, 0, 0, 0, 0, 2, 0, 2, 0, 0x00, 2]),                // 描述符（11 字节，坑 ②）
        Buffer.from([bytes.length]), Buffer.from(bytes), Buffer.from([0])    // 子块 + 结束（坑 ③）
      ]);
    };
    // 4 帧：A、B、A、C —— 取 3 帧时会采到 A、A、C 三个采样点，
    // 去重应当把重复的那个 A 去掉（这同时验证了"去重生效"与"不同帧不会被误删"）
    const gif = Buffer.concat([
      header,
      frame([0, 1, 2, 3]),      // A
      frame([3, 2, 1, 0]),      // B
      frame([0, 1, 2, 3]),      // A（与第 1 帧画面完全相同）
      frame([1, 1, 2, 2]),      // C
      Buffer.from([0x3b])
    ]);

    const info = gifInfo(gif);
    const G = parseGifStructure(gif);
    // 像素判据：帧 1 应解出我们写进去的 0,1,2,3
    const dec = G && G.frames[0] ? lzwDecode(G.frames[0].data, G.frames[0].minCodeSize, 4) : null;
    const px1 = dec ? [...dec.pixels].slice(0, 4).join(',') : 'null';
    // 4 帧里按 3 个采样点取（A、A、C）→ 去重后应产出 2 张
    const frames = extractGifFrames(gif, 3);
    const pngInfo = frames.map((f) => {
      const png = Buffer.from(f.dataUrl.split('base64,')[1], 'base64');
      return {
        magic: png.slice(0, 8).equals(PNG_MAGIC),
        w: png.readUInt32BE(16),
        h: png.readUInt32BE(20),
        body: f.dataUrl.slice(-60)
      };
    });
    const twoFramesDiffer = pngInfo.length === 2 && pngInfo[0].body !== pngInfo[1].body;

    const ok = px1 === '0,1,2,3'
      && info && info.animated && info.frames === 4
      && frames.length === 2                          // ← 采样 3 点(A,A,C) 去重后应只剩 A、C 两张
      && pngInfo.every((p) => p.magic && p.w === 2 && p.h === 2)
      && twoFramesDiffer;

    const diag = `插件版本=${PLUGIN_VERSION} 像素=${px1} 源帧数=${info ? info.frames : 'null'}`
      + ` 动图=${info ? info.animated : 'null'} 去重后发出=${frames.length}`
      + ` PNG=${pngInfo.map((p) => `${p.magic ? 'ok' : 'bad'}${p.w}x${p.h}`).join('/')}`
      + ` 两张不同=${twoFramesDiffer}`;

    if (ok) {
      log(`动图识别自检通过：GIF 能被拆成多帧画面交给模型（${diag}）`);
      writeSelfCheck(`${new Date().toISOString()} PASS ${diag}`);
      selfCheckFrequency();
    } else {
      // 计数前必须先保证库已加载：自检在 setup 阶段跑，那时 lib 还是 null
      // （踩过：直接写 lib.counters → Cannot read properties of null，整个 setup 抛错）
      loadLib();
      lib.counters.lookFailed = (lib.counters.lookFailed || 0) + 1;
      libDirty = true;
      flushLib(true);
      warn(`动图识别自检未通过：动图会退回"只显示第一帧"（其它功能不受影响）。${diag}`);
      writeSelfCheck(`${new Date().toISOString()} FAIL ${diag}`);
    }
  } catch (error) {
    warn(`动图识别自检抛错（动图抽帧将退回单帧）：${error?.message ?? error}`);
    writeSelfCheck(`${new Date().toISOString()} ERROR ${error?.message ?? error}\n${error?.stack ?? ''}`);
  }
}


/** 追加一行到测量文件。 */
function appendSelfCheck(text) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(path.join(DIR, 'measure.log'), `${new Date().toISOString()} ${text}\n`, 'utf8');
  } catch { /* 忽略 */ }
}

// ═══════════════════════════════════════════════════════════════════════════
// 定时按频率收集（"每 N 小时收集一次"）
// ═══════════════════════════════════════════════════════════════════════════
//
// 为什么用真实定时器而不是挂在钩子上：核心的 5 个钩子都只在"机器人要回话"时触发，
// 而"每 N 小时收一次"与回话频率无关 —— 挂钩子会变成"只有它愿意回话时才收"，
// 那就不是定时了。插件在自己的生命周期里跑定时器是官方允许的（activate/deactivate）。
//
// 状态落盘（schedule.json）：否则每次重启都会重新计时，
// 频繁重启的用户会变成"永远不到点"。

const SCHEDULE_FILE = path.join(DIR, 'schedule.json');
let scheduleTimer = null;
let schedState = { lastRunAt: 0, lastResult: '' };

function loadSchedule() {
  const raw = readJson(SCHEDULE_FILE, null);
  if (raw && typeof raw === 'object') {
    schedState.lastRunAt = num(raw.lastRunAt, 0);
    schedState.lastResult = clean(raw.lastResult, 200);
  }
}

function saveSchedule() {
  writeJsonAtomic(SCHEDULE_FILE, {
    lastRunAt: schedState.lastRunAt,
    lastResult: schedState.lastResult,
    savedAt: new Date().toISOString()
  });
}

/** 下一次该跑的时间（用于界面显示）。 */
function nextRunAt() {
  const h = conf().collectEveryHours;
  if (!(h > 0)) return 0;
  return (schedState.lastRunAt || 0) + h * 3600_000;
}

/**
 * 跑一次定时收集：
 *   ① 先把**所有已知会话**的近期消息扫描一遍（不只是当前群），
 *      否则定时收集会变成"只收最后一个群"。
 *   因为 store 的遍历只在钩子里拿得到，这里用启动时缓存下来的实例。
 */
async function runScheduledCollection(reason = 'timer') {
  const c = conf();
  if (!c.enabled || !(c.collectEveryHours > 0)) return null;
  const store = runtimeStore;
  if (!store?.listChats) {
    schedState.lastResult = '跳过：还没有拿到聊天存档（等先有一次对话）';
    saveSchedule();
    return null;
  }
  loadSchedule();
  // 只统计**上次收集之后**的新消息：这样"每 12 小时一次"收的正是这 12 小时里
  // 大家用得最多的表情，而不是把同一批重复统计一遍。
  // 第一次跑（没有上次记录）就按配置的窗口回溯。
  const sinceTs = schedState.lastRunAt || (Date.now() - c.collectTopHours * 3600_000);
  const chatKeys = (store.listChats() || []).map((x) => (typeof x === 'string' ? x : x?.key || x?.chatKey)).filter(Boolean);
  let totalCollected = 0;
  const parts = [];
  for (const chatKey of chatKeys) {
    try {
      const r = await collectTopUsed({
        store,
        chatKey,
        hours: c.collectTopHours,
        limit: c.collectTopCount,
        sinceTs,
        maxCandidates: 400        // 定时任务跑得少，可以多统计一些候选
      });
      if (r.collected) totalCollected += r.collected;
      if (r.collected || r.candidates) {
        parts.push(`${chatKey}: 收 ${r.collected}（候选 ${r.candidates}）`);
      }
    } catch (error) {
      parts.push(`${chatKey}: 失败 ${error?.message ?? error}`);
    }
  }
  schedState.lastRunAt = Date.now();
  schedState.lastResult = `[${reason}] ${new Date().toLocaleString('zh-CN')} 共收 ${totalCollected} 张`
    + (parts.length ? `｜${parts.slice(0, 3).join('；')}${parts.length > 3 ? ` 等 ${parts.length} 个会话` : ''}` : '');
  saveSchedule();
  log(`定时收集完成（${reason}）：${schedState.lastResult}`);
  return totalCollected;
}

/** 启动定时检查（每 5 分钟看一眼是否到点；用"到点判断"而不是 setTimeout，重启不丢节奏）。 */
function startScheduleTimer() {
  stopScheduleTimer();
  loadSchedule();
  scheduleTimer = setInterval(() => {
    try {
      const c = conf();
      if (!c.enabled || !(c.collectEveryHours > 0)) return;
      const due = nextRunAt();
      if (due && Date.now() >= due) void runScheduledCollection('timer');
    } catch (error) {
      warn(`定时收集检查失败：${error?.message ?? error}`);
    }
  }, 5 * 60 * 1000);
  // 不阻止进程退出（Node 里定时器默认会 hold 住事件循环）
  if (typeof scheduleTimer.unref === 'function') scheduleTimer.unref();
}

function stopScheduleTimer() {
  if (scheduleTimer) { clearInterval(scheduleTimer); scheduleTimer = null; }
}

/**
 * "手动收集"按钮与定时任务**共用**的一段：遍历所有会话，按使用频率收集。
 * 定时的入口是 runScheduledCollection（内部调它），按钮的入口是 organizer 的 action 分支。
 */
function listKnownChats() {
  try {
    const store = runtimeStore;
    if (!store?.listChats) return [];
    return (store.listChats() || [])
      .map((x) => (typeof x === 'string' ? x : x?.key || x?.chatKey))
      .filter(Boolean);
  } catch { return []; }
}

/** 收集状态（给界面/接口看进度与上次结果）。 */
export function collectRunStatus() {
  return {
    running: collectRun.running,
    startedAt: collectRun.startedAt,
    finishedAt: collectRun.finishedAt,
    done: collectRun.done,
    considered: collectRun.considered,
    collected: collectRun.collected,
    result: collectRun.result,
    error: collectRun.error,
    everyHours: conf().collectEveryHours,
    windowHours: conf().collectTopHours,
    topCount: conf().collectTopCount,
    lastRunAt: schedState.lastRunAt,
    nextRunAt: nextRunAt(),
    lastResult: schedState.lastResult,
    chats: listKnownChats().length
  };
}

const collectRun = {
  running: false, startedAt: 0, finishedAt: 0, done: 0, considered: 0,
  collected: 0, result: '', error: '', last: null
};

/** 立刻跑一次"按频率收集"（手动按钮用；定时任务走 runScheduledCollection）。 */
export function startCollectRun(opts = {}) {
  if (collectRun.running) return { ok: false, error: '已经有一次收集在跑了，等它结束' };
  const c = conf();
  const hours = clamp(opts.hours, 1, 8760, c.collectTopHours);
  const limit = Math.round(clamp(opts.limit, 1, 60, c.collectTopCount));
  const chats = listKnownChats();
  if (!chats.length) {
    return { ok: false, error: '还没拿到聊天存档（先让机器人在群里说过一次话，或等它处理过一条消息）' };
  }
  collectRun.running = true;
  collectRun.startedAt = Date.now();
  collectRun.finishedAt = 0;
  collectRun.done = 0;
  collectRun.considered = chats.length;
  collectRun.collected = 0;
  collectRun.result = '';
  collectRun.error = '';

  Promise.resolve()
    .then(async () => {
      let total = 0;
      const parts = [];
      for (const chatKey of chats) {
        try {
          const r = await collectTopUsed({
            store: runtimeStore,
            chatKey,
            hours,
            limit,
            onProgress: () => { /* 进度按"第几个会话"记，见下面的 done += 1 */ }
          });
          total += r.collected;
          if (r.candidates) parts.push(`${chatKey} 候选${r.candidates}/收${r.collected}`);
        } catch (error) {
          parts.push(`${chatKey} 失败：${error?.message ?? error}`);
        }
        collectRun.collected = total;
        collectRun.done += 1;
      }
      collectRun.result = `按使用频率收集（最近 ${hours} 小时、每群最多 ${limit} 张，共 ${chats.length} 个会话）：`
        + `实际收进 ${total} 张。\n`
        + (parts.length ? parts.slice(0, 6).join('\n') : '窗口内没有可收的新表情。');
      schedState.lastRunAt = Date.now();
      schedState.lastResult = `[手动] ${new Date().toLocaleString('zh-CN')} 共收 ${total} 张`;
      saveSchedule();
    })
    .catch((error) => {
      collectRun.error = String(error?.message ?? error);
      collectRun.result = `收集失败：${collectRun.error}`;
    })
    .finally(() => {
      collectRun.running = false;
      collectRun.finishedAt = Date.now();
      collectRun.last = {
        at: collectRun.finishedAt,
        collected: collectRun.collected,
        result: collectRun.result,
        error: collectRun.error
      };
    });

  return { ok: true };
}


/**
 * 四档配图频率的自检：确认四档真的两两不同、数值合法、且档位判定有兜底。
 *
 * 为什么值得有：档位这种东西最容易"配了没生效"—— 表里写错一个字段名、
 * 或者某个档位的额度跟别的档位撞成一样，用户在界面上看不出来，只觉得"调了没用"。
 * 这里把它变成启动时看得见的一行。
 */
function selfCheckFrequency() {
  try {
    const names = Object.keys(FREQ_LEVELS);
    const problems = [];
    if (names.length !== 4) problems.push(`档位数量=${names.length}（应为 4）`);
    for (const n of names) {
      const v = FREQ_LEVELS[n];
      if (!v || !v.label || !v.prompt) problems.push(`${n} 缺 label/prompt`);
      if (!(v.perChatDaily >= 0)) problems.push(`${n} perChatDaily 非法`);
      if (!(v.minIntervalMin >= 0)) problems.push(`${n} minIntervalMin 非法`);
      if (!(v.chance > 0 && v.chance <= 1)) problems.push(`${n} chance 必须在 (0,1]`);
    }
    // 四档必须两两不同：额度或间隔至少有一个不一样，否则"调档"就是空操作
    const sig = names.map((n) => `${FREQ_LEVELS[n].perChatDaily}/${FREQ_LEVELS[n].minIntervalMin}/${FREQ_LEVELS[n].chance}`);
    if (new Set(sig).size !== names.length) problems.push(`有档位参数完全相同：${sig.join(' ')}`);
    // 档位判定必须兜底到默认档，绝不能返回 undefined
    if (!levelOf('不存在的档')) problems.push('未知档位没有兜底');
    if (!levelOf(conf().stickerFrequency)) problems.push('当前配置的档位无法解析');

    const brief = names.map((n) => {
      const v = FREQ_LEVELS[n];
      return `${v.label}=${v.perChatDaily || '∞'}张/${v.minIntervalMin || '∞'}分${v.perMinute ? `/${v.perMinute}张每分` : ''}/${v.chance}`;
    }).join('  ');
    appendSelfCheck(problems.length
      ? `配图频率自检 FAIL：${problems.join('；')}`
      : `配图频率自检 PASS：${brief}｜当前=${levelOf(conf().stickerFrequency).label}`);
    selfCheckColdStart();
  } catch (error) {
    appendSelfCheck(`配图频率自检异常：${error?.message ?? error}`);
  }
}

/**
 * 冷启动自检：库里"已认识 / 未认识"各有多少，以及批量认识是否真的挑得出图。
 *
 * 为什么值得测：实测发现配图不活跃的根因不在频率，而在"库里 22 张只有 2 张有标签"——
 *   模型每轮只看到那两张，`freqBlocked=0`（连想发都没想过）。这条自检把
 *   "可用的图有多少"变成启动时看得见的一行，避免以后又把这个瓶颈当成频率问题去查。
 */
function selfCheckColdStart() {
  try {
    const l = loadLib();
    const known = l.items.filter((it) => (it.tags && it.tags.length) || it.note).length;
    const picks = pickUntagged(6);
    appendSelfCheck(`冷启动自检：库内 ${l.items.length} 张，已认识 ${known} 张，未认识 ${l.items.length - known} 张`
      + `｜批量认识一次可挑出 ${picks.length} 张（示例 ${picks.map((it) => `#${shortId(it)}`).join(' ') || '无'}）`);
  } catch (error) {
    appendSelfCheck(`冷启动自检异常：${error?.message ?? error}`);
  }
}

// ─────────────────────────────────────────────── 收录时识图（B 方案）
//
// 用户要求：**收录的时候就把图上的文字一并记下来**。
// 代价是每张新收的图多一次视觉调用 —— 这是明知的选择（换来"文字最全、最及时"）。
//
// 几个必须处理好的点：
//   ① **不能阻塞采集队列** —— 它在后台跑，收集本身照常（钩子的 5 秒超时也不受影响）。
//   ② **失败不能算"认不出"** —— tagFails 是「整理」用来判定删除的计数器，
//      收录时识图失败（网络抖动/额度）不该让一张好图被删掉，所以这里不碰它。
//   ③ **必须有预算上限** —— 24 小时最多识图 N 张，防某天狂收图烧穿额度。
//   ④ 识图结果只填空：已经有标签/备注的（比如模型自己刚写过）不覆盖。

let ingestVisionQueue = [];
let ingestVisionRunning = false;
let visionDay = '';
let visionUsedToday = 0;

function visionBudgetLeft() {
  const c = conf();
  const today = todayKey();
  if (visionDay !== today) { visionDay = today; visionUsedToday = 0; }
  if (!(c.recognizeIngestBudget > 0)) return 0;
  return Math.max(0, c.recognizeIngestBudget - visionUsedToday);
}

/** 把刚收进来的图交给模型看一遍，记下文字与适用场合（后台跑，不阻塞）。 */
function recognizeOnIngest(item) {
  try {
    const c = conf();
    if (!c.enabled || !c.recognizeOnIngest) return;
    if (!item?.path) return;
    if (visionBudgetLeft() <= 0) return;   // 今日额度用完 → 留给「整理」去补
    ingestVisionQueue.push(item.key);
    void drainIngestVision();
  } catch (error) {
    warn(`收录识图入队失败（不影响收录）：${error?.message ?? error}`);
  }
}

async function drainIngestVision() {
  if (ingestVisionRunning) return;
  ingestVisionRunning = true;
  try {
    while (ingestVisionQueue.length) {
      const key = ingestVisionQueue.shift();
      if (visionBudgetLeft() <= 0) { ingestVisionQueue = []; break; }
      const l = loadLib();
      const it = l.items.find((x) => x.key === key);
      if (!it?.path) continue;
      // 已经有标签或备注的跳过（可能模型刚写过，别覆盖人家的理解）
      if ((it.tags && it.tags.length) || it.note) continue;
      try {
        const res = await recognizeBatch([it], { maxDim: 224 });   // 单张、尺寸压小：只为读文字+定场合
        visionUsedToday += 1;
        const r = Array.isArray(res) ? res[0] : null;
        if (r && !r.skip) {
          const tags = Array.isArray(r.tags) ? r.tags.map(normalizeTag).filter(Boolean).slice(0, MAX_TAGS) : [];
          const note = clean(r.note, MAX_NOTE_CHARS);
          const text = clean(r.text, MAX_TEXT_CHARS);
          if (tags.length) it.tags = [...new Set([...it.tags, ...tags])].slice(0, MAX_TAGS);
          if (note && !it.note) it.note = note;
          // 文字是这次的主要目标：记下来，以后能按关键词挑图
          if (text) it.text = text;
          if (tags.length || note || text) {
            it.source = 'model';
            it.tagTriedAt = Date.now();
            it.usedAt = it.usedAt || 0;
            libDirty = true;
            flushLib(true);
            log(`收录识图：#${shortId(it)}${text ? ` 文字「${text}」` : ''}${tags.length ? ` 标签[${tags.join('/')}]` : ''}`);
          }
        }
      } catch (error) {
        // 失败只记日志：**绝不能**动 tagFails（那是"整理"用来判删的计数器）
        warn(`收录识图失败（不影响收录，稍后可用「整理」补）：${error?.message ?? error}`);
        ingestVisionQueue = [];   // 多半是密钥/网络问题，别继续撞
        break;
      }
      await new Promise((r) => setTimeout(r, 300));   // 轻微间隔，别把接口打满
    }
  } finally {
    ingestVisionRunning = false;
  }
}

/**
 * 把"收录时识图"的进度说清楚（给界面/日志用）。
 */
function ingestVisionStatus() {
  return { queued: ingestVisionQueue.length, running: ingestVisionRunning, usedToday: visionUsedToday, budget: conf().recognizeIngestBudget };
}

/**
 * 把自检结果单独写一个文件。
 * 为什么不用日志：加载路径上的日志通道时有时无（这台机器上 setup 里的 log/warn
 * 都没落到日志文件），而自检结果必须能被看到才有意义。写文件是最可靠的。
 */
function writeSelfCheck(text) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(path.join(DIR, 'selfcheck.log'), `${text}\n`, 'utf8');
  } catch { /* 写不了就算了，不能因此影响加载 */ }
}

// ─────────────────────────────────────────────── 后台采集队列

const queue = [];
const queueKeys = new Set();
let draining = false;

function enqueue(job) {
  if (queueKeys.has(job.key)) return false;
  if (queueKeys.size >= 40) queueKeys.delete(queueKeys.values().next().value);   // 防长跑内存增长
  queueKeys.add(job.key);
  queue.push(job);
  void drain();
  return true;
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      try {
        await ingest(job);
      } catch (error) {
        warn(`收录失败（不影响对话）：${error?.message ?? error}`);
      }
      // 每张之间留个间隔：这是后台活，别和正在进行的对话抢网络
      if (queue.length) await new Promise((r) => setTimeout(r, QUEUE_INTERVAL_MS));
    }
  } finally {
    draining = false;
  }
}

/** 真正入库：下载 → 认格式 → 算哈希去重 → 落盘 → 建索引 → 超限淘汰。 */
async function ingest(job) {
  const c = conf();
  if (!c.enabled) return;
  const maxBytes = Math.min(HARD_MAX_ITEM_BYTES, Math.round(c.maxItemMb * 1048576));

  // 已经按"file 键"在库里了：连下载都省了 —— 这是最常见的重复路径
  if (job.file && findItem(`file:${String(job.file).toLowerCase()}`)) {
    lib.counters.duplicates += 1;
    libDirty = true;
    return;
  }

  const buf = await fetchImageBytes(job.media, maxBytes);
  if (!buf || !buf.length) {
    lib.counters.failed += 1;
    libDirty = true;
    warn(`这张图取不到字节，已跳过（可能是一次性链接或已过期）：${clean(job.media?.url || job.media?.file, 80)}`);
    return;
  }
  if (buf.length > maxBytes) return;

  const ext = sniffImage(buf) || extFromName(job.media?.url) || extFromName(job.media?.file);
  if (!ext) {
    lib.counters.skipped += 1;
    libDirty = true;
    return;
  }

  const src = sha1(buf);
  const dup = findBySrc(src);
  if (dup) {                                // ← 去重的核心：同一张内容只存一份
    if (job.file && !dup.file) { dup.file = clean(job.file, 120); libDirty = true; }
    if (job.chatKey && !dup.chatKey) { dup.chatKey = clean(job.chatKey, 60); libDirty = true; }
    lib.counters.duplicates += 1;
    libDirty = true;
    return;
  }

  const file = `${src.slice(0, 16)}.${ext}`;
  const dest = path.join(IMG_DIR, file);
  try {
    fs.mkdirSync(IMG_DIR, { recursive: true });
    if (!fs.existsSync(dest)) fs.writeFileSync(dest, buf);
  } catch (error) {
    lib.counters.failed += 1;
    warn(`图片落盘失败：${error?.message ?? error}`);
    return;
  }

  addItem({
    key: `src:${src}`,
    src,
    file: clean(job.file, 120),
    path: dest,
    bytes: buf.length,
    ext,
    tags: [],
    note: '',
    text: '',
    // 「来源上下文」：收它的时候群里在聊什么 —— 不花 token 就能推断它适合什么场合。
    srcHint: clean(job.srcHint, 120),
    source: 'observed',
    chatKey: clean(job.chatKey, 60),
    chatName: clean(job.chatName, 60),
    createdAt: Date.now(),
    usedAt: 0,
    useCount: 0,
    sentCount: 0,
    sources: [clean(job.source, 60) || '群聊'],
    tagFails: 0,
    tagTriedAt: 0,
    tagFp: '',
    ...mediaMeta(buf, ext)
  });
  lib.counters.collected += 1;
  evictIfNeeded();
  libDirty = true;
  flushLib(true);
  const it = findBySrc(src);
  log(`偷到一张新表情（库内 ${lib.items.length} 张，${humanMb(totalBytes())}）：${file}${it?.animated ? `｜动图 ${it.gifFrames} 帧 ${it.gifDurationSec}s` : ''}`);
  // 收录时立刻识图（用户要求 B 方案）：把图上的文字 + 适用场合记下来。
  // 放后台跑，不阻塞采集队列 —— 收集照常，识图慢慢补。
  if (it) recognizeOnIngest(it);
}

/**
 * 入库时算一次元信息。GIF 只走块扫描（不解码像素），所以又快又安全。
 * 存下来是为了：① 挑图时能告诉模型"这是动图、多少帧"；② 顺便记下动图的尺寸与时长。
 */
function mediaMeta(buf, ext) {
  const base = { animated: false, gifFrames: 1, gifDurationSec: 0, gifWidth: 0, gifHeight: 0 };
  if (ext !== 'gif') return base;
  const info = gifInfo(buf);
  if (!info) return base;
  return {
    animated: info.animated,
    gifFrames: info.frames,
    gifDurationSec: info.durationSec,
    gifWidth: info.width,
    gifHeight: info.height
  };
}

// ─────────────────────────────────────────────── 表情包判定

/** 摘要里出现这些词 → 这张图就是表情包（与核心 segmentsToText 的用词一致）。 */
const STICKER_SUMMARY = /(动画表情|表情包|表情)/;
const PHOTO_SUMMARY = /(图片|照片|截图|文件|视频)/;

function isImageMedia(m) {
  return !!m && (m.kind === 'image' || m.kind === 'sticker');
}

/**
 * 保守判定"这张图是不是表情包"。
 * 判错方向的代价不对称：把照片当表情包收进来，只是库里多一张没用的图；
 * 把表情包当照片漏掉，才是这个功能失效。所以这里偏宽松，只在**明确像照片/截图**
 * 时才排除（最终拦截交给"取不到字节就不入库"以及模型不看它）。
 */
function isLikelySticker(m) {
  if (!m) return false;
  if (m.kind === 'sticker') return true;
  const summary = String(m.summary || m.text || '');
  if (STICKER_SUMMARY.test(summary)) return true;
  if (PHOTO_SUMMARY.test(summary)) return false;
  const name = String(m.file || m.url || '');
  return /\.(gif)(\?|$)/i.test(name);        // 没线索时：动图多半是表情
}

function mediaKeyOf(m) {
  const src = clean(m?.hash || m?.sha1 || '', 64);
  if (src) return `src:${src}`;
  const file = clean(m?.file, 120);
  if (file) return `file:${file.toLowerCase()}`;
  return '';
}

// ─────────────────────────────────────────────── 发送额度

function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 现在能不能配图？返回 { ok, reason, waitSec }。
 *
 * 判定顺序（从"最硬的约束"到"最软的引导"）：
 *   ① 全局每日上限        —— 防止整体刷屏
 *   ② 全局最小间隔        —— 防止跨群连续发
 *   ③ 本会话最小间隔      —— 防止同一个群连发
 *   ④ 本会话每日上限      —— 四档频率的"体感"主要靠它（按群算，A 群热闹不吃 B 群额度）
 *
 * @param {object} opts { explicit } explicit=true 表示"群友点名要图"（当前不影响判定，
 *                     保留参数只为调用处语义清晰）。
 */
/**
 * 现在能不能配图？返回 { ok, reason, waitSec }。
 *
 * ⚠️ 这里**只剩用户自己指定的硬上限**，概率性的"机制"全部撤掉了
 *    （档位概率、"值不值得发"、发言计数器强制 —— 用户明确说"不要这种硬性机制"）。
 *
 * 判定顺序：
 *   ① 全局每日上限        —— 用户设置，默认 0（不限）
 *   ② 全局最小间隔        —— 用户设置，默认 0（不限）
 *   ③ 本会话最小间隔      —— 用户设置，默认 0（不限）
 *   ④ 档位额度 + 活跃度缩放 —— 用户自己定的四档（很少15/偶尔30/一般每分钟2/经常不限）
 *   之后**一律放行**。
 *
 * 那"发不发、发哪张"靠什么决定？
 *    · 发不发：模型按提示词自己判断（它愿意发就发）
 *    · 发哪张：**奖励评分排序**（scoreSticker：语境相关性 C、期望互动 I、新颖度 N、
 *      使用均衡度 D）—— 好图排前面，但没有任何一张被禁止。
 */
function sendGate(chatKey, _opts = {}) {
  const c = conf();
  const l = loadLib();
  const now = Date.now();
  const lvl = levelOf(c.stickerFrequency);
  const st = chatStat(l, chatKey);

  if (l.sentDay !== todayKey()) { l.sentDay = todayKey(); l.sentToday = 0; libDirty = true; }
  if (c.sendDailyLimit > 0 && l.sentToday >= c.sendDailyLimit) {
    return { ok: false, reason: `频率限制：今天全局已发满 ${c.sendDailyLimit} 张（全局上限）。图没坏，用文字回应即可。` };
  }
  if (c.sendGlobalIntervalSec > 0 && l.lastGlobalSendAt) {
    const left = c.sendGlobalIntervalSec * 1000 - (now - l.lastGlobalSendAt);
    if (left > 0) return { ok: false, reason: `频率限制：距上次发图仅 ${Math.round((now - l.lastGlobalSendAt) / 1000)} 秒（全局间隔 ${c.sendGlobalIntervalSec} 秒）。图没坏，用文字回应即可。`, waitSec: Math.ceil(left / 1000) };
  }
  if (c.sendMinIntervalSec > 0 && l.lastSendAt) {
    const left = c.sendMinIntervalSec * 1000 - (now - l.lastSendAt);
    if (left > 0) return { ok: false, reason: `频率限制：本会话 ${Math.round((now - l.lastSendAt) / 1000)} 秒前刚发过（间隔要求 ${c.sendMinIntervalSec} 秒）。图没坏，用文字回应即可。`, waitSec: Math.ceil(left / 1000) };
  }

  // ── 四档频率：按会话，且**按活跃度缩放** ──
  // 用户要求"活跃度越高发得越集中"：热闹时额度放宽、间隔缩短；冷清时收紧、拉长。
  const activity = activityOf(chatKey);
  const lim = effectiveLimits(lvl, activity);
  if (st) {
    if (lim.daily > 0 && st.sentToday >= lim.daily) {
      return {
        ok: false,
        reason: `频率限制：本会话今天已发 ${st.sentToday} 张（档位「${lvl.label}」在「${activity.label}」活跃度下按群上限 ${lim.daily} 张）。`
          + '**图没坏、能发**，只是额度用完了 —— 用文字回应即可，不要编技术原因。'
      };
    }
    if (lim.intervalMin > 0 && st.lastAt) {
      const left = lim.intervalMin * 60000 - (now - st.lastAt);
      if (left > 0) {
        return {
          ok: false,
          reason: `这个会话 ${Math.round((now - st.lastAt) / 60000)} 分钟前刚配过图`
            + `（档位「${lvl.label}」+ 活跃度「${activity.label}」要求间隔 ${lim.intervalMin} 分钟），改用文字回应`,
          waitSec: Math.ceil(left / 1000)
        };
      }
    }
    // 「每分钟最多 N 张」—— 用户给"一般"档定的硬上限（经常档是 0 = 不限）。
    // 用 sliding window：数最近 60 秒内发过几张。
    if (lim.perMinute > 0) {
      const recent = Array.isArray(st.recentAt) ? st.recentAt.filter((t) => now - num(t, 0) < 60000) : [];
      if (recent.length >= lvl.perMinute) {
        const oldest = Math.min(...recent);
        return {
          ok: false,
          reason: `频率限制：档位「${lvl.label}」每分钟最多 ${lim.perMinute} 张，这一分钟已经发满 ${recent.length} 张了。用文字回应即可（等约 ${Math.ceil((60000 - (now - oldest)) / 1000)} 秒后可再发）。`,
          waitSec: Math.ceil((60000 - (now - oldest)) / 1000)
        };
      }
    }
  }
  // ── 概率闸门已按用户要求撤掉（2026-10-11）──
  //   · 档位概率闸门（lvl.chance）：删了
  //   · "值不值得发"的 45% 闸门（sendChanceOnPlain）：删了
  //   · 发言计数器强制轮换（stickerEveryNthReply）：删了
  //
  // 用户明确说"不要这种硬性机制"。撤掉后**这里不再因为概率拒绝任何一次发图** ——
  // 只剩真正的硬上限（每日额度 / 同群间隔 / 每分钟张数 / 全局额度）会拦，
  // 那些是用户自己指定的档位边界，不是"机制"。
  //
  // 那"它到底发不发、发哪张"靠什么？靠**奖励评分排序**（scoreSticker）：
  // 语境相关性、期望互动、新颖度、使用均衡度 —— 好图自然排前面，
  // 模型从候选里挑；而"发不发"由它自己按提示词判断。
  // 也就是说：**从"概率决定"改成"评分引导"**，不再有随机拦人。
  return { ok: true };
}

/**
 * 轮换方式：**软性排序**（不做任何禁止）。
 *
 * 用户明确要求"不要设置这种冷却" —— 所以这里不再有任何"发过的图不许再发"的硬阻断。
 * 轮换改由**排序**实现：发过的、发得多的自动排到候选后面（见 itemScore 的耗尽惩罚），
 * 模型优先看到的就是没发过的图；但它**随时可以发任何一张**，不会被拒绝。
 *
 * 为什么原来要做硬阻断、现在可以撤掉：
 *    硬阻断是为了压住"标签语义最强的那张"被反复选。但那个问题的根源其实是
 *    **能判断的图太少**（库里 93 张只有 5 张有标签）。现在两条都补上了：
 *      ① 收录时就识图 → 新图自动带标签和文字，可判断的池子会持续变大；
 *      ② itemScore 的耗尽惩罚 → 发过的图分数掉到 −50、−150…，自然让位。
 *    排序足够时，硬阻断就只剩副作用了（把"想发"变成"被拒"，用户看着像坏了）。
 */
/**
 * 记账："这个会话刚发了哪一张"。
 *
 * `itemKey` 用于维护**最近 N 次发过的编号**窗口（挑选时先排除它们）。
 * 窗口只在这里追加，挑选时读 —— 这就是用户方案里"先排除最近 5 次用过的"的落地。
 */
function markSent(chatKey, itemKey = '') {
  const l = loadLib();
  const now = Date.now();
  if (l.sentDay !== todayKey()) { l.sentDay = todayKey(); l.sentToday = 0; }
  l.lastSendAt = now;
  l.lastGlobalSendAt = now;
  l.sentToday += 1;
  l.sentTotal += 1;
  l.counters.sent += 1;
  const st = chatStat(l, chatKey);
  if (st) {
    st.lastAt = now;
    st.sentToday += 1;
    st.sentTotal += 1;
    if (itemKey) {
      st.recentIds.push(itemKey);
      // 只留最近 RECENT_EXCLUDE 个（多留 2 个做缓冲，便于排障时看历史）
      while (st.recentIds.length > RECENT_EXCLUDE + 2) st.recentIds.shift();
    }
    // 记发送时间戳（保留最近 5 分钟，供"每分钟最多 N 张"判定）
    if (!Array.isArray(st.recentAt)) st.recentAt = [];
    st.recentAt.push(now);
    while (st.recentAt.length && now - st.recentAt[0] > 300000) st.recentAt.shift();
    if (st.recentAt.length > 100) st.recentAt = st.recentAt.slice(-100);
  }
  libDirty = true;
  flushLib(true);
}

/**
 * 解析出这个会话的键，供按群记账使用。
 *
 * ⚠️ 必须兜底：ctx.chatKey 在个别工具调用里可能是空的，而 chatStat('') 会返回 null
 * → **记账静默丢失**（表现为全局 sent 涨了、按群统计却一条都没有，我实测踩到过）。
 * 依次回退：ctx.chatKey → session.chatKey → 用 kind+chatId 拼。
 */
function resolveChatKey(ctx) {
  const direct = String(ctx?.chatKey || '').trim();
  if (direct) return direct;
  const fromSession = String(ctx?.session?.chatKey || '').trim();
  if (fromSession) return fromSession;
  const kind = String(ctx?.kind || '').trim();
  const id = String(ctx?.chatId || '').trim();
  return (kind && id) ? `${kind}:${id}` : '';
}

/** 给模型看的"当前档位 + 这个会话还剩多少额度"。 */
function freqBrief(chatKey) {
  const c = conf();
  const l = loadLib();                 // ← 漏过这一行：freqBrief 一被调用就 ReferenceError
  const lvl = levelOf(c.stickerFrequency);
  const st = chatStat(l, chatKey);
  const used = st ? st.sentToday : 0;
  // 按活跃度缩放后的**实际**额度（与 sendGate 同一套算法，绝不两处各写一份）
  const activity = activityOf(chatKey);
  const lim = effectiveLimits(lvl, activity);
  const left = lim.daily > 0 ? Math.max(0, lim.daily - used) : Infinity;
  const cap = lim.daily > 0 ? `${left}/${lim.daily}` : '不限';
  const ago = st && st.lastAt ? `，距上次 ${Math.round((Date.now() - st.lastAt) / 60000)} 分钟` : '';
  return `档位「${lvl.label}」+ 活跃度「${activity.label}」`
    + `（最近 ${ACTIVITY_WINDOW_MIN} 分钟群里 ${activity.count} 条消息；本会话今天已配 ${used} 张，剩 ${cap}${ago}）`;
}

/**
 * 挑选一批"还没认识"的表情，用于批量认识（review_stickers）。
 *
 * 为什么需要它（这是实测出来的最大瓶颈）：
 *   库里 22 张，只有 2 张有标签/备注。而选图规则要求"有备注、能对上语境才发"——
 *   于是模型反复只看到那 2 张，`freqBlocked=0` 说明它连"想发"都没想过。
 *   这就是冷启动死锁：**打标签依赖用到它，用到它又依赖有标签**。
 *   解法是给一条批量认识的路：一次看多张，只给有把握的写标签。
 *   比逐张 look 省得多（一次请求 vs N 次），也不违反"看图按需"。
 */
function pickUntagged(limit = 6, onlyAnimatedUnseen = false) {
  const l = loadLib();
  const pool = l.items.filter((it) => it.path
    && (!it.tags || !it.tags.length) && !it.note
    && (!onlyAnimatedUnseen || (it.animated && !it.framesReady)));
  // 优先"已经被看过但还没写标签"的（信息已在手边，问了也白问），
  // 其余按"最近偷到的"排（新鲜的梗更有用）
  return pool
    .sort((a, b) => (b.viewedAt || 0) - (a.viewedAt || 0) || b.createdAt - a.createdAt)
    .slice(0, Math.max(1, limit));
}

// ─────────────────────────────────────────────── 挑图 / 上下文文本

/**
 * 候选打分。
 *
 * ⚠️ 这里曾经有一个**恶性循环**，是"总是发同一张图"的根因（实测：一张图被发了 21 次）：
 *    原式 = 发送次数×10 + 使用次数×3 − 距今天数
 *    → 发得越多分越高 → 越容易被挑中 → 再发一次 → 分更高……自我强化。
 *    于是模型每轮看到的永远是那张"最热"的图。
 *
 * 修法：把"发送次数"的正权重改成**耗尽惩罚** —— 发得越多分越低，冷却期过了才慢慢回来。
 *    这样它被迫轮换，而不是把同一张图刷到烂。
 *    效果：3 次以内基本无感，发到第 21 次时分数已降到 −100，天然让位给没发过的图。
 *
 * @param {number} penalty 耗尽惩罚的强度（留参数是为了让测试能对比新旧行为）
 */
function itemScore(it, penalty = 25) {
  const now = Date.now();
  const used = (it.sentCount || 0) + (it.useCount || 0);
  const lastUsed = now - (it.usedAt || 0);
  // 新鲜度：入库越久越不值钱（保留原有设计）
  const fresh = -(now - (it.createdAt || now)) / DAY_MS;
  // 耗尽：用得越多扣得越狠；但隔得越久惩罚越弱（24 小时后基本恢复）
  const tired = used > 0 ? penalty * used * Math.max(0, 1 - lastUsed / DAY_MS) : 0;
  return fresh - tired;
}

/**
 * 从库里挑候选：优先情绪标签命中，其次关键词命中（标签/备注/图上文字）。
 * 没给条件时：优先"最近偷到的"（新鲜的梗）并带一点随机，避免每次都发同一张。
 */
function pickCandidates({ mood = '', keyword = '', limit = 3, chatKey = '' } = {}) {
  const l = loadLib();
  // 排除「无意义」的图：它们是整理时判定"看不出内容"的，
  // 既不该发出去，也不该占候选位（挑图列表是模型唯一的选择来源）。
  let items = l.items.filter((it) => it.path && !isMeaningless(it));
  if (!items.length) return [];
  // 自愈：文件已经不在库里的条目（磁盘被清过、误删、搬家）直接跳过并清出索引。
  // ⚠️ 这是真实踩到的问题：有张"发过 21 次"的图文件丢了、索引还在，
  //    于是它每次被挑中都会发送失败 —— 而且因为发送计数高，它总被排在前列。
  //    不清掉就会一直卡在那里，看起来像"发表情老是失败"。
  const dead = items.filter((it) => !fs.existsSync(it.path));
  if (dead.length) {
    for (const it of dead) {
      warn(`库里这张图的文件已丢失，已清出索引：#${shortId(it)}（${it.path}）`);
      removeItem(it.key);
    }
    items = items.filter((it) => !dead.includes(it));
    if (!items.length) return [];
  }
  // ── 选图：按用户给的方案 ──
  //   ① 先排除**最近 5 次用过的**（"刚发过"的不要再发）
  //   ② 对剩余候选算 S = 0.6C + 0.25N + 0.15D
  //   ③ 按 S 加权随机抽取（不是永远取最高分 —— 那样又会变成"总是那几张"）
  //   ④ 候选被排空了就**放宽限制**（去掉排除重来），绝不返回空
  const recent = Array.isArray(chatStat(l, chatKey)?.recentIds) ? chatStat(l, chatKey).recentIds : [];
  const recentSet = new Set(recent);
  const totalSent = l.sentTotal || 0;

  // 语境文字（最近聊天内容）：用于 C 里"这个梗正在聊"的加分。
  const ctx = { mood, keyword, recentText: '' };
  try {
    const store = runtimeStore;
    if (store?.recent && chatKey) {
      const rs = store.recent(chatKey, { limit: 12, includeSelf: false }) || [];
      ctx.recentText = rs.map((e) => clean(e?.text, 60)).filter(Boolean).join(' ').slice(0, 600);
    }
  } catch { /* 取不到聊天内容就只用 mood/keyword */ }

  const notRecent = items.filter((it) => !recentSet.has(it.key));
  const pool = notRecent.length ? notRecent : items;        // ④ 放宽限制

  const scored = pool.map((it) => {
    // 总分 = 0.10C + 0.25·期望互动 + 0.25N + 0.15D（权重已在 scoreSticker 里归一化；
    // E 不参与选图，见奖励系统注释）
    const { S, C, I, N, D } = scoreSticker(it, ctx, totalSent);
    return { it, score: S, C, I, N, D };
  });
  scored.sort((a, b) => b.score - a.score);

  // ③ 加权随机抽取（填满 limit 为止，不放回）
  const picked = [];
  const rest = [...scored];
  while (picked.length < Math.max(1, limit) && rest.length) {
    const chosen = weightedPick(rest, (x) => x.score);
    const idx = rest.indexOf(chosen);
    rest.splice(idx, 1);
    picked.push(chosen);
  }
  // 把评分附在结果上（排障用：一眼看出这次为什么挑了它）
  for (const p of picked) p.it.__lastScore = { S: Number(p.score.toFixed(3)), C: Number(p.C.toFixed(2)), I: Number(p.I.toFixed(2)), N: Number(p.N.toFixed(2)), D: Number(p.D.toFixed(2)) };
  return picked.map((p) => p.it);
}

function oneLine(it, idx, withText) {
  const bits = [];
  // 动图要标明帧数与"看没看过"，但**不能让它显得像障碍**：
  // 抽帧只影响"模型知不知道它画的是什么"，不影响能不能发（发送直传原文件）。
  if (it.animated) {
    bits.push(it.framesReady
      ? `动图${it.gifFrames}帧/已看过`
      : `动图${it.gifFrames}帧（可直接发）`);
  } else if (it.ext) {
    bits.push(it.ext.toUpperCase());
  }
  if (it.tags.length) bits.push(`标签：${it.tags.join('/')}`);
  if (it.note) bits.push(it.note);
  if (withText && it.text) bits.push(`图上文字：「${it.text}」`);
  if (it.sentCount) bits.push(`发过${it.sentCount}次`);
  return `${idx + 1}. #${shortId(it)} ${bits.join('｜') || '（还没打标签）'}`;
}

// ─────────────────────────────────────────────── 权限判定

/**
 * 能不能改标签/删表情。
 * 顺序：主人能力（软依赖，没装就跳过）→ 配置里的授权号 → 群主/群管理员。
 * 群身份查不到时**保守拒绝**——写操作判错方向的代价更大，所以查询失败一律返回 false。
 */
async function canAdmin(ctx, args) {
  const c = conf();
  if (!c.adminOnly) return true;
  const uid = String(args?.userId || ctx?.session?.senderId || '').trim();
  if (uid && adminIdSet().has(uid)) return true;
  if (uid && String(uid) === String(ctx?.selfId || '')) return false;   // 机器人不算管理员

  // 主人能力（owner-identity 插件提供；没装时返回 undefined）
  try {
    const fn = apiRef?.capability?.('message.owner-check');
    if (typeof fn === 'function') {
      const r = fn({ requireAll: true, userId: uid, kind: ctx?.kind, chatId: ctx?.chatId, selfId: ctx?.selfId });
      if (r && typeof r === 'object' && r.persona) return true;
    }
  } catch { /* 能力缺失/抛错 → 继续往下判 */ }

  if (ctx?.kind === 'group' && uid && onebotRef?.call) {
    try {
      const info = await onebotRef.call('get_group_member_info', {
        group_id: Number(ctx.chatId),
        user_id: Number(uid),
        no_cache: false
      });
      const role = String(info?.role || '');
      if (role === 'owner' || role === 'admin') return true;
    } catch (error) {
      warn(`查群身份失败，按"无权限"处理：${error?.message ?? error}`);
    }
  }
  return false;
}

// ─────────────────────────────────────────────── 工具

function ok(content, extra = {}) {
  return { content, ...extra };
}

function err(content) {
  return { content, isError: true };
}

/** 把异常的堆栈也带上（排错时只有一句话根本定位不到行号，吃过这个亏）。 */
function errDetail(prefix, error) {
  const msg = `${prefix}${error?.message ?? error}`;
  const stack = String(error?.stack || '').split('\n').slice(0, 3).join(' | ');
  return { content: stack ? `${msg}［${stack}］` : msg, isError: true };
}

/**
 * 记住这次执行拿到的运行期对象。
 *
 * 为什么需要：钩子的载荷里没有 onebot（只有公共 skillContext），而**工具**的
 * ctx 里有完整的 onebot/sender。收图发生在后台（before-context 之后的 drain），
 * 那时离上一次工具执行可能已经过了很久 —— 所以只要有工具跑过就把引用存下来，
 * 给 `get_image` 那条兜底路径用。存的是核心的客户端实例，长期有效。
 */
function rememberRuntime(ctx) {
  try {
    if (ctx?.onebot) onebotRef = ctx.onebot;
    if (ctx?.sender) senderRef = ctx.sender;
  } catch { /* 拿不到就算了 */ }
}

/** 组装一个 image_url 部件（模型看图必须走 parts，不能把 base64 拼进文本）。 */
function imagePart(dataUrl) {
  return { type: 'image_url', image_url: { url: dataUrl } };
}

/**
 * 把库里的图组装成"给模型看"的 parts。
 *
 * ⚠️ 这里是与核心 gif-to-video 的分工：核心那条路要 ffmpeg（本机没有），
 *    所以动图由本插件自己抽帧成多张静态图 —— 对**任何**视觉模型都成立，
 *    不依赖视频部件，也不会因为端点不支持 video_url 而整轮失败。
 *
 * 记账：看完把 framesReady / viewedAt / viewCount 写进索引。这既让"已看过的动图"
 * 不必重复抽帧，也让挑图时能优先推荐已经看明白的图。
 */
function buildLookResult(item, buf, want) {
  const ext = sniffImage(buf) || item.ext;
  const head = `表情包 #${shortId(item)}`;

  if (ext === 'gif') {
    const info = gifInfo(buf) || {};
    const animated = (info.frames || 1) > 1;
    if (!animated) {
      return finishLook(item, {
        content: [{ type: 'text', text: `${head}：静态 GIF（只有 1 帧），下面是画面。看完用 tag_sticker 记下理解。` }, imagePart(`data:image/gif;base64,${buf.toString('base64')}`)]
      }, 1);
    }
    const frames = extractGifFrames(buf, want);
    if (!frames.length) {
      // 抽帧失败（画布过大/坏流）：退回整图，并如实说明只可能是第一帧
      return finishLook(item, {
        content: [{
          type: 'text',
          text: `${head}：这是一张**动图（GIF，共 ${info.frames || '多'} 帧）**，但这次没能抽出多帧画面（可能尺寸过大或文件异常）。`
            + '下面这张只有可能显示第一帧 —— 后几帧的内容你**看不到**，所以不要断言图里没有别的动作或文字，拿不准就少下结论。'
        }, imagePart(`data:image/gif;base64,${buf.toString('base64')}`)]
      }, 1);
    }
    const parts = [{
      type: 'text',
      text: `${head}：这是一张**动图**（GIF，共 ${info.frames} 帧、约 ${info.durationSec}s、${info.width}×${info.height}${info.loop ? `、循环 ${info.loop} 次` : ''}）。`
        + `下面按顺序给了 ${frames.length} 张画面（第 ${frames.map((f) => f.index).join('、')} 帧），**连起来看才是完整的表情**：`
        + '注意动作变化、表情从哪一帧变到哪一帧、以及后半段才出现的文字。判断含义时以整段动作为准，不要只按第一帧下结论。'
    }];
    for (const f of frames) parts.push(imagePart(f.dataUrl));
    parts.push({ type: 'text', text: '看完请用 tag_sticker 记下：note 写"画面动作 + 适合什么场合"，text 写图上的文字。' });
    return finishLook(item, { content: parts }, frames.length);
  }

  // 静态图（png/jpg/webp/bmp）：原图即可，模型自己看得懂
  const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
  return finishLook(item, {
    content: [{
      type: 'text',
      text: `${head}：静态图片${item.note ? `（已有说明：${item.note}）` : ''}。看完用 tag_sticker 写下理解，**并把图上的文字记进 text**（一个字也别漏，没有就留空）。`
    }, imagePart(`data:${mime};base64,${buf.toString('base64')}`)]
  }, 1);
}

/** 记一次"看过"，并把结果里补上给模型的收尾说明。 */
function finishLook(item, result, frameCount) {
  try {
    item.framesReady = Math.max(item.framesReady || 0, frameCount || 1);
    item.viewedAt = Date.now();
    item.viewCount = (item.viewCount || 0) + 1;
    item.usedAt = Date.now();
    libDirty = true;
    flushLib();
  } catch { /* 记账失败不影响看图 */ }
  return result;
}

function registerTools(api) {
  // ── 0. 看这张表情包（把图片真的交给模型看）───────────────────────────────
  api.registerTool({
    id: 'look_sticker',
    name: '看这张表情包',
    description: '把库里某张表情包的图片内容交给你看。当你要判断"这张图是什么意思、适合什么场合"、想给它打标签、或者群友问起某张图时使用。静态图直接看图；**动图（GIF）会自动抽成多张连续画面**（画面重复的帧会自动去掉，动图最多 2 张、静态图 1 张），你能看到动作和后半段才出现的内容。⚠️ **注意：发图不需要先看图** —— 动图和静态图都能直接 send_sticker_steal 发出去，这个工具只是让你"知道它画的是什么"，想挑得更贴切、或要给它打标签时才用。看图有成本，请按需使用，不要为了补全标签而逐张翻看。看完请用 tag_sticker 写下你的理解。',
    category: 'sticker',
    icon: '👀',
    parameters: {
      type: 'object',
      properties: {
        stickerId: { type: 'string', description: '表情包编号（挑图或列库时返回的 #后面那串）' },
        frames: { type: ['integer', 'string'], description: '动图抽几帧（1~6，默认用设置里的值）。想省 token 就填 1' }
      },
      required: ['stickerId']
    },
    async execute(ctx, args) {
      rememberRuntime(ctx);
      try {
        if (!conf().enabled) return err('更好的表情包收集和发送当前是关闭的');
        const found = resolveItem(args?.stickerId);
        if (found.error) return err(found.error);
        const item = found.item;
        if (!item.path || !fs.existsSync(item.path)) {
          removeItem(item.key);
          return err('这张表情包的图片文件已经不在本地了（可能被清理过），已从库里移除。');
        }

        let buf;
        try {
          buf = fs.readFileSync(item.path);
        } catch (error) {
          return err(`读图失败：${error?.message ?? error}`);
        }
        if (!buf.length) return err('这张表情包的图片是空文件。');

        const want = Math.round(clamp(args?.frames, 1, 6, conf().gifFramesWant));
        return buildLookResult(item, buf, want);
      } catch (error) {
        return err(`看图失败：${error?.message ?? error}`);
      }
    }
  });
  // ── 0.5 批量认识（打开冷启动死锁）───────────────────────────────────────
  api.registerTool({
    id: 'review_stickers',
    name: '批量认识表情包',
    description: '一次查看多张你还没认识过的表情包，用来给它们打标签。当"挑一张表情包"给出的候选都还没标签、你觉得没有合适的图可配时，用这个工具看一批：看完对**有把握的**用 tag_sticker 写标签（有把握才写，拿不准的跳过）。也可以用它专门看还没看过的动图。一次默认 4 张、最多 6 张，请勿频繁调用（看图有成本）。',
    category: 'sticker',
    icon: '📋',
    parameters: {
      type: 'object',
      properties: {
        count: { type: ['integer', 'string'], description: '这次看几张，默认 4、最多 6' },
        onlyAnimated: { type: 'boolean', description: '只挑还没看过的动图（true）还是任意未认识的图（默认 false）' }
      }
    },
    async execute(ctx, args) {
      rememberRuntime(ctx);
      try {
        if (!conf().enabled) return err('更好的表情包收集和发送当前是关闭的');
        const l = loadLib();
        const want = Math.round(clamp(args?.count, 1, 6, 4));
        const picks = pickUntagged(want, args?.onlyAnimated === true);
        if (!picks.length) {
          return ok(args?.onlyAnimated === true
            ? '没有"还没看过的动图"了，全部动图都认识过了。'
            : '库里没有"还没认识"的表情包了，全部都有标签或备注。可以直接用「挑一张表情包」挑图。');
        }

        // 预算收敛：批量看时把单帧尺寸压小（够判断"这图表达什么"即可），
        // 免得一次 4~6 张把上下文顶爆。看完恢复原值 —— 必须放 finally，
        // 否则中途抛错会让此后所有图都被永远压小。
        const parts = buildReviewParts(picks);
        if (!parts) return err('这批图的文件都读不到了，已跳过。');
        return { content: parts };
      } catch (error) {
        return errDetail('批量认识失败：', error);
      }
    }
  });

  // ── 0.6 按需回溯扫描（自己翻聊天记录往回捞）────────────────────────────
  api.registerTool({
    id: 'scan_stickers',
    name: '往回翻聊天记录找表情',
    description: '让机器人自己往回翻这个会话的历史消息，把里面出现过的表情包捞进自己的库；收完可以顺手把没认识的表情包看一遍、自动写好标签。当群友说「你多收点表情」「翻翻之前的」「去群里找找图」，或者你想扩充库存时用它。range 是往回看多久：1h / 4h / 12h / 24h / all（全部历史）。系统会**挑着收不全收**：只收表情包、跳过自己发的、按图片内容比对后跳过已经收过的（同一张绝不重复收集），但**表达同一个意思的不同图会分别收下**（同义多图是好事）。limit 控制这一轮最多收几张，防止一次捞太多。autoTag 默认按设置走（设置里默认开），开着时本工具会直接把一批图交给你看、你要立刻用 tag_sticker 写标签。',
    category: 'sticker',
    icon: '🧹',
    parameters: {
      type: 'object',
      properties: {
        range: { type: 'string', description: '往回看多久。可选 1h / 4h / 12h / 24h / all（全部历史），也可以直接填小时数如 "6"', enum: ['1h', '4h', '12h', '24h', 'all'] },
        limit: { type: ['integer', 'string'], description: '这一轮最多收几张，默认用设置里的值（1~30）' },
        autoTag: { type: 'boolean', description: '收完是否顺便自动补标签（看图 + 写标签）。不填则用设置里的开关。' }
      }
    },
    async execute(ctx, args) {
      rememberRuntime(ctx);
      const chatKey = resolveChatKey(ctx);
      try {
        if (!conf().enabled) return err('更好的表情包收集和发送当前是关闭的');
        if (!chatKey) return err('拿不到当前会话标识，没法翻记录。');
        if (!ctx.store?.recent) return err('当前环境读不到聊天存档（store 不可用）。');
        const c = conf();

        const raw = String(args?.range ?? '').trim().toLowerCase();
        let lookbackMin;
        if (!raw || raw === 'default') lookbackMin = c.collectWindowMin;
        else if (raw === 'all') lookbackMin = 60 * 24 * 365;          // 一年 ≈ 全部历史
        else if (raw.endsWith('h')) lookbackMin = Math.round(num(raw.slice(0, -1), 1) * 60);
        else lookbackMin = Math.round(num(raw, 1) * 60);              // 纯数字当小时
        lookbackMin = Math.round(clamp(lookbackMin, 5, 60 * 24 * 365, c.collectWindowMin));

        const limit = Math.round(clamp(args?.limit, 1, 30, DEFAULT_SCAN_LIMIT));

        // force：用户明确要求，绕过"20 秒冷却"（那个冷却只为自动顺带收而设）
        lastCollectAt = Date.now();
        const r = runCollect(ctx.store, chatKey, {
          lookbackMin,
          limit,
          ctxLike: { chatKey, chatName: ctx.chatName, kind: ctx.kind, sessionId: ctx.sessionId }
        });

        if (!r.taken) {
          return ok(`往回翻了 ${lookbackMin >= 1440 ? '全部' : `${Math.round(lookbackMin / 60)} 小时`}的记录`
            + `（扫过 ${r.scanned} 条消息），没有发现**新的**表情包 —— 出现过的都已在库里了，不会重复收集。`
            + (lib.items.length ? `库里现有 ${lib.items.length} 张。` : ''));
        }

        // ⚠️ 收是后台异步的。这里必须等它跑完，否则模型紧接着调「批量认识」会看到
        //    "没有未认识的表情包"（其实还在下载中）—— 那就白扫一趟。
        await nextTick(80);
        const drained = await waitForQueue(25000);
        const l2 = loadLib();
        const unknown = l2.items.filter((it) => (!it.tags || !it.tags.length) && !it.note).length;

        const head = `已排入 ${r.taken} 张新表情（往回翻了 ${lookbackMin >= 1440 ? '全部' : `${Math.round(lookbackMin / 60)} 小时`}、扫过 ${r.scanned} 条消息，按图片内容比对后跳过了重复的）。`
          + `库里现在 ${l2.items.length} 张，其中 ${unknown} 张还没认识（没有标签）。`
          + (drained ? '' : '（部分图片还在后台下载，稍后可再看一次）');

        // ── 自动补标签：两种模式都支持 ──
        // 这一轮的"首次批量"直接由本工具返回（不额外多绕一次调用），
        // 剩下超出预算的部分用提示让模型继续，直到补完。
        const wantAuto = args?.autoTag === undefined ? c.autoTagAfterScan : args.autoTag !== false;
        if (!wantAuto || !unknown) {
          return ok([head, unknown > 0
            ? '下一步：用「批量认识表情包」把没认识的看一遍并写好标签，之后挑图才准。'
            : '全部都有标签了，可以直接开始配图。'].join('\n'));
        }

        const batch = Math.min(6, c.autoTagBudget);
        const picks = pickUntagged(batch);
        const parts = picks.length ? buildReviewParts(picks) : null;
        if (!parts) {
          return ok([head, '（这批图暂时读不到，稍后再试）'].join('\n'));
        }
        const rest = Math.max(0, unknown - picks.length);
        parts[0].text = `${head}\n\n现在**自动开始补标签**：先看这 ${picks.length} 张。`;
        parts.push({
          type: 'text',
          text: rest > 0
            ? `看完这 ${picks.length} 张后，库里还剩约 ${rest} 张没认识：请继续调用「批量认识表情包」分批看完（每批 4~6 张），直到补完或你觉得够了。这轮不用发图。`
            : '这是最后一批：写完标签，库存就全部认识了，之后配图会更准。这轮不用发图。'
        });
        return { content: parts };
      } catch (error) {
        return errDetail('翻记录失败：', error);
      }
    }
  });

  // ── 0.7 一键整理（插件自己调模型，不依赖模型自觉）──────────────────────
  api.registerTool({
    id: 'organize_library',
    name: '一键整理表情库',
    description: '把库里还没认识的表情包**一次性**自动识别、自动打标签（AI 看每张图，判断画面内容、适用场合、图上的文字，并归类到情绪分类）。当群友说「整理一下表情库」「把表情包都认一遍」「给表情打上标签」，或者你发现候选里很多图都没标签时用它。认不出来的会记下失败次数，累计到设置里的次数后按设置自动删除（默认删）。dryRun=true 可以先试运行、只看会删哪些而不真删。⚠️ 这一步会花 token（每张图一次视觉识别），且要花点时间，调用后请等它返回。',
    category: 'sticker',
    icon: '🧽',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: ['integer', 'string'], description: '最多整理几张，默认用设置里的值（1~60）' },
        dryRun: { type: 'boolean', description: 'true = 只试运行，报告会删/会打什么标签但不改动库' }
      }
      // 注：onProgress 是给界面按钮用的（核心路由直接调本工具时传入），
      //     刻意不写进 parameters —— 那是发给模型的 JSON Schema，塞函数会让严格端点报错。
    },
    async execute(ctx, args) {
      rememberRuntime(ctx);
      try {
        if (!conf().enabled) return err('更好的表情包收集和发送当前是关闭的');
        const out = await organizeLibrary({
          limit: args?.limit,
          dryRun: args?.dryRun === true,
          onProgress: typeof args?.onProgress === 'function' ? args.onProgress : undefined
        });
        return ok(organizeReport(out));
      } catch (error) {
        return errDetail('整理失败：', error);
      }
    }
  });

  // ── 0.8 一键清理（去重 + 清理无意义）──────────────────────────────────
  api.registerTool({
    id: 'cleanup_library',
    name: '清理表情库',
    description: '清理表情库：① 删掉**图片内容完全一样**的重复份（同一张图存了多份，只留信息最全的那张，并把要删那张的标签合并过去）；② 删掉被标为**「无意义」**的图 —— 也就是「一键整理表情库」逐张判定为"看不出任何内容"的那些（纯色块、乱码、残缺）。当群友说「清理一下表情库」「把没用的表情删掉」「删掉重复的表情」时用它。**默认是试运行**（只报告不删），确认后要再调一次并传 dryRun=false 才会真删。⚠️ 它**不会**删"还没整理过、所以暂时没标签"的图 —— 那种应该先用「一键整理表情库」逐张判定（判定为「无意义」的才会进这里待删）。',
    category: 'sticker',
    icon: '🧹',
    parameters: {
      type: 'object',
      properties: {
        dryRun: { type: 'boolean', description: 'true=只报告不删（默认）；false=真的删。删除不可撤销，先试运行' }
      }
    },
    async execute(ctx, args) {
      rememberRuntime(ctx);
      try {
        if (!conf().enabled) return err('更好的表情包收集和发送当前是关闭的');
        const r = cleanupLibrary({ dryRun: args?.dryRun !== false });
        return ok(cleanupReport(r));
      } catch (error) {
        return errDetail('清理失败：', error);
      }
    }
  });

  // ── 0.9 按使用频率收集（手动按钮 + 定时任务共用）────────────────────────
  api.registerTool({
    id: 'collect_top_used',
    name: '收集最常用的表情',
    description: '统计**最近一段时间里群友用得最多**的表情包，按"出现次数从多到少"依次收进库里；已经在库里的自动跳过、顺延到下一个；候选不够就按规则终止，不硬凑。当群友说「收集一下最常用的表情」「把群里最火的表情收进来」「按使用频率收图」时用它。默认看最近 24 小时、最多收 10 张（可在设置里改）。',
    category: 'sticker',
    icon: '📈',
    parameters: {
      type: 'object',
      properties: {
        hours: { type: ['integer', 'string'], description: '往回统计多少小时，默认用设置里的值（1~8760）' },
        limit: { type: ['integer', 'string'], description: '最多收几张，默认用设置里的值（1~60）' }
      }
    },
    async execute(ctx, args) {
      rememberRuntime(ctx);
      try {
        if (!conf().enabled) return err('更好的表情包收集和发送当前是关闭的');
        const chatKey = resolveChatKey(ctx);
        if (!ctx.store?.recent) return err('当前环境读不到聊天存档，没法统计使用频率。');
        const c = conf();
        const r = await collectTopUsed({
          store: ctx.store,
          chatKey,
          chatName: ctx.chatName,
          hours: args?.hours,
          limit: args?.limit
        });
        return ok(topUsedReport({ ...r, limit: Math.round(clamp(args?.limit, 1, 60, c.collectTopCount)) }));
      } catch (error) {
        return errDetail('频率收集失败：', error);
      }
    }
  });

  // ── 0.10 删除最早的表情 ────────────────────────────────────────────────
  api.registerTool({
    id: 'delete_oldest',
    name: '删除最早的表情',
    description: '删掉库里**入库时间最早**的若干张表情包（默认 25 张，可在设置里改）。当群友说「删掉最早的表情」「清理一下最老的那些图」「库里太满了删掉旧的」时用它。保护：无论删多少，都至少保留设置里的"保底留存"张（默认 10）；并且优先删**从没被发过**的旧图，真正常用的不会因为入库早就被删。删除不可撤销，想先看会删哪些就传 dryRun=true。',
    category: 'sticker',
    icon: '🗑️',
    parameters: {
      type: 'object',
      properties: {
        count: { type: ['integer', 'string'], description: '删几张，默认用设置里的值（1~500）' },
        dryRun: { type: 'boolean', description: 'true=只报告会删哪些，不真删' }
      }
    },
    async execute(ctx, args) {
      rememberRuntime(ctx);
      try {
        if (!conf().enabled) return err('更好的表情包收集和发送当前是关闭的');
        const r = deleteOldestItems({ count: args?.count, dryRun: args?.dryRun === true });
        return ok(deleteOldestReport(r));
      } catch (error) {
        return errDetail('删除失败：', error);
      }
    }
  });

  // ── 1. 挑一张 ──────────────────────────────────────────────────────────
  api.registerTool({
    id: 'pick_sticker',
    name: '挑一张表情包',
    description: '从库里挑几张候选，返回编号、标签和适用场合。想配图时先用它挑，再用 send_sticker_steal 发出。参数 mood 填想表达的情绪（开心/无奈/生气/难过/害羞/惊讶/嘲讽/赞同/拒绝/打招呼/关心/沙雕/发呆/困/偷看/紧张），keyword 填更具体的关键词（如"猫娘""笑死"）。**动图（GIF）也能直接发，不需要先抽帧或先看**。⚠️ **别把"挑得完美"当成前提**：别人点名要图时，从返回的候选里**随便挑一张直接发**就行；自己主动说话想配图时同理 —— 挑不到"特别贴切"的也照发，不要为了追求贴切而放弃发图（只有当前是严肃/正式话题才不发）。',
    category: 'sticker',
    icon: '🔍',
    parameters: {
      type: 'object',
      properties: {
        mood: { type: 'string', description: '想表达的情绪，从系统给的情绪词里选一个；拿不准就留空', enum: MOODS },
        keyword: { type: 'string', description: '更具体的关键词，如"猫娘""笑死""晚安"。可选。' }
      }
    },
    async execute(ctx, args) {
      rememberRuntime(ctx);
      try {
        if (!conf().enabled) return err('更好的表情包收集和发送当前是关闭的（设置里可开）');
        const l = loadLib();
        if (!l.items.length) return err('库里还没有表情包：群友发过的表情包会被自动收进来，攒一点之后再挑。这次请用文字回应。');
        const c = conf();
        const cands = pickCandidates({
          mood: args?.mood,
          keyword: args?.keyword,
          limit: c.keepRecentCount,
          chatKey: resolveChatKey(ctx)
        });
        if (!cands.length) return err('没挑到合适的表情包，换成文字回应吧。');
        const lines = cands.map((it, i) => oneLine(it, i, c.showTextInContext));
        const gate = sendGate(resolveChatKey(ctx));
        return ok([
          `候选（库内共 ${l.items.length} 张）：`,
          ...lines,
          `当前档位：${freqBrief(resolveChatKey(ctx))}`,
          gate.ok
            ? '挑好后用 send_sticker_steal 发出去（一次只发一张）。想说的话请用 send_message 单独发 —— 图和文字不能在同一气泡。'
            : `⚠️ 这个会话现在不配图：${gate.reason}。这次用文字回应就好。`
        ].join('\n'));
      } catch (error) {
        return errDetail('挑图失败：', error);
      }
    }
  });

  // ── 2. 发一张 ──────────────────────────────────────────────────────────
  api.registerTool({
    id: 'send_sticker_steal',
    name: '发表情包',
    description: '把表情包发到当前会话（聊天配图用）。**别人点名要图时直接发**（不用纠结贴不贴切）；**自己主动说话时也主动配一张** —— 就像真人在群里随手甩表情。stickerId 用「挑一张表情包」返回的编号；如果上下文里【表情包库】已经直接给了"现成好发的"编号，可以跳过挑选直接用。**一条消息只能是一张图、不能附带文字**：想说的话先用 send_message 单独发。受当前档位与额度限制：被拒绝就改用文字回应，不要重试（也别编"图卡住了"这种理由）。',
    category: 'sticker',
    icon: '🖼️',
    parameters: {
      type: 'object',
      properties: {
        stickerId: { type: 'string', description: '表情包编号，即「挑一张表情包」返回的 #后面那串' },
        replyToMessageId: { type: ['integer', 'string'], description: '要引用回复的消息 id（可选，一般不用）' },
        wantSticker: { type: 'boolean', description: '**群友点名要图时填 true**（要表情/来个图/发点表情）—— 会跳过"值不值得发"的判定，保证一定发出去。自己主动配图时不要填' }
      },
      required: ['stickerId']
    },
    async execute(ctx, args) {
      rememberRuntime(ctx);
      try {
        if (!conf().enabled) return err('更好的表情包收集和发送当前是关闭的');
        // ⚠️ 这一行**必须有**。曾经在重写提示词时被误删，导致 send_sticker_steal
        //    执行到"记奖励"那一步抛 `l is not defined` —— 而那时**图片已经发出去了**，
        //    于是用户看到"发送失败"，实际图已经到了群里（最糟的一种 bug：假失败）。
        const l = loadLib();
        const raw = clean(args?.stickerId, 80).replace(/^#/, '');
        if (!raw) return err('缺少 stickerId：先用「挑一张表情包」拿到编号');
        const found = resolveItem(raw);
        if (found.error) return err(found.error);
        const item = found.item;
        if (!item.path || !fs.existsSync(item.path)) {
          removeItem(item.key);
          return err('这张表情包的图片文件已经不在本地了（可能被清理过），已从库里移除。换一张吧。');
        }

        const chatKey = resolveChatKey(ctx);
        // wantSticker = 群友**点名要图**。这时跳过"值不值得发"的判定 —— 人家要了就得给。
        const gate = sendGate(chatKey, { explicit: args?.wantSticker === true });
        if (!gate.ok) return err(gate.reason);

        // 这里**没有**"这张刚发过所以不许发"的硬阻断 —— 用户明确要求不要这种冷却。
        // 轮换由候选排序负责（发过的图分数低、自动排后面），但模型想发任何一张都能发。

        // ── 发送（带自动换图重试）────────────────────────────────────────
        // 为什么要重试：核心 sender 有一道**内容指纹去重**（默认 8000 毫秒，
        // 见 src/sender.js 的 #isDuplicate）：同一会话在窗口期内发**相同图片**会被
        // 直接拒绝，抛「这张图刚刚发过，已跳过（避免重复刷屏）」。
        // 用户实测的"发图偶尔失败"就是它 —— 连着要两张、或一轮里发两次时会撞上。
        //
        // 对策：撞上这类"重发被拦"时**自动换一张候选接着发**，而不是把失败抛给用户。
        // 只对"重复/限频"这类可换图解决的错误重试；网络/格式错误不重试（换图也一样失败）。
        const attempts = [item];
        try {
          for (const alt of pickCandidates({ limit: 3, chatKey })) {
            if (alt.key !== item.key && !attempts.some((x) => x.key === alt.key)) attempts.push(alt);
          }
        } catch { /* 拿不到备选就只用原来那张 */ }

        let sentItem = null;
        let lastError = null;
        for (const cand of attempts) {
          let candDataUrl = '';
          try {
            const buf = fs.readFileSync(cand.path);
            if (buf.length && buf.length <= HARD_MAX_ITEM_BYTES) {
              candDataUrl = `data:image/${cand.ext === 'jpg' ? 'jpeg' : cand.ext};base64,${buf.toString('base64')}`;
            }
          } catch { /* 没读成才就用路径 */ }
          try {
            await ctx.sender.sendImage(chatKey, { file: cand.path, dataUrl: candDataUrl }, { note: '偷来的表情包' });
            sentItem = cand;
            break;
          } catch (error) {
            lastError = error;
            const msg = String(error?.message ?? error);
            const retryable = /刚刚发过|重复|已跳过|dedup/i.test(msg);
            if (!retryable) return err(`发送失败：${msg}`);
            warn(`#${shortId(cand)} 被核心的去重拦下（${msg}），自动换一张重试`);
          }
        }
        if (!sentItem) {
          return err(`发送失败：连续 ${attempts.length} 张都被"8 秒内重复"拦下了（${lastError?.message ?? ''}）。`
            + '这是核心的防刷屏去重（src/sender.js 的 dedupeWindowMs，默认 8000 毫秒）—— 等几秒再发、或换一张不同的图。');
        }
        const item2 = sentItem;

        // 记账记的是**实际发出去的那张**（可能因为去重换过图，不能记成原来那张）
        markSent(chatKey, item2.key);
        // 发言计数器归零：下一次"连着几条文字就强制发图"从这里重新数
        markStickerSent(chatKey);
        item2.sentCount += 1;
        item2.useCount += 1;
        item2.usedAt = Date.now();
        // 按会话记"这个群发过这张"（chatKey → 时间戳）—— 排障/统计用；
        // "最近 N 次"的排除窗口由 markSent 里的 st.recentIds 维护。
        // 只记最近若干个会话，避免索引无限膨胀。
        try {
          if (chatKey) {
            if (!item2.sentTo || typeof item2.sentTo !== 'object') item2.sentTo = {};
            item2.sentTo[chatKey] = Date.now();
            const keys = Object.keys(item2.sentTo);
            if (keys.length > 8) {
              keys.sort((a, b) => num(item2.sentTo[a], 0) - num(item2.sentTo[b], 0));
              for (const k of keys.slice(0, keys.length - 8)) delete item2.sentTo[k];
            }
          }
        } catch { /* 记账失败不影响发送 */ }
        if (chatKey && !item2.chatKey) item2.chatKey = clean(chatKey, 60);
        libDirty = true;
        flushLib(true);

        // ── 奖励系统结算 ──
        // 基础奖励 E：成功发出即得 0.25，但**每 20 秒最多给一次**
        // （用户方案第 3 条：防止它为了拿奖励连发几十张刷分）。
        const nowMs = Date.now();
        const baseGapOk = !l.lastBaseRewardAt || (nowMs - l.lastBaseRewardAt) >= BASE_REWARD_MIN_GAP_MS;
        if (baseGapOk) {
          l.lastBaseRewardAt = nowMs;
          libDirty = true;
          // ⚠️ 必须在这里**再 flush 一次**：上面 markSent 的那次 flush 发生在这一行
          //    **之前**。只标脏不落盘的话，这个时间戳会一直躺在内存里，
          //    直到下次发送或进程退出 —— 重启就丢，"每 20 秒最多一次基础奖励"
          //    的防刷分就形同不存在（这类"写了但没存"的坑在这个项目里踩过多次）。
          flushLib(true);
        }
        // 互动奖励：3 分钟后回看这段时间的群友回应，把 U/M 记回**这张图**
        // —— 用户方案强调"记回原来的表情动作，而不是记到之后发的消息上"。
        registerSendForInteraction(chatKey, item2.key, baseGapOk);

        const c = conf();
        const quip = c.stealQuipChance > 0 && Math.random() * 100 < c.stealQuipChance;
        if (quip) { lib.counters.quips += 1; libDirty = true; }
        const tail = quip
          ? '已发出。这次可以顺口贫一句（例如「好表情，我偷了」「这张归我了」），一句话就够，说完不要再解释。'
          : '已发出。不要复述、不要解释图片内容、也不要说「我发了张图」这类旁白；本来就没别的话要说就保持安静。';
        const left = c.sendDailyLimit > 0 ? `（今天还剩 ${Math.max(0, c.sendDailyLimit - loadLib().sentToday)} 张额度）` : '';
        // 换过图时如实说明，免得模型以为发的是自己挑的那张（它会顺着这个编号说错话）
        const swapped = item2.key !== item.key ? `（你挑的 #${shortId(item)} 刚好撞上防重复，已自动换成这张）` : '';
        return ok(`已发出表情包 #${shortId(item2)}${swapped}${left}。${tail}`);
      } catch (error) {
        return err(`发表情失败：${error?.message ?? error}`);
      }
    }
  });

  // ── 3. 给表情打标签 ────────────────────────────────────────────────────
  api.registerTool({
    id: 'tag_sticker',
    name: '给表情包打标签',
    description: '把你对某张表情包的理解写进它的档案：tags 填情绪标签（从系统词表里选，可多个），note 填一句适用场合的说明（如「举着白旗的猫，服软认错时用」），text 填图上识别出的文字（如「笑死」，没有就留空）。**写之前必须先用 look_sticker 看过那张图**（动图会被抽成多帧，别只看编号就猜）。第一次看到库里某张表情、或群友纠正了含义、或管理员要求改标签时使用。stickerId 必须是库里已有的编号。',
    category: 'sticker',
    icon: '🏷️',
    parameters: {
      type: 'object',
      properties: {
        stickerId: { type: 'string', description: '表情包编号（挑图或列库时返回的 #后面那串）' },
        tags: {
          type: 'array',
          items: { type: 'string', enum: MOODS },
          description: '情绪标签，1~3 个即可，从系统词表里选'
        },
        note: { type: 'string', description: '一句适用场合的说明，例如「举着白旗的猫，服软认错时用」' },
        text: { type: 'string', description: '图上识别出的文字：**一个字也别漏**（哪怕只是一个符号、一个"嗯"），确实没有才留空。文字常常是这张图最有用的信息（群友引用的就是那句话），也是以后按关键词挑图的依据。不要编，看不清就留空' },
        userId: { type: ['integer', 'string'], description: '要求改标签的人（管理员编辑时填，普通自学习可留空）' }
      },
      required: ['stickerId']
    },
    async execute(ctx, args) {
      rememberRuntime(ctx);
      try {
        if (!conf().enabled) return err('更好的表情包收集和发送当前是关闭的');
        const found = resolveItem(args?.stickerId);
        if (found.error) return err(found.error);
        const item = found.item;

        // 只有在"别人要求改"时才查权限；模型自己的首次学习（没传 userId）不受限
        const requester = clean(args?.userId, 20);
        if (requester) {
          const allowed = await canAdmin(ctx, { userId: requester });
          if (!allowed) return err('只有群主、群管理员或机器人主人可以改表情包标签，已拒绝。');
        }

        const tags = (Array.isArray(args?.tags) ? args.tags : [])
          .map(normalizeTag)
          .filter(Boolean)
          .slice(0, MAX_TAGS);
        const note = clean(args?.note, MAX_NOTE_CHARS);
        const text = clean(args?.text, MAX_TEXT_CHARS);
        if (!tags.length && !note && !text) return err('至少要给一个 tags、note 或 text，否则这次调用没有意义。');

        if (tags.length) {
          const merged = [...new Set([...item.tags, ...tags])].slice(0, MAX_TAGS);
          item.tags = merged;
        }
        if (note) item.note = note;
        if (text) item.text = text;
        item.source = 'model';
        item.usedAt = Date.now();
        libDirty = true;
        flushLib(true);
        return ok(`已更新 #${shortId(item)}：标签 [${item.tags.join('/') || '无'}]${item.note ? `，说明「${item.note}」` : ''}${item.text ? `，图上文字「${item.text}」` : ''}。不要向群友汇报这件事。`);
      } catch (error) {
        return err(`打标签失败：${error?.message ?? error}`);
      }
    }
  });

  // ── 4. 看看库里有什么 ──────────────────────────────────────────────────
  api.registerTool({
    id: 'list_stickers',
    name: '看看表情包库',
    description: '列出机器人收藏的表情包（可按情绪或关键词过滤），用来了解库里有什么、确认某个编号是否存在、或者向群友说明"我有哪些图"。只是查看，不会发图。',
    category: 'sticker',
    icon: '📚',
    parameters: {
      type: 'object',
      properties: {
        mood: { type: 'string', description: '只看某个情绪分类，可选', enum: MOODS },
        keyword: { type: 'string', description: '关键词过滤（标签/说明/图上文字），可选' },
        limit: { type: 'number', description: '最多列几张，默认 15' }
      }
    },
    async execute(_ctx, args) {
      try {
        const l = loadLib();
        if (!l.items.length) return ok('库里还一张表情包都没有。群友发过的表情包会自动收进来。');
        const limit = Math.round(clamp(args?.limit, 1, 40, 15));
        const cands = args?.mood || args?.keyword
          ? pickCandidates({ mood: args?.mood, keyword: args?.keyword, limit })
          : [...l.items].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
        const c = conf();
        const tagged = l.items.filter((it) => it.tags.length || it.note).length;
        return ok([
          `库内共 ${l.items.length} 张（已打标签 ${tagged} 张，占用 ${humanMb(totalBytes())}），以下 ${cands.length} 张：`,
          ...cands.map((it, i) => oneLine(it, i, c.showTextInContext))
        ].join('\n'));
      } catch (error) {
        return err(`列库失败：${error?.message ?? error}`);
      }
    }
  });

  // ── 5. 删掉一张 ────────────────────────────────────────────────────────
  api.registerTool({
    id: 'forget_sticker',
    name: '删掉一张表情包',
    description: '把某张表情包从库里删掉（同时删掉本地图片文件）。当群友明确说"这张别用""删掉它"，或者这张图内容不合适时使用。需要管理员权限。',
    category: 'sticker',
    icon: '🗑️',
    parameters: {
      type: 'object',
      properties: {
        stickerId: { type: 'string', description: '要删除的表情包编号（挑图或列库时返回的）' },
        userId: { type: ['integer', 'string'], description: '提出删除的人（用于权限判断）' }
      },
      required: ['stickerId']
    },
    async execute(ctx, args) {
      rememberRuntime(ctx);
      try {
        const raw = clean(args?.stickerId, 80).replace(/^#/, '');
        const allowed = await canAdmin(ctx, args);
        if (!allowed) return err('只有群主、群管理员或机器人主人可以删除表情包，已拒绝。');
        const found = resolveItem(raw);
        if (found.error) return err(found.error);
        const removed = removeItem(found.item.key);
        if (!removed) return err(`库里找不到表情包 ${raw}，可能已经删过了。`);
        flushLib(true);
        return ok(`已删除表情包 #${raw}（连同本地图片文件）。不要向群友汇报这件事，也不要解释。`);
      } catch (error) {
        return err(`删除失败：${error?.message ?? error}`);
      }
    }
  });

  // ── 6. 库的概况 ────────────────────────────────────────────────────────
  api.registerTool({
    id: 'sticker_library_stats',
    name: '表情包库概况',
    description: '查看表情包库的统计：总数、占用空间、各情绪分类的数量、已发送数量和剩下的每日额度。当群友问"你偷了多少表情""你有多少张图"或需要判断库是否该清理时使用。',
    category: 'sticker',
    icon: '📊',
    parameters: { type: 'object', properties: {} },
    async execute(_ctx) {
      try {
        const c = conf();
        const l = loadLib();
        const byMood = new Map();
        for (const it of l.items) {
          for (const t of (it.tags.length ? it.tags : ['未分类'])) byMood.set(t, (byMood.get(t) || 0) + 1);
        }
        const top = [...byMood.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
          .map(([t, n]) => `${t}${n}`).join('、') || '（空）';
        const anim = l.items.filter((it) => it.animated);
        const animReady = anim.filter((it) => it.framesReady).length;
        return ok([
          `表情包库：${l.items.length} 张，占用 ${humanMb(totalBytes())}（上限 ${c.maxLibrarySize} 张 / ${c.maxLibraryMb}MB）`,
          `其中动图 ${anim.length} 张（已抽帧看过 ${animReady} 张）`,
          `分类：${top}`,
          `累计发送 ${l.sentTotal} 次，今天已发 ${l.sentToday}${c.sendDailyLimit > 0 ? ` / 上限 ${c.sendDailyLimit}` : '（无上限）'}`,
          `累计收录 ${l.counters.collected}，去重跳过 ${l.counters.duplicates}，淘汰 ${l.counters.evicted}，看图失败 ${l.counters.lookFailed || 0}`
        ].join('\n'));
      } catch (error) {
        return err(`统计失败：${error?.message ?? error}`);
      }
    }
  });

  // ── 表现报表（奖励系统的观察窗口）────────────────────────────────────
  api.registerTool({
    id: 'library_report',
    name: '表情包库表现报表',
    description: '生成一份"哪些表情真的能引起群友回应"的报表：互动表现排行（按单次互动奖励均值）、被发得最多的图、库健康度。'
      + '用来验证奖励系统是否在起作用（互动均值高的图，下次选图会排在前面）。'
      + '当群友问"哪些表情最受欢迎""表情包效果怎么样"，或你想复盘配图效果时使用。'
      + '同时会把报表写成文件（data/sticker-steal/reward-report.txt）便于留档对比。不花 token。',
    category: 'sticker',
    icon: '📈',
    parameters: { type: 'object', properties: {} },
    async execute(_ctx) {
      try {
        if (!conf().enabled) return err('更好的表情包收集和发送当前是关闭的');
        return ok(libraryReportText());
      } catch (error) {
        return err(`生成报表失败：${error?.message ?? error}`);
      }
    }
  });

  // ── 在文件管理器里定位报表文件 ────────────────────────────────────────
  api.registerTool({
    id: 'open_report_file',
    name: '打开报表文件',
    description: '在文件管理器里定位表现报表文件（data/sticker-steal/reward-report.txt），方便留档或对比不同时间的结果。'
      + '注意：**文件要先存在** —— 没生成过报表就先调一次「表情包库表现报表」。',
    category: 'sticker',
    icon: '📄',
    parameters: { type: 'object', properties: {} },
    async execute(_ctx) {
      try {
        const file = path.join(DIR, REPORT_FILE);
        if (!fs.existsSync(file)) {
          return err(`还没有报表文件。先调一次「表情包库表现报表」生成它，再来打开。（预期路径：${file}）`);
        }
        // ⚠️ 这里**惰性取** spawn，不能只靠 activate() 里赋值 ——
        //    加载器不保证走 activate()（和当初 cfg 那个坑同源：只有 setup 一定跑）。
        //    惰性取一次并缓存，两种加载路径下都能用。
        if (!nodeSpawn) {
          try {
            const cp = await import('node:child_process');
            nodeSpawn = cp?.spawn || null;
          } catch { nodeSpawn = null; }
        }
        const spawn = nodeSpawn;
        if (!spawn) return err('当前环境不支持打开文件管理器（取不到 child_process）');
        if (process.platform === 'win32') {
          spawn('explorer.exe', ['/select,' + file], { detached: true, stdio: 'ignore' }).unref();
        } else if (process.platform === 'darwin') {
          spawn('open', ['-R', file], { detached: true, stdio: 'ignore' }).unref();
        } else {
          spawn('xdg-open', [DIR], { detached: true, stdio: 'ignore' }).unref();
        }
        return ok(`已在文件管理器中定位报表文件：${file}`);
      } catch (error) {
        return err(`打开报表失败：${error?.message ?? error}`);
      }
    }
  });
}

// ─────────────────────────────────────────────── 钩子

/** 会话内已排队过的键（只活在本进程，避免同一轮里反复入队）。 */
const queuedOnce = new Set();
let lastCollectAt = 0;

function collectFrom(entries, ctxLike, budget) {
  const c = conf();
  let taken = 0;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (taken >= budget) break;
    if (entry?.self) continue;                                  // 自己发的不偷
    const media = Array.isArray(entry?.media) ? entry.media : [];
    for (const m of media) {
      if (taken >= budget) break;
      if (!isImageMedia(m)) continue;
      if (c.stickerOnly && !isLikelySticker(m)) continue;
      const key = mediaKeyOf(m);
      if (!key || queuedOnce.has(key)) continue;
      if (findItem(key)) { queuedOnce.add(key); continue; }      // 库里已有
      if (m.src && findBySrc(m.src)) { queuedOnce.add(key); continue; }
      queuedOnce.add(key);
      if (queuedOnce.size > 4000) queuedOnce.clear();
      if (enqueue({
        key,
        file: clean(m.file, 120),
        media: m,
        chatKey: String(ctxLike?.chatKey || ''),
        chatName: String(ctxLike?.chatName || ''),
        // 来源上下文（不花 token 的"免费标签"）：这张图出现时群里在聊什么。
        srcHint: describeSource(entry),
        source: ctxLike?.chatName || (ctxLike?.kind === 'group' ? '群聊' : '私聊')
      })) taken += 1;
    }
  }
  return taken;
}

/** 只偷最近这段时间里的表情，避免第一次打开时把整个群的历史翻一遍。 */
function withinWindow(entry, windowMs) {
  const ts = num(entry?.ts ?? entry?.at ?? entry?.time, 0);
  if (!ts) return true;               // 拿不到时间戳就不拦（总比漏收好）
  const ms = ts < 1e12 ? ts * 1000 : ts;
  return Date.now() - ms <= windowMs;
}

/**
 * 统一的"翻聊天记录捞表情"入口 —— 自动顺带收 与 用户要求的回溯扫描，走同一条路。
 *
 * @param {object} store       聊天存档（要有 recent）
 * @param {string} chatKey     会话
 * @param {object} opts
 * @param {number} opts.lookbackMin  往回看多少分钟（默认取设置里的 collectWindowMin）
 * @param {number} opts.limit        本次最多收几张
 * @param {object} opts.ctxLike      { chatKey, chatName, kind, sessionId }
 * @returns {{ taken:number, scanned:number, since:number }}
 *
 * "挑着收、不全收"落在两处：limit 卡住张数，以及下面 media 级的筛选
 * （只收表情包、跳过自己发的、按指纹跳过已收的）。不去按"每张都收"的方式堆量。
 */
function runCollect(store, chatKey, { lookbackMin = 0, limit = 0, ctxLike = {} } = {}) {
  const c = conf();
  const budget = Math.max(0, limit || DEFAULT_COLLECT_PER_RUN);
  const mins = Math.max(1, lookbackMin || c.collectWindowMin);
  const windowMs = mins * 60000;
  const meta = { taken: 0, scanned: 0, since: windowMs };

  if (!store?.recent || !chatKey || budget <= 0) return meta;
  let recent = [];
  try {
    // limit 要足够大才能覆盖长回溯：按时间窗筛，所以先多取一些（上限 400 防卡顿）
    const want = mins <= 60 ? 60 : mins <= 240 ? 150 : mins <= 720 ? 300 : 400;
    recent = store.recent(chatKey, { limit: want, includeSelf: false });
  } catch (error) {
    warn(`读取聊天记录失败（不影响对话）：${error?.message ?? error}`);
    return meta;
  }
  const list = (Array.isArray(recent) ? recent : []).filter((e) => withinWindow(e, windowMs));
  meta.scanned = list.length;
  // 从**最近**往回捞：新的梗比旧的更有用，张数用完时就停
  meta.taken = collectFrom(list.reverse(), ctxLike, budget);
  return meta;
}

/** 采集队列是否还有活（供"等收完再打标签"判断用）。 */
function queueBusy() {
  return queue.length > 0 || draining;
}

/** 等采集队列跑完（带上限，绝不卡住对话）。 */
async function waitForQueue(maxMs = 25000) {
  const deadline = Date.now() + maxMs;
  while (queueBusy() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
  }
  return !queueBusy();
}

/** 让出一轮事件循环，让排队的下载真正开始跑。 */
function nextTick(ms = 60) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 把一批"还没认识"的表情组装成给模型看的多模态 parts。
 * 抽出来是为了让「批量认识」工具与「扫描后自动补标签」共用同一段逻辑 ——
 * 两处各写一遍迟早会走样（一处改了图片压缩、另一处忘了改）。
 * 返回 null 表示这批图都读不到。
 */
function buildReviewParts(picks) {
  const oldDim = MAX_PNG_DIM;
  const parts = [{
    type: 'text',
    text: `这一批有 ${picks.length} 张你还没认识过的表情包（编号已给出）。`
      + '请逐张判断"画面是什么 + 适合什么场合"，然后对**有把握的**调用 tag_sticker 写下来；'
      + '拿不准的可以跳过（也可以说一句"看不懂"），不要硬编含义。\n'
      // 用户要求：收录/识别时**顺手把图上的文字也记下来**。
      // 关键点：这一步不需要任何额外调用 —— 模型本来就在看这张图，
      // 而文字往往是这张图最有用的信息（群友引用它、或语义就靠这句话）。
      + '**每张都要顺手把图上的文字记进 text**（哪怕只有一个字或一个符号，也不要漏）。'
      + '有了文字，以后按关键词/语境挑图才挑得准；没文字就留空，不要编。'
      + '这轮不必发图，专注认识它们。'
  }];
  try {
    // 预算收敛：批量看时把单帧尺寸压小（够判断"这图表达什么"即可），免得顶爆上下文。
    // 必须放 finally 恢复，否则中途抛错会让此后所有图都被永远压小。
    MAX_PNG_DIM = Math.min(oldDim, 256);
    for (const it of picks) {
      let buf;
      try { buf = fs.readFileSync(it.path); } catch { continue; }
      if (!buf || !buf.length) continue;
      const one = buildLookResult(it, buf, 1);     // 每张最多 1 帧，够认图
      const content = Array.isArray(one?.content) ? one.content : [];
      for (const p of content) {
        if (p?.type === 'text') parts.push({ type: 'text', text: `#${shortId(it)} ${p.text}` });
        else if (p?.type === 'image_url') parts.push(p);
      }
    }
  } finally {
    MAX_PNG_DIM = oldDim;
  }
  if (parts.length <= 1) return null;
  parts.push({ type: 'text', text: '看完用 tag_sticker 给有把握的写标签（可多次调用）。**每张都顺手把图上的文字记进 text**（一个字也别漏，没有就留空），之后正常聊天时配图和找图都会更准。' });
  return parts;
}

/**
 * 从 PNG 字节里取出像素（只支持我们自己生成的 RGBA 真彩 PNG）。
 * 用途：整理表情库时判断"这次抽出来的画面和上次是否一样"，
 * 一样就说明这张图本身没变、再让模型看一遍纯属白花钱。
 * 返回 { w, h, px }（px 为 RGBA），失败返回 null。
 */
function decodePngRgba(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 8 || !buf.slice(0, 8).equals(PNG_MAGIC)) return null;
    let p = 8;
    let w = 0; let h = 0; let colorType = 6; let bitDepth = 8;
    const idat = [];
    while (p + 8 <= buf.length) {
      const len = buf.readUInt32BE(p);
      const type = buf.slice(p + 4, p + 8).toString('latin1');
      const data = buf.slice(p + 8, p + 8 + len);
      if (type === 'IHDR') {
        w = data.readUInt32BE(0);
        h = data.readUInt32BE(4);
        bitDepth = data[8];
        colorType = data[9];
      } else if (type === 'IDAT') {
        idat.push(data);
      } else if (type === 'IEND') {
        break;
      }
      p += 12 + len;
    }
    if (!w || !h || colorType !== 6 || bitDepth !== 8 || !idat.length) return null;
    if (w * h > MAX_CANVAS_PIXELS) return null;
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = w * 4;
    const px = new Uint8Array(w * h * 4);
    const prev = new Uint8Array(stride);
    const cur = new Uint8Array(stride);
    let q = 0;
    for (let y = 0; y < h; y += 1) {
      const filter = raw[q];
      q += 1;
      for (let i = 0; i < stride; i += 1) {
        const x = raw[q + i] || 0;
        const a = i >= 4 ? cur[i - 4] : 0;
        const b = prev[i];
        const c = i >= 4 ? prev[i - 4] : 0;
        let v;
        if (filter === 1) v = x + a;
        else if (filter === 2) v = x + b;
        else if (filter === 3) v = x + ((a + b) >> 1);
        else if (filter === 4) {
          const pp = a + b - c;
          const pa = Math.abs(pp - a); const pb = Math.abs(pp - b); const pc = Math.abs(pp - c);
          v = x + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c));
        } else v = x;
        cur[i] = v & 0xff;
      }
      q += stride;
      px.set(cur, y * stride);
      prev.set(cur);
    }
    return { w, h, px };
  } catch {
    return null;
  }
}

/** 画面的粗略指纹：用像素做降采样平均，够判断"是不是同一张画面"。 */
function frameFingerprint(dataUrl) {
  try {
    const png = Buffer.from(String(dataUrl).split('base64,')[1] || '', 'base64');
    const dec = decodePngRgba(png);
    if (!dec) {
      // 解不出来就退回"按字节长度 + 片段"的弱指纹（宁可误判成"变了"，也不漏看）
      return `len:${png.length}:${png.slice(0, 24).toString('hex')}`;
    }
    let a = 0; let b = 0; let c = 0; let n = 0;
    for (let i = 0; i < dec.px.length; i += 64) {
      a += dec.px[i]; b += dec.px[i + 1] || 0; c += dec.px[i + 2] || 0; n += 1;
    }
    if (!n) return `dim:${dec.w}x${dec.h}`;
    return `${dec.w}x${dec.h}:${Math.round(a / n)}:${Math.round(b / n)}:${Math.round(c / n)}`;
  } catch {
    return 'unknown';
  }
}

/**
 * 用**核心的 LLM 通道**看一批图，返回每张的 {id, tags, note, text}。
 *
 * 为什么可以在这里调模型：这是插件自己的"一键整理"动作，不是钩子。
 * 钩子里禁止调模型（5 秒超时 + 不许有副作用），所以整理只能做成**工具/主动动作**。
 * 传 overrides 等于直接用当前配置的模型，不走账号池、也不触发专用模型切换 ——
 * 一次干净的"看图"请求。
 */
async function recognizeBatch(items, opts = {}) {
  const cfg = getConfig();
  const api = cfg?.api || {};
  if (api.vision === false) throw new Error('当前模型没有开启看图（设置 → 模型 API → 视觉），无法自动识别');
  if (!api.model) throw new Error('没有配置模型，无法自动识别');
  const apiKey = String(api.apiKey || cfg?.dshProviderKeys?.[api.provider] || '').trim();
  if (!apiKey) throw new Error('没有可用的 API Key，无法自动识别');

  const oldDim = MAX_PNG_DIM;
  const parts = [{
    type: 'text',
    // 用户要求：**每张图都必须有一个说法**，不允许"看不出/跳过"留空。
    // 所以这里不再提供 skip 这个出口，而是要求：看得懂就正常描述，
    // 真看不懂就老实标成「无意义」—— 那个标签让"无意义"这件事可查、可筛、可清理。
    text: '下面是几张群聊表情包。请判断每一张：画面是什么、适合什么场合用、图上有没有文字。'
      + '**直接给结果，不要写长篇思考、不要解释过程**（这一步只求快速分类）。'
      + '只输出一个 JSON 数组（不要代码块标记），**每一张都要有一个对象，不允许漏、不允许跳过**：'
      + '{"id":"编号","tags":["情绪标签"],"note":"一句话说明适合什么场合","text":"图上的文字，没有就空字符串"}'
      + `。情绪标签只能从这个表里选（可多选，1~3 个）：${MOODS.join('、')}。`
      + '**必须给每一张都下结论**：哪怕只是"一只动物在发呆，可以用在冷场时"，也比空着强。'
      + '只有当这张图**确实没有任何可看的内容**（纯色块、乱码、残缺、完全看不出是什么）时，'
      + '才把它标成 {"id":"编号","tags":["无意义"],"note":"看不出有意义的内容","text":""} —— '
      + '这是"实在找不到意义"的专用标记，不要拿它偷懒（能看出一点内容就必须照实描述）。'
  }];
  try {
    MAX_PNG_DIM = Math.min(oldDim, opts.maxDim || 256);
    for (const it of items) {
      let buf;
      try { buf = fs.readFileSync(it.path); } catch { continue; }
      if (!buf || !buf.length) continue;
      const isGif = (sniffImage(buf) || it.ext) === 'gif';
      if (isGif) {
        const frames = extractGifFrames(buf, 2);          // 动图给 2 帧就够判断，省 token
        if (frames.length) {
          parts.push({ type: 'text', text: `编号 ${shortId(it)}（动图，共 ${frames.length} 张画面）：` });
          for (const f of frames) parts.push({ type: 'image_url', image_url: { url: f.dataUrl } });
          continue;
        }
      }
      const ext = sniffImage(buf) || it.ext || 'png';
      const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
      parts.push({ type: 'text', text: `编号 ${shortId(it)}：` });
      parts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } });
    }
  } finally {
    MAX_PNG_DIM = oldDim;
  }
  if (parts.length <= 1) return [];

  // ⚠️ 第一次实测踩到的坑：deepseek-flash 会先"思考"再输出，而 maxTokens 太小的话
  //    500 个 token 会**全被思考吃掉**、正文一个字都没有（reasoning_tokens=500，
  //    content 为空），表现就是"解析失败"，很容易误判成模型不支持看图。
  //    所以：① 提示里明确要求直接给结果、不要长篇思考；② 预算给足；
  //    ③ 正文为空时自动加预算重试一次。
  const ask = async (budget) => chatCompletion({
    messages: [{ role: 'user', content: parts }],
    overrides: { baseUrl: api.baseUrl, apiKey, model: api.model, temperature: 0.2 },
    maxTokens: budget
  });

  let result = await ask(2600);
  let text = String(result?.message?.content ?? '').trim();
  if (!text) {
    warn('自动识别第一次返回空正文（输出预算被思考占满），已提高预算重试一次');
    result = await ask(4000);
    text = String(result?.message?.content ?? '').trim();
  }
  const arr = extractJsonArray(text);
  return Array.isArray(arr) ? arr : [];
}

/** 从模型回复里抠出 JSON 数组（容忍 ```json 代码块和前后废话）。 */
function extractJsonArray(text) {
  const s = String(text || '');
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  const slice = s.slice(start, end + 1);
  try { return JSON.parse(slice); } catch { /* 再试宽松一点 */ }
  try { return JSON.parse(slice.replace(/,\s*([\]}])/g, '$1')); } catch { return null; }
}

/**
 * 一键整理表情库：自己看、自己打标签；多次认不出来的按设置处理。
 *
 * 与「批量认识表情包」的区别：那个是**模型决定**去认识一批（交给模型看，
 * 模型再调 tag_sticker 写标签，两步、依赖模型自觉）；这个是**插件自己调模型**
 * 一步到底，不依赖模型自觉 —— 所以能当"一键"用。
 *
 * @param {object} opts
 * @param {number} opts.limit   最多处理几张（默认用 autoTagBudget）
 * @param {boolean} opts.dryRun 只报告不落盘（用于先看要删什么）
 * @param {function} opts.onProgress 每批结束回调 (done, total) —— 供界面显示进度
 */
async function organizeLibrary(opts = {}) {
  const c = conf();
  loadLib();
  const limit = Math.round(clamp(opts.limit, 1, 60, c.autoTagBudget));
  const dryRun = opts.dryRun === true;
  const out = {
    considered: 0, tagged: 0, skipped: 0, failed: 0,
    deleted: [], retried: 0, dryRun, model: String((getConfig()?.api?.model) || ''), errors: [],
    suspicious: false, deletedCapped: 0, meaningless: 0
  };

  const pending = pickUntagged(limit);
  out.considered = pending.length;
  if (!pending.length) return out;

  // ── 两道保险，防"模型抽风把库清空" ──
  // 背景：一次真实可能的灾难 —— 模型 API 某天抽风（额度用尽/网关返回空正文/答非所问），
  // 代码会把这些当成"这张图认不出来"，累计两次就把几十张图全删了。
  // 而"整批都认不出来"显然不是图片的问题，是系统性问题。所以：
  //   ① 单次整理的删除数量设硬上限（默认 25 张）—— 手滑/异常都不可能一次清库
  //   ② 整批全灭 → 判定为可疑（多半是模型/网络问题），**本次不再自动删除**
  const deleteCap = 25;
  const SUSPICIOUS_RATIO = 0.5;

  for (let i = 0; i < pending.length; i += c.organizeBatchSize) {
    const batch = pending.slice(i, i + c.organizeBatchSize);
    // 画面没变就不用再看一遍：上次已经看过、看到的还是同一张画面，重复请求纯属白花钱。
    // （指纹按抽帧后的像素算，所以"动图被改过"也能识别出来。）
    const fresh = [];
    for (const it of batch) {
      let fp = '';
      try {
        const buf = fs.readFileSync(it.path);
        const isGif = (sniffImage(buf) || it.ext) === 'gif';
        const probe = isGif ? extractGifFrames(buf, 1) : null;
        fp = probe && probe.length
          ? frameFingerprint(probe[0].dataUrl)
          : frameFingerprint(`data:image/${it.ext === 'jpg' ? 'jpeg' : (it.ext || 'png')};base64,${buf.toString('base64')}`);
      } catch { fp = ''; }
      if (!dryRun && fp && it.tagFp && it.tagFp === fp && (it.tagFails || 0) >= c.organizeMaxAttempts) {
        // 同一画面已经认够次数了 → 不再重复请求
        out.failed += 1;
        out.deleted.push({ id: shortId(it), fails: it.tagFails, ext: it.ext });
        if (c.organizeOnTagFail === 'delete') removeItem(it.key);
        continue;
      }
      if (fp) it.__fp = fp;
      fresh.push(it);
    }
    if (!fresh.length) continue;
    let res;
    try {
      res = await recognizeBatch(fresh);
    } catch (error) {
      // 整批失败（密钥/网络/模型不支持图）→ 记下来并停止，不要把剩下的全判成"认不出"
      out.errors.push(String(error?.message ?? error));
      break;
    }
    const byId = new Map();
    for (const r of res) {
      const id = clean(r?.id, 20).replace(/^#/, '');
      if (id) byId.set(id, r);
    }

    // ── 保险②：整批都认不出来 = 系统性问题，不是这些图的问题 ──
    // 必须在**删除之前**判定：先看这批的失败比例，再决定这批允不允许自动删。
    // 否则"模型抽风 → 整批判为认不出 → 全删"就成了一条不归路。
    const judgedOk = res.filter((r) => r && !r.skip && ((Array.isArray(r.tags) && r.tags.length) || clean(r.note, 40))).length;
    const batchSuspicious = fresh.length >= 3 && (fresh.length - judgedOk) / fresh.length >= SUSPICIOUS_RATIO;
    if (batchSuspicious) {
      out.suspicious = true;
      out.suspiciousReason = `一批 ${fresh.length} 张里有 ${fresh.length - judgedOk} 张没认出来 —— 更像模型/网关的问题，这批已跳过自动删除（只记失败次数）`;
    }

    for (const it of fresh) {
      const r = byId.get(shortId(it)) || null;
      let tags = Array.isArray(r?.tags) ? r.tags.map(normalizeTag).filter(Boolean).slice(0, MAX_TAGS) : [];
      let note = clean(r?.note, MAX_NOTE_CHARS);
      const text = clean(r?.text, MAX_TEXT_CHARS);

      // ── 用户要求：**整理时必须给每张图一个说法**，不能留空 ──
      // 模型有时会说"看不出是什么"（skip）或干脆漏掉某张。这种情况下不再当作"失败"，
      // 而是**强行赋予一个兜底标注**，保证库里不会有"什么信息都没有"的图：
      //   · 图上有文字 → 用文字本身当线索（"图上写着「嗯嗯」"）
      //   · 有来源上下文 → 用它
      //   · 什么都没有 → 老实标成「无意义」（这就是"实在找不到"的那种图）
      const weak = !r || r.skip === true || (!tags.length && !note);
      if (weak) {
        const fallbackText = text || clean(it.text, MAX_TEXT_CHARS);
        const hint = clean(it.srcHint, 40);
        if (fallbackText) {
          tags = ['其他'];
          note = `图上写着「${fallbackText}」`;
        } else if (hint) {
          tags = ['其他'];
          note = `看不出具体内容，${hint}`;
        } else {
          // 真的判断不出 → 明确标记"无意义"。
          // 用这个标签而不是留空，是为了让"有没有意义"这件事**可查、可筛、可清理**：
          // 挑图时不会被选中（tagFails 照常累计），页面上也能一眼看到有多少张这种图。
          tags = ['无意义'];
          note = '看不出有意义的内容（纯色块/乱码/残缺/无信息）';
        }
      }

      if (tags.length || note) {
        if (!dryRun) {
          it.tags = [...new Set([...it.tags, ...tags])].slice(0, MAX_TAGS);
          if (note) it.note = note;
          if (text) it.text = text;
          it.source = 'model';
          it.tagTriedAt = Date.now();
          it.tagFp = it.__fp || '';
          // 「无意义」的仍然记账失败次数：这样 organizeOnTagFail='delete' 时
          // 它照样会在累计到阈值后被清掉（既标了记、又保留了清理能力）。
          if (tags.includes('无意义')) it.tagFails = (it.tagFails || 0) + 1;
          else it.tagFails = 0;
        }
        if (tags.includes('无意义')) out.meaningless = (out.meaningless || 0) + 1;
        out.tagged += 1;
        continue;
      }

      // 认不出来 → 累计失败次数
      if (!dryRun) {
        it.tagFails = (it.tagFails || 0) + 1;
        it.tagTriedAt = Date.now();
        it.tagFp = it.__fp || '';
      }
      const fails = (it.tagFails || 0) + (dryRun ? 1 : 0);
      out.failed += 1;
      const wantDelete = c.organizeOnTagFail === 'delete' && fails >= c.organizeMaxAttempts;
      if (wantDelete && batchSuspicious) {
        // 本批可疑 → 不删，只记账（下次模型正常时再判）
        out.retried += 1;
      } else if (wantDelete && out.deleted.length >= deleteCap) {
        // 保险①：单次整理的删除总量封顶，异常情况下也不可能一次清库
        out.deletedCapped += 1;
        out.retried += 1;
      } else if (wantDelete) {
        out.deleted.push({ id: shortId(it), fails, ext: it.ext });
        if (!dryRun) removeItem(it.key);
      } else {
        out.retried += 1;
      }
    }
    if (!dryRun) { libDirty = true; flushLib(true); }

    // 进度回调：界面上那个按钮要靠它显示"已看 N/M"
    try { opts.onProgress?.(Math.min(out.tagged + out.failed, out.considered), out.considered); } catch { /* 进度上报失败不影响整理 */ }
  }
  if (!dryRun) { libDirty = true; flushLib(true); }
  return out;
}

/** 立刻跑一次"删除最早 N 张"（按钮用）。删除很快，但走同一套"长任务+进度"机制，界面体验一致。 */
const purgeRun = {
  running: false, startedAt: 0, finishedAt: 0, done: 0, considered: 0,
  deleted: 0, result: '', error: '', last: null
};

export function purgeRunStatus() {
  return {
    running: purgeRun.running,
    startedAt: purgeRun.startedAt,
    finishedAt: purgeRun.finishedAt,
    done: purgeRun.done,
    considered: purgeRun.considered,
    deleted: purgeRun.deleted,
    result: purgeRun.result,
    error: purgeRun.error,
    last: purgeRun.last,
    defaultCount: conf().deleteOldestCount,
    keep: conf().deleteOldestKeep,
    total: loadLib().items.length
  };
}

export function startPurgeRun(opts = {}) {
  if (purgeRun.running) return { ok: false, error: '已经有一次删除在跑了，等它结束' };
  const c = conf();
  const count = Math.round(clamp(opts.count, 1, 500, c.deleteOldestCount));
  const dryRun = opts.dryRun === true;
  purgeRun.running = true;
  purgeRun.startedAt = Date.now();
  purgeRun.finishedAt = 0;
  purgeRun.considered = count;
  purgeRun.done = 0;
  purgeRun.deleted = 0;
  purgeRun.result = '';
  purgeRun.error = '';
  Promise.resolve()
    .then(() => {
      const r = deleteOldestItems({ count, dryRun, keep: c.deleteOldestKeep });
      purgeRun.deleted = r.deleted.length;
      purgeRun.done = r.deleted.length;
      purgeRun.considered = r.deleted.length || count;
      purgeRun.result = deleteOldestReport(r);
    })
    .catch((error) => {
      purgeRun.error = String(error?.message ?? error);
      purgeRun.result = `删除失败：${purgeRun.error}`;
    })
    .finally(() => {
      purgeRun.running = false;
      purgeRun.finishedAt = Date.now();
      purgeRun.last = { at: purgeRun.finishedAt, deleted: purgeRun.deleted, result: purgeRun.result, error: purgeRun.error };
    });
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// 表情库页面（"打开表情库"按钮）用的数据接口
// ═══════════════════════════════════════════════════════════════════════════
//
// 插件不能注册 HTTP 路由，所以由核心的 src/sticker-library.js 提供路由，
// 这里只负责"给数据"和"执行删除" —— 逻辑仍然全在插件里。

/** 页面需要的库快照（含统计）。 */
export function librarySnapshot() {
  const c = conf();
  const l = loadLib();
  const items = l.items.map((it, idx) => ({
    id: shortId(it),
    key: it.key,
    // 完整文件路径：页面上要显示、也要用它"在文件夹中显示"（核心会校验必须在库目录内）
    path: it.path || '',
    tags: it.tags || [],
    note: it.note || '',
    text: it.text || '',
    ext: it.ext || '',
    bytes: it.bytes || 0,
    animated: it.animated === true,
    frames: it.gifFrames || 1,
    createdAt: num(it.createdAt, 0),
    sent: (it.sentCount || 0) + (it.useCount || 0),
    lastSentAt: num(it.usedAt, 0),
    chatName: it.chatName || '',
    tagFails: it.tagFails || 0,
    index: idx
  }));
  return {
    ok: true,
    version: PLUGIN_VERSION,
    // 实际目录路径也带上：页面上显示出来，用户才知道图到底存在哪
    imageDir: IMG_DIR,
    dataDir: DIR,
    total: items.length,
    bytes: items.reduce((s, x) => s + x.bytes, 0),
    tagged: items.filter((x) => x.tags.length || x.note).length,
    animated: items.filter((x) => x.animated).length,
    neverSent: items.filter((x) => !x.sent).length,
    deleteOldestCount: c.deleteOldestCount,
    deleteOldestKeep: c.deleteOldestKeep,
    counters: l.counters || {},
    items
  };
}

/** 按内容哈希取一张图的字节（页面缩略图/大图用）。 */
export function libraryImageBytes(src) {
  const want = String(src || '').trim().toLowerCase();
  if (!/^[0-9a-f]{8,64}$/.test(want)) return null;
  const l = loadLib();
  const hit = l.items.find((it) => String(it.src || '').toLowerCase() === want
    || shortId(it).toLowerCase() === want
    || String(it.key || '').toLowerCase().includes(want));
  if (!hit?.path) return null;
  try {
    return { bytes: fs.readFileSync(hit.path), ext: hit.ext || 'png' };
  } catch { return null; }
}

/** 页面里手动删除若干张（按内容哈希或短 id）。 */
export function libraryDelete(ids) {
  const list = Array.isArray(ids) ? ids.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean) : [];
  if (!list.length) return { ok: false, error: '没有指定要删的图' };
  loadLib();
  const removed = [];
  const missing = [];
  for (const want of list) {
    const hit = lib.items.find((it) => String(it.src || '').toLowerCase() === want
      || shortId(it).toLowerCase() === want
      || String(it.key || '').toLowerCase() === want);
    if (!hit) { missing.push(want); continue; }
    removed.push({ id: shortId(hit), tags: hit.tags || [], bytes: hit.bytes || 0 });
    removeItem(hit.key);
  }
  libDirty = true;
  flushLib(true);
  return {
    ok: true,
    removed: removed.length,
    freedBytes: removed.reduce((s, x) => s + x.bytes, 0),
    missing: missing.length,
    total: loadLib().items.length
  };
}

// ─────────────────────────────────────────────── 表现报表（奖励系统的观察窗口）

const REPORT_FILE = 'reward-report.txt';

/** 与选择逻辑里的 interactionReward 同一套算法（绝不两处各写一份）。 */
function rewardOfItem(x) {
  const n = num(x.interactShown, 0);
  if (!n) return null;
  return interactionReward((x.interactUsers || 0) / n, (x.interactReplies || 0) / n);
}

/**
 * 生成"表情包库表现报表"：哪些图真的能引起群友回应。
 *
 * 为什么要有它：用户方案第 4 条要求"奖励必须影响下一次选择"——
 * 这份报表就是验证它有没有在起作用的依据（互动均值高的图，奖励系统会优先选）。
 * 同时把报表**写成文件**（data/sticker-steal/reward-report.txt），便于留档对比。
 */
function libraryReportText() {
  const l = loadLib();
  const items = l.items;
  const L = [];
  const p = (s) => L.push(s);
  const sid = (x) => shortId(x);

  const sentTotal = num(l.sentTotal, 0) || items.reduce((a, x) => a + num(x.sentCount, 0), 0);
  const sentItems = items.filter((x) => num(x.sentCount, 0) > 0);
  const shown = items.filter((x) => num(x.interactShown, 0) > 0);
  const discovered = items.filter((x) => (x.tags && x.tags.length) || x.note);

  p(`库内 ${items.length} 张（动图 ${items.filter((x) => x.animated).length}）`);
  p(`已认识 ${discovered.length} 张｜记了图上文字 ${items.filter((x) => x.text).length} 张`);
  p(`被发过 ${sentItems.length} 张，累计发出 ${sentTotal} 次`);
  p(`有互动统计的 ${shown.length} 张  ← 奖励系统的数据源`);

  if (!shown.length) {
    p('');
    p('⚠️ 还没有互动统计数据。');
    p('  互动结算是"发出表情 → 等 3 分钟 → 回看这段时间的群友回应"，');
    p('  所以下一次发表情之后 3 分钟，这里就会有第一批数据。');
  } else {
    const rows = shown.map((x) => ({ x, n: num(x.interactShown, 0), rew: rewardOfItem(x) }))
      .sort((a, b) => b.rew - a.rew);
    const hot = rows.filter((r) => r.rew >= 0.1875);
    const warm = rows.filter((r) => r.rew >= 0.0625 && r.rew < 0.1875);
    const cold = rows.filter((r) => r.rew === 0);
    p('');
    p(`🏆 带动气氛 ${hot.length} 张｜🙂 有回应 ${warm.length} 张｜💤 无人搭理 ${cold.length} 张`);
    p('');
    p('表现最好的（单次互动奖励均值）：');
    for (const r of rows.slice(0, 12)) {
      const tags = (r.x.tags || []).join('/') || '未分类';
      p(`  #${sid(r.x)} ${r.rew.toFixed(3)} [${tags}] ${clean(r.x.note || r.x.text, 40)}（${r.n}次统计）`);
    }
    if (cold.length) {
      p('');
      p(`从没引起回应的 ${cold.length} 张：${cold.slice(0, 10).map((r) => `#${sid(r.x)}(${r.n}次)`).join('、')}`
        + (cold.length > 10 ? ` 等 ${cold.length} 张` : ''));
    }
  }

  const hotSent = items.filter((x) => num(x.sentCount, 0) >= 2).sort((a, b) => num(b.sentCount, 0) - num(a.sentCount, 0));
  p('');
  p('被发得最多的图（模型偏好）：');
  if (!hotSent.length) p('  （还没有发过 2 次以上的图）');
  for (const x of hotSent.slice(0, 10)) {
    p(`  #${sid(x)} 发过 ${num(x.sentCount, 0)} 次｜${x.animated ? '动图' : '静态'}｜标签 ${(x.tags || []).join('/') || '未分类'}`
      + `｜互动 ${num(x.interactShown, 0) ? `均值 ${rewardOfItem(x).toFixed(3)}` : '（暂无统计）'}`);
  }

  p('');
  p(`未分类 ${items.filter((x) => !((x.tags && x.tags.length) || x.note)).length} 张｜`
    + `标「无意义」${items.filter((x) => (x.tags || []).includes('无意义')).length} 张｜`
    + `从没被发过 ${items.filter((x) => !num(x.sentCount, 0)).length} 张`);
  // 顺手落盘一份留档
  try {
    fs.writeFileSync(path.join(DIR, REPORT_FILE), `${L.join('\n')}\n`, 'utf8');
  } catch { /* 写不了就只回文本 */ }
  return L.join('\n');
}

/** 把整理结果说成人话。 */
function organizeReport(out) {
  const lines = [];
  lines.push(`整理完成：看了 ${out.considered} 张，**全部给出了标注**（${out.tagged} 张）。`);
  // 用户要求：每张图都必须有意义，实在找不到的标成「无意义」而不是留空 ——
  // 所以要把"真判断不出内容"的数量如实报出来（那才是该清理的对象）。
  if (out.meaningless) {
    lines.push(`其中 ${out.meaningless} 张被标为**「无意义」**（看不出有任何内容：纯色块/乱码/残缺）。`
      + '这类图挑图时不会被选中；累计达到阈值后按「整理时认不出的图」的处理方式走（当前设置：'
      + (conf().organizeOnTagFail === 'delete' ? '删除' : '保留') + '）。');
  }
  if (out.deleted.length) {
    lines.push(`删除 ${out.deleted.length} 张（${out.dryRun ? '试运行，未真删' : '已删'}）：多次确认无意义 —— `
      + out.deleted.slice(0, 8).map((d) => `${d.id}(失败${d.fails}次)`).join('、')
      + (out.deleted.length > 8 ? ` 等 ${out.deleted.length} 张` : ''));
  }
  if (out.retried) lines.push(`还有 ${out.retried} 张累计了「无意义」次数；达到 ${conf().organizeMaxAttempts} 次会按设置处理。`);
  // ── 两道保险的提示：让"这次为什么没删"有明确解释 ──
  if (out.suspicious) {
    lines.push(`⚠️ 已跳过自动删除：${out.suspiciousReason || '本批失败比例过高'}。`
      + '这通常不是图片的问题，建议稍后重试一次；确认是模型/网络恢复后再跑。');
  }
  if (out.deletedCapped) {
    lines.push(`⚠️ 有 ${out.deletedCapped} 张达到删除条件但**没有删**：单次整理最多删 25 张（防止一次异常清空整个库）。再点一次可以继续处理。`);
  }
  if (out.errors.length) lines.push(`⚠️ 中断原因：${out.errors[0]}（剩下的没动）`);
  if (!out.considered) lines.push('库里没有"还没认识"的表情包，不用整理。');
  return lines.join('\n');
}

/**
 * 精确去重：按**图片字节内容**找完全一样的图，只留一张。
 *
 * 为什么按内容而不是按指纹键：库里的 items 本来就是按字节 sha1 建键的，
 * 但历史数据（或手改过 index.json）里可能出现同一张图存了两条。这里以
 * **实际文件字节**为准重算一遍，不信任索引 —— 索引错了就会漏删或误删。
 *
 * 保留策略：优先留"有标签/备注"的，其次留"被发过/用过"的，最后留"先入库的"。
 * 被删的那张如果有标签而留下的没有，会把标签合并过去（不丢信息）。
 */
function dedupeExact(dryRun = false) {
  loadLib();
  const byHash = new Map();
  const removed = [];
  let merged = 0;
  for (const it of [...lib.items]) {
    let hash = '';
    try {
      if (!it.path || !fs.existsSync(it.path)) continue;
      hash = sha1(fs.readFileSync(it.path));
    } catch { continue; }
    const prev = byHash.get(hash);
    if (!prev) { byHash.set(hash, it); continue; }

    // 打分：有标签 > 被发过 > 先入库
    const score = (x) => ((x.tags?.length || x.note) ? 1000 : 0) + (x.sentCount || 0) * 10 + (x.useCount || 0);
    const keep = score(prev) >= score(it) ? prev : it;
    const drop = keep === prev ? it : prev;
    byHash.set(hash, keep);
    // 把要删的那张的信息尽量合并到留下的那张上，别把标签一起删掉
    try {
      const addTags = (drop.tags || []).filter((t) => !(keep.tags || []).includes(t));
      if (addTags.length) {
        const before = (keep.tags || []).length;
        keep.tags = [...new Set([...(keep.tags || []), ...addTags])].slice(0, MAX_TAGS);
        if (keep.tags.length !== before) merged += 1;
      }
      if (!keep.note && drop.note) { keep.note = drop.note; merged += 1; }
      if (!keep.text && drop.text) keep.text = drop.text;
      keep.sentCount = (keep.sentCount || 0) + (drop.sentCount || 0);
      keep.useCount = (keep.useCount || 0) + (drop.useCount || 0);
    } catch { /* 合并失败不影响删除 */ }
    removed.push({ id: shortId(drop), sameAs: shortId(keep), bytes: drop.bytes || 0 });
    if (!dryRun) removeItem(drop.key);
  }
  if (!dryRun && removed.length) { libDirty = true; flushLib(true); }
  return { removed, merged, kept: byHash.size };
}

/**
 * 清理表情库：① 精确去重（图片完全一样）② 清掉"确认没有意义"的图。
 *
 * ⚠️ 顺序很重要，而且这是被用户提醒后才想清楚的：
 *    如果先删"没标签的"，会把**所有还没整理过的图**一次清空（新库里 90% 都没标签）。
 *    所以必须是：先去重 → 再删"没有标签 **且** 已经确认过认不出来"的。
 *    绝不按"没标签"就删 —— 那等于把自动收集的成果全扔了。
 *
 * @param {object} opts
 * @param {boolean} opts.dryRun      只报告不删（默认 true —— 会删东西的动作必须先看清楚）
 * @param {boolean} opts.forceUntagged 是否连带清理"从没整理过、也没标签"的图（默认 false）
 */
function cleanupLibrary(opts = {}) {
  const c = conf();
  const dryRun = opts.dryRun !== false;          // 默认试运行：删除类动作不给"手滑"的机会
  const result = { dryRun, duplicates: [], untagged: [], meaningless: [], merged: 0, scanned: 0, kept: 0, freedBytes: 0 };

  const before = lib.items.length;
  const dup = dedupeExact(dryRun);
  result.duplicates = dup.removed;
  result.merged = dup.merged;
  result.kept = dup.kept;
  result.scanned = before;

  // ① 精确重复占的空间
  for (const d of result.duplicates) result.freedBytes += d.bytes || 0;

  // ② 删「无意义」的图 —— 这是清理的核心职责（用户明确要求）。
  //
  //    为什么是删「无意义」而不是删"没标签"：
  //      「无意义」是**整理时逐张判定**得出的结论（纯色块/乱码/残缺/完全看不出内容），
  //      是个明确的"这张图没用"的判断；而"没标签"只代表"还没看过"——
  //      按那个删等于把自动收集的成果全扔掉（踩过这个设计陷阱）。
  //
  //    删除条件里仍要求 `tagFails >= 阈值`：整理会给「无意义」的图累加这个计数，
  //    所以它相当于"被独立判定过至少 N 次"，避免一次误判就把图删掉。
  //    阈值取 1 时就是"判一次就删"（整理默认阈值是 2）。
  const stale = lib.items.filter((it) => isMeaningless(it) && (it.tagFails || 0) >= c.organizeMaxAttempts);
  for (const it of stale) {
    result.meaningless.push({ id: shortId(it), fails: it.tagFails || 0, ext: it.ext, bytes: it.bytes || 0 });
    result.untagged.push({ id: shortId(it), fails: it.tagFails || 0, ext: it.ext, bytes: it.bytes || 0 });
    result.freedBytes += it.bytes || 0;
    if (!dryRun) removeItem(it.key);
  }

  // ③ 被标「无意义」但次数还不够的：留着记账（报告里说明，避免用户以为漏了）
  const pending = lib.items.filter((it) => isMeaningless(it) && (it.tagFails || 0) < c.organizeMaxAttempts);
  result.pendingMeaningless = pending.map((it) => ({ id: shortId(it), fails: it.tagFails || 0 }));

  // ③ 可选的激进档：连"从没整理过、也没标签"的一起清（默认关）
  if (opts.forceUntagged === true) {
    const never = lib.items.filter((it) => (!it.tags || !it.tags.length) && !it.note && !(it.tagFails > 0));
    for (const it of never) {
      result.untagged.push({ id: shortId(it), fails: 0, ext: it.ext, bytes: it.bytes || 0, never: true });
      result.freedBytes += it.bytes || 0;
      if (!dryRun) removeItem(it.key);
    }
  }

  if (!dryRun) { libDirty = true; flushLib(true); }
  result.afterCount = lib.items.length;
  return result;
}

/**
 * 一键删除**最早的** N 张表情（默认 25，可在设置里改）。
 *
 * "最早"按入库时间（createdAt）算，不是按最后使用时间 —— 用户说的是"最早的"，
 * 那就是库里躺得最久的那些。
 *
 * 安全设计（删除类功能必须想清楚"手滑会怎样"）：
 *   · `deleteOldestKeep` 保底：无论传多少，都至少留下这么多张（默认 10）。
 *     这样就算参数写错、或库里刚好很少，也不会被清空。
 *   · 优先删**从没被发过**的（sentCount/useCount 都为 0）：旧图里如果有真正常用的，
 *     不该因为"入库早"就被删掉。
 *   · 保底留存的那些从"最老的"里也让开：先挑没发过的老图，不够再动发过的。
 *
 * @param {object} opts { count?, dryRun? }
 */
function deleteOldestItems(opts = {}) {
  const c = conf();
  const dryRun = opts.dryRun === true;
  const keep = Math.max(0, Math.round(num(opts.keep, c.deleteOldestKeep)));
  loadLib();
  const total = lib.items.length;
  const want = Math.round(clamp(opts.count, 1, 500, c.deleteOldestCount));
  // 保底：最多只能删到剩 keep 张
  const allowed = Math.max(0, total - keep);
  const count = Math.min(want, allowed);

  const out = { dryRun, total, keep, want, count, allowed, deleted: [], freedBytes: 0, stopReason: '', afterCount: total };
  if (!count) {
    out.stopReason = total <= keep
      ? `库里只有 ${total} 张，已达到保底留存 ${keep} 张，没有可删的`
      : `没有可删的（保底留存 ${keep} 张）`;
    return out;
  }

  // 排序：① 从没被发过的优先删 ② 同组内入库时间早的优先
  const sorted = [...lib.items].sort((a, b) => {
    const aUsed = (a.sentCount || 0) + (a.useCount || 0) > 0 ? 1 : 0;
    const bUsed = (b.sentCount || 0) + (b.useCount || 0) > 0 ? 1 : 0;
    if (aUsed !== bUsed) return aUsed - bUsed;
    return num(a.createdAt, 0) - num(b.createdAt, 0);
  });

  for (const it of sorted) {
    if (out.deleted.length >= count) break;
    out.deleted.push({
      key: it.key,
      id: shortId(it),
      createdAt: num(it.createdAt, 0),
      sent: (it.sentCount || 0) + (it.useCount || 0),
      bytes: it.bytes || 0,
      tags: it.tags || []
    });
    out.freedBytes += it.bytes || 0;
    if (!dryRun) removeItem(it.key);
  }
  if (!dryRun) { libDirty = true; flushLib(true); }
  out.afterCount = lib.items.length;
  const kept = sorted.length - out.deleted.length;
  out.stopReason = out.deleted.length < want
    ? `只删了 ${out.deleted.length} 张（要删 ${want}，但保底要留 ${keep} 张）`
    : '';
  void kept;
  return out;
}

/** 把"删除最早 N 张"的结果说成人话。 */
function deleteOldestReport(r) {
  const mb = (b) => `${(b / 1048576).toFixed(1)}MB`;
  const when = (ts) => (ts ? new Date(ts).toLocaleString('zh-CN') : '（无记录）');
  const left = typeof r.afterCount === 'number' ? r.afterCount : r.total - r.deleted.length;
  const lines = [];
  if (!r.deleted.length) {
    // "删了 0 张"这种话对人没信息量 —— 直接说清为什么没删
    lines.push(`${r.dryRun ? '【试运行】' : '【已执行】'}没有删除任何图。库里共 ${r.total} 张。`);
    if (r.stopReason) lines.push(`原因：${r.stopReason}`);
    return lines.join('\n');
  }
  lines.push(`${r.dryRun ? '【试运行，什么都没删】' : '【已执行】'}库里原有 ${r.total} 张，`
    + `本次删除**最早**的 ${r.deleted.length} 张（保底留 ${r.keep} 张，删后剩 ${left} 张），释放约 ${mb(r.freedBytes)}。`);
  lines.push('最早的一批（入库时间 → 发过几次）：');
  for (const d of r.deleted.slice(0, 8)) {
    lines.push(`  ${d.id}  ${when(d.createdAt)}  发过 ${d.sent} 次  ${(d.bytes / 1024).toFixed(0)}KB${d.tags.length ? '  标签:' + d.tags.join('/') : ''}`);
  }
  if (r.deleted.length > 8) lines.push(`  …等共 ${r.deleted.length} 张`);
  if (r.stopReason) lines.push(`说明：${r.stopReason}`);
  if (r.dryRun) lines.push('确认没问题后再点一次（界面上那个按钮是真删）。');
  return lines.join('\n');
}

/** 把清理结果说成人话。 */
function cleanupReport(r) {
  const mb = (b) => `${(b / 1048576).toFixed(1)}MB`;
  const lines = [];
  const after = r.dryRun
    ? r.scanned - r.duplicates.length - r.untagged.length
    : (typeof r.afterCount === 'number' ? r.afterCount : r.scanned - r.duplicates.length - r.untagged.length);
  lines.push(`${r.dryRun ? '【试运行，什么都没删】' : '【已执行】'}扫了 ${r.scanned} 张。`);
  // ⚠️ 数量一律写出来（哪怕 0）—— 界面上那个结果框只有几行，
  //    "没有"和"0 张"对人没区别，但对"机器读报告"和"一眼看数量"区别很大。
  lines.push(`① 完全重复的图：${r.duplicates.length} 张${r.duplicates.length ? '要删' : '（没有）'}`
    + (r.duplicates.length ? `，只留信息最全的那张（${r.merged ? `已把 ${r.merged} 处标签合并过去，` : ''}`
      + `占 ${mb(r.duplicates.reduce((s, d) => s + (d.bytes || 0), 0))}）` : ''));
  if (r.duplicates.length) {
    lines.push('   ' + r.duplicates.slice(0, 6).map((d) => `${d.id} = ${d.sameAs}`).join('、')
      + (r.duplicates.length > 6 ? ` 等 ${r.duplicates.length} 张` : ''));
  }
  const staleOnes = r.meaningless || r.untagged.filter((u) => !u.never);
  const pending = r.pendingMeaningless || [];
  lines.push(`② 标着「无意义」的图：${staleOnes.length} 张${staleOnes.length ? '要删' : '（没有）'}`
    + (staleOnes.length ? `（整理时逐张判定为"看不出任何内容"的图）` : ''));
  if (staleOnes.length) {
    lines.push('   ' + staleOnes.slice(0, 8).map((d) => `${d.id}(判${d.fails}次)`).join('、')
      + (staleOnes.length > 8 ? ` 等 ${staleOnes.length} 张` : ''));
  }
  if (pending.length) {
    lines.push(`  另有 ${pending.length} 张标了「无意义」但判定次数还不够（${pending.slice(0, 5).map((d) => `${d.id}(${d.fails})`).join('、')}）——`
      + ' 它们挑图时已经被排除，再点一次「整理表情库」确认后就会被清掉。');
  }
  if (!staleOnes.length && !pending.length) {
    lines.push('   （库里目前没有被判为「无意义」的图 —— 先点「🧽 整理表情库」逐张判定后，这里才会有东西可删。）');
  }
  lines.push(`合计可释放约 ${mb(r.freedBytes)}；库里 ${r.scanned} → ${after} 张。`);
  if (r.dryRun) lines.push('确认没问题后，再点一次并选择"真删"（界面上那个按钮是真删；也可以对我说"确认删除"）。');
  return lines.join('\n');
}

/**
 * 媒体键 → 内容哈希 的**跨轮缓存**。
 *
 * 为什么必须有它：按"使用次数"排名就**必须**先知道每张图的内容哈希，而哈希只能
 * 下载字节来算。同一张表情在群里会被反复发，如果每轮都重新下载，代价无法接受
 * （实测：一个活跃群 20 分钟里就有几十次表情出现）。
 * 有了它，同一张图（同一个媒体键）整个进程只下载一次，频率统计才便宜到能放进
 * "聊天时顺带收"这种每 20 秒就会跑一次的地方。
 *
 * 内存有界：超过上限按插入顺序淘汰最旧的（Map 天然有序）。
 */
const HASH_CACHE_MAX = 1500;
const mediaHashCache = new Map();      // mediaKey → src(sha1)

function cacheHash(key, src) {
  if (!key || !src) return;
  if (mediaHashCache.size >= HASH_CACHE_MAX) {
    const oldest = mediaHashCache.keys().next().value;
    if (oldest !== undefined) mediaHashCache.delete(oldest);
  }
  mediaHashCache.set(key, src);
}

/** 把一张媒体解析成内容哈希（先查缓存）。 */
async function resolveSrc(media, key, maxBytes) {
  if (key && mediaHashCache.has(key)) return mediaHashCache.get(key);
  const buf = await fetchImageBytes(media, maxBytes);
  if (!buf || !buf.length) return null;
  const src = sha1(buf);
  cacheHash(key, src);
  return src;
}

/**
 * 按「被使用的次数」收集表情包 —— 与"按时间倒序捞"不同，这个要**统计频率**。
 *
 * 逻辑（用户定的规则）：
 *   1. 只看最近 N 小时内的消息（N 由调用方给）
 *   2. 把窗口里出现过的表情按**图片内容**归类，数每个内容出现了几次
 *   3. 按出现次数从大到小排列
 *   4. 依次收集；**已经在库里的直接跳过，顺延到下一个**
 *   5. 收集不到足够的数量就**终止**（不硬凑、不报错）
 *
 * ⚠️ 这里踩过一个把功能搞反的坑（写下来免得再犯）：早先按"媒体键"去重，
 *    于是同一张表情在 10 条消息里出现 10 次只算 1 次 → 排名全变成"各 1 次"，
 *    "按使用次数排"直接失效。现在不去重；重复的图靠 mediaHashCache 避免重复下载，
 *    靠内容哈希去重避免重复入库。
 *
 * @param {object} opts
 * @param {number} opts.hours     往回看多少小时
 * @param {number} opts.limit     最多收几张
 * @param {number} opts.maxCandidates 候选下载上限（防止活跃群一次拉几百张）
 * @param {number} opts.sinceTs   只考虑这个时间之后的消息（定时任务用：上次收集之后的新消息）
 * @param {object} opts.store
 * @param {string} opts.chatKey
 * @param {function} opts.onProgress
 */
async function collectTopUsed(opts = {}) {
  const store = opts.store;
  const chatKey = String(opts.chatKey || '');
  const hours = clamp(opts.hours, 1, 24 * 365, 24);
  const limit = Math.round(clamp(opts.limit, 1, 60, 10));
  const maxCandidates = Math.round(clamp(opts.maxCandidates, 10, 2000, 200));
  const sinceTs = num(opts.sinceTs, 0);
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const out = { hours, limit, scanned: 0, candidates: 0, unique: 0, already: 0, collected: 0, failed: 0, stopReason: '' };

  if (!store?.recent || !chatKey) { out.stopReason = '读不到聊天存档'; return out; }
  loadLib();

  // 1) 取时间窗内的消息（多取一些才够统计；上限 2000 防卡顿）
  const want = Math.min(2000, Math.max(200, Math.round(hours * 40)));
  let recent = [];
  try { recent = store.recent(chatKey, { limit: want, includeSelf: false }) || []; } catch { recent = []; }
  const windowMs = hours * 3600_000;
  const list = recent.filter((e) => withinWindow(e, windowMs)
    && (!sinceTs || num(e?.ts ?? e?.at, 0) > sinceTs));   // 定时任务只看"上次收集之后"的新消息
  out.scanned = list.length;

  // 2) 收集候选媒体：**每次出现都算一次**（这是"使用次数"的来源）
  //
  // ⚠️ 这里踩过一个把功能搞反的坑：早先按"媒体键"去重，于是同一张表情在 10 条消息里
  //    出现 10 次只算 1 次 → 排名全变成"各 1 次"，"按使用次数排"直接失效。
  //    现在每次都计数；同一张图靠 mediaHashCache 只下载一次。
  const all = [];
  for (const e of list) {
    for (const m of (Array.isArray(e.media) ? e.media : [])) {
      if (!isImageMedia(m)) continue;
      if (conf().stickerOnly && !isLikelySticker(m)) continue;
      const key = mediaKeyOf(m);
      if (!key) continue;
      all.push({ key, media: m, ts: num(e?.ts ?? e?.at, 0) });
    }
  }
  out.candidates = all.length;
  if (!all.length) { out.stopReason = '窗口内没有新的候选表情'; return out; }

  // 候选下载上限：活跃群一次可能有几百次出现，全下一遍太重（尤其是"聊天时顺带收"那条路）。
  // 先去掉**库里已有的**（省下载），再按"最近的优先"截断。
  const cands = [];
  for (const c of all) {
    if (findItem(c.key) || (c.key && mediaHashCache.has(c.key) && findBySrc(mediaHashCache.get(c.key)))) {
      out.already += 1;
      continue;
    }
    cands.push(c);
  }
  cands.sort((a, b) => b.ts - a.ts);
  const capped = cands.slice(0, maxCandidates);
  out.capped = cands.length > capped.length ? cands.length - capped.length : 0;

  // 3) 下载算内容哈希 → 按内容归类**计数**
  const maxBytes = Math.min(HARD_MAX_ITEM_BYTES, Math.round(conf().maxItemMb * 1048576));
  const byHash = new Map();          // src → { src, count, sample, lastTs }
  const CONCURRENCY = 4;
  let done = 0;
  for (let i = 0; i < capped.length; i += CONCURRENCY) {
    const slice = capped.slice(i, i + CONCURRENCY);
    await Promise.all(slice.map(async (c) => {
      try {
        const src = await resolveSrc(c.media, c.key, maxBytes);   // 命中 mediaHashCache 就不下载
        if (!src) { out.failed += 1; return; }
        const rec = byHash.get(src);
        if (rec) { rec.count += 1; if (c.ts > rec.lastTs) { rec.lastTs = c.ts; rec.sample = c; } }
        else byHash.set(src, { src, count: 1, sample: c, lastTs: c.ts });
      } catch { out.failed += 1; }
    }));
    done += slice.length;
    onProgress('download', done, capped.length);
  }

  // 4) 按出现次数从大到小排序（次数相同取更近的）
  const ranked = [...byHash.values()].sort((a, b) => b.count - a.count || b.lastTs - a.lastTs);
  out.unique = ranked.length;
  // 把排名前几名的"次数"带出来：报告里显示它，既能一眼看出排名对不对，
  // 也能解释"为什么这次只收了这几张"。
  out.top = ranked.slice(0, 5).map((r) => ({ src: r.src.slice(0, 8), count: r.count, already: !!findBySrc(r.src) }));

  // 5) 依次收集：已在库里的跳过并顺延；收集不到足够的就终止
  //
  // ⚠️ 这里**直接调 ingest**，不走 enqueue 队列 —— 踩过的坑：
  //    enqueue 有个"已排队过就不再排队"的防重复集合（queuedOnce/queueKeys），
  //    而"按频率收集"会**跨轮次反复遇到同一批图**（今天收过、明天还要再统计一遍），
  //    于是第二轮会被那个标记误判成"已处理"而静默跳过 → 表现为"收到 0 张"。
  //    直接 ingest 还有个好处：不用再等后台队列，结果当次就是准的。
  for (const r of ranked) {
    if (out.collected >= limit) break;
    if (findBySrc(r.src)) { out.already += 1; continue; }        // 内容已在库里 → 跳过、顺延
    try {
      await ingest({
        key: r.sample.key,
        file: clean(r.sample.media?.file, 120),
        media: r.sample.media,
        chatKey,
        chatName: String(opts.chatName || ''),
        source: `高频收集(${hours}h 内出现 ${r.count} 次)`
      });
    } catch (error) {
      out.failed += 1;
      warn(`高频收集入库失败：${error?.message ?? error}`);
      continue;
    }
    // ingest 内部会按内容哈希再判一次重（并发/竞态兜底），所以这里复查真实结果
    if (findBySrc(r.src)) out.collected += 1;
    else out.already += 1;
  }

  if (out.collected < limit) {
    out.stopReason = ranked.length <= out.collected + out.already
      ? `候选已用完（窗口内只有 ${ranked.length} 种不同的表情）`
      : `只找到 ${out.collected} 张可收的（其余要么已在库里、要么取不到字节）`;
  }
  return out;
}

/** 把高频收集的结果说成人话。 */
function topUsedReport(r) {
  const lines = [];
  lines.push(`按使用频率收集（最近 ${r.hours} 小时）：扫了 ${r.scanned} 条消息，`
    + `出现 ${r.candidates} 次表情候选、其中 ${r.unique} 种是没见过的。`);
  if (Array.isArray(r.top) && r.top.length) {
    // 把排名和次数显出来：这是"按次数收"最直接的证据，也解释了本次为什么收这几张
    lines.push('频率排名（前几）：' + r.top
      .map((t, i) => `${i + 1}.${t.src}×${t.count}次${t.already ? '(已有)' : ''}`)
      .join('　'));
  }
  lines.push(`实际收进 ${r.collected} 张；跳过已在库里的 ${r.already} 次${r.failed ? `，${r.failed} 张取不到字节` : ''}。`);
  if (r.stopReason) lines.push(`已按规则终止：${r.stopReason}（不会硬凑数量）。`);
  else lines.push(`已达到本次上限 ${r.limit} 张。`);
  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// 屏蔽 QQ Agent 原有的表情功能
// ═══════════════════════════════════════════════════════════════════════════
//
// 为什么需要这个：QQ Agent 自带一套表情包功能（收藏表情的收集/查看/发送），
// 它和本插件的本地库**直接冲突** —— 不屏蔽的话模型可能绕过本地库去发收藏表情，
// 用户看到的现象就是"每次发表情只发它自己库里的"。
//
// 「tool.guard」是宿主官方定义的扩展点（tool-registry.js 的 getToolAvailability 第 7 步）：
// 返回 {ok:false} 就把这个工具**从模型的可调用列表里整个移除** ——
// 模型不是"被劝说别用"，而是**根本看不见、也调不到**。这正是"自动屏蔽"该有的强度。
//
// ⚠️ 只屏蔽**表情专用**的工具：send_image / search_images 是"网图"能力（通用投图），
//    不属于表情功能，不该被这个开关牵连 —— 要关它们请用设置里的工具开关。
//    这是刻意的边界：屏蔽范围开得越大，越容易误伤用户其实还想要的能力。
const BUILTIN_STICKER_TOOLS = new Set([
  'send_sticker',        // 发送 QQ 收藏表情（最核心的冲突点）
  'list_stickers',       // 查看 QQ 收藏表情
  'collect_sticker',     // 把群里的表情收藏进 QQ 收藏
  'get_sticker_image',   // 取收藏表情的图片
  'sticker_note'         // 给收藏表情写备注
]);

/** 给被屏蔽的工具一句"替代方案在哪"的说明（会出现在工具的不可用原因里）。 */
function builtinBlockReason(toolId) {
  return `「${toolId}」已被「更好的表情包收集和发送」插件屏蔽：发表情请改用本地库（sticker-steal 的 pick_sticker → send_sticker_steal）。`
    + '想恢复 QQ 收藏表情：到「插件 → 更好的表情包收集和发送 → ⚙」把「屏蔽 QQ Agent 原有的表情功能」关掉，或把本插件停用。';
}

// ── 屏蔽"与表情包相似"的其它插件/技能 ────────────────────────────────────
//
// 用户要求："把其他的和我们相似的表情包插件屏蔽"。
//
// 为什么必须屏蔽（不是可选优化）：
//   同时装好几套表情系统时，实测出两个真问题：
//     ① **模型会编别家的编号**：它看到多套编号体系，于是自己拼出一个
//        `collected_-47957198` 这种根本不存在的 ID，发送必然失败。
//     ② **指令互相打架**：别的技能往提示词里写"发表情要从我库里挑"，
//        模型就嘴上答应、行动上放弃（"没有可用的表情包"）。
//
// 做法：**识别**而不是硬编码一份名单 —— 只要插件的 id/名称/描述/工具名里
// 带"表情/表情包/配图/梗/sticker/meme/emoji"这类词，且不是我们自己，就屏蔽它的工具。
// 这样以后新装一个类似的插件也会自动被挡，不会留下新的冲突源。
//
// ⚠️ 刻意**不屏蔽**通用图片能力（send_image / search_images 这类"网图"工具）：
//    它们不是表情功能，牵连进去会误伤用户其实还想要的能力。
const SELF_SKILL_ID = 'sticker-steal';
const SIMILAR_KEY = /表情|表情包|配图|梗图|sticker|meme|emoji/i;
const SIMILAR_ALLOW_TOOL = /^(send_image|search_images)$/;   // 通用投图/搜图：永远放行

/** 从工具 id 取出所属技能 id（`sticker-vault__send_local` → `sticker-vault`）。 */
function skillIdOfTool(toolId) {
  const s = String(toolId || '');
  const i = s.indexOf('__');
  return i > 0 ? s.slice(0, i) : '';
}

/**
 * 判断某个技能是不是"与表情包相似"的插件/技能。
 * 结果按 skillId 缓存（清单不会在运行中变），避免每次判工具都重新扫盘。
 */
const similarCache = new Map();
function isSimilarStickerSkill(skillId) {
  const id = String(skillId || '');
  if (!id) return false;
  if (id === SELF_SKILL_ID) return false;
  if (similarCache.has(id)) return similarCache.get(id);
  let hit = false;
  try {
    for (const root of [path.join(APP_DIR, 'plugins'), path.join(APP_DIR, 'skills')]) {
      for (const cand of [path.join(root, id, 'plugin.json'), path.join(root, id, 'skill.json')]) {
        if (!fs.existsSync(cand)) continue;
        const j = JSON.parse(fs.readFileSync(cand, 'utf8'));
        const tools = (j.tools || []).map((t) => (typeof t === 'string' ? t : (t.id || t.name))).filter(Boolean);
        const hay = `${j.id || id} ${j.name || ''} ${j.description || ''} ${tools.join(' ')}`;
        // 名称/描述命中关键词，或工具名自己带表情词（如 send_meme / list_stickers）
        hit = SIMILAR_KEY.test(hay) || tools.some((t) => SIMILAR_KEY.test(String(t)));
        if (hit) break;
      }
      if (hit) break;
    }
  } catch { hit = false; }
  similarCache.set(id, hit);
  return hit;
}

/** 给被屏蔽的相似插件一句说明。 */
function similarBlockReason(toolId) {
  const sid = skillIdOfTool(toolId);
  return `「${toolId}」已被「更好的表情包收集和发送」屏蔽：同时装着多套表情系统会让编号体系混乱（模型会编出不存在的 ID）。`
    + `本插件的库已经接管了发表情这件事（pick_sticker → send_sticker_steal）。`
    + `想恢复「${sid}」：到「插件 → 更好的表情包收集和发送 → ⚙」把「屏蔽其它表情包插件」关掉，或把本插件停用。`;
}

/** 这个工具要不要因为"相似插件屏蔽"被拦下。返回 true=拦。 */
function blockedAsSimilar(toolId) {
  const s = String(toolId || '');
  if (SIMILAR_ALLOW_TOOL.test(s)) return false;          // 通用投图/搜图放行
  const sid = skillIdOfTool(s);
  if (!sid) return false;                                 // 核心内置工具不走这条（另有 BUILTIN 名单管）
  return isSimilarStickerSkill(sid);
}

export const providers = {
  /**
   * 运行期守卫：**一个开关**屏蔽"其它表情系统"。
   *
   * 管两件事（用户要求合并成一个开关）：
   *   ① QQ Agent 原有的收藏表情工具
   *   ② 其它"与表情包相似"的插件/技能的工具
   * 关掉这个开关 → 两边都不管（用户想回到"多套系统并存"也是他的自由）。
   *
   * ⚠️ 守卫自身出错时**必须放行**（返回 undefined）—— 一个 bug 不该把整个工具列表塌掉。
   *    漏屏蔽一次只是"偶尔发错图"，绑住所有工具是灾难。
   */
  'tool.guard': (args = {}) => {
    try {
      const id = String(args?.toolId || '');
      if (!id) return undefined;
      const c = conf();
      if (!c.enabled) return undefined;                    // 本插件没启用 → 不干预
      if (c.blockOtherSticker === false) return undefined;  // 开关关掉 → 两边都不管

      // ① QQ Agent 原有的收藏表情工具
      if (BUILTIN_STICKER_TOOLS.has(id)) return { ok: false, reason: builtinBlockReason(id) };
      // ② 其它"与表情包相似"的插件/技能的工具
      if (blockedAsSimilar(id)) return { ok: false, reason: similarBlockReason(id) };
      return undefined;
    } catch {
      return undefined;
    }
  }
};

export const hooks = {
  /**
   * 每次工具调用之前：顺手抓住运行期的 OneBot 客户端。
   *
   * ⚠️ 这里为什么读 `session.ctx`：钩子载荷里**没有** ctx —— orchestrator.js:1140
   * 只传了公共 skillContext（chatKey/kind/chatId/model/visionEnabled/…）+ toolName/argsRaw/session。
   * 而收图要用 `get_image` 把 file 换成可读的本地文件，必须拿到 onebot。
   * 所以从 session 上找（本插件的工具执行时会挂，见 rememberRuntime）；找不到也不
   * 影响主路径 —— 有直链就走直链（fetchImageBytes 永远优先 URL）。
   *
   * 只做赋值，不做任何耗时动作：钩子有 5 秒硬超时。
   */
  'before-tool': ({ session }) => {
    try {
      if (session?.ctx?.onebot) onebotRef = session.ctx.onebot;
      if (session?.ctx?.sender) senderRef = session.ctx.sender;
    } catch { /* 拿不到就算了，收图会退回直链下载 */ }
  },

  /**
   * 组装提示词之前：聊天时**顺带**按使用频率收一批表情。
   *
   * ⚠️ 关键约束：钩子有 5 秒硬超时（manager.js DEFAULT_HOOK_TIMEOUT_MS），
   *    超了整段被跳过。所以这里**绝不能 await 网络**：
   *      · 只启动一个后台任务（fire-and-forget），钩子立刻返回；
   *      · 频率统计需要的下载，靠 mediaHashCache 摊薄 —— 同一张图整个进程只下一次。
   *
   * 用的是与按钮③、定时任务**完全同一套** collectTopUsed：
   * 按"出现次数"排名 + 跳过已在库里的 + 顺延 + 不够就停。
   * 区别只在参数：这里窗口小（collectWindowMin）、候选上限低（跑得勤，不必多收）。
   */
  'before-context': ({ store: chatStore, chatKey, chatName, kind }) => {
    try {
      const c = conf();
      if (!c.enabled) return;
      loadLib();
      flushLib();
      if (chatStore) runtimeStore = chatStore;   // 缓存给定时收集用（它要遍历所有会话）

      // 冷却：同一个会话 20 秒内不重复扫描（一个群里连着来好几条消息时省点算力）
      const now = Date.now();
      if (now - lastCollectAt < 20000) return;
      lastCollectAt = now;

      if (!chatStore?.recent || !chatKey) return;
      // 后台跑，不 await —— 钩子必须立刻返回，否则会被判定超时整段跳过
      void collectTopUsed({
        store: chatStore,
        chatKey,
        chatName,
        hours: Math.max(1, Math.round(c.collectWindowMin / 60)) || 1,
        limit: DEFAULT_COLLECT_PER_RUN,
        maxCandidates: 60          // 这条路跑得勤，别一次拉太多
      }).then((r) => {
        if (r.collected) log(`聊天时顺带收了 ${r.collected} 张最常用的表情（窗口 ${r.hours}h，候选 ${r.candidates}）`);
      }).catch((error) => {
        warn(`聊天时顺带收集失败（不影响对话）：${error?.message ?? error}`);
      });
    } catch (error) {
      warn(`before-context 排采集队列失败（不影响对话）：${error?.message ?? error}`);
    }
  },

  /**
   * 每次模型调用之后：把标签改动和额度落盘。
   * （工具的 send/tag 里已经 flush 过，这里只是兜住热重载前的最后一点脏数据。）
   */
  'after-response': () => {
    try {
      flushLib();
    } catch { /* 不影响对话 */ }
  }
};

/**
 * 每个会话的配图记账（"聊天配图频率"靠它落地）。
 *
 * 为什么要按会话分开：在 A 群聊得火热不应该把 B 群的额度也吃掉 ——
 * 频率是"每个群的体感"，全局一个计数器做不到这件事。
 * 只存最近用过的 200 个会话，防止长跑无限增长。
 */
const CHAT_STATS_MAX = 200;

function chatStat(l, chatKey) {
  const key = String(chatKey || '');
  if (!key) return null;
  if (!l.chatStats || typeof l.chatStats !== 'object') l.chatStats = {};
  let st = l.chatStats[key];
  if (!st || typeof st !== 'object') {
    st = { day: '', sentToday: 0, lastAt: 0, sentTotal: 0 };
    l.chatStats[key] = st;
    libDirty = true;          // ⚠️ 必须标脏，否则新建的记账不会落盘
  }
  // ⚠️ 下面这些"补字段"的初始化**一律要标脏**。
  //    踩过的坑：这些字段只在内存里补上、没标脏 → 永远不会写进 index.json，
  //    重启/热重载后全部丢失。表现就是"发言计数器看起来上线了，
  //    但 lastStickerAt 在文件里根本不存在"，排查时非常费劲。
  // 「最近 N 次发过的编号」——挑选时先排除它们（老数据没有这个字段，补上空数组）
  if (!Array.isArray(st.recentIds)) { st.recentIds = []; libDirty = true; }
  // 「最近发送时间戳」——用于"一般"档的"每分钟最多 N 张"硬上限
  if (!Array.isArray(st.recentAt)) { st.recentAt = []; libDirty = true; }
  // 「上次发表情的时间」——只用于**统计**"距上次表情过了多久"
  // （原来驱动"每 N 条文字强制配一张"的硬机制，已按用户要求撤掉）。
  // ⚠️ 新会话从当前时刻起算，不能用 0：用 0 会把历史所有自己发的消息都算进来，
  //    统计值会虚高（虽然不再影响放行，但排障时会被误导）。
  if (typeof st.lastStickerAt !== 'number' || !st.lastStickerAt) {
    st.lastStickerAt = Date.now();
    libDirty = true;
  }
  // 跨天重置
  if (st.day !== todayKey()) { st.day = todayKey(); st.sentToday = 0; libDirty = true; }
  // 超量时清掉最久没用的会话
  const keys = Object.keys(l.chatStats);
  if (keys.length > CHAT_STATS_MAX) {
    keys.sort((a, b) => num(l.chatStats[a]?.lastAt, 0) - num(l.chatStats[b]?.lastAt, 0));
    for (const k of keys.slice(0, keys.length - CHAT_STATS_MAX)) delete l.chatStats[k];
  }
  return st;
}

// ─────────────────────────────────────────────── 奖励系统（用户设计的方案）
//
// 总奖励上限 1.0：
//     R = 0.10·C + 0.25·E + R_互动(0.25) + 0.25·N + 0.15·D
//
//   C 语境相关性 0.10 —— 保证表情基本符合当下情境
//   E 发表情     0.25 —— 只要成功发出去就得分（没有发则 E=0）
//   R_互动       0.25 —— 群友的回应，鼓励发"能引起回应"的图
//   N 新颖度     0.25 —— 鼓励换图，解决"总发同一张"
//   D 使用均衡度 0.15 —— 避免长期只用少数几个
//
//   R_互动 = 0.125·min(U/3, 1) + 0.125·min(M/5, 1)
//     U = 回应这条表情的**不同群友人数**（满额参考 3 人）
//     M = 针对这条表情的**有效回复总数**（满额参考 5 条）
//
// ⚠️ **E 不参与选图**：选图发生在发送之前，那时"发没发出去"还不知道，
//    对所有候选都是同一个常数，加进去不会改变谁被选中。所以 E 的作用是
//    **发送后的记账**（写进图的历史），而选图用的是 C / 期望互动 / N / D。
//
// ⚠️ 最关键的一点（用户第 4 条）：**奖励必须影响下一次选择**。
//    普通 LLM API 不会因为"告诉模型得了 0.25 分"就更新自己。所以这里把每张图的
//    互动表现**累计写回图档案**（interactShown / interactUsers / interactReplies），
//    下次选图时按它的历史互动率给分 —— 这才是真正的"越用越好"。

const REWARD = { C: 0.10, E: 0.25, I: 0.25, N: 0.25, D: 0.15 };
const RECENT_EXCLUDE = 5;          // 先排除最近 N 次用过的
const WEIGHT_TEMP = 2.2;           // 加权随机的温度：越大越倾向于高分项，越小越平均

// 互动统计与间隔
const INTERACT_WINDOW_MS = 3 * 60_000;   // 发表情后 3 分钟内统计相关回复
const INTERACT_FULL_USERS = 3;           // 3 位不同群友 = 互动人数项满分
const INTERACT_FULL_REPLIES = 5;         // 5 条有效回复 = 回复数项满分
const BASE_REWARD_MIN_GAP_MS = 20_000;   // 基础发送奖励每 20 秒最多给一次（防刷分）
const INTERACT_PRIOR_WEIGHT = 3;         // 互动率的贝叶斯先验强度（样本少时更信任经验值）

/**
 * C：语境匹配度（0~1）。
 * 判据按可靠程度排：情绪标签命中 > 关键词命中（标签/说明/图上文字）> 来源上下文沾边。
 * 没有任何语境信息时给中性 0.5（不偏袒，让 N/D 起作用）。
 */
function scoreContext(it, { mood = '', keyword = '', recentText = '' } = {}) {
  const md = cleanTag(mood);
  const kw = clean(keyword, 30);
  const hits = [];
  if (md) {
    if (it.tags.includes(md)) hits.push(1);
    else if (it.tags.some((t) => t.includes(md) || md.includes(t))) hits.push(0.8);
    else hits.push(it.tags.length ? 0.25 : 0.45);
  }
  if (kw) {
    const hay = `${it.tags.join(' ')} ${it.note} ${it.text} ${it.srcHint}`;
    hits.push(hay.includes(kw) ? 1 : 0.2);
  }
  // 最近聊天里出现过它上面的文字/标签 → 说明"这个梗正在聊"，加分
  if (recentText) {
    const rt = String(recentText);
    for (const w of [it.text, ...(it.tags || [])]) {
      const t = clean(w, 8);
      if (t && t.length >= 2 && rt.includes(t)) { hits.push(0.9); break; }
    }
  }
  if (!hits.length) return 0.5;                       // 无语境信息 → 中性
  return Math.max(0, Math.min(1, hits.reduce((a, b) => a + b, 0) / hits.length));
}

/** N：新颖度（0~1）。没发过 = 1；越近发过越低；24 小时以上恢复满分。 */
function scoreNovelty(it) {
  const used = num(it.sentCount, 0) + num(it.useCount, 0);
  const last = num(it.usedAt, 0);
  if (!used || !last) return 1;                       // 从没发过：最新鲜
  const hours = (Date.now() - last) / 3600000;
  const recency = Math.max(0, Math.min(1, hours / 24));   // 24h 线性恢复
  const worn = Math.max(0, 1 - used / 12);                // 发过 12 次 → 新鲜度归零
  return Math.max(0, Math.min(1, recency * 0.65 + worn * 0.35));
}

/** D：使用均衡度（0~1）。发得越少越高 —— 用来避免"长期只用那几个"。 */
function scoreBalance(it, totalSent) {
  const used = num(it.sentCount, 0) + num(it.useCount, 0);
  if (!totalSent) return 1;
  const fair = totalSent / 30;                        // 期望均值（约 30 张"活跃图"摊平）
  return Math.max(0, Math.min(1, 1 - used / Math.max(1, fair * 4)));
}

/**
 * 这张图的**历史互动表现**（0~1）—— 用户方案里"记录每个表情引起互动的历史表现"。
 *
 * 用贝叶斯平均：样本少时向先验（0.5）收缩，避免"只发过 1 次、恰好有人回了一句"
 * 就被永久高估。这是解决"用 1~2 次的数据噪声"的标准做法。
 */
function scoreInteraction(it) {
  const shown = num(it?.interactShown, 0);
  if (shown <= 0) return 0.5;                          // 没有历史 → 中性
  // 每发一次能拿到的互动奖励（0~0.25），归一化成 0~1
  const perShow = (num(it.interactUsers, 0) + num(it.interactReplies, 0)) / shown;
  const raw = Math.min(1, perShow / 1.5);              // 1.5 ≈ 稳定拿到一半互动额度
  const prior = 0.5;
  return (raw * shown + prior * INTERACT_PRIOR_WEIGHT) / (shown + INTERACT_PRIOR_WEIGHT);
}

/**
 * R_互动 = 0.125·min(U/3,1) + 0.125·min(M/5,1)
 * 返回这一轮该给这张图加多少互动奖励（0 ~ 0.25）。
 */
function interactionReward(users, replies) {
  const u = 0.125 * Math.min(1, num(users, 0) / INTERACT_FULL_USERS);
  const m = 0.125 * Math.min(1, num(replies, 0) / INTERACT_FULL_REPLIES);
  return u + m;
}

/**
 * 选图用的总分（0~1）。
 *
 * 不含 E（发表情奖励）—— 理由见上方注释：选图时它还是个常数，
 * 对所有候选一视同仁。选图真正要比的是：
 *   语境相关性(0.10) + 期望互动(0.25) + 新颖度(0.25) + 使用均衡度(0.15)
 * 为了让四项权重仍然归一化到 1，这里把 E 的 0.25 按比例摊回其他三项。
 */
function scoreSticker(it, ctx = {}, totalSent = 0) {
  const C = scoreContext(it, ctx);
  const I = scoreInteraction(it);
  const N = scoreNovelty(it);
  const D = scoreBalance(it, totalSent);
  const cw = REWARD.C / (1 - REWARD.E);               // 0.10 / 0.75
  const iw = REWARD.I / (1 - REWARD.E);               // 0.25 / 0.75
  const nw = REWARD.N / (1 - REWARD.E);
  const dw = REWARD.D / (1 - REWARD.E);
  const S = cw * C + iw * I + nw * N + dw * D;
  return { S, C, I, N, D };
}

// ─────────────────────────────────────────────── 互动统计（R_互动的落地）
//
// 用户方案第 3 条第 3 点："给每条表情设置独立的互动统计窗口：发表后的 3 分钟内
// 统计相关回复，并把最后获得的互动奖励记回原来的表情动作，而不是记到机器人之后
// 发送的消息上。"
//
// 落地方式：
//   · 发一张表情 → 记下 { chatKey, itemKey, at } 一份"待统计"
//   · 3 分钟后回看这段时间的聊天记录，数：
//       U = 说话的**不同群友**人数（排除机器人自己、其他机器人）
//       M = 群友发的**有效回复**条数
//   · 把 U/M 累计写回**那张图**的档案（interactShown/Users/Replies）→ 影响下次选图
//   · 全部读本地聊天存档，不花 token

/** 待统计的发送记录（只放最近若干条，防长跑内存增长）。 */
const pendingInteractions = [];
const PENDING_MAX = 60;

/**
 * 登记一次"待统计互动"。baseGapOk=false 表示这次不给基础发送奖励 E
 * （用户方案第 3 条：每 20 秒最多获得一次基础发送奖励，防连发刷分）。
 */
function registerSendForInteraction(chatKey, itemKey, baseGapOk = true) {
  try {
    if (!chatKey || !itemKey) return;
    pendingInteractions.push({ chatKey, itemKey, at: Date.now(), baseGapOk });
    while (pendingInteractions.length > PENDING_MAX) pendingInteractions.shift();
    setTimeout(() => { void settleInteraction(chatKey, itemKey, Date.now()); }, INTERACT_WINDOW_MS + 1000).unref?.();
  } catch { /* 统计登记失败不影响发送 */ }
}

/**
 * 统计这次发送之后的群友互动，并把结果记回那张图。
 * @param {number} sentAt 发送时刻
 */
async function settleInteraction(chatKey, itemKey, sentAt) {
  try {
    const idx = pendingInteractions.findIndex((p) => p.chatKey === chatKey && p.itemKey === itemKey);
    const rec = idx >= 0 ? pendingInteractions.splice(idx, 1)[0] : { baseGapOk: true, at: sentAt };
    const since = num(rec.at, sentAt) + 500;             // 只要发出去之后的
    const store = runtimeStore;
    let users = 0; let replies = 0;
    if (store?.recent) {
      const list = store.recent(chatKey, { limit: 300, includeSelf: false }) || [];
      const who = new Set();
      for (const e of list) {
        const ts = num(e?.ts ?? e?.at, 0);
        if (ts <= since) continue;
        // 排除机器人自己（includeSelf:false 已过滤，这里再挡一道）与其他机器人
        if (e?.self === true || e?.bot === true || e?.isBot === true) continue;
        replies += 1;
        const uid = String(e?.userId ?? e?.senderId ?? e?.sender ?? e?.from ?? '');
        if (uid) who.add(uid);
      }
      users = who.size || (replies > 0 ? 1 : 0);          // 拿不到 userId 时退化成"有 1 个人"
    }
    const it = loadLib().items.find((x) => x.key === itemKey);
    if (!it) return;
    it.interactShown = num(it.interactShown, 0) + 1;
    it.interactUsers = num(it.interactUsers, 0) + Math.min(users, INTERACT_FULL_USERS);
    it.interactReplies = num(it.interactReplies, 0) + Math.min(replies, INTERACT_FULL_REPLIES);
    it.interactAt = Date.now();
    // 这一轮实际拿到的总奖励（记录用，便于观察"是否真的越用越好"）
    const reward = REWARD.E * (rec.baseGapOk ? 1 : 0) + interactionReward(users, replies);
    it.lastReward = Number(reward.toFixed(3));
    it.rewardHistory = Array.isArray(it.rewardHistory) ? it.rewardHistory : [];
    it.rewardHistory.push(it.lastReward);
    if (it.rewardHistory.length > 20) it.rewardHistory.shift();
    libDirty = true;
    flushLib(true);
    log(`互动统计：#${shortId(it)} 回应人数 ${users}、回复 ${replies} 条 → 本轮奖励 ${it.lastReward}`);
  } catch (error) {
    warn(`互动统计失败（不影响任何功能）：${error?.message ?? error}`);
  }
}

// （旧的"90 秒内有没有人说话 → ±1"的简单反馈已由上面的 settleInteraction 取代：
//   新实现数的是"不同回应人数 + 有效回复条数"，并按用户方案在 3 分钟窗口结算。）

/** 加权随机抽取：按 S 做 softmax 式抽样，高分更容易被选中但低分也有机会。 */
function weightedPick(list, scoreOf) {
  if (list.length <= 1) return list[0] || null;
  const scores = list.map((x) => scoreOf(x));
  const max = Math.max(...scores);
  const weights = scores.map((s) => Math.exp((s - max) * WEIGHT_TEMP));
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return list[Math.floor(Math.random() * list.length)];
  let r = Math.random() * sum;
  for (let i = 0; i < list.length; i += 1) {
    r -= weights[i];
    if (r <= 0) return list[i];
  }
  return list[list.length - 1];
}

// ─────────────────────────────────────────────── 动态提示词片段

/**
 * 给模型一段"聊天配图"的实时说明：当前档位、这个会话还剩多少额度、按需看图。
 *
 * 为什么必须动态生成：额度每轮都在变（间隔、每群上限、跨天重置），
 * 静态 prompt.sections 只能说"有这个功能"，说不了"现在这个群还能不能配"。
 * 频率的**措辞**也按档位改写 —— 与核心 buildStickerStrategyHint 同一套做法：
 * 档位管频率、策略管时机，绝不两处各写一套（那会左右脑互搏）。
 */
export function promptSections(ctx = {}) {
  try {
    if (!conf().enabled) return [];
    const l = loadLib();
    if (!l.items.length) return [];
    const c = conf();
    const lvl = levelOf(c.stickerFrequency);
    const tagged = l.items.filter((it) => it.tags.length || it.note).length;
    const anim = l.items.filter((it) => it.animated);
    const animUnseen = anim.filter((it) => !it.framesReady).length;

    // ── 现成可发的图：连编号带含义摆在面前 ──
    // 这是"主动发图"的关键一步：让动作从"挑一次 + 发一次"变成**一次调用就好**。
    // 想发的时候不用先做功课，发图才可能变成顺手的事。
    //
    // ⚠️ 这里踩过两个坑，都是"总是发同一张"的直接原因：
    //   ① 只给 3 张 + 只收"有标签的" → 库里 93 张、有标签 6 张，模型每轮只看得到
    //      同样那两三张（它往往直接照抄这个列表，压根不去调 pick_sticker）。
    //   ② 条件里有 `(!animated || framesReady)` → **动图全被挡在外面**。
    //      实测：33 张动图里 framesReady>0 的 0 张（抽帧只在"看过"时才做），
    //      于是有标签的 6 张里有 3 张动图永远进不来 —— 能发的只剩 3 张静态图。
    //
    // 现在的规则（按用户要求改的："没标签的也能发，配表情包只是为了好玩"）：
    //   · **不再要求有标签** —— 发图不需要模型先"看懂"它，人发表情也常常没理由。
    //     没标签的照常进列表，只标记「未分类」让模型知道"这张我没看过、拿不准就别配"。
    //   · **不再因为动图没抽帧就排除** —— 能不能发和"看没看过"是两件事。
    //     动图照常可选、照常能发（发送是直传原文件，见 send_sticker_steal）；
    //     抽帧只影响"模型知不知道它画的是什么"，所以标注「动图N帧」供它决定要不要先看一眼。
    //   · 已认识的图优先（有标签/备注的排在前面），但不再是硬门槛。
    //   · 数量给到 14 张：足够轮换，又不至于把上下文撑爆。
    const all = l.items.filter((it) => it.path && !isMeaningless(it));
    // 自愈：文件丢了的条目清出索引（同 pickCandidates 的理由 —— 死条目会一直
    // 出现在"现成好发的"列表里，模型照抄它去发就必然失败）。
    const alive = all.filter((it) => fs.existsSync(it.path));
    if (alive.length !== all.length) {
      for (const it of all) if (!fs.existsSync(it.path)) { warn(`文件已丢失，清出索引：#${shortId(it)}`); removeItem(it.key); }
    }
    // 冷却已按要求撤掉：不再排除"刚发过"的图，只靠排序让没发过的排前面。
    const pool = alive;
    const known = pool.filter((it) => it.tags.length || it.note).sort((a, b) => itemScore(b) - itemScore(a));
    // 未分类的图按"新鲜度 + 随机"取，**每轮都会不同** ——
    // 目的是让模型每轮看到几张它没见过的图，而不是永远同一批。
    // 为什么要随机而不是只按时间排：只按时间排的话，每轮的 8 张完全一样，
    // 模型很快就把它们也当"老面孔"，多样性还是上不去。
    const unknown = pool.filter((it) => !it.tags.length && !it.note)
      .map((it) => ({ it, r: Math.random() }))
      .sort((a, b) => (itemScore(b.it) + b.r * 3) - (itemScore(a.it) + a.r * 3))
      .map((x) => x.it);
    // 已认识的给 5 张、未分类的给 3 张（共 8 张）。
    // ⚠️ 数量是**为省 token 刻意压小的**（原来 9+10=19 张）：
    //    · 每个"编号+标签+说明"约 11 token，19 张就是 ~200 token **每一轮都要发**；
    //    · 而且未分类那批带随机、每轮都变，会让整段提示词**每轮都不一样** →
    //      提示词缓存全部失效（缓存命中价格便宜很多）。固定成 8 张后波动小得多。
    //    模型真想多挑，可以调 pick_sticker（那个走本地索引，不花 token）。
    const ready = [...known.slice(0, 5), ...unknown.slice(0, 3)];
    const readyLine = (it) => {
      const tag = it.tags.length ? `[${it.tags.join('/')}]` : '[未分类]';
      // 描述优先级：模型写的备注 > 图上的字 > **来源上下文** > 弱兜底线索。
      //   · 有标签的：直接按标签发（不打第二遍标签、不重复识别）
      //   · 没标签的：用"当时群里在聊什么"判断场合 —— 真人也是这么发图的
      //   · 连上下文都没有的（本功能上线前收的图，无法回填）：给出"来自哪个群、
      //     什么时候收的"这个弱线索，至少让模型知道它出自什么氛围的群，不至于完全瞎猜。
      // 三种都不花 token。
      const hint = clean(it.srcHint, 22) || describeHint(it);
      const desc = clean(it.note || it.text, 22) || hint;
      const anim = it.animated ? `动图${it.gifFrames || '?'}帧` : '';
      return `#${shortId(it)}${tag}${desc ? ` ${desc}` : ''}${anim ? ` ${anim}` : ''}`;
    };
    const readyLines = ready.length ? ready.map(readyLine).join('｜') : '';
    // 另外告诉模型"还有多少张没打标签的图"：不然它会以为库里只有上面这几张，
    // 反复用那几张而不去开荒（实测：87 张从没被发过，因为它只知道那 3 张）。
    const untaggedCount = unknown.length;

    // 是不是"主动冒出来"的时机：主动唤醒（proactive）本来就没有人在问它，
    // 这时候发一张图才是真正的"自己想说"，措辞也按这个来。
    const spontaneous = ctx?.proactive === true;
    const urge = spontaneous
      ? '**这一轮是你自己冒泡（没人问你）**：想说什么、想发张图都可以，就当自己在群里随手冒一句。'
      : '**发图不必等别人要**：就像真人在群里随手甩一张表情那样 —— 自己觉得好笑、想吐槽、想附和、或者单纯觉得这个气氛适合，都可以主动发一张，不用谁开口要。';

    // ⚠️ 拆成**两段**，理由是指令缓存（实测过缓存命中率只有 20%）：
    //   · 这一段（priority 98）**每轮都会变**（现成候选列表带随机的"发过N次"统计
    //     和随机排序），所以它承担"变化"的角色 —— 但必须排在**最末尾**，
    //     这样它前面的一切（核心规则 + 各技能静态段）字节固定，缓存前缀保住。
    //   · 那些"每轮都一样的指导话"不放在这里，见文件顶部静态规则
    //     （plugin.json 的 prompt.sections），那样它们能被缓存、不重复计费。
    return [{
      id: 'sticker-steal-state',
      title: '表情包库',
      priority: 98,
      content: `【表情包库｜聊天配图】你自己收藏的表情包有 ${l.items.length} 张（已打标签 ${tagged} 张${anim.length ? `，其中动图 ${anim.length} 张` : ''}）。`
        + `配图档位：${lvl.label}。${lvl.prompt}`
        + urge
        // ⚠️ 只有这一段必须每轮重发：候选列表（编号 + 标签 + 发过几次）会变。
        + (readyLines ? `现成好发的：${readyLines} —— 直接 send_sticker_steal 用编号就发，不用先挑。（想看更多候选用「挑一张表情包」，那个不花 token）` : '想配图时先用「挑一张表情包」挑候选，再用「发表情包」发出。')
        + (untaggedCount >= 10
          ? `库里还有 ${untaggedCount} 张你**没看过**（标着「未分类」）—— 每轮如果顺手，用「批量认识表情包」看几张，看完用「给表情包打标签」写下理解。`
          : '')
    }];
  } catch (error) {
    warn(`生成动态提示词片段失败：${error?.message ?? error}`);
    return [];
  }
}

// ─────────────────────────────────────────────── 生命周期

export function setup(api) {
  apiRef = api;
  // 注意：config 不再"只在这里赋值" —— 见 skillConfig() 的注释：
  // 热重载路径不会走到 setup()，只在这里赋值会让用户设置静默失效。
  cfg = skillConfig;
  log = api.log || (() => {});
  warn = api.warn || (() => {});
  apiFetch = api.fetch || null;
  registerTools(api);
  // 加载路径上唯一一定被执行的地方：在这里自检 GIF 解码器（原因见函数注释）
  selfCheckGifDecoder();
}

/** 同步自检：返回 Promise 会被当成"可用"，那是文档点名的坑。 */
export function available() {
  try {
    if (!conf().enabled) return { ok: false, reason: '更好的表情包收集和发送已在设置里关闭' };
  } catch { /* 配置读不到就乐观放行 */ }
  return true;
}

export async function activate() {
  try {
    fs.mkdirSync(IMG_DIR, { recursive: true });
    loadLib();
    // 延迟引入核心模块：加载期不碰这些依赖，热重载时也不会因为循环 import 卡住
    try {
      const mod = await import('../../src/safe-fetch.js');
      safeFetchBinary = mod?.safeFetchBinary || null;
    } catch (error) {
      warn(`取不到核心 safe-fetch，联网下载将走自带护栏：${error?.message ?? error}`);
    }
    // 打开文件管理器要用的子进程模块（延迟引入，加载期不碰）
    try {
      const cp = await import('node:child_process');
      nodeSpawn = cp?.spawn || null;
    } catch { nodeSpawn = null; }
    log(`已就绪：库内 ${loadLib().items.length} 张，目录 ${DIR}`);
    backfillMeta();   // 给"加动图功能之前"收进来的老条目补上动图标记
    selfCheckGifDecoder();   // 每次加载都自检抽帧：解码器坏了要马上知道
    // 定时收集：注册表里挂一个每 5 分钟检查一次的定时器（到点才真跑）
    startScheduleTimer();
    const nx = nextRunAt();
    if (nx) log(`定时收集已启用：每 ${conf().collectEveryHours} 小时一次（下次约 ${new Date(nx).toLocaleString('zh-CN')}）`);
  } catch (error) {
    warn(`activate 失败（功能仍可用，只是可能少一层下载保护）：${error?.message ?? error}`);
  }
}

export function deactivate() {
  // 清掉定时器：否则"关掉插件但定时器还在跑"就成了幽灵任务
  stopScheduleTimer();
  // 把内存里的采集队列丢掉，避免关掉后还继续下载。
  queue.length = 0;
  queueKeys.clear();
  flushLib(true);
}

export function dispose() {
  try {
    stopScheduleTimer();
    flushLib(true);
  } catch { /* 忽略 */ }
  lib = null;
  queuedOnce.clear();
  queue.length = 0;
  queueKeys.clear();
}

/** 给排障用（不是能力，不在 capabilities 里声明，核心不消费）。 */
export const internals = {
  get library() { return loadLib(); },
  get queueSize() { return queue.length; },
  pickCandidates,
  pickUntagged,
  sendGate,
  conf,
  FREQ_LEVELS,
  activityOf,
  effectiveLimits,
  selfTextsSinceLastSticker,
  markStickerSent,
  scoreSticker,
  scoreInteraction,
  interactionReward,
  settleInteraction,
  registerSendForInteraction,
  REWARD,
  setRuntimeStore: (s) => { runtimeStore = s; },
  freqBrief,
  isLikelySticker,
  DIR,
  // 给自测用（不对外暴露成能力，核心不消费）
  gifInfo,
  extractGifFrames,
  lzwDecode,
  parseGifStructure,
  buildLookResult,
  mediaMeta,
  // 收录时识图（B 方案）—— 供自测直接触发
  recognizeOnIngest,
  ingestVisionStatus
};
