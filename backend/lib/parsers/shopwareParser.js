// backend/lib/parsers/shopwareParser.js
const { load } = require('cheerio');

function pick($, el) { return ($(el).text() || '').replace(/\s+/g, ' ').trim(); }
function abs(base, href) { try { return new URL(href, base).toString(); } catch { return href || ''; } }

function readPrice($, node) {
  const txt =
    pick($, $(node).find('.product-price, .price--default, .product-price-info, [itemprop="price"]')) ||
    pick($, $(node).find('.product-info .price, .price'));
  const m = txt.match(/(\d+[.,]\d{2})/);
  return m ? m[1].replace(',', '.') : '';
}

module.exports = {
  parse($, url, { limit = 50 } = {}) {
    const out = [];
    const cards = $('.product--box, .product-box, .product-teaser, .product-card, [data-product-id]');
    cards.each((_, el) => {
      const $el = $(el);
      const a = $el.find('a').first();
      const title = pick($, $el.find('.product--title, .product-title, .product-name, [itemprop="name"]')) || pick($, a);
      const link  = abs(url, a.attr('href') || '');
      const imgEl = $el.find('img').first();
      const img   = abs(url, imgEl.attr('data-src') || imgEl.attr('data-original') || (imgEl.attr('srcset') || '').split(' ').shift() || imgEl.attr('src') || '');
      const price = readPrice($, $el);

      if (title && link) {
        out.push({ title, url: link, img, imgs: img ? [img] : [], price, sku: '', desc: '' });
      }
    });
    return out.slice(0, limit);
  }
};
