/**
 * Office 文档生成技能（Excel / Word / PowerPoint）
 * ─────────────────────────────────────────────────────────────────────────────
 * 为什么是技能（skills/）而不是插件：
 *   这是**模型决定**要做的事（"帮我做个表格/写个报告/做个PPT"），要给模型加工具，
 *   属于 LLM 型扩展。插件是确定性 providers/hooks。
 *
 * 用的库（纯 JS，装在程序 node_modules 里，从国内镜像取的）：
 *   · xlsx   (SheetJS 0.18.5) —— 写 .xlsx，单包无依赖
 *   · docx   (9.12.0)         —— 写 .docx
 *   · pptxgenjs (4.0.1)       —— 写 .pptx
 *   刻意不用 exceljs：它拖进来 200 个包 / 60MB；xlsx 只有单包。
 *
 * 关键实现点（都是踩过坑才这么写的）：
 *   1. **必须生成真 OOXML**：CSV/文本改后缀在 Word/Excel 里打不开，用户会以为"坏了"。
 *   2. 发送走协议端 upload_private_file / upload_group_file；先试 file:/// URI，
 *      失败退回**原始绝对路径**（有的协议端只认后者）。
 *   3. 文件名一律清洗：去掉路径分隔符/非法字符、防 ../ 穿越，最终路径必须落在导出目录内。
 *   4. 体积上限保护：超过 maxFileMB 不自动发送（QQ 上传会卡死），但文件保留。
 *   5. 同名文件自动加 -1/-2，绝不覆盖上一次的产出。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

let api = null;
let cfg = () => ({});

// ── 惰性加载三个库（技能加载时不拖慢启动）──────────────────────────────────
let libsPromise = null;
function loadLibs() {
  if (!libsPromise) {
    libsPromise = (async () => {
      const { createRequire } = await import('node:module');
      const req = createRequire(import.meta.url);
      // ⚠️ 必须用 require 取包，**不能**用 import()：
      //   pptxgenjs 4.0.1 的 package.json 是
      //     { "exports": { "import": "./dist/pptxgen.es.js", "require": "./dist/pptxgen.cjs.js" } }
      //   但**没声明 "type": "module"**，于是 dist/pptxgen.es.js（里面写的是
      //   `import JSZip from 'jszip'`）会被 Node 当成 CJS 解析 →
      //   "Cannot use import statement outside a module"。
      //   坑在本地测不出来：Node 22+ 会自动探测 ESM 语法（我不会复现），
      //   而程序跑在 Electron 的 Node 20 上（不复现不了）——所以只有 require 才稳。
      //   require 走 exports.require / main，三个包都有正牌 CJS 入口。
      const pkg = (name) => {
        try {
          return req(name);
        } catch (error) {
          throw new Error(`加载 ${name} 失败：${error?.message ?? error}`);
        }
      };
      const XLSX = pkg('xlsx');
      const D = pkg('docx');
      const PptxMod = pkg('pptxgenjs');
      const Pptx = typeof PptxMod === 'function' ? PptxMod : (PptxMod?.default ?? PptxMod);
      if (!XLSX?.utils) throw new Error('xlsx 库不可用（找不到 utils）');
      if (typeof D?.Document !== 'function') throw new Error('docx 库不可用（找不到 Document）');
      if (typeof Pptx !== 'function') throw new Error(`pptxgenjs 库不可用（拿到的是 ${typeof Pptx}）`);
      return { XLSX, D, Pptx };
    })();
    libsPromise.catch(() => { libsPromise = null; });
  }
  return libsPromise;
}

// ── 设置 ────────────────────────────────────────────────────────────────────
function num(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function readSettings() {
  let c = {};
  try { c = cfg() || {}; } catch { c = {}; }
  return {
    autoSend: c.autoSend !== false,                 // 默认开
    maxFileMB: num(c.maxFileMB, 12, 1, 100),
    exportDir: String(c.exportDir ?? '').trim(),
    fileNamePrefix: String(c.fileNamePrefix ?? '').trim()
  };
}

async function dataDir() {
  try {
    const mod = await import('../../src/config.js');
    return String(mod.DATA_DIR || '');
  } catch {
    return '';
  }
}

async function exportsDir(settings) {
  const base = settings.exportDir || path.join(await dataDir(), 'exports');
  if (!base) throw new Error('拿不到导出目录（数据目录不可用）');
  await fsp.mkdir(base, { recursive: true });
  return base;
}

// ── 小工具 ──────────────────────────────────────────────────────────────────
function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** 路径转 file:// URI（协议端两种写法都认，发失败会再退回原始路径）。 */
function toFileUri(target) {
  const abs = path.resolve(target).replace(/\\/g, '/');
  return `file:///${abs.split('/').map((seg, i) => (i === 0 ? seg : encodeURIComponent(seg))).join('/')}`;
}

const BAD_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

/** 清洗文件名：去非法字符、去路径穿越、限长、补扩展名、加前缀。 */
function buildFileName(raw, ext, settings) {
  let name = String(raw ?? '').trim();
  name = name.replace(BAD_CHARS, ' ').replace(/\.{2 }/g, '.').replace(/\s+/g, ' ').trim();
  // 去掉首部的点和空格：Windows 下虽合法，但 .xxx / " . . x" 这种名字很难看，
  // 而且点开头在别处会被当隐藏文件
  name = name.replace(/^[.\s]+/, '').trim();
  if (!name) name = `新建文件-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
  // 去掉用户可能已经写上的同扩展名，避免 a.xlsx.xlsx
  name = name.replace(new RegExp(`\\.${ext}$`, 'i'), '');
  if (settings.fileNamePrefix) name = `${settings.fileNamePrefix}${name}`;
  if (name.length > 60) name = name.slice(0, 60);
  return `${name}.${ext}`;
}

/** 同名不覆盖：a.xlsx → a-1.xlsx → a-2.xlsx */
async function uniquePath(dir, fileName) {
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, -ext.length || undefined);
  let candidate = path.join(dir, fileName);
  for (let i = 1; i < 100; i++) {
    try {
      await fsp.access(candidate);
      candidate = path.join(dir, `${stem}-${i}${ext}`);
    } catch {
      return candidate;
    }
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}

/** 断言最终路径仍在导出目录内（防穿越的最后一道闸）。 */
function assertInside(dir, target) {
  const rel = path.relative(path.resolve(dir), path.resolve(target));
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('目标路径越出了导出目录，已拒绝');
  return target;
}

function normalizeCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (v instanceof Date) return v;
  return String(v);
}

function normalizeRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 5000).map((row) => (Array.isArray(row) ? row.slice(0, 200).map(normalizeCell) : [normalizeCell(row)]));
}

/** 估算列宽（中文按 2 个字符宽）。 */
function autoWidths(rows) {
  const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const widths = [];
  for (let c = 0; c < cols; c++) {
    let max = 6;
    for (const row of rows.slice(0, 200)) {
      const text = String(row[c] ?? '');
      const w = [...text].reduce((sum, ch) => sum + (/[\u4e00-\u9fa5]/.test(ch) ? 2 : 1), 0);
      max = Math.max(max, Math.min(50, w + 2));
    }
    widths.push({ wch: max });
  }
  return widths;
}

// ── 发送（复用 pc-control 里验证过的写法）───────────────────────────────────
async function sendToChat(ctx, filePath, name) {
  if (!ctx.chatId) throw new Error('当前会话拿不到会话 id，无法发送文件');
  // 走发送队列：限频 / 去重 / self 留档与普通消息同一套口径。
  if (typeof ctx?.sender?.sendFile === 'function') {
    await ctx.sender.sendFile(ctx.chatKey, filePath, name);
    return;
  }
  if (typeof ctx?.onebot?.call !== 'function') throw new Error('当前会话拿不到协议端接口，无法发送文件');
  const isPrivate = String(ctx.chatKey || '').startsWith('private:');
  const action = isPrivate ? 'upload_private_file' : 'upload_group_file';
  const base = isPrivate ? { user_id: ctx.chatId } : { group_id: ctx.chatId };
  try {
    await ctx.onebot.call(action, { ...base, file: toFileUri(filePath), name }, 120000);
  } catch (error) {
    // 有些协议端不认 file:// URI，退回原始绝对路径再试一次
    try {
      await ctx.onebot.call(action, { ...base, file: path.resolve(filePath), name }, 120000);
    } catch (second) {
      throw new Error(`发送失败：${second?.message || error?.message || second || error}`);
    }
  }
}

/** 生成后的统一收尾：体积检查 → 自动发送 → 返回给模型的话。 */
async function finish(ctx, settings, filePath, label) {
  const stat = await fsp.stat(filePath);
  const name = path.basename(filePath);
  const size = humanSize(stat.size);
  const tooBig = stat.size > settings.maxFileMB * 1024 * 1024;

  if (tooBig) {
    return {
      content: `已生成 ${label}：${name}（${size}），但超过上限 ${settings.maxFileMB}MB，**没有自动发送**。`
        + `文件在：${filePath}`
    };
  }
  if (!settings.autoSend) {
    return { content: `已生成 ${label}：${name}（${size}）。自动发送已关闭，文件在：${filePath}` };
  }
  try {
    await sendToChat(ctx, filePath, name);
    return { content: `已生成并发送 ${label}：${name}（${size}）。发送到当前会话成功，不用再调发送工具。` };
  } catch (error) {
    return {
      content: `已生成 ${label}：${name}（${size}），但发送失败（${error?.message ?? error}）。文件仍在：${filePath}`,
      isError: true
    };
  }
}

// ── 工具：Excel ─────────────────────────────────────────────────────────────
async function makeXlsx(ctx, args, settings) {
  const sheetsIn = Array.isArray(args?.sheets) ? args.sheets : (Array.isArray(args?.rows) ? [{ name: args.sheetName, rows: args.rows }] : []);
  if (!sheetsIn.length) return { content: '没有给表格数据：sheets 里至少要有一张表（rows 是二维数组）。', isError: true };
  const { XLSX } = await loadLibs();

  const dir = await exportsDir(settings);
  const fileName = buildFileName(args?.fileName ?? args?.name ?? '表格', 'xlsx', settings);
  const filePath = assertInside(dir, await uniquePath(dir, fileName));

  const wb = XLSX.utils.book_new();
  const usedNames = new Set();
  sheetsIn.slice(0, 20).forEach((sheet, i) => {
    const rows = normalizeRows(sheet?.rows);
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = Array.isArray(sheet?.widths) && sheet.widths.length
      ? sheet.widths.map((w) => ({ wch: num(w, 12, 4, 80) }))
      : autoWidths(rows);
    let sheetName = String(sheet?.name ?? `Sheet${i + 1}`).replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || `Sheet${i + 1}`;
    while (usedNames.has(sheetName)) sheetName = `${sheetName.slice(0, 28)}~${i}`;
    usedNames.add(sheetName);
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  });
  XLSX.writeFile(wb, filePath);
  return finish(ctx, settings, filePath, 'Excel 表格');
}

// ── 工具：Word ──────────────────────────────────────────────────────────────
function headingLevel(D, level) {
  const n = num(level, 1, 1, 6);
  return [D.HeadingLevel.HEADING_1, D.HeadingLevel.HEADING_2, D.HeadingLevel.HEADING_3,
    D.HeadingLevel.HEADING_4, D.HeadingLevel.HEADING_5, D.HeadingLevel.HEADING_6][n - 1] || D.HeadingLevel.HEADING_1;
}

function docxTable(D, rows) {
  const data = normalizeRows(rows).slice(0, 200);
  if (!data.length) return null;
  const cols = data.reduce((m, r) => Math.max(m, r.length), 0);
  return new D.Table({
    width: { size: 100, type: D.WidthType.PERCENTAGE },
    rows: data.map((row) => new D.TableRow({
      children: Array.from({ length: cols }, (_, c) => new D.TableCell({
        children: [new D.Paragraph({ children: [new D.TextRun({ text: String(row[c] ?? ''), size: 20 })] })]
      }))
    }))
  });
}

async function makeDocx(ctx, args, settings) {
  const blocksIn = Array.isArray(args?.blocks) ? args.blocks
    : (Array.isArray(args?.paragraphs) ? args.paragraphs.map((p) => ({ type: 'paragraph', text: p })) : []);
  if (!blocksIn.length) return { content: '没有给内容：blocks 里至少要有 1 个段落/标题/表格。', isError: true };
  const { D } = await loadLibs();

  const dir = await exportsDir(settings);
  const fileName = buildFileName(args?.fileName ?? args?.name ?? args?.title ?? '文档', 'docx', settings);
  const filePath = assertInside(dir, await uniquePath(dir, fileName));

  const children = [];
  for (const block of blocksIn.slice(0, 500)) {
    const type = String(block?.type ?? 'paragraph').toLowerCase();
    const text = String(block?.text ?? block?.content ?? '');
    if (type === 'heading' || type === 'title') {
      children.push(new D.Paragraph({ text, heading: headingLevel(D, block?.level ?? (type === 'title' ? 1 : 2)) }));
    } else if (type === 'bullet' || type === 'list') {
      children.push(new D.Paragraph({ text, bullet: { level: num(block?.level, 0, 0, 4) } }));
    } else if (type === 'table') {
      const table = docxTable(D, block?.rows);
      if (table) children.push(table);
    } else if (type === 'pagebreak' || type === 'page-break') {
      children.push(new D.Paragraph({ children: [new D.PageBreak()] }));
    } else {
      children.push(new D.Paragraph({ children: [new D.TextRun({ text, size: 22 })] }));
    }
  }
  const doc = new D.Document({ sections: [{ properties: {}, children }] });
  const buffer = await D.Packer.toBuffer(doc);
  await fsp.writeFile(filePath, buffer);
  return finish(ctx, settings, filePath, 'Word 文档');
}

// ── 工具：PowerPoint ────────────────────────────────────────────────────────
async function makePptx(ctx, args, settings) {
  const slidesIn = Array.isArray(args?.slides) ? args.slides : [];
  if (!slidesIn.length) return { content: '没有给幻灯片内容：slides 里至少要有 1 页。', isError: true };
  const { Pptx } = await loadLibs();

  const dir = await exportsDir(settings);
  const fileName = buildFileName(args?.fileName ?? args?.name ?? args?.title ?? '演示文稿', 'pptx', settings);
  const filePath = assertInside(dir, await uniquePath(dir, fileName));

  const pptx = new Pptx();
  pptx.layout = 'LAYOUT_16x9';
  if (args?.title) pptx.title = String(args.title);

  for (const spec of slidesIn.slice(0, 80)) {
    const slide = pptx.addSlide();
    const title = String(spec?.title ?? '').trim();
    if (title) {
      slide.addText(title, { x: 0.55, y: 0.32, w: 9, h: 0.9, fontSize: 30, bold: true, color: '1F3864' });
    }
    const bullets = (Array.isArray(spec?.bullets) ? spec.bullets : (Array.isArray(spec?.lines) ? spec.lines : []))
      .map((b) => String(b ?? '').trim()).filter(Boolean).slice(0, 20);
    if (bullets.length) {
      slide.addText(
        bullets.map((text) => ({ text, options: { bullet: true, breakLine: true } })),
        { x: 0.7, y: title ? 1.35 : 0.6, w: 8.8, h: 4.7, fontSize: 18, color: '333333', valign: 'top' }
      );
    }
    if (spec?.notes) {
      try { slide.addNotes(String(spec.notes)); } catch { /* 备注失败不影响正文 */ }
    }
  }
  await pptx.writeFile({ fileName: filePath });
  return finish(ctx, settings, filePath, 'PowerPoint 演示文稿');
}

// ── 工具：纯文本 / CSV ──────────────────────────────────────────────────────
const BOM = '\uFEFF';   // UTF-8 BOM：Excel 打开 CSV 靠它认编码，否则中文乱码

/** 统一换行成 CRLF（Windows 记事本、Excel 都最稳），并保证结尾有换行。 */
function normalizeTextEndings(text) {
  let out = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n');
  if (out && !out.endsWith('\r\n')) out += '\r\n';
  return out;
}

/**
 * 只把**记录分隔符**换成 CRLF，引号内的换行原样保留。
 *
 * 为什么不能直接对整份 CSV 做 replace：那会把「引号内本来就有的换行」也改掉 = 篡改数据。
 * 为什么不能给 sheet_to_csv 传 RS='\r\n'：SheetJS 判断"要不要给字段加引号"用的是
 * RS 的值 —— 改成 CRLF 后，字段里只有 \n 就不再被引号包住，CSV 直接被写坏
 * （实测：Python 的 csv 模块会把它读成两行）。所以先让它用默认 RS 生成（引号正确），
 * 再只在引号外把 \n 换成 \r\n。
 */
function toCrlfRecords(csv) {
  const src = String(csv ?? '');
  let out = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"') {
      if (inQuotes && src[i + 1] === '"') { out += '""'; i++; continue; }   // 转义的双引号
      inQuotes = !inQuotes;
      out += ch;
      continue;
    }
    if (inQuotes) { out += ch; continue; }
    if (ch === '\r') continue;                    // 已有 CR 丢掉，避免出现 \r\r\n
    if (ch === '\n') { out += '\r\n'; continue; }
    out += ch;
  }
  return out;
}

async function writePlainFile(ctx, settings, { fileName, content, ext, label }) {
  const dir = await exportsDir(settings);
  const name = buildFileName(fileName, ext, settings);
  const filePath = assertInside(dir, await uniquePath(dir, name));
  await fsp.writeFile(filePath, content, 'utf8');
  return finish(ctx, settings, filePath, label);
}

async function makeTxt(ctx, args, settings) {
  let content = '';
  if (typeof args?.text === 'string' && args.text.length) {
    content = args.text;
  } else if (typeof args?.content === 'string' && args.content.length) {
    content = args.content;
  } else if (Array.isArray(args?.lines)) {
    content = args.lines.map((l) => String(l ?? '')).join('\n');
  }
  if (!content.trim()) {
    return { content: '没有内容：传 text（整段文字）或 lines（按行的字符串数组）。', isError: true };
  }
  content = normalizeTextEndings(content);
  // 默认不带 BOM（纯文本更通用）；要兼容很老的记事本/Excel 可以传 bom:true
  const body = (args?.bom === true ? BOM : '') + content;
  return writePlainFile(ctx, settings, {
    fileName: args?.fileName ?? args?.name ?? '文本',
    content: body,
    ext: 'txt',
    label: '文本文件'
  });
}

async function makeCsv(ctx, args, settings) {
  let csv = '';
  if (typeof args?.text === 'string' && args.text.trim()) {
    // 用户给的现成 CSV：原样保留（不碰字段内部换行），只在结尾补一个换行
    csv = String(args.text);
  } else {
    const rows = Array.isArray(args?.rows) ? args.rows
      : (Array.isArray(args?.sheets?.[0]?.rows) ? args.sheets[0].rows : null);
    if (!rows) return { content: '没有数据：传 rows（二维数组）或 text（现成的 CSV 文本）。', isError: true };
    const { XLSX } = await loadLibs();
    const ws = XLSX.utils.aoa_to_sheet(normalizeRows(rows));
    const delim = String(args?.delimiter ?? ',').slice(0, 1) || ',';
    // 用 SheetJS 出 CSV：逗号/引号/换行/中文的转义都由它处理，比自己拼字符串靠谱。
    // ⚠️ 不要给它传 RS='\r\n'（会破坏引号判定，字段内换行就不被包住 → CSV 被读成多行）。
    // 先用默认 RS 生成保证引号正确，再用 toCrlfRecords 把记录分隔符换成 CRLF。
    csv = XLSX.utils.sheet_to_csv(ws, { FS: delim, blankrows: false });
  }
  csv = toCrlfRecords(csv);
  if (csv && !/\r\n$/.test(csv)) csv += '\r\n';
  // 默认带 BOM：Excel 双击打开中文不乱码（这是最常见的坑）；要干净 UTF-8 传 bom:false
  const body = (args?.bom === false ? '' : BOM) + csv;
  return writePlainFile(ctx, settings, {
    fileName: args?.fileName ?? args?.name ?? '数据',
    content: body,
    ext: 'csv',
    label: 'CSV 表格'
  });
}

// ── 工具：发送已有文件 ──────────────────────────────────────────────────────
async function sendExistingFile(ctx, args, settings) {
  const raw = String(args?.fileName ?? args?.file ?? args?.path ?? '').trim();
  if (!raw) return { content: '要发哪个文件？传 fileName（导出目录里的文件名或绝对路径）。', isError: true };
  const dir = await exportsDir(settings);
  const target = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(dir, path.basename(raw));
  assertInside(dir, target);
  let stat;
  try { stat = await fsp.stat(target); } catch { return { content: `导出目录里找不到：${path.basename(target)}`, isError: true }; }
  if (!stat.isFile()) return { content: '这不是一个文件。', isError: true };
  if (stat.size > settings.maxFileMB * 1024 * 1024) {
    return { content: `文件 ${humanSize(stat.size)} 超过上限 ${settings.maxFileMB}MB，未发送。`, isError: true };
  }
  try {
    await sendToChat(ctx, target, path.basename(target));
    return { content: `已发送：${path.basename(target)}（${humanSize(stat.size)}）` };
  } catch (error) {
    return { content: `发送失败：${error?.message ?? error}`, isError: true };
  }
}

// ── 注册 ────────────────────────────────────────────────────────────────────
export function setup(apiRef) {
  api = apiRef;
  cfg = apiRef.config || (() => ({}));
  const log = apiRef.log || (() => {});
  log('Office 文档生成技能已加载（xlsx / docx / pptxgenjs）');

  api.registerTool({
    id: 'make_xlsx',
    name: '生成 Excel 表格',
    description: '把数据做成真正的 .xlsx 文件并（默认）直接发到当前会话。用户说"做个表格/Excel/报表/清单/统计表"时用。'
      + '参数：sheets 是数组，每张表 { name, rows }，rows 是二维数组（第一行通常当表头）；也可只传一张表的 rows。'
      + '单元格支持字符串/数字/布尔。生成后不用再调发送工具。',
    category: 'system',
    icon: '📊',
    parameters: {
      type: 'object',
      properties: {
        fileName: { type: 'string', description: '文件名（可不带 .xlsx；同名不覆盖，会自动加 -1）' },
        sheets: {
          type: 'array',
          description: '工作表数组',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '工作表名（≤31 字）' },
              rows: { type: 'array', items: { type: 'array', items: {} }, description: '二维数组数据' },
              widths: { type: 'array', items: { type: 'number' }, description: '可选：每列宽度' }
            },
            required: ['rows']
          }
        },
        rows: { type: 'array', items: { type: 'array', items: {} }, description: '只做一张表时的快捷写法（二维数组）' }
      }
    },
    async execute(ctx, args) {
      try {
        return await makeXlsx(ctx, args || {}, readSettings());
      } catch (error) {
        return { content: `生成 Excel 失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'make_docx',
    name: '生成 Word 文档',
    description: '把内容做成真正的 .docx 文件并（默认）直接发到当前会话。用户说"写个文档/报告/通知/方案/总结"时用。'
      + '参数 blocks 是块数组：{type:"heading"|"paragraph"|"bullet"|"table"|"pagebreak", text?/level?/rows?}。'
      + 'table 用 rows（二维数组，第一行当表头）。生成后不用再调发送工具。',
    category: 'system',
    icon: '📄',
    parameters: {
      type: 'object',
      properties: {
        fileName: { type: 'string', description: '文件名（可不带 .docx）' },
        blocks: {
          type: 'array',
          description: '内容块',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', description: 'heading / paragraph / bullet / table / pagebreak' },
              text: { type: 'string' },
              level: { type: 'integer', description: 'heading 层级 1~6；bullet 缩进 0~4' },
              rows: { type: 'array', items: { type: 'array', items: {} }, description: 'table 的数据' }
            }
          }
        },
        paragraphs: { type: 'array', items: { type: 'string' }, description: '只要纯段落的快捷写法' }
      }
    },
    async execute(ctx, args) {
      try {
        return await makeDocx(ctx, args || {}, readSettings());
      } catch (error) {
        return { content: `生成 Word 失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'make_pptx',
    name: '生成 PowerPoint',
    description: '把大纲做成真正的 .pptx 并（默认）直接发到当前会话。用户说"做个PPT/幻灯片/演示文稿/汇报"时用。'
      + '参数 slides 是页数组：{ title, bullets:[...], notes? }，每页标题 + 若干要点。生成后不用再调发送工具。',
    category: 'system',
    icon: '📽️',
    parameters: {
      type: 'object',
      properties: {
        fileName: { type: 'string', description: '文件名（可不带 .pptx）' },
        title: { type: 'string', description: '文档标题（写入文件属性）' },
        slides: {
          type: 'array',
          description: '幻灯片页数组，每页 { title, bullets:[...], notes? }',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: '本页标题' },
              bullets: { type: 'array', items: { type: 'string' }, description: '本页要点' },
              notes: { type: 'string', description: '可选：演讲者备注' }
            }
          }
        }
      },
      required: ['slides']
    },
    async execute(ctx, args) {
      try {
        return await makePptx(ctx, args || {}, readSettings());
      } catch (error) {
        return { content: `生成 PPT 失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'make_txt',
    name: '生成文本文件',
    description: '把文字做成 .txt 并（默认）直接发到当前会话。用户说"存成 txt / 导出成文本文件 / 给我个纯文本"时用。'
      + '参数：text（整段文字）或 lines（按行的数组，推荐——每行一条更可控）。换行统一成 Windows 的 CRLF。'
      + '默认不带 BOM；要兼容很老的记事本/Excel 可传 bom:true。生成后不用再调发送工具。',
    category: 'system',
    icon: '📝',
    parameters: {
      type: 'object',
      properties: {
        fileName: { type: 'string', description: '文件名（可不带 .txt）' },
        text: { type: 'string', description: '整段文字（和 lines 二选一）' },
        lines: { type: 'array', items: { type: 'string' }, description: '按行给（推荐，和 text 二选一）' },
        bom: { type: 'boolean', description: '可选：是否加 UTF-8 BOM，默认 false' }
      }
    },
    async execute(ctx, args) {
      try {
        return await makeTxt(ctx, args || {}, readSettings());
      } catch (error) {
        return { content: `生成 txt 失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'make_csv',
    name: '生成 CSV 表格',
    description: '把数据做成 .csv 并（默认）直接发到当前会话。用户说"导出 CSV / 给我个 csv / 表格数据要导入"时用。'
      + '参数：rows（二维数组，第一行当表头）或 text（现成 CSV 文本）；delimiter 可换分隔符。'
      + '**默认写 UTF-8 BOM**，这样 Excel 双击打开中文不乱码；要干净 UTF-8 传 bom:false。'
      + '逗号、引号、换行、中文的转义都由库处理，不用你手动加引号。生成后不用再调发送工具。',
    category: 'system',
    icon: '📑',
    parameters: {
      type: 'object',
      properties: {
        fileName: { type: 'string', description: '文件名（可不带 .csv）' },
        rows: { type: 'array', items: { type: 'array', items: {} }, description: '二维数组数据（第一行当表头）' },
        text: { type: 'string', description: '可选：现成的 CSV 文本（和 rows 二选一）' },
        delimiter: { type: 'string', description: '可选：分隔符，默认英文逗号' },
        bom: { type: 'boolean', description: '可选：是否加 UTF-8 BOM，默认 true（Excel 友好）' }
      }
    },
    async execute(ctx, args) {
      try {
        return await makeCsv(ctx, args || {}, readSettings());
      } catch (error) {
        return { content: `生成 csv 失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'send_file',
    name: '发送文件',
    description: '把导出目录里已有的文件再发一次（比如关掉了自动发送、或者用户想重发）。参数 fileName 传文件名或绝对路径（必须在导出目录内）。',
    category: 'system',
    icon: '📎',
    parameters: {
      type: 'object',
      properties: { fileName: { type: 'string', description: '导出目录里的文件名，或导出目录内的绝对路径' } },
      required: ['fileName']
    },
    async execute(ctx, args) {
      try {
        return await sendExistingFile(ctx, args || {}, readSettings());
      } catch (error) {
        return { content: `发送失败：${error?.message ?? error}`, isError: true };
      }
    }
  });
}

export function activate() {}
export function deactivate() {}
export function dispose() {}

/** 可用性自检：必须同步、不联网。 */
export function available() {
  const s = readSettings();
  return { ok: true, reason: s.autoSend ? '' : '自动发送已关闭（只生成，不发送）' };
}

export function promptSections() {
  return [{
    id: 'office-export-rules',
    priority: 60,
    content: '用户要"表格 / Excel / 报表 / 清单 / 统计"时用 make_xlsx（sheets 里 rows 传二维数组，第一行当表头）；'
      + '要"csv / 导入表格的数据"时用 make_csv（rows 传二维数组，默认带 BOM 让 Excel 不乱码）；'
      + '要"txt / 纯文本 / 文本文件"时用 make_txt（lines 每行一条最省事）；'
      + '要"文档 / 报告 / 通知 / 方案 / 总结 / 合同"时用 make_docx（blocks 用 heading/paragraph/bullet/table 组织）；'
      + '要"PPT / 幻灯片 / 演示文稿 / 汇报"时用 make_pptx（slides 每页一个 title + bullets）。'
      + '这几个工具会生成**真正的文件**并直接发到当前会话，所以：'
      + '① 数据要你自己整理完整后一次传进去，不要只发一半；② 生成成功后**不需要**再调 send_message 说"我做了一个文件"，'
      + '直接告诉用户你做了什么、几点内容即可；③ 一次只做一个文件，别连环生成；'
      + '④ 用户没说要文件、只是让你"列一下"时，正常用文字回答，不要擅自生成附件。'
  }];
}
