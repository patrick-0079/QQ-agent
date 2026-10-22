// 预览卡片外观：用技能自己的 buildCardHtml 渲出 HTML（含真实裁切后的背景图），
// 供无头浏览器截图肉眼确认。硬编码返回 null，所以只能跑 HTML，不能出 PNG。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.dirname(here);
const OUT = process.env.PREVIEW_OUT || path.join(os.tmpdir(), 'pcstatus-preview');
fs.mkdirSync(OUT, { recursive: true });

const CARD_W = 520;
const CARD_H = Number(process.env.CARD_H || 620);

const mod = await import(pathToFileURL(path.join(skillDir, 'index.js')).href);
const { buildCardHtml, cropBackground } = mod.__internals;

const bgFile = path.join(skillDir, 'assets', 'background.jpg');
const bgUri = fs.existsSync(bgFile) ? await cropBackground(bgFile, CARD_W, CARD_H) : '';
console.log('背景图:', bgUri ? Math.round(bgUri.length / 1024) + ' KB' : '（无，将用纯色）');

const d = {
  host: 'MY-PC', os: 'Windows 11 专业版', uptimeSec: 259500,
  cpu: { usedPct: 5, coreCount: 12, coreMax: 14 },
  mem: { totalMB: 32476, usedMB: 14746, freeMB: 17730, usedPct: 45 },
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
  const p = path.join(OUT, `card-${theme}.html`);
  fs.writeFileSync(p, html, 'utf8');
  console.log(`${theme}: ${p}（${Math.round(html.length / 1024)} KB）`);
}
console.log('CARD_H =', CARD_H, '\n目录:', OUT);
