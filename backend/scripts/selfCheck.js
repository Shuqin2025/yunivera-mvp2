// backend/scripts/selfCheck.js
// 目的：cron 自检，验证基础抓取链路是否可用（HTTP 200 + 有 <title>）
// 以后要做结构质量评估，再切换到模板解析成功率作为判定

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fetch from 'node-fetch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.resolve(__dirname, '..');
const SEED = path.join(ROOT, 'cli', 'seed-urls.txt');
const OUT_DIR = path.join(ROOT, 'logs', 'selfcheck');

const MIN_OK = Number(process.env.SELF_CHECK_MIN_OK || 1); // 允许你通过 env 调整阈值

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

async function headOrGet(url) {
  // 少数站点 HEAD 不返回或被拒绝，直接 GET
  try {
    const r = await fetch(url, { method: 'GET', timeout: 15000 });
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
      const r = await headOrGet(u);
      if (!r.ok) {
        detail.push({ url: u, ok: false, status: r.status || 0, ms: Date.now() - t0 });
        continue;
      }
      const text = await r.text();
      const pass = r.status < 400 && text && text.length > 200 && hasTitle(text);
      if (pass) ok += 1;
      detail.push({ url: u, ok: pass, status: r.status, bytes: text.length, ms: Date.now() - t0 });
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
    threshold: MIN_OK,
    detail,
  };

  const outFile = path.join(OUT_DIR, `dailyReport-${ts}.json`);
  await fs.writeFile(outFile, JSON.stringify(report, null, 2), 'utf8');

  console.log(`[selfcheck] ${ts} ok=${ok}/${urls.length} ratio=${ratio.toFixed(2)} -> ${path.relative(ROOT, outFile)}`);

  // 是否需要“让 cron 变红”
  if (ok < MIN_OK) {
    // 现在默认不让 cron 红（exit 0），避免把“内容失败”当作“运行失败”
    // 如果你希望小于阈值就把 cron 跑红，改成：process.exit(1)
    process.exit(0);
  } else {
    process.exit(0);
  }
}

main().catch(e => {
  console.error('[selfcheck] fatal error', e);
  process.exit(1);
});
