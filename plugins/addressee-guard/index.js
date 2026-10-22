// 点名判定（确定性型 / plugins/，纯 hooks）
//
// 解决什么：群友明明在叫别人（@ 别人、喊别人名字、聊第三方、"你/他"其实指别人），
// 机器人却当成在叫自己 —— 抢话、答非所问、用「我在 / 叫我吗」开场。
//
// 为什么是插件而不是改核心：核心的档位判定（src/prompt.js resolveContextTier）只回答
// "这一轮要不要参与"，它没有"这句话在叫谁"的概念。谁被喊了名字是**确定性知识**，
// 属于可插拔能力 —— 关掉本插件，聊天照常，只是模型又可能自作多情。
//
// 机制（两个钩子配合，另加一段常驻规则）：
//   before-context       拆本轮触发批，逐条算出「呼叫对象」，暂存（按 sessionId 对齐）
//   before-llm-messages  把判定结论追加到请求**末尾**（不动 system 前缀 → 前缀缓存不失效）
//   prompt.sections      把"没被点名≠被点名"的原则常驻进系统提示词（plugin.json）
//
// ── 改这里之前请先确认仍然成立的事实（读源码确证，2026-09 本 build）────────────
//   · src/app.js:886-892 入库时就算好 atMe：**有 @ 段就以 @ 段的 QQ 号为准**，
//     没有 @ 段才回落文本匹配。所以 `atMe===false 且 atNames 非空` == "这条 @ 的是别人"，
//     这是本插件最可靠的硬信号（同名不同人也不会错）。
//   · atNames 是**渲染后的 @ 原文**（`@李四(QQ:10002)` / `@李四` / `@全体成员`），
//     不是 QQ 号数组；QQ 号只在有 speaker-identity 那类 message.inline-at-normalize
//     提供者时才带括号。（src/onebot.js:429-444）
//   · 引用被渲染进正文：`[引用 张三(QQ:10001)：原文]`（src/onebot.js:458-477）。
//     消息条目**没有** reply 字段（src/app.js:901 没传），引用信息只在正文里。
//   · 机器人自己的存档条目 self===true、senderId==='self'（src/store.js:113-131）。
//   · 钩子 ctx 没有 onebot/sender：拿不到实时昵称，所以自报名用
//     persona.botName / persona.selfNickname / 本插件的别名设置（src/orchestrator.js:762-770）。
//   · 钩子有 5 秒硬超时（src/skills/manager.js:22）—— 本文件全程本地计算，
//     不联网、不调模型、不读大文件。

import { getConfig } from '../../src/config.js';

/** 出厂默认值（与 plugin.json 的 settings 保持一致）。 */
const DEFAULTS = {
  enabled: true,
  announceCalled: true,
  similarNameCheck: true,
  pronounCheck: true,
  botAliases: '',
  genericTerms: 'AI、人工智能、机器人、机宝、助手、小助手、bot',
  maxMessages: 8,
  memberScan: 40,
  strictTone: true,
  debugLog: false
};

/** 一轮最多看多少条（防止有人刷屏时把钩子拖长）。 */
const MAX_SCAN = 20;
/** 太短的"名字"（单字）不参与匹配：中文单字命中率太高，全是误报。 */
const MIN_NAME_LEN = 2;

let api = null;
/** 本轮触发批：sessionId/chatKey → { chatKey, entries }（before-context 存，before-llm-messages 取）。 */
const pending = new Map();

function settings() {
  const raw = (api && typeof api.config === 'function' ? api.config() : null) || {};
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  out.genericTermsList = splitList(out.genericTerms).filter((t) => t.length >= MIN_NAME_LEN);
  return out;
}

function configSafe() {
  try { return getConfig() || {}; } catch { return {}; }
}

// ── 文本小工具 ────────────────────────────────────────────────────────────

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 逗号/顿号/分号/竖线/空白分隔的列表。 */
function splitList(text) {
  return String(text || '')
    .split(/[,，、;；|/\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 文本里是否出现了这个名字/词。
 *
 * 与 plugins/member-aliases 同口径（保持一致，别让两处判定打架）：
 *   · 纯中文或长度 ≥3 的：直接包含判断 —— 中文不用空格分词，用"词边界"反而
 *     会把「小鲸鱼今天怎么没来」判成没命中。
 *   · 含 ASCII 字母数字的短词（"ai"、"99"）：只在 ASCII 边界上判断，
 *     否则 "99" 会命中 "1990"，"ai" 会命中 "said"。
 */
function textHasName(text, name) {
  const t = String(text || '');
  const a = String(name || '').trim();
  if (!a || !t || a.length < MIN_NAME_LEN) return false;
  const hasAsciiAlnum = /[0-9A-Za-z]/.test(a);
  if (!hasAsciiAlnum || a.length >= 3) return t.includes(a);
  try {
    return new RegExp(`(?<![0-9A-Za-z])${escapeRe(a)}(?![0-9A-Za-z])`, 'i').test(t);
  } catch {
    return t.includes(a);
  }
}

/** `@李四(QQ:10002)` → `李四`。 */
function stripAt(s) {
  return String(s || '')
    .replace(/^@/, '')
    .replace(/\(QQ:\d+\)$/i, '')
    .trim();
}

/**
 * 正文里的引用：`[引用 张三(QQ:10001)：原文]` → { name, uid, rest }。
 * rest = 去掉引用片段后的正文（引用原文不参与"喊谁名字"的判定，否则引用里
 * 提到的名字会被当成你正在喊的人）。
 */
function parseQuote(text) {
  const t = String(text || '');
  const m = /[\[【]引用\s*([^\]】]{0,120}?)[\]】]/.exec(t);
  if (!m) return null;
  let inner = m[1];
  // 先把 (QQ:数字) 摘出去：否则下面找"名字：原文"的分隔冒号会切在 "(QQ:" 里，
  // 名字会变成「李四(QQ」。
  const qm = /\(QQ:(\d+)\)/i.exec(inner);
  const uid = String(qm?.[1] || '');
  if (qm) inner = inner.slice(0, qm.index) + inner.slice(qm.index + qm[0].length);
  const qi = inner.search(/[：:]/);
  const head = (qi >= 0 ? inner.slice(0, qi) : inner).trim();
  // 「[引用消息]」这类解析失败的占位符：名字留空，只说"在回复别人"。
  const name = (qi >= 0 || uid) ? head : '';
  return { name, uid, rest: t.replace(m[0], ' ') };
}

/**
 * 是不是"点名式"叫法（而不是顺口提到）。
 * 命中位置要么在开头/标点之后，要么后面紧跟标点或"你/请/来/看/帮…"。
 * 只是被提到（"我昨天和小明吃饭"）不算叫。
 */
function isVocative(text, name) {
  const t = String(text || '');
  if (!t || !name || String(name).length < MIN_NAME_LEN) return false;
  try {
    const re = new RegExp(
      `(^|[\\s，,。.!！?？、~～:：;；@])${escapeRe(name)}`
      + `(?=$|[\\s，,。.!！?？、~～:：;；]|你|您|请|来|看|帮|说|在吗|在不在|呢|吗|呀|啊|哈|快|别|好|下|过来|过来看)`,
      'i'
    );
    return re.test(t);
  } catch {
    return false;
  }
}

/** 两个名字共享的字符（用于"名字跟你像"的判断）。 */
function sharedChars(a, b) {
  const set = new Set([...String(a || '')]);
  return [...new Set([...String(b || '')])].filter((c) => set.has(c));
}

/** 老/大/小/阿 这类通用前缀，单独撞上不算"名字像"。 */
const COMMON_AFFIX = new Set(['小', '老', '大', '阿', '神', '萌', '的', '是']);

/** 「小亮」vs「小鲸鱼」：包含关系，或共享 ≥2 个字（或同长度且共享一个实义字）。 */
function looksLike(selfN, name) {
  const n = String(name || '').trim();
  if (n.length < MIN_NAME_LEN) return false;
  return selfN.some((x) => {
    const a = String(x || '').trim();
    if (a.length < MIN_NAME_LEN) return false;
    if (a.includes(n) || n.includes(a)) return true;
    const same = sharedChars(a, n);
    if (same.length >= 2) return true;
    return a.length === n.length && same.some((c) => !COMMON_AFFIX.has(c));
  });
}

// ── 名册：我自己的名字 / 群里的人都叫什么 ────────────────────────────────

/**
 * 机器人自称。只有 persona.botName / persona.selfNickname 是权威的（会话级人设
 * 结构上不能改名字，见 src/config.js:190-194），其余靠用户在本插件里补别名 ——
 * 钩子里拿不到 onebot 的实时群昵称，所以别名设置是补齐同音/爱称的正规手段。
 */
function selfNames(cfg, s) {
  const list = [
    cfg?.persona?.botName,
    cfg?.persona?.selfNickname,
    ...splitList(s.botAliases)
  ];
  return [...new Set(list.map((x) => String(x || '').trim()).filter((x) => x.length >= MIN_NAME_LEN))];
}

/**
 * 本群成员名册：uid → 名字集合。
 * 三个来源都试：最近发言过的人（含昵称/群名片）、管理员备注、外号表（插件 member-aliases）。
 * 全失败也只是判定保守一点，绝不影响对话。
 */
function collectMembers(ctx, chatKey, s, selfN) {
  const cap = Math.max(4, Number(s.memberScan) || 40);
  const map = new Map();
  const add = (uid, name) => {
    const u = String(uid || '').trim();
    const n = String(name || '').trim();
    if (!u || u === 'self' || !n || n.length < MIN_NAME_LEN || n.length > 24) return;
    if (!map.has(u)) map.set(u, new Set());
    map.get(u).add(n);
  };

  try {
    const list = ctx?.store?.activeMembers?.(chatKey, cap) || [];
    for (const m of list) add(m?.userId, m?.name);
  } catch { /* 名册不全没关系 */ }

  try {
    const notes = configSafe()?.memberNotes || {};
    let i = 0;
    for (const [uid, name] of Object.entries(notes)) {
      if (i >= cap) break;
      i += 1;
      add(uid, name);
    }
  } catch { /* 同上 */ }

  try {
    const r = api?.capability?.('member.alias-list', {});
    const all = r && typeof r === 'object' && r.all && typeof r.all === 'object' ? r.all : null;
    if (all) {
      let i = 0;
      for (const [uid, names] of Object.entries(all)) {
        if (i >= cap) break;
        i += 1;
        for (const n of (Array.isArray(names) ? names : [names])) add(uid, n);
      }
    }
  } catch { /* 外号插件没开就算了 */ }

  // 自己也在名册里的话（备注/外号被别人记成我的名字）→ 记下来，同名时给模型一个提醒
  const sameNameSet = new Set();
  for (const names of map.values()) {
    for (const n of names) if (selfN.includes(n)) sameNameSet.add(n);
  }
  return { map, sameNameSet };
}

// ── 判定 ──────────────────────────────────────────────────────────────────

/**
 * 一条消息在叫谁。
 * @returns {{kind:string, why:string, label:string}}
 *   kind: me（在叫你）| other-at（@ 了别人）| all（@全体）| other-call（喊别人名字）
 *        | similar（名字像但不是你）| mention（提到别人）| quote-other（在回复别人）
 *        | generic（泛称）| pronoun（你/他指别人）| none（没点人）
 */
function analyze(entry, env, s) {
  const text = String(entry?.text || '');
  const label = `#${entry?.id ?? '?'} ${String(entry?.senderName || entry?.senderId || '群友')}`;
  const ats = (Array.isArray(entry?.atNames) ? entry.atNames : []).map((x) => String(x || '')).filter(Boolean);
  const nameHint = env.selfN.length ? `（你的名字：${env.selfN.join('、')}）` : '';

  // ① 拍一拍：只有拍到机器人的才会进存档
  if (entry?.isPoke) return { kind: 'me', why: '拍一拍拍的是你', label };

  // ② @ 段：框架按 QQ 号判定，最可靠
  if (entry?.atMe === true) return { kind: 'me', why: '@ 了你', label };
  const atOthers = ats.filter((t) => t !== '@全体成员').map(stripAt).filter(Boolean);
  if (atOthers.length) return { kind: 'other-at', why: `@ 的是「${atOthers.join('、')}」，不是你`, label };
  if (ats.includes('@全体成员')) return { kind: 'all', why: '@全体成员，没有单独点你', label };

  // ③ 引用：`[引用 张三：…]` —— 这条是对被引用的人说的
  const quote = parseQuote(text);
  const body = quote ? quote.rest : text;
  if (quote && quote.name && env.selfN.some((n) => quote.name === n || textHasName(quote.name, n))) {
    return { kind: 'me', why: '在回复你', label };
  }

  // ④ 老存档（atMe 为 null）兜底：正文里 @ 了你的名字
  if (entry?.atMe === null || entry?.atMe === undefined) {
    const hit = env.selfN.find((n) => textHasName(body, `@${n}`));
    if (hit) return { kind: 'me', why: `正文 @ 了你的名字（${hit}）`, label };
  }

  // ⑤ 正文里出现你的名字
  const selfHit = env.selfN.find((n) => textHasName(body, n));
  if (selfHit) {
    const sameName = env.sameNameSet.has(selfHit) ? '（注意：群里还有人用这个名字，也可能是在叫他）' : '';
    const way = isVocative(body, selfHit) ? `叫了你的名字（${selfHit}）` : `正文提到了你（${selfHit}）`;
    return { kind: 'me', why: `${way}${sameName}`, label };
  }

  // ⑥ 有人在喊别人
  const hits = [];
  for (const [uid, names] of env.members) {
    for (const n of names) {
      if (!textHasName(body, n)) continue;
      hits.push({ uid, name: n, direct: isVocative(body, n) });
    }
  }
  const direct = hits.find((h) => h.direct);
  if (direct) {
    // 被喊的那个人的名字跟你像（"鲸鱼" vs "小鲸鱼"）：明说"那是他"，别让模型自作多情。
    const near = s.similarNameCheck !== false && looksLike(env.selfN, direct.name);
    const why = near
      ? `在叫「${direct.name}」—— 跟你的名字有点像，但那是他${nameHint}`
      : `在叫「${direct.name}」${nameHint}`;
    return { kind: 'other-call', why, label };
  }
  if (s.similarNameCheck !== false) {
    const near = hits.find((h) => looksLike(env.selfN, h.name));
    if (near) return { kind: 'similar', why: `喊的是「${near.name}」，跟你的名字有点像但不是你${nameHint}`, label };
  }
  if (hits.length) return { kind: 'mention', why: `提到了「${hits[0].name}」，不是在叫他`, label };

  // ⑦ 在回复别人
  if (quote) return { kind: 'quote-other', why: quote.name ? `在回复「${quote.name}」，不是回复你` : '在回复别人的消息', label };

  // ⑧ 泛称（AI / 机器人 / 助手…）
  const generic = (s.genericTermsList || []).find((t) => textHasName(body, t));
  if (generic) {
    const tail = env.prevIsSelf
      ? '—— 不过你刚发过言，也可能是在说你，只有确实像在问你就接'
      : '，没有点你的名字';
    return { kind: 'generic', why: `「${generic}」是泛称${tail}`, label };
  }

  // ⑨ 代词：「他/她」指第三方；「你」看引用与上一句是谁说的
  if (s.pronounCheck !== false) {
    const m = /(你们|他们|她们|人家|你|您|他|她)/.exec(body);
    if (m) {
      const p = m[1];
      if (p === '你' || p === '您') {
        if (env.prevIsSelf) return { kind: 'pronoun', why: '「你」有可能指你（你刚说过话），也可能指别人 —— 没点名就别当成被叫', label };
        if (env.prevSpeaker) return { kind: 'pronoun', why: `「你」多半指上一条说话的「${env.prevSpeaker}」，不是你`, label };
        return { kind: 'pronoun', why: '「你」没有明确指向你', label };
      }
      return { kind: 'pronoun', why: `「${p}」指第三方，不是你`, label };
    }
  }

  return { kind: 'none', why: '没点任何人', label };
}

/** 把逐条判定拼成给模型看的块（追加在请求末尾）。 */
function buildBlock(items, env, s) {
  const called = items.filter((it) => it.kind === 'me');
  const names = env.selfN.length ? env.selfN.join('、') : '（未配置）';
  const head = called.length
    ? `【点名判定】本轮 ${items.length} 条新消息，其中 ${called.length} 条是在叫你（你的名字：${names}）。`
    : `【点名判定】本轮 ${items.length} 条新消息，没有一条是在叫你（你的名字：${names}）。`;

  const lines = items.map((it) => `· ${it.label}：${it.why}${it.kind === 'me' ? '　← 这条是叫你的' : ''}`);

  const tail = [];
  if (called.length && s.announceCalled !== false) {
    tail.push('处理要求：标了「叫你的」那几条，按平常那样回应即可；其余不用当自己被点名。');
  } else if (!called.length) {
    tail.push(s.strictTone === false
      ? '处理要求：这些都不是在叫你。想接话就自然接，不想接就安静看着。'
      : '处理要求：这些都不是在叫你 —— 可以围观、也可以有感而发地接话，但不要用「我在 / 叫我吗 / 怎么了 / 有什么事」这种被点到的口吻，也不要去回答明显在问别人的问题。');
  }
  return [head, ...lines, ...tail].join('\n');
}

/** 追加到请求末尾（最后一条 user 消息的尾部）：不动 system 前缀，缓存不失效。 */
function appendTail(messages, text) {
  if (!Array.isArray(messages) || !text) return false;
  const block = `\n\n${String(text).trim()}`;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') { m.content += block; return true; }
    if (Array.isArray(m.content)) { m.content.push({ type: 'text', text: block }); return true; }
  }
  messages.push({ role: 'user', content: block.trim() });
  return true;
}

// ── 钩子 ──────────────────────────────────────────────────────────────────

export const hooks = {
  /** 记下本轮触发批（判定要在 before-llm-messages 里做，那里才有 messages）。 */
  async 'before-context'(ctx = {}) {
    try {
      if (settings().enabled === false) return;
      if (String(ctx?.kind || 'group') !== 'group') return;   // 私聊里每句都是对你说的，不用判
      const entries = (Array.isArray(ctx?.triggerEntries) ? ctx.triggerEntries : [])
        .filter((e) => e && !e.self)
        .slice(-MAX_SCAN)
        .map((e) => ({
          id: e.id,
          ts: e.ts,
          senderId: e.senderId,
          senderName: e.senderName,
          text: e.text,
          isPoke: e.isPoke,
          atMe: e.atMe,
          atNames: Array.isArray(e.atNames) ? e.atNames.slice(0, 10) : []
        }));
      if (!entries.length) return;
      const key = String(ctx?.sessionId || ctx?.chatKey || '');
      pending.set(key, { chatKey: String(ctx?.chatKey || ''), entries });
      if (pending.size > 50) pending.delete(pending.keys().next().value);
    } catch { /* 判定失败只是少几行提示 */ }
  },

  /** 算出结论，追加到本轮请求末尾。 */
  async 'before-llm-messages'(ctx = {}) {
    const s = settings();
    if (s.enabled === false) return;
    const key = String(ctx?.sessionId || ctx?.chatKey || '');
    const job = pending.get(key);
    pending.delete(key);
    if (!job || !job.entries.length) return;

    try {
      const cfg = configSafe();
      const selfN = selfNames(cfg, s);
      const { map: members, sameNameSet } = collectMembers(ctx, job.chatKey, s, selfN);

      // 上一句是谁说的：判断「你」指谁时要用
      let prevIsSelf = false;
      let prevSpeaker = '';
      try {
        const recent = ctx?.store?.recent?.(job.chatKey, { limit: 12 }) || [];
        const firstTs = job.entries[0]?.ts || 0;
        const before = recent.filter((m) => (Number(m?.ts) || 0) < firstTs);
        const last = before[before.length - 1];
        if (last) prevIsSelf = Boolean(last.self);
        if (last && !last.self) prevSpeaker = String(last.senderName || '');
      } catch { /* 拿不到上下文就少一层判断 */ }

      const env = { selfN, selfId: String(cfg?.onebot?.selfId || ''), members, sameNameSet, prevIsSelf, prevSpeaker };
      const max = Math.max(1, Number(s.maxMessages) || 8);
      const items = job.entries.slice(-max).map((e) => analyze(e, env, s));
      if (!items.length) return;

      const block = buildBlock(items, env, s);
      const ok = appendTail(ctx?.messages, block);
      if (s.debugLog) api?.log?.(`点名判定${ok ? '' : '（注入失败）'}：${items.map((it) => `${it.label}=${it.kind}`).join(' | ')}`);
    } catch (error) {
      // 判定出问题绝不能影响正常回话
      try { api?.warn?.(`点名判定失败（已忽略）：${error?.message ?? error}`); } catch { /* 日志失败也忽略 */ }
    }
  }
};

// ── 能力（自检 / 给别的扩展用，纯函数，不改状态） ────────────────────────

export const providers = {
  /**
   * 单条文本的判定自检：api.capability('addressee.locate', { text, atMe, atNames, senderName, members })
   * members 形如 { "10001": ["张三", "三哥"] }，不给就是空名册。
   */
  'addressee.locate': (args = {}) => {
    const s = settings();
    const cfg = configSafe();
    const env = {
      selfN: selfNames(cfg, s),
      selfId: String(cfg?.onebot?.selfId || ''),
      members: new Map(),
      sameNameSet: new Set(),
      prevIsSelf: Boolean(args?.prevIsSelf),
      prevSpeaker: String(args?.prevSpeaker || '')
    };
    try {
      const raw = args?.members && typeof args.members === 'object' ? args.members : {};
      for (const [uid, names] of Object.entries(raw)) {
        env.members.set(String(uid), new Set((Array.isArray(names) ? names : [names]).map((n) => String(n)).filter(Boolean)));
      }
    } catch { /* 名册非法就空着 */ }
    const entry = {
      id: args?.id ?? 0,
      ts: Date.now(),
      senderId: String(args?.senderId || ''),
      senderName: String(args?.senderName || '群友'),
      text: String(args?.text || ''),
      atMe: args?.atMe === undefined ? null : args.atMe,
      atNames: Array.isArray(args?.atNames) ? args.atNames : [],
      isPoke: Boolean(args?.isPoke)
    };
    try {
      const it = analyze(entry, env, s);
      return { ok: true, kind: it.kind, why: it.why, label: it.label, selfNames: env.selfN, memberCount: env.members.size };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }
};

// ── 生命周期 ──────────────────────────────────────────────────────────────

export function setup(a) {
  api = a;
}

export function activate() {
  try {
    const cfg = configSafe();
    const names = selfNames(cfg, settings());
    api?.log?.(`点名判定已启用：你的名字 = ${names.join('、') || '（未取到，建议在设置里补别名）'}`);
  } catch { /* 日志失败无妨 */ }
}

export function deactivate() {
  pending.clear();
}

export function available() {
  return settings().enabled !== false;
}
