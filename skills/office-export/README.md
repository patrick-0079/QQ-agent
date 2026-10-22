# 文件导出（Excel / Word / PPT / TXT / CSV）

让机器人真的产出文件并发到聊天里。**生成的是原生格式**（不是 CSV 改后缀、也不是把网页存成 .doc），双击就能用 Office / WPS / Excel 打开。

## 五个工具

| 工具 | 产出 | 说明 |
|---|---|---|
| `make_xlsx` | `.xlsx` | 多工作表、表头、列宽自适应；数字保持数字类型 |
| `make_docx` | `.docx` | 标题 1~6 级 / 段落 / 要点 / 表格 / 分页 |
| `make_pptx` | `.pptx` | 16:9、每页标题 + 要点 + 演讲者备注 |
| `make_csv` | `.csv` | **默认 UTF-8 BOM**（Excel 打开中文不乱码）；逗号/引号/换行由库转义 |
| `make_txt` | `.txt` | 换行统一 CRLF；可选 BOM |

默认**生成后直接发到当前会话**（`autoSend` 可关）。还有个 `send_file` 用来重发导出目录里的文件。

## 为什么用这套库

| 库 | 版本 | 用途 | 选它的原因 |
|---|---|---|---|
| `xlsx`（SheetJS） | 0.18.5 | 写 xlsx / 转 csv | 单包无依赖；`sheet_to_csv` 的转义靠谱 |
| `docx` | 9.12.0 | 写 docx | 官方维护、API 完整 |
| `pptxgenjs` | 4.0.1 | 写 pptx | 纯 JS，不需要 Office 或 LibreOffice |

**故意不用 `exceljs`**：它拖进来 200 个包 / 60MB（archiver、bluebird、es-abstract 那一堆）。换成 `xlsx` 后整套依赖是 35 包 / 42MB。

## ⚠️ 两个必读的坑（都踩过）

### 1. 取包必须用 `require`，不能用 `import()`

`pptxgenjs 4.0.1` 的 package.json 是：

```json
{ "exports": { "import": "./dist/pptxgen.es.js", "require": "./dist/pptxgen.cjs.js" } }
```

但它**没声明 `"type": "module"`**，而 `dist/pptxgen.es.js` 里写的是 `import JSZip from 'jszip'`。程序的运行时是 **Node 20（Electron 33）不自动探测 ESM**，于是把那个 `.js` 当 CJS 解析：

```
Cannot use import statement outside a module
```

所以本技能统一用 `createRequire(import.meta.url)` 取包，走 `exports.require` / `main` 的正牌 CJS 入口。

> 这个坑在 Node 22+ 上**测不出来**（会自动探测 ESM 语法）。验证必须在程序自己的运行时里做：
> `ELECTRON_RUN_AS_NODE=1 "QQ Agent.exe" your-script.mjs`

### 2. CSV 要带 BOM，否则 Excel 中文乱码

Excel 双击打开 CSV 时按本地编码猜，纯 UTF-8 的中文会变乱码。`make_csv` 默认写 `\uFEFF` 开头；需要干净 UTF-8（给程序读）时传 `bom:false`。

## 安全与稳健

- 文件名清洗：去掉 `\ / : * ? " < > |`、路径穿越（`../`）、首部的点和空格，限长 60；
- **只能写在导出目录里**（`exportDir` 或 `数据目录\exports`），最后一道路径校验防越界；
- 同名不覆盖：`表格.xlsx` → `表格-1.xlsx`；
- 体积上限（默认 12MB）：超了**不发**（免得 QQ 上传卡死），但文件保留并告知路径；
- 发送先试 `file:///` URI，失败退回**原始绝对路径**（有的协议端只认后者）。

## 设置项

| 键 | 默认 | 说明 |
|---|---|---|
| `autoSend` | 开 | 生成后自动发到当前会话 |
| `maxFileMB` | 12 | 超过不自动发送 |
| `exportDir` | 空 | 留空 = `数据目录\exports` |
| `fileNamePrefix` | 空 | 给所有文件名加前缀 |

## 验证方式

- 生成后用**另一套库**反向打开：`openpyxl` / `python-docx` / `python-pptx` / `csv` 模块，确认内容、数字类型、表格、备注、CSV 转义都正确；
- 用 `ELECTRON_RUN_AS_NODE=1` 在程序自己的 Node 20 上跑一遍（见坑 1）；
- 真发一次：`upload_private_file` 返回 `status=ok retcode=0` 才算通。
