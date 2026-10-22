// 〔设置渲染 / 模型目录 / 技能插件页〕——M9 拆分第 7 段
'use strict';
// ── 模型目录（多提供商；面板式选择 + 图片输入能力徽标） ──
function visionBadge(providerId, model) {
  const r = (state.visionResults || {})[`${providerId}|||${model}`];
  const src = r?.source === 'docs' ? '官方资料' : (r?.source === 'probe' ? '在线探测' : '');
  const show = state.config?.ui?.showVision !== false;
  const t = (cls, text) => `<span class="vbadge ${cls}" style="${show ? '' : 'display:none'}" title="${esc((src ? `【${src}】` : '') + (r?.note || ''))}">${text}</span>`;
  if (!r) return t('unk', '未检测');
  if (r.verdict === 'vision') return t('ok', '支持图片输入');
  if (r.verdict === 'no-vision') return t('no', '不支持图片输入');
  return t('unk', '无法判定');
}

/** 左右开关（.switch）：设置页统一勾选形态。 */
function switchHtml(id, checked, label, extra = '') {
  return `<label class="switch"${extra ? ` ${extra}` : ''}>
    <input type="checkbox" id="${id}" ${checked ? 'checked' : ''} />
    <span class="track"><span class="thumb"></span></span>
    <span>${label}</span>
  </label>`;
}

// ── 两栏悬停下拉：左供应商 / 右模型 ──
function visionVerdictOf(providerId, model) {
  return (state.visionResults || {})[`${providerId}|||${model}`]?.verdict;
}

// 说明：这里曾经有一个 bindModelDdDismiss()，目标是 #model-dd / #model-pick-btn，
// 但真正的模型选择控件 id 是 #cfg-model-pick / #cfg-model（记忆页是 #cfg-mem-model-pick），
// 那两个 id 全项目从未被创建过 —— 函数也从未被调用，属于纯死代码，已删除。
// 若将来需要一个"点击外部/Esc 收起目录"的通用行为，请在 modelModalShell 里统一实现。






function renderSettings() {
  // 渲染守卫：自动保存进行中（表单正在被读取 / state.config 即将被覆盖）时
  // 不允许重建表单 DOM —— 会吹掉用户正在输入的未保存内容。
  // 拦下的请求由 endSettingsGuard() 在保存完成后补放。
  if (settingsGuard.pending > 0) {
    settingsGuard.needRerender = true;
    return;
  }
  // 焦点保护（2026-09-19 修"文本框偶发点不进/失焦"）：守卫只护住"保存进行中"的
  // 窗口，但守卫之外仍有一批异步重渲染（群名补底 / 视觉扫描完成 / 技能开关保存 /
  // 守卫补放的延迟渲染）会在用户打字途中重建 innerHTML —— 焦点、光标位置、
  // 未落盘的输入值全部被吹掉。这里在重建前后做"焦点与选区快照恢复"：
  //   ① 记下正在聚焦的输入框 id + 光标位置 + 当前值；
  //   ② 重建后按 id 找回元素，把值写回（渲染用的是 state.config，可能还没
  //      带上防抖窗口内的输入），恢复焦点与光标。
  const box = settingsFormRoot();
  // 滚动位置保持：innerHTML 重建会把阅读位置弹回顶部（也是一次大滚动跳转，
  // 会加剧深滚动下的合成错位）。重建后原样恢复。
  const prevScrollTop = box ? box.scrollTop : 0;
  // 折叠卡开合状态保持：重建后所有 setCard 会按默认 open 重置，用户点开的卡
  // 突然收起/重开会造成页面高度跳变（“开关技能时页面跳一下”的成因之一）。
  const foldStates = new Map();
  if (box) {
    box.querySelectorAll('.setcard.fold[id]').forEach((card) => {
      foldStates.set(card.id, card.classList.contains('open'));
    });
  }
  // 左栏会话列表的滚动位置同样要保住（renderSettingsSidebar 会重建整个 rail）。
  const railScrollEl = document.querySelector('#cm-rail .session-menu');
  const prevRailScroll = railScrollEl ? railScrollEl.scrollTop : 0;
  const focusSnap = (() => {
    const el = document.activeElement;
    if (!box || !el || el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT') return null;
    if (el.type === 'checkbox' || el.type === 'radio' || !box.contains(el)) return null;
    return {
      id: el.id,
      selStart: el.selectionStart ?? null,
      selEnd: el.selectionEnd ?? null,
      value: el.value
    };
  })();
  const c = state.config;
  renderSettingsSidebar();
  try {
    box.innerHTML = `
    ${renderSettingsSection(c)}`;
    // 先折叠收纳再绑事件：autoFold 会搬 DOM，但节点上的监听会跟着节点走；
    // 挂在 #settings-form 上的委托不受影响。放后面绑定则能找到最终结构。
    if (typeof enhanceConcept2UI === 'function') enhanceConcept2UI(box);
    bindSettingsEvents(c);
    // 会话面板：分区标签切换 + 分区菜单行尾的"恢复默认/跟随默认"标记
    if (typeof bindSessionTabs === 'function') bindSessionTabs(box);
    if (typeof mountSessionRestoreButton === 'function') mountSessionRestoreButton();
    // 恢复折叠状态（只恢复本次渲染仍存在的卡 id）
    for (const [id, open] of foldStates) {
      const card = box.querySelector(`.setcard.fold[id="${id}"]`);
      if (card) card.classList.toggle('open', open);
    }
    if (box && prevScrollTop) box.scrollTop = prevScrollTop;
    const railNow = document.querySelector('#cm-rail .session-menu');
    if (railNow && prevRailScroll) railNow.scrollTop = prevRailScroll;
  } catch (err) {
    // 单个设置区渲染失败不能让整页空白 —— 显示错误占位，其余页签仍可用
    console.error('[settings] 渲染失败:', err);
    box.innerHTML = `<div class="empty-hint">设置页渲染失败：${esc(err?.message || err)}<br />可切换其它页签，或刷新后重试。</div>`;
    return;
  }
  if (focusSnap?.id) {
    const back = box.querySelector('#' + focusSnap.id);
    if (back && (back.tagName === 'INPUT' || back.tagName === 'TEXTAREA')) {
      try {
        back.value = focusSnap.value;   // 覆盖渲染值：防抖窗口内的输入不被回滚
        if (focusSnap.selStart != null) back.setSelectionRange(focusSnap.selStart, focusSnap.selEnd ?? focusSnap.selStart);
        back.focus({ preventScroll: true });
      } catch { /* 恢复失败不致命 */ }
    }
  }
  // 群名补底（一次性）：分群按钮/活跃设置下拉第一次渲染时 state.chats 可能还没到
  // （switchTab 只在列表为空时才拉）。这里发现为空就补拉，到达后重渲染一次。
  if (!(state.chats || []).length && !renderSettings.__chatsFetch) {
    renderSettings.__chatsFetch = true;
    api('/api/chats').then((d) => {
      if ((d.chats || []).length && settingsTabActive()) renderSettings();
    }).catch(() => {}).finally(() => { renderSettings.__chatsFetch = false; });
  }
}

function renderSettingsSection(c) {
  // 2026-10-21 改版：
  //   · 全局视图 → 只渲染"全局通用"分区（模型 API / 搜索 / 安全与准入 / 系统与维护）
  //   · 会话视图（含"默认设置"）→ 会话面板（人设/记忆/聊天设置/工具与技能）
  if (state.settingsView === 'session') {
    return renderSessionSettingsSection(c);
  }
  const sec = state.settingsSection || 'api';
  const sections = {
    api: () => renderApiSection(c),
    search: () => renderSearchSection(c),
    security: () => renderSecuritySection(c),
    system: () => renderSystemSection(c)
  };
  const render = sections[sec] || sections.api;
  return `
    ${render()}`;
}
function renderApiSection(c) {
  const currentProvider = (state.providers || []).find((p) => p.id === c.api.provider);
  const currentModelDisplay = (currentProvider?.modelNames || {})[c.api.model] || c.api.model;
  // 专用模型的显示名：跨提供商选择时也能读出目录名（找不到就显示裸 id）
  const displayOf = (modelId) => {
    const m = String(modelId || '').trim();
    if (!m) return '';
    for (const p of (state.providers || [])) {
      if ((p.modelNames || {})[m]) return `${p.modelNames[m]}`;
    }
    return m;
  };
  const visionModelDisplay = displayOf(c.api.visionModel);
  const videoModelDisplay = displayOf(c.api.videoModel);
  const sc = (typeof setCard === 'function') ? setCard : (o) => `<div class="setcard">${o.body}</div>`;
  return `
    <h3 id="settings-api">模型 API</h3>
    <p class="setsub">选渠道、配降级、算成本 —— 常用项内联，低频项点开折叠卡</p>
    ${sc({
      id: 'card-api-model',
      icon: '🔑',
      title: '模型与渠道',
      sub: '提供商 / 模型 / BaseURL',
      val: esc(c.api.model || '未选模型'),
      open: true,
      body: `
    <div class="field">
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" id="open-model-config-btn">⚙ 模型配置</button>
        <button class="btn" id="open-model-manage-btn">🗂 模型管理</button>
      </div>
      <div class="hint" id="provider-hint" style="margin-top:6px">${currentProvider ? `当前：${esc(currentProvider.displayName)} · ${esc(c.api.model || '未选模型')} @ ${esc(currentProvider.baseURL)}${currentProvider.hasKey ? ' · 已保存 API Key（不显示）' : ' · 未保存 API Key'}` : '尚未选择模型'}</div>
      <div class="hint" id="model-vision-hint" style="margin-top:6px"></div>
      <input type="hidden" id="cfg-provider" value="${esc(c.api.provider || '')}" />
      <input type="hidden" id="cfg-model" value="${esc(c.api.model || '')}" />
      <input type="hidden" id="cfg-baseurl-value" value="${esc(c.api.baseUrl)}" />
    </div>`
    })}
    ${sc({
      id: 'card-api-fallback',
      icon: '🔄',
      gray: true,
      title: '备选模型（故障自动降级）',
      sub: '主模型失败后按顺序重试 · 留空不启用',
      body: `
    <div id="fallback-model-rows"></div>
    <div style="display:flex;gap:8px;margin-top:6px">
      <button class="btn btn-small" id="add-fallback-row-btn">＋ 添加备选模型</button>
    </div>`
    })}
    ${sc({
      id: 'card-api-price',
      icon: '💰',
      gray: true,
      title: '成本核算',
      sub: '官方价表 / 当前单价 / 批量自定义',
      body: `
    <div class="checkbox-row">${switchHtml('cfg-useofficialprice', c.api.useOfficialPrice !== false, '用内置官方价格表估算（按模型 id 自动匹配；走中转站请关掉）')}</div>

    <div class="field" style="margin-top:6px"><label>远程价格表</label>
      <div style="display:flex;align-items:center;gap:8px">
        <span class="muted">官网统一价格表</span>
        <button class="btn btn-small" id="price-feed-refresh-btn" title="从官网拉取最新价格表">拉取价格表</button>
      </div>
      <div class="hint" id="price-feed-status" style="margin-top:4px"></div>
    </div>

    <div class="price-card" id="model-price-card">
      <div class="pc-head">
        <span class="pc-title">当前模型单价</span>
        <span class="pc-model" id="pc-model">${esc(c.api.model || '（未选择模型）')}</span>
      </div>
      <div class="pc-rows">
        <div class="pc-row"><span class="pc-label">输入</span>
          <input type="number" id="cfg-price-in" step="0.01" min="0" value="0" /><span class="pc-unit">元/百万</span></div>
        <div class="pc-row"><span class="pc-label">输出</span>
          <input type="number" id="cfg-price-out" step="0.01" min="0" value="0" /><span class="pc-unit">元/百万</span></div>
        <div class="pc-row"><span class="pc-label">缓存命中</span>
          <input type="number" id="cfg-price-cached" step="0.01" min="0" value="0" /><span class="pc-unit">元/百万</span></div>
      </div>
      <div class="pc-note" id="pc-note"></div>
    </div>

    <div style="display:flex;gap:8px;margin:8px 0">
      <button class="btn btn-small" id="batch-price-btn">批量自定义价格编辑</button>
      <span class="muted" style="font-size:12px;align-self:center">为多个模型分别设定单价</span>
    </div>`
    })}`;
}


function renderSearchSection(c) {
  // 每个提供方区块的初始显隐都要跟当前 provider 一致
  const prov = String(c.webSearch?.provider || 'bing');
  // 自定义搜索提供商列表（可多个），用于动态生成下拉框选项
  const customProvs = Array.isArray(c.webSearch?.providers) ? c.webSearch.providers : [];
  return `
    <h3 id="settings-search">搜索服务</h3>
    <div class="hint" style="margin-bottom:12px">
      当前提供方：${prov === 'bing' ? 'Bing 网页解析' : prov === 'deepseek' ? 'DeepSeek 原生搜索' : prov === 'zhipu' ? '智谱 Web Search' : prov === 'bocha' ? '博查 AI Search' : prov === 'baidu' ? '百度千帆 AI Search' : prov === 'metaso' ? '秘塔 AI 搜索' : '自定义'}
      ${(() => {
        // 当前提供方已保存的 Key 状态（与模型 API 页同款提示口径）
        const keyState = {
          deepseek: c.webSearch?.deepseek?.hasApiKey,
          zhipu: c.webSearch?.zhipu?.hasApiKey,
          bocha: c.webSearch?.bocha?.hasApiKey,
          baidu: c.webSearch?.baidu?.hasApiKey,
          metaso: c.webSearch?.metaso?.hasApiKey
        }[prov];
        if (prov === 'bing') return ' · 无需 API Key';
        if (prov?.startsWith('custom:')) return '';
        return keyState ? ' · 已保存 API Key（不显示）' : ' · 未保存 API Key';
      })()}
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-websearch" ${c.webSearch?.enabled !== false ? 'checked' : ''} />
      <label for="cfg-websearch">联网搜索：启用 web_search / web_fetch 工具</label></div>
    <div class="field"><label>搜索提供方</label>
      <select id="cfg-searchprovider">
        <option value="bing" ${prov === 'bing' ? 'selected' : ''}>Bing 网页解析</option>
        <option value="deepseek" ${prov === 'deepseek' ? 'selected' : ''}>DeepSeek 原生搜索</option>
        <option value="zhipu" ${prov === 'zhipu' ? 'selected' : ''}>智谱 Web Search</option>
        <option value="bocha" ${prov === 'bocha' ? 'selected' : ''}>博查 AI Search</option>
        <option value="baidu" ${prov === 'baidu' ? 'selected' : ''}>百度千帆 AI Search</option>
        <option value="metaso" ${prov === 'metaso' ? 'selected' : ''}>秘塔 AI 搜索</option>
        ${customProvs.map((p) => `<option value="custom:${esc(p.id)}" ${prov === `custom:${p.id}` ? 'selected' : ''}>${esc(p.name || p.baseUrl)}（自定义 · ${p.type === 'bing' ? '网页解析' : 'JSON 接口'}）</option>`).join('')}
      </select></div>
    <div class="field" id="custom-provider-manage" style="${prov.startsWith('custom:') ? '' : 'display:none'}">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
        <button class="btn btn-small" id="test-search-provider-btn">测试这个搜索服务</button>
        <button class="btn btn-small btn-danger" id="del-search-provider-btn">删除这个搜索服务</button>
        <span id="search-provider-action-hint" class="muted" style="font-size:12px"></span>
      </div>
      <label>API Key${(() => {
        const cp = customProvs.find((p) => `custom:${p.id}` === prov);
        return cp?.hasApiKey ? '（已保存，可查看/替换/清除）' : '（未保存；多数自建服务留空即可）';
      })()}</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-custom-sp-key" value="${esc(customProvs.find((p) => `custom:${p.id}` === prov)?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-custom-sp-key-toggle" type="button">显示</button>
        <button class="btn btn-small btn-danger" id="cfg-custom-sp-key-clear" type="button" title="清除已保存的 API Key（留空保存并不会清除，必须点这个按钮）">清除密钥</button>
      </div>
    </div>
    <div class="field" id="bing-search-fields" style="${prov === 'bing' ? '' : 'display:none'}"><label>搜索地址（高级：可替换为兼容 Bing 结果格式的引擎）</label><input type="text" id="cfg-searchurl" value="${esc(c.webSearch?.searchUrl || 'https://cn.bing.com/search')}" /></div>
    <div class="field-row" id="deepseek-search-fields" style="${prov === 'deepseek' ? '' : 'display:none'}">
      <div class="field"><label>DeepSeek 搜索 API Key（留空用环境变量 DEEPSEEK_API_KEY）</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-ds-searchkey" value="${esc(c.webSearch?.deepseek?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="cfg-ds-searchkey-toggle" type="button">显示</button>
          <button class="btn btn-small btn-danger" id="cfg-ds-searchkey-clear" type="button" title="清除已保存的 API Key（留空保存并不会清除，必须点这个按钮）">清除密钥</button>
        </div></div>
      <div class="field"><label>模型</label><input type="text" id="cfg-ds-searchmodel" value="${esc(c.webSearch?.deepseek?.model || 'deepseek-v4-flash')}" /></div>
    </div>
    <div class="field-row" id="zhipu-search-fields" style="${prov === 'zhipu' ? '' : 'display:none'}">
      <div class="field"><label>智谱 API Key（留空用环境变量 ZHIPU_API_KEY）</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-zhipu-key" value="${esc(c.webSearch?.zhipu?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="cfg-zhipu-key-toggle" type="button">显示</button>
          <button class="btn btn-small btn-danger" id="cfg-zhipu-key-clear" type="button" title="清除已保存的 API Key（留空保存并不会清除，必须点这个按钮）">清除密钥</button>
        </div></div>
      <div class="field"><label>搜索引擎</label>
        <select id="cfg-zhipu-engine">
          <option value="search_std" ${c.webSearch?.zhipu?.engine === 'search_std' ? 'selected' : ''}>基础版 ¥0.01/次</option>
          <option value="search_pro" ${c.webSearch?.zhipu?.engine === 'search_pro' ? 'selected' : ''}>高级版 ¥0.03/次</option>
          <option value="search_pro_sogou" ${c.webSearch?.zhipu?.engine === 'search_pro_sogou' ? 'selected' : ''}>搜狗版 ¥0.05/次</option>
          <option value="search_pro_quark" ${c.webSearch?.zhipu?.engine === 'search_pro_quark' ? 'selected' : ''}>夸克版 ¥0.05/次</option>
        </select></div>
    </div>
    <div class="field" id="bocha-search-fields" style="${prov === 'bocha' ? '' : 'display:none'}">
      <label>博查 API Key</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-bocha-key" value="${esc(c.webSearch?.bocha?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-bocha-key-toggle" type="button">显示</button>
        <button class="btn btn-small btn-danger" id="cfg-bocha-key-clear" type="button" title="清除已保存的 API Key（留空保存并不会清除，必须点这个按钮）">清除密钥</button>
      </div></div>
    <div class="field" id="baidu-search-fields" style="${prov === 'baidu' ? '' : 'display:none'}">
      <label>百度千帆 API Key（留空用环境变量 BAIDU_SEARCH_API_KEY）</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-baidu-key" value="${esc(c.webSearch?.baidu?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-baidu-key-toggle" type="button">显示</button>
        <button class="btn btn-small btn-danger" id="cfg-baidu-key-clear" type="button" title="清除已保存的 API Key（留空保存并不会清除，必须点这个按钮）">清除密钥</button>
      </div></div>
    <div class="field" id="metaso-search-fields" style="${prov === 'metaso' ? '' : 'display:none'}">
      <label>秘塔 API Key（可选，留空用官方免费额度 / 环境变量 METASO_API_KEY）</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-metaso-key" value="${esc(c.webSearch?.metaso?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-metaso-key-toggle" type="button">显示</button>
        <button class="btn btn-small btn-danger" id="cfg-metaso-key-clear" type="button" title="清除已保存的 API Key（留空保存并不会清除，必须点这个按钮）">清除密钥</button>
      </div></div>

    <h3>添加自定义搜索服务</h3>
    <div class="field-row">
      <div class="field"><label>名称（自己辨认用）</label>
        <input type="text" id="new-sp-name" placeholder="例如：自建 SearXNG" /></div>
      <div class="field"><label>类型</label>
        <select id="new-sp-type">
          <option value="openai">JSON 搜索接口（POST）</option>
          <option value="bing">网页解析（Bing 结果格式）</option>
        </select></div>
    </div>
    <div class="field"><label>接口地址 / 搜索页地址</label>
      <input type="text" id="new-sp-baseurl" placeholder="JSON 类型：https://your-search.example.com/search；网页类型：https://your-searx.example.com/search" style="width:100%" /></div>
    <div class="field-row">
      <div class="field"><label>API Key（可选）</label>
        <input type="password" id="new-sp-apikey" placeholder="多数自建服务留空即可" autocomplete="new-password" style="width:100%" /></div>
      <div class="field"><label>模型名（可选）</label>
        <input type="text" id="new-sp-model" placeholder="Responses API 风格才需要" /></div>
    </div>
    <div style="display:flex;gap:8px;align-items:center;margin:8px 0">
      <button class="btn btn-small" id="add-search-provider-btn">＋ 添加并选中</button>
      <span id="add-search-provider-hint" class="muted" style="font-size:12px"></span>
    </div>
  `;
}

function renderMemorySettingsSection(c) {
  const mem = c.memory || {};
  const providers = state.providers || [];
  const useChat = mem.useChatModel !== false;
  const selP = providers.find((p) => p.id === mem.provider);
  const currentDisplay = selP ? `${selP.displayName || selP.id} · ${mem.model || '未选模型'}` : (mem.model || '未选模型');
  return `
    <h3 id="settings-memory">记忆整理</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-mem-consolidate" ${mem.consolidateEnabled !== false ? 'checked' : ''} />
      <label for="cfg-mem-consolidate">启用记忆自动整理</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-mem-usechat" ${useChat ? 'checked' : ''} />
      <label for="cfg-mem-usechat">使用与聊天机器人相同的模型</label></div>
    <div id="mem-model-box" style="${useChat ? 'display:none' : ''}">
      <div class="field"><label>记忆整理模型（点击选择）</label>
        <div style="display:flex;gap:8px">
          <input type="text" id="cfg-mem-model-pick" readonly placeholder="点击选择模型" value="${esc(currentDisplay)}" style="flex:1;cursor:pointer" />
        </div>
        <div class="hint" id="mem-model-hint">${selP ? `当前：${esc(selP.displayName)} @ ${esc(selP.baseURL)}` : '尚未选择专用模型'}</div>
        <input type="hidden" id="cfg-mem-provider" value="${esc(mem.provider || '')}" />
        <input type="hidden" id="cfg-mem-model" value="${esc(mem.model || '')}" />
      </div>
    </div>
    <div class="field"><label>整理冷却时间（毫秒）</label><input type="number" id="cfg-mem-interval" min="1800000" step="600000" value="${esc(mem.consolidateMinIntervalMs ?? 21600000)}" /></div>
    <div class="hint">条数超过阈值且距上次整理超过该冷却时间后，才会在运行结束后后台整理。默认 6 小时（21600000 毫秒）。</div>`;
}

function renderPersonaSection(c) {
  // 2026-10-21 改版：人设只有一处编辑入口 —— 会话面板。
  //   · 「默认设置」里编辑 = 全局默认（含按会话未覆盖的字段）
  //   · 某个会话里编辑 = 本会话覆盖（跟随默认的学说在 saveConfig 里用 diff 处理）
  // botName / selfNickname 是账号身份（@ 判定 / 存档称呼依赖），只在默认设置里可改。
  const isDefault = state.settingsView === 'session' && state.settingsScope === 'default';
  const identityRow = isDefault ? `
    <div class="field-row">
      <div class="field"><label>机器人名字</label><input type="text" id="cfg-botname" value="${esc(c.persona.botName)}" /></div>
      <div class="field"><label>群内展示名（可选）</label><input type="text" id="cfg-selfnick" value="${esc(c.persona.selfNickname || '')}" /></div>
    </div>` : `
    <div class="hint" style="margin-bottom:10px">机器人名字 / 群内展示名是账号身份，只能在「默认设置」里改（改了会影响 @ 判定与存档称呼）。</div>`;
  return `
    <h3>人设</h3>
    ${identityRow}
    ${renderPersonaPicker(c)}
    <div class="field-row">
      <div class="field"><label>参与度</label>
        <select id="cfg-participation">
          <option value="low" ${c.persona.participation === 'low' ? 'selected' : ''}>安静型</option>
          <option value="medium" ${c.persona.participation === 'medium' ? 'selected' : ''}>普通群友</option>
          <option value="high" ${c.persona.participation === 'high' ? 'selected' : ''}>活跃型</option>
        </select></div>
    </div>
    <div class="field"><label>角色设定</label>
      <textarea id="cfg-roletext" class="persona-role-text" placeholder="例如：你是运维群里的老油条……">${esc(c.persona.roleText || '')}</textarea></div>
    <div class="field"><label>管理员附加规则（可选，追加到系统提示）</label>
      <textarea id="cfg-customrules" class="persona-role-text" style="min-height:100px">${esc(c.persona.customRules || '')}</textarea></div>
    <div class="field">
      <label>系统提示词覆盖（高级 · 可选）</label>
      <textarea id="cfg-sysprompt" class="persona-role-text" style="min-height:120px" placeholder="留空 = 使用内置默认系统提示词（含安全规则/工具协议/反AI味等）。填写后将整体替换默认行为准则。">${esc(c.persona.systemPromptOverride || '')}</textarea>
      <div class="hint">
        ⚠️ 高级功能：填写后会<b>整体替换</b>内置系统提示词，默认的安全规则、工具协议、反 AI 味等约束全部失效（需自行在覆盖文本里写明）。
        可用占位符：<code>{botName}</code> <code>{roleText}</code> <code>{participation}</code>。留空则完全不影响现有行为。
      </div>
    </div>`;
}

// 表情包积极程度档位：[值, 显示名]
const STICKER_LEVELS = [
  [0, '0 · 不鼓励（只在很贴切时偶尔用）'],
  [1, '1 · 偶尔（合适时配一张）'],
  [2, '2 · 较积极（优先考虑配图）'],
  [3, '3 · 很积极（表情包爱好者）']
];

// 读取历史档位：名称与说明（档位制，累积生效）
/** 把输入钳制到 [min,max]，非法值退回 fallback。 */
/**
 * 取会话的群名（群聊才有）。
 * 群名由后端 /api/chats 附带（走 OneBot get_group_info，带缓存与超时保护），
 * 拿不到就返回空串 —— 调用方会自动退回只显示群号。
 */
function chatNameOf(chatKey) {
  const c = (state.chats || []).find((x) => x.key === chatKey);
  return String(c?.chatName || '').trim();
}

/**
 * 会话标题：群名 / 私聊昵称
 * 侧栏只显示名字（过长由 CSS 省略号截断），不拼群号 —— 拼了会被挤爆。
 * 拿不到名字时才退回「群 123 / 私聊 123」兜底。
 */
function formatChatTitle(chatKey, name = '') {
  const n = String(name || '').trim();
  if (n) return n;
  const m = /^group:(\d+)$/.exec(String(chatKey || ''));
  if (m) return `群 ${m[1]}`;
  const p = /^private:(\d+)$/.exec(String(chatKey || ''));
  if (p) return `私聊 ${p[1]}`;
  return String(chatKey || '');
}

/** 详情页标题：名字 + 号（需要确认身份时用） */
function formatChatTitleWithId(chatKey, name = '') {
  const m = /^group:(\d+)$/.exec(String(chatKey || ''));
  if (m) return name ? `${name}（${m[1]}）` : `群 ${m[1]}`;
  const p = /^private:(\d+)$/.exec(String(chatKey || ''));
  if (p) return name ? `${name}（${p[1]}）` : `私聊 ${p[1]}`;
  return formatChatTitle(chatKey, name);
}

/**
 * 群名补底缓存（id → 群名）：/api/onebot/groups 的群列表名字。
 * 没有消息存档的白名单群在 /api/chats 里查不到名字，分群按钮会退化成「群 <号>」，
 * 不方便辨识 —— 这里用 OneBot 群列表把名字补齐。
 */
async function loadQqGroupNames() {
  if (state.qqGroupNamesLoading) return state.qqGroupNames || {};
  state.qqGroupNamesLoading = true;
  try {
    const data = await api('/api/onebot/groups');
    state.qqGroupNames = state.qqGroupNames || {};
    for (const g of data.groups || []) {
      const id = String(g?.id ?? '').trim();
      const name = String(g?.name ?? '').trim();
      if (id && name) state.qqGroupNames[id] = name;
    }
  } catch { /* OneBot 未连接时静默：退回群号兜底 */ }
  finally { state.qqGroupNamesLoading = false; }
  return state.qqGroupNames || {};
}

/** 分群场景的群显示名：**仅群名**（拿不到才退回「群 <号>」兜底）。 */
function groupDisplayName(gid) {
  const id = String(gid ?? '').trim();
  const n = chatNameOf(`group:${id}`) || String(state.qqGroupNames?.[id] || '').trim();
  return n || `群 ${id}`;
}

function clampInt(raw, min, max, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/*
 * 滑条换算（前端显示用）。
 *
 * 换算逻辑来自 /vendor/tier-slider.js（与 src/tier-slider.js 同一份镜像）。
 * 后端保存配置时会用它**重新权威换算**档位与概率，前端这里只负责界面即时反馈。
 * 下面的 sliderToTierUI / sliderToTierUI_tierToSlider 是对共享函数的薄封装，
 * 保持既有调用点签名不变。
 */
function sliderToTierUI(pos) {
  return sliderToTier(pos);
}

/** 已保存配置 → 滑条位置（优先用存下来的位置，老配置没有就从 tier/概率反推）。 */
function sliderToTierUI_tierToSlider(st) {
  const saved = Number(st?.contextSliderPos);
  if (Number.isFinite(saved)) return Math.min(100, Math.max(0, saved));
  return tierToSlider(st?.contextTier, st?.randomPercent);
}

/** 滑条位置 → 一句话说明（给用户的即时反馈）。 */
function sliderDesc(pos) {
  const { tier, randomPercent } = sliderToTierUI(pos);
  if (tier === 1) return '<b>1 档 · 仅艾特</b>：只有被 @ 时才响应，其余消息标记已读、不调模型（最省）';
  if (tier === 2) return '<b>2 档 · +关键词</b>：被 @ 或命中关键词时响应';
  // 3 档概率展示必须与后端判定同源：resolveContextTier 用 Math.random()*100 与
  // randomPercent 比较（即"骰子值 < 阈值"），滑条换算出的 randomPercent 就是这个阈值。
  // 之前这里展示的是 sliderToTier 的 randomPercent 四舍五入值，而后端在保存时会
  // 重新权威换算一次 —— 两边都来自同一公式，但旧版 desc 里取整方式不同导致偶发不一致，
  // 现在统一保留一位小数（与 sliderToTier 一致）。
  if (tier === 3) return `<b>3 档 · +随机</b>：被 @ / 关键词必响应；此外每批普通消息有 <b>${randomPercent}%</b> 概率响应`;
  return '<b>4 档 · 全响应</b>：任何消息都响应，且艾特/关键词/随机的判定全部失效';
}

const TIER_NAME = { 1: '仅艾特', 2: '+关键词', 3: '+随机', 4: '全响应' };

/** 滑条位置 → 纯文本档位名（无 HTML 标签，供双点滑条说明文字使用）。 */
function sliderDescText(pos) {
  const { tier, randomPercent } = sliderToTierUI(pos);
  if (tier === 3) return `3 档 · +随机（${randomPercent}%）`;
  return `${tier} 档 · ${TIER_NAME[tier]}`;
}
const TIER_HINT = {
  1: '只有被 @ 时才响应，其余消息标记已读、不调模型（最省 token）',
  2: '在 1 档基础上，命中关键词也响应',
  3: '在 2 档基础上，再按概率随机响应一些消息',
  4: '任何消息都响应（改造前的行为，最费 token）'
};

function renderChatSection(c) {
  const st = c.store || {};
  const fold = (typeof setCard === 'function') ? setCard : (o) => `<div class="setcard">${o.body}</div>`;
  // 活跃设置：触发条件 + 回复概率（2026-10-21 改版），峰谷作为附加维度。
  const actBase = triggerFromStoreUI(st);
  const actPeakOn = st.peakSchedule?.enabled === true;
  const actPeak = actPeakOn ? peakTriggerFromStoreUI(st.peakSchedule) : null;
  const actSummary = actPeakOn
    ? `峰 ${triggerSummaryUI(actPeak.trigger, actPeak.probability)} / 其余 ${triggerSummaryUI(actBase.trigger, actBase.probability)}`
    : triggerSummaryUI(actBase.trigger, actBase.probability);
return `
    <h3>聊天设置</h3>
    ${fold({
      id: 'card-send-config',
      icon: '📨',
      title: '信息发送配置',
      sub: '温度 / 思考 / 节奏 / 发送限流',
      body: `
      <div class="field-row">
        <div class="field"><label>温度</label><input type="number" id="sc-temperature" step="0.1" min="0" max="2" value="${esc(c.api?.temperature ?? 0.8)}" /></div>
        <div class="field"><label>单次运行最大工具轮数</label><input type="number" id="sc-maxrounds" min="1" max="40" value="${esc(c.api?.maxRounds ?? 12)}" /></div>
      </div>
      <div class="field"><label>思考强度</label>
        <select id="sc-thinking-effort">
          ${[
            ['off', '关（不思考，明确关闭）'],
            ['', '默认（跟随模型/网关）'],
            ['on-noeffort', '开（明确开启，不指定强度）'],
            ['low', '低（快、省 token）'],
            ['medium', '中'],
            ['high', '高（慢、细致）'],
            ['xhigh', '超高（更慢、更深入）'],
            ['max', '拉满（最强推理）']
          ].map(([v, l]) => {
            const eff = c.api?.thinkingEffort || '';
            const mode = c.api?.thinkingMode || 'auto';
            // (mode, effort) 二维状态压成一维下拉：off 优先，其次 effort 档；
            // "on 但没指定强度"是独立档 on-noeffort（不能折叠进"默认"——
            // 那样一次保存会把明确开启改写成 auto，见 saveConfig chat 分支）。
            const sel = mode === 'off' ? 'off' : (eff || (mode === 'on' ? 'on-noeffort' : ''));
            return `<option value="${v}" ${sel === v ? 'selected' : ''}>${l}</option>`;
          }).join('')}
        </select>
        <div class="hint">内置落成各厂商思考参数（off~max 六档）；渠道不支持高档时向下就近映射。</div></div>
      <div class="field-row">
        <div class="field"><label>防抖聚批窗口（毫秒）</label><input type="number" id="sc-wakedelay" min="0" value="${esc(c.wakeDelayMs)}" /></div>
        <div class="field"><label>批次间隔（毫秒）</label><input type="number" id="sc-draindelay" min="0" value="${esc(c.drainDelayMs)}" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>同时处理几个会话</label><input type="number" id="sc-maxruns" min="1" max="8" value="${esc(c.maxConcurrentRuns)}" /></div>
        <div class="field"><label>失败自动重试次数</label><input type="number" id="sc-sessionretry" min="0" max="5" value="${esc(c.sessionRetryAttempts ?? 2)}" />
          <div class="hint">0 = 关闭。已发出过消息的会话绝不自动重试。</div></div>
      </div>
      <div class="field-row">
        <div class="field"><label>相邻消息最小间隔（毫秒）</label><input type="number" id="sc-mingap" min="200" value="${esc(c.send?.minGapMs ?? 1000)}" /></div>
        <div class="field"><label>最大间隔（毫秒）</label><input type="number" id="sc-maxgap" min="500" value="${esc(c.send?.maxGapMs ?? 3000)}" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>每分钟最多发送</label><input type="number" id="sc-maxpermin" min="1" value="${esc(c.send?.maxPerMinute ?? 80)}" /></div>
        <div class="field"><label>每小时最多发送</label><input type="number" id="sc-maxperhour" min="1" value="${esc(c.send?.maxPerHour ?? 500)}" /></div>
      </div>
      <div class="hint">改动即时生效（自动保存），无需单独点保存。</div>`
    })}
    ${fold({
      id: 'card-active-config',
      icon: '⚡',
      title: '活跃设置',
      sub: '触发条件 / 回复概率 / 峰谷',
      val: actSummary,
      extra: `<span class="ac-head-controls"><span class="ac-head-div"></span>
        <div class="btn ac-peak-btn" id="ac-peak-btn" role="button" tabindex="0" title="点击设置高峰时段（星期 / 开始结束 / 高峰触发条件）">
          <span>🌅 峰谷时段</span>
          <label class="switch ac-peak-switch" title="启用 / 停用峰谷切换（高峰用高峰设置，其余时间用主面板设置）"><input type="checkbox" id="ac-peak-enabled" ${st.peakSchedule?.enabled === true ? 'checked' : ''} /><span class="track"><span class="thumb"></span></span></label>
        </div>
        <button class="btn" id="ac-tier-params-btn" title="档位参数：历史条数 / 关键词表 / 被召唤后持续参与">⚙ 档位参数</button>
      </span>`,
      open: true,
      body: `<div id="ac-editor"></div>`
    })}

    ${fold({
      id: 'card-cmdmute',
      icon: '🔇',
      title: '指令禁言',
      sub: '被 @ 附带指令就安静一段时间',
      open: false,
      body: `
      <div class="field-row">
        <div class="field"><label>禁言指令（需与 @机器人 同条消息）</label>
          <input type="text" id="ac-cmdmute-command" value="${esc(c.commandMute?.command || '/安静')}" placeholder="如 /安静" /></div>
        <div class="field"><label>禁言时长（分钟，0 = 直到手动解除）</label>
          <input type="number" id="ac-cmdmute-duration" min="0" value="${esc(Number(c.commandMute?.durationMin ?? 30))}" /></div>
      </div>
      <div class="checkbox-row"><input type="checkbox" id="ac-cmdmute-enabled" ${c.commandMute?.enabled !== false ? 'checked' : ''} />
        <label for="ac-cmdmute-enabled">启用指令禁言</label></div>
      <div class="hint">改动即时生效（自动保存），无需单独点保存。</div>`
    })}

    ${fold({
      id: 'card-proactive',
      icon: '💬',
      title: '主动开话题',
      sub: '冷场时按概率主动开话题',
      body: `
      <div class="checkbox-row"><input type="checkbox" id="cfg-proactive" ${c.proactive.enabled ? 'checked' : ''} />
        <label for="cfg-proactive">冷场时按概率主动开话题</label></div>
      <div class="field-row">
        <div class="field"><label>检查间隔下限（毫秒）</label><input type="number" id="cfg-pro-min" min="60000" value="${esc(c.proactive.checkIntervalMinMs)}" /></div>
        <div class="field"><label>检查间隔上限（毫秒）</label><input type="number" id="cfg-pro-max" min="120000" value="${esc(c.proactive.checkIntervalMaxMs)}" /></div>
        <div class="field"><label>触发概率 0~1</label><input type="number" id="cfg-pro-prob" step="0.05" min="0" max="1" value="${esc(c.proactive.probability)}" /></div>
      </div>`
    })}

    ${fold({
      id: 'card-sticker',
      icon: '😄',
      title: '表情包',
      sub: '收藏表情同步 / 发送积极度 / 提示词列举数',
      body: `
      <div class="checkbox-row"><input type="checkbox" id="cfg-sticker" ${c.sticker.enabled ? 'checked' : ''} />
        <label for="cfg-sticker">启用表情包（收藏表情同步 + 发送工具）</label></div>
      <div class="field">
        <label>发表情包的积极程度</label>
        <select id="cfg-sticker-encourage">
          ${STICKER_LEVELS.map(([v, label], i) =>
            `<option value="${v}" ${Number(c.sticker?.encourage ?? 1) === v ? 'selected' : ''}>${esc(label)}</option>`
          ).join('')}
        </select>
        <div class="hint">
          这是"引导"不是"强制"，模型仍会自行判断什么时机合适。
        </div>
      </div>
      <div class="field">
        <label>提示词里列举的表情包数量（1~50）</label>
        <input type="number" id="cfg-sticker-promptmax" min="1" max="50" value="${esc(Number(c.sticker?.promptMaxStickers) || 10)}" />
        <div class="hint">
          每次唤醒时，系统会把收藏表里最多这么多个表情包列进提示词供模型挑选。
          列得越多模型选择越丰富，但 token 成本也越高；收藏很多时适当调大，收藏少或想省 token 就调小。
        </div>
      </div>`
    })}

    <div class="field" style="margin-top:14px">
      <button class="btn" id="blocklist-btn" style="height:44px;padding:0 28px;font-size:14px">管理屏蔽名单</button>
    </div>`;
}

/**
 * 「安全与准入」（全局）：替代旧「聊天白名单」页。
 *   · acceptAllSessions：唯一准入开关 —— 关闭时只有被添加到会话个性化的会话与机器人交互
 *   · deny（黑名单）继续全局生效
 * 一键下线/上线（暂停/恢复）是运行态操作，在顶栏，不属于配置。
 */
function renderSecuritySection(c) {
  const deny = c.deny || {};
  return `
    <h3 id="settings-security">安全与准入</h3>
    <p class="setsub">谁来跟机器人说话、哪些 ID 一律拉黑 —— 全局生效，与具体会话无关</p>
    <div class="checkbox-row"><input type="checkbox" id="cfg-accept-all" ${c.acceptAllSessions === true ? 'checked' : ''} />
      <label for="cfg-accept-all">接受所有会话（未添加到左侧会话列表的群/私聊也响应，走默认设置）</label></div>
    <div class="hint" style="margin-top:6px">未勾选时，只有被添加进左侧会话列表的会话才会被服务；
      在左侧「添加会话」即等于允许该会话。一键全线下线/上线用顶栏的「下线/上线」按钮。</div>
    <div class="field"><label>群聊黑名单（群号，逗号分隔；留空 = 不拉黑）</label>
      <input type="text" id="cfg-deny-groups" value="${esc((deny.groups || []).join(','))}" /></div>
    <div class="field"><label>私聊黑名单（QQ 号，逗号分隔；留空 = 不拉黑）</label>
      <input type="text" id="cfg-deny-private" value="${esc((deny.private || []).join(','))}" /></div>
    <div class="hint" style="margin-top:8px">黑名单优先于"接受所有会话"：名单内的 ID 永远不响应、不存档。
      屏蔽"某个群里的某个群友"请在对应会话的「聊天设置 → 屏蔽名单」里管理（按会话生效）。</div>`;
}

/**
 * 「系统与维护」（全局）：原「桌面端」页的功能保留件 —— 页面取消，设置按
 * 全局归类搬到这里（桌面自启/托盘、界面偏好、数据目录、版本更新）。
 */
function renderSystemSection(c) {
  return `
    <h3 id="settings-system">系统与维护</h3>
    <p class="setsub">进程行为 / 界面偏好 / 数据管理 / 版本更新 —— 全机生效</p>
    <h3 style="margin-top:4px">进程</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-autostart" ${c.server?.autoStart ? 'checked' : ''} />
      <label for="cfg-autostart">开机自启</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-closetray" ${c.server?.closeToTray !== false ? 'checked' : ''} />
      <label for="cfg-closetray">点关闭时最小化到托盘</label></div>
    <h3>界面</h3>
    <div class="field"><label>主题</label>
      <div class="theme-picker" id="theme-picker">
        ${['dark', 'light'].map((t) => `
          <div class="theme-option${getThemePref() === t ? ' on' : ''}" data-theme-opt="${t}" role="button" tabindex="0">
            <span class="t-ico">${THEME_ICON[t]}</span>
            <span>${THEME_LABEL[t]}</span>
          </div>`).join('')}
      </div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-showvision" ${c.ui?.showVision !== false ? 'checked' : ''} />
      <label for="cfg-showvision">模型目录显示“支持图片输入/不支持图片输入”徽标</label></div>
    <div class="field"><label>界面刷新间隔（毫秒）</label><input type="number" id="cfg-refreshms" min="1000" step="1000" value="${esc(c.ui?.refreshMs ?? 15000)}" /></div>
    <h3>数据管理</h3>
    <div class="field"><label>用户数据目录</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="cfg-datadir" readonly value="${esc(state.dataDir || '（加载中…）')}" style="flex:1" />
        <button class="btn btn-small" id="open-datadir-btn">打开文件夹</button>
      </div>
      <div class="hint">所有用户数据（配置、聊天记录、记忆、表情包）都存在这个目录里。删除后重启应用即为初始形态。</div>
    </div>
    <div class="field">
      <button class="btn btn-danger" id="reset-data-btn">重置为初始形态</button>
      <span class="hint" id="reset-data-hint" style="margin-left:10px"></span>
      <div class="hint" style="margin-top:6px">⚠️ 此操作会删除所有用户数据（配置、聊天记录、记忆、表情包），不可恢复。建议先备份。</div>
    </div>
    <h3>版本更新</h3>
    <div class="field"><label>当前版本 <b id="update-current">…</b><span id="update-status-text">${(typeof updateAvailable !== 'undefined' && updateAvailable) ? '<b style="color:var(--orange)">；发现新版本</b>' : '；检查线上是否有新版本'}</span></label>
      <div style="display:flex;gap:10px;align-items:center">
        <button class="btn btn-small" id="check-update-btn">检查更新</button>
        <span class="hint" id="update-hint" style="margin:0"></span>
      </div></div>`;
}

/** SnowLuma 页的「连接配置」卡片：全局字段，供 03-snowluma.js 渲染时引用。 */
const SNOWLUMA_CONNECT_FORM = (c) => `
  <div class="field"><label>SnowLuma 程序目录（留空 = 自动使用项目内 snowluma/ 文件夹）</label>
    <div style="display:flex;gap:8px">
      <input type="text" id="cfg-snowlumadir" value="${esc(c.snowluma.dir || '')}" style="flex:1" />
      <button class="btn btn-small" id="open-snowluma-btn">打开文件夹</button>
    </div>
    <div class="hint" id="snowluma-hint"></div></div>
  <div class="checkbox-row"><input type="checkbox" id="cfg-snowlumalaunch" ${c.snowluma.autoLaunch ? 'checked' : ''} />
    <label for="cfg-snowlumalaunch">QQ Agent 启动时自动拉起 SnowLuma（未运行时）</label></div>
  <div class="field-row">
    <div class="field"><label>WebSocket 地址（收消息）</label><input type="text" id="cfg-wsurl" value="${esc(c.snowluma.wsUrl)}" /></div>
    <div class="field"><label>HTTP 地址（发消息）</label><input type="text" id="cfg-httpurl" value="${esc(c.snowluma.httpUrl)}" /></div>
    <div class="field"><label>WebSocket 令牌</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-obtoken" value="${esc(c.snowluma?.hasAccessToken ? '******' : '')}" placeholder="输入新令牌可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-obtoken-toggle" type="button">显示</button>
      </div></div>
    <div class="field"><label>HTTP 令牌（与 WS 不同时填；SnowLuma 默认分开）</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-obhttptoken" value="${esc(c.snowluma?.hasHttpAccessToken ? '******' : '')}" placeholder="输入新令牌可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-obhttptoken-toggle" type="button">显示</button>
      </div></div>
  </div>
  <div class="hint">改完连接配置需要重启应用生效；其余设置即时生效。</div>`;

/**
 * 刷新 Skill 状态（后端判定结果）。
 * 单独抽出来是因为开关切换后需要立即重取，而不是等下一次 loadSettings。
 */
/**
 * 拉取技能/插件列表（内存态）。**不含磁盘重扫** —— 想让新放入的目录
 * 被看到，走 rescanSkills()。
 */
/**
 * 拉取技能/插件列表（内存态）。**不含磁盘重扫** —— 想让新放入的目录
 * 被看到，走 rescanSkills()。
 *
 * @param {{ chat?: string|null }} opts
 *   chat = 会话 key 时返回“该会话生效值”（仅会话管理 → 设置 → 工具与技能使用）；
 *   仓库页必须显式传 null（全局默认）—— 依赖 isSessionScope() 隐式判断会在
 *   离开会话管理后仍带着旧作用域，把仓库卡片错误地渲染成绿色。
 */
async function loadSkillsStatus({ chat = null } = {}) {
  try {
    const scope = chat ? `?chat=${encodeURIComponent(chat)}` : '';
    const data = await api(`/api/skills${scope}`);
    state.skills = data.skills || [];
    state.skillsSummary = data.summary || {};
    state.uninstalledSkills = data.uninstalled || [];
  } catch {
    /* 取不到就保持原值，不覆盖成空列表造成"条目都不见了"的假象 */
  }
}

/**
 * 重扫磁盘并刷新列表：技能/插件页「刷新」按钮的完整动作。
 * 之前刷新只重读内存注册表，后台文件监听一旦丢事件（目录删除重建、
 * 网络盘、杀毒软件），放进去的新插件无论点多少次刷新都看不到。
 * 现在先 POST /api/skills/reload 让后端真正重扫；接口不可用时退回
 * 普通列表拉取（不比旧行为差）。
 */
async function rescanSkills({ quiet = false } = {}) {
  try {
    const r = await api('/api/skills/reload', { method: 'POST' });
    if (r && r.skills) {
      state.skills = r.skills;
      state.skillsSummary = r.summary || {};
      // 重扫接口的响应没有 uninstalled 字段，补拉一次（很轻，还能顺带拿脱敏配置）
      await loadSkillsStatus();
      if (!quiet && r.failed?.length) {
        console.warn('[skill] 本次重扫失败条目：', r.failed);
      }
      return r;
    }
  } catch (e) {
    console.warn('[skill] 重扫请求失败：', e?.message || e);
  }
  await loadSkillsStatus();
  return null;
}

/**
 * 技能设置弹窗。
 *
 * 为什么把设置放在技能自己的弹窗里（而不是塞进设置页）：
 *   · 这些字段**只对这个技能有意义** —— 分散在全局设置页里，用户根本对不上号
 *   · 技能页本来就该是"这个技能能配什么"的唯一入口
 *   · 开关和设置放在一起，改完立刻能看到状态徽章变化
 *
 * 表单**完全按 manifest 的 configSchema 渲染**，前端不硬编码任何字段名 ——
 * 加一个新技能、加一个字段，这里一行都不用改。
 * 支持的 type：boolean（复选框）/ number（数字输入）/ enum（下拉）/ string（文本框）
 * 另外 secret: true 的字段用密码框，且留空 = 不修改（后端也按同一约定处理）。
 */
/**
 * 生成技能设置弹窗的 HTML（**纯函数**，不碰 DOM）。
 *
 * 拆出来的唯一目的是可测：这次改动的重点是视觉层级
 * （名字用等宽大字、介绍用正文小字、模态框加宽），
 * 埋在 DOM 操作里就只能靠肉眼看，改坏了没人发现。
 *
 * @returns {{ html: string } | { error: string }}
 */
function renderSkillSettingsModal(skill) {
  if (!skill) return { error: '技能不存在' };
  const skillId = skill.id;
  const schema = skill.configSchema || {};
  const values = skill.settings || {};
  // internal 字段（列表/对象类）不渲染成表单输入 —— 它们由专用界面管理。
  // 但仍然要在弹窗里列出来并说明去哪改，否则用户会以为"这个设置根本不存在"。
  const allKeys = Object.keys(schema);
  const internalKeys = allKeys.filter((k) => schema[k]?.type === 'internal');
  const keys = allKeys.filter((k) => schema[k]?.type !== 'internal');
  if (!allKeys.length) return { error: '这个技能没有可配置项' };

  const fieldHtml = (key) => {
    const d = schema[key] || {};
    const v = values[key] ?? d.default ?? '';
    const label = esc(d.label || key);
    const hint = d.description ? `<div class="hint">${esc(d.description)}</div>` : '';
    const id = `skset-${esc(skillId)}-${esc(key)}`;
    // secret：用密码框 + 占位符提示"留空不改"，避免把脱敏值当明文回填
    const isSecret = d.secret === true;
    // 长文本字段跨整行：窄列里换行会碎成一条，读起来很累
    const isWide = d.type === 'string' && (d.multiline === true || String(d.description || '').length > 60);
    const cls = 'field' + (isWide ? ' field--wide' : '');
    let input;
    if (d.type === 'boolean') {
      // 整行做成可点区域：单摆一个小复选框在宽弹窗里像没渲染完
      input = `<label class="skill-toggle-row">
        <input type="checkbox" id="${id}" data-key="${esc(key)}" data-type="boolean" ${v ? 'checked' : ''} />
        <span class="st-text">${v ? '已开启' : '已关闭'}</span>
      </label>`;
    } else if (d.type === 'number') {
      input = `<input type="number" id="${id}" data-key="${esc(key)}" data-type="number" value="${esc(v)}" step="any" />`;
    } else if (d.type === 'enum' && Array.isArray(d.values)) {
      // 枚举渲染成下拉：值写错会让技能行为异常，下拉从根上避免手抖
      input = `<select id="${id}" data-key="${esc(key)}" data-type="enum">${
        d.values.map((x) => `<option value="${esc(x)}" ${String(v) === String(x) ? 'selected' : ''}>${esc(x)}</option>`).join('')
      }</select>`;
    } else {
      input = `<input type="${isSecret ? 'password' : 'text'}" id="${id}" data-key="${esc(key)}" data-type="string" value="${isSecret ? '' : esc(v)}" placeholder="${isSecret ? (v ? '已设置（留空 = 不修改）' : '未设置') : ''}" autocomplete="off" />`;
    }
    return `<div class="${cls}"><label>${label}${d.required ? ' <span class="req">*</span>' : ''}${d.secret ? ' 🔒' : ''}</label>${input}${hint}</div>`;
  };

  return { html: `<div class="modal skill-modal" role="dialog" aria-modal="true" aria-label="${esc(skill.name)} 设置">
    <div class="skill-modal__head">
      <div class="skill-modal__titles">
        <div class="skill-modal__name">
          ${esc(skill.name)}
          <span class="skill-modal__ver">v${esc(skill.version || '')}</span>
        </div>
        <div class="skill-modal__id">${esc(skillId)}</div>
        <div class="skill-modal__desc">${esc(skill.description || '（这个技能没有写介绍）')}</div>
      </div>
      <button class="icon-btn" id="skset-x" title="关闭" aria-label="关闭">✕</button>
    </div>
    <div class="skill-modal__body">
      <div class="skill-modal__note">
        共 <b>${keys.length}</b> 项设置 · 保存在 <code>config.skills['${esc(skillId)}']</code>，只有这个技能会读到它们。
      </div>
      <div class="skill-form">${keys.map(fieldHtml).join('')}</div>
      ${internalKeys.length ? `<div class="skill-modal__internal">
        <div class="skill-modal__internal-head">以下设置不在这里改</div>
        ${internalKeys.map((k) => `<div class="skill-modal__internal-item"><b>${esc(schema[k].label || k)}</b><br />${esc(schema[k].description || '')}</div>`).join('')}
      </div>` : ''}
    </div>
    <div class="skill-modal__foot">
      <span class="skill-modal__foot-tip">改动即时生效，无需重启</span>
      <span class="spacer"></span>
      <button class="btn btn-small" id="skset-cancel">取消</button>
      <button class="btn btn-primary" id="skset-save">保存</button>
    </div>
  </div>` };
}

/** 打开某个技能的设置弹窗。 */
function openSkillSettings(skillId) {
  const skill = (state.skills || []).find((x) => x.id === skillId);
  if (!skill) return;
  const built = renderSkillSettingsModal(skill);
  if (built.error) { alert(built.error); return; }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = built.html;
  document.body.appendChild(overlay);

  const close = () => closeAnimatedOverlay(overlay);
  overlay.querySelector('#skset-x').addEventListener('click', close);
  overlay.querySelector('#skset-cancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  // Esc 关闭：弹窗大了以后鼠标要移很远，键盘出口是必需的
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  overlay.setAttribute('tabindex', '-1');
  overlay.focus();

  // 复选框旁边的"已开启/已关闭"文字要跟着变，否则看不出当前状态
  overlay.querySelectorAll('input[type="checkbox"][data-type="boolean"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const span = cb.parentElement?.querySelector('.st-text');
      if (span) span.textContent = cb.checked ? '已开启' : '已关闭';
    });
  });

  overlay.querySelector('#skset-save').addEventListener('click', async () => {
    const schema = skill.configSchema || {};
    const missing = [...overlay.querySelectorAll('[data-key]')].filter((el) => {
      const d = schema[el.dataset.key] || {};
      if (!d.required || d.type === 'boolean') return false;
      return String(el.value ?? '').trim() === '';
    });
    if (missing.length) {
      alert(`必填项不能为空：${missing.map((el) => schema[el.dataset.key]?.label || el.dataset.key).join('、')}`);
      return;
    }
    const settings = {};
    overlay.querySelectorAll('[data-key]').forEach((el) => {
      const key = el.dataset.key;
      const type = el.dataset.type;
      if (type === 'boolean') settings[key] = el.checked;
      else if (type === 'number') {
        const n = Number(el.value);
        // 空值/非数字：不提交这个键，让后端保留原值（而不是写进一个 NaN）
        if (el.value.trim() !== '' && Number.isFinite(n)) settings[key] = n;
      } else if (type === 'enum') settings[key] = el.value;
      else settings[key] = el.value;   // secret 留空 → 后端按"不修改"处理
    });
    try {
      const r = await api(`/api/skills/${encodeURIComponent(skillId)}`, {
        method: 'POST',
        body: JSON.stringify({ settings })
      });
      const idx = (state.skills || []).findIndex((x) => x.id === skillId);
      if (idx >= 0 && r.skill) {
        // 后端返回的是 status 视图；把设置与 schema 合并回去，避免卡片丢掉这两项
        state.skills[idx] = { ...state.skills[idx], ...r.skill, settings: r.settings || {}, configSchema: state.skills[idx].configSchema };
      }
      if (r.config) state.config = r.config;
      await loadSkillsStatus();
      // 两页都重绘：设置弹窗可能从技能页或插件页打开，
      // 而改动会同时影响状态徽章。重绘代价可忽略（每页最多十来张卡片）。
      renderModulePage('skill');
      renderModulePage('plugin');
      close();
    } catch (err) {
      alert(`保存失败：${err.message}`);
    }
  });
}

/**
 * 扩展页（技能 / 插件）
 *
 * 两型在**代码里完全同构**（同一条加载器、同一套清单字段、同一个开关），
 * 唯一的区别是"谁决定何时执行"：
 *   skill  （LLM 型）  —— 注册工具，模型看了 description 自己决定调不调
 *   plugin （确定性型）—— 提供能力/钩子，核心代码按能力名确定性调用，必然执行
 *
 * 这件事对使用者太重要了（决定"这个功能会不会被模型忽略"），所以拆成两个页签，
 * 但渲染逻辑共用一份 —— 否则两页的卡片、分组、开关行为迟早会分叉。
 *
 * ⚠️ 状态一律用后端 /api/skills 的判定结果，前端**不自己推断**能不能用 ——
 * 否则又会出现"界面说能用、实际不生效"的两套口径。
 */
const MODULE_KINDS = {
  skill: {
    kind: 'skill',
    tab: 'skills',
    boxSel: '#skills-page',
    title: '技能（Skill）',
    dir: 'skills/',
    emptyHint: `还没加载到任何技能。<br />LLM 型技能放在项目的 <code>skills/&lt;id&gt;/</code> 目录，需要 <code>skill.json</code> + <code>index.js</code>。`,
    lead: `技能是 <b>LLM 型</b>扩展：它们注册工具进模型的 function 列表，<b>用不用、什么时候用由模型自己判断</b>。<br />
      所以技能不会"一定生效" —— 模型可能一直不调用它。需要"条件满足必跑"的功能，应该做成插件（见旁边的「插件」页签）。`,
    setupTitle: '新增技能',
    setupHint: `在 <code>skills/&lt;id&gt;/</code> 放 <code>skill.json</code> + <code>index.js</code>，
      导出 <code>setup(api)</code> 并在里面 <code>api.registerTool({...})</code>。
      热重载默认开启，保存即生效。完整规范见 <code>doc/extend_development/skill-development.md</code>。`
  },
  plugin: {
    kind: 'plugin',
    tab: 'plugins',
    boxSel: '#plugins-page',
    title: '插件（Plugin）',
    dir: 'plugins/',
    emptyHint: `还没加载到任何插件。<br />确定性型插件放在项目的 <code>plugins/&lt;id&gt;/</code> 目录，需要 <code>plugin.json</code> + <code>index.js</code>。`,
    lead: `插件是 <b>确定性型</b>扩展：它们提供<b>能力</b>（<code>providers</code>）或<b>钩子</b>（<code>hooks</code>），
      由核心代码按能力名确定性调用 —— <b>条件满足就一定会执行，不经过 LLM，模型想忽略也忽略不掉</b>。<br />
      代价是它不能"看情况发挥"：什么时候触发必须在代码里写死。需要模型理解意图的功能，应该做成技能（见旁边的「技能」页签）。`,
    setupTitle: '新增插件',
    setupHint: `在 <code>plugins/&lt;id&gt;/</code> 放 <code>plugin.json</code> + <code>index.js</code>，
      导出 <code>setup(api)</code>，并用 <code>export const providers = {...}</code> 或 <code>export const hooks = {...}</code> 声明扩展点。
      热重载默认开启，保存即生效。完整规范见 <code>doc/extend_development/plugin-development.md</code>。`
  }
};

async function loadModulePage(kind, { rescan = false } = {}) {
  const meta = MODULE_KINDS[kind];
  if (!meta) return;
  const box = $(meta.boxSel);
  if (!box) return;
  box.innerHTML = renderModuleSkeleton(meta);
  if (rescan) await rescanSkills({ quiet: true });
  else await loadSkillsStatus();
  renderModulePage(kind);
  // 页面整页重建（切页签 / 手动刷新）时内容淡入；卡片开关后的原地重绘不播
  uiEnter(box);
}

function renderModuleSkeleton(meta) {
  return `<div class="usage-wrap">
    <div class="usage-head"><h2>${esc(meta.title)}</h2></div>
    <div class="sk-block">${'<div class="sk-row"></div>'.repeat(5)}</div>
  </div>`;
}

/**
 * 渲染一页（技能或插件）。
 *
 * @param {'skill'|'plugin'} kind 只渲染该类型；另一类的条目**完全不进这一页**
 */
function renderModulePage(kind) {
  const meta = MODULE_KINDS[kind];
  if (!meta) return '';
  const box = $(meta.boxSel);
  const all = state.skills || [];
  // 只留本页该管的类型。
  // ⚠️ kind 为 null（自定义根目录，如测试用的临时目录）时归入**技能页**而不是丢弃 ——
  // "界面上凭空少了一个条目"比"归错页"难排查得多（用户刚刚就踩过这个坑）。
  // 卡片上会标「目录未识别」提示作者去确认放置位置。
  const items = all.filter((s) => s.kind === meta.kind || (s.kind == null && meta.kind === 'skill'));

  // 统计按本页条目现算：后端 summary 是全量的，直接用会把另一类也算进来
  const mine = {
    total: items.length,
    active: items.filter((s) => s.active).length,
    off: items.filter((s) => s.loaded && !s.enabled).length,
    broken: items.filter((s) => !s.loaded).length
  };

  // 页头（两种分支共用）：搜索框必须**常驻** —— 空列表时也要能搜/能添加。
  // 之前空分支只渲染标题+添加+刷新，用户看到的就是“没有搜索框”。
  const head = `<div class="usage-head">
        <h2>${esc(meta.title)}</h2>
        <button class="btn btn-small" id="${esc(meta.tab)}-add-btn" title="从市场口令安装，或查看自建指南">＋ 添加${meta.kind === 'skill' ? '技能' : '插件'}</button>
        <input type="search" class="module-search" id="module-search-${esc(meta.tab)}"
          placeholder="搜索${meta.kind === 'skill' ? '技能' : '插件'}名称 / 简介 / 分类…" autocomplete="off" />
        <div class="usage-days">
          <span class="uc-tag" title="本页安装总数">共 ${mine.total} 个${meta.kind === 'skill' ? '技能' : '插件'}</span>
          <button class="btn btn-small" id="${esc(meta.tab)}-refresh-btn">刷新</button>
        </div>
      </div>
      <div class="hint" style="margin-bottom:14px">
        ${meta.lead}<br />
        本页只做仓库管理（安装 / 删除 / 参数），显示的是<b>全局默认</b>状态。<b>启停按会话走</b>：到「会话管理 → 选中会话 → 设置 → 工具与技能」里开；
        「默认会话」里的开关就是全局默认。<br />
        需要先填配置才能用的会标成橙色（<b>需配置</b>）；加载失败的标红，卡片上会直接写明原因。
      </div>`;

  if (!items.length) {
    const emptyHtml = `<div class="usage-wrap">
      ${head}
      <div class="empty-hint">${meta.emptyHint}</div>
    </div>`;
    if (box) box.innerHTML = emptyHtml;
    bindModulePageEvents(kind);
    return emptyHtml;
  }

  const catLabel = { model: '模型', message: '消息', knowledge: '知识', media: '媒体', utility: '工具' };

  // 按分类分组：一屏里按功能归类，比一长串平铺好找
  const order = ['model', 'message', 'media', 'knowledge', 'utility'];
  const byCat = new Map();
  for (const s of items) {
    const c = order.includes(s.category) ? s.category : 'utility';
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c).push(s);
  }

  // ── 卡片：单列一行，名称+简介常显，上传/设置钉在行尾 ──
  // 不再做正反面翻转（悬停才看简介）；按钮固定在内容框后侧，不随文字换行。
  const card = (s) => {
    const loadedOk = s.loaded;
    const active = loadedOk && s.enabled && s.active;
    // 状态优先级：加载失败(红) > 需配置/缺依赖(橙) > 已生效(绿) > 已关闭(灰) > 启用但依赖未就绪(橙)
    const needsConfig = loadedOk && s.needsConfig === true;
    const missingDeps = loadedOk && s.missingDeps === true;
    const configIssue = needsConfig || missingDeps;
    const stateCls = !loadedOk ? 'mcard-broken'
      : (configIssue ? 'mcard-config'
        : (!s.enabled ? 'mcard-off' : (active ? 'mcard-on' : 'mcard-dep')));
    // 仓库页只读：不再提供"点卡片切开关"，开关统一在会话管理里按会话开。
    const stateTitle = !loadedOk ? `加载失败：${s.loadError || '原因未知'}`
      : needsConfig ? `需要配置：${s.configReason || '请先填写配置'}（点 ⚙ 填写后再到会话管理启用）`
        : missingDeps ? `缺少依赖：${s.depsReason || (s.missingRequires || []).join('、') || '请先安装提供依赖的扩展'}`
          : (!s.enabled ? '已关闭（到「会话管理 → 设置 → 工具与技能」里启用）'
            : (active ? '已启用（按会话生效）' : `已启用但依赖未就绪：${s.reason || (s.missingRequires || []).join('、') || '原因未知'}`));
    // 无法真正生效时，把原因写在卡片上（不再只藏在 title 提示里）
    let errLine = '';
    if (!loadedOk) {
      errLine = String(s.loadError || '加载失败，原因未知').slice(0, 160);
    } else if (needsConfig) {
      errLine = `需要配置：${String(s.configReason || '请先填写配置（点 ⚙）').slice(0, 150)}`;
    } else if (missingDeps) {
      errLine = `缺少依赖：${String(s.depsReason || (s.missingRequires || []).join('、') || '需先安装提供依赖的扩展').slice(0, 150)}`;
    } else if (s.enabled && !s.active) {
      errLine = String(s.reason || (s.missingRequires || []).map((r) => `缺少能力：${r}`).join('、') || '依赖未就绪').slice(0, 160);
    }
    const allFields = Object.keys(s.configSchema || {});
    const settingsBtn = allFields.length
      ? `<button class="mcard-gear" data-skill-id="${esc(s.id)}" title="设置（${allFields.length} 项）" aria-label="打开 ${esc(s.name)} 的设置">⚙</button>`
      : '';
    const uploadBtn = `<button class="mcard-upload" data-skill-id="${esc(s.id)}" data-skill-kind="${kind}" title="上传到市场" aria-label="上传 ${esc(s.name)} 到市场">⬆</button>`;
    const delBtn = `<button class="mcard-del" data-skill-id="${esc(s.id)}" data-skill-name="${esc(s.name)}" data-skill-kind="${kind}"
      title="删除（同时清掉所有会话里这个扩展的设置）" aria-label="删除 ${esc(s.name)}">🗑</button>`;
    const haystack = [s.id, s.name, s.description, s.dir, catLabel[s.category] || s.category]
      .filter(Boolean).join(' ').toLowerCase();
    return `
    <div class="mcard ${stateCls}" data-skill-id="${esc(s.id)}" data-copy-name="${esc(s.name || s.id)}" data-search="${esc(haystack)}" title="${esc(`${stateTitle} · 点击复制名称`)}">
      <div class="mcard-main">
        <div class="mcard-name">${esc(s.name)} <span class="skill-card__ver">v${esc(s.version)}</span>${configIssue ? '<span class="mcard-badge-config">需配置</span>' : ''}</div>
        ${(s.toolIds || []).length ? `<div class="mcard-tools" title="本技能注册的工具 id">${(s.toolIds || []).map((id) => `<code class="mcard-tool-id">${esc(id)}</code>`).join('')}</div>` : ''}
        <div class="mcard-desc">${esc(s.description || '（没有写介绍）')}</div>
        ${errLine ? `<div class="mcard-err">${esc(errLine)}</div>` : ''}
      </div>
      <div class="mcard-acts">${uploadBtn}${settingsBtn}${delBtn}</div>
    </div>`;
  };

  const sections = [...byCat.entries()].map(([cat, list]) => `
    <h3 class="usage-h3">${catLabel[cat] || cat}（${list.length}）</h3>
    <div class="module-grid">
      ${list.map(card).join('')}
    </div>
  `).join('');

  // 残留配置：只在技能页展示一次（两页共用 state）。
  const uninstalledHtml = (kind === 'skill' && (state.uninstalledSkills || []).length)
    ? `<h3 class="usage-h3">已配置但未安装（${state.uninstalledSkills.length}）</h3>
      <div class="hint" style="margin-bottom:6px">这些条目在配置里留着开关/设置，但 <code>skills/</code> 与 <code>plugins/</code> 目录里已经没有对应的文件夹。重装同名插件会自动恢复这些设置；确认不要了可以清理掉。</div>
      <div class="tool-meta" style="gap:6px;margin-bottom:8px">
        ${state.uninstalledSkills.map((u) => `<span class="tool-dep" data-search-item data-search="${esc(String(u.id).toLowerCase())}">${esc(u.id)}${u.enabled ? '' : '（已关）'}${u.hasSettings ? ' · 有设置' : ''}</span>`).join('')}
      </div>
      <button class="btn btn-small" id="skills-cleanup-btn">清理这些残留配置</button>`
    : '';

  const html = `<div class="usage-wrap">
      ${head}
      <div id="module-empty-${esc(meta.tab)}" class="hint" style="display:none;margin:10px 0">
        没有匹配的${meta.kind === 'skill' ? '技能' : '插件'}，换个关键词试试。
      </div>
      ${sections}
      ${uninstalledHtml}
    </div>`;

  if (box) box.innerHTML = html;
  bindModulePageEvents(kind);
  if (typeof enhanceConcept2UI === 'function') enhanceConcept2UI(box);
  return html;
}

/** 供渲染测试按名取用的两个入口（render-test 会逐个执行这些函数）。 */
function renderSkillsPage() { return renderModulePage('skill'); }
function renderPluginsPage() { return renderModulePage('plugin'); }

function bindModulePageEvents(kind) {
  const meta = MODULE_KINDS[kind];
  if (!meta) return;
  // 「＋ 添加」入口（标题旁）：打开添加模态框（去市场口令安装 / 自建指南）。
  // ⚠️ 这个入口曾经从模板里消失过 —— openAddModuleModal 变成没人调用的孤本，
  // 技能/插件页直接失去"添加"能力。按钮与绑定必须成对存在（2026-09-26 修复）。
  $(`#${meta.tab}-add-btn`)?.addEventListener('click', () => openAddModuleModal(kind));
  $(`#${meta.tab}-refresh-btn`)?.addEventListener('click', () => loadModulePage(kind, { rescan: true }));
  // 残留配置清理（只在技能页渲染，按钮也只在这一页出现）
  $('#skills-cleanup-btn')?.addEventListener('click', async () => {
    const btn = $('#skills-cleanup-btn');
    if (!btn || !state.uninstalledSkills?.length) return;
    const ids = state.uninstalledSkills.map((u) => u.id);
    if (!(await uiConfirm(`清理 ${ids.length} 个未安装条目的配置（${ids.join('、')}）？\n会同时清掉所有会话里这些扩展的开关与设置。`))) return;
    btn.disabled = true;
    try {
      const r = await api('/api/skills/cleanup', { method: 'POST', body: JSON.stringify({ ids }) });
      if (r.config) state.config = r.config;
      await loadModulePage('skill');
    } catch (e) {
      alert(`清理失败：${e?.message || e}`);
      btn.disabled = false;
    }
  });
  // 注意这里是 $$ （返回数组）不是 $（返回单个元素）：
  // 卡片可能有多个，用 $ 会拿到一个元素然后 .forEach 报错。
  // ⚠️ 绑定范围必须限定在**本页容器内**：两个页面同时存在于 DOM 里（只是 view 切换显隐），
  // 用全局 $$ 会把另一页的卡片也绑一遍 —— 同一个开关被绑两次，一次切换会发两个请求。
  const scope = $(meta.boxSel);
  if (!scope) return;
  // 点击卡片复制名称（2026-10-21）：不拦截卡片上的按钮/文本选择。
  scope.querySelectorAll('.mcard').forEach((card) => {
    card.addEventListener('click', async (e) => {
      if (e.target?.closest?.('button')) return;
      const sel = typeof window.getSelection === 'function' ? String(window.getSelection() || '') : '';
      if (sel.trim()) return;
      const name = card.dataset.copyName || '';
      if (!name) return;
      const ok = await copyToClipboard(name);
      if (ok) showMiniToast(`已复制：${name}`);
      else showAppAlert('复制失败，请手动选中名称复制');
    });
  });
  scope.querySelectorAll('.skill-settings-btn, .mcard-gear').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();   // 齿轮在卡片内部，点它不能触发整卡开关
      openSkillSettings(btn.dataset.skillId);
    });
  });
  // 上传到市场（⬆ 钮）：同样 stopPropagation，且带上卡片所属类型
  scope.querySelectorAll('.mcard-upload').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openMarketUploadModal(btn.dataset.skillKind || kind, btn.dataset.skillId);
    });
  });
  // 删除扩展（🗑）：删目录 + 全局配置 + 所有会话里的同名覆盖，必须二次确认
  scope.querySelectorAll('.mcard-del').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.skillId;
      const name = btn.dataset.skillName || id;
      const label = (btn.dataset.skillKind || kind) === 'plugin' ? '插件' : '技能';
      if (!(await uiConfirm(`确定删除${label}「${name}」？\n\n会删除 skills/ 或 plugins/ 下的目录，并清掉全局配置与**所有会话**里它的开关/设置。此操作不可撤销。`))) return;
      btn.disabled = true;
      try {
        const r = await api(`/api/skills/${encodeURIComponent(id)}`, { method: 'DELETE' });
        await loadModulePage(kind, { rescan: true });
        await loadChatProfiles({ quiet: true });
        renderSettingsSidebar();
        showAppAlert(`已删除${label}「${name}」${r?.removedSessions ? `，同时清理了 ${r.removedSessions} 个会话里的设置` : ''}`);
      } catch (err) {
        btn.disabled = false;
        showAppAlert(`删除失败：${err.message}`);
      }
    });
  });

  // 顶部搜索：按 data-search 本地过滤（不整页重绘，保留滚动/焦点）
  const searchInput = scope.querySelector('.module-search');
  if (searchInput) {
    const applyFilter = () => {
      const q = searchInput.value.trim().toLowerCase();
      let shown = 0;
      scope.querySelectorAll('.mcard').forEach((el) => {
        const hit = !q || (el.dataset.search || '').includes(q);
        el.style.display = hit ? '' : 'none';
        if (hit) shown++;
      });
      // 残留配置条目也参与搜索
      scope.querySelectorAll('[data-search-item]').forEach((el) => {
        el.style.display = (!q || (el.dataset.search || '').includes(q)) ? '' : 'none';
      });
      // 分类标题：组内卡片被滤光则标题一并藏掉
      scope.querySelectorAll('.module-grid').forEach((grid) => {
        const any = [...grid.querySelectorAll('.mcard')].some((el) => el.style.display !== 'none');
        grid.style.display = any ? '' : 'none';
        const h = grid.previousElementSibling;
        if (h && h.classList.contains('usage-h3')) h.style.display = any ? '' : 'none';
      });
      const emptyHint = scope.querySelector(`#module-empty-${meta.tab}`);
      if (emptyHint) emptyHint.style.display = (q && shown === 0) ? '' : 'none';
    };
    searchInput.addEventListener('input', applyFilter);
  }
}

function renderToolsSection(c) {
  // 技能失活（未启用 / 加载失败 / 依赖未就绪）时，它注册的工具整组**不再显示** ——
  // 与提示词口径一致（orchestrator 的 getToolAvailability 过滤，失活技能的工具
  // 也不会写进提示词）。"界面看得到、模型用不到"和"界面看不到、提示词却写了"
  // 都是要消灭的割裂。
  const skillActive = new Map((state.skills || []).map((s) => [s.id, s.active === true]));
  const tools = (state.toolRegistry || []).filter((t) => !t.skillId || skillActive.get(t.skillId) === true);
  const toolsCfg = c.tools || {};
  // 分类清单必须与 tool-registry 的 CATEGORY_META 同源（8 类）：
  // 曾经只列 6 类，media/knowledge 两类的工具（send_image、bili-meme 等）
  // 在设置页无卡片 → 无分类开关也无单工具开关，只能手改 JSON。
  const categories = ['messaging', 'sticker', 'query', 'memory', 'web', 'knowledge', 'media', 'system'];
  const categoryNames = {
    messaging: '💬 消息发送',
    sticker: '😀 表情管理',
    query: '🔍 消息查询',
    memory: '🧠 记忆系统',
    web: '🌐 联网搜索',
    knowledge: '📚 知识库',
    media: '🎞️ 媒体理解',
    system: '⚙️ 系统反馈'
  };

  // 按分类分组
  const byCategory = {};
  for (const t of tools) {
    if (!byCategory[t.category]) byCategory[t.category] = [];
    byCategory[t.category].push(t);
  }

  // 渐进式披露：默认折叠，点击展开
  const expandedCategories = state.expandedToolCategories || new Set(['messaging']); // 默认展开第一个

  const categoryCards = categories.map((cat) => {
    const catTools = byCategory[cat] || [];
    if (!catTools.length) return '';
    const catEnabled = toolsCfg.categories?.[cat] !== false;
    const isExpanded = expandedCategories.has(cat);

    const toolCards = isExpanded ? catTools.map((t) => {
      const enabled = toolsCfg.overrides?.[t.id] ?? t.defaultEnabled ?? true;
      const disabledByDep = (t.requiresVision && c.api?.vision === false) || (t.requiresSearch && c.webSearch?.enabled === false);
      // 功能名字 + 一句话概括（description 可能缺失，不能直接 .split）
      const funcName = String(t.id || '').split(':').pop();
      const summary = String(t.description || '（无说明）').split('。')[0] + '。';
      // send_to 的开关就是「跨会话发送」本身（tools.crossChatSend）：
      // 开关收编进消息发送分类，用户在工具卡上直接控制，不再单独设全局勾选框。
      const isSendTo = t.id === 'send_to';
      const checked = isSendTo ? (toolsCfg.crossChatSend === true) : enabled;
      const chkId = `tool-chk-${t.id.replace(/[^\w-]/g, '_')}`;
      return `
        <div class="tool-card ${checked ? 'enabled' : 'disabled'} ${disabledByDep ? 'dep-disabled' : ''}" data-tool-id="${t.id}">
          <div class="tool-header">
            <label class="switch tool-switch">
              <input type="checkbox" class="tool-checkbox" id="${chkId}" data-tool-id="${t.id}" ${isSendTo ? 'data-cross-chat="1"' : ''} ${checked ? 'checked' : ''} ${disabledByDep && !isSendTo ? 'disabled' : ''} />
              <span class="track"><span class="thumb"></span></span>
            </label>
            <span class="tool-icon">${t.icon}</span>
            <div class="tool-title">
              <div class="tool-name">${esc(funcName)}${t.skillId ? '<span class="tool-dep tool-skill">skill</span>' : ''}</div>
              <div class="tool-summary">${esc(summary)}</div>
            </div>
          </div>
          <div class="tool-meta">
            ${t.requiresVision ? '<span class="tool-dep">需要视觉模型</span>' : ''}
            ${t.requiresSearch ? '<span class="tool-dep">需要搜索服务</span>' : ''}
            ${disabledByDep ? '<span class="tool-dep-warn">依赖未满足</span>' : ''}
            ${isSendTo ? '<span class="tool-dep">目标须在白名单内</span>' : ''}
          </div>
        </div>`;
    }).join('') : '';

    return `
      <div class="tool-category ${isExpanded ? 'expanded' : 'collapsed'}" data-category="${cat}">
        <div class="tool-category-header" data-category="${cat}" role="button" tabindex="0">
          <span class="tool-category-arrow">${isExpanded ? '▼' : '▶'}</span>
          <span class="tool-category-name">${categoryNames[cat] || cat}</span>
          <label class="tool-category-toggle switch" onclick="event.stopPropagation()">
            <input type="checkbox" class="category-checkbox" data-category="${cat}" ${catEnabled ? 'checked' : ''} />
            <span class="track"><span class="thumb"></span></span>
          </label>
          <span class="tool-category-count">${catTools.length} 个工具</span>
        </div>
        ${isExpanded ? `<div class="tool-list">${toolCards}</div>` : ''}
      </div>`;
  }).join('');

  // ⚠️ 必须落在顶层 setCard 里：renderSettingsSection 直接嵌这一段时，
  // autoFoldSettings 会按 h3 把整页重包成折叠卡，再把 .fold-head 绑到
  // 分类头上 —— 点分类会开合整块面板，grid-rows 折叠把下半屏撑出大片空白。
  const fold = (typeof setCard === 'function') ? setCard : (o) => `<div class="setcard">${o.body}</div>`;
  // 会话级技能/插件开关：文件全局一份，启停按会话记（profile overrides）。
  // 「默认会话」= 全局默认，影响所有没单独配置的会话。
  // 技能与插件拆成两个独立分区，各自带搜索（不再混在一张长列表里）。
  const scopeLabel = isSessionScope() ? '本会话' : '默认设置';
  const moduleCard = ({ key, kindLabel, list }) => {
    const rows = list.map((s) => {
      const loaded = s.loaded !== false;
      const on = s.enabled === true;
      const reason = loaded ? '' : '<span class="tool-dep-warn">未加载</span>';
      const hay = [s.id, s.name, s.description, s.category].filter(Boolean).join(' ').toLowerCase();
      return `
        <div class="skill-scope-row" data-search="${esc(hay)}">
          <div class="skill-scope-name">
            <b>${esc(s.name || s.id)}</b>
            <span class="muted">${kindLabel} · ${esc(s.id)}</span>${reason}
            <span class="muted skill-scope-state">${on ? '已启用' : '已关闭'}</span>
          </div>
          <label class="switch tool-switch" title="${loaded ? `只对${scopeLabel}生效` : '该扩展未成功加载，无法启用'}">
            <input type="checkbox" class="skill-scope-toggle" data-skill-id="${esc(s.id)}" data-no-autosave
                   ${on ? 'checked' : ''} ${loaded ? '' : 'disabled'} />
            <span class="track"><span class="thumb"></span></span>
          </label>
        </div>`;
    }).join('');
    const onCount = list.filter((s) => s.enabled === true).length;
    return fold({
      id: `card-scope-${key}`,
      icon: key === 'skills' ? '🧩' : '🔌',
      title: `${scopeLabel}启用的${kindLabel}`,
      sub: `已启用 ${onCount} / 共 ${list.length}${isSessionScope() ? '' : '（影响所有未单独配置的会话）'}`,
      open: true,
      body: `
        <div class="scope-search-row">
          <input type="search" class="scope-search" id="scope-search-${key}" data-no-autosave
                 placeholder="搜索${kindLabel}名称 / id / 简介…" autocomplete="off" />
        </div>
        <div class="scope-list">${rows || `<div class="hint">还没有安装${kindLabel}，可到「${kindLabel}仓库」添加。</div>`}</div>
        <div class="hint scope-empty" style="display:none">没有匹配的${kindLabel}。</div>`
    });
  };
  const allModules = state.skills || [];
  const skillScopeCards = moduleCard({ key: 'skills', kindLabel: '技能', list: allModules.filter((s) => s.kind !== 'plugin') })
    + moduleCard({ key: 'plugins', kindLabel: '插件', list: allModules.filter((s) => s.kind === 'plugin') });
  return `
    <h3 id="settings-tools">工具与技能</h3>
    <div class="hint" style="margin-bottom:12px">
      打开开关启用机器人可调用的工具。关闭后模型将无法使用该功能。
      ${toolsCfg.enabled === false ? '<span style="color:var(--red)">⚠️ 全局开关已关闭，所有工具均不可用</span>' : ''}
    </div>
    ${skillScopeCards}
    ${fold({
      id: 'card-tools-list',
      icon: '🛠',
      title: '工具列表',
      sub: '按分类展开；开关即时保存',
      open: true,
      body: `
        <div class="checkbox-row">
          ${switchHtml('cfg-tools-enabled', toolsCfg.enabled !== false, '启用工具系统（关闭后机器人只能看不能做任何操作）')}
        </div>
        <div class="tool-actions" style="margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-small" id="tools-enable-all">全部启用</button>
          <button class="btn btn-small" id="tools-disable-all">全部禁用</button>
          <button class="btn btn-small" id="tools-reset">恢复默认</button>
        </div>
        ${categoryCards || '<div class="hint">（还没有注册任何工具）</div>'}`
    })}`;
}

/**
 * 完整提示词预览文本（设置-工具与技能 & 技能页右侧共用同一份）。
 * 数据来自 GET /api/prompt-preview —— 后端用运行时同一套
 * buildSystemPrompt + getToolAvailability 组装，按当前启停状态实时反映；
 * 前端不再自己拼（曾经前端复制了一份静态模板，永远是"全启用"的样子，
 * 与实际发送的提示词越漂越远）。
 * 后端返回结果缓存在 state.promptPreview；render* 渲染时同步取，
 * 开关变动后由 refreshPromptPreview() 异步拉新并原地更新 DOM。
 */
function renderPromptPreviewText() {
  const d = state.promptPreview;
  if (!d || typeof d.systemPrompt !== 'string') return '（正在加载提示词预览…）';
  const tools = d.tools || [];
  const toolLines = tools.length
    ? tools.map((t) => `- ${t.id}：${t.description}`).join('\n')
    : '（当前没有可用工具）';
  return `${d.systemPrompt}\n\n【本次可用工具清单（function calling）】\n${toolLines}`;
}

/**
 * 拉取/刷新提示词预览。
 * 实时性设计（2026-09-17）：预览读的是**后端活配置**（getConfig），而设置的
 * 自动保存有 600ms 防抖 —— 直接刷看到的是旧状态。所以本函数可带 overrides
 * （与配置同结构的临时补丁）：请求发给 /api/prompt-preview，后端先深合并补丁
 * 再组装（不落盘），预览即刻反映刚点的开关，不用等自动保存落地。
 */
async function refreshPromptPreview(overrides = null) {
  try {
    // 空对象不附 body（GET 语义）——没有补丁就按后端活配置组装
    const hasOverrides = overrides && Object.keys(overrides).length > 0;
    const d = await api('/api/prompt-preview', hasOverrides ? {
      method: 'POST',
      body: JSON.stringify(overrides)
    } : {});
    state.promptPreview = d;
  } catch {
    state.promptPreview = null;
  }
  // 两处预览 DOM（设置-工具页 / 技能页右侧）都原地换文本，不整页重渲染
  $$('.prompt-preview-content').forEach((pre) => {
    pre.textContent = renderPromptPreviewText();
  });
}


