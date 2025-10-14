// backend/adapters/shopware.js
const { load } = require('cheerio');

function pickText($el) {
  return ($el.text() || '').replace(/\s+/g, ' ').trim();
}

function abs(base, href) {
  try {
    const u = new URL(href, base);
    return u.toString();
  } catch {
    return href || '';
  }
}

function readPrice($, node) {
  // Shopware 常见价位 DOM：.product-price, .price--default, .product-price-info
  const txt =
    pickText($(node).find('.product-price, .price--default, .product-price-info, [itemprop="price"]'))
    || pickText($(node).find('.product-info .price, .price'));
  // 简单提取数字和逗号/点
  const m = txt.match(/(\d+[.,]\d{2})/);
  return m ? m[1].replace(',', '.') : '';
}

function parseCards($, url) {
  const list = [];
  // Shopware 5/6 常见卡片容器
  const cards = $('.product--box, .product-box, .product-teaser, .product-card, [data-product-id]');
  if (!cards.length) return list;

  cards.each((_, el) => {
    const $el = $(el);
    const a = $el.find('a').first();
    const title =
      pickText($el.find('.product--title, .product-title, .product-name, [itemprop="name"]'))
      || pickText(a);
    const link = abs(url, a.attr('href') || '');
    // 图片选择尽量覆盖：data-src, srcset, src
    const imgEl = $el.find('img').first();
    const img =
      abs(url, imgEl.attr('data-src') || imgEl.attr('data-original') || (imgEl.attr('srcset') || '').split(' ').shift() || imgEl.attr('src') || '');

    const price = readPrice($, $el);

    if (title && link) {
      list.push({
        sku: '',
        title,
        url: link,
        img,
        imgs: img ? [img] : [],
        price,
        currency: '',
        moq: '',
        desc: ''
      });
    }
  });

  return list;
}

module.exports = {
  /**
   * 仅解析“目录/分类页”。（详情页扩展可以后续补）
   */
  parse($, url, { limit = 50 } = {}) {
    const products = parseCards($, url).slice(0, limit);
    return { items: products };
  },

  /**
   * 粗略判断：路径/参数中出现 shopware 常见特征时优先命中
   */
  test(url) {
    try {
      const u = new URL(url);
      const p = (u.pathname || '').toLowerCase();
      const qs = (u.search || '').toLowerCase();
      if (/\bshopware\b/.test(u.hostname)) return true;
      if (p.includes('/kategorie') || p.includes('/kategorien') || p.includes('/listing')) return true;
      if (/[?&](scategory|spage|sviewport)=/.test(qs)) return true;
      return false;
    } catch {
      return false;
    }
  },
};
