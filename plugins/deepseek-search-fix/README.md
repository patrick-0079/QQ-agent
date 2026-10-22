# DeepSeek 搜索修补（QQ Agent 插件）

修好内置的 DeepSeek 联网搜索 —— **模型完全无感知，不需要任何设置**。

## 它修的是什么

QQ Agent 内置的 DeepSeek 搜索走 OpenAI 风格的 `/responses` 端点 +
`tools: [{ type: 'web_search' }]`。该端点会**接受**这个工具声明，但
**从不执行**搜索，最后退化成把模型自己说的一段话当"搜索结果"返回：

```json
{ "query": "...", "results": [{ "title": "DeepSeek 搜索", "url": "", "snippet": "模型写的一段话" }] }
```

实测 746 次调用里 **466 次（62.5%）** 是这个形状 —— 零链接。
更糟的是那段 snippet 是模型的推测，看起来像答案，于是机器人会拿它当事实回答。

DeepSeek 真正的原生搜索在 **Anthropic 兼容端点**上：

```
POST <baseUrl>/anthropic/v1/messages
headers: x-api-key + authorization + anthropic-version: 2023-06-01
body.tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: N }]
```

响应 `content[]` 里的 `web_search_tool_result` 块才是带 `url` / `title` / `page_age` 的真结果。

## 怎么做修补的（关键）

不注册工具、不改提示词、不加按钮 —— 只挂一个 `after-tool` 钩子：

```
模型调用 web_search
   ↓
内置实现跑完，返回假结果
   ↓
★ 本插件在 after-tool 里检查：没有一条结果带 http 链接？
   ↓ 是
发一次原生搜索 → 就地替换 result.content / result.isError
   ↓
模型看到的是真结果。它不知道中间发生了什么。
```

为什么可行：`orchestrator` 的顺序是「先执行工具 → 再跑 `after-tool` 钩子 → 之后才读取
`result.content`」，所以在钩子里改写是有效的。

## 什么时候完全不动（零开销）

| 情况 | 行为 |
|---|---|
| 搜索提供方不是 `deepseek`（如 bing / 博查 / 智谱） | 完全不介入 |
| 结果里只要有一条带 `http` 链接 | 认为是好结果，放过（打过核心补丁的机器也走这条） |
| 结果是「没搜到」（`results: []`） | 放过，不重复搜 |
| 修补自身失败（网络/Key 问题） | 保留原结果，**不比装之前更差** |

## 成本

- **正常使用：0**（只在检测到坏结果时才多一次调用）
- 触发修补时：额外一次原生搜索调用（约 1.2k~3k input tokens）
- 相比"让模型看到假结果然后说错话、再多聊几轮"的代价，这笔钱通常更划算

## 配置

默认**零配置**：留空即复用应用里已配置的 DeepSeek Key / 地址。

| 设置项 | 默认 | 说明 |
|---|---|---|
| DeepSeek API Key | 空 | 留空 = 用应用里的 |
| 接口地址 | 空 | 留空 = 用应用里的；自动换算成 `/anthropic/v1/messages` |
| 模型 | `deepseek-v4-flash` | Anthropic 兼容端点上的模型名 |
| 单次最多检索次数 | 5 | 1~10 |
| 最多返回几条结果 | 10 | 按 URL 去重后截断 |
| 超时 | 120000 | 毫秒 |
| 连报错也一并修补 | 开 | 内置直接报错时也补一次 |
| 只在提供方是 deepseek 时生效 | 开 | 换用其它搜索源时完全不介入 |

## 权限与安全

- 只声明 `web_fetch`（访问 DeepSeek 端点需要联网）
- 不读取聊天记录、不写文件、不发消息
- 不注册工具、不注入提示词、不改任何全局状态
- 压缩包内不含任何密钥

## 已知限制（请如实告知用户）

这个修补依赖一个**未写进文档**的实现细节：`after-tool` 钩子拿到的 `result`
是同一个对象引用，且 orchestrator 在钩子之后才读取它。
如果将来作者把结果改成不可变（`Object.freeze` / 深拷贝），本插件会**静默失效** ——
表现回到"假结果"，**不会更糟**。

根本解仍然是修核心（换端点 + 严格模式）。

## 目录

```
deepseek-search-fix/
├── plugin.json    清单
├── index.js       入口（hooks['after-tool'] + setup）
└── README.md      本文件
```
