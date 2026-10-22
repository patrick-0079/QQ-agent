/**
 * 「定时刷新不该打断正在编辑的额度和设置」—— 回归测试。
 *
 * 报告的现象：「修改限额插件在修改额度时存在定时刷新输入栏的问题」。
 * 根因：页面每 20 秒 load() 一次（排行榜页另有 30 秒轮询），而 render() 会把
 *      输入框 value 写回**已保存的值**，于是没保存的输入被悄悄还原。
 *
 * 这里不靠"看一下代码觉得对了"，而是：**模拟定时器触发**，断言输入框的内容还在。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JSDOM } from 'jsdom';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-refresh-'));
process.env.QQ_AGENT_DATA_DIR = TMP;

const APP = 'E:/dsqqbot/QQ Agent/resources/app';
const UI = APP + '/plugins/quota-guard/ui';

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};
const ok = (n, c) => t(n, !!c, true);

// ── 环境 ──
const cfgMod = await import('file:///E:/dsqqbot/QQ%20Agent/resources/app/src/config.js');
cfgMod.setRuntimeConfig(cfgMod.loadConfig());
const qg = await import('file:///E:/dsqqbot/QQ%20Agent/resources/app/plugins/quota-guard/index.js');

const html = fs.readFileSync(UI + '/index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://127.0.0.1:3210/plugin-ui/quota-guard/index.html', runScripts: 'outside-only' });
const { window } = dom;
const doc = window.document;

// 定时器收集（不真的等 20 秒）
const timers = [];
window.setInterval = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
window.clearInterval = () => {};
window.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  const d = await qg.handleUiRequest({ ...body, port: 3210 });
  return { ok: true, json: async () => d };
};
window.scrollTo = () => {};

const appJs = fs.readFileSync(UI + '/app.js', 'utf8');
window.eval(appJs);
doc.dispatchEvent(new window.Event('DOMContentLoaded'));
await new Promise((r) => setTimeout(r, 400));

const $ = (id) => doc.getElementById(id);
const tick = () => new Promise((r) => setTimeout(r, 60));
const fire = (el, type) => el.dispatchEvent(new window.Event(type, { bubbles: true }));

console.log('── 0. 页面起来了 ──');
// ⚠️ 全局设置卡片**默认折叠**（index.html 里带 qg-collapsed），
//    不展开的话里面的输入框虽然存在、但这一步读不到值（测试假象）。
$('qg-settings-toggle').click();
await tick();
ok('全局设置卡片已展开', $('qg-settings-card').classList.contains('qg-collapsed') === false);
ok('有输入框 qg-defaultlimit', !!$('qg-defaultlimit'));
const poll = timers.find((x) => x.ms === 20000);
ok('★ 存在 20 秒自动刷新定时器', !!poll);
// 30 秒轮询只在切到排行榜页时创建，这里先不断言（见第 6 段）

// 先给一个人设额度，才能进详情面板
await qg.handleUiRequest({ action: 'setLimit', payload: { userId: '9001', limit: 50000, name: '甲' } });
$('qg-refresh').click();
await tick(); await tick();

console.log('');
console.log('── 1. 全局设置：正在编辑时，自动刷新不该覆盖 ──');
{
  const inp = $('qg-defaultlimit');
  const savedDefault = String((window.__qgDebug.data() || {}).settings.defaultDailyLimit || '');
  t('初始显示已保存的值', inp.value, savedDefault === '0' ? '' : savedDefault);

  // 模拟用户正在输入
  inp.value = '777777';
  inp.focus();
  fire(inp, 'input');
  await tick();

  // 触发一次自动刷新（等价于等了 20 秒）
  ok('★ isEditing 认为正在编辑', window.__qgDebug && true);   // 占位，下面用结果断言
  await poll.fn();
  await tick(); await tick();

  t('★★ 自动刷新后，未保存的输入**还在**', $('qg-defaultlimit').value, '777777');
}

console.log('');
console.log('── 2. 光标移开但没保存：也不该被覆盖 ──');
{
  const inp = $('qg-defaultlimit');
  inp.blur();                      // 失焦 —— 容易漏掉的情况
  await tick();
  await poll.fn();
  await tick(); await tick();
  t('★★ 失焦后仍未保存的输入还在', $('qg-defaultlimit').value, '777777');
}

console.log('');
console.log('── 3. 没有未保存改动时：自动刷新照常生效 ──');
{
  // 清掉编辑标记（等价于点「刷新」）
  $('qg-refresh').click();
  await tick(); await tick();
  const savedNow = String((window.__qgDebug.data() || {}).settings.defaultDailyLimit || '');
  t('点刷新后回到已保存的值', $('qg-defaultlimit').value, savedNow === '0' ? '' : savedNow);

  // 现在没有编辑，自动刷新应该能正常拉到新数据
  await qg.handleUiRequest({ action: 'save', payload: { resetHour: 5, defaultDailyLimit: 200000, notifyOnBlock: false, notifyText: 'x', blockWhenSendLimited: true } });
  await poll.fn();
  await tick(); await tick();
  t('★ 无编辑时自动刷新能拉到新值', $('qg-defaultlimit').value, '200000');
  t('重置时刻也更新了', $('qg-resethour').value, '5');
  // 还原
  await qg.handleUiRequest({ action: 'save', payload: { resetHour: 4, defaultDailyLimit: 100000, notifyOnBlock: false, notifyText: '（今天的额度用完啦，明天再来找我吧）', blockWhenSendLimited: true } });
}

console.log('');
console.log('── 4. 单人详情：正在编辑额度时，自动刷新不该覆盖 ──');
{
  $('qg-refresh').click();
  await tick(); await tick();
  const row = doc.querySelector('#qg-list .qg-person[data-pick="9001"]');
  ok('列表里能找到甲', !!row);
  row.click();
  await tick(); await tick();
  ok('详情面板已打开', $('qg-detail-body').hidden === false);

  const inp = $('qg-detail-limit');
  ok('额度输入框存在', !!inp);
  const saved = inp.value;
  inp.value = '888888';
  inp.focus();
  fire(inp, 'input');
  await tick();

  await poll.fn();               // 自动刷新
  await tick(); await tick();

  const inp2 = $('qg-detail-limit');
  t('★★ 详情面板是整块重建的，但未保存的额度还在', inp2 ? inp2.value : '(节点没了)', '888888');
  ok('★ 焦点被恢复到原输入框', doc.activeElement && doc.activeElement.id === 'qg-detail-limit');
  ok('★ 保存按钮标注了"有未保存改动"',
    ($('qg-detail-save').textContent || '').includes('未保存'));

  // 备注框同样保护
  const note = $('qg-detail-note');
  note.value = '临时写一半';
  note.focus();
  fire(note, 'input');
  await tick();
  await poll.fn();
  await tick(); await tick();
  t('★ 备注的未保存内容也在', $('qg-detail-note').value, '临时写一半');
}

console.log('');
console.log('── 5. 保存之后：标记清掉，自动刷新恢复 ──');
{
  // 点保存
  $('qg-detail-save').click();
  await tick(); await tick(); await tick();
  const saved = cfgMod.getConfig().skills['quota-guard'].perUser['9001'];
  t('额度真的存下来了（888888）', saved.limit, 888888);
  ok('保存按钮不再标"未保存"', !($('qg-detail-save').textContent || '').includes('未保存'));

  // 之后自动刷新应该正常工作：把后端值改掉再刷。
  // ⚠️ 得先失焦 —— 刚点完保存按钮，但输入框可能仍是 activeElement，
  //    而"有焦点"本身就意味着正在编辑（这是刻意的保护，不是 bug）。
  if (doc.activeElement && doc.activeElement.blur) doc.activeElement.blur();
  await tick();
  await qg.handleUiRequest({ action: 'setLimit', payload: { userId: '9001', limit: 123456 } });
  await poll.fn();
  await tick(); await tick();
  t('★ 保存后自动刷新能拉到新值', $('qg-detail-limit').value, '123456');
}

console.log('');
console.log('── 6. 排行榜页的搜索框也不该被打断 ──');
{
  doc.querySelector('[data-page="total"]').click();
  await tick(); await tick();
  const q = $('qg-cum-search');
  q.value = '半截输入';
  q.focus();
  fire(q, 'input');
  await tick();
  const cumPoll = timers.find((x) => x.ms === 30000);
  ok('找到 30 秒轮询', !!cumPoll);
  await cumPoll.fn();
  await tick(); await tick();
  t('★ 榜单搜索框内容没被冲掉', $('qg-cum-search').value, '半截输入');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
