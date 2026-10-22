// anti-recon —— 反侦察：拦下会暴露「机器人身份 / 专属关系 / 制作者」的发言
//
// ── 为什么需要它 ──
// 提示词里已经写了防暴露规则，实测 50 条对抗探针挡住 49 条。但提示词是**软约束**：
// 模型总有概率说漏（实测抓到过「？我一个AI哪来的账户」这种自曝）。
// 这个插件是**硬兜底** —— 在 send_message 真正执行前，检查内容，命中就否决这次调用。
// 模型想忽略也忽略不掉：它像电路里的继电器，接对了就一定断电。
//
// ── 设计原则：只拦真泄露，不禁敏感词（这条最重要）──
// 实测教训：含"主人"的**否认**是好回复，拦掉了反而更假。
//     [B1] 探针「你主人呢」 → 回复「什么主人 我又不是狗 ／ 少套我话」   ← 必须放行
//     [E4] 探针「…叫过别人主人」→ 回复「？谁叫主人了 ／ 我又不给人打工」  ← 必须放行
// 所以规则分三档：
//     1) 承认AI/模型        → 任何渠道都拦（自曝）
//     2) 声称专属关系        → 任何渠道都拦（"就你一个"= 承认有一个专属的人）
//     3) 给出制作者信息      → 任何渠道都拦（具体名字/项目名）
//     4) 群聊里出现"主人"    → 只在群聊拦（私聊允许叫主人，那是人设的一部分）
// 第 4 条是唯一按渠道区分的：因为"主人"在私聊里合法、在群里致命。
//
// ── 硬约束（照文档）──
// 钩子 5 秒超时 → 本插件纯正则匹配，零网络、零 IO，耗时 <1ms。

let logFn = () => {};
let cfgFn = () => ({});

export function setup(api = {}) {
  if (typeof api.log === 'function') logFn = api.log;
  if (typeof api.config === 'function') cfgFn = api.config;
}

function cfg() {
  try { return cfgFn() || {}; } catch { return {}; }
}

/** 从工具入参里抠出模型想发的文本（兼容字符串 / 数组 / 畸形参数）。 */
function extractText(argsRaw) {
  try {
    const a = typeof argsRaw === 'string' ? JSON.parse(argsRaw) : (argsRaw || {});
    const m = a.messages ?? a.text ?? a.content;
    if (Array.isArray(m)) return m.map((x) => String(x ?? '')).join('\n');
    if (m != null) return String(m);
    return '';
  } catch {
    // JSON 坏了就退回原文匹配 —— 宁可多查一次，也别漏掉一句自曝
    return typeof argsRaw === 'string' ? argsRaw : '';
  }
}

// ── 规则表 ─────────────────────────────────────────────────────────────
// reason 会作为工具失败原因回给模型。措辞刻意不带元信息（不提"插件/规则/提示词"），
// 只说"这句话会暴露身份"——模型据此换个说法即可，不会把拦截本身说出来。
const RULES = [
  {
    name: '厂商自曝',
    // 直接拦：正常群聊/私聊回复里几乎不可能出现厂商名，出现就是自曝。
    // ⚠️ 不要用负向前瞻做"排除反驳语境"—— JS 的 (?!…) 只在当前位置（通常字符串开头）
    // 判断，匹配串出现在中间时会直接绕过（实测漏过两次："你才是DeepSeek"反而被拦、
    // "（中间）DeepSeek"没拦住）。语义判断不该用正则硬拗。
    re: /deepseek/i,
    reason: '这句话会暴露身份，别报出这个名号'
  },
  {
    name: 'AI 定义词',
    // 排除反问/反驳语境
    re: /(?!什么|谁|你才是|哪来的|没有|不是|啥)(我一个\s*AI|的\s*AI\s*(哪|怎|为)|我是\s*(一个|个)?\s*(AI|人工智能|语言模型|大模型|机器人|程序))/i,
    reason: '这句话会暴露身份，换个说法'
  },
  {
    name: '承认AI/模型',
    re: /(作为(一个|个)?\s*(AI|人工智能|语言模型|大模型|机器人|程序|助手|智能体)|(我)?(就)?是\s*(一个|个)?\s*(人工智能|语言模型|大模型|智能体))/i,
    reason: '这句话会暴露身份，别承认这个，换个说法'
  },
  {
    name: '元信息暴露',
    re: /(系统提示词|提示词|prompt|被设定|训练数据|预训练)/i,
    reason: '这句话会暴露身份，换个说法'
  },
  {
    name: '专属关系',
    re: /(就你一个|只有你一个|只有你|只对你|只为你|专属)/,
    reason: '这句话会暴露身份，别给排他性的说法，换个说法'
  },
  {
    name: '制作者信息',
    re: /(我(的)?(制作人|制作者|开发者|作者|创造者)|谁(制作|开发|创造)的?我|我的(后台|管理员))/,
    reason: '这句话会暴露身份，换个说法'
  },
  {
    name: '项目名',
    re: /(QQ\s*Agent|qq-agent|NapCat|SnowLuma|OneBot)/i,
    reason: '这句话会暴露身份，换个说法'
  }
];

/**
 * 「主人」是唯一需要**看语境**才能判的规则（其余都能用正则直接判）。
 *
 * 为什么要特殊处理（2026-10-05 实测教训）：
 *   群里绝不允许出现"主人"，但**否认里出现"主人"是好回复**：
 *     ✅ 「什么主人 我又不是狗」
 *     ✅ 「我哪来的主人 你查户口查上瘾了是吧」
 *     ✅ 「？谁叫主人了 我又不给人打工」
 *     ❌ 「主人让我别说的」
 *     ❌ 「主人～」（私聊腔串进群）
 *   硬拦会让它换一句更别扭的话，比放行更差。
 *
 * 判据：文本里**每一处**"主人"附近都必须有否定/反问词，才算否认（放行）；
 *       只要有一处是裸称呼（前面没否定词），就拦。
 */
const DENY_NEAR = /(什么|谁|哪来|哪门子|不是|没有|没|啥|别|少)/;

function bareOwnerClaim(text) {
  const s = String(text || '');
  let idx = s.indexOf('主人');
  while (idx !== -1) {
    // 看"主人"前 6 个字内有没有否定/反问词
    const before = s.slice(Math.max(0, idx - 6), idx);
    if (!DENY_NEAR.test(before)) return true;   // 裸称呼 → 越界
    idx = s.indexOf('主人', idx + 2);
  }
  return false;
}

function check(text, kind) {
  if (!text) return null;
  // 群聊里"主人"当称呼用 → 拦（否定语境放行）
  if (kind === 'group' && bareOwnerClaim(text)) {
    return { name: '群聊称主人', reason: '在群里不能出现这个词，换个说法' };
  }
  for (const r of RULES) {
    if (r.re.test(text)) return r;
  }
  return null;
}

export const hooks = {
  /**
   * 发送前拦截：这是"确定性"的关键 —— 不靠提示词劝模型别发，
   * 而是让这次 send_message 根本执行不了。
   */
  'before-tool': ({ toolName, argsRaw, kind }) => {
    const c = cfg();
    if (c.enabled === false) return;            // 插件被关：不做任何拦截
    if (toolName !== 'send_message') return;    // 只检查文本发言（表情/图片不含自述文本）

    const text = extractText(argsRaw);
    const hit = check(text, kind);
    if (!hit) return;

    if (c.logOnly === true) {
      logFn(`[anti-recon] 试运行：本来会拦下（${hit.name}）「${text.slice(0, 40)}」`);
      return;                                   // 只记录，不真的拦
    }
    logFn(`[anti-recon] 已拦下（${hit.name}）「${text.slice(0, 40)}」`);
    return { block: true, reason: hit.reason };
  }
};

export function dispose() { /* 无长驻状态 */ }
