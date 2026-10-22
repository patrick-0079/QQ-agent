# 正在输入提示（私聊）

私聊里让机器人像真人一样亮起「对方正在输入…」：从它决定要回话（开始准备）到最后一条消息发出之间，对方的聊天窗顶栏一直显示正在输入，消息发出后自动收尾。**零 token**：不改提示词、不注册工具、不调模型，只在对的时机补发状态包。

## 它做了什么

QQ NT 里「正在输入」是一个 C2C 输入状态通知（上行 oidb `0xcd4` subcmd 1，对方收到 `0x210-0x115` 推送）。协议端 SnowLuma 已经把它做成了 OneBot action，所以插件只要在对的时机调它：

```
POST /set_input_status   { user_id: 123456, event_type: 1 }
```

`event_type = 1` 是「正在输入」（`3` 是「正在讲话」，即录音中）。

时间线（全部可配）：

```
对方发来消息
   │
   ├─ before-context 钩子触发（= 核心开始准备回话）
   │      └─ 等 firstDelayMs（默认 400ms）→ 亮起
   │
   ├─ 每 pingIntervalMs（默认 3500ms，±20% 抖动）刷新一次，保持亮着
   │      （QQ 的「正在输入」会过期，不刷新中途就熄灭）
   │
   └─ 收尾（四条线先到先算）
          · 模型调 finish          → 立刻收
          · 最后一条消息发出后      → 再等 postSendTailMs（默认 2500ms；连发两三条时继续亮着）
          · 一直没发出消息          → silentGraceMs 后撤掉（默认 60s，模型想完决定不说话时别吊着对方）
          · 单轮硬上限              → maxTypingMs（默认 120s，防卡死轮次里无限刷新）
```

## 为什么只有私聊

这个状态通知本身就是 C2C 专属的（oidb 请求里 `chatType=0`），**群里 QQ 根本不显示「正在输入」**，发了也是白发、还白多一次请求，所以群聊一律跳过。这是协议的限制，不是本插件没做。

## 安装

1. 把 `typing-indicator/` 整个文件夹放进机器人的 `plugins/` 目录；
2. 重启 QQ Agent（或在「插件」页点一下刷新）；
3. 到「插件」页确认卡片是「生效中」。它默认开启。

前置条件：配置里要有 SnowLuma 的 HTTP 地址（`snowluma.httpUrl`，默认 `http://127.0.0.1:3000`）。没有的话设置弹窗会直接告诉你原因，不会静默失效。

## 设置项

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | 开 | 关掉就完全不发状态包 |
| `firstDelayMs` | 400 | 亮起延迟。像人先抬手再打字，0 会显得有点抢 |
| `pingIntervalMs` | 3500 | 刷新间隔。太短浪费请求，太长中途熄灭 |
| `postSendTailMs` | 2500 | 发出消息后的收尾延迟。机器人常连发两三条，这个窗口里继续亮着 |
| `silentGraceMs` | 60000 | 一直没发出消息时的静默上限 |
| `maxTypingMs` | 120000 | 单轮硬上限 |
| `skipChats` | 空 | 不生效的会话，如 `private:123456`，多个用逗号分隔 |
| `logPings` | 关 | 排查用。打开后亮起/每次刷新/收尾全写日志 |

## 怎么确认它在工作

看 `data/logs/qq-agent-<日期>.log`：

```
[typing-indicator] 已上线：私聊准备回话时亮起「正在输入」，每 3.5 秒刷新一次…
[typing-indicator] 收尾（消息已发出）：private:2939749248 亮了 11.6 秒、刷新 3 次、发出 2 条
```

协议端日志（`snowluma/logs/`）里能看到对应的 `[Bridge.Action] set_input_status params=user_id=… event_type=1`。

## 兼容性与实现说明

- 适配 apiVersion 1（`setup(api)` + `hooks` + `providers`）。
- 只做**观测**地挂了一层 `OneBotClient.prototype.call` 补丁（用来知道"这条私聊真的发出消息了"），原样转发、失败不影响发送本身。
- 状态与定时器全部挂在 `globalThis`，热重载不会变成两个 ticker、两份账。
- 通过 `status.typing-indicator` 能力在「AI 状态」面板显示已触发轮次/状态包数/上次时长。
- 另外提供软依赖能力 `typing.indicate`：别的插件也能让某个私聊亮起正在输入。

## 隐私

插件不读聊天内容、不写数据目录以外的文件、不发任何外部网络请求 —— 全部流量只到本机协议端（`snowluma.httpUrl`）。落盘的只有 `data/typing-indicator/state.json` 里的一份累计统计（轮次/包数/上次时长）。
