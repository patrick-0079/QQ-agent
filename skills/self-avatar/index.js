import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appRoot = globalThis.__qqAgentRoot
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let cfg = () => ({});
let httpFetch = null;
let validateImageUrl = basicValidate;
let localStickerPath = () => null;

// 优先复用核心的图片地址校验（会做 DNS / 内网地址检查）与表情本地文件定位；
// 测试目录或非标准安装位置下加载失败时，退回基础校验。
try {
  const safe = await import(pathToFileURL(path.join(appRoot, 'src/safe-fetch.js')).href);
  if (typeof safe.validateImageUrl === 'function') validateImageUrl = safe.validateImageUrl;
} catch { /* 保留基础校验 */ }
try {
  const stickers = await import(pathToFileURL(path.join(appRoot, 'src/sticker-manager.js')).href);
  if (typeof stickers.localStickerPath === 'function') localStickerPath = stickers.localStickerPath;
} catch { /* 本地表情文件定位不可用 */ }

const SIZES = new Set(['640', '140', '100']);
const MAX_BYTES = 5 * 1024 * 1024;

export function setup(api) {
  cfg = api.config;
  httpFetch = typeof api.fetch === 'function' ? (...args) => api.fetch(...args) : null;

  api.registerTool({
    id: 'view_avatar',
    name: '查看自己的头像',
    description: '查看机器人自己当前 QQ 账号的头像，并把头像图片交给自己看；默认同时发到当前会话。当用户问「你的头像是什么/长什么样」「看看你的头像」「你是不是换头像了」，或聊到你的长相、形象、头像、QQ 资料时使用。只查看机器人自己，不能查群友。只想自己确认、不想发到群里时把 send 设为 false；用户说刚换过头像时把 refresh 设为 true。',
    category: 'media',
    icon: '🖼️',
    requiresVision: true,
    parameters: {
      type: 'object',
      properties: {
        send: { type: 'boolean', description: '是否把头像发到当前会话。不填则用技能设置（默认发）；false 表示只让自己看。' },
        refresh: { type: 'boolean', description: '是否强制取最新头像。用户说「刚换了头像」时设为 true。' }
      }
    },
    async execute(ctx, args) {
      const selfId = String(ctx?.selfId ?? ctx?.onebot?.selfId ?? '').trim();
      if (!/^\d+$/.test(selfId) || selfId === '0') {
        return { content: '拿不到机器人自己的 QQ 号，可能还没连上 QQ。', isError: true };
      }
      if (!httpFetch) {
        return { content: '技能没有联网权限（web_fetch），取不到头像。', isError: true };
      }

      const c = cfg() || {};
      const size = SIZES.has(String(c.size)) ? String(c.size) : '640';
      const shouldSend = args?.send === false ? false : (args?.send === true ? true : c.sendToChat !== false);
      const refresh = args?.refresh === true;
      const url = avatarUrl(selfId, size, refresh);

      let image;
      try {
        image = await fetchAvatar(url);
      } catch (error) {
        return { content: `取自己的头像失败：${human(error)}。可以稍后再试。`, isError: true };
      }

      let sendNote = '';
      if (shouldSend) {
        try {
          await ctx.sender.sendImage(ctx.chatKey, { dataUrl: `base64://${image.b64}` }, { note: '我的头像' });
          sendNote = '已发到当前会话。';
        } catch (error) {
          const msg = human(error);
          sendNote = /刚刚发过|重复/.test(msg)
            ? '这张头像刚刚已经发过，本次没有重复发。'
            : `发到会话失败（${msg}），但头像已经取到。`;
        }
      } else {
        sendNote = '没有发到会话（只让自己看）。';
      }

      return {
        content: [
          {
            type: 'text',
            text: `这是机器人自己（QQ ${selfId}${ctx?.selfNickname ? `，昵称 ${ctx.selfNickname}` : ''}）当前的头像。${sendNote}请直接看图片回答；看不到的细节不要编造。`
          },
          { type: 'image_url', image_url: { url: image.dataUrl } }
        ]
      };
    }
  });

  api.registerTool({
    id: 'set_avatar',
    name: '修改自己的头像',
    description: '修改机器人自己的 QQ 头像。用户明确要求换头像，或你确实想换且话题与你的形象有关时使用。三种图片来源必须且只能选一个：stickerId（你自己表情库里的表情，优先）、messageId（当前聊天里用户发给你并同意做头像的图片）、imageUrl（公开图片直链）。只改机器人自己，不能改别人；不要用群友的私人照片、聊天截图或未经允许的图片；不要连续换。调用一次后等结果，不要重复提交。QQ 客户端显示可能有缓存延迟。',
    category: 'media',
    icon: '🎭',
    requiresVision: false,
    parameters: {
      type: 'object',
      properties: {
        stickerId: { type: 'string', description: '自己表情库里的表情 id，来自 list_stickers；优先用这个。' },
        messageId: { type: 'string', description: '当前聊天里一张图片消息的 id；只用于用户发给你并同意做头像的图片。' },
        imageUrl: { type: 'string', description: '一张公开的 http(s) 图片直链；不要传内网地址或聊天截图。' },
        imageIndex: { type: 'integer', description: 'messageId 那张消息里有多张图时，从 0 开始选第几张；默认 0。' }
      }
    },
    async execute(ctx, args) {
      const selfId = String(ctx?.selfId ?? ctx?.onebot?.selfId ?? '').trim();
      if (!/^\d+$/.test(selfId) || selfId === '0') {
        return { content: '拿不到机器人自己的 QQ 号，可能还没连上 QQ。', isError: true };
      }

      const c = cfg() || {};
      if (c.allowAvatarChange === false) {
        return { content: '管理员关闭了「允许机器人改自己的头像」，现在只能看，不能改。', isError: true };
      }

      let source;
      try {
        source = await resolveAvatarSource(ctx, args);
      } catch (error) {
        return { content: `换头像失败：${human(error)}`, isError: true };
      }

      try {
        await call(ctx, 'set_qq_avatar', { file: source.ref }, 90000);
      } catch (error) {
        return { content: `设置头像失败：${human(error)}。这次没有确认成功，先不要重复提交。`, isError: true };
      }

      return {
        content: `已请求把自己的头像换成${source.label}。QQ 接口已接受；客户端显示可能有缓存延迟，稍后可以用 self-avatar__view_avatar 确认。`
      };
    }
  });
}

/**
 * 把三种来源统一成 set_qq_avatar 需要的 file 引用。
 * 必须且只能提供一个来源，避免模型同时塞多个参数导致选错图。
 */
async function resolveAvatarSource(ctx, args) {
  const provided = [
    ['imageUrl', args?.imageUrl],
    ['stickerId', args?.stickerId],
    ['messageId', args?.messageId]
  ].filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '');

  if (provided.length !== 1) {
    throw new Error('请从 stickerId（自己的表情）、messageId（当前会话图片）、imageUrl（公开图片直链）中只选一个来源');
  }

  const [kind, value] = provided[0];

  if (kind === 'imageUrl') {
    return { ref: await publicUrl(value), label: '你提供的公开图片' };
  }

  if (kind === 'stickerId') {
    const id = String(value).trim();
    const sticker = await ctx.stickers?.find(id);
    if (!sticker?.url) throw new Error(`没有找到表情 ${id}，先用 list_stickers 查自己的表情 id`);
    const ref = String(sticker.url).trim();
    if (/^https?:/i.test(ref)) {
      return { ref: await publicUrl(ref), label: `自己的表情 ${id}` };
    }
    if (/^base64:\/\//i.test(ref)) {
      return { ref, label: `自己的表情 ${id}` };
    }
    if (/^file:\/\/\//i.test(ref)) {
      const local = localStickerPath(ref);
      if (!local) throw new Error('这个表情的本地文件不在表情库目录里，不能用作头像');
      return { ref: pathToFileURL(local).href, label: `自己的表情 ${id}` };
    }
    throw new Error('这个表情没有可用的图片地址');
  }

  const mid = String(value).trim();
  if (!/^-?\d+$/.test(mid)) throw new Error('messageId 必须是当前聊天记录里的消息 id');
  const entry = ctx.store?.findByMid(ctx.chatKey, mid);
  const images = (entry?.media || []).filter((media) => media?.kind === 'image');
  if (!images.length) throw new Error('当前会话的这条消息没有图片');

  let index = 0;
  if (args?.imageIndex !== undefined && args?.imageIndex !== null && args?.imageIndex !== '') {
    index = Number(args.imageIndex);
    if (!Number.isInteger(index) || index < 0) throw new Error('imageIndex 必须是从 0 开始的整数');
  }
  const media = images[index];
  if (!media) throw new Error(`图片序号超出范围：这条消息只有 ${images.length} 张图`);

  let url = media.url;
  if (!url && media.file) {
    const data = await ctx.onebot.call('get_image', { file: String(media.file) });
    url = data?.url;
  }
  if (!url) throw new Error('这张图片的地址不可用，换一张或改用 imageUrl');
  return { ref: await publicUrl(url), label: `当前会话消息 ${mid} 里的第 ${index + 1} 张图` };
}

async function call(ctx, action, params, timeout = 15000) {
  const data = await ctx.onebot.call(action, params, timeout);
  // 有些协议端会把业务状态放在 data.result / data.retcode 里，而不是只靠 HTTP 状态。
  if (data && typeof data === 'object'
    && ((data.result != null && Number(data.result) !== 0)
      || (data.retcode != null && Number(data.retcode) !== 0))) {
    throw new Error('协议端返回业务错误');
  }
  return data;
}

async function publicUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) {
    throw new Error('图片地址不合法');
  }
  const url = new URL(value.trim());
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('仅允许公开 http(s) 图片链接');
  }
  return validateImageUrl(url.toString());
}

async function basicValidate(value) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0' || host.endsWith('.local')
    || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    throw new Error('不允许使用内网地址');
  }
  return url.toString();
}

function avatarUrl(id, size, refresh) {
  const u = new URL('https://q1.qlogo.cn/g');
  u.searchParams.set('b', 'qq');
  u.searchParams.set('nk', id);
  u.searchParams.set('s', size);
  // 5 分钟一个时间桶：既能看到较新的头像，又让同一时段内的重复调用命中发送去重。
  u.searchParams.set('t', String(refresh ? Date.now() : Math.floor(Date.now() / 300000)));
  return u.toString();
}

async function fetchAvatar(url) {
  const res = await httpFetch(url, {
    method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0 QQAgent/1.0', Accept: 'image/*' },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const rawType = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!/^image\/(jpeg|jpg|png|webp|gif)$/.test(rawType)) {
    throw new Error(`返回的不是图片（${rawType || '未知类型'}）`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new Error('图片内容为空');
  if (buffer.length > MAX_BYTES) throw new Error('头像图片太大');
  if (!looksLikeImage(buffer)) throw new Error('图片内容无法识别');

  const mime = rawType === 'image/jpg' ? 'image/jpeg' : rawType;
  const b64 = buffer.toString('base64');
  return { b64, dataUrl: `data:${mime};base64,${b64}` };
}

function looksLikeImage(buffer) {
  if (buffer.length < 12) return false;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true; // JPEG
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return true; // PNG
  const head6 = buffer.subarray(0, 6).toString('ascii');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return true;
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return true;
  return false;
}

function human(error) {
  const msg = String(error?.message ?? error ?? '').trim();
  if (/abort|timeout|timed out/i.test(msg)) return '请求超时';
  return msg.slice(0, 160) || '未知错误';
}

export function available() {
  return true;
}
