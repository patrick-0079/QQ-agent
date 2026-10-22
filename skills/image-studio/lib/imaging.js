// 纯像素运算：输入 / 输出都是 Electron `nativeImage.toBitmap()` 的 BGRA 缓冲。
//
// 为什么自己算而不是请一个图像库：
//   项目没有 sharp / jimp，也不能保证用户机器上装了 ffmpeg（实测这台机器就没有）。
//   而 Electron 自带 Chromium 的解码器 —— `nativeImage` 能把 png/jpg/webp 解成位图、
//   也能把位图重新编码，于是「解码 / 编码用原生，旋转翻转自己算」是最省依赖的路。
//
// 调用方（index.js）负责把 electron 的 nativeImage 传进来：本文件不 import electron，
// 这样在纯 Node 环境下也能直接对 Buffer 做单元测试。

/** 按文件头判断图片格式；认不出来返回 null（很多「图片链接」其实是网页）。 */
export function detectMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  const head6 = buf.toString('ascii', 0, 6);
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
  }
  return null;
}

/** 角度归一化：只认 0 / 90 / 180 / 270，其它一律当 0。 */
export function normalizeDegrees(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const deg = ((Math.round(n / 90) * 90) % 360 + 360) % 360;
  return deg === 90 || deg === 180 || deg === 270 ? deg : 0;
}

/** 旋转 BGRA 位图（顺时针）。返回新的 Buffer 与新的宽高。 */
export function rotateBitmap(bitmap, width, height, degrees) {
  const deg = normalizeDegrees(degrees);
  if (!deg) return { bitmap, width, height };
  const swap = deg === 90 || deg === 270;
  const nw = swap ? height : width;
  const nh = swap ? width : height;
  const out = Buffer.allocUnsafe(nw * nh * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let nx;
      let ny;
      if (deg === 90) { nx = height - 1 - y; ny = x; }
      else if (deg === 180) { nx = width - 1 - x; ny = height - 1 - y; }
      else { nx = y; ny = width - 1 - x; }
      const si = (y * width + x) * 4;
      const di = (ny * nw + nx) * 4;
      out[di] = bitmap[si];
      out[di + 1] = bitmap[si + 1];
      out[di + 2] = bitmap[si + 2];
      out[di + 3] = bitmap[si + 3];
    }
  }
  return { bitmap: out, width: nw, height: nh };
}

/** 镜像翻转。direction: horizontal（左右）/ vertical（上下）。 */
export function flipBitmap(bitmap, width, height, direction) {
  const horizontal = direction === 'horizontal';
  const vertical = direction === 'vertical';
  if (!horizontal && !vertical) return { bitmap, width, height };
  const out = Buffer.allocUnsafe(bitmap.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const nx = horizontal ? width - 1 - x : x;
      const ny = vertical ? height - 1 - y : y;
      const si = (y * width + x) * 4;
      const di = (ny * width + nx) * 4;
      out[di] = bitmap[si];
      out[di + 1] = bitmap[si + 1];
      out[di + 2] = bitmap[si + 2];
      out[di + 3] = bitmap[si + 3];
    }
  }
  return { bitmap: out, width, height };
}

/**
 * 转黑白（就地改写）。
 *
 * 半透明像素：位图可能是预乘 alpha 的，直接对三通道取亮度仍然成立
 * （线性缩放与亮度加权可交换），所以不需要额外还原 alpha。
 */
export function grayscaleBitmap(bitmap) {
  for (let i = 0; i < bitmap.length; i += 4) {
    const y = (0.299 * bitmap[i + 2] + 0.587 * bitmap[i + 1] + 0.114 * bitmap[i]) | 0;
    bitmap[i] = y;
    bitmap[i + 1] = y;
    bitmap[i + 2] = y;
  }
  return bitmap;
}

export const MAX_PIXELS = 60_000_000;

/**
 * 解码 → 旋转 → 翻转 → 黑白 → 缩放 → 重新编码。
 *
 * @param {object} nativeImage Electron 的 nativeImage（由调用方注入，便于测试）
 * @param {Buffer} buffer 原始图片字节
 * @param {string} mime detectMime 的结果
 * @param {{rotate?:number, flip?:string, grayscale?:boolean, maxSize?:number}} ops
 * @returns {{buffer:Buffer, mime:string, width:number, height:number}}
 */
export function transformImage(nativeImage, buffer, mime, ops = {}) {
  const img = nativeImage.createFromBuffer(buffer);
  if (!img || (typeof img.isEmpty === 'function' && img.isEmpty())) {
    throw new Error('图片解码失败（可能不是真图片，或格式不支持）');
  }
  let { width, height } = img.getSize();
  if (!width || !height) throw new Error('读不到图片尺寸');
  if (width * height > MAX_PIXELS) {
    throw new Error(`图片太大（${width}×${height}），超过处理上限，换一张小点的图`);
  }

  let bitmap = img.toBitmap();
  if (!Buffer.isBuffer(bitmap) || bitmap.length !== width * height * 4) {
    throw new Error('图片像素数据异常（尺寸与位图对不上）');
  }

  const deg = normalizeDegrees(ops.rotate);
  if (deg) {
    ({ bitmap, width, height } = rotateBitmap(bitmap, width, height, deg));
  }
  if (ops.flip === 'horizontal' || ops.flip === 'vertical') {
    ({ bitmap, width, height } = flipBitmap(bitmap, width, height, ops.flip));
  }
  if (ops.grayscale === true) grayscaleBitmap(bitmap);

  let out = nativeImage.createFromBitmap(bitmap, { width, height });
  const maxSize = Math.round(Number(ops.maxSize) || 0);
  if (maxSize > 0 && Math.max(width, height) > maxSize) {
    const scale = maxSize / Math.max(width, height);
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    out = out.resize({ width: w, height: h, quality: 'best' });
    width = w;
    height = h;
  }

  // 有 alpha 的格式留 PNG（旋转不损失透明度），照片走 JPEG 控制体积
  const keepPng = mime === 'image/png' || mime === 'image/gif';
  const encoded = keepPng ? out.toPNG() : out.toJPEG(92);
  if (!Buffer.isBuffer(encoded) || !encoded.length) throw new Error('图片重新编码失败');
  return { buffer: encoded, mime: keepPng ? 'image/png' : 'image/jpeg', width, height };
}

/**
 * 生成给模型「看一眼」的缩略图（不用于发送）。
 *
 * 为什么必须有：原图直通时发送的是几 MB 到 20MB 的原始文件，把它整个塞进模型请求
 * 会把请求撑爆（也贵）。缩略图长边 ≤ maxSide、JPEG 质量 80，通常 100~250KB。
 *
 * 返回的 width/height 是**原图**尺寸（调用方要用它来写文案），不是缩略图尺寸。
 * 原图本身就比 maxSide 小的话直接原样返回，不重编码。
 */
export function makePreview(nativeImage, buffer, mime, { maxSide = 1024, quality = 80 } = {}) {
  const img = nativeImage.createFromBuffer(buffer);
  if (!img || (typeof img.isEmpty === 'function' && img.isEmpty())) {
    throw new Error('图片解码失败（可能不是真图片，或格式不支持）');
  }
  const { width, height } = img.getSize();
  if (!width || !height) throw new Error('读不到图片尺寸');
  if (Math.max(width, height) <= maxSide) {
    return { buffer, mime, width, height, resized: false };
  }
  const scale = maxSide / Math.max(width, height);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const small = img.resize({ width: w, height: h, quality: 'good' });
  const encoded = small.toJPEG(quality);
  if (!Buffer.isBuffer(encoded) || !encoded.length) throw new Error('缩略图生成失败');
  return { buffer: encoded, mime: 'image/jpeg', width, height, resized: true };
}
