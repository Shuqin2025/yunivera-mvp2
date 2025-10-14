// backend/lib/templateParser.js
const { load } = require('cheerio');
const detect = require('./structureDetector');

// 模板解析器
const shopware = require('./parsers/shopwareParser');
const woo      = require('./parsers/woocommerceParser');
const magento  = require('./parsers/magentoParser');
const shopify  = require('./parsers/shopifyParser');

// 兜底：只抓可见商品卡上的标题、链接（极简）
function fallbackParse($, url, limit = 50) {
  const items = [];
  $('a, .product, .card').each((_, el) => {
    const a = $(el).is('a') ? $(el) : $(el).find('a').first();
    const title = (a.attr('title') || a.text() || '').replace(/\s+/g, ' ').trim();
    const href = a.attr('href') || '';
    if (title && href) {
      try {
        const abs = new URL(href, url).toString();
        items.push({ name: title, model: '', sku: '', price: '', image: '', description: '', link: abs });
      } catch {}
    }
  });
  return items.slice(0, limit);
}

const map = {
  Shopware:   shopware,
  WooCommerce: woo,
  Magento:    magento,
  Shopify:    shopify,
};

function toUnified(items = []) {
  // 统一字段：name, model, sku, price, image, description, link
  return items.map(it => ({
    name: it.title || it.name || '',
    model: it.model || '',
    sku: it.sku || '',
    price: it.price || '',
    image: (it.imgs && it.imgs[0]) || it.img || '',
    description: it.desc || it.description || '',
    link: it.url || it.link || '',
  }));
}

/**
 * @param {string} html
 * @param {string} url
 * @param {{limit?:number, typeHint?:string}} opts
 */
async function parse(html, url, opts = {}) {
  const { limit = 50, typeHint = '' } = opts;
  const $ = load(html);
  let type = '';

  // 优先用前端 hint（t）或者你们的 detect 结果
  if (typeHint) {
    type = typeHint;
  } else {
    try {
      const d = await detect.detectStructure(url, html); // 你们已有的方法；若不同名请替换
      type = d && (d.type || d.name || '');
    } catch {}
  }

  // 统一成 map 的 key
  const norm = (type || '').toLowerCase();
  let key = '';
  if (norm.includes('shopware')) key = 'Shopware';
  else if (norm.includes('woo')) key = 'WooCommerce';
  else if (norm.includes('magento')) key = 'Magento';
  else if (norm.includes('shopify')) key = 'Shopify';

  let items = [];
  if (key && map[key]) {
    try {
      items = await map[key].parse($, url, { limit });
    } catch (e) {
      // 失败就走兜底
      items = fallbackParse($, url, limit);
    }
  } else {
    items = fallbackParse($, url, limit);
  }

  return toUnified(items);
}

module.exports = { parse };
