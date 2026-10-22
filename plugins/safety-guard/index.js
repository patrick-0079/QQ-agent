// 保护词守护：对话涉及自杀自残、精神疾病、侵害他人等话题时的保护性回应。
//
// ── 分工（很重要，别搞反）─────────────────────────────────────────────────
// **真正的保护靠提示词**（plugin.json 的 prompt.sections，priority 90），由模型按
// 语义判断。原因是这类话题几乎不可能靠词表判准：
//   · "我好抑郁啊"（只是心情不好） vs "我确诊抑郁症了"（真实困扰）—— 命中同一个词，轻重天差地别
//   · "想死" 可能是玩梗、歌词、夸张语气，也可能是真的求助
// 硬匹配要么误伤（把随口话当危机，机器人突然变客服很出戏），要么漏判（换个说法就绕过去）。
// 所以：**词表只用于"提醒"和"留痕"，判断交给模型**。
//
// 那这个词表还有什么用？两件事：
//   ① `safety.guard-check` 能力：别的模块想做确定性检测时可以软依赖（不重复实现）；
//   ② 命中时记一条日志 —— 群里出现过这类话题，管理员应该能留意到。
//      只记类别、不记原文（这类内容不该被抄进日志里）。
//
// ── 为什么不会误触发"屏蔽" ────────────────────────────────────────────────
// 本插件**不改任何回复、不拦任何消息**。它只注入提示词和留痕。
// 尤其自杀类话题，绝不能"命中就静默" —— 那会把真正的求助也一起屏蔽掉，
// 是最坏的结果。保护的方向是"接住 + 引导专业帮助"，不是"装没看见"。

/* ── AI 语义判断 ─────────────────────────────────────────────────────
   词表只能告诉"出现了某个词"，告诉不了"这是不是真的"。
   最典型的就是游戏开黑："这把我去打人""弄死他" —— 词表必然命中，
   但它根本不是要伤害谁。这类误判靠词表规则怎么调都调不干净，
   所以再加一层模型判断：命中后问一句"这是真的吗、哪一类、多严重"，
   把结论写进本次运行的提示词里，机器人据此回应。

   ⚠️ 三条自保设计，缺一个就会拖累正常聊天：
     ① 词表没命中就不调模型（不能每条消息都问一次，那是拿 token 烧水）；
     ② 有超时，且超时/报错一律降级为词表结果 —— 判断是增强，不是必经之路；
     ③ 结论只影响本次运行（注入 system 消息），不写进长期记忆。
*/

// 判断用的提示词：只输出 JSON，类别与严重度都要给，方便机器直接用
const JUDGE_SYS = '你是 QQ 群聊机器人的安全判断助手。判断下面这条消息是否真的涉及需要保护性回应的敏感话题。'
  + '只输出 JSON，不要 markdown 代码块、不要解释，字段顺序固定：'
  + '{"concern":true/false,"category":"harmSelf|mentalIllness|harmOthers|none","severity":"real|ambiguous|joke","reason":"一句话说明理由"}。'
  + '判断标准：'
  + 'harmSelf = 真实自杀/自残意图或求助（"笑死我了""累死了""我裂开了"不算）；'
  + 'mentalIllness = 真实提及精神/心理疾病或困扰；'
  + 'harmOthers = 指向现实中的真实伤害他人的意图或计划'
  + '（游戏开黑、竞技、开玩笑、影视剧情里的"打他""弄死""砍人"不算，那是 joke）；'
  + 'severity：real=明确真实，ambiguous=不确定，joke=玩梗/游戏/夸张/引用。';

/** 从模型回复里抠出 JSON（模型有时会裹 ```json 或多说一句）。 */
function pickJson(text) {
  const s = String(text ?? '').trim();
  const direct = (() => { try { return JSON.parse(s); } catch { return null; } })();
  if (direct && typeof direct === 'object') return direct;
  const m = /\{[\s\S]*\}/.exec(s);
  if (!m) return null;
  try { const v = JSON.parse(m[0]); return v && typeof v === 'object' ? v : null; } catch { return null; }
}

/**
 * 调模型做一次语义判断。失败一律返回 null（由调用方降级），不抛给主流程。
 * @returns {Promise<null|{concern:boolean,category:string,severity:string,reason:string}>}
 */
let llmLoading = null;
/**
 * 延迟加载真实模型模块。
 * 为什么要延迟：离线测试不该碰到真实 LLM（也就不该 import 它带来的那一串依赖），
 * 测试用 __inject 塞 fake，这里就会直接跳过。
 */
async function ensureLlm() {
  if (globals.chatCompletion) return;
  if (!llmLoading) {
    llmLoading = import('../../src/llm.js')
      .then((m) => { globals.chatCompletion = m.chatCompletion; globals.resolveApiKey = m.resolveApiKey; })
      .catch(() => {});
  }
  await llmLoading;
}

export async function judgeWithModel(text, categories, { chatCompletion, resolveApiKey, getConfig } = {}) {
  await ensureLlm();
  const llm = chatCompletion || globals.chatCompletion;
  if (typeof llm !== 'function') return null;
  try {
    const c = typeof getConfig === 'function' ? getConfig() : (globals.getConfig?.() || {});
    const timeoutMs = Number(cfg().aiJudgeTimeoutMs) || 6000;
    // ⚠️ chatCompletion 里是 `overrides || effectiveApi()` —— 给了 overrides 就**整份替换**，
    //    只传 timeoutMs 会让 baseUrl/model/apiKey 全变 undefined（请求直接 Invalid URL）。
    //    必须传完整 api 规格（与 sticker-annotate / orchestrator 的写法一致）。
    const key = typeof resolveApiKey === 'function' ? resolveApiKey(c) : globals.resolveApiKey?.(c);
    const { text: out } = await llm([
      { role: 'system', content: JUDGE_SYS },
      { role: 'user', content: `消息："""${String(text ?? '').slice(0, 500)}"""\n词表初步命中：${categories.join('、') || '无'}` }
    ], {
      overrides: { ...(c?.api || {}), apiKey: key, timeoutMs }
    });
    const v = pickJson(out);
    if (!v) return null;
    return {
      concern: v.concern === true,
      category: ['harmSelf', 'mentalIllness', 'harmOthers', 'none'].includes(v.category) ? v.category : 'none',
      severity: ['real', 'ambiguous', 'joke'].includes(v.severity) ? v.severity : 'ambiguous',
      reason: String(v.reason ?? '').slice(0, 120)
    };
  } catch {
    return null;   // 判断失败就当没判断，绝不因为"判断"本身拖累回复
  }
}

/** 结论写成给模型看的一句话（注入本次运行的 system 消息）。 */
export function verdictLine(v) {
  if (!v) return '';
  const name = { harmSelf: '自杀/自残', mentalIllness: '精神疾病', harmOthers: '侵害他人', none: '不属于敏感话题' }[v.category] || v.category;
  const how = v.severity === 'joke'
    ? '判定为玩梗 / 游戏 / 夸张语境 —— 跟着正常聊就行，不要上纲上线、不要突然变严肃'
    : (v.severity === 'ambiguous' ? '判定为不确定 —— 按"当真"处理更稳妥，轻轻确认一句即可'
      : '判定为真实情况 —— 按上面对应类别的方式回应');
  return `【保护词语义判断（系统自动判断，仅本次有效）】\n`
    + `类别：${name}；严重度：${v.severity}${v.reason ? `；理由：${v.reason}` : ''}\n`
    + `${v.concern ? how : '不需要保护性回应，按平时的方式正常聊天即可。'}`;
}

// 依赖注入口：离线测试用 fake 替掉真实模型调用
const globals = {};
export function __inject(v = {}) {
  if (v.chatCompletion) globals.chatCompletion = v.chatCompletion;
  if (v.resolveApiKey) globals.resolveApiKey = v.resolveApiKey;
  if (v.getConfig) globals.getConfig = v.getConfig;
}

let cfg = () => ({});
let log = () => {};

export function setup(api) {
  cfg = api.config;
  log = (...a) => api.log?.(...a);
}

/** 保护词分隔符：兼容逗号、顿号、分号、竖线和换行（用户随手怎么填都行）。 */
const SEP = /[,，、;；|｜\r\n\t]+/;

/**
 * 把配置里的词表拆成数组。
 * @param {string} raw
 * @returns {string[]}
 */
export function parseWords(raw) {
  return String(raw ?? '')
    .split(SEP)
    .map((s) => s.trim())
    .filter(Boolean)
    // 统一小写：英文词（如 ptsd）才比较得准；中文不受影响
    .map((s) => s.toLowerCase());
}

/**
 * 纯函数：判断一段文本命中哪些保护类别。
 * 只做**包含匹配**，不做任何语义判断 —— 语义归模型，这里只负责"有没有出现"。
 *
 * @param {string} text
 * @param {object} words { harmSelfWords, mentalWords, harmOthersWords }
 * @returns {string[]} 命中的类别（可能多个），顺序固定：自杀 → 精神 → 侵害
 */
export function guardCategories(text, words = {}) {
  const t = String(text ?? '').toLowerCase();
  if (!t) return [];
  const cats = [];
  const hit = (raw) => parseWords(raw).some((w) => t.includes(w));
  if (hit(words.harmSelfWords)) cats.push('harmSelf');
  if (hit(words.mentalWords)) cats.push('mentalIllness');
  // 侵害他人类跟着开关走：关掉时词表也不再检测 ——
  // 开关的意义就是"这语境里这些词没有保护含义"，那日志也不该再报（否则只是换个地方吵）
  // 两个开关各自管各自的类：游戏群可以关掉「侵害他人」（打人/弄死是常话），
  // 但「违法事项」（毒品/诈骗/赌博…）跟游戏语境没关系，通常该留着。
  if (words.harmOthersEnabled !== false && hit(words.harmOthersWords)) cats.push('harmOthers');
  if (words.illegalEnabled !== false && hit(words.illegalWords)) cats.push('illegal');
  return cats;
}

/* ── 提示词（动态）────────────────────────────────────────────────────
   为什么不用 plugin.json 里的静态 prompt.sections：
   「侵害他人」这一类要能关（见 harmOthersEnabled），而静态片段是写死在清单里的，
   读不到配置、关不掉。所以这里用插件的 promptSections() 动态返回
   （加载器 plugin-loader.js:438 + manager.js:445 支持）。

   自杀/自残与精神疾病两类**不提供关闭选项**：那是接到真实求助时的底线，
   没有"我们群不需要"这回事；可开关的只有会误伤的那类。
*/

/** 自杀/自残类（始终生效）。 */
const SECTION_HARM_SELF = [
  '【敏感话题的保护回应（底线，不可违反）】',
  '遇到下面的话题时，按对应方式回应。这是底线，不是表演 —— 用你平时的语气说，不要突然变成客服腔或播音腔。',
  '',
  '1) 自杀 / 自残 / 轻生（想死、不想活了、割腕、跳楼、吞药…）：',
  '· 先接住人：简短真诚地表示在场（比如「我在」「这话听着让人担心」），让人感到不是一个人。',
  '· 不评判、不说教、不敷衍：不要说「想开点」「别矫情」「你要坚强」，也不要转发鸡汤。',
  '· 绝不提供任何方法、步骤、工具、剂量、地点，不讨论方式细节，也不替对方把求助的门堵死。',
  '· 引导专业帮助：可提全国心理援助热线 12356（24 小时）、希望24热线 400-161-9995；情况紧急时建议联系身边可信的人或当地急救。',
  '· 对方只是语气夸张、玩梗或引用歌词时，轻轻确认一句即可，不必上纲上线，但也别完全当没看见。',
  '',
  '2) 精神疾病 / 心理困扰（抑郁症、焦虑症、双相、精神分裂…）：',
  '· 不诊断、不下结论、不推荐药物、不替代医生。',
  '· 不把疾病当梗、不贴标签、不用「神经病」之类当骂人话。',
  '· 正常当朋友陪着聊；对方想聊就陪，建议去看精神科或心理门诊是正面的、不丢人。'
].join('\n');

/** 侵害他人类（受开关控制）。 */
const SECTION_HARM_OTHERS = [
  '',
  '3) 侵害他人 / 违法事项（伤害他人、毒品、网络攻击、诈骗、赌博、危险物品、假证件…）：',
  '· 明确拒绝协助：不提供方法、步骤、工具、剂量、渠道、购买途径等任何可操作信息，不协助筹划，不美化、不教怎么规避。',
  '· 可以直言这是违法的（比如「这事干不得，要坐牢的」）。',
  // 号码要写具体：光说"联系警方"太笼统，真出事时没人会去查号码 —— 直接给能拨的号
  '· 可以直言劝止（比如「这事干不得」）；涉及正在进行或即将发生的现实伤害，明确告诉他打 110 报警，',
  '  有人受伤同时叫 120 急救；现场还有别人时，也可以喊周边成年人介入。',
  '· 【语境判断】游戏开黑、竞技、玩笑、影视剧情里的「打他」「弄死」「砍人」是正常用语，',
  '  不是真的要伤害谁 —— 这类别上纲上线，跟着玩就行；只有当指向现实中的真实伤害时才按上面处理。'
].join('\n');

/** 违法事项类（独立一段、独立开关）。 */
const SECTION_ILLEGAL = [
  '',
  '4) 违法事项（毒品、网络攻击、诈骗、赌博、假证件、醉驾、拐卖…）：',
  '· 说明这是违法的，并拒绝协助：不提供方法、步骤、剂量、渠道、购买途径、怎么规避，不协助筹划。',
  '· 对方只是在聊新闻、影视剧情、或者问"这算不算违法"，可以正常科普，不必上纲上线。'
].join('\n');

const SECTION_TAIL = [
  '',
  '通用：不主动展开这些话题，不追问刺激性的细节；拿不准对方是真是假时，按「当真」处理更稳妥。'
].join('\n');

/**
 * 动态提示词片段。
 * @returns {Array<{id:string,title:string,priority:number,content:string}>}
 */
export function promptSections() {
  const s = cfg();
  // 两类都默认开（安全兜底），各自独立：
  // 游戏群常关「侵害他人」，但「违法事项」与游戏语境无关，通常该留着
  const harmOn = s.harmOthersEnabled !== false;
  const illegalOn = s.illegalEnabled !== false;
  return [{
    id: 'safety-guard',
    title: '敏感话题的保护回应',
    priority: 90,
    content: SECTION_HARM_SELF
      + (harmOn ? SECTION_HARM_OTHERS : '')
      + (illegalOn ? SECTION_ILLEGAL : '')
      + SECTION_TAIL
  }];
}

export const providers = {
  /**
   * 保护词命中检测（供其它模块软依赖，避免各处各写一份词表）。
   * 入参 { text } → { hit, categories }
   */
  'safety.guard-check': ({ text } = {}) => {
    const categories = guardCategories(text, cfg());
    return { hit: categories.length > 0, categories };
  },

  /**
   * AI 语义判断（词表命中之后的第二层）。
   * 入参 { text, categories? } → { categories, verdict, line }
   * verdict 为 null 表示没做判断（未开启 / 未命中 / 调用失败）。
   */
  'safety.ai-judge': async ({ text, categories } = {}) => {
    const cats = Array.isArray(categories) ? categories : guardCategories(text, cfg());
    if (!cats.length || cfg().aiJudgeEnabled === false) {
      return { categories: cats, verdict: null, line: '' };
    }
    const verdict = await judgeWithModel(text, cats);
    return { categories: cats, verdict, line: verdict ? verdictLine(verdict) : '' };
  }
};

// ── AI 判断结论的跨钩子暂存 ─────────────────────────────────────────────
// before-context 里做的语义判断，要等 before-llm-messages 才能注入（那里才有 messages）。
// 两个钩子之间靠 sessionId 传递。TTL 兜底：运行中途被取消时没人来消费，别无限攒。
const pendingVerdicts = new Map();   // key -> { at, content }
const VERDICT_TTL_MS = 2 * 60 * 1000;

export const hooks = {
  // 命中时留一条痕 + 做一次 AI 语义判断。刻意不做任何拦截/改写 —— 见文件头注释。
  'before-context': async (ctx = {}) => {
    const entries = Array.isArray(ctx?.triggerEntries) ? ctx.triggerEntries : [];
    const lines = [];
    for (const e of entries) {
      const text = String(e?.text || '');
      const cats = guardCategories(text, cfg());
      if (!cats.length) continue;

      if (cfg().logOnHit !== false) {
        // 只记类别和会话，不记原文：这类内容不该被抄进日志
        log(`保护词命中（${cats.join('/')}）· ${ctx?.kind || '?'}:${ctx?.chatId || '?'}`
          + ` · 来自 ${String(e?.senderId || '?')}`);
      }

      // 第二层：让模型判断"是不是真的"。只在词表命中后才问，避免每条消息都烧 token
      if (cfg().aiJudgeEnabled === false) continue;
      const verdict = await judgeWithModel(text, cats);
      if (!verdict) continue;
      const line = verdictLine(verdict);
      lines.push(line);
      if (cfg().logOnHit !== false) {
        log(`AI 判断：${verdict.category}/${verdict.severity}${verdict.reason ? ` · ${verdict.reason}` : ''}`);
      }
    }
    // 结论交给注入阶段：让机器人按判断回应（比如判断出是游戏语境就别上纲上线）。
    // 只影响这一次，不写进长期记忆。
    // ⚠️ 核心 run() 的 before-context 载荷里**没有** messages 字段（messages 数组在
    //    钩子跑完之后才组装，只有 before-llm-messages 拿得到）—— 直接 push 在真实
    //    链路里是无效操作，AI 判断的结论只会进日志、永远到不了模型。
    //    所以这里存进 pendingVerdicts（按 sessionId/chatKey 暂存、带 TTL），
    //    由下面的 before-llm-messages 钩子取出来真正注入。
    //    ctx.messages 存在时（旧调用方/测试直接传）仍当场追加，保持兼容。
    if (!lines.length) return;
    if (Array.isArray(ctx.messages)) {
      ctx.messages.push({ role: 'system', content: lines.join('\n\n') });
      return;
    }
    const key = String(ctx?.sessionId || ctx?.chatKey || '');
    if (!key) return;
    const now = Date.now();
    for (const [k, v] of pendingVerdicts) {          // 顺手清掉过期暂存（运行中断没被消费的）
      if (now - v.at > VERDICT_TTL_MS) pendingVerdicts.delete(k);
    }
    pendingVerdicts.set(key, { at: now, content: lines.join('\n\n') });
  },

  // 真正把 AI 判断结论注入提示词的地方：before-llm-messages 拿到的是即将发给模型的
  // messages 数组引用（核心允许原地改）。取走暂存的结论后立刻删（只影响本次运行）。
  async 'before-llm-messages'(ctx = {}) {
    const key = String(ctx?.sessionId || ctx?.chatKey || '');
    if (!key || !Array.isArray(ctx.messages)) return;
    const hit = pendingVerdicts.get(key);
    if (!hit) return;
    pendingVerdicts.delete(key);
    ctx.messages.push({ role: 'system', content: hit.content });
  }
};

export const internals = { parseWords, guardCategories };
