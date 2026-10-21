// 配置作用域（2026-10-21，会话个性化改造）
//
// 背景：原先的"按群隔离"是散在 config 里的几张映射表
// （personaByChat / store.groupSliderPos / store.groupPeakPos），
// 运行时一律读全局 getConfig()，只有极少数模块自己记得去查映射 ——
// 结果是"能配的地方没生效、生效的地方不可见"。
//
// 新模型：每个 QQ 群 / 私聊 = 一个会话（chatKey = group:123 / private:456），
// 会话可以有一份**配置覆盖**（见 chatProfiles / chat-profiles.js）。运行时进入
// 某个会话时用 AsyncLocalStorage 建立作用域，作用域内所有 getConfig() 自动拿到
// 「默认配置 + 本会话覆盖」合并后的生效配置。
//
// 为什么用 AsyncLocalStorage 而不是到处传 cfg 参数：
//   getConfig() 在 src/ 里有 150+ 个调用点（llm / prompt / tools / sender /
//   web-search / skills …），逐个改成参数传递既容易漏，也会把"配置"变成
//   每个函数的显式依赖。ALS 让调用链**无需改动**就自动继承会话配置，
//   且天然随 async/await 传播，不会串到别的会话（每个 wake 各自 run）。
//
// ⚠️ 作用域只在**会话运行链路**里建立（orchestrator.wake/onIncoming），
//    HTTP 路由只有显式传 ?chat= 时才进入作用域。写入配置（updateConfig）
//    永远写默认（全局）配置，不受作用域影响 —— 作用域是只读视图。
import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

/**
 * 在指定配置下执行一段异步逻辑（作用域内 getConfig() 返回 cfg）。
 * @template T
 * @param {object} cfg 生效配置（通常是默认 + 会话覆盖的合并结果）
 * @param {() => T} fn
 * @returns {T}
 */
export function runWithConfig(cfg, fn) {
  return storage.run(cfg, fn);
}

/** 当前作用域配置；不在作用域内返回 null。 */
export function scopedConfig() {
  return storage.getStore() || null;
}

/** 是否处于某个会话的配置作用域内。 */
export function hasConfigScope() {
  return Boolean(storage.getStore());
}
