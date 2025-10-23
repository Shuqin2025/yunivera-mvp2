// backend/modules/diagnostics/orchestrator.js
// 统一诊断编排：阶段事件 -> 监听器；心跳；指标聚合；落盘

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../lib/logger.js';

const ENV = {
  HEARTBEAT_SEC: Number(process.env.DIAG_HEARTBEAT_SEC || 300), // 5min
  ENABLE_FILE:   (process.env.DIAG_ENABLE_FILE || '1') === '1',
  SAVE_DIR:      process.env.DIAG_SAVE_DIR || './logs/diagnostics',
  // 0~1 之间的小数，控制落盘采样率（避免日志风暴）；默认 1（全部落盘）
  SAMPLING:      Math.min(1, Math.max(0, Number(process.env.DIAG_SAMPLING || 1))),
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
function saveJSON(rel, data) {
  if (!ENV.ENABLE_FILE) return;
  if (!maybeSample()) return;
  const dir = path.join(ENV.SAVE_DIR, rel);
  ensureDir(dir);
  const file = path.join(dir, `${new Date().toISOString().slice(0,10)}.jsonl`);
  try {
    fs.appendFileSync(file, JSON.stringify(data) + '\n');
  } catch (e) {
    logger.warn(`[orchestrator] write ${file} failed: ${e?.message || e}`);
  }
}

// ------------------------ 对外：注册/触发 ------------------------
export function onStage(stage, fn) {
  if (!listeners.has(stage)) listeners.set(stage, new Set());
  listeners.get(stage).add(fn);
  return () => listeners.get(stage)?.delete(fn);
}

/**
 * 触发阶段
 * @param {string} stage  e.g. 'start' | 'afterParse' | 'afterCrawl' | 'finished'
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
  d.last = now - last; // 近似值；对于第一次会比较大，但对趋势无伤
  d.total += d.last;

  const event = {
    stage,
    ts: new Date().toISOString(),
    taskId: taskCtx.taskId,
    batchId: taskCtx.batchId,
    ...payload,
  };

  logger.info(`[stage] ${stage} ${payload?.url ? `url=${payload.url}` : ''} ${payload?.ok===false ? '❌' : '✅'}`.trim());
  saveJSON('stages', event);

  // 逐个监听器执行（串行以便日志有序；若需并行可 Promise.all）
  const fns = [...(listeners.get(stage) || [])];
  for (const fn of fns) {
    try { await fn(event); }
    catch (e) {
      logger.warn(`[orchestrator] listener error @${stage}: ${e?.message || e}`);
      // 也落盘一份错误
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

