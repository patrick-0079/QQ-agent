// LLM 请求/响应消息的纯函数工具。
//
// 背景（2026-10-21）：DeepSeek 思考模式在工具续轮时要求把上一轮 assistant 的
// `reasoning_content` 原样回传，否则网关直接 400：
//   The `reasoning_content` in the thinking mode must be passed back to the API.
// 核心此前只保留了 content / tool_calls，reasoning 只用于 UI，没有进消息序列。
//
// 另一个隐藏问题：会话里的 assistant 条目还带着 `raw`（完整响应体，用于统计），
// 之前会被原样 JSON 发送给模型端点 —— 既浪费 token，也可能被严格网关判为未知字段。
// 所以请求体统一走本模块裁剪。

/**
 * 从一次模型响应构造 assistant 消息条目。
 * @param {object} msg     响应里的 choice.message
 * @param {object} [opts]
 * @param {string} [opts.reasoning] 已提取的思考内容（response.reasoning）
 * @param {object|null} [opts.raw]  原始响应（仅保存在会话里，请求时会被裁掉）
 */
export function assistantEntryFromResponse(msg, { reasoning = '', raw = null } = {}) {
  const entry = {
    role: 'assistant',
    content: msg?.content ?? null,
    tool_calls: Array.isArray(msg?.tool_calls) && msg.tool_calls.length ? msg.tool_calls : undefined
  };
  const rs = typeof reasoning === 'string' && reasoning.trim()
    ? reasoning
    : (typeof msg?.reasoning_content === 'string' ? msg.reasoning_content : '');
  if (rs) entry.reasoning_content = rs;
  if (raw) entry.raw = raw;
  return entry;
}

/**
 * 构造真正发给模型端点的消息数组：只保留协议字段，丢弃内部字段（raw 等）。
 *
 * @param {Array} messages
 * @param {{ includeReasoning?: boolean }} [opts]
 *   includeReasoning=true 时把 assistant.reasoning_content 一并回传（DeepSeek 思考续轮）。
 */
export function toApiMessages(messages, { includeReasoning = false } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  return list.map((m) => {
    if (!m || typeof m !== 'object') return m;
    const out = { role: m.role };
    if (m.role === 'assistant' && m.tool_calls && m.content === undefined) out.content = null;
    else if ('content' in m) out.content = m.content;
    if (m.name) out.name = m.name;
    if (m.tool_calls) out.tool_calls = m.tool_calls;
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    if (includeReasoning && m.role === 'assistant'
      && typeof m.reasoning_content === 'string' && m.reasoning_content) {
      out.reasoning_content = m.reasoning_content;
    }
    return out;
  });
}

/** 降级重试时摘掉所有 reasoning_content（思考参数被摘掉后再回传可能反被拒）。 */
export function stripReasoning(messages) {
  return toApiMessages(messages, { includeReasoning: false });
}

/**
 * 本次请求是否应该回传 reasoning_content。
 * 只有 deepseek 方言需要；且用户没有明确关闭思考时。
 */
export function shouldSendReasoning({ dialect = '', effort = '' } = {}) {
  if (dialect !== 'deepseek') return false;
  return String(effort || '').toLowerCase() !== 'off';
}
