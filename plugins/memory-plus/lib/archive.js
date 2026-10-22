// 印象档案 · 聊天记录存档层
//
// 干两件事：
//   1. **检索**：按「时间范围 + 发送人 QQ + 关键词」在本地存档里找消息，
//      替代核心 get_recent_messages 那种"一页一页往回翻"的做法。
//   2. **清理**：定时删掉过旧的存档；也支持人工指定时间段删除。
//
// ⚠️ 一个必须守住的纪律（auto-clean 插件用血换来的）：
//   ChatStore 在核心进程里**有内存缓存**，它每次写入都会把自己内存里的
//   整份 messages 落盘。所以"直接从磁盘删消息"对**正在被核心持有的会话**
//   会被下一次写入复活。
//   因此：
//     · 当前会话的删除 → 必须走 before-context 钩子里拿到的活 store（见 index.js）
//     · 其它会话（核心大概率没加载过）→ 才在这里直接改磁盘，并且只删"够旧"的，
//       即使被复活，下一轮扫描还会再删一次（自愈）。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../../src/config.js';

const MESSAGES_DIR = path.join(DATA_DIR, 'messages');
const MP_DIR = path.join(DATA_DIR, 'memory-plus');
const BACKUP_DIR = path.join(MP_DIR, 'archive-backup');

export function messagesDir() { return MESSAGES_DIR; }

export function archiveFile(chatKey) {
  const safe = String(chatKey || '').replace(/[^a-z0-9_]/gi, '_');
  return path.join(MESSAGES_DIR, `${safe}.json`);
}

/** 磁盘上有存档的会话（从文件名还原 chatKey）。 */
export function archivedChats() {
  const out = [];
  try {
    for (const f of fs.readdirSync(MESSAGES_DIR)) {
      const m = /^(group|private)_(\d+)\.json$/.exec(f);
      if (m) out.push({ chatKey: `${m[1]}:${m[2]}`, file: path.join(MESSAGES_DIR, f) });
    }
  } catch { /* 目录不存在 */ }
  return out;
}

function readArchive(chatKey) {
  try {
    let text = fs.readFileSync(archiveFile(chatKey), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.messages)) return parsed;
  } catch { /* 无存档 / 坏了 */ }
  return null;
}

function writeArchive(chatKey, state) {
  const file = archiveFile(chatKey);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

function backupArchive(chatKey, { stamp = '' } = {}) {
  try {
    const src = archiveFile(chatKey);
    if (!fs.existsSync(src)) return '';
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const tag = stamp || new Date().toISOString().replace(/[:.]/g, '-');
    const dst = path.join(BACKUP_DIR, `${path.basename(src, '.json')}.${tag}.json`);
    fs.copyFileSync(src, dst);
    // 只保留最近 8 份备份，别把磁盘吃光
    const mine = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith(path.basename(src, '.json') + '.')).sort();
    for (const old of mine.slice(0, Math.max(0, mine.length - 8))) {
      try { fs.rmSync(path.join(BACKUP_DIR, old), { force: true }); } catch { /* ignore */ }
    }
    return dst;
  } catch (error) {
    console.warn('[memory-plus] 存档备份失败:', error?.message ?? error);
    return '';
  }
}

/** 把 "YYYY-MM-DD" 或 "YYYY-MM-DD HH:mm" 或毫秒数 解析成时间戳。 */
export function parseTime(raw, { endOfDay = false } = {}) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const s = String(raw).trim();
  if (!s) return null;
  if (/^\d{10,}$/.test(s)) return Number(s);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})[T\s](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/.exec(s);
  if (m) {
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0)).getTime();
  }
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0);
    return d.getTime();
  }
  m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0);
    return d.getTime();
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function stampOf(ts) {
  const d = new Date(Number(ts) || 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 本地存档检索。三个条件都可选，全部给定时是 AND。
 * @param {string} chatKey
 * @param {{from?: any, to?: any, sender?: string, keyword?: string, limit?: number,
 *          context?: number, includeSelf?: boolean, excludePoke?: boolean}} opts
 *        context: 每条命中额外带回前后几条（默认 0，最多 5）
 * @returns {{ok: boolean, chatKey: string, scanned: number, matched: number, messages: object[], error?: string}}
 */
export function searchLocalArchive(chatKey, opts = {}) {
  const state = readArchive(chatKey);
  if (!state) return { ok: false, chatKey, scanned: 0, matched: 0, messages: [], error: '这个会话还没有本地存档' };
  const all = state.messages || [];
  const from = parseTime(opts.from, { endOfDay: false });
  const to = parseTime(opts.to, { endOfDay: true });
  const sender = String(opts.sender ?? '').trim();
  const keyword = String(opts.keyword ?? '').trim();
  const includeSelf = opts.includeSelf !== false;
  const ctxN = Math.min(5, Math.max(0, Number(opts.context) || 0));
  const limit = Math.min(200, Math.max(1, Number(opts.limit) || 30));

  const hitIdx = [];
  for (let i = 0; i < all.length; i += 1) {
    const m = all[i];
    if (!m) continue;
    if (m.self && !includeSelf) continue;
    if (m.isPoke && opts.excludePoke !== false) continue;
    if (from !== null && Number(m.ts) < from) continue;
    if (to !== null && Number(m.ts) > to) continue;
    if (sender) {
      const isSelf = String(sender) === 'self' || String(sender) === '我';
      if (isSelf ? !m.self : String(m.senderId) !== sender) continue;
    }
    if (keyword && !String(m.text || '').includes(keyword)) continue;
    hitIdx.push(i);
  }

  const picked = hitIdx.slice(-limit);   // 取最近 limit 条命中
  const messages = picked.map((i) => {
    const m = all[i];
    const item = {
      localId: m.id,
      mid: m.mid,
      ts: m.ts,
      time: stampOf(m.ts),
      senderId: m.self ? 'self' : String(m.senderId || ''),
      senderName: m.self ? '我' : String(m.senderName || ''),
      text: String(m.text || ''),
      self: !!m.self,
      recalled: !!m.recalled
    };
    if (ctxN > 0) {
      item.context = [];
      for (let j = Math.max(0, i - ctxN); j <= Math.min(all.length - 1, i + ctxN); j += 1) {
        if (j === i) continue;
        const c = all[j];
        if (!c) continue;
        item.context.push({ time: stampOf(c.ts), senderName: c.self ? '我' : String(c.senderName || ''), text: String(c.text || '') });
      }
    }
    return item;
  });

  return {
    ok: true,
    chatKey,
    scanned: all.length,
    matched: hitIdx.length,
    returned: messages.length,
    range: {
      from: from === null ? '' : stampOf(from),
      to: to === null ? '' : stampOf(to),
      firstAt: all.length ? stampOf(all[0].ts) : '',
      lastAt: all.length ? stampOf(all[all.length - 1].ts) : ''
    },
    messages
  };
}

/** 磁盘级删除：删掉 [from, to] 时间窗内的消息（用于非活跃会话 / 定时清理）。 */
export function pruneRangeLocal(chatKey, { from = 0, to = Number.MAX_SAFE_INTEGER, backup = true } = {}) {
  const state = readArchive(chatKey);
  if (!state) return { ok: false, removed: 0, error: '这个会话还没有本地存档' };
  const before = (state.messages || []).length;
  const keep = (state.messages || []).filter((m) => Number(m.ts) < from || Number(m.ts) > to);
  const removed = before - keep.length;
  if (!removed) return { ok: true, removed: 0, total: before };
  const backupPath = backup ? backupArchive(chatKey, { stamp: `prune-${Date.now()}` }) : '';
  state.messages = keep;
  writeArchive(chatKey, state);
  return { ok: true, removed, total: keep.length, backupPath };
}

/**
 * 全量扫描：删掉早于 cutoff 的消息。
 * 只处理"核心此刻大概率没加载"的会话；当前会话由 before-context 里的活 store 负责。
 * @returns {{ok:boolean, scanned:number, purged:number, removed:number, details:object[]}}
 */
export function sweepOldMessages({ retainDays = 30, backup = true, maxChats = 200, skipKeys = [] } = {}) {
  const cutoff = Date.now() - Math.max(1, Number(retainDays) || 30) * 86400000;
  const skip = new Set((skipKeys || []).map(String));
  const details = [];
  let purged = 0;
  let removed = 0;
  const chats = archivedChats().slice(0, Math.max(1, Number(maxChats) || 200));
  for (const { chatKey } of chats) {
    if (skip.has(chatKey)) continue;
    try {
      const r = pruneRangeLocal(chatKey, { from: 0, to: cutoff - 1, backup });
      if (r.removed) {
        purged += 1;
        removed += r.removed;
        details.push({ chatKey, removed: r.removed, total: r.total, backupPath: r.backupPath });
      }
    } catch (error) {
      details.push({ chatKey, error: String(error?.message ?? error) });
    }
  }
  return { ok: true, scanned: chats.length, purged, removed, cutoff, details };
}

/**
 * 直接从磁盘取最近 N 条消息（给"没有活的 ctx.store 的场合"用，例如面板点整理）。
 * 只读，不碰内存缓存，所以不会引起任何"复活"问题。
 */
export function readRecentFromDisk(chatKey, limit = 120) {
  const state = readArchive(chatKey);
  if (!state) return [];
  const all = state.messages || [];
  return all.slice(-Math.max(1, Math.min(5000, Number(limit) || 120)));
}

/**
 * 列出一个会话的所有存档备份（删除/回档用）。按时间倒序。
 * 备份是删存档前自动留的，所以"一键回档"就是从这里面挑一份还原。
 */
export function listBackups(chatKey) {
  const base = path.basename(archiveFile(chatKey), '.json');
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith(`${base}.`) && f.endsWith('.json'))
      .map((f) => {
        let bytes = 0;
        let at = 0;
        let count = -1;
        const full = path.join(BACKUP_DIR, f);
        try {
          const st = fs.statSync(full);
          bytes = st.size;
          at = st.mtimeMs;
        } catch { /* ignore */ }
        try {
          const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
          if (Array.isArray(parsed?.messages)) count = parsed.messages.length;
        } catch { /* 坏备份只报大小 */ }
        return { file: f, bytes, at, count };
      })
      .sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

/**
 * 一键回档：用某一份备份覆盖当前存档。
 * ⚠️ 只改磁盘。核心进程对该会话**有内存缓存**时，它下一次写入会覆盖回档结果 ——
 *    所以回档后如果这个会话正在跑，界面会提示重启一次控制台让它重新读盘。
 */
export function restoreBackup(chatKey, file) {
  const base = path.basename(archiveFile(chatKey), '.json');
  const name = path.basename(String(file || ''));
  if (!name || !name.startsWith(`${base}.`) || !name.endsWith('.json')) {
    return { ok: false, error: '备份文件名不属于这个会话' };
  }
  const src = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(src)) return { ok: false, error: '找不到这个备份文件' };
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(src, 'utf8'));
  } catch (error) {
    return { ok: false, error: `备份文件解析失败：${error?.message ?? error}` };
  }
  if (!parsed || !Array.isArray(parsed.messages)) return { ok: false, error: '备份文件结构不对（没有 messages）' };
  // 回档本身也要能撤销：先把当前存档留一份
  const safety = backupArchive(chatKey, { stamp: `before-restore-${Date.now()}` });
  writeArchive(chatKey, {
    chatKey: String(parsed.chatKey || chatKey),
    nextLocalId: Number(parsed.nextLocalId) || (parsed.messages.length + 1),
    messages: parsed.messages
  });
  return { ok: true, restored: parsed.messages.length, safety, from: name };
}

/** 存档概览（面板用）：每个会话的条数、时间范围、体积。 */export function archiveOverview() {
  return archivedChats().map(({ chatKey, file }) => {
    let bytes = 0;
    try { bytes = fs.statSync(file).size; } catch { /* ignore */ }
    const state = readArchive(chatKey);
    const msgs = state?.messages || [];
    return {
      chatKey,
      count: msgs.length,
      bytes,
      firstAt: msgs.length ? stampOf(msgs[0].ts) : '',
      lastAt: msgs.length ? stampOf(msgs[msgs.length - 1].ts) : ''
    };
  }).sort((a, b) => b.count - a.count);
}

export { stampOf };
