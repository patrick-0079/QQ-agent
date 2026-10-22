# MCP 桥

给 QQ agent 装一个 **MCP 客户端**：把任意 MCP 服务接进来，模型能直接调用它的工具，其它插件也能借来用。

> 装好即用：默认内置 **GameHOT 资讯**（匿名只读，7 个工具），不需要 API Key。
> 在群里问一句「今天有什么游戏新闻」就能看到效果。

---

## 一、你会得到什么

**给模型 3 个工具**（它会自己判断什么时候用）：

| 工具 | 作用 |
|---|---|
| `mcp_list` | 列出已接入的服务与工具（含参数名），调用前先看这个 |
| `mcp_call` | 调用某个服务里的工具（`server` + `tool` + `arguments`） |
| `mcp_reload` | 改完配置或服务崩了，重连一次 |

**给其它插件 2 个能力**（代码确定性调用，不花 token）：

| 能力 | 作用 |
|---|---|
| `mcp.call` | `{ server, tool, arguments }` → `{ ok, text, raw }` |
| `mcp.list` | 同步返回各服务状态与工具清单 |

**默认接入的服务**：

| 服务 | 能做什么 | 前提 |
|---|---|---|
| `gamehot` | 资讯精选、搜索、热点榜、事件时间线、日报/周报/月报 | 无需配置，匿名只读 |

---

## 二、快速开始

1. 在「插件」页启用 **MCP 桥**（市场安装后默认就是启用的）。
2. 确认能连通：工具列表里出现 `mcp_list` / `mcp_call` / `mcp_reload`。
3. 在群里问：「今天有什么游戏新闻？」——它会先 `mcp_list`，再 `mcp_call` GameHOT。

想加服务：控制台 → 插件 → MCP 桥 → 设置 → 「MCP 服务配置（JSON）」追加即可（见下）。

---

## 三、配置项

| 设置 | 默认 | 说明 |
|---|---|---|
| MCP 服务配置（JSON） | 内置 GameHOT | 所有服务都写在这里；格式见下 |
| 配置文件路径 | 空 | 想单独放一个 JSON 文件时填，比如 `data/mcp-servers.json`；文件存在时优先读它 |
| 启用时自动连接 | 开 | 关掉后第一次调用或 `mcp_reload` 时才连（适合启动慢的服务） |
| 单次调用超时（毫秒） | 60000 | 抓网页、跑查询这类工具较慢；超时会明确报错 |
| 输出截断长度（字符） | 4000 | 防止一次返回撑爆上下文，超出会注明总长度 |

### 配置格式

直接粘 Claude Desktop 的 `mcpServers`：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:/data/mcp-share"]
    },
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest", "--headless", "--browser", "chrome"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxx" }
    },
    "远程服务": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer xxx" }
    }
  }
}
```

也支持 `{ "servers": [ ... ] }`、裸数组 `[ ... ]`、扁平对象 `{ "fs": { ... } }`。
单个服务可以用 `"enabled": false` 临时停掉，`"timeoutMs"` 单独设超时。

---

## 四、给插件开发者

```js
export function setup(api) {
  const mcp = api.capability('mcp.call');     // 软依赖：没装/没启用就跳过
  if (!mcp) return;

  const { ok, text } = await mcp({
    server: 'gamehot',
    tool: 'gamehot_search',
    arguments: { query: '任天堂', limit: 5 }
  });
  api.log(ok ? text : '查询失败');
}
```

判断某个服务在不在：

```js
const list = api.capability('mcp.list')?.() || [];
const ready = list.some((s) => s.name === 'github' && s.status === 'ready');
```

---

## 五、排障

| 文件 | 内容 |
|---|---|
| `data/mcp-bridge/status.json` | 每个服务的状态、工具清单、错误原因 |
| `data/mcp-bridge/<服务名>.log` | 该服务自己的输出（启动失败、报错都在这） |
| `data/mcp-bridge/last-error.log` | 最近若干条连接/调用错误 |

常见问题：

| 现象 | 原因 / 处理 |
|---|---|
| 状态 `error`，`命令不存在` | 服务端没装：`npm i -g xxx`，或确认 `npx` 在 PATH |
| 首次调用很慢 | `npx -y` 在下载依赖；装成全局或改用本地路径会快很多 |
| `tools/call 超时` | 调大「单次调用超时」；有的服务首次启动要一分钟 |
| 连上了但没有工具 | 该服务没声明 tools 能力，或版本太老 |
| 401 / 403 | 需要令牌：放进 `headers` 或 `env` |
| 工具列表没更新 | 服务新增了工具：调 `mcp_reload` |

---

## 六、安全边界（刻意的）

- **只能连配置里显式列出的服务**，模型无法动态添加 —— 否则「让它跑个命令」就等于给了它 shell。
- 文件类服务建议只挂一个专用目录（示例里就是这么写的），不要挂整个磁盘。
- 输出截断、图片单张 ≤8MB 落盘，防止撑爆上下文或磁盘。
- 子进程无窗口（`windowsHide`），Windows 上 `npx` 经 `cmd /d /s /c` 启动。
- 远程服务请用长期令牌放 `headers`，插件不做 OAuth 授权跳转。

---

## 七、已知不支持（以及影响）

| 没做的能力 | 原本用途 | 影响 | 替代 |
|---|---|---|---|
| OAuth 授权跳转 | 浏览器登录换可刷新 token（Notion/Google/Slack） | 只认 OAuth 且不发长期令牌的服务连不上 | 后台建长期 token 填 `headers` |
| sampling | 服务端借客户端的模型做生成（如总结网页） | 依赖它的工具功能缺失 | 让机器人自己读内容再总结 |
| roots | 服务端问「允许碰哪些目录」 | 无损失，文件服务退回启动参数里的目录 | 参数里写死目录 |
| 推送订阅 | 工具/资源变化主动通知 | 工具变化要 `mcp_reload`；资源更新不会自动感知 | 定时轮询 |

---

## 八、实现说明

| 项 | 值 |
|---|---|
| 传输 | stdio（按行 JSON-RPC）、HTTP Streamable（`application/json` 或 `text/event-stream`） |
| 协议 | MCP `2024-11-05`（接受服务端回传的更高版本；HTTP 请求带 `mcp-protocol-version`） |
| 实现范围 | `initialize` / `tools/list` / `tools/call` / `ping` / `notifications` |
| 依赖 | 零第三方依赖（市场禁止 `node_modules`），协议层自行实现 |
| 测试 | `node test/mcp-bridge.mjs`（stdio / HTTP-JSON / HTTP-SSE / 图片落盘） |
| 打包 | `node scripts/pack-plugin.mjs mcp-bridge` |

---

## 九、致谢

协议参考 [Model Context Protocol](https://modelcontextprotocol.io) 规范（MIT）；
默认服务由 [GameHOT](https://gamehot.xiaoxun.xyz) 提供，匿名只读。
