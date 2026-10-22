// 群聊复读机（repeat-echo）：群里两个人连着发一模一样的话 → 薄荷跟着复读一遍。
//
// 为什么是「原型补丁」而不是 hooks：
//   5 个 hook（before-context / before-llm-messages / after-response / before-tool /
//   after-tool）都只在**已经排定一次模型会话之后**才触发。而复读恰恰要发生在
//   "这条消息根本没触发会话"的时候 —— 群里绝大多数消息都走 onIncoming 的早退路径
//   （判定不触发 → 标已读 → return），任何 hook 都看不见它们。
//   所以这里包一层 Orchestrator.prototype.onIncoming：它是**每一条**入站消息的
//   必经点，而且 this 上就挂着 sender —— 复读走完整发送管道（串行/限频/去重/留档），
//   一分钱 token 都不花（全程没有任何模型调用）。
//
// 安全边界：
//   · 只观察、不改变原方法行为（原方法先跑，返回值原样透出；异常只记日志）；
//   · 关掉插件 = 摘钩子，不留任何监听；
//   · 防刷屏四道闸 + 「薄荷正在回话就让路」（见 logic.js 与 plugin.json）。
//
// ⚠️ 本文件在 resources/app 里，应用自动更新会覆盖；装回来即可（配置不受影响）。

import fs from 'node:fs';
import path from 'node:path';
import { Orchestrator } from '../../src/orchestrator.js';
// 主日志（data/logs/qq-agent-*.log）：复读属于"她说了话但没经过模型"的动作，
// 必须留痕，否则事后翻日志只看到一条无来源的发送记录。api.log 只走 console、不落盘。
import { logger } from '../../src/logger.js';
// ⚠️ 数据目录必须问 config.js 要，不能按本项目录推算：DATA_DIR 会被
// QQ_AGENT_DATA_DIR / QQ_AGENT_PROFILE 重定向（本机就跑在安装根目录的 data/ 下，
// 而不是 resources/app/data/ —— 自己拼路径的状态文件会写到一个没人看的角落）。
import { DATA_DIR } from '../../src/config.js';

const PATCH_KEY = Symbol.for('qq-agent.repeat-echo.patch');
const STATE_FILE = path.join(DATA_DIR, 'repeat-echo.json');
const STATE_FLUSH_MS = 30_000;

let api = null;
let Logic = null;      // logic.js 的模块命名空间（动态导入，见 setup）
let engine = null;
let lastFlush = 0;

/** 节流写状态文件：看"钩子是否活着 / 复读过什么"用（observed 一直在涨 = 钩子在收消息）。 */
function flushState() {
  const now = Date.now();
  if (now - lastFlush < STATE_FLUSH_MS || !engine) return;
  lastFlush = now;
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      savedAt: new Date(now).toLocaleString('zh-CN', { hour12: false }),
      ...engine.stats()
    }, null, 1), 'utf8');
  } catch { /* 写不出状态不影响复读 */ }
}

export async function setup(skillApi) {
  api = skillApi;
  // ⚠️ 动态 + 时间戳导入 logic.js：加载器只给**入口**做了 ?t= 缓存击穿，
  //    静态 import 的 './logic.js' 会一直命中旧模块 —— 改了逻辑热重载后跑的还是老的
  //    （本插件踩过：状态文件里始终缺新字段）。这里自己刷新。
  Logic = await import(`./logic.js?t=${Date.now()}`);
  engine = new Logic.RepeatEcho({ settings: () => (api?.config?.() || {}) });
}

export function available() {
  return { ok: true };
}

export function activate() {
  const ok = install();
  if (ok) logger.info('repeat-echo', '群聊复读机已挂载：onIncoming 钩子（0 token，四道限流闸）');
}

export function deactivate() {
  uninstall();
}

export function dispose() {
  uninstall();
  engine?.clear?.();
  engine = null;
}

/** 状态查询能力：给控制台/排障用（不是给模型的工具）。 */
export const providers = {
  'repeat-echo.status': () => (engine ? engine.stats() : null)
};

/**
 * 装上钩子。幂等：同一个 prototype 上只包一次，热重载只换 handle。
 * 这样即使旧模块实例的 deactivate 没被调到，也不会出现"包两层、发两遍"。
 */
function install() {
  const proto = Orchestrator?.prototype;
  if (!proto || typeof proto.onIncoming !== 'function') {
    logger.warn('repeat-echo', '拿不到 Orchestrator.prototype.onIncoming，复读机未挂载（应用版本可能变了）');
    return false;
  }
  if (!engine && Logic) engine = new Logic.RepeatEcho({ settings: () => (api?.config?.() || {}) });

  let rec = proto[PATCH_KEY];
  if (!rec) {
    const original = proto.onIncoming;
    const wrapped = function onIncoming(chatKey, entry = null) {
      const out = original.call(this, chatKey, entry);
      // 复读是旁路增强：原方法先完成（排不排唤醒已定），再决定要不要跟一句。
      try {
        const cur = proto[PATCH_KEY];
        if (cur && typeof cur.handle === 'function') {
          const p = cur.handle(this, chatKey, entry);
          if (p && typeof p.catch === 'function') p.catch(() => {});
        }
      } catch (error) {
        logger.warn('repeat-echo', `复读观察失败：${error?.message ?? error}`);
      }
      return out;
    };
    rec = { original, wrapped, handle: null };
    proto[PATCH_KEY] = rec;
    proto.onIncoming = wrapped;
  }
  rec.handle = handle;
  return true;
}

/** 摘钩子：只在确认当前 onIncoming 还是我们那只时才还原。 */
function uninstall() {
  const proto = Orchestrator?.prototype;
  const rec = proto?.[PATCH_KEY];
  if (!rec) return;
  rec.handle = null;
  if (proto.onIncoming === rec.wrapped) proto.onIncoming = rec.original;
  delete proto[PATCH_KEY];
}

async function handle(orch, chatKey, entry) {
  if (!engine || !entry) return;
  if (!String(chatKey || '').startsWith('group:')) return;

  // 先判定（会推进"上一条"），再决定发不发 —— 放弃发送时那一枪不占配额。
  const hit = engine.judge(chatKey, entry);
  flushState();   // 节流 30 秒写一次状态文件（observed 一直在涨 = 钩子活着）
  if (!hit) return;

  const o = engine.opts();
  if (o.onlyWhenIdle) {
    try {
      if (orch?.runningChats?.has?.(chatKey) || orch?.pendingWake?.has?.(chatKey)) {
        logger.info('repeat-echo', `${chatKey} 跳过复读（会话在跑/等待中）：${hit.text.slice(0, 20)}`);
        return;
      }
    } catch { /* 内部字段形状变了就当不忙，不阻断复读 */ }
  }

  const sender = orch?.sender;
  if (!sender || typeof sender.sendTextBatch !== 'function') return;
  if (!engine.reserve(chatKey, hit)) return;   // 四道限流闸

  try {
    const r = await sender.sendTextBatch(chatKey, [hit.text]);
    logger.info('repeat-echo', `复读 ${chatKey}：${hit.text.slice(0, 40)}`);
    if (r?.sent?.[0]?.deduped) logger.info('repeat-echo', '（被发送去重窗口拦下，未真的发出）');
  } catch (error) {
    // 睡眠闸门 / 发送限频都会在这里抛：正常业务拒绝，不当错误刷屏
    logger.warn('repeat-echo', `复读没发出去：${error?.message ?? error}`);
  }
  lastFlush = 0;      // 刚复读过，下一次观察立刻落状态（不用等 30 秒）
  flushState();
}

/** 自测用：拿到当前引擎实例。 */
export const internals = { get engine() { return engine; }, install, uninstall };
