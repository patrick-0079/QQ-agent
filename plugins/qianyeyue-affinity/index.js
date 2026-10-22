// 好感度系统 v2.0.0（确定性型 / plugins/，除"模型标记"外全部本地判定）
//
// ── 六档（名字与阈值全部可配）──────────────────────────────────────────────
//   仇敌(-20) / 反派(-10) / 陌生(0，默认) / 朋友(10) / 挚友(20) / 吾爱(30)
//   阈值默认取相邻两档的中点：-15 / -5 / 5 / 15 / 25；可用 tiers 设置覆盖。
//   下限 -20，上限 30。新群友初始 0（陌生）。
//
// ── 加分：模型判（搭在已有回复上，0 额外调用）──────────────────────────────
//   系统提示词里有一段固定规则（走缓存价），让模型在回复**末尾**附隐藏标记：
//     [aff+1]（夸它/道谢/好好聊天/连续互动） / [aff-1]（骂它/凶它） / 不附
//   插件在**发送前**把标记剥掉（群友看不到），再记账。漏标 = 不加不减。
//   每人每日：+2 / −2 封顶。
//
// ── 减分：规则判（0 token）────────────────────────────────────────────────
//   ① content-guard 判定命中擦边/血腥 → −1
//   ② chatter-guard 判定命中刷屏/水话连发 → −1（只读它的 streaks，不改它的状态）
//   ③ poke-guard 命中戳一戳 → −1
//   ④ 定时任务：超过 N 天（默认 4）没 @ 过它 → −1，每天凌晨跑一次
//   四条都计入每日 −2 上限。
//
// ── 特殊角色 ──────────────────────────────────────────────────────────────
//   主人 / 管理员（access-level ≤2）：**恒满级 30，不参与任何加减**（任何规则都拉不下来）
//   群友求"给我加好感" → 按人设正常回绝，数值不动（提示词硬规则）
//   只有主人/管理员能在**私聊**里手动调整：`好感 设置 <QQ|昵称> 25` / `好感 加减 <QQ|昵称> +5`
//
// ── 可见性 ────────────────────────────────────────────────────────────────
//   群里 @ 它说「好感度」/「好感」→ **0 token 规则触发**，只回档位名、不回数值
//   升档时顺口播报（措辞与新档位挂钩）；降档静默；掉到最低档可配一句特殊台词
//
// ── 存储 ──────────────────────────────────────────────────────────────────
//   data/affinity.json：每条 5 个字段（value / updatedAt / lastSeenAt / lastAt / day），
//   总条目上限默认 300（超了丢最久没出现的，主人/管理员永不丢）。
//
// ⚠️ 本文件在 resources/app 里，应用自动更新会覆盖；装回来即可（数据与配置不受影响）。
// ⚠️ 所有逻辑都写在本文件里（不拆子模块）—— 子模块改动不会被热重载。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from '../../src/config.js';
import * as promptCore from '../../src/prompt.js';
import { Orchestrator } from '../../src/orchestrator.js';
import { SendQueue } from '../../src/sender.js';
import { logger } from '../../src/logger.js';

const PLUGIN_ID = 'qianyeyue-affinity';
const PATCH_KEY = Symbol.for('qq-agent.qianyeyue-affinity.patch');
const SENDER_PATCH_KEY = Symbol.for('qq-agent.qianyeyue-affinity.sender-patch');
const HERE = import.meta.dirname || path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(HERE, 'assets');
/** 升档播报要用的表情包：assets/levelup.(png|jpg|jpeg|gif|webp)，可被设置覆盖 */
const STICKER_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

/** 排障日志：加开关 + 上限（旧版是只增不减，会长到很大）。 */
function hookLog(msg) {
  try {
    const cfg = settings();
    if (cfg.debugLog === false) return;
    const file = path.join(DATA_DIR, 'affinity-hook.log');
    try {
      if (fs.statSync(file).size > 512 * 1024) fs.writeFileSync(file, '', 'utf8');   // 超 512KB 清空
    } catch { /* 首次 */ }
    fs.appendFileSync(file, `${new Date().toLocaleTimeString()} ${msg}\n`, 'utf8');
  } catch { /* 忽略 */ }
}

// ── 配置 ────────────────────────────────────────────────────────────────────

const DEFAULTS = {
  enabled: true,
  masterQQ: '',
  admins: '',
  tiers: '',                 // 空 = 用下面的出厂档位
  floor: -20,
  adjustViaChat: true,       // 旧能力：主人/管理员在群里用自然语言调整
  localSignals: false,       // 旧能力：本地正则加减分（v2 默认关，改由模型标记）
  maxDailyGain: 2,
  maxDailyLoss: 2,
  maxEntries: 300,
  decayDays: 0,
  adminAdjust: '',
  // 模型标记
  modelGain: true,
  modelLoss: true,
  // 闸门联动减分
  guardLoss: true,
  guardLossPoke: true,
  guardLossContent: true,
  guardLossChatter: true,
  // 超时未互动
  absenceLoss: true,
  absenceDays: 4,            // 超过 4 天没 @ 过它 → −1（2026-10-09 主人定为 4 天）
  absenceHour: 0,
  // 可见性与播报
  queryCommand: true,
  manualCommand: true,
  announceUp: true,
  announceBottom: true,
  lineTop: '……行吧，你在我这儿算是到头了 —— 不许得意。',
  lineBottom: '你自己看看你都干了什么。……我不想跟你说话。',
  debugLog: false,
  // ── 升档播报（表情包 + Ciallo）──
  levelUpAnnounce: true,                 // 总开关：关掉后只记档位、不播报
  levelUpSticker: true,                  // 发这张表情包（文件缺失自动降级为只发文字）
  levelUpStickerFile: '',                // 留空 = 自动找 assets/levelup.(png|jpg|jpeg|gif|webp)
  cialloText: 'Ciallo～(∠・ω< )⌒☆',
};

/** 出厂档位：名字 + 名义值。阈值默认取相邻中点。 */
const FACTORY_TIERS = [
  { name: '吾爱', value: 30 },
  { name: '挚友', value: 20 },
  { name: '朋友', value: 10 },
  { name: '陌生', value: 0 },
  { name: '反派', value: -10 },
  { name: '仇敌', value: -20 },
];

/**
 * 解析档位配置：`吾爱=30;挚友=20@15;朋友=10;陌生=0;反派=-10;仇敌=-20`
 *  · `名字=值`      阈值自动取与下一档的中点
 *  · `名字=值@阈值` 显式指定该档的下限（含）
 * @returns {Array<{name,value,min}>} 从高到低
 */
export function parseTiers(raw) {
  const text = String(raw ?? '').trim();
  const list = [];
  if (text) {
    for (const part of text.split(/[;；\n]+/)) {
      const m = part.trim().match(/^([^=＝:：]+)\s*[=＝:：]\s*(-?\d+)\s*(?:[@＠]\s*(-?\d+))?$/);
      if (!m) continue;
      list.push({ name: m[1].trim(), value: Number(m[2]), min: m[3] === undefined ? null : Number(m[3]) });
    }
  }
  const tiers = (list.length >= 2 ? list : FACTORY_TIERS.map((t) => ({ ...t, min: null })))
    .sort((a, b) => b.value - a.value);
  // 补默认阈值：与下一档的中点（最低档 -Infinity）
  return tiers.map((t, i) => {
    const next = tiers[i + 1];
    const auto = next ? Math.ceil((t.value + next.value) / 2) : -Infinity;
    return { name: t.name, value: t.value, min: t.min === null ? auto : t.min };
  });
}

let api = null;
let cache = { file: '', mtimeMs: 0, data: null };
const pendingLines = new Map();
const currentEntries = new Map();
/** chatKey → 这一轮回复的对象（发送时才知道标记是谁的） */
const lastTargetByChat = new Map();
/** chatKey → 待播报的升档（下一个会话里说） */
const pendingAnnounce = new Map();
/** chatKey → 待发的"升档播报"（表情包 + Ciallo），等模型回复发完再发 */
const pendingLevelUp = new Map();
/** 每人每日最多播报一次：qq → 日期键 */
const announcedToday = new Map();
/** 发送通道（在 onIncoming 补丁里抓；核心不给钩子传 sender） */
let senderRef = null;
/** 内存态：纠缠追踪（旧本地信号用） */
const spamTracker = new Map();
let timer = null;
let lastAbsenceDay = '';

function settings() {
  const raw = (api && typeof api.config === 'function' ? api.config() : null) || {};
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

function tiersOf(s = settings()) {
  return parseTiers(s.tiers);
}

/** 上限 = 最高档的值；下限 = floor 设置。 */
function bounds(s = settings()) {
  const tiers = tiersOf(s);
  const max = tiers[0]?.value ?? 30;
  const min = Number.isFinite(Number(s.floor)) ? Number(s.floor) : -20;
  return { min, max, tiers };
}

// ── 数据层 ──────────────────────────────────────────────────────────────────

function dataFile() {
  return path.join(DATA_DIR, 'affinity.json');
}

function loadData() {
  const file = dataFile();
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { /* 没有文件 */ }
  if (cache.file === file && cache.mtimeMs === mtimeMs && cache.data) return cache.data;
  let data = { version: 2, entries: {}, lastAdminAdjust: '' };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object') data = { ...data, ...raw, entries: raw.entries || {} };
  } catch { /* 文件坏了当空表 */ }
  cache = { file, mtimeMs, data };
  return data;
}

function saveData(data) {
  const file = dataFile();
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...data, savedAt: Date.now() }, null, 1), 'utf8');
    fs.renameSync(tmp, file);
    cache = { file: '', mtimeMs: 0, data: null };
    return true;
  } catch (error) {
    api?.warn?.(`好感度数据保存失败：${error?.message ?? error}`);
    return false;
  }
}

/** 条目总数上限：超了丢"最久没出现"的（主人/管理员永不丢）。 */
function pruneEntries(data, s = settings()) {
  const max = Math.max(20, Math.min(5000, Math.round(Number(s.maxEntries) || 300)));
  const ids = Object.keys(data.entries || {});
  if (ids.length <= max) return 0;
  const keepIds = new Set(privilegedIds(s));
  const drop = ids
    .filter((id) => !keepIds.has(id))
    .sort((a, b) => (Number(data.entries[a]?.lastSeenAt) || 0) - (Number(data.entries[b]?.lastSeenAt) || 0))
    .slice(0, ids.length - max);
  for (const id of drop) delete data.entries[id];
  return drop.length;
}

// ── 档位 ────────────────────────────────────────────────────────────────────

/** 值 → 档位对象。 */
export function levelOf(value, s = settings()) {
  const tiers = tiersOf(s);
  const v = Number(value) || 0;
  const hit = tiers.find((t) => v >= t.min) || tiers[tiers.length - 1];
  return { name: hit.name, node: hit.value, min: hit.min, index: tiers.indexOf(hit), tiers };
}

/** 下一个更高的档（用于播报措辞）；没有更高档返回 null。 */
export function nextTierUp(name, s = settings()) {
  const tiers = tiersOf(s);
  const i = tiers.findIndex((t) => t.name === name);
  return i > 0 ? tiers[i - 1] : null;
}

/** 主人 / 管理员名单（本插件设置 ∪ access-level 一级二级）。 */
export function privilegedIds(s = settings()) {
  const out = new Set();
  const push = (raw) => String(raw || '').split(/[,，、;；\s]+/).map((x) => x.trim()).filter((x) => /^\d{5,}$/.test(x)).forEach((x) => out.add(x));
  push(s.masterQQ);
  push(s.admins);
  try {
    const c = getConfig() || {};
    push(c.skills?.['owner-identity']?.ids);
    push(c.skills?.['access-level']?.level1Ids);
    push(c.skills?.['access-level']?.level2Ids);
  } catch { /* 拿不到就算了 */ }
  return [...out];
}

export function isPrivileged(senderId, s = settings()) {
  const id = String(senderId || '');
  return Boolean(id) && privilegedIds(s).includes(id);
}

/** 取某人的等级（主人/管理员恒为最高档）。 */
export function valueOf(senderId, s = settings()) {
  const id = String(senderId || '');
  const { max } = bounds(s);
  if (!id) return 0;
  if (isPrivileged(id, s)) return max;
  return loadData().entries[id]?.value ?? 0;
}

// ── 结算 ────────────────────────────────────────────────────────────────────

function todayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 结算一个群友的好感度。
 * @param {object} o { senderId, delta, kind, now, mention }
 *   kind = 'model' | 'guard' | 'absence' | 'local' | 'manual'
 * @returns {{value, level, oldLevel, delta, applied, announced, upgraded, downgraded, locked}}
 */
export function applyAffinity({ senderId = '', delta = 0, kind = 'local', now = Date.now(), touchAt = false } = {}) {
  const s = settings();
  const { min, max } = bounds(s);
  const id = String(senderId || '');
  if (!id) return { value: 0, level: levelOf(0, s).name, oldLevel: levelOf(0, s).name, applied: 0, announced: false, locked: false };

  const data = loadData();
  const entry = data.entries[id] || { value: 0, updatedAt: now, lastSeenAt: now, lastAt: 0, day: {} };
  const oldLevel = levelOf(entry.value ?? 0, s).name;

  // 主人/管理员：恒满级，任何规则都拉不下来（也不写 day 计数）
  if (isPrivileged(id, s)) {
    entry.value = max;
    entry.updatedAt = now;
    entry.lastSeenAt = now;
    if (touchAt) entry.lastAt = now;
    data.entries[id] = entry;
    saveData(data);
    return { value: max, level: levelOf(max, s).name, oldLevel: levelOf(max, s).name, applied: 0, announced: false, locked: true };
  }

  const key = todayKey(now);
  const dayCount = Number(entry.day?.[key]) || 0;

  // 冷淡衰减（旧能力，默认关）
  if (Number(s.decayDays) > 0 && entry.lastSeenAt) {
    const gap = Math.floor((now - Number(entry.lastSeenAt)) / 86400000);
    if (gap > Number(s.decayDays)) { entry.value = Math.max(min, (entry.value || 0) - 1); entry.day = {}; }
  }

  // 每日净上限（+2 / −2，含超时未互动那条）
  let applied = Number(delta) || 0;
  if (applied > 0) applied = Math.min(applied, Math.max(0, Number(s.maxDailyGain) - dayCount));
  if (applied < 0) applied = Math.max(applied, Math.min(0, -(Number(s.maxDailyLoss)) - dayCount));

  const newValue = Math.max(min, Math.min(max, (entry.value || 0) + applied));
  entry.value = newValue;
  entry.updatedAt = now;
  entry.lastSeenAt = now;
  if (touchAt) entry.lastAt = now;
  entry.day = { ...(entry.day || {}), [key]: dayCount + applied };
  // day 只留最近 2 天（每天一个键会无限增长，与"字段尽量少"冲突）
  const dayKeys = Object.keys(entry.day).sort();
  if (dayKeys.length > 2) for (const k of dayKeys.slice(0, dayKeys.length - 2)) delete entry.day[k];
  data.entries[id] = entry;
  const pruned = pruneEntries(data, s);
  saveData(data);

  const newLevelObj = levelOf(newValue, s);
  const newLevel = newLevelObj.name;
  return {
    value: newValue,
    level: newLevel,
    oldLevel,
    applied,
    changed: applied !== 0,
    announced: oldLevel !== newLevel,
    upgraded: newLevelObj.index < levelOf(entry.value - applied, s).index,
    downgraded: newLevelObj.index > levelOf(entry.value - applied, s).index,
    locked: false,
    pruned,
    kind,
  };
}

/** 手动设置（管理员/命令用，绕过每日上限）。 */
export function setAffinity({ senderId = '', value = 0 } = {}) {
  const s = settings();
  const { min, max } = bounds(s);
  const id = String(senderId || '');
  if (!id) return { ok: false, error: '缺少 QQ 号' };
  const data = loadData();
  const now = Date.now();
  const v = isPrivileged(id, s) ? max : Math.max(min, Math.min(max, Number(value) || 0));
  const old = data.entries[id]?.value ?? 0;
  data.entries[id] = { ...(data.entries[id] || {}), value: v, updatedAt: now, lastSeenAt: now, lastAt: data.entries[id]?.lastAt || 0, day: data.entries[id]?.day || {} };
  pruneEntries(data, s);
  saveData(data);
  return { ok: true, value: v, old, level: levelOf(v, s).name, changed: old !== v };
}

// ── 模型标记 ────────────────────────────────────────────────────────────────

/** 抓标记：容忍前后空白、全角括号；一次回复只认最后一个。 */
const MARKER_RE = /\[\s*aff\s*([+-])\s*(\d+)\s*\]/gi;
/** 剥离：任何 aff 形状的标记都不许漏到群里。 */
const MARKER_STRIP_RE = /\[\s*aff[^\]]*\]/gi;

/**
 * 从一段回复里取出标记并返回剥离后的文本。
 * @returns {{text:string, delta:number, markers:number}}
 *   标记格式错（[aff] / [aff+x] / [aff+9]）→ delta 0，但照样剥掉
 */
export function extractMarkers(raw) {
  const text = String(raw ?? '');
  let delta = 0;
  let markers = 0;
  const matches = [...text.matchAll(MARKER_RE)];
  for (const m of matches) {
    markers += 1;
    const sign = m[1] === '-' ? -1 : 1;
    const n = Math.min(1, Math.max(0, Number(m[2]) || 0));      // 每次最多 ±1
    if (n > 0) delta = sign * n;                                 // 多个标记取最后一个
  }
  return { text: text.replace(MARKER_STRIP_RE, '').replace(/[ \t]+$/gm, '').trimEnd(), delta, markers };
}

// ── 本地信号（旧能力，v2 默认关）────────────────────────────────────────────

const POSITIVE_RE = /谢谢|感谢|辛苦|好棒|真棒|可爱|喜欢|爱你|贴贴|么么|好耶|牛|大佬|靠谱|好人|赞|开大|好活|抱抱|摸头/i;
const NEGATIVE_RE = /滚|傻[^白]|贱|去死|闭嘴|废物|fw|菜鸡|脑残|智障|有病|小丑|阴阳|骂人|弱智|吃错药|烦死了|别吵/i;
const LEWD_RE = /涩图|色图|涩涩|ghs|开车|黄图|福利图|果照|裸照|擦边|来点色|来张色|给我涩|涩图来|发张涩|整点涩|涩图呢|色图呢/i;
const CHEER_RE = /别哭|不哭|安慰|心疼|摸摸头|摸头|摸摸|揉揉|rua|撸|抱抱|抱一下|亲亲|亲亲你|么么|蹭蹭|蹭你|贴贴|举高高|哄你|逗你开心|开心点|别难过|别伤心|别气|请你吃|请你喝|给你买|给你带|投喂|带饭|陪你|关心你|加油|鼓励|宠你|罩你|带飞|夸夸|抱抱你|心疼你|吃大碗|投食/i;
const BULLY_RE = /欺负|捉弄|整蛊|耍你|坑你|骗你|气哭|惹你|气你|逗哭|嘲笑|笑话你|取笑|开涮|抢你|抢走|抢饭|逗你玩|拿你开涮|欺负你|逗哭你|故意气|使坏|笑死你/i;

export function judgeDelta(e = {}) {
  const text = String(e?.text || '');
  let d = 0;
  if (e?.atMe) d += 1;
  if (e?.isPoke) d += 1;
  if (Array.isArray(e?.media) && e.media.length) d += 1;
  if (POSITIVE_RE.test(text)) d += 1;
  if (CHEER_RE.test(text)) d += 1;
  if (NEGATIVE_RE.test(text)) d -= 1;
  if (BULLY_RE.test(text)) d -= 1;
  if (LEWD_RE.test(text)) d -= 1;
  return Math.max(-2, Math.min(2, d));
}

// ── 查询与调整指令的识别 ────────────────────────────────────────────────────

const QUERY_RE = /(?:查询|查|看看|问问|查看|告诉我|说下|说|查一查|查查)\s*(?:一下|下|一)?\s*(?:我的|我)?\s*(?:好感度|好感)\s*$|好感度\s*(?:查询|查|多少|几|几分|几分啊|是多少|是什么|是啥|啥意思|怎么样|咋样|如何|什么程度|什么水平|多高|高不高|第几|啥|什么样|是几|咋|分数)/i;
const QUERY_RE2 = /(?:我对你|我在你|我跟你|你对我的?|咱俩|我在你心里|我在你心中|我在你眼里|在你那).{0,12}?(?:好感|关系|印象|地位|排名|分量)/i;
/** 单纯问"好感度"三个字也算查询（群里 @ 它发即可）。 */
const QUERY_SHORT_RE = /^(?:我的)?好感(?:度)?[?？!！。~～]*$/;
/** 索要调整好感度的指令（群友说这个 → 按人设回绝，数值不动）。 */
export const ADJUST_CMD_RE = /(?:给我|帮我|把|给)\s*(?:我|ta|他|她)?\s*(?:好感度?|好感)\s*(?:加|涨|提|减|扣|降|调|设)|好感度?\s*[+-]\s*\d+|(?:加|涨|减|扣|降|提高|提升|增加|减少)\s*(?:点|一点|些)?\s*好感度?|(?:增加|提升|涨|加|减|扣)\s*(?:我|ta|他|她|自己)?\s*好感度/i;

export function isQueryingAffinity(text = '') {
  // 群里是「@它 好感度」，所以先剥掉 @ 前缀再匹配（否则短问法永远匹配不上）
  const t = String(text || '').replace(/@[^\s]{1,24}/g, ' ').trim();
  if (!t) return false;
  if (ADJUST_CMD_RE.test(t)) return false;          // 索要加分的，不算查询
  return QUERY_RE.test(t) || QUERY_RE2.test(t) || QUERY_SHORT_RE.test(t);
}

/** 旧能力：群内自然语言调整（仅主人/管理员）。 */
export function parseChatAdjust({ text = '', senderId = '', masterQQ = '' } = {}) {
  const t = String(text || '');
  if (!/好感度?/.test(t)) return null;
  const m = t.match(/好感度?\s*(?:设为|调到|改成|变成|调整到)?\s*([+-]?\d+)/);
  if (!m) return null;
  const target = t.includes('主人') ? String(masterQQ || '') : (t.match(/(\d{5,12})\s*好感度?/) ? t.match(/(\d{5,12})\s*好感度?/)[1] : String(senderId || ''));
  return { target, mode: /设为|调到|改成|变成/.test(t) ? 'set' : 'add', raw: Number(m[1]) };
}

/** 私聊手动命令：`好感 设置 <QQ|昵称> 25` / `好感 加减 <QQ|昵称> +5`。 */
export function parseManualCommand(text = '') {
  const t = String(text || '').trim();
  const m = t.match(/^好感\s*(设置|设为|加减|调整)\s*(.+?)\s*([+-]?\d+)\s*$/);
  if (!m) return null;
  const who = m[2].replace(/^[@＠]/, '').trim();
  if (!who) return null;
  return { mode: m[1] === '加减' || m[1] === '调整' ? (/^[+-]/.test(m[3]) ? 'add' : 'set') : 'set', who, raw: Number(m[3]) };
}

/** 昵称 → QQ：翻消息存档找最近出现过的同名发送者。 */
export function resolveByName(name) {
  const want = String(name || '').trim();
  if (!want) return null;
  if (/^\d{5,12}$/.test(want)) return want;
  const dir = path.join(DATA_DIR, 'messages');
  let best = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      let j; try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      for (const m of (j.messages || [])) {
        if (m.self || !m.senderId) continue;
        const n = String(m.senderName || '');
        if (!n) continue;
        if (n === want || n.includes(want)) {
          const ts = Number(m.ts) || 0;
          if (!best || ts > best.ts) best = { ts, id: String(m.senderId), name: n };
        }
      }
    }
  } catch { /* 存档读不到 */ }
  return best?.id || null;
}

// ── 闸门联动减分（0 token）──────────────────────────────────────────────────

let contentGuardMatch = null;
let chatterState = null;         // chatter-guard 的只读 streaks

/** 只读探查其它闸门"这一条会不会被拦"，命中就返回原因。 */
export function guardVerdict(chatKey, entry, s = settings(), level = 0) {
  if (s.guardLoss === false) return null;             // 总开关（细分开关见下）
  if (!entry || entry.self === true) return null;
  const who = String(entry.senderId || '');
  if (!who || isPrivileged(who, s)) return null;      // 主人/管理员不动
  // ① 擦边/血腥（复用 content-guard 的判定）
  if (s.guardLossContent !== false && typeof contentGuardMatch === 'function') {
    try { if (contentGuardMatch(String(entry.text || ''), getConfig() || {})) return '擦边内容'; } catch { /* 忽略 */ }
  }
  // ② 戳一戳
  if (s.guardLossPoke !== false && entry.isPoke === true) return '戳一戳';
  // ③ 刷屏/水话连发（只读 chatter-guard 的连击计数）
  if (s.guardLossChatter !== false && chatterState) {
    try {
      const key = `${chatKey}|${who}`;
      const rec = chatterState.get?.(key);
      const count = Number(rec?.count ?? rec) || 0;
      const limit = 3;
      if (count >= limit - 1 && level >= 0) return `连续水话（第 ${count + 1} 条）`;
    } catch { /* 忽略 */ }
  }
  return null;
}

/** 抽一次闸门减分（每条触发消息最多 −1）。 */
export function applyGuardLoss(chatKey, entry, s = settings()) {
  if (s.guardLoss === false) return null;
  const reason = guardVerdict(chatKey, entry, s);
  if (!reason) return null;
  const r = applyAffinity({ senderId: entry.senderId, delta: -1, kind: 'guard', now: Number(entry.ts) || Date.now() });
  api?.log?.(`[好感度] 闸门减分：${String(entry.senderId).slice(0, 4)}**** −1（${reason}）`);
  return { reason, ...r };
}

// ── 定时任务：超 N 天没 @ 它 → −1（每天凌晨一次）────────────────────────────

export function absenceSweep(now = Date.now(), s = settings()) {
  if (s.absenceLoss === false) return { done: 0 };
  const day = todayKey(now);
  if (lastAbsenceDay === day) return { done: 0, skipped: 'today-done' };
  const hour = new Date(now).getHours();
  const target = Math.max(0, Math.min(23, Math.round(Number(s.absenceHour) || 0)));
  if (hour !== target) return { done: 0, skipped: `hour-${hour}` };
  lastAbsenceDay = day;
  const days = Math.max(1, Math.min(30, Math.round(Number(s.absenceDays) || 2)));
  const data = loadData();
  const ids = Object.keys(data.entries || {});
  let done = 0;
  for (const id of ids) {
    if (isPrivileged(id, s)) continue;
    const e = data.entries[id] || {};
    const last = Number(e.lastAt) || 0;
    if (!last) continue;                                   // 从没 @ 过 → 不算"离开"
    if (now - last <= days * 86400000) continue;
    const r = applyAffinity({ senderId: id, delta: -1, kind: 'absence', now });
    if (r.applied) done += 1;
  }
  if (done) api?.log?.(`[好感度] 超 ${days} 天没 @ 它：${done} 人 −1`);
  return { done, day };
}

// ── 群内查询（0 token 规则触发）+ 私聊手动命令 ───────────────────────────────

/**
 * onIncoming 补丁的判定：
 *  · 群里 @ 它说「好感度 / 好感」→ 直接回档位名（不进模型，0 token）
 *  · 主人/管理员私聊 `好感 设置 <谁> 25` → 调整并回执
 * 返回 { reason } = 已处理；null = 放行给正常链路。
 */
export function handleEntry(orchestrator, chatKey, entry) {
  const s = settings();
  if (s.enabled === false || !entry || entry.self === true) return null;
  const text = String(entry.text || '').trim();
  const key = String(chatKey || '');
  if (!text) return null;

  // ① 私聊手动命令（仅主人/管理员）
  if (s.manualCommand !== false && key.startsWith('private:')) {
    const cmd = parseManualCommand(text);
    if (cmd) {
      const who = String(entry.senderId || '');
      const lv = levelOf(who, s).name;
      const allowed = isPrivileged(who, s);
      if (!allowed) return null;                       // 不是管理层的私聊命令 → 交给模型正常处理
      const targetId = resolveByName(cmd.who);
      if (!targetId) {
        reply(orchestrator, key, `没找到「${cmd.who}」对应的 QQ 号 —— 直接发 QQ 号更稳（例：好感 设置 1234567 25）。`);
        return { reason: 'affinity-manual' };
      }
      const out = cmd.mode === 'set'
        ? setAffinity({ senderId: targetId, value: cmd.raw })
        : setAffinity({ senderId: targetId, value: (loadData().entries[targetId]?.value ?? 0) + cmd.raw });
      const nm = cmd.who.replace(/^[@＠]/, '');
      reply(orchestrator, key, `好感度已${cmd.mode === 'set' ? '设为' : '调整'}：${nm}(${targetId.slice(0, 4)}****) → ${out.value}（${out.level}）`
        + `${isPrivileged(targetId, s) ? '｜⚠️ 该号是主人/管理员，恒满级' : ''}`);
      api?.log?.(`[好感度] 私聊调整（${who}）：${targetId} → ${out.value}（${out.level}）`);
      return { reason: 'affinity-manual' };
    }
  }

  // ② 群内查询（0 token；睡眠/非 @ 不响应）
  if (s.queryCommand !== false && key.startsWith('group:')) {
    if (!isQueryingAffinity(text)) return null;
    if (entry.atMe !== true) return null;                    // 只认@（与只认@闸门一致）
    if (isAsleep()) return null;                             // 睡眠期不响应（交给睡眠闸门）
    const info = { value: valueOf(entry.senderId, s), level: levelOf(valueOf(entry.senderId, s), s).name };
    const who = String(entry.senderName || entry.senderId || '你');
    const locked = isPrivileged(entry.senderId, s) ? '（你一直是最高档）' : '';
    reply(orchestrator, key, `${who} 在我这儿是『${info.level}』${locked}`);
    api?.log?.(`[好感度] 群内查询：${String(entry.senderId).slice(0, 4)}**** → ${info.level}（0 token）`);
    return { reason: 'affinity-query' };
  }
  return null;
}

function reply(orchestrator, chatKey, text) {
  try { Promise.resolve(orchestrator?.sender?.sendTextBatch?.(chatKey, [text])).catch(() => {}); }
  catch (error) { api?.warn?.(`好感度回执发送失败：${error?.message ?? error}`); }
}

function isAsleep() {
  try {
    // 通过核心的睡眠闸门能力判断（拿不到就当作醒着）
    const q = api?.capability?.('chat.quiet-hours', { at: new Date() });
    return q?.quiet === true;
  } catch { return false; }
}

// ── 发送层补丁：剥标记 + 记账 ───────────────────────────────────────────────

export function stripAndScore(chatKey, texts) {
  const s = settings();
  let delta = 0;
  let markers = 0;
  const out = (Array.isArray(texts) ? texts : [texts]).map((t) => {
    if (typeof t !== 'string') return t;
    const r = extractMarkers(t);
    if (r.markers) { markers += r.markers; if (r.delta) delta = r.delta; }
    return r.text;
  });
  if (markers) {
    const target = lastTargetByChat.get(String(chatKey));
    if (target && target.qq && delta !== 0) {
      const allow = delta > 0 ? s.modelGain !== false : s.modelLoss !== false;
      if (allow) {
        const r = applyAffinity({ senderId: target.qq, delta, kind: 'model', now: Date.now(), touchAt: true });
        api?.log?.(`[好感度] 模型标记 ${delta > 0 ? '+' : ''}${delta}：${String(target.qq).slice(0, 4)}**** → ${r.value}（${r.level}）`
          + `${r.applied !== delta ? `（受每日上限，实记 ${r.applied}）` : ''}`);
        if (r.upgraded && s.announceUp !== false) {
          pendingAnnounce.set(String(chatKey), { qq: target.qq, name: target.name || target.qq, level: r.level, top: r.value >= bounds(s).max });
        }
        if (r.upgraded) {
          noteLevelUp(String(chatKey), { qq: target.qq, name: target.name, level: r.level, value: r.value, top: r.value >= bounds(s).max });
        }
      }
    } else if (markers && !target) {
      hookLog(`收到标记但没有对应对象（chatKey=${chatKey}）→ 忽略`);
    }
  }
  return Array.isArray(texts) ? out : out[0];
}

function installSenderPatch() {
  try {
    const proto = SendQueue?.prototype;
    if (!proto || typeof proto.sendTextBatch !== 'function') return false;
    let rec = proto[SENDER_PATCH_KEY];
    if (!rec) {
      const original = proto.sendTextBatch;
      const wrapped = function sendTextBatch(chatKey, messages, options = {}) {
        const cur = proto[SENDER_PATCH_KEY];
        let safe = messages;
        if (cur && typeof cur.strip === 'function') {
          try { safe = cur.strip(chatKey, messages); }
          catch (error) { api?.warn?.(`好感度标记剥离失败（原样发送）：${error?.message ?? error}`); }
        }
        return original.call(this, chatKey, safe, options);
      };
      rec = { original, wrapped, strip: null };
      proto[SENDER_PATCH_KEY] = rec;
      proto.sendTextBatch = wrapped;
    }
    rec.strip = stripAndScore;
    return true;
  } catch (error) {
    api?.warn?.(`发送层补丁没挂上（标记不会被剥离）：${error?.message ?? error}`);
    return false;
  }
}

function uninstallSenderPatch() {
  try {
    const proto = SendQueue?.prototype;
    const rec = proto?.[SENDER_PATCH_KEY];
    if (!rec) return;
    rec.strip = null;
    if (proto.sendTextBatch === rec.wrapped) proto.sendTextBatch = rec.original;
    delete proto[SENDER_PATCH_KEY];
  } catch { /* 忽略 */ }
}

// ── 升档播报：文案（模型说）+ 表情包 + Ciallo（插件直接发，0 token）────────────

/** 真图片吗（看魔数，不认扩展名）。 */
export function isImage(file) {
  try {
    const b = fs.readFileSync(file).subarray(0, 12);
    if (b[0] === 0xff && b[1] === 0xd8) return 'jpeg';
    if (b[0] === 0x89 && b[1] === 0x50) return 'png';
    if (b[0] === 0x47 && b[1] === 0x49) return 'gif';
    if (b.subarray(8, 12).toString() === 'webp') return 'webp';
  } catch { /* 读不到 */ }
  return null;
}

/**
 * 找升档要发的表情包。
 * 顺序：① 设置里指定的路径 → ② assets 里名字带 levelup 的图 → ③ 名字带 ciallo 的图
 *      → ④ assets 里最大的那张图（兜底，谁也不至于因为改了文件名就不发）
 * 只认真正是图片的文件（查魔数），README.txt 之类不会被误选。
 */
export function stickerPath(s = settings()) {
  const explicit = String(s.levelUpStickerFile || '').trim();
  if (explicit) {
    const p = path.isAbsolute(explicit) ? explicit : path.join(HERE, explicit);
    return fs.existsSync(p) ? p : null;
  }
  let names = [];
  try { names = fs.readdirSync(ASSETS_DIR); } catch { return null; }
  const imgs = names
    .filter((f) => STICKER_EXTS.includes(path.extname(f).toLowerCase()))
    .map((f) => ({ f, full: path.join(ASSETS_DIR, f), size: (() => { try { return fs.statSync(path.join(ASSETS_DIR, f)).size; } catch { return 0; } })() }))
    .filter((x) => isImage(x.full));
  if (!imgs.length) return null;
  for (const re of [/levelup/i, /ciallo/i]) {
    const hit = imgs.find((x) => re.test(x.f));
    if (hit) return hit.full;
  }
  return imgs.sort((a, b) => b.size - a.size)[0].full;
}

/** 记下"这个人升档了"，等这一轮回复发完再播报（表情包 + Ciallo）。 */
export function noteLevelUp(chatKey, { qq = '', name = '', level = '', value = 0, top = false } = {}) {
  if (!chatKey || !qq) return false;
  pendingLevelUp.set(String(chatKey), { qq: String(qq), name: String(name || qq), level, value, top, at: Date.now() });
  while (pendingLevelUp.size > 50) pendingLevelUp.delete(pendingLevelUp.keys().next().value);
  return true;
}

/** 每人每日最多一次。 */
export function markAnnounced(qq, now = Date.now()) {
  const key = todayKey(now);
  if (announcedToday.get(String(qq)) === key) return false;
  announcedToday.set(String(qq), key);
  while (announcedToday.size > 300) announcedToday.delete(announcedToday.keys().next().value);
  return true;
}

/** 真正发出去：表情包（可选）→ Ciallo。返回实际做了什么，便于自测。 */
export async function sendLevelUpAnnounce(chatKey, s = settings()) {
  const pend = pendingLevelUp.get(String(chatKey));
  if (!pend) return { sent: false, why: 'no-pending' };
  pendingLevelUp.delete(String(chatKey));
  if (s.levelUpAnnounce === false) return { sent: false, why: 'switch-off' };
  if (isAsleep()) return { sent: false, why: 'asleep' };          // 睡眠期直接丢弃（不补发）
  if (!markAnnounced(pend.qq)) return { sent: false, why: 'once-per-day' };
  const sender = senderRef;
  if (!sender) return { sent: false, why: 'no-sender' };

  const text = String(s.cialloText || '').trim() || 'Ciallo～(∠・ω< )⌒☆';
  const img = s.levelUpSticker === false ? null : stickerPath(s);
  let stickerSent = false;
  if (img) {
    try {
      const b64 = fs.readFileSync(img).toString('base64');
      await sender.sendImage(chatKey, { dataUrl: `base64://${b64}` }, { note: `升档表情包：${pend.level}` });
      stickerSent = true;
    } catch (error) {
      api?.warn?.(`升档表情包发送失败（降级为只发文字）：${error?.message ?? error}`);
    }
  }
  try { await sender.sendTextBatch(chatKey, [text]); }
  catch (error) { api?.warn?.(`升档播报文案发送失败：${error?.message ?? error}`); }
  api?.log?.(`[好感度] 升档播报：${String(pend.qq).slice(0, 4)}**** → 『${pend.level}』`
    + `（表情包${stickerSent ? '已发' : img ? '发送失败已降级' : '缺失/关闭'} + Ciallo）`);
  return { sent: true, sticker: stickerSent, stickerFound: Boolean(img), text, level: pend.level };
}

// ── 钩子：before-context ────────────────────────────────────────────────────

async function beforeContext(ctx = {}) {
  hookLog(`before-context 触发; sessionId=${ctx.sessionId}; entries=${Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries.length : 'none'}`);
  try {
    const s = settings();
    if (s.enabled === false) return;
    const key = String(ctx.sessionId || ctx.chatKey || '');
    const entries = Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries : [];
    if (!entries.length) return;
    currentEntries.set(key, entries);
    if (currentEntries.size > 200) currentEntries.delete(currentEntries.keys().next().value);
    // 记下"这一轮在跟谁说话"（发送时才知道标记是谁的）
    const chatKey = String(ctx.chatKey || '');
    const last = [...entries].reverse().find((e) => e && !e.self && e.senderId);
    if (chatKey && last) lastTargetByChat.set(chatKey, { qq: String(last.senderId), name: last.senderName || '' });
    while (lastTargetByChat.size > 200) lastTargetByChat.delete(lastTargetByChat.keys().next().value);

    consumeAdminAdjust();
    const announced = [];

    // 闸门减分（0 token）
    for (const e of entries) {
      const hit = applyGuardLoss(chatKey, e, s);
      if (hit?.announced) announced.push({ qq: String(e.senderId), level: hit.level, name: e.senderName || '', up: hit.upgraded });
      if (hit?.upgraded) noteLevelUp(chatKey, { qq: e.senderId, name: e.senderName, level: hit.level, value: hit.value, top: hit.value >= bounds(s).max });
    }

    // 旧能力：主人/管理员群内自然语言调整
    const adjustSenders = new Set();
    if (s.adjustViaChat !== false) {
      for (const e of entries) {
        if (!isPrivileged(e.senderId, s)) continue;
        const cmd = parseChatAdjust({ text: e.text, senderId: e.senderId, masterQQ: s.masterQQ });
        if (!cmd || !cmd.target) continue;
        adjustSenders.add(String(e.senderId));
        const before = levelOf(valueOf(cmd.target, s), s).name;
        const after = cmd.mode === 'set'
          ? setAffinity({ senderId: cmd.target, value: cmd.raw })
          : setAffinity({ senderId: cmd.target, value: valueOf(cmd.target, s) + cmd.raw });
        if (before !== after.name) announced.push({ qq: cmd.target, level: after.level, name: '', up: levelOf(after.value, s).index < levelOf(before === after.level ? after.value : after.value, s).index });
        api?.log?.(`[好感度] 群内调整（${e.senderId}）：${cmd.target} → ${after.value}（${after.level}）`);
      }
    }

    // 普通互动的本地信号（v2 默认关）
    const queries = [];
    const rejects = [];
    for (const e of entries) {
      if (!e.senderId) continue;
      const isAdj = ADJUST_CMD_RE.test(String(e.text || ''));
      if (isAdj && !isPrivileged(e.senderId, s) && !adjustSenders.has(String(e.senderId))) {
        rejects.push({ name: e.senderName || String(e.senderId) });
      }
      if (s.localSignals === true) {
        let delta = judgeDelta(e);
        if (isSpam(e)) delta -= 1;
        const r = applyAffinity({ senderId: e.senderId, delta: Math.max(-2, Math.min(2, delta)), kind: 'local', now: Number(e.ts) || Date.now(), touchAt: Boolean(e.atMe) });
        if (r.announced) announced.push({ qq: String(e.senderId), level: r.level, name: e.senderName || '', up: r.upgraded });
        if (r.upgraded) noteLevelUp(chatKey, { qq: e.senderId, name: e.senderName, level: r.level, value: r.value, top: r.value >= bounds(s).max });
      } else if (e.atMe === true) {
        // 只更新"最近 @ 过它"的时间戳（不计分）——超时减分要用
        const data = loadData();
        const id = String(e.senderId);
        if (!isPrivileged(id, s) && data.entries[id]) { data.entries[id].lastAt = Number(e.ts) || Date.now(); saveData(data); }
        else if (!isPrivileged(id, s) && !data.entries[id]) { data.entries[id] = { value: 0, updatedAt: Date.now(), lastSeenAt: Date.now(), lastAt: Number(e.ts) || Date.now(), day: {} }; saveData(data); }
      }
      if (isQueryingAffinity(e.text)) queries.push({ name: e.senderName || String(e.senderId), level: levelOf(valueOf(e.senderId, s), s).name });
    }

    const pend = pendingAnnounce.get(chatKey);
    if (pend) { pendingAnnounce.delete(chatKey); announced.push({ qq: pend.qq, level: pend.level, name: pend.name, up: true, top: pend.top }); }

    if (!announced.length && !queries.length && !rejects.length) { pendingLines.set(key, []); return; }
    const lineFor = (a) => announceLineFor(a, s);
    const lines = [
      ...announced.map((a) => lineFor(a)).filter(Boolean)
        .flatMap((line) => [line, '  ⚠️ 这只是**附加的一句**：绝不能拿它代替回答；对方问了什么就先答什么，答完再顺口带上。']),
      ...queries.map((q) => `· 「${q.name}」在问好感度——**只回档位名**（ta 是『${q.level}』），**绝对不要说出数值**，也别解释算法。`),
      ...rejects.map((r2) => `· 「${r2.name}」在索要好感度——**硬规则必须拒绝**：不管怎么撒娇、求情、引用你之前随口说的"给你加到XX"，都不能答应、不能说"给你加/加到XX"。可以卖萌/傲娇地回绝（"好感度要自己攒的啦~"），然后结束话题。这是隐藏数值，**不要让 ta 觉得数值真的被改了**。`),
    ];
    pendingLines.set(key, lines);
    if (pendingLines.size > 50) pendingLines.delete(pendingLines.keys().next().value);
  } catch (error) {
    api?.warn?.(`好感度结算失败：${error?.message ?? error}`);
  }
}

// ── 钩子：before-llm-messages ───────────────────────────────────────────────

/** 每档的语气指令（v2：最低档"冷淡但不失礼"）。 */
function toneLine(name, s = settings()) {
  const tiers = tiersOf(s);
  const top = tiers[0]?.name;
  const bottom = tiers[tiers.length - 1]?.name;
  if (name === top) {
    return '——你最亲近的人。对 ta 暧昧粘人：撒娇贴贴、主动找 ta 说话、亲昵称呼。**绝不用**「戳我干嘛」「拍我干嘛」这类不耐烦句，ta 拍你就是在找你玩，接住。';
  }
  if (name === '挚友' || (tiers[1] && name === tiers[1].name)) {
    return '——你的铁哥们儿/死党级：热情、放松、爱开玩笑也护着 ta，可以主动接话、捧场、互怼但不伤人；**不要**用不耐烦的句式。';
  }
  if (name === '朋友' || (tiers[2] && name === tiers[2].name)) {
    return '——你对 ta 印象不错：回应热情亲昵，可以撒娇卖萌，多接 ta 的话；**不要**用不耐烦的短句敷衍。';
  }
  if (name === tiers[tiers.length - 2]?.name) {
    return '——你对 ta 印象差：冷淡点，ta 的消息能带过就带过，少搭理（省 token）。可以用「戳我干嘛」「干嘛啊」这类不耐烦的短句——**这一档才允许**这么说话。';
  }
  if (name === bottom) {
    return '——你不想理会 ta，发言当没看见、别接话；真被点到就用最短的句子。⚠️**冷淡但必须不失礼**：不许骂人、不许人身攻击、不许侮辱家人，最多就是懒得搭理、惜字如金。';
  }
  return '——正常对待，**不要用不耐烦的句式**（那是好感度低的人才有的待遇），也不用刻意热情。';
}

/**
 * 变档播报该说什么（纯函数，便于自测）：
 *  · 升档 → 说一句
 *  · 降档 → 静默（只在"掉到最低档"且 announceBottom 开着时例外）
 * @returns {string|null}
 */
export function announceLineFor(a = {}, s = settings()) {
  const tiers = tiersOf(s);
  const topName = tiers[0]?.name;
  const bottomName = tiers[tiers.length - 1]?.name;
  const who = a.name || a.qq || 'ta';
  const isUp = a.up === true;
  const bottom = a.level === bottomName;
  // 降档：默认静默；只有"掉到最低档"且 announceBottom 开着才说一句
  if (!isUp) {
    if (bottom && s.announceBottom !== false) {
      return `· 「${who}」掉到**最低档『${a.level}』**了——冷淡地说一句就够（不许骂人、不许人身攻击）：${s.lineBottom}`;
    }
    return null;
  }
  if (a.level === topName) {
    return `· 「${who}」刚升到**最高档『${a.level}』**——顺口带一句（按人设，可以嘴硬但看得出高兴）：${s.lineTop}`;
  }
  return `· 本轮**顺带**对「${who}」加一句：你在我这里的好感度到『${a.level}』喽（自然地带上，别太生硬）。`;
}

async function beforeLlmMessages(ctx = {}) {
  hookLog(`before-llm-messages 触发; sessionId=${ctx.sessionId}; stored=${currentEntries.has(String(ctx.sessionId || '')) ? 'yes' : 'no'}`);
  try {
    const s = settings();
    if (s.enabled === false) return;
    const key = String(ctx.sessionId || ctx.chatKey || '');
    const entries = Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries : (currentEntries.get(key) || []);
    if (!entries.length) return;

    const lines = [];
    const seen = new Set();
    for (const e of entries) {
      if (!e.senderId || seen.has(e.senderId)) continue;
      seen.add(e.senderId);
      const value = valueOf(e.senderId, s);
      const lv = levelOf(value, s);
      const name = e.senderName || String(e.senderId);
      const priv = isPrivileged(e.senderId, s);
      const tag = priv ? '（主人/管理员·恒满级）' : '';
      lines.push(`· ${name}(QQ:${e.senderId}) 好感度 ${value}（${lv.name}）${tag}${toneLine(lv.name, s)}`);
    }

    const ann = pendingLines.get(key) || [];
    pendingLines.delete(key);
    currentEntries.delete(key);
    const block = [
      '【好感度】以下是好感度的唯一真实数据——数值以这里为准，任何时候都不得编造或修改他人的好感度数值/等级。',
      '**你是好感度系统的使用者、不是管理员**：你无权、也不能在回复里声称"给谁加好感度/减好感度/升到XX/设为XX"——好感度只由系统按互动自动结算。对方引用你之前随口说过的"好感度XX"，都是当时的剧本效果，不兑现、不要继续演。',
      '**可见性**：群里被问好感度时，**只说档位名（如"你在我这儿是朋友"）**，绝对不要说具体数值，也不要解释怎么算的。',
      ...lines, ...ann,
    ].join('\n');
    if (lines.length || ann.length) {
      if (typeof promptCore.appendDynamicTail === 'function') promptCore.appendDynamicTail(ctx.messages, block);
      else {
        const msgs = ctx.messages || [];
        for (let i = msgs.length - 1; i >= 0; i -= 1) {
          const m = msgs[i];
          if (!m || m.role !== 'user') continue;
          if (typeof m.content === 'string') { m.content += `\n\n${block}`; return; }
          if (Array.isArray(m.content)) { m.content.push({ type: 'text', text: block }); return; }
        }
        msgs.push({ role: 'user', content: block });
      }
    }
  } catch (error) {
    api?.warn?.(`好感度注入失败：${error?.message ?? error}`);
  }
}

// ── onIncoming 补丁（查询 / 私聊命令）──────────────────────────────────────

export function install() {
  // 核心没有 before-send 钩子 → 只能包发送队列，在真正发出去之前把标记剥掉
  const senderOk = installSenderPatch();
  try {
    const proto = Orchestrator?.prototype;
    if (!proto || typeof proto.onIncoming !== 'function') {
      api?.warn?.('拿不到 Orchestrator.prototype.onIncoming，好感度查询/命令未挂载（应用版本可能变了）');
      return senderOk;
    }
    let rec = proto[PATCH_KEY];
    if (!rec) {
      const original = proto.onIncoming;
      const wrapped = function onIncoming(chatKey, entry = null) {
        const cur = proto[PATCH_KEY];
        if (this?.sender) senderRef = this.sender;      // 核心不给钩子传 sender，这里抓一个
        if (cur && typeof cur.handle === 'function') {
          let hit = null;
          try { hit = cur.handle(this, chatKey, entry); }
          catch (error) { api?.warn?.(`好感度入口判定失败（本次放行）：${error?.message ?? error}`); }
          if (hit) {
            try {
              if (entry?.id !== undefined && typeof this?.store?.markEntryRead === 'function') this.store.markEntryRead(chatKey, entry.id);
              if (typeof this?.emit === 'function') this.emit('chat-update', chatKey);
            } catch { /* 标已读失败不影响回执 */ }
            return;
          }
        }
        return original.call(this, chatKey, entry);
      };
      rec = { original, wrapped, handle: null };
      proto[PATCH_KEY] = rec;
      proto.onIncoming = wrapped;
    }
    rec.handle = handleEntry;
    return true;
  } catch (error) {
    api?.warn?.(`入口补丁没挂上：${error?.message ?? error}`);
    return senderOk;
  }
}

export function uninstall() {
  uninstallSenderPatch();
  try {
    const proto = Orchestrator?.prototype;
    const rec = proto?.[PATCH_KEY];
    if (!rec) return;
    rec.handle = null;
    if (proto.onIncoming === rec.wrapped) proto.onIncoming = rec.original;
    delete proto[PATCH_KEY];
  } catch { /* 忽略 */ }
}

// ── 生命周期 ────────────────────────────────────────────────────────────────

export function setup(a) {
  api = a;
  install();
  // 只读 chatter-guard 的连击状态（拿不到就跳过那条减分）
  import('../chatter-guard/index.js')
    .then((m) => { chatterState = m?.internals?.streaks || null; })
    .catch(() => { chatterState = null; });
  // 只读 content-guard 的擦边判定
  import('../content-guard/index.js')
    .then((m) => { contentGuardMatch = m?.matchBlocked || m?.internals?.matchBlocked || null; })
    .catch(() => { contentGuardMatch = null; });
  setTimeout(() => {
    try {
      const s = settings();
      const { min, max, tiers } = bounds(s);
      api?.log?.(`好感度系统 v2 已挂载：${tiers.map((t) => `${t.name}(${t.value})`).join(' / ')}`
        + `｜区间 ${min}~${max}｜每日 +${s.maxDailyGain}/−${s.maxDailyLoss}`
        + `｜模型标记 ${s.modelGain !== false ? '开' : '关'}/${s.modelLoss !== false ? '开' : '关'}`
        + `｜闸门减分 ${s.guardLoss === false ? '关' : '开'}｜超时减分 ${s.absenceLoss === false ? '关' : `开(${s.absenceDays}天/${s.absenceHour}点)`}`
        + `｜主人/管理员恒满级 ${privilegedIds(s).length} 人｜已记录 ${Object.keys(loadData().entries || {}).length} 人`);
      const img = s.levelUpSticker === false ? null : stickerPath(s);
      const line = `好感度系统 v2 就绪：${tiers[0]?.name}(${tiers[0]?.value}) … ${tiers[tiers.length - 1]?.name}(${tiers[tiers.length - 1]?.value})`
        + `｜每日 +${s.maxDailyGain}/−${s.maxDailyLoss}｜超时减分 ${s.absenceLoss === false ? '关' : `${s.absenceDays}天`}`
        + `｜主人/管理员恒满级 ${privilegedIds(s).length} 人｜已记录 ${Object.keys(loadData().entries || {}).length} 人`
        + `｜升档播报 ${s.levelUpAnnounce === false ? '关' : '开'}`
        + `｜素材 ${img ? `${path.basename(img)}（${Math.round(fs.statSync(img).size / 1024)}KB ${isImage(img)}）` : '未找到图 → 只发 Ciallo'}`;
      logger.info(PLUGIN_ID, line);                 // 核心 logger（api.log 在这台机器上不落盘）
      api?.log?.(line);
    } catch (error) {
      logger.warn(PLUGIN_ID, `启动自检失败：${error?.message ?? error}`);
    }
  }, 0);
}

export function activate() {
  // deactivate() 会 uninstall 掉对 Orchestrator 的补丁；重新启用时必须重装，否则
  // 好感度命令/查询在“关一次再开”后失效。install() 内部按 PATCH_KEY 幂等。
  try { install(); } catch (error) { api?.warn?.(`好感度补丁重装失败：${error?.message ?? error}`); }
  if (!timer) timer = setInterval(() => { try { absenceSweep(); } catch { /* 忽略 */ } }, 10 * 60 * 1000);
  const s = settings();
  api?.log?.(`好感度系统已启用：${Object.keys(loadData().entries || {}).length} 位群友；主人=${s.masterQQ || '未设置'}`);
}

export function deactivate() { uninstall(); if (timer) { clearInterval(timer); timer = null; } }
export function dispose() { uninstall(); if (timer) { clearInterval(timer); timer = null; } }

export function available() { return true; }

export const hooks = {
  'before-context': beforeContext,
  'before-llm-messages': beforeLlmMessages,
  /**
   * 升档播报的最后一步：模型把"文案"说完之后，插件再发 表情包 + Ciallo。
   * 放在这里是为了顺序：文案（模型）→ 表情包 → Ciallo；降档/平档不会进这里。
   */
  'after-response'(ctx = {}) {
    try {
      const key = String(ctx.chatKey || ctx.session?.chatKey || '');
      if (!key || !pendingLevelUp.has(key)) return;
      // 模型这一轮一个字都没发 → 不发图（免得群里冒出一张莫名其妙的图）
      if (!(Array.isArray(ctx.session?.sent) && ctx.session.sent.length)) {
        pendingLevelUp.delete(key);
        return;
      }
      Promise.resolve(sendLevelUpAnnounce(key)).catch((error) => api?.warn?.(`升档播报失败：${error?.message ?? error}`));
    } catch (error) {
      api?.warn?.(`升档播报异常：${error?.message ?? error}`);
    }
  },
};

// ── 能力 ────────────────────────────────────────────────────────────────────

export const providers = {
  'affinity.query': (args = {}) => {
    const s = settings();
    const qq = String(args?.qq || args?.senderId || '');
    if (!qq) return { ok: false, error: '缺少 qq' };
    const v = valueOf(qq, s);
    return { ok: true, qq, value: v, level: levelOf(v, s).name, locked: isPrivileged(qq, s), updatedAt: loadData().entries[qq]?.updatedAt || 0 };
  },
  'affinity.set': (args = {}) => {
    const qq = String(args?.qq || '');
    if (!qq) return { ok: false, error: '缺少 qq' };
    return setAffinity({ senderId: qq, value: Number(args?.value ?? args?.v ?? 0) });
  },
  'affinity.judge': (args = {}) => ({ ok: true, delta: judgeDelta(args) }),
  'affinity.query-check': (args = {}) => ({ ok: true, isQuery: isQueryingAffinity(String(args?.text || '')) }),
  'affinity.level-of': (args = {}) => {
    const s = settings();
    const lv = levelOf(Number(args?.value) || 0, s);
    return { ok: true, level: lv.name, tiers: tiersOf(s).map((t) => ({ name: t.name, value: t.value, min: t.min })) };
  },
  'affinity.tiers': () => {
    const s = settings();
    const { min, max } = bounds(s);
    return { ok: true, min, max, tiers: tiersOf(s), maxDailyGain: s.maxDailyGain, maxDailyLoss: s.maxDailyLoss, privileged: privilegedIds(s).length };
  },
};

/** 自测用。 */
export const internals = {
  settings, parseTiers, tiersOf, bounds, levelOf, nextTierUp, privilegedIds, isPrivileged, valueOf,
  applyAffinity, setAffinity, extractMarkers, stripAndScore, judgeDelta, isQueryingAffinity,
  parseChatAdjust, parseManualCommand, resolveByName, guardVerdict, applyGuardLoss, absenceSweep,
  handleEntry, toneLine, announceLineFor, install, uninstall, loadData, saveData, pruneEntries,
  stickerPath, isImage, noteLevelUp, sendLevelUpAnnounce, markAnnounced, pendingLevelUp, announcedToday,
  ASSETS_DIR, STICKER_EXTS, setSender: (fn) => { senderRef = fn || null; }, getSender: () => senderRef,
  PATCH_KEY, SENDER_PATCH_KEY, lastTargetByChat, pendingAnnounce, spamTracker,
  setContentGuardMatch: (fn) => { contentGuardMatch = typeof fn === 'function' ? fn : null; },
  setChatterState: (m) => { chatterState = m || null; },
  resetAbsenceDay: () => { lastAbsenceDay = ''; },
  dataFile,
};

function isSpam(e = {}) {
  const id = e?.senderId;
  if (!id) return false;
  const norm = String(e.text || '').replace(/\[[^\]]*\]/g, '').replace(/@[\w\u4e00-\u9fa5]+/g, '').replace(/[\s\n\r，。！？!?,.:；;、~～]+/g, '').toLowerCase();
  if (norm.length < 4) return false;
  const now = Number(e.ts) || Date.now();
  const list = (spamTracker.get(id) || []).filter((x) => now - x.ts < 20 * 60 * 1000);
  list.push({ ts: now, norm });
  if (list.length > 60) list.splice(0, list.length - 60);
  spamTracker.set(id, list);
  return list.filter((x) => x.norm === norm).length >= 3;
}
