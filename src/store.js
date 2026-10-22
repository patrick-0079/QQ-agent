// 每个会话（group:xxx / private:xxx）一个不断增长的存档。
// 这是新架构的核心数据结构：模型不携带对话历史，每次运行都从这里拼接"已读信息"。
//
// 物理格式（2026-10 起）：快照 JSON + 追加式 JSONL，见 storage/chatlog.js。
//   messages/<chat>.json    快照（旧版本文件可直接当快照读）
//   messages/<chat>.jsonl   快照之后的增量事件，只追加
// 日常收消息只写一行 delta；delta 超阈值时才折叠成快照，避免"一条消息重写整个文件"。
//
// 条目格式：
// {
//   id:        本地递增序号（自 1 起，同群唯一，用于 UI 定位）
//   mid:       QQ 消息 id（可为负数；自己主动发送的本地记录可能没有）
//   ts:        时间戳毫秒
//   senderId:  QQ 号（自己发送的为 selfId）
//   senderName:群名片/昵称（自己发送的为 botName）
//   text:      解析后的纯文本（[图片] 等占位符已内联）
//   self:      是否是机器人自己发的
//   read:      已读状态（运行开始时批量置 true）
//   reply:     可选 { sender, text }：该消息引用/回复的对象摘要
//   media:     可选 [{ kind, url, file, faceId, summary }] 原始媒体定位信息
// }
import fs from 'node:fs';
import {
  appendChatEvent, compactChat, loadChatState, messagesDir
} from './storage/chatlog.js';

export class ChatStore {
  constructor(maxPerChat = 0) {
    this.maxPerChat = Math.max(0, Number(maxPerChat) || 0);
    this.chats = new Map();        // chatKey -> state
    this.delta = new Map();        // chatKey -> { count, bytes }（本进程追加量）
    this.compacting = new Set();   // 正在异步压缩的 chatKey
  }

  setMaxPerChat(cap) {
    this.maxPerChat = Math.max(0, Number(cap) || 0);
  }

  #state(chatKey) {
    if (!this.chats.has(chatKey)) {
      const loaded = loadChatState(chatKey);
      this.chats.set(chatKey, loaded.state);
      this.delta.set(chatKey, { count: loaded.deltaCount, bytes: loaded.deltaBytes });
    }
    return this.chats.get(chatKey);
  }

  /** 追加一条事件到 JSONL，并维护压缩阈值。 */
  #append(chatKey, event) {
    const st = this.#state(chatKey);
    const full = appendChatEvent(chatKey, st, event);
    const stats = this.delta.get(chatKey) || { count: 0, bytes: 0 };
    stats.count += 1;
    stats.bytes += JSON.stringify(full).length + 1;
    this.delta.set(chatKey, stats);
    if (stats.count >= 2000 || stats.bytes >= 2 * 1024 * 1024) this.#scheduleCompact(chatKey);
    return full;
  }

  #scheduleCompact(chatKey) {
    if (this.compacting.has(chatKey)) return;
    this.compacting.add(chatKey);
    setImmediate(() => {
      try {
        const st = this.chats.get(chatKey);
        if (st) {
          compactChat(chatKey, st);
          this.delta.set(chatKey, { count: 0, bytes: 0 });
        }
      } catch { /* 压缩失败保留 delta，下次再试 */ } finally {
        this.compacting.delete(chatKey);
      }
    });
  }

  #compactNow(chatKey) {
    try {
      const st = this.chats.get(chatKey);
      if (!st) return;
      compactChat(chatKey, st);
      this.delta.set(chatKey, { count: 0, bytes: 0 });
    } catch { /* ignore */ }
  }

  listChats() {
    // 从磁盘文件名还原（group_123.json / group_123.jsonl -> group:123）。
    // 与旧实现不同：这里不再把所有会话都读进内存，只列 key，元信息按需加载。
    const out = new Set();
    try {
      for (const f of fs.readdirSync(messagesDir())) {
        const m = /^(group|private)_(\d+)\.(json|jsonl)$/.exec(f);
        if (m) out.add(`${m[1]}:${m[2]}`);
      }
    } catch { /* 目录不存在 */ }
    return [...out];
  }

  getChatMeta(chatKey) {
    const st = this.#state(chatKey);
    // 未读只计他人消息（与 unreadCount / peekUnread 口径一致）——
    // 曾经用 !m.read 把 self 也算进去，机器人自己的发言会把角标顶大。
    const unread = st.messages.filter((m) => !m.read && !m.self).length;
    const last = st.messages[st.messages.length - 1] || null;
    return { chatKey, total: st.messages.length, unread, lastTs: last?.ts ?? 0, lastText: last?.text ?? '' };
  }

  /** 追加一条收到的消息（未读）。返回写入的条目。 */
  appendIncoming(chatKey, { mid, ts, senderId, senderName, text, reply = null, media = [], isPoke = false, atMe = null, atNames = [] }) {
    const st = this.#state(chatKey);
    const id = st.nextLocalId;
    const entry = {
      id,
      mid: mid ?? null,
      ts: ts || Date.now(),
      senderId: String(senderId ?? ''),
      senderName: String(senderName ?? ''),
      text: String(text ?? ''),
      self: false,
      read: false,
      reply: reply || null,
      media: Array.isArray(media) ? media : [],
      // 拍一拍事件：可作触发批（resolveContextTier 按 1 档响应），但不进【已读信息】
      isPoke: Boolean(isPoke),
      // @ 判定标记（2026-09-26）：atMe 以 @ 段的 QQ 号为准 —— 文本包含匹配
      // 分不清"同名不同人"（群友 @ 的人与机器人重名时被误判为 @机器人）。
      // null = 老存档未标，判定层回落文本匹配。
      atMe: atMe === null || atMe === undefined ? null : Boolean(atMe),
      // 渲染进 text 的 @片段原文（含 @ 前缀）：关键词判定据此剔除，
      // 防"@ 别人的名字里带关键词"误触发。空数组 = 该消息没有 @ 段。
      atNames: (Array.isArray(atNames) ? atNames : []).map((n) => String(n ?? '')).filter(Boolean).slice(0, 20)
    };
    this.#append(chatKey, { t: 'm', n: id + 1, m: entry });
    this.#trim(st);
    return entry;
  }

  /** 记录机器人自己发出的消息（已读）。 */
  appendSelf(chatKey, { text, ts, mid = null }) {
    const st = this.#state(chatKey);
    const id = st.nextLocalId;
    const entry = {
      id,
      mid: mid ?? null,
      ts: ts || Date.now(),
      senderId: 'self',
      senderName: '我',
      text: String(text ?? ''),
      self: true,
      read: true,
      reply: null,
      media: []
    };
    this.#append(chatKey, { t: 'm', n: id + 1, m: entry });
    this.#trim(st);
    return entry;
  }

  /** 快照当前未读并全部置为已读（运行开始时调用）。 */
  drainUnread(chatKey) {
    const st = this.#state(chatKey);
    const unread = st.messages.filter((m) => !m.read && !m.self);
    let changed = false;
    for (const m of st.messages) {
      if (!m.read) { m.read = true; changed = true; }
    }
    if (changed) this.#append(chatKey, { t: 'read', all: true });
    return unread;
  }

  /**
   * 只 drain「从某条消息起**之后**」的未读：取走触发批，之前的旧积压单独标已读。
   *
   * 为什么需要它（2026-09-25 触发链路重做的补丁）：磁盘上可能遗留旧进程/
   * 暂停期间攒下的积压未读。它们从未经过 onIncoming 的逐条判定，如果一次
   * 触发的 drain 把它们全部吃进触发批，模型会看到一大坨"未读信息"——用户
   * 看到的就是"积压消息被整批塞进唤醒"。正确语义：
   *   · 触发消息 X 之后的未读 = 本批的聚批对象（X 也在内）；
   *   · X 之前的旧未读 = 触发前就该已读的历史 → 标已读沉入【已读信息】。
   *
   * @param {string} chatKey
   * @param {number} fromTs 批的起点（触发消息的 ts，含）；早于它的未读标已读
   * @returns {{ batch: object[], archived: number }} batch = 触发批，archived = 被归档的旧未读条数
   */
  drainUnreadFrom(chatKey, fromTs) {
    const st = this.#state(chatKey);
    const unread = st.messages.filter((m) => !m.read && !m.self);
    const batch = [];
    let archived = 0;
    for (const m of unread) {
      if (m.ts >= fromTs) batch.push(m);
      else { m.read = true; archived++; }   // 触发点之前的旧积压：沉入历史
    }
    for (const m of st.messages) m.read = true;   // batch 里的也置已读（作为触发批取走）
    if (unread.length) this.#append(chatKey, { t: 'read', all: true });
    return { batch, archived };
  }

  /**
   * 把当前所有未读标记为已读，**但不取走它们**。
   *
   * 这是"档位控制是否响应"的关键：机器人判断"这次不回应"时调用它，
   * 消息就沉入历史（已读），不会产生会话、不消耗 token；
   * 但内容仍留在存档里，日后被艾特时还能作为"已读上下文"带进提示词。
   * 与 drainUnread 的区别：drainUnread 取走并作为触发批，这个只标记。
   *
   * @returns {number} 被标记为已读的条数
   */
  markAllRead(chatKey) {
    const st = this.#state(chatKey);
    let n = 0;
    for (const m of st.messages) {
      if (!m.read && !m.self) { m.read = true; n++; }
    }
    if (n) this.#append(chatKey, { t: 'read', all: true });
    return n;
  }

  /**
   * 把**单条**消息标记为已读（不取走）。
   *
   * 逐条触发判定（onIncoming）用：该条不触发会话时当场标已读、沉入历史，
   * 不动其它未读 —— 那些是"倒计时窗口内追加的"或"上一批遗留的"，
   * 各有自己的归宿（前者等 drain，后者等兜底或下一次触发）。
   *
   * @param {string} chatKey
   * @param {number} id 消息条目的本地 id（appendIncoming 返回的 entry.id）
   * @returns {boolean} 是否真的标记了（false = 没找到/本来就是已读）
   */
  markEntryRead(chatKey, id) {
    const st = this.#state(chatKey);
    const m = st.messages.find((x) => x.id === Number(id));
    if (!m || m.read || m.self) return false;
    this.#append(chatKey, { t: 'read', ids: [m.id] });
    return true;
  }

  /**
   * 把时间窗内的**已读**消息重新标记为未读（手动重试失败会话用）。
   *
   * 触发批当初被 drainUnread 置了已读；重试时按会话起止时间把它们翻回未读，
   * 唤醒流程就能重新取走它们。窗口向前放宽 5 分钟（容纳防抖聚批期），
   * 向后到会话结束 —— 窗口外的不动，避免误翻后来真正已读的历史。
   * @returns {number} 恢复为未读的条数
   */
  markUnreadInWindow(chatKey, startedAt, endedAt) {
    const st = this.#state(chatKey);
    const winStart = Number(startedAt) - 5 * 60 * 1000;
    const winEnd = Number(endedAt || startedAt) + 1000;
    const ids = [];
    for (const m of st.messages) {
      if (m.self) continue;
      if (m.read && m.ts >= winStart && m.ts <= winEnd) { m.read = false; ids.push(m.id); }
    }
    if (ids.length) this.#append(chatKey, { t: 'unread', ids });
    return ids.length;
  }

  unreadCount(chatKey) {
    const st = this.#state(chatKey);
    return st.messages.filter((m) => !m.read && !m.self).length;
  }

  /** 查看当前未读消息（不置已读），用于“等待中”会话的触发摘要。 */
  peekUnread(chatKey, limit = 3) {
    const st = this.#state(chatKey);
    return st.messages.filter((m) => !m.read && !m.self).slice(0, Math.max(1, Number(limit) || 3));
  }

  recent(chatKey, { limit = 80, offset = 0, includeSelf = true } = {}) {
    const st = this.#state(chatKey);
    const all = includeSelf ? st.messages : st.messages.filter((m) => !m.self);
    // offset = 跳过最近 N 条（用于工具翻页）。只读，绝不能修改 st.messages！
    const start = Math.max(0, all.length - Math.max(0, Number(offset) || 0));
    return all.slice(0, start).slice(-Math.max(1, Number(limit) || 1));
  }

  findByMid(chatKey, mid) {
    const st = this.#state(chatKey);
    const target = String(mid);
    return st.messages.find((m) => String(m.mid) === target) || null;
  }

  /**
   * 标记一条消息已被用户撤回（按 QQ 消息 id）。
   * 撤回的消息后续不再发给大模型（buildPastState 会过滤 recalled）。
   * @returns {boolean} 是否找到并标记了
   */
  markRecalled(chatKey, mid) {
    const st = this.#state(chatKey);
    const target = String(mid);
    const m = st.messages.find((x) => String(x.mid) === target);
    if (!m) return false;
    this.#append(chatKey, { t: 'recall', mid: m.mid });
    return true;
  }

  /**
   * 按 QQ 消息 id 更新一条已存档消息（文本/补媒体），并落盘。
   * 用途：read_forward 工具把"合并转发占位符"永久升级成展开后的文本
   * —— 一次展开，以后谁（模型/存档页/金句）都直接读到内容。
   */
  updateByMid(chatKey, mid, { text, appendMedia = [] } = {}) {
    const st = this.#state(chatKey);
    const target = String(mid);
    const m = st.messages.find((x) => String(x.mid) === target);
    if (!m) return false;
    const nextText = text != null ? String(text) : m.text;
    let nextMedia = Array.isArray(m.media) ? m.media : [];
    if (appendMedia.length) {
      nextMedia = [...nextMedia];
      // 转发节点里的图片经常只有协议端 file 缓存号、没有直链；不能只按 url 去重，
      // 否则 file 型图片会被整批丢弃（表现为 read_forward 说 images=N 但看不了图）。
      const mediaKey = (x) => String(x?.url || x?.file || '').trim();
      const seen = new Set(nextMedia.map(mediaKey).filter(Boolean));
      for (const x of appendMedia) {
        const key = mediaKey(x);
        if (key && !seen.has(key)) { nextMedia.push(x); seen.add(key); }
      }
    }
    this.#append(chatKey, { t: 'edit', id: m.id, text: nextText, media: nextMedia });
    return true;
  }

  findByLocalId(chatKey, localId) {
    const st = this.#state(chatKey);
    return st.messages.find((m) => m.id === Number(localId)) || null;
  }

  /**
   * 删除指定本地 id 的消息（部分清除）。返回删掉的条数。
   * @param {string} chatKey
   * @param {number[]} localIds 本地递增 id 数组
   */
  removeByLocalIds(chatKey, localIds = []) {
    const st = this.#state(chatKey);
    const ids = new Set((Array.isArray(localIds) ? localIds : [localIds]).map(Number));
    if (!ids.size) return 0;
    const before = st.messages.length;
    const existing = st.messages.filter((m) => ids.has(m.id)).map((m) => m.id);
    if (!existing.length) return 0;
    this.#append(chatKey, { t: 'del', ids: existing });
    return before - st.messages.length;
  }

  /**
   * 清空某会话的全部消息（整体清除）。返回删掉的条数。
   * 会话文件保留（空 messages），下次来消息继续往里写。
   */
  clearChat(chatKey) {
    const st = this.#state(chatKey);
    const removed = st.messages.length;
    if (removed) {
      this.#append(chatKey, { t: 'clear' });
      this.#compactNow(chatKey);
    }
    return removed;
  }

  /**
   * 仅屏蔽（不删除）：把某会话的全部未读标记为已读。
   * 与 markAllRead 相同语义，这里显式命名供"仅屏蔽、不再发送"场景调用。
   * 返回标记的条数。
   */
  muteUnread(chatKey) {
    return this.markAllRead(chatKey);
  }

  /** 最近 senderId 出现过的活跃成员（带最后发言时间）。 */
  activeMembers(chatKey, limit = 10) {
    const st = this.#state(chatKey);
    const map = new Map();
    for (const m of st.messages) {
      if (m.self) continue;
      const prev = map.get(m.senderId);
      if (!prev || prev.lastTs < m.ts) {
        map.set(m.senderId, { userId: m.senderId, name: m.senderName, lastTs: m.ts, count: (prev?.count || 0) + 1 });
      } else {
        prev.count += 1;
      }
    }
    return [...map.values()].sort((a, b) => b.lastTs - a.lastTs).slice(0, Math.max(1, limit));
  }

  #trim(st) {
    if (this.maxPerChat > 0 && st.messages.length > this.maxPerChat) {
      const minId = st.messages[st.messages.length - this.maxPerChat].id;
      this.#append(st.chatKey, { t: 'trim', minId });
    }
  }
}
