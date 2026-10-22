// 预热闸门修复（prewarm-fix）
//
// ── 要解决的问题 ───────────────────────────────────────────────────────
// 内置的「调用前预热」有一道 45 秒闸门，但它判断「是不是同一前缀」的依据是
// 上一次见到的**系统提示**。而系统提示经 deferVolatile 处理之后，在同一个聊天里
// 是逐字节恒定不变的（实测：同一个聊天里的几十个会话往往只对应 2~4 个不同版本，
// 差异全部来自 skill 段插拔）。于是那道闸门实际退化成「全局 45 秒只能预热一个会话」，
// 与「同一前缀」毫无关系。
//
// 实测（同一份日志，只统计 cache-stat 的「第 1 次调用」）：
//   会话首调   加权命中约 78%，完全脱靶 19 次
//   会话第2次  加权命中 97%+，完全脱靶  0 次
//   会话第3次  加权命中 97%+，完全脱靶  0 次
// 也就是说：**只有会话首调在挨打**，后续轮次本来就命中。本插件因此只补首调。
//
// ── 做法 ──────────────────────────────────────────────────────────────
// 不修改任何内置文件，只挂一个 llm.request-params 转换器。核心会在真正发请求之前
// 依次 await 每个转换器，并把**已经定稿的最终请求体**交给它。核心每轮会构造两次
// 同一份 body：先"只构造不发送"交给预热（第一次），真正要发的时候再算一遍
// （第二次，见 llm.js:487-518 的注释）。于是本插件按这个节奏工作：
//
//   第 1 次见到某 body  → 先不动。只是记下来，等真实调用再决定
//   期间若内置预热/保活发了同一个 body（max_tokens=1）→ 记下它的指纹
//   第 2 次见到同一 body（这就是真实调用）→
//       已经有人预热过 → 直接放行（**不发请求**，避免重复）
//       没人预热过     → 这才补发一次 max_tokens=1 的预热
//
// 这样每个新前缀**恰好被预热一次**：内置闸门放行时由内置写，被闸门挡住时由本插件
// 写，不会出现"两次预热 + 多等 3 秒"的重复劳动。
//
// 另外两条必要的跳过规则：
//   · 同一会话的续写（上次的消息序列是本次的前缀、工具没变）→ 跳过。
//     第 2 轮起本来就 97%+，再预热纯属多打一次请求、多等 1~3 秒，省不下钱
//     （这段增量真实调用自己也要写一遍）。
//   · 同一个前缀指纹已经预热过 → 跳过（这才是「同一前缀」的本意）。
//
// ── 边界与安全 ────────────────────────────────────────────────────────
//   · 只读请求体，绝不改写。转换器返回 undefined，核心按「没意见」处理；
//     若返回一个对象，核心会执行 `body = next.body || next` —— 返回 {} 会把整个
//     请求体换掉，这是本插件唯一需要小心的地方。
//   · 自己发出的那次预热用重入标记保护，不会再进本转换器。
//   · 「等真实调用」只对带 context.sessionId 的调用生效（编排器的每轮调用都带），
//     其它一次性调用（判定、分类等）不受影响，仍然按老规矩在第一次就决定。
//   · 自带超时；任何失败只记一行，绝不影响真实调用。
//   · 关掉开关后不发任何请求。
// 原实现用 node crypto 算 sha1；合体版改成插件内自带的 FNV 指纹 —— 少一个受管依赖。
function fnvHex(text) {
  const s = String(text ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${s.length}:${h.toString(16)}`;
}
// 原先是静态 import '{ chatCompletion } from <app>/src/llm.js'。改成**运行时按需加载**：
//   · 部署在 plugins/token-guard/lib/ 下时，'../../../src/llm.js' 正好是 <app>/src/llm.js ✓
//   · 在工作区里跑自测/验证时解析不到 → 降级为"不预热"，插件其余功能照常（不会因为耦合把整个插件拖死）
let chatCompletion = null;
let llmLoadError = '';
async function ensureLlm() {
  if (chatCompletion) return chatCompletion;
  try {
    const mod = await import('../../../src/llm.js');
    chatCompletion = (mod && mod.chatCompletion) || null;
  } catch (error) {
    llmLoadError = String(error?.message ?? error);
    chatCompletion = null;
  }
  return chatCompletion;
}
export function llmStatus() { return { ready: typeof chatCompletion === 'function', error: llmLoadError }; }

/** 插件 API 句柄（由 setup 注入）。刻意不叫 api，避免与请求体的 api 参数混淆。 */
let pluginApi = null;
/** 重入标记：我们自己发出的那次预热期间为 true。 */
let inFlight = false;
/** 上一次预热过的前缀身份（请求体哈希）。 */
let lastKey = '';
/** 上一次预热的时间戳。 */
let lastAt = 0;
/** 上一次见过的消息序列（逐条 JSON）与工具，用于判断「同一会话续写」。 */
let lastMsgParts = [];
let lastToolsJson = '';
/** 已记下、等真实调用再决定的前缀（编排器第 1 次构造时写入）。 */
let pendingKey = '';
/** 最近观察到的一次内置预热/保活所写的指纹 —— 有人代劳了就别重复。 */
let observedWarmKey = '';
let observedWarmAt = 0;
/** 每分钟滑窗（预热时间戳）。 */
let minuteWindow = [];

const stats = {
  warmed: 0,
  deferred: 0,
  alreadyWarmed: 0,
  sameKey: 0,
  continuation: 0,
  builtinWarm: 0,
  gapBlocked: 0,
  capped: 0,
  tooSmall: 0,
  noTools: 0,
  failed: 0,
  lastWarmAt: 0,
  lastSkip: '',
  lastError: ''
};

export function setup(api) {
  pluginApi = api;
}

export function available() {
  const s = cfg();
  if (s.enabled === false) return { ok: false, reason: '设置里已关闭' };
  return true;
}

export function deactivate() {
  minuteWindow = [];
  lastKey = '';
  lastAt = 0;
  lastMsgParts = [];
  lastToolsJson = '';
  pendingKey = '';
  observedWarmKey = '';
  observedWarmAt = 0;
}

function cfg() {
  try {
    return (pluginApi && typeof pluginApi.config === 'function' ? pluginApi.config() : null) || {};
  } catch {
    return {};
  }
}

function shortHash(text) {
  return fnvHex(text).slice(0, 12);
}

function note(reason) {
  stats.lastSkip = reason;
}

function remember(error) {
  stats.failed += 1;
  stats.lastError = String((error && error.message) || error).slice(0, 200);
}

/**
 * 补发一次调用前预热。
 * @param {{body: object, api: object, context: object}} p 最终请求体、目标端点、调用方上下文
 */
async function prewarm({ body, api, context }) {
  if (typeof (await ensureLlm()) !== 'function') return;   // 拿不到核心的发送函数就不预热（降级，不报错）
  const s = cfg();
  if (s.enabled === false) return;

  // ① 重入：这次调用就是我们自己发出去的预热
  if (inFlight) return;

  // ② 内置预热 / 保活：max_tokens 恒为 1，全项目只有内置预热用这个值。
  //    记下它写的指纹，后面真实调用时就知道"有人代劳了"。
  if (Number(body && body.max_tokens) === 1) {
    stats.builtinWarm += 1;
    try {
      const m = Array.isArray(body.messages) ? JSON.stringify(body.messages) : '';
      const t = Array.isArray(body.tools) ? JSON.stringify(body.tools) : '';
      observedWarmKey = shortHash(`${m}\u0000${t}`);
      observedWarmAt = Date.now();
    } catch { /* 记不上就算了，最多多发一次预热 */ }
    return;
  }

  // ③ 只处理带工具的会话级调用
  const msgs = Array.isArray(body && body.messages) ? body.messages : null;
  const tools = Array.isArray(body && body.tools) ? body.tools : null;
  if (!msgs || !tools || tools.length === 0) {
    stats.noTools += 1;
    return;
  }

  // ④ 体积门槛：判定 / 分类 / 小请求不值得预热
  const msgJson = JSON.stringify(msgs);
  const toolJson = JSON.stringify(tools);
  const chars = msgJson.length + toolJson.length;
  const minChars = Math.max(0, Number(s.minChars ?? 20000) || 0);
  if (chars < minChars) {
    stats.tooSmall += 1;
    note(`体积不足（${chars} < ${minChars}）`);
    return;
  }

  if (!api || !api.baseUrl || !api.model) return;

  const now = Date.now();
  const key = shortHash(`${msgJson}\u0000${toolJson}`);
  const parts = msgs.map((m) => JSON.stringify(m));

  // ⑤ 同一会话续写：上次见过的消息序列就是本次的前缀，且工具没变。
  //    这一轮的增量真实调用自己也要写一遍，提前预热既省不下钱还要多等一趟，
  //    而本体前缀早就在缓存里了。所以这里只往后跟，不发请求。
  const isContinuation = s.skipContinuation !== false
    && lastMsgParts.length >= 2
    && lastToolsJson === toolJson
    && lastMsgParts.length <= parts.length
    && lastMsgParts.every((p, i) => p === parts[i]);
  if (isContinuation) {
    stats.continuation += 1;
    note(`同一会话续写：前 ${lastMsgParts.length} 条已缓存，新增 ${parts.length - lastMsgParts.length} 条留给真实调用写`);
    lastMsgParts = parts;
    lastToolsJson = toolJson;
    lastKey = key;
    pendingKey = '';
    return;
  }

  // ⑥ 编排器的每轮会拿同一份 body 调两次（先只构造、再真发）。
  //    第一次按兵不动，等第二次（真实调用）再决定 —— 那时才知道内置预热有没有代劳。
  const sequenced = s.warmAtRealCall !== false && !!context && !!context.sessionId;
  if (sequenced) {
    if (key !== pendingKey) {
      pendingKey = key;
      stats.deferred += 1;
      note('等真实调用再决定（先看看内置预热会不会代劳）');
      return;
    }
    pendingKey = '';
    // 内置预热/保活刚写过同一个指纹 → 真实调用直接读缓存，不必再写一遍
    if (observedWarmKey === key && now - observedWarmAt < 120000) {
      stats.alreadyWarmed += 1;
      note(`内置预热已代劳（${key}），不再重复补发`);
      lastKey = key;
      return;
    }
  }

  // ⑦ 判重：请求体哈希才是「同一前缀」的正确身份
  if (key === lastKey) {
    stats.sameKey += 1;
    note(`同前缀已预热过（${key}）`);
    return;
  }

  // ⑧ 全局最小间隔：只防瞬时并发堆积（同前缀在 ⑦ 已经被跳过）
  const minGap = Math.max(0, Number(s.minGapMs ?? 1500) || 0);
  if (now - lastAt < minGap) {
    stats.gapBlocked += 1;
    note(`全局最小间隔（${now - lastAt}ms < ${minGap}ms）`);
    return;
  }

  // ⑨ 每分钟上限：安全阀
  const perMinute = Math.max(1, Number(s.maxPerMinute ?? 40) || 40);
  minuteWindow = minuteWindow.filter((t) => now - t < 60000);
  if (minuteWindow.length >= perMinute) {
    stats.capped += 1;
    note(`本分钟已达上限（${minuteWindow.length}/${perMinute}）`);
    return;
  }

  const timeoutMs = Math.max(1000, Number(s.warmTimeoutMs ?? 12000) || 12000);
  lastKey = key;
  lastAt = now;
  lastMsgParts = parts;
  lastToolsJson = toolJson;
  minuteWindow.push(now);
  inFlight = true;
  try {
    // 与内置预热完全同构：同一份请求体原样发出，只把 max_tokens 压到 1。
    // overrides 传当前端点，避免再走一次端点挑选而落到别处。
    await chatCompletion({
      sameBody: body,
      maxTokens: 1,
      tag: 'prewarm-fix',
      overrides: api,
      signal: AbortSignal.timeout(timeoutMs)
    });
    stats.warmed += 1;
    stats.lastWarmAt = Date.now();
  } catch (error) {
    remember(error);
    if (stats.failed === 1 || stats.failed % 20 === 0) {
      try { pluginApi?.warn?.(`补发预热失败（第 ${stats.failed} 次，已忽略）：${stats.lastError}`); } catch { /* ignore */ }
    }
  } finally {
    inFlight = false;
  }
}

export const providers = {
  'llm.request-params': async ({ body, api, context }) => {
    try {
      await prewarm({ body, api, context });
    } catch (error) {
      remember(error);
    }
    // 刻意返回 undefined：核心的写法是 `if (!next || typeof next !== 'object') continue;`
    // 与 `body = next.body || next` —— 返回任何对象都会试图替换请求体。
    return undefined;
  },

  'status.prewarm-fix': () => {
    const s = cfg();
    const now = Date.now();
    const inMinute = minuteWindow.filter((t) => now - t < 60000).length;
    const skipped = stats.sameKey + stats.continuation + stats.builtinWarm
      + stats.gapBlocked + stats.capped + stats.tooSmall + stats.noTools;
    return {
      icon: '🔥',
      title: '预热闸门修复',
      priority: 41,
      lines: [
        ['状态', s.enabled === false ? '已关闭' : '运行中'],
        ['已补发预热', String(stats.warmed)],
        ['内置已代劳', String(stats.alreadyWarmed)],
        ['等真实调用再定', String(stats.deferred)],
        ['跳过合计', String(skipped)],
        ['　同会话续写', String(stats.continuation)],
        ['　同前缀判重', String(stats.sameKey)],
        ['　内置预热/保活', String(stats.builtinWarm)],
        ['　全局间隔挡住', String(stats.gapBlocked)],
        ['　体积不足', String(stats.tooSmall)],
        ['　无工具', String(stats.noTools)],
        ['　触顶每分钟上限', String(stats.capped)],
        ['失败', String(stats.failed)],
        ['本分钟预热', `${inMinute} / ${Math.max(1, Number(s.maxPerMinute ?? 40) || 40)}`],
        ['最近预热', stats.lastWarmAt ? new Date(stats.lastWarmAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—'],
        ['最近跳过原因', stats.lastSkip || '—'],
        ['最近错误', stats.lastError || '—']
      ]
    };
  }
};

/** 测试用：重置内部状态。 */
export function _reset() {
  inFlight = false;
  lastKey = '';
  lastAt = 0;
  lastMsgParts = [];
  lastToolsJson = '';
  pendingKey = '';
  observedWarmKey = '';
  observedWarmAt = 0;
  minuteWindow = [];
  for (const k of Object.keys(stats)) {
    if (typeof stats[k] === 'number') stats[k] = 0;
    else stats[k] = '';
  }
}

/**
 * 供合体版复用的保活出口：用核心的 chatCompletion 发一次 keep-alive。
 * 镜像核心 cache-warm：传 sameBody（逐字节复用真实请求体）+ max_tokens=1，
 * 保证写进去的就是真实调用要读的那段前缀。拿不到 chatCompletion 返回 null（降级，不报错）。
 */
export async function sendKeepAlive(body, api) {
  const cc = await ensureLlm();
  if (typeof cc !== 'function' || !body || !Array.isArray(body.messages)) return null;
  return cc({
    messages: body.messages,
    tools: body.tools || null,
    maxTokens: 1,
    sameBody: body,
    overrides: api && api.baseUrl ? { baseUrl: api.baseUrl, apiKey: api.apiKey, model: api.model } : null,
    tag: 'keepalive'
  });
}
