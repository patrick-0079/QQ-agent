// 多帧抽帧实现（纯 ffmpeg 调用，不碰网络/配置）。
//
// ── 为什么 `-ss` 要放在 `-i` 前面 ──────────────────────────────────────
// `ffmpeg -i in.mp4 -ss 30 ...` 是**输出定位**：必须从第 0 秒解码到第 30 秒，
// 再把前面全部丢掉 —— 30 秒的高清视频要白解 30 秒。
// `ffmpeg -ss 30 -i in.mp4 ...` 是**输入定位**：直接跳到关键帧再解码，
// 快几倍到几十倍。对 10 分钟的视频取 4 帧，这个差别是「秒级」和「卡住」的区别。
//
// ── 为什么不做"直接把 URL 丢给 ffmpeg" ────────────────────────────────
// 社区版让 ffmpeg 直接读 HTTP URL，好处是只拉真正需要的那几段字节
// （10 分钟视频取 4 帧只传几百 KB，而不是几十 MB）。
// 但这里有 SSRF 缺口：URL 来自 OneBot 消息段（发送方可影响），
// ffmpeg 会自己去连、自己解析 DNS，我们没有任何机会做内网校验 ——
// 让群友发一条"视频链接"就能让宿主去探内网端口。
// 所以本项目坚持先经 safe-fetch 校验并落地成文件，再对本地文件抽帧。
// 代价是下载整个视频；换来的是不能被当跳板。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** 调外部命令，收集 stdout；失败/超时返回 null（不抛）。 */
function run(cmd, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch { return finish(null); }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(null); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', () => { clearTimeout(timer); finish(out || null); });
  });
}

/** 找一个可用的 ffmpeg（带缓存；失败结果只缓存 60 秒，之后允许重探）。 */
let ffmpegCache = null;
let ffmpegChecked = false;
let ffmpegCheckedAt = 0;
const FFMPEG_RETRY_MS = 60000;
export async function findFfmpeg() {
  // 成功结果长期缓存；失败（没找到）60 秒后允许重探——
  // 否则"首次探测时没装、后来装好了"就永远不可用，只能重启
  if (ffmpegChecked && ffmpegCache) return ffmpegCache;
  if (ffmpegChecked && Date.now() - ffmpegCheckedAt < FFMPEG_RETRY_MS) return ffmpegCache;
  ffmpegChecked = true;
  ffmpegCheckedAt = Date.now();
  ffmpegCache = null;
  for (const name of ['ffmpeg', 'ffmpeg.exe']) {
    const r = await run(name, ['-version'], 5000);
    if (r) { ffmpegCache = name; break; }
  }
  return ffmpegCache;
}

/** 测试/运维用：强制清空探测缓存。 */
export function resetFfmpegCache() {
  ffmpegCache = null;
  ffmpegChecked = false;
  ffmpegCheckedAt = 0;
}

/** 用 ffprobe 读时长；没有 ffprobe 就返回 0（调用方退回"等间隔猜"）。 */
export async function probeDuration(filePath, ffprobePath = 'ffprobe') {
  const txt = await run(ffprobePath, [
    '-v', 'quiet', '-print_format', 'json', '-show_format', filePath
  ], 15000);
  if (!txt) return 0;
  try {
    const j = JSON.parse(txt);
    return Number(j?.format?.duration) || 0;
  } catch { return 0; }
}

/**
 * 从视频里抽 N 帧，返回 data URL 数组。
 *
 * @param {object} o
 *   filePath    本地视频文件（必须是本地路径 —— 见文件头 SSRF 说明）
 *   count       要几帧（1~12，默认 4）
 *   ffmpegPath  可执行文件路径（不传则自动探测）
 *   maxWidth    缩放宽度上限（默认 768；越小 token 越省）
 *   quality     JPEG 质量 2~31，越小越好（默认 4）
 *   durationSec 已知时长（省一次 ffprobe）
 *   tmpDir      临时目录
 * @returns {Promise<{ frames: string[], times: number[], error?: string }>}
 */
export async function extractFrames({
  filePath,
  count = 4,
  ffmpegPath = null,
  maxWidth = 768,
  quality = 4,
  durationSec = 0,
  tmpDir = null
} = {}) {
  const src = String(filePath || '');
  if (!src || !fs.existsSync(src)) return { frames: [], times: [], error: '视频文件不存在' };

  const ffmpeg = ffmpegPath || await findFfmpeg();
  if (!ffmpeg) return { frames: [], times: [], error: '未找到 ffmpeg' };

  const n = Math.max(1, Math.min(12, Math.round(Number(count) || 4)));
  const dir = tmpDir || path.dirname(src);

  // 时间点：均匀分布在 (5%, 95%) 区间。
  // 不用首尾两端：开头常是黑场/logo，结尾常是黑场/字幕，两头都取等于浪费 2 帧。
  const dur = Number(durationSec) > 0 ? Number(durationSec) : (await probeDuration(src));
  const times = [];
  if (dur > 0) {
    for (let i = 0; i < n; i++) {
      times.push(Number((dur * (0.05 + 0.9 * (i / Math.max(1, n - 1)))).toFixed(3)));
    }
  } else {
    // 时长未知：取前几秒的几个点（短视频居多，猜错的代价只是画面重复）
    for (let i = 0; i < n; i++) times.push(Number((1 + i * 2).toFixed(3)));
  }

  const frames = [];
  const okTimes = [];
  for (const t of times) {
    const dest = path.join(dir, `frame_${Date.now().toString(36)}_${Math.round(t * 1000)}.jpg`);
    // -ss 在 -i 之前 = 输入定位（快）；-frames:v 1 = 只要一帧
    await run(ffmpeg, [
      '-y', '-ss', String(t), '-i', src,
      '-frames:v', '1',
      '-vf', `scale='min(${maxWidth},iw)':-2`,
      '-q:v', String(quality),
      dest
    ], 20000);
    try {
      if (!fs.existsSync(dest)) continue;
      const buf = fs.readFileSync(dest);
      if (!buf.length) continue;
      frames.push(`data:image/jpeg;base64,${buf.toString('base64')}`);
      okTimes.push(t);
    } catch { /* 单帧失败不影响其它帧 */ } finally {
      try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch { /* ignore */ }
    }
  }

  if (!frames.length) return { frames: [], times: [], error: '抽帧失败（ffmpeg 没有产出可用画面）' };
  return { frames, times: okTimes };
}
