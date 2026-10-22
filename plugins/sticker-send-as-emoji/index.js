/**
 * sticker-send-as-emoji —— 让机器人发的表情以「表情」形式出现，而不是一张大图。
 *
 * ── 问题 ──────────────────────────────────────────────────────────────
 * QQ 消息里的图片分两种，靠消息段 data.sub_type 区分：
 *   sub_type = 0 → 普通图片（客户端按原图尺寸渲染；表情库里 1080×1080 的图
 *                  就撑成一张大图）
 *   sub_type = 1 → 表情（客户端按表情渲染，小而紧凑，可长按收藏）
 *
 * 本项目的 sendSticker（src/onebot.js:357）只 push 了 { type:'image', data:{ file } }，
 * **从未带过 sub_type**，协议端于是按 0 处理 —— 这就是「机器人发表情=发大图」的根因。
 *
 * ── 实测依据（不是推测）──────────────────────────────────────────────
 * 用机器人收到过的真实消息向协议端 get_msg 回读对照：
 *   [图片]      → sub_type=0
 *   [动画表情]  → sub_type=1
 *   [可以可以]  → sub_type=1
 *   [生气]      → sub_type=0 + emoji_id/emoji_package_id/key（商城表情，另一条路）
 * 再实测发送同一张图：不带字段 → 回读 sub_type=0；带 sub_type=1 → 回读 sub_type=1。
 * 结论：协议端接受并保留该字段，发出口就是它。
 *
 * ── 为什么打在原型上（而不是改核心文件）──────────────────────────────
 *   ① src/ 的改动要重启应用才生效，插件热重载立即生效；
 *   ② 应用升级会替换 resources/app，核心里的改动会被静默冲掉（表现为"用了
 *      一阵子又变大图了"）；插件目录不在安装清单里，升级不丢。
 * 全项目"发表情"只有一个出口：send_sticker 工具 → sender.sendSticker →
 * OneBotClient.sendSticker → sendSegments。连 sender 内部的多次失败重试也都
 * 走 sendSticker，所以卡在这里一处生效、全覆盖。
 *
 * ── 安全性 ────────────────────────────────────────────────────────────
 * 不联网、不写文件、不碰连接。只在一个图片段的 data 上加一个数字；
 * 加之前检查"是图片段"且"还没有该字段"（已有则不覆盖）。任何异常都放行 ——
 * 宁可这次发成图片，也绝不让机器人发不出表情。
 */
import { OneBotClient } from '../../src/onebot.js';

const PATCHED = Symbol.for('qq-agent.sticker-send-as-emoji.patched');
const IN_STICKER = Symbol.for('qq-agent.sticker-send-as-emoji.inSticker');

let cfg = () => ({});
let log = () => {};
let warn = () => {};
let origSendSticker = null;
let origSendSegments = null;

const DEFAULTS = { enabled: true, subType: 1, debug: false };

function settings() {
  const s = (typeof cfg === 'function' ? cfg() : null) || {};
  const n = Number(s.subType);
  return {
    enabled: s.enabled !== false,
    subType: Number.isFinite(n) ? n : DEFAULTS.subType,
    debug: s.debug === true
  };
}

function dbg(...a) {
  if (!settings().debug) return;
  try { log('[sticker-send-as-emoji]', ...a); } catch { /* ignore */ }
}

/** 给"正在发表情"的那一批分段补上 sub_type。只改图片段，不改 reply/at。 */
function markStickerSegments(segments, subType) {
  let changed = 0;
  for (const seg of segments) {
    if (!seg || typeof seg !== 'object') continue;
    if (seg.type !== 'image') continue;
    const data = seg.data;
    if (!data || typeof data !== 'object') continue;
    // 已经有值就不覆盖：留给调用方显式指定的机会
    if (data.sub_type !== undefined && data.sub_type !== null) continue;
    data.sub_type = subType;
    changed++;
  }
  return changed;
}

function install() {
  const proto = OneBotClient?.prototype;
  if (!proto) { warn('拿不到 OneBotClient 原型，表情标记未挂载（应用版本可能变了）'); return false; }
  if (proto[PATCHED]) return true;                       // 幂等：已打过就不重复包

  const sendSticker = proto.sendSticker;
  const sendSegments = proto.sendSegments;
  if (typeof sendSticker !== 'function' || typeof sendSegments !== 'function') {
    warn('OneBotClient 上找不到 sendSticker/sendSegments，表情标记未挂载');
    return false;
  }
  origSendSticker = sendSticker;
  origSendSegments = sendSegments;

  // 发送前的最后一站：这里能看到最终分段，且与 sendSticker 在同一同步调用栈里
  // （sendSticker 体内没有 await 就调用 sendSegments），所以用实例标记区分
  // "这是发表情"不会串到并发的发图/发文字上。
  proto.sendSegments = function (kind, id, segments) {
    try {
      const s = settings();
      if (s.enabled && this?.[IN_STICKER] && Array.isArray(segments)) {
        const n = markStickerSegments(segments, s.subType);
        if (n) dbg(`已标记 ${n} 个图片段为表情（sub_type=${s.subType}）`, JSON.stringify(segments));
      }
    } catch (error) {
      // 任何意外都不阻断发送
      try { warn('补 sub_type 失败（本次按普通图片发送）：%s', error?.message ?? error); } catch { /* ignore */ }
    }
    return origSendSegments.call(this, kind, id, segments);
  };

  proto.sendSticker = function (kind, id, imageUrl, options) {
    this[IN_STICKER] = true;
    try {
      return origSendSticker.call(this, kind, id, imageUrl, options);
    } finally {
      this[IN_STICKER] = false;
    }
  };

  proto[PATCHED] = true;
  return true;
}

function uninstall() {
  const proto = OneBotClient?.prototype;
  if (!proto || !proto[PATCHED]) return;
  if (typeof origSendSticker === 'function') proto.sendSticker = origSendSticker;
  if (typeof origSendSegments === 'function') proto.sendSegments = origSendSegments;
  delete proto[PATCHED];
  origSendSticker = null;
  origSendSegments = null;
}

export function setup(api) {
  if (typeof api?.config === 'function') cfg = api.config;
  if (typeof api?.log === 'function') log = api.log;
  if (typeof api?.warn === 'function') warn = api.warn;
  const ok = install();
  const s = settings();
  if (ok) {
    log(s.enabled
      ? `表情将按「表情」发送（sub_type=${s.subType}），不会再发成撑满气泡的大图`
      : '当前已关闭：表情仍按普通图片发送（大图）');
  }
}

export function deactivate() { uninstall(); }
export function dispose() { uninstall(); }
export function available() { return { ok: true }; }

/**
 * 状态能力（只读）。
 * 兼作消 lintKindPlacement 的误报：本插件靠包装原型方法工作，既没有 hooks 也不注册
 * 工具，只统计 providers/hooks 的检查会误判成「没有任何代码会去调用它」。
 */
export const providers = {
  'sticker-send-as-emoji.status': () => {
    const s = settings();
    const proto = OneBotClient?.prototype;
    return {
      enabled: s.enabled,
      subType: s.subType,
      patchInstalled: !!(proto && proto[PATCHED]),
      // 方便一眼看出补丁是否还在（升级/重载后如果变 false，就是没挂上）
      sendStickerPatched: !!(proto && typeof proto.sendSticker === 'function' && proto[PATCHED])
    };
  }
};
