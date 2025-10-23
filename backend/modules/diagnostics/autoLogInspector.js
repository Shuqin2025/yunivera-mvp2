// backend/modules/diagnostics/autoLogInspector.js

/**
 * Auto Log Inspector（轻量巡检）
 * - 生成/透传 reqId（默认 X-Req-Id）
 * - 记录 http 起止 & 耗时
 * - 对 5xx/慢请求 计数 & 快照
 * - 可选：注册全局进程异常监听（unhandledRejection/uncaughtException）
 * - 触发 orchestrator 阶段事件（afterHttp）
 */

import { stageSnap, snap, snapError, metrics } from './debugSnapshot.js';

const LIGHT = process.env.DIAG_LIGHT_LOG === '1';
const DEFAULT_HEADER = (process.env.DIAG_REQ_ID_HEADER || 'X-Req-Id').toLowerCase();
const SLOW_MS = Number(process.env.HTTP_SLOW_MS ?? 1500);
const ENABLE_GLOBAL = String(process.env.DIAG_GLOBAL_EVENTS || '1') === '1';

// 懒加载 orchestrator，避免硬依赖
let _orchLoaded = false;
let _orch = null;
async function getOrchestrator() {
  if (_orchLoaded) return _orch;
  _orchLoaded = true;
  try {
    const mod = await import('./orchestrator.js');
    _orch = mod?.default || mod;
  } catch {
    _orch = null;
  }
  return _orch;
}
export async function runStage(stage, ctx = {}) {
  try {
    const orch = await getOrchestrator();
    if (orch?.runStage) await orch.runStage(stage, ctx);
  } catch {}
}

/** 只注册一次的全局异常监听 */
let globalHooked = false;
function hookGlobalOnce() {
  if (globalHooked || !ENABLE_GLOBAL) return;
  globalHooked = true;

  process.on('unhandledRejection', (reason, p) => {
    snapError('process:unhandledRejection', reason, {}, { promise: '[Promise]' });
    metrics.inc('process', 'unhandledRejection', 1);
  });
  process.on('uncaughtException', (err) => {
    snapError('process:uncaughtException', err);
    metrics.inc('process', 'uncaughtException', 1);
  });
}

/** Express/koa 中间件 */
export default function autoLogInspector(options = {}) {
  const headerName = (options.headerName || DEFAULT_HEADER).toLowerCase();
  hookGlobalOnce();

  return function autoLogInspectorMw(req, res, next) {
    // ctx 基本信息
    const ctx = (req.__ctx = req.__ctx || {});
    ctx.reqId =
      req.headers[headerName] ||
      ctx.reqId ||
      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // 回传 reqId 方便链路追踪
    try { res.setHeader(headerName, ctx.reqId); } catch {}

    const start = process.hrtime.bigint();

    stageSnap('http', 'http:inspect:start', {
      method: req.method,
      url: req.originalUrl || req.url,
    }, { reqId: ctx.reqId });

    // 错误兜底：底层 socket/响应错误
    res.on?.('error', (e) => {
      snapError('http:res:error', e, { reqId: ctx.reqId }, {
        method: req.method,
        url: req.originalUrl || req.url,
      });
      metrics.inc('http', 'resError', 1);
    });

    res.on('finish', async () => {
      const end = process.hrtime.bigint();
      const durMs = Number(end - start) / 1e6;
      const url = req.originalUrl || req.url;

      if (LIGHT) {
        console.log(`[diag] ${req.method} ${url} -> ${res.statusCode} dur=${durMs.toFixed(1)}ms reqId=${ctx.reqId}`);
      }

      // 基本快照
      stageSnap('http', 'http:inspect:end', {
        method: req.method,
        url,
        status: res.statusCode,
        dur: Math.round(durMs),
      }, { reqId: ctx.reqId });

      // metrics 补刀
      metrics.inc('http', 'requests', 1);
      if (res.statusCode >= 500) {
        metrics.inc('http', '5xx', 1);
        snap('http:server-error', { method: req.method, url, status: res.statusCode }, { level: 'WARN', reqId: ctx.reqId, stage: 'http' });
      }
      if (durMs > SLOW_MS) {
        metrics.inc('http', 'slow', 1);
        snap('http:slow', { method: req.method, url, dur: Math.round(durMs), threshold: SLOW_MS }, { level: 'WARN', reqId: ctx.reqId, stage: 'http' });
      }

      // 通知 orchestrator
      await runStage('afterHttp', { req, res, ctx, durMs });
    });

    next();
  };
}

// 允许具名导入
export { default as autoLogInspector } from './autoLogInspector.js';
