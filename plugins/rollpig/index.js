// RollPig（今日小猪）QQ Agent 适配插件
//
// 上游 nonebot-plugin-rollpig-plus 是 NoneBot2 / OneBot v11 插件，核心价值在
// 8000 行 Pillow 渲染器（卡片、图鉴、周报、日报），无法在 Node 侧复刻。
// 因此这里采用「Python 无头 NoneBot 侧车 + QQA 薄插件」：
//   · 侧车（默认 $QQA_HOME/rollpig-service）原样加载上游插件，只把出站 API
//     收集到 outbox；
//   · 本插件在 Orchestrator.prototype.onIncoming 上做旁路：命中 RollPig 指令时
//     不调用原方法（不进入活跃度/档位/其他回复管理插件，也不产生 LLM 请求），
//     把消息交给侧车，再把 outbox 里的发送任务用 QQA 自己的 sender 发出去。
//
// 为什么不是 hook：5 个 hook 只在已经排定模型会话后才触发，而「今日小猪」必须
// 在 onIncoming 的早退路径上就被截住；repeat-echo 也用了同一个挂载点。
//
// 安全边界：非指令消息原样透传；关掉插件即摘钩子；所有发送走 QQA sender
// （串行/限频/去重/留档），只有合并转发因 sender 不支持而直接走 onebot.call。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Orchestrator } from '../../src/orchestrator.js';
import { logger } from '../../src/logger.js';

const PATCH_KEY = Symbol.for('qq-agent.rollpig.patch');
const DEFAULT_SIDECAR = 'http://127.0.0.1:18765';
const HERE = path.dirname(fileURLToPath(import.meta.url));
// 群列表/机器人 QQ 落盘：侧车重启后不必等“下一条群消息”才能恢复日报推送。
// 不能写死 /app/data：原生安装（Windows/Linux）没有这个路径。
let dataDir = '';

let api = null;
let currentOrch = null;
let pollTimer = null;
let syncTimer = null;
let draining = false;
let installed = false;
let syncStarted = false;
const attempts = new Map();
const handled = new Set();

// 无参数指令：必须整句完全相等，避免把「今日小猪呀」这类正常聊天吞掉。
const EXACT_COMMANDS = new Set([
  '今天是什么小猪', '今日小猪',
  '明日小猪', '昨日小猪',
  '我的猪圈', '我的小猪',
  '本周小猪', '小猪投稿', '投稿小猪',
  '猪圈日报', '今日烤猪',
  '随机烤猪', '随机烤群友', '抽个群友烤了',
  '同步小猪资源', '刷新小猪图鉴',
  '烤箱续火', '烤箱补货', '重置烤猪次数', '恢复烧烤配额', '申请烤箱补给', '重置烧烤次数',
  '小猪帮助',
]);

const JOIN_WORDS = new Set(['加入', '加入预约', '加入烤猪']);

function cfg() {
  try {
    return api?.config?.() || {};
  } catch {
    return {};
  }
}

function sidecarUrl() {
  const raw = String(cfg().sidecarUrl || DEFAULT_SIDECAR).trim().replace(/\/+$/, '');
  return raw || DEFAULT_SIDECAR;
}

function timeoutMs() {
  const n = Number(cfg().requestTimeoutMs);
  return Number.isFinite(n) && n >= 1000 ? n : 120000;
}

function pollMs() {
  const n = Number(cfg().pollIntervalMs);
  return Number.isFinite(n) && n >= 500 ? n : 2000;
}

/** 去掉 QQA 渲染进正文的「@机器人」前缀，再判定指令。 */
function stripAtPrefix(text, entry) {
  let out = String(text || '').trim();
  if (!entry?.atMe) return out;
  for (const name of entry.atNames || []) {
    const token = `@${name}`;
    if (name && out.startsWith(token)) {
      out = out.slice(token.length).trim();
      break;
    }
  }
  if (out.startsWith('@')) {
    const match = out.match(/^@\S+\s*/);
    if (match) out = out.slice(match[0].length).trim();
  }
  return out;
}

/** 判定这条消息是不是 RollPig 指令；只做保守匹配，宁可不吞也不误吞。 */
function classify(text, entry, chatKey) {
  const raw = stripAtPrefix(text, entry);
  if (!raw) return null;
  const plain = raw.replace(/^[/／]+/, '').trim();
  if (!plain) return null;

  if (entry?.replyToSelf && JOIN_WORDS.has(plain)) return { kind: 'join', needsMembers: false };

  // 帮助图完全由插件本地发送，不经过侧车，侧车挂了也能用。
  if (plain === '小猪帮助') return { kind: 'help', needsMembers: false };

  if (EXACT_COMMANDS.has(plain)) {
    return {
      kind: 'exact',
      needsMembers: plain === '烤群友' || plain === '加急生火',
    };
  }

  // 随机小猪 [1-10]
  if (/^随机小猪(?:\s*(?:10|[1-9]))?$/.test(plain)) return { kind: 'roll', needsMembers: false };
  // 小猪图鉴 [页码]
  if (/^小猪图鉴(?:\s*\d{1,3})?$/.test(plain)) return { kind: 'catalog', needsMembers: false };
  // 找猪 / 搜猪 [关键词]（无关键词时上游会回用法提示，所以也放行）
  if (/^(?:找猪|搜猪)(?:\s+.+)?$/.test(plain)) return { kind: 'find', needsMembers: false };
  // 烤群友 / 加急生火 [@目标] [强行点火]
  if (/^(?:烤群友|加急生火)(?:\s+.+)?$/.test(plain)) return { kind: 'roast', needsMembers: true };
  // 小猪日报 / 每日总结设置 / rollpig日报 [开启|关闭|状态]
  if (/^(?:小猪日报|每日总结设置|rollpig日报)(?:\s+(?:开启|关闭|状态))?$/.test(plain)) {
    return { kind: 'report-switch', needsMembers: false };
  }
  return null;
}

function install() {
  const proto = Orchestrator?.prototype;
  if (!proto || typeof proto.onIncoming !== 'function') {
    logger.warn('rollpig', '拿不到 Orchestrator.prototype.onIncoming，插件未挂载');
    return false;
  }

  let rec = proto[PATCH_KEY];
  if (!rec) {
    const original = proto.onIncoming;
    const wrapped = function onIncoming(chatKey, entry = null) {
      currentOrch = this;
      // 首次拿到真实 Orchestrator 时补一次同步：激活时可能还没有任何消息，
      // 拿不到 onebot，群列表/超级用户会同步失败；第一条消息进来后再补。
      if (!syncStarted && this?.onebot?.call) {
        syncStarted = true;
        syncConfig().then((ok) => { if (!ok) syncStarted = false; }).catch(() => { syncStarted = false; });
      }
      // 热重载/卸载后，旧 wrapped 可能仍被别的插件包着；此时必须原样透传。
      const live = proto[PATCH_KEY];
      if (!live || live.wrapped !== wrapped) return original.call(this, chatKey, entry);
      const hit = entry ? classify(entry.text, entry, chatKey) : null;
      if (!hit) return original.call(this, chatKey, entry);

      // 命中：不走 QQA 原流程，避免活跃度/档位/其他回复管理插件过滤，也不产生 LLM 请求。
      try {
        this?.store?.markEntryRead?.(chatKey, entry.id);
      } catch { /* 标已读失败不影响指令处理 */ }
      const cur = proto[PATCH_KEY];
      if (cur && typeof cur.handle === 'function') {
        const p = cur.handle(this, chatKey, entry, hit, cur.original);
        if (p && typeof p.catch === 'function') {
          p.catch((error) => logger.warn('rollpig', `指令处理失败：${error?.message ?? error}`));
        }
      }
      return undefined;
    };
    rec = { original, wrapped, handle: null };
    proto[PATCH_KEY] = rec;
    proto.onIncoming = wrapped;
  }
  rec.handle = handle;
  installed = true;
  return true;
}

function uninstall() {
  const proto = Orchestrator?.prototype;
  const rec = proto?.[PATCH_KEY];
  if (!rec) return;
  rec.handle = null;
  if (proto.onIncoming === rec.wrapped) proto.onIncoming = rec.original;
  delete proto[PATCH_KEY];
  installed = false;
}

async function post(path, body, ms = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(`${sidecarUrl()}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function get(path, ms = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(`${sidecarUrl()}${path}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function normalizeMessage(message) {
  if (Array.isArray(message)) {
    return message
      .filter((seg) => seg && seg.type)
      .map((seg) => ({ type: String(seg.type), data: { ...(seg.data || {}) } }));
  }
  if (typeof message === 'string') return message; // 侧车内置 CQ 解析
  return [];
}

function pickReplyId(message) {
  if (!Array.isArray(message)) return null;
  for (const seg of message) {
    if (seg?.type === 'reply' && seg?.data?.id != null) return String(seg.data.id);
  }
  return null;
}

async function fetchMembers(orch, groupId) {
  if (!groupId) return [];
  try {
    const list = await orch.onebot.call('get_group_member_list', {
      group_id: Number(groupId),
      no_cache: false,
    });
    return Array.isArray(list) ? list : [];
  } catch (error) {
    logger.warn('rollpig', `拉群成员失败（继续执行）：${error?.message ?? error}`);
    return [];
  }
}

async function fetchRole(orch, groupId, userId, rawSender) {
  const role = String(rawSender?.role || '').trim();
  if (role) return role;
  try {
    const info = await orch.onebot.call('get_group_member_info', {
      group_id: Number(groupId),
      user_id: Number(userId),
      no_cache: false,
    });
    return String(info?.role || 'member');
  } catch {
    return 'member';
  }
}

async function buildPayload(orch, chatKey, entry, hit) {
  const kind = String(chatKey).startsWith('group:') ? 'group' : 'private';
  const chatId = String(chatKey).split(':')[1] || '';
  const selfId = String(orch?.onebot?.selfId || '');

  let raw = null;
  try {
    raw = await orch.onebot.call('get_msg', { message_id: entry.mid });
  } catch (error) {
    logger.warn('rollpig', `get_msg 失败，仅用文本构造事件：${error?.message ?? error}`);
  }

  const rawMessage = normalizeMessage(raw?.message);
  const rawSender = raw?.sender && typeof raw.sender === 'object' ? raw.sender : {};
  const replyId = pickReplyId(rawMessage) || (entry.replyToSelf ? String(entry.replyToMessageId || '') : '');
  const members = kind === 'group' && hit?.needsMembers ? await fetchMembers(orch, chatId) : [];
  const role = kind === 'group'
    ? await fetchRole(orch, chatId, entry.senderId, rawSender)
    : 'member';

  const ts = Number(entry.ts) || Date.now();
  return {
    kind,
    chat_id: String(chatId),
    group_id: kind === 'group' ? String(chatId) : undefined,
    self_id: selfId,
    user_id: String(entry.senderId || ''),
    message_id: String(entry.mid || ''),
    time: ts > 1e12 ? Math.floor(ts / 1000) : Math.floor(ts),
    text: String(entry.text || ''),
    message: rawMessage,
    at_me: Boolean(entry.atMe),
    reply_to_self: Boolean(entry.replyToSelf),
    reply: replyId
      ? {
          message_id: String(replyId),
          sender_id: entry.replyToSelf ? selfId : String(entry.replySenderId || ''),
        }
      : null,
    sender: {
      nickname: String(rawSender.nickname || entry.senderName || ''),
      card: String(rawSender.card || ''),
      role,
    },
    members,
  };
}

const HELP_IMAGE = '/media/rollpig/help/rollpig-help.png';
const HELP_ASSET = new URL('./assets/rollpig-help.png', import.meta.url);

function helpImagePath() {
  const raw = String(cfg().helpImage || HELP_IMAGE).trim();
  return raw || HELP_IMAGE;
}
const HELP_FALLBACK = [
  '【小猪帮助】',
  '今日小猪 / 昨日小猪 / 明日小猪 / 随机小猪 [1-10]',
  '找猪 关键词 / 我的猪圈 / 本周小猪 / 小猪图鉴 [页码]',
  '小猪投稿 / 猪圈日报 / 今日烤猪 / 烤群友 @某人 / 随机烤猪',
  '加急生火 @某人 / 烤箱续火 / 烤箱补货 / 小猪日报 开启|关闭|状态',
  '小猪帮助（查看完整指令图）',
].join('\n');

async function sendHelp(orch, chatKey, entry) {
  const sender = orch?.sender;
  if (!sender) throw new Error('sender 不可用');
  try {
    await sender.sendImage(chatKey, { file: helpImagePath() });
  } catch (error) {
    // 市场包只带插件、不带侧车时，/media 下没有帮助图；用插件自带 assets 兜底。
    try {
      const data = fs.readFileSync(HELP_ASSET);
      await sender.sendImage(chatKey, {
        dataUrl: `base64://${data.toString('base64')}`,
      });
    } catch (assetError) {
      logger.warn('rollpig', `帮助图发送失败，改用文字：${error?.message ?? error} / ${assetError?.message ?? assetError}`);
      await sender.sendTextBatch(chatKey, [HELP_FALLBACK]);
    }
  }
}

async function handle(orch, chatKey, entry, hit, original) {
  if (hit?.kind === 'help') {
    try {
      await sendHelp(orch, chatKey, entry);
    } catch (error) {
      logger.warn('rollpig', `小猪帮助处理失败：${error?.message ?? error}`);
    }
    return;
  }

  if (!orch?.onebot?.call) return;
  if (!entry?.mid) return;

  let payload;
  try {
    payload = await buildPayload(orch, chatKey, entry, hit);
  } catch (error) {
    logger.warn('rollpig', `构造事件失败：${error?.message ?? error}`);
    return;
  }

  try {
    const result = await post('/event', payload, timeoutMs());
    if (!result?.ok) {
      logger.warn('rollpig', `侧车拒绝事件：${result?.error || 'unknown'}`);
      return;
    }
    await drain(orch);
  } catch (error) {
    // 侧车没起来 / 超时：退回 QQA 原流程，至少不让消息凭空消失。
    logger.warn('rollpig', `侧车不可用，退回原流程：${error?.message ?? error}`);
    try {
      if (typeof original === 'function') original.call(orch, chatKey, entry);
    } catch { /* ignore */ }
  }
}

function outgoingSegments(message) {
  if (!Array.isArray(message)) return [];
  return message
    .filter((seg) => seg && seg.type)
    .map((seg) => {
      const type = String(seg.type);
      const data = { ...(seg.data || {}) };
      if (type === 'text') data.text = String(data.text ?? '');
      if (type === 'at') data.qq = String(data.qq ?? '');
      if (type === 'reply') data.id = String(data.id ?? '');
      if (type === 'image' && data.file) {
        // 侧车已经按部署形态返回 QQA 能读的路径：Docker 是 /media/...，
        // 原生安装是绝对路径。这里不要写死 /media 或 /opt/qq-agent。
        data.file = String(data.file);
      }
      return { type, data };
    });
}

function chatKeyFor(params, fallback) {
  if (params?.group_id != null) return `group:${params.group_id}`;
  if (params?.user_id != null) return `private:${params.user_id}`;
  return fallback;
}

async function deliver(orch, item) {
  const sender = orch?.sender;
  if (!sender) throw new Error('sender 不可用');
  const params = item.params || {};
  const chatKey = chatKeyFor(params, null);
  if (!chatKey) throw new Error('outbox 缺少会话 id');

  if (item.api === 'send_group_msg' || item.api === 'send_private_msg') {
    const segs = outgoingSegments(params.message);
    if (!segs.length) return null;
    if (segs.length === 1 && segs[0].type === 'text') {
      const r = await sender.sendTextBatch(chatKey, [segs[0].data.text || '']);
      return r?.sent?.[0]?.messageId ?? null;
    }
    if (segs.length === 1 && segs[0].type === 'image') {
      const r = await sender.sendImage(chatKey, { file: segs[0].data.file });
      return r?.message_id ?? null;
    }
    const r = await sender.sendMedia(chatKey, segs, {
      label: '[RollPig]',
      dedupeKey: `rollpig:${item.id}`,
    });
    return r?.message_id ?? null;
  }

  if (item.api === 'send_group_forward_msg') {
    const groupId = Number(params.group_id);
    try {
      const r = await orch.onebot.call('send_group_forward_msg', {
        group_id: groupId,
        messages: params.messages || [],
      });
      return r?.message_id ?? null;
    } catch (error) {
      // sender 不支持合并转发；降级为逐段发，保住图片内容。
      logger.warn('rollpig', `合并转发失败，降级逐段发送：${error?.message ?? error}`);
      const flat = [];
      for (const node of params.messages || []) {
        flat.push(...outgoingSegments(node?.data?.content));
      }
      if (!flat.length) throw error;
      const r = await sender.sendMedia(chatKey, flat, {
        label: '[RollPig]',
        dedupeKey: `rollpig:${item.id}:flat`,
      });
      return r?.message_id ?? null;
    }
  }

  if (item.api === 'set_msg_emoji_like') {
    await orch.onebot.call('set_msg_emoji_like', params);
    return null;
  }

  if (item.api === 'call_api') {
    await orch.onebot.call(params.api, params.params || {});
    return null;
  }

  logger.warn('rollpig', `未知 outbox 动作：${item.api}`);
  return null;
}

async function drain(orch) {
  if (!orch || draining) return;
  draining = true;
  try {
    for (let round = 0; round < 30; round += 1) {
      const data = await get('/outbox', 15000);
      const items = Array.isArray(data?.items) ? data.items : [];
      if (!items.length) break;
      for (const item of items) {
        if (handled.has(item.id)) continue;
        try {
          const messageId = await deliver(orch, item);
          attempts.delete(item.id);
          handled.add(item.id);
          await post('/ack', { id: item.id, message_id: messageId }, 8000).catch(() => {});
        } catch (error) {
          const tries = (attempts.get(item.id) || 0) + 1;
          attempts.set(item.id, tries);
          logger.warn('rollpig', `发送失败（第 ${tries} 次）：${error?.message ?? error}`);
          if (tries >= 2) {
            attempts.delete(item.id);
            handled.add(item.id);
            // 两次仍失败就 ack 掉，避免同一条坏消息永久堵住 outbox。
            await post('/ack', { id: item.id, message_id: null }, 8000).catch(() => {});
          }
        }
      }
    }
  } catch (error) {
    logger.warn('rollpig', `轮询 outbox 失败：${error?.message ?? error}`);
    // 侧车重启/暂时不可达：允许下一条消息重新同步 self_id 与群列表。
    syncStarted = false;
  } finally {
    draining = false;
  }
}

function cacheFile() {
  const dir = dataDir || path.join(HERE, 'data');
  return path.join(dir, 'rollpig-groups.json');
}

function saveCache(groups, selfId) {
  try {
    const file = cacheFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      groups: Array.isArray(groups) ? groups : [],
      selfId: String(selfId || ''),
      ts: Date.now(),
    }), 'utf8');
  } catch { /* 缓存写失败不影响主流程 */ }
}

function loadCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function restoreCache() {
  const cache = loadCache();
  if (!cache) return;
  const superusers = String(cfg().superusers || '')
    .split(/[,，\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (cache.selfId) {
    await post('/config', { self_id: String(cache.selfId), superusers }, 10000).catch(() => {});
  }
  if (Array.isArray(cache.groups) && cache.groups.length) {
    await post('/groups', { groups: cache.groups }, 10000).catch(() => {});
  }
}

async function syncConfig() {
  const orch = currentOrch;
  if (!orch?.onebot?.call) return false;
  try {
    const selfId = String(orch.onebot.selfId || '');
    let groups = [];
    try {
      const list = await orch.onebot.call('get_group_list', {});
      groups = Array.isArray(list) ? list : [];
    } catch { /* 群列表失败不影响单群指令 */ }
    if (groups.length) {
      await post('/groups', { groups }, 10000);
      saveCache(groups, selfId);
    }
    const superusers = String(cfg().superusers || '')
      .split(/[,，\s]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    await post('/config', { self_id: selfId, superusers }, 10000);
    logger.info('rollpig', `侧车已同步：self=${selfId}，群 ${groups.length} 个，超级用户 ${superusers.length} 个`);
    return true;
  } catch (error) {
    logger.warn('rollpig', `同步侧车配置失败：${error?.message ?? error}`);
    return false;
  }
}

function scheduleSync(attempt = 0) {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    const ok = await syncConfig();
    if (!ok && attempt < 10 && installed) scheduleSync(attempt + 1);
  }, attempt === 0 ? 1200 : 3000);
  syncTimer.unref?.();
}

function startPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (currentOrch) drain(currentOrch).catch(() => {});
  }, pollMs());
  pollTimer.unref?.();
}

export async function setup(skillApi) {
  api = skillApi;
  const injected = skillApi?.dataDir || skillApi?.paths?.data;
  dataDir = injected ? String(injected) : path.join(HERE, '..', '..', 'data');
}

export function available() {
  return { ok: true };
}

export function activate() {
  if (cfg().enabled === false) {
    logger.info('rollpig', '插件开关关闭，不挂载');
    return;
  }
  if (!install()) return;
  startPoll();
  restoreCache().catch(() => {});
  scheduleSync(0);
  logger.info('rollpig', `RollPig 已挂载：onIncoming 旁路，侧车 ${sidecarUrl()}`);
}

export function deactivate() {
  uninstall();
  if (pollTimer) clearInterval(pollTimer);
  if (syncTimer) clearTimeout(syncTimer);
  pollTimer = null;
  syncTimer = null;
  syncStarted = false;
}

export function dispose() {
  deactivate();
  currentOrch = null;
  attempts.clear();
}

export const providers = {
  'rollpig.status': () => ({
    installed,
    sidecar: sidecarUrl(),
    hasOrchestrator: Boolean(currentOrch),
  }),
};
