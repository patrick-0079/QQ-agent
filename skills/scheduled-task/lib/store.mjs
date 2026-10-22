// 定时任务的落盘存储。
// 文件：<数据目录>/scheduled-tasks.json
//
// 与核心的 data/reminders.json 分开：那一份是「到点由核心直接发一条文本」的闹钟，
// 语义不同、改动它会影响两个版本的既有行为（见技能目录下的安装说明）。
//
// 写盘照抄核心 ReminderStore 的路子：先写 .tmp 再 rename —— 断电时不会留下半个 JSON。
// 全量覆写是有意的：单机、任务数量被上限压着（每会话 5 条），不值得上增量写。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function load(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && Array.isArray(parsed.tasks)) return parsed.tasks;
  } catch { /* 文件不存在或坏了都当空库：任务丢了不该让进程起不来 */ }
  return [];
}

export class TaskStore {
  constructor(file) {
    this.file = file;
    this.tasks = load(file);
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, tasks: this.tasks }, null, 1), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  /** 重新从磁盘读（多实例/手工改过文件时用）。 */
  reload() {
    this.tasks = load(this.file);
    return this.tasks;
  }

  add({ chatKey, kind, text, dueAt, repeat = 'once', timeOfDay = null, weekdays = [], intervalMinutes = null, createdBy = '', createdByName = '' }) {
    const entry = {
      id: `t_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`,
      chatKey: String(chatKey),
      kind: String(kind || String(chatKey).split(':')[0] || ''),
      text: String(text ?? '').trim(),
      dueAt: Number(dueAt),
      repeat,
      timeOfDay,
      weekdays,
      intervalMinutes,
      createdBy: String(createdBy ?? ''),
      createdByName: String(createdByName ?? ''),
      createdAt: Date.now(),
      firedCount: 0,
      lastFiredAt: null,
      done: false
    };
    this.tasks.push(entry);
    this.save();
    return entry;
  }

  all() {
    return this.tasks;
  }

  /** 某会话还没到点/没结束的任务，按到期时间升序；不传 chatKey 就是全部。 */
  pending(chatKey = null) {
    return this.tasks
      .filter((t) => !t.done && (!chatKey || t.chatKey === String(chatKey)))
      .sort((a, b) => a.dueAt - b.dueAt);
  }

  /** 所有到点且没结束的任务。 */
  due(now = Date.now()) {
    return this.tasks.filter((t) => !t.done && Number(t.dueAt) <= now).sort((a, b) => a.dueAt - b.dueAt);
  }

  byId(id) {
    const key = String(id ?? '').trim();
    return this.tasks.find((t) => t.id === key) || null;
  }

  countIn(chatKey) {
    return this.pending(chatKey).length;
  }

  /** 某人在某会话里还有几条没结束的任务（防捣乱的上限用）。 */
  countByUser(chatKey, userId) {
    const uid = String(userId ?? '');
    if (!uid) return 0;
    return this.pending(chatKey).filter((t) => String(t.createdBy) === uid).length;
  }

  /**
   * 触发完了：nextDueAt 为 null 表示这条任务结束（一次性），否则改成下一次的时间。
   * 只在"确实唤醒成功"之后调 —— 反过来的话，进程崩溃就会把任务永久吞掉。
   */
  markFired(id, nextDueAt = null) {
    const t = this.byId(id);
    if (!t) return false;
    t.firedCount = (Number(t.firedCount) || 0) + 1;
    t.lastFiredAt = Date.now();
    if (nextDueAt == null) t.done = true;
    else t.dueAt = Number(nextDueAt);
    this.save();
    return true;
  }

  remove(id) {
    const key = String(id ?? '').trim();
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((t) => t.id !== key);
    if (this.tasks.length < before) {
      this.save();
      return true;
    }
    return false;
  }

  /** 已结束的任务只留最近 200 条，防文件无限长大。 */
  prune(keepDone = 200) {
    const done = this.tasks.filter((t) => t.done).sort((a, b) => (b.lastFiredAt || 0) - (a.lastFiredAt || 0));
    if (done.length <= keepDone) return false;
    const alive = this.tasks.filter((t) => !t.done);
    this.tasks = [...alive, ...done.slice(0, keepDone)];
    this.save();
    return true;
  }
}
