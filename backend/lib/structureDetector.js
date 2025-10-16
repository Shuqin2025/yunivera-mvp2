// backend/lib/structureDetector.js
const { load } = require('cheerio');

const PRICE_TOKENS = [
  'price', 'preise', 'preis', '€', '$', '¥', 'eur', 'usd', 'in kl. MwSt', 'inkl. MwSt',
  'from €', 'ab €', 'uvp', 'sale', 'sonderpreis', 'angebot'
];

const CART_TOKENS = [
  'add to cart', 'in den warenkorb', 'warenkorb', 'buy now', 'kaufen', 'jetzt kaufen',
  'in den einkaufswagen', 'add-to-cart', 'cart/add'
];

// 明显是站点级/资讯级链接或栏目
const GENERIC_LINK_BAD = new RegExp(
  [
    'hilfe','support','kundendienst','faq','service',
    'agb','widerruf','widerrufsbelehrung','rueckgabe','retoure',
    'versand','lieferung','payment','zahlungs',
    'datenschutz','privacy','cookies?',
    'kontakt','contact','impressum','about','ueber\\-?uns',
    'newsletter','blog','news','sitemap','rss','login','register','account',
    'warenkorb','cart','checkout','bestellung',
    'note','paypal','gift','gutschein','jobs','karriere','\\.pdf$'
  ].join('|'),
  'i'
);

// —— 平台判定 ——
// 返回 'Shopify' | 'WooCommerce' | 'Magento' | 'Shopware' | ''
function detectPlatform($, html) {
  const text = ($('html').html() || '').toLowerCase();

  // Shopify
  if (
    /cdn\.shopify\.com|window\.Shopify|Shopify\.theme/i.test(html) ||
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
  const h = (href || '').toLowerCase();
  if (!h || GENERIC_LINK_BAD.test(h)) return false;
  return /\/product|\/products|\/prod|\/item|\/p\/|\/detail|\/artikel|\/sku|\/dp\//.test(h);
}

function textIncludesAny(text, tokens = []) {
  const t = (text || '').toLowerCase();
  return tokens.some(k => t.includes(k.toLowerCase()));
}

function countMatches($, selector) {
  let c = 0;
  $(selector).each((_, el) => { c++; });
  return c;
}

/**
 * 结构检测
 * 返回 { type:'homepage'|'catalog'|'product', platform:'Shopify'|'WooCommerce'|'Magento'|'Shopware'|'', debug }
 */
async function detectStructure(url, html) {
  const $ = load(html);
  const bodyTxt = $('body').text() || '';

  // 平台
  const platform = detectPlatform($, html);

  // 0) JSON-LD / Microdata 强指示：Product
  let jsonldProduct = false;
  try {
    $('script[type="application/ld+json"]').each((_, s) => {
      try {
        const data = JSON.parse($(s).text() || 'null');
        const arr = Array.isArray(data) ? data : [data];
        for (const node of arr) {
          if (!node) continue;
          const t = (node['@type'] || node['type'] || '').toString().toLowerCase();
          if (t.includes('product')) jsonldProduct = true;
          if (node.offers && (node.offers.price || node.offers.priceCurrency)) jsonldProduct = true;
        }
      } catch {}
    });
  } catch {}

  if (jsonldProduct) {
    return debugReturn('product', platform, 'Product via JSON-LD', { jsonldProduct: true, url });
  }

  // 1) 常见商品卡片/网格
  const gridCandidates = [
    '.product-grid .product',
    '.products .product',
    '.product-list .product',
    '[class*="product"]',
    'article',
    'li'
  ].join(', ');

  // 候选锚点
  let productAnchorCount = 0;
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') || '';
    if (looksLikeProductHref(href)) productAnchorCount++;
  });

  // 明显的产品卡片元素数量
  const cardCount = countMatches($, '.product, .product-card, .product-item');

  // 2) 价格/购物车信号
  const hasPrice = textIncludesAny(bodyTxt, PRICE_TOKENS);
  const hasCart  = textIncludesAny(bodyTxt, CART_TOKENS);

  // 3) 判定
  // 3.1 只有一个主商品区域且价格/购买信号明显 → 详情页
  if ((cardCount <= 3 && (hasPrice || hasCart)) || (productAnchorCount < 6 && (hasPrice && hasCart))) {
    const media = $('img').length;
    if (media >= 1) {
      return debugReturn('product', platform, 'Single product signals', {
        cardCount, productAnchorCount, hasPrice, hasCart, url
      });
    }
  }

  // 3.2 多卡片 + 大量商品锚点 → 目录页
  if (cardCount >= 6 || productAnchorCount >= 12) {
    let decision = 'catalog';
    let reason   = 'Many cards/anchors';

    // —— 安全降级：目录页但无价格且无购买信号，极可能是“站点栏目/品牌宫格/帮助页” ——
    if (!hasPrice && !hasCart) {
      const firstLinks = $('a[href]').slice(0, 60).toArray().map(a => $(a).attr('href') || '');
      const badRatio = firstLinks.length
        ? firstLinks.filter(h => GENERIC_LINK_BAD.test(h || '')).length / firstLinks.length
        : 0;

      if (badRatio > 0.4) {
        decision = 'homepage';
        reason   = 'Catalog downgraded: no price/cart & too many site-links';
      }
    }

    return debugReturn(decision, platform, reason, {
      cardCount, productAnchorCount, hasPrice, hasCart, url
    });
  }

  // 3.3 默认回到主页/栏目页
  return debugReturn('homepage', platform, 'Low commerce signals', {
    cardCount, productAnchorCount, hasPrice, hasCart, url
  });
}

function debugReturn(type, platform, reason, extra = {}) {
  const payload = {
    type,
    platform: platform || '',
    name: type,
    debug: { reason, platform: platform || '', ...extra }
  };
  if (process.env.DEBUG) {
    console.log('[detector]', JSON.stringify(payload));
  }
  return payload;
}

module.exports = { detectStructure };
