// backend/lib/modules/excelExporter.js
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as XLSX from 'xlsx';

function safe(v) {
  return v == null ? '' : String(v);
}

function now() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 导出产品列表为 XLSX
 * @param {Array<object>} products 统一结构数组：
 *  { title, sku, ean, price, currency, moq, unit, img, imgs[], desc, link, url, adapter }
 * @param {Object} options { file?: string, filenamePrefix?: string, sourceUrl?: string }
 * @returns {Promise<string>} 生成文件的绝对路径
 */
export async function exportToExcel(products = [], options = {}) {
  const rows = (products || []).map((p, i) => ({
    '#': i + 1,
    Title: safe(p.title),
    'SKU / ID': safe(p.sku),
    EAN: safe(p.ean),
    Price: safe(p.price),
    Currency: safe(p.currency),
    MOQ: safe(p.moq),
    Unit: safe(p.unit),
    Image: safe(p.img),
    Images: Array.isArray(p.imgs) ? p.imgs.join(' | ') : safe(p.imgs),
    Description: safe(p.desc),
    'Product Link': safe(p.link || p.url),
    'Source URL': safe(p.url),
    Adapter: safe(p.adapter),
    'Exported At': now(),
  }));

  const header = [
    '#',
    'Title',
    'SKU / ID',
    'EAN',
    'Price',
    'Currency',
    'MOQ',
    'Unit',
    'Image',
    'Images',
    'Description',
    'Product Link',
    'Source URL',
    'Adapter',
    'Exported At',
  ];

  const ws = XLSX.utils.json_to_sheet(rows, { header, skipHeader: false });
  // 适度的列宽（SheetJS 只支持粗略宽度）
  const colWidths = [6, 50, 24, 18, 12, 10, 8, 8, 50, 60, 60, 60, 60, 16, 18].map((wch) => ({ wch }));
  ws['!cols'] = colWidths;

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Products');

  // 输出路径：优先 options.file，否则落到临时目录
  const outfile =
    options.file ||
    path.join(
      os.tmpdir(),
      `${options.filenamePrefix || 'catalog'}-${Date.now()}.xlsx`
    );

  const dir = path.dirname(outfile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  XLSX.writeFile(wb, outfile, { bookType: 'xlsx' });
  return outfile;
}
