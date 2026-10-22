// 余额 / 用量查询（balance-query）—— LLM 型技能，放 skills/，显示在控制台「技能」页签。
//
// ── 为什么是技能（LLM 型），不是插件（确定性型）────────────────────────────
// 按 doc/extend_development/ 的三问判断法：
//   ① 触发时机能用 if 描述吗？——「消息里有'余额查询'四个字」能写死，但
//      「DeepSeek 还有多少钱」「glm 额度用完没」这些同义说法要理解人话，
//      而且要不要查、查哪个渠道得看上下文 → 半能，判据上归技能。
//   ② 漏触发一次的代价？—— 这次没答上来，下次还能问，不丢数据 → 技能。
//   ③ 参数从哪来？—— 「查一下 deepseek」里的渠道名要从人话里抠 → 技能。
//   还有一条硬约束：插件的钩子有 5 秒硬超时且禁止发网络请求，而余额接口
//   常常要好几秒（海外渠道还要等代理回退），做成插件必然「命中了却查不出来」。
//
// ── 密钥怎么藏 ────────────────────────────────────────────────────────────
// Key / Cookie 只存在本技能的设置里（skill.json 的 configSchema 标了 secret，
// 界面回显 ******）。代码只把它们放进请求头：不写日志、不进工具返回值、
// 不回给模型。模型能看到的只有余额数字和失败原因。
//
// ── 四个渠道 ──────────────────────────────────────────────────────────────
//   opencode-go  GET https://opencode.ai/zen/go/v1/usage        滚动用量（5h / 周 / 月）
//   deepseek     GET https://api.deepseek.com/user/balance      账户余额
//   glm          GET https://open.bigmodel.cn/api/biz/account/query-customer-account-report
//                查不到余额时退到 /api/monitor/usage/quota/limit（Coding Plan 配额）
//   mimo         GET https://platform.xiaomimimo.com/api/v1/balance  余额（要控制台 Cookie）
//
// ── 踩坑备忘 ──────────────────────────────────────────────────────────────
//   · 智谱鉴权因端点而异：余额接口吃 `Bearer <key>`，国内站的 monitor 端点
//     吃原始 key（不带 Bearer）→ 先 Bearer，认证失败再退回原始 key。
//   · MiMo 要的是浏览器 Cookie（含 api-platform_serviceToken 与 userId），
//     不是 API Key；用 API Key 填这一栏必然 401。
//   · 所有请求都带超时：海外接口要走「直连失败 → 代理重试」，超时太短会
//     在代理接管前就被判死。
//   · 返回给模型的是**人话摘要**，不是原始 JSON：模型转述不容易抄错。

const VERSION = '1.0.0';
const UA = `qq-agent-balance/${VERSION} (+node)`;

/** 渠道表：id 与工具参数里用的名字完全一致。 */
const CHANNELS = {
  'opencode-go': {
    label: 'OpenCode Go',
    credential: 'opencodeGoKey',
    credentialName: 'OpenCode Go 密钥（opencodeGoKey）',
    url: 'https://opencode.ai/zen/go/v1/usage'
  },
  deepseek: {
    label: 'DeepSeek',
    credential: 'deepseekKey',
    credentialName: 'DeepSeek 密钥（deepseekKey）',
    url: 'https://api.deepseek.com/user/balance'
  },
  glm: {
    label: '智谱 GLM',
    credential: 'glmKey',
    credentialName: '智谱 GLM 密钥（glmKey）',
    host: { cn: 'https://open.bigmodel.cn', global: 'https://api.z.ai' }
  },
  mimo: {
    label: '小米 MiMo',
    credential: 'mimoCookie',
    credentialName: '小米 MiMo Cookie（mimoCookie）',
    url: 'https://platform.xiaomimimo.com/api/v1'
  }
};

const CHANNEL_IDS = Object.keys(CHANNELS);
const REGIONS = new Set(['cn', 'global']);

let cfg = () => ({});
let log = () => {};
let warn = () => {};
let httpFetch = null;

// ── 生命周期 ───────────────────────────────────────────────────────────────

export function setup(api) {
  cfg = api.config || (() => ({}));
  log = api.log || (() => {});
  warn = api.warn || (() => {});
  httpFetch = api.fetch || globalThis.fetch;

  log(`余额/用量查询已加载（${VERSION}）：渠道 ${CHANNEL_IDS.join(' / ')}`);

  api.registerTool({
    id: 'query_balance',
    name: '查询余额与用量',
    description:
      '查询 AI 服务商账户的余额与滚动用量：OpenCode Go（5 小时/周/月用量百分比）、'
      + 'DeepSeek（账户余额）、智谱 GLM（现金余额，或 Coding Plan 配额用量）、小米 MiMo（账户余额）。'
      + '当群友说「余额查询」「用量查询」「查余额」，或问某个 AI 服务还剩多少钱、额度还剩多少时调用。'
      + 'channel 指定查哪个：all（默认，把所有填了密钥的渠道一次查完）/ opencode-go / deepseek / glm / mimo。'
      + '没填密钥的渠道会被自动跳过并在结果里列出，不会报错。'
      + '结果里只有余额数字，不含任何密钥；如果某条查询失败，把失败原因如实告诉群友。',
    category: 'query',
    icon: '💰',
    defaultEnabled: true,
    parameters: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          enum: ['all', ...CHANNEL_IDS],
          description: '要查的渠道。all = 查所有已配置密钥的渠道（默认）；也可以只查其中一个：opencode-go / deepseek / glm / mimo。'
        }
      }
    },
    async execute(_ctx, args) {
      try {
        const c = cfg() || {};
        const timeoutMs = clamp(Number(c.timeoutMs) || 25000, 5000, 60000);
        const region = REGIONS.has(String(c.glmRegion || 'cn').trim().toLowerCase())
          ? String(c.glmRegion).trim().toLowerCase()
          : 'cn';

        const asked = normalizeChannel(args?.channel);
        const wanted = asked === 'all' ? CHANNEL_IDS.slice() : [asked];
        const ready = wanted.filter((id) => credentialOf(c, id));
        const skipped = wanted.filter((id) => !credentialOf(c, id));

        if (!ready.length) {
          return fail(
            `这些渠道都还没填密钥：${wanted.map(labelOf).join('、')}。`
            + '（在 QQ Agent 控制台「技能 → 余额 / 用量查询 → ⚙ 设置」里填至少一个；'
            + '密钥只存在本地，不会出现在对话里。）'
          );
        }

        const results = await Promise.all(ready.map(async (id) => {
          try {
            const out = await queryChannel(id, {
              token: credentialOf(c, id),
              timeoutMs,
              region
            });
            return { id, ok: true, lines: out.lines, note: out.note || '' };
          } catch (error) {
            const message = friendly(error);
            warn(`渠道 ${id} 查询失败：${message}`);
            return { id, ok: false, message };
          }
        }));

        return {
          content: render(results, skipped),
          isError: results.every((r) => !r.ok)
        };
      } catch (error) {
        warn(`余额查询整体失败：${error?.message ?? error}`);
        return fail(`查询没跑起来：${friendly(error)}`);
      }
    }
  });
}

/**
 * 可用性自检（**必须同步**，返回 Promise 会被当成可用）。
 * 一个密钥都没填时，控制台技能页会显示「需要配置」而不是假装生效。
 */
export function available() {
  try {
    const c = cfg() || {};
    if (CHANNEL_IDS.some((id) => credentialOf(c, id))) return { ok: true };
    return {
      ok: false,
      reason: '还没填任何渠道的密钥：点 ⚙ 设置填 OpenCode Go / DeepSeek / 智谱 GLM / 小米 MiMo 中任意一个'
    };
  } catch {
    return { ok: true };
  }
}

// ── 渠道分发 ───────────────────────────────────────────────────────────────

function queryChannel(id, ctx) {
  switch (id) {
    case 'opencode-go': return queryOpenCodeGo(ctx);
    case 'deepseek': return queryDeepSeek(ctx);
    case 'glm': return queryGlm(ctx);
    case 'mimo': return queryMiMo(ctx);
    default: throw new QueryError(`未知渠道：${id}`);
  }
}

// ── OpenCode Go：滚动用量 ──────────────────────────────────────────────────

const WINDOWS = [
  ['rolling', ['rolling'], '5 小时滚动'],
  ['weekly', ['weekly', 'week'], '每周'],
  ['monthly', ['monthly', 'month'], '每月']
];

async function queryOpenCodeGo(ctx) {
  const res = await getJson(CHANNELS['opencode-go'].url, {
    authorization: `Bearer ${ctx.token}`
  }, ctx);

  if (!res.ok) {
    throw httpError('OpenCode Go', res, res.status === 401 || res.status === 403
      ? '（Key 无效，或这个 Key 没开通 Go 订阅）'
      : '');
  }

  const root = res.json?.usage ?? res.json?.data?.usage ?? res.json?.data ?? res.json;
  if (!root || typeof root !== 'object') {
    throw new QueryError('OpenCode Go 返回的格式不认识（没找到 usage 字段），接口可能改版了');
  }

  const windows = readUsageWindows(root);
  if (windows.every((w) => w.percent === null)) {
    throw new QueryError('OpenCode Go 返回里没找到用量百分比，接口可能改版了');
  }

  const lines = [];
  for (const w of windows) {
    if (w.percent === null) {
      lines.push(`${w.label}：接口没返回`);
      continue;
    }
    const used = clamp(w.percent, 0, 100);
    const reset = formatTime(w.resetsAt);
    const state = w.status && !['ok', 'unknown', 'active'].includes(w.status.toLowerCase())
      ? `，状态 ${w.status}` : '';
    lines.push(`${w.label}：已用 ${percent(used)}，剩余 ${percent(100 - used)}`
      + (reset ? `，${reset} 重置` : '') + state);
  }

  return { lines, note: '滚动窗口按订阅周期自动重置' };
}

/** 从 usage 对象里读三个窗口；字段名做了多种兼容（接口改版时至少别直接崩）。 */
function readUsageWindows(root) {
  const firstNumber = (...vals) => vals.find((v) => typeof v === 'number' && Number.isFinite(v));

  return WINDOWS.map(([key, keys, label]) => {
    const w = keys.map((k) => root?.[k]).find((v) => v && typeof v === 'object');
    if (!w) return { key, label, percent: null, resetsAt: null, status: '' };

    let used = firstNumber(w.percent, w.usagePercent, w.percentage, w.percentUsed);
    if (used === undefined) {
      const usedUnits = firstNumber(w.used, w.usage, w.consumed, w.count, w.usedTokens, w.usedMicroCents);
      const limitUnits = firstNumber(w.limit, w.total, w.quota, w.max, w.cap, w.tokenLimit, w.limitMicroCents);
      if (usedUnits !== undefined && limitUnits > 0) used = (usedUnits / limitUnits) * 100;
    }

    let resetsAt = w.resetsAt ?? w.resetAt ?? w.resets_at ?? w.resetTime ?? null;
    if (!resetsAt) {
      // 有些版本只给「还剩多少秒」
      const sec = firstNumber(w.resetInSec, w.resetInSeconds, w.resetIn, w.secondsUntilReset);
      if (sec !== undefined) resetsAt = Date.now() + sec * 1000;
    }

    return {
      key,
      label,
      percent: used === undefined ? null : used,
      resetsAt,
      status: typeof w.status === 'string' ? w.status : ''
    };
  });
}

// ── DeepSeek：账户余额 ─────────────────────────────────────────────────────

async function queryDeepSeek(ctx) {
  const res = await getJson(CHANNELS.deepseek.url, {
    authorization: `Bearer ${ctx.token}`
  }, ctx);
  if (!res.ok) throw httpError('DeepSeek', res);

  const infos = Array.isArray(res.json?.balance_infos) ? res.json.balance_infos : [];
  if (!infos.length && res.json?.is_available === undefined) {
    throw new QueryError('DeepSeek 返回的格式不认识（没有 balance_infos），接口可能改版了');
  }

  const lines = [];
  for (const b of infos) {
    const currency = b?.currency || 'CNY';
    const extra = [];
    if (b?.granted_balance !== undefined) extra.push(`赠送 ${money(b.granted_balance)}`);
    if (b?.topped_up_balance !== undefined) extra.push(`充值 ${money(b.topped_up_balance)}`);
    lines.push(`可用余额 ${money(b?.total_balance)} ${currency}`
      + (extra.length ? `（${extra.join(' / ')}）` : ''));
  }
  if (!lines.length) lines.push('接口没有返回余额条目');
  lines.push(res.json?.is_available === false ? '状态：余额不足，当前无法调用 API' : '状态：可正常调用');

  return { lines };
}

// ── 智谱 GLM：现金余额优先，查不到退回 Coding Plan 配额 ────────────────────

async function queryGlm(ctx) {
  const host = CHANNELS.glm.host[ctx.region] || CHANNELS.glm.host.cn;

  // 1) 现金余额
  const accountRes = await glmFetch(host, '/api/biz/account/query-customer-account-report', ctx);
  const account = glmPayload(accountRes);
  const available = account ? Number(account.availableBalance ?? account.balance) : NaN;

  if (Number.isFinite(available)) {
    const extra = [];
    const num = (v) => (v === undefined || v === null || !Number.isFinite(Number(v)) ? null : Number(v));
    const recharged = num(account.rechargeAmount);
    const gifted = num(account.giveAmount);
    const spent = num(account.totalSpendAmount);
    const frozen = num(account.frozenBalance);
    if (recharged !== null) extra.push(`充值 ${money(recharged)}`);
    if (gifted !== null) extra.push(`赠送 ${money(gifted)}`);
    if (spent !== null) extra.push(`已用 ${money(spent)}`);
    if (frozen !== null && frozen > 0) extra.push(`冻结 ${money(frozen)}`);

    return {
      lines: [
        `可用余额 ${money(available)} CNY` + (extra.length ? `（${extra.join(' / ')}）` : '')
      ]
    };
  }

  // 2) 余额接口不可用（典型：Coding Plan 套餐 Key）→ 配额用量
  const quotaRes = await glmFetch(host, '/api/monitor/usage/quota/limit', ctx);
  const windows = readGlmQuota(quotaRes.json);
  if (windows && windows.length) {
    return {
      note: '这个 Key 查不到现金余额（多数是 Coding Plan 套餐 Key），以下是套餐配额用量',
      lines: windows.map((w) => {
        if (Number.isFinite(w.used) && Number.isFinite(w.limit)) {
          return `${w.label}：${w.used}/${w.limit}`
            + (Number.isFinite(w.percent) ? `（${percent(w.percent)}）` : '')
            + (formatTime(w.resetsAt) ? `，${formatTime(w.resetsAt)} 重置` : '');
        }
        const p = Number.isFinite(w.percent) ? w.percent : null;
        return `${w.label}：` + (p === null ? '接口没返回用量'
          : `已用 ${percent(p)}，剩余 ${percent(100 - p)}`)
          + (formatTime(w.resetsAt) ? `，${formatTime(w.resetsAt)} 重置` : '');
      })
    };
  }

  // 智谱「身份验证失败」是 HTTP 200 + code 1000，不能只看状态码
  if (isAuthFailure(accountRes) || isAuthFailure(quotaRes)) {
    throw new QueryError(
      '智谱 GLM 身份验证失败：密钥无效，或区域选错了'
      + `（国内 open.bigmodel.cn 用 cn，海外 z.ai 用 global；当前 region=${ctx.region}）`
    );
  }

  throw new QueryError(
    `余额接口和配额接口都没查到（余额 HTTP ${accountRes.status}；配额 HTTP ${quotaRes.status}）。`
    + `请确认密钥和区域是否匹配：国内平台用 cn，z.ai 用 global（当前 region=${ctx.region}）`
  );
}

/** 智谱的鉴权失败：401/403，或 HTTP 200 但 code = 401 / 1000。 */
function isAuthFailure(res) {
  if (!res) return false;
  const code = res.json?.code;
  return res.status === 401 || res.status === 403 || code === 401 || code === 1000;
}

/**
 * 智谱鉴权：余额 / 资源包 / 订阅接口吃 `Bearer <key>`，
 * 国内站的 monitor 端点吃原始 key（不带 Bearer）。先 Bearer，认证失败再退回原始。
 */
async function glmFetch(host, path, ctx) {
  const schemes = [`Bearer ${ctx.token}`, ctx.token];
  let last = null;
  for (const authorization of schemes) {
    const res = await getJson(host + path, { authorization }, ctx);
    last = res;
    const code = res.json?.code;
    const authProblem = res.status === 401 || code === 401 || code === 1000;
    if (!authProblem) return res;
  }
  return last;
}

/** 智谱响应外壳：code 非 0/200 或 success:false 视为没查到。 */
function glmPayload(res) {
  if (!res.ok) return null;
  const body = res.json;
  if (!body || typeof body !== 'object') return null;
  if (typeof body.code === 'number' && body.code !== 0 && body.code !== 200) return null;
  if (body.success === false) return null;
  return body.data ?? body;
}

/** 智谱 Coding Plan 配额：limits[] 里按 type / unit 区分窗口。 */
function readGlmQuota(json) {
  const container = json?.data ?? json;
  const limits = Array.isArray(container) ? container : container?.limits;
  if (!Array.isArray(limits) || !limits.length) return null;

  const out = [];
  for (const l of limits) {
    if (!l || typeof l !== 'object') continue;
    const type = String(l.type ?? l.name ?? '').toUpperCase();

    let label;
    if (type === 'TIME_LIMIT') label = '联网搜索';
    else if (l.unit === 3) label = '5 小时滚动';
    else if (l.unit === 6) label = '每周';
    else if (type === 'TOKENS_LIMIT') label = 'Token 用量';
    else if (type === 'CREDIT_LIMIT') label = '积分额度';
    else label = type || '额度';

    if (type === 'TIME_LIMIT') {
      const used = Number(l.currentValue);
      const limit = Number(l.usage);
      const pct = Number.isFinite(used) && limit > 0 ? (used / limit) * 100 : null;
      out.push({
        label,
        used: Number.isFinite(used) ? used : null,
        limit: Number.isFinite(limit) ? limit : null,
        percent: pct,
        resetsAt: l.nextResetTime ?? null
      });
      continue;
    }

    if (typeof l.percentage !== 'number') continue;
    out.push({
      label,
      used: null,
      limit: null,
      percent: l.percentage,
      resetsAt: l.nextResetTime ?? null
    });
  }
  return out.length ? out : null;
}

// ── 小米 MiMo：账户余额（控制台 Cookie）────────────────────────────────────

async function queryMiMo(ctx) {
  const base = CHANNELS.mimo.url;
  const cookie = String(ctx.token || '').trim().replace(/^cookie\s*:\s*/i, '');

  const missing = ['api-platform_serviceToken', 'userId'].filter((k) => !cookie.includes(k));
  if (missing.length) {
    throw new QueryError(
      `Cookie 里缺少 ${missing.join(' / ')}。MiMo 要的是控制台 Cookie，不是 API Key：`
      + '登录 platform.xiaomimimo.com → 控制台余额页 → 开发者工具 Network 里复制余额请求的整条 Cookie'
    );
  }

  const headers = {
    cookie,
    accept: 'application/json, text/plain, */*',
    origin: 'https://platform.xiaomimimo.com',
    referer: 'https://platform.xiaomimimo.com/#/console/balance',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8'
  };

  const res = await getJson(`${base}/balance`, headers, ctx);
  if (!res.ok) {
    throw httpError('小米 MiMo', res, res.status === 401 ? '（Cookie 过期了，重新登录复制一次）' : '');
  }

  const code = res.json?.code;
  if (code !== undefined && Number(code) !== 0) {
    throw new QueryError(`MiMo 返回 code ${code}${res.json?.message ? `：${res.json.message}` : ''}`
      + (Number(code) === 401 ? '（Cookie 过期了，重新登录复制一次）' : ''));
  }

  const data = res.json?.data ?? res.json;
  const total = Number(data?.balance);
  if (!Number.isFinite(total)) {
    throw new QueryError('MiMo 返回的格式不认识（缺少 data.balance），接口可能改版了');
  }

  const currency = data?.currency || 'CNY';
  const extra = [];
  if (data?.cashBalance !== undefined && Number.isFinite(Number(data.cashBalance))) {
    extra.push(`现金 ${money(data.cashBalance)}`);
  }
  if (data?.giftBalance !== undefined && Number.isFinite(Number(data.giftBalance))) {
    extra.push(`赠送 ${money(data.giftBalance)}`);
  }

  return {
    lines: [`可用余额 ${money(total)} ${currency}` + (extra.length ? `（${extra.join(' / ')}）` : '')]
  };
}

// ── HTTP ───────────────────────────────────────────────────────────────────

class QueryError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'QueryError';
    this.status = detail.status;
  }
}

async function getJson(url, headers, ctx) {
  const timeoutMs = clamp(Number(ctx.timeoutMs) || 25000, 5000, 60000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await httpFetch(url, {
      headers: { 'user-agent': UA, accept: 'application/json', ...headers },
      signal: controller.signal
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* 非 JSON（网关 HTML 错误页之类），下面按 text 兜底 */
    }
    return { status: res.status, ok: res.ok, json, text };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new QueryError(`请求超时（等了 ${Math.round(timeoutMs / 1000)} 秒没响应）`);
    }
    const cause = error?.cause?.code || error?.cause?.message || '';
    throw new QueryError(`网络不通：${error?.message ?? error}${cause ? `（${cause}）` : ''}`);
  } finally {
    clearTimeout(timer);
  }
}

function httpError(label, res, hint = '') {
  let extra = hint;
  if (!extra) {
    if (res.status === 401 || res.status === 403) extra = '（密钥无效、过期，或没有该渠道权限）';
    else if (res.status === 404) extra = '（接口地址可能已改版）';
    else if (res.status === 429) extra = '（请求太频繁，稍后再试）';
    else if (res.status >= 500) extra = '（对方服务异常，稍后再试）';
  }
  return new QueryError(`${label} 返回 HTTP ${res.status}${extra}：${errorText(res.json, res.text)}`,
    { status: res.status });
}

function errorText(json, text) {
  const candidates = [
    json?.error?.message,
    json?.error?.msg,
    json?.msg,
    json?.message,
    typeof json?.error === 'string' ? json.error : ''
  ].filter((v) => typeof v === 'string' && v.trim());
  if (candidates.length) return candidates[0].trim().slice(0, 160);
  if (text) return String(text).replace(/\s+/g, ' ').trim().slice(0, 160) || '没有返回内容';
  return '没有返回内容';
}

// ── 渲染 ───────────────────────────────────────────────────────────────────

function render(results, skipped) {
  const lines = [`【余额 / 用量查询】${stamp()}`];
  for (const r of results) {
    lines.push(`── ${labelOf(r.id)} ──`);
    if (!r.ok) {
      lines.push(`查询失败：${r.message}`);
      continue;
    }
    if (r.note) lines.push(`（${r.note}）`);
    for (const line of r.lines || []) lines.push(line);
  }
  if (skipped.length) {
    const detail = skipped.map((id) => `${labelOf(id)}（${CHANNELS[id].credential}）`).join('、');
    lines.push('');
    lines.push(`没填密钥、已跳过：${detail}`);
  }
  lines.push('');
  lines.push('（以上是接口实时返回。金额、百分比、重置时间如实转述；查询失败的那条直说原因和该填哪一项，'
    + '不要编数字，也不要提任何密钥内容。）');
  return lines.join('\n');
}

function fail(message) {
  return { content: `查询失败：${message}`, isError: true };
}

// ── 小工具 ─────────────────────────────────────────────────────────────────

function credentialOf(config, id) {
  const key = CHANNELS[id]?.credential;
  if (!key) return '';
  const value = config?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function labelOf(id) {
  return CHANNELS[id]?.label || id;
}

/** 参数容错：模型可能给 null、空串、大写、带空格的别名。 */
function normalizeChannel(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value || value === 'all' || value === '全部' || value === '所有') return 'all';
  if (CHANNELS[value]) return value;
  const alias = {
    go: 'opencode-go',
    opencode: 'opencode-go',
    opencodego: 'opencode-go',
    'opencode-go': 'opencode-go',
    ds: 'deepseek',
    zhipu: 'glm',
    bigmodel: 'glm',
    zai: 'glm',
    'z-ai': 'glm',
    xiaomi: 'mimo'
  }[value];
  return alias || 'all';
}

function friendly(error) {
  if (error instanceof QueryError) return error.message;
  return String(error?.message ?? error);
}

function clamp(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

function money(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toFixed(2) : '-';
}

function percent(n) {
  const v = Number(n);
  return Number.isFinite(v) ? `${v.toFixed(1)}%` : '-';
}

/** 时间戳/ISO 串/日期串 → "MM-DD HH:mm"；解析不了就原样返回。 */
function formatTime(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return value.trim();
  let d;
  if (typeof value === 'number') d = new Date(value < 1e12 ? value * 1000 : value);
  else d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return String(value);
  const p = (n) => String(n).padStart(2, '0');
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const date = sameYear
    ? `${p(d.getMonth() + 1)}-${p(d.getDate())}`
    : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return `${date} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function stamp() {
  return formatTime(Date.now());
}

/**
 * 排障 / 自测用：把纯函数暴露出来，方便用假响应验证解析逻辑，
 * 不会碰真实密钥，也不会被模型看到。
 */
export const internals = {
  CHANNELS,
  CHANNEL_IDS,
  readUsageWindows,
  readGlmQuota,
  glmPayload,
  normalizeChannel,
  formatTime,
  money,
  percent
};
