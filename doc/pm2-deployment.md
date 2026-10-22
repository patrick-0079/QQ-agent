# PM2 部署与 Windows 登录自启

## 进程编排

`<项目根>/ecosystem.config.cjs`（仓库上一级目录，随部署环境而定）：

| 进程 | 作用 | 生命周期 |
|---|---|---|
| `qq-agent` | 应用主服务（HTTP/SSE、编排器、OneBot 客户端） | 常驻，崩溃自动重启 |
| `qq-agent-boot` | 等应用就绪后拉起 SnowLuma / 便携 QQ，等 OneBot 连接 | 引导后常驻（idle） |
| `pm2-logrotate` | PM2 日志轮转（已有模块） | 常驻 |

`qq-agent-boot` 引导完成后**不退出**，保持 online。这样 `pm2 save` 会把它存进
dump，登录时你原有的 `PM2 Resurrect on Logon` 任务执行 `pm2 resurrect` 就会
自动把它拉起来，不需要额外的自启入口。

## 常用命令

```bash
pm2 list                       # 查看状态
pm2 logs qq-agent              # 应用日志
pm2 logs qq-agent-boot         # 引导日志
pm2 restart qq-agent           # 重启应用；snowluma.autoLaunch=true 会自动拉起 SnowLuma
pm2 restart qq-agent-boot      # 手动补跑引导（拉起 SnowLuma/QQ）
pm2 stop qq-agent qq-agent-boot
pm2 start ecosystem.config.cjs # 首次/恢复
pm2 save                       # 保存进程列表，供登录时 resurrect
pm2 delete qq-agent qq-agent-boot
```

数据/迁移命令仍走 `manage.mjs`，但**应用运行中 `data migrate/compact` 会拒绝执行**：

```bash
node manage.mjs status
node manage.mjs data stats
node manage.mjs data doctor
```

需要迁移时：`pm2 stop qq-agent qq-agent-boot` → `node manage.mjs data migrate` → `pm2 start qq-agent`。

## Windows 登录自启（沿用本机已有任务）

本机已存在计划任务：

```
任务名：PM2 Resurrect on Logon
路径：  \
触发：  用户 <用户名> 登录时
动作：  wscript.exe "%LOCALAPPDATA%\Programs\pm2-autostart\pm2-resurrect-hidden.vbs"
VBS：   隐藏执行 "%APPDATA%\npm\pm2.cmd" resurrect
```

该任务创建于 2026-10-21 09:07，最近一次运行结果 0。**本次没有新增第二个自启入口**；
之前临时加的 Startup VBS 已删除，Startup 目录只剩 `DeepSeek Harness.lnk` 等原有项。

PM2 7 在 Windows 上没有 init system，`pm2 startup` 会报 `Init system not found`，
所以保留“登录任务 + `pm2 resurrect`”这套机制即可。

### 验证自启

```powershell
pm2 kill
& wscript.exe "%LOCALAPPDATA%\Programs\pm2-autostart\pm2-resurrect-hidden.vbs"
# 或者：Start-ScheduledTask -TaskName 'PM2 Resurrect on Logon'
# 等 20~30 秒
pm2 list
node manage.mjs status
```

正常结果：`qq-agent` online、`qq-agent-boot` online、OneBot 已连接。

## 限制与注意

- **登录级自启**：需要用户登录后触发（现有任务就是 Logon 触发）。若要在登录前/
  无人登录时运行，需要把 PM2 注册成 Windows 服务或管理员级计划任务（需管理员权限）。
- 便携 QQ 的登录态保存在 `source/runtime/qq-portable-data`；如果登录失效，
  开机后仍需扫码。`qq-agent-boot` 等待 120 秒后放弃连接，但进程保持 online，
  应用本身可用，可在控制台手动启动 QQ。
- `qq-agent-boot` 常驻会占用约 50–60 MB 内存；它不会周期性重启 SnowLuma/QQ，
  避免与用户手动“停止”冲突。
- `pm2 restart qq-agent` 会重启应用并杀掉其子进程 SnowLuma；已设置
  `snowluma.autoLaunch=true`，应用启动时会自动重新拉起 SnowLuma。
- QQ 进程（`QQ.exe`）不由 PM2 管理；应用重启时它继续运行，真机重启后由
  `qq-agent-boot` 通过 `/api/qq-portable/launch` 拉起。
- 删除自启：需要删除 `PM2 Resurrect on Logon` 计划任务（`Unregister-ScheduledTask`，
  可能需要管理员）；恢复手动：`pm2 delete qq-agent qq-agent-boot` 后用
  `node manage.mjs start --all`。
