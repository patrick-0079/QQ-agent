# 余额 / 用量查询（`balance-query`）

给 QQ Agent 加的一个**技能**（LLM 型，所以显示在控制台「技能」页签，不在「插件」页签）。
群友说「余额查询」「用量查询」「查余额」时，机器人调接口取真实数据再回答。

支持的四个渠道：

| 渠道 | 查什么 | 需要填什么 |
|---|---|---|
| OpenCode Go | 5 小时 / 每周 / 每月滚动用量百分比 + 重置时间 | `opencodeGoKey`：opencode.ai 控制台的订阅 Key |
| DeepSeek | 账户余额（总额 / 赠送 / 充值）与可用状态 | `deepseekKey`：`sk-` 开头的 API Key |
| 智谱 GLM | 现金余额；查不到时自动退到 Coding Plan 配额用量 | `glmKey` + 区域 `cn` / `global` |
| 小米 MiMo | 账户余额（总额 / 现金 / 赠送） | `mimoCookie`：**控制台 Cookie**，不是 API Key |

## 怎么填

控制台 →「技能」→ 找「余额 / 用量查询」→ ⚙ 设置 → 填对应项 → 保存。
**留空 = 不查这个渠道**，不会报错；没填的渠道会在结果里列成「已跳过」。

密钥输入框是密码框（显示 `******`），保存后不会再显示原文，留空保存表示「不修改」。

## 四个凭据分别从哪拿

- **OpenCode Go**：<https://opencode.ai> 登录 → 控制台 → 复制订阅用 Key。
- **DeepSeek**：<https://platform.deepseek.com> → API keys → 新建（`sk-` 开头）。
- **智谱 GLM**：<https://open.bigmodel.cn>（国内）或 <https://z.ai>（海外）→ API Keys。
  形如 `1234abcd.abcdefgh`；国内平台在设置里选 `cn`，z.ai 选 `global`。
- **小米 MiMo**：<https://platform.xiaomimimo.com> 登录 → 打开控制台余额页 →
  浏览器开发者工具 → Network → 找 `balance` 请求 → 复制**整条 Cookie**。
  它必须包含 `api-platform_serviceToken` 和 `userId` 两段，缺了会被直接判为无效。

## 为什么是技能而不是插件

按 `doc/extend_development/` 的三问判断法：

1. **触发时机能写成 if 吗？** —— 「消息里有『余额查询』」能写死，但「DeepSeek 还剩多少钱」
   「glm 额度用完没」这些同义说法要理解人话，还要判断查哪个渠道 → 半能，归技能。
2. **漏触发一次的代价？** —— 这次没答上来，下次再问就行，不丢数据 → 技能。
3. **参数从哪来？** —— 渠道名要从人话里抠 → 技能。

另外插件的钩子有 **5 秒硬超时且禁止发网络请求**，而余额接口常常要好几秒（海外渠道还要
等代理回退），做成插件必然出现「命中了却查不出来」——所以只能是技能。

## 隐私

- 密钥只在本技能设置里（`data/config.json` → `skills.balance-query`），**不进提示词、
  不进工具返回值、不写日志**；模型能看到的只有余额数字和失败原因。
- 需要联网，所以清单里声明了 `permissions: ["web_fetch"]`。
- 默认谁问都能查。若只想自己查，可在后续版本加白名单（当前版本未做）。

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 技能页显示「需要配置」 | 一个密钥都没填。填任意一个并保存即变「生效中」。 |
| OpenCode Go 报 401 | Key 无效，或这个 Key 没开通 Go 订阅。 |
| 智谱报「身份验证失败」 | Key 无效，或区域选错（国内 `cn` / z.ai `global`）。 |
| MiMo 报「Cookie 里缺少 …」 | 填成了 API Key。要的是浏览器 Cookie，且含 `api-platform_serviceToken`、`userId`。 |
| MiMo 报 401 | Cookie 过期，重新登录复制一次。 |
| 海外渠道超时 | 把「单渠道超时」调到 25000 以上；本机的「网络代理」插件会在直连失败后自动改走代理。 |
