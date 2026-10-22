// 问号接龙（确定性型插件 / plugins/question-relay）
//
// ── 为什么是插件，不是技能 ────────────────────────────────────────────────
// 触发条件能写成死的 if（「连续 ≥2 条纯问号消息」），接什么也是固定的
// （一个「？」）。按三问判断法：
//   ① 触发时机能用 if 描述吗 —— 能，纯字符判定；
//   ② 漏触发一次的代价 —— 小（娱乐玩法，错过一条谁也不会掉血）；
//   ③ 参数从哪来 —— 固定配置（接龙字符、条数阈值），不从人话里抠。
// 三问全指向确定性 → 按规范落 plugins/，不落 skills/。
//
// ── 它怎么工作（一句话：判定归代码，说话走正门）──────────────────────────
//   before-context：拿 store.recent 从最新消息往回数「连续的纯问号」——
//     · 链里已经有机器人自己的问号 → 本轮接过，不再接（同轮只接一次）；
//     · 链断了（最新一条不是问号）→ 自然结束，什么都不做；
//     · 群友问号 ≥ minChain 且最新一条就是问号 → 记下「本会话应接一次」。
//   before-llm-messages：把一行强指令追加到发给模型的消息**末尾**——
//     模型看到「只回一个问号」就照做，经 send_message 发出（限频、去重、
//     留档都在这条正门里）。
//
// ── 为什么不直接在钩子里发消息 ────────────────────────────────────────────
//   本项目约定：钩子禁网禁发（command-digest / api-beggar 同款约束），
//   扩展侧根本没有发送通道（createSkillApi 只给 registerTool/config/fetch…）。
//   唯一合法的发言路径就是模型的 send_message —— 所以本插件的做法是
//   「用确定性判定把模型推出去说那一句话」，而不是自己绕过 SendQueue。
//
// ── 状态与文件（不落盘的理由）─────────────────────────────────────────────
//   · 内存 Map 记「待接」标记；热重载清空只会少接/多接一次，自愈；
//   · 绝不写插件目录 —— fs.watch 对 plugins/ 递归监听，自写文件会触发
//     热重载自激回路（api-beggar 的注释里已经踩过同一个坑）；
//   · 也不需要 DATA_DIR：这点瞬时状态不值得跨进程持久化。
//
// ── 和响应档位的关系（值得知道的一件事）──────────────────────────────────
//   判定发生在「消息触发机器人处理」的时刻（本机 store.contextTier = 3，
//   未艾特的消息约随机一半概率触发；连刷多条问号时，触发后的 2 秒聚批
//   窗口会把后续问号一起带进判定视野）。所以多轮接龙基本都能接上；
//   只有「极短的一两条问号、且恰好全部未触发」时才会错过。
//
// ── 边界 ──────────────────────────────────────────────────────────────────
//   · 只在群聊、非「主动机会」会话里工作（私聊和冷场开话题不掺和）；
//   · 机器人自己在哪些群干活由控制台白名单决定，本插件跟着走 ——
//     白名单外的聊天连存档都没有，这里自然看不到、也不会接；
//   · 撤回的消息在数链时视作不存在（跳过、不断链）；
//   · 全程同步内存运算，远低于钩子 5s 超时。

/** 出厂默认值（与 plugin.json 的 settings 保持一致）。 */
const DEFAULTS = {
  enabled: true,
  relayChar: '？',
  questionChars: '?？',
  minChain: 2,
  lookback: 30
};

/** 注入标记：同时充当幂等判据（同一条消息不重复注入）。 */
const INJECT_MARK = '【接龙请求】';

/** 待接标记的新鲜度上限：超过它认为是上一轮失败的残留，直接丢弃。 */
const PENDING_TTL_MS = 120000;

let cfg = () => ({});
let log = () => {};
let warn = () => {};

/** chatKey → { sessionId, at, peer, relayChar }。只在内存，热重载清空。 */
const pending = new Map();

/** 运行统计（状态面板用，只增不改）。 */
const stats = { totalRelays: 0, lastRelayAt: 0 };

export function setup(api) {
  cfg = api.config || (() => ({}));
  log = api.log || (() => {});
  warn = api.warn || (() => {});
  log(`问号接龙已加载：连续问号 ≥${DEFAULTS.minChain} 条时自动跟着接一个，同轮只接一次`);
}

/** 可用性自检：必须同步返回；本插件无外部依赖，恒可用。 */
export function available() {
  return { ok: true };
}

// ── 钩子 ──────────────────────────────────────────────────────────────────

export const hooks = {
  /**
   * 判定链：从最新消息回看「连续纯问号」，决定本会话要不要接。
   * 数据源是 store.recent（核心传进来的公开只读方法），纯内存运算。
   */
  'before-context'(payload = {}) {
    try {
      const s = readSettings();
      if (!s.enabled) return;
      if (String(payload.kind) !== 'group') return;   // 接龙只在群里玩
      if (payload.proactive) return;                  // 主动机会（冷场开话题）不掺和
      const chatKey = String(payload.chatKey || '');
      const store = payload.store;
      if (!chatKey || !store || typeof store.recent !== 'function') return;

      const list = store.recent(chatKey, { limit: s.lookback }) || [];
      const chain = analyzeChain(list, s.questionChars);
      // 三条闸门：最新一条是问号；群友问号够数；链里还没有机器人的问号（没接过）
      if (!chain.tailIsQuestion || chain.peer < s.minChain || chain.robot > 0) return;

      pending.set(chatKey, {
        sessionId: payload.sessionId,
        at: Date.now(),
        peer: chain.peer,
        relayChar: s.relayChar
      });
      log(`检测到问号接龙（群友连续 ${chain.peer} 条），本条会话接一个「${s.relayChar}」`);
    } catch (error) {
      // 判定失败 = 本轮不接，会话本身不受影响
      warn(`接龙判定失败（本次不接）：${String(error?.message || error)}`);
    }
  },

  /**
   * 注入：把接龙指令追加到发给模型的消息末尾。
   * 只改发给模型的 messages（存档对象一个字节都不动）；返回值忽略。
   */
  'before-llm-messages'(payload = {}) {
    try {
      const chatKey = String(payload.chatKey || '');
      const p = pending.get(chatKey);
      if (!p) return;
      pending.delete(chatKey);                        // 无论用不用都清，防残留
      if (Date.now() - p.at > PENDING_TTL_MS) return; // 太老：上一轮失败的残留
      if (p.sessionId && payload.sessionId && p.sessionId !== payload.sessionId) return;

      const messages = payload.messages;
      if (!Array.isArray(messages) || !messages.length) return;
      const msg = messages[messages.length - 1];
      if (!msg || msg.role !== 'user' || typeof msg.content !== 'string') return;
      if (msg.content.includes(INJECT_MARK)) return;  // 幂等：同一条不重复注入

      msg.content = `${msg.content}\n\n${buildDirective(p.peer, p.relayChar)}`;
      stats.totalRelays += 1;
      stats.lastRelayAt = Date.now();
      log(`已注入接龙指令（累计 ${stats.totalRelays} 次）`);
    } catch (error) {
      warn(`接龙指令注入失败（本次不接）：${String(error?.message || error)}`);
    }
  }
};

// ── 链分析 ────────────────────────────────────────────────────────────────

/**
 * 从最新消息往回数「连续的纯问号」。
 *   · 撤回的消息视作不存在（跳过，不断链）；
 *   · 遇到任何非问号消息（含机器人发言、拍一拍、图片占位）→ 链到此为止；
 *   · robot = 链里机器人自己发的问号数（> 0 表示本轮已经接过）。
 *
 * @returns {{peer:number, robot:number, tailIsQuestion:boolean}}
 */
function analyzeChain(list, qchars) {
  let peer = 0;
  let robot = 0;
  let tailIsQuestion = false;
  let first = true;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m || m.recalled) continue;          // 撤回的当不存在
    const q = isQuestionOnly(m.text, qchars);
    if (first) {
      first = false;
      if (!q) break;                         // 最新一条都不算问号 → 不在接龙中
      tailIsQuestion = true;
    }
    if (!q) break;                           // 链断
    if (m.self) robot += 1;
    else peer += 1;
  }
  return { peer, robot, tailIsQuestion };
}

/** 纯问号消息：去掉所有空白后，每个字符都在「问号字符集」里。 */
function isQuestionOnly(text, qchars) {
  const s = String(text ?? '').replace(/\s+/g, '');
  if (!s) return false;
  for (const ch of s) {
    if (!qchars.includes(ch)) return false;
  }
  return true;
}

/** 注入文案：强指令，明确「只回一个问号、别的都不要」。 */
function buildDirective(peer, relayChar) {
  return `${INJECT_MARK}群里正在玩问号接龙（已有 ${peer} 条连续问号）。`
    + `请立刻在当前会话**只发一个「${relayChar}」**：`
    + '不要任何其他文字、不要解释、不要 @ 任何人、不要调用其他工具。';
}

// ── 设置 ──────────────────────────────────────────────────────────────────

/** 执行时现读（setup 时快照会导致改了设置不生效）。 */
function readSettings() {
  let raw = {};
  try { raw = cfg() || {}; } catch { raw = {}; }
  return {
    enabled: raw.enabled !== false,   // 双保险：插件开关由 manager 层把关，这里再兜一层
    relayChar: pickChar(raw.relayChar, DEFAULTS.relayChar),
    questionChars: pickQuestionChars(raw.questionChars),
    minChain: clampInt(raw.minChain, 1, 10, DEFAULTS.minChain),
    lookback: clampInt(raw.lookback, 5, 200, DEFAULTS.lookback)
  };
}

function pickChar(value, fallback) {
  const s = String(value ?? '').trim();
  return s || fallback;
}

/** 问号字符集：去空白、去重；空配置回退默认「?？」。 */
function pickQuestionChars(value) {
  const raw = String(value ?? '').replace(/\s+/g, '');
  const out = [];
  for (const ch of raw) {
    if (!out.includes(ch)) out.push(ch);
  }
  return out.length ? out.join('') : DEFAULTS.questionChars;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

// ── 状态上报（ai-status「插件状态」分区，同步返回、不 IO）────────────────

export const providers = {
  'status.question-relay': () => {
    if (!stats.lastRelayAt) return null;   // 还没接过 → 不占格子
    return {
      icon: '❓',
      title: '问号接龙',
      priority: 70,
      lines: [
        ['累计接龙', `${stats.totalRelays} 次`],
        ['最近一次', new Date(stats.lastRelayAt).toLocaleTimeString('zh-CN', { hour12: false })]
      ],
      tips: []
    };
  }
};
