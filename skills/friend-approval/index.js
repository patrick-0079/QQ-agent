// 好友申请审批（skills/friend-approval）
//
// 把"要不要加这个人为好友"的决定权交回给主人/管理员。
//
// 两条入口，共用同一张"待审批"表（data/friend-approval/pending.json）：
//   ① 有人申请加机器人为好友
//      → 核心把 OneBot 的 request 事件转给 friend.request 能力（确定性，不经过模型）
//   ② 群友要求机器人主动加他
//      → 模型调用 request_friend_add 工具（LLM 型，用不用由模型判断）
// 两条都会私聊请示审批人；审批人回复同意/拒绝时，模型调用 decide_friend_request 执行。
//
// ⚠️ 协议端（SnowLuma / OneBot v11）只有"接受/拒绝别人发来的好友申请"
//    （set_friend_add_request），**没有**"机器人主动发好友申请"的接口。
//    所以②审批人同意后走的是「预批准 + 请对方自己发一条申请」：
//    对方一发申请就自动通过，不必再问审批人一次。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appRoot = globalThis.__qqAgentRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { DATA_DIR, getConfig } = await import(pathToFileURL(path.join(appRoot, 'src/config.js')).href);

const STATE_DIR = path.join(DATA_DIR, 'friend-approval');
const STATE_FILE = path.join(STATE_DIR, 'pending.json');
const MAX_PENDING = 50;        // 待审批条数上限（超了丢最旧的）
const MAX_PREAPPROVED = 100;   // 预批准名单上限

let cfg = () => ({});
let log = () => {};
let warn = () => {};

export function setup(api) {
  cfg = api.config;
  log = api.log;
  warn = api.warn;

  api.registerTool({
    id: 'request_friend_add',
    name: '请示加好友',
    description: '当群里有人明确要求机器人加他好友（例如「加我」「你加我一下」「加个好友」）时使用：把这件事报给审批人请示，由审批人决定。调用后在群里回一句"我去问下管理员"即可，不要直接答应也不要一口回绝。注意：机器人自己不能主动发好友申请，所以审批人同意后要请对方自己发一条申请，那条申请会被自动通过。没有这个需求时不要调用。',
    category: 'messaging',
    icon: '🤝',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: '提出要求的群友 QQ 号，从发言人标签里取，例如「神(nm)(QQ:2661342965)」里的 2661342965' },
        note: { type: 'string', description: '对方的原话或补充说明，会一并转给审批人（可选）' }
      },
      required: ['userId']
    },
    async execute(ctx, args) {
      const userId = String(args?.userId ?? '').trim();
      if (!/^\d{5,12}$/.test(userId)) {
        return { content: `没拿到有效的 QQ 号（收到的是「${userId}」）。请把对方 QQ 号填进 userId —— 从发言人标签形如 (QQ:123456) 里取。`, isError: true };
      }
      if (userId === String(ctx.selfId)) return { content: '那是机器人自己，不用加。', isError: true };
      if (!approvers().length) {
        return { content: '还没配置审批人，我没法请示。请让管理员在「技能 → 好友申请审批」里填上审批人 QQ 号。', isError: true };
      }

      const state = readState();
      prune(state);
      if (state.pending.some((p) => p.kind === 'invite' && p.userId === userId)) {
        return { content: `${userId} 的事已经问过审批人了，还没回话。别重复请示，也别答应对方。` };
      }

      const note = String(args?.note ?? '').trim().slice(0, 120);
      const name = await resolveName(ctx.onebot, userId, ctx.kind === 'group' ? ctx.chatId : null);
      state.pending.push({
        id: `${Date.now()}-${userId}`,
        kind: 'invite',
        userId,
        name,
        note,
        chatKey: ctx.chatKey,
        askedAt: Date.now()
      });
      writeState(state);

      const sent = await askApprovers(ctx.sender, [
        `📩 ${whoText({ userId, name })} 想让我加他好友${ctx.kind === 'group' ? `（群 ${ctx.chatId}）` : ''}。`,
        ...(note ? [`对方说：${note}`] : []),
        '同意请回复「同意」，不同意请回复「拒绝」。'
      ]);
      if (!sent) return { content: '请示失败：没能把消息发给任何一个审批人，检查一下审批人 QQ 号。', isError: true };

      log(`已把加好友请示转给 ${sent} 位审批人：${userId}`);
      return { content: '已经把这件事转给审批人了。你现在在群里说一句"我去问下管理员"就行 —— 别答应、也别一口回绝；审批人同意后对方自己发一条好友申请就会自动通过。' };
    }
  });

  api.registerTool({
    id: 'decide_friend_request',
    name: '审批好友申请',
    description: '审批人（主人/管理员）在私聊里明确回复「同意 / 通过 / 行」或「拒绝 / 不同意」这类对好友申请的表态时使用，会真的通过或拒绝这条申请，别的说法不要调用。只在审批人本人的私聊里、并且确实有待审批的好友申请时使用；对方只是闲聊或意思含糊时先问清楚，不要擅自通过。',
    category: 'messaging',
    icon: '✅',
    parameters: {
      type: 'object',
      properties: {
        decision: { type: 'string', enum: ['approve', 'reject'], description: 'approve=同意通过，reject=拒绝' },
        userId: { type: 'string', description: '要处理的申请人 QQ 号；不填则处理最近一条待审批的申请' },
        reason: { type: 'string', description: '拒绝理由，只做记录，不会发给对方（可选）' }
      },
      required: ['decision']
    },
    async execute(ctx, args) {
      const decision = args?.decision === 'approve' ? 'approve' : (args?.decision === 'reject' ? 'reject' : '');
      if (!decision) return { content: 'decision 只能是 approve（同意）或 reject（拒绝）。', isError: true };

      const list = approvers();
      if (!list.length) return { content: '还没配置审批人，这次没法批。', isError: true };
      if (ctx.kind !== 'private' || !list.includes(String(ctx.chatId))) {
        return { content: `只有审批人本人私聊我时才算数（当前审批人：${list.join('、')}），这一条我不执行。`, isError: true };
      }

      const state = readState();
      prune(state);
      const wanted = String(args?.userId ?? '').trim();
      const waiting = state.pending.filter((p) => !wanted || p.userId === wanted);
      if (!waiting.length) {
        return { content: wanted ? `没有 ${wanted} 的待审批申请（可能已经处理过或过期了）。` : '现在没有待审批的好友申请。', isError: true };
      }
      // 表按申请先后排列，最后一条就是最近的那条。
      // （刻意不按 askedAt 比大小：同一毫秒内产生的两条会打平，取谁就成了运气。）
      const target = waiting[waiting.length - 1];

      try {
        // ① 对方发来的好友申请：直接调协议端接口通过 / 拒绝
        if (target.kind === 'incoming') {
          await ctx.onebot.call('set_friend_add_request', { flag: target.flag, approve: decision === 'approve' });
          removePending(state, target.id);
          writeState(state);
          log(`${decision === 'approve' ? '通过' : '拒绝'}了好友申请：${target.userId}`);
          return {
            content: `已${decision === 'approve' ? '通过' : '拒绝'} ${whoText(target)} 的好友申请。`
              + (decision === 'reject' ? '对方不会收到任何通知。' : '')
          };
        }

        // ② 群友要求机器人加他：协议端不能主动发申请 → 同意 = 预批准，对方一发申请就自动过
        if (decision === 'approve') {
          state.preapproved = [
            ...state.preapproved.filter((p) => p.userId !== target.userId),
            { userId: target.userId, at: Date.now() }
          ].slice(-MAX_PREAPPROVED);
          removePending(state, target.id);
          writeState(state);
          let told = '';
          try {
            await ctx.sender.sendTextBatch(target.chatKey, ['管理员同意啦，你发一条好友申请就行，我这边会自动通过。'], { atUserId: target.userId });
            told = '并在原会话里告诉他了';
          } catch (error) {
            told = `但通知他没成功（${error?.message ?? error}），你可能得自己去说一声`;
          }
          log(`已预批准 ${target.userId}`);
          return { content: `已同意 ${whoText(target)} 的请求，${told}。等他发来好友申请会自动通过，不用再问你。` };
        }

        removePending(state, target.id);
        writeState(state);
        log(`已拒绝 ${target.userId} 的加好友请求`);
        return { content: `已拒绝 ${whoText(target)} 的请求。机器人本来就不能主动加人，所以我也不会给他发任何消息。` };
      } catch (error) {
        return { content: `执行失败：${error?.message ?? error}`, isError: true };
      }
    }
  });
}

/**
 * OneBot 好友申请事件（由核心 src/app.js 转发进来）。
 * 事件形状：{ post_type:'request', request_type:'friend', user_id, comment, flag, time }
 */
export const providers = {
  'friend.request': async ({ event, onebot, sender } = {}) => {
    if (String(event?.request_type || '') !== 'friend') return;   // 加群申请不归本技能管
    const userId = String(event?.user_id ?? '').trim();
    const flag = String(event?.flag ?? '').trim();
    if (!/^\d{5,12}$/.test(userId) || !flag) {
      warn('收到好友申请，但 user_id/flag 缺失，已跳过');
      return;
    }

    const state = readState();
    prune(state);

    // ① 审批人此前已同意过这个人 → 直接通过，不再打扰审批人
    if (state.preapproved.some((p) => p.userId === userId)) {
      state.preapproved = state.preapproved.filter((p) => p.userId !== userId);
      writeState(state);
      try {
        await onebot.call('set_friend_add_request', { flag, approve: true });
        log(`已自动通过 ${userId} 的好友申请（审批人此前已同意）`);
        await askApprovers(sender, [`已自动通过 ${userId} 的好友申请（你之前同意过他）。`]);
      } catch (error) {
        warn(`自动通过 ${userId} 的好友申请失败：${error?.message ?? error}`);
        await askApprovers(sender, [`${userId} 发来了好友申请，你之前同意过，但自动通过失败了：${error?.message ?? error}`]);
      }
      return;
    }

    // ② 常规路径：记进待审批表，私聊问审批人
    const comment = String(event?.comment ?? '').trim();
    const name = await resolveName(onebot, userId, null);
    const dup = state.pending.find((p) => p.kind === 'incoming' && p.userId === userId);
    if (dup) {
      // 同一个人重复申请：刷新 flag（旧 flag 可能已经失效），并挪到队尾 ——
      // 队列顺序就是"最近申请"的判据，不挪的话它会一直躺在原来的位置。
      state.pending = state.pending.filter((p) => p !== dup);
      state.pending.push({ ...dup, flag, comment: comment || dup.comment, askedAt: Date.now() });
    } else {
      state.pending.push({
        id: `${Date.now()}-${userId}`,
        kind: 'incoming',
        userId,
        name,
        comment,
        flag,
        askedAt: Date.now()
      });
    }
    writeState(state);

    const sent = await askApprovers(sender, [
      `📩 有人申请加我为好友：${whoText({ userId, name })}`,
      ...(comment ? [`验证消息：${comment}`] : []),
      '同意请回复「同意」，不同意请回复「拒绝」。'
    ]);
    log(`好友申请已转呈 ${sent} 位审批人：${userId}`);
  }
};

/**
 * 可用性自检（**必须同步**）：没配审批人就没法请示，直接让技能页显示原因，
 * 而不是等到有人加好友时才静默失败。
 */
export function available() {
  if (!approvers().length) {
    return { ok: false, reason: '还没设置审批人：在技能设置里填「审批人 QQ 号」，或把人加进「设置 → 白名单」的私聊栏' };
  }
  return true;
}

/**
 * 动态提示词：只在审批人的私聊里、且真有待批申请时注入，
 * 免得审批人过一会儿就忘了自己批过什么、还剩什么。
 */
export function promptSections(ctx = {}) {
  if (ctx.kind !== 'private' || !approvers().includes(String(ctx.chatId))) return [];
  const state = readState();
  prune(state);
  if (!state.pending.length) return [];
  const minutes = (ms) => Math.max(0, Math.round((Date.now() - Number(ms)) / 60000));
  const lines = state.pending.map((p) => (p.kind === 'incoming'
    ? `- ${whoText(p)} 申请加我为好友${p.comment ? `，验证消息：「${p.comment}」` : ''}（${minutes(p.askedAt)} 分钟前）`
    : `- ${whoText(p)} 在群里要求我加他好友${p.note ? `，原话：「${p.note}」` : ''}（${minutes(p.askedAt)} 分钟前）`));
  return [{
    id: 'friend-approval-pending',
    title: '待你拍板的好友申请',
    priority: 70,
    content: `下面这些等着你回话：\n${lines.join('\n')}\n说「同意」用 friend-approval__decide_friend_request（decision=approve）执行，说「拒绝」用 decision=reject。别口头答应完就完了。`
  }];
}

// ── 内部实现 ──────────────────────────────────────────────────────────────

/** 审批人 QQ 号：技能设置优先；留空时回落到「设置 → 白名单」里的私聊名单。 */
function approvers() {
  let fromSettings = [];
  try {
    fromSettings = String(cfg().approvers ?? '').split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean);
  } catch { /* 配置读不到时走回落 */ }
  if (fromSettings.length) return [...new Set(fromSettings)];
  try {
    const list = getConfig()?.allow?.private;
    return [...new Set((Array.isArray(list) ? list : []).map(String).filter(Boolean))];
  } catch {
    return [];
  }
}

function readState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      version: 1,
      pending: Array.isArray(raw?.pending) ? raw.pending.filter((p) => p && p.userId && p.kind) : [],
      preapproved: Array.isArray(raw?.preapproved) ? raw.preapproved.filter((p) => p && p.userId) : []
    };
  } catch {
    return { version: 1, pending: [], preapproved: [] };
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ version: 1, pending: state.pending, preapproved: state.preapproved }, null, 2), 'utf8');
  } catch (error) {
    warn(`待审批表写入失败：${error?.message ?? error}`);
  }
}

/** 丢掉过期和超量的待审批项（原地改 state）。 */
function prune(state) {
  const hours = Math.max(1, Number(cfg().maxPendingHours) || 12);
  const deadline = Date.now() - hours * 3600000;
  state.pending = state.pending.filter((p) => Number(p.askedAt) >= deadline);
  if (state.pending.length > MAX_PENDING) state.pending = state.pending.slice(-MAX_PENDING);
  if (state.preapproved.length > MAX_PREAPPROVED) state.preapproved = state.preapproved.slice(-MAX_PREAPPROVED);
}

function removePending(state, id) {
  state.pending = state.pending.filter((p) => p.id !== id);
}

/** 私聊问所有审批人。返回成功送达的人数。 */
async function askApprovers(sender, lines) {
  let sent = 0;
  for (const id of approvers()) {
    try {
      await sender.sendTextBatch(`private:${id}`, lines);
      sent += 1;
    } catch (error) {
      warn(`给审批人 ${id} 发消息失败：${error?.message ?? error}`);
    }
  }
  return sent;
}

/** 尽力量取昵称；失败就只留 QQ 号（绝不因此中断流程）。 */
async function resolveName(onebot, userId, groupId) {
  try {
    const info = groupId
      ? await onebot.call('get_group_member_info', { group_id: Number(groupId), user_id: Number(userId) })
      : await onebot.call('get_stranger_info', { user_id: Number(userId) });
    return String(info?.card || info?.nickname || '').trim();
  } catch {
    return '';
  }
}

function whoText({ userId, name } = {}) {
  return name ? `${name}(QQ:${userId})` : `QQ:${userId}`;
}
