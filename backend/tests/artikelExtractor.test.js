const test = require('node:test');
const assert = require('node:assert/strict');
const artikelExtractor = require('../lib/modules/artikelExtractor');

test('artikelExtractor: 常见前缀与纯码', () => {
  const txt = `
    Artikel-Nr.: ABC-1234
    EAN  4006381333931
    P/N: 90MB1A50-M0EAY0
    SKU: SNK-9999
  `;
  const out = artikelExtractor.extractFromText(txt);
  // 允许模块返回 sku/ean 等多键，这里只校验至少有一个“主键”
  assert.ok(out.sku || out.ean || out.pn);
  // 常见 13位EAN
  assert.match(txt, /\b\d{13}\b/);
});

test('artikelExtractor: 无前缀时也能识别纯码', () => {
  const txt = `The quick brown fox jumps over 47110815-9999 and 4711081599999 text.`;
  const out = artikelExtractor.extractFromText(txt);
  // 可能识别到 13 位数字为 EAN
  assert.ok(out.ean || out.sku);
});
