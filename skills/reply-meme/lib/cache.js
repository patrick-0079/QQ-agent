import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { downloadImage, fingerprint, saveImage, sniffSize } from './image.js';
import { createLimiter } from './limiter.js';
import { trustedUrl } from './network.js';

const MAX_AGE = 48 * 3600000;
const validName = /^[a-f0-9]{64}\.(jpg|png|gif|webp)$/;

// 持久化素材 URL 到本地图片的映射；ticket 仍只在当前会话生成和使用。
export function createImageCache(httpFetch, directory, { timeoutMs = 6000, failureTtlMs = 120000, maxFiles = 500, maxBytes = 128 * 1024 * 1024, concurrency = 2 } = {}) {
  const manifest = path.join(directory, 'image-cache.json');
  const records = new Map(), failures = new Map(), pending = new Map();
  const pins = new Map(), delivering = new Set();
  const limiter = createLimiter({ concurrency });
  try {
    if (fs.statSync(manifest).size <= 4 * 1024 * 1024) {
      const saved = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      for (const [key, entry] of Object.entries(saved.images || {}).slice(-500)) {
        if (/^[a-f0-9]{64}$/.test(key) && validName.test(entry?.name) && Number.isFinite(entry.at)
            && entry.at <= Date.now() && Date.now() - entry.at < MAX_AGE) records.set(key, entry);
      }
    }
  } catch { /* 缓存缺失或损坏时正常下载 */ }
  const keyOf = item => fingerprint(item.original);
  const fileOf = entry => path.join(directory, 'images', entry.name);
  const available = item => {
    const key = keyOf(item), failed = failures.get(key);
    if (failed && failed.until > Date.now()) return false;
    failures.delete(key);
    return true;
  };
  const cached = item => {
    const entry = records.get(keyOf(item));
    return !!entry && Date.now() - entry.at < MAX_AGE && fs.existsSync(fileOf(entry));
  };
  function lease(image) {
    pins.set(image.file, (pins.get(image.file) || 0) + 1);
    let released = false;
    return { ...image, release() {
      if (released) return;
      released = true;
      const count = (pins.get(image.file) || 1) - 1;
      if (count) pins.set(image.file, count); else pins.delete(image.file);
      sweep();
    } };
  }
  function persist() {
    try {
      fs.mkdirSync(directory, { recursive: true });
      const temp = `${manifest}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ images: Object.fromEntries(records) }));
      fs.renameSync(temp, manifest);
    } catch { /* 内存缓存仍可用 */ }
  }
  function sweep() {
    const dir = path.join(directory, 'images');
    const files = [];
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!validName.test(name)) continue;
        const file = path.join(dir, name);
        try {
          const stat = fs.lstatSync(file);
          // 不跟随本地符号链接，不清理未知文件。
          if (stat.isFile() && !stat.isSymbolicLink()) files.push({ name, file, size: stat.size, at: stat.mtimeMs });
        } catch { /* 文件可能已被其他缓存实例清理 */ }
      }
    } catch { return; }
    let bytes = files.reduce((sum, file) => sum + file.size, 0), count = files.length;
    const referenced = new Set([...records.values()].map(entry => entry.name));
    const retained = new Set(files.map(file => file.name));
    files.sort((a, b) => Number(referenced.has(a.name)) - Number(referenced.has(b.name)) || a.at - b.at);
    for (const file of files) {
      if (pins.has(file.file) || delivering.has(file.file)) continue;
      if (referenced.has(file.name) && Date.now() - file.at < MAX_AGE && count <= maxFiles && bytes <= maxBytes) continue;
      try {
        fs.unlinkSync(file.file);
        retained.delete(file.name); count--; bytes -= file.size;
      } catch { /* 锁定文件留到下次维护 */ }
    }
    for (const [key, entry] of records) if (!retained.has(entry.name)) records.delete(key);
    // 多个 URL 可能映射到同一文件；映射数量也按最近使用时间限制。
    for (const [key, entry] of [...records].sort((a, b) => a[1].at - b[1].at)) {
      if (records.size <= 500) break;
      if (!pins.has(fileOf(entry)) && !delivering.has(fileOf(entry))) records.delete(key);
    }
    persist();
  }
  async function prepare(item, signal, { prefetch = false } = {}) {
    if (signal?.aborted) throw new Error('图片准备已取消');
    const key = keyOf(item), entry = records.get(key);
    if (cached(item)) {
      try {
        const file = fileOf(entry), stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 12 * 1024 * 1024) throw new Error('缓存大小异常');
        const buf = fs.readFileSync(file), size = sniffSize(buf);
        if (!size || !size.w || !size.h || size.w > 20000 || size.h > 20000 || fingerprint(buf) !== entry.hash) throw new Error('缓存损坏');
        entry.at = Date.now();
        fs.utimesSync(file, new Date(), new Date());
        persist();
        const result = lease({ ...size, bytes: buf.length, hash: entry.hash, file, usedPreview: !!entry.usedPreview, cached: true });
        sweep();
        return result;
      } catch { records.delete(key); }
    }
    if (!available(item)) throw new Error('该素材刚刚下载失败，暂时跳过 2 分钟');
    if (pending.has(key)) {
      const image = await pending.get(key);
      if (signal?.aborted) throw new Error('图片准备已取消');
      return lease(image);
    }
    const job = (async () => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      let releaseSlot;
      let attempts = [];
      try {
        if (signal?.aborted) throw new Error('图片准备已取消');
        releaseSlot = await limiter.acquire(signal, prefetch);
        if (signal?.aborted) throw new Error('图片准备已取消');
        let image;
        if (item.origin === 'local') {
          const root = await fsp.realpath(item.localRoot);
          const filePath = await fsp.realpath(item.localFile);
          const stat = await fsp.lstat(item.localFile);
          if (path.dirname(filePath) !== root || stat.isSymbolicLink() || !stat.isFile() || stat.size > 12 * 1024 * 1024
              || `${stat.size}:${stat.mtimeMs}` !== item.revision) throw new Error('本地图片已变更，请重新检索');
          const buf = await fsp.readFile(filePath);
          const after = await fsp.stat(filePath);
          if (`${after.size}:${after.mtimeMs}` !== item.revision || buf.length !== stat.size) throw new Error('本地图片读取时发生变化');
          const size = sniffSize(buf);
          if (!size || !size.w || !size.h || size.w > 20000 || size.h > 20000) throw new Error('本地文件不是支持的图片');
          image = { ...size, buf, bytes: buf.length, hash: fingerprint(buf), usedPreview: false };
        } else {
          const urls = [...new Set([item.original, item.preview].filter(Boolean))];
          // 并行请求以限制总等待；原图成功时始终保留原始字节，预览仅兜底。
          attempts = urls.map(async url => ({
            ...await downloadImage(httpFetch, url, timeoutMs, controller.signal), usedPreview: url !== item.original
          }));
          const fastest = Promise.any(attempts);
          fastest.catch(() => {});
          image = await attempts[0].catch(() => fastest);
        }
        if (signal?.aborted) throw new Error('图片准备已取消');
        const file = saveImage(directory, image);
        delivering.add(file);
        const { buf, ...metadata } = image;
        const sourceItem = item.origin === 'local' ? undefined : Object.fromEntries(
          ['original', 'preview', 'title', 'alt', 'label', 'story', 'category', 'page', 'requestOnly'].filter(k => item[k] !== undefined).map(k => [k, item[k]]));
        records.set(key, { ...metadata, ...(sourceItem ? { sourceItem } : {}), name: path.basename(file), at: Date.now() });
        failures.delete(key);
        persist();
        return { ...metadata, file, cached: false };
      } catch (error) {
        if (signal?.aborted) throw new Error('图片准备已取消');
        if (error.code === 'cache-capacity') throw error;
        const reason = item.origin === 'local' && error.code ? '本地文件无法读取，请检查目录并重新检索' : error instanceof AggregateError ? [...new Set(error.errors.map(e => e.message))].join('；') : error.message;
        while (failures.size >= 1000) failures.delete(failures.keys().next().value);
        failures.set(key, { until: Date.now() + failureTtlMs });
        throw new Error(`所选素材无法准备：${String(reason).slice(0, 180)}`);
      } finally {
        controller.abort();
        await Promise.allSettled(attempts);
        releaseSlot?.();
        signal?.removeEventListener('abort', abort);
      }
    })();
    pending.set(key, job);
    let delivered;
    try {
      delivered = await job;
      if (signal?.aborted) throw new Error('图片准备已取消');
      return lease(delivered);
    } finally {
      pending.delete(key);
      if (delivered) delivering.delete(delivered.file);
      sweep();
    }
  }
  const cachedItems = () => [...records.values()].flatMap(entry => {
    const item = entry.sourceItem;
    try {
      if (!item || trustedUrl(item.original) !== item.original || typeof item.title !== 'string' || !cached(item)) return [];
      return [item];
    } catch { return []; }
  });
  return { prepare, available, cached, sweep, cachedItems };
}
