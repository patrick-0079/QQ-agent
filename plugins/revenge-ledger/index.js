// 《复仇账本》—— 玩笑性质的记仇小本本（LLM 型技能 / skills/）
// 【分发版】报幕文案两档可选（settings.noticeFlavor）：sharp 中性锋利（默认）/ limbus 原作致敬。
//
// 为什么放 skills/：它只注册工具，由**模型主动调用**来记账（确定性插件做不到"模型想记就记"）。
// 数据落在 DATA_DIR/revenge-ledger.json，纯明文，随时可以打开看/改/删。
//
// 设计取舍：
//   · 只做增/查/销三种动作，不做"自动报复"之类会真出事的行为 —— 它是群里的梗，不是工具人。
//   · 淘汰策略先删"已销账"的旧记录，尽量不动未销账的（别把刚记的仇淹掉）。
//   · 写入用"临时文件 + 改名"，避免写一半断电留下坏 JSON。
//   · **报幕要稀有**：纪录动态只是"稿子"，真正要不要喊由 noticeGate 决定（全局冷却 + 每日上限 +
//     单项冷却 + 纯时钟纪录/换人才算新闻）。记账判据、纪录算法、销账判据都不受影响。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';

const VERSION = '1.7.0';
const STORE = path.join(DATA_DIR, 'revenge-ledger.json');
const MAX_REASON = 200;
const MAX_NAME = 40;
const MAX_EVIDENCE = 200;

let cfg = () => ({});
let log = () => {};

export function setup(api) {
  cfg = api.config || (() => ({}));
  log = api.log || (() => {});
  const id1 = api.registerTool(toolAdd());
  const id2 = api.registerTool(toolQuery());
  const id3 = api.registerTool(toolSettle());
  const s = cfg() || {};
  log(`复仇账本已加载（v${VERSION}）｜工具 ${id1} / ${id2} / ${id3}`
    + `｜报幕档 ${flavorOf(s.noticeFlavor)}`
    + `｜报幕：冷却 ${numOr(s.noticeCooldownMinutes, NOTICE_DEFAULTS.cooldownMinutes)} 分钟 /`
    + ` 每日上限 ${numOr(s.noticeDailyCap, NOTICE_DEFAULTS.dailyCap)} 次 /`
    + ` 单项 ${numOr(s.noticeKeyCooldownMinutes, NOTICE_DEFAULTS.keyCooldownMinutes)} 分钟`
    + `｜nudge：${s.nudgeEnabled === true ? '开' : '关（默认）'}`
    + `（同会话 ${numOr(s.nudgeCooldownMinutes, NUDGE_DEFAULTS.cooldownMinutes)} 分钟 /`
    + ` 每日 ${numOr(s.nudgeDailyCap, NUDGE_DEFAULTS.dailyCap)} 次）`);
}

/* ── 存储 ─────────────────────────────────────────────────────────── */

export function emptyStore() {
  return { version: 1, entries: [] };
}

export function loadStore(file = STORE) {
  try {
    if (!fs.existsSync(file)) return emptyStore();
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!raw || !Array.isArray(raw.entries)) return emptyStore();
    return raw;
  } catch (error) {
    log(`账本读取失败，按空账本处理：${error?.message ?? error}`);
    return emptyStore();
  }
}

export function saveStore(store, file = STORE) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

/* ── 纯逻辑（可测）──────────────────────────────────────────────── */

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

export function nextId(store) {
  const n = (store.entries || []).reduce((max, e) => {
    const m = /^e(\d+)$/.exec(String(e?.id ?? ''));
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);
  return `e${n + 1}`;
}

/** 记一笔。target 可以是 QQ 号或昵称；同名同因未销账的记录会合并（仇恨值累加），避免刷屏。 */
export function addEntry(store, { target, reason, weight, evidence = '', chatKey = '', at = Date.now(), defaultWeight = 1 } = {}) {
  const t = clip(target, MAX_NAME);
  const r = clip(reason, MAX_REASON);
  if (!t) return { ok: false, error: '要记谁的仇？请给 QQ 号或昵称' };
  if (!r) return { ok: false, error: '因为什么？请写一句缘由' };
  const w = Math.max(1, Math.min(5, Math.round(Number(weight) || Number(defaultWeight) || 1)));
  const numeric = /^\d{5,}$/.test(t);
  const dup = store.entries.find((e) => e.status === 'open'
    && String(e.targetName) === t && String(e.reason) === r
    && ((numeric && String(e.targetId) === t) || (!numeric && !e.targetId)));
  if (dup) {
    dup.weight = Math.max(1, Math.min(5, Number(dup.weight) + w));
    dup.repeats = (Number(dup.repeats) || 1) + 1;
    dup.at = at;
    if (evidence) dup.evidence = clip(evidence, MAX_EVIDENCE);
    return { ok: true, entry: dup, merged: true };
  }
  const entry = {
    id: nextId(store),
    targetId: numeric ? t : '',
    targetName: t,
    reason: r,
    weight: w,
    evidence: clip(evidence, MAX_EVIDENCE),
    chatKey: String(chatKey || ''),
    at,
    status: 'open',
    repeats: 1,
    settledAt: null,
    settleNote: ''
  };
  store.entries.push(entry);
  return { ok: true, entry, merged: false };
}

/** 查账：target 可省；status=open|settled|all；mode=list|rank。 */
export function queryEntries(store, { target = '', status = 'open', limit = 20, mode = 'list' } = {}) {
  const t = clip(target, MAX_NAME);
  let rows = (store.entries || []).slice();
  if (status !== 'all') rows = rows.filter((e) => e.status === status);
  if (t) rows = rows.filter((e) => String(e.targetName) === t || String(e.targetId) === t);
  const lim = Math.max(1, Math.min(50, Math.round(Number(limit) || 20)));
  if (mode === 'rank') {
    const agg = new Map();
    for (const e of rows) {
      const key = String(e.targetId || e.targetName);
      const cur = agg.get(key) || { who: String(e.targetName || e.targetId), total: 0, count: 0, reasons: [] };
      cur.total += Number(e.weight) || 1;
      cur.count += 1;
      if (e.reason) cur.reasons.push(String(e.reason));
      agg.set(key, cur);
    }
    const rank = [...agg.values()].sort((a, b) => b.total - a.total || b.count - a.count).slice(0, lim);
    return { mode: 'rank', rows: rank, total: agg.size };
  }
  rows.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
  return { mode: 'list', rows: rows.slice(0, lim), total: rows.length };
}

/** 销账：按 id 或 target（target 时销掉他所有未销账记录）。 */
export function settleEntry(store, { id = '', target = '', note = '', at = Date.now() } = {}) {
  const n = clip(note, MAX_REASON);
  let hit = [];
  if (id) {
    const e = store.entries.find((x) => String(x.id) === String(id));
    if (e) hit = [e];
  } else {
    const t = clip(target, MAX_NAME);
    if (t) hit = store.entries.filter((e) => e.status === 'open' && (String(e.targetName) === t || String(e.targetId) === t));
  }
  if (!hit.length) return { ok: false, error: id ? `没有编号 ${id} 这笔账` : '要销谁的账？请给 QQ 号、昵称或记录编号' };
  for (const e of hit) {
    e.status = 'settled';
    e.settledAt = at;
    e.settleNote = n;
  }
  return { ok: true, settled: hit.map((e) => ({ id: e.id, who: e.targetName, reason: e.reason })), note: n };
}

/** 淘汰：先删最旧的已销账记录，仍超再删最旧的未销账记录。 */
export function prune(store, max = 200) {
  const cap = Math.max(10, Math.round(Number(max) || 200));
  if (store.entries.length <= cap) return { removed: 0 };
  let removed = 0;
  const byOldest = (a, b) => (Number(a.at) || 0) - (Number(b.at) || 0);
  for (const status of ['settled', 'open']) {
    while (store.entries.length > cap) {
      const pool = store.entries.filter((e) => e.status === status).sort(byOldest);
      if (!pool.length) break;
      const victim = pool[0];
      store.entries = store.entries.filter((e) => e !== victim);
      removed += 1;
    }
  }
  return { removed };
}

const stars = (w) => '★'.repeat(Math.max(1, Math.min(5, Number(w) || 1)));
const day = (ts) => {
  const d = new Date(Number(ts) || Date.now());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function formatLedger(rows) {
  // 展示时也截断：账本是明文文件，用户可能手改过，长度不能只依赖写入时的限制
  return rows.map((e) => `· [${e.id}] ${clip(e.targetName, MAX_NAME)}｜${stars(e.weight)}｜${clip(e.reason, MAX_REASON)}` +
    (e.repeats > 1 ? `（记了 ${e.repeats} 次）` : '') + `｜${day(e.at)}` +
    (e.status === 'settled' ? '｜已销账' : '')).join('\n');
}

/* ── 纪录系统（打破纪录 → 让模型喊出来）────────────────────────────── */

const MIN = 60 * 1000;

export function fmtDur(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (n < MIN) return `${Math.round(n / 1000)} 秒`;
  if (n < 60 * MIN) return `${Math.round(n / MIN)} 分钟`;
  if (n < 48 * 60 * MIN) return `${(n / (60 * MIN)).toFixed(1)} 小时`;
  return `${(n / (24 * 60 * MIN)).toFixed(1)} 天`;
}

const holderOf = (e) => String(e.targetName || e.targetId || '无名');
const keyOf = (e) => String(e.targetId || e.targetName || '');

/**
 * 算当前各项纪录。每条形如：
 *   { key, title, holder, holderKey, value, better:'smaller'|'larger', show:'12 分钟', meaningful:boolean, entryId? }
 * meaningful = 这个成绩本身值不值得喊出来（避免第一笔账就刷出一堆"纪录"）。
 */
export function computeRecords(store) {
  const es = (store.entries || []).filter((e) => e && e.at);
  const out = {};
  const put = (rec) => { out[rec.key] = rec; };
  const byTarget = new Map();
  for (const e of es) {
    const k = keyOf(e);
    if (!byTarget.has(k)) byTarget.set(k, []);
    byTarget.get(k).push(e);
  }

  // ① 最快三连：同一个人 3 笔账的最小时间跨度
  let triple = null;
  for (const [k, arr] of byTarget) {
    if (arr.length < 3) continue;
    const ts = arr.map((e) => Number(e.at)).sort((a, b) => a - b);
    for (let i = 0; i + 2 < ts.length; i += 1) {
      const span = ts[i + 2] - ts[i];
      if (!triple || span < triple.value) triple = { value: span, holder: holderOf(arr[0]), holderKey: k };
    }
  }
  if (triple) put({ key: 'fastestTriple', title: '最快三连（连吃三笔）', better: 'smaller', show: fmtDur(triple.value), meaningful: triple.value < 24 * 60 * MIN, ...triple });

  // ② 最速回锅：销账之后又被记上，间隔最短
  let reboil = null;
  for (const [k, arr] of byTarget) {
    const settled = arr.filter((e) => e.status === 'settled' && e.settledAt).map((e) => Number(e.settledAt)).sort((a, b) => a - b);
    const later = arr.filter((e) => e.status === 'open').map((e) => Number(e.at)).sort((a, b) => a - b);
    for (const s of settled) {
      const next = later.find((t) => t >= s);
      if (next === undefined) continue;
      const gap = next - s;
      if (!reboil || gap < reboil.value) reboil = { value: gap, holder: holderOf(arr[0]), holderKey: k };
    }
  }
  if (reboil) put({ key: 'fastestReboil', title: '最速回锅（刚洗白又被记）', better: 'smaller', show: fmtDur(reboil.value), meaningful: reboil.value < 6 * 60 * MIN, ...reboil });

  // ③ 单笔最高仇恨值（取最先到的那个人的那一笔）
  const tops = es.filter((e) => Number(e.weight) >= 5).sort((a, b) => Number(a.at) - Number(b.at));
  if (tops.length) {
    const e = tops[0];
    put({ key: 'highestWeight', title: '单笔最高仇恨（五星满级）', better: 'larger', value: 5, show: '★★★★★', holder: holderOf(e), holderKey: keyOf(e), entryId: e.id, meaningful: true });
  }

  // ④ 记账笔数最多
  let most = null;
  for (const [k, arr] of byTarget) if (!most || arr.length > most.value) most = { value: arr.length, holder: holderOf(arr[0]), holderKey: k };
  if (most) put({ key: 'mostEntries', title: '被记笔数最多', better: 'larger', show: `${most.value} 笔`, meaningful: most.value >= 3, ...most });

  // ⑤ 累计仇恨值最高
  let total = null;
  for (const [k, arr] of byTarget) {
    const v = arr.reduce((s, e) => s + (Number(e.weight) || 1), 0);
    if (!total || v > total.value) total = { value: v, holder: holderOf(arr[0]), holderKey: k };
  }
  if (total) put({ key: 'highestTotal', title: '累计仇恨最高（榜首）', better: 'larger', show: `${total.value} 点`, meaningful: total.value >= 5, ...total });

  // ⑥ 同一件事被记次数最多
  const rep = es.filter((e) => Number(e.repeats) >= 3).sort((a, b) => Number(b.repeats) - Number(a.repeats) || Number(a.at) - Number(b.at))[0];
  if (rep) put({ key: 'mostRepeats', title: '同一件事被记最多次', better: 'larger', value: Number(rep.repeats), show: `${rep.repeats} 次`, holder: holderOf(rep), holderKey: keyOf(rep), entryId: rep.id, meaningful: true });

  // ⑦ 最快洗白：从记账到销账用时最短
  const settled = es.filter((e) => e.status === 'settled' && e.settledAt && Number(e.settledAt) >= Number(e.at));
  if (settled.length) {
    const best = settled.map((e) => ({ e, v: Number(e.settledAt) - Number(e.at) })).sort((a, b) => a.v - b.v)[0];
    put({ key: 'fastestSettle', title: '最快洗白（记上到销账）', better: 'smaller', value: best.v, show: fmtDur(best.v), holder: holderOf(best.e), holderKey: keyOf(best.e), entryId: best.e.id, meaningful: best.v < 60 * MIN });
  }

  // ⑧ 最久未销（陈年旧账）—— 注意：它的数值 = 现在 - 最早未销那笔的时间，**会随钟自己变大**，
  // 所以标 clock:true：只有"换人"（旧账区换人）才算新闻，光时间流逝不算（否则每记一笔都判成打破纪录）。
  const open = es.filter((e) => e.status === 'open').sort((a, b) => Number(a.at) - Number(b.at));
  if (open.length) {
    const e = open[0];
    const age = Math.max(0, Date.now() - Number(e.at));
    put({ key: 'longestOpen', title: '陈年旧账（最久没销）', better: 'larger', value: age, show: fmtDur(age), holder: holderOf(e), holderKey: keyOf(e), entryId: e.id, meaningful: age > 24 * 60 * MIN, clock: true });
  }

  return out;
}

/** 对比上一次快照：谁打破了纪录 / 谁立了新纪录（新纪录要过 meaningful 才值得喊）。 */
export function diffRecords(prev = {}, next = {}) {
  const broken = [];
  const established = [];
  for (const [key, rec] of Object.entries(next)) {
    const old = prev[key];
    if (!old) {
      if (rec.meaningful) established.push(rec);
      continue;
    }
    const improved = rec.better === 'smaller' ? rec.value < old.value : rec.value > old.value;
    if (improved) broken.push({ ...rec, prevHolder: old.holder, prevShow: old.show, prevHolderKey: old.holderKey });
  }
  return { broken, established };
}

/** 只把"够夸张"的成绩写进纪录基线 —— 否则每多记一笔都算打破纪录，会变成刷屏。 */
export function meaningfulOnly(records) {
  return Object.fromEntries(Object.entries(records || {}).filter(([, r]) => r && r.meaningful));
}

/* ── 报幕降频闸门 ───────────────────────────────────────────────────
   为什么必须有：`longestOpen`（陈年旧账）的数值 = 现在 - 最早未销那笔的时间，**自己每秒都会变大**，
   而它 better='larger' ⇒ 只要账本上有一条旧账，**每记一笔、每销一笔都会被判定成"打破纪录"**，
   报幕频率 = 记账频率（所以必须有闸门）。

   闸门只决定"这次的报幕稿要不要交给模型喊"，**不动记账判据、不动纪录算法、不动销账判据**：
     · 全局冷却  noticeCooldownMinutes      两次报幕至少隔这么久
     · 每日上限  noticeDailyCap             一天最多报几次
     · 单项冷却  noticeKeyCooldownMinutes   同一条纪录多久内不重复报
     · 纯时钟纪录（clock:true）只有"换人"才算新闻 —— 光时间流逝不算
   基线 store.records 照旧每次都更新：冷却是"丢掉"，不是"排队补发"（不然解除冷却时会一次性炸一堆）。 */
const NOTICE_DEFAULTS = { cooldownMinutes: 360, dailyCap: 3, keyCooldownMinutes: 1440 };

/** 数字兜底：settings 里没填/填了非法值就用默认；显式填 0 = 关掉该项限制。 */
const numOr = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

/**
 * 报幕闸门。纯函数：不改入参，返回 { notices, state, ... }。
 * state = { lastAt, day, dayCount, keys: { 纪录key: 上次报的时间 }, rot }
 */
export function noticeGate(state = {}, notices = {}, now = Date.now(), opts = {}) {
  const o = opts || {};
  const cooldown = numOr(o.cooldownMinutes, NOTICE_DEFAULTS.cooldownMinutes) * MIN;
  const keyCooldown = numOr(o.keyCooldownMinutes, NOTICE_DEFAULTS.keyCooldownMinutes) * MIN;
  const dailyCap = Math.round(numOr(o.dailyCap, NOTICE_DEFAULTS.dailyCap));
  const st = {
    lastAt: Number(state?.lastAt) || 0,
    day: String(state?.day || ''),
    dayCount: Number(state?.dayCount) || 0,
    keys: { ...(state?.keys || {}) },
    rot: Number(state?.rot) || 0
  };
  const today = day(now);
  if (st.day !== today) { st.day = today; st.dayCount = 0; }

  // 先按"单项冷却 / 纯时钟纪录"筛出真正算新闻的
  const ready = [];
  for (const kind of ['broken', 'established']) {
    for (const rec of notices[kind] || []) {
      if (!rec || !rec.key) continue;
      // 纯时钟纪录：时间自己变大不算新闻，只有持有人换人（旧账区换人）才算
      if (rec.clock === true && String(rec.holderKey) === String(rec.prevHolderKey)) continue;
      if (now - (Number(st.keys[rec.key]) || 0) < keyCooldown) continue;
      ready.push({ kind, rec });
    }
  }

  const fired = [];
  if (ready.length && now - st.lastAt >= cooldown && st.dayCount < dailyCap) {
    fired.push(...ready);
    st.lastAt = now;
    st.dayCount += 1;
    for (const it of fired) st.keys[it.rec.key] = now;
    st.rot += fired.length;   // 轮换游标：连着报也不会是同一句
  }
  const out = { broken: [], established: [] };
  for (const it of fired) out[it.kind].push(it.rec);
  return {
    notices: out,
    state: st,
    ready: ready.length,
    fired: fired.length,
    suppressed: ready.length - fired.length,
    blockedBy: fired.length ? '' : (ready.length ? (now - st.lastAt < cooldown ? 'cooldown' : 'dailyCap') : 'noNews')
  };
}

/* 报幕文案 —— 两档可选，键名 noticeFlavor（写进 plugin.json 的 settings，设置页是下拉，一键切）。
      · 'sharp'（默认档）：中性但同样锋利，**不依赖任何具体人设** —— 谁的机器上都是这套词。
      · 'limbus'（原作致敬档）：《边狱巴士》「中指」《复仇账簿》那套口气（条款号 / 如数奉还）。
   两档共用同一套「中指」骨架：账簿抬头 / 第X条第Y项 / 如数奉还 / 中指时刻铭记 / 永不遗忘 ——
   锋利感不驯化，只是换了说话方式；报幕依旧是稀有事件（noticeGate 说了算）。
   ⚠️ 条款号是本项目**自编的致敬写法**，不是游戏里的真实条款（README 有声明）。
   想换成自己 AI 的口气：直接改下面两个数组里的句子（README「改成自己 AI 的口气」一节）。 */
export const NOTICE_FLAVORS = {
  sharp: {
    broken: [
      '—— 啧。又够一页了。你名字快写满这本。',
      '—— 记上了。该还我的，又多一笔。',
      '—— 哼，刻上去的擦不掉。别指望我忘。',
      '—— 翻到 {n} 你就知道了。',
      '—— 算了……啧。也写进账簿里吧。'
    ],
    fresh: [
      '—— 新的一条。别急，账不会自己消失。',
      '—— 抄上了。这本子只增不减。',
      '—— {n}。先记着，利息以后再算。'
    ],
    queryNote: '……翻本子。别催。'
  },
  limbus: {
    broken: [
      '—— 依据{n}，此笔已记于账簿之上。',
      '—— {n}。已归档；如数奉还，只是时间问题。',
      '—— 中指时刻铭记。这笔账，永不遗忘。',
      '—— 已刻录。账簿不会漏记，也不会错记。',
      '—— {n} 生效。你做过的事，一笔一笔都在这本账簿里。'
    ],
    fresh: [
      '—— 新条目立卷：{n}。永不遗忘。',
      '—— 账簿再添一页。此仇，如数奉还。',
      '—— 已记录在案。中指从不漏掉任何一笔。'
    ],
    queryNote: '……正在检索与「惹人恼火」相关的条目。'
  }
};
export const FLAVOR_DEFAULT = 'sharp';
export const flavorOf = (v) => (Object.prototype.hasOwnProperty.call(NOTICE_FLAVORS, String(v ?? ''))
  ? String(v) : FLAVOR_DEFAULT);
export const queryNoteOf = (s = {}) => NOTICE_FLAVORS[flavorOf(s?.noticeFlavor)].queryNote;
// 中指《复仇账簿》的口号与「家人」梗：两档共用 —— 这是骨架，不是人设
const LEDGER_HOLD = '—— 如数奉还。中指记着的账，一笔都不会少。';
const LEDGER_SOFT = '—— 家里那点事我懒得管。……你的账我替你记着。';

const MATTHIAS_KEYS = new Set(['longestOpen', 'fastestReboil']);

const MIDDLE_CLAUSE = {
  highestWeight: '第13条第2项',
  fastestTriple: '第27条第5项',
  fastestReboil: '第41条第1项',
  mostEntries: '第53条第4项',
  highestTotal: '第72条第3项D行第4列',
  mostRepeats: '第88条第2项',
  fastestSettle: '第9条第7项',
  longestOpen: '第108条第6项'
};

export function formatRecords(records) {
  const list = Object.values(records || {}).sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key));
  if (!list.length) return '还没有任何纪录（账本太干净了）';
  return list.map((r) => `· ${r.title}：${r.holder}｜${r.show}`).join('\n');
}

const ORDER = ['highestWeight', 'fastestTriple', 'fastestReboil', 'mostEntries', 'highestTotal', 'mostRepeats', 'fastestSettle', 'longestOpen'];

/**
 * 给模型看的"打破纪录"报幕稿。只出稿，不决定要不要喊（那是 noticeGate 的事）。
 * rot = 轮换游标：同一类报幕连着来也不会是同一句，免得听腻。
 */
export function recordNotice({ broken = [], established = [] } = {}, rot = 0, flavor = FLAVOR_DEFAULT) {
  const lines = [];
  let i = Math.max(0, Math.round(Number(rot) || 0));
  const f = NOTICE_FLAVORS[flavorOf(flavor)];
  const pick = (arr) => arr[i++ % arr.length];
  for (const r of broken) {
    const clause = MIDDLE_CLAUSE[r.key] || '第??条';
    lines.push(`【账簿】${clause}｜打破纪录｜${r.title}｜${r.holder}｜${r.show}（原 ${r.prevHolder} ${r.prevShow}）`);
    lines.push(pick(f.broken).replace('{n}', clause));
    if (MATTHIAS_KEYS.has(r.key)) lines.push(LEDGER_SOFT);
  }
  for (const r of established) {
    const clause = MIDDLE_CLAUSE[r.key] || '第??条';
    lines.push(`【账簿】${clause}｜新纪录｜${r.title}｜${r.holder}｜${r.show}`);
    lines.push(pick(f.fresh).replace('{n}', clause));
  }
  if (lines.length) {
    lines.push('→ 用你自己的口气把这句说出来，一句话就够，别念整张表、别念成公告、别演成真的威胁。'
      + '想加锋利感就带一个：「如数奉还 / 中指时刻铭记 / 永不遗忘」，别堆。');
  }
  return lines;
}

/**
 * 记账 / 销账 之后统一走一遍：算纪录 → 比对基线 → 过降频闸门 → 出报幕稿。
 * 基线（store.records）和闸门状态（store.noticeState）都在这里更新，调用方只管 saveStore。
 */
function checkRecords(store, s = {}) {
  const nextRecords = computeRecords(store);
  const diff = diffRecords(store.records || {}, nextRecords);
  const gate = noticeGate(store.noticeState || {}, diff, Date.now(), {
    cooldownMinutes: s.noticeCooldownMinutes,
    dailyCap: s.noticeDailyCap,
    keyCooldownMinutes: s.noticeKeyCooldownMinutes
  });
  const notice = recordNotice(gate.notices, gate.state.rot, s.noticeFlavor);
  store.records = meaningfulOnly(nextRecords);
  store.noticeState = gate.state;
  return notice;
}

/* ── 工具 ─────────────────────────────────────────────────────────── */

const ok = (payload) => ({ content: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 1) });
const err = (message) => ({ content: `错误：${message}`, isError: true });

function toolAdd() {
  return {
    id: 'revenge_add',
    name: '记一笔仇',
    category: 'memory',
    icon: '📕',
    description: '往《复仇账本》里记一笔：谁、因为什么、仇恨值几星（1~5）。'
      + '适用：群友惹到你/欠着没还/说话太损/鸽了你，或者有人让你「记下来」。'
      + '同一个人的同一件事重复记会合并（仇恨值累加），不用怕记重。'
      + '这是玩笑账本，不要用来记录真实隐私（住址/电话/证件/单位），也不要当成威胁或报复的手段。',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '记谁的仇：QQ 号或昵称（必填）' },
        reason: { type: 'string', description: '因为什么记这一笔（必填，一句话）' },
        weight: { type: 'number', description: '仇恨值 1~5 星，默认取设置里的值（1）' },
        evidence: { type: 'string', description: '可选：对方的原话/证据，方便以后翻旧账' }
      },
      required: ['target', 'reason']
    },
    async execute(ctx, args) {
      try {
        const store = loadStore();
        const s = cfg() || {};
        const r = addEntry(store, {
          target: args?.target,
          reason: args?.reason,
          weight: args?.weight,
          evidence: args?.evidence,
          chatKey: ctx?.chatKey ?? '',
          defaultWeight: s.defaultWeight
        });
        if (!r.ok) return err(r.error);
        const pruned = prune(store, s.maxEntries).removed;
        const notice = checkRecords(store, s);   // 纪录检测 → 比对基线 → 过降频闸门 → 出报幕稿
        saveStore(store);
        const open = store.entries.filter((e) => e.status === 'open').length;
        return ok({
          已记下: `[${r.entry.id}] ${r.entry.targetName}｜${stars(r.entry.weight)}｜${r.entry.reason}`,
          合并到旧账: Boolean(r.merged),
          账本未销账笔数: open,
          淘汰旧账: pruned || 0,
          ...(notice.length ? { 纪录动态: notice } : {}),
          提示: '这是玩笑账本；对方道歉或补偿后用 revenge_settle 销账，别每轮都翻出来念。'
        });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  };
}

function toolQuery() {
  return {
    id: 'revenge_query',
    name: '翻复仇账本',
    category: 'memory',
    icon: '📖',
    description: '查《复仇账本》：列出记录的仇（默认只看没销账的），或者按仇恨值出「仇恨榜」。'
      + '适用：想翻旧账、想知道谁欠自己最多、被问「你都记了谁」。',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '只看某个人的账（QQ 号或昵称），不传 = 全部' },
        status: { type: 'string', enum: ['open', 'settled', 'all'], description: '只看未销账(open，默认) / 只看已销账(settled) / 全部(all)' },
        mode: { type: 'string', enum: ['list', 'rank', 'records'], description: 'list = 按时间列出（默认）；rank = 出仇恨榜（按总仇恨值排序）；records = 看当前各项纪录保持者（最快三连/最速回锅/最高仇恨/最快洗白…）' },
        limit: { type: 'number', description: '最多返回几条，默认 20（上限 50）' }
      }
    },
    async execute(ctx, args) {
      try {
        const store = loadStore();
        if ((args?.mode || 'list') === 'records') {
          return ok({
            当前纪录: formatRecords(computeRecords(store)).split('\n'),
            说明: '这是账本上各项纪录的当前保持者；有人刷新纪录时，记/销账的工具会提示你喊出来。'
          });
        }
        const res = queryEntries(store, {
          target: args?.target,
          status: args?.status || 'open',
          mode: args?.mode || 'list',
          limit: args?.limit
        });
        const open = store.entries.filter((e) => e.status === 'open').length;
        if (!res.rows.length) {
          return ok({ 结果: '账本上没有符合条件的记录', 账本未销账笔数: open });
        }
        if (res.mode === 'rank') {
          return ok({
            仇恨榜: res.rows.map((r, i) => `${i + 1}. ${r.who}｜总仇恨 ${r.total}｜${r.count} 笔`),
            上榜人数: res.total
          });
        }
        return ok({ 记录: formatLedger(res.rows), 命中: res.total, 展示: res.rows.length, 账本未销账笔数: open, 账簿旁白: queryNoteOf(cfg() || {}) });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  };
}

function toolSettle() {
  return {
    id: 'revenge_settle',
    name: '销一笔账',
    category: 'memory',
    icon: '🕊️',
    description: '销账：对方道歉/补偿/事情翻篇了，把这笔从账本上划掉。'
      + '可以传记录编号（[e12] 里的 e12），也可以传 QQ 号或昵称（会销掉他所有未销账记录）。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记录编号，如 e12（从 revenge_query 结果里拿）' },
        target: { type: 'string', description: '或者按人销：QQ 号或昵称（销掉他所有未销账记录）' },
        note: { type: 'string', description: '可选：销账理由，例如「请了奶茶」' }
      }
    },
    async execute(ctx, args) {
      try {
        if (!args?.id && !args?.target) return err('请给记录编号(id)或要销账的人(target)');
        const store = loadStore();
        const r = settleEntry(store, { id: args?.id, target: args?.target, note: args?.note });
        if (!r.ok) return err(r.error);
        const notice = checkRecords(store, cfg() || {});   // 销账也可能刷新纪录 → 同样过降频闸门
        saveStore(store);
        return ok({
          已销账: r.settled.map((x) => `[${x.id}] ${x.who}｜${x.reason}`),
          笔数: r.settled.length,
          备注: r.note || '（无）',
          ...(notice.length ? { 纪录动态: notice } : {})
        });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  };
}

export const internals = {
  addEntry, queryEntries, settleEntry, prune, formatLedger, nextId, emptyStore, clip, stars, VERSION, STORE,
  computeRecords, diffRecords, formatRecords, recordNotice, fmtDur, meaningfulOnly,
  noticeGate, NOTICE_DEFAULTS, NOTICE_FLAVORS, FLAVOR_DEFAULT, flavorOf, queryNoteOf,
  nudgeGate                     // NUDGE_DEFAULTS 在下面才声明（TDZ），从 internals2 取
};

/* ── 使用倾向强化：命中触发词时，在请求末尾贴一句提醒 ──────────────
   背景：模型很少主动调工具，账本很容易被忽略。
   系统提示里的规则离"眼前这句话"太远，所以在**命中关键词的那一轮请求末尾**补一句，
   贴着当前对话提醒它去查/去记。只追加到末尾 → 前缀缓存不受影响。

   ── 收窄（只改"何时 nudge"，文案与报幕一个字没动）──────────
   三件事，都指向"它比想象中脏"：
     ① hooks 从没接上：loader 只读 `mod.hooks`，裸导出的 beforeLlmMessages 是**死代码**。
        所以这里先把它接上，但**默认关**（见下）。
     ② 就算接上，老实现也是"每轮必中"：宿主传进来的 messages 里含**系统提示词**，
        而本技能自己的规则段里就写着"账本/记账/记仇…" ⇒ 命中率不是"偶发"而是 100%。
        现在改成只看**本轮触发批的原文**（context.triggerText），
        拿不到才退回"最后两条**非 system** 消息"。
     ③ 词表太宽：18 个分支里"记账/还清/旧账/记下来/记上/我记着/算笔账/算个仇/复仇"
        都是日常话（还清水电费、旧账翻篇、我记着你说的话…），跟"账本这个梗"没关系。
   频率闸门：同一会话 240 分钟最多一次 + 全局每天最多 2 次，状态持久化到
   STORE 的 **nudgeState**（只追加新键；entries / records / noticeState 一律不碰）。
   `nudgeEnabled` 默认 false：想开就在**技能设置页**把 nudgeEnabled 打开（同一个字段，一键可逆）。 */
const NUDGE_RE = /(账本|账簿|小本本|记仇|翻旧账|仇恨榜|谁欠我|销账|记一笔|给你记|记[你我他]一笔|这笔账)/;

const NUDGE_MARK = '《复仇账本》就该动了';
const NUDGE_DEFAULTS = { enabled: false, cooldownMinutes: 240, dailyCap: 2 };

export function ledgerNudge(text) {
  const t = String(text ?? '');
  if (!NUDGE_RE.test(t)) return '';
  return '（这句话碰到了账本相关的话题：《复仇账本》就该动了 —— 要记就调 revenge_add，要翻就调 revenge_query，要销就调 revenge_settle；查完/记完再用你自己的语气回一句，别只在嘴上说"记下了"。）';
}

/**
 * nudge 闸门。纯函数：不改入参，返回 { fire, blockedBy, state }。
 * state = { lastAt, day, dayCount, sessions: { 会话key: 上次提醒时间 } }
 * 冷却是"丢掉"不是"排队补发"——被挡住这次就没了，不会集中爆发。
 */
export function nudgeGate(state = {}, { chatKey = '', now = Date.now() } = {}, opts = {}) {
  const o = opts || {};
  const cooldown = numOr(o.cooldownMinutes, NUDGE_DEFAULTS.cooldownMinutes) * MIN;
  const dailyCap = Math.round(numOr(o.dailyCap, NUDGE_DEFAULTS.dailyCap));
  const st = {
    lastAt: Number(state?.lastAt) || 0,
    day: String(state?.day || ''),
    dayCount: Number(state?.dayCount) || 0,
    sessions: { ...(state?.sessions || {}) }
  };
  const today = day(now);
  if (st.day !== today) { st.day = today; st.dayCount = 0; }

  const key = String(chatKey || '');
  const lastSessionAt = Number(st.sessions[key]) || 0;
  let fire = false;
  let blockedBy = '';
  // dailyCap = 0 → 一次都不贴（和 noticeGate 的"填 0 = 关掉"一致，等于总闸）；
  // cooldown = 0 → 不限这一项。
  if (dailyCap <= 0 || st.dayCount >= dailyCap) blockedBy = 'dailyCap';
  else if (cooldown > 0 && key && now - lastSessionAt < cooldown) blockedBy = 'sessionCooldown';
  else if (cooldown > 0 && !key && now - st.lastAt < cooldown) blockedBy = 'cooldown';
  else fire = true;

  if (fire) {
    st.lastAt = now;
    st.dayCount += 1;
    if (key) st.sessions[key] = now;
    // 状态文件是明文常驻的：只留最近 60 个会话，别让它无限长大
    st.sessions = Object.fromEntries(
      Object.entries(st.sessions).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 60)
    );
  }
  return { fire, blockedBy, state: st };
}

export function beforeLlmMessages({ messages, triggerText, chatKey } = {}) {
  try {
    // 默认关。开 = 显式把 nudgeEnabled 设成 true（默认值见 plugin.json settings）。
    if (cfg()?.nudgeEnabled !== true) return;
    const list = Array.isArray(messages) ? messages : [];
    if (!list.length) return;
    const last = list[list.length - 1];
    if (!last) return;
    const textOf = (m) => {
      const c = m?.content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) return c.map((x) => (typeof x?.text === 'string' ? x.text : '')).join(' ');
      return '';
    };
    // 只看"眼前这句话"：优先用宿主给的本轮触发批原文；
    // 退回时也跳过 system —— 否则系统提示词里的账本规则会让每一轮都命中。
    let source = typeof triggerText === 'string' ? triggerText : '';
    if (!source.trim()) {
      source = list.filter((m) => m && m.role !== 'system').slice(-2).map(textOf).join(' ');
    }
    if (!source.trim()) return;
    // 同一份消息被跑第二次（重试/重放）时不重复贴：命中文本或最后一条里已经有标记就跳过
    if (source.includes(NUDGE_MARK) || textOf(last).includes(NUDGE_MARK)) return;
    const nudge = ledgerNudge(source);
    if (!nudge) return;

    const s = cfg() || {};
    const store = loadStore();
    const prev = store.nudgeState || {};
    const gate = nudgeGate(prev, { chatKey: String(chatKey || '') }, {
      cooldownMinutes: s.nudgeCooldownMinutes,
      dailyCap: s.nudgeDailyCap
    });
    // 只在"真的要贴"或"跨天重置"时落盘，省掉没意义的写
    if (gate.fire || String(prev.day || '') !== gate.state.day) {
      store.nudgeState = gate.state;
      saveStore(store);
    }
    if (!gate.fire) return;

    if (typeof last.content === 'string') last.content = last.content + '\n\n' + nudge;
    else if (Array.isArray(last.content)) last.content.push({ type: 'text', text: nudge });
  } catch (error) {
    try { log('账本提醒失败（已忽略）：' + (error?.message ?? error)); } catch { /* ignore */ }
  }
}

// loader 只认 `mod.hooks` ——裸导出函数永远不会被调用。
export const hooks = { 'before-llm-messages': beforeLlmMessages };

export const internals2 = { ledgerNudge, nudgeGate, NUDGE_RE, NUDGE_DEFAULTS, NUDGE_MARK };
