// backend/routes/match.js
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const router = express.Router();

// 计算当前目录（ESM 兼容）
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 数据文件
const dataDir = path.join(__dirname, '..', 'data');
const catalogPath = path.join(dataDir, 'catalog.json');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(catalogPath)) fs.writeFileSync(catalogPath, '[]', 'utf-8');

// ---------- 工具：分词 & 打分 ----------
function tokenize(str = '') {
  return (str + '')
    .toLowerCase()
    .replace(/[_.,;:\/\\()|[\]{}"“”’'!?+\-*@#%^&=]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function scoreItem(queryTokens, item) {
  const textTokens = tokenize(
    [item.name, item.description, JSON.stringify(item.params || {})].join(' ')
  );
  if (queryTokens.length === 0) return 0;

  let hits = 0;
  let weight = 0;
  const set = new Set(textTokens);

  // 完全命中
  for (const t of queryTokens) {
    if (set.has(t)) {
      hits += 1;
      weight += 2;
    }
  }
  // 部分包含
  const joined = textTokens.join(' ');
  for (const t of queryTokens) {
    if (!set.has(t) && joined.includes(t)) {
      hits += 1;
      weight += 1;
    }
  }
  // 名称额外加权
  const nameTokens = tokenize(item.name || '');
  for (const t of queryTokens) {
    if (nameTokens.includes(t)) weight += 3;
  }

  const raw = (hits + weight) / (queryTokens.length * 6);
  let score = Math.max(0, Math.min(1, raw)) * 100;
  if (item.url) score += 2; // 有链接小奖励
  return Math.round(Math.max(0, Math.min(100, score)));
}

// ---------- 路由：查找（带分数） ----------
router.post('/match/find', (req, res) => {
  try {
    const {
      mode = 'keyword',
      keyword = '',
      url = '',
      pdfText = '',
      imageTags = [],
    } = req.body || {};

    const queryTokens = [
      ...tokenize(keyword),
      ...tokenize(url),
      ...tokenize(pdfText),
      ...(Array.isArray(imageTags) ? imageTags.map((t) => (t + '').toLowerCase()) : []),
    ];

    let items = [];
    try {
      items = JSON.parse(fs.readFileSync(catalogPath, 'utf-8') || '[]');
    } catch { items = []; }

    const scored = items
      .map((it) => ({ ...it, score: scoreItem(queryTokens, it) }))
      .sort((a, b) => (b.score || 0) - (a.score || 0));

    res.json({ items: scored });
  } catch (e) {
    console.error('[match/find] error:', e);
    res.status(500).json({ items: [], error: 'match_find_failed' });
  }
});

// ---------- 路由：导出 PDF（含分数） ----------
router.post('/match/export-pdf', async (req, res) => {
  try {
    const { items = [], title = '对比结果（MVP2 导出）' } = req.body || {};

    const filesDir = path.join(__dirname, '..', 'files');
    if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true });

    const ts = Date.now();
    const outPath = path.join(filesDir, `compare_${ts}.pdf`);

    const PDFDocument = (await import('pdfkit')).default;
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);

    const fontPath = path.join(__dirname, '..', 'fonts', 'NotoSansSC-Regular.ttf');
    if (fs.existsSync(fontPath)) doc.font(fontPath);

    doc.fontSize(16).text(title);
    doc.moveDown();

    items.forEach((it, idx) => {
      doc.fontSize(12).text(`${idx + 1}. ${it.name}   相似度：${'score' in it ? it.score + '%' : '-%'}`);
      if (it.price !== undefined) doc.text(`价格: ${it.price}`);
      if (it.url) doc.text(`链接: ${it.url}`);
      if (it.description) doc.text(`描述: ${it.description}`);

      const p = it.params || {};
      const entries = Object.entries(p);
      if (entries.length) doc.text('参数：' + entries.map(([k, v]) => `${k}: ${v}`).join('，'));
      doc.moveDown();
    });

    doc.end();
    stream.on('finish', () => {
      const host = `${req.protocol}://${req.get('host')}`;
      res.json({ pdf: `${host}/files/compare_${ts}.pdf` });
    });
  } catch (e) {
    console.error('[match/export-pdf] error:', e);
    res.status(500).json({ error: 'export_failed' });
  }
});

export default router;
