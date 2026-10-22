// 回复安全网：拦住"模型的思考/独白漏进群里"，并抢救写在正文里的成品。
//
// ── 两道闸，一条防线（2026-10-05 22:25 合并 outbound-guard）───────────────────
// 防的是同一种事故：模型的内心独白被当成消息发给群友。但漏出的路径有两条，
// 一条闸管不了另一条，所以本插件同时挂两个钩子：
//
//   路径 A：模型**没调工具**，话写在正文里
//        → 走 reply.* 能力（正文抢救链 src/reply-rescue.js）
//        → 原本的职责：把成品捞出来发掉；同时把混在里面的独白剔掉。
//        没有这条链，正文里的成品会被整段丢弃（历史事故：控制台显示"未回复"）。
//
//   路径 B：模型**调了 send_message**，但参数里混着独白
//        → 走 llm.response 响应变换（本文件末尾 transformResponse）
//        → 逐条剔独白、保留成品；整批都是独白就取消这次发送。
//        响应变换跑在 src/llm.js:490，早于 orchestrator 读取 tool_calls，
//        所以能**就地改参数**，且对下游（UI/存档/限频/去重）完全透明。
//
// ⚠️ 为什么不能只留一条：路径 B 的泄漏是"显式工具调用"，
//    reply.* 那条链**根本看不到**（那些会话 finish_reason=stop、raw 里没有 tool_calls）。
//    反过来路径 A 的成品，llm.response 也管不着（没有 tool_calls 可改）。
//    两段缺一不可 —— 这就是它们"相辅相成"的含义。
//
// ⚠️ 两段的判定方向**刻意相反**（合并后仍必须保持，改的时候别统一）：
//    路径 A 的误判代价是"少发一句"（原文本来也发不出去，沉默是安全的）；
//    路径 B 的误判代价是"把该说的话删掉"（机器人平白变哑巴）。
//    所以：
//      · 路径 A（isPlanningText）可以激进：过半独白、含思考标签、计划腔一律否决。
//      · 路径 B（isOutboundMonologue 逐条）必须保守：只收"绝不可能是发给群友的话"。
//    共用的是**逐条判据 isOutboundMonologue**；A 的整段否决策略不进 B。
//
// ── 2026-10-05 之前的形态与本次合并 ─────────────────────────────────────────
// 以前是 plugins/outbound-guard/ 独立持有路径 B，且**两边各存一份逐条判据常量**
// （13 组规则一字不差写了两遍，历轮多次因"改了一处忘了另一处"踩坑）。
// 现在 outbound-guard 已停用（改名 _disabled_outbound-guard/），判据只剩一份。
// ⚠️ 因此"改一处必须同步改另一处"的约束**已经消失** —— 只剩这一个文件要改。
//
// ── 保守原则（宁可不发，绝不误发）────────────────────────────────────────────
//   ① 只搬原句：不生成、不改写、不润色、不"帮模型把话说完"。
//   ② 明确"决定不说话"的内心戏（潜水/装死/没人@我…）一律拦下。
//   ③ 计划腔/候选稿（"回一句…或者…"）一律拦下。
//   ④ 拿不准一律沉默 —— 任何一级判定失败都往"不发"走。
//
// ── 接口（与 orchestrator 的调用点一一对应）────────────────────────────────
//   reply.is-planning-text   ({ text })            → { planning }
//   reply.is-outbound-monologue ({ text })         → { monologue }
//   reply.is-text-toolcall   ({ text })            → { toolCall }
//   reply.inline-calls       ({ text })            → { calls }
//   reply.loose-send         ({ text })            → { messages }
//   reply.salvage-lines      ({ text, ... })       → { say, messages }
//   reply.grounded-select    ({ reset }) / ({ remember }) / ({ proposed, sent })
//                                                    → { ok } / { ok } / { enabled, picked }
//   llm.response             ({ result, ... })     → （就地改 result.message.tool_calls）
//
// ── 2026-10-04 18:32 二次泄漏：本插件才是真正的出口 ─────────────────────────
// 那批"心里话"**不是模型调 send_message 发出去的**，而是模型写在正文里、
// 被本插件所在的**抢救链**转成发送的。路径 B 的闸（当时在 outbound-guard）挂在
// 响应变换上，永远看不到这条路（这些会话 finish_reason=stop、raw 里根本没有 tool_calls）。
// 逐句过滤原本只覆盖 INNER_PLAN / PLAN_TAIL / THINK_DESC 三种很窄的形态，
// 实测两轮泄漏一句都没命中：
//   「让我看图确认。」                    → 自我指令变体
//   「我只有一轮了，直接回复。」           → 口语化轮次盘算 + 收尾指令
//   「YZKA 发了一张图片，是…」            → 第三人称转述（尾部过长）
//   （两条英文思考段）                     → 语言比例
// 修法：① 自带逐条独白判据；② 新增"过半句子是独白 → 整段不发"。

let log = () => {};

export function setup(api) {
  log = api.log || (() => {});
}

// ── DSML 文本工具调用（2026-10-04 19:22 新增）───────────────────────────────
// 实测 DeepSeek 系模型会把工具调用写成 `<｜DSML｜tool_calls>` 文本标记，而不是走结构化
// function calling；网关**不一定**替它解析（实测原生 tool_calls=0、finish_reason=stop）。
// 于是应用"看不见这个调用"，正文被当成思考整段丢弃 —— 19:22:08 的 ai-image__gen 即此。
//
// 核心 orchestrator 的 parseInlineToolCalls 现在也认这种写法（走 text-toolcalls.js）。
// 这里再注册一份 `reply.inline-calls` 兜底：它是 orchestrator 早就留好的插件钩子，
// 但**全插件库一直没人实现**，一直是空操作。两处并存不会重复执行 —— orchestrator 会
// 按 name+args 去重合并。
//
// ⚠ 为什么内联、而不是 import ../text-toolcalls.js：该插件目录不在 app 源码树内，
//   相对路径引用会被打包/resolve 破坏；且本插件已有"自带一份避免 ESM 缓存"的先例
//    （见文件头 outbound-guard 那段说明）。代价：与 src/text-toolcalls.js 规则要同步。
const VB = '[｜|]';
const DSML_TOOLCALLS_BLOCK =
  `<${VB}\\s*DSML\\s*${VB}\\s*tool_calls\\s*>([\\s\\S]*?)<\\/${VB}\\s*DSML\\s*${VB}\\s*tool_calls\\s*>`;
const DSML_INVOKE =
  `<${VB}\\s*DSML\\s*${VB}\\s*invoke\\s+name\\s*=\\s*"([^"]+)"\\s*>([\\s\\S]*?)<\\/${VB}\\s*DSML\\s*${VB}\\s*invoke\\s*>`;
const DSML_PARAM =
  `<${VB}\\s*DSML\\s*${VB}\\s*parameter\\s+name\\s*=\\s*"([^"]+)"(?:\\s+string\\s*=\\s*"(true|false)")?\\s*>([\\s\\S]*?)<\\/${VB}\\s*DSML\\s*${VB}\\s*parameter\\s*>`;

/** 正文里是否含 DSML 文本工具调用标记（快速分流） */
function hasDsmlToolCalls(text) {
  return new RegExp(`<${VB}\\s*DSML\\s*${VB}\\s*tool_calls\\s*>`, 'i').test(String(text || ''));
}

/** 解析正文里的 DSML 文本工具调用 → [{ name, args }]；无则 [] */
function parseDsmlToolCalls(text) {
  const out = [];
  for (const block of String(text || '').matchAll(new RegExp(DSML_TOOLCALLS_BLOCK, 'gi'))) {
    for (const inv of block[1].matchAll(new RegExp(DSML_INVOKE, 'gi'))) {
      const args = {};
      for (const p of inv[2].matchAll(new RegExp(DSML_PARAM, 'gi'))) {
        const [, key, isStr, raw] = p;
        const val = raw.trim();
        if (isStr === 'true') args[key] = val;
        else { try { args[key] = JSON.parse(val); } catch { args[key] = val; } }
      }
      out.push({ name: inv[1], args });
    }
  }
  return out;
}

export function available() {
  return { ok: true };
}

// ── 明确"不回复"的内心戏（整段否决，避免把"我决定不说话"发出去）─────────────

const SILENT = [
  /(先|继续|安静|一直|又|打算|想|准备)潜[水着]/,   // 先潜水/继续潜水…
  /潜水(看看|看|装|了|中|吧|着|中)/,                 // 潜水看看你们聊啥
  /继续潜/, /装死/,
  /没人@/, /没被@/, /^没(有|人)?@?我/,               // 没人@我 / 没@我（句首）
  /跟(我)?(没|无)关/, /与我(没|无)关/, /跟我也没关系/, /这事跟我/,
  /话题(已|都)?翻篇/, /话题结束/, /翻篇了/,
  /看你们聊/, /看别人说/, /看群里(聊|说|讲)/, /看他们聊/,
  /安静(潜水|看着|待着|蹲着)/, /懒得回/, /不想回/, /不用回/, /不必回/,
  /已阅/, /已读/, /无视/, /装作没/, /假装没/, /假装看不到/, /装作没看到/
];

// ── 计划腔 / 候选稿（整段否决）─────────────────────────────────────────────

const PLANNING = [
  /回一句[^。！？\n]{0,30}或者/,                     // 回一句"…"或者"…"
  /要么[^。\n]{0,20}要么/,                          // 要么…，要么…（候选思考）
  /(候选|备选|草案)[：:]/, /方案[一二三四五12345][：:]/,
  /→\s*(太长|太啰嗦|再精简|精简|删除)/,
  /(太长|太啰嗦)[，,。]?(就|则|直接)/,
  /(直接|就)回[^。！？\n]{0,20}(得了|就行|算了|吧)/,   // "直接回不知道得了"（给自己的指令）
  /^(我|咱|我们)[先再]*(想想|思考|考虑|看看|搜搜|查查|找找|盘算)/
];

/** 思考/描述性内容：复述"用户说了什么"、转述对方需求 → 不是成品回复。 */
const THINK_DESC = /^(用户|对方|群友|有人|群友要|有人要)(刚|刚刚|现在|正在|在|发了|说了|问了|要|提到|@)/;

// ── 自我汇报腔 / 收尾腔（整段否决）─────────────────────────────────────────
// 模型偶尔把"对自身动作的汇报"写进正文，而不是要发出去的话。实测泄漏过：
//   "语音已经发出去了，这句接得挺自然的，不用再补文字了。"
//   "直接收工。"  "已语音回复，收工。"
// 这类文本被抢救链路发出去后：① 群里出现机器人自言自语；② 它会被 store
// 记成"我："，下一轮再塞回【已读信息】，永久污染上下文与注意力。
// 与【发送与汇报禁令】一致：绝不能让它们进群。
//
// 刻意只否决"明确的自我动作汇报"，不做宽泛的"含收工就否决"——
// "好了收工~" / "三比零，收工" 这类是真群里会说的话，必须照发。
const META_REPORT = [
  // 汇报自己发过什么：「已语音回复」「语音已经发出去了」「消息已发送成功」
  /(已经?|已)(把|刚刚|刚)?[^。！？\n]{0,12}(发出|发送|发出去|回复|送达|成功)/,
  /(语音|图片|表情|表情包|消息|卡片|歌)[^。！？\n]{0,8}(已经?|已)?[^。！？\n]{0,6}(发|回复)(了|出去|完毕|成功)/,
  // 告诉自己不用再做动作：「不用再补文字了」「不必再多说了」
  /(不用|无需|不必|不需要)(再)?(补|回|发|说话|说什么|说)/,
  // 纯收尾指令，整句只有它（"直接收工。"/"搞定了。"）
  /^[（(]?(直接|就)?(收工|完毕|搞定|完事|结束)[了。！!？?~～]*[)）]?$/,
  // 评价自己刚写的那句：「这句接得挺自然的」
  /(这句|这波|这个)[^。！？\n]{0,8}(接得|回得|答得|说得)[^。！？\n]{0,4}(自然|不错|挺好)/,
  // 权衡要不要开口：「在犹豫要不要再冒一句泡……」
  // 实测泄漏（2026-10-04 00:10 group:710273965）。与"汇报自己发过什么"是同一族：
  // 都在播报自己的动作状态，而不是在说话。
  // 动作词刻意收成"动词+口部宾语"的形状（冒…泡 / 接…话 / 开…口），
  // 「犹豫要不要去旅游」「纠结要不要换工作」这类真的在商量事的句子必须照发。
  /(犹豫|纠结)[^。！？\n]{0,8}(要不要|是不是|该不该)[^。！？\n]{0,10}(冒[^。！？\n]{0,2}泡|插[^。！？\n]{0,3}话|接[^。！？\n]{0,3}话|开[^。！？\n]{0,2}口|说[^。！？\n]{0,3}话|回[^。！？\n]{0,3}话|发[^。！？\n]{0,3}条|出[^。！？\n]{0,2}声|冒[^。！？\n]{0,3}句)/
];

// ── 逐条独白判据（**唯一来源**，2026-10-05 22:25 起）─────────────────────────
// 这套常量以前在 plugins/outbound-guard/index.js 里有一份一模一样的副本
// （13 组规则、逐字重复），两边注释都写着"改一处必须同步改另一处"。
// outbound-guard 停用后副本已删，**这里就是唯一来源** —— 改这里即可，
// 路径 A（reply.* 抢救链）与路径 B（llm.response 响应变换）共用同一份。
//
// 判据方向刻意保守：只收"绝不可能是发给群友的话"的特征。
// 路径 B 的误判代价是**把该说的话删掉**，所以宁漏不误杀。
// 全量 1,622 条历史真实发言逐条跑过，命中的全部是真独白（误杀 0）。
// 2026-10-04 19:02 补入 APP_TERM / MSG_META / QUOTE_META 三条元叙述规则后复跑，
// 新规则另命中 3 条，逐条核对仍全是真独白。

/** 工具名被当成普通词写进消息里（"其实我看图需要 get_message_images。"）。 */
const OUTBOUND_TOOL_TOKENS = /(get_message_images|get_sticker_image|read_group_history|read_messages|list_stickers|send_sticker|send_message|send_to|web_search|web_fetch)/;

/** 直接把工具调用语法当文本写出来（"finish()" / "finish(summary=\"…\"" ）。 */
const OUTBOUND_TOOL_SYNTAX = /^\s*(finish|send_message|send_sticker|send_to|list_stickers)\s*[（(]/i;

/** 轮次/预算元信息。 */
const OUTBOUND_ROUND_META = /(轮次|回合|预算|剩余轮)[^。！？\n]{0,8}(紧张|只剩|不够|用完|有限|不多了|不足)/;
const OUTBOUND_ROUND_META_EN = /(tool rounds?|rounds? left|out of (tool )?rounds|remaining rounds)/i;
/** 口语变体："我只有一轮了"（ROUND_META 要求以"轮次/回合…"开头，抓不到）。 */
const OUTBOUND_MY_ROUNDS = /(我|咱)[^。！？\n]{0,6}(只剩|只有|就剩|还剩|还有)[^。！？\n]{0,4}[一二三四五六1-6两]\s*轮/;

/** 第三人称转述："ZZKA发了张图问上面是什么。"（尾部放宽到 50，见 outbound-guard 注释）。 */
const OUTBOUND_NARRATION = /^[A-Za-z0-9_\u4e00-\u9fff]{1,16}\s*(问|说|发)(了|来|了个|了张)?[^。！？\n]{0,50}。$/;

/** 对自己下的命令："我需要回复。" / "我要说句话"。 */
const OUTBOUND_SELF_CMD = /^我(现在|先|得|要|该|需要|应该|必须|准备)*(要|该|需要|应该|必须)?(回(复)?|答|说(话|一句|点)|冒泡|开口|发声|出声)(一下|了|啦|呢)?[。！？~～…]*$/;
/** 落的句尾的收尾指令："…直接回复。" */
const OUTBOUND_SELF_WRAP = /(直接|干脆|就)(回(复)?|答|说|发)[吧了]?[。！？~～…]*$/;
/** 自我指令变体："让我看图确认。" */
const OUTBOUND_LET_ME = /^(让|叫)我[^。！？\n]{0,6}(看图|看下图|看看图|看一眼|看眼|确认一下|确认|查一下|查查|搜一下|搜搜|回复|回一句|回一下|说一句|试试|试一下)[。！？~～…]*$/;

/** 应用内部术语：群友永远不会说这些词。（2026-10-04 19:02 三次泄漏） */
// ⚠ 与 plugins/outbound-guard/index.js 的 APP_TERM 必须**同步修改**（两处一套）。
const OUTBOUND_APP_TERM = /(未读消息|已读信息|系统提醒|工具调用轮次)/;

/** 元指代开头："这条消息是…" —— 在指代输入本身，不是在说话。 */
// 必须紧跟判断词，否则会误杀正常回应「这条消息我没看懂，再说一遍？」（实测边界）。
const OUTBOUND_MSG_META = /^这(条|个)(未读)?(消息|信息|发言)\s*(是|指的是|就是|指的)/;

/** 复述引用结构："引用的话里提到…" —— 描述消息由什么组成，不是回应内容。 */
const OUTBOUND_QUOTE_META = /引用(的)?(话|内容|消息)[^。！？\n]{0,6}(里|中)?(提到|说|写|是)/;

// ── 风格规划句（2026-10-04 21:06 第四次泄漏，本插件侧）─────────────────────
// 实测泄漏："温柔卖萌带点腹黑。"（session mutu3poz-2be7f12c）
// 这是模型在**决定"用哪种口吻回复"**（"对方说我垃圾…我可以顺势接一下。
// 温柔卖萌带点腹黑。</think>哼，垃圾也是可爱的垃圾~"），前两句是思考过程，
// 它被拆句后当成一条独立成品发了出去。
//
// 判据必须**极精确**：光是"含风格词"远远不够 —— 全量 2,204 条历史真实发言里
// 含风格词的就有 271 条（"一只会卖萌的DeepSeek"、"我只会卖萌温柔这一套"、
// "呜——问这个我可就不困了~"…），用"含风格词"当判据会大面积误杀。
//
// 收窄到"**整句只有风格词 + 配置词、没有主语/宾语/交流对象**"：
//   ① 去标点后 ≤10 字（长句一定是在说事，不是标风格）
//   ② 含至少一个风格形容词
//   ③ 去掉风格词/配置词（带点/偏/走/是/属于/风格/路线…）与标点后**不剩任何其他字**
// ③ 是关键：真实发言总还有主语（"我只会…"）或宾语（"…的DeepSeek"）或对谁说的。
//
// 验证：全量 2,204 句真实发言 → **命中 1 句 = 本次泄漏原文**，误杀 0。
// （测试脚本 verify_style_plan.mjs 可复跑。）
const OUTBOUND_STYLE_WORD = '温柔|卖萌|腹黑|俏皮|傲娇|可爱|正经|冷淡|活泼|阳光|羞涩|娇憨|慵懒|乖巧|呆萌|高冷|软萌';
const OUTBOUND_STYLE_GLUE = /^(?:温柔|卖萌|腹黑|俏皮|傲娇|可爱|正经|冷淡|活泼|阳光|羞涩|娇憨|慵懒|乖巧|呆萌|高冷|软萌|带|点|偏|走|是|属于|风格|路线|一点|有点|些|很|挺|超|半|全|又|还|和|与|加|上)+[。！？!?~～…]*$/;

/** 整句只是"回复风格/口吻的规划"，不是要说的话。 */
function isStylePlan(t) {
  const s = String(t || '').trim();
  if (!s) return false;
  const core = s.replace(/[。！？!?~～…\s]/g, '');
  if (core.length < 2 || core.length > 10) return false;          // ① 只抓短句
  if (!new RegExp(OUTBOUND_STYLE_WORD).test(core)) return false;  // ② 必须有风格词
  return OUTBOUND_STYLE_GLUE.test(s);                             // ③ 其余只能是配置词
}

/** 括号+等号包起来的机器码（[emotion_id=…]）：字母再多也不是散文，必须放过。 */
const OUTBOUND_MACHINE_CODE = /^\s*\[[^\]\n]*[=:][^\]\n]*\]\s*$/;

/** 以英文为主的散文（思考段）。用比例而非绝对阈值：漏网那条夹着 12 个汉字。 */
function outboundEnglishProse(t) {
  const letters = (t.match(/[A-Za-z]/g) || []).length;
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  return letters >= 20 && letters > 2 * cjk;
}

/** 这段文本是模型的内心独白/计划/元叙述吗？（两条路径共用的逐条判据） */
// 2026-10-05 22:25 起 **export**：本文件是这套判据的唯一来源，
// 导出后别的插件/测试可以直接 import 复用，不必再复制一份常量
// （历史上正是"复制一份绕 ESM 缓存"造成了 13 组规则两处维护）。
export function isOutboundMonologue(text) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  if (OUTBOUND_MACHINE_CODE.test(t)) return false;
  if (OUTBOUND_TOOL_SYNTAX.test(t)) return true;
  if (OUTBOUND_TOOL_TOKENS.test(t)) return true;
  if (OUTBOUND_ROUND_META.test(t)) return true;
  if (OUTBOUND_ROUND_META_EN.test(t)) return true;
  if (OUTBOUND_MY_ROUNDS.test(t)) return true;
  if (OUTBOUND_NARRATION.test(t)) return true;
  if (OUTBOUND_SELF_CMD.test(t)) return true;
  if (OUTBOUND_SELF_WRAP.test(t)) return true;
  if (OUTBOUND_LET_ME.test(t)) return true;
  if (OUTBOUND_APP_TERM.test(t)) return true;
  if (OUTBOUND_MSG_META.test(t)) return true;
  if (OUTBOUND_QUOTE_META.test(t)) return true;
  // 含思考标签（2026-10-04 21:06 第四次泄漏）。
  // ⚠️ 合并时差点漏掉这条 —— 旧 outbound-guard 里有、reply-safety 的 isOutboundMonologue
  //    里没有（reply-safety 只在 isPlanningText 用了 hasThinkTag，逐条判据漏了）。
  //    全量 14,747 条历史消息比对时被等价性测试抓到，1 条不一致：
  //      `</think>哼，垃圾也是可爱的垃圾~` 旧=拦 新=放。
  //    用 hasThinkTag()（内部已对 g 标志正则做 lastIndex 归零）而不是裸 test。
  if (hasThinkTag(t)) return true;
  if (isStylePlan(t)) return true;          // 风格规划句（2026-10-04 21:06 第四次泄漏）
  return outboundEnglishProse(t);
}

/**
 * 正文里**过半**的句子都是独白 → 整段放弃。
 *
 * 为什么需要它（而不是只做逐句过滤）：剔完只剩一句残缺的成品也要发出去，
 * 群友收到的是没头没尾的半句话；而且"三句里两句是独白"说明这一轮模型本来
 * 就在自言自语，不发才是对的。本链路的原则本来就是"拿不准一律沉默"。
 *
 * 阈值取**严格过半**：2 句里 1 句不触发（可能真是"一句独白 + 一句成品"），
 * 3 句里 2 句触发。
 */
function mostlyMonologue(text) {
  // 先剥思考标签再投票：`</think>` 粘在成品句头上会让那句"看起来不像独白"，
  // 把整段投票结果带偏（2026-10-04 21:06 本例就是如此）。
  // 注：带标签的文本在 isPlanningText 里已被整段否决，这里是纵深防御。
  const body = stripThinkShell(stripThinkTags(String(text || '').trim()));
  if (!body) return false;
  const sentences = body
    .split(/(?<=[。！？!?~～])|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);          // 与 looseSend 的过滤门槛一致，碎片不投票
  if (sentences.length < 2) return false;   // 单句交给逐句过滤判定
  const hits = sentences.filter((s) => isOutboundMonologue(s)).length;
  return hits * 2 > sentences.length;       // 严格过半
}

function isPlanningText(text) {
  if (!text) return true;   // 空正文 = 没什么可抢救的
  // 含思考标签 = 这段正文里**明确混着思考**（2026-10-04 21:06 第四次泄漏）。
  // 走 looseSend 虽然也能剥掉标签前的思考，但"模型自己都标了思考边界"说明
  // 这一轮它压根没走工具协议、是在正文里自言自语 —— 本链路原则是拿不准一律沉默。
  if (hasThinkTag(text)) return true;
  if (SILENT.some((r) => r.test(text))) return true;
  if (PLANNING.some((r) => r.test(text))) return true;
  if (META_REPORT.some((r) => r.test(text))) return true;
  if (mostlyMonologue(text)) return true;   // 过半是独白（2026-10-04 新增）
  return false;
}

// ── 抽取成品句（只删思考/内心外壳，不动任何句子内容）────────────────────────

/** 我/咱/我们 + (先/再/…去来) + 动作 → "我再去搜一下"这类计划，不是成品。 */
const INNER_PLAN = /^(我|咱|我们|本[^\s，。！？]{0,4})[的们]*(先|再|还要|得|想|打算|决定|准备|必须|回头|稍后)*(去|来)?(搜|查|看|找|问|试|翻|看看|想想|问问|考虑|考虑考虑)/;

/** 以"算了/再说吧"等收尾的犹豫句 → 不算成品。 */
const PLAN_TAIL = /(算了|再说|再想|再聊|先这样|就这样吧|好吧|行吧|算了吧)[~～。！!]*$/;

/** 去思考外壳：开头的【深度思考】/思考：/分析：/总结：… 段整段删掉。 */
function stripThinkShell(text) {
  return String(text || '')
    .replace(/^((【[^】]*思考[^】]*】|思考[：:]|分析[：:]|思路[：:]|总结[：:]|内心[：:]|\(?(内心戏|OS|os)\)?[：:])[^\n]*\n?)+/, '')
    .trim();
}

// ── 思考标签（2026-10-04 21:06 第四次泄漏）────────────────────────────────
// 实测原文（session mutu3poz-2be7f12c，raw.choices[0].message.content）：
//   对方说我"你垃圾"，在玩梗调侃，我可以顺势接一下。温柔卖萌带点腹黑。</think>哼，垃圾也是可爱的垃圾~
// 是**一整段"思考 + 成品"混在一起**，用 `</think>`（孤立的闭合标签，开标签在更早被
// 网关/上下文吃掉了）分隔。抢救链按句末标点拆句，`</think>` 就**粘在下一条成品句头上**
// 原样发了出去 —— 日志里两条真实发言："温柔卖萌带点腹黑。" / "</think>哼，垃圾也是可爱的垃圾~"。
//
// 处理原则（顺序很重要）：
//   1) `</think>` **之前**的内容一律是思考 → 整段丢弃（含标签本身）；
//   2) 成对 `…` 包裹的区间也丢弃；
//   3) 残留的孤立标签（`<think>` / `</think>` / `<thinking>` 等）直接删掉，
//      避免它粘在正常句子前面被当成正文发出去。
//
// ⚠ 为什么必须做在"拆句之前"：`</think>` 出现在句中时，拆句器不认识它，
//    会把 `</think>哼，垃圾…` 当成一条独立成品句 —— 事后逐句过滤看不到"这是思考的尾巴"。
// ⚠ `g` 标志的正则有 lastIndex 状态：`test()` 会推进它，下一次调用就从上次位置往后找，
// 导致"明明有标签却判定没有"。所有使用点必须**先归零**（实测踩过：A 段判定后 B 段误返回原文）。
const THINK_TAG = /<\/?(?:think|thinking|reason|reasoning|analysis)\s*>/gi;
const THINK_PAIR = /<(?:think|thinking|reason|reasoning|analysis)\s*>[\s\S]*?<\/(?:think|thinking|reason|reasoning|analysis)\s*>/gi;
const THINK_CLOSE = /<\/(?:think|thinking|reason|reasoning|analysis)\s*>/gi;

/** 正文里是否出现过思考标签（出现即"这段含思考"的硬证据）。 */
function hasThinkTag(text) {
  THINK_TAG.lastIndex = 0;
  return THINK_TAG.test(String(text || ''));
}

/**
 * 剥掉思考标签及其内容，返回"只剩成品"的文本。
 * 没有标签时原样返回（trim 后），不影响既有行为。
 */
function stripThinkTags(text) {
  let t = String(text || '');
  THINK_TAG.lastIndex = 0;
  if (!THINK_TAG.test(t)) { THINK_TAG.lastIndex = 0; return t; }
  THINK_TAG.lastIndex = 0;
  // ① 成对区间先整段删（`<think>…</think>`）
  THINK_PAIR.lastIndex = 0;
  t = t.replace(THINK_PAIR, '');
  // ② 走到这里说明还剩**孤立**标签。取**最后一个**闭合标签之后的内容 ——
  //    它之前的都是思考（本例真实形态：`…带点腹黑。</think>哼…`）。
  THINK_CLOSE.lastIndex = 0;
  const closes = [...t.matchAll(THINK_CLOSE)];
  if (closes.length) {
    const last = closes[closes.length - 1];
    t = t.slice(last.index + last[0].length);
  }
  // ③ 万一还有孤立开标签（有头无尾，思考被截断），删掉标签本身
  THINK_TAG.lastIndex = 0;
  return t.replace(THINK_TAG, '').trim();
}

function looseSend(text) {
  const body = String(text || '').trim();
  if (!body) return [];

  // ⓪ 先剥思考标签：`</think>` 之前的内容是思考，不能进消息。
  //    没有标签时 stripThinkTags 原样返回，行为与改动前一致。
  const unthink = stripThinkTags(body);
  if (!unthink) return [];        // 整段都是思考（如 "<think>…</think>"）→ 无成品可发

  // ① 去掉开头的思考外壳段（【深度思考】…）
  let t = stripThinkShell(unthink);
  if (!t) return [];

  // ② 去掉整体是括号内心戏的行（（安静潜水…）这种）
  t = t.split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^[(（][\s\S]*[)）]$/.test(l))
    .join('\n')
    .trim();
  if (!t) return [];

  // ③ 拆句（换行或句末标点，标点保留），逐句过滤
  const sentences = t.split(/(?<=[。！？!?~～])|\n+/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const s of sentences) {
    if (s.length < 4 || s.length > 300) continue;
    if (INNER_PLAN.test(s)) continue;      // 内心计划："我先搜一下…"
    if (PLAN_TAIL.test(s)) continue;       // 犹豫收尾："…算了~"
    if (THINK_DESC.test(s)) continue;      // 复述对方需求："用户刚发了…"
    if (/^这是要/.test(s)) continue;       // "这是要 X 的"是转述，不是回复
    if (isOutboundMonologue(s)) continue;  // 独白/计划/元叙述（与 outbound-guard 同一套判据）
    out.push(s);
    if (out.length >= 3) break;            // 最多 3 句，防刷屏
  }
  return out;
}

// ── 启发式兜底：整段干净文本且像成品时，直接整段发出（不拆句）──────────────

async function salvageLines({ text = '', trigger = '', alreadySent = [], api = null } = {}) {
  const body = String(text || '').trim();
  if (!body || body.length < 2 || body.length > 300) return { say: false, messages: [] };
  const cleaned = stripThinkShell(body);
  if (!cleaned) return { say: false, messages: [] };
  if (INNER_PLAN.test(cleaned) || PLAN_TAIL.test(cleaned)) return { say: false, messages: [] };
  if (THINK_DESC.test(cleaned)) return { say: false, messages: [] };
  if (/^[(（]/.test(cleaned) && /[)）]$/.test(cleaned)) return { say: false, messages: [] };
  return { say: true, messages: [cleaned] };
}

// ── 草稿溯源闸：只放行"确实出自本轮模型原话"的句子，且没发过 ────────────────

let drafts = [];

function norm(s) {
  return String(s || '').replace(/\s+/g, '').toLowerCase();
}

function groundedSelect(args = {}) {
  // 运行开始：清空草稿池（草稿只在"这一次运行"内有意义）
  if (args?.reset === true) {
    drafts = [];
    return { ok: true };
  }
  // 每轮正文顺手记进草稿池（orchestrator 在 inline 分支调用）
  if (typeof args?.remember === 'string' && args.remember.trim()) {
    drafts.push(args.remember.trim());
    return { ok: true };
  }
  // 候选溯源 + 去重
  const proposed = Array.isArray(args?.proposed)
    ? args.proposed.filter((p) => typeof p === 'string' && p.trim())
    : [];
  if (!proposed.length) return { enabled: true, picked: [] };

  const sentTexts = new Set(
    (Array.isArray(args?.sent) ? args.sent : [])
      .filter((s) => s?.type === 'text')
      .map((s) => norm(s.text))
      .filter(Boolean)
  );
  const picked = proposed.filter((p) => {
    const np = norm(p);
    if (np.length < 3) return false;                 // 碎片不放行
    if (sentTexts.has(np)) return false;             // 本轮已发过的不重复发
    return drafts.some((d) => norm(d).includes(np)); // 必须是模型自己的原话
  });
  return { enabled: true, picked };
}

// ── 能力注册（orchestrator 通过 #capFirst 取第一个提供者）───────────────────

// ── 路径 B：llm.response 响应变换（2026-10-05 22:25 由 outbound-guard 并入）──
// 逐条剔掉 send_message 参数里的独白，保留成品；整批都是独白就取消这次发送。
//
// 为什么挂在 llm.response，而不是 before-tool：
//   before-tool 只能**整条否决**（orchestrator.js 的 tool 循环），拿不到参数、也改不了参数。
//   而泄漏常常是"一句成品 + 两句独白"混在同一次调用里 ——
//   整条否决会把那句成品一起丢掉，用户本该收到回答却变成沉默。
//   llm.response 是响应变换链，能直接改 result.message.tool_calls 的参数，
//   所以可以**逐条剔独白、保留成品**；全批都是独白时才取消这次发送。
//   执行时机在 src/llm.js:490（applyResultTransforms），早于 orchestrator 读取 tool_calls，
//   对下游（UI 会话页、存档、限频、去重）完全透明 —— 它们只会看到被清理过的参数。
//
// 判定方向与路径 A 相反（见文件头）：这里一旦误判就是**把该说的话删掉**。

/** 会真正把文字发到 QQ 的工具（跨会话发送同样是外发，一并管）。 */
const SEND_TOOLS = new Set(['send_message', 'send_to']);

function filterList(list) {
  const kept = [];
  const dropped = [];
  for (const m of list) {
    if (typeof m !== 'string') { kept.push(m); continue; }   // 非字符串原样放行
    if (isOutboundMonologue(m)) dropped.push(m); else kept.push(m);
  }
  return { kept, dropped };
}

/**
 * 逐条剔独白，保留成品；整批都是独白就取消这次发送。
 *
 * 不改返回值、直接改 result.message（applyResultTransforms 里就地生效）：
 * 返回对象反而要多一层合并语义，就地改更不容易出错。
 */
function transformResponse({ result } = {}) {
  const msg = result?.message;
  const calls = msg?.tool_calls;
  if (!Array.isArray(calls) || !calls.length) return;   // 没有工具调用：无操作

  const remain = [];
  let touched = false;

  for (const call of calls) {
    const name = call?.function?.name;
    if (!SEND_TOOLS.has(name)) { remain.push(call); continue; }

    let args;
    try {
      args = JSON.parse(call.function.arguments || '{}');
    } catch {
      remain.push(call); continue;                      // 参数不是合法 JSON：交给原链路报错
    }
    if (!args || typeof args !== 'object') { remain.push(call); continue; }

    // 单条字符串形态：留着就原样放行，是独白就整条取消
    if (typeof args.messages === 'string') {
      if (!isOutboundMonologue(args.messages)) { remain.push(call); continue; }
      touched = true;
      log(`[reply-safety] 拦下独白（${name}）：${JSON.stringify(args.messages.slice(0, 80))}`);
      continue;
    }
    if (!Array.isArray(args.messages)) { remain.push(call); continue; }

    const { kept, dropped } = filterList(args.messages);
    if (!dropped.length) { remain.push(call); continue; }

    touched = true;
    for (const d of dropped) {
      log(`[reply-safety] 拦下独白（${name}）：${JSON.stringify(String(d).slice(0, 80))}`);
    }
    if (!kept.length) {
      log(`[reply-safety] ${name} 的 ${dropped.length} 条全是独白 → 取消这次发送`);
      continue;                                          // 整条丢掉 = 本轮不说话
    }
    args.messages = kept;
    call.function.arguments = JSON.stringify(args);
    log(`[reply-safety] ${name}：剔除 ${dropped.length} 条独白，保留 ${kept.length} 条成品`);
    remain.push(call);
  }

  if (!touched) return;
  // 全被剔光时 remain 为空数组 → orchestrator 走"本轮不说话"分支，
  // 不再尝试发送，也不会给下一次请求留下无主的 tool 消息。
  msg.tool_calls = remain;
}

export const providers = {
  'reply.is-planning-text': ({ text = '' } = {}) => ({ planning: isPlanningText(text) }),
  // 逐条级独白判据。两条路径共用：
  //   · 路径 A：专供"文本工具调用抢救"（reply-rescue ⓪）—— 那条路径上 messages 是
  //     逐条待发的成品，而 is-planning-text 的"过半独白"判据对**单句**不生效
  //     （实测单句真实泄漏句"轮次紧张，直接看图吧。"会被它**全部放行**），所以要这个更细的判据。
  //   · 路径 B：transformResponse 逐条过滤 send_message 参数。
  'reply.is-outbound-monologue': ({ text = '' } = {}) => ({ monologue: isOutboundMonologue(String(text || '')) }),
  // 文本工具调用识别 + 解析。orchestrator 的 inline 分支会调 reply.inline-calls，
  // 抢救链的 ⓪ 分支会先问 reply.is-text-toolcall（"这是工具调用"还是"内心戏"）。
  // 后者很重要：正文里出现 `<｜DSML｜tool_calls>` 时，整段英文思考会被 ① 计划腔判据
  // 直接否决 —— 但正确的做法是**执行它想调的工具**，不是当成计划腔丢掉。
  'reply.is-text-toolcall': ({ text = '' } = {}) => ({ toolCall: hasDsmlToolCalls(text) }),
  'reply.inline-calls': ({ text = '' } = {}) => ({ calls: parseDsmlToolCalls(text) }),
  'reply.loose-send': ({ text = '' } = {}) => ({ messages: looseSend(text) }),
  'reply.salvage-lines': async (args = {}) => salvageLines(args),
  'reply.grounded-select': (args = {}) => groundedSelect(args),
  // 路径 B 的挂点（原 outbound-guard 的能力，2026-10-05 并入）。
  'llm.response': transformResponse
};
