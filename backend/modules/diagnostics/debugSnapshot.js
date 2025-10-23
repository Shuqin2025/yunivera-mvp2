// backend/modules/diagnostics/debugSnapshot.js
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const DEFAULT_DIR = process.env.SNAPSHOT_DIR || path.join(process.cwd(), 'logs', 'selfcheck');
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
 * - 按 JSONL 逐行落盘：{ ts, tag, level, reqId, stage, pid, host, data }
 * - 同时保留一个环形缓存（默认 500 条）便于在线查看
 */
export function createSnapshotter(options = {}) {
  const outDir = options.dir || DEFAULT_DIR;
  const file = path.join(outDir, FILE_BASENAME);
  const ringSize = options.ringSize ?? 500;
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

  /**
   * 核心打点
   * @param {string} tag   事件标签，如 'crawl:start'
   * @param {any}    data  任意结构化数据
   * @param {object} meta  { level, reqId, stage, ts }
   */
  function snap(tag, data = {}, meta = {}) {
    const rec = {
      ts: meta.ts || nowIso(),
      tag,
      level: meta.level || 'SNAP',
      reqId: meta.reqId || null,
      stage: meta.stage || null,
      pid: process.pid,
      host: os.hostname(),
      data,
    };
    pushRing(rec);
    writeLine(rec);
    return rec;
  }

  /** 语义封装：按阶段打点 */
  function stageSnap(stage, tag, data = {}, meta = {}) {
    return snap(tag, data, { ...meta, stage });
  }

  /** Express/koa 风格中间件：req.snap(tag, data) */
  function middleware() {
    return (req, res, next) => {
      const reqId = req.headers['x-request-id'] || rid();
      req.reqId = reqId;
      req.snap = (tag, data = {}, ext = {}) => snap(tag, data, { ...ext, reqId, stage: 'http' });
      stageSnap('http', 'http:req:start', { method: req.method, url: req.originalUrl || req.url }, { reqId });

      const end = () => {
        res.off?.('finish', end);
        res.off?.('close', end);
        stageSnap('http', 'http:req:end', { method: req.method, url: req.originalUrl || req.url, status: res.statusCode }, { reqId });
      };
      res.on('finish', end);
      res.on('close', end);
      next();
    };
  }

  /** （可选）暴露调试接口：GET /_debug/snapshots?last=200 */
  function router(app, basePath = '/_debug') {
    if (!ENABLE_HTTP || !app) return;
    app.get(`${basePath}/snapshots`, (req, res) => {
      const n = Math.min(+(req.query.last || 200), ring.length);
      res.json({ ok: true, count: n, items: ring.slice(-n) });
    });
  }

  return { snap, stageSnap, middleware, router, file, dir: outDir, ring };
}

// 默认实例
export const snapshotter = createSnapshotter();
export const snap = snapshotter.snap;
export const stageSnap = snapshotter.stageSnap;
export const snapshotMiddleware = snapshotter.middleware;
export const snapshotRouter = snapshotter.router;
