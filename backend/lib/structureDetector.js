// backend/lib/structureDetector.js
// 轻量、可解释的页面结构判定：homepage | catalog | product
// - 保守：宁可判为 homepage 也不误判为 catalog/product
// - 可观察：DEBUG=1 时输出完整判定原因，便于线上排障

const { load } = require('cheerio');

const PRICE_TOKENS = [
  'price', 'preise', 'preis', '€', '$', '¥', 'eur', 'usd',
  'inkl. mwst', 'in kl. mwst', 'inkl mwst', 'mwst',
  'ab €', 'from €', 'uvp', 'sale', 'sonderpreis', 'angebot'
];

const CART_TOKENS = [
  'add to cart', 'add-to-cart', 'cart/add', 'buy now',
  'in den warenkorb', 'warenkorb', 'kaufen', 'jetzt kaufen',
  'in den einkaufswagen', 'zum warenkorb', 'checkout'
];

// 明显是站点级/资讯级链接或栏目（非商品）
const GENERIC_LINK_BAD = new RegExp(
  [
    'hilfe','support','kundendienst','faq','service',
    'agb','widerruf','widerrufsbelehrung','rueckgabe','retoure',
    'versand','liefer','shipping','payment','zahlungs',
    'datenschutz','privacy','cookies?',
    'kontakt','contact','impressum','about','ueber\\-?uns',
    'newsletter','blog','news','sitemap','rss','login','register','account',
    'warenkorb','cart','checkout','bestellung',
    'note','paypal','gift','gutschein','jobs','karriere',
    '\\.pdf$'
  ].join('|'),
  'i'
);

// —————————————————————— 平台判定 ——————————————————————
// 返回 'Shopify' | 'WooCommerce' | 'Magento' | 'Shopware' | ''
function detectPlatform($, html) {
  const text = (html || $('html').html() || '').toLowerCase();

  // Shopify
  if (
    /cdn\.shopify\.com|window\.Shopify|Shopify\.theme/i.test(text) ||
    $('meta[name="shopify-digital-wallet"], link[href*="shopify"]').length
  ) return 'Shopify';

  // WooCommerce (WordPress)
  if (
    /woocommerce|wp\-content\/plugins\/woocommerce/i.test(text) ||
    $('[class*="woocommerce"], [class*="wc-"], .add_to_cart_button').length ||
    $('meta[name="generator"][content*="WooCommerce"]').length
  ) return 'WooCommerce';

  // Magento
  if (
    /Magento|Mage\.Cookies|mage\/requirejs|pub\/static\/|form_key/i.test(text) ||
    $('meta[name="generator"][content*="Magento"]').length
  ) return 'Magento';

  // Shopware
  if (
    /shopware|sw\-|Shopware\./i.test(text) ||
    $('meta[name="generator"][content*="Shopware"]').length
  ) return 'Shopware';

  return '';
}

// 链接是否“像商品详情”
function looksLikeProductHref(href = '') {
  const h = (href || '').toLowerCase().trim();
  if (!h) return false;
  if (GENERIC_LINK_BAD.test(h)) return false;
  // 常见的详情路径形态
  return /\/product[s]?\/|\/prod\/|\/item\/|\/p\/|\/detail\/|\/details\/|\/artikel\/|\/sku\/|\/dp\/|\/kaufen\/|\/buy\//.test(h);
}

function textIncludesAny(text, tokens = []) {
  const t = (text || '').toLowerCase();
  return tokens.some(k => t.includes(k));
}

function count($, selector) {
  let c = 0;
  $(selector).each(() => { c++; });
  return c;
}

// 解析 JSON-LD，看是否存在 Product/Offer 强信号
function hasJsonLdProduct($) {
  let yes = false;
  $('script[type="application/ld+json"]').each((_, s) => {
    try {
      const raw = ($(s).text() || '').trim();
      if (!raw) return;
      const data = JSON.parse(raw);
      const arr = Array.isArray(data) ? data : [data];

      for (const node of arr) {
        if (!node) continue;
        const typeRaw = node['@type'] || node.type || '';
        const types = Array.isArray(typeRaw) ? typeRaw.map(x => String(x).toLowerCase()) : [String(typeRaw).toLowerCase()];
        if (types.some(t => t.includes('product'))) yes = true;
        if (node.offers && (node.offers.price || node.offers.priceCurrency)) yes = true;
        if (Array.isArray(node.offers)) {
          if (node.offers.some(o => o && (o.price || o.priceCurrency))) yes = true;
        }
      }
    } catch { /* ignore */ }
  });
  return yes;
}

/**
 * 结构检测
 * 返回：
 * {
 *   type: 'homepage' | 'catalog' | 'product',
 *   platform: 'Shopify' | 'WooCommerce' | 'Magento' | 'Shopware' | '',
 *   name: 同 type,
 *   debug: { reason, platform, ...metrics }
 * }
 */
async function detectStructure(url, html) {
  const $ = load(html || '');
  const platform = detectPlatform($, html || '');
  const bodyText = $('body').text() || '';

  // —— 0) JSON-LD 强信号：直接判 product
  const jsonldProduct = hasJsonLdProduct($);
  if (jsonldProduct) {
    return debugReturn('product', platform, 'Product via JSON-LD', { url, jsonldProduct: true });
  }

  // —— 1) 锚点 & 卡片粗判
  let productAnchorCount = 0;
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') || '';
    if (looksLikeProductHref(href)) productAnchorCount++;
  });

  // 常见商品卡片类名（保守加入）
  const cardCount = count($, `
    .product, .product-card, .product-item, .productbox, .product-list-item,
    [class*="product-card"], [class*="product_item"], [data-product-id]
  `);

  // —— 2) 商业信号：价格 / 购买
  const hasPrice = textIncludesAny(bodyText, PRICE_TOKENS);
  const hasCart  = textIncludesAny(bodyText, CART_TOKENS);

  // —— 3) 详情页判定（保守：少量卡片 + 有价格/购买）
  // 典型详情页：卡片很少（<=3）且有价格/购买；或者商品锚点较少（<6）但同时出现价格与购买按钮
  if ((cardCount <= 3 && (hasPrice || hasCart)) || (productAnchorCount < 6 && hasPrice && hasCart)) {
    const mediaCount = $('img, video, picture').length;
    if (mediaCount >= 1) {
      return debugReturn('product', platform, 'Single product signals', {
        url, cardCount, productAnchorCount, hasPrice, hasCart, mediaCount
      });
    }
  }

  // —— 4) 目录页判定（多卡片或大量商品锚点）
  if (cardCount >= 6 || productAnchorCount >= 12) {
    let decision = 'catalog';
    let reason   = 'Many cards/anchors';

    // ✦ 你要求的降级：catalog 但没有 price/cart → 很可能是栏目/品牌宫格/帮助页
    if (!hasPrice && !hasCart) {
      const firstLinks = $('a[href]').slice(0, 80).toArray().map(a => $(a).attr('href') || '');
      const badRatio = firstLinks.length
        ? firstLinks.filter(h => GENERIC_LINK_BAD.test(h || '')).length / firstLinks.length
        : 0;

      // 同时结合 canonical/category/collections 的微弱信号，避免过度降级
      const canonical = ($('link[rel="canonical"]').attr('href') || '').toLowerCase();
      const looksLikeCatalogPath = /(category|categories|collection|collections|catalog|produkte|produkte\/|kategorie|waren)/.test(canonical);

      if (badRatio > 0.40 && !looksLikeCatalogPath) {
        decision = 'homepage';
        reason   = 'Catalog downgraded: no price/cart & too many site-links';
      }
    }

    return debugReturn(decision, platform, reason, {
      url, cardCount, productAnchorCount, hasPrice, hasCart
    });
  }

  // —— 5) 默认回到主页/栏目页（安全）
  return debugReturn('homepage', platform, 'Low commerce signals', {
    url, cardCount, productAnchorCount, hasPrice, hasCart
  });
}

function debugReturn(type, platform, reason, extra = {}) {
  const payload = {
    type,
    platform: platform || '',
    name: type,
    debug: { reason, platform: platform || '', ...extra }
  };
  // 开启 DEBUG 环境变量时输出便于排障的结构化日志
  if (process.env.DEBUG) {
    try { console.log('[detector]', JSON.stringify(payload)); } catch {}
  }
  return payload;
}

module.exports = { detectStructure };
