// 语音说话（云端 · 小米 MiMo TTS）：让机器人把一句话「说出来」，而不只是打字。
//
// 数据流：模型调用 mimo-tts__say(text, style?)
//         → POST {baseUrl}/chat/completions（model=mimo-v2.5-tts-voicedesign）
//         → 拿到 base64 音频 → ctx.sender.sendMedia() 发一条 record 段 → QQ 里是一颗语音气泡。
// 接口文档：https://mimo.mi.com/docs/zh-CN/api/audio/tts
//
// ── 音色从哪里来（三级回退）──────────────────────────────────────────────
//   ① 技能设置里的「音色描述」（填了就以它为准，适合临时试验）
//   ② 技能目录下的 voice.txt（**推荐的主来源**：改文件即改声音）
//   ③ 本文件里的 DEFAULT_VOICE_PROMPT（最后兜底，保证永远有声音）
//
// 为什么把文件做成主来源：设置页那个输入框是单行文本框，一百多字的音色描述在里面
// 既难改、又容易存成空值。实测踩过这个坑 —— 保存设置后 voicePrompt 变成空字符串，
// 而 voicedesign 没有描述就出不来声音，插件被判定为「不可用」，
// 表现是"刚才还能说话，突然就不说了"，且不报任何错。现在任一级非空都算可用。
//
// ── 两个必须写对的地方（写错就静默不出声）──────────────────────────────
//   ① 要念的文字必须放在 role=assistant 的 content 里；放在 user 里会被当成
//      "音色/风格指令"，结果是没有声音或念出别的东西（官方文档「Call Rules」）。
//   ② voicedesign 模型**不支持 audio.voice 字段**（会报错），音色完全由 user 里
//      那段描述决定；只有 mimo-v2.5-tts 才用 audio.voice 选内置音色。
//
// ── 发送为什么走 ctx.sender.sendMedia ────────────────────────────────────
// src/sender.js 明确写着：插件**不得**绕过发送队列直接调 onebot.sendSegments，
// 否则会跳过限频与留档（表现为"媒体把配额吃光后突然发不出话"、重启后重复发）。
// sendMedia 就是为此准备的公共入口，record 段的 silk 转码由协议端自己做
// （snowluma 的 loadPtt → encodeSilk，自带 ffmpeg 转码）。

import fs from 'node:fs';

let cfg = () => ({});
let log = () => {};
let apiFetch = null;

/** 音色描述文件（与 index.js 同目录）。见文件头的"三级回退"说明。 */
const VOICE_FILE = new URL('./voice.txt', import.meta.url);

const DEFAULT_BASE = 'https://api.xiaomimimo.com/v1';
const VOICEDESIGN = 'mimo-v2.5-tts-voicedesign';
const BUILTIN = 'mimo-v2.5-tts';
/** 内置音色白名单（官方列表）。填了别的值就回落到默认。 */
const PRESET_VOICES = ['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'];
/** 最后兜底：voice.txt 和设置项都读不到时用它，保证 voicedesign 永远有描述可用。 */
const DEFAULT_VOICE_PROMPT = '少女音，中高音，音色清脆、偏软，共鸣不太靠前，尾音带一点闷闷的厚度。语速偏快，说话像打字：短句连发，句子之间几乎不留停顿，句尾收得干脆、常把最后半个字轻轻吞掉，绝不拖长腔。语气随性灵动、带点懒散的撒娇感，像在群里跟熟人聊天，不是播音腔，也不甜腻。';

/**
 * 读 voice.txt。以 # 开头的行当注释丢掉，其余按行拼成一句话。
 * 文件不存在 / 读不出来都返回空串（交给下一级回退，绝不抛错）。
 */
export function readVoiceFile() {
  try {
    const raw = fs.readFileSync(VOICE_FILE, 'utf8').replace(/^\uFEFF/, '');
    return raw
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('#'))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return '';
  }
}

/**
 * 配置清洗。纯函数（除了读 voice.txt），方便自检与回归。
 * @param {object} raw  技能设置
 * @param {object} deps { fileVoice } —— 自检时注入假文件内容
 */
export function readConfig(raw, deps = {}) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const baseUrl = (String(c.baseUrl || '').trim() || DEFAULT_BASE).replace(/\/+$/, '');
  const apiKey = String(c.apiKey || '').trim();
  const model = String(c.model || '').trim() === BUILTIN ? BUILTIN : VOICEDESIGN;
  // 音色描述三级回退：设置 → voice.txt → 内置兜底
  const settingVoice = String(c.voicePrompt || '').trim();
  const fileVoice = ('fileVoice' in deps ? String(deps.fileVoice || '') : readVoiceFile()).trim();
  const voicePrompt = settingVoice || fileVoice || DEFAULT_VOICE_PROMPT;
  const voiceSource = settingVoice ? '设置里的「音色描述」' : (fileVoice ? 'voice.txt' : '内置兜底（voice.txt 读不到）');
  const presetRaw = String(c.presetVoice || '').trim();
  const presetVoice = PRESET_VOICES.includes(presetRaw) ? presetRaw : '冰糖';
  const format = String(c.audioFormat || 'mp3').trim().toLowerCase() === 'wav' ? 'wav' : 'mp3';
  const maxChars = Math.min(1000, Math.max(20, Math.floor(Number(c.maxChars)) || 120));
  const timeoutMs = Math.min(300000, Math.max(5000, Math.floor(Number(c.timeoutMs)) || 60000));
  return {
    baseUrl, apiKey, model, voicePrompt, voiceSource, presetVoice, format, maxChars,
    polishText: c.polishText === true,
    alsoSendText: c.alsoSendText === true,
    timeoutMs
  };
}

/**
 * 把模型给的 text 洗成"适合念出来"的样子。
 *
 * 为什么要洗：模型经常带 markdown（**加粗**、`代码`、列表符号）和表情符号，
 * 这些会被逐字念出来（念出"星号星号"），或者让 TTS 停顿怪异。
 * 换行合成一句：语音是一段连续音频，换行在 QQ 语音里没有意义。
 */
export function normalizeSpeakText(input) {
  let s = String(input ?? '');
  s = s.replace(/```[\s\S]*?```/g, ' ');            // 代码块整段丢掉（念不了）
  s = s.replace(/`([^`]*)`/g, '$1');                // 行内代码保留内容
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');      // 图片
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');    // 链接保留文字
  s = s.replace(/https?:\/\/\S+/gi, '链接');         // 裸链接念出来很糟
  s = s.replace(/^\s{0,3}#{1,6}\s*/gm, '');         // 标题
  s = s.replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, ''); // 列表符号
  s = s.replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1'); // 加粗/斜体/删除线
  s = s.replace(/[*_~#>|]/g, ' ');                  // 残留符号
  s = s.replace(/[\r\n]+/g, '，');                   // 换行 → 逗号停顿（比直接连读自然）
  s = s.replace(/[ \t\u3000]+/g, ' ');
  s = s.replace(/，{2,}/g, '，').replace(/^[，、\s]+|[，、\s]+$/g, '');
  return s.trim();
}

/** 拼这一句要用的音色/语气指令：默认音色描述 + 可选的单句微调。 */
export function buildVoiceInstruction(voicePrompt, style) {
  const base = String(voicePrompt || '').trim() || DEFAULT_VOICE_PROMPT;
  const extra = String(style || '').trim();
  return extra ? `${base} 这一句的语气：${extra}` : base;
}

/** 短指纹：用来给发送队列做去重键，避免同一句话在去重窗口内被念两遍。 */
function fingerprint(text) {
  let h = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

/** 响应体压成一行短摘要（别把整页 HTML 灌进日志）。 */
function snippet(text, max = 200) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** HTTP 状态码 → 能直接照做的提示。 */
function httpHint(status) {
  if (status === 401 || status === 403) return '（API Key 不对或没有权限：确认 apiKey 与「接口地址」是同一家的——套餐/中转的 tp- 开头 Key 只在套餐地址下有效，填官方地址会被拒）';
  if (status === 404) return '（接口地址不对，或这个地址不提供音频模型：把「接口地址」改回官方 https://api.xiaomimimo.com/v1 再试）';
  if (status === 429) return '（调用太频繁，或额度/余额用尽）';
  if (status === 400) return '（参数被拒：确认「合成方式」与音色设置匹配——voicedesign 不能带 audio.voice，mimo-v2.5-tts 必须带）';
  if (status >= 500) return '（MiMo 服务端异常，稍后自己会好）';
  return '';
}

/**
 * 合成一段语音。返回 { audioB64, spoken, text, voiceSource }。
 * @param {object} args { text, style }
 * @param {object} deps { fetchImpl }（自检时注入假 fetch）
 */
export async function synthesize({ text, style } = {}, { fetchImpl } = {}) {
  const c = readConfig(cfg());
  if (!c.apiKey) throw new Error('还没填 MiMo API Key（技能设置 → apiKey）');
  const spoken = normalizeSpeakText(text);
  if (!spoken) throw new Error('要说的内容是空的（去掉表情/markdown 之后什么都没剩下）');
  if (spoken.length > c.maxChars) {
    throw new Error(`这句话太长（${spoken.length} 字，上限 ${c.maxChars} 字）。`
      + '把内容拆成几条短句分别调用，或者改用打字回复——QQ 语音太长会被拒收，念出来也像念稿。');
  }
  const doFetch = fetchImpl || apiFetch;
  if (typeof doFetch !== 'function') throw new Error('缺少 fetch（清单里需要声明 web_fetch 权限）');

  const useDesign = c.model === VOICEDESIGN;

  // ⚠️ 要念的文字必须在 assistant；user 放音色/风格指令
  const messages = [];
  if (useDesign) {
    messages.push({ role: 'user', content: buildVoiceInstruction(c.voicePrompt, style) });
  } else if (String(style || '').trim()) {
    // 内置音色也支持自然语言风格指令，但不需要"设计音色"，所以只说风格
    messages.push({ role: 'user', content: String(style).trim() });
  }
  messages.push({ role: 'assistant', content: spoken });

  const audio = { format: c.format };
  if (!useDesign) audio.voice = c.presetVoice;          // voicedesign 传 voice 会报错
  if (useDesign && c.polishText) audio.optimize_text_preview = true;

  const res = await doFetch(`${c.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'api-key': c.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: c.model, messages, audio, stream: false }),
    signal: AbortSignal.timeout(c.timeoutMs)
  });

  const body = await res.text();
  if (!res.ok) throw new Error(`MiMo 返回 HTTP ${res.status}${httpHint(res.status)}：${snippet(body)}`);

  let data = null;
  try { data = JSON.parse(body); } catch { throw new Error(`MiMo 返回的不是 JSON：${snippet(body)}`); }
  if (data?.error) {
    const e = data.error;
    throw new Error(`MiMo 报错：${snippet(typeof e === 'string' ? e : (e.message || e.code || JSON.stringify(e)))}`);
  }

  const msg = data?.choices?.[0]?.message;
  const b64 = String(msg?.audio?.data || '').trim();
  if (!b64) throw new Error(`没拿到音频数据${snippet(body, 120) ? `（原始响应：${snippet(body, 120)}）` : ''}`);

  // polish 打开时，实际念的可能不是原话 —— 用 MiMo 回传的最终文本，日志与存档才准
  const finalText = c.polishText ? (String(msg?.final_text_preview || '').trim() || spoken) : spoken;
  log(`语音合成完成：${finalText.length} 字，格式 ${c.format}，音色来源=${c.voiceSource}`
    + `${c.polishText && finalText !== spoken ? '（文本已被润色）' : ''}`);
  return { audioB64: b64, spoken: finalText, text: spoken, voiceSource: c.voiceSource };
}

// ── 技能生命周期 ──────────────────────────────────────────────────────────

export function setup(api) {
  cfg = api.config;
  log = api.log || (() => {});
  apiFetch = api.fetch;
  api.registerTool({
    id: 'say',
    name: '用语音说话',
    category: 'media',
    icon: '🔊',
    description: '把一句话用你自己的声音说出来，发成一条真正的QQ语音消息（不是文字）。只在用户明确要你用语音（用语音回我/说句话/念一下/唱一段），或语音明显比文字更合适时用。一次只适合一两句短话；发完不要再把同一句话用文字发一遍。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: '要说出口的话。会被逐字念出来，所以别写表情符号、markdown、括号里的动作描写；一两句、60 字内最好。' },
        style: { type: 'string', description: '可选：只针对这一句的语气微调，自然语言。例如「压低声音，装正经」「带点笑意，语速更快」「有气无力地」。不填就用默认音色。' },
        replyToMessageId: { type: ['integer', 'string'], description: '可选：要引用/回复的消息 id（聊天记录里每条消息前的 #数字）' }
      },
      required: ['text']
    },
    async execute(ctx, args) {
      try {
        if (!ctx?.chatKey) return { content: '错误：当前环境没有会话上下文，无法发语音', isError: true };
        if (typeof ctx.sender?.sendMedia !== 'function') {
          return { content: '错误：当前环境缺少发送接口（sender.sendMedia），语音没发出去', isError: true };
        }
        const { audioB64, spoken } = await synthesize({ text: args?.text, style: args?.style });

        await ctx.sender.sendMedia(ctx.chatKey, [{ type: 'record', data: { file: `base64://${audioB64}` } }], {
          label: `[语音]${spoken.slice(0, 30)}`,
          dedupeKey: `tts:${fingerprint(spoken)}`,
          replyToMessageId: args?.replyToMessageId ?? null
        });

        if (readConfig(cfg()).alsoSendText) {
          try { await ctx.sender.sendTextBatch(ctx.chatKey, [spoken], {}); }
          catch (error) { log(`语音已发出，但补发的文字失败：${error?.message ?? error}`); }
        }

        // 会话页留痕（与内置发图/发表情工具同一口径）；失败不影响主流程
        try {
          ctx.session?.sent?.push({
            type: 'voice',
            text: `[语音]${spoken.slice(0, 40)}`,
            at: new Date().toLocaleTimeString('zh-CN', { hour12: false })
          });
          ctx.emit?.('session-update', ctx.session?.id);
        } catch { /* 留痕失败不影响这条语音已经发出去的事实 */ }

        return {
          content: `已用语音说出：「${spoken}」。这条语音已经直接发到会话里了——不要再把同一句话用文字发一遍，也不要向用户汇报"已发送"。`
        };
      } catch (error) {
        const msg = String(error?.message ?? error);
        log(`语音说话失败：${msg}`);
        return { content: `语音发送失败：${msg}。可以改用文字回复，不要立刻重复调用本工具。`, isError: true };
      }
    }
  });
  log(`MiMo 语音说话已注册（${readConfig(cfg()).model}，音色来源=${readConfig(cfg()).voiceSource}）`);
}

/**
 * 自检：必须同步返回（返回 Promise 会被当成"可用"），所以只做配置校验，不发网络请求。
 *
 * ⚠️ 刻意**不**把"音色描述是否为空"当不可用条件：描述有三级回退，永远读得到；
 *    曾经把空描述判成不可用，结果保存设置时把描述存成空值，插件就静默失声了。
 *    描述来源写在合成日志里，需要排查时看日志即可。
 */
export function available() {
  let c;
  try { c = readConfig(cfg()); } catch (error) { return { ok: false, reason: `配置读不出来：${error?.message ?? error}` }; }
  if (!c.apiKey) return { ok: false, reason: '还没填 MiMo API Key（设置里的 apiKey）' };
  if (!/^https?:\/\//i.test(c.baseUrl)) return { ok: false, reason: `接口地址要以 http(s):// 开头（当前：${c.baseUrl}）` };
  return { ok: true };
}

export const internals = { synthesize, readConfig, readVoiceFile, normalizeSpeakText, buildVoiceInstruction, fingerprint };
