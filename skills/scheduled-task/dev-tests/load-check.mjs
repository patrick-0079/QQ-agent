// 在某个 QQ-Agent 安装上验一遍「这个技能到底能不能被它的加载器吃下去」。
//
//   node skills/scheduled-task/dev-tests/load-check.mjs "E:\Tools\QQ-Agent-整合版-20260922"
//   node skills/scheduled-task/dev-tests/load-check.mjs "E:\Tools\QQ Agent-0.4.0-bugfix\resources\app"
//
// 干的事：把技能复制到一个临时目录当 skills 根，调那个版本的 plugin-loader 加载，
// 检查 id / 工具 / 清单校验有没有过。**不动目标安装的任何文件**（数据目录也指到临时目录）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hostPatchStatus, applyHostPatch, revertHostPatch } from '../host-patch.mjs';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = path.resolve(process.argv[2] || '');

if (!appRoot || !fs.existsSync(path.join(appRoot, 'src', 'plugin-loader.js'))) {
  console.error('用法：node dev-tests/load-check.mjs <应用根目录>（含 src/plugin-loader.js 的那一层）');
  process.exit(2);
}

const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-task-load-'));
const skillsRoot = path.join(staging, 'skills');
const pluginsRoot = path.join(staging, 'plugins');
fs.mkdirSync(skillsRoot, { recursive: true });
fs.mkdirSync(pluginsRoot, { recursive: true });
fs.cpSync(SKILL_DIR, path.join(skillsRoot, 'scheduled-task'), {
  recursive: true,
  filter: (src) => !/\.(host-patch\.json|restart-pending)$/.test(src)
});

// 别让这次检查往目标安装的数据目录里写东西
process.env.QQ_AGENT_DATA_DIR = path.join(staging, 'data');

const { loadPlugins } = await import(pathToFileURL(path.join(appRoot, 'src', 'plugin-loader.js')).href);
const result = await loadPlugins({ log: (...a) => console.log('   [loader]', ...a), roots: { skills: skillsRoot, plugins: pluginsRoot } });

const loaded = (result?.loaded || []).map((r) => r.id);
const failed = (result?.failed || []).map((r) => `${r.id}：${r.error || r.problems?.join('；') || '未知原因'}`);

console.log(`\n应用：${appRoot}`);
console.log(`加载成功：${loaded.join('、') || '（无）'}`);
console.log(`加载失败：${failed.join('；') || '（无）'}`);

const { skillManager } = await import(pathToFileURL(path.join(appRoot, 'src', 'skills', 'manager.js')).href);
const status = skillManager.registry.list().map((s) => ({
  id: s.manifest.id,
  name: s.manifest.name,
  tools: Array.isArray(s.manifest.tools) ? s.manifest.tools.map((t) => t.id) : []
}));
console.log('注册表：', JSON.stringify(status));

const { listTools } = await import(pathToFileURL(path.join(appRoot, 'src', 'tool-registry.js')).href);
const mine = listTools().map((t) => t.id).filter((id) => id.startsWith('scheduled-task__'));
console.log('注册进来的工具：', mine.join('、') || '（无）');

// ── 热补丁演练 ────────────────────────────────────────────────────────────
// 只在一个临时副本上打/摘，目标安装的 src/app.js 一个字节都不动。
// 打不上不算致命：那是"这个宿主已经原生给句柄，或者结构差别太大"，会退化成发文本。
let patchVerdict = '不需要（这个版本自己就把核心实例交给技能）';
const realApp = path.join(appRoot, 'src', 'app.js');
if (fs.existsSync(realApp)) {
  const patchRoot = path.join(staging, 'patch-root');
  fs.mkdirSync(path.join(patchRoot, 'src'), { recursive: true });
  const probeFile = path.join(patchRoot, 'src', 'app.js');
  const original = fs.readFileSync(realApp, 'utf8');
  fs.writeFileSync(probeFile, original, 'utf8');

  const st = hostPatchStatus({ root: patchRoot });
  if (!st.supported) {
    patchVerdict = /没有找到/.test(String(st.reason || ''))
      ? '不需要（这个版本自己就把核心实例交给技能）'
      : `打不了：${st.reason || st.conflict}`;
  } else {
    const applied = applyHostPatch({ root: patchRoot });
    if (!applied.ok) {
      patchVerdict = `打不了：${applied.conflict}`;
    } else {
      const reverted = revertHostPatch({ root: patchRoot });
      const back = fs.readFileSync(probeFile, 'utf8');
      const same = back === original;
      patchVerdict = `可以打（写盘前过了 node --check；摘除后${same ? '逐字节还原' : '与原文件不一致 —— 这是 bug'}）`;
      if (!same || !reverted.reverted) process.exitCode = 1;
    }
  }
}
console.log(`热补丁：${patchVerdict}`);

fs.rmSync(staging, { recursive: true, force: true });

const okAll = loaded.includes('scheduled-task') && mine.length === 3 && failed.length === 0;
console.log(okAll ? '\n结论：这个版本能正常加载。' : '\n结论：有问题，看上面的输出。');
process.exitCode = okAll ? 0 : (process.exitCode || 1);
