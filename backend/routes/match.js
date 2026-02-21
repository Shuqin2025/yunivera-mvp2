// backend/routes/match.js
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Ajv from "ajv";
import addFormats from "ajv-formats";

// ✅ [新增] 在 ESM 文件里使用 CommonJS 模块
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { compressBundle } = require('../lib/modules/semanticCompression/semanticCompressor.js');
// ---------------- Manifest schema validator (draft-07) ----------------
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

// match.js 位于 backend/routes/，schema 位于 backend/lib/schemas/

const router = express.Router();

// 计算当前目录（ESM 兼容）
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const manifestSchemaPath = path.join(__dirname, "..", "lib", "schemas", "compression_manifest_v1.schema.json");
const manifestSchema = JSON.parse(fs.readFileSync(manifestSchemaPath, "utf-8"));
const validateManifest = ajv.compile(manifestSchema);

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
    } catch {
      items = [];
    }

    const scored = items
      .map((it) => ({ ...it, score: scoreItem(queryTokens, it) }))
      .sort((a, b) => (b.score || 0) - (a.score || 0));

    // ✅ [新增] 生成 compression_manifest（只做“接线验证版”，不改变现有 items）
    const matchedBundle = {
      requestId: `match-${Date.now()}`,
      schemaVersion: '1.0',
      source: { url, fetchedAt: new Date().toISOString() },
      items: scored.map((it, idx) => {
  const itemId = it.id || it.url || it.name || String(idx);

  // ✅ 最小“通用目录字段”（任何目录都适用）
  const normalized = {
    id: itemId,
    title: it.name || '',
    url: it.url || '',
    summary: it.description || '',
    source: 'catalog',
  };

  // ✅ 可选：电商/商品目录字段（有则填，没有就空着，不影响）
  // 尽量从常见位置找：it.sku / it.params.sku
  const sku = it.sku || (it.params && (it.params.sku || it.params.SKU)) || '';
  if (sku) normalized.sku = String(sku).trim();

  // price：可能是 it.price 或 it.params.price（你现在 PDF 导出里用 it.price，所以优先 it.price）
  const priceRaw = it.price ?? (it.params && (it.params.price || it.params.unitPrice));
  if (priceRaw !== undefined && priceRaw !== null && priceRaw !== '') {
    normalized.price = { amount: priceRaw, currency: 'EUR' }; // currency 先默认 EUR，后续可从站点/字段识别
  }

  // ✅ evidence（最小证据锚点）：先把“来源字段”写出来
  // semanticCompressor 会用 evidence.field 来生成候选（目前它重点看 sku 和 price.amount）
  const evidence = [];
  if (normalized.sku) {
    evidence.push({
      field: 'sku',
      source: 'catalog',
      snippet: String(normalized.sku),
      confidence: 0.70,
      locator: { type: 'catalog_field', key: 'sku' },
    });
  }
  if (normalized.price && normalized.price.amount !== undefined) {
    evidence.push({
      field: 'price.amount',
      source: 'catalog',
      snippet: String(normalized.price.amount),
      confidence: 0.70,
      locator: { type: 'catalog_field', key: 'price' },
    });
  }

  return {
    itemId,
    raw: it,
    normalized,
    evidence,
  };
}),
    };

  const { compressed_bundle, compression_manifest } = compressBundle({
  requestId: matchedBundle.requestId,
  schemaVersion: matchedBundle.schemaVersion,
  engineVersion: 'semanticCompressor@0.1.0',
  matchedBundle,
});    
const ok = validateManifest(compression_manifest);
if (!ok) {
  return res.status(500).json({
    error: "manifest_contract_violation",
    message: "compression_manifest does not match v1 schema",
    details: validateManifest.errors || [],
  });
}
   res.json({ items: scored, compressed_bundle, compression_manifest });
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
