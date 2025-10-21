// backend/modules/errorCollector.js
import { logger } from "../lib/logger.js";         // 你已有的轻量 logger
import snapshot from "../lib/debugSnapshot.js";    // 你刚加的快照模块

function normalize(err = {}) {
  const e = (err && (err.cause || err)) || {};
  return {
    name: err.name || "Error",
    message: err.message || String(err),
    code: err.code || e.code || "",
    status: err.status || e.status || "",
    stack: (err.stack || "").split("\n").slice(0, 8).join("\n"),
  };
}

export function note(err, ctx = {}) {
  const n = normalize(err);
  logger.error("ERROR_CAPTURED", { ...n, ctx });
  // 关键错误做一次轻量快照
  snapshot("error", {
    err: n,
    ctx,
  });
}

export function express() {
  // 用作 app.use(errorCollector.express())
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    note(err, {
      url: req.originalUrl,
      method: req.method,
      query: req.query,
    });
    res.status(500).json({
      ok: false,
      error: "INTERNAL_ERROR",
      message: err?.message || "Internal Server Error",
    });
  };
}
