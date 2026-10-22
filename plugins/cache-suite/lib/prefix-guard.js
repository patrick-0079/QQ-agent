// 前缀缓存卫士 —— 把"每 N 分钟重渲染一次"的段从**系统提示**搬到**最后一条 user 消息末尾**。
//
// 为什么有用（实测数据）：
//   系统提示在最前面，缓存按前缀走。实例：`adaptive-group-style` 的统计块（learnMinutes=30）
//   写进系统提示的最后一段，位置在全文 17% 处。它一变，它后面 83% 的提示词全部作废：
//     系统提示逐字节相同 → 命中 98.5%（104 次）
//     系统提示有改动     → 命中 82.4%，其中间隔 >30 分钟的两次只有 11.9% / 12.2%
//   而用户提示词那一侧从【过去状态】开始本来就每轮都变 —— 把易变段放进那一侧是**免费的**：
//   它不再破坏任何可复用的前缀。
//
// 纪律：
//   · 纯字节搬移：内容一个字不改、不丢（自测里有"总长度守恒 + 段原文完整出现"的断言）。
//   · 只动两处：system 里剪掉、user 末尾粘上。不改工具、不改其它消息、不发网络请求。
//   · 出任何异常都原样返回（宁可缓存不恢复，也不能弄坏提示词）。

const DEFAULTS = {
  enabled: true,
  moveSections: '【群聊语言风格 · 自动学习】',
  keepCopyInSystem: false,
  logEachMove: true
};

let api = null;
let active = false;
/** 面板/日志用的累计计数 */
const stats = {
  moves: 0,
  lastAt: 0,
  lastChars: 0,
  lastHead: '',
  systemStable: null,
  lastSysLen: 0,
  lastSysSig: '',
  sameSysStreak: 0
};
/** chatKey -> 上一次见过的系统提示（判断"现在稳不稳"，这是本插件真正的 KPI） */
const lastSys = new Map();

export function setup(host) {
  api = host;
  active = true;
  try { api.log(`已启用（搬出系统提示的段：${sections().join(' / ') || '（无）'}）`); } catch { /* 日志失败不影响 */ }
  writeSnapshot();
}

export function activate() { active = true; writeSnapshot(); }
export function deactivate() { active = false; writeSnapshot(); }
export function available() { return { ok: true }; }

/** 把面板要看的快照写进宿主 storage（面板通过 ../@data/storage.json 读它）。 */
let lastWriteAt = 0;
function writeSnapshot(force = false) {
  const now = Date.now();
  if (!force && now - lastWriteAt < 3000) return;   // 3 秒节流：连续几轮也只写一次
  lastWriteAt = now;
  try {
    api?.storage?.set?.('snapshot', { ...snapshot(), updatedAt: now });
  } catch { /* 写不进去也不影响搬移 */ }
}

const cfg = () => ({ ...DEFAULTS, ...(api?.config?.() || {}) });
const asBool = (v, d) => (v === undefined || v === null || v === '' ? d : (typeof v === 'boolean' ? v : !/^(false|0|no|off|否|关)$/i.test(String(v).trim())));

/** 要搬的段标题列表（每行一个，以【开头）。 */
function sections() {
  return String(cfg().moveSections ?? '')
    .split(/[\n,，;；]/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith('【') && s.endsWith('】'));
}

/** 从 start 处往后找这一段到哪里结束：下一个以「【」开头的行，或字符串结尾。 */
function sectionEnd(text, start) {
  const next = text.indexOf('\n【', start + 1);
  return next < 0 ? text.length : next;
}

/**
 * 纯函数，便于离线用真实历史验证（自测与验证脚本都直接调它）。
 * @returns {{sys:string, user:string, moved:Array<{head:string, chars:number}>}}
 */
export function transform(systemText, userText, heads = sections(), keepCopy = false) {
  let sys = String(systemText ?? '');
  const user = String(userText ?? '');
  const moved = [];
  if (!sys || !user) return { sys, user, moved };
  for (const head of heads) {
    let guard = 0;
    for (;;) {
      if (guard++ > 8) break;
      const at = sys.indexOf(head);
      if (at < 0) break;
      const end = sectionEnd(sys, at);
      const block = sys.slice(at, end).replace(/\s+$/, '');
      if (!block) break;
      moved.push({ head, chars: block.length, body: block });
      // 对照模式：系统提示里留原件（这时不剪，只在末尾贴一份，用来做 A/B）
      if (keepCopy) break;
      // 剪掉（连同它前面的空行），保证剪完不留下三连空行
      const before = sys.slice(0, at).replace(/[ \t]+$/, '');
      sys = (before + sys.slice(end)).replace(/\n{3,}/g, '\n\n');
      // 如果同一段在系统提示里出现多次，循环继续处理下一次
      if (sys.indexOf(head) < 0) break;
    }
  }
  if (!moved.length) return { sys, user, moved };
  const tail = moved.map((m) => m.body).join('\n\n');
  return { sys: String(sys).replace(/\s+$/, ''), user: `${user}\n\n${tail}`, moved };
}

/** 找到最后一条 user 消息（与宿主其它插件的约定一致）。 */
function lastUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m && m.role === 'user' && typeof m.content === 'string') return m;
  }
  return null;
}

/**
 * 全文指纹（FNV-1a 32 位 + 长度）。
 * ⚠️ 踩过：第一版用"长度 + 首尾 64 字"当指纹，改动落在中间就检测不出来 ——
 * 而"中间有没有变"正是这个插件要盯的东西，所以必须扫全文。
 * 不用 node crypto：准入闸会拦 node  模块，自己写 5 行更省事。
 */
function digest(text) {
  const s = String(text ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${s.length}:${h.toString(16)}`;
}

function rememberSys(key, sys) {
  const sig = digest(sys);
  const prev = lastSys.get(key);
  lastSys.set(key, sig);
  if (lastSys.size > 200) lastSys.delete(lastSys.keys().next().value);
  stats.lastSysLen = sys.length;
  stats.lastSysSig = sig;
  if (!prev) { stats.systemStable = null; stats.sameSysStreak = 0; return; }
  stats.systemStable = prev === sig;
  stats.sameSysStreak = prev === sig ? stats.sameSysStreak + 1 : 0;
}

export const hooks = {
  /**
   * 请求定稿前把易变段搬走。
   * 跑在这里的理由：钩子拿到的是**同一个数组引用**，允许原地修改（宿主 orchestrator 的约定）。
   */
  'before-llm-messages'(ctx = {}) {
    try {
      const c = cfg();
      const messages = ctx?.messages;
      if (!active || !asBool(c.enabled, true) || !Array.isArray(messages)) return;
      const sys = messages.find((m) => m && m.role === 'system' && typeof m.content === 'string');
      const user = lastUserMessage(messages);
      if (!sys || !user) return;

      const heads = sections();
      rememberSys(String(ctx?.chatKey || ''), sys.content);
      if (!heads.length) return;

      const out = transform(sys.content, user.content, heads, asBool(c.keepCopyInSystem, false));
      if (!out.moved.length) return;
      // 长度守恒自检：搬移不该改变总字符数（去掉了空白差异，允许 ±段数×2）
      const delta = (out.sys.length + out.user.length) - (sys.content.length + user.content.length);
      if (Math.abs(delta) > out.moved.length * 2 + 4) {
        try { api.log(`⚠️ 搬移后长度不守恒（差 ${delta} 字），本次放弃，原样发出`); } catch { /* ignore */ }
        return;
      }
      sys.content = out.sys;
      user.content = out.user;

      const chars = out.moved.reduce((n, m) => n + m.chars, 0);
      stats.moves += 1;
      stats.lastAt = Date.now();
      stats.lastChars = chars;
      stats.lastHead = out.moved.map((m) => m.head).join(' ');
      writeSnapshot(true);
      if (asBool(c.logEachMove, true)) {
        try {
          api.log(`搬移 ${out.moved.length} 段 / ${chars} 字出系统提示：${out.moved.map((m) => m.head).join(' ')}（系统提示 ${sys.content.length} 字）`);
        } catch { /* ignore */ }
      }
    } catch (error) {
      try { api.warn(`搬移异常（本次原样发出）：${error?.message ?? error}`); } catch { /* ignore */ }
    }
  }
};

/** 供面板读取（宿主不会调用）。 */
export function snapshot() {
  return {
    enabled: asBool(cfg().enabled, true),
    heads: sections(),
    keepCopyInSystem: asBool(cfg().keepCopyInSystem, false),
    moves: stats.moves,
    lastAt: stats.lastAt,
    lastChars: stats.lastChars,
    lastHead: stats.lastHead,
    systemStable: stats.systemStable,
    sameSysStreak: stats.sameSysStreak,
    lastSysLen: stats.lastSysLen,
    tracked: lastSys.size,
    updatedAt: Date.now()
  };
}

export function internals() { return { transform, sections, sectionEnd, stats }; }
