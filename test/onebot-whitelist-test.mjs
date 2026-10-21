// 聊天白名单 → 会话个性化全链路测试（2026-10-21 更新口径）
//
// 旧「设置 → 聊天白名单 → 选择群/好友」UI 已移除；本测试改为覆盖两条链路：
//   · 后端：GET /api/onebot/groups|friends → OneBot get_group_list / get_friend_list（不变）
//   · 前端：设置 → 会话列表「＋ 添加会话」弹窗 → 选中条目 → 添加即准入；
//           会话覆盖只写会话（/api/config?chat= 变化），默认配置不被污染
//
// 除 OneBot 本身是 _harness 的 mock（标准 OneBot v11 形状）外，其余全部是真实代码。
//
// 运行：node test/onebot-whitelist-test.mjs（jsdom 为可选依赖，缺前端段自动跳过）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, bootApp, createChecker, listen, sleep, waitFor } from './_harness.mjs';

const c = createChecker('聊天白名单拉取（后端全链路）');
const ctx = await bootApp({});
const { request, app, onebotHttp, teardown } = ctx;

// ── 1) 后端 API：真实路由 + 真实 onebot.call + 映射 ──────────────────────
await c.check('GET /api/onebot/groups：群列表映射为 {id,name}（id 字符串化）', async () => {
  const r = await request('GET', '/api/onebot/groups');
  assert.equal(r.status, 200, `状态码：${r.status} ${r.text}`);
  assert.deepEqual(r.data.groups, [
    { id: '456', name: '覆盖群456' },
    { id: '789', name: '备用群789' }
  ]);
  assert.ok(onebotHttp.state.calls.includes('get_group_list'), 'OneBot 侧确实收到了 get_group_list');
});

await c.check('GET /api/onebot/friends：好友名 remark 优先于 nickname', async () => {
  const r = await request('GET', '/api/onebot/friends');
  assert.equal(r.status, 200, `状态码：${r.status} ${r.text}`);
  // mock 返回 {user_id:777, nickname:'好友777', remark:'老友'} —— 名字应取备注「老友」
  assert.deepEqual(r.data.friends, [{ id: '777', name: '老友' }]);
  assert.ok(onebotHttp.state.calls.includes('get_friend_list'), 'OneBot 侧确实收到了 get_friend_list');
});

await c.check('缺名字时的兜底：群名缺省退回群号、好友退回昵称/账号', async () => {
  // 起一个只回边界数据的临时 OneBot（不动共享 mock 的固定夹具）
  const edge = http.createServer((req, res) => {
    const action = String(req.url || '').replace(/^\//, '');
    const reply = (data) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
    };
    if (action === 'get_group_list') return reply([{ group_id: 10001 }, { group_id: 10002, group_name: '有名群' }]);
    if (action === 'get_friend_list') return reply([{ user_id: 20001 }, { user_id: 20002, nickname: '小名' }]);
    res.writeHead(404); res.end('{}');
  });
  const port = await listen(edge);
  const old = app.onebot.httpUrl;
  app.onebot.httpUrl = `http://127.0.0.1:${port}`;
  try {
    const g = await request('GET', '/api/onebot/groups');
    assert.deepEqual(g.data.groups, [{ id: '10001', name: '10001' }, { id: '10002', name: '有名群' }]);
    const f = await request('GET', '/api/onebot/friends');
    assert.deepEqual(f.data.friends, [{ id: '20001', name: '20001' }, { id: '20002', name: '小名' }]);
  } finally {
    app.onebot.httpUrl = old;
    await new Promise((r) => edge.close(r));
  }
});

await c.check('OneBot 不可达 → 502 + 可读 error（前端「拉取失败」文案的依据）', async () => {
  const old = app.onebot.httpUrl;
  app.onebot.httpUrl = 'http://127.0.0.1:9';   // 关闭端口：连接被拒
  try {
    const r = await request('GET', '/api/onebot/groups');
    assert.equal(r.status, 502, `状态码：${r.status} ${r.text}`);
    assert.ok(r.data && typeof r.data.error === 'string' && /get_group_list/.test(r.data.error),
      `error 应说明是哪个动作失败：${r.data && r.data.error}`);
  } finally {
    app.onebot.httpUrl = old;
  }
});

// ── 2) 前端真实操作路径（jsdom + 真实后端）────────────────────────────────
const c2 = createChecker('聊天白名单拉取（前端真实操作路径）');
let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { JSDOM = null; }

if (!JSDOM) {
  c2.ok('jsdom 未安装 —— 前端段已跳过（npm i -D jsdom 后自动启用）');
} else {
  const html = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
  let code = (await import('./_ui-load.mjs')).loadUiAppCode().code;
  code = code.replace(/^'use strict';\s*$/m, '');
  code = code.replace(/^export\s+(function|const|let|async function|class)/gm, '$1');

  const dom = new JSDOM(html, { url: ctx.base + '/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  // 与 coverage-wiring 同款环境垫片：fetch 代理到真实后端、EventSource/confirm 等空实现
  window.fetch = (input, init) => fetch(new URL(String(input), ctx.base).href, init);
  window.EventSource = class { constructor() {} addEventListener() {} close() {} };
  window.alert = () => {};
  window.confirm = () => true;
  if (typeof window.structuredClone !== 'function') {
    window.structuredClone = (v) => JSON.parse(JSON.stringify(v));
  }
  const tier = await import(pathToFileURL(path.join(ROOT, 'src', 'tier-slider.js')).href);
  const priceMod = await import(pathToFileURL(path.join(ROOT, 'ui', 'vendor', 'price-match.js')).href);
  window.TIER_SLIDER_BANDS = tier.TIER_SLIDER_BANDS;
  window.sliderToTier = tier.sliderToTier;
  window.tierToSlider = tier.tierToSlider;
  window.matchPriceTable = priceMod.matchPriceTable;

  window.eval(code);
  await sleep(1500);

  const doc = window.document;

  // 二次确认弹窗（uiConfirm）：关弹窗有 400ms 退场动画，jsdom 里上一个确认框
  // 可能还在 DOM 里，所以永远点"最后一个"（最新打开的）确认按钮。
  const clickConfirm = async () => {
    await waitFor(() => doc.querySelectorAll('#ui-confirm-ok').length > 0, 5000, '确认弹窗');
    const btns = [...doc.querySelectorAll('#ui-confirm-ok')];
    btns[btns.length - 1].click();
  };

  await c2.check('进设置 → 「安全与准入」分区：acceptAllSessions 开关就位', async () => {
    window.switchTab('settings');
    await waitFor(() => doc.querySelector('[data-gsec="security"]'), 8000, '设置侧栏渲染');
    doc.querySelector('[data-gsec="security"]').click();
    await waitFor(() => doc.querySelector('#cfg-accept-all'), 8000, '安全与准入分区渲染');
  });

  await c2.check('迁移后旧 allow 会话已出现在左栏（每群/私聊一个条目）', async () => {
    // 会话列表现在在「会话管理」左栏，设置页只留全局分区
    window.switchTab('chatmanage');
    await waitFor(() => doc.querySelectorAll('#cm-rail .chat-row').length >= 2, 8000, '会话管理左栏渲染');
    const rows = [...doc.querySelectorAll('.session-menu .chat-row')];
    assert.ok(rows.length >= 2, `应有至少两个会话行，实际 ${rows.length}`);
    assert.ok(rows.some((el) => (el.textContent || '').includes('覆盖群456')), `应有覆盖群456：${rows.map((e) => e.textContent.trim()).join(' | ')}`);
  });

  await c2.check('点 🗑 移除会话：行消失（不再单独准入）', async () => {
    const row = [...doc.querySelectorAll('.session-menu .chat-row')]
      .find((el) => el.dataset.chatKey === 'group:456');
    assert.ok(row, '应有 group:456 行');
    row.querySelector('[data-chat-remove]').click();
    // 移除有二次确认弹窗（uiConfirm）——点「确定」才真的删
    await clickConfirm();
    await waitFor(() => ![...doc.querySelectorAll('.session-menu .chat-row')]
      .some((el) => el.dataset.chatKey === 'group:456' && el.classList.contains('admitted')), 5000, '会话行移除');
    const g = await window.api('/api/chat-profiles');
    assert.ok(!(g.sessions || []).some((x) => x.key === 'group:456' && x.hasProfile), '移除后不应再有 profile');
  });

  await c2.check('「＋ 添加会话」：候选来自 OneBot，选中后添加成功并选中', async () => {
    doc.querySelector('#chat-session-add-btn').click();
    await waitFor(() => doc.querySelector('#add-session-candidates .session-add-row'), 5000, '候选列表渲染');
    const row = [...doc.querySelectorAll('#add-session-candidates .session-add-row')]
      .find((el) => (el.textContent || '').includes('覆盖群456'));
    assert.ok(row, '候选里应有覆盖群456');
    row.click();
    assert.equal(doc.querySelector('#add-session-kind').value, 'group');
    assert.equal(doc.querySelector('#add-session-id').value, '456');
    doc.querySelector('#add-session-save').click();
    // 添加同样有二次确认弹窗
    await clickConfirm();
    await waitFor(() => doc.querySelector('#session-panel-head'), 5000, '会话面板出现');
    assert.ok(doc.querySelector('#session-panel-head').textContent.includes('覆盖群456'), '新会话应被选中');
  });

  await c2.check('会话行恢复显示（已准入），群名补底缓存生效', async () => {
    await waitFor(() => [...doc.querySelectorAll('.session-menu .chat-row')]
      .some((el) => el.dataset.chatKey === 'group:456' && el.classList.contains('admitted')), 5000, '会话行回到已准入');
    // 拉取把 /api/onebot/groups 的名字写进了缓存（state.qqGroupNames）
    assert.equal(window.groupDisplayName('456'), '覆盖群456');
    assert.equal(window.groupDisplayName('789'), '备用群789');
    assert.equal(window.groupDisplayName('999999'), '群 999999');   // 真没有名字才退回群号
  });

  await c2.check('会话改动只写会话：档位覆盖后 /api/config?chat= 变化，默认不变', async () => {
    // 在当前会话面板（人设分区）切到聊天设置，拖档位 → 自动保存到 profile
    doc.querySelector('[data-session-section="chat"]').click();
    await waitFor(() => doc.querySelector('#ac-editor'), 5000, '活跃设置编辑器渲染');
    // 直接 PUT 覆盖（滑条拖动等价的接口动作），断言口径分流
    await window.api('/api/chat-profiles/group:456/overrides', {
      method: 'PUT',
      body: JSON.stringify({ overrides: { store: { contextSliderPos: 100 } } })
    });
    const eff = await window.api('/api/config?chat=group%3A456');
    assert.equal(eff.store.contextSliderPos, 100, '会话生效档位应为 100');
    const g = await window.api('/api/config');
    assert.notEqual(g.store.contextSliderPos, 100, '默认档位不应被会话覆盖污染');
  });

  await c2.check('黑名单会话在左栏标 🚫（黑名单优先级最高，添加了会话也照拒）', async () => {
    const cfg = await window.api('/api/config');
    const oldDeny = cfg.deny || { groups: [], private: [] };
    try {
      await window.api('/api/config', {
        method: 'POST',
        body: JSON.stringify({ deny: { groups: [], private: ['777'] } })
      });
      await window.loadChatProfiles({ quiet: true });
      window.renderSettingsSidebar();
      const row = [...doc.querySelectorAll('.session-menu .chat-row')]
        .find((el) => el.dataset.chatKey === 'private:777');
      assert.ok(row, '应有 private:777 行');
      assert.ok(row.classList.contains('denied'), '黑名单会话行应带 denied 标记');
      assert.ok((row.textContent || '').includes('黑名单'), `行内应写明黑名单：${row.textContent.trim()}`);
      // 准入判定同口径：即使它在 chatProfiles 里，也拒绝
      const a = await window.api('/api/chat-profiles');
      assert.ok((a.sessions || []).some((x) => x.key === 'private:777' && x.hasProfile), '该会话仍应在自定义列表里');
      assert.equal((a.sessions || []).find((x) => x.key === 'private:777').admitted, false,
        '黑名单会话即使已添加也不准入');
    } finally {
      await window.api('/api/config', { method: 'POST', body: JSON.stringify({ deny: oldDeny }) });
      await window.loadChatProfiles({ quiet: true });
      window.renderSettingsSidebar();
    }
  });

  await c2.check('OneBot 掉线：添加会话候选拉取失败提示可读', async () => {
    const old = app.onebot.httpUrl;
    app.onebot.httpUrl = 'http://127.0.0.1:9';
    try {
      // 上一个弹窗还在 400ms 退场动画里 → 等它真的摘掉再开新的，避免读到旧候选区
      await waitFor(() => !doc.querySelector('#add-session-candidates'), 3000, '旧弹窗退场');
      doc.querySelector('#chat-session-add-btn').click();
      const lastCandidates = () => {
        const all = [...doc.querySelectorAll('#add-session-candidates')];
        return all[all.length - 1] || null;
      };
      await waitFor(() => {
        const box = lastCandidates();
        return box && !box.textContent.includes('加载中');
      }, 8000, '候选区结束加载');
      const text = lastCandidates().textContent;
      assert.ok(text.includes('失败') || text.includes('手动输入'), `应有可读失败文案：${text}`);
    } finally {
      app.onebot.httpUrl = old;
    }
  });

  dom.window.close();
}

await teardown();
console.log('');
process.exit(c.finish() && c2.finish() ? 0 : 1);


