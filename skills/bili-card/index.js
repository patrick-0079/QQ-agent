// B站视频卡片（bili-card）
//
// ── 为什么需要它 ──────────────────────────────────────────────────────────
// QQ 手机端「分享到群」发的是**卡片消息**（json/xml 段），不是链接文本。
// 核心的 segmentsToText 对 json 段只输出 `[卡片消息]`（onebot.js:479），
// 卡片里的标题、简介、b23 短链在入库那一刻就被丢掉了 —— 模型只能看到四个字，
// 自然不知道群友分享的是什么视频。
//
// ── 为什么不做成普通 hook ─────────────────────────────────────────────────
// 5 个 hook 都在「已经排定一次模型会话」之后才触发，而且拿到的是**入库后的
// entry**（text 已经是 `[卡片消息]`），原始段已经没了。要还原卡片，必须抢在
// app.js 的 ingestMessage 之前。
//
// 最干净的切入点：OneBotClient 的 `onEvent` 是实例属性，WS 收到事件后直接调它。
// 本技能在 `connect()` 时包一层 onEvent：**同步**把 json/xml 段替换成文本段，
// 之后整条链路（入库、提示词、转发展开、引用）看到的都是可读文本。
// 纯本地解析，0 网络、0 token、0 延迟，不依赖任何 hook 超时。
//
// ⚠️ 本文件在 resources/app 里，应用自动更新会覆盖；装回来即可（配置不受影响）。

import { OneBotClient } from '../../src/onebot.js';
import { Orchestrator } from '../../src/orchestrator.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const MAX_TITLE = 80;
const MAX_DESC = 60;

const BILI_URL = /^https?:\/\/(?:[a-z0-9-]+\.)*(?:b23\.tv|bilibili\.com)\//i;
const IMAGE_URL = /\.(?:png|jpe?g|webp|gif|avif)(?:\?|$)/i;

let cfg = () => ({});
let api = null;

// 热重载会重新 import 本模块（新的函数闭包），但原型补丁只能打一次 ——
// 用全局 Symbol 存"当前该用哪套实现"，补丁永远调用最新的，避免重载叠加包装。
const PATCH_KEY = Symbol.for('qq-agent.bili-card.patch');
function live() {
  if (!globalThis[PATCH_KEY]) globalThis[PATCH_KEY] = {};
  return globalThis[PATCH_KEY];
}

// ── 卡片解析 ──────────────────────────────────────────────────────────────

/** 深度收集对象里的 [key, stringValue] 对（卡片结构各版本不同，不硬编码路径） */
function collectPairs(obj, out = []) {
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') out.push([k, v]);
    else if (v && typeof v === 'object') collectPairs(v, out);
  }
  return out;
}

function firstByKey(pairs, re) {
  for (const [k, v] of pairs) {
    if (!re.test(k)) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return '';
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** json 卡片（com.tencent.miniapp_01 / com.tencent.structmsg …）→ 一行文本 */
function cardTextFromJson(raw) {
  let d = raw;
  if (typeof raw === 'string') {
    try { d = JSON.parse(raw); } catch { return null; }
  }
  if (!d || typeof d !== 'object') return null;

  const meta = d.meta && typeof d.meta === 'object' && Object.keys(d.meta).length ? d.meta : d;
  const pairs = collectPairs(meta);

  const prompt = String(d.prompt || '').replace(/^\[分享\]\s*/, '').trim();
  const title = firstByKey(pairs, /^(title|brief|summary)$/i) || prompt;
  const desc = firstByKey(pairs, /^(desc|summary|content|brief)$/i);

  const urls = pairs
    .map(([, v]) => String(v).trim())
    .filter((v) => /^https?:\/\//i.test(v) && !IMAGE_URL.test(v));
  const url = urls.find((u) => BILI_URL.test(u)) || urls[0] || '';

  const text = buildCardText(title, desc, url);
  if (!text) return null;
  // 非 B 站卡片：默认也还原（群友分享的其它内容同样值得看见）
  if (!BILI_URL.test(url) && cfg().keepGeneric === false) return null;
  return text;
}

/** xml 卡片（老版本 QQ / 部分客户端）→ 一行文本 */
function cardTextFromXml(raw) {
  const s = String(raw || '');
  if (!s.trim()) return null;
  const pick = (tag) => {
    const m = new RegExp(`<${tag}\\b[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`, 'i').exec(s);
    return m ? decodeEntities(m[1]).trim() : '';
  };
  const title = pick('title');
  const desc = pick('summary') || pick('brief');
  const url = pick('url') || pick('qqdocurl');
  const text = buildCardText(title, desc, url);
  if (!text) return null;
  if (!BILI_URL.test(url) && cfg().keepGeneric === false) return null;
  return text;
}

function buildCardText(title, desc, url) {
  const t = clip(title, MAX_TITLE);
  const d = clip(desc, MAX_DESC);
  if (!t && !url) return null;
  const head = [t, d && d !== t ? d : ''].filter(Boolean).join(' ｜ ');
  return `[卡片] ${head}${url ? ` ｜ ${url}` : ''}`.trim();
}

/**
 * 把事件里的 json/xml 段就地替换成文本段。
 * 返回是否改动过（便于测试）；任何异常都由调用方兜住，绝不打断原事件流程。
 */
export function rewriteEvent(event) {
  if (cfg().enabled === false) return false;
  if (!event || event.post_type !== 'message') return false;
  if (!Array.isArray(event.message)) return false;

  let changed = false;
  for (let i = 0; i < event.message.length; i++) {
    const seg = event.message[i];
    if (!seg || typeof seg !== 'object') continue;
    if (seg.type !== 'json' && seg.type !== 'xml') continue;

    const raw = seg.data?.data ?? seg.data?.xml ?? seg.data?.content ?? '';
    const text = seg.type === 'json' ? cardTextFromJson(raw) : cardTextFromXml(raw);
    if (!text) continue;

    // 保留原始内容到扩展字段，排障时（会话页 JSON 模式）还能看到原卡片
    seg.__cardRaw = raw;
    event.message[i] = { type: 'text', data: { text } };
    changed = true;
  }
  return changed;
}

// ── 接入点：包一层 onEvent（同步，抢在入库之前）────────────────────────────
function install(client) {
  if (!client || client.__biliCardHooked) return;
  if (typeof client.onEvent !== 'function') return;
  client.__biliCardHooked = true;

  const prev = client.onEvent;
  client.onEvent = (event) => {
    try { live().rewrite?.(event); } catch { /* 卡片坏了不影响正常消息 */ }
    return prev(event);
  };
}

function patchConnect() {
  const s = live();
  s.install = install;
  if (s.connectPatched) return;
  s.connectPatched = true;
  const origConnect = OneBotClient.prototype.connect;
  OneBotClient.prototype.connect = function patchedConnect(...args) {
    try { live().install?.(this); } catch { /* ignore */ }
    return origConnect.apply(this, args);
  };
}

// 热重载兜底：技能是在 OneBot 已经连上之后才加载的，那时 onEvent 包装不会生效
// （包装只发生在 connect()）。这里再包一层 onIncoming：
//   · 先给 this.onebot 补装包装（之后的消息走同步快路径）；
//   · 当前这条如果已经是 [卡片消息] 占位，就用 get_msg 反查原始段补一次
//     —— 本地调用，几十毫秒，通常赶在 2 秒的唤醒倒计时之前落库。
function patchOrchestrator() {
  const s = live();
  s.recover = (orch, chatKey, entry) => { recoverCard(orch, chatKey, entry); };
  if (s.orchPatched) return;
  s.orchPatched = true;
  const origOnIncoming = Orchestrator.prototype.onIncoming;
  Orchestrator.prototype.onIncoming = function patchedOnIncoming(chatKey, entry) {
    try { live().install?.(this.onebot); } catch { /* ignore */ }
    try { live().recover?.(this, chatKey, entry); } catch { /* ignore */ }
    return origOnIncoming.apply(this, arguments);
  };
}

/** 占位消息 → get_msg 取原始段 → 还原卡片文本（尽力而为，失败保持占位） */
async function recoverCard(orch, chatKey, entry) {
  if (!entry || entry.mid == null) return;
  if (!/\[卡片消息\]/.test(String(entry.text || ''))) return;

  const raw = await orch.onebot.call('get_msg', { message_id: Number(entry.mid) });
  const segs = Array.isArray(raw?.message) ? raw.message.map((s) => ({ ...s })) : null;
  if (!segs) return;

  const ev = { post_type: 'message', message: segs };
  if (!rewriteEvent(ev)) return;

  const cardText = ev.message
    .filter((s) => s?.type === 'text')
    .map((s) => String(s.data?.text || ''))
    .find((t) => t.startsWith('[卡片]'));
  if (!cardText) return;

  const next = String(entry.text).replace('[卡片消息]', cardText);
  if (next !== entry.text) {
    orch.store.updateByMid(chatKey, entry.mid, { text: next });
    entry.text = next;   // 同一对象可能还在本次触发批里
  }
}

// ── B站详情查询（工具）────────────────────────────────────────────────────
function mmss(sec) {
  const s = Math.max(0, Number(sec) || 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function compact(n) {
  const v = Number(n) || 0;
  if (v < 10000) return String(v);
  return `${(v / 10000).toFixed(v >= 100000 ? 0 : 1).replace(/\.0$/, '')}万`;
}

async function resolveBvid(url) {
  const s = String(url || '').trim();
  const direct = /BV[0-9A-Za-z]{10}/.exec(s);
  if (direct) return direct[0];
  if (!/b23\.tv\//i.test(s)) return null;

  const r = await api.fetch(s, {
    redirect: 'manual',
    headers: { 'User-Agent': UA }
  });
  const loc = r.headers.get('location') || r.headers.get('Location') || '';
  const m = /BV[0-9A-Za-z]{10}/.exec(loc);
  if (m) return m[0];
  // 少数情况返回 200 + HTML 跳转页
  const body = await r.text().catch(() => '');
  const m2 = /BV[0-9A-Za-z]{10}/.exec(body);
  return m2 ? m2[0] : null;
}

async function fetchVideoInfo(bvid) {
  const r = await api.fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, {
    headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' }
  });
  const j = await r.json();
  if (!j || j.code !== 0 || !j.data) {
    throw new Error(`B站接口返回 ${j?.code ?? '?'}：${j?.message || '未知错误'}`);
  }
  const d = j.data;
  return {
    title: String(d.title || ''),
    author: String(d.owner?.name || ''),
    duration: Number(d.duration) || 0,
    view: Number(d.stat?.view) || 0,
    like: Number(d.stat?.like) || 0,
    favorite: Number(d.stat?.favorite) || 0,
    pubdate: Number(d.pubdate) || 0,
    desc: String(d.desc || ''),
    pic: String(d.pic || ''),
    bvid
  };
}

export function setup(skillApi) {
  api = skillApi;
  cfg = skillApi.config;

  // 补丁里永远调用"最新一版"的解析函数：重载后旧闭包自动退休
  live().rewrite = (event) => (cfg().enabled === false ? false : rewriteEvent(event));

  patchConnect();
  patchOrchestrator();
  api.log('已挂载卡片还原（json/xml → 文本），B站链接可查详情');

  api.registerTool({
    id: 'bili_video',
    name: 'B站视频详情',
    description:
      '按 b23.tv 短链或含 BV 号的链接查询哔哩哔哩视频的标题、UP 主、时长、播放/点赞/收藏和简介。' +
      '群里出现 [卡片] 且带 b23.tv / bilibili.com 链接、需要知道视频讲什么时调用。',
    category: 'media',
    icon: '📺',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '卡片里的链接，例如 https://b23.tv/xxxxxxx 或 https://www.bilibili.com/video/BVxxxxxxxxxx' }
      },
      required: ['url']
    },
    async execute(ctx, args) {
      const raw = String(args?.url ?? '').trim();
      if (!raw) return { content: '缺少 url：请把卡片里的链接填进来。', isError: true };
      if (typeof api?.fetch !== 'function') {
        return { content: '未授予 web_fetch 权限，查不了 B 站详情。', isError: true };
      }
      try {
        const bvid = await resolveBvid(raw);
        if (!bvid) return { content: `没从「${raw}」里认出 BV 号（短链可能已过期）。`, isError: true };
        const v = await fetchVideoInfo(bvid);
        const lines = [
          `🎬 ${v.title}`,
          `👤 ${v.author || '未知UP'} ｜ ⏱ ${mmss(v.duration)}`,
          `▶ ${compact(v.view)} 播放 ｜ ❤ ${compact(v.like)} ｜ ⭐ ${compact(v.favorite)}`,
          v.desc ? `📝 ${clip(v.desc, 160)}` : ''
        ].filter(Boolean);
        return { content: lines.join('\n') + `\n（${bvid}）` };
      } catch (e) {
        return { content: `查 B 站视频失败：${String(e?.message || e)}`, isError: true };
      }
    }
  });
}

export function available() {
  return { ok: true };
}

/** 卸载/热重载前把补丁指向空实现：关掉技能 = 立刻恢复 [卡片消息] 占位。 */
export function dispose() {
  const s = live();
  s.rewrite = () => false;
  s.recover = () => {};
}
