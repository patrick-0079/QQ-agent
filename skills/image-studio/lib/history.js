// 发送历史：记下"发过哪些图"，避免同一个群隔天又看到同一张。
//
// 只存一个键和时间戳，不存图片本身：
//   · Pixiv 作品 → `pixiv:<pid>`（同一作品的不同图床地址会归一到一个键）
//   · 普通网图   → `url:<sha256 前 20 位>`（百度/Bing 的图片地址对同一张图是稳定的）
//
// 窗口与容量都在读取时裁：默认 30 天内算"发过"，最多留 500 条。
// 文件坏了就当空历史 —— 去重是锦上添花，绝不能因为它让搜索整体失败。

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const HISTORY_MAX = 500;
export const DEFAULT_WINDOW_DAYS = 30;

/** 图片地址 → 去重键。 */
export function itemKey(url) {
  const value = String(url ?? '').trim();
  const pixiv = /pixiv\.re\/(\d{4,12})\.png/i.exec(value);
  if (pixiv) return `pixiv:${pixiv[1]}`;
  return `url:${createHash('sha256').update(value).digest('hex').slice(0, 20)}`;
}

/** 读历史（文件不存在/损坏都返回空）。只做解析，不按时间裁 —— 裁在 seenSet 里做。 */
export function loadHistory(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const items = Array.isArray(raw?.items) ? raw.items : [];
    return items
      .filter((it) => it && typeof it.key === 'string' && Number.isFinite(Number(it.at)))
      .map((it) => ({ key: it.key, at: Number(it.at) }))
      .slice(-HISTORY_MAX);
  } catch {
    return [];
  }
}

/** 窗口内的键集合。windowDays <= 0 表示"全算"（永久不重复）。 */
export function seenSet(items, windowDays = DEFAULT_WINDOW_DAYS, now = Date.now()) {
  const days = Number(windowDays);
  const cutoff = days > 0 ? now - days * 86400000 : 0;
  const set = new Set();
  for (const item of items || []) {
    if (item && item.at >= cutoff) set.add(item.key);
  }
  return set;
}

/** 原子写：先写 .tmp 再改名，进程被杀也不会留下半截 JSON。 */
export function saveHistory(file, items) {
  const clean = (items || [])
    .filter((it) => it && typeof it.key === 'string' && Number.isFinite(Number(it.at)))
    .slice(-HISTORY_MAX);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, items: clean }, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return clean;
}
