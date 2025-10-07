// backend/lib/structureDetector.js
// 目标：给定HTML（可选url），返回 { type, confidence, signals }，type ∈ Shopware|WooCommerce|Magento|Shopify|Static|Unknown

function scoreSignal(map, key, reason, weight = 1) {
  map[key] = map[key] || { score: 0, reasons: [] };
  map[key].score += weight;
  if (map[key].reasons.length < 12) map[key].reasons.push(reason);
}

export function detectStructure(html = "", url = "") {
  const t = String(html || "").toLowerCase();
  const u = String(url || "");
  const scores = {}; // { Shopware: {score, reasons}, ... }

  // ——— 通用信号 ———
  const hasJsonLDProduct = /"@type"\s*:\s*"(product|Product)"/.test(t);
  const hasULProducts   = /<ul[^>]*class="[^"]*\bproducts\b[^"]*"[^>]*>/.test(t);
  const hasLiProduct    = /<li[^>]*class="[^"]*\bproduct\b[^"]*"[^>]*>/.test(t);

  // ——— Shopware（beamer-discount / memoryking 等常见）———
  if (/\bshopware\b/.test(t)) scoreSignal(scores, "Shopware", "contains 'shopware'", 2);
  if (/\bproduct--box\b/.test(t)) scoreSignal(scores, "Shopware", ".product--box", 2);
  if (/\bbuybox--button\b/.test(t)) scoreSignal(scores, "Shopware", ".buybox--button");
  if (/\bis--ctl-listing\b|\bsw-/.test(t)) scoreSignal(scores, "Shopware", "is--ctl-listing/sw-");
  if (/themes\/frontend|engine\/shopware/.test(t)) scoreSignal(scores, "Shopware", "themes/frontend|engine/shopware");

  // ——— WooCommerce / WordPress ———
  if (/\bwoocommerce\b/.test(t)) scoreSignal(scores, "WooCommerce", "contains 'woocommerce'", 2);
  if (/wp-content|wp-includes/.test(t)) scoreSignal(scores, "WooCommerce", "wp-content/wp-includes");
  if (hasULProducts && hasLiProduct) scoreSignal(scores, "WooCommerce", "ul.products li.product", 2);
  if (/\bwoocommerce-loop-product__title\b/.test(t)) scoreSignal(scores, "WooCommerce", ".woocommerce-loop-product__title");
  if (/\bwoocommerce-price-amount\b/.test(t)) scoreSignal(scores, "WooCommerce", ".woocommerce-Price-amount");

  // ——— Magento ———
  if (/\bmagento\b/.test(t)) scoreSignal(scores, "Magento", "contains 'magento'", 2);
  if (/data-mage-init|\bmage-init\b/.test(t)) scoreSignal(scores, "Magento", "data-mage-init/mage-init", 2);
  if (/\bproduct-item(-info)?\b/.test(t)) scoreSignal(scores, "Magento", ".product-item/info");
  if (/\bprice-box\b/.test(t)) scoreSignal(scores, "Magento", ".price-box");

  // ——— Shopify ———
  if (/cdn\.shopify\.com|window\.shopify|shopify\.theme/.test(t)) scoreSignal(scores, "Shopify", "Shopify assets/theme", 2);
  if (/\bshopify-section\b/.test(t)) scoreSignal(scores, "Shopify", ".shopify-section");
  if (/\/products\.json\b/.test(t)) scoreSignal(scores, "Shopify", "/products.json");

  // ——— 静态/其它线索 ———
  if (hasJsonLDProduct) {
    // JSON-LD 很常见，给所有框架一点点“背景分”
    ["Shopware","WooCommerce","Magento","Shopify"].forEach(k => scoreSignal(scores, k, "JSON-LD Product", 0.5));
  }

  // ——— 从URL做一点点倾向（不决定，只加分）———
  if (/shopify/.test(u)) scoreSignal(scores, "Shopify", "url hints shopify");
  if (/woocommerce|wp-/.test(u)) scoreSignal(scores, "WooCommerce", "url hints wp/woo");
  if (/magento/.test(u)) scoreSignal(scores, "Magento", "url hints magento");
  if (/shopware|beamer-discount|memoryking/.test(u)) scoreSignal(scores, "Shopware", "url hints shopware");

  // 选出分数最高的类型
  const ranked = Object.entries(scores)
    .map(([type, v]) => ({ type, score: v.score, reasons: v.reasons }))
    .sort((a,b) => b.score - a.score);

  if (ranked.length === 0) {
    // 没有任何强信号，但HTML是完整静态页
    if (/<html[\s>]/.test(t) && /<body[\s>]/.test(t)) {
      return { type: "Static", confidence: 0.5, signals: ["basic HTML"] };
    }
    return { type: "Unknown", confidence: 0, signals: [] };
  }

  const best = ranked[0];
  const second = ranked[1] || { score: 0 };
  const gap = best.score - second.score;
  const confidence = Math.min(0.99, 0.55 + Math.max(0, gap) * 0.08); // 简单映射成 0.55~0.99

  return { type: best.type, confidence, signals: best.reasons };
}
