// 会话管理 → 设置 → 工具与技能：技能 / 插件分区的「启用状态」筛选。
//
// 需求（2026-10-22）：两个分区各新增两个筛选条件（已启用 / 已关闭），
// 与原有搜索框叠加。这里用 jsdom 加载真实 ui/index.html + 全部前端段，
// 走真实操作路径（会话管理 → 默认会话 → 设置 → 工具与技能）验证：
//   1. 两个分区各有「全部 / 已启用 / 已关闭」三个条件，计数与行数一致；
//   2. 点「已启用」只剩已启用的行，点「已关闭」只剩已关闭的行，点「全部」复原；
//   3. 条件与搜索叠加（搜索命中的行只要状态不符也不显示）；
//   4. 整页重绘（renderSettings）后条件不被打回「全部」。
//
// 运行：node test/scope-filter-ui-test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, bootApp, sleep } from './_harness.mjs';

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  console.log('\n⚠ 未安装 jsdom，跳过本套件。启用方式：npm i -D jsdom\n');
  process.exit(0);
}

let pass = 0;
let fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m, d) => { fail++; console.log('  ✗ ' + m); if (d) console.log('      ' + d); };
const check = (cond, m, d) => (cond ? ok(m) : bad(m, d));
async function step(name, fn) {
  try {
    const extra = await fn();
    ok(`${name}${extra ? ` —— ${extra}` : ''}`);
  } catch (error) {
    bad(name, error?.message || error);
  }
}

const ctx = await bootApp({});
const { base } = ctx;

let code = (await import('./_ui-load.mjs')).loadUiAppCode().code;
code = code.replace(/^'use strict';\s*$/m, '');
code = code.replace(/^export\s+(function|const|let|async function|class)/gm, '$1');

const html = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: base + '/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
window.fetch = (input, init) => fetch(new URL(String(input), base).href, init);
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
const cards = {};
const rowsOf = (card) => [...card.querySelectorAll('.skill-scope-row')];
const visibleRows = (card) => rowsOf(card).filter((row) => row.style.display !== 'none');
const countOf = (card, mode) => Number(card.querySelector(`.scope-filter-btn[data-scope-filter="${mode}"] .scope-filter-count`)?.textContent);

console.log('\n=== 打开：会话管理 → 默认会话 → 设置 → 工具与技能 ===');
await step('会话设置面板可见', async () => {
  window.switchTab('chatmanage');
  await sleep(600);
  doc.querySelector('#chat-default-item')?.click();
  await sleep(900);
  await window.switchCmSub?.('settings');
  await sleep(1200);
  doc.querySelector('[data-session-section="tools"]')?.click();
  await sleep(700);
  if (!doc.querySelector('#card-scope-skills')) throw new Error('工具与技能分区里没有渲染技能卡（#card-scope-skills）');
});

for (const [key, kindLabel] of [['skills', '技能'], ['plugins', '插件']]) {
  console.log(`\n=== ${kindLabel}分区：启用状态筛选 ===`);
  await step(`${kindLabel}卡有三个筛选条件（全部 / 已启用 / 已关闭）`, async () => {
    const card = doc.querySelector(`#card-scope-${key}`);
    if (!card) throw new Error(`找不到 #card-scope-${key}`);
    cards[key] = card;
    const modes = [...card.querySelectorAll('.scope-filter-btn')].map((b) => b.dataset.scopeFilter);
    if (modes.join(',') !== 'all,on,off') throw new Error(`条件按钮为 ${modes.join(',') || '（空）'}，应为 all,on,off`);
    if (card.querySelector('.scope-filter-btn[data-active="true"]')?.dataset.scopeFilter !== 'all') {
      throw new Error('初次进入应默认选中「全部」');
    }
    const rows = rowsOf(card);
    if (!rows.length) throw new Error('分区里没有任何行，无法验证筛选（技能/插件目录为空？）');
    const off = rows.filter((r) => r.dataset.enabled === '0').length;
    if (countOf(card, 'all') !== rows.length) throw new Error(`「全部」计数 ${countOf(card, 'all')} ≠ 行数 ${rows.length}`);
    if (countOf(card, 'on') !== rows.length - off) throw new Error(`「已启用」计数 ${countOf(card, 'on')} ≠ ${rows.length - off}`);
    if (countOf(card, 'off') !== off) throw new Error(`「已关闭」计数 ${countOf(card, 'off')} ≠ ${off}`);
    return `${rows.length} 条（启用 ${rows.length - off} / 关闭 ${off}）`;
  });

  await step(`${kindLabel}：点「已启用」只剩已启用的行`, async () => {
    const card = cards[key];
    if (!card) throw new Error('前一步未拿到卡片');
    const rows = rowsOf(card);
    card.querySelector('.scope-filter-btn[data-scope-filter="on"]').click();
    await sleep(80);
    const shown = visibleRows(card);
    const want = rows.filter((r) => r.dataset.enabled === '1');
    if (shown.length !== want.length) throw new Error(`显示 ${shown.length} 行，应为 ${want.length} 行`);
    if (shown.some((r) => r.dataset.enabled !== '1')) throw new Error('仍显示着已关闭的行');
    if (card.querySelector('.scope-filter-btn[data-active="true"]')?.dataset.scopeFilter !== 'on') {
      throw new Error('选中的条件没有切到「已启用」');
    }
    return `显示 ${shown.length} / ${rows.length}`;
  });

  await step(`${kindLabel}：点「已关闭」只剩已关闭的行`, async () => {
    const card = cards[key];
    if (!card) throw new Error('前一步未拿到卡片');
    const rows = rowsOf(card);
    card.querySelector('.scope-filter-btn[data-scope-filter="off"]').click();
    await sleep(80);
    const shown = visibleRows(card);
    const want = rows.filter((r) => r.dataset.enabled === '0');
    if (shown.length !== want.length) throw new Error(`显示 ${shown.length} 行，应为 ${want.length} 行`);
    if (shown.some((r) => r.dataset.enabled !== '0')) throw new Error('仍显示着已启用的行');
    return `显示 ${shown.length} / ${rows.length}`;
  });

  await step(`${kindLabel}：「已启用」按行状态命中（不是只隐藏已关闭的）`, async () => {
    const card = cards[key];
    if (!card) throw new Error('前一步未拿到卡片');
    const rows = rowsOf(card);
    const borrow = rows.find((r) => r.dataset.enabled === '0');
    if (!borrow) return '没有已关闭的行可借（全部都是已启用，跳过）';
    // 借一行临时标记为已启用：只改 DOM，不动真实配置 —— 验证「已启用」确实
    // 按行状态筛，而不是"只把已关闭的藏起来"（后者在全启用时看不出区别）。
    borrow.dataset.enabled = '1';
    card.querySelector('.scope-filter-btn[data-scope-filter="on"]').click();
    await sleep(80);
    const shown = visibleRows(card);
    const want = rowsOf(card).filter((r) => r.dataset.enabled === '1');
    const hit = shown.includes(borrow) && shown.length === want.length
      && shown.every((r) => r.dataset.enabled === '1');
    borrow.dataset.enabled = '0';
    if (!hit) throw new Error(`「已启用」显示了 ${shown.length} 行，应为 ${want.length} 行（且含借用的那一行）`);
    return `命中 ${want.length} 行`;
  });

  await step(`${kindLabel}：条件与搜索叠加（状态不符的搜索命中也不显示）`, async () => {
    const card = cards[key];
    if (!card) throw new Error('前一步未拿到卡片');
    const rows = rowsOf(card);
    const onRow = rows.find((r) => r.dataset.enabled === '1');
    card.querySelector('.scope-filter-btn[data-scope-filter="off"]').click();
    await sleep(60);
    // 在「已关闭」条件下：搜一个已启用行的 id，应一行都不显示
    if (onRow) {
      const needle = String(onRow.dataset.search || '').split(' ')[0];
      const input = card.querySelector('.scope-search');
      input.value = needle;
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      await sleep(60);
      if (visibleRows(card).length !== 0) throw new Error(`「已关闭」+ 搜索「${needle}」仍有行显示`);
      const empty = card.querySelector('.scope-empty');
      if (!empty || empty.style.display === 'none') throw new Error('无结果时没有显示空状态提示');
      input.value = '';
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      await sleep(60);
    }
    // 回到「全部」，搜索仍要生效
    card.querySelector('.scope-filter-btn[data-scope-filter="all"]').click();
    await sleep(60);
    if (visibleRows(card).length !== rows.length) throw new Error('点「全部」后没有复原');
    return '叠加生效';
  });

  await step(`${kindLabel}：整页重绘后筛选条件保留`, async () => {
    const card = cards[key];
    if (!card) throw new Error('前一步未拿到卡片');
    card.querySelector('.scope-filter-btn[data-scope-filter="on"]').click();
    await sleep(60);
    window.renderSettings();
    await sleep(400);
    const next = doc.querySelector(`#card-scope-${key}`);
    if (!next) throw new Error('重绘后找不到卡片');
    cards[key] = next;
    if (next.querySelector('.scope-filter-btn[data-active="true"]')?.dataset.scopeFilter !== 'on') {
      throw new Error('重绘后条件被打回「全部」（应记住用户选的「已启用」）');
    }
    const rows = rowsOf(next);
    const shown = visibleRows(next);
    if (shown.some((r) => r.dataset.enabled !== '1')) throw new Error('重绘后仍显示已关闭的行');
    if (shown.length !== rows.filter((r) => r.dataset.enabled === '1').length) throw new Error('重绘后显示行数不对');
    // 复原，避免影响后续断言/人工观察
    next.querySelector('.scope-filter-btn[data-scope-filter="all"]').click();
    await sleep(60);
    return `重绘后仍只显示 ${shown.length} 条已启用`;
  });
}

console.log(`\n${fail === 0 ? '全部通过' : '存在失败'} —— 通过 ${pass} / 失败 ${fail}`);
await ctx.teardown();
process.exit(fail ? 1 : 0);
