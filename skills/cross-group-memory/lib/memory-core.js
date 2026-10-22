/**
 * 跨群记忆 —— 核心读写库
 *
 * ══════════════════════════════════════════════════════════════════════
 * 这个库只做三件事：读消息、写印象、建跨群索引。
 * 所有落盘都走宿主自带的 ctx.memory，插件自己**不碰文件系统**。
 * ══════════════════════════════════════════════════════════════════════
 *
 * 宿主的真实接口（已核对 src/memory.js 与 src/store.js 源码，不是猜的）：
 *
 *   ctx.store.recent(chatKey, { limit, offset, includeSelf })
 *     → [{ mid, ts, senderId, senderName, text, reply, media, isPoke, atMe, ... }]
 *       · senderId = QQ 号字符串；机器人自己发的条目 self=true
 *
 *   ctx.store.activeMembers(chatKey, limit)
 *     → [{ userId, name, lastTs, count }]   ← 现成的成员聚合
 *
 *   ctx.memory.append(chatKey, 'memberImpression', content, { userId, target })
 *     · category 只认 'memberImpression'，传别的直接返回 null
 *     · content 在 #appendRaw 里被 **硬切到 300 字**，超了静默截断、不报错
 *     · #appendRaw 自带**按 content 全文去重**（相同内容不会重复入账）
 *     · 返回 { content, createdAt } 或 null
 *
 *   ctx.memory.getMember(chatKey, userId)
 *     → { userId, name, impressions: [{content, createdAt}], updatedAt }
 *
 *   ctx.memory.members(chatKey)
 *     → [{ userId, name, impressions, updatedAt, lastConsolidatedAt }]
 *
 *   ctx.memory.removeMember(chatKey, userId)   → 删除某人
 *
 *   ctx.memory.query(chatKey, category)
 *     → { memberImpression: [{ userId, target, content, createdAt }] }
 *
 * ⚠ 不要用 ctx.memory.editMemberImpression 做追加 —— 它是**整体替换**语义
 *   （内部直接重建 member 对象，不读旧值），而且 impressions 被切到 20 条。
 *   追加一律用 append()。
 */

/** 宿主的硬限制：content 会被切到这个长度，且不报错。 */
export const HOST_CONTENT_LIMIT = 300;
/** 跨群索引用的 chatKey。宿主 chatKey → 目录名时会做 `[^a-z0-9_] → _` 替换，
 *  所以这个 key 会落到 __global___cross_group__ 这样的目录下，与其他会话天然隔离。 */
export const CROSS_INDEX_KEY = 'global:__cross_group_index__';

/** 印象类别标记：用于在印象正文里区分"本群印象"和"跨群线索"。 */
const TAG_LOCAL = '【本群】';
const TAG_CROSS = '【跨群线索】';

// ── 记忆衰减依赖 ──────────────────────────────────────────────────────
// curve   ：纯函数曲线（不衰减的印象 / 会衰减的信息，分区与留存度）
// store   ：信息侧存（facts 带 hits/lastHitAt，宿主 schema 放不下）
// 命名成短别名：本文件里调用点密集，长名字会让 decay 相关代码难以阅读。
import * as curve from './curve.js';
import * as store from './fact-store.js';

/**
 * ★ 敏感信息过滤 —— 这是硬规则，不依赖模型自觉。
 *
 * 设计取舍：宁可错杀（漏记一条正常内容），不可放过。理由很简单 ——
 * 记忆库是长期存储，一旦写进去，就算后来删了也可能已经进了备份、
 * 进了别的日志。而漏记一条印象的代价只是"机器人少知道一点"。
 *
 * 命中任意一条即**拒收整条摘要**（不是擦掉那段再存），
 * 因为半截句子更容易产生误导。
 */
const SENSITIVE_PATTERNS = [
  // 身份证：18 位（含 X 结尾）或 15 位
  { name: '身份证号', re: /(?<!\d)\d{17}[\dXx](?!\d)/ },
  { name: '身份证号', re: /(?<!\d)\d{15}(?!\d)/ },
  // 手机号：中国大陆 1 开头 11 位
  { name: '手机号', re: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
  // 银行卡：16~19 位连续数字（避开已匹配的身份证）
  { name: '银行卡号', re: /(?<!\d)\d{16,19}(?!\d)/ },
  // 邮箱
  { name: '邮箱', re: /[\w.+-]+@[\w-]+\.[\w.]+/ },
  // 详细住址：省市 + 区/县/路/街 + 门牌，或明显的"住在/家住/地址"
  { name: '住址', re: /(?:家住|住在|地址|收货地址|现居)[^\s，。；]{4,}/ },
  { name: '住址', re: /[\u4e00-\u9fff]{2,8}(?:省|市)[\u4e00-\u9fff]{2,8}(?:区|县|镇|路|街|道)[\u4e00-\u9fff\d]{1,12}(?:号|栋|室|楼|单元)/ },
  // 真实姓名：自称"我叫/本人/真实姓名/实名 + 2~4 汉字"
  { name: '真实姓名', re: /(?:我叫|我是|本人叫|真实姓名|实名|真名)[\u4e00-\u9fff]{2,4}(?![\u4e00-\u9fff])/ },
  // 财务：工资/月薪/年薪/存款/收入 + 数字
  // ⚠ 中间必须允许空格与常见分隔符："月薪 30000"、"工资：8000"、"年薪约 30 万"
  { name: '财务信息', re: /(?:月薪|年薪|工资|薪资|存款|收入|余额|欠款|贷款|流水)[\s:：，,、约是达到有]{0,6}\d/ },
  // 医疗：确诊/病史/病情/吃了什么药
  { name: '医疗信息', re: /(?:确诊|病史|病情|患了|得的是|在吃.{0,4}药|服用.{0,4}药|癌症|糖尿病|高血压|抑郁症)/ },
  // 账号口令
  { name: '账号口令', re: /(?:密码|口令|验证码|密保)[\s:：是]{0,4}\S{4,}/ },
];

/**
 * 检查一段文本是否含敏感信息。
 * @returns {{safe: boolean, reason: string}}
 */
export function checkSensitive(text, enabled = true) {
  if (!enabled) return { safe: true, reason: '' };
  const s = String(text ?? '');
  if (!s) return { safe: true, reason: '' };
  for (const { name, re } of SENSITIVE_PATTERNS) {
    if (re.test(s)) return { safe: false, reason: name };
  }
  return { safe: true, reason: '' };
}

/** 把文本规整成一行、去多余空白。 */
export function normalizeText(t) {
  return String(t ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 把摘要裁到指定长度。
 * 优先在标点处断开（读起来自然），找不到就硬切。
 */
export function clampSummary(text, maxChars) {
  const s = normalizeText(text);
  const max = Math.max(20, Math.min(Number(maxChars) || 240, HOST_CONTENT_LIMIT - 20));
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const cut = Math.max(
    head.lastIndexOf('。'),
    head.lastIndexOf('；'),
    head.lastIndexOf('，'),
    head.lastIndexOf('.'),
    head.lastIndexOf(' ')
  );
  if (cut >= max * 0.5) return head.slice(0, cut + 1).trim();
  return head.trim();
}

/**
 * 从消息存档里按说话人聚合。
 *
 * @param {object} ctx
 * @param {string} chatKey
 * @param {{ limit?: number, excludeSelf?: boolean }} opts
 * @returns {Array<{userId, name, count, lastTs, texts, atMeCount}>}
 */
export function aggregateSpeakers(ctx, chatKey, opts = {}) {
  const limit = Math.max(1, Math.min(Number(opts.limit) || 60, 200));
  let msgs = [];
  try {
    msgs = ctx?.store?.recent?.(chatKey, { limit, includeSelf: false }) || [];
  } catch {
    return [];
  }

  const map = new Map();
  for (const m of msgs) {
    if (!m || m.self) continue;
    const uid = String(m.senderId ?? '').trim();
    // 只统计真实 QQ 号（宿主的 editMemberImpression 也要求纯数字）
    if (!/^\d{1,15}$/.test(uid)) continue;
    let rec = map.get(uid);
    if (!rec) {
      rec = { userId: uid, name: '', count: 0, lastTs: 0, texts: [], atMeCount: 0 };
      map.set(uid, rec);
    }
    rec.count += 1;
    rec.lastTs = Math.max(rec.lastTs, Number(m.ts) || 0);
    if (m.senderName) rec.name = String(m.senderName).trim() || rec.name;
    const text = normalizeText(m.text);
    if (text) rec.texts.push(text);
    if (m.atMe) rec.atMeCount += 1;
  }

  return [...map.values()].sort((a, b) => b.count - a.count || b.lastTs - a.lastTs);
}

/**
 * 写入本群印象。
 *
 * @returns {{ok: boolean, written: number, skipped: number, reasons: string[]}}
 */
export function writeImpression(ctx, chatKey, userId, name, summaries, opts = {}) {
  const mem = ctx?.memory;
  const out = { ok: false, written: 0, skipped: 0, reasons: [] };
  if (!mem || typeof mem.append !== 'function') {
    out.reasons.push('记忆模块不可用');
    return out;
  }
  const uid = String(userId ?? '').trim();
  if (!/^\d{1,15}$/.test(uid)) {
    out.reasons.push('QQ 号格式不合法');
    return out;
  }
  const list = Array.isArray(summaries) ? summaries : [summaries];
  const maxChars = opts.maxSummaryChars;
  const filterOn = opts.filterSensitive !== false;

  for (const raw of list) {
    const body = clampSummary(raw, maxChars);
    if (!body) { out.skipped += 1; continue; }
    const chk = checkSensitive(body, filterOn);
    if (!chk.safe) {
      out.skipped += 1;
      out.reasons.push(`含${chk.reason}已拦截`);
      continue;
    }
    try {
      const entry = mem.append(chatKey, 'memberImpression', `${TAG_LOCAL}${body}`, {
        userId: uid,
        target: opts.recordNickname === false ? '' : String(name || '').slice(0, 60),
      });
      if (entry) out.written += 1;
      else out.skipped += 1;
    } catch (error) {
      out.skipped += 1;
      out.reasons.push(String(error?.message ?? error).slice(0, 60));
    }
  }
  out.ok = out.written > 0;
  return out;
}

/** 读某人在本群的印象（只返回【本群】标记的）。 */
export function readImpressions(ctx, chatKey, userId) {
  const mem = ctx?.memory;
  if (!mem || typeof mem.getMember !== 'function') return null;
  try {
    const m = mem.getMember(chatKey, String(userId ?? '').trim());
    if (!m) return null;
    const impressions = (m.impressions || [])
      .map((e) => ({ content: String(e.content || ''), createdAt: Number(e.createdAt) || 0 }))
      .filter((e) => e.content.startsWith(TAG_LOCAL))
      .sort((a, b) => a.createdAt - b.createdAt);
    return { userId: m.userId, name: m.name, impressions };
  } catch {
    return null;
  }
}

/**
 * 裁剪某人的印象到上限。
 * 宿主的 append() **没有条数上限**，长期跑会无限膨胀，所以这里主动收口。
 * 策略：保留最新的 N 条（老印象参考价值递减）。
 *
 * 实现上仍用 append 语义无法删除，故改用 editMemberImpression 做**整批重写** ——
 * 这是它唯一合适的用法（它本就是"整体替换"语义）。
 */
export function trimImpressions(ctx, chatKey, userId, keep, opts = {}) {
  const mem = ctx?.memory;
  if (!mem || typeof mem.editMemberImpression !== 'function') return { trimmed: 0 };
  const uid = String(userId ?? '').trim();
  if (!/^\d{1,15}$/.test(uid)) return { trimmed: 0 };
  const max = Math.max(1, Math.min(Number(keep) || 12, 20)); // 宿主 edit 上限 20
  try {
    const m = mem.getMember(chatKey, uid);
    const all = (m?.impressions || []).slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    if (all.length <= max) return { trimmed: 0 };
    const kept = all.slice(-max).map((e) => String(e.content || ''));
    mem.editMemberImpression(chatKey, {
      userId: uid,
      name: opts.recordNickname === false ? '' : String(m.name || ''),
      impressions: kept,
    });
    return { trimmed: all.length - kept.length, kept: kept.length };
  } catch {
    return { trimmed: 0 };
  }
}

/** 列出本群所有被记过的人。 */
export function listMembers(ctx, chatKey) {
  const mem = ctx?.memory;
  if (!mem || typeof mem.members !== 'function') return [];
  try {
    return (mem.members(chatKey) || [])
      .map((m) => ({
        userId: String(m.userId || ''),
        name: String(m.name || ''),
        count: (m.impressions || []).filter((e) => String(e.content || '').startsWith(TAG_LOCAL)).length,
        updatedAt: Number(m.updatedAt) || 0,
      }))
      .filter((m) => m.userId && m.count > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

/**
 * 写跨群索引：记录某 QQ 号在哪些群出现过。
 *
 * 索引也放在 ctx.memory 里，用一个固定的自定义 chatKey，
 * 这样它同样能在控制台记忆页被看到和删除 —— 不搞"藏在插件目录里的黑盒数据"。
 */
export function updateCrossIndex(ctx, userId, name, groupId, topics, opts = {}) {
  const mem = ctx?.memory;
  if (!mem || typeof mem.append !== 'function') return { ok: false };
  const uid = String(userId ?? '').trim();
  if (!/^\d{1,15}$/.test(uid)) return { ok: false };
  const gid = String(groupId ?? '').trim();
  if (!gid) return { ok: false };

  // 线索正文：带上群标识与话题标签，一行一条便于阅读
  const topicStr = (Array.isArray(topics) ? topics : [])
    .map((t) => normalizeText(t))
    .filter(Boolean)
    .slice(0, 4)
    .join('、');
  const body = clampSummary(
    `${TAG_CROSS}群 ${gid}｜昵称 ${String(name || '').slice(0, 20) || '未知'}｜关注 ${topicStr || '（未提炼）'}`,
    opts.maxSummaryChars
  );
  try {
    const entry = mem.append(CROSS_INDEX_KEY, 'memberImpression', body, { userId: uid, target: name });
    return { ok: Boolean(entry) };
  } catch {
    return { ok: false };
  }
}

/**
 * 读跨群档案：某 QQ 号在哪些群出现过。
 * @returns {{userId, name, groups: Array<{groupId, nickname, topics, seenAt}>}}
 */
export function readCrossIndex(ctx, userId) {
  const mem = ctx?.memory;
  const uid = String(userId ?? '').trim();
  const result = { userId: uid, name: '', groups: [] };
  if (!mem || typeof mem.getMember !== 'function') return result;
  try {
    const m = mem.getMember(CROSS_INDEX_KEY, uid);
    if (!m) return result;
    result.name = String(m.name || '');
    const seen = new Set();
    for (const e of (m.impressions || []).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))) {
      const c = String(e.content || '');
      if (!c.startsWith(TAG_CROSS)) continue;
      const bodyText = c.slice(TAG_CROSS.length);
      const parts = bodyText.split('｜');
      const groupId = (parts[0] || '').replace(/^群\s*/, '').trim();
      if (!groupId || seen.has(groupId)) continue;
      seen.add(groupId);
      result.groups.push({
        groupId,
        nickname: (parts[1] || '').replace(/^昵称\s*/, '').trim(),
        topics: (parts[2] || '').replace(/^关注\s*/, '').trim(),
        seenAt: Number(e.createdAt) || 0,
      });
    }
  } catch { /* 读不到就当没有 */ }
  return result;
}

/** 从跨群索引里列出所有记过的 QQ 号。 */
export function listCrossIndex(ctx) {
  const mem = ctx?.memory;
  if (!mem || typeof mem.members !== 'function') return [];
  try {
    return (mem.members(CROSS_INDEX_KEY) || []).map((m) => ({
      userId: String(m.userId || ''),
      name: String(m.name || ''),
      count: (m.impressions || []).filter((e) => String(e.content || '').startsWith(TAG_CROSS)).length,
    })).filter((m) => m.userId && m.count > 0);
  } catch {
    return [];
  }
}

/**
 * 彻底删除某人的记录：本群印象 + 跨群索引。
 * 这是「别记我」的执行路径，必须真的删干净。
 *
 * ⚠ 不能用「调了 removeMember 就算删了」的写法 —— 宿主 removeMember 对不存在的
 *   成员不抛错（返回 false 或 undefined），无条件置 true 会**谎报删除成功**，
 *   等于对着用户撒谎说"已经删了"。所以删之前先 getMember 确认存在，
 *   并且把宿主的返回值也纳入判断。
 */
export function forgetPerson(ctx, userId, chatKey) {
  const mem = ctx?.memory;
  const uid = String(userId ?? '').trim();
  const out = { local: false, cross: false };
  if (!mem || typeof mem.removeMember !== 'function') return out;
  if (!/^\d{1,15}$/.test(uid)) return out;

  const existed = (key) => {
    try {
      if (typeof mem.getMember !== 'function') return false;
      return Boolean(mem.getMember(key, uid));
    } catch {
      return false;
    }
  };

  if (chatKey) {
    const had = existed(chatKey);
    try {
      const ret = mem.removeMember(chatKey, uid);
      // 宿主返回值语义不统一（可能是 boolean，也可能是 undefined），
      // 所以以「删之前存在 且 删之后确实读不到」为准。
      out.local = Boolean(had) && (ret === undefined || ret === true) && !existed(chatKey);
    } catch { /* 保持 false */ }
  }

  const hadCross = existed(CROSS_INDEX_KEY);
  try {
    const ret = mem.removeMember(CROSS_INDEX_KEY, uid);
    out.cross = Boolean(hadCross) && (ret === undefined || ret === true) && !existed(CROSS_INDEX_KEY);
  } catch { /* 保持 false */ }

  return out;
}

export const _internal = { SENSITIVE_PATTERNS, TAG_LOCAL, TAG_CROSS };

// ══════════════════════════════════════════════════════════════════════
// 记忆衰减：印象（不衰减）与信息（衰减）的分流读写
// ══════════════════════════════════════════════════════════════════════
//
// ★ 两类记忆的处理**截然不同**，这是本功能的核心分野（见 curve.js 的注释）：
//   印象 impression：'这个人是什么样' → 走宿主 ctx.memory，**永不衰减**。
//                    性格不会因为三个月没聊就变，衰减它属于语义错误。
//   信息 fact      ：'发生过什么事' → 走侧存 lib/fact-store.js，**随时间衰减**。
//                    "他昨天在加班"三个月后确实该淡出。
//
// 为什么不把 facts 也塞进 ctx.memory：宿主 schema 放不下。
//   ① append() 的 extra 被丢弃（只认 userId/target）—— src/memory.js:223
//   ② impression 只有 {content, createdAt}，没有 hits/lastHitAt 的位置
//   ③ editMemberImpression() 会把所有保留项的 createdAt 重置为 now —— src/memory.js:281
// ⇒ 用宿主的"重写"能力反而会**毁掉原始时间戳**，时间衰减就无从谈起。
// 详见 lib/fact-store.js 头部。

/**
 * 写入**信息**（会衰减的那类）。
 *
 * ⚠️ 与 writeImpression 的关键差别：本函数写侧存文件（不走 ctx.memory），
 *    因为这里要保留 hits/lastHitAt。安全过滤与长度限制与印象一致。
 *
 * @returns {{ok:boolean, added:number, reviewed:number, skipped:number, reasons:string[]}}
 */
export function writeFacts(chatKey, userId, name, entries, opts = {}) {
  const out = { ok: false, added: 0, reviewed: 0, skipped: 0, reasons: [] };
  const uid = String(userId ?? '').trim();
  if (!/^\d{1,15}$/.test(uid)) { out.reasons.push('QQ 号格式不合法'); return out; }

  const list = Array.isArray(entries) ? entries : [entries];
  const maxChars = opts.maxSummaryChars;
  const filterOn = opts.filterSensitive !== false;

  const clean = [];
  for (const raw of list) {
    const body = clampSummary(typeof raw === 'string' ? raw : raw?.content ?? '', maxChars);
    if (!body) { out.skipped += 1; continue; }
    const chk = checkSensitive(body, filterOn);
    if (!chk.safe) { out.skipped += 1; out.reasons.push(`含${chk.reason}已拦截`); continue; }
    clean.push(body);
  }
  if (!clean.length) return out;

  try {
    const r = store.addFacts(chatKey, uid, opts.recordNickname === false ? '' : String(name || '').slice(0, 60), clean);
    out.added = r.added;
    out.reviewed = r.reviewed;
    out.ok = r.added > 0 || r.reviewed > 0;
  } catch (error) {
    out.reasons.push(String(error?.message ?? error).slice(0, 60));
  }
  return out;
}

/** 读某人的**信息**侧存（含衰减打分，但不在库里改任何东西）。 */
export function readFacts(chatKey, userId, opts = {}) {
  const uid = String(userId ?? '').trim();
  if (!/^\d{1,15}$/.test(uid)) return null;
  const member = store.loadFacts(chatKey, uid);
  const scored = curve.partitionFacts(member.facts, opts.now || Date.now(), opts.curve || {});
  return { userId: uid, name: member.name, ...scored, lastDistillAt: member.lastDistillAt };
}

/**
 * 删除某人记录时的**信息侧存**清理。
 * 与 forgetPerson 配套：那个清宿主，这个清侧存 —— 两处都清才算真删干净，
 * 只清一处会留下"还认得这个人"的残影。
 */
export function forgetFacts(chatKey, userId) {
  const uid = String(userId ?? '').trim();
  if (!/^\d{1,15}$/.test(uid)) return false;
  return store.removeFacts(chatKey, uid);
}

/**
 * 列出本会话里所有有信息侧存的人（含衰减状态），供工具展示。
 * 与 listMembers（宿主印象）互补：那个看"记了谁"，这个看"还记得多少"。
 */
export function listFacts(chatKey, opts = {}) {
  const members = store.listFactMembers(chatKey);
  const now = opts.now || Date.now();
  return members.map((m) => {
    const member = store.loadFacts(chatKey, m.userId, m.name);
    const p = curve.partitionFacts(member.facts, now, opts.curve || {});
    return {
      userId: m.userId,
      name: m.name,
      total: member.facts.length,
      active: p.active.length,
      fade: p.fade.length,
      archive: p.archive.length,
      lastDistillAt: member.lastDistillAt,
    };
  });
}
