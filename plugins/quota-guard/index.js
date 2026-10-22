/**
 * quota-guard —— 按 QQ 号累计每日 token 消耗并限额（确定性型插件，零 token 成本）。
 *
 * 为什么是插件而不是技能：这套东西全是本地查表与记账，没有"要模型理解人话"的成分，
 * 触发时机也必须由核心代码决定（额度用尽的人**必然**被拦，不能由模型自选）。
 * 按项目的目录语义（plugins/ = 确定性型，skills/ = LLM 型）它属于前者。
 *
 * ── 开关只有一处 ────────────────────────────────────────────────────────
 *   启用状态就读 config.skills['quota-guard'].enabled（控制台「插件」页的那个开关）。
 *   本插件**不再自己维护一个 enabled** —— 两个开关会打架，出现"界面关了但还在拦人"。
 *   核心在调度前就会过滤掉未启用的 Skill，所以 hooks/providers 根本不会被调用。
 *
 * ── 它怎么做到"不花 token" ──────────────────────────────────────────────
 *   ① 本插件只在**本地**读配置、比数字、做加法，从不调用模型；
 *   ② 真正省钱靠核心扩展点 `chat.quota-gate`（见 src/orchestrator.js 的 #runAgent）：
 *      全部参与者都超额度时，核心在**组装提示词之前**结束这一轮，一条 LLM 请求都不发。
 *
 * ── 记账口径（先读这段再看代码）─────────────────────────────────────────
 *   一次会话运行可能包含十几轮 LLM 调用（每轮工具调用后都要再问一次模型），
 *   所以账要**按次**记，不能按轮记：
 *     · before-context   ：记下这一轮的参与者与各自发言条数（权重），并把额度已用尽
 *                          的人从触发批里剔除 —— 他的发言不进提示词，也就不该计他的账；
 *     · after-response   ：每次模型返回后，把**这一次调用**的真实 usage 按权重分给参与者；
 *     · chat.quota-gate  ：参与者全都超额 → 让核心跳过这一轮，零消耗收尾。
 *   用 sessionId 隔离：同一会话先后两次运行不会串账。
 *
 * ── 数据存哪 ────────────────────────────────────────────────────────────
 *   额度配置：config.skills['quota-guard']（走 setSkillConfig，与控制台设置同源）
 *   消耗账本：data/quota-guard/ledger.json（走 src/config.js 的 DATA_DIR，与其它插件同源）
 */

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig, updateConfig } from '../../src/config.js';
import { getSkillConfig, isSkillEnabledInConfig, setSkillEnabled } from '../../src/skills/config.js';
import { skillManager } from '../../src/skills/manager.js';

const SKILL_ID = 'quota-guard';
const STATE_DIR = path.join(DATA_DIR, 'quota-guard');
const LEDGER_FILE = path.join(STATE_DIR, 'ledger.json');

/** 与 plugin.json 的 settings 保持一致；getSkillConfig 会用这里的值兜底。 */
const DEFAULTS = {
  resetHour: 4,              // 每日重置时刻（0-23）
  defaultDailyLimit: 0,      // 0 = 不限
  perUser: {},               // { "QQ号": { limit: number, note: string } }
  notifyOnBlock: false,
  notifyText: '（今天的额度用完啦，明天再来找我吧）',
  /**
   * 发送限流前置：分钟/小时发送额度用尽时，**在请求模型之前**就结束这一轮。
   *
   * 默认开。理由：那种情况下本来就发不出去，问模型是纯浪费 token ——
   * 模型会把话想完，然后被 sender 的限流挡回来。
   * 关掉就退回核心原有行为（照常问模型，发送时才失败）。
   */
  blockWhenSendLimited: true
};

// ── 账本读写（同步 IO，文件很小；与项目其它插件一致的做法）────────────────
let ledgerCache = null;

function emptyLedger() {
  return {
    version: 1,
    users: {},
    totals: {},
    blocked: {},
    /**
     * 每个"被手动重置过的人"当天的**水位线**：
     * `{ "2026-10-09": { "1475044877": true } }` —— 标记为 true 表示
     * "这个人今天被重置过，他的今日用量只认账本，不要再拿会话存档兜底"。
     *
     * 为什么按人存而不按天存：会话存档（cumulative.days）是按天汇总的，
     * 一旦整天切到"只认账本"，同一天里**没被重置的其他人**就会一起变成 0 ——
     * 因为他们的用量只在存档里。按人标记就不会误伤旁人。
     *
     * 只存"是否重置过"这一个事实，不存数字：重置后他新花的钱由账本照常记，
     * 与水位线做减法反而容易在账本缓存刷新时序上出错。
     */
    userFloors: {}
  };
}

function loadLedger() {
  if (ledgerCache) return ledgerCache;
  try {
    const text = fs.readFileSync(LEDGER_FILE, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(text);
    ledgerCache = {
      version: 1,
      users: (parsed && typeof parsed.users === 'object' && parsed.users) || {},
      totals: (parsed && typeof parsed.totals === 'object' && parsed.totals) || {},
      blocked: (parsed && typeof parsed.blocked === 'object' && parsed.blocked) || {},
      userFloors: (parsed && typeof parsed.userFloors === 'object' && parsed.userFloors) || {}
    };
  } catch {
    // 文件不存在 / 损坏：都从空账开始。**不抛错** —— 记账失败绝不该让聊天主流程崩掉。
    ledgerCache = emptyLedger();
  }
  return ledgerCache;
}

function saveLedger() {
  if (!ledgerCache) return;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    // 先写临时文件再改名：写到一半断电不会留下半个 JSON（项目里所有落盘都这么做）
    const tmp = `${LEDGER_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(ledgerCache, null, 1), 'utf8');
    fs.renameSync(tmp, LEDGER_FILE);
  } catch { /* 磁盘满/权限问题不应影响发消息 */ }
}

// ── 累计账本（总用量排行榜用）────────────────────────────────────────────
//
// 当日账本（ledger.json）只存"每人每天用了多少"，过一天就归零 ——
// 从它推不出"历史总用量"。所以另开一份累计账本，数据来自**会话存档**：
//
//   每个会话文件（data/sessions/*.json）都完整记着：
//     · usage.totalTokens  这一次运行烧掉的 token（真实计费量）
//     · trigger[]          本轮触发批，每条带 senderId（QQ 号）
//   这正是分摊所需的全部信息，而且是**历史**数据 —— 插件是刚装的，
//   但会话存档从更早就存在，所以排行榜能立刻覆盖到全部历史，不用等它慢慢攒。
//
// 口径与实时记账一致：把这一轮的总消耗按各人发言条数分摊。
//
// ⚠️ 单独一个文件，绝不和当日账本混在一起：
//    当日账本是被 hooks 高频读写的（每次发言、每次回复），
//    把一份可能很大的累计表塞进去，会让那条热路径每次都要序列化整张表。
const CUMULATIVE_FILE = path.join(STATE_DIR, 'cumulative.json');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

let cumulativeCache = null;
/** 正在回填时的状态（跑在后台，不阻塞请求）。 */
const scanState = { running: false, done: 0, total: 0, startedAt: 0, error: '' };

function emptyCumulative() {
  return {
    version: 1, updatedAt: 0, users: {},
    totals: { tokens: 0, calls: 0, sessions: 0 },
    skipped: { selfChat: 0, noUsage: 0, noTrigger: 0 },
    processed: {},
    /**
     * 按天汇总的用量（`{ "2026-10-09": { tokens, users: { qq: tokens } } }`），
     * 同样来自会话存档。**只留最近 3 天**，够用且不会无限膨胀。
     *
     * 为什么需要它：当日账本（ledger.json）只在插件真正跑过一轮之后才有内容。
     * 插件是后装的，而"今天"的会话可能全发生在装它之前 —— 那时账本是空的，
     * 界面上今日用量会显示成 0，看起来像数据丢了。会话存档里其实一直记着，
     * 所以扫描时顺手按天汇总一份，当日账本为空时用它兜底。
     */
    days: {},
    // 是否**完整跑过一轮**扫描。没跑过 ≠ 跑过但结果是空 ——
    // 两者在界面上含义完全不同（"正在统计" vs "确实还没有历史"），必须分开。
    scannedOnce: false
  };
}

/** 只保留最近 N 天，避免 days 无限增长。 */
function pruneDays(cum, keep = 3) {
  const keys = Object.keys(cum.days || {}).sort();
  while (keys.length > keep) delete cum.days[keys.shift()];
}

function loadCumulative() {
  if (cumulativeCache) return cumulativeCache;
  try {
    const text = fs.readFileSync(CUMULATIVE_FILE, 'utf8').replace(/^\uFEFF/, '');
    const p = JSON.parse(text);
    cumulativeCache = {
      version: 1,
      updatedAt: Number(p?.updatedAt) || 0,
      users: (p && typeof p.users === 'object' && p.users) || {},
      totals: Object.assign({ tokens: 0, calls: 0, sessions: 0 }, (p && p.totals) || {}),
      skipped: Object.assign({ selfChat: 0, noUsage: 0, noTrigger: 0 }, (p && p.skipped) || {}),
      processed: (p && typeof p.processed === 'object' && p.processed) || {},
      days: (p && typeof p.days === 'object' && p.days) || {},
      scannedOnce: p?.scannedOnce === true
    };
  } catch {
    cumulativeCache = emptyCumulative();     // 不存在/损坏都从空账开始，绝不抛错
  }
  return cumulativeCache;
}

function saveCumulative() {
  if (!cumulativeCache) return;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = `${CUMULATIVE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cumulativeCache), 'utf8');
    fs.renameSync(tmp, CUMULATIVE_FILE);
  } catch { /* 写不进去也不能影响聊天 */ }
}

/**
 * 扫描/增量扫描会话存档。
 *
 * @param {object} opts
 *   - budgetMs  单次最多扫多久（默认 1500ms）。会话文件可能上千个，
 *               一口气扫完要好几秒，所以分片进行：没扫完就下次继续。
 *   - force     忽略 processed 缓存，全部重扫（界面上的「重建」用）
 * @returns {{done:boolean, scanned:number, total:number}}
 */
function scanSessions({ budgetMs = 1500, force = false } = {}) {
  const cum = loadCumulative();
  if (force) {
    cum.users = {};
    cum.totals = { tokens: 0, calls: 0, sessions: 0 };
    cum.skipped = { selfChat: 0, noUsage: 0, noTrigger: 0 };
    cum.processed = {};
  }
  let files;
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return { done: true, scanned: 0, total: 0 };   // 没有会话目录 = 没什么可统计
  }
  // 老的先扫：这样分片中断时，先出来的是最近的历史，进度也更直观
  let metas = [];
  try {
    metas = files.map((f) => ({ f, mtime: fs.statSync(path.join(SESSIONS_DIR, f)).mtimeMs }));
  } catch {
    metas = files.map((f) => ({ f, mtime: 0 }));
  }
  metas.sort((a, b) => a.mtime - b.mtime);

  // 机器人自己跟自己说话的私聊（private:<机器人QQ>）：算谁的都不对，整段跳过。
  // 不静默丢：计数放进 skipped.selfChat，界面上如实说明。
  let selfId = '';
  try { selfId = String(getConfig()?.onebot?.selfId || ''); } catch { /* 拿不到就按没有处理 */ }
  const selfChatKey = selfId ? `private:${selfId}` : '';

  const t0 = Date.now();
  let scanned = 0;
  let done = true;
  for (const { f, mtime } of metas) {
    if (!force && cum.processed[f] === mtime) continue;      // 没变过，跳过
    if (Date.now() - t0 > budgetMs) { done = false; break; }  // 这一片到点了，下次接着扫
    scanned++;
    let s = null;
    try { s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')); } catch { s = null; }
    if (!s || typeof s !== 'object') { cum.processed[f] = mtime; continue; }

    const tokens = Number(s.usage?.totalTokens) || 0;
    const calls = Number(s.usage?.calls) || 0;
    if (tokens <= 0) {
      // 没花过钱的会话（中止/报错）不进任何账，但也要记 processed，免得每轮重读
      cum.processed[f] = mtime;
      cum.skipped.noUsage += 1;
      continue;
    }
    const chatKey = String(s.chatKey || '');
    if (selfChatKey && chatKey === selfChatKey) {
      // 机器人自聊：花掉的 token 照样计入总计（确实花了），只是不归到谁头上
      cum.totals.tokens += tokens;
      cum.totals.calls += calls;
      cum.processed[f] = mtime;
      cum.skipped.selfChat += 1;
      continue;
    }
    // 按发言条数分摊（与实时记账同一套 participantsOf）
    const parts = participantsOf(Array.isArray(s.trigger) ? s.trigger : [], null);
    // ⚠️ 先无条件累计"总计"，再决定能不能分摊。
    //    曾经 totals.tokens 写在"有参与者"的分支里，于是没人发言的会话
    //    （主动开话题）花掉的 token 从总计里凭空消失了 —— 重建前后对不上账。
    cum.totals.tokens += tokens;
    cum.totals.calls += calls;
    if (!parts.length) {
      cum.processed[f] = mtime;
      cum.skipped.noTrigger += 1;
      continue;
    }
    // ⚠️ 只给**真的分到 token**的人建条目：distribute 会滤掉 value=0 的人，
    //    若照 parts 全量累加人次，会出现"0 token 却挂在榜上"的幽灵条目。
    const shares = distribute(parts, tokens);
    const counted = new Set();
    for (const { p, value } of shares) {
      const id = String(p.userId);
      counted.add(id);
      const u = cum.users[id] || (cum.users[id] = { tokens: 0, sessions: 0, messages: 0, name: '', firstAt: 0, lastAt: 0 });
      u.tokens += value;
      u.name = p.name || u.name || '';
    }
    const at = Number(s.startedAt) || 0;
    for (const p of parts) {
      if (!counted.has(String(p.userId))) continue;
      const u = cum.users[p.userId];
      if (!u) continue;
      u.sessions += 1;
      u.messages += p.count;
      if (at) {
        if (!u.firstAt || at < u.firstAt) u.firstAt = at;
        if (at > u.lastAt) u.lastAt = at;
      }
    }
    // 顺带按天汇总（当日账本为空时的兜底，见 emptyCumulative 的注释）。
    // ⚠️ dayKey 口径必须与当日账本**完全一致**（都按 resetHour 切），
    //    否则同一天在这两处会算成两天，界面上数字对不上。
    if (at) {
      const resetHour = settings().resetHour;
      const dk = dayKey(at, resetHour);
      const day = cum.days[dk] || (cum.days[dk] = { tokens: 0, sessions: 0, users: {} });
      day.tokens += tokens;
      day.sessions += 1;
      for (const { p, value } of shares) {
        const id = String(p.userId);
        day.users[id] = (Number(day.users[id]) || 0) + value;
      }
    }
    cum.totals.sessions += 1;
    cum.processed[f] = mtime;
  }

  cum.updatedAt = Date.now();
  if (scanned) saveCumulative();
  return { done, scanned, total: metas.length };
}

/** 当前扫描进度（给界面看）。 */
function scanProgress() {
  const cum = loadCumulative();
  let processedCount = 0;
  try { processedCount = Object.keys(cum.processed).length; } catch { /* ignore */ }
  return {
    running: scanState.running,
    processed: processedCount,
    total: scanState.total || processedCount,
    // 还没完整跑过一轮 = 榜上数字还在长，界面要说"正在统计"
    partial: !cum.scannedOnce,
    error: scanState.error || ''
  };
}

/**
 * 有没有"还没扫过、或扫过之后又变了"的会话文件。
 * 顺带告诉调用方"存档目录到底存不存在"（区分"没得扫"和"扫完了"）。
 *
 * 每轮只要 1 次 readdir + N 次 stat（实测 757 个文件约 10ms），
 * 比"先置 running=true 再发现没事干"便宜得多，也不会让界面闪一下"正在统计"。
 */
function pendingScanWork() {
  const cum = loadCumulative();
  let names;
  try { names = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')); } catch { return { archiveExists: false, hasWork: false }; }
  for (const f of names) {
    let mtime = 0;
    try { mtime = fs.statSync(path.join(SESSIONS_DIR, f)).mtimeMs; } catch { continue; }   // 刚被删掉的忽略
    if (cum.processed[f] !== mtime) return { archiveExists: true, hasWork: true };
  }
  return { archiveExists: true, hasWork: false };
}

/**
 * 启动（或推进）后台回填，**不阻塞请求**。
 *
 * 为什么要后台分片：一千个会话文件一口气读完要好几秒，直接卡在 HTTP 请求里
 * 界面会像卡死。这里跑在定时器上，每次最多 1.2 秒，界面轮询进度。
 * 反复调用是安全的：同一时刻只会有一个在跑（scanState.running 挡着）。
 *
 * ⚠️ 必须先判断"有没有活要干"再置 running —— 曾经是无条件置 true 然后扫，
 *    扫完发现无事可做直接 return，而 `running=false` 只在真正扫完的分支里赋值，
 *    结果 running 永远停在 true：界面同时看到"已完整统计"和"正在统计"两个矛盾状态。
 */
/**
 * 同步把"还没扫到的会话"扫完（小批量、有硬上限，绝不长阻塞）。
 *
 * 为什么重置前需要它：重置会把当天切到"只认账本"模式（见 todayUsage），
 * 那一刻还没被扫到的今日会话就再也进不了当日数字了 —— 用量会凭空少一截。
 * 总消耗不受影响（它自己记账），但当日数字会对不上，所以先排空再重置。
 *
 * 正常情况下待扫的只有几个文件（秒级），代价可忽略；万一积压很多，
 * 到 hardMs 就放弃并返回 false —— 界面刷新一下就好，绝不把请求卡死。
 *
 * @returns {boolean} 是否已经把待扫的全部扫完
 */
function drainScan(hardMs = 3000) {
  const t0 = Date.now();
  for (let i = 0; i < 50; i++) {
    if (!pendingScanWork().hasWork) return true;
    if (Date.now() - t0 > hardMs) return false;
    let r;
    try { r = scanSessions({ budgetMs: 250 }); } catch { return false; }
    if (r.done) {
      const cum = loadCumulative();
      cum.scannedOnce = true;
      pruneDays(cum);
      saveCumulative();
      return true;
    }
  }
  return false;
}

function kickScan(budgetMs = 1200) {
  if (scanState.running) return false;
  loadCumulative();
  let total = 0;
  try { total = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')).length; } catch { total = 0; }
  scanState.total = total;
  const work = pendingScanWork();
  if (!work.hasWork) {
    // 没有活要干。要分清两种"没活"：
    //   · 存档目录不存在（这实例还没跑过对话）→ 也算统计完成，
    //     否则界面会永远显示"正在统计…"，用户以为卡住了；
    //   · 有目录但全都扫过了 → 本来就是完成态。
    if (!work.archiveExists) {
      const cum = loadCumulative();
      if (!cum.scannedOnce) { cum.scannedOnce = true; saveCumulative(); }
    }
    return false;
  }

  scanState.running = true;
  scanState.startedAt = scanState.startedAt || Date.now();
  const step = () => {
    let r;
    try { r = scanSessions({ budgetMs }); } catch (error) { scanState.error = String(error?.message ?? error); scanState.running = false; return; }
    scanState.done = Object.keys(loadCumulative().processed).length;
    if (r.done) {
      const cum = loadCumulative();
      cum.scannedOnce = true;      // 完整跑过一轮，界面才可以放心说"没有历史"
      pruneDays(cum);              // 按天汇总只留最近几天
      saveCumulative();
      scanState.running = false;
      scanState.startedAt = 0;
      return;
    }
    setTimeout(step, 0);       // 让出事件循环，别把主线程占满
  };
  setTimeout(step, 0);
}

/**
 * 排行榜数据。
 *
 * ⚠️ 分母用"所有会话的消耗之和"，不是"各人分摊之和"——
 *    有些会话没人发言（主动机会）或整段被跳过（机器人自聊），
 *    它们的 token 不该算到任何人头上，但**确实花掉了**，要体现在总计里。
 *    两者分开列，账才说得清（互相对不上时用户一眼能看出是"没归到人头上"的部分）。
 */
function cumulativeBoard() {
  const cum = loadCumulative();
  const totalTokens = Number(cum.totals.tokens) || 0;
  const s = settings();
  const daily = loadLedger();
  const key = dayKey(Date.now(), s.resetHour);
  const todayForBoard = todayUsage();     // 账本为空时用会话存档兜底（见其注释）

  let attributed = 0;
  let firstAt = 0;
  let lastAt = 0;
  const rows = Object.entries(cum.users).map(([qq, u]) => {
    const tokens = Number(u.tokens) || 0;
    attributed += tokens;
    if (u.firstAt && (!firstAt || u.firstAt < firstAt)) firstAt = u.firstAt;
    if (u.lastAt > lastAt) lastAt = u.lastAt;
    return {
      userId: qq,
      // 昵称优先用累计账本里记的（历史会话里的群名片），其次当日的，最后备注
      name: String(u.name || '').trim(),
      note: s.perUser[qq]?.note || '',
      tokens,
      sessions: Number(u.sessions) || 0,
      messages: Number(u.messages) || 0,
      // 占比的分母是**归到人头的那部分**（attributed），不是全部消耗。
      // 用全部做分母的话，没人发言的会话会把所有人的占比一起拉低（各 46% 而不是 50%），
      // 看起来像算错了 —— 那部分不属于任何人的钱，不该出现在个人占比里。
      share: 0,
      firstAt: Number(u.firstAt) || 0,
      lastAt: Number(u.lastAt) || 0,
      limit: limitOf(s, qq),
      usedToday: usedOf(daily, qq, key) || (Number(todayForBoard.users[qq]) || 0),
      hasOwnQuota: !!s.perUser[qq]
    };
  });
  for (const r of rows) r.share = attributed > 0 ? r.tokens / attributed : 0;
  // 显示名：累计昵称 → 当日昵称 → 备注 → 空（界面回退显示 QQ 号）
  for (const r of rows) {
    const dailyName = String(daily.users[r.userId]?.name || '').trim();
    r.displayName = r.name || dailyName || r.note || '';
  }
  rows.sort((a, b) => b.tokens - a.tokens || a.userId.localeCompare(b.userId));
  rows.forEach((r, i) => { r.rank = i + 1; });

  return {
    ok: true,
    totals: {
      tokens: totalTokens,
      attributed,
      unattributed: Math.max(0, totalTokens - attributed),
      calls: Number(cum.totals.calls) || 0,
      // sessions = 有人发言、钱**归到了人头**的会话数（个人计数之和 = 它）
      // unattributedSessions = 花了钱但没人可归的（主动开话题 / 机器人自聊）
      sessions: Number(cum.totals.sessions) || 0,
      unattributedSessions: (Number(cum.skipped?.noTrigger) || 0) + (Number(cum.skipped?.selfChat) || 0),
      people: rows.length
    },
    skipped: { ...cum.skipped },
    range: { firstAt, lastAt },
    updatedAt: Number(cum.updatedAt) || 0,
    scan: scanProgress(),
    // 今日用量的来源：ledger（插件实时记的）| sessions（从会话存档补算的）| none
    // 界面据此决定要不要标一句"含历史补算"，避免用户以为插件早就在记了
    todaySource: todayForBoard.source,
    todayTotal: todayForBoard.tokens,
    rows
  };
}

/**
 * 取"今天"的用量。
 *
 * 两个来源，**当日账本优先**：
 *   ① ledger.json —— 插件运行期实时记的，权威；
 *   ② 会话存档按天汇总（cumulative.days）—— 兜底。
 *
 * 为什么需要兜底：当日账本只在插件真正跑过一轮之后才有内容。插件是后装的，
 * "今天"的会话可能全发生在装它之前 —— 那时账本是空的，今日用量会显示成 0，
 * 看起来像数据丢了（实测就是这个现象）。而这段历史一直躺在会话存档里，
 * 扫描时顺手按天汇总过，直接拿来用即可。
 *
 * @returns {{tokens:number, users:Object<string,number>, source:'ledger'|'sessions'|'none'}}
 */
function todayUsage() {
  const s = settings();
  const key = dayKey(Date.now(), s.resetHour);
  const daily = loadLedger();
  const cum = loadCumulative();
  const day = cum.days?.[key] || { tokens: 0, users: {} };
  const fromSessions = (qq) => Number(day.users?.[qq]) || 0;

  const users = {};
  const ledgerToday = {};
  for (const [qq, rec] of Object.entries(daily.users || {})) {
    if (rec && rec.dayKey === key) ledgerToday[qq] = Number(rec.used) || 0;
  }

  /**
   * 取值规则（**按人**判断，不是按天）：
   *   · 这个人今天被手动重置过（账本里有 floor）→ 只认账本，
   *     因为会话存档不知道你重置过，直接读会把重置前的量又算回来；
   *   · 没被重置过 → 账本里没有今天记录的，用存档兜底（插件后装时的历史）。
   *
   * 为什么按人而不是按天：按天切换会误伤同一天里**没被重置的其他人**，
   * 他们的用量只在存档里，一旦整天切到"只认账本"就全变成 0
   * （你以为只重置了甲，结果乙也归零 —— 实测复现过）。
   */
  const floors = daily.userFloors?.[key] || {};
  const ids = new Set([...Object.keys(ledgerToday), ...Object.keys(day.users || {})]);
  let hasFallbackOnly = false;
  for (const qq of ids) {
    if (Object.prototype.hasOwnProperty.call(floors, qq)) {
      users[qq] = ledgerToday[qq] || 0;          // 被重置过 → 只认账本
    } else if (Object.prototype.hasOwnProperty.call(ledgerToday, qq)) {
      users[qq] = ledgerToday[qq];               // 有实时记账
    } else {
      users[qq] = fromSessions(qq);              // 只有存档 → 兜底
      if (users[qq] > 0) hasFallbackOnly = true;
    }
  }

  const total = Object.values(users).reduce((a, b) => a + b, 0);
  // 来源标记：
  //   · 一个人都没有 → none
  //   · 只要有人是实时记账来的 → ledger（混合时也报 ledger，因为账本是权威那份）
  //   · 全是靠存档兜底算的 → sessions（界面据此提示"含历史补算"）
  const hasLedgerData = Object.keys(ledgerToday).length > 0;
  const source = Object.keys(users).length === 0 ? 'none' : (hasLedgerData ? 'ledger' : 'sessions');
  return { tokens: total, users, source, mixed: hasLedgerData && hasFallbackOnly };
}

// ── 配置 ────────────────────────────────────────────────────────────────

/** 每次都从核心现读，避免"界面改了、插件还用旧值"。 */
function settings() {
  return normalize(getSkillConfig(SKILL_ID, DEFAULTS));
}

function normalize(stored) {
  const s = { ...DEFAULTS, ...(stored || {}) };
  // perUser 是**映射**，逐条清洗：非法 QQ 号、非数字额度一律丢掉，
  // 免得手改配置文件写进垃圾值后把整个额度体系带崩。
  const perUser = {};
  for (const [qq, rec] of Object.entries((stored && stored.perUser) || {})) {
    const id = String(qq || '').trim();
    if (!/^\d{4,12}$/.test(id) || !rec || typeof rec !== 'object') continue;
    const limit = Number(rec.limit);
    perUser[id] = {
      limit: Number.isFinite(limit) ? Math.max(0, limit) : 0,
      note: String(rec.note ?? '').slice(0, 40)
    };
  }
  s.perUser = perUser;
  const hour = Number(s.resetHour);
  s.resetHour = Number.isFinite(hour) ? Math.min(23, Math.max(0, Math.floor(hour))) : DEFAULTS.resetHour;
  const dflt = Number(s.defaultDailyLimit);
  s.defaultDailyLimit = Number.isFinite(dflt) ? Math.max(0, dflt) : 0;
  s.notifyOnBlock = s.notifyOnBlock === true;
  // 默认开：缺省（undefined）也算开，只有显式 false 才关
  s.blockWhenSendLimited = s.blockWhenSendLimited !== false;
  s.notifyText = String(s.notifyText ?? DEFAULTS.notifyText).slice(0, 200);
  return s;
}

/**
 * 把本插件的配置整份写回 config.skills['quota-guard']。
 *
 * 为什么不用 skills/config.js 的 setSkillConfig：
 *   它是 `{...current, ...patch}` 的**浅合并**，而 deepMerge 的 `__replace__`
 *   约定只在"值的顶层"生效。于是 `setSkillConfig(id, { perUser: { __replace__: X } })`
 *   实际发出去的是 `skills: { id: { perUser: { __replace__: X } } }` —— 哨兵沉在
 *   第二层，deepMerge 不认，既不删键、还把 `{"__replace__":X}` 原样写进配置文件。
 *   实测后果：移除某人额度后文件里留下 `perUser: { "__replace__": {} }`，
 *   真实条目全被挤掉（别人设好的额度一起消失）。
 *
 * 做法：把整个 skills['quota-guard'] 用 __replace__ 整体替换，哨兵就在 deepMerge
 * 认得的顶层，删键与保留都精确。同时顺带保留 enabled（那是核心的开关，别被我覆盖）。
 */
function persistSkillConfig(patch) {
  const cur = getConfig()?.skills?.[SKILL_ID] || {};
  const next = normalize({ ...cur, ...patch });
  const full = {
    ...(cur && typeof cur === 'object' ? cur : {}),   // 保留 enabled 等非本插件字段
    resetHour: next.resetHour,
    defaultDailyLimit: next.defaultDailyLimit,
    notifyOnBlock: next.notifyOnBlock,
    notifyText: next.notifyText,
    blockWhenSendLimited: next.blockWhenSendLimited,
    perUser: next.perUser
  };
  updateConfig({ skills: { [SKILL_ID]: { __replace__: full } } });
}

/**
 * 调宿主自己的 HTTP 接口。
 *
 * ⚠️ 三个必须做对的地方：
 *   ① 地址用 127.0.0.1 + **传入的真实端口**，不能猜 3210 —— 多开时会把请求打到别的实例；
 *   ② Origin 头不能带（服务端 fetch 默认就没带），宿主的 originAllowed 对"无来源信息"
 *      的请求是放行的；带了错的 Origin 反而会被 403；
 *   ③ 实例设了 server.token 时要带上 —— 支持 `?token=`（见 app.js 的 authorize），
 *      而 token 是服务端自己读的，**不该经过浏览器**。
 */
async function coreApi(port, pathAndQuery) {
  let url = `http://127.0.0.1:${Number(port) || 3210}${pathAndQuery}`;
  try {
    const token = String(getConfig()?.server?.token || '');
    if (token) url += (url.includes('?') ? '&' : '?') + `token=${encodeURIComponent(token)}`;
  } catch { /* 读不到配置就按无令牌请求，本机默认放行 */ }
  const r = await doFetch(url);
  if (!r.ok) throw new Error(`宿主接口返回 ${r.status}`);
  return r.json();
}

/**
 * 额度周期的"今天"是哪一天。
 *
 * 不是自然日：resetHour=4 表示 04:00 到次日 04:00 算一天。
 * 做法是把时间往前推 resetHour 小时再取日期 —— 凌晨 3 点发的消息仍算"昨天"，
 * 与用户"我设的 4 点重置"的预期一致（而不是 0 点偷偷清一次）。
 */
function dayKey(now = Date.now(), resetHour = 4) {
  const shifted = new Date(now - resetHour * 3600 * 1000);
  const y = shifted.getFullYear();
  const m = String(shifted.getMonth() + 1).padStart(2, '0');
  const d = String(shifted.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function nextResetAt(now = Date.now(), resetHour = 4) {
  const d = new Date(now);
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), resetHour, 0, 0, 0);
  if (next.getTime() <= now) next.setDate(next.getDate() + 1);
  return next.getTime();
}

/**
 * 某人当日的**余额扣减量** —— 决定"当前余额"，也是**唯一**决定拦不拦的数。
 * 手动重置余额 = 把它清零（余额回满），**不动 spent**（今日用量是事实）。
 */
function usedOf(ledger, qq, key) {
  const rec = ledger.users[String(qq)];
  if (!rec || rec.dayKey !== key) return 0;
  return Math.max(0, Number(rec.used) || 0);
}

/**
 * 某人当日的**实际消耗** —— 界面上「今日用量」显示这个。
 *
 * 与 usedOf 的区别（这两个必须分清，我已经搞错过好几次）：
 *   · usedOf  = 余额扣减量 → 手动重置会清零，**决定拦不拦**
 *   · spentOf = 今日真实花了多少 → 手动重置**不清零**；只随"设定时刻"翻篇归零
 * 两者平常相等（没重置过时），一旦点过重置就会分叉，界面上必须分别显示。
 */
function spentOf(ledger, qq, key) {
  const rec = ledger.users[String(qq)];
  // 跨天自动视作 0：dayKey 变了就不再是"今天的用量"（这是"到设定时刻一起重置"）
  if (!rec || rec.dayKey !== key) return 0;
  // 老账本没有 spent 字段时回退到 used，免得历史看起来凭空少一截
  if (rec.spent === undefined || rec.spent === null) return Math.max(0, Number(rec.used) || 0);
  return Math.max(0, Number(rec.spent) || 0);
}

/** 某人的额度；0 = 不限。没单独设过就用全局默认。 */
function limitOf(s, qq) {
  const rec = s.perUser[String(qq)];
  if (rec && Number.isFinite(Number(rec.limit))) return Math.max(0, Number(rec.limit));
  return s.defaultDailyLimit;
}

/**
 * 这一轮运行的参与者与权重。
 *
 * 权重 = 该人在本次触发批里的发言条数（用户指定的分配口径）。
 * self 是机器人自己，不计入任何人的额度。
 */
function participantsOf(triggerEntries, skip) {
  const counts = new Map();
  for (const m of triggerEntries || []) {
    const uid = String(m?.senderId ?? '').trim();
    if (!uid || uid === 'self' || m?.self) continue;
    if (skip && skip.has(uid)) continue;
    const prev = counts.get(uid);
    counts.set(uid, {
      userId: uid,
      name: String(m?.senderName ?? '').trim() || prev?.name || '',
      count: (prev?.count || 0) + 1
    });
  }
  const list = [...counts.values()];
  const total = list.reduce((a, p) => a + p.count, 0);
  for (const p of list) p.weight = total > 0 ? p.count / total : 0;
  return list;
}

/** 一次调用实际消耗了多少 token（优先 total_tokens，缺了就用 prompt+completion）。 */
function tokensOf(usage) {
  if (!usage) return 0;
  const total = Number(usage.total_tokens);
  if (Number.isFinite(total) && total > 0) return Math.round(total);
  return (Number(usage.prompt_tokens) || 0) + (Number(usage.completion_tokens) || 0);
}

// ── 运行期状态（按 sessionId 隔离，防两次运行串账）──────────────────────
const runState = new Map();

/**
 * 每一轮已结算到的累计 token（key -> 最大 cumulative）。
 *
 * ⚠️ 这个水位**必须放在这里**，不能放进 runState —— runState 会被 before-context
 *    重建（settledUsage 归零），水位一清，去重判断就永远失效。
 *    实测踩过两次：同一笔消耗被记两遍，今日用量正好是余额扣减量的两倍
 *    （15000 + 15500 = 30500 这种）。
 *
 * 语义：一轮运行内部的 usage.totalTokens 是**只增不减**的累计值，
 *      所以"累计值 <= 水位"就说明这次 after-response 是重复触发（重试/多路径）。
 */
const settledWatermark = new Map();     // key -> { chatKey, participants, settledUsage, notified }

function runKeyOf(context = {}) {
  const sid = String(context?.sessionId ?? context?.session?.id ?? '').trim();
  return sid || `chat:${context?.chatKey ?? ''}`;
}

/**
 * 每个会话**最近一次** before-context 的摘要（chatKey -> 状态）。
 *
 * 为什么需要它：chat.quota-gate 要靠 before-context 记下的"这一轮原本有多少条消息"
 * 才能区分"本来没人说话（主动机会）"和"有人说话但全被剔除"。
 * 正常路径按 sessionId 取 runState，但**旧版核心不会把 sessionId 传给 gate** ——
 * 那时按 sessionId 查必然落空，判定就退化成"永远放行"，白花钱。
 * 所以留一份按 chatKey 的兜底，5 秒内对得上就用。
 */
const lastRunByChat = new Map();

/** 取这一轮的状态：先按 sessionId，落空了再按 chatKey 的短期兜底。 */
function runStateFor(context = {}) {
  const direct = runState.get(runKeyOf(context));
  if (direct) return direct;
  const fb = lastRunByChat.get(String(context?.chatKey ?? ''));
  return fb && Date.now() - fb.at < 5000 ? fb : null;
}

/**
 * 把一次调用的 token 按权重分给参与者（最大余额法，分摊之和精确等于实际消耗）。
 *
 * 不用四舍五入逐人算：四个人各 25% 累计下去每轮会丢掉 1~3 个 token，
 * 一天几百轮之后账本与「用量」页对不上，用户会怀疑记账不准。
 */
function distribute(participants, total) {
  const sum = Math.max(0, Math.round(total));
  if (!sum || !participants.length) return [];
  const parts = participants.map((p) => {
    const exact = sum * (Number(p.weight) || 0);
    const base = Math.floor(exact);
    return { p, value: base, frac: exact - base };
  });
  let remain = sum - parts.reduce((a, x) => a + x.value, 0);
  // 余数按小数部分从大到小发；完全相等时按 QQ 号排序（顺序稳定，账本可复现）
  parts.sort((a, b) => (b.frac - a.frac) || String(a.p.userId).localeCompare(String(b.p.userId)));
  for (let i = 0; i < parts.length && remain > 0; i++, remain--) parts[i].value += 1;
  return parts.filter((x) => x.value > 0);
}

// ── 钩子 ────────────────────────────────────────────────────────────────
export const hooks = {
  /**
   * 在任何 LLM 请求之前：挑出超额度的人，把他们从触发批里剔除，并记下参与者权重。
   *
   * ⚠️ triggerEntries 是同一个数组引用，核心允许原地修改（返回值被忽略）。
   *    用 length=0 + push 原地改，而不是重新赋值 —— 重新赋值不会影响核心持有的
   *    那个引用，表现就是"过滤了但没生效"。
   */
  'before-context': (context = {}) => {
    const s = settings();
    const { chatKey, triggerEntries, sessionId } = context;
    const key = dayKey(Date.now(), s.resetHour);
    const ledger = loadLedger();

    // 找出这一轮里额度已经用尽的人
    const overQuota = new Set();
    for (const m of triggerEntries || []) {
      const uid = String(m?.senderId ?? '').trim();
      if (!uid || uid === 'self' || m?.self) continue;
      const limit = limitOf(s, uid);
      if (limit <= 0) continue;                                  // 0 / 未设置 = 不限
      if (usedOf(ledger, uid, key) >= limit) overQuota.add(uid);
    }

    if (overQuota.size) {
      const kept = (triggerEntries || []).filter((m) => {
        const uid = String(m?.senderId ?? '').trim();
        return !(uid && overQuota.has(uid));
      });
      triggerEntries.length = 0;
      triggerEntries.push(...kept);
      ledger.blocked[key] = ledger.blocked[key] || {};
      for (const uid of overQuota) {
        ledger.blocked[key][uid] = (Number(ledger.blocked[key][uid]) || 0) + 1;
      }
      saveLedger();
      context.log?.(
        `[quota-guard] ${chatKey} 剔除 ${overQuota.size} 个已超额的人：${[...overQuota].join(', ')}`
        + `（本批剩余 ${triggerEntries.length} 条）`
      );
    }

    // 触发批已定稿，现在算权重并把状态挂到 sessionId 上
    const runInfo = {
      chatKey: String(chatKey || ''),
      participants: participantsOf(triggerEntries, overQuota),
      // 本轮**原本**有多少条他人消息。必须记下来：下面会把超额者的消息剔掉，
      // 剔完可能一条不剩 —— 那时 chat.quota-gate 需要区分
      // "本来没人说话（主动机会）" 和 "有人说话但全被剔了"，
      // 后者必须拦下整轮（否则模型照样被调用，白花钱）。见 gate 里的注释。
      incoming: (triggerEntries || []).length + overQuota.size,
      notified: false,
      at: Date.now()
    };
    runState.set(runKeyOf({ sessionId, chatKey }), runInfo);
    // 同时留一份按 chatKey 的兜底（旧版核心不传 sessionId 给 gate 时要用，见 runStateFor）
    lastRunByChat.set(String(chatKey || ''), runInfo);
    if (lastRunByChat.size > 100) {
      for (const k of [...lastRunByChat.keys()].slice(0, lastRunByChat.size - 100)) lastRunByChat.delete(k);
    }
    // 防泄漏：只保留最近 200 次运行的状态（正常同时活跃的会话个位数）
    if (runState.size > 200) {
      for (const k of [...runState.keys()].slice(0, runState.size - 200)) runState.delete(k);
    }
  },

  /**
   * 每次模型返回后：把**这一次调用**的真实 token 按权重分给参与者。
   *
   * 这里必须用 response.usage（本次调用的原始 usage），不能用 session.usage ——
   * 后者是整轮的累计值，第 2 次调用会把第 1 次的量再算一遍。
   */
  'after-response': ({ response, session } = {}) => {
    const tokens = tokensOf(response?.usage);
    if (!tokens) return;
    const st = runState.get(runKeyOf({ session }));
    if (!st) return;                                  // 本轮没经过 before-context（如主动机会），不记
    if (!st.participants.length) return;              // 没有他人参与，不该记任何人的账

    // 去重：累计值没变说明这次是重复触发（重试/多路径），跳过。
    // ⚠️ 账必须记在**插件自己的运行状态**（st）上。
    //    曾经写成只 `st.settledUsage = cumulative` 而判断用 `cumulative === st.settledUsage`，
    //    看似对，但每次 after-response 传进来的 session 是**新对象**、而 st 也常常是
    //    before-context 刚重建的（settledUsage 初始值），于是守卫永远失效 ——
    //    同一笔消耗被记两遍（实测：15500 记成 30500，今日用量正好是余额扣减量的两倍）。
    //    现在用"只增不减的水位"判断：<= 已结算过的值就认为重复。
    const cumulative = Number(session?.usage?.totalTokens) || 0;
    const wmKey = runKeyOf({ session });
    const settled = Number(settledWatermark.get(wmKey)) || 0;
    if (cumulative > 0 && cumulative <= settled) return;   // 重复触发，跳过
    if (cumulative > 0) {
      settledWatermark.set(wmKey, cumulative);
      // 防泄漏：只留最近 300 轮（正常同时活跃的会话个位数）
      if (settledWatermark.size > 300) {
        for (const k of [...settledWatermark.keys()].slice(0, settledWatermark.size - 300)) settledWatermark.delete(k);
      }
    }

    const s = settings();
    const key = dayKey(Date.now(), s.resetHour);
    const ledger = loadLedger();
    for (const { p, value } of distribute(st.participants, tokens)) {
      const id = String(p.userId);
      const rec = ledger.users[id];
      if (!rec || rec.dayKey !== key) {
        ledger.users[id] = { dayKey: key, used: 0, spent: 0, name: p.name || rec?.name || '', updatedAt: Date.now() };
      }
      const cur = ledger.users[id];
      const limit = limitOf(s, id);

      // ── spent：今日**实际消耗**。只增不减；手动重置余额**不动它**。 ──
      // ⚠️ 老账本没有 spent 字段时的迁移：起点是 `used + value`（= 这次扣费之后的合计），
      //    并且本次加法**只做一次**。曾经写成"先赋 used+value 再统一加一次 value"，
      //    于是本次扣费被算了两遍，今日用量正好是余额扣减量的两倍。
      cur.spent = (cur.spent === undefined || cur.spent === null)
        ? Math.max(0, Number(cur.used) || 0) + value
        : Math.max(0, Number(cur.spent) || 0) + value;

      // ── used：**余额扣减量**（唯一决定拦不拦）。封顶：超额部分不累加，
      //    否则额度设 100、账本却显示 300，看着像没生效。 ──
      const before = Math.max(0, Number(cur.used) || 0);
      let after = before + value;
      if (limit > 0 && after > limit) after = limit;
      cur.used = after;

      cur.name = p.name || cur.name || '';
      cur.updatedAt = Date.now();
      // totals 跟**余额口径**走，所以累加封顶后的增量而不是 value ——
      // 否则封顶时"今日合计"会比各人之和大。
      ledger.totals[key] = (Number(ledger.totals[key]) || 0) + (after - before);
    }
    saveLedger();
    // 累计账本**不在这里**加：唯一来源是会话存档（scanSessions）。
    // 曾经想过在这里顺手累加，但那样会重复记账 —— 会话文件写盘后扫描还会再计一次，
    // 而且 after-response 是**每次 LLM 调用**都触发（一轮里可能十几次），
    // 一次运行会被加十几遍。存档只有一个事实来源，别绕开它。
  }
};

// ── 能力：让核心决定"这一轮还要不要花钱" ─────────────────────────────────
export const providers = {
  /**
   * 返回 { skip: true, reason } = 告诉核心"这一轮一条 LLM 请求都别发"。
   *
   * 判定：这一轮的参与者**全部**额度已用尽。只要还有一个人有余量就放行 ——
   * 整轮开销本来就记在全体参与者头上，为一个人花一整轮的钱是合理的，
   * 把所有人都拦掉才是要的效果。
   * 返回 null = 不归我管，核心照常往下走（没启用时核心根本不会调用到这里）。
   */
  'chat.quota-gate': (context = {}) => {
    const { chatKey, triggerEntries, willRespond, tier, sendState } = context;
    // 档位已经决定不回（例如 1 档没被 @）：不用我们拦，正常走"没回话"路径
    if (willRespond === false) return null;

    const s = settings();

    // ① 发送限流前置（省掉"想完了却发不出去"的纯浪费）
    //
    // 核心的发送限流（config.send.maxPerMinute / maxPerHour）原先只在**真正发送
    // 那一刻**由 sender 的 #checkRate 拦下 —— 那时候模型已经把话想完了，
    // token 花了，消息却被退回给模型（"发送频率超限，请等一会再发"）。
    // 这是纯粹的浪费：本来就发不出去，根本不该问模型。
    //
    // 核心已经把只读的发送状态（sendState）交过来了，这里据此在**请求模型之前**
    // 拦掉。策略在插件里，所以可以随时开关、调阈值，不用改核心。
    if (s.blockWhenSendLimited && sendState) {
      if (sendState.ok === false) {
        return {
          skip: true,
          // code 是给核心/界面看的**结构化原因**，reason 是给人看的文案。
          // 只靠 reason 字符串去猜类型太脆（改一个字就失效），所以显式给码。
          code: 'rate-limited',
          reason: `${sendState.reason}，本轮不请求模型（零消耗）`
        };
      }
      // 更细的一层：剩余条数不够发一句话时也别问。
      // 一次回复通常是 1~3 条，配置里 minMessages 才是"最少要发几条"，
      // 这里只在**一条都发不出**时才拦（上面那条），剩余条数只用于提示，
      // 避免"因为只剩 1 条就不回了"这种过度拦截。
    }

    // ② 额度用尽：参与者全部超额 → 整轮零消耗
    const key = dayKey(Date.now(), s.resetHour);
    const ledger = loadLedger();
    const speakers = participantsOf(triggerEntries, null);
    const st = runStateFor(context);

    // ⚠️ 这一分支修的是一个"完全没拦住"的漏洞：
    //    before-context 已经把超额者的消息从 triggerEntries 里**剔掉**了，
    //    如果这一轮所有人都超额，剔完就是**空数组**。原先这里 `if (!speakers.length) return null`
    //    会把它当成"本来没人说话"，返回 null = 不归我管 —— 于是核心照常调用模型，
    //    钱照花，而用户看到的是"消息被吞了"（实际是花了钱才没回）。
    //    所以必须区分两种空：
    //      · 本来就没有他人消息（主动机会等）→ 不拦，走核心原有路径；
    //      · 有人说过话但全被剔除 → **必须拦**。
    const incoming = st ? Number(st.incoming) || 0 : (triggerEntries || []).length;
    if (!speakers.length) {
      if (incoming > 0) {
        // 名字从"今天被拦过的人"里取，能对上是谁把这一轮占满的
        const who = Object.keys(ledger.blocked?.[key] || {});
        return {
          skip: true,
          code: 'quota-exhausted',
          reason: `本轮发言的人额度都已用尽（${tier} 档本会响应）`
            + (who.length ? `：${who.join('、')}` : '')
        };
      }
      return null;                                   // 确实没人发言（主动机会等）→ 不拦
    }

    const blocked = speakers.filter((p) => {
      const limit = limitOf(s, p.userId);
      return limit > 0 && usedOf(ledger, p.userId, key) >= limit;
    });
    if (blocked.length !== speakers.length) return null;   // 还有人没超额 → 照常响应

    const names = blocked.map((p) => p.name || p.userId).join('、');
    return { skip: true, code: 'quota-exhausted', reason: `额度已用尽（${tier} 档本会响应）：${names}` };
  }
};

// ── 生命周期 ────────────────────────────────────────────────────────────

/**
 * 宿主注入的能力快照。
 *
 * api.fetch 只对**声明了 web_fetch 权限**的插件开放（见 plugin.json 的 permissions），
 * 它比裸用全局 fetch 好在两点：
 *   ① 走宿主的实现（代理/超时等策略与其它模块一致）；
 *   ② 测试里能被替换，不必真的发网络请求。
 * 拿不到时退回全局 fetch —— 本插件只请求本机 127.0.0.1 的自己人接口。
 */
let injected = {};

export function setup(api) {
  injected = api || {};
}

function doFetch(url, opts) {
  const f = typeof injected.fetch === 'function' ? injected.fetch : globalThis.fetch;
  return f(url, opts);
}

export function activate() {
  loadLedger();
  // 跨天（或改了重置时刻）时清掉旧日期的"拦截计数"，避免界面显示陈年数字。
  // 只清 blocked，users 里的历史留着（换回旧重置时刻还能看到那天的账）。
  const s = settings();
  const key = dayKey(Date.now(), s.resetHour);
  const ledger = loadLedger();
  let pruned = 0;
  for (const k of Object.keys(ledger.blocked || {})) {
    if (k !== key) { delete ledger.blocked[k]; pruned++; }
  }
  if (pruned) saveLedger();
}

export function deactivate() {
  // 只清运行期状态，**绝不清账本** —— 账本是跨运行的持久数据。
  runState.clear();
  settledWatermark.clear();
}

// ── 控制台页面动作（POST /api/plugin-ui/quota-guard/action）─────────────
export async function handleUiRequest({ action, payload } = {}) {
  // ⚠️ 这里**不能**在函数开头缓存一次 settings：setLimit / removeUser / save 都要
  //    先写配置再回快照，用开头那份旧快照会让界面显示"改了但列表没变"
  //    （实测复现：设完额度榜单照旧是空的）。一律现读。
  const key = dayKey(Date.now(), settings().resetHour);

  const snapshot = () => {
    const s = settings();
    const ledger = loadLedger();
    const today = todayUsage();      // 当日账本为空时用会话存档兜底
    const ids = new Set([...Object.keys(s.perUser), ...Object.keys(ledger.users), ...Object.keys(today.users)]);
    const rows = [...ids].map((qq) => {
      const rec = ledger.users[qq];
      const isToday = !!(rec && rec.dayKey === key);
      const limit = limitOf(s, qq);
      // 会话存档兜底（插件后装时，"今天"的历史只在存档里）
      const usedFromSessions = Number(today.users[qq]) || 0;
      // ⚠️⚠️ 这两个数**不是一个东西**，必须分开取（我已经搞错过好几次）：
      //   used  = 余额扣减量 → 决定「当前余额」，手动重置余额会清零它
      //   spent = 今日实际消耗 → 界面「今日用量」，手动重置**不清零**它
      //   两者只在"没重置过"时相等；一旦点过重置就会分叉，界面上必须分别显示。
      //   到设定时刻 dayKey 翻篇，两个一起归零（这才是"到点一起重置"）。
      const used = isToday ? usedOf(ledger, qq, key) : usedFromSessions;
      const spent = isToday ? spentOf(ledger, qq, key) : usedFromSessions;
      const own = s.perUser[qq];
      // 额度来源要讲清楚：界面上一眼看出"这个数是单独设的，还是跟着全局默认走的"。
      // 否则用户改了默认额度，会以为单独设过的人也跟着变了。
      const limitSource = own ? 'individual' : (s.defaultDailyLimit > 0 ? 'default' : 'none');
      // 账本记下的真实昵称：**只有今天发过言才有**（没发过言就无从得知他是谁）
      const realName = isToday ? String(rec.name || '') : '';
      const note = String(own?.note || '');
      return {
        userId: qq,
        // ⚠️ name / note / displayName 三者语义不同，不能互相冒充：
        //    name        账本里的真实昵称（今天发过言才有；没发言就是空）
        //    note        用户自己写的备注（标签性质）
        //    displayName 界面该显示什么：有昵称用昵称，没昵称才退回备注，都没有就空。
        //    曾经把 `name || note` 直接当成 name 返回，结果"只改了个备注"就把昵称
        //    显示成了备注（实测踩中）—— 那是拿标签冒充分身，会让人认错是谁。
        //    分开之后：界面负责展示（用 displayName），判定逻辑只认 name/note 本身。
        name: realName,
        note,
        displayName: realName || note,
        hasNickname: !!realName,
        // ⚠️ used / spent 千万别漏：界面上「当前余额」看 used、「今日用量」看 spent。
        //    曾经在加注释重构时把它们从返回对象里挤掉过 —— 症状是列表上所有用量
        //    都变成空、合计变成 NaN、超额判断全部失效，而插件不报任何错。
        /** 余额扣减量（决定「当前余额」，也决定拦不拦） */
        used,
        /** 今日实际消耗（决定「今日用量」，不受手动重置影响） */
        spent,
        limit,
        limitSource,                                    // individual | default | none(不限)
        hasOwnQuota: !!own,
        /** 单独额度本身（0 = 该人单独不限）；没单独设过就是 null */
        ownLimit: own ? own.limit : null,
        // ⚠️ 余额/进度/超额判定**只能用 used**（余额扣减量）。
        //    用 spent 会让"重置了余额却还在被拦"——因为 spent 不会因重置变小。
        remaining: limit > 0 ? Math.max(0, limit - used) : null,
        percent: limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0,
        over: limit > 0 && used >= limit,
        blockedCount: Number(ledger.blocked?.[key]?.[qq]) || 0,
        /** 今天说过话（有真实用量或有拦截）；false = 只是设了额度还没用上 */
        activeToday: spent > 0 || Number(ledger.blocked?.[key]?.[qq]) > 0,
        lastUpdatedAt: isToday ? (Number(rec.updatedAt) || 0) : 0
      };
    }).sort((a, b) => b.spent - a.spent || a.userId.localeCompare(b.userId));
    return {
      ok: true,
      settings: {
        resetHour: s.resetHour,
        defaultDailyLimit: s.defaultDailyLimit,
        notifyOnBlock: s.notifyOnBlock,
        notifyText: s.notifyText,
        blockWhenSendLimited: s.blockWhenSendLimited
      },
      // 插件开关的唯一真相（config.skills[id].enabled）。带上它，本页才能显示
      // "正在生效 / 待命"并让用户就地切换 —— 否则用户在本页看不到也开不了。
      enabled: isSkillEnabledInConfig(SKILL_ID, false),
      dayKey: key,
      resetAt: nextResetAt(Date.now(), s.resetHour),
      // 今日**用量**合计（真实消耗，不受手动重置影响）—— 界面上"今日合计"用它
      totalUsed: rows.reduce((a, r) => a + r.spent, 0),
      // 余额合计（= 各人余额扣减量之和）。点了重置余额，这个会跟着降。
      // 两个都给出来，界面才能如实说明"重置的是余额、不是用量"。
      totalCharged: rows.reduce((a, r) => a + r.used, 0),
      // 与当日账本同一口径（按 resetHour 切），今天有多少人多少量
      todaySource: today.source,
      todayTotal: today.tokens,
      stats: {
        people: rows.length,
        capped: rows.filter((r) => r.hasOwnQuota).length,
        over: rows.filter((r) => r.over).length,
        activeToday: rows.filter((r) => r.activeToday).length
      },
      rows
    };
  };

  /** 校验并规整一个额度值：必须是不小于 0 的有限数。 */
  const cleanLimit = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.max(0, Math.round(n));
  };

  switch (String(action || '')) {
    case 'state':
      // 顺手推进累计回填：增量扫只读新会话，常驻开销很小（见 kickScan）。
      // 第一次会分片跑几秒，界面按 scan.partial 显示"正在统计"。
      kickScan();
      return { ...snapshot(), scan: scanProgress() };

    /** 总用量排行榜（数据来自会话存档，见 scanSessions）。 */
    case 'cumulative':
      kickScan();
      return { ...snapshot(), board: cumulativeBoard() };

    /** 重建累计账本（忽略缓存全量重扫）。用于怀疑数字不对、或手改过存档时。 */
    case 'rebuildCumulative': {
      cumulativeCache = emptyCumulative();
      saveCumulative();
      scanSessions({ force: true, budgetMs: 0 });   // budgetMs=0 → 只起个头，剩下的交给 kickScan
      scanState.running = false;
      kickScan(1500);
      return { ...snapshot(), board: cumulativeBoard(), rebuilt: true };
    }

    case 'save': {
      const p = payload || {};
      // 与「插件」页的设置表单同源（同一个 config.skills['quota-guard']）
      persistSkillConfig({
        resetHour: Number(p.resetHour),
        defaultDailyLimit: Number(p.defaultDailyLimit),
        notifyOnBlock: p.notifyOnBlock === true,
        notifyText: String(p.notifyText ?? ''),
        blockWhenSendLimited: p.blockWhenSendLimited !== false
      });
      return { ...snapshot(), saved: true };
    }

    /** 给某人设额度（limit 为 0 = 不限，等于取消限额但保留他在榜上）。 */
    case 'setLimit': {
      const qq = String(payload?.userId ?? '').trim();
      if (!/^\d{4,12}$/.test(qq)) return { ok: false, error: 'QQ 号不合法' };
      const limit = cleanLimit(payload?.limit);
      if (limit === null) return { ok: false, error: '额度必须是不小于 0 的数字' };
      const cur = settings();                 // 现读，别用函数开头那份（下面要基于它改）
      const perUser = { ...cur.perUser };
      perUser[qq] = {
        limit,
        note: String(payload?.name ?? perUser[qq]?.note ?? '').slice(0, 40)
      };
      persistSkillConfig({ perUser });
      return { ...snapshot(), saved: true };
    }

    /** 批量给多人设同一个额度（界面里勾选多个人一次改）。 */
    case 'setLimits': {
      const ids = Array.isArray(payload?.userIds) ? payload.userIds.map((x) => String(x).trim()) : [];
      const valid = ids.filter((id) => /^\d{4,12}$/.test(id));
      if (!valid.length) return { ok: false, error: '没有勾选任何有效的人' };
      const limit = cleanLimit(payload?.limit);
      if (limit === null) return { ok: false, error: '额度必须是不小于 0 的数字' };
      const cur = settings();
      const perUser = { ...cur.perUser };
      const note = String(payload?.name ?? '').slice(0, 40);
      for (const id of valid) {
        perUser[id] = { limit, note: note || perUser[id]?.note || '' };
      }
      persistSkillConfig({ perUser });
      return { ...snapshot(), saved: true, affected: valid.length };
    }

    case 'removeUser': {
      const qq = String(payload?.userId ?? '').trim();
      const cur = settings();
      const perUser = { ...cur.perUser };
      delete perUser[qq];
      persistSkillConfig({ perUser });
      return { ...snapshot(), saved: true };
    }

    /** 从账本里彻底删掉一个人（连同他的额度）。用于加错号码的情况。 */
    case 'deletePerson': {
      const qq = String(payload?.userId ?? '').trim();
      if (!/^\d{4,12}$/.test(qq)) return { ok: false, error: 'QQ 号不合法' };
      const cur = settings();
      const perUser = { ...cur.perUser };
      delete perUser[qq];
      persistSkillConfig({ perUser });
      const ledger = loadLedger();
      delete ledger.users[qq];
      for (const k of Object.keys(ledger.blocked || {})) delete ledger.blocked[k][qq];
      ledgerCache = ledger;
      saveLedger();
      return { ...snapshot(), saved: true };
    }

    /** 给某人加/改备注（只是给人看的标签，不参与任何判定）。 */
    case 'setNote': {
      const qq = String(payload?.userId ?? '').trim();
      if (!/^\d{4,12}$/.test(qq)) return { ok: false, error: 'QQ 号不合法' };
      const cur = settings();
      const perUser = { ...cur.perUser };
      const note = String(payload?.note ?? '').slice(0, 40);
      perUser[qq] = { limit: perUser[qq]?.limit ?? 0, note };
      persistSkillConfig({ perUser });
      return { ...snapshot(), saved: true };
    }

    /**
     * 重置**余额**：带 userId = 只重置他；不带 = 所有人。
     *
     * 重置的对象是还剩多少可花：把今天的用量清零，余额就恢复满额。
     * 今日用量与余额是同一个数（都按天存），所以它们到设定时刻会一起归零，
     * 点重置时也一起清零 —— 这两件事本来就是一致的。
     */
    case 'reset': {
      const qq = String(payload?.userId ?? '').trim();
      const ledger = loadLedger();
      // 先把还没扫到的会话扫完，再动手。
      // 顺序很重要：重置后这些人切到"只认账本"，没扫到的今日会话就再也进不了
      // 当日数字了（总量不受影响，但当日会凭空少一截）。
      const drained = drainScan();
      const before = todayUsage();      // 重置前的当日用量（可能来自存档兜底）

      if (!ledger.userFloors || typeof ledger.userFloors !== 'object') ledger.userFloors = {};
      const floors = ledger.userFloors[key] || (ledger.userFloors[key] = {});

      /**
       * 取/建这个人的当日账本条目。
       * 跨天（dayKey 变了）时两个计数一起归零 —— 这就是"到设定时刻，今日用量和余额一起被重置"。
       */
      const ensureRec = (id) => {
        const rec = ledger.users[id] || (ledger.users[id] = { dayKey: key, used: 0, spent: 0, name: '', updatedAt: 0 });
        if (rec.dayKey !== key) { rec.dayKey = key; rec.used = 0; rec.spent = 0; }
        return rec;
      };
      /**
       * 重置某人的**余额**：只把余额扣减量（used）清零 → 余额回满。
       * ⚠️ **不动 spent** —— 今日用量是"今天真实花了多少"，是个事实，
       *    手动重置余额不该篡改它（这正是之前反复搞错的地方）。
       */
      const resetBalance = (id) => {
        const rec = ensureRec(id);
        // 老账本只有 used 没有 spent：先把当前 used 认作今日用量，再清余额扣减量，
        // 否则"今日用量"会跟着余额一起变成 0（那就又混成一个东西了）。
        if (rec.spent === undefined || rec.spent === null) rec.spent = Math.max(0, Number(rec.used) || 0);
        rec.used = 0;   // 只有余额被重置
        rec.updatedAt = Date.now();
        floors[id] = true;      // 从此刻起只认账本（不再用存档兜底，否则会立刻长回来）
        return rec;
      };

      if (qq) {
        // ⚠️ 必须**无条件**建条目，不能只在 `ledger.users[qq]` 已存在时才归零。
        //    插件是后装的：今天的历史消耗只在会话存档里，账本里根本没这个人。
        //    旧写法 `if (ledger.users[qq]) {...}` 对这种情况是**空操作** ——
        //    点了重置、界面数字纹丝不动，而返回值还说 saved:true。
        resetBalance(qq);
        if (ledger.blocked?.[key]) delete ledger.blocked[key][qq];
      } else {
        for (const id of Object.keys(ledger.users)) resetBalance(id);
        // 存档兜底里出现、但账本里还没有今天记录的人，也要一起重置（否则余额算不出来）
        for (const id of Object.keys(before.users || {})) {
          if (ledger.users[id]?.dayKey === key) { floors[id] = true; continue; }
          resetBalance(id);
        }
        if (!ledger.blocked || typeof ledger.blocked !== 'object') ledger.blocked = {};
        ledger.blocked[key] = {};
      }
      // 当天的总计跟着重算，否则统计条上的"今日合计"仍停在重置前的数
      // （旧写法只在全局重置时才更新 totals，单人重置后台账对不上）。
      ledger.totals[key] = Object.entries(ledger.users)
        .filter(([, u]) => u && u.dayKey === key)
        .reduce((a, [, u]) => a + (Number(u.used) || 0), 0);
      ledgerCache = ledger;
      saveLedger();
      // drained=false 表示有积压没扫完，当日数字可能少算一点（总量不受影响）
      return { ...snapshot(), saved: true, drained };
    }

    /**
     * 拉协议端的**好友列表**，供界面"从列表选人"用 —— 免得手打 QQ 号打错。
     */
    case 'fetchFriends': {
      const port = Number(payload?.port) || 3210;
      try {
        const d = await coreApi(port, '/api/onebot/friends');
        const known = new Set(snapshot().rows.map((x) => x.userId));
        return {
          ok: true,
          friends: (Array.isArray(d.friends) ? d.friends : []).map((f) => ({
            userId: f.id, name: f.name, nickname: String(f.name || ''), hasQuota: known.has(String(f.id))
          }))
        };
      } catch (error) {
        return { ok: false, error: `拉取好友列表失败：${String(error?.message ?? error)}` };
      }
    }

    /** 拉群列表，供"从群成员选人"先选一个群。 */
    case 'fetchGroups': {
      const port = Number(payload?.port) || 3210;
      try {
        const d = await coreApi(port, '/api/onebot/groups');
        const groups = (Array.isArray(d.groups) ? d.groups : []).map((g) => ({
          id: String(g.id), name: String(g.name || g.id)
        }));
        return { ok: true, groups };
      } catch (error) {
        return { ok: false, error: `拉取群列表失败：${String(error?.message ?? error)}` };
      }
    }

    /**
     * 拉某个群的成员（核心的 /api/groups/<id>/members，内部走 get_group_member_list）。
     *
     * 这是"手动填 QQ 号"之外真正可用的选人方式：群里的人本来就只有 QQ 号能对上，
     * 从成员列表里点一下比记号码靠谱得多。
     * 显示名优先用群名片（card），它才是群里实际看到的名字。
     */
    case 'fetchMembers': {
      const port = Number(payload?.port) || 3210;
      const groupId = String(payload?.groupId ?? '').trim();
      if (!/^\d{4,12}$/.test(groupId)) return { ok: false, error: '群号不合法' };
      try {
        const d = await coreApi(port, `/api/groups/${encodeURIComponent(groupId)}/members`);
        const known = new Set(snapshot().rows.map((x) => x.userId));
        const members = (Array.isArray(d.members) ? d.members : []).map((m) => {
          const uid = String(m.userId || '');
          const nick = String(m.nickname || '');
          const card = String(m.card || '');
          return {
            userId: uid,
            // 显示名优先群名片（那才是群里看到的名字），没有才退回昵称
            name: card || nick || uid,
            // ⚠️ 昵称要单独留着：群里几乎人人有名片，只按显示名搜的话，
            //    用真实昵称（"李四"）根本搜不到设了名片的他（"群里的昵称"）。
            nickname: nick,
            hasQuota: known.has(uid)
          };
        }).filter((m) => m.userId);
        return { ok: true, groupId, members };
      } catch (error) {
        return { ok: false, error: `拉取群成员失败：${String(error?.message ?? error)}` };
      }
    }

    /**
     * 开关插件本体。
     *
     * 唯一真相仍是 config.skills['quota-guard'].enabled（宿主「插件」页那个开关），
     * 这里只是让用户在本页也能切换 —— 原来只有宿主插件页能开，
     * 用户在本页看到一个"待命"状态却找不到开关，等于没有开关。
     * 走核心的 setSkillEnabled，不自己另存一份状态。
     */
    case 'setEnabled': {
      const on = payload?.enabled === true;
      setSkillEnabled(SKILL_ID, on);
      // ⚠️ 只写配置是不够的：能力是否被核心取用，取决于这个 Skill 在管理器里
      //    是不是"生效中"。运行期改开关必须同步跑生命周期，否则要等下次
      //    重扫/重启才生效 —— 表现为"开关打开了但根本没在拦人"。
      //    宿主自己的 /api/skills 开关也是这个两步写法（routes.js 里 setSkillEnabled
      //    + activate/deactivate），这里保持一致。
      try {
        if (on) skillManager.activate(SKILL_ID);
        else skillManager.deactivate(SKILL_ID);
      } catch { /* 活动期回调失败不该让开关本身失败 */ }
      return { ...snapshot(), saved: true };
    }

    default:
      return { ok: false, error: `未知动作：${action}` };
  }
}
