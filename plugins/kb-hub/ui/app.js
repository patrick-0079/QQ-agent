/* 多知识库中心 · 页面逻辑
 *
 * 分工与其它插件页面一致：本页面**不做任何判定逻辑**，
 * 所有数据都来自插件的 handleUiRequest —— 保证「界面显示的」和「实际生效的」同源。
 * 页面里唯一自己算的东西是「输入框的即时回显」，保存时整体回传。
 */
(function () {
  'use strict';

  var PLUGIN_ID = 'kb-hub';
  var ACTION_URL = '/api/plugin-ui/' + PLUGIN_ID + '/action';
  var TOKEN_KEY = 'qqa-console-token';

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function toast(msg, kind) {
    var el = $('kh-toast');
    el.textContent = msg;
    el.className = 'kh-toast' + (kind ? ' is-' + kind : '');
    el.hidden = false;
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.hidden = true; }, kind === 'err' ? 6000 : 2800);
  }
  function note(msg, kind) {
    var el = $('kh-note');
    if (!msg) { el.hidden = true; el.textContent = ''; return; }
    el.textContent = msg;
    el.className = 'kh-note' + (kind ? ' is-' + kind : '');
    el.hidden = false;
  }
  function splitList(v) {
    return String(v || '').split(/[,，、\n\r;；\s]+/).map(function (x) { return x.trim(); }).filter(Boolean);
  }

  /** 所有后端调用都走这里，失败一律转成 { ok:false, error } —— 页面不需要 try/catch 满天飞。 */
  function action(name, payload) {
    var headers = { 'content-type': 'application/json' };
    try {
      var tk = localStorage.getItem(TOKEN_KEY);
      if (tk) headers['x-console-token'] = tk;
    } catch (e) { /* localStorage 不可用就按无令牌走 */ }
    return fetch(ACTION_URL, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ action: name, payload: payload || {} })
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status + '（响应不是 JSON）' }; });
    }).catch(function (e) {
      return { ok: false, error: '请求失败：' + (e && e.message ? e.message : e) };
    });
  }

  var S = { data: null, cur: null, calls: {}, stats: null };

  // ── 调用统计与排行（只读展示，**不影响检索**）────────────────────────────
  function loadStats() {
    var sortBy = $('kh-stats-sort') ? $('kh-stats-sort').value : 'total';
    var zero = $('kh-stats-zero') ? $('kh-stats-zero').checked : false;
    return action('stats', { limit: 100, sortBy: sortBy, includeZero: zero }).then(function (r) {
      if (!r || r.ok !== true) {
        $('kh-stats-summary').innerHTML = '<span class="kh-err">统计读取失败：' + esc((r && r.error) || '未知错误') + '</span>';
        return;
      }
      S.stats = r;
      renderStats();
    });
  }

  function fmtTime(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    return d.toLocaleString();
  }

  function renderStats() {
    var r = S.stats;
    if (!r) return;
    var t = r.totals || {};
    $('kh-stats-summary').innerHTML = '累计调用 <b>' + (t.calls || 0) + '</b> 次 · 被用过的知识 <b>'
      + (t.entriesCalled || 0) + '</b> / ' + (t.entriesTotal || 0) + ' 条 · 从未用过 <b>' + (t.neverCalled || 0)
      + '</b> 条 · 统计更新于 ' + esc(fmtTime(r.updatedAt))
      + '<br /><span class="kh-muted">文件：' + esc(r.file || '') + '（放在知识库目录之外，不会被当成一本知识库）</span>';

    var bs = r.bases || [];
    $('kh-stats-bases').innerHTML = bs.length
      ? '按库合计：' + bs.map(function (b) {
        return '<span class="kh-tag">' + esc(b.name) + ' ' + b.total + ' 次'
          + (b.read ? '（读整本 ' + b.read + '）' : '') + '</span>';
      }).join(' ')
      : '';

    var rows = r.rows || [];
    if (!rows.length) {
      $('kh-stats-rows').innerHTML = '<div class="kh-empty">还没有任何调用记录。等群里问过几次之后再看，就能知道哪些知识真在被用、哪些是白写的。</div>';
      return;
    }
    var html = '<div class="kh-hint">排行（点一行可直接打开那本库）：</div>';
    for (var i = 0; i < rows.length; i++) {
      var x = rows[i];
      html += '<div class="kh-hit" data-open="' + esc(x.baseId) + '" style="cursor:pointer">'
        + '<span class="kh-score">#' + (i + 1) + ' · ' + x.total + ' 次</span>'
        + '<div><b>' + esc(x.baseName) + '</b> · ' + esc(x.question)
        + '<div class="kh-muted">自动带入 ' + x.inject + ' · 主动检索 ' + x.search
        + (x.total === 0 ? ' · <span class="kh-warnbox">从未被调用</span>' : ' · 最近 ' + esc(fmtTime(x.lastAt)))
        + '</div></div></div>';
    }
    $('kh-stats-rows').innerHTML = html;
  }

  // ── 顶部与状态 ──────────────────────────────────────────────────────────
  function renderHeader() {
    var d = S.data;
    if (!d) return;
    var s = d.settings || {};
    var st = d.stats || {};
    var on = s.enabled !== false;
    var badge = $('kh-state');
    badge.textContent = on ? '生效中' : '已关闭';
    badge.className = 'kh-badge ' + (on ? 'is-on' : 'is-off');

    $('kh-sub').textContent = (d.bases || []).length + ' 本库 · ' + (st.totalEntries || 0) + ' 条 · '
      + (s.autoInject === false ? '自动带入已关' : '自动带入开（相关度≥' + (s.autoInjectMinScore || 6) + '）')
      + ' · 已注入 ' + (st.injectHits || 0) + ' 轮';

    var status = $('kh-status');
    if (!on) {
      status.className = 'kh-hint kh-warnbox';
      status.innerHTML = '⚠️ <b>总开关是关的</b>：不会自动带入，也不给机器人检索工具。'
        + '去「插件 → 多知识库中心」的设置里打开「启用多知识库中心」。';
    } else if (!(d.bases || []).length) {
      status.className = 'kh-hint kh-warnbox';
      status.innerHTML = '⚠️ <b>还没有任何知识库</b>，所以现在什么都不会发生。点左边的「＋ 新建」或「导入文本」建第一本。';
    } else {
      status.className = 'kh-hint';
      status.innerHTML = '✅ 正在工作：自动带入 ' + (st.injectHits || 0) + ' 轮 · 主动查过 ' + (st.searches || 0) + ' 次'
        + (st.lastInjectAt ? ' · 最近一次带入：' + new Date(st.lastInjectAt).toLocaleString() : '');
    }

    var errs = d.errors || [];
    $('kh-errors').innerHTML = errs.length
      ? '<span class="kh-err">有 ' + errs.length + ' 个文件读不了（不影响其它库）：' + esc(errs.join('；')) + '</span>'
      : '';
    $('kh-dirs').innerHTML = '结构化库：<span class="kh-code">' + esc((d.dirs || {}).kb || '') + '</span><br />'
      + '文档库：<span class="kh-code">' + esc((d.dirs || {}).docs || '') + '</span>';
  }

  // ── 左侧列表 ────────────────────────────────────────────────────────────
  function renderList() {
    var d = S.data;
    if (!d) return;
    var bases = d.bases || [];
    $('kh-list-title').textContent = '知识库（' + bases.length + '）';
    var box = $('kh-bases');
    if (!bases.length) {
      box.innerHTML = '<div class="kh-empty">还没有知识库。<br />点「＋ 新建」建一本空库，或「导入文本」把已有资料粘进来。</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < bases.length; i++) {
      var b = bases[i];
      var tags = [];
      tags.push('<span class="kh-tag">' + b.entryCount + ' 条</span>');
      if (b.calls) tags.push('<span class="kh-tag ac">调用 ' + b.calls + '</span>');
      if (b.always) tags.push('<span class="kh-tag warn">常驻</span>');
      if (b.enabled === false) tags.push('<span class="kh-tag">已停用</span>');
      if (b.source === 'doc') tags.push('<span class="kh-tag ac">文档库</span>');
      if (b.scope && b.scope !== 'all') tags.push('<span class="kh-tag ac">' + esc(b.scopeLabel || '限定范围') + '</span>');
      html += '<button type="button" class="kh-base' + (S.cur && S.cur.id === b.id ? ' on' : '') + '" data-id="' + esc(b.id) + '">'
        + '<div class="kh-base-top"><span class="kh-base-name">' + esc(b.name) + '</span>'
        + '<span class="kh-base-id">' + esc(b.id) + '</span></div>'
        + (b.description ? '<div class="kh-base-desc">' + esc(b.description) + '</div>' : '')
        + '<div class="kh-tags">' + tags.join('') + '</div>'
        + '</button>';
    }
    box.innerHTML = html;
  }

  // ── 右侧编辑器 ──────────────────────────────────────────────────────────
  function renderEditor() {
    var d = $('kh-detail');
    var b = S.cur;
    if (!b) {
      d.innerHTML = '<div class="kh-empty">左边选一本知识库，这里就会出现它的编辑界面。</div>';
      return;
    }
    var isDoc = b.source === 'doc';
    var html = '';

    html += '<div class="kh-card-head"><h2>' + esc(b.name) + '</h2><div class="kh-actions">'
      + (isDoc
        ? '<button class="btn" id="kh-save-meta" type="button">保存设置</button>'
        : '<button class="btn" id="kh-save" type="button">保存</button>')
      + '<button class="kh-del" id="kh-delete" type="button">删除这本库</button>'
      + '</div></div>';

    html += '<div class="kh-hint">id：<span class="kh-code">' + esc(b.id) + '</span>'
      + (isDoc ? ' · 来源文件：<span class="kh-code">docs/' + esc(b.file) + '</span>' : ' · 文件：<span class="kh-code">' + esc(b.file) + '</span>')
      + '</div>';

    if (isDoc) {
      html += '<div class="kh-hint kh-warnbox">这是<b>文档库</b>：正文在文件里，改正文请编辑 '
        + '<span class="kh-code">docs/' + esc(b.file) + '</span> 并保存；这里只能改下面的说明和开关（改完点「保存设置」）。</div>';
    }

    html += '<div class="kh-row">'
      + '<div class="kh-field"><label class="kh-label">库名（给机器人看的名字）</label>'
      + '<input class="kh-input" data-base="name" type="text" value="' + esc(b.name) + '"' + (isDoc ? ' disabled' : '') + ' /></div>'
      + '<div class="kh-field"><label class="kh-label">关键词（逗号分隔，命中就一定查这本）</label>'
      + '<input class="kh-input" data-base="keywords" type="text" value="' + esc((b.keywords || []).join('，')) + '" /></div>'
      + '</div>';

    html += '<div class="kh-field"><label class="kh-label">一句话说明（机器人靠它判断该不该查这本）</label>'
      + '<input class="kh-input" data-base="description" type="text" value="' + esc(b.description || '') + '" /></div>';

    html += '<label class="kh-check"><input type="checkbox" data-base="always"' + (b.always ? ' checked' : '')
      + ' /> 常驻：每轮都带上这本库（适合群规这种必须一直遵守的）</label>';
    html += '<label class="kh-check"><input type="checkbox" data-base="enabled"' + (b.enabled === false ? '' : ' checked')
      + ' /> 启用这本库（取消勾选 = 暂时不用它，内容保留）</label>';

    // 生效范围：决定这本库在哪些会话里能用。
    // 判定发生在插件的检索层，所以自动带入、机器人主动查、清单提示三处会同时生效/失效。
    var scope = b.scope || 'all';
    html += '<div class="kh-row" style="margin-top:10px">'
      + '<div class="kh-field"><label class="kh-label">生效范围</label>'
      + '<select class="kh-select" data-base="scope">'
      + '<option value="all"' + (scope === 'all' ? ' selected' : '') + '>全部会话（默认）</option>'
      + '<option value="private"' + (scope === 'private' ? ' selected' : '') + '>只在私聊</option>'
      + '<option value="groups"' + (scope === 'groups' ? ' selected' : '') + '>只在下面列出的会话</option>'
      + '<option value="except"' + (scope === 'except' ? ' selected' : '') + '>除了下面列出的会话，其它都生效</option>'
      + '</select></div>'
      + '<div class="kh-field"><label class="kh-label">会话列表（群号或 QQ 号，逗号/换行分隔；也可写 group:123 / private:456）</label>'
      + '<input class="kh-input" data-base="scopeChats" type="text" value="' + esc((b.scopeChats || []).join('，')) + '" placeholder="例：1039172534，987654321" /></div>'
      + '</div>'
      + '<div class="kh-hint kh-muted">当前：<b>' + esc(b.scopeLabel || '全部会话') + '</b>'
      + '。想只在自己私聊里用，就选「只在私聊」；想避开某个群，就选「除了…以外」再把群号填进去。改完记得保存。</div>';

    if (isDoc) {
      html += '<div class="kh-card-head" style="margin-top:14px"><h2>内容预览（' + b.entries.length + ' 条）</h2></div>';
      html += b.entries.length
        ? '<div class="kh-entries">' + b.entries.slice(0, 40).map(function (e, i) {
          return '<div class="kh-entry"><div class="kh-entry-head"><span class="kh-entry-no">#' + (i + 1) + '</span></div>'
            + '<div class="kh-hint"><b>' + esc(e.question || e.title || '（无标题）') + '</b></div>'
            + '<div class="kh-hint">' + esc(String(e.answer || '').slice(0, 200)) + '</div></div>';
        }).join('') + '</div>'
        : '<div class="kh-empty">这个文件没解析出内容。检查一下是不是空文件。</div>';
    } else {
      html += '<div class="kh-card-head" style="margin-top:14px"><h2>内容（' + b.entries.length + ' 条）</h2>'
        + '<div class="kh-actions"><button class="btn btn-small" id="kh-add-entry" type="button">＋ 加一条</button></div></div>';
      html += '<div class="kh-entries" id="kh-entries">';
      if (!b.entries.length) {
        html += '<div class="kh-empty">这本库还是空的。点「＋ 加一条」开始写：<br />'
          + '「问题/说法」写群友可能怎么问，「内容」写标准答案。</div>';
      }
      for (var i = 0; i < b.entries.length; i++) {
        var e = b.entries[i];
        html += '<div class="kh-entry">'
          + '<div class="kh-entry-head"><span class="kh-entry-no">#' + (i + 1) + '</span>'
          + '<span class="kh-tags">' + callBadge(e.id) + '</span>'
          + '<button class="kh-del" type="button" data-del="' + i + '">删除</button></div>'
          + '<div class="kh-field"><label class="kh-label">问题 / 说法（群友可能怎么问）</label>'
          + '<input class="kh-input" data-idx="' + i + '" data-field="question" type="text" value="' + esc(e.question || '') + '" /></div>'
          + '<div class="kh-field"><label class="kh-label">内容（标准答案，机器人会照着说）</label>'
          + '<textarea class="kh-textarea" data-idx="' + i + '" data-field="answer">' + esc(e.answer || '') + '</textarea></div>'
          + '<div class="kh-field"><label class="kh-label">这条的关键词（可选，逗号分隔）</label>'
          + '<input class="kh-input" data-idx="' + i + '" data-field="keywords" type="text" value="' + esc((e.keywords || []).join('，')) + '" /></div>'
          + '</div>';
      }
      html += '</div>';
      html += '<div class="kh-btns"><button class="btn" id="kh-save2" type="button">保存</button>'
        + '<span class="kh-muted">改完一定要点保存；保存后立刻生效，不用重启。</span></div>';
    }

    d.innerHTML = html;
    renderList();
  }

  // ⚠️ 编辑区的事件**只挂一次**（在 init 里），不要写进 renderEditor：
  //    #kh-detail 这个容器本身不会被替换（换的是它的 innerHTML），
  //    每次渲染都 addEventListener 的话监听器会越叠越多 ——
  //    表现为“点一次「加一条」却加了好几条”，而且刷新次数越多越严重。
  function bindDetailOnce() {
    var d = $('kh-detail');

    // 输入即时回写内存（**不**重渲染，否则输入框会掉焦点）
    d.addEventListener('input', function (ev) {
      var el = ev.target;
      if (!S.cur || !el || !el.getAttribute) return;
      var bk = el.getAttribute('data-base');
      if (bk) {
        if (bk === 'keywords' || bk === 'scopeChats') S.cur[bk] = splitList(el.value);
        else if (bk === 'always' || bk === 'enabled') S.cur[bk] = !!el.checked;
        else S.cur[bk] = el.value;
        return;
      }
      var idx = Number(el.getAttribute('data-idx'));
      var f = el.getAttribute('data-field');
      if (f && Number.isInteger(idx) && S.cur.entries && S.cur.entries[idx]) {
        S.cur.entries[idx][f] = f === 'keywords' ? splitList(el.value) : el.value;
      }
    });

    d.addEventListener('change', function (ev) {
      var el = ev.target;
      var bk = el && el.getAttribute ? el.getAttribute('data-base') : null;
      if (!bk || !S.cur) return;
      if (bk === 'always' || bk === 'enabled') S.cur[bk] = !!el.checked;
      else if (bk === 'scope') { S.cur.scope = el.value; renderEditor(); }
    });

    d.addEventListener('click', function (ev) {
      var el = ev.target;
      if (!el || !el.getAttribute) return;
      var del = el.getAttribute('data-del');
      if (del !== null && del !== undefined && del !== '') {
        S.cur.entries.splice(Number(del), 1);
        renderEditor();
        toast('已删除这一条（记得点保存）');
        return;
      }
      switch (el.id) {
        case 'kh-add-entry':
          S.cur.entries.push({ id: 'e' + Date.now().toString(36), title: '', question: '', answer: '', keywords: [], tags: [] });
          renderEditor();
          toast('加了一条，写完记得保存');
          break;
        case 'kh-save':
        case 'kh-save2':
          saveBase();
          break;
        case 'kh-save-meta':
          saveMetaOnly();
          break;
        case 'kh-delete':
          deleteBase();
          break;
        default:
          break;
      }
    });
  }

  // ── 动作 ────────────────────────────────────────────────────────────────
  function load(keepCurrent) {
    return action('state').then(function (r) {
      if (!r || r.ok !== true) {
        note('读取失败：' + ((r && r.error) || '未知错误'), 'err');
        return;
      }
      note('');
      S.data = r;
      renderHeader();
      if (keepCurrent && S.cur && (r.bases || []).some(function (b) { return b.id === S.cur.id; })) {
        // 保存后刷新：重新拉一次当前库的完整内容
        return openBase(S.cur.id, true);
      }
      renderList();
      return null;
    });
  }

  function openBase(id, quiet) {
    return action('get', { id: id }).then(function (r) {
      if (!r || r.ok !== true) {
        if (!quiet) toast((r && r.error) || '打不开这本库', 'err');
        return;
      }
      S.cur = r.base;
      S.calls = r.calls || {};       // 每条知识的调用次数（只展示，不影响检索）
      if (!Array.isArray(S.cur.entries)) S.cur.entries = [];
      renderEditor();
      if (!quiet) $('kh-detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }

  /** 单条知识的调用次数徽章。 */
  function callBadge(entryId) {
    var c = (S.calls || {})[entryId];
    if (!c) return '';
    if (!c.total) return '<span class="kh-tag">未用过</span>';
    return '<span class="kh-tag ac" title="自动带入 ' + c.inject + ' 次 · 主动检索 ' + c.search + ' 次">调用 ' + c.total + '</span>';
  }

  function saveBase() {
    var b = S.cur;
    if (!b) return;
    if (!String(b.name || '').trim()) { toast('库名不能为空', 'err'); return; }
    action('save', { base: b }).then(function (r) {
      if (!r || r.ok !== true) { toast((r && r.error) || '保存失败', 'err'); return; }
      toast('已保存：' + r.saved.name + '（' + r.saved.entryCount + ' 条）', 'ok');
      load(true);
    });
  }

  function saveMetaOnly() {
    var b = S.cur;
    if (!b) return;
    action('save-meta', {
      id: b.id, description: b.description, keywords: b.keywords,
      always: b.always, enabled: b.enabled, scope: b.scope, scopeChats: b.scopeChats
    }).then(function (r) {
      if (!r || r.ok !== true) { toast((r && r.error) || '保存失败', 'err'); return; }
      toast('设置已保存', 'ok');
      load(true);
    });
  }

  function deleteBase() {
    var b = S.cur;
    if (!b) return;
    if (!window.confirm('确定删除「' + b.name + '」吗？\n' + (b.source === 'doc' ? '会删掉 docs/' + b.file + ' 这个文件。' : '会删掉这个库的全部内容。') + '\n删了没法撤销。')) return;
    action('delete', { id: b.id }).then(function (r) {
      if (!r || r.ok !== true) { toast((r && r.error) || '删除失败', 'err'); return; }
      S.cur = null;
      renderEditor();
      toast('已删除：' + (r.deleted || b.name), 'ok');
      load(false);
    });
  }

  function createBase() {
    var name = $('kh-new-name').value.trim();
    if (!name) { toast('先给这本库起个名字', 'err'); return; }
    action('create', {
      name: name,
      id: $('kh-new-id').value.trim(),
      description: $('kh-new-desc').value.trim(),
      keywords: $('kh-new-keys').value.trim(),
      always: $('kh-new-always').checked
    }).then(function (r) {
      if (!r || r.ok !== true) { toast((r && r.error) || '创建失败', 'err'); return; }
      $('kh-new-name').value = ''; $('kh-new-id').value = ''; $('kh-new-desc').value = ''; $('kh-new-keys').value = '';
      $('kh-new-always').checked = false;
      $('kh-panel-new').hidden = true;
      toast('已创建：' + r.base.name + '（' + r.base.id + '）', 'ok');
      load(false).then(function () { return openBase(r.base.id); });
    });
  }

  function importText() {
    var name = $('kh-imp-name').value.trim();
    var text = $('kh-imp-text').value;
    if (!name) { toast('先给这本库起个名字', 'err'); return; }
    if (!text.trim()) { toast('正文是空的', 'err'); return; }
    action('import', {
      name: name,
      id: $('kh-imp-id').value.trim(),
      description: $('kh-imp-desc').value.trim(),
      keywords: $('kh-imp-keys').value.trim(),
      text: text,
      always: $('kh-imp-always').checked
    }).then(function (r) {
      if (!r || r.ok !== true) { toast((r && r.error) || '导入失败', 'err'); return; }
      $('kh-imp-name').value = ''; $('kh-imp-id').value = ''; $('kh-imp-desc').value = ''; $('kh-imp-keys').value = ''; $('kh-imp-text').value = '';
      $('kh-imp-always').checked = false;
      $('kh-panel-import').hidden = true;
      toast('已导入 ' + r.entries + ' 条到「' + name + '」', 'ok');
      load(false).then(function () { return openBase(r.id); });
    });
  }

  function runTest() {
    var q = $('kh-test').value.trim();
    if (!q) { toast('先打一句话', 'err'); return; }
    var chat = $('kh-test-chat') ? $('kh-test-chat').value.trim() : '';
    action('test', { query: q, chatKey: chat }).then(function (r) {
      var out = $('kh-testout');
      if (!r || r.ok !== true) {
        out.innerHTML = '<div class="kh-err">测试失败：' + esc((r && r.error) || '未知错误') + '</div>';
        return;
      }
      var html = '<div class="kh-hint">按会话 <span class="kh-code">' + esc(r.chatKey || '') + '</span> 测试：可用 '
        + (r.usableBases || []).length + ' 本'
        + ((r.blockedBases || []).length ? '，被作用域挡掉 ' + r.blockedBases.length + ' 本（' + esc(r.blockedBases.join('、')) + '）' : '')
        + ' · 门槛 ' + r.threshold + '</div>';
      if (r.hits && r.hits.length) {
        html += '<div class="kh-hint">命中 ' + r.hits.length + ' 条：</div>';
        for (var i = 0; i < r.hits.length; i++) {
          var h = r.hits[i];
          html += '<div class="kh-hit"><span class="kh-score">' + h.score + '</span>'
            + '<div><b>' + esc(h.base) + '</b> · ' + esc(h.question || '(无问题)')
            + '<div class="kh-muted">' + esc(h.why.join(' / ')) + '</div>'
            + '<div class="kh-hint">' + esc(h.answer) + '</div></div></div>';
        }
      } else {
        html += '<div class="kh-empty">没有命中任何一条 —— 这句话不会触发自动带入。<br />'
          + '如果这是该命中的内容：把相关词写进这本库的「关键词」，或把设置里的「自动带入的最低相关度」调低一点'
          + '；也检查一下这本库的「生效范围」是不是把当前会话排除了。</div>';
      }
      if (r.injected) {
        html += '<div class="kh-hint" style="margin-top:12px">实际会塞给机器人的内容（原文）：</div>'
          + '<pre class="kh-pre">' + esc(r.injected) + '</pre>';
      }
      out.innerHTML = html;
    });
  }

  // ── 初始化 ──────────────────────────────────────────────────────────────
  function init() {
    bindDetailOnce();

    // 调用统计控件（排行只做展示，不影响检索）
    $('kh-stats-sort').addEventListener('change', loadStats);
    $('kh-stats-zero').addEventListener('change', loadStats);
    $('kh-stats-refresh').addEventListener('click', function () {
      loadStats().then(function () { toast('统计已刷新'); });
    });
    $('kh-stats-reset').addEventListener('click', function () {
      if (!window.confirm('确定把所有调用次数清零吗？\n这只影响统计数字，不影响任何知识库内容与检索结果。')) return;
      action('stats-reset', {}).then(function (r) {
        if (!r || r.ok !== true) { toast((r && r.error) || '清零失败', 'err'); return; }
        toast('统计已清零', 'ok');
        loadStats();
      });
    });
    // 点排行里的一行 → 打开那本库（方便直接看被频繁调用的内容）
    $('kh-stats-rows').addEventListener('click', function (ev) {
      var el = ev.target;
      while (el && el !== this && !el.getAttribute('data-open')) el = el.parentNode;
      if (el && el !== this) openBase(el.getAttribute('data-open'));
    });

    $('kh-bases').addEventListener('click', function (ev) {
      var el = ev.target;
      while (el && el !== this && !el.getAttribute('data-id')) el = el.parentNode;
      if (el && el !== this) openBase(el.getAttribute('data-id'));
    });

    $('kh-new').addEventListener('click', function () {
      $('kh-panel-new').hidden = false;
      $('kh-panel-import').hidden = true;
      $('kh-new-name').focus();
    });
    $('kh-new-cancel').addEventListener('click', function () { $('kh-panel-new').hidden = true; });
    $('kh-new-go').addEventListener('click', createBase);

    $('kh-import').addEventListener('click', function () {
      $('kh-panel-import').hidden = false;
      $('kh-panel-new').hidden = true;
      $('kh-imp-name').focus();
    });
    $('kh-import-cancel').addEventListener('click', function () { $('kh-panel-import').hidden = true; });
    $('kh-imp-go').addEventListener('click', importText);

    $('kh-test-go').addEventListener('click', runTest);
    $('kh-test').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') runTest(); });

    $('kh-reload').addEventListener('click', function () {
      action('reload').then(function (r) {
        if (!r || r.ok !== true) { toast((r && r.error) || '扫描失败', 'err'); return; }
        toast('已重新扫描：' + r.bases + ' 本 / ' + r.entries + ' 条', 'ok');
        load(true);
        loadStats();
      });
    });

    $('kh-open-kb').addEventListener('click', function () { openDir('kb'); });
    $('kh-open-docs').addEventListener('click', function () { openDir('docs'); });

    load(false);
    loadStats();
  }

  function openDir(which) {
    action('open-dir', { which: which }).then(function (r) {
      if (!r || r.ok !== true) toast((r && r.error) || '打不开文件夹', 'err');
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
