// MCP 桥 · 让 QQ agent 用上任意 MCP 服务
//
// ── 它解决什么 ────────────────────────────────────────────────────────────
// MCP（Model Context Protocol）已经是「工具生态」的事实标准：文件系统、GitHub、
// 浏览器、数据库、搜索、各种 SaaS 都有现成 server。qq-agent 没有内建 MCP 客户端，
// 这个插件补上，并且一次补两层：
//   · 给模型：mcp_list / mcp_call / mcp_reload 三个工具（LLM 型入口）
//   · 给其它插件：mcp.call / mcp.list 两个能力（确定性入口，不走模型）
//
// ── 为什么是"薄客户端"而不是打包 SDK ──────────────────────────────────────
// 市场禁止插件带 node_modules。SDK 会拖进几十个文件，所以协议层自己写了 4 个方法，
// 见 mcp-client.js。代价是不支持 sampling/roots 这类反向能力（聊天机器人也用不上）。
//
// ── 配置的两种写法 ────────────────────────────────────────────────────────
// 直接粘贴 Claude Desktop 的配置（mcpServers 形态）就能用，这是刻意的：
// 用户在别处攒的 MCP 配置不用翻译。
//
// ── 安全边界 ──────────────────────────────────────────────────────────────
//   · 只能连「配置里显式列出的」服务，模型无法动态添加（避免"让它跑个命令"变成 RCE）；
//   · 子进程没有终端（windowsHide），超时自动放弃；
//   · 输出统一截断，防止一个超大响应把上下文撑爆。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 用带时间戳的动态 import：宿主热重载只会给 index.js 加 ?t=，
// 静态 import 的子模块会命中 ESM 缓存拿不到新代码（踩过：改了 mcp-client 但一直跑旧版）。
const { McpServerConnection } = await import(`./mcp-client.js?t=${Date.now()}`);

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(PLUGIN_DIR, '..', '..');
const DATA_DIR = path.join(APP_ROOT, 'data', 'mcp-bridge');
const MEDIA_DIR = path.join(DATA_DIR, 'media');

let cfg = () => ({});
let log = () => {};
let warn = () => {};

/** 追加写文件，超过上限就清空重来（避免日志无限长大）。 */
function appendCapped(file, text, maxBytes = 512 * 1024) {
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > maxBytes) fs.writeFileSync(file, '');
  } catch {
    /* 检查失败就继续写 */
  }
  try {
    fs.appendFileSync(file, text, 'utf8');
  } catch {
    /* 写不了不影响功能 */
  }
}

/** 清掉三天前的 MCP 图片，避免长期运行把磁盘堆满。 */
function pruneMedia(maxAgeMs = 3 * 24 * 60 * 60 * 1000) {
  try {
    if (!fs.existsSync(MEDIA_DIR)) return;
    const now = Date.now();
    for (const name of fs.readdirSync(MEDIA_DIR)) {
      const file = path.join(MEDIA_DIR, name);
      try {
        if (now - fs.statSync(file).mtimeMs > maxAgeMs) fs.unlinkSync(file);
      } catch {
        /* 单个删不掉不影响其它 */
      }
    }
  } catch {
    /* 目录不存在 */
  }
}

/** 插件日志只到控制台，用户看不到；关键失败同时落一份文件，排障时直接看它。 */
function warnFile(message) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    appendCapped(
      path.join(DATA_DIR, 'last-error.log'),
      `${new Date().toISOString()} ${String(message).slice(0, 500)}\n`
    );
  } catch {
    /* 写不了就算了，不能因为日志把功能带崩 */
  }
}

/** name -> McpServerConnection */
const connections = new Map();
let connecting = null;

// ── 配置 ──────────────────────────────────────────────────────────────────

function settings() {
  const s = cfg() || {};
  return {
    serversJson: String(s.serversJson || '').trim(),
    serversFile: String(s.serversFile || '').trim(),
    autoStart: s.autoStart !== false,
    callTimeoutMs: Math.max(3000, Number(s.callTimeoutMs) || 60000),
    maxOutputChars: Math.max(800, Number(s.maxOutputChars) || 4000)
  };
}

/** 读配置文件：优先 serversFile（存在才读），否则用 settings 里的 JSON。 */
function rawConfigText() {
  const s = settings();
  if (s.serversFile) {
    try {
      return fs.readFileSync(s.serversFile, 'utf8');
    } catch (error) {
      warn(`读取 ${s.serversFile} 失败：${error?.message ?? error}`);
    }
  }
  return s.serversJson;
}

/** 兼容三种写法：{mcpServers:{...}} / {servers:[...]} / 裸数组。 */
function normalizeServers(text) {
  const content = String(text || '').trim();
  if (!content) return [];
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    warn(`MCP 配置不是合法 JSON：${error?.message ?? error}`);
    return [];
  }

  let entries = [];
  if (Array.isArray(parsed)) {
    entries = parsed.map((item) => ({ ...item }));
  } else if (parsed && typeof parsed === 'object' && parsed.mcpServers && typeof parsed.mcpServers === 'object') {
    entries = Object.entries(parsed.mcpServers).map(([name, item]) => ({ name, ...item }));
  } else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.servers)) {
    entries = parsed.servers.map((item) => ({ ...item }));
  } else if (parsed && typeof parsed === 'object') {
    // { "fs": {command...}, "gh": {...} } 这种扁平写法
    entries = Object.entries(parsed)
      .filter(([, value]) => value && typeof value === 'object' && (value.command || value.url))
      .map(([name, item]) => ({ name, ...item }));
  }

  const out = [];
  const seen = new Set();
  for (const entry of entries) {
    const name = String(entry.name || entry.id || '').trim();
    if (!name || seen.has(name)) continue;
    if (entry.enabled === false || entry.disabled === true) continue;
    const type = entry.type === 'http' || entry.url ? 'http' : 'stdio';
    const server = {
      name,
      type,
      command: String(entry.command || '').trim(),
      args: Array.isArray(entry.args) ? entry.args.map(String) : [],
      env: entry.env && typeof entry.env === 'object' ? entry.env : {},
      cwd: entry.cwd ? String(entry.cwd) : '',
      url: String(entry.url || '').trim(),
      headers: entry.headers && typeof entry.headers === 'object' ? entry.headers : {},
      timeoutMs: Math.max(3000, Number(entry.timeoutMs) || settings().callTimeoutMs)
    };
    if (type === 'stdio' && !server.command) continue;
    if (type === 'http' && !server.url) continue;
    seen.add(name);
    out.push(server);
  }
  return out;
}

// ── 连接管理 ──────────────────────────────────────────────────────────────

async function connectAll({ force = false } = {}) {
  if (connecting) return connecting;
  connecting = (async () => {
    pruneMedia();
    const servers = normalizeServers(rawConfigText());
    if (!servers.length) {
      log('没有配置 MCP 服务（设置里填 serversJson，或指定 serversFile）');
      return;
    }

    if (force) await closeAll();
    const wanted = new Set(servers.map((s) => s.name));
    for (const [name, conn] of [...connections]) {
      if (!wanted.has(name)) {
        await conn.close();
        connections.delete(name);
      }
    }

    for (const server of servers) {
      const existing = connections.get(server.name);
      if (existing && existing.status === 'ready' && !force) continue;
      if (existing) await existing.close();
      const conn = new McpServerConnection(server, {
        onLog: (line) => {
          log(`[${server.name}] ${line}`);
          // 服务端 stderr 也要落盘：连接失败时这是唯一能看出原因的地方。
          try {
            fs.mkdirSync(DATA_DIR, { recursive: true });
            appendCapped(
              path.join(DATA_DIR, `${server.name}.log`),
              `${new Date().toISOString()} ${String(line).slice(0, 500)}\n`
            );
          } catch {
            /* 日志写不了不影响连接 */
          }
        }
      });
      connections.set(server.name, conn);
      try {
        const ok = await conn.connect();
        if (ok) {
          log(`已连接 ${server.name}（${conn.tools.length} 个工具，${server.type}）`);
        } else {
          warn(`连接 ${server.name} 失败：${conn.error}`);
        }
      } catch (error) {
        conn.status = 'error';
        conn.error = error?.message ?? String(error);
        warn(`连接 ${server.name} 异常：${conn.error}`);
      }
    }
    // 落一份状态快照：插件日志只到控制台，用户排障时看这个文件最快。
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(DATA_DIR, 'status.json'),
        JSON.stringify(
          { updatedAt: new Date().toISOString(), servers: [...connections.values()].map((c) => c.describe()) },
          null,
          2
        ),
        'utf8'
      );
    } catch {
      /* 状态文件写不了不影响连接 */
    }
  })().finally(() => {
    connecting = null;
  });
  return connecting;
}

async function closeAll() {
  // 先摘下来再关：关的过程是异步的，如果边关边清空，
  // 正在重连的新连接会被一起关掉（热重载时 deactivate 与 activate 是连着触发的）。
  const snapshot = [...connections.values()];
  connections.clear();
  for (const conn of snapshot) {
    await conn.close().catch(() => {});
  }
}

/** 按 server 名或工具名找连接。找不到时给出可读的候选清单。 */
function resolveTarget(serverName, toolName) {
  const name = String(serverName || '').trim();
  if (name) {
    const conn = connections.get(name);
    if (!conn) throw new Error(`没有名为 ${name} 的 MCP 服务；已配置：${[...connections.keys()].join('、') || '（无）'}`);
    return { conn, tool: String(toolName || '').trim() };
  }
  const matches = [...connections.values()].filter((conn) =>
    conn.tools.some((tool) => tool.name === String(toolName || '').trim())
  );
  if (matches.length === 1) return { conn: matches[0], tool: String(toolName).trim() };
  if (!matches.length) throw new Error(`没有哪个 MCP 服务提供工具 ${toolName}；先调 mcp_list 看看`);
  throw new Error(`工具 ${toolName} 在多个服务里都有（${matches.map((m) => m.name).join('、')}），请指定 server`);
}

// ── 输出格式化 ────────────────────────────────────────────────────────────

function truncate(text) {
  const limit = settings().maxOutputChars;
  const value = String(text ?? '');
  return value.length > limit ? `${value.slice(0, limit)}\n…（已截断，共 ${value.length} 字）` : value;
}

/** 图片类结果落盘，返回可读路径；单个超过 8MB 不落盘（防止把磁盘写满）。 */
function saveImage(item, index) {
  try {
    const mime = String(item?.mimeType || 'image/png').toLowerCase();
    const ext = mime.includes('jpeg') ? 'jpg' : mime.includes('webp') ? 'webp' : mime.includes('gif') ? 'gif' : 'png';
    const buffer = Buffer.from(String(item?.data || ''), 'base64');
    if (!buffer.length) return null;
    if (buffer.length > 8 * 1024 * 1024) return { skipped: true, size: buffer.length };
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    const file = path.join(MEDIA_DIR, `${Date.now()}-${index}.${ext}`);
    fs.writeFileSync(file, buffer);
    return { file, size: buffer.length };
  } catch {
    return null;
  }
}

/** 把 MCP 的 content[] 变成一段文字；图片落盘。 */
function formatContent(result) {
  const parts = [];
  const content = Array.isArray(result?.content) ? result.content : [];
  let imageIndex = 0;
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'text') {
      parts.push(String(item.text || ''));
    } else if (item.type === 'image') {
      imageIndex += 1;
      const saved = saveImage(item, imageIndex);
      if (saved?.file) {
        parts.push(`[图片 ${imageIndex} 已保存：${saved.file}（${Math.round(saved.size / 1024)}KB）]`);
      } else if (saved?.skipped) {
        parts.push(`[图片 ${imageIndex} 太大（${Math.round(saved.size / 1048576)}MB），未保存]`);
      } else {
        parts.push(`[图片 ${imageIndex}：${item.mimeType || 'image'}，无法解析]`);
      }
    } else if (item.type === 'resource') {
      const res = item.resource || {};
      parts.push(`[资源 ${res.uri || ''}]\n${res.text || '(二进制内容)'}`);
    } else if (item.type === 'resource_link') {
      parts.push(`[链接] ${item.name || ''} ${item.uri || ''}`);
    } else {
      parts.push(JSON.stringify(item).slice(0, 500));
    }
  }
  if (!parts.length && result != null) {
    parts.push(typeof result === 'string' ? result : JSON.stringify(result));
  }
  const text = parts.join('\n').trim();
  return truncate(text || '（工具没有返回内容）');
}

function describeTools(conn) {
  const lines = [`- ${conn.name}（${conn.server.type}，${conn.status === 'ready' ? `${conn.tools.length} 个工具` : conn.status}）`];
  if (conn.status !== 'ready') {
    lines.push(`  原因：${conn.error || '未连接'}`);
    return lines.join('\n');
  }
  for (const tool of conn.tools) {
    const schema = tool.inputSchema || {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    const params = Object.keys(schema.properties || {})
      .map((key) => (required.includes(key) ? `${key}*` : key))
      .join(', ');
    const desc = String(tool.description || '').replace(/\s+/g, ' ').slice(0, 120);
    lines.push(`  · ${tool.name}${params ? `（${params}）` : ''}${desc ? ` — ${desc}` : ''}`);
  }
  return lines.join('\n');
}

/** 调工具，失败且连接仍显示 ready 时重连一次再试（会话过期很常见）。 */
async function callWithRetry(conn, tool, args, timeoutMs) {
  try {
    return await conn.callTool(tool, args, timeoutMs);
  } catch (error) {
    if (conn.status !== 'ready') throw error;
    const reconnected = await conn.connect();
    if (!reconnected) throw error;
    log(`[${conn.name}] 调用失败后重连成功，重试 ${tool}`);
    return conn.callTool(tool, args, timeoutMs);
  }
}

async function ensureServer(name) {
  const conn = connections.get(name);
  if (!conn) return null;
  if (conn.status === 'ready') return conn;
  const ok = await conn.connect();
  return ok ? conn : conn;
}

// ── 工具（给模型）──────────────────────────────────────────────────────────

/** 模型有时把 arguments 写成 JSON 字符串；容忍一下，别直接报参数错误。 */
function normalizeArgs(value) {
  if (value == null) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' ? value : {};
}

function toolResult(text, isError = false) {
  return { content: String(text), ...(isError ? { isError: true } : {}) };
}

function registerTools(api) {
  api.registerTool({
    id: 'mcp_list',
    name: 'MCP 工具清单',
    description: '列出已接入的 MCP 服务以及它们提供的工具（含参数名）。调用 MCP 工具前先看这个，不要凭记忆猜工具名。',
    category: 'query',
    icon: '🧩',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: '可选。只看某一个服务，例如 github。' }
      }
    },
    async execute(_ctx, args) {
      const only = String(args?.server || '').trim();
      const all = [...connections.values()].filter((conn) => !only || conn.name === only);
      if (!all.length) {
        return toolResult(
          '目前没有连上的 MCP 服务。检查「MCP 桥」插件的设置：serversJson 是否填了、命令是否装好。'
        );
      }
      const ready = all.filter((conn) => conn.status === 'ready');
      const lines = [`已接入 ${ready.length}/${all.length} 个 MCP 服务：`];
      for (const conn of all) lines.push(describeTools(conn));
      lines.push('调用方式：mcp_call（server + tool + arguments）。');
      return toolResult(truncate(lines.join('\n')));
    }
  });

  api.registerTool({
    id: 'mcp_call',
    name: '调用 MCP 工具',
    description:
      '调用某个 MCP 服务里的工具。不确定有哪些工具时先调 mcp_list。参数要按该工具的 inputSchema 填，别自创字段。',
    category: 'query',
    icon: '🧩',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: '服务名（mcp_list 里括号前的那个）。同名工具只在一个服务里时可省略。' },
        tool: { type: 'string', description: '工具名，例如 read_file / search_repositories。' },
        arguments: { type: 'object', description: '工具参数对象，按 inputSchema 填。没有参数就留空。' }
      },
      required: ['tool']
    },
    async execute(_ctx, args) {
      const toolName = String(args?.tool || '').trim();
      if (!toolName) return toolResult('缺少 tool：要调哪个工具？先 mcp_list 看看。', true);
      try {
        let { conn, tool } = resolveTarget(args?.server, toolName);
        conn = await ensureServer(conn.name);
        if (!conn || conn.status !== 'ready') {
          return toolResult(`MCP 服务 ${conn?.name || ''} 连不上：${conn?.error || '未知原因'}`, true);
        }
        const result = await callWithRetry(conn, tool, normalizeArgs(args?.arguments), settings().callTimeoutMs);
        const text = formatContent(result);
        return toolResult(text, Boolean(result?.isError));
      } catch (error) {
        return toolResult(`调用失败：${error?.message ?? error}`, true);
      }
    }
  });

  api.registerTool({
    id: 'mcp_reload',
    name: '重连 MCP 服务',
    description: '改完 MCP 配置或某个服务崩了之后，重新读取配置并连接全部服务。',
    category: 'system',
    icon: '🔄',
    parameters: { type: 'object', properties: {} },
    async execute() {
      await connectAll({ force: true });
      const lines = [...connections.values()].map(
        (conn) => `- ${conn.name}：${conn.status === 'ready' ? `${conn.tools.length} 个工具` : `${conn.status}（${conn.error}）`}`
      );
      return toolResult(lines.length ? `重连完成：\n${lines.join('\n')}` : '没有配置任何 MCP 服务。');
    }
  });
}

// ── 能力（给其它插件）──────────────────────────────────────────────────────

export const providers = {
  'mcp.list': () => [...connections.values()].map((conn) => conn.describe()),
  'mcp.call': async ({ server, tool, arguments: args, timeoutMs } = {}) => {
    const target = resolveTarget(server, tool);
    const conn = (await ensureServer(target.conn.name)) || target.conn;
    if (conn.status !== 'ready') {
      throw new Error(`MCP 服务 ${conn.name} 不可用：${conn.error || conn.status}`);
    }
    const result = await callWithRetry(conn, target.tool, args || {}, timeoutMs || settings().callTimeoutMs);
    return { ok: !result?.isError, text: formatContent(result), raw: result };
  }
};

// ── 生命周期 ──────────────────────────────────────────────────────────────

export function setup(api) {
  cfg = api.config;
  log = api.log;
  warn = (...args) => {
    api.warn(...args);
    warnFile(args.map(String).join(' '));
  };
  registerTools(api);
}

export function available() {
  const s = settings();
  if (!s.serversJson && !s.serversFile) {
    return { ok: false, reason: '还没配置 MCP 服务：在设置里填 serversJson（可直接粘贴 Claude Desktop 配置）' };
  }
  return true;
}

export function activate() {
  if (!settings().autoStart) {
    log('自动连接已关闭，等第一次调用时再连');
    return;
  }
  connectAll().catch((error) => warn(`连接 MCP 服务失败：${error?.message ?? error}`));
}

export function deactivate() {
  closeAll().catch(() => {});
}

export function dispose() {
  closeAll().catch(() => {});
}

// 供其它模块/测试使用
export { connectAll, normalizeServers, formatContent };






