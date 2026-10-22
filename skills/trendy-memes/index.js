// 网络流行梗知识库（trendy-memes）。
//
// ── 为什么是技能（skills/）而不是插件（plugins/） ──────────────────────────
// 「这个梗什么意思」「现在该不该接这句话」只能靠模型理解人话来判断，
// 规则写不死。插件的定义是"条件满足必跑"，而这里恰恰没有一条能写死的触发条件。
// 所以做成技能：注册工具进 function 列表，用不用、什么时候用，由模型自己判断。
//
// ── 它真正解决的问题 ──────────────────────────────────────────────────────
// 模型的训练知识有截止时间，近一两年新火的梗最容易记漏或记串。
// 硬猜出来的意思比不认识更尴尬，所以规则第一条就是**先查再用**。
//
// ── 两层知识库 ────────────────────────────────────────────────────────────
//   1. 自带底稿  <本技能目录>/kb/*.json        —— 随技能发布，记事本可改，存盘即生效
//   2. 自学习    <DATA_DIR>/trendy-memes/user-added.json —— 唯一会被写入的文件
//      机器人查明白一个新梗后自己记进来，下次不用再联网 —— 库会自己跟上时代。
//
// ⚠️ DATA_DIR 不能按本目录推算：它会被 QQ_AGENT_DATA_DIR / QQ_AGENT_PROFILE 重定向
//    （本机就跑在安装根目录的 data/ 下，而不是 resources/app/data/）。
//    自己拼路径会把状态写到一个没人看的角落 —— 这里优先读环境变量，与 rhythm-kb 同款。
//
// ⚠️ 本文件在 resources/app 里，应用自动更新会覆盖；装回来即可（自学习库在 data/ 下不受影响）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..', '..');
const DATA_DIR = process.env.QQ_AGENT_DATA_DIR || path.join(APP_ROOT, 'data');
const USER_DIR = path.join(DATA_DIR, 'trendy-memes');
const USER_FILE = path.join(USER_DIR, 'user-added.json');
const KB_DIR = path.join(HERE, 'kb');
const MAX_ENTRIES = 500;

let cfg = () => ({});

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(n) || lo)));

/* ── 载入 ────────────────────────────────────────────────────────────── */

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function entriesOf(raw, source) {
  const list = Array.isArray(raw) ? raw : (raw?.entries || []);
  return list
    .filter((e) => e && e.title)
    .map((e) => ({
      title: String(e.title),
      aliases: Array.isArray(e.aliases) ? e.aliases.map(String) : [],
      meaning: String(e.meaning || ''),
      usage: String(e.usage || ''),
      tone: String(e.tone || ''),
      era: String(e.era || ''),
      freshness: String(e.freshness || ''),
      tags: Array.isArray(e.tags) ? e.tags.map(String) : [],
      source,
    }));
}

let cache = null;
/** 底稿 + 自学习库合并。带内存缓存，写入后由 invalidate() 清掉。 */
function loadAll() {
  if (cache) return cache;
  const out = [];
  try {
    for (const name of fs.readdirSync(KB_DIR).filter((n) => n.endsWith('.json')).sort()) {
      out.push(...entriesOf(readJson(path.join(KB_DIR, name)), `底稿 ${name}`));
    }
  } catch { /* 底稿目录读不到：只靠自学习库也能工作 */ }
  out.push(...entriesOf(readJson(USER_FILE), '自学习'));
  cache = out;
  return out;
}

function invalidate() { cache = null; }

/* ── 检索 ────────────────────────────────────────────────────────────── */

function normText(s) {
  return String(s ?? '').toLowerCase().replace(/\s+/g, '');
}

/**
 * 打分检索。梗库和音游库不同：这里**别名比正文重要** ——
 * 同一个梗常有七八种写法（yyds / 永远的神 / 永远滴神），漏了别名就等于查不到。
 */
function search(query, limit) {
  const entries = loadAll();
  const q = normText(query);
  if (!q) return [];

  const scored = [];
  for (const e of entries) {
    const title = normText(e.title);
    const aliases = e.aliases.map(normText);
    const body = normText(`${e.meaning}${e.usage}${e.tone}${e.era}${e.tags.join('')}`);
    let score = 0;

    if (title === q) score += 100;
    else if (aliases.includes(q)) score += 90;
    else if (title.includes(q) || q.includes(title)) score += 60;
    else if (aliases.some((a) => a && (a.includes(q) || q.includes(a)))) score += 50;
    if (q.length >= 2 && body.includes(q)) score += 20;

    // 兜底：中文口语里常把梗嵌在长句中间（「你这就有点抽象了」），
    // 逐字覆盖率够高也算命中，但给低分，保证排在精确命中之后。
    if (!score && q.length >= 2) {
      const chars = [...new Set([...q])].filter((c) => /[\u4e00-\u9fa5a-z0-9]/.test(c));
      if (chars.length >= 2) {
        const hits = chars.filter((c) => title.includes(c) || body.includes(c)).length;
        if (hits / chars.length >= 0.8) score += 10;
      }
    }

    if (score > 0) scored.push({ e, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.e);
}

function formatEntry(e) {
  const lines = [`【${e.title}】`];
  if (e.aliases.length) lines.push(`别名：${e.aliases.join('、')}`);
  if (e.meaning) lines.push(`意思：${e.meaning}`);
  if (e.usage) lines.push(`怎么用：${e.usage}`);
  const meta = [
    e.tone && `语气：${e.tone}`,
    e.era && `流行于：${e.era}`,
    e.freshness && `当下：${e.freshness}`,
  ].filter(Boolean);
  if (meta.length) lines.push(meta.join(' ｜ '));
  return lines.join('\n');
}

/* ── 入口 ────────────────────────────────────────────────────────────── */

export function setup(api) {
  cfg = api.config;

  api.registerTool({
    id: 'lookup',
    name: '查网络梗',
    description: '查询本地网络流行梗库。群里出现不确定的网络梗、新词、缩写时先查这里，再决定怎么接话。参数 term 填那个梗本身或它的写法，例如「尊嘟假嘟」「yyds」「city不city」「偷感」。查不到会返回现有目录，并提示你改用 web_search 联网查 —— 不要因此硬猜意思。',
    category: 'knowledge',
    icon: '🔍',
    parameters: {
      type: 'object',
      properties: {
        term: { type: 'string', description: '要查的梗、新词或缩写，例如「尊嘟假嘟」「栓Q」「么喽」' },
        limit: { type: 'number', description: '最多返回几条，1~5，默认用设置里的值' },
      },
      required: ['term'],
    },
    async execute(_ctx, args) {
      const c = cfg() || {};
      const term = String(args?.term ?? '').trim();
      if (!term) return { content: '缺少 term：告诉我要查哪个梗。', isError: true };

      const maxLimit = clamp(Number(c.maxResults) || 3, 1, 5);
      const limit = clamp(Number(args?.limit) || maxLimit, 1, 5);
      const hits = search(term, limit);

      if (!hits.length) {
        const all = loadAll();
        const idxLimit = clamp(Number(c.indexLimit) || 30, 5, 80);
        const names = all.slice(0, idxLimit).map((e) => e.title);
        const tail = all.length > names.length ? `…等共 ${all.length} 条` : '';
        return {
          content: `梗库里没有「${term}」相关的条目。`
            + (names.length ? `现有条目：${names.join('、')}${tail}。` : '梗库目前是空的。')
            + '下一步：用 web_search 搜「' + term + ' 是什么梗」或「' + term + ' 什么意思」，'
            + '有结果再用 web_fetch 读正文。**不要凭印象编一个意思**；真查不到就如实说不确定。',
        };
      }

      const body = hits.map(formatEntry).join('\n\n---\n\n');
      return {
        content: `命中 ${hits.length} 条：\n\n${body}\n\n`
          + '（回话时只取相关的一两句；标了「偏旧」的别当新梗用。'
          + '底稿可能过时，若这个梗听起来是近期新火的、而条目里没有近期信息，可再用 web_search 核对一次。）',
      };
    },
  });

  api.registerTool({
    id: 'index',
    name: '梗库目录',
    description: '列出网络梗库里已有的条目。用在：想知道库里覆盖了哪些梗，或者刚被问到的问题查不到、需要如实告诉对方库里有什么。可用 keyword 只看含这个词的条目。',
    category: 'knowledge',
    icon: '📚',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '可选：只看标题/别名/标签里含这个词的条目' },
      },
    },
    async execute(_ctx, args) {
      const c = cfg() || {};
      const keyword = normText(args?.keyword ?? '');
      let all = loadAll();
      if (keyword) {
        all = all.filter((e) => normText(e.title).includes(keyword)
          || e.aliases.some((a) => normText(a).includes(keyword))
          || e.tags.some((t) => normText(t).includes(keyword)));
      }
      if (!all.length) {
        return { content: keyword ? `梗库里没有含「${args.keyword}」的条目。` : '梗库目前是空的。' };
      }
      const limit = clamp(Number(c.indexLimit) || 30, 5, 80);
      const shown = all.slice(0, limit);
      const lines = shown.map((e) => {
        const mark = e.freshness ? `（${e.freshness}）` : '';
        return `· ${e.title}${mark}${e.meaning ? `：${e.meaning.slice(0, 30)}` : ''}`;
      });
      const tail = all.length > shown.length ? `\n…还有 ${all.length - shown.length} 条没列出。` : '';
      return { content: `梗库共 ${all.length} 条：\n${lines.join('\n')}${tail}` };
    },
  });

  api.registerTool({
    id: 'remember',
    name: '收录网络梗',
    description: '把一个查明白的网络梗写进本地梗库（data\\trendy-memes\\user-added.json），下次不用再联网查。只在**确实学到**一个库里没有的梗、并且判断以后还会用到时使用；不要每句话都记。参数 title 是梗本身，meaning 是一句话意思，usage 是怎么用、什么时候用。',
    category: 'knowledge',
    icon: '💾',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '梗本身，例如「尊嘟假嘟」' },
        meaning: { type: 'string', description: '一句话说明它的意思' },
        usage: { type: 'string', description: '怎么用、什么场合用，可举例句' },
        aliases: { type: 'string', description: '可选：其他写法，逗号分隔，例如「yyds,永远的神」' },
        era: { type: 'string', description: '可选：大概哪年/哪阵子火的' },
        tags: { type: 'string', description: '可选：标签，逗号分隔，例如「谐音,卖萌」' },
      },
      required: ['title', 'meaning'],
    },
    async execute(_ctx, args) {
      const c = cfg() || {};
      if (c.allowTeach === false) {
        return { content: '当前设置不允许收录（「允许机器人自己收录新梗」是关的），请直接回答，不要尝试写入。', isError: true };
      }
      const title = String(args?.title ?? '').trim();
      const meaning = String(args?.meaning ?? '').trim();
      if (!title || !meaning) return { content: '缺少 title 或 meaning，无法收录。', isError: true };

      const splitList = (raw) => String(raw ?? '').split(/[,，、;；]+/).map((s) => s.trim()).filter(Boolean);
      const current = entriesOf(readJson(USER_FILE), '自学习');

      // 同名的直接覆盖（同一个梗被记两次时会更新，而不是堆两条）
      const idx = current.findIndex((e) => normText(e.title) === normText(title)
        || e.aliases.some((a) => normText(a) === normText(title)));
      const entry = {
        title,
        aliases: splitList(args?.aliases),
        meaning,
        usage: String(args?.usage ?? '').trim(),
        era: String(args?.era ?? '').trim(),
        freshness: '自学习',
        tags: splitList(args?.tags),
      };
      if (idx >= 0) current[idx] = { ...current[idx], ...entry, aliases: [...new Set([...current[idx].aliases, ...entry.aliases])] };
      else current.push(entry);

      if (current.length > MAX_ENTRIES) {
        return {
          content: `自学习库已达上限 ${MAX_ENTRIES} 条，请先整理 ${USER_FILE} 再收录。`,
          isError: true,
        };
      }

      try {
        fs.mkdirSync(USER_DIR, { recursive: true });
        fs.writeFileSync(USER_FILE, JSON.stringify({ entries: current }, null, 2), 'utf8');
        invalidate();
      } catch (error) {
        return { content: `写入梗库失败：${error?.message ?? error}（不影响本次回答）`, isError: true };
      }
      return {
        content: `${idx >= 0 ? '已更新' : '已收录'}「${title}」，梗库现有 ${current.length} 条自学习条目。`
          + '（不要向群友报告收录这个动作，继续正常聊天即可。）',
      };
    },
  });
}

export function available() { return { ok: true }; }

/** 自测用（不注册工具，直接调这些函数即可）。 */
export const internals = {
  loadAll,
  search,
  formatEntry,
  normText,
  invalidate,
  paths: { USER_DIR, USER_FILE, KB_DIR, DATA_DIR },
};
