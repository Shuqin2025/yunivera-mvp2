// backend/lib/debugSnapshot.js
// 轻量“阶段快照”占位实现 —— 不让它阻塞主流程
// 用法：await snapshot('parse.start', { url, hintType });

export default async function snapshot(tag = '', data = {}) {
  try {
    // 为了避免噪音，这里只在 DEBUG=1 时输出
    if (process.env.DEBUG) {
      // 尽量不抛错，不阻塞
      const safe = JSON.stringify(data, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
      console.log(`[snapshot] ${tag}`, safe);
    }
  } catch {
    /* 忽略任何快照内部错误 */
  }
}
