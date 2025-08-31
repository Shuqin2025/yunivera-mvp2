// backend/routes/pdf.js
import { Router } from 'express';
import PDFDocument from 'pdfkit';

const router = Router();

// 工具：把 rows(二维数组) 渲染成多行文本
function rowsToPlain(rows = []) {
  try {
    if (!Array.isArray(rows) || rows.length === 0) return '';
    return rows.map(r => (Array.isArray(r) ? r.join('  ') : String(r ?? ''))).join('\n');
  } catch {
    return '';
  }
}

// POST /v1/api/pdf
// body: { title?: string, content?: string, rows?: string[][] }
router.post('/', async (req, res) => {
  try {
    const title = (req.body?.title || '报价单 / Quote').toString();
    const contentFromRows = rowsToPlain(req.body?.rows);
    const content = (contentFromRows || req.body?.content || '').toString();

    // 重要：告诉浏览器这是 PDF，并建议下载文件名
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="quote.pdf"`);

    // 直接把 PDF 流 pipe 到响应（不落盘、不返回 JSON）
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    doc.pipe(res);

    // 标题
    doc.fontSize(20).text(title, { align: 'center' }).moveDown(1.5);

    // 正文（尽量使用通用字体；如果你在项目里放了 CJK 字体，可在此 doc.font(...) 嵌入）
    doc.fontSize(12).text(content || '(无正文 / empty)', {
      align: 'left',
      lineGap: 4,
    });

    doc.end(); // 结束后，Node 会把流发送给客户端
  } catch (err) {
    console.error('[PDF ERROR]', err);
    // 为保证前端总能拿到可读错误，这里仍然返回 JSON，但仅在异常分支
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
    }
  }
});

export default router;
