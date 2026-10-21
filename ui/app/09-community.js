// 〔社区：提示/上传/发送配置/活跃设置/市场〕——M9 拆分第 10 段
'use strict';
/* ══════════════════════════════════════════════════════════════
   社区功能：意见收集 + 金句上传
   ══════════════════════════════════════════════════════════════
   数据流向：浏览器 → https://kondius.cn/qq-agent/api（作者自建的公开
   收件箱，静态站之外的一个小型接收服务）。不经过本地后端 ——
   本地后端只服务本机，碰不到作者的服务器；分发版用户也是这个地址
   （意见和金句本来就是发给作者看的）。
*/
const COMMUNITY_API = 'https://kondius.cn/qq-agent/api';

/** 统一的提示小模态框（替代 alert —— 原生对话框与 UI 风格割裂）。 */
function showNoticeModal(title, text) {
  const overlay = modelModalShell({
    head: title,
    body: `<div class="hint" style="font-size:13.5px;line-height:1.7">${esc(text)}</div>`,
    foot: `<button class="btn btn-primary" id="notice-ok">知道了</button>`
  });
  overlay.querySelector('#notice-ok').addEventListener('click', () => closeModelModal(overlay));
}

/**
 * 上传成功浮框（右上角）：不自动消失，只能手动关闭，带目标网址。
 * 意见收集 / 金句上传成功后调用。
 */
function showUploadToast(title, url, { onClose } = {}) {
  // 同类型只留一个（连着传两次不堆叠）
  document.querySelectorAll('.upload-toast').forEach((el) => {
    el.classList.add('closing');
    setTimeout(() => el.remove(), 180);
  });
  const el = document.createElement('div');
  el.className = 'upload-toast';
  el.innerHTML = `
    <div class="ut-head">
      <span class="ut-title">${esc(title)}</span>
      <button class="ut-close" type="button" aria-label="关闭" title="关闭">×</button>
    </div>
    <a class="ut-link" href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`;
  document.body.appendChild(el);
  el.querySelector('.ut-close').addEventListener('click', () => {
    el.classList.add('closing');
    setTimeout(() => { el.remove(); onClose?.(); }, 180);
  });
}


/** 档位说明（concept2 设计稿文案：带 <b> 强调，百分比与后端判定同源）。 */
function descOf(pos) {
  const { tier, randomPercent } = sliderToTierUI(pos);
  if (tier === 1) return '只有被 @ 时才响应，其余消息标记已读、<b>不调模型</b>（最省 token）';
  if (tier === 2) return '在 1 档基础上，<b>命中关键词</b>也响应';
  if (tier === 3) return `被 @ / 命中关键词必响应；此外每批普通消息有 <b>${randomPercent}%</b> 概率响应`;
  return '任何消息都响应 —— <b>最费 token</b>';
}

/** 头部摘要文案（折叠卡 head 右侧的当前档位小结）。 */
function tierSummary(pos) {
  const { tier, randomPercent } = sliderToTierUI(pos);
  return tier === 3 ? `3 档 · ${randomPercent}%` : `${tier} 档 · ${TIER_NAME[tier]}`;
}

/**
 * 档位滑条控制器（2026-09-24 · 对齐 concept2 设计稿）：
 * 轨道/分段/拇指都是模板里的静态节点（.tier-scale / .tier-band / .tier-knob），
 * 控制器只做"值 ↔ 界面"与交互。动画契约按设计稿：
 *   · 预设 / 键盘跳档 → 拇指走 CSS 弹簧缓动（transition: left … cubic-bezier(.34,1.4,.64,1)）
 *   · 拖动中 → 临时 transition:none，帧级跟手（这是设计稿帧率正确的关键）
 *   · 松手   → 恢复过渡
 * 控制器协议与 00-core 的 createVSlider 保持一致
 * （setValues / applyValues / setDual / setDisabled / destroy / .values /
 *  onChange({low, high, byUser})）—— applyPeakPreset 等既有调用方零改动。
 * 值语义同旧协议：low = 低谷（活跃）档位点（数值大 = 档高），
 * high = 高峰（安静）档位点，恒有 low >= high；单珠模式只用 low。
 */
function createTierBar({ mount, dual = false, low = 100, high = 10, onChange = null, onInput = null } = {}) {
  // 位置保留两位小数（不取整）：整数量化会让拇指 1% 一跳（宽轨上≈6~10px 的台阶），
  // 拖起来"一段一段"且不跟手。1% 的 1/100 精度对换算毫无影响。
  const clamp = (v) => Math.min(100, Math.max(0, Math.round((Number(v) || 0) * 100) / 100));
  const st = { low: clamp(low), high: clamp(high), dual: !!dual, disabled: false };
  if (st.high > st.low) { const t = st.low; st.low = st.high; st.high = t; }

  // 档位代表位 = 区间中心（1→5、2→15、3→55、4→95）。
  // 松手吸附规则：1/2/4 档语义是离散的（档内任何位置等价）→ 弹簧回档位中心；
  // 3 档是"随机概率线性"（位置=概率）→ 保留精确位置不吸附。
  const B = TIER_SLIDER_BANDS;
  const TIER_POS = [
    B.tier1End / 2,
    (B.tier1End + B.tier2End) / 2,
    (B.tier2End + B.tier3End) / 2,
    (B.tier3End + 100) / 2
  ];
  const snapIfDiscrete = (v) => {
    const { tier } = sliderToTierUI(v);
    return (tier === 1 || tier === 2 || tier === 4) ? TIER_POS[tier - 1] : v;
  };

  // 拇指是模板里的静态节点（设计稿同款 markup）；缺了就兜底补一颗
  const knobLo = mount.querySelector('.knob-valley') || mount.querySelector('.tier-knob');
  let knobHi = mount.querySelector('.knob-peak');
  if (!knobHi) {
    knobHi = document.createElement('div');
    knobHi.className = 'tier-knob knob-peak';
    mount.appendChild(knobHi);
  }
  let knobRendered = false;   // 首帧装填不播动画（弹窗刚打开时不该有珠子弹出）
  [knobLo, knobHi].forEach((k, i) => {
    k.setAttribute('role', 'slider');
    k.setAttribute('aria-label', i === 0 ? '低谷时段档位点' : '高峰时段档位点');
    k.setAttribute('aria-valuemin', '0');
    k.setAttribute('aria-valuemax', '100');
    k.tabIndex = 0;
  });

  const fire = (byUser) => { if (onChange) onChange({ low: st.low, high: st.high, byUser }); };

  function render() {
    knobLo.style.left = st.low + '%';
    knobHi.style.left = st.high + '%';
    // 高峰珠随峰谷开关显隐（点击切换时淡入淡出）；拖动中形态不变，不触发动画
    if (st.dual) uiShow(knobHi, () => { knobHi.style.display = ''; }, knobRendered);
    else uiHide(knobHi, () => { knobHi.style.display = 'none'; }, knobRendered);
    knobLo.style.opacity = st.disabled ? '.4' : '';
    knobHi.style.opacity = st.disabled ? '.4' : '';
    knobLo.setAttribute('aria-valuenow', String(st.low));
    knobHi.setAttribute('aria-valuenow', String(st.high));
    mount.dataset.dual = st.dual ? '1' : '0';
    knobRendered = true;
  }

  const posFrom = (e) => {
    const r = mount.getBoundingClientRect();
    const w = r.width || 1;
    return clamp(((e.clientX - r.left) / w) * 100);
  };
  let dragging = null;
  const move = (which, v) => {
    if (which === 'lo') st.low = st.dual ? Math.max(v, st.high) : v;
    else st.high = Math.min(v, st.low);
    render();
    // 拖动中的高频轻量回调：读数行实时跟手（而不是松手后才变）
    if (onInput) onInput({ low: st.low, high: st.high, byUser: true });
  };
  mount.addEventListener('pointerdown', (e) => {
    if (st.disabled || dragging || (e.button != null && e.button !== 0)) return;
    e.preventDefault();
    const v = posFrom(e);
    if (st.dual) dragging = Math.abs(v - st.low) <= Math.abs(v - st.high) ? 'lo' : 'hi';
    else dragging = 'lo';
    try { mount.setPointerCapture(e.pointerId); } catch { /* 旧环境无指针捕获 */ }
    // 拖动跟手：关掉弹簧过渡，帧级直跟；松手恢复（设计稿同款手法）
    knobLo.style.transition = 'none';
    knobHi.style.transition = 'none';
    move(dragging, v);
  });
  mount.addEventListener('pointermove', (e) => { if (dragging) move(dragging, posFrom(e)); });
  const endDrag = () => {
    if (!dragging) return;
    dragging = null;
    knobLo.style.transition = '';
    knobHi.style.transition = '';
    // 松手吸附：1/2/4 档弹簧回档位中心（transition 已恢复 → 弹滑动画生效）；
    // 3 档（随机概率线性）保留精确位置。
    const lo = snapIfDiscrete(st.low);
    const hi = snapIfDiscrete(st.high);
    if (lo !== st.low || hi !== st.high) {
      st.low = lo;
      st.high = hi;
      render();
      if (onInput) onInput({ low: st.low, high: st.high, byUser: true });
    }
    fire(true);
  };
  mount.addEventListener('pointerup', endDrag);
  mount.addEventListener('pointercancel', endDrag);

  const onKey = (which) => (e) => {
    if (st.disabled) return;
    const cur = which === 'lo' ? st.low : st.high;
    let next = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = cur - 1;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = cur + 1;
    else if (e.key === 'PageDown') next = cur - 10;
    else if (e.key === 'PageUp') next = cur + 10;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = 100;
    else return;
    e.preventDefault();
    move(which, next);   // 键盘跳档保留弹簧过渡（招牌滑动动画）
    fire(true);
  };
  knobLo.addEventListener('keydown', onKey('lo'));
  knobHi.addEventListener('keydown', onKey('hi'));

  render();
  return {
    get values() { return { low: st.low, high: st.high }; },
    setValues(lo, hi) {
      st.low = clamp(lo);
      st.high = clamp(hi == null ? lo : hi);
      if (st.high > st.low) { const t = st.low; st.low = st.high; st.high = t; }
      render();
    },
    applyValues(lo, hi) { this.setValues(lo, hi); fire(false); },
    setDual(b) { st.dual = !!b; render(); },
    setDisabled(b) { st.disabled = !!b; render(); },
    destroy() {
      mount.removeEventListener('pointerdown', () => {});
      knobLo.removeEventListener('keydown', onKey('lo'));
      knobHi.removeEventListener('keydown', onKey('hi'));
    }
  };
}

/**
 * 「活跃设置」编辑器（2026-10-21 会话个性化版）。
 *
 * 只编辑"当前选中作用域"的一套档位：
 *   · 「默认设置」面板 → 全局默认档位（所有未自定义会话的默认值）
 *   · 某个群/私聊面板 → 该会话的覆盖（提交后写进 profile.overrides.store）
 * 旧的「统一设置开关 + 分群按钮 + groupSliderPos/groupPeakPos 两张图」已删除：
 *   会话"维度"由设置页左栏的会话列表承担，映射表不再存在。
 *
 * 峰谷：同一条滑条上两颗珠 —— 上 = 低谷档位、下 = 高峰档位。
 * 保存语义：拖动/切换即并入当前作用域（自动保存，与设置页其他分区一致），
 * "恢复默认"按钮在分区菜单行尾（会话作用域下才有）。
 *
 * 用法：renderChatSection 渲染 `<div id="ac-editor"></div>`，
 *      bindSettingsEvents 每次重渲染后调 mountActiveConfigEditor(root) 挂载。
 */
/**
 * 活跃设置编辑器（2026-10-21 改版）：
 *   触发条件三开关（仅@ / @+关键词 / 任何消息）+ 回复概率滑条。
 *   峰谷：时段（星期+时间）+ 高峰专用的触发条件/概率。
 *
 * 保存仍走 saveAll → postConfigPatch（自动保存到当前作用域：默认/该会话）。
 * 所有控件都标记 data-no-autosave：它们自己立即保存，不能触发表单的整段自动保存
 * 与“撤销本次设置”按钮（那会在切换时把页面顶下去）。
 */
function mountActiveConfigEditor(root) {
  const rootEl = root;
  const c = state.config || {};
  const st = c.store || {};
  const ps = st.peakSchedule || {};
  const peakOn0 = ps.enabled === true;
  const base = triggerFromStoreUI(st);
  const scopeText = (!isSessionScope() && state.settingsScope === 'default')
    ? '全局默认（未单独自定义的会话都用它）'
    : `${chatTitleOf(state.settingsScope)} 的专属设置`;

  const q = (sel) => rootEl.querySelector(sel);
  const qHead = (sel) => (rootEl.closest ? rootEl.closest('.setcard')?.querySelector(sel) : null) || q(sel);
  const headCard = rootEl.closest ? rootEl.closest('.setcard') : null;
  const ctrl = (sel) => headCard?.querySelector(sel) || q(sel);

  const triggerControls = (prefix, trig, prob) => `
    <div class="ac-trigger-row" data-prefix="${prefix}">
      <label class="ac-trigger-item"><input type="checkbox" class="ac-trigger" data-trigger="mention"
        id="${prefix}-trigger-mention" data-no-autosave ${trig.mention ? 'checked' : ''} /> 只有@时触发</label>
      <label class="ac-trigger-item"><input type="checkbox" class="ac-trigger" data-trigger="keyword"
        id="${prefix}-trigger-keyword" data-no-autosave ${trig.keyword ? 'checked' : ''} /> @+关键词触发</label>
      <label class="ac-trigger-item"><input type="checkbox" class="ac-trigger" data-trigger="all"
        id="${prefix}-trigger-all" data-no-autosave ${trig.all ? 'checked' : ''} /> 任何消息都触发</label>
    </div>
    <div class="ac-prob-row">
      <span class="ac-prob-label">触发后回复概率</span>
      <input type="range" id="${prefix}-prob-range" class="ac-prob-range" min="0" max="100" step="5"
             value="${prob}" data-no-autosave />
      <span class="ac-prob-val" ${prefix === 'peak' ? 'id="peak-prob-val"' : `id="${prefix}-prob-val"`}>${prob}%</span>
    </div>`;

  rootEl.innerHTML = `
    <div class="ac-trigger-wrap">
      <div class="hint ac-target" id="ac-target">当前编辑：${esc(scopeText)} · 改动即时保存</div>
      <div class="ac-sub-title">触发条件</div>
      ${triggerControls('ac', base.trigger, base.probability)}
      <div class="hint">「任何消息都触发」开启时，上面两项会置灰；回复概率在**触发之后**生效。</div>
      <div class="ac-summary" id="ac-summary">${esc(triggerSummaryUI(base.trigger, base.probability))}</div>
    </div>`;

  const readTrigger = (prefix) => normalizeTriggerUI({
    mention: rootEl.querySelector(`#${prefix}-trigger-mention`)?.checked,
    keyword: rootEl.querySelector(`#${prefix}-trigger-keyword`)?.checked,
    all: rootEl.querySelector(`#${prefix}-trigger-all`)?.checked
  });
  const readProb = (prefix) => Math.max(0, Math.min(100, Number(rootEl.querySelector(`#${prefix}-prob-range`)?.value ?? 100)));

  function syncTriggerUI(prefix) {
    const all = rootEl.querySelector(`#${prefix}-trigger-all`)?.checked === true;
    for (const name of ['mention', 'keyword']) {
      const el = rootEl.querySelector(`#${prefix}-trigger-${name}`);
      if (el) el.disabled = all;
    }
  }
  function normalizeChecks(prefix) {
    const mention = rootEl.querySelector(`#${prefix}-trigger-mention`);
    const keyword = rootEl.querySelector(`#${prefix}-trigger-keyword`);
    const all = rootEl.querySelector(`#${prefix}-trigger-all`);
    if (!all?.checked) {
      if (keyword?.checked && mention) mention.checked = true;
      if (!mention?.checked && !keyword?.checked && mention) mention.checked = true;
    }
    syncTriggerUI(prefix);
  }
  function syncProbLabel(prefix) {
    const val = rootEl.querySelector(`#${prefix}-prob-val`);
    if (val) val.textContent = `${readProb(prefix)}%`;
  }
  const baseTriggerNow = () => readTrigger('ac');
  const baseProbNow = () => readProb('ac');

  function saveAll(extra = {}) {
    const storePatch = { ...(extra.storeOverride || {}) };
    if (!Object.keys(storePatch).length) return;
    const p = postConfigPatch({ store: storePatch });
    // 供「一键还原默认配置」等待：避免还原请求先落地、旧的自动保存后到又把覆盖写回来。
    window.__settingsWritePromise = p;
    p.then(() => { mountSessionRestoreButton(); renderSettings(); })
      .catch((e) => showAppAlert(`保存失败：${e.message}`));
  }

  function saveBase() {
    const trig = baseTriggerNow();
    const prob = baseProbNow();
    const derived = legacyFromTriggerUI(trig, prob);
    const psNow = state.config?.store?.peakSchedule || {};
    const patch = { trigger: trig, replyProbability: prob, ...derived };
    if (psNow.enabled === true) {
      patch.peakSchedule = { ...psNow, valley: { sliderPos: derived.contextSliderPos } };
    }
    saveAll({ storeOverride: patch });
  }

  for (const prefix of ['ac']) {
    const box = rootEl;
    box.querySelectorAll(`#${prefix}-trigger-mention, #${prefix}-trigger-keyword, #${prefix}-trigger-all`).forEach((el) => {
      el.addEventListener('change', () => {
        normalizeChecks(prefix);
        const sum = box.querySelector('#ac-summary');
        if (sum) sum.textContent = triggerSummaryUI(readTrigger('ac'), readProb('ac'));
        saveBase();
      });
    });
    const range = box.querySelector(`#${prefix}-prob-range`);
    range?.addEventListener('input', () => syncProbLabel(prefix));
    range?.addEventListener('change', () => {
      normalizeChecks(prefix);
      const sum = box.querySelector('#ac-summary');
      if (sum) sum.textContent = triggerSummaryUI(readTrigger('ac'), readProb('ac'));
      saveBase();
    });
  }
  syncTriggerUI('ac');

  // ── 峰谷开关 ──
  const chkPeak = ctrl('#ac-peak-enabled');
  const peakOnNow = () => (chkPeak ? chkPeak.checked === true : (state.config?.store?.peakSchedule?.enabled === true));

  function applyPeakSwitch(on) {
    const psNow = state.config?.store?.peakSchedule || {};
    const peakCfg = peakTriggerFromStoreUI(psNow);
    const baseNow = triggerFromStoreUI(state.config?.store || {});
    const patch = {
      ...psNow,
      enabled: !!on,
      weekdays: Array.isArray(psNow.weekdays) ? psNow.weekdays : [],
      peak: {
        start: String(psNow.peak?.start || '09:00'),
        end: String(psNow.peak?.end || '18:00'),
        trigger: peakCfg.trigger,
        probability: peakCfg.probability
      },
      valley: { sliderPos: legacyFromTriggerUI(baseNow.trigger, baseNow.probability).contextSliderPos }
    };
    saveAll({ storeOverride: { peakSchedule: patch } });
  }
  chkPeak?.addEventListener('change', () => applyPeakSwitch(chkPeak.checked === true));

  // ── 峰谷时段模态框：星期 + 时间 + 高峰触发条件/概率 ──
  function openPeakModal() {
    const psNow = state.config?.store?.peakSchedule || {};
    const start = String(psNow.peak?.start || '09:00');
    const end = String(psNow.peak?.end || '18:00');
    const peakCfg = peakTriggerFromStoreUI(psNow);
    const days = Array.isArray(psNow.weekdays) && psNow.weekdays.length
      ? psNow.weekdays
      : [1, 2, 3, 4, 5, 6, 7];
    const weekRow = [1, 2, 3, 4, 5, 6, 7].map((d) => `
      <label class="peak-day"><input type="checkbox" id="peak-weekday-${d}" ${days.includes(d) ? 'checked' : ''} /> 周${'一二三四五六日'[d - 1]}</label>`).join('');
    const sub = modelModalShell({
      head: '峰谷时段',
      body: `
        <div class="field">
          <label>生效星期（都不勾 = 每天）</label>
          <div class="peak-days">${weekRow}</div>
        </div>
        <div class="field-row">
          <div class="field"><label>高峰开始</label><input type="time" id="cfg-peak-start" value="${esc(start)}" /></div>
          <div class="field"><label>高峰结束</label><input type="time" id="cfg-peak-end" value="${esc(end)}" /></div>
        </div>
        <div class="hint">跨零点也支持；高峰之外的时间一律视为「其余时间」，用主面板的设置。启用 / 停用见卡头开关。</div>
        <div class="field"><label>预设方案</label>
          <select id="cfg-peak-preset">
            <option value="">— 选择预设 —</option>
            ${peakPresetOptions(psNow).map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('')}
          </select>
          <div class="hint" id="peak-preset-hint" style="margin-top:4px">选预设自动填充星期、时段与高峰设置。</div>
        </div>
        <div class="ac-sub-title" style="margin-top:12px">高峰时段用</div>
        ${triggerControls('peak', peakCfg.trigger, peakCfg.probability)}
        <div class="field"><button class="btn btn-small" id="peak-preset-save-btn" type="button">保存当前方案为「自定义」</button></div>`,
      foot: `<button class="btn" id="ac-peak-cancel">取消</button>
             <button class="btn btn-primary" id="ac-peak-save">保存</button>`
    });
    const subRoot = sub;
    const readPeakTrigger = () => normalizeTriggerUI({
      mention: subRoot.querySelector('#peak-trigger-mention')?.checked,
      keyword: subRoot.querySelector('#peak-trigger-keyword')?.checked,
      all: subRoot.querySelector('#peak-trigger-all')?.checked
    });
    const readPeakProb = () => Math.max(0, Math.min(100, Number(subRoot.querySelector('#peak-prob-range')?.value ?? 100)));
    const syncPeak = () => {
      const all = subRoot.querySelector('#peak-trigger-all')?.checked === true;
      for (const name of ['mention', 'keyword']) {
        const el = subRoot.querySelector(`#peak-trigger-${name}`);
        if (el) el.disabled = all;
      }
    };
    const normalizePeak = () => {
      const mention = subRoot.querySelector('#peak-trigger-mention');
      const keyword = subRoot.querySelector('#peak-trigger-keyword');
      const all = subRoot.querySelector('#peak-trigger-all');
      if (!all?.checked) {
        if (keyword?.checked && mention) mention.checked = true;
        if (!mention?.checked && !keyword?.checked && mention) mention.checked = true;
      }
      syncPeak();
    };
    subRoot.querySelectorAll('#peak-trigger-mention, #peak-trigger-keyword, #peak-trigger-all').forEach((el) => {
      el.addEventListener('change', normalizePeak);
    });
    subRoot.querySelector('#peak-prob-range')?.addEventListener('input', (e) => {
      const val = subRoot.querySelector('#peak-prob-val');
      if (val) val.textContent = `${e.target.value}%`;
    });
    syncPeak();

    const peakPreset = subRoot.querySelector('#cfg-peak-preset');
    peakPreset?.addEventListener('change', () => {
      if (peakPreset.value) applyPeakPreset(peakPreset.value);
      peakPreset.value = '';
    });
    const readDays = () => [1, 2, 3, 4, 5, 6, 7].filter((d) => subRoot.querySelector(`#peak-weekday-${d}`)?.checked);
    const buildPeak = () => ({
      start: subRoot.querySelector('#cfg-peak-start')?.value || '09:00',
      end: subRoot.querySelector('#cfg-peak-end')?.value || '18:00',
      trigger: readPeakTrigger(),
      probability: readPeakProb()
    });

    subRoot.querySelector('#peak-preset-save-btn')?.addEventListener('click', () => {
      const psNext = state.config?.store?.peakSchedule || {};
      const peak = buildPeak();
      const weekdays = readDays();
      saveAll({ storeOverride: { peakSchedule: { ...psNext, custom: { peak, weekdays, valley: { sliderPos: legacyFromTriggerUI(triggerFromStoreUI(state.config?.store || {}).trigger, triggerFromStoreUI(state.config?.store || {}).probability).contextSliderPos } } } } });
      closeModelModal(subRoot);
    });
    subRoot.querySelector('#ac-peak-cancel')?.addEventListener('click', () => { closeModelModal(subRoot); renderSettings(); });
    subRoot.querySelector('#ac-peak-save')?.addEventListener('click', () => {
      const psNext = state.config?.store?.peakSchedule || {};
      const baseNow = triggerFromStoreUI(state.config?.store || {});
      saveAll({
        storeOverride: {
          peakSchedule: {
            ...psNext,
            weekdays: readDays(),
            peak: buildPeak(),
            valley: { sliderPos: legacyFromTriggerUI(baseNow.trigger, baseNow.probability).contextSliderPos }
          }
        }
      });
      closeModelModal(subRoot);
    });
  }

  // ── 档位参数（历史条数 / 关键词 / 连续参与）──
  function openTierParamsModal() {
    const stNow = state.config?.store || {};
    const cNow = state.config || {};
    const sub = modelModalShell({
      head: '档位参数',
      body: `
        <h4 class="tp-h">响应时随【已读信息】带多少条历史</h4>
        <div class="tp-row">发送
          <input class="inp mono tp-count" type="number" id="tp-historycount" min="1" max="500" value="${esc(stNow.historyCount ?? stNow.allCount ?? 80)}" />
          条已读历史。</div>
        <h4 class="tp-h" style="margin-top:12px">连续触发时的前缀缓存锚定</h4>
        <div class="checkbox-row"><input type="checkbox" id="tp-anchor" ${stNow.promptAnchor?.enabled !== false ? 'checked' : ''} />
          <label for="tp-anchor">复用上一轮的记忆+已读前缀，只追加新内容（推荐开启，缓存命中大幅省 token）</label></div>
        <div class="tp-row">最多额外追加
          <input class="inp mono tp-count" type="number" id="tp-anchor-extra" min="1" max="50" value="${esc(Number(stNow.promptAnchor?.maxExtraRead ?? 5))}" />
          条已读，超出则整体重置窗口。</div>
        <div class="field"><label>关键词触发用的词表（每行一个，不区分大小写）</label>
          <textarea id="tp-keywords" rows="4" placeholder="小鲸鱼&#10;bot">${esc((stNow.keywords || []).join('\n'))}</textarea></div>
        <h4 class="tp-h" style="margin-top:12px">被召唤后持续参与</h4>
        <div class="checkbox-row"><input type="checkbox" id="tp-chatactive" ${cNow.chatActive?.enabled === true ? 'checked' : ''} />
          <label for="tp-chatactive">被召唤后可持续参与话题（仅@/关键词触发时生效）</label></div>
        <div class="field"><label>活跃期最长持续（分钟，到期自动潜水）</label>
          <input type="number" id="tp-chatactive-ttl" min="1" max="240" value="${esc(Number(cNow.chatActive?.ttlMinutes ?? 30))}" style="max-width:160px" /></div>`,
      foot: `<button class="btn" id="tp-cancel">取消</button>
             <button class="btn btn-primary" id="tp-save">保存</button>`
    });
    sub.querySelector('#tp-cancel')?.addEventListener('click', () => closeModelModal(sub));
    sub.querySelector('#tp-save')?.addEventListener('click', async () => {
      try {
        await postConfigPatch({
          store: {
            historyCount: clampInt(sub.querySelector('#tp-historycount')?.value, 1, 500, 80),
            promptAnchor: {
              enabled: sub.querySelector('#tp-anchor')?.checked === true,
              maxExtraRead: clampInt(sub.querySelector('#tp-anchor-extra')?.value, 1, 50, 5)
            },
            keywords: String(sub.querySelector('#tp-keywords')?.value || '').split('\n').map((x) => x.trim()).filter(Boolean)
          },
          chatActive: {
            enabled: sub.querySelector('#tp-chatactive')?.checked === true,
            ttlMinutes: Math.min(240, Math.max(1, Number(sub.querySelector('#tp-chatactive-ttl')?.value) || 30))
          }
        });
        closeModelModal(sub);
        mountSessionRestoreButton();
        renderSettings();
      } catch (e) {
        alert(`保存档位参数失败：${e.message}`);
      }
    });
  }

  const peakBtn = ctrl('#ac-peak-btn');
  peakBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.target?.closest?.('.switch, input')) return;
    openPeakModal();
  });
  peakBtn?.addEventListener('keydown', (e) => {
    if (e.target !== peakBtn) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPeakModal(); }
  });
  ctrl('#ac-tier-params-btn')?.addEventListener('click', openTierParamsModal);
}


/**
 * 「创建技能 / 创建插件」引导模态框（技能页与插件页标题旁的 ＋ 按钮）。
 *
 * 定位：**引导**而不是代写 —— 控制台无法安全地往磁盘写任意代码，这个弹窗
 * 把用户带到正确的三样东西上：项目自带的脚手架脚本、开发文档、AI 桌面工具
 * 工作流。技能（LLM 型）与插件（确定性型）的文档路径不同，按 kind 切换。
 */
/* ═══ 社区市场：添加模态框 + 上传流程 + 口令安装 ═══
   2026-09-19 新增。所有网络请求走本地后端代理（/api/market/*），
   浏览器不直连官网（CORS 边界 + 凭据不进前端 localStorage）。 */

/** 拉本地已保存的账号凭据列表（{username, savedAt}）。 */
async function fetchMarketAccounts() {
  try {
    const r = await api('/api/market/accounts');
    return r.accounts || [];
  } catch { return []; }
}

/**
 * 「添加技能 / 添加插件」入口模态框：上下两个大按钮。
 * 上面 = 去市场（口令安装），悬停文案「捞点好货」；
 * 下面 = 自己造（原创建引导），悬停文案「我去牛逼」。
 */
function openAddModuleModal(kind) {
  const isSkill = kind === 'skill';
  const name = isSkill ? '技能' : '插件';
  // 双市场：技能页开 skill-market，插件页开 plugin-market（线上两个独立页面）
  const marketUrl = `https://www.kondius.cn/qq-agent/${isSkill ? 'skill-market' : 'plugin-market'}/`;
  const overlay = modelModalShell({
    head: `添加${name}`,
    body: `
      <div class="hint" style="margin-bottom:12px">两种来路：从市场捞现成的，或者自己造一个。</div>
      <div class="addmod-stack">
        <button class="addmod-big" id="addmod-market">
          <span class="addmod-label">看看${name}市场</span>
          <span class="addmod-hover-label">捞点好货</span>
        </button>
        <button class="addmod-big addmod-diy" id="addmod-diy">
          <span class="addmod-label">自己造个${name}</span>
          <span class="addmod-hover-label">我去牛逼</span>
        </button>
      </div>`,
    foot: `<button class="btn" id="addmod-cancel">算了</button>`
  });
  overlay.querySelector('#addmod-market')?.addEventListener('click', () => {
    closeModelModal(overlay);
    window.open(marketUrl, '_blank', 'noopener');
    openInstallCodeModal();
  });
  overlay.querySelector('#addmod-diy')?.addEventListener('click', () => {
    closeModelModal(overlay);
    openCreateModuleGuide(kind);
  });
  overlay.querySelector('#addmod-cancel')?.addEventListener('click', () => closeModelModal(overlay));
  return overlay;
}

/**
 * 口令安装模态框：
 *   · 输入一个口令按回车 → 自动出现下一个输入框（可连续录入多个）
 *   · 点「就这些吧」→ 批量校验 + 逐个安装；失败行变红并就地显示原因
 *   · 全部成功才关闭弹窗；有失败保留弹窗，可修改后重试
 * 类型（技能/插件）由服务器决定，会装进各自的仓库页。
 */
function openInstallCodeModal() {
  let codeRows = [];   // [{ code, status: 'idle'|'installing'|'ok'|'bad', entry, error }]
  let busy = false;
  const overlay = modelModalShell({
    head: '口令安装',
    body: `
      <div class="hint" style="margin-bottom:10px">
        在市场页找到想要的技能/插件，点「复制口令！」，把得到的口令填进来。
        <b>输入一个按回车</b>会继续出现下一个输入框，可以连续录多个；输完点「就这些吧」依次安装。
        <span class="muted">（技能口令和插件口令都行 —— 类型由服务器决定，会装进各自的页签）</span>
      </div>
      <div id="ic-rows"></div>
      <div class="hint" id="ic-status" style="margin-top:10px"></div>`,
    foot: `
      <button class="btn btn-primary" id="ic-confirm">就这些吧</button>
      <button class="btn" id="ic-cancel">算了算了</button>`
  });
  const rowsBox = overlay.querySelector('#ic-rows');
  const statusBox = overlay.querySelector('#ic-status');
  const setStatus = (text, isErr = false) => {
    statusBox.textContent = text || '';
    statusBox.style.color = isErr ? 'var(--err)' : '';
  };
  const blankRow = () => ({ code: '', status: 'idle', entry: null, error: '' });

  const renderRows = () => {
    rowsBox.innerHTML = codeRows.map((r, i) => {
      const cls = r.status === 'ok' ? ' ok' : (r.status === 'bad' ? ' bad' : (r.status === 'installing' ? ' checking' : ''));
      const badge = r.status === 'ok'
        ? `<span class="ic-check">✅</span><span class="ic-meta">${esc(r.entry?.name || '')}<span class="muted"> · ${esc(r.entry?.author || '')} · ${r.entry?.type === 'plugin' ? '插件' : '技能'}</span></span>`
        : '';
      const editable = r.status !== 'ok' && !busy;
      return `<div class="ic-row${cls}">
        <div class="ic-line">
          <input type="text" class="ic-input" data-idx="${i}" value="${esc(r.code)}"
            placeholder="${r.status === 'ok' ? '已安装' : '输入口令，回车继续下一个'}"
            autocomplete="off" spellcheck="false" ${editable ? '' : 'readonly'} />
          ${r.status === 'ok' ? '' : `<button class="ic-del" data-idx="${i}" title="删除这行" aria-label="删除第 ${i + 1} 行" ${busy ? 'disabled' : ''}>🗑</button>`}
          ${badge}
        </div>
        ${r.error ? `<div class="ic-err">${esc(r.error)}</div>` : ''}
      </div>`;
    }).join('');

    rowsBox.querySelectorAll('.ic-input').forEach((inp) => {
      inp.addEventListener('input', () => {
        const idx = Number(inp.dataset.idx);
        const row = codeRows[idx];
        if (!row) return;
        row.code = inp.value;
        if (row.status === 'bad') { row.status = 'idle'; row.error = ''; }
      });
      inp.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.isComposing || busy) return;
        e.preventDefault();
        const idx = Number(inp.dataset.idx);
        const row = codeRows[idx];
        if (!row) return;
        const code = inp.value.trim().toUpperCase();
        if (!code) return;
        row.code = code;
        if (row.status === 'bad') { row.status = 'idle'; row.error = ''; }
        // 在最后一行回车才追加新行；中间行回车只跳到下一行
        if (idx === codeRows.length - 1) codeRows.push(blankRow());
        renderRows();
        const inputs = [...rowsBox.querySelectorAll('.ic-input')];
        (inputs[idx + 1] || inputs[idx])?.focus();
      });
    });

    rowsBox.querySelectorAll('.ic-del').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (busy) return;
        const idx = Number(btn.dataset.idx);
        if (codeRows[idx]?.status === 'ok') return;
        codeRows.splice(idx, 1);
        if (!codeRows.length) codeRows.push(blankRow());
        renderRows();
      });
    });
    // 恢复焦点到最后一行（重绘会丢焦点）
    if (!busy) {
      const inputs = [...rowsBox.querySelectorAll('.ic-input')].filter((el) => !el.readOnly);
      const last = inputs[inputs.length - 1];
      if (last && document.activeElement !== last && rowsBox.contains(last)) {
        const focusIdx = last.dataset.idx;
        if (focusIdx != null) last.focus({ preventScroll: true });
      }
    }
  };
  codeRows.push(blankRow());
  renderRows();

  overlay.querySelector('#ic-cancel')?.addEventListener('click', () => {
    if (!busy) closeModelModal(overlay);
  });

  overlay.querySelector('#ic-confirm')?.addEventListener('click', async () => {
    if (busy) return;
    const btn = overlay.querySelector('#ic-confirm');
    // 1) 收集 + 本地格式校验
    const filled = codeRows.filter((r) => String(r.code || '').trim());
    if (!filled.length) { setStatus('先输入至少一个口令，再点「就这些吧」。', true); return; }
    const badFmt = filled.filter((r) => !/^[A-Z0-9]{4,12}$/.test(String(r.code).trim().toUpperCase()));
    if (badFmt.length) {
      for (const r of badFmt) { r.status = 'bad'; r.error = '口令格式无效（4~12 位字母或数字）'; }
      renderRows();
      setStatus(`有 ${badFmt.length} 个口令格式不对，已标红。`, true);
      return;
    }
    // 2) 归一 + 去重
    const seen = new Set();
    const todo = [];
    for (const r of filled) {
      const code = String(r.code).trim().toUpperCase();
      r.code = code;
      if (seen.has(code)) { r.status = 'bad'; r.error = '重复口令（已忽略）'; continue; }
      seen.add(code);
      if (r.status !== 'ok') todo.push(r);
    }
    if (!todo.length) {
      renderRows();
      setStatus('没有需要安装的口令（已成功的不会重复安装）。');
      return;
    }

    busy = true;
    btn.disabled = true;
    setStatus(`正在校验 ${todo.length} 个口令…`);
    renderRows();
    let okCount = 0;
    let failCount = 0;
    try {
      // 3) 批量校验（一次请求拿到 type/name/author，install 时回传给后端）
      let results = [];
      try {
        const vr = await api('/api/market/verify', {
          method: 'POST',
          body: JSON.stringify({ codes: todo.map((r) => r.code) })
        });
        results = vr.results || [];
      } catch (e) {
        for (const r of todo) { r.status = 'bad'; r.error = `校验失败：${String(e?.message || e).slice(0, 100)}`; }
        failCount = todo.length;
        throw e;
      }
      const byCode = new Map();
      results.forEach((hit, idx) => {
        const key = String(hit?.code || todo[idx]?.code || '').toUpperCase();
        if (key) byCode.set(key, hit);
      });
      // 4) 逐个安装（失败不中断后面的）
      for (let i = 0; i < todo.length; i++) {
        const r = todo[i];
        const hit = byCode.get(r.code);
        if (!hit || !hit.ok) {
          r.status = 'bad';
          r.error = String(hit?.error || '口令无效或已下架').slice(0, 120);
          failCount++;
          setStatus(`正在安装 ${i + 1}/${todo.length}：${r.code}（失败）`);
          renderRows();
          continue;
        }
        r.status = 'installing';
        r.error = '';
        r.entry = hit;
        setStatus(`正在安装 ${i + 1}/${todo.length}：${hit.name || r.code}…`);
        renderRows();
        try {
          await api('/api/market/install', {
            method: 'POST',
            body: JSON.stringify({ code: r.code, entry: hit })
          });
          r.status = 'ok';
          r.entry = hit;
          okCount++;
        } catch (e) {
          r.status = 'bad';
          r.error = String(e?.message || e).slice(0, 120);
          failCount++;
        }
        renderRows();
      }
    } catch { /* 校验整批失败：上面已标红，走统一汇总 */ } finally {
      busy = false;
      btn.disabled = false;
      renderRows();
    }

    // 5) 刷新两个仓库页（安装的类型可能在另一页）
    await Promise.allSettled([
      loadModulePage('skill', { rescan: true }),
      loadModulePage('plugin', { rescan: true })
    ]);
    if (failCount === 0) {
      setStatus(`全部安装成功（${okCount} 个），正在关闭…`);
      setTimeout(() => closeModelModal(overlay), 700);
    } else {
      setStatus(`安装完成：成功 ${okCount} 个，失败 ${failCount} 个；红色行可修改后重试。`, true);
    }
  });
  return overlay;
}

/**
 * 上传流程模态框（点卡片 ⬆ 钮进入）：
 *   第一步：无凭据 → 登录/注册；第二步：有凭据 → 列表选择；
 *   第三步：填展示名/简介 → 后端确认 id → 打包上传 → 待审核提示。
 */
async function openMarketUploadModal(kind, moduleId) {
  const isSkill = kind === 'skill';
  const name = isSkill ? '技能' : '插件';
  const s = (state.skills || []).find((x) => x.id === moduleId);
  const displayName0 = s?.name || moduleId;
  const desc0 = s?.description || '';

  const overlay = modelModalShell({
    head: `上传${name}到市场：${moduleId}`,
    body: `<div class="hint">正在读取本地账号…</div>`,
    foot: ''
  });
  const setBody = (html, foot = '') => {
    overlay.querySelector('.model-modal-body').innerHTML = html;
    const footBox = overlay.querySelector('.model-modal-foot');
    if (footBox) footBox.innerHTML = foot;
  };

  // ── 第一步：登录/注册（无凭据时） ──
  const renderLoginStep = (mode = 'login') => {
    const isLogin = mode === 'login';
    setBody(`
      <div class="hint" style="margin-bottom:10px">
        本机还没有 QQ Agent 账号凭据。上传${name}需要先登录（登录一次后会记住，以后不用再登）。
      </div>
      <div class="field"><label>登录 ID${isLogin ? '' : '（3~24 位，字母/数字/下划线）'}</label>
        <input type="text" id="mu-username" autocomplete="username" placeholder="如 my_bot_fan" /></div>
      ${isLogin ? '' : `
      <div class="field"><label>展示用户名（市场里显示的名字）</label>
        <input type="text" id="mu-displayname" maxlength="24" placeholder="如 小小机器人" /></div>`}
      <div class="field"><label>${isLogin ? '密码' : '设置密码（6~72 位）'}</label>
        <input type="password" id="mu-password" autocomplete="current-password" /></div>
      ${isLogin ? '' : `
      <div class="field"><label>确认密码</label>
        <input type="password" id="mu-password2" autocomplete="new-password" /></div>`}
      <div class="hint" id="mu-login-msg" style="min-height:18px"></div>
      <div class="hint" style="margin-top:6px">
        没有账号？<a href="https://www.kondius.cn/qq-agent/skill-market/" target="_blank" rel="noopener">前往官网注册</a>，
        或直接<span class="link" id="mu-switch-mode">${isLogin ? '在这里注册' : '在这里登录'}</span>。
      </div>`,
      `<button class="btn btn-primary" id="mu-login-go">${isLogin ? '登录' : '注册并登录'}</button>
       <button class="btn" id="mu-login-cancel">取消</button>`);
    const doLogin = async () => {
      const loginId = overlay.querySelector('#mu-username')?.value.trim() || '';
      const displayName = overlay.querySelector('#mu-displayname')?.value.trim() || '';
      const password = overlay.querySelector('#mu-password')?.value || '';
      const password2 = overlay.querySelector('#mu-password2')?.value || '';
      const msg = overlay.querySelector('#mu-login-msg');
      if (!loginId || !password) { msg.textContent = '登录 ID 和密码都要填'; return; }
      if (!isLogin) {
        if (!displayName) { msg.textContent = '展示用户名不能为空'; return; }
        if (password !== password2) { msg.textContent = '两次输入的密码不一致'; return; }
      }
      const go = overlay.querySelector('#mu-login-go');
      go.disabled = true;
      msg.textContent = isLogin ? '正在登录…' : '正在注册…';
      try {
        const payload = isLogin
          ? { loginId, password, mode: 'login' }
          : { loginId, displayName, password, mode: 'register' };
        await api('/api/market/login', { method: 'POST', body: JSON.stringify(payload) });
        msg.textContent = isLogin ? '登录成功' : '注册成功';
        await renderAccountPick();   // 进入第二步
      } catch (e) {
        msg.textContent = `${e?.message || e}`;
        go.disabled = false;
      }
    };
    overlay.querySelector('#mu-login-go')?.addEventListener('click', doLogin);
    overlay.querySelector('#mu-password')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && isLogin) doLogin();
    });
    overlay.querySelector('#mu-password2')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doLogin();
    });
    overlay.querySelector('#mu-login-cancel')?.addEventListener('click', () => closeModelModal(overlay));
    overlay.querySelector('#mu-switch-mode')?.addEventListener('click', () => renderLoginStep(isLogin ? 'register' : 'login'));
  };

  // ── 第二步：选择账号 ──
  const renderAccountPick = async () => {
    const accounts = await fetchMarketAccounts();
    if (!accounts.length) { renderLoginStep(); return; }
    setBody(`
      <div class="hint" style="margin-bottom:10px">本机保存了这些账号，用哪个上传？</div>
      ${accounts.map((a) => `
        <button class="account-pick" data-username="${esc(a.username)}">
          <span class="ap-name">${esc(a.username)}</span>
          <span class="muted">保存于 ${fmtTime(a.savedAt)}</span>
        </button>`).join('')}
      <div class="hint" style="margin-top:8px">
        <span class="link" id="mu-use-other">使用其它账号密码登录（新增一个）</span>
        ${accounts.length > 1 ? ' · ' : ''}
        <span class="link" id="mu-remove-one" style="${accounts.length > 1 ? '' : 'display:none'}">移除一个保存的账号</span>
      </div>`);
    overlay.querySelectorAll('.account-pick').forEach((btn) => {
      btn.addEventListener('click', () => renderPublishStep(btn.dataset.username));
    });
    overlay.querySelector('#mu-use-other')?.addEventListener('click', () => renderLoginStep());
    overlay.querySelector('#mu-remove-one')?.addEventListener('click', async () => {
      const accounts2 = await fetchMarketAccounts();
      if (accounts2.length <= 1) return;
      const who = await uiPrompt(`要移除哪个账号？\n${accounts2.map((a, i) => `${i + 1}. ${a.username}`).join('\n')}\n（输入序号或用户名）`);
      if (!who) return;
      const target = /^\d+$/.test(who.trim()) ? accounts2[Number(who.trim()) - 1]?.username : who.trim();
      if (!target || !accounts2.some((a) => a.username === target)) { alert('没找到这个账号'); return; }
      await api('/api/market/logout', { method: 'POST', body: JSON.stringify({ username: target }) });
      await renderAccountPick();
    });
  };

  // ── 第三步：填信息 + 确认上传 ──
  const renderPublishStep = (accountUsername) => {
    setBody(`
      <div class="hint" style="margin-bottom:10px">
        以 <b>${esc(accountUsername)}</b> 的名义上传 <b>${esc(moduleId)}</b>。如果市场上已存在同 id 的条目，上传会被拒绝（换一个 id 再试）。
      </div>
      <div class="field"><label>展示名</label>
        <input type="text" id="mu-name" value="${esc(displayName0)}" maxlength="60" /></div>
      <div class="field field--wide"><label>简介</label>
        <textarea id="mu-desc" rows="3" maxlength="500">${esc(desc0)}</textarea></div>
      <div class="hint" id="mu-pub-msg" style="min-height:18px"></div>
      <div class="hint" style="margin-top:6px">
        ⚠️ 打包上传的是 <code>${isSkill ? 'skills' : 'plugins'}/${esc(moduleId)}/</code> 整个目录。
        请先确认里面没有 API Key、Cookie 等私密信息 —— 审核通过后所有人都能下载。
      </div>`,
      `<button class="btn btn-primary" id="mu-pub-go">打包上传</button>
       <button class="btn" id="mu-pub-cancel">取消</button>`);
    overlay.querySelector('#mu-pub-cancel')?.addEventListener('click', () => closeModelModal(overlay));
    overlay.querySelector('#mu-pub-go')?.addEventListener('click', async () => {
      const go = overlay.querySelector('#mu-pub-go');
      const msg = overlay.querySelector('#mu-pub-msg');
      const displayName = overlay.querySelector('#mu-name')?.value.trim() || '';
      const description = overlay.querySelector('#mu-desc')?.value.trim() || '';
      if (!displayName) { msg.textContent = '展示名不能为空'; return; }
      // 人机验证：远端市场对发布强制验签，通过后把 captchaVerifyParam 随上传透传
      go.disabled = true;
      msg.textContent = '请完成人机验证…';
      showCaptcha((captchaVerifyParam) => {
        go.disabled = false;
        if (captchaVerifyParam instanceof Error) { msg.textContent = captchaVerifyParam.message; return; }
        doPublish(captchaVerifyParam);
      });
    });

    async function doPublish(captchaVerifyParam) {
      const go = overlay.querySelector('#mu-pub-go');
      const msg = overlay.querySelector('#mu-pub-msg');
      const displayName = overlay.querySelector('#mu-name')?.value.trim() || '';
      const description = overlay.querySelector('#mu-desc')?.value.trim() || '';
      go.disabled = true;
      msg.textContent = '正在打包并上传…';
      try {
        await api('/api/market/publish', {
          method: 'POST',
          body: JSON.stringify({ kind, id: moduleId, displayName, description, accountUsername, captchaVerifyParam })
        });
        setBody(`
          <div class="hint" style="margin:8px 0">
            ✅ 上传完成！<b>${esc(moduleId)}</b> 已进入<b>待审核</b>状态 ——
            审核通过后才会出现在市场，并生成「复制口令！」按钮。
          </div>
          <div class="hint">可以关闭这个窗口，或去 <a href="https://www.kondius.cn/qq-agent/skill-market/" target="_blank" rel="noopener">市场页面</a> 看看进展。</div>`,
          `<button class="btn" id="mu-done">知道了</button>`);
        overlay.querySelector('#mu-done')?.addEventListener('click', () => closeModelModal(overlay));
      } catch (e) {
        // 409（id 重复）等服务端错误直接显示人话文案
        msg.textContent = `${e?.message || e}`;
        go.disabled = false;
      }
    }
  };

  // 入口分流
  const accounts = await fetchMarketAccounts();
  if (accounts.length) await renderAccountPick();
  else renderLoginStep();
  return overlay;
}

/**
 * 「自己造个技能/插件」引导（2026-09-19 零门槛版）。
 *
 * 面向完全非技术人员：没有命令行、不用找文件夹、不用懂"放进目录"。
 * 全部工作交给一段**复制出去的提示词**：用户把它粘进任意 AI 桌面工具
 * （ZCode / WorkBuddy / Qoder / DeepSeek Harness…），AI 会自己——
 *   ① 找到项目里的开发文档并读懂
 *   ② 通过提问确认用户想要什么、并判定该做成技能还是插件（多数人分不清）
 *   ③ 按文档规范生成 skill.json/plugin.json + index.js
 *   ④ 直接把文件写进 skills/<id>/ 或 plugins/<id>/（热重载自动生效）
 *
 * 提示词里写死了"三步自检"（类型判定 → 文档路径 → 落盘位置），
 * 用户不需要理解其中任何一个术语。
 */
/**
 * 从 /api/status 的 dataDir 推导项目根目录。
 * dataDir 形如 <根>/data 或 <根>/data-2（第二实例）——去掉末尾的 data 段。
 * 拿不到（status 未加载等）返回空串，提示词里走"询问用户"兜底。
 */
function detectProjectRoot() {
  const dir = String(state.status?.dataDir || '');
  if (!dir) return '';
  const norm = dir.replace(/[\\/]+$/, '');
  const m = /[\\/]data(-\d+)?$/i.exec(norm);
  return m ? norm.slice(0, m.index) : norm;
}

function buildModuleCreationPrompt(kind) {
  const isSkill = kind === 'skill';
  // 引导 AI 从"用户点的是技能页还是插件页"出发，但**允许 AI 推翻**——
  // 用户多数分不清两型，点错入口是常态；判定权交给读完了文档的 AI。
  const entryHint = isSkill
    ? '用户是从「技能」页点进来的（他大概率想要一个技能，但也可能点错了，需要你判定）'
    : '用户是从「插件」页点进来的（他大概率想要一个插件，但也可能点错了，需要你判定）';
  // 项目根：拿到了就直接给 AI 绝对路径（省掉 AI 全盘摸索）；拿不到就让 AI 问。
  const root = detectProjectRoot();
  const locateBlock = root
    ? `这个项目就安装在我电脑的这个文件夹里（直接用，不用再找）：
${root}
文档在它下面的 doc/extend_development/ 里，技能/插件目录分别是它下面的 skills/ 和 plugins/。`
    : `先问我一句"QQ Agent 装在哪个文件夹"（我不知道的话，就找桌面或开始菜单里的「QQ Agent」快捷方式 → 右键 → 打开文件所在位置）。拿到项目文件夹后再继续。`;
  return `我电脑上有一个叫「QQ Agent」的 QQ 机器人项目，我想给它加一个新功能，但我不会写代码。请你帮我从头到尾做完，包括把文件放到位。下面是给你的完整工作说明：

【第零步：定位项目】
${locateBlock}

【第一步：先读懂文档】
读取项目里 doc/extend_development/ 目录下的这些文档：
- skill-development.md（技能开发规范）
- plugin-development.md（插件开发规范）
- skill-reference.md（API 完整参考，必读）
- 如果要操作 QQ 本身（查群成员、禁言、发文件等），还要读 snowluma-capabilities.md
先读完再动手。文档里写全了格式要求、API 用法和常见的坑，不按文档做的产物会静默失效（不报错、就是没反应）。

【第二步：搞清楚我要什么】
${entryHint}。
"技能"和"插件"是两种不同的东西（文档第 0 节有判定方法），大多数人分不清，所以：
- 先问清楚我想要这个功能做什么、什么时候触发、要不要机器人"动脑子"判断；
- 然后按文档的判定方法决定做成技能（skills/ 目录）还是插件（plugins/ 目录），并告诉我你的判定和理由；
- 我说不上来的时候，用文档里的"三问判断法"引导我。

【第三步：生成并落盘】
确定类型后：
1. 按对应文档的规范，生成完整可运行的文件（技能是 skills/<id>/skill.json + index.js，插件是 plugins/<id>/plugin.json + index.js）；
2. <id> 用一个简短的小写英文标识（如 my-weather），不要用中文；
3. 把文件直接写到项目对应的目录里去（技能 → skills/<id>/，插件 → plugins/<id>/）。这个项目开着热重载，文件落盘后会自动加载，不需要我重启或刷新；
4. 写完后告诉我：生成了什么、放在哪、回到 QQ Agent 的「技能」或「插件」页签应该看到什么。

【如果出了问题】
生成后如果 QQ Agent 控制台的技能/插件页显示加载失败，把页面上显示的错误原因原样发给我，我来贴给你修（文档里有常见失败对照表）。

现在开始：先简短地问我"你想让机器人学会什么"，然后按上面的流程走完全程。不要让我做任何技术操作。`;
}

function openCreateModuleGuide(kind) {
  const isSkill = kind === 'skill';
  const name = isSkill ? '技能' : '插件';
  const prompt = buildModuleCreationPrompt(kind);
  const overlay = modelModalShell({
    head: `自己造个${name}`,
    body: `
      <div class="hint" style="margin-bottom:12px">
        不会写代码？没问题。把下面这段提示词复制出来，粘贴到<b>任何</b>一个 AI 桌面工具里
        （ZCode、WorkBuddy、Qoder、DeepSeek Harness 之类的都行），
        然后告诉它你想要什么功能——它会问清楚需求、读文档、把做好的${name}直接放进项目里，
        你回到这个页面点「刷新」就能看到。<b>全程不需要你碰任何文件夹。</b>
      </div>
      <pre class="guide-code" id="cmg-prompt" style="max-height:220px;overflow:auto;user-select:all;white-space:pre-wrap;word-break:break-all">${esc(prompt)}</pre>
      <div class="hint" id="cmg-copied" style="min-height:18px;color:var(--green)"></div>`,
    foot: `<button class="btn btn-primary" id="cmg-copy">📋 一键复制提示词</button>
           <button class="btn" id="cmg-close">关闭</button>`
  });
  overlay.querySelector('#cmg-copy')?.addEventListener('click', async () => {
    // clipboard API 在 Electron 里稳；失败回落到选中文本让用户 Ctrl+C
    let ok = false;
    try {
      await navigator.clipboard.writeText(prompt);
      ok = true;
    } catch {
      const pre = overlay.querySelector('#cmg-prompt');
      if (pre) {
        const range = document.createRange();
        range.selectNodeContents(pre);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        ok = document.execCommand?.('copy') || false;
      }
    }
    const tip = overlay.querySelector('#cmg-copied');
    if (tip) tip.textContent = ok
      ? '✅ 已复制！现在打开你的 AI 工具（ZCode / WorkBuddy / Qoder…）直接粘贴发送。'
      : '复制失败——请手动选中上方文本框里的全部内容按 Ctrl+C 复制。';
  });
  overlay.querySelector('#cmg-close')?.addEventListener('click', () => closeModelModal(overlay));
}
