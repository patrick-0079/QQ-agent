// 用量与花费 —— LLM 型技能（放 skills/，显示在控制台「技能」页签）。
//
// ── 这个技能做什么 ────────────────────────────────────────────────────────
// 主人问「今天花了多少 token / 多少钱」时，汇总今天到目前为止的用量：
//   ① 总量：输入 / 输出 / 总 token、缓存命中 token
//   ② 花费：按项目既有单价配置估算（与界面同源的 estimateCost）
//   ③ 排行：消耗 token 最多的前 N 个群聊/私聊（按 chatKey 聚合）
//
// ── 为什么是 Skill（LLM 型）而不是插件 ────────────────────────────────────
// 「用户随口问一句才回答」必须先让模型理解语义、判断要不要查 —— 这是技能。
// 插件（确定性型）是"满足条件必然执行、绕过大脑"的，不适合这种对话触发。
//
// ── 数据来源与口径 ────────────────────────────────────────────────────────
//   · data/session-index-cache.json —— 单文件索引（全部已结束会话的
//     chatKey / startedAt / usage / model），快；比逐个读几千个会话文件可靠。
//   · 缓存缺失时回退：扫描 data/sessions/*.json 中今天改过的文件。
//   · 花费用 src/llm.js 的 estimateCost（与 /api/status、用量页同源），
//     逐会话按各自的 model + startedAt（峰谷）计价。
//   · "今天"按本地时区（与 sessions.js 的 localDayKey 同口径）。
//
// ── 权限 ──────────────────────────────────────────────────────────────────
// 这是财务数据，只有配置里的主人 QQ 能查（owner-identity.ids /
// owner-whitelist.ownerIds）。非主人调用直接拒绝，避免群友套取。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from '../../src/config.js';
import { estimateCost } from '../../src/llm.js';
import { listLegacyFiles, readIndexEntries } from '../../src/storage/session-files.js';

let cfg = () => ({});
let log = () => {};
let warn = () => {};

const DEFAULTS = { topN: 3, includeCacheRate: true };

const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

function conf() {
  try {
    return { ...DEFAULTS, ...(cfg() || {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

function readJson(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}

/** 本地日期键 YYYY-MM-DD（与 sessions.js 的 localDayKey 同口径）。 */
function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 今天 0 点的本地时间戳（毫秒）。 */
function dayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function normalizeUsage(u) {
  const promptTokens = Number(u?.promptTokens) || 0;
  const completionTokens = Number(u?.completionTokens) || 0;
  const totalTokens = Number(u?.totalTokens) || (promptTokens + completionTokens);
  const cachedTokens = Number(u?.cachedTokens) || 0;
  return { promptTokens, completionTokens, totalTokens, cachedTokens };
}

/** 读取今天产生过的会话摘要（索引优先，旧版文件补漏）。 */
function loadTodaySessions() {
  const start = dayStart();
  const out = [];
  const seen = new Set();

  // 快路径：单文件索引（已结束会话的摘要，含 usage）
  for (const e of readIndexEntries()) {
    if (Number(e?.startedAt) < start) continue;
    out.push(e);
    seen.add(String(e.id));
  }

  // 补漏：尚未迁移的旧版 sessions/<id>.json
  for (const f of listLegacyFiles()) {
    const id = f.replace(/\.json$/, '');
    if (seen.has(id)) continue;
    const full = path.join(SESSIONS_DIR, f);
    try {
      if (fs.statSync(full).mtimeMs < start) continue;
      const data = readJson(full, null);
      if (data && Number(data.startedAt) >= start) out.push(data);
    } catch {
      /* 跳过坏文件 */
    }
  }
  return out;
}

/** 按会话的 model + 发生时刻估算花费（与界面同源）。 */
function costOf(session) {
  const usage = normalizeUsage(session?.usage);
  const model = String(session?.model || '').trim();
  const at = Number(session?.startedAt) || Date.now();
  try {
    return Number(estimateCost(usage, { model, at }).cost) || 0;
  } catch {
    return 0;
  }
}

/** 按 chatKey 聚合，并按总 token 倒序。 */
function aggregate(sessions) {
  const perChat = new Map();
  const totals = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, cost: 0, runs: 0 };

  for (const s of sessions) {
    const u = normalizeUsage(s?.usage);
    if (u.totalTokens === 0 && u.promptTokens === 0 && u.completionTokens === 0) continue;
    const key = String(s?.chatKey || 'unknown');
    const cost = costOf(s);
    let e = perChat.get(key);
    if (!e) {
      e = { chatKey: key, promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, cost: 0, runs: 0 };
      perChat.set(key, e);
    }
    e.promptTokens += u.promptTokens;
    e.completionTokens += u.completionTokens;
    e.totalTokens += u.totalTokens;
    e.cachedTokens += u.cachedTokens;
    e.cost += cost;
    e.runs += 1;

    totals.promptTokens += u.promptTokens;
    totals.completionTokens += u.completionTokens;
    totals.totalTokens += u.totalTokens;
    totals.cachedTokens += u.cachedTokens;
    totals.cost += cost;
    totals.runs += 1;
  }

  const list = [...perChat.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  return { totals, list };
}

/** 群聊/私聊的显示文案。 */
function formatChat(chatKey) {
  const s = String(chatKey || '');
  const g = /^group:(\d+)$/.exec(s);
  if (g) return `群聊 ${g[1]}`;
  const p = /^private:(\d+)$/.exec(s);
  if (p) return `私聊 ${p[1]}`;
  return s || '未知会话';
}

function fmt(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function money(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v === 0) return '0.00';
  return v < 0.01 ? v.toFixed(4) : v.toFixed(2);
}

/** 生成给模型看的报告文本。 */
function render() {
  const c = conf();
  const topN = Math.min(10, Math.max(1, Math.round(Number(c.topN) || 3)));
  const day = todayKey();
  const { totals, list } = aggregate(loadTodaySessions());

  if (!list.length) {
    return `今天（${day}）到目前为止还没有产生消耗。`;
  }

  const lines = [];
  lines.push(`今天（${day}）截至目前：`);
  lines.push(`总消耗 ${fmt(totals.totalTokens)} token（输入 ${fmt(totals.promptTokens)} / 输出 ${fmt(totals.completionTokens)}）`);
  lines.push(`估算花费约 ¥${money(totals.cost)}`);
  if (c.includeCacheRate) {
    const rate = totals.promptTokens > 0 ? (totals.cachedTokens / totals.promptTokens) * 100 : 0;
    lines.push(`缓存命中率 ${rate.toFixed(1)}%（命中 ${fmt(totals.cachedTokens)} token）`);
  }
  lines.push(`共 ${totals.runs} 个会话、涉及 ${list.length} 个群聊/私聊。`);
  lines.push(`今天消耗最多的前 ${Math.min(topN, list.length)} 个：`);
  for (let i = 0; i < Math.min(topN, list.length); i += 1) {
    const e = list[i];
    lines.push(`${i + 1}. ${formatChat(e.chatKey)}：${fmt(e.totalTokens)} token，约 ¥${money(e.cost)}`);
  }
  return lines.join('\n');
}

// ── 权限：只有主人能查 ──────────────────────────────────────────────────

/** 主人 QQ 列表（owner-identity.ids / owner-whitelist.ownerIds，去重、只留合法号码）。 */
function ownerIds() {
  const cfgNow = getConfig() || {};
  const skills = cfgNow.skills || {};
  const rawList = [
    skills['owner-identity']?.ids,
    skills['owner-whitelist']?.ownerIds,
    cfgNow.ownerIds
  ];
  const out = [];
  for (const raw of rawList) {
    if (!raw) continue;
    const list = Array.isArray(raw) ? raw : String(raw).split(/[,，;；\s]+/);
    for (const item of list) {
      const id = String(item ?? '').trim();
      if (/^\d{5,15}$/.test(id) && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

function isOwnerAsking(ctx, ids) {
  if (!ids.length) return false;
  const trigger = ctx?.session?.trigger;
  if (Array.isArray(trigger)) {
    for (const m of trigger) {
      if (m && m.self !== true && ids.includes(String(m.senderId || ''))) return true;
    }
  }
  const m = /^private:(\d+)$/.exec(String(ctx?.chatKey || ''));
  if (m && ids.includes(m[1])) return true;
  return false;
}

// ── Skill 生命周期 ────────────────────────────────────────────────────────

export function setup(api) {
  cfg = api.config || (() => ({}));
  log = api.log || (() => {});
  warn = api.warn || (() => {});

  api.registerTool({
    id: 'today',
    name: '查询今日用量与花费',
    description:
      '汇总今天到目前为止的 token 用量、估算花费、缓存命中率，以及消耗最多的前几个群聊/私聊。'
      + '只在主人问「今天花了多少 / 谁最费钱」时调用；数据敏感，只有主人能查，非主人调用会被拒绝。',
    category: 'query',
    icon: '📊',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      try {
        const ids = ownerIds();
        if (!ids.length) {
          return { content: '还没配置主人 QQ 号，无法查询用量。', isError: true };
        }
        if (!isOwnerAsking(ctx, ids)) {
          return { content: '这块用量数据只有主人能查，你不是主人，我就不给你看了。', isError: true };
        }
        return { content: render() };
      } catch (error) {
        try {
          warn(`用量查询失败：${error?.message ?? error}`);
        } catch {
          /* ignore */
        }
        return { content: `status: error\n用量查询失败：${String(error?.message ?? error)}`, isError: true };
      }
    }
  });
}

/** 无外部依赖，恒可用。 */
export function available() {
  return { ok: true };
}

/** 排障用。 */
export const internals = {
  todayKey, dayStart, loadTodaySessions, aggregate, ownerIds, isOwnerAsking, render
};
