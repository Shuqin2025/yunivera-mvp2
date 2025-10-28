// backend/lib/structureDetector.js
// 修正版：统一输出 type = "list" | "detail" | "other"
// 这样 catalog.js 能正确分流，而不会再把真实目录页跳成 "skipped-non-list"

import * as cheerio from "cheerio";
const { load } = cheerio;

// --- DEBUG helper (append-only) ---
const __dbg = (tag, data) => {
  try {
    if (process?.env?.DEBUG) {
      const msg = typeof data === "string" ? data : JSON.stringify(data);
      console.log(`[struct] ${tag} ${msg}`);
    }
  } catch {}
};
// --- /DEBUG helper ---

// ===== logger safe import =====
let __logger = null;
try {
  const mod = await import("../logger.js").catch(() => null);
  if (mod) {
    __logger = mod.default || mod.logger || null;
  }
} catch {}
const __logDebug = (msg) => {
  try {
    if (__logger && typeof __logger.debug === "function") {
      __logger.debug(msg);
    } else if (typeof console !== "undefined" && typeof console.debug === "function") {
      console.debug(msg);
    }
  } catch {}
};
// ===== /logger =====

const PRICE_TOKENS = [
  "price",
  "preise",
  "preis",
  "€",
  "$",
  "¥",
  "eur",
  "usd",
  "inkl. mwst",
  "in kl. mwst",
  "inkl mwst",
  "mwst",
  "ab €",
  "from €",
  "uvp",
  "sale",
  "sonderpreis",
  "angebot"
];

const CART_TOKENS = [
  "add to cart",
  "add-to-cart",
  "cart/add",
  "buy now",
  "in den warenkorb",
  "warenkorb",
  "kaufen",
  "jetzt kaufen",
  "in den einkaufswagen",
  "zum warenkorb",
  "checkout"
];

// 宽松商业信号
const PRICE_REGEX = /€|eur|preis|price|chf|\$|£|[0-9]\s*,\s*[0-9]{2}\s*€/i;
const CART_REGEX = /add\-?to\-?cart|warenkorb|in den warenkorb|detail\-?btn|buy\-?now/i;

// 站点级/帮助/导航类链接的特征
const GENERIC_LINK_BAD = new RegExp(
  [
    "hilfe",
    "support",
    "kundendienst",
    "faq",
    "service",
    "agb",
    "widerruf",
    "widerrufsbelehrung",
    "rueckgabe",
    "retoure",
    "versand",
    "liefer",
    "shipping",
    "payment",
    "zahlungs",
    "datenschutz",
    "privacy",
    "cookies?",
    "kontakt",
    "contact",
    "impressum",
    "about",
    "ueber\\-?uns",
    "newsletter",
    "blog",
    "news",
    "sitemap",
    "rss",
    "login",
    "register",
    "account",
    "warenkorb",
    "cart",
    "checkout",
    "bestellung",
    "note",
    "paypal",
    "gift",
    "gutschein",
    "jobs",
    "karriere",
    "\\.pdf$"
  ].join("|"),
  "i"
);

// 平台嗅探 -------------------------------------------------
function detectPlatform($, html) {
  const text = (html || $("html").html() || "").toLowerCase();

  // Shopify
  if (
    /cdn\.shopify\.com|window\.Shopify|Shopify\.theme/i.test(text) ||
    $('meta[name="shopify-digital-wallet"], link[href*="shopify"]').length
  )
    return "Shopify";

  // WooCommerce
  if (
    /woocommerce|wp\-content\/plugins\/woocommerce/i.test(text) ||
    $('[class*="woocommerce"], [class*="wc-"], .add_to_cart_button').length ||
    $('meta[name="generator"][content*="WooCommerce"]').length
  )
    return "WooCommerce";

  // Magento
  if (
    /Magento|Mage\.Cookies|mage\/requirejs|pub\/static\/|form_key/i.test(text) ||
    $('meta[name="generator"][content*="Magento"]').length
  )
    return "Magento";

  // Shopware
  if (
    /shopware|sw\-|Shopware\./i.test(text) ||
    $('meta[name="generator"][content*="Shopware"]').length
  )
    return "Shopware";

  // ADDITIONAL signs:
  const isWooByCss =
    /\bwoocommerce\b/i.test($("body").attr("class") || "") ||
    $(".woocommerce").length > 0 ||
    $('link[href*="woocommerce"]').length > 0 ||
    $('script[src*="woocommerce"]').length > 0 ||
    $('script:contains("woocommerce_params")').length > 0 ||
    $('script:contains("wc_add_to_cart_params")').length > 0;

  const isShopwareByMeta = /shopware/i.test($('meta[name="generator"]').attr("content") || "");
  const isShopwareByHints =
    $("[data-shopware]").length > 0 ||
    $('[class*="sw-"], [id*="sw-"]').length > 0 ||
    $('script[src*="/engine/Shopware"], link[href*="/engine/Shopware"]').length > 0 ||
    $('link[href*="/bundles/storefront/"], script[src*="/bundles/storefront/"]').length > 0 ||
    $('script:contains("window.router")').length > 0;

  const isMagentoByAssets =
    $('script[src*="requirejs-config.js"]').length > 0 ||
    $('link[href*="/static/frontend/"], script[src*="/static/frontend/"]').length > 0 ||
    $('script[src*="/mage/"], script[src*="Magento_"]').length > 0 ||
    $("[data-mage-init]").length > 0 ||
    /Magento/i.test($('meta[name="generator"]').attr("content") || "") ||
    $('script:contains("Magento")').length > 0;

  try {
    const cnt = {
      woo: {
        bodyClass: /\bwoocommerce\b/i.test($("body").attr("class") || "") ? 1 : 0,
        divWoo: $(".woocommerce").length,
        linkWoo: $('link[href*="woocommerce"]').length,
        scriptWoo: $('script[src*="woocommerce"]').length,
        params:
          $('script:contains("woocommerce_params")').length +
          $('script:contains("wc_add_to_cart_params")').length
      },
      shopware: {
        meta: /shopware/i.test($('meta[name="generator"]').attr("content") || "") ? 1 : 0,
        dataAttr: $("[data-shopware]").length,
        swPrefix: $('[class*="sw-"], [id*="sw-"]').length,
        engine: $(
          'script[src*="/engine/Shopware"], link[href*="/engine/Shopware"]'
        ).length,
        bundles: $(
          'link[href*="/bundles/storefront/"], script[src*="/bundles/storefront/"]'
        ).length
      },
      magento: {
        reqjs: $('script[src*="requirejs-config.js"]').length,
        staticFront: $(
          'link[href*="/static/frontend/"], script[src*="/static/frontend/"]'
        ).length,
        mage: $('script[src*="/mage/"], script[src*="Magento_"]').length,
        mageInit: $("[data-mage-init]").length,
        metaGen: /Magento/i.test($('meta[name="generator"]').attr("content") || "") ? 1 : 0,
        word: $('script:contains("Magento")').length
      }
    };

    const verdict = {
      isShopify: false,
      isWoo: !!isWooByCss,
      isShopware: !!(isShopwareByMeta || isShopwareByHints),
      isMagento: !!isMagentoByAssets
    };
    const isGenericCandidate =
      !verdict.isShopify && !verdict.isWoo && !verdict.isShopware && !verdict.isMagento;

    __dbg("counts", cnt);
    __dbg("verdict", { ...verdict, isGenericCandidate });
  } catch (e) {
    __dbg("debug error", String(e));
  }

  if (isWooByCss) return "WooCommerce";
  if (isShopwareByMeta || isShopwareByHints) return "Shopware";
  if (isMagentoByAssets) return "Magento";

  return "";
}

// helpers -------------------------------------------------

function looksLikeProductHref(href = "") {
  const h = (href || "").toLowerCase().trim();
  if (!h) return false;
  if (GENERIC_LINK_BAD.test(h)) return false;
  return /\/product[s]?\/|\/prod\/|\/item\/|\/p\/|\/detail\/|\/details\/|\/artikel\/|\/sku\/|\/dp\/|\/kaufen\/|\/buy\//.test(
    h
  );
}

function textIncludesAny(text, tokens = []) {
  const t = (text || "").toLowerCase();
  return tokens.some((k) => t.includes(k));
}

function count($, selector) {
  let c = 0;
  $(selector).each(() => {
    c++;
  });
  return c;
}

// JSON-LD sniff for Product / Offer
function hasJsonLdProduct($) {
  let yes = false;
  $('script[type="application/ld+json"]').each((_, s) => {
    try {
      const raw = ($(s).text() || "").trim();
      if (!raw) return;
      const data = JSON.parse(raw);
      const arr = Array.isArray(data) ? data : [data];

      for (const node of arr) {
        if (!node) continue;
        const typeRaw = node["@type"] || node.type || "";
        const types = Array.isArray(typeRaw)
          ? typeRaw.map((x) => String(x).toLowerCase())
          : [String(typeRaw).toLowerCase()];
        if (types.some((t) => t.includes("product"))) yes = true;
        if (node.offers && (node.offers.price || node.offers.priceCurrency)) yes = true;
        if (Array.isArray(node.offers)) {
          if (node.offers.some((o) => o && (o.price || o.priceCurrency))) yes = true;
        }
      }
    } catch {
      /* ignore */
    }
  });
  return yes;
}

// 统一返回格式：type = "list" | "detail" | "other"
function debugReturnNormalized(normType, platform, reason, extra = {}, adapterHint = "") {
  const payload = {
    type: normType, // !!! 关键：只会是 list / detail / other
    platform: platform || "",
    name: normType,
    debug: {
      reason,
      platform: platform || "",
      adapterHint: adapterHint || "",
      ...extra
    }
  };
  if (process.env.DEBUG) {
    try {
      console.log("[detector]", JSON.stringify(payload));
    } catch {}
  }
  return payload;
}

// platform flags for debug only
function __platformFlags($, html) {
  try {
    const text = (html || $("html").html() || "").toLowerCase();
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
      $("[data-mage-init]").length > 0;

    const shopware =
      /shopware|sw\-|Shopware\./i.test(text) ||
      $('meta[name="generator"][content*="Shopware"]').length > 0 ||
      $("[data-shopware]").length > 0 ||
      $('[class*="sw-"], [id*="sw-"]').length > 0;

    return {
      shopify: !!shopify,
      shopware: !!shopware,
      woocom: !!woocom,
      magento: !!magento
    };
  } catch {
    return { shopify: false, shopware: false, woocom: false, magento: false };
  }
}

// 主逻辑 -------------------------------------------------

export async function detectStructure(url, html, adapterHint = "") {
  const $ = load(html || "");
  const platform = detectPlatform($, html || "");

  // debug fingerprints
  try {
    const __flags = __platformFlags($, html || "");
    const isShopify = !!__flags.shopify;
    const isWoo = !!__flags.woocom;
    const isShopware = !!__flags.shopware;
    const isMagento = !!__flags.magento;
    __dbg("fingerprints", { url, isShopify, isWoo, isShopware, isMagento });
    if (!isShopify && !isWoo && !isShopware && !isMagento) {
      __dbg("fallback", { reason: "no platform matched, use generic-links" });
    }
  } catch {}

  const bodyText = $("body").text() || "";
  const hint = adapterHint || process.env.ADAPTER_HINT || "";

  // 0) JSON-LD 强信号：大概率是商品详情页
  const jsonldProduct = hasJsonLdProduct($);
  if (jsonldProduct) {
    const payload = debugReturnNormalized(
      "detail",
      platform,
      "Product via JSON-LD",
      { url, jsonldProduct: true },
      hint
    );
    try {
      const f = __platformFlags($, html || "");
      const decidedAdapter = platform || hint || "";
      __logDebug(
        `[struct] url=${url} decided=type=${payload.type},platform=${decidedAdapter || "-"}`
      );
    } catch {}
    console.info?.(
      `[struct] type=${payload.type} platform=${platform || "-"} adapterHint=${hint || "-"}`
    );
    return payload;
  }

  // 1) 基础信号统计
  let productAnchorCount = 0;
  $("a[href]").each((_, a) => {
    const href = $(a).attr("href") || "";
    if (looksLikeProductHref(href)) productAnchorCount++;
  });

  // “商品卡片式块” 计数
  const cardCount = count(
    $,
    `
      .product, .product-card, .product-item, .productbox, .product-box,
      .product-list-item, .product-list, .product-grid, .products-grid,
      .listing--container, ul.products li,
      [class*="product-card"],
      [class*="product_item"],
      [data-product-id],
      [data-product]
    `
  );

  // 商业信号：价格/购买关键词
  const hasPriceTokens = textIncludesAny(bodyText, PRICE_TOKENS);
  const hasCartTokens = textIncludesAny(bodyText, CART_TOKENS);
  const hasPriceWide = PRICE_REGEX.test(bodyText);
  const hasCartWide = CART_REGEX.test(bodyText);
  const hasPrice = hasPriceTokens || hasPriceWide;
  const hasCart = hasCartTokens || hasCartWide;

  // 2) detail 判定（单品页）
  //    逻辑：卡片很少，但有价/购信息，且可能只有一个 SKU 的展示
  if (
    (cardCount <= 3 && (hasPrice || hasCart)) ||
    (productAnchorCount < 6 && hasPrice && hasCart)
  ) {
    const mediaCount = $("img, video, picture").length;
    if (mediaCount >= 1) {
      const payload = debugReturnNormalized(
        "detail",
        platform,
        "Single product signals",
        { url, cardCount, productAnchorCount, hasPrice, hasCart, mediaCount },
        hint
      );
      try {
        const decidedAdapter = platform || hint || "";
        __logDebug(
          `[struct] url=${url} decided=type=${payload.type},platform=${decidedAdapter || "-"}`
        );
      } catch {}
      console.info?.(
        `[struct] type=${payload.type} platform=${platform || "-"} adapterHint=${hint || "-"}`
      );
      return payload;
    }
  }

  // 3) list 判定（目录/分类页）
  //    我们把“很多卡片 or 很多疑似商品链接”直接当 list
  //    这是我们需要的，避免误判成 other → skipped-non-list
  if (cardCount >= 6 || productAnchorCount >= 12) {
    let decision = "list";
    let reason = "Many cards/anchors";

    // 降级：如果完全看不到价格/购买词，而且链接多半像导航/帮助
    if (!hasPrice && !hasCart) {
      const firstLinks = $("a[href]")
        .slice(0, 80)
        .toArray()
        .map((a) => $(a).attr("href") || "");
      const badRatio = firstLinks.length
        ? firstLinks.filter((h) => GENERIC_LINK_BAD.test(h || "")).length /
          firstLinks.length
        : 0;

      const canonical = ($('link[rel="canonical"]').attr("href") || "").toLowerCase();
      const looksLikeCatalogPath = /(category|categories|collection|collections|catalog|produkte|produkte\/|kategorie|waren)/.test(
        canonical
      );

      if (badRatio > 0.4 && !looksLikeCatalogPath) {
        // 页面像“站点导航大页”而不是卖货目录
        decision = "other";
        reason =
          "Catalog downgraded: no price/cart & too many site-links (possible homepage/mega menu)";
        console.warn?.(
          `[struct] list->other fallback (no price/cart signals) adapterHint=${hint || "-"}`
        );
      }
    }

    const payload = debugReturnNormalized(
      decision,
      platform,
      reason,
      { url, cardCount, productAnchorCount, hasPrice, hasCart },
      hint
    );
    try {
      const decidedAdapter = platform || hint || "";
      __logDebug(
        `[struct] url=${url} decided=type=${payload.type},platform=${decidedAdapter || "-"}`
      );
    } catch {}
    console.info?.(
      `[struct] type=${payload.type} platform=${platform || "-"} adapterHint=${hint || "-"}`
    );
    return payload;
  }

  // 4) 其他：主页/信息页/导航页
  const payload = debugReturnNormalized(
    "other",
    platform,
    "Low commerce signals",
    { url, cardCount, productAnchorCount, hasPrice, hasCart },
    hint
  );
  try {
    const decidedAdapter = platform || hint || "";
    __logDebug(
      `[struct] url=${url} decided=type=${payload.type},platform=${decidedAdapter || "-"}`
    );
  } catch {}
  console.info?.(
    `[struct] type=${payload.type} platform=${platform || "-"} adapterHint=${hint || "-"}`
  );
  return payload;
}

export default detectStructure;
