// backend/lib/parsers/shopifyParser.js
const { load } = require('cheerio');

function pick($el) {
  return ($el.text() || '').replace(/\s+/g, ' ').trim();
}
function abs(base, href) {
  try { return new URL(href, base).toString(); } catch { return href || ''; }
}
function firstAttr(el, keys) {
  for (const k of keys) {
    const v = el.attr(k);
    if (v) return v;
  }
  return '';
}
function readPrice(raw) {
  if (!raw) return '';
  const m = String(raw).match(/([\d.,]+)\s*(€|eur|€)/i);
  return m ? m[1].replace('.', '').replace(',', '.') : '';
}

module.exports = {
  /**
   * @param {CheerioAPI} $
   * @param {string} url
   * @param {{limit?:number}} opts
   */
  parse($, url, { limit = 50 } = {}) {
    const out = [];

    // 常见集合容器（不同主题）
    const containers = [
      '.collection, .collection__products, .collection-grid, .grid--collection',
      '.product-grid, .grid, [data-products], [data-section-type*="collection"]',
      '.template-collection, #Collection, main [role="main"]'
    ];

    let cards = $();
    for (const sel of containers) {
      const found = $(sel);
      if (found.length) { cards = found; break; }
    }
    if (!cards.length) cards = $('*'); // 容错：在全局里找卡片

    // 每张商品卡（购物主题差异极大，做多套选择器）
    const productEls = cards.find([
      '.product-card, .product-grid__item, .grid__item',
      'li.grid__item, li.product, article, .card--product',
      '[data-product-id], [data-product-handle]'
    ].join(','));

    productEls.each((_, node) => {
      const el = $(node);
      const a = el.find('a[href*="/products/"]').first();
      const link = abs(url, a.attr('href') || '');

      const title =
        pick(el.find('.product-card__title').first()) ||
        pick(el.find('.card__heading, .product-title, .full-unstyled-link').first()) ||
        pick(a) ||
        '';

      // 懒加载图片兜底
      const imgEl = el.find('img').first();
      const img =
        firstAttr(imgEl, ['data-src', 'data-original', 'data-lazy-src', 'data-srcset', 'srcset', 'src'])
          .split(' ')
          .shift() || '';

      const priceRaw =
        pick(el.find('.price-item--regular, .price__regular .price-item').first()) ||
        pick(el.find('.price, .product-card__price, [class*="price"]').first()) ||
        '';
      const price = readPrice(priceRaw);

      if (title && link) {
        out.push({
          title,
          url: link,
          img: img ? abs(url, img) : '',
          imgs: img ? [abs(url, img)] : [],
          price,
          sku: '',
          desc: ''
        });
      }
    });

    return out.slice(0, limit);
  }
};
