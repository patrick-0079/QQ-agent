// 一键下线通知（确定性型插件 / 放在 plugins/）
//
// ── 干什么 ────────────────────────────────────────────────────────────────
// 主人私聊说一句「下线」（或在群里 @机器人 说），机器人就：
//   ① 给白名单里的**所有群聊和私聊**各发一条下线通知；
//   ② 发给主人的那条私聊里额外带上**今日消耗 token / 缓存命中率 / 使用金额**；
//   ③ 把响应暂停一段时间（默认 24 小时），期间被 @ 也不说话、不调用任何工具。
// 主人说一句「上线」即恢复，并给白名单再发一条上线通知。
//
// ── 为什么做成插件（确定性型）而不是技能（LLM 型）──────────────────────────
// 按 src/skills/manifest.js 的 DIR_KIND 约定：
//   · 触发条件是「主人 + 固定词」，规则能写死 → 命中必然执行，不交给模型判断；
//   · 收件人名单（白名单）与通知文案、金额数字全部可预先确定；
//   · 模型若能参与，就可能把同一条通知发两次、或自己改写数字。
// 三条都指向"确定性型"，所以放 plugins/。
//
// ⚠️ 本插件**不注册任何工具**。这不是遗漏，而是刻意的：
//   createSkillApi 暴露给插件的只有 registerTool/config/capability/log/utils，
//   **没有** sender；钩子上下文（orchestrator.js 的 skillContext）里同样没有
//   onebot / sender —— 只有工具 execute(ctx) 拿得到。
//   而本插件要发给"当前会话以外"的一串群和私聊，且必须不依赖模型，
//   所以自己按 snowluma 配置建一个 OneBot HTTP 客户端直接发送（见 sendText）。
//   好处是整条链路完全不经过 LLM，也就无所谓"模型愿不愿意调用工具"。
//
// ── 怎么"停止回应" ──────────────────────────────────────────────────────────
// 一句话：下线期间**一条消息都不进模型**。
//   ① 主闸门：`chat.skip-run` 能力 —— 核心在**建会话之前**问一句"这一轮要不要跑"，
//      返回 { skip: true } 就直接标已读、丢掉等待会话、return：不建会话、不调模型。
//   ② 兜底：万一闸门没被接上（旧核心），before-llm-messages 仍会把本轮压成
//      「已下线，调用 finish 结束」，before-tool 拦掉除 finish 之外的工具，
//      after-response 清空正文 —— 那时才需要这三道钩子。
//   下线状态只是 config 里的一个时间戳（0 = 到主人说「上线」为止），不再往
//   commandMute 写东西：少一处会残留的状态，插件关掉也不会把群卡在"仅艾特"。
//
// ── 数据从哪来（今日用量）──────────────────────────────────────────────────
//   data/session-index-cache.json —— 核心自己维护的会话索引，每条含
//   chatKey / startedAt / usage{promptTokens,completionTokens,cachedTokens} / model。
//   金额复用核心的 src/model-prices.js（resolveModelPrice + sumCostByTime），
//   按每条记录自己的模型与时刻分别计价后汇总 —— 与「用量」页同一套算法与价格表，
//   不是另算一套。金额是估算值，文案里会标"约"。
//
// ── 常见坑（都已规避）─────────────────────────────────────────────────────
//   · plugin.json / index.js 一律不带 UTF-8 BOM（BOM 会让 JSON.parse 直接抛错，
//     且报错信息完全不提 BOM）
//   · 清单里的设置项名字不能含 key/token/secret/cookie/password —— 命中的字符串
//     字段会被核心当成密钥，在设置弹窗里显示成 ****** 的密码框
//   · 群号/QQ 号一律存成字符串：QQ 号超过 Number 安全范围会丢精度
//   · updateConfig 的对象字段是深合并，覆盖类数组/映射必须用 { __replace__: x }
//   · hot reload 会重新 import 本模块，模块级状态会重置；但"是否处于下线状态"
//     是读配置而非读内存，所以重载后状态不丢

import fs from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';
import { getConfig, getGlobalConfig, updateConfig, DATA_DIR } from '../../src/config.js';
import { profiledChatKeys } from '../../src/chat-profiles.js';
import { OneBotClient } from '../../src/onebot.js';
import { logger } from '../../src/logger.js';
import { resolveModelPrice, sumCostByTime } from '../../src/model-prices.js';

const PLUGIN_ID = 'bot-offline-notice';

const SESSION_INDEX_FILE = path.join(DATA_DIR, 'session-index-cache.json');
const DAY_MS = 86400000;
const TASK_TTL_MS = 30 * 60 * 1000;   // 一次触发任务的记忆有效期（防 Map 无限增长）

let api = null;
let log = () => {};
let warn = () => {};

/** sessionId -> { at, action }：本进程内"刚处理过的下线/上线"，用于去重与"这一轮别回话" */
const recentTriggers = new Map();
/** 广播串行锁：同一时刻只允许一次广播在跑 */
let broadcastBusy = false;
/** 上次下线广播时间（重复触发保护） */
let lastOfflineAt = 0;

// ───────────────────────────── 设置 ─────────────────────────────

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 把设置规整成稳定的形状（设置项缺省/写错都不该让功能消失）。 */
function normalizeSettings(raw = {}) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const words = (v, fallback) => {
    const list = String(v ?? '')
      .split(/[,，、;；\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    return list.length ? list : [...fallback];
  };
  const tpl = (v, fallback) => {
    const s = String(v ?? '').trim();
    return s || fallback;
  };
  return {
    ownerIdsRaw: String(c.ownerIds ?? '').trim(),
    offlineWords: words(c.offlineWords, DEFAULT_OFFLINE_WORDS),
    onlineWords: words(c.onlineWords, DEFAULT_ONLINE_WORDS),
    statusWords: words(c.statusWords, DEFAULT_STATUS_WORDS),
    notifyGroupsRaw: String(c.notifyGroups ?? '').trim(),
    notifyPrivateRaw: String(c.notifyPrivate ?? '').trim(),
    offlineTpl: tpl(c.offlineTpl, DEFAULT_OFFLINE_TPL),
    onlineTpl: tpl(c.onlineTpl, DEFAULT_ONLINE_TPL),
    ownerTpl: tpl(c.ownerTpl, DEFAULT_OWNER_TPL)
  };
}

/** 通知之间的固定间隔（不可配：只是为了避免一次广播把 QQ 发得太快）。 */
const PACE_MS = 1200;

const DEFAULT_OFFLINE_WORDS = ['下线', '关机', '休息了', '下班', '晚安下线'];
const DEFAULT_ONLINE_WORDS = ['上线', '回来', '恢复', '上工'];
const DEFAULT_STATUS_WORDS = ['下线状态', '离线状态'];
const DEFAULT_OFFLINE_TPL = '【{name}】下线通知：机器人要休息啦，接下来一段时间不会主动回应。\n时间：{time}\n原因：{reason}';
const DEFAULT_ONLINE_TPL = '【{name}】上线通知：机器人回来啦，可以正常聊天了。\n时间：{time}';
const DEFAULT_OWNER_TPL = '【{name}】已下线。\n时间：{time}\n本次共通知 {chatCount} 个会话（群 {groupCount} 个，私聊 {privateCount} 个）。\n今日消耗 token：{tokens}\n缓存命中率：{hitRate}\n使用金额：{cost}\n调用次数：{runs} 次';

function currentSettings() {
  try {
    return normalizeSettings(api?.config?.() || {});
  } catch (error) {
    warn('读取设置失败，已回落默认值：%s', error?.message ?? error);
    return normalizeSettings({});
  }
}

// ───────────────────────────── 小工具 ─────────────────────────────

/** 拆 "123,456 789" → ['123','456','789']（去重，保持字符串形态防丢精度）。 */
function parseIdList(text) {
  const out = [];
  const seen = new Set();
  for (const part of String(text ?? '').split(/[,，、;；\s]+/)) {
    const id = part.trim();
    if (!id || !/^\d+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** 本地日键 YYYY-MM-DD（与核心 sessions.js 的 dayKey 同口径）。 */
function localDayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtClock(ts = Date.now()) {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

/** 千分位整数。 */
function fmtInt(n) {
  return Math.round(Number(n) || 0).toLocaleString('en-US');
}

/** token 数：过万折成 "1.15万"，否则原样；与仓库里其它播报的观感一致。 */
function fmtTokens(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v >= 10000) return `${(v / 10000).toFixed(2)}万`;
  return fmtInt(v);
}

/** 金额：小额多留两位，避免 ¥0.00 看不出差别。 */
function fmtMoney(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v > 0 && v < 0.01) return v.toFixed(4);
  return v.toFixed(2);
}

function fmtHitRate(rate) {
  const v = Math.max(0, Math.min(1, Number(rate) || 0));
  return `${(v * 100).toFixed(1)}%`;
}

/** 机器人名字（用于通知文案）。 */
function botName() {
  const p = getConfig()?.persona || {};
  return String(p.selfNickname || p.botName || '').trim() || '机器人';
}

/**
 * 模板渲染：只替换已知占位符，未知的保持原样（不静默吞掉，方便作者发现自己写错了）。
 */
function render(tpl, vars) {
  return String(tpl ?? '').replace(/\{(\w+)\}/g, (whole, name) => (
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole
  ));
}

// ───────────────────────────── 收件人（白名单）─────────────────────────────

/**
 * 解析"要通知谁"。
 *
 * 群：**只认设置里明确写出的群号**。留空 = 一个群都不通知
 *     （以前会拿"已添加的会话"兜底，结果留空反而给所有群发了一遍，很反直觉）。
 * 私聊：设置里的号；留空才退回"已单独添加的私聊"；主人一定会收到一条
 *     （带今日用量，否则下线了连自己都不知道跑没跑成）。
 *
 * @returns {{groups: string[], privates: string[], ownerId: string}}
 */
function resolveTargets(settings, ownerId) {
  // ⚠️ profiledChatKeys() 返回的是 Set，不是数组：直接 .filter 会抛
  // "keys.filter is not a function"，而调用方都包在 try/catch 里 ——
  // 表现就是"指令识别到了却什么都没发、日志也只有一句失败"。必须先转成数组。
  const keys = [...profiledChatKeys()];
  const profilePrivates = keys.filter((k) => String(k).startsWith('private:'))
    .map((k) => String(k).slice('private:'.length));

  const groups = parseIdList(settings.notifyGroupsRaw);   // 不兜底：留空就是不发群
  let privates = parseIdList(settings.notifyPrivateRaw);
  if (!privates.length) privates = profilePrivates;

  // 主人的私聊一定要收到（否则下线了连自己都收不到用量统计）
  if (ownerId && !privates.includes(ownerId)) privates.push(ownerId);

  return { groups, privates, ownerId };
}

/**
 * 会话索引里最近出现过的群/私聊（只在“没配名单”的历史兜底路径用）。
 * 2026-10-22：上一版清理白名单时误删了这个函数，但导出表仍引用它 →
 * 插件加载直接 ReferenceError。这里按索引缓存恢复最小实现。
 */
function knownChats() {
  const groups = [];
  const privates = [];
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_INDEX_FILE, 'utf8'));
    const entries = Array.isArray(data?.entries) ? data.entries : (Array.isArray(data) ? data : []);
    for (const e of entries) {
      const key = String(e?.chatKey || '');
      const [kind, id] = key.split(':');
      if (!id) continue;
      if (kind === 'group') groups.push(id);
      if (kind === 'private') privates.push(id);
    }
  } catch { /* 索引缺失时返回空 */ }
  return { groups: [...new Set(groups)], privates: [...new Set(privates)] };
}

/** 允许下线的人：插件设置 > 主人识别技能 > 亲密度技能的 ownerQq。 */
function resolveOwnerIds(settings) {
  const cfg = getConfig() || {};
  let ids = parseIdList(settings.ownerIdsRaw);
  if (ids.length) return ids;
  const identity = cfg.skills?.['owner-identity'];
  if (identity) ids = parseIdList(identity.ids);
  if (ids.length) return ids;
  const affinity = cfg.skills?.affinity;
  if (affinity) ids = parseIdList(affinity.ownerQq);
  return ids;
}

// ───────────────────────────── 下线状态（持久化在配置里）──────────────────

/**
 * 当前是否处于下线状态。
 *
 * 2026-10-22 简化后只有"一直下线到主人说上线"一种，所以用 `offline: true` 表示；
 * `registered` 仍然兼容旧数据（> 0 表示一个到期时间戳）。
 */
function suspendState() {
  const raw = getConfig()?.skills?.['bot-offline-notice'];
  const until = Number(raw?.registered) || 0;
  const timed = until > 0 && Date.now() < until;          // 旧版：到点自动恢复
  const manual = raw?.offline === true;                    // 新版：直到说「上线」
  return {
    active: manual || timed,
    until: timed ? until : 0,
    at: Number(raw?.at) || 0,
    reason: String(raw?.reason || ''),
    chats: Array.isArray(raw?.chats) ? raw.chats.map(String) : []
  };
}

/** 写"已下线"状态。0 = 一直停到主人说上线。 */
function markSuspended({ until, reason, chats }) {
  const deathLine = Number(until) || 0;
  // ⚠️ 只写状态字段，**不碰 enabled**：以前这里顺手写了 enabled: true，
  //    结果每下一次线就把插件在所有会话里打开一次 —— 用户看到的就是
  //    "这插件莫名其妙全局启用了"。开关只归用户，插件不许自己改。
  updateConfig({
    skills: {
      'bot-offline-notice': {
        offline: true,
        registered: deathLine,
        at: Date.now(),
        reason: String(reason || ''),
        chats: Array.from(new Set((chats || []).map(String)))
      }
    }
  });
}

/** 清除"已下线"状态。 */
function clearSuspended() {
  updateConfig({
    skills: {
      'bot-offline-notice': { offline: false, registered: 0, at: 0, reason: '', chats: { __replace__: [] } }
    }
  });
}

// ───────────────────────────── 今日用量统计 ─────────────────────────────

/**
 * 统计"今天"的 token / 缓存命中率 / 金额。
 *
 * 口径与「用量」页一致：逐条按该条自己的模型与发生时刻计价（峰谷分时也吃得对），
 * 而不是拿今天的 token 总数乘当前模型单价 —— 那在换过模型或跨峰谷时会对不上账。
 *
 * 任何一步失败都退化成一个"数字为空"的结果，绝不让通知发不出去。
 * @returns {{tokens:number,totalTokens:number,promptTokens:number,completionTokens:number,
 *            cachedTokens:number,cost:number,hitRate:number,runs:number,models:Array,ok:boolean}}
 */
function collectTodayUsage(now = Date.now()) {
  const empty = {
    tokens: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0,
    cachedTokens: 0, cost: 0, hitRate: 0, runs: 0, models: [], ok: false
  };
  let data;
  try {
    data = JSON.parse(fs.readFileSync(SESSION_INDEX_FILE, 'utf8'));
  } catch {
    return empty;   // 索引不存在/损坏：通知照发，只是数字为 0
  }
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  if (!entries.length) return empty;

  // 判定"今天"：优先信索引自己的 dayKey 口径，否则按本地自然日
  const dayKey = data?.dayKey ? String(data.dayKey) : localDayKey(now);
  const dayStart = new Date(`${dayKey}T00:00:00`).getTime();
  if (!Number.isFinite(dayStart)) return empty;
  const dayEnd = dayStart + DAY_MS - 1;

  const byModel = new Map();   // model -> rows[]
  let runs = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedTokens = 0;
  let totalTokens = 0;

  for (const e of entries) {
    if (!e) continue;
    const at = Number(e.startedAt) || Number(e.endedAt) || 0;
    if (!at || at < dayStart || at > dayEnd) continue;
    const u = e.usage || {};
    const prompt = Number(u.promptTokens) || 0;
    const completion = Number(u.completionTokens) || 0;
    const cached = Math.min(Number(u.cachedTokens) || 0, prompt);
    const total = Number(u.totalTokens) || (prompt + completion);
    if (!prompt && !completion && !total) continue;   // 零消耗会话不计（与核心记账同口径）

    promptTokens += prompt;
    completionTokens += completion;
    cachedTokens += cached;
    totalTokens += total;
    runs += 1;

    const model = String(e.model || '').trim() || String(getConfig()?.api?.model || '').trim();
    const rows = byModel.get(model) || [];
    rows.push({ at, promptTokens: prompt, completionTokens: completion, cachedTokens: cached });
    byModel.set(model, rows);
  }

  if (!runs) return { ...empty, ok: true };

  // 逐模型计价（各自的价格表条目 + 各自的峰谷时刻）
  const cfg = getConfig() || {};
  let cost = 0;
  const models = [];
  for (const [model, rows] of byModel) {
    let price = null;
    try { price = resolveModelPrice(model, cfg); } catch { price = null; }
    if (!price) continue;
    let sum = { cost: 0, peakCost: 0, offPeakCost: 0, peakTokens: 0, offPeakTokens: 0 };
    try { sum = sumCostByTime(rows, price); } catch { /* 单模型算不出来就跳过计价 */ }
    cost += sum.cost || 0;
    models.push({ model, cost: sum.cost || 0, source: price.source, calls: rows.length });
  }
  models.sort((a, b) => b.cost - a.cost);

  return {
    ok: true,
    tokens: totalTokens,
    totalTokens,
    promptTokens,
    completionTokens,
    cachedTokens,
    cost,
    hitRate: promptTokens ? Math.min(1, cachedTokens / promptTokens) : 0,
    runs,
    models
  };
}

// ───────────────────────────── 发送 ─────────────────────────────

/**
 * 建一个只用于"发通知"的 OneBot HTTP 客户端。
 *
 * 为什么不复用核心的 sender：
 *   · 插件拿不到核心的 sender 实例（钩子上下文里没有，createSkillApi 也不给）；
 *   · 借用工具 ctx.sender 就要求模型先调用工具 —— 那正是本插件要避免的不确定性。
 * 令牌从 config.snowluma 现读（核心会把 SnowLuma 同步到的令牌写回配置），
 * 所以这里拿到的和核心在用的是同一份。
 */
function createOneBot() {
  // ⚠️ 必须读**全局**配置，不能用 getConfig()。
  //    钩子运行在会话作用域里（orchestrator 用 withChatScope 包住整轮），
  //    而作用域配置会经过 chat-profiles 的 stripSecrets：accessToken / httpAccessToken
  //    这两个字段被当密钥直接删掉（见 chat-profiles.js 的 SECRET_KEY_RE）。
  //    拿它建客户端 = 不带令牌请求 OneBot → 401 → 每条通知都失败；
  //    失败又被 broadcast 的逐条 try/catch 吞掉，只在控制台留一行 warn，
  //    从用户视角看就是"说了下线，一点反应都没有"。
  const s = getGlobalConfig()?.snowluma || {};
  return new OneBotClient({
    wsUrl: s.wsUrl,
    httpUrl: s.httpUrl,
    accessToken: s.accessToken,
    httpToken: s.httpAccessToken || s.accessToken,
    onEvent: () => {}
  });
}

/**
 * 按 chatKey 发一条文本。
 * 刻意不引用 sender.js 的 SendQueue：它是按 chatKey 限频并带去重窗口的，
 * 一次广播要发的是一串**不同**会话，逐条排队等自己的间隔只会把整轮拖到几分钟。
 * 改由本插件串行 + 固定间隔发送（见 broadcast），一次性触发最多几十条，量很小。
 */
async function sendText(onebot, chatKey, text) {
  const [kind, id] = String(chatKey).split(':');
  if (kind !== 'group' && kind !== 'private') throw new Error(`非法会话 key：${chatKey}`);
  if (!id || !/^\d+$/.test(id)) throw new Error(`非法会话号：${id}`);
  // 优先走核心发送队列：限频、排队、self 留档与普通消息一致。
  if (api?.sender?.sendTextBatch) return api.sender.sendTextBatch(chatKey, [text]);
  return onebot.sendText(kind, id, text);
}

/**
 * 串行广播：一条一条发，每条之间等 paceMs。
 * 返回 { sent: string[], failed: [{chatKey, error}] }。
 * 单条失败只记日志，绝不打断后面的收件人 —— 通知的完整性比"报错"重要。
 */
async function broadcast(targets, textOf, { paceMs }) {
  const onebot = createOneBot();
  const sent = [];
  const failed = [];
  const list = [...targets];
  for (let i = 0; i < list.length; i++) {
    const target = list[i];
    if (i > 0) await sleep(paceMs);
    try {
      await sendText(onebot, target.chatKey, textOf(target));
      sent.push(target.chatKey);
    } catch (error) {
      failed.push({ chatKey: target.chatKey, error: String(error?.message ?? error) });
    }
  }
  return { sent, failed };
}

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, Math.max(0, Number(ms) || 0));
    t.unref?.();   // 不能拖住进程退出
  });
}

// ───────────────────────────── 上线 / 下线 ─────────────────────────────

/**
 * 执行一次下线。
 * @returns {Promise<{ok:boolean, chatCount:number, groupCount:number, privateCount:number, usage:object, error?:string}>}
 */
async function goOffline({ settings, ownerId, reason }) {
  const targets = resolveTargets(settings, ownerId);
  const usage = collectTodayUsage();

  // 每个群一条通用文案；主人的私聊用带今日用量的文案
  const targetsWithText = [];
  for (const id of targets.groups) {
    targetsWithText.push({ chatKey: `group:${id}`, kind: 'group', id });
  }
  for (const id of targets.privates) {
    targetsWithText.push({ chatKey: `private:${id}`, kind: 'private', id, owner: id === ownerId });
  }

  const name = botName();
  const time = fmtClock();
  const groupText = render(settings.offlineTpl, { name, time, reason });
  const ownerText = render(settings.ownerTpl, {
    name, time, reason,
    chatCount: targetsWithText.length,
    groupCount: targets.groups.length,
    privateCount: targets.privates.length,
    tokens: fmtTokens(usage.tokens),
    hitRate: fmtHitRate(usage.hitRate),
    cost: `约 ¥${fmtMoney(usage.cost)}`,
    runs: usage.runs
  });

  const result = await broadcast(targetsWithText, (t) => (t.owner ? ownerText : groupText), {
    paceMs: PACE_MS
  });

  // 状态是"是否下线"的唯一真相；until = 0 表示一直停到主人说「上线」。
  // （不再往 config.commandMute 里写东西：静音由 chat.skip-run 闸门负责，
  //   少一处会残留的状态，插件关掉时也不会把群卡在"仅艾特"。）
  markSuspended({ until: 0, reason, chats: targetsWithText.map((t) => t.chatKey) });

  log('已下线：通知 %d 个会话（成功 %d / 失败 %d），成员用量 %s token / 命中率 %s / 约 ¥%s。',
    targetsWithText.length, result.sent.length, result.failed.length,
    fmtTokens(usage.tokens), fmtHitRate(usage.hitRate), fmtMoney(usage.cost));
  if (result.failed.length) {
    warn('部分会话通知失败：%s', result.failed.map((f) => `${f.chatKey}(${f.error})`).join('；'));
  }
  log('响应已暂停：直到主人说「上线」');

  return {
    ok: true,
    chatCount: targetsWithText.length,
    groupCount: targets.groups.length,
    privateCount: targets.privates.length,
    sentCount: result.sent.length,
    failedCount: result.failed.length,
    usage
  };
}

/** 执行一次上线。 */
async function goOnline({ settings, ownerIds }) {
  const targets = resolveTargets(settings, ownerIds[0] || '');

  const name = botName();
  const time = fmtClock();
  const text = render(settings.onlineTpl, { name, time });
  const list = [
    ...targets.groups.map((id) => ({ chatKey: `group:${id}` })),
    ...targets.privates.map((id) => ({ chatKey: `private:${id}` }))
  ];
  const result = await broadcast(list, () => text, { paceMs: PACE_MS });
  clearSuspended();

  log('已上线：通知 %d 个会话（成功 %d / 失败 %d）。',
    list.length, result.sent.length, result.failed.length);
  return { ok: true, chatCount: list.length, sentCount: result.sent.length, failedCount: result.failed.length };
}

// ───────────────────────────── 触发识别 ─────────────────────────────

function pruneRecent(now = Date.now()) {
  for (const [key, rec] of recentTriggers) {
    if (now - (Number(rec?.at) || 0) > TASK_TTL_MS) recentTriggers.delete(key);
  }
}

/**
 * 一条消息的稳定标识（用于"同一条消息只处理一次"）。
 * 优先用消息 id；没有就退到"时间戳 + 文本前 32 字"——
 * 这样同一条消息重试时签名不变，而用户再发一条同样的「下线」时间戳不同，仍然生效。
 */
function entrySig(entry) {
  if (!entry) return '';
  const id = entry.mid ?? entry.id;
  if (id !== undefined && id !== null && String(id) !== '') return `id:${id}`;
  if (entry.ts !== undefined && entry.ts !== null) {
    return `ts:${entry.ts}:${String(entry.text ?? '').slice(0, 32)}`;
  }
  return '';
}

/** 这条消息是不是在 @机器人（新存档有 atMe 标记；老存档回落到名字/QQ 号匹配）。 */
function looksAtMe(entry) {
  if (!entry) return false;
  if (entry.atMe === true) return true;
  const text = String(entry.text || '');
  if (!text) return false;
  const cfg = getConfig() || {};
  const p = cfg.persona || {};
  const names = [p.selfNickname, p.botName].map((x) => String(x || '').trim()).filter(Boolean);
  if (names.some((n) => text.includes(`@${n}`))) return true;
  const selfId = String(cfg.snowluma?.selfId || cfg.onebot?.selfId || '').trim();
  if (selfId && new RegExp(`\\[CQ:at(?:,[^\\]]*?)?qq=${selfId}[^\\]]*\\]`).test(text)) return true;
  return false;
}

/** 触发批里是否有"@机器人 + 指令词"，或有"拍了拍我"。 */
function atMeInBatch(entries) {
  return (entries || []).some((e) => e && !e.self && (looksAtMe(e) || (e.isPoke && /拍了拍\s*我/.test(String(e.text || '')))));
}

/**
 * 从本轮触发消息里认出下线/上线/状态查询指令。
 * 只有主人能触发；返回 null 表示"本轮不管"。
 *
 * @returns {{action:'offline'|'online'|'status', entry:object, word:string, ownerId:string}|null}
 */
function detect(ctx, settings) {
  if (!ctx || ctx.proactive || !ctx.sessionId) return null;
  const entries = Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries : [];
  if (!entries.length) return null;

  const ownerIds = resolveOwnerIds(settings);
  if (!ownerIds.length) return null;   // 没配主人就不认（宁可不动，也不能让谁都关得掉）

  const kind = String(ctx.kind || '');
  const isPrivate = kind === 'private' || String(ctx.chatKey || '').startsWith('private:');
  // 群里必须 @机器人；私聊不需要
  const atOk = isPrivate ? true : atMeInBatch(entries);

  const matchWord = (text, words) => words.find((w) => text.includes(w)) || null;

  // 逐条找：优先"后面说的"覆盖前面的（最后一条指令生效）
  let hit = null;
  for (const entry of entries) {
    if (!entry || entry.self) continue;
    const senderId = String(entry.senderId || '').trim();
    if (!senderId || !ownerIds.includes(senderId)) continue;
    if (!atOk) continue;
    const text = String(entry.text || '');
    if (!text) continue;

    // 状态查询放最前面：设置里未配任何查询词时不误判
    const statusWord = matchWord(text, settings.statusWords);
    const offlineWord = matchWord(text, settings.offlineWords);
    const onlineWord = matchWord(text, settings.onlineWords);

    let action = null;
    let word = '';
    if (statusWord) { action = 'status'; word = statusWord; }
    else if (onlineWord) { action = 'online'; word = onlineWord; }
    else if (offlineWord) { action = 'offline'; word = offlineWord; }
    if (!action) continue;
    hit = { action, entry, word, ownerId: senderId };
  }
  return hit;
}

// ───────────────────────────── 生命周期 ─────────────────────────────

export async function setup(a) {
  api = a;
  // 日志必须同时落到 data/logs/qq-agent-*.log。
  // 只用 api.log（= console.log）的话，事后在日志文件里一行都查不到 ——
  // 本次"通知没发出去"就是因此完全看不见（失败只在控制台闪一下）。
  log = (...args) => {
    try { logger.info(PLUGIN_ID, format(...args)); } catch { /* 日志失败不影响功能 */ }
  };
  warn = (...args) => {
    try { logger.warn(PLUGIN_ID, format(...args)); } catch { /* 日志失败不影响功能 */ }
  };

  // 启动自检：数据目录能读、索引在不在。
  // ⚠️ 这里绝不能打印"当前收件人是谁"：setup 阶段本插件还没进注册表，
  //    api.config() 拿不到用户在设置里改过的值，只会拿到默认值 —— 打了反而误导。
  const hasIndex = fs.existsSync(SESSION_INDEX_FILE);
  log('一键下线通知已加载：主人私聊（或群里 @我）说「%s」即下线并广播通知，说「%s」恢复。用量索引：%s。',
    DEFAULT_OFFLINE_WORDS[0], DEFAULT_ONLINE_WORDS[0], hasIndex ? '已找到' : '暂未生成（数字会显示为 0）');

  // 通道自检：令牌是全局配置里的（作用域配置会被剥掉，见 createOneBot 的注释）。
  // 这里只报"有没有"，绝不打印令牌本身。
  const sn = getGlobalConfig()?.snowluma || {};
  log('通知通道：%s，http %s',
    (sn.httpAccessToken || sn.accessToken) ? '已带令牌' : '**没有令牌**（协议端开了鉴权就会 401，通知发不出去）',
    sn.httpUrl || '（默认 127.0.0.1:3000）');

  // 启动时如果还处在"已下线"状态（进程重启/热重载），不需要补偿什么：
  // 静音判定每一轮都现读配置（chat.skip-run 闸门 + 钩子），状态在就不会说话。
  try {
    const state = suspendState();
    if (state.active) {
      log('检测到仍处于下线状态（%s），等主人说「上线」恢复。',
        state.until ? `到 ${fmtClock(state.until)}` : '直到说「上线」');
    }
  } catch (error) {
    warn('读取下线状态失败：%s', error?.message ?? error);
  }
}

export function available() { return { ok: true }; }

// ───────────────────────────── 运行前闸门 ─────────────────────────────

/**
 * `chat.skip-run`：核心在**建会话之前**问的一句"这一轮要不要跑"。
 *
 * 为什么需要它：只靠钩子的话，下线期间每条消息仍会走完整一轮
 * （建会话 → 组装提示词 → 调模型 → 再被钩子压掉），token 照烧。
 * 有了这个网关，下线期间**一条消息都不进模型**，会话也不会出现在列表里。
 *
 * 返回 `{ skip: true, reason }` = 不建会话、不调模型、消息标已读沉历史；
 * 返回 `{ skip: false }` = 照常运行。异常时一律按"照常运行"处理，绝不卡死对话。
 */
export const providers = {
  async 'chat.skip-run'({ chatKey, kind, entries, proactive }) {
    try {
      const key = String(chatKey || '');
      const settings = currentSettings();

      // ① 指令识别（主人 + 触发词）：下线/上线/状态 在这里就地处理完，本轮不跑模型
      const hit = detect({ chatKey: key, kind, triggerEntries: entries, proactive, sessionId: `gate:${key}` }, settings);

      if (hit && (hit.action === 'offline' || hit.action === 'online')) {
        // 去重靠**消息本身的标识**：同一条消息重试/补跑只处理一次，但用户手动连着
        // "下线→上线→下线" 是三条不同的消息，必须每次都生效（按时间窗去重会误吞）。
        pruneRecent();
        const sig = entrySig(hit.entry);
        const guard = sig ? `gate:msg:${sig}` : `gate:${key}:${hit.action}`;
        const last = recentTriggers.get(guard);
        if (last && Date.now() - (Number(last.at) || 0) < (sig ? 300000 : 15000)) {
          return { skip: true, reason: `「${hit.word}」刚刚处理过` };
        }
        recentTriggers.set(guard, { at: Date.now(), action: hit.action });
        if (hit.action === 'offline') {
          lastOfflineAt = Date.now();
          await goOffline({ settings, ownerId: hit.ownerId, reason: `主人（QQ:${hit.ownerId}）说「${hit.word}」` });
        } else {
          await goOnline({ settings, ownerIds: resolveOwnerIds(settings) });
        }
        return { skip: true, reason: `已处理「${hit.word}」指令` };
      }

      if (hit && hit.action === 'status') {
        await replyDirect(key, suspendStateText(suspendState()));
        return { skip: true, reason: '状态查询已直接回复' };
      }

      // ② 下线期间：任何会话的任何消息都不进模型（含群、私聊、主动发言）
      if (suspendState().active) return { skip: true, reason: '机器人已下线' };

      return { skip: false };
    } catch (error) {
      warn('运行前闸门判定失败，按「照常运行」处理：%s', error?.message ?? error);
      return { skip: false };
    }
  }
};

/** 不经过模型、直接往当前会话发一句（只用于状态查询这种一句话答复）。 */
async function replyDirect(chatKey, text) {
  const [kind, id] = String(chatKey || '').split(':');
  if ((kind !== 'group' && kind !== 'private') || !id) return;
  const onebot = createOneBot();
  await onebot.sendText(kind, id, text);
}

/** 状态查询的一句话答复。 */
function suspendStateText(state) {
  if (!state.active) return '现在是上线状态，可以正常聊天。';
  return state.until
    ? `已下线，预计 ${fmtClock(state.until)} 自动恢复；说「上线」可以立刻恢复。`
    : '已下线，直到你说「上线」。';
}

// ───────────────────────────── 钩子 ─────────────────────────────

export const hooks = {
  /**
   * ① 确定性识别指令。识别到就**当场执行**（发通知 + 落状态），
   *    并标记本轮为"已接管"（任务会在下面几个钩子里生效）。
   *
   * 为什么在这里发而不在工具里：工具要模型先调用，本插件要的正是"不靠模型"。
   */
  async 'before-context'(ctx) {
    try {
      pruneRecent();
      const settings = currentSettings();
      const hit = detect(ctx, settings);
      if (!hit) return;
      const key = String(ctx.sessionId || ctx.chatKey || '');
      if (!key) return;
      // 同一条消息重复进入 before-context（重试/补跑）时只处理一次
      if (recentTriggers.has(key)) return;

      if (hit.action === 'status') {
        const state = suspendState();
        recentTriggers.set(key, { at: Date.now(), action: 'status' });
        // 状态查询不影响对话，交给模型正常回一句即可，这里只记日志
        log('主人查询下线状态：当前%s。',
          state.active ? `处于下线中（${state.until ? `到 ${fmtClock(state.until)}` : '直到说「上线」'}）` : '在线');
        return;
      }

      if (hit.action === 'offline') {
        if (broadcastBusy) {
          recentTriggers.set(key, { at: Date.now(), action: 'offline' });
          log('上一次广播还在进行中，本次下线指令已忽略。');
          return;
        }
        recentTriggers.set(key, { at: Date.now(), action: 'offline' });
        broadcastBusy = true;
        lastOfflineAt = Date.now();
        try {
          await goOffline({ settings, ownerId: hit.ownerId, reason: `主人（QQ:${hit.ownerId}）说「${hit.word}」` });
        } finally {
          broadcastBusy = false;
        }
        return;
      }

      if (hit.action === 'online') {
        recentTriggers.set(key, { at: Date.now(), action: 'online' });
        if (broadcastBusy) { log('上一次广播还在进行中，本次上线指令已忽略。'); return; }
        broadcastBusy = true;
        try {
          await goOnline({ settings, ownerIds: resolveOwnerIds(settings) });
        } finally {
          broadcastBusy = false;
        }
      }
    } catch (error) {
      warn('处理下线/上线指令失败：%s', error?.message ?? error);
    }
  },

  /**
   * ② 下线期间把本轮对话压成一句"什么都别做"。
   *    没有它，模型会对着"主人说下线了"这句闲聊再回一句，形成重复播报。
   */
  'before-llm-messages'(ctx) {
    try {
      const settings = currentSettings();
      const state = suspendState();
      if (!state.active) return;

      // 刚刚由这一轮触发了下线：这一轮本身也不许再回话。
      // 主人虽然被豁免（要他还能说「上线」），但"下线"这句话不该再收到一句闲聊回复 ——
      // 确认信息由下线的私聊通知承担。
      if (justTriggeredOffline(ctx)) { silenceRound(ctx); return; }

      // 主人自己发来的消息（用来触发上线）不受影响
      const ownerIds = resolveOwnerIds(settings);
      const entries = Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries : [];
      if (entries.some((e) => e && !e.self && ownerIds.includes(String(e.senderId || '')))) return;
      if (!Array.isArray(ctx.messages)) return;

      // 收件人名单在"未接管"的会话里不给：这里只看配置里的白名单，
      // 由#shouldSilence决定是否要闭嘴（见下）。
      if (!shouldSilence(ctx, settings, state)) return;

      silenceRound(ctx);
    } catch (error) {
      warn('下线期间改写本轮对话失败：%s', error?.message ?? error);
    }
  },

  /**
   * ③ 下线期间除了 finish，别的工具一律拒绝。
   *    这是"一个字都发不出去"的第二道闸：即使模型不听话去调 send_message，
   *    也会在这里被拦下，而且回复安全网合成的发送调用同样过这道闸。
   */
  'before-tool'(ctx) {
    try {
      const name = String(ctx.toolName || '');
      if (justTriggeredOffline(ctx)) {
        return name === 'finish' ? undefined : { block: true, reason: '机器人已下线，本轮不调用任何工具。' };
      }
      const settings = currentSettings();
      const state = suspendState();
      if (!state.active) return;
      if (!shouldSilence(ctx, settings, state)) return;
      if (name === 'finish') return;
      return { block: true, reason: '机器人已下线，本轮不调用任何工具。' };
    } catch {
      return undefined;   // 判定失败就放行，宁可多说一句也不要卡死整轮
    }
  },

  /** ④ 兜底：下线期间万一还是有正文，清掉它。 */
  'after-response'(ctx) {
    try {
      const settings = currentSettings();
      const state = suspendState();
      if (!state.active) return;
      if (!justTriggeredOffline(ctx) && !shouldSilence(ctx, settings, state)) return;
      if (ctx?.response?.message) {
        ctx.response.message.content = '';
        if (Array.isArray(ctx.response.message.tool_calls)) ctx.response.message.tool_calls = [];
      }
    } catch { /* ignore */ }
  }
};

/** 把本轮对话压成一句"已下线，调用 finish"。 */
function silenceRound(ctx) {
  if (!Array.isArray(ctx.messages)) return;
  const kept = ctx.messages.filter((m) => m?.role === 'system' || m?.role === 'developer');
  ctx.messages.splice(0, ctx.messages.length, ...kept);
  ctx.messages.push({
    role: 'user',
    content: [
      '【系统状态：机器人已下线】',
      '当前处于下线状态，本轮不需要、也不允许发出任何内容。',
      '请立刻调用 finish 结束本轮：不要调用 send_message、send_sticker 等任何工具，也不要输出要发给群友的话。',
      '任何正文都不会被发送出去。'
    ].join('\n')
  });
}

/** 这一轮是不是"刚触发下线"的那一轮（用于连它自己的回复也压掉）。 */
function justTriggeredOffline(ctx) {
  const rec = recentTriggers.get(String(ctx?.sessionId || ''));
  if (!rec || rec.action !== 'offline') return false;
  return Date.now() - (Number(rec.at) || 0) < 120000;
}

/**
 * 这个会话在下线期间要不要"闭嘴"。
 *
 * 规则：
 *   · 主人自己来的消息一律不闭嘴 —— 否则他没法用「上线」把机器人叫回来
 *     （before-context 在提示词组装之前就跑，所以主人那条上线指令已经处理过了）；
 *   · 收件人（白名单 + 下线时记下的那批）里的会话要闭嘴；
 *   · 别的会话不打扰 —— 别人 @ 机器人该怎么答还怎么答，下线只针对白名单。
 */
function shouldSilence(ctx, settings, state) {
  const ownerIds = resolveOwnerIds(settings);
  const entries = Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries : [];
  if (entries.some((e) => e && !e.self && ownerIds.includes(String(e.senderId || '')))) return false;

  const chatKey = String(ctx.chatKey || '');
  if (state.chats.length && state.chats.includes(chatKey)) return true;
  // 下线状态里没记到（比如热重载后 chats 丢了）：退回按当前白名单判断
  const targets = resolveTargets(settings, ownerIds[0] || '');
  if (String(chatKey).startsWith('group:')) return targets.groups.includes(String(chatKey).split(':')[1]);
  if (String(chatKey).startsWith('private:')) return targets.privates.includes(String(chatKey).split(':')[1]);
  return false;
}

export function deactivate() { recentTriggers.clear(); }
export function dispose() { recentTriggers.clear(); }

// 离线自检用（不参与运行时逻辑）
export const internals = {
  parseIdList, localDayKey, fmtTokens, fmtMoney, fmtHitRate, render,
  normalizeSettings, resolveTargets, resolveOwnerIds, knownChats,
  collectTodayUsage, suspendState, detect, looksAtMe, atMeInBatch, shouldSilence,
  DEFAULT_OFFLINE_WORDS, DEFAULT_ONLINE_WORDS, SESSION_INDEX_FILE
};
