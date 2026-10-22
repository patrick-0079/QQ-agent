// 撤回消息（LLM 型 · skills/recall/）
//
// 核心只处理"**别人**撤回了消息"这类事件（store.markRecalled + 提示词过滤），
// 但没有给模型"撤回消息"的能力；协议端的 delete_msg 接口是有的（SnowLuma 能力清单里有）。
// 本技能把它包成两个工具：
//
//   recall_my_last  撤机器人自己刚发的（默认 1 条，可指定条数）
//   recall_message  按消息号 / 内容片段撤（撤别人的**只有主人**能要求）
//
// 消息号从哪来：核心的发送队列（src/sender.js）每次发完都会
// `store.appendSelf(chatKey, { text, ts, mid: data.message_id })` —— 也就是说
// 机器人自己发的每条消息在存档里都带着 QQ 消息号，`self: true` 标记它是我发的。
// 所以"找我自己最近那条"= 从存档里倒着找第一个 self 且 mid 非空的条目。
// 兜底：万一存档里没有 mid（比如走的是控制台"代为发言"通道，那条没记 mid），
// 就退回用协议端的历史接口（get_group_msg_history / get_friend_msg_history）
// 找自己发的最新一条 —— 这样"撤回我刚发的那句"在各种通道下都能work。
//
// 安全边界：
//   1. 撤**自己**的消息：谁要求都行（这是正常的纠错）
//   2. 撤**别人**的消息：只有主人能要求（读 owner-console 技能里的 ownerQq，
//      单一来源，不用两处维护）；而且机器人在群里得有管理员权限，否则协议端会拒绝，
//      这里如实把错误转述出来
//   3. 撤完调 store.markRecalled —— 与核心处理"用户撤回"一致，模型之后不会再看到它
import { getConfig } from '../../src/config.js';
import { skillManager } from '../../src/skills/manager.js';

let log = () => {};
let warn = () => {};
let cfg = () => ({});

function ok(payload) { return { content: JSON.stringify(payload, null, 1) }; }
function err(message) { return { content: String(message), isError: true }; }

/** 主人 QQ：先读 owner-console 的**生效设置**（manifest 默认 + 配置覆盖），读不到再退回配置文件。 */
function ownerQq() {
  try {
    const entry = (skillManager.list() || []).find((s) => s.id === 'owner-console');
    const v = String(entry?.settings?.ownerQq || '').trim();
    if (v) return v;
  } catch { /* 退回配置 */ }
  try {
    return String(getConfig()?.skills?.['owner-console']?.ownerQq || '').trim();
  } catch {
    return '';
  }
}

/**
 * 撤别人的消息只认一种场景：**主人自己的私聊**。
 *
 * 为什么不在群里按"最近说话的人是不是主人"来判？——第一版就是这么写的，测试立刻发现
 * 有误放行路径：群里主人刚说过话、另一个人同时让机器人撤回，触发批里"最近的发言者"
 * 就是主人，于是一个群友的请求会被当成主人的请求放行。撤回别人的消息属于管理动作，
 * 宁可按"主人的私聊"这种**无歧义**的场景判定（私聊白名单本来就只放行主人）。
 */
function ownerPrivateChat(ctx) {
  const owner = ownerQq();
  if (!owner) return { ok: false, error: '没配置主人的 QQ（在「主人控制台」技能设置里填）' };
  if (String(ctx?.kind || '') !== 'private' || String(ctx?.chatId || '') !== owner) {
    return { ok: false, error: '撤**别人**发的消息只能在主人的私聊里让我做（群里发指令分不清是谁要求的，容易被人借手）。' };
  }
  return { ok: true, owner };
}

function myEntries(ctx) {
  try {
    const recent = (typeof ctx?.store?.recent === 'function')
      ? (ctx.store.recent(ctx.chatKey, { limit: 80, includeSelf: true }) || [])
      : [];
    return recent.filter((m) => m && (m.self === true || m.senderId === 'self'));
  } catch {
    return [];
  }
}

async function deleteMsg(ctx, mid, chatKey = null) {
  const id = Number(mid);
  if (!Number.isFinite(id) || id === 0) return { ok: false, error: `消息号不合法：${mid}` };
  try {
    await ctx.onebot.call('delete_msg', { message_id: id });
    // 标记的会话必须是**这条消息所在的会话**（跨会话撤回时不是当前私聊）
    const key = chatKey || ctx.chatKey;
    try { ctx.store?.markRecalled?.(key, id); } catch { /* 存档标记失败不影响撤回 */ }
    try { ctx.emit?.('chat-update', key); } catch { /* 忽略 */ }
    return { ok: true, messageId: id };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/** 兜底：用协议端的历史接口找机器人自己发的最新一条消息号。 */
async function findMyLastViaHistory(ctx) {
  try {
    const kind = String(ctx?.kind || '');
    const selfId = String(ctx?.selfId || '');
    let list = [];
    if (kind === 'group') {
      const r = await ctx.onebot.call('get_group_msg_history', { group_id: Number(ctx.chatId), count: 20 });
      list = Array.isArray(r) ? r : (r?.messages || []);
    } else if (kind === 'private') {
      const r = await ctx.onebot.call('get_friend_msg_history', { user_id: Number(ctx.chatId), count: 20 });
      list = Array.isArray(r) ? r : (r?.messages || []);
    }
    // 历史是"旧 → 新"，倒着找自己发的最新一条
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const m = list[i];
      if (!m) continue;
      if (selfId && String(m.user_id ?? m.sender_id ?? '') !== selfId) continue;
      const mid = m.message_id ?? m.messageId;
      if (mid !== undefined && mid !== null) return { ok: true, messageId: Number(mid), via: 'history' };
    }
    return { ok: false, error: '历史接口里没找到自己发的消息' };
  } catch (error) {
    return { ok: false, error: `查历史失败：${error?.message ?? error}` };
  }
}

function brief(m) {
  const t = String(m?.text ?? '').replace(/\s+/g, ' ').slice(0, 30);
  return t || '(这条没有文本)';
}

/** 归一化名字，用于群名模糊匹配。 */
function normalizeName(s) {
  return String(s ?? '').toLowerCase().replace(/[\s\-_·.。，,、:：;；!！?？()（）【】\[\]"'“”‘’/\\|]/g, '');
}

/** 群名/群号 → 群号（只认允许说话的名单，跨会话操作同样受此约束）。 */
async function resolveChat(ctx, raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: false, error: '没说是哪个群' };
  let allow = [];
  try { allow = (getConfig()?.allow?.groups || []).map(String); } catch { allow = []; }
  if (/^\d{5,15}$/.test(s)) {
    if (allow.length && !allow.includes(s)) return { ok: false, error: `群 ${s} 不在允许说话的名单里（${allow.join('、') || '空'}）` };
    return { ok: true, chatKey: `group:${s}`, id: s, name: '' };
  }
  let list = [];
  try { list = (await ctx.onebot.call('get_group_list', {})) || []; } catch (error) {
    return { ok: false, error: `拿群列表失败：${error?.message ?? error}` };
  }
  const inAllow = list.filter((g) => !allow.length || allow.includes(String(g.group_id)));
  const t = normalizeName(s);
  const hit = inAllow.find((g) => normalizeName(g.group_name) === t)
    || inAllow.find((g) => normalizeName(g.group_name).includes(t))
    || inAllow.find((g) => t.includes(normalizeName(g.group_name)));
  if (!hit) return { ok: false, error: `没找到叫「${raw}」的群。可用的有：${inAllow.map((g) => `${g.group_name}(${g.group_id})`).join('、') || '（无）'}` };
  return { ok: true, chatKey: `group:${hit.group_id}`, id: String(hit.group_id), name: hit.group_name };
}

/**
 * 用协议端历史接口，找出机器人在**指定会话**里最近发过的 N 条消息。
 *
 * 为什么必须走历史接口、不能只看存档：机器人自己发的消息，只有在**核心发送管道**里
 * 发出去的才带消息号存档；由插件直接调 OneBot 发出去的（比如 B 站推送）不进存档。
 * 历史接口是协议端的事实记录，两种来源都在里面。
 */
async function myRecentViaHistory(ctx, chatKey, want) {
  const [kind, id] = String(chatKey).split(':');
  let r;
  if (kind === 'group') r = await ctx.onebot.call('get_group_msg_history', { group_id: Number(id), count: 60 });
  else if (kind === 'private') r = await ctx.onebot.call('get_friend_msg_history', { user_id: Number(id), count: 60 });
  else return [];
  const list = Array.isArray(r) ? r : (r?.messages || []);
  const selfId = String(ctx?.selfId || '');
  const out = [];
  for (let i = list.length - 1; i >= 0 && out.length < want; i -= 1) {
    const m = list[i];
    if (!m) continue;
    if (selfId && String(m.user_id ?? m.sender_id ?? '') !== selfId) continue;
    const mid = m.message_id ?? m.messageId;
    if (mid === undefined || mid === null) continue;
    const segs = Array.isArray(m.message) ? m.message : [];
    const text = segs.filter((s) => s?.type === 'text').map((s) => s?.data?.text || '').join(' ');
    out.push({ mid: Number(mid), text: text || (segs.some((s) => s?.type === 'image') ? '[图片]' : '') });
  }
  return out;
}

function registerTools(api) {
  // ── 1) 撤回自己刚发的 ──
  api.registerTool({
    id: 'recall_my_last',
    name: '撤回我刚发的消息',
    description: '撤回机器人**自己**发出去的消息（默认最后 1 条，可要多条）。'
      + '不传 chat = 当前会话；**传 chat（群名/群号）就去那个群里撤**自己刚发的 —— '
      + '主人在私聊里说"把某个群里我刚发的两条撤了""撤回你在某个群刚说的"就用这个（跨会话撤回只有主人能做，工具自己校验）。'
      + '适用：群友说"撤回""说错了""你刚才那条撤了"，或你自己发现发错了（复读、发错图、把报错/工具细节漏到群里）。'
      + '注意：QQ 只允许撤回 2 分钟内的消息，超时会被协议端拒绝，这时如实说明即可。',
    category: 'messaging',
    icon: '↩️',
    parameters: {
      type: 'object',
      properties: {
        count: { type: 'number', description: '撤回最近几条自己发的（1~5，默认 1）' },
        chat: { type: 'string', description: '要撤哪个会话里自己发的（群名或群号）；不传 = 当前会话' }
      }
    },
    async execute(ctx, args) {
      try {
        // ── 跨会话模式：主人在私聊里点名一个群，撤自己在那个群刚发的 ──
        const chatArg = String(args?.chat ?? '').trim();
        if (chatArg) {
          const gate = ownerPrivateChat(ctx);
          if (!gate.ok) return err(`${gate.error}（跨会话撤回需要主人身份）`);
          const target = await resolveChat(ctx, chatArg);
          if (!target.ok) return err(target.error);
          const wantCross = Math.min(5, Math.max(1, Math.round(Number(args?.count) || 1)));
          const mine = await myRecentViaHistory(ctx, target.chatKey, wantCross);
          if (!mine.length) {
            return err(`在「${target.name || target.id}」里没找到机器人自己发的消息（可能太旧、不在协议端历史里）。`);
          }
          const doneCross = [];
          const failedCross = [];
          for (const m of mine) {
            // eslint-disable-next-line no-await-in-loop
            const r = await deleteMsg(ctx, m.mid, target.chatKey);
            if (r.ok) doneCross.push({ messageId: r.messageId, text: brief(m) });
            else failedCross.push({ messageId: m.mid, text: brief(m), error: r.error });
          }
          log(`跨会话撤回：${target.name || target.id} 成功 ${doneCross.length} 条，失败 ${failedCross.length} 条`);
          if (!doneCross.length) {
            return err(`撤不回来：${failedCross.map((f) => f.error).join('；')}。`
              + '（QQ 只允许撤回 2 分钟内的消息 —— 超时的话谁都撤不掉，如实说就好）');
          }
          return ok({
            recalled: doneCross,
            failed: failedCross.length ? failedCross : undefined,
            chat: target.id,
            note: `已向 QQ 发出撤回请求（${doneCross.length} 条）。然后用 send_message 回主人一句就行；`
              + '如果主人说群里还看得到，那就是超过了 QQ 的撤回时限 —— 如实说明即可，别硬说撤掉了。'
          });
        }

        // 当前会话模式：先从存档里找自己刚发的（带消息号），找不到再用历史接口兜底
        const want = Math.min(5, Math.max(1, Math.round(Number(args?.count) || 1)));
        const mine = myEntries(ctx);
        const withMid = mine.filter((m) => m.mid !== undefined && m.mid !== null && m.mid !== '');
        if (!withMid.length) {
          // 兜底：存档里没有消息号（比如走的是"代为发言"通道），用历史接口找我发的最新一条
          const found = await findMyLastViaHistory(ctx);
          if (!found.ok) return err(`找不到可撤回的消息（${found.error}）。可能机器人刚说过的话已经超过可撤回时限，或者不是它发的。`);
          const r = await deleteMsg(ctx, found.messageId);
          if (!r.ok) return err(`撤回失败：${r.error}（QQ 只允许撤 2 分钟内的消息，超时谁都撤不掉）`);
          log(`撤回（历史兜底）消息 #${found.messageId}`);
          return ok({ recalled: [{ messageId: found.messageId }], note: '撤回成功。回一句"撤了"即可，别解释怎么做的。' });
        }
        const picked = withMid.slice(-want).reverse();   // 从最新往回撤
        const done = [];
        const failed = [];
        for (const m of picked) {
          // eslint-disable-next-line no-await-in-loop
          const r = await deleteMsg(ctx, m.mid);
          if (r.ok) done.push({ messageId: r.messageId, text: brief(m) });
          else failed.push({ messageId: m.mid, text: brief(m), error: r.error });
        }
        if (!done.length) return err(`撤回失败：${failed.map((f) => f.error).join('；')}`);
        log(`撤回 ${done.length} 条自己发的消息：${done.map((d) => d.messageId).join(', ')}`);
        return ok({
          recalled: done,
          failed: failed.length ? failed : undefined,
          note: `撤回了 ${done.length} 条。回一句"撤了"就行，别解释工具细节。`
        });
      } catch (error) {
        warn(`recall_my_last 异常：${error?.stack ?? error}`);
        return err(`撤回失败：${error?.message ?? error}`);
      }
    }
  });

  // ── 2) 按消息号 / 内容片段撤 ──
  api.registerTool({
    id: 'recall_message',
    name: '撤回指定消息',
    description: '撤回指定的消息：给 messageId（消息号），或给 contains（机器人自己最近消息里的内容片段，如"半夜"、"http"）。'
      + '撤机器**自己**发的消息：谁要求都行。撤**别人**发的消息：只有主人要求时才允许（工具会自己校验）。'
      + '需要消息号时先用 get_recent_messages 查。',
    category: 'messaging',
    icon: '🗑️',
    parameters: {
      type: 'object',
      properties: {
        messageId: { type: ['integer', 'string'], description: '要撤回的消息号（QQ message_id）' },
        contains: { type: 'string', description: '按内容片段找机器人自己最近发的那条（例如"早上好"、"链接"）' }
      }
    },
    async execute(ctx, args) {
      try {
        const rawId = args?.messageId;
        const contains = String(args?.contains ?? '').trim();

        if ((rawId === undefined || rawId === null || String(rawId).trim() === '') && !contains) {
          return err('要么给 messageId，要么给 contains（要撤哪条？）');
        }

        // ① 按内容片段：只在"我自己发的"里找，天然安全
        if ((rawId === undefined || rawId === null || String(rawId).trim() === '') && contains) {
          const mine = myEntries(ctx).filter((m) => m.mid !== undefined && m.mid !== null);
          const hit = [...mine].reverse().find((m) => String(m.text || '').includes(contains));
          if (!hit) return err(`机器人最近没发过包含「${contains}」的消息（只能撤它自己发的）。`);
          const r = await deleteMsg(ctx, hit.mid);
          if (!r.ok) return err(`撤回失败：${r.error}`);
          return ok({ recalled: { messageId: r.messageId, text: brief(hit) }, note: '撤回成功。回一句"撤了"即可。' });
        }

        // ② 按消息号
        const id = Number(rawId);
        if (!Number.isFinite(id) || id === 0) return err(`消息号不合法：${rawId}`);
        const mine = myEntries(ctx);
        const entry = mine.find((m) => String(m.mid) === String(id));
        if (!entry) {
          // 不在"我发的"里 → 可能是别人的消息、或太旧不在存档里
          const gate = ownerPrivateChat(ctx);
          if (!gate.ok) return err(`${gate.error}（这条消息号 ${id} 不在机器人自己发过的列表里）`);
          const r = await deleteMsg(ctx, id);
          if (!r.ok) return err(`撤回失败：${r.error}（QQ 只允许撤 2 分钟内的消息；撤别人的还需要机器人是群管理员）`);
          log(`撤回他人消息 #${id}（主人在私聊里要求）`);
          return ok({ recalled: { messageId: r.messageId, byOwner: true }, note: '已按主人要求撤回。回一句"撤了"即可。' });
        }
        const r = await deleteMsg(ctx, id);
        if (!r.ok) return err(`撤回失败：${r.error}`);
        return ok({ recalled: { messageId: r.messageId, text: brief(entry) }, note: '撤回成功。回一句"撤了"即可。' });
      } catch (error) {
        warn(`recall_message 异常：${error?.stack ?? error}`);
        return err(`撤回失败：${error?.message ?? error}`);
      }
    }
  });
}

export function setup(api) {
  cfg = api.config;
  log = api.log;
  warn = api.warn;
  registerTools(api);
  log('撤回消息已加载（撤自己发的：谁要求都行；撤别人的：只能在主人的私聊里）');
}

export function available() { return true; }

// 供测试/排障（加载器不消费）
export const internals = { ownerQq, ownerPrivateChat, myEntries, deleteMsg, findMyLastViaHistory, brief };
