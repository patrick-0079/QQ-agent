// 换硬件 / 换电脑后的自检工具（纯 Node 采集版）。
//
//   node tools/doctor.mjs
//
// 它跑一次真实采集，逐项告诉你在**这台**机器上什么能拿到、什么拿不到，
// 以及拿不到时卡片会怎么表现（会退回还是留空），方便你不用问人也能定位问题。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.dirname(here);
const skill = path.join(skillDir, 'index.js');

let bad = 0;
const line = (okFlag, label, extra = '') => {
  if (!okFlag) bad++;
  console.log(`${okFlag ? '  [OK]  ' : '  [!!]  '}${label}${extra ? ' — ' + extra : ''}`);
};

console.log('=== 电脑状态技能 · 换机自检（纯 Node 采集）===');
console.log('技能目录:', skillDir);
console.log('本机:', os.hostname(), '|', os.platform(), os.release(), '| Node', process.version);
console.log('');

console.log('1) 文件与采集通道');
line(fs.existsSync(skill), '技能入口 index.js 在位');
const bg = path.join(skillDir, 'assets', 'background.jpg');
line(fs.existsSync(bg), '背景图 assets/background.jpg 在位',
  fs.existsSync(bg) ? '' : '（没有也不影响出图，只是退回纯色卡片）');
line(true, '采集方式', 'Node + typeperf（性能计数器）/ reg（显卡名）/ node:os（内存、开机时长）/ fs.statfs（磁盘）');
line(true, '不依赖 PowerShell', '本技能不再调用 powershell.exe');

console.log('');
console.log('2) 采集实测');
let d = null;
try {
  const mod = await import(pathToFileURL(skill).href);
  const t0 = Date.now();
  d = await mod.__internals.collectSnapshot({ topN: 5, timeoutMs: 30000, wantGpu: true });
  console.log(`  （耗时 ${Date.now() - t0} ms）`);
} catch (e) {
  line(false, '采集可用', String(e && e.message).split('\n')[0]);
  console.log('\n结论：采集跑不起来，卡片会退回文字版。先把上面这条报错发出来。');
  process.exit(1);
}

line(Number(d.cpu.usedPct) >= 0, 'CPU 占用', `${d.cpu.usedPct}%（单核最高 ${d.cpu.coreMax}%）`);
line(Number(d.cpu.coreCount) > 0, 'CPU 每核数据', `${d.cpu.coreCount} 个逻辑处理器`);
line(!!d.cpu.name, 'CPU 型号', String(d.cpu.name).slice(0, 60));
line(Number(d.mem.totalMB) > 0, '内存', `${(d.mem.totalMB / 1024).toFixed(1)} GB（已用 ${d.mem.usedPct}%）`);
line(!!d.os, '系统版本', `${d.os || '?'} ${d.osBuild || ''}`);
line(d.disks.length > 0, '硬盘',
  d.disks.length ? d.disks.map((x) => `${x.id} ${x.freeGB}/${x.sizeGB}GB`).join('  ') : '一块都没读到');
line(true, '硬盘型号', '未采集（纯 Node 拿不到物理盘型号；不影响其余功能）');
const gpus = Array.isArray(d.gpus) ? d.gpus : [];
line(gpus.length > 0, '显卡型号', gpus.map((g) => g.n).join(' | ') || '无');
const withUsage = gpus.filter((g) => Number(g.usedPct) >= 0);
line(withUsage.length > 0, '显卡占用（需系统支持 GPU 引擎计数器）',
  withUsage.length ? `${withUsage[0].usedPct}%（挂在 ${withUsage[0].n}）` : '拿不到：勾了「显示显卡占用」也只会显示"未取到"');
const physical = gpus.filter((g) => !g.virtual);
line(physical.length > 0, '识别出物理显卡（决定占用挂在哪一行）',
  physical.length ? physical.map((g) => g.n).join(' | ') : '只看到虚拟适配器');
line(Number(d.procs.total) > 0, '进程快照', `${d.procs.total} 个进程`);
line(Array.isArray(d.procs.top) && d.procs.top.length > 0, '内存占用排行',
  Array.isArray(d.procs.top) && d.procs.top[0] ? `第一名 ${d.procs.top[0].n} ${d.procs.top[0].memMB} MB` : '无');
line(!!d.qqagent, 'QQ Agent 自身进程',
  d.qqagent ? `${d.qqagent.memMB} MB · ${d.qqagent.count} 个进程 · 已运行 ${((Date.now() - d.qqagent.start) / 86400000).toFixed(2)} 天`
    : '没找到名为「QQ Agent」的进程（机器人没在运行时会这样，卡片会写"没找到"）');
line(Number(d.uptimeSec) > 0, '开机时长', `${(d.uptimeSec / 3600).toFixed(1)} 小时`);

console.log('');
console.log('3) 画卡片这条路');
try {
  const mod = await import(pathToFileURL(skill).href);
  const el = await mod.__internals.electronModule();
  // ⚠️ 这一项在命令行里**永远**拿不到（Electron 只注入应用自己的进程），
  //    所以只作说明、不计入失败数 —— 否则每次自检都报"有异常"，反而误导。
  console.log(`  [说明] 能否拿到 Electron（画图与背景图裁切必需） — ${el ? '可以' : '命令行里拿不到，这是正常的'}`);
  console.log('         判断画图是否可用，请看 QQ Agent 控制台的日志（会打印"状态卡片已发出"或失败原因）。');
} catch (e) {
  line(false, '技能模块可加载', String(e && e.message).split('\n')[0]);
}

console.log('');
console.log(bad === 0
  ? '结论：本机全部能力可用。'
  : `结论：有 ${bad} 项拿不到/异常 —— 上面带 [!!] 的都写清了卡片会怎么降级（多数只是少显示一项，不影响出图）。`);
