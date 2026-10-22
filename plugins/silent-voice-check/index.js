// silent-voice-check —— 发言自检
//
// 场景：她「既没调用 send_message、也没调用 finish」就结束了一轮。
// 这时另起一次**独立**的模型调用（没有历史、极短提示词），只看这一轮的三件事：
//   ① 本轮触发的消息  ② 她写在正文里的话（按设计不会发出去）  ③ 她的思考
// 判断她是「确实不打算说话」还是「想说话却忘了走工具」。
// 后一种就把一句提醒塞回**原会话**，让她自己把话说出去 —— 插件不替她发言。
//
// ── 为什么不能照抄 reply-audit 的入口 ─────────────────────────────────────
// reply-audit 挂在 `reply.salvage-lines` 上。但核心只有在**正文非空**时才会走
// 回复安全网（src/reply-rescue.js 第 39 行：`if (!body) return [];`），
// 而"真沉默"的那一轮正文往往是空的 —— 于是那个能力点根本不会被问到，
// 表现为"装了但一次都没生效"。这是它不发挥作用的直接原因。
//
// ── 本插件的路子（不需要改宿主）──────────────────────────────────────────
// 核心在取到模型响应、**还没读 tool_calls** 之前会 await `after-response` 钩子
// （orchestrator.js:1016 → 1023）。钩子里只做一件不会超时的事：往
// `response.message.tool_calls` 里塞一个自己注册的内部工具调用 `voice_check`。
// 核心随后会照常执行它（工具执行没有钩子那 5 秒限制），于是：
//   · 判定「想说话」→ 工具结果就是那句提醒，模型在同一会话里继续 → 它自己发话
//   · 判定「不想说」→ 工具结果只写一行结论，同时用 `reply.local-policy` 让核心
//     当场收尾，不额外多跑一轮模型（省掉一次没意义的调用）
//
// 两条硬约束：
//   · 钩子里**不发网络请求**（5 秒超时），所有模型调用都在工具里做
//   · 一次运行最多自检一次（注入过就不再注入，避免反复烧 token / 死循环）

let cfg = () => ({});
let log = () => ({});

const TOOL_ID = 'voice_check';
const RUN_TTL_MS = 10 * 60 * 1000;

/**
 * 注册后**真实**的工具 id。
 *
 * ⚠️ 插件注册的工具会被加载器自动加前缀：`<skillId>__<toolId>`（plugin-loader.js:84），
 *    所以注入 tool_call 时必须用 `silent-voice-check__voice_check` 而不是裸 `voice_check` ——
 *    核心是按 `defs.find(d => d.id === name)` 找工具的。
 *    用 `registerTool` 的**返回值**而不是自己拼，这样插件改名/被重命名都不会失效。
 */
let toolId = TOOL_ID;

/** 每次运行的证据与判定结果。key = session.id（每次运行都是新 id）。 */
const runs = new Map();
/** 最近一次判定，供 reply.local-policy 决定要不要收尾。 */
let lastCheck = { at: 0, verdict: '' };

/** 可替换依赖，仅测试用。 */
let deps = {
  resolveApi: defaultResolveApi,
  fetch: (...args) => globalThis.fetch(...args)
};

export function setup(api = {}) {
  if (typeof api.config === 'function') cfg = api.config;
  if (typeof api.log === 'function') log = api.log;

  const registered = api.registerTool({
    id: TOOL_ID,
    name: '发言自检',
    description: '（内部工具，禁止主动调用）只由「发言自检」插件在「你既没发消息也没结束」时自动插入，用来判断这一轮是漏发了消息还是你确实不想说话。你自己调用它没有任何作用，只会浪费一轮。',
    category: 'system',
    icon: '🔎',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(ctx) {
      return runCheck(ctx);
    }
  });
  // 用加载器返回的真实 id（带 `<插件id>__` 前缀），别用裸 id —— 否则核心找不到这个工具
  if (typeof registered === 'string' && registered.trim()) toolId = registered.trim();
}

export function available() {
  return { ok: true };
}

export function dispose() {
  runs.clear();
  lastCheck = { at: 0, verdict: '' };
}

// ── 钩子：沉默轮次 → 插入内部工具调用 ────────────────────────────────────

export const hooks = {
  'after-response'({ response, session } = {}) {
    try {
      if (!response?.message || !session?.id) return undefined;
      if (session.error) return undefined;                       // 出错的那轮没有可信信号
      const calls = response.message.tool_calls;
      if (Array.isArray(calls) && calls.length) return undefined; // 调了工具（含 finish）就不算沉默

      const c = conf();
      if (!c.enabled) return undefined;

      const state = ensureRun(session.id);
      if (state.injected) return undefined;                      // 一次运行只自检一次

      const body = typeof response.message.content === 'string' ? response.message.content : '';
      const reasoning = String(response.reasoning ?? '');
      if ([body, reasoning].join('').trim().length < c.minSignalChars) return undefined;

      state.body = body;
      state.reasoning = reasoning;
      state.triggerText = String(session.triggerText || '');
      state.sent = Array.isArray(session.sent) ? session.sent.slice(-6) : [];
      state.at = Date.now();
      state.injected = true;

      // 只改内存里的响应对象，不发请求、不碰网络。
      // 正文**保留**（她写的话在存档/UI 里还看得到）；下一轮请求前会由
      // llm.request-params 补上 reasoning_content（见下方 provider 的注释）。
      response.message.tool_calls = [{
        id: `voice_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        type: 'function',
        function: { name: toolId, arguments: '{}' }
      }];

      log('检测到沉默轮次，已插入发言自检');
    } catch (error) {
      // 自检坏了绝不能影响聊天
      try { log(`插入发言自检失败（忽略）：${error?.message ?? error}`); } catch { /* ignore */ }
    }
    return undefined;
  }
};

// ── 能力：判定为「确实不想说话」时让核心当场收尾 ─────────────────────────

export const providers = {
  /**
   * 补齐 reasoning_content —— 对**本插件伪造的那次调用**是必须的。
   *
   * ── 服务端到底怎么校验（实测后修正的结论）──
   * DeepSeek 的思考模式要求：历史里带 tool_calls 的 assistant 消息要能对应上
   * 它当年的思考。它**按 tool_call id 认自己发过的消息**：
   *   · 用真实运行里服务端下发的 call id（如 call_00_ET_vqOuyr…）→ 不带 reasoning_content 也 200
   *   · 用编造的 call id                                        → 400
   *     "The `reasoning_content` in the thinking mode must be passed back to the API."
   *   · 带 reasoning_content（任意字符串即可）                   → 200
   *
   * 所以正常的多轮工具链（全部用真实 id）**不会 400** —— 我早前"关掉 early-finish
   * 就会炸"的判断是错的，那是被假 id 的探针误导的。
   *
   * 但本插件注入的 `voice_check` 调用 id 是**我们自己编的**（`voice_xxx`），
   * 服务端不认得，就必须显式把 reasoning_content 补上，否则下一轮必然 400。
   * 补的内容优先用这一轮真实的思考（after-response 里抓到的），拿不到就填占位文本。
   *
   * 只处理**自己这个工具**的消息，不碰其它工具的历史，避免影响别的功能。
   */
  'llm.request-params'({ body, messages, context } = {}) {
    try {
      const list = body?.messages ?? messages;
      if (!Array.isArray(list)) return undefined;
      const names = new Set([toolId, TOOL_ID]);
      const state = context?.sessionId ? runs.get(context.sessionId) : null;
      const reasoning = String(state?.reasoning || '').trim();
      const fill = reasoning || '（这一轮没有产生显式思考，由发言自检补位）';
      let changed = false;
      for (const m of list) {
        if (m?.role !== 'assistant' || !Array.isArray(m.tool_calls) || !m.tool_calls.length) continue;
        if (typeof m.reasoning_content === 'string' && m.reasoning_content.trim()) continue;
        const ours = m.tool_calls.some((call) => names.has(call?.function?.name));
        if (!ours) continue;
        m.reasoning_content = fill;
        changed = true;
      }
      return changed ? { body: { ...body, messages: list } } : undefined;
    } catch { return undefined; }
  },

  'reply.local-policy'({ batch } = {}) {
    try {
      const calls = Array.isArray(batch?.calls) ? batch.calls : [];
      const ours = new Set([toolId, TOOL_ID]);
      const isOurBatch = calls.some((call) => ours.has(call?.function?.name));
      if (!isOurBatch) return {};
      // 这一批里已经发出消息 → 正常继续，别抢着结束
      if (Array.isArray(batch?.newSent) && batch.newSent.length) return {};
      if (lastCheck.verdict === 'quiet' && Date.now() - lastCheck.at < 60000) return { shouldEnd: true };
      return {};
    } catch { return {}; }
  }
};

// ── 工具：真正做判定 ────────────────────────────────────────────────────

async function runCheck(ctx) {
  const state = ctx?.session?.id ? runs.get(ctx.session.id) : null;
  if (!state?.injected) {
    // 模型自己主动调进来的情况：说清楚它是内部工具，别让它以为出了故障、也别反复调
    return {
      content: '（这是内部工具：只在「你上一轮既没发消息也没结束」时由系统自动插入，你自己调用没有意义。'
        + '继续做你原本要做的事：要说的话用 send_message，决定不说就调用 finish。）'
    };
  }
  const c = conf();
  let verdict = 'quiet';
  let why = '';

  try {
    const api = await deps.resolveApi(c);
    if (!api?.baseUrl || !api?.model) {
      why = '没有可用的模型配置';
      log('自检跳过：没有可用的模型配置');
    } else {
      const raw = await askJudge(buildJudgeMessages(state), c, api);
      const parsed = parseVerdict(raw);
      verdict = parsed.verdict;
      why = parsed.why;
    }
  } catch (error) {
    why = `自检失败，按不发言处理：${error?.message ?? error}`;
    log(why);
  }

  state.verdict = verdict;
  state.why = why;
  state.at = Date.now();
  lastCheck = { at: Date.now(), verdict };

  if (verdict === 'say') {
    log(`判定为漏发消息${why ? `（${why}）` : ''}，已把提醒放回会话`);
    return { content: reminderText(state, why) };
  }
  return { content: `（发言自检：确认这一轮不需要说话${why ? `；依据：${why}` : ''}）` };
}

/** 判定为漏发时塞回会话的那句话。只给事实和下一步，不替她写内容。 */
function reminderText(state, why) {
  const body = String(state.body || '').trim();
  const shown = body ? body.replace(/\s+/g, ' ').slice(0, 160) : '（正文是空的，只有思考）';
  return [
    '【发言自检】你上一轮既没有调用 send_message、也没有调用 finish 就结束了，但独立判定认为你是想说话的。',
    why ? `判断依据：${why}` : '',
    `你当时写的内容：${shown}`,
    '现在请把要说的话用 send_message 发出去。如果你确实仍然不想说，就调用 finish 结束本轮。不要重复已经发过的内容。'
  ].filter(Boolean).join('\n');
}

/** 判定请求的提示词：极短、只要一个 JSON。 */
function buildJudgeMessages(state) {
  const trigger = String(state.triggerText || '').trim().slice(0, 1200) || '（没有拿到触发消息）';
  const body = String(state.body || '').trim().slice(0, 600) || '（空）';
  const reasoning = String(state.reasoning || '').trim().slice(0, 1500) || '（没有思考）';
  const sent = (state.sent || []).map((s) => `${s?.type === 'text' ? s?.text : `[${s?.type || '消息'}]`}`).join('；') || '（什么都没发）';

  return [
    {
      role: 'system',
      content: '你是一个判断器。只输出一行 JSON：{"verdict":"say","why":"一句话原因"} 或 {"verdict":"quiet","why":"一句话原因"}。不要输出别的文字，不要讲道理。'
    },
    {
      role: 'user',
      content: [
        `【本轮收到的消息】\n${trigger}`,
        `【她写在正文里、但没发出去的内容】\n${body}`,
        `【她的思考】\n${reasoning}`,
        `【她这一轮实际发出的消息】\n${sent}`,
        '',
        '问题：她这一轮「既没调用 send_message、也没调用 finish」就结束了。',
        '她本来是**想说话但忘了走工具**（verdict=say），还是**确实不打算说话**（verdict=quiet）？',
        '判据：',
        '- 正文或思考里已经写好了要回给对方的话（第一人称、在回应上面的消息）→ say',
        '- 权衡之后决定不插话、觉得话题与她无关、只是在做内部推理，或者已发过消息 → quiet',
        '- 拿不准 → quiet'
      ].join('\n')
    }
  ];
}

/** 解析判定结果：优先吃 JSON，退一步认关键词。任何异常都归到 quiet（保守）。 */
function parseVerdict(raw) {
  const text = String(raw || '').trim();
  if (!text) return { verdict: 'quiet', why: '' };
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const json = JSON.parse(text.slice(start, end + 1));
      const verdict = String(json?.verdict ?? '').toLowerCase();
      const why = String(json?.why ?? '').slice(0, 160);
      if (verdict === 'say' || verdict === 'quiet') return { verdict, why };
    } catch { /* 落到关键词判断 */ }
  }
  const hit = text.match(/"?verdict"?\s*[:=]\s*"?(say|quiet)/i);
  if (hit) return { verdict: hit[1].toLowerCase(), why: '' };
  return { verdict: 'quiet', why: '' };
}

/** 发一次独立的判定请求。失败一律返回空串（= quiet）。 */
async function askJudge(messages, c, api) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), c.timeoutMs);
  try {
    const res = await deps.fetch(`${String(api.baseUrl).replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(api.apiKey ? { authorization: `Bearer ${api.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: api.model,
        messages,
        thinking: { type: 'disabled' },   // 判分类请求：别把预算花在思考上
        temperature: 0,
        max_tokens: c.maxTokens,
        stream: false
      }),
      signal: controller.signal
    });
    if (!res.ok) {
      log(`自检请求被拒：HTTP ${res.status}`);
      return '';
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content : '';
  } catch (error) {
    log(`自检请求失败：${error?.name === 'AbortError' ? `超时（${c.timeoutMs}ms）` : (error?.message ?? error)}`);
    return '';
  } finally {
    clearTimeout(timer);
  }
}

// ── 配置与状态 ──────────────────────────────────────────────────────────

function conf() {
  const c = cfg() || {};
  return {
    enabled: c.enabled !== false,
    model: String(c.model ?? '').trim(),
    timeoutMs: clamp(Number(c.timeoutMs) || 8000, 3000, 30000),
    maxTokens: clamp(Number(c.maxTokens) || 160, 32, 600),
    minSignalChars: clamp(Number.isFinite(Number(c.minSignalChars)) ? Number(c.minSignalChars) : 20, 0, 1000)
  };
}

function clamp(n, lo, hi) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

function ensureRun(id, now = Date.now()) {
  for (const [key, value] of runs) {
    if (now - (value?.at || 0) > RUN_TTL_MS) runs.delete(key);
  }
  let state = runs.get(id);
  if (!state) {
    state = { injected: false, verdict: '', why: '', body: '', reasoning: '', triggerText: '', sent: [], at: now };
    runs.set(id, state);
  }
  return state;
}

/**
 * 解析判定用的模型端点。
 * ⚠️ 用核心的 getConfig()，不是 api.config() —— 后者只有本插件自己的设置，
 *    拿不到 baseUrl/model（reply-audit 在注释里记过这个坑）。
 * ⚠️ Key 用 resolveApiKey()：用户选「提供商目录」时 api.apiKey 是空的。
 */
async function defaultResolveApi(c) {
  const { getConfig } = await import('../../src/config.js');
  const { resolveApiKey } = await import('../../src/llm.js');
  const config = getConfig() || {};
  const api = config.api || {};
  return {
    baseUrl: String(api.baseUrl ?? '').trim(),
    apiKey: String(resolveApiKey(config) || '').trim(),
    model: c.model || String(api.model ?? '').trim()
  };
}

// 给隔离测试用（加载器不读这个导出）
export const __internals = {
  buildJudgeMessages, parseVerdict, conf, runs, ensureRun,
  setDeps(next) { deps = { ...deps, ...next }; },
  resetDeps() { deps = { resolveApi: defaultResolveApi, fetch: (...a) => globalThis.fetch(...a) }; },
  reminderText,
  getLastCheck: () => lastCheck
};
