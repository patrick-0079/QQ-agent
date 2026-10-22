// 群打卡（punch-card）：按排名自动完成 **QQ 群自带的打卡**（就是手机 QQ 里
// 「群打卡」那个按钮，打卡后会出现在群打卡榜上，名次就是榜单上的真实名次）。
//
// 打的是真打卡，不是发一条「打卡」文字：
//   协议端（SnowLuma 1.14+）提供两个扩展 action（已在真实环境实测）：
//     get_group_signed_list   只读，返回今日打卡榜：[{user_id, nick, time, rank}, …]
//     send_group_sign（别名 set_group_sign）  写入 = QQ 群自带的「打卡」
//   流程：定期只读查一次打卡榜 → 今天已有 N-1 个人打了 → 调 send_group_sign 真打一次
//   → 机器人排在当天第 N 名（与手机 QQ 里看到的榜单完全一致）。
//   实测样例：群 324632156 返回 5 条，rank 从 1 到 5，带昵称与时间戳。
//
// 为什么是轮询而不是消息钩子：
//   打卡榜是 QQ 服务端的数据，别人打卡时**不一定**在群里发消息，监听消息会漏；
//   直接查榜单才准。所以主路径是低频轮询（默认 30 秒一次，只读、不产生任何消息）。
//   消息入口（Orchestrator.onIncoming）仍然挂着，但**只用来接收测试指令**
//   （//强制打卡、//打卡状态、//打卡重置），不再参与计数。
//
// 「排名」怎么算：设置里的「我要当第几个打卡的人」= N。等到榜单上有 N-1 个人
//   （不含机器人自己）时打卡，机器人就是当天第 N 个。默认 3。填 1 = 有动静就先打。
//
// 读不到打卡榜的群（没开启群打卡功能，实测会返回 retcode 100）：
//   不降级、不发文字 —— 只是这一轮不打，继续按周期重试，日志里每天提示一次原因。
//
// 怎么拿到实例：Orchestrator 实例没法从外面拿，就在原型方法上包一层拿 this。
//   同一个 Orchestrator 身上挂着 sender（完整发送管道）与 onebot（协议端）。
//   幂等 + 可摘除（Symbol.for 保证热重载后认得出上一次的包层）。
//
// 安全边界：
//   · 生效范围：填了「自定义群号白名单」只认那些群；没填则沿用全局白名单。
//     全局黑名单永远优先拦截；
//   · 每群每天只打一次，不刷屏（QQ 的打卡本身一天也只能打一次）；
//   · 关掉插件 = 摘钩子 + 停定时器，不留监听；
//   · 全程 0 token，不调模型。
//
// ⚠️ 本文件在 resources/app 里，应用自动更新会覆盖；装回来即可（配置不受影响）。

import fs from 'node:fs';
import path from 'node:path';
import { Orchestrator } from '../../src/orchestrator.js';
import { OneBotClient } from '../../src/onebot.js';
import { logger } from '../../src/logger.js';
import { DATA_DIR, getConfig } from '../../src/config.js';
import { isChatAdmittedById, isChatDenied, profiledChatKeys } from '../../src/chat-profiles.js';

const PLUGIN_ID = 'punch-card';
const STATE_FILE = path.join(DATA_DIR, 'punch-card.json');

// 原型钩子标记（用 Symbol.for：热重载后是新模块实例，普通 Symbol 会认不出上一次的钩子）
const OB_CALL_KEY = Symbol.for('qq-agent.punch-card.ob.call');
const OB_CONNECT_KEY = Symbol.for('qq-agent.punch-card.ob.connect');
const ORCH_KEY = Symbol.for('qq-agent.punch-card.orch.onIncoming');

let api = null;
let onebotRef = null;
let orchRef = null;
let lastFlush = 0;
let tickTimer = null;      // 轮询打卡榜 + 到点兜底
let listWarnSig = '';      // 群号解析失败提示按「原始文本」记，改了内容就再提示一次

const groupState = new Map();   // groupId -> { day, selfPunched, selfRank, ... }
const stats = {
  captured: false,     // 是否已拿到会话调度器
  messages: 0,         // 看过的消息数（排障用）
  punched: 0,          // 机器人真实打卡成功的次数
  lastRank: 0,         // 最近一次打卡是当天第几个
  lastGroup: '',
  lastAt: 0,
  day: '',             // 当前统计日
  signedListsFetched: 0,  // 成功读到 QQ 打卡榜的次数
  lastSignedCount: 0,     // 最近一次榜单上的人数
  signApiCalls: 0,        // 真实打卡调用成功的次数
  signApiFails: 0,        // 真实打卡调用失败的次数
  catchUps: 0,         // 到点兜底自己打卡的次数
  testRuns: 0,
  lastTest: '',
  lastError: ''
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

function settings() {
  try { return (typeof api?.config === 'function' ? api.config() : null) || {}; }
  catch { return {}; }
}

function debug(msg) {
  if (settings().debugLog !== true) return;
  logger.info(PLUGIN_ID, msg);
}

// ── 生命周期 ────────────────────────────────────────────────────────────

export async function setup(skillApi) {
  api = skillApi;
}

export function available() {
  return { ok: true };
}

export function activate() {
  const ok = install();
  if (ok) {
    const scope = customWhitelist().active ? '自定义群号白名单内生效' : '沿用全局白名单（未填自定义群号）';
    logger.info(PLUGIN_ID, `群打卡已挂载（0 token，等 ${waitFor()} 人打卡后我打第 ${waitFor() + 1} 个，${scope}）`);
  }
  loadState();
  startTicking();
}

export function deactivate() {
  stopTicking();
  uninstall();
  flushState(true);
}

export function dispose() {
  stopTicking();
  uninstall();
  flushState(true);
  groupState.clear();
}

/** 状态查询能力：给控制台/排障用（不是给模型的工具）。 */
export const providers = {
  'punch-card.status': () => ({
    ...stats,
    targetRank: Math.max(1, Math.round(num(settings().targetRank, 3))),
    waitFor: waitFor(),
    whitelist: [...customWhitelist().ids],
    whitelistMode: customWhitelist().ids.size ? '自定义群号' : '沿用全局白名单',
    groups: [...groupState.entries()].map(([gid, st]) => ({
      group: gid, day: st.day, mode: st.signMode,
      signedCount: st.signedCount, othersCount: st.othersCount,
      selfPunched: st.selfPunched, selfRank: st.selfRank,
      lastPunchAt: st.lastPunchAt ? new Date(st.lastPunchAt).toLocaleString('zh-CN', { hour12: false }) : ''
    }))
  })
};

// ── 捕获 + 挂钩 ─────────────────────────────────────────────────────────

/** 在原型方法上包一层，只为拿到 this（实例）。幂等，可还原。
 *  before 返回 'veto' 时**不调用原方法**（用来拦下测试指令、不让它去吵模型）。 */
function patchMethod(proto, name, key, before) {
  if (!proto || typeof proto[name] !== 'function') return false;
  let rec = proto[key];
  if (!rec) {
    const original = proto[name];
    const wrapped = function (...args) {
      try { if (before(this, args) === 'veto') return; } catch { /* 捕获失败绝不影响原调用 */ }
      return original.apply(this, args);
    };
    rec = { original, wrapped };
    proto[key] = rec;
    proto[name] = wrapped;
  }
  return true;
}

function unpatchMethod(proto, name, key) {
  const rec = proto?.[key];
  if (!rec) return;
  if (proto[name] === rec.wrapped) proto[name] = rec.original;
  delete proto[key];
}

function install() {
  let ok = false;
  // 这两处只是为了尽早拿到协议端实例（没人说话时也要能查榜单、打卡）
  patchMethod(OneBotClient?.prototype, 'call', OB_CALL_KEY, (inst) => capture(inst));
  patchMethod(OneBotClient?.prototype, 'connect', OB_CONNECT_KEY, (inst) => capture(inst));
  // 主钩子：每条入站消息（已过白名单/屏蔽名单）的必经点 —— 这里只用来接测试指令
  ok = patchMethod(Orchestrator?.prototype, 'onIncoming', ORCH_KEY, (inst, args) => {
    if (inst && !orchRef) {
      orchRef = inst;
      stats.captured = true;
      logger.info(PLUGIN_ID, '已拿到会话调度器（打卡轮询已可用，发送走完整管道：限频/去重/存档）');
    }
    capture(inst?.onebot);
    capture(inst?.sender?.onebot);
    try { handleIncoming(inst, args?.[0], args?.[1]); }
    catch (error) { logger.warn(PLUGIN_ID, `处理消息出错：${error?.message ?? error}`); }
    // 测试指令不该吵模型：命中就标已读并拦下这条（不让 onIncoming 排会话）
    try { if (vetoPunchCommand(inst, args?.[0], args?.[1])) return 'veto'; }
    catch { /* 拦不下就算了，最多机器人多回一句 */ }
  }) || ok;
  if (!ok) {
    logger.warn(PLUGIN_ID, '拿不到 Orchestrator / OneBotClient 原型方法，打卡功能未挂载（应用版本可能变了）');
  }
  return ok;
}

function uninstall() {
  unpatchMethod(OneBotClient?.prototype, 'call', OB_CALL_KEY);
  unpatchMethod(OneBotClient?.prototype, 'connect', OB_CONNECT_KEY);
  unpatchMethod(Orchestrator?.prototype, 'onIncoming', ORCH_KEY);
  orchRef = null;
  onebotRef = null;
  stats.captured = false;
}

/** 记下协议端实例（查榜单、打卡、发消息要用）。 */
function capture(inst) {
  if (!inst || typeof inst !== 'object') return;
  if (typeof inst.call !== 'function' && typeof inst.sendText !== 'function') return;
  if (!onebotRef) onebotRef = inst;
}

function selfId() {
  const id = onebotRef?.selfId;
  return id ? String(id) : '';
}

// ── 消息处理（只接测试指令）────────────────────────────────────────────

function handleIncoming(orch, chatKey, entry) {
  const s = settings();
  if (s.enabled === false) return;
  const key = String(chatKey ?? '');
  if (!key.startsWith('group:') && !key.startsWith('private:')) return;
  if (!entry || entry.self === true) return;             // 自己发的不算
  const senderId = String(entry.senderId ?? '');
  if (!senderId) return;
  if (selfId() && senderId === selfId()) return;         // 双重保险

  const isGroup = key.startsWith('group:');
  const gid = isGroup ? String(key.split(':')[1] ?? '') : '';
  const text = cleanText(entry.text);
  if (!text) return;
  stats.messages++;
  stats.day = dayKey();

  if (s.testCommands === false) return;
  if (!isGroup && !gid) { /* 私信没有群号，走指令里的群号 */ }

  let cmd = matchPunchCommand(text);
  // @机器人 + //打卡 = 在指挥机器人自己动手 → 升级为「强制打卡」（不看人数，立刻打）。
  // 用 entry.atMe（核心按 QQ 号判定的权威标记），群友和机器人重名也不会误判。
  if (cmd && cmd.action === 'punch' && entry.atMe === true) cmd = { ...cmd, action: 'force', byAt: true };
  if (!cmd) return;

  if (isGroup) markHandled(key, text);   // 防协议端重发导致跑两遍
  runCommand(cmd, { chatKey: key, gid, senderId }).catch((error) => {
    stats.lastError = String(error?.message ?? error);
    logger.warn(PLUGIN_ID, `测试指令执行出错：${stats.lastError}`);
  });
}

/** 不 await：打卡不该阻塞消息入站。 */
function firePunch(gid, opts = {}) {
  punch(gid, opts).catch((error) => {
    stats.lastError = String(error?.message ?? error);
    logger.warn(PLUGIN_ID, `打卡失败：${stats.lastError}`);
  });
}

/** 延迟一下再打：别人刚打完自己秒跟，太像脚本。 */
async function waitBeforePunch() {
  const s = settings();
  const base = clamp(num(s.delaySec, 3), 0, 120);
  const jitter = clamp(num(s.delayJitterSec, 3), 0, 60);
  const wait = Math.round((base + (jitter > 0 ? Math.random() * jitter : 0)) * 1000);
  if (wait > 0) await sleep(wait);
}

/**
 * 打一次卡 = 调 QQ 群自带的打卡（手机 QQ 里那个「打卡」按钮）。
 * 不看人数时用 opts.force；到点兜底用 opts.catchUp。
 */
async function punch(gid, opts = {}) {
  const s = settings();
  if (s.enabled === false) return false;
  const st = stateOf(gid);
  rollDay(st);
  if (st.punching) { debug(`群 ${gid} 正在打卡中，跳过这次`); return false; }
  if (st.selfPunched && s.oncePerDay !== false && opts.test !== true && opts.force !== true) {
    debug(`群 ${gid} 我今天已经打过卡了（第 ${st.selfRank} 个），不再重复`);
    return false;
  }

  st.punching = true;
  try {
    await waitBeforePunch();
    // 打之前再读一次榜单：拿最新人数，也顺带确认这个群能打卡
    const list = await refreshSigned(gid);
    if (!list) {
      logger.warn(PLUGIN_ID, `群 ${gid} 打卡中止：读不到今日打卡榜（${st.signError || '未知原因'}）—— 这个群可能没开启群打卡功能`);
      return false;
    }
    const rank = st.othersCount + 1;
    try {
      await doGroupSign(gid);
    } catch (error) {
      const msg = String(error?.message ?? error);
      st.signError = msg.slice(0, 200);
      // 今天已经打过了（QQ 的打卡一天只能打一次）→ 别反复重试
      if (/已经打卡|已打卡|重复|already|已经.*打过/i.test(msg)) {
        st.selfPunched = true;
        logger.info(PLUGIN_ID, `群 ${gid} 打卡接口回「今天已经打过卡了」，按已打卡处理`);
        flushState(true);
        return false;
      }
      stats.signApiFails++;
      throw error;
    }
    stats.signApiCalls++;
    st.selfPunched = true;
    st.selfRank = rank;
    st.lastPunchAt = Date.now();
    st.catchUpDay = st.day;
    stats.punched++;
    stats.lastRank = rank;
    stats.lastGroup = gid;
    stats.lastAt = Date.now();
    if (opts.catchUp === true) stats.catchUps++;
    const why = opts.force === true ? '，强制打卡' : (opts.catchUp === true ? '，到点兜底' : '');
    logger.info(PLUGIN_ID, `群 ${gid} 已真实打卡（QQ 打卡榜当天第 ${rank} 个${why}）`);
    // 5 秒后回查一次榜单：确认真的上榜，并拿到真实名次
    setTimeout(() => {
      refreshSigned(gid).then(() => flushState(true)).catch(() => {});
    }, 5000).unref?.();
    flushState(true);
    return true;
  } finally {
    st.punching = false;
  }
}

// ── 到点兜底：今天一直没人打到目标名次，就自己打一次 ────────────────────

let lastTickDay = '';
let lastPollAt = 0;         // 上次查打卡榜的时间（控制轮询间隔）

function startTicking() {
  stopTicking();
  // 15 秒醒一次；真正查榜单的频率由 pollIntervalSec 控制（默认 30 秒）
  tickTimer = setInterval(() => {
    tick().catch((error) => logger.warn(PLUGIN_ID, `[打卡检查] 出错：${error?.message ?? error}`));
  }, 15000);
  tickTimer.unref?.();
  // 启动 15 秒后先建一次基线（顺便知道这些群能不能读到打卡榜）
  setTimeout(() => { tick().catch(() => {}); }, 15000).unref?.();
}

function stopTicking() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
}

async function tick() {
  const s = settings();
  if (s.enabled === false) return;
  if (!onebotRef || typeof onebotRef.call !== 'function') return;   // 还没拿到协议端

  // ① 主路径：按 QQ 打卡榜轮询（只读查询，不产生任何消息）
  const interval = clamp(Math.round(num(s.pollIntervalSec, 30)), 10, 3600);
  if (!lastPollAt || Date.now() - lastPollAt >= interval * 1000) {
    lastPollAt = Date.now();
    for (const gid of targetGroups().slice(0, 8)) {
      try { await checkSignedAndPunch(gid); }
      catch (error) { debug(`群 ${gid} 打卡检查出错：${error?.message ?? error}`); }
      await sleep(200);
    }
  }

  // ② 到点兜底：今天一直没人打到目标名次，就自己打一次
  if (s.catchUpEnabled !== true) return;

  const now = new Date();
  const hh = clamp(Math.round(num(s.catchUpHour, 23)), 0, 23);
  const mm = clamp(Math.round(num(s.catchUpMinute, 0)), 0, 59);
  if (now.getHours() * 60 + now.getMinutes() < hh * 60 + mm) return;

  for (const gid of targetGroups().slice(0, 8)) {
    try {
      const st = stateOf(gid);
      rollDay(st);
      if (st.selfPunched) continue;
      if (st.catchUpDay === st.day) continue;
      st.catchUpDay = st.day;
      logger.info(PLUGIN_ID, `[兜底] 群 ${gid} 到点还没打卡（今天榜单 ${st.othersCount} 人），机器人自己打一次`);
      firePunch(gid, { catchUp: true });
    } catch { /* 单个群出问题不影响其它群 */ }
  }
  // 顺手把跨天也记下来（状态里每群自己会 rollDay，这里只为了日志里看得见）
  lastTickDay = dayKey();
}

// ── 测试指令 ────────────────────────────────────────────────────────────

const CMD_ACTIONS = { 状态: 'status', 情况: 'status', 查询: 'status', 重置: 'reset', 清零: 'reset', 复位: 'reset', 重来: 'reset' };

// 「强制打卡」的说法：不看人数、不排队，立刻真打一次（今天打过就回一句提示）。
const FORCE_WORDS = new Set(['强制打卡', '立刻打卡', '马上打卡', '打卡!', '打卡！']);

/**
 * 识别测试指令，后面最多跟一个号码：
 *   //打卡          → 回一句今天的打卡榜情况（真打卡榜模拟不了「别人打卡」）
 *   //强制打卡      → 不看人数，立刻真打一次（已打过就回提示）
 *   //打卡状态      → 回一句今天的进度
 *   //打卡重置      → 清零重来
 *   群里：  //打卡状态           → 当前群
 *   私信：  //打卡状态 324632156 → 指定群号（不带则用「私信预览用的群号」）
 * @returns {{ action: 'punch'|'force'|'status'|'reset', num: string } | null}
 */
export function matchPunchCommand(text) {
  const t = String(text ?? '')
    .replace(/／/g, '/')                     // 全角斜杠也认（中文输入法下很容易打成 ／／）
    .replace(/^([@＠]\S{0,30}\s*)+/, '')     // 去掉手打的「@昵称」前缀
    .trim();
  const m = t.match(/^\/{2}\s*(强制打卡|立刻打卡|马上打卡|打卡[!！]|打卡|签到|打咭)\s*(状态|情况|查询|重置|清零|复位|重来)?\s*(\d{4,20})?\s*$/);
  if (!m) return null;
  const action = FORCE_WORDS.has(m[1]) ? 'force' : (CMD_ACTIONS[m[2]] ?? 'punch');
  return { action, num: String(m[3] ?? '') };
}

/** 真正干活：状态 / 重置 / 强制打卡。 */
async function runCommand(cmd, { chatKey, gid, senderId }) {
  const s = settings();
  stats.testRuns++;
  const isPrivate = String(chatKey).startsWith('private:');
  const target = String(isPrivate ? (cmd.num || s.testDefaultGroup || '') : gid);

  // ── 查状态 ──
  if (cmd.action === 'status') {
    if (!target) {
      await replyPrivate(senderId, '查状态要带群号：//打卡状态 群号');
      return true;
    }
    const st = stateOf(target);
    rollDay(st);
    await refreshSigned(target);          // 只读刷一次，让状态显示实时数据
    const wait = waitFor();
    const modeTxt = st.signMode === 'api' ? '真实打卡' : '未探测到打卡榜';
    const counted = st.signMode === 'api'
      ? `QQ 打卡榜今天 ${st.signedCount} 人（除机器人 ${st.othersCount} 人）`
      : '还没读到这张榜（群可能没开打卡功能）';
    const msg = `[打卡状态] 群 ${target}（${st.day}）${counted}，模式：${modeTxt}；`
      + `目标：凑够 ${wait} 人后我打第 ${wait + 1} 个；`
      + (st.selfPunched ? `我今天已打卡，是第 ${st.selfRank} 个。` : '我今天还没打卡。');
    stats.lastTest = msg;
    if (isPrivate) await replyPrivate(senderId, msg);
    else await deliver(target, msg);
    return true;
  }

  // ── 重置 ──
  if (cmd.action === 'reset') {
    if (!target) {
      await replyPrivate(senderId, '重置要带群号：//打卡重置 群号');
      return true;
    }
    const st = stateOf(target);
    st.selfPunched = false;
    st.selfRank = 0;
    st.catchUpDay = '';
    const msg = `[打卡] 群 ${target} 今天的状态已清零（我也可以重新打一次卡了）。`;
    stats.lastTest = msg;
    logger.info(PLUGIN_ID, `[测试] 群 ${target} 打卡状态已重置`);
    if (isPrivate) await replyPrivate(senderId, msg);
    else await deliver(target, msg);
    flushState(true);
    return true;
  }

  // ── //强制打卡：不看人数，立刻真打一次（已打过就回一句提示）──
  if (cmd.action === 'force') {
    if (!target) {
      await replyPrivate(senderId, '强制打卡要带上群号：//强制打卡 群号');
      return true;
    }
    const st = stateOf(target);
    rollDay(st);
    const already = String(s.alreadyPunchedReply ?? '').trim() || '已经打卡过啦';
    if (st.selfPunched) {
      stats.lastTest = `//强制打卡 群 ${target}：今天已打过卡（第 ${st.selfRank} 个），回复「${already}」`;
      logger.info(PLUGIN_ID, `[测试] ${stats.lastTest}`);
      if (isPrivate) await replyPrivate(senderId, already);
      else await deliver(target, already);
      return true;
    }
    stats.lastTest = `//强制打卡 群 ${target}${cmd.byAt ? '（@机器人）' : ''}：跳过人数门槛，立刻打卡`;
    logger.info(PLUGIN_ID, `[测试] ${stats.lastTest}`);
    firePunch(target, { force: true, test: true });
    return true;
  }

  // ── //打卡：真打卡榜改不动，只能回一句说明 ──
  if (!target) {
    await replyPrivate(senderId, '要查哪个群？带上群号：//打卡 群号（要机器人立刻打卡就发「//强制打卡 群号」）');
    return true;
  }
  const st = stateOf(target);
  rollDay(st);
  await refreshSigned(target);
  const tip = `这个群走的是 QQ 真实打卡榜（今天 ${st.signedCount} 人；机器人`
    + (st.selfPunched ? `已打卡，第 ${st.selfRank} 个` : '还没打卡') + '）。'
    + '榜单是 QQ 的数据，模拟不了别人打卡 —— 要让机器人现在就打卡，发「//强制打卡」。';
  stats.lastTest = `//打卡 群 ${target}（真实打卡榜，无法模拟别人）`;
  logger.info(PLUGIN_ID, `[测试] ${stats.lastTest}`);
  if (isPrivate) await replyPrivate(senderId, tip);
  else await deliver(target, tip);
  return true;
}

/** 私信回一句（测试结果/状态用）。 */
async function replyPrivate(uid, text) {
  try {
    // 回执走**直发**，不过发送队列：队列有内容去重，连着测两次第二次会被静默跳过，
    // 表现就是「第一次有反应、之后就没了」。测试反馈要每次都看得到。
    if (onebotRef && typeof onebotRef.sendText === 'function') {
      await onebotRef.sendText('private', uid, text);
      return;
    }
    const sender = orchRef?.sender;
    if (sender && typeof sender.sendTextBatch === 'function') {
      await sender.sendTextBatch(`private:${uid}`, [text]);
      return;
    }
    logger.warn(PLUGIN_ID, '私信回执没发出去：拿不到发送通道（协议端实例未捕获）');
  } catch (error) {
    logger.warn(PLUGIN_ID, `私信回执没发出去：${error?.message ?? error}`);
  }
}

/**
 * 测试指令不该让模型开口：在 onIncoming 处命中就标已读 + 拦下（返回 'veto'）。
 * 群聊和私信都拦；只拦指令，其它消息完全不受影响。
 */
function vetoPunchCommand(orch, chatKey, entry) {
  const s = settings();
  if (s.enabled === false || s.testCommands === false) return false;
  const key = String(chatKey ?? '');
  if (!key.startsWith('group:') && !key.startsWith('private:')) return false;
  if (!entry || entry.self) return false;
  if (!matchPunchCommand(entry.text)) return false;
  try {
    orch?.store?.markEntryRead?.(chatKey, entry.id);
    orch?.emit?.('chat-update', chatKey);
  } catch { /* 标不了已读也照样拦 */ }
  return true;
}

// ── 文本整理（只服务于指令识别）────────────────────────────────────────

/** 去 CQ 码、去开头 @段、全角斜杠归一、压缩空白。 */
export function cleanText(raw) {
  return String(raw ?? '')
    .replace(/\[CQ:[^\]]*\]/g, '')
    .replace(/／/g, '/')
    .replace(/^(?:\s*[@＠][^\s]{1,24}\s*)+/u, '')   // 渲染出来的「@昵称 」可能在最前面
    .replace(/\s+/g, ' ')
    .trim();
}

// ── QQ 群自带打卡接口（真实打卡榜）─────────────────────────────────────

/**
 * 读群今日打卡榜。成功返回数组 [{user_id, nick, time, rank}]；
 * 群没开打卡 / 接口不支持 / 出错 → null（调用方据此跳过这一轮）。
 */
async function fetchSignedList(gid) {
  const ob = onebotRef;
  if (!ob || typeof ob.call !== 'function') return null;
  try {
    // onebot.call 成功直接返回 data，失败（retcode≠0）会 throw
    const r = await ob.call('get_group_signed_list', { group_id: Number(gid) });
    return Array.isArray(r) ? r : (Array.isArray(r?.data) ? r.data : null);
  } catch (error) {
    stateOf(gid).signError = String(error?.message ?? error).slice(0, 200);
    return null;
  }
}

/** 调 QQ 群自带的打卡（= 手机 QQ 里那个「打卡」按钮）。失败会 throw。 */
async function doGroupSign(gid) {
  const ob = onebotRef;
  if (!ob || typeof ob.call !== 'function') throw new Error('拿不到协议端实例（还没接管到接口）');
  try {
    return await ob.call('send_group_sign', { group_id: Number(gid) });
  } catch (first) {
    // 有的协议端只注册了主名 set_group_sign（本项目两个名字都有，这里双保险）
    return await ob.call('set_group_sign', { group_id: Number(gid) });
  }
}

/**
 * 刷新某个群的打卡情况：今天多少人打了、我打没打、我第几个。
 * 读得到榜单 → signMode='api'；读不到 → 'unknown'（继续按周期重试）。
 */
async function refreshSigned(gid) {
  const st = stateOf(gid);
  const list = await fetchSignedList(gid);
  if (!list) {
    if (st.signErrDay !== st.day) {
      st.signErrDay = st.day;
      logger.warn(PLUGIN_ID, `群 ${gid} 读不到 QQ 的今日打卡榜（${st.signError || '未知原因'}）：`
        + '这个群可能没开启群打卡功能。机器人不会在这里发任何文字，只会继续按周期重试。');
    }
    st.signMode = 'unknown';
    return null;
  }
  if (st.signMode !== 'api') {
    logger.info(PLUGIN_ID, `群 ${gid} 已接入 QQ 群打卡榜（真实打卡，人数以榜单为准）`);
  }
  st.signMode = 'api';
  st.signedCount = list.length;
  const me = selfId();
  const mine = me ? list.find((x) => String(x?.user_id ?? '') === me) : null;
  st.othersCount = mine ? Math.max(0, list.length - 1) : list.length;
  if (mine) {
    st.selfPunched = true;
    st.selfRank = Number(mine.rank ?? 0) || st.selfRank || st.signedCount;
  }
  stats.signedListsFetched++;
  stats.lastSignedCount = list.length;
  return list;
}

/** 轮询一次打卡榜：人数够了就轮到我。 */
async function checkSignedAndPunch(gid) {
  const st = stateOf(gid);
  rollDay(st);
  if (st.selfPunched) return false;                 // 今天已经打过了
  const list = await refreshSigned(gid);
  if (!list) return false;                          // 读不到榜：这一轮不打，等下轮重试
  const wait = waitFor();
  if (st.othersCount < wait) {
    debug(`群 ${gid} 打卡榜今天 ${st.othersCount} 人，还差 ${wait - st.othersCount} 人才轮到我`);
    return false;
  }
  logger.info(PLUGIN_ID, `群 ${gid} 打卡榜今天已有 ${st.othersCount} 人打卡，轮到我了（目标：第 ${wait + 1} 个）`);
  firePunch(gid, { trigger: '打卡榜' });
  return true;
}

// ── 发送（只用于测试指令的回执，打卡本身不产生任何消息）─────────────────

/**
 * 优先走 Orchestrator 的 sender（完整管道：串行 / 限频 / 去重 / 睡眠闸门 / 存档）。
 * 只捕获到协议端实例时退化为直接发。
 */
async function deliver(gid, text) {
  const chatKey = `group:${gid}`;
  const sender = orchRef?.sender;
  if (sender && typeof sender.sendTextBatch === 'function') {
    const r = await sender.sendTextBatch(chatKey, [text]);
    if (r?.sent?.[0]?.deduped) logger.info(PLUGIN_ID, `（被发送去重窗口拦下，未真的发出）${gid}`);
    return;
  }
  const ob = onebotRef;
  if (!ob || typeof ob.sendText !== 'function') throw new Error('拿不到发送通道（协议端实例未捕获）');
  await ob.sendText('group', gid, text);
}

// ── 生效群判定 ──────────────────────────────────────────────────────────

/**
 * 解析「自定义群号白名单」文本框。
 * 容错很宽：换行 / 逗号 / 分号 / 空格 / 顿号 都能当分隔符，也认
 * `群123456`、`group:123456`、`123456（摸鱼群）` 这些粘贴过来的写法。
 */
export function parseGroupIds(raw) {
  const text = String(raw ?? '');
  const ids = new Set();
  for (const token of text.split(/[\r\n,，;；、|\t ]+/)) {
    if (!token) continue;
    const m = token.match(/^\D{0,6}(\d{4,20})/);
    if (m) ids.add(m[1]);
  }
  return { ids, raw: text, filled: text.trim().length > 0 };
}

let listWarned = false;
function customWhitelist() {
  const parsed = parseGroupIds(settings().groupWhitelist);
  if (parsed.filled && parsed.ids.size === 0) {
    if (listWarnSig !== parsed.raw) { listWarnSig = parsed.raw; listWarned = false; }
    if (!listWarned) {
      listWarned = true;
      logger.warn(PLUGIN_ID, '自定义群号白名单填了内容，但一个群号都没解析出来 —— '
        + '本次退回「沿用全局白名单」。请一行填一个纯数字群号，例如：324632156');
    }
    return { ids: new Set(), active: false, raw: parsed.raw };
  }
  return { ids: parsed.ids, active: parsed.ids.size > 0, raw: parsed.raw };
}

/**
 * 这个群该不该响应？
 * 优先级：全局黑名单 deny > 自定义群号白名单（填了才算）> 会话准入（profile / 默认放行）。
 * 2026-10-21：旧 allow / allowAllWhenEmpty 已迁入 chatProfiles，改用统一的准入判定。
 */
function groupGate(gid) {
  const id = String(gid);
  const key = `group:${id}`;
  if (isChatDenied(key)) return { ok: false, by: '全局黑名单' };

  const wl = customWhitelist();
  if (wl.active) return { ok: wl.ids.has(id), by: '自定义群号白名单' };

  return isChatAdmittedById('group', id)
    ? { ok: true, by: '会话准入' }
    : { ok: false, by: '未准入' };
}

/** 轮询要遍历的群：优先自定义白名单，否则用已准入的群（profiles）。 */
function targetGroups() {
  const cw = customWhitelist();
  if (cw.active && cw.ids.size) return [...cw.ids];
  const fromProfiles = profiledChatKeys()
    .filter((k) => String(k).startsWith('group:'))
    .map((k) => String(k).slice('group:'.length));
  if (fromProfiles.length) return fromProfiles;
  return [...groupState.keys()];   // 没配白名单：只管探测过的群
}

// ── 状态 ────────────────────────────────────────────────────────────────

function stateOf(gid) {
  let st = groupState.get(String(gid));
  if (!st) {
    st = {
      day: dayKey(), selfPunched: false, selfRank: 0,
      lastPunchAt: 0, catchUpDay: '', punching: false,
      // signMode：'api' = 能读到 QQ 打卡榜；'unknown' = 还没读到（每轮重试）
      signMode: 'unknown', signedCount: 0, othersCount: 0,
      signError: '', signErrDay: ''
    };
    groupState.set(String(gid), st);
  }
  return st;
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * 「今天」是哪一天：以设置里的「新的一天从几点开始」为界（默认 0 点）。
 * 过界就重新计数，机器人也可以重新打一次卡。
 */
export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const rh = clamp(Math.round(num(settings().resetHour, 0)), 0, 23);
  const t = new Date(d.getTime() - rh * 3600000);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

/** 跨天就把状态清零（机器人可以重新打卡）。 */
function rollDay(st) {
  const today = dayKey();
  if (st.day === today) return;
  st.day = today;
  st.selfPunched = false;
  st.selfRank = 0;
  st.catchUpDay = '';
  st.signErrDay = '';
  st.signedCount = 0;
  st.othersCount = 0;
  lastPollAt = 0;              // 新的一天：下一轮立刻查一次打卡榜
  logger.info(PLUGIN_ID, `新的一天（${today}）：打卡计数已重置`);
  flushState(true);
}

/** 我要当第几个打卡的人 → 得先等几个人打完。 */
function waitFor() {
  return Math.max(0, Math.round(num(settings().targetRank, 3)) - 1);
}

/** 指令防重（群内同一条指令 3 秒内只跑一次）。 */
let lastHandled = { key: '', text: '', at: 0 };
function markHandled(key, text) { lastHandled = { key: String(key), text: String(text), at: Date.now() }; }

/** 节流写状态文件：重启后当天的进度还在，不至于「重启一次我又打卡一次」。 */
function flushState(force = false) {
  const now = Date.now();
  if (!force && now - lastFlush < 30000) return;
  lastFlush = now;
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      savedAt: new Date(now).toLocaleString('zh-CN', { hour12: false }),
      day: dayKey(),
      stats,
      groups: [...groupState.entries()].map(([gid, st]) => ({
        group: gid, day: st.day,
        selfPunched: st.selfPunched, selfRank: st.selfRank,
        lastPunchAt: st.lastPunchAt, catchUpDay: st.catchUpDay,
        signMode: st.signMode, signedCount: st.signedCount, othersCount: st.othersCount
      }))
    }, null, 1), 'utf8');
  } catch { /* 写不出状态不影响打卡 */ }
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const today = dayKey();
    let n = 0;
    for (const g of raw?.groups ?? []) {
      if (!g?.group || g.day !== today) continue;   // 只恢复「今天」的，跨天的没人会想要
      const st = stateOf(g.group);
      st.day = g.day;
      st.selfPunched = Boolean(g.selfPunched);
      st.selfRank = Number(g.selfRank ?? 0);
      st.lastPunchAt = Number(g.lastPunchAt ?? 0);
      st.catchUpDay = String(g.catchUpDay ?? '');
      st.signMode = String(g.signMode ?? 'unknown');
      st.signedCount = Number(g.signedCount ?? 0);
      st.othersCount = Number(g.othersCount ?? 0);
      n++;
    }
    if (n) logger.info(PLUGIN_ID, `已恢复 ${n} 个群今天的打卡进度（重启不丢计数：不会重复打卡）`);
  } catch { /* 没存过/坏了就从头开始 */ }
}

/** 自测/排障用：拿到内部引用。 */
export const internals = {
  get onebot() { return onebotRef; },
  get orch() { return orchRef; },
  get stats() { return stats; },
  install, uninstall, capture,
  handleIncoming, punch, firePunch,
  fetchSignedList, doGroupSign, refreshSigned, checkSignedAndPunch,
  matchPunchCommand, cleanText,
  parseGroupIds, groupGate, customWhitelist, waitFor, dayKey, stateOf, rollDay,
  tick, startTicking, stopTicking, flushState, loadState,
  runCommand, vetoPunchCommand, replyPrivate, deliver
};
