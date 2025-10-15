3.3 Magento

backend/lib/parsers/magentoParser.js

module.exports = {
  parse($, url, { limit = 50 } = {}) {
    const out = [];
    const cards = $('.products-grid .product-item, .product-items .product-item, li.product.product-item');
    cards.each((_, el) => {
      const $el = $(el);
      const a = $el.find('a.product-item-link, a[href]').first();
      const title = (a.attr('title') || a.text() || '').replace(/\s+/g,' ').trim();
      const link = new URL(a.attr('href') || '', url).toString();
      const imgEl = $el.find('img').first();
      const img = new URL(imgEl.attr('data-src') || imgEl.attr('src') || '', url).toString();
      const price =
        $el.find('.price .price, [data-price-amount], .price-wrapper .price').first().text().toString().trim();
      if (title && link) out.push({ title, url: link, img, imgs: img ? [img] : [], price, sku: '', desc: '' });
    });
    return out.slice(0, limit);
  }
};
