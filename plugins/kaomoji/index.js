// 颜文字点缀 —— 确定性型插件（放 plugins/，显示在控制台「插件」页签）。
//
// ── 做什么 ────────────────────────────────────────────────────────────────
// 在模型调用 send_message 的那次响应里，随机（整体约 5%、对主人 20%）
// 给**最后一条**消息末尾加一个颜文字。只做加法、不改原意；不合适就跳过。
//
// ── 为什么是插件而不是技能 ────────────────────────────────────────────────
// 「满足概率就自动执行」的机械动作，不需要模型理解或决定 —— 确定性型。
// 模型自己算概率不可靠（容易走极端：要么从不加，要么天天加），代码摇骰子最稳。
//
// ── 挂在哪个扩展点 ────────────────────────────────────────────────────────
// capability `llm.response`：llm.js 在解析完响应、orchestrator 执行工具之前
// 调用转换器（llm.js:484/517）。在这里改写 send_message 的 arguments，
// 工具执行时用的就是改后的文本（orchestrator.js:1128 读同一份 response.message）。
// 因此不需要改核心代码，也不会绕过发送队列/限频/存档。
//
// ── 安全底线 ──────────────────────────────────────────────────────────────
// 1. 只加不删：不构造新语义，只在末尾追加一个颜文字字符。
// 2. 异常全吞：任何一步出错都静默跳过，绝不让消息发不出去。
// 3. 不合适就不加：太长、多行、含链接、已带颜文字、含严肃关键词 → 跳过。

import { getConfig } from '../../src/config.js';
import { normalizeMessageList } from '../../src/util.js';

let cfg = () => ({});
let log = () => {};
let warn = () => {};

const DEFAULTS = {
  enabled: true,
  overallPercent: 5,
  ownerPercent: 20,
  maxChars: 60,
  kaomojiList: '(｡•̀ᴗ-)✧|(≧▽≦)|(｡･ω･｡)|(๑•̀ㅂ•́)و✧|(￣▽￣)|(・∀・)|(｀・ω・´)|(๑´ㅂ`๑)|( ˘ω˘ )|(｡>ㅅ<｡)|(＾▽＾)|(●\'◡\'●)|(✿◡‿◡)|(｡◕‿◕｡)|ヾ(≧▽≦*)o|(´･ω･`)|( ╹▽╹ )|(＾ω＾)|(｡・ω・｡)ﾉ|(￣ω￣;)',
  avoidWords: '生病,医院,去世,死了,难过,想哭,报警,投诉,抱歉,对不起,生气,分手,抑郁,自杀,救命,住院,手术'
};

/** 读配置：任何异常都退回默认值（插件绝不因为配置读不出来而影响发送）。 */
function conf() {
  try {
    return { ...DEFAULTS, ...(cfg() || {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

/** 主人 QQ 列表（owner-identity.ids / owner-whitelist.ownerIds）。 */
function ownerIds() {
  const cfgNow = getConfig() || {};
  const skills = cfgNow.skills || {};
  const rawList = [skills['owner-identity']?.ids, skills['owner-whitelist']?.ownerIds, cfgNow.ownerIds];
  const out = [];
  for (const raw of rawList) {
    if (!raw) continue;
    const list = Array.isArray(raw) ? raw : String(raw).split(/[,，;；\s]+/);
    for (const item of list) {
      const id = String(item ?? '').trim();
      if (/^\d{5,15}$/.test(id) && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

/** 当前这轮是不是在跟主人说话（私聊主人）。 */
function isOwnerChat(ctx) {
  const ids = ownerIds();
  if (!ids.length) return false;
  const m = /^private:(\d+)$/.exec(String(ctx?.chatKey || ''));
  if (m && ids.includes(m[1])) return true;
  if (String(ctx?.kind || '') === 'private' && ids.includes(String(ctx?.chatId || ''))) return true;
  return false;
}

/** 解析颜文字池（| 或逗号/换行分隔）。 */
function kaomojiPool(c) {
  return String(c.kaomojiList || '')
    .split(/[|\n\r,，、]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 末尾是否已经像颜文字（括号短串），避免叠加两个。 */
function looksAlreadyDecorated(text) {
  return /[（(][^（）()\n]{0,20}[）)]\s*$/.test(text);
}

/** 「合适的时候」的判定：任何一条不满足就不加。 */
function isAppropriate(text, c) {
  const t = String(text || '').trim();
  if (!t) return false;
  const maxChars = Math.max(10, Number(c.maxChars) || 60);
  if (t.length > maxChars) return false;
  if (/[\r\n]/.test(t)) return false;
  if (/https?:\/\//i.test(t)) return false;
  if (looksAlreadyDecorated(t)) return false;
  const avoid = String(c.avoidWords || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const w of avoid) if (t.includes(w)) return false;
  return true;
}

/** 概率（0~100）。 */
function percentOf(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : fallback;
}

let lastKao = '';

export const providers = {
  // llm.js 在响应解析后调用：{ result, ...skillContext }
  'llm.response': (payload) => {
    try {
      const c = conf();
      if (!c.enabled) return;
      const msg = payload?.result?.message;
      const calls = msg?.tool_calls;
      if (!Array.isArray(calls) || !calls.length) return;

      // 只处理 send_message（send_to 是跨会话转达，不点缀）
      const call = calls.find((x) => x?.function?.name === 'send_message');
      if (!call) return;

      let args;
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {
        return; // 参数不是合法 JSON：不碰
      }

      let texts;
      try {
        texts = normalizeMessageList(args.messages);
      } catch {
        return; // 消息形态解不出来：不碰（交给工具自己报错给模型）
      }
      if (!texts.length) return;

      const last = texts[texts.length - 1];
      if (!isAppropriate(last, c)) return;

      const pct = isOwnerChat(payload)
        ? percentOf(c.ownerPercent, 20)
        : percentOf(c.overallPercent, 5);
      if (!(pct > 0)) return;
      if (Math.random() * 100 >= pct) return;

      const pool = kaomojiPool(c);
      if (!pool.length) return;
      let kao = pool[Math.floor(Math.random() * pool.length)];
      // 避免连续两次同一个（池子够大时）
      if (pool.length > 1 && kao === lastKao) kao = pool[(pool.indexOf(kao) + 1) % pool.length];
      lastKao = kao;

      texts[texts.length - 1] = last + kao;
      args.messages = texts;
      call.function.arguments = JSON.stringify(args);
      return { result: { message: msg } };
    } catch (error) {
      try {
        warn(`颜文字点缀失败（已忽略）：${error?.message ?? error}`);
      } catch {
        /* ignore */
      }
    }
  }
};

export function setup(api) {
  cfg = api.config || (() => ({}));
  log = api.log || (() => {});
  warn = api.warn || (() => {});
}

/** 无外部依赖，恒可用。 */
export function available() {
  return { ok: true };
}

/** 排障用。 */
export const internals = {
  DEFAULTS, isAppropriate, isOwnerChat, kaomojiPool, looksAlreadyDecorated
};
