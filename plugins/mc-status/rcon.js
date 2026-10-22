/**
 * rcon.js —— Minecraft RCON 客户端（Source RCON 协议，零依赖）
 *
 * MC 的 RCON 用的是 Valve 的 Source RCON：TCP 长连接，先认证再发命令。
 * 包格式： int32 长度(不含自身) + int32 请求ID + int32 类型 + body + 0x00 + 0x00
 *   类型 3 = 认证，2 = 执行命令，0 = 命令响应；认证失败时服务器回的 ID 是 -1。
 *
 * ⚠️ 「命令响应的类型」各家实现不统一，别只认 0：
 *   · 原版 MC / Paper：type 0（RESPONSE_VALUE）
 *   · **Cuberite：type 2** —— 实测 `list` 回的包是 `size=29 id=2 type=2 body="Players (1): …"`
 *   而 type 2 同时也是认证响应的类型，所以**必须靠请求 ID 区分**（认证用 1、命令用 2）。
 *   2026-09-24 之前只认 type 0，对着 Cuberite 会一路等到超时。
 *
 * ⚠️ 这个模块**只负责把命令送过去、把结果拿回来**。谁能执行什么命令、
 *    要不要放行危险命令，是 index.js 里 toolRcon() 的事 —— 协议层不做权限判断，
 *    免得有人以为"绕过工具直接调 execRcon 就安全"。
 */
import net from 'node:net';

const TYPE_RESPONSE = 0;
const TYPE_COMMAND = 2;
const TYPE_AUTH = 3;

/** 组包：body 后面要跟两个 NUL（body 终止符 + 一个空字符串） */
function pack(id, type, body) {
  const payload = Buffer.concat([Buffer.from(String(body ?? ''), 'utf8'), Buffer.from([0, 0])]);
  const buf = Buffer.alloc(4 + 4 + 4 + payload.length);
  buf.writeInt32LE(4 + 4 + payload.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payload.copy(buf, 12);
  return buf;
}

/**
 * 把收到的数据切成完整包（TCP 会粘包/拆包，必须自己攒 buffer）。
 * @returns {{packets:Array<{id:number,type:number,body:string}>, rest:Buffer}}
 */
export function splitPackets(buf) {
  const packets = [];
  let off = 0;
  while (buf.length - off >= 4) {
    const size = buf.readInt32LE(off);
    if (size < 10 || size > 4 * 1024 * 1024) break;   // 异常长度 -> 对方不是 RCON，直接停
    if (buf.length - off < 4 + size) break;           // 还没收全
    const id = buf.readInt32LE(off + 4);
    const type = buf.readInt32LE(off + 8);
    // body 结尾有两个 NUL，去掉末尾的空字节
    const raw = buf.subarray(off + 12, off + 4 + size);
    const body = raw.toString('utf8').replace(/\0+$/, '');
    packets.push({ id, type, body });
    off += 4 + size;
  }
  return { packets, rest: buf.subarray(off) };
}

// 请求 id 固定用两个不同值：认证 1、命令 2。
// 有了它才能把"命令响应"和"认证响应"分开 —— 两者可能撞在同一个 type 上（见下面命令响应的注释）。
const AUTH_ID = 1;
const CMD_ID = 2;

/** 收完最后一片响应后，还等这么久看有没有后续包（应对"不发结束包"的实现）。 */
const SETTLE_MS = 250;

/**
 * 执行一次 RCON 命令。
 * @returns {Promise<{ok:boolean, output:string, error?:string}>}
 *   ⚠️ 永不抛异常也永不回显密码：失败一律走 {ok:false,error}，
 *      调用方可以放心把 error 扔给模型/日志（密码不会出现在里面）。
 */
export function execRcon({ host, port = 25575, password = '', command = '', timeout = 5000 } = {}) {
  return new Promise((resolve) => {
    if (!host) return resolve({ ok: false, output: '', error: '没填 RCON 地址' });
    if (!password) return resolve({ ok: false, output: '', error: '没填 RCON 密码' });
    if (!String(command).trim()) return resolve({ ok: false, output: '', error: '命令是空的' });

    let settled = false;
    let buf = Buffer.alloc(0);
    let authed = false;
    const parts = [];          // 命令响应的分片（长输出会被拆成多个包）
    let settle = null;
    const sock = new net.Socket();

    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(settle);
      try { sock.destroy(); } catch { /* 已断开 */ }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, output: '', error: 'RCON 超时（服务器没开 rcon 或端口不通）' }),
      Math.max(1000, Number(timeout) || 5000));

    sock.on('error', (e) => finish({ ok: false, output: '', error: `RCON 连接失败：${String(e?.message || e)}` }));

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { packets, rest } = splitPackets(buf);
      buf = rest;
      for (const p of packets) {
        if (!authed) {
          // 认证响应：ID 回显成功，ID = -1 表示密码错误
          if (p.id === -1) return finish({ ok: false, output: '', error: 'RCON 认证失败（密码不对，或服务器没开 rcon）' });
          authed = true;
          sock.write(pack(CMD_ID, TYPE_COMMAND, command));
          continue;
        }

        /* ── 命令响应 ────────────────────────────────────────────────────
           ⚠️ **不能只认 type 0**（2026-09-24 修，用户报警"RCON 发指令没反应"）：
           原版 MC 用 type 0（RESPONSE_VALUE）回命令结果，但 **Cuberite 用 type 2** 回
           （实测包体：size=29 id=2 type=2 body="Players (1): …"）。只认 0 的话，
           对着 Cuberite 永远等不到响应 → 一路等到超时，报"服务器没开 rcon 或端口不通"，
           而实际上认证早就成功了（能被这个错报带偏，去查防火墙）。
           所以 0 和 2 都收 —— 这也是为什么上面的请求 id 要分开：认证响应同样是 type 2，
           靠 `p.id !== CMD_ID` 把它挡掉，否则认证响应会被当成"命令执行完、输出为空"。
           ─────────────────────────────────────────────────────────────── */
        if (p.id !== CMD_ID) continue;
        if (p.type !== TYPE_RESPONSE && p.type !== TYPE_COMMAND) continue;
        parts.push(p.body);
        // 空包 = 这一个响应结束了（原版和 Cuberite 都会发一个空包收尾）
        if (!p.body) return finish({ ok: true, output: parts.join('') });
        // 兜底：有的实现不发结束包，那就收完最后一片后稍等一下再返回
        clearTimeout(settle);
        settle = setTimeout(() => finish({ ok: true, output: parts.join('') }), SETTLE_MS);
      }
    });

    sock.on('close', () => {
      // 连上了却没拿到响应：多半是密码错被踢，或服务器配置问题
      if (!settled) finish({ ok: false, output: '', error: authed ? 'RCON 连接被关闭，没拿到结果' : 'RCON 连接被关闭（密码不对？）' });
    });

    sock.connect(Number(port) || 25575, host, () => {
      sock.write(pack(AUTH_ID, TYPE_AUTH, password));
    });
  });
}
