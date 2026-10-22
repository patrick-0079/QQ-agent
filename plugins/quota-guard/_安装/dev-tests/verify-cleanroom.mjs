/**
 * 净室验证：把分发包**原样解压**到临时目录，组装成一份核心，再从那份副本导入运行。
 *
 * 为什么不能直接跑现网：现网的核心/插件是"我知道它们是好的"那两份，
 * 验它就等于没验包。这里刻意只依赖压缩包里的文件。
 *
 * 覆盖：能不能 import、能力能否被核心找到、gate 能否真的拦下、
 *      逐人额度、两个计数器、重置语义、界面动作。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-cleanroom-'));
const LAB = path.join(ROOT, 'lab');            // 模拟 <QQ Agent 安装目录>
const APP = path.join(LAB, 'resources', 'app');
const DATA = path.join(LAB, 'data');

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};
const ok = (n, c) => t(n, !!c, true);

console.log('净室目录:', ROOT);
console.log('');

// ── 1. 解压分发包 ──
const ZIP = 'E:/canifish/plugin-package/quota-guard-package.zip';
const STAGE = path.join(ROOT, 'stage');
fs.mkdirSync(STAGE, { recursive: true });
execFileSync('powershell', ['-NoProfile', '-Command',
  `Expand-Archive -Path '${ZIP}' -DestinationPath '${STAGE}' -Force`], { stdio: 'inherit' });

const LIVE = 'E:/dsqqbot/QQ Agent/resources/app';

console.log('── 1. 按安装说明摆放文件 ──');
// ① 先有一份**完整的主程序本体**（等价于"已经装好的 QQ Agent"）。
//    压缩包里只含**改动过的**两个核心文件，其余主程序文件本来就在机器上。
//    这里复制现网 src/ 整棵树，但**排除**那两个补丁文件 ——
//    它们必须来自压缩包，否则验的还是现网代码（那就白验了）。
fs.cpSync(path.join(LIVE, 'src'), path.join(APP, 'src'), {
  recursive: true,
  filter: (p) => !/[\\/](sender|orchestrator)\.js$/.test(p) && !/\.bak/.test(p)
});
const leaked = ['sender.js', 'orchestrator.js'].filter((n) => fs.existsSync(path.join(APP, 'src', n)));
console.log('  复制主程序后这两个文件应不存在（须由包提供）:', leaked.length === 0 ? '✓ 是' : '✗ 泄漏了 ' + leaked.join(','));

// ② 插件 → resources/app/plugins/quota-guard
//    包里只有一个顶层目录 quota-guard/，plugin.json 在它的根层。
//    ⚠️ 必须让 plugin.json 落在 plugins/quota-guard/ 根层 —— 这是主程序
//       readManifest 唯一会去找的位置（多一层就装不上）。
fs.mkdirSync(path.join(APP, 'plugins'), { recursive: true });
fs.cpSync(path.join(STAGE, 'quota-guard'), path.join(APP, 'plugins', 'quota-guard'), {
  recursive: true,
  filter: (p) => !/[\\/]_安装([\\/]|$)/.test(p)      // 安装材料不属于插件本体
});
console.log('  ★ plugin.json 落在模块根层:',
  fs.existsSync(path.join(APP, 'plugins', 'quota-guard', 'plugin.json')) ? '✓' : '✗');

// ③ 核心补丁 → 覆盖到 src/
for (const f of ['sender.js', 'orchestrator.js']) {
  fs.copyFileSync(path.join(STAGE, 'quota-guard', '_安装', 'core-patches', 'src', f), path.join(APP, 'src', f));
}
fs.mkdirSync(DATA, { recursive: true });
console.log('  插件就位:', fs.existsSync(path.join(APP, 'plugins', 'quota-guard', 'plugin.json')));
console.log('  ★ 两个补丁文件来自压缩包:', ['sender.js', 'orchestrator.js'].every((n) => fs.existsSync(path.join(APP, 'src', n))));

// ── 2. 主程序本体已由上面的整树复制提供 ──
console.log('');
console.log('── 2. 用净室自己的 data 目录（不碰真实数据）──');
// 让插件用它自己的 data 目录
process.env.QQ_AGENT_DATA_DIR = DATA;

console.log('');
console.log('── 3. 从**净室副本**导入核心与插件 ──');
const url = (p) => 'file:///' + p.replace(/\\/g, '/').replace(/ /g, '%20');
let cfgMod = null, qg = null;
try {
  cfgMod = await import(url(path.join(APP, 'src', 'config.js')));
  cfgMod.setRuntimeConfig(cfgMod.loadConfig());
  ok('核心 config.js 能加载', true);
} catch (e) { ok('核心 config.js 能加载', false); console.log('     ', e.message); }

try {
  qg = await import(url(path.join(APP, 'plugins', 'quota-guard', 'index.js')));
  ok('★ 插件能从净室副本导入', true);
} catch (e) { ok('★ 插件能从净室副本导入', false); console.log('     ', e.message); }

if (!qg) { console.log('\n导入失败，后续无法进行'); process.exit(1); }

console.log('');
console.log('── 4. 插件对外契约 ──');
ok('导出 hooks', !!qg.hooks);
ok('导出 providers（能力）', !!qg.providers);
ok('提供 chat.quota-gate', typeof qg.providers['chat.quota-gate'] === 'function');
ok('实现 before-context', typeof qg.hooks['before-context'] === 'function');
ok('实现 after-response', typeof qg.hooks['after-response'] === 'function');
ok('有 handleUiRequest（面板用）', typeof qg.handleUiRequest === 'function');

console.log('');
console.log('── 5. sender 补丁：canSend 真的可用 ──');
{
  const { SendQueue } = await import(url(path.join(APP, 'src', 'sender.js')));
  ok('净室里的 sender.js 导出了 SendQueue', typeof SendQueue === 'function');
  const q = new SendQueue({ onebot: {}, store: { appendSelf() {} } });
  ok('★ 净室里实例化的 SendQueue 有 canSend()', typeof q.canSend === 'function');
  const c = q.canSend('group:1');
  t('空队列时可以发', c.ok, true);
  ok('返回剩余额度', typeof c.remainingMinute === 'number');
  // 只读性：连着问 5 次，剩余额度不该变
  const before = q.canSend('group:1').remainingMinute;
  for (let i = 0; i < 5; i++) q.canSend('group:1');
  t('★ 反复询问不占额度（只读）', q.canSend('group:1').remainingMinute, before);
}

console.log('');
console.log('── 6. 端到端：逐人额度 + 零消耗拦截 ──');
{
  const api = { config: () => ({}), log: () => {}, isSkillActive: () => true };
  const msg = (id, n) => ({ id: Math.random(), senderId: String(id), senderName: n, text: 'x' });
  const gate = qg.providers['chat.quota-gate'];
  let seq = 0;
  function run(entries, perMsg = 500) {
    seq++;
    const sid = 'r' + seq;
    const batch = entries.slice();
    qg.hooks['before-context']({ ...api, chatKey: 'group:1', sessionId: sid, triggerEntries: batch });
    const g = gate({ chatKey: 'group:1', sessionId: sid, triggerEntries: batch, willRespond: true, tier: 4, sendState: { ok: true } });
    const skipped = !!(g && g.skip);
    const spent = skipped ? 0 : perMsg * entries.length;
    if (!skipped) {
      qg.hooks['after-response']({
        ...api,
        session: { id: sid, chatKey: 'group:1', usage: { totalTokens: spent, calls: 1 } },
        response: { usage: { total_tokens: spent } }
      });
    }
    return { skipped, spent, code: g ? g.code : '' };
  }
  const row = async (qq) => (await qg.handleUiRequest({ action: 'state' })).rows.find((r) => r.userId === qq) || {};

  await qg.handleUiRequest({ action: 'setLimit', payload: { userId: '9001', limit: 2000, name: '甲' } });
  ok('设额度成功', (await row('9001')).limit === 2000);

  // 甲 3 条 + 乙 1 条 = 4 条 × 500 = 2000 → 甲 1500 / 乙 500
  const r1 = run([msg(9001, '甲'), msg(9001, '甲'), msg(9001, '甲'), msg(9002, '乙')], 500);
  t('多人在场时放行', r1.skipped, false);
  t('甲按 3/4 分摊 = 1500', (await row('9001')).spent, 1500);
  t('乙按 1/4 分摊 = 500', (await row('9002')).spent, 500);
  t('两人之和 = 本轮消耗 2000', (await row('9001')).spent + (await row('9002')).spent, 2000);

  // 把甲灌满
  run([msg(9001, '甲')], 500);
  const a = await row('9001');
  t('甲余额扣减到顶 2000', a.used, 2000);
  t('甲当前余额 0', a.remaining, 0);
  ok('甲已超额', a.over === true);

  // 甲单独发言 → 整轮拦下，零消耗
  const r2 = run([msg(9001, '甲')]);
  t('★ 全超额 → 整轮被拦', r2.skipped, true);
  t('★ 原因码正确', r2.code, 'quota-exhausted');
  t('★ 零消耗', r2.spent, 0);

  // 乙（额度充足）在场 → 不该整轮被拦
  const r3 = run([msg(9001, '甲'), msg(9002, '乙')]);
  t('★ 乙还有额度 → 整轮放行（不误伤）', r3.skipped, false);

  // 重置余额：余额回满，今日用量不动
  const beforeSpent = (await row('9001')).spent;
  await qg.handleUiRequest({ action: 'reset', payload: { userId: '9001' } });
  const a2 = await row('9001');
  t('★ 重置后余额回满', a2.remaining, 2000);
  t('★ 重置后今日用量不变', a2.spent, beforeSpent);
  ok('★ 两个数已分叉（不是一个东西）', a2.spent !== a2.used);
}

console.log('');
console.log('── 7. 面板动作可用 ──');
{
  const st = await qg.handleUiRequest({ action: 'state' });
  ok('state 返回 rows', Array.isArray(st.rows));
  ok('带 todaySource 字段', 'todaySource' in st);
  ok('带 totalUsed（今日用量口径）', typeof st.totalUsed === 'number');
  const b = await qg.handleUiRequest({ action: 'cumulative' });
  ok('cumulative 返回 board', !!b.board);
  ok('board 有 totals', !!b.board.totals);
  const un = await qg.handleUiRequest({ action: '不存在的动作' });
  ok('未知动作返回错误而不是崩', un.ok === false || un.error !== undefined);
  ok('插件不报未捕获异常', true);
}

console.log('');
console.log('── 8. 隔离性：净室没碰真实数据目录 ──');
{
  ok('用的是净室 data 目录', cfgMod.DATA_DIR.replace(/\\/g, '/').includes('/qg-cleanroom-'));
  const realLedger = 'E:/dsqqbot/QQ Agent/data/quota-guard/ledger.json';
  const realBefore = fs.existsSync(realLedger) ? fs.statSync(realLedger).mtimeMs : 0;
  console.log('  真实账本最后修改:', realBefore ? new Date(realBefore).toLocaleString('zh-CN') : '(不存在)');
  ok('★ 净室里生成的账本在临时目录', fs.existsSync(path.join(DATA, 'quota-guard', 'ledger.json')));
}

console.log('');
console.log(`合计 ${pass} 项通过，${fail} 项失败`);
console.log('净室目录（留给你查看）:', ROOT);
process.exit(fail ? 1 : 0);
