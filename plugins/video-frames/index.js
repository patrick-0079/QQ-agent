// 视频抽帧 Skill 入口。
//
// 只提供一个能力：`video.frames`
//   输入  { filePath, count?, maxWidth?, quality?, durationSec?, ffmpegPath? }
//   输出  { frames: string[], times: number[], error? }
//
// 核心模块（video-reader / tools）通过能力名取用它，**不 import 本文件**：
// 这样关掉这个 Skill 就退回"只给元信息"，换实现也不用改核心代码。
//
// 为什么抽帧要单独做成 Skill 而不是写死在核心：
//   · ffmpeg 是**外部可执行文件**，装没装、装在哪、能不能用都是环境相关的
//   · 抽几帧、多大尺寸、什么质量是**口味问题**，不同机器/不同模型差别很大
//   · 有些模型（Gemini、Qwen-VL 等）能原生读视频，那就完全不需要抽帧 ——
//     这时把 Skill 关掉即可，核心会走"原生视频输入"那条路
//   这三件事都符合"可插拔能力"的定位，而"决定走哪条路"是核心的职责。

import { extractFrames, findFfmpeg, probeDuration } from './frames.js';

let cfg = () => ({});
let log = () => {};

export function setup(api) {
  cfg = api.config;
  log = api.log;
}

export const providers = {
  // 抽帧：参数优先级 调用方传入 > 用户在设置页配的 > 默认值
  'video.frames': async ({ filePath, count, maxWidth, quality, durationSec, ffmpegPath } = {}) => {
    const c = cfg();
    const want = Math.max(1, Math.min(12, Math.round(Number(count) || Number(c.count) || 4)));
    const result = await extractFrames({
      filePath,
      count: want,
      maxWidth: Number(maxWidth) || Number(c.maxWidth) || 768,
      quality: Number(quality) || Number(c.quality) || 4,
      durationSec,
      ffmpegPath: ffmpegPath || null
    });
    if (result.error) log(`抽帧未成功：${result.error}`);
    return result;
  },

  // 让核心能问"现在这条路走得通吗"，用于 auto 模式的降级判断
  'video.frames.available': async ({ ffmpegPath } = {}) => {
    const ff = ffmpegPath || await findFfmpeg();
    return { ok: Boolean(ff), reason: ff ? '' : '未找到 ffmpeg（抽帧需要它）' };
  }
};

/**
 * 自检：没有 ffmpeg 时标为"依赖不满足"，UI 会直接显示原因。
 *
 * ⚠️ 这个函数**必须是同步的** —— SkillManager 的可用性判定（以及工具可用性判定）
 * 是同步调用链，`available()` 返回 Promise 会被当成"可用"（Promise 是 truthy）。
 * 但探测 ffmpeg 要 spawn 进程，只能异步。
 * 折中：首次调用先乐观返回"可用"并在后台探测，探测结果缓存下来，
 * 之后每次判定都读到真实状态（UI 下一次刷新就能看到原因）。
 * 不这么做的话表现是：明明没装 ffmpeg，设置页却显示"生效中"，
 * 而真正抽帧时又失败 —— 正是要消灭的那种"界面与实际不一致"。
 */
let ffmpegKnown = null;   // null = 还没探测出来
let probing = false;
let probeAt = 0;          // 上次探测时间：失败结果最多缓存 60 秒，之后允许重探
const PROBE_RETRY_MS = 60000;
function probeFfmpegInBackground() {
  if (probing) return;
  if (ffmpegKnown) return;                                     // 成功结果长期有效
  if (ffmpegKnown !== null && Date.now() - probeAt < PROBE_RETRY_MS) return;
  probing = true;
  findFfmpeg()
    .then((p) => { ffmpegKnown = p || ''; probeAt = Date.now(); })
    .catch(() => { ffmpegKnown = ''; probeAt = Date.now(); })
    .finally(() => { probing = false; });
}

export function available() {
  // 失败结果超 60 秒自动重探：用户后来装好 ffmpeg 不需要重启就能恢复
  if (ffmpegKnown === '' && Date.now() - probeAt > PROBE_RETRY_MS) ffmpegKnown = null;
  if (ffmpegKnown === null) {
    probeFfmpegInBackground();
    return { ok: true };   // 首次乐观放行，探测结果会补上
  }
  if (!ffmpegKnown) return { ok: false, reason: '未找到 ffmpeg，无法抽帧（装好 ffmpeg 后约 1 分钟内自动恢复）' };
  return { ok: true };
}

export function promptSections() {
  const c = cfg();
  return [{
    id: 'video-frames-active',
    title: '视频理解',
    priority: 35,
    content: `你看到的视频画面是从视频里抽出的 ${Number(c.count) || 4} 张截图，不是连续视频。帧与帧之间发生的事你看不到，描述时不要断言中间的连续过程。`
  }];
}

export const internals = {
  extractFrames, findFfmpeg, probeDuration,
  // 测试用：重置 ffmpeg 探测缓存
  __resetFfmpegCache: () => { ffmpegKnown = null; probing = false; }
};
