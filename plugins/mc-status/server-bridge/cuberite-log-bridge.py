#!/usr/bin/env python3
"""
mc-log-bridge —— 把 Cuberite 控制台日志的**尾部**通过一个只读 HTTP 端点暴露出去。

为什么要有它：RCON 只能执行命令、拿命令响应，**拿不到服务器控制台输出**
（Source RCON 协议的硬限制）。而 Cuberite 的 give 之类命令成功时只写控制台日志、
不回传，导致机器人侧永远只能看到"空响应"。要看服务器到底发生了什么，只能读日志。

为什么不用 server-bridge/ConsoleBridge.java：那是 Bukkit 插件（Paper/Spigot），
Cuberite 是 C++ 服务端、装不了 Java 插件，所以这里用一个零依赖的 Python 小服务替代，
HTTP 契约与 ConsoleBridge 保持一致（GET /logs?lines=N + X-MC-Log-Token 请求头）。

设计取舍：
  · **只读**：不提供任何执行命令的能力（执行命令走服务器自己的 RCON）
  · **token 走请求头**，不放 URL —— URL 会被写进各种访问日志/代理日志
  · **只读文件尾部**：cuberite.log 会长到几 MB，全读进来既慢又占那台 1.7GB 内存的小机器
  · **零第三方依赖**：只用标准库，装完不用 pip
"""

import argparse
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

# 一次最多从文件末尾回读多少字节（够 200 行日志了，再大对排查也没意义）
READ_WINDOW = 512 * 1024


def tail_lines(path, max_lines):
    """读文件尾部若干行（不整读文件）。返回 list[str]。"""
    with open(path, 'rb') as f:
        f.seek(0, os.SEEK_END)
        size = f.tell()
        start = max(0, size - READ_WINDOW)
        f.seek(start)
        raw = f.read(size - start)
    text = raw.decode('utf-8', errors='replace')
    # 起点可能切在多字节字符中间，第一行不完整 —— 丢掉第一行（从头读的文件除外）
    if start > 0:
        nl = text.find('\n')
        text = text[nl + 1:] if nl >= 0 else ''
    lines = [l for l in text.split('\n')]
    while lines and lines[-1] == '':
        lines.pop()
    if max_lines > 0 and len(lines) > max_lines:
        lines = lines[-max_lines:]
    return lines


class Handler(BaseHTTPRequestHandler):
    # 别让默认的请求日志刷得太狠，自己打一行简短的
    server_version = 'mc-log-bridge/1.0'

    def _send(self, code, body, ctype='text/plain; charset=utf-8'):
        data = body.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except BrokenPipeError:
            pass

    def _log(self, code, note=''):
        print('[%s] %s %s %s -> %d %s' % (
            time.strftime('%H:%M:%S'), self.client_address[0],
            self.command, self.path, code, note), flush=True)

    def do_GET(self):
        u = urlparse(self.path)
        # /health：不带 token 也要能访问 —— 排查时先分清"端口不通"还是"token 错了"
        if u.path in ('/health', '/healthz'):
            self._log(200, 'health')
            self._send(200, 'ok\n')
            return

        if u.path != '/logs':
            self._log(404)
            self._send(404, 'not found\n')
            return

        token = self.server.token
        if token:
            got = self.headers.get('X-MC-Log-Token') or ''
            # ⚠️ 用恒定时间比较，别用 ==（会被时序攻击逐字节试出来）
            if not _safe_eq(got, token):
                self._log(401, 'bad token')
                self._send(401, 'unauthorized\n')
                return

        try:
            n = int(parse_qs(u.query).get('lines', ['200'])[0])
        except (ValueError, TypeError):
            n = 200
        n = max(1, min(2000, n))

        try:
            lines = tail_lines(self.server.log_path, n)
        except FileNotFoundError:
            self._log(500, 'log file missing')
            self._send(500, 'log file not found\n')
            return
        except OSError as e:
            self._log(500, str(e))
            self._send(500, 'cannot read log: %s\n' % e)
            return

        self._log(200, '%d lines' % len(lines))
        self._send(200, '\n'.join(lines) + ('\n' if lines else ''))

    def do_POST(self):
        self._log(405)
        self._send(405, 'read-only\n')


def _safe_eq(a, b):
    """恒定时间字符串比较（标准库里有 hmac.compare_digest，用它最稳）。"""
    import hmac
    return hmac.compare_digest(str(a), str(b))


def main():
    ap = argparse.ArgumentParser(description='只读的 MC 服务器日志 HTTP 端点')
    ap.add_argument('--port', type=int, default=25585)
    ap.add_argument('--log', default='/home/lubuntu/cuberite/cuberite.log')
    ap.add_argument('--token-file', default='/home/lubuntu/mc-log-bridge/token',
                    help='token 从文件读（避免出现在 ps / systemd unit 里）')
    args = ap.parse_args()

    token = ''
    try:
        with open(args.token_file, 'r', encoding='utf-8') as f:
            token = f.read().strip()
    except OSError:
        pass
    if not token:
        print('⚠️ 没读到 token（%s）—— 端点将**拒绝所有** /logs 请求。'
              '先生成：openssl rand -hex 24 > %s' % (args.token_file, args.token_file),
              file=sys.stderr, flush=True)

    httpd = ThreadingHTTPServer(('0.0.0.0', args.port), Handler)
    httpd.token = token
    httpd.log_path = args.log
    print('mc-log-bridge 已启动：0.0.0.0:%d，日志 %s，token %s'
          % (args.port, args.log, '已配置' if token else '未配置(全部拒绝)'), flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
