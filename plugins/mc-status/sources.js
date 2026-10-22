/**
 * mc-status 数据源层
 *
 * 三个数据源，跟 weather-card 同一套模式（默认源零配置就能用，其余按需切换）：
 *   direct    直连服务器（默认）—— 自己实现协议，不依赖任何第三方
 *   mcsrvstat 第三方 API mcsrvstat.us —— 直连不通时的备胎，支持基岩版
 *   custom    自建 HTTP 接口 —— 自己填 URL 模板 + 字段映射
 *
 * ⚠️ 2026-09-21 实测：本机两家第三方 API 都不通
 *   - api.mcsrvstat.us 自身 DNS 故障，返回 {"online":false, debug.errors:[DNS lookup failed]}
 *     —— 明明是它自己坏了，却把服务器报成离线，这种误报比查不到还糟
 *   - api.mcstatus.io 直接返回空
 *   而直连 hypixel / mineplex / cubecraft 全部正常。
 *   所以默认必须是 direct。第三方源保留是为了网络环境不同的机器，不是因为指望它。
 */
// ⚠️ 热重载坑（项目踩过）：plugin-loader 只给插件**入口**加时间戳，入口里静态 import 的
//   子模块会命中 Node 的 ESM 缓存 —— 改了子模块，热重载日志报"成功"，跑的却还是旧版。
//   mcping.js 是 sources.js 的子模块，所以这里也必须动态 import + 时间戳，
//   否则改协议实现就得重启整个机器人。
const { pingServer, cleanMotd, extractText, parseMotdRich } = await import(`./mcping.js?t=${Date.now()}`);

/** 安全取数：取不到就是 null，绝不返回 undefined 混进渲染层 */
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** MOTD 可能是字符串、数组、组件对象，统一成一行纯文本 */
function motdText(m) {
  if (Array.isArray(m)) return cleanMotd(m.map((x) => (typeof x === 'string' ? x : extractText(x))).join(' '));
  if (m && typeof m === 'object') {
    if (Array.isArray(m.clean)) return cleanMotd(m.clean.join(' '));
    if (m.clean != null) return cleanMotd(extractText(m.clean));
    if (m.raw != null) return cleanMotd(extractText(m.raw));
    if (m.text != null) return cleanMotd(extractText(m.text));
    return '';
  }
  return cleanMotd(extractText(m));
}

/**
 * MOTD → 彩色片段，给卡片渲染用。跟 motdText 配对：一个出纯文本（给模型/文字卡），
 * 一个出彩色片段（给卡片图）。
 *
 * ⚠️ 取值顺序跟 motdText **故意相反**：motdText 要干净文本所以优先 clean；
 *    彩色要的是**带格式码的原文**，所以优先 raw —— 拿 clean 的话码已经被剥干净了，没颜色可还原。
 * ⚠️ 绝不取 html 字段：mcsrvstat 会返回一个带 <span> 的 html 版本，那是别人家拼好的
 *    HTML，直接用等于把 XSS 洞口敞开。我们只吃原始文本，自己解析、自己转义。
 */
function motdRichParts(m) {
  if (Array.isArray(m)) return parseMotdRich(m.map((x) => (typeof x === 'string' ? x : extractText(x))).join(' '));
  if (m && typeof m === 'object') {
    if (Array.isArray(m.raw)) return parseMotdRich(m.raw.join(' '));
    if (m.raw != null) return parseMotdRich(extractText(m.raw));
    if (Array.isArray(m.clean)) return parseMotdRich(m.clean.join(' '));
    if (m.clean != null) return parseMotdRich(extractText(m.clean));
    if (m.text != null) return parseMotdRich(extractText(m.text));
    return [];
  }
  return parseMotdRich(m);
}

/**
 * 统一返回结构。所有源都必须产出这个形状，渲染层才不用分支。
 * ok      —— 这次查询本身成功了吗（false 表示没查到可信结果）
 * online  —— 服务器在线吗
 * ⚠️ 两者不是一回事：查不通（ok=false）不代表服务器一定关了，
 *    可能只是网络/防火墙问题，渲染层要说清楚，别一口咬定"服务器挂了"。
 */
const blank = (name, host, port, edition) => ({
  ok: false, online: false, name, host, port, edition,
  version: '', protocol: null, playersOnline: null, playersMax: null,
  sample: [], motd: '', motdRich: [], query: null, latency: null, error: '', source: '', favicon: '', queriedAt: Date.now()
});

/* ── 1. 直连 ─────────────────────────────────────────────── */
async function fetchDirect(s, cfg) {
  const out = blank(s.name, s.host, s.port, s.edition);
  out.source = 'direct';
  try {
    const r = await pingServer(s.host, s.port, {
      edition: s.edition,
      timeout: num(cfg.timeout) || 5000,
      useSrv: cfg.useSrv !== false,
      // Query 要服务器开 enable-query，默认没开，所以默认关 —— 否则每次查询都白等一次 UDP 超时
      useQuery: cfg.useQuery === true
    });
    return {
      ...out,
      ok: true,
      online: true,
      host: r.queriedHost,
      port: r.queriedPort,
      version: r.version || '',
      protocol: r.protocol ?? null,
      playersOnline: r.playersOnline,
      playersMax: r.playersMax,
      sample: r.sample || [],
      motd: r.motd || '',
      motdRich: Array.isArray(r.motdRich) ? r.motdRich : [],
      // Query 补充信息（完整玩家名单/插件/地图），拿不到就是 null，渲染层自己判断
      query: r.query || null,
      latency: r.latency ?? null,
      // 服务器图标（status 响应里自带 base64 PNG，不用额外请求）。
      // ⚠️ 这是**服务器管理员可控的任意字符串**，渲染层必须自己过滤，不能直接塞进 img src。
      favicon: typeof r.favicon === 'string' ? r.favicon : ''
    };
  } catch (e) {
    // 区分「端口明确拒绝」和「超时」：前者基本可以确定是关了，
    // 后者可能是防火墙丢包，不能说死。
    const msg = String(e?.message || e);
    out.error = /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH/.test(msg)
      ? `连不上（${msg}）`
      : /超时|timeout|ETIMEDOUT/i.test(msg)
        ? `超时（可能已关服，也可能是网络/防火墙拦截）`
        : msg;
    return out;
  }
}

/* ── 2. mcsrvstat.us ────────────────────────────────────── */
async function fetchMcsrvstat(s, cfg, fetchRef) {
  const out = blank(s.name, s.host, s.port, s.edition);
  out.source = 'mcsrvstat';
  if (!fetchRef) { out.error = '插件未声明 web_fetch 权限，拿不到 fetch'; return out; }

  const bedrock = s.edition === 'bedrock';
  const base = String(cfg.apiBase || 'https://api.mcsrvstat.us').replace(/\/+$/, '');
  const url = `${base}/${bedrock ? 'bedrock/' : ''}3/${encodeURIComponent(s.host)}`
    + (s.port && s.port !== (bedrock ? 19132 : 25565) ? `:${s.port}` : '');

  let j;
  try {
    const res = await fetchRef(url);
    j = await res.json();
  } catch (e) {
    out.error = `查询服务请求失败：${String(e?.message || e)}`;
    return out;
  }

  // ⚠️ 关键：mcsrvstat 自己 DNS 挂掉时也会返回 online:false，
  //    并在 debug.errors 里写明是它自己的问题。不区分就会把「查询服务坏了」
  //    说成「你的服务器关了」—— 这是最要命的误报。
  const selfErr = Array.isArray(j?.debug?.errors) && j.debug.errors.length
    ? j.debug.errors.map((x) => `${x.type}: ${x.message}`).join('；')
    : '';
  if (selfErr && !j.online) {
    out.error = `查询服务自身出错，结果不可信（${selfErr}）。建议改用直连`;
    return out;
  }

  out.ok = true;
  out.online = j.online === true;
  out.host = j.hostname || s.host;
  out.port = num(j.port) ?? s.port;
  if (!out.online) { out.error = '服务器离线'; return out; }

  out.version = String(j.version ?? '').trim();
  out.protocol = num(j.protocol);
  // v2/v3 的 players 结构不完全一样，两种都认
  const p = j.players || {};
  out.playersOnline = num(p.online ?? j.players?.online);
  out.playersMax = num(p.max ?? j.players?.max);
  out.sample = Array.isArray(p.list)
    ? p.list.map((x) => String(typeof x === 'string' ? x : (x?.name ?? ''))).filter(Boolean) : [];
  out.motd = motdText(j.motd);
  out.motdRich = motdRichParts(j.motd);
  out.latency = null; // 第三方给的是它到服务器的延迟，不是你这台的，不给
  return out;
}

/* ── 3. 自建 HTTP 接口 ──────────────────────────────────── */
/** 按 "a.b.c" 路径取值，取不到返回 undefined */
function pickPath(obj, p) {
  try {
    return String(p).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  } catch { return undefined; }
}

async function fetchCustom(s, cfg, fetchRef) {
  const out = blank(s.name, s.host, s.port, s.edition);
  out.source = 'custom';
  if (!fetchRef) { out.error = '插件未声明 web_fetch 权限，拿不到 fetch'; return out; }

  const tpl = String(cfg.apiUrl || '').trim();
  if (!tpl) { out.error = '没填自建接口地址'; return out; }

  let map = {};
  try { map = JSON.parse(String(cfg.customMap || '{}')); } catch { /* 映射坏了就全用默认路径 */ }

  const url = tpl
    .replace(/\{host\}/g, encodeURIComponent(s.host))
    .replace(/\{port\}/g, String(s.port || ''))
    .replace(/\{edition\}/g, s.edition || 'java');

  let j;
  try {
    const res = await fetchRef(url);
    j = await res.json();
  } catch (e) {
    out.error = `自建接口请求失败：${String(e?.message || e)}`;
    return out;
  }

  out.ok = true;
  const onlineRaw = pickPath(j, map.online || 'online');
  // 没配 online 路径时，只要拿到数据就当在线（跟 weather-card 的自建接口一个道理）
  out.online = onlineRaw === undefined ? true : (onlineRaw === true || onlineRaw === 'true' || onlineRaw === 1 || onlineRaw === '1');
  if (!out.online) { out.error = '服务器离线'; return out; }

  out.version = String(pickPath(j, map.version || 'version') ?? '').trim();
  out.protocol = num(pickPath(j, map.protocol || 'protocol'));
  out.playersOnline = num(pickPath(j, map.playersOnline || 'players.online'));
  out.playersMax = num(pickPath(j, map.playersMax || 'players.max'));
  const list = pickPath(j, map.sample || 'players.list');
  out.sample = Array.isArray(list)
    ? list.map((x) => String(typeof x === 'string' ? x : (x?.name ?? ''))).filter(Boolean) : [];
  out.motd = motdText(pickPath(j, map.motd || 'motd'));
  out.motdRich = motdRichParts(pickPath(j, map.motd || 'motd'));
  out.latency = num(pickPath(j, map.latency || 'latency'));
  return out;
}

/* ── 注册表 ─────────────────────────────────────────────── */
export const SOURCES = {
  direct: {
    id: 'direct',
    label: '直连服务器',
    note: '自己实现 MC 协议，不经过任何第三方。延迟是你这台机器到服务器的真实延迟。',
    fetch: (s, cfg) => fetchDirect(s, cfg)
  },
  mcsrvstat: {
    id: 'mcsrvstat',
    label: 'mcsrvstat.us（第三方）',
    note: '支持基岩版；但依赖别人家服务，且实测会把它自己的故障报成服务器离线。',
    fetch: (s, cfg, fetchRef) => fetchMcsrvstat(s, cfg, fetchRef)
  },
  custom: {
    id: 'custom',
    label: '自建 HTTP 接口',
    note: '填 URL 模板（支持 {host}/{port}/{edition}）+ JSON 字段映射。',
    fetch: (s, cfg, fetchRef) => fetchCustom(s, cfg, fetchRef)
  }
};

export function getSource(id) {
  return SOURCES[id] || SOURCES.direct;
}

/**
 * 解析服务器列表配置。
 * 支持两种写法：
 *   1. 多行/逗号分隔：  名称|地址:端口|版本  （名称和版本可省）
 *      「Hypixel|mc.hypixel.net」「我的服|1.2.3.4:25566|bedrock」
 *   2. JSON 数组：[{"name":"...","host":"...","port":25565,"edition":"java"}]
 */
export function parseServers(input, fallback = '') {
  const raw = String(input ?? '').trim() || String(fallback ?? '').trim();
  if (!raw) return [];

  // 先试 JSON
  if (raw.startsWith('[')) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        return arr.map((x) => normalizeServer(x)).filter((x) => x.host);
      }
    } catch { /* 不是合法 JSON 就按文本解析 */ }
  }

  return raw.split(/[\n,，;；]+/).map((line) => {
    const parts = String(line).split('|').map((x) => String(x).trim());
    const [name, addr, edition] = parts;
    const target = addr || name || '';
    // 支持 host:port，也支持 IPv6 的 [::1]:25565
    let host = target;
    let port = null;
    const m6 = target.match(/^\[(.+)\]:(\d+)$/);
    const m4 = target.match(/^(.+):(\d+)$/);
    if (m6) { host = m6[1]; port = Number(m6[2]); }
    else if (m4) { host = m4[1]; port = Number(m4[2]); }
    return normalizeServer({ name: addr ? name : '', host, port, edition });
  }).filter((x) => x.host);
}

function normalizeServer(x) {
  const host = String(x?.host ?? x?.addr ?? '').trim();
  const edition = String(x?.edition ?? '').trim().toLowerCase() === 'bedrock' ? 'bedrock' : 'java';
  const port = Number(x?.port) || (edition === 'bedrock' ? 19132 : 25565);
  return {
    name: String(x?.name ?? '').trim() || host,
    host,
    port,
    edition
  };
}
