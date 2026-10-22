// 心情表情（meme-mood）—— 让机器人按自己的心情，从**自己的收藏**里挑一张发出去
//
// ── 为什么是技能（skills/，LLM 型），不是插件 ────────────────────────────────
//   判据（README「扩展」一节）：规则能不能写死 —— 规则写死、满足条件必然执行 → 插件；
//   要理解人话、该不该做由模型判断 → 技能。
//   "我这句吐槽该不该配一张、配哪一张"没有任何写死的规则可依据，只能她自己判断，
//   所以定成技能：发不发、发哪张由模型通过 registerTool 注册的工具自己决定。
//   本文件里那段确定性钩子只负责两件事：① 把"你现在还有额度、可以配图"递到她眼前；
//   ② 记账与限频（防止刷屏）。决定权始终在她 —— 这正是技能与插件的分界。
//
// ── 它和 meme-taste / whale-memes 的分工 ───────────────────────────────────
//   meme-taste    ：收藏。按她的口味把群里的图收进私人收藏夹（data/stickers.json）。
//   whale-memes   ：外链图库（aigengtu.com）里挑一张贴语气的图，跟她的收藏无关。
//   meme-mood（本文件）：**发表情**。从她**自己收来的**收藏里，按此刻的心情/语气
//                   挑一张发出去（GIF 动图原样发，QQ 里会自己动）。
//   三者共用同一个出口：核心的 send_sticker 工具（见 src/tools.js）。
//   另外全局的 sticker-send-as-emoji 插件会让发出去的图以"表情"渲染而不是大图。
//
// ── 频率由用户说了算 ──────────────────────────────────────────────────────
//   核心的 data/config.json 里 sticker.encourage（0~3 档）是全局软引导，管的是
//   "整体语气上多爱发表情"。本技能另有一套**硬额度**，写在自己的配置里（本页设置）：
//     每会话每小时几张 / 每会话每天几张 / 全部会话每小时加起来几张 / 同一张冷却多久
//   硬额度到了就是发不出去（工具会如实拒绝，不留一个"假装发了"的幻觉）。
//   想调频率 → 直接改这一页的数字，改完立即生效，不用重启。
//
// 注意（照 src/plugin-loader.js 的规矩）：
//   - 工具必须在 setup() 执行期间注册，写在别的函数里等于静默失效；
//   - 钩子与 promptSections 必须模块顶层 export，api 上没有注册钩子的方法；
//   - 数据一律落在 DATA_DIR/meme-mood/ 下，绝不能用 process.cwd() 当锚点；
//   - 技能 API 上**没有** tools 这个键（2026-09 的坑）：要核心工具只能问
//     src/tool-registry.js（下面的 shimCore / shimCoreAll 就是干这个的）。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';
import { getSkillConfig } from '../../src/skills/config.js';
import { getTool, getToolAvailability } from '../../src/tool-registry.js';

const SKILL_ID = 'meme-mood';
const PREFIX = `${SKILL_ID}__`;

/** 与 skill.json 的 settings 保持一致（这里留一份是为了加载顺序和容错）。 */
const DEFAULTS = {
  enabled: true,
  sending: true,
  perChatPerHour: 4,
  perChatPerDay: 15,
  globalPerHour: 30,
  minGapMin: 3,
  repeatCooldownMin: 180,
  hint: true
};

const DIR = path.join(DATA_DIR, SKILL_ID);
const STATE_FILE = path.join(DIR, 'state.json');

/** 注入到她"这一轮要想的东西"末尾的配图机会提示。 */
const HINT_HEAD = '【心情表情·配图机会】';
const HINT_TAIL = '- 想发就调 `meme-mood__send_by_mood`（就是上面这个完整名字；mood 填一个贴此刻语气的词，note 写一句你为什么挑这张）。不想发就照常说话 —— 这一轮不发图是完全正常的。';

const host = { api: null };
let log = () => {};
let warn = () => {};

// ─────────────────────────────────────────────── 小工具
function nowTs() {
  return Date.now();
}

function clamp(n, lo, hi, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, v));
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clean(s, max = 200) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function shortText(s, max = 40) {
  const t = clean(s, max + 20);
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    warn(`state.json 写盘失败：${e && e.message ? e.message : e}`);
    return false;
  }
}

// ─────────────────────────────────────────────── 配置
function cfg() {
  try {
    const merged = { ...DEFAULTS, ...(getSkillConfig(SKILL_ID, DEFAULTS) || {}) };
    // 离线自测用的覆写口：设置 DSH_MEME_MOOD_CFG='{"sending":false}' 可以临时改配置，
    // 不改磁盘上的 config.json。平时这个变量不存在，等于没有。
    const rawOverride = process.env.DSH_MEME_MOOD_CFG;
    if (rawOverride) {
      const extra = JSON.parse(rawOverride);
      if (extra && typeof extra === 'object') Object.assign(merged, extra);
    }
    return merged;
  } catch {
    return { ...DEFAULTS };
  }
}

function isOn() {
  if (cfg().enabled === false) return false;
  try {
    return host.api?.isSkillActive ? host.api.isSkillActive(SKILL_ID) !== false : true;
  } catch {
    return true;
  }
}

// ─────────────────────────────────────────────── 频率账本
function dayKey(ts = nowTs()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 账本形状：{ sends: { [chatKey]: [{ts, stickerId, mood}] }, history: [{ts, stickerId}], globals: [ts] } */
function state() {
  const s = readJson(STATE_FILE, null);
  if (!s || typeof s !== 'object') return { sends: {}, history: [] };
  return {
    sends: s.sends && typeof s.sends === 'object' && !Array.isArray(s.sends) ? s.sends : {},
    history: Array.isArray(s.history) ? s.history : []
  };
}

function writeState(s) {
  // 只留最近两天的流水，文件不会无限膨胀
  const cutoff = nowTs() - 48 * 3600 * 1000;
  const sends = {};
  for (const [k, list] of Object.entries(s.sends || {})) {
    const kept = (Array.isArray(list) ? list : []).filter((x) => num(x?.ts, 0) >= cutoff);
    if (kept.length) sends[k] = kept;
  }
  const history = (Array.isArray(s.history) ? s.history : []).filter((x) => num(x?.ts, 0) >= cutoff).slice(-800);
  return writeJson(STATE_FILE, { sends, history });
}

/**
 * 算额度。
 * 三个硬闸：本会话每小时、本会话每天、全部会话每小时。另加"距上一张的间隔"。
 * 每一项都可以由用户在设置页调。
 */
function quota(conf = cfg(), s = state(), chatKey = '') {
  const now = nowTs();
  const mine = Array.isArray(s.sends?.[chatKey]) ? s.sends[chatKey] : [];
  const all = Object.values(s.sends || {}).flat().map((x) => num(x?.ts, 0));
  const day = dayKey(now);

  const hourCap = Math.max(0, num(conf.perChatPerHour, DEFAULTS.perChatPerHour));
  const dayCap = Math.max(0, num(conf.perChatPerDay, DEFAULTS.perChatPerDay));
  const globalCap = Math.max(0, num(conf.globalPerHour, DEFAULTS.globalPerHour));

  const usedHour = mine.filter((x) => now - num(x.ts, 0) < 3600 * 1000).length;
  const usedDay = mine.filter((x) => dayKey(num(x.ts, now)) === day).length;
  const usedGlobal = all.filter((t) => now - t < 3600 * 1000).length;

  const last = mine.reduce((m, x) => Math.max(m, num(x.ts, 0)), 0);
  const gapMin = Math.max(0, num(conf.minGapMin, DEFAULTS.minGapMin));
  const waitMs = last ? Math.max(0, gapMin * 60000 - (now - last)) : 0;

  const leftHour = Math.max(0, hourCap - usedHour);
  const leftDay = Math.max(0, dayCap - usedDay);
  const leftGlobal = Math.max(0, globalCap - usedGlobal);

  let reason = '';
  if (leftHour <= 0) reason = `这个会话这一小时已经发了 ${usedHour} 张（上限 ${hourCap}）`;
  else if (leftDay <= 0) reason = `这个会话今天已经发了 ${usedDay} 张（上限 ${dayCap}）`;
  else if (leftGlobal <= 0) reason = `所有会话这一小时加起来已经发了 ${usedGlobal} 张（上限 ${globalCap}）`;
  else if (waitMs > 0) reason = `距上一张还不到 ${gapMin} 分钟（还要等约 ${Math.ceil(waitMs / 60000)} 分钟）`;

  return {
    leftHour, leftDay, leftGlobal, waitMs,
    allowed: leftHour > 0 && leftDay > 0 && leftGlobal > 0 && waitMs <= 0,
    left: Math.min(leftHour, leftDay, leftGlobal),
    reason
  };
}

/** 同会话里最近发过的那几张（用于"别连着发同一张"）。 */
function recentIds(conf, s, chatKey) {
  const min = Math.max(0, num(conf.repeatCooldownMin, DEFAULTS.repeatCooldownMin));
  if (min <= 0) return new Set();
  const cutoff = nowTs() - min * 60000;
  const mine = Array.isArray(s.sends?.[chatKey]) ? s.sends[chatKey] : [];
  return new Set(mine.filter((x) => num(x.ts, 0) >= cutoff && x.stickerId).map((x) => String(x.stickerId)));
}

function recordSend(chatKey, stickerId, mood) {
  const s = state();
  const rec = { ts: nowTs(), stickerId: String(stickerId || ''), mood: clean(mood, 30) };
  s.sends[chatKey] = [...(Array.isArray(s.sends[chatKey]) ? s.sends[chatKey] : []), rec].slice(-60);
  // history 只留 stickerId，供"整体上她爱用哪几张"做参考
  s.history = [...s.history, { ts: rec.ts, stickerId: rec.stickerId }].slice(-800);
  writeState(s);
  return rec;
}

// ─────────────────────────────────────────────── 核心工具桥（唯一的取用方式）
/**
 * 核心工具的来源在这一个函数里，两条路：
 *   ① 正常运行时问 src/tool-registry.js 要真的那个核心工具；
 *   ② 离线自测（node skills/meme-mood/selftest.mjs）时可以用环境变量
 *      DSH_MEME_MOOD_STUB='{"send_sticker":true,"list_stickers":true}'
 *      把核心换成自测桩，不用起整个 QQ Agent 就能验证本技能的逻辑。
 *      平时这个变量不存在，走的就是真工具。
 */
function coreDef(name) {
  const stubOn = process.env.DSH_MEME_MOOD_STUB;
  if (stubOn) {
    try {
      const want = JSON.parse(stubOn);
      if (want && want[name]) return globalThis.__DSH_MEME_MOOD_STUBS__?.[name] || null;
    } catch { /* 变量写坏了就当没有，走真工具 */ }
  }
  return getTool(name);
}

/**
 * 把核心工具包一层：核心的 execute(ctx, args) 与技能工具是**同一套签名**
 * （见 src/tools.js 的 executeTool：`def.execute(ctx, args)`），钩子/工具里拿到的 ctx
 * 就是核心那套（chatKey / store / stickers / sender / session / emit 都在），原样透传即可。
 * 返回 null 表示"核心现在没有这个工具"。
 */
function shimCore(name) {
  return async (ctx, args) => {
    const def = coreDef(name);
    if (!def || typeof def.execute !== 'function') return null;
    return def.execute(ctx, args);
  };
}

/**
 * 同 shimCore，但先过一遍核心的可用性口径（src/tool-registry.js 的 getToolAvailability）。
 * 可用性有七道闸（全局开关、分类开关、单工具开关、技能开关、tool.guard 的"仅允许主人"…），
 * 这里把**真正**拦住它的那条原因取出来，而不是笼统说一句"不可用"。
 */
function shimCoreAll(name) {
  const stubOn = process.env.DSH_MEME_MOOD_STUB;
  const def = coreDef(name);
  if (!def || typeof def.execute !== 'function') return { ok: false, def: null, availability: null };
  if (stubOn) return { ok: true, def, availability: { enabled: true, code: null, reason: '' } };
  const availability = getToolAvailability(name, { runtimeContext: {} });
  if (!availability?.enabled) return { ok: false, def, availability };
  return { ok: true, def, availability };
}

function gateWhy(gate) {
  if (!gate?.def) return '核心的收藏表情工具没有注册上（src/tools.js 的 send_sticker 不在 registry 里）';
  return `被核心拦住了：${gate?.availability?.reason || gate?.availability?.code || '原因不明'}`;
}

function asText(r) {
  if (r == null) return '';
  if (typeof r.content === 'string') return r.content;
  if (Array.isArray(r.content)) return r.content.filter((p) => p?.type === 'text').map((p) => p.text).join('\n');
  try { return JSON.stringify(r); } catch { return String(r); }
}

function firstId(obj) {
  const list = obj?.stickers;
  if (!Array.isArray(list) || !list.length) return null;
  return String(list[0]?.id ?? '') || null;
}

// ─────────────────────────────────────────────── 选图
/**
 * 按心情从**她自己的收藏**里找候选。
 * 关键词交给核心的 list_stickers（它匹配备注/笔记/标签/id），这里只做两件事：
 *   ① 把最近发过的图剔掉（同一会话别连着发同一张）；
 *   ② 顺手数一下其中有多少是动图（她最爱的"会动的"那类，报给她时更有画面）。
 */
async function findCandidates(ctx, { mood, query, limit = 8, exclude } = {}) {
  const q = clean(query || mood || '', 40);
  const payload = { limit: Math.max(4, Math.min(30, limit * 3)) };
  if (q) payload.query = q;
  const r = await shimCore('list_stickers')(ctx, payload);
  if (!r) return { ok: false, why: '核心的"查看表情库"(list_stickers) 没注册上或被关掉了', items: [], query: q };
  if (r.isError) return { ok: false, why: asText(r), items: [], query: q };

  let parsed = null;
  try { parsed = JSON.parse(asText(r)); } catch { parsed = null; }
  const items = Array.isArray(parsed?.stickers) ? parsed.stickers : [];
  const skip = exclude instanceof Set ? exclude : new Set();
  const kept = items.filter((s) => !skip.has(String(s?.id ?? '')));
  return {
    ok: true,
    why: '',
    query: q,
    matched: num(parsed?.matched, items.length),
    total: num(parsed?.total, items.length),
    items: kept.slice(0, limit),
    // 被冷却挡掉的那几张也报出来，她才知道"不是没有，是刚发过"
    cooled: items.length - kept.length
  };
}

function candidatesText(res, conf, chatKey = '') {
  const lines = [];
  const q = res.query ? `关键词「${res.query}」` : '（没给关键词，列的是常用/轮换的那几张）';
  lines.push(`我的收藏里${q}匹配到 ${num(res.matched, res.items.length)} 张${res.total ? `（收藏夹一共 ${res.total} 张）` : ''}：`);
  if (!res.items.length) {
    lines.push('  - （没有可发的：要么没匹配上，要么这几张刚好都在冷却里）');
  } else {
    for (const s of res.items) {
      const label = s.desc || s.localNote || '（没备注，可以先看图）';
      const tags = Array.isArray(s.tags) && s.tags.length ? ` [${s.tags.join('/')}]` : '';
      const used = num(s.useCount, 0) ? `（用过 ${num(s.useCount, 0)} 次）` : '';
      lines.push(`  - ${label}${tags}${used}  → stickerId=${s.id}`);
    }
  }
  if (res.cooled > 0) lines.push(`（另有 ${res.cooled} 张刚发过不久，这次先跳过）`);
  lines.push('');
  const left = quota(conf, state(), chatKey);
  lines.push(`本会话这一小时还能发 ${left.leftHour} 张、今天还能发 ${left.leftDay} 张；要我发的话，用 meme-mood__send_by_mood 把 stickerId 填成上面某一行的 id 即可。`);
  return lines.join('\n');
}

// ─────────────────────────────────────────────── 钩子
const hooks = {
  // ① 递机会：告诉她"你现在可以配一张"，并把额度说明白；她自己决定发不发。
  'before-llm-messages': (ctx) => {
    try {
      const conf = cfg();
      if (!isOn() || conf.sending === false || conf.hint === false) return;
      const messages = ctx?.messages;
      if (!Array.isArray(messages) || !messages.length) return;

      const chatKey = String(ctx?.chatKey || '');
      const q = quota(conf, state(), chatKey);
      if (!q.allowed) return;   // 没额度就别提，免得她白惦记

      // 只有真的还有收藏可发时才提（收藏夹空的时候提了也发不出去）
      const gate = shimCoreAll('send_sticker');
      if (!gate.ok && !gate.def) return;

      const sys = messages.find((m) => m && m.role === 'system');
      const line = `（发表情：本会话这一小时还能主动发 ${q.leftHour} 张、今天还能发 ${q.leftDay} 张）`;
      if (sys && typeof sys.content === 'string' && !sys.content.includes(line)) {
        sys.content = `${sys.content}\n${line}`;
      }

      // 机会提示最多每 20 分钟递一次，免得每轮都在她眼前刷同一句话
      const st = state();
      if (num(st.hintAt, 0) && nowTs() - num(st.hintAt, 0) < 20 * 60000) return;

      const target = lastUser(messages);
      if (!target) return;
      const block = [
        HINT_HEAD,
        `我自己的收藏里有可以用的表情（本会话这一小时还能发 ${q.leftHour} 张、今天还能发 ${q.leftDay} 张）。`,
        '- 如果这句话本身有情绪、配一张正好替我把话说完（接梗、吐槽、无语、得意、委屈、被催…），就可以挑一张发；',
        '- 分寸在心里：对方在认真问事、话题正紧、刚发过图，或者没合适的，就别硬凑 —— 不发完全正常；',
        '- 别人明确点名要图时（"来张表情包"），也走同一条路（先看候选再发）。',
        HINT_TAIL
      ].join('\n');
      if (appendBlock(target, block)) {
        const s = state();
        s.hintAt = nowTs();
        writeState(s);
      }
    } catch (e) {
      warn(`注入失败：${e && e.message ? e.message : e}`);
    }
  },

  // ② 记账：不管她是从本技能发的，还是直接用核心的 send_sticker 发的，都算进额度里。
  'after-tool': (ctx) => {
    try {
      const name = String(ctx?.toolName || '');
      const isMine = name.startsWith(PREFIX);
      if (!isMine && name !== 'send_sticker') return;

      const result = ctx.result || {};
      const text = asText(result);
      const failed = Boolean(result.isError) || /^\s*错误/.test(text);
      if (failed) {
        if (isMine) log(`这次没发出去：${shortText(text, 80)}`);
        return;
      }

      // orchestrator 的 after-tool 载荷没有 args 对象，参数只有 JSON 字符串形式
      let args = ctx.args || {};
      if (typeof ctx.argsRaw === 'string' && ctx.argsRaw.trim()) {
        try {
          const parsed = JSON.parse(ctx.argsRaw);
          if (parsed && typeof parsed === 'object') args = parsed;
        } catch { /* 解析失败就当没有参数，不拦记账 */ }
      } else if (typeof ctx.argsRaw === 'object' && ctx.argsRaw) {
        args = ctx.argsRaw;
      }

      const stickerId = clean(args.stickerId ?? args.emojiId ?? '', 80);
      const chatKey = String(ctx?.chatKey || '');
      if (!chatKey) return;

      // 幂等：本技能自己的工具已经在 recordSend 里记过账了，别重复扣额度
      const s = state();
      const mine = Array.isArray(s.sends[chatKey]) ? s.sends[chatKey] : [];
      const last = mine[mine.length - 1];
      if (last && stickerId && String(last.stickerId) === stickerId && nowTs() - num(last.ts, 0) < 5000) return;

      recordSend(chatKey, stickerId, args.mood || '');
      const q = quota(cfg(), state(), chatKey);
      log(`发了一张表情${stickerId ? `（${stickerId}）` : ''}，本会话这一小时还剩 ${q.leftHour} 张`);
    } catch (e) {
      warn(`记账失败：${e && e.message ? e.message : e}`);
    }
  }
};

function lastUser(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m && m.role === 'user') return m;
  }
  return null;
}

function appendBlock(m, block) {
  if (!m) return false;
  if (typeof m.content === 'string') {
    m.content = m.content ? `${m.content}\n\n${block}` : block;
    return true;
  }
  if (Array.isArray(m.content)) {
    m.content.push({ type: 'text', text: `\n\n${block}` });
    return true;
  }
  m.content = block;
  return true;
}

// ─────────────────────────────────────────────── 提示词片段（她的自我认知）
export function promptSections() {
  try {
    if (!isOn()) return [];
    const conf = cfg();
    // ⚠️ 前缀缓存：这一段会被编进**系统提示**，每次运行原样重发。
    //    里面**不能**出现"本会话还剩 N 张"这种每发一张就变的数字 ——
    //    数字一变，系统提示从这一段到末尾的缓存前缀全部失效（缓存重算 = 全价）。
    //    要报额度就让模型现调 meme-mood__mood_status 去问（工具结果不进系统提示）。
    const lines = [
      '【心情表情：用我自己收来的表情说话】',
      '我自己有一个表情收藏夹（一张张都是我按自己的口味收的），可以按此刻的心情挑一张发出去 —— 这是"表情"，不是配图：一条消息只能是一张表情，不能附带文字。'
    ];
    if (conf.sending === false) {
      lines.push('（主动发表情现在是关着的：只有别人点名要图时你才会发。）');
    } else {
      lines.push(
        `主动发是可以的，但有硬额度：这个会话每小时 ${Math.max(0, num(conf.perChatPerHour, DEFAULTS.perChatPerHour))} 张、每天 ${Math.max(0, num(conf.perChatPerDay, DEFAULTS.perChatPerDay))} 张，所有会话加起来每小时 ${Math.max(0, num(conf.globalPerHour, DEFAULTS.globalPerHour))} 张，两张之间至少隔 ${Math.max(0, num(conf.minGapMin, DEFAULTS.minGapMin))} 分钟。额度用完了工具会拒绝你，那就照常说话。`
      );
    }
    lines.push(
      '额度是有的（具体剩几张，用 `meme-mood__mood_status` 现问，这里不写死数字）；遇到对得上语气的就发，不用省。',
      `挑图的顺序：先想"这张对不对得上现在的语气"，再看备注（desc/笔记/标签）能不能准确对上；不确定的图可以先看。发过不久的同一张会进冷却（默认 ${Math.max(0, num(conf.repeatCooldownMin, DEFAULTS.repeatCooldownMin))} 分钟），别连着刷同一张。`,
      '三个工具：`meme-mood__send_by_mood`（按心情挑一张发出去）、`meme-mood__browse_mine`（先看看有哪些候选、还剩多少额度）、`meme-mood__mood_status`（查额度）。',
      '分寸：配表情是为了让话更像人说的，不是为了凑热闹。严肃话题、对方在认真问事的时候不要发；没合适的就不发。'
    );
    return [{
      id: `${SKILL_ID}-playbook`,
      title: '心情表情（按自己的心情发自己收的表情）',
      priority: 52,
      content: lines.join('\n')
    }];
  } catch (e) {
    warn(`生成提示失败：${e?.message ?? e}`);
    return [];
  }
}

// ─────────────────────────────────────────────── 入口
export function setup(api) {
  host.api = api;
  log = api?.log || (() => {});
  warn = api?.warn || (() => {});

  const conf = cfg();
  log(
    `心情表情已加载：每会话 ${num(conf.perChatPerHour, DEFAULTS.perChatPerHour)} 张/小时、`
    + `${num(conf.perChatPerDay, DEFAULTS.perChatPerDay)} 张/天，全部会话 ${num(conf.globalPerHour, DEFAULTS.globalPerHour)} 张/小时，`
    + `间隔 ${num(conf.minGapMin, DEFAULTS.minGapMin)} 分钟；`
    + (conf.sending === false ? '主动发表情已关闭（只有点名要图才发）' : '主动发表情开着')
    + `；账本放在 data/${SKILL_ID}/`
  );
  const sendGate = shimCoreAll('send_sticker');
  if (!sendGate.ok && sendGate.def) {
    warn(`核心的"发送表情"(send_sticker) 现在不可用：${gateWhy(sendGate)}`);
  } else if (!sendGate.def) {
    warn('核心的"发送表情"(send_sticker) 不在 registry 里，本技能发不出任何表情。');
  }

  // 工具必须在 setup 执行期间注册（loader 只认这里的注册）

  api.registerTool({
    id: 'send_by_mood',
    name: '按心情发表情',
    description:
      '从我自己的表情收藏里挑一张，按此刻的心情/语气发到当前会话。mood 填一个贴语气的短词（如「无语」「得意」「委屈」「气鼓鼓」）；给 stickerId 就直接发指定那张，不给就按 mood 从收藏里找最贴的一张。一条消息只能是一张表情，不能附带文字。额度用完/间隔未到时会被拒绝。',
    category: 'sticker',
    icon: '😄',
    parameters: {
      type: 'object',
      properties: {
        mood: { type: 'string', description: '此刻语气的一个短词，用来搜备注/标签（如「无语」「得意」「晚安」）' },
        stickerId: { type: 'string', description: '想发的那一张的 id（先 browse_mine 拿到）；给了它就不按 mood 挑' },
        note: { type: 'string', description: '一句你为什么挑这张（可选，记进流水，方便以后回顾）' },
        replyToMessageId: { type: ['integer', 'string'], description: '可选：要引用的消息 id' },
        atUserId: { type: ['integer', 'string'], description: '可选：要 @ 的 QQ 号' }
      }
    },
    async execute(ctx, args) {
      const conf = cfg();
      if (conf.enabled === false || !isOn()) {
        return { content: '错误：心情表情这个技能现在是关着的，发不了。', isError: true };
      }
      if (conf.sending === false) {
        return { content: '错误：主动发表情是关着的（设置页「允许主动发表情」）。只在你被点名要图时才发。', isError: true };
      }

      const chatKey = String(ctx?.chatKey || '');
      if (!chatKey) return { content: '错误：不知道要发到哪个会话。', isError: true };

      const gate = shimCoreAll('send_sticker');
      if (!gate.ok) {
        return { content: `错误：现在发不了表情 —— ${gateWhy(gate)}。`, isError: true };
      }

      const q = quota(conf, state(), chatKey);
      if (!q.allowed) {
        return {
          content: `错误：这次先不发 —— ${q.reason}。这一轮照常说话就好，别硬凑。`,
          isError: true
        };
      }

      const mood = clean(args?.mood ?? '', 30);
      const wanted = clean(args?.stickerId ?? '', 80);
      const payload = {};
      if (wanted) payload.stickerId = wanted;
      if (args?.replyToMessageId !== undefined && args?.replyToMessageId !== null) payload.replyToMessageId = args.replyToMessageId;
      if (args?.atUserId !== undefined && args?.atUserId !== null) payload.atUserId = args.atUserId;

      try {
        if (wanted) {
          const r = await gate.def.execute(ctx, payload);
          const text = asText(r);
          if (r?.isError || /^\s*错误/.test(text)) return { content: text || '错误：这张没发出去。', isError: true };
          recordSend(chatKey, wanted, mood);
          const after = quota(conf, state(), chatKey);
          return { content: `${text}\n（已记入额度：本会话这一小时还能发 ${after.leftHour} 张）` };
        }

        // 没指定 id：按 mood 搜自己的收藏 → 拿第一张发
        const found = await findCandidates(ctx, { mood, limit: 5, exclude: recentIds(conf, state(), chatKey) });
        if (!found.ok) return { content: `错误：翻不到我的收藏（${found.why}）。`, isError: true };
        if (!found.items.length) {
          return {
            content:
              `错误：我的收藏里没有对上「${mood || '此刻语气'}」的表情`
              + `${found.total ? `（收藏夹里有 ${found.total} 张，可以给个别的词，或先用 meme-mood__browse_mine 看看）` : '（收藏夹现在是空的，先去收几张）'}。`
              + '这一张先不发，照常说话就好。',
            isError: true
          };
        }
        const pick = found.items[0];
        const r = await gate.def.execute(ctx, { ...payload, stickerId: String(pick.id) });
        const text = asText(r);
        if (r?.isError || /^\s*错误/.test(text)) return { content: text || '错误：这张没发出去。', isError: true };
        recordSend(chatKey, pick.id, mood);
        const after = quota(conf, state(), chatKey);
        const label = pick.desc || pick.localNote || pick.id;
        return {
          content:
            `已发出「${shortText(label, 30)}」（stickerId=${pick.id}${mood ? `，心情：${mood}` : ''}）。\n`
            + `（本会话这一小时还能发 ${after.leftHour} 张、今天还能发 ${after.leftDay} 张。发出去之后不要在文本里复述图里画的是什么。）`
        };
      } catch (e) {
        return { content: `错误：发不出去（${e && e.message ? e.message : e}）。`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'browse_mine',
    name: '翻我的表情收藏',
    description:
      '看看我自己收藏的表情里有哪些可以发的（可按心情/关键词筛），顺便报一下还剩多少额度。看中哪张就用 meme-mood__send_by_mood 把 stickerId 填上发出去。',
    category: 'sticker',
    icon: '🧺',
    parameters: {
      type: 'object',
      properties: {
        mood: { type: 'string', description: '可选：按此刻语气筛（如「无语」「得意」）' },
        limit: { type: 'integer', description: '最多列几张，默认 8' }
      }
    },
    async execute(ctx, args) {
      const conf = cfg();
      if (conf.enabled === false || !isOn()) {
        return { content: '错误：心情表情这个技能现在是关着的。', isError: true };
      }
      const chatKey = String(ctx?.chatKey || '');
      const limit = clamp(args?.limit, 1, 20, 8);
      try {
        const found = await findCandidates(ctx, {
          mood: clean(args?.mood ?? '', 30),
          limit,
          exclude: recentIds(conf, state(), chatKey)
        });
        if (!found.ok) return { content: `错误：翻不到我的收藏（${found.why}）。`, isError: true };
        return { content: candidatesText(found, conf, chatKey) };
      } catch (e) {
        return { content: `错误：翻不出来（${e && e.message ? e.message : e}）。`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'mood_status',
    name: '发表情额度',
    description:
      '看我现在还能发几张表情：本会话这一小时/今天、所有会话这一小时各还剩几张，距离上一张还要等多久，以及频率设置值。',
    category: 'sticker',
    icon: '📊',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      const conf = cfg();
      const chatKey = String(ctx?.chatKey || '');
      const q = quota(conf, state(), chatKey);
      const st = state();
      const mine = Array.isArray(st.sends?.[chatKey]) ? st.sends[chatKey] : [];
      const lines = [
        '【发表情额度】',
        `- 本会话这一小时：还能发 ${q.leftHour} 张（设置值 ${Math.max(0, num(conf.perChatPerHour, DEFAULTS.perChatPerHour))} 张/小时）`,
        `- 本会话今天：还能发 ${q.leftDay} 张（设置值 ${Math.max(0, num(conf.perChatPerDay, DEFAULTS.perChatPerDay))} 张/天）`,
        `- 所有会话这一小时：还能发 ${q.leftGlobal} 张（设置值 ${Math.max(0, num(conf.globalPerHour, DEFAULTS.globalPerHour))} 张/小时）`,
        `- 两张之间至少隔 ${Math.max(0, num(conf.minGapMin, DEFAULTS.minGapMin))} 分钟${q.waitMs > 0 ? `（现在还要等约 ${Math.ceil(q.waitMs / 60000)} 分钟）` : ''}`,
        `- 同一张重复发送的冷却：${Math.max(0, num(conf.repeatCooldownMin, DEFAULTS.repeatCooldownMin))} 分钟`,
        `- 主动发表情：${conf.sending === false ? '已关闭' : '开着'}；出错时的提示：${conf.hint === false ? '关闭' : '开着'}`,
        `- 这个会话最近发过的：${mine.length ? mine.slice(-5).map((x) => `${x.stickerId || '?'}${x.mood ? `(${x.mood})` : ''}`).join('、') : '（还没有）'}`,
        q.allowed ? '- 现在可以发。' : `- 现在发不了：${q.reason}。`
      ];
      return { content: lines.join('\n') };
    }
  });
}

export function available() {
  return { ok: true };
}

export function dispose() {
  host.api = null;
}

export { hooks };
export const internals = { quota, dayKey, recentIds, findCandidates };
