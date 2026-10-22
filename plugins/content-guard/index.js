// 擦边内容拦截（content-guard）：有人 @ 机器人 / 回复机器人，但内容是黄色或擦边时，
// 机器人不予理会（不回、不解释、不劝、不复述）。
//
// ── 为什么是「原型补丁」而不是 hooks ──────────────────────────────────────
// 5 个 hook（before-context / before-llm-messages / after-response / before-tool /
// after-tool）**全都发生在"已经排定一次模型会话之后"**。而「不予理会」要求的是
// **根本不排这次会话** —— 命中就该 0 token、不叫模型。
// 唯一位置是 Orchestrator.prototype.onIncoming：它是**每一条**入站消息的必经点，
// 也是核心判定"要不要响应"的地方（判定不触发 → 标已读 → return）。
// 本插件在这里做的是**前置否决**：命中时不调用原方法，直接复刻核心那条
// "未触发"路径（markEntryRead + emit chat-update），行为与核心自身的不触发完全一致。
// 旁边 plugins/repeat-echo 用的是同一手法（它是事后观察，本插件是事前否决）。
//
// ── 两层防护 ─────────────────────────────────────────────────────────────
//   ① 硬拦（本文件）：明显露骨的词 → 消息进来那一刻就不触发会话，0 token
//   ② 提示词规则（plugin.json 的 prompt.sections）：负责词表抓不到的
//      谐音 / 双关 / 隐晦暗示，由模型自己判断后保持沉默
//   另有 before-llm-messages：把命中内容在**送进模型前**替换成 [已过滤]，
//   防止机器人翻到历史里的这类消息时接话（只改提示词那一份，存档原文不动）。
//
// ⚠️ 本文件在 resources/app 里，应用自动更新会覆盖；装回来即可（配置不受影响）。

import { Orchestrator } from '../../src/orchestrator.js';
import { logger } from '../../src/logger.js';

const PLUGIN_ID = 'content-guard';
const PATCH_KEY = Symbol.for('qq-agent.content-guard.patch');

/**
 * 默认词表：**刻意保守**。
 *
 * 只收「几乎不可能出现在正常语境里」的多字词。像「操」「草」「骚」「逼」这类
 * 单字或常用脏话一律不收 —— 它们在日常口语里大量出现（"我操""别逼我"），
 * 收进来会把正常聊天整条拦掉，比漏拦更糟。
 * 抓不到的、这个群特有的说法，交给设置里的「额外词」；误伤了就用「例外词」。
 */
const DEFAULT_WORDS = [
  '做爱', '性交', '口交', '肛交', '射精', '自慰', '手淫', '肉棒', '阴茎', '阴道', '龟头',
  '精液', '淫水', '骚穴', '淫叫', '浪叫', '约炮', '裸聊', '裸照', '黄图', '色图', '涩图',
  '里番', '撸管', '打飞机', '开黄腔',
];

/**
 * 同一类词的**其它语言**。
 *
 * 使用者问："黄色违禁词是不止中文的吗" —— 实测答案是**原来只认中文** ✗：
 * `r18`、`nsfw`、`エロ`、`zuoai` 这些在旧词表里全能过去。
 * 这里补的是**明确、几乎不会误伤**的词；谐音/双关那种仍交给模型判断 ✓
 */
const MULTILINGUAL_WORDS = [
  // 英文
  'r18', 'r-18', 'nsfw', 'porn', 'porno', 'hentai', 'sexting', 'sexchat', 'sextape',
  'nude', 'nudes', 'rule34', 'onlyfans', 'camgirl', 'fuck',
  // 日文
  'エロ', 'おっぱい', 'ちんこ', 'まんこ', 'セックス', '全裸', '裸体',
  // 拼音（音游群里常见的打法）
  'zuoai', 'seqi', 'seqing', 'huangtu', 'luoliao', 'yuepao', 'zibao', 'luotu',
];

/**
 * 血腥暴力类。**只收多字、语义明确的词。**
 *
 * ⚠️ 单字（打 / 杀 / 血 / 死 / 刀）**绝不能进表** —— 会误伤日常对话：
 *    "打死你""打歌打到手出血了""这曲子要命" 这类在音游群里天天出现 ✗
 * 所以只收"肢解""分尸"这种组合起来才有意义的词。
 */
const VIOLENT_WORDS = [
  '肢解', '分尸', '碎尸', '虐杀', '开膛', '凌迟', '剥皮', '血肉模糊',
  '割腕', '自杀方法', '自杀教程', '虐猫', '虐狗', '活埋',
];

/**
 * 脏话类。**默认关闭** —— 理由：
 *   ① 群聊里骂人太常见（实测当天群里就有一条 `sb`），硬屏蔽会让机器人"装听不懂"、显得坏了；
 *   ② 使用者明确要求过「被挑衅可以毒舌」，屏蔽脏话会跟那条规矩直接打架。
 * 更合适的做法是**不拦"听到"、只限"说出"**（见 plugin.json 里的提示词规则）。
 * 想硬屏蔽的人可以把 blockProfanity 打开。
 */
const PROFANITY_WORDS = [
  '傻逼', '煞笔', '沙比', '傻屄', '去死吧', '操你', '艹你', '干你妈', '你妈死了',
  '贱人', '臭婊', '死全家',
];

let api = null;
const stats = { blocked: 0, redacted: 0, lastHit: '', lastAt: 0 };

/** 逗号（中英文）分隔的词表 → 数组；去空、去重、trim。 */
export function splitWords(raw) {
  const out = [];
  for (const item of String(raw ?? '').split(/[,，、;；\s]+/)) {
    const w = item.trim();
    if (w && !out.includes(w)) out.push(w);
  }
  return out;
}

/** 轻量归一：去零宽字符、全角转半角、小写。 */
export function normalize(text) {
  return String(text ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .toLowerCase();
}

/**
 * 去掉分隔符后的紧凑形式。用于抓「色 图」「色-图」「s e x」这类**插分隔符规避**。
 * ⚠️ 只在**短消息**上启用（见 matchBlocked）：否则会把两句话拼在一起凭空造出脏词，
 *    例如「好色 图片」拼成「好色图片」就含「色图」✗ —— 那是误伤。
 */
export function compact(text) {
  return normalize(text).replace(/[\s\-_.·*~^,，。、;；:：!！?？'"“”‘’()（）[\]【】<>《》/\\|+]+/g, '');
}

/** 当前生效的完整词表（按设置开关拼装）。 */
export function activeWords(cfg = {}) {
  const words = [...DEFAULT_WORDS, ...MULTILINGUAL_WORDS];
  if (cfg.blockViolent !== false) words.push(...VIOLENT_WORDS);
  if (cfg.blockProfanity === true) words.push(...PROFANITY_WORDS);
  return [...words, ...splitWords(cfg.extraWords)];
}

/**
 * 命中判定。返回命中的词，没命中返回 null。
 * 例外词先被**从正文里剔除**再比对 —— 这样"某个词误伤"不会连累整条消息，
 * 比"整条放行"精确得多。
 */
export function matchBlocked(text, cfg = {}) {
  const raw = String(text ?? '');
  if (!raw) return null;
  let subject = raw;
  for (const w of splitWords(cfg.allowWords)) subject = subject.split(w).join('');
  const list = activeWords(cfg);

  // ① 常规匹配（已做全角/大小写归一）
  const norm = normalize(subject);
  for (const w of list) {
    if (w && norm.includes(normalize(w))) return w;
  }

  // ② 变体规避：真删掉分隔符再比一次。限短消息，避免跨句拼词误伤。
  if (raw.length <= 24) {
    const cmp = compact(subject);
    if (cmp.length <= 14) {
      for (const w of list) {
        const cw = compact(w);
        if (cw.length >= 2 && cmp.includes(cw)) return w;
      }
    }
  }
  return null;
}

/** 这条消息是不是「冲着机器人来的」：@ 它、@全体、或回复它自己的消息。 */
export function isDirectedAtBot(orch, entry) {
  if (!entry) return false;
  if (entry.atMe === true || entry.atAll === true) return true;
  const selfId = String(orch?.onebot?.selfId ?? '');
  const replyTo = String(entry.reply?.senderId ?? '');
  return Boolean(selfId) && replyTo === selfId;
}

function settings() {
  return api?.config?.() || {};
}

/**
 * 事前否决判定。返回命中的词 = 拦；返回 null = 放行（走原逻辑）。
 * 任何异常都吞掉并放行 —— 过滤器坏掉不该让机器人整体不响应。
 */
function veto(orch, chatKey, entry) {
  const cfg = settings();
  if (cfg.enabled === false) return null;
  if (cfg.hardBlock === false) return null;
  if (!entry) return null;                       // 没有具体条目（peekUnread 路径）不否决
  if (String(cfg.scope || 'directed') !== 'all' && !isDirectedAtBot(orch, entry)) return null;
  const hit = matchBlocked(entry.text, cfg);
  if (!hit) return null;
  return { word: hit };
}

export function setup(skillApi) { api = skillApi; }

export function available() { return { ok: true }; }

export function activate() {
  const ok = install();
  if (ok) {
    logger.info(PLUGIN_ID, '擦边内容拦截已挂载：onIncoming 前置否决（命中即不触发会话，0 token）');
  }
}

export function deactivate() { uninstall(); }

export function dispose() { uninstall(); }

/** 状态查询能力：给控制台/排障用（不是给模型的工具）。 */
export const providers = {
  [`${PLUGIN_ID}.status`]: () => ({
    enabled: settings().enabled !== false,
    scope: String(settings().scope || 'directed'),
    hardBlock: settings().hardBlock !== false,
    blockViolent: settings().blockViolent !== false,
    blockProfanity: settings().blockProfanity === true,
    wordCounts: {
      中文成人: DEFAULT_WORDS.length,
      其它语言: MULTILINGUAL_WORDS.length,
      血腥暴力: settings().blockViolent !== false ? VIOLENT_WORDS.length : 0,
      脏话: settings().blockProfanity === true ? PROFANITY_WORDS.length : 0,
      自定义: splitWords(settings().extraWords).length,
      生效合计: activeWords(settings()).length,
    },
    blocked: stats.blocked,
    redacted: stats.redacted,
    lastHit: stats.lastHit,
    lastAt: stats.lastAt ? new Date(stats.lastAt).toLocaleString('zh-CN', { hour12: false }) : '',
    words: DEFAULT_WORDS.length + splitWords(settings().extraWords).length,
  }),
};

export const hooks = {
  /**
   * 上下文净化：把送给模型的那一份里的命中行换成 [已过滤]。
   * 只动这一次调用的 messages 对象，**不碰聊天存档**。
   */
  'before-llm-messages'(ctx = {}) {
    const cfg = settings();
    if (cfg.enabled === false || cfg.redactInContext === false) return;
    const messages = Array.isArray(ctx?.messages) ? ctx.messages : null;
    if (!messages?.length) return;

    for (const message of messages) {
      if (!message || typeof message.content !== 'string') continue;
      if (!matchBlocked(message.content, cfg)) continue;       // 整段没命中就跳过，省开销
      message.content = message.content
        .split('\n')
        .map((line) => (matchBlocked(line, cfg) ? redactLine(line) : line))
        .join('\n');
      stats.redacted++;
    }
  },
};

/** 保留 `时间 名字(QQ:x)：` 前缀，只把正文换掉（正文里可能有多个"："，所以用第一个）。 */
function redactLine(line) {
  const i = line.indexOf('：');
  return i >= 0 ? `${line.slice(0, i + 1)}[已过滤]` : '[已过滤]';
}

/**
 * 装上钩子。幂等：同一个 prototype 上只包一次，热重载只换 handle。
 * 与 repeat-echo 同款做法 —— 旧模块实例的 deactivate 没被调到也不会包两层。
 */
function install() {
  const proto = Orchestrator?.prototype;
  if (!proto || typeof proto.onIncoming !== 'function') {
    logger.warn(PLUGIN_ID, '拿不到 Orchestrator.prototype.onIncoming，擦边拦截未挂载（应用版本可能变了）');
    return false;
  }

  let rec = proto[PATCH_KEY];
  if (!rec) {
    const original = proto.onIncoming;
    const wrapped = function onIncoming(chatKey, entry = null) {
      const cur = proto[PATCH_KEY];
      if (cur && typeof cur.veto === 'function') {
        let hit = null;
        try { hit = cur.veto(this, chatKey, entry); }
        catch (error) { logger.warn(PLUGIN_ID, `拦截判定失败（本次放行）：${error?.message ?? error}`); }

        if (hit) {
          // 复刻核心"未触发"那条路径：标已读 + 通知界面，然后**不调用原方法**。
          // 原方法一旦跑到，就会按档位判定甚至排唤醒 —— 那就挡不住了。
          try {
            if (typeof this?.store?.markEntryRead === 'function') this.store.markEntryRead(chatKey, entry.id);
            if (typeof this?.emit === 'function') this.emit('chat-update', chatKey);
          } catch (error) {
            logger.warn(PLUGIN_ID, `拦截后标已读失败：${error?.message ?? error}`);
          }
          stats.blocked++;
          stats.lastHit = hit.word;
          stats.lastAt = Date.now();
          logger.info(PLUGIN_ID, `${chatKey} 已拦截（命中「${hit.word}」）：不予理会，未触发会话`);
          return;
        }
      }
      return original.call(this, chatKey, entry);
    };
    rec = { original, wrapped, veto: null };
    proto[PATCH_KEY] = rec;
    proto.onIncoming = wrapped;
  }
  rec.veto = veto;
  return true;
}

/** 摘钩子：只在确认当前 onIncoming 还是我们那只时才还原。 */
function uninstall() {
  const proto = Orchestrator?.prototype;
  const rec = proto?.[PATCH_KEY];
  if (!rec) return;
  rec.veto = null;
  if (proto.onIncoming === rec.wrapped) proto.onIncoming = rec.original;
  delete proto[PATCH_KEY];
}

/** 自测用。 */
export const internals = { DEFAULT_WORDS, matchBlocked, isDirectedAtBot, redactLine, stats, install, uninstall };
