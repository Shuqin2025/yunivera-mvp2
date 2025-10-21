// modules/diagnostics/debugSnapshot.js
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const DEFAULT_DIR = process.env.SNAPSHOT_DIR || path.join(process.cwd(), 'logs');
const FILE_BASENAME = process.env.SNAPSHOT_FILE || 'snapshots.log.jsonl';
const ENABLE_HTTP = String(process.env.DEBUG_SNAPSHOT_API || '0') === '1';

function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function rid() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

/**
 * 轻量快照器
 * - 以 JSONL 写盘：每行 {ts, tag, level, reqId, data}
 * - 内存保留一个环形缓存，便于紧急查看
 */
export function createSnapshotter(options = {}) {
  const outDir = options.dir || DEFAULT_DIR;
  const file = path.join(outDir, FILE_BASENAME);
  const ringSize = options.ringSize ?? 500;   // 进程内最多缓存 500 条
  const ring = [];

  ensureDirSync(outDir);

  function pushRing(rec) {
    ring.push(rec);
    if (ring.length > ringSize) ring.shift();
  }

  function writeLine(obj) {
    try {
      fs.appendFile(file, JSON.stringify(obj) + os.EOL, () => {});
    } catch {}
  }

  function snap(tag, data = {}, meta = {}) {
    const rec = {
      ts: meta.ts || nowIso(),
      tag,
      level: meta.level || 'SNAP',
      reqId: meta.reqId || null,
      pid: process.pid,
      host: os.hostname(),
      data
    };
    pushRing(rec);
    writeLine(rec);
    return rec;
  }

  /** Express/koa 风格中间件：req.snap(tag, data) */
  function middleware() {
    return (req, _res, next) => {
      const reqId = req.headers['x-request-id'] || rid();
      // 挂到 req / res 方便随手打点
      req.reqId = reqId;
      req.snap = (tag, data = {}, ext = {}) => snap(tag, data, { ...ext, reqId });
      snap('http:req:start', { method: req.method, url: req.originalUrl || req.url }, { reqId });
      // 结束也打一条
      const end = () => {
        req.offEnd?.();
        snap('http:req:end', { method: req.method, url: req.originalUrl || req.url }, { reqId });
      };
      req.offEnd = () => { _res.off?.('finish', end); _res.off?.('close', end); };
      _res.on('finish', end);
      _res.on('close', end);
      next();
    };
  }

  /** （可选）暴露一个只读调试接口：GET /_debug/snapshots?last=200 */
  function router(app, basePath = '/_debug') {
    if (!ENABLE_HTTP || !app) return;
    app.get(`${basePath}/snapshots`, (req, res) => {
      const n = Math.min(+(req.query.last || 200), ring.length);
      res.json({ ok: true, count: n, items: ring.slice(-n) });
    });
  }

  return { snap, middleware, router, file, dir: outDir };
}

// 便捷默认实例（不想手动 new 的情况下）
export const snapshotter = createSnapshotter();
export const snap = snapshotter.snap;
export const snapshotMiddleware = snapshotter.middleware;
export const snapshotRouter = snapshotter.router;
