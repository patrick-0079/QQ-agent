# 明日方舟数据库（ark-db）

接 [PRTS · prts.wiki](https://prts.wiki/) 的实时查询技能。不落全站数据，查一次拉一次；干员/黑话只存索引。

## 五个工具

| 工具 | 用途 |
|---|---|
| `ark-db__ark_operator` | 干员卡：星级/职业·分支/阵营/标签/特性/部署/面板/天赋/技能/精英化材料/潜能。**外号也能直接查** |
| `ark-db__ark_nick` | 外号 → 干员（老板=银灰、42=史尔特尔、小羊=艾雅法拉），黑话 → PRTS 词条（充电宝、逃课、七星干员） |
| `ark-db__ark_search` | 全站搜索页面标题 |
| `ark-db__ark_page` | 任意页面正文摘要（去模板/表格/HTML），默认 800 字 |
| `ark-db__ark_sync` | 重建干员索引（约 460 个）与黑话索引（63 条） |

## 数据来源与解析

- 接口：`https://prts.wiki/api.php`（MediaWiki，`formatversion=2`）
- 干员页 wikitext 里的模板：
  - `{{CharinfoV2}}` → 代号、外文名、稀有度（数字，**+1 = 星级**）、职业、分支、特性、国家、标签、配音
  - `{{属性}}` → 再部署、部署费用、阻挡数、攻击间隔、所属势力、精英 0/1/2 各档生命/攻击/防御/法抗
  - `{{天赋列表3}}` → 天赋 1~3 名称/解锁条件/效果
  - `{{技能2}}` ×N → 技能名、回复类型/触发类型、描述（取最后一档强化后）
  - `{{精英化材料}}` → `精1/精2` 里的 `{{材料消耗|名称|数量}}`
  - `{{潜能提升}}` → 潜能 2~6
- 干员索引：`Category:干员`（463 条，去掉 `/spine`），每批 40 个标题一次请求，约 12 次请求
- 黑话索引：命名空间前缀 `明日方舟黑话·梗·成句/` 的 63 个子页（term = 路径末段，如「充电宝」「逃课」）

## 索引文件

| 文件 | 内容 |
|---|---|
| `data/operators.json` | 干员索引：title/代号/英文/日文/职业/分支/星级/标签/势力 |
| `data/slang.json` | 黑话索引：term → PRTS 词条标题 |
| `data/nicknames.json` | 社区外号映射（**可手改**；只在文件不存在时写入默认值，升级不覆盖） |
| `data/cache.json` | 页面缓存 24h、搜索缓存 6h |

干员索引缺失或超过 7 天、黑话索引超过 30 天时，启动后后台自动重建（十几秒，不挡启动）。

## 自测

```powershell
$tmp = "$env:TEMP\probe-ark.mjs"
@'
import { internals } from 'file:///C:/Users/零陵灵/AppData/Local/Programs/QQ%20Agent/resources/app/skills/ark-db/index.js';
console.log((await internals.buildOperatorCard('银灰')).text);
console.log((await internals.buildPageDigest('充电宝', 500)).text);
'@ | Set-Content $tmp -Encoding UTF8
& node $tmp
```

## 已知限制

- 面板只取「精英 0 1 级 → 精英 2 满级」两档，中间档不给
- 技能描述只取强化后最后一档，看不到专精 1/2/3 的数值差异
- 模组解析未做（用 `ark_page` 读模组页）
- 黑话只给词条标题，解释要 `ark_page` 现读
- 站点模板改版会导致解析失败，届时改 `findTemplates` 的模板名与字段名
