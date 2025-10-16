// backend/lib/structureDetector.js
// 指纹优先 → 规则打分 → generic 兜底（带降噪）+ 目录误判回退
// CommonJS：返回对象包含 adapter 与 type；同时导出 default

const cheerio = require('cheerio');

/* ----------------- 小工具 ----------------- */
function has($, sel) { try { return $(sel).length > 0; } catch { return false; } }
function textAll($, sel) { try { return $(sel).text() || ''; } catch { return ''; } }
function attr($, sel, name) { try { return $(sel).attr(name) || ''; } catch { return ''; } }
function meta($, name) {
  try {
    return (
      $(`meta[name="${name}"]`).attr('content') ||
      $(`meta[property="${name}"]`).attr('content') ||
      ''
    );
  } catch { return ''; }
}
function normalize(ret) {
  if (ret && !ret.type && ret.adapter) ret.type = ret.adapter;
  if (ret && !ret.adapter && ret.type) ret.adapter = ret.type;
  return ret;
}

/* ----------------- 导航/页脚常见词（generic-links 降噪） ----------------- */
function looksLikeNavText(t) {
  const x = String(t || '').toLowerCase();
  return [
    'home','start','kontakt','contact','login','anmelden','register','konto','account','mein konto','my account',
    'logout','cart','warenkorb','basket','wishlist','wunschliste',
    'agb','impressum','datenschutz','privacy','policy','hilfe','support',
    'newsletter','blog','news','service','faq','payment','shipping','versand',
    'returns','widerruf','revocation','cookie','sitemap'
  ].some(k => x.includes(k));
}

/* ----------------- “产品信号”判定 ----------------- */
function hasProductGrid($) {
  return has($, [
    // 通用/四大系统的列表容器
    'ul.products li.product',
    '.products .product',
    '.wc-block-grid__product',
    '.grid--view-items .grid__item',
    '.collection .grid__item',
    '.product-grid',
    '.product-card',
    '.product--box',
    '.product-box',
    '.products-grid .product-item',
    '.product-items .product-item',
    '[data-product-id]'
  ].join(', '));
}

function hasProductLinks($) {
  return has($, [
    // 常见的“进入详情页”的 a 链接
    'a[href*="/product/"]',
    'a[href*="/products/"]',
    'a[href*="/artikel"]',
    'a[href*="/p/"]',
    'a[href*="/dp/"]',          // 兼容类亚马逊路径
    'a.product-link, a.woocommerce-LoopProduct-link, a.woocommerce-LoopProduct__link',
    '.product-title a, .product__title a, .product-item-link'
  ].join(', '));
}

function hasPriceSignals($, htmlStr = '') {
  const sel = [
    '.price', '.product-price', '.amount', '.price-box', '[data-price]', '[data-price-amount]',
    '.woocommerce-Price-amount', '.price__regular', '.price__container', '[itemprop="price"]'
  ].join(', ');
  if (has($, sel)) return true;

  // 兜底：HTML 里是否出现货币符号/ISO 货币
  const s = (htmlStr || '').toLowerCase();
  return /€|eur|￥|¥|\$|usd|gbp|chf|cad|aud/.test(s);
}

function hasAddToCart($) {
  return has($, [
    '[name="add-to-cart"]',
    'button[name="add"], button[name="add-to-cart"]',
    'button.add-to-cart, a.add-to-cart, .add-to-cart',
    'form[action*="cart"], form[action*="add_to_cart"]',
    '.product-form__cart-submit, [data-product="add-to-cart"]'
  ].join(', '));
}

/* ----------------- 快速指纹（四大系统） ----------------- */
function fastFingerprint($, url, htmlStr) {
  const scriptsText = textAll($, 'script');

  // Shopify
  if (
    /shopify/i.test(meta($, 'generator')) ||
    has($, 'meta[name="shopify-digital-wallet"]') ||
    /cdn\.shopify\.com/i.test(htmlStr) ||
    /\/collections\//i.test(url) ||
    /Shopify/i.test(scriptsText) ||
    has($, 'script[data-section-type], script[data-shopify]') ||
    has($, '.product-grid, .collection, .grid--view-items, [data-product-id]')
  ) {
    return normalize({ adapter: 'shopify', reason: 'fast:shopify', confidence: 0.99, signals: ['meta|script|url|container'] });
  }

  // WooCommerce
  if (
    /woocommerce/.test(String(attr($, 'body', 'class'))) ||
    has($, '.woocommerce ul.products li.product, .products .product, .wc-block-grid__product') ||
    /\/product-category\//i.test(url)
  ) {
    return normalize({ adapter: 'woocommerce', reason: 'fast:woocommerce', confidence: 0.99, signals: ['body|container|url'] });
  }

  // Magento
  if (
    /magento/i.test(meta($, 'generator')) ||
    has($, 'script[type="text/x-magento-init"]') ||
    has($, 'script[src*="mage"], script[src*="Magento"]') ||
    has($, '.products-grid .product-item, .product-items .product-item, [data-role="priceBox"]')
  ) {
    return normalize({ adapter: 'magento', reason: 'fast:magento', confidence: 0.99, signals: ['meta|script|grid|priceBox'] });
  }

  // Shopware
  if (
    /shopware/i.test(meta($, 'generator')) ||
    has($, '[data-plugin="offcanvas-menu"], [data-offcanvas]') ||
    has($, '.cms-block-product-listing, .cms-element-product-listing, .product--box, .product-box, [data-product-id]')
  ) {
    return normalize({ adapter: 'shopware', reason: 'fast:shopware', confidence: 0.99, signals: ['meta|offcanvas|listing'] });
  }

  return null;
}

/* ----------------- 规则打分（未命中指纹时） ----------------- */
const RULES = [
  {
    type: 'shopify',
    hints: [/cdn\.shopify\.com/i, /shopify-section/i, /window\.Shopify/i, /Shopify\.theme/i, /\/products\.json/i],
    dom: ['.product-grid', '.collection', '.grid--view-items .grid__item', '[data-product-id]', 'script[data-shopify]']
  },
  {
    type: 'woocommerce',
    hints: [/woocommerce/i, /wp-content\/plugins\/woocommerce/i, /wc\-block/i],
    dom: ['.woocommerce ul.products li.product', '.products .product', '.wc-block-grid__product', 'a.woocommerce-LoopProduct-link, a.woocommerce-LoopProduct__link']
  },
  {
    type: 'magento',
    hints: [/Magento/i, /mage\/requirejs|mage\/storage/i, /text\/x-magento-init/i],
    dom: ['.products-grid .product-item', '.product-items .product-item', '[data-role="priceBox"]']
  },
  {
    type: 'shopware',
    hints: [/shopware/i, /themes\/Frontend|bundles\/storefront/i],
    dom: ['.product--box', '.product-box', '.cms-block-product-listing .product-box', '[data-product-id]', '[data-plugin="offcanvas-menu"], [data-offcanvas]']
  }
];

function scoreByRules($, htmlStr) {
  let best = { type: 'generic-links', score: 0, signals: [] };

  for (const rule of RULES) {
    let score = 0;
    const sig = [];

    for (const re of rule.hints || []) {
      if (re.test(htmlStr)) { score += 1; sig.push(`hint:${String(re).slice(1,18)}`); }
    }
    for (const sel of rule.dom || []) {
      if (has($, sel)) { score += 1; sig.push(`dom:${sel.split(' ')[0]}`); }
    }

    if (score > best.score) {
      best = { type: rule.type, score, signals: sig };
    }
  }

  if (best.score > 0) {
    const max = Math.max(...RULES.map(r => (r.hints?.length || 0) + (r.dom?.length || 0))) || 8;
    const confidence = Math.min(0.98, best.score / max + 0.1);
    return normalize({ adapter: best.type, reason: 'rulescore', confidence, signals: best.signals });
  }
  return null;
}

/* ----------------- generic-links 兜底 + 降噪 ----------------- */
function fallbackGeneric($) {
  const links = [];
  $('a[href]').each((_, a) => {
    const t = String($(a).text() || '').trim();
    if (t && !looksLikeNavText(t)) {
      links.push({ title: t, href: String($(a).attr('href') || '') });
    }
  });
  return normalize({ adapter: 'generic-links', reason: 'fallback', linksSample: links.slice(0, 12) });
}

/* ----------------- 主函数：detect(html, url) ----------------- */
function detect(html, url = '') {
  const $ = cheerio.load(html);
  const htmlStr = (typeof $.html === 'function' ? $.html() : String(html)) || '';

  // 1) 指纹优先
  let ret = fastFingerprint($, url, htmlStr);
  if (!ret) {
    // 2) 规则打分
    ret = scoreByRules($, htmlStr);
  }

  // 3) 若都没有 → generic 兜底
  if (!ret) {
    return fallbackGeneric($);
  }

  // 4) “目录误判回退”：命中四大系统但页面没有任何“产品信号”（网格/价格/加车/产品链接）
  const isBig4 = /^(shopify|woocommerce|magento|shopware)$/i.test(ret.adapter);
  const grid = hasProductGrid($);
  const price = hasPriceSignals($, htmlStr);
  const cart  = hasAddToCart($);
  const prodL = hasProductLinks($);

  if (isBig4 && !(grid || price || cart || prodL)) {
    const fb = fallbackGeneric($);
    fb.reason = 'demoted:no-product-signals';
    fb.signals = ['grid:false', 'price:false', 'cart:false', 'plink:false', ...(ret.signals || [])];
    return fb;
  }

  // 5) 返回并附带“产品信号”作为诊断信息
  ret.grid = grid;
  ret.signals = Array.from(new Set([...(ret.signals || []),
    `grid:${grid}`, `price:${price}`, `cart:${cart}`, `plink:${prodL}`
  ]));
  return normalize(ret);
}

module.exports = { detect };
module.exports.default = detect;
