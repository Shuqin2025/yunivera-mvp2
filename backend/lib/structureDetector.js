// backend/lib/structureDetector.js
// 改进站点结构检测（优先命中四大系统，避免落回 generic-links）
// 兼容：CommonJS require 与 ESM default；返回同时包含 adapter 与 type 两个字段。

const cheerio = require('cheerio');

function has($, sel) {
  try { return $(sel).length > 0; } catch { return false; }
}

// 过滤明显的导航/页脚链接（防止 generic-links 误把目录页当内容）
function looksLikeNavText(t) {
  const x = (t || '').toLowerCase();
  return [
    'home','kontakt','contact','login','anmelden','impressum','widerruf','agb','datenschutz','privacy',
    'versand','shipping','wishlist','basket','cart','newsletter','blog','help','support'
  ].some(k => x.includes(k));
}

function hasProductGrid($) {
  return has($, 'ul.products li.product, .grid--product, [data-product-id], .product-card, .product-grid, .product--box, .product-box, .products-grid .product-item, .product-items .product-item');
}

function normalize(ret) {
  // 同时返回 adapter 与 type，保证老新代码均可读取
  if (ret && !ret.type && ret.adapter) ret.type = ret.adapter;
  if (ret && !ret.adapter && ret.type) ret.adapter = ret.type;
  return ret;
}

function detect(html, url = '') {
  const $ = cheerio.load(html);
  const htmlStr = typeof $.html === 'function' ? $.html() : String(html);

  // 1) Shopify（脚本/标记/URL 线索）
  if (
    has($, 'meta[name="shopify-digital-wallet"]') ||
    /cdn\.shopify\.com/i.test(htmlStr) ||
    /\/collections\//i.test(url) ||
    /Shopify/i.test(($('script').text() || ''))
  ) {
    return normalize({ adapter: 'shopify', reason: 'shopify markers/url', grid: hasProductGrid($) });
  }

  // 2) WooCommerce（body 类名/常见链接/URL）
  if (
    has($, 'body[class*="woocommerce"]') ||
    has($, 'a.woocommerce-LoopProduct-link, a.woocommerce-LoopProduct__link') ||
    /\/product-category\//i.test(url)
  ) {
    return normalize({ adapter: 'woocommerce', reason: 'woocommerce markers/url', grid: hasProductGrid($) });
  }

  // 3) Magento（mage 资源、价格盒、典型卡）
  if (
    has($, 'script[src*="mage"], script[src*="Magento"], script[type="text/x-magento-init"]') ||
    has($, '[data-role="priceBox"]') ||
    has($, 'div.product-item, .products-grid .product-item, .product-items .product-item')
  ) {
    return normalize({ adapter: 'magento', reason: 'magento markers', grid: hasProductGrid($) });
  }

  // 4) Shopware（5/6 常见标记）
  if (
    has($, '[data-product-id]') ||
    has($, '.product--box, .product-box') ||
    has($, 'meta[name="application-name"][content*="Shopware"]') ||
    has($, '[data-offcanvas], [data-plugin="offcanvas-menu"]')
  ) {
    return normalize({ adapter: 'shopware', reason: 'shopware markers', grid: hasProductGrid($) });
  }

  // 兜底：generic-links，但做降噪（过滤导航/页脚）
  const links = [];
  $('a[href]').each((_, a) => {
    const t = ($(a).text() || '').trim();
    if (t && !looksLikeNavText(t)) {
      links.push({ title: t, href: String($(a).attr('href') || '') });
    }
  });

  return normalize({ adapter: 'generic-links', reason: 'fallback', linksSample: links.slice(0, 10) });
}

module.exports = { detect };
module.exports.default = detect;
