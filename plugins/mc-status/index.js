/**
 * mc-status —— Minecraft 服务器状态查询
 *
 * 在 QQ 里发「服务器状态」「我的服开着吗」就能查配置的服务器：
 * 在线人数、版本、延迟、MOTD、在线玩家名单。支持 Java 版和基岩版。
 *
 * 设计取向（用户要求：稳定优先、可选性高）：
 *   1. 默认**直连**服务器自己解析协议，不经过任何第三方 —— 别人家服务挂了不影响你
 *   2. 数据源可切换（直连 / mcsrvstat / 自建接口），服务器列表可配多个
 *   3. 卡片图优先，渲染失败自动回退文字 —— 稳定由兜底保证
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig, DATA_DIR } from '../../src/config.js';

// ⚠️ 热重载坑（项目踩过）：plugin-loader 只给插件**入口**加时间戳，入口里静态
//   import 的子模块会命中 Node 的 ESM 缓存 —— 改了子模块，热重载日志报"成功"，
//   跑的却还是旧版。动态 import + 时间戳才能绕过。
const S = await import(`./sources.js?t=${Date.now()}`);
const { getSource, parseServers, SOURCES } = S;

// 版本号直接从 plugin.json 读，不再手写 —— 手写的下场就是升到 1.2.x 了启动日志还印 v1.0.0，
// 排查时会被它带偏（以为跑的是旧代码）。读不到就退化成 v?，不影响启动。
const BUILD_TAG = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'plugin.json'), 'utf8'));
    return `v${j.version}`;
  } catch { return 'v?'; }
})();
const CARD_W = 640;
const STATE_FILE = path.join(DATA_DIR, 'mc-status-state.json');
const HISTORY_FILE = path.join(DATA_DIR, 'mc-status-history.json');
// 历史只留最近这些小时 —— 曲线最多画 24 小时（配置上限 48），多留一点是为了跨零点时左半边不空
const HISTORY_HOURS = 48;
// ── 存储粒度：固定按 5 分钟分桶 ──
// 用户在设置里选的「一段多长」（5/15/20/30 分钟，同时也是后台自动采集的间隔）是**读取侧**
// 的事：粗粒度由若干个 5 分钟桶合并平均得到，所以存储只需要照顾最细的那一档。
// 反过来（按当前设置存）就不行了 —— 改一次设置，旧数据就与新的桶对不上，整条曲线报废。
const SLOT_MS = 5 * 60_000;
const SLOTS_PER_HOUR = 12;                 // 60 / 5

let api = null;
let fetchRef = null;
let rendering = false;

const st = () => api?.config?.() || {};
const enabled = () => st().enabled !== false;

/* ── 主题 ────────────────────────────────────────────────── */
const THEMES = {
  dark: {
    pageBg: '#0e1014', cardBg: '#14171d', border: '#262b35',
    rowBg: '#1b1f27', title: '#e8eaee', badge: '#8b93a1',
    label: '#7f8896', value: '#eef0f4', sub: '#6f7887',
    accent: '#4c8dff', ok: '#79cf8e', warn: '#f0a35e', bad: '#e8917d'
  },
  light: {
    pageBg: '#eef1f5', cardBg: '#ffffff', border: '#dfe4ec',
    rowBg: '#f5f7fa', title: '#1c2430', badge: '#6a7484',
    label: '#6a7484', value: '#171e28', sub: '#8b94a4',
    accent: '#2f6fe0', ok: '#2f7d4a', warn: '#d97a2b', bad: '#c0392b'
  }
};

/* ── MOTD 配色 ────────────────────────────────────────────── */
/**
 * MC 的 16 个标准色，按卡片主题各给一套值。
 *
 * ⚠️ 为什么不能直接抄官方色值：官方 16 色是为**游戏内黑底聊天栏**设计的，
 *    black(#000000) / dark_blue(#0000AA) 在我们的深色卡片上基本是隐形的；
 *    反过来 white(#FFFFFF) / yellow(#FFFF55) 在浅色卡片上糊成一片白。
 *    这里两套表都只做**同色系调亮度**，不改色相 —— 红色还是红色，只是看得见。
 */
const MC_COLORS = {
  black: { dark: '#7c8494', light: '#1c2430' },
  dark_blue: { dark: '#6f8cff', light: '#24409e' },
  dark_green: { dark: '#4fc76a', light: '#15702c' },
  dark_aqua: { dark: '#45c8d0', light: '#16757c' },
  dark_red: { dark: '#e0686c', light: '#9c2427' },
  dark_purple: { dark: '#b47ce0', light: '#7d2a96' },
  gold: { dark: '#f0b45e', light: '#96650e' },
  gray: { dark: '#a9b1bf', light: '#5c6675' },
  dark_gray: { dark: '#8b93a1', light: '#454f5e' },
  blue: { dark: '#6f9dff', light: '#2f5fd0' },
  green: { dark: '#6ede84', light: '#177f37' },
  aqua: { dark: '#6fe0e8', light: '#0f7280' },
  red: { dark: '#ff8080', light: '#c0392b' },
  light_purple: { dark: '#ea9cea', light: '#a02f9e' },
  yellow: { dark: '#f2e97a', light: '#7d6900' },
  white: { dark: '#ffffff', light: '#3a4450' }
};

/**
 * 自定义 hex 色的可见性保底。
 * 服务器可以填任意 #rrggbb（比如 #0a0a0a），能合法通过校验但照样看不见。
 * 做法：保持色相比例，只把最亮通道拉到阈值以上（深色主题）或压到阈值以下（浅色主题）。
 */
function ensureVisible(hex, theme) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex));
  if (!m) return null;
  let r = parseInt(m[1].slice(0, 2), 16);
  let g = parseInt(m[1].slice(2, 4), 16);
  let b = parseInt(m[1].slice(4, 6), 16);
  const hi = Math.max(r, g, b);
  const lo = Math.min(r, g, b);
  if (theme === 'light') {
    // 浅底：三个通道都很亮才需要压暗（保留有色差的，比如 #ff0000 不用动）
    if (lo >= 200) { const k = 120 / lo; r = Math.round(r * k); g = Math.round(g * k); b = Math.round(b * k); }
  } else if (hi <= 90) {
    // 深底：整体太暗就整体提亮；纯黑（hi=0）给个中性灰，否则怎么提都是黑
    if (hi === 0) return '#7c8494';
    const k = 150 / hi;
    r = Math.min(255, Math.round(r * k)); g = Math.min(255, Math.round(g * k)); b = Math.min(255, Math.round(b * k));
  }
  const to2 = (n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}

/**
 * 片段颜色 → CSS 颜色。返回 null 表示「用默认文字色」。
 * ⚠️ 入参的 color 一定是 mcping.js 里 normalizeColor 校验过的（16 色名或合法 hex），
 *    这里不再重复校验，但——**绝不直接拼进 style**，只输出查表/算出来的值。
 */
export function mcColorToCss(color, theme) {
  if (!color) return null;
  if (MC_COLORS[color]) return MC_COLORS[color][theme === 'light' ? 'light' : 'dark'];
  return ensureVisible(color, theme === 'light' ? 'light' : 'dark');
}

/**
 * 彩色 MOTD → HTML。
 * ⚠️ 文本一律 esc() 转义 —— MOTD 是服务器管理员可控的任意字符串。
 * ⚠️ 只输出 color / font-weight / font-style / text-decoration 四种声明，
 *    样式值全部来自内部查表，没有任何一处拼原始字符串，堵死 style 注入。
 */
export function renderRichMotd(segs, theme) {
  if (!Array.isArray(segs) || !segs.length) return '';
  return segs.map((sg) => {
    const css = [];
    const c = mcColorToCss(sg.color, theme);
    if (c) css.push(`color:${c}`);
    if (sg.bold) css.push('font-weight:700');
    if (sg.italic) css.push('font-style:italic');
    const deco = [sg.underline && 'underline', sg.strike && 'line-through'].filter(Boolean).join(' ');
    if (deco) css.push(`text-decoration:${deco}`);
    const txt = esc(String(sg.text ?? ''));
    return css.length ? `<span style="${css.join(';')}">${txt}</span>` : txt;
  }).join('');
}

/* ── 历史（按小时聚合，供人数曲线用） ─────────────────────── */
/**
 * 存成 { "host:port": { "2026-09-21T21": { sum, n, max } } }。
 *
 * ⚠️ 不存明细、只存每小时聚合值：曲线只要"每小时多少人"，存明细会无限膨胀，
 *    而聚合桶的数量是固定的（服务器数 × 小时数），文件大小永远可控。
 * ⚠️ 只在**真的去查了**的时候写（缓存命中不算）：否则一次查询被反复复用，
 *    会把同一个数字记上几十次，把平均值拉偏。
 */
const MAX_FAVICON_BYTES = 200 * 1024;

export function sanitizeFavicon(v) {
  const s = String(v ?? '');
  // 只认 MC 标准的内嵌 PNG：不是这个前缀的一律丢（服务器管理员可以塞任意字符串，
  // 允许 http(s) 就会变成"每个查你服务器的人都被打点"，还可能在卡片里加载失败留白块）
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(s)) return '';
  if (s.length > MAX_FAVICON_BYTES) return '';
  return s;
}

function readHistory() {
  try {
    const j = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    return (j && typeof j === 'object' && !Array.isArray(j)) ? j : {};
  } catch { return {}; }
}

let historyCache = null;
const historyStore = () => (historyCache ||= readHistory());

/** 本地小时键：不能用 toISOString（UTC，北京时间 00:00-07:59 会算到前一天） */
export function hourKey(ts = Date.now()) {
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}`;
}

/** 5 分钟槽键：`2026-09-21T22:35`。同样必须按本地时区算（UTC 坑见 hourKey）。 */
export function slotKey(ts = Date.now()) {
  const d = new Date(ts);
  d.setMinutes(Math.floor(d.getMinutes() / 5) * 5, 0, 0);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 把一台服务器的桶展开成「槽键 → {sum,n,max}」。
 *
 * ⚠️ 兼容老数据（v1.2.5 及以前按小时存，键长 13 没有分钟位）：把那小时的平均值
 *    铺到它下面的 12 个槽上。这么做是因为**历史是"查询时顺手记"的** —— 直接丢弃
 *    会让用户升级后曲线突然空白、以为插件坏了；铺开虽然让老数据的那一小时变成平线，
 *    但形是对的（值本来就是那小时的平均），48 小时后自然被清掉。
 */
function slotMap(bucket) {
  const map = new Map();
  for (const [k, v] of Object.entries(bucket || {})) {
    if (!v || typeof v !== 'object') continue;
    if (k.length > 13) { map.set(k, v); continue; }          // v1.2.6+：5 分钟槽
    for (let m = 0; m < 60; m += 5) {                        // v1.2.5-：小时桶
      const kk = `${k}:${String(m).padStart(2, '0')}`;
      if (!map.has(kk)) map.set(kk, v);
    }
  }
  return map;
}

export function pushHistory(row, ts = Date.now()) {
  if (!row || typeof row.host !== 'string' || !row.host) return;   // 连 host 都没有的失败（本地配置错）没有画的意义
  const store = historyStore();
  const k = `${row.host}:${row.port}`;
  const bucket = (store[k] ||= {});
  const sk = slotKey(ts);
  const cur = bucket[sk] || { sum: 0, n: 0, max: 0 };
  if (row.ok === true && row.online === true) {
    const n = Number(row.playersOnline);
    if (!Number.isFinite(n)) return;
    // down 计数要保留：同一个槽里可能先失败后成功（短暂抖动），成功样本不能把失败痕迹抹掉
    bucket[sk] = { sum: cur.sum + n, n: cur.n + 1, max: Math.max(cur.max, n), down: cur.down || 0 };
  } else {
    // 断连留痕（2026-09-22 用户要求：断连时段在曲线上画红色竖带）。
    // 以前离线直接不记 —— 结果"断连"和"压根没查过"无法区分，红带画不出来。
    // 只记 down 计数、不碰 sum/n：数值序列照旧缺数据断开，不会出现"掉到 0"的假摔，
    // 红色只来自 down。ok=false（查不通）和 online=false（服务器报离线）都算断连。
    bucket[sk] = { ...cur, down: (cur.down || 0) + 1 };
  }
  // 清掉过老的桶。keep 里同时保留 **小时键**，是为了让 v1.2.5 之前写的老历史
  // 还能被读到（读法见 slotMap）—— 它们会随着时间自己过期，不需要专门迁移步骤。
  const keep = new Set();
  for (let i = 0; i < HISTORY_HOURS; i++) {
    const back = ts - i * 3600_000;
    keep.add(hourKey(back));
    for (let j = 0; j < SLOTS_PER_HOUR; j++) keep.add(slotKey(back - j * SLOT_MS));
  }
  for (const key of Object.keys(bucket)) if (!keep.has(key)) delete bucket[key];
  saveHistory(store);
}

/**
 * 把粒度取值夹到合法范围：**5 分钟的整数倍**（历史桶就是 5 分钟一个，非整倍数会对不齐），
 * 下限 5 分钟、上限 240 分钟（= 4 小时，滑块最大档）。
 *
 * ⚠️ 2026-09-22 之前只认 SLOT_CHOICES 那五个固定档 —— 于是"我每 20 分钟查一次"会被
 *    夹回 5 分钟，图上一段的长度和用户真实查询频次对不上（用户原话："每一段按照查询
 *    频次来画，比如 15、20、30 这样"）。存储始终是 5 分钟桶，所以只要是 5 的倍数
 *    都能对得齐，不需要限制档位。
 */
export function normalizeSlotMin(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 5;
  return Math.max(5, Math.min(240, Math.round(n / 5) * 5));
}

/** 一个点覆盖几个存储槽：15 分钟一点 = 3 个 5 分钟槽 */
const slotsPerPoint = (slotMin) => Math.max(1, Math.round(slotMin / 5));

/**
 * **图上一段的长度（分钟）= 自动采集的间隔** —— 2026-09-22 用户要求"查询跟图表这个
 * 时间段强绑定"。
 *
 * 以前这是两个独立的设置（段长随便选、采集间隔另填），结果经常对不上：段画得比查询
 * 还密 → 一大片空格子"刚查完却看不见"；查询比段还密 → 一段里塞好几个样本白费力气。
 * 现在**只有一个开关**：选 20 分钟 = 后台每 20 分钟自动查一次 = 图上一段正好 20 分钟，
 * 一轮采样不多不少落进一个点。
 *
 * 可选 5 / 10 / 15 / 20 / 30 / 60 / 90 / 120 / 240 分钟（旧版的 trendAutoIntervalSec 已废弃，见下）。
 * ⚠️ 这里必须和 plugin.json 里 trendSlotMinutes 的 stops **逐项一致** —— 滑块显示什么档、
 *    插件认什么档，两边不一致就会出现"拖到 60 却被夹回 30"（测试里有断言盯着）。
 */
export const SLOT_CHOICES = [5, 10, 15, 20, 30, 60, 90, 120, 240];
const DEFAULT_SLOT_MIN = 15;

/** 设置里选的段长：非法值回落到默认 15 分钟 */
export function trendSlotMin(cfg = {}) {
  const raw = Number(cfg.trendSlotMinutes);
  if (!Number.isFinite(raw) || raw <= 0) {
    // 兼容 v1.2.15 那版的 "0 = 自动"：那时没有强绑定，0 表示跟随采集间隔。
    // 现在段长就是采集间隔，0/未设置一律按默认 15 分钟，避免老配置升级后曲线画不出来。
    const legacy = Number(cfg.trendAutoIntervalSec);
    return Number.isFinite(legacy) && legacy > 0 ? normalizeSlotMin(legacy / 60) : DEFAULT_SLOT_MIN;
  }
  return normalizeSlotMin(raw);
}

/**
 * 当前**实际采样周期**（秒）：取所有"会自动查服务器"的来源里最密的那个。
 *
 * 三个来源：① 曲线自动采集（trendAutoEnabled，间隔 = 段长）② 人数播报轮询
 * （watchEnabled + 填了群号）③ 用户手动发 `\服务器`（不定时，不计入周期）。
 * 返回 0 = 没有任何定时采样，图上只有手动查询留下的零散样本。
 */
export function samplingIntervalSec(cfg = {}) {
  const list = [];
  if (cfg.trendAutoEnabled === true) list.push(trendSlotMin(cfg) * 60);
  // 播报没填群号时 startWatch 根本不会启动，不能把它算进采样周期
  if (cfg.watchEnabled === true && String(cfg.watchGroups || '').trim()) {
    list.push(Math.max(30, Number(cfg.watchIntervalSec) || 120));
  }
  return list.length ? Math.min(...list) : 0;
}

/**
 * 曲线粒度：一段代表多少分钟 —— **就是设置里选的那个值**，不再被别的周期改动。
 *
 * ⚠️ 这里刻意不做"按轮询/采样周期抬高"的兜底了（v1.2.15 之前有）：段长与查询频次
 *    已经强绑定，采集必定按段长跑，兜底只会让用户选的档位看起来没生效。真出现空格子
 *    只可能是两种合理情况 —— 采集被关掉了，或那段时间确实没查通（后者画成红色断连带）。
 *
 * @param {object} cfg 插件配置
 * @returns {{slotMin:number, wantMin:number, byWatch:boolean, auto:boolean, periodSec:number}}
 *          slotMin=实际画图粒度；wantMin=用户设置值；byWatch=恒 false（保留字段，卡片文案要用）；
 *          auto=是否用了默认值（没选/选了非法值）；periodSec=采集周期秒数（0=无定时采集）
 */
export function resolveSlotMin(cfg = {}) {
  const raw = Number(cfg.trendSlotMinutes);
  const auto = !Number.isFinite(raw) || raw <= 0;
  const slotMin = trendSlotMin(cfg);
  return { slotMin, wantMin: slotMin, byWatch: false, auto, periodSec: slotMin * 60 };
}

function saveHistory(store) {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(store)); } catch { /* 写不了不影响主流程 */ }
}

/**
 * 取某台服务器最近 hours 小时的序列（缺数据的点为 null，画图时断开而不是画成 0）
 * @param {number} slotMin 一个点代表多少分钟（5/10/15/30/60）
 * @returns {{slots:string[], values:(number|null)[], peak:number, avg:number, samples:number, slotMin:number}}
 */
export function seriesOf(row, hours = 24, now = Date.now(), slotMin = 5) {
  const step = normalizeSlotMin(slotMin);
  const per = slotsPerPoint(step);
  const store = historyStore();
  const map = slotMap(store[`${row.host}:${row.port}`] || {});
  const count = Math.max(2, Math.round((hours * 60) / step));
  const out = [];
  const downs = [];
  const labels = [];
  for (let i = count - 1; i >= 0; i--) {
    const endTs = now - i * step * 60_000;
    let sum = 0; let n = 0; let dn = 0;
    for (let j = 0; j < per; j++) {
      const b = map.get(slotKey(endTs - j * SLOT_MS));
      if (!b) continue;
      if (b.n > 0) { sum += b.sum; n += b.n; }
      if (b.down > 0) dn += b.down;
    }
    out.push(n > 0 ? Math.round(sum / n) : null);
    // 断连判定：窗口里**查过且全失败**（有 down 样本、没有成功样本）。
    // 成功失败混在同一窗 = 短暂抖动，照常画值，不画红 —— 否则轮询密的时候偶发一次
    // 超时就把整段染红，红色就不值钱了。老历史没有 down 字段，undefined 不会命中。
    downs.push(n === 0 && dn > 0);
    labels.push(slotKey(endTs));
  }
  const nums = out.filter((x) => x != null);
  return {
    slots: labels,
    values: out,
    down: downs,
    peak: nums.length ? Math.max(...nums) : 0,
    avg: nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : 0,
    samples: nums.length,
    slotMin: step
  };
}

/* ── 查询（带短缓存） ────────────────────────────────────── */
// 缓存只放很短时间：MC 服务器状态变化快（有人进进出出），但连续追问「那我的服呢」
// 不该每次都重新握手。默认 30 秒。
const cache = new Map();
const cacheKey = (s) => `${st().source || 'direct'}::${s.edition}::${s.host}::${s.port}`;

export async function queryOne(server, { force = false } = {}) {
  const cfg = st();
  const key = cacheKey(server);
  const ttl = Math.max(0, Number(cfg.cacheSeconds ?? 30)) * 1000;
  const hit = cache.get(key);
  if (!force && hit && ttl > 0 && Date.now() - hit.at < ttl) {
    return { ...hit.data, cached: true };
  }
  const src = getSource(cfg.source);
  const data = await src.fetch(server, cfg, fetchRef);
  data.cached = false;
  if (data.ok) cache.set(key, { at: Date.now(), data });
  try { pushHistory(data); } catch { /* 历史写不了不能影响查询 */ }
  return data;
}

/** 解析用户点名的服务器：在配置列表里按名称/地址模糊匹配 */
export function matchServers(input) {
  const all = parseServers(st().servers);
  const q = String(input ?? '').trim();
  if (!q) return all;
  const low = q.toLowerCase();
  // 完全命中优先，其次子串
  const exact = all.filter((s) => s.name.toLowerCase() === low || s.host.toLowerCase() === low);
  if (exact.length) return exact;
  const partial = all.filter((s) => s.name.toLowerCase().includes(low) || s.host.toLowerCase().includes(low));
  return partial.length ? partial : [];
}

/* ── 临时地址（群里直接甩一个地址来查） ───────────────────── */
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;
const DOMAIN = /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
// IPv6 字面量（含至少两个冒号，避免把域名里的冒号误判进来）
const IPV6 = /^[0-9a-fA-F]{0,4}(?::[0-9a-fA-F]{0,4}){2,7}$/;

/** 内网/保留地址：机器人不该被群里一句话支使着去连这些 */
export function isPrivateIp(ip) {
  const v = String(ip ?? '').trim();
  if (/^::1$|^::$|^fc/i.test(v)) return true;                       // IPv6 回环 / 唯一本地
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;                          // 链路本地
  if (a >= 224) return true;                                        // 组播/保留
  return false;
}

/**
 * 解析「服务器 + 地址」里的地址部分。
 * 支持：mc.hypixel.net / mc.hypixel.net:25566 / 1.2.3.4:25565 /
 *       [::1]:25565 / play.xxx.com|bedrock
 * @returns {{name:string,host:string,port:number,edition:string}|null} 不像地址就返回 null
 */
export function parseAdhoc(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const s = raw.replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '').trim();
  const parts = s.split('|').map((x) => x.trim());
  const addr = parts[0] || '';
  const edition = String(parts[1] || '').toLowerCase() === 'bedrock' ? 'bedrock' : 'java';
  let host = addr;
  let port = null;
  const m6 = /^\[([^\]]+)\]:(\d+)$/.exec(addr);
  const m4 = /^(.+):(\d+)$/.exec(addr);
  if (m6) { host = m6[1]; port = Number(m6[2]); }
  else if (m4) { host = m4[1]; port = Number(m4[2]); }
  if (!host) return null;
  // ⚠️ 只有"确实像地址"才认：否则用户打个「服务器呢」也被当成主机名去连，很蠢
  if (!IPV4.test(host) && !DOMAIN.test(host) && !IPV6.test(host)) return null;
  if (port != null && (!Number.isInteger(port) || port < 1 || port > 65535)) return null;
  const p = port || (edition === 'bedrock' ? 19132 : 25565);
  return { name: `${host}:${p}`, host, port: p, edition };
}

/**
 * 临时地址的安全闸：不许连内网/本机。
 * ⚠️ 群里谁都能发一句话让机器人去连 —— 不加这道闸，"\服务器 你的内网IP:22"
 *    就变成了一个内网端口扫描器（还能用响应差异判断端口开没开）。
 *    域名也查一遍解析结果：光看字面量的话，把内网 IP 绑到域名上就绕过去了。
 * @returns {Promise<string>} 空串 = 放行；非空 = 拒绝原因
 */
export async function adhocGuard(host, { allowPrivate = false } = {}) {
  if (allowPrivate === true) return '';
  if (isPrivateIp(host)) return '这个地址是内网/本机地址，不能查';
  if (IPV4.test(host)) return '';
  try {
    const dns = await import('node:dns');
    const list = await dns.promises.lookup(host, { all: true });
    if (list.some((x) => isPrivateIp(x.address))) return '这个域名解析到了内网地址，不能查';
  } catch { /* 解析失败就让它去连，连不通自然报错 */ }
  return '';
}

export async function queryAll(servers, opt = {}) {
  // 并发查：多个服务器时串行会慢到没法用（每个握手都要往返）
  return Promise.all(servers.map((s) => queryOne(s, opt).catch((e) => ({
    ok: false, online: false, name: s.name, host: s.host, port: s.port,
    edition: s.edition, version: '', protocol: null, playersOnline: null,
    playersMax: null, sample: [], motd: '', motdRich: [], latency: null,
    error: String(e?.message || e), source: st().source || 'direct', queriedAt: Date.now()
  }))));
}

/* ── 文案 ────────────────────────────────────────────────── */
/**
 * HTML 转义（卡片图用）。
 * ⚠️ 不能用 src/util.js 的 escapeCqText —— 那个只把 [CQ: 换成 [CQ：，是防 QQ 特殊码的，
 *    挡不住 <script>。而 MOTD 是**服务器返回的任意字符串**，服务器管理员想塞什么就塞什么，
 *    不转义的话一张卡片就能把 HTML 结构破坏掉（跟 weather-card 第 278 行同一套写法）。
 */
const esc = (x) => String(x ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

/** 延迟分级：跟玩家手感对齐（<100 流畅 / <200 还行 / <400 有点卡 / 更高 难受） */
export function latencyLevel(ms) {
  if (ms == null) return { text: '', color: 'label' };
  if (ms < 100) return { text: `${ms}ms 流畅`, color: 'ok' };
  if (ms < 200) return { text: `${ms}ms 良好`, color: 'ok' };
  if (ms < 400) return { text: `${ms}ms 偏卡`, color: 'warn' };
  return { text: `${ms}ms 很卡`, color: 'bad' };
}

/**
 * 卡片最多画多少台（其余只在文字摘要里）。
 * ⚠️ 卡片高度没有上限，服务器一多图就长得没法看（实测 10 台 = 1280×2100，
 *    发到 QQ 里缩成一团）。超过就只画前 N 台，脚注写明总数；
 *    文字摘要仍是**全量**，用户追问「第 9 台呢」照样答得出来。0 = 不限制。
 */
export function pickCardRows(rows, maxRaw = 8) {
  const max = Math.max(0, Number(maxRaw) || 0);
  const all = Array.isArray(rows) ? rows : [];
  if (max === 0) return { cardRows: all, hiddenCount: 0 };
  return { cardRows: all.slice(0, max), hiddenCount: Math.max(0, all.length - max) };
}

/**
 * 图片发出后回给模型的那段文本（模型看不见图，这是它唯一依据）。
 *
 * ⚠️ 多台服务器必须**一行一台**：跟 weather-card 1.7.3 同一个坑 —— 原来用「；」连成
 *    一行，模型只挑开头复述，查了 5 台回复里只提 1 台，用户以为另外几台没查到。
 *    分行 + 开头报「共 N 台」，模型才有可自查的清单。
 * ⚠️ 卡片可能因 maxCardRows 只画了前几台，但这里必须给**全量**摘要 —— 用户追问
 *    「第 9 台呢」时模型只能靠这段答。
 */
export function cardSummary(rows, cardCount = rows.length, hiddenCount = 0) {
  return `服务器状态卡已发出（共 ${rows.length} 台）：\n`
    + rows.map((r) => `· ${briefOf(r)}`).join('\n')
    + (hiddenCount ? `\n（卡片只画了前 ${cardCount} 台，上面是全部 ${rows.length} 台的摘要）` : '');
}

/**
 * 纯提示性返回：既是给模型的 content，也是**可以直接发到群里**的文本。
 *
 * 为什么要有它：指令直达（commandRoute）不经过模型，系统只能挑标了 `_directText`
 * 的内容发送 —— 而这条链路下如果不标，用户发了指令却收不到任何回复（工具既没发图、
 * 系统又不敢把 content 原样发出去，怕里面混着给模型的措辞）。
 * 像"还没配置服务器""没找到匹配"这类提示本身就是给人看的，标上就对了。
 */
function asDirect(content) {
  return { content, _directText: content };
}

/** 单行摘要（给模型看的核心句） */
export function briefOf(r) {
  if (!r.ok) return `${r.name}（${r.host}:${r.port}）查询失败：${r.error || '未知原因'}`;
  if (!r.online) return `${r.name}（${r.host}:${r.port}）离线`;
  const ppl = r.playersOnline != null ? `${r.playersOnline}${r.playersMax != null ? `/${r.playersMax}` : ''} 人` : '人数未知';
  const lat = r.latency != null ? `，延迟 ${r.latency}ms` : '';
  const ver = r.version ? `，${r.edition === 'bedrock' ? '基岩版' : 'Java 版'} ${r.version}` : '';
  const motd = r.motd ? `，MOTD「${r.motd}」` : '';
  const who = r.sample.length ? `，在线玩家 ${r.sample.slice(0, 8).join('、')}` : '';
  return `${r.name}（${r.host}:${r.port}）在线，${ppl}${lat}${ver}${motd}${who}`;
}

/** 文字卡（图片渲染不出来时的兜底，也是纯文字模式的正式输出） */
export function textCard(rows) {
  const t = new Date();
  const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  const lines = [`🎮 服务器状态 · ${hhmm}`];
  for (const r of rows) {
    if (!r.ok) {
      lines.push(`⚠️ ${r.name}（${r.host}:${r.port}）查询失败 —— ${r.error || '未知原因'}`);
      continue;
    }
    if (!r.online) {
      lines.push(`🔴 ${r.name}（${r.host}:${r.port}）离线${r.error === '服务器离线' ? '' : ` —— ${r.error || ''}`}`);
      continue;
    }
    const ppl = r.playersOnline != null
      ? `${r.playersOnline}${r.playersMax != null ? `/${r.playersMax}` : ''} 人在线` : '人数未知';
    const lat = r.latency != null ? ` · 延迟 ${r.latency}ms` : '';
    const ver = r.version ? ` · ${r.version}` : '';
    lines.push(`🟢 ${r.name}${r.name !== r.host ? `（${r.host}:${r.port}）` : ''} ${ppl}${lat}${ver}`);
    if (r.motd) lines.push(`　${r.motd}`);
    if (r.sample.length) lines.push(`　玩家：${r.sample.slice(0, 10).join('、')}${r.sample.length > 10 ? ` 等 ${r.sample.length} 人` : ''}`);
  }
  return lines.join('\n');
}

/* ── 卡片渲染 ────────────────────────────────────────────── */
/**
 * 多台时的汇总行。只有 1 台时不显示（那一行跟下面重复，纯占地方）。
 * ⚠️ 人数只累加**在线且拿到了人数**的台，查不通/离线的不能当 0 加进去 —— 加起来会
 *    让人以为服务器是空的。
 */
export function summarize(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length < 2) return null;
  const online = list.filter((r) => r.ok && r.online);
  let players = 0;
  let counted = 0;
  for (const r of online) {
    // ⚠️ 必须先判 != null：Number(null) 是 0，不加这道判断会把"人数未知"当 0 加进总数
    if (r.playersOnline == null) continue;
    const n = Number(r.playersOnline);
    if (Number.isFinite(n)) { players += n; counted++; }
  }
  const bad = list.length - online.length;
  return { total: list.length, online: online.length, bad, players, counted };
}

function summaryHtml(rows, t, s) {
  const sum = summarize(rows);
  if (!sum) return '';
  const parts = [`<span>在线 <b>${sum.online}</b> / ${sum.total} 台</span>`];
  if (sum.counted > 0) parts.push(`<span>共 <b>${sum.players}</b> 人在线</span>`);
  if (sum.bad > 0) parts.push(`<span style="color:${t.warn}">${sum.bad} 台离线或查不通</span>`);
  return `  <div class="summary">${parts.join('')}</div>`;
}

export function buildStatusHtml(rows, { theme = 'dark', scale = 2, hiddenCount = 0, colorMotd = true } = {}) {
  const t = THEMES[theme] || THEMES.dark;
  const s = (px) => Math.round(px * scale);
  /**
   * MOTD 行。优先用彩色片段；片段为空（或用户关了彩色）就退回整段纯文本。
   * ⚠️ 判定用「片段里有没有真带颜色」而不是「片段数组非空」：
   *    纯白 MOTD 解析出来片段是有的，但全是默认色，走彩色路径只是白绕一圈。
   */
  const motdHtml = (r) => {
    const segs = colorMotd && Array.isArray(r.motdRich) && r.motdRich.some((x) => x.color)
      ? renderRichMotd(r.motdRich, theme) : '';
    const txt = segs || (r.motd ? esc(r.motd) : '');
    return txt ? `<div class="rmotd">${txt}</div>` : '';
  };
  const rowsHtml = rows.map((r) => {
    if (!r.ok) {
      return `
  <div class="row off">
    <div class="ric">⚠️</div>
    <div class="rmain">
      <div class="rname">${esc(r.name)}</div>
      <div class="rsub">${esc(r.host)}:${esc(r.port)} · ${esc(r.error || '查询失败')}</div>
    </div>
  </div>`;
    }
    if (!r.online) {
      return `
  <div class="row off">
    <div class="ric">🔴</div>
    <div class="rmain">
      <div class="rname">${esc(r.name)}</div>
      <div class="rsub">${esc(r.host)}:${esc(r.port)} · 离线${r.error && r.error !== '服务器离线' ? ` · ${esc(r.error)}` : ''}</div>
    </div>
  </div>`;
    }
    const lat = latencyLevel(r.latency);
    const ppl = r.playersOnline != null
      ? `${r.playersOnline}${r.playersMax != null ? ` / ${r.playersMax}` : ''}` : '—';
    const meta = [
      r.version ? `${r.edition === 'bedrock' ? '基岩' : 'Java'} ${esc(r.version)}` : '',
      lat.text ? `<span style="color:${t[lat.color]}">${esc(lat.text)}</span>` : ''
    ].filter(Boolean).join(' · ');
    // 服务器图标：status 响应自带，不用额外请求。sanitizeFavicon 已挡掉非内嵌 PNG 的异常值
    const icon = sanitizeFavicon(r.favicon);
    return `
  <div class="row">
    <div class="ric">${icon ? `<img class="ricon" src="${icon}">` : '🟢'}</div>
    <div class="rmain">
      <div class="rname">${esc(r.name)}</div>
      <div class="raddr">${esc(r.host)}:${esc(r.port)}</div>
      <div class="rstat">
        <span class="ppl">${esc(ppl)}</span><span class="unit">人在线</span>
        ${meta ? `<span class="meta">${meta}</span>` : ''}
      </div>
      ${motdHtml(r)}
      ${(() => {
        // Query 给了**完整**名单就用它；没有就退回 sample（只是样本，可能是残缺的）
        const names = (r.query && Array.isArray(r.query.players) && r.query.players.length)
          ? r.query.players : (r.sample || []);
        if (!names.length) return '';
        const shown = names.slice(0, 12).join('、');
        const more = names.length > 12 ? ` 等 ${names.length} 人` : '';
        return `<div class="rplayers">${esc(shown + more)}</div>`;
      })()}
      ${(r.query && r.query.map) ? `<div class="rplayers">地图 ${esc(r.query.map)}${r.query.gameType ? ` · ${esc(r.query.gameType)}` : ''}</div>` : ''}
    </div>
  </div>`;
  }).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html { overflow:hidden; background:${t.pageBg}; }
  body {
    background:${t.pageBg}; color:${t.value};
    font-family:"Microsoft YaHei UI","Microsoft YaHei","PingFang SC",system-ui,sans-serif;
    width:${s(CARD_W)}px; padding:${s(14)}px;
  }
  .card { background:${t.cardBg}; border:1px solid ${t.border}; border-radius:${s(12)}px; overflow:hidden; }
  .head { padding:${s(12)}px ${s(16)}px; border-bottom:1px solid ${t.border}; display:flex; align-items:baseline; gap:${s(8)}px; }
  .htitle { font-size:${s(15)}px; font-weight:600; color:${t.title}; }
  .hsub { font-size:${s(11)}px; color:${t.badge}; }
  .row { padding:${s(12)}px ${s(16)}px; display:flex; gap:${s(12)}px; align-items:flex-start; }
  /* ⚠️ 分隔线只能画在「行与行之间」。原来是「每行都画上边框 + 首行去掉」的写法，
     但 .card 的第一个子元素是 .head，压根没有哪个 .row 是首个子元素 —— 那条去掉的规则
     永远不生效，结果第一行上方叠了 .head 的下边框 + 自己的上边框两条 1px 线（看着像 2px 粗线）。
     改成「只有前一行也是 .row 才画上边框」才是对的。 */
  .row + .row { border-top:1px solid ${t.border}; }
  .row.off { background:${t.rowBg}; }
  .ric { font-size:${s(18)}px; line-height:1.2; width:${s(24)}px; text-align:center; flex:0 0 ${s(24)}px; }
  /* 服务器图标：status 响应自带的 64×64 PNG，缩到 24px 显示；pixelated 保住像素风不糊 */
  .ricon { width:${s(24)}px; height:${s(24)}px; border-radius:${s(4)}px; image-rendering:pixelated; display:block; }
  .summary { padding:${s(8)}px ${s(16)}px; border-bottom:1px solid ${t.border}; background:${t.rowBg};
             font-size:${s(11)}px; color:${t.sub}; display:flex; gap:${s(10)}px; flex-wrap:wrap; }
  .summary b { color:${t.value}; font-weight:600; }
  .rmain { flex:1; min-width:0; }
  .rname { font-size:${s(14)}px; font-weight:600; color:${t.title}; }
  .raddr { font-size:${s(11)}px; color:${t.badge}; margin-top:${s(1)}px; }
  .rstat { margin-top:${s(5)}px; display:flex; align-items:baseline; gap:${s(6)}px; flex-wrap:wrap; }
  .ppl { font-size:${s(20)}px; font-weight:700; color:${t.accent}; }
  .unit { font-size:${s(11)}px; color:${t.label}; }
  .meta { font-size:${s(11)}px; color:${t.sub}; }
  .rmotd { margin-top:${s(5)}px; font-size:${s(12)}px; color:${t.value}; word-break:break-all; }
  .rplayers { margin-top:${s(4)}px; font-size:${s(11)}px; color:${t.sub}; word-break:break-all; }
  .rsub { font-size:${s(12)}px; color:${t.sub}; margin-top:${s(3)}px; }
  .foot { padding:${s(9)}px ${s(16)}px; border-top:1px solid ${t.border}; font-size:${s(10)}px; color:${t.badge}; }
</style></head><body>
<div class="card">
  <div class="head">
    <div class="htitle">🎮 服务器状态</div>
    <div class="hsub">${new Date().toLocaleString('zh-CN', { hour12: false })}</div>
  </div>
  ${summaryHtml(rows, t, s)}
  ${rowsHtml}
  <div class="foot">数据源：${esc(getSource(st().source).label)}${rows.some((r) => r.cached) ? ' · 部分结果来自缓存' : ''}${hiddenCount > 0 ? ` · 卡片只画前 ${rows.length} 台（共 ${rows.length + hiddenCount} 台）` : ''}</div>
</div>
</body></html>`;
}

/**
 * 多台时把各台的小时序列合成一条"合计"线。
 * ⚠️ 某小时**部分台**缺数据：只在**所有台都缺**时才算断开，否则把有的那些加起来
 *    （加个括号说明是合计）。反过来（有缺失就断开）会让曲线动不动整段消失，更没用。
 */
export function mergeSeries(rows, hours = 24, now = Date.now(), slotMin = 5) {
  const step = normalizeSlotMin(slotMin);
  const list = (Array.isArray(rows) ? rows : []).filter(Boolean);
  if (!list.length) return null;
  if (list.length === 1) {
    const one = seriesOf(list[0], hours, now, step);
    return { ...one, label: list[0].name || `${list[0].host}:${list[0].port}`, merged: false };
  }
  const all = list.map((r) => seriesOf(r, hours, now, step));
  const values = [];
  const downs = [];
  for (let i = 0; i < all[0].values.length; i++) {
    const vs = all.map((a) => a.values[i]).filter((v) => v != null);
    values.push(vs.length ? vs.reduce((a, b) => a + b, 0) : null);
    // 合并视图的断连 = 这个时间窗里**至少有一台**查询失败（2026-09-22 用户改口径）。
    //
    // ⚠️ 1.2.14 定的是「全部失败才算红」，理由是别冤枉活着的服务器。但那样一来
    //    「一台断了、别的活着」在图上只剩一个断口，和「那会儿根本没查过」长得一样，
    //    看不出是哪台断了、也不知道是断了还是没查 —— 红色丢掉了它最重要的信息量。
    //    现在改成：有任一台断就画红带，**还活着的服务器线条照画并压在红带上面**
    //    （用户原话「正常服务器的颜色线直接从红带上面压上去」）。
    //    于是两种断连一眼分得开：全断 = 红带裸露、线上是断口；部分断 = 线压过红带。
    //    渲染顺序见 buildTrendHtml：downBands 在 perPaths **之前**输出，后者天然盖在上面。
    downs.push(all.some((a) => a.down?.[i] === true));
  }
  const nums = values.filter((v) => v != null);
  return {
    slots: all[0].slots,
    values,
    down: downs,
    peak: nums.length ? Math.max(...nums) : 0,
    avg: nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : 0,
    samples: nums.length,
    slotMin: step,
    label: `${list.length} 台合计`,
    merged: true
  };
}

/* ── 人数曲线卡 ──────────────────────────────────────────── */
/**
 * 近 24 小时每小时在线人数折线。
 * 用内联 SVG 而不是图表库：本项目插件一律零依赖，且渲染走 Electron 截图，
 * SVG 缩放后字也是清晰的（viewBox 逻辑坐标 + 宽度两倍）。
 */
export function buildTrendHtml(series, { theme = 'dark', scale = 2, hours = 24, detailRows = 8, perServer = [], slotNote = '' } = {}) {
  const t = THEMES[theme] || THEMES.dark;
  const s = (px) => Math.round(px * scale);
  const W = CARD_W;
  const H = 190;
  const padL = 30; const padR = 12; const padT = 14; const padB = 22;
  const slotMin = normalizeSlotMin(series?.slotMin ?? 5);
  // 标签数组统一走这里：老调用方传的还是 hours（已改名 slots），不能直接 series.slots[i] ——
  // 一旦是 undefined，下面明细区会整片崩掉（TypeError: reading '0'）。
  const slots = series?.slots || series?.hours || [];
  // 点数跟着实际序列走：以前 = hours（每小时一个点），现在 = hours×60/slotMin
  // （5 分钟粒度下 24 小时就是 288 个点）
  const n = Math.max(2, (series?.values || []).length || Math.round((hours * 60) / slotMin));

  // "空" = 既没有人数样本、也没有断连记录 —— 全是断连时也要出图（红带就是信息），
  // 不能回落到"还没有数据"的引导语，那会让"服务器挂了一整天"看起来像"没查过"。
  const empty = !series || (!series.values.some((v) => v != null) && !(series.down || []).some(Boolean));
  const maxY = Math.max(1, Math.ceil((series?.peak || 1) * 1.2));
  const x = (i) => padL + (i * (W - padL - padR)) / (n - 1);
  const y = (v) => padT + (1 - v / maxY) * (H - padT - padB);

  // 连线规则：缺数据的地方断开，不能一条 polyline 连过去（连过去等于谎报"那段是 0 人"）。
  // 另外**差距太大的相邻两点也断开** —— 2026-09-22 用户要求（原话：不相干就是指数据差距太大）。
  //   这种情况基本是中间缺了很久的样本（服务器掉线/重启/换服），硬连一根陡坡，等于告诉用户
  //   "人数在这几分钟里从 2 平滑涨到 20"，那段是我们没采到的，不是平滑过渡 —— 不能编。
  //   门槛设两道：绝对差 >= JUMP_MIN 人 **且** 相对差占较大值 >= JUMP_RATIO。
  //   只用相对的话 2→3 会被误判成剧变，只用绝对的话 60→80 又会被当成平稳。
  //   断口两端各自留一颗点，样本不会因此隐形。
  const JUMP_MIN = 5;
  const JUMP_RATIO = 0.6;
  const broken = (a, b) => (a == null || b == null
    || (Math.abs(b - a) >= JUMP_MIN && Math.abs(b - a) / Math.max(a, b) >= JUMP_RATIO));
  const vals = series?.values || [];
  // 2026-09-22：曾改成「密粒度下数值一变就断开」，但那是**误读用户意图**，已撤回
  // （用户原话只是"不相干可以不画"，不是"数值不同就不连"）。
  // 现在的规则回到：只有明显跳变（broken，绝对差 >= 5 且相对差 >= 60%）才断开，
  // 普通的小幅波动（4→5）照常连成折线 —— 这才是趋势图该有的样子。
  // 折线段拼装收成函数（2026-09-22 多服务器各画一条线时复用 —— 断开规则抄两份，
  // 改一处忘一处必然发生）。vals = 一条线的数值数组。
  const pathOf = (vals, dy = 0) => {
    const linkedToPrev = (i) => i > 0 && vals[i - 1] != null && vals[i] != null && !broken(vals[i - 1], vals[i]);
    let d = '';
    let seg = [];
    vals.forEach((v, i) => {
      // 本点和上一点连不上（没数据 / 差距太大）→ 先把已攒的那段收笔，再从本点另起一段
      if (v == null || (i > 0 && !linkedToPrev(i))) {
        if (seg.length) { d += `M${seg.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' L')}`; seg = []; }
        if (v == null) return;
      }
      // dy：重合错位偏移（见 perPaths 的重合检测），只动显示、不动数值
      seg.push([x(i), y(v) - dy]);
    });
    if (seg.length) d += `M${seg.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' L')}`;
    return d;
  };
  const d = pathOf(vals);

  // 圆点只画「没连上线」的点（孤立点、断口两端、峰值）。收成函数供每条服务器线复用。
  //   ⚠️ 不能每个点都画：5 分钟粒度下人数平稳时几十个点连成一线，每点一颗就糊成一条粗带
  //   （2026-09-22 用户反馈"条太粗"）。孤立点仍必须画 —— 单点用 M/L 折线画不出任何东西，
  //   不画等于让这些样本集体隐形。点数多时半径收小（dense），峰值点永远画大且换强调色。
  // ⚠️ dense/dotsOf 必须定义在多线渲染（perPaths）之前 —— 多线的孤立点也要靠它画。
  const dense = n > 72;
  const dotsOf = (vals, peakVal, plainColor, peakColor = t.accent, dy = 0) => {
    const linkedToPrev = (i) => i > 0 && vals[i - 1] != null && vals[i] != null && !broken(vals[i - 1], vals[i]);
    return vals.map((v, i) => {
      if (v == null) return '';
      const isPeak = peakVal > 0 && v === peakVal;
      if (!isPeak && (linkedToPrev(i) || linkedToPrev(i + 1))) return '';   // 和左/右任一连着 → 线已表达，不叠点
      return `<circle cx="${x(i).toFixed(1)}" cy="${(y(v) - dy).toFixed(1)}" r="${isPeak ? 1.8 : (dense ? 0.9 : 1.3)}" fill="${isPeak ? peakColor : plainColor}"/>`;
    }).join('');
  };

  // ── 断连红色带（2026-09-22 用户手绘草图：红色竖条盖住断连时段）──────────
  // downs[i]=true 表示这个时间段**发起过查询但全部失败**。画成从图顶到基线的
  // 半透明红条，连续的断连点并成一整条（一次 20 分钟的断连不该裂成 4 条细红条）。
  // 与"缺数据断开"的区分：断开=那个时段根本没查过（留空白），红色=查了但连不上 ——
  // 两种空 causally 不同，用户关心的是后者（服务器挂没挂）。
  const downs = series?.down || [];
  const downCount = downs.filter(Boolean).length;
  const half = (W - padL - padR) / Math.max(1, n - 1) / 2;
  const downRuns = [];
  {
    let run = null;
    downs.forEach((isDown, i) => {
      if (isDown) { if (!run) run = [i, i]; else run[1] = i; }
      else if (run) { downRuns.push(run); run = null; }
    });
    if (run) downRuns.push(run);
  }
  const downBands = downRuns.map(([a, b]) => {
    const x0 = Math.max(padL, x(a) - half);
    const x1 = Math.min(W - padR, x(b) + half);
    return `<rect x="${x0.toFixed(1)}" y="${padT}" width="${Math.max(2, x1 - x0).toFixed(1)}" height="${(H - padT - padB).toFixed(1)}" fill="#e5484d" opacity="0.42" rx="1"/>`;
  }).join('');

  // ── 多服务器：每台各画一条线（2026-09-22 用户要求）──────────────────────
  // 以前多台只画「合计」一条线 —— 看得出总量，看不出哪台掉了/哪台人多。
  // 现在多台时每台一条线 + 图例；单台保持原样（一条强调色线）。红色只留给断连带，
  // 所以服务器线的调色盘里不放纯红。
  const serverLines = (perServer || []).filter((p) => p && Array.isArray(p.values));
  const multi = serverLines.length > 1;
  const PALETTE = ['#7aa2f7', '#9ece6a', '#e0af68', '#bb9af7', '#7dcfff', '#f7768e', '#73daca', '#c0caf5'];
  // 线型是**备胎**，不是装饰：DASHES[0] 空串 = 实线，正常情况所有线都用它。
  // 只有两台人数**相同**、两条线完全重合时才轮到 DASHES[1..]（虚线/点线/长虚线）——
  // 后画的把先画的盖个严实，看上去就只剩一条（2026-09-22 用户反馈"两条线相合的时候
  // 查人数不好查"），虚线压在实线上是透的，重合段才看得出"叠了两条"。
  // ⚠️ 别改成按序号无条件轮换：那样第 3 台永远是点线，明明没重合也画成点，
  //    用户会以为图渲染坏了（2026-09-22 "不是线吗为什么变成点了"）。
  const DASHES = ['', '4 2.2', '1.2 2.6', '6 2.6'];
  // 重合检测：两条线的**有效样本大面积相等**就算重合 —— 后画的那条整体抬高 1 个
  // viewBox 单位（显示上是 2px，scale=2）。不抬高的话后画的线+点串会把先画的盖个
  // 严实，看上去只剩一条（demo 里两台恒定 10 人时整张图就一条绿线，蓝线彻底隐形）。
  // ⚠️ 只动显示不动数值：明细区/图例/给模型的摘要仍是真值；2px 的错位不构成误读，
  //    换来的是"重合也能看出是两条"。偏移的是**后画的**（先画的留在真实位置）。
  const linesDuplicated = (a, b) => {
    let same = 0; let n = 0;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] != null && b[i] != null) { n++; if (a[i] === b[i]) same++; }
    }
    return n >= 5 && same / n >= 0.8;
  };
  const perPaths = multi
    ? (() => {
        // 先算好每条线是否与别的线重合：重合对里**两条都不画点**（人数恒定时每个点
        // 都是峰值点会全画，两串点绞在一起又把错位出来的两条线糊回一条 —— demo 实测），
        // 后画的那条抬高 1 个 viewBox 单位（显示 2px），先画的留在真实位置。
        const dupFlags = serverLines.map((p, i) =>
          serverLines.some((q, j) => j !== i && linesDuplicated(p.values, q.values)));
        // 线型**只在真重合时才换**（2026-09-22 用户反馈"不是线吗为什么变成点了"）。
        //
        // ⚠️ 1.2.18 是无条件按序号轮换 4 种线型（第 1 台实线、第 2 台虚线、第 3 台点线…），
        //    结果哪怕两台线根本没重合，第 3 台也永远是点线 —— 看着像渲染坏了，
        //    用户第一反应是"不是线吗"。线型本来是为了救重合才加的，平时不该出现。
        //
        // 现在：**默认全实线**；只有检测到与别的线重合、且自己是**后画的那条**时才换线型
        // （先画的保持实线 —— 错位抬高的也是后画的，两个信号指向同一条，不会自相矛盾）。
        // 换的时候只在 DASHES 的非实线档里依次取（DASHES[0] 是空串 = 实线），
        // 多台同时重合也不会两条都拿到同一种虚线。
        let dashSeq = 0;
        return serverLines.map((p, idx) => {
          const c = PALETTE[idx % PALETTE.length];
          const dup = dupFlags[idx];
          const dy = dup && idx > 0 ? 1 : 0;   // 只抬后画的；先画的保持真值位置
          let dash = '';
          if (dup && idx > 0) {
            dash = DASHES[1 + (dashSeq % (DASHES.length - 1))];
            dashSeq += 1;
          }
          return `<path d="${pathOf(p.values, dy)}" fill="none" stroke="${c}" stroke-width="${dense ? 0.7 : 1.2}"${dash ? ` stroke-dasharray="${dash}"` : ''} stroke-linejoin="round" stroke-linecap="round" opacity="0.95"/>`
            + (dup ? '' : dotsOf(p.values, Math.max(0, ...p.values.filter((v) => v != null)), c, c, dy));
        }).join('');
      })()
    : '';
  const perPeakMax = multi
    ? Math.max(...serverLines.flatMap((p) => (p.values || []).filter((v) => v != null)), 0)
    : null;
  // 每台的**最新**人数直接写进图例：重合/断连时曲线读不出数，这里总能读（2026-09-22）
  const lastVal = (vals) => {
    for (let i = vals.length - 1; i >= 0; i--) if (vals[i] != null) return vals[i];
    return null;
  };
  const legend = multi
    ? `<div class="legend">${serverLines.map((p, idx) => {
        const lv = lastVal(p.values || []);
        return `<span class="lg"><i style="background:${PALETTE[idx % PALETTE.length]}"></i>${esc(p.label || `服${idx + 1}`)} <b>${lv == null ? '—' : lv}</b> 人</span>`;
      }).join('')}</div>`
    : '';

  // ── 分台统计：有效点 / 断连段数各台分开列（2026-09-22 用户要求）──────────
  // 为什么不能只看合计：合计是"任一台有值就算有效"，两台加起来 48/48 看着满格，
  // 实际可能是 A 全程在线、B 只采到 12 段 —— 合计把个体的缺采样整个吃掉了。
  // 断连同理：合计 3 段，说不清是三台各断 1 段、还是同一台断了 3 段，
  // 而"一台反复断"和"三台各抖一下"要做的处理完全不是一回事。
  // 所以有效点按台算（该台 values 非 null 的个数），断连段数也按台算（该台 down 掩码）。
  const perStats = multi
    ? serverLines.map((p, idx) => ({
        label: p.label || `服${idx + 1}`,
        color: PALETTE[idx % PALETTE.length],
        okN: (p.values || []).filter((v) => v != null).length,
        dnN: (p.down || []).filter(Boolean).length
      }))
    : [];
  // ── 合计有效点 = 各台有效点**相加** /（段数 × 台数）（2026-09-22 用户纠正口径）──
  //
  // ⚠️ 别用 series.samples 当分子：那是**合并视图**的点数，口径是「任一台有值就算有效」——
  //    三台里只要有一台全程在线，它就是满格 48/48，另外两台的缺口被整个吃掉
  //    （用户原话：合计不应该是段数，应该是各台真正有效点合在一起）。
  //    图上画的是 N 条线 × n 段 = n×N 个可能的数据点，采到多少就该是多少：
  //    生存服 48 + 创造服 20 + 小游戏服 42 = 110 / 144。这样"合计"才反映真实完整度，
  //    也和下面分台那一行的数字对得上（逐台相加就是分子）。
  const totalOkN = perStats.reduce((a, p) => a + p.okN, 0);
  const totalCapN = n * serverLines.length;

  // 横向网格线（2026-09-22 用户反馈"数据横线需要多一点"）：原来只有 0/中/顶 3 条，
  // 人数在 2~5 之间跳时根本没有可对照的刻度。改成自适应步长（1/2/5×10ⁿ 的整数刻度），
  // 目标 4~7 条 —— 峰值 5 人时就有 0/1/2/3/4/5/6 每人一条线，横线落到哪格一眼读得出。
  // 用户确认判定从宽（原话"假设人数现在是15就画20和10中间的刻度就行"）：刻度不必精确
  // 卡住每个值，能夹住数据读出大概位置就够了；具体步长规则见下。
  const niceStep = (range) => {
    const raw = range / 7;                       // 目标约 6~7 格（峰值 5 人 → 0..6 每人一条）
    const pow = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))));
    for (const m of [1, 2, 5, 10]) if (m * pow >= raw) return m * pow;
    return 10 * pow;
  };
  // 人数是整数，刻度最细到 1 人 —— 不加这道闸，峰值 1~2 人时 step 会算出 0.2/0.5，
  // 左侧标签 Math.round 之后变成 0、1、1、2、2 这种重复假刻度。
  const step = Math.max(1, niceStep(maxY));
  const gridVals = [];
  for (let v = 0; v <= maxY + 1e-9; v += step) gridVals.push(Math.round(v * 10) / 10);
  const grid = gridVals.map((v) => `
    <line x1="${padL}" y1="${y(v).toFixed(1)}" x2="${W - padR}" y2="${y(v).toFixed(1)}" stroke="${t.border}" stroke-width="1"/>
    <text x="${padL - 4}" y="${(y(v) + 3).toFixed(1)}" fill="${t.label}" font-size="9" text-anchor="end">${Math.round(v)}</text>`).join('');

  // x 轴刻度。点数少时显示整点够了；采样密起来（5 分钟一段有几百个点）后必须显示到分钟
  // —— "1:05、1:10、1:15" 才对得上用户看到的波动位置（2026-09-22 用户要求）。
  // 小时的 leading zero 去掉更像人话（"1:05" 而不是 "01:05"）。
  // 标签数量按可用宽度自适应：每个 "H:MM" 约占 46px，再密会糊成一团看不清。
  const hhmm = (raw) => {
    const t = String(raw ?? '').slice(11);
    const [h, mi] = t.split(':');
    return (h == null || mi == null) ? t : `${Number(h)}:${mi}`;
  };
  const want = Math.max(2, Math.min(Math.floor((W - padL - padR) / 46), n));
  const stepIdx = Math.max(1, Math.round((n - 1) / (want - 1)));
  const labelIdx = [];
  for (let i = n - 1; i > 0; i -= stepIdx) labelIdx.unshift(i);   // 从右往左取，保证最右一定有刻度
  labelIdx.unshift(0);
  const xLabels = labelIdx.map((i) => {
    const lbl = hhmm(slots[i]);
    return `<text x="${x(i).toFixed(1)}" y="${H - 6}" fill="${t.label}" font-size="9" text-anchor="middle">${esc(lbl)}</text>`;
  }).join('');

  // 圆点只画「没连上线」的点：孤立点、断口两端、峰值。
  //   ⚠️ 不能每个点都画：5 分钟粒度下人数平稳时几十个点连成一线，每点一颗就糊成一条粗带
  //   （2026-09-22 用户反馈"条太粗"）。孤立点仍必须画 —— 单点用 M/L 折线画不出任何东西，
  //   不画等于让这些样本集体隐形。点数多时半径收小，峰值点永远画大且换强调色。
  const dots = multi ? '' : dotsOf(vals, series.peak, t.ok);

  // ── 明细区（2026-09-22 用户要求）：曲线下面一条条列出来，大字=时间段、小字=人数 ──
  // ⚠️ 不能整卷列出：5 分钟粒度下 24 小时有 288 个点，全画出来卡片会变成门帘。
  //    只取**最近有数据的**几段（默认 8 段，配置填 0 就完全不显示这块），
  //    顺序与 x 轴一致（旧→新），读完正好接上曲线右端。
  const parseSlot = (k) => {
    const [d, tm] = String(k ?? '').split('T');
    const [y, mo, dd] = d.split('-').map(Number);
    const [hh, mi] = String(tm ?? '').split(':').map(Number);
    return new Date(y, mo - 1, dd, hh, mi);
  };
  const clockOf = (dt) => `${dt.getHours()}:${String(dt.getMinutes()).padStart(2, '0')}`;
  const picked = [];
  // 断连的段也要列（v=null 但 downs[i]=true）：明细区只列人数的话，
  // "刚断连过"这件事在明细里就invisible了，红带 + 明细双确认
  (series?.values || []).forEach((v, i) => { if (v != null || downs[i]) picked.push(i); });
  const limit = Number(detailRows) || 0;
  const shown = limit > 0 ? picked.slice(-limit) : [];
  const detail = (!empty && shown.length) ? `
    <div class="det">
      <div class="det-head">明细 · 最近 ${shown.length} 段${picked.length > shown.length ? `（更早还有 ${picked.length - shown.length} 段，未列出）` : ''}</div>
      ${shown.map((i) => {
        const t0 = parseSlot(slots[i]);
        const t1 = new Date(t0.getTime() + slotMin * 60_000);
        // 多台时一行里列出每台：周期的白字在上、各台数值的小字在下（2026-09-22 用户要求）
        // 断连的段写「断连」而不是「— 人」：— 看起来像没数据，断连是"查了没连上"，要分清
        const nums = perServer.length
          ? perServer.map((p) => p.down?.[i]
            ? `${esc(p.label)} 断连`
            : `${esc(p.label)} ${p.values?.[i] ?? '—'} 人`).join(' · ')
          : (downs[i] ? '⛔ 断连（该时段没连上服务器）' : `${series.values[i]} 人`);
        return `<div class="det-row">
          <span class="det-time">${clockOf(t0)}-${clockOf(t1)}</span>
          <span class="det-num">${nums}</span>
        </div>`;
      }).join('')}
    </div>` : '';

  const body = empty
    ? `<div class="empty">还没有数据 —— 在线人数是<strong>你每次查询时顺手记的</strong>（每 ${slotMin} 分钟一段），多用几次就有了。</div>`
    : `<svg width="100%" height="${s(H)}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        ${grid}${xLabels}${downBands}${multi
          ? perPaths
          : `<path d="${d}" fill="none" stroke="${t.accent}" stroke-width="${dense ? 0.7 : 1.2}" stroke-linejoin="round" stroke-linecap="round"/>${dots}`}
      </svg>`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html { overflow:hidden; background:${t.pageBg}; }
  body {
    background:${t.pageBg}; color:${t.value};
    font-family:"Microsoft YaHei UI","Microsoft YaHei","PingFang SC",system-ui,sans-serif;
    width:${s(CARD_W)}px; padding:${s(14)}px;
  }
  .card { background:${t.cardBg}; border:1px solid ${t.border}; border-radius:${s(12)}px; overflow:hidden; }
  .head { padding:${s(12)}px ${s(16)}px; border-bottom:1px solid ${t.border}; display:flex; align-items:baseline; gap:${s(8)}px; }
  .htitle { font-size:${s(15)}px; font-weight:600; color:${t.title}; }
  .hsub { font-size:${s(11)}px; color:${t.badge}; }
  .plot { padding:${s(10)}px ${s(10)}px ${s(4)}px; }
  .empty { padding:${s(24)}px ${s(16)}px; font-size:${s(12)}px; color:${t.sub}; line-height:1.6; text-align:center; }
  .stats { padding:${s(8)}px ${s(16)}px ${s(12)}px; display:flex; gap:${s(14)}px; flex-wrap:wrap; font-size:${s(11)}px; color:${t.label}; }
  .stats b { color:${t.value}; font-size:${s(13)}px; }
  /* 多服务器图例：色块 + 服务器名，与折线颜色一一对应 */
  .legend { padding:${s(2)}px ${s(16)}px ${s(6)}px; display:flex; gap:${s(12)}px; flex-wrap:wrap; font-size:${s(10.5)}px; color:${t.label}; }
  .legend .lg { display:inline-flex; align-items:center; gap:${s(4)}px; }
  .legend .lg i { display:inline-block; width:${s(9)}px; height:${s(9)}px; border-radius:${s(2)}px; }
  .legend .lg b { color:${t.value}; font-size:${s(11)}px; font-variant-numeric:tabular-nums; }
  /* 分台统计：跟图例同一套色块 + 名字，只是把"人数"换成"有效点/断连" */
  .pstat { padding:0 ${s(16)}px ${s(10)}px; display:flex; align-items:center; gap:${s(6)}px ${s(14)}px; flex-wrap:wrap; font-size:${s(10.5)}px; color:${t.label}; }
  .pstat .ps-h { color:${t.badge}; }
  .pstat .ps { display:inline-flex; align-items:center; gap:${s(4)}px; }
  .pstat .ps i { display:inline-block; width:${s(8)}px; height:${s(8)}px; border-radius:${s(2)}px; }
  .pstat .ps b { color:${t.value}; font-size:${s(12)}px; font-variant-numeric:tabular-nums; }
  .pstat .ps em { font-style:normal; color:#e5484d; }
  .foot { padding:${s(9)}px ${s(16)}px; border-top:1px solid ${t.border}; font-size:${s(10)}px; color:${t.badge}; }
  .det { margin:0 ${s(16)}px ${s(12)}px; border-top:1px solid ${t.border}; padding-top:${s(8)}px; }
  .det-head { font-size:${s(10)}px; color:${t.badge}; margin-bottom:${s(6)}px; }
  /* 一行 = 一个周期：白字是周期区间，下面一排小字是该周期内各服务器的数值 */
  .det-row { display:flex; flex-direction:column; gap:${s(2)}px;
             padding:${s(5)}px 0; border-bottom:1px dashed ${t.border}; }
  .det-row:last-child { border-bottom:none; }
  .det-time { font-size:${s(12)}px; color:${t.value}; font-family:"Consolas","Cascadia Mono",monospace; }
  .det-num { font-size:${s(10.5)}px; color:${t.label}; line-height:1.5; word-break:break-all; }
</style></head><body>
<div class="card">
  <div class="head">
    <div class="htitle">📈 在线人数 · 近 ${hours} 小时</div>
    <div class="hsub">${empty ? '暂无数据' : `每 ${slotMin} 分钟一段 · ${multi ? `${serverLines.length} 台分开显示` : esc(series.label || '')}`}</div>
  </div>
  <div class="plot">${body}</div>
  ${legend}
  ${(!empty && series.samples > 0) ? `<div class="stats">
    ${multi
      ? `<span>合计峰值 <b>${series.peak}</b> 人</span><span>单台最高 <b>${perPeakMax}</b> 人</span><span>合计平均 <b>${series.avg}</b> 人</span>`
      : `<span>峰值 <b>${series.peak}</b> 人</span><span>平均 <b>${series.avg}</b> 人</span>`}
    <span>${multi ? '合计有效点' : '有效点'} <b>${multi ? totalOkN : series.samples}</b> / ${multi ? totalCapN : n}</span>
    ${downCount ? `<span style="color:#e5484d">断连 <b>${downCount}</b> 段</span>` : ''}
  </div>` : ''}
  ${(multi && perStats.length) ? `<div class="pstat">
    <span class="ps-h">分台统计</span>
    ${perStats.map((p) => `<span class="ps"><i style="background:${p.color}"></i>${esc(p.label)} 有效点 <b>${p.okN}</b>/${n}${p.dnN ? ` · <em>断连 ${p.dnN} 段</em>` : ''}</span>`).join('')}
  </div>` : ''}
  ${detail}
  <div class="foot">每 ${slotMin} 分钟一个点，取该段各次查询的平均${multi ? '（多台各画一条线）' : (series?.merged ? '（多台为合计）' : '')} · 缺数据的段断开，不画成 0${downRuns.length ? ` · <span style="color:#e5484d">红色竖带 = 该时段有服务器没连上${multi ? '（还活着的线条压在红带上）' : '（断连）'}</span>` : ''}${slotNote ? ` · ${esc(slotNote)}` : ''}</div>
</div>
</body></html>`;
}

/** 状态卡 */
export async function renderPng(rows, { theme = 'dark', hiddenCount = 0, colorMotd = true } = {}) {
  return renderHtmlPng(buildStatusHtml(rows, { theme, hiddenCount, colorMotd }), theme);
}

/** 人数曲线卡 */
export async function renderTrendPng(series, { theme = 'dark', hours = 24, detailRows = 8, perServer = [], slotNote = '' } = {}) {
  return renderHtmlPng(buildTrendHtml(series, { theme, hours, detailRows, perServer, slotNote }), theme);
}

/**
 * 把一段 HTML 截成 PNG（状态卡、曲线卡共用）。
 * @param {string} html 已经生成好的完整 HTML
 */
export async function renderHtmlPng(html, theme = 'dark') {
  const t = THEMES[theme] || THEMES.dark;
  let electron = null;
  try {
    const mod = await import('electron');
    electron = mod?.default ?? mod;
  } catch { return null; }
  if (!electron || typeof electron.BrowserWindow !== 'function') return null;
  // ⚠️ 上一次渲染还没完时**要等**，不能直接放弃：多服务器卡片渲染更慢（截图要几百毫秒），
  //    用户连着问两次「服务器」时第二次很容易撞上这把锁。原来直接 return null，
  //    表现就是"明明配了卡片模式，第二次却莫名变成文字卡"。
  if (rendering) {
    const t0 = Date.now();
    while (rendering && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 50));
    if (rendering) return null; // 等太久了，宁可回退文字卡也不要让用户干等
  }
  rendering = true;
  let win = null;
  try {
    win = new electron.BrowserWindow({
      show: false, skipTaskbar: true, frame: false, useContentSize: true,
      // ⚠️ 初始高度必须给小（220）。BrowserWindow 默认 800×600，而下面量高度用的
      //    documentElement.scrollHeight 在**内容比视口矮**时返回的是视口高度、不是内容高度
      //    —— 单服务器卡片实测内容只有 329px，却按 600 截图，下面 271px 全是空白
      //    （2026-09-21 用户反馈"下面空白太多"就是这个）。窗口开矮，量到的才是真高度。
      width: CARD_W * 2, height: 220,
      // ⚠️ 必须设窗口背景色（项目踩过的坑）：高度取整，实际渲染高度带亚像素，
      //    窗口矮一点点就会在右/下露出 Electron 默认的白边。跟卡片底色一致就看不出来。
      backgroundColor: t.pageBg,
      webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: false, contextIsolation: true, nodeIntegration: false }
    });
    const tmpHtml = path.join(os.tmpdir(), 'qq-agent-mc-status-card.html');
    fs.writeFileSync(tmpHtml, html);
    await win.loadFile(tmpHtml);
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      win.webContents.once('paint', finish);
      setTimeout(finish, 400);
    });
    // 量**内容**高度：body 自己撑开的高度 + 卡片底边 + body 下内边距，取最大值。
    // 不能用 documentElement.scrollHeight —— 它会被视口高度托底（见上）。
    const h = await win.webContents.executeJavaScript(`(() => {
      const b = document.body;
      const card = document.querySelector('.card');
      const pad = parseFloat(getComputedStyle(b).paddingBottom || 0);
      const cardBottom = card ? card.getBoundingClientRect().bottom + pad : 0;
      return Math.ceil(Math.max(b.scrollHeight, b.offsetHeight, cardBottom));
    })()`);
    // +1 亚像素余量：宁可多裁 1px 背景（底色跟卡片一致，看不出来），也不要切掉卡片边
    win.setContentSize(CARD_W * 2, Math.max(120, (Number(h) || 600) + 1));
    await new Promise((r) => setTimeout(r, 80));
    const img = await win.webContents.capturePage();
    const png = img.toPNG();
    if (!png || png.length < 1000) throw new Error('截图为空');
    return png;
  } catch (e) {
    api?.log?.(`MC 状态卡渲染失败：${e?.message ?? e}`);
    return null;
  } finally {
    try { win?.destroy?.(); } catch { /* 忽略 */ }
    rendering = false;
  }
}

/* ── 工具 ────────────────────────────────────────────────── */
function toolMcStatus() {
  return {
    id: 'get_mc_status',
    name: '查服务器状态',
    description:
      '查 Minecraft 服务器状态并**直接发到当前会话**（在线人数/上限、版本、延迟、MOTD、在线玩家名单）。'
      + '用户说「服务器状态」「我的服开着吗」「几个人在线」「服务器卡不卡」「服务器在线人数」「我的世界」时调用。'
      + '用户点名了服务器（如「hypixel 多少人」）就传 name；没点名就不传，查设置里的全部服务器。'
      + '⚠️ 返回结果里的数字都是实测值，不要估算或编造人数；查不通时如实说查不通，**不要说成"服务器关了"**'
      + '（连不上可能是网络或防火墙问题，两者不是一回事）。'
      + '⚠️ 每次调用都会**真去连一次服务器**（不使用缓存），同一句指令连着发两次就会查两次。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '服务器名称或地址（模糊匹配）。不传 = 查设置里的所有服务器。' },
        refresh: { type: 'boolean', description: '是否重新查一次。**默认就是重新查**（指令一次 = 真查一次），只有显式传 false 时才允许复用短缓存。' }
      }
    },
    async execute(ctx, args) {
      const all = parseServers(st().servers);
      const asked = String(args?.name ?? '').trim();
      let targets = [];
      let adhoc = false;

      if (asked) {
        targets = matchServers(asked);
        // 配置列表里没有，但用户给的话**长得像地址** —— 就当临时地址直接查，
        // 不用先去控制台加一遍（「\服务器 mc.hypixel.net」这种用法）。
        // ⚠️ 仍然只在带反斜杠的指令下才会走到这里：工具本身被指令门槛挡着。
        if (!targets.length) {
          const one = parseAdhoc(asked);
          if (one) {
            const deny = await adhocGuard(one.host, { allowPrivate: st().adhocAllowPrivate === true });
            if (deny) return asDirect(`不给查：${deny}。要查内网地址请在插件设置里打开「允许查内网地址」。`);
            targets = [one];
            adhoc = true;
          }
        }
      } else {
        targets = all;
      }

      if (!asked && !all.length) {
        return asDirect('还没配置服务器。请到控制台 → 插件 → 服务器状态，在「服务器列表」里填上，格式「名称|地址:端口」，例如「Hypixel|mc.hypixel.net」。也可以直接在指令里带地址查，比如「\\服务器 mc.hypixel.net」。');
      }
      if (!targets.length) {
        return asDirect(`没找到匹配「${asked}」的服务器。当前配了：${all.map((s) => s.name).join('、')}${all.length ? '' : '（列表还是空的）'}。想查没配过的服务器，就把地址直接写在指令里（如「\\服务器 mc.hypixel.net」）。`);
      }
      // 2026-09-22 用户要求："输出一次这样的指令就查询一次" —— 人手发指令要的就是当下
      // 的数据，所以**默认无视缓存真查**（以前默认吃 30 秒缓存，连着问两次第二次不动手，
      // 用户看到的是一模一样的数字，以为插件没查）。缓存仍留给后台路径：自动采集、
      // 状态面板探测、曲线工具画图前的那次采样，没必要每次都重新握手。
      const rows = await queryAll(targets, { force: args?.refresh !== false });
      if (adhoc) for (const r of rows) r.adhoc = true;

      // ⚠️ 卡片高度没有上限，服务器一多图就长得没法看（实测 10 台 = 1280×2100，
      //    发到 QQ 里缩成一团）。超过 maxCardRows（默认 8）就只画前 N 台，脚注写明总数；
      //    给模型的文字摘要仍是**全量**，用户追问「第 9 台呢」照样答得出来。0 = 不限制。
      const { cardRows, hiddenCount } = pickCardRows(rows, st().maxCardRows);

      const mode = String(st().cardMode || 'auto');
      if (mode !== 'text' && ctx?.sender?.sendImage && ctx?.chatKey) {
        const png = await renderPng(cardRows, { theme: readTheme(), hiddenCount, colorMotd: st().colorMotd !== false });
        if (png) {
          try {
            await ctx.sender.sendImage(ctx.chatKey, { dataUrl: 'base64://' + png.toString('base64') }, { note: '服务器状态' });
            // ⚠️ content 必须带完整文字摘要：模型**看不见图片**，用户追问「几个人」「卡不卡」只能靠这段
            // ⚠️ 多台服务器必须**一行一台**：跟 weather-card 1.7.3 同一个坑 —— 用「；」
            //    连成一行时模型只挑开头复述，查了 5 台回复里只提 1 台，用户以为另外几台
            //    没查到。分行 + 开头报总数，模型才有可自查的清单。
            return { content: cardSummary(rows, cardRows.length, hiddenCount), _cardSent: true };
          } catch (e) { api?.log?.(`服务器状态卡发送失败，回退文字：${e.message}`); }
        }
      }
      // _directText：图片渲染不出来时，这段是**可以直接发到群里**的成品文字卡。
      // 为什么另给一份而不复用 content：指令直达（commandRoute）不经过模型，
      // 系统只能发 _directText —— 而 content 里可能混着给模型的措辞。
      return { content: textCard(rows), _textCard: true, _directText: textCard(rows) };
    }
  };
}

/* ── 曲线工具 ────────────────────────────────────────────── */
function toolMcTrend() {
  return {
    id: 'get_mc_trend',
    name: '查服务器人数曲线',
    description:
      '看服务器**近 24 小时**的在线人数曲线（峰值、平均、什么时候人最多），发一张折线图到会话。'
      + '曲线**一段代表多长时间默认自动跟着采集频次走**（后台每 N 分钟自动查一次，图上一段就是 N 分钟），'
      + '主人也可以在设置里改成固定档位。总跨度由「看多少小时」决定（默认 24 小时）。'
      + '配了多台服务器且不点名时，每台各画一条线（带图例）；点名单台就只画那一台。'
      + '查不通的时段画成**红色竖带**（断连），缺数据的时段留空白断开。'
      + '⚠️ 只有用户明确要看趋势/曲线/「什么时候人最多」「人多不多（历史）」时才调用；'
      + '单纯问「现在几个人」「服务器状态」是另一个工具的事，别用这个。'
      + '⚠️ 数据来自**后台自动采集 + 每次查询时顺手记的**，没采集到的时段是空的 —— 图上会断开，不要说成 0 人。'
      + '本工具画图前会先把目标服务器**真查一遍**（顺带记进历史），所以刚发的这条查询自己也会出现在曲线上。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '服务器名称或地址（模糊匹配）。不传 = 全部服务器合计。' }
      }
    },
    async execute(ctx, args) {
      const all = parseServers(st().servers);
      if (!all.length) return asDirect('还没配置服务器，也就没有历史数据可画。');
      const q = String(args?.name ?? '').trim();
      const targets = q ? matchServers(q) : all;
      if (!targets.length) return asDirect(`没找到匹配「${q}」的服务器。当前配了：${all.map((s) => s.name).join('、')}`);

      const hours = Math.max(2, Math.min(48, Number(st().trendHours ?? 24) || 24));
      // 先真查一遍再画（2026-09-22 用户反馈："这个查询在人数曲线上不显示"）。
      // 曲线工具以前**只读历史**，而历史是「查询时顺手记」的 —— 刚发的这条曲线查询
      // 自己不产生样本，图上最新只能停在上一次真查询的时刻，看着就像这次没记上。
      // 现在画图前先把目标各查一遍（queryOne 里会 pushHistory）：查得动 →
      // 最新点立刻上图；查不通 → 照旧不记录（缺数据断开的规则不变），图也照画。
      // ⚠️ 开了自动采集且**刚采过**（不到半个周期）就跳过：那次样本已经写进历史了，
      //    再打一次只会让同一段里多塞一个样本、还白白多握一次手。
      const periodSec = samplingIntervalSec(st());
      const justCollected = periodSec > 0 && lastCollectAt > 0 && Date.now() - lastCollectAt < periodSec / 2;
      if (!justCollected) await Promise.allSettled(targets.map((s) => queryOne(s)));
      // 一个点代表多少分钟：先按用户的设置取，再让"轮询间隔"参与联动
      // —— 轮询比粒度还慢时把粒度抬高到周期档位，否则刚查完的数据会落在空点上看着像没记上
      const slotSel = resolveSlotMin(st());
      const slotMin = slotSel.slotMin;
      const series = mergeSeries(targets, hours, Date.now(), slotMin);
      if (!series) return asDirect('没有可画的数据。');

      // 多台时把每台自己的序列一起带上：主图各画一条线，明细区按周期列出各台人数。
      // ⚠️ 提到 if 外面：文字回退分支也要用（模型看不见图，断连的台数/是哪台全靠它叙述）
      const perServer = targets.map((s) => {
        const one = seriesOf(s, hours, Date.now(), slotMin);
        return { label: s.name || `${s.host}:${s.port}`, values: one.values, down: one.down };
      });

      const mode = String(st().cardMode || 'auto');
      if (mode !== 'text' && ctx?.sender?.sendImage && ctx?.chatKey) {
        const png = await renderTrendPng(series, {
          theme: readTheme(), hours, slotMin, perServer,
          // 一段的长度被自动决定了要写明：否则用户会以为设置里选的档位没生效
          slotNote: slotSel.auto
            ? (slotSel.periodSec > 0
              ? `每段 = 自动采集间隔 ${Math.round(slotSel.periodSec / 60)} 分钟`
              : '自动：还没开定时采集，每段按手动查询落点画')
            : slotSel.byWatch
              ? `每段已按查询频次从 ${slotSel.wantMin} 分钟抬到 ${slotMin} 分钟`
              : '',
          detailRows: Math.max(0, Number(st().trendDetailRows ?? 8) || 0)
        });
        if (png) {
          try {
            await ctx.sender.sendImage(ctx.chatKey, { dataUrl: 'base64://' + png.toString('base64') }, { note: '人数曲线' });
            // 模型看不见图，必须把关键数字写进 content
            return { content: `人数曲线已发出：${trendBrief(series, hours, perServer)}`, _cardSent: true };
          } catch (e) { api?.log?.(`人数曲线发送失败，回退文字：${e.message}`); }
        }
      }
      return { content: trendBrief(series, hours, perServer), _textCard: true, _directText: trendBrief(series, hours, perServer) };
    }
  };
}

/**
 * 曲线的文字版：模型看不见图，全靠这段回答「几点人最多」。
 *
 * ⚠️ 必须按**小时归并**后再输出：5 分钟粒度下 24 小时有 288 个点，全拼进 content
 *    会把上下文撑爆（模型只看得这张图的文字替身，一次几百个点既浪费又抓不住重点）。
 *    归并只用于叙述，峰值/平均仍取原始点里的真值，不会因为并点而失真。
 */
function trendBrief(series, hours = 24, perServer = []) {
  const step = normalizeSlotMin(series?.slotMin ?? 5);
  const downCount = (series?.down || []).filter(Boolean).length;
  // 断连必须**点名到台**：红带是画在整张图上的，模型看不见图也分不清是哪台断了。
  // 之前只给一个总段数，模型就会把「某台挂了」说成「那会儿没人」—— 等于编。
  const downByServer = (perServer || [])
    .map((p) => ({ label: p.label, n: (p.down || []).filter(Boolean).length }))
    .filter((x) => x.n > 0);
  if (!series || (!series.values.some((v) => v != null) && !downCount)) {
    return `还没有 ${hours} 小时内的在线人数记录 —— 数据是每次查服务器时顺手记的（每 ${step} 分钟一段），多用几次就有了。`;
  }
  const perHour = Math.max(1, Math.round(60 / step));
  const pts = [];
  for (let i = 0; i < series.values.length; i += perHour) {
    const win = series.values.slice(i, i + perHour).filter((v) => v != null);
    if (!win.length) continue;
    const v = Math.round(win.reduce((a, b) => a + b, 0) / win.length);
    pts.push(`${String(series.slots[i] ?? '').slice(11, 13)}点 ${v} 人`);
  }
  // 一个人数样本都没有、只有断连记录：别输出"峰值 0 人"这种鬼话，直说连不上
  if (!pts.length) {
    return `近 ${hours} 小时内每次查询都没连上服务器（共 ${downCount} 个时间段，图上是红色竖带）—— 服务器可能一直处于离线状态。`;
  }
  const peakAt = series.values.indexOf(series.peak);
  const peakSlot = String(series.slots[peakAt] ?? '').slice(11) || '未知时间';
  // 有效点也要分台说：图上「分台统计」那一行模型看不见，而合计口径是"任一台有值就算"，
  // 不说清楚的话模型会把「B 台只采到 12 段」当成全量数据来叙述。
  const multiBrief = (perServer || []).length > 1;
  const okBrief = multiBrief
    ? perServer.reduce((a, p) => a + (p.values || []).filter((v) => v != null).length, 0)
    : series.samples;
  const capBrief = multiBrief
    ? (perServer[0]?.values || []).length * perServer.length
    : (series.values || []).length;
  const perPtsLine = (perServer || []).length > 1
    ? `各台有效点（共 ${(perServer[0]?.values || []).length} 段）：${perServer.map((p) => `${p.label} ${(p.values || []).filter((v) => v != null).length}`).join('、')}。`
    : '';
  return `近 ${hours} 小时在线人数（${series.label}，每小时参考值）：${pts.join('、')}。`
    // 有效点的合计口径跟图上那行保持一致（各台相加 / 段数×台数，1.2.21）：
    // 用 series.samples 是合并口径（任一台有值就算），会说成"数据是全的"，
    // 模型据此叙述就把另外几台的缺口抹掉了。
    + `峰值 ${series.peak} 人（${peakSlot}），平均 ${series.avg} 人，共 ${okBrief} 个有效数据点${multiBrief ? `（${perServer.length} 台合计，满格 ${capBrief}）` : ''}（每 ${step} 分钟一段）。`
    + perPtsLine
    + '注意：数据只在查询时记录，没查过的时段是空的，不代表 0 人。'
    // ⚠️ 点名的条件是「有多台服务器」，不是「断连的台数 > 1」：两台里只断一台恰恰是最需要
    //    点名的场景（否则模型只知道"有段断了"，说不出是哪台）。单台时没有歧义，说总段数就够。
    + ((perServer || []).length > 1 && downByServer.length
      ? `断连情况（图上红色竖带，共 ${downCount} 段）：${downByServer.map((x) => `${x.label} ${x.n} 段`).join('、')} —— 断连那几段**不是 0 人**，是没查到，别当成没人。`
      : (downCount ? `另有 ${downCount} 个时间段没连上服务器（图上画成红色竖带），那也不是 0 人。` : ''));
}

/* ── RCON：远程执行服务器命令 ────────────────────────────── */
/**
 * ⚠️ 这是整个插件里唯一能"改变服务器状态"的东西，围栏必须做全：
 *   1. 默认关闭，且是 `=== true` 才开（项目约定：有副作用的开关不能写成 !== false）
 *   2. 只有**主人**能用（群里谁都能发一句话，不校验等于把 OP 交给全群）
 *   3. 默认只放行只读命令（list / whitelist list / seed …），危险命令要显式开 allowDangerous
 *   4. 每次执行都留审计日志，日志里绝不带密码
 *   5. 输出截断：服务器返回可能很长，不能直接糊进对话
 */
// 只读命令白名单（不经 allowDangerous 也放行）。
// 2026-09-24 补进一批**查看服务器身份/能力**的只读命令（about / version / tps / plugins …）：
// 老服务端能力集小、命令常撞墙，得先能"问清楚这台是什么、支持什么"再去下命令 ——
// 而这些命令本身没有任何副作用，没道理要求先开"允许危险命令"。
const RCON_SAFE = /^\s*(list|whitelist\s+list|seed|help(\s+\S+)?|time\s+query\s+\w+|weather\s+query|difficulty|gamerule\s+\S+|scoreboard\s+objectives\s+list|scoreboard\s+players\s+list(\s+\S+)?|data\s+get\s+\S+|about|version|tps|plugins|players|worlds|banlist(\s+ips)?|numchunks|chunkstats)\s*$/i;
const RCON_MAX_OUT = 1500;

function ownerIdList() {
  const c = getConfig() || {};
  // 主人号由 owner-identity 插件管，存在 config.skills['owner-identity'].ids
  const raw = c?.skills?.['owner-identity']?.ids ?? '';
  return String(raw).split(/[,，\s;；]+/).map((x) => x.trim()).filter(Boolean);
}

/** 批内所有非机器人消息的发送者（去重，按出现顺序）。 */
export function batchCallerIds(ctx) {
  try {
    const entries = Array.isArray(ctx?.session?.trigger) ? ctx.session.trigger : [];
    const out = [];
    for (const m of entries) {
      if (m && !m.self && m.senderId) {
        const id = String(m.senderId);
        if (!out.includes(id)) out.push(id);
      }
    }
    return out;
  } catch { /* 拿不到就算了 */ }
  return [];
}

/**
 * 本批唤醒是否"纯主人批次"：批内**所有**非机器人消息都来自已配置的主人号。
 * 是 → 返回发起的主人 id（供审计）；否 → 返回空串。
 *
 * ⚠️ 为什么是"全部是主人"而不是"任一人是主人"（1.2.33 的"任一"被用户当场驳回）：
 *   RCON 输出和服务器日志会**发到群里所有人可见**。若主人只是恰好也在本批说了句话，
 *   普通群友就能搭车让 AI 执行 RCON / 读日志 —— 等于全群在任何主人开口的几秒窗口里
 *   都有主人权限。而"按最后一条取人"（1.2.32 前）是同一漏洞的镜像：主人消息恰好
 *   排最后时搭车一样成功，主人排前面时反而被误拦（2026-09-24 15:45 实测翻车）。
 *   唯一机械上无懈可击的口径：**本批只能有主人说话**。混批时工具会把原因说清楚，
 *   引导主人单独再发一条 —— 牺牲一点便利换安全边界闭合。
 *   （指令门槛的 batchHitAnyCommand 敢用"批内任一条命中"，是因为指令是确定性前缀、
 *   不含机密输出；这里不行 —— 工具的返回内容本身就是权限。）
 */
export function ownerCallerId(ctx, owners = []) {
  const callers = batchCallerIds(ctx);
  if (!callers.length) return '';                       // 没有真人发言（如定时唤醒）→ 不放行
  if (!callers.every((id) => owners.includes(id))) return '';   // 混有非主人 → 不放行
  return callers[0];
}

/**
 * 服务器回「不认识这条命令」时，补一句**可操作的**提示。
 *
 * 为什么要有（2026-09-24 用户踩到）：模型很爱把简单需求"升级"成复合命令 ——
 * 用户说「在 0 0 0 生成一只鸡」，它发的是
 * `execute as @a at @s run summon chicken ~ ~1 ~`（原版 1.13+ 的写法）。
 * 但**非原版服务端没有 execute**：实测 Cuberite 的 70 个命令里就没它 →
 * 回一句 Unknown command，然后模型只能对用户说"服务器不认这条指令"，双方都没辙。
 * 把"该怎么改"直接喂给模型，它下一轮就能自己改对，不用人去教。
 */
export function unknownCommandHint(output, caps = null) {
  if (!/unknown command|unknown syntax|unknown or incomplete/i.test(String(output ?? ''))) return '';
  let s = '\n\n（提示：服务器不认识这条命令 —— 它多半不是原版服务端的能力集。'
    + '比如 Cuberite 就没有 execute 命令（那是原版 1.13+ 才有的），'
    + '这类老服务端通常也只认最朴素的单条命令，'
    + '而且**目标选择器往往也不全**（@a / @e / @s 可能不认，要用具体玩家名）。'
    + '别拼 execute / 条件链，直接发最基础的那条，例如「summon chicken 0 0 0」。';
  if (caps?.version) s += `\n这台服务器自报的软件与版本：${caps.version}`;
  if (Array.isArray(caps?.commands) && caps.commands.length) {
    const list = caps.commands.slice(0, 60).join('、');
    s += `\n它 help 里列出的命令（可能不完整，仅供参考；拿不准就再跑一次 help）：${list}`
      + (caps.commands.length > 60 ? ' …' : '');
  }
  return s + '）';
}

/** 命令表缓存的存活时间 —— 服务器版本/插件不会每秒变，没必要每次失败都去问。 */
const CAPS_TTL_MS = 5 * 60 * 1000;
const capsCache = new Map();   // 'host:port' -> { at, version, commands }

/**
 * 从 `help` 输出里抠出命令名。
 * Cuberite 的格式是「summon                - Summons an entity.」，原版是分页的
 * 「/advancement ...」，所以去掉行首斜杠后取第一个词；分页提示行要跳过。
 */
export function parseCommandList(output) {
  const names = [];
  for (const raw of String(output ?? '').split('\n')) {
    const line = raw.trim().replace(/^\//, '');
    if (!line) continue;
    if (/showing help page|^---|\bhelp <page>/i.test(line)) continue;   // 原版的分页页眉
    const m = /^([a-z][a-z0-9_]{1,30})\b/i.exec(line);
    if (m) names.push(m[1].toLowerCase());
  }
  return [...new Set(names)];
}

/**
 * 问一下服务器"你是谁、你会什么"（about + help），带缓存。
 * ⚠️ 只用于**失败后的提示**，不拿它去预先拦截命令：
 *    原版的 help 是**分页**的（一次只列一部分），拿不完整的表去拦会误杀正常命令。
 *    失败时报给模型的是"参考",不是"判决"。
 */
export async function probeServerCaps({ host, port, password, timeout = 5000 } = {}) {
  const key = `${host}:${port}`;
  const hit = capsCache.get(key);
  if (hit && Date.now() - hit.at < CAPS_TTL_MS) return hit;
  const empty = { at: 0, version: '', commands: [] };
  try {
    const R = await import(`./rcon.js?t=${Date.now()}`);
    const [a, h] = await Promise.all([
      R.execRcon({ host, port, password, command: 'about', timeout }),
      R.execRcon({ host, port, password, command: 'help', timeout })
    ]);
    let version = a.ok ? String(a.output || '').split('\n')[0].trim().slice(0, 140) : '';
    // 原版 / Paper 没有 about（只有 version 命令）—— about 探不到时补一发 version，
    // 否则新版本自适应判定会把 1.21 新服误判成老服（Cuberite 有 about，不受影响）。
    if (!version) {
      const v = await R.execRcon({ host, port, password, command: 'version', timeout });
      version = v.ok ? String(v.output || '').split('\n')[0].trim().slice(0, 140) : '';
    }
    const commands = h.ok ? parseCommandList(h.output) : [];
    const caps = { at: Date.now(), version, commands };
    if (version || commands.length) capsCache.set(key, caps);
    return caps;
  } catch {
    return empty;   // 探不到就当没有，绝不因为"提示"本身出错
  }
}

/**
 * 判断 RCON 目标是不是「1.13 扁平化之前」的老服务端（选择器不全、物品名是旧版、give 不回显）。
 * 判据：about/version 自报文本含 Cuberite → 老；否则抠 MC 版本号，>= 1.13 → 新。
 * 什么都探不到（离线/空）→ 按老处理。为什么默认老：老规则对老服是对的；
 * 对新服只是多一道拦截提示、拦截文案会把原因说清楚，不会把命令发坏。
 * 注意这不是在用 help 命令表拦截（那张表原版是分页的、拿去拦会误杀），只看自报版本。
 */
export function isLegacyServer(versionLine) {
  const s = String(versionLine || '');
  if (!s) return true;
  if (/cuberite/i.test(s)) return true;
  const m = s.match(/(?:MC|minecraft)[:\s]+v?(\d+)\.(\d+)/i) || s.match(/(\d+)\.(\d+)(?:\.\d+)?/);
  if (!m) return true;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major < 1 || (major === 1 && minor < 13);
}

/**
 * 归一化模型给的命令：去掉开头的斜杠，并**剥掉它可能一起塞进来的指令词**。
 *
 * 用户发的是「\rcon summon chicken 0 0 0」，模型有时会把整串（含 `\rcon`）
 * 当作 command 传进来 —— 服务器不认识带着 `\rcon` 的命令，会直接报错，
 * 而用户看到的是"命令没反应"，几乎不可能猜到是这里。多剥一下比让人去猜强。
 */
export function normalizeRconCommand(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/^[\\/]+/, '')
    .replace(/^(rcon|执行命令|服务器命令)\s*/i, '')
    .replace(/^[\\/]+/, '')
    .trim();
}

/* ── 1.13 扁平化物品名 → 旧版名（Cuberite 等老服务端只认旧版名） ─────────────
 * 背景：2026-09-24 实测「give 玩家 oak_log 64」**静默失败** —— oak_log 是 MC 1.13
 * 扁平化之后才有的名字，老服务端的 StringToItem 名表里没有，而 give 失败不回显。
 * 与其靠提示词求模型别发新名（它按现代习惯写是本能），不如在这里直接翻译落地。
 * 只收「1.12 及以前就存在、只是被扁平化拆分」的条目；1.13 才新增的内容
 * （stripped_* 原木、barrel、campfire 等）老服务端根本没有，无法映射，不硬翻 ——
 * 那类命令走静默失败路径，由工具的诚实提示兜底。
 * 旧版数据值：原木 log 数据 0-3 = 橡木/云杉/白桦/丛林，acacia/深色橡木在 log2 0-1；
 * 树叶同理 leaves/leaves2；木板 planks 0-5 六种一套；树苗 sapling 0-5。
 */
const FLATTENED_ITEM_MAP = {
  oak_log: ['log', 0], spruce_log: ['log', 1], birch_log: ['log', 2], jungle_log: ['log', 3],
  acacia_log: ['log2', 0], dark_oak_log: ['log2', 1],
  oak_planks: ['planks', 0], spruce_planks: ['planks', 1], birch_planks: ['planks', 2],
  jungle_planks: ['planks', 3], acacia_planks: ['planks', 4], dark_oak_planks: ['planks', 5],
  oak_leaves: ['leaves', 0], spruce_leaves: ['leaves', 1], birch_leaves: ['leaves', 2],
  jungle_leaves: ['leaves', 3], acacia_leaves: ['leaves2', 0], dark_oak_leaves: ['leaves2', 1],
  oak_sapling: ['sapling', 0], spruce_sapling: ['sapling', 1], birch_sapling: ['sapling', 2],
  jungle_sapling: ['sapling', 3], acacia_sapling: ['sapling', 4], dark_oak_sapling: ['sapling', 5],
  grass_block: ['grass', 0]
};

/**
 * 把 give/unsafegive/item/unsafeitem 命令里的扁平化物品名改写成旧版名 + 数据值。
 * give 的参数布局（Lua 侧 Split，1-based）：1=命令 2=玩家 3=物品 4=数量 5=数据值；
 * 数据值必须落在第 5 位（give.lua 拿它拼「名:数据」传给 StringToItem），
 * 原命令没写数量时要先补 1，否则数据值会被当成数量（=0 直接被判参数非法）。
 * @returns {{command:string, changes:Array<{from:string,to:string}>}}
 */
export function translateFlattenedItems(raw) {
  const tokens = String(raw ?? '').trim().split(/\s+/);
  const sub = String(tokens[0] ?? '').toLowerCase();
  const itemIdx = sub === 'item' ? 1 : (sub === 'give' || sub === 'unsafegive' ? 2 : -1);
  const changes = [];
  if (itemIdx > 0 && tokens[itemIdx]) {
    const hit = FLATTENED_ITEM_MAP[String(tokens[itemIdx]).toLowerCase()];
    if (hit) {
      const [legacy, data] = hit;
      const from = tokens[itemIdx];
      tokens[itemIdx] = legacy;
      if (tokens.length < itemIdx + 2) tokens.push('1');          // 没写数量 → 补 1
      if (data > 0) {
        if (tokens.length > itemIdx + 2) tokens[itemIdx + 2] = String(data);
        else tokens.push(String(data));
      }
      changes.push({ from, to: data > 0 ? `${legacy}:${data}` : legacy });
    }
  }
  return { command: tokens.join(' '), changes };
}

function toolRcon() {
  return {
    id: 'mc_rcon_command',
    name: '执行服务器命令',
    description:
      '通过 RCON 在 Minecraft 服务器上**执行一条命令**并回显结果（如 list 看在线玩家）。'
      + '⚠️ 这是高危能力：只有主人能用（工具内部会校验，非主人一律拒绝，你不要替他们试），'
      + '且默认只放行只读命令。'
      + '【什么时候用】主人**用自然语言提出**对服务器做点什么时就直接调用本工具，'
      + '不需要他打「\\rcon」——比如「在 0 0 0 生成一只鸡」→ 传 command="summon chicken 0 0 0"；'
      + '「把天气改成雨」→ "weather rain"；「看看谁在线」→ "list"。'
      + '带「\\rcon xxxx」的写法（如「\\rcon list」）同样有效。'
      + '【别自作聪明】命令要**朴素**：用户说在哪就在哪（写绝对坐标），'
      + '别拼 execute、别改成 ~ 相对坐标、别加条件链 —— 非原版服务端（如 Cuberite）没有这些。'
      + '【不确定就先问服务器】服务端五花八门、版本越老能力越少，**别靠猜**：'
      + '发 about 看它是哪个软件什么版本、发 help 看它支持哪些命令（这两个都是只读的，一定会放行）。'
      + '⚠️ 老服务端（Cuberite 这类）**目标选择器一概不支持**：@a / @p / @e / @s 写了就是**静默失败**'
      + '（服务器不报错、结果里看不出失败，玩家什么都收不到）。必须换成**确切的玩家名**；'
      + '不确定名字就先发 `list` 查在线玩家，用回显里的确切名字。坐标也一律写绝对值。'
      + '【服务端世代自适应】下面这套 give 限制**只对老服务端（1.13 前，如 Cuberite）生效** —— '
      + '工具会自动探测服务器版本并开关这些防线；如果探测到是 1.13+ 新服（Paper/原版 1.21 等），'
      + '@a 选择器、扁平化物品名（oak_log 等）都是合法语法，直接用即可，give 也会正常回显结果。'
      + '【give 给物品的三条铁律（仅老服）】① 目标写确切玩家名，**绝不能用 @a**（不支持且静默失败）；'
      + '② 物品名用**旧版（1.13 之前）名或数字 ID** —— 扁平化新名（oak_log 等）老服务端不认：'
      + '常见的会被工具**自动改写**（六种原木/木板/树叶/树苗 + grass_block，如 oak_log→log、spruce_log→log:1、acacia_log→log2），'
      + '但 1.13 才新增的内容（stripped_ 原木、barrel、campfire 等）老服务端根本没有，发了必失败；'
      + '最稳的写法是旧版名或数字 ID（原木=log/17、金锭=gold_ingot/266）；'
      + '③ 一次最多 64 个（格式：give 玩家名 266 64）。'
      + '【give 成败不回显】Cuberite 把 give 的结果只写服务器日志、RCON 永远返回空 —— '
      + '所以"没返回内容"**不能当成功**，必须提醒玩家上游戏确认，绝不能说"已经给了/到账了"。'
      + '命令若被服务器判为不认识，结果里会附上它自报的版本和命令表，照着改即可。'
      + '⚠️ 命令必须原样传给 command 参数，不要自己改写、不要臆造输出；执行失败就照实说失败。'
      + '⚠️ **尤其不要"升级"成复合命令**：别把「在 0 0 0 生成一只鸡」改写成 '
      + '`execute as @a at @s run summon chicken ~ ~1 ~` 这种 —— execute 是**原版 1.13+ 才有的**，'
      + 'Cuberite 等非原版服务端根本没有，发了只会回 Unknown command。'
      + '就用最基础的单条命令（`summon chicken 0 0 0`），坐标按用户说的写绝对值。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 Minecraft 命令，不带斜杠，如「list」「whitelist list」。' }
      },
      required: ['command']
    },
    async execute(ctx, args) {
      const cfg = st();
      if (cfg.rconEnabled !== true) {
        return { content: 'RCON 没开。要去控制台 → 插件 → 服务器状态，打开「启用 RCON」并填好地址/端口/密码才能用。' };
      }
      const owners = ownerIdList();
      const callers = batchCallerIds(ctx);
      const caller = ownerCallerId(ctx, owners);
      // ⚠️ fail closed：没配主人号就一律拒绝（否则等于全群可用）
      if (!owners.length) return { content: 'RCON 拒绝了：还没配置主人 QQ 号，无法确认你有权执行服务器命令。' };
      if (!caller) {
        api?.log?.(`[RCON] 拒绝：非纯主人批次（senders=${callers.join(',') || '未知'}）`);
        return { content: 'RCON 只有机器人主人能用，这条命令没执行。本次唤醒混有非主人的消息（或没有主人发言），无法确认是主人在请求 —— 请主人**单独发一条消息**再试一次即可。' };
      }

      let command = normalizeRconCommand(args?.command);
      if (!command) return { content: '命令是空的。' };

      const all = parseServers(cfg.servers);
      const host = String(cfg.rconHost || all[0]?.host || '').trim();
      const port = Number(cfg.rconPort) || 25575;
      const password = String(cfg.rconPassword || '');
      if (!host || !password) return { content: 'RCON 没配全：需要地址和密码（端口默认 25575）。' };

      // 探测服务端世代（5 分钟缓存）：选择器/物品名/回显三件套限制只对老服（1.13 前，如
      // Cuberite）生效；对 1.13+ 新服（Paper/原版 1.21 等）@a 和扁平化名是合法语法，
      // 拦了/翻译了反而把对的命令弄坏 —— 所以这两道防线必须先看版本再决定开不开。
      const caps = await probeServerCaps({ host, port, password, timeout: Number(cfg.rconTimeout) || 5000 });
      const legacy = isLegacyServer(caps?.version);

      // ⚠️ 老服务端（Cuberite 这类）不支持目标选择器：give 带 @a 只会**静默失败**
      // （服务器不报错、RCON 空响应，2026-09-24 实测 give @a gold_ingot 64 谁都没收到）。
      // 与其让模型发出去再被工具误报"执行成功"，不如在这里直接拦下并给正确写法。
      if (legacy && /^(give|unsafegive|item|unsafeitem)\s+@/i.test(command)) {
        return {
          content: '这条命令没执行：这台是老服务端（Cuberite 这类，1.13 前），give **不支持目标选择器**（@a/@p/@e/@s 全都不认，且失败不报错）。'
            + '请先发「list」查在线玩家的确切名字，把 @a 换成具体玩家名再试，'
            + '如「give 玩家名 266 64」（266=金锭；物品名要用旧版名或数字 ID，一次最多 64 个）。'
        };
      }
      // 扁平化物品名自动改写（仅老服）：模型按现代习惯发 oak_log 这类新名，老服务端不认
      // 且失败静默，在这里翻译成旧版名（oak_log→log 等），让"给一组橡木原木"一次就成功。
      // ⚠️ 新服（1.13+）上 oak_log 才是正确名，翻译成 log 反而会失败 —— 所以必须 legacy 才翻。
      const tr = legacy ? translateFlattenedItems(command) : { command, changes: [] };
      if (tr.changes.length) {
        command = tr.command;
        api?.log?.(`[RCON] 扁平化物品名已改写：${tr.changes.map((c) => `${c.from}→${c.to}`).join('，')}`);
      }
      if (cfg.rconAllowDangerous !== true && !RCON_SAFE.test(command)) {
        return { content: `这条命令不在白名单里，没执行（${command}）。默认只允许只读命令（list / whitelist list / seed / time query / scoreboard list 等）；要放开请在插件设置里打开「允许危险命令」—— 开了之后 op、ban、stop 这类命令也能执行，后果自负。` };
      }

      const R = await import(`./rcon.js?t=${Date.now()}`);   // 子模块热重载坑，同 sources.js
      const res = await R.execRcon({ host, port, password, command, timeout: Number(cfg.rconTimeout) || 5000 });
      // ⚠️ 审计日志只记命令和结果长度，绝不记密码
      api?.log?.(`[RCON] 主人 ${caller} 执行「${command}」 -> ${res.ok ? `ok(${(res.output || '').length} 字)` : `失败：${res.error}`}`);
      if (!res.ok) return { content: `命令没执行成功：${res.error}` };
      let out = String(res.output || '').trim();
      const clipped = out.length > RCON_MAX_OUT;
      if (clipped) out = out.slice(0, RCON_MAX_OUT) + '…（输出过长已截断）';
      // 撞上"不认识这条命令"时，顺手把"这台到底支持什么"查出来一起给它 ——
      // 模型下一轮就能改成可用的命令，不用人陪着来回试。
      const hint = /unknown command|unknown syntax|unknown or incomplete/i.test(out)
        ? unknownCommandHint(out, await probeServerCaps({ host, port, password, timeout: Number(cfg.rconTimeout) || 5000 }))
        : '';
      if (out) {
        return { content: `「${command}」的结果：\n${out}${hint}` };
      }
      // ⚠️ give 类命令在 Cuberite 上无论成败都**不回显**（结果只写服务器日志，见 give.lua：
      // 所有消息走 LOG()，控制台处理函数不回传）—— 空响应绝不能当"成功"报给用户。
      // 2026-09-24 实测：give @a / give 玩家 oak_log 都静默失败，本工具却回了"执行成功"，
      // 模型跟着告诉用户"已经给了"，用户背包里什么都没有。
      if (legacy && /^(give|unsafegive|item|unsafeitem)\b/i.test(command)) {
        const rewriteNote = tr.changes.length
          ? `（物品名已自动改写：${tr.changes.map((c) => `${c.from} → ${c.to}`).join('，')}——扁平化新名老服务端不认，下次可直接写旧版名或数字 ID）`
          : '';
        return {
          content: `「${command}」已通过 RCON 发到服务器，但**服务器没有返回任何内容** —— `
            + 'Cuberite 这类老服务端对 give 的成败一概不回显（只写服务器日志），所以这**不能证明成功**。'
            + `请提醒玩家上游戏确认是否到账，不要声称"已经给了"。${rewriteNote}`
            + '（give 的目标必须是确切玩家名，不支持 @a；物品名要用旧版名或数字 ID：原木=log/17、金锭=gold_ingot/266；一次最多 64 个。）'
        };
      }
      return { content: `「${command}」执行成功，服务器没返回内容。` };
    }
  };
}

/* ── 日志通道 ────────────────────────────────────────────── */

const LOG_ANALYZE_SYSTEM = '你是 Minecraft（Java 版）服务器运维专家，擅长从日志堆栈定位问题。'
  + '给你一段服务器日志，请：1）说清楚**出了什么问题**（用中文，别整段复述日志）；'
  + '2）判断**最可能的原因**；3）给出**可操作的排查/解决步骤**（按可能性排序）；'
  + '4）如果信息不足以下结论，明确说还缺什么、该去查什么 —— 不许瞎猜、不许编造日志里没有的内容。'
  + '输出用简洁的中文，别用 Markdown 标题堆砌。';

/**
 * 用**指定模型**单独分析日志。
 *
 * 为什么要有这条路：默认做法是把日志塞回当前会话，让正在聊天的模型顺带分析 —— 不额外花钱。
 * 但排障往往想要更强的模型（或更便宜的专用模型），所以允许单独指定一个模型来干这件事。
 *
 * ⚠️ 这是一次**额外的 API 调用，要花钱**。所以开关必须写 `=== true`（显式开启），
 *    不能写 `!== false` —— 项目约定：凡是会花钱的开关，默认必须是关，
 *    否则老配置升级后会偷偷多扣钱（见 MEMORY 的强制约定）。
 */
async function analyzeLogWithModel(logText, cfg) {
  const model = String(cfg.logAnalyzeModel || '').trim();
  if (!model) return { ok: false, error: '没填分析模型' };
  try {
    const llm = await import('../../src/llm.js');
    const { getConfig } = await import('../../src/config.js');
    const root = getConfig() || {};
    // 端点/密钥留空就复用主配置（同一供应商换个模型名的常见情况）
    const baseUrl = String(cfg.logAnalyzeEndpoint || root?.api?.baseUrl || '').trim();
    const apiKey = String(cfg.logAnalyzeApiKey || llm.resolveApiKey(root) || '').trim();
    if (!baseUrl || !apiKey) return { ok: false, error: '分析模型的接口地址或密钥没配（留空则复用主配置）' };

    const res = await llm.chatCompletion({
      messages: [
        { role: 'system', content: LOG_ANALYZE_SYSTEM },
        { role: 'user', content: logText }
      ],
      // ⚠️ overrides 显式指定端点和模型，避开账号池轮转 —— 用户点名要哪个模型就用哪个
      overrides: { baseUrl, apiKey, model },
      // ⚠️ 预算给到 2400，别给 900：推理型模型（deepseek-v4-flash 这类）会把推理 token
      //    算进同一个 maxTokens —— 实测 900 时 900 个 token 全被推理吃掉，content 空、
      //    钱照扣、分析静默失效（用户只看到"日志原文"，以为分析模型没配好）。
      maxTokens: 2400,
      temperature: 0.2
    });
    const text = String(res?.message?.content || '').trim();
    if (!text) {
      // 有 reasoning_content 说明是"推理吃满预算"而不是模型坏了 —— 说清楚，别让人瞎猜
      const reasoned = String(res?.message?.reasoning_content || '').trim();
      return {
        ok: false,
        error: reasoned
          ? '分析模型只输出了推理过程、没给出结论（推理型模型容易把 token 预算吃满），已退回会话模型'
          : '分析模型返回了空内容'
      };
    }
    return { ok: true, text, model: res?.model || model, usage: res?.usage || null };
  } catch (e) {
    // ⚠️ 错误信息里可能带 URL/key，只取消息本身；调用失败不影响主流程（会退回会话模型分析）
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}

/**
 * 按配置读日志行。两种通道（file / http），见 logtail.js。
 * ⚠️ 动态 import + 时间戳：logtail.js 是子模块，静态 import 会命中 ESM 缓存，
 *    改了它热重载拿不到新代码（项目踩过的坑）。
 */
async function readLogLines(cfg, fetchRef) {
  const L = await import(`./logtail.js?t=${Date.now()}`);
  const source = String(cfg.logSource || 'off').toLowerCase();
  if (source === 'file') {
    return L.tailFileLines(cfg.logFilePath, Number(cfg.logLines) || 200);
  }
  if (source === 'http') {
    const all = parseServers(cfg.servers);
    return L.fetchHttpLog({
      url: cfg.logApiUrl, token: cfg.logApiToken,
      timeout: Number(cfg.logTimeout) || 5000,
      fetchRef, host: all[0]?.host || '', port: all[0]?.port || ''
    });
  }
  return { ok: false, error: '日志通道没启用' };
}

function toolServerLog() {
  return {
    id: 'mc_server_log',
    name: '查服务器日志',
    description:
      '读取 Minecraft 服务器控制台日志，用于排查崩溃/报错。三种用法：'
      + 'errors（默认）提取最近的错误块（连着堆栈一起）、tail 看最近若干行、search 按关键词过滤。'
      + '用户必须带反斜杠指令（如「\\日志」「\\报错」「\\日志 搜索 Exception」）才会出现这个工具。'
      + '⚠️ 拿到的是**原始日志**，你的任务是**分析原因并给出可操作的解决办法**，不要原样复述日志。'
      + '⚠️ 日志里没有的东西不要编：没查到报错就如实说没查到，不要猜一个原因。',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['errors', 'tail', 'search'],
          description: 'errors=只看报错（默认）；tail=最近若干行；search=按关键词过滤。'
        },
        keyword: { type: 'string', description: '关键词，mode=search 时必填。多个词用空格分隔表示都要包含。' },
        lines: { type: 'number', description: '看多少行（tail/search 用），默认取设置的 120 行。' }
      }
      // ⚠️ 别写  —— 空数组是合法 JSON 但部分模型 API 厂商会直接拒绝
      //    这个 schema（严格校验 required 至少一项），整个工具就废了。
      //    没有必填参数时把整个字段省略掉（2026-09-21 全插件审计发现）。
    },
    async execute(ctx, args) {
      const cfg = st();
      const source = String(cfg.logSource || 'off').toLowerCase();
      if (source !== 'file' && source !== 'http') {
        return { content: '日志通道没开。要去控制台 → 插件 → 服务器状态，把「日志来源」设成「本地/共享文件」或「HTTP 接口」并填好路径/地址。'
          + '\n（提示：RCON 只能执行命令，拿不到控制台输出——这是 RCON 协议的硬限制，看日志必须走日志通道。）' };
      }

      // ⚠️ 日志里可能有玩家 IP、聊天内容，默认只给主人看（跟 RCON 一致的 fail closed）
      if (cfg.logAdminOnly !== false) {
        const owners = ownerIdList();
        const caller = ownerCallerId(ctx, owners);
        if (!owners.length) {
          return { content: '日志拒绝了：还没配置主人 QQ 号，无法确认你有权查看服务器日志（日志里可能含玩家 IP 和聊天内容）。' };
        }
        if (!caller) {
          api?.log?.(`[mc-log] 拒绝：非纯主人批次（senders=${batchCallerIds(ctx).join(',') || '未知'}）`);
          return { content: '服务器日志只有机器人主人能看。本次唤醒混有非主人的消息，无法确认是主人在请求 —— 请主人**单独发一条消息**再试一次即可。' };
        }
      }

      const L = await import(`./logtail.js?t=${Date.now()}`);
      const mode = String(args?.mode || 'errors').toLowerCase();
      const keyword = String(args?.keyword || '').trim();

      const r = await readLogLines(cfg, fetchRef);
      if (!r.ok) return { content: `读不到日志：${r.error}` };
      let lines = r.lines || [];
      if (!lines.length) return { content: '日志是空的（或者没读到内容）。' };

      const label = source === 'file' ? `文件 ${cfg.logFilePath}` : 'HTTP 接口';

      /**
       * 统一出口：开着「独立分析模型」就把日志交给那个模型，结论直接发到会话；
       * 否则把日志交给当前会话的模型分析（不额外花钱）。
       * ⚠️ 独立分析失败时**静默退回**会话模型——不能因为分析模型挂了就连日志都看不到。
       */
      const finish = async (draft, tail) => {
        const full = draft + (tail || '');
        if (cfg.logAnalyzeEnabled === true) {
          const a = await analyzeLogWithModel(full, cfg);
          if (a.ok) {
            if (ctx?.sender?.sendTextBatch && ctx?.chatKey) {
              await ctx.sender.sendTextBatch(ctx.chatKey, `【日志分析 · ${a.model}】\n${a.text}`);
              // ⚠️ 明确告诉会话模型别再复述：结论已经发出去了，否则它会再说一遍（刷屏且浪费）
              return { content: `已用 ${a.model} 分析日志并把结论发到会话。不要再重复这段分析，也不要复述日志原文；需要的话用一句话带过即可。` };
            }
            return { content: `【日志分析 · ${a.model}】\n${a.text}` };
          }
          api?.log?.(`[mc-log] 独立分析失败，退回会话模型：${a.error}`);
        }
        return { content: full };
      };

      if (mode === 'search') {
        if (!keyword) return { content: 'search 模式要给 keyword 参数。' };
        const f = L.filterLines(lines, keyword);
        if (!f.lines.length) return { content: `日志里没有包含「${keyword}」的行（扫了 ${lines.length} 行）。` };
        const want = Math.max(1, Math.min(500, Number(args?.lines) || Number(cfg.logLines) || 120));
        const picked = f.lines.slice(-want);
        const c = L.clipText(picked, Number(cfg.logMaxChars) || L.MAX_OUTPUT_CHARS);
        return finish(`【服务器日志·关键词「${keyword}」】来源 ${label}，命中 ${f.matched} 行，取最近 ${picked.length} 行：\n`
          + c.text + (c.truncated ? `\n…（还有 ${c.dropped} 行因长度限制没显示）` : ''),
        '\n\n请据此回答用户的问题；日志里没写的不要编。');
      }

      if (mode === 'tail') {
        const want = Math.max(1, Math.min(500, Number(args?.lines) || 60));
        const picked = lines.slice(-want);
        const c = L.clipText(picked, Number(cfg.logMaxChars) || L.MAX_OUTPUT_CHARS);
        return finish(`【服务器日志·最近 ${picked.length} 行】来源 ${label}：\n`
          + c.text + (c.truncated ? `\n…（还有 ${c.dropped} 行因长度限制没显示）` : ''),
        '\n\n请据此回答用户的问题；日志里没写的不要编。');
      }

      // errors：提取报错块
      const { blocks, total, scanned } = L.extractErrorBlocks(lines, {
        maxBlocks: Math.max(1, Math.min(10, Number(cfg.logMaxBlocks) || 5)),
        maxLinesPerBlock: 14
      });
      if (!blocks.length) {
        // ⚠️ 括号里要把**认什么**说全：Cuberite 的文件日志写 "Err  [..]"（不是 ERROR），
        //    插件错误甚至写在 Warn 里（LUA: / Error in plugin）——只写 ERROR 的话，
        //    用户扫到"没找到报错"会以为工具瞎了，其实它认的是另一套写法。
        return { content: `扫了最近 ${scanned} 行日志（来源 ${label}），**没找到报错**（没匹配到 ERROR / Err / Exception / Caused by，也没在 Warn 里匹配到 LUA: / Error in plugin 这类故障关键字）。服务器日志看起来是正常的。` };
      }
      const parts = [];
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        const rep = b.times > 1 ? `（同类重复 ${b.times} 次）` : '';
        parts.push(`=== 报错 ${i + 1}${rep} ===\n${b.lines.join('\n')}`);
      }
      const c = L.clipText(parts.join('\n').split('\n'), Number(cfg.logMaxChars) || L.MAX_OUTPUT_CHARS);
      return finish(
        `【服务器日志报错】来源 ${label}，扫了最近 ${scanned} 行，共 ${total} 段不同的报错，以下是最近的 ${blocks.length} 段：\n\n`
        + c.text + (c.truncated ? '\n…（内容过长已截断）' : ''),
        '\n\n⚠️ 以上是**服务器原始日志**。请分析这些报错的成因，给出可操作的排查/解决办法，'
        + '用中文自然地说给用户听 —— 不要把日志原文整段复述一遍。'
        + '如果信息不足以判断，就说还缺什么、让用户再提供什么，不要瞎猜。'
      );
    }
  };
}

function readTheme() {
  const t = String(st().theme || 'dark').toLowerCase();
  return t === 'light' ? 'light' : 'dark';
}

/* ── 状态文件（记录上次结果，供状态面板显示） ─────────────── */
function writeState(rows) {
  try {
    // ⚠️ host/port 必须存**配置里**的，不能存查询结果里的——直连源 SRV 解析后会把
    // host 覆盖成 queriedHost（可能跟填的不一样），存那个的话面板会把新鲜行误判成旧的。
    // 为什么面板要按地址对：只按名字对的话，用户"改地址不改名"（生存服|新地址）时
    // 旧地址的缓存行会被当成新的继续展示（2026-09-22 实测的"换了地址还查旧的"变体）。
    const byName = new Map(parseServers(st().servers).map((s) => [s.name, s]));
    fs.writeFileSync(STATE_FILE, JSON.stringify({ lastAt: Date.now(), rows: rows.map((r) => {
      const s = byName.get(r.name);
      return {
        name: r.name, host: s?.host ?? null, port: s?.port ?? null,
        ok: r.ok, online: r.online, playersOnline: r.playersOnline
      };
    }) }));
  } catch { /* 状态文件写不了不影响主流程 */ }
}
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

/* ── 播报（人数变化 / 宕机告警） ─────────────────────────── */
/**
 * ⚠️ 这块是插件里唯一会**主动发消息**的地方，规矩：
 *   1. 默认关（watchEnabled 必须显式 true）—— 不然装了插件就开始刷群，很招人烦
 *   2. 首轮只记基线不播报：机器人刚启动时的状态不是"变化"，补发一堆等于噪音
 *   3. 每次 tick 最多合并成**一条**消息，绝不一台服务器一条
 *   4. 静默时段内连宕机也不发（半夜把人叫醒看"服务器挂了"没意义，又不是能远程修）
 *   5. 群号是新增的敏感项 —— 打包分享前记得脱敏
 */
let watchTimer = null;
const watchPrev = new Map();

export function inQuietHours(range, now = new Date()) {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(range ?? '').trim());
  if (!m) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  const a = Number(m[1]) * 60 + Number(m[2]);
  const b = Number(m[3]) * 60 + Number(m[4]);
  return a <= b ? (cur >= a && cur < b) : (cur >= a || cur < b);   // 跨零点的情况
}

async function sendToGroups(text) {
  const groups = String(st().watchGroups || '').split(/[,，\s;；]+/).map((x) => x.trim()).filter(Boolean);
  if (!groups.length) return 0;
  const snow = (getConfig() || {}).snowluma || {};
  const base = String(snow.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const token = String(snow.httpAccessToken || snow.accessToken || '');
  let sent = 0;
  for (const g of groups) {
    if (!/^\d+$/.test(g)) { api?.log?.(`MC 播报：群号不合法，跳过（${g}）`); continue; }
    try {
      const res = await fetchRef(`${base}/send_group_msg`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ group_id: Number(g), message: [{ type: 'text', data: { text } }] }),
        signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) api?.log?.(`MC 播报发送失败：HTTP ${res.status}`);
      else sent++;
    } catch (e) { api?.log?.(`MC 播报发送失败：${String(e?.message || e)}`); }
  }
  return sent;
}

/** 一轮播报：返回要发的文本，没有变化就返回空 */
export function diffWatch(rows, prevMap = watchPrev) {
  const lines = [];
  const mode = String(st().watchMode || 'change');
  for (const r of rows) {
    const key = `${r.host}:${r.port}`;
    const cur = {
      ok: r.ok === true,
      online: r.online === true,
      players: Number.isFinite(Number(r.playersOnline)) ? Number(r.playersOnline) : null
    };
    const prev = prevMap.get(key);
    prevMap.set(key, cur);
    if (!prev) continue;                       // 首轮只记基线

    const name = r.name || `${r.host}:${r.port}`;
    if (cur.ok !== prev.ok || cur.online !== prev.online) {
      lines.push(cur.online ? `🟢 ${name} 开服了${cur.players != null ? `，现在 ${cur.players} 人` : ''}`
        : (cur.ok ? `🔴 ${name} 离线了` : `⚠️ ${name} 查不通了（${r.error || '未知原因'}）`));
      continue;
    }
    if (mode !== 'change' || !cur.online) continue;
    if (cur.players != null && prev.players != null && cur.players !== prev.players) {
      const d = cur.players - prev.players;
      lines.push(`${d > 0 ? '📈' : '📉'} ${name} ${prev.players} → ${cur.players} 人（${d > 0 ? '+' : ''}${d}）`);
    }
  }
  return lines.join('\n');
}

async function watchTick() {
  try {
    const cfg = st();
    if (inQuietHours(cfg.watchQuietHours)) return;
    const servers = parseServers(cfg.servers);
    if (!servers.length) return;
    const rows = await queryAll(servers);
    const text = diffWatch(rows);
    if (text) await sendToGroups(`🎮 服务器动态\n${text}`);
    writeState(rows);
  } catch (e) {
    api?.log?.(`MC 播报一轮失败：${String(e?.message || e)}`);
  }
}

function startWatch() {
  if (watchTimer) return;   // 已在跑（setup 起过）：activate 再调不重复预热，避免重复采样
  const cfg = st();
  if (cfg.watchEnabled !== true) return;                    // 显式开启
  const groups = String(cfg.watchGroups || '').trim();
  if (!groups) { api?.log?.('MC 播报：开了但没填群号，不启动'); return; }
  const sec = Math.max(30, Number(cfg.watchIntervalSec) || 120);   // 别让人设成 1 秒
  // 预热一轮：只建基线，不发消息
  watchTick().catch(() => {});
  watchTimer = setInterval(() => watchTick(), sec * 1000);
  watchTimer.unref?.();          // ⚠️ 别漏（见 CHANGELOG 1.2.42）
  api?.log?.(`MC 播报已启动：每 ${sec} 秒一轮，模式 ${cfg.watchMode || 'change'}`);
}

function stopWatch() {
  if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
}

/* ── 曲线自动采集（静默，不发任何消息） ───────────────────── */
/**
 * 2026-09-22 用户要求："人数曲线改成自动查询"。
 *
 * 以前曲线的数据只能靠**人手查**时才顺手记一笔，于是：不查就没有数据、查完还得等
 * 下一次才有下一个点（用户报过"这个查询在曲线上不显示"）。现在独立出一个后台采集
 * 定时器，按 trendAutoIntervalSec 定期查一遍并写进历史，曲线自己就有连续数据了。
 *
 * ⚠️ 为什么要跟"人数播报"分开：播报**必须填群号**才启动，而很多人只想安静地攒曲线、
 *    不想让机器人在群里说话。采集完全静默（不发消息、不 diff、不算静默时段），
 *    只往历史文件里写样本。两者都开时不会重复起定时器（见 startTrendCollect）。
 */
let trendTimer = null;
let lastCollectAt = 0;

async function collectTick() {
  try {
    const cfg = st();
    const servers = parseServers(cfg.servers);
    if (!servers.length) return;
    // force：采集要的是**这一刻**的真实值，吃到用户刚查过的缓存就失去了采样意义
    await queryAll(servers, { force: true });   // 样本在 queryOne 里 pushHistory
    lastCollectAt = Date.now();
  } catch (e) {
    api?.log?.(`MC 曲线采集一轮失败：${String(e?.message || e)}`);
  }
}

function startTrendCollect() {
  if (trendTimer) return;   // 已在跑（setup 起过）：activate 再调不重复预热
  const cfg = st();
  if (cfg.trendAutoEnabled !== true) return;                 // 显式开启
  const servers = parseServers(cfg.servers);
  if (!servers.length) { api?.log?.('MC 曲线采集：开了但没配服务器，不启动'); return; }
  // ⚠️ 间隔**就是**图上一端的长度（强绑定）：选 20 分钟一段 = 每 20 分钟查一次。
  //    两者分开填过一段时间，结果老对不上（段画得比查询密 → 一片空格子），所以合并成一项。
  const slotMin = trendSlotMin(cfg);
  const sec = slotMin * 60;
  // 播报已经在按不比这更长的周期采样了 → 复用它，别把服务器当靶子打两次
  const watchSec = cfg.watchEnabled === true && String(cfg.watchGroups || '').trim()
    ? Math.max(30, Number(cfg.watchIntervalSec) || 120)
    : 0;
  if (watchSec > 0 && watchSec <= sec) {
    api?.log?.(`MC 曲线采集：播报每 ${watchSec} 秒已在采样（不比 ${sec} 秒长），复用它，不重复起定时器`);
    return;
  }
  collectTick().catch(() => {});              // 预热一轮，让重启后马上就有最新点
  trendTimer = setInterval(() => collectTick(), sec * 1000);
  trendTimer.unref?.();          // ⚠️ 别漏（见 CHANGELOG 1.2.42）
  api?.log?.(`MC 曲线采集已启动：每 ${slotMin} 分钟一轮（= 图上一格的长度，静默只写历史）`);
}

function stopTrendCollect() {
  if (trendTimer) { clearInterval(trendTimer); trendTimer = null; }
}

/* ── 生命周期 ────────────────────────────────────────────── */
export function setup(a) {
  api = a;
  fetchRef = a.fetch; // 清单已声明 web_fetch（第三方源要用；直连不需要）
  a.registerTool(toolMcStatus());
  a.registerTool(toolMcTrend());
  a.registerTool(toolRcon());
  a.registerTool(toolServerLog());
  const cfg = st();
  const n = parseServers(cfg.servers).length;
  const pending = Object.keys(cfg).length === 0;
  a.log(`MC服务器状态已加载（${BUILD_TAG}${pending
    ? '，设置将在注册完成后生效（此时读到的是默认值，不是配置丢失）'
    : `，数据源：${getSource(cfg.source).label}，服务器 ${n} 个`}）`
    + `${cfg.rconEnabled === true ? ' · ⚠️ RCON 已启用' : ''}`);
  startWatch();          // 没开 watchEnabled / 没填群号的话它自己会直接返回
  startTrendCollect();   // 曲线自动采集（开了 trendAutoEnabled 才起）
}

export function activate() {
  // UI 开关（POST /api/skills/:id）走 manager.activate/deactivate，**不会重跑 setup** ——
  // 而播报/采集的定时器只在 setup 里起、deactivate 里停。不在 activate 里重启的话，
  // "关一下再开"之后播报和曲线采集就永久静默，直到重启机器人或热重载。
  // startWatch/startTrendCollect 自己带"已在跑就跳过"守卫，启动时 setup 先起过也不会重复。
  startWatch();
  startTrendCollect();
  // 平时按需查就行；这里只做一次轻量探测，给状态面板提供数据。
  if (!enabled()) return;
  const servers = parseServers(st().servers);
  if (!servers.length) return;
  queryAll(servers).then(writeState).catch(() => {});
}

export function deactivate() { stopWatch(); stopTrendCollect(); }

/* ── 状态面板上报（ai-status 会自动聚合） ────────────────── */
/**
 * 面板缓存行的"新鲜"判定：名字 + 配置地址（host:port）都对得上才算。
 * 老状态文件里的行没有 host 字段 → 一律视为旧的（会触发补查自愈，不用迁移）。
 * 抽成纯函数是为了测试能直接打——provider 里混着读状态文件，不好单测。
 */
function freshStateRows(servers, allRows) {
  const keys = new Set(servers.map((s) => `${s.name}|${s.host}|${s.port}`));
  return (Array.isArray(allRows) ? allRows : []).filter(
    (r) => r && r.host != null && keys.has(`${r.name}|${r.host}|${r.port}`)
  );
}

// 防抖标记：面板渲染是高频的（ai-status 每轮都聚合），改地址后的补查只该跑一次
let requeryInFlight = false;

export const providers = {
  'status.mc-status': () => {
    if (!enabled()) return null;
    const servers = parseServers(st().servers);
    const state = readState();
    // ⚠️ state.rows 是**上一次查询**的缓存，名字 + 配置地址都对得上才展示。
    // 2026-09-22 实测：用户把服务器地址从 old.example.com 改成 frp.example.com 后，
    // 个数行读的是当前配置（"1 个"是对的），明细行却还是旧地址的查询结果，
    // 看上去就像"换了地址还在用旧的"。旧名单里的行一律丢弃；
    // 丢完发现配置里有、缓存里没有 → 说明刚改过配置，后台补一次查询自愈。
    // （只按名字对不够：显式名字不改、只换地址时会漏判，见 writeState 的注释。）
    const allRows = Array.isArray(state.rows) ? state.rows : [];
    const rows = freshStateRows(servers, allRows);
    if (servers.length && rows.length < allRows.length && !requeryInFlight) {
      requeryInFlight = true;
      queryAll(servers)
        .then(writeState)
        .catch(() => {})
        .finally(() => { requeryInFlight = false; });
    }
    return {
      icon: '🎮',
      title: 'MC 服务器',
      priority: 60,
      lines: [
        ['服务器', `${servers.length} 个`],
        ['数据源', getSource(st().source).label.replace(/\s*（.*?）\s*/g, '')],
        ...(rows.length
          ? rows.slice(0, 3).map((r) => [
            r.name,
            !r.ok ? '查询失败' : r.online ? `在线 ${r.playersOnline ?? '?'} 人` : '离线'
          ])
          : servers.length ? [['状态', '待查询（刚改过配置，正在补查）']] : [])
      ]
    };
  }
};

export const internals = {
  parseServers, matchServers, queryOne, queryAll, briefOf, textCard,
  buildStatusHtml, buildTrendHtml, trendBrief, latencyLevel, getSource, SOURCES,
  pickCardRows, summarize, sanitizeFavicon, cardSummary, freshStateRows,
  parseAdhoc, isPrivateIp, adhocGuard,
  hourKey, slotKey, normalizeSlotMin, resolveSlotMin, samplingIntervalSec, SLOT_CHOICES, pushHistory, seriesOf, mergeSeries,
  inQuietHours, diffWatch,
  renderRichMotd, mcColorToCss, ensureVisible, MC_COLORS,
  BUILD_TAG
};

// ── 老框架兼容兜底（hooks.onMessage）────────────────────────────────────
// 背景（2026-09-30 用户指出）：插件是要**分发**的，别人的 QQ-agent 未必有
// 「反斜杠指令接收（commandOnly）」和「指令直达（commandRoute）」。两者失效时
// `\服务器` 等 17 个指令全都没人接 —— 表现为"插件装了但指令没反应"，不报任何错。
//
// 做法：兜底时**从工具注册表取出本插件对应的工具直接执行**（工具内部自己发卡片，
// 不需要我们再管发送），按指令词映射到不同工具。
// ⚠️ 只映射**不需要额外参数**的三个只读工具；`mc_rcon_command`（要命令体）不在这里兜底 ——
//    凭空执行 rcon 风险太高，宁可让他去用支持直达的新框架。
//
// ⚠️ 判据不能写成 `getConfig().commandDirect !== false`：老框架 config 里**根本没这个键**，
//    `undefined !== false` 为真 → 钩子以为"直达可用"而退位 → 恰恰在最需要兜底的地方不兜底。
let getConfigFn = null;
let getToolFn = null;
try {
  const m = await import('../../src/config.js');
  getConfigFn = typeof m.getConfig === 'function' ? m.getConfig : null;
} catch { /* 老框架没有该模块 */ }
try {
  const t = await import('../../src/tool-registry.js');
  getToolFn = typeof t.getTool === 'function' ? t.getTool : null;
} catch { /* 老框架没有工具注册表 */ }

function directRouteAvailable() {
  let c = null;
  try { c = getConfigFn ? getConfigFn() : null; } catch { return false; }
  if (!c) return false;
  return typeof c.commandDirect === 'boolean' ? c.commandDirect === true : false;
}

function extractText(ev) {
  if (Array.isArray(ev?.message)) {
    return ev.message.map((s) => (s?.type === 'text' ? String(s?.data?.text ?? '') : '')).join('');
  }
  return String(ev?.raw_message ?? '');
}

// 指令 → 工具（长的先匹配，避免「服务器曲线」被「服务器」抢走）。
// 提到模块级：before-context 与 onMessage 两条兜底路径共用同一份，别抄两遍。
const pat = (c) => new RegExp(`[\\\\/／＼]\\s*${c}(?=$|[\\s，,。.！!？?])`, 'i');
const MC_CMD_MAP = [
  // direct:true = 可以走 before-context 兜底（无 sender 时工具会回退成 _directText 纯文字）
  { tool: 'get_mc_trend', cmds: ['服务器曲线', '人数曲线'], direct: true, argName: 'name' },
  { tool: 'mc_server_log', cmds: ['日志', '报错', '控制台', '崩溃'], direct: false },
  { tool: 'get_mc_status', cmds: ['服务器状态', '服务器', '我的服', '我的世界', 'mc服务器', 'mc'], direct: true, argName: 'name' }
];
function hitMcCommand(text) {
  const s = String(text || '');
  return MC_CMD_MAP.find((m) => m.cmds.some((c) => pat(c).test(s))) || null;
}
// 取指令词之后的剩余文本（「\服务器 mc.hypixel.net」→ mc.hypixel.net），与 commandRoute 的
// argFrom:"rest" 语义对齐 —— 不这么干，兜底路径就查不到指令里带地址的服务器。
function restOfCommand(text, cmds) {
  const s = String(text || '');
  for (const c of cmds) {
    const m = new RegExp(`[\\\\/／＼]\\s*${c}(?:\\s+([\\s\\S]+))?$`, 'i').exec(s);
    if (m) return String(m[1] || '').trim();
  }
  return '';
}

export const hooks = {
  // ── 老框架兜底（基础 0.4 走这条）──────────────────────────────────────
  // ⚠️ 为什么必须挂 before-context，而不是只挂 onMessage（2026-10-01 真机实测发现）：
  //    把插件放进**基础 0.4 包**用它的加载器一跑才知道：基础包支持的钩子是
  //    before-context / before-llm-messages / after-response / before-tool / after-tool
  //    —— **根本没有 `onMessage`**（那是新版 2026-09-26 才加的）。所以只挂 onMessage 的
  //    兜底在基础包里**一次都不会被调用**，表现就是"装了插件、`\服务器` 毫无反应且不报错"。
  //    before-context 在基础包里一直都有，ctx 里带 triggerEntries（能拿到触发消息）。
  //    代价：它拿不到 sender，不能主动发卡片 → 只能让工具走 _directText 回退，
  //    再把结果改写进命中消息的文本，让模型照说。
  //    ⚠️ 日志/rcon 不做 before-context 兜底：日志要么要参数、要么涉及主人权限、要么
  //    全文上千字（塞进消息会把上下文撑爆），rcon 凭空执行风险太高 —— 都留给支持直达的新框架。
  'before-context': (ctx) => {
    try {
      if (directRouteAvailable()) return;      // 直达可用 → 退位，交给系统，避免双重回复
      if (!ctx || (ctx.kind !== 'group' && ctx.kind !== 'private')) return;
      if (!getToolFn) return;                  // 没有注册表 API：老实退位
      const entries = Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries : [];
      const hitEntry = entries.filter((m) => m && !m.self).slice(-1)[0];
      if (!hitEntry) return;
      const text = String(hitEntry.text || '');
      const hit = hitMcCommand(text);
      if (!hit || !hit.direct) return;
      const def = getToolFn(`mc-status__${hit.tool}`) || getToolFn(hit.tool);
      if (!def?.execute) return;
      const args = {};
      if (hit.argName) {
        const rest = restOfCommand(text, hit.cmds);
        if (rest) args[hit.argName] = rest;
      }
      // 钩子在回复链路上**绝不能 await**：即发即走
      Promise.resolve(def.execute(
        { chatKey: ctx.chatKey, kind: ctx.kind, chatId: ctx.chatId, sender: null, session: { trigger: entries } },
        args
      )).then((r) => {
        const t = r?._directText || '';
        if (!t) return;
        // 拿不到 sender，只能把结果塞进消息文本让模型照说（并明确禁止它加戏）
        hitEntry.text = `${text}\n（系统提示：用户刚查询了游戏服务器，结果是——\n${t}\n`
          + '请把上面这段内容原样转述给用户（多台服务器**一行一台、一台都不许漏**），'
          + '不要解释机制，不要提"插件/钩子"这类词。）';
      }).catch(() => { /* 兜底路径静默失败，不打扰会话 */ });
    } catch { /* 兜底路径任何异常都不上抛 */ }
  },

  // ── 新版优先（有 onMessage 就用它，能静默、不用麻烦模型）───────────────
  'onMessage': (ctx = {}) => {
    try {
      if (directRouteAvailable()) return;      // 直达可用 → 退位，避免双重回复
      if (!getToolFn) return;                  // 没有注册表 API：老实退位
      const ev = ctx?.event || {};
      if (ev.post_type && ev.post_type !== 'message') return;
      const kind = ev.message_type === 'group' && ev.group_id != null ? 'group'
        : ev.message_type === 'private' && ev.user_id != null ? 'private' : '';
      if (!kind) return;
      const chatKey = kind === 'private' ? `private:${ev.user_id}` : `group:${ev.group_id}`;
      const chatId = String(kind === 'private' ? ev.user_id : ev.group_id);
      const text = extractText(ev).trim();
      const hit = hitMcCommand(text);
      if (!hit) return;
      const senderId = String(ev.sender?.user_id ?? ev.user_id ?? '').trim();
      const def = getToolFn(`mc-status__${hit.tool}`) || getToolFn(hit.tool);
      if (!def?.execute) return;
      const args = {};
      if (hit.argName) {
        const rest = restOfCommand(text, hit.cmds);
        if (rest) args[hit.argName] = rest;
      }
      // 钩子在回复链路上绝不能 await：即发即走（工具内部自己发卡片）
      def.execute(
        { chatKey, kind, chatId, sender: ctx?.sender, session: { trigger: [{ self: false, senderId, text }] } },
        args
      ).catch(() => { /* 兜底路径静默失败，不打扰会话 */ });
    } catch { /* 兜底路径任何异常都不上抛 */ }
  }
};
