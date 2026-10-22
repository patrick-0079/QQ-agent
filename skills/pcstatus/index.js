// 电脑状态（pcstatus）—— LLM 型 Skill（skills/），注册工具交给模型按需调用。
//
// 为什么是 Skill 而不是插件（plugins/）：
//   plugins/ 是"确定性型"——必须 export providers / hooks，由核心代码在固定时机调用。
//   本功能是"群友问 → 机器人去查"，什么时候该触发由模型理解人话后决定，
//   没有任何核心代码会在固定时机调用它。放进 plugins/ 会被加载器判定为
//   "没有提供能力或钩子"，功能静默失效（不报错，就是永远不触发）。
//   判据（项目 README「扩展（两型：插件 / Skill）」）：规则能写死 → 插件；要理解人话 → 技能。
//
// 数据采集与出图（纯 Node，不含任何 PowerShell —— 市场打包校验禁止打包脚本类文件）：
//   · 采集走 Windows 自带的 typeperf（性能计数器）、reg（读显卡名）与 node:os / fs.statfs；
//   · 卡片用 HTML 拼装，交给应用自带的 Electron 离屏窗口截图成 PNG，再经会话发送；
//   · 背景图用 Electron nativeImage 裁切缩放，不需要任何外部图片库。
//   详细口径与踩过的坑见下方「采集层」注释。

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── 卡片尺寸相关常量 ──────────────────────────────────────────────────────
// ⚠️ 这几个原先定义在"背景图准备"那一段里，改造采集层时随那一段一起被替换掉了，
//    结果 CARD_W / HEIGHT_SLACK 变成未定义（运行时直接 ReferenceError，卡片全废）。
//    现在提到这里，采集层与渲染层共用。
const CROP_FACE_SHIFT = 0.05;   // 裁切窗口相对正中再上移的比例，多留头顶
const CARD_W = 520;             // 卡片宽度（CSS 像素）
const CARD_PAD_TOP = 84;        // 面板上方留出的照片高度
const CARD_PAD_BOTTOM = 42;     // 面板下方留出的照片高度
// 定窗高度比量到的内容高度多留这么多像素：宁可多一条背景边，
// 也不能让内容贴边溢出——差几像素就会在截图里出现滚动条或被裁掉（用户实拍反馈过）。
const HEIGHT_SLACK = 40;


/** 把函数体里没注册进 API 的字段补上默认值（避免 manifest 少写一项就崩）。 */
const DEFAULTS = {
  topN: 8,
  topListInCompact: 2,

  timeoutMs: 20000,
  replyStyle: 'card',
  // card = 出图（画不出来时自动退回文字）；text = 一开始就不画图，只发文字。
  // 留这个开关是因为"画图"依赖应用的 Electron 环境，个别环境下画不出来；
  // 想要稳定就走 text，不用等兜底。
  sendAs: 'card',
  // 默认浅色：配浅色壁纸更搭
  cardTheme: 'light',
  backgroundImage: '',
  // ── 卡片呈现 ──────────────────────────────────────────────────────────
  // 精简：只出"系统 + 硬件 + 软件占用"三块；详细：再补系统 Build、CPU 型号全称、
  // 显卡型号/显存/驱动、硬盘型号、可用内存等。
  detailLevel: 'brief',
  opacity: 55,            // 面板与分框的不透明度（0=全透、100=不透明）
  displayMode: 'ring',    // ring = 圆环；bar = 横条（全局默认，下面四项可各自覆盖）
  // ── 每一项硬件单独选圆环或横条 ────────────────────────────────────────
  // 'same' = 跟随上面的全局选择；也可以单独指定 ring / bar。
  modeCpu: 'same',
  modeMem: 'same',
  modeDisk: 'same',
  modeGpu: 'same',
  // ── 显示哪些内容 ──────────────────────────────────────────────────────
  showOs: true,
  showCpuInfo: true,
  showCpu: true,
  showMem: true,
  showDisk: true,
  showProcs: true,
  showQQAgent: true,
  showSelfProc: true,     // 是否显示本进程自身那一块
  // 本进程那一块的标题。默认写清楚它是"运行机器人的应用进程"，
  // 免得和「QQ Agent 自身（全部进程合计）」读起来像同一件事。
  selfProcLabel: 'process',
  // GPU 相关：占用要额外跑一次 GPU 引擎计数器（约 +1 秒），所以单独开关
  showGpu: false,         // 在"系统"框里显示显卡型号（随详细模式一起出现）
  showGpuUsage: false,    // 单独给显卡占用开一块（勾上才采集）
  // 虚拟显示器（远程串流那一类）不是真显卡，占用挂在上面让人看不懂，默认隐藏
  hideVirtualGpu: true
};

let cfgOf = () => ({});

/** 技能 API 句柄：日志与失败告警用（setup 时赋值）。 */
let api = null;

/** 记录一条技能日志；没装 api 时静默（便于单独跑测试脚本）。 */
function note(...args) {
  try { api?.log?.(...args); } catch { /* 日志失败绝不能影响主流程 */ }
}

function warn(...args) {
  try { api?.warn?.(...args); } catch { /* 同上 */ }
}


function num(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/** 从输出里截出第一段配平的 JSON。前后若有告警/报错文本都不影响。 */

/** 从输出里截出第一段配平的 JSON。前后若有告警/报错文本都不影响。 */
function firstJson(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/** 把秒数说成人话：2天3小时18分钟。 */

/** 把秒数说成人话：2天3小时18分钟。 */
function zhDur(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}天${h}小时${m}分钟`;
  if (h > 0) return `${h}小时${m}分钟`;
  if (m > 0) return `${m}分钟`;
  return `${s}秒`;
}


function gb(mb) {
  const n = Number(mb);
  if (!Number.isFinite(n)) return '?';
  return (n / 1024).toFixed(1);
}

/**
 * 统一把"可能是数组、可能只有一个元素、也可能是 null"的字段掰成数组再遍历。
 * 采集层换了实现，但这个防御仍然必要：单个盘/单块显卡的情况到处都是，
 * 而 JSON 序列化会把"只有一个元素的数组"折叠成对象、空数组折叠成 null。
 */
function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v === null || v === undefined) return [];
  if (typeof v === 'object') return [v];
  return [v];
}

/** 时间戳（毫秒）→ 本地时间 yyyy-MM-dd HH:mm。 */

/** 时间戳（毫秒）→ 本地时间 yyyy-MM-dd HH:mm。 */
function zhClock(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '不可用';
  const d = new Date(n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 单个程序的多进程聚合行：Chrome（7 个进程，共 1100MB，最早启动于 …，已运行 …）。 */

/** 单个程序的多进程聚合行：Chrome（7 个进程，共 1100MB，最早启动于 …，已运行 …）。 */
function appLine(a) {
  if (!a || typeof a !== 'object') return '';
  const n = String(a.n ?? '未知');
  const count = Number(a.count) || 1;
  const mem = Number(a.memMB) || 0;
  const bits = [`${n}（${count} 个进程，共 ${mem} MB`];
  const st = Number(a.start) || 0;
  if (st > 0) {
    const sec = (Date.now() - st) / 1000;
    bits.push(`最早启动于 ${zhClock(st)}，已运行 ${zhDur(sec)}`);
  }
  return `${bits.join('，')}）`;
}

/** 简短版专用：一句话说清"占多少内存、跑了多久"，不带进程数和启动时刻。 */

/** 简短版专用：一句话说清"占多少内存、跑了多久"，不带进程数和启动时刻。 */
function qaLine(a) {
  if (!a || typeof a !== 'object') return '';
  const mem = Number(a.memMB) || 0;
  const st = Number(a.start) || 0;
  const count = Number(a.count) || 1;
  const bits = [`${mem} MB`];
  if (count > 1) bits.push(`${count} 个进程`);
  if (st > 0) bits.push(`已运行 ${zhDur((Date.now() - st) / 1000)}`);
  return bits.join(' · ');
}

// ── 背景图准备 ────────────────────────────────────────────────────────────
//
// 不用 CSS 的 background-position 去"猜"取景：壁纸通常是竖图，按宽扁卡片铺满时
// 只能看到中间一条，靠百分比调位置完全是试错（实测人脸被裁在画面外两次）。
// 改成**按卡片实际比例精确裁切**，人物脸部固定落在画面上部（见 CROP_FACE_SHIFT）。
//
// 顺带在这里把图缩到卡片尺寸：默认那张 645×806 的壁纸转 base64 是 191KB，
// 缩完约 60KB，卡片 HTML 从约 200KB 降到约 70KB，离屏窗口压力小很多。

// ===========================================================================
// 采集层（纯 Node 实现，不含任何 PowerShell）
//
// 为什么改成这样：技能市场的打包校验禁止可执行/脚本类文件
//   （market.js 与 zip-install.js 共用 \.(exe|dll|bat|cmd|ps1|vbs|sh)$ 这条规则），
//   上一版把采集脚本作为一个独立脚本文件放进包里，因此过不了上传。
//   现在整条采集与出图链路只用 Node.js + Windows 自带命令行接口：
//
//   CPU（整机 + 每核）  typeperf '\Processor(*)\% Processor Time'
//   进程内存 / 已运行    typeperf '\Process(*)\Working Set' + '\Process(*)\Elapsed Time'
//   GPU 占用            typeperf '\GPU Engine(*)\Utilization Percentage'（取引擎最大值）
//   内存 / 开机时长      node:os（totalmem / freemem / uptime）
//   硬盘容量            fs.statfs（只报当前真实挂载的盘）
//   系统版本            node:os（version / release）
//   显卡型号            reg query 驱动键的 DriverDesc（REG_SZ 普通字符串）
//   背景图裁切          Electron nativeImage（crop + resize + toJPEG）
//
// ⚠️ 踩过的坑（都不要再犯）：
//   1. `\Process(*)\Elapsed Time` 的单位是**秒**（实测 337901 = 3.91 天），
//      当初误按 100ns 除以 1e7，结果全变 0；
//   2. **不要把多组计数器合并到一次 typeperf 调用**：实测合并后表头 371 列、数据 374 列，
//      列会错位（进程名含引号会破坏简单切分），算出的 GPU 占用是天文数字。一次一组才稳；
//   3. `_Total` 是性能计数器给的"所有进程合计"那一行，不是真进程 ——
//      不排掉它会稳稳霸占"最占内存"榜首；
//   4. Electron 模块只能在**应用自己的主进程**里 import；普通 node/独立 electron 进程
//      里会报 Cannot find module，所以拿不到时必须优雅退回，不能让整张卡片失败。
// ===========================================================================

/** 跑一条命令并取回 stdout；失败一律返回 null，绝不抛。 */
function runCapture(cmd, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 128 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? null : String(stdout || ''));
    });
  });
}

/**
 * 解析 typeperf 的 CSV：返回 [{ header, value }]（跳过第一列时间戳）。
 * 用逐字段扫描而不是正则 —— 字段里可能带转义引号，正则会把列切错。
 * 表头与数据列数不一致时返回 null：宁可放弃这一组，也不要错位算出荒谬数字。
 */
function parseTypeperf(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.startsWith('"'));
  if (lines.length < 2) return null;

  const fields = (line) => {
    const res = [];
    let i = 0;
    while (i < line.length) {
      if (line[i] !== '"') { i++; continue; }
      i++;
      let buf = '';
      while (i < line.length) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') { buf += '"'; i += 2; continue; }
          i++;
          break;
        }
        buf += line[i];
        i++;
      }
      res.push(buf);
    }
    return res;
  };

  const head = fields(lines[0]);
  const val = fields(lines[1]);
  if (!head.length || head.length !== val.length) return null;
  const pairs = [];
  for (let i = 1; i < head.length; i++) pairs.push({ header: head[i], value: Number(val[i]) });
  return pairs;
}

/** 从 typeperf 表头抠出计数器实例：\\机器\类(实例)\计数器。 */
function counterInstance(header) {
  const m = /\\\\([^\\]+)\\([^(]+)\(([^)]*)\)\\([^\\]+)$/.exec(String(header));
  return m ? { cls: m[2], inst: m[3], counter: m[4] } : null;
}

/** CPU 占用：整机与每核（一次 typeperf）。 */
async function readCpu(timeoutMs) {
  const txt = await runCapture('typeperf', ['-sc', '1', '\\Processor(*)\\% Processor Time'], timeoutMs);
  const pairs = txt ? parseTypeperf(txt) : null;
  if (!pairs) return { usedPct: -1, coreCount: 0, coreMax: 0, coreAvg: 0 };
  let total = -1;
  const cores = [];
  for (const p of pairs) {
    const c = counterInstance(p.header);
    if (!c) continue;
    const v = Math.max(0, Math.min(100, Math.round(p.value)));
    if (c.inst === '_Total') total = v;
    else cores.push(v);
  }
  if (total < 0 && cores.length) total = Math.round(cores.reduce((x, y) => x + y, 0) / cores.length);
  return {
    usedPct: total,
    coreCount: cores.length,
    coreMax: cores.length ? Math.max(...cores) : 0,
    coreAvg: cores.length ? Math.round(cores.reduce((x, y) => x + y, 0) / cores.length) : 0
  };
}

/** 进程快照：名字 / 内存 / 已运行秒数（两次 typeperf，各自对齐）。 */
async function readProcesses(timeoutMs) {
  const [wsTxt, elTxt] = await Promise.all([
    runCapture('typeperf', ['-sc', '1', '\\Process(*)\\Working Set'], timeoutMs),
    runCapture('typeperf', ['-sc', '1', '\\Process(*)\\Elapsed Time'], timeoutMs)
  ]);
  const wsPairs = wsTxt ? parseTypeperf(wsTxt) : null;
  const elPairs = elTxt ? parseTypeperf(elTxt) : null;
  const elapsed = new Map();
  if (elPairs) {
    for (const p of elPairs) {
      const c = counterInstance(p.header);
      // ⚠️ Elapsed Time 单位就是秒，不要再换算
      if (c && Number.isFinite(p.value)) elapsed.set(c.inst, p.value);
    }
  }
  const rows = [];
  if (wsPairs) {
    for (const p of wsPairs) {
      const c = counterInstance(p.header);
      if (!c || !Number.isFinite(p.value)) continue;
      if (c.inst === '_Total') continue;                              // 不是真进程
      if (String(c.inst).toLowerCase() === 'idle') continue;
      rows.push({
        n: c.inst.replace(/#\d+$/, ''),
        inst: c.inst,
        memMB: Math.round((p.value / 1024 / 1024) * 10) / 10,
        elapsedSec: elapsed.has(c.inst) ? elapsed.get(c.inst) : -1
      });
    }
  }
  return rows;
}

/** 按程序名聚合：同一程序多个进程合成一条，start 取最早启动那个。 */
function aggregateProcesses(rows) {
  const byName = new Map();
  let totalMemMB = 0;
  for (const r of rows) {
    totalMemMB += Number(r.memMB) || 0;
    if (!byName.has(r.n)) byName.set(r.n, { n: r.n, count: 0, memMB: 0, earliestSec: -1 });
    const a = byName.get(r.n);
    a.count++;
    a.memMB += Number(r.memMB) || 0;
    if (r.elapsedSec >= 0 && r.elapsedSec > a.earliestSec) a.earliestSec = r.elapsedSec;
  }
  const now = Date.now();
  const apps = [...byName.values()].map((a) => ({
    n: a.n,
    count: a.count,
    memMB: Math.round(a.memMB * 10) / 10,
    // elapsed 越大 = 启动越早；换成时间戳交给上层（上层按 start 算"已运行多久"）
    start: a.earliestSec >= 0 ? Math.round(now - a.earliestSec * 1000) : 0
  }));
  apps.sort((a, b) => b.memMB - a.memMB);
  return { total: rows.length, memMB: Math.round(totalMemMB), apps };
}

/** GPU 占用：所有引擎里的最大值（与任务管理器口径接近）。 */
async function readGpu(timeoutMs) {
  const txt = await runCapture('typeperf', ['-sc', '1', '\\GPU Engine(*)\\Utilization Percentage'], timeoutMs);
  const pairs = txt ? parseTypeperf(txt) : null;
  if (!pairs) return { usedPct: -1, engines: 0 };
  let max = -1;
  let engines = 0;
  for (const p of pairs) {
    if (!/GPU Engine\(/.test(p.header)) continue;
    engines++;
    if (Number.isFinite(p.value) && p.value > max) max = p.value;
  }
  if (max < 0) return { usedPct: -1, engines };
  return { usedPct: Math.max(0, Math.min(100, Math.round(max))), engines };
}

/** 是不是真实显卡（虚拟显示驱动不带这些厂商关键字）。 */
function isPhysicalGpu(name) {
  return /NVIDIA|Radeon|GeForce|Quadro|Intel\(R\)|AMD|Arc|UHD|Iris|RTX|GTX/i.test(String(name || ''));
}

/** 显卡型号：读驱动键的 DriverDesc（REG_SZ）。 */
async function readGpuNames(timeoutMs) {
  const txt = await runCapture('reg', [
    'query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}',
    '/s', '/v', 'DriverDesc'
  ], Math.min(timeoutMs, 20000));
  if (!txt) return [];
  const names = [];
  for (const line of txt.split(/\r?\n/)) {
    const m = /DriverDesc\s+REG_SZ\s+(.+)$/.exec(line);
    if (m && m[1].trim()) names.push(m[1].trim());
  }
  return [...new Set(names)];
}

/** 当前真实挂载的盘符与容量（只报能 statfs 到的）。 */
async function readDisks() {
  const disks = [];
  for (let i = 67; i <= 90; i++) {
    const L = String.fromCharCode(i);
    const root = `${L}:\\`;
    try {
      const st = await fs.promises.statfs(root);
      const size = st.blocks * st.bsize;
      const free = st.bfree * st.bsize;
      if (!size) continue;
      disks.push({
        id: `${L}:`,
        sizeGB: Math.round((size / 1024 ** 3) * 10) / 10,
        freeGB: Math.round((free / 1024 ** 3) * 10) / 10,
        usedGB: Math.round(((size - free) / 1024 ** 3) * 10) / 10,
        freePct: Math.round((free / size) * 100),
        model: ''
      });
    } catch { /* 该盘符不存在 */ }
  }
  return disks;
}

/** 系统版本：os.version() 已给可读名，再补 build 号。 */
function readOs() {
  let caption = '';
  try { caption = String(os.version() || '').trim(); } catch { caption = ''; }
  const rel = String(os.release() || '');
  const build = Number(rel.split('.')[2] || 0);
  if (!/Windows\s*\d/i.test(caption)) {
    const fam = build >= 22000 ? 'Windows 11' : build >= 10240 ? 'Windows 10' : 'Windows';
    caption = caption ? `${fam}（${caption}）` : fam;
  }
  return { os: caption, osBuild: rel ? `Build ${rel}` : '' };
}

// 中文名 / 常用叫法 → 真实进程名前缀（与上一版保持同一张表）。
// ⚠️ 查表前会把键小写并去掉空格（"QQ Agent" → "qqagent"），所以两种写法都要注册。
const ALIAS = new Map();
function addAlias(name, procs) {
  ALIAS.set(name.toLowerCase().replace(/\s+/g, ''), procs);
  ALIAS.set(name.toLowerCase(), procs);
}
addAlias('微信', ['wechat', 'weixin']);
addAlias('企业微信', ['wxwork']);
addAlias('QQ', ['qq']);
addAlias('QQ Agent', ['qq agent', 'qqagent']);
addAlias('QQ音乐', ['qqmusic']);
addAlias('TIM', ['tim']);
addAlias('钉钉', ['dingtalk']);
addAlias('飞书', ['feishu', 'lark']);
addAlias('浏览器', ['msedge', 'chrome', 'firefox', 'brave']);
addAlias('自带浏览器', ['msedge']);
addAlias('谷歌浏览器', ['chrome']);
addAlias('火狐', ['firefox']);
addAlias('代码', ['code']);
addAlias('vscode', ['code']);
addAlias('终端', ['windowsterminal', 'powershell']);
addAlias('任务管理器', ['taskmgr']);
addAlias('音乐', ['cloudmusic', 'qqmusic', 'spotify']);
addAlias('网易云音乐', ['cloudmusic']);
addAlias('哔哩哔哩', ['bilibili']);
addAlias('抖音', ['douyin']);
addAlias('原神', ['yuanshen', 'genshinimpact']);
addAlias('星穹铁道', ['starrail']);
addAlias('英雄联盟', ['league of legends', 'leagueclient']);
addAlias('我的世界', ['javaw', 'minecraft']);
addAlias('绝地求生', ['pubg']);
addAlias('永劫无间', ['naraka', 'naragame']);
addAlias('游戏', ['steam', 'epicgameslauncher', 'wegame']);
addAlias('网盘', ['baidunetdisk', 'aliyundrive']);
addAlias('录屏', ['obs64']);
addAlias('虚拟机', ['vmware', 'virtualbox']);
addAlias('输入法', ['sogouinput', 'qqpinyin', 'weasel']);

/** 把用户输入拆成"进程名前缀"列表：命中别名用别名，否则按原文。 */
function toKeys(raw) {
  const keys = [];
  for (const piece of String(raw || '').split(',')) {
    const k = piece.trim().toLowerCase().replace(/\s+/g, '');
    if (!k) continue;
    const hit = ALIAS.get(k) || ALIAS.get(piece.trim().toLowerCase());
    if (hit) keys.push(...hit.map((s) => s.toLowerCase()));
    else keys.push(k);
    keys.push(k.replace(/\.exe$/, ''));
  }
  return [...new Set(keys.filter(Boolean))];
}

/** 进程名是否命中给定前缀（等值 / 前缀- 开头 / 去空格后等值）。 */
function nameMatches(procName, keys) {
  const ln = String(procName || '').toLowerCase();
  const bare = ln.replace(/\.exe$/, '');
  const tight = ln.replace(/\s+/g, '');
  for (const k of keys) {
    if (ln === k || bare === k) return true;
    if (ln.startsWith(`${k}-`)) return true;
    if (tight === k.replace(/\s+/g, '')) return true;
  }
  return false;
}

/**
 * **本进程**（技能自己所在的进程）的占用与运行时长。
 *
 * ⚠️ 这里读的是 `process.*`，也就是"运行着这个技能的进程"。
 *    实证过它是谁：技能的 api.log 是写进 `data\logs\qq-agent-*.log` 的，
 *    说明技能由 **QQ Agent 应用（Electron）** 加载并运行在它的进程里，
 *    **不是** SnowLuma 那个以 node.exe 跑的运行时进程（那个进程名就是 node，
 *    按名字认还必须区分同机其它 node 进程，认不准）。
 *    所以这块数据的准确含义是"QQ Agent 应用进程自己"，标签默认也这么写；
 *    如果哪天加载方式变了，可以在设置里把标签改成 SnowLuma 之类，**数据不用改**。
 */
function readSelfProcess() {
  try {
    const rss = Number(process.memoryUsage?.().rss) || 0;
    const upSec = Number(process.uptime?.()) || 0;
    if (rss <= 0) return null;
    return {
      memMB: Math.round((rss / 1024 / 1024) * 10) / 10,
      start: Date.now() - Math.round(upSec * 1000),
      uptimeSec: Math.round(upSec),
      runtime: process.versions?.electron ? `Electron ${String(process.versions.electron).split('.')[0]}`
        : process.versions?.node ? `Node ${String(process.versions.node).split('.')[0]}` : ''
    };
  } catch {
    return null;
  }
}

/**
 * 采一次完整快照（结构与此前 PowerShell 版完全一致，上层渲染无需改动）。
 *
 * wantGpu  : 是否采集显卡占用（要多花约 1 秒）
 * wantSelf : 是否附带「本进程自身」的占用与运行时长
 */
async function collectSnapshot({ targets = '', topN = 5, timeoutMs = 20000, wantGpu = false, wantSelf = true } = {}) {
  const ms = Math.max(10000, Number(timeoutMs) || 20000);
  const [cpu, procs, disks] = await Promise.all([
    readCpu(ms),
    readProcesses(ms),
    readDisks()
  ]);
  const osInfo = readOs();
  const agg = aggregateProcesses(procs);

  const memTotalMB = Math.round(os.totalmem() / 1024 / 1024);
  const memFreeMB = Math.round(os.freemem() / 1024 / 1024);
  const memUsedMB = memTotalMB - memFreeMB;

  const gpuNames = await readGpuNames(ms);
  const gpuUsage = wantGpu ? await readGpu(ms) : { usedPct: -1, engines: 0 };
  // 占用只能挂一块卡上：性能计数器只给 LUID，Windows 不提供 LUID→显卡名 的映射，
  // 所以多显卡时这是**全局引擎最大值**。优先挂独显，否则会让人误以为"显卡没在忙"。
  const pick = gpuNames.findIndex((n) => /NVIDIA|Radeon|GeForce|Quadro|RTX|GTX|Arc/i.test(n));
  const useIdx = pick >= 0 ? pick : gpuNames.findIndex((n) => isPhysicalGpu(n));
  const gpus = gpuNames.map((n, i) => ({
    n,
    res: '',
    vramGB: 0,
    driver: '',
    virtual: !isPhysicalGpu(n),
    usedPct: (i === useIdx && gpuUsage.usedPct >= 0) ? gpuUsage.usedPct : -1
  }));

  let matched = [];
  const gaps = [];
  if (String(targets || '').trim()) {
    const keys = toKeys(targets);
    matched = agg.apps.filter((a) => nameMatches(a.n, keys));
    if (!matched.length) gaps.push(...keys);
  }

  const qqagent = agg.apps.find((a) => String(a.n).toLowerCase().replace(/\s+/g, '') === 'qqagent') || null;
  const top = agg.apps.slice(0, Math.max(1, Math.min(12, Number(topN) || 5)));

  return {
    host: os.hostname(),
    os: osInfo.os,
    osBuild: osInfo.osBuild,
    bootEpoch: Math.round(Date.now() - os.uptime() * 1000),
    uptimeSec: Math.round(os.uptime()),
    // ⚠️ 展开顺序很重要：...cpu 必须放在前面。
    //    否则 readCpu() 若哪天也返回 threads/name，就会把这里算好的值覆盖掉。
    cpu: { ...cpu, name: (os.cpus()[0] || {}).model || '', threads: os.cpus().length },
    mem: {
      totalMB: memTotalMB, usedMB: memUsedMB, freeMB: memFreeMB,
      usedPct: memTotalMB > 0 ? Math.round((memUsedMB * 100) / memTotalMB) : 0
    },
    disks,
    gpus,
    gpuEngines: gpuUsage.engines,
    procs: { total: agg.total, memMB: agg.memMB, top },
    qqagent,
    selfProc: wantSelf ? readSelfProcess() : null,
    matched,
    gaps
  };
}

/**
 * 背景图裁切（Electron nativeImage）。按卡片比例取中间区域、略上移给头顶留空间，
 * 再缩放到卡片尺寸、编码成 JPEG data URI。
 *
 * ⚠️ 必须用 import('electron')：该模块只在**应用自己的主进程**里可用，
 *    普通 node / 独立 electron 进程里会报 Cannot find module。拿不到就返回空串，
 *    卡片退回纯色背景 —— 绝不因此画不出卡片。
 */
async function cropBackground(bgFile, cardW, cardH) {
  let nativeImage = null;
  try {
    const mod = await import('electron');
    const e = mod?.default ?? mod;
    nativeImage = e?.nativeImage ?? null;
  } catch { /* 按"拿不到"处理 */ }
  if (!nativeImage?.createFromBuffer) return '';

  try {
    const img = nativeImage.createFromBuffer(fs.readFileSync(bgFile));
    const size = img.getSize();
    if (!size?.width || !size?.height) return '';

    const wantAspect = cardW / cardH;
    const imgAspect = size.width / size.height;
    let cropW;
    let cropH;
    if (imgAspect > wantAspect) { cropH = size.height; cropW = Math.round(cropH * wantAspect); }
    else { cropW = size.width; cropH = Math.round(cropW / wantAspect); }
    cropW = Math.max(1, Math.min(size.width, cropW));
    cropH = Math.max(1, Math.min(size.height, cropH));
    const cropX = Math.round((size.width - cropW) / 2);
    let cropY = Math.round((size.height - cropH) / 2 - size.height * CROP_FACE_SHIFT);
    cropY = Math.max(0, Math.min(size.height - cropH, cropY));

    const cropped = img.crop({ x: cropX, y: cropY, width: cropW, height: cropH });
    const cs = cropped.getSize();
    if (!cs?.width || !cs?.height) return '';
    const resized = cropped.resize({ width: Math.round(cardW), height: Math.round(cardH), quality: 'good' });
    const jpg = resized.toJPEG(86);
    if (!jpg || jpg.length < 512) return '';
    return `data:image/jpeg;base64,${jpg.toString('base64')}`;
  } catch (error) {
    note(`背景图处理失败，本次用纯色卡片：${error?.message ?? error}`);
    return '';
  }
}

/**
 * 执行一次采集，返回 { ok, d } 或 { ok: false, error }（与旧版同样的返回形状）。
 */
async function collect(opts = {}) {
  try {
    const d = await collectSnapshot(opts);
    return { ok: true, d };
  } catch (error) {
    return { ok: false, error: `读取系统状态失败（${error?.message ?? error}）。` };
  }
}

// ── 输出形态 ──────────────────────────────────────────────────────────────
//
// ⚠️ 这里最重要的一个坑：**工具返回的文字多长，模型就发多少条**。
// 早先 renderSummary 返回十几行（一行一个事实），模型就把它拆成了 16 条消息一条条发，
// 群里刷屏、看着费眼。
// 解法不是"让模型少发"，而是**直接给它一段已经拼好的、可以原样发出去的文字**：
// 模型面对「照抄这一段」永远只发一条。所以：

const SEND_BEGIN = '== 下面这条可直接原样发出（整段算一条消息，不要拆成多条）==';
const SEND_END = '== 可直接发出的内容结束 ==';

// ── 状态卡片图 ────────────────────────────────────────────────────────────
//
// 发图这条路**不是**走模型的 send_image 工具（那个工具只收 http(s) 直链、会拒本地文件、
// 还会被内网地址拦掉）。真正的通道在 ctx.sender.sendImage 上：它接受**本地文件路径**
// 或 base64://，完全绕开 URL 校验。
// 已在实际使用的机制：
//   写 HTML → 离屏 BrowserWindow（offscreen:true）→ capturePage() → PNG → sender.sendImage。
//
// ⚠️ 两个必须遵守的细节（否则是"偶尔发不出来"的隐形故障）：
//   1. sendImage 要同时给 file 和 dataUrl（base64 兜底）：默认走本地路径让协议端自己读盘，
//      body 只有 ~100 字节；协议端读不到该路径时自动回退 base64 再试一次。
//   2. 图片走 data:URL 而不是 file:// 载入：这样 HTML 里能带 CSP，避免远程图标被拦。
// 任何一步失败都返回 null → 调用方退回文字，不会静默失败。

const CARD_THEME = {
  dark: {
    pageBg: '#0e1014', cardBg: '#14171d', border: '#262b35', text: '#e8ecf3',
    dim: '#aab3c2', dim2: '#6f7a8d', chip: '#1b2028'
  },
  light: {
    pageBg: '#eef1f5', cardBg: '#ffffff', border: '#dfe4ec', text: '#1a1f29',
    dim: '#5b6675', dim2: '#8b95a7', chip: '#f3f5f9'
  }
};

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 用量条的颜色：绿→黄→红，一眼看出哪里紧张。 */
function barColor(pct) {
  const n = Number(pct) || 0;
  if (n >= 90) return '#f85149';
  if (n >= 75) return '#d29922';
  return '#3fb950';
}

/**
 * 圆环仪表（SVG）：和资源管理器那种环形占用指示一个观感。
 * 用 r=26 的圆，周长 2πr ≈ 163.36，靠 stroke-dasharray 控制已用弧长。
 *
 * ⚠️ 一圈只画一条弧。曾经在 CPU 那枚里额外套了一圈"单核最高"的弧，
 *    结果 34% 的主弧和 47% 的副弧几乎重叠成一条 —— 看起来像"数字 34%、圈却快满了"。
 *    峰值改成文字（单核最高 xx%）；弧端也用 butt：圆头会各多出半个线宽的圆帽，
 *    让弧看起来比实际长几个百分点，同样会造成"数字和圈对不上"。
 */
const RING_R = 26;
const RING_C = 2 * Math.PI * RING_R;   // 163.36

function ringSvg(pct) {
  const w = Math.max(0, Math.min(100, Number(pct) || 0));
  const fill = (RING_C * w) / 100;
  return `<svg viewBox="0 0 60 60" width="76" height="76">
        <circle class="trk" cx="30" cy="30" r="${RING_R}"/>
        <circle cx="30" cy="30" r="${RING_R}" fill="none" stroke="${barColor(w)}" stroke-width="6"
          stroke-linecap="butt" stroke-dasharray="${fill.toFixed(2)} ${RING_C.toFixed(2)}"
          stroke-dashoffset="0" transform="rotate(-90 30 30)"/>
      </svg>`;
}

/** 一个指标（CPU / 内存 / 每块盘 / 显卡）：按 mode 渲成圆环或横条。 */
function metric(mode, label, pct, valueText, subText = '') {
  const w = Math.max(0, Math.min(100, Number(pct) || 0));
  if (mode === 'ring') {
    return `    <div class="gauge">
      <div class="ringwrap">
        ${ringSvg(w)}
        <div class="rlabel">${esc(`${Math.round(w)}%`)}</div>
      </div>
      <div class="gname">${esc(label)}</div>
      ${subText ? `<div class="gval">${esc(subText)}</div>` : ''}
    </div>`;
  }
  const sub = subText ? `<div class="msub">${esc(subText)}</div>` : '';
  return `    <div class="mrow">
      <div class="row"><span class="k">${esc(label)}</span><span class="v">${esc(valueText)}</span></div>
      <div class="bar"><i style="width:${w}%;background:${barColor(w)}"></i></div>
      ${sub}
    </div>`;
}

/** 一个分框小节：标题 + 内容。 */
function frame(title, inner, cls = '') {
  if (!inner) return '';
  return `  <div class="frame ${cls}">
    <div class="ftitle">${esc(title)}</div>
${inner}
  </div>`;
}

/** 键值行。 */
function kv(k, v, cls = 'kv') {
  return `    <div class="row sm ${cls}"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`;
}

/** 用系统状态画一张卡片 HTML（宽度固定，高度由内容决定）。 */
function buildCardHtml(d, cfg, theme = 'dark', bgDataUri = '', cardH = 0) {
  const t = CARD_THEME[theme] || CARD_THEME.dark;
  const W = 520;
  const hasBg = !!bgDataUri;
  const isLight = theme === 'light';
  const globalMode = cfg.displayMode === 'bar' ? 'bar' : 'ring';
  const detailed = cfg.detailLevel === 'detail';
  const show = (k) => cfg[k] !== false;

  /**
   * 每一项硬件可以单独选圆环或横条；选"跟随全局"就用 displayMode 的值。
   * ⚠️ 必须每处都调它，不能再直接用全局 mode —— 否则单独设置不生效。
   */
  const modeOf = (key) => {
    const v = cfg[key];
    if (v === 'ring' || v === 'bar') return v;
    return globalMode;
  };

  const cpu = d.cpu || {};
  const mem = d.mem || {};
  const disks = asArray(d.disks);
  // 本进程那一块的标题：默认说清"这是运行机器人的应用进程"，
  // 免得和下面「QQ Agent 自身（全部进程合计）」混淆。可在设置里改。
  const selfLabel = cfg.selfProcLabel === 'snowluma' ? 'SnowLuma 自身' : 'QQ Agent 自身（本进程）';
  // 虚拟显示器（远程串流那一类）不是真实显卡，占用挂在上面会让人看不懂，
  // 默认隐藏；想看得更全可以在设置里打开。
  const allGpus = asArray(d.gpus);
  const hideVirtual = show('hideVirtualGpu');
  const gpus = hideVirtual ? allGpus.filter((g) => !g.virtual) : allGpus;

  // ── 头部（不套框）────────────────────────────────────────────────────
  const headLine = `  <div class="head">🖥️ ${esc(d.host || '本机')}</div>`;
  const subParts = [];
  if (show('showOs') && d.os) subParts.push(String(d.os).replace(/Insider Preview/i, '').trim());
  if (detailed && show('showOs') && d.osBuild) subParts.push(String(d.osBuild));
  subParts.push(`已开机 ${zhDur(d.uptimeSec)}`);
  const subLine = `  <div class="sub">${esc(subParts.join(' · '))}</div>`;

  // ── 系统框 ───────────────────────────────────────────────────────────
  // ⚠️ 框标题已经是「系统」了，正文里不要再放一行「系统 → ...」，否则一屏里出现两个"系统"
  //    （第一版就是这样，用户直接看得出来）。这里正文只放：处理器、以及详细模式下的显卡。
  const sysRows = [];
  if (show('showCpuInfo') && cpu.name) {
    const short = String(cpu.name).replace(/\(R\)|\(TM\)|CPU\s*|@.*$/g, '').replace(/\s{2,}/g, ' ').trim();
    // ⚠️ 只写"线程"数，不写"X 核 Y 线程"。
    //    纯 Node 拿不到物理核数（没有等价于 Win32_Processor.NumberOfCores 的接口：
    //    os.cpus() 只给逻辑处理器；性能计数器的 Processor Information 实例名只到封装号；
    //    systeminfo 只报"安装了几个处理器"）。既然拿不到，就**不显示**这个数 ——
    //    原来写 `${cpu.cores || '?'} 核` 会在卡片上直接印出一个问号，很显眼也很难看。
    const spec = detailed
      ? `${cpu.name}（${cpu.threads || '?'} 线程）`
      : `${short} ${cpu.threads || '?'} 线程`;
    sysRows.push(kv('处理器', spec));
  }
  if (detailed && show('showGpu') && gpus.length) {
    for (const g of gpus) {
      const bits = [g.n];
      if (g.res) bits.push(g.res);
      if (g.vramGB > 0) bits.push(`${g.vramGB}G 显存`);
      sysRows.push(kv('显卡', bits.join(' · ')));
    }
  }
  // 系统版本放这一行的位置最自然：标题写"系统"，信息跟着走
  if (show('showOs')) {
    sysRows.unshift(kv('版本', `${d.os || '未知'}${detailed && d.osBuild ? ` · ${d.osBuild}` : ''}`));
  }
  const sysFrame = sysRows.length ? frame('系统', sysRows.join('\n')) : '';

  // ── 硬件框：CPU 与内存（各自可单独选圆环/横条）────────────────────────
  const hwInner = [];
  const hwModes = [];
  if (show('showCpu') && Number.isFinite(Number(cpu.usedPct))) {
    const m = modeOf('modeCpu');
    hwModes.push(m);
    const peak = (Number(cpu.coreCount) > 1 && Number(cpu.coreMax) > 0) ? `单核最高 ${cpu.coreMax}%` : '';
    hwInner.push(metric(m, 'CPU', cpu.usedPct, `${cpu.usedPct}%${peak ? `（${peak}）` : ''}`, peak));
  }
  if (show('showMem') && Number(mem.totalMB) > 0) {
    const m = modeOf('modeMem');
    hwModes.push(m);
    hwInner.push(metric(m, '内存', mem.usedPct,
      `${gb(mem.usedMB)} / ${gb(mem.totalMB)} GB（${mem.usedPct}%）`,
      detailed ? `可用 ${gb(mem.freeMB)} GB` : ''));
  }
  const hwRing = hwModes.includes('ring') && !hwModes.includes('bar');   // 全部同一种时才能并排
  const hwFrame = hwInner.length
    ? frame('硬件', `<div class="${hwRing ? 'gauges' : 'mrows'}">\n${hwInner.join('\n')}\n  </div>`)
    : '';

  // ── 硬盘：全部盘合到同一个框里。一框一盘会把卡片撑得很长（实测四块盘要四屏）──
  const diskInner = [];
  const diskMode = modeOf('modeDisk');
  if (show('showDisk') && disks.length) {
    for (const dk of disks) {
      const used = 100 - (Number(dk.freePct) || 0);
      // 详细模式把型号放在数值行里，不再单独占一行（否则型号会出现两次）
      const value = detailed
        ? `剩 ${dk.freeGB} / 共 ${dk.sizeGB} GB（${dk.freePct}%）`
        : `剩 ${dk.freeGB} / ${dk.sizeGB} GB（${dk.freePct}%）`;
      const label = diskMode === 'ring' ? `${dk.id}` : `${detailed && dk.model ? dk.model : `硬盘 ${dk.id}`}`;
      const sub = diskMode === 'ring'
        ? (detailed && dk.model ? `${dk.freeGB}/${dk.sizeGB}G` : `剩 ${dk.freeGB}G`)
        : (detailed && dk.model ? '' : `剩 ${dk.freeGB} / ${dk.sizeGB} GB`);
      diskInner.push(metric(diskMode, label, used, value, sub));
    }
  }
  const diskFrame = diskInner.length
    ? frame('硬盘', `<div class="${diskMode === 'ring' ? 'gauges' : 'mrows'}">\n${diskInner.join('\n')}\n  </div>`)
    : '';

  // ── 显卡占用框（勾选才出现；虚拟显示器已在上面过滤掉）────────────────
  const gpuFrames = [];
  if (show('showGpuUsage')) {
    const gpuMode = modeOf('modeGpu');
    const used = gpus.find((g) => Number(g.usedPct) >= 0);
    if (used) {
      const value = detailed
        ? `${used.usedPct}%${used.res ? ` · ${used.res}` : ''}${used.vramGB > 0 ? ` · ${used.vramGB}G` : ''}`
        : `${used.usedPct}%`;
      gpuFrames.push(frame(`显卡 · ${used.n}`, metric(gpuMode, 'GPU', used.usedPct, value,
        detailed ? '全局引擎占用（取各引擎最大值，不按显卡归属）' : '')));
    } else if (gpus.length && detailed) {
      // 没取到占用，但详细模式下还是把显卡名报一下，比单纯写"未取到"有用
      gpuFrames.push(frame('显卡', kv('显卡', gpus.map((g) => g.n).join(' · '))));
    } else if (gpus.length) {
      gpuFrames.push(frame(`显卡 · ${gpus[0].n}`, kv('GPU 占用', '本次未取到（可能未启用或驱动不支持）')));
    } else {
      gpuFrames.push(frame('显卡', kv('GPU 占用', '只检测到虚拟显示器，已按设置隐藏')));
    }
  }

  // ── 软件占用框 ───────────────────────────────────────────────────────
  const swRows = [];
  const top = asArray((d.procs || {}).top).slice(0, cfg.topListInCompact);
  if (show('showProcs') && top.length) {
    swRows.push(`    <div class="sec">最占内存</div>`);
    for (const x of top) {
      const cnt = Number(x.count) || 1;
      swRows.push(kv(`${x.n}${cnt > 1 ? ` ×${cnt}` : ''}`, `${x.memMB} MB`));
    }
  }
  const qa = d.qqagent;
  if (show('showQQAgent')) {
    swRows.push(`    <div class="sec">QQ Agent 自身</div>`);
    if (qa) {
      swRows.push(kv('占用内存', `${qa.memMB} MB${Number(qa.count) > 1 ? ` · ${qa.count} 个进程` : ''}`));
      if (Number(qa.start) > 0) swRows.push(kv('已运行', zhDur((Date.now() - Number(qa.start)) / 1000)));
    } else {
      swRows.push(kv('状态', '没找到名为「QQ Agent」的进程'));
    }
  }
  // ── 本进程（运行机器人的那个应用进程）自身 ────────────────────────────
  // 数据来自**本进程自己**（process.rss / process.uptime），是精确值，
  // 不需要去猜哪个 node.exe 是谁。标签可配（见「本进程标题」设置）。
  const selfP = d.selfProc;
  if (show('showSelfProc') && selfP) {
    swRows.push(`    <div class="sec">${esc(selfLabel)}</div>`);
    swRows.push(kv('占用内存', `${selfP.memMB} MB${selfP.runtime ? ` · ${selfP.runtime}` : ''}`));
    if (Number(selfP.uptimeSec) > 0) swRows.push(kv('已运行', zhDur(selfP.uptimeSec)));
  }
  if (!show('showProcs') && (d.procs || {}).total) {
    swRows.push(kv('进程总数', `${d.procs.total} 个 · 合计 ${d.procs.memMB ?? '?'} MB`));
  }
  const swFrame = swRows.length ? frame('软件占用', swRows.join('\n')) : '';

  // ⚠️ 变量名别叫 warn：会遮蔽模块级那个 warn() 日志函数（同类坑踩过两次）
  const warnings = [];
  if (show('showCpu') && Number(cpu.usedPct) >= 85) warnings.push('CPU 几乎满载，现在确实卡');
  if (show('showMem') && Number(mem.usedPct) >= 85) warnings.push('内存快满了，可能会卡');
  const warnHtml = warnings.length
    ? `  <div class="warn">${esc(warnings.join('；'))}</div>` : '';

  // ── 透明度：用户可调。面板与分框都跟着变（原来"模糊但不通透"就是 alpha 太高）──
  const opRaw = Number(cfg.opacity);
  const alpha = (Number.isFinite(opRaw) ? Math.max(0, Math.min(100, opRaw)) : 55) / 100;
  const panelA = Math.round(alpha * 100) / 100;
  const frameA = Math.round(alpha * 100) / 100;
  const frameA2 = Math.round(alpha * 16) / 100;

  const textMain = isLight ? '#0f1722' : '#fff';
  const dim1 = isLight ? 'rgba(15,23,34,.70)' : 'rgba(255,255,255,.78)';
  const dim2 = isLight ? 'rgba(15,23,34,.58)' : 'rgba(255,255,255,.66)';
  const dim3 = isLight ? 'rgba(15,23,34,.50)' : 'rgba(255,255,255,.58)';
  const shadow = isLight ? '0 1px 2px rgba(255,255,255,.55)' : '0 1px 3px rgba(0,0,0,.55)';
  const panelBg = isLight ? `rgba(255,255,255,${panelA})` : `rgba(14,18,26,${panelA})`;
  const frameBg = isLight ? `rgba(255,255,255,${frameA})` : `rgba(255,255,255,${frameA2})`;
  const frameBorder = isLight ? 'rgba(255,255,255,.55)' : 'rgba(255,255,255,.14)';
  const cardBorder = isLight ? 'rgba(255,255,255,.70)' : 'rgba(255,255,255,.20)';
  const cardShadow = isLight ? '30,50,80,.16' : '0,0,0,.26';
  const shadeTop = isLight ? '250,252,255,.20' : '10,14,22,.16';
  const shadeMid = isLight ? '246,249,255,.30' : '10,14,22,.28';
  const shadeBot = isLight ? '236,242,250,.44' : '6,9,15,.44';
  const trackColor = hasBg ? (isLight ? 'rgba(15,23,34,.16)' : 'rgba(255,255,255,.20)') : t.border;

  const bgCss = hasBg ? `
  html, body { margin:0; padding:0; }
  body { width:${W}px; color:${textMain}; font-family:"Microsoft YaHei","Segoe UI",system-ui,sans-serif;
         text-shadow:${shadow}; }
  #bg { position:absolute; inset:0; background-image:url('${bgDataUri}'); background-size:100% 100%;
        filter:saturate(1.05) brightness(${isLight ? '1.04' : '.95'}); }
  .shade { position:absolute; inset:0; background:
      linear-gradient(180deg, rgba(${shadeTop}) 0%, rgba(${shadeMid}) 55%, rgba(${shadeBot}) 100%); }
  .wrap { position:relative; padding:${CARD_PAD_TOP}px 14px ${CARD_PAD_BOTTOM}px; }
  .card { background:${panelBg}; border:1px solid ${cardBorder}; border-radius:16px;
          padding:12px 13px 11px; backdrop-filter:blur(14px) saturate(1.1);
          -webkit-backdrop-filter:blur(14px) saturate(1.1); box-shadow:0 10px 30px rgba(${cardShadow}); }
  .frame { background:${frameBg}; border:1px solid ${frameBorder}; border-radius:12px;
           padding:9px 12px 7px; margin-top:9px; }
  .bar { height:8px; background:${isLight ? 'rgba(15,23,34,.14)' : 'rgba(255,255,255,.18)'};
         border-radius:4px; overflow:hidden; margin:5px 0 9px; }
  .warn { background:${isLight ? 'rgba(15,23,34,.10)' : 'rgba(255,255,255,.16)'}; }`
    : `
  html, body { margin:0; padding:0; background:${t.cardBg}; }
  body { width:${W}px; color:${t.text}; font-family:"Microsoft YaHei","Segoe UI",system-ui,sans-serif; }
  .wrap { position:relative; }
  .card { background:${t.cardBg}; border-radius:14px; padding:15px 17px 13px; }
  .frame { background:${t.chip}; border:1px solid ${t.border}; border-radius:12px;
           padding:9px 12px 7px; margin-top:9px; }
  .bar { height:8px; background:${t.cardBg}; border-radius:4px; overflow:hidden; margin:5px 0 9px; }
  .warn { background:${t.chip}; }`;

  // 两种底色共用的排版样式
  const baseCss = `
  .head { font-size:19px; font-weight:700; margin-bottom:3px; }
  .sub { color:${hasBg ? dim1 : t.dim}; font-size:12.5px; margin-bottom:2px; }
  .k { color:${hasBg ? dim1 : t.dim2}; }
  .row { display:flex; justify-content:space-between; align-items:baseline; font-size:14px; margin:2px 0; }
  .row.sm { font-size:13px; }
  /* 键名限宽：长处理器型号若自由换行会折成两行，很难看 */
  .mrow .k, .kv .k { flex:0 0 auto; max-width:64%; }
  .mrow .v, .kv .v { flex:1 1 auto; text-align:right; }
  .sec { color:${hasBg ? dim2 : t.dim}; font-size:12px; margin:9px 0 3px; letter-spacing:.04em; }
  .ftitle { color:${hasBg ? dim2 : t.dim}; font-size:12px; letter-spacing:.04em; margin-bottom:4px; }
  .msub { color:${hasBg ? dim3 : t.dim2}; font-size:11.5px; margin:-4px 0 7px; }
  .foot { color:${hasBg ? dim3 : t.dim2}; font-size:11.5px; margin-top:10px; }
  .warn { margin-top:9px; border-radius:8px; padding:8px 10px; font-size:13px; }
  /* ⚠️ flex-direction / flex-wrap 必须写死：只给 display:flex 时，
     在离屏窗口里圆环会竖着排（实测），并排才符合"仪表盘"的观感。 */
  .gauges { display:flex; flex-direction:row; flex-wrap:wrap; align-items:flex-start;
            gap:20px 32px; justify-content:center; margin:2px 0 2px; }
  .mrows { display:block; }
  .gauge { flex:0 0 auto; width:100px; text-align:center; }
  .ringwrap { position:relative; width:76px; height:76px; margin:0 auto; }
  .ringwrap svg { display:block; }
  .trk { fill:none; stroke:${trackColor}; stroke-width:6; }
  .rlabel { position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
            font-size:15px; font-weight:700; }
  .gname { margin-top:4px; font-size:12.5px; color:${hasBg ? dim1 : t.dim}; }
  .gval { margin-top:1px; font-size:11px; color:${hasBg ? dim3 : t.dim2}; }`;

  const body = hasBg
    ? `  <div id="bg"></div><div class="shade"></div>
  <div class="wrap"><div class="card">`
    : `  <div class="wrap"><div class="card">`;
  const tail = hasBg ? `  </div></div>` : `  </div>`;

  // ⚠️ overflow:hidden 很重要：窗口尺寸与内容高度只要差几个像素，截图里就会出现
  //    滚动条（用户实拍反馈"右边和底下被滑动条挡住"）。这里彻底禁掉滚动。
  //    ⚠️ 但它只能保证"不出现滚动条"，**不能**保证内容不被裁掉 —— 窗口比内容矮时
  //    超出的部分会被直接切掉（"下半部分遮挡"）。所以高度必须留足余量，见 HEIGHT_SLACK。
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<style>
  * { box-sizing: border-box; }
  html, body { overflow:hidden; }
  .bar > i { display:block; height:100%; border-radius:4px; }
${bgCss}
${baseCss}
</style></head><body>
${body}
${headLine}
${subLine}
${sysFrame}
${hwFrame}
${diskFrame}
${gpuFrames.join('\n')}
${swFrame}
${warnHtml}
  <div class="foot">实测值 · ${esc(zhClock(Date.now()))}</div>
${tail}
</body></html>`;
}

/**
 * 量出页面真实内容高度（CSS 像素）。
 *
 * 取多个口径的最大值，并且**等字体就绪**后再量：
 * 只量 getBoundingClientRect().height 时，中文字体晚一步生效会把内容撑高，
 * 量到的值偏小 → 窗口比内容矮 → 底部被切掉（实测就是"下半部分遮挡"）。
 */
async function measureDocHeight(win) {
  const expr = `(() => {
    const dh = document.documentElement;
    const b = document.body;
    return Math.max(
      dh ? dh.scrollHeight : 0,
      dh ? dh.offsetHeight : 0,
      dh ? Math.ceil(dh.getBoundingClientRect().height) : 0,
      b ? b.scrollHeight : 0,
      b ? Math.ceil(b.getBoundingClientRect().height) : 0
    );
  })()`;
  const h = await win.webContents.executeJavaScript(expr).catch(() => 0);
  return Number.isFinite(h) && h > 0 ? h : 0;
}


/**
 * 测出这份 HTML 的真实高度（CSS 像素）。卡片高度由内容决定，先量了才知道
 * 背景图该按什么比例裁。
 */
async function measureHtmlHeight(electron, html, W, theme = 'dark') {
  let win = null;
  try {
    const t = CARD_THEME[theme] || CARD_THEME.dark;
    win = new electron.BrowserWindow({
      show: false, skipTaskbar: true, frame: false, useContentSize: true,
      width: W, height: 360, backgroundColor: t.cardBg,
      webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: false, contextIsolation: true, nodeIntegration: false }
    });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    // 等字体就绪：中文字体晚一步生效会把内容撑高，量早了就偏小
    await win.webContents.executeJavaScript('document.fonts && document.fonts.ready').catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    const h = await measureDocHeight(win);
    // 再给一档余量：后面按这个高度裁背景图并定窗截图，宁可多一条背景边，也不能切掉内容
    return h > 80 ? h + HEIGHT_SLACK : 0;
  } catch {
    return 0;
  } finally {
    try { if (win) win.destroy(); } catch { /* 忽略 */ }
  }
}

/**
 * HTML → PNG。用应用自带的 Electron 开一个离屏窗口截图。
 * ⚠️ import('electron') 只有在**应用自己的主进程**里才拿得到（普通 node/electron 命令行下
 *    会报 Cannot find module）；拿不到就返回 null，由调用方退回文字。
 */
let cardRendering = false;
/** 最近一次截图的实际尺寸（诊断用，打进出图日志）。 */
let lastRenderInfo = null;
async function renderCardPng(html, theme = 'dark', fixedH = 0) {
  let electron = null;
  try {
    const mod = await import('electron');
    electron = mod?.default ?? mod;
  } catch {
    return null;
  }
  if (!electron || typeof electron.BrowserWindow !== 'function') return null;

  // 同一时刻只允许渲染一张：同时开多个离屏窗口容易互相抢 GPU 进程
  if (cardRendering) {
    const t0 = Date.now();
    while (cardRendering && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 50));
    if (cardRendering) return null;
  }
  cardRendering = true;

  const t = CARD_THEME[theme] || CARD_THEME.dark;
  const W = 520;
  let win = null;
  try {
    win = new electron.BrowserWindow({
      show: false,
      skipTaskbar: true,
      frame: false,
      useContentSize: true,
      // ⚠️ 必须用 CSS 尺寸建窗，不能乘缩放：显示器不是 100% 时会多乘一次 DPR，
      //    卡片只占左边一半、右边露出一片背景色
      width: W,
      height: fixedH > 80 ? Math.ceil(fixedH) : 360,
      backgroundColor: t.cardBg,
      webPreferences: {
        offscreen: true,
        backgroundThrottling: false,
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false
      }
    });

    // 用 data:URL 载入，避免 file:// 页面里的 CSP/相对路径问题
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

    // 等字体就绪（中文字体晚一步会把内容撑高）
    await win.webContents.executeJavaScript('document.fonts && document.fonts.ready').catch(() => {});

    if (fixedH > 80) {
      // 高度已确定（背景图是按这个高度裁的），只等首帧画完
      await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        try { win.webContents.once('paint', finish); } catch { /* 老版本没有 paint 事件 */ }
        setTimeout(finish, 700);
      });
    } else {
      await new Promise((r) => setTimeout(r, 350));
      // 没走背景图分支时也要量高定窗，免得下方留白或截断
      const h = await measureDocHeight(win);
      if (h > 60) {
        win.setContentSize(W, Math.ceil(h) + HEIGHT_SLACK);
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    // ── 定案：截之前再量一次，窗口不够高就补上 ──────────────────────────
    // 高度是按"另一扇窗量出来的值"预设的，中间可能因字体/换行差几个像素；
    // 差出来的部分会被直接切掉（overflow:hidden 不会救它）。这里做最后一道兜底：
    // 实测内容比窗口高就加高窗口，让"被裁掉一截"这件事根本不可能发生。
    if (fixedH > 80) {
      const need = await measureDocHeight(win);
      if (need > fixedH + 2) {
        win.setContentSize(W, Math.ceil(need) + HEIGHT_SLACK);
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    let png = null;
    try {
      const img = await win.webContents.capturePage();
      png = img.toPNG();
    } catch { /* 下面回退 captureBitmap */ }
    if (!png || png.length < 1000) {
      // 回退：offscreen 窗口在某些版本上 capturePage 会失败，但离屏位图是有的
      const bmp = win.webContents.captureBitmap?.();
      if (bmp && !bmp.isEmpty()) png = bmp.toPNG();
    }
    if (!png || png.length < 1000) throw new Error('截图为空');

    // 把「窗口尺寸 / 页面内容高度 / 出图像素」一起带出去打日志：
    // 用户反馈"图被裁"时，这三者一比就知道是窗口建小了，还是截图截小了。
    try {
      const size = win.getContentSize();
      const docH = await measureDocHeight(win);
      const imgSize = img?.getSize ? img.getSize() : null;
      const bmpSize = (!imgSize && png) ? null : null;
      lastRenderInfo = {
        winW: size?.[0] ?? 0,
        winH: size?.[1] ?? 0,
        docH,
        imgW: imgSize?.width ?? 0,
        imgH: imgSize?.height ?? 0,
        fixed: fixedH,
        bytes: png.length
      };
      void bmpSize;
    } catch { /* 诊断信息取不到不影响出图 */ }
    return png;
  } catch {
    return null;
  } finally {
    try { if (win) win.destroy(); } catch { /* 忽略 */ }
    cardRendering = false;
  }
}

/** 整机状态的简短版：控制在 8 行内，足够回答"卡不卡/还剩多少"。 */
function compactSummary(d, cfg) {
  // 本进程那一块的标题（与卡片同一套文案）
  const selfLabel = cfg?.selfProcLabel === 'snowluma' ? 'SnowLuma 自身' : 'QQ Agent 自身（本进程）';
  const lines = [];
  const head = [`🖥️ ${d.host || '本机'}`];
  const osShort = String(d.os || '').replace(/Insider Preview/i, '').trim();
  if (osShort) head.push(osShort);
  head.push(`已开机 ${zhDur(d.uptimeSec)}`);
  lines.push(head.join(' · '));

  const cpu = d.cpu || {};
  if (Number.isFinite(Number(cpu.usedPct))) {
    const peak = Number(cpu.coreCount) > 1 && Number(cpu.coreMax) > 0 ? `（单核最高 ${cpu.coreMax}%）` : '';
    lines.push(`CPU ${cpu.usedPct}%${peak}`);
  }

  const mem = d.mem || {};
  if (Number(mem.totalMB) > 0) {
    lines.push(`内存 ${gb(mem.usedMB)} / ${gb(mem.totalMB)} GB（${mem.usedPct}%）`);
  }

  const disks = asArray(d.disks);
  if (disks.length) {
    lines.push(`硬盘 ${disks.map((k) => `${k.id} 剩 ${k.freeGB}G（${k.freePct}%）`).join(' │ ')}`);
  }

  const top = asArray((d.procs || {}).top);
  if (top.length) {
    const items = top.slice(0, cfg.topListInCompact).map((t) => {
      const cnt = Number(t.count) || 1;
      return cnt > 1 ? `${t.n} ${cnt} 进程 ${t.memMB}MB` : `${t.n} ${t.memMB}MB`;
    });
    lines.push(`最占内存：${items.join(' │ ')}`);
  }

  // compact 下自带 QQ Agent 一行，明细里就不重复了（避免同一条消息里出现两次）
  const qa = d.qqagent;
  if (qa && cfg.showQQAgent !== false) lines.push(`QQ Agent：${qaLine(qa)}`);
  // 本进程自身的占用与运行时长（数据来自本进程，精确值）
  const selfP = d.selfProc;
  if (selfP && cfg.showSelfProc !== false) {
    lines.push(`${selfLabel}：${selfP.memMB} MB · 已运行 ${zhDur(selfP.uptimeSec)}`);
  }

  if (Number(cpu.usedPct) >= 85) lines.push('（CPU 几乎满载，现在确实卡）');
  else if (Number(mem.usedPct) >= 85) lines.push('（内存快满了，可能会卡）');
  return lines.join('\n');
}

/** 整机状态的完整明细（模型回答追问时参考用）。 */
function detailLines(r, cfg) {
  // 本进程那一块的标题（与卡片同一套文案，可在设置里改）
  const selfLabel = cfg?.selfProcLabel === 'snowluma' ? 'SnowLuma 自身' : 'QQ Agent 自身（本进程）';
  const d = r.d || {};
  const detail = [];
  if (d.host) detail.push(`主机：${d.host}${d.os ? `（${d.os}）` : ''}`);
  const up = Number(d.uptimeSec) || 0;
  if (up > 0) detail.push(`已开机：${zhDur(up)}（开机于 ${zhClock(d.bootEpoch)}）`);
  const cpu = d.cpu || {};
  if (Number.isFinite(Number(cpu.usedPct))) {
    const coreNote = Number(cpu.coreMax) > 0 && Number(cpu.coreCount) > 1
      ? `（单核最高 ${cpu.coreMax}%）` : '';
    // 只报线程数：纯 Node 拿不到物理核数，与其显示"?"不如不显示（见卡片注释）
    detail.push(`CPU：${cpu.name || '未知型号'}，${cpu.threads || '?'} 线程，`
      + `最近约 1 秒平均占用 ${cpu.usedPct}%${coreNote}`);
  } else {
    detail.push(`CPU：${cpu.name || '未知型号'}（占用率读取失败）`);
  }
  const mem = d.mem || {};
  if (Number(mem.totalMB) > 0) {
    detail.push(`内存：已用 ${gb(mem.usedMB)} GB / 共 ${gb(mem.totalMB)} GB（${mem.usedPct}%），`
      + `可用 ${gb(mem.freeMB)} GB`);
  }
  for (const dk of asArray(d.disks)) {
    detail.push(`硬盘 ${dk.id}：剩余 ${dk.freeGB} GB / 共 ${dk.sizeGB} GB（可用 ${dk.freePct}%）`);
  }
  for (const g of asArray(d.gpus)) {
    detail.push(`显卡：${g.n}${g.res ? `（当前输出 ${g.res}）` : ''}`);
  }
  const procs = d.procs || {};
  detail.push(`进程总数：${procs.total ?? '?'} 个，合计占用内存 ${procs.memMB ?? '?'} MB`);
  const qa = d.qqagent;
  if (cfg.showQQAgent !== false) {
    if (qa) detail.push(`QQ Agent 自身：${appLine(qa)}`);
    else detail.push('QQ Agent 自身：没找到名为「QQ Agent」的进程（可能没在运行）。');
  }
  // 本进程自身（技能所在的进程，读到的是它自己的真实数据）
  const selfDetail = d.selfProc;
  if (cfg.showSelfProc !== false && selfDetail) {
    detail.push(`${selfLabel}：占用内存 ${selfDetail.memMB} MB`
      + `，已运行 ${zhDur(selfDetail.uptimeSec)}${selfDetail.runtime ? `（${selfDetail.runtime}）` : ''}`);
  }
  return detail;
}

/** 整机状态 → 给模型看的内容。 */
function renderSummary(r, cfg) {
  const d = r.d || {};
  const isCompact = cfg.replyStyle !== 'detail';
  const topN = isCompact ? cfg.topListInCompact : cfg.topN;
  // ⚠️ detailLines() 里已经含「进程总数」和「QQ Agent 自身」两行，
  //    这里不要再拼一次 —— 曾经重复拼过，明细里同样的两行各出现两遍（用户实拍反馈过）。
  const detail = detailLines(r, cfg);
  const procs = d.procs || {};
  // 简短版已经列过前几名，这里补上剩下的，便于回答"还有谁在占内存"
  const rest = asArray(procs.top).slice(topN);
  if (rest.length) {
    detail.push(`其它占内存的程序：${rest.map((t) => appLine(t)).join('；')}`);
  }

  if (isCompact) {
    return `${SEND_BEGIN}\n${compactSummary(d, cfg)}\n${SEND_END}\n\n`
      + `【补充明细（这是给你回答追问用的，不要主动发出去）】\n${detail.join('\n')}`;
  }
  return `【电脑状态快照（${zhClock(Date.now())}）】\n${detail.join('\n')}\n`
    + '（以上是本次实测值，请照实回答，不要自行估算。）';
}

/**
 * 画一张状态卡片并直接发到当前会话。
 *
 * 发图通道是 ctx.sender.sendImage，
 * **不是**模型的 send_image 工具：后者只收 http(s) 直链、拒本地文件、还会被内网地址拦。
 *
 * 这个函数只在**成功发出去**时返回 true；任何一步失败（Electron 取不到、截图为空、
 * 发送被限频/去重挡掉）都返回 false 并把原因写进日志，由调用方退回文字版 ——
 * 绝不出现"告诉模型图发了、其实没发"的静默失效。
 */
/**
 * 拿到 Electron 模块（只在应用自己的主进程里可用；普通 node 下会抛错）。
 * 缓存住成功的结果，避免每次查询都去试一次失败的 import。
 */
let electronMod = undefined;
async function electronModule() {
  if (electronMod !== undefined) return electronMod;
  try {
    const mod = await import('electron');
    const e = mod?.default ?? mod;
    electronMod = (e && typeof e.BrowserWindow === 'function') ? e : null;
  } catch {
    electronMod = null;
  }
  return electronMod;
}

/** 有没有这个文件（普通文件才算，目录/无权限一律当没有）。 */
function isReadableFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/**
 * 决定卡片背景图用哪个文件，找不到就返回 ''（退回纯色卡片）。
 *
 * 顺序：
 *   1. 技能设置里的「背景图」——填本地路径，或填 http(s) 网址（会下载到临时目录）
 *   2. 技能自带的 assets/background.jpg（想换背景图，直接把图改名丢进去即可）
 * 注意：第 2 条依赖 index.js 用 file:// 被 import（加载器就是这么加载的），
 * 所以 import.meta.url 就是技能目录里的位置。两条都不是可发图 URL，只是取图来源，
 * 真正发图走的是 sender.sendImage 的本地路径通道。
 */
async function resolveBackgroundFile(cfg) {
  const assetFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets', 'background.jpg');

  const configured = String(cfg?.backgroundImage || '').trim();
  if (configured) {
    // 填的是网址：下载到临时目录再用（下载失败就继续看自带图）
    if (/^https?:\/\//i.test(configured)) {
      try {
        const res = await fetch(configured, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 1024) throw new Error('文件太小，不像是图片');
        const dir = path.join(os.tmpdir(), 'qqagent-pcstatus');
        fs.mkdirSync(dir, { recursive: true });
        const dst = path.join(dir, `bg-src-${process.pid}.img`);
        fs.writeFileSync(dst, buf);
        return dst;
      } catch (error) {
        note(`设置里的背景图网址取不到（${error?.message ?? error}），改用自带背景图/纯色`);
      }
    } else {
      const p = path.resolve(configured);
      if (isReadableFile(p)) return p;
      note(`设置里的背景图路径不可读：${p}，改用自带背景图/纯色`);
    }
  }

  if (isReadableFile(assetFile)) return assetFile;
  return '';
}

async function trySendCard(ctx, r, cfg) {
  const d = r.d || {};
  // 每一步失败都把**具体原因**记进日志：之前只写"渲染失败"，用户报问题时
  // 无从判断是拿不到 Electron、量高失败、截图为空，还是发送被拦 —— 排查全靠猜。
  const why = [];
  if (!ctx?.sender || typeof ctx.sender.sendImage !== 'function' || !ctx?.chatKey) {
    // 这是"卡片模式没有发图通道"的正常情况（例如本地调试），不是故障，只在日志留一行
    note('卡片模式不可用：当前上下文没有 sender.sendImage 或 chatKey，本次走文字版');
    return false;
  }

  const theme = cfg.cardTheme === 'light' ? 'light' : 'dark';
  const W = CARD_W;
  let pngPath = null;
  try {
    // ⚠️ 这里**不能提前 return**：曾经在"拿不到 electronModule"时直接返回，
    //    结果连一行日志都没有，用户报"还是发文字"时完全无从判断卡在哪一步。
    //    现在每一步失败都记进 why，最后统一打一条能定位的日志。
    const el = await electronModule();
    if (!el) why.push('拿不到 Electron 模块');

    // ── 找背景图：设置里的路径 / 网址 → 技能自带 assets/background.jpg ──
    const bgFile = await resolveBackgroundFile(cfg);
    if (!bgFile) why.push('没有可用背景图');

    // ── 第一步：先量高度。卡片高度由内容决定，背景图必须按这个比例裁才对准 ──
    let cardH = 0;
    if (el) {
      const blank = buildCardHtml(d, cfg, theme, '', 0);
      const h = await measureHtmlHeight(el, blank, W, theme);
      cardH = h > 120 ? h : 0;
      if (!cardH) why.push('量高失败（返回 0）');
    }

    // ── 第二步：裁好背景图，再出最终 HTML 并截图 ──
    let bgUri = '';
    if (bgFile && cardH) {
      bgUri = await cropBackground(bgFile, W, cardH);
      if (!bgUri) why.push('背景图裁切失败');
    }
    const html = buildCardHtml(d, cfg, theme, bgUri, cardH);
    const png = await renderCardPng(html, theme, cardH);
    if (!png) {
      why.push('截图返回空');
      warn(`卡片渲染失败：${why.join('；')}。本次改用文字。`
        + '若一直如此：把「整机状态发什么」设成纯文本，或把「回复形态」改成短文本即可绕过');
      return false;
    }
    if (why.length) note(`卡片已出图，但有降级项：${why.join('；')}`);

    // 落盘再发：sendImage 优先让协议端按路径读盘（body 从 ~2.5MB 降到 ~100 字节），
    // 同时带 base64 兜底。地址里带随机段，避免同目录多实例互相覆盖。
    const dir = path.join(os.tmpdir(), 'qqagent-pcstatus');
    fs.mkdirSync(dir, { recursive: true });
    pngPath = path.join(dir, `card-${process.pid}-${Date.now()}.png`);
    fs.writeFileSync(pngPath, png);

    // ⚠️ 变量名别叫 note：它会遮蔽上面那个 note() 日志函数，
    //    导致成功日志静默抛错（被 catch 吃掉），排查时看不到任何线索。
    const imgNote = `🖥️ ${d.host || '本机'} 状态（已开机 ${zhDur(d.uptimeSec)}）`;
    await ctx.sender.sendImage(
      ctx.chatKey,
      { file: pngPath, dataUrl: 'base64://' + png.toString('base64') },
      { note: imgNote }
    );
    try {
      ctx.session?.sent?.push({ type: 'image', text: `[${imgNote}]`, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
    } catch { /* 留档失败不影响发送结果 */ }
    note(`状态卡片已发出（${bgUri ? '照片背景' : '纯色背景'}，预设高 ${cardH || '实测'}，`
      + `出图 ${png.length ? Math.round(png.length / 1024) : 0} KB`
      + (lastRenderInfo ? `，窗口 ${lastRenderInfo.winW}x${lastRenderInfo.winH}、页面 ${lastRenderInfo.docH}、图 ${lastRenderInfo.imgW}x${lastRenderInfo.imgH}` : '')
      + '）');
    return true;
  } catch (error) {
    warn(`卡片发送失败：${error?.message ?? error}`);
    return false;
  } finally {
    // 图已发完就没用了，及时删掉。⚠️ 必须放在 await sendImage 之后：
    // 协议端是"按路径读盘"的，提前删会让发送读到空文件。
    if (pngPath) { try { fs.unlinkSync(pngPath); } catch { /* 忽略 */ } }
  }
}

/** 指定软件 → 给模型看的内容。 */
function renderQuery(r, target, cfg) {
  const d = r.d || {};
  const matched = asArray(d.matched);
  const isCompact = cfg.replyStyle !== 'detail';

  let readyLine;
  if (matched.length) {
    readyLine = matched.length === 1
      ? `${target}：${qaLine(matched[0])}`
      : `${target}（匹配到 ${matched.length} 个程序）\n` + matched.map((a) => `· ${a.n}：${qaLine(a)}`).join('\n');
  } else {
    readyLine = `「${target}」现在没有在运行，所以查不到运行时长。`;
  }

  const notes = [];
  if (matched.length) {
    notes.push('说明：括号里第一个数字是该程序名下的进程数，内存是这些进程的合计；'
      + '「已运行」取的是最早启动的那个进程，也就是这个程序本次启动至今的时长。');
  } else {
    const gaps = asArray(d.gaps).filter(Boolean);
    if (gaps.length) notes.push(`尝试匹配的进程名：${gaps.join('、')}。`);
  }
  const up = Number(d.uptimeSec) || 0;
  if (up > 0) notes.push(`参考：这台电脑已开机 ${zhDur(up)}。`);

  if (isCompact) {
    return `${SEND_BEGIN}\n${readyLine}\n${SEND_END}\n\n`
      + `【补充明细（给你回答追问用，不要主动发出去）】\n${notes.join('\n')}`;
  }
  return `【软件运行情况：${target}】\n${readyLine}\n${notes.join('\n')}\n`
    + '（以上是本次实测值，请照实回答。）';
}

export function setup(_api) {
  api = _api;
  cfgOf = () => ({ ...DEFAULTS, ...(api.config?.() || {}) });

  api.registerTool({
    id: 'pc_status',
    name: '查电脑状态',
    description:
      '查询运行着机器人的这台 Windows 电脑的实时状态，数据来自系统本身。'
      + 'target 有两种用法：'
      + '① system = 整机概况（CPU 占用、内存、硬盘剩余、显卡、开机时长，以及最占内存的几个程序，'
      + '附带 QQ Agent 自身占用的内存与已运行时长）；'
      + '② 直接填应用名 = 只看这个软件（进程数、合计内存、已运行时长），'
      + '例如「微信」「QQ」「Steam」「Chrome」「Code」，写进程名 WeChat.exe 或中文名都可以。'
      + '群友问「电脑卡不卡」「内存/CPU/硬盘还剩多少」「开机多久了」「微信/某游戏开了多久」'
      + '「QQ Agent 跑了多久」时用它 —— 不要凭印象猜这些数字。'
      + '【返回怎么用】返回里有一段被 == 包起来的「可直接原样发出」的文字，'
      + '把它整段照抄发一条消息即可，不要拆成多条、也不要逐行念（群里刷屏很难看）；'
      + '它后面的「补充明细」只留着自己回答追问，不要发出去。'
      + '注意：只能查这台跑机器人的电脑，查不到别人自己的手机或电脑。',
    category: 'query',
    icon: '🖥️',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: '要查什么。填 system 看整机概况；填应用名（如「微信」或 WeChat.exe）只看该软件的进程数、内存与已运行时长。'
        }
      },
      required: ['target']
    },
    async execute(ctx, args) {
      const cfg = cfgOf();
      const replyStyle = ['detail', 'card'].includes(cfg.replyStyle) ? cfg.replyStyle : 'compact';
      const raw = String(args?.target ?? '').trim();
      const isSystem = !raw || /^(system|all|整体|全部|概况|电脑|整机|overview)$/i.test(raw);

      const common = {
        topN: num(cfg.topN, 1, 12, DEFAULTS.topN),
        timeoutMs: num(cfg.timeoutMs, 5000, 60000, DEFAULTS.timeoutMs),
        // 只有真的要显示显卡占用时才多花那一秒去采 GPU 引擎计数器
        wantGpu: cfg.showGpuUsage === true,
        wantSelf: cfg.showSelfProc !== false
      };

      try {
        const r = isSystem
          ? await collect(common)
          : await collect({ ...common, targets: raw });
        if (!r.ok) {
          const what = isSystem ? '电脑状态' : `「${raw}」的运行情况`;
          return { content: `读取${what}失败：${r.error}。请如实告诉群友这次没查到，不要编数字。`, isError: true };
        }

        // ── 卡片图模式：整机状态才画卡片（单个软件本来就只有一行，画图反而更重）──
        // sendAs='text' 时直接跳过画图，走下面的文字版（用户可显式选择不画图）。
        if (cfg.sendAs !== 'text' && replyStyle === 'card' && isSystem) {
          const sent = await trySendCard(ctx, r, cfg);
          if (sent) {
            // ⚠️ 这里**故意不给**「可直接原样发出」那段文字。
            //    曾经给过，结果是：图已经发出去了，模型还是把那段文字照抄发了一遍，
            //    群里变成"一条图 + 一大段重复数据"（用户实拍反馈两次）。
            //    给的文字越像"该发出去的东西"，模型越会发它 —— 所以成功路径干脆不给可发文案，
            //    只留一句"已经发完了，调 finish 收尾"，让模型没有东西可发。
            return {
              content: `【状态卡片图已由工具直接发到群里了——这一轮不要再发任何消息】\n`
                + `图上已经写全了 CPU、内存、硬盘、最占内存的程序、QQ Agent 自身的占用与运行时长，`
                + `**没有需要你补的话，也不要复述图上的任何数字**。请直接调用 finish 收尾`
                + `（summary 写「状态卡片已发送」即可）。\n`
                + `只有在群友明确追问同一个数据、而图上确实没有时才开口。\n\n`
                + `【以下明细仅用于回答后续追问，不要主动发出去】\n${detailLines(r, cfg).join('\n')}`
            };
          }
          // 画图/发图任一环节失败：不给模型留"图发了"的错觉，直接退回文字版。
          // 具体原因已由 trySendCard 记进日志，这里不重复刷一条。
        }

        return {
          content: isSystem
            ? renderSummary(r, { ...cfg, replyStyle })
            : renderQuery(r, raw, { ...cfg, replyStyle })
        };
      } catch (error) {
        return { content: `读取电脑状态时出错：${error?.message ?? error}。请如实告诉群友这次没查到。`, isError: true };
      }
    }
  });

  note('电脑状态 Skill 已加载：工具 pc_status（system / 应用名）');
}

export function dispose() {
  // 没有后台定时器或监听器要收尾：每次查询都是一次性跑几条系统命令 → 拼图 → 发送，不留驻。
}

// ── 给 tools/ 下的自测脚本用（加载器只关心 setup/dispose，多导几个不影响它）──
export const __internals = { buildCardHtml, cropBackground, trySendCard, electronModule, collectSnapshot, collect, CARD_THEME, CARD_W };
