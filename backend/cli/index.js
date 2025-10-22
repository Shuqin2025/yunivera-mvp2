#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import urlMod from 'node:url';

import config from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { withRetry } from '../lib/retryHandler.js';
import { ProgressBar } from '../lib/progressBar.js';

import { detectStructure } from '../lib/structureDetector.js';
import { parseWithTemplate } from '../lib/templateParser.js';
import { fetchDetailsAndMerge } from '../lib/modules/detailFetcher.js';
import { extractArtikelNr } from '../lib/modules/artikelExtractor.js';
import { exportToExcel } from '../lib/modules/excelExporter.js';

// 兼容性的快照导入（如果模块里是 writeSnapshot/makeTaskId，就包装成 debugSnapshot）
let writeSnapshot = null;
let makeTaskId   = null;
try {
  const m = await import('../lib/debugSnapshot.js');
  writeSnapshot = m.writeSnapshot || null;
  makeTaskId    = m.makeTaskId    || null;
} catch {
  // 可选模块，不存在就忽略
}

// ------------------------- CLI 参数 -------------------------
const argv = process.argv.slice(2);
const urls = [];
let limit         = 50;
let outName       = (config.export?.defaultXlsxName) || 'catalog.xlsx';
let outDir        = (config.export?.outDir)          || 'output';
let enableSnapshot = false;
let concurrency   = (config.concurrency?.parse)      || 3;
let taskId        = null;

function printHelp() {
  const msg = `
Yunivera CLI - 输入 URL 抓取目录并导出 Excel

用法:
  npm run cli -- [参数...]

常用参数:
  -u, --url <URL>           目标分类页，可多次指定
  -l, --limit <N>           抓取条数上限（默认 50）
  -o, --xlsx <name.xlsx>    导出文件名（默认 ${outName}）
      --outdir <dir>        导出目录（默认 ${outDir}）
  -c, --concurrency <N>     并发抓取 URL 数（默认 ${concurrency}）
  -s, --snapshot            开启阶段快照（after-parse / after-details）
      --task <id>           指定本次任务ID（未指定则自动生成）
  -h, --help                显示帮助

示例:
  npm run cli -- \\
    --url "https://snocks.com/collections/socken" \\
    --url "https://themes.woocommerce.com/storefront/shop/" \\
    -l 60 -o result.xlsx --outdir ./output -c 4 --snapshot
`.trim();
  console.log(msg);
}

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--url' || a === '-u')          { urls.push(argv[++i]); continue; }
  if (a === '--limit' || a === '-l')        { limit = parseInt(argv[++i] || '50', 10); continue; }
  if (a === '--xlsx' || a === '-o')         { outName = argv[++i] || outName; continue; }
  if (a === '--outdir')                     { outDir = argv[++i] || outDir; continue; }
  if (a === '--snapshot' || a === '-s')     { enableSnapshot = true; continue; }
  if (a === '--concurrency' || a === '-c')  { concurrency = Math.max(1, parseInt(argv[++i] || `${concurrency}`, 10)); continue; }
  if (a === '--task')                       { taskId = argv[++i] || null; continue; }
  if (a === '--help' || a === '-h')         { printHelp(); process.exit(0); }
}

if (urls.length === 0) {
  printHelp();
  process.exit(0);
}

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

// 快照包装（可关可开、可兼容）
if (!taskId) {
  if (makeTaskId) {
    taskId = makeTaskId('yunivera');
  } else {
    const t = new Date();
    taskId = `yunivera_${t.getFullYear()}${String(t.getMonth()+1).padStart(2,'0')}${String(t.getDate()).padStart(2,'0')}${String(t.getHours()).padStart(2,'0')}${String(t.getMinutes()).padStart(2,'0')}${String(t.getSeconds()).padStart(2,'0')}`;
  }
}
async function debugSnapshot(stage, payload, append = false) {
  if (!enableSnapshot || !writeSnapshot) return;
  try {
    await writeSnapshot(taskId, stage, payload, append);
  } catch (e) {
    logger.warn(`snapshot(${stage}) 失败: ${e?.message || e}`);
  }
}

// ------------------------- 核心流程 -------------------------
async function runOne(url) {
  logger.info(`开始处理: ${url}`);

  // 1) 类型识别
  const det = await withRetry(
    () => detectStructure(url),
    {
      tries:    config.request?.retry        ?? 3,
      delayMs:  config.request?.retryDelayMs ?? 800,
      jitterMs: config.request?.retryJitterMs?? 400,
      onRetry:  ({ attempt, backoff, err }) =>
        logger.warn(`detect 重试 #${attempt} in ${backoff}ms: ${err?.message || err}`),
    }
  );
  const type = det?.type || det?.adapter || 'unknown';
  logger.info(`识别类型: ${type}`);

  // 2) 模板解析（目录页）
  let rows = await withRetry(
    () => parseWithTemplate(url, { limit }),
    {
      tries:    config.request?.retry        ?? 3,
      delayMs:  config.request?.retryDelayMs ?? 800,
      jitterMs: config.request?.retryJitterMs?? 400,
      onRetry:  ({ attempt, backoff }) =>
        logger.warn(`parse 重试 #${attempt} in ${backoff}ms`),
    }
  );

  await debugSnapshot('after-parse', {
    url, type,
    count: rows.length,
    sample: rows.slice(0, 3),
    fieldsRate: rows.length ? {
      title: rows.filter(p => p.title).length / rows.length,
      price: rows.filter(p => p.price).length / rows.length,
      img:   rows.filter(p => p.img).length   / rows.length,
      sku:   rows.filter(p => p.sku).length   / rows.length,
    } : { title:0, price:0, img:0, sku:0 },
  });

  // 3) 详情页补抓（仅当必要时）
  const needDetail = rows.some(r => (!r.sku && !r.ean) || (!r.price && !r.img));
  if (needDetail) {
    logger.info(`触发详情页补抓…（${rows.length} 记录）`);
    const bar = new ProgressBar(rows.length, 'details');
    rows = await fetchDetailsAndMerge(rows, { onProgress: () => bar.tick() });
    await debugSnapshot('after-details', { url, type, count: rows.length, sample: rows.slice(0, 3) }, true);
  }

  // 4) 统一做 Artikel-Nr/EAN/SKU 智能提取（只填补空位）
  rows = rows.map(r => {
    const id = extractArtikelNr({
      title:  r.title || '',
      desc:   r.desc  || '',
      rawText: '',
      sku:    r.sku   || '',
      ean:    r.ean   || '',
    });
    return {
      ...r,
      sku:   r.sku   || id.sku   || '',
      ean:   r.ean   || id.ean   || '',
      model: r.model || id.model || '',
    };
  });

  // 5) 导出 Excel
  const host    = (() => { try { return (new urlMod.URL(url)).hostname; } catch { return 'unknown-host'; } })();
  const safeHost= host.replace(/[^\w.-]/g, '_');
  const outPath = path.join(outDir, `${safeHost}__${outName}`);
  await exportToExcel(rows, { file: outPath });

  logger.info(`✅ 完成: ${url} → ${outPath}（共 ${rows.length} 条）`);
  return { url, count: rows.length, out: outPath };
}

// ------------------------- 简易并发任务池 -------------------------
async function runPool(items, worker, poolSize) {
  const results = new Array(items.length);
  let next = 0;
  let active = 0;

  return new Promise((resolve) => {
    const maybeStart = () => {
      while (active < poolSize && next < items.length) {
        const i = next++;
        active++;
        Promise.resolve(worker(items[i], i))
          .then((r) => { results[i] = { ok: true,  value: r }; })
          .catch((e) => { results[i] = { ok: false, error: e }; })
          .finally(() => {
            active--;
            if (results.filter(Boolean).length === items.length) resolve(results);
            else maybeStart();
          });
      }
    };
    maybeStart();
  });
}

// ------------------------- 批处理与汇总 -------------------------
(async () => {
  logger.info(`任务ID: ${taskId}`);
  const bar = new ProgressBar(urls.length, 'batch');

  const results = await runPool(
    urls,
    async (u) => {
      try {
        const r = await runOne(u);
        bar.tick();
        return { ...r, ok: true };
      } catch (err) {
        logger.error(`❌ 失败: ${u} → ${err?.message || err}`);
        bar.tick();
        return { url: u, ok: false, error: err?.message || String(err) };
      }
    },
    concurrency
  );

  const ok   = results.filter(r => r.ok).length;
  const fail = results.length - ok;
  logger.info(`批次完成：成功 ${ok}，失败 ${fail}`);
  if (fail) logger.warn('失败条目：' + results.filter(r => !r.ok).map(r => r.url).join(', '));

  process.exit(0);
})();
