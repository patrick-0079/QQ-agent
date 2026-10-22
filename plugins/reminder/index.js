/**
 * reminder —— 定时提醒
 *
 * 「提醒我半小时后拿快递」→ 模型调 set_reminder 工具 → 存 data/reminders.json
 * → 定时器扫描到点 → 通过 OneBot HTTP API 在原会话播报（群里 @设置人）。
 *
 * 时间解析交给模型（它知道现在几点），工具只收绝对时间 when 或相对分钟
 * minutes，所以「明早」「周五晚上」这类说法都能用，插件自己不用写日期解析。
 *
 * 任务持久化：重启机器人不丢；已完成的留 keepAfterDoneDays 天再清理。
 * 播报与取消都是幂等操作：播报前先标记，发送失败会重试下轮（最多 5 次）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { getConfig, DATA_DIR } from '../../src/config.js';
import { escapeCqText } from '../../src/util.js';

// 版本号从 plugin.json 读，不再手写 —— 手写的下场就是版本升了启动日志还印旧号
// （本文件原先就印着 v1.0.1，实际已是 v1.1.x）。读不到退化成 v?，不影响启动。
const BUILD_TAG = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'plugin.json'), 'utf8'));
    return `v${j.version}`;
  } catch { return 'v?'; }
})();
const STORE = path.join(DATA_DIR, 'reminders.json');
const MAX_RETRY = 5;

let api = null;
let fetchRef = null;
let timer = null;

const st = () => api?.config?.() || {};
const enabled = () => st().enabled !== false;

/* ── 持久化（原子写：先 tmp 再 rename，避免写一半被读到） ────── */
export function readStore() {
  try {
    const j = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    if (Array.isArray(j.items) && Number.isFinite(j.nextId)) return j;
  } catch { /* 首次运行或文件坏了，从零开始 */ }
  return { nextId: 1, items: [] };
}

export function writeStore(store) {
  try {
    fs.mkdirSync(path.dirname(STORE), { recursive: true });
    const tmp = STORE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 1));
    fs.renameSync(tmp, STORE);
  } catch (e) { api?.log?.(`写提醒文件失败：${e.message}`); }
}

/** 清理：已完成的超期删除；未完成的超过 90 天视为遗弃删除。 */
function pruneStore(store) {
  const keepDays = Math.max(0, Number(st().keepAfterDoneDays ?? 1));
  const now = Date.now();
  const before = store.items.length;
  store.items = store.items.filter((it) => {
    if (it.doneAt) return now - it.doneAt < keepDays * 86400000;
    return now - it.createdAt < 90 * 86400000;
  });
  return store.items.length !== before;
}

/* ── 时间解析：when（本地 ISO）或 minutes（相对） ─────────────── */
export function resolveWhen({ when, minutes }) {
  const now = Date.now();
  if (Number.isFinite(Number(minutes)) && Number(minutes) > 0) {
    return now + Number(minutes) * 60000;
  }
  const t = Date.parse(String(when ?? ''));
  if (Number.isFinite(t)) return t;
  return null;
}

const fmtTime = (ts) => {
  const d = new Date(ts);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const day = `${d.getMonth() + 1}/${d.getDate()}`;
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now.getTime() + 86400000).toDateString() === d.toDateString();
  return sameDay ? `今天 ${hm}` : tomorrow ? `明天 ${hm}` : `${day} ${hm}`;
};

/* ── OneBot HTTP 发送 ───────────────────────────────────────── */
async function onebotSend(chatKey, segments) {
  const m = /^(private|group):(\d+)$/.exec(String(chatKey || ''));
  if (!m) throw new Error(`会话键不合法：${chatKey}`);
  const cfg = getConfig()?.snowluma || {};
  const base = String(cfg.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const token = String(cfg.httpAccessToken || cfg.accessToken || '');
  const res = await fetchRef(`${base}/${m[1] === 'private' ? 'send_private_msg' : 'send_group_msg'}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(m[1] === 'private'
      ? { user_id: Number(m[2]), message: segments }
      : { group_id: Number(m[2]), message: segments }),
    signal: AbortSignal.timeout(90000)
  });
  if (!res.ok) throw new Error(`OneBot HTTP ${res.status}`);
}

/** 谁在叫机器人：最后一条非机器人消息的发送者（口径与 ai-status 门禁一致）。 */
function lastCallerId(ctx) {
  try {
    const entries = Array.isArray(ctx?.session?.trigger) ? ctx.session.trigger : [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const msg = entries[i];
      if (msg && !msg.self && msg.senderId) return String(msg.senderId);
    }
  } catch { /* 拿不到就算了 */ }
  return '';
}

/* ── 工具实现 ──────────────────────────────────────────────── */
function toolSetReminder() {
  return {
    id: 'set_reminder',
    name: '设置提醒',
    description:
      '设置一条到点播报的提醒。时间填法二选一：用户说了相对时间（「X分钟后/秒后」）填 minutes（分钟数，可带小数，如 0.5=30秒后、90=一个半小时后）；'
      + '否则把用户说的时间换算成绝对本地时间填 when（ISO 字符串，如 2026-09-21T15:30:00，今天就是今天，明天就是明天）。'
      + '提醒内容浓缩成一句话填 text（尽量保留用户原话里的事由，如用户说「提醒我一分钟后叫我」就填「叫我」，'
      + '不要自己改写成「到点了主人」这类空泛句子）。播报会在用户说话的会话发出，群聊里会 @设置人。',
    parameters: {
      type: 'object',
      properties: {
        when: { type: 'string', description: '提醒时间，本地时区 ISO 字符串（2026-09-21T15:30:00）。与 minutes 二选一。' },
        minutes: { type: 'number', description: '多少分钟后提醒（相对时间用这个）。与 when 二选一。' },
        text: { type: 'string', description: '提醒内容一句话，保留用户原话的事由（如「拿快递」「叫我」「开会」）。' }
      },
      required: ['text']
    },
    async execute(ctx, args) {
      const text = String(args?.text ?? '').trim().slice(0, 200);
      if (!text) return { content: '提醒内容不能为空' };
      const when = resolveWhen(args || {});
      if (when == null) {
        return { content: '时间没算出来：when（绝对时间）和 minutes（相对分钟）至少给一个' };
      }
      const now = Date.now();
      if (when - now < 15 * 1000) {
        return { content: '提醒时间已经过了或太近（至少 15 秒后）。请让用户重新说个时间' };
      }
      if (when - now > 90 * 86400000) {
        return { content: '提醒时间太远（最多 90 天）' };
      }

      const store = readStore();
      const active = store.items.filter((i) => !i.doneAt);
      const maxActive = Math.max(1, Number(st().maxActive) || 50);
      if (active.length >= maxActive) {
        return { content: `待办提醒已满（${maxActive} 条），先取消几条再来` };
      }

      const chatKey = ctx?.chatKey || '';
      if (!chatKey) return { content: '没有会话上下文，不知道到点发哪里' };

      const id = store.nextId++;
      store.items.push({
        id,
        chatKey,
        userId: lastCallerId(ctx),
        when,
        text,
        createdAt: now,
        retry: 0
      });
      writeStore(store);
      api?.log?.(`新提醒 #${id}：${fmtTime(when)} ${text} → ${chatKey}`);
      return {
        content: `已设置：${fmtTime(when)} 提醒「${text}」（id #${id}）`,
        reminderId: id, when
      };
    }
  };
}

function toolListReminders() {
  return {
    id: 'list_reminders',
    name: '查询提醒',
    description: '列出当前会话的待办提醒（id、时间、内容）。群里看到的是本群的，私聊看到的是自己的。',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      const chatKey = ctx?.chatKey || '';
      const now = Date.now();
      const store = readStore();
      const mine = store.items
        .filter((i) => !i.doneAt && i.chatKey === chatKey)
        .sort((a, b) => a.when - b.when)
        .slice(0, 10);
      if (!mine.length) return { content: '当前会话没有待办提醒' };
      const lines = mine.map((i) =>
        `#${i.id}  ${fmtTime(i.when)}  ${i.text}（${i.when > now ? '还有 ' + fmtLeft(i.when - now) : '马上'}）`);
      return { content: lines.join('\n') };
    }
  };
}

const fmtLeft = (ms) => {
  if (ms < 60000) return Math.max(1, Math.round(ms / 1000)) + ' 秒';
  if (ms < 3600000) return Math.round(ms / 60000) + ' 分钟';
  return (ms / 3600000).toFixed(1) + ' 小时';
};

function toolCancelReminder() {
  return {
    id: 'cancel_reminder',
    name: '取消提醒',
    description: '按 id 取消一条待办提醒。用户没给 id 就先调 list_reminders 查。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'number', description: '要取消的提醒 id（从 list_reminders 结果里拿）' } },
      required: ['id']
    },
    async execute(ctx, args) {
      const id = Number(args?.id);
      if (!Number.isFinite(id)) return { content: '缺少提醒 id' };
      const store = readStore();
      const item = store.items.find((i) => i.id === id && !i.doneAt && i.chatKey === (ctx?.chatKey || ''));
      if (!item) return { content: `当前会话没有待办提醒 #${id}（可能已完成、取消过，或不在这个会话）` };
      item.doneAt = Date.now();
      item.cancelled = true;
      writeStore(store);
      api?.log?.(`取消提醒 #${id}（${item.text}）`);
      return { content: `已取消：${fmtTime(item.when)} 的「${item.text}」` };
    }
  };
}

/* ── 到点扫描（定时器驱动） ──────────────────────────────────── */
export async function scanOnce({ dryRun = false } = {}) {
  const now = Date.now();
  const store = readStore();
  const due = store.items.filter((i) => !i.doneAt && i.when <= now);
  if (!due.length) return { fired: 0 };

  const results = [];
  for (const item of due) {
    if (item.retry >= MAX_RETRY) {
      item.doneAt = now;
      item.failed = true;
      results.push({ id: item.id, result: 'give-up' });
      continue;
    }
    if (dryRun) { results.push({ id: item.id, result: 'dry-run' }); continue; }

    // 先标记再发送：发送抛错重试，成功后不再触发
    try {
      const segments = [];
      if (item.chatKey.startsWith('group:') && item.userId) {
        segments.push({ type: 'at', data: { qq: item.userId } });
        segments.push({ type: 'text', data: { text: ' ' } });
      }
      segments.push({ type: 'text', data: { text: escapeCqText(`⏰ 到点提醒：${item.text}`) } });
      await onebotSend(item.chatKey, segments);
      item.doneAt = Date.now();
      results.push({ id: item.id, result: 'sent' });
      api?.log?.(`提醒 #${item.id} 已播报 → ${item.chatKey}`);
    } catch (e) {
      item.retry = (item.retry || 0) + 1;
      results.push({ id: item.id, result: 'retry', error: e.message });
      api?.warn?.(`提醒 #${item.id} 播报失败（第 ${item.retry} 次）：${e.message}`);
    }
  }
  writeStore(store);
  return { fired: results.length, results };
}

/* ── 生命周期 ──────────────────────────────────────────────── */
export function setup(a) {
  api = a;
  fetchRef = a.fetch; // 清单已声明 web_fetch
  a.registerTool(toolSetReminder());
  a.registerTool(toolListReminders());
  a.registerTool(toolCancelReminder());
  const n = readStore().items.filter((i) => !i.doneAt).length;
  a.log(`定时提醒已加载（${BUILD_TAG}，待办 ${n} 条）`);
}

export function activate() {
  if (!enabled() || !fetchRef) return;
  const everySec = Math.max(5, Number(st().scanIntervalSec) || 20);
  timer = setInterval(() => {
    const store = readStore();
    if (pruneStore(store)) writeStore(store);
    scanOnce().catch(() => {});
  }, everySec * 1000);
  timer.unref?.();
  // 启动即补查一次：机器人重启期间到点的提醒会在这里补发（15 秒内算准时，超过就不吵了）
  const boot = setTimeout(() => { scanOnce().catch(() => {}); }, 15 * 1000);
  boot.unref?.();
  api?.log?.(`定时提醒已启用：每 ${everySec} 秒扫描`);
}

export function deactivate() {
  if (timer) { clearInterval(timer); timer = null; }
}

/* ── 状态面板上报 ──────────────────────────────────────────── */
export const providers = {
  'status.reminder': () => {
    if (!enabled()) return null;
    const items = readStore().items.filter((i) => !i.doneAt); // 读缓存文件，毫秒级
    if (!items.length) return null; // 没有任务就不占格子
    const next = items.slice().sort((a, b) => a.when - b.when)[0];
    return {
      icon: '⏰',
      title: '定时提醒',
      priority: 55,
      lines: [
        ['待办', `${items.length} 条`],
        ['最近的', next ? `${fmtTime(next.when)} ${String(next.text).slice(0, 10)}` : '—']
      ]
    };
  }
};

// 给测试用的出口
export const internals = {
  readStore, writeStore, resolveWhen, scanOnce, fmtTime, pruneStore
};
