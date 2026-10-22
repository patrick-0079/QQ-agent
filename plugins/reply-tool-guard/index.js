import { randomUUID } from 'node:crypto';

const MAX_NUDGES = 2;
const REMINDER = '你上一轮只输出了思考或普通文本，没有完成发言工具调用，所以 QQ 没收到回复。请根据当前聊天立即真正调用 send_message，把仅用于回复对方的文字放进 messages。只发送最终回复；不要包含思考、备注、QQ号记录、[SEND]/[PAUSE]/[STICKER] 标记或表情编号。不要再以普通文本结束。';
let reminderTool = '';
let log = () => {};
let warn = () => {};

export function setup(api) {
  log = (...args) => api.log(...args);
  warn = (...args) => api.warn(...args);
  reminderTool = api.registerTool({
    id: 'continue_reply',
    name: '发言督促（程序内部）',
    description: '由程序用于恢复尚未发言的对话，不发送任何消息。模型应直接使用 send_message。',
    category: 'system',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute() { return { content: REMINDER }; }
  });
}

function lastReminder(messages) {
  const last = messages?.[messages.length - 1];
  return last?.role === 'tool' && last.name === reminderTool;
}

export const providers = {
  'llm.request-params'({ body, context }) {
    // Only the main chat loop carries sessionId. Do not affect memory judges,
    // model tests, consolidation, or any request where sending is unavailable.
    if (!Array.isArray(body?.tools)) return body;
    // Hide the internal continuation function from the model's choices.
    const tools = body.tools.filter((t) => t?.function?.name !== reminderTool);
    if (!context?.sessionId || context.proactive || !tools.some((t) => t?.function?.name === 'send_message')) return { ...body, tools };
    if (lastReminder(body.messages)) {
      return {
        ...body,
        tools: tools.filter((t) => t?.function?.name === 'send_message'),
        tool_choice: { type: 'function', function: { name: 'send_message' } }
      };
    }
    // Do not replace an explicit choice made by the core/another extension.
    if (body.tool_choice !== undefined && body.tool_choice !== 'auto') return { ...body, tools };
    // Normal turns retain all real tools, including finish for intentional silence.
    return { ...body, tools, tool_choice: 'required' };
  },
  'llm.retry-advisor'({ body, status, errorText, sessionId }) {
    if (!sessionId || ![400, 422].includes(status) || !body?.tools?.length) return null;
    const ours = body.tool_choice === 'required'
      || body.tool_choice?.function?.name === 'send_message';
    if (!ours || !/tool[_ -]?choice/i.test(String(errorText))) return null;
    // The core owns this retry (abort, timeout, cost, fallback). Never call the
    // model directly from the plugin or a 5-second hook.
    warn('模型接口拒绝 tool_choice，已请求核心降级为 auto；仍保留发言提醒。');
    return {
      body: { ...body, tool_choice: 'auto' },
      reason: '发言工具督促：接口不支持强制工具选择，已降级为提醒模式'
    };
  }
};

export const hooks = {
  'after-response'({ response, session, proactive }) {
    const message = response?.message;
    if (!reminderTool || !message || !session || !Array.isArray(session.sent) || proactive) return;
    if (message.role && message.role !== 'assistant') return;
    if (message.tool_calls?.length || message.function_call || session.sent.length) return;
    if (['content_filter', 'error'].includes(response.finishReason)) return;
    const history = Array.isArray(session.messages) ? session.messages : [];
    // A failed sending action is not permission to generate a replacement send.
    if (history.some((m) => /^(?:send(?:_|$)|finish$)/.test(m?.toolCall?.name || ''))) return;
    if ((session.excludedTools || []).some((t) => t.id === 'send_message' || t.id === reminderTool)) return;
    const nudges = history.filter((m) => m?.toolCall?.name === reminderTool).length;
    if (nudges >= MAX_NUDGES) {
      warn('已督促 %s 轮，模型仍未调用发言工具；本轮结束，不转发正文。', MAX_NUDGES);
      return;
    }
    // This is a no-op continuation tool, NOT a synthetic send_message. It gives
    // the existing orchestrator another normal, metered and cancellable turn.
    // Preserve content for the model/session log; none of it is sent to QQ.
    message.tool_calls = [{
      id: `reply_nudge_${randomUUID()}`,
      type: 'function',
      function: { name: reminderTool, arguments: '{}' }
    }];
    log('模型未调用工具，发起第 %s/%s 轮发言督促。', nudges + 1, MAX_NUDGES);
  }
};
