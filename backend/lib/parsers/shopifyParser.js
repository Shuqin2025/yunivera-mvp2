// backend/lib/parsers/shopifyParser.js
// 宽选择器覆盖常见主题（尽量不依赖具体主题类名）
// 保留当前模块导出结构：module.exports = { id, test, parse }

function pickText($, el) { return ($(el).text() || '').replace(/\s+/g, ' ').trim(); }
function abs(base, href) { try { return new URL(href, base).toString(); } catch { return href || ''; } }
function readPrice($, node) {
  const txt = pickText($, $(node).find('[class*="price"], [data-price], [itemprop="price"]'));
  const m = txt.match(/(\d+[.,]\d{2})/);
  return m ? m[1].replace(',', '.') : '';
}
function pickFromSelectors($, el, selList) {
  for (const sel of selList) {
    const t = ($(el).find(sel).first().text() || '').trim();
    if (t) return t;
  }
  return '';
}

function parse($, url, { limit = 50 } = {}) {
  const out = [];
  // 更“宽”的卡片选择器（兼容多主题）
  const cards = $(
    '.product-card, .grid-product, [data-product-id], li.grid__item, .product-item, .collection-grid-item'
  );

  cards.each((_, el) => {
    const $el = $(el);
    // 优先选择真正的产品链接
    const a = $el.find('a[href*="/products/"]').first().length
      ? $el.find('a[href*="/products/"]').first()
      : ($el.find('a[href]').first().length ? $el.find('a[href]').first() : $el.closest('a[href]').first());

    const title =
      pickFromSelectors($, el, [
        '.product-card__title', '[class*="product-title"]', '.grid-product__title',
        '.product-item__title', 'h3', 'h2', '[itemprop="name"]'
      ]) || (a.attr('title') || '').trim() || pickText($, a);

    const link = abs(url, a && a.attr('href') || '');

    const imgEl = $el.find('img').first();
    const img = abs(url,
      imgEl.attr('data-src') || (imgEl.attr('srcset') || '').split(' ').shift() || imgEl.attr('src') || ''
    );

    const price = readPrice($, $el);

    if (title && link) {
      out.push({ title, url: link, link, img, imgs: img ? [img] : [], sku: '', desc: '', price });
    }
  });

  return out.slice(0, limit);
}

const api = {
  id: 'shopify',
  test: (_$, url) => /myshopify\.com|\/collections\//i.test(url),
  parse
};

module.exports = api;
module.exports.default = api;
