// backend/lib/parsers/woocommerceParser.js
// 宽选择器覆盖常见主题（尽量不依赖具体主题类名）
// 保留当前模块导出结构：module.exports = { id, test, parse }

// —— 小工具 ——
function pickText($, el) { return ($(el).text() || '').replace(/\s+/g, ' ').trim(); }
function abs(base, href) { try { return new URL(href, base).toString(); } catch { return href || ''; } }
function readPrice($, node) {
  const txt = pickText($, $(node).find('.price, .amount, [itemprop="price"], .wc-block-grid__product-price'));
  const m = txt.match(/(\d+[.,]\d{2})/);
  return m ? m[1].replace(',', '.') : '';
}

function parse($, url, { limit = 50 } = {}) {
  const out = [];

  // 更“宽”的卡片选择器（兼容经典与 Block 版式；也兼容由链接反推的 product 容器）
  const baseCards = $(
    'ul.products li.product, ' +           // 经典 UL 列表
    '.products .product, ' +               // 通用 products 容器
    '.wc-block-grid__product, ' +          // Block Grid
    '[class*="product-card"]'              // 一些主题的卡片类
  );

  // 同时把“链接本身”作为起点再回溯到 product 容器，避免漏抓
  const linkAnchors = $('a.woocommerce-LoopProduct-link, a.woocommerce-LoopProduct__link, a[href*="/product/"]');
  const fromLinks = linkAnchors.closest('li.product, .product, .wc-block-grid__product');

  const cards = baseCards.add(fromLinks);

  cards.each((_, el) => {
    const $el = $(el);

    // —— 选择有效的商品链接 ——
    const a =
      $el.find('a.woocommerce-LoopProduct-link[href], a.woocommerce-LoopProduct__link[href], a[href*="/product/"], a[href]').first().length
        ? $el.find('a.woocommerce-LoopProduct-link[href], a.woocommerce-LoopProduct__link[href], a[href*="/product/"], a[href]').first()
        : $el.closest('a[href]').first();

    const title =
      pickText($, $el.find('.woocommerce-loop-product__title, .product-title, .wc-block-grid__product-title, h2, h3, [itemprop="name"]').first()) ||
      (a.attr('title') || '').trim() ||
      pickText($, a);

    const link = abs(url, a.attr('href') || '');

    // —— 图片：data-src > data-srcset/srcset 首地址 > src ——
    const imgEl = $el.find('img').first();
    const srcset = (imgEl.attr('data-srcset') || imgEl.attr('srcset') || '').split(',')[0] || '';
    const firstSrcsetUrl = srcset.split(' ').shift();
    const img =
      abs(url, imgEl.attr('data-src')) ||
      abs(url, firstSrcsetUrl || '') ||
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
