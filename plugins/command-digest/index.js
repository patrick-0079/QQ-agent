// 群总结指令（确定性型插件 / plugins/command-digest）
//
// ── 为什么是插件，不是技能 ────────────────────────────────────────────────
// 「/群总结」是**精确字符串**：触发条件能写成死的 if，不需要理解人话。
// 按文档 §0 第一问「触发时机能用 if 描述吗」—— 能，所以是确定性型。
// 更要紧的是可靠性：命令的意义就是"我给了明确指令，你必须照做"。
// 做成技能只能靠提示词劝模型（它可能不调工具）；做成插件则由钩子改写触发内容，
// 模型看到的就是一句明确的执行指令，而不是一句它需要自己领会的话。
//
// ── 它怎么工作 ────────────────────────────────────────────────────────────
//   before-context 钩子在「组装提示词之前」被调用，拿到的 triggerEntries
//   就是随后 buildUserPrompt 要用的那个数组（同一引用）。
//   于是我们把 /群总结 这条消息的文本**原地改写**成一条明确指令，模型看到的
//   就是「【指令·群总结】立刻执行」而不是「/群总结」——要不要调工具不再靠它猜。
//
// ⚠️ 钩子**改不了"要不要回应"**：档位判定（被艾特/关键词/随机）
//    在钩子之前就算完了。本机 store.contextTier = 4（每条消息都响应），
//    所以命令一定会走到提示词；如果哪天把档位调低，普通消息（含本命令）
//    就不会被响应 —— 那时要么 @ 机器人，要么把档位调回 4。
//
// ── 钩子的硬约束（照文档 §3.2 遵守）────────────────────────────────────────
//   · 只做轻量加工：全程同步、零网络、零文件 IO，远低于 5 秒超时
//   · 不发消息、不发请求、不重试（那属于工具）
//   · 出错只影响自己：整个 run 包了 try/catch

/** 出厂默认值（与 plugin.json 的 settings 保持一致）。 */
const DEFAULTS = {
  commands: '/群总结, /总结, /群聊总结',
  forceCount: 0
};

/** 命令后允许跟的条数范围（与 chat-digest 技能的上限一致）。 */
const MIN_COUNT = 20;
const MAX_COUNT = 600;
/** 被改写的触发消息会带上这个前缀，便于自己排查"这条是不是命令"。 */
const MARK = '【指令·群总结】';

let cfg = () => ({});
let log = () => {};
let warn = () => {};
let isSkillActive = () => false;

export function setup(api) {
  cfg = api.config;
  log = api.log || (() => {});
  warn = api.warn || (() => {});
  isSkillActive = api.isSkillActive || (() => false);
  log(`群总结指令已加载，命令：${commandList().join(' / ')}`);
}

export function available() {
  return true;
}

export const hooks = {
  /**
   * 识别命令并改写触发消息。
   * 只改文本，不动别的字段；识别不到命令时一个字都不加（不变量）。
   */
  'before-context'(ctx = {}) {
    try {
      const entries = Array.isArray(ctx?.triggerEntries) ? ctx.triggerEntries : [];
      if (!entries.length) return;
      if (ctx.proactive) return;              // 主动机会不是命令触发的
      if (String(ctx.kind) !== 'group') return;  // 命令只在群里认

      let fired = 0;
      for (const entry of entries) {
        if (!entry || entry.self) continue;
        const hit = parseCommand(String(entry.text ?? ''));
        if (!hit) continue;

        const count = resolveCount(hit.count);
        entry.text = buildDirective({
          count,
          raw: String(hit.raw || '').trim(),
          digestReady: digestReady(ctx)
        });
        fired += 1;
      }
      if (fired) log(`识别到群总结命令 ×${fired}，已改写成明确指令`);
    } catch (error) {
      // 钩子抛错只会记日志并跳过本插件，但自己兜住能留下更清楚的原因
      warn(`群总结指令处理失败：${String(error?.message || error)}`);
    }
  }
};

/* ── 命令识别 ─────────────────────────────────────────────────────────── */

function commandList() {
  const raw = String((typeof cfg === 'function' ? cfg()?.commands : '') ?? '').trim() || DEFAULTS.commands;
  const list = raw.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULTS.commands.split(',').map((s) => s.trim());
}

/**
 * 解析一条命令。
 *
 * 匹配规则（刻意严格，避免误触发）：
 *   · 命令必须在消息**开头**（允许前面有空白）—— 「这个/群总结不错」不算命令
 *   · 命令后只能是：结束 / 条数 / @机器人名（QQ 客户端 @ 会渲染成 "@昵称"）
 *   · 「/群总结一下」不算 —— 多出来的字说明不是本命令
 *
 * 用纯字符串前缀比较（不构造正则）：用户填的命令词里如果有 . * ( ) 之类字符，
 * 拼进正则会变成元字符，纯比较没有这个隐患。
 *
 * @returns {{raw:string, count:number|null}|null}
 */
function parseCommand(text) {
  const source = String(text ?? '').trim();
  if (!source || source[0] !== '/') return null;

  for (const command of commandList()) {
    // 先只认命令本身，再看后面剩下什么 —— 比一条大正则更好读，也更不容易放过误触发。
    //   「/群总结」            剩余 ""        → 认
    //   「/群总结 300」        剩余 "300"     → 认，条数 300
    //   「/群总结300」         剩余 "300"     → 认，条数 300（不留空格的写法也常见）
    //   「/群总结@小鲸鱼」     剩余 "@小鲸鱼"  → 认，不限条数
    //   「/群总结@小鲸鱼 200」 剩余里既有 @ 又有数 → 认，条数 200（顺序无关）
    //   「/群总结一下」        剩余 "一下"    → 不认（多出来的字说明不是本命令）
    if (!source.startsWith(command)) continue;

    // 剩余部分：先剔掉 @某人，再剔掉标点空白，剩下的只能是条数（或什么都没有）
    const rest = source.slice(command.length)
      .replace(/@\S+/g, ' ')
      .replace(/[\s。！!，,、~～.]+/g, ' ')
      .trim();
    if (!rest) return { raw: source, count: null };

    const digits = /^(\d{1,4})$/.exec(rest);
    if (!digits) continue;   // 还有别的字 → 不是本命令
    const count = Number(digits[1]);
    return { raw: source, count: Number.isFinite(count) && count > 0 ? count : null };
  }
  return null;
}

/** 条数：强制设置优先；其次命令里的数；都没写就交给技能自己的默认值。 */
function resolveCount(fromCommand) {
  const forced = Number((typeof cfg === 'function' ? cfg()?.forceCount : 0) ?? 0);
  if (Number.isFinite(forced) && forced >= MIN_COUNT) {
    return Math.max(MIN_COUNT, Math.min(MAX_COUNT, Math.round(forced)));
  }
  if (Number.isFinite(fromCommand) && fromCommand > 0) {
    return Math.max(MIN_COUNT, Math.min(MAX_COUNT, Math.round(fromCommand)));
  }
  return null;   // null = 不指定，让 digest_read 用技能设置里的默认条数
}

/** chat-digest 技能此刻是否真的可用（关了就别让模型白跑一趟）。 */
/** chat-digest 技能此刻是否真的可用（关了就别让模型白跑一趟）。 */
function digestReady(ctx) {
  try {
    return Boolean(isSkillActive('chat-digest', ctx));
  } catch {
    return false;
  }
}

/** 改写后的文本：给模型的是一道明确指令，不是一句需要领会的话。 */
function buildDirective({ count, raw, digestReady: ready }) {
  const countText = count ? `最近 ${count} 条` : '技能设置里的默认条数（不要自己定）';
  if (!ready) {
    return `${MARK}有人发了「${raw}」，但群聊总结技能（chat-digest）当前没有生效，`
      + '所以这次出不了图。用一句话告诉群友：总结功能没开，去 QQ Agent 控制台的「技能」页打开它。'
      + '不要编造总结内容。';
  }
  return [
    `${MARK}有人发了命令「${raw}」，这是明确指令，立刻执行，不要反问我。`,
    `第一步：调用 chat-digest__digest_read 读取${countText}聊天记录。`,
    '第二步：按读到的记录写好内容（调皮、嘴碎、有网感，必须给金句和 MBTI 分析），',
    '再调用 chat-digest__digest_compose 渲染成图片并发到群里。',
    '两步都要做完；只读不渲染，群友什么图都看不到。'
  ].join('');
}
