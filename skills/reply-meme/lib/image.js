import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readBytes } from './network.js';

export const fingerprint = (value) => crypto.createHash('sha256').update(value).digest('hex');

// Header/size checks reject HTML error pages. They do not fully decode the image.
export function sniffSize(b) {
  if (!Buffer.isBuffer(b) || b.length < 24) return null;
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && b.toString('ascii', 12, 16) === 'IHDR') {
    return { format: 'png', w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  }
  if (/^GIF8[79]a$/.test(b.toString('ascii', 0, 6))) return { format: 'gif', w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  if (b[0] === 255 && b[1] === 216) {
    let p = 2;
    while (p + 4 <= b.length) {
      if (b[p] !== 255) { p++; continue; }
      const marker = b[p + 1];
      if (marker === 255) { p++; continue; }
      if (marker === 217 || marker === 218) break;
      if (marker === 216 || marker === 1 || (marker >= 208 && marker <= 215)) { p += 2; continue; }
      const length = b.readUInt16BE(p + 2);
      if (length < 2 || p + 2 + length > b.length) return null;
      if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) {
        if (length < 8) return null;
        return { format: 'jpeg', h: b.readUInt16BE(p + 5), w: b.readUInt16BE(p + 7) };
      }
      p += 2 + length;
    }
  }
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = b.toString('ascii', 12, 16);
    if (chunk === 'VP8X' && b.length >= 30) return { format: 'webp', w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
    if (chunk === 'VP8L' && b.length >= 25 && b[20] === 47) {
      const bits = b.readUInt32LE(21);
      return { format: 'webp', w: 1 + (bits & 16383), h: 1 + ((bits >>> 14) & 16383) };
    }
    if (chunk === 'VP8 ' && b.length >= 30 && b[23] === 157 && b[24] === 1 && b[25] === 42) {
      return { format: 'webp', w: b.readUInt16LE(26) & 16383, h: b.readUInt16LE(28) & 16383 };
    }
  }
  return null;
}

export async function downloadImage(httpFetch, url, timeoutMs, signal) {
  const buf = await readBytes(httpFetch, url, { timeoutMs, accept: 'image/*', signal });
  const size = sniffSize(buf);
  if (!size || !size.w || !size.h || size.w > 20000 || size.h > 20000) throw new Error('不是支持的图片，或图片尺寸异常');
  return { ...size, buf, bytes: buf.length, hash: fingerprint(buf) };
}

export function saveImage(directory, item) {
  const dir = path.join(directory, 'images');
  fs.mkdirSync(dir, { recursive: true });
  const ext = item.format === 'jpeg' ? 'jpg' : item.format;
  const file = path.join(dir, `${item.hash}.${ext}`);
  fs.writeFileSync(file, item.buf);
  return file;
}
