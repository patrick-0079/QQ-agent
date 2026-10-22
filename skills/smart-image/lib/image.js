// 图片工具：格式嗅探（取真实分辨率）、下载校验、落盘。
//
// 为什么必须"下载下来自己看"再发：
//   搜索引擎给的直链有三类坑 —— ①防盗链 403 ②图已删 404 ③返回一个 HTML
//   错误页（HTTP 200 + text/html，最阴的一种）。只把 URL 甩给协议端的话，
//   用户看到的就是一张裂图或者空白，而我们连"失败了"都不知道。
//   所以这里统一：下载 → 认格式 → 量尺寸 → 太小的丢掉 → 落盘 → 发本地文件。
//
// 这样做顺带拿到两个能力：
//   · "高清"可以真正落实 —— 按**实测**分辨率排序，而不是信搜索接口的标称值
//     （百度标称 3552x4720，实际只给 500x664 的缩略图，只能靠实测识破）。
//   · "每次不同"可以按**内容指纹**去重 —— 同一张图挂在十个不同 URL 上也认得出来。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/** 带真实 UA：图片站对非浏览器 UA 常直接 403，或返回空 body。 */
export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export const TMP_DIR = path.join(os.tmpdir(), 'qq-agent-smart-image');

/**
 * 从字节流里嗅出真实格式与分辨率，认不出返回 null。
 *
 * 只认魔数、不信任 Content-Type —— 出错时服务器经常回一个
 * `200 + text/html` 的错误页，只看响应头会把它当图片。
 */
export function sniffSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;

  // PNG：IHDR 的大端宽高在固定偏移
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { format: 'png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  // GIF87a / GIF89a：小端
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { format: 'gif', w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }
  // BMP：高度可能为负（表示自上而下），取绝对值
  if (buf[0] === 0x42 && buf[1] === 0x4d) {
    return { format: 'bmp', w: Math.abs(buf.readInt32LE(18)), h: Math.abs(buf.readInt32LE(22)) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) return sniffJpeg(buf);
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    return sniffWebp(buf);
  }
  return null;
}

/** JPEG：逐段跳到 SOFn（帧头），宽高在里面。C4/C8/CC 是其它表，不是帧头。 */
function sniffJpeg(buf) {
  let p = 2;
  while (p + 9 < buf.length) {
    if (buf[p] !== 0xff) { p += 1; continue; }
    const marker = buf[p + 1];
    // 单字节标记（无长度字段）：填充、RSTn、SOI/EOI
    if (marker === 0xff) { p += 1; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
    const len = buf.readUInt16BE(p + 2);
    if (len < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return { format: 'jpeg', h: buf.readUInt16BE(p + 5), w: buf.readUInt16BE(p + 7) };
    }
    p += 2 + len;
  }
  return null;
}

/** WebP 三种容器：VP8X（扩展，24 位宽高）、VP8（有损，解 frame header）、VP8L（无损，14 位）。 */
function sniffWebp(buf) {
  const fourcc = buf.toString('latin1', 12, 16);
  try {
    if (fourcc === 'VP8X') {
      return {
        format: 'webp',
        w: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
        h: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16))
      };
    }
    if (fourcc === 'VP8 ') {
      // 有损：起始码 0x9d 0x01 0x2a，其后 2 字节小端是宽高（低 14 位有效）
      for (let i = 20; i < Math.min(buf.length - 9, 40); i++) {
        if (buf[i] === 0x9d && buf[i + 1] === 0x01 && buf[i + 2] === 0x2a) {
          return {
            format: 'webp',
            w: buf.readUInt16LE(i + 3) & 0x3fff,
            h: buf.readUInt16LE(i + 5) & 0x3fff
          };
        }
      }
    }
    if (fourcc === 'VP8L') {
      // 无损：第 21 字节起 4 字节小端，宽高各 14 位（各减 1）
      const bits = buf.readUInt32LE(21);
      return { format: 'webp', w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
    }
  } catch { /* 结构异常就当认不出 */ }
  return null;
}

/** 内容指纹：同一张图挂在不同 URL 上也认得出（"每次不同"靠它兜底）。 */
export function contentHash(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20);
}

/** URL 指纹：下载前的廉价去重（省流量），和内容指纹配合使用。 */
export function urlHash(url) {
  return crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 20);
}

/**
 * 下载一个候选图并校验，成功返回 { buf, w, h, format, hash, bytes, contentType }。
 *
 * @param {Function} httpFetch api.fetch
 * @param {string} url
 * @param {{ timeoutMs?: number, maxBytes?: number, headerTease?: boolean }} opts
 */
export async function downloadImage(httpFetch, url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 7000;
  const maxBytes = opts.maxBytes ?? 12 * 1024 * 1024;
  const resp = await httpFetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'User-Agent': UA,
      'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      // 多带一个 Referer：一部分图床**只**拦 Referer 为空/异常的请求
      'Referer': new URL(url).origin + '/'
    },
    signal: abortAfter(timeoutMs)
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const declared = Number(resp.headers?.get?.('content-length') || 0);
  if (declared && declared > maxBytes) throw new Error(`文件过大（${Math.round(declared / 1048576)}MB）`);

  const buf = Buffer.from(await resp.arrayBuffer());
  if (!buf.length) throw new Error('空响应');
  if (buf.length > maxBytes) throw new Error(`文件过大（${Math.round(buf.length / 1048576)}MB）`);

  const size = sniffSize(buf);
  if (!size) {
    // 认不出魔数：可能是 HTML 错误页 / JSON / 冷门格式。宁可不发，也不要发裂图。
    const head = buf.toString('latin1', 0, 32).replace(/[\x00-\x1f]/g, ' ').trim();
    throw new Error(`不是可识别的图片（开头是 ${JSON.stringify(head.slice(0, 24))}）`);
  }
  if (!size.w || !size.h) throw new Error('尺寸异常');
  if (size.w > 20000 || size.h > 20000) throw new Error(`尺寸异常（${size.w}x${size.h}）`);

  return {
    buf,
    w: size.w,
    h: size.h,
    format: size.format,
    bytes: buf.length,
    hash: contentHash(buf),
    contentType: String(resp.headers?.get?.('content-type') || '')
  };
}

/** 落盘到临时目录，返回本地路径（发图时传路径 → 协议端读盘，body 只有百来字节）。 */
export function saveTemp(buf, format) {
  const ext = ({ jpeg: 'jpg', png: 'png', gif: 'gif', webp: 'webp', bmp: 'bmp' })[format] || 'img';
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const file = path.join(TMP_DIR, `${contentHash(buf)}.${ext}`);
  try {
    fs.writeFileSync(file, buf);
  } catch (error) {
    throw new Error(`写盘失败：${error?.message ?? error}`);
  }
  return file;
}

/** 清理临时目录里过期的图（默认 2 天），避免无限堆积。失败不抛。 */
export function sweepTemp(maxAgeMs = 48 * 3600 * 1000) {
  try {
    if (!fs.existsSync(TMP_DIR)) return;
    const now = Date.now();
    for (const name of fs.readdirSync(TMP_DIR)) {
      const p = path.join(TMP_DIR, name);
      try {
        if (now - fs.statSync(p).mtimeMs > maxAgeMs) fs.unlinkSync(p);
      } catch { /* 单个文件失败忽略 */ }
    }
  } catch { /* 目录不可用忽略 */ }
}

/** 超时信号：不设上限时，一个挂住的图床会拖着整轮对话。 */
export function abortAfter(ms) {
  return (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function')
    ? AbortSignal.timeout(ms)
    : undefined;
}

/**
 * 只放行公网 http(s) 直链。
 *
 * 为什么搜图也要挡内网：这些地址会被本进程下载、还会交给协议端去取。
 * 如果搜到一条指向 127.0.0.1 / 内网段的地址，等于替我们打内网 ——
 * 与项目里其它联网模块的 SSRF 防护口径保持一致。
 */
export function isPublicHttpUrl(u) {
  if (!/^https?:\/\//i.test(String(u || ''))) return false;
  let host = '';
  try { host = new URL(u).hostname.toLowerCase(); } catch { return false; }
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (/^(127|10|0)\./.test(host)) return false;
  if (/^192\.168\./.test(host)) return false;
  if (/^169\.254\./.test(host)) return false;
  const m = host.match(/^172\.(\d{1,3})\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return false;
  if (host.includes(':')) return false;   // IPv6 字面量（含 ::1）
  return true;
}
