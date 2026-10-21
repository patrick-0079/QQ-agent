// 覆盖测试 E：界面接线（真实 DOM）
//
// 用 jsdom 加载真实的 ui/index.html 并执行 ui/app.js，然后按**用户的真实操作路径**遍历：
//   - 8 个页签（点 .tab[data-tab]）：会话/存档/记忆/用量/技能/插件/SnowLuma/设置
//     （技能与插件是**两个独立页签**：同构的渲染逻辑、不同的类型过滤，都要走一遍）
//   - 8 个设置分区（点 .settings-menu-item[data-section]）
//   - 若干主要弹窗（点开后再扫）
// 对扫到的每一个交互元素（button/input/select/textarea/a），检查"它自己或任一祖先"
// 是否挂了该类型的事件监听 —— 即：这个控件点下去/改一下，到底有没有代码在管。
//
// 依赖 jsdom（可选）：未安装时打印说明并跳过。
//   npm i -D jsdom      # 启用本测试
//
// 运行：node test/coverage-wiring.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, bootApp, createChecker } from './_harness.mjs';

const c = createChecker('界面接线（真实 DOM）');

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  console.log('\n⚠ 未安装 jsdom，跳过本套件。启用方式：npm i -D jsdom\n');
  c.ok('jsdom 未安装 —— 已跳过（安装后自动启用）');
  c.finish();
  process.exit(0);
}

const ctx = await bootApp({});
const { base } = ctx;

const html = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
// M9 拆分：app.js 变成 ESM 桥 + 12 个普通脚本段。桥只做 import + window 赋值，
// 这里改为直接拼接 12 段后 window.eval（vendor 值已在下方注入 window，
// 与浏览器里桥文件的 window.* 赋值等价）。
let code = (await import('./_ui-load.mjs')).loadUiAppCode().code;
code = code.replace(/^'use strict';\s*$/m, '');
// eval 环境跑不了 export 前缀（07 段的 renderSkillSettingsModal 有一个）——
// 剥掉后再执行（拆分前 app.js 同款处理）。
code = code.replace(/^export\s+(function|const|let|async function|class)/gm, '$1');

const dom = new JSDOM(html, { url: base + '/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;

// 监听器追踪（必须在执行 app.js 之前安装）
const listeners = new Map();
const origAdd = window.EventTarget.prototype.addEventListener;
window.EventTarget.prototype.addEventListener = function (type, ...rest) {
  if (!listeners.has(this)) listeners.set(this, new Set());
  listeners.get(this).add(String(type));
  return origAdd.call(this, type, ...rest);
};

window.fetch = (input, init) => fetch(new URL(String(input), base).href, init);
window.EventSource = class { constructor() {} addEventListener() {} close() {} };
window.alert = () => {};
window.confirm = () => true;
// jsdom 的 window 上没有 structuredClone（真实浏览器有）。补个等价垫片，
// 否则依赖它的弹窗会以"structuredClone is not defined"失败 —— 那是测试环境问题。
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(1500);

// ── 判定：元素自身或任一祖先有该类型监听 ──────────────────────────────────
function wantedTypes(tag, type) {
  if (tag === 'a') return ['click'];
  if (tag === 'select') return ['change', 'input', 'click'];
  if (type === 'checkbox' || type === 'radio' || type === 'file') return ['change', 'click', 'input'];
  if (tag === 'input' || tag === 'textarea') return ['input', 'change', 'keydown', 'keyup', 'focus', 'blur', 'click'];
  return ['click', 'submit', 'mousedown', 'keydown'];
}
function wired(el) {
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  const want = wantedTypes(tag, type);
  let n = el;
  while (n && n.nodeType === 1) {
    const set = listeners.get(n);
    if (set) for (const t of want) if (set.has(t)) return true;
    n = n.parentElement;
  }
  return false;
}

/**
 * "批量读取式"控件：自身不挂监听，值在**提交按钮**被点时才被整体读走。
 * 典型例子是白名单选择器：`确定` 按钮里执行
 *   $$('input[type=checkbox]:checked', overlay).map(el => el.value)
 * 所以这些复选框没有自己的监听器是正常的，不算缺陷 —— 这里单独标记出来，
 * 与"真的没人管"区分开（后者才是 bug）。
 */
function batchRead(el) {
  const type = (el.getAttribute('type') || '').toLowerCase();
  if (type !== 'checkbox' && type !== 'radio') return false;
  const box = el.closest('.model-modal, .modal');
  if (!box) return false;
  return [...box.querySelectorAll('button')].some((b) => wired(b));
}

const rows = [];
const seen = new WeakSet();
function scan(label) {
  let added = 0;
  for (const el of window.document.querySelectorAll('button, input, select, textarea, a[href]')) {
    if (seen.has(el)) continue;
    seen.add(el);
    added++;
    let hidden = false;
    try {
      const cs = window.getComputedStyle(el);
      hidden = cs.display === 'none' || cs.visibility === 'hidden';
      // 屏幕外锚点（left/top: -9999px）：视觉上永远不可见，是给 SDK 挂的隐藏元素
      // （如阿里云验证码的 #captcha-trigger），不属于"看得见但点了没反应"的缺陷。
      if (!hidden && /-999\d+px/.test(String(cs.left || '') + String(cs.top || ''))) hidden = true;
    } catch { /* ignore */ }
    const isWired = wired(el);
    const isBatch = !isWired && batchRead(el);
    rows.push({
      label,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      id: el.id || '',
      cls: String(el.className || '').slice(0, 36),
      text: (el.textContent || '').trim().slice(0, 16),
      hidden,
      batch: isBatch,
      ok: isWired || isBatch
    });
  }
  return added;
}

// 等待首屏渲染完成（有内容再继续）
for (let i = 0; i < 40; i++) {
  if (window.document.querySelectorAll('button, input, select, textarea, a[href]').length >= 10) break;
  await sleep(200);
}
const cov = {};
cov['首屏'] = scan('首屏');

// ── 1) 逐个页签（点真实按钮）────────────────────────────────────────────
// 注意：各 view 都是 index.html 里的静态节点，切页签不会新建元素
//（它们在首屏那轮就已全部扫到）。所以这里统计"访问过的页签数"，而不是新增元素数。
// ⚠️ 这份列表必须与 index.html 里的 .tab 保持一致 —— 漏掉一个页签，
// 那一页的按钮就永远不会被接线检查覆盖（skills/plugins 曾经就是这样被漏掉的）。
const visitedTabs = [];
for (const t of ['chatmanage', 'usage', 'skills', 'plugins', 'snowluma', 'settings']) {
  const tabBtn = window.document.querySelector(`.tab[data-tab="${t}"]`);
  if (tabBtn) tabBtn.click(); else { try { window.switchTab(t); } catch { /* ignore */ } }
  await sleep(800);
  visitedTabs.push(t);
  cov[`页签/${t}`] = scan(`页签/${t}`);
}

// 上面那份清单必须覆盖 index.html 声明的**全部**页签。
// 漏一个的后果很隐蔽：那一页永远不会被接线检查扫到 —— 页面上"看得见但点了没反应"
// 的控件就此长期潜伏（skills 页此前就是这样被漏掉的）。
await c.check('页签遍历覆盖了 index.html 声明的全部页签', () => {
  const declared = [...html.matchAll(/data-tab="([\w-]+)"/g)].map((m) => m[1]);
  const missed = declared.filter((t) => !visitedTabs.includes(t));
  if (missed.length) {
    throw new Error(`这些页签没被遍历到（请同步本文件的页签清单）：${missed.join(', ')}`);
  }
  const extra = visitedTabs.filter((t) => !declared.includes(t));
  if (extra.length) {
    throw new Error(`遍历清单里有 index.html 未声明的页签：${extra.join(', ')}`);
  }
  return `${declared.length} 个页签全部覆盖`;
});

// ── 2) 会话管理子页（运行记录/存档/记忆/用量/设置）+ 设置页全局分区 ────────
// 会话级配置在「会话管理 → 设置」；设置页只剩全局分区（[data-gsec]）。
window.switchTab('chatmanage');
await sleep(700);
for (const sub of ['sessions', 'chats', 'memory', 'usage', 'settings']) {
  window.switchCmSub(sub);
  await sleep(700);
  cov[`会话管理/${sub}`] = scan(`会话管理/${sub}`);
}

// 左栏控件：添加会话 / 群发（都在搜索框上方）+ 宽度拖拽把手
await c.check('会话管理左栏：添加/群发/宽度拖拽已就位并接线', () => {
  const rail = window.document.querySelector('#cm-rail');
  assert.ok(rail, '缺少左栏 #cm-rail');
  for (const id of ['chat-session-add-btn', 'session-broadcast-btn', 'chat-session-search', 'cm-rail-resizer']) {
    assert.ok(rail.querySelector(`#${id}`), `左栏缺少 #${id}`);
  }
  const order = [...rail.querySelectorAll('#chat-session-add-btn, #session-broadcast-btn, #chat-session-search')]
    .map((el) => el.id);
  assert.deepEqual(order, ['chat-session-add-btn', 'session-broadcast-btn', 'chat-session-search'],
    `添加/群发应排在搜索框上方，实际顺序：${order.join(' → ')}`);
  assert.ok(wired(rail.querySelector('#chat-session-add-btn')), '添加会话没接线');
  assert.ok(wired(rail.querySelector('#session-broadcast-btn')), '群发没接线');
  const rz = listeners.get(rail.querySelector('#cm-rail-resizer'));
  assert.ok(rz && rz.has('pointerdown'), '宽度拖拽把手没接线（pointerdown）');
  assert.ok(rail.style.getPropertyValue('--cm-rail-w'), '左栏宽度变量未应用');
});

// 会话设置的折叠卡：autoFoldSettings 必须绑定到 #cm-settings（而不是设置页表单）
await c.check('会话设置里的折叠卡可以正常开合', async () => {
  window.switchCmSub('settings');
  await sleep(700);
  const toolsTab = window.document.querySelector('[data-session-section="tools"]');
  if (toolsTab) { toolsTab.click(); await sleep(500); }
  const card = window.document.querySelector('#cm-settings .setcard.fold');
  assert.ok(card, '会话设置里没有折叠卡');
  const head = card.querySelector('.fold-head');
  assert.ok(head, '折叠卡缺少 .fold-head');
  const before = card.classList.contains('open');
  head.click();
  await sleep(60);
  assert.notEqual(card.classList.contains('open'), before, '点击折叠卡头没有开合');
});

// 口令安装：回车只追加输入框，不联网
await c.check('口令安装：回车追加下一个输入框（不触发网络）', async () => {
  const ov = window.openInstallCodeModal();
  const inputs = () => [...ov.querySelectorAll('#ic-rows .ic-input')];
  assert.equal(inputs().length, 1, `初始应只有 1 个输入框，实际 ${inputs().length}`);
  const first = inputs()[0];
  first.value = 'ABCD12';
  first.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(120);
  assert.equal(inputs().length, 2, `回车后应有 2 个输入框，实际 ${inputs().length}`);
  assert.equal(inputs()[0].value, 'ABCD12', '已输入的口令不能被清掉');
  window.closeModelModal(ov);
});

// 口令安装：格式不对时标红并保留弹窗（不联网）
await c.check('口令安装：失败项红色提示且弹窗不关闭', async () => {
  const ov = window.openInstallCodeModal();
  const first = ov.querySelector('#ic-rows .ic-input') || ov.querySelector('.ic-input');
  if (!first) throw new Error(`输入框未渲染：${ov.innerHTML.slice(0, 200)}`);
  first.value = 'AB';
  first.dispatchEvent(new window.Event('input', { bubbles: true }));
  ov.querySelector('#ic-confirm').click();
  await sleep(150);
  const bad = ov.querySelector('.ic-row.bad');
  if (!bad) throw new Error('格式错误的口令没有标红');
  if (!/口令格式无效/.test(bad.textContent)) throw new Error(`红色原因不明确：${bad.textContent}`);
  if (!ov.isConnected) throw new Error('有失败项时弹窗不应关闭');
  window.closeModelModal(ov);
});

// 会话里启用插件后：仓库卡片必须仍是“全局关闭”，不能变绿
await c.check('会话启用插件不污染仓库（卡片仍为全局关闭）', async () => {
  const doc = window.document;
  await window.api('/api/chat-profiles', {
    method: 'POST',
    body: JSON.stringify({ kind: 'group', id: '990001', alias: '仓库回归测试群' })
  });
  window.switchTab('chatmanage');
  await sleep(500);
  await window.loadChatProfiles({ quiet: true });
  window.renderSettingsSidebar();
  window.selectCmScope('group:990001');
  await sleep(900);
  window.switchCmSub('settings');
  await sleep(1200);
  doc.querySelector('[data-session-section="tools"]')?.click();
  await sleep(600);
  const row = [...doc.querySelectorAll('.skill-scope-row')]
    .find((el) => String(el.dataset.search || '').includes('sticker-memory'));
  if (!row) throw new Error('会话设置里找不到 sticker-memory 行');
  const cb = row.querySelector('input.skill-scope-toggle');
  cb.click();
  await sleep(1200);
  if (doc.body.textContent.includes('切换失败')) throw new Error('切换插件时报错了');
  const cfg = await window.api('/api/config');
  if (cfg.skills?.['sticker-memory']?.enabled === true) throw new Error('会话开关污染了全局配置');
  window.switchTab('plugins');
  await sleep(1500);
  const card = doc.querySelector('#plugins-page .mcard[data-skill-id="sticker-memory"]');
  if (!card) throw new Error('插件仓库里找不到 sticker-memory 卡片');
  if (card.classList.contains('mcard-on')) throw new Error('仓库卡片因会话启用而变绿（作用域泄漏）');
  window.switchTab('chatmanage');
  await sleep(600);
});
const defItem = window.document.querySelector('#chat-default-item');
if (defItem) {
  defItem.click();
  await sleep(600);
  const stabs = [...window.document.querySelectorAll('[data-session-section]')].map((el) => el.dataset.sessionSection);
  for (const tab of stabs) {
    const btn = window.document.querySelector(`[data-session-section="${tab}"]`);
    if (!btn) continue;
    btn.click();
    await sleep(400);
    cov[`会话管理/settings-${tab}`] = scan(`会话管理/settings-${tab}`);
  }
}
window.switchTab('settings');
await sleep(800);
const gsecs = [...window.document.querySelectorAll('#settings-sidebar [data-gsec]')].map((el) => el.dataset.gsec);
for (const sec of gsecs) {
  const item = window.document.querySelector(`#settings-sidebar [data-gsec="${sec}"]`);
  if (!item) continue;
  item.click();
  await sleep(500);
  cov[`设置/global-${sec}`] = scan(`设置/global-${sec}`);
}

// ── 3) 主要弹窗：直接调用各自的打开函数（比找按钮可靠），逐个扫描 ────────
// 参数与"前置设置分区"按各函数签名/依赖给：有些函数会先读写本分区的元素
//（如 openModelPicker 写 #provider-hint），分区不对就会抛 null。
// section: 'api' = 全局分区；'persona' 等 = 默认设置面板里的会话分区标签。
const MODALS = [
  ['提示弹窗', 'showNoticeModal', ['测试标题', '测试正文'], null],
  ['调用明细', 'openToolBreakdown', [], null],
  ['用量下钻', 'openUsageBreakdown', ['model', 'm0'], null],
  ['人设选择器', 'openPersonaPicker', [], 'persona'],
  ['人设新建', 'openPersonaCreateModal', [], 'persona'],
  ['添加会话', 'openAddSessionModal', [], null],
  ['模型选择器', 'openModelPicker', [], 'api'],
  ['记忆模型选择器', 'openMemoryModelPicker', [], 'memory'],
  ['模型添加', 'openModelAddModal', ['https://example.com/v1', 'k', ['m1', 'm2']], 'api'],
  ['模型配置', 'openModelConfigModal', [], 'api'],
  ['模型管理', 'openModelManageModal', [], 'api'],
  ['批量价格编辑', 'openBatchPriceModal', [], 'api'],
  ['屏蔽名单', 'openBlocklistModal', [], 'chat'],
  ['意见反馈', 'openFeedbackModal', [], null]
];
const modalReport = [];
for (const [name, fn, args, section] of MODALS) {
  for (const ov of [...window.document.querySelectorAll('.model-modal-overlay, .modal-overlay')]) { try { ov.remove(); } catch { /* ignore */ } }
  window.switchTab?.('settings');
  // 等第一次 loadSettings 的异步渲染结束，否则它会晚一步覆盖掉我们刚点的面板 DOM
  await sleep(1400);
  if (section) {
    if (section === 'api' || section === 'search' || section === 'security' || section === 'system') {
      const item = window.document.querySelector(`[data-gsec="${section}"]`);
      if (item) item.click();
    } else {
      window.document.querySelector('#chat-default-item')?.click();
      await sleep(350);
      const tab = window.document.querySelector(`[data-session-section="${section}"]`);
      if (tab) tab.click();
    }
    await sleep(400);
  }
  let err = '';
  try {
    if (typeof window[fn] !== 'function') err = '函数不存在';
    else await window[fn](...args);
  } catch (e) { err = String(e?.message ?? e); }
  await sleep(700);
  const n = scan(`弹窗/${name}`);
  const opened = window.document.querySelectorAll('.model-modal-overlay, .modal-overlay').length > 0;
  cov[`弹窗/${name}`] = n;
  modalReport.push(`${name}: ${err ? '打不开(' + err.slice(0, 34) + ')' : (opened ? '已打开' : '未产生弹窗')} +${n}`);
}
for (const ov of [...window.document.querySelectorAll('.model-modal-overlay, .modal-overlay')]) { try { ov.remove(); } catch { /* ignore */ } }

// ── 汇总 ────────────────────────────────────────────────────────────────
const total = rows.length;
const broken = rows.filter((r) => !r.ok && !r.hidden);
const brokenHidden = rows.filter((r) => !r.ok && r.hidden);

await c.check('遍历全部页签/设置分区/弹窗后，没有"可见但没接线"的交互元素', () => {
  const batch = rows.filter((r) => r.batch);
  console.log(`      覆盖范围：${Object.entries(cov).filter(([, n]) => n > 0).length} 个场景，共 ${total} 个交互元素`);
  console.log(`      可见且未接线：${broken.length}；隐藏且未接线：${brokenHidden.length}；批量读取式（正常）：${batch.length}`);
  for (const b of broken) console.log(`        ✗ [${b.label}] <${b.tag}${b.type ? ' ' + b.type : ''}> id=${b.id || '-'} class="${b.cls}" 文本="${b.text}"`);
  for (const b of brokenHidden.slice(0, 10)) console.log(`        (隐藏) [${b.label}] <${b.tag}> id=${b.id || '-'} class="${b.cls}"`);
  if (broken.length) throw new Error(`${broken.length} 个可见交互元素没有任何事件监听`);
  return `元素 ${total} 个，全部有归属`;
});

await c.check('各主要弹窗能正常打开（不算缺陷：无数据时可能不产生内容）', () => {
  console.log('      弹窗打开情况：');
  for (const r of modalReport) console.log(`        ${r}`);
  const failed = modalReport.filter((r) => r.includes('打不开') || r.includes('函数不存在'));
  if (failed.length) throw new Error(`有 ${failed.length} 个弹窗打开失败：${failed.join('; ')}`);
  return `${modalReport.filter((r) => r.includes('已打开')).length}/${modalReport.length} 个弹窗成功打开`;
});

await c.check('扫描覆盖面足够（走完全部页签与设置分区）', () => {
  // 全局分区（设置/global-*）+ 会话管理子页（会话管理/*）都算设置面覆盖
  const secs = Object.keys(cov).filter((k) => k.startsWith('设置/') || k.startsWith('会话管理/')).length;
  const modals = Object.keys(cov).filter((k) => k.startsWith('弹窗/') && cov[k] > 0).length;
  if (visitedTabs.length < 6) throw new Error(`只访问了 ${visitedTabs.length} 个页签`);
  // 全局 4 项 + 默认设置 + 会话分区（最多 4 个）
  if (secs < 6) throw new Error(`只扫到 ${secs} 个设置分区`);
  return `页签 ${visitedTabs.length} / 设置分区 ${secs} / 弹窗 ${modals}，交互元素 ${total} 个`;
});

// ── 4) 回归：用量页「展开全部 / 收起」────────────────────────────────────
await c.check('用量页「展开全部/收起」按钮真的能开合（曾经完全没有绑定）', async () => {
  const models = Array.from({ length: 25 }, (_, i) => ({
    key: `m${i}`, vendor: '测试渠道', model: `model-${i}`, runs: 1,
    promptTokens: 100, completionTokens: 10, cachedTokens: 0, cacheHitRate: 0, cost: 0.001
  }));
  const stats = {
    mode: 'models',
    totals: { runs: 25, promptTokens: 2500, completionTokens: 250, cachedTokens: 0, cacheHitRate: 0, cost: 0.025 },
    days: [], chats: [], models
  };
  window.switchTab('usage');
  // 等页签自己的异步加载（/api/usage/stats 等）跑完，否则它会在我们手工渲染之后
  // 用真实（空）数据把表格覆盖掉 —— 那会让断言看到 0 行。1.5s 在机器负载高时
  // 可能不够（2026-09-26 两次偶发误报都是它），加一层"被盖掉就补渲染"的兜底。
  await sleep(1500);
  window.renderUsagePage(stats, {}, {});
  await sleep(150);

  let btn = window.document.querySelector('#models-expand');
  if (btn && btn.style.display === 'none') {
    // 异步加载晚于手工渲染落地、表格被盖回空数据 → 补渲染一次再断言
    window.renderUsagePage(stats, {}, {});
    await sleep(150);
    btn = window.document.querySelector('#models-expand');
  }
  if (!btn) throw new Error('找不到 #models-expand');
  const tb = window.document.querySelector('[data-table="models"] tbody');
  if (btn.style.display === 'none') throw new Error('模型 25 行时按钮应可见');

  const a = tb.querySelectorAll('tr[data-key]').length;
  if (a !== 20) throw new Error(`折叠态应 20 行，实际 ${a}`);
  btn.click();
  await sleep(120);
  const b = tb.querySelectorAll('tr[data-key]').length;
  if (b !== 25) throw new Error(`展开后应 25 行，实际 ${b}`);
  if (btn.textContent.trim() !== '收起') throw new Error(`展开后文案应为「收起」，实际「${btn.textContent.trim()}」`);
  btn.click();
  await sleep(120);
  const d = tb.querySelectorAll('tr[data-key]').length;
  if (d !== 20) throw new Error(`再点应收起回 20 行，实际 ${d}`);
  return `折叠 ${a} → 展开 ${b} → 收起 ${d}`;
});

await c.check('切换技能/插件时页面不跳：折叠状态保持、无撤销按钮', async () => {
  const doc = window.document;
  window.switchTab('chatmanage');
  await sleep(500);
  window.selectCmScope('group:990001');
  await sleep(900);
  window.switchCmSub('settings');
  await sleep(1200);
  doc.querySelector('[data-session-section="tools"]')?.click();
  await sleep(500);
  const card = doc.querySelector('#card-scope-skills') || doc.querySelector('#cm-settings .setcard.fold');
  if (!card) throw new Error('找不到技能分区折叠卡');
  const head = card.querySelector('.fold-head');
  if (card.classList.contains('open')) { head.click(); await sleep(200); }
  const before = card.classList.contains('open');
  const cb = doc.querySelector('.skill-scope-toggle');
  if (!cb) throw new Error('找不到技能开关');
  cb.click();
  await sleep(1200);
  if (card.classList.contains('open') !== before) throw new Error('开关后折叠状态被重置（页面会跳）');
  if (doc.querySelector('.settings-undo-btn')) throw new Error('技能开关不应触发「撤销本次设置」按钮');
});

await c.check('活跃设置：任何消息开关会置灰另两个触发条件', async () => {
  const doc = window.document;
  doc.querySelector('[data-session-section="chat"]')?.click();
  await sleep(700);
  const all = doc.querySelector('#ac-trigger-all');
  const mention = doc.querySelector('#ac-trigger-mention');
  const keyword = doc.querySelector('#ac-trigger-keyword');
  if (!all || !mention || !keyword) throw new Error('缺少触发条件三开关');
  all.checked = true;
  all.dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(150);
  if (!mention.disabled || !keyword.disabled) throw new Error('勾选「任何消息」后另两个开关应置灰');
  all.checked = false;
  all.dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(900);
});

await c.check('峰谷模态框支持星期 + 高峰触发条件', async () => {
  const doc = window.document;
  const btn = doc.querySelector('#ac-peak-btn');
  if (!btn) throw new Error('缺少峰谷时段入口');
  btn.click();
  await sleep(300);
  const need = ['cfg-peak-start', 'cfg-peak-end', 'peak-weekday-1', 'peak-weekday-7', 'peak-trigger-mention', 'peak-trigger-all', 'peak-prob-range'];
  for (const id of need) {
    if (!doc.querySelector(`#${id}`)) throw new Error(`峰谷模态框缺少 #${id}`);
  }
  const cancel = doc.querySelector('#ac-peak-cancel');
  if (cancel) cancel.click();
  await sleep(200);
});

await c.check('一键还原默认配置：清空该会话全部覆盖', async () => {
  const doc = window.document;
  const btn = doc.querySelector('#session-reset-all-btn');
  if (!btn) throw new Error('会话头缺少「一键还原默认配置」按钮');
  btn.click();
  await sleep(250);
  // 走真实的确认弹窗（不依赖 window.uiConfirm 覆盖是否生效）
  const ok = doc.querySelector('#ui-confirm-ok') || [...doc.querySelectorAll('button')].filter((b) => b.textContent.trim() === '确定').pop();
  if (ok) { ok.click(); await sleep(900); }
  const prof = await window.api('/api/chat-profiles/group:990001');
  if (Object.keys(prof.overrides || {}).length) throw new Error(`还原后仍有覆盖：${JSON.stringify(prof.overrides)}`);
});

await c.check('仓库卡片点击可复制名称', async () => {
  const doc = window.document;
  window.switchTab('plugins');
  await sleep(1300);
  let copied = '';
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (t) => { copied = String(t); } }
  });
  const card = doc.querySelector('#plugins-page .mcard');
  if (!card) throw new Error('插件页没有卡片');
  card.click();
  await sleep(120);
  const want = card.dataset.copyName || '';
  if (!copied || copied !== want) throw new Error(`复制内容不对：${copied}，期望 ${want}`);
  if (!doc.querySelector('.mini-toast.show')) throw new Error('复制后没有轻提示');
});

await c.check('会话隔离：一个会话启用插件，另一个会话仍关闭（前端）', async () => {
  const doc = window.document;
  await window.api('/api/chat-profiles', {
    method: 'POST',
    body: JSON.stringify({ kind: 'group', id: '990002', alias: '隔离测试群B' })
  });
  try {
    await window.api('/api/skills/sticker-memory', {
      method: 'POST',
      body: JSON.stringify({ enabled: true, chat: 'group:990001' })
    });
    const openTools = async (key) => {
      window.switchTab('chatmanage');
      await sleep(400);
      window.selectCmScope(key);
      await sleep(800);
      window.switchCmSub('settings');
      await sleep(1000);
      doc.querySelector('[data-session-section="tools"]')?.click();
      await sleep(600);
      const row = [...doc.querySelectorAll('.skill-scope-row')]
        .find((el) => String(el.dataset.search || '').includes('sticker-memory'));
      return row?.querySelector('input.skill-scope-toggle')?.checked;
    };
    const a = await openTools('group:990001');
    const b = await openTools('group:990002');
    if (a !== true) throw new Error('990001 应显示已启用');
    if (b !== false) throw new Error('990002 不应被 990001 的开关影响');
  } finally {
    await window.api('/api/chat-profiles/group:990002', { method: 'DELETE' });
  }
});

await c.check('人设：机器人名字修改后能自动保存（回归）', async () => {
  const doc = window.document;
  window.switchTab('chatmanage');
  await sleep(500);
  const def = doc.querySelector('#chat-default-item');
  if (def) { def.click(); await sleep(600); }
  window.switchCmSub('settings');
  await sleep(800);
  doc.querySelector('[data-session-section="persona"]')?.click();
  await sleep(500);
  const input = doc.querySelector('#cfg-botname');
  if (!input) throw new Error('默认设置里找不到机器人名字输入框');
  const before = input.value;
  input.value = '自动化改名';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await sleep(1200);
  const cfg = await window.api('/api/config');
  if (cfg.persona?.botName !== '自动化改名') throw new Error(`机器人名字没保存，实际 ${cfg.persona?.botName}`);
  input.value = before;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await sleep(800);
});

await ctx.teardown();
try { window.close(); } catch { /* ignore */ }
try { dom.window.close(); } catch { /* ignore */ }
process.exit(c.finish() ? 0 : 1);
