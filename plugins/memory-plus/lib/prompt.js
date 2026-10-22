// 印象档案 · 提示词层
//
// 这里只干一件核心改造：**把核心拼出来的【记忆】段换掉**。
//
// 为什么必须换（而不是"再追加一段"）：
//   核心的 memory.formatForPrompt 每人固定只给最近 3 条（memory.js:467 的
//   `impressions.slice(-3)`），段尾还有【新加入成员】的重复注入。只追加等于
//   让模型同时看到两套口径，且旧的"只给三条"那份仍然在抢注意力。
//   换掉之后：长期/短期分层、约定类优先用原文、标签速览全都由本插件说了算，
//   而长期印象的**正文仍然来自核心记忆**（只是取法与排序被我们接管）。
//
// 注入形态（越靠前的越"硬"，也越贵，所以都带上限）：
//   【记忆】
//   【长期印象 · 稳定，可直接引用】       ← 约定类第一条永远在这里、用原文
//   【短期印象 · 新形成，可能不准】       ← 带提及次数与过期天数
//   【印象标签 · 速览】                  ← 人多时只给标签，要看原话让模型自己调工具
//   （一行工具提示）
//
// ⚠️ 本文件**刻意不 import 其它 lib 模块**：index.js 用带 ?t= 的动态 import 加载
//    lib/*，让改了代码后热重载能立刻生效（静态子模块 import 会被 Node 的 ESM URL
//    缓存住，改了不生效 —— 本项目的 knowledge-hub-panel 也是用 ?t= 绕开的）。
//    所以这里的两个判定函数由调用方（index.js）注入。

const HEADER = '【记忆】';
const NOOP_APPT = () => false;
const NOOP_META = () => null;

/** 把毫秒时间戳格式化成 2026-10-13 这样的短日期。 */
function day(ts) {
  const d = new Date(Number(ts) || 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function daysLeft(createdAt, ttlDays) {
  const ttl = Math.max(1, Number(ttlDays) || 14) * 86400000;
  const left = Math.ceil((Number(createdAt) + ttl - Date.now()) / 86400000);
  return Math.max(0, left);
}

/**
 * 给一条长期印象定"重要性"排序键。
 * 约定 > 提及次数 > 新近度。目的就是替掉核心的"固定取最近三条"。
 */
function longScore(item, meta, isAppointment) {
  const appointment = (meta?.kind === 'appointment') || isAppointment(item.content);
  const hits = Number(meta?.hits) || 0;
  return (appointment ? 1e12 : 0) + hits * 1e7 + (Number(item.createdAt) || 0) / 1000;
}

/**
 * 生成一整段【记忆】文本。
 *
 * @param {object} args
 * @param {Array} args.members       长期印象成员：[{userId,name,impressions:[{content,createdAt}]}]
 * @param {number[]} args.shortStats 本会话（chatKey）的短期印象来源
 * @param {object} args.shortByMember { [userId]: { name, short: [...], labels: [...] } }
 * @param {Set<string>} args.relevantUserIds 本轮相关的人（窗口里出现过的）
 * @param {object} args.cfg          本插件配置
 * @param {number} args.expireTtlDays 短期印象 TTL（天）
 * @returns {{ text: string, replaced: boolean, members: number, longItems: number, shortItems: number }}
 */
export function buildMemoryBlock({
  chatKey = '',
  members = [],
  shortByMember = {},
  relevantUserIds = null,
  cfg = {},
  helpers = {}
} = {}) {
  const looksLikeAppointment = typeof helpers.looksLikeAppointment === 'function' ? helpers.looksLikeAppointment : NOOP_APPT;
  const getLongMeta = typeof helpers.getLongMeta === 'function' ? helpers.getLongMeta : NOOP_META;
  const ttlDays = Math.max(1, Number(cfg.shortTtlDays) || 14);
  const maxLong = Math.max(1, Number(cfg.longPerMember) || 8);
  const maxShort = Math.max(1, Number(cfg.shortPerMember) || 4);
  const maxLabels = Math.max(1, Number(cfg.labelsPerMember) || 6);
  const forceFullAppointment = cfg.appointmentAlwaysFull !== false;

  const filter = relevantUserIds && relevantUserIds.size ? relevantUserIds : null;

  // ── 组装每个人的条目 ──
  const people = [];
  const seen = new Set();

  const pushPerson = (userId, name) => {
    const uid = String(userId || '');
    if (seen.has(uid)) return null;
    seen.add(uid);
    const person = { userId: uid, name: String(name || uid || '某人'), long: [], short: [], labels: [] };
    people.push(person);
    return person;
  };

  for (const m of members || []) {
    const uid = String(m.userId || '');
    if (filter && uid && !filter.has(uid)) continue;
    const person = pushPerson(uid, m.name);
    if (!person) continue;
    for (const e of m.impressions || []) {
      const content = String(e?.content || '').trim();
      if (!content) continue;
      person.long.push({ content, createdAt: Number(e?.createdAt) || 0 });
    }
  }

  // 只有短期印象、还没有长期印象的人也要出现（否则"新认识的人"永远不进提示词）
  for (const [uid, entry] of Object.entries(shortByMember || {})) {
    if (filter && uid && !filter.has(uid)) continue;
    const person = seen.has(String(uid)) ? people.find((p) => p.userId === String(uid)) : pushPerson(uid, entry?.name);
    if (!person) continue;
    for (const s of entry?.short || []) {
      if (s.promotedAt) continue;
      person.short.push(s);
    }
    person.labels = (entry?.labels || []).map((l) => l.tag).filter(Boolean).slice(0, maxLabels);
  }
  if (!people.length) return { text: '', replaced: false, members: 0, longItems: 0, shortItems: 0 };

  // ── 排序与截断 ──
  for (const p of people) {
    // 长期印象：约定类 > 提及次数 > 新近度。这就是"不再固定取最近三条"的落点。
    p.long = p.long
      .map((it) => ({ ...it, _score: longScore(it, getLongMeta(chatKey, it.content), looksLikeAppointment) }))
      .sort((a, b) => b._score - a._score);
    p.short.sort((a, b) => (Number(b.hits) || 0) - (Number(a.hits) || 0) || (Number(b.lastHitAt) || 0) - (Number(a.lastHitAt) || 0));
  }

  const manyPeople = people.length > Math.max(1, Number(cfg.injectCompactThreshold) || 6);
  const promoteMin = Math.max(1, Number(cfg.promoteMinHits) || 3);
  const lines = [HEADER];

  // ── 长期记忆 ──
  // 标签优先（用户要求）：某人**已经有标签**时，只给"标签 + 约定原文"，不再堆全文；
  // 正文随时可以用 recall_impression(mode=full) 展开 —— 所以提示词里给了两种模式的提示。
  // 约定类例外：约定被压成标签就等于把"说好的事"弄丢了，永远给原文。
  const labelFirst = cfg.enableLabelFirst !== false;
  const longLines = [];
  let longItems = 0;
  let labelOnlyCount = 0;
  for (const p of people) {
    const all = p.long;
    if (!all.length) continue;
    const appts = all.filter((it) => {
      const meta = getLongMeta(chatKey, it.content) || {};
      return meta.kind === 'appointment' || looksLikeAppointment(it.content);
    });
    const isAppt = (it) => appts.some((a) => a.content === it.content && a.createdAt === it.createdAt);
    const normalCount = all.length - appts.length;
    const hasLabels = p.labels.length > 0;
    const labelOnly = labelFirst && hasLabels && normalCount > 0;
    const picked = labelOnly ? appts.slice(0, maxLong) : all.slice(0, maxLong);
    const rendered = [];
    for (const it of picked) {
      const meta = getLongMeta(chatKey, it.content) || {};
      const hits = Number(meta.hits) || 0;
      const tail = hits > 0 ? `（提及×${hits}）` : '';
      longItems += 1;
      rendered.push(isAppt(it) ? `〔约定·用原文〕${it.content}${tail}` : `${it.content}${tail}`);
    }
    if (labelOnly) {
      labelOnlyCount += 1;
      const hidden = Math.max(0, normalCount - appts.length);
      rendered.push(`标签：${p.labels.slice(0, maxLabels).join(' · ')}`
        + `（另有 ${hidden || normalCount} 条原文没展开；要引用原话、或判断他到底怎么回事，就调 recall_impression 的 mode=full，别按标签硬猜）`);
    }
    if (rendered.length) longLines.push(`- ${p.name}：${rendered.join('；')}`);
  }
  if (longLines.length) {
    lines.push('【长期记忆 · 稳定，可以直接引用】');
    lines.push(...longLines);
  }

  // ── 短期记忆 ──
  const shortLines = [];
  let shortItems = 0;
  for (const p of people) {
    const items = p.short.slice(0, manyPeople ? Math.min(2, maxShort) : maxShort);
    if (!items.length) continue;
    const rendered = items.map((s) => {
      shortItems += 1;
      const isAppt = s.kind === 'appointment' || looksLikeAppointment(s.content);
      const hits = Math.max(0, Number(s.hits) || 0);
      // 提及次数到了阈值 → 明确标出来，让模型"看见"该不该晋升这件事
      const flag = hits >= promoteMin ? '⚑建议晋升：' : '';
      const bits = [];
      if (hits > 0) bits.push(`提及×${hits}`);
      bits.push(`${daysLeft(s.createdAt, ttlDays)} 天后过期`);
      const tail = bits.length ? `（${bits.join('，')}）` : '';
      if (isAppt) return `${flag}〔约定·用原文〕${s.content}${tail}`;
      return `${flag}${s.content}${tail}`;
    });
    shortLines.push(`- ${p.name}：${rendered.join('；')}`);
  }
  if (shortLines.length) {
    lines.push('【短期记忆 · 最近才形成，可能不准，会自动过期】');
    lines.push(...shortLines);
  }

  // ── 标签速览 ──
  const labelLines = [];
  for (const p of people) {
    const fromStore = p.labels.length ? p.labels : [];
    // 长期记忆条数多于上限时，把没进正文的也用标签兜一下（信息不失真到"完全看不见"）
    const tags = fromStore.slice(0, maxLabels);
    if (!tags.length) continue;
    labelLines.push(`- ${p.name}：${tags.join(' · ')}`);
  }
  if (labelLines.length) {
    lines.push('【记忆标签 · 一句话速览】');
    lines.push(...labelLines);
  }

  if (longLines.length === 0 && shortLines.length === 0 && labelLines.length === 0) {
    return { text: '', replaced: false, members: 0, longItems: 0, shortItems: 0 };
  }

  // ⚠️ 实测：模型几乎不会主动记录（200 个会话里 note_impression 被调用 **0 次**）。
  //    原因之一是原来那段说明太长、像注解而不像"规则"。改成简短硬规则，并把记录动作
  //    绑定到具体触发条件上；同时明确"别用 memory_append 记新观察"。
  lines.push('【怎么记 · 每轮都扫一眼】');
  lines.push('- 只要有人透露出**稳定信息**（偏好/雷点/说话习惯/身份关系/近况），就调 **note_impression** 记成短期记忆，'
    + 'kind 选 general/preference/fact/relation；"说好/答应/提醒我"这类一律 kind=appointment 且**用原话**。');
  lines.push('- 同一件事反复出现、已经很稳的，调 **promote_impression** 晋升成长期记忆。');
  lines.push('- **不要用 memory_append 记新观察**（那是核心的老接口，不走短期/晋升这套）。');
  lines.push('- 该不该记、算不算约定拿不准 → 调 **ask_owner** 问主人。'
    + '看记忆：标签档可以直接引用；要原话全文就调 **recall_impression** 的 mode=full，别按标签硬猜。'
    + `${forceFullAppointment ? '约定类一律按原文引用，不许改写细节。' : ''}`);

  return { text: lines.join('\n'), replaced: true, members: people.length, longItems, shortItems, labelOnly: labelOnlyCount };
}

/**
 * 裁剪喂给模型的聊天记录（【已读信息】/【新已读信息】），只保留最近 N 条。
 * 用户反馈：聊天记录太长会把上下文塞满、把人设带偏。
 *
 * ⚠️ 这里**绝不在块内插任何自己的行**（踩过一个狠坑）：
 *   session-memory-keeper 的核验机制会逐行核对块内每一行能否在存档里找到，
 *   找不到就把那一行替换成「[旧历史格式无法核验，本轮停用]」。我原来插的那行
 *   "（更早的 N 条已省略…）" 就被换成了这句吓人的文案 —— 功能没坏，但界面看着像坏了。
 *   所以裁剪只做"删掉更早的行"，说明文字用 note 返回，由调用方放到块**外面**。
 * 另外：行首锚定，且不用 /m（`$` 在 /m 下会变成行尾，非贪婪匹配会提前收尾）。
 * @returns {{text:string, trimmed:number, kept:number, note:string}}
 */
export function trimHistorySection(text, limit) {
  const n = Math.max(0, Number(limit) || 0);
  if (!n || typeof text !== 'string' || !text) return { text, trimmed: 0, kept: 0, note: '' };
  let trimmed = 0;
  let kept = 0;
  const out = text.replace(/(^|\n)【(已读信息|新已读信息)】([\s\S]*?)(?=\n\n【|$)/g, (whole, lead, title, body) => {
    const lines = String(body).split('\n');
    const head = lines[0] || '';                       // "以下是…：" 说明句
    const items = lines.slice(1).filter((l) => l.trim());
    if (items.length <= n) { kept += items.length; return whole; }
    const keep = items.slice(-n);
    const cut = items.length - keep.length;
    trimmed += cut;
    kept += keep.length;
    // 只保留头部说明句 + 最近 N 行，块内不掺任何自己的文字
    return `${lead}【${title}】${head}\n${keep.join('\n')}`;
  });
  const note = trimmed
    ? `本轮已读记录只带了最近 ${n} 条（更早的 ${trimmed} 条已省略；要翻旧账就调 search_archive 按时间/发送人/关键词查，或 get_recent_messages 往前翻）`
    : '';
  return { text: out, trimmed, kept, note };
}

/**
 * 裁剪系统提示里整段的技能规则（只认渲染器给的分段标记 "▸ 标题"）。
 * 核心规则段（安全规则/工具协议/人设…）不以 ▸ 开头，**永远不会被裁**。
 * @returns {{text:string, removed:string[]}}
 */
export function trimSystemSections(text, keywords) {
  const keys = (Array.isArray(keywords) ? keywords : String(keywords || '').split(/\r?\n/))
    .map((s) => String(s || '').trim()).filter(Boolean);
  if (!keys.length || typeof text !== 'string' || !text) return { text, removed: [] };
  const out = [];
  const removed = [];
  let skipping = false;
  for (const line of String(text).split('\n')) {
    if (line.startsWith('▸ ')) {
      const title = line.slice(2).trim();
      if (keys.some((k) => title.includes(k))) {
        removed.push(title);
        skipping = true;
        continue;
      }
      skipping = false;
    }
    if (skipping) continue;      // 丢掉这一段的所有内容行，直到下一个 ▸
    out.push(line);
  }
  return { text: out.join('\n'), removed };
}

/** 粗略量一下提示词体积（面板显示用）。 */
export function measurePrompt(text) {
  return String(text || '').length;
}

/**
 * 把【记忆】段替换掉。
 *
 * ⚠️ 必须**只认核心那一段**，不能随便找"【记忆】"四个字（踩过坑）：
 *   人设文本里会出现「我只看得到聊天记录、【记忆】…」，核心的记忆规则里也有
 *   「…会自动出现在【记忆】里」。按裸字符串找的话，会把我们的块插进人设中间 ——
 *   既打乱人设（实测会让群聊里的人设明显跑偏），又**没换掉**真正的记忆段。
 *   所以这里只认核心那段独一无二的签名：行首的【记忆】紧跟着【对群友的印象】。
 *
 * 三种情况：
 *   1. 有核心记忆块 → 整段替换（含它那行【对群友的印象】）
 *   2. 没有（该会话还没有任何印象）→ 插在行首的【已读信息】之前
 *   3. 都没有 → 不动（不冒险改结构）
 */
const CORE_MEMORY_RE = /(^|\n)【记忆】\n【对群友的印象】[\s\S]*?(?=\n\n【|$)/;

export function replaceMemorySection(text, block) {
  if (typeof text !== 'string' || !text || !block) return text;
  // ⚠️ 这里**不能**用 /m 标志：开了 m 之后 `$` 变成"行尾"，非贪婪的 *? 会在
  //    第一行行末就收尾，只吃掉标题那一行（踩过）。用 (^|\n) 代替行首锚定。
  if (CORE_MEMORY_RE.test(text)) {
    return text.replace(CORE_MEMORY_RE, (m, lead) => `${lead}${block}`);
  }
  // 只认行首的【已读信息】；句子中间的提及（"扫一眼【已读信息】…"）不算
  if (/(^|\n)【已读信息】/.test(text)) {
    return text.replace(/(^|\n)【已读信息】/, (m, p1) => `${p1}${block}\n\n【已读信息】`);
  }
  return text;
}

/** 对 OpenAI messages 数组原地做替换。 */
export function applyToMessages(messages, block) {
  if (!Array.isArray(messages) || !block) return false;
  let touched = false;
  for (const msg of messages) {
    if (!msg) continue;
    if (typeof msg.content === 'string') {
      const next = replaceMemorySection(msg.content, block);
      if (next !== msg.content) { msg.content = next; touched = true; }
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part && part.type === 'text' && typeof part.text === 'string') {
          const next = replaceMemorySection(part.text, block);
          if (next !== part.text) { part.text = next; touched = true; }
        }
      }
    }
  }
  return touched;
}

/**
 * 待裁决问题块：主人回答了模型之前问的记忆判定问题时，把"问题 + 主人的原话"
 * 追加到请求末尾（不动系统前缀，缓存不受影响），让模型当场落定。
 */
export function buildPendingAnswerBlock(questions = []) {
  const answered = questions.filter((q) => q && q.status === 'answered' && q.answer);
  if (!answered.length) return '';
  const lines = ['【记忆判定 · 主人已经回答你了】'];
  for (const q of answered.slice(0, 3)) {
    lines.push(`· 你问的：「${q.question}」`);
    lines.push(`  主人答：「${q.answer}」`);
    lines.push(`  → 按主人的意思落定：确认记下就 note_impression / promote_impression，否定就 drop_impression；`
      + `落定后必须调 resolve_owner_answer 报告结论（问题 id：${q.id}）。`);
  }
  return lines.join('\n');
}

/** 待主人裁决的问题块（给主人私聊里用：提醒他模型在等回答）。 */
export function buildAskReminderBlock(questions = []) {
  const pending = questions.filter((q) => q && q.status === 'pending');
  if (!pending.length) return '';
  const lines = ['【你在等主人回答的记忆判定问题】'];
  for (const q of pending.slice(0, 3)) {
    lines.push(`· （${day(q.askedAt)} 问的）${q.question}`);
  }
  lines.push('主人这一轮如果回答了，就按他的意思落定，并调 resolve_owner_answer 报告结论。不要重复追问同一个问题。');
  return lines.join('\n');
}

export { day, daysLeft };
