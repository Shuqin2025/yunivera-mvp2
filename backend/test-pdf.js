// backend/test-pdf.js  —— 本地生成一个简单 PDF 验证 PDFKit 是否正常
import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 确保有输出目录 backend/files
const outDir = path.join(__dirname, 'files');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

// 输出文件
const filename = `local-test-${Date.now()}.pdf`;
const filepath = path.join(outDir, filename);

// 生成
const doc = new PDFDocument({ size: 'A4', margin: 56 });
doc.pipe(fs.createWriteStream(filepath));

doc.fontSize(20).text('测试报价单', { align: 'center' }).moveDown();
doc.fontSize(12).text('这是一个由 test-pdf.js 本地生成的 PDF 文件，用于验证 PDFKit 输出是否正常。');

doc.end();

console.log('OK! 生成成功：', filepath);
