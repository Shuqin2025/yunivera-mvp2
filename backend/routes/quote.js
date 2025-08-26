import express from 'express';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default function routes(filesDir) {
  const router = express.Router();

  router.get('/ping', (req, res) => res.send('ok'));

  router.post('/quote/export-pdf', (req, res) => {
    try {
      const { title = '示例报价', items = [] } = req.body || {};

      const doc = new PDFDocument({ size: 'A4', margin: 50 });

      // 输出文件
      const fileName = `quote_${Date.now()}.pdf`;
      const outPath = path.join(filesDir, fileName);
      const stream = fs.createWriteStream(outPath);
      doc.pipe(stream);

      // 关键：用绝对路径载入中文字体，并在写任何文字前切换到它
      const fontPath = path.join(__dirname, '..', 'fonts', 'NotoSansSC-Regular.ttf');
      if (fs.existsSync(fontPath)) {
        doc.registerFont('noto', fontPath);
        doc.font('noto'); // 必须在任何 doc.text 之前
        console.log('[mvp2] using font:', fontPath);
      } else {
        console.warn('[mvp2] font not found:', fontPath);
      }

      // 标题
      doc.fontSize(16).text(title);
      doc.moveDown();

      // 列表
      items.forEach((it, idx) => {
        doc.fontSize(12).text(`${idx + 1}. ${it.name || ''}`);
        if (it.desc) doc.text(`描述: ${it.desc}`);
        if (it.price !== undefined) doc.text(`价格: ${it.price}`);
        if (it.url) doc.text(`链接: ${it.url}`, { link: it.url, underline: true });
        doc.moveDown(0.8);
      });

      doc.end();

      stream.on('finish', () => {
        const host = `${req.protocol}://${req.get('host')}`;
        res.json({ pdf: `${host}/files/${fileName}` });
      });
      stream.on('error', (e) => {
        console.error(e);
        res.status(500).json({ error: 'export_failed' });
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'server_error' });
    }
  });

  return router;
}
