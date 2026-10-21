// Skill 配置读写：所有 Skill 开关的唯一入口。
//
// 核心原则（防止"多个开关打架"）：
//   1. Skill 的启用状态**只**存在 config.skills[id].enabled 一处；
//      模块不允许再维护 config.xxx.enabled 之类的影子开关。
//   2. 旧配置里的历史字段（如 api.vision、webSearch.enabled）仍然由各自模块读取
//      （它们是"功能开关"，不是"Skill 开关"），但 Skill 自己不再复制一份。
//   3. 读取时用 manifest.settings 作为默认值补齐，保证 Skill 侧拿到的配置形状稳定。

import { getConfig, updateConfig } from '../config.js';

/**
 * 本次进程内被强制“新装默认关闭”的扩展。
 *
 * 为什么需要：配置写盘可能失败（Windows 上 watcher 与写配置抢文件、磁盘临时占用）；
 * 失败后 isEnabled 会回落到 manifest.enabledByDefault=true，UI 看起来就是“新装默认开启”。
 * 有这层内存兜底后，即使写盘失败，本次进程也一定按关闭处理；用户显式打开时清除。
 */
const forcedDefaultOff = new Set();

export function markSkillDefaultOff(id) {
  forcedDefaultOff.add(String(id));
}

export function clearSkillDefaultOff(id) {
  forcedDefaultOff.delete(String(id));
}

export function isSkillForcedDefaultOff(id) {
  return forcedDefaultOff.has(String(id));
}

/** 取某个 Skill 的配置对象（已与 manifest 默认值合并）。 */
export function getSkillConfig(id, defaults = {}) {
  const raw = getConfig()?.skills?.[String(id)];
  const merged = { ...(defaults || {}) };
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      if (v !== undefined) merged[k] = v;
    }
  }
  return merged;
}

/**
 * Skill 是否被用户开启。
 * 未配置过时回退到 manifest 的 enabledByDefault（默认 true）；
 * 但本次进程标记为“新装默认关闭”的条目一律返回 false（除非用户显式打开）。
 */
export function isSkillEnabledInConfig(id, enabledByDefault = true) {
  const key = String(id);
  if (forcedDefaultOff.has(key)) return false;
  const raw = getConfig()?.skills?.[key];
  if (!raw || raw.enabled === undefined) return enabledByDefault !== false;
  return raw.enabled !== false;
}

/** 写入某个 Skill 的配置（浅合并进该 Skill 的命名空间）。 */
export function setSkillConfig(id, patch) {
  const key = String(id);
  // 显式打开 = 用户操作，解除“新装默认关闭”内存标记。
  if (patch && patch.enabled === true) forcedDefaultOff.delete(key);
  const current = getConfig()?.skills?.[key];
  const next = { ...(current && typeof current === 'object' ? current : {}), ...(patch || {}) };
  const cfg = updateConfig({ skills: { [key]: next } });
  return cfg.skills?.[key] || next;
}

/** 只切开关，保留该 Skill 的其它配置。 */
export function setSkillEnabled(id, enabled) {
  return setSkillConfig(id, { enabled: !!enabled });
}

/** 当前配置里已存在的 Skill 配置键（用于 UI 显示"已配置但未安装"的 Skill）。 */
export function listConfiguredSkillIds() {
  const skills = getConfig()?.skills;
  if (!skills || typeof skills !== 'object') return [];
  return Object.keys(skills);
}
