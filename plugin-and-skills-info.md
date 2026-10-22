# 插件与技能来源说明

本目录（`skills/`、`plugins/`）里的扩展**不是本项目自己写的**。它们是 QQ Agent 的社区扩展，绝大多数来自
QQ Agent 插件/Skill 市场，少量为本机自建。核查日期：**2026-10-22**。

- 市场地址：<https://www.kondius.cn/qq-agent/plugin-market/> 、<https://www.kondius.cn/qq-agent/skill-market/>
- 核查范围：**103 个扩展**（33 个技能 + 70 个插件）
- 明细数据：同一批核查数据另存为本机工作区的 `EXTENSION-SOURCES-2026-10-22.md` / `.csv`（未随仓库提交）

## 一、来源分布

| 项 | 数量 |
|---|---|
| 能在市场找到同 id 条目 | 102 |
| 市场无条目、本机自建（`balance-query`，DSH 技能） | 1 |
| 涉及的市场发布账号 | 76 |
| 能确证到公开仓库 | 2 |

## 二、署名与许可（重要）

1. **市场只记录"发布账号昵称"，没有源码仓库、主页或作者字段。** 接口只返回：id、名称、描述、分类、版本、作者（账号）、authorId、时间、下载量、安装口令、下载地址。
2. **包内清单的 `author` 不能当作者用。** 抽查市场 ZIP 发现：`cross-memory` 包内写「本机定制」、`image-studio` 写「本地自建」、`face-decode`/`owner-identity` 写「QQ Agent」、`smart-image` 为空——这些占位值原样存在于分发包里，不是本地改的。
3. **"发布者"不等于"原作者"。** 102 个有市场条目的扩展中，99 个的清单署名与发布账号不一致；市场还存在重复上传（例如 `face-decode` 有两条描述完全相同的条目，分属林枫灬寒霜 / atri），部分条目只是转载。
4. **只有 2 个扩展能确证公开仓库**：`reply-meme` → <https://github.com/nuoxi4n/qq-agent-extensions>，`rollpig` → <https://github.com/TLeoJU/qqa-rollpig>。其余 101 个在代码、README、清单、市场描述里都没有仓库线索。
5. **上游主仓库不包含这些扩展。** <https://github.com/K0nd1us/QQ-agent> 的 `.gitignore` 忽略了 `skills/`、`plugins/`，所以它们都不是"官方内置"，而是第三方作品。
6. **许可状况未知。** 各扩展版权归各自作者，包内基本没有 LICENSE。本仓库收录仅用于部署与备份；**如需再分发或商用，请先向对应发布者确认授权**。

## 三、如何复核

- 市场列表接口：`https://www.kondius.cn/api/community/plugins`、`https://www.kondius.cn/api/community/skills`
- 单个条目的下载地址：`https://www.kondius.cn/api/community/{plugins|skills}/<id>/download`
- 表格里的 id 都链到对应市场页；"安装口令"是市场分发的凭据，可在 QQ Agent「添加插件/Skill」里直接粘贴安装。

## 四、完整清单（103 项）

| # | 类型 | 扩展 id | 市场发布者 | 版本 | 下载 | 安装口令 | 清单署名 | 公开仓库 / 备注 |
|---|---|---|---|---|---|---|---|---|
| 1 | 插件 | [agent-task](https://www.kondius.cn/qq-agent/plugin-market/agent-task/) | o'h | 2.1.2 | 125 | UBHGFD | QQ Agent | — |
| 2 | 插件 | [ai-status](https://www.kondius.cn/qq-agent/plugin-market/ai-status/) | o'h | 1.6.0 | 919 | 9ZB9UQ | QQ Agent | — |
| 3 | 插件 | [mc-status](https://www.kondius.cn/qq-agent/plugin-market/mc-status/) | o'h | 1.2.43 | 103 | 2DNRLK | QQ Agent | — |
| 4 | 插件 | [reminder](https://www.kondius.cn/qq-agent/plugin-market/reminder/) | o'h | 1.1.4 | 403 | QLP7N2 | QQ Agent | — |
| 5 | 插件 | [safety-guard](https://www.kondius.cn/qq-agent/plugin-market/safety-guard/) | o'h | 1.0.4 | 178 | ZF2UJQ | （空） | — |
| 6 | 插件 | [steam-query](https://www.kondius.cn/qq-agent/plugin-market/steam-query/) | o'h | 1.2.3 | 1384 | DMSPRB | QQ Agent | — |
| 7 | 插件 | [chatter-guard](https://www.kondius.cn/qq-agent/plugin-market/chatter-guard/) | 千夜月ヾ❀＿official | 1.0.0 | 1677 | WNVZBW | 为 QQ Agent 定制 | — |
| 8 | 插件 | [content-guard](https://www.kondius.cn/qq-agent/plugin-market/content-guard/) | 千夜月ヾ❀＿official | 1.1.0 | 246 | VXRZG4 | 千夜月ヾ❀＿official | — |
| 9 | 插件 | [qianyeyue-affinity](https://www.kondius.cn/qq-agent/plugin-market/qianyeyue-affinity/) | 千夜月ヾ❀＿official | 2.0.0 | 152 | FE5YL5 | 千夜月official | — |
| 10 | 插件 | [sticker-cap](https://www.kondius.cn/qq-agent/plugin-market/sticker-cap/) | 千夜月ヾ❀＿official | 1.0.0 | 412 | V8FZ78 | 为 QQ Agent 定制 | — |
| 11 | 技能 | [trendy-memes](https://www.kondius.cn/qq-agent/skill-market/trendy-memes/) | 千夜月ヾ❀＿official | 1.0.0 | 6598 | W3DNCX | 为 QQ Agent 定制 | — |
| 12 | 插件 | [auto-finish](https://www.kondius.cn/qq-agent/plugin-market/auto-finish/) | 111 | 1.0.0 | 459 | NCAQ2T | 本地自建 | — |
| 13 | 插件 | [context-reuse](https://www.kondius.cn/qq-agent/plugin-market/context-reuse/) | 111 | 1.0.0 | 2637 | J3KSLJ | 本地自建 | — |
| 14 | 插件 | [reply-safety](https://www.kondius.cn/qq-agent/plugin-market/reply-safety/) | 111 | 2.0.0 | 607 | AX8GQX | 本地自建 | — |
| 15 | 插件 | [search-guard](https://www.kondius.cn/qq-agent/plugin-market/search-guard/) | 111 | 1.1.0 | 260 | Q42EJS | 本地自建 | — |
| 16 | 插件 | [cross-memory](https://www.kondius.cn/qq-agent/plugin-market/cross-memory/) | 渔宰 | 2.0.0 | 261 | EURXHZ | 本机定制 | — |
| 17 | 插件 | [group-manner](https://www.kondius.cn/qq-agent/plugin-market/group-manner/) | 渔宰 | 1.0.0 | 852 | JQJWLM | 本机定制 | — |
| 18 | 插件 | [reply-pacing](https://www.kondius.cn/qq-agent/plugin-market/reply-pacing/) | 渔宰 | 1.0.0 | 232 | TFAYJJ | 本机定制 | — |
| 19 | 插件 | [kaomoji](https://www.kondius.cn/qq-agent/plugin-market/kaomoji/) | 北大落榜生 | 1.0.0 | 155 | PHW24E | QQ Agent 用户 | — |
| 20 | 技能 | [usage-report](https://www.kondius.cn/qq-agent/skill-market/usage-report/) | 北大落榜生 | 1.0.0 | 70 | KF3DJ9 | QQ Agent 用户 | — |
| 21 | 插件 | [punch-card](https://www.kondius.cn/qq-agent/plugin-market/punch-card/) | 蝶影覓踨 | 1.0.0 | 152 | Y2WJZX | 为 QQ Agent 定制 | — |
| 22 | 插件 | [sticker-send-as-emoji](https://www.kondius.cn/qq-agent/plugin-market/sticker-send-as-emoji/) | 蝶影覓踨 | 1.0.0 | 1209 | NN9UBJ | 本地自建 | — |
| 23 | 插件 | [msg-reaction](https://www.kondius.cn/qq-agent/plugin-market/msg-reaction/) | 风语 | 1.5.0 | 1544 | CGT6JK | QQ Agent | — |
| 24 | 插件 | [typing-indicator](https://www.kondius.cn/qq-agent/plugin-market/typing-indicator/) | 风语 | 1.0.1 | 612 | HDVE3U | 本机定制 | — |
| 25 | 插件 | [face-decode](https://www.kondius.cn/qq-agent/plugin-market/face-decode/) | 林枫灬寒霜 | 1.1.0 | 535 | V9WMRJ | QQ Agent | 市场有两条同描述条目（林枫灬寒霜 / atri），署名有歧义 |
| 26 | 技能 | [scheduled-task](https://www.kondius.cn/qq-agent/skill-market/scheduled-task/) | 林枫灬寒霜 | 0.1.0 | 105 | BD9Y2M | 社区整合包 | — |
| 27 | 插件 | [kb-hub](https://www.kondius.cn/qq-agent/plugin-market/kb-hub/) | 让我钓个鱼行不 | 1.3.0 | 34 | PC55NB | QQ Agent + DSH | — |
| 28 | 插件 | [quota-guard](https://www.kondius.cn/qq-agent/plugin-market/quota-guard/) | 让我钓个鱼行不 | 1.0.0 | 140 | 3ASEST | canifish | — |
| 29 | 插件 | [hell-joke](https://www.kondius.cn/qq-agent/plugin-market/hell-joke/) | 相思凉 | 1.4.0 | 14 | P88RGZ | 本地 | — |
| 30 | 插件 | [token-ledger](https://www.kondius.cn/qq-agent/plugin-market/token-ledger/) | 相思凉 | 1.0.0 | 894 | Z5E7UD | 本机定制 | — |
| 31 | 插件 | [cross-chat-link](https://www.kondius.cn/qq-agent/plugin-market/cross-chat-link/) | 小草 | 1.0.0 | 3868 | 5N4BA7 | QQ Agent（对应 0.2 的跨会话记忆断层） | — |
| 32 | 插件 | [member-aliases](https://www.kondius.cn/qq-agent/plugin-market/member-aliases/) | 小草 | 1.0.0 | 2975 | PQCQ2A | QQ Agent（迁移自 0.2 的 memberAliases） | — |
| 33 | 插件 | [revenge-ledger](https://www.kondius.cn/qq-agent/plugin-market/revenge-ledger/) | 馀狼 | 1.7.0 | 270 | NZUVZ6 | 社区分发版 | — |
| 34 | 插件 | [tool-boost](https://www.kondius.cn/qq-agent/plugin-market/tool-boost/) | 馀狼 | 1.0.0 | 145 | BGZWQM | 本地自建 | — |
| 35 | 插件 | [addressee-guard](https://www.kondius.cn/qq-agent/plugin-market/addressee-guard/) | hypcalled | 1.0.0 | 462 | F3K9FS | 本地自建 | — |
| 36 | 技能 | [meme-mood](https://www.kondius.cn/qq-agent/skill-market/meme-mood/) | hypcalled | 1.0.0 | 288 | 2GSD6F | 本地自建 | — |
| 37 | 技能 | [skill-summary](https://www.kondius.cn/qq-agent/skill-market/skill-summary/) | Nasos | 1.0.0 | 1125 | 5QH94H | 为 QQ Agent 定制 | — |
| 38 | 技能 | [steam-deals](https://www.kondius.cn/qq-agent/skill-market/steam-deals/) | Nasos | 1.4.0 | 1308 | JU9R2W | 为 QQ Agent 定制 | — |
| 39 | 插件 | [friend-gate](https://www.kondius.cn/qq-agent/plugin-market/friend-gate/) | x1yuan | 1.3.0 | 426 | XJPWVN | QQ Agent + DSH | — |
| 40 | 插件 | [guardian](https://www.kondius.cn/qq-agent/plugin-market/guardian/) | x1yuan | 1.1.0 | 1120 | DJ3M5A | QQ Agent + DSH | — |
| 41 | 技能 | [owner-console](https://www.kondius.cn/qq-agent/skill-market/owner-console/) | yimoxianliu | 1.0.0 | 77 | HXQPNA | 本地自建 | — |
| 42 | 技能 | [recall](https://www.kondius.cn/qq-agent/skill-market/recall/) | yimoxianliu | 1.0.0 | 50 | 3PTBA5 | 本地自建 | — |
| 43 | 插件 | [quote-reply](https://www.kondius.cn/qq-agent/plugin-market/quote-reply/) | 168 | 1.1.0 | 152 | BF7PDV | 小肥鱼 | — |
| 44 | 技能 | [pig-hub](https://www.kondius.cn/qq-agent/plugin-market/pig-hub/) | 闇音 | 1.0.0 | 259 | LWUAH8 | 本地自建 | 市场为 plugin，本地为 skill |
| 45 | 插件 | [sticker-memory](https://www.kondius.cn/qq-agent/plugin-market/sticker-memory/) | 不是豆日向 | 1.0.0 | 6182 | 3BBFH5 | DSH | — |
| 46 | 插件 | [continuous-life](https://www.kondius.cn/qq-agent/plugin-market/continuous-life/) | 疯子酱 | 1.0.0 | 39 | QTQU5F | 疯子酱 | — |
| 47 | 插件 | [net-proxy](https://www.kondius.cn/qq-agent/plugin-market/net-proxy/) | 凤凰院丁真 | 1.1.0 | 170 | WLZXB5 | 本地自建 | — |
| 48 | 技能 | [pcstatus](https://www.kondius.cn/qq-agent/skill-market/pcstatus/) | 芙 | 2.0.0 | 200 | 8GE6WB | QQ Agent 用户自制 | — |
| 49 | 插件 | [at-identity](https://www.kondius.cn/qq-agent/plugin-market/at-identity/) | 柑橘 | 1.0.0 | 100 | AHKUT8 | 本机定制 | — |
| 50 | 技能 | [mimo-tts](https://www.kondius.cn/qq-agent/skill-market/mimo-tts/) | 和好inn年年 | 1.0.0 | 2416 | RRAAXT | QQ Agent | — |
| 51 | 技能 | [deai-flavor](https://www.kondius.cn/qq-agent/skill-market/deai-flavor/) | 玖云 | 1.0.1 | 7690 | RWX7UZ | 小肥鱼 | — |
| 52 | 技能 | [ark-db](https://www.kondius.cn/qq-agent/skill-market/ark-db/) | 零陵灵 | 1.0.0 | 61 | RULUD5 | 本地自建 | — |
| 53 | 技能 | [health-report](https://www.kondius.cn/qq-agent/plugin-market/health-report/) | 路过不知名墨真 | 1.0.0 | 26 | QBMLP9 | DSH | 市场为 plugin，本地为 skill |
| 54 | 技能 | [sing-aloud](https://www.kondius.cn/qq-agent/skill-market/sing-aloud/) | 闾阎 | 0.9.0 | 1018 | LK59H5 | QQ Agent 用户 | — |
| 55 | 插件 | [sleep-schedule](https://www.kondius.cn/qq-agent/plugin-market/sleep-schedule/) | 弥弥斯 | 1.0.0 | 58 | GEJRKB | 为 QQ Agent 定制 | — |
| 56 | 插件 | [quote-target](https://www.kondius.cn/qq-agent/plugin-market/quote-target/) | 墨瑾离歌 | 1.0.0 | 33 | RCQ7NE | 主人 & DSH | — |
| 57 | 技能 | [verify-first](https://www.kondius.cn/qq-agent/skill-market/verify-first/) | 毣天 | 1.0.0 | 1718 | WT3NXC | 本地自建 | — |
| 58 | 插件 | [memory-plus](https://www.kondius.cn/qq-agent/plugin-market/memory-plus/) | 慕潮汐 | 2.5.0 | 145 | CHHAV7 | 本机定制 | — |
| 59 | 插件 | [at-mention](https://www.kondius.cn/qq-agent/plugin-market/at-mention/) | 泡影之梦 | 1.0.0 | 261 | WTNG9J | 小肥鱼 | — |
| 60 | 技能 | [minecraft-master](https://www.kondius.cn/qq-agent/skill-market/minecraft-master/) | 七平 | 1.3.0 | 216 | BQHKKZ | AI 生成 · 资料来自 zh.minecraft.wiki 与萌娘百科（已改写为速查条目） | — |
| 61 | 技能 | [cross-group-memory](https://www.kondius.cn/qq-agent/skill-market/cross-group-memory/) | 其实我是区 | 1.1.0 | 991 | ZP5A5T | 伊西丝 / WorkBuddy | — |
| 62 | 插件 | [ccb-command](https://www.kondius.cn/qq-agent/plugin-market/ccb-command/) | 青霄 | 1.1.0 | 55 | M3LJWA | DSH | — |
| 63 | 技能 | [bilibili-peek](https://www.kondius.cn/qq-agent/skill-market/bilibili-peek/) | 染雨 | 1.0.0 | 1501 | GKPPT9 | 本地自制（非市场作品） | — |
| 64 | 插件 | [sticker-sense](https://www.kondius.cn/qq-agent/plugin-market/sticker-sense/) | 软糯大香蕉 | 1.0.0 | 82 | MBRZNT | DSH | — |
| 65 | 插件 | [persona-picker](https://www.kondius.cn/qq-agent/plugin-market/persona-picker/) | 神秘人 | 1.0.0 | 182 | 782NS3 | 本机定制 | — |
| 66 | 插件 | [repeat-echo](https://www.kondius.cn/qq-agent/plugin-market/repeat-echo/) | 四季玲奈 | 1.0.0 | 3290 | EZB9Q6 | DSH | — |
| 67 | 插件 | [silent-voice-check](https://www.kondius.cn/qq-agent/plugin-market/silent-voice-check/) | 污染源 | 1.0.3 | 39 | XU9WRK | （空） | — |
| 68 | 插件 | [cache-suite](https://www.kondius.cn/qq-agent/plugin-market/cache-suite/) | 小糖 | 3.1.0 | 188 | 6T88PQ | （空） | — |
| 69 | 插件 | [mcp-bridge](https://www.kondius.cn/qq-agent/plugin-market/mcp-bridge/) | 小勋 | 1.0.1 | 14 | GD9VRY | 本地自建 | — |
| 70 | 插件 | [rollpig](https://www.kondius.cn/qq-agent/plugin-market/rollpig/) | 新海ソラ | 0.14.4-qqa.1 | 49 | VBUTCC | QQ Agent RollPig contributors | [TLeoJU/qqa-rollpig](https://github.com/TLeoJU/qqa-rollpig) |
| 71 | 技能 | [group-image-repost](https://www.kondius.cn/qq-agent/skill-market/group-image-repost/) | 夜游 | 1.0.0 | 61 | C99B85 | DSH | — |
| 72 | 插件 | [share-card](https://www.kondius.cn/qq-agent/plugin-market/share-card/) | 雨夜流汐 | 1.1.0 | 3218 | WNU4D2 | QQ Agent User | — |
| 73 | 插件 | [context-chime](https://www.kondius.cn/qq-agent/plugin-market/context-chime/) | 御坂凌 | 1.0.0 | 4170 | 5S8W69 | 本机定制 | — |
| 74 | 技能 | [friend-approval](https://www.kondius.cn/qq-agent/skill-market/friend-approval/) | 月落洲 | 1.0.0 | 732 | ETMDPT | 本地自建 | — |
| 75 | 技能 | [smart-image](https://www.kondius.cn/qq-agent/skill-market/smart-image/) | 云洺 | 2.1.0 | 3128 | L84GZD | （空） | — |
| 76 | 技能 | [my-weather](https://www.kondius.cn/qq-agent/skill-market/my-weather/) | 正在加载 | 1.0.0 | 17 | 5QFDS3 | 本地自建 | — |
| 77 | 技能 | [office-export](https://www.kondius.cn/qq-agent/skill-market/office-export/) | archmi | 1.1.0 | 71 | CYT7J3 | 本地生成 | — |
| 78 | 插件 | [speech-to-text-qq](https://www.kondius.cn/qq-agent/plugin-market/speech-to-text-qq/) | asuka的追求者 | 1.0.0 | 2206 | EAVD5D | 本地改造 | — |
| 79 | 技能 | [long-memory](https://www.kondius.cn/qq-agent/skill-market/long-memory/) | ATRI | 1.0.1 | 309 | SBGRT7 | QQ Agent | 依赖 sql.js（github.com/sql-js/sql.js），非扩展本体仓库 |
| 80 | 插件 | [sticker-steal](https://www.kondius.cn/qq-agent/plugin-market/sticker-steal/) | Civilight_Eterna | 5.5.1 | 3040 | 84GKJQ | 为 QQ Agent 定制 | — |
| 81 | 插件 | [deepseek-status](https://www.kondius.cn/qq-agent/plugin-market/deepseek-status/) | d1gital | 1.0.0 | 61 | PKEK9S | DSH | — |
| 82 | 插件 | [command-digest](https://www.kondius.cn/qq-agent/plugin-market/command-digest/) | dafeiyu | 1.0.0 | 169 | HLRSC7 | QQ Agent 用户定制 | — |
| 83 | 插件 | [anti-recon](https://www.kondius.cn/qq-agent/plugin-market/anti-recon/) | dockerrrr | 1.0.0 | 404 | 35MD9Q | 部署侧 | — |
| 84 | 插件 | [deepseek-search-fix](https://www.kondius.cn/qq-agent/plugin-market/deepseek-search-fix/) | Ender | 1.0.0 | 28 | 7EG67G | （空） | — |
| 85 | 插件 | [owner-identity](https://www.kondius.cn/qq-agent/plugin-market/owner-identity/) | ERROR | 1.0.0 | 8551 | UC6476 | QQ Agent | — |
| 86 | 插件 | [chuanzi](https://www.kondius.cn/qq-agent/skill-market/chuanzi/) | hinwaz | 1.6.6 | 141 | BZJED9 | local | 市场为 skill，本地已改为 plugin |
| 87 | 插件 | [daily-checkin](https://www.kondius.cn/qq-agent/plugin-market/daily-checkin/) | jun_hua | 1.0.0 | 38 | JN6XVR | QQ Agent 用户 | — |
| 88 | 插件 | [topic-guard](https://www.kondius.cn/qq-agent/skill-market/topic-guard/) | kelixuan | 1.0.0 | 575 | B6ZSMG | QQ Agent | 市场为 skill，本地为 plugin |
| 89 | 插件 | [video-frames](https://www.kondius.cn/qq-agent/plugin-market/video-frames/) | kelp | 1.0.0 | 2125 | EZ4SBE | QQ Agent | — |
| 90 | 插件 | [image-compat](https://www.kondius.cn/qq-agent/plugin-market/image-compat/) | Kondius | 1.0.0 | 658 | 7HX6VP | QQ Agent | — |
| 91 | 技能 | [stamina](https://www.kondius.cn/qq-agent/skill-market/stamina/) | lanker | 1.0.1 | 58 | CF7QGF | local | — |
| 92 | 插件 | [detailed-thinking](https://www.kondius.cn/qq-agent/plugin-market/detailed-thinking/) | Mashiro | 1.0.0 | 908 | 6NNW3H | QQ Agent | — |
| 93 | 插件 | [poke-counter](https://www.kondius.cn/qq-agent/plugin-market/poke-counter/) | NaCl | 1.1.0 | 181 | V6X3BN | （空） | — |
| 94 | 技能 | [self-surf](https://www.kondius.cn/qq-agent/plugin-market/self-surf/) | neuro | 1.0.0 | 3248 | 3MUZFL | 自建（按 QQ Agent 插件 API v1） | 市场为 plugin，本地为 skill |
| 95 | 技能 | [reply-meme](https://www.kondius.cn/qq-agent/skill-market/reply-meme/) | nuoxi4n | 1.0.1 | 10139 | RF963Z | nuoxi4n | [nuoxi4n/qq-agent-extensions/tree/main/skills/reply-meme](https://github.com/nuoxi4n/qq-agent-extensions/tree/main/skills/reply-meme) |
| 96 | 技能 | [bili-card](https://www.kondius.cn/qq-agent/skill-market/bili-card/) | Parabola404 | 1.0.0 | 129 | RCWD84 | （空） | — |
| 97 | 技能 | [self-avatar](https://www.kondius.cn/qq-agent/skill-market/self-avatar/) | Topo | 1.0.0 | 97 | 8LJTDH | 本地自建 | — |
| 98 | 技能 | [daily-fortune](https://www.kondius.cn/qq-agent/skill-market/daily-fortune/) | xs | 1.0.0 | 1465 | EMAFMX | 为 QQ Agent 定制 | — |
| 99 | 技能 | [image-studio](https://www.kondius.cn/qq-agent/skill-market/image-studio/) | XxJ | 1.3.0 | 20 | 4TFGY6 | 本地自建 | — |
| 100 | 插件 | [reply-tool-guard](https://www.kondius.cn/qq-agent/plugin-market/reply-tool-guard/) | yehuaixian | 1.0.0 | 97 | DRKS7B | （空） | — |
| 101 | 插件 | [bot-offline-notice](https://www.kondius.cn/qq-agent/plugin-market/bot-offline-notice/) | zbingsu | 1.0.0 | 28 | 4WAZVL | QQ Agent | — |
| 102 | 插件 | [question-relay](https://www.kondius.cn/qq-agent/plugin-market/question-relay/) | Zone | 1.0.0 | 954 | 6V3PGB | 本机定制 | — |
| 103 | 技能 | balance-query | 未上架 | — | — | — | 本机 | 市场无条目；本机自建（DSH 技能） |

> 注：`清单署名` 是包内 `plugin.json`/`skill.json` 的 `author` 字段，多为占位；判断来源请以「市场发布者 + 市场条目链接」为准。
