// 会话个性化：按会话的配置覆盖、准入与运行时作用域（2026-10-21 改版）
//
// 模型：
//   · "默认设置" = config.json 顶层的全局默认值（设置页「默认设置」项直接编辑它）
//   · 每个会话（group:<id> / private:<id>）在 config.chatProfiles 里可以有一份
//     { alias, pinnedAt, overrides }，overrides 只存"与默认不同"的字段
//   · 运行时进入会话作用域后，getConfig() = 默认 + 该会话 overrides 的合并结果
//     （AsyncLocalStorage 见 config-scope.js）
//
// 准入（替代旧白名单）：
//   · acceptAllSessions=true → 所有会话都可被服务；不在 chatProfiles 里的走默认配置
//   · false → 只有 chatProfiles 里存在的会话被准入（添加会话 = 允许该会话）
//   · deny / globalBlocklist 仍然全局生效，优先于准入
//
// 边界：
//   · 覆盖里不允许出现全局专属字段（SnowLuma / 模型 API / 搜索服务 / 凭据 / 界面偏好…），
//     写入时剥掉，合并时强制回落全局值 —— 防止"在会话里改了端口"这类自相矛盾的配置
//   · 配置合并按 deepMerge；写覆盖时先深克隆，绝不改动全局配置对象

import { getGlobalConfig, updateConfig, deepMerge, getConfigVersion } from './config.js';
import { runWithConfig, scopedConfig } from './config-scope.js';

const KEY_RE = /^(group|private):([A-Za-z0-9_-]+)$/;

/** 覆盖项允许出现的顶层字段（与"可按会话自定义的功能"一一对应）。 */
const ALLOWED_TOP = new Set([
  'persona', 'memory', 'store', 'tools', 'skills',
  'proactive', 'chatActive', 'sticker', 'commandMute', 'blocklist'
]);

/**
 * 全局专属路径：即使会话覆盖里出现（历史数据/前端伪造），合并结果也强制回落全局值。
 * 分类依据见计划：SnowLuma / 模型 API / 搜索服务 / 系统 / 安全 全是全局，不按会话变。
 */
const GLOBAL_ONLY_PATHS = [
  ['snowluma'],
  ['api'],
  ['webSearch'],
  ['providers'],
  ['providersSourceYaml'],
  ['dshProviderKeys'],
  ['deny'],
  ['globalBlocklist'],
  ['communityExemptions'],
  ['security'],
  ['server'],
  ['ui'],
  ['extensions'],
  ['modelVision'],
  ['acceptAllSessions'],
  ['chatProfiles'],
  ['persona', 'botName'],
  ['persona', 'selfNickname'],
  ['store', 'keepSessionFiles'],
  ['store', 'maxMessagesPerChat'],
  ['commandMute', 'active']
];

/** 任何层级都不进覆盖的凭据字段名（凭据永远全局）。 */
const SECRET_KEY_RE = /^(apiKey|accessToken|httpAccessToken|cookie|password|secret)$/i;

// ── 工具 ─────────────────────────────────────────────────────────────
function deepClone(v) {
  if (v === undefined) return v;
  try { return structuredClone(v); } catch { return JSON.parse(JSON.stringify(v)); }
}

function setPath(obj, path, value) {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    if (!cur[k] || typeof cur[k] !== 'object' || Array.isArray(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  if (value === undefined) delete cur[path[path.length - 1]];
  else cur[path[path.length - 1]] = value;
}

function getPath(obj, path) {
  let cur = obj;
  for (const k of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

/** 递归剥掉密钥类字段与派生标记（hasXxx / dshProviderKeyPresence）。 */
function stripSecrets(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    for (const item of node) stripSecrets(item);
    return node;
  }
  for (const key of Object.keys(node)) {
    if (SECRET_KEY_RE.test(key) || /^has[A-Z][A-Za-z0-9]*$/.test(key) || key === 'dshProviderKeyPresence') {
      delete node[key];
      continue;
    }
    stripSecrets(node[key]);
  }
  return node;
}

/** 只保留允许按会话覆盖的顶层字段；再剥掉各顶层下"永远全局"的子路径。 */
const PROTECTED_SUBPATHS = [
  ['persona', 'botName'],
  ['persona', 'selfNickname'],
  ['store', 'keepSessionFiles'],
  ['store', 'maxMessagesPerChat'],
  ['commandMute', 'active']
];

export function sanitizeOverrides(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  for (const top of Object.keys(input)) {
    if (!ALLOWED_TOP.has(top)) continue;
    const v = input[top];
    if (v === undefined) continue;
    out[top] = deepClone(v);
  }
  for (const path of PROTECTED_SUBPATHS) {
    // path[0] 已经定位到顶层容器（root），从 1 开始往下走
    let cur = out[path[0]];
    if (!cur || typeof cur !== 'object') continue;
    for (let i = 1; i < path.length - 1; i++) {
      const next = cur[path[i]];
      if (!next || typeof next !== 'object' || Array.isArray(next)) { cur = null; break; }
      cur = next;
    }
    if (cur && typeof cur === 'object') delete cur[path[path.length - 1]];
  }
  return stripSecrets(out);
}

/** 把合并结果里出现的全局专属字段回落到全局值（防御性兜底）。 */
function enforceGlobalOnly(merged, global) {
  for (const path of GLOBAL_ONLY_PATHS) {
    const gv = getPath(global, path);
    setPath(merged, path, gv === undefined ? undefined : deepClone(gv));
  }
  return stripSecrets(merged);
}

// ── 会话标识 ─────────────────────────────────────────────────────────
export function isValidChatKey(key) {
  return KEY_RE.test(String(key || ''));
}

export function parseChatKey(key) {
  const m = KEY_RE.exec(String(key || ''));
  if (!m) return null;
  return { key: `${m[1]}:${m[2]}`, kind: m[1], id: m[2] };
}

export function makeChatKey(kind, id) {
  return `${String(kind).trim()}:${String(id).trim()}`;
}

// ── 最小化覆盖：只存与默认不同的字段 ─────────────────────────────────
const isPlainObj = (v) => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const isMarker = (v) => isPlainObj(v) && '__replace__' in v;
const jsonEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * 对单个分区做最小化：与默认一致的子树不进覆盖。
 * __replace__ 标记保留语义：替换后的值若与默认一致 → 该子树也不需要覆盖。
 * @returns {object|undefined} undefined = 该分区与默认一致，无需覆盖
 */
function minimalSection(def, node) {
  if (isMarker(node)) {
    return jsonEq(def, node.__replace__) ? undefined : node;
  }
  if (!isPlainObj(node) || !isPlainObj(def)) {
    return jsonEq(def, node) ? undefined : node;   // 叶子 / 数组
  }
  const out = {};
  let any = false;
  for (const [k, v] of Object.entries(node)) {
    const dv = def[k];
    if (isMarker(v)) {
      if (jsonEq(dv, v.__replace__)) continue;
      out[k] = v; any = true; continue;
    }
    if (isPlainObj(v) && isPlainObj(dv)) {
      const sub = minimalSection(dv, v);
      if (sub === undefined) continue;
      out[k] = sub; any = true; continue;
    }
    if (jsonEq(dv, v)) continue;
    out[k] = v; any = true;
  }
  return any ? out : undefined;
}

// ── profile 增删改查（全部走 updateConfig，天然写盘 + 失效缓存）──────
function currentProfiles() {
  const cfg = getGlobalConfig();
  const p = cfg.chatProfiles;
  return (p && typeof p === 'object' && !Array.isArray(p)) ? p : {};
}

function writeProfiles(profiles) {
  updateConfig({ chatProfiles: { __replace__: profiles } });
}

export function getProfile(key) {
  const parsed = parseChatKey(key);
  if (!parsed) return null;
  const p = currentProfiles()[parsed.key];
  return p ? deepClone(p) : null;
}

/** 创建/更新会话条目（alias / pinnedAt）。创建即准入（acceptAllSessions=false 时）。 */
export function upsertProfile(key, patch = {}) {
  const parsed = parseChatKey(key);
  if (!parsed) throw new Error(`非法会话标识：${key}`);
  const profiles = { ...currentProfiles() };
  const now = Date.now();
  const prev = { alias: '', pinnedAt: 0, overrides: {}, createdAt: now, updatedAt: now, ...(profiles[parsed.key] || {}) };
  const next = {
    ...prev,
    alias: patch.alias !== undefined ? String(patch.alias ?? '').slice(0, 60) : prev.alias,
    pinnedAt: patch.pinnedAt !== undefined ? Math.max(0, Number(patch.pinnedAt) || 0) : prev.pinnedAt,
    updatedAt: now
  };
  profiles[parsed.key] = next;
  writeProfiles(profiles);
  return deepClone(next);
}

/** 整体替换覆盖（sanitize 后）。 */
export function setProfileOverrides(key, overrides = {}) {
  const parsed = parseChatKey(key);
  if (!parsed) throw new Error(`非法会话标识：${key}`);
  const profiles = { ...currentProfiles() };
  const now = Date.now();
  const prev = profiles[parsed.key] || { alias: '', pinnedAt: 0, createdAt: now, updatedAt: now };
  prev.overrides = sanitizeOverrides(overrides);
  prev.updatedAt = now;
  profiles[parsed.key] = prev;
  writeProfiles(profiles);
  return { profile: deepClone(prev), overrides: deepClone(prev.overrides) };
}

/**
 * 深合并写覆盖（前端"自定义某个分区并保存"走这里）。
 * 存储做**最小化**：与默认一致的子树不进 overrides（"跟随默认"语义自然成立）。
 */
export function patchProfileOverrides(key, patch = {}) {
  const parsed = parseChatKey(key);
  if (!parsed) throw new Error(`非法会话标识：${key}`);
  const profiles = { ...currentProfiles() };
  const now = Date.now();
  const prev = { overrides: {}, ...(profiles[parsed.key] || {}) };
  prev.overrides = { ...(prev.overrides || {}) };
  const global = getGlobalConfig();
  const clean = sanitizeOverrides(patch);
  for (const top of Object.keys(clean)) {
    const defSec = isPlainObj(global[top]) ? deepClone(global[top]) : (global[top] ?? {});
    const existing = prev.overrides[top];
    const mergedTop = deepMerge(
      isPlainObj(defSec) ? deepClone(defSec) : defSec ?? {},
      isPlainObj(existing) ? deepMerge(deepClone(existing), clean[top]) : clean[top]
    );
    const minimal = minimalSection(defSec, mergedTop);
    if (minimal === undefined) delete prev.overrides[top];
    else prev.overrides[top] = minimal;
  }
  // 若没有 clean 传入的顶层（如 blocklist 存量），保持在 overrides 里不动
  if (!Object.keys(clean).length && !Object.keys(prev.overrides).length && !profiles[parsed.key]) {
    // 首次写入就全空：仍建一条准入条目
  }
  prev.updatedAt = now;
  profiles[parsed.key] = prev;
  writeProfiles(profiles);
  return { profile: deepClone(prev), overrides: deepClone(prev.overrides) };
}

/** 恢复某个分区为默认（删除该分区覆盖）。 */
export function clearProfileSection(key, section) {
  const parsed = parseChatKey(key);
  if (!parsed) throw new Error(`非法会话标识：${key}`);
  if (!ALLOWED_TOP.has(String(section))) throw new Error(`不允许按会话覆盖的分区：${section}`);
  const profiles = { ...currentProfiles() };
  const p = profiles[parsed.key];
  if (!p) return { profile: null, cleared: false };
  p.overrides = { ...(p.overrides || {}) };
  delete p.overrides[String(section)];
  p.updatedAt = Date.now();
  profiles[parsed.key] = p;
  writeProfiles(profiles);
  return { profile: deepClone(p), cleared: true };
}

/**
 * 从**所有会话**的覆盖里删掉某个技能/插件的开关与设置。
 *
 * 用于扩展被删除（仓库删除按钮 / 清理残留配置）：文件都没了，
 * 各会话里留着 `skills.<id>` 只会变成永远不可用的脏配置。
 *
 * @returns {number} 被清理的会话数
 */
export function purgeSkillFromProfiles(id) {
  const sid = String(id);
  const profiles = { ...currentProfiles() };
  let purged = 0;
  for (const [key, p] of Object.entries(profiles)) {
    const skills = p?.overrides?.skills;
    if (!skills || !Object.prototype.hasOwnProperty.call(skills, sid)) continue;
    const nextSkills = { ...skills };
    delete nextSkills[sid];
    const nextOverrides = { ...(p.overrides || {}) };
    if (Object.keys(nextSkills).length) nextOverrides.skills = nextSkills;
    else delete nextOverrides.skills;
    profiles[key] = { ...p, overrides: nextOverrides, updatedAt: Date.now() };
    purged++;
  }
  if (purged) writeProfiles(profiles);
  return purged;
}

/** 移除会话条目（= 不再准入，acceptAllSessions=false 时）。聊天/记忆数据不动。 */
export function removeProfile(key) {
  const parsed = parseChatKey(key);
  if (!parsed) return false;
  const profiles = { ...currentProfiles() };
  if (!profiles[parsed.key]) return false;
  delete profiles[parsed.key];
  writeProfiles(profiles);
  return true;
}

export function listProfiles() {
  return deepClone(currentProfiles());
}

// ── 生效配置与作用域 ─────────────────────────────────────────────────
const effectiveCache = new Map();   // chatKey -> { configVersion, cfg }

/**
 * 取某个会话的生效配置（默认 + 覆盖，全局专属字段强制回落）。
 * ⚠️ 返回对象是缓存里的活对象 —— 调用方只读，不得修改。
 */
export function effectiveConfigForChat(chatKey) {
  const parsed = parseChatKey(chatKey);
  const global = getGlobalConfig();
  if (!parsed) return global;
  const cv = getConfigVersion();
  const cached = effectiveCache.get(parsed.key);
  if (cached && cached.configVersion === cv && cached.globalRef === global) return cached.cfg;

  const profile = currentProfiles()[parsed.key];
  const overrides = profile ? sanitizeOverrides(profile.overrides) : {};
  const cfg = Object.keys(overrides).length
    ? enforceGlobalOnly(deepMerge(deepClone(global), overrides), global)
    : enforceGlobalOnly(deepClone(global), global);
  effectiveCache.set(parsed.key, { configVersion: cv, globalRef: global, cfg });
  return cfg;
}

/** 在某个会话的配置作用域内执行 fn（运行时入口用）。 */
export function withChatScope(chatKey, fn) {
  return runWithConfig(effectiveConfigForChat(chatKey), fn);
}

/** 当前是否处于会话作用域（供 config.js 等底层判断用）。 */
export function inChatScope() {
  return scopedConfig() != null;
}

// ── 准入 ─────────────────────────────────────────────────────────────
/**
 * 会话是否被服务（替代旧 allowed()）：
 *   1. deny / globalBlocklist 命中 → 拒绝（原 allowed() 只查 deny，全局屏蔽在入口另判）
 *   2. acceptAllSessions=true → 接受
 *   3. chatProfiles 里存在该会话（"添加到会话自定义"）→ 接受
 */
export function isChatAdmitted(chatKey) {
  const parsed = parseChatKey(chatKey);
  if (!parsed) return false;
  const cfg = getGlobalConfig();
  const denyList = cfg.deny?.[parsed.kind] ?? cfg.deny?.[`${parsed.kind}s`] ?? [];
  if (denyList.map(String).includes(parsed.id)) return false;
  if (cfg.acceptAllSessions === true) return true;
  return Boolean(currentProfiles()[parsed.key]);
}

/** 是否命中黑名单（拒绝处理，优先级最高；与是否添加会话无关）。 */
export function isChatDenied(chatKey) {
  const parsed = parseChatKey(chatKey);
  if (!parsed) return false;
  const cfg = getGlobalConfig();
  const denyList = cfg.deny?.[parsed.kind] ?? cfg.deny?.[`${parsed.kind}s`] ?? [];
  return denyList.map(String).includes(parsed.id);
}

/** 按 kind/id 的便捷包装（与旧 allowed(kind, id) 调用点对齐）。 */
export function isChatAdmittedById(kind, id) {
  if (!id) return false;
  return isChatAdmitted(`${kind}:${id}`);
}

// ── 技能/插件生命周期辅助 ─────────────────────────────────────────────
/** 全局默认是否启用（skills[id].enabled 未显式设 false 即启用）。 */
export function isSkillGloballyEnabled(id, enabledByDefault = true) {
  const raw = getGlobalConfig()?.skills?.[String(id)];
  if (!raw || raw.enabled === undefined) return enabledByDefault !== false;
  return raw.enabled !== false;
}

/** 是否有任一会话在 profile 里显式启用了该技能。 */
export function isSkillEnabledInAnyProfile(id) {
  for (const p of Object.values(currentProfiles())) {
    const o = p?.overrides?.skills?.[String(id)];
    if (o && typeof o === 'object' && o.enabled === true) return true;
  }
  return false;
}

/**
 * 该技能是否被"任何地方"需要（决定 activate/deactivate 生命周期）：
 * 全局默认启用 或 任一会话启用。文件只装一份，启用是配置层面的。
 */
export function isSkillWantedAnywhere(id, enabledByDefault = true) {
  return isSkillGloballyEnabled(id, enabledByDefault) || isSkillEnabledInAnyProfile(id);
}

// ── 会话列表（设置面板左栏用）────────────────────────────────────────
/** 已单独配置的会话 key 集合（"默认会话" = 其余所有会话）。 */
export function profiledChatKeys() {
  return new Set(Object.keys(currentProfiles()));
}

/** 所有已知会话 key（存档 + 运行记录 + 记忆 + 已配置），不区分是否准入。 */
export function collectChatKeys({ store, sessions, memory } = {}) {
  const keys = new Set();
  try { for (const k of (store?.listChats?.() || [])) keys.add(k); } catch { /* ignore */ }
  try { for (const e of (sessions?.index || [])) if (e?.chatKey) keys.add(e.chatKey); } catch { /* ignore */ }
  try { for (const k of (memory?.listChats?.() || [])) keys.add(k); } catch { /* ignore */ }
  return keys;
}

/**
 * 合并所有已知会话：chatProfiles（准入的）+ 消息存档 + 运行记录 + 记忆文件。
 * @param {object} sources { store, sessions, memory, getChatName(parsed)=>Promise<string> }
 */
export async function listChatSessions({ store, sessions, memory, getChatName } = {}) {
  const cfg = getGlobalConfig();
  const keys = new Set(Object.keys(currentProfiles()));
  try { for (const k of (store?.listChats?.() || [])) keys.add(k); } catch { /* ignore */ }
  try { for (const e of (sessions?.index || [])) if (e?.chatKey) keys.add(e.chatKey); } catch { /* ignore */ }
  try { for (const k of (memory?.listChats?.() || [])) keys.add(k); } catch { /* ignore */ }

  const items = [];
  for (const raw of keys) {
    const parsed = parseChatKey(raw);
    if (!parsed) continue;
    const key = parsed.key;
    const profile = currentProfiles()[key] || null;
    let messageCount = 0, unread = 0, lastTs = 0;
    try {
      const m = store?.getChatMeta?.(key);
      if (m) { messageCount = m.total ?? 0; unread = m.unread ?? 0; lastTs = m.lastTs ?? 0; }
    } catch { /* ignore */ }
    let name = '';
    if (!profile?.alias && typeof getChatName === 'function') {
      try { name = String(await getChatName(parsed) || ''); } catch { /* ignore */ }
    }
    const alias = profile?.alias || '';
    items.push({
      key,
      kind: parsed.kind,
      id: parsed.id,
      name: alias || name || (parsed.kind === 'group' ? `群 ${parsed.id}` : `QQ ${parsed.id}`),
      alias,
      pinnedAt: profile?.pinnedAt || 0,
      hasProfile: Boolean(profile),
      admitted: isChatAdmitted(key),
      overrideCount: profile ? Object.keys(profile.overrides || {}).length : 0,
      messageCount,
      unread,
      lastTs
    });
  }
  items.sort((a, b) => {
    if (a.hasProfile !== b.hasProfile) return a.hasProfile ? -1 : 1;   // 已准入/已自定义的在前
    if ((b.pinnedAt || 0) !== (a.pinnedAt || 0)) return (b.pinnedAt || 0) - (a.pinnedAt || 0);
    return (b.lastTs || 0) - (a.lastTs || 0);
  });
  return { sessions: items, acceptAllSessions: cfg.acceptAllSessions === true };
}
