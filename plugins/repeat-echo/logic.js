// 群聊复读机·纯逻辑（不 import 任何核心模块，可被自测直接驱动）
//
// 判定口径：**紧邻的两条**（同群上一条消息 → 这一条）满足
//    ① 文字指纹完全相同；② 发送者不是同一个人；③ 间隔在跟话窗口内
// 就算"两个人在复读"，薄荷可以跟一句。
// 只认紧邻是刻意的：跨着别的消息对上同一句话不是复读，是巧合。
//
// 防刷屏四道闸（都记账在中签那一刻，宁可少发也不刷屏）：
//   同群冷却 / 每群配额 / 全局小时配额 / 同一句封禁窗口。

const HOUR_MS = 3600000;
const MAX_TRACKED_CHATS = 500;
const MAX_TEXT_KEYS = 800;

function num(value, dflt, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/**
 * 文字指纹：只用来判"是不是同一句"，复读时发的是原文。
 *
 * 返回空串 = 这一条不参与复读判定：
 *   · 空内容 / 全是空白；
 *   · 文本里还有原始 CQ 串（协议端没给结构化段时 core 会回落 raw_message）——
 *     原样复读会把 [CQ:...] 当字面文字发出去，或者发出畸形段。
 */
export function fingerprintOf(entry) {
  const raw = String(entry?.text ?? '');
  if (!raw) return '';
  if (/\[CQ:/i.test(raw)) return '';
  return raw.replace(/\s+/g, ' ').trim();
}

export class RepeatEcho {
  constructor({ now = () => Date.now(), settings = () => ({}) } = {}) {
    this.now = now;
    this.settings = settings;
    this.prev = new Map();        // chatKey -> { fp, senderId, ts, entryId }
    this.repeats = [];            // 全局复读时刻（近一小时）
    this.chatRepeats = new Map(); // chatKey -> [ts]
    this.textSeen = new Map();    // `${chatKey}|${fp}` -> 上次复读时刻
    this.history = [];            // 最近复读了什么（排障用，最多 20 条）
    this.observed = 0;            // 观察过的群消息条数（证明钩子活着）
  }

  /** 合并默认值的有效参数（单位已换算成毫秒）。 */
  opts() {
    const s = this.settings() || {};
    return {
      enabled: s.enabled !== false,
      pairWindowMs: num(s.pairWindowSec, 180, 5, 3600) * 1000,
      maxLen: num(s.maxLen, 0, 0, 400),   // 0 = 不限制（长句也复读）
      cooldownMs: num(s.cooldownSec, 90, 0, 3600) * 1000,
      windowMs: num(s.windowMin, 30, 1, 1440) * 60000,
      maxPerWindow: num(s.maxPerWindow, 4, 1, 50),
      maxPerHour: num(s.maxPerHour, 15, 1, 200),
      sameTextMs: num(s.sameTextBlockMin, 30, 1, 1440) * 60000,
      onlyWhenIdle: s.onlyWhenIdle !== false
    };
  }

  /**
   * 观察一条入站消息：更新"上一条"，并回答"这条能不能复读"。
   * **只判定、不记账**（记账在 reserve 里），所以调用方因为"薄荷正在回话"放弃发送时，
   * 这一枪不会白占配额。
   *
   * @returns {{chatKey:string, text:string, fp:string, senderId:string}|null}
   */
  judge(chatKey, entry) {
    const o = this.opts();
    if (!o.enabled) return null;
    const key = String(chatKey ?? '');
    if (!key.startsWith('group:')) return null;
    if (!entry || entry.self) return null;
    const senderId = String(entry.senderId ?? '');
    if (!senderId) return null;

    const now = this.now();
    const fp = fingerprintOf(entry);
    const text = String(entry.text ?? '').trim();
    const entryId = `${key}#${entry.id ?? entry.mid ?? ''}`;
    const prev = this.prev.get(key) || null;
    this.observed += 1;

    const usable = Boolean(fp)
      && (o.maxLen <= 0 || fp.length <= o.maxLen)
      && !(Array.isArray(entry.media) && entry.media.length)
      && entry.atMe !== true
      && entry.isPoke !== true;

    let hit = null;
    if (usable && prev && prev.entryId !== entryId
        && prev.fp === fp && prev.senderId !== senderId
        && now - prev.ts <= o.pairWindowMs) {
      hit = { chatKey: key, text, fp, senderId };
    }

    // 「上一条」无条件推进（同一条重复投递时不动），否则跨着别的消息也会对上同一句。
    if (!(prev && prev.entryId === entryId)) {
      this.prev.delete(key);
      this.prev.set(key, { fp, senderId, ts: now, entryId });
      while (this.prev.size > MAX_TRACKED_CHATS) {
        this.prev.delete(this.prev.keys().next().value);
      }
    }
    return hit;
  }

  /** 四道限流闸；通过则当场记账并返回 true。 */
  reserve(chatKey, hit) {
    const key = String(chatKey ?? hit?.chatKey ?? '');
    const fp = String(hit?.fp ?? '');
    if (!key || !fp) return false;
    const now = this.now();
    const o = this.opts();

    this.repeats = this.repeats.filter((t) => now - t < HOUR_MS);
    if (this.repeats.length >= o.maxPerHour) return false;

    const chat = (this.chatRepeats.get(key) || []).filter((t) => now - t < o.windowMs);
    this.chatRepeats.set(key, chat);
    if (chat.length >= o.maxPerWindow) return false;
    if (chat.length && now - chat[chat.length - 1] < o.cooldownMs) return false;

    const bk = `${key}|${fp}`;
    const lastText = this.textSeen.get(bk) || 0;
    if (lastText && now - lastText < o.sameTextMs) return false;

    this.repeats.push(now);
    chat.push(now);
    this.textSeen.set(bk, now);
    this.history.push({ at: now, chatKey: key, text: String(hit?.text ?? '').slice(0, 60) });
    if (this.history.length > 20) this.history.splice(0, this.history.length - 20);
    this.#pruneText(now, o);
    return true;
  }

  stats() {
    const now = this.now();
    return {
      observed: this.observed,
      chats: this.prev.size,
      repeatsLastHour: this.repeats.filter((t) => now - t < HOUR_MS).length,
      recent: this.history.slice(-5),
      opts: this.opts()
    };
  }

  clear() {
    this.prev.clear();
    this.repeats = [];
    this.chatRepeats.clear();
    this.textSeen.clear();
    this.history = [];
    this.observed = 0;
  }

  #pruneText(now, o) {
    if (this.textSeen.size <= MAX_TEXT_KEYS) return;
    for (const [k, t] of this.textSeen) {
      if (now - t > o.sameTextMs) this.textSeen.delete(k);
    }
  }
}
