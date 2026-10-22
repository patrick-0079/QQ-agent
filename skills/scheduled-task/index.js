// 定时任务（scheduled-task）
//
// 一句话：到点之后**唤醒 AI**，让它在原来那个会话里执行当时说明的事项 ——
// 走的是和「主动发起会话（冷场主动开话题）」同一条路，而不是让核心直接甩一条死文本。
//
// 三段链路，缺一不可：
//   1. 落盘：模型调 schedule_task → lib/store.mjs 写 <数据目录>/scheduled-tasks.json
//      （重启不丢；停机期间错过的，起来后补跑一次）
//   2. 唤醒：本文件每 20 秒对一次钟 → orchestrator.wake(chatKey, { proactive: true })
//      —— 和核心的提醒循环同一套节奏，只是核心那条只发文本
//   3. 交底：唤醒之后这一轮要告诉模型"为什么醒的"。走 before-llm-messages 钩子，
//      把当时那段说明追加进这一轮的 user 消息里（调用点见 orchestrator 里对
//      hookBeforeLlmMessages 的调用）
//
// 为什么不用核心的 reminders：那一份是"到点由核心直接发一条文本"的闹钟，两个版本
// 的模型侧工具还不一样（bugfix 有 set_reminder，整合版没有）。改造它要同时踩两边，
// 而且会把既有闹钟的语义改掉。这里是独立技能 + 独立存储，只复用"唤醒"那一段。

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { TaskStore } from './lib/store.mjs';
import { planSchedule, nextDueAfter, formatDue, describeRepeat } from './lib/time.mjs';
import { hostPatchStatus, applyHostPatch, revertHostPatch, requestRestart, defaultRoot } from './host-patch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
  maxPerChat: 5,          // 单会话最多几条待触发任务（防捣乱）
  maxPerUser: 3,          // 单人单会话最多几条
  minIntervalMinutes: 5,  // 周期任务的最小间隔
  tickMs: 20_000,
  injectTtlMs: 3 * 60_000,   // 唤醒后钩子几乎立刻就到；给足余量但不留过夜
  autoRestart: true,      // 打完宿主补丁后自动重启一次让补丁生效
  fallbackText: true      // 拿不到编排器时，退化成发一条文本提醒
};

const RESTART_FLAG = path.join(HERE, '.restart-pending');

let api = null;                 // setup(api) 存下来：日志、配置、注册表
let host = null;                // activate(ctx) 存下来：宿主句柄（orchestrator / sender / config）
let store = null;
let tickTimer = null;
let firstTickTimer = null;
let tickBusy = false;
const firing = new Set();
/** chatKey → { block, taskId, expiresAt }：等这一轮的模型消息组装时注入，注入即消费。 */
const pendingInject = new Map();

// ── 小工具 ────────────────────────────────────────────────────────────────

function conf() {
  let saved = {};
  try { saved = api?.config?.() || {}; } catch { saved = {}; }
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = typeof DEFAULTS[k] === 'number' ? Number(v) : v;
  }
  return out;
}

function log(...a) { (api?.log || console.log)(...a); }
function warn(...a) { (api?.warn || console.warn)(...a); }

function dataDir() {
  return host?.config?.dataDir
    || process.env.QQ_AGENT_DATA_DIR
    || path.resolve(HERE, '..', '..', 'data');
}

function dataFile() {
  return path.join(dataDir(), 'scheduled-tasks.json');
}

function ok(content) { return { content }; }
function err(content) { return { content, isError: true }; }

/**
 * 谁在说话。两个版本的执行上下文给的东西不一样，按"最可信的先来"取：
 *   ctx.triggerUserIds  整合版直接给（触发这次运行的人）
 *   ctx.session.trigger 两个版本都有；私聊只有对方，群里取最后一条非自己的
 * 拿不到就返回空 —— 调用方据此决定"能不能确认这是不是你自己设的任务"。
 */
function callerId(ctx = {}) {
  const ids = Array.isArray(ctx.triggerUserIds) ? ctx.triggerUserIds.filter(Boolean) : [];
  if (ids.length) return String(ids[ids.length - 1]);
  const trig = ctx?.session?.trigger;
  if (Array.isArray(trig)) {
    const last = [...trig].reverse().find((e) => e && !e.self && e.senderId);
    if (last) return String(last.senderId);
  }
  return '';
}

/** 触发这次运行的会话，按"先信 ctx、再信 activate 时拿到的 host"取。 */
function chatKeyOf(ctx = {}) {
  return String(ctx?.chatKey || '').trim();
}

// ── 注册工具（skill.json 里 tools[] 是给设置页看的元数据，真正的注册在这里）──

export function setup(skillApi) {
  api = skillApi;

  api.registerTool({
    id: 'schedule_task',
    name: '安排定时任务',
    description: '安排一个定时任务：到点系统会唤醒你（和"主动发起会话"同一条路），你按 text 里写的事项在那个会话里执行。适用：有人说"10 分钟后提醒我""每天八点跟我说早安""每周一提醒我交周报""帮我记着点"。到点你会看到 text 原文。',
    category: 'system',
    icon: '⏰',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: '到点要执行的事项。写给你的未来自己看：写清对谁、做什么（例："提醒 XX 该吃药了"、"跟大家说早安，并报一句今天的天气"）。到点你会原样看到这段。'
        },
        delayMinutes: { type: 'number', description: '多少分钟后触发（一次性；与 atTime 二选一）' },
        atTime: { type: 'string', description: '触发时间：一次性用 "HH:MM"（今天/明天）或 "YYYY-MM-DD HH:MM"；每天/每周用 "HH:MM" 作为那个时间点' },
        repeat: { type: 'string', enum: ['once', 'daily', 'weekly', 'interval'], description: '重复方式：once（默认，一次性）/ daily 每天 / weekly 每周 / interval 每隔 N 分钟' },
        intervalMinutes: { type: 'number', description: 'repeat=interval 时必填：每隔多少分钟（最小见配置，默认 5）' },
        weekdays: { type: 'array', items: { type: 'number' }, description: 'repeat=weekly 时必填：1=周一 … 7=周日，例如 [1,3,5]' }
      },
      required: ['text']
    },
    async execute(ctx, args) {
      if (!store) return err('定时任务还没激活（技能开关没打开，或刚启用还没生效）。');
      const text = String(args.text ?? '').trim();
      if (!text) return err('text 不能为空：写清到点要做什么。');
      if (text.length > 800) return err(`text 太长了（${text.length} 字），压到 800 字以内 —— 它到点会原样进你的上下文。`);

      const chatKey = chatKeyOf(ctx);
      if (!chatKey) return err('拿不到当前会话标识，没法把它和会话绑起来。');

      const c = conf();
      const plan = planSchedule(args, Date.now(), { minIntervalMinutes: Number(c.minIntervalMinutes) || 5 });
      if (plan.error) return err(plan.error);

      const by = callerId(ctx);
      if (store.countIn(chatKey) >= (Number(c.maxPerChat) || 5)) {
        return err(`本会话的定时任务已经到上限（${c.maxPerChat} 条）了。用 list_scheduled_tasks 看看有哪些，先取消不用的。`);
      }
      if (by && store.countByUser(chatKey, by) >= (Number(c.maxPerUser) || 3)) {
        return err(`你自己在这个会话里的定时任务已经到上限（${c.maxPerUser} 条）了。先取消一条再设。`);
      }

      const entry = store.add({
        chatKey,
        kind: String(ctx.kind || chatKey.split(':')[0] || ''),
        text,
        dueAt: plan.dueAt,
        repeat: plan.repeat,
        timeOfDay: plan.timeOfDay,
        weekdays: plan.weekdays,
        intervalMinutes: plan.intervalMinutes,
        createdBy: by,
        createdByName: String(ctx?.session?.trigger?.find((e) => String(e?.senderId) === by)?.senderName || '')
      });

      const when = `${formatDue(entry.dueAt)}（${describeRepeat(entry)}）`;
      return ok(JSON.stringify({
        set: true,
        id: entry.id,
        nextAt: entry.dueAt,
        when,
        note: `已安排好：${when} 到点我会在这个会话里醒过来处理。回复里请把具体时间用普通话说给提要求的人听。`
      }, null, 1));
    }
  });

  api.registerTool({
    id: 'list_scheduled_tasks',
    name: '查看定时任务',
    description: '查看当前会话里还没到点（或还在重复）的定时任务。适用："我设了什么定时""还有哪些提醒""那个每天的任务还在吗"。',
    category: 'system',
    icon: '📋',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      if (!store) return err('定时任务还没激活。');
      const chatKey = chatKeyOf(ctx);
      const list = store.pending(chatKey);
      if (!list.length) return ok('当前会话没有还没触发的定时任务。');
      const me = callerId(ctx);
      const lines = list.map((t, i) => {
        const mine = me && String(t.createdBy) === me ? '（你设的）' : '';
        return `${i + 1}. [${t.id}] ${formatDue(t.dueAt)} · ${describeRepeat(t)}${mine}\n   ${t.text}`;
      });
      return ok(`当前会话还有 ${list.length} 条定时任务：\n${lines.join('\n')}`);
    }
  });

  api.registerTool({
    id: 'cancel_scheduled_task',
    name: '取消定时任务',
    description: '取消一个还没结束的定时任务（单次或周期都行，周期任务取消后就彻底不再跑）。id 从 list_scheduled_tasks 取。适用："取消那个提醒""别每天发了""刚才那个不算"。',
    category: 'system',
    icon: '🗑️',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要取消的任务 id（list_scheduled_tasks 里的 [t_xxx]）' },
        asOwner: { type: 'boolean', description: '只有在你能确认提要求的人是主人/管理员时才传 true —— 用来取消别人设的任务。拿不准就别传。' }
      },
      required: ['id']
    },
    async execute(ctx, args) {
      if (!store) return err('定时任务还没激活。');
      const task = store.byId(args.id);
      if (!task) return err(`没找到任务 ${args.id}（可能已经跑完或已经取消了，用 list_scheduled_tasks 查一下）。`);
      if (chatKeyOf(ctx) && task.chatKey !== chatKeyOf(ctx)) {
        return err('这条任务不属于当前会话，不能在别的会话里删。');
      }
      const me = callerId(ctx);
      const mine = me && String(task.createdBy) === me;
      if (!mine && args.asOwner !== true) {
        return err(me
          ? '这条任务不是你设的。只有设它的本人、或者主人/管理员才能取消 —— 确认对方是主人就把 asOwner 传 true 再调一次。'
          : '拿不到你的 QQ 号，没法确认这条任务是不是你设的。如果你就是设它的人、或者你是主人/管理员，把 asOwner 传 true 再调一次。');
      }
      store.remove(task.id);
      return ok(`已取消：${formatDue(task.dueAt)} ${describeRepeat(task)} —— ${task.text}`);
    }
  });
}

// ── 生命周期 ──────────────────────────────────────────────────────────────

export function activate(ctx = {}) {
  host = {
    orchestrator: ctx.orchestrator || null,
    sender: ctx.sender || null,
    config: ctx.config || null,
    onebot: ctx.onebot || null
  };
  store = new TaskStore(dataFile());
  adoptHostDataDir().catch(() => {});
  ensureHostContext().catch((error) => warn('检查宿主句柄时出错：', error?.message ?? error));
  startTicker();
  const pending = store.pending();
  log(`已启用（数据文件 ${dataFile()}）${pending.length ? `，待触发 ${pending.length} 条` : ''}`);
}

export function deactivate(ctx = {}) {
  stopTicker();
  pendingInject.clear();
  const reason = String(ctx?.reason || '');
  if (reason === 'reload' || reason === 'reload-failed') {
    // 热重载（改了文件/重扫插件）会先 deactivate 再 activate：这时候摘补丁
    // 纯属自残 —— 摘完下次启动就拿不到句柄，而这一次重启也白搭。
    return;
  }
  const r = revertHostPatch({ root: defaultRoot() });
  if (r?.reverted) log('已摘除宿主补丁');
  if (r?.conflict) warn('摘除宿主补丁失败：', r.conflict);
}

export function dispose() {
  stopTicker();
  pendingInject.clear();
}

// ── 宿主句柄：能白拿就白拿，拿不到才打补丁 ────────────────────────────────

async function ensureHostContext() {
  if (typeof host?.orchestrator?.wake === 'function') {
    // 原生支持（整合版走这条）：什么也不用做，顺带清掉可能残留的重启标记。
    try { fs.rmSync(RESTART_FLAG, { force: true }); } catch { /* ignore */ }
    return true;
  }

  const status = hostPatchStatus({ root: defaultRoot() });
  if (!status.supported) {
    warn('这个宿主既没把编排器交给技能，也没有可打的补丁锚点（', status.reason || status.conflict || '原因未知', '）——到点会退化成发一条文本提醒。');
    return false;
  }
  if (status.applied) {
    if (fs.existsSync(RESTART_FLAG)) {
      warn('补丁已打上，但这次启动仍然拿不到句柄 —— 不再自动重启（防循环）。功能退化为发文本提醒。');
      return false;
    }
    const r = await restartWithFlag();
    warn('宿主补丁已就位但本次进程没吃到，需要重启一次才能唤醒 AI', r?.ok ? '：正在自动重启…' : `（${r?.reason}）`);
    return false;
  }

  const applied = applyHostPatch({ root: defaultRoot() });
  if (!applied.ok) {
    warn('打宿主补丁失败：', applied.conflict, '——到点会退化成发一条文本提醒。');
    return false;
  }
  log(`已给宿主补上「扩展上下文」补丁（${applied.file}）；停用本技能时会自动摘掉。`);
  const r = await restartWithFlag();
  if (r?.ok) log('补丁要下次启动才生效，正在自动重启一次…');
  else warn('补丁要下次启动才生效，但我没法自动重启（', r?.reason, '）——请手动关掉软件重开一次。');
  return false;
}

/**
 * 兜底问一次宿主的 src/config.js 要 DATA_DIR。
 *
 * 为什么需要：没拿到宿主上下文时（还没打补丁的那一次启动），我们只能猜数据目录
 * 是 <应用根>/data —— 可用 PROFILE 跑多实例时真实目录是 data2、data3，
 * 任务就会写到别的实例看不见的地方。src/config.js 此刻早就被宿主加载进内存了，
 * 这里 import 拿到的就是同一个模块实例，零成本拿到真值。
 * 技能被单独搬出去跑（没有 src/）时会失败，那就继续用猜的那个。
 */
async function adoptHostDataDir() {
  if (host?.config?.dataDir) return;
  try {
    const mod = await import(new URL('../../src/config.js', import.meta.url).href);
    const dir = mod?.DATA_DIR;
    if (!dir) return;
    if (path.resolve(dir) === path.dirname(store.file)) return;
    log(`数据目录改用宿主报的：${dir}`);
    store = new TaskStore(path.join(dir, 'scheduled-tasks.json'));
  } catch { /* 没有宿主的 src/ 就用猜的那个 */ }
}

/** 自动重启一次；标记文件保证同一个坑只重启一次（否则会变成无限重启）。 */
async function restartWithFlag() {
  if (!conf().autoRestart) return { ok: false, reason: '配置里关掉了 autoRestart' };
  try { fs.writeFileSync(RESTART_FLAG, String(Date.now()), 'utf8'); } catch { /* ignore */ }
  return requestRestart({ delayMs: 1500 });
}

// ── 每 20 秒对一次钟 ──────────────────────────────────────────────────────

function startTicker() {
  stopTicker();
  const tickMs = Math.max(5000, Number(conf().tickMs) || DEFAULTS.tickMs);
  tickTimer = setInterval(() => { tick().catch(() => {}); }, tickMs);
  tickTimer.unref?.();
  // 启动后先来一次：停机期间错过的任务在这里补跑
  firstTickTimer = setTimeout(() => { tick().catch(() => {}); }, 3000);
  firstTickTimer.unref?.();
}

function stopTicker() {
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  if (firstTickTimer) { clearTimeout(firstTickTimer); firstTickTimer = null; }
}

async function tick() {
  if (tickBusy || !store) return;
  tickBusy = true;
  try {
    sweepExpiredInjections();
    const now = Date.now();
    for (const task of store.due(now)) {
      if (firing.has(task.id)) continue;
      firing.add(task.id);
      try {
        await fire(task, now);
        // 只有"确实交出去了"才改状态：反过来的话，进程崩溃/发送失败会把任务永久吞掉。
        store.markFired(task.id, nextDueAfter(task, now));
      } catch (error) {
        warn(`触发失败，下一轮重试（${task.id}）：`, error?.message ?? error);
      } finally {
        firing.delete(task.id);
      }
    }
    store.prune();
  } finally {
    tickBusy = false;
  }
}

/**
 * 过了有效期还没被消费的说明：说明宿主那一轮的钩子没按预期跑到（版本差异 / 中途出错），
 * 模型醒来时没看到事项。这里只留痕不补发 —— 它已经被唤醒过一次了，事后再补一条
 * 文本提醒会变成没头没脑的重复。日志里能看见，便于按版本对钩子形状。
 */
function sweepExpiredInjections() {
  const now = Date.now();
  for (const [chatKey, entry] of pendingInject) {
    if (now <= entry.expiresAt) continue;
    pendingInject.delete(chatKey);
    warn(`任务 ${entry.taskId} 的说明没能注入模型上下文（${chatKey}）：宿主的 before-llm-messages 钩子形状可能变了，或者那一轮正好不是主动唤醒。`);
  }
}

async function fire(task, now) {
  const late = now - Number(task.dueAt || 0) > 90_000;
  const block = buildInjection(task, { late });
  const orchestrator = host?.orchestrator;

  if (typeof orchestrator?.wake === 'function') {
    pendingInject.set(task.chatKey, { block, taskId: task.id, expiresAt: Date.now() + (Number(conf().injectTtlMs) || DEFAULTS.injectTtlMs) });
    try {
      // 不 await：wake 要跑完一整轮模型调用，等它会把后面到点的任务全堵住。
      Promise.resolve(orchestrator.wake(task.chatKey, { proactive: true, proactiveReason: 'scheduled-task' }))
        .catch((error) => {
          pendingInject.delete(task.chatKey);
          warn(`唤醒失败（${task.chatKey}）：`, error?.message ?? error);
          return sendFallback(task, { late }).catch(() => {});
        });
    } catch (error) {
      pendingInject.delete(task.chatKey);
      throw error;
    }
    return;
  }

  if (!conf().fallbackText) throw new Error('拿不到 orchestrator.wake 且关闭了文本退化');
  if (typeof host?.sender?.sendTextBatch !== 'function') {
    throw new Error('拿不到 orchestrator.wake，也没有 sender 可以退化');
  }
  await sendFallback(task, { late });
}

/** 拿不到编排器时的兜底：至少把这件事说出来。 */
function sendFallback(task, { late }) {
  const when = formatDue(task.dueAt);
  const head = late ? `⏰ 定时任务（原定 ${when}，延迟触发）` : '⏰ 定时任务';
  const r = host.sender.sendTextBatch(task.chatKey, [`${head}：${task.text}`]);
  return Promise.resolve(r);
}

function buildInjection(task, { late = false } = {}) {
  const when = formatDue(task.dueAt);
  const head = late ? `【定时任务】（原定 ${when}，延迟触发）` : `【定时任务】（${when}）`;
  const who = task.createdByName ? `${task.createdByName}（QQ:${task.createdBy || '未知'}）` : '这个会话里的人';
  return [
    head,
    `${who}当时让你记着这件事：`,
    task.text,
    '到点了，按上面的说明执行 —— 这就是当时要求说明的事项。像你主动发起会话那样自然处理：该发言就发言，确实不适合在这儿说话也可以安静结束。'
  ].join('\n');
}

// ── 把说明交到这一轮的模型消息里 ──────────────────────────────────────────

/**
 * 判断"这一轮是不是主动唤醒的那一轮"。
 * 只看两个版本都给得出的线索，不猜：
 *   · bugfix 宿主在 hook 里直接给 proactive 布尔值
 *   · 两个版本都给 session；主动唤醒的会话没有触发消息（trigger 为空数组），
 *     正常消息驱动的一定有（没有未读就不会跑）
 */
function looksLikeProactiveTurn(payload) {
  if (payload?.proactive === true) return true;
  const session = payload?.session;
  if (!session) return false;
  if (Array.isArray(session.trigger)) return session.trigger.length === 0;
  return String(session.triggerSummary || '').startsWith('主动机会');
}

export const hooks = {
  // 钩子拿到的是同一个 messages 数组引用，原地改就会生效（两个版本都这么约定的）
  'before-llm-messages': (payload = {}) => {
    const chatKey = String(payload?.chatKey || '');
    if (!chatKey) return;
    const entry = pendingInject.get(chatKey);
    if (!entry) return;
    if (Date.now() > entry.expiresAt) { pendingInject.delete(chatKey); return; }
    // 不是我们唤醒的那一轮就别插手：这 10 分钟里可能插进来一条真人消息，
    // 把"定时任务说明"塞进那轮回复就变成了张冠李戴。
    if (!looksLikeProactiveTurn(payload)) return;
    const messages = payload.messages;
    if (!Array.isArray(messages) || !messages.length) return;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role !== 'user') continue;
      messages[i].content = `${messages[i].content}\n\n${entry.block}`;
      pendingInject.delete(chatKey);   // 只注入一次
      return;
    }
  }
};

// 自检/排障用的出口（不参与运行时）
export const internals = { conf, buildInjection, looksLikeProactiveTurn, dataFile, pendingInject, tick };
