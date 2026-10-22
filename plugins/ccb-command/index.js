// CCB 指令（ccb-command）：群里有人发「/ccb @某人」→ 机器人固定回一条
// 「你和'某人'ccb了'随机数'分钟，注入了'随机数'的今夜！可喜可贺」，
// 两个随机数都带两位小数，四档分布：
//   80% → 1.00~100.00   15% → 100.01~1000.00   4% → 1000.01~10000.00   1% → 10000.01~100000000.00；
// 另有 20% 概率多回「恭喜怀上！」、5% 概率多回「非常抱歉！你的急急炸掉了！杂口杂口！」。
//
// ── 为什么是「确定性型插件」而不是 LLM 型技能 ──────────────────────────────
// 行为是**规则写死**的：指令词能枚举、随机数由本地 Math.random 产生、概率写死成百分比。
// 这类"条件满足就必须照做"的需求放 plugins/（确定性型），核心按能力名取用、不经过 LLM，
// 模型想漏掉也漏不掉 —— 而放进 skills/ 会变成"给模型一个工具，用不用它自己看着办"，
// 结果就是"有时回有时不回"。判据：规则能写死 → 插件；要理解人话 → 技能。
//
// ── 为什么包 Orchestrator.prototype.onIncoming ────────────────────────────
// 核心的 5 个 hook（before-context / before-llm-messages / after-response /
// before-tool / after-tool）都只在**已经排定一次模型会话之后**才触发。而本指令必须
// 在"这条消息到底要不要叫醒模型"之前就命中：默认响应档位是"仅被 @ 时响应"，
// 而「/ccb @某人」@ 的是别人、不是机器人 —— 这一步就被判定为"不触发"并标已读了，
// 任何 hook 都看不见它（与 repeat-echo / welcome-newcomer 踩的是同一个坑）。
// onIncoming 是**每一条**入站消息的必经点，且 this 上挂着 sender 与 store。
//
// ── 安全边界 ──────────────────────────────────────────────────────────────
//   · 只读自己的设置、只发本群消息；走 sender.sendTextBatch 完整发送管道
//     （睡眠时段 / 发送限频 / 去重 / 存档 / 引用与 @ 规则全部照常生效）；
//   · 默认 consumeCommand=true 时命中指令会 veto：把这条标已读并**不调用**原方法，
//     避免"插件回一条 + 模型再回一条"叠成两条；
//   · 非群聊、机器自己的消息、没 @ 到人的 /ccb 一律不碰；
//   · 异常全部收口在 try/catch，绝不影响原方法（最坏是这一条没有回应）；
//   · 关掉开关 / 卸载插件 = 摘钩子，不留任何监听。
//
// ⚠️ 本文件在 resources/app 里，应用自动更新会覆盖；把 plugins/ccb-command/ 整个目录
//    备份一份、更新后拷回来即可（配置不受影响）。

import { Orchestrator } from '../../src/orchestrator.js';
// 主日志（data/logs/qq-agent-*.log）：本指令属于"她说了话但没经过模型"的动作，
// 必须留痕，否则事后翻日志只看到一条无来源的发送记录。api.log 只走 console、不落盘。
import { logger } from '../../src/logger.js';

const PLUGIN_ID = 'ccb-command';
// ⚠️ 用 Symbol.for：热重载后是新模块实例，普通 Symbol 认不出上一次挂的钩子，
//    结果会在 prototype 上越包越多层（一条指令回 N 遍）。
const PATCH_KEY = Symbol.for('qq-agent.ccb-command.onIncoming');
// 特征串：早期版本没有 __ccbWrapped 标记，只能靠**源码里出现的自身符号名**认出它
// （Symbol.for 的 key 会被打印在函数源码里，所以这是可靠的指纹，且不会误伤别的插件）。
const PATCH_KEY_SRC_HINT = 'qq-agent.ccb-command.onIncoming';
// 真实原方法的存放处。**必须挂在 prototype 上**：热重载换的是模块实例，
// 模块内的局部变量会跟着换新，只有挂在共享原型上的引用才能跨代存活。
// 少了它就会出现"新包装层把上一代包装层当成原方法"，多层套娃 → 栈溢出。
const ORIGINAL_KEY = Symbol.for('qq-agent.ccb-command.originalOnIncoming');
// 版本指纹：改代码时手动 +1，配合 activate 的日志确认"运行中的是哪一版"
// （热重载有时会装上改写过程中的中间态，日志里有指纹就不用猜）。
const BUILD = '1.1.0';

let api = null;
/** 同群冷却：groupId -> 上次回应时间戳 */
const lastAt = new Map();
let stats = { hits: 0, sent: 0, vetoed: 0, skippedCooldown: 0, failed: 0, lastAt: 0, lastGroup: '' };

// ── 设置读取 ─────────────────────────────────────────────────────────────
// 每次判定都现读 api.config()（已合并 manifest 的 settings 默认值），
// 控制台改设置后无需重载即刻生效。
function settings() {
  try { return api?.config?.() || {}; } catch { return {}; }
}

/** 彩蛋概率：限幅到 0~100，0 表示这个彩蛋永不出现。 */
function chancePercent(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(0, n));
}

/**
 * 四段分布（每次取值独立掷骰）。一律用"分"作整数单位，从根本上避免浮点误差。
 *
 *     80% →      1.00 ~     100.00
 *     15% →    100.01 ~    1000.00   ← 原要求写 101.00，见下方说明
 *      4% →   1000.01 ~   10000.00   ← 原要求写 1001.00
 *      1% →  10000.01 ~ 100000000.00 ← 原要求写 10001.00
 *
 * ⚠️ 关于每段的下界：要求给的是 101.00 / 1001.00 / 10001.00，与上一段的上界
 *    (100.00 / 1000.00 / 10000.00) 之间各留了 0.99 的空隙。这里取**紧邻上一段上界**的
 *    100.01 / 1000.01 / 10000.01，让 1.00~100000000.00 连续、不重不漏。
 *    若要严格照字面（接受三段空隙永远取不到），把 min 改成 10100 / 100100 / 1000100 即可。
 */
const TIERS = [
  { pct: 80, min: 100, max: 10_000 },                 //        1.00 ~     100.00
  { pct: 15, min: 10_001, max: 100_000 },             //      100.01 ~    1000.00
  { pct: 4, min: 100_001, max: 1_000_000 },           //     1000.01 ~   10000.00
  { pct: 1, min: 1_000_001, max: 10_000_000_000 }     //    10000.01 ~ 100000000.00
];
const TIER_TOTAL_PCT = TIERS.reduce((sum, t) => sum + t.pct, 0);   // = 100

function rollAmount() {
  // 第一步：按权重掷骰，决定落在哪一段（累加式，稳定且与其它档互不影响）
  let r = Math.random() * TIER_TOTAL_PCT;
  let tier = TIERS[TIERS.length - 1];
  for (const t of TIERS) {
    if (r < t.pct) { tier = t; break; }
    r -= t.pct;
  }
  // 第二步：在该段内均匀取一个"分"值（含两端）
  const span = Math.max(1, tier.max - tier.min + 1);
  const cents = tier.min + Math.floor(Math.random() * span);
  return (cents / 100).toFixed(2);
}

// ── 指令识别 ─────────────────────────────────────────────────────────────

/** 把指令词转成安全的字面量正则源（用户填 . 或 | 之类不该变成通配/分支）。 */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 从正文里剥掉最前面的 [引用 ...] 块。
 * 引用块里是**被引用者**的原话，不是本条消息的正文 ——
 * 不剥的话，引用一条含「/ccb」的消息会被误当成指令。
 * 与核心 prompt.js 的 stripReplyBlocks 同口径（按方括号深度找配对，找不到就不剥）。
 */
function stripLeadingReply(text) {
  let s = String(text ?? '');
  for (;;) {
    const start = s.indexOf('[引用');
    if (start < 0) break;
    let depth = 0;
    let end = -1;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (c === '[') depth++;
      else if (c === ']') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) break;                       // 没有配对的 ] → 保守不剥
    const rest = s.slice(end + 1);
    if (rest.trim()) return rest;             // 剥掉引用块，后面才是本条正文
    s = rest;                                 // 整条都是引用（剥完只剩空白）→ 继续找下一块 / 结束
  }
  return s;
}

/**
 * 解析「指令 + @某人」。
 *
 * 两种写法都认：
 *   · @ 在指令后面：/ccb @张三        （正常输入）
 *   · @ 在指令前面：@张三 /ccb        （QQ 里先点人再补字很常见）
 * @ 段在核心渲染时已经是 `@名字`（onebot.js 的 segmentsToText），
 * 若装了 speaker-identity 一类能力还会被规范化成 `@名字(QQ:123)`，这里一并剥掉。
 *
 * @returns {{ name: string } | null} 没 @ 到具体的人（或 @全体成员）时返回 null
 */
function parseCommand(text, commandWord) {
  const cmd = escapeRe(commandWord);
  // 说明：不用 \s* 允许空名字 —— "@ " 后面什么都没有不该算数。
  const after = new RegExp(`^\\s*${cmd}\\s+@\\s*([^@\\[\\]\\n]+)`, 'i');   // 指令在前
  const before = new RegExp(`^\\s*@\\s*([^@\\[\\]\\n]+?)\\s+${cmd}(?:\\s|$)`, 'i'); // @ 在前
  const m = after.exec(text) || before.exec(text);
  if (!m) return null;

  // 名字可能带 (QQ:12345) 后缀 —— 渲染层为了区分同名不同人而加，不该念出来
  let name = String(m[1] ?? '').replace(/\(QQ:\d+\)\s*$/i, '').trim();
  // 名字里跟着别的 @ 段时，只取第一个（"@张三@李四" 取张三、舍弃李四）
  const at = name.indexOf('@');
  if (at > 0) name = name.slice(0, at).trim();
  if (!name) return null;
  if (name === '全体成员') return null;      // @全体成员 不是"某个人"
  // 「@123456」这种没解析出昵称的形态也认（长度兜底，防把整句话当名字念出去）
  return { name: name.slice(0, 64) };
}

/** 生成正文。两个数字各自独立掷骰取值（可能相同），都带两位小数。 */
function buildLines(name, s) {
  const body = `你和'${name}'ccb了${rollAmount()}分钟，注入了${rollAmount()}的今夜！可喜可贺`;
  const lines = [body];
  // 两个彩蛋各自独立掷骰：正文永远发，彩蛋是附加（所以两者可能同时命中）
  if (Math.random() * 100 < chancePercent(s.pregnantChance, 20)) lines.push('恭喜怀上！');
  if (Math.random() * 100 < chancePercent(s.explodeChance, 5)) lines.push('非常抱歉！你的急急炸掉了！杂口杂口！');
  return lines;
}

// ── 消息处理（纯同步：只做判定与排发送，绝不 await）─────────────────────
// ⚠️ 绝不能在这里 await：onIncoming 是核心的**同步**方法，包装层若返回 Promise，
//    调用方拿不到 'veto'（见 install()），拦指令与"标已读"都会失效。
function handle(orch, chatKey, entry) {
  const key = String(chatKey ?? '');
  if (!key.startsWith('group:')) return false;        // 只做群聊
  if (!entry || entry.self === true) return false;    // 机器自己的发言不触发
  const s = settings();
  if (s.enabled === false) return false;              // 开关关了就纯旁观

  const word = String(s.command ?? '/ccb').trim() || '/ccb';
  const hit = parseCommand(stripLeadingReply(entry.text), word);
  if (!hit) return false;

  // 同群冷却：防有人连点把机器人刷成复读怪。
  // 刻意"丢弃整次判定"而不是"只丢彩蛋"：连点时本来就不该再多回一条。
  const cooldownMs = Math.max(0, Number(s.cooldownSec) || 0) * 1000;
  const now = Date.now();
  const prev = lastAt.get(key) || 0;
  if (cooldownMs > 0 && now - prev < cooldownMs) {
    stats.skippedCooldown++;
    logger.info(PLUGIN_ID, `${key} 命中指令但被同群冷却拦下（剩余 ${Math.ceil((cooldownMs - (now - prev)) / 1000)} 秒）`);
    // 仍然拦下这条：否则模型会接一句，冷却形同虚设
    return veto(orch, key, entry, s);
  }
  lastAt.set(key, now);
  // 冷却表上限：群很多时不让 Map 无限涨（写满就整体清，代价只是冷却被重置一次）
  if (lastAt.size > 2000) lastAt.clear();

  const lines = buildLines(hit.name, s);
  stats.hits++;
  stats.lastAt = now;
  stats.lastGroup = key;

  const sender = orch?.sender;
  if (!sender || typeof sender.sendTextBatch !== 'function') {
    stats.failed++;
    logger.warn(PLUGIN_ID, '拿不到 sender（发送管道），这次没发出去');
    return veto(orch, key, entry, s);
  }

  // 不 await：排进发送队列就走（串行 / 限频 / 去重 / 存档都在管道里）。
  // 失败只记日志：睡眠时段、限频、去重都可能抛，属于正常业务拒绝，不该刷错误。
  Promise.resolve(sender.sendTextBatch(key, lines))
    .then(() => {
      stats.sent++;
      logger.info(PLUGIN_ID, `${key} ccb → ${hit.name}（${lines.length} 条）`);
    })
    .catch((error) => {
      stats.failed++;
      logger.warn(PLUGIN_ID, `ccb 没发出去：${error?.message ?? error}`);
    });

  return veto(orch, key, entry, s);
}

/**
 * 命中指令后要不要"吃掉"这条消息。
 * 吃掉 = 标已读 + 让包装层不调用原 onIncoming（模型不会被唤醒）。
 * 不做的话：响应档位是"全响应/概率响应"的群里会变成"插件回一条 + 模型再回一条"。
 */
function veto(orch, key, entry, s) {
  if (s.consumeCommand === false) return false;
  try {
    orch?.store?.markEntryRead?.(String(key), entry?.id);
    orch?.emit?.('chat-update', String(key));
  } catch { /* 标不了已读也照样拦，最坏是这条留在未读堆里 */ }
  stats.vetoed++;
  return true;
}

// ── 挂载 / 摘除 ──────────────────────────────────────────────────────────

/**
 * 包一层 Orchestrator.prototype.onIncoming。
 * 幂等：同一个 prototype 上只包一次（PATCH_KEY 记着原始方法与我们的包装），
 * 所以热重载只会换掉 handle 指向的函数，不会出现"包两层、回两遍"。
 */
function install() {
  const proto = Orchestrator?.prototype;
  if (!proto || typeof proto.onIncoming !== 'function') {
    logger.warn(PLUGIN_ID, '拿不到 Orchestrator.prototype.onIncoming，CCB 指令未挂载（应用版本可能变了）');
    return false;
  }

  // ── 找到真正的原方法（绝不允许是我们自己的包装层）────────────────────────
  // 三条来源按可信度排序：
  //   ① 原型上的真身缓存（ORIGINAL_KEY）—— 最可信，命中时连链子都不用走；
  //   ② 当前记录里的 original —— 记录是"我们装的这一层"的元数据，可信；
  //   ③ 顺着 __ccbInner 往下走 —— 只给"包装层在、记录丢了"的残留情况兜底。
  // ⚠️ ③ 必须只当兜底。若把它放在最优先，遇到一个"没有 __ccbInner 标记的旧包装层"
  //    就会把它误认成真身，链子从此多套一层（本项目实测复现过这个缺口）。
  const findRealOriginal = (start) => {
    let fn = start;
    for (let i = 0; i < 50; i++) {
      if (typeof fn !== 'function') return null;
      if (!fn.__ccbInner) return fn;      // 没有我们的标记 = 真正的核心方法
      fn = fn.__ccbInner;
    }
    return null;
  };
  const isOurs = (fn) => typeof fn === 'function' && fn.__ccbWrapped === true;

  const prevRec = proto[PATCH_KEY];
  let realOriginal = null;
  for (const cand of [proto[ORIGINAL_KEY], prevRec?.original, findRealOriginal(proto.onIncoming)]) {
    if (typeof cand === 'function' && !isOurs(cand)) { realOriginal = cand; break; }
  }
  if (typeof realOriginal !== 'function') {
    logger.warn(PLUGIN_ID, '找不到真正的 onIncoming（包装链异常），本次不挂载');
    return false;
  }
  // 存到共享原型上：下一次热重载/新模块实例直接取这里，不会再走偏
  proto[ORIGINAL_KEY] = realOriginal;

  let rec = proto[PATCH_KEY];
  // 换掉包装层的三种情况（其余情况复用旧包装层 = 幂等，热重载只换 handle）：
  //   ① 还没有记录；
  //   ② 记录里的真身与本次认定的真身不一致（上一代残留 / 记录被清过）；
  //   ③ 记录自己的包装层已损坏（真身指向自己 → 会递归），必须重建。
  const brokenRec = Boolean(rec) && (rec.wrapped?.__ccbInner === rec.wrapped || rec.original === rec.wrapped);
  if (!rec || rec.original !== realOriginal || brokenRec) {
    const original = realOriginal;
    const wrapped = function onIncoming(chatKey, entry = null) {
      // 取当时的 handle（不是闭包里的那个）：热重载后新实例换了 handle，
      // 旧包装层也能立刻指向新逻辑。
      try {
        const cur = proto[PATCH_KEY];
        if (cur && typeof cur.handle === 'function') {
          if (cur.handle(this, chatKey, entry) === true) return;   // 命中指令 → 不叫醒模型
        }
      } catch (error) {
        logger.warn(PLUGIN_ID, `指令判定异常（按未命中处理）：${error?.message ?? error}`);
      }
      // ⚠️ 放行到核心时：arguments 要在**本函数作用域**里先取出来再 apply。
      //    带默认参数的函数里 arguments 在 apply 中不可靠；写错会变成"包装层调用
      //    自己"→ RangeError: Maximum call stack size exceeded（本项目实测踩过：
      //    日志一秒刷四千多条栈溢出、消息全部处理失败）。
      //    这里刻意只用闭包里的 original（上面已保证它是真身，绝不是包装层），
      //    不再现读 proto[PATCH_KEY] —— 少一条可能取到包装层的路径。
      // eslint-disable-next-line prefer-rest-params
      const args = arguments;
      // 最后一道保险：万一真身被人为改成我们自己（记录被外部篡改），
      // 宁可放弃这一条消息，也绝不让消息管道递归崩掉。
      if (original === wrapped) {
        logger.warn(PLUGIN_ID, '真身被改成了包装层自身，已跳过本次放行以免递归（重新加载插件即可恢复）');
        return undefined;
      }
      return original.apply(this, args);
    };
    // 标记：让后续的查找能认出"这是我们的包装层，它里面包的是 original"
    Object.defineProperty(wrapped, '__ccbInner', { value: original, enumerable: false });
    Object.defineProperty(wrapped, '__ccbWrapped', { value: true, enumerable: false });
    rec = { original, wrapped, handle: null };
    proto[PATCH_KEY] = rec;
  }
  // 把（可能是上一代残留的）包装层从原型上换掉，确保链子的顶端始终是本记录
  if (proto.onIncoming !== rec.wrapped) proto.onIncoming = rec.wrapped;
  rec.handle = handle;
  return true;
}

/**
 * 摘钩子：把本插件**所有**带标记的包装层从链上摘掉，并还原成真身。
 *
 * 为什么不是"只摘自己这一层"：热重载时旧实例的 deactivate 未必都跑到
 * （同一文件被连改几次、watcher 连触发多轮），只摘一层就会留下残留 ——
 * 那些残留的代码取自当时的磁盘文件、早已不存在，却一直活着，而且**无法在运行时拆除**
 * （真身藏在它的闭包里），最后只能靠重启。所以这里一次摘干净，从根上避免残留。
 */
function uninstall() {
  const proto = Orchestrator?.prototype;
  const rec = proto?.[PATCH_KEY];
  if (!proto) return;
  if (rec) rec.handle = null;

  let removed = 0;
  // 只动带 __ccbWrapped 标记的层（我们这一代起的），其它插件/无标记残留一律不碰
  let fn = proto.onIncoming;
  let link = null;                       // 上一层函数对象（用于接回链子）
  for (let i = 0; i < 50 && typeof fn === 'function'; i++) {
    if (fn.__ccbWrapped === true) {
      const inner = (typeof fn.__ccbInner === 'function' && fn.__ccbInner !== fn) ? fn.__ccbInner : null;
      if (!inner) break;                 // 没有内层就无法安全接回，停手
      if (link) link.__ccbInner = inner;
      else proto.onIncoming = inner;
      removed++;
      fn = inner;                        // 继续往下看（可能还有我们别的层）
      continue;
    }
    link = fn;
    if (typeof fn.__ccbInner !== 'function' || fn.__ccbInner === fn) break;
    fn = fn.__ccbInner;
  }

  delete proto[PATCH_KEY];
  delete proto[ORIGINAL_KEY];
}

// ── 生命周期 ─────────────────────────────────────────────────────────────

/** 判定"这一层是本插件的包装层"：优先看标记，其次靠源码特征串（兼容早期无标记版本）。 */
function looksLikeOurWrapper(fn) {
  if (typeof fn !== 'function') return false;
  if (fn.__ccbWrapped === true) return true;
  const src = String(fn);
  return src.includes(PATCH_KEY_SRC_HINT) && src.includes('handle');
}

/**
 * 检查原型链：找出"本插件的包装层"里哪些是**没有标记的老残留**。
 * 老残留取不出它内部包的真身（真身存在闭包里，外部无法访问），因此无法安全拆除 ——
 * 这种情况只能如实报告，让用户重启一次。不报告的话表现极其隐蔽：
 * 文件里明明没有的日志还在打、消息被静默吃掉、改代码完全不生效（实测踩过）。
 */
function findStaleOurLayers() {
  const proto = Orchestrator?.prototype;
  const stale = [];
  let fn = proto?.onIncoming;
  for (let i = 0; i < 12 && typeof fn === 'function'; i++) {
    if (looksLikeOurWrapper(fn) && fn.__ccbWrapped !== true) stale.push(i);
    if (typeof fn.__ccbInner !== 'function' || fn.__ccbInner === fn) break;
    fn = fn.__ccbInner;
  }
  return stale;
}

export async function setup(skillApi) {
  api = skillApi;
  try {
    const stale = findStaleOurLayers();
    if (stale.length) {
      logger.warn(PLUGIN_ID,
        `检出 ${stale.length} 层本插件的历史残留包装层（热重载未退干净留下的，代码已不在磁盘上）。`
        + '它无法在运行时安全拆除，**请重启一次 QQ Agent**；重启前本指令可能不生效。');
    }
  } catch { /* 检查失败不影响加载 */ }
  return { ok: true };
}

export function available() {
  // 挂载点在 activate 里做，这里只报告"依赖软件版本是否支持"。
  const proto = Orchestrator?.prototype;
  if (!proto || typeof proto.onIncoming !== 'function') {
    return { ok: false, reason: '这个版本的 QQ Agent 没有 Orchestrator.onIncoming 挂载点' };
  }
  return { ok: true };
}

export function activate() {
  const ok = install();
  if (ok) {
    // 版本指纹：每次挂载都打印。热重载后翻日志就能确认"跑的到底是哪一版代码"，
    // 不用去猜（本项目排障时正是靠它定位到"文件改了但运行中的还是旧版"）。
    logger.info(PLUGIN_ID, `CCB 指令已挂载：[${BUILD}] /ccb @某人（0 token，纯本地判定）`);
  }
}

export function deactivate() {
  uninstall();
}

export function dispose() {
  uninstall();
  lastAt.clear();
}

/** 状态查询能力：给控制台/排障用（不是给模型的工具）。 */
export const providers = {
  'ccb-command.status': () => ({
    ...stats,
    cooldownGroups: lastAt.size,
    lastAtText: stats.lastAt ? new Date(stats.lastAt).toLocaleString('zh-CN', { hour12: false }) : ''
  })
};

/** 自测用：拿到纯函数，便于脱离运行时验证指令识别与文案生成。 */
export const internals = { parseCommand, buildLines, rollAmount, stripLeadingReply, install, uninstall };
