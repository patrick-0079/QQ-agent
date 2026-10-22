// 极简 MCP 客户端：只实现"够用"的那部分协议。
//
// ── 为什么自己写而不装 @modelcontextprotocol/sdk ─────────────────────────
// 市场插件的硬约束：目录里不许出现 node_modules。要么把 SDK 的几百个文件打进来
// （还带一堆传递依赖），要么自己实现需要的 4 个方法。本文件选后者：
// initialize / tools.list / tools.call / notifications。
//
// ── 支持的传输 ───────────────────────────────────────────────────────────
//   stdio：最常见（npx、uvx、本地可执行文件），按行分隔 JSON-RPC
//   http ：远程服务，POST JSON-RPC；响应可能是 application/json，也可能是 SSE
//
// ── 踩过的坑 ─────────────────────────────────────────────────────────────
//   · Windows 上 `npx` 不是可执行文件，是 `npx.cmd`，直接 spawn 会 ENOENT；
//   · 服务端会把日志打到 stdout（协议要求只能打 stderr），解析失败的行要跳过而不是崩；
//   · venv/批处理类启动器会再 fork 一层，关进程要连子树一起收（taskkill /T）。

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'qq-agent-mcp-bridge', version: '1.0.0' };
const WIN = process.platform === 'win32';

/** Windows 上把 npx/npm/uvx 之类的命令补成 .cmd。 */
function resolveCommand(command) {
  if (!WIN || !command) return command;
  if (/[\\/]/.test(command) || /\.(exe|cmd|bat|com)$/i.test(command)) return command;
  const launchers = new Set(['npx', 'npm', 'pnpm', 'yarn', 'bunx', 'uvx', 'uv', 'deno']);
  return launchers.has(command.toLowerCase()) ? `${command}.cmd` : command;
}

function killTree(child) {
  if (!child || child.exitCode != null) return;
  try {
    if (WIN) {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      });
    } else {
      process.kill(-child.pid, 'SIGTERM');
    }
  } catch {
    try {
      child.kill();
    } catch {
      /* 已经退出 */
    }
  }
}

// ── JSON-RPC 连接基类 ─────────────────────────────────────────────────────

class JsonRpcConnection {
  constructor({ timeoutMs = 30000, onLog = () => {} } = {}) {
    this.timeoutMs = timeoutMs;
    this.onLog = onLog;
    this.nextId = 1;
    this.pending = new Map();
    this.serverInfo = null;
    this.protocolVersion = PROTOCOL_VERSION;
    this.capabilities = {};
  }

  _onMessage(parsed) {
    if (parsed?.id != null && (parsed.result !== undefined || parsed.error !== undefined)) {
      const entry = this.pending.get(parsed.id);
      if (!entry) return;
      this.pending.delete(parsed.id);
      clearTimeout(entry.timer);
      if (parsed.error) {
        entry.reject(new Error(parsed.error.message || `MCP 错误 ${parsed.error.code}`));
      } else {
        entry.resolve(parsed.result);
      }
      return;
    }
    if (parsed?.method) {
      if (parsed.method === 'ping' && parsed.id != null) {
        this._send({ jsonrpc: '2.0', id: parsed.id, result: {} });
        return;
      }
      // 其它服务端反向请求（sampling / roots / elicitation）：明确回"不支持"，
      // 让服务端自己决定降级，而不是一直等。
      if (parsed.id != null) {
        this._send({
          jsonrpc: '2.0',
          id: parsed.id,
          error: { code: -32601, message: `客户端不支持 ${parsed.method}` }
        });
      }
    }
  }

  _onParseError(raw) {
    // 协议要求 stdout 只放 JSON-RPC；有的服务会把启动横幅混进来，跳过即可。
    this.onLog(`忽略非协议输出：${String(raw).slice(0, 120)}`);
  }

  _send(message) {
    throw new Error('未实现 _send');
  }

  request(method, params = {}, timeoutMs = this.timeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时（${Math.round(timeoutMs / 1000)} 秒）`));
      }, Math.max(1000, timeoutMs));
      this.pending.set(id, { resolve, reject, timer });
      try {
        this._send({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    this._send({ jsonrpc: '2.0', method, params });
  }

  async initialize() {
    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO
    }, Math.max(this.timeoutMs, 20000));
    this.serverInfo = result?.serverInfo || null;
    this.capabilities = result?.capabilities || {};
    if (result?.protocolVersion) this.protocolVersion = result.protocolVersion;
    this.notify('notifications/initialized', {});
    return result;
  }

  async listTools() {
    const tools = [];
    let cursor;
    for (let page = 0; page < 20; page += 1) {
      const result = await this.request('tools/list', cursor ? { cursor } : {});
      if (Array.isArray(result?.tools)) tools.push(...result.tools);
      if (!result?.nextCursor) break;
      cursor = result.nextCursor;
    }
    return tools;
  }

  async callTool(name, args = {}, timeoutMs) {
    return this.request('tools/call', { name, arguments: args || {} }, timeoutMs);
  }

  async close() {}
}

// ── stdio 传输 ────────────────────────────────────────────────────────────

class StdioConnection extends JsonRpcConnection {
  constructor(options) {
    super(options);
    const { command, args = [], env = {}, cwd } = options;
    const resolved = resolveCommand(command);
    // Windows 上 .cmd/.bat 不能用 shell:false 直接 spawn（Node 会以 EINVAL 拒绝，
    // 这是修 CVE-2024-27980 后的行为），而 shell:true 又会触发 DEP0190
    // （参数不转义，有注入风险）。所以自己拼一条命令行交给 cmd /d /s /c。
    const needsCmd = WIN && /\.(cmd|bat)$/i.test(String(resolved));
    let spawnCommand = resolved;
    let spawnArgs = args;
    if (needsCmd) {
      const quote = (value) => {
        const text = String(value);
        return /[\s"&|<>^]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
      };
      spawnCommand = process.env.ComSpec || 'cmd.exe';
      spawnArgs = ['/d', '/s', '/c', `"${[quote(resolved), ...args.map(quote)].join(' ')}"`];
    }
    try {
      this.child = spawn(spawnCommand, spawnArgs, {
        cwd: cwd || process.cwd(),
        windowsHide: true,
        // 走 cmd 时必须原样传命令行，否则 Node 会把整串再包一层引号，
        // cmd 会把带引号的整串当成命令名（报"不是内部或外部命令"）。
        windowsVerbatimArguments: needsCmd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...env }
      });
    } catch (error) {
      throw new Error(
        `启动 ${spawnCommand} 失败：${error?.message ?? error}` +
          `（path=${error?.path || '-'}，syscall=${error?.syscall || '-'}）`
      );
    }
    this.exitInfo = null;
    this.buffer = '';

    // ⚠️ stdin 的 'error' 必须接住：MCP 进程中途退出时再写会抛 EPIPE，
    // 而流对象上没人监听 'error' 就是未捕获异常 —— 会把整个程序带崩（实测崩过）。
    this.child.stdin.on('error', (e) => { this.stdinError = String(e?.message ?? e); });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this._read(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      const line = String(chunk).trim();
      if (line) this.onLog(line.slice(0, 400));
    });
    this.child.on('error', (error) => {
      this.exitInfo = `启动失败：${error?.message ?? error}`;
      this._failAll(new Error(this.exitInfo));
    });
    this.child.on('exit', (code, signal) => {
      this.exitInfo = `进程退出（code=${code}${signal ? `，signal=${signal}` : ''}）`;
      this._failAll(new Error(this.exitInfo));
    });
  }

  _read(chunk) {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) {
        try {
          this._onMessage(JSON.parse(line));
        } catch {
          this._onParseError(line);
        }
      }
      index = this.buffer.indexOf('\n');
    }
    // 防呆：单行超长且没有换行时不要无限涨
    if (this.buffer.length > 8 * 1024 * 1024) this.buffer = '';
  }

  _send(message) {
    if (!this.child?.stdin?.writable) throw new Error('MCP 进程已退出，无法发送');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  _failAll(error) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.pending.delete(id);
    }
  }

  async close() {
    killTree(this.child);
  }
}

// ── HTTP 传输（streamable HTTP）────────────────────────────────────────────

class HttpConnection extends JsonRpcConnection {
  constructor(options) {
    super(options);
    this.url = String(options.url || '').trim();
    this.headers = { ...(options.headers || {}) };
    this.sessionId = '';
    this.buffer = '';
  }

  _send(message) {
    // 通知没有响应，也不能同步 await；单独发，失败只记日志。
    this._post(message).catch((error) => this.onLog(`发送失败：${error?.message ?? error}`));
  }

  async _post(message) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...this.headers
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    // 2025-06-18 版协议要求每个请求带版本头；老服务端会忽略，不影响。
    if (this.protocolVersion) headers['mcp-protocol-version'] = this.protocolVersion;
    const response = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    const sid = response.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (message.id == null) return null;
    if (!response.ok && response.status !== 202) {
      throw new Error(`HTTP ${response.status}`);
    }
    const type = response.headers.get('content-type') || '';
    if (type.includes('text/event-stream')) {
      return this._readStream(response, message.id);
    }
    const text = await response.text();
    if (!text.trim()) return null;
    try {
      const parsed = JSON.parse(text);
      this._onMessage(parsed);
      return parsed;
    } catch {
      this._onParseError(text);
      return null;
    }
  }

  /** 从 SSE 里挑出 id 匹配的那条响应。 */
  async _readStream(response, id) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split = buffer.indexOf('\n\n');
      while (split >= 0) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          try {
            const parsed = JSON.parse(data);
            this._onMessage(parsed);
            if (parsed?.id === id) return parsed;
          } catch {
            this._onParseError(data);
          }
        }
        split = buffer.indexOf('\n\n');
      }
    }
    return null;
  }

  async close() {
    if (!this.sessionId) return;
    try {
      await fetch(this.url, {
        method: 'DELETE',
        headers: { 'mcp-session-id': this.sessionId, ...this.headers },
        signal: AbortSignal.timeout(3000)
      });
    } catch {
      /* 关不掉就算了 */
    }
  }
}

// ── 对外：一个已连接的服务 ────────────────────────────────────────────────

export class McpServerConnection {
  /**
   * @param {object} server { name, type:'stdio'|'http', command, args, env, cwd, url, headers, timeoutMs }
   */
  constructor(server, { onLog = () => {} } = {}) {
    this.server = server;
    this.name = server.name;
    this.onLog = onLog;
    this.tools = [];
    this.status = 'idle';
    this.error = '';
    this.connectedAt = 0;
    this.conn = null;
  }

  async connect() {
    // 重连前先把旧连接收掉：否则 stdio 会留下一个孤儿进程，HTTP 会留下旧会话。
    if (this.conn) {
      const old = this.conn;
      this.conn = null;
      await old.close().catch(() => {});
    }
    this.status = 'connecting';
    const options = { timeoutMs: this.server.timeoutMs || 30000, onLog: this.onLog };
    try {
      const conn = this.server.type === 'http'
        ? new HttpConnection({ ...options, url: this.server.url, headers: this.server.headers })
        : new StdioConnection({ ...options, command: this.server.command, args: this.server.args,
            env: this.server.env, cwd: this.server.cwd });
      this.conn = conn;
      await conn.initialize();
      const tools = await conn.listTools();
      // 连接期间可能被 deactivate/closeAll 关掉（宿主热重载会先 deactivate 再 activate），
      // 这时不能把结果写回，否则会出现"看起来 ready 实际 conn 是 null"。
      if (this.conn !== conn) throw new Error('连接已被关闭');
      this.tools = tools;
      this.status = 'ready';
      this.error = '';
      this.connectedAt = Date.now();
      return true;
    } catch (error) {
      this.status = 'error';
      this.error = error?.message ?? String(error);
      await this.close();
      return false;
    }
  }

  async callTool(name, args, timeoutMs) {
    if (this.status !== 'ready' || !this.conn) {
      throw new Error(`MCP 服务 ${this.name} 未连接（${this.error || this.status}）`);
    }
    return this.conn.callTool(name, args, timeoutMs);
  }

  async close() {
    const conn = this.conn;
    this.conn = null;
    if (conn) await conn.close().catch(() => {});
    if (this.status !== 'error') this.status = 'closed';
  }

  describe() {
    return {
      name: this.name,
      type: this.server.type,
      status: this.status,
      error: this.error,
      tools: this.tools.map((tool) => ({
        name: tool.name,
        description: String(tool.description || '').replace(/\s+/g, ' ').slice(0, 200),
        inputSchema: tool.inputSchema || null
      }))
    };
  }
}

export { PROTOCOL_VERSION };
