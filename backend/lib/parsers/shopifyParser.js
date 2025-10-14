// backend/lib/parsers/shopifyParser.js

function pick($, el) { return ($(el).text() || '').replace(/\s+/g, ' ').trim(); }
function abs(base, href) { try { return new URL(href, base).toString(); } catch { return href || ''; } }
function readPrice($, node) {
  const txt = pick($, $(node).find('[class*="price"], [data-price], [itemprop="price"]'));
  const m = txt.match(/(\d+[.,]\d{2})/);
  return m ? m[1].replace(',', '.') : '';
}

function parse($, url, { limit = 50 } = {}) {
  const out = [];
  // 尽量覆盖常见 Shopify 主题
  const cards = $(
    '[class*="product-card"], [class*="ProductItem"], .grid-product, .product-item'
  );

  cards.each((_, el) => {
    const $el = $(el);
    const a = $el.find('a').first();

    const title =
      pick($, $el.find('[class*="product-title"], [class*="ProductItem__Title"]')) ||
      pick($, a);

    const link = abs(url, a.attr('href') || '');

    const imgEl = $el.find('img').first();
    const img =
      abs(url, imgEl.attr('data-src')) ||
      abs(url, (imgEl.attr('srcset') || '').split(' ').shift()) ||
      abs(url, imgEl.attr('src') || '');

    const price = readPrice($, $el);

    if (title && link) {
      out.push({
        title,
        url: link,
        link,
        img,
        imgs: img ? [img] : [],
        price,
        sku: '',
        desc: ''
      });
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
