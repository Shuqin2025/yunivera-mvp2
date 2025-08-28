// backend/routes/quote.js
import express from 'express';
import PDFDocument from 'pdfkit';

const router = express.Router();

/**
 * 健康检查
 * GET https://<your-backend>/v1/api/health
 * 响应: { ok: true, message: 'OK' }
 */
router.get('/health', (req, res) => {
  res.json({ ok: true, message: 'OK' });
});

/**
 * 生成 PDF（保持与现有前端测试的兼容）
 * POST https://<your-backend>/v1/api/pdf
 * body: { title?: string, content?: string }
 * 响应: application/pdf (attachment: quote.pdf)
 */
router.post('/pdf', async (req, res) => {
  const { title = '测试报价单', content = '这是由后端 /v1/api/pdf 生成的 PDF。' } = req.body || {};

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="quote.pdf"');

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  doc.pipe(res);

  doc.fontSize(20).text(title, { align: 'center' });
  doc.moveDown();
  doc.fontSize(12).text(content);

  doc.end();
});

export default router;
