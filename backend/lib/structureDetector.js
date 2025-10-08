// backend/lib/structureDetector.js
// Detect German e‑commerce site structure by lightweight heuristics.
// Export as a NAMED function to match: `import { detectStructure } from "./lib/structureDetector.js";`

/**
 * @param {string} html  The raw HTML string of a list (category/collection) page
 * @param {string} [url] Optional URL of the page (used only for hints)
 * @returns {{type: 'Shopify'|'WooCommerce'|'Shopware'|'Magento'|'Unknown', confidence: number, signals: string[]}}
 */
export function detectStructure(html = '', url = '') {
  const src = String(html || '');
  const u = String(url || '');

  // Collect signals
  const sig = [];

  // ---------- Shopify ----------
  // Typical markers: cdn.shopify.com assets, shopify-section, window.Shopify, /collections/ URLs
  let scoreShopify = 0;
  if (/cdn\.shopify\.com\//i.test(src)) { scoreShopify += 2; sig.push('cdn.shopify.com'); }
  if (/shopify-section|theme--cart|Shopify\.theme|window\.Shopify/i.test(src)) { scoreShopify += 2; sig.push('shopify-section/window.Shopify'); }
  if (/\/collections\//i.test(u) || /\/collections\//i.test(src)) { scoreShopify += 1; sig.push('collections URL'); }
  if (/"@type"\s*:\s*"ProductCollection"/i.test(src)) { scoreShopify += 1; sig.push('ProductCollection JSON-LD'); }

  // ---------- WooCommerce ----------
  // Typical markers: 'woocommerce' classes, wp-content/plugins/woocommerce, add-to-cart forms
  let scoreWoo = 0;
  if (/woocommerce|woo\-commerce/i.test(src)) { scoreWoo += 2; sig.push('class: woocommerce'); }
  if (/wp\-content\/plugins\/woocommerce/i.test(src)) { scoreWoo += 2; sig.push('wp-content/plugins/woocommerce'); }
  if (/name=["']add-to-cart["']/i.test(src)) { scoreWoo += 1; sig.push('form add-to-cart'); }
  if (/\/product-category\//i.test(u) || /woocommerce\.min\.js/i.test(src)) { scoreWoo += 1; sig.push('woocommerce.js/category'); }

  // ---------- Shopware (5/6) ----------
  // Typical markers: meta generator, sw- classes, storefront assets, window.Shopware
  let scoreShopware = 0;
  if (/meta[^>]+name=["']generator["'][^>]+content=["']Shopware/i.test(src)) { scoreShopware += 3; sig.push('meta generator=Shopware'); }
  if (/\bShopware\b/i.test(src)) { scoreShopware += 1; sig.push('string "Shopware"'); }
  if (/\bsw\-|sw6\-|js\-listing|is--ctl-listing|is--act-listing/i.test(src)) { scoreShopware += 2; sig.push('sw-/listing classes'); }
  if (/\/bundles\/storefront\/|\/themes\/Frontend\/|window\.Shopware/i.test(src)) { scoreShopware += 1; sig.push('storefront assets'); }

  // ---------- Magento (2.x) ----------
  // Typical markers: data-mage-init, requirejs/knockout, Magento_Catalog, luma theme assets
  let scoreMagento = 0;
  if (/data-mage-init|data-bind="scope:|Magento_Catalog|mage\/validation/i.test(src)) { scoreMagento += 2; sig.push('data-mage-init / Magento_Catalog'); }
  if (/\/static\/version|requirejs\/require\.js|knockout-?\w*\.js/i.test(src)) { scoreMagento += 2; sig.push('static/version or requirejs/knockout'); }
  if (/meta[^>]+name=["']generator["'][^>]+content=["']Magento/i.test(src)) { scoreMagento += 2; sig.push('meta generator=Magento'); }
  if (/\/collections\/|\/category\/|\/catalog\/category\/view/i.test(u + ' ' + src)) { scoreMagento += 1; sig.push('catalog/category'); }

  // Normalize & pick best
  const scores = [
    ['Shopify', scoreShopify],
    ['WooCommerce', scoreWoo],
    ['Shopware', scoreShopware],
    ['Magento', scoreMagento],
  ] as const;

  scores.sort((a, b) => b[1] - a[1]);
  const [bestType, bestScore] = scores[0];

  // Confidence: map score to 0..1
  const max = Math.max(1, scores[0][1] + scores[1][1] / 4);
  const confidence = Math.max(0, Math.min(1, bestScore / max));

  const type = bestScore > 0 ? (bestType as any) : 'Unknown';

  // Keep unique signals (dedupe)
  const signals = Array.from(new Set(sig));

  return { type, confidence, signals };
}

// Default export (optional) for flexibility when imported as default
export default { detectStructure };

