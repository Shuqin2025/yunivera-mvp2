const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const excel = require('../lib/modules/excelExporter');

test('excelExporter: 基本导出', async () => {
  const rows = [
    { title: 'A', sku: 'A-1', price: '9,99 €', url: 'https://a', img: 'https://img/a.jpg', desc: 'x' },
    { title: 'B', sku: 'B-2', price: '19,99 €', url: 'https://b', img: 'https://img/b.jpg', desc: 'y' },
  ];
  const out = path.resolve(__dirname, 'tmp.xlsx');
  if (fs.existsSync(out)) fs.unlinkSync(out);
  await excel.toXLSX(rows, out);
  assert.ok(fs.existsSync(out), 'xlsx should be generated');
  const stat = fs.statSync(out);
  assert.ok(stat.size > 1000, 'xlsx should not be empty');
});
