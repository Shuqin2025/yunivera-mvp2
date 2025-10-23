#!/usr/bin/env node
// === imports（robust, ESM-safe） ===
import fs from 'node:fs';
import path from 'node:path';
import urlMod from 'node:url';

import config from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { withRetry } from '../lib/retryHandler.js';
import { ProgressBar } from '../lib/progressBar.js';

// --- 目录结构识别 / 模板解析 ---
import * as Structure from '../lib/structureDetector.js';
import * as Template   from '../lib/templateParser.js';

// --- 详情抓取 / 货号提取 / 导出 ---
import * as Detail   from '../lib/modules/detailFetcher.js';
import * as Artikel  from '../lib/modules/artikelExtractor.js';
import * as Excel    from '../lib/modules/excelExporter.js';

// --- 快照（可选）---
let writeSnapshot = null;
let makeTaskId    = null;
try {
  const m = await import('../lib/debugSnapshot.js');
  writeSnapshot = m.writeSnapshot || null;
  makeTaskId    = m.makeTaskId    || null;
} catch { /* ignore */ }

// ✅ 新增（诊断编排相关 import）
import { runStage } from '../modules/diagnostics/orchestrator.js';
import { register as registerDebugSnapshot } from '../modules/diagnostics/debugSnapshot.js';
import { register as registerAutoInspector } from '../modules/diagnostics/autoLogInspector.js';

// --- 统一“兼容映射”（命名导出 / default 混用时也能工作）---
const detectStructure      = Structure.detectStructure   || Structure.default;
const parseWithTemplateRaw = Template.parseWithTemplate  || Template.default?.parseWithTemplate || Template.default || Template.parse;
const fetchDetailsAndMerge = Detail.fetchDetailsAndMerge || Detail.default;
const extractArtikelNr     = Artikel.extractArtikelNr    || Artikel.default;
const exportToExcel        = Excel.exportToExcel         || Excel.default;

// ------------------------- CLI 参数 -------------------------
const argv = process.argv.slice(2);
const urls = [];
let limit          = 50;
let outName        = (config.export?.defaultXlsxName) || 'catalog.xlsx';
let outDir         = (config.export?.outDir)          || 'output';
let enableSnapshot = false;
let concurrency    = (config.concurrency?.parse)      || 3;
let taskId         = null;

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
  npm run cli -- \
    --url "https://snocks.com/collections/socken" \
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

if (urls.length === 0) { printHelp(); process.exit(0); }
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

// 任务ID生成 & 快照封装
if (!taskId) {
  if (makeTaskId) taskId = makeTaskId('yunivera');
  else {
    const t = new Date();
    taskId = `yunivera_${t.getFullYear()}${String(t.getMonth()+1).padStart(2,'0')}${String(t.getDate()).padStart(2,'0')}${String(t.getHours()).padStart(2,'0')}${String(t.getMinutes()).padStart(2,'0')}${String(t.getSeconds()).padStart(2,'0')}`;
  }
}
async function dbgSnapshot(stage, payload, append = false) {
  if (!enableSnapshot || !writeSnapshot) return;
  try { await writeSnapshot(taskId, stage, payload, append); }
  catch (e) { logger.warn(`snapshot(${stage}) 失败: ${e?.message || e}`); }
}

// ✅ 注册诊断模块（主流程启动前）
try {
  registerDebugSnapshot?.();   // 内部会向 orchestrator/onStage 自注册
  registerAutoInspector?.();
} catch (e) {
  logger.warn(`diagnostics register skipped: ${e?.message || e}`);
}

// ------------------------- 核心流程 -------------------------
const parseWithTemplate = async (url, opts) => parseWithTemplateRaw(url, opts);

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

  await dbgSnapshot('after-parse', {
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

  // 3) 详情页补抓（必要时）
  const needDetail = rows.some(r => (!r.sku && !r.ean) || (!r.price && !r.img));
  if (needDetail) {
    logger.info(`触发详情页补抓…（${rows.length} 记录）`);
    const bar = new ProgressBar(rows.length, 'details');
    rows = await fetchDetailsAndMerge(rows, { onProgress: () => bar.tick() });
    await dbgSnapshot('after-details', { url, type, count: rows.length, sample: rows.slice(0, 3) }, true);
  }

  // 4) 统一做 ID 智能提取（只填补空位）
  rows = rows.map(r => {
    const id = extractArtikelNr({
      title:  r.title || '',
      desc:   r.desc  || '',
      rawText: '',
      sku:    r.sku   || '',
      ean:    r.ean   || '',
      model:  r.model || '',
    });
    return {
      ...r,
      sku:   r.sku   || id.sku   || '',
      ean:   r.ean   || id.ean   || '',
      model: r.model || id.model || '',
    };
  });

  // 5) 导出 Excel
  const host     = (() => { try { return (new urlMod.URL(url)).hostname; } catch { return 'unknown-host'; } })();
  const safeHost = host.replace(/[^\w.-]/g, '_');
  const outPath  = path.join(outDir, `${safeHost}__${outName}`);
  const saved    = await exportToExcel(rows, { file: outPath });
  logger.info(`✅ 完成: ${url} → ${saved}（共 ${rows.length} 条）`);

  return { url, count: rows.length, out: saved, ok: true };
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

// ------------------------- 邮件汇总（可选） -------------------------
async function sendSummaryMail({ taskId, results }) {
  const to = process.env.REPORT_TO || 'shuqinamberg@proton.me';
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    logger.warn('邮件未发送：缺少 SMTP_* 环境变量');
    return;
  }

  let nodemailer;
  try { nodemailer = (await import('nodemailer')).default; }
  catch { logger.warn('邮件未发送：未安装 nodemailer（已安全跳过）'); return; }

  const okList   = results.filter(r => r.ok).map(r => r.value);
  const failList = results.filter(r => !r.ok);

  const textLines = [
    `Task: ${taskId}`,
    `Time: ${new Date().toISOString()}`,
    ``,
    `✅ 成功 ${okList.length} 个：`,
    ...okList.map(r => `- ${r.url}  →  ${r.out}  (${r.count} 条)`),
    ``,
    `❌ 失败 ${failList.length} 个：`,
    ...failList.map(r => `- ${r.error?.url || ''}  ${r.error?.message || r.error || ''}`),
  ];

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  await transporter.sendMail({
    from: `"Yunivera Bot" <${SMTP_USER}>`,
    to,
    subject: `[Yunivera] 批次完成 - OK ${okList.length} / FAIL ${failList.length} - ${taskId}`,
    text: textLines.join('\n'),
  });

  logger.info(`📧 已发送汇总邮件给 ${to}`);
}

// ------------------------- 批处理与汇总 -------------------------
(async () => {
  logger.info(`任务ID: ${taskId}`);
  const bar = new ProgressBar(urls.length, 'batch');

  // ✅ 批量开始
  try { runStage('start', { urls, taskId: 'batch-' + Date.now() }); } catch {}

  const results = await runPool(
    urls,
    async (u) => {
      try {
        const r = await runOne(u);

        // ✅ 单条完成（成功）
        try {
          runStage('afterParse', {
            url: u,
            ok: true,
            // 预留字段，方便未来在解析器里塞 meta/parse/html
            parse: r?.parse ?? null,
            meta:  r?.meta  ?? null,
            html:  r?.html  ?? null,
          });
        } catch {}

        bar.tick();
        return { ...r, ok: true };
      } catch (err) {
        logger.error(`❌ 失败: ${u} → ${err?.message || err}`);

        // ✅ 单条完成（失败）
        try {
          runStage('afterParse', {
            url: u,
            ok: false,
            error: err?.message || String(err),
          });
        } catch {}

        bar.tick();
        return { ok: false, error: { url: u, message: err?.message || String(err) } };
      }
    },
    concurrency
  );

  const ok   = results.filter(r => r.ok).length;
  const fail = results.length - ok;
  logger.info(`批次完成：成功 ${ok}，失败 ${fail}`);
  if (fail) logger.warn('失败条目：' + results.filter(r => !r.ok).map(r => r.error.url).join(', '));

  // ✅ 批次抓取完
  try { runStage('afterCrawl', { total: results.length, ok, fail }); } catch {}

  try { await sendSummaryMail({ taskId, results }); }
  catch (e) { logger.warn(`发送汇总邮件失败：${e?.message || e}`); }

  // ✅ 全部收尾
  try {
    runStage('finished', {
      outFile: outName,
      total: results.length,
      ok,
      fail,
    });
  } catch {}

  process.exit(0);
})();
