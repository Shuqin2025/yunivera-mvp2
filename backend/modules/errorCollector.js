// backend/modules/errorCollector.js

// 一个很轻量的错误收集器：缓存最近 N 条错误到内存，方便路由兜底统一上报。
// 不依赖外部 logger；生产可通过环境变量调优。

const _buffer = [];
const MAX = Number(process.env.ERROR_BUFFER_MAX || 200); // 环境变量可调，默认 200

function _push(rec) {
  try {
    _buffer.push(rec);
    if (_buffer.length > MAX) _buffer.shift();
  } catch {}
}

function _toPlainError(err) {
  if (!err) return { name: "Error", message: "Unknown error" };
  return {
    name: err.name || "Error",
    message: String(err.message ?? err),
    code: err.code ?? undefined,
    // 如需返回栈，设置 EXPOSE_ERROR_STACK=1
    stack:
      process.env.EXPOSE_ERROR_STACK === "1"
        ? err.stack || undefined
        : undefined,
  };
}

/**
 * 采集一条错误
 * @param {any} err
 * @param {import('express').Request} [req]
 * @param {object} [extra]
 * @returns {object} 归一化记录
 */
async function capture(err, req, extra = {}) {
  const now = Date.now();
  const rec = {
    ts: now,
    error: _toPlainError(err),
    req: req
      ? {
          method: req.method,
          url: req.originalUrl || req.url,
          ip:
            (req.headers["x-forwarded-for"] || "")
              .toString()
              .split(",")[0] || req.ip || "",
          ua: (req.headers["user-agent"] || "").toString().slice(0, 200),
          reqId: req.__ctx?.reqId,
        }
      : undefined,
    extra,
  };

  _push(rec);

  // 控制台输出（可通过 DIAG_ERROR_STDERR=0 关闭）
  if (process.env.DIAG_ERROR_STDERR !== "0") {
    const r = rec.req || {};
    console.error(
      "[error]",
      rec.error.name,
      "-",
      rec.error.message,
      `${r.method || ""} ${r.url || ""}`.trim(),
      `reqId=${r.reqId || "-"}`
    );
  }

  return rec;
}

/** 获取最近若干条错误（只读快照） */
function recent(limit = 50) {
  const n = Math.max(0, _buffer.length - limit);
  return _buffer.slice(n);
}

// === 导出区：同时提供命名导出与默认导出 ===
export { capture, recent };
export default { capture, recent };
