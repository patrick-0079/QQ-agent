// plugins/msg-reaction/index.js
//
// 消息表情回应（确定性型 / 出站观测驱动）
//
// ── 这个插件干什么 ────────────────────────────────────────────────────────
// QQ（NT）支持给**任意一条消息**加「表情回应」：长按消息 → 顶上那排
// 👍 😳 🍰 😨 😴 😂 就是它。本插件让机器人偶尔也给自己刚发出的那条消息点一个，
// 看起来像真人顺手留了个态度，而不是每次都只吐文字。
//
// ── 为什么是"观测出站"而不是挂钩子（重要，改代码前先看）─────────────────────
// 本版核心**并没有真正调用 after-tool / before-tool 钩子**（orchestrator.js 里
// 那几处 runHook 在运行时不触发，实测：同目录 typing-indicator 的 after-tool 同样
// 收不到消息，它是靠下面的补丁才知道"消息已发出"的）。
// 所以本插件沿用 typing-indicator（plugins/typing-indicator/index.js installSendHook）
// 里被验证过的那条路：**挂 OneBotClient.prototype.call**。
//
//   好处一：所有出站发送都从这里过 —— 文本 / 表情 / 图片 / 视频，不管是谁发的
//           （核心工具、提醒、别的插件），一个都漏不掉。
//   好处二：拿得到精确的 group_id 与回包里的 message_id，不用猜。
//   好处三：不用改核心任何文件，也不依赖钩子是否被调用。
//
// 补丁只做**观测**，原样返回原始 promise ——《观测失败绝不能影响发送本身》。
//
// ── 协议层事实（照抄 SnowLuma 源码，不是猜的）─────────────────────────────
//   · action 名：set_msg_emoji_like
//     参数 { message_id: 非零整数, emoji_id: 非空字符串, set: bool }
//   · emoji_id 是**数字字符串**：>3 位按 Unicode 码点当"大表情"处理
//     （👍 = "128077"），≤3 位按经典 QQ 小黄脸编号处理。所以本插件用码点。
//   · **仅群聊可用**：SnowLuma 明确抛 "emoji reactions are not supported on
//     private messages"；私聊一律跳过，不做无意义的请求。
//   · 目标消息必须在协议端的 messageStore 里且带权威 sequence。自己刚发的消息
//     满足 —— SnowLuma 的 finalizeSend() 会当场 cacheMessageMeta() 登记。
//   · 接口存在性已实测：用不存在的 id 请求返回 retcode=100 "message not found"，
//     而不存在的 action 返回 retcode=1404 "unknown action"。
//
// ── 贴什么（这是 v1.1 的核心改动）──────────────────────────────────────────
// 默认 **AI 决定**：把机器人刚发出的那句话交给模型，让它从"表情池"里挑 0~2 个
// （情绪平淡就回 none，一个都不贴）。这样贴出来的是"态度"，不是"随机凑数"。
//   · 挑不中/模型挂了 → 退回随机 1 个，功能不会整体哑掉（而且不计入发送熔断）。
//   · 另一档 **随机贴一个** 保留旧行为，不想花模型调用时可以切过去。
// ⚠️ 一条消息最多 2 个表情是**硬上限**（settings 里被 clamp 在 1~2），
//    配置写多大都不放行 —— 这是"不把整排表情占满"的底线。
//
// ── 频率控制（四重闸门，默认不可能刷屏）───────────────────────────────────
//   ① 概率     probabilityPercent，默认 20%
//   ② 会话冷却 minGapSec，同一个群两次之间至少 300 秒
//   ③ 小时上限 maxPerHour = 3 / 会话 / 小时
//   ④ 每日上限 maxPerDay = 15 / 会话 / 天（跨重启累计，状态落盘）
//   另加：同会话并发保护（连着发两条不会算重配额）+ 连续失败熔断
//   （协议端不认时暂停 10 分钟，日志只打一次）。
//
// ── 两个必须遵守的工程约定（照抄 typing-indicator 的教训）─────────────────
//   ① 热重载会 import 出**新的模块实例**：所有跨实例状态（含补丁、定时器）必须挂
//      globalThis，否则同一时刻会有两份计数器、两份补丁。
//   ② 补丁只装一次：靠原型上的标记位认领，重载不叠第二层。

import fs from 'node:fs';
import path from 'node:path';
import { getConfig, DATA_DIR } from '../../src/config.js';
import { OneBotClient } from '../../src/onebot.js';
// ⚠️ 必须用 logger 而不是 api.log：api.log 只是 console.log（[skill:xxx] 前缀），
//    **不会写进 data/logs/*.log**，出问题时等于没有任何线索。
//    typing-indicator 同样是这么做的（它的日志能在日志文件里看到，就是这个原因）。
import { logger } from '../../src/logger.js';
// 「AI 决定」模式要借核心的模型通道挑表情（与 routes.js 的 sticker-ai-label 同一个入口）。
import { chatCompletion } from '../../src/llm.js';

const ID = 'msg-reaction';
const CALL_TIMEOUT_MS = 8000;          // 表情回应是个小包，超过 8 秒当没连上
const FAIL_LIMIT = 4;                  // 连续失败这么多次 → 熔断
const FAIL_PAUSE_MS = 10 * 60 * 1000;  // 熔断时长
const KEEP_EMOJI_MEMORY = 3;           // 记住最近用过的几个表情（避免连着重复）
const SEND_ACTIONS = new Set(['send_group_msg', 'send_private_msg']);
// v1.4：同一条发送在这个时间窗内被重复观测到 → 视为同一次，忽略
const SEEN_DEDUP_MS = 10 * 60 * 1000;
const SEEN_MAX = 200;

// 默认表情池：全是"轻量态度"型，不挑场合，也不至于像敷衍
const DEFAULT_EMOJIS = [
  '128077', // 👍
  '128514', // 😂
  '129300', // 🤔
  '128517', // 😅
  '128563', // 😳
  '128564', // 😴
  '128079', // 👏
  '128591', // 🙏
  '128527', // 😏
  '128580', // 🙄
  '129392', // 🥰
  '128557'  // 😭
];

/**
 * 表情的"含义"表 —— 让模型能凭语义挑，而不是瞎猜一串数字。
 * key 就是 emoji_id（Unicode 码点字符串），值与设置页里显示的中文一致。
 */
const EMOJI_LABELS = {
  128077: '赞 / 同意',
  128514: '笑哭',
  129300: '思考 / 疑惑',
  128517: '尴尬 / 冒汗',
  128563: '惊讶 / 脸红',
  128564: '无语 / 困',
  128079: '鼓掌 / 叫好',
  128591: '拜托 / 谢了',
  128527: '得意 / 坏笑',
  128580: '翻白眼',
  129392: '喜欢 / 宠溺',
  128557: '难受 / 哭了',
  127856: '想吃 / 甜',
  128293: '火 / 很强',
  10024: '闪光 / 亮眼',
  128128: '服了 / 笑死',
  128526: '酷 / 得意',
  129313: '小丑 / 自嘲',
  128522: '微笑',
  129394: '苦笑 / 含泪'
};

/** emoji_id（码点字符串）→ 可读字符；经典小黄脸（编号 ≤3 位）没有码点，返回 #id。 */
function emojiCharOf(id) {
  const n = Number(id);
  if (!Number.isFinite(n) || !isEmojiCodepoint(n)) return `#${id}`;
  try { return String.fromCodePoint(n); } catch { return `#${id}`; }
}

const STATE_DIR = path.join(DATA_DIR, ID);
const STATE_FILE = path.join(STATE_DIR, 'state.json');

// ── 共享状态（热重载安全）──────────────────────────────────────────────────
const G = (globalThis.__msgReactionState = globalThis.__msgReactionState || {
  cfgOf: null,
  logFn: null,
  warnFn: null,
  client: null,
  clientKey: '',
  chats: new Map(),        // chatKey -> { lastReactAt, hourStamps[], dayKey, dayCount, recentEmojis[], pausedUntil, fails }
  pending: new Set(),      // 待触发的 setTimeout handle
  inFlight: new Set(),     // 正在"挑 + 贴"的会话（防同会话并发重复计配额）
  dispatch: null,          // 补丁的转发口：每次 setup 指向**最新**实例的处理函数
  patchedCall: null,       // 已安装的 OneBotClient.prototype.call 补丁
  installed: false,
  pickFn: null,            // 离线自检注入的"挑表情"函数（线上为 null → 走真模型）
  pausedUntil: 0,          // 全局熔断截止时间
  failStreak: 0,
  warnedPrivate: false,
  clock: null,             // 离线自检注入假时钟
  transport: null,         // 离线自检注入传输层
  // sent = 自动路径贴成功次数；onDemand = 被点名要求贴成功次数。
  // ⚠️ 必须分开统计：合成一个「已贴 N 次」，用户根本分不清是机器人自己贴的
  //    还是自己点名要的 —— 而这两件事对应完全不同的限频规则。
  // sent = 自动路径（走概率与配额）贴成功的次数；
  // onDemand = 别人点名要求、模型调工具贴成功的次数；
  // blocked = 模型想自己贴、被"没明说要贴"这道硬校验拦下的次数。
  // **三者分开统计**：混在一起的话，用户看到"已贴 20 次"根本分不清
  // 是机器人按自己设置贴的，还是自己点名的，还是模型擅作主张的。
  stats: { attempts: 0, sent: 0, onDemand: 0, blocked: 0, skipped: 0, failed: 0, lastAt: 0, lastEmoji: '', lastReason: '' },
  savedAt: 0,
  // v1.4：同一次发送被观测两次时用来去重（热重载会让补丁叠加，见 installSendHook）
  seen: new Map(),
  originalCall: null,
  byReason: new Map(),     // 跳过原因 → 次数（面板里直接展示）
  // v1.5：chatKey -> { mid, at }。本会话最近一条**别人发的**消息（before-context 旁听缓存）。
  // 「贴别人的消息」在机器人不引用时靠它取目标 —— 见 rememberPeerId 的注释。
  recentPeer: new Map()
});

// v1.5：入站旁听缓存的有效期。超过这个时间的群友消息不再拿来贴，
// 避免机器人安静一会儿后突然去贴两百年前的旧消息（观感很像出错）。
const PEER_CACHE_TTL_MS = 120 * 1000;

const nowMs = () => (typeof G.clock === 'function' ? Number(G.clock()) : Date.now());
// 日志走 logger（落盘）而不是 api.log（只在控制台）。
// G.logFn 仅作为 logger 不可用时的兜底，保证日志永远不会反向弄坏发送。
const log = (...a) => {
  try { logger.info(ID, ...a); } catch { try { (G.logFn || (() => {}))(...a); } catch { /* ignore */ } }
};
const warn = (...a) => {
  try { logger.warn(ID, ...a); } catch { try { ((G.warnFn || G.logFn) || (() => {}))(...a); } catch { /* ignore */ } }
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

// ── 设置 ────────────────────────────────────────────────────────────────────
function settings() {
  let c = {};
  try { c = (typeof G.cfgOf === 'function' ? G.cfgOf() : null) || {}; } catch { c = {}; }
  const n = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

  // target 用中文枚举值（设置页下拉直接显示中文），这里同时接受英文别名
  const rawTarget = String(c.target ?? '自己的消息').trim();
  const targetMap = {
    '自己的消息': 'self', 'self': 'self',
    '被回复的消息': 'peer', 'peer': 'peer',
    '两者随机': 'both', 'both': 'both',
    '关闭': 'off', 'off': 'off', 'none': 'off'
  };
  const target = targetMap[rawTarget] || 'self';

  // 表情从哪来：AI 挑（默认）/ 随机抽一个 / 关闭
  const rawMode = String(c.mode ?? 'AI 决定').trim();
  const modeMap = {
    'AI 决定': 'ai', 'ai': 'ai', 'ai-pick': 'ai',
    '随机贴一个': 'random', 'random': 'random',
    '关闭': 'off', 'off': 'off', 'none': 'off'
  };
  const mode = modeMap[rawMode] || 'ai';

  const parsed = String(c.emojiIds ?? '')
    .split(/[,，、;；\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^\d{1,9}$/.test(s));
  const emojiPool = [...new Set(parsed.length ? parsed : DEFAULT_EMOJIS)];

  const dMin = clamp(n(c.delayMinSec, 3), 0, 600);
  const dMax = clamp(n(c.delayMaxSec, 15), 0, 600);

  return {
    enabled: c.enabled !== false,
    mode,
    target,
    // 一条消息最多贴几个：**用户自己定**（1~5）。
    // 上限只做"别把整排表情占满"的兜底，默认 2；不锁死在 2，
    // 之前那个 1~2 的硬 clamp 属于把用户的旋钮焊死了。
    maxEmojis: clamp(Math.floor(n(c.maxEmojis, 2)), 1, 5),
    probability: clamp(n(c.probabilityPercent, 20), 0, 100) / 100,
    minGapMs: clamp(n(c.minGapSec, 300), 0, 86400) * 1000,
    maxPerHour: Math.max(0, Math.floor(n(c.maxPerHour, 3))),
    maxPerDay: Math.max(0, Math.floor(n(c.maxPerDay, 15))),
    delayMinMs: Math.min(dMin, dMax) * 1000,
    delayMaxMs: Math.max(dMin, dMax) * 1000,
    emojiPool,
    avoidRepeat: c.avoidRepeat !== false,
    logSends: c.logSends === true,
    // v1.4：每次"决定要不要贴"都记一行日志（含结果）。用来核对设置里的
    // 数值是不是真的在生效 —— 光看次数，用户分不清是概率没过还是被冷却拦了。
    logSkips: c.logSkips === true,
    skipChats: String(c.skipChats ?? '').trim(),
    // v1.4：目标是「被回复的消息」但这条没引用任何人时，退回贴自己的那条。
    // 否则概率调到 100% 也可能一条都贴不出来，看起来就像设置没生效。
    fallbackToSelf: c.fallbackToSelf !== false,
    // 模型那条「按需贴」要不要先过一遍"对方是不是明说了要贴"（默认开）。
    requireExplicit: c.requireExplicit !== false
  };
}

const skipSet = () => new Set(String(settings().skipChats).split(/[,，、;；\s]+/).filter(Boolean));

// ── 协议端客户端：只为发这一个 action 而存在 ────────────────────────────────
function snl() {
  const cfg = getConfig() || {};
  return cfg.snowluma || {};
}

function clientFor(sn) {
  const key = `${sn.httpUrl || ''}|${sn.httpAccessToken || sn.accessToken || ''}`;
  if (G.client && G.clientKey === key) return G.client;
  G.client = new OneBotClient({
    wsUrl: sn.wsUrl,
    httpUrl: sn.httpUrl,
    accessToken: sn.accessToken,
    httpToken: sn.httpAccessToken || sn.accessToken,
    onEvent: () => {}   // 不订阅事件，也不 connect()，只用它的 HTTP call()
  });
  G.clientKey = key;
  return G.client;
}

async function defaultTransport(messageId, emojiId) {
  const sn = snl();
  if (!String(sn.httpUrl || '').trim()) throw new Error('没有配置 snowluma.httpUrl');
  const onebot = clientFor(sn);
  return onebot.call('set_msg_emoji_like', {
    message_id: Number(messageId),
    emoji_id: String(emojiId),
    set: true
  }, CALL_TIMEOUT_MS);
}

function sendReaction(messageId, emojiId) {
  if (typeof G.transport === 'function') return G.transport(messageId, emojiId);
  return defaultTransport(messageId, emojiId);
}

// ══════════════════════════════════════════════════════════════════════════
// 工具：让模型能**按别人的要求**去贴（v1.2 新增，v1.3 收窄）
//
// ── 两条路的边界（这是本插件最容易搞混的地方）─────────────────────────────
//   · 自动路径：机器人自己发完消息，插件**先走概率**，过了才让 AI 挑表情贴。
//     四重闸门（概率 / 冷却 / 小时 / 每日）**只属于这条路**。
//   · 按需路径（本工具）：**只在有人明确点名要求时**才该被调用，且不受限频约束。
//
// v1.2 的教训：工具描述里写了"或者你自己想给某句话补个态度"，模型就开始**主动**调它，
// 于是每条消息都被贴上 —— 用户看到的就是"怎么变成百分百贴了"。
// 现在改成：非点名不得调用；主动贴那件事交给自动路径（受概率管着）。
//
// ⚠️ 两条路的计数**必须分开**（见 fire() 与工具里的 st.toolXxx）：
//    按需贴若去改 lastReactAt / dayCount，就会把自动路径的冷却和配额吃掉，
//    用户设的"概率 20% / 冷却 300s"就不再是实际生效的数字了。
// ══════════════════════════════════════════════════════════════════════════
const TOOL_MIN_GAP_MS = 5000;   // 同会话两次"按需贴"的最小间隔（防连点/防模型重复调用）
const REACTED_MID_MEMORY = 8;   // 记住最近贴过的 8 条消息 id，防止同一条被贴两次

/** 这条消息最近是不是已经贴过了（按需路径与自动路径共用，避免同一条叠两回）。 */
function alreadyReacted(st, mid) {
  const target = String(mid);
  return (st?.reactedMids || []).some((x) => String(x) === target);
}

/** 取本会话最近一条**别人发的**消息（= 刚跟机器人说话的那条）。 */
function lastPeerMessage(ctx) {
  try {
    const chatKey = String(ctx?.chatKey || '');
    const list = ctx?.store?.recent?.(chatKey, { limit: 30, includeSelf: false }) || [];
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      const mid = Number(m?.mid);
      if (Number.isFinite(mid) && mid !== 0) return { mid, text: String(m?.text || '') };
    }
  } catch { /* 拿不到就算了 */ }
  return null;
}

// ── "对方是不是明说了要贴表情" ──────────────────────────────────────────────
// 这是用户明确要的一条规则：**单纯 @ 它不算，得把话说出来**才行。
// 光靠工具描述叮嘱模型不够（实测模型会因为"被 @"就顺手贴），所以这里做成硬校验：
// 只有最近几条别人发的话里能看出"要表情"的意思，才允许贴；否则直接拒绝。
//
// ⚠️ 只认"贴/给/来/点/回/加/补/送 + 表情/赞/比心/回应/反应"这种搭配，
//    以及"给我个👍"这种"给动词 + 表情字符"。**不拿含义词表去匹配**——
//    「喜欢」「同意」「难受」这些本身是日常词，拿它们当依据会把普通聊天误判成点单。
const GIVE_VERB = /(贴|给|来|点|回|加|补|送)/;
const OBJECT_WORD = /(表情|赞|比心|回应|反应|emoji)/i;
// 兜底：这几个动词本身就专指"加个表情"（贴/加/补不会用来干别的），
// 后面跟量词即可认定。刻意**不含** 给/来/点/回 —— 它们太常用
// （"回一下消息""点一下链接"），一放进来就会把普通聊天误判成点单。
const ADD_VERB_MEASURE = /(贴|加|补).{0,3}(一下|一个|个|条)/;

function hasEmojiChar(text) {
  for (const ch of String(text || '')) {
    if (isEmojiCodepoint(ch.codePointAt(0))) return true;
  }
  return false;
}

/** 这句话像不像"给我贴个表情"？（纯函数，便于测试） */
function isReactionRequest(text) {
  const t = String(text || '').replace(/\s+/g, '');
  if (!t) return false;
  if (OBJECT_WORD.test(t)) return true;              // "贴个表情" / "点个赞" / "反应一下"
  if (GIVE_VERB.test(t) && hasEmojiChar(t)) return true;   // "给我个👍"
  if (ADD_VERB_MEASURE.test(t)) return true;         // "贴一下" / "加个" / "补一条"
  return /贴/.test(t) && t.length <= 6;              // "贴一个" / "贴我"
}

/** 最近几条别人发的话里，有没有明确要求贴表情。 */
function someoneAskedToReact(ctx) {
  try {
    const list = ctx?.store?.recent?.(String(ctx?.chatKey || ''), { limit: 8, includeSelf: false }) || [];
    // 看最近 3 条：允许"说完要求后还补了两句话"的情况，但不无限往前翻
    return list.slice(-3).some((m) => isReactionRequest(m?.text));
  } catch { return false; }
}

/**
 * 这个码点像不像"表情"？
 * ⚠️ 不能简单用 `>= 0x2000`：汉字（如「赞」= 36190）也在那之上，
 *    那样「赞」会被当成码点解析成一个乱七八糟的 id。必须限定在表情区段。
 */
function isEmojiCodepoint(n) {
  return (n >= 0x1F000 && n <= 0x1FAFF)     // 😀 表情、🫠 扩展、🤝 手势、🍰 食物…
    || (n >= 0x2600 && n <= 0x27BF)        // ✨ ☀ ☂ ❤ 这类杂项符号与装饰符
    || (n >= 0x2B00 && n <= 0x2BFF);       // ⭐ 等
}

/**
 * 把模型给的表情说明解析成 emoji_id 数组。纯函数，便于测试。
 * 接受三种写法（都见过模型这么给）：
 *   1. 纯数字   "128077"          → 直接当 id（也可能是经典小黄脸编号，如 "14"）
 *   2. 表情本身 "👍" / "😂🎉"      → 取其中的 Unicode 码点
 *   3. 含义词   "赞" / "笑哭"      → 查含义表反查 id
 * 解析不出来就返回空数组，由调用方兜底（走 AI 挑 / 随机）。
 */
function parseEmojiSpec(spec) {
  const out = [];
  for (const part of String(spec ?? '').split(/[,，、;；\s]+/).map((s) => s.trim()).filter(Boolean)) {
    // ① 纯数字：直接当 id
    if (/^\d{1,9}$/.test(part)) { out.push(part); continue; }
    // ② 表情字符：取第一个落在表情区段的码点
    let cp = 0;
    for (const ch of part) {
      const n = ch.codePointAt(0);
      if (isEmojiCodepoint(n)) { cp = n; break; }
    }
    if (cp) { out.push(String(cp)); continue; }
    // ③ 含义词：反查含义表（放在最后，否则汉字会被上一步误判）
    const hit = Object.entries(EMOJI_LABELS).find(([, label]) => label && label.includes(part));
    if (hit) out.push(hit[0]);
  }
  return [...new Set(out)];
}

/**
 * 按需贴时决定贴哪几个：
 *   ① 模型明确给了表情 → 就用它（**允许不在表情池里** —— 这是别人点名要的，
 *      拿池子白名单去拒绝用户请求是本末倒置）；
 *   ② 没给 → 用与自动路径同一套"AI 按语气挑"；
 *   ③ 再不行 → 池子里随机一个。
 */
async function resolveToolEmojis(c, spec, targetText, st) {
  const explicit = parseEmojiSpec(spec);
  if (explicit.length) return explicit.slice(0, c.maxEmojis);
  try {
    const picked = await askAiForEmojis(c, targetText, st);
    if (picked.length) return picked.slice(0, c.maxEmojis);
  } catch (error) {
    warn(`按需贴表情时 AI 挑失败，退回随机：${String(error?.message ?? error).slice(0, 120)}`);
  }
  return [pickEmoji(c, st)];
}

/** 工具定义（放模块级是为了让离线自检能直接拿到它的 execute 来跑）。 */
const REACTION_TOOL = {
  id: 'react',
  name: '贴表情回应',
  description:
    '给某条消息贴「表情回应」——QQ 里长按消息、顶上那排 👍😂😳 的那个。它不占发言条数、不算刷屏。\n'
    + '【只在有人明确要求时用】例如"给我贴个赞"、"回我个表情"、"点一下这条"、"贴个哭的"。\n'
    + '【不要自己主动贴】机器人自己随手贴的那条路，是插件按用户设置的概率和上限自动走的，'
    + '不需要你调用这个工具；你主动调用会绕开用户设的限制，属于越权。\n'
    + '默认贴到本会话最近一条别人发的消息（也就是刚跟你说话的那条）；要指定就传 messageId'
    + '（聊天记录里每条消息前的 #数字）。\n'
    + 'emoji 可以传表情本身（👍）、Unicode 码点（128077）或含义词（赞、笑哭）；留空则由你按语气挑。\n'
    + '只能用在群聊（QQ 协议不支持私聊表情回应）。',
  category: 'messaging',
  icon: '😀',
  parameters: {
    type: 'object',
    properties: {
      emoji: {
        type: 'string',
        description: '要贴的表情：表情本身（👍）／Unicode 码点（128077）／含义词（赞、笑哭）都行，多个用空格或逗号分隔。留空 = 由你按语气挑。'
      },
      messageId: {
        type: ['integer', 'string'],
        description: '贴到哪条消息上（聊天记录里的 #数字）。留空 = 最近一条别人发的消息。'
      }
    }
  },
  async execute(ctx, args) {
    const chatKey = String(ctx?.chatKey || '');
    if (!/^group:\d+$/.test(chatKey)) {
      return { content: '错误：QQ 只有群聊有「表情回应」，私聊贴不了（协议不支持）。', isError: true };
    }
    const c = settings();
    if (!c.enabled || c.mode === 'off') {
      return { content: '错误：「消息表情回应」这条功能被管理员关掉了。', isError: true };
    }
    const now = nowMs();
    // 协议端连续失败时正在熔断：明确告诉模型，别让它一遍遍试
    if (G.pausedUntil && now < G.pausedUntil) {
      return { content: `错误：刚才连续贴失败，正在冷却中（还需 ${Math.ceil((G.pausedUntil - now) / 60000)} 分钟）。`, isError: true };
    }

    // ①-b 硬校验：只有**对方明说了要表情**才允许贴。
    //     单纯 @ 一下、或者说句好话，都不算 —— 这是明确的规则。
    //     光写在工具描述里叮嘱模型不够（实测它会因为"被 @"就顺手贴），
    //     所以做成代码级拦截：模型调了也会被拦下来，贴不出去。
    if (c.requireExplicit && !someoneAskedToReact(ctx)) {
      G.stats.blocked += 1;
      G.stats.lastReason = `block 没有明说要表情 ${chatKey}`;
      log(`拦截了一次「贴表情回应」调用：${chatKey} 最近几条里没看到"要表情"的请求`);
      return {
        content:
          '这一步不用做：这段对话里没有人要求贴表情。'
          + '这个工具只在对方明说「贴个表情 / 点个赞 / 回个表情 / 反应一下」时才用；'
          + '机器人自己随手贴的那条路是插件按用户设置的概率和上限自动走的，不需要你调用，'
          + '你主动调用会绕开用户设的限制。直接继续下一步或结束就好。',
        isError: true
      };
    }

    // ① 定目标消息：显式给的 id 优先，否则最近一条别人发的
    const asked = Number(args?.messageId);
    let target = Number.isFinite(asked) && asked !== 0 ? asked : 0;
    let targetText = '';
    if (target) {
      try { targetText = String(ctx?.store?.findByMid?.(chatKey, target)?.text || ''); } catch { /* ignore */ }
    } else {
      const last = lastPeerMessage(ctx);
      if (last) { target = last.mid; targetText = last.text; }
    }
    if (!target) {
      return { content: '错误：没找到要贴的消息（这个会话里还没有别人说话的记录，可以传 messageId 指定）。', isError: true };
    }

    const st = chatState(chatKey);
    if (alreadyReacted(st, target)) {
      return { content: '这条消息上已经贴过了，不用再贴。', isError: false };
    }
    if (st.lastToolAt && now - st.lastToolAt < TOOL_MIN_GAP_MS) {
      return { content: '刚好已经贴过了，先不用再贴（避免重复）。', isError: false };
    }

    const emojis = await resolveToolEmojis(c, args?.emoji, targetText, st);
    if (!emojis.length) {
      return { content: '错误：没解析出可用的表情（表情池是空的）。', isError: true };
    }

    const ok = [];
    for (const emojiId of emojis) {
      try {
        await sendReaction(target, emojiId);
        ok.push(emojiId);
      } catch (error) {
        if (!ok.length) {
          handleSendFailure(chatKey, target, error, st);
          return { content: `错误：贴表情失败（${String(error?.message ?? error)}）。不要重试。`, isError: true };
        }
        break;
      }
    }

    // ⚠️ 只记"按需"自己的计数，**绝不碰** lastReactAt / hourStamps / dayCount ——
    //    那三个是自动路径的闸门。按需贴若去动它们，就会把用户设的概率与冷却吃掉，
    //    表现成"我点了一次名，接下来五分钟它就不按我的设置走了"。
    st.lastToolAt = now;
    st.toolHourStamps = [...(st.toolHourStamps || []), now].slice(-64);
    st.reactedMids = [...(st.reactedMids || []), target].slice(-REACTED_MID_MEMORY);
    G.failStreak = 0;
    G.stats.onDemand += 1;
    G.stats.lastAt = now;
    G.stats.lastEmoji = ok.map(emojiCharOf).join('');
    G.stats.lastReason = `ok(按需) ${chatKey}#${target}`;
    saveState(true);
    log(`按需贴（点名）：${chatKey} 消息 #${target} ← ${ok.map((id) => `${emojiCharOf(id)}(${id})`).join(' ')}`);
    return {
      content: `已贴 ${ok.length} 个表情回应：${ok.map((id) => `${emojiCharOf(id)}`).join(' ')}。`
        + '不要输出"已贴"类汇报，继续思考下一步或直接结束。'
    };
  }
};

/** 注册工具（热重载时同 id 覆盖，不会叠加）。 */
function registerReactionTool(api) {
  if (typeof api?.registerTool !== 'function') {
    // 核心没提供注册入口（理论上不会）：不抛错，否则整个插件会因为
    // "顺便提供的一个工具"而加载失败 —— 自动贴那一半功能不该被拖下水。
    warn('核心未提供 registerTool，「按需贴表情」工具未注册（自动贴不受影响）');
    return false;
  }
  api.registerTool(REACTION_TOOL);
  return true;
}


// ── 出站观测补丁（唯一的核心补丁，只观测不干预）────────────────────────────
/**
 * 从发送参数里取"这条消息回复/引用了谁"。
 * SendQueue 传的 message 是段数组，reply 段形如 { type:'reply', data:{ id } }。
 * 纯函数，便于测试。
 */
export function replyTargetOf(params) {
  const msg = params?.message;
  if (!Array.isArray(msg)) return 0;
  for (const seg of msg) {
    if (seg?.type === 'reply' && seg?.data?.id != null) {
      const n = Number(seg.data.id);
      if (Number.isFinite(n) && n !== 0) return n;
    }
  }
  return 0;
}

/** 从出站回包里取自己刚发出的消息 id。纯函数，便于测试。 */
export function sentIdOf(data) {
  const n = Number(data?.message_id ?? data?.messageId);
  return Number.isFinite(n) && n !== 0 ? n : 0;
}

/**
 * 从发送参数里取"机器人刚说了什么"（只取 text 段）。
 * 「AI 决定」模式要把这句话交给模型，让它按语气挑表情 —— 这是模式的全部输入。
 * 纯函数，便于测试。
 */
export function textOf(params) {
  const msg = params?.message;
  if (typeof msg === 'string') return msg.replace(/\[CQ:[^\]]*\]/g, '').trim();
  if (!Array.isArray(msg)) return '';
  return msg
    .filter((seg) => seg?.type === 'text')
    .map((seg) => String(seg?.data?.text ?? ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 问模型：这句话该贴什么表情？
 * 只喂「刚发出的那句话 + 可选表情清单（带中文含义）」，让它回 0~2 个 id 或 none。
 *
 * 走核心的 chatCompletion（与 routes.js 的 sticker-ai-label 同一个入口），
 * 所以用户换渠道/换模型时自动跟着变，不需要插件另配一套 Key。
 *
 * 返回 id 数组（已按当前表情池过滤、去重、截断）；任何异常都返回 null，
 * 由调用方决定降级（目前是"退回随机一个"）。
 */
async function askAiForEmojis(c, text, st) {
  const pool = c.emojiPool.length ? c.emojiPool : DEFAULT_EMOJIS;
  const lines = pool.map((id) => `${id} ${emojiCharOf(id)} ${EMOJI_LABELS[id] || '（无说明）'}`);
  const recent = (st.recentEmojis || []).filter((e) => pool.includes(e));
  const recentHint = (c.avoidRepeat && recent.length)
    ? `\n\n最近已经用过：${recent.map((id) => `${id} ${emojiCharOf(id)}`).join('、')}（尽量换别的）`
    : '';
  const say = String(text || '').slice(0, 200) || '（刚发的是图片/表情，没有文字）';

  const ask = '你刚在 QQ 群里发出了下面这条消息。现在决定要不要给它点「表情回应」——'
    + '就像真人发完话随手补个态度，不是为了凑热闹。\n\n'
    + `你刚发出的消息：「${say}」\n\n`
    + `可选表情（第一列是 id，第二列是表情，第三列是含义）：\n${lines.join('\n')}${recentHint}\n\n`
    + '规则：\n'
    + `· 最多选 ${c.maxEmojis} 个，宁少勿多；一个都不想贴就回 none。\n`
    + '· 只有情绪明确时才选（好笑得意的、无奈的、赞同的、惊讶的、服了的…）；'
    + '平铺直叙、正经回答问题、正在生气或严肃时就回 none。\n'
    + '· 只从上面清单里选，不要发明新 id。\n'
    + '· 只输出 id（逗号分隔）或 none，不要标点以外的任何解释。';

  const r = await chatCompletion({
    messages: [
      { role: 'system', content: '你在替一个 QQ 机器人在消息上贴表情回应。输出必须极简：id 列表或 none。' },
      { role: 'user', content: ask }
    ],
    temperature: 0.6,
    // ⚠️ 不能给太小：会"先思考"的模型（gemini-3.8 等）会把额度用在 reasoning 上，
    //    回话被截断。这里留足额度，答案本身只有几个字符。
    maxTokens: 600,
    tag: 'msg-reaction-pick'
  });

  const raw = String(r?.message?.content ?? '').trim();
  if (!raw) throw new Error('模型返回空内容');
  if (/^(none|no|不贴|无|-)$/i.test(raw) || /^none\b/i.test(raw)) return [];
  // 宽松解析：把回话里所有数字抓出来，只保留在池子里的 —— 模型偶尔会带解释，
  // 或者写成 "[128077, 128514]"，都不该因此整条失败。
  const ids = (raw.match(/\d{2,9}/g) || [])
    .filter((id) => pool.includes(id))
    .filter((id, i, arr) => arr.indexOf(id) === i)
    .slice(0, c.maxEmojis);
  if (!ids.length) throw new Error(`模型没给出池内 id：${raw.slice(0, 80)}`);
  return ids;
}

function installSendHook() {
  const proto = OneBotClient?.prototype;
  if (!proto || typeof proto.call !== 'function') return false;

  // ── 为什么这里要先"剥洋葱" ────────────────────────────────────────────────
  // 热重载会用 `?t=时间戳` 重新 import 本模块，每次都是**新的模块实例**。
  // 只靠 `proto.call.__msgReaction` 认领是不够的：实测日志里每条发送都打了**两行**
  // 观测记录，栈里能同时看到两代实例的补丁 —— 补丁被套了两层。
  // 后果很实在：一次发送被掷两次概率，20% 实际变成 36%，
  // **设置里填的数字就失真了**。
  // 所以先把已有补丁全部剥掉，拿到"真身"再重新包一层，保证层数恒等于 1。
  let base = proto.call;
  let hops = 0;
  while (base && base.__msgReaction && base.__msgReactionOriginal && hops < 16) {
    base = base.__msgReactionOriginal;
    hops += 1;
  }
  // 剥到底还带着补丁标记 → 链上有老版本装的补丁，它没留回溯指针，我们无法再往下剥。
  // 这时**绝不叠新补丁**（否则层数继续涨），直接认领：
  // 旧补丁会走 G.dispatch，而 G.dispatch 每次 setup 都指向最新实例，行为依然是最新的。
  if (base && base.__msgReaction) {
    G.installed = true;
    G.originalCall = null;   // 已知剥不干净：丢掉被污染的缓存，交给 dispatch 兜底
    return true;
  }

  // 真身优先用缓存那份（跨热重载稳定），没有就用刚剥出来的
  const original = (G.originalCall && !G.originalCall.__msgReaction) ? G.originalCall : base;
  G.originalCall = original;

  const patched = function (...args) {
    const result = original.apply(this, args);
    try {
      const [action, params] = args;
      if (SEND_ACTIONS.has(action) && params && result && typeof result.then === 'function') {
        // ⚠️ 只用派生 promise 观测，**原样返回 result** —— 发送能不能成功
        //    与本插件无关，绝不能因为观测抛错/变慢而影响原调用。
        //
        // ⚠️⚠️ 处理函数必须走 G.dispatch 这个**共享转发口**，不能直接闭包 onOutboundSent：
        //    热重载会 import 出新模块实例，但原型上这个补丁是**旧实例装的、不会重装**。
        //    直接闭包旧函数的话，改完代码热重载后跑的仍然是旧逻辑（要重启才生效）——
        //    这个坑实测踩过（v1.0 → v1.1 升级后行为没变）。
        //    G.dispatch 由最新一次 setup() 覆盖，于是补丁只装一次、逻辑永远是最新的。
        result.then(
          (data) => { try { G.dispatch?.(action, params, data); } catch { /* 观测失败不影响发送 */ } },
          () => { /* 发送本身失败：什么都不做 */ }
        );
      }
    } catch { /* 同上 */ }
    return result;
  };
  patched.__msgReaction = true;
  patched.__msgReactionOriginal = original;   // 供下次热重载"剥洋葱"用
  G.patchedCall = patched;   // 留个引用：排障与离线自检要用
  proto.call = patched;
  G.installed = true;
  return true;
}

// ── 状态落盘（只写数据目录；写不了也不影响功能）────────────────────────────
function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!raw || typeof raw !== 'object') return;
    if (raw.chats && typeof raw.chats === 'object') {
      for (const [key, v] of Object.entries(raw.chats)) {
        if (!v || typeof v !== 'object') continue;
        G.chats.set(key, {
          lastReactAt: Number(v.lastReactAt) || 0,
          hourStamps: Array.isArray(v.hourStamps) ? v.hourStamps.map(Number).filter(Number.isFinite) : [],
          dayKey: String(v.dayKey || ''),
          dayCount: Number(v.dayCount) || 0,
          recentEmojis: Array.isArray(v.recentEmojis) ? v.recentEmojis.map(String) : [],
          // v1.3：按需路径自己的计数 + 已贴过的消息 id（与上面的自动计数互不干扰）
          lastToolAt: Number(v.lastToolAt) || 0,
          toolHourStamps: Array.isArray(v.toolHourStamps) ? v.toolHourStamps.map(Number).filter(Number.isFinite) : [],
          reactedMids: Array.isArray(v.reactedMids) ? v.reactedMids.map(String) : [],
          pausedUntil: 0,
          fails: 0
        });
      }
    }
    const s = raw.stats || {};
    G.stats = {
      attempts: Number(s.attempts) || 0,
      sent: Number(s.sent) || 0,
      onDemand: Number(s.onDemand) || 0,
      blocked: Number(s.blocked) || 0,
      skipped: Number(s.skipped) || 0,
      failed: Number(s.failed) || 0,
      lastAt: Number(s.lastAt) || 0,
      lastEmoji: String(s.lastEmoji || ''),
      lastReason: String(s.lastReason || '')
    };
  } catch { /* 首次运行 / 文件损坏：用空状态 */ }
}

function saveState(force = false) {
  const now = nowMs();
  if (!force && now - G.savedAt < 5000) return;   // 5 秒合并写，别让每个表情都落一次盘
  G.savedAt = now;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const chats = {};
    // 只保留最近 200 个会话，防止长期运行把文件撑大
    const entries = [...G.chats.entries()].slice(-200);
    for (const [key, v] of entries) {
      chats[key] = {
        lastReactAt: v.lastReactAt || 0,
        hourStamps: (v.hourStamps || []).slice(-64),
        dayKey: v.dayKey || '',
        dayCount: v.dayCount || 0,
        recentEmojis: (v.recentEmojis || []).slice(-KEEP_EMOJI_MEMORY),
        lastToolAt: v.lastToolAt || 0,
        toolHourStamps: (v.toolHourStamps || []).slice(-64),
        reactedMids: (v.reactedMids || []).slice(-REACTED_MID_MEMORY)
      };
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify({ version: 2, chats, stats: G.stats }, null, 0), 'utf8');
  } catch { /* 只写数据目录；写不了不影响功能 */ }
}

function chatState(chatKey) {
  let st = G.chats.get(chatKey);
  if (!st) {
    st = {
      lastReactAt: 0, hourStamps: [], dayKey: '', dayCount: 0, recentEmojis: [],
      pausedUntil: 0, fails: 0,
      lastToolAt: 0, toolHourStamps: [], reactedMids: []   // 按需路径自己的计数
    };
    G.chats.set(chatKey, st);
  }
  return st;
}

const dayKeyOf = (ts) => new Date(ts).toISOString().slice(0, 10);
function rollDay(st, now) {
  const key = dayKeyOf(now);
  if (st.dayKey !== key) { st.dayKey = key; st.dayCount = 0; }
}

function pickEmoji(c, st) {
  const pool = c.emojiPool.length ? c.emojiPool : DEFAULT_EMOJIS;
  if (pool.length === 1) return pool[0];
  const recent = new Set(c.avoidRepeat ? (st.recentEmojis || []) : []);
  const fresh = pool.filter((e) => !recent.has(e));
  const from = fresh.length ? fresh : pool;
  return from[Math.floor(Math.random() * from.length)];
}

// ── 判频：返回 '' 表示放行，否则返回跳过原因（只用于统计/排障，不刷日志）──
function checkQuota(chatKey, st, c, now) {
  if (!c.enabled) return '插件未启用';
  if (c.mode === 'off' || c.target === 'off') return '已设为关闭';
  if (!/^group:\d+$/.test(chatKey)) return '非群聊（协议不支持）';
  if (skipSet().has(chatKey)) return '在跳过名单里';
  if (G.pausedUntil && now < G.pausedUntil) return '熔断中';
  if (st.pausedUntil && now < st.pausedUntil) return '会话熔断中';
  if (!(c.probability > 0)) return '触发概率为 0';
  if (Math.random() > c.probability) return '随机跳过';
  if (st.lastReactAt && now - st.lastReactAt < c.minGapMs) return '会话冷却中';
  st.hourStamps = (st.hourStamps || []).filter((t) => now - t < 3600000);
  if (c.maxPerHour > 0 && st.hourStamps.length >= c.maxPerHour) return '已达每小时上限';
  rollDay(st, now);
  if (c.maxPerDay > 0 && st.dayCount >= c.maxPerDay) return '已达每日上限';
  return '';
}

// ── v1.5：入站观测 ────────────────────────────────────────────────────────
// 自动路径本来只能从出站参数的 reply 段拿"被回复的消息"，但机器人的人设被刻意
// 设计成"不轻易引用"（见 prompt.js 的【引用与点名】），于是绝大多数回复没有 reply 段，
// 「贴别人」就永远取不到目标 —— 用户看到的现象是"概率 100% 却一条都贴不上别人"。
//
// 解法：走 before-context hook 旁听一次，把"本会话最近一条别人发的消息 id"记下来。
// hook 在每次组装上下文时跑，此时 store 里已经有触发的那条群友消息了。
// 纯旁听，不改上下文、不返回任何东西。
function rememberPeerId(ctx) {
  try {
    const chatKey = String(ctx?.chatKey || '');
    if (!/^group:\d+$/.test(chatKey)) return;
    const list = ctx?.store?.recent?.(chatKey, { limit: 20, includeSelf: false }) || [];
    for (let i = list.length - 1; i >= 0; i--) {
      const mid = Number(list[i]?.mid);
      if (Number.isFinite(mid) && mid !== 0) {
        G.recentPeer.set(chatKey, { mid, at: nowMs() });
        break;
      }
    }
    // 只留最近的若干个会话，别把这个 Map 养大
    if (G.recentPeer.size > 200) {
      for (const [k, v] of G.recentPeer) {
        if (nowMs() - (v?.at || 0) > 30 * 60 * 1000) G.recentPeer.delete(k);
      }
    }
  } catch { /* 旁听失败不影响任何东西 */ }
}

// 取本会话最近记下的"别人发的消息"，太旧（> 120s）就不用，避免贴到很久以前那条
function cachedPeerId(chatKey, now) {
  const v = G.recentPeer.get(chatKey);
  if (!v || !v.mid) return 0;
  if (now - (v.at || 0) > PEER_CACHE_TTL_MS) return 0;
  return Number(v.mid) || 0;
}

// ── 真·入口：每有一条消息成功发出，就被补丁叫到这里 ────────────────────────
function onOutboundSent(action, params, ownId) {
  const c = settings();
  if (!c.enabled || c.mode === 'off' || c.target === 'off') return;

  const isGroup = action === 'send_group_msg';
  const chatKey = isGroup
    ? `group:${String(params?.group_id ?? '')}`
    : `private:${String(params?.user_id ?? '')}`;
  if (!/^(group|private):\d+$/.test(chatKey)) return;

  const wantSelf = c.target === 'self' || c.target === 'both';
  const wantPeer = c.target === 'peer' || c.target === 'both';
  const nowTs = nowMs();

  const candidates = [];
  // 自己的消息：用回包里的 message_id（最稳，协议端刚登记过 meta）
  if (wantSelf && ownId) candidates.push(ownId);
  // 被回复的消息：优先用 reply 段（最准确）
  if (wantPeer) {
    const peerId = replyTargetOf(params);
    if (peerId) candidates.push(peerId);
    // v1.5：没有 reply 段时，退回本会话最近一条别人发的消息（入站旁听缓存的）。
    // 这是"给别人的消息贴表情"能真正生效的关键 —— 否则机器人不引用就永远贴不到别人。
    else {
      const cached = cachedPeerId(chatKey, nowTs);
      if (cached) candidates.push(cached);
    }
  }
  // v1.4 兼容：目标是「被回复的消息」但既没引用、缓存里也没有 → 退回贴自己刚发的那条。
  // （fallbackToSelf 关掉时就不贴，避免表情跑到机器人自己的气泡上。）
  if (!candidates.length && c.fallbackToSelf && ownId) candidates.push(ownId);

  const text = textOf(params);

  // ── 一次发送只掷一次概率 ──────────────────────────────────────────────────
  // 热重载可能让补丁叠加（见 installSendHook 的注释），同一次发送就会走到这里两次，
  // 概率等于被掷两遍：填 20% 实际是 36%。这里按"会话 + 消息 id"去重，
  // 保证**设置里填多少就是多少**。
  const now = nowMs();
  const seenKey = `${chatKey}#${ownId || text.slice(0, 24)}`;
  const prev = G.seen.get(seenKey) || 0;
  if (prev && now - prev < SEEN_DEDUP_MS) {
    if (c.logSends) log(`重复观测，已忽略（同一条发送在 ${now - prev}ms 内被观测了两次）`);
    return;
  }
  G.seen.set(seenKey, now);
  // 裁剪：先丢过期的；还超上限就直接清空（宁可短暂失去去重，也不能让 Map 无限长）
  if (G.seen.size > SEEN_MAX) {
    for (const [k, t] of G.seen) if (now - t > SEEN_DEDUP_MS) G.seen.delete(k);
    if (G.seen.size > SEEN_MAX) G.seen.clear();
  }

  // 排障开关：把每一条观测到的出站发送都记下来（默认关，避免刷日志）
  if (c.logSends) {
    // v1.5：标出候选目标是从哪来的 —— 「引用」= 这次真引用了别人；「最近群友」= 走旁听兜底。
    // 有这行才能一眼看出"贴的到底是谁的消息"，不用再去猜。
    const peerFrom = replyTargetOf(params) ? '引用'
      : (wantPeer && cachedPeerId(chatKey, nowTs) ? '最近群友' : '—');
    log(`观测到出站发送 ${action} ${chatKey} own=#${ownId || '—'} peer=#${replyTargetOf(params) || '—'}`
      + ` 目标来源=${peerFrom} text=「${text.slice(0, 30)}」（本次候选 ${candidates.length} 个）`);
  }

  if (!candidates.length) return;   // 没得点，静默
  // 两者随机：一次只点一个，别在一条消息上叠两个表情
  const messageId = candidates.length === 1 ? candidates[0] : candidates[randInt(0, candidates.length - 1)];

  const st = chatState(chatKey);
  const reason = checkQuota(chatKey, st, c, now);
  if (reason) {
    if (reason === '非群聊（协议不支持）' && !G.warnedPrivate) {
      G.warnedPrivate = true;
      log('私聊没有「表情回应」这个东西（QQ 协议限制），该会话已跳过');
    }
    G.stats.skipped += 1;
    G.stats.lastReason = `skip ${reason}`;
    // v1.4：记下是被哪个闸门拦的，面板里能直接看到 —— 否则用户调了概率
    // 却看不到效果，只会以为设置是摆设。
    G.byReason.set(reason, (G.byReason.get(reason) || 0) + 1);
    if (c.logSkips) log(`不贴（${chatKey} 消息 #${messageId}）：${reason}`);
    return;
  }
  scheduleFire(chatKey, messageId, text, c);
}

function scheduleFire(chatKey, messageId, text, c) {
  const delay = randInt(c.delayMinMs, c.delayMaxMs);
  const handle = setTimeout(() => {
    G.pending.delete(handle);
    fire(chatKey, messageId, text).catch(() => { /* fire 内部已吞错 */ });
  }, delay);
  handle.unref?.();   // 定时器不该吊住进程退出
  G.pending.add(handle);
}

/**
 * 决定"贴哪几个"，然后逐个贴上去。
 * AI 模式：把刚发出的那句话交给模型，让它挑 0~2 个（挑的是"心情"，不是"凑数"）。
 * 随机模式：从池子里随机抽 1 个。
 * 两者都会被 c.maxEmojis（设置里锁死 1~2）再截一次。
 */
async function chooseEmojis(c, text, st) {
  // ⚠️ 出口统一截断：不管挑表情的是注入的测试函数、AI、还是随机，
  //    "一条消息最多 maxEmojis 个"这条底线都必须在**唯一出口**上兜住 ——
  //    分散在三个分支里各截一次，迟早有一条分支被漏掉（自检就是这么抓到的）。
  const cap = (list) => (Array.isArray(list) ? list.filter(Boolean).slice(0, c.maxEmojis) : []);
  if (typeof G.pickFn === 'function') return cap(await G.pickFn(c, text, st));   // 离线自检注入
  if (c.mode === 'random') return cap([pickEmoji(c, st)]);
  try {
    return cap(await askAiForEmojis(c, text, st));
  } catch (error) {
    // AI 挑失败（渠道挂了 / 返回不可解析）：退回随机一个，别让功能整体哑掉。
    // 只记一行，且**不计入发送失败熔断** —— 这跟协议端能不能贴是两回事。
    warn(`AI 挑表情失败，这次退回随机：${String(error?.message ?? error).slice(0, 120)}`);
    return cap([pickEmoji(c, st)]);
  }
}

/** 贴失败的处理：计数 + 连续失败熔断（协议端不支持时别再死磕）。 */
function handleSendFailure(chatKey, messageId, error, st) {
  G.stats.failed += 1;
  G.failStreak += 1;
  st.fails = (st.fails || 0) + 1;
  const msg = String(error?.message ?? error);
  G.stats.lastReason = `fail ${msg}`;
  warn(`表情回应失败（${chatKey} 消息 #${messageId}）：${msg}`);
  if (G.failStreak >= FAIL_LIMIT) {
    G.pausedUntil = nowMs() + FAIL_PAUSE_MS;
    G.failStreak = 0;
    warn(`连续失败 ${FAIL_LIMIT} 次，暂停 ${Math.round(FAIL_PAUSE_MS / 60000)} 分钟`
      + '（常见原因：协议端版本不支持 set_msg_emoji_like，或这条消息不在协议端缓存里）');
  } else if (st.fails >= FAIL_LIMIT) {
    st.pausedUntil = nowMs() + FAIL_PAUSE_MS;
    st.fails = 0;
  }
  saveState();
}

async function fire(chatKey, messageId, text) {
  const c = settings();
  if (!c.enabled || c.mode === 'off' || c.target === 'off') return;
  const st = chatState(chatKey);
  // 排期期间配额可能已经用掉（同一会话连着发几条时），这里二次校验
  const now = nowMs();
  if (st.lastReactAt && now - st.lastReactAt < c.minGapMs) return;
  st.hourStamps = (st.hourStamps || []).filter((t) => now - t < 3600000);
  if (c.maxPerHour > 0 && st.hourStamps.length >= c.maxPerHour) return;
  rollDay(st, now);
  if (c.maxPerDay > 0 && st.dayCount >= c.maxPerDay) return;
  if (G.pausedUntil && now < G.pausedUntil) return;
  // 同一会话同一时刻只允许一次"挑 + 贴"：连着发两条消息时不会把配额算重
  if (G.inFlight.has(chatKey)) return;
  G.inFlight.add(chatKey);

  try {
    G.stats.attempts += 1;
    const emojis = await chooseEmojis(c, text, st);
    if (!emojis.length) {
      // AI 明确觉得这句不用贴 —— 这不算失败，也不占配额（但要落盘，否则状态面板看不出它在工作）
      G.stats.skipped += 1;
      G.stats.lastReason = `skip AI 认为不用贴（${String(text || '').slice(0, 20)}）`;
      log(`不贴：${chatKey} 消息 #${messageId} —— AI 认为这句话不需要表情`);
      saveState();
      return;
    }

    const ok = [];
    for (const emojiId of emojis) {
      try {
        await sendReaction(messageId, emojiId);
        ok.push(emojiId);
      } catch (error) {
        if (!ok.length) throw error;      // 一个都没贴上：按失败处理
        handleSendFailure(chatKey, messageId, error, st);   // 第二个失败不致命
        break;
      }
    }
    if (!ok.length) return;

    const at = nowMs();
    G.failStreak = 0;
    st.fails = 0;
    st.lastReactAt = at;
    st.hourStamps.push(at);
    rollDay(st, at);
    st.dayCount += 1;
    st.recentEmojis = [...(st.recentEmojis || []), ...ok].slice(-KEEP_EMOJI_MEMORY);
    G.stats.sent += 1;
    G.stats.lastAt = at;
    G.stats.lastEmoji = ok.map(emojiCharOf).join('');
    G.stats.lastReason = `ok ${chatKey}#${messageId}`;
    saveState();
    log(`已给 ${chatKey} 的消息 #${messageId} 贴了 ${ok.length} 个表情：`
      + ok.map((id) => `${emojiCharOf(id)}(${id})`).join(' '));
  } catch (error) {
    handleSendFailure(chatKey, messageId, error, st);
  } finally {
    G.inFlight.delete(chatKey);
  }
}

// ── 状态面板上报（ai-status 的 status.<id> 协议）────────────────────────────
export const providers = {
  [`status.${ID}`]: () => {
    const s = G.stats;
    const c = settings();
    const paused = G.pausedUntil && nowMs() < G.pausedUntil;
    // v1.4：把"为什么没贴"摊开。之前只有一个「跳过 N 次」，
    // 用户把概率调到 100% 却还是很少贴，就会怀疑设置没生效；
    // 其实大概率是被「会话冷却」拦了 —— 现在这一行能直接看出来。
    const reasons = [...G.byReason.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([r, n]) => `${r} ${n}`)
      .join(' · ');

    // 当前会话今天用了多少额度（面板要能直接看出"是不是被上限卡住了"）
    const today = dayKeyOf(nowMs());
    const used = [...G.chats.entries()].reduce((sum, [, v]) => (
      v.dayKey === today ? sum + (Number(v.dayCount) || 0) : sum
    ), 0);

    const lines = [
      ['自动贴', `${s.sent} 次（走概率与配额）`],
      ['被点名贴', `${s.onDemand} 次`],
      ['拦下的', `${s.blocked} 次（模型想贴但没人要求）`],
      ['跳过', `${s.skipped} 次（限频 / 概率 / AI 觉得不用贴）`],
      ['跳过原因', reasons || '—'],
      ['今日额度', c.maxPerDay > 0 ? `${used} / ${c.maxPerDay}` : `${used} / 不限`],
      ['当前设置', `${c.mode} · ${c.target} · ${Math.round(c.probability * 100)}% · 冷却 ${Math.round(c.minGapMs / 1000)}s · 每小时 ${c.maxPerHour} · 每日 ${c.maxPerDay}`],
      ['上次', s.lastAt ? `${new Date(s.lastAt).toLocaleTimeString('zh-CN', { hour12: false })} · ${s.lastEmoji || '—'}` : '还没贴过']
    ];
    const tips = [];
    if (!c.enabled) tips.push('「消息表情回应」已关闭');
    if (c.mode === 'off' || c.target === 'off') tips.push('已被设为「关闭」，插件不动作');
    // ⚠️ 这条提示专门给"概率调到 100% 却没效果"的情况：
    //    最容易踩的是每日上限被当天早些时候的自动贴打满，
    //    之后一整天都不会再贴 —— 不点破的话只会以为设置是摆设。
    if (c.maxPerDay > 0 && used >= c.maxPerDay) {
      tips.push(`今日额度已用满（${used}/${c.maxPerDay}），今天不会再自动贴了；想继续就把「每会话每日上限」调大或设为 0`);
    }
    if (!G.installed) tips.push('出站观测未安装（协议端客户端模块加载异常）');
    if (paused) tips.push('协议端连续失败，已临时熔断');
    if (!c.requireExplicit) tips.push('「必须明说才贴」已关闭：模型可以自己决定贴');
    if (s.failed > 0 && !paused) tips.push(`累计失败 ${s.failed} 次（协议端可能不支持该 action）`);
    return { icon: '😀', title: '消息表情回应', lines, tips, priority: 57 };
  }
};

// ── 生命周期 ────────────────────────────────────────────────────────────────
/**
 * 补齐 globalThis 上那份状态里**这一版新增**的字段。
 * G 是跨热重载共享的：升级插件时它是上一个版本留下的对象，新字段全是 undefined，
 * 不补齐的话新功能会静默失效（例如 G.inFlight 为 undefined → 并发保护直接抛错被吞）。
 */
function migrateState() {
  if (!(G.inFlight instanceof Set)) G.inFlight = new Set();
  if (!(G.chats instanceof Map)) G.chats = new Map();
  if (!(G.pending instanceof Set)) G.pending = new Set();
  if (!(G.seen instanceof Map)) G.seen = new Map();
  if (!(G.byReason instanceof Map)) G.byReason = new Map();
  if (typeof G.stats !== 'object' || !G.stats) {
    G.stats = { attempts: 0, sent: 0, onDemand: 0, blocked: 0, skipped: 0, failed: 0, lastAt: 0, lastEmoji: '', lastReason: '' };
  }
  // 统计字段名补齐：旧的状态文件里没有新字段，直接 Number(undefined)||0 也安全，
  // 但显式补出来能让面板与断言拿到 0 而不是 undefined。
  for (const k of ['attempts', 'sent', 'onDemand', 'blocked', 'skipped', 'failed']) {
    if (typeof G.stats[k] !== 'number') G.stats[k] = 0;
  }
  for (const st of G.chats.values()) {
    if (!Array.isArray(st.hourStamps)) st.hourStamps = [];
    if (!Array.isArray(st.recentEmojis)) st.recentEmojis = [];
    if (!Array.isArray(st.toolHourStamps)) st.toolHourStamps = [];
    if (!Array.isArray(st.reactedMids)) st.reactedMids = [];
    if (typeof st.dayCount !== 'number') st.dayCount = 0;
    if (typeof st.lastReactAt !== 'number') st.lastReactAt = 0;
    if (typeof st.lastToolAt !== 'number') st.lastToolAt = 0;   // v1.2 新增
  }
}

export function setup(api) {
  G.cfgOf = api.config;
  G.logFn = api.log;
  G.warnFn = api.warn;
  migrateState();
  // 补丁只装一次，但**逻辑转发口每次 setup 都指向最新实例**（热重载后立刻生效）
  G.dispatch = (action, params, data) => onOutboundSent(action, params, sentIdOf(data));
  registerReactionTool(api);   // 「别人让我贴」这条路（v1.2）：给模型一个工具
  loadState();
  installSendHook();     // 唯一的核心补丁，只观测不干预
  const c = settings();
  log(`已上线：${c.mode} · ${c.target} · 概率 ${Math.round(c.probability * 100)}% · 冷却 ${Math.round(c.minGapMs / 1000)}s`
    + ` · 每小时 ${c.maxPerHour} 次 · 一条最多 ${c.maxEmojis} 个；池内 ${c.emojiPool.length} 个表情；`
    + `出站观测${G.installed ? '已安装' : '❌未安装'}；入站旁听已安装（无引用时改用最近一条群友消息）；`
    + `「贴表情回应」工具已注册（别人点名让你贴时走这条，不受限频约束）`);
}

// v1.5：入站旁听 —— 每次组装上下文时记下"本会话最近一条别人发的消息"。
// 挂在 before-context 上（基础 0.4 包也支持这个钩子，见 ai-status 的踩坑注释），
// 此时 ctx.store 里已经能看到触发的那条群友消息，正好用来当"贴别人"的兜底目标。
// 纯旁听：不改上下文、不返回任何东西，捕错隔离，绝不影响正常回复。
export const hooks = {
  'before-context': (ctx) => {
    rememberPeerId(ctx);
  }
};

export function activate() {
  // 热重载时补丁与定时器挂在 G 上、原型上是同一个函数，不需要重建；
  // 但首次安装或补丁被别的路径还原时，这里补一次。
  installSendHook();
}

export function deactivate() {
  // 注意：重载路径会调用 deactivate。**不要**在这里卸补丁或清 G.pending，
  // 否则"改一个字的配置"会把已经排队、几秒后要点的表情全丢掉。
}

export function dispose() {
  for (const h of G.pending) { try { clearTimeout(h); } catch { /* ignore */ } }
  G.pending.clear();
  saveState(true);
}

// 纯函数与内部入口导出：便于离线自检 / 回归测试（不依赖核心与协议端）
export const internals = {
  settings,
  replyTargetOf,
  sentIdOf,
  textOf,
  emojiCharOf,
  parseEmojiSpec,
  isReactionRequest,
  someoneAskedToReact,
  lastPeerMessage,
  pickEmoji,
  checkQuota,
  handleSent: onOutboundSent,
  reactTool: REACTION_TOOL
};
