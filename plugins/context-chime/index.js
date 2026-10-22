/**
 * context-chime —— 上下文插话判定（确定性型插件 / API v1）
 *
 * ── 它解决什么 ────────────────────────────────────────────────────────────
 * 原生 QQ-Agent 只在四种情况下回话：被 @、命中关键词、随机命中（3 档概率）、
 * 4 档全响应。也就是说"没被叫到但这句话其实该接"这种情况，原生**只能靠掷骰子**。
 * 本插件补上这一档：**用一次极短的模型调用判断该不该接**。
 *
 * ── 它怎么接进核心 ────────────────────────────────────────────────────────
 * 提供能力 `reply.interest-judge`。orchestrator 在"原生触发全都没命中"时调用它，
 * 拿回 { respond: true } 就把这条消息当成一次触发（tier 3 / 原因"上下文相关"），
 * 走完全正常的会话流程（历史、记忆、工具、限频全都不绕过）。
 *
 *   核心侧是**可插拔**的：插件没装 / 被关掉 / 抛错 → 能力取不到 → 直接回到原生
 *   行为，不会出现"半边生效"。
 *
 * ── 成本控制（本插件存在的意义就是别乱烧钱）──────────────────────────────
 *   · 同群冷却（默认 12 秒）：不让每条消息都打一次模型
 *   · 短消息不判（默认 < 4 字）、纯图片/表情不判、拍一拍不判
 *   · 单群每日判定上限（默认 400 次）——超了自动退回原生档位
 *   · 判定请求 max_tokens 极小（默认 32）、temperature 0、**显式关闭思考**
 *     （想的模型会把预算全烧在 reasoning 上，还常常把 JSON 截断）
 *   · 判定模型可与聊天模型分开（judgeModel / judgeProvider）
 *   · 全部记录进内存日志，可用 chimelog 工具查"刚才为什么没接话"
 *
 * ── 硬约束（遵守 skill-reference 的口径）──────────────────────────────────
 *   · 能力提供者里**不发消息**、不碰发送队列，只做"判 + 返回"
 *   · 任何异常一律吞掉并返回"不接"（保守侧：宁可少接，不可乱接）
 *   · available() 同步返回
 *   · 配置每次执行时现读（cfg()），不在 setup 时快照
 */

import { chatCompletion } from '../../src/llm.js';
import { getConfig } from '../../src/config.js';

// ───────────────────────────── 运行态（内存态，重启即清） ─────────────────────────────

const state = {
  lastJudgeAt: new Map(),   // chatKey -> ts（冷却）
  lastText: new Map(),      // chatKey -> text（同一句话不重复判）
  daily: new Map(),         // `${日期}|${chatKey}` -> 次数
  history: [],              // 最近 50 条判定记录（供 chimelog 工具查看）
  totals: { calls: 0, promptTokens: 0, completionTokens: 0, skipped: 0 }
};

let cfg = () => ({});
let log = () => {};
let warn = () => {};

// 只打一次的"链路已接通"日志：用来确认**核心补丁真的在调用本插件**。
// 判定被规则跳过时是静默的，没有这一行就分不清"没触发"和"补丁没生效"。
let firstCallLogged = false;
let callCount = 0;

const HISTORY_MAX = 50;
const DEFAULTS = {
  enabled: true,
  cooldownSec: 12,
  minChars: 4,
  windowSize: 14,
  judgeProbability: 100,
  dailyCallLimit: 400,
  confidenceThreshold: 0,
  allowPrivate: false,
  onlyGroups: '',
  denyGroups: '',
  judgeModel: '',
  judgeProvider: '',
  maxTokens: 64,
  timeoutMs: 6000,
  promptExtra: ''
};

// ───────────────────────────── 小工具 ─────────────────────────────

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function str(v, dflt = '') {
  const s = String(v ?? '').trim();
  return s || dflt;
}

/** 逗号/空格/中文逗号分隔的 id 列表匹配。 */
function listHas(listText, id) {
  const raw = str(listText);
  if (!raw) return false;
  const target = String(id ?? '').trim();
  if (!target) return false;
  return raw.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean).includes(target);
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function clip(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function settings() {
  const s = (typeof cfg === 'function' ? cfg() : null) || {};
  const pick = (k) => (s[k] === undefined || s[k] === null || s[k] === '' ? DEFAULTS[k] : s[k]);
  return {
    enabled: s.enabled === undefined ? DEFAULTS.enabled : s.enabled !== false,
    cooldownSec: num(pick('cooldownSec'), DEFAULTS.cooldownSec),
    minChars: num(pick('minChars'), DEFAULTS.minChars),
    windowSize: num(pick('windowSize'), DEFAULTS.windowSize),
    judgeProbability: num(pick('judgeProbability'), DEFAULTS.judgeProbability),
    dailyCallLimit: num(pick('dailyCallLimit'), DEFAULTS.dailyCallLimit),
    confidenceThreshold: num(pick('confidenceThreshold'), DEFAULTS.confidenceThreshold),
    allowPrivate: s.allowPrivate === true,
    onlyGroups: str(s.onlyGroups),
    denyGroups: str(s.denyGroups),
    judgeModel: str(s.judgeModel),
    judgeProvider: str(s.judgeProvider),
    maxTokens: num(pick('maxTokens'), DEFAULTS.maxTokens),
    timeoutMs: num(pick('timeoutMs'), DEFAULTS.timeoutMs),
    promptExtra: str(s.promptExtra)
  };
}

function remember(record) {
  try {
    state.history.push({ ts: Date.now(), ...record });
    if (state.history.length > HISTORY_MAX) state.history.splice(0, state.history.length - HISTORY_MAX);
  } catch { /* 记录失败不影响主流程 */ }
}

// ───────────────────────────── 判定提示词 ─────────────────────────────

function buildJudgeMessages({ botName, selfNickname, personaBrief, recentLines, lastLine, promptExtra }) {
  const system = [
    `你在替一个 QQ 群里的机器人「${botName}」做一件小事：判断群里刚来的那条消息，它**该不该主动接话**。`,
    '这个机器人平时只被 @ 或被叫到才回话。现在给它加了「看气氛主动接一句」的能力，所以你要像一个人那样判断：这句话里有没有它的戏份。',
    '',
    '【怎么读下面的记录（很重要，别读错人）】',
    '以「我：」开头的行是**机器人自己说过的话**；其它行都是群友。',
    `机器人叫「${botName}」，但群里可能还有别的机器人、或者昵称跟它很像的人（例如「小鲸鲸」「大肥鱼」）——那些**都算群友**，不是它自己说的。「它刚说过话」只认「我：」开头的行。`,
    '',
    '【该接（reply=1）】',
    '1. 消息是在跟机器人说话、问它、提到它的名字/身份/梗，或者明显在等它表态；',
    '2. 抛出了一个机器人接得上的话题：提问、求解、争论、玩梗、报新闻、发图求评价、报进度；',
    '3. 群里正热闹地接龙/问答，它接一句会让气氛更好；',
    '4. 有人分享情绪或经历（开心、抱怨、emo、告别、问候），朋友该应一声。',
    '',
    '【不该接（reply=0）】',
    '1. 明显是两个人之间的私事：约时间、私聊内容、互相安排、发文件发链接打卡；',
    '2. 低信息量应答：「嗯」「好」「哈哈」「?」这类，接了就成刷屏；',
    '3. 话题与机器人完全无关，或者消息是在 @ 别人（不是它）；',
    '4. 机器人**刚刚才说过话**，这时候再插一句会显得黏人（上下文里能看到它自己的发言）。',
    '',
    '宁可少接，不要乱接：判错一次"该接却没接"只是少说一句话，判错一次"不该接却接了"就是群里刷屏。拿不准时倾向 reply=0。',
    promptExtra ? `\n【主人追加的判据】\n${promptExtra}` : '',
    '',
    '只输出一个 JSON 对象，不要任何其它文字、不要 Markdown、不要解释：',
    '{"reply":0或1,"confidence":0到100的整数,"why":"不超过15个字的中文理由"}'
  ].filter(Boolean).join('\n');

  const user = [
    `【机器人】${botName}${selfNickname && selfNickname !== botName ? `（群里也被叫「${selfNickname}」）` : ''}`,
    personaBrief ? `【它的人设摘要】${personaBrief}` : '',
    recentLines ? `【最近的群聊（越靠下越新，"我："开头的是机器人自己说的）】\n${recentLines}` : '',
    `【最新一条，要判定的是这条】${lastLine}`,
    '按上面的规则判断：机器人该不该接这句？只回 JSON。'
  ].filter(Boolean).join('\n\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}

/** 宽容解析：模型偶尔会包一层 ```json 或者在 JSON 前后多说两句。 */
export function parseJudge(raw) {
  const s = String(raw ?? '');
  if (!s.trim()) return null;
  const m = s.match(/\{[\s\S]*?\}/);
  if (!m) return null;
  let obj = null;
  try { obj = JSON.parse(m[0]); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const rawReply = obj.reply ?? obj.respond ?? obj.answer ?? obj.should_reply;
  let reply = null;
  if (typeof rawReply === 'boolean') reply = rawReply;
  else if (typeof rawReply === 'number') reply = rawReply >= 1;
  else if (typeof rawReply === 'string') reply = /^(1|true|yes|y|接|是)$/i.test(rawReply.trim());
  if (reply === null) return null;
  return {
    respond: reply,
    confidence: Math.max(0, Math.min(100, Math.round(num(obj.confidence, 0)))),
    why: clip(obj.why ?? obj.reason ?? '', 40)
  };
}

/** 判定用模型参数：默认沿用聊天主模型；配了 judgeModel 就换（可选换渠道）。 */
export function resolveJudgeApi(s, baseApi) {
  const base = baseApi && (baseApi.baseUrl || baseApi.apiKey || baseApi.model) ? { ...baseApi } : null;
  if (!s.judgeModel) return base;
  if (!s.judgeProvider) return { ...(base || {}), model: s.judgeModel };
  let picked = null;
  try {
    const c = getConfig();
    const p = (c.providers || []).find((x) => String(x?.id) === s.judgeProvider);
    const key = c.dshProviderKeys?.[s.judgeProvider] || p?.apiKey || base?.apiKey || '';
    picked = { baseUrl: p?.baseURL || base?.baseUrl, apiKey: key, provider: s.judgeProvider, model: s.judgeModel };
  } catch (error) {
    warn(`读取渠道配置失败，回退主渠道：${error?.message ?? error}`);
  }
  return picked || { ...(base || {}), model: s.judgeModel };
}

// ───────────────────────────── 判定主体 ─────────────────────────────

/**
 * 判定一条消息值不值得机器人接话。
 * @param {object} args 由核心注入：{ chatKey, kind, chatId, text, entry, entries, recent, selfId, botName, selfNickname, personaBrief, api }
 * @returns {Promise<{respond:boolean,confidence?:number,why?:string,skipped?:string}>}
 */
export async function judgeInterest(args = {}) {
  const s = settings();
  const chatKey = String(args.chatKey || '');
  const kind = String(args.kind || chatKey.split(':')[0] || '');
  const chatId = String(args.chatId || chatKey.split(':')[1] || '');
  const text = String(args.text ?? '').trim();
  const done = (skipped) => { state.totals.skipped += 1; return { respond: false, skipped }; };

  // 首次被调用就打一行（永久保留）：这是"核心补丁是否接通"的唯一直接证据。
  callCount += 1;
  if (!firstCallLogged) {
    firstCallLogged = true;
    log(`✅ 核心补丁已接通：首次收到判定请求（${chatKey}）—— 之后没被 @ 也可能按上下文接话`);
  }

  if (!s.enabled) return done('已关闭');
  if (!chatKey || !text) return done('无内容');
  if (kind === 'private' && !s.allowPrivate) return done('私聊不判');
  if (kind !== 'group' && kind !== 'private') return done('非群聊');
  if (listHas(s.denyGroups, chatId)) return done('在黑名单群');
  if (s.onlyGroups && !listHas(s.onlyGroups, chatId)) return done('不在白名单群');
  if (args.entry?.isPoke || /^\[拍一拍\]/.test(text)) return done('拍一拍');
  if (text.length < s.minChars) return done('消息过短');
  if (text.length <= 12 && /^\[(图片|表情|动图|GIF|视频|语音|文件|合并转发|转发消息)[^\]]*\]$/.test(text)) return done('纯媒体');

  const now = Date.now();
  if (now - (state.lastJudgeAt.get(chatKey) || 0) < s.cooldownSec * 1000) return done('冷却中');
  if (state.lastText.get(chatKey) === text) return done('重复内容');

  const dk = `${todayKey()}|${chatKey}`;
  const used = state.daily.get(dk) || 0;
  if (used >= s.dailyCallLimit) return done('已达当日上限');
  if (s.judgeProbability < 100 && Math.random() * 100 >= s.judgeProbability) return done('未命中采样');

  const api = resolveJudgeApi(s, args.api);
  if (!api || !api.model || !api.baseUrl) return done('没有可用的模型配置');

  // 先占位再请求：冷却/去重在请求期间也生效，连发消息不会同时打出去
  state.lastJudgeAt.set(chatKey, now);
  state.lastText.set(chatKey, text);
  state.daily.set(dk, used + 1);

  const recent = Array.isArray(args.recent) ? args.recent.slice(-Math.max(2, s.windowSize)) : [];
  const recentLines = recent
    .filter((m) => m && String(m.text ?? '').trim())
    .map((m) => `${m.self ? '我' : clip(m.senderName || m.senderId || '群友', 12)}：${clip(m.text, 120)}`)
    .join('\n');
  const messages = buildJudgeMessages({
    botName: str(args.botName, '机器人'),
    selfNickname: str(args.selfNickname),
    personaBrief: clip(args.personaBrief, 220),
    recentLines,
    lastLine: `${clip(args.entry?.senderName || args.entry?.senderId || '群友', 12)}：${clip(text, 200)}`,
    promptExtra: s.promptExtra
  });

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('判定超时')), Math.max(1000, s.timeoutMs));
  timer.unref?.();

  try {
    const result = await chatCompletion({
      messages,
      temperature: 0,
      maxTokens: Math.max(8, Math.round(s.maxTokens)),
      signal: controller.signal,
      overrides: api,
      // thinkingMode: 'off' —— 判定类请求不需要思考，开着只会多烧 reasoning token
      skillContext: { api, model: api.model, messages, thinkingMode: 'off', chatKey, chime: true }
    });
    const content = result?.message?.content ?? '';
    const parsed = parseJudge(content);
    const usage = result?.usage || null;
    state.totals.calls += 1;
    state.totals.promptTokens += num(usage?.prompt_tokens, 0);
    state.totals.completionTokens += num(usage?.completion_tokens, 0);

    if (!parsed) {
      // 最常见的失败不是"模型乱答"，而是**判定模型被强制思考**：reasoning 把
      // max_tokens 吃光，正文为空、finish_reason=length。这种错误必须说人话，
      // 否则用户只会看到"判定输出无法解析"，完全不知道该去换模型。
      const finish = String(result?.finishReason || '');
      const reasoning = num(result?.usage?.completion_tokens_details?.reasoning_tokens, 0);
      const starved = !String(content).trim() && (finish === 'length' || reasoning > 0);
      const why = starved
        ? `判定模型把预算烧在思考上（reasoning ${reasoning} token，finish=${finish || '?'}）——把插件设置里的「判定专用模型」换成一个能关思考的小模型`
        : `输出无法解析：${clip(content, 80) || '(空)'}`;
      warn(`${why}，本次按"不接"处理`);
      remember({ chatKey, text, respond: false, skipped: why, ms: Date.now() - started, model: api.model });
      return { respond: false, skipped: why };
    }

    const passed = parsed.respond && parsed.confidence >= s.confidenceThreshold;
    remember({
      chatKey, text, respond: passed, confidence: parsed.confidence, why: parsed.why,
      ms: Date.now() - started, model: api.model,
      tokens: usage ? `${num(usage.prompt_tokens, 0)}+${num(usage.completion_tokens, 0)}` : '',
      skipped: parsed.respond && !passed ? '自信度不足' : ''
    });
    log(`判定 ${chatKey}：${passed ? '接' : '不接'}（${parsed.confidence}%${parsed.why ? `，${parsed.why}` : ''}，${Date.now() - started}ms）`);
    return { respond: passed, confidence: parsed.confidence, why: parsed.why || '' };
  } catch (error) {
    const message = String(error?.cause?.message ?? error?.message ?? error);
    warn(`判定失败（按"不接"处理）：${message}`);
    remember({ chatKey, text, respond: false, skipped: `判定失败：${clip(message, 60)}`, ms: Date.now() - started, model: api.model });
    return { respond: false, skipped: '判定失败' };
  } finally {
    clearTimeout(timer);
  }
}

// ───────────────────────────── 生命周期 / 扩展点 ─────────────────────────────

export function setup(api) {
  if (typeof api?.config === 'function') cfg = api.config;
  if (typeof api?.log === 'function') log = api.log;
  if (typeof api?.warn === 'function') warn = api.warn;

  // 排查用工具：让用户能直接问机器人"刚才为什么没接话"
  try {
    api.registerTool({
      id: 'chimelog',
      name: '查看插话判定记录',
      description:
        '查看"上下文插话判定"最近的判定记录：每条消息被判要接还是不接、模型给的理由与自信度、耗时与 token。'
        + '当被问「你刚才为什么不接话」「为什么没回我」「插话判定怎么判的」时调用，用返回的真实记录回答，不要编。',
      category: 'system',
      icon: '🫧',
      parameters: {
        type: 'object',
        properties: {
          count: { type: 'number', description: '看最近多少条，默认 15，最多 50。' },
          onlyResponded: { type: 'boolean', description: '只看判定为「要接」的记录。' }
        }
      },
      async execute(ctx, argsRaw) {
        const args = typeof argsRaw === 'string' ? (() => { try { return JSON.parse(argsRaw); } catch { return {}; } })() : (argsRaw || {});
        const n = Math.max(1, Math.min(50, Math.round(num(args.count, 15))));
        let rows = state.history.slice(-n).reverse();
        if (args.onlyResponded) rows = rows.filter((r) => r.respond);
        const chatKey = String(ctx?.chatKey || '');
        const mine = rows.filter((r) => !chatKey || r.chatKey === chatKey);
        const use = mine.length ? mine : rows;
        const head = `插话判定统计：被核心调用 ${callCount} 次，其中真正判定 ${state.totals.calls} 次、因规则跳过 ${state.totals.skipped} 次，`
          + `累计 token 输入 ${state.totals.promptTokens} / 输出 ${state.totals.completionTokens}。`;
        if (!use.length) return { content: `${head}\n最近没有判定记录。` };
        const lines = use.map((r) => {
          const t = new Date(r.ts).toLocaleTimeString('zh-CN', { hour12: false });
          if (r.skipped) return `${t} ⏭️ 跳过（${r.skipped}）｜${clip(r.text, 40)}`;
          return `${t} ${r.respond ? '✅ 接了' : '⛔ 没接'}${r.confidence ? `（${r.confidence}%）` : ''}`
            + `${r.why ? ` 理由：${r.why}` : ''}｜${clip(r.text, 40)}${r.tokens ? `｜token ${r.tokens}` : ''}`;
        });
        return { content: `${head}\n${lines.join('\n')}` };
      }
    });
  } catch (error) {
    warn(`注册 chimelog 工具失败：${error?.message ?? error}`);
  }
  log('上下文插话判定已就绪（能力 reply.interest-judge）');
}

/** 同步返回；没有模型配置时判定会自行退回"不接"。 */
export function available() {
  return true;
}

/** 能力提供者：核心在"原生触发全没命中"时调用。 */
export const providers = {
  'reply.interest-judge': (args = {}) => judgeInterest(args)
};

/** 测试/排障用导出。 */
export const __internals = { state, settings, buildJudgeMessages, parseJudge, resolveJudgeApi };
