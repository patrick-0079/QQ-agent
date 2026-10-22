// 更详细的会话思考：把每轮模型的原生推理内容写进会话记录，
// 让控制台会话页能看到深度思考过程。
//
// 为什么用 after-response 钩子：触发时机固定（每轮响应后必到），
// 且只加工内存里的会话记录 —— 不发请求、不发消息，符合钩子边界。
//
// 为什么插入 { role: 'assistant', content: '【深度思考】…' }：
// 控制台会话页只认识工具卡片、图片注入提示和 assistant 气泡三类条目，
// 插件没有前端渲染入口。assistant 气泡是唯一能零侵入展示文本的形态，
// 前缀用于和正文草稿区分。这是刻意的取舍，见 docs/adr/0002。

let cfg = () => ({});

export function setup(api) {
  cfg = api.config;
}

const PREFIX = '【深度思考】';

/**
 * 取本轮思考文本：优先用「思考模式适配」插件已提取的 response.reasoning，
 * 缺失时按同一套字段口径自行兜底，保证本插件单独启用也能工作。
 */
function pickReasoning(response) {
  const direct = response?.reasoning;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  return extractReasoning(response?.message);
}

/** 兼容各厂商的推理字段结构（与 thinking-adapters/dialects.js 口径一致）。 */
function extractReasoning(message) {
  if (!message || typeof message !== 'object') return '';
  const candidates = [
    message.reasoning_content,
    message.reasoning,
    message.thinking,
    message.thoughts
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  if (Array.isArray(message.reasoning_details)) {
    const joined = message.reasoning_details
      .map((d) => (typeof d === 'string' ? d : (d?.text ?? d?.summary ?? '')))
      .filter(Boolean)
      .join('\n');
    if (joined.trim()) return joined.trim();
  }
  if (Array.isArray(message.content)) {
    const joined = message.content
      .filter((p) => p?.type === 'thinking' || p?.type === 'reasoning')
      .map((p) => p?.thinking ?? p?.text ?? '')
      .filter(Boolean)
      .join('\n');
    if (joined.trim()) return joined.trim();
  }
  return '';
}

/** 0 或非法值 = 不限制；正数才截断。 */
function limitText(text) {
  const max = Math.max(0, Number(cfg().maxChars) || 0);
  if (!max || text.length <= max) return text;
  return `${text.slice(0, max)}\n…（已截断，完整内容 ${text.length} 字符）`;
}

export const hooks = {
  'after-response': ({ response, session } = {}) => {
    if (!session || !Array.isArray(session.messages)) return;
    const reasoning = pickReasoning(response);
    if (!reasoning) return;
    // 插在本轮正文之前：核心会在钩子返回后紧接着 push 本轮 assistant 正文，
    // 所以这里追加到最后，等价于会话页里"先深度思考、后正文"的阅读顺序。
    session.messages.push({
      role: 'assistant',
      content: `${PREFIX}\n${limitText(reasoning)}`
    });
  }
};

export function available() {
  return { ok: true };
}
