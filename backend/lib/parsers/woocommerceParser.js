// backend/lib/parsers/woocommerceParser.js

// 说明：接收由 templateParser 传入的 $（同一份 Cheerio 实例）与 url
// 统一输出：[{ title, url, link, img, imgs:[], price, sku:'', desc:'' }]
function pick($, el) {
  return ($(el).text() || '').replace(/\s+/g, ' ').trim();
}
function abs(base, href) {
  try { return new URL(href, base).toString(); } catch { return href || ''; }
}
function readPrice($, node) {
  const txt = pick($, $(node).find('.price, .amount, [itemprop="price"], .wc-block-grid__product-price'));
  const m = txt.match(/(\d+[.,]\d{2})/);
  return m ? m[1].replace(',', '.') : '';
}

function parse($, url, { limit = 50 } = {}) {
  const out = [];
  // 兼容多种常见 WooCommerce 列表结构
  const cards = $(
  '.products .product, ' +
  '.woocommerce ul.products li.product, ' +
  '.wc-block-grid__product, ' +
  '[class*="product-card"]'
);

  cards.each((_, el) => {
    const $el = $(el);
    const a = ($el.find('a.woocommerce-LoopProduct-link[href], a.woocommerce-LoopProduct__link[href], a[href]')[0]
  ? $el.find('a.woocommerce-LoopProduct-link[href], a.woocommerce-LoopProduct__link[href], a[href]').first()
  : $el.closest('a[href]').first());

    const title =
      pick($, $el.find('.woocommerce-loop-product__title, .product-title, .wc-block-grid__product-title')) ||
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
  id: 'woocommerce',
  test: (_$, url) => /woocommerce|\/product-category\//i.test(url),
  parse
};

module.exports = api;
module.exports.default = api;

  
