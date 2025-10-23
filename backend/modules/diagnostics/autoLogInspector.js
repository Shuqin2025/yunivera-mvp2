// backend/modules/diagnostics/autoLogInspector.js

/**
 * Auto Log Inspector（自动日志巡检中间件）
 * - 生成/透传请求 ID（默认头：X-Req-Id）
 * - 轻量请求耗时日志（受 DIAG_LIGHT_LOG 控制）
 * - 与 debugSnapshot 联动打点
 * - 可与 orchestrator（若存在）协同：触发阶段事件
 */

import { stageSnap } from './debugSnapshot.js';

const LIGHT = process.env.DIAG_LIGHT_LOG === '1';
const HEADER = (process.env.DIAG_REQ_ID_HEADER || 'X-Req-Id').toLowerCase();

// 懒加载 orchestrator（若没有也不报错）
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

/** 对外暴露：在任意阶段触发 orchestrator（若存在） */
export async function runStage(stage, ctx = {}) {
  try {
    const orch = await getOrchestrator();
    if (orch?.runStage) await orch.runStage(stage, ctx);
  } catch {}
}

/** Express/koa 风格中间件 */
export default function autoLogInspector(options = {}) {
  const headerName = (options.headerName || 'X-Req-Id').toLowerCase();

  return function autoLogInspectorMw(req, res, next) {
    // ctx 统一挂载
    const ctx = (req.__ctx = req.__ctx || {});
    ctx.reqId =
      req.headers[headerName] ||
      ctx.reqId ||
      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    ctx.startAt = Date.now();

    // 回写请求 ID
    try { res.setHeader(headerName, ctx.reqId); } catch {}

    // 开始打点
    stageSnap('http', 'http:inspect:start', {
      method: req.method,
      url: req.originalUrl || req.url,
    }, { reqId: ctx.reqId });

    // 结束时输出轻量日志 + 快照 + 触发 orchestrator 阶段
    res.on('finish', async () => {
      const dur = Date.now() - (ctx.startAt || Date.now());
      const url = req.originalUrl || req.url;
      if (LIGHT) {
        console.log(`[diag] ${req.method} ${url} -> ${res.statusCode} dur=${dur}ms reqId=${ctx.reqId}`);
      }
      stageSnap('http', 'http:inspect:end', {
        method: req.method,
        url,
        status: res.statusCode,
        dur,
      }, { reqId: ctx.reqId });

      // 触发 orchestrator 的阶段（供 afterHttp 聚合分析）
      await runStage('afterHttp', { req, res, ctx });
    });

    next();
  };
}

// 也提供具名导出（兼容 import { autoLogInspector }）
export { default as autoLogInspector } from './autoLogInspector.js';
