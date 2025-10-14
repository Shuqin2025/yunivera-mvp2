// backend/lib/parsers/woocommerceParser.js
module.exports = {
  parse($, url, { limit = 50 } = {}) {
    const out = [];
    const cards = $('.products .product, .woocommerce ul.products li.product, [class*="product-card"]');
    cards.each((_, el) => {
      const $el = $(el);
      const a   = $el.find('a.woocommerce-LoopProduct-link, a.woocommerce-LoopProduct__link, a').first();
      const title = ($el.find('.woocommerce-loop-product__title, .product-title').text() || a.attr('title') || a.text() || '').trim();
      const link  = new URL(a.attr('href') || '', url).toString();
      const imgEl = $el.find('img').first();
      const img   = new URL(imgEl.attr('data-src') || imgEl.attr('src') || '', url).toString();
      const price = ($el.find('.price').text() || '').replace(/\s+/g, ' ').trim();
      if (title && link) out.push({ title, url: link, img, imgs: img ? [img] : [], price, sku: '', desc: '' });
    });
    return out.slice(0, limit);
  }
};
