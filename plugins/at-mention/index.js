// at-mention —— 让机器人用「名字」@ 群友。
//
// 详细背景见 lib/at-resolver.js 的文件头注释。一句话：
// OneBot 里只有独立的 `at` 段才是真 @，正文写 `@某人` 对方收不到提醒；
// 而模型手上通常只有昵称、没有 QQ 号。本插件把正文里的 `@名字` 认领成真 @。
//
// 宿主侧接入点：src/sender.js 的 #resolveOutgoingAt()，走
// `message.outgoing-at-resolve` 能力。没有插件提供时完全是空操作。
//
// ⚠️ 子模块必须用「带时间戳的动态 import」加载：
//    加载器只给插件入口加了 `?t=` 强制刷新，入口里静态 import 的子模块仍被 Node 的
//    ESM 缓存锁住 —— 会出现"改了 lib/ 下的文件、热重载后还是旧代码"。沿用
//    early-finish / dsml-tool-rescue 已经踩过并记录的同样写法。
const resolver = await import(`./lib/at-resolver.js?t=${Date.now()}`);

let logFn = () => {};
let cfgFn = () => ({});

export function setup(api = {}) {
  if (typeof api.log === 'function') logFn = api.log;
  if (typeof api.config === 'function') cfgFn = api.config;
}

/**
 * 宿主在发送前调用：`{ text, chatKey, kind, members }` → `{ text, atUserIds }`。
 *
 * members 由宿主提供（她最近活跃的群成员名单），因为插件拿不到 store。
 * 返回的 text 已去掉被认领的 `@名字`，atUserIds 是挂到这条消息上的 QQ 号。
 */
export const providers = {
  'message.outgoing-at-resolve': ({ text, kind, members } = {}) => {
    try {
      const cfg = cfgFn() || {};
      if (cfg.enabled === false) return null;
      // 私聊没有群成员，真 @ 无意义。
      if (kind !== 'group') return null;

      const result = resolver.resolveMentions(text, members, {
        maxMentions: cfg.maxMentions,
        allowPartialMatch: cfg.allowPartialMatch !== false,
      });

      if (!result.hits.length) return null;

      if (cfg.debug === true) {
        const who = result.hits.map((h) => `${h.name}(${h.userId})`).join('、');
        logFn(`[at-mention] 已把正文里的 @ 转成真 @ 提醒：${who}`);
      }
      return { text: result.text, atUserIds: result.atUserIds };
    } catch (error) {
      // 解析失败一律当作"没解析出来"——绝不能因为插件出错而挡住一条消息的发送。
      try {
        logFn(`[at-mention] 解析出错（已忽略，本条按原样发送）：${error?.message || error}`);
      } catch { /* 日志也失败就算了 */ }
      return null;
    }
  }
};

export function dispose() {
  // 本插件不持有定时器/监听器，无需清理。保留导出以明确"没有需要回收的资源"。
}
