/**
 * 记忆遗忘曲线 —— 纯函数模块（零依赖，可独立测试）
 *
 * ── 设计立场：为什么**不**照抄艾宾浩斯 ──────────────────────────────────
 * 人类的遗忘曲线描述的是「无复习内容的**留存率**衰减」（R = e^(-t/S)），
 * 它是**心理测量学**模型：自变量是时间，因变量是"还能回忆起的概率"。
 * 直接搬到 bot 上会得到两个荒谬结论：
 *   ① "这条记忆每分钟掉 3% 权重" —— 可模型读的是**文字**，不是权重数值，
 *      0.37 和 0.42 对它的行为影响是**零**。这是没有行为意义的伪精确。
 *   ② 人类"遗忘"= 神经突触连接弱化（不可逆）；bot 的"遗忘"应该是
 *      **降级 + 归档**（可逆、可检索）。我们要的是工程策略，不是神经拟态。
 *
 * ── 只借用它唯一有价值的工程内核 ────────────────────────────────────────
 * 「**半衰期 + 复习延长**」这两条是真管用的：
 *   · 半衰期：把"时间流逝"折算成一个可比较的标量（而非拍脑袋的"保留最近 N 条"）
 *   · 复习延长：被再次提到 = 复习 → 记忆强化。**这是记忆曲线唯一的反馈回路**，
 *     没有它，衰减就只是个单向的定时器，跟"过期删除"没区别。
 *
 * ── 两类记忆，截然不同的处理（这是本模块的核心分野）────────────────────
 *   印象 impression：'这个人**是什么样**'（性格/偏好/雷点）→ **不衰减**。
 *                    人的性格不会因为三个月没聊就改变，衰减它属于语义错误。
 *   信息 fact      ：'**发生过什么事**'（一次性的、有时效的）→ **衰减**。
 *                    "他昨天在加班"三个月后确实该淡出，这才是遗忘该管的事。
 *
 * ⚠️ 本文件是**纯函数**：不读文件、不依赖 Date.now()（时间由调用方传入）、
 *    不做 IO。这样它可以在任何环境下被单测，也不会污染调用方的状态。
 */

/** 记忆分区。数值区间由 retention 决定，语义见 partition()。 */
export const ZONE = {
  ACTIVE: 'active',   // 活跃：正常喂给模型
  FADE: 'fade',       // 淡化：不再强调，蒸馏时优先合并
  ARCHIVE: 'archive', // 归档：不主动喂模型，但**保留数据**、仍可被检索
};

/** 默认曲线参数。全部可在 skill 配置里覆盖（见 plugin.json 的 configSchema）。 */
export const DEFAULT_CURVE = {
  /** 信息半衰期（天）：14 天后 retention 降到 0.5。 */
  halfLifeDays: 14,
  /** 低于此值进归档区。 */
  archiveThreshold: 0.15,
  /** 低于此值进淡化区，优先参与蒸馏。 */
  fadeThreshold: 0.5,
  /** 每次"复习"的加成系数：hits 越多，retention 被抬得越高。 */
  reviewBoost: 0.3,
};

const DAY_MS = 86400000;

/** 把任意输入夹到 [min,max]，且对 NaN 有兜底 —— 配置被填成垃圾值时不让整条曲线崩掉。 */
function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 归一化曲线配置：外部传进来的可能是字符串、负数、undefined。
 * 一律收敛成可信的数值，避免下游每个调用点各写一遍防御。
 */
export function normalizeCurve(raw = {}) {
  const halfLifeDays = clampNum(raw.halfLifeDays, 0.1, 3650, DEFAULT_CURVE.halfLifeDays);
  const archiveThreshold = clampNum(raw.archiveThreshold, 0, 0.99, DEFAULT_CURVE.archiveThreshold);
  // fade 必须 > archive，否则"淡化区"区间为空（分区逻辑会退化成两档）
  let fadeThreshold = clampNum(raw.fadeThreshold, 0.01, 1, DEFAULT_CURVE.fadeThreshold);
  if (fadeThreshold <= archiveThreshold) fadeThreshold = Math.min(1, archiveThreshold + 0.01);
  const reviewBoost = clampNum(raw.reviewBoost, 0, 5, DEFAULT_CURVE.reviewBoost);
  return { halfLifeDays, archiveThreshold, fadeThreshold, reviewBoost };
}

/**
 * 「复习」加成因子。
 *
 * 用 log2 而非线性：第 1 次复习的边际收益最大（从 "偶然一提" 变成 "确认过"），
 * 第 10 次和第 11 次几乎无差别。这与人类的"重复学习收益递减"一致，
 * 也避免某条被反复提到的记忆把权重顶成天文数字、压死其它所有记忆。
 *
 * hits=0 → 1.0（无加成）；hits=1 → 1+boost；hits=3 → 1+2boost；hits=7 → 1+3boost
 */
export function reviewFactor(hits, reviewBoost = DEFAULT_CURVE.reviewBoost) {
  const h = Math.max(0, Math.floor(Number(hits) || 0));
  const boost = clampNum(reviewBoost, 0, 5, DEFAULT_CURVE.reviewBoost);
  return 1 + Math.log2(h + 1) * boost;
}

/**
 * 计算一条**信息**的留存度（0~1 之间，越大越清晰）。
 *
 *   retention = 0.5 ^ (idleDays / halfLifeDays) × reviewFactor(hits)
 *
 * 注意结果**不夹到 1**：被复习过的旧信息可以 > 1，表示"比新信息还牢"——
 * 这是有意的，因为"复习过 5 次的老话题"本就该比"昨天提了一嘴"更稳定。
 * 但排序/分区时用的是夹过的值（见 partition），避免它无限增长。
 *
 * @param {number} idleDays 距上次被触碰的天数（调用方算好传入，纯函数不读时钟）
 * @param {number} hits     被复习次数
 * @param {object} curve    曲线配置（会被 normalize）
 */
export function retention(idleDays, hits = 0, curve = DEFAULT_CURVE) {
  const c = normalizeCurve(curve);
  const d = Math.max(0, Number(idleDays) || 0);
  const decay = Math.pow(0.5, d / c.halfLifeDays);
  return decay * reviewFactor(hits, c.reviewBoost);
}

/**
 * 把一条信息的原始时间戳折算成 idleDays。**这是唯一读时钟的地方**，
 * 且时钟由调用方传入（now），保持函数纯净、可测。
 */
export function idleDaysOf(lastTouchedAt, now = Date.now()) {
  const t = Number(lastTouchedAt);
  if (!Number.isFinite(t) || t <= 0) return 0;
  const diff = Number(now) - t;
  return diff > 0 ? diff / DAY_MS : 0;
}

/**
 * 判定一条信息属于哪个分区。
 *
 * 分区用的是**夹到 [0,1] 的 retention**：复习加成可以让原始值 >1，
 * 但"是否归档"只该看它有没有掉队，不该因为加成高就永远免死。
 * 反过来，一旦它掉到阈值下，hits 会自然衰减（因为 lastHitAt 不再更新），
 * 所以"归档"本身就是可逆的 —— 被重新提起就会回到活跃区。
 */
export function zoneOf(retentionValue, curve = DEFAULT_CURVE) {
  const c = normalizeCurve(curve);
  const r = Math.min(1, Math.max(0, Number(retentionValue) || 0));
  if (r < c.archiveThreshold) return ZONE.ARCHIVE;
  if (r < c.fadeThreshold) return ZONE.FADE;
  return ZONE.ACTIVE;
}

/**
 * 给一组信息算 retention + 分区，并按 retention 降序返回新数组。
 * 不改原对象（返回浅拷贝 + 附加字段），避免调用方拿到被悄悄改过的数据。
 *
 * @param {Array} facts   [{ content, createdAt, hits, lastHitAt }]
 * @param {number} now    当前时间戳
 * @param {object} curve  曲线配置
 */
export function scoreFacts(facts = [], now = Date.now(), curve = DEFAULT_CURVE) {
  const c = normalizeCurve(curve);
  return (Array.isArray(facts) ? facts : [])
    .filter((f) => f && typeof f.content === 'string' && f.content.trim())
    .map((f) => {
      const lastTouchedAt = Number(f.lastHitAt) || Number(f.createdAt) || now;
      const idleDays = idleDaysOf(lastTouchedAt, now);
      const raw = retention(idleDays, f.hits, c);
      return {
        ...f,
        idleDays: Math.round(idleDays * 100) / 100,
        retention: Math.round(Math.min(1, raw) * 1000) / 1000,
        zone: zoneOf(raw, c),
      };
    })
    .sort((a, b) => b.retention - a.retention || (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
}

/** 按分区切成三堆，便于"注入用活跃、蒸馏用淡化、展示用全部"。 */
export function partitionFacts(facts = [], now = Date.now(), curve = DEFAULT_CURVE) {
  const scored = scoreFacts(facts, now, curve);
  return {
    active: scored.filter((f) => f.zone === ZONE.ACTIVE),
    fade: scored.filter((f) => f.zone === ZONE.FADE),
    archive: scored.filter((f) => f.zone === ZONE.ARCHIVE),
    all: scored,
  };
}

/**
 * 一条信息该不该被蒸馏考虑？
 * 只挑**淡化区**的：活跃区还没到需要合并的时候，归档区已经沉底、
 * 合并它收益很低（而且归档本来就不喂模型，合不合并对提示词无影响）。
 * 这条规则让蒸馏的工作量随时间自然收敛。
 */
export function isDistillCandidate(scoredFact) {
  return Boolean(scoredFact) && scoredFact.zone === ZONE.FADE;
}

export const _internal = { clampNum, DAY_MS };
