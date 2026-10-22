const ALLOWED_HOSTS = new Set(['aigengtu.com', 'img.aigengtu.com']);

export function trustedUrl(value) {
  const u = new URL(value, 'https://aigengtu.com/');
  if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname) || u.username || u.password || (u.port && u.port !== '443')) {
    throw new Error('图源地址不在 aigengtu.com 白名单内');
  }
  return u.href;
}

// Host api.fetch remains the only network entry point, preserving web_fetch permissions.
// Check each redirect before fetching it, and limit streamed bytes as well as Content-Length.
export async function readBytes(httpFetch, value, { timeoutMs = 8000, maxBytes = 12 * 1024 * 1024, accept = '*/*', signal } = {}) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  if (signal?.aborted) throw signal.reason || new Error('请求已取消');
  signal?.addEventListener('abort', onAbort, { once: true });
  let rejectAbort;
  const abort = new Promise((_, reject) => { rejectAbort = () => reject(controller.signal.reason || new Error('请求已取消')); });
  controller.signal.addEventListener('abort', rejectAbort, { once: true });
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { reject(new Error('图源请求超时')); controller.abort(); }, timeoutMs);
  });
  const job = async () => {
    let url = trustedUrl(value);
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await httpFetch(url, {
        method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: { Accept: accept, 'User-Agent': 'reply-meme/1.0 (+https://aigengtu.com/)', Referer: 'https://aigengtu.com/' }
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers?.get?.('location');
        try { await response.body?.cancel?.(); } catch { /* already consumed */ }
        if (!location) throw new Error('图源跳转缺少地址');
        url = trustedUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok) {
        try { await response.body?.cancel?.(); } catch { /* no body */ }
        throw new Error(`图源 HTTP ${response.status}`);
      }
      // Also validate final URL for host wrappers that ignore redirect:manual.
      if (response.url) trustedUrl(response.url);
      const declared = Number(response.headers?.get?.('content-length') || 0);
      if (declared > maxBytes) {
        controller.abort();
        throw new Error('图源文件超过大小限制');
      }
      let buffer;
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        try {
          while (true) {
            const { done, value: chunk } = await reader.read();
            if (done) break;
            size += chunk.byteLength;
            if (size > maxBytes) { controller.abort(); throw new Error('图源文件超过大小限制'); }
            chunks.push(Buffer.from(chunk));
          }
          buffer = Buffer.concat(chunks, size);
        } finally {
          try { await reader.cancel(); } catch { /* already closed */ }
          reader.releaseLock();
        }
      } else {
        // Same fallback interface as the supplied package's api.fetch wrapper.
        buffer = Buffer.from(await response.arrayBuffer());
      }
      if (!buffer.length || buffer.length > maxBytes) throw new Error('图源文件为空或超过大小限制');
      return buffer;
    }
    throw new Error('图源跳转次数过多');
  };
  try { return await Promise.race([job(), timeout, abort]); }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    controller.signal.removeEventListener('abort', rejectAbort);
  }
}
