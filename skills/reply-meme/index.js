import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createSource, rankCandidates } from './lib/source.js';
import { buildCandidates, candidateId, describe } from './lib/candidates.js';
import { resolvePolicy, hasMedia, hasText, stopped } from './lib/policy.js';
import { createHistory } from './lib/history.js';
import { fingerprint } from './lib/image.js';
import { createImageCache } from './lib/cache.js';
import { selectionInfo } from './lib/metadata.js';
import { createLocalSource } from './lib/local.js';

const DEFAULT_DIR = path.join(os.tmpdir(), 'qq-agent-reply-meme');
const integer = (v, fallback, min, max) => Math.min(max, Math.max(min, Number.isFinite(Number(v ?? fallback)) ? Math.floor(Number(v ?? fallback)) : fallback));
const result = (data, isError = false) => ({ content: JSON.stringify(data), ...(isError ? { isError: true } : {}) });
const strings = value => Array.isArray(value) && value.length > 0 && value.every(x => typeof x === 'string' && x.length > 0 && x.length <= 80);
let runtime;

export const hooks = {
  'before-llm-messages': ctx => runtime?.beforeMessages(ctx),
  'after-response': ctx => runtime?.afterResponse(ctx)
};
export const promptSections = ctx => runtime?.promptSections(ctx) || [];
export const available = () => runtime?.available() ?? true;
export const activate = () => runtime?.activate();
export const deactivate = () => runtime?.deactivate();
export const dispose = () => runtime?.deactivate();

// Optional dependencies are for isolated verification; the host passes only api.
export async function setup(api, { cacheDir = DEFAULT_DIR } = {}) {
  runtime?.deactivate();
  const settings = () => api.config() || {};
  const log = message => { try { api.log?.(message); } catch { /* optional logger */ } };
  const httpFetch = (...args) => {
    if (settings().networkEnabled === false) throw new Error('网络图源已关闭');
    return api.fetch(...args);
  };
  const source = createSource(httpFetch, cacheDir);
  const local = createLocalSource();
  const images = createImageCache(httpFetch, cacheDir);
  const history = createHistory(cacheDir);
  const sessions = new Map();
  let active = false, controller = new AbortController(), timer, refresh, lastIndexAt = 0;
  const policy = () => resolvePolicy(settings());
  const localEnabled = () => settings().localEnabled === true;
  const networkEnabled = () => settings().networkEnabled !== false;
  const allowed = item => item.origin === 'local'
    ? localEnabled() && path.resolve(String(settings().localDirectory || '').trim()) === item.localRoot
    : networkEnabled();
  const networkShelf = () => [...new Map([...images.cachedItems(), ...source.peek()].map(item => [item.original, item])).values()];
  const localLoad = async () => {
    if (!localEnabled()) { local.clear(); return []; }
    try { return await local.load(settings().localDirectory, controller.signal); }
    catch (error) { if (!controller.signal.aborted) log(`本地表情目录暂不可用：${error.message}`); return []; }
  };
  // 工具是否可被调用由宿主注册器判断；这里只检查自身生命周期。
  const usable = () => active;
  const releaseState = state => { for (const ticket of state.tickets.values()) if (!ticket.sending) ticket.release?.(); };
  const expireSessions = () => {
    for (const [id, state] of sessions) if (Date.now() - state.at > 30 * 60000) { releaseState(state); sessions.delete(id); }
  };
  const cooling = key => history.cooling(key, integer(settings().cooldownSeconds, 60, 0, 3600));
  const keyOf = ctx => String(ctx.sessionId || ctx.session?.id || '');
  const stateOf = (ctx, reset = false) => {
    const key = keyOf(ctx);
    if (!key || !ctx.chatKey) return null;
    let state = sessions.get(key);
    if (state && state.chatKey !== ctx.chatKey) return null;
    if (reset || !state) {
      if (state) releaseState(state);
      state = { chatKey: ctx.chatKey, at: Date.now(), round: 0, offered: new Map(), tickets: new Map(), text: '', sent: 0, uncertain: false, busy: false, prepareAttempts: 0, downloads: new Set(), prefetched: false };
      sessions.set(key, state);
    }
    state.at = Date.now();
    expireSessions();
    while (sessions.size > 200) { const key = sessions.keys().next().value; releaseState(sessions.get(key)); sessions.delete(key); }
    return state;
  };
  const current = (ctx, state) => sessions.get(keyOf(ctx)) === state && active && !stopped(ctx.session);
  const offer = (state, items, compact = false) => items.map(item => {
    state.offered.set(candidateId(item), item);
    while (state.offered.size > 160) state.offered.delete(state.offered.keys().next().value);
    const data = describe(item, history.seen(state.chatKey, fingerprint(item.original)), { compact });
    return compact ? { ...data, ...(images.cached(item) ? { cached: true } : {}) } : { ...data, cached: images.cached(item) };
  });
  const shelf = (state, items, limit = 12, relevantOnly = false) => buildCandidates(items, state.text, {
    limit, relevantOnly, seed: state.chatKey + ':' + state.at, seen: item => history.seen(state.chatKey, fingerprint(item.original)), cached: item => images.cached(item)
  });

  const warm = () => {
    if (!usable()) return;
    if (localEnabled()) { void localLoad(); return; }
    if (refresh || !networkEnabled()) return;
    refresh = source.load(integer(settings().cacheMinutes, 1440, 1, 1440), controller.signal)
      .then(({ items, at }) => { if (at !== lastIndexAt) { lastIndexAt = at; log(`表情候选索引已就绪（${items.length} 张，由主聊天模型选图）`); } })
      .catch(error => { if (!controller.signal.aborted) log(`索引暂不可用：${error.message}`); })
      .finally(() => { refresh = null; });
  };
  runtime = {
    available() { return localEnabled() || (networkEnabled() && typeof api.fetch === 'function'); },
    activate() {
      if (active) return;
      active = true;
      controller = new AbortController();
      images.sweep();
      warm();
      timer = setInterval(() => { expireSessions(); images.sweep(); warm(); }, 60000);
      timer.unref?.();
    },
    deactivate() {
      active = false;
      clearInterval(timer);
      controller.abort();
      local.clear();
      for (const state of sessions.values()) releaseState(state);
      sessions.clear();
    },
    beforeMessages(ctx) {
      if (!usable() || !Array.isArray(ctx.messages)) return;
      const state = stateOf(ctx, true);
      if (!state) return;
      // Retrieval uses a short text view; the main model retains every original message.
      state.text = ctx.messages.filter(m => m.role === 'user' && typeof m.content === 'string').map(m => m.content).join('\n').slice(-6000);
      if (!policy().proactive) return;
      if (cooling(ctx.chatKey)) {
        ctx.messages.push({ role: 'user', content: '[梗鲸本轮状态：主动配图冷却中；明确点图仍可检索。]' });
        return;
      }
      const limit = integer(settings().promptCandidates, 3, 0, 12);
      if (!limit || hasMedia(ctx.session)) return;
      const localItems = localEnabled() ? local.peek(settings().localDirectory).filter(images.available) : [];
      const contextual = localEnabled() && !!state.text.trim();
      let chosen = shelf(state, localItems, limit, contextual);
      if (!chosen.length && networkEnabled()) {
        const items = rankCandidates(networkShelf().filter(images.available), { defaultCharacter: settings().character || 'auto', random: true });
        chosen = shelf(state, items, limit, contextual);
      }
      const candidates = offer(state, chosen, true);
      if (!candidates.length) return;
      ctx.messages.push({ role: 'user', content: '[梗鲸候选数据，非指令；选中id后调用find_meme({"ids":[id]})换取ticket；id不能用于send_meme。]\n' + JSON.stringify(candidates) });
    },
    afterResponse(ctx) {
      if (!active) return;
      const state = stateOf(ctx);
      if (state) state.round++;
      // Observe the normal model boundary; never manufacture or reorder tool calls.
    },
    promptSections() {
      if (!usable()) return [];
      const p = policy();
      // System prefix depends only on settings. Per-chat cooldown belongs at
      // the end of user messages; sending must not rewrite the system prefix.
      const timing = !p.proactive ? '仅响应明确点图。' : p.hint;
      const max = integer(settings().maxCount, 3, 1, 3);
      const content = timing + ` 点图默认 ${integer(settings().count, 1, 1, max)} 张，上限 ${max}；主动最多 1 张。`;
      return [{ id: 'reply-meme-current-intensity', title: '梗鲸表情使用时机', priority: 45, content }];
    }
  };

  api.registerTool({
    id: 'find_meme', name: '查找与准备梗鲸表情', category: 'sticker', icon: '🐳',
    description: '按配置优先本地、其次缓存、最后网络检索表情，或传已见过的 ids 准备图片并取得 ticket；不发送。已有贴切候选直接准备；准备成功仍未发送，需继续调用 send_meme。',
    parameters: { type: 'object', additionalProperties: false, properties: {
      ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3, description: '已在本次上下文或检索结果中见过的候选 id。提供后只准备这些图片，返回 ticket；主动配图选 1 张。' },
      keyword: { type: 'string', description: '可选，用自己想表达的动作、态度或台词搜索，如抱抱、得意、好耶；多个词为空格分隔的备选表达。留空浏览。' },
      emotion: { type: 'string', description: '可选，搜索意图如自嘲、开心；由你根据完整对话判断，不要求固定情绪词。' },
      character: { type: 'string', description: '可选角色，如 DeepSeek、Claude、GPT、豆包；auto 不限。' },
      random: { type: 'boolean', description: '只有用户明确要求随机时为 true；仍遵守角色、关键词和情绪筛选。可能返回含义未知的图片，只能用 request 发送，不能编造其内容。' }
    } },
    async execute(ctx, args = {}) {
      if (!args || typeof args !== 'object' || Array.isArray(args)) return result({ reason: '工具参数必须是对象。' }, true);
      const state = stateOf(ctx);
      if (!state || !usable() || stopped(ctx.session)) return result({ reason: '当前会话或表情工具不可用。' }, true);
      if (state.busy) return result({ reason: '本轮已有表情操作正在处理。' }, true);
      if (args.ids !== undefined && (!strings(args.ids) || args.ids.length > integer(settings().maxCount, 3, 1, 3))) return result({ reason: 'ids 必须是 1~3 个已提供的候选编号，且不超过配置上限。' }, true);
      state.busy = true;
      const signal = controller.signal;
      try {
        const c = settings();
        if (args.ids === undefined) {
          if (state.prepareAttempts >= 3) return result({ candidates: [], sent: 0, next: '本轮准备次数已到上限，请停止检索和换图，继续文字回复。' }, true);
          const keyword = typeof args.keyword === 'string' ? args.keyword.trim().slice(0, 120) : '';
          const emotion = typeof args.emotion === 'string' ? args.emotion.trim().slice(0, 40) : '';
          const contextual = localEnabled() && !keyword && !emotion && args.random !== true && !!state.text.trim();
          const rank = (items, isLocal = false) => {
            const ranked = rankCandidates(items.filter(item => allowed(item) && images.available(item) && (args.random === true || selectionInfo(item).evidence !== 'unknown')),
            { keyword, emotion, character: typeof args.character === 'string' ? args.character : '', defaultCharacter: isLocal ? 'auto' : c.character || 'auto', random: true });
            return contextual ? shelf(state, ranked, 40, true) : ranked;
          };
          let eligible = rank(await localLoad(), true), stale = false;
          if (!eligible.length && networkEnabled()) eligible = rank(networkShelf());
          if (!eligible.length && networkEnabled()) {
            const loaded = await source.load(integer(c.cacheMinutes, 1440, 1, 1440), signal);
            stale = loaded.stale; eligible = rank(loaded.items);
          }
          if (!current(ctx, state)) return result({ reason: '会话或技能状态已变化。' }, true);
          const limit = integer(c.poolSize, 4, 1, 40);
          let chosen;
          if (args.random === true) chosen = eligible.map(item => ({ item, tie: Math.random() })).sort((a, b) => a.tie - b.tie).slice(0, limit).map(x => x.item);
          else if (keyword || emotion) chosen = eligible.slice().sort((a, b) => b.score - a.score || Number(history.seen(ctx.chatKey, fingerprint(a.original))) - Number(history.seen(ctx.chatKey, fingerprint(b.original))) || Number(images.cached(b)) - Number(images.cached(a)) || fingerprint(state.at + a.original).localeCompare(fingerprint(state.at + b.original))).slice(0, limit);
          else chosen = shelf(state, eligible, limit);
          // 每轮仅预取一次一张；与正式选择共用最多四张冷素材的预算。
          if (!state.prefetched) {
            state.prefetched = true;
            const item = chosen.find(item => item.origin !== 'local' && !images.cached(item));
            if (item && state.downloads.size < 4) {
              state.downloads.add(candidateId(item));
              void images.prepare(item, signal, { prefetch: true }).then(image => image.release()).catch(() => {});
            }
          }
          return result({ candidates: offer(state, chosen), cachedIndex: stale, next: chosen.length ? '调用 reply-meme__find_meme({"ids":["所选id"]}) 获取 ticket；候选 id 不能传给 send_meme。无贴切素材就结束。' : '无匹配素材，结束检索，继续文字回复。' });
        }
        const ids = [...new Set(args.ids)];
        if (ids.some(id => !state.offered.has(id))) return result({ reason: '候选不在本次会话提供的列表中，请重新检索，不接受自行编造的编号或 URL。' }, true);
        const prepared = [], failures = [];
        for (const id of ids) {
          if (!allowed(state.offered.get(id))) { failures.push({ id, reason: '图源已关闭或本地目录已变更，请重新检索。' }); continue; }
          if ([...state.tickets.values()].some(t => t.id === id && t.used)) { failures.push({ id, reason: '本轮已尝试发送过这张图，不重复准备。' }); continue; }
          const existing = [...state.tickets.values()].find(t => t.id === id && !t.used && fs.existsSync(t.file));
          if (existing) { prepared.push({ id, ticket: existing.ticket, ...(selectionInfo(existing.item).requestOnly ? { requestOnly: true } : {}) }); continue; }
          if (state.prepareAttempts >= 3) { failures.push({ id, reason: '本轮最多尝试准备 3 张素材（含失败），请停止连续换图重试。' }); continue; }
          const candidate = state.offered.get(id);
          let image;
          if (signal.aborted || !current(ctx, state)) break;
          if (!images.cached(candidate) && !state.downloads.has(id)) {
            if (state.downloads.size >= 4) { failures.push({ id, reason: '本轮下载预算已用完，请继续文字。' }); continue; }
            state.downloads.add(id);
          }
          state.prepareAttempts++;
          try { image = await images.prepare(candidate, signal); }
          catch (error) {
            log(`候选 ${id} 下载失败：${error.message}`);
            failures.push({ id, reason: error.message });
            continue;
          }
          if (!current(ctx, state) || signal.aborted || !allowed(candidate)) { image.release(); return result({ reason: '图片准备期间状态已变化，没有发送。' }, true); }
          const { release, ...data } = image;
          const item = { ...candidate, ...data, urlHash: fingerprint(candidate.original) };
          const ticket = randomUUID();
          const file = image.file;
          const { buf, ...metadata } = item;
          state.tickets.set(ticket, { id, ticket, file, item: metadata, round: state.round, used: false, release });
          prepared.push({ id, ticket, evidence: selectionInfo(item).evidence,
            ...(image.usedPreview ? { preview: true } : {}),
            ...(selectionInfo(item).requestOnly ? { requestOnly: true } : {}),
            ...(Math.min(item.w, item.h) < integer(c.minShortSide, 160, 0, 2000) ? { small: true, width: item.w, height: item.h } : {}) });
        }
        return result({ prepared, failures, sent: 0, next: prepared.length
          ? '图片仅准备好，尚未发送；finish 不会代发。仍要配图且条件满足时，下一步调用 reply-meme__send_meme，将 prepared.ticket 填入 tickets。主动配图用 reply，明确点图用 request；文字已发则勿重发。确认 sent>0 后再结束；素材不合适、用户取消或条件不满足时可放弃。'
          : '没有可发送的 ticket，不要调用 send_meme。主动配图失败就继续文字，不要连续换图拖延回复；用户明确点图可从候选中优先选 cached=true 的素材，本轮最多尝试 3 张。' }, prepared.length === 0);
      } catch (error) { return result({ reason: `表情准备未完成：${error.message}`, sent: 0 }, true); }
      finally { state.busy = false; }
    }
  });

  api.registerTool({
    id: 'send_meme', name: '发送已选梗鲸表情', category: 'sticker', icon: '🐳',
    description: '仅发送 find_meme(ids) 的 prepared.ticket，不能发送 candidates.id。reply=文字后的主动配图；request=明确点图。成功后结束。',
    parameters: { type: 'object', additionalProperties: false, properties: {
      tickets: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3, description: 'find_meme 返回的图片 ticket，不能填候选 id 或 URL。reply 只能 1 个。' },
      mode: { type: 'string', enum: ['reply', 'request'], description: 'reply=根据聊天语境主动配图；request=用户明确要图。' }
    }, required: ['tickets', 'mode'] },
    async execute(ctx, args = {}) {
      if (!args || typeof args !== 'object' || Array.isArray(args)) return result({ reason: '工具参数必须是对象。' }, true);
      const state = stateOf(ctx);
      const fail = reason => result({ sent: 0, reason }, true);
      if (!state || !usable() || stopped(ctx.session) || typeof ctx.sender?.sendImage !== 'function') return fail('当前会话或发送工具不可用。');
      if (!['reply', 'request'].includes(args.mode) || !strings(args.tickets)) return fail('需要有效的 mode 和 tickets。');
      const proactive = args.mode === 'reply', tickets = [...new Set(args.tickets)];
      const max = integer(settings().maxCount, 3, 1, 3);
      if (tickets.length > (proactive ? 1 : max) || state.sent + tickets.length > max) return fail('超过本轮图片数量上限。');
      if (state.busy || state.uncertain) return fail('本轮正在处理图片或上次发送未确认，不自动重发。');
      if (proactive && (!policy().proactive || cooling(ctx.chatKey) || hasMedia(ctx.session) || !hasText(ctx.session))) return fail('主动配图未开启、仍在冷却，或本轮尚未成功发文字/已经发过媒体。');
      const candidateIds = tickets.filter(ticket => state.offered.has(ticket));
      if (candidateIds.length) return fail('误把候选 id 当作 ticket。先调用 reply-meme__find_meme(' + JSON.stringify({ ids: candidateIds }) + ')，再将 prepared.ticket 传给 send_meme.tickets；保持原 mode，已发文字勿重发。');
      const entries = tickets.map(ticket => state.tickets.get(ticket));
      if (entries.some(item => !item || item.used || state.round <= item.round || !fs.existsSync(item.file))) return fail('发送凭据不可用：请先准备图片，读取工具结果后再决定发送。');
      if (entries.some(entry => !allowed(entry.item))) return fail('图源已关闭或本地目录已变更，凭据不可发送。');
      if (proactive && entries.some(entry => selectionInfo(entry.item).requestOnly)) return fail('所选素材仅供明确点图：展示图片或含义未知的图片不能主动配图。请继续文字，不要改用 request 绕过。');
      if (new Set(entries.map(entry => entry.item.hash)).size !== entries.length) return fail('所选图片内容重复，请只发送一张。');
      state.busy = true;
      const sent = [];
      try {
        for (const entry of entries) {
          if (!current(ctx, state) || !allowed(entry.item) || (proactive && (!policy().proactive || cooling(ctx.chatKey) || hasMedia(ctx.session)))) break;
          entry.used = true; // Ambiguous acknowledgements must never cause an automatic retry.
          entry.sending = true;
          try {
            const reply = await ctx.sender.sendImage(ctx.chatKey, { file: entry.file }, { note: proactive ? '回复表情' : '梗鲸表情包' });
            if (reply === false || reply?.ok === false || reply?.success === false || reply?.isError === true) throw new Error('平台未确认发送');
          } catch (error) {
            state.uncertain = true;
            history.mark(ctx.chatKey, entry.item, proactive);
            return result({ sent: sent.length, sendUnconfirmed: true, reason: '平台未确认最后一张图片是否送达，不要自动重发。' }, true);
          } finally { entry.sending = false; entry.release?.(); }
          state.sent++;
          history.mark(ctx.chatKey, entry.item, proactive);
          sent.push({ title: entry.item.title, source: entry.item.page, width: entry.item.w, height: entry.item.h });
          ctx.session?.sent?.push({ type: 'image', text: '[图片:梗鲸表情包]', at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
          try { ctx.emit?.('session-update', ctx.session?.id); } catch { /* optional UI update */ }
        }
        return result({ sent: sent.length, images: sent, message: sent.length ? '图片已发送，不重复发图，不汇报发送结果。可以正常结束，无须特定收尾工具。' : '状态已变化，没有发送。' }, sent.length === 0);
      } catch (error) { return fail(`发送未完成：${error.message}`); }
      finally { state.busy = false; }
    }
  });
}
