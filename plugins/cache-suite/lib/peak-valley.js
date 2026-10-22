// 峰谷自动切换（Peak / Valley API & Model Switcher）
//
// ── 它解决什么问题 ────────────────────────────────────────────────────
// ① 时段 → 端点：DeepSeek 官方自 2026-08-16 起实行峰谷分时计价，高峰时段单价是闲时的
//    2 倍。高峰档期的官方口径（见核心 src/model-prices.js 的 PEAK_WINDOWS / isPeakHour）：
//        北京时间 周一至周五 09:00-12:00、14:00-18:00   ← 高峰
//        其余时间（含整个周末）                          ← 闲时（半价）
//    于是最省钱的用法是"按时段换端点"：闲时走 DeepSeek 官方，高峰走便宜的中转/别家。
//    一天最多切 4 次、还夹着周末，手动切既烦又一定会忘，所以交给本插件按时间自动切。
//
// ② 端点 → 图片专用模型：换端点时必须**连"看图用哪个模型"一起换**。
//    原因是核心的顺序：它先用本插件给的端点，再拿设置页里那个**全局**
//    「图片输入专用模型」覆盖模型名（`specializedModelFor()`，src/llm.js:361）。
//    于是一旦切到另一个厂商的端点，那个全局模型名在那边根本不存在 → 带图的请求 404、
//    整轮对话失败。本插件在请求体定稿前把 `body.model` 换成**当前这一侧**的图片模型
//    （每侧一个字段：peakVisionModel / valleyVisionModel），图片请求就跟着端点走了。
//
// ── 为什么写成插件（确定性型）─────────────────────────────────────────
// "现在几点 → 该用哪个端点""这次带图 → 用这一侧的图片模型"都是**能写死的规则**：
// 不需要模型理解任何内容，也不该由模型决定。按 doc/extend_development 的判据 → 插件。
//
// ── 零额外 token（本插件的硬约束，改代码时请守住）────────────────────
//   ✗ 不写 prompt / promptSections —— 系统提示词一个字节都不加
//   ✗ 不 registerTool —— 不往请求里塞 function schema（工具说明每轮都要付钱）
//   ✗ 不发任何网络请求、不自己重试 —— 绝不"偷偷多打一次 API"
//   △ 唯一碰请求体的地方：**带图/带视频**时把 body.model 换成该侧的图片模型。
//     这是修 404 的必要动作，且只发生在媒体请求上；**纯文字请求一个字节都不动**
//     （前缀缓存最关心的就是纯文字那条路径）。
//   ✓ 每次请求只做几次整数比较 + 一次数组扫描（消息里的 part 类型），纳秒级
//   唯一代价是"换端点"本身会让**新端点**的前缀缓存冷启一次（每个边界一次，见 README）。
//
// ── 与核心的接口（三处，都是核心来调我）──────────────────────────────
//   providers['llm.endpoint-pick']      每次**真实调用**前问"这次用哪个端点"（src/llm.js:345）
//   providers['llm.endpoint-feedback']  调用结束后回报成没成（src/llm.js:676，用于故障降级）
//   providers['llm.request-params']     请求体定稿前改 body（只在带图/带视频时动 model）
// ⚠️ 核心只取**第一个** llm.endpoint-pick 提供者（src/llm.js:345 取到就 break），
//    所以本插件与 account-pool 不能同时启用 —— available() 会直接说明这一点。

const DEFAULT_PEAK_WINDOWS = '09:00-12:00,14:00-18:00';
const DEFAULT_WINDOWS = [{ from: 9 * 60, to: 12 * 60 }, { from: 14 * 60, to: 18 * 60 }];
const SIDES = ['peak', 'valley'];
/** 侧位中文名：日志、面板、原因文案共用一处，改名字只改这里。 */
const SIDE_CN = { peak: '高峰侧', valley: '闲时侧' };
const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
/** 媒体 part 的类型 → 内部模态名（与核心 specializedModelFor 的判据同名）。 */
const MEDIA_PART_KIND = { image_url: 'image', video_url: 'video' };

/** 这些状态码意味着"问题出在这个端点"，换另一侧有意义。 */
const HARD_FAIL_STATUSES = new Set([401, 402, 403, 404, 408, 409, 425, 429]);
/** 401/402/429 之外，网关把失败原因写在正文里的常见措辞。 */
const HARD_FAIL_TEXT_RE = /insufficient|quota|balance|余额|欠费|配额|rate.?limit|too many requests|限流/i;
/** 匹配形如 "9:30-12:00" / "9-12" / "22:00~02:00" / "9:00至12:00" 的一段。 */
const WINDOW_PART_RE = /^(\d{1,2})(?::(\d{1,2}))?\s*[-~—－至到]\s*(\d{1,2})(?::(\d{1,2}))?$/;

/** 面板快照的最小写入间隔：状态没变就不必每分钟刷盘。 */
const SNAPSHOT_MIN_INTERVAL_MS = 60000;
/** 面板里"未来切换点"最多留几个 —— 面板侧按当前时间自己挑最近的，不重复实现时段逻辑。 */
const UPCOMING_LIMIT = 8;
/**
 * "刚才挑的是哪一侧"的有效期。
 * 用途只有一个：两侧共用同一个 Base URL（只换模型）时，request-params 里没法靠地址分辨
 * 自己在哪一侧，就用它兜底。pick 与 request-params 之间只隔一次 await，
 * 正常是同一毫秒级的事，10 秒已经非常宽松。
 */
const LAST_PICK_TTL_MS = 10000;
/** 带图请求的日志节流：一次看图会连着调用好几轮，没必要每轮写一行。 */
const MEDIA_LOG_INTERVAL_MS = 120000;

let cfg = () => ({});
let log = () => {};
let warn = () => {};
let storage = null;
let apiRef = null;

let pluginActive = true;
let lastWriteAt = 0;
let lastOutcomeKey = '';
let warnedWindows = false;
/** 最近一次 endpoint-pick 的结果（request-params 里识别"这次在哪一侧"的兜底判据）。 */
let lastPick = { key: '', baseUrl: '', at: 0 };
/** 最近一次"带图改写"的现场（给面板看，也是排障时最有用的一行）。 */
let lastMediaRewrite = { kind: '', side: '', from: '', to: '', at: 0 };
let lastMediaLogAt = 0;

/** 运行期健康与统计：'peak' | 'valley' -> {...}（刻意不落盘：秒级观测值，重启归零更干净） */
const runtime = new Map();
/** 窗口串 → 解析结果 的缓存：热路径上只剩一次字符串比较。 */
let windowCache = { text: '', windows: null, invalid: [] };

// ── 时段解析与判定（纯函数，便于自测）──────────────────────────────────

/** "H[:MM]" → 当天第几分钟；24:00 允许（= 1440，代表当天末尾）。 */
export function toMinutes(hour, minute) {
  const h = Number(hour);
  const m = minute === undefined || minute === null || minute === '' ? 0 : Number(minute);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  if (h < 0 || h > 24 || m < 0 || m > 59) return null;
  if (h === 24 && m !== 0) return null;
  return h * 60 + m;
}

/**
 * 解析高峰时段串。
 * 分隔符：逗号 / 中文逗号 / 分号 / 顿号 / 空白；两端相同的时刻表示**全天**。
 * @returns {{windows: Array<{from:number,to:number}>, invalid: string[]}}
 */
export function parseWindows(text) {
  const raw = String(text ?? '').trim();
  const windows = [];
  const invalid = [];
  if (!raw) return { windows, invalid };
  for (const part of raw.split(/[,;，；、\s]+/).map((s) => s.trim()).filter(Boolean)) {
    const m = WINDOW_PART_RE.exec(part);
    if (!m) { invalid.push(part); continue; }
    const from = toMinutes(m[1], m[2]);
    const to = toMinutes(m[3], m[4]);
    if (from === null || to === null) { invalid.push(part); continue; }
    // 两端相同按"全天"理解（00:00-00:00 与 09:00-09:00 都是这个语义）
    windows.push(from === to ? { from: 0, to: 1440 } : { from, to });
  }
  return { windows, invalid };
}

function parseWindowsCached(text) {
  if (windowCache.text === text && windowCache.windows) return windowCache;
  const r = parseWindows(text);
  windowCache = { text, windows: r.windows, invalid: r.invalid };
  return windowCache;
}

/** 把时间戳换算成目标时区的"墙上时间"（不依赖运行环境的本地时区设置）。 */
export function localParts(at, timezoneOffset) {
  const d = new Date(Number(at) + Number(timezoneOffset) * 3600000);
  return {
    year: d.getUTCFullYear(), month: d.getUTCMonth(), date: d.getUTCDate(),
    weekday: d.getUTCDay(), hour: d.getUTCHours(), minute: d.getUTCMinutes(),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes()
  };
}

/** 人类可读的当地时间：MM-DD HH:MM 周X（日志/面板用）。 */
export function formatLocal(at, timezoneOffset) {
  const p = localParts(at, timezoneOffset);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(p.month + 1)}-${pad(p.date)} ${pad(p.hour)}:${pad(p.minute)} ${WEEKDAY_CN[p.weekday]}`;
}

/**
 * 某个时刻是否处于高峰。
 * 与核心 isPeakHour 同口径：按目标时区判小时；weekdaysOnly 时周末全天闲时。
 */
export function isPeakAt(at, schedule) {
  const sched = schedule || {};
  const offset = Number.isFinite(Number(sched.timezoneOffset)) ? Number(sched.timezoneOffset) : 8;
  const windows = Array.isArray(sched.windows) && sched.windows.length ? sched.windows : DEFAULT_WINDOWS;
  const p = localParts(at, offset);
  if (sched.weekdaysOnly !== false && (p.weekday === 0 || p.weekday === 6)) return false;
  return windows.some((w) => (w.from <= w.to
    ? (p.minutes >= w.from && p.minutes < w.to)
    : (p.minutes >= w.from || p.minutes < w.to)));   // 跨零点
}

/**
 * 未来若干个"状态真的会翻转"的时刻。
 * 翻转只可能发生在窗口边界或当地零点，所以只在这些点上试算即可（不必逐分钟扫）。
 * @returns {Array<{at:number, to:'peak'|'valley'}>}
 */
export function upcomingBoundaries(at, schedule, limit = UPCOMING_LIMIT) {
  const sched = schedule || {};
  const offset = Number.isFinite(Number(sched.timezoneOffset)) ? Number(sched.timezoneOffset) : 8;
  const windows = Array.isArray(sched.windows) && sched.windows.length ? sched.windows : DEFAULT_WINDOWS;
  const now = Number(at);
  const marks = new Set([0]);
  for (const w of windows) {
    marks.add(w.from);
    marks.add(w.to >= 1440 ? 1439 : w.to);   // 24:00 的翻转落在次日零点，marks 里的 0 已覆盖
  }
  const p = localParts(now, offset);
  const dayStartUtc = Date.UTC(p.year, p.month, p.date);
  const out = [];
  for (let d = 0; d < 10 && out.length < limit; d++) {
    for (const m of marks) {
      const epoch = dayStartUtc + d * 86400000 + m * 60000 - offset * 3600000;
      if (epoch <= now) continue;
      const before = isPeakAt(epoch - 60000, sched);
      const after = isPeakAt(epoch, sched);
      if (before === after) continue;
      out.push({ at: epoch, to: after ? 'peak' : 'valley' });
    }
  }
  out.sort((a, b) => a.at - b.at);
  return out.slice(0, limit);
}

// ── 配置归一化（纯函数：UI 存下来的值什么类型都可能）───────────────────

const asBool = (v, dflt) => {
  if (v === undefined || v === null || v === '') return dflt;
  if (typeof v === 'boolean') return v;
  return !/^(false|0|no|off|否|关)$/i.test(String(v).trim());
};
const asNum = (v, dflt, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
};

/** 把 api.config() 的结果整成插件内部口径。 */
export function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const mode = String(c.mode ?? 'switch').trim().toLowerCase() === 'observe' ? 'observe' : 'switch';
  const timezoneOffset = asNum(c.timezoneOffset, 8, -12, 14);
  const weekdaysOnly = asBool(c.weekdaysOnly, true);
  const windowsText = String(c.peakWindows ?? '').trim() || DEFAULT_PEAK_WINDOWS;
  const parsed = parseWindowsCached(windowsText);
  if (!warnedWindows && (!parsed.windows.length || parsed.invalid.length)) {
    warnedWindows = true;
    const bad = parsed.invalid.length ? `无法识别的片段：${parsed.invalid.join('、')}；` : '';
    if (parsed.windows.length) warn(`${bad}已忽略这些片段，生效时段：${windowsText}`);
    else warn(`${bad}高峰时段串整体无法解析，已按默认 ${DEFAULT_PEAK_WINDOWS} 处理`);
  }
  const windows = parsed.windows.length ? parsed.windows : DEFAULT_WINDOWS;
  return {
    // ⚠️ 必须带上原始字段：端点档案（peakBaseUrl / valleyModel / peakVisionModel …）不在
    //    下面的归一化清单里，只回传归一化结果会让 sideProfile() 永远读到 undefined
    //    —— 表现为"配置明明填了，插件却一直显示未配置"。
    //    （这个 bug 曾经真的发生过：单测把 normalizeConfig 与 sideProfile 分开测，
    //      各自都对，合起来错。所以 selftest 里补了 setup() 之后的端到端断言。）
    ...c,
    mode,
    timezoneOffset,
    weekdaysOnly,
    windowsText,
    windows,
    fallbackOnFail: asBool(c.fallbackOnFail, true),
    failCooldownMin: asNum(c.failCooldownMin, 5, 0, 1440),
    logSwitch: asBool(c.logSwitch, true)
  };
}

/**
 * 取某一侧的端点档案。
 * **两侧都必须填了 Base URL 与模型名**才算"配置了这一侧"——
 * 只填一半会很危险：模型名空着会回落成主配置的模型名，而那个模型多半不在
 * 这个端点上，结果是每次调用 404，比不切还糟。所以缺一半 = 视为没配置。
 */
export function sideProfile(c, key) {
  const baseUrl = String(c?.[`${key}BaseUrl`] ?? '').trim();
  const model = String(c?.[`${key}Model`] ?? '').trim();
  let apiKey = String(c?.[`${key}ApiKey`] ?? '').trim();
  // 密码框的约定：'******' 是"没改过"的占位，绝不能当 Key 发出去
  if (apiKey === '******') apiKey = '';
  const label = String(c?.[`${key}Label`] ?? '').trim();
  if (!baseUrl || !model) return null;
  return {
    key,
    baseUrl,
    model,
    apiKey,
    label: label || model,
    url: safeUrlLabel(baseUrl),
    // 这一侧的"图片输入专用模型"：带图/带视频的请求改用它。
    // 留空 = 不干预（沿用核心设置页里的全局那个）。
    imageModel: String(c?.[`${key}VisionModel`] ?? '').trim()
  };
}

/** 端点地址的展示形态：保留 host 与路径，但把像 token 的长路径段打码。 */
export function safeUrlLabel(url) {
  const s = String(url ?? '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    const segs = String(u.pathname || '').split('/').filter(Boolean)
      .map((seg) => (/^[A-Za-z0-9_-]{20,}$/.test(seg) ? '***' : seg));
    return `${u.protocol}//${u.host}${segs.length ? `/${segs.join('/')}` : ''}`;
  } catch { return '(地址无法解析)'; }
}

/**
 * Key 的"能认出来但不是明文"形态：首 10 位 + 尾 6 位。
 *
 * 为什么需要它：控制台按设计**从不回填**密文字段（密码框永远空白、接口只回 `******`），
 * 于是"哪把 Key 填进了哪一侧"在界面上根本看不出来 —— 用户只能靠猜，
 * 填反了要等到某侧 401 才发现。面板里给出指纹，一眼就能对上自己手里的 Key。
 * 太短的 Key 不外显任何片段（短串露头露尾等于全露）。
 */
export function keyFingerprint(apiKey) {
  const s = String(apiKey ?? '').trim();
  if (!s) return '';
  if (s.length < 24) return `已填（${s.length} 字符）`;
  return `${s.slice(0, 10)}…${s.slice(-6)}`;
}

/** 这次失败是不是"端点的问题"（换一侧有意义），还是"请求本身的问题"（换谁都一样）。 */
export function isHardFail(status, errorText = '') {
  const s = Number(status) || 0;
  if (HARD_FAIL_TEXT_RE.test(String(errorText || ''))) return true;
  if (s === 0) return true;                      // 网络层失败 / 超时（请求已发出）
  if (HARD_FAIL_STATUSES.has(s)) return true;
  if (s >= 500) return true;
  // 400 / 422 是请求体（如上下文超长、参数被拒）的问题，换端点不会变好；
  // 这类失败交给核心自己的降级/备选模型链路，本插件不抢着换端点。
  return false;
}

// ── 媒体识别与"图片模型跟着端点走" ────────────────────────────────────

/** 从 messages 里认模态（video 优先，与核心 specializedModelFor 同序）。 */
export function detectMedia(messages) {
  if (!Array.isArray(messages)) return '';
  let kind = '';
  for (const m of messages) {
    const content = m?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const k = MEDIA_PART_KIND[String(part?.type ?? '')];
      if (k === 'video') return 'video';   // 视频能同时含图片部分，优先判定
      if (k === 'image') kind = 'image';
    }
  }
  return kind;
}

const normUrl = (u) => String(u ?? '').trim().replace(/\/+$/, '').toLowerCase();

/**
 * 这次请求落在哪一侧？（靠"端点地址"认，地址相同再用"刚挑的那次"兜底）
 * @returns {'peak'|'valley'|''} '' = 不是本插件给的端点（例如某个时段没配、回退主设置页）
 */
export function identifySide(c, baseUrl, pickInfo = null, now = Date.now()) {
  const target = normUrl(baseUrl);
  if (!target) return '';
  const hits = SIDES.filter((k) => {
    const p = sideProfile(c, k);
    return Boolean(p) && normUrl(p.baseUrl) === target;
  });
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    // 两侧共用同一个 Base URL（只有模型不同）时靠"刚才挑的是哪一侧"分辨
    const lp = pickInfo;
    if (lp && lp.key && hits.includes(lp.key) && (Number(now) - Number(lp.at || 0)) <= LAST_PICK_TTL_MS) return lp.key;
    return hits[0];
  }
  return '';
}

/**
 * 带图/带视频时，把 body.model 换成**当前这一侧**的图片专用模型。
 *
 * 为什么必须在这一步做：核心先用本插件给的端点，再拿设置页里那个**全局**
 * 「图片输入专用模型」覆盖模型名（src/llm.js:361 的 specializedModelFor）——
 * 于是切到别家端点后，那个全局模型名在那边不存在，带图的请求必然 404。
 * 请求体定稿前是唯一还能改 model 的地方（endpoint-pick 拿到的是改写**之前**的模型）。
 *
 * @returns {null | {body:object, side:string, kind:string, from:string, to:string}}
 *   null = 不改写（纯文字请求 / 不在本插件的端点上 / 这一侧没配图片模型）
 */
export function rewriteMediaModel({ messages, api, body, config = null, pickInfo = null, now = Date.now() }) {
  if (!body || typeof body !== 'object') return null;
  const kind = detectMedia(messages);
  if (!kind) return null;                             // 纯文字：一个字节都不动
  const c = config || readConfig();
  const side = identifySide(c, api?.baseUrl, pickInfo || lastPick, now);
  if (!side) return null;                             // 这次不是本插件的端点，不越权
  const profile = sideProfile(c, side);
  const want = profile ? profile.imageModel : '';
  if (!want || want === body.model) return null;      // 没配 / 已经是它，无需改写
  return { body: { ...body, model: want }, side, kind, from: String(body.model ?? ''), to: want };
}

// ── 决策（纯函数）─────────────────────────────────────────────────────

/**
 * 决定这次用哪一侧。
 * @returns {{key:'peak'|'valley'|null, preferredKey:'peak'|'valley', peakNow:boolean, reason:string}}
 *   key === null 表示"不干预"：核心会继续用主设置页里配的端点。
 */
export function decideEndpoint({ schedule, peak, valley, health, now, fallbackOnFail = true }) {
  const peakNow = isPeakAt(now, schedule);
  const preferredKey = peakNow ? 'peak' : 'valley';
  const otherKey = peakNow ? 'valley' : 'peak';
  const preferred = preferredKey === 'peak' ? peak : valley;
  const other = otherKey === 'peak' ? peak : valley;
  const sideHealth = (k) => (health && health[k]) || {};
  const cooling = (k) => Number(sideHealth(k).coolingUntil || 0) > Number(now);

  const windowName = peakNow ? '高峰' : '闲时';
  if (!preferred) {
    return { key: null, preferredKey, peakNow, reason: `${windowName}时段没有配置端点，不干预（沿用主设置页的端点）` };
  }
  if (fallbackOnFail && cooling(preferredKey)) {
    if (other && !cooling(otherKey)) {
      return {
        key: otherKey, preferredKey, peakNow,
        reason: `${windowName}侧故障冷却中${sideHealth(preferredKey).lastError ? `（${sideHealth(preferredKey).lastError}）` : ''}，临时改走另一侧`
      };
    }
    return { key: null, preferredKey, peakNow, reason: `${windowName}侧故障冷却中且另一侧不可用，回退主设置页的端点` };
  }
  return { key: preferredKey, preferredKey, peakNow, reason: `${windowName}时段` };
}

// ── 运行期状态 ────────────────────────────────────────────────────────

function statsOf(key) {
  let s = runtime.get(key);
  if (!s) {
    s = { calls: 0, failures: 0, fails: 0, coolingUntil: 0, lastError: '', lastUsedAt: 0, latencyEWMA: 0 };
    runtime.set(key, s);
  }
  return s;
}

function healthOf(now) {
  const out = {};
  for (const key of SIDES) {
    const s = statsOf(key);
    out[key] = { ...s, cooling: Number(s.coolingUntil) > Number(now) };
  }
  return out;
}

function labelFor(profile, key) {
  const cn = SIDE_CN[key] || '端点';
  return profile ? `${cn}「${profile.label}」` : cn;
}

// ── 快照（给只读面板看；也是"到底切没切"的现场证据）────────────────────

function sideView(key, profile, now) {
  const s = statsOf(key);
  return {
    key,
    configured: Boolean(profile),
    label: profile ? profile.label : '',
    model: profile ? profile.model : '',
    url: profile ? profile.url : '',
    hasOwnKey: Boolean(profile && profile.apiKey),
    keyHint: profile ? keyFingerprint(profile.apiKey) : '',
    // 这一侧的图片专用模型（留空 = 不干预，沿用核心设置页里的全局值）
    imageModel: profile ? profile.imageModel : '',
    calls: s.calls,
    failures: s.failures,
    cooling: Number(s.coolingUntil) > Number(now),
    coolingUntil: Number(s.coolingUntil) || 0,
    lastError: s.lastError || '',
    lastUsedAt: Number(s.lastUsedAt) || 0,
    latencyEWMA: Math.round(Number(s.latencyEWMA) || 0)
  };
}

function buildSnapshot(c, decision, now) {
  const schedule = { timezoneOffset: c.timezoneOffset, weekdaysOnly: c.weekdaysOnly, windows: c.windows };
  const peak = sideProfile(c, 'peak');
  const valley = sideProfile(c, 'valley');
  const activeKey = !pluginActive ? 'off'
    : c.mode === 'observe' ? 'observe'
      : (decision.key || 'base');
  return {
    updatedAt: now,
    enabled: pluginActive,
    mode: c.mode,
    timezoneOffset: c.timezoneOffset,
    weekdaysOnly: c.weekdaysOnly,
    windowsText: c.windowsText,
    localNow: formatLocal(now, c.timezoneOffset),
    peakNow: decision.peakNow,
    activeKey,
    wouldBeKey: decision.key || 'base',
    reason: decision.reason,
    // 最近一次"带图改写"：面板据此解释"刚才为什么用了另一个模型"
    media: lastMediaRewrite.kind
      ? { ...lastMediaRewrite, ageSec: Math.max(0, Math.round((now - lastMediaRewrite.at) / 1000)) }
      : null,
    sides: {
      peak: sideView('peak', peak, now),
      valley: sideView('valley', valley, now)
    },
    upcoming: upcomingBoundaries(now, schedule, UPCOMING_LIMIT)
  };
}

/**
 * 写面板快照。
 * 节流（60s）只是省盘：切换/失败/配置变更都会 force 立刻写。
 * 任何异常都吞掉 —— 面板没数据是小事，绝不能让统计写坏一次真实调用。
 */
function writeSnapshot(force) {
  const now = Date.now();
  if (!force && now - lastWriteAt < SNAPSHOT_MIN_INTERVAL_MS) return;
  lastWriteAt = now;
  if (!storage || typeof storage.set !== 'function') return;
  try {
    writeSnapshot.lastError = '';
    storage.set('snapshot', buildSnapshot(readConfig(), lastDecision, now));
  } catch (error) {
    writeSnapshot.lastError = String(error?.message ?? error);
  }
}
writeSnapshot.lastError = '';

let lastDecision = { key: null, preferredKey: 'valley', peakNow: false, reason: '尚未判定' };

function readConfig() {
  return normalizeConfig(cfg() || {});
}

// ── 核心调用的三个入口 ────────────────────────────────────────────────

/**
 * 每次真实调用前被核心问到"用哪个端点"。
 * 返回 null 是**完全合法**的回答，意思是"这次不干预，用你自己的配置"。
 */
let pickingEndpoint = false;
export function pickEndpoint() {
  // 递归保护：e2e 全技能组合曾出现 Maximum call stack size exceeded，
  // 无论根因是哪层回调重入，这里都退化成“本次不干预”，绝不能拖垮整轮请求。
  if (pickingEndpoint) return null;
  pickingEndpoint = true;
  try {
    return _pickEndpoint();
  } finally {
    pickingEndpoint = false;
  }
}

function _pickEndpoint() {
  const now = Date.now();
  const c = readConfig();
  const schedule = { timezoneOffset: c.timezoneOffset, weekdaysOnly: c.weekdaysOnly, windows: c.windows };
  const peak = sideProfile(c, 'peak');
  const valley = sideProfile(c, 'valley');
  const health = healthOf(now);
  const decision = decideEndpoint({
    schedule, peak, valley, health, now, fallbackOnFail: c.fallbackOnFail
  });
  lastDecision = decision;

  const chosen = decision.key === 'peak' ? peak : decision.key === 'valley' ? valley : null;
  // 记下这次挑的是哪一侧：request-params 里识别"这请求在哪一侧"要用
  lastPick = { key: decision.key || '', baseUrl: chosen ? chosen.baseUrl : '', at: now };

  const outcomeKey = `${c.mode}:${decision.key || 'none'}`;
  let changed = false;
  if (outcomeKey !== lastOutcomeKey) {
    lastOutcomeKey = outcomeKey;
    changed = true;
    if (c.logSwitch) {
      const stamp = formatLocal(now, c.timezoneOffset);
      if (c.mode === 'observe') {
        log(`${stamp} 观察：本该走 ${labelFor(chosen, decision.key || decision.preferredKey)}${chosen ? `（${chosen.model} @ ${chosen.url}）` : ''} —— ${decision.reason}`);
      } else if (chosen) {
        log(`${stamp} 切到 ${labelFor(chosen, decision.key)}：${chosen.model} @ ${chosen.url} —— ${decision.reason}`);
      } else {
        log(`${stamp} 不干预：${decision.reason}`);
      }
    }
  }
  writeSnapshot(changed);

  if (c.mode === 'observe' || !chosen) return null;
  // 契约：核心只认 baseUrl 为真的返回；apiKey 留空表示沿用主配置的 Key。
  return { id: chosen.key, baseUrl: chosen.baseUrl, apiKey: chosen.apiKey || '', model: chosen.model };
}

/**
 * 请求体定稿前：**只在带图/带视频时**把模型换成当前这一侧的图片专用模型。
 * 返回 undefined 表示"我不改写"（契约：非对象返回值被忽略）。
 */
export function applyRequestParams({ body, api, messages } = {}) {
  const now = Date.now();
  const c = readConfig();
  const r = rewriteMediaModel({ messages, api, body, config: c, pickInfo: lastPick, now });
  if (!r) return undefined;

  lastMediaRewrite = { kind: r.kind, side: r.side, from: r.from, to: r.to, at: now };
  if (c.logSwitch && now - lastMediaLogAt > MEDIA_LOG_INTERVAL_MS) {
    lastMediaLogAt = now;
    const cn = r.kind === 'video' ? '视频' : '图片';
    log(`${formatLocal(now, c.timezoneOffset)} 带${cn}的请求：${SIDE_CN[r.side] || r.side} 改用图片专用模型 ${r.to}（核心给的模型名是 ${r.from || '(空)'}，在这个端点上多半不存在）`);
  }
  writeSnapshot(true);
  return { body: r.body };
}

/** 核心回报这次调用成没成（只有 pick 给出 id 时才会回报）。 */
export function endpointFeedback(payload = {}) {
  const key = String(payload.accountId || payload.id || '');
  if (!SIDES.includes(key)) return { ok: true };
  const now = Date.now();
  const s = statsOf(key);
  const c = readConfig();
  let enteredCooling = false;

  if (payload.ok) {
    s.calls += 1;
    s.fails = 0;
    s.coolingUntil = 0;
    s.lastError = '';
    s.lastUsedAt = now;
    const lat = Number(payload.latencyMs);
    if (Number.isFinite(lat) && lat > 0) {
      s.latencyEWMA = s.latencyEWMA > 0 ? s.latencyEWMA * 0.7 + lat * 0.3 : lat;
    }
  } else {
    s.calls += 1;
    s.failures += 1;
    s.lastUsedAt = now;
    s.lastError = `${Number(payload.status) || 0} ${String(payload.error || '调用失败').replace(/\s+/g, ' ').trim().slice(0, 120)}`;
    if (c.fallbackOnFail && c.failCooldownMin > 0 && isHardFail(payload.status, payload.error)) {
      s.fails += 1;
      if (s.coolingUntil <= now) {
        s.coolingUntil = now + c.failCooldownMin * 60000;
        enteredCooling = true;
      }
    }
  }

  if (enteredCooling && c.logSwitch) {
    log(`${labelFor(sideProfile(c, key), key)} 连续失败，${c.failCooldownMin} 分钟内不再投用（${s.lastError}）`);
  }
  writeSnapshot(enteredCooling || Boolean(payload.ok && s.calls === 1));
  return { ok: true, cooling: Number(s.coolingUntil) > now };
}

// ── 生命周期与自检 ────────────────────────────────────────────────────

export function setup(api) {
  cfg = typeof api?.config === 'function' ? api.config : () => ({});
  log = typeof api?.log === 'function' ? api.log : () => {};
  warn = typeof api?.warn === 'function' ? api.warn : log;
  storage = api?.storage || null;
  apiRef = api || null;
  pluginActive = true;
  // 先把快照写一份：面板第一次打开就有东西看（此时还没发生任何调用）
  try {
    const c = readConfig();
    const schedule = { timezoneOffset: c.timezoneOffset, weekdaysOnly: c.weekdaysOnly, windows: c.windows };
    const now = Date.now();
    lastDecision = decideEndpoint({
      schedule, peak: sideProfile(c, 'peak'), valley: sideProfile(c, 'valley'),
      health: healthOf(now), now, fallbackOnFail: c.fallbackOnFail
    });
  } catch { /* 自检失败不影响真实调用 */ }
  writeSnapshot(true);
  log('已启用（零额外 token：不加提示词、不注册工具；只在带图/带视频时把模型换成该侧的图片专用模型）');
}

export function activate() {
  pluginActive = true;
  writeSnapshot(true);
}

export function deactivate() {
  pluginActive = false;
  writeSnapshot(true);
}

/** 有可用的一侧才算就绪；两侧都没配时明确说出来，而不是"开着但什么都不做"。 */
export function available() {
  if (typeof apiRef?.isSkillActive === 'function') {
    try {
      if (apiRef.isSkillActive('account-pool')) {
        return {
          ok: false,
          reason: 'account-pool 也在提供 llm.endpoint-pick，而核心只取第一个提供者（src/llm.js:345）。两者同时启用必有一个静默失效，请二选一。'
        };
      }
    } catch { /* 自检异常不该让插件判死 */ }
  }
  const c = readConfig();
  if (!sideProfile(c, 'peak') && !sideProfile(c, 'valley')) {
    return {
      ok: false,
      reason: '高峰侧与闲时侧都还没配置：至少给一侧填上 Base URL 与模型名（Key 可留空沿用主设置页的）。'
    };
  }
  return { ok: true };
}

export const providers = {
  'llm.endpoint-pick': () => {
    try {
      return pickEndpoint();
    } catch (error) {
      // 插件自己坏了必须退化成"不干预"，绝不能让整轮对话失败
      try { warn(`峰谷判定异常，本次不切换：${error?.message ?? error}`); } catch { /* ignore */ }
      return null;
    }
  },
  'llm.endpoint-feedback': (payload) => {
    try {
      return endpointFeedback(payload);
    } catch (error) {
      try { warn(`峰谷统计异常（不影响调用）：${error?.message ?? error}`); } catch { /* ignore */ }
      return { ok: true };
    }
  },
  'llm.request-params': (args) => {
    try {
      return applyRequestParams(args);
    } catch (error) {
      // 改写失败等于"什么都不改"，绝不能因此让请求发不出去
      try { warn(`图片模型改写异常，本次不改写：${error?.message ?? error}`); } catch { /* ignore */ }
      return undefined;
    }
  }
};

/** 自测入口：这些是纯函数，`node plugins/peak-valley-switch/selftest.mjs` 直接跑。 */
export const internals = {
  DEFAULT_PEAK_WINDOWS, DEFAULT_WINDOWS, SIDES, SIDE_CN,
  parseWindows, toMinutes, isPeakAt, upcomingBoundaries, formatLocal, localParts,
  normalizeConfig, sideProfile, safeUrlLabel, isHardFail, decideEndpoint, keyFingerprint,
  detectMedia, identifySide, rewriteMediaModel, applyRequestParams,
  statsOf, healthOf, buildSnapshot,
  lastPickState: () => ({ ...lastPick }),
  lastMediaState: () => ({ ...lastMediaRewrite }),
  resetRuntime() {
    runtime.clear();
    lastOutcomeKey = '';
    warnedWindows = false;
    windowCache = { text: '', windows: null, invalid: [] };
    lastPick = { key: '', baseUrl: '', at: 0 };
    lastMediaRewrite = { kind: '', side: '', from: '', to: '', at: 0 };
    lastMediaLogAt = 0;
  }
};
