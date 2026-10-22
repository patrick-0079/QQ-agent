import { clean, knownMoodWords, moodWords, occurrences, isNegated, matches } from './text.js';
import { selectionInfo, meaningfulText } from './metadata.js';
export { isAffirmedPhrase } from './text.js';
import fs from 'node:fs';
import path from 'node:path';
import { readBytes, trustedUrl } from './network.js';

export const INDEX_URL = 'https://aigengtu.com/gallery-index.json';
const MAX_AGE = 7 * 24 * 3600000;
const ROLES = [
  ['DeepSeek娘', 'deepseek', 'deepseek娘', 'ds娘', '鲸鱼娘', '蓝色大肥鱼', '大肥鱼', '深度求索'],
  ['Claude娘', 'claude', 'claude娘'], ['GPT娘', 'gpt', 'gpt娘', 'chatgpt'],
  ['豆大妈', '豆包', '豆包娘', '豆大妈', 'doubao'], ['Kimi娘', 'kimi', 'kimi娘'],
  ['通义千问娘', '通义千问', '通义', '千问', 'qwen'], ['智谱清言娘', '智谱清言', '智谱', 'glm'],
  ['Gemini娘', 'gemini', 'gemini娘'], ['Grok娘', 'grok', 'grok娘'], ['AI娘化', 'ai娘化']
];
const ROLE_PREFIXES = [...new Set(ROLES.flat())].sort((a, b) => b.length - a.length);
const clip = (s, n) => typeof s === 'string' ? s.slice(0, n) : '';

// Source-specific corrections stay at ingestion, not in ranking or sending.
// Observed on 2026-10-02. Apply only while the misleading title is unchanged.
const CORRECTIONS = {
  '1532': ['DeepSeek鲸娘『加载可爱中』表情包', 'DeepSeek形象对比的社交平台截图'],
  '1531': ['DeepSeek鲸娘『可爱即正义』表情包', 'DeepSeek鲸娘全身插画'],
  '1610': ['DeepSeek鲸娘『贴贴』表情包', 'DeepSeek鲸娘单人像（国旗背景）']
};

function sourceLabel(title) {
  const prefix = ROLE_PREFIXES.find(alias => title.toLowerCase().startsWith(alias.toLowerCase()));
  return (prefix ? title.slice(prefix.length).replace(/^(?:女仆)?(?:鲸鱼?|酱)?娘?/, '') : title).trim();
}

export function parseIndex(raw) {
  if (!raw?.gallery || Array.isArray(raw.gallery) || typeof raw.gallery !== 'object') throw new Error('图库索引格式已变更');
  const result = [], seen = new Set();
  for (const [category, group] of Object.entries(raw.gallery)) {
    if (!Array.isArray(group?.images)) throw new Error('图库分类缺少 images');
    for (const value of group.images) {
      if (!value || typeof value.original !== 'string') continue;
      try {
        const original = trustedUrl(value.original);
        if (!/\/meme\/\d+\.(webp|png|jpg|jpeg|gif)$/i.test(new URL(original).pathname) || seen.has(original)) continue;
        seen.add(original);
        let preview = '';
        try { if (typeof value.preview === 'string') preview = trustedUrl(value.preview); } catch { /* optional */ }
        let title = clip(value.name || value.alt, 300);
        let alt = clip(value.alt, 300);
        let story = clip(typeof value.story === 'string' ? value.story : value.story?.zh, 1600);
        const id = /\/(\d+)\.[a-z]+$/i.exec(new URL(original).pathname)?.[1];
        const correction = CORRECTIONS[id];
        const requestOnly = correction?.[0] === title;
        if (requestOnly) { title = correction[1]; alt = ''; story = ''; }
        let label = sourceLabel(title);
        if (!meaningfulText(label) && meaningfulText(sourceLabel(alt))) { title = alt; label = sourceLabel(alt); }
        result.push({ original, preview, title, alt, story, label,
          ...(requestOnly ? { requestOnly: true } : {}), category: clip(category, 80), page: `https://aigengtu.com/meme/${id}` });
      } catch { /* invalid entries are not fetch targets */ }
      if (result.length >= 20000) return result;
    }
  }
  return result;
}

export function createSource(httpFetch, directory) {
  const file = path.join(directory, 'gallery-cache.json');
  let cache = null, pending = null, retryAfter = 0;
  try {
    if (fs.statSync(file).size <= 6 * 1024 * 1024) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Number.isFinite(saved.at) && saved.at <= Date.now() && Date.now() - saved.at < MAX_AGE) {
        cache = { at: saved.at, items: parseIndex(saved.raw) };
      }
    }
  } catch { /* fetch a fresh index */ }
  return {
    peek() { return cache && Date.now() - cache.at < MAX_AGE ? cache.items : []; },
    async load(cacheMinutes = 1440, signal) {
      if (signal?.aborted) throw new Error('索引请求已取消');
      if (cache && Date.now() - cache.at < cacheMinutes * 60000) return { ...cache, stale: false };
      const usableCache = cache && Date.now() - cache.at < MAX_AGE;
      if (usableCache && (pending || Date.now() < retryAfter)) return { ...cache, stale: true };
      if (pending) return pending;
      pending = (async () => {
        try {
          const bytes = await readBytes(httpFetch, INDEX_URL, { maxBytes: 5 * 1024 * 1024, accept: 'application/json', signal });
          if (signal?.aborted) throw signal.reason;
          const raw = JSON.parse(bytes.toString('utf8'));
          const items = parseIndex(raw);
          const at = Date.now();
          cache = { at, items };
          try {
            fs.mkdirSync(directory, { recursive: true });
            const temp = `${file}.${process.pid}.tmp`;
            fs.writeFileSync(temp, JSON.stringify({ at, raw }));
            fs.renameSync(temp, file);
          } catch { /* in-memory cache is enough */ }
          return { ...cache, stale: false };
        } catch (error) {
          if (signal?.aborted) throw error;
          retryAfter = Date.now() + 60000;
          if (cache && Date.now() - cache.at < MAX_AGE) return { ...cache, stale: true };
          throw error;
        }
      })().finally(() => { pending = null; });
      if (usableCache) {
        // 更新索引不占住工具回合；hook 依旧只读取现有缓存。
        pending.catch(() => {});
        return { ...cache, stale: true };
      }
      return pending;
    }
  };
}

function roleFrom(value) {
  const q = clean(value);
  if (!q || ['auto', '不限', '全部'].includes(q)) return null;
  const role = ROLES.find((r) => r.some((alias) => clean(alias) === q));
  if (!role) throw new Error(`不支持的角色：${String(value).slice(0, 40)}。可用 DeepSeek、Claude、GPT、豆包、Kimi、通义千问、智谱清言、Gemini、Grok、AI娘化。`);
  return role[0];
}

export function rankCandidates(items, { keyword = '', emotion = '', character = '', defaultCharacter = 'auto', random = false } = {}) {
  let query = clean(keyword).slice(0, 120);
  const explicitRole = roleFrom(character);
  const inferredRoles = [];
  for (const role of ROLES) {
    const aliases = [...new Set(role.map(clean))].sort((a, b) => b.length - a.length);
    if (aliases.some((a) => query.includes(a))) {
      inferredRoles.push(role[0]);
      for (const alias of aliases) query = query.split(alias).join(' ');
    }
  }
  const hasCharacter = typeof character === 'string' && character.trim().length > 0;
  // User's explicit role > role in keyword > configured default. Explicit auto suppresses the default.
  const defaultRole = !explicitRole && !inferredRoles.length && !hasCharacter ? roleFrom(defaultCharacter) : null;
  const roles = explicitRole ? [explicitRole] : inferredRoles.length ? inferredRoles : defaultRole ? [defaultRole] : [];
  // Keep meaningful phrases intact; the model supplies short keywords, not entire messages.
  const terms = query.replace(/表情包|表情|梗图|配图|来一张|来张|一张|图片/g, ' ').split(/[\s,，、;；。！!？?]+/).filter((x) => x && x !== '的');
  const mood = moodWords(emotion);
  const intendedMood = clean(emotion) ? knownMoodWords(emotion) : terms.flatMap(knownMoodWords);
  if (!terms.length && !mood.length && !roles.length && !random) return [];
  const scored = [];
  for (const item of items) {
    if (roles.length && !roles.includes(item.category)) continue;
    const info = selectionInfo(item);
    const title = clean(info.label), story = clean(info.description);
    // Exclude contradictory moods before scoring so another synonym or dedupe cannot resurrect them.
    if (intendedMood.some((word) => occurrences(title, clean(word)).some((at) => isNegated(title, at)))) continue;
    const caption = clean(/[『「“]([^』」”]+)[』」”]/.exec(item.title)?.[1] || '').replace(/[\s\p{P}\p{S}]/gu, '');
    let score = 0, hits = 0, titleSupport = false, descriptionSupport = false;
    for (const term of terms) {
      if (matches(title, term)) {
        score += 12; hits++; titleSupport = true;
        if (caption === term) score += 12;
        else if (caption.includes(term) && caption.length <= 12) score += 6;
      }
      else if (matches(story, term)) { score += 3; hits++; descriptionSupport = true; }
      else {
        const synonyms = moodWords(term);
        if (synonyms.some((w) => matches(title, w))) { score += 5; hits++; titleSupport = true; }
        else if (synonyms.some((w) => matches(story, w))) { score += 1; hits++; descriptionSupport = true; }
      }
    }
    if (terms.length && !hits) continue;
    if (mood.length) {
      if (mood.some((w) => matches(title, w))) { score += 10; titleSupport = true; }
      else if (mood.some((w) => matches(story, w))) { score += 2; descriptionSupport = true; }
      else continue;
    }
    // Narrative mentions (e.g. "收到用户的迷惑输入") do not establish a reply's intent.
    // A description can be the only usable evidence for an untitled image.
    // It must not override a meaningful title expressing something else.
    if ((terms.length || mood.length) && !titleSupport && !(info.evidence === 'description' && descriptionSupport)) continue;
    if (terms.length > 1 && hits === terms.length) score += 8;
    if (score && (caption.length > 35 || /[四五六九]格|拼图|合集/.test(title))) score *= 0.65;
    scored.push({ ...item, score: score || 1 });
  }
  scored.sort((a, b) => b.score - a.score);
  if (!scored.length) return [];
  // Prefer the highest relevance band; don't trade meaning for novelty or resolution.
  const floor = Math.max(1, scored[0].score * 0.7);
  return scored.filter((x) => x.score >= floor);
}
