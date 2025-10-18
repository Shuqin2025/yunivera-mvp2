// backend/lib/structureDetector.js
// 轻量、可解释的页面结构判定：homepage | catalog | product
// - 保守：宁可判为 homepage 也不误判为 catalog/product
// - 可观察：DEBUG=1 时输出完整判定原因，便于线上排障

const { load } = require('cheerio');

// --- DEBUG helper (append-only) ---
const __dbg = (tag, data) => {
  try {
    if (process?.env?.DEBUG) {
      const msg = typeof data === 'string' ? data : JSON.stringify(data);
      console.log(`[struct] ${tag} ${msg}`);
    }
  } catch {}
};
// --- /DEBUG helper ---

// ===== 引入 dbg（与 ESM/CJS 兼容的安全方案；失败则回退到本地实现） =====
let dbg = (...args) => { try { if (process?.env?.DEBUG) console.log(...args); } catch {} };
try {
  // 如果 logger.js 以 ESM 导出 dbg，这里 require 可能抛错，所以上面先准备了回退
  // eslint-disable-next-line import/no-dynamic-require, global-require
  const maybe = require('../logger.js');
  if (maybe && typeof maybe.dbg === 'function') dbg = maybe.dbg;
} catch {}
// ===== /dbg 引入 =====

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

// 🔥 更宽松的正则信号
const PRICE_REGEX = /€|eur|preis|price|chf|\$|£|[0-9]\s*,\s*[0-9]{2}\s*€/i;
const CART_REGEX  = /add\-?to\-?cart|warenkorb|in den warenkorb|detail\-?btn|buy\-?now/i;

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

  // ======= ADDON: stronger fingerprints for platform detection =======
  // ---- WooCommerce ----
  const isWooByCss =
    /\bwoocommerce\b/i.test($('body').attr('class') || '') ||
    $('.woocommerce').length > 0 ||
    $('link[href*="woocommerce"]').length > 0 ||
    $('script[src*="woocommerce"]').length > 0 ||
    $('script:contains("woocommerce_params")').length > 0 ||
    $('script:contains("wc_add_to_cart_params")').length > 0;

  // ---- Shopware (v5/v6) ----
  const isShopwareByMeta = /shopware/i.test($('meta[name="generator"]').attr('content') || '');
  const isShopwareByHints =
    $('[data-shopware]').length > 0 ||
    $('[class*="sw-"], [id*="sw-"]').length > 0 ||
    $('script[src*="/engine/Shopware"], link[href*="/engine/Shopware"]').length > 0 ||
    $('link[href*="/bundles/storefront/"], script[src*="/bundles/storefront/"]').length > 0 ||
    $('script:contains("window.router")').length > 0;

  // ---- Magento (2.x) ----
  const isMagentoByAssets =
    $('script[src*="requirejs-config.js"]').length > 0 ||
    $('link[href*="/static/frontend/"], script[src*="/static/frontend/"]').length > 0 ||
    $('script[src*="/mage/"], script[src*="Magento_"]').length > 0 ||
    $('[data-mage-init]').length > 0 ||
    $('script:contains("Magento")').length > 0 ||
    /Magento/i.test($('meta[name="generator"]').attr('content') || '');

  // === 追加：统计计数与总览（只加不改） ===
  try {
    const cnt = {
      woo: {
        bodyClass: /\bwoocommerce\b/i.test($('body').attr('class') || '') ? 1 : 0,
        divWoo: $('.woocommerce').length,
        linkWoo: $('link[href*="woocommerce"]').length,
        scriptWoo: $('script[src*="woocommerce"]').length,
        params:
          $('script:contains("woocommerce_params")').length +
          $('script:contains("wc_add_to_cart_params")').length,
      },
      shopware: {
        meta: /shopware/i.test($('meta[name="generator"]').attr('content') || '') ? 1 : 0,
        dataAttr: $('[data-shopware]').length,
        swPrefix: $('[class*="sw-"], [id*="sw-"]').length,
        engine: $('script[src*="/engine/Shopware"], link[href*="/engine/Shopware"]').length,
        bundles: $('link[href*="/bundles/storefront/"], script[src*="/bundles/storefront/"]').length,
      },
      magento: {
        reqjs: $('script[src*="requirejs-config.js"]').length,
        staticFront: $('link[href*="/static/frontend/"], script[src*="/static/frontend/"]').length,
        mage: $('script[src*="/mage/"], script[src*="Magento_"]').length,
        mageInit: $('[data-mage-init]').length,
        metaGen: /Magento/i.test($('meta[name="generator"]').attr('content') || '') ? 1 : 0,
        word: $('script:contains("Magento")').length,
      },
    };

    // 这里的 isShopify/isWoo/isShopware/isMagento 仅作“当前函数视角”的判定总览
    const verdict = {
      isShopify: false,                       // 上面 Shopify 的强判已提前 return
      isWoo: !!isWooByCss,
      isShopware: !!(isShopwareByMeta || isShopwareByHints),
      isMagento: !!isMagentoByAssets,
    };
    const isGenericCandidate = !verdict.isShopify && !verdict.isWoo && !verdict.isShopware && !verdict.isMagento;

    dbg('[struct] counts', cnt);
    dbg('[struct] verdict', { ...verdict, isGenericCandidate });
  } catch (e) {
    dbg('[struct] debug error', String(e));
  }
  // === /统计与总览 ===

  // 将这些加强条件与原判断合并（原有分支未命中时再兜底）
  if (isWooByCss) return 'WooCommerce';
  if (isShopwareByMeta || isShopwareByHints) return 'Shopware';
  if (isMagentoByAssets) return 'Magento';
  // ======= /ADDON =======

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
 *   debug: { reason, platform, adapterHint, ...metrics }
 * }
 */
async function detectStructure(url, html, adapterHint = '') {
  const $ = load(html || '');
  const platform = detectPlatform($, html || '');

  // ===== DEBUG: fingerprints overview (append-only) =====
  try {
    const __flags = __platformFlags($, html || '');
    const isShopify = !!__flags.shopify;
    const isWoo = !!__flags.woocom;
    const isShopware = !!__flags.shopware;
    const isMagento = !!__flags.magento;
    __dbg('fingerprints', { url, isShopify, isWoo, isShopware, isMagento });
    if (!isShopify && !isWoo && !isShopware && !isMagento) {
      __dbg('fallback', { reason: 'no platform matched, use generic-links' });
    }
  } catch {}
  // ===== /DEBUG =====

  // ===== DEBUG: structure fingerprints =====
  try {
    if (process.env.DEBUG) {
      const flags = __platformFlags($, html || '');
      console.log('[struct]', 'flags=', flags);
    }
  } catch (_) {}
  // ===== /DEBUG =====

  const bodyText = $('body').text() || '';
  const hint = adapterHint || process.env.ADAPTER_HINT || '';

  // —— 0) JSON-LD 强信号：直接判 product
  const jsonldProduct = hasJsonLdProduct($);
  if (jsonldProduct) {
    const payload = debugReturn('product', platform, 'Product via JSON-LD', { url, jsonldProduct: true }, hint);
    console.info?.(`[struct] type=${payload.type} platform=${payload.platform || '-'} adapterHint=${hint || '-'}`);
    return payload;
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

  // —— 2) 商业信号：价格 / 购买（宽松 + 令牌）
  const hasPriceTokens = textIncludesAny(bodyText, PRICE_TOKENS);
  const hasCartTokens  = textIncludesAny(bodyText, CART_TOKENS);
  const hasPriceWide   = PRICE_REGEX.test(bodyText);
  const hasCartWide    = CART_REGEX.test(bodyText);
  const hasPrice       = hasPriceTokens || hasPriceWide;
  const hasCart        = hasCartTokens || hasCartWide;

  // —— 3) 详情页判定（保守：少量卡片 + 有价格/购买）
  if ((cardCount <= 3 && (hasPrice || hasCart)) || (productAnchorCount < 6 && hasPrice && hasCart)) {
    const mediaCount = $('img, video, picture').length;
    if (mediaCount >= 1) {
      const payload = debugReturn('product', platform, 'Single product signals', {
        url, cardCount, productAnchorCount, hasPrice, hasCart, mediaCount
      }, hint);
      console.info?.(`[struct] type=${payload.type} platform=${payload.platform || '-'} adapterHint=${hint || '-'}`);
      return payload;
    }
  }

  // —— 4) 目录页判定（多卡片或大量商品锚点）
  if (cardCount >= 6 || productAnchorCount >= 12) {
    let decision = 'catalog';
    let reason   = 'Many cards/anchors';

    // ✦ 兜底降级：catalog 但没有 price/cart → 很可能是栏目/品牌宫格/帮助页
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
        console.warn?.(`[struct] catalog->homepage fallback (no price/cart signals) adapterHint=${hint || '-'}`);
      }
    }

    const payload = debugReturn(decision, platform, reason, {
      url, cardCount, productAnchorCount, hasPrice, hasCart
    }, hint);
    console.info?.(`[struct] type=${payload.type} platform=${payload.platform || '-'} adapterHint=${hint || '-'}`);
    return payload;
  }

  // —— 5) 默认回到主页/栏目页（安全）
  const payload = debugReturn('homepage', platform, 'Low commerce signals', {
    url, cardCount, productAnchorCount, hasPrice, hasCart
  }, hint);
  console.info?.(`[struct] type=${payload.type} platform=${payload.platform || '-'} adapterHint=${hint || '-'}`);
  return payload;
}

function debugReturn(type, platform, reason, extra = {}, adapterHint = '') {
  const payload = {
    type,
    platform: platform || '',
    name: type,
    debug: { reason, platform: platform || '', adapterHint: adapterHint || '', ...extra }
  };
  // 开启 DEBUG 环境变量时输出便于排障的结构化日志
  if (process.env.DEBUG) {
    try { console.log('[detector]', JSON.stringify(payload)); } catch {}
  }
  return payload;
}


// ===== DEBUG helper: platform flags (does not affect logic) =====
function __platformFlags($, html) {
  try {
    const text = (html || $('html').html() || '').toLowerCase();
    const shopify =
      /cdn\.shopify\.com|window\.Shopify|Shopify\.theme/i.test(text) ||
      $('meta[name="shopify-digital-wallet"], link[href*="shopify"]').length > 0;

    const woocom =
      /woocommerce|wp\-content\/plugins\/woocommerce/i.test(text) ||
      $('[class*="woocommerce"], [class*="wc-"], .add_to_cart_button').length > 0 ||
      $('meta[name="generator"][content*="WooCommerce"]').length > 0;

    const magento =
      /Magento|Mage\.Cookies|mage\/requirejs|pub\/static\/|form_key/i.test(text) ||
      $('meta[name="generator"][content*="Magento"]').length > 0 ||
      $('[data-mage-init]').length > 0;

    const shopware =
      /shopware|sw\-|Shopware\./i.test(text) ||
      $('meta[name="generator"][content*="Shopware"]').length > 0 ||
      $('[data-shopware]').length > 0 ||
      $('[class*="sw-"], [id*="sw-"]').length > 0;

    return { shopify: !!shopify, shopware: !!shopware, woocom: !!woocom, magento: !!magento };
  } catch { return { shopify:false, shopware:false, woocom:false, magento:false }; }
}
// ===== /DEBUG helper =====

module.exports = { detectStructure };
