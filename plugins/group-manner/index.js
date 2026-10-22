/**
 * 群聊分寸（group-manner）—— QQ Agent 插件
 *
 * ── 解决什么 ──────────────────────────────────────────────────────────────
 * 内核默认 contextTier=4（全部响应）→ 群里**每条消息都唤醒她**，于是她句句都接，
 * 像客服值班而不是群友。真人不是这样的：大部分时间在潜水，被叫到才应，
 * 或者碰到自己感兴趣的话题才插一句。
 *
 * ── 为什么不用改内核 ──────────────────────────────────────────────────────
 * 内核本身就支持"看完消息决定不回，就安静结束"（src/prompt.js 里的规则 5，
 * 模型返回空即不发言）。所以本插件只需要**把"现在该不该开口"讲清楚** ——
 * 判断在插件这边做，执行交给内核原有的空回复路径，零内核改动。
 *
 * ── 怎么判断 ──────────────────────────────────────────────────────────────
 *   ① 是不是在跟她说话（被 @ / 被回复 / 私聊）→ 是则必回，绕过一切概率
 *   ② 有没有明确的说话对象（@ 了别人 / 回复了别人 / 点名问某人）→ 有则不插嘴
 *   ③ 除此之外给一个**按兴趣加权**的搭腔概率：
 *        基础 interjectChance
 *        + 命中兴趣词 interestBonus
 *        + 是问句 questionBonus
 *        + 带情绪 emotionBonus
 *      掷到了就允许她接一句，没掷到就让她安静 —— 这就是"偶尔挑感兴趣的回复"。
 *   ④ 外加一个最短间隔，防止她在别人聊天时连着插话。
 *
 * ── 还有一半是"怎么说话" ──────────────────────────────────────────────────
 * 光少说还不够，得像人。所以同时注入一段"像真人说话"的口径：
 * 短、口语、有情绪、不客服腔、不复读、允许不接。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../../src/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_TAG = '群聊分寸';
const BUILD_TAG = 'v1.0.0';

const DEFAULTS = {
  enabled: true,
  onlyGroups: true,
  quietIfNotAddressed: true,
  interjectChance: 15,
  interestKeywords: '',
  questionBonus: 20,
  emotionBonus: 15,
  interestBonus: 35,
  mannerPrompt: '',
  minGapSeconds: 45,
  onlyOwner: false,
  targets: ''
};

const BUILTIN_MANNER = [
  '【群里的说话方式（像真人，不像客服）】',
  '- **短**：一两句，通常 3~30 字。群里没人发长篇大论，长段落一眼就露馅。',
  '- **口语**：可以用「啊 / 吧 / 诶 / 草 / 哈哈 / ？？？ / 真的假的」，可以说半句话。',
  '- **有情绪**：好笑就笑，无语就吐槽一句，被逗到可以直接「草」。不用端着，也不用每句都礼貌。',
  '- **不客服腔**：绝不说「有什么可以帮您」「感谢分享」「希望对你有所帮助」「请问还有什么问题」这类。',
  '- **不复读**：别人刚说过的意思、刚发过的图，不要再重复一遍。',
  '- **允许不接**：没什么想说的就安静待着，这很正常 —— 不用为了合群硬找话题。',
  '- 偶尔只回一个词、一个表情、一句「+1」就够了；不是每次都要说完整的话。'
].join('\n');

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

/* ── 配置 ── */
const num = (v, d, min = 0, max = 100000) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : d;
};

function settings() {
  let raw = {};
  try {
    raw = (typeof api?.config === 'function' ? api.config() : null) || {};
  } catch { raw = {}; }
  const kw = String(raw.interestKeywords ?? DEFAULTS.interestKeywords);
  return {
    enabled: raw.enabled !== false,
    onlyGroups: raw.onlyGroups !== false,
    quietIfNotAddressed: raw.quietIfNotAddressed !== false,
    interjectChance: num(raw.interjectChance, DEFAULTS.interjectChance, 0, 100),
    keywords: kw.split(/\r?\n|[,，、]/).map((x) => x.trim()).filter(Boolean),
    questionBonus: num(raw.questionBonus, DEFAULTS.questionBonus, 0, 100),
    emotionBonus: num(raw.emotionBonus, DEFAULTS.emotionBonus, 0, 100),
    interestBonus: num(raw.interestBonus, DEFAULTS.interestBonus, 0, 100),
    mannerPrompt: String(raw.mannerPrompt ?? ''),
    minGapSeconds: num(raw.minGapSeconds, DEFAULTS.minGapSeconds, 0, 86400),
    onlyOwner: raw.onlyOwner === true,
    targets: String(raw.targets ?? '')
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

function inScope(chatKey, senderIds = []) {
  const s = settings();
  if (!s.enabled) return false;
  const key = String(chatKey || '');
  if (s.onlyGroups && !key.startsWith('group:')) return false;
  const targets = parseIds(s.targets);
  if (targets.length) {
    const ids = senderIds.length ? senderIds : (key.startsWith('private:') ? [key.slice('private:'.length)] : []);
    return ids.some((id) => targets.includes(id));
  }
  if (s.onlyOwner) {
    const owners = ownerIds();
    const ids = senderIds.length ? senderIds : [];
    return owners.length > 0 && ids.some((id) => owners.includes(id));
  }
  return true;
}

/* ── 场景判定 ──────────────────────────────────────────────────────────── */

/**
 * 一条消息是不是"在跟她说话"。
 * 只认结构化标记（atMe / replyToMe），不做名字匹配 —— 名字会改会撞。
 */
function addressedToMe(e, selfId = '') {
  if (!e || typeof e !== 'object') return false;
  if (e.atMe === true || e.atAll === true) return true;
  if (selfId && String(e.reply?.senderId ?? '') === String(selfId)) return true;
  return false;
}

/** 有没有"明确说给别人"的迹象：@ 了别人 / 回复了别人 / 点名问某人。 */
function pointedAtOther(e, selfId = '') {
  if (!e || typeof e !== 'object') return false;
  const replyTo = String(e.reply?.senderId ?? '');
  if (replyTo && selfId && replyTo !== String(selfId)) return true;
  const text = String(e.text ?? '');
  // @ 了别人（@ 段通常以 @ 或 [CQ:at,qq=xxx] 形式留下痕迹；这里用保守的文本特征）
  if (/@\S{1,20}/.test(text) && !addressedToMe(e, selfId)) return true;
  // 点名问某人：「张三你说呢」「楼上的问题是」「xx呢」
  if (/(^|[\s，,。！？])[\u4e00-\u9fa5A-Za-z0-9_]{2,12}(你|您)(说|觉得|看|来|呢|怎么)/.test(text)) return true;
  return false;
}

const isQuestion = (t) => /[?？]|吗[。！？!?]?$|怎么|为什么|为啥|如何|多少|哪[个里]|是不是|能不能|可不可以/.test(String(t || ''));
const hasEmotion = (t) => /哈哈|嘿嘿|嘻嘻|笑死|草|卧槽|我去|无语|麻了|气死|哭了|呜呜|烦死|崩溃|绝了|离谱|太[好棒牛强]|牛逼|难受|开心|难过|激动|惊了|震惊|离谱/.test(String(t || ''));

/**
 * 算这一轮"允不允许她开口"。
 * @returns {{speak:boolean, chance:number, roll:number, reason:string, kind:string}}
 */
function decide(entries = [], s = settings(), selfId = '', lastSpokeAt = 0, now = Date.now()) {
  const list = entries.filter((e) => e && !e.self);
  if (!list.length) return { speak: false, chance: 0, roll: 0, reason: '没有可回的消息', kind: 'none' };

  // ① 被叫到 → 必回
  if (list.some((e) => addressedToMe(e, selfId))) {
    return { speak: true, chance: 100, roll: 0, reason: '在跟她说话（被 @ / 被回复）', kind: 'addressed' };
  }

  // ② 别人之间有明确对象 → 默认不插嘴
  const pointed = list.filter((e) => pointedAtOther(e, selfId));
  if (pointed.length && s.quietIfNotAddressed) {
    return { speak: false, chance: 0, roll: 0, reason: '这话有明确对象（@ 了别人 / 回复别人 / 点名问某人），不插嘴', kind: 'other-target' };
  }

  // ③ 最短间隔（只约束"主动搭腔"，不约束被叫到）
  if (s.minGapSeconds > 0 && lastSpokeAt > 0 && now - lastSpokeAt < s.minGapSeconds * 1000) {
    const left = Math.ceil((s.minGapSeconds * 1000 - (now - lastSpokeAt)) / 1000);
    return { speak: false, chance: 0, roll: 0, reason: `刚搭过话，${left} 秒内不再主动插嘴`, kind: 'gap' };
  }

  // ④ 按兴趣加权掷骰子
  const joined = list.map((e) => String(e.text ?? '')).join('\n');
  let chance = s.interjectChance;
  const why = [`基础 ${s.interjectChance}%`];
  const hitKw = s.keywords.filter((k) => joined.includes(k));
  if (hitKw.length) { chance += s.interestBonus; why.push(`命中兴趣词「${hitKw.slice(0, 3).join('、')}」+${s.interestBonus}%`); }
  if (isQuestion(joined)) { chance += s.questionBonus; why.push(`是问句 +${s.questionBonus}%`); }
  if (hasEmotion(joined)) { chance += s.emotionBonus; why.push(`带情绪 +${s.emotionBonus}%`); }
  chance = Math.max(0, Math.min(100, chance));
  const roll = Math.random() * 100;
  const speak = roll < chance;
  return {
    speak,
    chance: Math.round(chance * 10) / 10,
    roll: Math.round(roll * 10) / 10,
    reason: `${why.join('，')} → 掷到 ${Math.round(roll)}，${speak ? '这次接一句' : '这次不说话'}`,
    kind: speak ? 'interject' : 'quiet'
  };
}

/* ── 本轮记账 ── */
const batches = new Map();               // sessionId -> { entries, chatKey, at }
const lastSpoke = new Map();             // chatKey -> ts
const BATCH_TTL_MS = 10 * 60 * 1000;

function rememberBatch(ctx = {}) {
  const sid = String(ctx?.sessionId || '');
  if (!sid) return null;
  const entries = (Array.isArray(ctx?.triggerEntries) ? ctx.triggerEntries : [])
    .filter((e) => e && !e.self)
    .map((e) => ({
      senderId: String(e?.senderId ?? '').replace(/[^0-9]/g, ''),
      senderName: String(e?.senderName ?? '').slice(0, 24),
      text: String(e?.text ?? '').slice(0, 300),
      atMe: e?.atMe === true, atAll: e?.atAll === true,
      isPoke: e?.isPoke === true,
      reply: e?.reply && typeof e.reply === 'object' ? { senderId: e.reply.senderId } : null
    }));
  const rec = { entries, chatKey: String(ctx?.chatKey || ''), at: Date.now() };
  batches.set(sid, rec);
  if (batches.size > 200) {
    for (const [k, v] of batches) if (Date.now() - v.at > BATCH_TTL_MS) batches.delete(k);
  }
  return rec;
}

/** 组装要注入的话。 */
function buildInjection(d, entries = [], s = settings()) {
  const out = [];
  if (d.kind === 'addressed') {
    out.push('【这一批是在跟你说话】该回就回，正常回应。');
  } else if (d.kind === 'other-target') {
    out.push('【这一批不是跟你说话】');
    out.push('- 这些话有明确的说话对象（@ 了别人、回复别人、或者点名问某个人）。**这一轮不要开口**。');
    out.push('- 安静结束就好，不用解释、不用说"我不打扰了"、也不用发表情刷存在感。');
    return out.join('\n');   // 不叠加"像真人"那段：这轮她本来就不该说话
  } else if (d.speak) {
    out.push('【这一批没人叫你，但你自己想搭一句】');
    out.push('- 你是因为对话题感兴趣才开口的 —— 那就**像群里的人一样随口接一句**，别像在回答问题。');
    out.push('- 如果你的话其实没什么必要，或者只是重复别人说的，那也可以改主意不说。');
  } else {
    out.push('【这一批你不打算开口】');
    out.push('- 别人在聊，这批里没有非你不可的话。**这一轮安静结束就好** —— 不回是正常的，不需要理由。');
    out.push('- 只有当你看完确实有话非说不可时，才破例接一句。');
  }
  const manner = String(s.mannerPrompt || '').trim();
  out.push('');
  out.push(BUILTIN_MANNER);
  if (manner) {
    out.push('');
    out.push('【额外要求】');
    out.push(manner);
  }
  return out.join('\n');
}

/* ── 钩子 ── */
export const hooks = {
  'before-context'(ctx = {}) {
    try {
      if (!settings().enabled) return;
      rememberBatch(ctx);
    } catch (e) {
      warn(`记账失败（不影响本轮）：${e?.message ?? e}`);
    }
  },

  'before-llm-messages'(ctx = {}) {
    try {
      const s = settings();
      if (!s.enabled) return;
      const messages = ctx?.messages;
      if (!Array.isArray(messages) || !messages.length) return;
      const chatKey = String(ctx?.chatKey || '');
      const sid = String(ctx?.sessionId || '');
      const rec = sid ? batches.get(sid) : null;
      const entries = rec?.entries || [];
      if (!entries.length) return;
      if (!inScope(chatKey, [...new Set(entries.map((e) => e.senderId).filter(Boolean))])) return;

      const selfId = String(api?.selfId || api?.onebot?.selfId || '');
      const d = decide(entries, s, selfId, lastSpoke.get(chatKey) || 0, Date.now());
      // 记日志（她为什么说/不说，排查时一眼能看到）
      log(`[${chatKey}] ${d.speak ? '开口' : '安静'}｜${d.reason}`);

      const text = buildInjection(d, entries, s);
      if (!text) return;
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i];
        if (!m || m.role !== 'user') continue;
        if (typeof m.content !== 'string') return;
        if (m.content.includes('【群聊分寸】')) return;   // 去重：重试路径不叠两遍
        m.content = `${m.content}\n\n【群聊分寸】\n${text}`;
        return;
      }
    } catch (e) {
      warn(`注入失败（不影响本轮）：${e?.message ?? e}`);
    }
  },

  'after-response'(ctx = {}) {
    try {
      const s = settings();
      if (!s.enabled) return;
      const chatKey = String(ctx?.chatKey || '');
      if (!chatKey) return;
      // 她这一轮真的说话了 → 记下时间（最短间隔用）
      const resp = ctx?.response || ctx?.session || null;
      const said = String(resp?.text ?? resp?.content ?? '').trim();
      if (said) lastSpoke.set(chatKey, Date.now());
    } catch { /* 记账失败不影响 */ }
  }
};

/* ── 生命周期 ── */
export function setup(a) {
  api = a;
  ensureLogger().then(() => {
    const s = settings();
    log(`已加载（${BUILD_TAG}）：${s.onlyGroups ? '只管群聊' : '所有会话'}`
      + `｜搭腔基础 ${s.interjectChance}%（兴趣 +${s.interestBonus} / 问句 +${s.questionBonus} / 情绪 +${s.emotionBonus}）`
      + `｜有明确对象时不插嘴 ${s.quietIfNotAddressed ? '开' : '关'}`
      + `｜最短间隔 ${s.minGapSeconds} 秒｜兴趣词 ${s.keywords.length} 个`);
  });
}

export function available() {
  return settings().enabled !== false;
}

export function deactivate() {
  batches.clear();
  lastSpoke.clear();
}

export function dispose() {
  batches.clear();
  lastSpoke.clear();
}

/* ── 面板 ── */
export const providers = {
  'status.group-manner': () => {
    const s = settings();
    const now = Date.now();
    const recent = [...lastSpoke.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([k, ts]) => `${k}（${Math.round((now - ts) / 60000)} 分钟前）`);
    return {
      icon: '🤐',
      title: '群聊分寸',
      priority: 57,
      lines: [
        ['状态', s.enabled ? '运行中（不再句句都接）' : '已关闭'],
        ['范围', s.onlyGroups ? '只管群聊（私聊不受影响）' : '所有会话'],
        ['被叫到时', '必回（@ 她 / 回复她 / 拍一拍）'],
        ['别人有明确对象时', s.quietIfNotAddressed ? '不插嘴' : '照常参与'],
        ['搭腔概率', `基础 ${s.interjectChance}%｜兴趣词 +${s.interestBonus}｜问句 +${s.questionBonus}｜情绪 +${s.emotionBonus}`],
        ['兴趣词', s.keywords.length ? s.keywords.slice(0, 8).join('、') + (s.keywords.length > 8 ? ` …共 ${s.keywords.length} 个` : '') : '（未设置）'],
        ['最短间隔', `${s.minGapSeconds} 秒（被叫到不受限）`],
        ['她最近开口过', recent.length ? recent.join('｜') : '（本次运行还没有）'],
        ['说话口径', s.mannerPrompt ? '内置 + 自定义补充' : '内置（短/口语/有情绪/不客服腔/不复读/允许不接）']
      ]
    };
  }
};

export const internals = {
  BUILD_TAG,
  settings,
  ownerIds,
  inScope,
  addressedToMe,
  pointedAtOther,
  isQuestion,
  hasEmotion,
  decide,
  buildInjection,
  rememberBatch,
  batches,
  lastSpoke
};
