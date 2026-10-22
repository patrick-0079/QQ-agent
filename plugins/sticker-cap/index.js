// 表情包库上限（sticker-cap）：防"一直发表情包让它收、把库和磁盘撑爆"。
//
// ── 为什么需要它 ──────────────────────────────────────────────────────────
// 使用者原话："设这个的目的是防止有人一直发表情包让它存然后炸掉。"
//
// 核心已有的两道闸门**只防频率、不防总量**：
//   · sticker.maxCollectPerHour = 10    每小时最多收 10 张 ✓
//   · sticker.promptMaxStickers = 10    只把 10 张写进提示词 ✓
//   · **总量上限：没有** ✗
//
// 实测（2026-10-07）：data/sticker-images/ 20 张 / 17.2 MB，
// 单张中位 513 KB、最大 2.81 MB ✗ → 按 10 张/小时能堆约 5 MB/小时、一天 100+ MB ✗
//
// ── 这道闸做什么 ──────────────────────────────────────────────────────────
// 在 `before-tool` 里拦 `collect_sticker`：收之前先量库，
// **张数或总大小任一超上限 → 拒绝这次收录**，并把原因交给模型（它会说"库满了"而不是硬塞）✓
// 已经在库里的**不删不动** ✓ —— 只拦新增 ✓
//
// 量库有 10 秒缓存，避免每次调用都扫目录 ✓
//
// ⚠️ 本文件在 resources/app 里，应用自动更新会覆盖；配置在 data/config.json 不受影响。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';
// ★ 真正持久的做法：表情包的**源头在 QQ 收藏**（sticker-manager 每次 sync 会把 QQ 的列表
//   并回本地 ✗）。所以只删本地是没用的 —— 实测一次同步 6 条全部回来了 ✓
//   这里包一层 StickerManager.prototype.sync：同步完成后按剔除名单过滤，再写回本地 ✓
import { StickerManager } from '../../src/sticker-manager.js';
import { saveStickerStore } from '../../src/stickers.js';
// ⚠️ 必须直接用核心 logger：插件 api 上**没有 log/warn**，
//    用 api?.log 会被可选链静默吞掉 —— 那样"补丁到底挂上没有"就完全看不见 ✗（踩过）
import { logger } from '../../src/logger.js';

const PLUGIN_ID = 'sticker-cap';
const CACHE_MS = 10_000;

let api = null;
let cache = { at: 0, count: 0, bytes: 0 };
const stats = { checked: 0, blocked: 0, lastReason: '', lastAt: 0 };

function settings() { return api?.config?.() || {}; }

/** 表情包图片目录（与核心一致：DATA_DIR/sticker-images）。 */
export function imagesDir() { return path.join(DATA_DIR, 'sticker-images'); }

/** 量一下库里有多少张、占多少字节（带 10 秒缓存）。 */
export function measure(now = Date.now()) {
  // ⚠️ cache.at === 0 表示"还没量过"，必须真量 —— 否则时间戳偏小（测试/时钟回拨）时
  //    `now - 0 < CACHE_MS` 会把初始的空值当成有效缓存，张数永远读成 0 ✗（踩过）
  if (cache.at > 0 && now - cache.at < CACHE_MS) return cache;
  let count = 0;
  let bytes = 0;
  try {
    const dir = imagesDir();
    for (const name of fs.readdirSync(dir)) {
      try {
        const st = fs.statSync(path.join(dir, name));
        if (st.isFile()) { count++; bytes += st.size; }
      } catch { /* 单个文件读不到就跳过 */ }
    }
  } catch { /* 目录不存在 = 空库 */ }
  cache = { at: now > 0 ? now : Date.now(), count, bytes };
  return cache;
}

/**
 * 该不该拒绝这次收录？返回 null = 放行；返回 { reason } = 拦。
 * 任何异常都吞掉并**放行** —— 闸门坏掉不该让功能整体不可用（已有核心的频率闸兜着 ✓）。
 */
export function capVerdict(now = Date.now()) {
  const cfg = settings();
  if (cfg.enabled === false) return null;
  const maxCount = Math.max(1, Number(cfg.maxCount) || 200);
  const maxBytes = Math.max(1, Number(cfg.maxMB) || 200) * 1024 * 1024;
  const { count, bytes } = measure(now);
  const mb = bytes / 1024 / 1024;
  if (count >= maxCount) {
    return { reason: `表情包库已经有 ${count} 张（上限 ${maxCount} 张），这次不收新的了。告诉对方库满了、需要先清理，不要硬塞。`, count, bytes };
  }
  if (bytes >= maxBytes) {
    return { reason: `表情包库已经占 ${mb.toFixed(1)} MB（上限 ${(maxBytes / 1024 / 1024)} MB），这次不收新的了。告诉对方库满了、需要先清理。`, count, bytes };
  }
  return null;
}

export function setup(apiRef) { api = apiRef; }

export function available() { return { ok: true }; }

/** 剔除名单：这些 id 永远不要（逗号/空格分隔）。 */
export function blockedIds() {
  return new Set(String(settings().blockedIds ?? '')
    .split(/[,，、;；\s]+/).map((x) => x.trim()).filter(Boolean));
}

/** 从一份条目数组里剔掉名单内的（导出供自测）。返回 { kept, removed }。 */
export function stripBlocked(entries, blocked = blockedIds()) {
  const list = Array.isArray(entries) ? entries : [];
  if (!blocked.size) return { kept: list, removed: 0 };
  const kept = list.filter((e) => !blocked.has(String(e?.id ?? '')));
  return { kept, removed: list.length - kept.length };
}

const PATCH_KEY = Symbol.for('qq-agent.sticker-cap.patch');
let removedTotal = 0;

/**
 * 包一层 StickerManager.prototype.sync：原同步跑完后，把名单内的条目剔掉并写回本地。
 *
 * 为什么必须包在 sync 上：`mergeStickerLibrary` 是**并集** ——
 * 只要 QQ 收藏里还有，下一次同步就会把它并回本地 ✗（实测 6 条全回来）。
 * 幂等：同一个 prototype 只包一次（热重载只换实现）✓
 */
function install() {
  const proto = StickerManager?.prototype;
  if (!proto || typeof proto.sync !== 'function') {
    logger.warn(PLUGIN_ID, '拿不到 StickerManager.prototype.sync，剔除名单未挂载（应用版本可能变了）');
    return false;
  }
  let rec = proto[PATCH_KEY];
  if (!rec) {
    const original = proto.sync;
    const wrapped = async function sync(...args) {
      const result = await original.apply(this, args);
      try {
        const cur = proto[PATCH_KEY];
        const blocked = cur && typeof cur.blockedIds === 'function' ? cur.blockedIds() : new Set();
        if (blocked.size && Array.isArray(this.entries)) {
          const { kept, removed } = stripBlocked(this.entries, blocked);
          if (removed > 0) {
            this.entries = kept;
            try { saveStickerStore(this.entries); } catch { /* 写回失败也不影响本次返回 */ }
            removedTotal += removed;
            try { api?.log?.(`${PLUGIN_ID} 同步后剔除 ${removed} 条不在名单内的表情包`); } catch { /* ignore */ }
          }
          // 返回值里的 entries 可能还指着旧数组，纠正一下，免得下游又看到被剔掉的
          if (result && typeof result === 'object' && result.entries !== this.entries) result.entries = this.entries;
        }
      } catch (error) {
        try { api?.warn?.(`${PLUGIN_ID} 剔除名单执行失败（本次放行）：${error?.message ?? error}`); } catch { /* ignore */ }
      }
      return result;
    };
    rec = { original, wrapped, blockedIds: null };
    proto[PATCH_KEY] = rec;
    proto.sync = wrapped;
  }
  rec.blockedIds = blockedIds;
  return true;
}

function uninstall() {
  const proto = StickerManager?.prototype;
  const rec = proto?.[PATCH_KEY];
  if (!rec) return;
  rec.blockedIds = null;
  if (proto.sync === rec.wrapped) proto.sync = rec.original;
  delete proto[PATCH_KEY];
}

export function activate() {
  const ok = install();
  if (ok) {
    const n = blockedIds().size;
    logger.info(PLUGIN_ID, `已挂载：容量闸 ${Math.max(1, Number(settings().maxCount) || 200)} 张 / `
      + `${Math.max(1, Number(settings().maxMB) || 200)} MB ｜ 剔除名单 ${n} 条 ｜ 同步后过滤已启用`);
  }
}

export function deactivate() { uninstall(); }
export function dispose() { uninstall(); }

export const hooks = {
  /** 收表情包之前先量库；超上限直接否决这次调用。 */
  'before-tool'(ctx = {}) {
    if (String(ctx.toolName || '') !== 'collect_sticker') return undefined;
    stats.checked++;
    let verdict = null;
    try { verdict = capVerdict(); }
    catch (error) {
      try { api?.warn?.(`${PLUGIN_ID} 量库失败（本次放行）：${error?.message ?? error}`); } catch { /* ignore */ }
      return undefined;
    }
    if (!verdict) return undefined;
    stats.blocked++;
    stats.lastReason = verdict.reason;
    stats.lastAt = Date.now();
    try { api?.log?.(`${PLUGIN_ID} 已拦下收录：${verdict.reason}`); } catch { /* ignore */ }
    return { block: true, reason: verdict.reason };
  },
};

export const providers = {
  [`${PLUGIN_ID}.status`]: () => {
    const { count, bytes } = measure(0);          // 强制量一次（status 是给人看的，不吃缓存）
    return {
      enabled: settings().enabled !== false,
      maxCount: Math.max(1, Number(settings().maxCount) || 200),
      maxMB: Math.max(1, Number(settings().maxMB) || 200),
      count,
      mb: Number((bytes / 1024 / 1024).toFixed(2)),
      dir: imagesDir(),
      checked: stats.checked,
      blocked: stats.blocked,
      lastReason: stats.lastReason,
      lastAt: stats.lastAt ? new Date(stats.lastAt).toLocaleString('zh-CN', { hour12: false }) : '',
      // 剔除名单（与 QQ 同步后过滤用）
      blockedIds: blockedIds().size,
      patched: Boolean(StickerManager?.prototype?.[PATCH_KEY]),
      removedTotal,
    };
  },
};

/** 自测用。 */
export const internals = { imagesDir, measure, capVerdict, stats, setCache: (c) => { cache = c; }, blockedIds, stripBlocked, install, uninstall };
