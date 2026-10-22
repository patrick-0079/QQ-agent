// 省 token · 投递即收尾（确定性版）
//
// ── 它解决什么 ────────────────────────────────────────────────────────────
// orchestrator 的循环是：
//   for (let round = 0; round < maxRounds && !finish; round++)
// 默认 maxRounds = 2。于是只要模型在第一轮调了 send_message 而没同一次响应里
// 带上 finish，就**必然再打一次完整模型调用**，带着同样的 ~17,000 token 上下文，
// 产出只有一句 finish。
//
// 实测（本机 sessions 留档）：
//   · 245 个有效会话里 239 个是 2 轮
//   · 最后一轮的工具组合：(finish,) 126 次、(send_message,) 95 次
//   · 也就是约 **45% 的轮次**，第二次调用纯属浪费
//
// 已有的 finish-merge 插件靠提示词要求模型"同一次响应里先 send_message 再 finish"，
// 该段提示词 200/200 都在系统提示里，但仍有 91/200 拆成两次响应。
// **批处理工具调用不能靠提示词祈祷，必须用代码定死。**
//
// ── 它怎么工作 ────────────────────────────────────────────────────────────
// 核心（orchestrator.js:1230）已经留好了钩子：
//     const policyFn = this.#capFirst('reply.local-policy', skillContext);
//     const r = policyFn({ api, entries, batch: { calls, results, newSent, allSent, searched } });
//     if (r?.shouldEnd) finish = true;
// 但那句注释所说的"判定规则本身在插件里（canEndReplyBatch…）"**从未被实现**，
// 全仓库没有任何 reply.local-policy 提供者 —— 这段是死代码。
// 本插件把它补上。
//
// 规则（全部可配）：
//   1. 本批工具调用**全部**是"投递类"（把内容送到群里），
//      不含任何"查询类"（看图/搜索/翻记录/翻表情/查成员）；
//   2. 且确实送出了东西（session.sent 有新增，或调用了纯副作用工具）；
//   → 直接收尾，不再打第二次模型调用。
//
// ── 为什么丢了第二轮不掉智商 ──────────────────────────────────────────────
//   · send_message 的参数是 oneOf[string, array]，**数组 = 分多条发送**，
//     sender.sendTextBatch 会按 send.minGapMs / maxGapMs 逐条间隔发出。
//     要多说几句，本来一轮就能说完。
//   · 系统提示里现在就写着"普通对话默认 1 条，最多 2 条；要分条就传数组"。
//   · 实测只有 6/200（3%）的轮次在第二轮补发了第二条消息 —— 代价极小，
//     而收益是 45% 的轮次少一次完整调用。
//   · 只要本批出现了任何查询类工具（典型：get_message_images → 下一轮 send_message），
//     本插件**不会**干预，多步推理链完全保留。
//
// ── 怎么关掉 ──────────────────────────────────────────────────────────────
//   插件页禁用它，或删掉 plugins/auto-finish/ 目录。
//   钩子取不到提供者时 #capFirst 返回 null，行为与没有本插件时**完全一致**。

let api = null;
let log = () => {};

const DEFAULTS = {
  // 送完就收尾（关掉 = 本插件完全不动手）
  stopAfterDelivery: true,
  // 必须确实送出了东西才收尾（避免"工具全失败/空参数"时误判为已交付）
  onlyIfDelivered: true,
  // 出现查询类工具就不干预（强烈建议保持 true —— 这是"多步任务不被截断"的保险）
  queryGuard: true,
  // 投递类工具清单（逗号分隔）。留空 = 用下面的内置默认值
  deliveryTools: '',
  // 强制视为"查询类"的工具（逗号分隔）。用来把某个工具从投递类里摘出来
  queryTools: ''
};

// 内置：把内容送到群里的工具（副作用即交付，不存在"还在准备"的中间态）
const BUILTIN_DELIVERY = new Set([
  'send_message', 'send_to', 'send_sticker', 'send_poke', 'send_image',
  // Skill 提供的投递类工具（按 <skillId>__<tool> 命名；前缀不写死，
  // 只认后缀，这样换 skill 实现不用改这里）
  'tts-say__say', 'tts-say__say_to',
  'ai-image__gen', 'comfy-draw__local_draw',
  'music__send_music', 'smart-image__send'
]);

// 内置：明确是"查询类"的工具（拿到结果后模型还需要再决定说什么 → 必须继续循环）
const BUILTIN_QUERY = new Set([
  'get_message_images', 'get_sticker_image', 'list_stickers', 'search_images',
  'web_search', 'web_fetch', 'read_forward', 'read_video', 'get_recent_messages',
  'get_message_detail', 'get_active_members', 'get_chats', 'memory_query',
  'collect_sticker', 'check_holiday', 'list_reminders', 'report_feedback'
]);

function settings() {
  const raw = (api && typeof api.config === 'function' ? api.config() : null) || {};
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

function splitList(s) {
  return String(s || '')
    .split(/[,，\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function toolName(t) {
  if (!t) return '';
  if (typeof t === 'string') return t;
  return String(t?.function?.name ?? t?.name ?? '');
}

/**
 * 判断这一批工具调用是否构成"已交付、可以收尾"。
 * 返回 { shouldEnd, reason } 或 null（不干预）。
 */
function decide({ batch = {}, entries = [] } = {}) {
  const s = settings();
  if (s.stopAfterDelivery === false) return null;

  const calls = Array.isArray(batch.calls) ? batch.calls : [];
  const names = calls.map(toolName).filter(Boolean);
  if (!names.length) return null;                       // 本批没有工具调用，交给核心处理

  const delivery = new Set([...BUILTIN_DELIVERY, ...splitList(s.deliveryTools)]);
  const query = new Set([...BUILTIN_QUERY, ...splitList(s.queryTools)]);
  // 自定义投递清单里的工具要优先于内置查询清单（用户显式指定说了算）
  const custom = new Set(splitList(s.deliveryTools));
  for (const n of custom) query.delete(n);

  // finish 由核心处理（它会置 finish=true 并跑活跃模式状态机），这里不抢
  if (names.includes('finish')) return null;

  // ── 保险：出现任何查询类工具就不干预 ──
  // 典型场景：第 1 轮 get_message_images（看图）→ 第 2 轮 send_message。
  // 截断第 2 轮 = 看了图却不说话，绝对不能做。
  if (s.queryGuard !== false) {
    const hasQuery = names.some((n) => !delivery.has(n) || query.has(n));
    if (hasQuery) return null;
  }

  // ── 必须确实交付了东西 ──
  // newSent 来自 session.sent 的新增（text / sticker / image 都会记进去）。
  // 纯副作用型投递工具（表情/戳一戳/语音）如果没进 session.sent，也认。
  const newSent = Array.isArray(batch.newSent) ? batch.newSent : [];
  const SIDE_EFFECT_ONLY = /(sticker|poke|say|music|draw|gen)$/i;
  const delivered = newSent.length > 0 || names.some((n) => SIDE_EFFECT_ONLY.test(n));
  if (s.onlyIfDelivered !== false && !delivered) return null;

  return {
    shouldEnd: true,
    reason: `本批已交付完毕（${names.join('+')}），省掉一次收尾调用`
  };
}

export const providers = {
  // 核心 orchestrator.js:1231 消费这个能力；没有提供者时那段分支是空操作
  'reply.local-policy': decide
};

export function setup(a) {
  api = a;
  log = (a && typeof a.log === 'function') ? a.log : () => {};
  const s = settings();
  log(`投递即收尾已启用：stopAfterDelivery=${s.stopAfterDelivery} `
    + `onlyIfDelivered=${s.onlyIfDelivered} queryGuard=${s.queryGuard}`);
}

export function activate() { /* setup 里已经打过日志 */ }

export function available() { return { ok: true }; }
