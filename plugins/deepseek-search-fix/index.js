/**
 * deepseek-search-fix —— 修补内置 DeepSeek 联网搜索（QQ Agent 插件）
 * ============================================================
 *
 * 【它修的是什么】
 *   QQ Agent 内置的 DeepSeek 搜索走 OpenAI 风格的 `/responses` 端点 +
 *   `tools:[{type:'web_search'}]`。该端点会**接受**这个工具声明，但**从不执行**搜索，
 *   最后退化成把模型自己说的一段话当"搜索结果"返回：
 *
 *       { query, results: [{ title: 'DeepSeek 搜索', url: '', snippet: '模型写的那段话' }] }
 *
 *   实测 746 次调用里 466 次（62.5%）是这个形状 —— 零链接。
 *
 *   DeepSeek 真正的原生搜索在 **Anthropic 兼容端点**上：
 *       POST /anthropic/v1/messages
 *       tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: N }]
 *   响应 content[] 里有 `web_search_tool_result` 块，里面才是带 url 的真结果。
 *
 * 【为什么做成 plugin 而不是 skill】
 *   这个需求是"修补已有功能"，不该让模型去判断要不要用新工具。
 *   plugin 是确定性型：满足条件必然执行，模型完全无感知。
 *
 * 【实现原理：after-tool 改写结果】
 *   orchestrator 的执行顺序是：
 *       ① result = await executeTool(...)          ← 内置搜索跑完
 *       ② await runHook('after-tool', { result })  ← 本插件在这里
 *       ③ 读取 result.content 交给模型              ← 所以②里改是有效的
 *   于是：检测到假结果 → 自己发一次原生搜索 → 就地替换 result.content。
 *   模型看到的是真结果，它不知道中间发生了什么，function 列表也没有任何变化。
 *
 * 【成本】
 *   只有"检测到坏结果"时才追加一次调用。真结果 / 其它 provider → 完全不动，零开销。
 *
 * 【安全边界】
 *   · 只处理 toolName === 'web_search'
 *   · autoScope 默认开：只在 webSearch.provider === 'deepseek' 时介入
 *   · 结果里只要有一条带 http 链接，就认定"这是真结果"，直接放过
 *   · 不注册任何工具、不注入任何提示词、不改任何全局状态
 */

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-v4-flash';
const ANTHROPIC_VERSION = '2023-06-01';
const WEB_SEARCH_TOOL_TYPE = 'web_search_20250305';
// 内置失败实现的标志性标题：出现它 + 无 url 基本可以断定是"模型散文冒充搜索结果"
const BROKEN_TITLE = 'DeepSeek 搜索';

let apiRef = null;

// ── 读核心配置（同进程；本文件在 <app>/plugins/<id>/ 下，所以 ../../src 就是核心源码）──
let coreGetConfig = null;
try {
  const mod = await import('../../src/config.js');
  if (typeof mod.getConfig === 'function') coreGetConfig = mod.getConfig;
} catch { /* 非标准安装位置 → 降级到技能设置 / 环境变量 */ }

function coreConfig() {
  try { return coreGetConfig ? coreGetConfig() : null; } catch { return null; }
}

/** 本插件自己的设置（每次调用都读，改配置无需重载）。 */
function settings() {
  try {
    const s = apiRef && typeof apiRef.config === 'function' ? apiRef.config() : null;
    return s && typeof s === 'object' ? s : {};
  } catch { return {}; }
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 把各种写法的 baseUrl 换算成 Anthropic 兼容的 messages 端点。
 * 支持：https://api.deepseek.com、.../v1、.../anthropic/v1、.../responses（内置默认）。
 */
export function resolveAnthropicEndpoint(baseUrl) {
  const raw = String(baseUrl || '').trim() || DEFAULT_BASE_URL;
  let u;
  try { u = new URL(raw); } catch { u = new URL(DEFAULT_BASE_URL); }
  const origin = u.origin;
  const p = u.pathname.replace(/\/+$/, '');
  if (/\/anthropic\/v1\/messages$/.test(p)) return origin + p;
  if (/\/anthropic\/v1$/.test(p)) return origin + p + '/messages';
  if (/\/anthropic$/.test(p)) return origin + p + '/v1/messages';
  if (/\/responses$/.test(p)) return origin + '/anthropic/v1/messages';
  if (!p || p === '/') return origin + '/anthropic/v1/messages';
  if (/\/v1$/.test(p)) return origin + p + '/messages';
  return origin + p + '/messages';
}

/** 组装调用参数：本插件设置 > 应用里的 DeepSeek 配置 > 环境变量 > 默认值。 */
export async function resolveTarget() {
  const s = settings();
  const app = coreConfig();
  const ds = (app && app.webSearch && app.webSearch.deepseek) || {};
  const api = (app && app.api) || {};
  const apiProvider = String(api.provider || '').toLowerCase();
  const apiBase = String(api.baseUrl || '').toLowerCase();
  const apiLooksDeepSeek = apiProvider.includes('deepseek') || apiBase.includes('deepseek');

  const key = String(
    s.apiKey
    || ds.apiKey
    || (apiLooksDeepSeek ? api.apiKey : '')
    || process.env.DEEPSEEK_API_KEY
    || ''
  ).trim();

  const baseUrl = String(
    s.baseUrl
    || ds.baseUrl
    || (apiLooksDeepSeek ? api.baseUrl : '')
    || DEFAULT_BASE_URL
  ).trim();

  const model = String(s.model || ds.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;

  return {
    key,
    endpoint: resolveAnthropicEndpoint(baseUrl),
    model,
    maxUses: clampInt(s.maxUses, 1, 10, 5),
    maxResults: clampInt(s.maxResults, 1, 20, 10),
    timeoutMs: clampInt(s.timeoutMs, 10_000, 300_000, 120_000)
  };
}

/**
 * 判断内置搜索这次返回的是不是"坏结果"。
 * @returns {'fake'|'error'|null}  null = 正常，不要动
 */
export function classifyResult(content, isError) {
  if (isError) return 'error';

  let data;
  try { data = JSON.parse(String(content ?? '')); } catch { return null; }
  if (!data || typeof data !== 'object' || !Array.isArray(data.results)) return null;
  if (!data.results.length) return null;   // 真·没搜到，属于正常结果

  // 只要有一条带 http 链接，就认为内置实现是好的（例如已打过核心补丁、或用的是 bing）
  const withUrl = data.results.filter((r) => r && /^https?:\/\//i.test(String(r.url || '')));
  if (withUrl.length > 0) return null;

  // 全都没 url：再看是不是内置失败实现的形状
  const looksFake = data.results.every((r) => r
    && (!String(r.url || '').trim() || String(r.title || '') === BROKEN_TITLE));
  return looksFake ? 'fake' : null;
}

/** 真正的原生搜索。拿不到结构化结果块就抛错（严格模式，绝不拿模型散文充数）。 */
export async function nativeSearch(query, fetchImpl, target) {
  const q = String(query || '').trim();
  if (!q) throw new Error('缺少搜索关键词');
  const t = target || await resolveTarget();
  if (!t.key) {
    throw new Error('缺少 DeepSeek API Key（可在「插件 → DeepSeek 搜索修补」里填写，或用应用里已配置的 DeepSeek Key）');
  }

  const doFetch = fetchImpl
    || (apiRef && typeof apiRef.fetch === 'function' ? apiRef.fetch : null);
  if (typeof doFetch !== 'function') {
    throw new Error('拿不到 fetch（请确认 plugin.json 里声明了 web_fetch 权限）');
  }

  const body = {
    model: t.model,
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: `Perform a web search for the query: ${q}` }]
    }],
    tools: [{ type: WEB_SEARCH_TOOL_TYPE, name: 'web_search', max_uses: t.maxUses }]
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), t.timeoutMs);
  let res;
  try {
    res = await doFetch(t.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': t.key,
        authorization: `Bearer ${t.key}`,
        'anthropic-version': ANTHROPIC_VERSION
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } catch (error) {
    const reason = error && error.name === 'AbortError'
      ? `请求超时（${Math.round(t.timeoutMs / 1000)} 秒）`
      : ((error && error.message) || String(error));
    throw new Error(`请求失败：${reason}；端点 ${t.endpoint}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}（端点 ${t.endpoint}）：${text.replace(/\s+/g, ' ').slice(0, 300)}`);
  }

  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error(`响应不是合法 JSON（${text.length} 字节，可能被超时截断）。端点 ${t.endpoint}`);
  }

  const blocks = Array.isArray(data && data.content) ? data.content : [];
  const resultBlocks = blocks.filter((b) => b && b.type === 'web_search_tool_result');
  if (!resultBlocks.length) {
    throw new Error(`原生搜索未触发（响应里没有 web_search_tool_result 块）。端点 ${t.endpoint}，模型 ${t.model}`);
  }

  const seen = new Set();
  const results = [];
  for (const block of resultBlocks) {
    const items = Array.isArray(block && block.content) ? block.content : [];
    for (const item of items) {
      if (!item || item.type !== 'web_search_result') continue;
      const url = String(item.url || '').trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      results.push({
        title: String(item.title || '').trim().slice(0, 200) || url,
        url,
        ...(item.page_age ? { publishedAt: String(item.page_age).slice(0, 40) } : {})
      });
      if (results.length >= t.maxResults) break;
    }
    if (results.length >= t.maxResults) break;
  }
  if (!results.length) {
    throw new Error(`返回了 ${resultBlocks.length} 个结果块，但没有可用条目（缺 url）`);
  }

  const summary = blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 1500);

  const searched = Number(
    data && data.usage && data.usage.server_tool_use
      ? data.usage.server_tool_use.web_search_requests
      : 0
  ) || resultBlocks.length;

  // 形状与「打过核心补丁」的内置实现一致：模型在两种机器上看到的格式完全相同
  return {
    query: q,
    provider: 'deepseek',
    searched,
    results,
    ...(summary ? { summary } : {})
  };
}

/** 从工具调用参数里取 query（argsRaw 是 JSON 字符串）。 */
function queryOf(argsRaw, content) {
  try {
    const a = typeof argsRaw === 'string' ? JSON.parse(argsRaw) : argsRaw;
    const q = String((a && a.query) || '').trim();
    if (q) return q;
  } catch { /* 落到下面从结果里找 */ }
  try {
    const d = JSON.parse(String(content ?? ''));
    return String((d && d.query) || '').trim();
  } catch { return ''; }
}

function log(level, message) {
  const fn = apiRef && typeof apiRef[level] === 'function' ? apiRef[level] : null;
  if (fn) { try { fn(message); } catch { /* 忽略 */ } }
}

export const hooks = {
  /**
   * 内置搜索跑完之后立刻检查：是坏结果就地替换。
   * 正常结果（有真实链接 / 其它 provider / 没搜到）一律放过，零开销。
   */
  'after-tool': async (ctx) => {
    try {
      if (!ctx || ctx.toolName !== 'web_search') return;
      const cfg = coreConfig();
      const s = settings();

      // 作用域收窄：默认只在 provider=deepseek（也就是有 bug 的那条通路）时介入
      if (s.autoScope !== false) {
        const provider = String((cfg && cfg.webSearch && cfg.webSearch.provider) || '').trim().toLowerCase();
        if (provider && provider !== 'deepseek') return;
      }

      const result = ctx.result;
      if (!result || typeof result !== 'object') return;

      const kind = classifyResult(result.content, result.isError === true);
      if (!kind) return;                                   // 正常结果：什么都不做
      if (kind === 'error' && s.repairErrors === false) return;

      const query = queryOf(ctx.argsRaw, result.content);
      if (!query) return;

      let fixed;
      try {
        fixed = await nativeSearch(query, apiRef && apiRef.fetch);
      } catch (error) {
        // 修补失败就保持原样 —— 不比安装本插件之前更差
        log('warn', `修补「${query}」失败，保留原结果：${(error && error.message) || error}`);
        return;
      }

      const next = JSON.stringify(fixed, null, 1);
      // 就地改写：orchestrator 在钩子之后才读取 result.content
      result.content = next;
      result.isError = false;
      log('log', `已修补内置搜索（${kind === 'fake' ? '假结果' : '报错'}）：${query} → ${fixed.results.length} 条真实链接`);
    } catch (error) {
      // 钩子里绝不抛错：抛了也只会被 runHook 吞掉，不如自己吞干净
      log('warn', `after-tool 处理异常：${(error && error.message) || error}`);
    }
  }
};

/** 只用来拿受控 api（config / fetch / log），不注册任何工具。 */
export function setup(api) {
  apiRef = api;
}

export function dispose() {
  apiRef = null;
}

export default { setup, hooks, dispose };
