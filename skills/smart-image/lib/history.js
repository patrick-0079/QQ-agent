// 去重记忆：让"同一个关键词每次出不同的图"跨轮次、跨重启都成立。
//
// 为什么不能只靠内存 Set：
//   应用重启后内存清空，用户连着两次问"来张猫图"，第二次很可能又抽到同一张
//   （搜索引擎对同一关键词的排序是稳定的，热门前几张图就那么几个）。
//   所以落一份 JSON 到磁盘，进程一起就读回来。
//
// 两级记忆（都记，缺一不可）：
//   · 关键词级 —— 这个关键词已经发过哪些图。保证"同词不同图"。
//   · 全局级   —— 本技能一共发过哪些图。避免"猫"发过的图又被"橘猫"抽出来。
// 键同时含 **URL 指纹**（下载前就能拦，省流量）和 **内容指纹**（同一张图换域名也认得）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const DIR = path.join(os.tmpdir(), 'qq-agent-smart-image');
const FILE = path.join(DIR, 'history.json');

/** 每个关键词最多记这么多张，超了丢最旧的（只丢记录，不删图）。 */
const PER_KEYWORD_LIMIT = 60;
/** 全局最多记这么多张。 */
const GLOBAL_LIMIT = 400;

/** 进程内缓存：磁盘读写只在第一次和变化时发生。 */
let state = null;

function emptyState() {
  return { version: 1, keywords: {}, global: [] };
}

function load() {
  if (state) return state;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    state = {
      version: 1,
      keywords: (raw && typeof raw.keywords === 'object' && raw.keywords) || {},
      global: Array.isArray(raw?.global) ? raw.global : []
    };
  } catch {
    state = emptyState();   // 文件不存在/损坏都从零开始，不是错误
  }
  return state;
}

function persist() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state));
  } catch { /* 写不进去不影响本次功能，只是重启后可能重复 */ }
}

/** 关键词归一：大小写、空白、标点、空格都不该导致记忆分裂。 */
export function normKeyword(keyword) {
  return String(keyword || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[，。！？、,.!?;；:："'“”‘’()（）\[\]【】<>《》~～\-_/\\|+*&^%$#@`]/g, '')
    .trim()
    .slice(0, 80);
}

function keyOf(keyword) {
  return crypto.createHash('sha1').update(normKeyword(keyword)).digest('hex').slice(0, 16);
}

/**
 * 这个候选是否已经发过。
 *
 * @param {{ urlHash?: string, hash?: string }} fp
 * @returns {'url'|'content'|null} 命中的维度（用于日志区分"省了流量"和"换域名同图"）
 */
export function seen(keyword, fp) {
  const s = load();
  const list = s.keywords[keyOf(keyword)] || [];
  const g = s.global;
  if (fp.urlHash && (list.includes(`u:${fp.urlHash}`) || g.includes(`u:${fp.urlHash}`))) return 'url';
  if (fp.hash && (list.includes(`c:${fp.hash}`) || g.includes(`c:${fp.hash}`))) return 'content';
  return null;
}

/** 记一笔（URL 和内容指纹都记）。 */
export function mark(keyword, fp) {
  const s = load();
  const k = keyOf(keyword);
  const list = s.keywords[k] || (s.keywords[k] = []);
  const add = (bucket, item) => {
    if (!item || bucket.includes(item)) return;
    bucket.push(item);
    while (bucket.length > (bucket === s.global ? GLOBAL_LIMIT : PER_KEYWORD_LIMIT)) bucket.shift();
  };
  if (fp.urlHash) { add(list, `u:${fp.urlHash}`); add(s.global, `u:${fp.urlHash}`); }
  if (fp.hash) { add(list, `c:${fp.hash}`); add(s.global, `c:${fp.hash}`); }
  persist();
}

/** 调试/自检用：清空记忆。 */
export function reset() {
  state = emptyState();
  persist();
}
