// 戳一戳统计插件（确定性型）
//
// 功能：
//   1. 每次机器人被戳一戳，今日计数 +1，并持久化到 data/plugins/poke-counter/data.json
//   2. 按可配置概率从预设文本里随机抽一条回复（支持 {n} / {count} 占位符）
//   3. 维护一个数字，每次被戳时执行预设表达式（如 n + 1、n * 2），结果播报
//
// 接入点：
//   app.js 的 ingestPoke() 在识别到"戳机器人"时会调用
//   globalThis.wuwaEmojiPokeSend(chatKey, sender) 然后 return（不走 LLM）。
//   本插件 setup 时包装这个全局函数：先跑自己的统计/回复逻辑，再透传给
//   原始实现（鸣潮表情插件），两者互不干扰。
//   若该全局函数尚未被任何插件设置（鸣潮表情未启用），本插件直接占用它，
//   这样被戳时走确定性回复、不触发 AI、零 token 消耗。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let _api = null;
// 被包装前的原始 globalThis.wuwaEmojiPokeSend（鸣潮表情插件或 undefined）
let _origPokeSend = null;
// 本插件挂上去的包装引用（deactivate 时只在"仍是自己的"时才还原）
let _myPokeWrapper = null;
// 冷却表：chatKey -> 上次回复时间戳
const _lastReplyAt = new Map();

// ── 数据文件路径 ────────────────────────────────────────────────────────────
// 插件在 <install>/resources/app/plugins/poke-counter/index.js
// 向上 4 级 = 安装根目录（与 gscore-bridge 同口径）
function dataFile() {
  const pluginDir = path.dirname(fileURLToPath(import.meta.url));
  const installDir = path.resolve(pluginDir, '..', '..', '..', '..');
  return path.join(installDir, 'data', 'plugins', 'poke-counter', 'data.json');
}

// ── 配置读取 ────────────────────────────────────────────────────────────────
function cfg() { return _api?.config?.() || {}; }

function settings() {
  const c = cfg();
  return {
    replyProbability: Math.min(1, Math.max(0, Number(c.replyProbability) ?? 0.3)),
    replyTexts: String(c.replyTexts ?? '').trim(),
    expression: String(c.expression ?? 'n + 1').trim() || 'n + 1',
    initialValue: Number(c.initialValue) || 0,
    perGroup: c.perGroup === true,
    showNumber: c.showNumber !== false,
    showDailyCount: c.showDailyCount !== false,
    cooldownMs: Math.max(0, Number(c.cooldownMs) || 0)
  };
}

// ── 本地日期 key（YYYY-MM-DD）───────────────────────────────────────────────
function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ── 持久化 ──────────────────────────────────────────────────────────────────
// 数据结构（新旧兼容）：
//   新版 { global: {daily,total,number}, groups: {chatKey: {daily,total,number}} }
//   旧版 { daily, total, number }（早期全局模式直写顶层）→ 启动时迁移到 global
function emptyBlock() {
  return { daily: {}, total: 0, number: settings().initialValue };
}

function loadData() {
  const file = dataFile();
  try {
    if (!fs.existsSync(file)) {
      return { global: emptyBlock(), groups: {} };
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    // 旧版顶层直写 → 迁到 global
    if (raw && raw.daily && !raw.global) {
      return {
        global: { daily: raw.daily, total: Number(raw.total) || 0, number: Number(raw.number) || 0 },
        groups: (raw.groups && typeof raw.groups === 'object') ? raw.groups : {}
      };
    }
    return {
      global: (raw?.global && typeof raw.global === 'object') ? raw.global : emptyBlock(),
      groups: (raw?.groups && typeof raw.groups === 'object') ? raw.groups : {}
    };
  } catch (e) {
    try { _api?.warn?.('poke-counter 读取数据失败，重置：%s', e?.message || e); } catch {}
    return { global: emptyBlock(), groups: {} };
  }
}

/** 根据 perGroup 设置选出本次戳要用的数据块（全局或当前会话）。 */
function blockFor(data, chatKey) {
  if (!settings().perGroup) return data.global;
  if (!data.groups[chatKey]) data.groups[chatKey] = emptyBlock();
  return data.groups[chatKey];
}

function saveData(data) {
  const file = dataFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 原子写：先写临时文件再 rename，避免崩溃留半截 JSON
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { _api?.warn?.('poke-counter 写入数据失败：%s', e?.message || e); } catch {}
  }
}

// ── 表达式求值（仅暴露 n 为当前数值）─────────────────────────────────────────
function applyExpression(expr, n) {
  try {
    const fn = new Function('n', `"use strict"; return (${expr});`);
    const result = fn(n);
    if (typeof result === 'number' && Number.isFinite(result)) return result;
    return n;
  } catch (e) {
    try { _api?.warn?.('poke-counter 表达式无效（%s），保留原数值：%s', expr, e?.message || e); } catch {}
    return n;
  }
}

// ── 组装回复文本 ──────────────────────────────────────────────────────────
function buildReplyText(texts, n, count) {
  // 把多行预设文本拆成数组，滤掉空行
  const lines = texts.split('\n').map((s) => s.trim()).filter(Boolean);
  let chosen = lines.length
    ? lines[Math.floor(Math.random() * lines.length)]
    : '';

  // 先做占位符替换
  if (chosen) {
    chosen = chosen.replaceAll('{n}', String(n)).replaceAll('{count}', String(count));
  }

  const extra = [];
  const s = settings();
  // 文本里没写 {n} 且配置开启播报数值 → 自动追加
  if (s.showNumber && !lines.some((l) => l.includes('{n}'))) {
    extra.push(`当前数值：${n}`);
  }
  // 文本里没写 {count} 且配置开启播报今日次数 → 自动追加
  if (s.showDailyCount && !lines.some((l) => l.includes('{count}'))) {
    extra.push(`今天被戳 ${count} 次了`);
  }

  const parts = [];
  if (chosen) parts.push(chosen);
  if (extra.length) parts.push(extra.join('，'));
  return parts.join('，') || `今天被戳 ${count} 次了，当前数值：${n}`;
}

// ── 戳一戳主逻辑 ──────────────────────────────────────────────────────────
async function handlePoke(chatKey, sender) {
  const s = settings();
  const data = loadData();
  const block = blockFor(data, chatKey);
  const today = todayKey();

  // 1. 计数
  block.daily[today] = (block.daily[today] || 0) + 1;
  block.total = (block.total || 0) + 1;
  const todayCount = block.daily[today];

  // 2. 数字运算
  block.number = applyExpression(s.expression, Number(block.number) || 0);
  saveData(data);

  try { _api?.log?.(`[poke-counter] 被戳 +1（${s.perGroup ? chatKey : '全局'}，今日 ${todayCount}，数值 ${block.number}）`); } catch {}

  // 3. 按概率 + 冷却决定是否回复
  const now = Date.now();
  const lastAt = _lastReplyAt.get(chatKey) || 0;
  const inCooldown = s.cooldownMs > 0 && (now - lastAt) < s.cooldownMs;
  const roll = Math.random();

  if (!inCooldown && roll < s.replyProbability && sender) {
    const text = buildReplyText(s.replyTexts, block.number, todayCount);
    try {
      await sender.sendTextBatch(chatKey, [text]);
      _lastReplyAt.set(chatKey, now);
    } catch (e) {
      try { _api?.warn?.('poke-counter 发送回复失败：%s', e?.message || e); } catch {}
    }
  }
}

// ── 生命周期 ────────────────────────────────────────────────────────────────
function buildWrapper() {
  // 保存已有实现（鸣潮表情插件），包装它
  _origPokeSend = typeof globalThis.wuwaEmojiPokeSend === 'function'
    ? globalThis.wuwaEmojiPokeSend
    : null;

  _myPokeWrapper = async (chatKey, sender) => {
    // 自己的统计/回复逻辑永远跑
    try { await handlePoke(chatKey, sender); } catch (e) {
      try { _api?.warn?.('poke-counter 处理戳一戳出错：%s', e?.message || e); } catch {}
    }
    // 透传给原始实现（鸣潮表情），有就调用，没有就忽略
    if (typeof _origPokeSend === 'function') {
      try { await _origPokeSend(chatKey, sender); } catch (e) {
        try { _api?.warn?.('poke-counter 透传给原 poke 处理器失败：%s', e?.message || e); } catch {}
      }
    }
  };
}

export async function setup(api) {
  _api = api;
  // 只准备包装函数，不挂全局 —— 未启用时不能改写 globalThis（会影响别的插件）。
  buildWrapper();
  try { _api?.log?.('poke-counter 已加载（等待启用后接管戳一戳）'); } catch {}
}

export function activate() {
  // 启用时才挂到全局；中途别人占过这个钩子的话，以当前实现作为透传目标。
  _origPokeSend = typeof globalThis.wuwaEmojiPokeSend === 'function'
    ? globalThis.wuwaEmojiPokeSend
    : null;
  if (!_myPokeWrapper) buildWrapper();
  globalThis.wuwaEmojiPokeSend = _myPokeWrapper;
  try { _api?.log?.('poke-counter 已启用（今日计数与数字运算已就绪）'); } catch {}
}

export function deactivate() {
  // 只在当前挂着的确实是自己的包装时才还原，避免误删别人后来挂的实现
  if (globalThis.wuwaEmojiPokeSend === _myPokeWrapper) {
    if (typeof _origPokeSend === 'function') {
      globalThis.wuwaEmojiPokeSend = _origPokeSend;
    } else {
      try { delete globalThis.wuwaEmojiPokeSend; } catch {}
    }
  }
  _myPokeWrapper = null;
  _origPokeSend = null;
  _lastReplyAt.clear();
}
