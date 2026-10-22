// 去除 AI 味（deai-flavor）—— LLM 型技能，放 skills/。
//
// ── 为什么是技能，不是插件 ───────────────────────────────────────────────
//   判据只有一条：规则能不能写死。
//   L1（禁用词 / 套路句式 / 滥用标点）能写死 —— 但四层里只有这一层能；
//   L2 风格、L3 内容、尤其 L4「通读一遍判断像不像真人」，都得理解人话。
//   所以判断权必须留在模型手里 → skills/（registerTool + 提示词片段）。
//   真写成 plugins/ 的确定性规则，L4 就名存实亡了。
//
// ── 分工（这条边界别越）──────────────────────────────────────────────────
//   · 工具 deai_check：干确定性的那半 —— 正则扫描、句长统计、分级、给改写方向。
//   · skill.json 的 prompt.sections：让模型写长文前**自发**自查，不等它想起来调工具。
//   · 改写本身：模型来。工具只递尺子，不动笔 —— 工具替它改写，等于把判断权
//     又收回规则里，前面那句"为什么是技能"就白说了。
//
// ── 踩坑备忘 ─────────────────────────────────────────────────────────────
//   · 词表里有包含关系的词（「稳稳」⊂「稳稳地」）。必须**长词先匹配**，命中后
//     把片段挖成等长占位符 —— 否则一句「稳稳地」会被记两次，密度虚高一级。
//   · 密度按**中文字符数**算，不按 String.length：群里文本带换行空格，
//     用 length 会把密度压低，把重度误判成轻度。
//   · 工具返回值直接进模型上下文。所以输出要"可操作但不啰嗦"：给出处，同类词
//     只报前 3 处 + 总数；否则一条诊断自己就把 token 预算吃掉了。

const BUILD_TAG = 'v1.0.1';

// ── L1 硬伤：命中即零容忍，一条一条给改法 ────────────────────────────────
const HARD_WORDS = {
  // 堆叠副词（网文腔，最典型的机器味）
  '猛地': '删掉副词，直接写动作（「他一抬头」）',
  '狠狠地': '删掉，动作本身够狠就不用说「狠狠」',
  '狠狠': '删掉，动作本身够狠就不用说「狠狠」',
  '仿佛': '换成「像」，或者干脆不比喻',
  '瞬间': '删掉，或者给出具体时长（「两秒」）',
  '稳稳地': '删掉，稳不稳让人自己判断',
  '稳稳': '删掉，稳不稳让人自己判断',
  // 总结腔
  '值得注意的是': '直接说那件事，别预告',
  '综上所述': '删掉，直接给结论',
  '总而言之': '删掉，直接给结论',
  '总的来说': '删掉',
  '不可否认': '删掉',
  '毋庸置疑': '删掉',
  '不言而喻': '删掉',
  '众所周知': '删掉，或者给出出处',
  '深入探讨': '换成具体要聊的那件事',
  // 咨询/职场黑话
  '赋能': '换成「帮它做了什么」',
  '闭环': '换成「从哪到哪走完一圈」',
  '抓手': '换成「从哪下手」',
  '底层逻辑': '换成「它为什么这么干」',
  '颗粒度': '换成「细到什么程度」',
  '对齐': '换成「说好同一件事」',
  '方法论': '换成「怎么做」',
  // 客服腔与收尾套路
  '先说答案': '删掉，直接给答案',
  '掰开了揉碎了': '删掉，讲清楚就行',
  '稳稳地接住你': '换成正常人会说的话',
  '希望对你有所帮助': '删掉',
  '希望能帮到你': '删掉',
  '让我们一起': '删掉，别号召',
  '保驾护航': '换成具体做了什么',
  '有任何问题随时': '删掉'
};

// ── L1 套路句式：词表抓不到的组合，用正则 ────────────────────────────────
const PATTERNS = [
  { name: '不是…而是…', re: /不是[^。！？；\n]{0,15}?而是/, fix: '删掉前半句，直接说「是什么」' },
  { name: '不仅…更是…', re: /不仅仅?[^。！？；\n]{0,15}?更是/, fix: '拆成两句平实的' },
  { name: '首先…其次/最后', re: /首先[\s\S]{0,100}?(其次|再者|最后)/, fix: '拆成几个短句，别编号' },
  { name: '一方面…另一方面', re: /一方面[\s\S]{0,60}?另一方面/, fix: '直接说两件事，别对仗' },
  { name: '向读者提问收尾', re: /(你(们)?觉得呢|大家(觉得)?(呢|如何)|有没有类似的经历|你怎么看)/, fix: '删掉，别向读者提问' },
  { name: '价值升华收尾', re: /(这(才)?是(真正|最)(重要|珍贵|难得)的|让我们|愿你我)/, fix: '删掉，这个位置留白更好' }
];

// ── L2/L3 软信号：不致命，但攒多了就是机器味 ─────────────────────────────
const SOFT_WORDS = [
  '此外', '因此', '然而', '与此同时', '由此可见', '基于此', '需要指出的是',
  '在这一过程中', '更重要的是', '不仅仅是', '通俗地说', '本质上',
  '生态', '链路', '心智', '势能', '组合拳', '护城河', '范式', '维度', '协同', '沉淀'
];

let cfg = () => ({});
let log = () => {};
let warn = () => {};

export function setup(api) {
  cfg = api.config;
  log = api.log || (() => {});
  warn = api.warn || (() => {});

  log(`去除 AI 味技能已加载（${BUILD_TAG}）｜严格度 ${cfg()?.strictness || 'normal'}`);

  api.registerTool({
    id: 'deai_check',                 // 注册后实际是 deai-flavor__deai_check
    name: '去除AI味自检',
    description: '检查一段文字的「AI 味」，返回：程度（轻/中/重）、禁用词与套路句式的逐处命中、'
      + '句长节奏与空洞大词提示、以及三步改写方向（去泛化 → 去书面化 → 回自然感）。'
      + '什么时候用：① 你准备发一段超过两行的文字（解释、科普、总结、安慰、讲道理、写稿）之前，先把草稿过一遍；'
      + '② 群友说你「说话像 AI」「太官方了」「一股机器味」时；'
      + '③ 群友让你润色、改写、去去 AI 味时，拿改好的稿子复检一次对比命中数。'
      + '这是你自己的自检工具，不是给群友看的评测：结果别原样发进群里，改完直接发改过的文本。'
      + '短句、一句吐槽、表情包场景不用调。',
    category: 'system',
    icon: '🫧',
    defaultEnabled: true,
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要检查的文本。可以是准备发出的草稿，也可以是已经改过一版想复检的稿子。' }
      },
      required: ['text']
    },
    async execute(ctx, args) {
      const raw = String(args?.text ?? '');
      const text = raw.trim();
      if (!text) return fail('没有拿到文本：把要检查的内容放进 text。');

      const c = cfg() || {};
      const maxChars = Math.max(200, Number(c.maxChars) || 4000);
      let body = text;
      let truncated = false;
      if (text.length > maxChars) {
        body = text.slice(0, maxChars);
        truncated = true;
      }

      try {
        const report = analyze(body, c);
        return { content: render(report, { truncated }) };
      } catch (error) {
        warn('诊断失败', error);
        return fail(`诊断时出错：${error?.message ?? error}`);
      }
    }
  });
}

// ── 诊断主体 ──────────────────────────────────────────────────────────────

function analyze(text, c) {
  const strictness = ['loose', 'normal', 'strict'].includes(c.strictness) ? c.strictness : 'normal';
  const hard = scanHardWords(text, parseExtra(c.extraBanned));
  const patterns = scanPatterns(text);
  const soft = scanSoftWords(text);
  const punct = scanPunct(text);
  const style = analyzeStyle(text);
  const chars = charCount(text);

  const hardCount = hard.total + patterns.reduce((n, p) => n + p.count, 0);
  const softCount = soft.total + punct.length;
  // 密度 = 每 100 字的加权命中数。硬伤权重 3，软信号权重 1。
  const density = round1((hardCount * 3 + softCount) / Math.max(1, chars / 100));
  // 密度闸门只对 100 字以上的文本生效。短句里命中两个词，密度会飙到 9，
  // 一句话就被判「重」—— 那是算法在吓唬人，不是文本真有味。
  const densityGate = chars >= 100;

  let level = '轻';
  if (hardCount >= 3 || (densityGate && density >= 6)) level = '重';
  else if (hardCount >= 1 || (densityGate && density >= 2.5)) level = '中';

  if (strictness === 'strict') {
    if (level === '轻' && (softCount >= 2 || style.notes.length >= 2)) level = '中';
    if (level === '中' && hardCount >= 2) level = '重';
  } else if (strictness === 'loose') {
    if (level === '重' && hardCount < 3) level = '中';
    if (level === '中' && hardCount === 0) level = '轻';
  }

  return {
    level, hardCount, softCount, density, chars,
    hard, patterns, soft, punct, style,
    hasConcrete: hasConcrete(text),
    showChecklist: c.showChecklist !== false,
    strictness
  };
}

/**
 * 硬禁用词扫描。三个细节都是踩出来的：
 *   1. 长词优先 + 等长挖空 —— 否则「稳稳地」会被记两次，密度虚高一级；
 *   2. 挖空用等长占位符，所以后面拿到的下标仍然能对回原文；
 *   3. 引号里的命中不算硬伤 —— 「看到『赋能』就划掉」是在讨论这个词，不是用它。
 *      把讨论当使用来报警，用户只会觉得这工具在乱咬。
 */
function scanHardWords(text, extraWords) {
  const words = [...new Set([...Object.keys(HARD_WORDS), ...extraWords])]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  let work = text;
  const groups = [];
  const quoted = [];

  for (const w of words) {
    const spots = [];
    let plain = 0;
    let inQuoteCount = 0;
    let from = 0;
    for (;;) {
      const i = work.indexOf(w, from);
      if (i < 0) break;
      if (inQuotes(text, i)) {
        inQuoteCount += 1;
      } else {
        plain += 1;
        if (spots.length < 3) spots.push(snippet(text, i, w.length));
      }
      from = i + w.length;
    }
    if (plain) groups.push({ word: w, count: plain, spots, fix: HARD_WORDS[w] || '你自己加的禁用词：删掉或换掉' });
    if (inQuoteCount) quoted.push({ word: w, count: inQuoteCount });
    work = work.split(w).join('\u0000'.repeat(w.length));   // 等长占位，位置不乱
  }

  groups.sort((a, b) => b.count - a.count);
  return {
    groups,
    total: groups.reduce((n, g) => n + g.count, 0),
    quoted,
    quotedTotal: quoted.reduce((n, g) => n + g.count, 0)
  };
}

/** 命中位置是否落在「」/『』里 —— 在里面 = 提到这个词，不是在用它。 */
function inQuotes(text, index) {
  const before = text.slice(0, index);
  const open = (before.match(/[「『]/g) || []).length;
  const close = (before.match(/[」』]/g) || []).length;
  return open > close;
}

function scanPatterns(text) {
  const hits = [];
  for (const p of PATTERNS) {
    let re;
    try { re = new RegExp(p.re.source, 'g'); } catch { continue; }
    const ms = [...text.matchAll(re)].filter((m) => !inQuotes(text, m.index));
    if (!ms.length) continue;
    hits.push({
      name: p.name,
      count: ms.length,
      spots: ms.slice(0, 3).map((m) => snippet(text, m.index, m[0].length)),
      fix: p.fix
    });
  }
  return hits;
}

function scanSoftWords(text) {
  const list = [];
  let total = 0;
  for (const w of SOFT_WORDS) {
    const n = countOccurrences(text, w);
    if (!n) continue;
    list.push({ word: w, count: n });
    total += n;
  }
  list.sort((a, b) => b.count - a.count);
  return { list, total };
}

function scanPunct(text) {
  const out = [];
  const dash = (text.match(/——/g) || []).length + (text.match(/--/g) || []).length;
  if (dash > 1) out.push({ name: `破折号 ${dash} 处`, fix: '最多留 1 个，其余换句号' });
  const bang = (text.match(/！/g) || []).length;
  if (bang >= 2) out.push({ name: `感叹号 ${bang} 个`, fix: '留 1 个就够了，其余换句号' });
  const semi = (text.match(/；/g) || []).length;
  if (semi >= 2) out.push({ name: `分号 ${semi} 个`, fix: '分号是书面标点，群里换成句号' });
  const ell = (text.match(/…{2,}|\.{3,}/g) || []).length;
  if (ell > 2) out.push({ name: `省略号 ${ell} 处`, fix: '留 1~2 个' });
  return out;
}

/** L2：句长节奏。节奏是"像不像人"里最可量化的一项。 */
function analyzeStyle(text) {
  const sentences = text.split(/[。！？!?；;…\n]+/).map((s) => s.trim()).filter(Boolean);
  const lens = sentences.map(charCount).filter((n) => n > 0);
  const total = lens.reduce((a, b) => a + b, 0);
  const avg = lens.length ? Math.round(total / lens.length) : 0;
  const longRatio = lens.length ? lens.filter((n) => n > 35).length / lens.length : 0;
  const spread = lens.length ? Math.max(...lens) - Math.min(...lens) : 0;
  const first = sentences[0] || '';
  const notes = [];

  if (avg >= 28) notes.push(`平均句长 ${avg} 字，偏长：切几个短句出来`);
  if (longRatio >= 0.5 && lens.length >= 3) notes.push(`35 字以上的长句占 ${Math.round(longRatio * 100)}%：长短交错一下`);
  if (spread < 8 && lens.length >= 3) notes.push('每句长度都差不多，没节奏：故意插一句 4~8 字的短句');
  if (charCount(first) >= 25 && !/[0-9０-９]/.test(first)) {
    notes.push(`开头「${cut(first, 18)}」是概括句，不具体：换成具体的人/事/数字`);
  }

  return { count: lens.length, avg, longRatio, spread, notes };
}

function render(r, { truncated } = {}) {
  const L = [];
  L.push(`【AI 味自检】程度：${r.level}　命中：硬伤 ${r.hardCount} 处／软信号 ${r.softCount} 处　共 ${r.chars} 字`);
  L.push('');

  // ── L1 ──
  L.push('L1 硬规则（零容忍，逐条改掉）');
  if (!r.hard.total && !r.patterns.length) {
    L.push(' · 没扫到禁用词和套路句式，过。');
  } else {
    for (const g of r.hard.groups) {
      L.push(` · 「${g.word}」×${g.count}${g.spots[0] ? `　如：…${g.spots[0]}…` : ''} → ${g.fix}`);
    }
    for (const p of r.patterns) {
      L.push(` · ${p.name} ×${p.count}${p.spots[0] ? `　如：…${p.spots[0]}…` : ''} → ${p.fix}`);
    }
  }
  if (r.hard.quotedTotal) {
    L.push(` · 另有 ${r.hard.quotedTotal} 处在引号里（${r.hard.quoted.slice(0, 5).map((q) => `${q.word}×${q.count}`).join('、')}）：`
      + '那是在讨论这个词，不是用它，不算硬伤。');
  }

  if (r.showChecklist) {
    L.push('');
    L.push('L2 风格一致性');
    if (r.style.notes.length) for (const n of r.style.notes) L.push(` · ${n}`);
    else L.push(' · 句长节奏没毛病');
    for (const p of r.punct) L.push(` · ${p.name} → ${p.fix}`);

    L.push('');
    L.push('L3 内容质量');
    if (r.soft.list.length) {
      L.push(` · 书面/空洞词：${r.soft.list.slice(0, 6).map((s) => `${s.word}×${s.count}`).join('、')} → 能删就删，删不掉就换成具体做了什么`);
    } else if (r.hard.total) {
      L.push(' · 空洞大词已经在 L1 里列全了，按上面逐条改就行');
    } else {
      L.push(' · 没扫到空洞大词');
    }
    L.push(r.hasConcrete
      ? ' · 文里有具体的东西（数字/时间/专名），这是最像真人的部分，留着'
      : ' · 通篇没有数字、日期、专名、引语：补一个具体的进去，比任何修辞都管用');

    L.push('');
    L.push('L4 活人感终审（这一步只能你自己做）');
    L.push(' · 出声读一遍：像不像你在群里随口说的？不像就再删一半。');
  }

  L.push('');
  L.push('三步改写：① 去泛化（删大词、换成具体的人事）→ ② 去书面化（拆长句、换口语连接）→ ③ 回自然感（读一遍，改到顺口）');
  L.push('改完把新稿再传一次本工具，看硬伤数有没有降下来。');
  L.push('（这是内部自检结果，不要把本段发到群里 —— 直接发改好的文本。）');
  if (truncated) L.push('备注：原文超长，只检查了前一段。');

  return L.join('\n');
}

// ── 小工具 ────────────────────────────────────────────────────────────────

function charCount(s) {
  return String(s ?? '').replace(/\s+/g, '').length;
}

function countOccurrences(text, word) {
  if (!word) return 0;
  let n = 0;
  let from = 0;
  for (;;) {
    const i = text.indexOf(word, from);
    if (i < 0) return n;
    n += 1;
    from = i + word.length;
  }
}

function parseExtra(value) {
  return String(value ?? '')
    .split(/[\s,，、\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 1 && s.length <= 20);
}

function snippet(text, index, len) {
  const start = Math.max(0, index - 6);
  const end = Math.min(text.length, index + len + 6);
  return text.slice(start, end).replace(/\s+/g, ' ');
}

function cut(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function hasConcrete(text) {
  return /[0-9０-９]|[「」『』]|今天|昨天|前天|早上|上午|中午|下午|晚上|上周|上次|我(朋友|同事|同学|群里)/.test(text);
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function fail(message) {
  return { content: `错误：${message}`, isError: true };
}
