// 缓存钉定器（cache-pin）v1.0.0 —— 动作型前缀优化
//
// ── 与 cache-guard 的分工 ────────────────────────────────────────────────
//   cache-guard（前缀缓存哨兵）  纯观测：统计命中率、按小节指纹化系统提示、漂移时告警。声明"不改行为"。
//   cache-pin（本插件）          动作型：把漂移的**源头搬家**，让缓存失效点后移。
//   两者互补，可同时开：一个负责"谁在击穿缓存"，一个负责"把洞堵上"。
//
// ── 原理（前缀缓存只有一条规则）─────────────────────────────────────────
//   命中与否取决于「请求体的 token 前缀是否逐字节稳定」，且失效点是**第一个不同的字符**。
//   系统提示中段一旦出现差异（例如表情额度从 15 张变成 14 张），从那个字符开始的
//   全部后续内容（剩余系统提示 + 工具定义 + 对话历史）都算全新 token、按全价计费。
//   把易变片段替换成**稳定占位符**、原值搬到**末尾** → 失效点被推到整个提示的最尾部，
//   前面那一段（通常是 2 万 token 里的大头）重新变成可命中。
//   注意：搬的是**位置**，不是内容 —— 文字一个不丢，只是从"中段"挪到"末尾"。
//
// ── 三件事 ──────────────────────────────────────────────────────────────
//   1. 模式钉定：pinPatterns（清单默认 + 自学习）命中的片段 → 占位符 + 原值移到末尾。
//   2. 数字漂移自学习：与上一次**同会话**的稳定区逐字符比对，若差异**只发生在数字**上，
//      就把这段的"形状"（数字→\d+）学成正则、持久化，之后所有会话都自动钉它 ——
//      不需要事先知道规律。表情额度那句就是这么被自动认出来的。
//   3. 归因告警：模型/上游横跳（缓存按 (模型×上游) 隔离，一换整段归零）、
//      以及稳定区残余漂移（钉不住的差异，附原文对比，供你补进 pinPatterns）。
//
// ── 边界（重要）─────────────────────────────────────────────────────────
//   orchestrator 只把这个 hook 交给插件：{ chatKey, model, provider, sessionId, messages }。
//   所以本插件**改不了** model / provider / tools / fallbackModels / cacheWarm —— 那些只能
//   在设置里治。本插件能做的，是把它们**变化的事实**变成日志和计数，不让它静默发生。
//   （tools 在 hook 之后才定稿，见 orchestrator.js 的工具集过滤那一段。）
//
// ── 稳定性红线 ──────────────────────────────────────────────────────────
//   · 不 import 任何模块（连 fs 都不用）：状态走 api.storage，写进
//     data/plugin-data/cache-pin/storage.json，不落 plugins/ 目录（避免 fs.watch 全量重扫）。
//   · 全程 try/catch：本插件任何异常都不该影响一次真实调用。
//   · 幂等：输入里若已有上一次的末尾动态块，先剥掉再重新处理，绝不叠加。

const DEFAULTS = {
  // 总开关：关掉 = 只观测不搬运（等价于纯报告模式）
  pinning: true,
  // 搬运目的地：'system-tail' 系统提示末尾（改动最小，推荐）；'user-tail' 最后一条 user 消息末尾
  pinTarget: 'system-tail',
  // 要钉的片段（正则字符串）。默认只有一条 —— 唯一被实测确认的稳定漂移源。
  // 注：这里是数组，UI 表单不渲染数组（type: internal），要手加请用下面的 pinPatternsText。
  pinPatterns: [
    '今天的额度还剩\\s*\\d+\\s*张（这个小时还能\\s*\\d+\\s*张）'
  ],
  // 追加的钉定模式（每行一条正则，'#' 开头视为注释）—— 这是 UI 里可编辑的那个字段
  pinPatternsText: '',
  // 自动学习"只有数字在变"的片段
  autoPinNumeric: true,
  // 模型/上游横跳告警
  modelSwitchAlert: true,
  // 稳定区仍有差异（钉不住）时告警并给出原文对比
  reportStableDrift: true,
  // 超过这个长度的片段不钉（避免把整段正文搬走）
  maxPinChars: 2000,
  // 自学习形状的上限，防止无限增长
  maxLearned: 40,
  // 同一条告警的日志节流（秒）
  logThrottleSec: 600,
  // 计数落盘节流（秒）；学到新形状时会立刻落盘
  storageFlushSec: 60,
  // 是否注册一个报表工具（默认关：注册工具会改变 tools 数组形状，本身也是一次前缀变化）
  exposeTool: false
};

const PLACEHOLDER = '【动态值已移至末尾】';
const TAIL_HEADER = '\n\n【动态状态·本段可能每次变化（为保住前缀缓存已移至末尾）】\n';

let api = null;
const compiled = new Map();   // pattern 字符串 -> RegExp（编译缓存，避免每轮重编译）
const snaps = new Map();      // chatKey -> { core, at }（core = 不含末尾动态块的稳定区）
const logAt = new Map();      // 日志签名 -> 上次打日志时间戳
const stats = {
  moves: 0,          // 累计搬运片段数
  chars: 0,          // 累计搬运字符数（≈ 每轮被"救回"的前缀长度）
  learned: 0,        // 累计自学习形状数
  modelSwitches: 0,  // 累计模型/上游切换次数
  driftUnpinned: 0,  // 钉不住的残余漂移次数
  lastMoveAt: 0,
  modelHistory: []   // 最近 10 次切换
};
let learned = [];    // 自学习到的形状正则（字符串），持久化在 storage
// 归因事件环形缓冲。为什么必须落盘：插件的 console.log 走 stdio，**不进** app 的日志文件
// （实测日志文件只收核心通道：app/req-fp/cache-stat/cache-warm…），而插件又不能用 fs
// （fs 属高危模块，用了就得进 trustedPlugins）。所以 storage.json 是唯一能被看见的出口。
const alerts = [];
let lastModelKey = '';
let flushedAt = 0;

function record(type, detail) {
  alerts.unshift({ at: Date.now(), type, detail: String(detail).slice(0, 300) });
  if (alerts.length > 20) alerts.length = 20;
}

// ── 配置 / 持久化 ──────────────────────────────────────────────────────

function settings() {
  const raw = (api && typeof api.config === 'function' ? api.config() : null) || {};
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

function persist(force = false) {
  const now = Date.now();
  if (!force && now - flushedAt < settings().storageFlushSec * 1000) return;
  flushedAt = now;
  try {
    api?.storage?.set('stats', {
      ...stats,
      learned: learned.slice(),
      alerts: alerts.slice(),
      updatedAt: now
    });
  } catch (error) {
    api?.warn?.('统计落盘失败：', error?.message || error);
  }
}

function restore() {
  try {
    const saved = api?.storage?.get?.('stats', null);
    if (!saved || typeof saved !== 'object') return;
    for (const k of Object.keys(stats)) {
      if (k === 'modelHistory') continue;
      if (typeof saved[k] === 'number') stats[k] = saved[k];
    }
    if (Array.isArray(saved.modelHistory)) stats.modelHistory = saved.modelHistory.slice(0, 10);
    if (Array.isArray(saved.learned)) learned = saved.learned.filter((s) => typeof s === 'string').slice(0, DEFAULTS.maxLearned);
    if (Array.isArray(saved.alerts)) alerts.push(...saved.alerts.slice(0, 20));
  } catch { /* 存储坏了就从空开始，不能拖死扩展 */ }
}

/** 同一条告警按签名节流，避免刷屏。返回本次是否真的输出了。 */
function note(message, signature, level = 'log') {
  const now = Date.now();
  const last = logAt.get(signature) || 0;
  if (now - last < settings().logThrottleSec * 1000) return false;
  logAt.set(signature, now);
  const fn = api?.[level] || api?.log;
  if (typeof fn === 'function') fn.call(api, message);
  return true;
}

// ── 文本工具 ────────────────────────────────────────────────────────────

function reOf(source) {
  const key = String(source);
  if (compiled.has(key)) return compiled.get(key);
  let re = null;
  // 'gm'：g 用于替换全部出现处；m 让用户写的 ^ / $ 按**行**生效（逐行写模式的直觉语义），
  // 不加 m 的话 ^ 只匹配整串开头，用户配的 "^当前时间" 会静默失效。
  try { re = new RegExp(key, 'gm'); } catch { re = null; }
  compiled.set(key, re);
  return re;
}

/** 数字一律换成 #，用于判断"差异是否只在数字/日期上"。 */
function mask(s) {
  return String(s).replace(/\d/g, '#');
}

/** 把一段实际文本抽象成"形状"正则：转义元字符 → 数字变 \d+ → 空白变 \s*。 */
function shapeOf(span) {
  return String(span)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\d+/g, '\\d+')
    .replace(/\s+/g, '\\s*');
}

/** 求两个字符串的差异区间（去掉公共前缀与公共后缀）。 */
function diffSpan(a, b) {
  let i = 0;
  const max = Math.min(a.length, b.length);
  while (i < max && a[i] === b[i]) i++;
  let j = 0;
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  return { start: i, a: a.slice(i, a.length - j), b: b.slice(i, b.length - j) };
}

/**
 * 把差异区间扩成"可读的上下文窗口"（**不跨行**），作为要学习的模式。
 *
 * 为什么必须扩：差异本身常常只是 `123` → `456`，直接形状化会得到 `\d+` ——
 * 过宽的图案会把系统提示里**所有**数字都搬到末尾（等于毁掉提示词）。
 * 扩到一行内的上下文后，学到的是 `活跃度评分 \d+ 分，仅供参考。` 这种既具体
 * 又能跨次匹配的形状，也正是人手会写的那种。
 */
function windowAround(text, start, len, margin = 16) {
  const lineStart = Math.max(text.lastIndexOf('\n', start - 1) + 1, 0);
  let lineEnd = text.indexOf('\n', start + len);
  if (lineEnd < 0) lineEnd = text.length;
  const from = Math.max(lineStart, start - margin);
  const to = Math.min(lineEnd, start + len + margin);
  return text.slice(from, to);
}

/** 形状里的"实义字符"数（排除 \d+ / \s* / 转义反斜杠），用于拒绝过宽的图案。 */
function literalChars(shape) {
  return shape.replace(/\\d\+|\\s\*|\\/g, '').length;
}

function clip(s, n = 120) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** 汇总钉定模式：清单默认数组 + UI 多行文本（每行一条，# 开头为注释）。 */
function patternsOf(s) {
  const list = [];
  if (Array.isArray(s.pinPatterns)) {
    for (const x of s.pinPatterns) {
      if (typeof x === 'string' && x.trim()) list.push(x.trim());
    }
  }
  if (typeof s.pinPatternsText === 'string') {
    for (const line of s.pinPatternsText.split('\n')) {
      const t = line.trim();
      if (t && !t.startsWith('#')) list.push(t);
    }
  }
  return list;
}

/** 用当前配置 + 自学习形状跑一遍钉定，返回稳定区与命中的原值。 */
function applyPatterns(text, s) {
  const moved = [];
  let out = text;
  const sources = [
    ...patternsOf(s),
    ...learned
  ];
  for (const src of sources) {
    const re = reOf(src);
    if (!re) continue;
    out = out.replace(re, (m) => {
      if (m.length > s.maxPinChars || m.includes(PLACEHOLDER)) return m;
      moved.push(m);
      return PLACEHOLDER;
    });
  }
  return { core: out, moved };
}

// ── 归因 ────────────────────────────────────────────────────────────────

function noteModelSwitch(model, provider, chatKey) {
  const key = `${provider || '?'}|||${model || '?'}`;
  if (key === '?|||?') return;
  if (!lastModelKey) { lastModelKey = key; return; }
  if (key === lastModelKey) return;
  const from = lastModelKey;
  lastModelKey = key;
  stats.modelSwitches += 1;
  stats.modelHistory.unshift({ at: Date.now(), from, to: key, chatKey: chatKey || '' });
  stats.modelHistory = stats.modelHistory.slice(0, 10);
  record('model-switch', `${from} → ${key}（${chatKey || '?'}）`);
  persist(true);
  api?.warn?.(`⚠️ 模型/上游发生切换：${from} → ${key}`
    + `（缓存按 (模型 × 上游) 隔离，本次起该前缀整段重建、命中归零；`
    + `如需长期稳定，请在设置里把备用模型 fallbackModels 收紧到同一模型/上游）`);
}

// ── 主流程 ──────────────────────────────────────────────────────────────

/**
 * before-llm-messages：允许原地改 messages（orchestrator.js 传的是同一个数组引用）。
 */
async function beforeLlmMessages(context = {}) {
  try {
    const s = settings();
    const { messages, chatKey, model, provider } = context;

    if (s.modelSwitchAlert) noteModelSwitch(model, provider, chatKey);

    if (!s.pinning) return;
    if (!Array.isArray(messages) || !messages.length) return;

    const sys = messages.find((m) => m && m.role === 'system' && typeof m.content === 'string');
    if (!sys) return;

    const key = String(chatKey || 'unknown');
    const original = sys.content;

    // 幂等：先剥掉上一次留下的末尾动态块，再重新处理
    const headerAt = original.indexOf(TAIL_HEADER);
    const raw = headerAt >= 0 ? original.slice(0, headerAt) : original;

    // 第一遍：用已配置 / 已学到的形状钉定
    let pass = applyPatterns(raw, s);

    // 第二遍：稳定区仍在漂移，但差异只在数字上 → 学成形状并立刻重跑
    let learnedNow = null;
    if (s.autoPinNumeric) {
      const prev = snaps.get(key);
      if (prev && prev.core && prev.core !== pass.core) {
        const d = diffSpan(prev.core, pass.core);
        const changed = d.a.length > 0 || d.b.length > 0;
        if (changed && d.b.length && d.b.length <= s.maxPinChars
          && mask(d.a) === mask(d.b) && /\d/.test(d.a)) {
          // 学"差异 + 上下文窗口"，而不是差异本身：否则会学出 \d+ 这种过宽图案
          const shape = shapeOf(windowAround(pass.core, d.start, d.b.length));
          if (shape.length >= 6 && shape.length <= 300 && literalChars(shape) >= 6
            && !learned.includes(shape) && learned.length < s.maxLearned) {
            learned.push(shape);
            stats.learned += 1;
            learnedNow = shape;
            pass = applyPatterns(raw, s);   // 用新形状重跑，保证所有出现处一起钉
            record('learned', shape);
            api?.log?.(`自学习到一个易变形状（已持久化，之后自动钉定）：${shape}`);
            persist(true);
          }
        }
        // 学不了也不硬钉：把原文对比交出来，让人补进 pinPatterns
        if (s.reportStableDrift && learnedNow === null && pass.core !== prev.core) {
          const d2 = diffSpan(prev.core, pass.core);
          if (d2.a.length || d2.b.length) {
            // 记账与告警共用同一个节流：否则一个钉不住的差异会每次调用都写一次盘
            const emitted = note('⚠️ 稳定区仍有差异（钉不住，缓存会从这里开始失效）：'
              + `\n     上次：${clip(d2.a)}`
              + `\n     本次：${clip(d2.b)}`
              + '\n     若它本来就该变，把它加进 pinPatterns 即可自动搬运。',
            `drift:${mask(d2.a).slice(0, 60)}|${mask(d2.b).slice(0, 60)}`, 'warn');
            if (emitted) {
              stats.driftUnpinned += 1;
              record('drift-unpinned', `上次：${clip(d2.a)} ｜ 本次：${clip(d2.b)}`);
              persist(true);
            }
          }
        }
      }
    }

    const moved = [...new Set(pass.moved.map((m) => m.trim()).filter(Boolean))];
    if (moved.length) {
      const tail = moved.map((m) => `- ${m}`).join('\n');
      const block = `${TAIL_HEADER}${tail}`;
      if (s.pinTarget === 'user-tail') {
        const lastUser = [...messages].reverse().find((m) => m && m.role === 'user' && typeof m.content === 'string');
        if (lastUser) lastUser.content += block;
        else sys.content = pass.core + block;
      } else {
        sys.content = pass.core + block;
      }
      stats.moves += moved.length;
      stats.chars += moved.reduce((n, m) => n + m.length, 0);
      stats.lastMoveAt = Date.now();
      persist();
    }

    // 这一轮的稳定区留作下次比对的基线
    snaps.set(key, { core: pass.core, at: Date.now() });
    if (snaps.size > 24) snaps.delete(snaps.keys().next().value);   // 简单上限，防内存增长
  } catch (error) {
    api?.warn?.('处理失败（已跳过，不影响本次调用）：', error?.message || error);
  }
}

// ── 生命周期 ────────────────────────────────────────────────────────────

export function setup(a) {
  api = a;
  restore();
}

export function activate() {
  const s = settings();
  api?.log?.(`缓存钉定器已启用：pinning=${s.pinning} target=${s.pinTarget}`
    + ` 模式=${patternsOf(s).length}条 自学习=${learned.length}条`
    + ` autoPinNumeric=${s.autoPinNumeric} steps=${stats.moves}`);

  if (!s.exposeTool) return;
  try {
    api?.registerTool?.({
      id: 'report',
      name: '缓存钉定报表',
      description: '查看缓存钉定器累计搬运了多少易变片段、自学习到哪些形状、模型/上游切换过几次。',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: async () => JSON.stringify({
        stats,
        learned,
        pinPatterns: settings().pinPatterns
      }, null, 2)
    });
  } catch (error) {
    api?.warn?.('报表工具注册失败：', error?.message || error);
  }
}

export function available() {
  return true;
}

export const hooks = {
  'before-llm-messages': beforeLlmMessages
};
