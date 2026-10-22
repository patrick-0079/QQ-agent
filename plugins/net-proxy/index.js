// 网络代理（确定性型插件）—— 给整个进程的出站网络套一层 HTTP 代理。
//
// ── 为什么做成插件 ─────────────────────────────────────────────────────────
// 应用的联网请求走两条路：
//   ① globalThis.fetch（undici）—— llm.js / web-search.js / providers.js /
//      price-feed.js / community.js / telemetry.js / market.js，以及其它扩展
//      自己发的请求；
//   ② src/safe-fetch.js 里的 node:http(s) —— 只有核心的网页抓取用它。
// 本插件接管 ①；同时把自己暴露成 `network.proxy-config` 能力，让核心的 ②
// 也能按同一份设置走代理。插件关掉 → 两条路都退回直连（② 的分支在核心里
// 是"拿不到能力就原样走老路"）。
//
// ── 为什么装 Dispatcher，而不是包一层 globalThis.fetch ────────────────────
// 扩展拿到的 api.fetch 是**加载那一刻**捕获的 globalThis.fetch
// （见 plugin-loader.js 的 createSkillApi），而 plugins/ 比 skills/ 后加载 ——
// 如果这里只写 `globalThis.fetch = wrapper`，先加载的技能手里那份原函数
// 根本不会经过包装，表现为"插件开了，但某些技能的联网请求没走代理"。
// 换 dispatcher 没有这个问题：undici 的 fetch 在**每次请求时**才向
// getGlobalDispatcher() 取 dispatcher，早已被捕获的 fetch 也照样生效。
//
// ── 为什么是"路由型 dispatcher"，而不是直接 setGlobalDispatcher(ProxyAgent) ─
// 技能设置的保存路径（POST /api/skills/:id → setSkillConfig）**不会**回调
// activate/deactivate —— 用户改完端口点保存，插件收不到任何通知。所以这里装的
// 是一个**逐请求现读配置**的路由器：命中代理走代理，否则走直连，每次请求重新
// 判断。改设置 → 下一个请求立刻生效，不用重启、也不用重载插件。
//
// ── 本机地址硬直连 ────────────────────────────────────────────────────────
// OneBot（127.0.0.1:3000 / 3001）与控制台都在本机。把本机流量塞进代理会直接
// 打断与 QQ 协议端的通信，代理一挂机器人也跟着挂 —— 所以 localhost /
// 127.0.0.1 / ::1 是**硬绕行**，不受用户配置影响。

const CONNECT_TIMEOUT_MS = 30000;
// 硬绕行：这三条永远直连，用户配置只做追加（不能关闭）
const HARD_BYPASS = ['localhost', '127.0.0.1', '::1'];

let api = null;
let undici = null;            // { Dispatcher, Agent, ProxyAgent }
let loadError = '';           // 依赖加载失败的原因（undici 拿不到时）
let router = null;            // 当前装上的路由 dispatcher
let prevDispatcher = null;    // 装之前的全局 dispatcher，卸载时原样还原
let proxyAgent = null;        // 当前代理 Agent（配置变化时重建）
let proxyAgentKey = '';       // 上面那个 Agent 对应的配置指纹
let proxyAgentError = '';     // 上次构造代理 Agent 失败的原因

// ── 配置读取 ──────────────────────────────────────────────────────────────

/** 本插件的设置（每次调用现读，保证"改完即生效"）。 */
function rawSettings() {
  try { return api?.config?.() || {}; } catch { return {}; }
}

/** "a, b\nc ;d" → ['a','b','c','d']（小写、去空、去通配前缀）。 */
function splitList(raw) {
  return String(raw ?? '')
    .split(/[,;，；\s]+/)
    .map((s) => s.trim().toLowerCase().replace(/^\*\./, '').replace(/^\.+|\.+$/g, ''))
    .filter(Boolean);
}

/**
 * 归一化后的代理配置。
 * enabled 为 false 时调用方一律直连（不报错）—— 用户只是还没填完。
 */
function buildConfig() {
  const s = rawSettings();
  const protocolRaw = String(s.protocol ?? 'http').trim().toLowerCase();
  const socks = protocolRaw.startsWith('socks');
  const protocol = protocolRaw === 'https' ? 'https' : 'http';
  const host = String(s.host ?? '').trim();
  const port = Math.max(0, Math.min(65535, Math.floor(Number(s.port) || 0)));
  const username = String(s.username ?? '').trim();
  const password = String(s.password ?? '');
  const bypass = [...HARD_BYPASS, ...splitList(s.bypass)];
  // 用法：fallback（默认）= 平时直连、连不上才换代理；always = 全部走代理
  const mode = String(s.mode ?? 'fallback').trim().toLowerCase() === 'always' ? 'always' : 'fallback';
  // 直连多久算"连不上"：只影响 fallback 模式，被墙的地址通常表现为一直卡住
  const directTimeoutMs = Math.max(2000, Math.min(60000, Math.round((Number(s.directTimeoutSec) || 10) * 1000)));
  return {
    mode,
    protocol,
    socks,
    host,
    port,
    username,
    password,
    bypass,
    directTimeoutMs,
    // 未配置完整 = 不生效（而不是报错）：留空 host 是初始状态
    enabled: !socks && !!host && port > 0,
    webFetch: s.proxyWebFetch !== false && !socks
  };
}

/** 主机名是否命中绕行清单（完全相等，或为其子域）。 */
function hostBypassed(hostname, list) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;                      // 解析不出主机 = 当本机处理，直连
  return list.some((p) => p && (h === p || h.endsWith(`.${p}`)));
}

/** 目标 URL 是否该直连（解析不出来的地址一律直连，避免把本机流量塞进代理）。 */
function urlBypassed(urlString, list) {
  try {
    return hostBypassed(new URL(String(urlString)).hostname, list);
  } catch {
    return true;
  }
}

// ── 代理 Agent ────────────────────────────────────────────────────────────

/** 按当前配置取/建代理 Agent；配置没变就复用（含连接池）。 */
function ensureProxyAgent(cfg) {
  const key = `${cfg.protocol}|${cfg.host}|${cfg.port}|${cfg.username}|${cfg.password}`;
  if (proxyAgent && proxyAgentKey === key) return proxyAgent;
  try { proxyAgent?.close?.(); } catch { /* 旧 Agent 关不掉不影响新建 */ }
  proxyAgent = null;
  proxyAgentKey = '';
  proxyAgentError = '';
  try {
    const opts = { uri: `${cfg.protocol}://${cfg.host}:${cfg.port}` };
    // undici 的 token 会原样写进 Proxy-Authorization，所以这里自己拼 Basic
    if (cfg.username) opts.token = `Basic ${Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64')}`;
    proxyAgent = new undici.ProxyAgent(opts);
    proxyAgentKey = key;
  } catch (error) {
    proxyAgentError = String(error?.message ?? error);
    api?.warn?.(`构造代理 Agent 失败：${proxyAgentError}`);
  }
  return proxyAgent;
}

// 只有**连接层**失败才值得换代理重试：DNS 解析不出来、连接被拒、连接超时。
// 业务层错误（HTTP 4xx/5xx、用户中止、协议错）绝不重试 —— 那会把"服务器明确拒绝"
// 当成"网络不通"，重试就成了放大器。
const RETRYABLE_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH',
  'ENETUNREACH', 'EPIPE', 'ECONNABORTED', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
  'ERR_SOCKET_CONNECTION_TIMEOUT', 'UND_ERR_CLOSED'
]);

function isConnectFailure(error) {
  const code = String(error?.code ?? '');
  if (RETRYABLE_CODES.has(code)) return true;
  const text = String(error?.message ?? '');
  // 用户主动中止不是"连不上"，重试会让他"点了中止还在跑"
  if (/abort/i.test(code) || /abort/i.test(text)) return false;
  return /fetch failed|socket hang up|connect ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|other side closed|请求超时|域名解析失败/i.test(text);
}

/**
 * 路由 dispatcher：每次 dispatch 现读配置，决定这次请求怎么走。
 *
 * 两种用法：
 *   always   —— 直接交给代理 Agent；
 *   fallback —— 先直连，只有"连不上"才把**同一个请求**改从代理重试一次
 *               （换掉 handler 的 onError，不改请求内容，所以调用方完全无感）。
 *
 * 只重写 dispatch / close / destroy，请求本身（含 body、headers、TLS）全部原样
 * 透传给被选中的 Agent —— 出问题也只会是"走错出口"，不会污染请求内容。
 */
function createRouter() {
  const { Dispatcher, Agent } = undici;

  return new (class ProxyRouter extends Dispatcher {
    constructor() {
      super();
      this.direct = null;
      this.directKey = '';
    }

    /** 直连 Agent：连接超时可配 —— fallback 模式下它就是"多久算连不上"的判据。 */
    directAgent(timeoutMs) {
      const key = String(timeoutMs);
      if (this.direct && this.directKey === key) return this.direct;
      try { this.direct?.close?.(); } catch { /* 旧 Agent 关不掉不影响新建 */ }
      this.direct = new Agent({
        connect: { timeout: timeoutMs },
        keepAliveTimeout: 10000,
        keepAliveMaxTimeout: 60000
      });
      this.directKey = key;
      return this.direct;
    }

    dispatch(opts, handler) {
      let cfg;
      try { cfg = buildConfig(); } catch { return this.directAgent(CONNECT_TIMEOUT_MS).dispatch(opts, handler); }
      const origin = opts?.origin;
      const url = origin ? String(origin.href ?? origin) : '';
      // 未配置 / 本机地址 / 解析不出目标：一律直连
      if (!cfg.enabled || !url || urlBypassed(url, cfg.bypass)) {
        return this.directAgent(cfg.directTimeoutMs).dispatch(opts, handler);
      }
      let proxy = null;
      try { proxy = ensureProxyAgent(cfg); } catch { proxy = null; }
      if (!proxy) return this.directAgent(cfg.directTimeoutMs).dispatch(opts, handler);
      if (cfg.mode === 'always') return proxy.dispatch(opts, handler);
      return this.dispatchFallback(opts, handler, cfg, proxy);
    }

    /** fallback：先直连；连不上才把同一个请求改从代理重试一次。 */
    dispatchFallback(opts, handler, cfg, proxy) {
      const direct = this.directAgent(cfg.directTimeoutMs);
      let settled = false;
      // 一旦真的开始收到响应（或已结束），就不允许再改走代理：
      // 否则"响应读到一半才断"会被当成连不上，导致重复的副作用请求。
      for (const name of ['onConnect', 'onHeaders', 'onData', 'onComplete', 'onUpgrade']) {
        const original = handler[name];
        if (typeof original !== 'function') continue;
        handler[name] = (...args) => { settled = true; return original.apply(handler, args); };
      }
      const originalOnError = handler.onError;
      handler.onError = (error) => {
        if (settled || !isConnectFailure(error)) return originalOnError?.call(handler, error);
        settled = true;
        api?.log?.(`直连失败（${error?.code ?? error?.message ?? '未知'}），改用代理重试`);
        try { return proxy.dispatch(opts, handler); }
        catch (retryError) { return originalOnError?.call(handler, retryError); }
      };
      return direct.dispatch(opts, handler);
    }

    async close() {
      const jobs = [];
      if (this.direct) jobs.push(this.direct.close());
      if (proxyAgent) jobs.push(proxyAgent.close());
      return Promise.allSettled(jobs);
    }

    async destroy(error) {
      const jobs = [];
      if (this.direct) jobs.push(this.direct.destroy(error));
      if (proxyAgent) jobs.push(proxyAgent.destroy(error));
      return Promise.allSettled(jobs);
    }
  })();
}

// ── 生命周期 ──────────────────────────────────────────────────────────────

export async function setup(skillApi) {
  api = skillApi;
  try {
    // 动态 import：undici 拿不到时只让本插件显示"不可用"，不影响应用启动。
    undici = await import('undici');
    if (typeof undici.ProxyAgent !== 'function' || typeof undici.Dispatcher !== 'function') {
      loadError = '当前 undici 版本缺少 ProxyAgent / Dispatcher（需要 undici >= 5.19）';
    }
  } catch (error) {
    loadError = `无法加载 undici：${error?.message ?? error}`;
  }
  if (loadError) api.warn?.(loadError);
}

/** 开启：把路由 dispatcher 装上（幂等，重复调用只装一次）。 */
export function activate() {
  if (loadError) throw new Error(loadError);
  // ⚠️ undici 还没就绪时必须**报错**，不能静默 return：
  //    setup() 是 async（动态 import undici），如果调用方忘了 await setup 就直接
  //    activate，"什么都不装"会表现为"插件显示已开启、网络其实完全没走代理" ——
  //    正是这个插件最不该出现的失败形态（用户以为在走代理，实际裸奔）。
  //    正常流程下加载器会 await setup，所以这条只在异常路径上触发。
  if (!undici) throw new Error('undici 尚未就绪：setup() 未被 await 完成');
  if (router) return;
  router = createRouter();
  try {
    prevDispatcher = undici.getGlobalDispatcher();
    undici.setGlobalDispatcher(router);
  } catch (error) {
    router = null;
    throw error;
  }
  const cfg = buildConfig();
  api?.log?.(cfg.enabled
    ? `已启用：${cfg.mode === 'always' ? '全部走' : '直连优先、连不上才走'} ${cfg.protocol}://${cfg.host}:${cfg.port}`
      + `（绕过 ${cfg.bypass.join(', ')}${cfg.mode === 'fallback' ? `，直连超时 ${cfg.directTimeoutMs / 1000}s` : ''}）`
    : '已启用，但还没填代理地址/端口 —— 在设置里填完立即生效');
}

/** 关闭：还原原来的全局 dispatcher，并释放连接池。 */
export function deactivate() {
  if (!router) return;
  try {
    if (prevDispatcher) undici.setGlobalDispatcher(prevDispatcher);
  } catch (error) {
    api?.warn?.(`还原全局 dispatcher 失败：${error?.message ?? error}`);
  }
  try { router.close(); } catch { /* 关闭失败不影响还原 */ }
  router = null;
  prevDispatcher = null;
  proxyAgent = null;
  proxyAgentKey = '';
  api?.log?.('已停用：网络恢复直连');
}

export function dispose() {
  try { deactivate(); } catch { /* 卸载路径不抛 */ }
}

/** 自检：配置不完整或协议不支持时明确说出原因，而不是静默不生效。 */
export function available() {
  if (loadError) return { ok: false, reason: loadError };
  const cfg = buildConfig();
  if (cfg.socks) return { ok: false, reason: '不支持 SOCKS5：请改用同一代理软件的 HTTP/混合端口' };
  if (!cfg.host) return { ok: false, reason: '还没填代理地址' };
  if (!cfg.port) return { ok: false, reason: '还没填代理端口' };
  return true;
}

/**
 * 提供给核心（src/safe-fetch.js）的代理信息。
 *
 * 安全抓取走的是 node:http(s) 而不是 undici，没法被上面的 dispatcher 罩住，
 * 所以核心按能力名来问这次该怎么走。返回的 dispatcher 是 undici 的
 * ProxyAgent，核心用它发 undici.request。
 *
 * 拿不到配置（未启用 / 未填完整 / 解析失败）时返回 null —— 核心据此走直连，
 * 语义与"没装这个插件"完全一致。
 */
export const providers = {
  'network.proxy-config': () => {
    const cfg = buildConfig();
    if (!cfg.enabled) return null;
    return {
      url: `${cfg.protocol}://${cfg.host}:${cfg.port}`,
      // 用法：fallback（直连优先，连不上才用代理）/ always（全部走代理）
      // 核心的安全抓取按它决定"要不要改成代理发一次"
      mode: cfg.mode,
      webFetch: cfg.webFetch,
      bypass: cfg.bypass,
      dispatcher: ensureProxyAgent(cfg),
      reason: proxyAgentError
    };
  }
};
