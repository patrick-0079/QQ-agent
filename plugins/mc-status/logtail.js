/**
 * logtail —— 服务器日志读取（两种通道）+ 报错提取
 *
 * 为什么要这个模块：RCON 只能执行命令、拿命令响应，**拿不到服务器控制台输出**
 * （这是 Source RCON 协议的硬限制，不是实现问题）。想看服务器发生了什么、
 * 尤其是「刚才为什么崩了」，只有读日志这一条路。
 *
 * 两种通道，覆盖不同部署：
 *   file  直接读日志文件（服务器在本机 / 局域网共享 / 映射盘）—— 最省事，实时
 *   http  GET 一个 HTTP 端点（服务端装桥接插件，见 server-bridge/）—— 远端租用服适用
 *
 * ⚠️ 日志是**服务器和玩家都能写进去的任意文本**（玩家名、聊天内容都在里面），
 *    会流进 AI 上下文再发到 QQ。所以：
 *    1. 这里只做**提取和截断**，不做任何 HTML 拼接 —— 转义由渲染层负责
 *    2. 长度一律设上限：一次查询最多喂给模型几千字符，否则既费 token 又淹没有用信息
 *    3. token 不进 URL query（会留在服务端访问日志里），走请求头
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';

/** 单次最多读多少字节（文件尾部）。再大的日志对分析也没意义，还卡 I/O */
const MAX_READ_BYTES = 512 * 1024;
/** 最多喂给模型多少字符 —— 超了就截断并标注 */
export const MAX_OUTPUT_CHARS = 3000;

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

/* ── 通道 1：本地/共享文件 ────────────────────────────────── */

/**
 * 读文件**尾部**若干行。
 *
 * ⚠️ 不能 readFileSync 整个文件再 split：MC 的 latest.log 动辄几百 MB，
 *    全读进来会把机器人卡死。做法是从文件末尾往回读一个窗口（512KB），
 *    窗口起点切在多字节字符中间也没关系——第一行本来就不完整，直接丢掉。
 */
export async function tailFileLines(filePath, maxLines = 200) {
  const p = String(filePath || '').trim();
  if (!p) return { ok: false, error: '没填日志文件路径' };

  let fh;
  try {
    fh = await fsp.open(p, 'r');
  } catch (e) {
    const code = e?.code;
    return { ok: false, error: code === 'ENOENT' ? `日志文件不存在：${p}`
      : code === 'EACCES' ? `没有权限读日志：${p}`
        : `读日志失败：${String(e?.message || e)}` };
  }

  try {
    const stat = await fh.stat();
    if (stat.isDirectory()) return { ok: false, error: `填的是目录不是文件：${p}` };
    const size = stat.size;
    const start = Math.max(0, size - MAX_READ_BYTES);
    const len = size - start;
    if (len <= 0) return { ok: true, lines: [], truncated: false, fileSize: size };

    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, start);
    let text = buf.toString('utf8');
    // 起点可能切在半个字中间，第一行不完整 —— 丢掉第一行（文件没被从头读完时才需要）
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    const lines = splitLines(text);
    const keep = Math.max(1, num(maxLines, 200));
    const sliced = lines.length > keep ? lines.slice(lines.length - keep) : lines;
    return { ok: true, lines: sliced, truncated: lines.length > keep, fileSize: size };
  } catch (e) {
    return { ok: false, error: `读日志失败：${String(e?.message || e)}` };
  } finally {
    try { await fh.close(); } catch { /* 关不掉不影响，句柄会随 GC 释放 */ }
  }
}

/** 按行切，兼容 \r\n 和 \n；末尾空行丢掉 */
export function splitLines(text) {
  const raw = String(text ?? '').split(/\r?\n/);
  while (raw.length && raw[raw.length - 1] === '') raw.pop();
  return raw;
}

/* ── 通道 2：HTTP 桥接 ───────────────────────────────────── */

/**
 * 从 HTTP 端点拉日志（服务端桥接插件提供）。
 * 响应支持三种形态：纯文本、{"text":"..."}、{"lines":["..."]}。
 *
 * ⚠️ token 走 X-MC-Log-Token 请求头而不是 query 参数：
 *    URL 会被服务端写进访问日志/代理日志，放 query 等于把凭据明文存一份在别人机器上。
 */
export async function fetchHttpLog({ url, token = '', timeout = 5000, fetchRef, host = '', port = '' } = {}) {
  const tpl = String(url || '').trim();
  if (!tpl) return { ok: false, error: '没填日志接口地址' };
  if (!fetchRef) return { ok: false, error: '插件未声明 web_fetch 权限，拿不到 fetch' };

  const finalUrl = tpl
    .replace(/\{host\}/g, encodeURIComponent(String(host || '')))
    .replace(/\{port\}/g, encodeURIComponent(String(port || '')));

  const headers = {};
  if (token) headers['X-MC-Log-Token'] = String(token);

  let res;
  try {
    res = await fetchRef(finalUrl, { headers, timeout: Math.max(1000, num(timeout, 5000)) });
  } catch (e) {
    return { ok: false, error: `日志接口请求失败：${String(e?.message || e)}` };
  }
  if (!res || res.ok === false) {
    return { ok: false, error: `日志接口返回 ${res?.status ?? '异常'}` };
  }

  let text = '';
  try {
    const ct = String(res.headers?.get?.('content-type') || '');
    text = ct.includes('json') ? await res.json() : await res.text();
  } catch {
    return { ok: false, error: '日志接口返回的内容解析不了' };
  }

  let lines;
  if (typeof text === 'string') lines = splitLines(text);
  else if (Array.isArray(text?.lines)) lines = text.lines.map((x) => String(x));
  else if (typeof text?.text === 'string') lines = splitLines(text.text);
  else return { ok: false, error: '日志接口返回格式不认识（要纯文本，或 {"lines":[...]}）' };

  return { ok: true, lines };
}

/* ── 筛选与报错提取 ──────────────────────────────────────── */

/**
 * 一行日志的**级别**（统一大写），认不出来返回空串。
 *
 * ⚠️ 为什么要单独抽这个函数：MC 生态里至少三种级别写法，散写在正则里迟早漏一种，
 *    而漏的后果是"日志里明明有报错，工具却说没找到" —— 假阴性比报错本身更糟
 *    （用户会以为服务器一直很健康）。三种写法：
 *      1）Java 版（原版/Paper/Spigot）：[12:00:00] [Server thread/ERROR]:
 *      2）Cuberite 控制台输出（stdout，被 systemd 抓进 cuberite.log 的就是它）：Error: [12:00:00]
 *      3）Cuberite 文件日志（logs/LOG_*.txt）：Err  [12:00:00]  ← 缩写 + 两个空格，最容易被漏
 *    实测依据：Cuberite src/LoggerListeners.cpp —— cFileListener 写 "Err  "，
 *    cVanillaCPPConsoleListener 写 "Error: "。
 */
export function logLevelOf(line) {
  const l = String(line ?? '');
  let m = l.match(/\[[^\]]*\/([A-Z]+)\]/i);                       // [.../ERROR]
  if (m) return m[1].toUpperCase();
  m = l.match(/^\s*([A-Za-z]+)\s*[:：]?\s*\[\d{1,2}:\d{2}/);      // Error: [12:00] / Err  [12:00] / Warn [12:00]
  if (m) return m[1].toUpperCase();
  m = l.match(/^\s*\[([A-Z]+)\]/i);                               // [ERROR] 少数服务端的写法
  if (m) return m[1].toUpperCase();
  return '';
}

/** 算「报错」的级别集合（Info/Log 不算） */
const ERROR_LEVELS = new Set(['ERROR', 'ERR', 'SEVERE', 'FATAL', 'CRITICAL']);
/** 算「警告」的级别集合 —— Cuberite 把插件错误写成 Warn，得再看内容决定（见 looksLikeFailure） */
const WARN_LEVELS = new Set(['WARN', 'WARNING']);

/**
 * Warn 行里哪些是**真故障**。
 *
 * ⚠️ 为什么 Warn 也要挑着认（2026-09-24 实测）：Cuberite 把插件错误**写成 Warn**，
 *    比如 `Warn [19:37:06] LUA: Plugins/X/X.lua:4: ...`、`Warn [...] Error in plugin X ...`。
 *    只认 ERROR/Err 的话，服务器上插件真崩了，工具照样回"没找到报错"。
 *    但 Warn 里也混着一堆无害提示（"Cannot open file ... recipes.txt"、
 *    "spawning in a non-existent chunk"），全算报错会把真故障淹掉 ——
 *    所以按**故障关键字**挑，而不是按级别一刀切。
 */
const FAILURE_HINTS = /(LUA:|Error in plugin|Cannot call|Failed to|Exception|Lua error|error in\b)/i;

/** 这一行**内容**看起来像故障吗（Warn 级别的二次判定） */
export function looksLikeFailure(line) {
  return FAILURE_HINTS.test(String(line ?? ''));
}

/** 关键词过滤（大小写不敏感，多个词用空格分隔=AND） */
export function filterLines(lines, keyword) {
  const k = String(keyword || '').trim();
  if (!k) return { lines: lines.slice(), matched: lines.length };
  const words = k.split(/\s+/).map((w) => w.toLowerCase());
  const out = lines.filter((l) => {
    const low = String(l).toLowerCase();
    return words.every((w) => low.includes(w));
  });
  return { lines: out, matched: out.length };
}

/**
 * 一行是不是「报错行」。
 * 认四种形态：级别是 ERROR/ERR/SEVERE/FATAL 的日志条目（Java 版和 Cuberite 两种写法）、
 * 异常类名行、裸 Error: 行、Caused by 行。
 */
export function isErrorStart(line) {
  const l = String(line ?? '');
  const lv = logLevelOf(l);
  if (ERROR_LEVELS.has(lv)) return true;
  // Cuberite 的插件错误是 Warn 级别：级别不够，靠内容补判
  if (WARN_LEVELS.has(lv) && looksLikeFailure(l)) return true;
  if (/^\s*[\w.$]*(Exception|Error|Throwable)\b/.test(l)) return true;
  if (/\bCaused by:/.test(l)) return true;
  return false;
}

/** 一行是不是「栈帧/续行」（报错块的组成部分，本身不算新错误） */
function isStackTrace(line) {
  const l = String(line ?? '');
  if (/^\s+at\s/.test(l)) return true;
  if (/^\s*\.\.\.\s*\d+\s+more/.test(l)) return true;
  if (/^\s*Suppressed:/.test(l)) return true;
  // Cuberite：栈帧也是一条条独立日志（Warn [hh:mm:ss]   [C](-1): error），
  // 靠"时间戳后多两个空格的缩进"认出来；Stack trace / Stack trace end 同理。
  // 不认的话，一次插件错误会被拆成六七段，AI 拿到的是一堆碎片。
  if (/^[A-Za-z]+\s*[:：]?\s*\[\d{1,2}:\d{2}(:\d{2})?\]\s{2,}\S/.test(l)) return true;
  if (/^[A-Za-z]+\s*[:：]?\s*\[\d{1,2}:\d{2}(:\d{2})?\]\s+(Stack trace|Stack trace end)\b/i.test(l)) return true;
  return false;
}

/** 取一行里的 [hh:mm:ss]，取不到返回空串（用于判断两条日志是不是同一秒） */
function secondOf(line) {
  const m = String(line ?? '').match(/\[(\d{1,2}:\d{2}:\d{2})\]/);
  return m ? m[1] : '';
}

/**
 * 一行是不是「一条新日志条目的开头」（带时间戳）。
 *
 * ⚠️ 为什么要区分：不区分的话，**连续两条** ERROR 会被吃进同一个块 ——
 *    第二条 ERROR 也满足 isErrorStart，于是被当成第一条的续行。
 *    结果两个独立故障被并成一个，去重也因此失效（表现为"服务器刷了两百次报错，
 *    工具却说只有一段"）。
 *    带时间戳 = 新条目，另起一块；Caused by / 裸异常类名才是当前块的续行。
 *
 * ⚠️ Cuberite 的条目开头是「级别 + 时间戳」（Err  [12:00:03] / Error: [12:00:03]），
 *    不是 Java 版的「[时间戳] [线程/级别]」—— 只认后者的话，Cuberite 连续两条
 *    Error 会被并成一段（2026-09-24 实测）。
 */
export function isLogEntryStart(line) {
  const l = String(line ?? '');
  if (/^\[\d{2}:\d{2}:\d{2}\]/.test(l)) return true;
  if (/^\[[^\]]*\/(ERROR|SEVERE|FATAL|WARN|INFO|DEBUG)\]/i.test(l)) return true;
  // Cuberite：级别写在方括号外面（Err  [12:00:03] / Error: [12:00:03] / Warn [12:00:03]）
  return !!logLevelOf(l) && /\[\d{1,2}:\d{2}/.test(l);
}

/**
 * 从日志行里提取报错块（报错行 + 跟着的栈帧），按最近优先返回。
 *
 * ⚠️ 为什么要聚合成「块」而不是逐行返回：单看一行
 *    「Could not pass event PlayerJoinEvent」是没法判断原因的，
 *    必须连着下面的 Caused by 和栈帧一起给，AI 才查得出所以然。
 * ⚠️ 为什么要去重：服务器崩一次会把同一个栈刷几十遍，不去重会把上下文占满、
 *    还让 AI 以为发生了几十个不同的问题。
 *
 * @returns {{blocks:Array<{head:string, lines:string[], times:number}>, total:number, scanned:number}}
 */
export function extractErrorBlocks(lines, { maxBlocks = 5, maxLinesPerBlock = 14 } = {}) {
  const arr = Array.isArray(lines) ? lines : [];
  const blocks = [];
  const seen = new Map(); // 签名 -> blocks 下标（去重）

  let i = 0;
  let scanned = 0;
  while (i < arr.length) {
    const line = String(arr[i] ?? '');
    if (isErrorStart(line)) {
      // 往后吃栈帧和紧跟着的 Caused by 链
      const chunk = [line];
      let j = i + 1;
      while (j < arr.length && chunk.length < maxLinesPerBlock) {
        const nx = String(arr[j] ?? '');
        if (isStackTrace(nx)) { chunk.push(nx); j++; continue; }
        // Caused by / 裸异常类名属于当前块；带时间戳的新日志条目要另起一块
        if (isErrorStart(nx) && !isLogEntryStart(nx)) { chunk.push(nx); j++; continue; }
        // Cuberite 把一次插件错误拆成好几条 Warn（LUA: / Stack trace / Error in plugin…），
        // 时间戳是同一秒 → 属于同一次事件，并进当前块，别拆成一堆碎片。
        // ⚠️ 只对 Warn 生效：Java 版的 ERROR 一行就是一次事件，合并不合适。
        if (isErrorStart(nx) && WARN_LEVELS.has(logLevelOf(nx))
            && secondOf(nx) && secondOf(nx) === secondOf(line)) {
          chunk.push(nx); j++; continue;
        }
        break;
      }
      const blockLines = chunk.slice(0, maxLinesPerBlock);
      // 签名取「异常类型 + 首条消息」的前 120 字符，够区分又不至于误判成同一个
      const sig = blockLines.join('\n').replace(/\[\d{2}:\d{2}:\d{2}\]/g, '')
        .replace(/\d+/g, '#').slice(0, 120);
      if (seen.has(sig)) {
        const idx = seen.get(sig);
        blocks[idx].times++;
      } else {
        seen.set(sig, blocks.length);
        blocks.push({ head: blockLines[0], lines: blockLines, times: 1 });
      }
      i = j;
      continue;
    }
    i++;
    scanned++;
  }

  // 最近的排前面（日志是时间正序写的）
  blocks.reverse();
  return {
    blocks: blocks.slice(0, Math.max(1, maxBlocks)),
    total: blocks.length,
    scanned: arr.length
  };
}

/**
 * 把待输出的内容截断到预算内。
 * @returns {{text:string, truncated:boolean, dropped:number}}
 */
export function clipText(lines, maxChars = MAX_OUTPUT_CHARS) {
  const budget = Math.max(200, num(maxChars, MAX_OUTPUT_CHARS));
  const arr = Array.isArray(lines) ? lines : [];
  const kept = [];
  let used = 0;
  for (const l of arr) {
    const s = String(l ?? '');
    if (used + s.length + 1 > budget) break;
    kept.push(s);
    used += s.length + 1;
  }
  return { text: kept.join('\n'), truncated: kept.length < arr.length, dropped: arr.length - kept.length };
}
