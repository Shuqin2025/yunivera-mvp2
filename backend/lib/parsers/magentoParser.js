// backend/lib/parsers/magentoParser.js
// 宽选择器 + 链接反推 + 图片/价格稳妥解析 + 黑名单
// 保持导出结构与其它解析器一致：module.exports = { id, test, parse }

// —— 工具 ——
function pickText($, el) { return ($(el).text() || '').replace(/\s+/g, ' ').trim(); }
function abs(base, href) {
  const s = String(href || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('//')) return 'https:' + s;
  try {
    const b = new URL(base || 'https://localhost');
    if (s.startsWith('/')) return b.origin + s;
    return b.origin + '/' + s.replace(/^\.?\//, '');
  } catch { return s; }
}
function splitSrcset(s) {
  return String(s || '')
    .split(',')
    .map(x => x.trim().split(/\s+/)[0])
    .filter(Boolean);
}
function bestImgFrom($, $root, base) {
  const seen = new Set();
  const push = (u) => { if (u) seen.add(abs(base, u)); };

  const $img = $root.find('img').first();
  if ($img.length) {
    push($img.attr('data-src'));
    splitSrcset($img.attr('data-srcset')).forEach(push);
    splitSrcset($img.attr('srcset')).forEach(push);
    push($img.attr('src'));
  }
  $root.closest('picture').find('source[srcset]').each((_i, el) => {
    splitSrcset(el.attribs?.srcset || '').forEach(push);
  });

  const html = $root.html() || '';
  const re = /https?:\/\/[^"'()\s<>]+?\.(?:jpe?g|png|webp)(?:\?[^"'()\s<>]*)?/ig;
  let m; while ((m = re.exec(html))) push(m[0]);

  const list = [...seen].filter(u => /\.(?:jpe?g|png|webp)(?:$|\?)/i.test(u) && !/loader\.svg/i.test(u));
  if (!list.length) return '';
  const score = (u) => {
    let s = 0;
    const mm = u.match(/(\d{2,4})x(\d{2,4})/);
    if (mm) s += Math.min(parseInt(mm[1],10), parseInt(mm[2],10));
    if (/800x800|700x700|600x600/.test(u)) s += 100;
    if (/\.webp(?:$|\?)/i.test(u)) s += 5;
    return s;
  };
  return list.sort((a,b) => score(b) - score(a))[0];
}
function readPrice($, node) {
  const txt = pickText($, $(node).find(
    '.price .price, [data-price-amount], .price-wrapper .price, ' +
    '[data-price-type], [itemprop="price"], .price-box .price'
  ));
  const m = txt.match(/(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})|(\d+[.,]\d{2})/);
  return m ? (m[1] || m[2] || '').replace(',', '.') : '';
}

function parse($, url, { limit = 50 } = {}) {
  const out = [];

  // —— 更“宽”的商品卡选择器 ——
  const baseCards = $(
    '.products-grid .product-item, .product-items .product-item, li.product.product-item, ' +
    '.product-item, .item.product.product-item'
  );

  // 从常见的产品链接反推容器
  const linkAnchors = $('a.product-item-link[href], a[href*="/product/"]');
  const fromLinks = linkAnchors.closest(
    '.products-grid .product-item, .product-items .product-item, li.product.product-item, .product-item'
  );

  // 合并
  const cards = baseCards.add(fromLinks);

  // 黑名单：避免相关产品/推荐滑块误判
  const BLACK = [
    '.related', '.upsell', '.crosssell', '.cross-selling', '.upselling',
    '.block.related', '.block.upsell', '.block.crosssell',
    '.product-info-main', '.page-layout-1column .column.main .product.info.detailed'
  ].join(', ');

  cards.each((_i, el) => {
    const $el = $(el);
    if ($el.closest(BLACK).length) return; // 跳过黑名单区域

    // —— 链接 ——
    const $a =
      $el.find('a.product-item-link[href], a[href*="/product/"], a[href]').first().length
        ? $el.find('a.product-item-link[href], a[href*="/product/"], a[href]').first()
        : $el.closest('a[href]').first();

    const title =
      ($a.attr('title') || '').trim() ||
      pickText($, $a) ||
      pickText($, $el.find('.product-item-link, .product.name a, .product.name, h2, h3, [itemprop="name"]').first());

    const link = abs(url, $a.attr('href') || '');

    // —— 图片 ——
    const img = bestImgFrom($, $el, url);

    // —— 价格 ——
    const price = readPrice($, $el);

    // —— SKU ——
    const sku =
      ($el.attr('data-sku') || '').trim() ||
      ($el.find('[data-sku]').attr('data-sku') || '').trim() ||
      ($el.find('[data-product-sku]').attr('data-product-sku') || '').trim() || '';

    if (title && link) {
      out.push({
        title,
        url: link,
        link,
        img,
        imgs: img ? [img] : [],
        price,
        sku,
        desc: ''
      });
    }
  });

  return out.slice(0, limit);
}

const api = {
  id: 'magento',
  test: ($, url) => {
    if ($('script[type="text/x-magento-init"]').length) return true;
    if ($('[data-role="priceBox"], .products-grid .product-item, .product-items .product-item').length) return true;
    return /magento/i.test(url);
  },
  parse
};

module.exports = api;
module.exports.default = api;
