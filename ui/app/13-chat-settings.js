// 〔会话个性化：左栏会话列表 / 作用域工具〕——2026-10-21 改版第 1 段
//
// 需求落点：
//   · 设置页左栏 = 会话列表（可搜索/置顶，★默认设置永久置顶）+ 全局设置入口
//   · 右栏 = 会话设置面板，顶部菜单切换 人设/记忆/聊天设置/工具与技能
//   · 白名单 UI 移除：把会话"添加到自定义"= 准入；acceptAllSessions 时未添加的
//     会话也准入并走默认配置（开关在「安全与准入」分区）
//   · 会话隔离 = 配置覆盖（chatProfiles[key].overrides），文件/ID 单份
//
// 术语：
//   · scope 'default'      = 编辑默认（全局）配置；会话面板各分区即"所有未自定义会话的默认值"
//   · scope '<chatKey>'    = 编辑该会话的覆盖（只在覆盖分区生效；全局专属分区不可见）
'use strict';

// ── state 扩展（一次性） ──────────────────────────────────────────────
Object.assign(state, {
  chatSessions: [],        // GET /api/chat-profiles.sessions
  chatSessionsLoading: false,
  acceptAllSessions: false,
  // which settings view is active in the left column
  settingsView: 'global',        // 'global' | 'session'
  // 全局视图当前分区（模型 API / 搜索 / 安全 / 系统）
  settingsSection: 'api',
  // 会话面板当前分区
  sessionSection: 'persona',     // persona | memory | chat | tools
  // 当前编辑作用域：'default' = 默认配置；否则 chatKey
  settingsScope: 'default',
  sessionSearch: ''
});

// ── 小工具 ───────────────────────────────────────────────────────────
/** URL 片段：chatKey 中的冒号是路由合法字符，不做 encodeURIComponent（%3A 会 404）。 */
function profileUrl(key) {
  return String(key || '');
}

/** 正在编辑的是不是某个具体会话（而不是默认配置）。 */
function isSessionScope() {
  return state.settingsView === 'session' && state.settingsScope !== 'default';
}

/**
 * 设置表单的宿主元素：
 *   · 设置页 → #settings-form（全局分区）
 *   · 会话管理 → #cm-settings（该会话的人设/记忆/聊天/工具）
 * 两处复用同一套渲染/自动保存，所以只能有一个宿主同时有内容。
 */
function settingsFormRoot() {
  if (state.tab === 'chatmanage') return $('#cm-settings') || $('#settings-form');
  return $('#settings-form');
}

/** 会话面板当前分区，默认回落。 */
function sessionSectionNow() {
  return ['persona', 'memory', 'chat', 'tools'].includes(state.sessionSection) ? state.sessionSection : 'persona';
}

function scopeSessionRow() {
  return (state.chatSessions || []).find((s) => s.key === state.settingsScope) || null;
}

/** 会话显示名（行数据优先；找不到时按 key 兜底）。 */
function chatTitleOf(key) {
  const row = (state.chatSessions || []).find((s) => s.key === key);
  if (row) return row.name;
  const m = /^(group|private):(.+)$/.exec(String(key || ''));
  if (!m) return String(key || '');
  return m[1] === 'group' ? `群 ${m[2]}` : `QQ ${m[2]}`;
}

const PROFILE_SECTIONS = [
  ['persona', '人设'],
  ['memory', '记忆'],
  ['chat', '聊天设置'],
  ['tools', '工具与技能']
];

// ── 数据加载 ─────────────────────────────────────────────────────────
// 并发调用合并：同一时刻只发一次请求，后来者等同一个 Promise（否则 await
// loadChatProfiles() 会在 in-flight 时立刻返回，拿到的是空列表 → 左栏空窗）。
let chatProfilesInflight = null;
async function loadChatProfiles({ quiet = false } = {}) {
  if (chatProfilesInflight) return chatProfilesInflight;
  chatProfilesInflight = (async () => {
    try {
      const data = await api('/api/chat-profiles');
      state.chatSessions = data.sessions || [];
      state.acceptAllSessions = data.acceptAllSessions === true;
      state.denyLists = data.deny || { groups: [], private: [] };
      if (state.tab === 'settings' || state.tab === 'chatmanage') renderSettingsSidebar();
      // 右栏行头显示的名字/别名可能变了：轻量重绘（有草稿防抖窗口时也不挡，
      // 因为我们只改 DOM 的行头文字，不重建表单）
      updateSessionHeader();
    } catch (e) {
      if (!quiet) console.error('加载会话列表失败:', e);
    } finally {
      chatProfilesInflight = null;
    }
  })();
  return chatProfilesInflight;
}

/** 拉取当前作用域的配置（session → 生效 + 覆盖；default → 全局配置）。 */
async function loadScopeConfig({ force = false } = {}) {
  if (!isSessionScope()) return;
  const key = state.settingsScope;
  const prof = await api(`/api/chat-profiles/${profileUrl(key)}`);
  state.config = prof.effective;
  state.defaultConfig = prof.default;
  state.scopeOverrides = prof.overrides || {};
  state.profileEntry = prof.profile || null;
  void force;
}

/** 会话面板行头的小更新（名字/统计可能异步变），不重建表单。 */
function updateSessionHeader() {
  if (!settingsTabActive() || !isSessionScope()) return;
  const el = $('#session-panel-head');
  if (el) el.outerHTML = renderSessionPanelHead();
}

// ── 左栏 ─────────────────────────────────────────────────────────────
// 两个页签共用一份渲染函数，但内容不同：
//   · 会话管理（#cm-rail）：默认会话 + 会话列表（搜索/置顶/移除/添加）
//   · 设置（#settings-sidebar）：只有全局设置入口，会话级配置已搬走
function renderSettingsSidebar() {
  const isCm = state.tab === 'chatmanage';
  const sidebar = isCm ? $('#cm-rail') : $('#settings-sidebar');
  if (!sidebar) return;
  const s = state.status;
  const q = String(state.sessionSearch || '').trim().toLowerCase();
  const activeScope = isCm ? state.cmScope : state.settingsScope;
  // 会话管理左栏 = 默认会话 + 已单独添加的会话（其余会话都归默认会话，不单列）
  const shown = (state.chatSessions || [])
    .filter((x) => x.hasProfile)
    .filter((x) => !q
      || String(x.name || '').toLowerCase().includes(q)
      || String(x.alias || '').toLowerCase().includes(q)
      || String(x.key).toLowerCase().includes(q)
      || String(x.id).includes(q));

  const deny = state.denyLists || { groups: [], private: [] };
  const isDenied = (x) => (x.kind === 'group' ? deny.groups : deny.private)
    .map(String).includes(String(x.id));

  const sessionRow = (x) => {
    const active = activeScope === x.key;
    const pinned = (x.pinnedAt || 0) > 0;
    const denied = isDenied(x);
    const sub = denied ? '🚫 黑名单（拒绝处理）'
      : x.hasProfile
        ? (x.overrideCount ? `已自定义 ${x.overrideCount} 项` : '已单独添加')
        : (state.acceptAllSessions ? '走默认设置' : '未添加（不响应）');
    return `
      <div class="settings-menu-item chat-row ${active ? 'active' : ''} ${x.hasProfile ? 'admitted' : 'discovered'} ${denied ? 'denied' : ''}"
           data-chat-key="${esc(x.key)}" title="${esc(x.key)}">
        <span class="chat-row-main">
          <span class="chat-row-icon">${x.kind === 'group' ? '👥' : '👤'}</span>
          <span class="chat-row-text">
            <span class="chat-row-name"><span class="chat-row-title">${esc(x.name)}</span>${denied ? '<span class="chat-deny-tag">🚫</span>' : ''}${!x.hasProfile && state.acceptAllSessions && !denied ? '<span class="chat-def-tag">默认</span>' : ''}</span>
            <span class="chat-row-sub">${x.kind === 'group' ? '群号' : 'QQ'} ${esc(String(x.id))} · ${sub}</span>
          </span>
        </span>
        <span class="chat-row-ops">
          <button class="chat-pin-btn ${pinned ? 'on' : ''}" data-chat-pin="${esc(x.key)}"
                  title="${pinned ? '取消置顶' : '置顶'}" aria-label="${pinned ? '取消置顶' : '置顶'}">📌</button>
          ${x.hasProfile ? `<button class="chat-pin-btn chat-remove-btn" data-chat-remove="${esc(x.key)}"
                  title="移除该会话（不再单独准入；聊天/记忆数据保留）" aria-label="移除会话">🗑</button>` : ''}
        </span>
      </div>`;
  };

  const runState = `
    <div class="settings-runstate">
      <div class="rs-title">机器人运行状态</div>
      <div class="rs-row"><span class="dot ${s?.onebot?.connected ? 'dot-on' : 'dot-off'}"></span><span>${s?.onebot?.connected ? '运行中' : '未就绪'}</span></div>
      <div class="rs-row muted">${state.paused ? '⏸ 已暂停' : (s?.orchestrator?.model ? `模型：${esc(s.orchestrator.model)}` : '模型：未设置')}</div>
    </div>`;

  const globalMenu = `
    <div class="settings-global-label muted">全局设置</div>
    <div class="settings-menu global-menu">
      ${[['api', '⚙ 模型 API'], ['search', '🔍 搜索服务'], ['security', '🛡 安全与准入'], ['system', '🧰 系统与维护']]
      .map(([id, label]) => `<button class="settings-menu-item global-item ${state.settingsView === 'global' && state.settingsSection === id ? 'active' : ''}" data-gsec="${id}">${label}</button>`).join('')}
    </div>
    <div class="hint" style="padding:10px 12px">
      会话级配置（人设/记忆/聊天设置/工具与技能）在「会话管理」里按会话单独设置。
    </div>`;

  sidebar.innerHTML = isCm
    ? `<div class="cm-rail-head">${runState}
      <div class="cm-rail-actions">
        <button class="btn btn-small" id="chat-session-add-btn" title="添加要单独配置/准入的会话">＋ 添加会话</button>
        <button class="btn btn-small" id="session-broadcast-btn" title="给选中的群/私聊批量发送一条消息">群发</button>
      </div>
      <input type="search" id="chat-session-search" class="session-search" placeholder="搜索会话（名字/群号）…"
             value="${esc(state.sessionSearch || '')}" autocomplete="off" /></div>
      <div class="settings-menu session-menu">
        <button class="settings-menu-item session-item ${activeScope === 'default' ? 'active' : ''}"
                id="chat-default-item" title="没有单独添加的会话都归到默认会话">
          <span class="chat-row-main"><span class="chat-row-icon">★</span>
            <span class="chat-row-text"><span class="chat-row-name"><span class="chat-row-title">默认会话</span></span>
              <span class="chat-row-sub">其余所有会话的合计</span></span></span>
        </button>
        ${shown.map(sessionRow).join('') || '<div class="hint session-empty">还没有单独添加的会话。点「＋ 添加会话」，其余会话都归「默认会话」。</div>'}
      </div>
      <div class="cm-rail-resizer" id="cm-rail-resizer" title="拖动调整左侧宽度（双击恢复默认）"></div>`
    : `${runState}${globalMenu}`;
  bindSettingsSidebarEvents(sidebar);
}

function bindSettingsSidebarEvents(sidebar) {
  const searchInput = sidebar.querySelector('#chat-session-search');
  searchInput?.addEventListener('input', (e) => {
    state.sessionSearch = e.target.value;
    // 只重筛列表，不整栏重建，避免打字时失焦
    renderSessionListOnly(sidebar, searchInput);
  });

  sidebar.querySelector('#chat-default-item')?.addEventListener('click', async () => {
    flushSettingsSaves();
    state.settingsView = 'session';
    state.settingsScope = 'default';
    if (typeof selectCmScope === 'function' && state.tab === 'chatmanage') selectCmScope('default');
    else await refreshSettingsPane();
  });

  sidebar.querySelectorAll('.chat-row').forEach((el) => {
    el.addEventListener('click', async (ev) => {
      if (ev.target?.closest?.('.chat-pin-btn')) return;
      flushSettingsSaves();
      state.settingsView = 'session';
      state.settingsScope = el.dataset.chatKey;
      if (typeof selectCmScope === 'function' && state.tab === 'chatmanage') selectCmScope(el.dataset.chatKey);
      else await refreshSettingsPane();
    });
  });

  sidebar.querySelectorAll('.chat-pin-btn').forEach((btn) => {
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const key = btn.dataset.chatPin;
      const row = (state.chatSessions || []).find((x) => x.key === key);
      const pinned = (row?.pinnedAt || 0) > 0 ? 0 : Date.now();
      try {
        await api(`/api/chat-profiles/${profileUrl(key)}`, { method: 'PATCH', body: JSON.stringify({ pinnedAt: pinned }) });
        await loadChatProfiles({ quiet: true });
        renderSettingsSidebar();
      } catch (e) { showAppAlert(`置顶失败：${e.message}`); }
    });
  });

  // 移除会话：删条目 = 不再准入（acceptAllSessions=false 时）；数据保留
  sidebar.querySelectorAll('[data-chat-remove]').forEach((btn) => {
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const key = btn.dataset.chatRemove;
      if (!(await uiConfirm(`确定移除会话「${chatTitleOf(key)}」（${key}）？\n\n移除后该会话不再被单独服务（聊天/记忆/运行记录保留）。`))) return;
      try {
        await api(`/api/chat-profiles/${profileUrl(key)}`, { method: 'DELETE' });
        // 正在查看被移除的会话 → 回落到默认会话
        if (state.cmScope === key) state.cmScope = 'default';
        if (state.settingsScope === key) state.settingsScope = 'default';
        await loadChatProfiles({ quiet: true });
        renderSettingsSidebar();
        if (state.tab === 'chatmanage') switchCmSub(state.cmSub);
      } catch (e) { showAppAlert(`移除失败：${e.message}`); }
    });
  });

  // 添加会话（曾被我误删绑定 → 点击无反应）
  sidebar.querySelector('#chat-session-add-btn')?.addEventListener('click', () => openAddSessionModal());
  // 群发：入口已从运行记录列表头移到这里（逻辑在 10-feedback.js）
  sidebar.querySelector('#session-broadcast-btn')?.addEventListener('click', () => {
    if (typeof openBroadcastModal === 'function') openBroadcastModal();
  });
  // 左栏宽度拖拽（仅会话管理）
  if (sidebar.id === 'cm-rail' && typeof initCmRailResizer === 'function') initCmRailResizer();


  sidebar.querySelectorAll('[data-gsec]').forEach((el) => {
    el.addEventListener('click', () => {
      state.settingsView = 'global';
      state.settingsSection = el.dataset.gsec;
      renderSettingsSidebar();
      renderSettings();
      uiEnter($('#settings-form'));
    });
  });
}

/** 搜索输入时重建左栏（保留输入框焦点与光标）。 */
function renderSessionListOnly(sidebar, searchInput) {
  const focusLen = searchInput.value.length;
  const cursorStart = searchInput.selectionStart;
  renderSettingsSidebar();
  const input = sidebar.querySelector('#chat-session-search') || $('#chat-session-search');
  if (input) {
    try {
      input.focus({ preventScroll: true });
      input.setSelectionRange(cursorStart ?? focusLen, cursorStart ?? focusLen);
    } catch { /* ignore */ }
  }
}

/** 切换作用域后重建右栏（设置页旧路径的兼容入口）。 */
async function refreshSettingsPane() {
  renderSettingsSidebar();
  if (state.tab === 'chatmanage') {
    if (typeof switchCmSub === 'function') switchCmSub(state.cmSub);
    return;
  }
  renderSettings();
  uiEnter($('#settings-form'));
}

// ── 右栏：会话设置面板 ────────────────────────────────────────────────
function renderSessionPanelHead() {
  const isDefault = state.settingsScope === 'default';
  const row = isDefault ? null : scopeSessionRow();
  const overrides = isDefault ? null : (state.scopeOverrides || {});
  const count = isDefault ? 0 : Object.keys(overrides || {}).length;
  const title = isDefault ? '默认设置（所有会话）'
    : `${row?.kind === 'group' ? '群' : '私聊'}「${esc(row?.alias || row?.name || chatTitleOf(state.settingsScope))}」`;
  const sub = isDefault
    ? '以下设置是所有未单独自定义会话的默认值'
    : `${esc(state.settingsScope)} · ${count ? `已自定义 ${count} 个分区` : '跟随默认设置'}`;
  return `
    <div id="session-panel-head" class="session-panel-head">
      <div class="session-panel-title-row">
        <span class="session-panel-title">${title}</span>
      </div>
      <div class="muted session-panel-sub">${sub}</div>
    </div>`;
}

/** 会话面板整段（行头 + 分区菜单 + 内容），由 renderSettingsSection 调用。 */
function renderSessionSettingsSection(c) {
  const sec = sessionSectionNow();
  const renderers = {
    persona: () => renderPersonaSection(c),
    memory: () => renderMemorySettingsSection(c),
    chat: () => renderChatSection(c),
    tools: () => renderToolsSection(c)
  };
  const render = renderers[sec] || renderers.persona;
  const isDefault = state.settingsScope === 'default';
  return `
    ${renderSessionPanelHead()}
    <div class="session-tabs">
      ${PROFILE_SECTIONS.map(([id, label]) => `
        <button class="session-tab ${sec === id ? 'active' : ''}" data-session-section="${id}">${label}</button>`).join('')}
      ${!isDefault ? `<span class="session-tab-op" id="session-restore-btn-wrap"></span>` : ''}
    </div>
    <div class="session-panel-body">${render()}</div>
    <div class="hint" style="margin-top:10px">
      ${isDefault
        ? '这里是全局默认值：未单独自定义的会话都继承这一套。要为某个群/私聊单独设置，在左侧选中它。'
        : '改动只写入这个会话；未改动的字段继续跟随默认设置。点顶部「恢复默认」可让整个分区回到默认值。'}
    </div>`;
}

/** 当前分区是否被（该会话）覆盖。 */
function isSectionOverridden() {
  if (state.settingsView !== 'session' || state.settingsScope === 'default') return false;
  const ov = state.scopeOverrides || {};
  const sec = sessionSectionNow();
  if (ov[sec]) return true;
  // 「工具与技能」分区里还嵌着会话级技能/插件开关（overrides.skills），
  // 只改过技能开关时也要能亮出"恢复默认"。
  return sec === 'tools' && Boolean(ov.skills);
}

/** 在分区菜单行尾挂"恢复默认 | 本项已自定义"标记（渲染后调用，一次即可）。 */
function mountSessionRestoreButton() {
  if (!settingsTabActive() || state.settingsView !== 'session' || state.settingsScope === 'default') return;
  const wrap = $('#session-restore-btn-wrap');
  if (!wrap) return;
  const section = sessionSectionNow();
  const label = PROFILE_SECTIONS.find(([id]) => id === section)?.[1] || section;
  if (isSectionOverridden()) {
    wrap.innerHTML = `<button class="btn btn-small btn-danger" id="session-restore-btn"
      title="删除该分区的会话覆盖，恢复为默认设置">恢复${esc(label)}默认</button>`;
    wrap.querySelector('#session-restore-btn')?.addEventListener('click', async () => {
      if (!(await uiConfirm(`确定恢复「${label}」为默认设置？\n\n这个会话对该分区的自定义将被清除（其余分区不受影响）。`))) return;
      try {
        await api(`/api/chat-profiles/${profileUrl(state.settingsScope)}/overrides/${section}`, { method: 'DELETE' });
        // 「工具与技能」把技能/插件开关也算在内：一并恢复，否则按钮点了还会亮着
        if (section === 'tools') {
          await api(`/api/chat-profiles/${profileUrl(state.settingsScope)}/overrides/skills`, { method: 'DELETE' }).catch(() => {});
        }
        await refreshScopeAfterWrite();
        showAppAlert('已恢复默认设置', { kind: 'info' });
      } catch (e) { showAppAlert(`恢复失败：${e.message}`); }
    });
  } else {
    wrap.innerHTML = `<span class="muted" style="font-size:12px">跟随默认设置</span>`;
  }
}

/** 覆盖写入/恢复成功后的统一刷新：拉配置 + 重绘右栏 + 刷新左栏统计。 */
async function refreshScopeAfterWrite() {
  await loadChatProfiles({ quiet: true });
  if (isSessionScope()) await loadScopeConfig();
  else await loadSettings();
  renderSettings();
}

/** 「添加会话」弹窗：从 OneBot 好友/群列表选择，或手动输入号码。 */
function openAddSessionModal() {
  const overlay = modelModalShell({
    head: '添加会话',
    body: `
      <div class="hint" style="margin-bottom:8px">添加后该会话即被允许与机器人交互（acceptAllSessions 未开启时，未添加的会话不响应）。</div>
      <div class="field"><label>从 OneBot 列表选择</label>
        <div id="add-session-candidates" class="session-add-list"><div class="muted" style="padding:8px">加载中…</div></div>
      </div>
      <div class="field-row">
        <div class="field"><label>类型</label>
          <select id="add-session-kind"><option value="group">QQ 群</option><option value="private">好友/私聊</option></select></div>
        <div class="field"><label>号码（群号/QQ号）</label><input id="add-session-id" placeholder="例如 123456789" /></div>
      </div>
      <div class="field"><label>备注名（可选，仅控制台显示）</label><input id="add-session-alias" placeholder="留空自动取群名/QQ昵称" /></div>`,
    foot: `<button class="btn" id="add-session-cancel">取消</button>
           <button class="btn btn-primary" id="add-session-save">添加</button>`
  });
  const list = overlay.querySelector('#add-session-candidates');
  (async () => {
    try {
      const [g, f] = await Promise.all([api('/api/onebot/groups'), api('/api/onebot/friends')]);
      // 顺手把 OneBot 名字写进缓存：左栏/用量页的「群 <号>」兜底文案靠它升级成群名
      state.qqGroupNames = state.qqGroupNames || {};
      for (const x of g.groups || []) {
        const id = String(x?.id ?? '').trim();
        const name = String(x?.name ?? '').trim();
        if (id && name) state.qqGroupNames[id] = name;
      }
      // 候选里排除的只该是"已单独添加（有 profile）"的会话；只在历史里出现过、
      // 还没准入的会话必须能重新添加，否则移除后就再也加不回来了。
      const have = new Set((state.chatSessions || []).filter((x) => x.hasProfile).map((x) => x.key));
      const items = [
        ...(g.groups || []).map((x) => ({ kind: 'group', id: String(x.id), name: x.name || `群 ${x.id}` })),
        ...(f.friends || []).map((x) => ({ kind: 'private', id: String(x.user_id ?? x.qq ?? ''), name: x.nickname || String(x.user_id ?? '') }))
      ].filter((x) => /^[A-Za-z0-9_-]+$/.test(x.id) && !have.has(`${x.kind}:${x.id}`) && x.id);
      list.innerHTML = items.length
        ? items.map((x) => `
          <div class="session-add-row" data-kind="${x.kind}" data-id="${esc(x.id)}" data-name="${esc(x.name)}">
            <span>${x.kind === 'group' ? '👥' : '👤'} ${esc(x.name)}</span>
            <span class="muted">${esc(x.id)}</span>
          </div>`).join('')
        : '<div class="muted" style="padding:8px">列表为空或 OneBot 未连接，可直接手动输入号码。</div>';
      list.querySelectorAll('.session-add-row').forEach((el) => {
        el.addEventListener('click', () => {
          overlay.querySelector('#add-session-kind').value = el.dataset.kind;
          overlay.querySelector('#add-session-id').value = el.dataset.id;
          overlay.querySelector('#add-session-alias').value = el.dataset.name || '';
        });
      });
      // 名字缓存拿到了：重绘左栏，把「群 <号>」升级成真实群名
      if (state.tab === 'settings' || state.tab === 'chatmanage') renderSettingsSidebar();
    } catch { list.innerHTML = '<div class="muted" style="padding:8px">拉取失败（OneBot 未连接？），可直接手动输入号码。</div>'; }
  })();

  overlay.querySelector('#add-session-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#add-session-save').addEventListener('click', async () => {
    const kind = overlay.querySelector('#add-session-kind')?.value || 'group';
    const id = String(overlay.querySelector('#add-session-id')?.value || '').trim();
    const alias = String(overlay.querySelector('#add-session-alias')?.value || '').trim();
    if (!/^[A-Za-z0-9_-]+$/.test(id)) { showAppAlert('请输入正确的号码（数字）'); return; }
    const key = `${kind}:${id}`;
    if (!(await uiConfirm(`添加会话「${alias || chatTitleOf(key)}」（${key}）？\n\n该会话将被允许与机器人交互。`))) return;
    try {
      await api('/api/chat-profiles', { method: 'POST', body: JSON.stringify({ key, alias }) });
      closeModelModal(overlay);
      await loadChatProfiles({ quiet: true });
      state.settingsView = 'session';
      state.settingsScope = key;
      if (state.tab === 'chatmanage' && typeof selectCmScope === 'function') {
        selectCmScope(key);
        // 刚添加的会话多半是要配置它：直接落到「设置」子页
        if (state.cmSub !== 'settings') switchCmSub('settings');
      } else await refreshSettingsPane();
    } catch (e) { showAppAlert(`添加失败：${e.message}`); }
  });
}

// ── 顶栏二维码彩蛋（从设置侧栏移走）─────────────────────────────────
function showQrcodeEgg() {
  const ov = document.createElement('div');
  ov.className = 'qrcode-egg-overlay';
  ov.innerHTML = '<img src="group-qrcode.jpg" alt="群二维码" '
    + 'onerror="this.remove(); this.parentElement?.insertAdjacentText(\'afterbegin\', \'二维码图片缺失：请把 group-qrcode.jpg 放到 ui/ 目录下\')" />';
  const close = () => closeAnimatedOverlay(ov);
  ov.addEventListener('click', close);
  document.body.appendChild(ov);
}

// 顶栏按钮是常驻元素：加载时直接绑（"接线"检查按元素监听器判定）
/** 会话面板事件（每次重渲染后由 renderSettings 调用）：分区标签切换。 */
function bindSessionTabs(box) {
  const root = box || $('#settings-form');
  if (!root) return;
  root.querySelectorAll('.session-tab').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const key = btn.dataset.sessionSection;
      if (key) { state.sessionSection = key; renderSettings(); }
    });
  });
}

$('#qrcode-egg-btn')?.addEventListener('click', (e) => {
  e.preventDefault();
  showQrcodeEgg();
});

if (typeof document.addEventListener === 'function') {
  document.addEventListener('click', () => { /* 预留：会话面板全局兜底 */ });
}






