# 分享卡片解读（share-card）

给 QQ Agent 0.4.0 用的插件：让机器人读懂群友/好友推来的分享，并接管加好友请求。

- 插件 id：`share-card`
- 版本：1.1.0
- 设置项：20 个（面板 → 插件 → 分享卡片解读）
- 能力：`friend.request`、`group.request`、`share-card.status`
- 权限：`web_fetch`
- 注册工具：`read_share`（「读取分享链接」，让模型按需读一条链接）、`read_image_text`（「读图片文字」，调协议端 OCR 读群里最近的截图/公告图）

## 一、它做什么

1. **自动解读**：消息里出现 B站 / 抖音 / 米游社 / 贴吧 / QQ频道 / 腾讯视频 / 塔吉多 / 快手 / 小红书 / 库街区 / 森空岛 / 其它网页链接时，自动抓正文并追加到模型上下文（`injectIntoPrompt` 可关）。
2. **按需解读**：`readCards` / `readLinks` 控制读卡片还是读裸链接；`maxLinksPerTurn` 限制每轮最多读几条。
3. **卡片转文字**：QQ 的 JSON 卡片（B站分享、抖音分享、贴吧分享、频道帖子、小程序、好友名片、群名片）会被渲染成人能读的一段话，而不是 `[卡片消息]`。
4. **读图**：开了 `autoOcr` 会把本轮消息里的图片交给协议端 OCR 读出文字；模型也可以调 `read_image_text` 按需读。
4. **加好友/入群请求**：默认只私聊通知主人；可开 `autoApproveFriend` / `autoApproveGroup` 自动同意，配 `allowList` / `denyList` 黑白名单。

## 二、平台现状（都是实测过的）

| 平台 | 卡片标题 | 网页正文 | 备注 |
|---|---|---|---|
| B站（含 `b23.tv` / `bili2233.cn`） | ✅ | ✅ | 走官方 `api.bilibili.com/x/web-interface/view`，展示链接会收敛成 `bilibili.com/video/BV…` |
| 米游社 | ✅ | ✅ | 走官方 `bbs-api.miyoushe.com/post/wapi/getPostFull` |
| QQ频道 | ✅ | ✅ | `pd.qq.com/g/<频道>/post/<id>` 与短链 `pd.qq.com/s/<code>` 都直接返回带完整 og 的 HTML |
| 塔吉多（完美世界《异环》社区） | ✅ | ✅ | 走 `bbs-api.tajiduo.com/bbs/wapi/getPostFull`，标题/作者/阅读点赞/正文都能拿到 |
| 腾讯视频 | ✅ | ⚠️ 尽力而为 | `v.qq.com` 视频页是 JS 渲染，抓到 og 就用，抓不到退回卡片信息 |
| QQ 好友名片 / 群名片 | ✅ | — | `[卡片消息｜名称：柒夜｜QQ号：1460415227｜类型：个人名片]` |
| 抖音 | ✅ | ⚠️ 需 Cookie | 分享页对未登录只给空壳；老接口已下线 |
| 贴吧 | ✅ | ⚠️ 需 Cookie | `tieba.baidu.com` 对本机整站 403 |
| 小红书 | ✅ | ❌ 未登录读不到 | 笔记页对未登录返回反爬壳（无 og、无正文） |
| 快手 | ✅ | ❌ 未登录读不到 | 分享页纯 JS 渲染，未登录时 graphql 也不给数据 |
| 库街区 | ✅ | ❌ 未登录读不到 | 正文接口要登录令牌（`访问令牌不能为空`） |
| 森空岛 | ✅ | ❌ 未登录读不到 | `zonai.skland.com` 要设备签名（`设备信息无效`），签名复现不出来 |

**「网页正文」那一列是 ❌/⚠️ 的平台，插件不会假装读过**：它会改注一段 `【分享卡片】`，把卡片自带的标题/来源交给模型，并写明「正文没能读到、不要声称看过正文」，再附一条给主人的可操作提示。

### 新加的四家为什么读不到（都实测过）

- **小红书**：`www.xiaohongshu.com/explore/<id>` 桌面 UA 和移动 UA 都返回 200，但 **og 一个都没有、没有 `__INITIAL_STATE__`、连 `<title>` 都是空的** —— 是反爬壳；要签名的那几个接口（`/api/sns/web/v1/feed` 等）拿不到。
- **快手**：短链 302 正常，但分享页是纯 JS 壳（76 KB 里 0 个 og）；`POST www.kuaishou.com/graphql` 直接回 `{"result":2}`（无 Cookie 调不通）。
- **库街区**：`api.kurobbs.com/forum/detail` 与 `/forum/post/detail` 都返回 `{"code":220,"msg":"访问令牌不能为空"}` —— 路径是对的，token 存在浏览器 localStorage 里。
- **森空岛**：`GET https://zonai.skland.com/web/v2/item?id=1` → `{"code":10001,"message":"设备信息无效"}`；主包（`main.2f44d4a6.js`）里能挖到 65 个 `/web/v1|v2` 路径，但**没有任何 salt / hmac 常量**（只有 crypto-browserify 库本身），签名算法复现不出来。

它们都留了位置：只要以后能拿到正文，往 `lib/resolve.js` 的 `HANDLERS` 里补一个 handler 就行，其余流程（选链接、渲染、降级）都不用动。

### 抖音 / 贴吧 为什么读不到正文

- **抖音**：短链 302 正常、`aweme_id` 能提取，但分享页对未登录**只返回空壳**（`_ROUTER_DATA` 里没有 `videoInfoRes.item_list`）；爬虫 UA 直接 404；`iesdouyin/web/api/v2/aweme/iteminfo` 已下线（200 但 0 字节）；`www.douyin.com/aweme/v1/web/aweme/detail/` 返回 `403 Blocked by ArgusSecurityPlugin`。第三方解析接口试了 4 个，全挂。
- **贴吧**：5 种 UA × 4 种 URL 变体**全部 403 + 百度安全验证**，是 IP 级风控。用公开阅读器/代理替我们抓（`r.jina.ai` / allorigins / codetabs / corsproxy / cors.lol / whateverorigin）也全部失败。

**两条都能靠你自己的登录态 Cookie 解锁**：把 Cookie 填进来即可，不用改代码。

### 正文读不到时不会白来一趟

抖音/贴吧正文读不到时，插件**不会静默什么都不做**（早期版本就是这样，等于这条消息白发了）。它会改注一段
`【分享卡片】`，把卡片自带的标题/来源原样交给模型，并明确写上「正文没能读到」「不要声称看过正文」，
同时附一条给主人的可操作提示（例如「抖音正文需要登录 Cookie（填本技能的 douyinCookie，或填到「媒体下载」技能）」）。

裸链接（不是卡片）读不到时则**保持安静**，不产生噪音。

## 三、Cookie 怎么给

在插件面板「分享卡片解读」里填 `douyinCookie` / `tiebaCookie`，或者填到「媒体下载」技能里 ——
本插件的 `reuseMediaCookies`（默认开）会**自动复用** `media-download` 的 `bilibiliCookie` / `douyinCookie`，不用两处各贴一遍。

- **抖音**：网页版 `douyin.com` → F12 → Application → Cookies → 复制 `sessionid`
- **贴吧**：`tieba.baidu.com` → 同上 → 复制 `BDUSS=…`
- **B站**：同上 → `SESSDATA`

填了 Cookie 之后，贴吧会自动从手机页切到 PC 页（桌面页才有 `d_post_content` 首楼正文）。
名字里带 `Cookie` / `key` / `token` / `secret` / `password` 的设置，面板会自动打码。

## 四、协议层做不到的两件事

这两条不是没写，是**协议本身没有接口**：

- **扫码加好友**：SnowLuma 的 action 里 **11 种二维码写法全灭**（`get_qrcode` / `scan_qrcode` / `decode_qrcode`…），而且**没有 `add_friend`**。就算自己写个解码器把二维码读出来，也没有任何接口能拿这个结果去加人。
- **机器人主动加别人**：同上，没有 `add_friend`。**只能处理别人发来的请求**（`set_friend_add_request` / `set_group_add_request` 是有的）。

顺带：本机三个 Python 都没有 `cv2` / `pyzbar` / `qrcode`，QQ Agent 的 `node_modules` 里也没有 `jsqr` / `qrcode` / `jimp` —— 连"先解码再说"这条路都堵着。

## 五、依赖两处核心补丁（更新后会丢！）

这个插件要靠 `resources\app\src\` 里两处最小补丁才能拿到卡片内容与好友请求：

| 补丁 | 位置 | 作用 |
|---|---|---|
| A | `src\onebot.js` | `case 'json'` 不再压成 `[卡片消息]`，改调 `cardSegmentToText()` 渲染出标题/链接/QQ号 |
| B | `src\app.js` | 接住核心原本丢弃的 `post_type:'request'`，转发给 `friend.request` / `group.request` 能力 |

**QQ Agent 一旦自动更新，`resources\app\` 被整个替换，这两处补丁会静默消失**（插件本身还在，但读不到卡片、也收不到好友请求）。

### 更新后怎么恢复

```bat
node F:\雨夜流汐\Documents\DeepSeek\.tools\patch-qqagent-core.mjs --dry   :: 先看要紧不要紧
node F:\雨夜流汐\Documents\DeepSeek\.tools\patch-qqagent-core.mjs         :: 打两处补丁
node F:\雨夜流汐\Documents\DeepSeek\.tools\patch-card-quality.mjs          :: 卡片渲染增强（名片/QQ号）
node F:\雨夜流汐\Documents\DeepSeek\.tools\share-card\verify-and-repair.mjs --fix   :: 体检 + 重新拷插件
```

`patch-qqagent-core.mjs` 每步都会断言锚点唯一（`split(from).length-1 === 1`）并回读校验，重复执行不会打歪。

补丁前的原始文件备份在：

- `F:\雨夜流汐\Documents\DeepSeek\.backup\qqagent-core-2026-10-01T05-12-41-604Z\`
- `F:\雨夜流汐\Documents\DeepSeek\.backup\qqagent-core-cardv2-2026-10-01T06-11-50-555Z\`

## 六、改完代码怎么生效

`resources\app\plugins\<id>\lib\` 下的 ESM 模块**不会**被热重载重新加载 —— 改完 `lib\` 必须重启 QQ Agent，
否则会出现"看着加载正常、但改动没生效"。改 `index.js` 一般热重载就够。

源码在 `F:\雨夜流汐\Documents\DeepSeek\.tools\share-card\`，改完拷进安装目录：

```bat
node F:\雨夜流汐\Documents\DeepSeek\.tools\share-card\verify-and-repair.mjs --fix
```

## 七、自测脚本

都在 `F:\雨夜流汐\Documents\DeepSeek\.tools\share-card\`：

| 脚本 | 作用 |
|---|---|
| `verify-and-repair.mjs` | 体检核心补丁 + 插件文件一致性（`--fix` 自动重拷） |
| `test-platforms.mjs` | 12 家平台识别 + 卡片选链接 + 新平台联网解析/降级（37 项断言） |
| `resolve-cli.mjs` | 命令行解析一条链接：`node resolve-cli.mjs <url>` |
| `test-card-real.mjs` | 抖音/贴吧/名片等真实卡片 JSON 的渲染断言 |
| `test-card-patch.mjs` | 10 种卡片形态的渲染回归 |
| `test-integration.mjs` | 假 onebot 跑 hooks 与好友请求处理（26 项断言） |
| `test-cookies.mjs` | Cookie 管道冒烟（有/无 Cookie 各 5 条真实链接） |
| `resolve-cli.mjs` | 命令行解析一条链接：`node resolve-cli.mjs <url>` |
| `list-archive-links.mjs` | 列出 QQ Agent 存档里出现过的所有链接 |
| `find-cards.mjs` | 列出存档里的卡片消息（看补丁有没有真的生效过） |
