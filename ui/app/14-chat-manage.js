// 〔会话管理页〕——2026-10-21 改版第 2 段
//
// 一级菜单「会话管理」= 会话维度的所有功能：
//   左栏：默认会话 ★ + 已单独添加的会话（可搜索/置顶/移除/添加）
//   右栏：运行记录 / 存档 / 记忆 / 用量 / 设置（子页签）
//
// 口径约定（与后端一致）：
//   · 默认会话 = 没有单独配置（chatProfiles 里没有）的所有会话的汇总
//   · 某个会话 = 只看这个会话自己的数据/配置
//   · 黑名单最高优先级：聊天、拍一拍、主动发言、send_to 在准入判定里先看 deny，
//     加了会话也照拒 —— 这里只在左栏标 🚫，不改准入逻辑
'use strict';

Object.assign(state, {
  cmScope: 'default',     // 'default' | 'group:<id>' | 'private:<id>'
  cmSub: 'sessions',      // sessions | chats | memory | usage | settings
  cmUsage: null,
  cmUsageLoading: false
});

const CM_SUBTABS = [
  ['sessions', '运行记录'],
  ['chats', '存档'],
  ['memory', '记忆'],
  ['usage', '用量'],
  ['settings', '设置']
];

/** 当前是否停在会话管理的某个子页（原先按一级页签判断的地方改用它）。 */
function inCmSub(sub) {
  return state.tab === 'chatmanage' && state.cmSub === sub;
}

/** 设置表单是否正在显示（设置页 或 会话管理的「设置」子页）。 */
function settingsTabActive() {
  return state.tab === 'settings' || inCmSub('settings');
}

/** 会话管理页的数据口径查询串（其它页签/全局用量不筛）。 */
function cmScopeQuery() {
  if (state.tab !== 'chatmanage' || !state.cmScope) return '';
  return `chat=${encodeURIComponent(state.cmScope)}`;
}

/** 把 cmScopeQuery() 拼到已有 query 上。 */
function withCmScope(path) {
  const q = cmScopeQuery();
  if (!q) return path;
  return path + (path.includes('?') ? '&' : '?') + q;
}

// ── 左栏宽度（会话管理专用）──────────────────────────────────────────
const CM_RAIL_W_KEY = 'qqa-cm-rail-width';
const CM_RAIL_W_MIN = 200;
const CM_RAIL_W_MAX = 520;
const CM_RAIL_W_DEF = 280;

function readCmRailWidth() {
  try {
    const v = Number(localStorage.getItem(CM_RAIL_W_KEY));
    if (Number.isFinite(v) && v > 0) return v;
  } catch { /* 隐私模式忽略 */ }
  return CM_RAIL_W_DEF;
}

function applyCmRailWidth(px) {
  const w = Math.round(Math.min(CM_RAIL_W_MAX, Math.max(CM_RAIL_W_MIN, Number(px) || CM_RAIL_W_DEF)));
  const rail = $('#cm-rail');
  if (rail) rail.style.setProperty('--cm-rail-w', `${w}px`);
  try { localStorage.setItem(CM_RAIL_W_KEY, String(w)); } catch { /* ignore */ }
  return w;
}

/** 左栏右缘拖拽调宽（双击复位）。左栏 innerHTML 每次重绘都会重建 handle，故按元素绑定。 */
function initCmRailResizer() {
  const rail = $('#cm-rail');
  const handle = $('#cm-rail-resizer');
  if (!rail || !handle) return;
  applyCmRailWidth(readCmRailWidth());
  if (handle.__resizeBound) return;
  handle.__resizeBound = true;
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = rail.getBoundingClientRect().width || readCmRailWidth();
    try { handle.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    handle.classList.add('dragging');
    document.body.classList.add('resizing-list');
    const onMove = (ev) => applyCmRailWidth(startW + (ev.clientX - startX));
    const onUp = (ev) => {
      handle.classList.remove('dragging');
      document.body.classList.remove('resizing-list');
      try { handle.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  });
  handle.addEventListener('dblclick', () => applyCmRailWidth(CM_RAIL_W_DEF));
}

// ── 子页签 ───────────────────────────────────────────────────────────
function renderCmSubtabs() {
  const box = $('#cm-subtabs');
  if (!box) return;
  box.innerHTML = CM_SUBTABS.map(([id, label]) => `
    <button class="session-tab ${state.cmSub === id ? 'active' : ''}" data-cm-sub="${id}">${label}</button>`).join('');
  box.querySelectorAll('[data-cm-sub]').forEach((btn) => {
    btn.addEventListener('click', () => switchCmSub(btn.dataset.cmSub));
  });
}

/** 当前是不是"只可能有一个目标"的会话（默认会话之外）。 */
function cmIsSingleScope() {
  return state.tab === 'chatmanage' && Boolean(state.cmScope) && state.cmScope !== 'default';
}

/** 存档/记忆在单会话下不需要左侧栏（只有一个目标，直接看内容）。 */
function applyCmSingleScopeLayout() {
  const single = cmIsSingleScope();
  $$('.cm-panel[data-cm-panel="chats"], .cm-panel[data-cm-panel="memory"]')
    .forEach((p) => p.classList.toggle('cm-single-scope', single));
}

/** 切换子页：面板显隐 + 按当前会话口径拉数据。 */
async function switchCmSub(sub) {
  const next = CM_SUBTABS.some(([id]) => id === sub) ? sub : 'sessions';
  if (state.cmSub === 'settings' && next !== 'settings') flushSettingsSaves();
  state.cmSub = next;
  $$('.cm-panel').forEach((p) => p.classList.toggle('active', p.dataset.cmPanel === next));
  $$('#cm-subtabs [data-cm-sub]').forEach((b) => b.classList.toggle('active', b.dataset.cmSub === next));
  applyCmSingleScopeLayout();
  renderSettingsSidebar();
  if (next === 'sessions') loadSessions();
  else if (next === 'chats') {
    await loadChats({ quiet: true });
    // 单会话：列表里只有它自己，直接选中并展示消息
    if (cmIsSingleScope() && state.currentChatKey !== state.cmScope) await selectChat(state.cmScope);
  } else if (next === 'memory') {
    await loadMemoryView();
    if (cmIsSingleScope() && state.currentMemoryChatKey !== state.cmScope) {
      state.currentMemoryChatKey = state.cmScope;
      renderMemoryList();
      loadMemoryDetail(state.cmScope);
    }
  } else if (next === 'usage') loadCmUsage();
  else if (next === 'settings') loadCmSettings();
}

/** 左栏选中某个会话（或默认会话）：所有子页都换成这个口径。 */
function selectCmScope(key) {
  const next = key || 'default';
  if (state.cmScope === next) {
    // 同一条再点一次：只刷新当前子页
    renderSettingsSidebar();
    switchCmSub(state.cmSub);
    return;
  }
  if (state.cmSub === 'settings') flushSettingsSaves();
  state.cmScope = next;
  applyCmSingleScopeLayout();
  // 右栏详情属于上一个会话：切走就清空，避免看串
  state.currentSessionId = null;
  state.currentChatKey = null;
  state.currentMemoryChatKey = null;
  state.cmUsage = null;   // 用量缓存按作用域失效，避免看到上一个会话的数字
  const sl = $('#session-items');
  if (sl) sl.innerHTML = '';
  const sd = $('#session-detail');
  if (sd) sd.innerHTML = '<div class="empty-hint">← 选择左侧会话查看完整过程</div>';
  const ci = $('#chat-items');
  if (ci) ci.innerHTML = '';
  const cd = $('#chat-detail');
  if (cd) cd.innerHTML = '<div class="empty-hint">← 选择会话查看消息存档</div>';
  const mi = $('#memory-items');
  if (mi) mi.innerHTML = '';
  const md = $('#memory-detail');
  if (md) md.innerHTML = '<div class="empty-hint">← 选择会话查看记忆</div>';
  state.chatMessages = [];
  state.shownMessageCount = 0;
  renderSettingsSidebar();
  renderCmSubtabs();
  switchCmSub(state.cmSub);
}

/** 进入会话管理页（switchTab 调用）。 */
function enterChatManage() {
  // 左栏会话列表可能还没拉过（首屏直接落在本页）：异步补齐，回来自己重绘
  void loadChatProfiles({ quiet: true });
  applyCmSingleScopeLayout();
  renderSettingsSidebar();
  renderCmSubtabs();
  switchCmSub(state.cmSub);
}

// ── 会话用量 ─────────────────────────────────────────────────────────
async function loadCmUsage({ force = false } = {}) {
  if (state.cmUsageLoading && !force) return;
  state.cmUsageLoading = true;
  const box = $('#cm-usage');
  if (box && !state.cmUsage) box.innerHTML = '<div class="usage-skeleton"><div class="sk-line"></div><div class="sk-line short"></div><div class="sk-line"></div></div>';
  try {
    const data = await api(withCmScope('/api/usage/stats?range=7'));
    state.cmUsage = data;
    renderCmUsage();
  } catch (e) {
    if (box) box.innerHTML = `<div class="empty-hint">会话用量加载失败：${esc(e.message || e)}</div>`;
  } finally {
    state.cmUsageLoading = false;
  }
}

function cmFmtMoney(n) {
  const v = Number(n) || 0;
  if (!v) return '0';
  return v < 0.01 ? v.toFixed(4) : v.toFixed(2);
}

function cmFmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}K`;
  return String(Math.round(v));
}

function renderCmUsage() {
  const box = $('#cm-usage');
  if (!box) return;
  const st = state.cmUsage || null;
  if (!st) { box.innerHTML = '<div class="empty-hint">还没有用量数据</div>'; return; }
  const t = st.totals || {};
  const scopeLabel = state.cmScope === 'default'
    ? '默认会话（其余所有会话合计）'
    : (chatTitleOf(state.cmScope) || state.cmScope);
  const models = (st.models || []).slice(0, 8);
  const days = (st.days || []).slice(-7);
  const maxDay = Math.max(1, ...days.map((d) => Number(d.cost) || 0));
  box.innerHTML = `
    <div class="usage-head">
      <div>
        <div class="usage-title">用量 · ${esc(scopeLabel)}</div>
        <div class="muted">近 7 天（会话口径）</div>
      </div>
      <button class="btn btn-small" id="cm-usage-refresh">刷新</button>
    </div>
    <div class="cm-usage-cards">
      <div class="cm-usage-card"><div class="cm-usage-num">¥${cmFmtMoney(t.cost)}</div><div class="muted">总成本</div></div>
      <div class="cm-usage-card"><div class="cm-usage-num">${cmFmtTokens(t.totalTokens)}</div><div class="muted">总 Token</div></div>
      <div class="cm-usage-card"><div class="cm-usage-num">${Number(t.runs) || 0}</div><div class="muted">调用次数</div></div>
      <div class="cm-usage-card"><div class="cm-usage-num">${t.promptTokens ? Math.round((Number(t.cachedTokens) / Number(t.promptTokens)) * 100) : 0}%</div><div class="muted">缓存命中</div></div>
    </div>
    <div class="cm-usage-section">
      <div class="cm-usage-h">按模型</div>
      ${models.length ? models.map((m) => `
        <div class="cm-usage-row">
          <span class="cm-usage-key">${esc(m.model || m.key)}${m.vendor ? `<span class="muted"> · ${esc(m.vendor)}</span>` : ''}</span>
          <span class="cm-usage-val">¥${cmFmtMoney(m.cost)} · ${cmFmtTokens(m.totalTokens)} token</span>
        </div>`).join('') : '<div class="muted">暂无调用</div>'}
    </div>
    <div class="cm-usage-section">
      <div class="cm-usage-h">按天</div>
      ${days.length ? days.map((d) => `
        <div class="cm-usage-row">
          <span class="cm-usage-key">${esc(d.day)}</span>
          <span class="cm-usage-bar"><i style="width:${Math.max(2, Math.round(((Number(d.cost) || 0) / maxDay) * 100))}%"></i></span>
          <span class="cm-usage-val">¥${cmFmtMoney(d.cost)}</span>
        </div>`).join('') : '<div class="muted">暂无数据</div>'}
    </div>
    <div class="hint" style="margin-top:10px">
      会话用量只统计这个会话自己的调用；默认会话是「所有没单独添加的会话」的合计，
      已单独添加的会话不会重复计入。
    </div>`;
  $('#cm-usage-refresh')?.addEventListener('click', () => loadCmUsage({ force: true }));
}

// ── 会话设置（复用设置页的会话面板渲染器）─────────────────────────────
/** 把「设置 → 某个会话」整套面板渲染到会话管理右栏。 */
async function loadCmSettings() {
  state.settingsView = 'session';
  state.settingsScope = state.cmScope === 'default' ? 'default' : state.cmScope;
  await loadSettings();
}

