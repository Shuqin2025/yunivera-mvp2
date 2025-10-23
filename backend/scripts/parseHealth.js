// backend/scripts/parseHealth.js
// 轻量“解析健康检查”：抓取目录页并用 cheerio 粗略统计“产品卡片”数量
// 仅评估解析可达性/可识别度，不写库、不导出。

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { setTimeout as delay } from 'timers/promises';
import fetch from 'node-fetch';
import cheerio from 'cheerio';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.resolve(__dirname, '..'); // backend/
const SEED_PATH = path.join(ROOT, 'cli', 'seed-urls.txt');
const LOG_DIR = path.join(ROOT, 'logs', 'selfcheck');

const PARSE_MIN_ITEMS = parseInt(process.env.PARSE_MIN_ITEMS || '6', 10);
const EXIT_ON_FAIL = (process.env.EXIT_ON_FAIL || '0') === '1';

// 一组常见“产品卡片”选择器（尽量兼容我们历史能抓的站点）
const CARD_SELECTORS = [
  '.product',
  '.product-card',
  '.product-item',
  '.productTile',
  'article.product',
  'li.product',
  'li.product-item',
  'li.grid-item',
  '.c-product-list__item',
  '.c-listing__item',
  '.product-grid .item',
  '.listing .product-box',
];

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
}

async function readLines(file) {
  const raw = await fs.readFile(file, 'utf8');
  return raw
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(s => s && !s.startsWith('#'));
}

function countCards($) {
  let maxHit = 0;
  let bestSel = '';
  for (const sel of CARD_SELECTORS) {
    const n = $(sel).length;
    if (n > maxHit) {
      maxHit = n;
      bestSel = sel;
    }
  }
  // 兜底：列表型 UL>LI
  if (maxHit === 0) {
    const n = $('ul li').length;
    if (n >= PARSE_MIN_ITEMS) {
      maxHit = n;
      bestSel = 'ul li (fallback)';
    }
  }
  return { items: maxHit, selector: bestSel };
}

async function probeParse(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);

  let status = 0;
  let items = 0;
  let selector = '';
  let err = '';

  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    status = res.status;
    if (!res.ok) {
      err = `bad status: ${status}`;
    } else {
      const html = await res.text();
      const $ = cheerio.load(html);
      const r = countCards($);
      items = r.items;
      selector = r.selector;
    }
  } catch (e) {
    err = String(e?.message || e);
  } finally {
    clearTimeout(to);
  }

  const ok = items >= PARSE_MIN_ITEMS;
  return { ok, status, items, selector, err };
}

const fmtDate = (d = new Date()) => d.toISOString().slice(0, 10);

async function main() {
  await ensureDir(LOG_DIR);

  const urls = await readLines(SEED_PATH);
  if (!urls.length) {
    console.log('[parseHealth] seed list empty.');
    return;
  }

  const today = fmtDate();
  const results = [];
  for (const u of urls) {
    const r = await probeParse(u);
    results.push({ url: u, ...r });
    await delay(200);
  }

  const total = results.length;
  const oks = results.filter(r => r.ok).length;
  const ratio = total > 0 ? +(oks / total).toFixed(3) : 0;

  const report = {
    date: today,
    total,
    ok: oks,
    ratio,
    minItems: PARSE_MIN_ITEMS,
    results,
    meta: { ts: new Date().toISOString() },
  };

  const file = path.join(LOG_DIR, `parseReport-${today}.json`);
  await fs.writeFile(file, JSON.stringify(report, null, 2), 'utf8');

  console.log(`[parseHealth] ${today} ok=${oks}/${total} ratio=${ratio} saved=${path.relative(ROOT, file)}`);

  // 按需让 cron 变红
  if (EXIT_ON_FAIL && oks === 0) process.exit(1);
}

main().catch(e => {
  console.error('[parseHealth] fatal:', e);
  if (EXIT_ON_FAIL) process.exit(1);
});
