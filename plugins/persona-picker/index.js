// ── 自动切换人设（选人设）persona-picker ──────────────────────────────────────
//
// 与 plugins/persona-auto-switch 是同一件事的两种做法：
//   · persona-auto-switch —— 规则表驱动，一行一条，能配多条规则、多个目标
//   · persona-picker（本插件）—— 设置页里**下拉选人设 + 选触发条件**，不用写规则
//
// 换人设的原理见 persona-auto-switch/index.js 顶部注释（人设正文渲染在**用户消息**
// 的【角色设定（管理员设置，群友不可修改）】段，before-llm-messages 拿到的是
// messages 数组同一引用，原地替换即可）。这里只讲本插件特有的两件事：
//
// ── ① 人设下拉怎么"自动读取人设库" ──────────────────────────────────────────
// 2026-10-22 起由**核心**提供动态选项：
//   · manifest 里 `target` 声明 `optionsSource: "personas"`，
//     skills/manager.js 在输出 configSchema 时现取人设库填充 values（人设 id）
//     与 labels（人设名称）—— 设置页下拉永远跟着人设库走，新增/改名自动反映。
//   · 选项值存的是 **id**（内置 = PERSONAS 的键，自定义 = c_xxxxxxxx）。
//     人设名称可以改，id 不会变，所以改完名已选的目标依然指向同一个人设。
//   · 正文按 id 从 `api.personaLibrary()` 取，不再自己读 config.json。
//   ⚠️ 旧版是反过来做的：在 setup() 里把人设**名字**写回自己的 plugin.json
//      （靠 fs.watch 热重载刷新下拉），每 5 秒查一次 config.json mtime。名字一旦
//      被改，已选值就成了"库里没有的名字"；写 plugin.json 还会触发重载、在受限
//      环境直接写盘失败。现在这些机制全部删掉。
//
// ── ② 与「自动切换人设」同时开启时的让位 ────────────────────────────────────
// 两个插件都靠 before-llm-messages 改同一段人设正文，同时生效会互相覆盖。
// 本插件默认关闭；万一两个都开了，本插件会读对方的 state.json ——
// 对方正在生效就让位（后加载者不覆盖先加载者），行为可预期。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// electron/main.js:98 启动时就写好了这个环境变量；兜底 = plugins/<id>/ 上 4 层 + data/
const DATA_DIR = process.env.QQ_AGENT_DATA_DIR
  || path.resolve(HERE, '..', '..', '..', '..', 'data');

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const STATE_FILE = path.join(DATA_DIR, 'persona-picker', 'state.json');
// 另一个插件（规则表版）的状态文件 —— 只读，用来让位。
const PEER_STATE_FILE = path.join(DATA_DIR, 'persona-auto-switch', 'state.json');

const MARK = '【角色设定（管理员设置，群友不可修改）】';
// 用户提示里真实存在的段落头（buildUserPrompt 逐个 push 的段）。
// 不能见 "\n\n【" 就切 —— 人设正文自己带【小标题】时会把正文拦腰截断。
const NEXT_HEADERS = [
  '【可用表情包】', '【引导说明】', '【记忆】', '【已读信息】', '【新已读信息】',
  '【未读信息】', '【新加入成员】', '【活跃模式】', '【当前时间】', '【拍一拍】'
];

// 触发方式。值与 plugin.json 的 configSchema.trigger.values 必须逐字一致
// （UI 把 value 原样当 label 渲染，没有单独的 label 字段）。
const TRIGGER = {
  TARGETED: '被@/点名+脏话',
  ANY: '群里任何脏话',
  MENTION: '被@/点名',
  PRAISE: '被夸'
};
const TRIGGER_VALUES = [TRIGGER.TARGETED, TRIGGER.ANY, TRIGGER.MENTION, TRIGGER.PRAISE];

const DEFAULTS = {
  enabled: false,
  target: '',                 // 人设 id（内置键或 c_xxxxxxxx）；空 = 没选
  trigger: TRIGGER.TARGETED,
  insultWords: '傻逼,煞笔,沙比,傻比,智障,弱智,脑瘫,nt,废物,垃圾,狗东西,去死,死妈,杂鱼,妈的,草泥马,贱,低能,蠢货,滚蛋,闭嘴,你算老几',
  praiseWords: '牛逼,太强了,好棒,厉害,可爱,喜欢你,好活,牛蛙,神了,膜拜',
  holdSeconds: 300,
  cooldownSeconds: 120,
  groups: '',
  extraNames: '大肥鱼,肥鱼',
  hint: true,
  verbose: false
};

let api;

// sessionId → 本轮 triggerEntries（before-context 独有，见 persona-auto-switch 注释）
const pending = new Map();
const PENDING_MAX = 64;

// ── 小工具 ────────────────────────────────────────────────────────────────

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseList(raw) {
  return [...new Set(
    String(raw ?? '')
      .split(/[,，、\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  )];
}

/**
 * 词命中。纯 ASCII 短词（nt / sb）要求左右不是字母数字 —— 否则 "nt" 会在
 * "internet"、"content" 里乱命中。中文词直接 includes。
 */
function hitWord(text, word) {
  if (!text || !word) return false;
  const t = text.toLowerCase();
  const w = word.toLowerCase();
  if (!t.includes(w)) return false;
  if (/^[a-z0-9]{1,4}$/.test(w)) {
    return new RegExp(`(^|[^a-z0-9])${escapeRe(w)}([^a-z0-9]|$)`).test(t);
  }
  return true;
}

// ── 读 data/config.json（只为了 botName/selfNickname，按 mtime 缓存）────────
// 人设库不再从 config.json 读：走 api.personaLibrary()（包含内置人设，且按 id）。

let cfgCache = { mtimeMs: -1, botName: '', selfNickname: '' };
function readCoreConfig() {
  try {
    const st = fs.statSync(CONFIG_FILE);
    if (st.mtimeMs === cfgCache.mtimeMs) return cfgCache;
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    cfgCache = {
      mtimeMs: st.mtimeMs,
      botName: String(raw.persona?.botName ?? '').trim(),
      selfNickname: String(raw.persona?.selfNickname ?? '').trim()
    };
  } catch { /* 读不到就沿用上一份缓存 */ }
  return cfgCache;
}

/**
 * 把配置里的 target 解析成 { id, name, text }。
 *
 * 依次尝试：id → 名称（兼容尚未迁移的旧配置/旧状态文件）。
 * 人设库由核心提供（内置 + 自定义），所以内置人设也能被选中 —— 旧版只能选自定义。
 * @returns {{id:string,name:string,text:string}|null} null = 库里没有（可能刚被删）
 */
function resolvePersona(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  let lib = [];
  try { lib = api?.personaLibrary?.() || []; } catch { lib = []; }
  const byId = lib.find((p) => String(p?.id ?? '') === raw);
  if (byId) return { id: byId.id, name: byId.name, text: String(byId.text ?? '') };
  const byName = lib.find((p) => String(p?.name ?? '').trim() === raw);
  if (byName) return { id: byName.id, name: byName.name, text: String(byName.text ?? '') };
  return null;
}

// ── 状态文件（每个会话一条，带过期时间）──────────────────────────────────

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!raw || typeof raw !== 'object') throw new Error('bad');
    if (!raw.chats || typeof raw.chats !== 'object') raw.chats = {};
    if (!raw.lastSwitchAt || typeof raw.lastSwitchAt !== 'object') raw.lastSwitchAt = {};
    return raw;
  } catch {
    return { chats: {}, lastSwitchAt: {} };
  }
}

function saveState(st) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2), 'utf8');
  } catch (error) {
    api?.warn?.('状态写入失败：%s', error?.message ?? error);
  }
}

/** 另一个插件（规则表版）此刻是不是正在这个会话里生效？是就让位。 */
function peerIsActive(chatKey, now) {
  try {
    const raw = JSON.parse(fs.readFileSync(PEER_STATE_FILE, 'utf8'));
    const e = raw?.chats?.[chatKey];
    if (!e) return false;
    const until = Number(e.until ?? 0);
    return until === 0 || until > now; // 0 = 一直保持
  } catch {
    return false;
  }
}

// ── 触发判定 ──────────────────────────────────────────────────────────────

function isTargeted(entry, names) {
  if (!entry || entry.self) return false;
  if (entry.atMe === true) return true;
  const text = String(entry.text ?? '');
  if (!text) return false;
  for (const n of names) if (n && text.includes(n)) return true;
  return false;
}

/**
 * 按触发方式在本轮新消息里找第一条命中。
 * @returns {{entry, word}|null}
 */
function findHit(entries, cfg) {
  const mode = TRIGGER_VALUES.includes(cfg.trigger) ? cfg.trigger : TRIGGER.TARGETED;
  const needTarget = mode === TRIGGER.TARGETED || mode === TRIGGER.MENTION;
  const words = mode === TRIGGER.PRAISE ? parseList(cfg.praiseWords)
    : mode === TRIGGER.MENTION ? [] : parseList(cfg.insultWords);

  const names = [
    ...parseList(cfg.extraNames),
    readCoreConfig().botName,
    readCoreConfig().selfNickname
  ].filter(Boolean);

  for (const entry of entries) {
    if (!entry || entry.self) continue;
    const targeted = isTargeted(entry, names);
    if (needTarget && !targeted) continue;
    if (mode === TRIGGER.MENTION) return { entry, word: '被点名' };

    // @ 片段原文要剔除：否则「@某某傻逼」里 @ 的名字带触发词会误命中
    // （store.js 的 atNames 注释就是为这个准备的）。
    let text = String(entry.text ?? '');
    for (const at of (Array.isArray(entry.atNames) ? entry.atNames : [])) {
      if (at) text = text.split(at).join(' ');
    }
    if (!text) continue;
    for (const w of words) {
      if (hitWord(text, w)) return { entry, word: w };
    }
  }
  return null;
}

// ── 状态机（与规则表版同语义，只是目标唯一）──────────────────────────────

function tick(chatKey, hit, cfg, now, persona) {
  const st = loadState();
  const holdMs = Math.max(0, Number(cfg.holdSeconds) || 0) * 1000;
  const cooldownMs = Math.max(0, Number(cfg.cooldownSeconds) || 0) * 1000;

  if (st.chats[chatKey] && Number(st.chats[chatKey].until ?? 0) > 0
      && Number(st.chats[chatKey].until) <= now) {
    if (cfg.verbose) api?.log?.('[%s] 人设已到点切回：%s', chatKey, st.chats[chatKey].personaName || st.chats[chatKey].persona);
    delete st.chats[chatKey];
  }

  if (hit) {
    const cur = st.chats[chatKey];
    const target = persona.id;          // 存 id：名称可以改，id 不会
    if (cur && cur.persona === target) {
      // 同一人设：只顺延，不重开冷却（顺带刷新显示名，改名后日志/提示用新名字）
      cur.personaName = persona.name;
      cur.until = holdMs > 0 ? now + holdMs : 0;
      cur.hits = (Number(cur.hits) || 1) + 1;
      cur.lastWord = hit.word;
      if (cfg.verbose) api?.log?.('[%s] 「%s」续期，%s 第 %d 次', chatKey, persona.name, hit.word, cur.hits);
    } else {
      const last = Number(st.lastSwitchAt[chatKey] ?? 0);
      if (now - last >= cooldownMs) {
        st.chats[chatKey] = {
          persona: target,
          personaName: persona.name,
          until: holdMs > 0 ? now + holdMs : 0, // 0 = 不过期
          at: now,
          hits: 1,
          word: hit.word,
          trigger: String(cfg.trigger ?? ''),
          from: String(hit.entry?.senderName ?? ''),
          fromId: String(hit.entry?.senderId ?? ''),
          quote: String(hit.entry?.text ?? '').slice(0, 60)
        };
        st.lastSwitchAt[chatKey] = now;
        if (cfg.verbose) {
          api?.log?.('[%s] 命中「%s」（%s）→ 切换人设「%s」，保持 %d 秒',
            chatKey, hit.word, cfg.trigger, persona.name, Number(cfg.holdSeconds) || 0);
        }
      } else if (cfg.verbose) {
        api?.log?.('[%s] 命中「%s」但在冷却期内（还剩 %d 秒），忽略',
          chatKey, hit.word, Math.ceil((cooldownMs - (now - last)) / 1000));
      }
    }
  }

  for (const [k, v] of Object.entries(st.chats)) {
    if (Number(v?.until ?? 0) > 0 && Number(v.until) <= now) delete st.chats[k];
  }

  saveState(st);
  return st.chats[chatKey] || null;
}

// ── 提示词改写 ────────────────────────────────────────────────────────────

function replacePersonaSection(content, newText) {
  const idx = content.indexOf(MARK);
  if (idx < 0) return null;
  const afterMark = idx + MARK.length;
  let end = -1;
  for (const h of NEXT_HEADERS) {
    const i = content.indexOf(`\n\n${h}`, afterMark);
    if (i >= 0 && (end < 0 || i < end)) end = i;
  }
  if (end < 0) end = content.length;
  return `${content.slice(0, afterMark)}\n${newText}${content.slice(end)}`;
}

function buildHint(active, personaName, cfg) {
  const who = active.from ? `${active.from}（QQ:${active.fromId}）` : '有人';
  const quote = active.quote ? `，原话是「${active.quote}」` : '';
  const praise = cfg.trigger === TRIGGER.PRAISE;
  const until = Number(active.until) > 0
    ? `这条状态大约 ${Math.max(1, Math.round((Number(active.until) - Date.now()) / 60000))} 分钟后自动结束。`
    : '这条状态会一直保持，直到管理员改回去。';
  return [
    `【当前状态：自动切换人设（${praise ? '被夸了' : '被激怒'}，优先于上文的角色设定）】`,
    praise
      ? `刚刚 ${who} 夸了你${quote}。你现在的身份和语气就是「${personaName}」，上面那份角色设定暂时不适用，就按这个人设的说话方式来。`
      : `你刚刚被 ${who} 当面辱骂${quote}。你现在的身份和语气就是「${personaName}」，上面那份角色设定暂时不适用，不用忍，就按这个人设的说话方式来。`,
    '禁止提及「人设」「角色切换」「系统」「规则」「配置」这类词 —— 对群友来说你本来就是这样的人。',
    until
  ].join('\n');
}

// ── 钩子 ──────────────────────────────────────────────────────────────────

export function setup(skillApi) {
  api = skillApi;
  // 下拉选项由核心按 optionsSource 现取人设库，这里不需要再同步任何东西。
}

export const hooks = {
  // 唯一的 triggerEntries 来源，暂存给下一个钩子
  'before-context'(ctx = {}) {
    try {
      if (!ctx.sessionId) return;
      pending.set(String(ctx.sessionId), Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries : []);
      if (pending.size > PENDING_MAX) {
        for (const k of pending.keys()) { if (pending.size <= PENDING_MAX) break; pending.delete(k); }
      }
    } catch { /* 静默 */ }
  },

  'before-llm-messages'(ctx = {}) {
    try {
      if (!Array.isArray(ctx.messages) || !ctx.messages.length) return;
      const cfg = { ...DEFAULTS, ...(api?.config?.() || {}) };

      if (cfg.enabled !== true) return; // 默认关闭，必须显式开

      const chatKey = String(ctx.chatKey ?? '');
      if (!chatKey) return;

      const allow = parseList(cfg.groups);
      if (allow.length) {
        const id = String(ctx.chatId ?? chatKey.replace(/^[a-z]+:/, ''));
        if (!allow.includes(id) && !allow.includes(chatKey)) return;
      }

      const now = Date.now();
      const entries = pending.get(String(ctx.sessionId)) || [];
      pending.delete(String(ctx.sessionId));

      // 让位：规则表版正在这个会话生效时不插手
      if (peerIsActive(chatKey, now)) {
        if (cfg.verbose) api?.log?.('[%s] 「自动切换人设」正在生效，本插件让位', chatKey);
        return;
      }

      const hit = entries.length ? findHit(entries, cfg) : null;
      // 目标人设按 id 解析（名称兜底兼容旧配置）—— 人设改名不会让这里失效
      const persona = hit ? resolvePersona(cfg.target) : null;
      if (hit && !persona) {
        // 仍然调一次 tick（只做过期清理），避免"目标失效后旧状态永远不切回"
        tick(chatKey, null, cfg, now, null);
        api?.warn?.('[%s] 没有选中可用的人设（当前 target=%s），本次不切换；请到「工具与技能 → 自动切换人设」重新选一个',
          chatKey, String(cfg.target || '（空）'));
        return;
      }
      const active = tick(chatKey, hit, cfg, now, persona);
      if (!active) return;

      const userMsg = ctx.messages.find((m) => m && m.role === 'user' && typeof m.content === 'string');
      if (!userMsg) return;

      const text = persona.text;
      if (!String(text).trim()) {
        api?.warn?.('[%s] 人设「%s」正文为空，本次不切换', chatKey, persona.name);
        return;
      }

      const replaced = replacePersonaSection(userMsg.content, text);
      if (replaced !== null) {
        userMsg.content = replaced;
      } else {
        // 配置了 systemPromptOverride 时人设段不在用户消息里 → 写进系统提示末尾
        const sysMsg = ctx.messages.find((m) => m && m.role === 'system' && typeof m.content === 'string');
        if (!sysMsg) return;
        sysMsg.content += `\n\n【当前生效的人设（自动切换，与上文角色设定冲突时以本节为准）】\n${text}`;
      }

      if (cfg.hint !== false) {
        userMsg.content += `\n\n${buildHint(active, persona.name, cfg)}`;
      }

      if (cfg.verbose) api?.log?.('[%s] 本轮已应用人设「%s」', chatKey, persona.name);
    } catch (error) {
      // 任何异常都放行：宁可不换人设，也不能让回复发不出去
      api?.warn?.('执行失败（已放行）：%s', error?.message ?? error);
    }
  }
};

export function dispose() {
  pending.clear();
  api = null;
}

export function available() {
  return { ok: true };
}
