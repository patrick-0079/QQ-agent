// 记忆与存档优化（memory-plus）· 插件入口
//
// 这个插件接管控制台「记忆」页的展示与写入，并给机器人加上"长期 / 短期两层记忆"：
//   ▸ 确定性的一侧（钩子 + 定时器）
//       · before-context / before-llm-messages：记忆怎么进提示词、短期记忆什么时候过期、
//         排队的存档清理什么时候生效 —— 这些必须是死规则，不能指望模型自觉。
//       · activate 里的定时器：过期清理与存档定期清理到点必然发生。
//   ▸ 交给模型的一侧（8 个工具）
//       该不该记、该不该晋升、拿不准要不要问主人 —— 只有模型判得准。
//   ▸ 控制台侧（registerRoutes 动作路由）
//       面板的写操作入口（长期记忆的写仍然走核心自己的接口，见 lib/host.js 的说明）。
//
// 术语：界面上统一叫「记忆」（长期记忆 / 短期记忆 / 记忆标签），不再出现"印象"这个独立概念。
import path from 'node:path';
import fs from 'node:fs';

// ⚠️ 这里刻意用**带 ?t= 的动态 import** 加载自己的 lib/*，而不是静态 import：
//    Node 的 ESM 按 URL 缓存模块，静态子模块在热重载时不会更新（改了代码不生效，
//    表现为"明明改了文件，行为还是旧的"，比报错更难查）。同一个 BUST 保证这一次
//    加载出来的 5 个 lib 模块是同一批（lib 之间不互相 import，所以没有身份冲突）。
const BUST = `?t=${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const storeMod = await import(`./lib/store.js${BUST}`);
const archiveMod = await import(`./lib/archive.js${BUST}`);
const promptMod = await import(`./lib/prompt.js${BUST}`);
const llmMod = await import(`./lib/llm.js${BUST}`);
const hostMod = await import(`./lib/host.js${BUST}`);

const {
  KINDS, KIND_LABELS, addShort, removeShort, setShortKind, promoteShortItem, chatMembers, chatFlags,
  getMember, setLabels, addLabel, removeLabel, expireShort, stats,
  addQuestion, listQuestions, answerQuestion, resolveQuestion, lastAskAt,
  addPendingPrune, takePendingPrune, listPendingPrune, setLastConsolidated,
  setArchiveSweep, archiveSweepState, recordPurge, looksLikeAppointment,
  getLongMeta, setLongMeta, bumpLongMeta, load: loadState, save: saveState,
  listChats, dataDir, longMetaMap, touchMemberSeen, membersWithoutMemory,
  getLabelQueue, setLabelQueue, shiftLabelQueue, clearLabelQueue, chatsWithLabelQueue
} = storeMod;

const {
  searchLocalArchive, pruneRangeLocal, sweepOldMessages, archiveOverview, parseTime, stampOf,
  readRecentFromDisk, listBackups, restoreBackup, archivedChats, messagesDir
} = archiveMod;
const {
  buildMemoryBlock, applyToMessages, buildPendingAnswerBlock, buildAskReminderBlock, daysLeft,
  trimHistorySection, trimSystemSections, measurePrompt
} = promptMod;
const { askModel, extractJson, cleanTags, pickTags } = llmMod;
const { installHost, removeHost, hostStatus, writeSnapshot, reloadConsole } = hostMod;

// ── 模块级状态 ──────────────────────────────────────────────────────────
let apiRef = null;
let readBodyFn = null;
let jsonFn = null;
let cfg = () => ({});
const blockCache = new Map();       // sessionId -> { text, at }
const timers = [];
let lastExpireAt = 0;
let lastSnapshotAt = 0;
/** 当前整理任务（同一时刻只允许一个，面板靠轮询看进度）。 */
let job = null;
/** 最近一次操作的结论 —— 界面常驻状态区一直显示它，不用等报错才提醒。 */
let lastOperation = { at: 0, ok: true, text: '' };
/** 最近一次提示词裁剪的情况（面板显示用）。 */
let lastTrim = { at: 0, history: 0, sections: [] };
/** sessionId -> 本轮"真正发出去"的提示词（after-response 写回会话记录，让控制台显示真实内容）。 */
const finalPromptCache = new Map();
/** 最近一次实发提示词的摘要（面板状态区显示用）。 */
let lastSentPrompt = { at: 0, total: 0, memory: null, historyKept: 0, historyCut: 0, sections: [] };
/** 标签压缩队列的定时器（一次一个人、间隔 30 秒）。 */
let labelQueueTimer = null;
let labelQueueChat = '';

function noteOperation(ok, text) {
  lastOperation = { at: Date.now(), ok: ok !== false, text: String(text || '').slice(0, 400) };
  return lastOperation;
}

/** 取一条消息的纯文本（content 可能是字符串，也可能是 [{type:'text',text}] 数组）。 */
function contentText(msg) {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n');
  }
  return '';
}

// 日志：setup 之前（钩子先于 setup 触发、或测试里直接调钩子）没有 api，退回 console，
// 绝不让一条诊断信息凭空消失。
function log(...args) {
  try { if (apiRef?.log) apiRef.log(...args); else console.log('[memory-plus]', ...args); } catch { /* ignore */ }
}
function warn(...args) {
  try { if (apiRef?.warn) apiRef.warn(...args); else console.warn('[memory-plus]', ...args); } catch { /* ignore */ }
}
function verbose(...args) { if (cfg().verbose) log(...args); }

function ownerId() { return String(cfg().ownerQq || '').replace(/\D/g, ''); }
function isOwnerPrivateKey(chatKey) {
  const id = ownerId();
  return !!id && String(chatKey) === `private:${id}`;
}
/** 当前会话是不是主人私聊（决定"能不能查别的群"）。 */
function canQueryOtherChats(ctx) {
  return isOwnerPrivateKey(ctx?.chatKey);
}
function trimText(s, n) { return String(s ?? '').trim().slice(0, n); }
function kindLabel(kind) { return KIND_LABELS[kind] || kind || '一般观察'; }

// ── 功能开关 ───────────────────────────────────────────────────────────
// 每一个大功能都能单独关掉；关掉之后那部分完全回到原生行为。
// disableAll 是总闸：连钩子和工具一起停（见 available()）。
function on(key, dflt = true) {
  const v = cfg()[key];
  return v === undefined || v === null ? dflt : v !== false;
}
/** 本会话是否跳过系统提示裁剪（跑团群等）。 */
function skipTrimForChat(chatKey) {
  const list = String(cfg().trimSkipChats || '').split(/[\s,，、;；]+/).map((s) => s.trim()).filter(Boolean);
  return list.includes(String(chatKey || ''));
}
/** 要把哪个工具挡掉（返回原因字符串 = 挡；返回空 = 放行）。 */
function blockReason(toolId) {
  const id = String(toolId || '');
  if (!id) return '';
  if (on('enableToolGuard') && cfg().blockedTools) {
    const list = String(cfg().blockedTools || '').split(/[\s,，、;；]+/).map((s) => s.trim()).filter(Boolean);
    for (const key of list) {
      if (!key) continue;
      // 支持前缀：写成 "chat-archive__" 就整段拦掉
      if (id === key || (key.endsWith('__') ? id.startsWith(key) : id.startsWith(`${key}__`) || id === key)) {
        return `被「记忆与存档优化」的噪声工具拦截规则挡住（${key}）——它容易被反复挂着调、返回与话题无关的长内容。要放开就在插件设置里删掉这一条。`;
      }
    }
  }
  if (!on('enableMemory') && /^memory-plus__(note_impression|recall_impression|promote_impression|drop_impression|consolidate_memory)$/.test(id)) {
    return '「两层记忆」已关闭（插件设置里可以打开）';
  }
  if (!on('enableShortTerm') && /^memory-plus__(note_impression|promote_impression)$/.test(id)) {
    return '「短期记忆」已关闭（插件设置里可以打开）';
  }
  if (!on('enableArchiveTools') && id === 'memory-plus__search_archive') {
    return '「聊天记录检索」已关闭（插件设置里可以打开）';
  }
  return '';
}

// ══════════════════════════════════════════════════════════════════════
// 工具（模型看得见的那一侧）
// ══════════════════════════════════════════════════════════════════════

function registerTools(api) {
  // ── 1. 记一条短期记忆 ───────────────────────────────────────────────
  api.registerTool({
    id: 'note_impression',
    name: '记一条记忆（短期）',
    description: '把一条对某人的新观察记成**短期记忆**：会随时间过期、可能不准，重复记同一件事会自动累加"提及次数"。'
      + '当群友表现出新的稳定特点、偏好、身份关系，或出现"约定/答应/待提醒"这类事时使用。'
      + '不要记一时的话题、情绪波动、当天聊了什么。同一件事不要重复换词记，直接再调一次让它累加次数即可。',
    category: 'memory',
    icon: '📝',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '要记下的观察，一句话说清。约定类必须保留原话里的时间、人名、事情，不许改写。' },
        userId: { type: 'string', description: '这条记忆关于谁（QQ 号）。不填 = 当前会话对方（私聊）或触发消息的发送者。' },
        name: { type: 'string', description: '对方的名字/群名片，可选，用于显示。' },
        kind: { type: 'string', enum: KINDS, description: '类型：general 一般观察 / appointment 约定或待办 / preference 偏好 / fact 事实 / relation 关系。约定类一定要填 appointment。' },
        tags: { type: 'array', items: { type: 'string' }, description: '可选，1~3 个短标签（2~6 个字），如"嘴硬""夜猫子"。' }
      },
      required: ['content']
    },
    async execute(ctx, args) {
      try {
        const content = trimText(args?.content, 400);
        if (!content) return { content: '缺少 content：要记什么？', isError: true };
        const userId = String(args?.userId || (ctx?.kind === 'private' ? ctx?.chatId : '') || '').replace(/\D/g, '');
        if (!userId) return { content: '缺少 userId：这条记忆是关于谁的？请填对方的 QQ 号。', isError: true };
        const kind = KINDS.includes(args?.kind) ? args.kind : (looksLikeAppointment(content) ? 'appointment' : 'general');
        const r = addShort(ctx.chatKey, userId, args?.name || '', {
          content,
          kind,
          tags: args?.tags,
          source: 'tool'
        });
        const item = r.item;
        const ttl = Math.max(1, Number(cfg().shortTtlDays) || 14);
        const minHits = Math.max(1, Number(cfg().promoteMinHits) || 3);
        const head = r.merged
          ? `已累加：这件事你之前记过，现在提及次数到 ${item.hits} 次`
          : '已记成短期记忆';
        const hint = item.hits >= minHits
          ? `\n它已经出现 ${item.hits} 次（≥ 阈值 ${minHits}）。如果它确实是稳定特征/真实约定，调 promote_impression 晋升成长期记忆（要写理由）；只是一时的事就放着，${ttl} 天后会自动过期。`
          : `\n再遇到同一件事时重复调用本工具即可累加次数（当前 ${item.hits} 次，到 ${minHits} 次会被标成"建议晋升"）。${ttl} 天内没晋升就会自动删除。`;
        return { content: `${head}（类型 ${kindLabel(item.kind)}，提及×${item.hits}）。${hint}` };
      } catch (error) {
        return { content: `记记忆失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 2. 查/展开记忆 ──────────────────────────────────────────────────
  api.registerTool({
    id: 'recall_impression',
    name: '查记忆（标签速览 / 原文展开）',
    description: '查某人或本会话的记忆，分两个档：'
      + 'mode=tag 只给压缩标签（省 token，用来快速过目）；'
      + 'mode=full 给长期与短期的**原文全文**。'
      + '提示词里的【记忆】段只给了一部分（人多或记忆多时会压缩成标签），'
      + '当你要引用原话、判断一个人到底怎么回事、或标签看不懂时，用 mode=full 展开，不要靠标签猜。',
    category: 'memory',
    icon: '🔍',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: '要看谁的记忆（QQ 号）。不填 = 本会话所有人的概览。' },
        mode: { type: 'string', enum: ['tag', 'full'], description: 'tag = 只给标签；full = 给原文全文。默认 tag。' }
      }
    },
    async execute(ctx, args) {
      try {
        const mode = args?.mode === 'full' ? 'full' : 'tag';
        const wantId = String(args?.userId || '').replace(/\D/g, '');
        const shortMap = chatMembers(ctx.chatKey);
        const longMembers = safeMembers(ctx);
        const lines = [];

        const pushOne = (userId, longName, longItems, shortEntry) => {
          const name = longName || shortEntry?.name || userId || '某人';
          const labels = (shortEntry?.labels || []).map((l) => `${l.tag}${l.pinned ? '(钉)' : ''}`);
          lines.push(`【${name}（${userId || '无QQ号'}）】`);
          if (mode === 'tag') {
            lines.push(`  标签：${labels.length ? labels.join(' · ') : '（还没有标签，可以用整理记忆生成）'}`);
            lines.push(`  长期记忆 ${longItems.length} 条、短期记忆 ${(shortEntry?.short || []).length} 条（要看原文用 mode=full）`);
            return;
          }
          if (longItems.length) {
            lines.push('  —— 长期（稳定）——');
            for (const it of longItems) {
              const meta = getLongMeta(ctx.chatKey, it.content) || {};
              const marks = [
                (meta.kind === 'appointment' || looksLikeAppointment(it.content)) ? '约定·用原文' : '',
                Number(meta.hits) > 0 ? `提及×${meta.hits}` : '',
                it.createdAt ? stampOf(it.createdAt) : ''
              ].filter(Boolean).join('，');
              lines.push(`  · ${it.content}${marks ? `（${marks}）` : ''}`);
            }
          }
          const shorts = shortEntry?.short || [];
          if (shorts.length) {
            lines.push('  —— 短期（可能不准，会自动过期）——');
            const ttl = Math.max(1, Number(cfg().shortTtlDays) || 14);
            for (const s of shorts) {
              const hits = Math.max(0, Number(s.hits) || 0);
              lines.push(`  · ${s.content}（${kindLabel(s.kind)}${hits > 0 ? `，提及×${hits}` : ''}，${daysLeft(s.createdAt, ttl)} 天后过期）id=${s.id}`);
            }
          }
          if (!longItems.length && !shorts.length) lines.push('  （还没有任何记忆）');
        };

        if (wantId) {
          const long = longMembers.find((m) => String(m.userId) === wantId);
          pushOne(wantId, long?.name, long?.impressions || [], shortMap[wantId]);
        } else {
          const ids = new Set([...longMembers.map((m) => String(m.userId)), ...Object.keys(shortMap)]);
          if (!ids.size) return { content: '这个会话还没有任何记忆。' };
          for (const id of ids) {
            const long = longMembers.find((m) => String(m.userId) === String(id));
            pushOne(id, long?.name, long?.impressions || [], shortMap[id]);
          }
        }
        return { content: lines.join('\n') };
      } catch (error) {
        return { content: `查记忆失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 3. 晋升成长期记忆 ───────────────────────────────────────────────
  api.registerTool({
    id: 'promote_impression',
    name: '把短期记忆晋升为长期记忆',
    description: '把一条已经反复出现、你判断足够稳定的**短期记忆**转成**长期记忆**（写进核心的群友档案，此后长期有效、不会被自动过期）。'
      + '调用前先看一眼提及次数：次数高（达到设置里的阈值）说明它反复出现，可信；'
      + '只有一两次、或只是今天的话题，就不要晋升。必须给出理由。晋升后只能删除，不能退回短期。',
    category: 'memory',
    icon: '⬆️',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: '关于谁的 QQ 号（必填）。' },
        shortId: { type: 'string', description: '要晋升的那条短期记忆的 id（recall_impression 的 mode=full 会给出）。与 content 二选一。' },
        content: { type: 'string', description: '直接给要写进长期记忆的正文（当你不是从短期列表里挑、而是要写一条新长期记忆时用）。' },
        reason: { type: 'string', description: '为什么它够稳（一句话）。会记在档案旁注里，供以后复查。' },
        force: { type: 'boolean', description: '提及次数还没到阈值但你仍然确定要晋升时，填 true。' }
      },
      required: ['userId', 'reason']
    },
    async execute(ctx, args) {
      try {
        const userId = String(args?.userId || '').replace(/\D/g, '');
        if (!userId) return { content: '缺少 userId（QQ 号）', isError: true };
        const reason = trimText(args?.reason, 200);
        if (!reason) return { content: '缺少 reason：为什么它够稳？', isError: true };
        const minHits = Math.max(1, Number(cfg().promoteMinHits) || 3);
        const entry = getMember(ctx.chatKey, userId);
        let item = null;
        if (args?.shortId) item = (entry?.short || []).find((s) => s.id === String(args.shortId)) || null;
        if (!item && args?.content) {
          const want = trimText(args.content, 400);
          item = (entry?.short || []).find((s) => s.content === want) || null;
        }
        if (!item && !args?.content) {
          return { content: '没找到要晋升的短期记忆：请用 recall_impression（mode=full）拿到 id，或直接用 content 给出正文。', isError: true };
        }
        const hits = Math.max(0, Number(item?.hits) || 0);
        // 手工记的（提及为 0 也是人工确认过的）不卡阈值；模型记的才看提及次数
        const manual = item?.source === 'manual';
        if (item && !manual && hits < minHits && args?.force !== true) {
          return {
            content: `这条只被提到 ${hits} 次（阈值 ${minHits}），还不到该晋升的程度。`
              + '要么再观察一阵（重复调用 note_impression 累加次数），要么确认无误后带 force=true 重试。',
            isError: true
          };
        }
        const body = trimText(item?.content || args?.content, 300);
        if (!body) return { content: '要晋升的正文是空的', isError: true };
        if (typeof ctx?.memory?.append !== 'function') {
          return { content: '核心记忆不可写（拿不到 ctx.memory），这次晋升没做。', isError: true };
        }
        ctx.memory.append(ctx.chatKey, 'memberImpression', body, { userId, target: '' });
        let carried = hits;
        if (item) {
          const r = promoteShortItem(ctx.chatKey, userId, item.id, { reason, by: 'model' });
          if (r) carried = r.hits;
        } else {
          setLongMeta(ctx.chatKey, body, {
            kind: looksLikeAppointment(body) ? 'appointment' : 'general',
            reason,
            hits: 0
          });
        }
        return {
          content: `已晋升为长期记忆：「${body}」（${carried > 0 ? `提及×${carried}` : '手工确认'}，理由：${reason}）。`
            + '这条不再会过期；以后引用它不需要加"最近""好像"。'
        };
      } catch (error) {
        return { content: `晋升失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 4. 删/降级记忆 ──────────────────────────────────────────────────
  api.registerTool({
    id: 'drop_impression',
    name: '删掉一条记忆（短期 / 长期）',
    description: '删掉不准确、已过时、或不该记的记忆。scope=short 只删短期（本插件管的），'
      + 'scope=long 从核心长期档案里删，scope=both 两边都删。'
      + '当本人纠正了你、或你发现自己记错了/把玩笑当真了时使用。',
    category: 'memory',
    icon: '🗑️',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '要删掉的那条记忆的正文（可以只写其中一段，模糊匹配）。必填。' },
        userId: { type: 'string', description: '关于谁的 QQ 号，可选（填了更准）。' },
        scope: { type: 'string', enum: ['short', 'long', 'both'], description: '删哪一层：short 短期 / long 长期 / both 两边。默认 both。' }
      },
      required: ['content']
    },
    async execute(ctx, args) {
      try {
        const want = trimText(args?.content, 200);
        if (!want) return { content: '缺少 content：要删哪条？', isError: true };
        const scope = ['short', 'long', 'both'].includes(args?.scope) ? args.scope : 'both';
        const userId = String(args?.userId || '').replace(/\D/g, '');
        const notes = [];
        if (scope !== 'long') {
          const shortMap = chatMembers(ctx.chatKey);
          for (const [uid, entry] of Object.entries(shortMap)) {
            if (userId && uid !== userId) continue;
            for (const s of entry.short || []) {
              if (s.content.includes(want) || want.includes(s.content)) {
                if (removeShort(ctx.chatKey, uid, s.id)) notes.push(`短期：${s.content}`);
              }
            }
          }
        }
        if (scope !== 'short' && typeof ctx?.memory?.remove === 'function') {
          // 工具说明里承诺的是"可以只写其中一段"（模糊匹配），所以先自己把命中的原文
          // 找出来，再用**精确正文**去调核心的 remove —— 核心只认完全相等的 content。
          const map = chatMembers(ctx.chatKey) || {};
          const targets = userId ? [userId] : [...new Set(Object.keys(map))];
          if (!targets.length) targets.push('');
          for (const uid of targets) {
            let impressions = [];
            try {
              if (uid && typeof ctx.memory.getMember === 'function') {
                impressions = ctx.memory.getMember(ctx.chatKey, uid)?.impressions || [];
              }
              if (!impressions.length) {
                // 没有 getMember（或那个人读不到）就退回全量 members() 里找
                const all = safeMembers(ctx);
                impressions = uid
                  ? (all.find((m) => String(m.userId) === String(uid))?.impressions || [])
                  : all.flatMap((m) => m.impressions || []);
              }
            } catch (error) {
              verbose(`读取长期记忆失败（${uid}）：${error?.message ?? error}`);
            }
            for (const it of impressions) {
              const text = String(it?.content || '');
              if (!text) continue;
              if (!(text.includes(want) || want.includes(text))) continue;
              try {
                if (ctx.memory.remove(ctx.chatKey, 'memberImpression', { userId: uid, content: text })) {
                  notes.push(`长期：${uid || '某人'} 的「${text}」`);
                }
              } catch { /* 单条失败继续 */ }
            }
          }
        }
        if (!notes.length) return { content: `没找到包含「${want}」的记忆（可能本来就没有）。` };
        return { content: `已删除 ${notes.length} 条：\n${notes.map((n) => `- ${n}`).join('\n')}` };
      } catch (error) {
        return { content: `删除失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 5. 聊天记录检索 ─────────────────────────────────────────────────
  api.registerTool({
    id: 'search_archive',
    name: '检索聊天记录（时间 + 发送人 + 关键词）',
    description: '像聊天软件的"查找聊天记录"一样，按**时间范围 + 发送人 QQ + 关键词**一次找到相关消息，'
      + '不用一页一页往前翻。群友问"上次说的那个""前几天谁提过××"、你要核实某句话是谁什么时候说的、'
      + '或者要给某人写记忆但记不清细节时使用。三个条件都可选，全给就是 AND。'
      + '本地存档没有的部分可以 source=qq 去问 QQ 自己（只能翻页、且只能拿到最近的若干条）。',
    category: 'query',
    icon: '🔎',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '关键词（原文子串匹配）。可选。' },
        sender: { type: 'string', description: '发送人 QQ 号，或填 self 表示机器人自己发的。可选。' },
        from: { type: 'string', description: '起始时间，如 "2026-10-01" 或 "2026-10-01 14:30"。可选。' },
        to: { type: 'string', description: '结束时间，同格式（只写日期表示当天 23:59）。可选。' },
        limit: { type: 'number', description: '最多返回几条命中（默认 30，最大 200）。' },
        context: { type: 'number', description: '每条命中额外带回前后几条上下文（0~5，默认 0）。' },
        source: { type: 'string', enum: ['local', 'qq', 'auto'], description: 'local 只查本地存档（快、全）；qq 直接问 QQ；auto 本地不够时再问 QQ。默认 local。' },
        chatKey: { type: 'string', description: '要查哪个会话，如 group:123456。只有主人私聊里能查别的会话；默认查当前会话。' }
      }
    },
    async execute(ctx, args) {
      try {
        const targetKey = String(args?.chatKey || '').trim() || String(ctx.chatKey || '');
        if (targetKey !== String(ctx.chatKey) && !canQueryOtherChats(ctx)) {
          return { content: '只能查当前会话的聊天记录（跨会话检索请在主人的私聊里用）。', isError: true };
        }
        if (!/^(group|private):\d+$/.test(targetKey)) {
          return { content: `会话标识不对：${targetKey}（应该形如 group:123 或 private:456）`, isError: true };
        }
        const opts = {
          keyword: args?.keyword,
          sender: args?.sender,
          from: args?.from,
          to: args?.to,
          limit: args?.limit,
          context: args?.context
        };
        const source = ['local', 'qq', 'auto'].includes(args?.source) ? args.source : 'local';
        let local = null;
        if (source !== 'qq') local = searchLocalArchive(targetKey, opts);

        const needQq = source === 'qq' || (source === 'auto' && (!local?.ok || (local.matched || 0) < Math.min(3, Number(opts.limit) || 3)));
        let qq = null;
        if (needQq) qq = await queryQqHistory(ctx, targetKey, opts);

        const parts = [];
        if (local?.ok && local.matched) {
          parts.push(`本地存档命中 ${local.matched} 条（存档共 ${local.scanned} 条，范围 ${local.range.firstAt} ~ ${local.range.lastAt}），列出最近 ${local.returned} 条：`);
          if (local.range.from || local.range.to) parts.push(`（筛选范围：${local.range.from || '不限'} ~ ${local.range.to || '不限'}）`);
          for (const m of local.messages) {
            parts.push(`[${m.time}] ${m.senderName}(${m.senderId})#${m.mid ?? '-'}：${m.text}${m.recalled ? '（已撤回）' : ''}`);
            if (m.context?.length) {
              parts.push(`    · 上下文：${m.context.map((c) => `${c.senderName}：${c.text}`).join(' | ')}`);
            }
          }
        } else if (local && !local.ok) {
          parts.push(`本地存档：${local.error}`);
        } else if (local) {
          parts.push(`本地存档里没有符合条件的消息（存档共 ${local.scanned} 条，范围 ${local.range.firstAt} ~ ${local.range.lastAt}）。`);
        }
        if (qq) {
          if (qq.ok) {
            parts.push(`QQ 侧记录命中 ${qq.matched} 条（共取回 ${qq.fetched} 条，只能按条数往前翻，不含时间筛选）：`);
            for (const m of qq.messages) parts.push(`[${m.time}] ${m.senderName}(${m.senderId})：${m.text}`);
          } else {
            parts.push(`QQ 侧记录取回失败：${qq.error}`);
          }
        }
        const text = parts.join('\n') || '没有找到相关聊天记录。';
        return { content: `${text}\n\n（引用时请照实说"记录里是这么写的"，不要改写成自己的记忆。）` };
      } catch (error) {
        return { content: `检索失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 6. 拿不准 → 主动问主人 ──────────────────────────────────────────
  api.registerTool({
    id: 'ask_owner',
    name: '拿不准就问主人（私聊）',
    description: '当你对某条记忆的判定实在拿不准（该不该记、是不是玩笑、该不该晋升、记错了会不会冒犯），'
      + '可以直接私聊问主人，而不是自己硬猜。问题要具体、给出选项，方便主人一句话回答。'
      + '别拿鸡毛蒜皮的小事问；主人没配 QQ 号时这个工具会告诉你改用保守做法。',
    category: 'memory',
    icon: '📮',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要问主人的问题，一句话说清上下文。例如"张三说他下周要考研，这条该记成长期记忆吗？"' },
        userId: { type: 'string', description: '这条判定是关于谁的 QQ 号，可选。' },
        shortId: { type: 'string', description: '牵涉到的短期记忆 id，可选（主人回答后便于自动落定）。' }
      },
      required: ['question']
    },
    async execute(ctx, args) {
      try {
        const question = trimText(args?.question, 300);
        if (!question) return { content: '缺少 question', isError: true };
        const owner = ownerId();
        if (!owner || cfg().ownerAskEnabled === false) {
          return {
            content: '现在问不了主人（主人的 QQ 号没配，或主动询问被关掉了）。请按保守规则处理：'
              + '拿不准的记忆先记成短期记忆、不要晋升；有冒犯风险的就先不要记。'
          };
        }
        if (isOwnerPrivateKey(ctx.chatKey)) {
          return { content: '你正在主人的私聊里 —— 直接问他本人就行，不用再发一条私聊。' };
        }
        const cooldownMin = Math.max(1, Number(cfg().askCooldownMinutes) || 120);
        const ownerChat = `private:${owner}`;
        const asks = listQuestions(ownerChat);
        const last = asks.reduce((n, q) => Math.max(n, Number(q.askedAt) || 0), 0);
        if (Date.now() - last < cooldownMin * 60000) {
          const wait = Math.ceil((cooldownMin * 60000 - (Date.now() - last)) / 60000);
          return {
            content: `刚才已经问过主人一次了（${wait} 分钟后才能再问）。这次请自己按保守规则处理：`
              + '记成短期记忆、不要晋升，等下次再说。'
          };
        }
        if (typeof ctx?.sender?.sendTextBatch !== 'function') {
          return { content: '发送通道不可用，这次没问成。请自行保守处理。', isError: true };
        }
        const userId = String(args?.userId || '').replace(/\D/g, '');
        const q = addQuestion(ownerChat, {
          userId,
          name: '',
          shortId: String(args?.shortId || ''),
          question: `${question}（来自 ${ctx.chatKey}）`
        });
        await ctx.sender.sendTextBatch(ownerChat, [
          `【记忆判定求助】${question}`,
          `（你不方便一句话答的话，直接回我就行，我会按你的意思落定。编号 ${q.id}）`
        ]);
        return {
          content: `已经把问题私聊发给主人了（编号 ${q.id}）。这一条先按保守做法处理：记成短期记忆、不晋升；`
            + '主人回复后你再据他的意思落定，并调 resolve_owner_answer 汇报结论。不要在这个群里提"我去问主人了"。'
        };
      } catch (error) {
        return { content: `问主人失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 7. 落定主人的答复 ───────────────────────────────────────────────
  api.registerTool({
    id: 'resolve_owner_answer',
    name: '落定主人的答复',
    description: '主人回答了你之前的记忆判定问题后，用这个工具把结论登记下来（并顺手把该记的记上、该删的删掉）。'
      + '当【记忆判定 · 主人已经回答你了】里出现问题时，处理完必须调它汇报，否则那条问题会一直挂在"待裁决"里。',
    category: 'memory',
    icon: '✅',
    parameters: {
      type: 'object',
      properties: {
        questionId: { type: 'string', description: '问题编号（形如 q...），在提示词里给出。' },
        decision: { type: 'string', description: '结论一句话：主人是怎么定的。' },
        action: { type: 'string', enum: ['none', 'promote', 'keep-short', 'drop'], description: '你实际做的处理：none 只登记 / promote 已晋升 / keep-short 保持短期 / drop 已删除。' }
      },
      required: ['questionId', 'decision']
    },
    async execute(ctx, args) {
      try {
        const id = trimText(args?.questionId, 60);
        if (!id) return { content: '缺少 questionId', isError: true };
        const owner = ownerId();
        const candidates = [];
        if (owner) candidates.push(`private:${owner}`);
        if (ctx?.kind === 'private' && /^\d+$/.test(String(ctx?.chatId || ''))) candidates.push(`private:${ctx.chatId}`);
        candidates.push(String(ctx?.chatKey || ''));
        let q = null;
        for (const key of [...new Set(candidates)].filter(Boolean)) {
          q = resolveQuestion(key, id, args?.decision, { action: args?.action || 'none' });
          if (q) break;
        }
        if (!q) return { content: `没找到编号 ${id} 的问题（可能已经被处理过了）。`, isError: true };
        return { content: `已登记结论：「${q.decision}」（处理方式：${args?.action || 'none'}）。这条问题不再挂在待裁决里。` };
      } catch (error) {
        return { content: `登记失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 8. 整理记忆 ─────────────────────────────────────────────────────
  api.registerTool({
    id: 'consolidate_memory',
    name: '整理记忆（压缩标签 / 判定晋升 / 从聊天记录提取）',
    description: '对本会话做一次完整的记忆整理，四件事一起做：'
      + '① 删掉过期且没晋升的短期记忆；'
      + '② 把每个人现有的长期+短期记忆压缩成几个短标签（原文不删，随时可展开）；'
      + '③ 判定哪些短期记忆够稳、可以晋升成长期；'
      + '④ 回看最近的聊天记录，挑出值得记住的内容转成短期记忆。'
      + '当用户说"整理一下记忆"、或提示词里出现多条"⚑建议晋升"、或短期记忆堆得比较多时调用。'
      + '整理会花一次模型调用的钱，别频繁调。',
    category: 'memory',
    icon: '🧹',
    parameters: {
      type: 'object',
      properties: {
        extract: { type: 'boolean', description: '是否顺便从聊天记录里提取新记忆（默认按插件设置）。' },
        judge: { type: 'boolean', description: '是否让模型判定晋升候选（默认 true）。' }
      }
    },
    async execute(ctx, args) {
      try {
        const r = await consolidateChat(ctx, {
          extract: args?.extract,
          judge: args?.judge !== false,
          apply: true
        });
        return { content: r.summary, isError: r.ok === false };
      } catch (error) {
        return { content: `整理失败：${error?.message ?? error}`, isError: true };
      }
    }
  });
}

// ══════════════════════════════════════════════════════════════════════
// 工具内部用到的辅助
// ══════════════════════════════════════════════════════════════════════

/**
 * 拿核心的长期记忆。
 *   工具路径：ctx.memory 是**活的核心实例**，直接问它（最准）。
 *   面板路径（整理任务）：没有 ctx，就从磁盘读 —— 只读，不碰核心的内存缓存，
 *   所以不存在"写了被复活"的问题。少了这一条，面板点整理会看到"压缩标签 0 人"
 *   （因为它根本看不到长期记忆）。
 */
function safeMembers(ctx) {
  try {
    if (typeof ctx?.memory?.members === 'function') return ctx.memory.members(ctx.chatKey) || [];
  } catch (error) {
    verbose(`读核心记忆失败：${error?.message ?? error}`);
  }
  return readLongMembersFromDisk(ctx?.chatKey);
}

/** 只读磁盘上的长期记忆（data/memory/<会话>/<QQ>.json）。 */
function readLongMembersFromDisk(chatKey) {
  const key = String(chatKey || '');
  if (!key) return [];
  const dir = path.join(dataDirRoot(), 'memory', key.replace(/[^a-z0-9_]/gi, '_'));
  const out = [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== '_meta.json');
  } catch {
    return [];
  }
  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!raw) continue;
      const impressions = Array.isArray(raw.impressions)
        ? raw.impressions.map((e) => ({ content: String(e?.content || ''), createdAt: Number(e?.createdAt) || 0 })).filter((e) => e.content)
        : [];
      if (!impressions.length) continue;
      out.push({
        userId: String(raw.userId || f.replace(/\.json$/, '')),
        name: String(raw.name || ''),
        impressions,
        updatedAt: Number(raw.updatedAt) || 0
      });
    } catch { /* 坏文件跳过 */ }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 直接问 QQ 要最近的聊天记录（OneBot 的 history 接口没有时间/发送人筛选，只能取回后自己筛）。 */
async function queryQqHistory(ctx, chatKey, opts = {}) {
  try {
    if (typeof ctx?.onebot?.call !== 'function') return { ok: false, error: 'OneBot 通道不可用' };
    const [kind, id] = chatKey.split(':');
    const count = Math.min(200, Math.max(10, Number(opts.limit) || 30) * 3);
    const params = kind === 'group'
      ? { group_id: Number(id), count, reverse_order: true }
      : { user_id: Number(id), count, reverse_order: true };
    const action = kind === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history';
    const data = await ctx.onebot.call(action, params);
    const list = Array.isArray(data) ? data : (data?.messages || []);
    const from = parseTime(opts.from, { endOfDay: false });
    const to = parseTime(opts.to, { endOfDay: true });
    const sender = String(opts.sender || '').trim();
    const keyword = String(opts.keyword || '').trim();
    const messages = [];
    for (const m of list) {
      const ts = Number(m?.time) * 1000 || Number(m?.timestamp) * 1000 || 0;
      const uid = String(m?.sender?.user_id ?? m?.user_id ?? '');
      const name = String(m?.sender?.card || m?.sender?.nickname || m?.sender?.name || uid);
      const text = typeof m?.message === 'string' ? m.message : String(m?.raw_message ?? m?.message ?? '');
      if (from !== null && ts && ts < from) continue;
      if (to !== null && ts && ts > to) continue;
      if (sender && sender !== 'self' && uid !== sender) continue;
      if (keyword && !text.includes(keyword)) continue;
      messages.push({ time: stampOf(ts || Date.now()), senderId: uid, senderName: name, text: trimText(text, 300) });
      if (messages.length >= Math.min(60, Number(opts.limit) || 30)) break;
    }
    return { ok: true, fetched: list.length, matched: messages.length, messages };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * 整理一个会话。两个调用方：
 *   · 工具 consolidate_memory（有 ctx：能读存档、能写核心长期记忆）
 *   · 控制台面板的整理任务（没有 ctx：只做短期侧与标签，晋升结果交给面板写回核心）
 * @param {object} ctx 至少要有 chatKey
 * @param {{extract?:boolean|null, judge?:boolean, apply?:boolean, onProgress?:Function}} opts
 */
async function consolidateChat(ctx, { extract = null, judge = true, apply = true, onProgress = null } = {}) {
  const chatKey = ctx.chatKey;
  const c = cfg();
  const now = Date.now();
  const result = {
    ok: true,
    summary: '',
    promotions: [],
    labels: [],
    expired: { removed: 0 },
    extracted: 0,
    diagnostics: []
  };
  const step = (label, i, total) => {
    try { onProgress?.({ label, step: i, total }); } catch { /* 进度回调失败不影响整理 */ }
  };
  let rateLimited = 0;

  // ① 过期清理
  step('清理过期短期记忆', 0, 1);
  const ex = expireShort(c.shortTtlDays, now);
  result.expired = ex;

  const longMembers = safeMembers(ctx);
  const ids = new Set([...longMembers.map((m) => String(m.userId)), ...Object.keys(chatMembers(chatKey))]);

  // ④ 从聊天记录里提取（先做，提取出来的会被后面的标签/晋升一起考虑）
  const doExtract = extract === null ? c.consolidateExtractFromArchive !== false : extract === true;
  if (doExtract) {
    step('回看聊天记录', 0, 1);
    const scan = Math.min(2000, Math.max(20, Number(c.consolidateArchiveScanCount) || 120));
    const ex2 = await extractFromArchive(ctx, { scan, settings: c });
    if (ex2.error) result.diagnostics.push(`从聊天记录提取失败：${ex2.error}`);
    for (const it of ex2.items) {
      if (!it.userId || !it.content) continue;
      try {
        addShort(chatKey, it.userId, it.name || '', {
          content: it.content,
          kind: KINDS.includes(it.kind) ? it.kind : (looksLikeAppointment(it.content) ? 'appointment' : 'general'),
          source: 'archive'
        });
        result.extracted += 1;
        ids.add(String(it.userId));
      } catch (error) {
        verbose(`提取的记忆没记上：${error?.message ?? error}`);
      }
    }
    if (!ex2.items.length && ex2.note) result.diagnostics.push(ex2.note);
  }

  // ② ③ 逐人压缩标签 + 判定晋升
  const pending = [...ids].filter((uid) => {
    const long = longMembers.find((m) => String(m.userId) === String(uid));
    const entry = chatMembers(chatKey)[uid];
    return (long?.impressions?.length || 0) + ((entry?.short || []).length) > 0;
  });
  let tagCount = 0;
  let i = 0;
  let queued = 0;
  for (const uid of pending) {
    i += 1;
    step(`整理第 ${i}/${pending.length} 个人`, i, pending.length);
    try {
      const long = longMembers.find((m) => String(m.userId) === String(uid));
      const entry = chatMembers(chatKey)[uid] || { short: [], labels: [] };
      const shorts = entry.short || [];
      const labels = entry.labels || [];
      let tags = labels.filter((l) => l.pinned).map((l) => l.tag);
      let promotes = [];
      let judgeFailed = false;
      if (judge) {
        const judged = await judgeMember({
          name: long?.name || entry.name || uid,
          long: long?.impressions || [],
          shorts,
          maxTags: Math.max(1, Number(c.labelsPerMember) || 6),
          settings: c
        });
        judgeFailed = !!judged.error;
        if (judged.error) {
          result.diagnostics.push(`${long?.name || uid}：${judged.error}`);
          if (judged.rateLimited) rateLimited += 1;
        }
        // ── 限流：剩下的**不在这里硬顶**，转成"30 秒一个人"的排队任务 ──
        if (judged.rateLimited && i < pending.length) {
          const rest = pending.slice(i - 1);      // 含当前这个人（它的标签这次没拿到）
          setLabelQueue(chatKey, rest, {
            done: [...result.labels.filter((l) => l.tags.length).map((l) => l.userId)],
            failed: [],
            delayMs: 30000                            // 刚被限流过，先歇 30 秒再开工
          });
          queued = rest.length;
          startLabelQueueTimer(chatKey);
          break;
        }
        if (judged.tags.length) {
          tags = [...new Set([...tags, ...judged.tags])].slice(0, Math.max(1, Number(c.labelsPerMember) || 6));
        }
        promotes = judged.promote || [];
        // 逐个人串行调模型时稍微让一下，别把网关的 rps 打爆（打爆了整批标签都是空的）
        if (i < pending.length) await sleep(350);
      }
      if (apply) {
        // ⚠️ 只有模型**真的给出结果**时才重写标签。失败时一个字都不动 ——
        //    否则一次限流就会把用户已有的标签洗掉（pinned 之外的会被覆盖）。
        if (tags.length && !judgeFailed) {
          setLabels(chatKey, uid, tags, { sourceIds: shorts.map((s) => s.id) });
          tagCount += tags.length;
        }
        result.labels.push({ userId: uid, name: long?.name || entry.name || uid, tags: judgeFailed ? [] : tags });
      }
      for (const p of promotes) {
        const s = shorts.find((x) => x.id === String(p.shortId));
        if (!s) continue;
        const hits = Math.max(0, Number(s.hits) || 0);
        const minHits = Math.max(1, Number(c.promoteMinHits) || 3);
        const manual = s.source === 'manual';
        // 手工记的（人工确认过）可以直接晋升；模型记的要看次数或模型自己的把握
        if (!manual && hits < minHits && Number(p.confidence) < 75) continue;
        const body = trimText(s.content, 300);
        if (apply && typeof ctx?.memory?.append === 'function') {
          try {
            ctx.memory.append(chatKey, 'memberImpression', body, { userId: uid, target: '' });
            promoteShortItem(chatKey, uid, s.id, { reason: p.reason || '整理时判定稳定', by: 'consolidate' });
          } catch (error) {
            result.diagnostics.push(`晋升写回失败（${uid}）：${error?.message ?? error}`);
          }
        }
        result.promotions.push({
          userId: uid,
          name: long?.name || entry.name || uid,
          shortId: s.id,
          content: body,
          hits,
          reason: String(p.reason || '整理时判定稳定'),
          confidence: Number(p.confidence) || 0
        });
      }
    } catch (error) {
      result.diagnostics.push(`整理 ${uid} 时出错：${error?.message ?? error}`);
    }
  }

  if (apply) {
    setLastConsolidated(chatKey, now);
    chatFlags(chatKey, { pendingConsolidateAt: 0 });
  }

  const lines = [
    `整理完成（${chatKey}）：`,
    `· 过期删除短期记忆 ${ex.removed} 条`,
    `· 压缩标签 ${result.labels.filter((l) => l.tags.length).length} 人 / ${tagCount} 个标签`,
    `· 晋升为长期记忆 ${result.promotions.length} 条${result.promotions.length ? `：${result.promotions.map((p) => p.content).join('；')}` : ''}`,
    `· 从聊天记录新增短期记忆 ${result.extracted} 条`
  ];
  if (queued) {
    lines.push(`· 模型通道限流（429）：剩下 ${queued} 个人已转入排队模式，**每 30 秒处理一个**，进度和失败名单就在右上角状态区里（不用守着，可以切走）。`);
  } else if (rateLimited) {
    lines.push(`· 模型通道在限流（429）：有 ${rateLimited} 个人的标签这次没生成，等一分钟再点一次「整理本记忆」即可（其余部分已经做完）。`);
  }
  if (result.diagnostics.length) {
    lines.push(`· 需要留意：${result.diagnostics.slice(0, 3).join('；')}`);
  }
  result.summary = lines.join('\n');
  result.queued = queued;
  return result;
}

// ── 标签压缩队列：限流后 30 秒一个人，直到做完 ──────────────────────────
//
// 为什么要有它：批量压缩是"一个人一次模型调用"，网关限流时整批都会空。
// 队列写进了 state.json，所以热重载/重启后 activate 会接着跑完。
function startLabelQueueTimer(chatKey) {
  labelQueueChat = String(chatKey || labelQueueChat || '');
  if (labelQueueTimer) return;
  const tick = async () => {
    labelQueueTimer = null;
    try {
      await runLabelQueueOnce();
    } catch (error) {
      warn(`标签队列执行失败：${error?.message ?? error}`);
    }
    // 还有人就排下一次
    const still = labelQueueChat ? getLabelQueue(labelQueueChat) : { uids: [] };
    if (still.uids.length) {
      const wait = Math.max(1000, (still.nextAt || 0) - Date.now());
      labelQueueTimer = setTimeout(tick, wait);
      labelQueueTimer.unref?.();
    } else {
      labelQueueChat = '';
      refreshSnapshotSoon();
    }
  };
  // 第一次也等一下（刚被限流过，立刻再打还是会被拒）
  const q0 = getLabelQueue(labelQueueChat);
  const wait0 = Math.max(1000, (q0.nextAt || 0) - Date.now());
  labelQueueTimer = setTimeout(tick, wait0 || 30000);
  labelQueueTimer.unref?.();
}

/** 处理队列里的第一个人（一次一个）。 */
async function runLabelQueueOnce() {
  const chatKey = labelQueueChat;
  if (!chatKey) return;
  const q = getLabelQueue(chatKey);
  const uid = q.uids[0];
  if (!uid) return;
  const c = cfg();
  const entry = getMember(chatKey, uid) || { short: [], labels: [] };
  const long = readLongFromDisk(chatKey, uid);
  const judged = await judgeMember({
    name: long.name || entry.name || uid,
    long: long.impressions,
    shorts: entry.short,
    maxTags: Math.max(1, Number(c.labelsPerMember) || 6),
    settings: c
  });
  if (judged.error) {
    const r = shiftLabelQueue(chatKey, { error: judged.error });
    noteOperation(false, `标签队列：${long.name || uid} 失败（${judged.error}）`);
    // 限流导致的失败：留在队列里下次再试，不记成"失败名单"
    if (judged.rateLimited) {
      const cur = getLabelQueue(chatKey);
      // 把它放回队首（shiftLabelQueue 已经摘掉了），并把 nextAt 推后
      setLabelQueue(chatKey, [uid, ...cur.uids], { done: cur.done, failed: cur.failed.filter((f) => f.userId !== uid) });
    }
    void r;
  } else {
    const keep = (entry.labels || []).filter((l) => l.pinned).map((l) => l.tag);
    const tags = [...new Set([...keep, ...judged.tags])].slice(0, Math.max(1, Number(c.labelsPerMember) || 6));
    if (tags.length) setLabels(chatKey, uid, tags, { sourceIds: (entry.short || []).map((s) => s.id) });
    shiftLabelQueue(chatKey, { result: tags.join('·') });
    noteOperation(true, `标签队列：${long.name || uid} 完成（${tags.join(' · ') || '模型没给标签'}）`);
  }
  refreshSnapshotSoon();
}

/** 手动把某个会话的所有人排进标签队列。 */
function enqueueAllLabels(chatKey) {
  const long = readLongMembersFromDisk(chatKey);
  const uids = [...new Set([...long.map((m) => String(m.userId)), ...Object.keys(chatMembers(chatKey))])].filter(Boolean);
  setLabelQueue(chatKey, uids, { done: [], failed: [] });
  startLabelQueueTimer(chatKey);
  return uids.length;
}

/** 让出一点时间（不阻塞进程退出）。 */
function sleep(ms) {
  return new Promise((resolve) => { const t = setTimeout(resolve, Math.max(0, Number(ms) || 0)); t.unref?.(); });
}

/**
 * 让模型把某人的记忆压成标签 + 判晋升。
 * 返回 {tags, promote, raw, error}：**永远不抛错**，失败也把原因带回去（否则界面只会"点了没反应"）。
 */
async function judgeMember({ name, long = [], shorts = [], maxTags = 6, settings = {} }) {
  const longLines = long.slice(0, 20).map((e) => `- ${trimText(e.content, 300)}`).join('\n');
  const shortLines = shorts.slice(0, 20)
    .map((s) => `- [id=${s.id} 提及×${Math.max(0, Number(s.hits) || 0)} ${kindLabel(s.kind)}] ${trimText(s.content, 300)}`)
    .join('\n');
  if (!longLines && !shortLines) return { tags: [], promote: [], raw: '', error: '' };
  const messages = [
    {
      role: 'system',
      content: '你是聊天机器人的记忆整理模块。只做"压缩"和"判断"，绝不发明新事实、不许推测没写的内容。'
        + '输出必须是严格的 JSON 对象，不要任何解释文字、不要 markdown 代码块。格式：'
        + '{"tags":["短词1","短词2"],"promote":[{"shortId":"s1","reason":"为什么够稳","confidence":0-100}]}'
    },
    {
      role: 'user',
      content: `关于「${name}」现有记忆：\n`
        + `【长期（已确认、稳定）】\n${longLines || '（暂无）'}\n`
        + `【短期（临时观察，带提及次数）】\n${shortLines || '（暂无）'}\n\n`
        + `请输出 JSON：\n`
        + `1) tags：不超过 ${maxTags} 个"刻板印象"式短标签（每个 2~6 个汉字，如"嘴硬""夜猫子""爱发图"），用于让人一眼抓住这个人；不要整句、不要标点。\n`
        + `2) promote：从上面的短期记忆里挑出**确实已经稳定**的（提及次数高、与长期记忆一致、是稳定特征/真实约定，而不是一时的话题或情绪），`
        + `最多 3 条。confidence 是你对"它就是稳定特征"的把握（0~100）。拿不准就不要放进 promote。\n`
        + `注意：短期记忆里带〔约定〕性质的（说好/答应/待提醒）如果次数够、内容具体，优先考虑晋升。`
    }
  ];
  const r = await askModel({ messages, temperature: 0.1, maxTokens: 1200, chatKey: '', settings });
  if (!r.ok) {
    const limited = !!r.rateLimited || /429|rate.?limit|rps|tpm|rpm/i.test(String(r.error || ''));
    return { tags: [], promote: [], raw: '', error: `模型调用失败：${r.error}`, rateLimited: limited, configError: !!r.configError };
  }
  const parsed = extractJson(r.text);
  if (!parsed) {
    return { tags: [], promote: [], raw: trimText(r.text, 300), error: `模型输出不是合法 JSON（原文：${trimText(r.text, 120) || '(空)'}）` };
  }
  const tags = cleanTags(pickTags(parsed), maxTags);
  const promote = (Array.isArray(parsed.promote) ? parsed.promote : [])
    .map((p) => ({ shortId: String(p?.shortId || ''), reason: trimText(p?.reason, 120), confidence: Number(p?.confidence) || 0 }))
    .filter((p) => p.shortId);
  const error = tags.length ? '' : `模型没给出可用标签（原始返回：${trimText(JSON.stringify(parsed), 160)}）`;
  return { tags, promote, raw: trimText(r.text, 300), error };
}

/** 回看聊天记录，让模型挑出值得记住的稳定信息。返回 {items, error, note}。 */
async function extractFromArchive(ctx, { scan = 120, settings = {}, focus = [] } = {}) {
  try {
    let list = null;
    if (typeof ctx?.store?.recent === 'function') {
      list = ctx.store.recent(ctx.chatKey, { limit: Math.min(2000, scan) }) || [];
    } else {
      list = readRecentFromDisk(ctx.chatKey, Math.min(2000, scan));
    }
    if (!list || list.length < 6) return { items: [], note: `聊天记录太少（只有 ${list?.length || 0} 条），这次不提取` };

    const lines = [];
    let chars = 0;
    for (const m of list) {
      if (!m || m.isPoke || m.recalled) continue;
      const who = m.self ? '我' : `${String(m.senderName || '')}(${m.senderId})`;
      const text = trimText(m.text, 160);
      if (!text) continue;
      const line = `${stampOf(m.ts)} ${who}：${text}`;
      if (chars + line.length > 6000) break;
      chars += line.length;
      lines.push(line);
    }
    if (lines.length < 6) return { items: [], note: '有效聊天记录太少，这次不提取' };

    const messages = [
      {
        role: 'system',
        content: '你是聊天机器人的记忆整理模块。任务：从聊天记录里挑出"以后还用得上"的稳定信息，绝不发明、不推测。'
          + '输出严格 JSON，不要解释、不要 markdown 代码块。'
          + '格式：{"items":[{"userId":"123456","name":"张三","content":"一句话的观察","kind":"general|appointment|preference|fact|relation"}]}'
      },
      {
        role: 'user',
        content: `以下是最近的聊天记录（时间 发送者：内容）：\n${lines.join('\n')}\n\n`
          + (focus.length
            ? `**这几个人还没被记过，优先看看他们有没有值得记的稳定信息**：`
              + focus.map((f) => `${f.name || f.userId}(${f.userId})`).join('、') + '\n'
            : '')
          + `请挑出值得长期记住的**关于某个人的稳定信息**，最多 ${focus.length ? 5 : 3} 条：\n`
          + '- 适合记：稳定性格特点、说话习惯、明确偏好/雷点、身份关系、以及"约定/答应/待提醒"类的事。\n'
          + '- 不要记：一时的话题与情绪、当天发生了什么、玩笑话、你自己说过的话、没有明确指向某人的内容、'
          + '以及任何涉及隐私敏感（真实姓名/住址/联系方式/账号密码/金钱往来）的内容。\n'
          + '- 约定类（kind=appointment）的 content 必须保留原话里的时间、人名、事情，不许改写。\n'
          + '- 不确定就不要输出。userId 必须是记录里出现过的 QQ 号。'
      }
    ];
    const r = await askModel({ messages, temperature: 0.1, maxTokens: 1800, chatKey: ctx.chatKey, settings });
    if (!r.ok) return { items: [], error: r.error, rateLimited: !!r.rateLimited || /429|rate.?limit|rps|tpm|rpm/i.test(String(r.error || '')) };
    const parsed = extractJson(r.text);
    if (!parsed) return { items: [], error: `模型输出不是合法 JSON（原文：${trimText(r.text, 120) || '(空)'}）` };
    const raw = Array.isArray(parsed.items) ? parsed.items : (Array.isArray(parsed) ? parsed : []);
    const items = raw.slice(0, focus.length ? 5 : 3).map((it) => ({
      userId: String(it?.userId || '').replace(/\D/g, ''),
      name: trimText(it?.name, 60),
      content: trimText(it?.content, 300),
      kind: String(it?.kind || 'general')
    })).filter((it) => it.userId && it.content);
    if (!items.length) return { items: [], note: `模型认为这次没有值得记的内容（返回 ${raw.length} 条候选）` };
    return { items };
  } catch (error) {
    return { items: [], error: String(error?.message ?? error) };
  }
}

// ══════════════════════════════════════════════════════════════════════
// 钩子（确定性的一侧）
// ══════════════════════════════════════════════════════════════════════

export const hooks = {
  /**
   * 组装提示词之前，做三件"到点必然发生"的事：
   *   ① 短期记忆过期清理（顺手，10 分钟最多一次）
   *   ② 执行排队的存档时间段删除（用**活的 store 实例**，不会被内存缓存复活）
   *   ③ 把本会话的记忆块算好，缓存给 before-llm-messages 用
   * 这里绝不能做网络/模型调用（钩子 5 秒超时会被跳过）。
   */
  'before-context': ({ chatKey, sessionId, triggerEntries, store, memory }) => {
    try {
      const c = cfg();
      const now = Date.now();

      // ⓪ 花名册：把"发过言的人"登记进记忆页（节流 10 分钟，不花模型调用）
      if (chatKey && on('enableMemory')) {
        try { refreshRoster(chatKey); } catch (error) { verbose(`花名册失败：${error?.message ?? error}`); }
      }

      // ① 过期清理（节流；关掉「短期记忆」就不做）
      if (on('enableShortTerm') && now - lastExpireAt > 10 * 60 * 1000) {
        lastExpireAt = now;
        const ex = expireShort(c.shortTtlDays, now);
        if (ex.removed) verbose(`短期记忆过期清理：删了 ${ex.removed} 条`);
      }

      // ② 排队的存档删除（活 store 才能不被复活）
      if (store && typeof store.removeByLocalIds === 'function') {        const pend = takePendingPrune(chatKey);
        for (const p of pend) {
          try {
            const recent = store.recent(chatKey, { limit: 100000 }) || [];
            const ids = recent.filter((m) => Number(m.ts) >= (p.from || 0) && Number(m.ts) <= (p.to || Number.MAX_SAFE_INTEGER)).map((m) => m.id);
            const removed = ids.length ? store.removeByLocalIds(chatKey, ids) : 0;
            recordPurge({ chatKey, removed, reason: 'manual-range', note: p.note });
            verbose(`按时间段清理 ${chatKey}：删了 ${removed} 条`);
          } catch (error) {
            warn(`按时间段清理失败（${chatKey}）：${error?.message ?? error}`);
          }
        }
      }

      // ③ 算记忆块（关掉「两层记忆」就完全不动提示词里的记忆段）
      if (!sessionId || !chatKey) return;
      if (!on('enableMemory')) { blockCache.delete(String(sessionId)); return; }
      const members = (() => {
        try { return typeof memory?.members === 'function' ? memory.members(chatKey) : []; } catch { return []; }
      })();
      const shortByMember = chatMembers(chatKey);

      // 相关的人 = 本轮触发批的发送者 + 最近窗口里出现过的人（核心也是这个口径）
      const relevant = new Set();
      for (const m of triggerEntries || []) {
        if (m?.senderId && !m.self) relevant.add(String(m.senderId));
      }
      try {
        const recent = store?.recent ? store.recent(chatKey, { limit: 60 }) : [];
        for (const m of recent || []) {
          if (m?.senderId && !m.self) relevant.add(String(m.senderId));
        }
      } catch { /* 读不到就只按触发批 */ }

      const built = buildMemoryBlock({
        chatKey,
        members,
        shortByMember,
        relevantUserIds: relevant.size ? relevant : null,
        cfg: c,
        helpers: { looksLikeAppointment, getLongMeta }
      });
      if (built.replaced) {
        blockCache.set(String(sessionId), { text: built.text, at: now });
        verbose(`记忆块已备好（${chatKey}）：${built.members} 人 / 长期 ${built.longItems} / 短期 ${built.shortItems}`);
      } else {
        blockCache.delete(String(sessionId));
      }
      // 顺手清理过期的缓存条目
      for (const [k, v] of blockCache) if (now - v.at > 10 * 60 * 1000) blockCache.delete(k);
    } catch (error) {
      warn(`before-context 失败：${error?.message ?? error}`);
    }
  },

  /**
   * 消息即将发给模型，按顺序做四件事（每一件都能单独关掉）：
   *   ① 把【记忆】段换成本插件的两层版本（enableMemory）
   *   ② 裁剪【已读信息】的条数（enableHistoryTrim / historyLimit）
   *   ③ 裁掉系统提示里配置过的整段技能规则（enableSystemTrim / trimSectionTitles）
   *   ④ 插入"主人已回答的问题"与"排队中的整理任务"
   */
  'before-llm-messages': ({ messages, sessionId, chatKey }) => {
    try {
      if (!Array.isArray(messages) || !messages.length) return;
      const stats = { trimmedHistory: 0, trimmedSections: [], memory: null };
      // 记下核心原文的字数，好让面板能说清"省了多少"
      const coreChars = { system: 0, user: 0 };
      for (const m of messages) {
        if (!m) continue;
        if (m.role === 'system') coreChars.system += contentText(m).length;
        else if (m.role === 'user') coreChars.user += contentText(m).length;
      }

      // ① 记忆段
      if (on('enableMemory')) {
        const cached = sessionId ? blockCache.get(String(sessionId)) : null;
        if (cached?.text) {
          applyToMessages(messages, cached.text);
          blockCache.delete(String(sessionId));
          stats.memory = {
            members: Number(cached.members) || 0,
            labelOnly: Number(cached.labelOnly) || 0,
            longItems: Number(cached.longItems) || 0,
            shortItems: Number(cached.shortItems) || 0,
            chars: cached.text.length
          };
        }
      } else if (sessionId) {
        blockCache.delete(String(sessionId));
      }

      // ② 裁剪聊天记录 + ③ 裁系统提示段落
      const wantTrim = on('enableHistoryTrim') && Number(cfg().historyLimit) > 0;
      const wantSysTrim = on('enableSystemTrim') && String(cfg().trimSectionTitles || '').trim() && !skipTrimForChat(chatKey);
      let trimNote = '';
      if (wantTrim || wantSysTrim) {
        for (const msg of messages) {
          if (!msg) continue;
          const isSystem = msg.role === 'system';
          const apply = (text) => {
            let out = String(text);
            if (!isSystem && wantTrim) {
              const r = trimHistorySection(out, cfg().historyLimit);
              out = r.text;
              stats.trimmedHistory += r.trimmed;
              // ⚠️ 说明文字**不能写进【已读信息】块里**：session-memory-keeper 会逐行核验，
              //    认不出的行会被它换成"[旧历史格式无法核验，本轮停用]"。所以先攒着，
              //    最后贴到消息**末尾**（块外）。
              if (r.note) trimNote = r.note;
            }
            if (isSystem && wantSysTrim) {
              const r = trimSystemSections(out, cfg().trimSectionTitles);
              out = r.text;
              if (r.removed.length) stats.trimmedSections.push(...r.removed);
            }
            return out;
          };
          if (typeof msg.content === 'string') msg.content = apply(msg.content);
          else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if (part && part.type === 'text' && typeof part.text === 'string') part.text = apply(part.text);
            }
          }
          // 把裁剪说明贴成【已读信息】**前面**独立的一段（块外）。
          // 为什么不贴在消息末尾：如果【已读信息】正好是最后一段，块的范围会一直延伸到
          // 字符串结尾，说明文字又会被算进块里、被 session-memory-keeper 换成"无法核验"。
          if (trimNote && !isSystem && typeof msg.content === 'string') {
            const before = msg.content;
            msg.content = msg.content.replace(/(^|\n)(【已读信息】)/, (m, lead, head) => `${lead}（${trimNote}）\n\n${head}`);
            if (msg.content !== before) trimNote = '';
          }
        }
      }
      if (stats.trimmedHistory || stats.trimmedSections.length) {
        lastTrim = {
          at: Date.now(),
          history: stats.trimmedHistory,
          sections: [...new Set(stats.trimmedSections)]
        };
        verbose(`提示词裁剪：聊天记录少带 ${stats.trimmedHistory} 条`
          + (stats.trimmedSections.length ? `；裁掉段落 ${[...new Set(stats.trimmedSections)].join('、')}` : ''));
      }

      // ④ 追加提示
      const extras = [];
      const owner = ownerId();
      if (owner && chatKey === `private:${owner}`) {
        const answered = listQuestions(`private:${owner}`, { status: 'answered' });
        const block = buildPendingAnswerBlock(answered);
        if (block) extras.push(block);
        const pending = listQuestions(`private:${owner}`, { status: 'pending' });
        const remind = buildAskReminderBlock(pending);
        if (remind) extras.push(remind);
      }
      if (chatKey && on('enableMemory')) {
        const flags = chatFlags(chatKey);
        if (flags.pendingConsolidateAt) {
          extras.push('【记忆整理 · 已排队】主人刚在控制台点了"整理记忆"。'
            + '请立刻调用 consolidate_memory 完成这次整理（它会过期清理、压缩标签、判定晋升、并从聊天记录里提取新记忆），'
            + '然后把一句话结论告诉主人（如果这是在群里，就不要把整理细节说给群友听）。');
        }
      }
      if (extras.length) {
        const idx = Math.max(0, messages.length - 1);
        messages.splice(idx, 0, { role: 'user', content: `（系统提示，不必直接回应）${extras.join('\n\n')}` });
      }

      // ⑤ 记下"真正发出去的内容" —— 控制台的「系统提示 / 本次输入」显示的是核心拼好的
      //    原文（钩子**之前**的），用户据此以为裁剪/标签没生效。这里把实发内容缓存起来，
      //    由 after-response 写回会话记录，控制台就能显示真实内容与真实字数。
      if (sessionId) {
        const parts = { system: [], user: [] };
        for (const m of messages) {
          if (!m || (m.role !== 'system' && m.role !== 'user')) continue;
          parts[m.role].push(contentText(m));
        }
        const system = parts.system.join('\n\n');
        const user = parts.user.join('\n\n');
        const snap = {
          at: Date.now(),
          system,
          user,
          total: system.length + user.length,
          coreSystemChars: Number(coreChars.system) || 0,
          coreUserChars: Number(coreChars.user) || 0,
          memory: stats.memory || null,
          historyKept: stats.trimmedHistory ? Number(cfg().historyLimit) : 0,
          historyCut: stats.trimmedHistory,
          sections: [...new Set(stats.trimmedSections)]
        };
        finalPromptCache.set(String(sessionId), snap);
        lastSentPrompt = {
          at: snap.at,
          total: snap.total,
          memory: snap.memory,
          historyKept: snap.historyKept,
          historyCut: snap.historyCut,
          sections: snap.sections
        };
      }
    } catch (error) {
      warn(`before-llm-messages 失败：${error?.message ?? error}`);
    }
  },

  /**
   * 一轮回答结束后，把"实发提示词"写回会话记录。
   * 目的：控制台「会话」页的「系统提示 / 本次输入」不再显示核心原文，而是**真正发出去**的
   * 内容（记忆段=标签档、已读信息=裁剪后的条数），省得用户以为没生效。
   * 只改这三个纯展示字段，不动任何运行时逻辑。
   */
  'after-response': ({ session, sessionId }) => {
    try {
      const id = String(session?.id || sessionId || '');
      if (!id || !session) return;
      const snap = finalPromptCache.get(id);
      if (!snap) return;
      if (typeof session.systemPrompt === 'string') session.systemPrompt = snap.system;
      if (typeof session.userPrompt === 'string') session.userPrompt = snap.user;
      if (snap.total) session.promptChars = snap.total;
      session.memoryPlus = {
        processed: true,
        coreChars: { system: snap.coreSystemChars, user: snap.coreUserChars },
        sentChars: snap.total,
        memory: snap.memory,
        history: snap.historyCut ? { kept: snap.historyKept, cut: snap.historyCut } : null,
        sections: snap.sections
      };
    } catch (error) {
      verbose(`after-response 写回实发提示词失败：${error?.message ?? error}`);
    }
  },

  /**
   * 工具执行之后做两件事：
   *   ① 工具结果太长就截断（enableToolCap / toolResultMaxChars）—— 防止一次检索把上下文塞满、把人设带偏
   *   ② 有人直接用核心的 memory_append 记长期记忆时，给它补一条类型旁注
   *      （这样"约定类优先用原文"对核心工具写进来的内容同样生效）
   * ⚠️ 这里**不动提及次数** —— 提及次数只由"重复记录/晋升"决定，按轮次自增会让数字飞涨。
   */
  'after-tool': ({ toolName, argsRaw, chatKey, result }) => {
    try {
      // ① 结果截断（默认关闭；打开后可以用 capOnlyTools 限定只截某几个工具，
      //    避免一刀切把 list_stickers / get_recent_messages 这类"列表即信息"的结果截坏）
      if (on('enableToolCap', false) && result && !result.isError) {
        const cap = Math.max(500, Number(cfg().toolResultMaxChars) || 4000);
        const only = String(cfg().capOnlyTools || '').split(/[\s,，、;；]+/).map((s) => s.trim()).filter(Boolean);
        const name = String(toolName || '');
        const hit = !only.length || only.some((k) => name === k || name.startsWith(k.endsWith('__') ? k : `${k}__`) || name.startsWith(k));
        if (hit && typeof result.content === 'string' && result.content.length > cap) {
          const cut = result.content.length - cap;
          result.content = `${result.content.slice(0, cap)}\n…（结果太长，已省略 ${cut} 字；需要细节请换更精确的条件再查一次）`;
          noteOperation(true, `已截断 ${toolName} 的结果（省略 ${cut} 字）`);
        }
      }
      // ② memory_append 的类型旁注 + **顺带镜像成短期记忆**
      //    实测模型很爱用它自己的老接口 memory_append（它的系统提示里就是这么教的），
      //    而几乎不调我们的 note_impression（200 个会话 0 次）。为了不让"短期记忆"永远是空的，
      //    这里把 memory_append 写进来的观察**同时**记一条短期记忆（按内容去重、会合并提及次数），
      //    这样"短期 → 判定 → 晋升/过期"这套流程照常运转。可用 mirrorCoreAppend 关掉。
      if (toolName === 'memory_append' && !result?.isError) {
        const content = trimText(argsRaw?.content, 300);
        if (content && chatKey) {
          const meta = getLongMeta(chatKey, content);
          if (!meta?.kind) {
            setLongMeta(chatKey, content, {
              kind: looksLikeAppointment(content) ? 'appointment' : 'general',
              hits: 0
            });
            saveState();
          }
          if (on('mirrorCoreAppend', true)) {
            const uid = String(argsRaw?.userId || argsRaw?.target || argsRaw?.member || argsRaw?.qq || '').replace(/\D/g, '');
            if (uid) {
              try {
                const r = addShort(chatKey, uid, String(argsRaw?.name || ''), {
                  content,
                  kind: looksLikeAppointment(content) ? 'appointment' : 'general',
                  source: 'core'
                });
                verbose(`memory_append 已镜像成短期记忆：${content.slice(0, 40)}`);
                if (r?.merged) verbose('（与已有短期记忆合并，提及次数 +1）');
              } catch (error) {
                verbose(`镜像短期记忆失败：${error?.message ?? error}`);
              }
            }
          }
        }
      }
    } catch { /* 加工失败不影响主流程 */ }
  }
};

// ── 能力：tool.guard（运行期否决工具）──────────────────────────────────
// 这是核心**会主动来消费**的标准能力（多提供者）。用它做两件事：
//   · 拦掉配置里的"噪声工具"（默认 chat-archive__stats）
//   · 某个功能被关掉时，让对应工具直接不可用（界面会显示原因）
export const providers = {
  'tool.guard': ({ toolId }) => {
    const reason = blockReason(toolId);
    return reason ? { ok: false, reason } : undefined;   // undefined = 不归我管，放行
  }
};

/** 动态提示词片段：只有当本会话真的攒了"建议晋升"时才出现一行。 */
export function promptSections(ctx) {
  try {
    if (!on('enableMemory') || !on('enableShortTerm')) return [];
    const chatKey = ctx?.chatKey;
    if (!chatKey) return [];
    const c = cfg();
    const minHits = Math.max(1, Number(c.promoteMinHits) || 3);
    const map = chatMembers(chatKey);
    let n = 0;
    for (const entry of Object.values(map)) {
      for (const s of entry.short || []) {
        if ((Number(s.hits) || 0) >= minHits) n += 1;
      }
    }
    if (!n) return [];
    return [{
      id: 'memory-plus-pending',
      title: '待晋升的记忆',
      priority: 44,
      content: `本会话有 ${n} 条短期记忆已经达到"建议晋升"的提及次数。`
        + '如果这轮聊天自然相关，顺手用 promote_impression 把它们定下来（要写理由）；不合适就别硬做。'
    }];
  } catch {
    return [];
  }
}

// ══════════════════════════════════════════════════════════════════════
// 动作路由（控制台面板的写操作入口）
// ══════════════════════════════════════════════════════════════════════

export function registerRoutes(api) {
  const { registerPluginRoutes, readBody, json } = api;
  readBodyFn = readBody;
  jsonFn = json;

  const routes = [{
    method: '*',
    pattern: /^\/api\/skills\/memory-plus\/action\/([^/]+)$/,
    handler: async (ctx) => {
      // ⚠️ 动作键必须从 pathname 末段取：核那条通配路由的 match[1] 是插件 id、
      //    match[2] 才是键（app-control 为此专门写过一段注释）。
      const pathname = String(ctx.pathname || '');
      const key = decodeURIComponent(pathname.split('/').filter(Boolean).pop() || '');
      const body = ctx.method === 'GET' ? {} : await readBody(ctx.req);
      try {
        const out = await handleAction(key, body || {}, ctx);
        // 所有动作都在这里留一条"最近一次操作"的结论：界面常驻状态区一直显示它，
        // 用户不用等报错才知道发生了什么。
        const b = out?.body || {};
        if (b.ok === false) noteOperation(false, b.error || b.hint || `「${key}」没有成功`);
        else noteOperation(true, b.note || b.summary || describeAction(key, b));
        return json(ctx.res, out.status || 200, out.body);
      } catch (error) {
        const text = `记忆与存档优化动作执行失败：${String(error?.message ?? error)}`;
        noteOperation(false, text);
        return json(ctx.res, 502, { ok: false, error: text });
      }
    }
  }];

  return registerPluginRoutes('memory-plus', routes);
}

/** 面板动作分发。返回 {status, body}。 */
async function handleAction(key, body) {
  const chatKey = String(body.chatKey || '');
  const mustChat = () => {
    if (!/^(group|private):\d+$/.test(chatKey)) throw new Error(`chatKey 不对：${chatKey || '(空)'}`);
    return chatKey;
  };

  switch (key) {
    case 'overview': {
      if (chatKey) {
        mustChat();
        return { body: { ok: true, chatKey, data: chatOverview(chatKey) } };
      }
      return { body: { ok: true, chats: listChats().map((k) => ({ chatKey: k, ...chatOverview(k) })), stats: stats(), archive: archiveSweepState() } };
    }

    case 'short-save': {
      mustChat();
      const userId = String(body.userId || '').replace(/\D/g, '');
      if (!userId) throw new Error('缺少 userId');
      const content = trimText(body.content, 400);
      if (!content) throw new Error('缺少 content');
      const r = addShort(chatKey, userId, body.name || '', {
        content,
        kind: KINDS.includes(body.kind) ? body.kind : (looksLikeAppointment(content) ? 'appointment' : 'general'),
        tags: body.tags,
        source: 'manual'
      });
      refreshSnapshotSoon();
      return { body: { ok: true, item: r.item, merged: r.merged } };
    }

    case 'short-delete': {
      mustChat();
      const ok = removeShort(chatKey, String(body.userId || '').replace(/\D/g, ''), String(body.shortId || ''));
      refreshSnapshotSoon();
      return { body: { ok } };
    }

    case 'short-kind': {
      mustChat();
      const item = setShortKind(chatKey, String(body.userId || '').replace(/\D/g, ''), String(body.shortId || ''), body.kind);
      if (!item) throw new Error('没找到这条短期记忆');
      refreshSnapshotSoon();
      return { body: { ok: true, item } };
    }

    case 'labels-save': {
      mustChat();
      const userId = String(body.userId || '').replace(/\D/g, '');
      const tags = Array.isArray(body.tags) ? body.tags : String(body.tags || '').split(/[，,、\s]+/);
      const labels = setLabels(chatKey, userId, tags, { pinned: body.pinned === true });
      refreshSnapshotSoon();
      return { body: { ok: true, labels } };
    }

    case 'label-add': {
      mustChat();
      const labels = addLabel(chatKey, String(body.userId || '').replace(/\D/g, ''), body.tag, { pinned: body.pinned === true });
      refreshSnapshotSoon();
      return { body: { ok: true, labels } };
    }

    case 'label-delete': {
      mustChat();
      const ok = removeLabel(chatKey, String(body.userId || '').replace(/\D/g, ''), String(body.tag || ''));
      refreshSnapshotSoon();
      return { body: { ok } };
    }

    /** 只给某一个人重新生成标签（面板上的"压缩标签"按钮走这条，不再全群跑一遍）。 */
    case 'labels-suggest': {
      mustChat();
      const userId = String(body.userId || '').replace(/\D/g, '');
      if (!userId) throw new Error('缺少 userId');
      const c = cfg();
      const entry = getMember(chatKey, userId) || { short: [], labels: [] };
      const long = readLongFromDisk(chatKey, userId);
      const judged = await judgeMember({
        name: long.name || entry.name || userId,
        long: long.impressions,
        shorts: entry.short,
        maxTags: Math.max(1, Number(c.labelsPerMember) || 6)
      });
      const keep = (entry.labels || []).filter((l) => l.pinned).map((l) => l.tag);
      const tags = [...new Set([...keep, ...judged.tags])].slice(0, Math.max(1, Number(c.labelsPerMember) || 6));
      // 模型失败时一个字都不动（否则会把已有标签洗掉）
      if (tags.length && !judged.error) setLabels(chatKey, userId, tags, { sourceIds: entry.short.map((s) => s.id) });
      refreshSnapshotSoon();
      return {
        body: {
          ok: !!(!judged.error && tags.length),
          tags: judged.error ? [] : tags,
          raw: judged.raw || '',
          error: judged.error || '',
          hint: judged.error ? '' : (tags.length ? '' : '模型这次没给出可用标签，可以让它再试一次，或手工加标签。')
        }
      };
    }

    case 'promote': {
      mustChat();
      const userId = String(body.userId || '').replace(/\D/g, '');
      const shortId = String(body.shortId || '');
      const entry = getMember(chatKey, userId);
      const item = (entry?.short || []).find((s) => s.id === shortId);
      if (!item) throw new Error('没找到这条短期记忆（可能已被处理）');
      const reason = trimText(body.reason, 200) || '控制台人工晋升';
      const r = promoteShortItem(chatKey, userId, shortId, { reason, by: 'manual' });
      if (!r) throw new Error('晋升失败：这条短期记忆已经不在了');
      refreshSnapshotSoon();
      // 长期记忆的正文由面板通过核自己的 PUT /api/memory-files/... 写回（那是缓存正确的那条路）
      return { body: { ok: true, userId, name: entry?.name || '', content: r.content, kind: r.kind, hits: r.hits, reason } };
    }

    case 'questions': {
      return { body: { ok: true, questions: chatKey ? listQuestions(mustChat()) : [] } };
    }

    case 'question-resolve': {
      mustChat();
      const q = resolveQuestion(chatKey, String(body.questionId || ''), trimText(body.decision, 300), { action: body.action || 'manual' });
      if (!q) throw new Error('没找到这条问题');
      refreshSnapshotSoon();
      return { body: { ok: true, question: q } };
    }

    case 'question-answer': {
      mustChat();
      const q = answerQuestion(chatKey, String(body.questionId || ''), trimText(body.answer, 600));
      if (!q) throw new Error('没找到这条问题');
      refreshSnapshotSoon();
      return { body: { ok: true, question: q } };
    }

    case 'prune-preview': {
      mustChat();
      const from = parseTime(body.from, { endOfDay: false }) ?? 0;
      const to = parseTime(body.to, { endOfDay: true }) ?? Number.MAX_SAFE_INTEGER;
      const r = searchLocalArchive(chatKey, { from, to, limit: 1, includeSelf: true });
      if (!r.ok) return { body: { ok: false, error: r.error } };
      return { body: { ok: true, count: r.matched, from: stampOf(from), to: to === Number.MAX_SAFE_INTEGER ? '不限' : stampOf(to), total: r.scanned } };
    }

    case 'prune': {
      mustChat();
      const from = parseTime(body.from, { endOfDay: false }) ?? 0;
      const to = parseTime(body.to, { endOfDay: true }) ?? Number.MAX_SAFE_INTEGER;
      if (!body.confirm) throw new Error('没有确认（confirm=false）：删除存档不可撤销，请先确认');
      const disk = pruneRangeLocal(chatKey, { from, to, backup: cfg().archiveBackupBeforePurge !== false });
      // 再排一次队：如果这个会话正被核心持有（内存缓存），下一次运行时用活 store 再删一次，
      // 否则内存里的旧消息会在下一次写入时"复活"。
      addPendingPrune(chatKey, { from, to, note: trimText(body.note, 100) || '面板手动删除' });
      recordPurge({ chatKey, removed: disk.removed || 0, reason: 'manual-range', backupPath: disk.backupPath });
      refreshSnapshotSoon();
      return { body: { ok: true, removed: disk.removed || 0, backupPath: disk.backupPath || '', queued: true } };
    }

    /** 存档备份列表（一键回档用）。 */
    case 'backups': {
      mustChat();
      return { body: { ok: true, backups: listBackups(chatKey) } };
    }

    /** 一键回档：用某一份备份覆盖当前存档。 */
    case 'backup-restore': {
      mustChat();
      const r = restoreBackup(chatKey, body.file);
      if (!r.ok) throw new Error(r.error || '回档失败');
      refreshSnapshotSoon();
      return { body: { ok: true, ...r } };
    }

    case 'sweep-now': {
      const skip = body.skipActive ? [String(body.skipActive)] : [];
      const r = sweepOldMessages({
        retainDays: cfg().archiveRetainDays,
        backup: cfg().archiveBackupBeforePurge !== false,
        skipKeys: skip
      });
      setArchiveSweep();
      recordPurge({ removed: r.removed, reason: 'sweep-manual', chats: r.purged });
      refreshSnapshotSoon();
      return { body: { ok: true, ...r, details: (r.details || []).slice(0, 50) } };
    }

    /** 整理记忆：起一个后台任务，立刻返回；面板轮询 consolidate-status 看进度。 */
    case 'consolidate': {
      mustChat();
      if (job && !job.done) throw new Error(`已经有整理任务在跑（${job.chatKey}，第 ${job.step}/${job.total || '?'} 步）`);
      startConsolidateJob(chatKey, { extract: body.extract, judge: body.judge !== false });
      return { body: { ok: true, started: true, job: jobSnapshot() } };
    }

    case 'consolidate-status': {
      return { body: { ok: true, ...jobSnapshot() } };
    }

    /** 界面常驻状态区：任务进度 + 标签队列 + 最近一次操作 + 计数 + 专用模型是否生效。 */
    case 'status': {
      return { body: statusSnapshot(chatKey) };
    }

    /** 自检：插件在应用进程里到底能不能看到存档（排查"自动提取没对象"这类问题用）。 */
    case 'diag': {
      const chats = archivedChats();
      const c = cfg();
      return {
        body: {
          ok: true,
          dataDir: dataDir(),
          messagesDir: messagesDir(),
          chats: chats.map(({ chatKey }) => {
            const rows = readRecentFromDisk(chatKey, 400);
            return {
              chatKey,
              rows: rows.length,
              newest: rows.length ? new Date(Number(rows[rows.length - 1].ts)).toLocaleString('zh-CN') : '',
              lastAutoExtractAt: Number(chatFlags(chatKey).lastAutoExtractAt) || 0
            };
          }),
          settings: {
            autoExtractEnabled: c.autoExtractEnabled !== false,
            intervalHours: Number(c.autoExtractIntervalHours) || 3,
            minNew: Number(c.autoExtractMinNewMessages) || 20,
            mirrorCoreAppend: c.mirrorCoreAppend !== false,
            scan: Number(c.consolidateArchiveScanCount) || 120
          },
          busy: autoExtractBusy,
          jobState: job ? (job.done ? 'done(已结束，不影响提取)' : 'running') : 'idle',
          backoffUntil: autoExtractBackoffUntil,
          lastExtractError,
          counts: stats()
        }
      };
    }

    /** 跳过"够久/够多"的检查，立刻跑一次自动提取（面板按钮 + 核实用）。 */
    case 'extract-now': {
      const before = stats();
      const probe = archivedChats().map(({ chatKey }) => {
        const rows = readRecentFromDisk(chatKey, 400);
        return { chatKey, rows: rows.length, last: Number(chatFlags(chatKey).lastAutoExtractAt) || 0 };
      });
      const r = await maybeAutoExtract({ force: true });
      const after = stats();
      if (!r) {
        noteOperation(false, '手动提取：这次没有可提取的对象（没攒够新消息，或正在等限流重试）');
        return { body: { ok: false, note: '这次没有可提取的对象（可能还没攒够新消息，或正在等限流重试）；也可以点「整理本记忆」强制整理一遍', before, after, probe } };
      }
      if (r.error) {
        noteOperation(false, `手动提取失败：${r.error}`);
        return { body: { ok: false, ...r, before, after, probe, note: `提取失败：${r.error}` } };
      }
      noteOperation(true, r.added
        ? `手动提取：从 ${r.chatKey} 记下 ${r.added} 条短期记忆`
        : `手动提取：${r.chatKey} 里没有值得记的新内容`);
      refreshSnapshotSoon();
      return { body: { ok: true, ...r, before, after, note: r.added ? `提取到 ${r.added} 条短期记忆` : '没有值得记的新内容' } };
    }

    /** 把某个会话的所有人排进标签队列（一次一个人、间隔 30 秒）。 */
    case 'queue-start': {
      mustChat();
      const n = enqueueAllLabels(chatKey);
      return { body: { ok: true, queued: n, note: `已排队：${n} 个人，每 30 秒处理一个，刷新状态即可看进度` } };
    }

    case 'queue-clear': {
      mustChat();
      clearLabelQueue(chatKey);
      if (labelQueueChat === chatKey) labelQueueChat = '';
      refreshSnapshotSoon();
      return { body: { ok: true, note: '已清空标签队列' } };
    }

    case 'enqueue-consolidate': {
      mustChat();
      chatFlags(chatKey, { pendingConsolidateAt: Date.now() });
      return { body: { ok: true, queued: true, note: '已排队：该会话下一次运行时模型会立刻整理' } };
    }

    /** 重新扫描：把插件与技能全部重扫一遍，并强制刷新本插件的数据快照。 */
    case 'rescan': {
      const r = await rescanSkills();
      refreshSnapshot();
      return { body: { ok: true, ...r } };
    }

    case 'snapshot': {
      const ok = refreshSnapshot();
      return { body: { ok, generatedAt: lastSnapshotAt } };
    }

    case 'host-status': {
      return { body: { ok: true, host: hostStatus() } };
    }

    case 'host-reinstall': {
      const r = await installHost({ log });
      // 这是用户显式点的"重装面板"，所以无论文件有没有变都刷新一次控制台
      const reload = await reloadConsole();
      refreshSnapshot();
      return { body: { ok: r.ok !== false, ...r, reload } };
    }

    case 'host-remove': {
      const r = await removeHost({ log });
      const reload = r.changed ? await reloadConsole() : { count: 0, error: '没有改动，不需要刷新' };
      return { body: { ok: r.ok !== false, ...r, reload } };
    }

    case 'expire-now': {
      const r = expireShort(cfg().shortTtlDays);
      refreshSnapshotSoon();
      return { body: { ok: true, ...r } };
    }

    case 'data-dir': {
      return { body: { ok: true, dir: dataDir() } };
    }

    default:
      return { status: 404, body: { ok: false, error: `未知动作：${key}` } };
  }
}

/** 从磁盘读某个人的长期记忆（面板动作没有 ctx.memory，只能读文件；只读，不写）。 */
function readLongFromDisk(chatKey, userId) {
  const all = readLongMembersFromDisk(chatKey);
  const hit = all.find((m) => String(m.userId) === String(userId));
  return hit ? { name: hit.name, impressions: hit.impressions } : { name: String(userId || ''), impressions: [] };
}

/** 数据根（data/），从 store 的数据目录往上退一级。 */
function dataDirRoot() {
  return path.dirname(dataDir());
}

/** 起一个整理任务（后台跑，前端轮询进度）。 */
function startConsolidateJob(chatKey, opts) {
  job = {
    id: `j${Date.now().toString(36)}`,
    chatKey,
    startedAt: Date.now(),
    finishedAt: 0,
    label: '准备中',
    step: 0,
    total: 0,
    done: false,
    ok: true,
    summary: '',
    error: '',
    result: null
  };
  const mine = job;
  (async () => {
    try {
      const r = await consolidateChat({ chatKey, memory: null, store: null }, {
        extract: opts.extract,
        judge: opts.judge !== false,
        apply: true,
        onProgress: (p) => {
          if (job === mine) { job.label = p.label || job.label; job.step = p.step || 0; job.total = p.total || 0; }
        }
      });
      mine.result = r;
      mine.summary = r.summary;
      mine.ok = r.ok !== false;
    } catch (error) {
      mine.error = String(error?.message ?? error);
      mine.ok = false;
      mine.summary = `整理失败：${mine.error}`;
    } finally {
      mine.done = true;
      mine.finishedAt = Date.now();
      chatFlags(chatKey, { pendingConsolidateAt: 0 });
      refreshSnapshotSoon();
    }
  })();
  return job;
}

function jobSnapshot() {
  if (!job) return { running: false, job: null };
  const running = !job.done;
  return {
    running,
    job: {
      id: job.id,
      chatKey: job.chatKey,
      label: job.label,
      step: job.step,
      total: job.total,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      ok: job.ok,
      summary: job.summary,
      error: job.error,
      promotions: job.result?.promotions || [],
      labels: job.result?.labels || [],
      expired: job.result?.expired || { removed: 0 },
      extracted: job.result?.extracted || 0,
      queued: job.result?.queued || 0,
      diagnostics: job.result?.diagnostics || []
    }
  };
}

/** 只数一下磁盘上有几个长期记忆文件（状态区每几秒就会取一次，别在这儿解析全部 JSON）。 */
function countLongFromDisk(chatKey) {
  const key = String(chatKey || '');
  if (!key) return 0;
  const dir = path.join(dataDirRoot(), 'memory', key.replace(/[^a-z0-9_]/gi, '_'));
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== '_meta.json').length;
  } catch {
    return 0;
  }
}

/** 界面常驻状态区要的全部信息。 */
function statusSnapshot(chatKey) {
  const c = cfg();
  const members = chatKey ? chatMembers(chatKey) : {};
  let short = 0;
  let labels = 0;
  for (const m of Object.values(members)) {
    short += (m.short || []).length;
    labels += (m.labels || []).length;
  }
  const flags = chatKey ? chatFlags(chatKey) : { lastConsolidatedAt: 0, pendingConsolidateAt: 0 };
  const q = chatKey ? getLabelQueue(chatKey) : { uids: [], done: [], failed: [], nextAt: 0 };
  const js = jobSnapshot();
  const dedicated = llmMod.resolveDedicatedApi(c);
  const activeChat = labelQueueChat || chatKey;
  const qa = activeChat ? getLabelQueue(activeChat) : q;
  return {
    ok: true,
    chatKey: chatKey || '',
    running: js.running,
    job: js.job,
    queue: {
      active: qa.uids.length > 0,
      chatKey: qa.uids.length ? activeChat : '',
      remaining: qa.uids.length,
      done: qa.done.length,
      failed: qa.failed,
      total: qa.uids.length + qa.done.length + qa.failed.length,
      nextInSec: qa.uids.length ? Math.max(0, Math.ceil(((qa.nextAt || 0) - Date.now()) / 1000)) : 0
    },
    last: lastOperation,
    counts: {
      long: countLongFromDisk(chatKey),
      short,
      labels,
      pendingQuestions: chatKey ? listQuestions(chatKey).filter((x) => x.status !== 'resolved').length : 0
    },
    lastConsolidatedAt: flags.lastConsolidatedAt,
    pendingConsolidateAt: flags.pendingConsolidateAt || 0,
    model: {
      provider: String(c.modelProvider || ''),
      model: String(c.modelName || ''),
      dedicated: !!(dedicated && dedicated.api),
      error: (dedicated && dedicated.error) || ''
    },
    // 功能开关的当前实际状态（面板状态区直接显示，一眼看出哪些被关了）
    switches: {
      memory: on('enableMemory'),
      shortTerm: on('enableShortTerm'),
      labelFirst: on('enableLabelFirst'),
      archiveTools: on('enableArchiveTools'),
      toolCap: on('enableToolCap'),
      toolGuard: on('enableToolGuard'),
      historyTrim: on('enableHistoryTrim'),
      systemTrim: on('enableSystemTrim'),
      uiPanel: on('uiPanel')
    },
    // 花名册覆盖情况：发过言的人里有多少已经有记忆（面板显示"为什么有人没进记忆"）
    roster: (() => {
      try {
        const all = Object.entries(chatMembers(chatKey) || {}).map(([uid, m]) => ({
          uid,
          name: m.name || uid,
          count: Number(m.seen?.count) || 0,
          has: (m.short || []).length > 0 || (m.labels || []).length > 0
        }));
        const covered = all.filter((m) => m.has).length;
        return {
          total: all.length,
          covered,
          empty: all.length - covered,
          // 发言最多但还没记忆的几位（面板提示"这些人还没进记忆"）
          missing: all.filter((m) => !m.has).sort((a, b) => b.count - a.count).slice(0, 8).map((m) => `${m.name}(${m.count})`)
        };
      } catch { return { total: 0, covered: 0, empty: 0, missing: [] }; }
    })(),
    limits: {
      historyLimit: Number(c.historyLimit) || 0,
      toolResultMaxChars: Number(c.toolResultMaxChars) || 0,
      capOnlyTools: String(c.capOnlyTools || '').split(/[\s,，、;；]+/).filter(Boolean),
      mirrorCoreAppend: c.mirrorCoreAppend !== false,
      autoExtract: c.autoExtractEnabled !== false,
      autoExtractIntervalHours: Number(c.autoExtractIntervalHours) || 3,
      autoExtractMinNewMessages: Number(c.autoExtractMinNewMessages) || 20,
      blockedTools: String(c.blockedTools || '').split(/[\s,，、;；]+/).filter(Boolean)
    },
    // 最近一次提示词裁剪（面板显示"裁了多少条记录 / 裁了哪几段"）
    trim: { at: lastTrim.at, history: lastTrim.history, sections: lastTrim.sections },
    // 最近一次"真正发出去"的提示词摘要（面板用它证明裁剪/标签确实生效了）
    sent: {      at: lastSentPrompt.at,
      total: lastSentPrompt.total,
      memory: lastSentPrompt.memory,
      historyKept: lastSentPrompt.historyKept,
      historyCut: lastSentPrompt.historyCut,
      sections: lastSentPrompt.sections
    },
    host: undefined
  };
}

/** 给"最近一次操作"配一句人话（动作返回体里没有 note/summary 时用）。 */
function describeAction(key, body = {}) {
  switch (key) {
    case 'short-save': return body.merged ? '同一件事又记了一次，提及次数 +1' : '已记下一条短期记忆';
    case 'short-delete': return '已删除一条短期记忆';
    case 'short-kind': return '已修改这条短期记忆的类型';
    case 'labels-save': return `已保存标签（${(body.labels || []).length} 个）`;
    case 'label-add': return '已添加标签';
    case 'label-delete': return '已删除标签';
    case 'labels-suggest': return `标签已更新：${(body.tags || []).join(' · ') || '（无）'}`;
    case 'promote': return `已晋升为长期记忆${body.hits ? `（提及×${body.hits}）` : ''}`;
    case 'prune': return `已删除 ${body.removed || 0} 条聊天记录，并已排队复核`;
    case 'backup-restore': return `回档完成：恢复 ${body.restored || 0} 条记录`;
    case 'sweep-now': return `存档清理完成：${body.purged || 0} 个会话、共 ${body.removed || 0} 条`;
    case 'expire-now': return `已清理过期短期记忆 ${body.removed || 0} 条`;
    case 'rescan': return `已重新扫描：${body.loaded || 0} 个扩展${(body.failed || []).length ? `，${body.failed.length} 个失败` : ''}`;
    case 'question-resolve': return '已落定这条待裁决问题';
    case 'question-answer': return '已代答这条待裁决问题';
    case 'snapshot': return '状态已刷新';
    case 'consolidate': return body.started ? '已开始整理，进度会显示在右边' : '整理已提交';
    case 'queue-start': return body.note || '已排队';
    case 'extract-now': return body.note || '已尝试提取';    case 'queue-clear': return '已清空标签队列';
    case 'host-reinstall': return '面板已重装';
    default: return '';
  }
}

/** 重扫插件与技能（走核心自己的加载器，和「重新扫描」按钮同一套语义）。 */
async function rescanSkills() {
  try {
    const mod = await import('../../src/plugin-loader.js');
    const result = await mod.loadPlugins({ log });
    return {
      loaded: (result.loaded || []).length,
      failed: (result.failed || []).map((f) => ({ id: f.id, error: f.error })),
      pruned: result.pruned || []
    };
  } catch (error) {
    return { loaded: 0, failed: [], pruned: [], error: String(error?.message ?? error) };
  }
}

function chatOverview(chatKey) {
  const members = chatMembers(chatKey);
  const flags = chatFlags(chatKey);
  const questions = listQuestions(chatKey);
  return {
    chatKey,
    lastConsolidatedAt: flags.lastConsolidatedAt,
    pendingConsolidateAt: flags.pendingConsolidateAt,
    pendingPrune: flags.pendingPrune,
    questions,
    members: Object.entries(members).map(([userId, m]) => ({
      userId,
      name: m.name,
      short: m.short,
      labels: m.labels
    })),
    // 长期记忆的旁注（类型 / 提及次数 / 晋升理由），按正文原文匹配 —— 面板用它显示"约定"标记
    meta: Object.values(longMetaMap(chatKey)).map((m) => ({
      content: String(m.content || ''),
      kind: m.kind || '',
      hits: Number(m.hits) || 0,
      reason: String(m.reason || ''),
      updatedAt: Number(m.updatedAt) || 0
    }))
  };
}

// ══════════════════════════════════════════════════════════════════════
// 面板数据快照 + 定时器 + 生命周期
// ══════════════════════════════════════════════════════════════════════

let snapshotTimer = null;

/** 生成并写出前端面板读的静态快照（只含本插件的数据；长期记忆由面板直接问核心要）。 */
export function refreshSnapshot() {
  try {
    const chats = listChats().map((k) => chatOverview(k));
    const payload = {
      generatedAt: Date.now(),
      version: 2,
      dataDir: dataDir(),
      stats: stats(),
      kindLabels: KIND_LABELS,
      // 面板要按设置显示（短期保留天数、存档保留天数…），所以把当前设置也带上
      settings: { ...cfg() },
      host: hostStatus(),
      archive: { overview: archiveOverview().slice(0, 80), sweep: archiveSweepState() },
      chats
    };
    lastSnapshotAt = Date.now();
    return writeSnapshot(payload);
  } catch (error) {
    warn(`生成面板快照失败：${error?.message ?? error}`);
    return false;
  }
}

function refreshSnapshotSoon() {
  if (snapshotTimer) return;
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    try { refreshSnapshot(); } catch { /* ignore */ }
  }, 300);
  snapshotTimer.unref?.();
}

/** 到点检查存档定期清理（默认 30 天一次）。 */
function maybeSweepArchive(force = false) {
  const c = cfg();
  if (c.archiveCleanupEnabled === false && !force) return null;
  const intervalMs = Math.max(1, Number(c.archiveCleanupIntervalDays) || 30) * 86400000;
  const last = archiveSweepState().lastSweepAt || 0;
  if (!force && Date.now() - last < intervalMs) return null;
  const r = sweepOldMessages({
    retainDays: c.archiveRetainDays,
    backup: c.archiveBackupBeforePurge !== false
  });
  setArchiveSweep();
  recordPurge({ removed: r.removed, reason: 'sweep-auto', chats: r.purged });
  if (r.removed) log(`存档定期清理：${r.purged} 个会话、共 ${r.removed} 条（保留 ${c.archiveRetainDays} 天）`);
  return r;
}

/**
 * 花名册：把"在群里说过话的人"全部登记成记忆页里的成员。
 *
 * 用户反馈："为什么有些发过言的群友没有加入记忆？" —— 因为以前成员只有在
 * **被模型记了一条**之后才会出现，23 个发言人里只有 11 个有记录，剩下 12 个像没来过。
 * 这里用死规则补齐：谁说话谁就在册（累计发言数、首末次时间），完全不花模型调用。
 * 印象/标签之后由提取与压缩慢慢长上去。为避免重复计数，只处理上次之后的新消息。
 */
const rosterAt = new Map();   // chatKey -> 上次扫描时间（进程内节流）

function refreshRoster(chatKey, { force = false, ttlMs = 10 * 60 * 1000 } = {}) {
  if (!chatKey) return 0;
  const last = rosterAt.get(chatKey) || 0;
  if (!force && Date.now() - last < ttlMs) return 0;
  rosterAt.set(chatKey, Date.now());
  const since = Number(chatFlags(chatKey).lastRosterAt) || 0;
  // 首次（或很久没扫）时把窗口放大，做一次"补录"：把以前说过话、但当时没进记忆的人补进花名册
  const scan = since ? 800 : 3000;
  const rows = readRecentFromDisk(chatKey, scan);
  let added = 0;
  let maxTs = since;
  for (const m of rows) {
    if (!m || m.self || m.recalled || m.isPoke) continue;
    const ts = Number(m.ts) || 0;
    if (ts <= since) continue;
    const uid = String(m.senderId || '').replace(/\D/g, '');
    if (!uid) continue;
    try {
      if (touchMemberSeen(chatKey, uid, String(m.senderName || ''), ts)) added += 1;
    } catch (error) {
      verbose(`登记群友失败（${uid}）：${error?.message ?? error}`);
    }
    if (ts > maxTs) maxTs = ts;
  }
  if (maxTs > since) {
    chatFlags(chatKey, { lastRosterAt: maxTs });
    saveState();
  }
  if (added) verbose(`花名册：${chatKey} 新增 ${added} 位发过言的群友`);
  return added;
}

/**
 * 规则提取：**不花任何 token** 地把聊天记录里"明确约定/承诺"类的话记成短期记忆。
 *
 * 为什么需要它：模型额度会限流（实测渠道 429 tpm/rpm 超限时，整理一整天都是 0 条），
 * 而"约定类"恰恰是最不能丢的记忆。所以用死规则兜一层：只认**别人说的**、
 * 同时含"承诺动词 + 明确时间"的短句，一次最多两条，宁可少记也不误记。
 * @returns {Array<{userId:string,name:string,content:string,kind:string}>}
 */
const RULE_PROMISE = /(说好|说定了|说定|答应|约好|约定|别忘了|别忘|记得|回头|待会儿|晚点)/;
const RULE_TIME = /(明天|后天|大后天|今晚|今天晚上|晚上|早上|中午|下午|凌晨|周[一二三四五六日天末]|星期[一二三四五六日天]|\d{1,2}\s*[点:：]\s*\d{0,2})/;

function ruleExtract(chatKey, { scan = 200, since = 0, limit = 2 } = {}) {
  const rows = readRecentFromDisk(chatKey, scan);
  const out = [];
  const seen = new Set();
  for (let i = rows.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const m = rows[i];
    if (!m || m.self || m.recalled || m.isPoke || !m.text) continue;
    if (Number(m.ts) <= Number(since || 0)) continue;
    const text = String(m.text).replace(/\s+/g, ' ').replace(/\[[^\]]*\]/g, '').trim();
    if (text.length < 6 || text.length > 100) continue;
    if (!RULE_PROMISE.test(text) || !RULE_TIME.test(text)) continue;
    if (/^(哈+|笑死|草|6+|？+|\?+)$/.test(text)) continue;
    const uid = String(m.senderId || '').replace(/\D/g, '');
    if (!uid) continue;
    const key = `${uid}:${text.slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ userId: uid, name: String(m.senderName || ''), content: text.slice(0, 100), kind: 'appointment' });
  }
  return out;
}

/**
 * 自动从聊天记录里提取"新的稳定观察"→ 短期记忆。
 *
 * 为什么必须有这个：实测模型**几乎不主动记录**（200 个会话里 note_impression 被调用 0 次），
 * 光靠提示词教育它，"短期记忆"会永远是空的。所以这里兜一层确定性的：
 * 某会话距上次提取 ≥ N 小时、且期间攒够 ≥ M 条新消息时，自动提取一次（一次只处理一个会话）。
 * 成本：约每个会话每 N 小时一次模型调用（默认 3 小时 / 20 条），可以用设置关掉。
 * @returns {Promise<{chatKey:string,added:number}|null>}
 */
let autoExtractBusy = false;
let autoExtractBackoffUntil = 0;
/** 最近一次提取失败的原因（界面显示，别让人对着"没有可提取的对象"猜）。 */
let lastExtractError = null;

async function maybeAutoExtract({ force = false } = {}) {
  if (autoExtractBusy) return null;
  const c = cfg();
  if (!force && c.autoExtractEnabled === false) return null;
  // ⚠️ 必须是 `job && !job.done`：整理任务跑完后 job 对象会留着（done=true），
  //    写成 `if (job)` 会让自动提取**从此永远被跳过**（"一天都没短期记忆"的元凶）。
  if (job && !job.done) return null;
  if (!force && Date.now() < autoExtractBackoffUntil) return null;
  const intervalH = Math.max(1, Number(c.autoExtractIntervalHours) || 3);
  const minNew = Math.max(5, Number(c.autoExtractMinNewMessages) || 20);
  autoExtractBusy = true;
  try {
    // 先挑出候选（消息够多、够久、新消息够多），按"新消息最多"优先，一次只处理一个会话
    const cands = [];
    for (const { chatKey } of archivedChats()) {
      if (!chatKey) continue;
      try { refreshRoster(chatKey); } catch (error) { verbose(`花名册失败：${error?.message ?? error}`); }
      const rows = readRecentFromDisk(chatKey, 400);
      if (!rows || rows.length < 6) continue;
      const last = Number(chatFlags(chatKey).lastAutoExtractAt) || 0;
      const fresh = rows.filter((m) => Number(m.ts) > last).length;
      if (!force) {
        if (Date.now() - last < intervalH * 3600 * 1000) continue;
        if (fresh < minNew) continue;
      }
      cands.push({ chatKey, fresh, last, rows: rows.length });
    }
    cands.sort((a, b) => b.fresh - a.fresh);
    if (!cands.length) return null;

    for (const cand of cands) {
      const { chatKey, fresh } = cand;
      // ① 先用**零成本**的规则提取把"明确约定"捞出来（模型限流也照样能记）
      let added = 0;
      if (c.ruleExtractEnabled !== false) {
        for (const it of ruleExtract(chatKey, { scan: 200, since: cand.last, limit: 2 })) {
          try {
            addShort(chatKey, it.userId, it.name || '', {
              content: it.content, kind: 'appointment', source: 'rule'
            });
            added += 1;
          } catch (error) {
            verbose(`规则提取没记上：${error?.message ?? error}`);
          }
        }
      }
      // ② 再让模型回看一遍，补"稳定观察"（这一步会花 token，限流时算失败但不影响①）
      //    ★ 公平性：优先考察"还没有任何记忆"的人，否则模型每次都写那几个活跃的人，
      //      长尾群友永远进不了记忆（实测 23 个发言人里 12 个一条都没有）。
      const focus = membersWithoutMemory(chatKey, 6);
      const r = await extractFromArchive({ chatKey }, { scan: Number(c.consolidateArchiveScanCount) || 120, settings: c, focus });
      if (r.rateLimited || r.error) {
        const why = String(r.error || '模型限流');
        if (r.rateLimited) autoExtractBackoffUntil = Date.now() + 30 * 60 * 1000;
        lastExtractError = { at: Date.now(), chatKey, error: why };
        chatFlags(chatKey, { lastAutoExtractAt: Date.now() });
        saveState();
        if (added) {
          noteOperation(true, `自动提取（规则）：记下 ${added} 条约定类短期记忆；模型提取失败（${why.slice(0, 60)}），稍后再补`);
          refreshSnapshotSoon();
          return { chatKey, added, fresh, error: why, partial: true };
        }
        noteOperation(false, `自动提取失败：${why}`);
        if (!force) return { chatKey, added: 0, fresh, error: why, rateLimited: !!r.rateLimited };
        continue;   // 手动触发时换下一个会话再试
      }
      lastExtractError = null;

      for (const it of r.items) {
        if (!it.userId || !it.content) continue;
        try {
          addShort(chatKey, it.userId, it.name || '', {
            content: it.content,
            kind: KINDS.includes(it.kind) ? it.kind : (looksLikeAppointment(it.content) ? 'appointment' : 'general'),
            source: 'auto'
          });
          added += 1;
        } catch (error) {
          verbose(`自动提取的记忆没记上：${error?.message ?? error}`);
        }
      }
      chatFlags(chatKey, { lastAutoExtractAt: Date.now() });
      saveState();
      const why = r.note ? `（${r.note}）` : '';
      noteOperation(true, added
        ? `自动提取：从 ${chatKey} 最近的 ${fresh} 条记录里记下 ${added} 条短期记忆`
        : `自动提取：${chatKey} 最近的 ${fresh} 条记录里没有值得记的新内容${why}`);
      refreshSnapshotSoon();
      return { chatKey, added, fresh, note: r.note || '' };
    }
    return null;
  } finally {
    autoExtractBusy = false;
  }
}

function startTimers() {
  stopTimers();
  const t1 = setInterval(() => {
    try { expireShort(cfg().shortTtlDays); } catch (error) { warn(`过期清理失败：${error?.message ?? error}`); }
  }, 30 * 60 * 1000);
  const t2 = setInterval(() => {
    try { maybeSweepArchive(); } catch (error) { warn(`存档清理失败：${error?.message ?? error}`); }
  }, 6 * 60 * 60 * 1000);
  const t3 = setInterval(() => {
    try { if (cfg().uiPanel !== false) refreshSnapshot(); } catch { /* ignore */ }
  }, 30 * 60 * 1000);
  // 自动提取短期记忆：每 10 分钟检查一次「够久 + 攒够新消息」的会话（一次只处理一个）
  const t4 = setInterval(() => {
    maybeAutoExtract().catch((error) => warn(`自动提取失败：${error?.message ?? error}`));
  }, 10 * 60 * 1000);
  for (const t of [t1, t2, t3, t4]) { t.unref?.(); timers.push(t); }
  // 启动后 60 秒做一次"到点就清"的检查，别在启动瞬间抢 IO
  const boot = setTimeout(() => {
    try {
      if (cfg().archiveCleanupEnabled !== false) maybeSweepArchive();
      if (cfg().uiPanel !== false) refreshSnapshot();
      maybeAutoExtract().catch(() => { /* ignore */ });
    } catch (error) { warn(`启动检查失败：${error?.message ?? error}`); }
  }, 60 * 1000);
  boot.unref?.();
  timers.push(boot);
}

function stopTimers() {
  while (timers.length) {
    const t = timers.pop();
    try { clearTimeout(t); clearInterval(t); } catch { /* ignore */ }
  }
  if (snapshotTimer) { try { clearTimeout(snapshotTimer); } catch { /* ignore */ } snapshotTimer = null; }
}

/** 插件生命周期：加载一次。 */
export function setup(api) {
  apiRef = api;
  cfg = api.config;
  try {
    registerTools(api);
  } catch (error) {
    api.error?.(`注册工具失败：${error?.message ?? error}`);
    throw error;
  }
  api.log('记忆与存档优化已加载（长期/短期两层记忆 + 聊天记录检索 + 存档清理 + 一键回档）');
}

/** 被启用（或热重载后重新激活）：装界面、起定时器。 */
export async function activate(ctx = {}) {
  try {
    const c = cfg();
    if (c.uiPanel !== false) {
      const r = await installHost({ log });
      if (r.ok === false) warn(`控制台界面没装上（不影响机器人功能）：${r.error}`);
      else if (r.changed) {
        // 界面文件变了/刚装上 → 让控制台自己刷新一次（等价于用户按 F5）。
        // 幂等安装保证这里不会变成重载循环。
        const rr = await reloadConsole();
        if (rr.count > 0) log(`控制台已刷新（${rr.count} 个窗口），「记忆」页已接管`);
        else warn(`界面已装好，但自动刷新控制台没做成（${rr.error}）—— 你按一下 F5 就能看到新界面`);
      }
      refreshSnapshot();
    }
    startTimers();
    // 上次限流留下的标签队列：接着跑完（队列写在 state.json 里，热重载/重启都不丢）
    try {
      const pendingQueues = chatsWithLabelQueue();
      if (pendingQueues.length) {
        labelQueueChat = pendingQueues[0];
        startLabelQueueTimer(labelQueueChat);
        log(`标签队列续跑：${labelQueueChat} 还有 ${getLabelQueue(labelQueueChat).uids.length} 个人（每 30 秒一个）`);
      }
    } catch (error) {
      warn(`续跑标签队列失败：${error?.message ?? error}`);
    }
    log('记忆与存档优化已激活');
  } catch (error) {
    warn(`激活失败：${error?.message ?? error}`);
  }
}

/** 被关闭：清定时器。热重载时**不摘界面**（避免闪烁，activate 会立刻重装覆盖）。 */
export function deactivate(ctx = {}) {
  stopTimers();
  if (ctx?.reason === 'reload') return;
  if (cfg().uiPanel !== false) {
    removeHost({ log }).catch(() => { /* ignore */ });
  }
}

/** 卸载/热重载的最终清理。 */
export function dispose() {
  stopTimers();
  blockCache.clear();
  finalPromptCache.clear();
}

/** 可用性自检：必须同步返回（返回 Promise 会被当成"可用"）。
 *  ⚠️ 这里**故意不再有**"全部停用"那种自毁总开关：它会把插件变成「不可用」，
 *     界面上只剩一句吓人的报错（用户实测：关掉后提示还留着，以为坏了）。
 *     要整块停用请用「插件」页自带的插件级开关（核心的标准做法），
 *     单个功能则用设置里的 ①~⑧ 分开关。 */
export function available() {
  try {
    loadState();
    return true;
  } catch (error) {
    return { ok: false, reason: `记忆数据目录不可读：${error?.message ?? error}` };
  }
}

export { consolidateChat, chatOverview, refreshSnapshot as _refreshSnapshot, jobSnapshot as _jobSnapshot, ruleExtract as _ruleExtract, maybeAutoExtract as _maybeAutoExtract };
