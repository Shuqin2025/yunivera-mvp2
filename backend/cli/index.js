#!/usr/bin/env node
/**
 * CLI: 输入 URL → 检测结构 → 解析目录 → 详情补抓 → 智能提取 SKU → 导出 Excel
 * 用法：
 *   npm run cli -- "https://example.com/category" --limit=50 --outfile=/tmp/out.xlsx
 */

const path = require('path');
const fs = require('fs');
const { URL } = require('url');

const templateParser = require('../lib/templateParser');
const detailFetcher = require('../lib/modules/detailFetcher');
const artikelExtractor = require('../lib/modules/artikelExtractor');
const excelExporter = require('../lib/modules/excelExporter');

function parseArgs(argv) {
  const args = { limit: 50, detailSkuMax: 0, outfile: path.resolve(process.cwd(), 'catalog.xlsx') };
  for (const a of argv.slice(2)) {
    if (!a) continue;
    if (!a.startsWith('--')) { args.url = a; continue; }
    const [k, v = ''] = a.replace(/^--/, '').split('=');
    if (k === 'limit') args.limit = Number(v || 50);
    if (k === 'detailSkuMax') args.detailSkuMax = Number(v || 0);
    if (k === 'outfile') args.outfile = path.resolve(process.cwd(), v || 'catalog.xlsx');
  }
  return args;
}

(async () => {
  const args = parseArgs(process.argv);
  if (!args.url) {
    console.error('用法: npm run cli -- "https://example.com/category" --limit=50 --detailSkuMax=12 --outfile=./out.xlsx');
    process.exit(2);
  }

  // 粗校验URL
  try { new URL(args.url); } catch {
    console.error('无效 URL:', args.url);
    process.exit(2);
  }

  console.log('▶ 解析目录:', args.url);
  const base = await templateParser.parseUrl(args.url, { limit: args.limit });

  console.log(`  - 初始抓到 ${base.products?.length || 0} 条`);

  // 详情页补抓（如需）
  let enriched = base.products || [];
  if (args.detailSkuMax > 0) {
    console.log(`▶ 详情页补抓 SKU（最多 ${args.detailSkuMax} 条）…`);
    enriched = await detailFetcher.enrich(enriched, {
      max: args.detailSkuMax,
      // 传入基础URL，便于相对链接处理
      baseUrl: base.url || args.url,
    });
    console.log(`  - 补抓后仍有 ${enriched.length} 条`);
  }

  // 智能提取 SKU / EAN / P/N
  console.log('▶ 智能提取 SKU / EAN / P/N …');
  enriched = enriched.map(p => {
    const sku = p.sku && String(p.sku).trim() ? p.sku : artikelExtractor.extractFromText([
      p.title, p.desc, p.url
    ].filter(Boolean).join(' \n ')).sku;
    return { ...p, sku: sku || '' };
  });

  // 导出 Excel
  console.log('▶ 导出 Excel =>', args.outfile);
  await excelExporter.toXLSX(enriched, args.outfile);

  // 成功提示
  const size = fs.existsSync(args.outfile) ? fs.statSync(args.outfile).size : 0;
  console.log(`✓ 完成。共 ${enriched.length} 条，文件大小 ${(size/1024).toFixed(1)} KB`);
})().catch(err => {
  console.error('✗ 运行失败：', err?.stack || err);
  process.exit(1);
});
