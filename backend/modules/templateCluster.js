// backend/modules/templateCluster.js

/**
 * 语义模板聚合：非常轻量的启发式分类器
 * 返回 { platform, type, adapterHint }
 */
export function classify(url = "", html = "") {
  const u = String(url);
  const h = String(html || "");

  // 平台粗判
  const isShopify =
    /cdn\.shopify|x-shopify|\/collections\//i.test(u) ||
    /x-shopify|shopify-section|shopify-dynamic/i.test(h);

  const isWoo =
    /\/product-category\/|woocommerce|wp-content\/plugins\/woocommerce/i.test(u + h);

  // 页面类型粗判
  const isCatalog = /\/collections\/|\/category\/|\/kategorie\//i.test(u) || /product-grid|grid__item/i.test(h);

  const platform = isShopify ? "shopify" : isWoo ? "woocommerce" : "";
  const type = isCatalog ? "catalog" : "";

  // 提示给上层（例如你的 templateParser/choose-adapter）
  const adapterHint = platform
    ? `${platform}${type ? `:${type}` : ""}`
    : ""; // e.g. "shopify:catalog"

  return { platform, type, adapterHint };
}
