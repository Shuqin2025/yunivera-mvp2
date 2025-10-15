// backend/lib/modules/excelExporter.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const ExcelJS = require('exceljs');

function safe(v) { return v == null ? '' : String(v); }

function now() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * @param {Array} products 统一结构数组：
 *  {
 *    title, sku, ean, price, currency, moq, unit,
 *    img, imgs[], desc, link, url, adapter
 *  }
 * @param {Object} options { filenamePrefix, sourceUrl }
 * @returns {Promise<string>} 生成文件的绝对路径
 */
async function exportToExcel(products = [], options = {}) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Products');

  sheet.columns = [
    { header: '#', key: '_idx', width: 6 },
    { header: 'Title', key: 'title', width: 50 },
    { header: 'SKU / ID', key: 'sku', width: 24 },
    { header: 'EAN', key: 'ean', width: 18 },
    { header: 'Price', key: 'price', width: 12 },
    { header: 'Currency', key: 'currency', width: 10 },
    { header: 'MOQ', key: 'moq', width: 8 },
    { header: 'Unit', key: 'unit', width: 8 },
    { header: 'Image', key: 'img', width: 50 },
    { header: 'Images', key: 'imgs', width: 60 },
    { header: 'Description', key: 'desc', width: 60 },
    { header: 'Product Link', key: 'link', width: 60 },
    { header: 'Source URL', key: 'url', width: 60 },
    { header: 'Adapter', key: 'adapter', width: 16 },
    { header: 'Exported At', key: 'ts', width: 18 },
  ];

  (products || []).forEach((p, i) => {
    sheet.addRow({
      _idx: i + 1,
      title: safe(p.title),
      sku: safe(p.sku),
      ean: safe(p.ean),
      price: safe(p.price),
      currency: safe(p.currency),
      moq: safe(p.moq),
      unit: safe(p.unit),
      img: safe(p.img),
      imgs: Array.isArray(p.imgs) ? p.imgs.join(' | ') : safe(p.imgs),
      desc: safe(p.desc),
      link: safe(p.link || p.url),
      url: safe(p.url),
      adapter: safe(p.adapter),
      ts: now(),
    });
  });

  sheet.getRow(1).font = { bold: true };

  // 自动换行 & 顶部对齐（长文本列）
  ['Images', 'Description', 'Product Link', 'Source URL'].forEach(h => {
    const col = sheet.getColumn(h);
    col.alignment = { wrapText: true, vertical: 'top' };
  });

  // 生成临时文件
  const prefix = options.filenamePrefix || 'catalog';
  const tmp = path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}.xlsx`
  );

  await workbook.xlsx.writeFile(tmp);
  return tmp;
}

module.exports = { exportToExcel };
