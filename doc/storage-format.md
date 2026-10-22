# 存储格式（P1 / P2）

> 适用版本：2026-10-22 起。旧数据**无需手动迁移**即可启动；首次启动会在后台把旧版会话压缩归档。

## 1. 总览

| 数据 | 位置 | 格式 | 写频率 |
|---|---|---|---|
| 消息存档快照 | `data/messages/<chat>.json` | JSON | 仅压缩时 |
| 消息增量 | `data/messages/<chat>.jsonl` | JSONL（一行一事件） | 每条消息 |
| 会话索引 | `data/sessions/index.jsonl` | JSONL（一行一会话） | 每次运行结束 |
| 会话完整档案 | `data/sessions/archive/<id>.json.gz` | gzip(JSON) | 每次运行结束 |
| 运行中摘要 | `data/sessions/running/<id>.json` | JSON（≈1KB） | 每 2 秒节流 |
| 旧版会话档案 | `data/sessions/<id>.json` | JSON | 只读兼容 |
| 配置 / 记忆 / 表情 / 用量 | 同旧版 | JSON | 不变 |

设计原则：**热数据追加写，冷数据压缩存；索引可重建，原始档案才是真相。**

---

## 2. 消息存档

### 2.1 文件

```
data/messages/group_976685145.json     # 快照
data/messages/group_976685145.jsonl    # 增量事件
```

旧版 `group_976685145.json` 直接作为快照读取，**不需要迁移**。

### 2.2 快照

```jsonc
{
  "version": 2,
  "chatKey": "group:976685145",
  "seq": 1275,          // 已合并到的事件序号
  "nextLocalId": 1271,  // 下一条消息的本地 id
  "messages": [ /* 原条目结构不变 */ ]
}
```

### 2.3 增量事件

每行一个 JSON，`seq` 单调递增：

```jsonc
{"seq":1270,"t":"m","n":1271,"m":{ /* 消息条目 */ }}
{"seq":1271,"t":"read","all":true}
{"seq":1272,"t":"read","ids":[1268,1269]}
{"seq":1273,"t":"unread","ids":[1269]}
{"seq":1274,"t":"recall","mid":"937688924"}
{"seq":1275,"t":"edit","id":1270,"text":"...","media":[...]}
{"seq":1276,"t":"del","ids":[1200,1201]}
{"seq":1277,"t":"trim","minId":1300}
{"seq":1278,"t":"clear"}
```

- `m` 的 `n` 携带新的 `nextLocalId`，保证删除/清空后 id 不倒退。
- 所有事件幂等：`seq <= 快照.seq` 的事件在回放时跳过。

### 2.4 压缩与崩溃恢复

- 触发条件：增量 ≥ 2000 行或 ≥ 2MB，或执行 `clear`。
- 顺序：**先写快照（含 seq）→ 再截断增量**。
  - 若进程在两步之间退出，下次回放会因 `seq <= 快照.seq` 跳过已合并事件，不会重复。
- 增量末尾允许是崩溃留下的半行：
  - 读取时忽略；
  - 下一次追加前若文件末字节不是 `\n`，先补一个换行，避免把新事件拼到坏行上。

### 2.5 插件读取

插件不要直接读 `messages/*.json`（它只是快照，可能落后于增量）。使用：

```js
import { readChatState } from '../../src/storage/chatlog.js';
const state = readChatState('group:123');   // 快照 + 增量回放
```

内置 `cross-memory` 已改为该入口。

---

## 3. 会话档案

### 3.1 文件

```
data/sessions/index.jsonl                 # 一行一个已结束会话
data/sessions/archive/<id>.json.gz        # 完整档案（提示词/消息/发送记录）
data/sessions/running/<id>.json           # 运行中摘要
data/sessions/<id>.json                   # 旧版完整档案（只读 + 后台迁移）
```

### 3.2 索引行

```jsonc
{
  "id": "mvi7drb0-f487fa7b",
  "chatKey": "group:1107480004",
  "startedAt": 1792592652924,
  "endedAt": 1792592677010,
  "status": "done",
  "usage": { "promptTokens": 23444, "completionTokens": 143, "totalTokens": 23587,
             "cachedTokens": 22912, "calls": 2 },
  "model": "deepseek-v4.1-flash",
  "vendor": "opencode.ai",
  "trigger": "……",
  "promptChars": 12071,
  "rounds": 2,
  "webSearchCount": 0,
  "usageRows": [ { "at": 1792592654000, "p": 12000, "c": 80, "cached": 11000, "model": "…" } ],
  "toolCounts": { "send_message": 1, "finish": 1 }
}
```

- `usageRows` 让用量页不需要解压全部档案即可按次统计；
- `/api/sessions` 返回的摘要会剥掉 `usageRows` / `toolCounts`，避免响应体膨胀；
- 需要完整对象时走 `GET /api/sessions/:id`（服务端按需解压 gzip）。

### 3.3 运行中

- `create` 只写 `running/<id>.json`，内容为摘要，不含提示词与消息；
- `update` 每 2 秒最多写一次（`#persistThrottled`）；
- `finish` 写 `archive/<id>.json.gz`、追加一行索引、删除 running、累加今日用量；
- 进程崩溃后遗留的 running 摘要，下次启动会回收成 `aborted` 的 `partial` 档案。

### 3.4 保留策略

`store.keepSessionFiles`：

- `0` = 不限（默认，与旧版一致）；
- `N > 0` = 只保留最近 N 个已结束会话，超出部分删除 gzip 档案并重写索引。

---

## 4. 迁移、压缩与体检

```bash
node manage.mjs data stats                 # 查看新旧格式数量与占用
node manage.mjs data doctor                # 只读体检
node manage.mjs data doctor --fix          # 隔离坏文件、修 JSONL 坏行、清陈旧 tmp/锁
node manage.mjs data migrate               # 旧版 sessions/<id>.json → gzip + 索引
node manage.mjs data compact               # 压缩消息增量 + 重建会话索引
node manage.mjs data backup                # 打包到 backup/data-<时间>.zip
```

- `migrate` / `compact` 会先检查应用是否在运行（PID + 端口）；运行中拒绝执行，
  确认无写入后可加 `--force`。
- 迁移是**先写 gzip、解压校验 id、再删旧文件**；校验失败会保留旧文件。
- 想保留旧文件人工核对：`QQ_AGENT_KEEP_LEGACY_SESSIONS=1`。

### 回滚

新版只读旧 `.json` 快照/档案，因此回滚到旧版本不会丢数据；但旧版本读不到新的
`.jsonl` 增量与 gzip 档案。回滚前先执行：

```bash
node manage.mjs data compact
```

它会把增量折回 `.json` 快照、把会话索引重写成完整档案所需的形态（旧版本可直接读
`sessions/<id>.json` 的场景需保留旧文件，建议迁移时设置 `QQ_AGENT_KEEP_LEGACY_SESSIONS=1`）。

---

## 5. 兼容性说明

- `ChatStore` / `SessionRegistry` 的公开方法签名未变，`orchestrator`、`routes` 无需改动。
- 直接读 `data/sessions/*.json` 的扩展需要改用：
  - `readIndexEntries()`：会话摘要（含 usage）；
  - `readSessionFull(id)`：按需读完整档案；
  - `readChatState(chatKey)`：消息快照 + 增量。
- 已同步修改：`cross-memory`、`token-ledger`、`usage-report`、`telemetry`、`app.js` 用量统计。
