// 统一文件存储原语：原子写、JSONL 追加/读取。
//
// 设计目标：
//   · 崩溃安全：写 JSON 一律 tmp + rename；JSONL 允许最后一行是半行，读取时忽略。
//   · 零依赖：只用 node:fs / node:path。
//   · 可解释：所有调用方共享同一套错误语义（读失败返回 fallback，不抛）。
import fs from 'node:fs';
import path from 'node:path';

/** 递归建目录（幂等）。 */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * 读 JSON；任何异常（不存在/半截/权限）都返回 fallback。
 * 调用方需要区分"文件不存在"和"文件坏了"时，用 readJsonResult。
 */
export function readJsonSafe(file, fallback = null) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const value = JSON.parse(text);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

/** 读 JSON 并带上状态：{ ok, value, reason }。 */
export function readJsonResult(file) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return { ok: true, value: JSON.parse(text), reason: '' };
  } catch (error) {
    return { ok: false, value: null, reason: String(error?.code || error?.message || error) };
  }
}

/**
 * 原子写：先写同目录临时文件，再 rename 覆盖目标。
 * value 是字符串时原样写入（JSONL/文本也走这里）；否则按 JSON 序列化。
 *
 * @param {string} file
 * @param {unknown} value
 * @param {{ fsync?: boolean, pretty?: boolean|number }} [options]
 */
export function writeJsonAtomic(file, value, { fsync = false, pretty = 1 } = {}) {
  ensureDir(path.dirname(file));
  const text = typeof value === 'string'
    ? value
    : JSON.stringify(value, null, pretty === false ? 0 : pretty);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, text, 'utf8');
    if (fsync) fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/** 文件是否以换行结尾；不存在视为 true（无需补）。 */
function endsWithNewline(file) {
  try {
    const st = fs.statSync(file);
    if (!st.size) return true;
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(1);
      fs.readSync(fd, buf, 0, 1, st.size - 1);
      return buf[0] === 0x0a;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return true;
  }
}

/**
 * 追加一行 JSON。
 *
 * 崩溃留下的半行会导致下一次追加拼在坏行后面 —— 这里在追加前检查
 * 文件末字节，不是 \n 就先补一个换行，坏行只影响它自己那一行。
 * 单进程串行调用（Node 事件循环）下不会出现两行交错。
 */
export function appendJsonl(file, obj) {
  ensureDir(path.dirname(file));
  const prefix = endsWithNewline(file) ? '' : '\n';
  fs.appendFileSync(file, prefix + JSON.stringify(obj) + '\n', 'utf8');
}

/**
 * 读取 JSONL。
 *
 * @param {string} file
 * @param {{ tolerateTail?: boolean, limit?: number }} [options]
 *   tolerateTail=true：最后一行解析失败时静默忽略（崩溃半行）；
 *   中间行解析失败也跳过，但会在返回值的 badLines 里计数。
 * @returns {any[] & { badLines?: number }}
 */
export function readJsonl(file, { tolerateTail = true, limit = Infinity } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split('\n');
  const out = [];
  let badLines = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      badLines += 1;
      // 最后一行（或末尾空行前的最后一段）允许是崩溃半行
      if (!(tolerateTail && i >= lines.length - 1)) {
        // 中间坏行：跳过，继续读后面的有效行
      }
    }
    if (out.length >= limit) break;
  }
  if (badLines) Object.defineProperty(out, 'badLines', { value: badLines, enumerable: false });
  return out;
}

/** 文件大小（不存在返回 0）。 */
export function fileSize(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}
