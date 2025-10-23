// backend/modules/diagnostics/orchestrator.js
// 编排器：统一的阶段事件 & 心跳 & 结构化诊断日志（JSONL）

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../../lib/logger.js';

const LOG_DIR = process.env.DIAG_LOG_DIR || path.join(process.cwd(), 'logs', 'diagnostics');
const HEARTBEAT_MS = Number(process.env.DIAG_HEARTBEAT_MS ?? 5 * 60 * 1000); // 5min
const JSONL_FILE = () => path.join(LOG_DIR, `diag-${new Date().toISOString().slice(0, 10)}.jsonl`);
const HB_FILE    = () => path.join(LOG_DIR, `heartbeat-${new Date().toISOString().slice(0, 10)}.log`);

const subs = new Set();           // 订阅者（register/onStage）
let hbTimer = null;               // 心跳定时器
let started = false;              // 是否启动过心跳
let batchId = null;               // 最近一次批次 ID
const metrics = {                 // 轻量运行指标
  batches: 0,
  urlsOk: 0,
  urlsFail: 0,
  last: {
    startAt: null,
    finishAt: null,
    ok: 0,
    fail: 0,
  }
};

// 确保目录存在
async function ensureDir(p) {
  try { await fsp.mkdir(p, { recursive: true }); } catch {}
}

// 追加一行 JSONL
async function appendJsonl(file, obj) {
  try {
    await ensureDir(path.dirname(file));
    await fsp.appendFile(file, JSON.stringify(obj) + '\n');
  } catch (e) {
    logger.warn(`[orchestrator] appendJsonl failed: ${e?.message || e}`);
  }
}

// 追加文本（心跳）
async function appendText(file, line) {
  try {
    await ensureDir(path.dirname(file));
    await fsp.appendFile(file, line + '\n', 'utf8');
  } catch (e) {
    logger.warn(`[orchestrator] appendText failed: ${e?.message || e}`);
  }
}

// --------- 心跳 ----------
function startHeartbeat() {
  if (started || HEARTBEAT_MS <= 0) return;
  hbTimer = setInterval(() => {
    const line = `[HEARTBEAT] ${new Date().toISOString()} batch=${batchId ?? '-'} ok=${metrics.last.ok} fail=${metrics.last.fail}`;
    logger.info(line);
    appendText(HB_FILE(), line).catch(() => {});
  }, HEARTBEAT_MS).unref?.();
  started = true;
  logger.info(`[orchestrator] heartbeat started: every ${HEARTBEAT_MS}ms`);
}
function stopHeartbeat() {
  if (hbTimer) {
    clearInterval(hbTimer);
    hbTimer = null;
  }
  started = false;
}

// --------- 对外：订阅/触发 ----------
/** 订阅阶段事件（回调签名： (stage, context) => void|Promise<void> ） */
export function onStage(fn) {
  if (typeof fn === 'function') subs.add(fn);
  return () => subs.delete(fn);
}
/** 兼容老名字 */
export const register = onStage;

/** 触发阶段事件，并做结构化落盘与指标聚合 */
export async function runStage(stage, context = {}) {
  // 轻量聚合
  try {
    if (stage === 'start') {
      metrics.batches += 1;
      metrics.last = { startAt: Date.now(), finishAt: null, ok: 0, fail: 0 };
      batchId = context?.taskId || context?.batchId || `batch_${Date.now()}`;
      startHeartbeat();
    }
    if (stage === 'afterParse') {
      if (context?.ok) {
        metrics.urlsOk += 1;
        metrics.last.ok += 1;
      } else if (context?.ok === false) {
        metrics.urlsFail += 1;
        metrics.last.fail += 1;
      }
    }
    if (stage === 'finished') {
      metrics.last.finishAt = Date.now();
      // 心跳不强制停止，让它在下一轮 start 前继续维持；若你希望结束就停，可开启下一行
      // stopHeartbeat();
    }
  } catch (e) {
    // 指标聚合失败不阻断
  }

  // 结构化落盘
  const payload = {
    ts: new Date().toISOString(),
    stage,
    batchId,
    context
  };
  appendJsonl(JSONL_FILE(), payload).catch(() => {});

  // 通知订阅者
  for (const fn of subs) {
    try { await fn(stage, context); }
    catch (e) {
      logger.warn(`[orchestrator] subscriber error @${stage}: ${e?.message || e}`);
    }
  }
}

// --------- 辅助：导出只读指标、手动 flush ----------
export function getMetrics() {
  return JSON.parse(JSON.stringify(metrics));
}
export async function flush() {
  // 目前 JSONL 在 append 时已落盘，这里预留接口以便未来扩展（比如队列积压批量写）
  return true;
}

// 进程退出清理
for (const sig of ['SIGINT', 'SIGTERM', 'beforeExit', 'exit']) {
  process.on(sig, async () => {
    try { await flush(); } catch {}
    stopHeartbeat();
  });
}

// 首次引入就按需启动心跳（直到第一次 runStage('start') 才会记录 batchId）
startHeartbeat();
