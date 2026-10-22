// 体力值（QQ Agent 扩展·确定性型 = 插件，位于 plugins/）
//
// ── 为什么是"插件"而不是"技能" ────────────────────────────────────────────
// 本项目两种扩展的唯一判据是**谁决定何时执行**：
//   插件（plugins/）靠 providers/hooks，核心代码满足条件必然执行，模型绕不过去；
//   技能（skills/）靠 registerTool，模型看说明自己判断用不用。
// "发言必须扣体力、体力不够必须发不出去"是**死规则** —— 模型想赖账也不该有机会。
// 所以计费与拦截走 hooks（确定性）；"有人 @ 我问体力"这种要理解人话的部分
// 也在 before-context 里确定性处理掉，另外注册一个只读查询工具给模型兜底。
//
// ── 它到底拦住了什么（读源码后的实测结论，不是猜的）─────────────────────
// 核心的钩子调用点（src/orchestrator.js）：
//   before-context      776   提示词组装前；有 triggerEntries / store
//   before-llm-messages 876   发给模型的 messages 组装后（同一数组引用，可原地改）
//   after-response      1016  每次 LLM 响应后
//   before-tool         1140  **唯一读返回值**的钩子：返回 {block:true,reason} 可否决本次调用
//   after-tool          1151  result 是活引用，可改 content/isError
// 关键结论：
//   · 钩子里**没有** sender/onebot，所以本插件的"讨饭/回执"自己建一条发送通道；
//   · 钩子**无法中止**这一轮（before-context 返回值被忽略），所以"别让它再回一遍"
//     只能靠 before-tool 否决发言工具 —— 见下面 suppress 机制；
//   · before-tool 在 executeTool **之前**跑，after-tool 在之后跑，且被否决时
//     after-tool 仍会跑（拿到的是错误对象）→ 计费必须放在 after-tool 且只认成功。
//
// ── 计费为什么放在 after-tool ─────────────────────────────────────────────
// 放 before-tool 会"先扣钱再发现发送失败"，白扣。现在的分工是：
//   before-tool：只**查**够不够（不够就否决），不动余额；
//   after-tool ：执行成功（!isError）才真扣。
// 两者都在同一次调用上顺序发生，所以"这轮只剩 1 点却想发两条"依然会被拦住：
// 第一条 after-tool 扣完，第二条 before-tool 就看到了新余额。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// ── 路径锚点 ────────────────────────────────────────────────────────────────
// 与 plugin-loader.js 同一约定：以**模块自身位置**为锚点，绝不用 process.cwd()
// （安装版里快捷方式的"起始位置"通常是 <install>/ 而不是 app/，用 cwd 会解析到
// 不存在的目录 —— 那种错误只会表现为"体力永远满格"，排查成本极高）。
const HERE = path.dirname(fileURLToPath(import.meta.url));   // <app>/plugins/stamina
const APP_ROOT = path.resolve(HERE, '..', '..');             // <app>

/** 数据目录：便携/多实例时 QQ_AGENT_DATA_DIR 会覆盖（与 src/config.js 同一规则）。 */
const DATA_DIR = process.env.QQ_AGENT_DATA_DIR
  ? path.resolve(process.env.QQ_AGENT_DATA_DIR)
  : path.join(APP_ROOT, 'data');
const STORE_FILE = path.join(DATA_DIR, 'stamina.json');
/** 体力变动日志：自己写、不依赖 api.log（那条通道不进日志文件，见 logChange 注释）。 */
const LOG_FILE = path.join(DATA_DIR, 'stamina.log');

const SCHEMA_VERSION = 1;

/**
 * 插件版本，与 skill.json 的 version 保持一致。
 * 写进启动日志，这样 stamina.log 第一行就能回答"现在跑的是哪个版本"，
 * 排查时不必再去比对目录里的文件时间（本次事故里正是靠这个区分的）。
 */
const VERSION = '1.0.1';

// ── 默认值 ──────────────────────────────────────────────────────────────────
// ⚠️ 必须与 skill.json 的 settings 保持一致：运行时 api.config() 只以
//    manifest.settings 为底、再被用户配置覆盖，**configSchema.default 不参与**。
//    这里再兜一层是因为用户可能把某项清空/写成非数字。
const DEFAULTS = {
  maxStamina: 60,
  costPerMessage: 1,
  costPerImage: 2,
  recoverMinutes: 5,
  recoverAmount: 1,
  begThreshold: 10,
  fishCakeRestore: 15,
  fishCakesPerDay: 2,
  speechTools: 'send_message,send_to',
  imageTools: 'send_image',
  blockWhenZero: true,
  proactiveBeg: true,
  begCooldownMinutes: 10,
  ownerBegCooldownMinutes: 5,
  checkIntervalSeconds: 60,
  begWindowMinutes: 30,
  ownerIds: '',
  verboseLog: true,
  feedKeywords: '投喂鱼饼,喂鱼饼,喂饼',
  queryKeywords: '查询体力,查看体力,体力查询,查体力',
  begText: '饿死了…谁行行好，投喂个鱼饼吧（@我说「投喂鱼饼」就行）',
  ownerBegText: '主人…我体力见底了，赏我个鱼饼吧',
  feedText: '谢谢{name}！鱼饼真香，体力 +{gain}（{stamina}/{max}）',
  feedFullText: '谢谢{name}！不过我已经吃饱了，鱼饼先留着吧（{stamina}/{max}）',
  noCakeText: '{name}，你今天的鱼饼已经喂完啦，明天再来吧',
  queryText: '当前体力：{stamina}/{max}'
};

/** 被本插件否决时写在错误里的标记 —— after-tool 靠它认出"这次没执行，别扣钱"。 */
const BLOCK_MARK = '【体力不足】';

// ── 小工具 ──────────────────────────────────────────────────────────────────

function ok(payload) {
  return { content: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 1) };
}
function err(message) {
  return { content: `错误：${message}`, isError: true };
}
function clampInt(v, min, max, dflt) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}
function clampNum(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}
function toBool(v, dflt) {
  if (v === true || v === false) return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on', '是', '开'].includes(s)) return true;
    if (['0', 'false', 'no', 'off', '否', '关', ''].includes(s)) return false;
  }
  return dflt;
}
/**
 * 逗号/顿号/空白分隔的字符串 → 去重数组。
 *
 * ⚠️ 空字符串必须解析成 **[]**，不能回落成默认值 —— 否则"把「发言工具」清空
 *    就等于发言免费"这个设置项永远失效：用户清空后仍会拿到默认的 send_message，
 *    表现就是"我明明关了它还是扣我体力"。默认值只在字段**整个缺失**（undefined）
 *    时兜底，而那种情况实际由 manifest.settings 负责，这里只是防御。
 */
function toList(v, dflt = []) {
  if (v === undefined || v === null) return dflt;
  const raw = Array.isArray(v) ? v : String(v).split(/[,，、\s]+/);
  return [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))];
}
/** 本地时区的 YYYY-MM-DD（不能用 toISOString：那是 UTC，晚上 8 点后会差一天）。 */
function localDate(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** 模板占位符替换：{name} {stamina} {max} {gain}；认不出的占位符原样保留。 */
function fill(tpl, vars) {
  return String(tpl ?? '').replace(/\{(\w+)\}/g, (m, k) => (
    Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m
  ));
}
function hasKeyword(text, keywords) {
  const t = String(text ?? '');
  if (!t) return false;
  return keywords.some((k) => k && t.includes(k));
}

// ── 存储 ────────────────────────────────────────────────────────────────────
// 一个文件装所有群：{ v, chats: { "group:123": {...} } }。
// 写盘用"临时文件 + rename"（原子替换）—— 直接 writeFileSync 覆盖时，写一半
// 被杀进程会留下半个 JSON，下次读就所有群的体力全没了。

const queues = new Map();   // file -> Promise（同文件串行，防读改写丢更新）

function withLock(file, fn) {
  const prev = queues.get(file) || Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(file, next.catch(() => {}));
  return next;
}

function emptyStore() {
  return { v: SCHEMA_VERSION, chats: {} };
}

/**
 * 单个群的记录形状（缺字段一律补齐，容忍手工编辑过的文件）。
 *
 * ⚠️⚠️ 必须把**当前生效的上限**作为参数传进来，绝不能在这里自己找默认值。
 *   这里曾经写成 `clampInt(raw?.maxStamina, …)` —— 读一个**从来没被写入过**的
 *     per-chat 字段，于是每次都回落到硬编码的 DEFAULTS.maxStamina（60），
 *     结果把用户配的 100 悄悄夹回 60：
 *         投喂 → 79 存盘 → 下次读取夹成 60 → 再投喂 → 80 → 又夹成 60 …
 *     表现就是"投喂永远涨不上去、上限永远到不了"，而且**没有任何报错**。
 *   上限是全局设置（api.config），不是每群字段；clamp 必须用那个值。
 *   （每群只存 stamina 本身，恢复/夹取由 settle() 按当前配置处理。）
 */
function normalizeChat(raw, maxStamina = DEFAULTS.maxStamina) {
  const cap = clampInt(maxStamina, 1, 100000, DEFAULTS.maxStamina);
  return {
    stamina: clampNum(raw?.stamina, 0, cap, cap),
    // lastSettle = 上次"结算自然恢复"的时间戳。恢复是懒计算的锚点，见 settle()。
    lastSettle: Number(raw?.lastSettle) || Date.now(),
    lastBegAt: Number(raw?.lastBegAt) || 0,
    lastOwnerBegAt: Number(raw?.lastOwnerBegAt) || 0,
    lastActiveAt: Number(raw?.lastActiveAt) || 0,
    // cakes: { "YYYY-MM-DD": { "<QQ号>": 已用个数 } } —— 按天存 = 跨天自动满额（不叠加）
    cakes: (raw?.cakes && typeof raw.cakes === 'object' && !Array.isArray(raw.cakes)) ? raw.cakes : {}
  };
}

function readStore(maxStamina = DEFAULTS.maxStamina) {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    const chats = {};
    for (const [k, v] of Object.entries(raw?.chats || {})) {
      if (v && typeof v === 'object') chats[String(k)] = normalizeChat(v, maxStamina);
    }
    return { v: SCHEMA_VERSION, chats };
  } catch (e) {
    if (e?.code === 'ENOENT' || e instanceof SyntaxError) {
      // 文件不存在 = 还没用过；JSON 坏了 → 备份现场，别把所有人的体力直接吞掉
      if (e instanceof SyntaxError) {
        try { fs.renameSync(STORE_FILE, `${STORE_FILE}.broken-${Date.now()}`); } catch { /* 备份失败不阻断 */ }
      }
      return emptyStore();
    }
    throw new Error(`读取体力数据失败（${STORE_FILE}）：${e?.message ?? e}`);
  }
}

function writeStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${STORE_FILE}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 1));
  fs.renameSync(tmp, STORE_FILE);
}

/** 只保留最近 N 天的鱼饼账，防止文件无限增长。 */
function pruneCakes(store, keepDays = 7) {
  const cutoff = localDate(Date.now() - keepDays * 86400000);
  for (const rec of Object.values(store.chats)) {
    for (const day of Object.keys(rec.cakes)) {
      if (day < cutoff) delete rec.cakes[day];
    }
  }
}

// ── 插件本体 ────────────────────────────────────────────────────────────────

/**
 * ⚠️ 用 `export const hooks = {}` 占位、在 setup 里按需挂载，而不是把闭包写在
 *    模块顶层 —— 后者会让状态跨**热重载**残留：加载器每次重载都重新 import
 *    一遍模块，但旧模块的对象如果还被管理器引用着，里面的计时器/缓存就永远
 *    回收不掉（表现为幽灵讨饭）。setup 里重新赋值为全新对象，旧的自然被替换。
 */
export const hooks = {};

/**
 * 生命周期实现的容器：由 setup() 填充，供下面的模块级导出转发。
 * 见文件末尾「生命周期」一节 —— 加载器只认模块导出，不认 setup 的返回值。
 */
let lifecycle = null;

/** 加载器取的是 mod.activate / mod.deactivate / mod.dispose / mod.available（见文件末尾说明）。 */
export function activate(ctx) { return lifecycle?.activate?.(ctx); }
export function deactivate(ctx) { return lifecycle?.deactivate?.(ctx); }
export function dispose() { return lifecycle?.dispose?.(); }
export function available(ctx) {
  if (!lifecycle) return true;   // setup 还没跑：不拦
  return lifecycle.available?.(ctx);
}

export function setup(api) {
  const log = api.log;
  const warn = api.warn;

  // ── 配置 ──────────────────────────────────────────────────────────────────

  /**
   * 体力变动日志。
   *
   * ⚠️ 为什么自己写文件、而不是只用 api.log：
   *    api.log 走的是 console.log（plugin-loader.js:120），而应用写进
   *    data/logs/qq-agent-*.log 的是它**自己的** logger —— 两者不是一条通道。
   *    实测那台机器的日志里**一条 [skill:xxx] 都没有**，也就是说插件用 api.log
   *    打的东西根本没落进日志文件。排查"到底扣没扣"时这是致命的：什么都看不到。
   *    所以这里直接往数据目录写一个自己的 stamina.log，保证一定看得见。
   *
   * 这套机制的失败方式是**沉默的**（没生效时不报错，只是数值不动），
   * 所以"看得见每一步"比"日志干净"重要得多。可以在设置里关掉。
   */
  function logChange(chatKey, message) {
    try {
      if (!cfg().verboseLog) return;
      const line = `${new Date().toISOString()} ${chatKey} ${message}\n`;
      fs.appendFileSync(LOG_FILE, line, 'utf8');
      // 体积控制：超过 512KB 只留最后 300 行，防止长期运行把磁盘写满
      if (fs.statSync(LOG_FILE).size > 512 * 1024) {
        const kept = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).slice(-300);
        fs.writeFileSync(LOG_FILE, `${kept.join('\n')}\n`, 'utf8');
      }
    } catch { /* 记日志失败绝不影响体力机制本身 */ }
  }

  function cfg() {
    const c = api.config() || {};
    const maxStamina = clampInt(c.maxStamina, 1, 100000, DEFAULTS.maxStamina);
    return {
      maxStamina,
      costPerMessage: clampNum(c.costPerMessage, 0, 100000, DEFAULTS.costPerMessage),
      costPerImage: clampNum(c.costPerImage, 0, 100000, DEFAULTS.costPerImage),
      // 下界 1 分钟：0 会让 recoverMs 变成 0，settle 里的整除直接炸成 Infinity
      recoverMinutes: clampNum(c.recoverMinutes, 1, 100000, DEFAULTS.recoverMinutes),
      recoverAmount: clampNum(c.recoverAmount, 0, 100000, DEFAULTS.recoverAmount),
      begThreshold: clampNum(c.begThreshold, 0, 100000, DEFAULTS.begThreshold),
      fishCakeRestore: clampNum(c.fishCakeRestore, 0, 100000, DEFAULTS.fishCakeRestore),
      fishCakesPerDay: clampInt(c.fishCakesPerDay, 0, 1000, DEFAULTS.fishCakesPerDay),
      speechTools: new Set(toList(c.speechTools, toList(DEFAULTS.speechTools))),
      imageTools: new Set(toList(c.imageTools, toList(DEFAULTS.imageTools))),
      blockWhenZero: toBool(c.blockWhenZero, DEFAULTS.blockWhenZero),
      proactiveBeg: toBool(c.proactiveBeg, DEFAULTS.proactiveBeg),
      begCooldownMs: clampNum(c.begCooldownMinutes, 0, 100000, DEFAULTS.begCooldownMinutes) * 60000,
      ownerBegCooldownMs: clampNum(c.ownerBegCooldownMinutes, 0, 100000, DEFAULTS.ownerBegCooldownMinutes) * 60000,
      checkIntervalMs: Math.max(5, clampNum(c.checkIntervalSeconds, 5, 100000, DEFAULTS.checkIntervalSeconds)) * 1000,
      begWindowMs: clampNum(c.begWindowMinutes, 0, 100000, DEFAULTS.begWindowMinutes) * 60000,
      ownerIds: toList(c.ownerIds, []),
      verboseLog: toBool(c.verboseLog, DEFAULTS.verboseLog),
      feedKeywords: toList(c.feedKeywords, toList(DEFAULTS.feedKeywords)),
      queryKeywords: toList(c.queryKeywords, toList(DEFAULTS.queryKeywords)),
      begText: String(c.begText ?? DEFAULTS.begText),
      ownerBegText: String(c.ownerBegText ?? DEFAULTS.ownerBegText),
      feedText: String(c.feedText ?? DEFAULTS.feedText),
      feedFullText: String(c.feedFullText ?? DEFAULTS.feedFullText),
      noCakeText: String(c.noCakeText ?? DEFAULTS.noCakeText),
      queryText: String(c.queryText ?? DEFAULTS.queryText)
    };
  }

  /**
   * 主人 QQ 号。除了本插件自己的设置，还去读**主人识别技能**的配置
   * （config.skills['owner-identity'].ids）—— 那是这个应用里"谁是主人"的
   * 唯一权威来源，复制一份到本插件会立刻出现"两处不一致"的问题。
   * 它由 api.config() 侧读不到（那是本技能自己的命名空间），所以直接读盘。
   * 注：owner-identity 技能本身可能没安装，配置段却仍在，所以照读不误。
   */
  function ownerIds() {
    const c = api.config() || {};
    return [...new Set([...toList(c.ownerIds, []), ...toList(readOwnerFromCore(), [])])];
  }
  function readOwnerFromCore() {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8'));
      return raw?.skills?.['owner-identity']?.ids;
    } catch { return ''; }
  }

  /** 会话标识：群聊用 group:群号；私聊一律不参与（本插件只管群）。 */
  function groupKeyOf(ctx) {
    const ck = String(ctx?.chatKey ?? '').trim();
    if (ck) return ck.startsWith('group:') ? ck : '';
    const kind = String(ctx?.kind ?? '').trim();
    const id = String(ctx?.chatId ?? '').trim();
    return kind === 'group' && id ? `group:${id}` : '';
  }

  // ── 自然恢复（懒计算）──────────────────────────────────────────────────────
  //
  // ⚠️ 刻意**不用** setInterval 每秒 +1：那样进程一关就停，重启后还要补算，
  //    而且要在内存里维护一堆定时器。改成按时间戳一次性补齐：
  //    存 lastSettle（上次结算时刻），下次任何人读体力时算
  //    "过了几个恢复周期 × 每周期恢复量"，再把 lastSettle 推进相应整周期。
  //    好处：关机/重启/休眠都不漏算，也不会多算（余数留在 lastSettle 里）。
  // 返回值：本次实际补了多少点（0 = 没补）。
  function settle(rec, c, now = Date.now()) {
    // 用户把上限调小时，存量必须跟着降下来 —— 否则会留下"体力 24/20"这种越界
    // 状态，之后每一次读取都显示超过上限，看起来像体力条坏了。
    if (rec.stamina > c.maxStamina) rec.stamina = c.maxStamina;
    if (c.recoverAmount <= 0) { rec.lastSettle = now; return 0; }
    const periodMs = c.recoverMinutes * 60000;
    const elapsed = now - rec.lastSettle;
    if (elapsed < periodMs) return 0;
    const periods = Math.floor(elapsed / periodMs);
    // 先把锚点推进整周期数（余数保留，保证"每 5 分钟"不被读取频率带偏）
    rec.lastSettle += periods * periodMs;
    if (rec.stamina >= c.maxStamina) return 0;
    const before = rec.stamina;
    rec.stamina = Math.min(c.maxStamina, rec.stamina + periods * c.recoverAmount);
    return rec.stamina - before;
  }

  /** 只读地看当前体力（不改盘）：供查询与日志用。 */
  function peekStamina(rec, c) {
    const now = Date.now();
    // 无论走哪个分支都要夹到上限：上限被调小时存量可能越界（见 settle 的注释）
    if (c.recoverAmount <= 0) return Math.min(rec.stamina, c.maxStamina);
    const periodMs = c.recoverMinutes * 60000;
    const periods = Math.floor(Math.max(0, now - rec.lastSettle) / periodMs);
    if (periods <= 0 || rec.stamina >= c.maxStamina) return Math.min(rec.stamina, c.maxStamina);
    return Math.min(c.maxStamina, rec.stamina + periods * c.recoverAmount);
  }

  /** 一次读改写：所有写操作都走这里，保证不丢更新。 */
  async function mutate(fn) {
    return withLock(STORE_FILE, () => {
      // 读盘时就带上**当前生效的上限**，否则 normalizeChat 会拿默认值把余额夹掉
      // （见 normalizeChat 的注释 —— 那正是"投喂涨不上去"的成因）。
      const store = readStore(cfg().maxStamina);
      const out = fn(store);
      pruneCakes(store);
      writeStore(store);
      return out;
    });
  }

  // ── 发送通道 ──────────────────────────────────────────────────────────────
  //
  // 钩子的 context 里**没有** sender/onebot（已核对 orchestrator.js:776/876/1016/
  // 1140/1151 的组装），而 core 的 SendQueue / OneBotClient 都建在 createApp()
  // 闭包里、不导出单例，插件拿不到。所以本插件自己建一条**只发不收**的通道：
  //   · 不调 connect()，因此不会开第二条 WebSocket、不会收到重复事件；
  //   · 复用核心的 SendQueue（而不是裸调 onebot.sendSegments），这样 Markdown
  //     转纯文本、超长切分、CQ 转义、发送去重都还在 —— sender.js 明确要求
  //     "插件不得绕过本方法"。
  // ⚠️ 但**不能**给它 `new ChatStore()`：store.js 每会话在内存里缓存、saveChat
  //    整份覆盖写，第二个实例会把核心的消息记录清掉。这里只喂一个 appendSelf
  //    的空实现 —— 代价是本插件发的回执不进核心存档（它下次看不到自己说过
  //    "当前体力 43/60"），这是刻意选的：宁可少一条记录，也不能清空聊天记录。
  let transportPromise = null;

  async function transport() {
    if (!transportPromise) {
      transportPromise = (async () => {
        const [{ getConfig }, { OneBotClient }, { SendQueue }] = await Promise.all([
          import('../../src/config.js'),
          import('../../src/onebot.js'),
          import('../../src/sender.js')
        ]);
        const sl = getConfig()?.snowluma || {};
        const onebot = new OneBotClient({
          httpUrl: sl.httpUrl,
          accessToken: sl.accessToken,
          httpToken: sl.httpAccessToken || sl.accessToken
        });
        const storeShim = { appendSelf() { /* 见上面注释：不接管核心存档 */ } };
        return new SendQueue({ onebot, store: storeShim, log: (...a) => log(...a) });
      })().catch((e) => {
        warn(`发送通道初始化失败（体力回执/讨饭将不可用）：${e?.message ?? e}`);
        transportPromise = null;   // 下次重试
        return null;
      });
    }
    return transportPromise;
  }

  /** 往某个群发一条纯文本（可选 @ 某人）。失败只记日志，绝不抛给调用方。 */
  async function send(chatKey, text, atUserId = null) {
    const body = String(text ?? '').trim();
    if (!body) return false;
    const q = await transport();
    if (!q) return false;
    try {
      await q.sendTextBatch(chatKey, [body], { atUserId: atUserId || null });
      return true;
    } catch (e) {
      // 限频（send.maxPerMinute/maxPerHour）会在这里抛出，属正常保护，不当故障
      warn(`发送失败（${chatKey}）：${e?.message ?? e}`);
      return false;
    }
  }

  // ── 本次运行的状态（跨 hook 传递）─────────────────────────────────────────
  //
  // ⚠️ 必须带时间戳 + TTL。曾见同类插件只存一个布尔，结果 before-context 跑过、
  //    后续 hook 因为会话被中止没跑到，记录就永远留在 Map 里；同 chatKey 的下一次
  //    运行读到**上一次**的残留就是误判。TTL 让它不会跨轮次生效。
  const TTL_MS = 120000;
  const suppressed = new Map();   // sessionId -> at（本轮由系统代答，别让模型再发言）

  function markSuppressed(sessionId) {
    if (!sessionId) return;
    suppressed.set(String(sessionId), Date.now());
    const now = Date.now();
    for (const [k, t] of suppressed) if (now - t > TTL_MS) suppressed.delete(k);
  }
  function isSuppressed(sessionId) {
    const t = suppressed.get(String(sessionId ?? ''));
    if (!t) return false;
    if (Date.now() - t > TTL_MS) { suppressed.delete(String(sessionId)); return false; }
    return true;
  }

  /** 每个群的"本轮是否被系统代答过"提示，交给 before-llm-messages 注入一句话。 */
  const autoHandled = new Map();  // chatKey -> { at, notes: string[] }

  function noteAutoHandled(chatKey, note) {
    const cur = autoHandled.get(chatKey);
    if (cur && Date.now() - cur.at <= TTL_MS) cur.notes.push(note);
    else autoHandled.set(chatKey, { at: Date.now(), notes: [note] });
  }
  function takeAutoHandled(chatKey) {
    const cur = autoHandled.get(chatKey);
    autoHandled.delete(chatKey);
    if (!cur || Date.now() - cur.at > TTL_MS) return null;
    return cur.notes;
  }

  // ── 计费口径 ──────────────────────────────────────────────────────────────

  /** 这次工具调用要花多少体力；0 = 不归本插件管。 */
  function costOf(toolName, argsRaw, c) {
    const name = String(toolName ?? '');
    let args = {};
    try { args = JSON.parse(argsRaw || '{}') || {}; } catch { /* 参数不是合法 JSON：按一次算 */ }
    if (c.imageTools.has(name)) {
      return { kind: 'image', units: 1, cost: c.costPerImage };
    }
    if (c.speechTools.has(name)) {
      // 按"这一批要发几条"计费：send_message 的 messages 传数组就是分多条发送，
      // 发 3 条扣 3 份。空/全是空白 → 交给工具自己报错，这里按 1 算不影响结果。
      const m = args?.messages;
      const units = Array.isArray(m)
        ? Math.max(1, m.filter((x) => String(x ?? '').trim()).length)
        : 1;
      return { kind: 'speech', units, cost: units * c.costPerMessage };
    }
    return { kind: null, units: 0, cost: 0 };
  }

  // ── 钩子 1：before-context ────────────────────────────────────────────────
  // 两件事：① 记下"这个群刚有人说话"（讨饭只挑活人多的群）；② 确定性处理
  // @机器人 的「投喂鱼饼」「查询体力」指令。
  //
  // ⚠️ 这里**不擦** triggerEntries 的 text。triggerEntries 是浅拷贝数组、但元素
  //    与核心存档**是同一批对象**（store.js drainUnread 直接返回 st.messages 里的
  //    条目，没克隆）—— 改 m.text 会把群友那条消息在内存存档里一起改坏。所以
  //    指令消息原样留给模型看，靠下面的 suppress 机制保证它不会重复回一遍。
  hooks['before-context'] = async function beforeContext(ctx) {
    const chatKey = groupKeyOf(ctx);
    if (!chatKey) return;   // 私聊：整套体力机制不生效
    const c = cfg();
    const entries = Array.isArray(ctx?.triggerEntries) ? ctx.triggerEntries : [];

    // ① 记录活跃时间（讨饭窗口判定用）
    try {
      const info = await mutate((store) => {
        const rec = store.chats[chatKey] || (store.chats[chatKey] = normalizeChat(null, c.maxStamina));
        rec.lastActiveAt = Date.now();
        const gained = settle(rec, c);
        return { gained, stamina: rec.stamina, max: c.maxStamina };
      });
      if (info.gained > 0) {
        logChange(chatKey, `自然恢复 +${Math.round(info.gained * 100) / 100} → ${Math.round(info.stamina * 100) / 100}/${info.max}`);
      }
    } catch (e) {
      warn(`记录活跃时间失败：${e?.message ?? e}`);
    }

    if (!entries.length) return;

    // ② 找出 @机器人 的指令消息
    const owners = ownerIds();
    let handled = 0;
    for (const m of entries) {
      if (!m || m.self || m.atMe !== true) continue;
      const text = String(m.text ?? '');
      const senderId = String(m.senderId ?? '').trim();
      if (!senderId) continue;

      const isFeed = hasKeyword(text, c.feedKeywords);
      const isQuery = hasKeyword(text, c.queryKeywords);
      if (!isFeed && !isQuery) continue;

      // 查询优先于投喂（文案里同时出现两个词时，"查询体力"更可能是本意）
      const action = isQuery ? 'query' : 'feed';
      try {
        const reply = await handleCommand({ action, chatKey, senderId, senderName: m.senderName, c, owners });
        if (reply) {
          handled += 1;
          await send(chatKey, reply.text, reply.atUserId);
          noteAutoHandled(chatKey, action === 'query'
            ? `有人 @ 你查询体力，系统已经替你把「${reply.text}」发出去了。`
            : `有人 @ 你投喂鱼饼，系统已经替你回执「${reply.text}」了。`);
        }
      } catch (e) {
        warn(`处理指令失败：${e?.message ?? e}`);
      }
    }

    // ③ 整批都是指令 → 本轮没有任何"需要模型动脑"的内容，干脆别让它发言
    if (handled > 0 && handled === entries.filter((m) => m && !m.self).length) {
      markSuppressed(ctx?.sessionId);
    }
  };

  /**
   * 执行一条指令，返回 { text, atUserId } 或 null。
   * 这是纯确定性的：不经过 LLM，所以"查询体力"永远是准的。
   */
  async function handleCommand({ action, chatKey, senderId, senderName, c, owners }) {
    const isOwner = owners.includes(senderId);
    const name = String(senderName || senderId).slice(0, 24);

    if (action === 'query') {
      const { stamina, max } = await mutate((store) => {
        const rec = store.chats[chatKey] || (store.chats[chatKey] = normalizeChat(null, c.maxStamina));
        rec.lastActiveAt = Date.now();
        settle(rec, c);
        return { stamina: Math.round(rec.stamina * 100) / 100, max: c.maxStamina };
      });
      return { text: fill(c.queryText, { stamina, max: c.maxStamina, name }), atUserId: null };
    }

    // ── 投喂 ──
    return mutate((store) => {
      const rec = store.chats[chatKey] || (store.chats[chatKey] = normalizeChat(null, c.maxStamina));
      rec.lastActiveAt = Date.now();
      settle(rec, c);
      const max = c.maxStamina;
      const cur = rec.stamina;

      // 已经满了：**不消耗**对方当天的鱼饼额度 —— 否则"喂了个寂寞"还倒扣一次机会
      if (cur >= max) {
        logChange(chatKey, `${senderId} 投喂时体力已满（${Math.round(cur * 100) / 100}/${max}），不消耗额度`);
        return { text: fill(c.feedFullText, { name, stamina: Math.round(cur * 100) / 100, max }), atUserId: null };
      }

      // 主人鱼饼无限
      if (isOwner) {
        const gain = Math.min(c.fishCakeRestore, max - cur);
        rec.stamina = Math.min(max, cur + c.fishCakeRestore);
        logChange(chatKey, `${senderId}(主人) 投喂 +${Math.round(gain * 100) / 100} → ${Math.round(rec.stamina * 100) / 100}/${max}`);
        return {
          text: fill(c.feedText, { name, gain: Math.round(gain * 100) / 100, stamina: Math.round(rec.stamina * 100) / 100, max }),
          atUserId: null
        };
      }

      // 群友：按「群 + 人 + 当天」记账。按天存 = 跨天自动满额（不叠加）
      const day = localDate();
      const usedToday = Number(rec.cakes?.[day]?.[senderId]) || 0;
      if (usedToday >= c.fishCakesPerDay) {
        logChange(chatKey, `${senderId} 投喂被拒（今日额度已用完 ${usedToday}/${c.fishCakesPerDay}）`);
        return { text: fill(c.noCakeText, { name, stamina: Math.round(cur * 100) / 100, max }), atUserId: null };
      }

      rec.cakes[day] = rec.cakes[day] || {};
      rec.cakes[day][senderId] = usedToday + 1;
      const gain = Math.min(c.fishCakeRestore, max - cur);
      rec.stamina = Math.min(max, cur + c.fishCakeRestore);
      logChange(chatKey, `${senderId} 投喂 +${Math.round(gain * 100) / 100} → ${Math.round(rec.stamina * 100) / 100}/${max}（今日 ${usedToday + 1}/${c.fishCakesPerDay}）`);
      return {
        text: fill(c.feedText, { name, gain: Math.round(gain * 100) / 100, stamina: Math.round(rec.stamina * 100) / 100, max }),
        atUserId: null
      };
    });
  }

  // ── 钩子 2：before-llm-messages ───────────────────────────────────────────
  // 告诉模型"这条指令系统已经代答了，别重复回"。只在确实代答过时追加，
  // 正常对话里这段不存在（不占 token、不干扰行为）。
  hooks['before-llm-messages'] = function beforeLlmMessages(ctx) {
    const chatKey = groupKeyOf(ctx);
    if (!chatKey || !Array.isArray(ctx?.messages)) return;
    const notes = takeAutoHandled(chatKey);
    if (!notes?.length) return;
    ctx.messages.push({
      role: 'system',
      content: `【系统】${notes.join('')}\n这条已经处理完了：**不要**再回复、不要复述、不要调用任何发送工具去回应它；`
        + '如果本轮没有别的内容要处理，直接结束。'
    });
  };

  // ── 钩子 3：before-tool（只查余额，不扣钱）────────────────────────────────
  // 这是**唯一读返回值**的钩子：返回 { block:true, reason } 就否决这次调用。
  // 计费不在这里做 —— 否决之外的失败（网络、限频）不该扣钱，扣钱交给 after-tool。
  hooks['before-tool'] = async function beforeTool(ctx) {
    const chatKey = groupKeyOf(ctx);
    if (!chatKey) return undefined;
    const c = cfg();

    // 本轮已由系统代答 → 拦住模型自己再发一遍（钩子无法中止整轮，
    // 这是"不让它重复回"的唯一硬手段）
    const toolName = String(ctx?.toolName ?? '');
    if (isSuppressed(ctx?.sessionId) && (c.speechTools.has(toolName) || c.imageTools.has(toolName))) {
      return { block: true, reason: '本轮内容已由系统直接处理并回复完毕，不需要你再发言。请直接结束本次处理。' };
    }

    const { cost, kind, units } = costOf(toolName, ctx?.argsRaw, c);
    if (!kind || cost <= 0) return undefined;

    try {
      const info = await mutate((store) => {
        const rec = store.chats[chatKey] || (store.chats[chatKey] = normalizeChat(null, c.maxStamina));
        settle(rec, c);
        return { stamina: rec.stamina };
      });
      if (info.stamina >= cost) return undefined;
      if (!c.blockWhenZero) return undefined;
      const what = kind === 'image' ? '生图' : `发言 ${units} 条`;
      logChange(chatKey, `体力不足，拦下 ${toolName}（需 ${cost}，现有 ${Math.round(info.stamina * 100) / 100}）`);
      return {
        block: true,
        reason: `${BLOCK_MARK}体力不够了（需要 ${cost} 点，当前只有 ${Math.round(info.stamina * 100) / 100} 点，上限 ${c.maxStamina}）。`
          + `这次${what}发不出去。别反复重试；先讨个鱼饼（在群里说「@我 投喂鱼饼」，群友每人每天有 ${c.fishCakesPerDay} 个，主人无限），或者等体力自然恢复（每 ${c.recoverMinutes} 分钟回 ${c.recoverAmount} 点）。`
      };
    } catch (e) {
      warn(`体力检查失败，本次放行：${e?.message ?? e}`);
      return undefined;
    }
  };

  // ── 钩子 4：after-tool（真正扣钱）─────────────────────────────────────────
  // 只认成功：被 before-tool 否决的调用也会走到这里（拿到的是错误对象），
  // 靠 BLOCK_MARK 认出来跳过；工具自身报错（网络失败等）同样不扣。
  hooks['after-tool'] = async function afterTool(ctx) {
    const chatKey = groupKeyOf(ctx);
    if (!chatKey) return;
    const c = cfg();
    const toolName = String(ctx?.toolName ?? '');
    const { cost, kind, units } = costOf(toolName, ctx?.argsRaw, c);
    if (!kind || cost <= 0) return;

    const result = ctx?.result;
    if (result?.isError) return;                                    // 没发出去，不扣
    if (String(result?.content ?? '').includes(BLOCK_MARK)) return;  // 被本插件否决的，不扣

    try {
      const info = await mutate((store) => {
        const rec = store.chats[chatKey] || (store.chats[chatKey] = normalizeChat(null, c.maxStamina));
        const gained = settle(rec, c);
        // 下限夹到 0：blockWhenZero 关掉时允许"欠着"，但余额不为负
        rec.stamina = Math.max(0, rec.stamina - cost);
        return { stamina: rec.stamina, max: c.maxStamina, gained };
      });
      const what = kind === 'image' ? '生图' : `发言 ${units} 条`;
      logChange(chatKey, `${what} -${cost} → ${Math.round(info.stamina * 100) / 100}/${info.max}`
        + (info.gained > 0 ? `（期间自然恢复 +${info.gained}）` : ''));
    } catch (e) {
      warn(`扣除体力失败：${e?.message ?? e}`);
    }
  };

  // ── 工具：查询体力（给模型兜底）───────────────────────────────────────────
  // @机器人 说「查询体力」由 before-context 确定性处理；这个工具是给**口语化**
  // 提问兜底的（"你还剩多少体力""你是不是饿了"），只读、无副作用。
  api.registerTool({
    id: 'query',
    name: '查询体力',
    description: '查询**当前群**机器人的剩余体力值（每个群各一份，私聊没有这套机制）。'
      + '当有人用大白话问"你还剩多少体力""你饿不饿""还能说几句"时调用。'
      + '注意：如果对方是 @ 你说「查询体力」，系统已经自动回复过了，不要再重复调用。',
    category: 'query',
    icon: '🔋',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      const chatKey = groupKeyOf(ctx);
      if (!chatKey) {
        return ok({ ok: false, reason: '私聊里没有体力机制（体力按群独立计算）' });
      }
      const c = cfg();
      try {
        const info = await mutate((store) => {
          const rec = store.chats[chatKey] || (store.chats[chatKey] = normalizeChat(null, c.maxStamina));
          const gained = settle(rec, c);
          const day = localDate();
          return {
            stamina: Math.round(rec.stamina * 100) / 100,
            max: c.maxStamina,
            gained,
            begThreshold: c.begThreshold,
            hungry: rec.stamina < c.begThreshold,
            cakesToday: Object.keys(rec.cakes?.[day] || {}).length
          };
        });
        return ok({
          ok: true,
          chatKey,
          stamina: info.stamina,
          max: info.max,
          percent: info.max ? Math.round((info.stamina / info.max) * 100) : 0,
          recoveredJustNow: info.gained || undefined,
          hungry: info.hungry,
          costs: { perMessage: c.costPerMessage, perImage: c.costPerImage },
          recovery: `每 ${c.recoverMinutes} 分钟回 ${c.recoverAmount} 点`,
          note: info.hungry
            ? `体力偏低（低于 ${c.begThreshold}），该讨饭了：让群友 @ 你说「投喂鱼饼」。`
            : '体力充足。'
        });
      } catch (e) {
        return err(`查询体力失败：${e?.message ?? e}`);
      }
    }
  });

  // ── 讨饭循环 ──────────────────────────────────────────────────────────────
  //
  // 只在**最近有人说过话**的群里出声（否则会在早就没人气的群里自言自语）。
  // 讨饭消息由本插件直接发出，**不经过 before-tool**，所以天然不扣体力 ——
  // 这正是"乞求信息不消耗体力"的实现方式。
  let timer = null;

  async function begTick() {
    const c = cfg();
    if (!c.proactiveBeg) return;
    const now = Date.now();
    let store;
    try { store = readStore(c.maxStamina); } catch (e) { warn(`讨饭循环读取失败：${e?.message ?? e}`); return; }
    const owners = ownerIds();

    for (const [chatKey, rec] of Object.entries(store.chats)) {
      if (!chatKey.startsWith('group:')) continue;
      const cur = peekStamina(rec, c);
      if (cur >= c.begThreshold) continue;                       // 还不饿
      if (c.begWindowMs > 0 && now - (rec.lastActiveAt || 0) > c.begWindowMs) continue;  // 群里早没人了

      // 归零 → @主人求救（比在群里泛泛讨饭更明确）
      if (cur <= 0 && owners.length) {
        if (now - (rec.lastOwnerBegAt || 0) < c.ownerBegCooldownMs) continue;
        const target = owners[0];
        const text = fill(c.ownerBegText, { stamina: 0, max: c.maxStamina });
        const sent = await send(chatKey, text, target);
        if (sent) {
          try {
            await mutate((s) => {
              const r = s.chats[chatKey];
              if (r) { r.lastOwnerBegAt = Date.now(); r.lastBegAt = Date.now(); }
            });
          } catch { /* 记不上就下一轮再说 */ }
          log(`体力归零，已在 ${chatKey} @主人(${target}) 求救`);
        }
        continue;
      }

      // 低于阈值（但还没归零）→ 在群里讨饭
      if (now - (rec.lastBegAt || 0) < c.begCooldownMs) continue;
      const text = fill(c.begText, { stamina: Math.round(cur * 100) / 100, max: c.maxStamina });
      const sent = await send(chatKey, text);
      if (sent) {
        try {
          await mutate((s) => { const r = s.chats[chatKey]; if (r) r.lastBegAt = Date.now(); });
        } catch { /* 同上 */ }
        log(`体力偏低（${Math.round(cur * 100) / 100}/${c.maxStamina}），已在 ${chatKey} 讨饭`);
      }
    }
  }

  function startTimer() {
    stopTimer();
    const c = cfg();
    timer = setInterval(() => { begTick().catch((e) => warn(`讨饭循环出错：${e?.message ?? e}`)); }, c.checkIntervalMs);
    // unref：这个定时器不该阻止进程退出（否则关不掉程序）
    timer.unref?.();
  }
  function stopTimer() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  // ── 生命周期 ──────────────────────────────────────────────────────────────
  //
  // ⚠️⚠️ 这里必须**同时**做两件事，否则讨饭定时器根本不会启动：
  //   ① 在模块顶层 `export function activate/deactivate/dispose/available`；
  //   ② setup 里把真正的实现挂到模块级变量上，让 ① 转发过去。
  //
  // 原因是加载器（plugin-loader.js:429-435）取的是**模块导出**：
  //     activate: typeof mod.activate === 'function' ? mod.activate : null,
  // 而 `await setupFn(api)` 的**返回值是被丢掉的**（同文件 :368）。
  // 也就是说"在 setup 里 return { activate(){} }"这种写法在本版本里是**静默失效**的
  // —— 不报错、不告警，只是永远没人调用它。本项目现有的三个扩展
  // （todo-list / blacklist-manager / knowledge-base）都踩了这个坑：它们的
  // activate/deactivate 从来没被执行过。本插件不再重复它。
  //
  // 为什么要有 ② 这层转发：activate 需要用到 cfg()/startTimer()/readStore()
  // 这些定义在 setup 闭包里的东西，而模块导出必须在顶层。用变量把它们接起来。
  // 热重载时旧模块实例有自己的 lifecycle 变量，旧 deactivate 停的是旧定时器，
  // 新 setup 覆盖新的那份 —— 两边互不干扰，不会留下幽灵定时器。

  lifecycle = {
    // 目录不可写（磁盘只读/权限不足）时整体不可用，控制台直接说明原因，
    // 比让模型每次白调一次再收到"写入失败"要好。
    // ⚠️ 这里**故意不创建目录**：只在目录已存在时探测可写性。技能在加载/自检
    //    阶段擅自建目录，会让"用户根本没打算用体力"也留下一个空目录。
    //    真正的创建发生在第一次写入时（writeStore 里的 mkdirSync）。
    available() {
      try {
        if (!fs.existsSync(DATA_DIR)) return true;   // 还没用过 → 放行，首次写入时再建
        fs.accessSync(DATA_DIR, fs.constants.W_OK);
        return true;
      } catch (e) {
        return { ok: false, reason: `数据目录不可写：${DATA_DIR}（${e?.message ?? e}）` };
      }
    },
    activate() {
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        // 落地一次数据文件当"心跳"。为什么要多此一举：本插件的症状是**沉默的**
        // —— 没加载时它不会报错，只是什么都不扣、什么都不加，看起来像"数值坏了"。
        // 有了这个文件，判断"到底加载没有"只需看它存不存在，不用去翻日志。
        // （2026-10-11 的排查就是靠"文件不存在"一步定位到"根本没加载"。）
        const c = cfg();
        // 先把当前配置读出来，再读盘 —— readStore 需要用它当夹取上限（见 normalizeChat）。
        // 原来这两行的顺序反了，readStore() 拿默认值 60 夹了一遍，于是
        // activate 时 writeStore 就把用户配的 100 直接写成 60。
        writeStore(readStore(c.maxStamina));
        const store = readStore(c.maxStamina);
        const groups = Object.keys(store.chats).length;
        const hungry = Object.entries(store.chats)
          .filter(([k, r]) => k.startsWith('group:') && peekStamina(r, c) < c.begThreshold).length;
        log(`已就绪：${groups} 个群有体力记录（${hungry} 个在饿肚子），上限 ${c.maxStamina}，`
          + `每 ${c.recoverMinutes} 分钟回 ${c.recoverAmount} 点，数据文件 ${STORE_FILE}`);
        // 往自己的日志文件也写一条启动标记：api.log 不进日志文件（见 logChange 注释），
        // 而"插件到底有没有被加载"必须有个看得见的地方回答。
        logChange('-', `===== 插件已激活 v${VERSION}（上限 ${c.maxStamina}，每 ${c.recoverMinutes} 分钟回 ${c.recoverAmount} 点，`
          + `发言 -${c.costPerMessage}，生图 -${c.costPerImage}，拦截=${c.blockWhenZero ? '开' : '关'}）=====`);
        if (c.proactiveBeg) {
          startTimer();
          log(`讨饭循环已启动（每 ${Math.round(c.checkIntervalMs / 1000)} 秒检查一次；`
            + `低于 ${c.begThreshold} 讨饭，归零时 @主人）`);
        }
      } catch (e) {
        warn(`体力插件初始化失败：${e?.message ?? e}`);
      }
    },
    deactivate() {
      stopTimer();
      suppressed.clear();
      autoHandled.clear();
    },
    dispose() {
      stopTimer();
      suppressed.clear();
      autoHandled.clear();
      queues.clear();
      transportPromise = null;
    }
  };
  return lifecycle;
}
