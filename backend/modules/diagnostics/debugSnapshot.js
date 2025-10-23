// backend/modules/diagnostics/debugSnapshot.js
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const DEFAULT_DIR = process.env.SNAPSHOT_DIR || path.join(process.cwd(), 'logs', 'selfcheck');
const FILE_BASENAME = process.env.SNAPSHOT_FILE || 'snapshots.log.jsonl';
const ENABLE_HTTP = String(process.env.DEBUG_SNAPSHOT_API || '0') === '1';

const METRICS_DIR = process.env.METRICS_DIR || path.join(process.cwd(), 'logs', 'metrics');
const METRICS_FILE = process.env.METRICS_FILE || 'metrics.json';
const METRICS_FLUSH_SECS = Number(process.env.METRICS_FLUSH_SECS ?? 30);

/** --------- utils ---------- */
function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function nowIso() { return new Date().toISOString(); }
function rid() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

/** 安全 JSON 序列化（避免 circular / 大对象） */
function safeStringify(obj) {
  const seen = new WeakSet();
  const MAX_LEN = 10_000; // 防止超大字符串
  try {
    return JSON.stringify(obj, function (key, value) {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      if (value instanceof Buffer) return `[Buffer ${value.length}]`;
      if (typeof value === 'string' && value.length > MAX_LEN) {
        return value.slice(0, MAX_LEN) + `…(+${value.length - MAX_LEN})`;
      }
      // 只挑安全字段（req/res/socket等）
      if (key === 'req' || key === 'res' || key === 'socket') return `[${key}]`;
      return value;
    });
  } catch {
    return JSON.stringify({ error: 'safeStringify-failed' });
  }
}

/** --------- Snapshotter ---------- */
/**
 * - 按 JSONL 逐行落盘：{ ts, tag, level, reqId, stage, pid, host, data }
 * - 同时保留一个环形缓存（默认 500 条）
 * - 追加 metrics 聚合器（内存 -> 定时/手动 flush）
 */
export function createSnapshotter(options = {}) {
  const outDir = options.dir || DEFAULT_DIR;
  const file = path.join(outDir, FILE_BASENAME);
  const ringSize = options.ringSize ?? 500;
  const ring = [];

  ensureDirSync(outDir);

  /* ---- metrics aggregator ---- */
  const metricsDir = METRICS_DIR;
  const metricsFile = path.join(metricsDir, METRICS_FILE);
  ensureDirSync(metricsDir);

  // 简易指标容器：{ '<ns>.<key>': { type:'counter'|'gauge', value:number } }
  const _metrics = Object.create(null);

  function mkey(ns, key) { return `${ns}.${key}`; }
  function inc(ns, key, val = 1) {
    const k = mkey(ns, key);
    const cur = _metrics[k] || { type: 'counter', value: 0 };
    cur.value += val;
    _metrics[k] = cur;
  }
  function gauge(ns, key, val) {
    const k = mkey(ns, key);
    _metrics[k] = { type: 'gauge', value: Number(val) };
  }
  function readMetricsDisk() {
    try {
      const raw = fs.readFileSync(metricsFile, 'utf8');
      return JSON.parse(raw);
    } catch { return {}; }
  }
  function writeMetricsDisk(obj) {
    try {
      ensureDirSync(metricsDir);
      fs.writeFileSync(metricsFile, safeStringify(obj) + os.EOL, 'utf8');
    } catch {}
  }
  function flushMetrics() {
    const disk = readMetricsDisk();
    const day = new Date().toISOString().slice(0,10); // YYYY-MM-DD
    disk[day] = disk[day] || {};
    for (const [k, v] of Object.entries(_metrics)) {
      const cur = disk[day][k] || { type: v.type, value: 0 };
      if (v.type === 'counter') {
        cur.value = (cur.value || 0) + v.value;
      } else {
        // 覆盖最近值
        cur.value = v.value;
      }
      cur.type = v.type;
      disk[day][k] = cur;
    }
    writeMetricsDisk(disk);
  }

  let timer = null;
  if (METRICS_FLUSH_SECS > 0) {
    timer = setInterval(() => {
      try { flushMetrics(); } catch {}
    }, METRICS_FLUSH_SECS * 1000).unref?.();
  }

  /* ---- snapshot core ---- */
  function pushRing(rec) {
    ring.push(rec);
    if (ring.length > ringSize) ring.shift();
  }
  function writeLine(obj) {
    try { fs.appendFile(file, safeStringify(obj) + os.EOL, () => {}); } catch {}
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

  /** 错误快照（自动提取 message/stack/cause） */
  function snapError(tag, err, meta = {}, extra = {}) {
    const e = err || {};
    const payload = {
      message: e.message,
      stack: e.stack,
      name: e.name,
      code: e.code,
      cause: e.cause && (e.cause.message || String(e.cause)),
      ...extra,
    };
    // 计数器补刀
    metrics.inc('error', tag, 1);
    return snap(tag, payload, { ...meta, level: 'ERROR' });
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
      res.on?.('error', (e) => snapError('http:req:error', e, { reqId }, { method: req.method, url: req.originalUrl || req.url }));
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
    app.get(`${basePath}/metrics`, (req, res) => {
      try {
        const disk = fs.existsSync(metricsFile) ? JSON.parse(fs.readFileSync(metricsFile, 'utf8')) : {};
        res.json({ ok: true, file: metricsFile, data: disk });
      } catch (e) {
        res.status(500).json({ ok: false, error: String(e) });
      }
    });
  }

  const metrics = { inc, gauge, flush: flushMetrics };

  return { snap, snapError, stageSnap, middleware, router, file, dir: outDir, ring, metrics };
}

/** 默认实例（对外复用） */
export const snapshotter = createSnapshotter();
export const snap = snapshotter.snap;
export const snapError = snapshotter.snapError;
export const stageSnap = snapshotter.stageSnap;
export const snapshotMiddleware = snapshotter.middleware;
export const snapshotRouter = snapshotter.router;
export const metrics = snapshotter.metrics;
