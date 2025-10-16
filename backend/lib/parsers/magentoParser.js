// backend/lib/parsers/magentoParser.js
// 宽选择器 + 链接反推 + 图片/价格稳妥解析 + 黑名单
// 导出结构保持与其它解析器一致：module.exports = { id, test, parse }

function pickText($, el) {
  return ($(el).text() || '').replace(/\s+/g, ' ').trim();
}
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

  // 1) 卡片内第一张图 + 常见懒加载
  const $img = $root.find('img').first();
  if ($img.length) {
    push($img.attr('data-src'));
    push($img.attr('data-original'));
    push($img.attr('data-lazy'));
    push($img.attr('data-image'));
    push($img.attr('src'));
    splitSrcset($img.attr('data-srcset')).forEach(push);
    splitSrcset($img.attr('srcset')).forEach(push);

    // 2) 若该 img 在 <picture> 中，顺带收集 source[srcset]
    const $pic = $img.closest('picture');
    if ($pic.length) {
      $pic.find('source[srcset]').each((_i, el) => {
        splitSrcset(el.attribs?.srcset || '').forEach(push);
      });
    }
  }

  // 3) <noscript> 内常见兜底图
  $root.find('noscript').each((_i, el) => {
    const html = $(el).html() || '';
    const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (m) push(m[1]);
  });

  // 4) HTML 中的直链兜底
  const html = $root.html() || '';
  const re = /https?:\/\/[^"'()\s<>]+?\.(?:jpe?g|png|webp)(?:\?[^"'()\s<>]*)?/ig;
  let m; while ((m = re.exec(html))) push(m[0]);

  // 5) 过滤 & 简单评分
  const list = [...seen].filter(u =>
    /\.(?:jpe?g|png|webp)(?:$|\?)/i.test(u) && !/loader\.svg/i.test(u)
  );
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
  // 先从常见展示节点读文本
  const txt = pickText($, $(node).find(
    '.price .price, .price-wrapper .price, ' +
    '[itemprop="price"], .price-box .price, [data-price-type]'
  ));
  let out = '';
  const m = txt.match(/(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})|(\d+[.,]\d{2})/);
  if (m) out = (m[1] || m[2] || '').replace(',', '.');

  // 兜底：直接读 data-price-amount / data-price-final
  if (!out) {
    const cand = $(node).find('[data-price-amount],[data-price-final],[data-price]').first();
    const v = cand.attr('data-price-amount') || cand.attr('data-price-final') || cand.attr('data-price');
    if (v && /^\d+(\.\d+)?$/.test(v)) out = v;
  }
  return out;
}

function parse($, url, { limit = 50 } = {}) {
  const out = [];

  // 更宽的卡片选择器（覆盖大多数 Magento 主题）
  const baseCards = $(
    '.products-grid .product-item, .product-items .product-item, li.product.product-item,' +
    ' .product-item, .item.product.product-item, .product-item-info, li.product'
  );

  // 从典型产品链接反推容器
  const linkAnchors = $('a.product-item-link[href], a[href*="/product/"]');
  const fromLinks = linkAnchors.closest(
    '.products-grid .product-item, .product-items .product-item, li.product.product-item,' +
    ' .product-item, .product-item-info, li.product'
  );

  const cards = baseCards.add(fromLinks);

  // 黑名单：相关/推荐滑块、详情页主信息区等
  const BLACK = [
    '.related', '.upsell', '.crosssell', '.cross-selling', '.upselling',
    '.block.related', '.block.upsell', '.block.crosssell',
    '.product-info-main', '.page-layout-1column .column.main .product.info.detailed'
  ].join(', ');

  cards.each((_i, el) => {
    const $el = $(el);
    if ($el.closest(BLACK).length) return;

    // 链接
    const $a = ($el.find('a.product-item-link[href], a[href*="/product/"], a[href]').first().length
      ? $el.find('a.product-item-link[href], a[href*="/product/"], a[href]').first()
      : $el.closest('a[href]').first());

    const title =
      ($a.attr('title') || '').trim() ||
      pickText($, $a) ||
      pickText($, $el.find('.product-item-link, .product.name a, .product.name, h2, h3, [itemprop="name"]').first());

    const link = abs(url, $a.attr('href') || '');

    // 图片
    const img = bestImgFrom($, $el, url);

    // 价格
    const price = readPrice($, $el);

    // SKU（目录页偶尔存在）
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
    if ($('[data-role="priceBox"], .products-grid .product-item, .product-items .product-item, .product-item-info').length) return true;
    return /magento/i.test(url);
  },
  parse
};

module.exports = api;
module.exports.default = api;
