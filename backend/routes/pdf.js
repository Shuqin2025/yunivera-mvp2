// backend/routes/pdf.js
import { Router } from 'express';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const router = Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * POST /v1/api/pdf
 * body:
 *   {
 *     title?: string,
 *     content?: string,      // 与 rows 二选一；有 rows 优先
 *     rows?: Array<{
 *       name?: string,
 *       sku?: string,
 *       price?: number|string,
 *       currency?: string,
 *       moq?: number|string,
 *       url?: string
 *     }>
 *   }
 */
router.post('/', async (req, res) => {
  try {
    const { title = '报价单 / Angebot', content = '', rows = [] } = req.body || {};

    // 1) 设置 PDF 响应头（前端在用 response.blob()，必须返回二进制）
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="quote.pdf"');

    // 2) 创建 PDF 文档并直接 pipe 到 response（不要写磁盘，不要 res.json）
    const doc = new PDFDocument({ size: 'A4', margin: 56 });
    doc.pipe(res);

    // 3) 中文字体（可选）：如果存在就用 NotoSansSC，否则 Helvetica
    const zhFont = path.join(__dirname, '..', 'fonts', 'NotoSansSC-Regular.ttf');
    if (fs.existsSync(zhFont)) {
      try { doc.registerFont('zh', zhFont); doc.font('zh'); } catch {}
    } else {
      doc.font('Helvetica');
    }

    // 4) 标题
    doc.fontSize(18).text(title, { align: 'center' }).moveDown(1);

    // 5) 正文或表格
    if (Array.isArray(rows) && rows.length > 0) {
      doc.fontSize(12).text('【报价列表 / Price List】').moveDown(0.5);

      const headers = ['名称', 'SKU', '价格', '币种', 'MOQ', '来源'];
      const colWidths = [140, 80, 70, 50, 50, 130];

      // 表头
      headers.forEach((h, i) => doc.text(h, { continued: i < headers.length - 1, width: colWidths[i] }));
      doc.moveDown(0.3);
      doc.moveTo(doc.x, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
      doc.moveDown(0.3);

      // 数据行
      rows.forEach((r) => {
        const vals = [
          r?.name ?? '',
          r?.sku ?? '',
          (r?.price ?? '') + '',
          r?.currency ?? '',
          (r?.moq ?? '') + '',
          r?.url ?? ''
        ];
        vals.forEach((v, i) => doc.text(v, { continued: i < vals.length - 1, width: colWidths[i] }));
        doc.moveDown(0.2);
      });

      doc.moveDown(0.8);
      doc.fontSize(10).fillColor('#555')
        .text('注：本页仅为自动整理的询价草稿，用于内部快速比对；最终价格以供应商报价为准。')
        .fillColor('black');
    } else {
      // 无 rows 时，用纯文本正文
      doc.fontSize(12).text(content || '（无正文 / No content）', { align: 'left', lineGap: 4 });
    }

    // 6) 结束并把内容刷到客户端
    doc.end();

    // 注意：这里不要再写任何 res.json / res.end，避免破坏 PDF 流
  } catch (err) {
    console.error('[PDF ERROR]', err);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
    }
  }
});

export default router;
