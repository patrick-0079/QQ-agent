/* 记忆与存档优化 · 控制台界面（渲染进程侧）
 *
 * v2.1.0 —— 接管原有的「记忆」页（不新开页签），并补上三件使用体验上的事：
 *   ① **右上角常驻状态区**：任务进度 / 限流排队 / 最近一次操作结论（成功也报，不只报错）、
 *      专用模型开关，还有「刷新状态」按钮。每 2.5 秒自动刷新一次（只在记忆页轮询）。
 *   ② **留在原地**：任何改动之后重画都保持滚动位置与折叠状态，连着改十条也不用重新翻。
 *   ③ 批量压缩标签被限流时，任务会自动转入"每 30 秒一个人"的排队模式，
 *      状态区显示还剩几个、下一个几秒后、以及谁失败了（点开看原因）。
 *
 * 结构与类名尽量沿用核心那一套（.detail-header / .collapsible.mem-fold / .mem-who /
 * .mem-actions / .coll-body / .btn / .badge / .inp / .muted），字体与主题自动一致。
 * 改代码要改插件目录里的 host/panel.js（插件每次激活都会覆盖 ui/ 下的副本）。
 */
(function () {
  'use strict';

  var ACTION = '/api/skills/memory-plus/action/';
  var SNAP_URL = '/memory-plus-data.json';
  var FALLBACK_KINDS = {
    general: '一般观察', appointment: '约定/待办', preference: '偏好', fact: '事实', relation: '关系'
  };

  var S = {
    snapshot: null,
    cfg: null,
    providers: null,
    members: {},        // chatKey -> 核心成员数组（长期记忆）
    status: null,       // 最近一次 status 快照（状态区用它）
    archiveOpen: false,
    pollTimer: null,
    lastActive: false,
    installed: false
  };

  var lastRenderedChat = '';

  // ── 基础工具 ────────────────────────────────────────────────────────
  function q1(sel, root) { return (root || document).querySelector(sel); }
  function qa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) {
    if (typeof window.esc === 'function') return window.esc(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmt(ts) {
    var n = Number(ts) || 0;
    if (!n) return '—';
    if (typeof window.fmtTime === 'function') { try { return window.fmtTime(n); } catch (e) { /* 兜底 */ } }
    var d = new Date(n);
    var p = function (x) { return String(x).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function keyToPath(k) { return String(k || '').replace(':', '_'); }
  function chatTitle(k) {
    try {
      if (typeof window.formatChatTitle === 'function' && typeof window.chatNameOf === 'function') {
        return window.formatChatTitle(k, window.chatNameOf(k));
      }
    } catch (e) { /* 兜底 */ }
    return k;
  }
  function kindLabel(kind) {
    var map = (S.snapshot && S.snapshot.kindLabels) || FALLBACK_KINDS;
    return map[kind] || FALLBACK_KINDS[kind] || '一般观察';
  }
  function kindOption(v) { return kindLabel(v) + '（' + v + '）'; }
  function coreState() {
    try { return (typeof state !== 'undefined' && state) ? state : null; } catch (e) { return null; }
  }
  function currentChatKey() {
    var st = coreState();
    return (st && st.currentMemoryChatKey) || lastRenderedChat || '';
  }
  function errText(status, data, raw) {
    if (data && typeof data === 'object') {
      if (data.error) return String(data.error);
      if (data.hint) return String(data.hint);
      try { return JSON.stringify(data).slice(0, 300); } catch (e) { /* ignore */ }
    }
    return (raw ? String(raw).slice(0, 300) : ('HTTP ' + status));
  }

  async function act(key, body) {
    var r = await fetch(ACTION + encodeURIComponent(key), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    var text = '';
    try { text = await r.text(); } catch (e) { text = ''; }
    var data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    if (r.status === 404) {
      throw new Error('动作路由不可用（HTTP 404）：这台机器上「插件动作路由」的补丁可能被应用更新覆盖了。'
        + '重跑一次安装根目录的 data\\apply-module-manager-fix.mjs 再刷新本页即可；长期记忆的增删改不受影响。');
    }
    if (!r.ok || (data && data.ok === false)) throw new Error(errText(r.status, data, text));
    return data || {};
  }

  async function core(pathname, opts) {
    if (typeof window.api === 'function') return window.api(pathname, opts);
    var r = await fetch(pathname, opts);
    var data = null;
    try { data = await r.json(); } catch (e) { data = null; }
    if (!r.ok) throw new Error(errText(r.status, data, ''));
    return data;
  }
  function confirmBox(msg) {
    if (typeof window.uiConfirm === 'function') return window.uiConfirm(msg);
    return Promise.resolve(window.confirm(msg));
  }

  // ── 视图位置保持（"改一条想连续操作"的关键）────────────────────────
  function captureView() {
    var detail = q1('#memory-detail');
    var collapsed = {};
    qa('.mem-fold[data-uid]', detail || document).forEach(function (el) {
      if (!el.open) collapsed[el.getAttribute('data-uid')] = true;
    });
    return {
      top: detail ? detail.scrollTop : 0,
      win: (window.scrollY || window.pageYOffset || 0),
      collapsed: collapsed
    };
  }
  function restoreView(v) {
    if (!v) return;
    var apply = function () {
      var detail = q1('#memory-detail');
      if (detail) {
        qa('.mem-fold[data-uid]', detail).forEach(function (el) {
          if (v.collapsed[el.getAttribute('data-uid')]) el.open = false;
        });
        detail.scrollTop = v.top;
      }
      try { window.scrollTo(0, v.win); } catch (e) { /* ignore */ }
    };
    apply();
    try { window.requestAnimationFrame(apply); } catch (e) { /* ignore */ }
    setTimeout(apply, 60);
    setTimeout(apply, 200);
  }
  /** 跑一段会改 DOM 的代码，前后自动保位置。 */
  async function keepingView(fn) {
    var v = captureView();
    var r = await fn();
    restoreView(v);
    return r;
  }

  // ── 数据 ────────────────────────────────────────────────────────────
  async function loadSnapshot() {
    var r = await fetch(SNAP_URL + '?t=' + Date.now(), { cache: 'no-store' });
    S.snapshot = await r.json();
    return S.snapshot;
  }
  function snapChat(chatKey) {
    var chats = (S.snapshot && S.snapshot.chats) || [];
    for (var i = 0; i < chats.length; i += 1) if (chats[i].chatKey === chatKey) return chats[i];
    return null;
  }
  function snapMember(chatKey, uid) {
    var sc = snapChat(chatKey);
    return ((sc && sc.members) || []).filter(function (m) { return String(m.userId) === String(uid); })[0] || null;
  }
  function metaFor(chatKey, content) {
    var sc = snapChat(chatKey);
    var list = (sc && sc.meta) || [];
    for (var i = 0; i < list.length; i += 1) if (list[i].content === content) return list[i];
    return null;
  }
  function coreMember(chatKey, uid) {
    return (S.members[chatKey] || []).filter(function (m) { return String(m.userId) === String(uid); })[0] || null;
  }
  async function loadCoreMembers(chatKey) {
    try {
      var r = await core('/api/memory-files/' + keyToPath(chatKey));
      S.members[chatKey] = (r && r.members) || [];
    } catch (e) {
      S.members[chatKey] = S.members[chatKey] || [];
    }
    return S.members[chatKey];
  }
  async function loadCfg() {
    if (S.cfg) return S.cfg;
    try { S.cfg = await core('/api/config'); } catch (e) { S.cfg = {}; }
    return S.cfg;
  }
  async function loadProviders() {
    if (S.providers) return S.providers;
    try {
      var r = await core('/api/providers');
      S.providers = (r && r.providers) || [];
    } catch (e) { S.providers = []; }
    return S.providers;
  }
  function noteOf(userId) {
    var st = coreState();
    var notes = (S.cfg && S.cfg.memberNotes) || (st && st.config && st.config.memberNotes) || {};
    return notes[String(userId)] || '';
  }
  function nameOf(chatKey, uid) {
    var cm = coreMember(chatKey, uid);
    var sm = snapMember(chatKey, uid);
    return noteOf(uid) || (cm && cm.name) || (sm && sm.name) || String(uid);
  }

  // ── 一、右侧常驻状态区 ──────────────────────────────────────────────
  function statusBarHtml() {
    return [
      '<div class="mp-side" id="mp-statusbar">',
      '  <div class="mp-side-row">',
      '    <span class="mp-dot" id="mp-dot"></span>',
      '    <span class="mp-status-text" id="mp-status-text">就绪</span>',
      '    <button class="btn btn-small" data-mp="refresh-status" title="立刻重新读一次任务进度与记忆数据（不会跳回顶部）">刷新状态</button>',
      '  </div>',
      '  <div class="mp-progress"><i id="mp-bar"></i></div>',
      '  <div class="mp-side-model">',
      '    <span class="muted" style="font-size:12px">整理用模型</span>',
      '    <select class="inp mp-sel" id="mp-provider-sel" title="选一个渠道专门用来压缩标签/判定晋升"><option value="">跟随主模型</option></select>',
      '    <select class="inp mp-sel" id="mp-model-sel"><option value="">（先选渠道）</option></select>',
      '    <button class="btn btn-small" data-mp="save-model">保存</button>',
      '  </div>',
      '  <div class="mp-side-hint muted" id="mp-model-hint"></div>',
      '  <div class="mp-side-hint muted" id="mp-switch-hint"></div>',
      '  <div class="mp-side-fail" id="mp-fail-list"></div>',
      '</div>'
    ].join('\n');
  }

  function renderStatus() {
    var st = S.status || {};
    var dot = q1('#mp-dot');
    var text = q1('#mp-status-text');
    var bar = q1('#mp-bar');
    if (!dot) return;
    var job = st.job || null;
    var q = st.queue || { active: false, remaining: 0, done: 0, failed: [] };
    var last = st.last || null;
    var running = !!st.running;
    var queueing = !!(q.remaining > 0);

    var cls = 'mp-dot';
    var msg = '就绪';
    var pct = 0;
    if (running) {
      cls += ' mp-dot-run';
      msg = '整理中：' + ((job && job.label) || '准备中');
      if (job && job.total) { msg += '（' + job.step + '/' + job.total + '）'; pct = Math.round(100 * job.step / job.total); }
    } else if (queueing) {
      cls += ' mp-dot-queue';
      msg = '限流排队中：还剩 ' + q.remaining + ' 个人，下一个 ' + (q.nextInSec > 0 ? q.nextInSec + ' 秒后' : '马上')
        + '（已完成 ' + q.done + (q.failed && q.failed.length ? '，失败 ' + q.failed.length : '') + '）';
      pct = q.total ? Math.round(100 * q.done / q.total) : 0;
    } else if (last && last.ok === false) {
      cls += ' mp-dot-err';
      msg = '上次操作失败：' + String(last.text || '').slice(0, 160);
    } else if (last && last.text) {
      cls += ' mp-dot-ok';
      msg = '上次操作：' + String(last.text).slice(0, 160);
    }
    dot.className = cls;
    if (text) text.textContent = msg;
    if (bar) {
      bar.style.width = (running || queueing) ? Math.max(3, pct) + '%' : '0%';
      bar.className = (running || queueing) ? 'on' : '';
    }

    var box = q1('#mp-fail-list');
    if (box) {
      var fails = (q.failed || []).slice(0, 12);
      if (!fails.length) box.innerHTML = '';
      else {
        box.innerHTML = '<details class="mp-fail"><summary>有 ' + q.failed.length + ' 个人没成功，点开看是谁、为什么</summary>'
          + fails.map(function (f) {
            return '<div class="mp-fail-item">· ' + esc(nameOf(st.chatKey || '', f.userId)) + '：' + esc(f.error || '未知原因') + '</div>';
          }).join('')
          + '</details>';
      }
    }

    var hint = q1('#mp-model-hint');
    var m = st.model || {};
    if (hint) {
      if (m.error) hint.textContent = '⚠ ' + m.error;
      else if (m.dedicated) hint.textContent = '生效中：专用渠道 ' + (m.provider || '') + ' / 模型 ' + (m.model || '');
      else hint.textContent = '当前跟随主模型（想单独指定就选渠道+模型再保存）';
      hint.style.color = m.error ? 'var(--err)' : '';
    }
    fillModelSelects(m);
    renderSwitchHint(st);
  }

  /** 开关摘要 + 最近一次提示词裁剪情况（一眼看出哪些功能被关了、省了多少）。 */
  function renderSwitchHint(st) {
    var box = q1('#mp-switch-hint');
    if (!box) return;
    var sw = st.switches;
    var lim = st.limits || {};
    var tr = st.trim || {};
    var bits = [];
    if (sw) {
      var onNames = [];
      if (sw.memory) onNames.push('两层记忆');
      if (sw.shortTerm) onNames.push('短期记忆');
      if (sw.labelFirst) onNames.push('标签优先');
      if (sw.archiveTools) onNames.push('记录检索');
      if (sw.historyTrim) onNames.push('记录裁剪×' + (lim.historyLimit || 0));
      if (sw.systemTrim) onNames.push('段落裁剪');
      if (sw.toolGuard) onNames.push('工具护栏' + (lim.blockedTools && lim.blockedTools.length ? '（拦 ' + lim.blockedTools.join('/') + '）' : ''));
      if (sw.toolCap) onNames.push('结果截断×' + (lim.toolResultMaxChars || 0)
        + (lim.capOnlyTools && lim.capOnlyTools.length ? '（只截 ' + lim.capOnlyTools.join('/') + '）' : '（全部工具）'));
      var offNames = [];
      if (!sw.memory) offNames.push('两层记忆');
      if (!sw.shortTerm) offNames.push('短期记忆');
      if (!sw.labelFirst) offNames.push('标签优先');
      if (!sw.archiveTools) offNames.push('记录检索');
      if (!sw.historyTrim) offNames.push('记录裁剪');
      if (!sw.systemTrim) offNames.push('段落裁剪');
      if (!sw.toolGuard) offNames.push('工具护栏');
      if (!sw.toolCap) offNames.push('结果截断');
      bits.push('已开：' + (onNames.join('、') || '（无）'));
      if (offNames.length) bits.push('已关：' + offNames.join('、'));
    }
    if (tr.at) {
      var when = new Date(Number(tr.at));
      var p2 = function (n) { return String(n).padStart(2, '0'); };
      var stamp = p2(when.getHours()) + ':' + p2(when.getMinutes());
      bits.push('上次裁剪 ' + stamp + '：记录少带 ' + (tr.history || 0) + ' 条'
        + ((tr.sections && tr.sections.length) ? '，裁掉段落 ' + tr.sections.join('、') : ''));
    }
    // 实发内容摘要：控制台「会话」页显示的是核心原文（钩子之前），这里给的是**真正发出去**的
    var se = st.sent || {};
    if (se.at) {
      var mem = se.memory || {};
      var memTxt = mem.members
        ? ('记忆段：' + mem.members + ' 人' + (mem.labelOnly ? '（其中 ' + mem.labelOnly + ' 人走标签档）' : '（全文档）'))
        : '记忆段：未替换（核心原文）';
      var histTxt = se.historyCut
        ? ('已读信息：' + se.historyKept + ' 条（省掉 ' + se.historyCut + ' 条）')
        : '已读信息：未裁剪';
      bits.push('📤 上轮实发 ' + (se.total || 0) + ' 字 ｜ ' + memTxt + ' ｜ ' + histTxt
        + ((se.sections && se.sections.length) ? ' ｜ 裁段 ' + se.sections.join('、') : ''));
    }
    bits.push('其它开关在「插件 → 记忆与存档优化 → 设置」里');
    box.textContent = bits.join('\n');
    box.style.whiteSpace = 'pre-line';
    box.style.color = '';
  }

  function fillModelSelects(m) {
    var sel = q1('#mp-provider-sel');
    var msel = q1('#mp-model-sel');
    if (!sel || !msel) return;
    var providers = S.providers || [];
    if (sel.getAttribute('data-filled') !== '1') {
      sel.innerHTML = '<option value="">跟随主模型</option>'
        + providers.map(function (p) {
          return '<option value="' + esc(p.id) + '">' + esc(p.displayName || p.id) + '</option>';
        }).join('');
      sel.setAttribute('data-filled', '1');
      sel.addEventListener('change', function () { fillModelOptions(sel.value, ''); });
    }
    if (document.activeElement !== sel && sel.value !== (m.provider || '')) sel.value = m.provider || '';
    fillModelOptions(sel.value, m.model || '');
  }

  function fillModelOptions(providerId, keepModel) {
    var msel = q1('#mp-model-sel');
    if (!msel) return;
    var p = (S.providers || []).filter(function (x) { return String(x.id) === String(providerId); })[0];
    if (!p) { msel.innerHTML = '<option value="">跟随主模型</option>'; msel.value = ''; return; }
    var models = Array.isArray(p.models) ? p.models : [];
    var names = p.modelNames || {};
    var html = '<option value="">（这个渠道的模型）</option>'
      + models.map(function (id) {
        return '<option value="' + esc(id) + '">' + esc(names[id] || id) + '</option>';
      }).join('');
    var target = String(keepModel || '');
    if (target && models.indexOf(target) < 0) {
      // 当前配置里的模型不在这个渠道的列表里，也保留一项，免得被静默改掉
      html += '<option value="' + esc(target) + '">' + esc(target) + '（当前配置）</option>';
    }
    msel.innerHTML = html;
    if (document.activeElement !== msel) msel.value = target;
  }

  async function saveModel() {
    var sel = q1('#mp-provider-sel');
    var msel = q1('#mp-model-sel');
    var provider = String((sel && sel.value) || '');
    var model = String((msel && msel.value) || '');
    try {
      await core('/api/skills/memory-plus', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ settings: { modelProvider: provider, modelName: model } })
      });
      await pollStatus(true);
      appendLocalNote(provider && model ? ('专用模型已保存：' + provider + ' / ' + model) : '已改为跟随主模型');
    } catch (e) {
      appendLocalNote('保存失败：' + e.message, true);
    }
  }

  /** 状态区直接改写一句话（比如"已删除 3 条"），不用等下一轮轮询。 */
  function appendLocalNote(text, isErr) {
    var el = q1('#mp-status-text');
    if (el) {
      el.textContent = String(text).slice(0, 220);
      var dot = q1('#mp-dot');
      if (dot) dot.className = 'mp-dot ' + (isErr ? 'mp-dot-err' : 'mp-dot-ok');
    }
    if (isErr) {
      var box = q1('#mp-fail-list');
      if (box) box.innerHTML = '<div class="mp-fail-item">' + esc(text) + '</div>';
    }
  }
  function setStatus(text, isErr) { appendLocalNote(text, isErr); }

  // ── 二、状态轮询（进度常驻显示）──────────────────────────────────────
  async function pollStatus(force) {
    var st = coreState();
    if (!force && st && st.tab !== 'memory') return null;
    var key = currentChatKey();
    try {
      var r = await act('status', { chatKey: key });
      var wasActive = S.lastActive;
      S.status = r;
      S.lastActive = !!(r.running || (r.queue && r.queue.active));
      renderStatus();
      if (wasActive && !S.lastActive) {
        // 任务刚跑完 → 数据可能变了，刷新一次并留在原地
        await refreshAll();
        try {
          var r2 = await act('status', { chatKey: key });
          S.status = r2;
          renderStatus();
        } catch (e) { /* ignore */ }
      }
      return r;
    } catch (e) {
      return null;
    }
  }

  function startPoll() {
    if (S.pollTimer) return;
    S.pollTimer = setInterval(function () {
      var st = coreState();
      if (!st || st.tab !== 'memory') return;   // 只在记忆页轮询
      pollStatus(false);
    }, 2500);
  }

  // ── 三、整页刷新（保持位置）─────────────────────────────────────────
  async function refreshAll() {
    var chatKey = currentChatKey();
    if (!chatKey) return;
    await keepingView(async function () {
      await loadSnapshot();
      await loadCoreMembers(chatKey);
      await loadProviders();
      await renderDetail(chatKey);
    });
  }

  // ── 四、渲染详情 ────────────────────────────────────────────────────
  function memberBlock(chatKey, uid, cm, sm) {
    var who = nameOf(chatKey, uid);
    var longList = (cm && cm.impressions) || [];
    var shortList = (sm && sm.short) || [];
    var labels = (sm && sm.labels) || [];
    var head = [
      '<details class="collapsible mem-fold" open data-uid="' + esc(uid) + '">',
      '  <summary>',
      '    <span class="mem-who">' + esc(who) + ' <span class="muted">(QQ ' + esc(uid) + ')</span>',
      '      （长期 ' + longList.length + ' · 短期 ' + shortList.length + '）</span>',
      '    <span class="mem-actions">',
      '      <button class="btn btn-small" data-mp="edit-all">编辑</button>',
      '      <button class="btn btn-small" data-mp="refresh">更新记忆</button>',
      '      <button class="btn btn-small" data-mp="tags">压缩标签</button>',
      '      <button class="btn btn-small btn-danger" data-mp="del-all">删除</button>',
      '    </span>',
      '  </summary>',
      '  <div class="coll-body">'
    ].join('\n');
    var body = [];

    body.push('<div class="mp-row"><span class="mp-row-k">标签</span><span class="mp-tags">');
    if (!labels.length) body.push('<span class="muted" style="font-size:12px">还没有标签（点「压缩标签」让模型生成，或手工加）</span>');
    labels.forEach(function (l) {
      body.push('<span class="badge' + (l.pinned ? ' ok' : '') + '">' + esc(l.tag)
        + '<span class="mp-x" data-mp="tag-del" data-tag="' + esc(l.tag) + '" title="删除标签">×</span></span>');
    });
    body.push('<input class="inp mp-tag-in" data-mp="tag-in" placeholder="加标签" size="6" />');
    body.push('<button class="btn btn-small" data-mp="tag-add">加</button>');
    body.push('</span></div>');

    body.push('<div class="mp-sec">长期记忆 · 稳定，可以直接引用（' + longList.length + ' 条，只能改 / 删）</div>');
    if (!longList.length) body.push('<div class="muted" style="font-size:12px;padding:2px 0">还没有长期记忆</div>');
    longList.forEach(function (it, idx) {
      var meta = metaFor(chatKey, it.content) || {};
      var appt = meta.kind === 'appointment';
      var hits = Number(meta.hits) || 0;
      body.push('<div class="mp-line" data-long-idx="' + idx + '">');
      body.push('<span class="mp-line-t">');
      if (appt) body.push('<span class="badge" style="color:var(--warn);border-color:var(--warn-line)">约定·原文</span> ');
      body.push(esc(it.content));
      if (hits > 0) body.push(' <span class="muted" style="font-size:11px">提及×' + hits + '</span>');
      if (meta.reason) body.push(' <span class="muted" style="font-size:11px" title="晋升理由">· ' + esc(meta.reason) + '</span>');
      body.push('</span>');
      body.push('<span class="mp-line-a">');
      body.push('<button class="btn btn-small" data-mp="long-edit" data-idx="' + idx + '">改</button>');
      body.push('<button class="btn btn-small btn-danger" data-mp="long-del" data-idx="' + idx + '">删</button>');
      body.push('</span></div>');
    });

    body.push('<div class="mp-sec">短期记忆 · 最近才形成，会过期（' + shortList.length + ' 条）</div>');
    if (!shortList.length) body.push('<div class="muted" style="font-size:12px;padding:2px 0">还没有短期记忆</div>');
    shortList.slice().sort(function (a, b) { return (Number(b.hits) || 0) - (Number(a.hits) || 0); }).forEach(function (s) {
      var hits = Math.max(0, Number(s.hits) || 0);
      var appt = s.kind === 'appointment';
      var left = '';
      try {
        var ttl = (S.snapshot && S.snapshot.settings && S.snapshot.settings.shortTtlDays) || 14;
        left = Math.max(0, Math.ceil((Number(s.createdAt) + ttl * 86400000 - Date.now()) / 86400000)) + ' 天后过期';
      } catch (e) { /* 不影响展示 */ }
      body.push('<div class="mp-line" data-short-id="' + esc(s.id) + '">');
      body.push('<span class="mp-line-t">');
      if (appt) body.push('<span class="badge" style="color:var(--warn);border-color:var(--warn-line)">约定</span> ');
      body.push(esc(s.content));
      body.push(' <span class="muted" style="font-size:11px">' + esc(kindLabel(s.kind))
        + (hits > 0 ? '，提及×' + hits : '') + (left ? '，' + left : '') + '</span>');
      body.push('</span>');
      body.push('<span class="mp-line-a">');
      body.push('<button class="btn btn-small" data-mp="promote">晋升</button>');
      body.push('<button class="btn btn-small btn-danger" data-mp="short-del">删</button>');
      body.push('</span></div>');
    });

    body.push('<div class="mp-row mp-add-row">');
    body.push('<input class="inp mp-add-in" data-mp="add-in" placeholder="记一条短期记忆…（回车也可）" />');
    body.push('<select class="inp mp-add-kind" data-mp="add-kind">');
    ['general', 'appointment', 'preference', 'fact', 'relation'].forEach(function (k) {
      body.push('<option value="' + k + '">' + esc(kindOption(k)) + '</option>');
    });
    body.push('</select>');
    body.push('<button class="btn btn-small" data-mp="add-save">记下</button>');
    body.push('</div>');

    return head + body.join('') + '</div></details>';
  }

  function archiveBlock(chatKey) {
    var ov = ((S.snapshot && S.snapshot.archive && S.snapshot.archive.overview) || [])
      .filter(function (o) { return o.chatKey === chatKey; })[0];
    var sweep = (S.snapshot && S.snapshot.archive && S.snapshot.archive.sweep) || {};
    var thisYear = new Date().getFullYear();
    var years = [];
    for (var y = thisYear; y >= thisYear - 6; y -= 1) years.push(y);
    var daySel = function (name) {
      var out = ['<select class="inp mp-date" data-mp="' + name + '-y"><option value="">年</option>'];
      years.forEach(function (yy) { out.push('<option value="' + yy + '">' + yy + '</option>'); });
      out.push('</select><select class="inp mp-date" data-mp="' + name + '-m"><option value="">月</option>');
      for (var m = 1; m <= 12; m += 1) out.push('<option value="' + m + '">' + m + ' 月</option>');
      out.push('</select><select class="inp mp-date" data-mp="' + name + '-d"><option value="">日</option>');
      for (var d = 1; d <= 31; d += 1) out.push('<option value="' + d + '">' + d + ' 日</option>');
      out.push('</select>');
      return out.join('');
    };
    return [
      '<details class="collapsible mem-fold mp-archive"', S.archiveOpen ? ' open' : '', '>',
      '  <summary><span class="mem-who">聊天记录存档',
      ov ? '（' + ov.count + ' 条，' + (ov.bytes / 1024).toFixed(0) + ' KB，' + esc(ov.firstAt || '—') + ' ~ ' + esc(ov.lastAt || '—') + '）' : '（这个会话还没有本地存档）',
      '</span><span class="mem-actions"><span class="muted" style="font-size:11px">上次自动清理 ' + esc(sweep.lastSweepAt ? fmt(sweep.lastSweepAt) : '从未') + '</span></span></summary>',
      '  <div class="coll-body">',
      '    <div class="mp-row"><span class="mp-row-k">快删</span>',
      '      <button class="btn btn-small" data-mp="quick" data-days="7">删 7 天前</button>',
      '      <button class="btn btn-small" data-mp="quick" data-days="30">删 30 天前</button>',
      '      <button class="btn btn-small" data-mp="quick" data-days="90">删 90 天前</button>',
      '      <button class="btn btn-small" data-mp="quick" data-days="180">删半年之前</button>',
      '      <button class="btn btn-small btn-danger" data-mp="quick" data-days="0">全删</button>',
      '    </div>',
      '    <div class="mp-row"><span class="mp-row-k">自选</span> 从 ', daySel('from'), ' 到 ', daySel('to'),
      '      <button class="btn btn-small" data-mp="preview">看看命中几条</button>',
      '      <button class="btn btn-small btn-danger" data-mp="prune">删除这些</button>',
      '    </div>',
      '    <div class="mp-row"><span class="mp-row-k"></span>',
      '      <button class="btn btn-small" data-mp="sweep">现在按设置清理一次（保留 ' + esc(String(((S.snapshot && S.snapshot.settings) || {}).archiveRetainDays || 30)) + ' 天）</button>',
      '      <button class="btn btn-small" data-mp="backups">查看可回档的备份</button>',
      '    </div>',
      '    <div class="mp-backups"></div>',
      '    <div class="muted" style="font-size:11px;padding:2px 0">删存档只动机器人本地的记录，QQ 里不会有任何变化；删之前会自动备份，能一键回档。</div>',
      '  </div>',
      '</details>'
    ].join('');
  }

  function questionsBlock(chatKey, questions) {
    var list = (questions || []).filter(function (q) { return q.status !== 'resolved'; });
    if (!list.length) return '';
    return [
      '<details class="collapsible mem-fold" open>',
      '  <summary><span class="mem-who">待你裁决的记忆判定（' + list.length + '）</span></summary>',
      '  <div class="coll-body">',
      list.map(function (q) {
        return '<div class="mp-q" data-qid="' + esc(q.id) + '">'
          + '<span class="badge' + (q.status === 'pending' ? '' : ' ok') + '">' + (q.status === 'pending' ? '等主人回答' : '主人已答') + '</span> '
          + esc(q.question)
          + (q.answer ? '<div class="muted" style="font-size:12px">主人答：' + esc(q.answer) + '</div>' : '')
          + '<div class="mp-row"><input class="inp mp-q-in" placeholder="直接代答 / 给结论" />'
          + '<button class="btn btn-small" data-mp="q-resolve">落定</button></div></div>';
      }).join(''),
      '  </div>',
      '</details>'
    ].join('');
  }

  async function renderDetail(chatKey) {
    var detail = q1('#memory-detail');
    if (!detail || !chatKey) return;
    var view = captureView();
    await loadCfg();
    if (!S.members[chatKey]) await loadCoreMembers(chatKey);
    var coreMembers = S.members[chatKey] || [];
    var sc = snapChat(chatKey);
    var snapMembers = (sc && sc.members) || [];
    var longN = coreMembers.reduce(function (n, m) { return n + ((m.impressions || []).length); }, 0);
    var shortN = snapMembers.reduce(function (n, m) { return n + ((m.short || []).length); }, 0);
    var tagN = snapMembers.reduce(function (n, m) { return n + ((m.labels || []).length); }, 0);
    var last = sc && sc.lastConsolidatedAt ? fmt(sc.lastConsolidatedAt) : '从未';
    var ids = {};
    coreMembers.forEach(function (m) { ids[String(m.userId)] = true; });
    snapMembers.forEach(function (m) { ids[String(m.userId)] = true; });
    var rows = Object.keys(ids).map(function (uid) {
      return memberBlock(chatKey, uid, coreMember(chatKey, uid), snapMember(chatKey, uid));
    }).join('');
    var kind = chatKey.indexOf('group') === 0 ? 'group' : 'private';
    var membersHtml = kind === 'group'
      ? '<div class="field" style="margin:8px 0"><button class="btn btn-small" id="mem-load-members-btn">拉取群成员列表（编辑备注）</button><span id="mem-members-status" class="muted"></span></div><div id="mem-members"></div>'
      : '';
    var roster = (S.status && S.status.roster) || null;
    var rosterHint = (roster && roster.total) ? (' · 群友 ' + roster.total + ' 人 / 有记忆 ' + roster.covered + ' 人') : '';
    detail.innerHTML = [
      '<div class="detail-header mp-hd">',
      '  <div class="mp-hd-main">',
      '    <h2>' + esc(chatTitle(chatKey)) + ' 的记忆</h2>',
      '    <div class="sub">',
      '      <span>长期 ' + longN + ' 条 · 短期 ' + shortN + ' 条 · 标签 ' + tagN + ' 个 · 上次整理 ' + esc(last) + rosterHint + '</span>',
      '      <button class="btn btn-small" data-mp="add-member">＋ 添加记忆</button>',
      '      <button class="btn btn-small" data-mp="consolidate">整理本记忆</button>',
      '      <button class="btn btn-small" data-mp="extract-now" title="立刻让模型回看聊天记录、把新的稳定信息记成短期记忆（平时每 3 小时自动做一次）">立刻提取新记忆</button>',
      '      <button class="btn btn-small" data-mp="core-consolidate">合并去重</button>',
      '      <button class="btn btn-small" data-mp="queue-start" title="一次一个人、间隔 30 秒地重新压缩所有人的标签（限流时的稳妥做法）">全部重压标签</button>',
      '      <button class="btn btn-small" data-mp="queue-clear" title="停掉正在排队的标签任务">停止排队</button>',
      '      <button class="btn btn-small" data-mp="expire">清理过期短期</button>',
      '      <button class="btn btn-small" data-mp="rescan" title="重新加载全部扩展。装了新插件时才需要点；重载期间其它扩展会有一两秒不可用（比如好感度插件），这是宿主的热重载窗口">重新扫描</button>',
      '    </div>',
      '  </div>',
      statusBarHtml(),
      '</div>',
      membersHtml,
      questionsBlock(chatKey, sc && sc.questions),
      rows || '<div class="muted" style="padding:10px">这个会话还没有任何记忆。可以点右上角「＋ 添加记忆」手动记，或点「整理本记忆」让模型从聊天记录里提炼。</div>',
      archiveBlock(chatKey)
    ].join('\n');

    var loadMembersBtn = q1('#mem-load-members-btn');
    if (loadMembersBtn && typeof window.loadGroupMembers === 'function') {
      loadMembersBtn.addEventListener('click', function () { window.loadGroupMembers(chatKey.split(':')[1] || '', chatKey); });
    }
    bindDetail(detail, chatKey);
    lastRenderedChat = chatKey;
    restoreView(view);
    renderStatus();
  }

  // ── 五、交互 ────────────────────────────────────────────────────────
  function memberEl(root, uid) { return q1('.mem-fold[data-uid="' + uid + '"]', root); }

  async function refreshMember(root, chatKey, uid) {
    await keepingView(async function () {
      await loadCoreMembers(chatKey);
      await loadSnapshot();
      var old = memberEl(root, uid);
      var html = memberBlock(chatKey, uid, coreMember(chatKey, uid), snapMember(chatKey, uid));
      if (old) {
        var tmp = document.createElement('div');
        tmp.innerHTML = html;
        old.replaceWith(tmp.firstElementChild);
        bindMember(tmp.firstElementChild, chatKey, uid, root);
      } else {
        await renderDetail(chatKey);
      }
    });
    pollStatus(true);
  }

  function bindMember(el, chatKey, uid, root) {
    if (!el) return;
    var pick = function (name) { return q1('[data-mp="' + name + '"]', el); };
    var longList = function () {
      var cm = coreMember(chatKey, uid);
      return (cm && cm.impressions) || [];
    };

    var editAll = pick('edit-all');
    if (editAll) editAll.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      var cm = coreMember(chatKey, uid) || { userId: uid, name: '', impressions: [] };
      if (typeof window.openMemberImpressModal === 'function') window.openMemberImpressModal(chatKey, cm);
      else setStatus('核心的编辑弹窗不可用（控制台版本不匹配）', true);
    });

    var refreshBtn = pick('refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', async function (e) {
      e.preventDefault(); e.stopPropagation();
      appendLocalNote('已让模型重新分析这个人…');
      try {
        await core('/api/memory-files/consolidate', {
          method: 'POST', body: JSON.stringify({ chatKey: chatKey, userIds: [uid], force: true })
        });
        appendLocalNote('已提交「更新记忆」，结果稍后自动刷新');
      } catch (err) { appendLocalNote('更新失败：' + err.message, true); }
    });

    var tagsBtn = pick('tags');
    if (tagsBtn) tagsBtn.addEventListener('click', async function (e) {
      e.preventDefault(); e.stopPropagation();
      var btn = e.currentTarget;
      btn.disabled = true; btn.textContent = '压缩中…';
      appendLocalNote('正在让模型压缩标签…');
      try {
        var r = await act('labels-suggest', { chatKey: chatKey, userId: uid });
        if (r && r.ok) appendLocalNote('标签已更新：' + (r.tags || []).join(' · '));
        else appendLocalNote('没拿到可用标签：' + ((r && (r.error || r.hint)) || '模型没返回'), true);
        await refreshMember(root, chatKey, uid);
      } catch (err) {
        appendLocalNote('压缩标签失败：' + err.message, true);
      } finally {
        btn.disabled = false; btn.textContent = '压缩标签';
      }
    });

    var delAll = pick('del-all');
    if (delAll) delAll.addEventListener('click', async function (e) {
      e.preventDefault(); e.stopPropagation();
      if (!(await confirmBox('删除 ' + nameOf(chatKey, uid) + ' 的全部长期记忆？\n\n（短期记忆与标签还在，可在下方单独删）'))) return;
      try {
        await core('/api/memory-files/' + keyToPath(chatKey) + '/members/' + encodeURIComponent(uid), { method: 'DELETE', body: '{}' });
        appendLocalNote('已删除该成员的长期记忆');
        await refreshMember(root, chatKey, uid);
      } catch (err) { appendLocalNote('删除失败：' + err.message, true); }
    });

    var tagAdd = pick('tag-add');
    if (tagAdd) tagAdd.addEventListener('click', async function (e) {
      e.preventDefault(); e.stopPropagation();
      var input = pick('tag-in');
      var v = String((input && input.value) || '').trim();
      if (!v) return;
      try {
        await act('label-add', { chatKey: chatKey, userId: uid, tag: v });
        await refreshMember(root, chatKey, uid);
      } catch (err) { appendLocalNote('加标签失败：' + err.message, true); }
    });
    qa('[data-mp="tag-del"]', el).forEach(function (x) {
      x.addEventListener('click', async function (e) {
        e.preventDefault(); e.stopPropagation();
        try {
          await act('label-delete', { chatKey: chatKey, userId: uid, tag: x.getAttribute('data-tag') });
          await refreshMember(root, chatKey, uid);
        } catch (err) { appendLocalNote('删标签失败：' + err.message, true); }
      });
    });

    // 长期记忆：就地编辑（不用 prompt —— Electron 里 prompt 被禁，点了没反应）
    qa('[data-mp="long-edit"]', el).forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        var idx = Number(btn.getAttribute('data-idx'));
        var line = q1('.mp-line[data-long-idx="' + idx + '"]', el);
        var cur = (longList()[idx] || {}).content || '';
        if (!line || line.getAttribute('data-editing') === '1') return;
        line.setAttribute('data-editing', '1');
        line.innerHTML = '<textarea class="inp mp-edit-ta"></textarea>'
          + '<span class="mp-line-a"><button class="btn btn-small btn-primary" data-mp="long-save">保存</button>'
          + '<button class="btn btn-small" data-mp="long-cancel">取消</button></span>';
        var ta = q1('.mp-edit-ta', line);
        ta.value = cur;
        ta.focus();
        try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (err) { /* ignore */ }
        q1('[data-mp="long-cancel"]', line).addEventListener('click', function (ev) {
          ev.preventDefault(); ev.stopPropagation();
          refreshMember(root, chatKey, uid);
        });
        q1('[data-mp="long-save"]', line).addEventListener('click', async function (ev) {
          ev.preventDefault(); ev.stopPropagation();
          var next = String(ta.value || '').trim();
          if (!next) { appendLocalNote('内容不能为空（要删请点「删」）', true); return; }
          try {
            var list = longList().map(function (x) { return x.content; });
            list[idx] = next;
            await putMember(chatKey, uid, list);
            appendLocalNote('已保存');
            await refreshMember(root, chatKey, uid);
          } catch (err) { appendLocalNote('保存失败：' + err.message, true); }
        });
      });
    });

    qa('[data-mp="long-del"]', el).forEach(function (btn) {
      btn.addEventListener('click', async function (e) {
        e.preventDefault(); e.stopPropagation();
        var idx = Number(btn.getAttribute('data-idx'));
        if (!(await confirmBox('删除这条长期记忆？\n\n' + ((longList()[idx] || {}).content || '')))) return;
        try {
          var list = longList().filter(function (x, i) { return i !== idx; }).map(function (x) { return x.content; });
          await putMember(chatKey, uid, list);
          appendLocalNote('已删除');
          await refreshMember(root, chatKey, uid);
        } catch (err) { appendLocalNote('删除失败：' + err.message, true); }
      });
    });

    // 短期 → 长期：先写长期（核心接口），再删短期
    qa('[data-mp="promote"]', el).forEach(function (btn) {
      var line = btn.closest('.mp-line');
      var shortId = line && line.getAttribute('data-short-id');
      btn.addEventListener('click', async function (e) {
        e.preventDefault(); e.stopPropagation();
        btn.disabled = true; btn.textContent = '晋升中…';
        try {
          var sm = snapMember(chatKey, uid) || { short: [] };
          var item = (sm.short || []).filter(function (s) { return s.id === shortId; })[0];
          if (!item) throw new Error('这条短期记忆已经不在了，刷新后可看到最新状态');
          var list = longList().map(function (x) { return x.content; });
          if (list.indexOf(item.content) < 0) list.push(item.content);
          await putMember(chatKey, uid, list);
          await act('promote', { chatKey: chatKey, userId: uid, shortId: shortId, reason: '控制台人工晋升' });
          appendLocalNote('已晋升为长期记忆' + (Number(item.hits) > 0 ? '（提及×' + item.hits + '）' : ''));
          await refreshMember(root, chatKey, uid);
        } catch (err) {
          appendLocalNote('晋升失败：' + err.message, true);
          btn.disabled = false; btn.textContent = '晋升';
        }
      });
    });

    qa('[data-mp="short-del"]', el).forEach(function (btn) {
      var line = btn.closest('.mp-line');
      var shortId = line && line.getAttribute('data-short-id');
      btn.addEventListener('click', async function (e) {
        e.preventDefault(); e.stopPropagation();
        try {
          await act('short-delete', { chatKey: chatKey, userId: uid, shortId: shortId });
          appendLocalNote('已删除这条短期记忆');
          await refreshMember(root, chatKey, uid);
        } catch (err) { appendLocalNote('删除失败：' + err.message, true); }
      });
    });

    var save = async function () {
      var input = pick('add-in');
      var sel = pick('add-kind');
      var v = String((input && input.value) || '').trim();
      if (!v) return;
      try {
        var r = await act('short-save', {
          chatKey: chatKey, userId: uid, content: v,
          kind: (sel && sel.value) || 'general', name: noteOf(uid)
        });
        appendLocalNote(r.merged ? '同一件事已记过，提及次数 +1' : '已记下（手工记的从 0 开始，界面不显示提及）');
        await refreshMember(root, chatKey, uid);
      } catch (err) { appendLocalNote('记下失败：' + err.message, true); }
    };
    var addSave = pick('add-save');
    if (addSave) addSave.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); save(); });
    var addIn = pick('add-in');
    if (addIn) addIn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); save(); }
    });
  }

  async function putMember(chatKey, uid, contents) {
    await core('/api/memory-files/' + keyToPath(chatKey) + '/members/' + encodeURIComponent(uid), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: noteOf(uid) || '', impressions: (contents || []).slice(0, 20) })
    });
  }

  function bindDetail(detail, chatKey) {
    var on = function (name, fn) {
      qa('[data-mp="' + name + '"]', detail).forEach(function (el) {
        el.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); fn(el, e); });
      });
    };

    on('refresh-status', async function (btn) {
      btn.disabled = true; btn.textContent = '刷新中…';
      try {
        await act('snapshot', {});       // 强制重写一次快照，保证读到最新数据
        S.cfg = null; S.providers = null;
        await pollStatus(true);
        await refreshAll();
        appendLocalNote('状态已刷新（' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '）');
      } catch (err) { appendLocalNote('刷新失败：' + err.message, true); }
      btn.disabled = false; btn.textContent = '刷新状态';
    });

    on('save-model', function () { saveModel(); });

    on('extract-now', async function (btn) {
      btn.disabled = true; btn.textContent = '提取中…';
      try {
        var r = await act('extract-now', {});
        appendLocalNote(r && r.note ? r.note : '已尝试提取', !(r && r.ok));
        await refreshAll();
      } catch (err) { appendLocalNote('提取失败：' + err.message, true); }
      btn.disabled = false; btn.textContent = '立刻提取新记忆';
    });

    on('add-member', function () {
      if (typeof window.openMemberImpressModal === 'function') window.openMemberImpressModal(chatKey, null);
      else appendLocalNote('核心的添加弹窗不可用（控制台版本不匹配）', true);
    });

    on('expire', async function (btn) {
      btn.disabled = true;
      try {
        var r = await act('expire-now', {});
        appendLocalNote('已清理过期短期记忆 ' + (r.removed || 0) + ' 条');
        await refreshAll();
      } catch (err) { appendLocalNote('清理失败：' + err.message, true); }
      btn.disabled = false;
    });

    on('rescan', async function (btn) {
      btn.disabled = true; btn.textContent = '扫描中…';
      appendLocalNote('正在重新扫描插件与技能…');
      try {
        var r = await act('rescan', {});
        var note = '已重扫：' + (r.loaded || 0) + ' 个扩展';
        if (r.failed && r.failed.length) note += '，' + r.failed.length + ' 个失败';
        if (r.error) note += '（' + r.error + '）';
        appendLocalNote(note);
        await act('snapshot', {});
        S.cfg = null; S.providers = null;
        await pollStatus(true);
        await refreshAll();
      } catch (err) { appendLocalNote('重新扫描失败：' + err.message, true); }
      btn.disabled = false; btn.textContent = '重新扫描';
    });

    on('consolidate', async function () {
      appendLocalNote('已开始整理，进度显示在右侧状态区…');
      try {
        var r = await act('consolidate', { chatKey: chatKey });
        S.status = { running: true, job: r.job || { label: '准备中' }, queue: { active: false, remaining: 0, done: 0, failed: [] } };
        renderStatus();
        startPoll();
      } catch (err) { appendLocalNote('整理失败：' + err.message, true); }
    });

    on('core-consolidate', async function (btn) {
      btn.disabled = true; btn.textContent = '已提交…';
      try {
        await core('/api/memory-files/consolidate', { method: 'POST', body: JSON.stringify({ chatKey: chatKey, force: true }) });
        appendLocalNote('已提交「合并去重」，结果稍后自动刷新');
      } catch (err) { appendLocalNote('提交失败：' + err.message, true); }
      btn.disabled = false; btn.textContent = '合并去重';
    });

    on('queue-start', async function (btn) {
      btn.disabled = true;
      try {
        var r = await act('queue-start', { chatKey: chatKey });
        appendLocalNote('已排队 ' + (r.queued || 0) + ' 个人，每 30 秒处理一个');
        await pollStatus(true);
      } catch (err) { appendLocalNote('排队失败：' + err.message, true); }
      btn.disabled = false;
    });

    on('queue-clear', async function () {
      try {
        await act('queue-clear', { chatKey: chatKey });
        appendLocalNote('已清空标签队列');
        await pollStatus(true);
      } catch (err) { appendLocalNote('停止失败：' + err.message, true); }
    });

    qa('.mp-q', detail).forEach(function (box) {
      var btn = q1('[data-mp="q-resolve"]', box);
      var input = q1('.mp-q-in', box);
      if (!btn) return;
      btn.addEventListener('click', async function (e) {
        e.preventDefault(); e.stopPropagation();
        var v = String((input && input.value) || '').trim();
        if (!v) { appendLocalNote('先填一句结论', true); return; }
        try {
          await act('question-resolve', { chatKey: chatKey, questionId: box.getAttribute('data-qid'), decision: v });
          appendLocalNote('已落定');
          await refreshAll();
        } catch (err) { appendLocalNote('落定失败：' + err.message, true); }
      });
    });

    // ── 存档区 ──
    var archive = q1('.mp-archive', detail);
    if (archive) {
      archive.addEventListener('toggle', function () { S.archiveOpen = archive.open; });
      var dateVal = function (name) {
        var y = q1('[data-mp="' + name + '-y"]', detail);
        var m = q1('[data-mp="' + name + '-m"]', detail);
        var d = q1('[data-mp="' + name + '-d"]', detail);
        if (!y || !y.value) return '';
        return y.value + '-' + String((m && m.value) || '1').padStart(2, '0') + '-' + String((d && d.value) || '1').padStart(2, '0');
      };
      var setRange = function (from, to) {
        var set = function (name, val) {
          var y = q1('[data-mp="' + name + '-y"]', detail);
          var m = q1('[data-mp="' + name + '-m"]', detail);
          var d = q1('[data-mp="' + name + '-d"]', detail);
          if (!y) return;
          if (!val) { y.value = ''; if (m) m.value = ''; if (d) d.value = ''; return; }
          var p = String(val).split('-');
          y.value = p[0] || '';
          if (m) m.value = String(Number(p[1] || 1));
          if (d) d.value = String(Number(p[2] || 1));
        };
        set('from', from); set('to', to);
      };

      qa('[data-mp="quick"]', archive).forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.preventDefault(); e.stopPropagation();
          var days = Number(btn.getAttribute('data-days')) || 0;
          if (!days) setRange('', '2099-12-31');
          else {
            var d = new Date(Date.now() - days * 86400000);
            var p = function (x) { return String(x).padStart(2, '0'); };
            setRange('', d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()));
          }
          appendLocalNote('已填好时间范围，点「看看命中几条」再删');
        });
      });

      qa('[data-mp="preview"]', archive).forEach(function (btn) {
        btn.addEventListener('click', async function (e) {
          e.preventDefault(); e.stopPropagation();
          try {
            var r = await act('prune-preview', { chatKey: chatKey, from: dateVal('from'), to: dateVal('to') });
            appendLocalNote('命中 ' + r.count + ' 条（该会话共 ' + r.total + ' 条，范围 ' + r.from + ' ~ ' + r.to + '）');
          } catch (err) { appendLocalNote('预览失败：' + err.message, true); }
        });
      });

      qa('[data-mp="prune"]', archive).forEach(function (btn) {
        btn.addEventListener('click', async function (e) {
          e.preventDefault(); e.stopPropagation();
          var from = dateVal('from');
          var to = dateVal('to');
          if (!(await confirmBox('删除 ' + chatKey + ' 在 ' + (from || '最早') + ' ~ ' + (to || '最新') + ' 之间的聊天记录？\n\n删前会自动备份，之后可以一键回档。'))) return;
          try {
            var r = await act('prune', { chatKey: chatKey, from: from, to: to, confirm: true });
            appendLocalNote('已删除 ' + (r.removed || 0) + ' 条，并已排队复核' + (r.backupPath ? '；备份已生成' : ''));
            await refreshAll();
          } catch (err) { appendLocalNote('删除失败：' + err.message, true); }
        });
      });

      qa('[data-mp="sweep"]', archive).forEach(function (btn) {
        btn.addEventListener('click', async function (e) {
          e.preventDefault(); e.stopPropagation();
          if (!(await confirmBox('按「存档保留天数」清理所有会话的过旧聊天记录？\n\n当前选中的会话会被跳过（它可能正在被机器人使用）。'))) return;
          try {
            var r = await act('sweep-now', { skipActive: chatKey });
            appendLocalNote('清理完成：' + (r.purged || 0) + ' 个会话、共 ' + (r.removed || 0) + ' 条');
            await refreshAll();
          } catch (err) { appendLocalNote('清理失败：' + err.message, true); }
        });
      });

      qa('[data-mp="backups"]', archive).forEach(function (btn) {
        btn.addEventListener('click', async function (e) {
          e.preventDefault(); e.stopPropagation();
          var box = q1('.mp-backups', detail);
          if (!box) return;
          box.innerHTML = '<span class="muted" style="font-size:12px">读取备份…</span>';
          try {
            var r = await act('backups', { chatKey: chatKey });
            var list = r.backups || [];
            if (!list.length) { box.innerHTML = '<span class="muted" style="font-size:12px">还没有备份（清理或删除存档时会自动生成）</span>'; return; }
            box.innerHTML = '<div class="mp-row"><span class="mp-row-k">回档</span><select class="inp mp-backup-sel">'
              + list.slice(0, 30).map(function (b) {
                return '<option value="' + esc(b.file) + '">' + esc(fmt(b.at)) + ' · ' + (b.count >= 0 ? b.count + ' 条' : '?') + ' · ' + (b.bytes / 1024).toFixed(0) + 'KB</option>';
              }).join('')
              + '</select><button class="btn btn-small btn-danger" data-mp="restore">一键回档</button></div>'
              + '<div class="muted" style="font-size:11px">回档会用选中那份备份覆盖当前存档（当前存档也会先备份一份）。</div>';
            var rb = q1('[data-mp="restore"]', box);
            rb.addEventListener('click', async function (ev) {
              ev.preventDefault(); ev.stopPropagation();
              var sel = q1('.mp-backup-sel', box);
              var file = sel && sel.value;
              if (!file) return;
              if (!(await confirmBox('用这份备份覆盖当前存档？'))) return;
              try {
                var rr = await act('backup-restore', { chatKey: chatKey, file: file });
                appendLocalNote('回档完成：恢复 ' + (rr.restored || 0) + ' 条记录。'
                  + '如果这个会话正在被机器人使用，建议点顶栏「重启」让它重新读盘。');
                await refreshAll();
              } catch (err) { appendLocalNote('回档失败：' + err.message, true); }
            });
          } catch (err) { box.innerHTML = '<span class="muted" style="font-size:12px">读取备份失败：' + esc(err.message) + '</span>'; }
        });
      });
    }

    qa('.mem-fold[data-uid]', detail).forEach(function (el2) {
      bindMember(el2, chatKey, el2.getAttribute('data-uid'), detail);
    });
  }

  // ── 六、挂钩核心的记忆页 ────────────────────────────────────────────
  function wrap(name, after) {
    var orig = window[name];
    if (typeof orig !== 'function') return false;
    if (orig.__mpWrapped) return true;
    var wrapped = async function () {
      var r = await orig.apply(this, arguments);
      try { await after.apply(this, arguments); } catch (e) { console.warn('[记忆优化] 接管后处理失败：', e); }
      return r;
    };
    wrapped.__mpWrapped = true;
    window[name] = wrapped;
    return true;
  }

  function decorateList() {
    var box = q1('#memory-items');
    if (!box) return;
    var chats = (S.snapshot && S.snapshot.chats) || [];
    var byKey = {};
    chats.forEach(function (c) { byKey[c.chatKey] = c; });
    qa('.chat-item', box).forEach(function (item) {
      var key = item.getAttribute('data-key');
      var sc = byKey[key];
      var sub = q1('.chat-item-sub', item);
      if (!sub || !sc) return;
      var shortN = 0;
      var tagN = 0;
      (sc.members || []).forEach(function (m) {
        shortN += (m.short || []).length;
        tagN += (m.labels || []).length;
      });
      var pend = (sc.questions || []).filter(function (q) { return q.status === 'pending'; }).length;
      var extra = [];
      if (shortN) extra.push('短期 ' + shortN);
      if (tagN) extra.push('标签 ' + tagN);
      if (pend) extra.push('待裁决 ' + pend);
      var badge = q1('.mp-badge', sub);
      if (!extra.length) { if (badge) badge.textContent = ''; return; }
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'mp-badge';
        sub.appendChild(badge);
      }
      badge.textContent = ' · ' + extra.join(' · ');
    });
  }

  async function afterList() {
    try { if (!S.snapshot) await loadSnapshot(); } catch (e) { /* ignore */ }
    decorateList();
  }
  async function afterDetail(chatKey) {
    var key = chatKey || currentChatKey();
    if (!key) return;
    var changed = lastRenderedChat !== key;   // 必须在 renderDetail 之前判断（它会更新 lastRenderedChat）
    try { await loadSnapshot(); } catch (e) { /* ignore */ }
    await loadCoreMembers(key);
    await loadProviders();
    await renderDetail(key);
    if (changed) {
      // 只有"换了一个会话"才回到顶部；同会话内的刷新一律留在原地
      var d = q1('#memory-detail');
      if (d) d.scrollTop = 0;
    }
    startPoll();
    pollStatus(true);
  }

  function install() {
    if (S.installed) return true;
    if (typeof window.loadMemoryDetail !== 'function') return false;
    var ok1 = wrap('loadMemoryView', afterList);
    var ok2 = wrap('renderMemoryList', afterList);
    var ok3 = wrap('loadMemoryDetail', afterDetail);
    if (!ok1 && !ok2 && !ok3) return false;
    S.installed = true;
    console.log('[记忆优化] 已接管「记忆」页（列表装饰 + 详情增强 + 右侧状态区）');
    return true;
  }

  function boot() {
    if (!install()) {
      var tries = 0;
      var t = setInterval(function () {
        tries += 1;
        if (install() || tries > 20) clearInterval(t);
      }, 300);
      return;
    }
    var st = coreState();
    if (st && st.tab === 'memory' && typeof window.loadMemoryView === 'function') {
      try { window.loadMemoryView(); } catch (e) { /* ignore */ }
    }
    startPoll();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  setTimeout(boot, 1000);
  setTimeout(boot, 2500);
})();
