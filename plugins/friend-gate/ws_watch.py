# 好友申请「真 flag」监听器（friend-gate 的配套脚本）
#
# 为什么需要它：SnowLuma 不把 request 事件推给核心（核心收不到），但它**在自己的 WS 上会广播**
# （bundle 里有 convertFriendRequest，产出带 `flag: event.flag` 的标准 OneBot request 事件）。
# 日志里那个 "ID:" 只是它内部消息 ID，**不能当 flag**（实测 OIDB error 316）。
# 所以这里挂一个 WS 客户端：抓到 request 就把**真 flag** 写进待处理表 → 插件才能替你点同意/拒绝。
#
# 用法：python ws_watch.py          常驻（断线自动重连）
#       python ws_watch.py --once   只连一次、收 30 秒就退（排错用）
#
# 说明：Node 20 没有内置 WebSocket、项目里也没装 ws 包，所以这一支用 Python 的 websocket-client
# （装在自定义目录时，靠 PYTHONPATH 找得到即可）。

import json
import os
import sys
import time
import urllib.request

try:
    import websocket  # websocket-client
except Exception as e:  # pragma: no cover
    print('缺少 websocket-client：%s' % e)
    sys.exit(2)

HERE = os.path.dirname(os.path.abspath(__file__))
APP_ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))          # resources/app
DATA = os.path.abspath(os.path.join(APP_ROOT, '..', '..', 'data'))   # QQ Agent/data
SL_CFG_DIR = os.path.join(APP_ROOT, 'snowluma', 'config')
PENDING = os.path.join(DATA, 'pending-friend-requests.json')
LOG = os.path.join(DATA, 'ws-watch.log')

ONCE = '--once' in sys.argv


def log(msg):
    line = '[%s] %s\n' % (time.strftime('%Y-%m-%d %H:%M:%S'), msg)
    try:
        with open(LOG, 'a', encoding='utf8') as f:
            f.write(line)
    except Exception:
        pass
    if ONCE:
        sys.stdout.write(line)


def sl_conf():
    """从 SnowLuma 的 onebot 配置里拿 ws 端口+token、http 端口+token。"""
    try:
        fn = [x for x in os.listdir(SL_CFG_DIR) if x.startswith('onebot_') and x.endswith('.json')]
        if not fn:
            return None
        j = json.load(open(os.path.join(SL_CFG_DIR, fn[0]), encoding='utf8'))
        net = j.get('networks', {})
        ws = (net.get('wsServers') or [{}])[0]
        hs = (net.get('httpServers') or [{}])[0]
        return {
            'ws_port': ws.get('port', 3001),
            'ws_token': ws.get('accessToken', ''),
            'http_port': hs.get('port', 3000),
            'http_token': hs.get('accessToken', '') or ws.get('accessToken', ''),
        }
    except Exception as e:
        log('读配置失败：%s' % e)
        return None


def read_json(p, dft):
    try:
        return json.load(open(p, encoding='utf8'))
    except Exception:
        return dft


def write_json(p, v):
    try:
        with open(p, 'w', encoding='utf8') as f:
            json.dump(v, f, ensure_ascii=False, indent=1)
    except Exception as e:
        log('写 %s 失败：%s' % (p, e))


def owners():
    cfg = read_json(os.path.join(DATA, 'config.json'), {})
    found = []

    def walk(o, d):
        if not isinstance(o, dict) or d > 4:
            return
        for k, v in o.items():
            if k.lower() in ('ownerqq', 'owners', 'admins', 'ownerid') and isinstance(v, str) and any(ch.isdigit() for ch in v):
                found.append(v)
            elif isinstance(v, dict):
                walk(v, d + 1)

    walk(cfg, 0)
    out = []
    for x in found:
        for q in ''.join(ch if ch.isdigit() else ' ' for ch in x).split():
            if q not in out:
                out.append(q)
    return out


def send_private(conf, uid, text):
    url = 'http://127.0.0.1:%s/send_private_msg' % conf['http_port']
    body = json.dumps({'user_id': int(uid), 'message': text}).encode('utf8')
    req = urllib.request.Request(url, data=body, headers={
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': 'Bearer ' + conf['http_token'],
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read().decode('utf8'))
    except Exception as e:
        log('通知 %s 失败：%s' % (uid, e))
        return None


def in_whitelist(qq):
    cfg = read_json(os.path.join(DATA, 'config.json'), {})
    arr = ((cfg.get('allow') or {}).get('private') or [])
    arr = [str(x) for x in arr] if isinstance(arr, list) else []
    if not arr:
        return '（聊天白名单是空的 = 谁都能聊）'
    return '（已经在聊天白名单里）' if str(qq) in arr else '（**还不在聊天白名单里** —— 点了同意我会顺手把他加进去）'


def handle_event(conf, e):
    """收到 request 事件：写进待处理表（带**真 flag**）并私聊机主。"""
    kind = e.get('request_type')
    flag = str(e.get('flag') or '')
    raw_uid = e.get('user_id')
    uid = '' if raw_uid is None else str(raw_uid)
    if uid == '0':
        # 有些实现把好友申请事件的 user_id 填 0（外部审查指出）。这时**不能**把 QQ 留空：
        # 若 flag 本身看起来就是 QQ 号，就拿它当 QQ 用，免得待处理条目没法合并、也没法加白名单。
        uid = flag if str(flag).strip().isdigit() and len(str(flag).strip()) >= 5 else ''
    gid = str(e.get('group_id') or '')
    comment = str(e.get('comment') or '').replace('\n', ' ')[:200]
    if kind not in ('friend', 'group') or not flag:
        return False
    key = uid or gid
    log('收到 %s 申请：%s flag=%s' % (kind, key, flag))
    pend = read_json(PENDING, {'list': []})
    lst = pend.get('list') if isinstance(pend, dict) else []
    lst = lst if isinstance(lst, list) else []
    # 同一个 QQ 只留一条、并且**优先用 WS 的真 flag**（覆盖掉从日志抓来的假 flag）
    lst = [x for x in lst if str(x.get('userId') or '') != uid or kind != 'friend']
    lst.insert(0, {'type': kind, 'userId': uid, 'groupId': gid, 'comment': comment,
                   'flag': flag, 'at': int(time.time() * 1000), 'from': 'ws'})
    write_json(PENDING, {'list': lst[:50]})
    for o in owners():
        tip = ('有人要加你好友：QQ %s\n%s' % (uid, in_whitelist(uid))) if kind == 'friend' \
            else ('有人想拉我进群：群 %s\n（验证消息：%s）' % (gid, comment or '（无）'))
        send_private(conf, o, tip + '\n（回我「同意」我就点通过，回「拒绝」我就不通过 —— 这次我手里有凭证，能真点）')
    return True


def main():
    conf = sl_conf()
    if not conf:
        log('拿不到 SnowLuma 配置，退出')
        return
    url = 'ws://127.0.0.1:%s/?access_token=%s' % (conf['ws_port'], conf['ws_token'])
    log('连 ws://127.0.0.1:%s/（只记端口，token 不落日志）' % conf['ws_port'])
    while True:
        try:
            ws = websocket.create_connection(url, timeout=10, suppress_origin=True)
            log('已连上（开始监听 request 事件）')
            ws.settimeout(60)
            end = time.time() + 30 if ONCE else None
            while True:
                if end and time.time() > end:
                    ws.close()
                    log('--once 结束')
                    return
                try:
                    raw = ws.recv()
                except Exception:
                    continue
                try:
                    e = json.loads(raw)
                except Exception:
                    continue
                if isinstance(e, dict) and e.get('post_type') == 'request':
                    handle_event(conf, e)
        except Exception as e:
            log('连接断了（%s），5 秒后重连' % e)
            if ONCE:
                return
            time.sleep(5)


if __name__ == '__main__':
    main()
