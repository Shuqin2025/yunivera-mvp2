// backend/lib/parsers/magentoParser.js

function pick($, el) { return ($(el).text() || '').replace(/\s+/g, ' ').trim(); }
function abs(base, href) { try { return new URL(href, base).toString(); } catch { return href || ''; } }
function readPrice($, node) {
  const txt =
    pick($, $(node).find('.price .price, .price, [data-price-amount], [itemprop="price"]')) ||
    ($(node).find('[data-price-amount]').attr('data-price-amount') || '');
  const m = (txt + '').match(/(\d+[.,]\d{2})/);
  return m ? m[1].replace(',', '.') : (txt || '');
}

function parse($, url, { limit = 50 } = {}) {
  const out = [];
  const cards = $('.product-item, .item.product.product-item');

  cards.each((_, el) => {
    const $el = $(el);
    const a = $el.find('a.product-item-link, a').first();

    const title =
      pick($, $el.find('.product-item-link, .product-item-name')) ||
      pick($, a);

    const link = abs(url, a.attr('href') || '');

    const imgEl = $el.find('img').first();
    const img =
      abs(url, imgEl.attr('data-src')) ||
      abs(url, (imgEl.attr('srcset') || '').split(' ').shift()) ||
      abs(url, imgEl.attr('src') || '');

    const price =
      $el.find('[data-price-amount]').attr('data-price-amount') ||
      readPrice($, $el);

    if (title && link) {
      out.push({
        title,
        url: link,
        link,
        img,
        imgs: img ? [img] : [],
        price: (price + '').replace(',', '.'),
        sku: '',
        desc: ''
      });
    }
  });

  return out.slice(0, limit);
}

const api = {
  id: 'magento',
  test: (_$, url) => /magento|\/catalog\//i.test(url),
  parse
};

module.exports = api;
module.exports.default = api;

