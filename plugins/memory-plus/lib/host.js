// 印象档案 · 控制台界面安装层
//
// 为什么需要这一层（不是我们想改核，是核没有前端扩展点）：
//   插件跑在 Electron 主进程，页面跑在渲染进程，两边唯一的通路是本地 HTTP。
//   核里**没有任何** registerTab / uiExtension 之类的钩子（knowledge-hub-panel
//   也确认过这一点）。所以"自带管理界面"在这台机器上的既定做法就是：
//     插件把界面文件写进 <安装根>/resources/app/ui/，再往 ui/index.html 里
//     插一行 <script defer src="/xxx.js">（静态根就是 ui/，放进去即可访问）。
//
// 三条纪律（照抄 module-manager / knowledge-hub-panel 踩坑后的结论）：
//   1. 只摘自己那一段（带自己 id 的注释标记），**绝不整文件还原备份** ——
//      module-manager、theme-mode、knowledge-hub-panel、app-control 都在改
//      同一个 index.html，整文件还原会把别人装的东西一起弄没。
//   2. 第一次改动前留一份当时的 index.html 快照（写一次，永不覆盖）。
//   3. 幂等：内容没变不写盘；找不到 </head> 就整体放弃，宁可不装也不弄坏页面。
//
// ⚠️ 应用覆盖安装会把 resources/app/ 整个换掉 —— 界面文件和注入行都会没。
//   本插件在每次 setup / activate 时都会重装一遍（自愈），用户只需刷新控制台。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../../../src/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_DIR = path.resolve(HERE, '..');          // plugins/memory-plus
const APP_ROOT = path.resolve(PLUGIN_DIR, '..', '..');        // resources/app
const INSTALL_ROOT = path.resolve(APP_ROOT, '..', '..');      // 安装根（QQ Agent/）
export const UI_DIR = path.join(APP_ROOT, 'ui');
const UI_INDEX = path.join(UI_DIR, 'index.html');

const HOST_BEGIN = '<!-- memory-plus:begin（由「记忆与存档优化」插件安装；关掉插件会精确删掉这一段） -->';
const HOST_END = '<!-- memory-plus:end -->';

/** 要搬进 ui/ 的文件（源在插件目录里，改代码要改这里那一份）。 */
const HOST_FILES = [
  { from: 'host/panel.js', to: 'memory-plus-panel.js' },
  { from: 'host/panel.css', to: 'memory-plus-panel.css' }
];

/** 面板的数据快照：核的静态根会直接把它当文件供出去，前端 fetch 即可（零核依赖）。 */
export const SNAPSHOT_FILE = path.join(UI_DIR, 'memory-plus-data.json');

function hostBlock() {
  return [
    HOST_BEGIN,
    '<link rel="stylesheet" href="/memory-plus-panel.css" />',
    '<script defer src="/memory-plus-panel.js"></script>',
    HOST_END
  ].join('\n');
}

/** 摘掉属于本插件的那几行（认标记块 + 散落的两个引用行）。 */
export function stripHostLines(html) {
  const eol = String(html).includes('\r\n') ? '\r\n' : '\n';
  const out = [];
  let inBlock = false;
  let removed = false;
  for (const line of String(html).split(/\r?\n/)) {
    const t = line.trim();
    if (!inBlock && t.startsWith('<!-- memory-plus:begin')) { inBlock = true; removed = true; continue; }
    if (inBlock) { if (t.startsWith('<!-- memory-plus:end')) inBlock = false; continue; }
    if (/^<link\b[^>]*\/memory-plus-panel\.css[^>]*>$/i.test(t)) { removed = true; continue; }
    if (/^<script\b[^>]*\/memory-plus-panel\.js[^>]*><\/script>$/i.test(t)) { removed = true; continue; }
    out.push(line);
  }
  return { html: out.join(eol), removed };
}

/**
 * 装/刷新界面。返回 {ok, changed, files, backedUp} 或 {ok:false, error}。
 * 幂等：文件内容一致就不写；注入行已存在就不重复插。
 */
export async function installHost({ log = () => {} } = {}) {
  try {
    await fsp.mkdir(UI_DIR, { recursive: true });
    let html;
    try {
      html = await fsp.readFile(UI_INDEX, 'utf8');
    } catch (error) {
      return { ok: false, error: `读不到 ${UI_INDEX}：${error?.message ?? error}（这个 resources/app 不是 QQ Agent 的控制台？）` };
    }

    let backedUp = '';
    if (!stripHostLines(html).removed) {
      const backup = path.join(INSTALL_ROOT, 'data', 'ui-theme-backup', 'index.html.before-memory-plus');
      try {
        await fsp.access(backup);
      } catch {
        try {
          await fsp.mkdir(path.dirname(backup), { recursive: true });
          await fsp.writeFile(backup, html, 'utf8');
          backedUp = backup;
        } catch { /* 备份失败不影响安装 */ }
      }
    }

    let changed = false;
    const bits = [];
    for (const f of HOST_FILES) {
      const src = path.join(PLUGIN_DIR, f.from);
      const dst = path.join(UI_DIR, f.to);
      let data;
      try {
        data = await fsp.readFile(src);
      } catch (error) {
        return { ok: false, error: `插件里缺文件 ${f.from}：${error?.message ?? error}` };
      }
      let same = false;
      try { same = Buffer.compare(await fsp.readFile(dst), data) === 0; } catch { same = false; }
      if (!same) { await fsp.writeFile(dst, data); changed = true; }
      bits.push(`${f.to}${same ? '' : '（已写入）'}`);
    }

    let next = stripHostLines(html).html;
    // ⚠️ 插在 </body> 之前（不是 </head>）：这样我们的脚本在文档顺序上排在
    //    核心的 /app/*.js 之后执行，能立刻拿到 switchTab / loadMemoryDetail /
    //    openMemberImpressModal / uiConfirm 这些核心全局 —— 否则得靠轮询等它们出现。
    //    找不到 </body> 时退回 </head>（少见，但不至于装不上）。
    const at = /<\/body>/i.test(next) ? /<\/body>/i : (/<\/head>/i.test(next) ? /<\/head>/i : null);
    if (!at) {
      return { ok: false, error: 'ui/index.html 里找不到 </body> 也找不到 </head>，不敢动它（怕把控制台页面弄坏）' };
    }
    next = next.replace(at, `${hostBlock()}\n${String(next).match(at)[0]}`);
    if (next !== html) { await fsp.writeFile(UI_INDEX, next, 'utf8'); changed = true; }

    if (changed) log(`控制台界面已装上/刷新：${bits.join('、')}`);
    return { ok: true, changed, files: bits, backedUp: backedUp || undefined };
  } catch (error) {
    return { ok: false, error: `装界面失败：${error?.message ?? error}` };
  }
}

/** 摘掉界面（删文件 + 精确摘行）。 */
export async function removeHost({ log = () => {} } = {}) {
  try {
    let changed = false;
    try {
      const html = await fsp.readFile(UI_INDEX, 'utf8');
      const { html: next, removed } = stripHostLines(html);
      if (removed) { await fsp.writeFile(UI_INDEX, next, 'utf8'); changed = true; }
    } catch { /* 读不到就只删文件 */ }
    for (const f of HOST_FILES) {
      const abs = path.join(UI_DIR, f.to);
      try { await fsp.access(abs); await fsp.rm(abs, { force: true }); changed = true; } catch { /* 不存在 */ }
    }
    // 顺手把数据快照也删掉，卸载后不在 ui/ 里留垃圾
    try { await fsp.access(SNAPSHOT_FILE); await fsp.rm(SNAPSHOT_FILE, { force: true }); changed = true; } catch { /* 不存在 */ }
    if (changed) log('控制台界面已卸掉');
    return { ok: true, changed };
  } catch (error) {
    return { ok: false, error: `卸界面失败：${error?.message ?? error}` };
  }
}

/** 界面在不在（面板状态块用）。 */
export function hostStatus() {
  const items = [];
  for (const f of HOST_FILES) {
    const abs = path.join(UI_DIR, f.to);
    let bytes = 0;
    let fresh = false;
    try { bytes = fs.statSync(abs).size; } catch { bytes = 0; }
    try { fresh = Buffer.compare(fs.readFileSync(abs), fs.readFileSync(path.join(PLUGIN_DIR, f.from))) === 0; } catch { fresh = false; }
    items.push({ what: `ui/${f.to}`, ok: bytes > 0, bytes, upToDate: fresh });
  }
  let refs = false;
  try {
    const html = fs.readFileSync(UI_INDEX, 'utf8');
    refs = /\/memory-plus-panel\.js/.test(html) && /\/memory-plus-panel\.css/.test(html);
  } catch { /* 读不到 = 没装 */ }
  items.push({ what: 'ui/index.html 里挂着印象档案面板', ok: refs, upToDate: refs });
  return { ok: true, installed: items.every((x) => x.ok), upToDate: items.every((x) => x.upToDate), items };
}

/** 原子写面板数据快照。前端 fetch('/memory-plus-data.json') 读它。 */
export function writeSnapshot(data) {
  try {
    fs.mkdirSync(UI_DIR, { recursive: true });
    const tmp = `${SNAPSHOT_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
    fs.renameSync(tmp, SNAPSHOT_FILE);
    return true;
  } catch (error) {
    console.warn('[memory-plus] 写面板快照失败:', error?.message ?? error);
    return false;
  }
}

/** 让控制台窗口重新加载（等价于用户按 F5）。无头/非 Electron 环境下静默跳过。
 * @returns {{count:number, error:string}} count>0 = 真的刷新了；error 非空 = 没刷新成（原因可直接给用户看） */
export async function reloadConsole() {
  try {
    const mod = await import('electron');
    const BrowserWindow = mod?.BrowserWindow ?? mod?.default?.BrowserWindow;
    if (!BrowserWindow || typeof BrowserWindow.getAllWindows !== 'function') {
      return { count: 0, error: '拿不到 BrowserWindow（当前不是 Electron 环境，或控制台没开）' };
    }
    const wins = BrowserWindow.getAllWindows();
    if (!wins.length) return { count: 0, error: '当前没有控制台窗口' };
    let n = 0;
    for (const w of wins) {
      try { w.webContents?.reloadIgnoringCache?.(); n += 1; } catch { /* 单个窗口失败不影响其它 */ }
    }
    return { count: n, error: '' };
  } catch (error) {
    return { count: -1, error: String(error?.message ?? error) };
  }
}

export { DATA_DIR };
