# RollPig 市场包安装说明（重要）

> 文档性质：**安装说明**（面向市场包用户），会被打包成市场包里的 `INSTALL.md`。

这个市场包**只包含 QQA 插件层**（`plugin.json` + `index.js` + 帮助图），不包含 Python 侧车。

RollPig 的卡片渲染依赖上游 `nonebot-plugin-rollpig-plus`（Pillow、字体、表情资源），
而 QQA 的 `qq-agent` 容器内没有 Python 3，市场包也不能执行 `.sh` 安装脚本。
因此：

> **只安装这个市场包，插件能加载，但所有指令都不会生成卡片；**
> 消息会被放回 QQA 的普通聊天流程，表现为“机器人没反应/普通回复”。

## 正确安装顺序

### 1. 先安装侧车（一次性）

Linux（Docker 或原生）在服务器上执行（需要 root）：

```bash
git clone https://github.com/TLeoJU/qqa-rollpig.git qqa-rollpig
cd qqa-rollpig
sudo ./scripts/install.sh
```

如果 QQA 不在 `/opt/qq-agent`：

```bash
sudo QQA_HOME=/path/to/qq-agent ./scripts/install.sh
# 没有 Docker、QQA 和侧车同机时：
sudo QQA_DEPLOY_MODE=native ./scripts/install.sh
```

Windows 原生 QQA 不能跑 `install.sh`，按 [windows.md](windows.md) 手动部署；
关键是把 `QQA_MEDIA_URL_PREFIX` 设成 QQA 能读到的**绝对路径**，而不是 `/media`。

验证：

```bash
curl -s http://127.0.0.1:18765/health
systemctl status rollpig-sidecar --no-pager
```

### 2. 再安装这个市场包

在 QQ Agent 控制台「插件」页安装/启用「今日小猪（RollPig）」。
市场包只会覆盖插件目录，不会动侧车。

### 3. 验证

在群里发送：

```text
小猪帮助
今日小猪
```

应收到帮助长图 / 今日小猪卡片，并且**不会**产生 LLM 文字回复。

## 如果只装市场包

插件会显示已加载，但：

- 所有需要卡片的指令都会因为没有侧车而回退到 QQA 普通聊天；
- `小猪帮助` 仍可用：先试插件设置里的 `helpImage`（默认
  `/media/rollpig/help/rollpig-help.png`），失败后读取市场包内的
  `assets/rollpig-help.png` 以 base64 发送；只有两张图都不可用时才回退文字；
- 侧车未运行时，日志会出现 `fetch failed` / `sidecar unavailable`。

此时请按上面的“先安装侧车”补装，然后重启 QQA 或触发热重载。

## 市场包为什么不包含侧车

市场包只放 QQA 插件层，侧车需要 Python 3.10+、venv 和常驻进程，必须在服务器上单独安装；市场包本身不执行安装脚本，也不会在 QQA 容器内启动进程。

## 链接

- 本仓库：你下载或克隆它的 GitHub 页面
- 上游：<https://github.com/Felis2026/nonebot-plugin-rollpig-plus>
- 问题反馈：请附 `journalctl -u rollpig-sidecar -n 100 --no-pager` 与 QQA 插件页错误原文。
