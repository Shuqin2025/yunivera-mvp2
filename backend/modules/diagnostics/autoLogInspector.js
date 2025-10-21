// modules/diagnostics/autoLogInspector.js
import fs from 'fs';
import path from 'path';

const LOG_DIR = process.env.LOG_DIR || path.join(process.cwd(), 'logs');
const SNAP_FILE = process.env.SNAPSHOT_FILE || 'snapshots.log.jsonl';
const REPORT_DIR = process.env.REPORT_DIR || path.join(process.cwd(), 'reports');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
}

function parseSnapshotLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function percent(n, d) {
  if (!d) return '0%';
  return (Math.round((n * 10000) / d) / 100) + '%';
}

export async function runInspector() {
  ensureDir(REPORT_DIR);

  const snapPath = path.join(LOG_DIR, SNAP_FILE);
  const lines = readLines(snapPath);
  const snaps = lines.map(parseSnapshotLine).filter(Boolean);

  // 计算：成功/失败、异常热度、阶段耗时（通过 start/end 配对）
  let okCount = 0, errCount = 0;
  const byTag = new Map();
  const byReq = new Map();
  const errorHeat = new Map();

  for (const s of snaps) {
    const tag = s.tag || 'unknown';
    byTag.set(tag, (byTag.get(tag) || 0) + 1);

    if (s.reqId) {
      const arr = byReq.get(s.reqId) || [];
      arr.push(s);
      byReq.set(s.reqId, arr);
    }

    if (/error/i.test(tag)) {
      errCount++;
      const key = s.data?.name || s.data?.message || tag;
      errorHeat.set(key, (errorHeat.get(key) || 0) + 1);
    }
    if (/success/i.test(tag)) okCount++;
  }

  // 粗略耗时：以 http:req:start / http:req:end 估算
  let durSumMs = 0, durN = 0;
  for (const [, arr] of byReq) {
    const start = arr.find(x => x.tag === 'http:req:start')?.ts;
    const end = arr.find(x => x.tag === 'http:req:end')?.ts;
    if (start && end) {
      const d = (new Date(end) - new Date(start));
      if (d >= 0 && d < 120000) { durSumMs += d; durN++; }
    }
  }

  // 排行（前 8 个错误模式）
  const topErrors = [...errorHeat.entries()]
    .sort((a,b)=>b[1]-a[1]).slice(0, 8)
    .map(([k,v]) => ({ pattern: k, count: v }));

  const summary = {
    date: new Date().toISOString(),
    files: { snapshots: snapPath },
    totals: {
      snapshots: snaps.length,
      byTag: Object.fromEntries(byTag),
    },
    quality: {
      ok: okCount,
      error: errCount,
      successRate: percent(okCount, okCount + errCount),
      avgReqMs: durN ? Math.round(durSumMs / durN) : null
    },
    topErrors
  };

  // 控制台报告（尽量简洁）
  const line = (s='') => console.log(s);
  line('┌──────────────────────────────────────────┐');
  line('│         Yunivera Log Diagnostics         │');
  line('├──────────────────────────────────────────┤');
  line(`│ Snapshots: ${String(summary.totals.snapshots).padEnd(8)} | Success: ${String(summary.quality.ok).padEnd(6)} Error: ${String(summary.quality.error).padEnd(6)} │`);
  line(`│ Success Rate: ${summary.quality.successRate.padEnd(7)}  Avg Req: ${summary.quality.avgReqMs ?? '-'} ms          │`);
  line('├──────────── Top Error Patterns ──────────┤');
  if (topErrors.length === 0) line('│ (no errors)                               │');
  topErrors.forEach(e => line(`│ ${String(e.count).padStart(4)} ×  ${e.pattern.slice(0, 36).padEnd(36)} │`));
  line('└──────────────────────────────────────────┘');

  // 导出 JSON/TXT
  const jsonOut = path.join(REPORT_DIR, `autoLogInspector_${Date.now()}.json`);
  fs.writeFileSync(jsonOut, JSON.stringify(summary, null, 2));
  const txtOut = jsonOut.replace(/\.json$/, '.txt');
  const linesOut = [
    `Date: ${summary.date}`,
    `Snapshots: ${summary.totals.snapshots}`,
    `Success: ${summary.quality.ok}  Error: ${summary.quality.error}  SuccessRate: ${summary.quality.successRate}`,
    `AvgReqMs: ${summary.quality.avgReqMs}`,
    `TopErrors:`,
    ...topErrors.map(e => `  - ${e.count} × ${e.pattern}`)
  ];
  fs.writeFileSync(txtOut, linesOut.join('\n'));

  return { summary, jsonOut, txtOut };
}

// 直接执行：node modules/diagnostics/autoLogInspector.js
if (process.argv[1] === (new URL(import.meta.url)).pathname) {
  runInspector().catch(err => {
    console.error('[autoLogInspector] failed:', err);
    process.exitCode = 1;
  });
}
