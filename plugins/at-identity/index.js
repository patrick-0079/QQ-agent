// @ 身份锚点（分清 @ 的是谁）—— 确定性型插件（放 plugins/，显示在控制台「插件」页签）
//
// ── 这个插件修什么 ────────────────────────────────────────────────────────
// 群聊里出现 @ 时，机器人分不清 @ 的是谁，一旦有 @ 就当成在叫自己。
//
// 两个根因（源码核对，非猜测）：
//   1. 正文 @段 没有身份锚点。onebot.js:429-444 把 @ 段渲染成裸 `@昵称`，
//      而历史发言人却带 `(QQ:xxx)` 后缀（prompt.js formatEntry）—— 模型看得到
//      `@张三`，却没有任何 QQ 号可比对；@ 的那个人改名后更是无从认起。
//      宿主为这个问题预留了 `message.inline-at-normalize` 能力（onebot.js:17-25、440），
//      但全仓库没有任何技能/插件提供它 —— 这个能力一直空转。
//   2. 系统提示从没告诉模型"你的 QQ 号是多少"。她唯一的自我认知是名字
//      （botName「柠檬酱」），而名字会撞、会改；自定义规则又要求"被 @ 必回"，
//      于是任何 @ 出现都倾向当成召唤。
//
// ── 做两件事（都是"只补信息、不改语义"）──────────────────────────────────
//   A. providers['message.inline-at-normalize']：把 @段 渲染成 `@昵称(QQ:号)`，
//      与发言人格式完全同构 —— 模型按 QQ 号认人，不再靠名字猜。
//   B. hooks['before-llm-messages']：群聊轮次往系统提示**末尾**追加一小段
//      身份锚点（你的 QQ 号 / 谁在叫你只认 QQ 号）。追加在末尾而不插中间，
//      是为了不推走后面核心规则的字节位置、不破坏系统提示的缓存前缀
//      （与 prompt.js:219-221 的注释同一道理）。
//
// ── 三条硬保证 ────────────────────────────────────────────────────────────
//   1. 纯增量：只在 @段 后面补 (QQ:号)、只在系统提示末尾加段。绝不改写
//      任何已有内容，绝不删东西。
//   2. 异常全吞：任何一步出错都当没这个插件，绝不影响机器人说话
//      （与 skill-gating 同一纪律 —— 修 bug 的插件自己绝不能变成新 bug）。
//   3. 关了就等于没装：enabled=false 时两个扩展点都原样放行。
//
// ── 依据（源码核对）───────────────────────────────────────────────────────
//   · onebot.js:17-25  normalizeInlineAt() 取第一个 message.inline-at-normalize
//     提供者，fn({ text, members, atUserId }) → string|null。返回 null 时
//     调用方退回原文本 —— 本插件返回 undefined/null 都安全。
//   · orchestrator.js:891  runHook('before-llm-messages', { ...skillContext, messages })
//     拿到的是 messages 的同一个数组引用，原地改 messages[0].content 即生效；
//     且在 session.inputMessages = structuredClone(messages) 之前执行。
//   · skills/manager.js:414-429  runHook 顺序执行、错误隔离、带超时 —— 钩子
//     抛错只记日志，不会让请求发不出去。
//   · 机器人 QQ 号：插件 API 没有直连 onebot（plugin-loader.js createSkillApi
//     白名单里没有），走本机控制台 GET /api/status → onebot.self.userId。

// ── 机器人 QQ 号探测 ─────────────────────────────────────────────────────
// 控制台端口：QQ_AGENT_PORT 显式覆盖 > 默认 3210（config.js:370-372）。
// 这里读同一个环境变量，行为与宿主完全一致；第二实例（+100 偏移）也能对上。
const BASE_PORT = Number(process.env.QQ_AGENT_PORT) || 3210;

let selfId = '';            // 探测到的机器人 QQ 号（缓存）
let probing = null;         // 进行中的探测 Promise（防并发重入）
let lastProbeAt = 0;        // 上次成功探测时间

async function probeSelfId(log, warn) {
  if (selfId) return selfId;
  if (probing) return probing;
  probing = (async () => {
    // 失败后 60 秒内不重试：登录前连打只是空转。
    if (Date.now() - lastProbeAt < 60000) return selfId;
    for (let p = BASE_PORT; p < BASE_PORT + 10; p++) {
      try {
        const r = await fetch(`http://127.0.0.1:${p}/api/status`, { signal: AbortSignal.timeout(2500) });
        if (!r.ok) continue;
        const d = await r.json();
        const id = String(d?.onebot?.self?.userId || '');
        if (id) {
          selfId = id;
          lastProbeAt = Date.now();
          log?.(`已取到机器人 QQ 号：${id}（端口 ${p}）`);
          return id;
        }
      } catch { /* 端口不通/未启动，试下一个 */ }
    }
    lastProbeAt = Date.now();
    warn?.(`暂未取到机器人 QQ 号（${BASE_PORT}~${BASE_PORT + 9} 都没有返回登录信息）。` +
      `未登录或改过端口时，可在本插件设置里手填。稍后自动重试。`);
    return '';
  })();
  try { return await probing; } finally { probing = null; }
}

/** 手填的 QQ 号优先（纯数字校验），否则用探测值。 */
function effectiveSelfId(conf) {
  const manual = String(conf?.selfId || '').trim();
  if (/^\d{5,12}$/.test(manual)) return manual;
  return selfId;
}

// ── 扩展点 A：正文 @段 规范化 ────────────────────────────────────────────
//
// onebot.js:17-21 的调用形状：
//   fn({ text: '@昵称', members: [{ userId, nickname }], atUserId: '123' })
// 期望返回 '@昵称(QQ:123)' 这种形式；返回 null/undefined 时宿主用原文本。
//
// ⚠️ 只做纯函数拼接：不查网络、不发请求 —— normalizeInlineAt 在消息入库的
//    同步渲染路径上，卡住会拖慢 ingest。
export const providers = {
  'message.inline-at-normalize': (args = {}) => {
    try {
      const id = String(args?.atUserId || '').trim();
      const name = String(args?.text || '').trim();
      if (!id || !name || !/^\d{5,12}$/.test(id)) return null;
      // 已带 (QQ:…) 后缀（理论上不会，防御性）就原样返回，绝不叠两层。
      if (/\(QQ:\d+\)$/.test(name)) return name;
      return `${name}(QQ:${id})`;
    } catch {
      return null;  // 与"没有提供者"同义，宿主退回原文本
    }
  }
};

// ── 扩展点 B：系统提示末尾注入身份锚点 ──────────────────────────────────
//
// 规则（与 owner-identity / image-ref-hint 的说明段同一写法风格）：
//   · 只在群聊（chatKey 以 group: 开头）注入 —— 私聊没有 @ 机制，没有误判面；
//   · 探测不到 QQ 号时不注入（没有锚点就不要给模型"我是谁"的假信息）；
//   · 追加在系统提示**末尾**：不推走核心规则的字节位置，缓存前缀不受影响。
//     （before-llm-messages 在 prompt 组装之后、structuredClone 之前，
//     这里追加的内容只影响本轮请求体，不落盘。）
export const hooks = {
  'before-llm-messages': (context = {}) => {
    try {
      const { messages, chatKey, selfNickname, botName } = context;
      if (!Array.isArray(messages) || !messages.length) return;
      if (!String(chatKey || '').startsWith('group:')) return;

      const conf = cfg();
      if (conf?.enabled !== true) return;
      const id = effectiveSelfId(conf) || '';
      if (!id) { void probeSelfId(context.log, context.warn); return; }  // 异步探测，本轮先不带

      const sys = messages.find((m) => m && m.role === 'system' && typeof m.content === 'string');
      if (!sys) return;
      // 防重复注入（热重载/同轮多次 hook 都安全）
      if (sys.content.includes(`【@ 身份锚点】`)) return;

      const nick = String(selfNickname || context.selfNickname || '').trim();
      const name = String(botName || context.botName || '').trim();
      const who = name ? `你的名字是「${name}」` : (nick ? `你的昵称是「${nick}」` : '你是一个群成员');

      const anchor = [
        `\n\n【@ 身份锚点】`,
        `${who}，你的 QQ 号是 ${id}。`,
        `判断消息里的 @ 在叫谁时，唯一依据是 @ 后面括号里的 QQ 号：`,
        `@某某(QQ:${id}) 才是在叫你；@某某(QQ:别的号) 都是在叫别人，与你无关，不要接话。`,
        `@全体成员（qq=all）是全体广播，不算单独叫你。`,
        `拿不准 @ 的是谁时，宁可当作在叫别人。`
      ].join('\n');

      sys.content += anchor;
      if (conf.verbose) console.log(`[skill:at-identity] 本轮已注入身份锚点（QQ:${id}，+${anchor.length} 字符）`);
    } catch (error) {
      // 静默放行 —— 修 bug 的插件绝不能自己变成新 bug
      try { console.warn(`[skill:at-identity] 身份锚点注入失败，本轮跳过：${error?.message ?? error}`); } catch { /* ignore */ }
    }
  }
};

// ── 生命周期 ─────────────────────────────────────────────────────────────

let probeTimer = null;

export function setup(api) {
  // 缓存配置读取与日志函数：hooks/providers 执行时拿不到 api，
  // 只能在 setup 时把 api.config()（skillManager.settingsOf，plugin-loader.js:95）存下来。
  settingsFn = api?.config || null;
  log = api?.log || log;
  warn = api?.warn || warn;

  const c = cfg();
  api.log?.(`@ 身份锚点已加载：${c.enabled ? '开' : '关'}`
    + (c.selfId ? `（手填 QQ:${c.selfId}）` : '（QQ 号自动探测中…）'));

  // 周期探测：机器人 QQ 号要等 OneBot 连上（登录完成）才有。
  // 30 秒一次直到拿到，之后停表 —— 拿到后永久缓存，重启前不再探测。
  const tryProbe = async () => {
    const conf = cfg();
    if (conf?.enabled !== true) return;
    if (selfId || effectiveSelfId(conf)) {
      if (probeTimer) { clearInterval(probeTimer); probeTimer = null; }
      return;
    }
    await probeSelfId(log, warn);
    if (selfId && probeTimer) { clearInterval(probeTimer); probeTimer = null; }
  };
  void tryProbe();
  probeTimer = setInterval(tryProbe, 30000);
  if (probeTimer.unref) probeTimer.unref();
}

export function dispose() {
  if (probeTimer) { clearInterval(probeTimer); probeTimer = null; }
}

// ── 配置读取（manifest.settings 提供默认值）──────────────────────────────

let log = (...args) => console.log('[skill:at-identity]', ...args);
let warn = (...args) => console.warn('[skill:at-identity]', ...args);

let settingsFn = null;

function cfg() {
  try {
    return settingsFn ? settingsFn() : { enabled: true, selfId: '', verbose: false };
  } catch {
    return { enabled: true, selfId: '', verbose: false };
  }
}

// loader 对每个插件只调用 setup(api)/register(api) 其中一个（plugin-loader.js:318，
// setup 优先）。所以配置读取函数必须在 setup 里缓存 —— 如果同时导出 register，
// 也不会有第二次调用；settingsFn 只能在 setup 里赋值。

