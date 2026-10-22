const DEFAULTS = {
  maxTurns: 3,
  expireMinutes: 5
};

let api = null;

// chatKey -> { messages: [{role, content}...], updatedAt: number }
const store = new Map();

function settings() {
  const raw = (api && typeof api.config === 'function' ? api.config() : null) || {};
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

function cleanupExpired() {
  const s = settings();
  const expireMs = s.expireMinutes * 60 * 1000;
  const now = Date.now();
  for (const [chatKey, entry] of store) {
    if (now - entry.updatedAt > expireMs) {
      store.delete(chatKey);
    }
  }
}

async function beforeLlmMessages({ chatKey, messages } = {}) {
  if (!chatKey || !Array.isArray(messages) || messages.length < 2) return;

  const s = settings();
  if (s.maxTurns <= 0) return;

  cleanupExpired();

  const entry = store.get(chatKey);
  if (!entry || !entry.messages || entry.messages.length === 0) return;

  // 取最近 N 轮（一轮 = user + assistant）
  const maxMsgs = s.maxTurns * 2;
  const history = entry.messages.slice(-maxMsgs);
  if (!history.length) return;

  // 当前 messages 是 [system, user]
  // 我们要把 history 插在 system 后面、当前 user 前面
  // 这样结构就是 [system, ...history, currentUser]
  const currentUser = messages.pop();
  messages.push(...history);
  messages.push(currentUser);
}

async function afterResponse(ctx = {}) {
  const chatKey = ctx.chatKey;
  const session = ctx.session;
  if (!chatKey || !session) return;

  const s = settings();
  if (s.maxTurns <= 0) return;

  // 从 session 里提取对话历史
  // session.messages 里每条是 { toolCall: ... } 格式
  // 我们要找 assistant 的文字回复和 user 的触发消息
  const history = [];

  // 先找 trigger entries（用户说了什么）
  if (Array.isArray(session.trigger) && session.trigger.length) {
    const userText = session.trigger
      .map((t) => `${t.senderName || t.senderId}：${String(t.text || '').slice(0, 200)}`)
      .join('\n');
    history.push({ role: 'user', content: userText.slice(0, 500) });
  }

  // 找 assistant 发的文字消息
  if (Array.isArray(session.sent)) {
    for (const sent of session.sent) {
      if (sent.type === 'text' && sent.text) {
        history.push({ role: 'assistant', content: String(sent.text).slice(0, 500) });
      }
    }
  }

  if (!history.length) return;

  // 更新 store
  const existing = store.get(chatKey) || { messages: [], updatedAt: 0 };
  existing.messages.push(...history);

  // 截断到最大轮数
  const maxMsgs = s.maxTurns * 2;
  if (existing.messages.length > maxMsgs) {
    existing.messages = existing.messages.slice(-maxMsgs);
  }

  existing.updatedAt = Date.now();
  store.set(chatKey, existing);
}

export function setup(a) { api = a; }
export function activate() {
  const s = settings();
  api?.log?.(`上下文延续已启用：maxTurns=${s.maxTurns} expireMinutes=${s.expireMinutes}`);
}
export function available() { return true; }
export const hooks = {
  'before-llm-messages': beforeLlmMessages,
  'after-response': afterResponse
};
