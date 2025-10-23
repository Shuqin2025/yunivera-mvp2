// backend/scripts/selfCheck.js
// 目的：cron 自检 -> 基础可用性：HTTP 200/3xx + (有 <title> 或 页面长度>=MIN_BYTES)
// 报告写入 logs/selfcheck/dailyReport-YYYY-MM-DD.json
// 想把“不达标”判为失败：把结尾的 process.exit(0) 改成 1

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fetch from 'node-fetch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.resolve(__dirname, '..');
const SEED = path.join(ROOT, 'cli', 'seed-urls.txt');
const OUT_DIR = path.join(ROOT, 'logs', 'selfcheck');

const MIN_OK = Number(process.env.SELF_CHECK_MIN_OK || 1);
const MIN_BYTES = Number(process.env.SELF_CHECK_MIN_BYTES || 100);

async function readSeeds() {
  const raw = await fs.readFile(SEED, 'utf8');
  return raw
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(s => s && !s.startsWith('#'));
}

function hasTitle(html) {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return !!(m && m[1] && m[1].trim());
}

async function get(url) {
  // 直接 GET，HEAD 有些站会拒绝或不返回正文
  try {
    const r = await fetch(url, { method: 'GET', timeout: 20000 });
    return r;
  } catch (e) {
    return { ok: false, status: 0, _err: e };
  }
}

async function main() {
  const urls = await readSeeds();
  await fs.mkdir(OUT_DIR, { recursive: true });

  let ok = 0;
  const detail = [];

  for (const u of urls) {
    const t0 = Date.now();
    try {
      const r = await get(u);
      if (!r.ok) {
        detail.push({ url: u, ok: false, status: r.status || 0, ms: Date.now() - t0 });
        continue;
      }
      const text = await r.text();
      const bytes = text ? text.length : 0;
      const pass = (r.status < 400) && (hasTitle(text) || bytes >= MIN_BYTES);
      if (pass) ok += 1;
      detail.push({ url: u, ok: pass, status: r.status, bytes, ms: Date.now() - t0 });
    } catch (e) {
      detail.push({ url: u, ok: false, status: 0, err: String(e), ms: Date.now() - t0 });
    }
  }

  const ratio = urls.length ? ok / urls.length : 0;
  const ts = new Date().toISOString().slice(0, 10);

  const report = {
    ts,
    ok,
    total: urls.length,
    ratio,
    threshold_ok: MIN_OK,
    min_bytes: MIN_BYTES,
    detail,
  };

  const outFile = path.join(OUT_DIR, `dailyReport-${ts}.json`);
  await fs.writeFile(outFile, JSON.stringify(report, null, 2), 'utf8');

  console.log(`[selfcheck] ${ts} ok=${ok}/${urls.length} ratio=${ratio.toFixed(2)} saved=${path.relative(ROOT, outFile)}`);

  // 不让 cron 红：用 0。想告警改成 1。
  process.exit(0);
}

main().catch(e => {
  console.error('[selfcheck] fatal error', e);
  process.exit(1);
});
