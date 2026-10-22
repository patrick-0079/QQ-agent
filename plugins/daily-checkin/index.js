// 每日签到（确定性型，plugins/）
//
// 判定理由（对应文档的三问判断法）：
//   ① 要做什么：群友说“签到/打卡”，发一笔金币。
//   ② 什么时候触发：关键词命中就必须发，同一天重复请求必须返回同一笔结果。
//   ③ 要不要机器人“动脑子”：不要 —— 发多少、发没发过是纯规则问题，
//      交给模型自由发挥会出现“没查账也敢说发了金币”。
//   所以它是确定性型：注册工具 + 钩子把关，落位 plugins/。
//
// 生效路径（按宿主源码核对，不是猜测）：
//   · registerTool            → 工具进模型的 function 列表
//   · hooks['before-llm-messages'] → 关键词命中时往本轮上下文塞任务提示，不靠模型自觉
//   · promptSections()        → 常驻规则片段。宿主确实调用的是这个函数名。
//   （注意：能力名 message.trigger 在宿主 src/ 里没有任何消费点，
//     那个 provider 属于“写了也不生效”，所以这里不再靠它。）
//
// 金币不自己记账：通过宿主能力 currency.v1 接入已安装的「货币系统」，
// 与余额/转账/流水/排行榜共用同一本账（见 plugins/currency/API.md）。
// 写入需要货币插件设置里给 daily-checkin 授予 credit 权限；缺少权限时
// 工具会明确报错并给出改法，不会静默失败。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** 数据目录：与 currency 插件同一套约定（优先宿主环境变量，其次安装目录下的 data/）。 */
function defaultDataDirectory(pluginUrl = import.meta.url, env = process.env) {
  if (env.QQ_AGENT_DATA_DIR) return path.resolve(env.QQ_AGENT_DATA_DIR);
  const raw = String(env.QQ_AGENT_PROFILE || '').trim();
  const profile = /^\d+$/.test(raw) ? raw : '';
  // ../ 从 plugins/daily-checkin/ 上跳到 plugins/，../../ 到 App 根，再加 data/。
  return fileURLToPath(new URL(`../../data${profile ? `-${profile}` : ''}/`, pluginUrl));
}

const STATE_VERSION = 1;
const MAX_AMOUNT = 1_000_000_000_000;
const REWARD_LIMIT = 1_000_000;
const DEFAULT_TRIGGERS = '签到\n打卡\n签到啦\n每日签到';
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const REQUESTER_FAIL = '没有可确认的发言人，请本人单独 @ 机器人发送「签到」。';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

let hostApi = null;
let checkinToolId = 'daily-checkin__checkin';
let dataDir = defaultDataDirectory();
let state = null;
let settingsProblem = '';
let settingsWarning = '';

// ── 可热改的 JSON 设置文件 ──────────────────────────────────────────────────

/**
 * 用户可以直接编辑的 JSON 设置文件（默认数据目录下的 settings.json）。
 *
 * 为什么不建议改 config.json：那是宿主自己管理的文件，应用里任何一次「保存设置」
 * 都可能整份重写它，手改的内容会被覆盖。这个文件在插件自己的数据目录里，宿主不碰；
 * 并且按修改时间做缓存失效 —— 存盘即生效，不用重启。
 */
const JSON_KEYS = new Map(Object.entries({
  triggerwords: 'triggerWords', 触发关键词: 'triggerWords', 关键词: 'triggerWords',
  basereward: 'baseReward', 基础金币: 'baseReward', 基础签到金币: 'baseReward',
  streakbonus: 'streakBonus', 连签加成: 'streakBonus', 连续第几天加多少: 'streakBonus',
  maxstreakbonus: 'maxStreakBonus', 连签上限: 'maxStreakBonus', 连签加成上限: 'maxStreakBonus',
  firstbonus: 'firstBonus', 首次奖励: 'firstBonus', 首次签到额外奖励: 'firstBonus',
  timezone: 'timeZone', 时区: 'timeZone', 按哪个时区算一天: 'timeZone'
}));

function readSettingsFile(rawSettings = {}) {
  const name = String(rawSettings.settingsFile ?? 'settings.json').trim();
  if (!name) return { data: {}, error: '', file: '' };
  const file = path.isAbsolute(name) ? name : path.join(dataDir, name);
  let text;
  try { text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); }
  catch (error) { return { data: {}, error: '', file: error.code === 'ENOENT' ? '' : String(error.message || error) }; }

  // 每次都重新解析：文件只有几 KB，"改了 JSON 没生效"比多读一次文件难查得多。
  let payload;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      payload = { data: {}, error: '设置文件的根必须是一个 JSON 对象（{ ... }）' };
    } else {
      const data = {};
      const unknown = [];
      for (const [key, value] of Object.entries(parsed)) {
        if (key.startsWith('$')) continue;                    // "$说明" 这类注释键
        const mapped = JSON_KEYS.get(String(key).toLowerCase());
        if (!mapped) { unknown.push(key); continue; }
        data[mapped] = value;
      }
      payload = { data, error: '' };
      if (unknown.length) payload.unknown = unknown;
    }
  } catch (error) {
    payload = { data: {}, error: `设置文件不是合法 JSON（${error.message}）` };
  }
  return { ...payload, file };
}
let zoneCache = { zone: '', formatter: null };
const injectedSessions = new Map();

// ── 设置 ────────────────────────────────────────────────────────────────────

function clampNumber(value, fallback, min, max) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 算出设置。设置文件写坏时**不抛错**，只把原因记在 settingsProblem 里；
 * 工具路径走 currentSettings()，会明确拒绝执行而不是退回默认值。
 */
function resolveSettings() {
  let rawInput = {};
  try { rawInput = hostApi?.config?.() ?? {}; } catch { rawInput = {}; }

  const raw = { ...rawInput };
  const fromFile = readSettingsFile(raw);
  const ignored = Array.isArray(fromFile.unknown) ? fromFile.unknown : [];
  if (fromFile.file && !fromFile.error) Object.assign(raw, fromFile.data);
  // 坏 JSON 才停止发放；写错键名只忽略并提醒
  settingsProblem = fromFile.file && !fromFile.error ? '' : (fromFile.error || '');
  settingsWarning = ignored.length ? `设置文件里有被忽略的键：${ignored.join('、')}（本插件只认 triggerWords、baseReward、streakBonus、maxStreakBonus、firstBonus、timeZone）` : '';

  const timeZone = String(raw?.timeZone ?? '').trim() || 'Asia/Shanghai';
  return {
    triggers: Array.isArray(raw?.triggerWords)
      ? raw.triggerWords.map((s) => String(s ?? '').trim()).filter(Boolean)
      : String(raw?.triggerWords ?? DEFAULT_TRIGGERS).split(/[,，、\r\n]+/).map((s) => s.trim()).filter(Boolean),
    baseReward: clampNumber(raw?.baseReward, 10, 1, REWARD_LIMIT),
    streakBonus: clampNumber(raw?.streakBonus, 2, 0, REWARD_LIMIT),
    maxStreakBonus: clampNumber(raw?.maxStreakBonus, 30, 0, REWARD_LIMIT),
    firstBonus: clampNumber(raw?.firstBonus, 0, 0, REWARD_LIMIT),
    timeZone
  };
}

function currentSettings() {
  const settings = resolveSettings();
  if (settingsProblem) {
    const error = new Error(`插件设置有问题，已停止发放：${settingsProblem}`);
    error.code = 'INVALID_CONFIG';
    throw error;
  }
  return settings;
}

/** 宿主里这个插件是否真的生效（群友在「插件」页关掉开关就绝不下发奖励）。
 *
 *  注意：宿主的 api.isSkillActive(id) 返回的是**布尔值**，不是 {active} 对象。
 *  写成 `?.active !== false` 会恒为 true —— 开关判断会静默失效。
 *  这里两种形状都认（布尔 / {active}），拿不到结论时按"生效"处理。
 */
function selfActive() {
  const answer = hostApi?.isSkillActive?.('daily-checkin');
  if (typeof answer === 'boolean') return answer;
  if (answer && typeof answer === 'object' && Object.hasOwn(answer, 'active')) return answer.active !== false;
  return true;
}

// ── 时间：按配置时区的自然日 ─────────────────────────────────────────────────

function dayFormatter(timeZone) {
  if (zoneCache.zone !== timeZone || !zoneCache.formatter) {
    // 非法时区名会在这里抛错；让调用方把原因变成可读文案。
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    zoneCache = { zone: timeZone, formatter };
  }
  return zoneCache.formatter;
}

function dayKey(now, timeZone) {
  let text;
  try { text = dayFormatter(timeZone).format(new Date(now)); }
  catch { throw fail('INVALID_CONFIG', `时区「${timeZone}」不合法，请在「每日签到」设置里改成 IANA 时区名（如 Asia/Shanghai）。`); }
  if (!DATE_RE.test(text)) throw fail('INTERNAL_ERROR', `无法按「${timeZone}」计算日期。`);
  return text;
}

function daysBetween(from, to) {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / 86400000) : 0;
}

// ── 状态落盘 ────────────────────────────────────────────────────────────────

function emptyState() {
  return { pluginId: 'daily-checkin', version: STATE_VERSION, users: {} };
}

/** 只保留合法形状的记录；单条损坏丢弃，不让整个文件不可用。 */
function sanitize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('签到数据不是对象');
  if (input.pluginId && input.pluginId !== 'daily-checkin') throw new Error('签到数据文件属于其它插件');
  const users = {};
  const source = input.users && typeof input.users === 'object' && !Array.isArray(input.users) ? input.users : {};
  for (const [key, value] of Object.entries(source)) {
    const record = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const lastDate = typeof record.lastDate === 'string' && DATE_RE.test(record.lastDate) ? record.lastDate : '';
    if (!lastDate) continue;
    users[String(key)] = {
      lastDate,
      streak: clampNumber(record.streak, 1, 1, 100000),
      totalDays: clampNumber(record.totalDays, 1, 1, 1000000),
      lastReward: clampNumber(record.lastReward, 0, 0, MAX_AMOUNT),
      lastAt: Number.isFinite(Number(record.lastAt)) ? Number(record.lastAt) : 0,
      zone: String(record.zone || '')
    };
  }
  return { pluginId: 'daily-checkin', version: STATE_VERSION, users };
}

function stateFile() {
  return path.join(dataDir, 'daily-checkin.json');
}

function loadState() {
  if (state) return state;
  const file = stateFile();
  fs.mkdirSync(dataDir, { recursive: true });
  let raw = null;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (raw === null || raw === '') { state = emptyState(); return state; }
  let parsed;
  try { parsed = JSON.parse(raw.replace(/^\uFEFF/, '')); }
  catch { throw new Error(`签到数据不是合法 JSON，请检查或删除这个文件：${file}`); }
  state = sanitize(parsed);
  return state;
}

/** 同步原子写：临时文件 + fsync + rename；写失败就不改内存状态。 */
function saveState(next) {
  const file = stateFile();
  fs.mkdirSync(dataDir, { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx');
    fs.writeFileSync(fd, JSON.stringify(next), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    try { fs.unlinkSync(temp); } catch { /* ignore */ }
  }
  state = next;
  return next;
}

function userRecord(scope, userId) {
  return loadState().users[`${scope}/${userId}`] || null;
}

function putUser(scope, userId, record) {
  const current = loadState();
  return saveState({ ...current, users: { ...current.users, [`${scope}/${userId}`]: record } });
}

// ── 发言人判定（沿用 currency 插件的口径）──────────────────────────────────

function entryText(entry) {
  let text = String(entry?.text || '');
  for (const name of entry?.atNames || []) text = text.replaceAll(String(name), '');
  return text;
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * 从本轮真实消息里确定操作人。
 * 不唯一 / 只有机器人自己发言 / 定时主动发言一律拒绝 —— 否则会变成
 * “随便引用一条别人的消息就能替人签到”。
 * 注意 ctx.session.triggerEntries 在宿主里恒为 undefined，这里只认 session.trigger。
 */
function requester(ctx) {
  if (!ctx?.session || ['done', 'noreply', 'error', 'aborted'].includes(ctx.session.status)) {
    throw fail('INVALID_CONTEXT', '当前会话已结束，请重新发送「签到」。');
  }
  const source = ctx.session.triggerEntries ?? ctx.session.trigger;
  const raw = Array.isArray(source) ? source : (source ? [source] : []);
  if (!raw.length || ctx.proactive === true) throw fail('INVALID_CONTEXT', REQUESTER_FAIL);
  const entries = raw.filter((entry) => entry && !entry.self && !entry.recalled && !entry.isPoke
    && String(entry.senderId) !== String(ctx.selfId));
  if (!entries.length) throw fail('INVALID_CONTEXT', REQUESTER_FAIL);
  if (new Set(entries.map((entry) => String(entry.senderId))).size !== 1) {
    throw fail('AMBIGUOUS_REQUESTER', '本轮有多位群友发言，请本人单独 @ 机器人发送「签到」。');
  }
  const userId = String(entries[0].senderId);
  if (!/^[1-9]\d{4,11}$/.test(userId)) throw fail('INVALID_CONTEXT', REQUESTER_FAIL);
  if (ctx.kind === 'private' && userId !== String(ctx.chatId)) throw fail('INVALID_CONTEXT', REQUESTER_FAIL);
  return { userId };
}

// ── 货币能力（软依赖：没有货币系统也能给出可读提示，不硬依赖）──────────────

function moneyProvider() {
  const money = hostApi?.capability?.('currency.v1', { consumer: 'daily-checkin' });
  if (!money || money.apiVersion !== 1) {
    throw fail('UNAVAILABLE', '没有可用的金币系统：请确认「货币系统」插件已安装并启用（签到发的金币就存在它里面）。');
  }
  return money;
}

function currencyNameOf(money) {
  const name = String(money.info()?.currencyName ?? '').trim();
  return name || '金币';
}

/** 把货币接口的错误码换成群友/你能看懂的话。 */
function explain(code, message) {
  if (code === 'FORBIDDEN') {
    return '签到还没有发币权限：在「插件 → 货币系统 → 扩展接入权限」里填 {"daily-checkin":["credit"]} 后保存即可。';
  }
  if (code === 'UNAVAILABLE') return '金币系统当前不可用（可能被停用或刚重载），稍后再试。';
  if (code === 'INVALID_CONFIG') return String(message || '插件设置不合法。');
  if (code === 'BALANCE_LIMIT') return '这个钱包已经到达金币上限，本次奖励发不进去。';
  if (code === 'INVALID_CONTEXT' || code === 'AMBIGUOUS_REQUESTER') return String(message);
  return String(message || '金币操作失败');
}

// ── 签到逻辑 ────────────────────────────────────────────────────────────────

function run(work) {
  try { return { ok: true, ...work() }; }
  catch (error) { return { ok: false, code: error.code || 'INTERNAL_ERROR', message: error.message || String(error) }; }
}

function planFor(record, today, zone) {
  if (record && record.lastDate === today && record.zone === zone) {
    return { date: today, streak: record.streak, totalDays: record.totalDays, repeat: true, reward: record.lastReward };
  }
  const previous = record && record.zone === zone ? record : null;
  const gap = previous ? daysBetween(previous.lastDate, today) : Infinity;
  return {
    date: today,
    streak: previous && gap === 1 ? (Number(previous.streak) || 0) + 1 : 1,
    totalDays: (previous ? Number(previous.totalDays) || 0 : 0) + 1,
    repeat: false,
    reward: 0,
    first: !previous
  };
}

function rewardFor(config, plan) {
  const bonus = Math.min(Math.max(plan.streak - 1, 0) * config.streakBonus, config.maxStreakBonus);
  return Math.min(config.baseReward + bonus + (plan.first ? config.firstBonus : 0), REWARD_LIMIT);
}

function runCheckIn(ctx, args = {}, now = Date.now()) {
  const actor = requester(ctx);
  if (!selfActive()) throw fail('UNAVAILABLE', '每日签到当前未生效：请在「插件」页确认它是打开的。');
  const config = currentSettings();
  const money = moneyProvider();
  const scope = String(ctx.chatKey);
  const userId = actor.userId;
  const zone = config.timeZone;
  const today = dayKey(now, zone);
  const record = userRecord(scope, userId);
  const plan = planFor(record, today, zone);
  const currencyName = currencyNameOf(money);

  if (plan.repeat) {
    const balance = money.balance({ scope, userId });
    return {
      action: 'checkin', date: today, timeZone: zone, alreadyCheckedInToday: true,
      streak: plan.streak, totalDays: plan.totalDays, reward: plan.reward, rewardIssued: false,
      balance: balance.ok ? balance.balance : null, available: balance.ok ? balance.available : null, currencyName,
      note: '今天已经签到过了，没有重复发放金币。把首次结果如实告诉群友，不要当成新的奖励。'
    };
  }

  const amount = rewardFor(config, plan);
  const credited = money.credit({
    scope,
    userId,
    amount,
    // 幂等键：扩展 + 人 + 日期。同一天重试永远指向同一笔交易，不会重复发币。
    requestId: `daily-checkin:${userId}:${today}`,
    reason: `每日签到（连续第 ${plan.streak} 天）`
  });
  if (!credited.ok) throw fail(credited.code, explain(credited.code, credited.message));

  const replayed = credited.receipt?.replayed === true;
  let saved = plan.repeat ? record : null;
  if (!saved) {
    saved = { lastDate: today, streak: plan.streak, totalDays: plan.totalDays, lastReward: amount, lastAt: now, zone };
    try { putUser(scope, userId, saved); }
    catch { /* 金币已入账，不能因为本地记录写失败就回报失败 */ }
  }

  const balance = money.balance({ scope, userId });
  return {
    action: 'checkin', date: today, timeZone: zone, alreadyCheckedInToday: replayed,
    streak: saved.streak, totalDays: saved.totalDays, reward: amount, rewardIssued: true,
    baseReward: config.baseReward,
    streakBonus: Math.min(Math.max(saved.streak - 1, 0) * config.streakBonus, config.maxStreakBonus),
    firstBonus: plan.first ? config.firstBonus : 0,
    balance: balance.ok ? balance.balance : null, available: balance.ok ? balance.available : null, currencyName,
    note: '这是真实入账结果。请按人设自然回复：连续第几天、拿到多少金币、当前余额；不要暴露文件名或内部编号。'
  };
}

function runQuery(ctx, args = {}, now = Date.now()) {
  const actor = requester(ctx);
  const config = currentSettings();
  const money = moneyProvider();
  const scope = String(ctx.chatKey);
  const target = args.userId === undefined || args.userId === null ? actor.userId : String(args.userId);
  if (!/^[1-9]\d{4,11}$/.test(target)) throw fail('INVALID_ARGUMENT', 'userId 必须是有效 QQ 号。');
  if (target !== actor.userId) throw fail('FORBIDDEN', '只能查询本人的签到状态。');
  const today = dayKey(now, config.timeZone);
  const record = userRecord(scope, target);
  const balance = money.balance({ scope, userId: target });
  return {
    action: 'status', date: today, timeZone: config.timeZone,
    checkedInToday: Boolean(record && record.lastDate === today && record.zone === config.timeZone),
    streak: record ? record.streak : 0, totalDays: record ? record.totalDays : 0,
    lastDate: record ? record.lastDate : null, lastReward: record ? record.lastReward : 0,
    rules: {
      baseReward: config.baseReward, streakBonus: config.streakBonus,
      maxStreakBonus: config.maxStreakBonus, firstBonus: config.firstBonus
    },
    balance: balance.ok ? balance.balance : null, currencyName: currencyNameOf(money),
    note: '签到规则与本人当前状态。回复时用这里的真实数字，不要编造奖励。'
  };
}

// ── 关键词识别与提示词注入 ──────────────────────────────────────────────────

function detect(entries, config) {
  if (!config.triggers.length || !Array.isArray(entries)) return null;
  for (const entry of entries) {
    if (!entry || entry.self || entry.recalled || entry.isPoke) continue;
    const text = entryText(entry);
    const word = config.triggers.find((item) => text.includes(item));
    if (word) return { word, text };
  }
  return null;
}

function cleanupSessions(now = Date.now()) {
  for (const [id, item] of injectedSessions) if (now - item.at > SESSION_TTL_MS) injectedSessions.delete(id);
}

// ── 生命周期 ────────────────────────────────────────────────────────────────

export function setup(api) {
  hostApi = api;
  checkinToolId = api.registerTool({
    id: 'checkin',
    name: '每日签到',
    icon: '📅',
    category: 'query',
    defaultEnabled: true,
    description: '给本轮真实发言人发放当天签到金币（每个群独立、每天一次、按配置时区的自然日重置、连签递增）。'
      + '只在群友明确说「签到/打卡」时调用，返回真实入账结果与余额。不能替别人签到，转述或引用别人的消息不算授权。'
      + 'action：checkin 领取今天的金币（默认），status 只查询本人签到状态与规则。'
      + '工具不会自己发消息，拿到结果后必须调用 send_message 告知真实结果。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['checkin', 'status'], description: 'checkin 领取今天的签到金币；status 查询本人签到状态与规则。' },
        userId: { type: 'string', pattern: '^[1-9]\\d{4,11}$', description: 'status 可选，只能填本人 QQ 号；不接受昵称。' },
        messageId: { type: 'string', pattern: '^(?:-?\\d+|local:[1-9]\\d*)$', description: '提出签到的那条本轮真实消息编号，来自聊天记录；没有 QQ 编号时用 local:本地编号。' }
      },
      required: ['action'],
      additionalProperties: false
    },
    async execute(ctx, args) {
      const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
      const result = run(() => {
        const action = input.action ?? 'checkin';
        if (!['checkin', 'status'].includes(action)) throw fail('INVALID_ARGUMENT', 'action 只能是 checkin 或 status。');
        for (const key of Object.keys(input)) {
          if (!['action', 'userId', 'messageId'].includes(key)) throw fail('INVALID_ARGUMENT', `未知参数：${key}`);
        }
        return action === 'status' ? runQuery(ctx, input) : runCheckIn(ctx, input);
      });
      if (result.ok) {
        return {
          content: `${JSON.stringify(result)}\n上述结果尚未发送到 QQ。请调用 send_message，按当前人设自然回复真实结果；不要编造金币、余额或连签天数。`
        };
      }
      return {
        content: `签到没有完成（${result.code}）：${explain(result.code, result.message)}\n请把这个实际原因告诉群友，不要声称签到成功或发了金币。`,
        isError: true
      };
    }
  });
  // 启动自检：数据文件损坏 / 时区写错只记日志，**不在 setup 里抛错** ——
  // setup 抛错会让整条加载失败，群友就打不开「每日签到」的设置页去改回时区。
  // 真正的原因交给 available() 与工具报错呈现。
  try {
    loadState();
    dayKey(Date.now(), currentSettings().timeZone);
  } catch (error) {
    api.warn?.('自检未通过：%s', error?.message ?? error);
  }
}

export function activate() {
  cleanupSessions();
}

export function deactivate() {
  injectedSessions.clear();
}

export function dispose() {
  injectedSessions.clear();
  state = null;
}

export function available() {
  // 注意：这里不要调用 selfActive()。宿主先判开关再调自检，
  // 在自检里再问自己的开关会造成 available → isActive → available 无限递归爆栈。
  try {
    loadState();
    // 先刷新设置（会读 JSON 文件），再检查它有没有问题，否则第一次问总是上一次的结果
    const settings = resolveSettings();
    if (settingsProblem) return { ok: false, reason: `JSON 设置文件有问题：${settingsProblem}` };
    dayKey(Date.now(), settings.timeZone);
  } catch (error) {
    return { ok: false, reason: error.message || String(error) };
  }
  return true;
}

export const providers = {
  /** 给别的扩展用：某人今天签到了没（只读，不写金币）。 */
  'daily-checkin.status'({ chatKey, userId } = {}) {
    try {
      const config = currentSettings();
      const scope = String(chatKey || '');
      const id = String(userId || '');
      if (!/^(group|private):[1-9]\d{4,11}$/.test(scope) || !/^[1-9]\d{4,11}$/.test(id)) return undefined;
      const today = dayKey(Date.now(), config.timeZone);
      const record = userRecord(scope, id);
      return {
        date: today,
        timeZone: config.timeZone,
        checkedInToday: Boolean(record && record.lastDate === today && record.zone === config.timeZone),
        streak: record ? record.streak : 0,
        totalDays: record ? record.totalDays : 0,
        lastDate: record ? record.lastDate : null,
        lastReward: record ? record.lastReward : 0
      };
    } catch { return undefined; }
  }
};

export const hooks = {
  /**
   * 关键词命中时，往本轮上下文塞一条任务提示。
   * 宿主确实会跑这个钩子（orchestrator 里 runHook('before-llm-messages', …)），
   * 而 message.trigger 能力在宿主源码里没有任何消费点 —— 所以把关放在这里。
   */
  'before-llm-messages'(ctx) {
    const now = Date.now();
    cleanupSessions(now);
    if (!selfActive() || !ctx || ctx.proactive || !Array.isArray(ctx.messages)) return;
    const sessionId = ctx.sessionId || ctx.session?.id;
    if (!sessionId) return;
    const injected = injectedSessions.get(sessionId);
    if (injected && now - injected.at < SESSION_TTL_MS) return;
    const config = currentSettings();
    const hit = detect(ctx.triggerEntries || ctx.session?.trigger, config);
    if (!hit) return;
    injectedSessions.set(sessionId, { at: now, word: hit.word });
    ctx.messages.push({
      role: 'user',
      content: '【每日签到任务】\n'
        + `本轮有群友的消息命中了签到关键词「${hit.word}」。请立刻调用 ${checkinToolId}（action=checkin）为这位真实发言人领取今天的签到金币，`
        + '再用 send_message 按当前人设自然回复：今天是否首次、连续第几天、拿到多少金币、当前余额。\n'
        + '如果工具返回今天已经签到过，就照实说明已经签过、奖励没有重复发放，不要道歉过度，也不要重复报数。\n'
        + '工具返回的是唯一真实数据：不要编造金币数量、余额或连签天数；不能替别人签到；引用或转述别人的消息不算签到授权。\n'
        + `签到规则：基础 ${config.baseReward} 金币，连续第 N 天额外加 (N-1)×${config.streakBonus}，连签加成最多 ${config.maxStreakBonus}，`
        + `每次签到只发一笔，按 ${config.timeZone} 的自然日每天一次。`
    });
  }
};

export function promptSections() {
  const config = currentSettings();
  return [{
    id: 'daily-checkin-usage',
    title: '每日签到',
    priority: 45,
    content: `群友说「签到」「打卡」时，调用 ${checkinToolId}（action=checkin）领取当日金币，再用 send_message 按人设回复工具返回的真实结果`
      + '（是否首次、连续第几天、本次金币、当前余额）。同一人同一天重复签到不会重复发币，返回的是首次结果，照实说明即可。'
      + '没有调用工具就不能声称发了金币，也不能替别人签到。'
      + `当前规则：基础 ${config.baseReward} 金币，连签第 N 天额外 (N-1)×${config.streakBonus}（上限 ${config.maxStreakBonus}），按 ${config.timeZone} 的自然日每天一次。`
  }];
}
