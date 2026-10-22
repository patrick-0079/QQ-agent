// 智能配图（LLM 型技能 / skills/）
//
// 做什么：被 @ 或有人想要图时，机器人自己判断该不该配图；该配就按关键词找一张，
//         **一步到位直接发出去**，不需要模型再调第二个工具。
//
// 为什么是"技能"而不是"插件"：
//   "这句话是不是在要图"没法写成确定规则 —— 必须理解人话，所以由模型决定何时调用。
//   规则能写死的（比如"消息里有链接就下载"）才该做成插件。
//
// v2.0.0 相对 v1 的三处变化（对应三条要求）：
//
//   ① 「同一个关键词每次要不同的图」
//      v1 固定请求第 0 页第 1 条 —— 同一关键词永远出同一张，必然"脸熟"。
//      v2 三道保障叠加：搜索起点随机（0/30/60）+ **在分辨率最高的 N 张里随机挑**
//      + 按**内容指纹**记住发过的图（落盘，重启也记得）。同一张图换了域名也算重复。
//
//   ② 「最好高清点」
//      v1 用百度 `thumbURL` —— 那是 500px 缩略图，正是"糊"的根源。
//      v2 改成：优先拿**原图直链**；并且不信搜索接口的标称尺寸 ——
//      下载后按**实测**分辨率排序、低于下限的降级使用（百度标称 3552x4720，
//      实际发过来 500x664，只有实测能识破）。兜底端点也按 ~1600px 挑。
//
//   ③ 「什么图都能配，不能出现不认识/不知道」
//      四层来源递进：360/百度 的原图直链 → 必应的"必在相关图"（任何关键词都有，
//      实测「樱花」出樱花、「土星」出土星）→ 360 小图 → 与关键词无关的随机图。
//      外加逐级放宽关键词变体再搜。所以只要网络通，就一定发得出图。
//      模型那边也下了硬要求：写完关键词就交出去，不许回"我不认识"。
//
// v2.1.0：接入 **pixiv 图源**（ACG 题材走 pixiv）。
//   搜动漫/游戏相关的词时，优先从 pixiv 出图 —— 那才是这类题材真正的出处，
//   "对味程度"明显好过通用图搜。实现见 lib/pixiv.js，这里只负责编排：
//     · prefer（默认）：pixiv 优先，拿不到再走搜索引擎 —— 用户在群里看到的就是
//       "ACG 词出 pixiv 高清图、其它词照旧"，不需要自己切开关；
//     · fallback：先用搜索引擎，实在没图才试 pixiv；
//     · off：完全不碰。
//   **非 ACG 关键词会自然走不到 pixiv**（那边校验后返回空），
//   所以不存在"把『橘猫』也塞进 pixiv 搜"的副作用 —— 见 lib/pixiv.js 的相关性校验。
//
// 与内置能力的区别：
//   · 内置 search_images + send_image：两步。模型可能搜完就停了，图没发出去。
//   · 出厂自带的 search-image 技能：一步，但依赖 apihz 第三方接口（要 ID/Key，会过期）。
//   · 本技能：一步 + 免 Key + 多图源互备。
//
// 为什么"下载下来自己看"再发（而不是把 URL 甩给协议端）：
//   搜索引擎给的直链有三类坑 —— 防盗链 403、图已删 404、以及最阴的
//   `200 + text/html` 错误页。只传 URL 的话用户看到裂图，而我们连失败了都不知道。
//   下载校验顺带换来两个能力：按**实测**分辨率排序（真高清）、按**内容**去重（真不重样）。
//
// 依赖：只用到 api.fetch（在 skill.json 里声明了 web_fetch 权限才拿得到）。
import { collectCandidates, keywordVariants, randomFallbacks } from './lib/sources.js';
import { pixivCandidates } from './lib/pixiv.js';
import { downloadImage, saveTemp, sweepTemp, urlHash, isPublicHttpUrl } from './lib/image.js';
import { seen, mark } from './lib/history.js';

/** 单次调用最多下载几张来试。防"关键词冷门 + 直链全挂"时无上限地拖时间。 */
const MAX_DOWNLOADS = 16;
/** 整轮下载校验的时间预算。超了就用手头已有的结果，绝不把对话拖死。 */
const TOTAL_BUDGET_MS = 30000;
/** 兜底阶段的独立下载额度与额外时限：这是"必须出图"的最后一环，值得多花几秒。 */
const FALLBACK_DOWNLOADS = 4;
const FALLBACK_EXTRA_MS = 8000;
/** 同时下载数：3 并发在"够快"和"别把图床打急"之间比较平衡。 */
const CONCURRENCY = 3;
/**
 * pixiv 反代的超时安排。它的耗时结构和普通图床完全不同：
 *   **首访要回源（实测 5~17s，波动极大）→ 之后命中缓存（约 1.5s）**。
 * 而本地超时断开**不会**取消反代那边的回源 —— 它照样会把这张图拉完并缓存。
 * 所以最优策略不是"一次给足长超时"，而是：**先短超时探一次，再立刻用同一 URL 问一次**，
 * 第二次基本直接命中缓存（实测首访 9.4s 的图，重试只要 1.6s）。
 * 换镜像排在最后，因为换域名等于重新回源，比同 URL 重试慢得多。
 */
const PIXIV_FIRST_MS = 6000;
const PIXIV_RETRY_MS = 9000;
/** pixiv 阶段最多试几张（并发）。并发越多，"其中至少一张回源快"的概率越高。 */
const PIXIV_TRIES = 3;
/** pixiv 阶段的独立时限：到点就收手，把剩余预算完整留给搜索引擎。 */
const PIXIV_STAGE_MS = 13000;

let cfg = () => ({});
let httpFetch = null;
let log = () => {};

export function setup(api) {
  cfg = api.config;
  log = api.log || (() => {});
  httpFetch = typeof api.fetch === 'function' ? (...args) => api.fetch(...args) : null;

  api.registerTool({
    id: 'find_image',
    name: '智能配图',
    description: '按关键词找一张图并直接发到当前会话。当你判断对方想要一张图（“来张猫图”“有图吗”“搜张向日葵”“长啥样发一个”）时调用。参数 keyword 是搜索关键词，从对方的话里提炼，越具体越准。**不管这个关键词你认不认识、事物是否真实存在，都照原话传进来**——工具内部有多图源和兜底图源，任何关键词都能出图，所以永远不要回答“我不认识/没有这个的图”。它会在一个回复里把图发出去，你不需要再调用发送工具，也不要复述图片内容。',
    category: 'media',
    icon: '🎨',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '搜索关键词，原话提炼，例如“橘猫”“向日葵”“赛博朋克城市”“三体 罗辑”' },
        count: { type: 'number', description: '发几张，1~3，默认用设置里的值（通常 1）' }
      },
      required: ['keyword']
    },
    async execute(ctx, args) {
      return run(ctx, args);
    }
  });
}

async function run(ctx, args) {
  const c = cfg() || {};
  const keyword = normalizeKeyword(args?.keyword);
  if (!keyword) {
    return { content: '缺少 keyword：请把对方想要的事物提炼成一个关键词再调用。', isError: true };
  }
  if (!httpFetch) {
    return { content: '未启用网络权限（web_fetch），无法找图。请在技能页确认本技能已启用。', isError: true };
  }

  const maxCount = clamp(num(c.maxCount, 3), 1, 3);
  const want = clamp(num(args?.count, num(c.count, 1)), 1, maxCount);
  const minShortSide = Math.max(0, num(c.minShortSide, 480));
  const poolSize = clamp(num(c.poolSize, 40), 5, 200);
  const allowRandom = c.allowRandom !== false;
  const sourcePref = String(c.source || 'auto').trim().toLowerCase();
  const sources = sourcePref === '360' ? ['360']
    : sourcePref === 'baidu' ? ['baidu']
      : sourcePref === 'bing' ? ['bing']
        : null;   // auto：全都试，谁先出图算谁的

  // pixiv（ACG 图源）：取值非法一律按 prefer —— "配不出图"比"配置写错"严重得多
  const pixivPref = String(c.pixiv || 'prefer').trim().toLowerCase();
  const pixivMode = ['off', 'prefer', 'fallback'].includes(pixivPref) ? pixivPref : 'prefer';
  const pixivExcludeAI = c.pixivExcludeAI === true;

  // 顺手清理两天前的临时图，防止目录无限增长（失败不影响本次）
  sweepTemp();

  const env = {
    want, minShortSide, poolSize, sources, keyword,
    pixivMode, pixivExcludeAI, pixivUsed: false,
    deadline: Date.now() + TOTAL_BUDGET_MS,
    good: [], weak: [], taken: new Set(), downloads: 0, errors: []
  };

  // ── 0) pixiv：ACG 题材优先从 pixiv 出图 ───────────────────────────────
  // 放在最前，因为它的候选质量最好；非 ACG 词在这里会**立刻**返回空
  // （相关性校验挡掉），代价只有一次元数据请求（约 1.2s），不会拖慢普通图搜。
  if (pixivMode === 'prefer') await tryPixiv(env);

  // ── 1) 逐级放宽关键词搜索 ─────────────────────────────────────────────
  // 先用原话搜（最准）；不够就换变体再搜。变体只做"减法"，不换语义。
  const variants = keywordVariants(keyword);
  const usedVariants = [];
  for (const kw of variants) {
    if (env.good.length >= want || Date.now() > env.deadline || env.downloads >= MAX_DOWNLOADS) break;
    let res;
    try {
      res = await collectCandidates(httpFetch, kw, { sources, allowRandom: false, want });
    } catch (error) {
      env.errors.push(`${kw}: ${error?.message ?? error}`);
      continue;
    }
    if (res.errors.length) env.errors.push(...res.errors.map((e) => `${kw} → ${e}`));
    const queue = orderCandidates(res.candidates, poolSize, [0, 1]);
    if (!queue.length) continue;
    usedVariants.push(kw);
    log(`「${kw}」候选 ${res.candidates.length} 条，进入试取 ${queue.length} 条`);
    await tryQueue(queue, env);
  }

  // ── 2) 兜底：必返图文源 + 随机图 ──────────────────────────────────────
  // 只有"一张相关的都没拿到"才补。已经拿到 1 张相关图就不再塞无关图 ——
  // 宁可少发一张，也不要一真一假混着发。
  if (!env.good.length && !env.weak.length) {
    const guaranteed = [];
    // fallback 模式：搜索引擎一条都没出，才轮到 pixiv 试一次。
    // 拿到图的话下面 probe 的条件不成立，必应/随机图自然不会再补 —— 有真图就不发凑数的。
    if (pixivMode === 'fallback') await tryPixiv(env);
    // 必应对任何关键词都返回相关图，用它守住"必定出图"这条底线
    try {
      const res = await collectCandidates(httpFetch, keyword, { sources: ['bing'], allowRandom: false, want: 1 });
      guaranteed.push(...orderCandidates(res.candidates, 4, [1, 2]));
    } catch (error) {
      env.errors.push(`必应兜底: ${error?.message ?? error}`);
    }
    if (allowRandom) guaranteed.push(...randomFallbacks());
    if (guaranteed.length) {
      // 兜底阶段重置下载额度并补一点时限 —— 前面把预算花在"试那些可能挂掉的
      // 原图直链"上了，不该因此让最后一环没机会执行。
      env.downloads = 0;
      env.deadline = Math.max(env.deadline, Date.now() + FALLBACK_EXTRA_MS);
      await probe(guaranteed, env, {
        pureFallback: true, maxDownloads: FALLBACK_DOWNLOADS, respectHistory: false
      });
    }
  }

  // ── 3) 选图：优先够清晰的，其次能接受的，且每张内容都不同 ──────────────
  // 按**实测**像素降序取，而不是按"下载完成顺序"取 —— 一次并发会同时下到
  // 大图和小图，不排序的话可能把 500px 的中档图先选走、把 3524px 的原图丢掉。
  // 这样不会削弱"每次不同"：去重靠的是记忆（发过的会在下一轮被排除），
  // 而不是靠随机挑，所以"从大到小轮着来"反而是更好的行为。
  const byPixels = (a, b) => (b.w * b.h) - (a.w * a.h);
  const picked = [
    ...[...env.good].sort(byPixels),
    ...[...env.weak].sort(byPixels)
  ].slice(0, want);   // env.taken 已保证内容不重复

  if (!picked.length) {
    const why = env.errors.slice(0, 3).join('；') || '所有图源都没有返回可用图片';
    log(`找图失败：${why}`);
    return {
      // 注意措辞：这是"图源连不上/图挂了"，不是"不认识这个词"。
      // 提示词里已叮嘱模型不要把这类情况说成"我不知道"。
      content: `这次所有图源都没能拿到可用的图（${why}）。请只回一句“图源暂时连不上，稍后再试一次”，不要说你不知道或没有这个的图。`,
      isError: true
    };
  }

  let sent = 0;
  const sentInfo = [];
  for (const item of picked) {
    let file;
    try {
      file = saveTemp(item.buf, item.format);
    } catch (error) {
      log(`落盘失败，跳过这张：${error?.message ?? error}`);
      continue;
    }
    try {
      await ctx.sender.sendImage(ctx.chatKey, { file }, { note: `配图：${keyword}` });
      // 只在"确实发出去了"之后才记账 —— 发失败的不该占用记忆额度，
      // 否则记忆会越来越满，把好图都判成"已发过"。
      mark(keyword, { urlHash: urlHash(item.url), hash: item.hash });
      sent += 1;
      sentInfo.push(`${item.w}x${item.h} ${item.source}`);
      log(`已发送 ${item.w}x${item.h}（${Math.round(item.bytes / 1024)}KB，${item.source}）`);
    } catch (error) {
      log(`发送失败，跳过这张：${error?.message ?? error}`);
    }
  }

  if (!sent) {
    return {
      content: '图找到了但发送全部失败。请只回一句“发图失败了，稍后再试一次”，不要说你不知道或没有这个的图。',
      isError: true
    };
  }

  // 与内置发送工具保持一致：记进会话，让控制台会话页能看到这条图
  try {
    ctx.session?.sent?.push({
      type: 'image',
      text: `[图片:配图 ${keyword}]`,
      at: new Date().toLocaleTimeString('zh-CN', { hour12: false })
    });
    ctx.emit?.('session-update', ctx.session?.id);
  } catch { /* 留档失败不影响发送结果 */ }

  // 给模型的话要跟实际情况对上：发的是"相关图但用了备用源"还是"无关随机图"，
  // 说错了模型就会对用户讲错。
  const lines = [`已发出 ${sent} 张「${keyword}」的图（${sentInfo[0] || ''}）。`];
  const randomUsed = picked.some((p) => p.tier === 3);
  // pixiv 命中也算"常规来源"：它没走 usedVariants 那条循环，
  // 不加这个判断会被误判成"常规图源没返回结果"，模型就会对用户讲错。
  const pixivUsed = picked.some((p) => p.pixiv);
  if (randomUsed) {
    lines.push('注意：所有图源都没有与这个关键词相关的图，发出去的是一张随机图。只回一句“没找到特别贴切的图，先给你一张”，不要描述图片内容。');
  } else if (!usedVariants.length && !pixivUsed) {
    lines.push('注意：常规图源这次没返回结果，用的是备用图源（内容仍与该关键词相关）。不要再描述或复述图片内容。');
  } else {
    lines.push('不要再描述或复述图片内容，一两句话带过即可。');
  }
  return { content: lines.join('\n') };
}

/**
 * pixiv 阶段：ACG 关键词优先从这里出图。
 *
 * **失败一律静默** —— 返回空候选、限流 429、超时，都只当"这次没有"：
 * 后面还有搜索引擎和必应兜底，用户不该察觉这里发生过一次失败，
 * 更不该因为它而收不到图。
 *
 * 只试 PIXIV_TRIES 张、且用独立的短时限。反代首访要回源（实测 5~17s/张），
 * 由着它下会把整轮 30s 预算吃干净，反而让后面的搜索引擎没机会出图。
 */
async function tryPixiv(env) {
  const before = env.good.length + env.weak.length;
  let res;
  try {
    res = await pixivCandidates(httpFetch, env.keyword, { excludeAI: env.pixivExcludeAI });
  } catch (error) {
    env.errors.push(`pixiv: ${error?.message ?? error}`);
    return;
  }
  if (res.errors.length) env.errors.push(...res.errors);
  if (!res.candidates.length) return;
  log(`pixiv 命中 ${res.candidates.length} 条`);

  const queue = orderCandidates(res.candidates, 6, [0]).slice(0, PIXIV_TRIES);
  const saved = env.deadline;
  env.deadline = Math.min(saved, Date.now() + PIXIV_STAGE_MS);
  try {
    await probe(queue, env, { respectHistory: true, eager: true });
  } finally {
    env.deadline = saved;   // 无论成败都把剩余预算还给后面
  }
  if (env.good.length + env.weak.length > before) env.pixivUsed = true;
  else log(`pixiv 有 ${res.candidates.length} 条候选但一张也没下成，按"这次没有"处理`);
}

/**
 * 试取一个关键词候选队列。
 *
 * 分两轮，第二轮是"用户第 N 次问同一个词"的退路：
 *   第一轮尊重记忆（没发过的优先，这是"不重样"的本体）；
 *   如果全部候选都发过了，第二轮放开记忆允许复用。
 * 为什么必须有第二轮：记忆满员时若继续硬性排除，队列会被清空 →
 * 结果是"问第二次猫图，反而收到一张与猫无关的随机图"，比重复更糟。
 */
async function tryQueue(queue, env) {
  const before = env.good.length + env.weak.length;
  await probe(queue, env, { respectHistory: true });
  if (env.good.length + env.weak.length > before) return;
  if (Date.now() > env.deadline || env.downloads >= MAX_DOWNLOADS) return;
  log('候选都已发过，本轮放开记忆，允许复用旧图（比换成无关随机图好）');
  await probe(queue, env, { respectHistory: false });
}

/**
 * 排序候选：**层内按分辨率降序取前 N 张后打散，再跨层轮转交替**。
 *
 * 三步都不可省，各自解决一个具体问题：
 *   ① 层内按标称像素降序 → 保证进池子的都是高分辨率那批（这是"高清"）
 *   ② 在池子里打散     → 保证每次挑哪张是随机的（这是"每次不同"）
 *   ③ 跨层轮转交替     → 保证"可靠但中档"的图不会被排在几十条
 *      "很可能 403 的原图直链"之后。（实测踩过：60 条候选里前面的原图几乎全 403，
 *      16 次下载额度全烧在它们身上，中档图一次都没轮到，结果 3 张只能发出 2 张。）
 *      轮转后前 8 次就同时试到了两种层，成图率明显上来。
 */
function orderCandidates(candidates, poolSize, tierOrder) {
  const byTier = new Map();
  for (const c of candidates) {
    if (!c?.url || !isPublicHttpUrl(c.url)) continue;
    const tier = Number.isInteger(c.tier) ? c.tier : 2;
    const bucket = byTier.get(tier);
    if (bucket) bucket.push(c); else byTier.set(tier, [c]);
  }

  const buckets = tierOrder.map((tier) => {
    const list = byTier.get(tier) || [];
    list.sort((a, b) => (b.w * b.h) - (a.w * a.h));
    return shuffle(list.slice(0, poolSize));
  }).filter((b) => b.length);

  const out = [];
  const longest = Math.max(...buckets.map((b) => b.length), 0);
  for (let i = 0; i < longest; i++) {
    for (const bucket of buckets) {
      if (bucket[i]) out.push(bucket[i]);
    }
  }
  return out;
}

/**
 * 逐张试取：下载 → 嗅探真实分辨率 → 过小的降级 → 内容去重。
 *
 * 是"边试边收"而不是"先挑定一张再验证" —— 因为图床直链的死活事先无法从
 * 搜索结果判断（实测 360 的原图约一半 403/404），只能试着来。
 */
async function probe(queue, env, opts = {}) {
  const need = opts.pureFallback ? 1 : env.want;
  const cap = opts.maxDownloads ?? MAX_DOWNLOADS;
  const respectHistory = opts.respectHistory !== false;
  // 兜底阶段**一次只取一张**：这里混着"相关的兜底图"和"无关的随机图"，
  // 批量下就会把两者一起收下 → 变成 1 张像样的 + 2 张八竿子打不着的混着发。
  // 只取第一个成功的，宁少勿杂。
  const batchSize = opts.pureFallback ? 1 : CONCURRENCY;
  const tried = new Set();   // 本次 probe 内试过的 URL，避免同一批重复下载
  let i = 0;

  while (i < queue.length
    && env.good.length < need
    && Date.now() < env.deadline
    && env.downloads < cap) {
    const batch = [];
    while (batch.length < batchSize && i < queue.length) {
      const c = queue[i++];
      const uh = urlHash(c.url);
      if (tried.has(uh)) continue;
      tried.add(uh);
      // 下载前就能命中的去重：同一 URL 发过就不用再下了，省流量
      if (respectHistory && seen(env.keyword, { urlHash: uh })) continue;
      batch.push(c);
    }
    if (!batch.length) continue;

    // pixiv 阶段用 eager：**先到先用，不等最慢的那张**。
    // 反代耗时波动极大（5~17s），三张并发时若等 Promise.all 全部跑完，
    // 就算第一张 5s 就到了也要干等到 15s 才返回 —— 实测这一条就让整轮从 26s 掉到 6~10s。
    const results = opts.eager
      ? await raceCollect(batch.map((c) => tryOne(c, env, respectHistory)))
      : await Promise.all(batch.map((c) => tryOne(c, env, respectHistory)));
    for (const r of results) {
      if (!r || env.taken.has(r.hash)) continue;
      env.taken.add(r.hash);
      const shortSide = Math.min(r.w, r.h);
      if (env.minShortSide === 0 || shortSide >= env.minShortSide) {
        env.good.push(r);
      } else if (shortSide >= env.minShortSide * 0.6 || opts.pureFallback) {
        // 达不到下限但不算离谱（或已经是兜底阶段）：留着，只有更好的不够才用
        env.weak.push(r);
      } else {
        env.errors.push(`分辨率过低 ${r.w}x${r.h}`);
      }
    }
    // 兜底阶段只要拿到一张就收手，别再下别的
    if (opts.pureFallback && (env.good.length || env.weak.length)) break;
  }
}

/**
 * "先到先用"：并发任务里只要有**一个成功**就立刻返回，不再等其余的。
 * 全失败才等到最后一个结束（那时确实没有可用的了）。
 *
 * 注意：被放弃等待的任务仍在后台跑完（fetch 无法中途取消），结果会被丢弃。
 * 这里换的是响应速度，代价是可能多下几张图 —— 对 pixiv 这种
 * "耗时波动 5~17s"的源来说非常值。
 */
function raceCollect(promises) {
  return new Promise((resolve) => {
    if (!promises.length) { resolve([]); return; }
    const out = [];
    let left = promises.length;
    for (const p of promises) {
      p.then((r) => {
        out.push(r);
        if (r) resolve(out);
        else if (--left === 0) resolve(out);
      }, () => {
        if (--left === 0) resolve(out);
      });
    }
  });
}

/** 下载并校验单个候选。任何失败都只记录、返回 null（换下一张继续试）。 */
async function tryOne(candidate, env, respectHistory) {
  env.downloads += 1;
  const plan = candidate.pixiv
    ? pixivPlan(candidate)
    : [{ url: candidate.url, timeoutMs: 7000 }];

  for (const step of plan) {
    // 每一步都受本轮时限约束（而不是只在步与步之间粗略检查）：
    // 否则最后一步仍能跑满自己的超时，一轮下来能超出时限整整一步。
    const remain = env.deadline - Date.now();
    if (remain < 800) {
      env.errors.push(`${candidate.source}: 超出本轮时限，放弃`);
      return null;
    }
    try {
      const d = await downloadImage(httpFetch, step.url, {
        timeoutMs: Math.min(step.timeoutMs, remain)
      });
      // 内容指纹去重：同一张图挂在别的域名上也认得出来
      if (respectHistory && seen(env.keyword, { hash: d.hash })) {
        env.errors.push('与发过的图重复');
        return null;
      }
      return { ...candidate, ...d, shortSide: Math.min(d.w, d.h) };
    } catch (error) {
      env.errors.push(`${candidate.source}: ${String(error?.message ?? error).slice(0, 60)}`);
    }
  }
  return null;
}

/**
 * pixiv 候选的下载计划（顺序很关键，见上面 PIXIV_FIRST_MS 的说明）：
 *   ① 主 URL 短超时探一次 —— 首访常常 6s 内就回来了，不必干等十几秒；
 *   ② 同一 URL 再问一次 —— 反代的回源不会因为我们断开而停下，
 *      这几秒足够它把图缓存好，第二次基本秒回（实测 9.4s → 1.6s）；
 *   ③ 换镜像 —— 最后手段，代价是重新回源。
 *
 * 不做"原图"档位：原图 3~10MB，反代回源实测要 20s 上下，给不够时间必然全挂、
 * 白等十几秒再掉回通用图搜。1200px 对 QQ 群配图已经够用，别为它牺牲速度。
 */
function pixivPlan(candidate) {
  const plan = [
    { url: candidate.url, timeoutMs: PIXIV_FIRST_MS },
    { url: candidate.url, timeoutMs: PIXIV_RETRY_MS }
  ];
  for (const m of candidate.mirrors || []) plan.push({ url: m, timeoutMs: PIXIV_RETRY_MS });
  return plan;
}

// ── 小工具 ───────────────────────────────────────────────────────────────

/** 关键词归一：去掉包裹的引号、多余空白、结尾的标点。 */
function normalizeKeyword(input) {
  return String(input ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s"“”'‘’「」『』]+|[\s"“”'‘’「」『』。！？，、!?,]+$/g, '')
    .trim()
    .slice(0, 80);
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, Math.round(Number(n) || lo)));
}

/** Fisher-Yates。用 Math.random 足够 —— 这里只需要"别老是同一张"。 */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * 自检：本技能不依赖任何 Key 或第三方额度，只要拿到 web_fetch 权限就能工作。
 * 返回 true 表示"可用"；技能页不会显示"依赖缺失"。
 */
export function available() {
  return true;
}
