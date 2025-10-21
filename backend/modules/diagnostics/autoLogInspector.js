// backend/modules/diagnostics/autoLogInspector.js

/**
 * 轻量级请求巡检中间件：
 * - 给每个请求打 reqId、记录开始时间
 * - 请求结束时可选输出一条极简日志（仅在 DIAG_LIGHT_LOG=1 时）
 * - 不依赖外部 logger，不会影响现有路由
 */

function autoLogInspector(options = {}) {
  const { headerName = "X-Req-Id" } = options;

  return function autoLogInspectorMw(req, res, next) {
    // 上下文容器（避免覆盖你已有的 ctx 设计）
    const ctx = (req.__ctx = req.__ctx || {});

    // 生成/继承请求 ID
    ctx.reqId =
      req.headers[headerName.toLowerCase()] ||
      ctx.reqId ||
      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // 记录起始时间
    ctx.startAt = Date.now();

    // 透传到响应头，便于链路查看
    try {
      res.setHeader(headerName, ctx.reqId);
    } catch {}

    // 结束时的极简日志（仅在需要时）
    res.on("finish", () => {
      if (process.env.DIAG_LIGHT_LOG === "1") {
        const dur = Date.now() - (ctx.startAt || Date.now());
        const url = req.originalUrl || req.url;
        console.log(
          `[diag] ${req.method} ${url} -> ${res.statusCode} ` +
            `dur=${dur}ms reqId=${ctx.reqId}`
        );
      }
    });

    next();
  };
}

// --- 同时导出「命名导出」与「默认导出」---
// 这样无论你用 import autoLogInspector from ... 还是 import { autoLogInspector } from ...
// 都能正常工作。
export { autoLogInspector };
export default autoLogInspector;
