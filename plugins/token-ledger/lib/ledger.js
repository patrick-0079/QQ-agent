// plugins/token-ledger/lib/ledger.js
//
// Token 账本的计算内核（**纯函数，不碰文件系统**，方便离线断言）。
//
// ── 这些数字从哪来、有多真 ────────────────────────────────────────────────
// 核心把每个会话落盘在 data/sessions/<id>.json，里面有：
//   · usage: { promptTokens, completionTokens, totalTokens, cachedTokens, calls }  ← **真实记账**
//   · messages: [ { role:'assistant', ... }, { toolCall:{ name, args, result, isError } } ]
// 所以"每个会话花了多少 token"是权威值；但"**哪个技能**花的"没人记（模型是按请求计费，
// 不按工具计费）。所以这里用一条能自圆其说的分摊口径：
//
//   **工具返回的内容会留在上下文里，之后每一轮请求都要把它重新发一遍。**
//   一条 4000 token 的工具输出，如果这次会话后面还有 5 轮，那就是 2 万 token 的账。
//   这就是"重发账"（resendTokens），也是真正能把上下文撑大的东西。
//
// token 数是**估算**：中文按 0.7/字、其它字符按 0.3/字（实测这类混合文本误差约 ±30%）。
// 报告里一律标"估算"，只有"真实记账"那几行是准的。
//
// 另一个必须说清的口径：核心开了 prompt 缓存（cachedTokens），被缓存的那部分重发是
// 打折的。所以"重发账"是**上限**，不是实际扣费。

const CJK = /[\u3000-\u9fff\uff00-\uffef]/;

/** 估算一段文本的 token 数（中文 0.7/字，其它 0.3/字）。 */
function estimateTokens(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  let cjk = 0;
  for (const ch of s) if (CJK.test(ch)) cjk += 1;
  const other = s.length - cjk;
  return Math.round(cjk * 0.7 + other * 0.3);
}

/** 工具名 → 归属。`chat-archive__wordcloud` → 技能 chat-archive；没前缀的是核心内置工具。 */
function ownerOf(toolName) {
  const name = String(toolName ?? '');
  const i = name.indexOf('__');
  return i > 0 ? name.slice(0, i) : '';
}

/** 人类可读的数字：12345 → 1.2万。 */
function human(n) {
  const v = Number(n) || 0;
  if (v >= 100000000) return `${(v / 100000000).toFixed(2)}亿`;
  if (v >= 10000) return `${(v / 10000).toFixed(1)}万`;
  return String(v);
}

/**
 * 汇总一批会话。
 * @param {object[]} sessions 已解析的会话对象
 * @param {object} opts { topN }
 */
function summarize(sessions, { topN = 8 } = {}) {
  const list = Array.isArray(sessions) ? sessions : [];
  const tools = new Map();      // name → 统计
  const skills = new Map();     // skillName（'' = 内置）→ 统计
  const totals = {
    sessions: list.length, calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0,
    toolCalls: 0, outTokens: 0, resendTokens: 0, oldest: 0, newest: 0
  };
  const make = (name) => ({
    name, calls: 0, outTokens: 0, resendTokens: 0, maxTokens: 0, maxAt: '', errors: 0, sessions: 0
  });
  const bump = (map, key, outTokens, resendTokens, isError, maxText) => {
    const cur = map.get(key) || make(key);
    cur.calls += 1;
    cur.outTokens += outTokens;
    cur.resendTokens += resendTokens;
    if (isError) cur.errors += 1;
    if (outTokens > cur.maxTokens) { cur.maxTokens = outTokens; cur.maxAt = maxText; }
    map.set(key, cur);
  };

  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    const u = s.usage || {};
    const calls = Math.max(0, Number(u.calls) || 0);
    totals.calls += calls;
    totals.promptTokens += Number(u.promptTokens) || 0;
    totals.completionTokens += Number(u.completionTokens) || 0;
    totals.totalTokens += Number(u.totalTokens) || 0;
    totals.cachedTokens += Number(u.cachedTokens) || 0;
    const started = Number(s.startedAt) || 0;
    if (started) {
      if (!totals.oldest || started < totals.oldest) totals.oldest = started;
      if (started > totals.newest) totals.newest = started;
    }

    const seenSkills = new Set();
    const seenTools = new Set();
    let round = 0;
    for (const m of (Array.isArray(s.messages) ? s.messages : [])) {
      if (m?.role === 'assistant') { round += 1; continue; }
      const tc = m?.toolCall;
      const name = tc?.name ? String(tc.name) : '';
      if (!name) continue;
      const outTokens = estimateTokens(tc.result);
      const at = Math.max(1, round || 1);
      const resend = Math.max(1, (calls || 1) - at + 1);      // 这份输出在后面每一轮都要重发
      const shortArg = (() => {
        try { return JSON.stringify(tc.args ?? '').slice(0, 60); } catch { return ''; }
      })();
      const where = `${s.chatName || s.chatKey || ''} ${shortArg}`.trim();
      const skill = ownerOf(name);
      bump(tools, name, outTokens, outTokens * resend, tc.isError, where);
      bump(skills, skill, outTokens, outTokens * resend, tc.isError, where);
      seenTools.add(name);
      seenSkills.add(skill);
      totals.toolCalls += 1;
      totals.outTokens += outTokens;
      totals.resendTokens += outTokens * resend;
    }
    // 会话数按"去重计"（同一会话里调了 5 次也只算 1 个会话）
    for (const key of seenTools) { const x = tools.get(key); if (x) x.sessions += 1; }
    for (const key of seenSkills) { const x = skills.get(key); if (x) x.sessions += 1; }
  }

  const shape = (m) => [...m.values()]
    .map((x) => ({
      ...x,
      // 技能维度：空 key 就是核心内置工具（send_message / finish 这些）
      name: m === skills ? (x.name || '(核心内置)') : x.name,
      skill: m === skills ? (x.name || '(核心内置)') : (ownerOf(x.name) || '(核心内置)'),
      avgTokens: x.calls ? Math.round(x.outTokens / x.calls) : 0
    }))
    .sort((a, b) => b.resendTokens - a.resendTokens || b.outTokens - a.outTokens || a.name.localeCompare(b.name));

  const toolRows = shape(tools);
  const skillRows = shape(skills);
  const fattest = [...toolRows].sort((a, b) => b.avgTokens - a.avgTokens || b.maxTokens - a.maxTokens)[0] || null;
  const biggest = [...toolRows].sort((a, b) => b.maxTokens - a.maxTokens)[0] || null;
  // 重发账占（真实 prompt token）的比例：估算口径，见文件头说明
  const share = totals.promptTokens ? Math.round((1000 * totals.resendTokens) / totals.promptTokens) / 10 : null;
  return {
    tools: toolRows.slice(0, Math.max(1, topN)),
    skills: skillRows.slice(0, Math.max(1, topN)),
    totals, fattest, biggest, share
  };
}

/**
 * 汇总"每轮固定开销"：技能往系统提示词里塞的片段（prompt.sections）。
 *
 * 为什么这条比工具输出重要得多：**每一次请求都要把系统提示词重发一遍**。
 * 一个技能塞了 1000 字的提示词，按今天 335 次请求算就是 33.5 万字的账 —— 而工具输出
 * 通常只有零点几个百分点（实测这机器上 0.5%）。所以"关掉用不上的技能"是最直接的省钱手段。
 *
 * 口径：只统计 manifest 里声明的 prompt.sections（这是核心真正注入的部分）；
 * 工具定义（tools 参数）由核心按启用状态动态组装，插件侧看不到，故不计入并注明。
 */
function summarizePrompts(rows, { calls = 0, topN = 6 } = {}) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.id);
  const on = list.filter((r) => r.enabled);
  const off = list.filter((r) => !r.enabled);
  const sum = (arr) => arr.reduce((a, r) => a + (Number(r.chars) || 0), 0);
  const enabledChars = sum(on);
  const enabledTokens = Math.round(enabledChars * 0.7);
  const perCall = enabledTokens;                                  // 每轮多花这么多
  const windowCost = perCall * Math.max(0, Number(calls) || 0);
  // 同名合并：同一个技能装了两份（xxx 与 xxx_1）在界面上看着一样，但提示词的账是交两遍的，
  // 这里合成一行并标 ×N —— 顺带把"重复安装"这个真问题暴露出来。
  const merged = new Map();
  for (const r of on) {
    const chars = Number(r.chars) || 0;
    const key = r.name || r.id;
    const cur = merged.get(key) || { id: r.id, name: key, chars: 0, dup: 0, ids: [], dirs: [] };
    cur.chars += chars;
    cur.dup += 1;
    cur.ids.push(r.id);
    cur.dirs.push(r.dir || r.id);       // 目录名才是"要删哪一份"的答案（manifest 里的 id 两份是一样的）
    merged.set(key, cur);
  }
  const ranked = [...merged.values()].filter((r) => r.chars > 0).sort((a, b) => b.chars - a.chars);
  return {
    rows: ranked.slice(0, Math.max(1, topN)),
    dups: ranked.filter((r) => r.dup > 1),
    enabledCount: on.length, disabledCount: off.length,
    enabledChars, enabledTokens, perCall, windowCost,
    disabledTokens: Math.round(sum(off) * 0.7),
    largest: ranked[0] || null
  };
}

/** 紧凑文本报告（工具返回和私聊推送共用；brief=给工具用的精简版，免得账本自己撑上下文）。 */
function renderText(sum, { topN = 6, scope = 'skill', days = 7, windowLabel = '', brief = false } = {}) {
  const rows = scope === 'tool' ? sum.tools : sum.skills;
  const rowCap = brief ? Math.min(topN, 3) : topN;
  const promptCap = brief ? 2 : topN;
  const t = sum.totals;
  const lines = [];
  lines.push(`📒 Token 账本 · ${windowLabel || `近 ${days} 天`}`);
  lines.push(`真实记账：${t.sessions} 个会话 / ${t.calls} 次请求 / ${human(t.totalTokens)} token`
    + `${t.cachedTokens ? `（缓存命中 ${human(t.cachedTokens)}）` : ''}`);
  if (t.calls) {
    lines.push(`平均每次请求要重发 ${human(Math.round(t.promptTokens / t.calls))} token 的上下文 —— 这才是大头`);
  }
  // 每轮固定开销：技能提示词
  const p = sum.prompts;
  if (p && p.enabledChars) {
    lines.push('');
    lines.push(`每轮固定开销（技能提示词，跟着每次请求一起发；已启用 ${p.enabledCount} 个）：`);
    p.rows.slice(0, promptCap).forEach((r, i) => {
      lines.push(`${i + 1}. ${r.name}${r.dup > 1 ? ` ×${r.dup}` : ''}　${r.chars} 字 ≈ ${Math.round(r.chars * 0.7)} token/轮`);
    });
    lines.push(`合计 ${p.enabledChars} 字 ≈ ${human(p.perCall)} token/轮`
      + `${t.calls ? ` × ${t.calls} 次请求 ≈ ${human(p.windowCost)} token` : ''}（关掉用不上的技能，省的就是这块）`);
    if (p.dups.length) {
      lines.push(`⚠️ 有 ${p.dups.length} 个技能装了两份：${p.dups.map((d) => d.name).join('、')}`
        + `（目录：${p.dups.map((d) => d.dirs.join(' + ')).join('；')}）—— 提示词的账交了两遍，删掉重复的那份就省下来了`);
    }
  }
  // 工具输出
  lines.push('');
  if (!rows.length) {
    lines.push('这段时间没有任何工具调用记录。');
    return lines.join('\n');
  }
  lines.push(`工具输出重发账（估算）：${human(t.resendTokens)} token`
    + `${sum.share != null ? `，约占上下文 ${sum.share}%` : ''}`
    + `${sum.share != null && sum.share < 5 ? '（很小 —— 别急着砍工具输出）' : ''}`);
  lines.push(`按${scope === 'tool' ? '工具' : '技能'}排（重发账 = 输出 × 后面还要重发几轮）：`);
  rows.slice(0, rowCap).forEach((r, i) => {
    lines.push(`${i + 1}. ${r.name}　${r.calls} 次　均 ${r.avgTokens} token/次　重发账 ${human(r.resendTokens)}`
      + `${r.errors ? `　失败 ${r.errors}` : ''}`);
  });
  if (!brief && sum.fattest) {
    lines.push(`最肥的单次输出：${sum.fattest.name}（均 ${sum.fattest.avgTokens} token/次`
      + `${sum.fattest.maxTokens > sum.fattest.avgTokens ? `，最大 ${sum.fattest.maxTokens}` : ''}）`);
  }
  return lines.join('\n');
}

export { estimateTokens, ownerOf, human, summarize, summarizePrompts, renderText };
