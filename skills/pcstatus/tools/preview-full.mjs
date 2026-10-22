// 校验卡片底部留白：按用户实际设置渲染最"满"的一种情况，看最后一行是否完整。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.dirname(here);
const OUT = process.env.PREVIEW_OUT || path.join(os.tmpdir(), 'pcstatus-preview');
fs.mkdirSync(OUT, { recursive: true });

const CARD_W = 520;
const CARD_H = Number(process.env.CARD_H || 700);

const mod = await import(pathToFileURL(path.join(skillDir, 'index.js')).href);
const { buildCardHtml, cropBackground } = mod.__internals;

const bgFile = path.join(skillDir, 'assets', 'background.jpg');
const bgUri = await cropBackground(bgFile, CARD_W, CARD_H);

// 最容易撑满的情况：5 个程序 + 2 块盘 + CPU/内存告警行 + 10 行明细
const d = {
  host: 'MY-PC', os: 'Windows 11 专业版', uptimeSec: 259500,
  cpu: { usedPct: 91, coreCount: 12, coreMax: 98 },
  mem: { totalMB: 32476, usedMB: 29850, freeMB: 2626, usedPct: 92 },
  disks: [ { id: 'C:', freeGB: 108, freePct: 23 }, { id: 'D:', freeGB: 338, freePct: 18 } ],
  procs: { top: [
    { n: 'Memory Compression', count: 1, memMB: 2451.1 },
    { n: 'svchost', count: 98, memMB: 1467.2 },
    { n: 'DeepSeek Harness', count: 6, memMB: 1274 },
    { n: 'QQ', count: 7, memMB: 1002.1 },
    { n: 'steamwebhelper', count: 8, memMB: 782.9 }
  ] },
  qqagent: { n: 'QQ Agent', count: 4, memMB: 628.8, start: Date.now() - 164000000 }
};
const cfg = { topListInCompact: 5, includeQQAgent: true };

for (const theme of ['light', 'dark']) {
  const html = buildCardHtml(d, cfg, theme, bgUri, CARD_H);
  fs.writeFileSync(path.join(OUT, `full-${theme}.html`), html, 'utf8');
}
console.log('CARD_H =', CARD_H, '| 目录:', OUT);
console.log('（含告警行与 5 个程序，是最容易溢出的一种排版）');
