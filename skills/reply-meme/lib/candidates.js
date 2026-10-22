import { fingerprint } from './image.js';
import { selectionInfo } from './metadata.js';
import { matches, knownMoodWords, MOOD_TERMS } from './text.js';

// Diversify the shelf, never classify the conversation or decide whether to send.
const SHELVES = [
  /生气|气鼓鼓|愤怒|哼|你才|反击/, /哈哈|大笑|笑死|乐/, /疑惑|问号|震惊/,
  /委屈|哭|难过|可怜/, /抱抱|安慰|摸摸/, /喜欢|爱你|比心|贴贴/,
  /躺平|摆烂|摸鱼|装死/, /谢谢|感谢|不客气/, /晚安|早安|你好|Ciallo/i,
  /加油|厉害|真棒/, /开心|好耶|高兴|得意/, /钱|续费|收费|余额|赞助/,
  /无语|嫌弃|吐槽/, /害羞|尴尬|捂脸|撒娇|卖萌|可爱/, /道歉|对不起|认错/, /收到|好的|同意/
];
const STOP = new Set(['我们', '你们', '这个', '那个', '就是', '一个', '什么', '怎么', '可以', '现在', '然后', '一下', '还是', '不是', '因为', '所以', '用户', '机器人', '模型',
  '不要', '不够', '不能', '没有', '还有', '很多', '一些', '这样', '那样', '觉得', '真的', '已经', '刚才', '继续', '给我', '换个', '换一个', '表情', '表情包', '图片', '颜文字']);
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
const norm = value => String(value || '').normalize('NFKC').toLowerCase();
export const candidateId = item => fingerprint(item.original).slice(0, 16);

export function buildCandidates(items, text = '', { seen = () => false, cached = () => false, limit = 12, seed = '', relevantOnly = false } = {}) {
  // Recent lines win over accumulated history; repeated common words cannot
  // manufacture relevance. This retrieves vocabulary, not the user's emotion.
  const words = new Map();
  const lines = norm(text).slice(-6000).split('\n').filter(x => x.trim()).slice(-8).reverse();
  for (const [age, line] of lines.entries()) {
    // Intl.Segmenter may split colloquial phrases such as 好耶 into single chars.
    const terms = [...MOOD_TERMS.filter(term => line.includes(term)),
      ...[...segmenter.segment(line)].filter(part => part.isWordLike).map(part => part.segment)];
    for (const term of terms) {
      if (term.length >= 2 && !STOP.has(term) && !words.has(term) && words.size < 48) {
        words.set(term, age === 0 ? 4 : age < 3 ? 2 : 1);
      }
    }
  }
  const weightedWords = [...words].map(([word, weight]) => ({ word, weight, synonyms: knownMoodWords(word) }));
  const pool = items.flatMap(item => {
    const info = selectionInfo(item);
    if (info.requestOnly) return [];
    const title = norm(info.label), story = norm(info.description);
    let fit = 0;
    for (const { word, weight, synonyms } of weightedWords) {
      if (matches(title, word)) fit += 4 * weight;
      else if (synonyms.some(term => matches(title, term))) fit += 2 * weight;
      else if (info.evidence === 'description' && matches(story, word)) fit += weight;
    }
    return [{ ...item, recent: seen(item), local: cached(item), fit, label: info.label,
      tie: fingerprint(seed + item.original).slice(0, 8) }];
  });
  const novelty = (a, b) => Number(a.recent) - Number(b.recent) || Number(b.local) - Number(a.local) || a.tie.localeCompare(b.tie);
  const selected = [], taken = new Set();
  const add = item => { if (item && !taken.has(item.original) && selected.length < limit) { taken.add(item.original); selected.push(item); } };
  const bestFit = Math.max(0, ...pool.map(x => x.fit));
  const related = pool.filter(x => x.fit > 0 && x.fit >= bestFit * 0.5).sort((a, b) => b.fit - a.fit || novelty(a, b));
  if (relevantOnly) return related.slice(0, limit);
  related.slice(0, Math.max(1, Math.ceil(limit * 2 / 3))).forEach(add);
  // A small rotating shelf lets the main model respond with a different attitude
  // than the user's words. Do not always spend the spare slots on anger/laughter.
  const offset = parseInt(fingerprint(seed).slice(0, 8), 16) % SHELVES.length;
  const spareLimit = Math.min(limit, selected.length + Math.max(1, Math.min(4, Math.floor(limit / 3))));
  for (let i = 0; i < SHELVES.length && selected.length < spareLimit; i++) {
    const shelf = SHELVES[(offset + i) % SHELVES.length];
    const inShelf = item => shelf.test(item.label);
    if (selected.some(inShelf)) continue;
    add(pool.filter(x => inShelf(x) && !taken.has(x.original)).sort(novelty)[0]);
  }
  related.forEach(add);
  // Empty browsing may explore meaningful titles. Topic-based shelves never
  // fill remaining slots with unrelated, unlabelled images.
  if (!text.trim()) pool.sort(novelty).forEach(add);
  return selected;
}

export function describe(item, recent = false, { compact = false } = {}) {
  const info = selectionInfo(item);
  if (compact) return { id: candidateId(item), title: item.title.slice(0, 110),
    ...(info.evidence === 'description' ? { description: info.description.slice(0, 140) } : {}),
    ...(recent ? { recentlySent: true } : {}) };
  return { id: candidateId(item), title: item.title.slice(0, 110),
    ...(info.description ? { description: info.description.slice(0, 140) } : {}),
    evidence: info.evidence, ...(info.requestOnly ? { requestOnly: true } : {}),
    character: item.category, recentlySent: recent };
}
