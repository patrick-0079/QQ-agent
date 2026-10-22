// 体检报告 · 集成测试（不联网）
//
// 用**合成的当日日志**驱动，验证：结构化运行行的聚合、报错计数、崩溃文件识别、
// 看门狗重启统计、以及"一天一个文件、每次追加一节"的落盘形式。
// 跑法：node plugins/health-report/integration-test.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'health-itest-'));
const LOGS = path.join(TMP, 'logs');
fs.mkdirSync(LOGS, { recursive: true });

let pass = 0;
let fail = 0;
const check = (n, c, d = '') => { if (c) { pass += 1; console.log(`  ✓ ${n}`); } else { fail += 1; console.log(`  ✗ ${n}${d ? ` —— ${d}` : ''}`); } };

// 造一份"当日日志"：3 次运行（2 done、1 noreply）+ 2 条报错
const today = new Date().toISOString().slice(0, 10);
const logFile = path.join(LOGS, `qq-agent-${today}.log`);
fs.writeFileSync(logFile, [
  '09:00:01 [INFO ] [app] 启动完成',
  '09:01:00 [INFO ] [session] 运行结束 status=done chat=group:1 轮次=2 发出=1 工具=3(失败1) 搜索=1 用时=40s 原因=本批已交付完毕',
  '09:05:00 [INFO ] [session] 运行结束 status=done chat=private:2 轮次=1 发出=2 工具=1 搜索=0 用时=20s 原因=本地收尾策略判定：本批已交付完毕',
  '09:09:00 [INFO ] [session] 运行结束 status=noreply chat=group:1 轮次=1 发出=0 工具=0 搜索=0 用时=5s 原因=模型判断无需回复',
  '09:10:00 [INFO ] [app] [skill] ❌ 某插件：清单解析失败',
  '09:11:00 [ERROR] [app] 模型接口 500',
  '09:12:00 [INFO ] [app] 正常运行中'
].join('\n'), 'utf8');

// 看门狗状态（近 24h 内 2 次重启 + 1 次很久以前）
fs.writeFileSync(path.join(TMP, 'guardian-watchdog-state.json'),
  JSON.stringify({ updatedAt: Date.now(), restarts: [Date.now() - 3600_000, Date.now() - 7200_000, Date.now() - 30 * 86400_000] }), 'utf8');

// 崩溃现场
fs.writeFileSync(path.join(LOGS, 'crash.log'),
  `\n[${new Date().toISOString()}] uncaughtException\nError: 测试用崩溃\n    at test (x.js:1:1)\n`, 'utf8');

const mod = await import(pathToFileURL(path.join(HERE, 'index.js')).href);
const IT = mod.__internals;
IT.setDataDir(TMP);
IT.setConfig(() => ({ enabled: true, intervalHours: 6, startDelaySec: 5, keepDays: 30 }));
await mod.setup({ config: () => ({ enabled: true }), log: () => {}, warn: () => {}, dataDir: TMP });

console.log('\n① 当日运行聚合（吃结构化日志行，不碰会话 JSON）');
const r = IT.buildReport();
check('识别出 3 次运行', r.today.runs === 3, String(r.today.runs));
check('结果分布正确（done 2 / noreply 1）', r.today.byStatus.done === 2 && r.today.byStatus.noreply === 1, JSON.stringify(r.today.byStatus));
check('平均轮次正确（(2+1+1)/3≈1.3）', Math.abs(r.today.avgRounds - 1.3) < 0.15, String(r.today.avgRounds));
check('平均工具数正确（(3+1+0)/3≈1.3）', Math.abs(r.today.avgTools - 1.3) < 0.15, String(r.today.avgTools));
check('发出总数正确（1+2+0=3）', r.today.totalSent === 3, String(r.today.totalSent));
check('报错计数（❌ + [ERROR = 2）', r.today.errors === 2, String(r.today.errors));

console.log('\n② 崩溃与自愈');
check('识别崩溃文件、类型与首行堆栈', r.today.crash?.entries === 1 && r.today.crash.kind === 'uncaughtException' && /Error: 测试用崩溃/.test(r.today.crash.tail || ''), JSON.stringify(r.today.crash));
check('报告里写明崩溃类型与堆栈首行', /uncaughtException：Error: 测试用崩溃/.test(r.md), '未写进表格');
check('近 24h 重启次数（3 条里只有 2 条在窗口内）', r.wd.restarts24h === 2, String(r.wd.restarts24h));

console.log('\n③ 内存与汇总');
check('内存有实际数字', r.mem.rssMB > 0 && r.mem.heapUsedMB > 0, JSON.stringify(r.mem));
check('汇总行包含关键项', /今日运行 3 次/.test(r.summary) && /近 24h 自动重启 2 次/.test(r.summary), r.summary);
check('报告 Markdown 有表格与各节', /## \d\d:\d\d 体检/.test(r.md) && /\| 扩展 \|/.test(r.md) && /\| 今日运行 \|/.test(r.md));

console.log('\n④ 落盘形式（一天一个文件、每次追加一节）');
const saved = IT.saveReport(r.md);
const saved2 = IT.saveReport(IT.buildReport().md);
check('报告写到 data/reports/health-<日期>.md', /health-\d{4}-\d{2}-\d{2}\.md$/.test(saved) && fs.existsSync(saved), saved);
check('同一天两次 → 同一个文件、两节内容', saved === saved2 && (fs.readFileSync(saved, 'utf8').match(/## \d\d:\d\d 体检/g) || []).length === 2);
check('文件头只写一次', (fs.readFileSync(saved, 'utf8').match(/# QQ Agent 体检报告/g) || []).length === 1);

console.log('\n⑤ 停用与防泄漏');
IT.setConfig(() => ({ enabled: false }));
check('停用后 summary 仍可生成（不影响读取，只是不再定时）', typeof IT.buildReport().summary === 'string');
IT.setConfig(() => ({ enabled: true }));
check('定时器句柄被登记（卸载时能清掉，不会每次热重载多一个）', globalThis.__healthReportTimer !== undefined);
mod.deactivate();
check('deactivate 后句柄已清空', globalThis.__healthReportTimer === null);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
process.exit(fail ? 1 : 0);
