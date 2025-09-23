// backend/adapters/sinotronic.js
// 适配 sinotronic-e.com 的目录页，带多种备用选择器与懒加载图片处理
const { URL } = require('url');

function abs(base, href) {
  try { return new URL(href || '', base).toString(); } catch { return href || ''; }
}

function pickImg($img) {
  if (!$img || !$img.length) return '';
  const attrs = ['src', 'data-src', 'data-original', 'data-echo', 'data-lazy', 'data-img', 'data-url'];
  for (const a of attrs) {
    const v = ($img.attr(a) || '').trim();
    if (v) return v;
  }
  // 兼容 style="background-image:url(...)"
  const m = ($img.attr('style') || '').match(/url\((.*?)\)/i);
  return m && m[1] ? m[1].replace(/['"]/g, '') : '';
}

module.exports = function parseSinotronic($, ctx) {
  const out = [];
  const limit = Number(ctx.limit || 50);
  const base = ctx.url;

  // ① 主选择器：常见产品列表 li / item 卡片
  const main = $(
    [
      'ul li:has(a)',            // 通用 ul>li
      '.list li:has(a)',
      '.prolist li:has(a)',
      '.products li:has(a)',
      '.product-list li:has(a)',
      '.goods-list li:has(a)',
      '.grid li:has(a)',
      'div.product',             // 常见卡片
      'div.goods',
      '.product-item',
      '.goods-item'
    ].join(',')
  );

  main.each((_, el) => {
    if (out.length >= limit) return false;
    const $el = $(el);
    const $a = $el.find('a[href]').first();
    const href = abs(base, $a.attr('href'));
    if (!href) return;

    const $img = $el.find('img').first();
    let title =
      ($img.attr('alt') || $a.attr('title') || $a.text() || '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!title) return;

    const img = abs(base, pickImg($img));

    out.push({
      sku: title,
      title,
      url: href,
      img,
      price: '',
      currency: '',
      moq: ''
    });
  });

  // ② 兜底：整页所有 a[href]（过滤掉 # / javascript:）
  if (out.length === 0) {
    $('a[href]').each((_, a) => {
      if (out.length >= limit) return false;
      const $a = $(a);
      const href = ($a.attr('href') || '').trim();
      if (!href || /^(javascript:|#)/i.test(href)) return;

      const text = ($a.text() || '').replace(/\s+/g, ' ').trim();
      if (!text) return;

      const img = abs(base, pickImg($a.find('img').first()));

      out.push({
        sku: text,
        title: text,
        url: abs(base, href),
        img,
        price: '',
        currency: '',
        moq: ''
      });
    });
  }

  return out;
};
