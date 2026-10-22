// 明日方舟数据库（ark-db）
//
// 接 prts.wiki（PRTS 明日方舟中文 wiki）的实时查询技能。
//   ark_operator  干员卡（星级/职业·分支/阵营/特性/天赋/技能/精英化材料/潜能）
//   ark_nick      外号 → 干员 / 黑话 → 词条（本地库，零延迟）
//   ark_search    全站搜索页面标题
//   ark_page      任意页面正文摘要（活动/机制/剧情/黑话）
//   ark_sync      重建干员索引与黑话索引
//
// 数据来源：https://prts.wiki/api.php（MediaWiki，formatversion=2）
// 干员页结构：{{CharinfoV2}} + {{属性}} + {{天赋列表3}} + {{技能2}}×N + {{精英化材料}} + {{潜能提升}}
// 黑话页：命名空间前缀「明日方舟黑话·梗·成句/」

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// 数据放在应用根目录的 data/ark-db（不是在 skills/ 里）——技能目录被热重载监听，
// 每次写缓存都会触发「检测到变化，重新扫描」，把数据挪出去就不会自己叫醒自己。
const DATA_DIR = path.resolve(ROOT, '../../../../data/ark-db');
const CACHE_FILE = path.join(DATA_DIR, 'cache.json');
const OPERATORS_FILE = path.join(DATA_DIR, 'operators.json');
const SLANG_FILE = path.join(DATA_DIR, 'slang.json');
const NICK_FILE = path.join(DATA_DIR, 'nicknames.json');

const API = 'https://prts.wiki/api.php';
const WIKI = 'https://prts.wiki/w/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) QQAgent-arkdb/1.0';

const CLASS_CN = {
  '\u5148\u950b': '先锋', '\u8fd1\u536b': '近卫', '\u91cd\u88c5': '重装', '\u72d9\u51fb': '狙击',
  '\u672f\u5e08': '术师', '\u533b\u7597': '医疗', '\u8f85\u52a9': '辅助', '\u7279\u79cd': '特种',
};

// ── 小工具 ───────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cfg = {};
let log = () => {};
let lastRequestAt = 0;

function minGapMs() {
  return Math.max(300, Number(cfg?.minGapMs) || 900);
}

function cleanInline(value) {
  let s = String(value ?? '');
  s = s.replace(/<br\s*\/?>/gi, ' ');
  s = s.replace(/<\/(del|s|span|div|p)>/gi, '');
  s = s.replace(/<(del|s|span|div|p)[^>]*>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/'''/g, '').replace(/''/g, '');
  return s.replace(/\s+/g, ' ').trim();
}

// 去掉 wiki 标记：{{color|#xxx|文字}}→文字、[[a|b]]→b、模板里的参数串
function stripMarkup(value) {
  let s = String(value ?? '');
  for (let guard = 0; guard < 6; guard++) {
    const before = s;
    s = s.replace(/\{\{\s*color\s*\|[^|{}]*\|([^{}]*)\}\}/gi, '$1');
    // {{*|5%|+5%}} / {{**|30%|-70%}} / {{+|30|+30}} / {{-|30|-30}} → 取显示值
    s = s.replace(/\{\{\s*(\*+|\+|-)\s*\|[^|{}]*\|([^{}]*)\}\}/gi, '$2');
    s = s.replace(/\{\{\s*\+\s*\|[^|{}]*\|([^{}]*)\}\}/gi, '$1');
    s = s.replace(/\{\{\s*-\s*\|[^|{}]*\|([^{}]*)\}\}/gi, '$1');
    s = s.replace(/\{\{\s*修正\s*\|([^|{}]*)[^{}]*\}\}/gi, '$1');
    s = s.replace(/\{\{\s*术语\s*\|[^|{}]*\|([^{}]*)\}\}/gi, '$1');
    s = s.replace(/\{\{\s*注\s*\|([^{}]*)\}\}/gi, '$1');
    s = s.replace(/\{\{\s*(?:color|数值|变动数值lite|变动数值)\s*\|([^{}]*)\}\}/gi, '');
    if (s === before) break;
  }
  s = s.replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1');
  s = s.replace(/\[\[([^\]]*)\]\]/g, '$1');
  s = s.replace(/\[https?:\/\/[^\s\]]+\s*([^\]]*)\]/g, '$1');
  s = s.replace(/\{\{[^{}]*\}\}/g, '');
  return cleanInline(s);
}

async function apiGet(params) {
  const url = new URL(API);
  const base = { format: 'json', formatversion: '2', ...params };
  for (const [k, v] of Object.entries(base)) url.searchParams.set(k, String(v));
  for (let attempt = 0; attempt < 3; attempt++) {
    const gap = lastRequestAt + minGapMs() - Date.now();
    if (gap > 0) await sleep(gap);
    lastRequestAt = Date.now();
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'application/json' },
        signal: AbortSignal.timeout(Number(cfg?.timeoutMs) || 15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (error) {
      if (attempt === 2) throw error;
      await sleep(800 * (attempt + 1));
    }
  }
  return {};
}

function link(title) {
  return WIKI + encodeURIComponent(String(title ?? '').replace(/ /g, '_'));
}

// ── 缓存 ─────────────────────────────────────────────────────────────

let cache = { pages: {}, searches: {} };

function loadCache() {
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    cache = { pages: {}, searches: {} };
  }
  if (!cache.pages) cache.pages = {};
  if (!cache.searches) cache.searches = {};
}

function saveCache() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const pages = Object.entries(cache.pages)
      .sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0))
      .slice(0, Number(cfg?.maxCachePages) || 240);
    const searches = Object.entries(cache.searches)
      .sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0))
      .slice(0, 120);
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ pages: Object.fromEntries(pages), searches: Object.fromEntries(searches) }));
  } catch {
    /* 缓存写失败不影响查询 */
  }
}

async function getPage(title) {
  const key = String(title ?? '').trim();
  if (!key) return null;
  const hit = cache.pages[key];
  if (hit && Date.now() - Number(hit.at || 0) < 86400000) return hit;
  const json = await apiGet({
    action: 'query',
    prop: 'revisions',
    rvprop: 'content',
    rvslots: 'main',
    titles: key,
    redirects: '1',
  });
  const page = json?.query?.pages?.[0];
  if (!page) return null;
  const result = {
    title: page.title,
    missing: Boolean(page.missing),
    content: page?.revisions?.[0]?.slots?.main?.content || '',
    at: Date.now(),
  };
  cache.pages[key] = result;
  saveCache();
  return result;
}

async function searchPages(query, limit = 6) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  const cacheKey = `${q}::${limit}`;
  const hit = cache.searches[cacheKey];
  if (hit && Date.now() - Number(hit.at || 0) < 21600000) return hit.hits || [];
  const json = await apiGet({
    action: 'query',
    list: 'search',
    srsearch: q,
    srlimit: String(Math.max(1, Math.min(10, limit))),
    srprop: 'snippet',
  });
  const hits = (json?.query?.search || []).map((item) => ({
    title: item.title,
    snippet: cleanInline(String(item.snippet || '').replace(/<[^>]+>/g, '')),
  }));
  cache.searches[cacheKey] = { hits, at: Date.now() };
  saveCache();
  return hits;
}

// ── wikitext 解析 ────────────────────────────────────────────────────

// 找到「{{name」之后第一个配平的模板块
function extractTemplate(content, name) {
  const all = findTemplates(content, name);
  return all[0] || '';
}

function findTemplates(content, name) {
  const out = [];
  const text = String(content ?? '');
  const needle = `{{${name}`;
  let from = 0;
  for (;;) {
    const start = text.indexOf(needle, from);
    if (start < 0) break;
    // 从该模板自己的 {{ 开始记深度：这样内部嵌套的 {{color}} 不会把块提前截断
    let depth = 0;
    let i = start;
    for (; i < text.length; i++) {
      if (text[i] === '{' && text[i + 1] === '{') {
        depth++;
        i++;
        continue;
      }
      if (text[i] === '}' && text[i + 1] === '}') {
        depth--;
        i++;
        if (depth === 0) {
          i++;
          break;
        }
        continue;
      }
    }
    out.push(text.slice(start, Math.min(i, text.length)));
    from = Math.max(i, start + needle.length);
  }
  return out;
}

// 顶层按 | 切分（尊重 {{}} 与 [[]] 嵌套）
function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let bracket = 0;
  let buf = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '{' && body[i + 1] === '{') {
      depth++;
      buf += '{{';
      i++;
      continue;
    }
    if (c === '}' && body[i + 1] === '}') {
      depth = Math.max(0, depth - 1);
      buf += '}}';
      i++;
      continue;
    }
    if (c === '[' && body[i + 1] === '[') {
      bracket++;
      buf += '[[';
      i++;
      continue;
    }
    if (c === ']' && body[i + 1] === ']') {
      bracket = Math.max(0, bracket - 1);
      buf += ']]';
      i++;
      continue;
    }
    if (c === '|' && depth === 0 && bracket === 0) {
      parts.push(buf);
      buf = '';
      continue;
    }
    buf += c;
  }
  parts.push(buf);
  return parts;
}

function parseTemplateParams(block, name) {
  const body = String(block ?? '').replace(/^\{\{\s*[^|}\n]*\s*/, '').replace(/\}\}\s*$/, '');
  const params = {};
  let positional = 0;
  for (const part of splitTopLevel(body)) {
    if (!part.includes('=') && part.trim() && !/^[^=]*$/.test(part)) {
      params[String(++positional)] = part.trim();
      continue;
    }
    const idx = part.indexOf('=');
    if (idx < 0) {
      if (part.trim()) params[String(++positional)] = part.trim();
      continue;
    }
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    params[key] = value;
  }
  return params;
}

// ── 索引：干员 / 黑话 / 外号 ─────────────────────────────────────────

let OPERATORS = null;
let SLANG = null;
let NICKS = null;
let building = null;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  } catch (error) {
    log(`[ark] 写文件失败 ${path.basename(file)}：${error?.message ?? error}`);
  }
}

function loadOperators() {
  if (OPERATORS) return OPERATORS;
  OPERATORS = readJson(OPERATORS_FILE, null);
  return OPERATORS;
}

function loadSlang() {
  if (SLANG) return SLANG;
  SLANG = readJson(SLANG_FILE, null);
  return SLANG;
}

// 社区常用外号（可手改，重装不会覆盖：只在文件不存在时写入）
const DEFAULT_NICKS = {
  老板: ['银灰'],
  大老板: ['银灰'],
  塞爹: ['塞雷娅'],
  爹: ['塞雷娅'],
  驴: ['阿米娅'],
  小驴: ['阿米娅'],
  '42': ['史尔特尔'],
  '42姐': ['史尔特尔'],
  小羊: ['艾雅法拉'],
  羊: ['艾雅法拉'],
  能天使: ['能天使'],
  能: ['能天使'],
  陈sir: ['陈'],
  龙陈: ['陈'],
  老爷子: ['赫拉格'],
  银老板: ['银灰'],
  玫兰莎: ['玫兰莎'],
  玫剑圣: ['玫兰莎'],
  德狗: ['德克萨斯'],
  凛冬: ['凛冬'],
  推王: ['推进之王'],
  星熊: ['星熊'],
  白面鸮: ['白面鸮'],
  夜莺: ['夜莺'],
  闪灵: ['闪灵'],
  闪剑圣: ['闪灵'],
  幽灵鲨: ['幽灵鲨'],
  棘刺: ['棘刺'],
  鸡翅: ['棘刺'],
  温蒂: ['温蒂'],
  空弦: ['空弦'],
  小刻: ['刻俄柏'],
  刻俄柏: ['刻俄柏'],
  莫斯提马: ['莫斯提马'],
  年: ['年'],
  夕: ['夕'],
  令: ['令'],
  重岳: ['重岳'],
  凯尔希: ['凯尔希'],
  凯爹: ['凯尔希'],
  M3: ['凯尔希'],
  水月: ['水月'],
  絮雨: ['絮雨'],
  迷迭香: ['迷迭香'],
  号角: ['号角'],
  菲亚梅塔: ['菲亚梅塔'],
  林雨霞: ['林'],
  老陈: ['陈'],
  老银: ['银灰'],
  雷神: ['雷蛇'],
  天火: ['天火'],
  芙蓉: ['芙蓉'],
  红豆: ['红豆'],
  蓝毒: ['蓝毒'],
  黑: ['黑'],
  赫默: ['赫默'],
  华法琳: ['华法琳'],
  拉普兰德: ['拉普兰德'],
  拉狗: ['拉普兰德'],
  崖心: ['崖心'],
  岚: ['岚'],
  蜜蜡: ['蜜蜡'],
  食铁兽: ['食铁兽'],
  斥罪: ['斥罪'],
  泥岩: ['泥岩'],
  帕拉斯: ['帕拉斯'],
  归溟幽灵鲨: ['归溟幽灵鲨'],
  号令: ['号角'],
  玛恩纳: ['玛恩纳'],
  叔叔: ['玛恩纳'],
  龙腾: ['龙腾'],
  燃灰: ['燃灰'],
  迷彩: ['迷彩'],
  乌有: ['乌有'],
};

function loadNicks() {
  if (NICKS) return NICKS;
  const existing = readJson(NICK_FILE, null);
  if (existing && typeof existing === 'object') {
    NICKS = existing;
    return NICKS;
  }
  NICKS = DEFAULT_NICKS;
  writeJson(NICK_FILE, NICKS);
  return NICKS;
}

function normKey(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s·・.。'"“”‘’（）()\[\]【】]/g, '');
}

function indexAgeDays(data) {
  const at = Number(data?.updatedAt || 0);
  if (!at) return Infinity;
  return (Date.now() - at) / 86400000;
}

async function listCategory(category, limit = 2000) {
  const titles = [];
  let cont = null;
  do {
    const params = { action: 'query', list: 'categorymembers', cmtitle: category, cmlimit: '500', cmnamespace: '0' };
    if (cont) params.cmcontinue = cont;
    const json = await apiGet(params);
    for (const m of json?.query?.categorymembers || []) titles.push(m.title);
    cont = json?.continue?.cmcontinue || null;
  } while (cont && titles.length < limit);
  return [...new Set(titles)];
}

async function listAllPages(prefix, limit = 500) {
  const titles = [];
  let cont = null;
  do {
    const params = { action: 'query', list: 'allpages', apprefix: prefix, aplimit: '500', apnamespace: '0' };
    if (cont) params.apcontinue = cont;
    const json = await apiGet(params);
    for (const m of json?.query?.allpages || []) titles.push(m.title);
    cont = json?.continue?.apcontinue || null;
  } while (cont && titles.length < limit);
  return titles;
}

async function buildOperatorIndex({ reason = 'manual' } = {}) {
  if (building) return building;
  building = (async () => {
    const t0 = Date.now();
    const titles = (await listCategory('Category:干员')).filter((t) => !/\/spine$/i.test(t));
    const operators = [];
    for (let i = 0; i < titles.length; i += 40) {
      const batch = titles.slice(i, i + 40);
      let json;
      try {
        json = await apiGet({
          action: 'query',
          prop: 'revisions',
          rvprop: 'content',
          rvslots: 'main',
          titles: batch.join('|'),
        });
      } catch (error) {
        log(`[ark] 索引批次 ${i} 失败：${error?.message ?? error}`);
        continue;
      }
      for (const page of json?.query?.pages || []) {
        if (!page || page.missing) continue;
        const content = page?.revisions?.[0]?.slots?.main?.content || '';
        const blocks = findTemplates(content, 'CharinfoV2');
        if (!blocks.length) continue;
        const p = parseTemplateParams(blocks[0], 'CharinfoV2');
        const stat = parseTemplateParams(extractTemplate(content, '属性') || '', '属性');
        operators.push({
          title: page.title,
          name: stripMarkup(p['干员名'] || page.title),
          en: stripMarkup(p['干员外文名'] || ''),
          jp: stripMarkup(p['干员名jp'] || ''),
          cls: stripMarkup(p['职业'] || ''),
          branch: stripMarkup(p['分支'] || ''),
          rarity: Number(p['稀有度'] || 0) + 1,
          tags: stripMarkup(p['标签'] || ''),
          faction: stripMarkup(stat['所属势力'] || p['所属国家'] || ''),
          position: stripMarkup(p['位置'] || ''),
        });
      }
    }
    const data = { version: 1, updatedAt: Date.now(), count: operators.length, source: 'prts.wiki Category:干员', operators };
    writeJson(OPERATORS_FILE, data);
    OPERATORS = data;
    log(`[ark] 干员索引已建立：${operators.length} 个（${reason}，${Math.round((Date.now() - t0) / 1000)}s）`);
    return data;
  })()
    .catch((error) => {
      log(`[ark] 建干员索引失败：${error?.message ?? error}`);
      return null;
    })
    .finally(() => {
      building = null;
    });
  return building;
}

async function buildSlangIndex({ reason = 'manual' } = {}) {
  const t0 = Date.now();
  const pages = await listAllPages('明日方舟黑话·梗·成句/');
  const items = pages
    .filter((t) => !/\/spine$/i.test(t))
    .map((title) => {
      const parts = title.split('/');
      return { title, term: parts[parts.length - 1] || title, group: parts[1] || '' };
    })
    .filter((x) => x.term);
  const data = { version: 1, updatedAt: Date.now(), count: items.length, items };
  writeJson(SLANG_FILE, data);
  SLANG = data;
  log(`[ark] 黑话索引已建立：${items.length} 条（${reason}，${Math.round((Date.now() - t0) / 1000)}s）`);
  return data;
}

// 外号/名字 → 干员
function resolveOperator(query) {
  const idx = loadOperators();
  const nicks = loadNicks();
  const q = normKey(query);
  if (!q) return null;

  const nicked = nicks[String(query ?? '').trim()] || Object.entries(nicks).find(([k]) => normKey(k) === q)?.[1];
  if (Array.isArray(nicked) && nicked.length) {
    const hit = (idx?.operators || []).find((o) => normKey(o.name) === normKey(nicked[0]));
    if (hit) return { ...hit, how: 'nickname' };
  }

  const list = idx?.operators || [];
  let hit = list.find((o) => normKey(o.name) === q || normKey(o.title) === q);
  if (hit) return { ...hit, how: 'name' };
  hit = list.find((o) => normKey(o.en) === q || normKey(o.jp) === q);
  if (hit) return { ...hit, how: 'foreign' };
  if (q.length >= 2) {
    hit = list.find((o) => normKey(o.name).includes(q) || q.includes(normKey(o.name)));
    if (hit) return { ...hit, how: 'fuzzy' };
  }
  return null;
}

function resolveSlang(term) {
  const idx = loadSlang();
  const q = normKey(term);
  if (!q) return null;
  const items = idx?.items || [];
  let hit = items.find((x) => normKey(x.term) === q);
  if (hit) return { ...hit, how: 'exact' };
  if (q.length >= 2) {
    hit = items.find((x) => normKey(x.term).includes(q) || q.includes(normKey(x.term)));
    if (hit) return { ...hit, how: 'fuzzy' };
  }
  return null;
}

function describeOperator(entry) {
  return [
    `「${entry.name}」`,
    entry.rarity ? `${'★'.repeat(Math.max(0, Math.min(6, Number(entry.rarity))))}` : '',
    [entry.cls, entry.branch].filter(Boolean).join('·'),
    entry.faction || '',
    entry.tags ? `标签：${entry.tags}` : '',
    entry.en ? entry.en : '',
  ]
    .filter(Boolean)
    .join('｜');
}

// ── 干员卡 ───────────────────────────────────────────────────────────

function hasOperatorBox(content) {
  return findTemplates(content, 'CharinfoV2').length > 0;
}

function materialsFromBlock(block) {
  const p = parseTemplateParams(block, '精英化材料');
  const out = [];
  for (const stage of ['精1', '精2']) {
    const raw = p[stage] || '';
    const items = [...raw.matchAll(/\{\{\s*材料消耗\s*\|([^|}]+)\|([^|}]+)/g)]
      .map((m) => `${stripMarkup(m[1])}×${stripMarkup(m[2])}`)
      .filter((s) => s && !s.startsWith('×'));
    if (items.length) out.push(`${stage}：${items.join('、')}`);
  }
  return out;
}

function parseTalents(content) {
  const block = extractTemplate(content, '天赋列表3') || extractTemplate(content, '天赋列表');
  if (!block) return [];
  const p = parseTemplateParams(block, '天赋列表3');
  // 同一个天赋会有「精英1 / 精英2 / 精英2 X模组2级」几条，按名字去重、留最高档
  const byName = new Map();
  for (const n of [1, 2, 3]) {
    const name = stripMarkup(p[`天赋${n}`]);
    if (!name || /^[?？——-]+$/.test(name)) continue;
    const cond = stripMarkup(p[`天赋${n}条件`]);
    const effect = stripMarkup(p[`天赋${n}效果`]);
    if (!effect) continue;
    const label = cond && cond !== '精英0' && cond !== '——' ? cond : '';
    byName.set(name, { name, label, effect });
  }
  return [...byName.values()].map(
    (t) => `${t.name}${t.label ? `（${t.label}）` : ''}：${t.effect.slice(0, 80)}`
  );
}

function parseSkills(content) {
  // 有的干员页用 {{技能2}}（带编号），有的只写 {{技能}}
  let blocks = findTemplates(content, '技能2');
  if (!blocks.length) blocks = findTemplates(content, '技能');
  const out = [];
  for (const block of blocks) {
    const p = parseTemplateParams(block, '技能');
    const name = stripMarkup(p['技能名']);
    if (!name) continue;
    const desc = stripMarkup(p['技能3描述'] || p['技能2描述'] || p['技能1描述'] || '');
    const type1 = stripMarkup(p['技能类型1'] || '');
    const type2 = stripMarkup(p['技能类型2'] || '');
    out.push({ name, meta: [type1, type2].filter(Boolean).join('/'), desc });
  }
  return out;
}

function parsePotential(content) {
  const block = extractTemplate(content, '潜能提升');
  if (!block) return [];
  const p = parseTemplateParams(block, '潜能提升');
  return [2, 3, 4, 5, 6].map((n) => {
    const v = stripMarkup(p[`潜能${n}`]);
    return v ? `潜${n}：${v}` : '';
  }).filter(Boolean);
}

async function buildOperatorCard(query) {
  const wanted = String(query ?? '').trim();
  if (!wanted) return { error: '要查哪个干员？把名字或外号给我（银灰 / 老板 / 42 / 小羊 都行）。' };

  const tried = new Set();
  const probe = async (title) => {
    const key = String(title ?? '').trim();
    if (!key || tried.has(key)) return null;
    tried.add(key);
    const page = await getPage(key);
    if (!page || page.missing) return null;
    return { page, usable: hasOperatorBox(page.content) };
  };

  let note = '';
  let page = null;
  let first = null;

  const idxHit = resolveOperator(wanted);
  if (idxHit) {
    const hit = await probe(idxHit.title);
    if (hit?.usable) {
      page = hit.page;
      if (idxHit.how !== 'name') note = `（「${wanted}」指的是${idxHit.name}）`;
    }
  }

  if (!page) {
    first = await probe(wanted);
    if (first?.usable) page = first.page;
  }

  if (!page) {
    const candidates = [];
    if (first?.page) {
      for (const m of String(first.page.content || '').matchAll(/\{\{参阅\|([^|}]+)/g)) candidates.push(m[1].trim());
    }
    const hits = await searchPages(wanted, 6);
    for (const h of hits) candidates.push(h.title);
    for (const cand of candidates) {
      const r = await probe(cand);
      if (r?.usable) {
        page = r.page;
        note = `（查的是「${page.title}」）`;
        break;
      }
    }
    if (!page) {
      const slang = resolveSlang(wanted);
      if (slang) {
        return {
          error: `「${wanted}」不是干员名，像是黑话/梗：「${slang.term}」（${slang.group}）。用 ark_page 读这条词条：`,
          hits: [{ title: slang.title }],
        };
      }
      const names = hits.map((h) => h.title).slice(0, 6);
      if (!names.length) return { error: `PRTS 上没搜到「${wanted}」。换个写法试试（代号/中文名/英文名）。` };
      return { error: `「${wanted}」没有干员面板（可能是同名页/活动/道具）。搜到的页面：`, hits };
    }
  }

  const content = page.content || '';
  const info = parseTemplateParams(findTemplates(content, 'CharinfoV2')[0], 'CharinfoV2');
  const stat = parseTemplateParams(extractTemplate(content, '属性'), '属性');
  const obtain = parseTemplateParams(extractTemplate(content, '干员获得方式'), '干员获得方式');

  const stars = Math.max(0, Math.min(6, Number(info['稀有度'] || 0) + 1));
  const name = stripMarkup(info['干员名'] || page.title);
  const cls = [stripMarkup(info['职业']), stripMarkup(info['分支'])].filter(Boolean).join('·');
  const rarity = `${'★'.repeat(stars)}${stars >= 6 ? '(6★)' : ''}`;

  const lines = [];
  lines.push(`【干员】${name}${note}`);
  const sub = [stripMarkup(info['干员外文名']), stripMarkup(info['干员名jp'])].filter(Boolean).join(' / ');
  if (sub) lines.push(sub);
  const meta = [rarity, cls, stripMarkup(info['位置']), stripMarkup(info['所属国家'])].filter(Boolean).join('｜');
  lines.push(meta);
  const tags = stripMarkup(info['标签']);
  if (tags) lines.push(`标签：${tags}`);
  const trait = stripMarkup(info['特性']);
  if (trait) lines.push(`特性：${trait}`);
  if (stat['再部署'] || stat['部署费用'] || stat['阻挡数']) {
    lines.push(
      `部署：再部署 ${stripMarkup(stat['再部署']) || '?'}｜费用 ${stripMarkup(stat['部署费用']) || '?'}｜阻挡 ${stripMarkup(stat['阻挡数']) || '?'}｜攻击间隔 ${stripMarkup(stat['攻击速度']) || '?'}`
    );
  }
  const hpBase = stripMarkup(stat['精英0_1级_生命上限']);
  const atkBase = stripMarkup(stat['精英0_1级_攻击']);
  const defBase = stripMarkup(stat['精英0_1级_防御']);
  const resBase = stripMarkup(stat['精英0_1级_法术抗性']);
  const hpMax = stripMarkup(stat['精英2_满级_生命上限'] || stat['精英1_满级_生命上限']);
  const atkMax = stripMarkup(stat['精英2_满级_攻击'] || stat['精英1_满级_攻击']);
  if (hpBase || atkBase) {
    lines.push(
      `面板：HP ${hpBase || '?'}→${hpMax || '?'}｜攻击 ${atkBase || '?'}→${atkMax || '?'}｜防御 ${defBase || '?'}｜法抗 ${resBase || '?'}`
    );
  }
  if (obtain['获得方式']) lines.push(`获得：${stripMarkup(obtain['获得方式'])}`);

  const talents = parseTalents(content);
  if (talents.length) {
    lines.push('天赋：');
    for (const t of talents) lines.push(`· ${t}`);
  }

  const skills = parseSkills(content);
  if (skills.length) {
    lines.push('技能：');
    for (const s of skills.slice(0, 3)) {
      const head = `· ${s.name}${s.meta ? `（${s.meta}）` : ''}`;
      lines.push(s.desc ? `${head}：${s.desc.slice(0, 90)}` : head);
    }
  }

  const mats = materialsFromBlock(extractTemplate(content, '精英化材料'));
  if (mats.length) {
    lines.push('精英化：');
    for (const m of mats) lines.push(`· ${m}`);
  }

  const pots = parsePotential(content);
  if (pots.length) lines.push(`潜能：${pots.join('；')}`);

  lines.push(`页面：${link(page.title)}`);

  let text = lines.join('\n');
  const maxChars = Number(cfg?.maxCardChars) || 1500;
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}…（截断）`;
  return { text, title: page.title };
}

// ── 页面摘要 ─────────────────────────────────────────────────────────

function removeTemplates(text) {
  let s = String(text ?? '');
  let out = '';
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{' && s[i + 1] === '{') {
      depth++;
      i++;
      continue;
    }
    if (s[i] === '}' && s[i + 1] === '}') {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    if (depth === 0) out += s[i];
  }
  return out;
}

function toPlainText(wikitext, maxChars) {
  let s = String(wikitext ?? '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/\{\{黑话头\}\}/g, '');
  s = removeTemplates(s);
  s = s.replace(/<gallery[\s\S]*?<\/gallery>/gi, '');
  s = s.replace(/\{\|[\s\S]*?\|\}/g, '');
  s = s.replace(/\[\[File:[^\]]*\]\]/gi, '');
  s = s.replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1');
  s = s.replace(/\[\[([^\]]*)\]\]/g, '$1');
  s = s.replace(/\[https?:\/\/[^\s\]]+\s*([^\]]*)\]/g, '$1');
  s = s.replace(/^=+\s*(.*?)\s*=+$/gm, '【$1】');
  s = s.replace(/'''/g, '').replace(/''/g, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/^[*#:;]+\s*/gm, '');
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.split('\n').map((l) => l.trim()).filter((l) => l && !/^\[\[?(分类|Category):/.test(l)).join('\n');
  s = s.trim();
  const cap = Math.max(200, Math.min(3000, Number(maxChars) || Number(cfg?.pageChars) || 800));
  if (s.length > cap) s = `${s.slice(0, cap)}…（后略）`;
  return s;
}

async function buildPageDigest(title, chars) {
  const wanted = String(title ?? '').trim();
  if (!wanted) return { error: '要读哪个页面？给个标题（可以用 ark_search 先找）。' };
  let page = await getPage(wanted);
  if (!page || page.missing) {
    // 「充电宝」「逃课」这种黑话在 PRTS 的完整标题是「明日方舟黑话·梗·成句/战斗术语/充电宝」
    const slang = resolveSlang(wanted);
    if (slang) {
      const slangPage = await getPage(slang.title);
      if (slangPage && !slangPage.missing) page = slangPage;
    }
  }
  if (!page || page.missing) {
    const hits = await searchPages(wanted, 6);
    if (!hits.length) return { error: `PRTS 上没有「${wanted}」这个页面，也没搜到相近的。` };
    return { error: `没找到「${wanted}」这个页面，可能是标题不准确。搜到的：`, hits };
  }
  const body = toPlainText(page.content, chars);
  if (!body) return { error: `「${page.title}」这个页面没有正文（可能只是模板/重定向页）。` };
  return { text: `【${page.title}】（PRTS）\n${body}\n页面：${link(page.title)}` };
}

// ── 工具注册 ─────────────────────────────────────────────────────────

export function setup(api) {
  cfg = typeof api.config === 'function' ? api.config : () => ({});
  log = (...a) => (typeof api.log === 'function' ? api.log(...a) : undefined);
  loadCache();
  loadNicks();
  const opIdx = loadOperators();
  const slangIdx = loadSlang();
  log(
    `明日方舟数据库已就绪（缓存 ${Object.keys(cache.pages || {}).length} 个页面，干员索引 ${opIdx?.count || 0}，黑话 ${slangIdx?.count || 0}）`
  );

  const staleOps = !opIdx?.operators?.length || indexAgeDays(opIdx) > 7;
  const staleSlang = !slangIdx?.items?.length || indexAgeDays(slangIdx) > 30;
  if (staleOps || staleSlang) {
    setTimeout(() => {
      (async () => {
        if (staleOps) await buildOperatorIndex({ reason: opIdx?.operators?.length ? '超过 7 天' : '首次建库' });
        if (staleSlang && !staleOps) await buildSlangIndex({ reason: '黑话索引刷新' });
      })().catch(() => {});
    }, 6000);
  } else {
    log(`干员索引 ${opIdx.count} 个（${indexAgeDays(opIdx).toFixed(1)} 天前更新）`);
  }

  api.registerTool({
    id: 'ark_operator',
    name: '查明日方舟干员',
    description:
      '按名字或外号查 PRTS（prts.wiki）的干员面板：星级、职业·分支、阵营、标签、特性、部署、面板数值、天赋、技能、精英化材料、潜能。'
      + '外号也行（银灰/老板、史尔特尔/42、艾雅法拉/小羊）。回答时挑关键的几项，别把整张卡念完。',
    category: 'knowledge',
    icon: '🛡️',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '干员代号或外号，例如「银灰」「老板」「42」「小羊」' }
      },
      required: ['name']
    },
    async execute(_ctx, args) {
      try {
        const r = await buildOperatorCard(args?.name);
        if (r.error) {
          const tail = r.hits?.length ? `\n${r.hits.map((h) => `- ${h.title}`).join('\n')}` : '';
          return { content: `${r.error}${tail}` };
        }
        return { content: r.text };
      } catch (error) {
        log(`[ark] 干员查询失败：${error?.message ?? error}`);
        return { content: `查 prts.wiki 失败了（${error?.message ?? error}）。可以过一会儿再试。` };
      }
    }
  });

  api.registerTool({
    id: 'ark_nick',
    name: '查明日方舟外号/黑话',
    description:
      '把群友嘴里的外号或黑话对到干员/词条：老板→银灰、42→史尔特尔、小羊→艾雅法拉、塞爹→塞雷娅；'
      + '黑话如「充电宝」「逃课」「七星干员」会给出 PRTS 的黑话词条页。本地库、零延迟，听到不认识的叫法先查这个。',
    category: 'knowledge',
    icon: '🏷️',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '听到的外号或黑话，例如「老板」「充电宝」「七星干员」' }
      },
      required: ['query']
    },
    async execute(_ctx, args) {
      const q = String(args?.query ?? '').trim();
      if (!q) return { content: '要查哪个称呼？' };
      try {
        const op = resolveOperator(q);
        const slang = resolveSlang(q);
        const parts = [];
        if (op) {
          parts.push(`干员：${describeOperator(op)}\n页面：${link(op.title)}`);
        }
        if (slang) {
          parts.push(`黑话/梗：「${slang.term}」${slang.group ? `（${slang.group}）` : ''}\n词条：${slang.title}\n要解释就用 ark_page 读这个词条。`);
        }
        if (!parts.length) {
          const hits = await searchPages(q, 5);
          const tail = hits.length ? `\nPRTS 搜到：\n${hits.map((h) => `- ${h.title}`).join('\n')}` : '';
          return { content: `本地库（${(loadOperators()?.count || 0)} 个干员 / ${(loadSlang()?.count || 0)} 条黑话）里没有「${q}」。${tail}` };
        }
        return { content: `${parts.join('\n\n')}\n\n（别背资料，顺着对方的话接一句就行。）` };
      } catch (error) {
        log(`[ark] 外号查询失败：${error?.message ?? error}`);
        return { content: `查外号失败了（${error?.message ?? error}）。` };
      }
    }
  });

  api.registerTool({
    id: 'ark_search',
    name: '搜 PRTS',
    description: '在 prts.wiki 全站搜索页面标题。用来找活动、关卡、材料、模组、剧情、黑话词条的准确页面名，再配合 ark_page 读正文。',
    category: 'knowledge',
    icon: '🔎',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词，例如「危机合约」「模组」「充电宝」' },
        limit: { type: 'number', description: '返回条数，默认 6，最多 10' }
      },
      required: ['query']
    },
    async execute(_ctx, args) {
      try {
        const limit = Math.max(1, Math.min(10, Number(args?.limit) || 6));
        const hits = await searchPages(args?.query, limit);
        if (!hits.length) return { content: `PRTS 上没搜到「${args?.query ?? ''}」。` };
        return {
          content: `搜到 ${hits.length} 条（PRTS）：\n${hits
            .map((h, i) => `${i + 1}. ${h.title}${h.snippet ? `\n   ${h.snippet.slice(0, 80)}` : ''}`)
            .join('\n')}`
        };
      } catch (error) {
        log(`[ark] 搜索失败：${error?.message ?? error}`);
        return { content: `搜 prts.wiki 失败了（${error?.message ?? error}）。` };
      }
    }
  });

  api.registerTool({
    id: 'ark_page',
    name: '读 PRTS 页面',
    description: '取 prts.wiki 某个页面的正文摘要（去掉模板/表格/HTML），适合活动机制、关卡、材料用途、剧情、黑话。默认 800 字，最多 3000 字。',
    category: 'knowledge',
    icon: '📖',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '页面标题（用 ark_search 找到的准确标题）' },
        chars: { type: 'number', description: '要多少字的摘要，默认 800，最多 3000' }
      },
      required: ['title']
    },
    async execute(_ctx, args) {
      try {
        const r = await buildPageDigest(args?.title, args?.chars);
        if (r.error) {
          const tail = r.hits?.length ? `\n${r.hits.map((h) => `- ${h.title}`).join('\n')}` : '';
          return { content: `${r.error}${tail}` };
        }
        return { content: r.text };
      } catch (error) {
        log(`[ark] 页面读取失败：${error?.message ?? error}`);
        return { content: `读 prts.wiki 页面失败了（${error?.message ?? error}）。` };
      }
    }
  });

  api.registerTool({
    id: 'ark_sync',
    name: '同步明日方舟库',
    description: '重建干员索引（约 460 个干员）与黑话索引（PRTS「明日方舟黑话·梗·成句」子页）。平时会自动更新，新干员查不到时再调。',
    category: 'knowledge',
    icon: '🔄',
    parameters: {
      type: 'object',
      properties: {
        force: { type: 'boolean', description: 'true = 立刻重建' }
      }
    },
    async execute(_ctx, args) {
      try {
        const t0 = Date.now();
        const ops = await buildOperatorIndex({ reason: args?.force ? '手动强制' : '手动' });
        const slang = await buildSlangIndex({ reason: '手动' });
        return {
          content: `已更新：干员 ${ops?.count || 0} 个、黑话 ${slang?.count || 0} 条，用时 ${Math.round((Date.now() - t0) / 1000)} 秒。`
        };
      } catch (error) {
        log(`[ark] 同步失败：${error?.message ?? error}`);
        return { content: `同步失败了（${error?.message ?? error}）。` };
      }
    }
  });
}

export const internals = {
  buildOperatorCard,
  buildPageDigest,
  searchPages,
  getPage,
  parseTemplateParams,
  findTemplates,
  toPlainText,
  buildOperatorIndex,
  buildSlangIndex,
  resolveOperator,
  resolveSlang,
  loadOperators,
  loadSlang,
};
