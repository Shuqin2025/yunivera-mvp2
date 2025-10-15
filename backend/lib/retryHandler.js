// 简单重试/退避包装器（用于网络请求或易抛错的步骤）
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export async function withRetry(fn, {
  tries = 3,
  delayMs = 800,
  jitterMs = 400,
  onRetry = () => {},
} = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const backoff = delayMs * Math.pow(2, i) + Math.floor(Math.random() * jitterMs);
      await onRetry({ attempt: i + 1, backoff, err });
      await sleep(backoff);
    }
  }
  throw lastErr;
}
