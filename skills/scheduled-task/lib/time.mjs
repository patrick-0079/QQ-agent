// 时间解析与「下次什么时候触发」的纯计算。
//
// 全部按**本机时区**解释（不引入任何依赖、不做 UTC 换算）：
// 机器设成 Asia/Hong_Kong 就是香港时间，用户说的"八点"就是墙上的八点。
//
// 为什么单独一个文件：这段是纯函数，可以在没有宿主、没有网络的情况下跑自检
// （见 dev-tests/self-check.mjs）。跨天数、跨周、夏令时全都容易写错，
// 混在 index.js 里就没法单独验。

const MINUTE = 60_000;

/** "HH:MM" → { h, m }；不合法返回 null。 */
export function parseHHMM(raw) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return { h, m: mi };
}

/**
 * "HH:MM" 或 "YYYY-MM-DD HH:MM" → 本机时区的时间戳；不合法返回 null。
 * 只给 "HH:MM" 时按「今天这个点，已经过了就明天」理解。
 */
export function parseAtTime(raw, now = Date.now()) {
  const s = String(raw ?? '').trim();
  if (/^\d{1,2}:\d{2}$/.test(s)) {
    const t = parseHHMM(s);
    if (!t) return null;
    return nextTimeOfDayFrom(t, now);
  }
  const full = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/.exec(s);
  if (!full) return null;
  const d = new Date(Number(full[1]), Number(full[2]) - 1, Number(full[3]), Number(full[4]), Number(full[5]), 0, 0);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/** 从 from 之后（严格大于）的下一个「HH:MM」时刻。 */
export function nextTimeOfDayFrom(timeOfDay, from) {
  const d = new Date(from);
  d.setHours(timeOfDay.h, timeOfDay.m, 0, 0);
  if (d.getTime() <= from) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** 星期几：1=周一 … 7=周日（跟人说话的习惯一致，不用 JS 的 0=周日）。 */
export function isoWeekday(ts) {
  const d = new Date(ts).getDay();
  return d === 0 ? 7 : d;
}

/** 从 from 之后（严格大于）的下一个「weekdays 里的某天 + HH:MM」。 */
export function nextWeeklyFrom(weekdays, timeOfDay, from) {
  const days = [...new Set((weekdays || []).map(Number).filter((n) => n >= 1 && n <= 7))];
  if (!days.length) return null;
  const base = new Date(from);
  // 用 setDate 逐天推进，而不是 from + n*86400000：夏令时那天 24 小时并不成立，
  // 加毫秒会跳过一个日历日。
  for (let i = 0; i <= 7; i++) {
    const d = new Date(base);
    d.setDate(d.getDate() + i);
    if (!days.includes(isoWeekday(d.getTime()))) continue;
    d.setHours(timeOfDay.h, timeOfDay.m, 0, 0);
    if (d.getTime() > from) return d.getTime();
  }
  return null;
}

/** repeat 的规范化：接受英文与中文写法，非法返回 null。 */
export function normalizeRepeat(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === '' || s === 'once' || s === '一次' || s === '一次性') return 'once';
  if (s === 'daily' || s === '每天' || s === '每日') return 'daily';
  if (s === 'weekly' || s === '每周' || s === '每星期') return 'weekly';
  if (s === 'interval' || s === 'periodic' || s === '每隔' || s === '周期' || s === '循环') return 'interval';
  return null;
}

/**
 * 把模型给的参数算成「首次触发时间 + 重复规则」。
 * 返回 { dueAt, repeat, timeOfDay, weekdays, intervalMinutes } 或 { error }。
 * error 文本是给模型看的，写清"该怎么改"而不是"哪里不对"。
 */
export function planSchedule(args = {}, now = Date.now(), { minIntervalMinutes = 5 } = {}) {
  const repeat = normalizeRepeat(args.repeat);
  if (!repeat) {
    return { error: `repeat 只能是 once / daily / weekly / interval（收到「${args.repeat}」）。不重复就别传这个参数。` };
  }

  const delayMinutes = Number(args.delayMinutes);
  const intervalMinutes = Number(args.intervalMinutes);
  const atRaw = String(args.atTime ?? '').trim();

  if (repeat === 'interval') {
    if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
      return { error: 'repeat=interval 时必须给 intervalMinutes（每隔多少分钟）。' };
    }
    if (intervalMinutes < minIntervalMinutes) {
      return { error: `最小间隔是 ${minIntervalMinutes} 分钟。太密的定时会刷屏，请改大或换成一次性。` };
    }
    const step = Math.round(intervalMinutes);
    return { dueAt: now + step * MINUTE, repeat, timeOfDay: null, weekdays: [], intervalMinutes: step };
  }

  if (repeat === 'daily' || repeat === 'weekly') {
    // 允许模型写成 "08:00"；写成 "2026-09-30 08:00" 也能救回来（取后面的时刻）。
    const timeOfDay = parseHHMM(atRaw) || parseHHMM(atRaw.split(/[ T]/).pop());
    if (!timeOfDay) {
      return { error: 'repeat=daily / weekly 时，atTime 要给「HH:MM」（例如 "08:00"）。' };
    }
    if (repeat === 'daily') {
      return { dueAt: nextTimeOfDayFrom(timeOfDay, now), repeat, timeOfDay, weekdays: [], intervalMinutes: null };
    }
    const days = [...new Set((Array.isArray(args.weekdays) ? args.weekdays : []).map(Number).filter((n) => n >= 1 && n <= 7))];
    if (!days.length) {
      return { error: 'repeat=weekly 时必须给 weekdays，1=周一 … 7=周日（例如 [1,3,5]）。' };
    }
    const dueAt = nextWeeklyFrom(days, timeOfDay, now);
    if (!dueAt) return { error: '每周的时间算不出来，检查一下 weekdays 是不是 1~7。' };
    return { dueAt, repeat, timeOfDay, weekdays: days, intervalMinutes: null };
  }

  // 一次性
  if (Number.isFinite(delayMinutes) && delayMinutes > 0) {
    return { dueAt: now + Math.round(delayMinutes) * MINUTE, repeat, timeOfDay: null, weekdays: [], intervalMinutes: null };
  }
  if (atRaw) {
    const dueAt = parseAtTime(atRaw, now);
    if (!dueAt) return { error: '时间格式不对：用 "HH:MM"（如 18:30）或 "YYYY-MM-DD HH:MM"。' };
    if (dueAt <= now) return { error: '这个时间已经过去了，请给一个未来的时间。' };
    return { dueAt, repeat, timeOfDay: parseHHMM(atRaw.split(/[ T]/).pop()), weekdays: [], intervalMinutes: null };
  }
  return { error: '要给 delayMinutes（多少分钟后）或 atTime（具体时间）之一。' };
}

/** 已触发过的任务：下一次该什么时候触发；不重复返回 null。 */
export function nextDueAfter(task, from = Date.now()) {
  const repeat = task?.repeat || 'once';
  if (repeat === 'once') return null;
  if (repeat === 'interval') {
    const step = Math.max(1, Number(task.intervalMinutes) || 0) * MINUTE;
    if (!step) return null;
    let t = Number(task.dueAt) || from;
    // 停机很久时一路推到未来，而不是把错过的每一次都补一遍。
    while (t <= from) t += step;
    return t;
  }
  const timeOfDay = task.timeOfDay || { h: 9, m: 0 };
  if (repeat === 'daily') return nextTimeOfDayFrom(timeOfDay, from);
  if (repeat === 'weekly') return nextWeeklyFrom(task.weekdays || [], timeOfDay, from);
  return null;
}

/** 给人看的时间：今天/明天/月日 + 时:分。 */
export function formatDue(ts, now = Date.now()) {
  if (!Number.isFinite(Number(ts))) return '（时间未知）';
  const d = new Date(Number(ts));
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const pad = (n) => String(n).padStart(2, '0');
  const isSameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const today = new Date(now);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (isSameDay(d, today)) return `${hh}:${mm}`;
  if (isSameDay(d, tomorrow)) return `明天 ${hh}:${mm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`;
}

/** 重复规则的中文描述（列表与回执用）。 */
export function describeRepeat(task) {
  const repeat = task?.repeat || 'once';
  if (repeat === 'once') return '一次性';
  if (repeat === 'interval') return `每 ${task.intervalMinutes} 分钟`;
  const hm = task.timeOfDay ? `${String(task.timeOfDay.h).padStart(2, '0')}:${String(task.timeOfDay.m).padStart(2, '0')}` : '';
  if (repeat === 'daily') return `每天 ${hm}`.trim();
  const names = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const days = (task.weekdays || []).map((n) => names[n] || `周${n}`).join('、');
  return `每${days} ${hm}`.trim();
}
