// backend/lib/parsers/shopifyParser.js
module.exports = {
  parse($, url, { limit = 50 } = {}) {
    const out = [];
    const cards = $('[class*="product-card"], [class*="ProductItem"], .grid-product, .product-item');
    cards.each((_, el) => {
      const $el = $(el);
      const a   = $el.find('a').first();
      const title = ($el.find('[class*="product-title"], [class*="ProductItem__Title"]').text() || a.attr('title') || a.text() || '').trim();
      const link  = new URL(a.attr('href') || '', url).toString();
      const imgEl = $el.find('img').first();
      const img   = new URL(imgEl.attr('data-src') || imgEl.attr('src') || '', url).toString();
      const price = ($el.find('[class*="price"], [class*="Price"]').text() || '').replace(/\s+/g, ' ').trim();
      if (title && link) out.push({ title, url: link, img, imgs: img ? [img] : [], price, sku: '', desc: '' });
    });
    return out.slice(0, limit);
  }
};
