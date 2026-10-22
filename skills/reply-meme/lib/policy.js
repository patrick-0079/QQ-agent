export const FIND_TOOL = 'reply-meme__find_meme';
export const SEND_TOOL = 'reply-meme__send_meme';
const LEVELS = { '0 · 不鼓励': 0, '1 · 偶尔': 1, '2 · 较积极': 2, '3 · 很积极': 3, low: 1, medium: 2, high: 3 };
const NAMES = ['不鼓励', '偶尔', '较积极', '很积极'];
const HINTS = [
  '表情是备选项，只有非常贴切时偶尔用；纯文字完全可以。',
  '普通闲聊约每 3~5 轮一张，玩梗时可以更密，不要连续刷屏。',
  '回应、吐槽、接梗时优先考虑一张贴切的表情，注意换着用。',
  '能配表情的地方尽量配，接梗、调侃、附和时积极使用；没有合适图片仍可不发。'
];

export function resolvePolicy(settings = {}) {
  const choice = String(settings.intensity ?? '跟随聊天设置');
  // Preserve the old explicit opt-out; host level zero has never meant disabled.
  const legacyOff = choice === '0 · 不主动' || choice === 'off';
  const follows = !legacyOff && !Object.hasOwn(LEVELS, choice) && !/^[0-3]$/.test(choice);
  // API v1 未公开全局设置；跟随模式只提示主模型遵守已有主提示词。
  const raw = follows ? null : LEVELS[choice] ?? Number(choice);
  const level = raw == null ? null : Math.min(3, Math.max(0, Math.floor(Number(raw) || 0)));
  return { proactive: settings.autoReply !== false && !legacyOff, follows, level,
    name: level == null ? '跟随宿主策略' : NAMES[level],
    hint: level == null ? '按主系统提示中的表情包积极程度选择，不另设频率。' : HINTS[level] };
}

export const hasMedia = (session) => (session?.sent || []).some(item => !item.to && ['image', 'sticker', 'video'].includes(item.type));
export const hasText = (session) => (session?.sent || []).some(item => !item.to && item.type === 'text' && typeof item.text === 'string' && item.text.trim());
export const stopped = (session) => ['aborted', 'error', 'done', 'noreply'].includes(session?.status);
