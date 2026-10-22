import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function createLocalSource() {
  let root = '', at = 0, items = [], pending;
  const resolve = directory => typeof directory === 'string' && path.isAbsolute(directory.trim()) ? path.resolve(directory.trim()) : '';
  return {
    peek(directory) { return resolve(directory) === root ? items : []; },
    clear() { root = ''; at = 0; items = []; },
    async load(directory, signal) {
      const wanted = resolve(directory);
      if (!wanted) throw new Error('本地目录需要填写绝对路径');
      if (root === wanted && Date.now() - at < 30000) return items;
      if (pending) { try { await pending; } catch { /* retry own directory */ } return this.load(directory, signal); }
      root = wanted; at = 0; items = [];
      pending = (async () => {
        const stat = await fs.lstat(wanted);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('本地目录不可用或是链接目录');
        const entries = await fs.readdir(wanted, { withFileTypes: true });
        const found = [];
        for (const entry of entries) {
          if (signal?.aborted) throw new Error('本地扫描已取消');
          if (!entry.isFile() || !/\.(jpe?g|png|webp|gif)$/i.test(entry.name)) continue;
          const file = path.join(wanted, entry.name);
          try {
            const stat = await fs.lstat(file);
            if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > 12 * 1024 * 1024) continue;
            const revision = `${stat.size}:${stat.mtimeMs}`;
            const title = path.basename(entry.name, path.extname(entry.name)).replace(/[_\s-]+\d+$/, '').replace(/[_]+/g, ' ').trim();
            const url = pathToFileURL(file); url.searchParams.set('rev', revision);
            found.push({ origin: 'local', original: url.href, localFile: file, localRoot: wanted, revision,
              title, label: title, story: '', category: '' });
          } catch { /* file removed during scan */ }
          if (found.length >= 5000) break;
        }
        if (!signal?.aborted && root === wanted) { items = found; at = Date.now(); }
      })();
      try { await pending; return items; } finally { pending = null; }
    }
  };
}
