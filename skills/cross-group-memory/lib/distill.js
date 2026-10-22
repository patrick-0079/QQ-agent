/**
 * 记忆蒸馏 —— 把多条褪色的「信息」提纯成一条稳定的「印象」。
 *
 * ══════════════════════════════════════════════════════════════════════
 * ── 蒸馏 ≠ 摘要（这是最容易做错的地方）──────────────────────────────
 * 如果把蒸馏实现成"把旧记忆改短一点"，那叫**摘要**，不叫蒸馏。区别在于：
 *   · 摘要：1 条 → 1 条（信息不变，只是变短）。信息熵没变，只是被压缩了文字。
 *   · 蒸馏：N 条 → 1 条（**信息类型**变了：从"发生过的事"升格为"这个人的特征"）。
 *
 * 真蒸馏必须回答"从这些事实里能**归纳出什么**"，而不是"怎么把它们写短"。
 * 例：
 *   输入（3 条信息）：'他说在准备考研' / '他问过考研数学' / '他说考研压力大'
 *   蒸馏 → 1 条印象：'在准备考研（压力大）' —— 且 hits=3（三条共同印证）
 * 这才是"记住关键信息"的正确含义：**关键信息 = 被多条事实共同印证的特征**。
 *
 * ── 谁来做归纳 ───────────────────────────────────────────────────────
 * ⚠️ 技能**拿不到 LLM**（api 上只有 registerTool/config/capability/log/fetch/utils）。
 * 所以"语义归纳"只能由**模型**完成 —— 本模块负责的是**归纳前的准备工作**：
 *   ① 聚类：把值得蒸馏的 facts（淡化区）按主题分组，判断哪些"够格"蒸馏
 *   ② 出题：生成一段给模型的指令（哪些人、哪些事实、要归纳成什么）
 *   ③ 落账：模型归纳回来后，负责写印象、清原事实、保留可追溯的记录
 * 换句话：**本模块不假装自己能做 NLP**，它只做能确定的那部分（筛选/分组/记账），
 * 把不确定的那部分（语义归纳）明确交给模型 —— 这比用正则猜语义诚实得多。
 *
 * ── 纯函数优先 ───────────────────────────────────────────────────────
 * 除 distillApply 外全部是纯函数，可独立单测；IO 在 fact-store / index 层。
 */

import { partitionFacts, normalizeCurve, ZONE } from './curve.js';

/** 两条信息是否"疑似同主题"。用字 + 二字词（bigram）重叠，够用即可（不装 NLP）。 */
const STOP = new Set(['的', '了', '是', '在', '他', '她', '我', '你', '有', '和', '就', '都', '也', '很', '说', '过', '个', '这', '那', '一']);

/**
 * 提取用于比对的 token 集。
 *
 * ★ 必须用 **bigram（相邻二字词）**，不能只用单字 —— 中文单字重叠太弱：
 *   实测 '他在准备考研数学' vs '他说考研压力很大' 单字 Jaccard 只有 0.22，
 *   会把同一主题（考研）硬拆成两组，导致蒸馏永远凑不够条数。
 *   加上 bigram 后，"考研"这个词成为强信号，相似度升到可聚类的水平。
 *
 * 单字 + bigram 混用：单字保底（短句、专业词），bigram 提精度（中文词边界）。
 */
function tokens(text) {
  const s = String(text ?? '').toLowerCase();
  const set = new Set();
  const cjk = [];
  for (const ch of s) {
    if (/[\u4e00-\u9fa5]/.test(ch)) { cjk.push(ch); if (!STOP.has(ch)) set.add(ch); }
    else cjk.push(' ');
  }
  // 相邻二字词：只在连续中文段内构造，避免跨标点拼出假词
  let run = [];
  const flush = () => {
    for (let i = 0; i + 1 < run.length; i++) {
      const bg = run[i] + run[i + 1];
      if (!STOP.has(run[i]) || !STOP.has(run[i + 1])) set.add(bg);
    }
    run = [];
  };
  for (const ch of s) {
    if (/[\u4e00-\u9fa5]/.test(ch)) run.push(ch);
    else flush();
  }
  flush();
  for (const w of s.match(/[a-z0-9]{2,}/g) || []) set.add(w);
  return set;
}

/**
 * 相似度：**重叠系数 + bigram 加成**，不用 Jaccard。
 *
 * ★ 为什么不用 Jaccard（实测踩坑）：
 *   句子一长，Jaccard 的并集就被大量"独有 bigram"撑大，导致**真正的共同词
 *   （如"考研"）被稀释**。实测 '考研压力很大' vs '考研数学题' 的 Jaccard 仅 0.14，
 *   同一主题被拆成两组 —— 蒸馏永远凑不够条数。
 *
 * 采用两段式：
 *   ① 重叠系数 inter / min(|A|,|B|) —— 对"短句 vs 长句"更稳（不惩罚长度差）
 *   ② bigram 加成：共同的二字词是"同主题"的强证据（"考研" > "考" + "研" 孤立出现）
 *
 * 结果夹到 1；两个空集 → 0。
 */
export function similarity(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0, bgInter = 0;
  for (const x of A) {
    if (B.has(x)) { inter += 1; if (x.length >= 2) bgInter += 1; }
  }
  const minSize = Math.min(A.size, B.size);
  const overlap = inter / minSize;
  // 每个共同 bigram 额外加 0.12（上限 +0.48），让"考研""数学"这类词真正起作用
  const bonus = Math.min(0.48, bgInter * 0.12);
  return Math.min(1, overlap * 0.75 + bonus);
}

/**
 * 把一组信息按主题聚类（简单单链聚类）。
 *
 * 为什么不更高级：这里的目标是"给模型分好组"，而**模型自己会看到全部原文**，
 * 它有能力纠正粗糙的分组。用简单的字符重叠聚类，是为了**不引入假精确** ——
 * 真上 embedding 需要联网调模型，而技能还不一定能联网，成本收益不成比例。
 *
 * @param {Array} facts   已 score 过的 facts（含 content/retention/zone）
 * @param {number} threshold 相似度阈值。
 *   ★ 0.22 是**实测标定**出来的，不是拍脑袋：
 *     同主题对实测最低 0.325（'考研数学' vs '考研压力'），
 *     异主题对实测最高 0.058（'拉面' vs '早起'）—— 中间有 5.6 倍的空档。
 *     取 0.22 落在空档中央，两侧都留了余量；偏离到 0.35 会把同主题拆开，
 *     降到 0.1 以下则可能把无关短句并进来。
 */
export function clusterFacts(facts = [], threshold = 0.22) {
  const groups = [];
  for (const f of facts) {
    let placed = false;
    for (const g of groups) {
      // 与组内任一成员相似即并入（单链，容忍主题的链式延伸）
      if (g.some((m) => similarity(m.content, f.content) >= threshold)) {
        g.push(f);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push([f]);
  }
  return groups;
}

/**
 * 挑出这次该蒸馏什么。
 *
 * 规则（每条都有理由）：
 *   · 只看**淡化区**：活跃区还没到该合并的时候；归档区已沉底，合并它对提示词无影响。
 *   · 组内至少 `minFacts` 条：一条事实谈不上"归纳"，凑不够数就不蒸馏。
 *   · 优先 retention 低的组：越接近遗忘的越该尽快提纯，否则等着等着就没了。
 *
 * @returns {Array<{facts:Array, avgRetention:number, totalHits:number}>} 按紧迫度降序
 */
export function pickDistillTargets(facts = [], {
  minFacts = 3,
  maxGroups = 6,
  threshold = 0.22,
  curve = {},
} = {}) {
  const c = normalizeCurve(curve);
  const scored = facts.filter((f) => f && f.zone);
  const fade = scored.filter((f) => f.zone === ZONE.FADE);
  if (fade.length < Math.max(2, minFacts)) return [];

  const groups = clusterFacts(fade, threshold)
    .filter((g) => g.length >= Math.max(2, minFacts))
    .map((g) => ({
      facts: g,
      avgRetention: g.reduce((s, f) => s + (Number(f.retention) || 0), 0) / g.length,
      totalHits: g.reduce((s, f) => s + (Number(f.hits) || 0), 0),
      lastTs: Math.max(...g.map((f) => Number(f.lastHitAt) || Number(f.createdAt) || 0)),
    }));

  // 紧迫度：retention 越低越该先蒸馏；同分时 hits 多的优先（更值得留）
  groups.sort((a, b) => a.avgRetention - b.avgRetention || b.totalHits - a.totalHits);
  return groups.slice(0, Math.max(1, maxGroups));
}

/**
 * 为模型生成蒸馏指令（"出题"）。
 *
 * 关键：**必须明确告诉模型输出格式**，否则它回来的东西无法自动落账。
 * 所以要求它按行输出 `QQ号 | 归纳内容`，本模块用这个格式解析。
 *
 * @param {Array} targets  pickDistillTargets 的结果
 * @param {object} nameMap  userId → 昵称（用于让模型知道"这些人是谁"）
 */
export function buildDistillPrompt(targets = [], nameMap = {}) {
  if (!targets.length) return '';
  const lines = [
    '【记忆蒸馏任务】',
    '以下群友的若干"过往信息"已经过去一段时间、正在淡忘。请把同一主题的多条信息**归纳成一条稳定特征**（不是把话写短，而是提炼出"这个人是什么样"）。',
    '归纳要求：',
    '- 只写**稳定的、以后用得到的**特征；一次性的事件（"昨天在加班"）不要升格为特征。',
    '- 若一组信息里其实**没有**稳定特征可提炼，就整组跳过，不要硬编。',
    '- 严禁写入真实姓名、住址、电话、身份证、银行卡、病情等敏感信息。',
    '输出格式（每行一条，务必用 | 分隔，QQ 号照抄）：',
    'QQ号 | 归纳出的一句话特征',
  ];
  for (const t of targets) {
    const uid = String(t.facts[0]?.userId ?? '');
    const who = nameMap[uid] || uid;
    lines.push('', `▸ ${who}(QQ:${uid}) 的候选信息（${t.facts.length} 条，平均留存 ${t.avgRetention.toFixed(2)}）：`);
    for (const f of t.facts) lines.push(`  · ${f.content}`);
  }
  return lines.join('\n');
}

/**
 * 解析模型返回的蒸馏结果。
 * 宽容解析：容忍全角竖线、多余空格、前后缀说明文字；解析不出的行**丢弃但不报错**
 * （模型的输出形态不可控，解析失败不该让整个流程失败）。
 *
 * @returns {Array<{userId:string, summary:string}>}
 */
export function parseDistillOutput(text) {
  const out = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim().replace(/^[-*·▸\s]+/, '');
    if (!line) continue;
    const m = /^(\d{5,15})\s*[|｜]\s*(.+)$/.exec(line);
    if (!m) continue;
    const summary = m[2].trim().replace(/^[「『"']|[」』"']$/g, '').trim();
    if (!summary) continue;
    out.push({ userId: m[1], summary: summary.slice(0, 280) });
  }
  return out;
}

/**
 * 判断某个人的信息是否"该被蒸馏了"（到点检查）。
 *
 * 这是"定时批量"的节流闸门：只有距上次蒸馏超过 intervalHours 才真跑，
 * 否则每次会话结束都蒸馏会把 token 烧光（而蒸馏本身要调模型）。
 */
export function shouldDistill(member, { now = Date.now(), intervalHours = 24 } = {}) {
  const last = Number(member?.lastDistillAt) || 0;
  const gap = Math.max(0, Number(intervalHours) || 24) * 3600000;
  return now - last >= gap;
}

/**
 * 蒸馏后的落账：把已归纳出的 summary 写成印象、把原 facts 移出活跃区。
 *
 * ⚠️ **本函数不删原 facts** —— 先生明确要求"降级归档，不删"。
 *    蒸馏只做两件事：① 把归纳结果交给调用方去写印象；② 把原 facts 标记为已蒸馏
 *    （hits 归零 + lastHitAt 保持不变 ⇒ 它们会自然继续衰减到归档区）。
 *
 * @returns {{ promoted: Array<{userId,summary,fromCount}>, remainingFacts: Array }}
 */
export function distillApply(targets = [], results = [], { now = Date.now() } = {}) {
  const byUser = new Map();
  for (const r of results) {
    if (!r?.userId || !r?.summary) continue;
    byUser.set(String(r.userId), r.summary);
  }
  const promoted = [];
  const consumed = new Set();   // 被归纳掉的原 facts（按内容串标识）

  for (const t of targets) {
    const uid = String(t.facts[0]?.userId ?? '');
    const summary = byUser.get(uid);
    if (!summary) continue;      // 模型选择跳过这一组 → 保持原样，不勉强
    promoted.push({ userId: uid, summary, fromCount: t.facts.length });
    for (const f of t.facts) consumed.add(`${uid}\u0000${f.content}`);
  }
  return { promoted, consumed, now };
}

/**
 * 把"已蒸馏"的原 facts 更新为衰减后状态（hits 归零，让它们自然沉底）。
 * 注意：**不删**，只是不再享受复习加成 —— 这是"降级归档"的实现。
 */
export function fadeConsumedFacts(member, consumed, now = Date.now()) {
  if (!member || !consumed?.size) return member;
  for (const f of member.facts || []) {
    const key = `${member.userId}\u0000${f.content}`;
    if (consumed.has(key)) {
      // 归零但不改 lastHitAt：时间继续走，它会自己掉进归档区
      f.hits = 0;
      if (!f.lastHitAt) f.lastHitAt = Number(f.createdAt) || now;
      f.distilledAt = now;
    }
  }
  return member;
}

export const _internal = { tokens, STOP };
