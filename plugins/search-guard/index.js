const DEFAULTS = { maxSearches: 3, alsoBlockFetch: true };
let api = null;

function settings() {
  const raw = (api && typeof api.config === 'function' ? api.config() : null) || {};
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

function countSearches(session) {
  if (!session || !Array.isArray(session.messages)) return 0;
  let used = 0;
  for (const m of session.messages) {
    const name = m?.toolCall?.name || m?.toolName || '';
    if (name === 'web_search' || name === 'web_fetch') used++;
  }
  return used;
}

async function beforeTool({ toolName: name, session } = {}) {
  const s = settings();
  const max = Math.floor(Number(s.maxSearches));
  if (!max || max <= 0) return;

  const searchNames = ['web_search'];
  if (s.alsoBlockFetch) searchNames.push('web_fetch');
  if (!searchNames.includes(name)) return;

  const used = countSearches(session);
  if (used < max) return;

  return {
    block: true,
    reason: `【强制】本次对话已搜索 ${used} 次（上限 ${max}）。立即停止搜索，基于已有信息直接 send_message 回复用户，然后 finish。`
  };
}

export function setup(a) { api = a; }
export function activate() {
  const s = settings();
  api?.log?.(`搜索护栏启用: maxSearches=${s.maxSearches}`);
}
export function available() { return true; }
export const hooks = { 'before-tool': beforeTool };
