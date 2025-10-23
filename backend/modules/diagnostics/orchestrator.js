// backend/modules/diagnostics/orchestrator.js
// 统一诊断编排：阶段事件 -> 监听器；心跳；指标聚合；安全落盘（防循环/重对象）

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../lib/logger.js';

const ENV = {
  HEARTBEAT_SEC: Number(process.env.DIAG_HEARTBEAT_SEC || 300), // 5min
  ENABLE_FILE:   (process.env.DIAG_ENABLE_FILE || '1') === '1',
  SAVE_DIR:      process.env.DIAG_SAVE_DIR || './logs/diagnostics',
  SAMPLING:      Math.min(1, Math.max(0, Number(process.env.DIAG_SAMPLING || 1))),
  MAX_DEPTH:     Math.min(8, Math.max(1, Number(process.env.DIAG_MAX_DEPTH || 4))),
  MAX_ARRAY:     Math.min(200, Math.max(5, Number(process.env.DIAG_MAX_ARRAY || 50))),
  REDACT_KEYS:   String(process.env.DIAG_REDACT || 'password,authorization,auth,token,cookie,set-cookie')
                   .split(',')
                   .map(s => s.trim().toLowerCase())
                   .filter(Boolean),
};

// ----------------------------- 事件总线 -----------------------------
/** Map<stage, Set<listener(payload)>> */
const listeners = new Map();
/** 近重复事件防抖：Map<key, lastTs> */
const recent = new Map();
/** 指标：按阶段统计条数、近一次耗时、累计耗时 */
const metrics = {
  counts: new Map(), // stage -> n
  durations: new Map(), // stage -> { last: number, total: number }
};
/** 任务上下文（在 runStage('start', {taskId}) 时刷新） */
let taskCtx = {
  taskId: null,
  batchId: null,
  startedAt: null,
};
let heartbeatTimer = null;

// ------------------------ 工具：目录/落盘 ------------------------
function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}
function maybeSample() {
  if (ENV.SAMPLING >= 1) return true;
  return Math.random() < ENV.SAMPLING;
}

function safeStringify(data) {
  // 跳过循环 & 重对象 & 受限深度/数组长度，并支持敏感字段脱敏
  const seen = new WeakSet();
  const redact = new Set(ENV.REDACT_KEYS);

  function helper(value, depth) {
    if (value == null) return value;
    const t = typeof value;

    if (t === 'function' || t === 'symbol' || t === 'bigint') return String(value);
    if (t === 'string' || t === 'number' || t === 'boolean') return value;

    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
    }

    if (Buffer.isBuffer(value)) return `<Buffer len=${value.length}>`;

    // Node streams / sockets / requests / responses：用占位
    const ctor = value?.constructor?.name;
    if (ctor === 'Socket' || ctor === 'TLSSocket') return `<${ctor}>`;
    if (ctor === 'IncomingMessage' || ctor === 'ServerResponse') return `<${ctor}>`;
    if (ctor && /Stream$/i.test(ctor)) return `<${ctor}>`;

    if (depth >= ENV.MAX_DEPTH) {
      if (Array.isArray(value)) return `<Array len=${value.length}>`;
      return `<Object ${ctor || 'Object'}>`;
    }

    if (typeof value === 'object') {
      if (seen.has(value)) return '<CircularRef>';
      seen.add(value);

      if (Array.isArray(value)) {
        const out = [];
        const len = Math.min(value.length, ENV.MAX_ARRAY);
        for (let i = 0; i < len; i++) {
          out.push(helper(value[i], depth + 1));
        }
        if (value.length > len) out.push(`<...+${value.length - len}>`);
        return out;
      }

      const out = {};
      for (const [k, v] of Object.entries(value)) {
        const key = String(k);
        // 脱敏
        if (redact.has(key.toLowerCase())) {
          out[key] = '[REDACTED]';
          continue;
        }
        // 常见大对象键直接省略
        if (key === 'socket' || key === 'req' || key === 'res') {
          out[key] = `<${key}>`;
          continue;
        }
        out[key] = helper(v, depth + 1);
      }
      return out;
    }

    try { return JSON.parse(JSON.stringify(value)); }
    catch { return String(value); }
  }

  try {
    return JSON.stringify(helper(data, 0));
  } catch (e) {
    // 最后兜底
    try { return JSON.stringify({ _nonSerializable: String(e) }); }
    catch { return '{"_nonSerializable":"fail"}'; }
  }
}

function saveJSON(rel, data) {
  if (!ENV.ENABLE_FILE) return;
  if (!maybeSample()) return;
  const dir = path.join(ENV.SAVE_DIR, rel);
  ensureDir(dir);
  const file = path.join(dir, `${new Date().toISOString().slice(0,10)}.jsonl`);
  try {
    fs.appendFileSync(file, safeStringify(data) + '\n', 'utf8');
  } catch (e) {
    logger.warn(`[orchestrator] write ${file} failed: ${e?.message || e}`);
  }
}

// 对 payload 做精简摘要，避免把整棵大树写盘
function summarizePayload(payload = {}) {
  const out = {};
  // 常见可读字段
  for (const k of ['url','ok','taskId','batchId','site','type','platform','hintType']) {
    if (payload[k] !== undefined) out[k] = payload[k];
  }
  // stats/metrics 只保留扁平摘要
  if (payload.stats && typeof payload.stats === 'object') {
    const { total, success, failed, durationMs, ...rest } = payload.stats;
    out.stats = { total, success, failed, durationMs, ...rest };
  }
  // 错误对象结构化
  if (payload.error instanceof Error) {
    out.error = { name: payload.error.name, message: payload.error.message, stack: payload.error.stack };
  } else if (payload.error) {
    out.error = payload.error;
  }
  // 允许自定义补充小片段
  if (payload.note) out.note = payload.note;

  return out;
}

// ------------------------ 对外：注册/触发 ------------------------
export function onStage(stage, fn) {
  if (!listeners.has(stage)) listeners.set(stage, new Set());
  listeners.get(stage).add(fn);
  return () => listeners.get(stage)?.delete(fn);
}

/**
 * 触发阶段
 * @param {string} stage  e.g. 'start' | 'afterParse' | 'afterCrawl' | 'finished' | 'afterHttp'
 * @param {object} payload 任意上下文
 * @param {object} [opts]  { debounceMs?: number, key?: string }
 */
export async function runStage(stage, payload = {}, opts = {}) {
  const now = Date.now();
  const debounceMs = Number(opts.debounceMs ?? 1500);
  const key = opts.key || `${stage}:${payload?.url || ''}:${payload?.taskId || taskCtx.taskId || ''}`;

  // 任务语义：记录 taskId/batchId/开始时间
  if (stage === 'start') {
    taskCtx = {
      taskId:  payload?.taskId || taskCtx.taskId || `task_${now}`,
      batchId: payload?.batchId || `batch_${now}`,
      startedAt: new Date().toISOString(),
    };
    startHeartbeat();
  }

  // 去重/防抖
  const last = recent.get(key) || 0;
  if (now - last < debounceMs) return;
  recent.set(key, now);

  // 指标：次数+耗时
  metrics.counts.set(stage, (metrics.counts.get(stage) || 0) + 1);
  if (!metrics.durations.has(stage)) metrics.durations.set(stage, { last: 0, total: 0 });
  const d = metrics.durations.get(stage);
  d.last = last ? (now - last) : 0; // 第一次为 0
  d.total += d.last;

  const event = {
    stage,
    ts: new Date().toISOString(),
    taskId: taskCtx.taskId,
    batchId: taskCtx.batchId,
    ...summarizePayload(payload),
  };

  logger.info(
    `[stage] ${stage} ${event.url ? `url=${event.url} ` : ''}${event.ok === false ? '❌' : '✅'}`
      .trim()
  );

  saveJSON('stages', event);

  // 逐个监听器执行（串行以便日志有序；若需并行可 Promise.all）
  const fns = [...(listeners.get(stage) || [])];
  for (const fn of fns) {
    try { await fn(event); }
    catch (e) {
      logger.warn(`[orchestrator] listener error @${stage}: ${e?.message || e}`);
      saveJSON('errors', { stage, ts: event.ts, msg: e?.message || String(e) });
    }
  }

  if (stage === 'finished') {
    stopHeartbeat();
    flushMetrics();
  }
}

// 给调试模块的“快速注册”使用
export function register(cb) {
  try { cb?.({ onStage, runStage }); }
  catch (e) { logger.warn(`[orchestrator] register failed: ${e?.message || e}`); }
}

// ------------------------ 心跳 & 指标落盘 ------------------------
function startHeartbeat() {
  if (heartbeatTimer || ENV.HEARTBEAT_SEC <= 0) return;
  heartbeatTimer = setInterval(() => {
    const beat = {
      ts: new Date().toISOString(),
      taskId: taskCtx.taskId,
      batchId: taskCtx.batchId,
      memMB: Math.round((process.memoryUsage?.rss?.() || process.memoryUsage().rss) / 1024 / 1024),
      uptimeSec: Math.round(process.uptime()),
    };
    logger.info(`[HEARTBEAT] ${beat.ts} task=${beat.taskId} rss=${beat.memMB}MB up=${beat.uptimeSec}s`);
    saveJSON('heartbeat', beat);
  }, ENV.HEARTBEAT_SEC * 1000);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function flushMetrics() {
  const out = {
    ts: new Date().toISOString(),
    taskId: taskCtx.taskId,
    batchId: taskCtx.batchId,
    startedAt: taskCtx.startedAt,
    counts: Object.fromEntries(metrics.counts),
    durations: Object.fromEntries(
      [...metrics.durations.entries()].map(([k, v]) => [k, { last: v.last, total: v.total }])
    ),
  };
  logger.info(`[metrics] ${JSON.stringify(out.counts)}`);
  saveJSON('metrics', out);

  // 清理，避免内存持续增长
  metrics.counts.clear();
  metrics.durations.clear();
  recent.clear();
}
