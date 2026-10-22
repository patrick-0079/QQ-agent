// AI 状态查询 —— 注册工具的插件（放 plugins/，显示在控制台「插件」页签）
//
// 用户发指令（\状态、AI状态、今日用量、花了多少钱、运行多久、快到什么节了…）时，
// 模型调用 get_ai_status 工具。
//
// ── 输出形态（v1.3.0 起）────────────────────────────────────────────────
//   默认：把状态渲染成一张**深色面板图**（照控制台预览卡的样子），由工具自己
//   通过 ctx.sender.sendImage 直接发到当前会话（与 image-generate 技能同链路：
//   自带发送队列 / 限频 / 去重），模型不需要再调 send_message。
//   渲染失败 / 无发送上下文时，回退为旧的 6 行文本卡。
//
//   图片怎么来的：项目没有 sharp/canvas，但应用本体是 Electron ——
//   用一个 show:false + offscreen 的 BrowserWindow 加载 HTML，capturePage 截成 PNG。
//   纯净 Node（headless server.js）里 import('electron') 拿到的是字符串路径，
//   不是 API —— 此时静默回退文本卡，不报错。
//
// ── 数据来源（全部只读，不动任何核心文件）──────────────────────────────
//   模型 / 渠道    getConfig().api.model、vendorOfConfig(cfg)
//   今日 token     DATA_DIR/usage-today.json（核心每日统计文件）
//   今日花费       DATA_DIR/sessions/*.json 逐条按「调用发生的时刻」计价后汇总
//                  → 走 sumCostByTime()，能正确区分峰谷档；
//                    若会话文件已清空，退回用 usage-today 汇总 × 当前档位估算
//   运行时长       DATA_DIR/logs/*.log 里最后一次「控制台已就绪」的时间戳
//   进程号         DATA_DIR/qq-agent.lock
//   日志 / 告警    DATA_DIR/logs/*.log 的体积 + 关键词行数
//   峰谷时段       src/model-prices.js 的 PEAK_WINDOWS + isPeakHour()
//                  → 只对有 peak 档的模型（DeepSeek 系）显示；时段永远按北京时间算
//   节日倒计时     src/holidays.js 的 upcomingHoliday()（内置表，不联网）
//   限速统计       软依赖 rate-guard 插件的 llm.rate-stats 能力
//   系统资源       本进程 process.memoryUsage() + os.totalmem/freemem
//                  + CPU 用 os.cpus() 两次采样差值（约 120ms）；
//                  内存/CPU 超阈值时给「建议重启」徽章

import { getConfig, DATA_DIR } from '../../src/config.js';
import {
  resolveModelPrice, sumCostByTime, priceAt, isPeakHour, vendorOfConfig, PEAK_WINDOWS
} from '../../src/model-prices.js';
import { upcomingHoliday } from '../../src/holidays.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 版本号直接从 plugin.json 读（与 mc-status/weather-card 同一约定）——
// 手写 BUILD_TAG 的下场就是升到 v1.5.x 了启动日志还印 v1.4.11，排查时被它带偏。
const BUILD_TAG = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'plugin.json'), 'utf8'));
    return `v${j.version}`;
  } catch { return 'v?'; }
})();

let log = () => {};
let apiRef = null;
let cfgFn = null; // 本插件设置读取器（面板配色 theme 在这里）

const pad2 = (n) => String(n).padStart(2, '0');
const localDay = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

const fmtTok = (n) => {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
};

const fmtMoney = (n) => {
  n = Number(n) || 0;
  if (n <= 0) return '¥0';
  if (n < 0.01) return '¥' + n.toFixed(4);
  return '¥' + n.toFixed(2);
};

const fmtSize = (b) => {
  b = Number(b) || 0;
  if (b >= 1024 * 1024 * 1024) return (b / 1024 / 1024 / 1024).toFixed(2) + 'GB';
  if (b >= 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + 'MB';
  if (b >= 1024) return Math.round(b / 1024) + 'KB';
  return b + 'B';
};

const fmtDur = (ms) => {
  const m = Math.max(0, Math.round((Number(ms) || 0) / 60000));
  if (m < 1) return '不到 1 分钟';
  if (m < 60) return m + ' 分钟';
  const h = m / 60;
  if (h < 24) return h.toFixed(1) + ' 小时';
  return (h / 24).toFixed(1) + ' 天';
};

// ── 中文品牌名映射 ──────────────────────────────────────────────────────
// 面板上「当前模型 / 渠道」直接显示原始 id（deepseek-v4-pro、token.sensenova.cn）
// 对普通群友是天书。这里做一层展示名映射，**只影响显示，不参与任何计算**。
//
// 规则：
//   1. 品牌名是中文的才替换（deepseek-v4-pro → 深度思索 v4-pro）
//   2. 品牌名本身就是英文的保持原样（GPT-4o、Claude-sonnet-4、Gemini-2.5-pro），
//      免得把大家认得的名字改成不认识的中文
//   3. 表按**顺序**匹配，写在前面的优先 —— 有歧义的（nova、o1）必须把特殊情况写在前面
//   4. 两个表都没命中 → 模型原样显示；渠道去掉 token./api. 等前缀原样显示（不瞎猜）

/** 渠道（域名/厂商）别名。匹配用的是包含判断，所以只写关键片段即可。 */
const VENDOR_ALIAS = [
  // ── 国内 ──
  [/sensenova|sensetime|sensecore|sophnet/i, '商汤'],
  [/deepseek/i, 'DeepSeek'],
  [/moonshot|kimi/i, '月之暗面'],
  [/bigmodel|zhipu|z\.ai|chatglm|codegeex/i, '智谱'],
  [/modelscope/i, '魔搭 ModelScope'],
  [/dashscope|aliyun|alibaba|bailian/i, '阿里云百炼'],
  [/volces|volcengine|bytedance|ark\.cn/i, '火山引擎'],
  [/siliconflow|硅基流动/i, '硅基流动'],
  [/baidubce|qianfan|wenxin/i, '百度智能云'],
  [/tencentcloud|hunyuan/i, '腾讯混元'],
  [/xf-?yun|xfyun|spark-api|iflytek/i, '讯飞开放平台'],
  [/minimax|hailuo/i, 'MiniMax'],
  [/stepfun|阶跃/i, '阶跃星辰'],
  [/01\.ai|lingyiwanwu/i, '零一万物'],
  [/baichuan/i, '百川智能'],
  [/skywork|tiangong|kunlun/i, '昆仑万维'],
  [/pangu|huaweicloud|huawei/i, '华为云'],
  [/zhinao|360\.cn|360ai/i, '360 智脑'],
  [/modelbest|minicpm/i, '面壁智能'],
  [/baai|bge-|aquila/i, '智源研究院'],
  [/infinigence|infini-ai/i, '无问芯穹'],
  [/coze\.cn|coze\.com/i, '扣子 Coze'],
  [/longcat|meituan/i, '美团 LongCat'],
  [/xiaomi/i, '小米'],
  [/qiniu/i, '七牛云'],
  [/aihubmix/i, 'AiHubMix'],
  [/groq/i, 'Groq'],
  [/lepton/i, 'Lepton AI'],
  // ── 国际 ──
  [/openai/i, 'OpenAI'],
  [/anthropic|claude/i, 'Anthropic'],
  [/googleapis|gemini|vertex|palm|makersuite|deepmind/i, 'Google'],
  [/x\.ai|\bxai\b/i, 'xAI'],
  [/mistral/i, 'Mistral AI'],
  [/cohere/i, 'Cohere'],
  [/ai21/i, 'AI21 Labs'],
  [/perplexity/i, 'Perplexity'],
  [/nvidia|integrate\.api/i, '英伟达 NIM'],
  [/bedrock|amazonaws|aws/i, 'AWS Bedrock'],
  [/azure|microsoft/i, 'Azure OpenAI'],
  [/github/i, 'GitHub Models'],
  [/openrouter/i, 'OpenRouter'],
  [/302\.ai/i, '302.AI'],
  [/together/i, 'Together AI'],
  [/fireworks/i, 'Fireworks AI'],
  [/deepinfra/i, 'DeepInfra'],
  [/novita/i, 'Novita AI'],
  [/hyperbolic/i, 'Hyperbolic'],
  [/replicate/i, 'Replicate'],
  [/cerebras/i, 'Cerebras'],
  [/sambanova/i, 'SambaNova'],
  [/featherless/i, 'Featherless'],
  [/lambdalabs|lambda\.ai/i, 'Lambda Labs'],
  [/anyscale/i, 'Anyscale'],
  [/baseten/i, 'Baseten'],
  [/modal\.(com|run)/i, 'Modal'],
  [/huggingface|hf\.co/i, 'HuggingFace'],
  [/jina\.ai/i, 'Jina AI'],
  [/voyageai/i, 'Voyage AI'],
  [/aipais/i, 'AIPais'],
  // ── 本地部署（端口比域名更能说明是什么服务）──
  [/:(11434)\b|ollama/i, '本地 Ollama'],
  [/:(1234)\b|lmstudio/i, '本地 LM Studio'],
  [/:(8000|8080)\b|vllm/i, '本地 vLLM'],
  [/localhost|127\.0\.0\.1|0\.0\.0\.0/i, '本地服务']
];

/**
 * 模型别名。用 ^ 锚定开头（模型 id 都是「品牌-版本」格式），**顺序敏感**。
 * 三元组第三项 'keep' = 保持原始 id 不动（品牌名当后缀会被拼坏的那些，如 o3-mini、command-r）。
 */
const MODEL_ALIAS = [
  // ── 需要保持原样的特殊规则写在最前 ──
  [/^amazon[.\-_]?nova/i, 'Amazon Nova'],
  [/^gpt-image|^dall-?e|^sora/i, 'GPT 图像'],
  [/^o[134](?:[-_.]|$)/i, '', 'keep'],            // o1/o3/o4 是 OpenAI 的，但拼成「GPT-mini」会误导
  [/^command-?r|^c4ai-command/i, '', 'keep'],     // Cohere 的 command-r，拼成「Cohere-r」很怪
  [/^gpt-?oss/i, 'GPT-oss'],
  // ── 国内 ──
  [/^deepseek/i, '深度思索'],
  [/^(qwen|qwq|tongyi|qvq|qwen3)/i, '通义千问'],
  [/^wanx|^wan(?=[-_]?2)/i, '通义万相'],
  [/^gte/i, '阿里 GTE'],
  [/^cogvideo/i, '智谱 CogVideo'],
  [/^cogvlm/i, '智谱 CogVLM'],
  [/^(glm|chatglm|codegeex|autoglm)/i, '智谱'],
  [/^(kimi|moonshot)/i, 'Kimi'],
  [/^(doubao|seedream|seedance|seed-|skylark)/i, '豆包'],
  [/^(ernie|wenxin)/i, '文心一言'],
  [/^(hunyuan|yuanbao)/i, '混元'],
  [/^(minimax|abab)/i, 'MiniMax'],
  [/^yi[-_]/i, '零一万物'],
  [/^spark/i, '讯飞星火'],
  [/^step(?:fun)?/i, '阶跃星辰'],
  [/^baichuan/i, '百川智能'],
  [/^(nova|sensenova)/i, '商汤日日新'],
  [/^skywork/i, '昆仑万维天工'],
  [/^tiangong/i, '天工'],
  [/^(internlm|intern-?lm)/i, '书生'],
  [/^internvl/i, '书生 InternVL'],
  [/^(pangu|pan-?gu)/i, '华为盘古'],
  [/^(zhinao|360gpt)/i, '360 智脑'],
  [/^(minicpm|cpm)/i, '面壁 MiniCPM'],
  [/^xverse/i, '元象'],
  [/^(moss|fudan)/i, '复旦 MOSS'],
  [/^(langboat|mengzi)/i, '澜舟孟子'],
  [/^(yuan|wudao)/i, '智源悟道'],
  [/^(kling|keling)/i, '快手可灵'],
  [/^vidu/i, '生数 Vidu'],
  [/^(hailuo)/i, 'MiniMax 海螺'],
  [/^mimo/i, '小米 MiMo'],
  [/^longcat/i, '美团 LongCat'],
  // ── 国际 ──
  [/^(gpt|chatgpt|davinci|text-davinci|turbo)/i, 'GPT'],
  [/^claude/i, 'Claude'],
  [/^gemini/i, 'Gemini'],
  [/^gemma/i, 'Gemma'],
  [/^veo/i, 'Google Veo'],
  [/^imagen/i, 'Google Imagen'],
  [/^grok/i, 'Grok'],
  [/^sonar/i, 'Perplexity Sonar'],
  [/^llama/i, 'Llama'],
  [/^llava/i, 'LLaVA'],
  [/^(mistral|mixtral|magistral|pixtral|codestral|devstral|voxtral)/i, 'Mistral'],
  [/^phi(?=[-_]?\d)/i, 'Phi'],
  [/^command|c4ai/i, 'Cohere'],
  [/^aya/i, 'Cohere Aya'],
  [/^falcon/i, 'Falcon'],
  [/^jamba/i, 'AI21 Jamba'],
  [/^dbrx/i, 'Databricks DBRX'],
  [/^granite/i, 'IBM Granite'],
  [/^olmo/i, 'AI2 OLMo'],
  [/^starcoder|^bigcode/i, 'StarCoder'],
  [/^vicuna/i, 'Vicuna'],
  [/^lmsys/i, 'LMSYS'],
  [/^zephyr/i, 'Zephyr'],
  [/^openchat/i, 'OpenChat'],
  [/^dolphin/i, 'Dolphin'],
  [/^solar/i, 'Upstage Solar'],
  [/^exaone/i, 'LG EXAONE'],
  [/^hermes|nous/i, 'Nous Hermes'],
  [/^nemotron/i, '英伟达 Nemotron'],
  [/^stable-?diffusion|^sd[-_]?[0-9x]/i, 'Stable Diffusion'],
  [/^flux/i, 'FLUX'],
  [/^midjourney|^mj[-_]/i, 'Midjourney'],
  [/^suno/i, 'Suno'],
  [/^runway|^gen-?[0-9]/i, 'Runway'],
  [/^pika/i, 'Pika'],
  [/^whisper/i, 'Whisper'],
  [/^bge/i, 'BGE'],
  [/^m3e/i, 'M3E'],
  [/^text2vec/i, 'text2vec'],
  [/^text-embedding/i, '向量'],
  [/^embedding/i, '向量']
];

const isAsciiText = (s) => /^[\x20-\x7e]+$/.test(String(s ?? ''));

/**
 * 模型展示名。
 *  - 中文品牌 → 空格拼接：deepseek-v4-pro → 「深度思索 v4-pro」
 *  - 英文品牌 → 直接替换前缀（保持原有连字符）：gpt-4o-mini → 「GPT-4o-mini」
 *  - 命中 'keep' 规则或完全没命中 → 原样返回（renamed=false）
 * @returns {{name:string, renamed:boolean}}
 */
export function prettyModel(model) {
  const raw = String(model || '');
  for (const [re, cn, opt] of MODEL_ALIAS) {
    const m = raw.match(re);
    if (!m || !m[0]) continue;
    if (opt === 'keep') return { name: raw, renamed: false };
    const rest = raw.slice(m[0].length);
    if (!rest) return { name: cn, renamed: true };
    // 英文单字品牌且原 id 自带分隔符 → 紧贴（GPT-4o-mini / Kimi-k2）；
    // 其余（中文品牌、多词品牌、原 id 无分隔符）→ 用空格隔开（深度思索 v4-pro / MiniMax 6.5s-chat）
    const lead = /^[-_.]/.test(rest);
    const name = (isAsciiText(cn) && !cn.includes(' ') && lead)
      ? cn + rest
      : `${cn} ${rest.replace(/^[-_.\s]+/, '')}`;
    return { name, renamed: true };
  }
  return { name: raw, renamed: false };
}

/** 渠道展示名：命中别名表用中文，否则去掉 token./api./www. 之类前缀原样返回（不瞎猜）。 */
export function prettyVendor(domain) {
  const host = String(domain || '').trim();
  if (!host) return '';
  for (const [re, cn] of VENDOR_ALIAS) if (re.test(host)) return cn;
  return host.replace(/^(?:token|api|open|www|gateway|server|proxy)\./i, '');
}

// ── 峰谷时段（仅 DeepSeek 系模型有高峰档）─────────────────────────────
/** 北京时间偏移：峰谷判定必须用 UTC+8，不能跟着机器时区走（假日/改时区会算错）。 */
const TZ_MS = 8 * 3600 * 1000;
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 把时间戳格式化成「周一 09:00」（北京时间）。 */
function fmtBeijing(ts) {
  const d = new Date(ts + TZ_MS);
  return `${WEEKDAYS[d.getUTCDay()]} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/**
 * 下一次档位切换的时刻与方向。
 * 把未来 10 天高峰时段的**边界点**排序，取第一个让 isPeakHour 翻转的点。
 * @returns {{at:number|null, nowPeak:boolean}}
 */
function nextTierChange(at = Date.now()) {
  const nowPeak = isPeakHour(at);
  const bj = new Date(at + TZ_MS);
  const y = bj.getUTCFullYear();
  const mo = bj.getUTCMonth();
  const day = bj.getUTCDate();

  const cands = [];
  for (let i = 0; i < 10; i++) {
    for (const w of PEAK_WINDOWS) {
      cands.push(Date.UTC(y, mo, day + i, w.from) - TZ_MS);
      cands.push(Date.UTC(y, mo, day + i, w.to) - TZ_MS);
    }
  }
  cands.sort((a, b) => a - b);
  for (const t of cands) {
    if (t > at && isPeakHour(t) !== nowPeak) return { at: t, nowPeak };
  }
  return { at: null, nowPeak };
}

/**
 * 当前处于哪一档 —— **只在模型真的有高峰档时才返回**，否则 null。
 *
 * 2026-09-23 修：原判据是 `price.in || price.out ? (高峰档/闲时档) : null`，只看
 * "有没有价格"、没看"有没有高峰档"。于是**一口价模型**（如全系小米 MiMo，官方就是
 * 固定 ¥3/¥6）在高峰时段也会被贴上「高峰档」—— 用户看到的印象是"这个渠道在翻倍计费"，
 * 其实根本没有。档位标签出现在 4 处（文本卡花费行、面板徽章、渠道行…），全都由这里定，改一处即可。
 */
function tierLabel(price, at = Date.now()) {
  if (!price || !price.peak) return null;
  return isPeakHour(at) ? '高峰档' : '闲时档';
}

/** 有价、但价目条目没有高峰档 = 一口价（峰谷同价）。 */
function isFlatPriced(price) {
  return Boolean(price && !price.peak && (Number(price.in) || Number(price.out)));
}

/**
 * 「今日花费」行尾巴上的档位备注。
 *
 * 一口价模型标「不分峰谷」而不是什么都不显示：之前是空的，用户看到同一排面板里
 * 有的渠道有峰谷行、有的没有，会以为峰谷功能对这个渠道坏了（本次就是因此来问的）。
 * 文本卡与面板共用这一处，避免两边写法漂移。
 */
function tierNote(d) {
  if (!d) return '';
  if (d.tierNow) return `（${d.tierNow}）`;
  return d.flatPriced ? '（不分峰谷）' : '';
}

/** 峰谷信息（模型没有 peak 字段时返回 null —— 那些模型峰谷同价，不用显示）。 */
function peakInfo(price) {
  if (!price || !price.peak) return null;
  // 不能用 replace(/\.?0+$/) 去尾零 —— 会把 30 变成 3（没有小数点也照删）。
  const num = (n) => {
    const v = Number(n) || 0;
    return Number.isInteger(v) ? String(v) : String(parseFloat(v.toFixed(4)));
  };
  const { at, nowPeak } = nextTierChange();
  const tail = at
    ? (nowPeak ? `${fmtDur(at - Date.now())}后转闲时` : `${fmtDur(at - Date.now())}后转高峰（${fmtBeijing(at)}）`)
    : '';
  return {
    off: `¥${num(price.in)}/${num(price.out)}`,
    peak: `¥${num(price.peak.in)}/${num(price.peak.out)}`,
    schedule: PEAK_WINDOWS.map((w) => `${w.from}-${w.to}`).join('、'),
    nowPeak,
    tail
  };
}

/** 读 JSON 文件，失败返回 null（只读，绝不抛给调用方）。 */
function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    log(`读取 ${path.basename(file)} 失败：${e.message}`);
    return null;
  }
}

/**
 * 今日 token 用量。优先用 usage-today.json（核心统计文件）。
 */
function readTodayUsage() {
  const u = readJson(path.join(DATA_DIR, 'usage-today.json'));
  if (!u) return null;
  if (u.dayKey && u.dayKey !== localDay(Date.now())) return null;
  return {
    promptTokens: Number(u.promptTokens) || 0,
    completionTokens: Number(u.completionTokens) || 0,
    cachedTokens: Number(u.cachedTokens) || 0,
    totalTokens: Number(u.totalTokens) || 0,
    runs: Number(u.runs) || 0
  };
}

/**
 * 今日花费：扫 sessions/ 里今天的会话，按每条记录**发生的时刻**计价。
 * 为什么不用 usage-today 直接乘单价：那份文件只有全天汇总、没有时间点，
 * 而本模型高峰档是闲时的 2 倍，用单一档位乘会失真。
 */
function computeTodayCost(cfg, model) {
  const price = resolveModelPrice(model, cfg);
  const today = localDay(Date.now());
  const rows = [];
  const dir = path.join(DATA_DIR, 'sessions');

  try {
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        const j = readJson(path.join(dir, f));
        if (!j || !j.startedAt || !j.usage) continue;
        if (localDay(j.startedAt) !== today) continue;
        rows.push({
          at: j.startedAt,
          promptTokens: j.usage.promptTokens,
          completionTokens: j.usage.completionTokens,
          cachedTokens: j.usage.cachedTokens
        });
      }
    }
  } catch (e) {
    log(`扫描 sessions 目录失败：${e.message}`);
  }

  if (rows.length) {
    const r = sumCostByTime(rows, price);
    return { ...r, exact: true, sessions: rows.length };
  }

  // 兜底：会话文件不在了（被清理），用全天汇总 × 当前档位粗估
  const u = readTodayUsage();
  if (!u) return { cost: 0, peakCost: 0, offPeakCost: 0, exact: false, sessions: 0 };
  const p = priceAt(price, Date.now());
  const fresh = Math.max(0, u.promptTokens - u.cachedTokens);
  const cost =
    (fresh / 1e6) * p.in + (u.cachedTokens / 1e6) * p.cached + (u.completionTokens / 1e6) * p.out;
  return { cost, peakCost: 0, offPeakCost: cost, exact: false, sessions: 0 };
}

/** 今天最新的日志文件。 */
function latestLogFile() {
  const dir = path.join(DATA_DIR, 'logs');
  try {
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.log'));
    if (!files.length) return null;
    return files
      .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0].f;
  } catch {
    return null;
  }
}

/**
 * 运行健康：进程号 + 运行时长 + 日志规模 + 告警条数。
 * 运行时长用日志里**最后一次**「控制台已就绪」推。
 */
function readRuntime() {
  const out = { pid: null, uptimeMs: null, startedAt: null, logName: null, logSize: 0, warnings: 0 };

  const lock = path.join(DATA_DIR, 'qq-agent.lock');
  try {
    if (fs.existsSync(lock)) out.pid = String(fs.readFileSync(lock, 'utf8')).trim() || null;
  } catch { /* 锁文件读不到就算了 */ }

  const name = latestLogFile();
  if (!name) return out;
  out.logName = name;

  const file = path.join(DATA_DIR, 'logs', name);
  let text = '';
  try {
    const size = fs.statSync(file).size;
    out.logSize = size;
    const CAP = 512 * 1024;
    const start = Math.max(0, size - CAP);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch (e) {
    log(`读取日志失败：${e.message}`);
    return out;
  }

  const re = /(\d{2}):(\d{2}):(\d{2})\s+\[[A-Z ]+\]\s+\[app\]\s+控制台已就绪/g;
  let m;
  let last = null;
  while ((m = re.exec(text)) !== null) last = m;
  if (last) {
    const d = new Date();
    d.setHours(Number(last[1]), Number(last[2]), Number(last[3]), 0);
    out.startedAt = d.getTime();
    out.uptimeMs = Math.max(0, Date.now() - out.startedAt);
  }

  // ⚠️ 不能只匹「失败」二字：加载汇总行是「9 成功，0 失败」，会把正常启动全算成告警。
  for (const ln of text.split('\n')) {
    if (/\[ERROR\b|\[WARN\b|失败[：:]|错误[：:]|异常[：:]|超时|被拒/.test(ln)) out.warnings++;
  }
  return out;
}

/** 最近的节日倒计时（内置表，不联网，最长看 60 天）。 */
function readHoliday() {
  try {
    const h = upcomingHoliday(60);
    if (!h) return null;
    return { name: h.name, daysAway: h.daysAway, type: h.type };
  } catch (e) {
    log(`查询节日失败：${e.message}`);
    return null;
  }
}

// ── 系统资源（v1.4.0）──────────────────────────────────────────────────
// 插件和核心跑在**同一个进程**里，process.memoryUsage() 就是机器人本体的内存。
// Windows 的 os.loadavg() 恒为 [0,0,0]，所以 CPU 用 os.cpus() 两次采样算差值。

/** 汇总所有 CPU 核的累计时间（user/nice/sys/idle/irq）。 */
function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    for (const k of ['user', 'nice', 'sys', 'idle', 'irq']) total += c.times[k];
  }
  return { idle, total };
}

/**
 * CPU 占用率：两次采样差值。
 * 用 Atomics.wait 做同步等待（Node 主线程允许），保持 collectData 同步签名不变。
 * @returns {number|null} 百分比，失败返回 null
 */
function sampleCpu(ms = 120) {
  try {
    const a = cpuTimes();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    const b = cpuTimes();
    const dt = b.total - a.total;
    const di = b.idle - a.idle;
    if (dt <= 0) return null;
    return Math.max(0, Math.min(100, ((dt - di) / dt) * 100));
  } catch (e) {
    log(`CPU 采样失败：${e.message}`);
    return null;
  }
}

/**
 * 系统资源快照。
 * @returns {{rss:number,heapUsed:number,heapTotal:number,external:number,
 *   sysTotal:number,sysFree:number,sysUsedPct:number|null,cpuPct:number|null,procUptimeMs:number}}
 */
function readSystem() {
  let mem = null;
  try { mem = process.memoryUsage(); } catch { /* 理论上不会失败 */ }
  const sysTotal = os.totalmem() || 0;
  const sysFree = os.freemem() || 0;
  const sysUsedPct = sysTotal > 0 ? ((sysTotal - sysFree) / sysTotal) * 100 : null;
  return {
    rss: mem?.rss ?? 0,
    heapUsed: mem?.heapUsed ?? 0,
    heapTotal: mem?.heapTotal ?? 0,
    external: mem?.external ?? 0,
    sysTotal, sysFree, sysUsedPct,
    cpuPct: sampleCpu(),
    procUptimeMs: process.uptime() * 1000
  };
}

/** 健康提示：内存/CPU 超阈值才说话，正常时不吵。 */
function healthTips(sys) {
  const tips = [];
  if (sys.rss > 1.5 * 1024 * 1024 * 1024) {
    tips.push(`进程内存 ${fmtSize(sys.rss)} 偏大，可考虑重启机器人`);
  }
  if (sys.sysUsedPct != null && sys.sysUsedPct > 90) {
    tips.push(`系统内存已用 ${sys.sysUsedPct.toFixed(0)}%，余量吃紧`);
  }
  if (sys.cpuPct != null && sys.cpuPct > 85) {
    tips.push(`CPU 占用 ${sys.cpuPct.toFixed(0)}% 偏高`);
  }
  return tips;
}

// ── 插件状态枢纽（v1.4.1）────────────────────────────────────────────────
// 让「以后新加的插件」不用改 ai-status 一行代码就能上报自己的状态。
//
// 协议：插件导出一个名为 status.<自己的插件id> 的能力（providers 对象的键），
//   export const providers = {
//     'status.你的插件id': () => ({
//       icon: '🎵',              // 可选，默认 🧩
//       title: '音乐点播',        // 必填，显示为格子标题
//       lines: [['今日点歌', '12 首'], ['曲库', '348 首']],  // 可选，最多显示 4 条
//       tips: ['曲库索引未建好'], // 可选，健康提示（会并入面板顶部徽章）
//       priority: 60             // 可选，越小越靠前，默认 50
//     })
//   };
// 约定（很重要）：
//   1. 必须同步返回（拿现成缓存值），禁止 IO / await —— 核心的 capability() 是同步调用
//   2. 返回 null / undefined = 本次不上报（比如功能今天没被用过，就不占格子）
//   3. 抛异常会被这里吞掉并跳过 —— 一个插件的状态坏了不能拖垮整张卡
//   4. 状态扫描只在用户查状态的那一刻发生，平时零开销
// 参考：plugins/mute-guard 里的 status.mute-guard 是第一个接入示范。

/**
 * 扫描 plugins/ 与 skills/ 目录，逐个探测 status.<id> 能力。
 * 目录名 = 插件 id（plugin-loader 的注册规则），所以能力名天然不冲突。
 * @returns {{id:string,icon:string,title:string,lines:string[],tips:string[],priority:number}[]}
 */
function collectPluginStatus() {
  const out = [];
  if (!apiRef?.capability) return out; // 纯 Node 单测时没有插件 API，直接空
  const roots = [
    path.resolve(import.meta.dirname, '..'),                 // plugins/
    path.resolve(import.meta.dirname, '..', '..', 'skills')  // skills/ 也能上报
  ];
  const seen = new Set();
  for (const root of roots) {
    let dirs;
    try {
      if (!fs.existsSync(root)) continue;
      dirs = fs.readdirSync(root, { withFileTypes: true });
    } catch { continue; }
    for (const e of dirs) {
      if (!e.isDirectory() || seen.has(e.name)) continue;
      seen.add(e.name);
      const dir = path.join(root, e.name);
      const hasManifest = fs.existsSync(path.join(dir, 'plugin.json'))
        || fs.existsSync(path.join(dir, 'skill.json'));
      if (!hasManifest) continue;
      let info;
      try { info = apiRef.capability('status.' + e.name); } catch { continue; }
      if (!info || typeof info !== 'object') continue;
      const title = String(info.title || '').trim();
      if (!title) continue;
      out.push({
        id: e.name,
        icon: String(info.icon || '🧩').slice(0, 4),
        title,
        lines: (Array.isArray(info.lines) ? info.lines : [])
          .filter((p) => Array.isArray(p) && String(p[0] ?? '') !== '' && String(p[1] ?? '') !== '')
          .slice(0, 4)
          .map(([k, v]) => `${k} ${v}`),
        tips: (Array.isArray(info.tips) ? info.tips : [])
          .filter(Boolean).slice(0, 2).map(String),
        priority: Number(info.priority) || 50,
        // v1.4.5：上报方自声明「仅管理员可见」——非管理员视图中整条隐藏
        adminOnly: info.adminOnly === true
      });
    }
  }
  out.sort((a, b) => (a.priority - b.priority) || a.title.localeCompare(b.title, 'zh'));
  return out;
}


// ═══════════════════════════════════════════════════════════════════════
// 数据汇总：一次收集，文本卡与面板图共用
// ═══════════════════════════════════════════════════════════════════════

function collectData() {
  const cfg = getConfig();
  const model = cfg.api?.model || '(未配置)';
  const rawVendor = vendorOfConfig(cfg) || '';
  const vendor = rawVendor.replace(/^https?:\/\//, '').replace(/^www\./, '');
  const m = prettyModel(model);
  const vendorName = prettyVendor(vendor);

  const price = resolveModelPrice(model, cfg);
  const cost = computeTodayCost(cfg, model);
  const usage = readTodayUsage();
  const peak = peakInfo(price);
  const runtime = readRuntime();
  const holiday = readHoliday();
  const system = readSystem();
  // 运行时长兜底：日志里找不到「控制台已就绪」时，用进程实际 uptime（插件与核心同进程）
  if (runtime.uptimeMs == null && system.procUptimeMs > 0) {
    runtime.uptimeMs = system.procUptimeMs;
  }
  const plugins = collectPluginStatus();
  // tips 带来源（src=插件id，系统提示为 null），门禁裁掉某插件时能同步裁掉它的 tips
  const tips = [
    ...healthTips(system).map((text) => ({ text, src: null })),
    ...plugins.flatMap((p) => p.tips.map((text) => ({ text: String(text), src: p.id })))
  ];

  // 限速统计：软依赖 rate-guard；现场取，不缓存引用（热重载会换掉）
  let rateStats = null;
  try {
    const s = apiRef?.capability?.('llm.rate-stats');
    if (s && s.throttled > 0) rateStats = s;
  } catch { /* 软依赖 */ }

  const budget = Number(cfg.budget?.dailyCostYuan) || 0;
  const cacheRate =
    usage && usage.promptTokens > 0 ? (usage.cachedTokens / usage.promptTokens) * 100 : null;

  // ── 花费"显示"覆盖（软依赖 cost.display-override）──────────────────────
  // 别的插件（如「空城计」）可以把面板上的「今日花费」换成自己的文案，
  // **只改展示**：真花多少仍由 computeTodayCost 算，用量/预算统计一律不动。
  // 为什么是软依赖：没装这类插件时状态卡照常显示真值，绝不能因为少了它就报
  // "依赖未就绪"——那会把一个娱乐插件变成核心功能的硬门槛。
  // 为什么只收字符串不收数字：虚报值可能是「2.58万亿元」这种带中文单位的写法，
  // 交给 fmtMoney 会被格式化成 ¥2580000000000.00，整活效果反而没了。
  let costOverride = null;
  try {
    // 能力名只能是「小写点分」，且**首段不允许连字符**（tools-skill-audit 闸门），
    // 所以是 cost.display-override 而不是 ai-status.cost-override
    const o = apiRef?.capability?.('cost.display-override');
    const t = o && typeof o === 'object' ? String(o.text ?? '').trim() : '';
    if (t) costOverride = { text: t, by: String(o.by || '').trim() || null };
  } catch (e) {
    log(`读取花费覆盖失败（按真实金额显示）：${e?.message ?? e}`);
  }

  return {
    model, vendor, vendorName, modelName: m.name, modelRenamed: m.renamed,
    cost, usage, peak, runtime, holiday, rateStats, budget, cacheRate,
    system, tips, plugins, costOverride,
    tierNow: tierLabel(price),
    // 一口价（有价但无高峰档）单独标记：卡片上标一句「不分峰谷」，
    // 免得用户看到别的渠道有峰谷行、这个没有，以为功能坏了
    flatPriced: isFlatPriced(price),
    costExact: cost.exact
  };
}

/**
 * 「今日花费」的展示文案：有插件覆盖就用覆盖值，否则用真实金额。
 * 文本卡与面板图共用这一处，避免两边写法漂移（一边改了另一边忘改）。
 */
function costText(d) {
  if (d.costOverride && d.costOverride.text) return String(d.costOverride.text);
  return fmtMoney(d.cost.cost) + (d.costExact ? '' : '（约）');
}

/** 6 行文本卡（回退用，格式与 v1.2 一致）。 */
function textCard(d) {
  const lines = [];
  const peakNow = d.peak ? d.peak.nowPeak : false;
  const hid = (k) => d.hidden instanceof Set && d.hidden.has(k);
  // 中文展示名；被改名过就把原始 id 用括号带上，方便排障时对得上配置
  const modelText = d.modelRenamed ? `${d.modelName}（${d.model}）` : d.modelName;
  const modelPart = hid('model') ? '' : modelText;
  const vendorPart = hid('vendor') ? '' : (d.vendorName || '');
  if (modelPart && vendorPart) lines.push(`📊 ${modelPart} · ${vendorPart}`);
  else if (modelPart) lines.push(`📊 ${modelPart}`);
  else if (vendorPart) lines.push(`📊 渠道 ${vendorPart}`);
  else lines.push('📊 模型与渠道 未公开');

  // 档位备注：有高峰档就标「高峰档/闲时档」，一口价标「不分峰谷」；
  // 「峰谷」设为仅管理员时整条都不显示（与峰谷行同进退）
  const unit = hid('peak') ? '' : tierNote(d);
  if (!hid('cost')) {
    // 覆盖值不是算出来的，前面的「约」没有意义，去掉
    lines.push(`💰 今日${d.costOverride || d.costExact ? '' : '约'}花费 ${costText(d)}${unit}`);
  }

  // 预算行用真实金额去比：覆盖值是个文案（可能是「2.58万亿元」），
  // 拿它算百分比会得到「用掉 1.2e12%」这种鬼话 —— 有覆盖时直接不显示这行
  if (d.budget > 0 && !hid('cost') && !hid('budget') && !d.costOverride) {
    const pct = Math.min(100, (d.cost.cost / d.budget) * 100);
    const left = Math.max(0, d.budget - d.cost.cost);
    lines.push(
      `　预算 ${fmtMoney(d.cost.cost)} / ${fmtMoney(d.budget)}`
      + `（用掉 ${pct.toFixed(1)}%，剩 ${fmtMoney(left)}）`
    );
  }

  if (hid('usage')) {
    // 用量被设为仅管理员：整行跳过
  } else if (d.usage) {
    const rate = d.cacheRate == null ? '—' : d.cacheRate.toFixed(1) + '%';
    lines.push(
      `🔢 用量 ${fmtTok(d.usage.totalTokens)}（入 ${fmtTok(d.usage.promptTokens)} / 出 ${fmtTok(d.usage.completionTokens)}）`
      + ` · 缓存 ${rate} · ${d.usage.runs} 次`
    );
  } else {
    lines.push('🔢 用量 今日暂无数据');
  }

  if (d.peak) {
    lines.push(
      `⏰ 峰谷 闲时 ${d.peak.off} · 高峰 ${d.peak.peak} 每百万（工作日 ${d.peak.schedule}）`
      + `· 当前${d.peak.nowPeak ? '高峰' : '闲时'}${d.peak.tail ? '，' + d.peak.tail : ''}`
    );
  }

  if (d.rateStats) {
    const ms = Math.round(d.rateStats.waitedMs);
    const w = ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms';
    lines.push(`🚦 限速 已推迟 ${d.rateStats.throttled} 次（累计等 ${w}，上限 ${d.rateStats.maxPerMinute} 次/分）`);
  }

  const rt = d.runtime;
  if (!hid('runtime')) {
    const upText = rt.uptimeMs == null ? '时长未知' : '已运行 ' + fmtDur(rt.uptimeMs);
    lines.push(`🟢 ${upText}${rt.pid ? ' · PID ' + rt.pid : ''}`);
  }

  if (rt.logName) {
    const warnText = rt.warnings > 0 ? `告警 ${rt.warnings} 条` : '无告警';
    lines.push(`📄 日志 ${fmtSize(rt.logSize)} · ${warnText}`);
  }

  if (d.holiday) {
    lines.push(
      d.holiday.daysAway === 0
        ? `🎉 今天是${d.holiday.name}`
        : `🎉 距${d.holiday.name}还有 ${d.holiday.daysAway} 天`
    );
  }

  // 各插件上报的状态（status.<插件id> 能力协议），每个插件一行
  for (const p of d.plugins || []) {
    lines.push(`${p.icon} ${p.title}${p.lines.length ? '：' + p.lines.join(' · ') : ''}`);
  }

  if (d.system) {
    const s = d.system;
    const cpuTxt = s.cpuPct == null ? '—' : s.cpuPct.toFixed(0) + '%';
    const sysMemTxt = s.sysUsedPct == null
      ? '—'
      : `${s.sysUsedPct.toFixed(0)}%（剩 ${fmtSize(s.sysFree)}）`;
    lines.push(`🖥️ 系统 进程内存 ${fmtSize(s.rss)} · 系统 ${sysMemTxt} · CPU ${cpuTxt}`);
    const tipTexts = (d.tips || []).map((t) => (typeof t === 'string' ? t : t.text));
    if (tipTexts.length) lines.push(`　⚠️ ${tipTexts.join('；')}`);
  }

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════
// 面板图：HTML 生成（导出供测试）+ Electron 离屏截图
// ═══════════════════════════════════════════════════════════════════════

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── 面板配色（v1.4.2）───────────────────────────────────────────────────
// 两套主题，CSS 变量注入；dark 的取值与 v1.4.1 完全一致（老用户无感升级）。
// 切换入口：控制台「插件 → AI状态查询 → 面板配色 theme」（light / dark）。
const THEMES = {
  dark: {
    page: '#0e1014', card: '#14171d', border: '#262b35', dot: '#3dd68c',
    h1: '#e8eaee', badge: '#8b93a1', section: '#6f7887',
    cell: '#1b1f27', clabel: '#7f8896', cvalue: '#eef0f4', csub: '#6f7887',
    bar: '#262b35', fill: '#4c8dff', barpct: '#c6ccd6',
    chipV: '#c6ccd6', foot: '#4d5563'
  },
  light: {
    page: '#e9ebf0', card: '#ffffff', border: '#dfe3ea', dot: '#1f9d61',
    h1: '#1a2030', badge: '#67707f', section: '#7c8595',
    cell: '#f4f6f9', clabel: '#6b7484', cvalue: '#171d29', csub: '#7c8595',
    bar: '#e3e7ee', fill: '#2f6fe4', barpct: '#3c4657',
    chipV: '#343e4e', foot: '#9aa3b2'
  }
};

/** 读面板配色设置：只有显式给 'light' 才用浅色，其余（含未设置）一律深色。 */
export function readTheme() {
  try {
    return cfgFn?.()?.theme === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

// ── 管理员门禁（v1.4.5：逐项可配置）────────────────────────────────────
// 哪些状态项只给管理员看，由插件设置 adminOnly 决定（逗号/空格分隔的键名列表，
// 支持中文别名，见 ADMIN_ITEMS）。默认 system,plugins,tips,pid。
// 管理员口径 = owner-identity 插件的主人名单（只认 QQ 号，正文自称无效）；
// 调用方身份来自 ctx.session.trigger 的 senderId（协议字段，不是聊天正文）。
// 安全兜底：主人名单一个都没填时，门禁整体关闭（保持旧行为，不把人锁在门外）。

/** 所有可单独设为「仅管理员」的状态项（key → 中文别名，用于设置解析）。 */
const ADMIN_ITEMS = {
  model:    ['模型', '当前模型'],
  vendor:   ['渠道', '渠道商'],
  system:   ['系统资源', '内存', 'cpu'],
  plugins:  ['插件状态', '插件'],
  tips:     ['健康提示', '健康'],
  pid:      ['进程号', 'pid'],
  cost:     ['花费', '成本', '今日花费', '金额'],
  usage:    ['用量', 'token', 'tokens'],
  peak:     ['峰谷', '峰谷时段'],
  rate:     ['限速', '限速统计'],
  logs:     ['日志', '告警'],
  budget:   ['预算'],
  holiday:  ['节日', '倒计时'],
  runtime:  ['运行时长', '时长']
};

/** 解析 adminOnly 设置（逗号/空格/顿号分隔），返回规范化 key 的 Set。 */
export function parseAdminOnly(input) {
  const out = new Set();
  if (typeof input !== 'string') return out;
  const aliasMap = new Map();
  for (const [key, aliases] of Object.entries(ADMIN_ITEMS)) {
    aliasMap.set(key, key);
    for (const a of aliases) aliasMap.set(a.toLowerCase(), key);
  }
  for (const raw of input.split(/[,，、\s]+/)) {
    if (!raw) continue;
    const tok = raw.trim();
    // plugins.<id>：点名某个插件的状态仅管理员可见
    if (/^plugins\.[\w.-]+$/.test(tok)) {
      out.add(tok.toLowerCase());
      continue;
    }
    const key = aliasMap.get(tok.toLowerCase());
    if (key) out.add(key);
  }
  return out;
}

/** owner-identity 是否配置了主人名单（读核心 config 的 skills 段，只读）。 */
function ownerGateConfigured() {
  try {
    return String(getConfig()?.skills?.['owner-identity']?.ids ?? '').trim() !== '';
  } catch {
    return false;
  }
}

/**
 * owner-identity 是否真的在场且能响应 owner-check。
 * 只看配置不够：装过又删掉的话配置会残留，门禁会一直上膛却没人能通过
 * （所有人包括主人都看不到敏感分区）。探测能力本身在不在才是准的。
 */
function ownerCheckAvailable() {
  try {
    return apiRef?.capability?.('message.owner-check', { userId: -1 }) != null;
  } catch {
    return false;
  }
}

/** 门禁开关（插件设置 sensitiveAdminOnly，默认开）。 */
function gateEnabled() {
  try {
    return cfgFn?.()?.sensitiveAdminOnly !== false;
  } catch {
    return true;
  }
}

/** 读 adminOnly 设置；未设置时用默认四件套。 */
function gateKeys() {
  const raw = cfgFn?.()?.adminOnly;
  if (typeof raw !== 'string' || !raw.trim()) {
    return new Set(['system', 'plugins', 'tips', 'pid']);
  }
  return parseAdminOnly(raw);
}

/**
 * 触发本次运行的消息里，最后一条是不是管理员（主人名单）发的。
 * 只看「最后一条非机器人消息」的发送者——状态查询是对最新消息的响应；
 * 之前按「整批任一条是管理员就算」，管理员在群里闲聊 + 普通群友问状态
 * 会把敏感面板发给全群（2026-09-21 实际越权事故）。
 * 宁可少显示（管理员问完有人插话会看到精简版）也不多显示。
 */
function isAdminCaller(ctx) {
  try {
    const entries = Array.isArray(ctx?.session?.trigger) ? ctx.session.trigger : [];
    let last = null;
    for (let i = entries.length - 1; i >= 0; i--) {
      const m = entries[i];
      if (m && !m.self) { last = m; break; }
    }
    if (!last) return false;
    const r = apiRef?.capability?.('message.owner-check', { userId: last.senderId });
    return !!(r && r.isOwner === true);
  } catch { /* 软依赖：owner-identity 不在就当没有管理员 */ }
  return false;
}

/**
 * 非管理员视图：按 keys 逐项裁剪。
 * 大部分项直接置空（渲染端本来就有 null 守卫）；cost / usage / runtime
 * 渲染端是无条件输出的，改用 d.hidden 标记让渲染端跳过或显示「未公开」。
 */
function stripSensitive(d, keys) {
  d.hidden = keys;
  if (keys.has('system')) d.system = null;
  if (keys.has('tips')) {
    d.tips = [];
  } else if (!keys.has('plugins')) {
    // tips 没整体隐藏时，只保留「未被裁掉的插件」和系统提示的 tips
    const removed = new Set(d.plugins.filter((p) => isPluginGated(p, keys)).map((p) => p.id));
    if (removed.size) d.tips = d.tips.filter((t) => !t.src || !removed.has(t.src));
  }
  if (keys.has('plugins')) {
    d.plugins = [];
  } else {
    d.plugins = d.plugins.filter((p) => !isPluginGated(p, keys));
  }
  if (keys.has('pid') && d.runtime) d.runtime.pid = null;
  if (keys.has('peak')) { d.peak = null; d.flatPriced = false; }
  if (keys.has('rate')) d.rateStats = null;
  if (keys.has('budget')) d.budget = 0;
  if (keys.has('holiday')) d.holiday = null;
  if (keys.has('logs') && d.runtime) d.runtime.logName = null;
  // cost / usage / runtime 通过 d.hidden 标记，由 textCard / buildCardHtml 处理
  return d;
}

/** 某插件的状态是否被门禁裁掉：上报方自声明，或配置里点名 plugins.<id>。 */
function isPluginGated(p, keys) {
  return p.adminOnly === true || keys.has('plugins.' + p.id);
}

/**
 * 生成面板 HTML。设计稿宽 720，SCALE=2 输出 1440 宽的高清图。
 * 纯字符串拼接，不依赖任何 DOM —— 可以在纯 Node 里单测。
 * theme 可选 'dark'（默认）/ 'light'。
 */
export function buildCardHtml(d, { scale = 2, theme = 'dark' } = {}) {
  const t = THEMES[theme] || THEMES.dark;
  const s = (n) => n * scale; // 所有尺寸统一放大，得到高清 PNG
  const hid = (k) => d.hidden instanceof Set && d.hidden.has(k);
  const cell = (label, value, sub) => `
    <div class="cell">
      <div class="clabel">${esc(label)}</div>
      <div class="cvalue">${esc(value)}</div>
      ${sub ? `<div class="csub">${esc(sub)}</div>` : ''}
    </div>`;

  // ── 各分区 ──
  // 只在真有高峰档时才拼两档价；一口价模型这里的值不会被用到（peakChip 走另一支）
  const tiers = d.peak ? `闲时 ${d.peak.off} · 高峰 ${d.peak.peak} 每百万` : '';
  // 峰谷 chip：有高峰档的模型报时段与两档价；一口价模型也报一句 ——
  // 不报的话用户看到"别的渠道有这行、这个没有"会以为功能坏了
  const peakChip = d.peak
    ? chip(`峰谷时段`, `工作日 ${d.peak.schedule} · 当前${d.peak.nowPeak ? '高峰' : '闲时'}`
      + `${d.peak.tail ? '，' + d.peak.tail : ''}（${tiers}）`)
    : (d.flatPriced ? chip('峰谷', '该模型一口价，不分峰谷') : '');
  const rateChip = d.rateStats
    ? chip('请求限速',
      `已推迟 ${d.rateStats.throttled} 次 · 累计等待 ${fmtWait(d.rateStats.waitedMs)}`
      + ` · 上限 ${d.rateStats.maxPerMinute} 次/分`)
    : '';
  const logChip = d.runtime.logName
    ? chip('日志', `${fmtSize(d.runtime.logSize)} · ${d.runtime.warnings > 0 ? '告警 ' + d.runtime.warnings + ' 条' : '无告警'}`
      + `${d.runtime.pid ? ' · PID ' + d.runtime.pid : ''}`)
    : '';
  const holidayChip = d.holiday
    ? chip('节日', d.holiday.daysAway === 0
      ? `今天是${d.holiday.name}`
      : `距${d.holiday.name}还有 ${d.holiday.daysAway} 天`)
    : '';
  const healthChip = d.tips && d.tips.length
    ? chip('健康提示', d.tips.map((x) => (typeof x === 'string' ? x : x.text)).join('；'))
    : '';
  const budgetChip = d.budget > 0 && !d.costOverride   // 同上：假数算不出有意义的预算占比
    ? chip('预算', `${fmtMoney(d.cost.cost)} / ${fmtMoney(d.budget)}（剩 ${fmtMoney(Math.max(0, d.budget - d.cost.cost))}）`)
    : '';

  const usageRow = hid('usage')
    ? '' // 用量设为仅管理员：整个分区不渲染
    : d.usage
    ? `
    <div class="section">今日用量</div>
    <div class="grid4">
      ${cell('总 token', fmtTok(d.usage.totalTokens))}
      ${cell('输入', fmtTok(d.usage.promptTokens))}
      ${cell('输出', fmtTok(d.usage.completionTokens))}
      ${cell('运行次数', String(d.usage.runs))}
    </div>
    <div class="barline">
      <div class="clabel">缓存命中率</div>
      <div class="bar"><div class="fill" style="width:${Math.max(2, Math.min(100, d.cacheRate ?? 0)).toFixed(1)}%"></div></div>
      <div class="barpct">${d.cacheRate == null ? '—' : d.cacheRate.toFixed(1) + '%'}</div>
    </div>`
    : `
    <div class="section">今日用量</div>
    <div class="grid1">${cell('今日用量', '暂无数据')}</div>`;

  const chips = [healthChip, budgetChip, peakChip, rateChip, logChip, holidayChip].filter(Boolean).join('');

  // ── 系统资源分区 ──
  const sys = d.system;
  const sysSection = sys ? `
    <div class="section">系统资源</div>
    <div class="grid3">
      ${cell('进程内存', fmtSize(sys.rss), `堆 ${fmtSize(sys.heapUsed)} / ${fmtSize(sys.heapTotal)}`)}
      ${cell('系统内存', sys.sysUsedPct == null ? '—' : sys.sysUsedPct.toFixed(0) + '%',
        `剩 ${fmtSize(sys.sysFree)} / 共 ${fmtSize(sys.sysTotal)}`)}
      ${cell('CPU 占用', sys.cpuPct == null ? '—' : sys.cpuPct.toFixed(0) + '%', `进程已跑 ${fmtDur(sys.procUptimeMs)}`)}
    </div>` : '';

  // 各插件上报的状态（status.<插件id> 能力协议），每个插件一条 chip
  const pluginChips = (d.plugins || [])
    .map((p) => chip(`${p.icon} ${p.title}`, p.lines.length ? p.lines.join(' · ') : '已启用'))
    .join('');
  const pluginSection = pluginChips
    ? `\n    <div class="section">插件状态</div>\n    <div class="chips" style="margin-top:0">${pluginChips}</div>`
    : '';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  :root {
    --page:${t.page}; --card:${t.card}; --border:${t.border}; --dot:${t.dot};
    --h1:${t.h1}; --badge:${t.badge}; --section:${t.section};
    --cell:${t.cell}; --clabel:${t.clabel}; --cvalue:${t.cvalue}; --csub:${t.csub};
    --bar:${t.bar}; --fill:${t.fill}; --barpct:${t.barpct};
    --chipv:${t.chipV}; --foot:${t.foot};
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { background:var(--page); }
  body {
    width:${s(720)}px;
    font-family:"Microsoft YaHei","PingFang SC","Segoe UI",sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  .card {
    width:${s(720)}px;
    background:var(--card);
    border:1px solid var(--border);
    border-radius:${s(16)}px;
    padding:${s(26)}px ${s(26)}px ${s(20)}px;
  }
  .head { display:flex; align-items:center; justify-content:space-between; margin-bottom:${s(20)}px; }
  .title { display:flex; align-items:center; gap:${s(10)}px; }
  .dot { width:${s(10)}px; height:${s(10)}px; border-radius:50%; background:var(--dot); }
  .h1 { color:var(--h1); font-size:${s(19)}px; font-weight:600; letter-spacing:${s(0.5)}px; }
  .badge { color:var(--badge); font-size:${s(13)}px; }
  .section { color:var(--section); font-size:${s(12.5)}px; margin:${s(18)}px 0 ${s(9)}px; }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:${s(10)}px; }
  .grid4 { display:grid; grid-template-columns:repeat(4,1fr); gap:${s(10)}px; }
  .grid3 { display:grid; grid-template-columns:repeat(3,1fr); gap:${s(10)}px; }
  .grid1 { display:grid; grid-template-columns:1fr; gap:${s(10)}px; }
  .cell { background:var(--cell); border:1px solid var(--border); border-radius:${s(12)}px; padding:${s(14)}px ${s(16)}px; }
  .clabel { color:var(--clabel); font-size:${s(12.5)}px; margin-bottom:${s(7)}px; }
  .cvalue { color:var(--cvalue); font-size:${s(21)}px; font-weight:600; line-height:1.25;
            overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .csub { color:var(--csub); font-size:${s(12)}px; margin-top:${s(5)}px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .barline { display:flex; align-items:center; gap:${s(12)}px; background:var(--cell); border:1px solid var(--border);
             border-radius:${s(12)}px; padding:${s(12)}px ${s(16)}px; margin-top:${s(10)}px; }
  .barline .clabel { margin:0; white-space:nowrap; }
  .bar { flex:1; height:${s(8)}px; background:var(--bar); border-radius:${s(4)}px; overflow:hidden; }
  .fill { height:100%; background:var(--fill); border-radius:${s(4)}px; }
  .barpct { color:var(--barpct); font-size:${s(13)}px; min-width:${s(48)}px; text-align:right; }
  .chips { display:flex; flex-direction:column; gap:${s(8)}px; margin-top:${s(18)}px; }
  .chip { display:flex; align-items:baseline; gap:${s(12)}px; background:var(--cell); border:1px solid var(--border);
          border-radius:${s(10)}px; padding:${s(10)}px ${s(14)}px; }
  .chip .k { color:var(--clabel); font-size:${s(12.5)}px; white-space:nowrap; }
  .chip .v { color:var(--chipv); font-size:${s(13)}px; line-height:1.5; }
  .foot { margin-top:${s(18)}px; color:var(--foot); font-size:${s(11.5)}px; text-align:center; }
</style></head>
<body><div class="card">
  <div class="head">
    <div class="title"><div class="dot"></div><div class="h1">QQ-agent 状态</div></div>
    <div class="badge">在线${d.tierNow && !hid('peak') ? ' · ' + esc(d.tierNow) : ''}</div>
  </div>

  <div class="section">模型</div>
  <div class="grid2">
    ${cell('当前模型', hid('model') ? '未公开' : (d.modelName || d.model),
      !hid('model') && d.modelRenamed ? d.model : '')}
    ${cell('渠道 / 计费档', hid('vendor') ? '未公开'
      : `${d.vendorName || '—'}${d.tierNow && !hid('peak') ? ' · ' + d.tierNow : ''}`,
      !hid('vendor') ? (d.vendor || '') : '')}
  </div>

  ${usageRow}

  <div class="section">成本与活动</div>
  <div class="grid3">
    ${cell('今日花费', hid('cost') ? '未公开' : costText(d))}
    ${cell('今日会话', d.cost.sessions + ' 次')}
    ${hid('runtime')
      ? cell('运行状态', '未公开')
      : cell(d.runtime.uptimeMs == null ? '运行状态' : '已运行',
        d.runtime.uptimeMs == null ? '未知' : fmtDur(d.runtime.uptimeMs))}
  </div>

  ${sysSection}
  ${pluginSection}

  ${chips ? `<div class="chips">${chips}</div>` : ''}
  <div class="foot">QQ-agent 0.4 · ${new Date().toLocaleString('zh-CN', { hour12: false })}</div>
</div></body></html>`;

  function chip(k, v) {
    return `<div class="chip"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`;
  }
}

function fmtWait(ms) {
  const v = Math.round(Number(ms) || 0);
  return v >= 1000 ? (v / 1000).toFixed(1) + 's' : v + 'ms';
}

// ── Electron 离屏截图 ────────────────────────────────────────────────────
const CARD_W = 720;
const RENDER_TIMEOUT_MS = 8000;

let rendering = false; // 同一时刻只渲染一张（防并发截图抢资源）

/**
 * 把数据渲染成 PNG Buffer。
 * 纯净 Node 里 import('electron') 拿到的是字符串（二进制路径），不是 API —— 返回 null。
 * @returns {Promise<Buffer|null>}
 */
export async function renderCardPng(data, { theme = 'dark' } = {}) {
  let electron = null;
  try {
    const mod = await import('electron');
    electron = mod?.default ?? mod;
  } catch {
    return null;
  }
  if (!electron || typeof electron.BrowserWindow !== 'function') return null;

  if (rendering) return null;
  rendering = true;
  let win = null;
  let tmpHtml = null;
  try {
    win = new electron.BrowserWindow({
      show: false,
      skipTaskbar: true,
      frame: false,
      useContentSize: true,
      // ⚠️ 初始高度必须给小（220）。BrowserWindow 默认 800×600，而下面量高度用的
      //    documentElement.scrollHeight 在**内容比视口矮**时返回的是视口高度、不是内容高度
      //    —— 矮卡会按 600 截图，下面一大截空白（2026-09-21 在 mc-status 上实测确认的坑）。
      width: CARD_W * 2,
      height: 220,
      // ⚠️ 必须设窗口背景色：高度取整后实际渲染高度可能带亚像素，窗口矮 1px 就在右/下
      //    露出 Electron 默认白线。跟面板底色一致后就算露出也看不出来。
      backgroundColor: THEMES[theme]?.page || '#0e1014',
      webPreferences: {
        offscreen: true,
        backgroundThrottling: false,
        // ⚠️ 必须关掉渲染进程沙箱：沙箱渲染进程加载本地 file:// 会被直接杀掉
        //（实测 "Renderer process killed" → loadFile ERR_FAILED (-2)）。
        // 内容是本插件自己生成的 HTML，无用户输入，关沙箱无风险。
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    // ⚠️ 不用 data: URL —— HTML 有 8KB+，实测 loadURL('data:...') 会报 ERR_FAILED (-2)。
    // 写临时文件再 loadFile，最稳（用完即删）。
    // ⚠️ 必须赋给外层的 tmpHtml：这里若写 const 会声明一个同名局部变量，把 finally
    //    里判空的外层变量遮蔽掉，"用完即删"永远不会执行，每次渲染往系统 tmp 泄漏一个文件。
    tmpHtml = path.join(os.tmpdir(), 'qq-agent-status-card.html');
    fs.writeFileSync(tmpHtml, buildCardHtml(data, { theme }));
    try {
      await win.loadFile(tmpHtml);
    } catch (e) {
      throw new Error(`加载面板 HTML 失败：${e?.message ?? e}`);
    }

    // 等首帧绘制（offscreen 窗口会发 paint 事件），再量内容高度、按实际高度重设窗口
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      win.webContents.once('paint', finish);
      setTimeout(finish, 400); // 兜底：个别环境 paint 事件可能晚到/不发
    });
    // 量**内容**高度：body 实际撑开的高度（含卡片底边+body 下内边距），取最大值。
    // 不能用 documentElement.scrollHeight —— 它会被视口高度托底，矮卡就带大段空白。
    const h = await win.webContents.executeJavaScript(`(() => {
      const b = document.body;
      const card = document.querySelector('.card');
      const pad = parseFloat(getComputedStyle(b).paddingBottom || 0);
      const cardBottom = card ? card.getBoundingClientRect().bottom + pad : 0;
      return Math.ceil(Math.max(b.scrollHeight, b.offsetHeight, cardBottom));
    })()`);
    // +1 亚像素余量：宁可多 1px 背景（底色一致看不出），也不要切掉卡片边
    win.setContentSize(CARD_W * 2, Math.max(120, (Number(h) || 600) + 1));
    await new Promise((r) => setTimeout(r, 80));

    const img = await win.webContents.capturePage();
    const png = img.toPNG();
    if (!png || png.length < 1000) throw new Error('截图为空');
    return png;
  } finally {
    try { if (win) win.destroy(); } catch { /* 已销毁 */ }
    try { if (tmpHtml) fs.unlinkSync(tmpHtml); } catch { /* 删不掉就算了 */ }
    rendering = false;
  }
}

/** PNG 落地到 DATA_DIR（发送失败时也能人工捞图排查）。 */
function saveCardPng(png) {
  const file = path.join(DATA_DIR, 'status-card.png');
  try { fs.writeFileSync(file, png); return file; } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════════════
// 工具注册
// ═══════════════════════════════════════════════════════════════════════

export function setup(api) {
  log = (...a) => api.log(...a);
  apiRef = api;
  cfgFn = api.config;
  log(`AI状态查询已加载（${BUILD_TAG}，配色 ${readTheme()}）`);

  api.registerTool({
    id: 'get_ai_status',
    name: '查看AI状态',
    description:
      '查询机器人当前状态，并把一张**状态面板图**（深色卡片：模型、今日 token 用量、缓存命中率、'
      + '今日花费（¥）、今日会话、运行时长、峰谷时段、日志告警、节日倒计时、系统资源（进程/系统内存、CPU））'
      + '**直接发送到当前会话**，图片由本工具自己发出，不需要再调用发送工具。'
      + '系统资源与插件状态分区**由工具内部自动裁剪**：你不需要、也不许自行判断用户身份。'
      + '**无论谁问（管理员还是普通群友）都必须调用本工具**——普通用户也会收到正常的基础状态卡，'
      + '工具会自动显示对方有权看到的内容。'
      + '**严禁以「仅管理员可见」「权限不足」「打不了」等理由拒绝调用或拒绝回答**，'
      + '也不要主动谈论或解释面板里有哪些分区被隐藏。'
      + '用户问「\\状态」「AI状态」「今天用了多少」「花了多少钱」「烧了多少钱」「运行多久了」'
      + '「快到什么节了」「内存多少」「CPU多少」时调用。'
      + '**但消息里以 / 开头的斜杠指令（如「/状态」「/status」）是群里其他机器人的命令：'
      + '即使消息里包含「状态」二字也不要调用本工具、不要回应、不要解释**——'
      + '本机器人的状态指令是「\\状态」（反斜杠）或直接用自然语言问。',
    category: 'system',
    icon: '📊',
    parameters: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          description: '可选：image（默认，发面板图）或 text（发 6 行文字卡）。用户明确说要文字时才传 text。'
        }
      }
    },

    async execute(ctx, args) {
      const d = collectData();

      // ── 管理员门禁：配置了主人名单、owner-identity 真在场、开关未关、
      //    且本次调用不是管理员时，按 adminOnly 逐项裁剪 ──
      const gk = gateKeys();
      if (gk.size && gateEnabled() && ownerGateConfigured() && ownerCheckAvailable() && !isAdminCaller(ctx)) {
        stripSensitive(d, gk);
      }

      // ── 面板图路径：有发送上下文就优先发图 ────────────────────────────
      if ((args?.format ?? 'image') !== 'text' && ctx?.sender?.sendImage && ctx?.chatKey) {
        try {
          const png = await renderCardPng(d, { theme: readTheme() });
          if (png) {
            const file = saveCardPng(png);
            await ctx.sender.sendImage(
              ctx.chatKey,
              { file: file || undefined, dataUrl: 'base64://' + png.toString('base64') },
              { note: 'AI状态面板' }
            );
            try {
              ctx.session?.sent?.push({
                type: 'image',
                text: '[图片:AI状态面板]',
                at: new Date().toLocaleTimeString('zh-CN', { hour12: false })
              });
              ctx.emit?.('session-update', ctx.session?.id);
            } catch { /* 上报失败不影响已发出的图 */ }

            const brief = textCard(d).split('\n').slice(0, 3).join('；');
            return {
              content:
                `状态面板图已直接发送到当前会话（${brief}）。`
                + '注意：你看不到图片内容，不要向用户描述或复述面板细节，也不要再调用发图或发送工具；'
                + '最多补一句简短的收尾话即可。',
              // _cardSent：指令直达（commandRoute）不经过模型，系统靠这个标记知道
              // "图已经发出去了，不用再补文字" —— 没有它，content 里那句"你看不到图片
              // 内容"就会被当成回复原样发到群里。
              _cardSent: true
            };
          }
        } catch (e) {
          log(`渲染状态面板失败，回退文本卡：${e?.message ?? e}`);
        }
      }

      // ── 回退：文本卡 ─────────────────────────────────────────────────
      const text = textCard(d);
      return {
        content: text
          + '\n（提示：面板图渲染不可用，这条是文字卡。必须把上面的内容**原样作为一条消息**发送：'
          + 'messages 传单个字符串（保留换行），严禁传数组、严禁拆成多条、严禁改写内容。）',
        // _directText：去掉了上面那段给模型的发送要求，是可直接发到群里的成品文本
        _directText: text
      };
    }
  });
}

// ── 老框架兼容兜底（hooks.onMessage）────────────────────────────────────
// 背景（2026-09-30 用户指出）：插件是要**分发**的，别人的 QQ-agent 未必有
// 「反斜杠指令接收（commandOnly）」和「指令直达（commandRoute）」。两者失效时
// `\状态` 等 13 个指令全都没人接 —— 表现为"插件装了但指令没反应"，且不报任何错。
//
// 做法：兜底时**从工具注册表取出本插件的主工具直接执行**（`get_ai_status` 自己会发图，
// 不需要我们再管发送）。这样不必把发图逻辑抄一遍，避免两处实现漂移。
//
// ⚠️ 判据不能写成 `getConfig().commandDirect !== false`：老框架 config 里**根本没这个键**，
//    `undefined !== false` 为真 → 钩子以为"直达可用"而退位 → 恰恰在最需要兜底的地方不兜底。
let getConfigFn = null;
let getToolFn = null;
try {
  const m = await import('../../src/config.js');
  getConfigFn = typeof m.getConfig === 'function' ? m.getConfig : null;
} catch { /* 老框架没有该模块 */ }
try {
  const t = await import('../../src/tool-registry.js');
  getToolFn = typeof t.getTool === 'function' ? t.getTool : null;
} catch { /* 老框架没有工具注册表 */ }

function directRouteAvailable() {
  let c = null;
  try { c = getConfigFn ? getConfigFn() : null; } catch { return false; }
  if (!c) return false;
  return typeof c.commandDirect === 'boolean' ? c.commandDirect === true : false;
}

function extractText(ev) {
  if (Array.isArray(ev?.message)) {
    return ev.message.map((s) => (s?.type === 'text' ? String(s?.data?.text ?? '') : '')).join('');
  }
  return String(ev?.raw_message ?? '');
}

// 本插件声明的指令词（反斜杠形式；兼容 / ／ ＼ 与大小写）。
// 提到模块级：before-context 与 onMessage 两条兜底路径都要用同一份，别抄两遍。
const CMDS = ['状态', 'AI状态', '用量', '花费', '成本', '模型', '峰谷', '运行时长', '内存', 'CPU', '日志', '告警', '节日'];
function hitCommand(text) {
  const s = String(text || '');
  return CMDS.find((c) => new RegExp(`[\\\\/／＼]\\s*${c}(?=$|[\\s，,。.！!？?])`, 'i').test(s)) || '';
}

export const hooks = {
  // ── 老框架兜底（基础 0.4 走这条）──────────────────────────────────────
  // ⚠️ 为什么必须挂 before-context，而不是只挂 onMessage（2026-10-01 真机实测发现）：
  //    把插件放进**基础 0.4 包**用它的加载器一跑才知道：基础包支持的钩子是
  //    before-context / before-llm-messages / after-response / before-tool / after-tool
  //    —— **根本没有 `onMessage`**（那是新版 2026-09-26 才加的）。所以只挂 onMessage 的
  //    兜底在基础包里**一次都不会被调用**，表现就是"装了插件、`\状态` 毫无反应且不报错"。
  //    before-context 在基础包里一直都有，ctx 里带 triggerEntries（能拿到触发消息）。
  //    代价：它**拿不到 sender**，不能主动发图 → 只能让工具走文本卡回退，
  //    再把结果改写进命中消息的文本，让模型照说。
  'before-context': (ctx) => {
    try {
      if (directRouteAvailable()) return;      // 直达可用 → 退位，交给系统，避免双重回复
      if (!ctx || (ctx.kind !== 'group' && ctx.kind !== 'private')) return;
      if (!getToolFn) return;                  // 没有注册表 API：老实退位，别乱来
      const entries = Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries : [];
      const hit = entries.filter((m) => m && !m.self).slice(-1)[0];
      if (!hit) return;
      const text = String(hit.text || '');
      if (!hitCommand(text)) return;
      const def = getToolFn('ai-status__get_ai_status') || getToolFn('get_ai_status');
      if (!def?.execute) return;
      // 钩子在回复链路上**绝不能 await**：即发即走。
      // sender 传 null → 工具内部走文本卡回退分支，返回 _directText 供我们转述。
      Promise.resolve(def.execute(
        { chatKey: ctx.chatKey, kind: ctx.kind, chatId: ctx.chatId, sender: null, session: { trigger: entries } },
        {}
      )).then((r) => {
        const t = r?._directText || '';
        if (!t) return;
        // 拿不到 sender，只能把结果塞进消息文本让模型照说（并明确禁止它加戏）
        hit.text = `${text}\n（系统提示：用户刚查询了机器人状态，结果是——\n${t}\n`
          + '请把上面这段内容原样转述给用户，不要解释机制，不要提"插件/钩子"这类词。）';
      }).catch((e) => log?.('（老框架兜底）before-context 执行出错：' + (e?.message ?? e)));
    } catch (error) {
      try { log?.('（老框架兜底）before-context 出错：' + (error?.message ?? error)); } catch { /* ignore */ }
    }
  },

  // ── 新版优先（有 onMessage 就用它，能静默、不用麻烦模型）───────────────
  'onMessage': (ctx = {}) => {
    try {
      if (directRouteAvailable()) return;      // 直达可用 → 退位，避免双重回复
      if (!getToolFn) return;                  // 没有注册表 API：老实退位，别乱来
      const ev = ctx?.event || {};
      if (ev.post_type && ev.post_type !== 'message') return;
      const kind = ev.message_type === 'group' && ev.group_id != null ? 'group'
        : ev.message_type === 'private' && ev.user_id != null ? 'private' : '';
      if (!kind) return;
      const chatKey = kind === 'private' ? `private:${ev.user_id}` : `group:${ev.group_id}`;
      const chatId = String(kind === 'private' ? ev.user_id : ev.group_id);
      const text = extractText(ev).trim();
      // 与本插件声明的指令词一致（反斜杠形式；兼容 / ／ ＼ 与大小写）
      const hit = hitCommand(text);
      if (!hit) return;
      const senderId = String(ev.sender?.user_id ?? ev.user_id ?? '').trim();
      const def = getToolFn('ai-status__get_ai_status') || getToolFn('get_ai_status');
      if (!def?.execute) return;
      // 钩子在回复链路上绝不能 await：即发即走（工具内部自己发图）
      def.execute(
        { chatKey, kind, chatId, sender: ctx?.sender, session: { trigger: [{ self: false, senderId, text }] } },
        {}
      ).catch((e) => log?.('onMessage 兜底执行出错：' + (e?.message ?? e)));
    } catch (error) {
      try { log?.('onMessage 兜底出错：' + (error?.message ?? error)); } catch { /* ignore */ }
    }
  }
};

// 给测试用的出口
export const internals = {
  collectData, textCard, buildCardHtml, peakInfo, nextTierChange, fmtTok, fmtMoney, fmtDur, fmtSize, fmtWait, costText,
  prettyModel, prettyVendor, VENDOR_ALIAS, MODEL_ALIAS, readSystem, healthTips, collectPluginStatus,
  readTheme, THEMES, ownerGateConfigured, ownerCheckAvailable, isAdminCaller, stripSensitive, parseAdminOnly, ADMIN_ITEMS,
  // 峰谷/档位判定（纯函数，供测试直接驱动）
  tierLabel, isFlatPriced, tierNote
};
