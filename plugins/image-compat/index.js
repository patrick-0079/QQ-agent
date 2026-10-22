// 图片格式兼容：处理"模型不接受这种图片"的两种情况。
//
// ── 情况一：提前识别（避免把整轮打挂）─────────────────────────────────
// 部分本地/自建视觉接口（llama.cpp、vLLM 的某些版本）遇到 webp / avif 会直接 400。
// 一个 400 会让**整轮对话失败** —— 比"这轮看不到图"严重得多。
// 所以这里提供 `image.mime-support`：调用方在构造图片部分之前问一句，
// 不支持的格式就改成文字说明（"有 1 张 webp 图无法传给当前模型"），照常继续。
//
// 为什么不写死一张"哪些接口不支持"的表：
//   那种表必然滞后且不准（同一个 llama.cpp 不同版本行为都不同），猜错的代价是请求 400。
//   所以做成**格式白/黑名单 + 用户可配**：默认把 webp/avif 当作"可能不支持"，
//   真需要发的用户在设置里把这两个从名单里去掉即可。
//
// ── 情况二：事后降级（救回一整轮）─────────────────────────────────────
// 如果还是被拒了（比如 HTML 里嵌的 base64 编码不被接受），
// 识别出"这是图片导致的拒绝"，摘掉图片重发一次：
// 宁可这轮看不见图，也不要整轮报错什么都发不出去。
//
// ── 边界 ──────────────────────────────────────────────────────────────
// 它只提供"判断"和"改写请求体"两个纯函数，**不自己发请求**（重试由 llm.js 执行），
// 这样超时预算、abort、计费口径都不变。

let cfg = () => ({});
let log = () => {};

/** 解析配置里的格式名单（逗号/空白分隔 → 规范化数组）。 */
export function unsupportedList(raw) {
  return String(raw ?? '')
    .split(/[,，;；\s]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

/** 某个 mime 是否属于"不要喂给模型"的格式。 */
export function isUnsupportedMime(mime, list = null) {
  const m = String(mime || '').toLowerCase().split(';')[0].trim();
  if (!m) return false;
  const set = list || unsupportedList(cfg().unsupportedMimes);
  return set.includes(m);
}

/**
 * 接口是因为"图片格式/编码"拒绝的这次请求吗？
 * 只在 400 / 415 / 422 上判定，且错误文本要真的提到图片相关字段 ——
 * 否则会把"模型名写错""Key 无效"这类无关错误也重试一遍，白白多花一次调用。
 */
export function isImageRejection(status, text) {
  if (![400, 415, 422].includes(Number(status))) return false;
  return /base64 encoded image|image_url|invalid image|unsupported (image|media)|must be a base64/i.test(String(text || ''));
}

/**
 * 把所有图片部分换成一句文字说明，返回新 messages；没有图片则返回 null。
 *
 * 返回 null 而不是原数组，是为了让调用方清楚区分"没改动"和"改动后恰好相同"——
 * 调用方据此决定要不要真的重试（返回 null 就别重试了）。
 */
export function stripImageParts(messages) {
  let touched = false;
  const out = (messages || []).map((m) => {
    if (!Array.isArray(m?.content)) return m;
    const kept = [];
    let dropped = 0;
    for (const part of m.content) {
      if (part?.type === 'image_url') { dropped += 1; continue; }
      kept.push(part);
    }
    if (!dropped) return m;
    touched = true;
    kept.push({ type: 'text', text: `（有 ${dropped} 张图片无法传给当前模型：接口不支持这种格式，已省略）` });
    return { ...m, content: kept };
  });
  return touched ? out : null;
}

/** 请求体里有没有图片部分（用于判断值不值得为图片降级重试）。 */
export function hasImageParts(messages) {
  for (const m of (messages || [])) {
    if (!Array.isArray(m?.content)) continue;
    if (m.content.some((p) => p?.type === 'image_url')) return true;
  }
  return false;
}

// ── Skill 生命周期 ────────────────────────────────────────────────────────

export function setup(api) {
  cfg = api.config;
  log = api.log;
}

export const providers = {
  /** 调用方在构造图片部分之前问：这个格式能发吗？ */
  'image.mime-support': ({ mime } = {}) => {
    const unsupported = isUnsupportedMime(mime);
    return { supported: !unsupported, unsupported, mime: String(mime || '').toLowerCase() };
  },

  /**
   * 被拒时给出降级建议。
   * 返回 { body, reason } 让核心去重试；返回 null 表示"这个错误不该由我处理"。
   *
   * GIF 降级（2026-09-19，用户定稿规则 2）："图片输入开、视频输入没开"时 GIF 按
   * 原样发，模型读不了会报错 —— 此时取**首帧**（静态 PNG）替换后重试，
   * 而不是整张摘掉：首帧至少保住"看得见图"，比完全省略强。
   * 首帧提取在代码里完成（gifFirstFrameDataUrl），不依赖模型自己重试。
   */
  'llm.retry-advisor': async ({ body, errorText, status } = {}) => {
    if (cfg().stripOnReject === false) return null;
    if (!isImageRejection(status, errorText)) return null;
    if (!hasImageParts(body?.messages)) return null;   // 没有图片就别瞎重试
    // 第一优先：GIF 换首帧（只换 GIF 图，普通图不动）
    const firstFrame = await replaceGifWithFirstFrame(body.messages);
    if (firstFrame) {
      log('接口拒绝图片输入：GIF 已换成首帧静态图，重试一次');
      return {
        body: { ...body, messages: firstFrame },
        reason: '接口不接受 GIF 动图，已换成首帧静态图重试（画面只取第一帧）'
      };
    }
    // 第二优先：没有 GIF（或首帧提取失败）→ 摘掉全部图片
    const next = stripImageParts(body.messages);
    if (!next) return null;
    log('接口拒绝了图片部分，摘掉后重试一次');
    return {
      body: { ...body, messages: next },
      reason: '接口不接受图片输入，已摘掉图片重试（这轮看不见图，但文字部分照常处理）'
    };
  }
};

/**
 * 把 messages 里 GIF 形态的 image_url 换成首帧静态图。
 * data URL 的 MIME 是 image/gif 才替换；http(s) URL 的 GIF 判不了字节（内容
 * 已在核心侧下载过，这里拿不到）—— 这类留给"摘掉图片"的兜底分支。
 * 返回新的 messages 数组（没有任何 GIF 时返回 null）。
 */
async function replaceGifWithFirstFrame(messages) {
  let gifFirstFrameDataUrl;
  try {
    ({ gifFirstFrameDataUrl } = await import('../src/gif-to-video.js'));
  } catch {
    return null;   // 模块不可加载（理论上不会）→ 走摘图兜底
  }
  if (typeof gifFirstFrameDataUrl !== 'function') return null;
  let touched = false;
  const out = [];
  for (const m of (messages || [])) {
    if (!Array.isArray(m?.content)) { out.push(m); continue; }
    let gifCount = 0;
    const parts = [];
    for (const part of m.content) {
      const url = String(part?.image_url?.url || '');
      const isGif = /^data:image\/gif;base64,/i.test(url);
      if (isGif) {
        gifCount += 1;
        const frame = await gifFirstFrameDataUrl(Buffer.from(url.split(',')[1] || '', 'base64'));
        if (frame) {
          parts.push({ type: 'image_url', image_url: { url: frame } });
        } else {
          // 首帧提取失败：留占位说明，别发原始 GIF（发了还会再报错）
          parts.push({ type: 'text', text: '（1 张 GIF 动图无法传给当前模型，首帧提取失败，已省略）' });
        }
      } else {
        parts.push(part);
      }
    }
    if (gifCount) {
      touched = true;
      out.push({ ...m, content: parts });
    } else {
      out.push(m);
    }
  }
  return touched ? out : null;
}

export function available() { return { ok: true }; }

export const internals = {
  isUnsupportedMime, isImageRejection, stripImageParts, hasImageParts, unsupportedList
};
