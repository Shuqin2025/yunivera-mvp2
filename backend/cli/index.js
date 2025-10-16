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
import { debugSnapshot } from '../lib/modules/debugSnapshot.js'; // 可选快照

// ------------------------- CLI 参数 -------------------------
const argv = process.argv.slice(2);
const urls = [];
let limit = 50;
let outName = config.export?.defaultXlsxName || 'catalog.xlsx';
let outDir = config.export?.outDir || 'output';
let enableSnapshot = false;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--url' || a === '-u') { urls.push(argv[++i]); continue; }
  if (a === '--limit' || a === '-l') { limit = parseInt(argv[++i] || '50', 10); continue; }
  if (a === '--xlsx' || a === '-o') { outName = argv[++i] || outName; continue; }
  if (a === '--outdir') { outDir = argv[++i] || outDir; continue; }
  if (a === '--snapshot' || a === '-s') { enableSnapshot = true; continue; }
}

if (urls.length === 0) {
  logger.info('用法: npm run cli -- --url <catalogURL> [--url <...>] [--limit 50] [--xlsx out.xlsx] [--outdir dir] [--snapshot]');
  process.exit(0);
}

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

// ------------------------- 核心流程 -------------------------
async function runOne(url) {
  logger.info(`开始处理: ${url}`);

  // 1) 类型识别
  const det = await withRetry(
    () => detectStructure(url),
    {
      tries: config.request.retry,
      delayMs: config.request.retryDelayMs,
      jitterMs: config.request.retryJitterMs,
      onRetry: ({ attempt, backoff, err }) =>
        logger.warn(`detect 重试 #${attempt} in ${backoff}ms: ${err?.message || err}`),
    }
  );
  const type = det?.type || 'unknown';
  logger.info(`识别类型: ${type}`);

  // 2) 模板解析（目录页）
  let rows = await withRetry(
    () => parseWithTemplate(url, { limit }),
    {
      tries: config.request.retry,
      delayMs: config.request.retryDelayMs,
      jitterMs: config.request.retryJitterMs,
      onRetry: ({ attempt, backoff }) =>
        logger.warn(`parse 重试 #${attempt} in ${backoff}ms`),
    }
  );

  if (enableSnapshot) {
    try { await debugSnapshot('after-parse', { url, type, count: rows.length, sample: rows.slice(0, 3) }); }
    catch (e) { logger.warn(`snapshot(after-parse) 失败: ${e?.message || e}`); }
  }

  // 3) 详情页补抓（仅当必要时）
  const needDetail = rows.some(r => (!r.sku && !r.ean) || (!r.price && !r.img));
  if (needDetail) {
    logger.info(`触发详情页补抓…（${rows.length} 记录）`);
    const bar = new ProgressBar(rows.length, 'details');
    rows = await fetchDetailsAndMerge(rows, { onProgress: () => bar.tick() });
    if (enableSnapshot) {
      try { await debugSnapshot('after-details', { url, type, count: rows.length, sample: rows.slice(0, 3) }); }
      catch (e) { logger.warn(`snapshot(after-details) 失败: ${e?.message || e}`); }
    }
  }

  // 4) 统一做 Artikel-Nr/EAN/SKU 智能提取（只填补空位）
  rows = rows.map(r => {
    const id = extractArtikelNr({
      title: r.title || '',
      desc: r.desc || '',
      rawText: '',
      sku: r.sku || '',
      ean: r.ean || '',
    });
    return {
      ...r,
      sku: r.sku || id.sku || '',
      ean: r.ean || id.ean || '',
      model: r.model || id.model || '',
    };
  });

  // 5) 导出 Excel
  const host = (() => { try { return (new urlMod.URL(url)).hostname; } catch { return 'unknown-host'; } })();
  const safeHost = host.replace(/[^\w.-]/g, '_');
  const outPath = path.join(outDir, `${safeHost}__${outName}`);
  await exportToExcel(rows, { file: outPath });

  logger.info(`✅ 完成: ${url} → ${outPath}（共 ${rows.length} 条）`);
  return { url, count: rows.length, out: outPath };
}

// ------------------------- 批处理与汇总 -------------------------
(async () => {
  const bar = new ProgressBar(urls.length, 'batch');
  const results = [];

  for (const u of urls) {
    try {
      const r = await runOne(u);
      results.push({ ...r, ok: true });
    } catch (err) {
      logger.error(`❌ 失败: ${u} → ${err?.message || err}`);
      results.push({ url: u, ok: false, error: err?.message || String(err) });
    } finally {
      bar.tick();
    }
  }

  const ok = results.filter(r => r.ok).length;
  const fail = results.length - ok;
  logger.info(`批次完成：成功 ${ok}，失败 ${fail}`);
  if (fail) logger.warn('失败条目：' + results.filter(r => !r.ok).map(r => r.url).join(', '));

  process.exit(0);
})();
