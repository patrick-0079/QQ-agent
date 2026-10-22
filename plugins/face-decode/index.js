// QQ自带表情转译（face-decode）：
// QQ 内置表情到达时是 OneBot 的 face 消息段（{ type:'face', data:{ id:数字 } }），
// 核心 segmentsToText 会把它渲染成不透明的数字占位符 `[表情14]`，模型认不出来。
//
// 双层翻译（v1.1.0，兼容两种核心）：
//   ① onMessage 钩子（0.4.1+ 本体侧）：把 event.message 里的 face 段**原地改写**为
//      text 段 `[表情:官方名]`——译本进存档/记忆/指令链。0.4.0 无此钩子，不会触发。
//   ② before-llm-messages 兜底（新旧核心都有）：LLM 消息层面把文本里的 `[表情{id}]`
//      正则翻成 `[表情:官方名]`。它覆盖 onMessage 够不到的一切：没有 onMessage 的
//      旧版核心（0.4.0-bugfix）、装插件之前的历史旧格式、合并转发展开文本。
//      本体侧已译的文本（`[表情:xx]`）不匹配正则，天然幂等、不会双重改写。
//
// 选型记录见 docs/adr/0025：刻意不走"能力模式改核心 segmentsToText"（非侵入约束）。
//
// 纪律：目录里查不到的 id（限时/季节表情）**保持原样**，宁可不译不许编。
import { FACE_NAMES } from './lib/faces.mjs';

/** 数字占位符 → 官方名（查不到的 id 原样保留，不参与替换）。 */
const FACE_TAG = /\[表情(\d+)\]/g;

function translateFaceTags(text) {
  return String(text).replace(FACE_TAG, (raw, id) => {
    const name = FACE_NAMES[Number(id)];
    return name ? `[表情:${name}]` : raw;
  });
}

function translateMessageContent(m) {
  if (!m) return false;
  if (typeof m.content === 'string') {
    const out = translateFaceTags(m.content);
    if (out !== m.content) { m.content = out; return true; }
    return false;
  }
  if (Array.isArray(m.content)) {
    let changed = false;
    for (const part of m.content) {
      if (part && typeof part === 'object' && typeof part.text === 'string') {
        const out = translateFaceTags(part.text);
        if (out !== part.text) { part.text = out; changed = true; }
      }
    }
    return changed;
  }
  return false;
}

export function setup(_api) { /* 无外部资源 */ }
export function activate() { /* 开关由 skillManager.isActive 控制 */ }
export function deactivate() { /* 下一次 runHook 不再分发本钩子 */ }
export function dispose() { /* 无需回收 */ }

export const hooks = {
  /**
   * 层① 本体侧（0.4.1+）：每条入站消息，face 段原地改写。
   * 失败由 skillManager 隔离（只记日志，不阻塞收消息），这里不再额外兜底吞错。
   */
  onMessage(ctx = {}) {
    const segs = ctx?.event?.message;
    if (!Array.isArray(segs)) return null;
    for (const seg of segs) {
      if (!seg || seg.type !== 'face') continue;
      const d = seg.data ?? (seg.data = {});
      const id = Number(d.id);
      // 只译闭集内的 id；未知 id 不动段，保持核心的 `[表情{id}]` 行为
      const name = Number.isInteger(id) ? FACE_NAMES[id] : undefined;
      if (!name) continue;
      seg.type = 'text';
      seg.data = { text: `[表情:${name}]` };
    }
    return null;
  },

  /**
   * 层② 提示词兜底（0.3.1~0.4.0 / 全版本通用）：LLM 消息里的 `[表情{id}]` 文本翻成官方名。
   * 只动 user 消息——face 占位符只会出现在历史/输入里，system 与 assistant 不含它
   * （assistant 偶尔回显也属异常，改了无害，但从严只处理 user）。
   */
  'before-llm-messages'(ctx = {}) {
    const messages = ctx?.messages;
    if (!Array.isArray(messages)) return null;
    for (const m of messages) {
      if (m?.role !== 'user') continue;
      translateMessageContent(m);
    }
    return null;
  }
};

/** 自测用：核心加载器不消费这些导出。 */
export const internals = { FACE_NAMES, translateFaceTags };
