// 思考模式适配 Skill 入口。
//
// 通过 4 个能力接入核心，**不碰网络、不自己做重试**：
//   llm.request-params   往请求体加本渠道的思考参数
//   llm.response         从响应里提取思考内容
//   llm.usage            统计思考 token
//   llm.retry-advisor    网关拒绝思考参数时，建议"摘掉这些字段重发一次"
//
// 为什么重试要交给 llm.js 执行：如果 Skill 自己再发一次请求，就会绕开
// 超时预算、abort 信号、重试次数上限、日志和计费统计 —— 变成"悄悄多打一次 API"。
// 所以这里只返回"请摘掉这些字段"的建议，动作由核心执行。

import {
  detectDialect, buildThinkingParams, stripThinkingParams, looksLikeThinkingRejection,
  extractReasoning, extractReasoningTokens, THINKING_BODY_KEYS, DIALECT_LABELS
} from './dialects.js';

let cfg = () => ({});
let log = () => {};

export function setup(api) {
  cfg = api.config;
  log = api.log;
}

/** 合法的思考模式取值。写错了以前会**静默不生效**，很难排查。 */
const VALID_MODES = new Set(['off', 'auto', 'on']);

/** 当前生效的思考请求（UI / 排障用）。 */
export function resolveThinkingRequest(api = null, modeOverride = undefined) {
  const s = cfg();
  // 设置页「思考强度」：api.thinkingMode/Effort/Budget 是模型 API 区的口径，
  // 与本插件自身设置并存 —— api.* 优先（那是用户在主设置页明确选的），
  // 没设置过（undefined）才回落插件设置（技能页表单）。
  const userMode = String(api?.thinkingMode ?? '').trim().toLowerCase();
  const fallbackMode = String(s.mode || 'auto').trim().toLowerCase();
  // 优先级：调用方按次覆盖 > api.thinkingMode（设置页） > 插件设置 > auto
  const rawMode = String((modeOverride !== undefined ? modeOverride : (VALID_MODES.has(userMode) ? userMode : fallbackMode)) ?? '').trim().toLowerCase();
  const modeValid = VALID_MODES.has(rawMode);
  if (!modeValid) {
    // 不再静默：明确告诉用户配置值无效，并回落到 auto（安全的默认）
    log(`思考模式取值无效（${JSON.stringify(rawMode || '(空)')}），已按 auto 处理；可选值：off / auto / on`);
  }
  const mode = modeValid ? rawMode : 'auto';
  const det = detectDialect({ baseUrl: api?.baseUrl || '', model: api?.model || '' });
  const eff = String(api?.thinkingEffort ?? s.effort ?? '').trim().toLowerCase();
  const budget = Number(api?.thinkingBudget) > 0 ? Number(api.thinkingBudget) : (Number(s.budget) || 0);
  const built = buildThinkingParams({
    mode,
    dialect: det.dialect,
    effort: ['low', 'medium', 'high'].includes(eff) ? eff : '',
    budget
  });
  return {
    mode,
    modeRaw: rawMode,
    modeValid,
    warning: modeValid ? '' : `思考模式取值无效（${rawMode || '空'}），已按 auto 处理；可选 off / auto / on`,
    dialect: det.dialect,
    dialectLabel: det.label,
    supports: det.supports,
    applied: built.applied,
    params: built.params,
    omitTemperature: built.omitTemperature,
    reason: det.reason
  };
}

export const providers = {
  // ── 请求参数 ──
  'llm.request-params': ({ body, api, context }) => {
    // context.thinkingMode 允许调用方为**这一次请求**覆盖模式（'off' 表示别思考）。
    // 典型场景：回复安全网的裁判、其它分类/判定类调用 —— 它们不需要思考，
    // 开着思考只会多烧一轮 reasoning token 还更慢。
    // 这是"按次覆盖"，不改用户配置，下一次正常对话仍然按配置走。
    // api.thinkingMode（设置页-模型 API「思考强度」）同样按次传入，优先于插件自身设置。
    const req = resolveThinkingRequest(api, context?.thinkingMode ?? api?.thinkingMode);
    if (!req.applied) {
      // 不应用时也要告诉调用方"如需降级请摘掉这些键"，但不动 body
      return { body, thinking: { applied: false, mode: req.mode, dialect: req.dialect } };
    }
    const next = { ...body, ...req.params };
    return {
      body: next,
      omitTemperature: req.omitTemperature,
      thinking: { applied: true, mode: req.mode, dialect: req.dialect, keys: THINKING_BODY_KEYS }
    };
  },

  // ── 响应加工 ──
  'llm.response': ({ result }) => {
    const reasoning = extractReasoning(result.message);
    if (!reasoning) return {};
    return { result: { reasoning } };
  },

  // ── usage 附加统计 ──
  'llm.usage': ({ usage }) => {
    const n = extractReasoningTokens(usage);
    return n ? { reasoningTokens: n } : {};
  },

  // ── 降级建议 ──
  // 只在错误文本确实在抱怨思考字段时才建议重试，避免把普通 400（例如
  // 模型名写错、Key 无效）也重试一遍，白白多花一次调用。
  'llm.retry-advisor': ({ body, errorText }) => {
    if (!looksLikeThinkingRejection(errorText)) return null;
    const keys = THINKING_BODY_KEYS.filter((k) => k in body);
    if (!keys.length) return null;
    log(`网关拒绝思考参数（命中字段：${keys.join(', ')}），摘掉后重试一次`);
    return {
      body: stripThinkingParams(body),
      reason: `网关不支持思考参数（${keys.join('/')}），已去掉后重试`
    };
  },

  // ── 方言识别（给 UI / 其它模块用） ──
  'model.thinking-detect': ({ baseUrl, model }) => detectDialect({ baseUrl, model })
};

export function promptSections() {
  const req = resolveThinkingRequest();
  if (req.mode === 'off') return [];
  return [{
    // ⚠️ id 必须与 plugin.json 里那条**完全相同**（2026-09-20 修）。
    //    原来是 'thinking-active' 而 manifest 是 'thinking-note'，于是
    //    skillManager.getPromptSections 的按-id-去重认不出它们讲的是同一件事，
    //    系统提示里「▸ 思考输出」出现两遍（一遍基础规则、一遍带当前模式），
    //    每次调用白付约 100 字符。
    //    同 id 后由 manager 的去重逻辑保证**后者（本条，信息更全）胜出**；
    //    而当 mode === 'off'（上面提前 return）时，manifest 里那条仍然生效，
    //    所以"关闭思考时仍有一句基本说明"的行为保持不变。
    id: 'thinking-note',
    title: '思考输出',
    priority: 30,
    content: `当前思考模式：${req.mode}（${req.dialectLabel}）。思考内容不会发送给群友，只有调用发送工具才会真正发言。`
  }];
}

export function available() {
  return { ok: true };
}

export const internals = {
  DIALECT_LABELS, THINKING_BODY_KEYS, detectDialect, buildThinkingParams,
  stripThinkingParams, looksLikeThinkingRejection, extractReasoning,
  extractReasoningTokens, extractThinkingTokens: extractReasoningTokens
};
