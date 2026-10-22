// 〔人设管理：一级菜单页 + 人设库增删查改〕—— 2026-10-22
//
// 为什么要单独一页：
//   · 以前人设只能在「会话管理 → 默认设置 / 某个会话 → 人设」里通过
//     「＋ 添加人设」创建，入口散落在每个会话面板里 —— 想对比/整理人设
//     得先挑一个会话，新增出来的人设也看不出总共有多少。
//   · 现在人设库提升为一级菜单：列表 / 搜索 / 查看 / 新建 / 编辑 / 删除 / 复制。
//     会话面板只保留「选择人设」，不再提供新增入口。
//
// 数据口径：
//   GET /api/persona-templates → [{ id, name, text, customRules, builtin }]
//     · builtin:true 来自 src/personas.js，只读；想改先「复制为自定义」。
//     · 自定义条目存在 config.customPersonas，id 形如 custom_<下标>。
//   POST   /api/persona-templates            新建
//   PATCH  /api/persona-templates/custom_N   编辑
//   DELETE /api/persona-templates/custom_N   删除
//
// 注意：编辑人设库不会自动改写已经选过该人设的会话 —— 会话保存的是选择时的
// 文本副本。页面上的提示会写明这一点，避免"改了人设但群里的 bot 没变"的困惑。
'use strict';

Object.assign(state, {
  personaList: [],      // 完整人设库（含 customRules / builtin），人设管理页与会话选择器共用
  personaSearch: ''     // 搜索关键词（切走再回来仍保留，和技能/插件页的搜索框一致）
});

/** 拉取人设库，并同步给会话面板的 state.personaTemplates。 */
async function loadPersonaTemplates() {
  const data = await api('/api/persona-templates');
  const list = Array.isArray(data?.templates) ? data.templates : [];
  state.personaList = list;
  const map = {};
  for (const t of list) {
    if (!t || t.id == null) continue;
    map[t.id] = {
      name: t.name,
      text: t.text,
      customRules: t.customRules || '',
      builtin: !!t.builtin
    };
  }
  state.personaTemplates = map;
  return list;
}

function personaById(id) {
  const key = String(id ?? '');
  return (state.personaList || []).find((p) => String(p?.id) === key) || null;
}

/** 卡片上的纯文本预览：折叠空白，超长截断（避免整篇角色卡把列表撑爆）。 */
function personaPreview(text, max = 170) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 进入「人设管理」页签时调用（switchTab 里唯一入口）。 */
async function loadPersonaPage({ silent = false } = {}) {
  const box = $('#personas-page');
  if (!box) return;
  if (!silent) {
    box.innerHTML = `<div class="usage-wrap">
      <div class="usage-head"><h2>人设管理</h2></div>
      <div class="hint">正在加载人设库…</div>
    </div>`;
  }
  try {
    await loadPersonaTemplates();
  } catch (err) {
    box.innerHTML = `<div class="usage-wrap">
      <div class="usage-head"><h2>人设管理</h2></div>
      <div class="empty-hint">人设库加载失败：${esc(err?.message || err)}<br />可点「重试」再拉一次。</div>
      <div style="margin-top:12px"><button class="btn btn-small" id="persona-retry-btn">重试</button></div>
    </div>`;
    $('#persona-retry-btn')?.addEventListener('click', () => loadPersonaPage());
    return;
  }
  renderPersonaPage();
  if (!silent) uiEnter(box);
}

function renderPersonaPage() {
  const box = $('#personas-page');
  if (!box) return '';
  const all = state.personaList || [];
  const builtins = all.filter((p) => p.builtin);
  const customs = all.filter((p) => !p.builtin);

  const card = (p) => {
    const id = String(p.id ?? '');
    const haystack = [p.id, p.name, p.text, p.customRules].filter(Boolean).join(' ').toLowerCase();
    return `
      <div class="persona-card ${p.builtin ? 'persona-card-builtin' : ''}"
           data-persona-id="${esc(id)}" data-search="${esc(haystack)}"
           title="${p.builtin ? '内置人设（只读）' : '自定义人设'}">
        <div class="persona-card-main">
          <div class="persona-card-name">
            <span>${esc(p.name || '（未命名人设）')}</span>
            <span class="persona-badge ${p.builtin ? '' : 'is-custom'}">${p.builtin ? '内置' : '自定义'}</span>
            ${p.customRules ? '<span class="persona-badge is-rule">含附加规则</span>' : ''}
          </div>
          <div class="persona-card-desc">${esc(personaPreview(p.text))}</div>
        </div>
        <div class="persona-card-acts">
          <button class="btn btn-small" data-persona-action="view" data-persona-id="${esc(id)}">查看</button>
          ${p.builtin
            ? `<button class="btn btn-small" data-persona-action="copy" data-persona-id="${esc(id)}">复制为自定义</button>`
            : `<button class="btn btn-small" data-persona-action="edit" data-persona-id="${esc(id)}">编辑</button>
               <button class="btn btn-small btn-danger" data-persona-action="delete" data-persona-id="${esc(id)}">删除</button>`}
        </div>
      </div>`;
  };

  const group = (title, hint, list) => (list.length ? `
    <div class="persona-group" data-persona-group>
      <h3 class="usage-h3">${esc(title)} <span class="muted" style="font-size:12px">${esc(hint)}</span></h3>
      <div class="persona-grid">${list.map(card).join('')}</div>
    </div>` : '');

  const groups = [
    group('内置人设', `${builtins.length} 个 · 代码内置，只读`, builtins),
    group('自定义人设', `${customs.length} 个 · 可编辑 / 删除`, customs)
  ].filter(Boolean).join('');

  const html = `<div class="usage-wrap">
    <div class="usage-head">
      <h2>人设管理</h2>
      <button class="btn btn-small" id="persona-new-btn" title="新建一个人设">＋ 新建人设</button>
      <input type="search" class="module-search" id="persona-search"
        placeholder="搜索人设名称 / 角色设定…" autocomplete="off" value="${esc(state.personaSearch || '')}" />
      <div class="usage-days">
        <span class="uc-tag" id="persona-count-tag">共 ${all.length} 个人设</span>
        <button class="btn btn-small" id="persona-refresh-btn">刷新</button>
      </div>
    </div>
    <div class="hint" style="margin-bottom:14px">
      人设库是全局的：<b>内置人设只读</b>，自定义人设可以新建 / 编辑 / 删除；
      「复制为自定义」会基于内置人设生成一份可编辑副本。<br />
      会话里的「人设」只负责<b>选用</b>，不再提供新增入口。改动人设库<b>不会</b>改写已经选过该人设的会话
      （会话保存的是选择时的文本副本）—— 要让某个会话用上新内容，到「会话管理 → 设置 → 人设」重新选一次即可。
    </div>
    ${groups || `<div class="empty-hint">人设库还是空的。点「＋ 新建人设」创建一个吧。</div>`}
    <div class="hint" id="persona-search-empty" style="display:none;margin:10px 0">没有匹配的人设，换个关键词试试。</div>
  </div>`;

  box.innerHTML = html;
  bindPersonaPageEvents();
  // 搜索词在切走再回来时仍保留：渲染完立即按当前关键词过滤一次
  if (String(state.personaSearch || '').trim()) applyPersonaFilter();
  return html;
}

/** 页面级事件（委托到 #personas-page 本身，重绘不会重复绑定）。 */
function bindPersonaPageEvents() {
  const page = $('#personas-page');
  if (!page) return;
  if (!page.__personaClickBound) {
    page.__personaClickBound = true;
    page.addEventListener('click', onPersonaPageClick);
  }
  const search = $('#persona-search');
  if (search && !search.__personaInputBound) {
    search.__personaInputBound = true;
    search.addEventListener('input', () => {
      state.personaSearch = search.value;
      applyPersonaFilter();
    });
  }
}

function onPersonaPageClick(e) {
  const actionBtn = e.target?.closest?.('[data-persona-action]');
  if (actionBtn) {
    e.preventDefault();
    const id = actionBtn.dataset.personaId;
    const action = actionBtn.dataset.personaAction;
    if (action === 'view') openPersonaViewModal(id);
    else if (action === 'edit') openPersonaEditModal(id);
    else if (action === 'copy') openPersonaCreateModal({ copyFrom: id, onSaved: refreshPersonaPage });
    else if (action === 'delete') deletePersonaFromLibrary(id);
    return;
  }
  if (e.target?.closest?.('#persona-new-btn')) {
    openPersonaCreateModal({ onSaved: refreshPersonaPage });
    return;
  }
  if (e.target?.closest?.('#persona-refresh-btn')) {
    loadPersonaPage();
    return;
  }
  // 点卡片主体 = 查看详情；文本选区/按钮不触发（方便复制粘贴人设内容）
  const cardEl = e.target?.closest?.('.persona-card');
  if (cardEl && !e.target.closest('button')) {
    const sel = typeof window.getSelection === 'function' ? String(window.getSelection() || '') : '';
    if (!sel.trim()) openPersonaViewModal(cardEl.dataset.personaId);
  }
}

async function refreshPersonaPage() {
  await loadPersonaPage({ silent: true });
}

/** 只做 DOM 内过滤：不重绘，打字不丢焦点，也不打断卡片状态。 */
function applyPersonaFilter() {
  const page = $('#personas-page');
  if (!page) return;
  const q = String(state.personaSearch || '').trim().toLowerCase();
  let visible = 0;
  page.querySelectorAll('.persona-card').forEach((card) => {
    const hit = !q || String(card.dataset.search || '').includes(q);
    card.style.display = hit ? '' : 'none';
    if (hit) visible++;
  });
  page.querySelectorAll('[data-persona-group]').forEach((group) => {
    const any = [...group.querySelectorAll('.persona-card')].some((c) => c.style.display !== 'none');
    group.style.display = any ? '' : 'none';
  });
  const empty = $('#persona-search-empty');
  if (empty) empty.style.display = visible ? 'none' : '';
  const tag = $('#persona-count-tag');
  if (tag) {
    const total = (state.personaList || []).length;
    tag.textContent = q ? `匹配 ${visible} / ${total}` : `共 ${total} 个人设`;
  }
}

/** 详情弹窗：查看完整角色设定 / 附加规则。 */
function openPersonaViewModal(id) {
  const p = personaById(id);
  if (!p) {
    showAppAlert('人设不存在（可能已被删除，请刷新列表）');
    return null;
  }
  const overlay = modelModalShell({
    head: `${p.builtin ? '内置人设' : '自定义人设'} · ${esc(p.name || '')}`,
    body: `
      <div class="persona-detail-meta">ID：${esc(p.id)} · ${p.builtin ? '内置（只读）' : '自定义'}</div>
      <div class="field"><label>角色设定</label>
        <pre class="persona-detail-text">${esc(p.text || '')}</pre>
      </div>
      ${p.customRules ? `<div class="field"><label>管理员附加规则</label>
        <pre class="persona-detail-text">${esc(p.customRules)}</pre>
      </div>` : ''}`,
    foot: `<button class="btn" id="persona-view-close">关闭</button>
           <button class="btn" id="persona-view-copy">复制为自定义</button>
           ${p.builtin ? '' : `<button class="btn btn-primary" id="persona-view-edit">编辑</button>`}`
  });
  overlay.querySelector('#persona-view-close')?.addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#persona-view-copy')?.addEventListener('click', () => {
    closeModelModal(overlay);
    openPersonaCreateModal({ copyFrom: id, onSaved: refreshPersonaPage });
  });
  overlay.querySelector('#persona-view-edit')?.addEventListener('click', () => {
    closeModelModal(overlay);
    openPersonaEditModal(id);
  });
  return overlay;
}

/** 新建人设（兼容旧调用名：会话面板的新增入口已移除，测试/旧代码仍可直接调用）。 */
function openPersonaCreateModal(opts = {}) {
  return openPersonaEditorModal({ ...(opts || {}), id: '' });
}

/** 编辑自定义人设：内置人设不允许直接改，引导先复制。 */
function openPersonaEditModal(id, opts = {}) {
  const p = personaById(id);
  if (!p) {
    showAppAlert('人设不存在（可能已被删除，请刷新列表）');
    return null;
  }
  if (p.builtin) {
    showAppAlert('内置人设是代码内置的，不能直接修改。可以「复制为自定义」后再编辑。');
    return null;
  }
  return openPersonaEditorModal({ ...(opts || {}), id });
}

/**
 * 新建 / 编辑 / 复制共用的编辑弹窗。
 * @param {{id?: string, copyFrom?: string, onSaved?: Function}} opts
 *   id      非空 = 编辑该自定义人设
 *   copyFrom 非空 = 以该人设为模板新建（内置/自定义都行）
 *   onSaved 保存成功后的回调（人设管理页用它刷新列表）
 */
function openPersonaEditorModal({ id = '', copyFrom = '', onSaved = null } = {}) {
  const editing = Boolean(id);
  const base = personaById(id || copyFrom);
  if ((id || copyFrom) && !base) {
    showAppAlert('人设不存在（可能已被删除，请刷新列表）');
    return null;
  }
  if (editing && base.builtin) {
    showAppAlert('内置人设不能直接修改，请复制为自定义后再编辑。');
    return null;
  }
  const initialName = editing
    ? String(base?.name || '')
    : (copyFrom && base ? String(base.name || '').slice(0, 46) + '（副本）' : '');
  const head = editing ? '编辑人设' : (copyFrom && base ? '复制为自定义人设' : '新建人设');
  const overlay = modelModalShell({
    head,
    body: `
      ${editing ? '' : `<div class="hint" style="margin-bottom:10px">${copyFrom && base ? `基于「${esc(base.name || '')}」创建一份可编辑副本。` : '创建后可在本页继续编辑 / 删除；到会话里「选择人设」即可选用。'}</div>`}
      <div class="field"><label>人设名称</label>
        <input type="text" id="persona-form-name" maxlength="50" placeholder="例如：毒舌老哥"
          value="${esc(initialName)}" />
      </div>
      <div class="field"><label>角色设定</label>
        <textarea id="persona-form-text" class="persona-role-text" style="min-height:320px"
          placeholder="写下这个角色是谁、怎么说话、有哪些雷点和习惯…">${esc(base?.text || '')}</textarea>
      </div>
      <div class="field"><label>管理员附加规则（可选，追加到系统提示）</label>
        <textarea id="persona-form-rules" style="min-height:90px"
          placeholder="可选：只对这个人设生效的额外规则">${esc(base?.customRules || '')}</textarea>
      </div>
      <div id="persona-form-hint" class="muted" style="font-size:12px"></div>`,
    foot: `<button class="btn" id="persona-form-cancel">取消</button>
           <button class="btn btn-primary" id="persona-form-save">${editing ? '保存修改' : '创建人设'}</button>`
  });
  const hint = overlay.querySelector('#persona-form-hint');
  const setHint = (text) => { if (hint) hint.textContent = text; };
  overlay.querySelector('#persona-form-cancel')?.addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#persona-form-save')?.addEventListener('click', async () => {
    const name = String(overlay.querySelector('#persona-form-name')?.value || '').trim();
    const text = String(overlay.querySelector('#persona-form-text')?.value || '').trim();
    const customRules = String(overlay.querySelector('#persona-form-rules')?.value || '').trim();
    if (!name) { setHint('人设名称不能为空'); return; }
    if (!text) { setHint('角色设定不能为空'); return; }
    const saveBtn = overlay.querySelector('#persona-form-save');
    if (saveBtn) saveBtn.disabled = true;
    setHint('保存中…');
    try {
      if (editing) {
        await api(`/api/persona-templates/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ name, text, customRules })
        });
      } else {
        await api('/api/persona-templates', {
          method: 'POST',
          body: JSON.stringify({ name, text, customRules })
        });
      }
      closeModelModal(overlay);
      showMiniToast(editing ? `已保存人设「${name}」` : `已创建人设「${name}」`);
      // 人设库变化后同步 state；页面由调用方决定怎么重绘
      try { await loadPersonaTemplates(); } catch { /* 刷新失败不掩盖保存成功 */ }
      if (typeof onSaved === 'function') await onSaved();
      else if (state.tab === 'personas') await refreshPersonaPage();
    } catch (err) {
      if (saveBtn) saveBtn.disabled = false;
      setHint(`保存失败：${err?.message || err}`);
    }
  });
  return overlay;
}

async function deletePersonaFromLibrary(id) {
  const p = personaById(id);
  if (!p) {
    showAppAlert('人设不存在（可能已被删除，请刷新列表）');
    return;
  }
  if (p.builtin) {
    showAppAlert('内置人设是代码内置的，不能删除。');
    return;
  }
  if (!(await uiConfirm(`确定删除自定义人设「${p.name}」？\n\n只从人设库里删除；已经选用过它的会话不受影响（会话保存的是文本副本）。`))) return;
  try {
    await api(`/api/persona-templates/${encodeURIComponent(id)}`, { method: 'DELETE', body: '{}' });
    showMiniToast(`已删除人设「${p.name}」`);
    await refreshPersonaPage();
  } catch (err) {
    showAppAlert(`删除失败：${err?.message || err}`);
  }
}
