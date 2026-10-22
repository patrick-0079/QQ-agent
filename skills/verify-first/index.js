// 先查证再回答（LLM 型技能）—— 把「不知道」变成最后一步。
//
// 为什么放在 skills/ 而不是 plugins/：
//   什么时候该查、查到什么程度算够，只能由模型理解人话来判断，没有任何"满足条件必然执行"
//   的时机可言。放 plugins/ 且只 registerTool 会触发加载器的 lintKindPlacement 警告。
//
// 本技能提供两样东西：
//   1. 提示词片段（skill.json 的 prompt.sections）：把「先查本地 → 联网搜 → 打开正文 →
//      交叉验证 → 才说不知道」写成硬规则，并规定"不知道"的三种口径。
//   2. 工具 verify_quote：从指定网页里抓出与关键词相关的**原句**。
//      为什么需要它：web_search 返回的摘要是机器生成的，经常与正文不一致；
//      web_fetch 会把整页塞进上下文，贵且噪声大。核对"这个页面到底有没有这么说"时，
//      只需要那几句原话 —— 这正是判断信息真伪最短的一步。

let cfg = () => ({});
let httpFetch = null;

const DEFAULT_MAX_SNIPPETS = 4;
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_BYTES = 600000;

// ── 安全：只允许公网 http(s) ────────────────────────────────────────────
// 技能拿到的 api.fetch 是**原始 globalThis.fetch**（核心的 SSRF 防护在 safe-fetch.js 里，
// 只作用于核心自己的联网工具），所以本工具必须自己挡一道：协议白名单 + 本机/内网字面 IP。
// 注意：这里只做字面判断，不做 DNS 解析级的防护（域名解析到内网的情况挡不住）——
// 本技能是本地用户自己装的，风险可接受；要更严就把它交给核心的 web 工具去做。
function checkUrl(raw) {
  let u;
  try { u = new URL(String(raw ?? '').trim()); } catch { return { error: 'URL 不合法' }; }
  if (!/^https?:$/.test(u.protocol)) return { error: '只支持 http/https 链接' };
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1') {
    return { error: '不允许访问本机地址' };
  }
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    const isPrivate = a === 0 || a === 10 || a === 127
      || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
    if (isPrivate) return { error: '不允许访问内网/本机地址' };
  }
  return { url: u };
}

async function fetchText(url, timeoutMs, maxBytes) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await httpFetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'QQAgent/verify-first (+local)', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' }
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const ctype = String(res.headers?.get?.('content-type') || '');
    if (ctype && !/text\/|html|json|xml|plain/i.test(ctype)) {
      return { error: `这不是文本页面（Content-Type: ${ctype}）` };
    }
    let text = '';
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const dec = new TextDecoder('utf-8');
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value?.byteLength ?? 0;
        text += dec.decode(value, { stream: true });
        if (got >= maxBytes) { try { await reader.cancel(); } catch { /* 截断即可 */ } break; }
      }
      text += dec.decode();
    } else {
      text = await res.text();
      if (text.length > maxBytes) text = text.slice(0, maxBytes);
    }
    return { text, truncated: text.length >= maxBytes };
  } catch (error) {
    const msg = error?.name === 'AbortError' ? `超时（${timeoutMs}ms）` : (error?.message ?? String(error));
    return { error: `抓取失败：${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

// ── HTML → 纯文本 ───────────────────────────────────────────────────────
function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|dd|dt)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/[ \t\u00a0\u3000]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sentencesOf(text) {
  const out = [];
  let buf = '';
  for (const ch of text) {
    buf += ch;
    if (ch === '。' || ch === '！' || ch === '？' || ch === '!' || ch === '?' || ch === '\n') {
      const s = buf.trim();
      if (s) out.push(s);
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function splitKeywords(raw) {
  return String(raw ?? '')
    .split(/[、,，;；/|\s]+/)
    .map((s) => s.trim())
    // 丢掉单字母/单数字的拉丁词（"Judge C" 拆出来的 C 只会制造噪声）；
    // 单个汉字要保留 —— 「性」这种黑话本身就是一整个词。
    .filter((s) => s && !(/^[\x00-\x7f]+$/.test(s) && s.length < 2))
    .slice(0, 8);
}

export function setup(api) {
  cfg = api.config;
  httpFetch = typeof api.fetch === 'function' ? (...args) => api.fetch(...args) : null;

  api.registerTool({
    id: 'verify_quote',
    name: '核对网页原文',
    description: '从指定网页里抓出与关键词相关的**原句**，用来确认「这个页面到底有没有这么说」。当你从搜索结果拿到的摘要、或者别人转述的说法需要核实时使用（摘要经常与正文不一致）。参数 url 是要核对的网页地址，keywords 用「、」分隔 1~4 个关键词。返回的是页面里真实出现的原句；如果一处都没命中，说明这个页面里没有这些内容，不要把它当成证据。',
    category: 'web',
    icon: '🔎',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要核对的网页地址（http/https）' },
        keywords: { type: 'string', description: '要核对的关键词，用「、」分隔，例如「判定窗口、毫秒」' },
        count: { type: 'number', description: '最多返回几处原句，1~8，默认用设置里的值' }
      },
      required: ['url', 'keywords']
    },
    async execute(_ctx, args) {
      const c = cfg() || {};
      if (!httpFetch) return { content: '未启用网络权限（web_fetch），无法核对网页。', isError: true };

      const checked = checkUrl(args?.url);
      if (checked.error) return { content: `无法核对：${checked.error}`, isError: true };
      const url = checked.url.href;

      const keywords = splitKeywords(args?.keywords);
      if (!keywords.length) return { content: '缺少 keywords：告诉我核对哪些词。', isError: true };

      const timeoutMs = Math.min(30000, Math.max(1000, Number(c.timeoutMs) || DEFAULT_TIMEOUT_MS));
      const maxBytes = Math.min(5_000_000, Math.max(50_000, Number(c.maxBytes) || DEFAULT_MAX_BYTES));
      const want = Math.min(8, Math.max(1, Number(args?.count) || Number(c.maxSnippets) || DEFAULT_MAX_SNIPPETS));

      const got = await fetchText(url, timeoutMs, maxBytes);
      if (got.error) return { content: `核对失败：${got.error}。可以换一个来源，或改用别的关键词。`, isError: true };

      const isHtml = /<\s*(html|body|div|p|span|a|li)\b/i.test(got.text.slice(0, 2000));
      const plain = isHtml ? htmlToText(got.text) : got.text;
      const sentences = sentencesOf(plain);
      if (!sentences.length) return { content: '这个页面没抓到可读文本（可能是纯图片或需要登录）。换一个来源试试。', isError: true };

      // 打分：关键词命中次数 + 关键词长度（长词更具体、更有说服力）
      const lower = sentences.map((s) => s.toLowerCase());
      const keys = keywords.map((k) => ({ raw: k, low: k.toLowerCase(), w: 1 + Math.min(4, k.length) }));
      const scored = [];
      sentences.forEach((s, i) => {
        let score = 0;
        const hitWords = [];
        for (const k of keys) {
          if (!k.low) continue;
          const n = lower[i].split(k.low).length - 1;
          if (n > 0) { score += n * k.w; hitWords.push(k.raw); }
        }
        // 太长/太短的句子都不是好证据
        if (score > 0 && s.length > 400) score *= 0.5;
        if (score > 0) scored.push({ i, score, hitWords, text: s });
      });
      scored.sort((a, b) => b.score - a.score);

      if (!scored.length) {
        return {
          content: `没有命中：这个页面里没有出现「${keywords.join('、')}」相关的句子。`
            + `\n→ 说明该页面很可能并没有这么说，别把它当作证据；换个来源或换关键词再核对。`
            + `\n（已读取约 ${Math.round(plain.length / 1000)}K 字${got.truncated ? '，页面过长已截断' : ''}）`
        };
      }

      // 取前 N 处，并带上相邻一句作为上下文（上下文能防止断章取义）
      const picked = [];
      const used = new Set();
      for (const h of scored) {
        if (picked.length >= want) break;
        if (used.has(h.i)) continue;
        used.add(h.i);
        const ctx = [];
        for (const j of [h.i - 1, h.i, h.i + 1]) {
          if (j < 0 || j >= sentences.length) continue;
          if (j !== h.i && used.has(j)) continue;
          ctx.push(sentences[j]);
          used.add(j);
        }
        picked.push(ctx.join(' '));
      }

      const body = picked.map((t, i) => `${i + 1}. ${t}`).join('\n');
      return {
        content: `在页面里命中 ${scored.length} 处（关键词：${keywords.join('、')}）：\n\n${body}\n\n`
          + `（以上是页面原文，不是摘要。回答可以基于它们；如需更多证据，换关键词再核对一次。已读取约 ${Math.round(plain.length / 1000)}K 字${got.truncated ? '，页面过长已截断' : ''}）`
      };
    }
  });
}

/** 自检：没有网络权限时明确报出来，而不是让工具变成哑巴。 */
export function available() {
  if (!httpFetch) return { ok: false, reason: '缺少 web_fetch 权限（清单里的 permissions 被删了？）' };
  return true;
}
