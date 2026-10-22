/**
 * mcping —— Minecraft 服务器状态查询（纯协议实现，零第三方依赖）
 *
 * 为什么要自己实现而不用第三方 API：
 *   直连是唯一"不会因为别人家服务挂了/限流/改版就失效"的方案。本项目机器人在
 *   本机常驻运行，直连 TCP 完全可行，延迟还能自己测（第三方 API 给的是它到你服务器
 *   的延迟，不是你这台的）。第三方 API 只作为兜底选项保留（见 sources.js）。
 *
 * 两套协议：
 *   Java 版  —— TCP，Server List Ping（1.7+），默认端口 25565，支持 SRV 记录
 *   基岩版   —— UDP，RakNet Unconnected Ping，默认端口 19132
 *
 * ⚠️ 本模块不依赖项目任何东西，可独立测试。
 */
import net from 'node:net';
import dgram from 'node:dgram';
import dns from 'node:dns';

/* ── VarInt（Minecraft 的变长整数，最多 5 字节，小端、7 位一组） ── */
export function writeVarInt(value) {
  const out = [];
  // MC 的 VarInt 是 32 位有符号；protocol version 允许 -1（表示"不检查版本"）
  let n = value < 0 ? value + 0x100000000 : value >>> 0;
  for (let i = 0; i < 5; i++) {
    const b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) out.push(b | 0x80);
    else { out.push(b); break; }
  }
  return Buffer.from(out);
}

/** 返回 [值, 消耗的字节数]。数据没收全时抛「越界」，调用方据此继续等。 */
export function readVarInt(buf, off = 0) {
  let value = 0;
  for (let i = 0, shift = 0; i < 5; i++, shift += 7) {
    if (off + i >= buf.length) throw new Error('VarInt 越界');
    const b = buf[off + i];
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) {
      if (value >= 0x80000000) value -= 0x100000000; // 还原成有符号
      return [value, i + 1];
    }
  }
  throw new Error('VarInt 超过 5 字节');
}

/** MC 字符串 = VarInt 长度 + UTF-8 字节 */
const mcString = (s) => {
  const b = Buffer.from(String(s), 'utf8');
  return Buffer.concat([writeVarInt(b.length), b]);
};

/* ── MOTD 清洗 ────────────────────────────────────────────── */

/**
 * 把 MOTD 组件转成纯文本。
 * description 有三种形态，全都得认：
 *   1. 字符串（1.7 以前的旧版）           "A Server"
 *   2. 组件对象 { text: "..." }           {"text":"A Server"}
 *   3. 带 extra 的组件                    {"text":"","extra":[{"text":"A"},{"text":"B"}]}
 * 只取 text，颜色/点击事件这些属性丢掉——QQ 里显示不了，留着只会让字符串变长。
 */
export function extractText(comp) {
  if (comp == null) return '';
  if (typeof comp === 'string') return comp;
  if (Array.isArray(comp)) return comp.map(extractText).join('');
  if (typeof comp === 'object') {
    const self = typeof comp.text === 'string' ? comp.text : '';
    const extra = comp.extra != null ? extractText(comp.extra) : '';
    // translate 型组件（如 "multiplayer.disconnect.outdated"）没有 text，
    // 退而求其次用 translate 键名，总比空白强
    const fallback = typeof comp.translate === 'string' ? comp.translate : '';
    return self + extra || fallback;
  }
  return String(comp);
}

/**
 * 去掉 MC 的格式码：§ + 一位（颜色 0-9a-f / 格式 k-o / r 重置），
 * 以及部分插件用的 & 前缀。剩下的空白压成一个空格。
 * 典型输入 "§aHypixel §c[1.8]" → "Hypixel [1.8]"
 */
export function cleanMotd(s) {
  return String(s ?? '')
    .replace(/[§&][0-9a-fk-or]/gi, '')
    .replace(/[§&]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ── MOTD 彩色片段 ────────────────────────────────────────── */

/**
 * 把 MOTD 解析成「带颜色的片段」，供卡片渲染成彩色文字。
 *
 * 为什么要单独再解析一遍：extractText 为了压缩长度，把 color/bold 这些属性
 * **全丢了**——纯文本是回不去的。想在卡片上还原颜色，必须在解析阶段就留下。
 *
 * 颜色有两个来源，都得认：
 *   1. JSON 组件：{text:"Hi", color:"red"} 或 color:"#ff0000"（1.16+ 支持 hex）
 *   2. § 格式码字符串：§cHi（旧版、基岩版、第三方 API 基本都是这种）
 *
 * ⚠️ 安全红线：MOTD 是**服务器管理员可控的任意字符串**，会流进 HTML。
 *    所以颜色**只认白名单**（16 个色名 + 严格正则校验过的 #rrggbb），
 *    绝不把原字符串拼进 style；文本一律由渲染层转义。
 *    另外要限长度和片段数——服务器可以塞一万个片段把渲染拖死。
 */

/** 16 个标准色的名字（hex 之外的唯一合法值） */
export const MC_COLOR_NAMES = [
  'black', 'dark_blue', 'dark_green', 'dark_aqua', 'dark_red', 'dark_purple', 'gold', 'gray',
  'dark_gray', 'blue', 'green', 'aqua', 'red', 'light_purple', 'yellow', 'white'
];

/** § + 一位 的颜色码 → 色名。k/l/m/n/o 是格式不是颜色，r 是重置 */
const CODE_TO_COLOR = {
  '0': 'black', '1': 'dark_blue', '2': 'dark_green', '3': 'dark_aqua',
  '4': 'dark_red', '5': 'dark_purple', '6': 'gold', '7': 'gray',
  '8': 'dark_gray', '9': 'blue', 'a': 'green', 'b': 'aqua',
  'c': 'red', 'd': 'light_purple', 'e': 'yellow', 'f': 'white'
};

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** 防御上限：超过就截断，服务器塞再多也不怕 */
const MAX_MOTD_CHARS = 200;
const MAX_MOTD_SEGS = 40;

/** 归一成安全的颜色标识：色名 / 合法 hex / null（null = 用默认色） */
export function normalizeColor(c) {
  if (typeof c !== 'string') return null;
  const v = c.trim().toLowerCase();
  if (!v) return null;
  if (v.startsWith('#')) return HEX_COLOR.test(v) ? v : null;
  // ⚠️ 用 hasOwnProperty 而不是 includes：防原型链上的怪东西混进来
  return Object.prototype.hasOwnProperty.call(CODE_TO_COLOR, v) || MC_COLOR_NAMES.includes(v) ? v : null;
}

const EMPTY_STYLE = () => ({ color: null, bold: false, italic: false, underline: false, strike: false });

/**
 * 从 JSON 组件解析。子组件的样式**继承**父级（MC 的规则），
 * 子组件自己声明的字段覆盖继承值。
 */
function richFromComponent(comp, parent, out) {
  if (comp == null || out.done) return;
  if (typeof comp === 'string') { pushSegment(out, comp, parent); return; }
  if (Array.isArray(comp)) { for (const c of comp) richFromComponent(c, parent, out); return; }
  if (typeof comp !== 'object') { pushSegment(out, String(comp), parent); return; }

  const style = { ...parent };
  const c = comp.color != null ? normalizeColor(comp.color) : null;
  if (c) style.color = c;
  // ⚠️ 只认 true：MC 里 bold:false 是显式关闭，但我们默认就是 false，省得区分
  if (comp.bold === true) style.bold = true;
  if (comp.italic === true) style.italic = true;
  if (comp.underlined === true) style.underline = true;
  if (comp.strikethrough === true) style.strike = true;
  // ⚠️ obfuscated（§k）是**动态**乱码效果，用户明确说不要动画，
  //    所以这里直接忽略，按普通文字显示。

  const self = typeof comp.text === 'string' ? comp.text
    : typeof comp.translate === 'string' ? comp.translate : '';
  if (self) pushSegment(out, self, style);
  if (comp.extra != null) for (const e of (Array.isArray(comp.extra) ? comp.extra : [comp.extra])) {
    richFromComponent(e, style, out);
  }
}

/** 从 §/& 格式码字符串解析 */
function richFromCodes(s, out) {
  const str = String(s ?? '');
  let style = EMPTY_STYLE();
  let buf = '';
  const flush = () => { if (buf) pushSegment(out, buf, style); buf = ''; };

  for (let i = 0; i < str.length && !out.done; i++) {
    const ch = str[i];
    // & 前缀沿用 cleanMotd 的既有约定（很多插件这么写）；`&` 后面不是合法码就当普通字符
    if ((ch === '§' || ch === '&') && i + 1 < str.length && /[0-9a-fk-or]/i.test(str[i + 1])) {
      const code = str[i + 1].toLowerCase();
      flush();
      if (code === 'r') style = EMPTY_STYLE();
      else if (CODE_TO_COLOR[code]) style = { ...style, color: CODE_TO_COLOR[code] };
      else if (code === 'l') style = { ...style, bold: true };
      else if (code === 'o') style = { ...style, italic: true };
      else if (code === 'n') style = { ...style, underline: true };
      else if (code === 'm') style = { ...style, strike: true };
      // k（乱码）忽略 —— 不做动态效果
      i++; // 吃掉码位
      continue;
    }
    buf += ch;
  }
  flush();
}

function pushSegment(out, text, style) {
  if (out.done || !text) return;
  let t = String(text);
  const room = MAX_MOTD_CHARS - out.chars;
  if (room <= 0 || out.segs.length >= MAX_MOTD_SEGS) { out.done = true; return; }
  if (t.length > room) { t = t.slice(0, room); out.done = true; }
  if (!t) return;
  out.chars += t.length;
  out.segs.push({ text: t, color: style.color, bold: style.bold, italic: style.italic, underline: style.underline, strike: style.strike });
}

/**
 * MOTD → 片段数组。两种形态都吃：JSON 组件 / 带格式码的字符串。
 * 返回 [{text, color, bold, italic, underline, strike}, ...]
 */
export function parseMotdRich(comp) {
  const out = { segs: [], chars: 0, done: false };
  if (comp != null && typeof comp === 'object') richFromComponent(comp, EMPTY_STYLE(), out);
  else richFromCodes(comp, out);
  // 收尾：去掉首尾空白片段，不然 MOTD 常见的前后换行会留出空档
  while (out.segs.length && !out.segs[0].text.trim()) out.segs.shift();
  while (out.segs.length && !out.segs[out.segs.length - 1].text.trim()) out.segs.pop();
  return out.segs;
}

/** 有没有任何一个片段真的带了自定义颜色（用来决定要不要走彩色渲染） */
export function hasRichColor(segs) {
  return Array.isArray(segs) && segs.some((s) => s.color);
}

/* ── SRV 解析 ────────────────────────────────────────────── */
/**
 * 查 _minecraft._tcp.<host>。很多服务器把真实端口藏在 SRV 里
 * （域名指向 A 记录，实际 MC 开在另一个端口），不解析就会连错端口超时。
 * 查不到就返回 null（绝大多数服务器没配，正常现象，不是错误）。
 *
 * ⚠️ 带超时兜底（默认 1500ms）：dns.resolveSrv 自己没有超时参数，DNS 服务器不响应时
 *   这个 Promise 会一直挂着。单台时顶多是慢，多台并发（queryAll 是 Promise.all）
 *   会被最慢的那一个拖住，整次查询没有时间上限。查不到 SRV 的后果只是"用原端口连"，
 *   远比卡住轻 —— 所以超时就当没配。
 */
export function resolveSrv(host, timeoutMs = 1500) {
  return new Promise((resolve) => {
    // 已经是 IP 就没必要查
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return resolve(null);
    let done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => finish(null), Math.max(200, Number(timeoutMs) || 1500));
    dns.resolveSrv(`_minecraft._tcp.${host}`, (err, addrs) => {
      if (err || !Array.isArray(addrs) || !addrs.length) return finish(null);
      // priority 小的优先，同 priority 时 weight 大的优先
      const a = addrs.slice().sort((x, y) => (x.priority - y.priority) || (y.weight - x.weight))[0];
      finish({ host: a.name, port: a.port });
    });
  });
}

/* ── Java 版：Server List Ping ───────────────────────────── */
/**
 * @returns {Promise<{online:boolean, version, protocol, playersOnline, playersMax,
 *                    sample, motd, favicon, latency}>}
 *   latency 为 null 表示状态拿到了但延迟没测到（服务器不回 pong，老版本常见）
 */
export function pingJava(host, port = 25565, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    let settled = false;
    let buf = Buffer.alloc(0);
    let stage = 'response';   // response → ping → done
    let status = null;
    let tPing = 0;
    let pongTimer = null;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (pongTimer) clearTimeout(pongTimer);
      if (hardTimer) clearTimeout(hardTimer);
      try { sock.destroy(); } catch { /* 已断开 */ }
      fn(arg);
    };

    // ⚠️ 必须有这把"硬超时"（2026-09-29 实测踩坑）：Node 的 sock.setTimeout() **不覆盖
    //    连接建立阶段** —— 目标端口丢包（如 frp 隧道后端挂了）时，连接一直停在 SYN_SENT，
    //    'timeout' 事件永远不触发，这个 Promise 就永远不 settle。表现是：用户发 \服务器，
    //    机器人一个字都不回，会话永远"进行中"（用户实测卡 3 分钟以上）。
    //    硬超时覆盖"从发起连接到拿到结果"的全程，到点就 reject。
    //    上限取 timeout + 3000ms：正常路径是「连接 → 状态包（≤timeout 无活动）→ 等 pong
    //    （≤min(2500,timeout)）」，留 3 秒余量足够；再长就是真的连不上了。
    const hardTimer = setTimeout(() => finish(reject, new Error('连接超时')), Math.max(500, Number(timeout) || 5000) + 3000);

    sock.setTimeout(timeout);
    sock.on('error', (e) => finish(reject, e));
    sock.on('timeout', () => finish(reject, new Error('连接超时')));

    sock.connect(port, host, () => {
      // 握手：id=0x00，protocol=-1（不检查版本，任何版本都能连），nextState=1（status）
      const handshake = Buffer.concat([
        writeVarInt(0x00),
        writeVarInt(-1),
        mcString(host),
        Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        writeVarInt(1)
      ]);
      // 请求包：length=1, id=0x00
      const request = Buffer.from([0x01, 0x00]);
      sock.write(Buffer.concat([
        Buffer.concat([writeVarInt(handshake.length), handshake]),
        request
      ]));
    });

    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      // TCP 是字节流，一个 data 事件可能只来半个包，也可能粘了多个包 —— 循环解到解不动为止
      for (;;) {
        if (!buf.length) return;
        let len, n;
        try { [len, n] = readVarInt(buf, 0); } catch { return; }        // 长度字段都没收全
        if (buf.length < n + len) return;                                // 负载还没收全
        const payload = buf.slice(n, n + len);
        buf = buf.slice(n + len);

        let id, p;
        try { [id, p] = readVarInt(payload, 0); } catch { continue; }

        if (stage === 'response' && id === 0x00) {
          let slen, q;
          try { [slen, q] = readVarInt(payload, p); } catch { continue; }
          const raw = payload.slice(p + q, p + q + slen).toString('utf8');
          let j;
          try { j = JSON.parse(raw); } catch {
            return finish(reject, new Error('服务器返回的不是合法 JSON'));
          }
          status = {
            online: true,
            version: j.version?.name ?? '',
            protocol: j.version?.protocol ?? null,
            playersOnline: j.players?.online ?? null,
            playersMax: j.players?.max ?? null,
            sample: Array.isArray(j.players?.sample)
              ? j.players.sample.map((x) => String(x?.name ?? '')).filter(Boolean) : [],
            motd: cleanMotd(extractText(j.description)),
            // 彩色片段（同上，颜色信息在 extractText 里已经丢了，这里必须单独留一份）
            motdRich: parseMotdRich(j.description),
            favicon: typeof j.favicon === 'string' ? j.favicon : '',
            latency: null,
            raw: j
          };
          // 状态已拿到，接着在同一条连接上测延迟（ping/pong）
          stage = 'ping';
          const pl = Buffer.alloc(8);
          pl.writeBigInt64BE(BigInt(Date.now()));
          const pingPkt = Buffer.concat([writeVarInt(0x01), pl]);
          tPing = Date.now();
          // ⚠️ 老版本服务器不回 pong，不能干等 —— 超时就当没测到，状态照样返回
          pongTimer = setTimeout(() => finish(resolve, status), Math.min(2500, timeout));
          try {
            sock.write(Buffer.concat([writeVarInt(pingPkt.length), pingPkt]));
          } catch { finish(resolve, status); }
          continue;
        }

        if (stage === 'ping' && id === 0x01) {
          status.latency = Date.now() - tPing;
          return finish(resolve, status);
        }
        // 其余包忽略（mod 服务端会多塞东西）
      }
    });
  });
}

/* ── 基岩版：RakNet Unconnected Ping ─────────────────────── */
const RAKNET_MAGIC = Buffer.from([
  0x00, 0xff, 0xff, 0x00, 0xfe, 0xfe, 0xfe, 0xfe,
  0xfd, 0xfd, 0xfd, 0xfd, 0x12, 0x34, 0x56, 0x78
]);

/**
 * 基岩版走 UDP，数据包可能丢，所以失败要重试（默认 2 次）。
 * 返回结构与 Java 版对齐，但字段少（基岩版只给这些信息）。
 */
export function pingBedrock(host, port = 19132, timeout = 4000, retries = 2) {
  const once = () => new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      try { sock.close(); } catch { /* 已关闭 */ }
      fn(arg);
    };
    const timer = setTimeout(() => finish(reject, new Error('超时（UDP 无响应）')), timeout);

    // Unconnected Ping: 0x01 + 时间(8) + magic(16) + clientGUID(8)
    const t0 = Date.now();
    const pkt = Buffer.concat([
      Buffer.from([0x01]),
      (() => { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(t0)); return b; })(),
      RAKNET_MAGIC,
      (() => { const b = Buffer.alloc(8); b.writeBigInt64BE(0x02n); return b; })()
    ]);

    sock.on('error', (e) => finish(reject, e));
    sock.on('message', (msg) => {
      // Unconnected Pong: 0x1c + 时间(8) + serverGUID(8) + magic(16) + 长度(2) + 数据
      if (msg.length < 35 || msg[0] !== 0x1c) return;
      const latency = Date.now() - t0;
      const strLen = msg.readUInt16BE(33);
      const data = msg.slice(35, 35 + strLen).toString('utf8');
      // 数据形如：MCPE;Dedicated Server;560;1.20.30;0;10;...;Survival;...
      const f = String(data).split(';');
      // ⚠️ 分号分隔的字段在各版本里语义会漂移：实测 Cubecraft 的第 8 段是 "C"，
      //    有的版本是地图名、有的是游戏模式。只取公认稳定的前几段，
      //    多取一段就可能冒出「（C）」这种没头没尾的东西。
      finish(resolve, {
        online: true,
        edition: 'bedrock',
        version: f[3] || '',
        protocol: f[2] ? Number(f[2]) || null : null,
        playersOnline: f[4] != null && f[4] !== '' ? Number(f[4]) || 0 : null,
        playersMax: f[5] != null && f[5] !== '' ? Number(f[5]) || 0 : null,
        sample: [],
        motd: cleanMotd(f[1] || ''),
        motdRich: parseMotdRich(f[1] || ''),
        favicon: '',
        latency,
        raw: data
      });
    });

    sock.send(pkt, 0, pkt.length, port, host, (err) => {
      if (err) finish(reject, err);
    });
    sock.on('close', () => clearTimeout(timer));
  });

  return (async () => {
    let lastErr;
    for (let i = 0; i <= retries; i++) {
      try { return await once(); } catch (e) { lastErr = e; }
    }
    throw lastErr;
  })();
}

/**
 * 统一入口：按 edition 选协议；Java 版先解 SRV。
 * @param {string} host
 * @param {number} port 为 0/null 时用版本默认端口
 */
export async function pingServer(host, port, { edition = 'java', timeout = 5000, useSrv = true, useQuery = false } = {}) {
  const isBedrock = edition === 'bedrock';
  const defaultPort = isBedrock ? 19132 : 25565;
  let target = { host, port: Number(port) || defaultPort };

  if (!isBedrock && useSrv) {
    // SRV 超时单独给一个更短的值：它只是"找端口"的辅助查询，不值得占用整次查询的超时预算
    const srv = await resolveSrv(host, Math.min(1500, Number(timeout) || 1500));
    // 用户显式指定了非默认端口时，以用户为准（他有可能是故意的）
    if (srv && (!Number(port) || Number(port) === defaultPort)) target = srv;
  }

  const res = isBedrock
    ? await pingBedrock(target.host, target.port, timeout)
    : await pingJava(target.host, target.port, timeout);

  const out = { ...res, queriedHost: target.host, queriedPort: target.port, edition: isBedrock ? 'bedrock' : 'java' };

  // Query 是**补充**信息：拿不到就空着，绝不能因为它失败就让整个查询挂掉
  if (!isBedrock && useQuery) {
    const q = await queryServer(target.host, target.port, Math.min(3000, Number(timeout) || 3000));
    if (q) out.query = q;
  }
  return out;
}

/* ── Query 协议（UDP） ────────────────────────────────────── */
/**
 * Minecraft Query 协议（UT3 简化版，UDP），端口跟服务器端口一致（默认 25565）。
 *
 * 它给的是 Server List Ping **拿不到**的东西：
 *   - **完整**玩家名单。Server List Ping 的 sample 只是服务器给的样本（常不满 12 人，
 *     很多服干脆不给），所以「XX 在不在」用 sample 回答会**误判**
 *   - 插件列表 / 服务端软件名、地图名、游戏模式
 *
 * ⚠️ 前提：服务器要开 `enable-query=true`（server.properties），MC **默认不开**，
 *    而且不少租服面板也不给开。所以它做成开关（useQuery），拿不到就静默降级。
 *
 * 两轮交互：
 *   握手  FE FD 09 <sid>          → 09 <sid> <challenge 字符串\0>
 *   统计  FE FD 00 <sid> <challenge:int32> <4 字节 padding> → 00 <sid> <11 字节 padding> <KV 段> ...
 */
const QUERY_MAGIC = Buffer.from([0xfe, 0xfd]);
const Q_HANDSHAKE = 0x09;
const Q_STAT = 0x00;

/** 协议要求 session id 只保留低 28 位（高 4 位清零） */
export function querySessionId() {
  return (Math.floor(Math.random() * 0xffffffff) & 0x0f0f0f0f) >>> 0;
}

/** 组包；challenge 非空时补上 4 字节 padding（完整统计必须有） */
export function buildQueryPacket(type, sid, challenge) {
  const sidBuf = Buffer.alloc(4);
  sidBuf.writeUInt32BE(sid >>> 0, 0);
  const parts = [QUERY_MAGIC, Buffer.from([type]), sidBuf];
  if (challenge != null) {
    const c = Buffer.alloc(4);
    c.writeInt32BE(challenge, 0);
    parts.push(c, Buffer.alloc(4));
  }
  return Buffer.concat(parts);
}

/** 校验响应头（type + session id 对不上就是别人回的包，丢弃） */
export function queryMatchHeader(msg, type, sid) {
  if (!Buffer.isBuffer(msg) || msg.length < 5) return null;
  if (msg[0] !== type) return null;
  if (msg.readUInt32BE(1) !== (sid >>> 0)) return null;
  return msg.subarray(5);
}

/**
 * 解析完整统计响应体。
 * 结构：<11 字节 padding><key\0value\0 … 空 key 结束><10 字节 padding><"player_\0"><玩家名\0 …><\0>
 * ⚠️ 全是服务器给的任意字符串，调用方渲染前必须转义。
 */
export function parseFullStat(payload) {
  const kv = {};
  let i = 11; // 跳过固定 padding
  let guard = 0;
  while (i < payload.length && guard++ < 500) {
    const ke = payload.indexOf(0, i);
    if (ke < 0) break;
    const key = payload.toString('utf8', i, ke);
    if (!key) { i = ke + 1; break; }          // 空 key = KV 段结束
    const ve = payload.indexOf(0, ke + 1);
    if (ve < 0) break;
    kv[key] = payload.toString('utf8', ke + 1, ve);
    i = ve + 1;
  }
  const players = [];
  const marker = payload.indexOf(Buffer.from('player_'), i);
  if (marker >= 0) {
    let p = marker + 'player_'.length;
    if (payload[p] === 0) p++;               // 跳过前缀后的 NUL
    let g = 0;
    while (p < payload.length && g++ < 5000) {
      const e = payload.indexOf(0, p);
      if (e < 0) break;
      const name = payload.toString('utf8', p, e);
      if (!name) break;
      players.push(name);
      p = e + 1;
    }
  }
  return { kv, players };
}

/**
 * 做一次完整 Query。
 * @returns {Promise<null|{players:string[], plugins:string, pluginList:string[], map:string, gameType:string, version:string, hostPort:number|null}>}
 *   ⚠️ 任何一步失败都返回 null（不抛异常）—— 它只是补充信息，调用方不用 try/catch。
 */
export function queryServer(host, port = 25565, timeout = 3000) {
  return new Promise((resolve) => {
    const p = Number(port) || 25565;
    const ms = Math.max(500, Math.min(10000, Number(timeout) || 3000));
    let sock = null;
    let done = false;
    let timer = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try { sock?.close(); } catch { /* 关不掉就算了，进程退出会回收 */ }
      resolve(r);
    };
    try {
      sock = dgram.createSocket('udp4');
    } catch { return finish(null); }

    const sid = querySessionId();
    timer = setTimeout(() => finish(null), ms);
    sock.on('error', () => finish(null));

    sock.on('message', (msg) => {
      if (done) return;
      const body = queryMatchHeader(msg, Q_HANDSHAKE, sid);
      if (body) {
        // 握手回的是 challenge token，是个 NUL 结尾的数字字符串
        const token = parseInt(body.toString('utf8').replace(/\0+$/, ''), 10);
        if (!Number.isFinite(token)) return finish(null);
        const stat = buildQueryPacket(Q_STAT, sid, token);
        sock.send(stat, 0, stat.length, p, host, (e) => { if (e) finish(null); });
        return;
      }
      const statBody = queryMatchHeader(msg, Q_STAT, sid);
      if (statBody) {
        const { kv, players } = parseFullStat(statBody);
        const pluginList = String(kv.plugins || '')
          .split(/[,;]/).map((x) => x.trim()).filter(Boolean);
        return finish({
          players,
          plugins: String(kv.plugins || ''),
          pluginList,
          map: String(kv.map || ''),
          gameType: String(kv.gametype || ''),
          version: String(kv.version || ''),
          hostPort: Number(kv.hostport) || null
        });
      }
      // 类型/sid 对不上的包直接忽略，继续等
    });

    const hello = buildQueryPacket(Q_HANDSHAKE, sid, null);
    sock.send(hello, 0, hello.length, p, host, (e) => { if (e) finish(null); });
  });
}
