# mc-status 改动日志

> **规则**：每次改动本插件都在这里加一条，倒序（最新在最上面）。
> 每条要写清**改了什么**和**为什么** —— 只写"改了什么"的话，几个月后有人看到这段
> 奇怪的代码不敢删，也不知道删了会坏什么。
> 版本号同步 `plugin.json` 的 `version`；只改 bug 没加功能就动最后一位。

---

## 1.2.42 / 2026-10-02 / 给两个定时器补 `unref()`（漏了会把加载它的进程钉住）

### 改了什么

- `watchTimer`（播报轮询）与 `trendTimer`（曲线采集）创建后各补一行 `unref?.()`。
- 版本号 1.2.41 → **1.2.42**。

### 为什么

2026-10-02 做新插件 `steam-query` 时排查"`npm test` 跑不完"，
顺手把**所有带 `setInterval` 的插件**过了一遍，发现只有本插件和当时新建的
`steam-query` 没调 `unref` —— 其余 8 个（weather-card / reminder / budget-guard /
sticker-tagger / agent-task / conversation-memory / telemetry-guard / pc-control-l3）
都调了。

没有 `unref` 的定时器会**阻止 Node 进程自然退出**。凡是"加载完插件就该结束"的场景
（`test/skill-test.mjs` 会 import 并加载全部插件，`tools-skill-audit.mjs` 同理）
都会被它钉在事件循环里 —— 表现为测试跑完却久久不退出，**且不报任何错**，极难定位。

本插件一直没暴露，是因为两个 timer 都在 `watchMode` 有配置时才创建（默认关），
测试环境里通常不触发。但只要有人在测试环境开了播报，就会踩到同一个坑，
所以按统一写法补齐。

### 验证

`node --check plugins/mc-status/index.js` 通过；`npm test` 全绿。

---

## 1.2.41 / 2026-10-01 / 兜底钩子改挂 before-context（1.2.40 挂的 onMessage 在基础 0.4 里是死的）

### 改了什么
- **新增 `hooks['before-context']` 兜底**，与原有的 `onMessage` 并存：
  · `before-context`（基础 0.4 唯一支持的兜底路径）：命中 `\服务器`/`\服务器曲线` 时
    **取出工具直接执行**，拿不到 sender（工具走 `_directText` 回退），再把结果
    **改写进命中消息的 `hit.text`** 让模型照说（并强调多台服务器一行一台）。
  · `onMessage`（新版才有）：保留，能静默发卡片、不用麻烦模型。
- 指令映射 `MC_CMD_MAP`、`pat()`、`hitMcCommand()` 提到**模块级**，两条路径共用。
- 新增 `restOfCommand()`：解析指令词之后的剩余文本，当作 `name` 参数传给工具 ——
  与 `commandRoute` 的 `argFrom:"rest"` 对齐，兜底路径也能查「\服务器 mc.hypixel.net」。
- `MC_CMD_MAP` 给每项加 `direct` 标记：**日志（mc_server_log）与 rcon 不做
  before-context 兜底** —— 日志要么要参数、要么涉及主人权限、要么全文上千字（塞进消息
  会把上下文撑爆），rcon 凭空执行风险太高，都留给支持指令直达的新框架。

### 为什么
- 1.2.40 只挂了 `onMessage`。**放进基础 0.4 包实测才发现**基础包支持的钩子是
  `before-context / before-llm-messages / after-response / before-tool / after-tool`
  —— **没有 `onMessage`**，所以 1.2.40 的兜底在基础包里**一次都不会被调用**，
  表现就是"装了插件、`\服务器` 毫无反应且不报错"。
- `before-context` 基础包里一直都有，`ctx.triggerEntries` 能拿到触发消息；
  代价是拿不到 sender → 不能直接发卡片，只能回退文字卡再让模型转述（可接受）。

### 涉及
- `plugins/mc-status/index.js`（新增 before-context、抽映射、加 restOfCommand）
- 版本 `plugin.json` 1.2.40 → 1.2.41

### 验证
- `node scripts/base-pack-hook-test.mjs`：**在真实基础 0.4 包里**喂 `\服务器` →
  命中消息被改写成"还没配置服务器…"提示（6/6 通过）。
- `node scripts/legacy-compat-test.mjs`：新增对 `before-context` 的导出检查，全部通过。
- `node test/mc-status-test.mjs`：144/144 通过。

---

## 1.2.40 / 2026-09-30 / 老框架兼容兜底（无指令直达时用 onMessage 接管 \服务器 等只读指令）

### 改了什么
- 新增 `hooks.onMessage` 兜底：当框架**没有**「反斜杠指令门槛（commandOnly）」与
  「指令直达（commandRoute）」时，插件自己解析指令并执行对应逻辑。
  · 只读/发卡类（telemetry-guard / netease-song-id / ai-status / mc-status）：
    兜底时**从 `src/tool-registry.js` 取回本插件对应的工具直接 execute**，
    不把发图/发卡逻辑抄第二遍（避免两处实现漂移）。
  · 直接动作类（genshin-dl / mute-guard）：兜底时调用各自的处理函数。
- 框架依赖（`src/config.js`、`src/tool-registry.js`）改为**动态 import + try/catch**：
  老框架可能没有 `src/skills/config.js` 等后加模块，**静态 import 会让整个插件加载失败**
  （表现成"插件完全不出现"，最难查）。缺什么只让对应能力降级。
- mute-guard **只兜底 `\j`（禁言）**：解除本来就有 before-context 钩子兜着，
  若在 onMessage 里也处理，走模型路径的框架下会**双重回复**。
- mc-status **只兜底不需要额外参数的只读工具**；`mc_rcon_command`（要命令体）不在此列 ——
  凭空执行 rcon 风险太高，宁可让用户去用支持直达的新框架。

### 为什么
- 用户原话："**其他人电脑里不一定有反斜杠的指令接收还有指令直达之类的**"。
  这是真问题：`\指令` 依赖两个本项目特性，**别人的框架没有时指令发出去就是死的**，
  而插件能正常加载、不报任何错 —— 典型的"装了像没装"。
- 统计全项目：**10 个插件用了 commandRoute，此前只有 pc-control-l3 做了兜底**。

### 验证
- 本插件测试全过；语法检查通过。

## [1.2.39] - 2026-09-29

**修复：连不通的服务器会让「\服务器」查询永久卡住（实测卡 3 分钟以上、一个字都不回）**

- **改了什么**：`mcping.js` 的 `pingJava()` 增加一把**硬超时** `hardTimer` ——
  `setTimeout(() => finish(reject, new Error('连接超时')), timeout + 3000)`，
  并在 `finish()` 里 `clearTimeout(hardTimer)`。
- **为什么**：**Node 的 `sock.setTimeout()` 不覆盖连接建立阶段** —— 目标端口丢包时
  （典型：frp 隧道后端挂了 / 服务器维护中），连接停在 SYN_SENT，`'timeout'` 事件
  永远不触发，`sock.on('timeout', …)` 那条兜底形同虚设 → **这个 Promise 永远不 settle**。
  后果链：`pingJava` 不返回 → `pingServer`/`queryOne` 不返回 → 指令直达的
  `get_mc_status` 不返回 → 那条会话永远停在「进行中」，用户看到的就是发完指令毫无反应。
- **实测复现**（修前）：`pingJava('mc.example.com:25565', 25565, 5000)` 20 秒仍未 settle；
  隔离计时显示 `resolveSrv` 0.0s 正常（它自带超时），卡点确实在 socket 连接阶段。
- **验证**：修后 `pingJava(坏地址, 5000)` → **8.0s settle，报「连接超时」**；
  `pingServer(坏地址)` 同样 8.0s 返回；**回归** `pingJava('mc.hypixel.net', 25565, 5000)`
  → 0.8s 正常返回（online，20386/200000 人）→ 好路径没被影响。
  上限取 `timeout + 3000` 的理由：正常路径是「连接 → 状态包（≤timeout 无活动）→
  等 pong（≤min(2500, timeout)）」，留 3 秒余量足够。
- **涉及**：`mcping.js`、`plugin.json`（1.2.38 → 1.2.39）

## [1.2.38] - 2026-09-24

**修：UI「关一下再开」之后播报/曲线采集永久停摆**

- **改了什么**：activate() 里补上 startWatch() / startTrendCollect()；startWatch / startTrendCollect 开头加「已在跑就跳过」守卫（原来是先 stopWatch 再判断，现在改成 if (watchTimer) return）。
- **为什么**：控制台插件开关走 manager.activate/deactivate，**不重跑 setup**；而播报与曲线采集的定时器只在 setup 里起、deactivate 里停，activate 却不重启 —— 关一次再开，两个后台定时器就没了，直到重启机器人或热重载。守卫保证启动时 setup 先起过、reloadSkills 统一 activate 时不会重复预热（collectTick 是 force 查询，重复预热会多打一轮握手）。
- **验证**：`node test/mc-status-test.mjs` 144 通过 / 0 失败。


## [1.2.37] - 2026-09-24

**报错识别再补一刀：Cuberite 的插件错误写在 Warn 里（真机造错实测出来的）**

**改了什么**

1. `logtail.js` 新增 `looksLikeFailure()`：Warn 级别的行**按内容**二次判定，命中故障关键字
   （`LUA:` / `Error in plugin` / `Cannot call` / `Failed to` / `Exception` / `Lua error` / `error in`）
   才算报错。
2. `isStackTrace()` 扩展：认 Cuberite 的两种栈帧写法 —— `Stack trace:` / `Stack trace end`，
   以及「级别+时间戳**后缩进两格以上**」的栈帧行（`Warn [19:37:06]   [C](-1): error`）。
3. 块提取新增「**同一秒的 Warn 并入当前块**」：Cuberite 把一次插件错误拆成 7 条独立日志行，
   不合并的话 AI 拿到的是一堆碎片。⚠️ 只对 Warn 生效（Java 版的 ERROR 一行就是一次事件）。
4. 「没找到报错」的文案补上 Warn 故障关键字，免得用户以为工具瞎了。
5. 版本号 1.2.36 → 1.2.37。

**为什么**

在真机上真的造了一次错（`load` 一个 `Initialize()` 里 `error()` 的 Lua 插件），
Cuberite 打出来的是 **Warn**，不是 Err：

```
Warn [19:37:06] LUA: Plugins/QQAgentLogTest/QQAgentLogTest.lua:4: 故意抛出的 Lua 错误
Warn [19:37:06] Stack trace:
Warn [19:37:06]   [C](-1): error
...
Warn [19:37:06] Error in plugin QQAgentLogTest: Cannot call the Initialize() function.
```

1.2.36 只认 ERROR/Err → **服务器插件真崩了，工具照样回"没找到报错"**。
而 Warn 里又混着大量无害提示（`Cannot open file ... recipes.txt`、
`spawning in a non-existent chunk`），按级别一刀切会把真故障淹掉，所以按关键字挑。

**同日配套修正：HTTP 日志桥读错文件了**

- 原来读 `/home/lubuntu/cuberite/cuberite.log`（控制台 stdout 重定向）——实测**内容落后
  真实时间一小时以上**（Cuberite 的 file listener 才是实时追加的）。表现为"刚出的报错，
  工具说没有"。
- 改：给桥传 `logs` **目录**，每次请求挑 mtime 最新的 `LOG_<时间戳>.txt`
  （Cuberite 每次启动换文件名，填死路径第二天就失效）。`cuberite-log-bridge.py` 新增
  `resolve_log_path()`，systemd unit 的 `--log` 改成目录。

**涉及**

- `plugins/mc-status/logtail.js`：`looksLikeFailure`、`WARN_LEVELS`、`isErrorStart`、`isStackTrace`、`secondOf`、块提取
- `plugins/mc-status/index.js`：「没找到报错」文案
- `plugins/mc-status/plugin.json`：version
- `plugins/mc-status/server-bridge/cuberite-log-bridge.py` + `.service`：目录模式
- `test/mc-status-test.mjs`：新增 3 条（Warn 故障识别含无害 Warn 不误报、一次错误合成一段、重复合并计数）

**验证**

- `node test/mc-status-test.mjs`：**144 通过 / 0 失败**（新增 3 条用的是真机造出来的原始日志）。
- 真机 e2e：`\报错` 现在能拿到那 7 行一整段，再触发两次后正确显示「同类重复 3 次」。
- `node --check` 过；`check:undef`、`plugin-manifest-check`、`plugin-smoke mc-status` 全绿。

---

## [1.2.36] - 2026-09-24

**日志报错识别支持 Cuberite 的写法（原来只认 Java 版格式，Cuberite 的 Err 行全漏）**

**改了什么**

1. `logtail.js` 新增 `logLevelOf()`：统一解析一行日志的级别，覆盖三种写法 ——
   Java 版 `[12:00:00] [Server thread/ERROR]:`、Cuberite 控制台 `Error: [12:00:00]`、
   Cuberite 文件日志 `Err  [12:00:00]`（四字符定长前缀，Error 被缩写成 Err + 两个空格）。
2. `isErrorStart()` 改为「级别 ∈ {ERROR, ERR, SEVERE, FATAL, CRITICAL}」即算报错
   （原来只认 `[.../ERROR]` 和裸异常类名），裸 Exception/Error/Caused by 仍按原样认。
3. `isLogEntryStart()` 补上「级别写在方括号外 + 时间戳」的形态，Cuberite 连续两条
   Err 不再被并成同一段报错块。
4. `index.js`：「没找到报错」的文案里把认的级别写全（ERROR / Err / Exception / Caused by）。
5. `plugin.json`：`logFilePath` 说明补一句 Cuberite 的坑 —— 它每次启动新开一个
   `logs/LOG_<时间戳>.txt`（文件名会变），要填固定路径得填控制台输出重定向的 `cuberite.log`。
6. `analyzeLogWithModel()` 的 `maxTokens` 900 → 2400；空结论时区分「推理吃满预算」和
   「模型返回空」两种情况分别报错。
7. 版本号 1.2.35 → 1.2.36。

**为什么必须改**

本机对接的服务端就是 Cuberite。实测（2026-09-24，SSH 拉真实日志）：
`logs/LOG_*.txt` 里的报错行写作 `Err  [hh:mm:ss]`，而旧正则既不匹配 `Err` 也不匹配
「级别在方括号外」的形态 → **日志里真有 Error 时，工具照样回"没找到报错"**。
假阴性比报错更糟：用户会以为服务器一直健康，把真正的故障漏过去。
格式依据：Cuberite `src/LoggerListeners.cpp` —— cFileListener 写 `"Err  "`、
cVanillaCPPConsoleListener 写 `"Error: "`。

另一处：**推理型模型会把 token 预算吃光**。`deepseek-v4-flash` 实测一次调用
`completion_tokens=900` 全部是 `reasoning_tokens`，`content` 为空 → 插件判"返回空内容"
静默退回会话模型。**钱扣了、分析没了**，用户只会看到日志原文，还以为分析没配好。
预算提到 2400 后同一请求得到 1300 字结论（推理只用掉 198）。

**没改的地方（有意）**

- Warn / Info / Log 仍不算报错，避免"扫出来 70 条 Warn"把真正的故障淹掉。
- errors 模式在「没找到报错」时**提前返回、不走独立分析模型**：没报错就没东西可分析，
  省一次付费调用（这是本次测试确认的现状行为，不是 bug）。

**同日配套：日志通道按 http 接通（服务端部署，插件代码没动，所以版本号不变）**

- 服务端（Cuberite 那台）新增 `mc-log-bridge`：`/home/lubuntu/mc-log-bridge/mc-log-bridge.py`，
  端口 25585，读 `cuberite.log` 尾部，校验 `X-MC-Log-Token`，systemd `--user` 托管（enabled + Linger=yes）。
- 为什么现写一个而不装 `server-bridge/ConsoleBridge.java`：那是 **Bukkit 插件**，Cuberite 是
  C++ 服务端装不了 Java 插件。新写的这个 HTTP 契约与 ConsoleBridge 完全一致，机器人侧不用改。
- 源码与部署/排障步骤归档在 `plugins/mc-status/server-bridge/`（`cuberite-log-bridge.py`、
  `cuberite-log-bridge.service`、`编译与安装.md` 末尾新增「Cuberite 用户看这里」）。
- 机器人侧配置（走 `POST /api/config`，不是改文件）：`logSource=http`、
  `logApiUrl=http://<内网IP>:25585/logs?lines=200`、`logApiToken` 已填、`logAdminOnly=true`。
  ⚠️ token 不写进本项目任何文件（只在服务器 `/home/lubuntu/mc-log-bridge/token`，600）。
- 端到端实测：errors / tail / search 三种模式全通，混批身份门正确拒绝。

**涉及**

- `plugins/mc-status/logtail.js`：新增 `logLevelOf`、`ERROR_LEVELS`，改 `isErrorStart` / `isLogEntryStart`
- `plugins/mc-status/server-bridge/`：新增 `cuberite-log-bridge.py`、`cuberite-log-bridge.service`；`编译与安装.md` 加 Cuberite 部署章节
- `plugins/mc-status/index.js`：toolServerLog 的"没找到报错"文案；`analyzeLogWithModel` 的 maxTokens 与空结论诊断
- `plugins/mc-status/plugin.json`：version、`logFilePath` 说明
- `test/mc-status-test.mjs`：新增 12 条「日志与 AI 分析」断言（Cuberite 格式 + 工具端到端 + 分析开关，带 `--ai` 付费用例）

**验证**

- `node test/mc-status-test.mjs`：**143 通过 / 0 失败**（其中新增 12 条「日志与 AI 分析」：
  Cuberite 两种格式识别与分段/去重、工具三种模式、身份门三种情形、HTTP 通道、
  分析开关关/开/失败退回）。
- `node test/mc-status-test.mjs --ai`：追加 2 条**真花钱**的用例也过（真调 deepseek-v4-flash
  出结论并发到会话 + 阻止会话模型复述；模型名写错时静默退回、日志照常返回）。
- 另跑了一次性验证脚本（未入库）：1.2MB 日志尾部读取 2ms、CRLF/多字节截断不乱码、
  HTTP 四种响应形态 + token 只在请求头、失败不落 URL。
- `node --check` 过；`check:undef` 扫 plugins/mc-status 共 5 文件 0 处；
  `plugin-manifest-check` 全过；`plugin-smoke mc-status` 4 工具 + 1 provider 全绿、真 bug 0；
  热重载日志确认 v1.2.36 加载成功、4 个工具在位。

---

## [1.2.35] - 2026-09-24

**修复 1.2.34 引入的运行时错误：owners is not defined**

**改了什么**

1. toolRcon.execute 里补回被误删的 `const owners = ownerIdList();`（1.2.34 重排身份
   判定代码块时把它挤掉了，`ownerCallerId(ctx, owners)` 引用了未定义变量，
   一调用就 ReferenceError → 工具直接报错，用户看到"owners is not defined"）。
2. 版本号 1.2.34 → 1.2.35。

**为什么会出现**

node --check 只查语法不查运行时引用（ReferenceError 是运行时错误），而
check:standalone 只验证插件**加载**、不执行工具 —— 这类"工具 execute 体内漏声明"
只有真调用才会炸，恰好被用户的第一次真实调用抓到。`npm run check:undef`
（acorn 静态扫描）能查出这类问题，修完复扫 0 处；以后改 execute 体内代码应顺手跑它。

**涉及**

- `index.js`：toolRcon.execute（补一行声明）
- `plugin.json`：version

**验证**

- `node --check` 过、check:undef 复扫 plugins/ src/ skills/ 共 105 文件 0 处疑似；
- 热重载后 /api/tools 工具在位。

---

## [1.2.34] - 2026-09-24

**主人身份判定：改"纯主人批次"口径，堵住搭车漏洞（1.2.33 的"任一主人"被当场驳回）**

**改了什么**

1. `ownerCallerId` 判定口径从「批内任一人是主人」收紧为「**批内全部**非机器人消息
   都来自主人」（≥1 人且无混入）—— 是则返回发起的主人 id，否则拒绝。
2. RCON / 日志两处的拒绝文案改为可操作：「本次唤醒混有非主人的消息……请主人
   **单独发一条消息**再试一次即可」。
3. 版本号 1.2.32 → 1.2.34（1.2.33 未发布即被此版取代）。

**为什么这么写**

- 1.2.32 前按「最后一条非机器人消息」取调用者：主人先发"给金锭"、同批后面跟着
  别的群友 → 调用者取成别人 → 工具回"RCON 只有机器人主人能用"（2026-09-24
  15:45 会话 muf8956t 实测，主人被误拦）。
- 1.2.33 改成"批内任一人是主人"修误拦，但被用户当场指出新漏洞：RCON 输出和
  服务器日志**发到群里所有人可见**，普通群友只要在主人开口的几秒批窗口内搭车
  请求，就能借主人的身份让 AI 执行 RCON / 读日志（日志里可能有玩家 IP 和聊天
  内容）。而"最后一条"旧口径是同一漏洞的镜像（主人恰好排最后时搭车照样成功）。
- 唯一机械上无懈可击的口径是「本批只能有主人说话」。混批被拒时文案给出明确
  出路（单独再发一条），把 15:45 那种"明明我是主人却被拦"的懵逼变成一步自救。
  （对比：指令门槛的 batchHitAnyCommand 敢用"批内任一条命中"，因为那是确定性
  前缀指令、输出不含机密；这里工具的返回内容本身就是权限。）

**涉及**

- `index.js`：batchCallerIds / ownerCallerId（重写）、toolRcon 与 mc_server_log 的身份判定及文案
- `plugin.json`：version

**验证**

- `node --check`、plugin.json 解析通过；单测 9 例全过（主人单独发✅ / 双主人同批✅ /
  搭车攻击两向❌被拒 / 非主人❌ / 纯机器人唤醒❌ / 空批❌）；
- 热重载后 /api/tools 工具在位。

---

## [1.2.32] - 2026-09-24

**服务端世代自适应：老服限制不再误伤 1.13+ 新服**

**改了什么**

1. `probeServerCaps` 补一发 `version` 回退：原版/Paper 没有 about 命令，about 探不到时
   用 version 拿自报版本，否则新服会被误判成老服。
2. 新增 `isLegacyServer()`：按 about/version 自报文本判定服务端世代 ——
   含 Cuberite → 老；抠出 MC 版本号 >= 1.13 → 新；探不到 → 保守按老。
3. 三道防线全部按世代门控：@a 硬拦截、扁平化物品名改写、give 空响应的"老服不回显"提示，
   **只在 legacy 时生效**。对 1.13+ 新服（Paper/原版 1.21 等）：@a 选择器和扁平化名是
   合法语法，直接放行（改写反而会把对的命令弄坏 —— 新服上 oak_log 才是正确名）。
   execute 里的 host/port/password 计算相应上移到探测之前。
4. 工具描述与 plugin.json（instruction + 清单 description）同步说明自适应行为；
   版本号 1.2.31 → 1.2.32。

**为什么这么写**

用户问"改了这些之后 1.21 新版本命令还有效吗"——按 1.2.30/1.2.31 的实现，答案其实是
"无效"：@a 拦截和物品名改写都是无条件的，对新服会把合法语法拦掉/改坏。这三件事的
正确性本来就取决于服务端世代，而 v1.2.29 已经有了带缓存的 about/help 探测，顺手拿来
判版本即可。探不到时默认按老服处理：老规则对老服是对的，对新服只是多一道说明清楚的
拦截，不会把命令发坏。

**涉及**

- `index.js`：probeServerCaps（version 回退）/ isLegacyServer（新增导出）/ toolRcon.execute / description
- `plugin.json`：prompt.instruction、tools[].description、version

**验证**

- `node --check` 过、plugin.json 解析过、check:standalone mc-status ✅（工具=4）；
- isLegacyServer 单测 8 例全过（Cuberite/Paper 1.21/Spigot 1.12.2/原版 1.21/1.13/无版本串）；
- 热重载后 /api/tools 描述已含「服务端世代自适应」。

---

## [1.2.31] - 2026-09-24

**扁平化物品名自动改写：模型发 oak_log 这类新名也能落地**

**改了什么**

1. 新增 `FLATTENED_ITEM_MAP` + `translateFlattenedItems()`：give/unsafegive/item/unsafeitem
   命令里的 1.13 扁平化物品名在发送前**自动改写**为旧版名+数据值 ——
   六种原木（oak_log→log、acacia_log→log2 等）、六种木板（*_planks→planks:0-5）、
   六种树叶（*_leaves→leaves/leaves2）、六种树苗（*_sapling→sapling:0-5）、grass_block→grass。
   数据值按 give.lua 的布局落在第 5 个参数；原命令没写数量时自动补 1（否则数据值会被
   当成数量 0，直接被判参数非法）。
2. 改写发生后：审计日志记一笔（`[RCON] 扁平化物品名已改写：…`）；
   give 类空响应的返回里附改写说明（`oak_log → log`），让模型和用户都知道发生了什么。
3. 工具描述与 plugin.json（instruction + 清单 description）同步说明改写行为；
   并明确 1.13 才新增的内容（stripped_ 原木、barrel、campfire 等）老服务端没有、别发。
4. 版本号 1.2.30 → 1.2.31。

**为什么这么写**

接 1.2.30：@a 拦住了，但物品名只靠提示词还是拦不住 —— 模型按现代 MC 习惯写物品名
是本能（用户说"橡木原木"，它就写 oak_log）。翻 give.lua 确认它把第 5 个参数拼成
「名:数据」传给 StringToItem，所以旧版名+数据值的改写格式是它原生支持的；
1.13 才新增的内容没有旧版对应物，硬翻只会造出新的静默失败，明确不翻、靠 1.2.30
的诚实空响应提示兜底。

**涉及**

- `index.js`：FLATTENED_ITEM_MAP / translateFlattenedItems（新增导出）/ toolRcon.execute / description
- `plugin.json`：prompt.instruction、tools[].description、version

**验证**

- `node --check` 过、plugin.json JSON 解析过、check:standalone mc-status ✅（工具=4）；
- 改写逻辑单测 10 例全过（含缺数量补 1、log2/leaves2 数据值、非映射名不改写、非 give 命令不碰）；
- 热重载后 /api/tools 里 mc_rcon_command 描述已含「自动改写」文案。

---

## [1.2.30] - 2026-09-24

**把"老服务端不支持选择器/新物品名/give 静默失败"给模型说死，堵住"谎报已到账"**

**改了什么**

1. **`@a` 硬拦截**：give/unsafegive/item/unsafeitem 命令带 `@` 选择器时在工具层直接拒绝，
   不再发给服务器，返回里写明正确写法（先 list 查确切玩家名）。
2. **give 静默响应改诚实措辞**：give 类命令 RCON 空响应时，不再回"执行成功，服务器没返回内容"，
   改为明确告诉模型"不能证明成功，要让玩家上游戏确认，不要声称已经给了"，
   并附上正确姿势（确切玩家名 / 旧版物品名或数字 ID / 一次最多 64）。
3. **工具描述重写 give 相关段落**：目标选择器从"可能不认"改成"一概不支持且静默失败"；
   新增 give 三条铁律（确切玩家名 / 旧版名或数字 ID（log=17、gold_ingot=266）/ ≤64）
   和"give 成败不回显"的说明。
4. `plugin.json` 同步：`prompt.instruction` 改写 mc_rcon_command 段（口头说也直接调用、
   选择器必须换玩家名、旧版物品名、静默确认）；tools 清单里 mc_rcon_command 的 description 同步；
   版本号 1.2.29 → 1.2.30。

**为什么这么写**

实测复盘：用户口头要求"给所有玩家一组金锭""给某玩家一组橡木原木"，模型分别发了
`give @a gold_ingot 64` 和 `give 玩家 oak_log 64`，两条其实都失败了——
前者 @a 不是玩家名（Cuberite 的 give 只按确切玩家名匹配，见 Core 插件 give.lua），
后者 oak_log 是 MC 1.13 扁平化后的新物品名，老服务端（客户端 ≤1.12）的 StringToItem 不认。
但 Cuberite 把 give 的所有成败消息都只写服务器控制台日志（give.lua 走 LOG()、
控制台处理函数不回传，对比 cmd_summon.lua 会 return 消息所以有回显），RCON 永远空响应，
本工具把空响应当"执行成功"报给模型 → 模型告诉用户"给了" → 用户背包里什么都没有。
描述里原有的"选择器**可能**不认"太软，加上静默失败 + 谎报成功，模型永远学不到教训；
所以：能确定性拦截的（@a）就在工具层拦，不能拦的（物品名）就把"空响应≠成功"说死，
并让模型每次都让用户上游戏确认。

**涉及**

- `index.js`：toolRcon 的 description / execute（@a 拦截 + give 空响应措辞）
- `plugin.json`：prompt.instruction、tools[].description、version

**验证**

- `node --check index.js` 通过；
- 直接连 RCON 实测：`give 玩家 notanitemxyz 1`（瞎编物品名）与合法写法返回完全相同的空响应，
  证实 give 无论成败都不回显，拦截与措辞修改是对症的；数字 ID（266/17）写法实测可达玩家背包。

---

## [1.2.29] - 2026-09-24

**让"服务器版本/能力"可提前查，并在命令撞墙时自动给答案（针对老服务端）**

**改了什么**

1. **只读白名单加入"查看身份/能力"的命令**：`about`、`version`、`tps`、`plugins`、
   `players`、`worlds`、`banlist`、`numchunks`、`chunkstats` —— 这些本来零副作用，
   没道理要求先打开「允许危险命令」才能问。
2. **`probeServerCaps()`**：跑 `about`（拿软件与版本）+ `help`（拿命令表），
   **带 5 分钟缓存**（按 `host:port` 存）。
3. **`parseCommandList()`**：从 `help` 输出抠命令名 —— 兼容 Cuberite 的
   「summon&nbsp;&nbsp;&nbsp;- 说明」和原版的「--- Showing help page 1 of 3 --- + /cmd」；
   多词命令（`time query daytime`）取基础名。
4. **失败提示加厚**：命令被服务器判为"不认识"时，结果里**附上它自报的版本和命令表**，
   外加一句"老服务端的目标选择器往往不全（@a/@e/@s 可能不认，用具体玩家名）"。
5. 工具说明补「不确定就先 about / help 问服务器，别靠猜」。

**为什么这么写**

用户反馈："有些版本过于古老导致有些指令用不了，比如说 @a，有没有什么办法解决一下，
比如提前查看服务器版本。" —— 这是很实在的问题：服务端五花八门、版本越老能力越少，
而模型是靠"训练时见过的原版"去猜命令的，于是专挑老服务端没有的写法（execute、@a）。

解决思路：**让服务器自己交代能力**。
- **提前**：`about`/`version`/`help` 进只读白名单 → 不问也能查，且不问也能放行；
- **兜底**：真撞墙了，把"这台是什么、支持什么"直接写进失败结果 →
  模型**下一轮**就能改成可用命令，不用人陪着来回试。

**⚠️ 为什么只做提示、不做预先拦截**：原版的 `help` 是**分页**的（一次只列一部分），
拿不完整的表去拦会误杀正常命令。所以这份命令表是"参考"不是"判决" ——
提示里也明说了"可能不完整"。

**涉及**：plugins/mc-status/index.js、test/mc-rcon-test.mjs

**验证**
- `node test/mc-rcon-test.mjs`：**25 通过 / 0 失败**（新增 6 条：@a 提醒、两种 help 格式解析、
  空输入、带 caps 的提示、caps 为空时退化）
- 真机（Cuberite）：`execute as @a at @s run …` → 提示里带上
  「Cuberite Jenkins …#445」+ 53 个可用命令名；`about` 直接放行；
  `summon chicken 5 5 5` 正常执行
- `check:undef` 0 处

---

## [1.2.28] - 2026-09-24

**让主人能用自然语言直接对服务器下命令（RCON 工具豁免指令门槛）**

**改了什么**

- `plugin.json`：新增 `commandFreeTools: ["mc_rcon_command"]` —— 这个工具**不再要求**
  消息里带 `\rcon`，模型始终看得见它；同插件的查询工具（`get_mc_status` / `get_mc_trend` /
  `mc_server_log`）**仍然**要带 `\服务器` 等指令。
- 工具说明改写：明确"主人用自然语言提出要动服务器时就直接调用本工具"，并给了几个例子
  （「在 0 0 0 生成一只鸡」→ `summon chicken 0 0 0`、「看看谁在线」→ `list`）。

**为什么这么写**

用户要求：**"玩家说在某个地方生成某只鸡时 AI 要给出命令并执行，而不是由人打指令"**。
原来 RCON 工具被指令门槛挡着（不带 `\rcon` 就不进 function 列表），所以光靠提示词没用 ——
工具压根不在，模型想调也调不到。

用户确认的边界（两个问题都问过）：
- **谁能用**：只有主人。**安全靠工具内部的主人校验守**（`lastCallerId` vs `owner-identity`），
  不靠门槛 —— 门槛只解决"模型会不会乱调"，不解决"谁有权限"。
- **查询类**：不放开，继续要求 `\服务器`（所以是"按工具豁免"，不是把整个插件的门槛去掉）。

⚠️ 门槛的实现位于核心（`src/tool-registry.js` 用 `def.id` 调 `commandOpen`），
本插件只负责**声明**哪些工具豁免；机制本身记在 `项目交接文档.md` §十一。
⚠️ **核心改动要重启才生效**（`src/` 不走热重载）。

**涉及**：plugins/mc-status/plugin.json、plugins/mc-status/index.js、
src/skills/manifest.js、src/skills/manager.js、src/tool-registry.js（后三个见 §十一）、
test/command-gate-test.mjs

**验证**
- `node test/command-gate-test.mjs`：**26 通过 / 0 失败**（新增 4 条：字段保留、豁免放行（含带前缀 id）、
  未豁免的照旧拦、真实工具可用性一放一拦）
- 真机离线链路（真实加载器 + 真实 tool-registry）：
  「在0 0 0生成一只鸡」→ `mc_rcon_command` ✅ 可见、`get_mc_status` ❌ 仍不可见；
  带 `\rcon` 时两个都可见

---

## [1.2.27] - 2026-09-24

**让"服务器不认识这条命令"变成可自我纠正的提示（防模型乱升级成 execute）**

**改了什么**

- 新增 `unknownCommandHint()`：命令输出里出现 `Unknown command` / `Unknown or incomplete command`
  时，在结果后面附一段提示，点名"非原版服务端没有 execute"并给出正确写法
  （`summon chicken 0 0 0`）。
- `mc_rcon_command` 的工具说明里加了明确警告：**不要把自己的命令"升级"成
  `execute as @a at @s run summon chicken ~ ~1 ~` 这种复合命令**，就用最基础的单条命令、
  坐标写绝对值。

**为什么这么写**

用户截图反馈：让机器人"在 0 0 0 生成一只鸡"，模型发出去的却是
`execute as @a at @s run summon chicken ~ ~1 ~`，服务器回
`Unknown command, type 'help' for all commands.`，然后模型只能回用户一句
"服务器不认这条指令"，双方都没辙。

根因：**execute 是原版 1.13+ 才有的命令，Cuberite 没有它**（实测它的 70 个命令里没有
execute，也没有条件链）。工具说明里虽然写了"命令必须原样传、不要改写"，但模型照样改写 ——
所以这次两手都上：说明里**具体点名这个坑**（比抽象的"不要改写"有效），
结果里**给出下一步**（模型拿到就能自己改对，不用人来教）。

**涉及**：plugins/mc-status/index.js、test/mc-rcon-test.mjs

**验证**
- `node test/mc-rcon-test.mjs`：**19 通过 / 0 失败**（新增 3 条：识别 Cuberite/原版两种报错、
  正常输出不附提示）
- 真机：`help` 确认 Cuberite 共 70 个命令、**无 execute**；`summon chicken 0 0 0` 可用

---

## [1.2.26] - 2026-09-24

**修：RCON 对 Cuberite 服务器完全不可用（只认 type 0 的响应）**

**改了什么**

`rcon.js`：
- 命令响应**同时接受 type 0 和 type 2**（原来只认 `TYPE_RESPONSE`=0）。
- 请求 id 拆成两个固定值（认证 1 / 命令 2），**命令响应按 id 过滤** ——
  因为 type 2 同时也是认证响应的类型，不靠 id 区分会把认证响应当成"执行完、输出为空"。
- 支持**多包拼接**：长输出被拆成多个包时全部收下，遇到空包（结束包）才返回；
  另外给"不发结束包"的实现留了 250ms 兜底窗口。

`index.js`：
- 新增 `normalizeRconCommand()`：把模型给的命令归一化 —— 去前导斜杠，
  并**剥掉模型可能一起传进来的指令词**（`\rcon` / `执行命令` / `服务器命令`）。
  用户发「\rcon summon chicken 0 0 0」时，模型有时会把整串当 command 传进来，
  服务器不认 → 用户只看到"命令没反应"，几乎猜不到是这个原因。只在**开头**剥，不误伤正文。

**为什么这么写**

用户报"通过 AI 用 RCON 发指令没反应"。排查过程与结论：
- 端口 25575 **是通的**（TCP 可连），但 `execRcon` 一路超时，报"服务器没开 rcon 或端口不通"
  —— 这个错误文案把人往防火墙方向带偏了。
- 抓原始包才看清：认证**其实成功了**，服务器回的是 `size=10 id=1 type=2 body=""`；
  发 `list` 后回的是 `size=29 id=2 type=2 body="Players (1): 0001Oh"` + 一个空包收尾。
- **原版 MC/Paper 用 type 0 回命令结果，Cuberite 用 type 2** —— 只认 0 就永远等不到。
- 顺带把多包响应补上：原来收到第一个 type 0 就 return，长输出会被截断。

**涉及**：plugins/mc-status/rcon.js、plugins/mc-status/index.js、
test/mc-rcon-test.mjs（新增，已挂 `npm test`）

**验证**
- `node test/mc-rcon-test.mjs`：**16 通过 / 0 失败** —— 起假 RCON 服务器分别模拟原版（type 0）
  与 Cuberite（type 2）、认证响应不被误认、多包拼接、无结束包兜底、认证失败/端口不通/参数缺失、
  `splitPackets` 的粘包与半包，以及 `normalizeRconCommand` 的六种写法
- 真机（<内网IP>，Lubuntu + Cuberite）：`list` → `Players (1): 0001Oh`；
  `summon chicken 0 0 0` → `Successfully summoned entity at [X:0 Y:0 Z:0]`（语法有效）
- ⚠️ 排查时我误把 `destroyentities` 当查询命令跑了一次（它是**销毁全部实体**），
  把刚召唤的鸡清掉了 —— 教训：**执行前先确认命令语义**，别照名字猜。

---


## [1.2.25] - 2026-09-22
**设置表单改用 UI 认得的字段写法（select→enum、text→string）**
- `plugin.json` 的 configSchema 里 13 个字段改写法：**UI 一行没动**：
  - 5 个 `type: "select"` + `options[{value,label}]` → `type: "enum"` + `values: [...]`：
    source / cardMode / theme / watchMode / logSource
  - 8 个 `type: "text"` → `type: "string"`：servers / customMap / logFilePath /
    logApiUrl / logApiToken / logAnalyzeModel / logAnalyzeEndpoint / logAnalyzeApiKey
  - servers、customMap 补 `multiline: true`（让它们在表单里占整行宽）
  - 5 个下拉的 `description` 末尾补了「可选值：xxx=含义」，抵消下拉只显示原始值的可读性问题
- 配置项本身（`settings` 默认值、代码读取的键）**一个都没改**，纯 UI 元数据调整。
**为什么这么写**
- UI 的 `renderSettingsField()` 只认 `enum + values` 一种写法。写成 `select + options` 时它
  既不报错也不警告，而是掉进最后的 else 分支渲染成**普通文本框** —— 用户要在里面手填
  `direct`/`mcsrvstat`/`custom` 这种枚举值，填错一个字母插件行为就异常，而界面上完全看不出来
  是谁的锅。同理 `type: "text"` 不属于宽字段判定里的 `'string'`，本该占整行的服务器列表、
  字段映射表会被塞进窄列挤成一团。
- **改的是插件而不是 UI**：这份 UI 和 zip 里的 0.4 preview（老版）是**同一套口径**
  （都只认 enum+values），所以「升级 UI 去兼容 select」只能修好这一台机器 —— 插件拷给别人、
  对方是老 UI 时照样退化。清单写在插件自己的目录里**随插件走**，改成两边都认的标准写法，
  新老核心上都能正确渲染。这也是这次不碰 `ui/` 的原因（改了也白改）。
- 保留了 UI 原本的写法而不是给 UI 加别名：插件随身携带清单，是唯一能保证到处都对的做法。
**涉及**：`plugin.json`（configSchema 13 字段 + 版本 1.2.25）、新增 `scripts/schema-ui-check.mjs`
  （`npm run check:ui`：把真实 configSchema 喂给真实渲染函数，看渲染成了什么控件 —— 这类问题
  靠肉眼看 JSON 是发现不了的，它第一次跑就抓到这 13 个）
**验证**：check:ui 127 字段全部渲染正确（select/text 归零，下拉 9 个）；
  mc-status-test 131/0；check:plugins 与改前一致（15 处人工确认项无新增）

---

## [1.2.24] - 2026-09-22
**状态面板旧缓存判定升级：名字 + 配置地址双重匹配**
- `writeState` 现在把配置里的 `host`/`port` 一并存进状态文件；面板上报（`status.mc-status`）
  改用新抽的 `freshStateRows()` 按「名字 + host:port」判定缓存行是否新鲜，
  对不上的一律丢弃并触发后台补查自愈；行里没有 host 的老状态文件视为过期（不用迁移）。
**为什么这么写**
- 1.2.23 的自愈只按**名字**匹配。实测撞上变体：用户写 `新服|frp.example.com:26109`，
  之前是 `新服|old.example.com:35674` —— 显式名字没变、只有地址变，旧地址的缓存行
  被当新的继续展示，面板照样显示旧服务器的查询结果（同"换了地址还查旧的"）。
- host/port 存**配置里**的而不是查询结果里的：直连源 SRV 解析后会把 host 覆盖成
  queriedHost（可能跟填的不一样），存那个会把新鲜行误判成旧的、每次渲染都白查一轮。
**涉及**：`index.js`（writeState、freshStateRows、providers）、`test/mc-status-test.mjs`（+3 用例）
**验证**：mc-status-test 131/0（含"同名不同址""老格式无 host"两个新回归）；check:undef 0

## [1.2.23] - 2026-09-22
**状态面板：换服务器地址后不再显示旧地址的查询缓存**
- 改了什么：`status.mc-status` 上报时，`state.rows` 里的明细行只有**服务器名在当前配置里**才展示；
  对不上的行丢弃，并提示「待查询（刚改过配置，正在补查）」，同时在后台自动补一次查询自愈
  （`requeryInFlight` 防抖——面板是 ai-status 每轮聚合的高频调用，补查只该跑一次）。
**为什么这么写**：2026-09-22 实测事故——用户把地址从 old.example.com 换成 frp.example.com 后，
  面板「服务器 1 个」读的是当前配置（对），明细行却还是旧地址的上次查询结果（错），
  看起来像"换了地址还在用旧的"。根因是明细读的是**查询缓存**，只有真查询才更新，改配置不触发。
  没有现成的配置变更通知钩子，所以在上报侧按名字比对自愈。
**涉及**：plugins/mc-status/index.js（providers 部分）、test/mc-status-test.mjs（+2 项）
**验证**：mc-status-test 128/0（新增两条：换地址后旧行不展示+提示待查询；对得上时正常展示）；
  补查指向 127.0.0.1:1 瞬间失败，测试不真出网。

## [1.2.22] - 2026-09-22

**指令直达：\服务器 / \人数曲线 由系统直接执行，不再交给模型判断**

- `plugin.json` 新增 `commandRoute`：`服务器曲线/人数曲线` → `get_mc_trend`，
  `服务器/服务器状态/我的服/mc/mc服务器/我的世界` → `get_mc_status`，
  两者都带 `argName: name` + `argFrom: rest`（「\服务器 生存服」直接把"生存服"当参数）
- 所有"提示性返回"（没配服务器、没找到匹配、不给查内网、没有可画的数据）改用
  `asDirect()`，同时给出 `_directText`
- 状态卡/曲线卡的文本兜底分支补 `_directText`

**为什么**：原来模型那一环不可靠 —— 群友发「\服务器」，模型没调服务器工具，去调了
常驻的天气工具，最后编一句"服务器没崩"（2026-09-22 事故）。「\指令」是确定性输入，
用户已经把意图写死了，交给系统执行更准、更快、还省掉整轮 token。
`_directText` 是因为：直达不经过模型，系统只敢发显式标了"这段能发给人看"的文本 ——
`content` 里可能混着给模型的措辞（ai-status 就有"必须原样作为一条消息发送"），
但反过来，如果提示性返回不标，用户发了指令会一个字都收不到。

**没进直达的**：`rcon/执行命令`、`日志/报错/控制台/崩溃` —— 前者参数敏感（要先过
白名单和主人校验，交给模型判断更稳），后者本身就是 LLM 型（要模型读日志给结论）。
这些仍走原来的模型链路，行为不变。

**验证**：`node test/command-router-test.mjs` 21 项（含"长指令词优先""指令夹在连发
消息中间""content 里的模型指令不能漏到群里"）；mc-status 测试 126/0。

---

## [1.2.21] - 2026-09-22

**合计有效点口径纠正：各台有效点相加 /（段数 × 台数）**

- 改了什么：多台时「合计有效点」不再用 `series.samples`，改成
  `totalOkN / (n × 台数)` —— 分子是**各台有效点之和**，分母是**段数 × 台数**
  （例：生存服 48 + 创造服 20 + 小游戏服 42 = 110 / 144）。
  给模型的摘要同步改成 `共 110 个有效数据点（3 台合计，满格 144）`。单台行为不变。
- 为什么这么写：`series.samples` 是**合并视图**的点数，口径「任一台有值就算有效」——
  三台里只要有一台全程在线它就是满格 48/48，另外两台的缺口被整个吃掉，看着 100% 完整，
  实际丢了三分之一。图上画的是 N 条线 × n 段 = n×N 个可能的数据点，采到多少就该是多少
  （用户原话：合计不应该是服务器点数，应该是各台真正有效点合在一起）。
  改完也和下面分台那一行对得上了：逐台相加就是分子，不用再解释两个口径。
- ⚠️ 别改回 `series.samples`（代码注释里也写了这条理由，改回去同样的反馈会再来一次）。
- **涉及**：plugins/mc-status/index.js（`totalOkN`/`totalCapN`、stats 那一行、
  trendBrief 的 `okBrief`/`capBrief`）、plugins/mc-status/plugin.json（1.2.21）、
  test/mc-status-test.mjs（合计断言 48/48 → 110/144，并加"不许再是满格"的反向断言；
  摘要断言同步）、scripts/gen-trend-preview.mjs（`--perstat` 的 console 口径同步）
- **验证**：`node test/mc-status-test.mjs` 126/0；
  `gen-trend-preview.mjs --perstat`（三台 96/30/90）→ 图上 `合计有效点 216 / 288`。

## [1.2.20] - 2026-09-22

**线型改成「平时全实线，只有重合时才换虚线」**

- 改了什么：`DASHES` 不再按序号无条件轮换。默认每台都是**实线**（`DASHES[0]` 空串）；
  只有 `linesDuplicated` 检测到这条线与别的线重合、且自己是**后画的那条**时，才从非实线档里
  依次取一种（`DASHES[1..]`，多台同时重合时各拿不同线型，不会两条都拿到同一种虚线）。
  先画的那条保持实线 —— 和"抬高 2px 的是后画的"指向同一条，两个信号不打架。
- 为什么这么写：1.2.18 是无条件轮换（第 1 台实线、第 2 台虚线、第 3 台点线…），于是**哪怕
  根本没跟谁重合**，第 3 台也永远画成一串点 —— 用户看到图的反应是"不是线吗为什么变成点了"，
  像渲染坏了。线型本来只是救重合的备胎（虚线压在实线上是透的，重合段才看得出叠了两条），
  平时不该出现。
- ⚠️ 别改回按序号轮换：`DASHES` 定义处的注释也写了这条，改回去同样的反馈会再来一次。
- **涉及**：plugins/mc-status/index.js（perPaths 里 dash 的分配逻辑 + DASHES 注释）、
  plugins/mc-status/plugin.json（1.2.20）、
  test/mc-status-test.mjs（新增线型测试：不重合 → 全实线 / 重合 → 只后画的换 /
  三台重合 → 后两条线型不撞）
- **验证**：`node test/mc-status-test.mjs` 126/0；
  `gen-trend-preview.mjs --perstat`（三台人数 10/8/6 各不相同）→ 0 个 `stroke-dasharray`，全实线；
  `gen-trend-preview.mjs --demo`（两台恒定 10 人重合）→ 1 个，只有后画那条换虚线。

## [1.2.19] - 2026-09-22

**有效点、断连段数按服务器分开统计（图上一行「分台统计」）**

- 改了什么：多台各画一条线时，统计区下面多一行 `.pstat`，每台一个色块 + 名字 +
  `有效点 X/总段数`，断了的那台在自己名字后面追加红色的 `· 断连 N 段`。
  原来那行 `有效点 X / N` 在多台时改叫 **「合计有效点」**（口径没变，只是标明是合计）。
  给模型的摘要同步补了一句 `各台有效点（共 N 段）：A 48、B 20、C 42`。
- 为什么这么写：合计口径是「任一台有值就算有效」，三台里只要有一台全程在线，
  合计就是满格 48/48 —— 创造服只采到 20 段、小游戏服断了 6 段这些缺口被合计整个吃掉
  （用户原话：有效点也分服务器、断连的段数也分服务器）。断连同理：合计 3 段说不清
  是三台各断 1 段还是同一台断了 3 段，而「一台反复断」和「三台各抖一下」要做的处理
  根本不是一回事。
- ⚠️ 单台时不渲染这行（只有一个台，分台没意义），维持原来的「有效点 X / N」。
- ⚠️ 1.2.17 那条测试断言 `doesNotMatch(brief, /创造服/)`（不许点名没断的台）被这条改动
  撞到了 —— 新的「各台有效点」会合法列出每台名字。已把断言收紧到**只检查断连那一句**
  （抽出 `断连情况…：` 到 `——` 之间的片段），保护力不减：要防的是「把没断的台说成断了」，
  不是「摘要里不能出现这个台名」。
- **涉及**：plugins/mc-status/index.js（perStats 计算 + `.pstat` 样式 + HTML 块 +
  `合计有效点` 措辞 + trendBrief 的 perPtsLine）、
  plugins/mc-status/plugin.json（1.2.19）、
  test/mc-status-test.mjs（新测分台统计 4 台口径 + 单台不渲染；收紧 1.2.17 断言）、
  scripts/gen-trend-preview.mjs（新增 `--perstat` 场景：三台 = 全程 / 只采到 30 段 / 断连 6 段）
- **验证**：`node test/mc-status-test.mjs` 125/0；
  `node scripts/gen-trend-preview.mjs --perstat` → `mc-trend-perstat-preview.html`
  目检：合计 96/96 满格，分台行显示 生存服 96、创造服 30、小游戏服 90（断连 6 段）。

## [1.2.18] - 2026-09-22

**重合线可见化：图例带每台人数 + 线型交替 + 重合自动错位**

- 改了什么（三件配套的事，都冲着同一个问题）：
  1. **图例直接给出每台的最新人数**（`生存服 10 人`，最新有效样本；断连取上一
     个有效值，全程没数据显示 —）。曲线读不出的数，图例总能读。
  2. **多台时线型随序号交替**（实线/虚线/点线/长虚线循环，`DASHES`）。两台人数
     相同时两条线完全重合，只靠颜色分不出来 —— 后画的盖住先画的。
  3. **重合自动错位**：检测两条线的有效样本大面积相等（≥80% 且样本 ≥5 个，
     `linesDuplicated`）时，**后画的线整体抬高 1 个 viewBox 单位**（显示 2px），
     且重合对**两条都不画点**。这样重合也能看出"叠了两条"，先画的留在真值位置。
- 为什么这么写：用户拿"两台都固定 10 人 + 一台断连"的 demo 图反馈"两条线相合的
  时候查人数不好查"。重合是常态场景（两台人一样多很常见），后画的线+点串会把
  先画的盖个严实 —— demo 里整张图只剩一条绿线，蓝线彻底隐形。最初只加了虚线
  交替，但点串（人数恒定时每个点都是峰值点、全画）照样盖死；补了"重合不画点 +
  抬高 2px"才真正分开。抬高只动显示：明细区/图例/给模型的摘要都是真值，2px 的
  错位不构成误读，换来"重合可见"。
- **涉及**：plugins/mc-status/index.js（pathOf/dotsOf 加 dy 参数、linesDuplicated、
  perPaths 重合检测、legend 带人数、.legend .lg b 样式）、
  scripts/gen-trend-preview.mjs（--demo 场景：两台恒定 10 人 + 生存服断连 1 小时）、
  scripts/shot-preview.mjs（按内容宽重开窗口再截 —— offscreen 下 resize 后
  capturePage 不跟随，之前 1224px 的卡片被 900px 视口裁掉一整段，看起来像渲染 bug）、
  plugins/mc-status/plugin.json（版本）
- **验证**：`node test/mc-status-test.mjs` 124/0；demo 图 `node
  scripts/gen-trend-preview.mjs --demo` → `mc-trend-demo-preview.png` 目检：
  重合段蓝绿条纹可辨、断连红带照画、绿虚线压过红带、图例两台各 10 人。

## [1.2.17] - 2026-09-22

**红带口径放宽：有任一台断连就画红带，活着的线压在红带上面**

- 改了什么：`mergeSeries` 的断连判定从「这个时间窗**全部**服务器都查询失败」放宽成
  「**至少一台**失败」（`mergeSeries` 的 downs 一行）。红带画法不变（图顶到基线、
  连续段并成一条）；脚注改成「红色竖带 = 该时段有服务器没连上（还活着的线条压在
  红带上）」；统计区新增「断连 N 段」红字；明细区措辞微调。
- 为什么这么写：1.2.14 定"全部失败才算红"是怕冤枉活着的服务器，但那样一来
  「一台断了、别的活着」在图上只剩一个断口，**和"那会儿根本没查过"长得一样**，
  既看不出是哪台断了、也分不清是断了还是没查 —— 红色丢掉了它最重要的信息量。
  用户拍板的替代方案（原话「正常服务器的颜色线直接从红带上面压上去」）：红带照画，
  活着的线条照画并压在红带上面（渲染顺序 downBands 在 perPaths 之前，天然盖不住线）。
  于是全断 = 红带裸露、线上断口；部分断 = 线压过红带 —— 两种情况一眼分开，
  也不用引入第二种颜色。
- 同时给模型的文字摘要（trendBrief）加了**逐台点名断连**：多台时输出
  「断连情况：生存服 3 段、创造服 0 段」这样的一条。模型看不见图，以前只有一个
  总段数，它会把"某台挂了"说成"那会儿没人"。点名的条件是「配了多台服务器」
  而不是「断连的台数 > 1」—— 两台里只断一台恰恰是最需要点名的场景。
  单台时仍用总段数说法。perServer 的构造也提到了发图分支外面（文字回退也要用）。
- 单台自身的判定**没动**：同一窗口里既有失败又有成功仍是抖动，不染红；
  完全没查过的时段仍是空白，不画红。
- **涉及**：plugins/mc-status/index.js（mergeSeries、buildTrendHtml 脚注/统计/明细、
  trendBrief、曲线工具 execute）、test/mc-status-test.mjs、
  scripts/gen-trend-preview.mjs（预览改成部分断连 + 全断 + 单服三张卡）
- **验证**：`node test/mc-status-test.mjs` 124/0（改口径断言 + 新增"部分断连也画红、
  合计不假摔成 0、红带先画线后画（z-order）、摘要逐台点名"等 4 条）；
  预览 `node scripts/gen-trend-preview.mjs` → `mc-trend-v1217-preview.png`
  （electron 离屏截图，三张卡逐一目检通过）；`check:undef` 0；`test:smoke` 真 bug 0

## [1.2.16] - 2026-09-22

**曲线密度改成滑块，且「一段多长」与「多久查一次」彻底绑死成一个设置**

- **一个设置管两件事（强绑定）**：`trendSlotMinutes` 现在是唯一驱动项 —— 图上一段多长，
  后台就多久自动查一次（选 20 分钟 = 每 20 分钟查一次 = 一段 20 分钟），一轮采样不多不少
  落进一个点。**为什么**：v1.2.15 把这两项拆成了「段长」和「自动采集间隔」两个设置，
  用户还得自己保证它们对得上，对不上就又回到"段画得比查询密 → 一大片空格子"的老毛病
  （用户原话："查询需要跟图表这个时间段强绑定"）。
- **`trendAutoIntervalSec` 废弃**（从 settings/configSchema 里删掉）：间隔由段长决定。
  **为什么保留一点兼容**：老配置里可能还存着这个键 —— `trendSlotMin()` 在段长没选（0/空）
  时会拿它换算，避免升级后曲线直接断档；段长选了就以段长为准。
- **去掉"按轮询周期抬高粒度"的兜底**：以前播报周期比段长粗时会把段长抬上去，
  结果用户选的档位看起来没生效。**为什么现在敢去掉**：采集必定按段长跑，空格子只可能是
  采集被关掉、或那段时间确实没查通（后者画红色断连带，本来就该空着）。
- **设置控件从下拉改成滑块**（用户要求"换成滑块"）：档位 5/10/15/20/30/60/90/120/240 分钟
  （最大 4 小时）。`normalizeSlotMin` 上限同步从 120 抬到 **240**，否则拖到 240 会被夹回 120。
  ⚠️ 档位表在**两个地方**各写了一份（`plugin.json` 的 `stops` 和代码里的 `SLOT_CHOICES`），
  测试里有断言盯住两边一致 —— 不一致就会出现"拖到 4 小时、插件只认 2 小时"的静默降级。
- 滑块显示单位：≥60 分钟自动说小时（60 →「1小时」、90 →「1.5小时」、240 →「4小时」）。

**涉及**：`plugins/mc-status/index.js`（trendSlotMin/samplingIntervalSec/resolveSlotMin 重写、
SLOT_CHOICES、normalizeSlotMin 上限、startTrendCollect 用段长作间隔）、`plugin.json`（1.2.16、
滑块 schema、删掉旧间隔项）、**框架 UI**：`ui/app/06-settings-render.js`（新增 `type: "slider"`
渲染 + `fmtSliderVal` + collectSettings 取值 + document 级 input 委托同步显示）、`ui/style.css`
（`.field--slider` / `.skill-range` / 刻度样式）、`test/mc-status-test.mjs`
**验证**：`node test/mc-status-test.mjs` 123 通过 / 0 失败（新增：滑块档位 ↔ 代码档位一致、
段长不被周期偷偷改、采集间隔 = 段长、老 interval 键兼容）；`npm run check:undef` 0 处；
`npm run test:smoke` 真 bug 0；`node test/coverage-ui.mjs` 21 通过 / 0 失败

## [1.2.15] - 2026-09-22

**「\服务器」一次指令 = 真查一次；曲线改成后台自动采集，一段的长度跟随查询频次**

- **指令不再吃缓存**：`get_mc_status` 默认 `force`（`queryAll(..., { force: args?.refresh !== false })`）。
  **为什么**：以前默认吃 30 秒缓存，连着发两次 `\服务器` 第二次根本没动手，用户看到
  一模一样的数字以为插件没查（用户原话"输出一次这样的指令就查询一次"）。
  缓存不是删了 —— 它只留给**后台路径**（自动采集、状态面板探测、曲线预查）：
  那些是程序自己发起的、没必要每次都重新握手。⚠️ 所以 `cacheSeconds` 的含义变了，
  描述已改成"只管后台路径"，别再拿它解释指令行为。
- **曲线后台自动采集**（新增设置 `trendAutoEnabled` 默认开 / `trendAutoIntervalSec` 默认 900）：
  独立定时器按间隔 `queryAll(servers, {force:true})`，**只写历史、一条消息都不发**。
  **为什么单独做一个、不复用「人数播报」**：播报**必须填群号**才启动，而只想安静攒曲线
  的人根本不想让机器人说话。两者都开且播报周期更短时，采集直接复用播报的采样
  （`startTrendCollect` 里判断后 return），不会把服务器当靶子打两次。
- **一段的长度 = 查询频次**（`trendSlotMinutes = 0` 即"自动"，现在是默认值）：
  `samplingIntervalSec()` 取所有自动来源里**最密**的周期，`resolveSlotMin` 在自动模式下
  直接拿它当段长（15 分钟一采 → 一段 15 分钟；1200 秒 → 20 分钟；1800 秒 → 30 分钟）。
  **为什么**：以前粒度是手动选的固定档、跟采样频次无关，画得比采样还密时一大片格子是空的，
  "刚查完图上却看不见"（用户原话"每一段按照查询频次来画，比如 15 20 30 这样"）。
  手动档位仍保留，但**不得短于采样周期**（会被自动抬高）。
- **`normalizeSlotMin` 不再限死 5/10/15/30/60 五档**，改成"5 的倍数、5~120 分钟"。
  **为什么**：20 分钟这类合法频次以前会被夹回 5 分钟，段长和真实频次对不上，正是用户抱怨的点。
  历史桶本来就是 5 分钟一个，只要 5 的倍数都对得齐，没必要设档位。
- 卡片脚注会写明"每段 = 自动采集间隔 N 分钟"；曲线工具在自动采集刚跑过（不到半个周期）时
  **跳过画图前那次预查询**，省一次握手、也避免同一段里多塞一个样本。

**涉及**：`plugins/mc-status/index.js`（queryAll 调用、resolveSlotMin/samplingIntervalSec/
normalizeSlotMin、collectTick+startTrendCollect/stopTrendCollect、setup/deactivate、
曲线工具预查询与 slotNote）、`plugin.json`（1.2.15 + 新增两项设置 + 曲线设置单独成组
「人数曲线」+ cacheSeconds/轮询间隔描述改写）、`test/mc-status-test.mjs`
**验证**：`node test/mc-status-test.mjs` 121 通过 / 0 失败（新增 6 条：自动粒度 15/20/30、
手动指令连发两次真查两次、后台仍吃缓存、采集写历史、采样周期取更密者、播报没填群号不算采样）

## [1.2.14] - 2026-09-22

**断连画红色竖带 + 多服务器各画一条线（用户手绘草图提的需求）**

两条一起改（都落在曲线卡上）：

- **断连红色竖带**：`pushHistory` 以前对离线/查不通**直接不记** —— 结果"断连"
  和"压根没查过"在数据里无法区分，想画红带也没有数据来源。现在失败样本在槽里记
  `down` 计数（不碰 sum/n，数值序列照旧缺数据断开，不会出现"掉到 0"的假摔）；
  `seriesOf`/`mergeSeries` 输出 `down` 掩码（窗口内**查过且全失败**才算，成功失败
  混在窗口 = 短暂抖动，照常画值）；渲染时连续的断连点并成一条从图顶到基线的
  半透明红色竖带（`#e5484d`，opacity 0.42），明细区断连段写「⛔ 断连」，
  底部注释出现红带说明，`trendBrief` 会向模型报"另有 N 个时间段查询全部失败"。
- **多服务器分开画**：以前多台只画「合计」一条线 —— 看得出总量，看不出哪台掉了。
  现在不点名查询且配了多台时，每台一条线（8 色调色盘轮换，不放纯红——红色留给
  断连带）+ 图例；统计区改「合计峰值 / 单台最高 / 合计平均」。点名单台照旧单线。
  连线与圆点规则抽成 `pathOf`/`dotsOf` 复用，避免断开规则抄两份改一漏一。

**为什么这么写**

- *down 为什么记在槽里而不是单独的事件列表*：断连的展示粒度就是槽（红带画在时间轴上），
  记在同键槽里序列化/清理（48h 过期）全部复用现有逻辑，不用另写一套生命周期。
- *成功样本为什么要保留同槽的 down 计数*：一次轮询失败 + 三次成功 = 抖动，值照画、
  不画红；如果成功时把 down 抹掉，下次再失败时窗口的 down 次数就少记了。
- *合并视图的红带为什么要求"全部失败"*：多台里一台断、别的活着，整体没断 ——
  给整个时间轴染红会冤枉还在线的。哪台断了看各自线上的断口（分开画之后可见）。
- *红带为什么连点并成一条*：5 分钟粒度下 20 分钟断连 = 4 个点，裂成 4 条细红条
  视觉上像噪点；用户草图里就是一条实心红柱。
- *空态判定放宽*：全是断连记录时也出图（红带本身就是信息），不能回落到
  "还没有数据"引导语 —— 那会把"服务器挂了一整天"伪装成"没查过"。

**涉及**：`plugins/mc-status/index.js`（pushHistory/seriesOf/mergeSeries 加 down、
buildTrendHtml 重构 pathOf/dotsOf + 红带 + 多线 + 图例 + 明细/统计/底注、
trendBrief、get_mc_trend 描述与 perServer）、`plugins/mc-status/plugin.json`
（1.2.14、简介）、`test/mc-status-test.mjs`（+5 条断连/多线断言）

**验证**：`node test/mc-status-test.mjs` 全过；`npm run check:undef` 0 处

---

## [1.2.13] - 2026-09-22

**修复：刚发的「人数曲线」查询自己不出现在曲线上（用户反馈："这个查询在人数曲线上不显示"）**

- `get_mc_trend`（曲线工具）以前**只读历史**（mergeSeries/seriesOf），自己不发起查询；
  而历史样本是「每次查询时顺手记」的（queryOne → pushHistory）。结果就是：曲线查询
  画出来的是**上一次**真查询之前的世界，最新只能停在上次的时刻 —— 用户刚查的这次
  永远要等下一次查询才上图，看起来像"没记上"。
- 修法：画图前先把目标服务器各真查一遍（`await Promise.allSettled(targets.map(queryOne))`），
  查得动 → 最新点立刻上图；查不通 → 照旧不记录（缺数据断开的规则不变），图也照画。
- 不 force：30 秒缓存内的重复查询直接吃缓存 —— 那份样本在被取回时已经记过了。

**为什么这么写**

- *为什么不改成"曲线工具也长期记数据"之外的方案（比如定时轮询）*：轮询是独立的
  `watchEnabled` 功能，默认关 —— 不能为了画图偷偷给所有人开定时器。曲线工具自己
  查一遍是零成本补样本：它本来就只服务"此刻想看"的人。
- *为什么用 allSettled 不是 all*：某一台查不通不能把整张图炸掉 —— 曲线的语义是
  "画得出多少是多少"，查不通的那台只是今天这个点缺数据。
- *为什么缓存命中也能接受*：缓存里的数据在它被取回的那一刻就已经 pushHistory 过了，
  槽位不会丢；force 重查只会多打一次服务器，没有信息增益。

**涉及**：`plugins/mc-status/index.js`（get_mc_trend.execute 画图前补一轮 queryOne、
工具描述补一句）、`plugins/mc-status/plugin.json`（版本 1.2.13）、
`test/mc-status-test.mjs`（新增 2 条：画图前先查+样本立刻可见、查不通不炸）

**验证**：`node test/mc-status-test.mjs` 全过；`npm run check:undef` 0 处

---

## [1.2.12] - 2026-09-22

**去掉写在设置表单 placeholder 里的真实群号（脱敏）**

- `watchGroups` 的 placeholder 原本写死了真实群号（两个），现改为占位号 `123456789`。
- 同时新增 `scripts/pack-plugin.mjs`（`npm run pack:plugin <插件名>`）：这是第三次手工脱敏打包了，
  抽成脚本并内置出包前自检。

**为什么这么写**

- 提示词/工具不随目录走不行，但**真实个人信息随插件目录走**同样不行 —— 插件是要发给别人的。
  UI 上的 placeholder 很容易被忽略：它不是配置值，却会在别人电脑的输入框里显示。
- 也是这一次才发现：光扫"字段名"（password/token）不够，`CHANGELOG.md` 第 225 行把**真实服务器
  主机名**写进了验证记录里。所以打包脚本改成按「运行时配置的真实值」反查替换整个包，
  而不是只认几个敏感字段名。

**涉及**：`plugins/mc-status/plugin.json`（placeholder、版本）、`scripts/pack-plugin.mjs`（新增）

**验证**：`node scripts/pack-plugin.mjs mc-status` 出包，脱敏自检 0 命中；
包内独立复核（真实地址/端口/群号/QQ号/用户名/本地路径）全 0 命中；JSON 可解析、全部 .js 语法通过

---

## [1.2.11] - 2026-09-22

**曲线粒度与轮询间隔联动（用户要求："防止刚查完数据在图表上又看不见"）**

- 新增 `resolveSlotMin(cfg)`：开了播报时，**一个点的长度不得短于轮询周期**
  （取 5/10/15/30/60 里 >= 周期的最小档）；关播报时完全听用户的（数据来自手动查询）。
- 趋势工具改用它取粒度；卡片底部在被抬高时写明原因
  （"粒度已按轮询间隔从 5 分钟自动抬到 30 分钟"）。
- 两个设置项的说明互相点明了这层关系。

**为什么这么写**

- *根因*：粒度 5 分钟 + 轮询 30 分钟 → 图上 6 个格子才 1 个样本，看着像"刚查完没记上"。
  把点抬到 >= 轮询周期，每一轮轮询必定正好落入一个点，不会有点被架空。
- *为什么只在轮询比粒度慢时抬*：反过来（轮询 2 分钟、粒度 5 分钟）是采样比显示密，
  多点平均更准，照用户选的即可 —— 只有"显示比采样密"才会产生空点错觉。
- *为什么必须写在卡片上*：不改 ui/ 或配置用户也能懂；用户看到粒度不是自己选的会以为设置没生效。
- *为什么不动用户的设置值*：抬的是"画图时的有效粒度"，`trendSlotMinutes` 原值留着，
  关掉播报立刻回到原来的细粒度 —— 联动是可逆的。

**涉及**：`plugins/mc-status/index.js`（resolveSlotMin/趋势工具/buildTrendHtml slotNote/renderTrendPng/internals 导出）、
`plugin.json`（两个设置项说明、版本）、`test/mc-status-test.mjs`（+联动断言）

**验证**：mc 测试 108/0；`undef-scan` 0 处；`test:smoke` 真 bug 0；
脚本核验：轮询30分+粒度5分→30；轮询2分+粒度5分→5；关播报→原值；20分周期→30档

---

## [1.2.10] - 2026-09-22

**撤回 1.2.7 的「数值一变就断开」—— 那是我误读了意图**

- 1.2.7 曾把连线规则改成「密粒度下相邻点数值相同才连横线，一变就断开」。**撤回**。
- 恢复为原规则：只有明显跳变才断开 —— 绝对差 >= 5 人 **且** 相对差 >= 60%
  （服务器掉线/重启/换服那种中间没采到样本的情况）；普通小幅波动（4→5）照常连成折线。
- 线宽/点径（0.7 / 0.9 / 峰值 1.8）和 Y 轴整数刻度 **保留**，不受本次撤回影响。

**为什么撤回**：用户原话是"如果不相干的话可以不画"，指的是**明显不相干的跳变**，
不是"数值不同就不连"。我按后者理解，把趋势图切成了碎段落，丢掉了连续趋势。
⚠️ 教训：用户对视觉效果的描述（"一条横二一条横四"）不等于要求改数据结构/连线规则 ——
不确定时先问，别直接按字面推演实现。

**涉及**：`plugins/mc-status/index.js`（buildTrendHtml 的 linkedToPrev）、`plugin.json`（版本）

**验证**：mc 测试 107/0（原 1.2.7 未对该规则加断言，撤回无需改测试）；preview 人工核对

---

## [1.2.9] - 2026-09-22

**刻度整数闸 + 判定口径从宽（用户确认："人数15就画20和10中间的刻度就行"）**

- `niceStep` 的 pow 下限从 0.1 提到 1，`step` 再加 `Math.max(1, ...)` 双保险：
  人数是整数，刻度最细到 1 人。修复峰值 1~2 人时 step 算出 0.2/0.5、
  标签 Math.round 后出现「0、1、1、2、2」重复假刻度的 bug。
- 判定口径按用户确认从宽：刻度不必精确卡住每个值，能夹住数据读出大概位置即可。
  实测各峰值：1→0,1,2；5→0..6；15→0,5,10,15；40→0,10,20,30,40；150→0,50,100,150。

**为什么这么写**：刻度重复比刻度少更糟 —— 少了只是粗略，重复是直接给模型/用户错误坐标。

**涉及**：`plugins/mc-status/index.js`（niceStep/step）、`test/mc-status-test.mjs`（+刻度整数不重复断言）、`plugin.json`（版本）

**验证**：mc 测试 107/0；脚本核验峰值 1/2/5/15/40/150/800 刻度序列；preview 人工核对

---

## [1.2.8] - 2026-09-22

**横向网格线加密：按峰值自适应整数刻度（原话"数据横线需要多一点"）**

- 原来固定 0/中/顶 3 条线，人数在 2~5 之间跳时没有可对照的刻度。
- 改为 nice-step 自适应（1/2/5×10ⁿ）：目标约 6~7 格。峰值 5 人 -> 0..6 每人一条；
  峰值 200 -> 步长 50 共 5 条，自动保持整数、不会糊。
- 左侧刻度数字随线生成，与线一一对应。

**为什么这么写**：读图靠"横线落到哪格"；格子太少等于没有坐标系。1/2/5 序列保证
任何峰值下刻度都是整齐的整数（不会出现 3.7 这种）。

**涉及**：`plugins/mc-status/index.js`（buildTrendHtml 的 grid 段）、`plugin.json`（版本）

**验证**：mc 测试 106/0；脚本核验峰值 3/5/12/60/200 下横线数 5/7/4/4/5；preview 出图人工核对

---

## [1.2.7] - 2026-09-22

**曲线画细：横线只在同值段上画，数值变了就断开**

- 折线 stroke-width 1.1 -> 0.7（稀疏 1.6 -> 1.2）；数据点圆点 r 1.4 -> 0.9，峰值点 2.6 -> 1.8。
- 密粒度（点数 > 72，即 5/10/15 分钟档）下**相邻点数值相同才连成横线**，数值一变就断开，
  断口处由圆点兜底（孤立点不会隐形）。稀疏粒度（每小时一点）保持原「跳跃断开」逻辑不变。

**为什么这么写**

- 用户原话："一条横二一条横四一条横五…如果不相干的话可以不画"。5 分钟粒度下人数是阶梯状
  跳变的，按旧逻辑 4->5 也用陡线硬连，整条线成了粗锯齿/粗横条。横线只画在"数值相同的一段"
  正好对应用户看到的形态，也更诚实：没采到中间过渡就不该画出过渡。
- 线粗的主因是**圆点+折线叠加**：点挨着点时 r=1.4 的点连成一带就是粗条，所以点、线一起收细。

**涉及**：`plugins/mc-status/index.js`（buildTrendHtml 的 dots/linkedToPrev/path）、`plugins/mc-status/plugin.json`（版本）

**验证**：`node test/mc-status-test.mjs` 106/0；`node scripts/mc-trend-preview.mjs` 出图人工核对；
`node --check` 语法过

---

## [1.2.6] - 2026-09-22

**曲线粒度可调（默认 5 分钟一段，跨度仍是 24 小时）+ 卡片下方明细区**

- 存储侧改为固定按 **5 分钟分桶**（`SLOT_MS`/`slotKey`），历史文件大小仍可控；
  用户在设置里选的粒度（5/10/15/30/60 分钟）是**读取侧**的事：粗粒度由若干 5 分钟桶
  加权平均合并得到。跨度继续由 `trendHours` 决定（默认 24 小时 → 288 个点）。
- 新增配置项：`trendSlotMinutes`（一个点代表多少分钟）、`trendDetailRows`（卡片下方明细行数，0=不显示）。
- 卡片 X 轴刻度按可用宽度自适应，显示到分钟（`1:05` 这种，去掉小时的 leading zero）。
- 卡片下方新增明细区：白字一行是检测周期（`1:00-1:05`），下面小字是该周期内各服务器的人数。
- 文字版 `trendBrief` 改为**按小时归并**后再给模型。

**为什么这么写**

- *为什么存储固定 5 分钟、粒度只在读取侧生效*：反过来（按当前设置分桶）一旦改设置，
  新桶和旧数据就对不上，整条历史报废。粗细都由最细的桶合并出来，改设置不损伤历史。
- *为什么每个有数据的点都必须画圆点*：5 分钟粒度下数据是零散的，孤立的单个点用 M/L
  **画不出任何东西**，只画线等于让这些样本集体隐形 —— 用户看到的就是一张空图。
  `r` 随点数收小（288 个点用 1.6px 会糊成粗带），峰值点永远画大并换强调色。
- *为什么保留老历史并铺开*：v1.2.5 以前按小时存（键长 13）。直接丢弃会让用户升级后
  曲线突然空白、以为插件坏了；`slotMap` 把那小时的平均铺到它下面 12 个槽上，
  形是对的（值本来就是那小时平均），48 小时后自然过期。
- *为什么文字版要按小时归并*：288 个点全拼进 content 会撑爆上下文，而 content 是模型
  **唯一能看到的替身**。峰值/平均仍取原始点真值，不会因为并点失真。
- *为什么明细默认只列 8 段*：几百个点全列会把卡片撑成门帘；取最近有数据的若干段，
  顺序与 X 轴一致（旧→新），读完正好接上曲线右端。

**涉及**：`plugins/mc-status/index.js`（历史/序列/画图/文案/工具）、`plugins/mc-status/plugin.json`（+2 配置项、版本 1.2.6）、`test/mc-status-test.mjs`（+ 粒度/点数/孤立点/明细断言，fixture `hours`→`slots`）、`scripts/mc-trend-preview.mjs`（新增，生预览卡）

**验证**：`node test/mc-status-test.mjs` 106/0；`npm run check:plugins` 清单干净；
`npm run test:smoke` 真 bug 0；`node scripts/undef-scan.mjs plugins/mc-status/` 0 处；
`node scripts/mc-trend-preview.mjs` 出图人工核对（禅）

---

## [1.2.4] - 2026-09-21

**修复（全插件审计）：mc_server_log 的工具 schema 带空 required**

- `required: []` 是合法 JSON Schema，但**部分模型 API 厂商会严格校验并直接拒绝**
  这个 schema —— 一旦被拒，整个工具就废了（不是这一项参数的问题）。
- 没有必填参数时把整个 `required` 字段省略掉，别留空数组。

**附带**：`capabilities` 补上 `status.mc-status`（代码里实现了、清单没声明，
能力表和 UI 口径不一致；不影响运行时，因为能力是按 providers 的键注册的）。

**为什么这么写**

- 两条都不是崩溃级 bug：一个是"某些厂商下会整工具失效"的隐患，一个是清单自洽。
  都不改也能跑，但都属于"将来排障时被误导"的类型。

**涉及**：`plugins/mc-status/index.js`（schema）、`plugin.json`（version → 1.2.4）

**验证**：`node test/tools-skill-audit.mjs`（原报「required 是空数组」已消失）

## [1.2.3] - 2026-09-21

**修复：查了多台服务器，卡片图全对，AI 回复里却只提 1 台**

- 跟 weather-card 1.7.3 是**同一个坑**（那边先发现：查 5 个地区只说 1 个），
  这里按同一套修法处理。模型看不见图，摘要是它唯一依据，问题都出在这一环。
- 两处原因：
  1. `plugin.json` 提示词写着「最多用一句自然的话带过」—— 模型照办，一句话塞不下第二台。
  2. 工具返回 `服务器状态卡已发出：A；B；C…`，**全挤在一行**，模型只挑开头复述。
- **修法**：
  - 提示词改成按台数自适应：1 台一句话带过；**多台必须一行一台**（名字 + 在线/离线 +
    人数 + 延迟四项），明确写「查了 5 台却只提 1 台是要避免的错」；仍不许复述
    MOTD、版本、玩家名单等图上已有的细节。
  - 返回文本改成 `服务器状态卡已发出（共 N 台）：` + **每台一行**。总数给模型可自查的清单。
  - 卡片因 `maxCardRows` 只画前 N 台时，末尾补一句「卡片只画了前 N 台，上面是全部 M 台的
    摘要」—— 摘要本来就是全量（用户会追问「第 9 台呢」），但不说的话模型可能以为
    另外几台没查到。
  - 抽出 `cardSummary(rows, cardCount, hiddenCount)` 并导出到 internals，好让这条能被测试覆盖。

**为什么这么写**

- **不改图片、不改查询层**：图是对的，问题只在"模型读到的文本"这一环。
- **靠结构化清单而不是靠提示词喊"别漏"**：提示词是软约束，长串文本里模型天然只看开头；
  一行一条 + 报总数才是硬保证。

**涉及**：`plugins/mc-status/index.js`（新增 cardSummary、execute 返回文本）、
`plugin.json`（version → 1.2.3、prompt.instruction）、`test/mc-status-test.mjs`（+2 条）

**验证**：`node test/mc-status-test.mjs` 104/0（新增：5 台一台都不能少、卡片只画 8 台时
摘要仍给全量 10 台）；`node scripts/undef-scan.mjs plugins/mc-status` 0 处疑似问题。
⚠️ 提示词走注册，**需要重启机器人才生效**（插件代码热重载可达，提示词不行）。

## [1.2.2] - 2026-09-21
**全插件静态扫描后的收尾修：启动日志版本号写死、数据源标签带主观词**
- **改了什么**：① `BUILD_TAG` 不再手写 `'v1.0.0'`，改成启动时从 `plugin.json` 读版本号；② 数据源标签 `直连服务器（推荐）` 去掉「（推荐）」
- **为什么这么写**：版本号写死的下场就是插件早到 1.2.x 了、启动日志还印 `v1.0.0`，排查时会误以为跑的是旧代码（这次审计就是被它误导了一瞬）；从清单读才能杜绝漂移，读不到退化成 `v?` 不影响启动。「（推荐）」是主观评价，跟之前重写简介时定的口径（只写事实、不写"比别的好在哪"）不一致，而且它会印在卡片脚注上
- **涉及**：`index.js`（BUILD_TAG 改为读文件 + 导出到 internals 便于断言）、`sources.js`（标签）、`test/mc-status-test.mjs`（新增「版本号必须跟 plugin.json 一致」断言 + RCON 协议往返 2 条）
- **验证**：102 通过 / 0 失败；另用临时脚本真跑了四个工具的**成功路径**（假 Java 服务器 + 假 RCON 服务器）：状态查询、指令带地址、曲线、日志三种模式、RCON 执行与危险命令拦截，全部正常无异常
- **审计结论（这次没问题的部分）**：配置项读写一致（无死配置、无缺默认值）、工具声明与注册一一对应、指令词与提示词一致、`src/` 与 `skills/` 无未定义引用

---

## [1.2.1] - 2026-09-21
**修：Java 版查询必报错「useQuery is not defined」（真机首查即触发）**
- **改了什么**：`pingServer` 的参数解构里补上 `useQuery = false`（mcping.js）。v1.2.0 加 Query 协议时函数体里用了 `useQuery`，但解构参数列表漏写了它
- **为什么这么写**：解构缺省参数必须显式列出，函数体里才能拿到 —— 这不是"没传就用 false"的语义，而是直接 ReferenceError。而且出错的代码在 **ping 成功之后**才执行，离线测试全是连接失败、走不到那行，所以 98 条测试全过也没拦住；真机上你的服务器一上线、第一次 ping 成功就炸了，整张卡显示错误查不了
- **涉及**：`mcping.js`（一行）；`test/mc-status-test.mjs` 新增「假 Java 服务器」回归测试 —— 本地起一个只说 Java 状态协议的最小 TCP 服务器（VarInt 帧 + 握手/状态/ping 应答），让 ping 真正成功一次，覆盖"ping 成功之后的代码路径"；并验证 Query 端口没开时静默降级（无 query 字段、不影响 online）
- **验证**：真机 `old.example.com:35674` ping 通（在线 6/20，无 query 字段属正常 —— 服务器没开 enable-query）；测试 99 通过 / 0 失败
- **教训**：给"成功路径"加代码时，离线测试天然测不到它 —— 需要一个能让 ping 成功的桩，这类回归才进得了网

---

## [1.2.0] - 2026-09-21
**接入服务器控制台：日志通道（file / HTTP）+ 报错交给 AI 分析 + Query 协议**
新增三种接入方式，加上原有的 Server List Ping 和 RCON，覆盖到「能接的都接上」：

1. **日志通道**（新增模块 `logtail.js`）—— 来源可设 `file`（直接读 logs/latest.log 尾部）/ `http`（服务端装桥接插件）
2. **排查崩溃**：`\日志` `\报错` `\控制台`；默认提取**报错块**（报错行 + 堆栈 + Caused by 链），交给模型分析原因与解决办法
3. **可选指定分析模型**：开着会额外调一次 API 用点名的模型分析并把结论直接发到会话
4. **Query 协议**（UDP）：完整玩家名单、插件列表、地图名、游戏模式
5. **服务端桥接插件**：`server-bridge/` 下提供 Paper/Spigot 插件源码（含编译安装说明）
**为什么这么写**
- **RCON 拿不到控制台输出**是 Source RCON 协议的硬限制，不是配置问题 —— 想"看到服务器发生了什么"只有读日志一条路。所以日志做成**独立通道**，跟 RCON 并列，不是替代
- 机器人跑在内网、服务器在公网，所以是**机器人主动去拉**（HTTP GET），不是服务器推 —— 机器人这边不用公网 IP、不用开端口
- token 走 `X-MC-Log-Token` **请求头**而不是 URL 参数：URL 会被写进各种访问日志，等于把凭据明文存一份在别人机器上（有测试守着）
- 提取报错**必须连着堆栈**：单看「Could not pass event PlayerJoinEvent」没法判断原因，必须带下面的 Caused by 和栈帧
- **相同堆栈要合并计数**：服务器崩一次会刷几百遍同一个栈，不去重会把上下文占满、还让 AI 以为发生了几百个不同的问题
- ⚠️ 修了一个真 bug：最初把"带时间戳的新 ERROR 行"也当成当前块的续行，导致**连续两条 ERROR 被并成一段**、去重失效。加了 `isLogEntryStart()`：带时间戳 = 新条目另起一块，Caused by / 裸异常类名才是续行
- **额外调模型要花钱** → 开关必须 `=== true`（项目约定：会花钱的默认必须关），失败时静默退回"交给会话模型分析"，不能因为分析模型挂了就连日志都看不到
- 日志默认**仅主人可见**（可能含玩家 IP、聊天），没配主人号一律拒绝（跟 RCON 一致的 fail closed）
- Query 默认关：MC 自己默认也关（enable-query=false），开着没反应就是服务器没开，不能因为拿不到就报错
**涉及**：新增 logtail.js / server-bridge/；mcping.js（Query 协议）、sources.js（query 字段 + useQuery）、index.js（日志工具 + 分析模型 + Query 渲染）、plugin.json（14 项新设置 + 4 个指令词 + 工具 + 提示词）、test（+20 条）
**验证**：测试 98/0（Query 5 条、日志 15 条，含 token 不泄漏、去重、截断、HTTP 三种响应格式）；gate 21 / coverage-offline 全过；Java 插件用 stub 实编 0 错误

---

## [1.1.2] - 2026-09-21
**重写插件简介（去掉主观表述，补齐功能清单）**
- 控制台插件列表里显示的说明文字重写：只陈述功能与规则，删掉评价性表述；补上此前新增但简介里没提的功能（彩色 MOTD、汇总行、人数曲线、播报/告警、RCON、指令带地址查）
**为什么这么写**
- 用户要求"不要带主观"。原文有两处是开发者视角的判断而非客观事实：
  「不经过任何第三方服务 —— 别人家 API 挂了不影响你用」（后半句是评价）、
  「正因为有这道门槛，mc 才敢当指令词」（是设计解释，不是用户需要知道的信息）。
  简介的作用是让人**判断这是不是自己要的插件**，评价性文字帮不上忙还占篇幅。
- 保留全部硬约束（反斜杠门槛、内网地址默认拒绝、开关默认关闭），这些是行为事实不是评价
- 同步把新指令词写进【指令方法】，否则用户不知道有 `\服务器曲线` / `\rcon`
**涉及**：plugin.json（description、version）
**验证**：JSON 合法；mc-status 测试 78/0 通过（含"用户可见文案不许带 MC"的断言）

---

## [1.1.1] - 2026-09-21
**MOTD 简介支持彩色（静态）**
- 卡片上的服务器简介按服务器自带的颜色渲染，粗体/斜体/下划线/删除线一并还原；§k 乱码是动态效果，按用户要求不做，照普通文字显示
**为什么这么写**
- 颜色必须在**协议解析阶段**就留下：`extractText` 为了出纯文本把 color/bold 全丢了，纯文本是回不去的，所以 mcping.js 新增 `parseMotdRich()`（JSON 组件 + §/& 格式码两种来源都认），数据层多带一个 `motdRich` 字段
- 颜色**只认白名单**（16 个 MC 色名 + 严格正则的 #rrggbb）：MOTD 是服务器管理员可控的任意字符串，会把原色名拼进 HTML style，不做白名单等于把 style 注入洞口敞开；文本一律 esc() 转义，style 里只允许 color/font-weight/font-style/text-decoration 四种声明
- **不能直接抄 MC 官方 16 色值**：官方色是为游戏内黑底聊天栏设计的，black(#000000)/dark_blue(#0000AA) 在深色卡上隐形、white/yellow 在浅色卡上糊成一片。给 dark/light 各一套同色系调亮度的表，另对自定义 hex 做可见性兜底（太暗提亮/太亮压暗）
- 片段有上限（200 字符 / 40 段）：服务器可以塞一万个片段把渲染拖死
- 第三方源取值顺序跟纯文本**故意相反**（优先 raw 而不是 clean）：clean 的码已被剥掉没颜色可还原；绝不取 mcsrvstat 的 html 字段，那是别人拼好的 HTML，直接用等于 XSS
- 默认开（`colorMotd` 设置可关）。全默认色（无任何片段带颜色）时不走彩色路径，避免白绕一圈
**涉及**：mcping.js（解析器+白名单）、sources.js（motdRich 字段+取值）、index.js（配色表+渲染+开关）、plugin.json（设置项）、test/mc-status-test.mjs（新增 15 条用例）
**验证**：测试 78/0 通过（含 XSS 转义、style 注入、上限、两套主题）；electron 实渲深/浅两套卡片确认颜色和可读性

---

## [1.1.0] - 2026-09-21

**五件新功能 + 「\mc」指令词回归（都带安全围栏）**

1. **服务器图标上卡**：favicon 其实早就解析出来了（mcping 一直有返回），但
   fetchDirect 没往外传，白丢了。现在贴在卡片左侧（64×64 缩 24px，pixelated 保像素风）。
   ⚠️ 图标是**服务器管理员可控的任意字符串**，`sanitizeFavicon()` 只放行
   `data:image/png;base64` 内嵌 PNG（外链会泄露查询者 IP）、限 200KB、坏值兜底成 🟢。
2. **多台汇总行**：head 下一行「在线 2/4 台 · 共 2 人在线 · 2 台离线或查不通」。
   只累加**真正拿到人数**的台 —— 修了个顺手发现的 bug：`Number(null)` 是 0，
   不加 `!= null` 判断会把"人数未知"当 0 加进总数。只有 1 台时不显示（纯占地方）。
3. **每小时人数曲线**（`\服务器曲线`）：每次真查询（缓存命中不算）都往
   `mc-status-history.json` 记一笔，按小时聚合（存明细会无限膨胀，聚合桶数量固定）。
   卡片是内联 SVG 折线：缺数据的小时**断开而不是画成 0**（画 0 等于谎报"那小时没人"）；
   没数据时给说明文案而不是空图。多台默认画合计线，某小时部分台缺数据时只加有的那些。
   文字版把每小时数字都给模型（模型看不见图，全靠这段回答"几点人最多"）。
4. **人数变化播报 / 宕机告警**（`watchEnabled`，默认关）：定时轮询（最短 30 秒，
   每次都是真实握手），有人进出或服务器开关就往指定群发一条。规矩：
   首轮只记基线不补发（重启后不噪音）、每次最多合并一条消息、静默时段
   （默认 23:00-08:00，支持跨零点）连宕机也不发。**群号是新增敏感项，打包分享前必须删**。
5. **RCON 执行服务器命令**（`rconEnabled`，默认关）：用户点名要"能不用但不能没有"。
   围栏做全了：① 只有**主人**能用（fail closed —— 没配主人号就一律拒绝）；
   ② 默认只放行只读命令（list / whitelist list / seed / time query 等），
   危险命令要显式开 `rconAllowDangerous`；③ 每次执行留审计日志，**日志里绝不带密码**；
   ④ 输出截断 1500 字。协议在 `rcon.js`（Source RCON，零依赖，组包/拆包自己写，
   粘包要自己攒 buffer）。
6. **指令里直接带地址查没配过的服务器**（`\服务器 mc.hypixel.net`）：
   解析出"确实像地址"才认（否则「服务器呢」也被当主机名去连）。
   ⚠️ 内网闸：127.* / 10.* / 192.168.* / 172.16-31.* / 169.254.* / ::1 一律拒绝，
   **域名也先解析再判断**（光看字面量的话，把内网 IP 绑到域名上就绕过去了）——
   不然群里一句话就能让机器人变成内网端口扫描器。真要查自己内网的服，
   显式开 `adhocAllowPrivate`。
7. **`\mc` 指令词回归**：装了反斜杠门槛后闲聊里的"mc"不会误触发，用户同意加回
   `\mc`、`\mc服务器`、`\我的世界`。显示名/工具名/卡片正文仍然不许出现 MC（测试改成了
   "指令词必须带反斜杠"的新规则）。实测门槛：`\mc` / `\MC` / 全角 `＼mc` 都触发，
   裸 "mc"、"mc 怎么样" 不触发。

- 测试：63 通过 / 0 失败（新增 favicon 过滤、汇总、曲线断开与聚合、临时地址解析、
  内网拦截、RCON 协议与 fail-closed、静默时段跨零点、播报基线与去重共 14 条）；
  command-gate 21、_ui-load、coverage-offline 148 全过。
- 新增文件：`rcon.js`（协议层，不做权限判断 —— 权限在工具层，防止有人误以为协议层安全）。
- ⚠️ 生效方式：代码全部热重载可达（子模块都是动态 import+时间戳），但
  **prompt/commands 是启动时读的，要重启机器人才生效**。

## [1.0.4] - 2026-09-21

**多台服务器场景体检：修 4 个问题（都是多服务器才暴露的）**

用 electron 离屏渲染实测 2 / 6 / 10 台三种卡片量出来的：

1. **卡片高度没有上限** —— 10 台实测 1280×2100，发到 QQ 里缩成一团看不清。
   新增 `maxCardRows`（默认 8，0 = 不限制）：超过就只画前 N 台，脚注写明
   「卡片只画前 8 台（共 12 台）」；**给模型的文字摘要仍是全量**，追问「第 9 台呢」
   照样答得出来。抽成 `pickCardRows()` 以便单测。
2. **第一行上方是 2px 粗线** —— 分隔线原写法是「每行画上边框 + 首行去掉」，但
   `.card` 的第一个子元素是 `.head`，没有哪个 `.row` 是首个子元素，**那条去掉的规则
   永远不生效**，于是第一行叠了 head 的下边框 + 自己的上边框。改成 `.row + .row`。
3. **SRV 查询会把整次查询拖住** —— `dns.resolveSrv` 没有超时参数，DNS 不响应时
   这个 Promise 一直挂着；多台并发是 `Promise.all`，会被最慢的那个拖着没有时间上限。
   加了 1500ms 兜底（超时就当没配 SRV，用原端口连 —— 后果远轻于卡住）。
4. **连续两次查询第二次会莫名变文字卡** —— `renderPng` 的并发锁原来直接 `return null`，
   多服务器渲染更慢更容易撞上。改成最多等 2 秒，超时才回退文字。
5. **改 mcping.js 要重启才生效** —— 它是 sources.js 的子模块，静态 import 会命中 ESM
   缓存，热重载拿不到新代码。sources.js 改成动态 import + 时间戳（跟入口那套一致），
   以后改协议实现不用重启。

- 测试：新增 10 条多服务器用例（CSS 分隔线、不丢行、长串不溢出、裁剪与脚注、
  SRV 超时、并发保序、一台失败不影响其它、文字卡措辞）→ 51 通过 / 0 失败。
- 未发现的问题（已验证安全）：并发无共享状态、socket/timer 都有清理、
  `Promise.all` 结果与输入同序、长 MOTD/长名字不横向溢出。

## [1.0.3] - 2026-09-21

**修复：卡片图下面有一大截空白**

- 现象：发出来的状态卡下面一大片空白，离线/失败卡（内容矮）尤其明显。
- 根因（实测）：截图量高用的 `documentElement.scrollHeight`，在**内容比窗口矮**时
  返回的是视口高度、不是内容高度。BrowserWindow 默认 800×600，单服务器卡片内容
  实测只有 329px，却按 600 截图 → 下面 271px 全是背景色空白。
- 修法（`renderPng`）：① 初始窗口高度故意给小（220），量到的才不会被视口托底；
  ② 高度改量 `body.scrollHeight / body.offsetHeight / 卡片底边+body下内边距` 的
  最大值，再 +1 亚像素余量（多出的 1px 是背景色，跟卡片同色看不出来）。
- 实测：截图 1280×600 → 1280×330，空白只剩 1px 背景色。

## [1.0.2] - 2026-09-21

**指令改为反斜杠形式，不带反斜杠不生效**

- 指令：\服务器、\服务器状态、\我的服
- 清单里开了 `commandOnly` + `commands`，由框架层拦截
- 触发词说明里写明：闲聊里说「服务器卡不卡」「我的服开着吗」**不响应**
- 继续遵守上一版约定：所有用户可见文案不含「MC」

**为什么这么写**

- 同 ai-status：用户要求插件指令必须带反斜杠。
- ⚠️ 指令词选「服务器」而不是「MC」，跟"文案不许带 MC"的约定一致。
- 顺带消歧仍然保留：本插件只管**游戏**服务器，机器人自身状态归 ai-status —— 现在两边都要反斜杠，更不会撞。

**涉及**：`plugin.json`（commandOnly / commands / prompt.when / examples / description）
**验证**：`node test/command-gate-test.mjs`（21 项全过）；重启后 `GET /api/tools/availability` 确认没带指令时工具为 `enabled=false / code=command-required`

---
## [1.0.1] - 2026-09-21

**用户可见文案全部去掉「MC」字样，统一叫「服务器」**

- 插件显示名：`MC服务器状态` → `服务器状态查询`
- 工具名：`查MC服务器状态` → `查服务器状态`
- 触发词：去掉「mc」，现在是「服务器状态」「我的服开着吗」「几个人在线」「服务器卡不卡」
  「服务器在线人数」「我的世界」
- 卡片标题 / 文字卡标题：`🎮 MC 服务器状态` → `🎮 服务器状态`
- 未配置时的提示语、发图 note、失败回退日志里的 MC 一并换掉
- 触发词说明里补了消歧：这里的「服务器」指**游戏服务器**，机器人自身的状态/内存/CPU 归 ai-status，别抢

**为什么这么写**

- 用户明确要求：指令方法里不能有 MC，可以有「服务器」。所以凡是**用户能看见或会说出口**的
  地方一律用「服务器」；`Minecraft` 只保留在语义说明里 —— 删掉它模型就认不出「我的世界」
  这种说法了，那属于帮倒忙。
- 插件 id / 目录名仍是 `mc-status`：改目录名要同步 `data/config.json` 的配置键和控制台引用，
  收益为零、风险不小，不划算。
- ⚠️ 顺手消歧：「服务器状态」跟 ai-status 的「状态」只差两个字，容易误触发。
  所以在 description 和 `prompt.when` 里都写明了边界，避免用户问「机器人状态」时被本插件抢走。
- 加了两条回归测试（★ 标记）盯着：卡片/文字卡/摘要里不许出现 MC、工具名和示例指令里不许出现 MC。
  以后谁手滑写回去，测试会红。

**涉及**：`plugin.json`（name/description/prompt.win/examples/tools 名）、`index.js`（工具名、
工具描述、卡片标题、文字卡标题、未配置提示、发图 note）、`test/mc-status-test.mjs`（+2 项）
**验证**：离线测试 41 项全过（原 39 + 新增 2）；`plugin.json` JSON 解析通过

---

## [1.0.0] - 2026-09-21

**新建插件：Minecraft 服务器状态查询**

- QQ 里发「mc」「服务器状态」「几个人在线」「服务器卡不卡」就能查：在线人数/上限、
  版本、延迟、MOTD、在线玩家名单
- 支持 **Java 版 + 基岩版**，可配多个服务器，卡片图优先 + 文字兜底

**为什么这么写**

- **默认必须直连，不能依赖第三方 API。** 这是本次最重要的判断，有实测支撑：
  2026-09-21 本机实测 `api.mcsrvstat.us` **自身 DNS 故障**，返回
  `{"online":false, debug.errors:[{type:"ip",message:"DNS lookup failed"}]}` ——
  明明是它自己坏了，却把服务器报成「离线」；`api.mcstatus.io` 直接返回空。
  而直连 hypixel / mineplex / cubecraft **全部正常**。
  所以协议自己实现（`mcping.js`，零依赖），第三方只作为可切换的备胎保留。
- **`ok` 和 `online` 必须分开。** 查不通（`ok=false`）不等于服务器关了 ——
  可能是网络问题或防火墙丢包。渲染层和给模型的摘要里两者措辞不同：
  端口明确拒绝/主机不可达才说「离线」，超时说「可能已关服，也可能是网络/防火墙拦截」。
  混为一谈会让用户以为服务器炸了，实际只是机器人这边连不出去。
- **第三方源要检测 `debug.errors`。** mcsrvstat 自己出错时也返回 `online:false`，
  不区分就会把「查询服务坏了」说成「你的服务器关了」—— 这是最要命的误报。
  所以带 `debug.errors` 且 `online:false` 时判定为**不可信结果**（`ok=false`），
  错误里明写「查询服务自身出错，建议改用直连」。
- **第三方源不给延迟。** 它返回的是「它到服务器」的延迟，不是你这台机器的。
  冒充成本机延迟会误导「卡不卡」的判断，所以 `latency` 恒为 null。
- **延迟靠 ping/pong 在同一条连接上测**：握手 → Request → Response → Ping → Pong。
  ⚠️ 老版本服务器不回 pong，不能干等，设 2.5s 上限，超时就返回 `latency:null`
  —— 状态照样给，只是没延迟。
- **基岩版只取分号数据的前几段。** 实测 Cubecraft 第 8 段是 "C"，
  该字段在不同版本里语义会漂移（有的版本是地图名、有的是游戏模式），
  多取一段就会冒出「（C）」这种没头没尾的东西。
- **必须解析 SRV 记录**（`_minecraft._tcp.<域名>`）：很多服务器域名和 MC 实际端口
  不一致，不解析就连错端口超时。⚠️ 用户**显式填了非默认端口**时以用户为准（他有可能是故意的）。
- ⚠️ **MOTD 必须做 HTML 转义，而且不能用 `escapeCqText`**。
  那个函数只把 `[CQ:` 换成 `[CQ：`（防 QQ 特殊码），**挡不住 `<script>`**。
  MOTD 是服务器返回的任意字符串，不转义一张卡片就能把 HTML 结构破坏掉。
  用的是 weather-card 第 278 行那套 HTML 转义。
- **握手包 protocol 填 -1**（不检查版本）：任何版本的服务器都能连上，
  写死某个版本号会导致版本不匹配时握手失败。
- **缓存只放 30 秒**：MC 状态变化快（有人进进出出），但连续追问不该每次重新握手。

**涉及**（全部新建）：`mcping.js`（协议）、`sources.js`（数据源）、`index.js`（工具与渲染）、
`plugin.json`、`test/mc-status-test.mjs`

**验证**：离线 39 项 + 联网 2 项全过。真机端到端：
Hypixel 19688/200000 人 / 延迟 248ms / Java 版；Cubecraft 8009/55000 人 / 延迟 81ms / 基岩版；
不存在的地址如实报「查询失败 —— 超时（可能已关服，也可能是网络/防火墙拦截）」而没误报成离线。
机器人加载确认：18 插件 0 失败。

**待办**：服务器列表默认留空，需要用户在控制台填「名称|地址:端口」后才能查。

## 1.2.43 / 2026-10-03 / 简介按**基础版 0.4** 重写（去掉反斜杠指令的写法）

### 改了什么

- 插件简介（ 的 ）整段重写：一律改说「发一句自然语言」/「@机器人 说…」，
  删掉「指令直达」「0 token」「必须带反斜杠」「不带反斜杠的同类说法不生效」这些表述。
- 顺带把简介里的本机路径、数据目录名换成中性说法。
- 本插件实测（基础 0.4）：带不带反斜杠都能触发兜底。
- 版本号按上一条升一位。

### 为什么

基础版 0.4 包里**没有**  / ，orchestrator 里
也没有  —— 即「指令直达」这条通道在基础版上**根本不存在**。
把  写进简介，只会让装了基础版的人以为指令能用。
而实测（基础 0.4 环境里喂消息进 before-context）表明：
不写反斜杠并不会让插件全废 —— 兜底钩子认不认斜杠是**因插件而异**的，
就算不认，**模型那条路仍然走得通**（工具在清单里、描述写清就会调）。

> 结论：简介层面写「发自然语言」对基础版是正确且可行的。
> 那些靠斜杠触发兜底的插件，带斜杠只是**更快更确定**，不是唯一入口。


## 1.2.43 / 2026-10-03 / 简介按**基础版 0.4** 重写（去掉反斜杠指令的写法）

### 改了什么

- 插件简介（plugin.json 的 description 字段）整段重写：一律改说「发一句自然语言」/「@机器人 说…」，
  删掉「指令直达」「0 token」「必须带反斜杠」「不带反斜杠的同类说法不生效」这些表述。
- 顺带把简介里的本机路径、数据目录名换成中性说法。
- 本插件在基础 0.4 上的实测结论：带不带反斜杠都能触发兜底。
- 版本号升一位。

### 为什么

基础版 0.4 包里**没有** skills/command-router.js 与 command-gate.js，orchestrator 里
也没有 resolveDirectCommand —— 也就是说「指令直达」这条通道在基础版上**根本不存在**。
把反斜杠指令写进简介，只会让装了基础版的人以为那能用。

而实测（在基础 0.4 环境里把消息喂进 before-context 钩子）表明：
**不写反斜杠并不会让插件全废** —— 兜底钩子认不认反斜杠是**因插件而异**的；
就算钩子不认，**模型那条路仍然走得通**（工具在清单里、描述写清就会调）。

> 结论：简介层面写「发自然语言」对基础版是正确且可行的。
> 那些靠反斜杠触发兜底的插件，带反斜杠只是**更快更确定**，并不是唯一入口。
