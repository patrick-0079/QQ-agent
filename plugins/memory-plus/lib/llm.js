// 印象档案 · 模型调用层
//
// 只服务一件事：**整理印象时让模型做判断**（哪条短期印象够稳、哪条能压成什么标签、
// 哪段聊天记录值得记下来）。判断类请求一律关思考、低温、带超时 —— 与
// context-chime / msg-reaction 这些现役插件的姿势保持一致（它们是本仓库里
// 插件直接调核心 llm.js 的既有先例）。
//
// ⚠️ 这里**不做任何闲聊回复**：模型只负责吐 JSON，写不写记忆由调用方决定。
import { chatCompletion, resolveApiKey } from '../../../src/llm.js';
import { getConfig } from '../../../src/config.js';

/**
 * 调一次模型，拿纯文本。失败一律返回 {ok:false}，绝不抛错给上层。
 *
 * ⚠️ 两个必须守住的点（都踩过）：
 *  1. **不要传 overrides**。真实配置里 `api.apiKey` 可能是占位文字（本机就是「（无）」三个
 *     全角字），一旦把它当 overrides 传下去，请求头会变成 `Bearer （无）`，undici 直接抛
 *     "Cannot convert argument to a ByteString…" —— 表现为"点整理没反应 / 改动为 0"。
 *     不传 overrides 时核心会走 effectiveApi()：按选中的提供商正确解析 Key，
 *     还会顺带享受账号池与专用模型那套逻辑。
 *  2. 只在本地校验 baseUrl/model 是否填了，不去碰 Key（Key 的解析交给核心）。
 */
/**
 * 解析"专用渠道 + 专用模型"（设置里可留空 = 跟随主模型）。
 *
 * 写法照抄核心自己的记忆整理（orchestrator 的 #memoryChat）：
 * 用 providers 里的 baseURL + Key 组一个 overrides 传给 chatCompletion。
 *
 * @returns {{api: object, error: string}|null} null = 没配专用渠道（用主模型）
 */
export function resolveDedicatedApi(settings = {}) {
  const provider = String(settings.modelProvider || '').trim();
  const model = String(settings.modelName || '').trim();
  if (!provider && !model) return null;
  if (!provider) return { api: null, error: '配了专用模型名但没选渠道：请把「专用渠道」也选上（或都留空 = 跟随主模型）' };
  if (!model) return { api: null, error: '选了专用渠道但没选模型：请把「专用模型」也选上（或都留空 = 跟随主模型）' };
  let cfg = {};
  try { cfg = getConfig() || {}; } catch { cfg = {}; }
  const p = (cfg.providers || []).find((x) => String(x?.id) === provider);
  if (!p) return { api: null, error: `找不到渠道 ${provider}（它可能被改名或删掉了，去插件设置里重选一个）` };
  const baseUrl = String(p.baseURL || p.baseUrl || '').trim();
  const key = String(cfg.dshProviderKeys?.[provider] || p.apiKey || '').trim();
  if (!baseUrl) return { api: null, error: `渠道 ${provider} 没有填 Base URL` };
  if (!key) return { api: null, error: `渠道 ${provider} 还没有 Key（去「设置 → 模型」里给它填上）` };
  // 非 ASCII 的 Key/地址会让请求头在本地就被 undici 拒掉（ByteString 报错），提前拦住并说人话
  if (/[^\x20-\x7E]/.test(key)) {
    return { api: null, error: `渠道 ${provider} 的 Key 里有非 ASCII 字符（多半是复制时带进了中文），请重新复制一次纯英文 Key` };
  }
  return { api: { baseUrl, apiKey: key, model, timeoutMs: 180000 } };
}

export async function askModel({ messages, temperature = 0.2, maxTokens = 0, timeoutMs = 60000, chatKey = '', settings = {}, retryOnRateLimit = true } = {}) {
  const cfg0 = getConfig();
  const api = { ...(cfg0.api || {}), apiKey: resolveApiKey(cfg0) };
  // 专用渠道优先；没配就用主模型（核心的 effectiveApi：会自己解析 Key、账号池、专用视觉模型）
  const dedicated = resolveDedicatedApi(settings);
  if (dedicated?.error) return { ok: false, error: dedicated.error, configError: true };
  const overrides = dedicated?.api || null;
  if (!overrides) {
    if (!String(api.baseUrl || '').trim() || !String(api.model || '').trim()) {
      return { ok: false, error: '还没配置模型（Base URL / 模型名），先到「设置 → 模型」里填好再整理记忆' };
    }
  }
  const modelName = overrides ? overrides.model : api.model;
  const once = async ({ maxTokens: mt = maxTokens } = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('整理超时')), Math.max(3000, Number(timeoutMs) || 60000));
    timer.unref?.();
    try {
      const result = await chatCompletion({
        messages,
        temperature: Math.max(0, Math.min(1, Number(temperature))),
        maxTokens: Math.max(0, Number(mt) || 0),
        signal: controller.signal,
        // 没有专用渠道时不传 overrides：交给核心走 effectiveApi + 账号池那一套
        overrides,
        // 判断类请求不需要思考：开着只会多烧 reasoning token，还可能把正文挤空
        skillContext: {
          api: overrides ? { ...api, ...overrides } : api,
          model: modelName, messages, thinkingMode: 'off', chatKey, memoryPlus: true
        }
      });
      const content = String(result?.message?.content ?? '');
      const usage = result?.usage || null;
      const reasoning = Number(usage?.completion_tokens_details?.reasoning_tokens) || 0;
      if (!content.trim() && (String(result?.finishReason) === 'length' || reasoning > 0)) {
        return {
          ok: false,
          error: `模型把预算烧在思考上了（reasoning ${reasoning} token，finish=${result?.finishReason || '?'}）——`
            + '把一个能关思考的模型配给整理用（或调大它的输出上限）',
          usage
        };
      }
      return { ok: true, text: content, usage };
    } catch (error) {
      return { ok: false, error: humanizeError(error) };
    } finally {
      clearTimeout(timer);
    }
  };
  const first = await once();
  // 限流（429 / rps exhausted）：等一会儿自动重试一次 —— 整理是逐个成员串行调的，
  // 不重试的话一次限流就会让"压缩标签"整批变成 0，用户看到的就是"点了没用"。
  if (!first.ok && retryOnRateLimit && /429|rate.?limit|rps|tpm|rpm/i.test(String(first.error || ''))) {
    await new Promise((r) => { const t = setTimeout(r, 2500); t.unref?.(); });
    const second = await once();
    if (second.ok) return second;
    return { ok: false, error: `${second.error}（已重试一次，仍被限流）`, rateLimited: true };
  }
  // ⚠️ 输出被"思考"吃光（finish=length / reasoning_tokens>0 且正文为空）：
  //    这是**整理永远出不来结果**的头号原因（用户实测：提取一整天都是 0 条）。
  //    很多渠道不认 thinkingMode:'off'，所以这里直接把预算放大再试一次，最稳。
  if (!first.ok && /烧在思考上|finish=length/i.test(String(first.error || ''))) {
    const bigger = Math.max(2500, Math.round(Math.max(1, Number(maxTokens) || 700) * 4));
    const second = await once({ maxTokens: bigger });
    if (second.ok) return second;
    // 放大后如果撞上限流，那瓶颈就是限流而不是输出上限，别报错报错因
    if (/429|rate.?limit|rps|tpm|rpm/i.test(String(second.error || ''))) {
      return { ok: false, error: `${second.error}（重试时撞上限流；整理用的渠道当前额度不足）`, rateLimited: true };
    }
    return {
      ok: false,
      error: `${second.error}（已把输出上限抬到 ${bigger} 仍不够，建议给整理单独配一个「能关思考」的小模型）`,
      truncated: true
    };
  }
  return first;
}

/** 把底层报错翻译成人能看懂的话（尤其是"请求头里有非 ASCII 字符"这一类）。 */
function humanizeError(error) {
  const message = String(error?.cause?.message ?? error?.message ?? error);
  if (/ByteString/i.test(message)) {
    return '请求头里有非 ASCII 字符，请求还没发出去就被本地拒了（原报错：' + message + '）。'
      + '通常是「设置 → 模型」里 Base URL / API Key 混进了中文（例如占位文字「（无）」）。'
      + '把 Key 清空、重新从服务商复制一次纯英文 Key 即可。';
  }
  if (/aborted|abort/i.test(message)) return '请求超时或被打断（' + message + '）';
  return message;
}

/** 从模型输出里抠出第一个合法 JSON 对象（容忍 ```json 围栏与前后废话）。 */
export function extractJson(text) {
  const raw = String(text || '');
  if (!raw.trim()) return null;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidates = [];
  if (fence) candidates.push(fence[1]);
  candidates.push(raw);
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(raw.slice(start, end + 1));
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c.trim());
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* 试下一个候选 */ }
  }
  return null;
}

/**
 * 把模型给的标签洗成干净的短词。
 * 容错（模型经常不按格式来，这里全都要接住，否则界面就"点了没反应"）：
 *   · 数组：["嘴硬","夜猫子"]
 *   · 字符串："嘴硬、夜猫子" / "嘴硬, 夜猫子" / "嘴硬 夜猫子" / "嘴硬/夜猫子"
 *   · 对象：{ "嘴硬": 3 }（取键）
 *   · 数组里混对象：{ "tag": "嘴硬" } / { "label": "夜猫子" }
 */
export function cleanTags(list, max = 8) {
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    const tag = String(raw ?? '')
      .replace(/^[\s\-*·•\d.、)]+/, '')
      .replace(/[\s\u3000]+/g, '')
      .replace(/[，。！？、；：""''（）()【】\[\]…—～~,.!?;:'"`]/g, '')
      .slice(0, 12);
    if (!tag || seen.has(tag) || out.length >= max) return;
    seen.add(tag);
    out.push(tag);
  };
  const walk = (v) => {
    if (v === null || v === undefined) return;
    if (typeof v === 'string') {
      const parts = v.split(/[，,、;；/|｜\s\u3000]+/).filter(Boolean);
      if (parts.length > 1) parts.forEach(push);
      else push(v);
      return;
    }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === 'object') {
      if (typeof v.tag === 'string' || typeof v.label === 'string' || typeof v.name === 'string') {
        push(v.tag || v.label || v.name);
        return;
      }
      Object.keys(v).forEach(push);
    }
  };
  walk(list);
  return out;
}

/** 从模型的 JSON 里取标签数组（不同模型会用不同的键名）。 */
export function pickTags(parsed) {
  if (!parsed || typeof parsed !== 'object') return [];
  return parsed.tags ?? parsed.labels ?? parsed.label ?? parsed.keywords ?? parsed.tagsList ?? [];
}
