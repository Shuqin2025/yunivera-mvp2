// export.js
const Router = require('express').Router;
const ExcelJS = require('exceljs');
const axios = require('axios');
const pLimit = require('p-limit');
const { chromium } = require('playwright');

const router = Router();

// 通用 UA
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

// 工具：根据 Content-Type 猜扩展名
function extFromContentType(ct = '') {
  ct = (ct || '').toLowerCase();
  if (ct.includes('png')) return 'png';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpeg';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('gif')) return 'gif';
  return 'png';
}

// 先尝试 axios 下载（带 Referer）；失败再用 Playwright 兜底
async function fetchImageBuffer(imgUrl) {
  const origin = (() => {
    try { return new URL(imgUrl).origin; } catch { return undefined; }
  })();

  // 1) axios 直连
  try {
    const resp = await axios.get(imgUrl, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': UA,
        'Referer': origin || imgUrl, // 有的站校验来源
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
      timeout: 15000,
      validateStatus: s => s >= 200 && s < 400
    });
    const ext = extFromContentType(resp.headers['content-type']);
    return { buffer: Buffer.from(resp.data), extension: ext };
  } catch (e) {
    // 继续兜底
  }

  // 2) Playwright 兜底（模拟浏览器发起请求，天然带 Referer）
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ userAgent: UA });
    // 直接 fetch 图片，拿到 arrayBuffer
    const arrBuf = await page.evaluate(async (url) => {
      const r = await fetch(url, { credentials: 'omit' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const ab = await r.arrayBuffer();
      return Array.from(new Uint8Array(ab)); // 序列化给 Node
    }, imgUrl);
    // 尝试根据扩展名推断
    const extGuess = imgUrl.split('?')[0].split('.').pop().toLowerCase();
    const ext = ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extGuess) ? extGuess : 'png';
    return { buffer: Buffer.from(Uint8Array.from(arrBuf)), extension: ext };
  } finally {
    await browser.close();
  }
}

// 主导出路由：接收 JSON 数组
// items: [{ title, link, imageUrl, price, sku, ... }]
router.post('/export/xlsx', async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Products');

  // 表头
  ws.columns = [
    { header: 'Title', key: 'title', width: 40 },
    { header: 'Price', key: 'price', width: 12 },
    { header: 'SKU',   key: 'sku',   width: 18 },
    { header: 'Link',  key: 'link',  width: 60 },
    { header: 'Image', key: 'image', width: 22 }, // 实际用于放图
  ];

  // 先写文本数据（第 2 行开始放）
  items.forEach((it, idx) => {
    const row = ws.addRow({
      title: it.title || '',
      price: it.price || '',
      sku: it.sku || '',
      link: it.link || '',
      image: '' // 占位
    });
    // 给 Link 加超链
    if (it.link) {
      const cell = row.getCell('link');
      cell.value = { text: it.link, hyperlink: it.link };
      cell.font = { color: { argb: 'FF1B73E8' }, underline: true };
    }
    // 行高为放图准备
    row.height = 100;
  });

  // 下载图片并嵌入（控制并发，避免被限流/过慢）
  const limit = pLimit(4);
  const tasks = items.map((it, i) => limit(async () => {
    if (!it.imageUrl) return;
    try {
      const { buffer, extension } = await fetchImageBuffer(it.imageUrl);
      const imageId = wb.addImage({ buffer, extension });
      // ExcelJS 坐标（列行从 0 开始）：Image 列是第 5 列 → 索引 4
      const rowIdx = i + 2; // 数据从第 2 行开始
      ws.addImage(imageId, {
        tl: { col: 4, row: rowIdx - 1 }, // 放到第 5 列（E列）
        ext: { width: 120, height: 90 }, // 按你需要调整
        editAs: 'oneCell'
      });
    } catch (e) {
      // 失败就忽略，保留空白
      // 也可以在相邻列写上 "Image fetch failed"
    }
  }));

  await Promise.all(tasks);

  // 样式微调
  ws.getRow(1).font = { bold: true };
  ws.getColumn('image').alignment = { vertical: 'middle', horizontal: 'center' };

  // 输出
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="products.xlsx"');
  await wb.xlsx.write(res);
  res.end();
});

module.exports = router;
