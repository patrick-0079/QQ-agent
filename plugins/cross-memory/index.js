/**
 * 仿生记忆（cross-memory v2）—— QQ Agent 插件
 *
 * ── 和 v1 的区别 ──────────────────────────────────────────────────────────
 * v1 是"把她最近说过的话按时间倒序取几条塞进上下文"——机械、每次都全量、
 * 没有主次。那是数据库，不是记忆。
 *
 * v2 按人脑记忆的几个特性重做：
 *   ① **遗忘曲线**：每条记忆有强度，随时间指数衰减（半衰期默认 36 小时）。
 *      不常被想起的事自然淡掉，而不是"过了 48 小时一刀切"。
 *   ② **情绪加权**：带情绪的事（笑、气、委屈、激动）衰减更慢 —— 人就是记得住
 *      让自己有情绪的事。
 *   ③ **联想检索**：不再按时间倒序全量取，而是拿**当前正在聊的话题**去匹配记忆关键词，
 *      按「强度 × 相关度 × 新鲜度」打分，只取真正相关的那几条。想不起来的就不提。
 *   ④ **复习效应**：某条记忆被想起一次，它的强度就加一点 —— 越常回忆越牢。
 *   ⑤ **记忆巩固**：强度高、且被反复想起的，升级成「长期记忆」（衰减慢得多）。
 *      偶尔想起一次的仍算「短期记忆」。
 *   ⑥ **细节模糊化**：越久远的记忆，注入时给得越简略（截得更短）——
 *      人对旧事的印象本来就是梗概，不会记得原话。
 *
 * ── 隐私（沿用 v1 的默认）────────────────────────────────────────────────
 * 只抽取 `self: true` 的内容（**她自己说过的 / 做过的**）。别的会话里别人说的原话
 * 默认不带 —— 群里 A 说的话，A 并不知道会被带到你私聊里。要带得自己开开关。
 *
 * ── 幂等 ──────────────────────────────────────────────────────────────────
 * 衰减是"读的时候按时间算"，所以必须确定性：同一时刻读多次结果要一致。
 * 采集是增量的（记住 lastScanAt + 每条消息的 ts），不会重复记。
 */

import fs from 'node:fs';
import path from 'node:path';
import { readChatState } from '../../src/storage/chatlog.js';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../../src/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_TAG = '仿生记忆';
const BUILD_TAG = 'v2.0.0';

const DEFAULTS = {
  enabled: true,
  halfLifeHours: 36,
  emotionBonus: 2.5,
  longTermThreshold: 0.62,
  promoteAfterRecalls: 3,
  longTermHalfLifeFactor: 6,
  recallBoost: 0.12,
  maxRecall: 4,
  minScore: 0.18,
  maxChars: 900,
  lookbackHours: 24 * 21,
  includeOthers: false,
  includeImpressions: true,
  maxPerScan: 400,
  minTextLen: 3,
  scanEveryMin: 5,
  forgetBelow: 0.04
};

let api = null;
let log = (...a) => { try { api?.log?.(...a); } catch { /* ignore */ } };
let warn = (...a) => { try { api?.warn?.(...a); } catch { /* ignore */ } };
let loggerReady = false;

async function ensureLogger() {
  if (loggerReady) return;
  try {
    const { logger } = await import('../../src/logger.js');
    if (logger?.info) {
      log = (t) => { try { logger.info(LOG_TAG, String(t)); } catch { /* ignore */ } };
      warn = (t) => { try { logger.warn(LOG_TAG, String(t)); } catch { /* ignore */ } };
    }
  } catch { /* 用 api.log */ }
  loggerReady = true;
}

/* ── 路径 ── */
const DATA_DIR = (() => {
  const fromEnv = String(process.env?.QQ_AGENT_DATA_DIR ?? '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  const suffix = /^\d+$/.test(String(process.env?.QQ_AGENT_PROFILE ?? '')) ? `-${process.env.QQ_AGENT_PROFILE}` : '';
  try {
    const guess = path.resolve(HERE, '..', '..', '..', 'data' + suffix);
    if (fs.existsSync(path.join(guess, 'config.json'))) return guess;
  } catch { /* 往下走 */ }
  return path.resolve(HERE, '..', '..', 'data' + suffix);
})();

const MESSAGES_DIR = path.join(DATA_DIR, 'messages');
const IMPRESSIONS_DIR = path.join(DATA_DIR, 'memory');
const STORE_DIR = path.join(DATA_DIR, 'cross-memory');
const STORE_FILE = path.join(STORE_DIR, 'memories.json');

/* ── 配置 ── */
const num = (v, d, min = 0, max = 1e9) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : d;
};

function settings() {
  let raw = {};
  try {
    raw = (typeof api?.config === 'function' ? api.config() : null) || {};
  } catch { raw = {}; }
  return {
    enabled: raw.enabled !== false,
    halfLifeHours: num(raw.halfLifeHours, DEFAULTS.halfLifeHours, 1, 24 * 60),
    emotionBonus: num(raw.emotionBonus, DEFAULTS.emotionBonus, 1, 10),
    longTermThreshold: num(raw.longTermThreshold, DEFAULTS.longTermThreshold, 0.1, 1),
    promoteAfterRecalls: Math.round(num(raw.promoteAfterRecalls, DEFAULTS.promoteAfterRecalls, 1, 20)),
    longTermHalfLifeFactor: num(raw.longTermHalfLifeFactor, DEFAULTS.longTermHalfLifeFactor, 1, 50),
    recallBoost: num(raw.recallBoost, DEFAULTS.recallBoost, 0, 1),
    maxRecall: Math.round(num(raw.maxRecall, DEFAULTS.maxRecall, 1, 12)),
    minScore: num(raw.minScore, DEFAULTS.minScore, 0, 1),
    maxChars: Math.round(num(raw.maxChars, DEFAULTS.maxChars, 100, 6000)),
    lookbackHours: num(raw.lookbackHours, DEFAULTS.lookbackHours, 1, 24 * 120),
    includeOthers: raw.includeOthers === true,
    includeImpressions: raw.includeImpressions !== false,
    maxPerScan: Math.round(num(raw.maxPerScan, DEFAULTS.maxPerScan, 10, 5000)),
    minTextLen: Math.round(num(raw.minTextLen, DEFAULTS.minTextLen, 1, 60)),
    scanEveryMin: num(raw.scanEveryMin, DEFAULTS.scanEveryMin, 0.5, 120),
    forgetBelow: num(raw.forgetBelow, DEFAULTS.forgetBelow, 0, 0.5)
  };
}

const parseIds = (s) => [...new Set(String(s ?? '').split(/[,，;；\s]+/)
  .map((x) => x.replace(/[^0-9]/g, '')).filter(Boolean))];

function ownerIds() {
  const cfg = getConfig() || {};
  return parseIds(cfg.skills?.soulmate?.ids
    || cfg.skills?.bond?.ownerQq
    || cfg.skills?.['owner-identity']?.ids);
}

/* ══════════════ 关键词与情绪（不依赖分词库的轻量做法）══════════════ */

/** 中文停用词（只去掉最没信息量的，避免误伤）。 */
const STOP = new Set(['这个', '那个', '什么', '怎么', '我们', '你们', '他们', '就是', '不是', '可以',
  '现在', '今天', '明天', '昨天', '因为', '所以', '但是', '然后', '还是', '已经', '一下', '一个',
  '这些', '那些', '自己', '觉得', '知道', '可能', '应该', '真的', '有点', '感觉', '时候', '还有',
  '如果', '这样', '那样', '没有', '起来', '出来', '过来', '一起', '这个', '嗯嗯', '哈哈']);

/**
 * 提关键词：中文取 2-gram 与 3-gram（不依赖分词库也能抓到"画画""加班""女朋友"这类词），
 * 英文按单词。去掉停用词与纯数字。
 */
export function keywordsOf(text, max = 14) {
  const t = String(text ?? '');
  const out = [];
  const seen = new Set();
  const push = (w) => {
    const x = String(w).trim().toLowerCase();
    if (!x || x.length < 2 || seen.has(x) || STOP.has(x)) return;
    if (/^[\d\s]+$/.test(x)) return;
    seen.add(x);
    out.push(x);
  };
  // 英文/数字词
  for (const m of t.matchAll(/[A-Za-z][A-Za-z0-9_]{1,20}/g)) push(m[0]);
  // 连续中文段 → 2/3-gram
  for (const seg of t.matchAll(/[\u4e00-\u9fa5]{2,}/g)) {
    const s = seg[0];
    for (let i = 0; i + 2 <= s.length && out.length < max * 2; i += 1) push(s.slice(i, i + 2));
    for (let i = 0; i + 3 <= s.length && out.length < max * 2; i += 2) push(s.slice(i, i + 3));
  }
  return out.slice(0, max);
}

/** 粗估"情绪强度" 0~1：标点、笑声、感叹、脏话、情绪词都算。 */
export function emotionOf(text) {
  const t = String(text ?? '');
  if (!t) return 0;
  let s = 0;
  if (/[!！]{1,}/.test(t)) s += 0.2;
  if (/[?？]{2,}/.test(t)) s += 0.15;
  if (/哈哈|嘿嘿|嘻嘻|笑死|草|卧槽|我去|妈呀/.test(t)) s += 0.3;
  if (/好可爱|好喜欢|想你|爱你|抱抱|亲亲|mua/i.test(t)) s += 0.35;
  if (/生气|气死|烦死|讨厌|难受|委屈|哭了|呜呜|崩溃|害怕|紧张/.test(t)) s += 0.35;
  if (/太.{0,4}了|真的.{0,4}|居然|竟然|天啊|天呐/.test(t)) s += 0.15;
  if (t.length <= 6) s += 0.05;                       // 短促的话往往情绪更直接
  return Math.max(0, Math.min(1, s));
}

/* ══════════════ 相关性（n-gram 命中 + 字符级 Dice）══════════════ */

/** 取出一段文字里有信息量的汉字集合（去掉最高频的虚字）。 */
const FILLER = new Set([...'的了是我你他她它们在有和就不都一个上也很到说要去会着没看好自己这那什么怎么' +
  '吗呢吧啊呀哦嗯把被让给对从与及或但而且还如果所以因为可以这个那个么']);
export function charsOf(text) {
  const out = new Set();
  for (const c of String(text ?? '')) {
    if (!/[\u4e00-\u9fa5]/.test(c)) continue;
    if (FILLER.has(c)) continue;
    out.add(c);
  }
  return out;
}

/** 字符级 Dice 相似度（2|A∩B| / (|A|+|B|)）。中文短文本上比 n-gram 稳，
 *  能抓住「上班」↔「加班」这类不共享词但共享字的情况。 */
export function diceOf(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const c of a) if (b.has(c)) inter += 1;
  return (2 * inter) / (a.size + b.size);
}

/* ══════════════ 记忆存储 ══════════════ */

const emptyStore = () => ({ version: 2, memories: [], lastScanAt: 0, scans: 0 });
let cache = null;

export function loadStore() {
  if (cache) return cache;
  let data = emptyStore();
  try {
    const j = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    if (j && typeof j === 'object' && Array.isArray(j.memories)) data = { ...emptyStore(), ...j };
  } catch { /* 首次运行 */ }
  cache = data;
  return data;
}

export function saveStore(data = cache) {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    const tmp = `${STORE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
    fs.renameSync(tmp, STORE_FILE);
    cache = data;
    return true;
  } catch (e) {
    warn(`记忆写盘失败：${e?.message ?? e}`);
    return false;
  }
}

/* ══════════════ 遗忘曲线（读时结算，幂等）══════════════ */

/**
 * 某条记忆在 now 时刻的强度。
 *   · 指数衰减：exp(-Δt / 半衰期)
 *   · 情绪越高半衰期越长（记得更牢）
 *   · 长期记忆再乘一个系数（衰减慢得多）
 *   · 被回忆过会有加成（复习效应，记在 recallBoostTotal 里）
 * 纯函数：同一 (mem, now) 永远同一结果，不会因为多读几次而漂移。
 */
export function strengthOf(mem, now, s = settings()) {
  const ts = Number(mem?.ts) || now;
  // 衰减起点取「事件发生」与「上次想起」里更晚的那个 —— 回忆会重新巩固记忆。
  // 人也是这样：老事一旦被想起来，就又变得清楚。
  // 但**细节**仍按真实年龄模糊化（见 blurText）—— 那是"熟悉感还在、细节早忘了"的分工。
  const anchor = Math.max(ts, Number(mem?.lastRecallAt) || 0);
  const hours = Math.max(0, (now - anchor) / 3600000);
  const emo = Math.max(0, Math.min(1, Number(mem?.emotion) || 0));
  let half = s.halfLifeHours * (1 + emo * (s.emotionBonus - 1));
  if (mem?.kind === 'long') half *= s.longTermHalfLifeFactor;
  const decayed = Math.exp(-hours / Math.max(0.5, half));
  const base = Number(mem?.base) || 1;
  const boost = Number(mem?.recallBoostTotal) || 0;
  return Math.max(0, Math.min(2, base * decayed + boost * decayed));
}

/* ══════════════ 采集（增量，不重复记）══════════════ */

export function fileToChatKey(name) {
  const m = /^(group|private)_(\d+)\.(?:json|jsonl)$/.exec(String(name));
  return m ? `${m[1]}:${m[2]}` : '';
}

export function worthKeeping(text, minLen = 3) {
  const t = String(text ?? '').trim();
  if (t.length < minLen) return false;
  if (/^\[[^\]]{1,12}\]$/.test(t)) return false;
  if (/^[\p{P}\p{S}\s]+$/u.test(t)) return false;
  return true;
}

/**
 * 增量扫描各会话存档，把新出现的「她自己说过的话」变成记忆条目。
 * 只记 self: true（includeOthers 打开时，别人的话也记，但打上别人的标记）。
 */
export function scan(s = settings(), now = Date.now(), force = false) {
  const store = loadStore();
  if (!force && s.scanEveryMin > 0 && now - Number(store.lastScanAt || 0) < s.scanEveryMin * 60000) {
    return { added: 0, skipped: '距上次扫描还不够久' };
  }
  // 快照 + JSONL 增量都要看：只读 .json 会漏掉还没压缩的新消息
  let files = [];
  try {
    files = fs.readdirSync(MESSAGES_DIR);
  } catch {
    return { added: 0, skipped: '没有消息存档' };
  }
  const chatKeys = new Set();
  for (const f of files) {
    const key = fileToChatKey(f);
    if (key) chatKeys.add(key);
  }
  const seen = new Set(store.memories.map((m) => m.id));
  const since = now - s.lookbackHours * 3600000;
  let added = 0;

  for (const chatKey of chatKeys) {
    const j = readChatState(chatKey);
    const msgs = Array.isArray(j?.messages) ? j.messages : [];
    let taken = 0;
    for (let i = msgs.length - 1; i >= 0 && taken < s.maxPerScan; i -= 1) {
      const m = msgs[i];
      const ts = Number(m?.ts) || 0;
      if (ts && ts < since) break;
      const isSelf = m?.self === true;
      if (!isSelf && !s.includeOthers) continue;
      const text = String(m?.text ?? '').trim();
      if (!worthKeeping(text, s.minTextLen)) continue;
      const id = `${chatKey}#${ts}#${text.slice(0, 24)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      store.memories.push({
        id,
        ts: ts || now,
        chatKey,
        self: isSelf,
        text: text.slice(0, 400),
        keywords: keywordsOf(text, 12),
        emotion: emotionOf(text),
        base: 1,
        kind: 'short',
        recallCount: 0,
        recallBoostTotal: 0,
        lastRecallAt: 0
      });
      added += 1;
      taken += 1;
    }
  }
  store.lastScanAt = now;
  store.scans = Number(store.scans || 0) + 1;

  // 忘掉强度低到可以忽略的（真正的"遗忘"）
  const before = store.memories.length;
  store.memories = store.memories.filter((m) => strengthOf(m, now, s) >= s.forgetBelow);
  const forgotten = before - store.memories.length;

  // 巩固：**反复被想起的事**会变成长期记忆。
  // 主判据是回忆次数 —— 人记住一件事靠的是反复提取，不是它当时有多强烈；
  // 强度只当加速器（又强、又至少想起过一次的，也算）。
  let promoted = 0;
  for (const m of store.memories) {
    if (m.kind === 'long') continue;
    const recalls = Number(m.recallCount) || 0;
    if (recalls >= s.promoteAfterRecalls || (strengthOf(m, now, s) >= s.longTermThreshold && recalls >= 1)) {
      m.kind = 'long';
      promoted += 1;
    }
  }
  saveStore(store);
  return { added, forgotten, promoted, total: store.memories.length };
}

/* ══════════════ 联想检索 ══════════════ */

/**
 * 由**当前话题**想起相关的往事。
 * 打分：强度 × 0.55 + 关键词相关度 × 0.35 + 新鲜度 × 0.10
 * @returns {Array} 命中的记忆（已按分数排序）
 */
export function recall(topicText, selfKey, s = settings(), now = Date.now()) {
  const store = loadStore();
  const topicKw = new Set(keywordsOf(topicText, 18));
  const topicChars = charsOf(topicText);
  const out = [];
  for (const m of store.memories) {
    if (m.chatKey === selfKey && now - m.ts < 20 * 60000) continue;    // 刚说的不用提醒她
    if (!m.self && !s.includeOthers) continue;
    const st = strengthOf(m, now, s);
    if (st < s.forgetBelow) continue;

    // 相关度取两条通道里更强的那个：
    //   ① n-gram 命中（精确，"画画" ↔ "画画"）
    //   ② 字符级 Dice（模糊，"上班" ↔ "加班" 这种不共享词但共享字的情况）
    // 只靠 ① 太脆；只靠 ② 太松。
    let hit = 0;
    for (const k of m.keywords || []) if (topicKw.has(k)) hit += 1;
    const relNgram = topicKw.size ? hit / Math.max(2, Math.min(6, topicKw.size)) : 0;
    const relChar = diceOf(topicChars, charsOf(m.text));
    const rel = Math.max(relNgram, relChar);

    // ★ 联想检索的闸：**一点共同点都没有，就想不起来**。
    // 人也是这样 —— 聊量子力学时不会突然冒出一句"我刚吃完饭"。
    // （想主动找话说是 her-life 的事，不该由记忆系统硬塞。）
    if (rel <= 0) continue;

    const anchor = Math.max(Number(m.ts) || 0, Number(m.lastRecallAt) || 0);
    const aliveH = (now - anchor) / 3600000;
    const fresh = Math.exp(-aliveH / (s.halfLifeHours * 3));
    // 三项权重：**相关度主导**（0.55），其次强度（0.30），最后新鲜度（0.15）。
    // 一开始我把强度给到 0.55，结果问"今天上班累吗"她先想起"我家猫踩坏键盘"——
    // 只因为那条更近。人的检索是线索驱动的：相关才想得起来，而不是新的先冒头。
    const score = Math.min(1, rel) * 0.55 + st * 0.30 + fresh * 0.15;
    if (score < s.minScore) continue;
    out.push({ mem: m, score, strength: st, rel, hit });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/** 从当前上下文里挑出"正在聊什么"（最近几条 user 消息拼起来）。 */
export function topicFromMessages(messages, maxLen = 800) {
  if (!Array.isArray(messages)) return '';
  const parts = [];
  for (let i = messages.length - 1; i >= 0 && parts.length < 4; i -= 1) {
    const m = messages[i];
    if (m?.role !== 'user' || typeof m.content !== 'string') continue;
    parts.push(m.content.slice(-400));
  }
  return parts.join('\n').slice(-maxLen);
}

/** 细节模糊化：越久远的记忆给得越简略。 */
export function blurText(text, ageHours, s = settings()) {
  const t = String(text ?? '');
  const half = Math.max(1, s.halfLifeHours);
  const ratio = Math.exp(-ageHours / (half * 2));      // 1 = 很新，0 = 很久
  const limit = Math.round(30 + ratio * 70);           // 30~100 字
  if (t.length <= limit) return t;
  return t.slice(0, limit) + '…';
}

/* ══════════════ 组装注入文本 ══════════════ */

const pad2 = (n) => String(n).padStart(2, '0');
const hhmm = (ts) => { const d = new Date(ts); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const dateLabel = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1}-${pad2(d.getDate())}`; };
export function placeLabel(chatKey, selfKey = '') {
  const k = String(chatKey || '');
  if (k === selfKey) return '这里';
  return k.startsWith('private:') ? '私聊' : '那个群里';
}

/**
 * 组装要注入的那段（联想出的几条，不是全量倾倒）。
 * @returns {{text:string, count:number, chats:number, scored:Array}}
 */
export function buildRecall(selfKey, topicText, s = settings(), now = Date.now()) {
  const hits = recall(topicText, selfKey, s, now);
  if (!hits.length) return { text: '', count: 0, chats: 0, scored: [] };
  const lines = [];
  const chats = new Set();
  let used = 0;
  for (const h of hits) {
    if (lines.length >= s.maxRecall) break;
    const m = h.mem;
    const ageH = (now - m.ts) / 3600000;
    const when = ageH < 20 ? `${hhmm(m.ts)}` : `${dateLabel(m.ts)} ${hhmm(m.ts)}`;
    const body = blurText(m.text, ageH, s);
    const tag = m.kind === 'long' ? '（这事你一直记着）' : '';
    const line = `· ${when}（${placeLabel(m.chatKey, selfKey)}）你说过「${body}」${tag}`;
    if (used + line.length > s.maxChars) break;
    lines.push(line);
    used += line.length;
    chats.add(m.chatKey);
    // 复习效应：想起来了就更牢一点（记在 boost 上，读时一起衰减）
    m.recallCount = Number(m.recallCount || 0) + 1;
    m.lastRecallAt = now;
    m.recallBoostTotal = Math.min(0.6, Number(m.recallBoostTotal || 0) + s.recallBoost);
  }
  if (!lines.length) return { text: '', count: 0, chats: 0, scored: hits };
  saveStore();                                          // 记住这次"想起来过"

  const out = [
    '【你想起了一些事（由现在聊的内容想起来的，不是全部）】',
    ...lines
  ];
  if (s.includeImpressions) {
    const imp = loadImpressions(selfKey, 4);
    if (imp.length) {
      out.push('【你对这些人的印象】');
      for (const i of imp) out.push(`· ${i.name ? i.name + '：' : ''}${i.text}`);
    }
  }
  out.push('（自然带出来就行，别复述时间地点，也别说「我记得」这种话 —— 就跟人聊天时顺口提到一样。）');
  return { text: out.join('\n'), count: lines.length, chats: chats.size, scored: hits.slice(0, s.maxRecall) };
}

/** 群友印象（内核 memory.js 维护的 data/memory/<会话>/<QQ>.json）。 */
export function loadImpressions(selfKey = '', max = 6) {
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(IMPRESSIONS_DIR);
  } catch {
    return out;
  }
  for (const dir of dirs) {
    if (dir === 'backups') continue;
    const full = path.join(IMPRESSIONS_DIR, dir);
    let stat = null;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!stat.isDirectory()) continue;
    const key = String(dir).replace(/_/g, ':');
    if (key === selfKey) continue;
    let files = [];
    try { files = fs.readdirSync(full).filter((x) => x.endsWith('.json') && !x.startsWith('_')); } catch { continue; }
    for (const f of files.slice(0, 20)) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(full, f), 'utf8'));
        const items = Array.isArray(j?.items) ? j.items : (Array.isArray(j) ? j : []);
        const nm = String(j?.name || '').slice(0, 10);
        for (const it of items) {
          const t = String(it?.text ?? it?.impression ?? '').trim();
          if (!t) continue;
          out.push({ name: nm, text: t.slice(0, 70) });
          if (out.length >= max) return out;
        }
      } catch { /* 跳过坏文件 */ }
    }
  }
  return out;
}

function inScope(chatKey, s = settings()) {
  if (!s.enabled) return false;
  return true;                                          // v2 对所有会话生效（记忆本就该互通）
}

/* ── 钩子 ── */
export const hooks = {
  'before-llm-messages'(ctx = {}) {
    try {
      const s = settings();
      if (!s.enabled) return;
      const chatKey = String(ctx?.chatKey || '');
      if (!chatKey) return;
      const messages = ctx?.messages;
      if (!Array.isArray(messages) || !messages.length) return;

      // ① 先增量采集（低频：默认 5 分钟一次）
      const sc = scan(s, Date.now());
      if (sc.added) log(`采集到 ${sc.added} 条新记忆`
        + `${sc.forgotten ? `，遗忘了 ${sc.forgotten} 条` : ''}`
        + `${sc.promoted ? `，巩固了 ${sc.promoted} 条为长期记忆` : ''}`);

      // ② 由当前话题联想 → 组装
      const topic = topicFromMessages(messages);
      const { text, count, chats } = buildRecall(chatKey, topic, s, Date.now());
      if (!text) return;

      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i];
        if (!m || m.role !== 'user') continue;
        if (typeof m.content !== 'string') return;
        if (m.content.includes('【你想起了一些事')) return;      // 去重（重试路径）
        m.content = `${m.content}\n\n${text}`;
        log(`想起 ${count} 件事（来自 ${chats} 个会话）`);
        return;
      }
    } catch (e) {
      warn(`联想失败（不影响本轮）：${e?.message ?? e}`);
    }
  }
};

/* ── 生命周期 ── */
export function setup(a) {
  api = a;
  ensureLogger().then(() => {
    const s = settings();
    const store = loadStore();
    const longTerm = store.memories.filter((m) => m.kind === 'long').length;
    log(`已加载（${BUILD_TAG}）：半衰期 ${s.halfLifeHours} 小时｜情绪加成 ×${s.emotionBonus}`
      + `｜长期记忆阈值 ${s.longTermThreshold}（衰减慢 ${s.longTermHalfLifeFactor} 倍）`
      + `｜每轮最多想起 ${s.maxRecall} 件`);
    log(`记忆库：${store.memories.length} 条（长期 ${longTerm} 条）｜扫描 ${store.scans || 0} 次`
      + `｜别人原话 ${s.includeOthers ? '会记' : '不记（默认）'}`);
  });
}

export function available() {
  return settings().enabled !== false;
}
export function dispose() { /* 由 loadStore 缓存，无需清理 */ }

/* ── 面板 ── */
export const providers = {
  'status.cross-memory': () => {
    const s = settings();
    const store = loadStore();
    const now = Date.now();
    const alive = store.memories
      .map((m) => ({ m, st: strengthOf(m, now, s) }))
      .sort((a, b) => b.st - a.st);
    const longTerm = store.memories.filter((m) => m.kind === 'long').length;
    const strong = alive.filter((x) => x.st >= 0.5).length;
    const byChat = new Map();
    for (const m of store.memories) byChat.set(m.chatKey, (byChat.get(m.chatKey) || 0) + 1);
    const avgEmo = store.memories.length
      ? (store.memories.reduce((n, m) => n + (Number(m.emotion) || 0), 0) / store.memories.length)
      : 0;
    return {
      icon: '🧠',
      title: '仿生记忆',
      priority: 56,
      lines: [
        ['状态', s.enabled ? '运行中（联想式回忆，不是全量倾倒）' : '已关闭'],
        ['记忆库', `${store.memories.length} 条｜长期记忆 ${longTerm} 条｜还很清楚（强度≥0.5）${strong} 条`],
        ['遗忘曲线', `半衰期 ${s.halfLifeHours} 小时｜情绪高的事最多慢 ${s.emotionBonus} 倍｜低于 ${s.forgetBelow} 就忘掉`],
        ['复习效应', `每想起一次强度 +${s.recallBoost}（上限 0.6）｜想起 ≥${s.promoteAfterRecalls} 次升级为长期记忆`],
        ['联想检索', `由当前话题匹配（n-gram + 字符相似度双通道），最多想起 ${s.maxRecall} 件（门槛 ${s.minScore}）｜毫无共同点就不想起来`],
        ['细节模糊化', '越久远只给梗概（30~100 字）；被想起只恢复"熟悉感"，细节仍按真实年龄淡去'],
        ['各会话来源', [...byChat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
          .map(([k, v]) => `${k} ${v}`).join('｜') || '（无）'],
        ['平均情绪强度', `${(avgEmo * 100).toFixed(0)}%`],
        ['别人原话', s.includeOthers ? '⚠️ 会记（你打开的）' : '不记（默认：只记她自己说过的）'],
        ['对人的印象', s.includeImpressions ? '一并带（内核 memory.js 整理过的摘要）' : '不带']
      ]
    };
  }
};

export const internals = {
  BUILD_TAG,
  DATA_DIR,
  MESSAGES_DIR,
  STORE_FILE,
  settings,
  ownerIds,
  inScope,
  keywordsOf,
  emotionOf,
  charsOf,
  diceOf,
  strengthOf,
  fileToChatKey,
  worthKeeping,
  loadStore,
  saveStore,
  scan,
  recall,
  topicFromMessages,
  blurText,
  placeLabel,
  buildRecall,
  loadImpressions
};
