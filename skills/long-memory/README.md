# QQ Agent 长期记忆技能 v1.0.1

给 DeepSeek 使用的本地记忆工具。沿用所提供 qqzone 技能的 `skill.json + setup(api) + registerTool` 契约。需要 QQ Agent 向工具传入 `kind/chatId` 或 `chatKey`；不读取账号密码，不访问网络，不另外调用模型。

## 安装

1. 解压 `long-memory-1.0.1.zip`，把完整 **long-memory** 文件夹放到 QQ Agent 的 **skills** 目录，和 **qqzone** 文件夹并列。
2. 保留 `vendor` 文件夹、`store.js` 和 `package.json`；不是只复制 index.js。
3. 在 QQ Agent 技能设置中启用“长期记忆”，重新加载技能/重启程序。配置开关为 `config.skills['long-memory'].enabled`。
4. 开始一个能加载新工具及提示词的会话，先说：**“调用 long-memory__status 检查记忆功能。”**
5. 然后试：**“记住我喜欢巧克力蛋糕。”** 重启后问 **“我喜欢吃什么蛋糕？”**，再说 **“忘掉我喜欢蛋糕这件事。”**。检查工具结果，不能只听模型口头答复。

无需下载/安装 MySQL、PostgreSQL、Redis，也无需 npm install。SQLite 引擎已内置为 sql.js 1.13.0 + WASM，不依赖原生扩展编译或 Node 的内置 SQLite。需要宿主支持 ES 模块、Node 文件API和 WebAssembly；目标 Node 18+。已在本机 Node 24 实测，未在实际 QQ Agent/Electron 内实测。

## 数据在哪里

按优先级寻找**数据根目录**：技能配置 `dataDir` → 环境变量 `QQ_AGENT_DATA_DIR` → 检测到 `src/skills.js` 的应用根下 `data` → 标准 `skills/long-memory` 布局对应的应用根下 `data`。

最终文件为：`<数据根目录>/long-memory/memory.sqlite`。目录首次使用时自动创建，必须可写。无法确定位置时明确报错，不悄悄写到未知位置。

`dataDir` 必须是绝对目录，不是 .sqlite 文件名；例如 Windows `D:\QQAgentData`，Linux `/var/lib/qq-agent/data`。不要在使用后随意更改，否则程序会看到另一份数据库。Docker 请挂载这个数据根目录到持久卷。换机器时关闭机器人，再复制数据库文件。

## 如何记、如何查

- DeepSeek 按附带提示词自行精选记忆。**每次 save 硬限制1～2条**；每轮总计最多1～2条是提示词约定，宿主未提供回合ID，插件无法跨调用强制统计每轮额度。
- 不强制每轮保存，允许0条；不自动扫描聊天，不自动导入旧印象库。
- 四类记忆：profile 人物档案；event 重要事件；task 未完事项；summary 简短摘要。
- 同会话、同人物、同类别的相同正文去重。同主题 key 的正文变化要求 update，避免直接新增矛盾档案。不是语义级去重，近义重述仍需模型判断。
- search 使用中文二字组合和中英文关键词匹配，最多5条、记忆内容合计约6000字符。不做向量语义检索，不保证任意同义表达都能搜到。
- update 需要最新 revision，避免覆盖较新的内容。正文及依据必填，未填写的标签/来源/确定性/状态保留原值；确定性不变且不填有效期时保留原过期时间。
- 默认期限：明确档案长期，事件180天，待办90天，摘要30天；推测默认7天且最多30天。每次访问数据库时物理清理过期记忆；没有后台定时任务。待办完成后仍可 review，但不再进入 search。
- source_message_id 和 evidence 由模型提供，**没有验证聊天原文**，结果固定标记 source_verified=false。推测不能当事实。

工具名由 QQ Agent 加前缀：

| 工具 | 用途 |
|---|---|
| `long-memory__save` | 精选保存1～2条，重复内容不新增 |
| `long-memory__search` | 按当前话题检索最多5条 |
| `long-memory__update` | 修改原事实、更新待办，用id和revision |
| `long-memory__forget` | 按ID物理删除1～20条，无清空全库工具 |
| `long-memory__review` | 分页查看当前会话档案，包括已完成待办 |
| `long-memory__status` | 检查数据库、当前会话条数和能力限制 |

模型示例参数：

```json
{"items":[{"category":"profile","key":"饮食/甜食","content":"喜欢巧克力蛋糕","evidence":"用户说：我喜欢巧克力蛋糕","certainty":"stated","tags":["饮食","蛋糕"]}]}
```

检索：`{"query":"喜欢什么蛋糕","limit":3}`。更新或删除前先获取实际ID，不能猜测ID。

## 会话隔离和群聊

数据库查询范围由宿主 `ctx` 决定，模型不能指定 scope/path。私聊只访问当前聊天对象的私聊库，不能指定其他QQ。群聊只能访问本群库，可通过真实 `subject_qq` 给不同人物分块，公共事项用 `shared`。

群聊是**本群公共记忆**：没有做群管理员权限校验，本群成员共用工具，可发起查看/修改/遗忘；不要存私密信息。若不需要群聊记忆，关闭 `allowInGroup`。同一QQ在不同群、私聊的档案不自动互通，这是刻意保留的隔离边界。

遗忘会删除当前活动数据库的记录、来源与证据，不保留隐藏历史表/全文索引。数据库启用 secure_delete；本机测试验证删除后文件不再包含对应文本。插件不自动制作历史备份。**这不等于擦除操作系统快照、外部备份或原聊天记录**；若自行备份，需要同步管理这些副本。

## 存储规模和异常

为了随包部署，sql.js 会在操作时加载 SQLite 文件，并在修改成功后整体导出，写临时文件、fsync、原子替换。适用于一个机器上低频精选的小型记忆库；不是高并发数据库服务器。默认每会话2000条、可设10～10000条，整个文件硬上限32MB。超过限制明确报错，不自动清除有效记忆。

每次操作通过独占 `.lock` 文件阻止多个进程同时改写。锁冲突立即返回错误，不忙等；同进程并发调用已测试。程序崩溃可能留下 `memory.sqlite.lock`：**先关闭所有使用该库的机器人、确认没有操作，再只删除此 .lock 文件**；不要删除 .sqlite。不要把同一数据库文件放到网络共享盘让多机直接共用。

数据落盘失败、数据库损坏、来源上下文缺失都会报错，不宣称保存成功，也不会遇到损坏后自动清空重建。保持完整错误信息交给维护者排查。

## 自动回忆的实际边界

当前技能通过提示词引导 DeepSeek 在需要时调用 search/save，没有未经验证的宿主钩子。模型仍可能漏调工具；这不会改变模型权重，也不是“所有对话都自动记住”。若要保证每条消息进入模型前自动查记忆，需要进一步接入 QQ Agent 的消息处理/提示词构建代码。

## 测试与依赖

```sh
node --test skills/long-memory/dev-tests/memory.test.mjs
```

测试会在系统临时目录建立假数据库并清理，不接触真实聊天数据、不联网。覆盖持久化、隔离、去重、冲突、并发、检索、过期、物理删除、文件损坏、落盘失败和宿主注册契约。

依赖为 [sql.js 1.13.0](https://github.com/sql-js/sql.js)，MIT 授权，许可证随 vendor 附带；SQLite 本身为公共领域。引擎使用方式参考 [sql.js 官方文档](https://sql.js.org/documentation/)。下载包来源和文件校验值见 THIRD-PARTY.json。

## v1.0.1 会话标识兼容修复

会话身份按解析后的类型和QQ号比较，兼容 private_12345、private:12345、private/12345、private-12345（group同理），兼容数值chatId和首尾空白。若宿主提供不含身份的内部chatKey，则使用完整有效的kind/chatId；可解析的身份字段真正冲突时仍拒绝。群聊开关也使用统一解析。内部数据库scope继续使用原下划线格式，无需重建、迁移或删除数据库。

升级：关闭QQ Agent，覆盖技能文件，保留原data目录和dataDir设置，再启动并调用 long-memory__status。若仍失败，请返回完整工具错误，其中包含已隐藏号码的字段格式；当前修复已通过30项本地测试，未在实际宿主验证。

