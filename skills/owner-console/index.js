// 主人控制台（LLM 型 · skills/owner-console/）
//
// 目标：**主人用自己的 QQ 私聊机器人**，就能查看/开关任意技能与插件、改这些扩展的设置项。
// 为什么做成技能（LLM 型）而不是插件：这里要理解"把 B站推送关掉""早上好改成 7 点半"
// 这种人话 → 请求由模型解析成结构化参数 → 属于 LLM 型，放 skills/。
//
// ── 安全设计（这是本技能最重要的部分）──────────────────────────────────
//   1. 只在**私聊**里生效：群里发指令谁都能看见，等于把管理口令贴在公告栏上。
//   2. 私聊对象必须是**主人自己的 QQ**（设置里的 ownerQq；默认已填你的大号）。
//   3. 再核一次"刚说话的人"是不是主人（store.recent 里的 senderId）——私聊白名单
//      本来已经保证这一点，多一道不亏。
//   4. 改设置时**只允许清单里声明过的键**（manifest 的 settings + configSchema），
//      与控制台 UI 完全同一口径 —— 模型编不出别的字段往配置里塞。
//   5. 不做任意配置写：只开放"扩展自己的设置"，核心项（API Key、白名单、
//      发送限频等）一律不碰 —— 那些改错了能让机器人彻底失联。
//
// ⚠️ 本技能**只读/只改扩展配置**，不自己发消息、不调模型（符合核心的硬约束）。
import { getConfig } from '../../src/config.js';
import { setSkillConfig, setSkillEnabled } from '../../src/skills/config.js';
import { skillManager } from '../../src/skills/manager.js';

let cfg = () => ({});
let log = () => {};
let warn = () => {};

function ok(payload) { return { content: JSON.stringify(payload, null, 1) }; }
function err(message) { return { content: String(message), isError: true }; }

/**
 * 身份闸：只有在"主人的私聊"里才放行。
 * @returns {{ok:true}|{ok:false,error:string}}
 */
function ownerGate(ctx) {
  const owner = String(cfg()?.ownerQq || '').trim();
  if (!/^\d{5,12}$/.test(owner)) return { ok: false, error: '没配置主人的 QQ 号（技能设置里填「主人的 QQ 号」）' };
  const kind = String(ctx?.kind || '');
  const chatId = String(ctx?.chatId || '');
  if (kind !== 'private') {
    return { ok: false, error: '这个操作只能在**私聊**里做（群里发指令谁都能看见，不安全）' };
  }
  if (chatId !== owner) {
    return { ok: false, error: `这个私聊不是主人的 QQ（当前 ${chatId || '未知'}），拒绝执行` };
  }
  // 再核"最近说话的人"是不是主人：私聊白名单已保证，这里只做兜底
  try {
    const recent = (typeof ctx?.store?.recent === 'function')
      ? (ctx.store.recent(ctx.chatKey, { limit: 10, includeSelf: false }) || [])
      : [];
    const last = [...recent].reverse().find((m) => m && m.senderId);
    if (last && String(last.senderId) !== owner) {
      return { ok: false, error: `最近的发言者（${last.senderId}）不是主人，拒绝执行` };
    }
  } catch { /* 拿不到就不额外拦 */ }
  return { ok: true };
}

/** 归一化：去掉空白/连字符/标点并小写，便于"去AI味"这种口语说法匹配。 */
function norm(s) {
  return String(s ?? '').toLowerCase().replace(/[\s\-_·.。，,、:：;；!！?？()（）【】\[\]"'“”‘’/\\|]/g, '');
}

/**
 * 找一个技能/插件：id 精确 → 名字精确 → 子串 → 反向子串 → 字符覆盖率打分。
 * 打分这一层是为了处理"去AI味" vs 技能真名"去除 AI 味"这类**中间插了字**的说法
 * （子串匹配对这种完全无效 —— 实测就是这么挂掉的）。
 */
export function findSkill(target) {
  const t = String(target ?? '').trim();
  if (!t) return null;
  const list = skillManager.list() || [];
  const tn = norm(t);
  if (!tn) return null;

  let hit = list.find((s) => norm(s.id) === tn) || list.find((s) => norm(s.name) === tn);
  if (hit) return hit;
  hit = list.find((s) => norm(s.id).includes(tn) || norm(s.name).includes(tn));
  if (hit) return hit;
  hit = list.find((s) => tn.includes(norm(s.id)) || (norm(s.name) && tn.includes(norm(s.name))));
  if (hit) return hit;

  // 字符覆盖率：目标里至少 60% 的字出现在候选的 id/名字里
  if (tn.length < 2) return null;
  let best = null;
  let bestScore = 0;
  for (const s of list) {
    const hay = new Set([...norm(s.id), ...norm(s.name)]);
    const need = [...tn];
    const score = need.filter((ch) => hay.has(ch)).length / need.length;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return bestScore >= 0.6 ? best : null;
}

/** 把模型给的值按 schema 转成正确的类型（只做保守转换，不猜）。 */
function coerceValue(schema, raw) {
  const type = schema?.type;
  if (type === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) return { ok: false, error: `要一个数字，收到「${raw}」` };
    if (schema.min !== undefined && n < Number(schema.min)) return { ok: false, error: `不能小于 ${schema.min}` };
    if (schema.max !== undefined && n > Number(schema.max)) return { ok: false, error: `不能大于 ${schema.max}` };
    return { ok: true, value: n };
  }
  if (type === 'boolean') {
    if (typeof raw === 'boolean') return { ok: true, value: raw };
    const s = String(raw ?? '').trim().toLowerCase();
    if (['true', '1', '开', '开启', '打开', '是', 'yes', 'on'].includes(s)) return { ok: true, value: true };
    if (['false', '0', '关', '关闭', '否', 'no', 'off'].includes(s)) return { ok: true, value: false };
    return { ok: false, error: `要 true/false（或 开/关），收到「${raw}」` };
  }
  if (type === 'enum') {
    const values = Array.isArray(schema.values) ? schema.values.map(String) : [];
    const s = String(raw ?? '').trim();
    const hit = values.find((v) => v.toLowerCase() === s.toLowerCase());
    if (!hit) return { ok: false, error: `只能是这些值之一：${values.join(' / ')}` };
    return { ok: true, value: hit };
  }
  if (Array.isArray(raw) || (raw && typeof raw === 'object')) return { ok: false, error: '这个设置项只接受文本' };
  return { ok: true, value: String(raw ?? '') };
}

function compactStatus() {
  const c = getConfig() || {};
  const entries = skillManager.list() || [];
  const list = entries.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    enabled: s.enabled,
    active: s.active,
    error: s.loadError || s.lastError || ''
  }));
  // ⚠️ 设置要看**生效值**（manifest 默认 + 配置覆盖），不能只看 config.json ——
  //    从没在界面上保存过的扩展，config.json 里根本没有它的条目，直接读会全是 undefined
  //    （实测踩到：早上好的设置显示成空对象）。
  const eff = (id) => (entries.find((s) => s.id === id) || {}).settings || {};
  return {
    model: `${c.api?.provider || '?'} / ${c.api?.model || '?'}`,
    crossChatSend: c.tools?.crossChatSend === true,
    allow: { groups: c.allow?.groups || [], private: c.allow?.private || [] },
    proactive: c.proactive?.enabled === true,
    extensions: list,
    morningGreet: (() => {
      const s = eff('morning-greet');
      return { time: s.time, targets: s.targets, graceMinutes: s.graceMinutes, 文案条数: String(s.greetings || '').split('\n').filter(Boolean).length };
    })(),
    biliPush: (() => {
      const s = eff('bili-dynamic-push');
      return { up: s.up, targets: s.targets, intervalMin: s.intervalMin, imageWidth: s.imageWidth, withImages: s.withImages, combineImageText: s.combineImageText };
    })()
  };
}

/** 归一化名字，用于群名/昵称模糊匹配。 */
function normalizeName(s) {
  return String(s ?? '').toLowerCase().replace(/[\s\-_·.。，,、:：;；!！?？()（）【】\[\]"'“”‘’/\\|]/g, '');
}

/**
 * 把「群号或群名」解析成群号。
 * 只认白名单里的群 —— 机器人本来就不被允许在别处说话，戳人/点赞同理。
 */
async function resolveGroup(ctx, key) {
  const s = String(key ?? '').trim();
  const allow = (getConfig()?.allow?.groups || []).map(String);
  if (!s) return { ok: false, error: '没说要哪个群' };
  if (/^\d{5,15}$/.test(s)) {
    if (allow.length && !allow.includes(s)) return { ok: false, error: `群 ${s} 不在允许的会话名单里（白名单：${allow.join('、') || '空'}）` };
    return { ok: true, id: s, name: '' };
  }
  let list = [];
  try { list = (await ctx.onebot.call('get_group_list', {})) || []; } catch (error) { return { ok: false, error: `拿群列表失败：${error?.message ?? error}` }; }
  const inAllow = list.filter((g) => !allow.length || allow.includes(String(g.group_id)));
  const t = normalizeName(s);
  const hit = inAllow.find((g) => normalizeName(g.group_name) === t)
    || inAllow.find((g) => normalizeName(g.group_name).includes(t))
    || inAllow.find((g) => t.includes(normalizeName(g.group_name)));
  if (!hit) {
    return { ok: false, error: `没找到叫「${key}」的群。可用的有：${inAllow.map((g) => `${g.group_name}(${g.group_id})`).join('、') || '（无）'}` };
  }
  return { ok: true, id: String(hit.group_id), name: hit.group_name };
}

/** 把「QQ 号或昵称」解析成 QQ 号（先在指定群里找，再找好友，最后翻一遍允许的群）。 */
async function resolveUser(ctx, who, groupId) {
  const s = String(who ?? '').trim();
  if (!s) return { ok: false, error: '没说要拍/赞谁' };
  if (/^\d{5,15}$/.test(s)) return { ok: true, id: s, name: '' };
  const t = normalizeName(s);
  const pick = (list, getNick, getCard) => {
    const named = (list || []).filter(Boolean);
    return named.find((m) => normalizeName(getCard(m)) === t)
      || named.find((m) => normalizeName(getNick(m)) === t)
      || named.find((m) => normalizeName(getCard(m)).includes(t))
      || named.find((m) => normalizeName(getNick(m)).includes(t));
  };
  // ① 指定群
  if (groupId) {
    try {
      const members = (await ctx.onebot.call('get_group_member_list', { group_id: Number(groupId) })) || [];
      const hit = pick(members, (m) => m.nickname, (m) => m.card);
      if (hit) return { ok: true, id: String(hit.user_id), name: hit.card || hit.nickname };
    } catch { /* 继续往下找 */ }
  }
  // ② 好友列表
  try {
    const friends = (await ctx.onebot.call('get_friend_list', {})) || [];
    const hit = pick(friends, (f) => f.nickname, (f) => f.remark);
    if (hit) return { ok: true, id: String(hit.user_id), name: hit.remark || hit.nickname };
  } catch { /* 继续 */ }
  // ③ 允许的群里逐个找
  const allow = (getConfig()?.allow?.groups || []).map(String);
  for (const gid of allow) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const members = (await ctx.onebot.call('get_group_member_list', { group_id: Number(gid) })) || [];
      const hit = pick(members, (m) => m.nickname, (m) => m.card);
      if (hit) return { ok: true, id: String(hit.user_id), name: `${hit.card || hit.nickname}(在群 ${gid})` };
    } catch { /* 换下一个群 */ }
  }
  return { ok: false, error: `认不出「${who}」是谁。直接把 QQ 号给我最稳（也可以先让我看群成员）` };
}

function registerTools(api) {
  // ── 1) 查看状态 ──
  api.registerTool({
    id: 'owner_status',
    name: '主人控制台·状态',
    description: '查看机器人当前状态：用的是哪个模型、允许说话的会话白名单、跨会话发送开着没有、每个技能/插件的开关与加载状态、'
      + '两个自建插件（B站动态推送、每日早上好）的关键设置。'
      + '只在**主人的私聊**里有效；主人在私聊里问"你现在什么状态""都开了哪些技能""推送都怎么配的"时调用。',
    category: 'system',
    icon: '🛠️',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      const gate = ownerGate(ctx);
      if (!gate.ok) return err(gate.error);
      const st = compactStatus();
      return ok({
        ...st,
        note: '把关键信息用一两句话告诉主人即可；技能列表可以说成"开着的：A、B、C；关着的：D"，不要逐条念 JSON。'
      });
    }
  });

  // ── 2) 开关技能 / 插件 ──
  api.registerTool({
    id: 'owner_skill',
    name: '主人控制台·开关功能',
    description: '打开或关闭某个技能/插件（按 id 或名字，支持部分匹配）。例：主人说"把去AI味关了""打开B站动态推送""停下早上好"。'
      + '只在**主人的私聊**里有效。'
      + '注意：这是程序层面的开关（会写进配置并立即生效），不是只对这一次对话生效；关掉某个技能后模型就看不到它的工具了。',
    category: 'system',
    icon: '🔧',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '技能/插件的 id 或名字，例如 bili-dynamic-push、morning-greet、去AI味' },
        enabled: { type: 'boolean', description: 'true=打开，false=关闭' }
      },
      required: ['target', 'enabled']
    },
    async execute(ctx, args) {
      const gate = ownerGate(ctx);
      if (!gate.ok) return err(gate.error);
      const found = findSkill(args?.target);
      if (!found) return err(`没找到叫「${args?.target}」的技能/插件。可以先用 owner_status 看完整清单。`);
      const want = args?.enabled !== false;
      if (found.enabled === want) {
        return ok({ id: found.id, name: found.name, enabled: found.enabled, note: `它本来就已经是${want ? '开' : '关'}着的，没有改动。` });
      }
      try {
        setSkillEnabled(found.id, want);
        // 与 routes.js 的开关路径一致：先写配置再跑生命周期（顺序不能反，
        // 否则 activate 里读到的配置还是旧值）
        if (want) skillManager.activate(found.id, { reason: 'owner-console' });
        else skillManager.deactivate(found.id, { reason: 'owner-console' });
        const after = (skillManager.list() || []).find((s) => s.id === found.id) || {};
        log(`主人控制台：${found.id} → ${want ? '开启' : '关闭'}`);
        const selfNote = found.id === 'owner-console'
          ? '（注意：你把「主人控制台」自己关了，之后只能用控制台界面重新打开它。）'
          : '';
        return ok({
          id: found.id,
          name: found.name,
          enabled: after.enabled,
          active: after.active,
          loadError: after.loadError || '',
          note: `已${want ? '打开' : '关闭'}「${found.name}」，立即生效。${selfNote} 然后用 send_message 回主人一句，别复述 JSON。`
        });
      } catch (error) {
        return err(`切换「${found.name}」失败：${error?.message ?? error}`);
      }
    }
  });

  // ── 3) 改扩展的设置项 ──
  api.registerTool({
    id: 'owner_set',
    name: '主人控制台·改设置',
    description: '修改某个扩展（技能/插件）的**设置项**。只能改它清单里声明过的键（与控制台设置表单同一口径），'
      + '改不了核心项（API Key、白名单、发送限频等）。例：主人说"早上好改到 7 点半"→ owner_set(扩展=morning-greet, 键=time, 值="07:30")；'
      + '"B站推送的检查间隔改成 15 分钟"→ owner_set(bili-dynamic-push, intervalMin, 15)。'
      + '只在**主人的私聊**里有效。不确定键名时先用 owner_status 看当前设置。',
    category: 'system',
    icon: '⚙️',
    parameters: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: '扩展的 id 或名字，例如 morning-greet / bili-dynamic-push' },
        key: { type: 'string', description: '设置项的键名，例如 time / targets / intervalMin' },
        value: { type: 'string', description: '新的值（按设置项类型自动转换：数字、开关、枚举都行）' }
      },
      required: ['skill', 'key', 'value']
    },
    async execute(ctx, args) {
      const gate = ownerGate(ctx);
      if (!gate.ok) return err(gate.error);
      const found = findSkill(args?.skill);
      if (!found) return err(`没找到叫「${args?.skill}」的技能/插件。`);
      const key = String(args?.key ?? '').trim();
      const schema = found.configSchema || {};
      const allowed = new Set([...Object.keys(found.settings || {}), ...Object.keys(schema)]);
      if (!allowed.has(key)) {
        return err(`「${found.name}」没有名为 ${key} 的设置项。它有的是：${[...allowed].join('、') || '（无）'}`);
      }
      const conv = coerceValue(schema[key], args?.value);
      if (!conv.ok) return err(`值不对：${conv.error}`);
      try {
        const next = setSkillConfig(found.id, { [key]: conv.value });
        log(`主人控制台：${found.id}.${key} = ${JSON.stringify(conv.value)}`);
        return ok({
          skill: found.id,
          key,
          value: next?.[key],
          current: Object.fromEntries(Object.entries(next || {}).filter(([k]) => k !== 'enabled')),
          note: '已保存并立即生效（扩展每次用配置都是现读的，不用重启）。然后用 send_message 回主人一句，别复述 JSON。'
        });
      } catch (error) {
        return err(`保存失败：${error?.message ?? error}`);
      }
    }
  });

  // ── 4) 在别的群拍人（跨会话）──
  api.registerTool({
    id: 'owner_poke',
    name: '主人控制台·拍某人',
    description: '在**指定的群**里拍一拍某个人（跨会话戳人，不限当前会话；不传 group 就是拍一个好友）。'
      + 'who 可以给 QQ 号，也可以给昵称/群名片 —— 工具会自己去群成员、好友列表里认；'
      + 'group 可以给群号或群名（只认允许说话的会话名单里的群）。'
      + '例：主人说「拍一下某群里的某人」→ group="群名或群号", who="昵称或QQ号"。只在**主人的私聊**里有效。',
    category: 'system',
    icon: '👋',
    parameters: {
      type: 'object',
      properties: {
        who: { type: 'string', description: '要拍的人的 QQ 号或昵称/群名片' },
        group: { type: 'string', description: '在哪个群拍（群号或群名）；不传 = 拍好友' }
      },
      required: ['who']
    },
    async execute(ctx, args) {
      const gate = ownerGate(ctx);
      if (!gate.ok) return err(gate.error);
      try {
        let groupId = '';
        let groupName = '';
        if (String(args?.group ?? '').trim()) {
          const g = await resolveGroup(ctx, args.group);
          if (!g.ok) return err(g.error);
          groupId = g.id;
          groupName = g.name;
        }
        const u = await resolveUser(ctx, args?.who, groupId);
        if (!u.ok) return err(u.error);
        // OneBot：群聊 send_poke 带 group_id + user_id；私聊只带 user_id（核心 onebot.js 同款参数）
        const params = groupId
          ? { group_id: Number(groupId), user_id: Number(u.id) }
          : { user_id: Number(u.id) };
        await ctx.onebot.call('send_poke', params);
        log(`主人控制台：拍了 ${u.name || u.id}(${u.id})${groupId ? ` 于群 ${groupName || groupId}` : '（好友）'}`);
        return ok({
          poked: u.id,
          name: u.name || u.id,
          group: groupId || null,
          note: '拍好了。然后用 send_message 回主人一句，别复述 JSON。'
        });
      } catch (error) {
        warn(`owner_poke 异常：${error?.stack ?? error}`);
        return err(`拍一拍失败：${error?.message ?? error}`);
      }
    }
  });

  // ── 5) 给谁点赞（名片赞）──
  api.registerTool({
    id: 'owner_like',
    name: '主人控制台·点赞',
    description: '给某个人的 QQ 名片点赞（协议端 send_like，和「名片点赞」技能同一个接口）。'
      + 'who 可以给 QQ 号或昵称（会自己去好友/允许的群成员里认）；times 默认 10、最多 20'
      + '（QQ 名片赞每人每天上限一般是 20，别刷）。例：主人说「给0216点个赞」「给群里的小明赞 5 个」。'
      + '只在**主人的私聊**里有效。',
    category: 'system',
    icon: '👍',
    parameters: {
      type: 'object',
      properties: {
        who: { type: 'string', description: '要点赞的人的 QQ 号或昵称' },
        times: { type: 'number', description: '点几个（1~20，默认 10）' }
      },
      required: ['who']
    },
    async execute(ctx, args) {
      const gate = ownerGate(ctx);
      if (!gate.ok) return err(gate.error);
      try {
        const u = await resolveUser(ctx, args?.who, '');
        if (!u.ok) return err(u.error);
        const times = Math.min(20, Math.max(1, Math.round(Number(args?.times) || 10)));
        await ctx.onebot.call('send_like', { user_id: Number(u.id), times });
        log(`主人控制台：给 ${u.name || u.id}(${u.id}) 点了 ${times} 个赞`);
        return ok({
          liked: u.id,
          name: u.name || u.id,
          times,
          note: `点了 ${times} 个赞。然后用 send_message 回主人一句（比如「点了」），别邀功。`
        });
      } catch (error) {
        warn(`owner_like 异常：${error?.stack ?? error}`);
        return err(`点赞失败：${error?.message ?? error}`);
      }
    }
  });

  // ── 6) 代它在别的群说话（可真 @ 人）──
  api.registerTool({
    id: 'owner_say',
    name: '主人控制台·代发消息',
    description: '让机器人**去指定的群**说一句话（跨会话代发），可以**真正 @ 到群成员**（不是打一段"@名字"的纯文本）。'
      + 'group 给群号或群名（只认允许说话的会话名单里的群）；at 给要 @ 的人的昵称/群名片/QQ 号，多人用逗号分隔。'
      + '例：主人说「在某个群里发一句 xxx 并艾特某人」→ group="群名或群号", text="xxx", at="昵称或QQ号"。'
      + '注意：核心自带的跨会话发送工具（send_to）不支持 @，只有本工具能 @ 到人 —— 主人明确要求"艾特/@"时必须用它。'
      + '只在**主人的私聊**里有效。',
    category: 'system',
    icon: '📣',
    parameters: {
      type: 'object',
      properties: {
        group: { type: 'string', description: '发到哪个群（群号或群名）' },
        text: { type: 'string', description: '要说的内容' },
        at: { type: 'string', description: '要 @ 的人（昵称/群名片/QQ 号，多人用逗号分隔）；不传就是普通发言' }
      },
      required: ['group', 'text']
    },
    async execute(ctx, args) {
      const gate = ownerGate(ctx);
      if (!gate.ok) return err(gate.error);
      try {
        // 与核心 send_to 同一个开关：管理员没开「允许跨会话发送」就不代发
        if (getConfig()?.tools?.crossChatSend !== true) {
          return err('跨会话发送是关着的（管理员可在「设置 → 工具与技能」里打开「允许跨会话发送」）。');
        }
        const g = await resolveGroup(ctx, args?.group);
        if (!g.ok) return err(g.error);
        const text = String(args?.text ?? '').trim();
        if (!text) return err('要说什么？（text 是空的）');

        // 解析要 @ 的人 → 拼成 OneBot 消息段数组（at 段是真的 @，QQ 会给对方提醒）
        const segments = [];
        const atErrors = [];
        const atNames = [];
        for (const one of String(args?.at ?? '').split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 5)) {
          // eslint-disable-next-line no-await-in-loop
          const u = await resolveUser(ctx, one, g.id);
          if (!u.ok) { atErrors.push(`${one}：${u.error}`); continue; }
          segments.push({ type: 'at', data: { qq: String(u.id) } });
          segments.push({ type: 'text', data: { text: ' ' } });
          atNames.push(u.name || u.id);
        }
        segments.push({ type: 'text', data: { text } });
        await ctx.onebot.call('send_group_msg', { group_id: Number(g.id), message: segments });
        // 记进存档（和核心发送路径一致），这样模型之后知道自己在群里说过这句
        try { ctx.store?.appendSelf?.(`group:${g.id}`, { text: `${atNames.length ? `@${atNames.join(' @')} ` : ''}${text}`, ts: Date.now() }); } catch { /* 忽略 */ }
        try { ctx.emit?.('chat-update', `group:${g.id}`); } catch { /* 忽略 */ }
        log(`主人控制台：代发到群 ${g.name || g.id}${atNames.length ? `（@${atNames.join('、')}）` : ''}：${text.slice(0, 40)}`);
        return ok({
          sent: true,
          group: g.id,
          at: atNames.length ? atNames : undefined,
          atFailed: atErrors.length ? atErrors : undefined,
          note: '已经发出去了（@ 是真的 @，对方会收到提醒）。然后用 send_message 回主人一句，别复述 JSON。'
        });
      } catch (error) {
        warn(`owner_say 异常：${error?.stack ?? error}`);
        return err(`代发失败：${error?.message ?? error}`);
      }
    }
  });
}

export function setup(api) {
  cfg = api.config;
  log = api.log;
  warn = api.warn;
  registerTools(api);
  log('主人控制台已加载（只对设置里那个 QQ 号的私聊生效）');
}

export function available() { return true; }

// 供测试/排障（加载器不消费）
export const internals = { ownerGate, findSkill, coerceValue, compactStatus, normalizeName, resolveGroup, resolveUser };
