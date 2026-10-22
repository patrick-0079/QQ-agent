/**
 * Token 配额守卫 · 控制台（人员逐个管理）
 *
 * 布局是**主从式**：左边是人员列表，点一个人 → 右边是那个人的独立管理面板
 * （额度模式 / 数值 / 备注 / 清零 / 删除）。
 *
 * ⚠️ 所有数据都来自插件的 handleUiRequest（POST /api/plugin-ui/quota-guard/action），
 *    页面不自己算账 —— 保证「界面显示的」和「实际生效的」同源。
 *
 * ⚠️ 一律不用原生 prompt / confirm：宿主项目在控制台里刻意替换掉了原生对话框
 *    （Windows 上关闭后不回焦，之后所有输入框都打不了字，见 ui/app/00-core.js 的注释）。
 *    这里自己做模态框。
 */
(function () {
  'use strict';

  var ACTION = '/api/plugin-ui/quota-guard/action';
  var DEFAULT_LIMIT = 1000;

  var state = {
    data: null,
    selected: '',          // 当前管理谁
    checked: {},           // { qq: true } 批量勾选
    query: '',
    filter: 'all',
    sort: 'used',
    modal: null,           // { kind:'batch'|'single', targets:[], title, hint }
    addTab: 'members',     // members | friends | manual
    groups: null,          // 群列表缓存
    members: null,         // 当前群的成员缓存
    friends: null,         // 好友缓存
    memberQuery: '',
    friendQuery: '',
    page: 'daily',         // daily | total（两个页签）
    board: null,           // 累计排行榜数据
    cumQuery: '',
    cumSort: 'tokens'
  };

  var $ = function (id) { return document.getElementById(id); };

  /**
   * 用户正在编辑的输入框（id -> 值）。
   *
   * 为什么必须有它：页面每 20 秒会 `load()` 一次（排行榜页另有 30 秒轮询），
   * 而 `render()` 会把所有输入框的 value 写回**已保存的值** ——
   * 结果是你刚敲了一半的额度被定时刷新覆盖掉，而且**没有任何提示**。
   * 实测现象：「修改额度时输入栏会被定时刷新重置」。
   *
   * 做法：只要某个输入框的值与"渲染时写进去的值"不一致，就认为它有未保存改动，
   * 于是自动刷新**不覆盖它**（手动点「刷新」除外 —— 那是用户明确要求重载）。
   */
  var dirty = { value: {} };

  /** 记录"渲染刚写进去的值"作为基线，用于之后判断用户有没有改动。 */
  function markBaseline(id, written) {
    if (!(id in dirty.value)) dirty.value[id] = String(written == null ? '' : written);
  }
  /** 渲染时是否该跳过这个输入框（用户改过就别动它）。 */
  function shouldKeep(id) {
    var el = $(id);
    if (!el) return false;
    return (id in dirty.value) && String(el.value) !== dirty.value[id];
  }
  /**
   * 手动刷新 / 成功保存后调用：清掉全部"未保存"标记，并把保存按钮的标注去掉。
   * ⚠️ 必须连 `dirty.detail` 一起清 —— 只清 `dirty.value` 的话，
   *    详情面板会永远带着"有未保存改动"，而 isEditing() 又依赖它，
   *    于是自动刷新被永久挡住（页面看起来不再更新）。实测踩过。
   */
  function clearDirty() {
    dirty.value = {};
    dirty.detail = false;
    var save = $('qg-detail-save');
    if (save) {
      save.textContent = '保存这个人的设置';
      save.classList.remove('is-dirty');
    }
  }

  /** 现在有没有输入框正在被编辑（含未保存改动 / 有焦点）。 */
  function isEditing() {
    if (dirty.detail) return true;                 // 详情面板里有未保存的改动
    var ae = document.activeElement;
    if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName || '')) return true;   // 光标还在框里
    for (var id in dirty.value) {                  // 有改动但光标已移开 —— 也算在编辑
      var el = $(id);
      if (el && String(el.value) !== dirty.value[id]) return true;
    }
    return false;
  }
  var esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };
  var fmt = function (n) { return (Number(n) || 0).toLocaleString('en-US'); };

  /**
   * 用量的显示格式：以 k 计数（1k = 1000 token），超过 100 万改用 M。
   *
   * 例：1500 → "1.5k" · 15000 → "15k" · 150000 → "150k" · 1200000 → "1.2M"
   *
   * ⚠️ 只影响**显示**。账本里存的、配置里写的、发给后端的，一律还是原始的精确整数 ——
   *    换算只发生在这里。否则每显示一次就四舍五入一次，账会越算越偏。
   *
   * 显示规则：
   *   · ≥100k 向下取整（"150k"、"999k"，不再有小数）
   *   · 10k~100k 保留一位小数，但整数就不显示 .0（"15k" / "15.5k"）
   *   · <10k 保留一位小数（"1.0k" / "1.5k"）
   *   · <1000 原样显示（"999"）—— 新用户第一天的数字往往很小，写成 "0.5k" 反而难懂
   *   · 高位一档取整后可能变成 "1000k"，所以到 100 万就换用 M
   *
   * ⚠️ 高位用 Math.floor 而不是 Math.round：四舍五入会把 999949 显示成 "1000k"
   *    （永远不该出现的写法），而且用量显示宁可偏小 —— 让人以为还剩一点，
   *    比让人以为额度比实际多要安全。
   */
  function fmtK(n) {
    var v = Number(n);
    if (!isFinite(v)) return '0';
    v = Math.round(v);
    if (Math.abs(v) < 1000) return String(v);
    var scaled = v / 1000;
    var unit = 'k';
    if (scaled >= 1000) { scaled = v / 1e6; unit = 'M'; }
    if (scaled >= 100) return Math.floor(scaled) + unit;
    if (scaled >= 10) {
      var one = Math.floor(scaled * 10) / 10;
      return (Number.isInteger(one) ? String(one) : one.toFixed(1)) + unit;
    }
    return scaled.toFixed(1) + unit;
  }

  function fmtTime(ts) {
    if (!ts) return '—';
    var d = new Date(Number(ts));
    var p = function (x) { return String(x).padStart(2, '0'); };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  /** 悬停用的精确值：k 显示会舍掉小数，鼠标放上去要给回原始数字。 */
  function exact(n) { return fmt(n) + ' token'; }

  /**
   * 把用户输入的额度解析成 token 数。
   *
   * 支持简写：50k → 50000、1.5k → 1500、2m（大小写都行）→ 2000000、带逗号也行。
   * 既然界面上都用 k 显示了，输入也要能写 k —— 不然用户得自己数零。
   * 解析不出来返回 null（调用方据此报错，而不是当成 0 悄悄存下去）。
   */
  function parseLimit(raw) {
    var s = String(raw == null ? '' : raw).trim().replace(/[,\s]/g, '');
    if (s === '') return null;                       // 空串：由调用方决定是"不限"还是"保留原值"
    var m = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(s);
    if (!m) return null;
    var n = Number(m[1]);
    if (!isFinite(n)) return null;
    var unit = m[2].toLowerCase();
    if (unit === 'k') n *= 1000;
    else if (unit === 'm') n *= 1e6;
    return Math.max(0, Math.round(n));
  }

  function toast(msg, isError) {
    var el = $('qg-toast');
    if (!el) return;
    el.textContent = String(msg || '');
    el.hidden = false;
    el.classList.toggle('is-error', !!isError);
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.hidden = true; }, 2600);
  }

  function note(msg, isError) {
    var el = $('qg-note');
    if (!el) return;
    if (!msg) { el.hidden = true; return; }
    el.textContent = String(msg);
    el.hidden = false;
    el.classList.toggle('is-error', !!isError);
  }

  function post(action, payload) {
    return fetch(ACTION, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: action, payload: payload || {} })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.ok === false && d.error) throw new Error(d.error);
      return d;
    });
  }

  // ── 取数 ────────────────────────────────────────────────────────────
  function load() {
    var wantBoard = state.page === 'total' && !state.board;
    return (wantBoard ? post('cumulative') : post('state'))
      .then(function (d) {
        state.data = d;
        if (d.board) state.board = d.board;
        render();
        // 榜单还在后台统计时，过一会儿自己再取一次（用户不用手点刷新）
        if (state.page === 'total' && state.board && (state.board.scan.running || state.board.scan.partial)) {
          clearTimeout(load._t);
          load._t = setTimeout(function () { loadBoard(); }, 800);
        }
        return d;
      })
      .catch(function (e) { note('读取失败：' + e.message, true); });
  }

  /** 只取排行榜（不重取当日数据，切换页签与刷新时用）。 */
  function loadBoard() {
    return post('cumulative').then(function (d) {
      state.data = d;
      state.board = d.board;
      render();
      if (d.board && (d.board.scan.running || d.board.scan.partial)) {
        clearTimeout(loadBoard._t);
        loadBoard._t = setTimeout(loadBoard, 800);
      }
      return d;
    }).catch(function (e) { note('读取累计数据失败：' + e.message, true); });
  }

  /**
   * 跑一个会改数据的动作：成功后就地重渲染（不整页刷新，保留滚动与选中）。
   *
   * @param {boolean} keepSelection 保留当前选中的人。
   *   必须传 true 的场景：**刚添加一个新人**。那一刻他在列表里还不存在，
   *   render() 末尾的"选中的人已不在列表就清掉"会立刻把选中项抹掉，
   *   表现为「添加后右边面板不出现，得再点一下左边才出来」（实测踩中）。
   */
  function act(action, payload, okMsg, keepSelection) {
    return post(action, payload).then(function (d) {
      state.data = d;
      // 保存成功后清掉"未保存"标记：输入框现在的值就是已保存的值，
      // 不清的话自动刷新会一直被 isEditing() 挡住（页面看起来不再更新）。
      clearDirty();
      render({ keepSelection: !!keepSelection });
      if (okMsg) toast(okMsg);
      return d;
    }).catch(function (e) {
      note('操作失败：' + e.message, true);
      toast('操作失败', true);
      throw e;
    });
  }

  // ── 过滤 / 排序 ─────────────────────────────────────────────────────
  function visibleRows() {
    var rows = (state.data && state.data.rows) || [];
    var q = state.query.trim().toLowerCase();
    var f = state.filter;
    rows = rows.filter(function (r) {
      if (q && !(r.userId.toLowerCase().indexOf(q) >= 0
        || String(r.name || '').toLowerCase().indexOf(q) >= 0
        || String(r.note || '').toLowerCase().indexOf(q) >= 0)) return false;
      if (f === 'active') return r.activeToday;
      if (f === 'capped') return r.hasOwnQuota;
      if (f === 'nocap') return !r.hasOwnQuota;
      if (f === 'over') return r.over;
      return true;
    });
    var s = state.sort;
    rows.sort(function (a, b) {
      if (s === 'name') return String(a.name || a.userId).localeCompare(String(b.name || b.userId));
      if (s === 'remaining') {
        // 不限的人排最后（没有"剩余"这个概念），其余按剩余升序 —— 最紧张的排最前
        var ar = a.remaining === null ? Infinity : a.remaining;
        var br = b.remaining === null ? Infinity : b.remaining;
        return ar - br || b.spent - a.spent;
      }
      return b.spent - a.spent || a.userId.localeCompare(b.userId);
    });
    return rows;
  }

  function rowBy(qq) {
    return ((state.data && state.data.rows) || []).find(function (r) { return r.userId === qq; }) || null;
  }

  // ── 渲染：统计条 ────────────────────────────────────────────────────
  function renderStats() {
    var st = (state.data && state.data.stats) || { people: 0, capped: 0, over: 0, activeToday: 0 };
    $('qg-stats').innerHTML =
      '<span class="qg-chip">共 <b>' + st.people + '</b> 人</span>'
      + '<span class="qg-chip">已设额度 <b>' + st.capped + '</b></span>'
      + '<span class="qg-chip">今天活跃 <b>' + st.activeToday + '</b></span>'
      + (st.over
        ? '<span class="qg-chip is-over qg-clickable" data-filterto="over">已超额 <b>' + st.over + '</b> · 点此筛选</span>'
        : '<span class="qg-chip">无人超额</span>');
  }

  // ── 渲染：左列表 ────────────────────────────────────────────────────
  /**
   * 进度条的宽度百分比。
   *
   * ⚠️ 必须留在**模块作用域**：列表渲染和详情渲染都要用它。
   *    曾经把它定义在 quotaBlocksHtml 内部，于是 renderList 调用时抛
   *    ReferenceError，**整个左列表变成空的**（而详情看着正常）——
   *    症状是"列表莫名其妙没人"，极难查。位置不要动。
   *
   * ⚠️ 用了一点点但比例极小时（比如额度 100 亿、用了 200 万 → 0.02%），
   *    四舍五入会得到 0%，进度条**整条是空的**，看起来像"完全没用"——
   *    和旁边写着的"今日用量 2.0M"自相矛盾。所以只要用过就至少给 2%。
   */
  function barWidth(percent) {
    var p = Number(percent);
    if (!isFinite(p) || p <= 0) return 0;
    if (p >= 100) return 100;
    return Math.max(2, p);
  }

  function barClass(r) {
    if (r.limit <= 0) return 'qg-mini is-none';
    if (r.over) return 'qg-mini is-over';
    if (r.percent >= 80) return 'qg-mini is-warn';
    return 'qg-mini';
  }

  function renderList() {
    var rows = visibleRows();
    var box = $('qg-list');
    var empty = $('qg-empty');

    $('qg-listcount').textContent = rows.length + ' / ' + (((state.data || {}).rows || []).length) + ' 人';
    var allChecked = rows.length > 0 && rows.every(function (r) { return state.checked[r.userId]; });
    $('qg-checkall').checked = allChecked;

    if (!rows.length) {
      box.innerHTML = '';
      var total = (((state.data || {}).rows) || []).length;
      empty.hidden = false;
      empty.textContent = total === 0
        ? '还没有任何人。等群里聊起来会自动出现，或点「＋ 添加人」先设好。'
        : '没有符合筛选条件的人。';
      return;
    }
    empty.hidden = true;

    var html;
    try {
      html = rows.map(function (r) {
      // 列表行是紧凑摘要：主数字是**今日用量**，后面跟当前余额。
      // 标签写清楚哪个是哪个 —— 两个数混在一起正是之前让人看错的原因。
      var quotaText;
      if (r.limit <= 0) {
        quotaText = '<span class="qg-strong" title="今日用量 ' + esc(exact(r.spent)) + '">' + fmtK(r.spent) + '</span>'
          + ' <span class="qg-muted">· 不限</span>';
      } else {
        quotaText = '<span class="qg-strong" title="今日用量 ' + esc(exact(r.spent)) + '">' + fmtK(r.spent) + '</span>'
          + ' <span class="qg-muted" title="当前余额 ' + esc(exact(r.remaining)) + ' / 额度 ' + esc(exact(r.limit)) + '">'
          + '余额 ' + fmtK(r.remaining) + '</span>';
      }
      var tag = r.hasOwnQuota
        ? '<span class="qg-tag is-own" title="单独设过额度">单独</span>'
        : (r.limit > 0 ? '<span class="qg-tag" title="跟随全局默认额度">默认</span>' : '');
      var overTag = r.over ? '<span class="qg-tag is-over">超额</span>' : '';
      // 卡片标题：优先真实昵称，没昵称时退回备注，都没有就显示 QQ 号。
      // 用后端给的 displayName（它已经按这个优先级算好了，界面不再自己猜）。
      var title = r.displayName ? esc(r.displayName) : '<span class="qg-mono qg-muted">' + esc(r.userId) + '</span>';
      // 备注单独成标签：有真实昵称时才需要（否则备注已经在标题上了，重复显示很吵）
      var noteTag = (r.note && r.hasNickname)
        ? '<span class="qg-tag is-note" title="备注">' + esc(r.note) + '</span>' : '';
      // 有真实昵称时，把 QQ 号单独列一行，方便核对是谁
      var subLine = r.hasNickname ? '<div class="qg-person-sub qg-mono">' + esc(r.userId) + '</div>' : '';
      return '<div class="qg-person' + (r.userId === state.selected ? ' is-sel' : '') + (r.over ? ' is-over' : '') + '" data-pick="' + esc(r.userId) + '">'
        + '<label class="qg-check" data-stop="1"><input type="checkbox" data-check="' + esc(r.userId) + '"' + (state.checked[r.userId] ? ' checked' : '') + ' /></label>'
        + '<div class="qg-person-main">'
        + '  <div class="qg-person-top"><span class="qg-person-name">' + title + '</span>' + tag + overTag + noteTag + '</div>'
        + subLine
        + '  <div class="qg-person-bar">' + quotaText + '<span class="' + barClass(r) + '"><i style="width:' + (r.limit > 0 ? barWidth(r.percent) : 0) + '%"></i></span></div>'
        + '</div>'
        + (r.blockedCount ? '<span class="qg-blocked" title="今天被拦下的次数">拦 ' + r.blockedCount + '</span>' : '')
        + '</div>';
      }).join('');
    } catch (e) {
      // 单行渲染出错不该让整个列表空掉 —— 记下来并把错误显式暴露，
      // 否则症状是"列表莫名其妙是空的"，排查起来毫无线索。
      console.error('[quota-guard] 渲染列表失败：', e);
      html = '<div class="qg-empty">列表渲染出错：' + (e && e.message ? e.message : e) + '</div>';
    }
    box.innerHTML = html;
  }

  /**
   * 详情面板是整块 innerHTML 重建的，所以"保留未保存的输入"要先把值抓出来，
   * 重建后再写回去。否则定时刷新一样会把没保存的额度冲掉。
   */
  var DETAIL_FIELDS = [
    { id: 'qg-detail-limit', from: function (r) { return r.ownLimit > 0 ? String(r.ownLimit) : ''; } },
    { id: 'qg-detail-note', from: function (r) { return String(r.note || ''); } }
  ];

  /** 重建前抓取：{ 值, 是否有未保存改动 }。 */
  function captureDetailEdit() {
    var snap = { activeId: '', values: {}, dirty: false };
    var ae = document.activeElement;
    if (ae && ae.id) snap.activeId = ae.id;
    for (var i = 0; i < DETAIL_FIELDS.length; i++) {
      var el = $(DETAIL_FIELDS[i].id);
      if (!el) continue;
      snap.values[DETAIL_FIELDS[i].id] = el.value;
    }
    snap.dirty = !!(dirty.detail)
      || Object.keys(snap.values).some(function (id) {
        // ⚠️ 基线可能还没建立（第一次进详情面板时）—— 那就先建立它，
        //    否则"第一次进来改一下"永远被判成没改动，定时刷新照样覆盖（第一版漏了）。
        if (!(id in dirty.value)) { dirty.value[id] = String(snap.values[id]); return false; }
        return String(snap.values[id]) !== dirty.value[id];
      });
    return snap;
  }

  /** 重建后还原：把用户没保存的值写回新节点，并把标签改成"未保存"。 */
  function restoreDetailEdit(snap, r) {
    var changed = false;
    for (var i = 0; i < DETAIL_FIELDS.length; i++) {
      var f = DETAIL_FIELDS[i];
      var el = $(f.id);
      if (!el) continue;
      var shown = String(snap.values[f.id] == null ? '' : snap.values[f.id]);
      var saved = String(f.from(r));
      // ⚠️ 基线必须在这里也记一次：详情面板是整块重建的，
      //    不记基线的话 shouldKeep/isEditing 永远判定"没改动" ——
      //    于是定时刷新照样把你正在编辑的额度写回去（第一版就这么漏了）。
      var prev = (f.id in dirty.value) ? dirty.value[f.id] : null;
      if (prev !== null && shown !== prev) changed = true;
      el.value = snap.dirty ? shown : saved;
      dirty.value[f.id] = saved;
    }
    if (snap.dirty || changed) snap.dirty = true;

    if (snap.activeId && $(snap.activeId)) {
      try { $(snap.activeId).focus(); } catch (e) { /* 焦点丢了不影响功能 */ }
    }
    dirty.detail = snap.dirty;
    var save = $('qg-detail-save');
    if (save && snap.dirty) {
      save.textContent = '保存这个人的设置 · 有未保存改动';
      save.classList.add('is-dirty');
    }
    if (typeof updateLimitHint === 'function') updateLimitHint();
  }

  /**
   * 详情面板里一有输入就标记"未保存"，并把保存按钮标出来。
   *
   * 为什么要在 input 时立刻标记，而不是等下次重绘才比：
   *   · 用户需要**当场**看到"改了、还没保存"，而不是过 20 秒才亮起来；
   *   · isEditing() 依赖这个标记来决定"自动刷新要不要跳过"。
   */
  function markDetailDirty() {
    if (dirty.detail) return;
    dirty.detail = true;
    var save = $('qg-detail-save');
    if (save) {
      save.textContent = '保存这个人的设置 · 有未保存改动';
      save.classList.add('is-dirty');
    }
  }

  // ── 渲染：右详情（单人管理）─────────────────────────────────────────
  function renderDetail() {
    var body = $('qg-detail-body');
    var emptyEl = $('qg-detail-empty');
    var r = state.selected ? rowBy(state.selected) : null;
    if (!r) {
      body.hidden = true;
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;
    body.hidden = false;

    // 详情块是整块重建的：先抓走用户没保存的输入，重建后再写回，
    // 否则定时刷新会把正在编辑的额度冲掉（实测踩过）。
    var editSnap = captureDetailEdit();

    var mode = r.hasOwnQuota ? (r.ownLimit > 0 ? 'custom' : 'unlimited') : 'default';
    var sourceText = {
      individual: '单独设置',
      default: '跟随全局默认（' + fmt((state.data.settings || {}).defaultDailyLimit) + '）',
      none: '不限（全局默认也是 0）'
    }[r.limitSource] || '—';

    var nextReset = fmtTime((state.data || {}).resetAt);

    body.innerHTML =
      '<div class="qg-detail-head">'
      + '  <div>'
      + '    <div class="qg-detail-name">' + (r.displayName ? esc(r.displayName) : '未知名') + '</div>'
      + '    <div class="qg-mono qg-muted">' + esc(r.userId) + '</div>'
      + '  </div>'
      + '  <div class="qg-detail-tags">'
      + (r.over ? '<span class="qg-tag is-over">已超额</span>' : '')
      + '<span class="qg-tag' + (r.hasOwnQuota ? ' is-own' : '') + '">' + esc(sourceText) + '</span>'
      + '  </div>'
      + '</div>'

      + quotaBlocksHtml(r)

      + '<div class="qg-detail-meta">'
      + '  <div><span class="qg-muted">今天</span> ' + (r.activeToday ? '有发言' : '<span class="qg-muted">没发言</span>') + '</div>'
      + '  <div><span class="qg-muted">被拦</span> ' + r.blockedCount + ' 次</div>'
      + '  <div><span class="qg-muted">最后记账</span> ' + fmtTime(r.lastUpdatedAt) + '</div>'
      + '  <div><span class="qg-muted">额度刷新</span> 每天 ' + ((state.data.settings || {}).resetHour) + ':00（下次 ' + nextReset + '）</div>'
      + cumMetaHtml(r.userId)
      + '</div>'

      + '<div class="qg-detail-form">'
      + '  <div class="qg-field">'
      + '    <span>额度模式</span>'
      + '    <div class="qg-radio">'
      + '      <label><input type="radio" name="qg-mode" value="default"' + (mode === 'default' ? ' checked' : '') + ' /><span>跟随全局默认</span></label>'
      + '      <label><input type="radio" name="qg-mode" value="unlimited"' + (mode === 'unlimited' ? ' checked' : '') + ' /><span>单独不限</span></label>'
      + '      <label><input type="radio" name="qg-mode" value="custom"' + (mode === 'custom' ? ' checked' : '') + ' /><span>单独设额度</span></label>'
      + '    </div>'
      + '  </div>'
      + '  <label class="qg-field" id="qg-custom-wrap"' + (mode === 'custom' ? '' : ' hidden') + '>'
      + '    <span>每日额度（token，可用 k 简写：50k = 50000）</span>'
      + '    <input type="text" inputmode="decimal" id="qg-detail-limit" value="' + (r.ownLimit > 0 ? r.ownLimit : '') + '" placeholder="如 50k" />'
      + '    <em id="qg-limit-hint">' + (r.ownLimit > 0 ? '当前：' + fmtK(r.ownLimit) + '（' + fmt(r.ownLimit) + '）token' : '留空则按上面的模式处理') + '</em>'
      + '    <div class="qg-quick" data-quick="detail"></div>'
      + '  </label>'
      + '  <label class="qg-field">'
      + '    <span>备注（只给你自己看）</span>'
      + '    <input type="text" id="qg-detail-note" maxlength="40" value="' + esc(r.note || '') + '" placeholder="例：老同学 / 别限太死" />'
      + '  </label>'
      + '  <div class="qg-form-actions">'
      + '    <button class="btn btn-small btn-primary" id="qg-detail-save" type="button">保存这个人的设置</button>'
      + '    <button class="btn btn-small" id="qg-detail-clear" type="button">清零今天的用量</button>'
      + '    <button class="btn btn-small" id="qg-detail-dropquota" type="button"' + (r.hasOwnQuota ? '' : ' disabled') + '>取消单独额度</button>'
      + '    <button class="btn btn-small btn-danger" id="qg-detail-delete" type="button">删除这个人的记录</button>'
      + '  </div>'
      + '</div>';

    // 快捷额度按钮
    var quick = body.querySelector('[data-quick="detail"]');
    if (quick) quick.innerHTML = quickButtonsHtml();

    // 把用户没保存的输入写回新节点（并提示"有未保存改动"）
    restoreDetailEdit(editSnap, r);
  }

  // 快捷额度：值仍是精确 token 数，按钮上按 k/M 显示（10k / 50k / 100k / 500k / 1M）
  /**
   * 单人详情里的"累计用量"一格。
   *
   * 数据来自排行榜（会话存档扫描）。榜还没取过就不显示 —— 不为了一个数字
   * 在打开单人面板时去触发一次全量扫描。
   */
  function cumMetaHtml(userId) {
    var b = state.board;
    if (!b || !b.rows) return '';
    var r = null;
    for (var i = 0; i < b.rows.length; i++) { if (b.rows[i].userId === userId) { r = b.rows[i]; break; } }
    if (!r) return '<div><span class="qg-muted">累计</span> <span class="qg-muted">榜上暂无</span></div>';
    return '<div title="来自会话存档，覆盖全部历史"><span class="qg-muted">累计</span> '
      + '<b>' + fmtK(r.tokens) + '</b> <span class="qg-muted">· 第 ' + r.rank + ' 名 · ' + (r.share * 100).toFixed(1) + '%</span></div>';
  }

  var PRESETS = [10000, 50000, 100000, 500000, 1000000];

  function quickButtonsHtml() {
    return PRESETS.map(function (v) {
      return '<button type="button" class="qg-quickbtn" data-preset="' + v + '" title="' + exact(v) + '">' + fmtK(v) + '</button>';
    }).join('') + '<button type="button" class="qg-quickbtn" data-preset="0">不限</button>';
  }

  // ── 渲染：总用量排行榜 ──────────────────────────────────────────────
  function cumRows() {
    var b = state.board;
    if (!b) return [];
    var q = state.cumQuery.trim().toLowerCase();
    var rows = (b.rows || []).filter(function (r) {
      if (!q) return true;
      return String(r.userId).indexOf(q) >= 0
        || String(r.displayName || '').toLowerCase().indexOf(q) >= 0
        || String(r.note || '').toLowerCase().indexOf(q) >= 0;
    });
    var sort = state.cumSort;
    rows = rows.slice().sort(function (a, b2) {
      if (sort === 'name') return String(a.displayName || a.userId).localeCompare(String(b2.displayName || b2.userId));
      if (sort === 'sessions') return b2.sessions - a.sessions || b2.tokens - a.tokens;
      if (sort === 'messages') return b2.messages - a.messages || b2.tokens - a.tokens;
      if (sort === 'share') return b2.share - a.share || b2.tokens - a.tokens;
      return b2.tokens - a.tokens || a.userId.localeCompare(b2.userId);
    });
    return rows;
  }

  function fmtDate(ts) {
    if (!ts) return '—';
    var d = new Date(Number(ts));
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function renderBoard() {
    var b = state.board;
    if (!b) return;
    var t = b.totals || {};
    var scan = b.scan || {};

    // 顶部状态：还在统计就说清楚，别让用户以为数字是最终值
    $('qg-cum-status').textContent = scan.partial
      ? ('正在统计… ' + (scan.processed || 0) + ' / ' + (scan.total || '?') + ' 个会话')
      : ('已统计 ' + (scan.processed || 0) + ' 个会话' + (b.updatedAt ? ' · 更新于 ' + fmtTime(b.updatedAt) : ''));

    $('qg-cum-stats').innerHTML =
      '<span class="qg-chip">总计 <b>' + fmtK(t.tokens) + '</b> token（' + fmt(t.tokens) + '）</span>'
      + '<span class="qg-chip">' + (t.people || 0) + ' 人上榜</span>'
      + '<span class="qg-chip" title="有人发言、费用归到了人头上的会话数">' + (t.sessions || 0) + ' 次会话</span>'
      + (t.unattributedSessions > 0
        ? '<span class="qg-chip" title="花了钱但没人可归的会话（主动开话题 / 机器人自聊）">另有 ' + t.unattributedSessions + ' 次没归人</span>'
        : '')
      + '<span class="qg-chip">' + (t.calls || 0) + ' 次模型调用</span>'
      + (t.unattributed > 0
        ? '<span class="qg-chip" title="没有人发言的会话（主动开话题）或机器人自聊，这部分花掉了但不该记到谁头上">未归到人头 <b>' + fmtK(t.unattributed) + '</b></span>'
        : '');

    var sk = b.skipped || {};
    var skipBits = [];
    if (sk.noUsage) skipBits.push(sk.noUsage + ' 次没花钱的会话');
    if (sk.selfChat) skipBits.push(sk.selfChat + ' 次机器人自聊');
    if (sk.noTrigger) skipBits.push(sk.noTrigger + ' 次没人发言');
    $('qg-cum-range').textContent =
      '覆盖区间：' + fmtDate(b.range && b.range.firstAt) + ' → ' + fmtDate(b.range && b.range.lastAt)
      + (skipBits.length ? '（已跳过：' + skipBits.join('、') + '）' : '')
      + (b.todayTotal > 0 ? ' · 今日 ' + fmtK(b.todayTotal) + ' token' + (b.todaySource === 'sessions' ? '（含启用前补算）' : '') : '');

    var rows = cumRows();
    $('qg-cum-count').textContent = rows.length + ' / ' + ((b.rows || []).length) + ' 人';
    var empty = $('qg-cum-empty');
    if (!rows.length) {
      empty.hidden = false;
      empty.textContent = scan.partial
        ? '正在读取历史会话存档，稍等一下就会出来…'
        : ((b.rows || []).length
          ? '没有符合搜索条件的人。'
          : '没有读到任何历史会话。可能这个实例还没有跑过对话，或者 data/sessions 目录是空的。');
      $('qg-cum-rows').innerHTML = '';
      return;
    }
    empty.hidden = true;

    $('qg-cum-rows').innerHTML = rows.map(function (r) {
      var medal = r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : '';
      var pct = (r.share * 100);
      var noteTag = (r.note && r.note !== r.displayName)
        ? '<span class="qg-tag is-note" title="备注">' + esc(r.note) + '</span>' : '';
      return '<tr' + (r.rank <= 3 ? ' class="qg-top3"' : '') + '>'
        + '<td class="qg-c-rank"><span class="qg-rank">' + medal + (medal ? '' : r.rank) + '</span></td>'
        + '<td class="qg-mono">' + esc(r.userId) + '</td>'
        + '<td>' + (r.displayName ? esc(r.displayName) : '<span class="qg-muted">未知名</span>') + noteTag + '</td>'
        + '<td class="qg-num"><b title="' + esc(exact(r.tokens)) + '">' + fmtK(r.tokens) + '</b></td>'
        + '<td class="qg-c-share">'
        + '  <span class="qg-sharebar" title="占「归到人头」总量的 ' + pct.toFixed(2) + '%"><i style="width:' + Math.min(100, pct).toFixed(1) + '%"></i></span>'
        + '  <span class="qg-pct">' + (pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)) + '%</span>'
        + '</td>'
        + '<td class="qg-num">' + (r.sessions || 0) + '</td>'
        + '<td class="qg-num">' + (r.messages || 0) + '</td>'
        + '<td class="qg-num">' + (r.usedToday > 0 ? fmtK(r.usedToday) : '<span class="qg-muted">—</span>') + '</td>'
        + '<td class="qg-c-act"><button class="btn btn-small" data-cum-manage="' + esc(r.userId) + '" type="button">去设额度</button></td>'
        + '</tr>';
    }).join('');
  }

  /**
   * 单人详情里的两块数字：**今日用量** 和 **当前余额**。
   *
   * 它们是同一个数的两种说法，所以**总是同步变化**：
   *   · 今日用量 = 他今天花掉了多少（按天存，到设定时刻归零）
   *   · 当前余额 = 额度 - 今日用量（点重置会把今日用量清零 → 余额回满）
   * 之所以分两块显示，是因为"花了多少"和"还能花多少"是用户关心的两件事，
   * 挤在一行里（"已用 / 额度 · 剩余 x"）分不清哪个是哪个。
   *
   * 额度为 0（不限）时不显示余额数字 —— 写"∞"容易被误读成"额度用不完"，
   * 直接说"不限额"更清楚；进度条也不再需要。
   */
  function quotaBlocksHtml(r) {
    var usedBlock =
      '<div class="qg-qblock">'
      + '  <div class="qg-qblock-label">今日用量</div>'
      + '  <div class="qg-qblock-value" title="' + esc(exact(r.spent)) + '">' + fmtK(r.spent) + '</div>'
      + '  <div class="qg-qblock-sub">' + esc(exact(r.spent)) + ' · 重置余额不影响它</div>'
      + '</div>';

    var right;
    if (r.limit > 0) {
      right =
        '<div class="qg-qblock' + (r.over ? ' is-over' : '') + '">'
        + '  <div class="qg-qblock-label">当前余额</div>'
        + '  <div class="qg-qblock-value" title="' + esc(exact(r.remaining)) + '">' + fmtK(r.remaining) + '</div>'
        + '  <div class="qg-qblock-sub">'
        + '    <span title="' + esc(exact(r.limit)) + '">额度 ' + fmtK(r.limit) + '</span>'
        + '    <span class="qg-muted">已用 ' + fmt(r.percent) + '%</span>'
        + '  </div>'
        + '  <div class="qg-bar-lg' + (r.over ? ' is-over' : '') + '"><i style="width:' + barWidth(r.percent) + '%"></i></div>'
        + '</div>';
    } else {
      right =
        '<div class="qg-qblock is-nolimit">'
        + '  <div class="qg-qblock-label">当前余额</div>'
        + '  <div class="qg-qblock-value">不限额</div>'
        + '  <div class="qg-qblock-sub"><span class="qg-muted">不参与拦截，随便用</span></div>'
        + '</div>';
    }
    return '<div class="qg-qblocks">' + usedBlock + right + '</div>';
  }

  // ── 渲染：整页 ──────────────────────────────────────────────────────
  function render(opts) {
    var d = state.data;
    if (!d) return;
    var s = d.settings || {};
    var hasOver = ((d.rows || []).some(function (r) { return r.over; }));
    $('qg-sub').textContent = '额度周期：每天 ' + s.resetHour + ':00 刷新 · 今天 ' + d.dayKey;
    // 顶部开关：反映插件真实的启用状态（唯一真相是 config.skills[id].enabled）
    var on = d.enabled === true;
    $('qg-enable').checked = on;
    $('qg-enable-label').textContent = on ? '已开启' : '已关闭';
    $('qg-enable-wrap').classList.toggle('is-off', !on);
    // 关着的时候，"有人已超额"这种提示没有意义（根本没在拦），改成如实说
    $('qg-state').textContent = !on ? '未生效' : (hasOver ? '有人已超额' : '正常');
    $('qg-state').classList.toggle('is-warn', on && hasOver);
    $('qg-state').classList.toggle('is-off', !on);
    $('qg-settings-summary').textContent = '重置 ' + s.resetHour + ':00 · 默认额度 '
      + (s.defaultDailyLimit > 0 ? fmtK(s.defaultDailyLimit) : '不限')
      + (s.blockWhenSendLimited !== false ? ' · 限流前置' : '')
      + (s.notifyOnBlock ? ' · 会回话' : '');
    // ⚠️ 写输入框前先让过"用户正在编辑"的那些 —— 否则定时刷新会把
    //    你没保存的改动悄悄还原成已保存的值（实测踩过）。
    //    没被改过的框照常写入（这样后端改了值、界面也能跟着变）。
    if (!shouldKeep('qg-resethour')) $('qg-resethour').value = s.resetHour;
    // 默认额度：显示成 k（读起来快），但输入框里放**精确值** —— 它是可编辑的，
    // 放 "50k" 再被当数字读会解析失败。用户想写 k 自己敲就是（parseLimit 认）。
    if (!shouldKeep('qg-defaultlimit')) $('qg-defaultlimit').value = s.defaultDailyLimit > 0 ? String(s.defaultDailyLimit) : '';
    $('qg-notify').checked = s.notifyOnBlock === true;
    $('qg-sendgate').checked = s.blockWhenSendLimited !== false;
    if (!shouldKeep('qg-notifytext')) $('qg-notifytext').value = s.notifyText || '';
    // 记下基线（只在第一次渲染时记，之后保持第一次的值，才能判断"改没改"）
    markBaseline('qg-resethour', s.resetHour);
    markBaseline('qg-defaultlimit', s.defaultDailyLimit > 0 ? String(s.defaultDailyLimit) : '');
    markBaseline('qg-notifytext', s.notifyText || '');
    $('qg-total').textContent = '今日合计 ' + fmtK(d.totalUsed) + ' token（' + fmt(d.totalUsed) + '）';
    $('qg-nextreset').textContent = '下次刷新：' + new Date(d.resetAt).toLocaleString('zh-CN');
    // 今日用量如果是"从历史会话补算"的，必须说清楚 ——
    // 否则用户会以为插件一直在记账（实际它是刚装的，账本是空的、这是回填的）。
    var ts = $('qg-today-source');
    if (ts) {
      if (d.todaySource === 'sessions') {
        ts.hidden = false;
        ts.textContent = '⚠ 今日用量是从历史会话存档补算的（插件启用之前的对话也算在内），'
          + '不是插件实时记的。从下一次对话开始就是实时记账了。';
      } else {
        ts.hidden = true;
      }
    }

    // 选中的人如果已经不在列表里（被删了）就清掉选中。
    // keepSelection：刚添加的新人此刻还没进这次响应，不能把他清掉（见 act 的注释）。
    if (state.selected && !rowBy(state.selected) && !(opts && opts.keepSelection)) state.selected = '';

    renderStats();
    renderList();
    renderDetail();
    // 累计榜：有数据就渲染（切到那一页时 load() 会去取）
    if (state.board) renderBoard();

    var cnt = Object.keys(state.checked).filter(function (k) { return state.checked[k]; }).length;
    var batchBtn = $('qg-batch');
    batchBtn.disabled = cnt === 0;
    batchBtn.textContent = cnt ? ('批量设额度 · 已选 ' + cnt + ' 人') : '批量设额度';
  }

  /** 切换页签：daily（今日额度）/ total（总用量排行榜）。 */
  function switchPage(page) {
    state.page = page === 'total' ? 'total' : 'daily';
    $('qg-page-daily').hidden = state.page !== 'daily';
    $('qg-page-total').hidden = state.page !== 'total';
    Array.prototype.forEach.call($('qg-pages').querySelectorAll('[data-page]'), function (b) {
      b.classList.toggle('is-on', b.getAttribute('data-page') === state.page);
    });
    // ⚠️ 每次切到排行榜都**重新取一次**，不能"有缓存就不再取"。
    //    增量扫很便宜（实测 700+ 会话约 10ms），而这个页面上的数字会随着
    //    新会话不断变化。曾经写成"有 state.board 就跳过"，后果是：
    //    第一次进页面时榜单还是空的（扫描刚开始），之后即使存档里已经有数据，
    //    再切回来也永远显示那个空榜 —— 用户以为功能坏了。
    if (state.page === 'total') {
      loadBoard();
      startCumPoll();
    } else {
      stopCumPoll();
    }
  }

  /** 停在排行榜页时定时刷新（新会话会不断进来）。 */
  function startCumPoll() {
    stopCumPoll();
    cumPoll = setInterval(function () {
      // ⚠️ 正在编辑就不刷：榜单页也有搜索框，重绘会打断输入。
      if (state.page === 'total' && !state.modal && !isEditing()) loadBoard();
    }, 30000);
  }
  function stopCumPoll() {
    if (cumPoll) { clearInterval(cumPoll); cumPoll = null; }
  }

  // ── 添加人：页签 / 群成员 / 好友 ────────────────────────────────────

  function switchAddTab(tab) {
    state.addTab = ['members', 'friends', 'manual'].indexOf(tab) >= 0 ? tab : 'members';
    ['members', 'friends', 'manual'].forEach(function (t) {
      var pane = $('qg-pane-' + t);
      if (pane) pane.hidden = t !== state.addTab;
    });
    var box = $('qg-addbox');
    if (box) {
      Array.prototype.forEach.call(box.querySelectorAll('[data-addtab]'), function (b) {
        b.classList.toggle('is-on', b.getAttribute('data-addtab') === state.addTab);
      });
    }
    if (state.addTab === 'manual') { var q = $('qg-add-qq'); if (q) q.focus(); }
    if (state.addTab === 'members') {
      if (state.groups === null) loadGroups();
      else renderGroups();
      renderMembers();
    }
    if (state.addTab === 'friends') {
      if (state.friends === null) loadFriends();
      else renderFriends();
    }
  }

  /** 拉群列表填进下拉框（只拉一次，之后走缓存）。 */
  function loadGroups() {
    var sel = $('qg-group-select');
    if (sel) sel.innerHTML = '<option value="">拉取群列表…</option>';
    post('fetchGroups').then(function (d) {
      state.groups = d.groups || [];
      renderGroups();
    }).catch(function (e) {
      state.groups = [];
      if (sel) sel.innerHTML = '<option value="">' + esc(e.message) + '</option>';
    });
  }

  function renderGroups() {
    var sel = $('qg-group-select');
    if (!sel) return;
    var gs = state.groups || [];
    if (!gs.length) { sel.innerHTML = '<option value="">没有拉到群（协议端连上了吗？）</option>'; return; }
    var cur = sel.value;
    sel.innerHTML = '<option value="">选择群聊…</option>' + gs.map(function (g) {
      return '<option value="' + esc(g.id) + '">' + esc(g.name) + '（' + esc(g.id) + '）</option>';
    }).join('');
    if (cur) sel.value = cur;
  }

  /** 拉当前选中群的成员。 */
  function loadMembers() {
    var box = $('qg-members');
    var gid = $('qg-group-select') ? $('qg-group-select').value : '';
    if (!gid) { if (box) { box.hidden = false; box.innerHTML = '<div class="qg-muted" style="padding:8px">先选一个群。</div>'; } return; }
    if (box) { box.hidden = false; box.innerHTML = '<div class="qg-muted" style="padding:8px">拉取群成员…</div>'; }
    state.members = null;
    post('fetchMembers', { groupId: gid }).then(function (d) {
      state.members = d.members || [];
      renderMembers();
    }).catch(function (e) {
      state.members = [];
      if (box) box.innerHTML = '<div class="qg-muted" style="padding:8px">' + esc(e.message) + '</div>';
    });
  }

  /** 渲染人员选择列表（群成员与好友共用同一套外壳）。 */
  function personListHtml(list, q, emptyText) {
    var query = String(q || '').trim().toLowerCase();
    var hit = query
      ? list.filter(function (p) {
        // ⚠️ 昵称也要能搜到：群里几乎人人有名片，只匹配显示名的话，
        //    用真实昵称（"李四"）根本找不到设了名片的他（显示为"群里的昵称"）。
        return String(p.userId).indexOf(query) >= 0
          || String(p.name || '').toLowerCase().indexOf(query) >= 0
          || String(p.nickname || '').toLowerCase().indexOf(query) >= 0;
      })
      : list;
    if (!list.length) return '<div class="qg-muted" style="padding:8px">' + esc(emptyText) + '</div>';
    if (!hit.length) return '<div class="qg-muted" style="padding:8px">没有匹配的人。</div>';
    // 人可能很多（大群几百人），加个上限：一次渲染上千个按钮会卡，而且也没人会翻到底
    var MAX = 300;
    var shown = hit.slice(0, MAX);
    var more = hit.length > MAX ? '<div class="qg-muted" style="padding:8px">还有 ' + (hit.length - MAX) + ' 人没显示，用上面的搜索框缩小范围。</div>' : '';
    return shown.map(function (p) {
      // 有名片且和昵称不同时，把昵称也显示出来，方便确认是谁
      var alt = (p.nickname && p.nickname !== p.name) ? '<span class="qg-muted qg-altname">' + esc(p.nickname) + '</span>' : '';
      return '<button type="button" class="qg-friend" data-add-user="' + esc(p.userId) + '" data-add-name="' + esc(p.name || '') + '">'
        + '<span>' + esc(p.name || p.userId) + '</span>' + alt
        + '<span class="qg-mono qg-muted">' + esc(p.userId) + '</span>'
        + (p.hasQuota ? '<span class="qg-tag is-own">已设</span>' : '') + '</button>';
    }).join('') + more;
  }

  function renderMembers() {
    var box = $('qg-members');
    if (!box || state.members === null) return;
    box.hidden = false;
    box.innerHTML = personListHtml(state.members, state.memberQuery, '这个群里没拉到成员（协议端连上了吗？）');
  }

  function loadFriends() {
    var box = $('qg-friends');
    if (state.friends !== null) { renderFriends(); return; }
    if (box) { box.hidden = false; box.innerHTML = '<div class="qg-muted" style="padding:8px">拉取好友列表…</div>'; }
    post('fetchFriends').then(function (d) {
      state.friends = d.friends || [];
      renderFriends();
    }).catch(function (e) {
      state.friends = [];
      if (box) box.innerHTML = '<div class="qg-muted" style="padding:8px">' + esc(e.message) + '</div>';
    });
  }

  function renderFriends() {
    var box = $('qg-friends');
    if (!box || state.friends === null) return;
    box.hidden = false;
    box.innerHTML = personListHtml(state.friends, state.friendQuery, '好友列表是空的（或协议端没连上）。');
  }

  /**
   * 从列表里点了一个人：直接把额度框准备好，让他填额度再确认。
   *
   * 特意**不**直接落盘 —— 点错一下就把人加进额度表、还得再去删，很烦。
   * 把人填进"手填"页签的输入框，用户看清 QQ 号和名字后自己点添加。
   */
  function pickPerson(userId, name) {
    switchAddTab('manual');
    if ($('qg-add-qq')) $('qg-add-qq').value = String(userId || '');
    if ($('qg-add-name')) $('qg-add-name').value = String(name || '');
    if ($('qg-add-limit')) $('qg-add-limit').focus();
    toast('已填入 ' + (name || userId) + '，填好额度点「添加」');
  }

  /** 额度输入框下面的实时换算提示：把用户敲的 "50k" 变成人话。 */  function updateLimitHint() {
    var el = $('qg-limit-hint');
    var inp = $('qg-detail-limit');
    if (!el || !inp) return;
    var raw = String(inp.value || '').trim();
    if (raw === '') {
      // 留空在"单独设额度"模式下是不合法的，直接说清楚；其它模式本来就按模式走
      var mode = (document.querySelector('input[name="qg-mode"]:checked') || {}).value;
      el.textContent = mode === 'custom' ? '填一个大于 0 的额度，可以写 50k' : '留空则按上面的模式处理';
      return;
    }
    var n = parseLimit(raw);
    if (n === null) { el.textContent = '看不懂这个额度：可以写 50000，也可以写 50k / 1.5m'; return; }
    if (n === 0) { el.textContent = '0 = 该人单独不限'; return; }
    el.textContent = '＝ ' + fmt(n) + ' token（' + fmtK(n) + '）';
  }

  // ── 模态框（批量设额度）─────────────────────────────────────────────

  function openLimitModal(kind, targets, title, hint) {
    state.modal = { kind: kind, targets: targets, title: title, hint: hint };
    $('qg-modal-title').textContent = title;
    $('qg-modal-hint').textContent = hint || '';
    $('qg-modal-limit').value = '';
    $('qg-modal-quick').innerHTML = quickButtonsHtml();
    $('qg-modal').hidden = false;
    showModalLimit();
    $('qg-modal-limit').focus();
  }

  function closeLimitModal() {
    state.modal = null;
    $('qg-modal').hidden = true;
  }

  /** 批量弹窗里的实时换算提示。 */
  function showModalLimit() {
    var el = $('qg-modal-hint');
    var m = state.modal;
    if (!el || !m) return;
    var raw = String($('qg-modal-limit').value || '').trim();
    var head = m.hint || '';
    var n = raw === '' ? null : parseLimit(raw);
    var tail;
    if (n === null) tail = raw === '' ? '（填 0 = 不限）' : '（额度看不懂：可以写 50000 或 50k）';
    else tail = n === 0 ? '（0 = 不限）' : '（＝ ' + fmt(n) + ' token · ' + fmtK(n) + '）';
    el.textContent = head + ' ' + tail;
  }
  function submitModal() {
    var m = state.modal;
    if (!m) return;
    var raw = String($('qg-modal-limit').value || '').trim();
    var limit = raw === '' ? null : parseLimit(raw);
    if (limit === null) { toast('额度填得不对，可以写 50000，也可以写 50k', true); return; }
    var ids = m.targets;
    act('setLimits', { userIds: ids, limit: limit }, '已把 ' + ids.length + ' 个人的额度设为 ' + (limit > 0 ? fmtK(limit) : '不限'))
      .then(function () { closeLimitModal(); })
      .catch(function () { /* act 已提示 */ });
  }

  // ── 事件绑定 ────────────────────────────────────────────────────────
  // ⚠️ 幂等：绑定只做一次。宿主项目在 ui/app/07-settings-events.js 里专门记过
  //    这个坑 —— 重复绑定会让每个点击触发 N 次处理函数；对"取反"型开关
  //    （如这里的展开/收起）表现为**点了没反应**（两次取反抵消），极难排查。
  var bound = false;
  var cumPoll = null;      // 停在排行榜页时的定时刷新句柄

  function bind() {
    if (bound) return;
    bound = true;

    // ── 页签：今日额度 / 总用量排行榜 ──
    $('qg-pages').addEventListener('click', function (e) {
      var tab = e.target.closest('[data-page]');
      if (!tab) return;
      switchPage(tab.getAttribute('data-page'));
    });

    // ── 排行榜自己的控件 ──
    $('qg-cum-search').addEventListener('input', function (e) { state.cumQuery = e.target.value; render(); });
    $('qg-cum-sort').addEventListener('change', function (e) { state.cumSort = e.target.value; render(); });
    $('qg-cum-rebuild').addEventListener('click', function () {
      openConfirm('重新统计总用量？',
        '会忽略缓存，把 data/sessions 里的会话存档全部重扫一遍。'
        + '在你手改过存档、或怀疑数字不对时用；只读存档，不会改动任何数据。',
        function () {
          return post('rebuildCumulative').then(function (d) {
            state.data = d; state.board = d.board; render();
            toast('已重建，正在重新统计…');
            loadBoard();      // 后台分片跑，跟一次进度
          });
        });
    });
    // 从榜单直接跳到这个人去设额度
    $('qg-cum-rows').addEventListener('click', function (e) {
      var b = e.target.closest('[data-cum-manage]');
      if (!b) return;
      var qq = b.getAttribute('data-cum-manage');
      switchPage('daily');
      state.selected = qq;
      render();
      // ⚠️ 不能用 findPerson —— 那是测试脚本里的辅助函数，页面运行时并不存在。
      //    曾经这么写过，点击按钮会抛 ReferenceError（按钮看着能点，点了没反应）。
      var el = document.querySelector('#qg-list .qg-person[data-pick="' + qq + '"]');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
      toast('已切到今日额度页，选中 ' + qq);
    });
    // 全局设置折叠
    $('qg-settings-toggle').addEventListener('click', function () {
      var card = $('qg-settings-card');
      card.classList.toggle('qg-collapsed');
    });

    $('qg-save').addEventListener('click', function () {
      // 默认额度走 parseLimit：既认 "50000" 也认 "50k"；空串 = 不限（0）
      var rawDefault = $('qg-defaultlimit').value;
      var dflt = String(rawDefault).trim() === '' ? 0 : parseLimit(rawDefault);
      if (dflt === null) { toast('默认额度填得不对，可以写 50000，也可以写 50k', true); return; }
      act('save', {
        resetHour: Number($('qg-resethour').value),
        defaultDailyLimit: dflt,
        notifyOnBlock: $('qg-notify').checked === true,
        notifyText: $('qg-notifytext').value,
        blockWhenSendLimited: $('qg-sendgate').checked === true
      }, '全局设置已保存');
    });

    // ⚠️ 开关类选项**改动即保存**，不能等用户想起来点「保存设置」。
    //    这两颗开关都是"拨一下就期望立刻生效"的东西；等一个显式保存，
    //    用户在别处一点（或刷新页面）改动就静默没了 —— 而且界面上开关还是他拨过的样子，
    //    看起来像"设置了但没生效"。实测踩过：blockWhenSendLimited 一直没被写进配置。
    //    文本类字段（时刻/额度/提示文本）仍走「保存设置」按钮，避免边打字边落盘。
    for (const id of ['qg-notify', 'qg-sendgate']) {
      const el = $(id);
      if (!el) continue;
      el.addEventListener('change', function () {
        // 默认额度框里可能是空的或写坏的 —— 那种情况下沿用上一次生效的值，别把它清成 0
        const rawD = String($('qg-defaultlimit').value).trim();
        const parsed = rawD === '' ? 0 : parseLimit(rawD);
        const dflt = parsed === null
          ? Number((state.data && state.data.settings || {}).defaultDailyLimit) || 0
          : parsed;
        act('save', {
          resetHour: Number($('qg-resethour').value),
          defaultDailyLimit: dflt,
          notifyOnBlock: $('qg-notify').checked === true,
          notifyText: $('qg-notifytext').value,
          blockWhenSendLimited: $('qg-sendgate').checked === true
        }, id === 'qg-sendgate'
          ? ($('qg-sendgate').checked ? '已开启发送限流前置' : '已关闭发送限流前置')
          : ($('qg-notify').checked ? '已开启额度提示' : '已关闭额度提示'));
      });
    }

    $('qg-resetall').addEventListener('click', function () {
      openConfirm('清空今天所有人的用量？', '额度本身不变，只是把今天的计数归零。', function () {
        return act('reset', {}, '已重置所有人的余额（今日用量不变）');
      });
    });

    $('qg-refresh').addEventListener('click', function () {
      // 手动刷新 = 用户明确要求重载：清掉"未保存"标记，
      // 否则上次编辑留下的标记会让自动刷新一直被跳过（页面看起来不再更新）。
      if (isEditing()) toast('已按你的要求重载，未保存的输入会被还原');
      clearDirty();
      load().then(function () { toast('已刷新'); });
    });

    // 工具栏
    $('qg-search').addEventListener('input', function (e) { state.query = e.target.value; render(); });
    $('qg-filter').addEventListener('change', function (e) { state.filter = e.target.value; render(); });
    $('qg-sort').addEventListener('change', function (e) { state.sort = e.target.value; render(); });

    // 统计条上的"点此筛选"
    $('qg-stats').addEventListener('click', function (e) {
      var el = e.target.closest('[data-filterto]');
      if (!el) return;
      state.filter = el.getAttribute('data-filterto');
      $('qg-filter').value = state.filter;
      render();
    });

    // 全选（只作用于当前筛选出来的）
    $('qg-checkall').addEventListener('change', function (e) {
      var on = e.target.checked;
      visibleRows().forEach(function (r) {
        if (on) state.checked[r.userId] = true; else delete state.checked[r.userId];
      });
      render();
    });

    // 列表：勾选 / 选中
    $('qg-list').addEventListener('click', function (e) {
      var cb = e.target.closest('[data-check]');
      if (cb) {
        var id = cb.getAttribute('data-check');
        if (cb.checked) state.checked[id] = true; else delete state.checked[id];
        render();
        return;
      }
      var person = e.target.closest('[data-pick]');
      if (person) {
        state.selected = person.getAttribute('data-pick');
        render();
      }
    });

    $('qg-batch').addEventListener('click', function () {
      var ids = Object.keys(state.checked).filter(function (k) { return state.checked[k]; });
      if (!ids.length) return;
      openLimitModal('batch', ids, '批量设额度',
        '将给这 ' + ids.length + ' 个人设成同一个每日额度：' + ids.slice(0, 8).join('、') + (ids.length > 8 ? ' 等' : ''));
    });

    // 添加人
    $('qg-add-person').addEventListener('click', function () {
      var box = $('qg-addbox');
      box.hidden = !box.hidden;
      if (!box.hidden) {
        switchAddTab(state.addTab);      // 恢复上次用的那个页签
        if (state.addTab === 'members' && state.groups === null) loadGroups();
      }
    });

    // 添加人的三个页签：从群成员选 / 从好友选 / 手填
    $('qg-addbox').addEventListener('click', function (e) {
      var tab = e.target.closest('[data-addtab]');
      if (tab) { switchAddTab(tab.getAttribute('data-addtab')); return; }
    });

    // ── 群成员 ──
    $('qg-members-load').addEventListener('click', loadMembers);
    $('qg-group-select').addEventListener('change', loadMembers);
    $('qg-member-search').addEventListener('input', function (e) {
      state.memberQuery = e.target.value;
      renderMembers();
    });
    $('qg-members').addEventListener('click', function (e) {
      var b = e.target.closest('[data-add-user]');
      if (!b) return;
      pickPerson(b.getAttribute('data-add-user'), b.getAttribute('data-add-name'));
    });

    // ── 好友 ──
    $('qg-friends-load').addEventListener('click', loadFriends);
    $('qg-friend-search').addEventListener('input', function (e) {
      state.friendQuery = e.target.value;
      renderFriends();
    });
    $('qg-friends').addEventListener('click', function (e) {
      var b = e.target.closest('[data-add-user]');
      if (!b) return;
      pickPerson(b.getAttribute('data-add-user'), b.getAttribute('data-add-name'));
    });

    // ── 手填 ──
    $('qg-add-confirm').addEventListener('click', function () {
      var qq = String($('qg-add-qq').value || '').trim();
      if (!/^\d{4,12}$/.test(qq)) { toast('QQ 号看起来不对（4~12 位数字）', true); return; }
      var rawLimit = String($('qg-add-limit').value || '').trim();
      var limit = rawLimit === '' ? 0 : parseLimit(rawLimit);      // 留空 = 不限（0）
      if (limit === null) { toast('额度填得不对，可以写 50000，也可以写 50k', true); return; }
      var name = String($('qg-add-name').value || '').trim();
      state.selected = qq;        // 先选中再落盘：新人是"即将出现"的，不能等响应回来才选
      act('setLimit', { userId: qq, limit: limit, name: name }, '已保存 ' + qq, true)
        .then(function () {
          $('qg-add-qq').value = '';
          $('qg-add-name').value = '';
          $('qg-add-limit').value = '';
          // 加完就收起来：把地方还给下面的额度列表（用户接着要看新加的人）
          $('qg-addbox').hidden = true;
          render({ keepSelection: true });
        }).catch(function () {});
    });

    // ── 插件开关（顶部）──
    $('qg-enable').addEventListener('change', function (e) {
      var want = e.target.checked === true;
      post('setEnabled', { enabled: want }).then(function (d) {
        state.data = d;
        render();
        toast(want ? '已开启：开始记账并拦人' : '已关闭：完全不工作');
      }).catch(function (err) {
        e.target.checked = !want;      // 失败要还原开关，别让界面撒谎
        note('切换失败：' + err.message, true);
      });
    });

    // 详情面板（委托：面板内容会整体重绘）
    $('qg-detail-body').addEventListener('change', function (e) {
      if (e.target.name === 'qg-mode') {
        var wrap = $('qg-custom-wrap');
        if (wrap) wrap.hidden = e.target.value !== 'custom';
        updateLimitHint();
      }
    });
    // 额度框边输边显示换算结果（"50k → 50,000 token"），省得自己数零
    $('qg-detail-body').addEventListener('input', function (e) {
      if (e.target.id === 'qg-detail-limit') updateLimitHint();
      markDetailDirty();      // 边输边把"有未保存改动"标出来（别等重绘）
    });
    $('qg-detail-body').addEventListener('change', markDetailDirty);
    $('qg-detail-body').addEventListener('click', function (e) {
      var qb = e.target.closest('[data-preset]');
      if (qb) {
        var inp = $('qg-detail-limit');
        if (inp) inp.value = qb.getAttribute('data-preset');
        var radio = document.querySelector('input[name="qg-mode"][value="custom"]');
        if (radio) radio.checked = true;
        if ($('qg-custom-wrap')) $('qg-custom-wrap').hidden = false;
        return;
      }
      var qq = state.selected;
      if (!qq) return;
      if (e.target.closest('#qg-detail-save')) {
        var mode = (document.querySelector('input[name="qg-mode"]:checked') || {}).value || 'default';
        var note = String(($('qg-detail-note') || {}).value || '');
        var limit = 0;
        if (mode === 'custom') {
          limit = parseLimit(($('qg-detail-limit') || {}).value);
          if (limit === null || limit <= 0) {
            toast('单独设额度时，额度要大于 0（想不限就选「单独不限」）', true);
            return;
          }
        }
        // 先写额度，再写备注（两步都要落盘；分开是为了复用已有的动作语义）
        act('setLimit', { userId: qq, limit: limit }, null)
          .then(function () { return act('setNote', { userId: qq, note: note }, '已保存 ' + qq + ' 的设置'); })
          .catch(function () {});
        return;
      }
      if (e.target.closest('#qg-detail-clear')) {
        return act('reset', { userId: qq }, '已重置 ' + qq + ' 的余额（今日用量不变）');
      }
      if (e.target.closest('#qg-detail-dropquota')) {
        return act('removeUser', { userId: qq }, '已取消 ' + qq + ' 的单独额度');
      }
      if (e.target.closest('#qg-detail-delete')) {
        openConfirm('删除 ' + qq + ' 的记录？', '会同时删掉他的单独额度和今天的用量记录。这个操作不可撤销。', function () {
          state.checked[qq] = false;
          delete state.checked[qq];
          return act('deletePerson', { userId: qq }, '已删除 ' + qq).then(function () {
            if (state.selected === qq) state.selected = '';
            render();
          });
        });
      }
    });

    // 模态框
    $('qg-modal-ok').addEventListener('click', submitModal);
    $('qg-modal-cancel').addEventListener('click', closeLimitModal);
    $('qg-modal').addEventListener('click', function (e) { if (e.target.id === 'qg-modal') closeLimitModal(); });
    $('qg-modal-quick').addEventListener('click', function (e) {
      var b = e.target.closest('[data-preset]');
      if (b) { $('qg-modal-limit').value = b.getAttribute('data-preset'); showModalLimit(); }
    });
    // 批量框也边输边换算，避免"设成 5000000 还是 500000"这种手滑
    $('qg-modal-limit').addEventListener('input', showModalLimit);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeLimitModal(); closeConfirm(); }
    });

    // 每 20 秒自动刷新用量。
    // ⚠️ 正在编辑输入框时**必须跳过** —— render() 会把输入框的 value 写回已保存的值，
    //    于是你刚敲的额度被悄悄还原（实测现象：「修改额度时输入栏被定时刷新重置」）。
    //    用户手动点「刷新」不受此限：那是他明确要求重载，走 refreshNow() 会清掉编辑标记。
    setInterval(function () {
      if (state.modal || isEditing()) return;
      load();
    }, 20000);
  }

  // ── 自建确认框（替代原生 confirm）──────────────────────────────────
  function openConfirm(title, hint, onOk) {
    var el = $('qg-confirm');
    if (!el) {
      el = document.createElement('div');
      el.className = 'qg-modal';
      el.id = 'qg-confirm';
      el.hidden = true;
      el.innerHTML = '<div class="qg-modalbox">'
        + '<h3 id="qg-confirm-title"></h3>'
        + '<p class="qg-hint" id="qg-confirm-hint"></p>'
        + '<div class="qg-form-actions">'
        + '<button class="btn btn-small btn-danger" id="qg-confirm-ok" type="button">确定</button>'
        + '<button class="btn btn-small" id="qg-confirm-cancel" type="button">取消</button>'
        + '</div></div>';
      document.body.appendChild(el);
      el.addEventListener('click', function (e) { if (e.target.id === 'qg-confirm') el.hidden = true; });
      $('qg-confirm-cancel').addEventListener('click', function () { el.hidden = true; });
    }
    $('qg-confirm-title').textContent = title;
    $('qg-confirm-hint').textContent = hint || '';
    // 换掉旧的确定按钮（避免监听器叠加）
    var old = $('qg-confirm-ok');
    var fresh = old.cloneNode(true);
    old.parentNode.replaceChild(fresh, old);
    fresh.addEventListener('click', function () {
      el.hidden = true;
      try { var r = onOk(); if (r && r.catch) r.catch(function () {}); } catch (_) { /* 已提示 */ }
    });
    el.hidden = false;
  }

  function closeConfirm() {
    var el = $('qg-confirm');
    if (el) el.hidden = true;
  }

  document.addEventListener('DOMContentLoaded', function () {
    bind();
    $('qg-modal-quick').innerHTML = quickButtonsHtml();
    switchPage('daily');
    load();
  });

  /**
   * 只读调试出口：给自动化测试看"页面当前认为的列表内容"。
   *
   * 刻意只暴露**读**，不暴露任何会改状态的东西 —— 测试要改状态一律走真实动作
   * （fetch 桥打到插件的 handleUiRequest），否则测的就不是用户走的那条路了。
   */
  window.__qgDebug = {
    groups: function () { return state.groups; },
    members: function () { return state.members; },
    friends: function () { return state.friends; },
    selected: function () { return state.selected; },
    checked: function () { return Object.keys(state.checked).filter(function (k) { return state.checked[k]; }); },
    page: function () { return state.page; },
    board: function () { return state.board; },
    // 页面**当前正在渲染的那份**数据。测试要核对"界面显示的是不是这份数据"时用它，
    // 不要另发一次请求 —— 两次读之间数据可能已经变了，断言会随机失败。
    data: function () { return state.data; },
    // 当前筛选/排序后真正要画进列表的行。列表渲染出问题时用它定位是"数据没有"
    // 还是"过滤/渲染坏了" —— 光看 innerHTML 为空分不清这两种。
    visible: function () { return visibleRows(); },
    filter: function () { return { q: state.query, f: state.filter, sort: state.sort }; }
  };
})();
