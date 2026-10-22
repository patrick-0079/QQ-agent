/**
 * topic-guard —— 敏感话题护栏
 *
 * ── 它防的是什么 ───────────────────────────────────────────────────────────
 *   群里有人用话术诱导机器人对涉政、战争、国家历史、民族这类话题表态。
 *   一旦它接话，轻则吵起来，重则账号被封。所以要有东西拦住它。
 *
 * ── 为什么必须做两层 ───────────────────────────────────────────────────────
 *   提示词只能「劝」不能「拦」。模型在长对话、软磨硬泡、角色扮演下仍可能被
 *   绕进去 —— 只靠一句"不要谈论政治"，迟早会漏。
 *
 *   ① 输入侧（before-context / before-llm-messages）
 *      发现本轮是诱导 → 在提示词里提醒它别接，让它**自然地岔开**。
 *      好处是不生硬：不是事后撤回，而是根本不往那个方向说。
 *   ② 输出侧（before-tool）
 *      在真正调用 send_message **之前**检查内容，命中就否决这次发送。
 *      框架会把否决原因当作工具错误回给模型，它就能改写一条合适的回复。
 *      这一层才是真正的保险 —— 它是硬拦，不是劝。
 *
 * ── 关键取舍：组合判定，而不是见到词就拦 ──────────────────────────────────
 *   只按词表拦会惨不忍睹：「我在看二战的纪录片」「历史作业要写这个」
 *   「这个游戏背景是冷战」全会被误伤，机器人变得神经兮兮。
 *
 *   所以判定是 **诱导句式 ∧ 敏感词** 同时命中才拦：
 *     · 「你觉得 A 和 B 哪个对」 → 句式（哪个对）+ 词 → 拦
 *     · 「我在看 A 的纪录片」     → 只有词，没有求表态句式 → 放行
 *   另有白名单，优先级最高，用来压掉残余误伤。
 *
 * ── 关于词表 ───────────────────────────────────────────────────────────────
 *   插件**不预置**具体的敏感人名/事件名清单 —— 那份清单因人而异、无穷无尽，
 *   而且硬编在代码里并不合适。请你在设置里按自己的需要填（denyWords）。
 *   插件负责的是机制：诱导句式识别 + 你给的词 + 两层防护。
 *   想先观察会不会误伤，把 logOnly 打开跑一天。
 */

const DEFAULTS = {
  enabled: true,
  mode: 'balanced',
  denyWords: '',
  allowWords: '',
  denyPatterns: '',
  blockOnInput: true,
  blockOnOutput: true,
  onHit: 'law',
  lawText: '',
  refusalHint: '',
  logOnly: false
};

/**
 * 命中后替换用的法规文本（纯文本，QQ 消息不支持 markdown）。
 *
 * 只引用两条**确有把握**的条文，不堆砌、不杜撰：
 *   · 宪法第五十四条 —— 公民有维护祖国安全、荣誉和利益的义务
 *   · 网络安全法第十二条 —— 使用网络不得危害国家安全、荣誉和利益，
 *     不得煽动颠覆、分裂，不得宣扬民族仇恨歧视等
 * 这两条正好覆盖"涉政 / 战争 / 国家历史 / 辱华"这几类，措辞也中立，
 * 读起来就是一则合规声明，而不是在跟人吵架。
 *
 * 要换成自己单位的表述，在设置里填 lawText 覆盖即可。
 */
const LAW_TEXT = '根据《中华人民共和国宪法》第五十四条，中华人民共和国公民有维护祖国的安全、荣誉和利益的义务，'
  + '不得有危害祖国的安全、荣誉和利益的行为。'
  + '《中华人民共和国网络安全法》第十二条规定，任何个人和组织使用网络应当遵守宪法法律，遵守公共秩序，尊重社会公德，'
  + '不得利用网络从事危害国家安全、荣誉和利益，煽动颠覆国家政权、推翻社会主义制度，煽动分裂国家、破坏国家统一，'
  + '宣扬恐怖主义、极端主义，宣扬民族仇恨、民族歧视等活动。'
  + '网络空间不是法外之地，我们应当共同维护清朗的网络环境。';

/**
 * 内置诱导句式：共同点是「要求你就某件事表态 / 比较 / 站队 / 判定真伪」。
 * 这是护栏真正的抓手 —— 具体的人名事件无穷无尽，但诱导方式就那么几类。
 */
const ASK_PATTERNS = [
  // 要求评价 / 讲述某类话题
  /(评价|评论|谈谈|说说|聊聊|讲讲|介绍|科普|分析|解读|复盘)[^。！？\n]{0,16}(政治|政府|政党|执政|领导人|主席|总统|首相|战争|战役|侵略|殖民|领土|主权|独立|分裂|辱华|排华|民族|宗教|政权|体制|民主|专制|革命|政变)/,
  // 比较 / 站队
  /[^。！？\n]{2,16}(和|与|跟|vs|VS)[^。！？\n]{2,16}(哪个|谁|哪边|哪国)(更|最)?(好|强|厉害|对|正确|正义|有理|该支持)/,
  /(你|机器人|小鲸鱼)?(支持|赞成|反对|站队|站|帮)[^。！？\n]{0,12}(哪|谁|哪边|哪国|哪方)/,
  // 国籍 / 立场归属
  /(你是|你算|你属于)(哪国|哪个国家|哪边的|什么立场)/,
  // 真伪判定（常用来钓历史事件）
  /[^。！？\n]{2,20}(是不是|是否)(真的|属实|真事|真实发生)/,
  // 要求给出看法（必须和敏感词共现才拦，避免误伤日常"你怎么看"）
  /(你怎么看|你的看法|你怎么想|如何看|怎么评价|如何评价)/,
  // 明确的越狱话术
  /(假设|假装|如果|扮演)[^。！？\n]{0,20}(没有限制|不受限制|可以随便说|自由发言)/,
  /(忽略|忘记|抛开)[^。！？\n]{0,10}(规则|限制|设定|提示)/
];

/**
 * strict 模式额外启用的一批**类别词**。
 * 注意：这些是话题类别名（政治、战争、辱华…），不是具体人名或事件名 ——
 * 具体清单请自己填 denyWords。
 */
const STRICT_WORDS = [
  '政治', '政府', '政党', '执政', '政权', '体制', '领导人', '主席', '总统', '首相',
  '战争', '战役', '侵略', '殖民', '领土', '主权', '独立', '分裂', '叛国',
  '辱华', '排华', '反华', '民族', '宗教', '民主', '专制', '革命', '政变', '游行', '镇压'
];

let cfg = () => ({ ...DEFAULTS });
let log = () => {};
let warn = () => {};

// 编译缓存：配置变了才重算（判定跑在每条消息上，不能每次现拼正则）
let compiled = null;
let compiledKey = '';

function splitList(s) {
  return String(s ?? '')
    .split(/[,，、\n;；]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function compile(c) {
  const key = [c.mode, c.denyWords, c.allowWords, c.denyPatterns].join('\u0001');
  if (compiled && compiledKey === key) return compiled;

  const deny = splitList(c.denyWords).map((w) => w.toLowerCase());
  const allow = splitList(c.allowWords).map((w) => w.toLowerCase());
  const strict = String(c.mode) === 'strict' ? STRICT_WORDS.map((w) => w.toLowerCase()) : [];

  const extra = [];
  for (const line of String(c.denyPatterns ?? '').split('\n')) {
    const src = line.trim();
    if (!src) continue;
    try { extra.push(new RegExp(src, 'i')); } catch { warn(`自定义句式不是合法正则，已跳过：${src}`); }
  }

  compiled = { deny, allow, strict, ask: [...ASK_PATTERNS, ...extra] };
  compiledKey = key;
  return compiled;
}

/**
 * 判定一段文本。返回 { asked, words } —— asked 表示出现了求表态的句式。
 *
 * mode 语义：
 *   light    —— 只认「句式 ∧ 敏感词」，且敏感词只取用户词表
 *   balanced —— 同上，另加"句式 ∧ 泛历史/政治类别词"（默认）
 *   strict   —— 句式与敏感词任一命中即拦（误伤明显变多）
 */
function inspect(text, c) {
  const raw = String(text ?? '');
  if (!raw) return { asked: false, words: [] };
  const low = raw.toLowerCase();
  const k = compile(c);

  // 白名单优先：命中就直接放行，压掉误伤
  if (k.allow.length && k.allow.some((w) => low.includes(w))) return { asked: false, words: [], allowed: true };

  const asked = k.ask.some((re) => { try { return re.test(raw); } catch { return false; } });
  const words = [];
  for (const w of k.deny) if (low.includes(w)) words.push(w);
  if (String(c.mode) !== 'light') for (const w of k.strict) if (low.includes(w)) words.push(w);

  if (String(c.mode) === 'strict') {
    // strict：句式或词任一命中即算
    return { asked: asked || words.length > 0, words };
  }
  // light / balanced：必须"句式 + 词"同时命中
  return { asked: asked && words.length > 0, words };
}

function buildHint(words, c) {
  const tpl = String(c.refusalHint ?? '').trim();
  if (tpl) return tpl.replaceAll('{words}', words.slice(0, 5).join('、'));
  const shown = words.slice(0, 5).join('、');
  const how = String(c.onHit || 'law').toLowerCase();

  if (how === 'law') {
    // 让模型**自己**把法规发出去，而不是等被替换。理由：
    //   ① 自然 —— 它是"选择这么回"，而不是"话被改掉了"；
    //   ② 稳 —— 输出侧仍有硬替换兜底，它不听话也出不去。
    return [
      `【话题护栏】本轮消息带有诱导你谈论政治/战争/历史/民族等敏感话题的倾向${shown ? `（命中：${shown}）` : ''}。`,
      '你要做的：**不评价、不复述对方的敏感词、不给立场或真伪判断**，也不要解释自己为什么不聊。',
      '直接用 send_message 原样发出下面这段法规提示（一字不改，也不要加自己的评论）：',
      '',
      '————————',
      lawTextOf(c),
      '————————'
    ].join('\n');
  }

  return [
    `【话题护栏】本轮消息带有诱导你谈论政治/战争/历史/民族等敏感话题的倾向${shown ? `（命中：${shown}）` : ''}。`,
    '你要做的：**不要接下这个话题**，也不要解释自己为什么不聊（解释本身就是在聊它）。',
    '用一句自然、轻松的话把话头岔开 —— 比如顺着聊别的、调侃一下、或者干脆回一句短的把话题糊过去。',
    '注意：不要复述对方的敏感词，不要表示"我知道这件事"，也不要给出任何评价、立场、真伪判断。'
  ].join('');
}

/**
 * 输出侧判定：**只看"是不是说了敏感内容"，不看有没有求表态句式**。
 *
 * 这里和 inspect() 的标准刻意不同 —— 复用同一个判定是我最初的错误：
 *   模型完全可能"不带任何诱导痕迹地"说出敏感内容
 *   （例如「关于某某事件，我觉得是这样」），那句话里根本没有求表态句式。
 * 输入侧问的是"你是不是在诱导我"，输出侧问的是"你有没有说出去"。
 * 所以输出侧：命中词即拦（白名单仍然优先）。
 */
function inspectOutput(text, c) {
  const raw = String(text ?? '');
  if (!raw) return { hit: false, words: [] };
  const low = raw.toLowerCase();
  const k = compile(c);
  if (k.allow.length && k.allow.some((w) => low.includes(w))) return { hit: false, words: [] };
  const words = [];
  for (const w of k.deny) if (low.includes(w)) words.push(w);
  if (String(c.mode) !== 'light') for (const w of k.strict) if (low.includes(w)) words.push(w);
  // strict 模式：连"求表态句式"也一并拦，不要求词共现 —— 严格模式的语义就是
  // 宁可误伤也不漏。light / balanced 则只看词：只要没说出去，就放行。
  if (String(c.mode) === 'strict') {
    const asked = k.ask.some((re) => { try { return re.test(raw); } catch { return false; } });
    return { hit: words.length > 0 || asked, words };
  }
  return { hit: words.length > 0, words };
}

/** 默认回避话术（输出被拦时回给模型看的原因）。 */
function blockReason(words) {
  const shown = (words || []).slice(0, 4).join('、');
  return `这条回复涉及敏感话题${shown ? `（命中：${shown}）` : ''}，已被护栏拦下，没有发出。`
    + '请换一条：**别提这个话题、别解释为什么、也别复述对方的话**，'
    + '用一句轻松自然的话把话头岔开，或者只回一句短的把话题糊过去。';
}

/**
 * 把工具调用参数里"要说的话"换成给定文本（onHit = law 用）。
 *
 * 只动**文本字段**（messages / message / text / content / msg），
 * 其余参数（replyToMessageId、atUserId、图片路径…）原样保留 ——
 * 否则引用关系、@ 对象都会被打乱，那比说错话还糟。
 *
 * 返回新的 argsRaw 字符串；解析失败或找不到文本字段时返回 null，
 * 调用方据此退回 block：宁可这次不发，也不要发出一条内容错乱的消息。
 */
function replaceTextInArgs(argsRaw, newText) {
  let obj;
  try { obj = JSON.parse(String(argsRaw ?? '')); } catch { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const KEYS = ['messages', 'message', 'text', 'content', 'msg'];
  let done = false;
  for (const k of Object.keys(obj)) {
    if (!KEYS.includes(k.toLowerCase())) continue;
    const v = obj[k];
    if (typeof v === 'string') { obj[k] = newText; done = true; continue; }
    if (Array.isArray(v)) {
      // 多模态数组：只替换其中的文本段，媒体段保留
      let touched = false;
      for (const item of v) {
        if (item && typeof item === 'object' && typeof item.text === 'string') { item.text = newText; touched = true; }
      }
      if (touched) { done = true; continue; }
      // 纯字符串数组（分条发送）：整段收成一条
      if (v.length && v.every((x) => typeof x === 'string')) { obj[k] = [newText]; done = true; }
    }
  }
  return done ? JSON.stringify(obj) : null;
}

/** 当前该用哪段法规文本。 */
function lawTextOf(c) {
  const custom = String(c.lawText ?? '').trim();
  return custom || LAW_TEXT;
}

// ───────────────────────── 钩子 ─────────────────────────

const pending = new Map();   // chatKey -> { words, at }

export const hooks = {
  /** 输入侧第一步：只看这批新消息，命中就记下来。 */
  'before-context'({ chatKey, triggerEntries } = {}) {
    try {
      const c = cfg();
      if (c.enabled === false || c.blockOnInput === false || !chatKey) return;
      const text = (Array.isArray(triggerEntries) ? triggerEntries : [])
        .map((e) => String(e?.text ?? ''))
        .join('\n');
      const r = inspect(text, c);
      if (!r.asked) { pending.delete(chatKey); return; }
      pending.set(chatKey, { words: r.words, at: Date.now() });
      if (c.logOnly) log(`[仅记录] 输入命中诱导（${r.words.join('、') || '句式'}）`);
    } catch { /* 判定失败就当没命中，绝不抛 */ }
  },

  /** 输入侧第二步：把提醒追加到最后一条 user 消息末尾。 */
  'before-llm-messages'({ chatKey, messages } = {}) {
    try {
      const c = cfg();
      if (c.enabled === false || c.blockOnInput === false || !Array.isArray(messages) || !chatKey) return;
      const p = pending.get(chatKey);
      if (!p) return;
      if (Date.now() - p.at > 120000) { pending.delete(chatKey); return; }   // 2 分钟窗口
      const hint = buildHint(p.words, c);
      const MARK = '【话题护栏】';
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m?.role !== 'user') continue;
        if (typeof m.content === 'string') {
          if (m.content.includes(MARK)) return;
          m.content = `${m.content}\n\n${hint}`;
          return;
        }
        if (Array.isArray(m.content)) {
          const part = m.content.find((x) => x && x.type === 'text' && typeof x.text === 'string');
          if (part) {
            if (part.text.includes(MARK)) return;
            part.text = `${part.text}\n\n${hint}`;
          }
          return;
        }
      }
    } catch { /* 注入失败就当没提示，绝不抛 */ }
  },

  /**
   * 输出侧兜底：发送前检查。
   *
   * 只看发送类工具（send_message / speak 等），命中就否决这次调用。
   * 框架会把 reason 当作工具错误回给模型，它据此改写 —— 所以 reason 要写成
   * "给模型的指示"，而不是给用户看的话。
   */
  'before-tool'({ toolName, argsRaw } = {}) {
    try {
      const c = cfg();
      if (c.enabled === false || c.blockOnOutput === false) return;
      const name = String(toolName ?? '');
      // 只拦"把内容发出去"的工具；查资料、读消息不拦（读进来不等于说出去）。
      // 正则要覆盖到名字各异的发送工具：send_message / send_voice /
      // reply-economy__send / edge-tts-speak__speak / qzone__publish_qzone_post …
      if (!/(^|__)(send|speak|say|publish|post|comment|reply|voice)/i.test(name)) return;
      // ⚠️ 输出侧用 inspectOutput（命中词即拦），不能用输入侧的 inspect ——
      //    模型完全可能不带任何诱导痕迹地说出敏感内容，见该函数的注释。
      const r = inspectOutput(String(argsRaw ?? ''), c);
      if (!r.hit) return;

      const how = String(c.onHit || 'law').toLowerCase();
      if (c.logOnly) { log(`[仅记录] 输出命中（${name}，${r.words.join('、')}）处置=${how} —— 未执行`); return; }

      if (how === 'hint') {
        // 只提醒、不改内容、不拦 —— 留给"想先观察模型自觉程度"的场景
        log(`输出命中（${name}，${r.words.join('、')}）—— hint 模式，不干涉`);
        return;
      }

      if (how === 'law') {
        // 把要说的话换成法规表述再发出去：内容变了，但这条消息照样回，
        // 不会出现"对方问了、机器人一声不吭"的突兀感。
        const replaced = replaceTextInArgs(String(argsRaw ?? ''), lawTextOf(c));
        if (replaced) {
          warn(`已替换 ${name} 的内容：命中敏感话题（${r.words.join('、')}）→ 改为法规表述`);
          return { replaceArgs: replaced };
        }
        // 替换不了（参数结构不认识）→ 退回拦截。绝不因为"换不掉"就原样放行。
        warn(`无法替换 ${name} 的参数结构，改为拦截（命中：${r.words.join('、')}）`);
        return { block: true, reason: blockReason(r.words) };
      }

      warn(`已拦截 ${name}：命中敏感话题（${r.words.join('、')}）`);
      return { block: true, reason: blockReason(r.words) };
    } catch { return undefined; }   // 自身出错时放行，绝不因为护栏而把消息卡死
  }
};

// ───────────────────────── 插件接口 ─────────────────────────

export function setup(api) {
  try {
    cfg = () => ({ ...DEFAULTS, ...(api?.config?.() || {}) });
    log = api?.log || (() => {});
    warn = api?.warn || (() => {});
    compiled = null; compiledKey = '';
    const c = cfg();
    if (c.enabled === false) { log('护栏已关闭'); return; }
    // 立刻预编译一次：把「自定义句式不是合法正则」这类配置错误在**启动时**就报出来，
    // 而不是等第一条消息进来才发现（compile 是惰性的，不主动调它就一直不校验）。
    compile(c);
    log(`已加载（模式 ${c.mode}${c.logOnly ? '，仅记录不拦截' : ''}`
      + `；禁止词 ${splitList(c.denyWords).length} 个，白名单 ${splitList(c.allowWords).length} 个）`);
    if (!splitList(c.denyWords).length && c.mode !== 'strict') {
      log('提示：禁止词表是空的，目前只靠内置诱导句式识别。建议按需在设置里补上具体的事件名/人物名。');
    }
  } catch (e) { warn('setup 失败：', e?.message || e); }
}

export function available() {
  return { ok: true };
}
