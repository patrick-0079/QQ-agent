// SnowLuma 的 ocr_image 封装。
//
// 约定（实测出来的，见 .tools/share-card/probe-ocr.mjs）：
//   POST <httpUrl>/ocr_image   { image }
//   image 必须是 **http(s) 图片地址** 或协议端已缓存的 file_id；
//   本地路径 / file:// / base64 **一律拒绝**，报
//     "ocr_image needs an http(s) image url or a cached image file_id; base64/local-file input is not supported"
//   成功时 retcode=0、文本在 data（字符串或 data.text）。
//
// ⚠️ 这个接口背后是腾讯侧的 OCR 服务，会整体不可用：此时 retcode=100、
//    wording 类似 "image ocr failed: code=200 msg=服务忙,请稍后重试"。这属于上游问题，
//    不是参数写错 —— 这里把它翻译成人话并允许重试几次。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR as CORE_DATA_DIR } from '../../../src/config.js';

// 数据目录必须问核心要，不要自己拼路径：安装目录下 `resources\app\data` 是错的，
// 真正的 data 在 `<安装目录>\data`（conversation-memory 的 lib/env.js 也是这么做的）。
const DATA_DIR = process.env.QQ_AGENT_DATA_DIR || CORE_DATA_DIR;

/** 读协议端的 HTTP 地址与令牌（与应用内部 onebot.call 用的是同一份）。 */
export function readEndpoint() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
    const s = raw.snowluma || {};
    return {
      url: String(s.httpUrl || 'http://127.0.0.1:3000').trim().replace(/\/+$/, ''),
      token: String(s.httpAccessToken || s.accessToken || '').trim()
    };
  } catch {
    return null;
  }
}

/** 把上游的 wording 翻译成给模型/用户看的一句话。 */
function explain(wording, retcode) {
  const w = String(wording || '');
  if (/服务忙|稍后重试|繁忙/i.test(w)) return '协议端的文字识别服务暂时不可用（腾讯侧返回「服务忙」），过一会儿再试';
  if (/needs an http\(s\) image url/i.test(w)) return '这个接口只认 http(s) 图片地址或已缓存的文件号，不支持本地文件';
  if (/unknown action|1404/.test(w) || retcode === 1404) return '协议端没有 ocr_image 这个接口';
  return w || `识别失败（retcode=${retcode}）`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 识别一张图里的文字。
 * @param {(url: string, init?: object) => Promise<Response>} fetchImpl
 * @param {string} image http(s) 图片地址或缓存 file_id
 * @returns {Promise<{ok: boolean, text: string, error: string, attempts: number}>}
 */
export async function ocrImage(fetchImpl, image, { timeoutMs = 25000, retries = 2 } = {}) {
  const ep = readEndpoint();
  if (!ep) return { ok: false, text: '', error: '读不到协议端配置（data/config.json 的 snowluma 段）', attempts: 0 };
  const img = String(image || '').trim();
  if (!img) return { ok: false, text: '', error: '没有给图片地址', attempts: 0 };
  if (!/^https?:\/\//i.test(img) && !/^[0-9a-f]{16,}$/i.test(img)) {
    return { ok: false, text: '', error: '只支持 http(s) 图片地址或协议端缓存的文件号', attempts: 0 };
  }
  const fetchFn = fetchImpl || globalThis.fetch;
  const headers = { 'content-type': 'application/json' };
  if (ep.token) headers.authorization = `Bearer ${ep.token}`;

  const total = Math.max(1, Math.min(5, Number(retries) || 1) + 1);
  let last = '';
  let lastCode = null;
  for (let i = 1; i <= total; i += 1) {
    try {
      const res = await fetchFn(`${ep.url}/ocr_image`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ image: img }),
        signal: AbortSignal.timeout(Math.max(5000, Math.min(60000, Number(timeoutMs) || 25000)))
      });
      const body = await res.json().catch(() => null);
      if (!body) { last = `HTTP ${res.status}，返回不是 JSON`; lastCode = res.status; }
      else if (body.retcode === 0 || body.status === 'ok') {
        const d = body.data ?? body;
        const text = typeof d === 'string' ? d : String(d?.text ?? d?.result ?? '').trim();
        return { ok: true, text, error: '', attempts: i };
      } else {
        lastCode = body.retcode;
        last = explain(body.wording, body.retcode);
        // 只有「上游忙」值得重试；参数类错误立刻返回
        if (!/服务忙|稍后重试|繁忙/.test(String(body.wording || ''))) {
          return { ok: false, text: '', error: last, attempts: i };
        }
      }
    } catch (error) {
      last = String(error?.message || error).slice(0, 120);
      lastCode = null;
    }
    if (i < total) await sleep(1500 * i);
  }
  return { ok: false, text: '', error: last || `识别失败（retcode=${lastCode}）`, attempts: total };
}

/** 从一条会话记录里挑出可识别的图片地址（http(s) 或 file_id）。 */
export function pickImageFrom(entry) {
  for (const md of entry?.media || []) {
    if (!md) continue;
    if (md.kind && md.kind !== 'image') continue;
    const url = String(md.url || '').trim();
    if (/^https?:\/\//i.test(url)) return url;
    const file = String(md.file || '').trim();
    if (/^[0-9a-f]{16,}$/i.test(file)) return file;
  }
  return '';
}
