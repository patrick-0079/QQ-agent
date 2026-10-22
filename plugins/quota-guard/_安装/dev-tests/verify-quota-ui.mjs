/**
 * quota-guard 控制台界面的真实验证（一次性脚本，不属于项目）。
 *
 * 做法：用 jsdom 加载**真正的** ui/index.html，把页面里的 fetch 换成"直连插件
 * handleUiRequest"的桥，然后像用户一样点按钮、填输入框，最后断言页面显示的东西
 * 与插件返回的数据一致。
 *
 * 这样测的是出货的 HTML + CSS(结构) + JS 三件套，而不是抄一份来测自己。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JSDOM } from 'jsdom';

// ── 临时数据目录：绝不碰用户真实的 data/ ─────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-ui-'));
process.env.QQ_AGENT_DATA_DIR = TMP;

const APP = 'E:\\dsqqbot\\QQ Agent\\resources\\app';
const PLUGIN_DIR = path.join(APP, 'plugins/quota-guard');
const UI = path.join(PLUGIN_DIR, 'ui');

const cfgMod = await import('file:///E:/dsqqbot/QQ%20Agent/resources/app/src/config.js');
const skMod = await import('file:///E:/dsqqbot/QQ%20Agent/resources/app/src/skills/config.js');
const QG_SPEC = 'file:///E:/dsqqbot/QQ%20Agent/resources/app/plugins/quota-guard/index.js';
const qg = await import('file:///E:/dsqqbot/QQ%20Agent/resources/app/plugins/quota-guard/index.js');
cfgMod.setRuntimeConfig(cfgMod.loadConfig());

// 把宿主注入的 fetch 换成假的：插件会用它回调宿主自己的接口
//（/api/onebot/friends、/api/onebot/groups、/api/groups/<id>/members）。
// 这样测试不依赖"这台机器上真的开着 QQ Agent 并且登着号"。
qg.setup({
  fetch: async (url) => {
    const u = String(url);
    if (u.includes('/api/onebot/friends')) {
      return { ok: true, json: async () => ({ friends: [{ id: "3573039609", name: "主人" }, { id: "123456789", name: "路人甲" }] }) };
    }
    if (u.includes('/api/onebot/groups')) {
      return { ok: true, json: async () => ({ groups: [{ id: "1039172534", name: "测试群" }, { id: "999888777", name: "另一个群" }] }) };
    }
    if (/\/api\/groups\/\d+\/members/.test(u)) {
      return {
        ok: true,
        json: async () => ({
          members: [
            { userId: "11111111", nickname: "张三", card: "" },
            { userId: "22222222", nickname: "李四", card: "群里的昵称" },
            { userId: "3573039609", nickname: "主人", card: "主人" }
          ]
        })
      };
    }
    throw new Error("测试里没有备这个地址：" + u);
  },
  config: () => cfgMod.getConfig()?.skills?.["quota-guard"] || {},
  log: () => {}
});

// 页面 fetch 桥打到哪个实例上。需要「重载插件读新文件」的用例改这个变量
// （ES 模块的具名导出是只读的，没法直接替换 qg.handleUiRequest）。
let bridgeTarget = qg;

/**
 * 等累积榜的后台分片扫描收敛，再返回总消耗。
 *
 * ⚠️ 扫描进行中时 board.totals 是**中途**数字，直接读会拿到偏小的值 ——
 *    断言会变得随机（实测踩过：基准读成 15500，其实是扫描到一半）。
 */
async function cumSettled() {
  let b = await qg.handleUiRequest({ action: 'cumulative' });
  for (let i = 0; i < 80 && (b.board.scan.running || b.board.scan.partial); i++) {
    await new Promise((r) => setTimeout(r, 50));
    b = await qg.handleUiRequest({ action: 'cumulative' });
  }
  return b.board.totals.tokens;
}

/**
 * 与页面 fmtK **逐字同源**的实现（直接照抄）。
 * ⚠️ 不能凭印象写近似版：4.0k vs 4k 这种差异会让断言误报，
 *    而那是测试的错、不是页面的错（这个坑踩了两次）。
 */
function fmtKx(n) {
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

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const ok = (name, cond) => t(name, !!cond, true);

const html = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(UI, 'app.js'), 'utf8');

const dom = new JSDOM(html, {
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  url: 'http://127.0.0.1:3210/plugin-ui/quota-guard/index.html',
  beforeParse(window) {
    // 把页面的 fetch 直接接到插件的动作入口上（等价于程序那条 /api/plugin-ui/<id>/action）。
    // ⚠️ 不要在这里给某个 action 单独造返回值：造的形状一旦和插件真实返回的不一致，
    //    测出来的就是"假数据的形状"，而不是插件的契约（实测踩过：这里返回 {id}，
    //    而插件返回 {userId}，于是界面渲染出的按钮 QQ 号是空的，看着像插件的 bug）。
    //    需要假数据（如好友列表）就在插件那一层注入 fetch，见上面的 qg.setup(...)。
    window.fetch = async (url, opts) => {
      const body = JSON.parse((opts && opts.body) || '{}');
      const d = await bridgeTarget.handleUiRequest({ ...body, port: 3210 });
      return { ok: true, json: async () => d };
    };
  }
});
const { window } = dom;
const doc = window.document;
const $ = (id) => doc.getElementById(id);
const fire = (el, type, extra = {}) => {
  const ev = new window.Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, extra);
  el.dispatchEvent(ev);
};
const click = (el) => fire(el, 'click');
/** 等一轮微任务，让 fetch/await 链跑完 */
const tick = () => new Promise((r) => setTimeout(r, 0));
/**
 * 等到条件成立（最多 ~1 秒）。
 *
 * ⚠️ 有些位置不能只 await 两个 tick：整段测试里前面已经堆了不少 async 链
 *    （fetch 桥 → handleUiRequest → 文件 IO），轮到某一步时两跳不一定够，
 *    会看到"还在加载中"的中间态 —— 那是**测试等待不够**，不是功能坏了。
 *    实测踩过：好友列表断言拿到的是"拉取好友列表…"占位。
 */
async function waitFor(fn, label) {
  for (let i = 0; i < 100; i++) {
    // ⚠️ 必须 await：谓词可能是 async（要问插件拿最新数字）。
    //    不 await 的话 Promise 对象恒为真值，waitFor 会**立刻返回**，
    //    后面的断言全在旧数据上跑 —— 实测踩过，表现为"总消耗"断言莫名失败。
    try { if (await fn()) return true; } catch { /* 还没就绪 */ }
    await new Promise((r) => setTimeout(r, 10));
  }
  console.log(`  [waitFor 超时] ${label || ''}`);
  return false;
}

// 先把 DOMContentLoaded 绑上，再执行页面脚本（defer 的等价效果）
const ready = new Promise((r) => doc.addEventListener('DOMContentLoaded', r));
window.eval(appJs);
fire(doc, 'DOMContentLoaded');
await ready;
await tick(); await tick();

const LIST = () => $('qg-list');

/**
 * 把插件开关设成指定状态并等页面刷出来。
 *
 * 为什么需要它：顶部那颗开关是真的会落盘的，而"未生效"时页面会如实隐藏
 * "有人已超额"之类的运行态提示（没在拦人，报了就是撒谎）。所以凡是断言
 * 运行态提示的用例，都要先明确把开关打开。
 */
async function setEnabled(on) {
  $('qg-enable').checked = on;
  fire($('qg-enable'), 'change');
  await waitFor(() => cfgMod.getConfig().skills['quota-guard']?.enabled === on, '开关落盘=' + on);
  // 等界面也跟上（标签/徽标是同一次 render 里刷的，落盘与重渲染不在同一拍）
  await waitFor(() => $('qg-enable-label').textContent === (on ? '已开启' : '已关闭'), '开关标签刷新');
}
const personEls = () => [...LIST().querySelectorAll('.qg-person')];
const names = () => personEls().map((p) => p.querySelector('.qg-person-name').textContent.trim());
/**
 * 按 QQ 号找列表里那一行。
 * ⚠️ 必须同时看 data-pick 属性：有昵称时 QQ 号只出现在属性里，不在可见文本里，
 *    只搜 textContent 会找不到人（这是测试写法问题，不是页面问题）。
 */
const findPerson = (qq) => personEls().find((p) => p.getAttribute('data-pick') === String(qq));

window.addEventListener('error', function (e) {
    console.log('  [页面错误]', e.message, '@', (e.filename||'').split('/').pop() + ':' + e.lineno);
  });
  const _origErr = console.error;
  console.error = function () { console.log('  [页面 console.error]', Array.prototype.slice.call(arguments).join(' ')); _origErr.apply(console, arguments); };

console.log('── 1. 空状态 ──');
ok('页面渲染出了列表容器', !!LIST());
ok('空状态提示可见', !$('qg-empty').hidden);
ok('提示里引导怎么加人', /添加人/.test($('qg-empty').textContent));
ok('详情面板处于空态', $('qg-detail-empty').hidden === false && $('qg-detail-body').hidden === true);

console.log('\n── 2. 添加人（手填 QQ 号 + 备注 + 额度）──');
$('qg-add-person').click();
// ⚠️ 查 .hidden **属性**（property），不是 getAttribute('hidden')。
//    HTML 里写了 hidden="" 之后，JS 把属性置回 true/false 不会同步到特性上，
//    查特性会永远看到"还是隐藏"（这是测试写法问题，不是页面问题）。
ok('添加区展开', $('qg-addbox').hidden === false);
$('qg-add-qq').value = '3573039609';
$('qg-add-name').value = '主人';
$('qg-add-limit').value = '200000';
click($('qg-add-confirm'));
await tick(); await tick();
// 他还没发过言 → 账本里没有昵称，所以列表显示 QQ 号；备注"主人"另显示成标签。
// （这是刻意的：备注不该冒充本人名字，否则改个备注就像换了个人）
  ok('列表里出现这个 QQ 号', !!findPerson('3573039609'));
ok('已设额度标记为「单独」', findPerson('3573039609').textContent.includes('单独'));
ok('备注显示成标签而不是名字', findPerson('3573039609').textContent.includes('主人'));
ok('添加后自动选中他（右边面板立刻出现，不用再点一下）', !!findPerson('3573039609').classList.contains('is-sel'));
ok('添加成功后添加区自动收起', $('qg-addbox').hidden === true);

console.log('\n── 3. 单人详情面板 ──');
ok('详情面板已显示', $('qg-detail-body').hidden === false);
// 他还没发过言 → 没有真实昵称，详情用备注"主人"显示，并如实标注"还没发过言"
ok('详情用备注兜底显示名字', $('qg-detail-body').textContent.includes('主人'));
ok('详情里显示 QQ 号', $('qg-detail-body').textContent.includes('3573039609'));
ok('如实标注今天还没发言', $('qg-detail-body').textContent.includes('没发言'));
ok('额度模式选在「单独设额度」', doc.querySelector('input[name="qg-mode"][value="custom"]').checked);
t('额度输入框带出了已保存的值', $('qg-detail-limit').value, '200000');
ok('显示了额度来源标签', $('qg-detail-body').textContent.includes('单独设置'));
ok('有快捷额度按钮', $('qg-detail-body').querySelectorAll('[data-preset]').length >= 5);
ok('有清零 / 取消额度 / 删除 三个操作', !!$('qg-detail-clear') && !!$('qg-detail-dropquota') && !!$('qg-detail-delete'));

console.log('\n── 4. 快捷额度按钮 ──');
click($('qg-detail-body').querySelector('[data-preset="50000"]'));
t('点 50,000 后输入框变成 50000', $('qg-detail-limit').value, '50000');
ok('并自动切到「单独设额度」', doc.querySelector('input[name="qg-mode"][value="custom"]').checked);

console.log('\n── 5. 保存单人设置（额度 + 备注）──');
$('qg-detail-limit').value = '50000';
$('qg-detail-note').value = '老同学';
click($('qg-detail-save'));
await tick(); await tick();
{
  const r = cfgMod.getConfig().skills['quota-guard'].perUser['3573039609'];
  t('额度已落盘', r.limit, 50000);
  t('备注已落盘', r.note, '老同学');
}
// 关键回归：昵称字段不能被备注污染。
// 他还没发过言，所以 name 本来就该是空 —— 备注只能待在 note 里、并作为显示兜底。
ok('列表用备注兜底显示（他没有真实昵称）', findPerson('3573039609').textContent.includes('老同学'));
{
  const row = (await qg.handleUiRequest({ action: 'state' })).rows.find((x) => x.userId === '3573039609');
  t('name 与 note 是两个独立字段（备注没冒充昵称）', [row.name, row.note], ['', '老同学']);
  t('displayName 按"昵称优先、备注兜底"算', row.displayName, '老同学');
  t('并如实标记没有真实昵称', row.hasNickname, false);
}

console.log('\n── 6. 额度模式：单独不限 ──');
{
  const radio = doc.querySelector('input[name="qg-mode"][value="unlimited"]');
  radio.checked = true;
  fire(radio, 'change');
  // change 事件后自定义额度输入应被隐藏
  ok('选「单独不限」后额度输入框隐藏', $('qg-custom-wrap').hidden);
  click($('qg-detail-save'));
  await tick(); await tick();
  t('额度被写成 0（= 该人单独不限）', cfgMod.getConfig().skills['quota-guard'].perUser['3573039609'].limit, 0);
}

console.log('\n── 7. 取消单独额度（回到跟随全局）──');
$('qg-defaultlimit').value = '80000';
click($('qg-save'));
await tick(); await tick();
click($('qg-detail-dropquota'));
await tick(); await tick();
{
  const perUser = cfgMod.getConfig().skills['quota-guard'].perUser;
  ok('perUser 里已经没有他了（__replace__ 真的删掉了）', perUser['3573039609'] === undefined);
  // ⚠️ 取消单独额度后他就"既没额度也没用量"了，因此**会从列表里消失** ——
  //    这是设计如此（列表 = 有额度的人 ∪ 今天有账的人），不是丢数据。
  const st = await qg.handleUiRequest({ action: 'state' });
  t('他从列表里消失了（无额度且今天没账）', st.rows.some((x) => x.userId === '3573039609'), false);
  ok('右边面板回到空态提示', $('qg-detail-empty').hidden === false);
}

console.log('\n── 8. 制造用量，验证超额展示 ──');
{
  await setEnabled(true);        // 运行态提示只在开关打开时才该出现
  const msg = (id, n, t2) => ({ id: Math.random(), senderId: String(id), senderName: n, text: t2 });
  const api = { config: () => ({}), log: () => {}, isSkillActive: () => true };
  // 把默认额度改成 10000（上一段把它改成过 80000）
  $('qg-defaultlimit').value = '10000';
  click($('qg-save'));
  await tick(); await tick();

  // 上一段取消了"主人"的单独额度，他因此离开了列表 —— 这里直接落一笔用量把他带回来，
  // 顺便给"路人甲"也设一笔（用插件接口，等价于用户已经配过）
  await qg.handleUiRequest({ action: 'setLimit', payload: { userId: '123456789', limit: 10000, name: '路人甲' } });
  const batch = [msg(3573039609, '主人', 'a'), msg(123456789, '路人甲', 'b')];
  qg.hooks['before-context']({ ...api, chatKey: 'group:1', sessionId: 'ui-s1', triggerEntries: batch });
  const session = { id: 'ui-s1', chatKey: 'group:1', usage: { totalTokens: 30000 } };
  qg.hooks['after-response']({ ...api, response: { usage: { total_tokens: 30000 } }, session });

  click($('qg-refresh'));
  await tick(); await tick();
  t('列表里现在是两个人', names().length, 2);
  ok('两人都显示为超额（各 15000 / 额度 10000）', personEls().every((p) => p.classList.contains('is-over')));
  ok('统计条显示已超额人数', $('qg-stats').textContent.includes('已超额'));
  ok('顶部状态徽标提示有人超额', $('qg-state').textContent.includes('超额'));
}

console.log('\n── 9. 筛选 ──');
{
  $('qg-filter').value = 'over';
  fire($('qg-filter'), 'change');
  t('筛选「已超额」→ 2 人', names().length, 2);
  $('qg-filter').value = 'nocap';
  fire($('qg-filter'), 'change');
  // 「未设额度」= 没有单独额度的人。主人用的是全局默认额度（10000），所以算未设额度；
  // 路人甲有单独额度。这里恰好 1 人。
  t('筛选「未设额度」→ 1 人', names().length, 1);
  ok('这 1 人正是跟随默认额度的那位', findPerson('3573039609') != null);
  $('qg-filter').value = 'capped';
  fire($('qg-filter'), 'change');
  t('筛选「已设额度」→ 1 人（路人甲）', names().length, 1);
  ok('已设额度的是路人甲', findPerson('123456789') != null);
  $('qg-filter').value = 'all';
  fire($('qg-filter'), 'change');
  t('恢复全部 → 2 人', names().length, 2);
}

console.log('\n── 10. 搜索 ──');
{
  $('qg-search').value = '主人';
  fire($('qg-search'), 'input');
  t('搜昵称', names().length, 1);
  $('qg-search').value = '123456789';
  fire($('qg-search'), 'input');
  t('搜 QQ 号', names(), ['路人甲']);
  $('qg-search').value = '';
  fire($('qg-search'), 'input');
  t('清空搜索恢复 2 人', names().length, 2);
}

console.log('\n── 11. 排序 ──');
{
  $('qg-sort').value = 'name';
  fire($('qg-sort'), 'change');
  t('按昵称排（主人 vs 路人甲）', names().length, 2);
  $('qg-sort').value = 'used';
  fire($('qg-sort'), 'change');
  ok('按用量排不报错', names().length === 2);
}

console.log('\n── 12. 批量设额度 ──');
{
  // 勾选两人。⚠️ 每勾一个都要**重新取一次** DOM：勾选会触发重渲染重建列表，
  //    第一次留下的元素已成游离节点，再点它冒泡不到 #qg-list 的委托监听上。
  ['3573039609', '123456789'].forEach((qq) => {
    const cb = findPerson(qq).querySelector('[data-check]');
    cb.checked = true;
    click(cb);
  });
  await tick(); await tick();
  ok('批量按钮已启用', $('qg-batch').disabled === false);
  ok('按钮上显示勾选数量', $('qg-batch').textContent.includes('2'));
  click($('qg-batch'));
  ok('批量弹窗打开', !$('qg-modal').hidden);
  ok('弹窗提示里列出要改的人', $('qg-modal-hint').textContent.includes('2'));
  click($('qg-modal-quick').querySelector('[data-preset="500000"]'));
  t('快捷按钮填进弹窗', $('qg-modal-limit').value, '500000');
  click($('qg-modal-ok'));
  await tick(); await tick();
  ok('弹窗已关闭', $('qg-modal').hidden);
  const perUser = cfgMod.getConfig().skills['quota-guard'].perUser;
  t('两人的额度都被改写', [perUser['3573039609'].limit, perUser['123456789'].limit], [500000, 500000]);
  ok('列表上不再显示超额', personEls().every((p) => !p.classList.contains('is-over')));
}

console.log('\n── 13. 单人清零 ──');
{
  const before = await qg.handleUiRequest({ action: 'state' });
  ok('清零前他确实有用量（前提条件）', before.rows.find((r) => r.userId === '3573039609').used > 0);
  click(findPerson('3573039609'));
  await waitFor(() => $('qg-detail-body').hidden === false && !!$('qg-detail-clear'), '详情面板渲染');
  ok('点一下左边就选中了他（右边出现详情）', $('qg-detail-body').hidden === false);
  click($('qg-detail-clear'));
  await tick(); await tick();
  const st = await qg.handleUiRequest({ action: 'state' });
  const row = st.rows.find((x) => x.userId === '3573039609');
  t('他的今日用量归零', row.used, 0);
  const other = st.rows.find((x) => x.userId === '123456789');
  ok('别人的用量没被动', other.used > 0);
}

console.log('\n── 14. 删除一个人（自建确认框，不是原生 confirm）──');
{
  const p = findPerson('123456789');
  click(p);
  await tick();
  click($('qg-detail-delete'));
  ok('出现了自建确认框', $('qg-confirm') && !$('qg-confirm').hidden);
  ok('确认框标题点名了是谁', $('qg-confirm-title').textContent.includes('123456789'));
  click($('qg-confirm-ok'));
  await tick(); await tick();
  ok('确认框已关闭', $('qg-confirm').hidden);
  t('列表里只剩一个人', names().length, 1);
  const perUser = cfgMod.getConfig().skills['quota-guard'].perUser;
  ok('他的单独额度也一起删了', perUser['123456789'] === undefined);
}

console.log('\n── 15. 从好友列表选人 ──');
{
  click($('qg-add-person'));
  await tick();
  click(doc.querySelector('[data-addtab="friends"]'));
  await waitFor(() => doc.querySelectorAll('#qg-friends [data-add-user]').length >= 2, '好友列表渲染');
  const friends = doc.querySelectorAll('#qg-friends [data-add-user]');
  t('拉到两个好友', friends.length, 2);
  ok('好友按钮上带了 QQ 号（回归：曾经这里是空的）', friends[1].getAttribute('data-add-user') === '123456789');
  click(friends[1]);
  await tick();
  t('点击后 QQ 号被填入', $('qg-add-qq').value, '123456789');
  t('昵称也被填入', $('qg-add-name').value, '路人甲');
  // 收起来，免得挡着后面的列表断言
  click($('qg-add-person'));
}

console.log('\n── 16. 全局设置折叠 ──');
{
  const card = $('qg-settings-card');
  ok('默认是折叠的', card.classList.contains('qg-collapsed'));
  click($('qg-settings-toggle'));
  ok('点一下展开', !card.classList.contains('qg-collapsed'));
  click($('qg-settings-toggle'));
  ok('再点一下收起', card.classList.contains('qg-collapsed'));
  ok('折叠摘要里显示了关键值', $('qg-settings-summary').textContent.includes('默认额度'));
}

console.log('\n── 17. 界面上没有原生 prompt / confirm（宿主对此有硬要求）──');
{
  const src = fs.readFileSync(path.join(UI, 'app.js'), 'utf8');
  ok('app.js 里没有裸露的 prompt(', !/[^.\w]prompt\s*\(/.test(src));
  ok('app.js 里没有裸露的 confirm(', !/[^.\w]confirm\s*\(/.test(src));
}

console.log('\n── 18. 用量以 k 计数（显示层换算，原始值不动）──');
{
  // 抠出页面的格式化/解析函数来验边界（它们是纯函数）
  const src = fs.readFileSync(path.join(UI, 'app.js'), 'utf8');
  const grab = (name) => {
    const m = new RegExp(`function ${name}\\b`).exec(src);
    const start = src.indexOf('{', m.index);
    let d = 0;
    for (let i = start; i < src.length; i++) {
      if (src[i] === '{') d++;
      else if (src[i] === '}') { d--; if (!d) return src.slice(m.index, i + 1); }
    }
    throw new Error('抠不出来: ' + name);
  };
  const sandbox = {};
  new Function('out', grab('fmtK') + '\n' + grab('parseLimit') + '\nout.fmtK=fmtK; out.parseLimit=parseLimit;')(sandbox);
  const { fmtK, parseLimit } = sandbox;

  console.log('  — fmtK 显示规则 —');
  t('999 原样（不写成 1.0k）', fmtK(999), '999');
  t('1000 → 1.0k', fmtK(1000), '1.0k');
  t('1500 → 1.5k', fmtK(1500), '1.5k');
  t('9999 → 10.0k', fmtK(9999), '10.0k');
  t('10000 → 10k（整数不显示 .0）', fmtK(10000), '10k');
  t('15000 → 15k', fmtK(15000), '15k');
  t('15500 → 15.5k', fmtK(15500), '15.5k');
  t('99999 → 99.9k（还在 10k~100k 档，保留一位小数）', fmtK(99999), '99.9k');
  t('100000 → 100k（进 100k 档后取整）', fmtK(100000), '100k');
  t('150000 → 150k', fmtK(150000), '150k');
  t('500000 → 500k', fmtK(500000), '500k');
  t('999949 → 999k（高位向下取整，不该出现 1000k）', fmtK(999949), '999k');
  t('999000 → 999k', fmtK(999000), '999k');
  t('1000000 → 1.0M（到 100 万换单位）', fmtK(1000000), '1.0M');
  t('1234567 → 1.2M', fmtK(1234567), '1.2M');
  t('0 → 0', fmtK(0), '0');
  t('undefined → 0（不显示 NaN）', fmtK(undefined), '0');
  t('null → 0', fmtK(null), '0');

  console.log('  — parseLimit 接受简写 —');
  t('50000 原样', parseLimit('50000'), 50000);
  t('50k → 50000', parseLimit('50k'), 50000);
  t('50K 大写也认', parseLimit('50K'), 50000);
  t('1.5k → 1500', parseLimit('1.5k'), 1500);
  t('2M → 2000000', parseLimit('2M'), 2000000);
  t('带逗号 1,000,000', parseLimit('1,000,000'), 1000000);
  t('带空格 50 k', parseLimit('50 k'), 50000);
  t('0 → 0', parseLimit('0'), 0);
  t('空串 → null（含义由调用方定）', parseLimit(''), null);
  t('乱写 → null', parseLimit('abc'), null);
  t('负数 → null', parseLimit('-5'), null);
  t('1k2 → null（不猜）', parseLimit('1k2'), null);
}

console.log('\n── 19. 列表/详情显示成 k，悬停给精确值 ──');
{
  const msg = (id, n, t2) => ({ id: Math.random(), senderId: String(id), senderName: n, text: t2 });
  const api = { config: () => ({}), log: () => {}, isSkillActive: () => true };
  await qg.handleUiRequest({ action: 'setLimit', payload: { userId: '3573039609', limit: 500000, name: '主人' } });
  const _base = (await qg.handleUiRequest({ action: 'state' })).rows.find((r) => r.userId === '3573039609');
  const spentBefore = _base.spent;
  const usedBefore = _base.used;
  const batch = [msg(3573039609, '主人', 'a')];
  qg.hooks['before-context']({ ...api, chatKey: 'gk', sessionId: 'gk1', triggerEntries: batch });
  qg.hooks['after-response']({ ...api, response: { usage: { total_tokens: 15500 } }, session: { id: 'gk1', chatKey: 'gk', usage: { totalTokens: 15500 } } });
  {
    const _L = path.join(TMP, 'quota-guard', 'ledger.json');
    const _j = fs.existsSync(_L) ? JSON.parse(fs.readFileSync(_L, 'utf8')) : {};
  }
  click($('qg-refresh'));
  // ⚠️ 等"15.5k"真的出现，而不是等 "k" —— 额度那格本来就是 "500k"，
  //    等 "k" 会在用量还没渲染出来时就放行（实测踩过：断言拿到 "0 token"）。
  await waitFor(() => (findPerson('3573039609') || {}).textContent?.includes('15.5k'), '用量渲染成 15.5k');

  // ⚠️ spent 是"今天累计消耗"，不是"本次一笔" —— 第 13 段已经给他记过一笔，
  //    所以这里断言**增量**，不要写死数字（写死会误报，踩过）。
  const stNow = await qg.handleUiRequest({ action: 'state' });
  const rowData = stNow.rows.find((r) => r.userId === '3573039609');
  t('★ 今日用量 = 之前的累计 + 本次 15,500', rowData.spent, spentBefore + 15500);
  t('★ 余额扣减量同样 +15,500', rowData.used, usedBefore + 15500);

  const row = findPerson('3573039609');
  ok('列表显示今日用量', row.textContent.includes(fmtKx(rowData.spent)));
  ok('列表显示当前余额', row.textContent.includes(fmtKx(rowData.remaining)));
  ok('不再显示带逗号的长数字', !row.textContent.includes('15,500'));
  t('悬停给今日用量的精确值', row.querySelector('.qg-strong').getAttribute('title'), '今日用量 ' + rowData.spent.toLocaleString('en-US') + ' token');
  ok('余额的精确值也挂在悬停提示上', row.innerHTML.includes(rowData.remaining.toLocaleString('en-US') + ' token'));

  click(row);
  await waitFor(() => $('qg-detail-body').textContent.includes(fmtKx(spentBefore + 15500)), '详情渲染出用量');
  ok('详情里也用 k', $('qg-detail-body').textContent.includes(fmtKx(spentBefore + 15500)));
  ok('用量的精确值挂在悬停提示上', ($('qg-detail-body').innerHTML).includes((spentBefore + 15500).toLocaleString('en-US') + ' token'));
  ok('并注明重置余额不影响它', $('qg-detail-body').textContent.includes('重置余额不影响它'));
  ok('额度的精确值也挂在悬停提示上', ($('qg-detail-body').innerHTML).includes('500,000 token'));

  // 关键：格式化绝不能回写到数据
  const st = await qg.handleUiRequest({ action: 'state' });
  const rr = st.rows.find((r) => r.userId === '3573039609');
  t('账本里的今日用量是精确整数', rr.spent, spentBefore + 15500);
  t('配置里的额度也是精确整数', cfgMod.getConfig().skills['quota-guard'].perUser['3573039609'].limit, 500000);
}

console.log('\n── 20. 单人额度输入支持 k 简写 ──');
{
  click(findPerson('3573039609'));
  await waitFor(() => !!$('qg-detail-limit'), '详情额度框');
  const radio = doc.querySelector('input[name="qg-mode"][value="custom"]');
  radio.checked = true;
  fire(radio, 'change');
  $('qg-detail-limit').value = '30k';
  fire($('qg-detail-limit'), 'input');
  ok('输入 30k 时显示换算', $('qg-limit-hint').textContent.includes('30,000'));
  click($('qg-detail-save'));
  await waitFor(() => cfgMod.getConfig().skills['quota-guard'].perUser['3573039609']?.limit === 30000, '保存 30k');
  t('30k 被正确存成 30000', cfgMod.getConfig().skills['quota-guard'].perUser['3573039609'].limit, 30000);
}

console.log('\n── 21. 全局默认额度支持 k，乱填不覆盖 ──');
{
  $('qg-defaultlimit').value = '80k';
  click($('qg-save'));
  await waitFor(() => (cfgMod.getConfig().skills['quota-guard'] || {}).defaultDailyLimit === 80000, '默认 80k');
  t('默认额度 80k → 80000', cfgMod.getConfig().skills['quota-guard'].defaultDailyLimit, 80000);
  await waitFor(() => $('qg-settings-summary').textContent.includes('80k'), '摘要刷新');
  ok('折叠摘要显示 80k', $('qg-settings-summary').textContent.includes('80k'));

  $('qg-defaultlimit').value = '八十k';
  click($('qg-save'));
  await tick(); await tick();
  t('乱填不会被静默写成 0', cfgMod.getConfig().skills['quota-guard'].defaultDailyLimit, 80000);
  ok('乱填时给了提示', ($('qg-toast').textContent + $('qg-note').textContent).includes('不对'));
}

console.log('\n── 21b. 开关改动即保存（不等「保存设置」）──');
{
  // 关掉发送限流前置，不应需要点保存按钮
  const before = cfgMod.getConfig().skills['quota-guard'].blockWhenSendLimited;
  $('qg-sendgate').checked = false;
  fire($('qg-sendgate'), 'change');
  await waitFor(() => cfgMod.getConfig().skills['quota-guard'].blockWhenSendLimited === false, '落盘 false');
  t('取消勾选后立刻落盘（无需点保存）', cfgMod.getConfig().skills['quota-guard'].blockWhenSendLimited, false);

  $('qg-sendgate').checked = true;
  fire($('qg-sendgate'), 'change');
  await waitFor(() => cfgMod.getConfig().skills['quota-guard'].blockWhenSendLimited === true, '落盘 true');
  t('重新勾选也立刻落盘', cfgMod.getConfig().skills['quota-guard'].blockWhenSendLimited, true);

  // 额度提示开关同理
  $('qg-notify').checked = true;
  fire($('qg-notify'), 'change');
  await waitFor(() => cfgMod.getConfig().skills['quota-guard'].notifyOnBlock === true, '通知落盘');
  t('额度提示开关也立刻落盘', cfgMod.getConfig().skills['quota-guard'].notifyOnBlock, true);
  $('qg-notify').checked = false;
  fire($('qg-notify'), 'change');
  await waitFor(() => cfgMod.getConfig().skills['quota-guard'].notifyOnBlock === false, '通知关掉');

  // 关键回归：额度框里是坏值时，拨开关不能把默认额度清成 0
  const keep = cfgMod.getConfig().skills['quota-guard'].defaultDailyLimit;
  $('qg-defaultlimit').value = '乱写的';
  $('qg-sendgate').checked = false;
  fire($('qg-sendgate'), 'change');
  await waitFor(() => cfgMod.getConfig().skills['quota-guard'].blockWhenSendLimited === false, '坏值时也落盘');
  t('额度框坏值时不清掉默认额度', cfgMod.getConfig().skills['quota-guard'].defaultDailyLimit, keep);
  $('qg-defaultlimit').value = String(keep);
  $('qg-sendgate').checked = true;
  fire($('qg-sendgate'), 'change');
  await waitFor(() => cfgMod.getConfig().skills['quota-guard'].blockWhenSendLimited === true, '恢复');
}

console.log('\n── 22. 批量弹窗支持 k ──');
{
  $('qg-defaultlimit').value = '0';
  click($('qg-save'));
  await tick(); await tick();
  const cb = findPerson('3573039609').querySelector('[data-check]');
  cb.checked = true;
  click(cb);
  await waitFor(() => $('qg-batch').disabled === false, '批量按钮');
  click($('qg-batch'));
  await tick();
  $('qg-modal-limit').value = '1.5k';
  fire($('qg-modal-limit'), 'input');
  ok('弹窗里实时换算', $('qg-modal-hint').textContent.includes('1,500'));
  click($('qg-modal-ok'));
  await waitFor(() => cfgMod.getConfig().skills['quota-guard'].perUser['3573039609']?.limit === 1500, '批量 1.5k');
  t('批量 1.5k → 1500', cfgMod.getConfig().skills['quota-guard'].perUser['3573039609'].limit, 1500);
}

console.log('\n── 23. 插件开关（页面顶部那颗）──');
{
  // 先把开关关掉（前面测试从没开过，这里明确设一次）
  skMod.setSkillConfig('quota-guard', { enabled: false });
  click($('qg-refresh'));
  await waitFor(() => $('qg-enable-label').textContent === '已关闭', '开关显示已关闭');
  ok('顶部开关未勾选', $('qg-enable').checked === false);
  ok('标签写着「已关闭」', $('qg-enable-label').textContent === '已关闭');
  ok('关着时状态徽标如实显示「未生效」', $('qg-state').textContent === '未生效');
  ok('关着时不会误报"有人已超额"', !$('qg-state').classList.contains('is-warn'));

  // 打开它
  $('qg-enable').checked = true;
  fire($('qg-enable'), 'change');
  await waitFor(() => cfgMod.getConfig().skills['quota-guard'].enabled === true, '开关落盘');
  t('打开后 config.skills 里 enabled = true（和宿主插件页同一个开关）', cfgMod.getConfig().skills['quota-guard'].enabled, true);
  await waitFor(() => $('qg-enable-label').textContent === '已开启', '标签刷新');
  ok('标签变成「已开启」', $('qg-enable-label').textContent === '已开启');
  ok('状态徽标回到正常态', $('qg-state').textContent !== '未生效');

  // 再关一次，验证双向
  $('qg-enable').checked = false;
  fire($('qg-enable'), 'change');
  await waitFor(() => cfgMod.getConfig().skills['quota-guard'].enabled === false, '关闭落盘');
  t('关闭同样落盘', cfgMod.getConfig().skills['quota-guard'].enabled, false);

  // 复原成开启，免得影响后面
  await qg.handleUiRequest({ action: 'setEnabled', payload: { enabled: true } });
}

console.log('\n── 24. 从群成员选人（不再只能手填 QQ 号）──');
{
  const dbg = window.__qgDebug;
  // 明确地把添加区**先关掉再打开**，并显式点「从群成员选」页签。
  // 不这么做的话，前面用例可能已经把添加区留在打开状态（那时再点一次是"收起"），
  // 断言就会看到上一次的页签 —— 实测踩过：断言"默认停在群成员页签"失败。
  if (!$('qg-addbox').hidden) { click($('qg-add-person')); await tick(); }
  click($('qg-add-person'));
  await waitFor(() => $('qg-addbox').hidden === false, '添加区展开');
  click(doc.querySelector('[data-addtab="members"]'));
  await tick();
  ok('可以切到「从群成员选」页签', !$('qg-pane-members').hidden);
  ok('群成员页签高亮', doc.querySelector('[data-addtab="members"]').classList.contains('is-on'));
  ok('手填页签这时候是收起的', $('qg-pane-manual').hidden === true);

  await waitFor(() => (dbg.groups() || []).length >= 2, '群列表加载');
  t('群列表拉到了 2 个群', dbg.groups().length, 2);
  ok('下拉框里有「测试群」', $('qg-group-select').innerHTML.includes('测试群'));

  // 契约：fetchGroups / fetchMembers 直接调也要对
  const gApi = await qg.handleUiRequest({ action: 'fetchGroups', payload: { port: 3210 } });
  t('fetchGroups 返回 2 个群', (gApi.groups || []).length, 2);
  const mApi = await qg.handleUiRequest({ action: 'fetchMembers', payload: { groupId: '1039172534', port: 3210 } });
  t('fetchMembers 返回 3 个成员', (mApi.members || []).length, 3);
  t('成员字段是 userId + name + nickname', Object.keys(mApi.members[0]).sort(), ['hasQuota', 'name', 'nickname', 'userId']);
  t('优先用群名片（李四 → 群里的昵称）', mApi.members[1].name, '群里的昵称');
  t('没名片时用昵称', mApi.members[0].name, '张三');

  // 选一个群 → 自动拉成员
  $('qg-group-select').value = '1039172534';
  fire($('qg-group-select'), 'change');
  await waitFor(() => dbg.members() && dbg.members().length >= 3, '成员加载');
  t('拉到 3 个群成员', dbg.members().length, 3);
  const btns = doc.querySelectorAll('#qg-members [data-add-user]');
  t('成员渲染成按钮', btns.length, 3);
  ok('界面上显示的是群名片', $('qg-members').innerHTML.includes('群里的昵称'));
  ok('没名片时退回昵称', $('qg-members').innerHTML.includes('张三'));
  ok('按钮上带 QQ 号', btns[0].getAttribute('data-add-user') === '11111111');

  // 搜索过滤
  $('qg-member-search').value = '李四';
  fire($('qg-member-search'), 'input');
  await tick();
  t('搜「李四」命中 1 人（用真实昵称也能搜到设了名片的他）', doc.querySelectorAll('#qg-members [data-add-user]').length, 1);
  ok('搜索结果里把他的昵称也显示出来，方便确认是谁', $('qg-members').innerHTML.includes('李四'));
  $('qg-member-search').value = '22222222';
  fire($('qg-member-search'), 'input');
  await tick();
  t('按 QQ 号也能搜', doc.querySelectorAll('#qg-members [data-add-user]').length, 1);
  $('qg-member-search').value = '';
  fire($('qg-member-search'), 'input');
  await tick();
  t('清空搜索恢复 3 人', doc.querySelectorAll('#qg-members [data-add-user]').length, 3);

  // 点一个人 → 填进手填页签，并且**不**立刻落盘
  const before = JSON.stringify(cfgMod.getConfig().skills['quota-guard'].perUser);
  click(doc.querySelectorAll('#qg-members [data-add-user]')[0]);
  await tick();
  ok('点成员后跳到手填页签', !$('qg-pane-manual').hidden);
  t('QQ 号被填入', $('qg-add-qq').value, '11111111');
  t('昵称被填入', $('qg-add-name').value, '张三');
  t('点一下不会立刻加进额度表（要点「添加」才落盘）', JSON.stringify(cfgMod.getConfig().skills['quota-guard'].perUser), before);

  // 填额度 → 添加
  $('qg-add-limit').value = '20k';
  click($('qg-add-confirm'));
  await waitFor(() => cfgMod.getConfig().skills['quota-guard'].perUser['11111111']?.limit === 20000, '添加群成员');
  t('群成员添加成功，20k → 20000', cfgMod.getConfig().skills['quota-guard'].perUser['11111111'].limit, 20000);
  await waitFor(() => !!findPerson('11111111'), '新人出现在左侧列表');
  ok('他出现在左侧列表里', !!findPerson('11111111'));
}

console.log('\n── 25. 从好友选（原有能力没丢）──');
{
  const dbg = window.__qgDebug;
  click($('qg-add-person'));
  await tick();
  click(doc.querySelector('[data-addtab="friends"]'));
  await waitFor(() => (dbg.friends() || []).length >= 2, '好友加载');
  t('好友页签拉到 2 人', dbg.friends().length, 2);
  ok('好友面板可见', $('qg-pane-friends').hidden === false);
  ok('群成员面板已收起', $('qg-pane-members').hidden === true);
  const fb = doc.querySelectorAll('#qg-friends [data-add-user]');
  ok('好友按钮带 QQ 号', fb[1].getAttribute('data-add-user') === '123456789');
  click(fb[1]);
  await tick();
  t('点好友后 QQ 号进手填框', $('qg-add-qq').value, '123456789');
}

console.log('\n── 26. 群号不合法要拦住 ──');
{
  const bad = await qg.handleUiRequest({ action: 'fetchMembers', payload: { groupId: '../etc', port: 3210 } });
  t('非法群号被拒绝（不会拼进 URL）', bad.ok, false);
  ok('给了明确的错误', /不合法/.test(bad.error || ''));
}

/**
 * 取累计榜，并等后台回填跑完。
 *
 * ⚠️ 累计是**后台分片扫描**出来的（见插件 kickScan），第一次请求返回时
 *    扫描往往刚开始，board 还是空的 —— 直接断言就会得到一堆 0。
 *    这里轮询到"不再统计中"再返回。
 */
async function cumulativeSettled(maxMs = 6000) {
  let b = await qg.handleUiRequest({ action: 'cumulative' });
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (!b.board.scan.running && !b.board.scan.partial) return b;
    await new Promise((r) => setTimeout(r, 100));
    b = await qg.handleUiRequest({ action: 'cumulative' });
  }
  return b;
}

console.log('\n── 27. 页签：今日额度 / 总用量排行榜 ──');
{
  const dbg = window.__qgDebug;
  ok('默认停在「今日额度」页', !$('qg-page-daily').hidden && $('qg-page-total').hidden);
  ok('页签高亮正确', doc.querySelector('[data-page="daily"]').classList.contains('is-on'));

  click(doc.querySelector('[data-page="total"]'));
  await waitFor(() => $('qg-page-total').hidden === false, '切到排行榜');
  ok('排行榜页显示出来了', !$('qg-page-total').hidden);
  ok('今日额度页已收起', $('qg-page-daily').hidden === true);
  ok('页签高亮切过去了', doc.querySelector('[data-page="total"]').classList.contains('is-on'));
  t('内部页码状态 = total', dbg.page(), 'total');

  click(doc.querySelector('[data-page="daily"]'));
  await waitFor(() => $('qg-page-daily').hidden === false, '切回今日');
  ok('能切回今日额度', !$('qg-page-daily').hidden && $('qg-page-total').hidden);
}

console.log('\n── 28. 累计：没有会话存档时的空状态（不能谎报有数据）──');
{
  // 临时 DATA_DIR 里没有 sessions 目录 → 应该明确说"没读到历史"，而不是空表。
  // ⚠️ 首次请求时扫描刚开始（partial=true），要等收敛后再断言。
  const b = await cumulativeSettled();
  t('会话数为 0', b.board.totals.sessions, 0);
  t('人数为 0', b.board.totals.people, 0);
  t('token 合计为 0', b.board.totals.tokens, 0);
  ok('scan 明确标记为已完整扫描过', b.board.scan.partial === false);
}

console.log('\n── 29. 累计：造一批会话存档，验证分摊与排行榜 ──');
{
  const SESS = path.join(TMP, 'sessions');
  fs.mkdirSync(SESS, { recursive: true });
  const msg = (id, n) => ({ id: Math.random(), senderId: String(id), senderName: n, text: 'x' });
  const write = (name, o) => fs.writeFileSync(path.join(SESS, name + '.json'), JSON.stringify(o), 'utf8');
  // 会话1：甲 3 条 + 乙 1 条，花 4000 → 甲 3000 / 乙 1000
  write('s1', { id: 's1', chatKey: 'group:1', startedAt: 1000, usage: { totalTokens: 4000, calls: 2 }, trigger: [msg(9001, '甲'), msg(9001, '甲'), msg(9001, '甲'), msg(9002, '乙')] });
  // 会话2：乙 2 条，花 2000 → 全归乙
  write('s2', { id: 's2', chatKey: 'group:1', startedAt: 2000, usage: { totalTokens: 2000, calls: 1 }, trigger: [msg(9002, '乙'), msg(9002, '乙')] });
  // 会话3：没人发言（主动机会），花 500 → 不归任何人
  write('s3', { id: 's3', chatKey: 'group:1', startedAt: 3000, usage: { totalTokens: 500, calls: 1 }, trigger: [] });
  // 会话4：没花钱，跳过
  write('s4', { id: 's4', chatKey: 'group:1', startedAt: 4000, usage: { totalTokens: 0, calls: 0 }, trigger: [msg(9001, '甲')] });

  const b = await cumulativeSettled();
  t('总 token = 6500（含没人发言的那 500）', b.board.totals.tokens, 6500);
  t('归到人头 = 6000', b.board.totals.attributed, 6000);
  t('未归到人头 = 500', b.board.totals.unattributed, 500);
  t('归到人头的会话 = 2 次（没人发言、没花钱的各 1 次都不算）', b.board.totals.sessions, 2);
  t('另有 1 次没归到人（没人发言）', b.board.totals.unattributedSessions, 1);
  t('2 人上榜', b.board.rows.length, 2);
  t('甲 = 3000', b.board.rows.find((r) => r.userId === '9001').tokens, 3000);
  t('乙 = 1000 + 2000 = 3000', b.board.rows.find((r) => r.userId === '9002').tokens, 3000);
  t('甲发言 3 条', b.board.rows.find((r) => r.userId === '9001').messages, 3);
  t('乙参与 2 次会话', b.board.rows.find((r) => r.userId === '9002').sessions, 2);
  ok('占比算得出（各约 50%）', b.board.rows.every((r) => Math.abs(r.share - 0.5) < 0.01));
  ok('没人发言的那次被计为"跳过：没人发言"', b.board.skipped.noTrigger >= 1);
  ok('没花钱的那次被计为"跳过：没花钱"', b.board.skipped.noUsage >= 1);
  const skipSum = b.board.rows.reduce((a, r) => a + r.tokens, 0);
  t('各人分摊之和 + 未归到人头 = 总计（账对得上）', skipSum + b.board.totals.unattributed, b.board.totals.tokens);
}

console.log('\n── 30. 累计是增量的：新会话只补扫新文件 ──');
{
  const SESS = path.join(TMP, 'sessions');
  fs.writeFileSync(path.join(SESS, 's5.json'), JSON.stringify({
    id: 's5', chatKey: 'group:1', startedAt: 5000,
    usage: { totalTokens: 1000, calls: 1 }, trigger: [{ id: 1, senderId: '9001', senderName: '甲', text: 'x' }]
  }), 'utf8');
  const b = await cumulativeSettled();
  t('新增会话被计入（甲 3000 + 1000）', b.board.rows.find((r) => r.userId === '9001').tokens, 4000);
  t('总 token 7500', b.board.totals.tokens, 7500);
  // 关键：不能重复计旧文件
  const b2 = await cumulativeSettled();
  t('再取一次数字不变（没有重复累加）', b2.board.totals.tokens, 7500);
}

console.log('\n── 31. 界面上的排行榜 ──');
{
  const dbg = window.__qgDebug;
  click(doc.querySelector('[data-page="total"]'));
  await waitFor(() => (dbg.board() || {}).totals?.tokens === 7500, '榜单加载');
  await waitFor(() => doc.querySelectorAll('#qg-cum-rows tr').length >= 2, '行渲染');

  const rows = [...doc.querySelectorAll('#qg-cum-rows tr')];
  t('渲染出 2 行', rows.length, 2);
  ok('第 1 名有奖牌', rows[0].textContent.includes('🥇'));
  ok('显示累计 token（用 k 计数）', $('qg-cum-rows').textContent.includes('4.0k'));
  ok('显示占比', $('qg-cum-rows').textContent.includes('%'));
  ok('统计条给出总计与人数', $('qg-cum-stats').textContent.includes('7.5k') && $('qg-cum-stats').textContent.includes('2 人上榜'));
  ok('如实标注"未归到人头"（那 500 没记到谁头上）', $('qg-cum-stats').textContent.includes('未归到人头'));
  ok('覆盖区间显示出来了', /\d{4}-\d{2}-\d{2}/.test($('qg-cum-range').textContent));
  ok('状态栏说明已统计多少会话', $('qg-cum-status').textContent.includes('已统计'));

  // 搜索
  $('qg-cum-search').value = '乙';
  fire($('qg-cum-search'), 'input');
  await tick();
  t('搜昵称命中 1 行', doc.querySelectorAll('#qg-cum-rows tr').length, 1);
  $('qg-cum-search').value = '9001';
  fire($('qg-cum-search'), 'input');
  await tick();
  t('搜 QQ 号命中 1 行', doc.querySelectorAll('#qg-cum-rows tr').length, 1);
  $('qg-cum-search').value = '';
  fire($('qg-cum-search'), 'input');
  await tick();

  // 排序
  $('qg-cum-sort').value = 'messages';
  fire($('qg-cum-sort'), 'change');
  await tick();
  t('按发言条数排序后仍是 2 行', doc.querySelectorAll('#qg-cum-rows tr').length, 2);
  $('qg-cum-sort').value = 'tokens';
  fire($('qg-cum-sort'), 'change');
  await tick();

  // 从榜单跳到设额度。
  // ⚠️ 得先给榜上的人设个额度 —— 今日列表只显示"有额度或今天有账"的人，
  //    否则跳过去是空的，断言会误判成"选中丢了"。
  await qg.handleUiRequest({ action: 'setLimit', payload: { userId: '9001', limit: 50000, name: '甲' } });
  await qg.handleUiRequest({ action: 'setLimit', payload: { userId: '9002', limit: 50000, name: '乙' } });
  click($('qg-refresh'));
  await waitFor(() => !!doc.querySelector('#qg-list .qg-person[data-pick="9001"]'), '甲进入今日列表');
  const targetBtn = doc.querySelector('#qg-cum-rows [data-cum-manage="9001"]');
  ok('榜单那一行有「去设额度」按钮', !!targetBtn);
  click(targetBtn);
  await tick(); await tick();
  t('跳到今日额度页', dbg.page(), 'daily');
  ok('今日额度页可见', !$('qg-page-daily').hidden);
  ok('并且选中了那个人（列表里那一行是高亮的）',
    !!doc.querySelector('#qg-list .qg-person.is-sel'));
}

console.log('\n── 32. 单人详情里显示累计 ──');
{
  const dbg = window.__qgDebug;
  click(doc.querySelector('[data-page="daily"]'));
  await waitFor(() => $('qg-page-daily').hidden === false, '回今日页');
  // 给甲设个额度，让他在今日列表里出现
  await qg.handleUiRequest({ action: 'setLimit', payload: { userId: '9001', limit: 100000, name: '甲' } });
  click($('qg-refresh'));
  await waitFor(() => !!findPerson('9001'), '甲出现在今日列表');
  click(findPerson('9001'));
  await waitFor(() => $('qg-detail-body').hidden === false, '详情渲染');
  ok('详情里有「累计」一格', $('qg-detail-body').textContent.includes('累计'));
  ok('显示了累计数值', $('qg-detail-body').textContent.includes('4.0k'));
  ok('显示了名次', /第 \d+ 名/.test($('qg-detail-body').textContent));
}

console.log('\n── 33. 重新统计 ──');
{
  click(doc.querySelector('[data-page="total"]'));
  await waitFor(() => $('qg-page-total').hidden === false, '排行榜页');
  click($('qg-cum-rebuild'));
  await waitFor(() => !$('qg-confirm').hidden, '确认框');
  ok('重建前先确认（不静默动数据）', $('qg-confirm-title').textContent.includes('重新统计'));
  click($('qg-confirm-ok'));
  await waitFor(() => (window.__qgDebug.board() || {}).totals?.tokens === 7500, '重建完成');
  t('重建后数字依然正确（没有重复累加）', window.__qgDebug.board().totals.tokens, 7500);
}

console.log('\n── 34. 当日账本为空时，今日用量用会话存档兜底 ──');
{
  // 场景：插件是后装的，今天的会话全发生在装它之前 → ledger.json 是空的，
  // 但会话存档里明明记着今天花了多少。不兜底的话界面上今日用量会显示 0。
  const SESS = path.join(TMP, 'sessions');
  const now = Date.now();
  for (const f of fs.readdirSync(SESS)) fs.unlinkSync(path.join(SESS, f));
  fs.rmSync(path.join(TMP, 'quota-guard'), { recursive: true, force: true });
  const msg = (id, n) => ({ id: Math.random(), senderId: String(id), senderName: n, text: 'x' });
  fs.writeFileSync(path.join(SESS, 'today1.json'), JSON.stringify({
    id: 'today1', chatKey: 'group:1', startedAt: now,
    usage: { totalTokens: 6000, calls: 1 }, trigger: [msg(9101, '甲'), msg(9101, '甲'), msg(9102, '乙')]
  }), 'utf8');
  fs.writeFileSync(path.join(SESS, 'today2.json'), JSON.stringify({
    id: 'today2', chatKey: 'group:1', startedAt: now,
    usage: { totalTokens: 2000, calls: 1 }, trigger: [msg(9102, '乙')]
  }), 'utf8');

  // ⚠️ 必须重载模块：删文件只能清磁盘，插件内存里还缓存着旧账本
  //    （它会认为"今天已经有账本了"，于是不启用兜底 —— 实测踩过这个坑）。
  const fresh = await import(QG_SPEC + '?t=' + Date.now());
  let b = await fresh.handleUiRequest({ action: 'cumulative' });
  for (let i = 0; i < 60 && (b.board.scan.running || b.board.scan.partial); i++) {
    await new Promise((r) => setTimeout(r, 100));
    b = await fresh.handleUiRequest({ action: 'cumulative' });
  }
  t('今日来源标记为 sessions（补算）', b.board.todaySource, 'sessions');
  t('今日合计 = 8000', b.board.todayTotal, 8000);
  t('甲今日 = 4000（6000 的 2/3）', b.board.rows.find((r) => r.userId === '9101').usedToday, 4000);
  t('乙今日 = 4000（6000 的 1/3 + 2000）', b.board.rows.find((r) => r.userId === '9102').usedToday, 4000);

  await fresh.handleUiRequest({ action: 'setLimit', payload: { userId: '9101', limit: 100000 } });
  const st = await fresh.handleUiRequest({ action: 'state' });
  t('state 也标记为 sessions', st.todaySource, 'sessions');
  t('state 的今日合计 = 8000', st.todayTotal, 8000);
  const rowA = st.rows.find((r) => r.userId === '9101');
  t('甲在当日视图里的用量也是 4000', rowA.used, 4000);
  ok('甲的进度有值（额度 > 0 时算得出百分比）', rowA.limit > 0 && rowA.percent > 0);
  ok('列表里没有凭空的 0 用量陌生人', st.rows.every((r) => r.used > 0 || r.hasOwnQuota));

  // 界面上要如实提示"这是补算的"，不能让人以为插件一直在记账
  const realTarget = bridgeTarget;
  bridgeTarget = fresh;
  try {
    click($('qg-refresh'));
    await waitFor(() => $('qg-today-source').hidden === false, '补算提示出现');
    ok('页面上给出了"历史补算"的提示', $('qg-today-source').textContent.includes('补算'));
    ok('今日合计显示在页面上', $('qg-total').textContent.includes('8.0k'));
  } finally {
    bridgeTarget = realTarget;
  }
}

console.log('\n── 35. 当日账本一旦有数据，就以它为准 ──');
{
  const L = path.join(TMP, 'quota-guard', 'ledger.json');
  const resetHour = cfgMod.getConfig().skills['quota-guard'].resetHour;
  const sh = new Date(Date.now() - resetHour * 3600 * 1000);
  const dk = sh.getFullYear() + '-' + String(sh.getMonth() + 1).padStart(2, '0') + '-' + String(sh.getDate()).padStart(2, '0');
  fs.mkdirSync(path.dirname(L), { recursive: true });
  fs.writeFileSync(L, JSON.stringify({
    version: 1,
    users: { 9101: { dayKey: dk, used: 777, name: '甲', updatedAt: Date.now() } },
    totals: { [dk]: 777 }, blocked: {}
  }), 'utf8');
  const fresh2 = await import(QG_SPEC + '?t=' + Date.now());     // 重载以读到新账本
  const st = await fresh2.handleUiRequest({ action: 'state' });
  // 账本里只有 9101，9102 只在会话存档里 —— 这正是"插件中途开始记账"的真实形态。
  // 规则：有实时记账的人按账本，没有的人按存档兜底。**不能整天切到只认账本**，
  // 否则 9102 会凭空归零（那正是"只重置了甲、乙也归零"的同一个坑）。
  t('有账本时来源标记为 ledger（账本那份是权威）', st.todaySource, 'ledger');
  t('有账本的人以账本为准（9101 = 777，而不是补算的 4000）', st.rows.find((r) => r.userId === '9101').used, 777);
  t('没账本的人仍用存档兜底（9102 = 4000）', st.rows.find((r) => r.userId === '9102').used, 4000);
  t('今日合计 = 777 + 4000', Number(st.todayTotal), 4777);
}

console.log('\n── 35b. 今日用量与可用额度分开显示 ──');
{
  await qg.handleUiRequest({ action: 'setLimit', payload: { userId: '9101', limit: 100000 } });
  click($('qg-refresh'));
  await waitFor(() => !!$('qg-list').querySelector('[data-pick="9101"]'), '甲进列表');
  click($('qg-list').querySelector('[data-pick="9101"]'));
  await waitFor(() => $('qg-detail-body').hidden === false, '详情渲染');

  const blocks = [...$('qg-detail-body').querySelectorAll('.qg-qblock')];
  t('渲染出两块（用量 / 可用额度）', blocks.length, 2);
  t('第一块标题是「今日用量」', blocks[0].querySelector('.qg-qblock-label').textContent.trim(), '今日用量');
  t('第二块标题是「当前余额」', blocks[1].querySelector('.qg-qblock-label').textContent.trim(), '当前余额');

  // ⚠️ 必须用**页面自己正在渲染的那份数据**（__qgDebug.data），
  //    不能另发一次 state 请求 —— 两次读之间数据可能就变了，断言会随机失败。
  const st = window.__qgDebug.data();
  const row = st.rows.find((r) => r.userId === '9101');
  t('用量块的数值 = 今日用量（spent）', blocks[0].querySelector('.qg-qblock-value').textContent.trim(), fmtKx(row.spent));
  t('余额块的数值 = 当前余额（额度 - used）', blocks[1].querySelector('.qg-qblock-value').textContent.trim(), fmtKx(row.remaining));
  ok('用量块里**没有**余额字样（两块语义不混）',
    !/当前余额/.test(blocks[0].textContent));
  ok('余额块里注明了总额度', blocks[1].textContent.includes(fmtKx(row.limit)));
  ok('用量块注明重置余额不影响它', blocks[0].textContent.includes('重置余额不影响它'));
  ok('余额块与用量块各有各的标题（语义分明）',
    blocks[0].querySelector('.qg-qblock-label').textContent.trim() === '今日用量'
    && blocks[1].querySelector('.qg-qblock-label').textContent.trim() === '当前余额');
  ok('可用块里有进度条', !!blocks[1].querySelector('.qg-bar-lg'));
  t('超额的块会带警示样式（这个人没超额）', blocks[1].classList.contains('is-over'), false);
}

console.log('\n── 35c. 不限额的人：可用额度写「不限额」，不编造数字 ──');
{
  await qg.handleUiRequest({ action: 'setLimit', payload: { userId: '9102', limit: 0 } });
  click($('qg-refresh'));
  await waitFor(() => !!$('qg-list').querySelector('[data-pick="9102"]'), '乙进列表');
  click($('qg-list').querySelector('[data-pick="9102"]'));
  await waitFor(() => $('qg-detail-body').hidden === false, '详情');
  const blocks = [...$('qg-detail-body').querySelectorAll('.qg-qblock')];
  t('仍是两块', blocks.length, 2);
  t('余额块写「不限额」', blocks[1].querySelector('.qg-qblock-value').textContent.trim(), '不限额');
  ok('不限额时不画进度条', !blocks[1].querySelector('.qg-bar-lg'));
  ok('用量块照常有值', blocks[0].querySelector('.qg-qblock-value').textContent.trim().length > 0);
}

console.log('\n── 35d. 进度条：用过就该看得见（比例极小时不能是空的）──');
{
  // 额度给得极大 → 比例接近 0%（如 2.1M / 10000M = 0.02%），取整后是 0。
  // 这时进度条若照 0% 画就是**整条空的**，与旁边写着的用量自相矛盾。
  await qg.handleUiRequest({ action: 'setLimit', payload: { userId: '9101', limit: 10000000000 } });
  click($('qg-refresh'));
  await waitFor(() => !!$('qg-list').querySelector('[data-pick="9101"]'), '甲进列表');
  click($('qg-list').querySelector('[data-pick="9101"]'));
  await waitFor(() => $('qg-detail-body').hidden === false, '详情');

  const d = window.__qgDebug.data();
  const row = d.rows.find((r) => r.userId === '9101');
  ok('前提：这个人今天确实用过（否则测不到）', row.used > 0);

  const bar = $('qg-detail-body').querySelector('.qg-qblock.is-over .qg-bar-lg i')
    || $('qg-detail-body').querySelectorAll('.qg-qblock')[1].querySelector('.qg-bar-lg i');
  ok('有进度条', !!bar);
  const w = parseFloat((bar.getAttribute('style') || '').match(/width:\s*([\d.]+)%/)?.[1] ?? '0');
  ok('用过之后进度条宽度不为 0（否则看着像完全没用）', w > 0);
  ok('但也不会被撑成满格（不能假装用满了）', w <= 100);

  const shown = $('qg-detail-body').querySelectorAll('.qg-qblock')[1].querySelector('.qg-qblock-sub').textContent;
  ok('同时如实给出「已用 x%」', /已用\s*[\d.]+%/.test(shown));

  // 列表行的迷你进度条同理
  const mini = $('qg-list').querySelector('[data-pick="9101"]').querySelector('.qg-mini i');
  if (mini) {
    const mw = parseFloat((mini.getAttribute('style') || '').match(/width:\s*([\d.]+)%/)?.[1] ?? '0');
    ok('列表里的迷你进度条也不为 0', mw > 0);
  }
  await qg.handleUiRequest({ action: 'setLimit', payload: { userId: '9101', limit: 100000 } });
}

console.log('\n── 36. 重置按钮（界面路径）：只动他一个人、只动今天 ──');
{
  const dbg = window.__qgDebug;
  // 让甲、乙走"实时记账"路径进账本（最接近真实使用）
  await qg.handleUiRequest({ action: 'setLimit', payload: { userId: '9101', limit: 100000 } });
  await qg.handleUiRequest({ action: 'setLimit', payload: { userId: '9102', limit: 100000 } });
  const api = { config: () => ({}), log: () => {}, isSkillActive: () => true };
  const m = (id, n) => ({ id: Math.random(), senderId: String(id), senderName: n, text: 'x' });
  qg.hooks['before-context']({ ...api, chatKey: 'group:1', sessionId: 'ui1', triggerEntries: [m(9101, '甲'), m(9101, '甲'), m(9102, '乙')] });
  qg.hooks['after-response']({
    ...api,
    session: { id: 'ui1', chatKey: 'group:1', usage: { totalTokens: 3000, calls: 1 } },
    response: { usage: { total_tokens: 3000 } }
  });

  click($('qg-refresh'));
  await waitFor(() => !!$('qg-list').querySelector('[data-pick="9101"]'), '甲进列表');
  click($('qg-list').querySelector('[data-pick="9101"]'));
  await waitFor(() => $('qg-detail-body').hidden === false, '详情');
  ok('详情里有「清零今天的用量」按钮', $('qg-detail-body').textContent.includes('清零今天的用量'));

  // ⚠️ 基准必须**直接问插件**，不能用页面上的 board —— 页面可能还没加载过榜单，
  //    那样基准会取到 0（实测踩过，导致"总消耗没变"这条误报）。

  const before = await cumSettled();
  const beforeA = (await qg.handleUiRequest({ action: 'state' })).rows.find((r) => r.userId === '9101').used;
  ok('基准有效（甲今日有量）', beforeA > 0);

  const btn = [...$('qg-detail-body').querySelectorAll('button')].find((b) => /清零今天的用量/.test(b.textContent));
  ok('找到按钮', !!btn);
  click(btn);
  await tick();
  ok('清零按钮在详情里（点击即执行，不弹确认）', !!btn);

  // 等插件真的落盘
  await waitFor(async () => {
    const st = await qg.handleUiRequest({ action: 'state' });
    return (st.rows.find((r) => r.userId === '9101') || {}).used === 0;
  }, '甲今日归零');

  const st = await qg.handleUiRequest({ action: 'state' });
  t('甲今日归零', st.rows.find((r) => r.userId === '9101').used, 0);
  t('乙没被牵连', st.rows.find((r) => r.userId === '9102').used, 1000);
  t('★ 总消耗一点没变', await cumSettled(), before);
  const bdAfter = (await qg.handleUiRequest({ action: 'cumulative' })).board;
  const aAfter = bdAfter.rows.find((r) => r.userId === '9101');
  t('★ 甲的历史总消耗 > 0 且没被清零', aAfter.tokens > 0, true);

  // 刷新页面也不能自己长回来
  click($('qg-refresh'));
  await tick(); await tick();
  t('刷新后甲今日仍是 0', (await qg.handleUiRequest({ action: 'state' })).rows.find((r) => r.userId === '9101').used, 0);
}

console.log('\n── 37. 全局「清空今天所有人的用量」──');
{
  click($('qg-settings-toggle'));
  await tick();
  const btn = $('qg-resetall');
  ok('找到全局清空按钮', !!btn);
  const before = await cumSettled();

  click(btn);
  await waitFor(() => !$('qg-confirm').hidden, '全局确认框');
  click($('qg-confirm-ok'));
  await waitFor(async () => {
    const st = await qg.handleUiRequest({ action: 'state' });
    return Number(st.todayTotal) === 0;
  }, '全局归零');

  const st = await qg.handleUiRequest({ action: 'state' });
  t('今日合计归零', Number(st.todayTotal), 0);
  ok('所有人今日都是 0', st.rows.every((r) => !r.used));
  t('★ 总消耗依然没变', await cumSettled(), before);
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log('临时数据目录：' + TMP);
process.exit(fail ? 1 : 0);
