// backend/lib/parsers/shopwareParser.js
// 宽选择器覆盖常见主题（尽量不依赖具体主题类名）
// 保留与其它解析器一致的导出结构：module.exports = { id, test, parse }

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
    push($img.attr('data-fallbacksrc'));
    splitSrcset($img.attr('srcset')).forEach(push);
    push($img.attr('src'));
  }
  $root.closest('picture').find('source[srcset]').each((_i, el) => {
    splitSrcset(el.attribs?.srcset || '').forEach(push);
  });

  // 兜底：从节点 HTML 里扒出图片 URL
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
  const txt =
    pickText($, $(node).find('.price--default, .product--price, .product-price, .product-price-info, [itemprop="price"]')) ||
    pickText($, $(node).find('.product--info .price, .price')) || '';
  const m = txt.match(/(\d{1,3}(?:[.,]\d{2}))/);
  return m ? m[1].replace(',', '.') : '';
}

function parse($, url, { limit = 50 } = {}) {
  const out = [];

  // —— 更“宽”的卡片选择器（Shopware 5/6 兼容）——
  const baseCards = $(
    '[data-product-id], .product--box, .product-box, .product-card, ' +
    '.cms-block-product-listing .product-box, .cms-element-product-listing .product-box'
  );

  // 由常见详情链接反推商品容器
  const linkAnchors = $(
    'a[href*="/detail"], a[href*="/produkt"], a[href*="/product"], ' +
    'a.product--image, a.product-image, a.product-title'
  );
  const fromLinks = linkAnchors.closest('[data-product-id], .product--box, .product-box, .product-card');

  const cards = baseCards.add(fromLinks);

  // 黑名单：避免详情页的 cross-selling/related 等滑块误判为列表
  const BLACK = [
    '.product--detail', '.product--details', '#detail',
    '.cross-selling', '.crossselling', '.related', '.related--products',
    '.similar--products', '.upselling', '.accessories', '.accessory--slider',
    '.product-slider--container', '.product--slider', '.is--ctl-detail',
  ].join(', ');

  cards.each((_i, el) => {
    const $el = $(el);
    if ($el.closest(BLACK).length) return; // 跳过黑名单区域

    // —— 选择有效链接 ——
    const $a = $el.find('a[href]').first();
    const title =
      pickText($, $el.find('.product--title, .product--info a, .product--name, [itemprop="name"], .product-box__title, .product-title, .product-name').first()) ||
      ($a.attr('title') || '').trim() ||
      pickText($, $a);
    const href =
      $el.attr('data-url') || $el.attr('data-link') || $el.attr('data-href') ||
      $a.attr('href') || '';
    const link = abs(url, href);

    // —— 图片 ——
    const img = bestImgFrom($, $el, url);

    // —— 价格 ——
    const price = readPrice($, $el);

    // —— SKU（Shopware 常有 data-ordernumber/data-sku） ——
    const sku =
      ($el.attr('data-ordernumber') || '').trim() ||
      ($el.find('[data-ordernumber]').attr('data-ordernumber') || '').trim() ||
      ($el.find('[data-sku]').attr('data-sku') || '').trim() || '';

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
  id: 'shopware',
  test: ($, url) => {
    try {
      const metaApp = ($('meta[name="application-name"]').attr('content') || '').toLowerCase();
      if (metaApp.includes('shopware')) return true;
    } catch {}
    if ($('[data-product-id], .product--box, .product-box').length > 0) return true;
    return /shopware/i.test(url);
  },
  parse
};

module.exports = api;
module.exports.default = api;
