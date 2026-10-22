const MOODS = {
  难过: ['难过', '不开心', '伤心', '委屈', '哭哭', '哭泣', '落泪', '呜呜'],
  开心: ['开心', '快乐', '高兴', '好耶', '欢呼', '庆祝'],
  感谢: ['感谢', '谢谢', '多谢', '感激', '谢啦'],
  赞同: ['赞同', '收到', '明白', '好的', '好哒', '没问题', '同意', '了解'],
  鼓励: ['鼓励', '加油', '你可以', '你能行', '坚持', '打气'],
  安慰: ['安慰', '抱抱', '别难过', '摸摸头', '不哭'],
  疑惑: ['疑惑', '困惑', '疑问', '问号', '不懂', '歪头', '奇怪'],
  无语: ['无语', '沉默', '扶额', '无奈', '呆滞'],
  震惊: ['震惊', '惊讶', '吃惊', '震撼', '目瞪口呆'],
  生气: ['生气', '气愤', '气鼓鼓', '愤怒', '恼火'],
  道歉: ['道歉', '对不起', '抱歉', '认错', '我错了'],
  晚安: ['晚安', '睡觉', '睡了', '好梦', '困了'],
  早安: ['早安', '早上好', '起床'],
  摸鱼: ['摸鱼', '偷懒', '摆烂', '躺平', '划水'],
  喜欢: ['喜欢', '爱你', '比心', '心动'],
  贴贴: ['贴贴', '抱抱', '蹭蹭', '依偎'],
  尴尬: ['尴尬', '汗颜', '社死', '捂脸'],
  害羞: ['害羞', '羞涩', '脸红'],
  卖萌: ['卖萌', '撒娇'],
  得意: ['得意', '骄傲', '自豪', '叉腰'],
  大笑: ['大笑', '哈哈', '笑死', '笑出声', '爆笑']
};
export const MOOD_TERMS = [...new Set(Object.values(MOODS).flat())];
export const clean = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const MOOD_LOOKUP = new Map();
for (const [mood, words] of Object.entries(MOODS)) {
  for (const word of [mood, ...words]) if (!MOOD_LOOKUP.has(clean(word))) MOOD_LOOKUP.set(clean(word), words);
}

export function knownMoodWords(value) {
  return MOOD_LOOKUP.get(clean(value)) || [];
}

export function moodWords(value) {
  const known = knownMoodWords(value);
  const q = clean(value);
  return known.length ? known : q ? [q] : [];
}

// Only inspect the immediate prefix, without crossing punctuation or clauses.
// Lexical phrases such as 没问题/不懂/不哭 are matched as whole phrases.
const NEGATED_PREFIX = /(?:不|没(?:有)?|未|别|莫|勿|并非|不是|不能|无法)(?:再|太|很|怎么|那么|这么|够|算|想|要|会|敢|能|可能|真的|真|特别|完全|十分|一直|已经|任何|一点|一丝|一丁点|有点|值得|\s){0,4}$/u;

export function occurrences(text, word) {
  const positions = [];
  if (!word) return positions;
  for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + word.length)) positions.push(at);
  return positions;
}

export function isNegated(text, at) {
  return NEGATED_PREFIX.test(text.slice(Math.max(0, at - 20), at));
}

export function matches(text, word) {
  const q = clean(word);
  if (!occurrences(text, q).some((at) => !isNegated(text, at))) return false;
  // "好的，现在我是你爹了" is not an acknowledgement. Require a complete "好的" caption.
  if (q === '好的') return /(?:^|[『「“"'\s])好的(?:[』」”"'。！!]|$)/.test(text);
  return true;
}

export function isAffirmedPhrase(text, phrase) {
  return matches(clean(text), clean(phrase));
}
