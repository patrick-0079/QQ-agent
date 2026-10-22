/**
 * 信息（fact）侧存 —— 记忆衰减所需的额外字段，宿主 schema 放不下，只能自建。
 *
 * ══════════════════════════════════════════════════════════════════════
 * ── 为什么必须自建文件（读源码后的硬结论，不是偏好）────────────────────
 *
 * 本技能原来的自律是"所有落盘都走 ctx.memory，插件不碰文件系统"。
 * 但记忆衰减这个需求**在宿主 schema 里放不下**，三条硬约束（均已核对 src/memory.js）：
 *
 *   ① `append()` 的 extra **被丢弃**：只取 userId/target，content 之外的自定义
 *      字段（hits / lastHitAt / zone）根本没地方存 —— 见 src/memory.js:223。
 *   ② 宿主的 impression 只有 `{ content, createdAt }` 两个字段，无分类、无权重。
 *   ③ `editMemberImpression()` 是**整体替换**且会把所有保留项的 createdAt
 *      **重置为 now**（src/memory.js:281）。 ⇒ 一旦用它做"重写"，全部原始时间戳
 *      就毁了，跨时间的衰减计算立刻失去意义。
 *
 * ⇒ 结论：**印象**继续走宿主（不动它，也就保住了原始 createdAt）；
 *    **信息**另存一份带 hits/lastHitAt 的侧存文件。这是唯一能做到"时间可衰减"
 *    的存法，不是偷懒。
 *
 * ── 文件布局 ──────────────────────────────────────────────────────────
 *   data/memory-curve/<group|private>_<id>/<QQ>.json
 *     { v:1, userId, name, facts:[{ content, createdAt, hits, lastHitAt }],
 *       updatedAt, lastDistillAt }
 *   与宿主的 data/memory/ 平级但独立 —— 互不干扰，删掉本目录 = 完全回退到无衰减状态。
 *
 * ── 写盘用「临时文件 → rename」原子替换 ─────────────────────────────────
 * 与 trpg-dice/state.js 同因：直接 writeFile 到目标路径，中途崩溃会留下半截 JSON，
 * 下次读就直接废掉。rename 在同一分区上是原子操作（要么旧文件完好，要么新文件完整）。
 *
 * ⚠️ DATA_DIR 必须问 config.js 要，不能按插件目录推算 —— 它会被
 *    QQ_AGENT_DATA_DIR / QQ_AGENT_PROFILE 重定向（trpg-dice 踩过这条）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../../src/config.js';

/** 侧存根目录。整体删掉它即可无损回退（宿主的 impressions 一个字节都没动过）。 */
export const CURVE_DIR = path.join(DATA_DIR, 'memory-curve');

/** chatKey('group:123') → 目录名，与宿主 memory.js 的 chatDirName 同规则。 */
function chatDirName(chatKey) {
  return String(chatKey ?? '').replace(/[^a-z0-9_]/gi, '_');
}

function memberFile(chatKey, userId) {
  const uid = String(userId ?? '').trim();
  // 与宿主一致：QQ 号原样做文件名；非数字（如 'self'）加前缀防撞
  const name = /^\d+$/.test(uid) ? `${uid}.json` : `u_${uid.replace(/[^a-z0-9_]/gi, '_')}.json`;
  return path.join(CURVE_DIR, chatDirName(chatKey), name);
}

function readJson(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/** 原子写：临时文件 → rename。失败只抛给调用方，绝不静默吞掉（写坏了要能发现）。 */
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

/** 空成员记录。 */
function emptyMember(userId, name = '') {
  return { v: 1, userId: String(userId ?? ''), name: String(name ?? ''), facts: [], updatedAt: 0, lastDistillAt: 0 };
}

/**
 * 读某人的信息侧存。**永远返回合法对象**（不存在 → 空记录），
 * 让调用方不必到处判空 —— 与宿主 loadMember 的语义保持一致。
 */
export function loadFacts(chatKey, userId, name = '') {
  const uid = String(userId ?? '').trim();
  if (!uid) return emptyMember(uid, name);
  const raw = readJson(memberFile(chatKey, uid), null);
  if (!raw) return emptyMember(uid, name);
  return {
    v: Number(raw.v) || 1,
    userId: String(raw.userId ?? uid),
    name: String(raw.name ?? name ?? ''),
    facts: (Array.isArray(raw.facts) ? raw.facts : [])
      .filter((f) => f && typeof f.content === 'string' && f.content.trim())
      .map((f) => ({
        content: String(f.content).trim(),
        createdAt: Number(f.createdAt) || 0,
        hits: Math.max(0, Number(f.hits) || 0),
        lastHitAt: Number(f.lastHitAt) || Number(f.createdAt) || 0,
      })),
    updatedAt: Number(raw.updatedAt) || 0,
    lastDistillAt: Number(raw.lastDistillAt) || 0,
  };
}

/** 整份写回。调用方负责传入已经合并好的完整记录。 */
export function saveFacts(chatKey, member, now = Date.now()) {
  const uid = String(member?.userId ?? '').trim();
  if (!uid) return false;
  const payload = {
    v: 1,
    userId: uid,
    name: String(member.name ?? ''),
    facts: Array.isArray(member.facts) ? member.facts : [],
    updatedAt: now,
    lastDistillAt: Number(member.lastDistillAt) || 0,
  };
  writeJsonAtomic(memberFile(chatKey, uid), payload);
  return true;
}

/**
 * 追加若干条信息。
 *
 * 去重规则：**同 content 视为同一条** —— 命中则 hits+1、lastHitAt=now（= 复习），
 * 而不是新增一条。这是"复习延长记忆"在写入侧的实现。
 * （宿主的 append 也按 content 去重，但它是直接丢弃，不会累加次数。）
 *
 * @returns {{ added:number, reviewed:number, member:object }}
 */
export function addFacts(chatKey, userId, name, entries, now = Date.now()) {
  const member = loadFacts(chatKey, userId, name);
  if (name) member.name = String(name);
  const list = Array.isArray(entries) ? entries : [entries];
  let added = 0, reviewed = 0;

  for (const raw of list) {
    const content = String(typeof raw === 'string' ? raw : raw?.content ?? '').trim();
    if (!content) continue;
    const body = content.slice(0, 300);
    const hit = member.facts.find((f) => f.content === body);
    if (hit) {
      hit.hits += 1;
      hit.lastHitAt = now;
      reviewed += 1;
    } else {
      member.facts.push({ content: body, createdAt: now, hits: 0, lastHitAt: now });
      added += 1;
    }
  }
  if (added || reviewed) saveFacts(chatKey, member, now);
  return { added, reviewed, member };
}

/**
 * 「复习」一批已有信息：按 content 命中则 hits+1。用于对话里再次提到某人某事的场景。
 * 与 addFacts 的差别：这里**只认已有条目**，命不中就不新增（避免把随口一提变成记忆）。
 */
export function reviewFacts(chatKey, userId, contents, now = Date.now()) {
  const member = loadFacts(chatKey, userId);
  const list = Array.isArray(contents) ? contents : [contents];
  let reviewed = 0;
  for (const raw of list) {
    const body = String(raw ?? '').trim();
    if (!body) continue;
    const hit = member.facts.find((f) => f.content === body);
    if (hit) { hit.hits += 1; hit.lastHitAt = now; reviewed += 1; }
  }
  if (reviewed) saveFacts(chatKey, member, now);
  return { reviewed, member };
}

/**
 * 用一批新的 facts 覆盖某人的（蒸馏/裁剪后的落盘）。
 * ⚠️ 只用于**本模块自己算出的结果**，不要拿外部数组直接调用 —— 会把 hits 历史冲掉。
 */
export function replaceFacts(chatKey, userId, facts, now = Date.now(), extra = {}) {
  const member = loadFacts(chatKey, userId);
  member.facts = (Array.isArray(facts) ? facts : []).map((f) => ({
    content: String(f?.content ?? '').trim().slice(0, 300),
    createdAt: Number(f?.createdAt) || now,
    hits: Math.max(0, Number(f?.hits) || 0),
    lastHitAt: Number(f?.lastHitAt) || Number(f?.createdAt) || now,
  })).filter((f) => f.content);
  if (extra.name !== undefined) member.name = String(extra.name);
  if (extra.lastDistillAt !== undefined) member.lastDistillAt = Number(extra.lastDistillAt) || 0;
  saveFacts(chatKey, member, now);
  return member;
}

/** 列出某会话下所有有信息侧存的人（目录扫描）。 */
export function listFactMembers(chatKey) {
  const dir = path.join(CURVE_DIR, chatDirName(chatKey));
  const out = [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return out;
  }
  for (const f of files) {
    const raw = readJson(path.join(dir, f), null);
    if (!raw) continue;
    const facts = Array.isArray(raw.facts) ? raw.facts : [];
    if (!facts.length) continue;
    out.push({
      userId: String(raw.userId ?? ''),
      name: String(raw.name ?? ''),
      count: facts.length,
      lastDistillAt: Number(raw.lastDistillAt) || 0,
      updatedAt: Number(raw.updatedAt) || 0,
    });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 删除某人的信息侧存（配合 forget 用，保证"删干净"）。 */
export function removeFacts(chatKey, userId) {
  try { fs.rmSync(memberFile(chatKey, userId), { force: true }); return true; } catch { return false; }
}

/** 删除整个会话的信息侧存。 */
export function removeChatFacts(chatKey) {
  try { fs.rmSync(path.join(CURVE_DIR, chatDirName(chatKey)), { recursive: true, force: true }); return true; } catch { return false; }
}

export const _internal = { chatDirName, memberFile, readJson, writeJsonAtomic };
