// 语音转文字（QQ 原生）
//
// ── 它解决什么 ───────────────────────────────────────────────────────
// 0.4 把语音转文字做成了可插拔能力 `media.transcribe`（内核收到语音只写 `[语音]`，
// 谁来转文字由插件决定）。商店里的那版是**本地 whisper.cpp**：要装可执行文件、
// 下载 ggml 模型、每次转写占 CPU。本插件换一条路：**直接用 QQ 自带的转写能力** ——
// 协议端（SnowLuma）已经把它暴露成一个 OneBot action：
//
//     fetch_ptt_text / get_ptt_text / get_record_text
//     参数 { message_id } → 返回 { text }
//
// 内部走的是 QQ 客户端的 `pttTrans.Trans{C2C,Group}PttReq`，所以**不装任何东西**、
// 不下载模型、不占显存，而且中文识别质量就是 QQ 自己的水平（微信/QQ 用户天天在用）。
//
// ── 为什么不需要改内核 ────────────────────────────────────────────────
// 内核的 `media.transcribe` 能力只传 `{ record, onebot }`，**没有 message_id** ——
// 而 QQ 的转写接口恰恰要 message_id。所以本插件不走那个能力，改走钩子：
//
//   before-context 钩子能拿到 triggerEntries（本轮新消息，每条带 mid）、store
//   → 认出文本是 `[语音]` 的消息
//   → 用 mid 调协议端的 fetch_ptt_text
//   → `store.updateByMid(chatKey, mid, { text: '[语音转文字] …' })` 写回（自带落盘）
//
// 好处：**装在别人的标准 0.4 上就能跑**，不需要任何补丁。
//
// ── 两个必须小心的约束 ────────────────────────────────────────────────
// 1. **钩子有 5 秒硬上限**（manager 的 #withTimeout）。所以只用「预算内等待」：
//    等到了就直接给本轮用；等不到就让它继续在后台跑，完成时再写回 —— 下一轮生效。
//    绝不为了等结果把回复卡住。
// 2. QQ 转写是**异步推送**的，协议端最多等 20 秒。所以请求超时要给宽（默认 20 秒），
//    不能沿用内核 OneBot 调用那个 15 秒默认值。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DONE = '[语音转文字]';
const PLACEHOLDER = '[语音]';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..', '..');
const DATA_DIR = process.env.QQ_AGENT_DATA_DIR || path.join(APP_ROOT, 'data');

let api = null;
const inflight = new Set();     // 正在转的 mid，避免同一轮里重复发请求
const stats = { ok: 0, fail: 0, lastError: '' };

function cfg() {
  try { return (api?.config && api.config()) || {}; } catch { return {}; }
}

/**
 * 读协议端的 HTTP 地址与令牌。
 *
 * ⚠️ 插件拿不到全局 config（`api.config()` 只给本插件自己的设置），只能读
 *    `data/config.json`。地址与令牌就在 `snowluma` 块里 —— 与应用内部
 *    `onebot.call()` 用的是同一份，所以不会出现"插件连不上但应用连得上"。
 */
function readEndpoint() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8').replace(/^﻿/, ''));
    const s = raw.snowluma || {};
    return {
      url: String(s.httpUrl || 'http://127.0.0.1:3000').trim().replace(/\/+$/, ''),
      token: String(s.httpAccessToken || s.accessToken || '').trim()
    };
  } catch {
    return null;
  }
}

/** 调协议端的转写接口。返回文本；拿不到就返回空串（不抛）。 */
async function requestText(ep, mid, timeoutMs) {
  const headers = { 'content-type': 'application/json' };
  if (ep.token) headers.authorization = `Bearer ${ep.token}`;
  const res = await api.fetch(`${ep.url}/fetch_ptt_text`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message_id: /^-?\d+$/.test(String(mid)) ? Number(mid) : mid }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json().catch(() => null);
  if (!body) throw new Error('返回不是 JSON');
  // OneBot 标准响应；协议端不认这个 action 时 retcode 会是 1404 之类
  if (body.status !== 'ok' && body.retcode !== 0) {
    throw new Error(`retcode=${body.retcode ?? body.status} ${body.wording ?? ''}`.trim());
  }
  // 有的实现把结果放在 data 里，有的直接平铺
  const data = body.data ?? body;
  return String(data?.text ?? '').trim();
}

/** 一批里挑出"还没转写的语音"。 */
function pickVoices(triggerEntries) {
  const out = [];
  for (const m of triggerEntries || []) {
    if (!m || m.self) continue;
    const text = String(m.text ?? '');
    // 只认占位符；已经是 [语音转文字] 的不动（避免和别的转写实现打架）
    if (!text.includes(PLACEHOLDER) || text.includes(DONE)) continue;
    if (m.mid == null || String(m.mid).trim() === '') continue;
    out.push({ mid: String(m.mid), senderName: String(m.senderName || '') });
  }
  return out;
}

/** 转一条并写回。 */
async function doOne(chatKey, store, ep, item, timeoutMs) {
  const text = await requestText(ep, item.mid, timeoutMs);
  if (!text) return null;
  // 写回时**保留原有的占位符内容**（有的消息除了 [语音] 还有别的文本）
  const cur = store.findByMid?.(chatKey, item.mid);
  const before = String(cur?.text ?? PLACEHOLDER);
  const next = before.includes(PLACEHOLDER)
    ? before.replace(PLACEHOLDER, `${DONE} ${text}`)
    : `${before} ${DONE} ${text}`;
  store.updateByMid(chatKey, item.mid, { text: next });
  if (cfg().debugLog) api?.log?.(`${item.senderName || item.mid}：${text}`);
  return text;
}

/**
 * before-context 钩子。
 *
 * ⚠️ 必须**在 5 秒内返回**（框架硬上限）。所以这里只等 budgetMs；没等到的
 *    继续在后台跑完并写回 —— 下一轮就能用上，而回复一次都不会被拖住。
 */
async function onBeforeContext(ctx) {
  try {
    const chatKey = String(ctx?.chatKey || '');
    const store = ctx?.store;
    if (!chatKey || !store || typeof store.updateByMid !== 'function') return;

    const items = pickVoices(ctx?.triggerEntries);
    if (!items.length) return;

    const ep = readEndpoint();
    if (!ep?.url) return;

    const c = cfg();
    // 框架给钩子 5 秒；留 1 秒余量
    const budget = Math.min(4500, Math.max(500, Number(c.budgetMs) || 4000));
    const timeoutMs = Math.max(3000, Number(c.timeoutMs) || 20000);

    const jobs = [];
    for (const it of items) {
      if (inflight.has(it.mid)) continue;
      inflight.add(it.mid);
      const p = doOne(chatKey, store, ep, it, timeoutMs)
        .then((t) => { if (t) { stats.ok += 1; return t; } return null; })
        .catch((e) => {
          stats.fail += 1;
          stats.lastError = String(e?.message ?? e);
          return null;
        })
        .finally(() => inflight.delete(it.mid));
      jobs.push(p);
    }
    if (!jobs.length) return;

    // 预算内等一等：等到了本轮提示词里就是文字；等不到就让它后台跑完。
    let timer = null;
    const gap = new Promise((resolve) => { timer = setTimeout(resolve, budget); });
    try {
      await Promise.race([Promise.all(jobs), gap]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (e) {
    // 绝不影响主流程
    try { api?.warn?.('语音转文字出错：' + (e?.message ?? e)); } catch { /* 忽略 */ }
  }
}

export const hooks = {
  'before-context': (ctx) => onBeforeContext(ctx)
};

export const providers = {
  /** 给"工具与技能 → 插件"页或排障看的运行统计。 */
  'speech-to-text.status': () => ({
    ok: true,
    url: readEndpoint()?.url || '',
    inflight: [...inflight],
    ...stats
  })
};

export function setup(a) {
  api = a;
  const ep = readEndpoint();
  a.log?.(ep?.url ? `已启用（协议端 ${ep.url}）` : '已启用，但读不到协议端地址（snowluma.httpUrl）');
}

export const __internals = { pickVoices, requestText, readEndpoint, doOne, stats };
