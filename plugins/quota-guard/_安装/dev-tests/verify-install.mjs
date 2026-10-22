/**
 * 用主程序自己的解压/加载逻辑验证这个包 —— 不再靠我的理解。
 *
 * 沙箱要**像真的安装目录**：插件里的相对导入是 ../../src/config.js，
 * 所以临时目录里必须有完整的 src/（模拟"已经装好的 QQ Agent"），
 * 然后**用包里的核心补丁覆盖**那两个文件。否则测的是沙箱缺文件，不是包的问题。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const APP = 'E:/dsqqbot/QQ Agent/resources/app';
const ZIP = 'E:/canifish/plugin-package/quota-guard-package.zip';
const u = (p) => 'file:///' + p.replace(/\\/g, '/').replace(/ /g, '%20');

let pass = 0, fail = 0;
const t = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};
const ok = (n, c) => t(n, !!c, true);

const zipMod = await import(u(APP + '/src/zip-install.js'));
const loader = await import(u(APP + '/src/plugin-loader.js'));
const buf = fs.readFileSync(ZIP);

// ── 搭一个"已经装好的 QQ Agent" ──
const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'qg-lab-'));
const res = path.join(lab, 'resources', 'app');
fs.mkdirSync(res, { recursive: true });
fs.cpSync(path.join(APP, 'src'), path.join(res, 'src'), {
  recursive: true,
  filter: (p) => !/[\\/](sender|orchestrator)\.js$/.test(p) && !/\.bak/.test(p)
});
fs.mkdirSync(path.join(res, 'plugins'), { recursive: true });
fs.mkdirSync(path.join(lab, 'data'), { recursive: true });
console.log('沙箱:', lab);
console.log('  复制主程序后 sender/orchestrator 应不存在:',
  ['sender.js', 'orchestrator.js'].every((n) => !fs.existsSync(path.join(res, 'src', n))) ? '✓' : '✗');

console.log('');
console.log('── ① 主程序的安装函数（把包解到 plugins/）──');
let name = '';
try {
  name = await zipMod.unzipToModuleDir(buf, { root: res, type: 'plugin', preferId: 'quota-guard' });
  ok('安装成功', true);
} catch (e) { ok('安装成功', false); console.log('     ' + e.message); }
t('★ 落地目录名 = quota-guard', name, 'quota-guard');

const dir = path.join(res, 'plugins', name);
ok('★ plugin.json 在模块根层', fs.existsSync(path.join(dir, 'plugin.json')));
ok('index.js 在根层', fs.existsSync(path.join(dir, 'index.js')));
ok('ui/index.html 在', fs.existsSync(path.join(dir, 'ui', 'index.html')));

console.log('');
console.log('── ② 按安装说明覆盖核心补丁 ──');
for (const f of ['sender.js', 'orchestrator.js']) {
  const src = path.join(dir, '_安装', 'core-patches', 'src', f);
  ok(`包里带上了 ${f}`, fs.existsSync(src));
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(res, 'src', f));
}
ok('★ 补丁已覆盖到 src/', ['sender.js', 'orchestrator.js'].every((n) => fs.existsSync(path.join(res, 'src', n))));

console.log('');
console.log('── ③ 真让主程序加载（loadPlugins）──');
{
  process.env.QQ_AGENT_DATA_DIR = path.join(lab, 'data');
  const out = await loader.loadPlugins({
    log: () => {},
    roots: { skills: path.join(res, 'skills'), plugins: path.join(res, 'plugins') }
  });
  const ids = out.loaded.map((r) => r.id);
  console.log('  主程序加载成功的插件:', JSON.stringify(ids));
  if (out.failed.length) console.log('  失败的:', JSON.stringify(out.failed.map((r) => ({ id: r.id, err: String(r.error || '').slice(0, 200) }))));
  ok('★★ 主程序加载成功（认出了这个插件）', ids.includes('quota-guard'));
  t('★ 只加载了一个（_安装/ 没被误认为插件）', ids.filter((x) => x === 'quota-guard').length, 1);
}

console.log('');
console.log('── ④ 加载后能真干活：从沙箱副本跑一轮拦截 ──');
{
  const qg = await import(u(path.join(dir, 'index.js')) + '?t=' + Date.now());
  ok('插件导出了 chat.quota-gate', typeof qg.providers['chat.quota-gate'] === 'function');
  const api = { config: () => ({}), log: () => {}, isSkillActive: () => true };
  const msg = (id, n) => ({ id: Math.random(), senderId: String(id), senderName: n, text: 'x' });
  const gate = qg.providers['chat.quota-gate'];
  await qg.handleUiRequest({ action: 'setLimit', payload: { userId: '9001', limit: 1000, name: '甲' } });
  let seq = 0;
  const run = (entries, perMsg = 500) => {
    seq++;
    const sid = 'x' + seq;
    const batch = entries.slice();
    qg.hooks['before-context']({ ...api, chatKey: 'group:1', sessionId: sid, triggerEntries: batch });
    const g = gate({ chatKey: 'group:1', sessionId: sid, triggerEntries: batch, willRespond: true, tier: 4, sendState: { ok: true } });
    const skipped = !!(g && g.skip);
    if (!skipped) {
      qg.hooks['after-response']({
        ...api, session: { id: sid, chatKey: 'group:1', usage: { totalTokens: perMsg * entries.length, calls: 1 } },
        response: { usage: { total_tokens: perMsg * entries.length } }
      });
    }
    return skipped;
  };
  t('未超额时放行', run([msg(9001, '甲')]), false);
  run([msg(9001, '甲')]);
  t('★ 灌满后整轮被拦（零消耗）', run([msg(9001, '甲')]), true);
  const row = (await qg.handleUiRequest({ action: 'state' })).rows.find((r) => r.userId === '9001');
  t('额度记到 1000（封顶）', row.used, 1000);
  t('今日用量也是 1000', row.spent, 1000);
}

console.log('');
console.log('── ⑤ 装完后 plugins/ 下只有 quota-guard 一个模块 ──');
{
  const mods = fs.readdirSync(path.join(res, 'plugins'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  t('plugins/ 里的模块', mods, ['quota-guard']);
}

fs.rmSync(lab, { recursive: true, force: true });
console.log('');
console.log(`合计 ${pass} 项通过，${fail} 项失败`);
process.exit(fail ? 1 : 0);
