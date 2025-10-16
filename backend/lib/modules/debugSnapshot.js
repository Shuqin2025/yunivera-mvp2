// backend/lib/modules/debugSnapshot.js
import fs from 'fs';
import path from 'path';

const SNAPSHOT_DIR = path.join(process.cwd(), 'snapshots');
if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

/**
 * 轻量快照：写入一份 JSON（可覆盖/可增量）
 * @param {string} taskId          任务ID（同一次抓取保持一致）
 * @param {string} stage           阶段名：DETECT / PARSE / DETAIL / EXPORT / DONE
 * @param {object} payload         任意统计与异常信息
 * @param {boolean} append         是否以 JSONL 追加（默认 false：覆盖合并）
 */
export function writeSnapshot(taskId, stage, payload = {}, append = false) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(SNAPSHOT_DIR, `${taskId}.json`);

  if (append) {
    const line = JSON.stringify({ time: stamp, stage, ...payload }) + '\n';
    fs.appendFileSync(path.join(SNAPSHOT_DIR, `${taskId}.jsonl`), line, 'utf8');
  }

  let curr = {};
  if (fs.existsSync(base)) {
    try { curr = JSON.parse(fs.readFileSync(base, 'utf8')); } catch {}
  }
  const next = {
    ...(curr || {}),
    taskId,
    updatedAt: stamp,
    stages: {
      ...(curr.stages || {}),
      [stage]: { time: stamp, ...payload },
    },
  };
  fs.writeFileSync(base, JSON.stringify(next, null, 2), 'utf8');
}

/** 生成一个简单 taskId */
export function makeTaskId(prefix = 'task') {
  const t = new Date();
  const id = [
    t.getFullYear(),
    String(t.getMonth() + 1).padStart(2, '0'),
    String(t.getDate()).padStart(2, '0'),
    String(t.getHours()).padStart(2, '0'),
    String(t.getMinutes()).padStart(2, '0'),
    String(t.getSeconds()).padStart(2, '0'),
  ].join('');
  return `${prefix}_${id}`;
}
