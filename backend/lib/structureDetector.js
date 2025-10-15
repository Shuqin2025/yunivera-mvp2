// backend/lib/structureDetector.js
// 指纹优先 + 规则打分次优 + generic 兜底（带降噪）
// CommonJS 版本，向下兼容：返回对象同时包含 adapter 与 type 字段；同时导出 default。

const cheerio = require('cheerio');

// —— 小工具 ——
function has($, sel) { try { return $(sel).length > 0; } catch { return false; } }
function meta($, name) {
  try {
    return (
      $(`meta[name="${name}"]`).attr('content') ||
      $(`meta[property="${name}"]`).attr('content') ||
      ''
    );
  } catch { return ''; }
}
function textOf($, sel) { try { return $(sel).text() || ''; } catch { return ''; } }

// 导航/页脚常见词（generic-links 降噪）
function looksLikeNavText(t) {
  const x = String(t || '').toLowerCase();
  return [
    'home','start','kontakt','contact','login','anmelden','register','konto','account','mein konto','my account',
    'logout','cart','warenkorb','basket','wishlist','wunschliste',
    'agb','impressum','datenschutz','privacy','policy','hilfe','support','kontakt',
    'newsletter','blog','news','service','faq','payment','shipping','versand',
    'returns','widerruf','revocation','cookie','sitemap'
  ].some(k => x.includes(k));
}

function hasProductGrid($) {
  return has($, [
    'ul.products li.product',
    '.products .product',
    '.wc-block-grid__product',
    '.grid--view-items .grid__item',
    '.product-grid',
    '.product-card',
    '.product--box',
    '.product-box',
    '.products-grid .product-item',
    '.product-items .product-item',
    '[data-product-id]'
  ].join(', '));
}

function normalize(ret) {
  if (ret && !ret.type && ret.adapter) ret.type = ret.adapter;
  if (ret && !ret.adapter && ret.type) ret.adapter = ret.type;
  return ret;
}

// —— 一级：快速指纹命中（四大系统）——
function fastFingerprint($, url, htmlStr) {
  const scriptAll = textOf($, 'script');

  // Shopify：meta/script/url 指纹
  if (
    /shopify/i.test(meta($, 'generator')) ||
    has($, 'meta[name="shopify-digital-wallet"]') ||
    /cdn\.shopify\.com/i.test(htmlStr) ||
    /\/collections\//i.test(url) ||
    /Shopify/i.test(scriptAll) ||
    has($, 'script[data-section-type], script[data-shopify]') ||
    has($, '.product-grid, .collection, .grid--view-items, [data-product-id]')
  ) {
    return normalize({ adapter: 'shopify', reason: 'fast:shopify', confidence: 0.99, grid: hasProductGrid($), signals: ['meta|script|url|container'] });
  }

  // WooCommerce：body 类、常见容器
  if (
    /woocommerce/.test(String($('body').attr('class') || '')) ||
    has($, '.woocommerce ul.products li.product, .products .product, .wc-block-grid__product') ||
    /\/product-category\//i.test(url)
  ) {
    return normalize({ adapter: 'woocommerce', reason: 'fast:woocommerce', confidence: 0.99, grid: hasProductGrid($), signals: ['body|container|url'] });
  }

  // Magento：meta/script/init、常见栅格
  if (
    /magento/i.test(meta($, 'generator')) ||
    has($, 'script[type="text/x-magento-init"]') ||
    has($, 'script[src*="mage"], script[src*="Magento"]') ||
    has($, '.products-grid .product-item, .product-items .product-item, [data-role="priceBox"]')
  ) {
    return normalize({ adapter: 'magento', reason: 'fast:magento', confidence: 0.99, grid: hasProductGrid($), signals: ['meta|script|grid|priceBox'] });
  }

  // Shopware：meta、offcanvas、典型 listing
  if (
    /shopware/i.test(meta($, 'generator')) ||
    has($, '[data-plugin="offcanvas-menu"], [data-offcanvas]') ||
    has($, '.cms-block-product-listing, .cms-element-product-listing, .product--box, .product-box, [data-product-id]')
  ) {
    return normalize({ adapter: 'shopware', reason: 'fast:shopware', confidence: 0.99, grid: hasProductGrid($), signals: ['meta|offcanvas|listing'] });
  }

  return null;
}

// —— 二级：规则打分（未命中指纹时）——
const RULES = [
  {
    type: 'shopify',
    hints: [
      /cdn\.shopify\.com/i,
      /shopify-section/i,
      /window\.Shopify/i,
      /Shopify\.theme/i,
      /\/products\.json/i
    ],
    dom: [
      '.product-grid',
      '.collection',
      '.grid--view-items .grid__item',
      '[data-product-id]',
      'script[data-shopify]'
    ]
  },
  {
    type: 'woocommerce',
    hints: [
      /woocommerce/i,
      /wp-content\/plugins\/woocommerce/i,
      /wc\-block/i
    ],
    dom: [
      '.woocommerce ul.products li.product',
      '.products .product',
      '.wc-block-grid__product',
      'a.woocommerce-LoopProduct-link, a.woocommerce-LoopProduct__link'
    ]
  },
  {
    type: 'magento',
    hints: [
      /Magento/i,
      /mage\/requirejs|mage\/storage/i,
      /text\/x-magento-init/i
    ],
    dom: [
      '.products-grid .product-item',
      '.product-items .product-item',
      '[data-role="priceBox"]'
    ]
  },
  {
    type: 'shopware',
    hints: [
      /shopware/i,
      /themes\/Frontend|bundles\/storefront/i
    ],
    dom: [
      '.product--box',
      '.product-box',
      '.cms-block-product-listing .product-box',
      '[data-product-id]',
      '[data-plugin="offcanvas-menu"], [data-offcanvas]'
    ]
  }
];

function scoreByRules($, htmlStr) {
  let best = { type: 'generic-links', score: 0, signals: [] };

  for (const rule of RULES) {
    let score = 0;
    const sig = [];

    // hint（正则）命中
    for (const re of rule.hints || []) {
      if (re.test(htmlStr)) { score += 1; sig.push(`hint:${String(re).slice(1,18)}`); }
    }
    // DOM 命中
    for (const sel of rule.dom || []) {
      if (has($, sel)) { score += 1; sig.push(`dom:${sel.split(' ')[0]}`); }
    }

    if (score > best.score) {
      best = { type: rule.type, score, signals: sig };
    }
  }

  if (best.score > 0) {
    const max = Math.max(...RULES.map(r => (r.hints?.length || 0) + (r.dom?.length || 0))) || 8;
    const confidence = Math.min(0.98, best.score / max + 0.1); // 打分命中最高不超过 0.98
    return normalize({ adapter: best.type, reason: 'rulescore', confidence, grid: null, signals: best.signals });
  }
  return null;
}

// —— 三级：generic-links 兜底 + 降噪 ——
function fallbackGeneric($) {
  const links = [];
  $('a[href]').each((_, a) => {
    const t = String($(a).text() || '').trim();
    if (t && !looksLikeNavText(t)) {
      links.push({ title: t, href: String($(a).attr('href') || '') });
    }
  });
  return normalize({ adapter: 'generic-links', reason: 'fallback', linksSample: links.slice(0, 10) });
}

// —— 主函数 ——
function detect(html, url = '') {
  const $ = cheerio.load(html);
  const htmlStr = (typeof $.html === 'function' ? $.html() : String(html)) || '';

  // 1) 指纹优先
  const fastHit = fastFingerprint($, url, htmlStr);
  if (fastHit) { fastHit.grid = fastHit.grid ?? hasProductGrid($); return normalize(fastHit); }

  // 2) 规则打分
  const scored = scoreByRules($, htmlStr);
  if (scored) { scored.grid = hasProductGrid($); return normalize(scored); }

  // 3) generic-links 兜底（降噪）
  return fallbackGeneric($);
}

module.exports = { detect };
module.exports.default = detect;
