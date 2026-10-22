// 会话档案的物理布局（P2：冷热分离）。
//
//   sessions/index.jsonl        一行一个已结束会话的摘要（含逐次调用用量）
//   sessions/archive/<id>.json.gz   完整档案（提示词/消息/发送记录），按需解压
//   sessions/running/<id>.json      运行中会话的摘要（≈1KB，不含提示词）
//   sessions/<id>.json              旧版完整档案，只读兼容 + 后台迁移
//
// 为什么：旧实现每 2 秒把整个会话（含提示词与全部消息）重写一遍，
// 一个 2 分钟的运行要写几十次、几十 MB；历史档案又要全量扫描才能列清单。
// 拆成"小摘要热写 + gzip 冷归档 + 单文件索引"后：
//   · 运行中写盘 ≈ 1KB/2s；
//   · 结束只写一次 gzip；
//   · 列表/用量只读 index.jsonl，不再读几千个档案。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { DATA_DIR } from '../config.js';
import {
  appendJsonl, ensureDir, fileSize, readJsonl, readJsonSafe, writeJsonAtomic
} from './atomic.js';

const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const ARCHIVE_DIR = path.join(SESSIONS_DIR, 'archive');
const RUNNING_DIR = path.join(SESSIONS_DIR, 'running');
const INDEX_FILE = path.join(SESSIONS_DIR, 'index.jsonl');

export const INDEX_VERSION = 1;

export function sessionsDir() { return SESSIONS_DIR; }
export function archiveDir() { return ARCHIVE_DIR; }
export function runningDir() { return RUNNING_DIR; }
export function indexFile() { return INDEX_FILE; }

export function ensureSessionsDirs() {
  ensureDir(SESSIONS_DIR);
  ensureDir(ARCHIVE_DIR);
  ensureDir(RUNNING_DIR);
}

export function legacyFile(id) {
  return path.join(SESSIONS_DIR, `${id}.json`);
}

export function archiveFile(id) {
  return path.join(ARCHIVE_DIR, `${id}.json.gz`);
}

export function runningFile(id) {
  return path.join(RUNNING_DIR, `${id}.json`);
}

/** 旧版完整档案文件名列表（不含 archive/running 子目录）。 */
export function listLegacyFiles() {
  try {
    return fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}

/** 读索引：按 id 去重（后写覆盖先写），按 startedAt 倒序。 */
export function readIndexEntries() {
  const map = new Map();
  for (const e of readJsonl(INDEX_FILE)) {
    if (!e || typeof e !== 'object' || !e.id) continue;
    map.set(String(e.id), e);
  }
  return [...map.values()].sort((a, b) => (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0));
}

export function appendIndexEntry(entry) {
  if (!entry || !entry.id) return;
  appendJsonl(INDEX_FILE, entry);
}

/** 原子重写整个索引（删除/清空/裁剪/压缩时用）。 */
export function rewriteIndex(entries) {
  const list = (Array.isArray(entries) ? entries : [])
    .filter((e) => e && e.id)
    .map((e) => JSON.stringify(e))
    .join('\n');
  writeJsonAtomic(INDEX_FILE, list ? `${list}\n` : '');
}

/** 写完整档案（gzip）。先写 tmp 再 rename，失败不会破坏旧档案。 */
export function writeArchive(session) {
  ensureSessionsDirs();
  const file = archiveFile(session.id);
  const raw = Buffer.from(JSON.stringify(session), 'utf8');
  const gz = zlib.gzipSync(raw, { level: 4 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, gz);
  fs.renameSync(tmp, file);
  return gz.length;
}

/** 读完整档案；损坏返回 null（调用方回退旧版 JSON）。 */
export function readArchive(id) {
  try {
    const buf = fs.readFileSync(archiveFile(id));
    return JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
  } catch {
    return null;
  }
}

/** 读一个会话的完整对象：archive 优先，其次旧版 sessions/<id>.json。 */
export function readSessionFull(id) {
  const archived = readArchive(id);
  if (archived) return archived;
  return readJsonSafe(legacyFile(id), null);
}

/** 运行中会话的摘要列表（给启动僵尸回收/用量页用）。 */
export function readRunningSummaries() {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(RUNNING_DIR).filter((f) => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    const v = readJsonSafe(path.join(RUNNING_DIR, f), null);
    if (v && typeof v === 'object' && v.id) out.push(v);
  }
  return out;
}

/** 写运行中摘要（小文件，节流由调用方负责）。 */
export function writeRunningSummary(summary) {
  ensureSessionsDirs();
  writeJsonAtomic(runningFile(summary.id), summary, { pretty: 1 });
}

export function deleteSessionArtifacts(id) {
  for (const f of [archiveFile(id), runningFile(id), legacyFile(id)]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
}

export function sessionStorageStats() {
  return {
    indexBytes: fileSize(INDEX_FILE),
    legacyFiles: listLegacyFiles().length,
    archiveFiles: (() => { try { return fs.readdirSync(ARCHIVE_DIR).filter((f) => f.endsWith('.json.gz')).length; } catch { return 0; } })(),
    runningFiles: (() => { try { return fs.readdirSync(RUNNING_DIR).filter((f) => f.endsWith('.json')).length; } catch { return 0; } })()
  };
}
