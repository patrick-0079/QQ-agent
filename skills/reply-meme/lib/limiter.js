export function createLimiter({ concurrency = 2, maxQueue = 8, waitMs = 2000 } = {}) {
  let running = 0;
  const queue = [];
  const busy = () => Object.assign(new Error('图片下载繁忙，请稍后再试；本次没有请求图源'), { code: 'cache-capacity' });
  function slot() {
    running++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      running--;
      queue.shift()?.grant();
    };
  }
  return {
    async acquire(signal, prefetch = false) {
      if (signal?.aborted) throw new Error('图片准备已取消');
      if (running < concurrency) return slot();
      // 预取只用空闲资源，不排在主模型已选图片之前。
      if (prefetch || queue.length >= maxQueue) throw busy();
      return new Promise((resolve, reject) => {
        let timer;
        const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
        const remove = error => {
          const index = queue.indexOf(entry);
          if (index < 0) return;
          queue.splice(index, 1); clean(); reject(error);
        };
        const cancel = () => remove(new Error('图片准备已取消'));
        const entry = { grant() { clean(); resolve(slot()); } };
        queue.push(entry);
        signal?.addEventListener('abort', cancel, { once: true });
        timer = setTimeout(() => remove(busy()), waitMs);
      });
    }
  };
}
