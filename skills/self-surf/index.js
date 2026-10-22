// self-surf —— 机器人自己上网（确定性型插件，放 plugins/）
//
// ── 需求原话 ──────────────────────────────────────────────────────────────
//   「让机器人自己上网到处跑」「她可以凭自己的想法上网」
//
// ── 判定：为什么是「插件」而不是「技能」──────────────────────────────────
// 三问（规则能写死 → 插件；要理解人话 → 技能）：
//   ① 规则能写死吗？能。什么时候醒（定时间隔）、醒几轮、看几页，全是机械规则。
//   ② 要不要理解人话？要 —— 但这件事**在本插件内部自己起一次模型调用来解决**
//      （见 decideTopic / writePost），不需要把触发权交给外层对话。
//   ③ 何时执行由谁定？**必须由核心定时必然执行**。这正是技能做不到的地方：
//      技能只注册工具进模型的函数列表，而模型只有在"群里有人说话、轮到它思考"
//      时才会想起调用 —— 群聊安静时它永远不会动。而需求恰恰是"没人理它的时候
//      它自己想上网"。所以只能是插件：activate() 起定时器，核心管开关。
// 结论：plugins/。它靠 activate/deactivate/定时器 + 一个工具（被点名时立刻跑一轮）
// 工作，起模型调用与发送都走项目内部现成的通道（与 qukan 同款做法）。
//
// ── 一轮里它做了什么（这才是"自己想上网"）────────────────────────────────
//   ① 翻最近的群聊记录 → 起一次模型调用，让**它自己**挑一个值得深挖的话题，
//      连同搜索关键词一起给出来（话题必须来自群友真聊过的内容，不是凭空瞎逛）
//   ② 拿关键词去搜（核心自带的 Bing 搜索），挑 2~3 个**不同域名**的结果页
//   ③ 抓这些页面的正文（剥掉脚本/样式/标签），交给模型
//   ④ 再起一次模型调用，让它写成一条**像群友说话**的短消息（带来源链接），
//      不确定的地方必须说不确定 —— 宁可说"没查明白"，也不许硬编
//   ⑤ 通过 OneBot HTTP 发到指定会话（默认私聊发给主人）
//
// ── 为什么不去用现成的 qukan 插件 ──────────────────────────────────────────
// qukan 是"刷 B 站找一条视频分享"，它的内容源固定是 B 站榜单/搜索 API；
// 本插件是"自己去万维网上翻资料"，会真的抓网页正文。两者内容源不重叠，
// 且各有独立开关，想关哪个关哪个。若你只想留一个，关掉对应的即可。
//
// ── 安全边界（都写在代码里，不靠提示词自觉）──────────────────────────────
//   · 发送目标只认「设置里填的那个会话」，不接受来自网页/模型的任意目标
//   · 抓取前用核心的 validateFetchUrl 校验（挡住内网/本机地址，防 SSRF）
//   · 域名黑名单：命中的域名整页跳过（内容与抓取都跳过）
//   · 单轮有时间上限与页数上限；一轮没跑完不允许再起一轮（running 闸）
//   · 抓不到任何正文时**不发**"内容"，只发一句诚实的"这轮没查到东西"
//
// ── 落盘的坑（都按宿主真实行为处理）────────────────────────────────────────
//   · 核心**没有发送能力**给扩展，发送只能走 OneBot HTTP 直连（qukan 踩过，
//     注释原文："核心没有发送能力，这是本机唯一可用的通道"）
//   · api.log() 只落控制台、不落盘（主日志只记 logger 自己的事件），所以这里
//     额外调 src/logger.js 双写，否则出问题时在 data/logs 里一条线索都没有
//   · 定时器必须在 deactivate 里清掉，否则"开关关了但定时器还在"（加载器明确
//     按这个语义设计了生命周期，插件必须配合）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { profiledChatKeys } from '../../src/chat-profiles.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..', '..');
// ⚠️ DATA_DIR 会被 QQ_AGENT_DATA_DIR / QQ_AGENT_PROFILE 重定向，不能按目录硬推
const DATA_DIR = process.env.QQ_AGENT_DATA_DIR || path.join(APP_ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'self-surf.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DEFAULTS = {
  enabled: true,
  targetChat: '',            // 空 = 用主人 QQ（从 config 里找）；形如 123 或 group:123
  minMinutes: 120,           // 醒来间隔下限
  maxMinutes: 300,           // 上限（区间内随机，别像定时任务）
  quietHours: '0-7',         // 静默时段（这段时间内不打扰）
  maxPages: 3,               // 一轮最多抓几个页面
  maxChars: 6000,            // 单页正文最多取多少字喂给模型
  maxTurns: 4,               // 一轮最多换几个关键词重搜
  includeSources: true,      // 消息结尾附上来源链接
  domainBlock: '',           // 域名黑名单，逗号分隔（命中整页跳过）
  dryRun: false              // 只演练：不发出去，只写日志（调试用）
};

let api = null;
let log = () => {};
let warn = () => {};
let timer = null;
let running = false;
let lastRunAt = 0;
let lastResult = null;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(n) || lo)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settings = () => ({ ...DEFAULTS, ...(api?.config?.() || {}) });

/* ── 双写日志：api.log 不落盘，必须额外走 logger ─────────────────────────── */

function setupLogging() {
  const write = (level, ...a) => {
    const msg = a.map((x) => (typeof x === 'string' ? x : (() => {
      try { return JSON.stringify(x); } catch { return String(x); }
    })())).join(' ');
    try { if (level === 'warn') api.warn(...a); else api.log(...a); } catch { /* ignore */ }
    try {
      import('../../src/logger.js').then((m) => {
        try { if (level === 'warn') m.logger.warn('self-surf', msg); else m.logger.info('self-surf', msg); } catch { /* ignore */ }
      }).catch(() => {});
    } catch { /* ignore */ }
  };
  log = (...a) => write('info', ...a);
  warn = (...a) => write('warn', ...a);
}

/* ── 状态落盘（只记"上次什么时候跑的、跑了什么"，用于跨重启不过度打扰）──── */

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function loadState() {
  const raw = readJson(STATE_FILE, null);
  lastRunAt = Number(raw?.lastRunAt) || 0;
  lastResult = raw?.lastResult || null;
  return { lastRunAt, lastResult };
}

function saveState(patch = {}) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const next = {
      lastRunAt: patch.lastRunAt ?? lastRunAt,
      lastResult: patch.lastResult ?? lastResult,
      updatedAt: Date.now()
    };
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) { warn(`状态写入失败：${e?.message ?? e}`); }
}

/* ── 取配置与发送通道（照 qukan 的成熟做法：探活后再发）────────────────── */

async function coreConfig() {
  try {
    const m = await import('../../src/config.js');
    return (typeof m.getConfig === 'function' ? m.getConfig() : null) || null;
  } catch { return null; }
}

/** 发送地址候选：程序配置优先，其次 snowluma 的 onebot_*.json，最后默认端口。 */
function endpointCandidates(cfg) {
  const out = [];
  const snow = cfg?.snowluma || {};
  const base = String(snow.httpUrl || '').replace(/\/+$/, '');
  const token = String(snow.httpAccessToken || snow.accessToken || '');
  if (base) out.push({ base, token, from: '程序配置' });
  try {
    const dirs = [
      path.join(APP_ROOT, 'snowluma', 'config'),
      path.join(APP_ROOT, 'resources', 'snowluma', 'config'),
      path.join(APP_ROOT, '..', 'snowluma', 'config')
    ];
    for (const dir of dirs) {
      if (!dir || !fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!/^onebot_.*\.json$/i.test(f)) continue;
        const j = readJson(path.join(dir, f), null);
        const hs = j?.networks?.httpServers || [];
        const ws = j?.networks?.wsServers || [];
        const port = Number(hs[0]?.port || 3000);
        const tk = String(hs[0]?.accessToken || ws[0]?.accessToken || '');
        if (tk) out.push({ base: `http://${hs[0]?.host || '127.0.0.1'}:${port}`, token: tk, from: 'snowluma' });
      }
    }
  } catch { /* 读不到就走默认端口 */ }
  if (!out.length) out.push({ base: 'http://127.0.0.1:3000', token: '', from: '默认端口' });
  const seen = new Set();
  return out.filter((x) => {
    const k = `${x.base}|${x.token}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 探活：get_status 需要认证，正好当探针。 */
async function pickEndpoint(cfg) {
  const tries = endpointCandidates(cfg);
  for (const t of tries) {
    try {
      const res = await fetch(`${t.base}/get_status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(t.token ? { authorization: `Bearer ${t.token}` } : {}) },
        body: '{}',
        signal: AbortSignal.timeout(8000)
      });
      if (res.ok) return t;
    } catch { /* 换下一个 */ }
  }
  return null;
}

const escapeCq = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/\[/g, '&#91;').replace(/\]/g, '&#93;');

/**
 * 发一条消息到指定会话。
 * @param {string} target 形如 "123"（私聊）或 "group:123"（群）
 */
async function sendTo(target, text, cfg) {
  const t = String(target || '').trim();
  if (!t) throw new Error('没有设置发送目标');
  const isGroup = /^group:/i.test(t);
  const id = t.replace(/^(group|private):/i, '').replace(/\D/g, '');
  if (!/^\d{5,12}$/.test(id)) throw new Error(`发送目标不合法：${target}`);

  const ep = await pickEndpoint(cfg);
  if (!ep) throw new Error('找不到可用的 OneBot 发送地址（协议端没起来？）');
  const action = isGroup ? 'send_group_msg' : 'send_private_msg';
  const payload = isGroup
    ? { group_id: Number(id), message: [{ type: 'text', data: { text: escapeCq(text) } }] }
    : { user_id: Number(id), message: [{ type: 'text', data: { text: escapeCq(text) } }] };

  const res = await fetch(`${ep.base}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(ep.token ? { authorization: `Bearer ${ep.token}` } : {}) },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60000)
  });
  if (!res.ok) {
    if (res.status === 401) throw new Error(`OneBot 401（令牌没被接受，来源：${ep.from}）`);
    throw new Error(`OneBot HTTP ${res.status}`);
  }
  const j = await res.json().catch(() => null);
  if (j && j.status === 'failed') throw new Error(`协议端拒绝：${j.message || j.wording || '未知'}`);
  return { ok: true, via: ep.from, group: isGroup };
}

/** 从配置里推默认目标：优先主人 QQ，其次白名单里的私聊。 */
function defaultTarget(cfg) {
  const s = settings();
  if (s.targetChat) return String(s.targetChat);
  const owners = cfg?.owner ?? cfg?.owners ?? cfg?.admin ?? null;
  const list = Array.isArray(owners) ? owners : (owners ? [owners] : []);
  const ownerQq = String(list[0] || cfg?.onebot?.selfId || '').replace(/\D/g, '');
  if (/^\d{5,12}$/.test(ownerQq) && ownerQq !== String(cfg?.onebot?.selfId || '')) return ownerQq;
  // 2026-10-21：旧 allow.private 已迁入 chatProfiles，取第一个单独添加的私聊
  const priv = profiledChatKeys()
    .filter((k) => String(k).startsWith('private:'))
    .map((k) => String(k).slice('private:'.length));
  if (priv.length) return `private:${String(priv[0]).replace(/\D/g, '')}`;
  return '';
}

/* ── 模型调用（与 qukan 同款：走核心 llm.chatCompletion）──────────────────── */

async function callLLM({ system, user, maxTokens = 700, temperature = 0.8, context = {} }) {
  const llm = await import('../../src/llm.js');
  const res = await llm.chatCompletion({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature,
    maxTokens,
    skillContext: { thinkingMode: 'off', ...context }
  });
  const raw = res?.message?.content;
  return Array.isArray(raw) ? raw.map((x) => x?.text ?? '').join('') : String(raw ?? '');
}

/** 网络类错误才重试；鉴权/额度错误直接抛（重试只是白等）。 */
async function callLLMRetry(args, tries = 3) {
  let last = null;
  for (let i = 0; i < tries; i += 1) {
    if (i > 0) await sleep(1200 * i);
    try { return await callLLM(args); } catch (e) {
      last = e;
      const m = String(e?.message ?? e);
      if (/401|403|invalid|unauthor|api key|鉴权|无效|quota|余额|额度|insufficient/i.test(m)) break;
    }
  }
  throw last;
}

/* ── 网页正文提取（纯函数，便于自测）────────────────────────────────────── */

const ENTITIES = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'",
  '&mdash;': '—', '&ndash;': '–', '&hellip;': '…', '&middot;': '·', '&times;': '×'
};

/** HTML → 可读文本：去掉脚本/样式/注释，块级标签转换行，压缩空白，解常见实体。 */
export function htmlToText(html, maxChars = 6000) {
  let s = String(html ?? '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|svg|iframe|head)[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<(br|hr)\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|td)>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '\n· ');
  s = s.replace(/<[^>]+>/g, ' ');
  for (const [k, v] of Object.entries(ENTITIES)) s = s.split(k).join(v);
  s = s.replace(/&#(\d+);/g, (_, d) => {
    const n = Number(d);
    return Number.isFinite(n) && n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : ' ';
  });
  s = s.replace(/[ \t\u00a0]+/g, ' ');
  s = s.replace(/\n{3 }/g, '\n\n');
  s = s.split('\n').map((l) => l.trim()).join('\n').trim();
  return s.length > maxChars ? `${s.slice(0, maxChars)}…` : s;
}

/** 域名黑名单：命中返回 true（整页跳过）。 */
export function blockedByDomain(url, blockList) {
  const list = String(blockList || '').split(/[,，;；\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return false;
  let host = '';
  try { host = new URL(String(url)).hostname.toLowerCase(); } catch { return false; }
  return list.some((d) => host === d || host.endsWith(`.${d}`));
}

/** 抓一个页面并抽出正文。走核心的 validateFetchUrl 校验（挡内网地址）。 */
async function fetchPageText(url, { timeoutMs = 15000, maxChars = 6000 } = {}) {
  const sf = await import('../../src/safe-fetch.js');
  await sf.validateFetchUrl(url, {});                 // 抛错 = 内网/非法地址，直接放弃这一页
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'accept-language': 'zh-CN,zh;q=0.9' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = String(res.headers.get('content-type') || '');
  if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) throw new Error(`不是网页（${type || '未知类型'}）`);
  const html = await res.text();
  return htmlToText(html, maxChars);
}

/* ── 让「它自己」决定查什么 ──────────────────────────────────────────────── */

/**
 * 从最近的群聊记录里挑一个它自己感兴趣、又确实有信息量的话题。
 * 返回 { topic, query, why } —— 拿不到就返回 null（这一轮就不发）。
 */
export async function decideTopic(recentLines, settingsNow = {}) {
  const text = (Array.isArray(recentLines) ? recentLines : []).join('\n').slice(-4000);
  if (!text.trim()) return null;
  const system = '你是一个中文 QQ 群里的机器人，性格好奇、爱较真、说话像群友。'
    + '现在没人跟你说话，你自己想上网看点东西。'
    + '请从下面这段最近群聊里，挑一个**你自己想弄明白**的话题去查。'
    + '要求：'
    + '① 必须跟群友真聊过的内容有关（人名/游戏/番剧/事件/某个说法都行），不要凭空乱逛；'
    + '② 必须是"查一下能得到信息"的东西（某个东西是什么、某件事进展如何、某个说法的来龙去脉），'
    + '不要选纯情绪或私事；'
    + '③ 搜索关键词要能真的搜到东西：如果是动画/游戏/日本相关的内容，优先给日文原名关键词；'
    + '④ 只输出一个 JSON，不要任何解释、不要代码块围栏。'
    + '格式：{"topic":"一句话说明你想弄明白什么","query":"搜索关键词","why":"为什么想查它（一句话）"}'
    + '如果这段聊天里实在没有值得查的东西，就输出 {"topic":"","query":"","why":""}。';
  const out = await callLLMRetry({ system, user: `最近的群聊：\n${text}`, maxTokens: 400, temperature: 0.9 });
  return parseTopicJson(out);
}

/** 从模型输出里抠出 {topic,query,why}；解析不出来返回 null。 */
export function parseTopicJson(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const candidates = [s];
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1]);
  const brace = s.match(/\{[\s\S]*\}/);
  if (brace) candidates.push(brace[0]);
  for (const c of candidates) {
    try {
      const j = JSON.parse(c);
      const topic = String(j?.topic ?? '').trim();
      const query = String(j?.query ?? '').trim();
      if (!topic || !query) return null;
      return { topic, query, why: String(j?.why ?? '').trim() };
    } catch { /* 试下一个 */ }
  }
  return null;
}

/** 把查到的资料写成像群友说话的短消息（不许硬编，不确定要说不确定）。 */
export async function writePost(topic, sources, settingsNow = {}) {
  const body = sources.map((s, i) => `【资料${i + 1}】${s.title}\n${s.url}\n${s.text}`).join('\n\n---\n\n');
  const system = '你是一个中文 QQ 群里的机器人，现在自己上网查了点东西，想跟群友说一声。'
    + '要求：'
    + '① 说人话：像群友分享见闻，不要写报告、不要用"首先/其次/综上所述"、不要列一堆小标题；'
    + '② 长度控制在 120~320 字，只讲最有意思、最有信息量的那几点，不要复述所有细节；'
    + '③ **只根据给你的资料说**。资料里没有的、或者你拿不准的，必须明说"这个我没查明白"或'
    + '"资料里没写"，**绝对不许自己编**；'
    + '④ 不要提"资料1/资料2""网页""搜索""接口""模型"这类字眼，就当是你自己看到的；'
    + '⑤ 不要向群友复述内部细节（域名、抓取过程、超时等）。'
    + '直接输出要发的那段话本身，不要任何前后缀、不要引号。';
  const user = `你想弄明白的是：${topic}\n\n查到的资料：\n${body}`;
  const text = await callLLMRetry({ system, user, maxTokens: 900, temperature: 0.85 });
  return String(text ?? '').trim();
}

/* ── 静默时段 ─────────────────────────────────────────────────────────────── */

export function inQuietHours(rangeStr, now = new Date()) {
  const m = String(rangeStr || '').match(/^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/);
  if (!m) return false;
  const from = Number(m[1]) % 24;
  const to = Number(m[2]) % 24;
  const h = now.getHours();
  if (from === to) return false;
  return from < to ? (h >= from && h < to) : (h >= from || h < to);
}

/** 下一次唤醒延迟：区间内随机，落在静默时段就推到静默结束。 */
export function nextDelayMs(s, now = new Date()) {
  const lo = clamp(Number(s.minMinutes) || DEFAULTS.minMinutes, 5, 24 * 60);
  const hi = Math.max(lo, clamp(Number(s.maxMinutes) || DEFAULTS.maxMinutes, 5, 24 * 60));
  const base = (lo + Math.floor(Math.random() * (hi - lo + 1))) * 60 * 1000;
  const at = new Date(now.getTime() + base);
  if (!inQuietHours(s.quietHours, at)) return base;
  const mm = String(s.quietHours || '').match(/^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/);
  const to = mm ? Number(mm[2]) % 24 : 7;
  const end = new Date(at);
  end.setHours(to, 0, 0, 0);
  if (end <= at) end.setDate(end.getDate() + 1);
  return end.getTime() - now.getTime() + Math.floor(Math.random() * 15 * 60 * 1000);
}

/* ── 从会话存档里取最近的聊天（决定话题的原料）──────────────────────────── */

async function recentChatLines(limit = 60) {
  try {
    const cfg = await coreConfig();
    const m = await import('../../src/store.js');
    // ⚠️ ChatStore 是 class，必须 new —— store.js 里**没有** createStore 工厂函数
    const store = new m.ChatStore(cfg?.store?.maxMessagesPerChat ?? 0);
    // 优先主人所在的会话（第一个单独添加的群，其次第一个私聊；均来自 chatProfiles）
    const keys = profiledChatKeys();
    const chatKey = keys.find((k) => String(k).startsWith('group:'))
      || keys.find((k) => String(k).startsWith('private:'))
      || '';
    if (!chatKey) return { lines: [], chatKey: '' };
    const recent = typeof store.recent === 'function' ? store.recent(chatKey, { limit }) : [];
    const lines = (Array.isArray(recent) ? recent : [])
      .slice(-limit)
      .map((e) => `${e?.senderName || e?.senderId || '某人'}：${String(e?.text || '').replace(/\s+/g, ' ').slice(0, 120)}`)
      .filter((x) => x.length > 4);
    return { lines, chatKey };
  } catch (e) {
    warn(`读会话存档失败：${e?.message ?? e}`);
    return { lines: [], chatKey: '' };
  }
}

/* ── 一轮完整流程 ─────────────────────────────────────────────────────────── */

async function runCycle({ dry = false, manual = false, reason = 'timer' } = {}) {
  if (running) return { ok: false, error: '上一轮还在跑' };
  running = true;
  const s = settings();
  const notes = [];
  try {
    if (!s.enabled && !manual) return { ok: false, error: '插件是关着的' };
    const cfg = await coreConfig();
    const target = defaultTarget(cfg);
    if (!target) return { ok: false, error: '没有可用的发送目标：请在设置里填「发给谁」（或先配好私聊白名单）' };

    // ① 决定查什么
    const { lines, chatKey } = await recentChatLines();
    if (!lines.length) return { ok: false, error: `最近的聊天记录读不到内容（会话 ${chatKey || '未知'}），这轮先不动` };
    const topic = await decideTopic(lines, s);
    if (!topic) { log('这轮没挑出值得查的话题，跳过'); return { ok: true, skipped: true, reason: '没有值得查的话题' }; }
    log(`自己想查：「${topic.topic}」（关键词 ${topic.query}）—— ${topic.why}`);

    // ② 搜索
    // ⚠️ 返回形状是 { query, results }，而且**没结果时是抛错**而不是返回空数组
    //    （见 web-search.js 的 bingSearch）—— 所以必须 try 包住、不能直接当数组用。
    //    用 webSearch() 而不是 bingSearch()：它会按用户配置的搜索服务走
    //    （bing / deepseek / 智谱 / 自定义…），以后换服务这里不用改。
    const ws = await import('../../src/web-search.js');
    const found = [];
    const searchErrors = [];
    for (let turn = 0; turn < clamp(Number(s.maxTurns) || DEFAULTS.maxTurns, 1, 6); turn += 1) {
      const q = turn === 0 ? topic.query : `${topic.query} ${topic.topic}`.slice(0, 60);
      try {
        const r = await ws.webSearch(q);
        const list = Array.isArray(r?.results) ? r.results : (Array.isArray(r) ? r : []);
        for (const x of list) {
          const url = String(x?.url || x?.link || '');
          if (!/^https?:\/\//i.test(url)) continue;
          if (found.some((f) => f.url === url)) continue;
          found.push({ url, title: String(x?.title || ''), snippet: String(x?.snippet || x?.summary || '') });
        }
      } catch (e) {
        searchErrors.push(`${q}：${e?.message ?? e}`);
      }
      if (found.length >= 6) break;                       // 够挑了，别把请求数堆上去
    }
    const links = found.filter((r) => !blockedByDomain(r.url, s.domainBlock));
    if (!links.length) {
      notes.push(searchErrors[0] || '搜索没返回可用链接');
      const msg = `我刚才想查一下「${topic.topic}」，但没搜到能看的东西，回头再试试。`;
      if (!dry && !s.dryRun) await sendTo(target, msg, cfg);
      saveState({ lastRunAt: Date.now(), lastResult: { topic: topic.topic, sent: !dry && !s.dryRun, ok: false, note: '无搜索结果' } });
      return { ok: true, sent: false, notes, message: msg };
    }

    // ③ 抓正文（不同域名优先，页数与时间都有上限）
    const maxPages = clamp(Number(s.maxPages) || DEFAULTS.maxPages, 1, 5);
    const seenHost = new Set();
    const sources = [];
    const errors = [];
    for (const l of links) {
      if (sources.length >= maxPages) break;
      let host = '';
      try { host = new URL(l.url).hostname; } catch { continue; }
      if (seenHost.has(host)) continue;                 // 每个域名只取一页，避免同一站刷屏
      seenHost.add(host);
      try {
        const text = await fetchPageText(l.url, { maxChars: clamp(Number(s.maxChars) || DEFAULTS.maxChars, 800, 20000) });
        if (text.length < 200) { errors.push(`${host}：正文太短`); continue; }
        sources.push({ url: l.url, title: l.title || host, text });
      } catch (e) {
        errors.push(`${host}：${e?.message ?? e}`);
      }
    }
    if (errors.length) log(`抓取失败/跳过：${errors.slice(0, 4).join('；')}`);
    if (!sources.length) {
      const msg = `我刚才想查一下「${topic.topic}」，但那几个页面都没打开，没看成。`;
      if (!dry && !s.dryRun) await sendTo(target, msg, cfg);
      saveState({ lastRunAt: Date.now(), lastResult: { topic: topic.topic, sent: false, ok: false, note: '页面都没抓到' } });
      return { ok: true, sent: false, notes: errors, message: msg };
    }

    // ④ 写成人话
    let post = await writePost(topic.topic, sources, s);
    if (!post) post = `我刚才去查了「${topic.topic}」，但没整理出什么有用的东西。`;
    if (s.includeSources !== false) {
      const uniq = [...new Set(sources.map((x) => x.url))].slice(0, 3);
      post = `${post}\n\n${uniq.join('\n')}`;
    }

    // ⑤ 发送（dry / dryRun 时不发）
    const willSend = !dry && !s.dryRun;
    if (willSend) await sendTo(target, post, cfg);
    log(`本轮${willSend ? '已发送' : '（演练，未发送）'}：话题「${topic.topic}」，用了 ${sources.length} 个页面`);
    saveState({
      lastRunAt: Date.now(),
      lastResult: { topic: topic.topic, query: topic.query, sent: willSend, ok: true, pages: sources.map((x) => x.url), at: Date.now() }
    });
    return { ok: true, sent: willSend, topic: topic.topic, pages: sources.length, message: post, notes };
  } catch (e) {
    const msg = `自己上网这轮失败了：${e?.message ?? e}`;
    warn(msg);
    return { ok: false, error: String(e?.message ?? e) };
  } finally {
    running = false;
  }
}

/* ── 定时器 ───────────────────────────────────────────────────────────────── */

function scheduleNext() {
  if (timer) { clearTimeout(timer); timer = null; }
  const s = settings();
  if (!s.enabled) return;
  const delay = nextDelayMs(s);
  const at = new Date(Date.now() + delay);
  log(`下次自己上网：${Math.round(delay / 60000)} 分钟后（约 ${at.toLocaleTimeString('zh-CN', { hour12: false })}）`);
  timer = setTimeout(async () => {
    timer = null;
    try {
      if (!inQuietHours(settings().quietHours)) await runCycle({ reason: 'timer' });
      else log('现在是静默时段，跳过这轮');
    } catch (e) {
      warn(`定时这轮出错：${e?.message ?? e}`);
    } finally {
      scheduleNext();
    }
  }, delay);
  if (typeof timer.unref === 'function') timer.unref();
}

/* ── 生命周期与工具 ───────────────────────────────────────────────────────── */

export function setup(hostApi) {
  api = hostApi;
  setupLogging();
  loadState();

  hostApi.registerTool({
    id: 'surf_now',
    name: '现在自己上网看点东西',
    category: 'web',
    icon: '🌐',
    description: '让机器人**立刻**自己上网逛一圈：从最近的群聊里挑一个它想弄明白的话题，去搜、去翻几个网页，'
      + '然后把结果说给群友。用在：群友说「你自己去查查」「你自己看着办」「随便找点东西讲讲」「你不是能上网吗」这类时候。\n'
      + '它会把结果**直接发到会话里**，所以调用之后你只需要配一句短话，**不要**复述它查了什么细节、也不要编造它查到的东西。'
      + '如果返回里说没查到，就如实说一句没查到。',
    parameters: {
      type: 'object',
      properties: {
        dry: { type: 'boolean', description: 'true = 只演练：查到什么就回报什么，但不真的发消息（群友说「先看看你会发什么」时用）' }
      }
    },
    async execute(_ctx, args) {
      const r = await runCycle({ dry: !!args?.dry, manual: true, reason: 'tool' });
      if (!r.ok) return { content: `这轮没跑成：${r.error}`, isError: true };
      if (r.skipped) return { content: `这轮没找到值得查的东西（${r.reason}），什么都没发。` };
      if (r.sent === false && r.message) {
        return { content: `（演练模式，没有真的发出去）本来会发这条：\n${r.message}` };
      }
      return {
        content: `已经自己上网查过「${r.topic}」并把结果发到会话里了（翻了 ${r.pages} 个页面）。\n`
          + '配一句短话就行，**不要**复述查到的内容细节，也不要补充你没查过的东西。'
      };
    }
  });

  hostApi.registerTool({
    id: 'surf_status',
    name: '看自己上网的排班',
    category: 'web',
    icon: '🕒',
    description: '查看机器人"自己上网"的当前状态：开没开、下次大概什么时候醒、上一轮查了什么。群友问「你多久自己上一次网」「你上次看了啥」时用它。',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const s = settings();
      const parts = [
        `状态：${s.enabled ? '开着' : '关着'}`,
        `间隔：${s.minMinutes}~${s.maxMinutes} 分钟随机`,
        `静默时段：${s.quietHours || '无'}`,
        `一次最多看：${s.maxPages} 个页面`,
        `上次跑：${lastRunAt ? new Date(lastRunAt).toLocaleString('zh-CN', { hour12: false }) : '还没跑过'}`
      ];
      if (lastResult?.topic) parts.push(`上次查的：${lastResult.topic}（${lastResult.sent ? '发出去了' : '没发出去'}）`);
      return { content: `${parts.join('\n')}\n（不要向群友复述这些内部设置细节，用一两句人话概括就行。）` };
    }
  });

  scheduleNext();
  log(`自己上网已加载（间隔 ${settings().minMinutes}~${settings().maxMinutes} 分钟，静默 ${settings().quietHours || '无'}）`);
}

export function activate() {
  // 开关被重新打开时，重新排班（避免"关掉再打开后定时器不再启动"）
  if (api) {
    log('已被启用，重新排班');
    scheduleNext();
  }
}

export function deactivate() {
  // 必须清掉定时器：否则"开关关了但定时器还在"（加载器明确按这个语义设计生命周期）
  if (timer) { clearTimeout(timer); timer = null; }
  running = false;
  log('已被关闭，定时器已清除');
}

export function available() {
  return { ok: true };
}

/* ── 给自检脚本用的内部出口（不影响运行）────────────────────────────────── */
export const internals = {
  settings, runCycle, decideTopic, writePost, parseTopicJson,
  htmlToText, blockedByDomain, fetchPageText, inQuietHours, nextDelayMs,
  endpointCandidates, defaultTarget, recentChatLines,
  __setApi: (a) => { api = a; },
  __state: () => ({ lastRunAt, lastResult, running, hasTimer: !!timer })
};
