// backend/scripts/debugSnapshot.js
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 复用已有的模块逻辑（你仓库里已存在）
import {
  ensureDirs,
  exportSnapshot,
  readSnapshot,
} from '../modules/diagnostics/debugSnapshot.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const SNAPSHOT_DIR = process.env.SNAPSHOT_DIR || 'logs/snapshots';
  const SNAPSHOT_FILE = process.env.SNAPSHOT_FILE || 'daily.json';
  const outName = process.argv[2] || `export-${Date.now()}.json`;

  const src = path.resolve(process.cwd(), SNAPSHOT_DIR, SNAPSHOT_FILE);
  const out = path.resolve(process.cwd(), SNAPSHOT_DIR, outName);

  await ensureDirs(path.dirname(out));
  const data = await readSnapshot(src);
  await exportSnapshot(data, out);

  console.log(`[debugSnapshot] read: ${src}`);
  console.log(`[debugSnapshot] write: ${out}`);
  console.log(`[debugSnapshot] entries: ${Array.isArray(data) ? data.length : 0}`);
}

main().catch((err) => {
  console.error('[debugSnapshot] failed:', err);
  process.exitCode = 1;
});
