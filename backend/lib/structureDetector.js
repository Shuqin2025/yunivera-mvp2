// backend/lib/structureDetector.js
// 结构识别（Shopify / WooCommerce / Shopware / Magento / Static / Unknown）

import * as cheerio from "cheerio";


// —— 便捷判定工具（新增）——
function has($, sel) { return $(sel).length > 0; }
function meta($, name) {
  return $(`meta[name="${name}"]`).attr('content')
      || $(`meta[property="${name}"]`).attr('content')
      || '';
}

// —— 轻量正则线索（HTML 级别）——
const RULES = [
  {
    type: "Shopify",
    hints: [
      /cdn\.shopify\.com/i,
      /shopify-section/i,
      /window\.Shopify/i,
      /Shopify\.theme/i,
      /\/products\.json/i,
    ],
    dom: [
      'script[src*="cdn.shopify.com"]',
      '[data-section-id]',
      'form[action*="/cart"]',
    ],
  },
  {
    type: "WooCommerce",
    hints: [
      /woocommerce/i, // wp-content/plugins/woocommerce 或 body 类名
      /wp-content\/plugins\/woocommerce/i,
      /woocommerce-loop-product/i,
      /add_to_cart_button/i,
    ],
    dom: [
      "ul.products li.product",
      ".woocommerce",
      'a.button.add_to_cart_button, a.add_to_cart_button',
    ],
  },
  {
    type: "Shopware",
    hints: [
      /product--box/i,          // 列表项常见类
      /shopware/i,              // meta / 资源路径等
      /themes\/Frontend/i,
      /data-variant-id/i,
    ],
    dom: [
      ".product--box, .entry--sku, .product--ordernumber, .is--ordernumber",
      'script[src*="engine/Shopware"]',
      'link[href*="themes/Frontend"]',
    ],
  },
  {
    type: "Magento",
    hints: [
      /Magento/i,
      /data-mage-init/i,
      /product-item/i,
      /Magento_Catalog/i,
    ],
    dom: [
      ".product-item, .price-box",
      'script[type="text/x-magento-init"]',
    ],
  },
];

// —— 计算某一类的命中分 ——
function scoreType($, html, rule) {
  let hit = 0;
  const signals = [];

  // 正则命中
  for (const r of rule.hints || []) {
    if (r.test(html)) {
      hit++;
      signals.push(r.source || String(r));
    }
  }

  // DOM 命中（存在即加分）
  for (const sel of rule.dom || []) {
    if ($(sel).length) {
      hit++;
      signals.push(`dom:${sel}`);
    }
  }

  return { type: rule.type, score: hit, signals };
}

// —— 主函数 ——
// input: HTML 字符串 或 cheerio 实例
export function detectStructure(input) {
  let $;

  if (typeof input === "string") {
    try {
      $ = cheerio.load(input);
    } catch (e) {
      return { type: "Unknown", confidence: 0, signals: ["load_error"] };
    }
  } else if (input && typeof input.root === "function") {
    $ = input;
  } else {
    return { type: "Unknown", confidence: 0, signals: ["invalid_input"] };
  }

  
// —— 快速指纹命中（新增，优先于打分）——
  try {
    // Shopware：meta generator、offcanvas 数据属性、典型容器
    if (
      /shopware/i.test(meta($, 'generator')) ||
      has($, '[data-plugin="offcanvas-menu"], [data-offcanvas]') ||
      has($, '.cms-block-product-listing, .product-box, [data-product-id]')
    ) {
      return { type: 'Shopware', confidence: 0.99, signals: ['fast:meta|attr|container'] };
    }

    // WooCommerce：body 类名与常见容器
    if (
      /woocommerce/.test(($('body').attr('class') || '')) ||
      has($, '.woocommerce ul.products li.product, .products .product, .wc-block-grid__product')
    ) {
      return { type: 'WooCommerce', confidence: 0.99, signals: ['fast:body|container'] };
    }

    // Magento：meta generator、x-magento-init、常见栅格
    if (
      /magento/i.test(meta($, 'generator')) ||
      has($, 'script[type="text/x-magento-init"]') ||
      has($, '.products-grid .product-item, .product-items .product-item, [data-product-id]')
    ) {
      return { type: 'Magento', confidence: 0.99, signals: ['fast:meta|script|grid'] };
    }

    // Shopify：全局变量、模板标记、典型卡片
    if (
      /Shopify/.test($('script').text()) ||
      has($, 'script[data-section-type], script[data-shopify]') ||
      has($, '.product-grid, .collection, .grid--view-items, [data-product-id]')
    ) {
      return { type: 'Shopify', confidence: 0.99, signals: ['fast:globals|template|cards'] };
    }
  } catch (e) {
    // 忽略快速指纹异常，继续走后续策略
  }
const html = $.html ? $.html() : String(input);

  // 逐类打分
  const scores = RULES
    .map((rule) => scoreType($, html, rule))
    .sort((a, b) => b.score - a.score);

  let best = scores[0];

  // 若没命中已知平台，尝试 Static 的粗特征
  if (!best || best.score === 0) {
    const cardCount = $('[class*="product"],[class*="item"]').length;
    const priceLike = (html.match(/€\s?\d|EUR|\$\s?\d|Preis|€\d/gi) || []).length;

    if (cardCount > 8 && priceLike > 8) {
      best = { type: "Static", score: 1, signals: ["basic HTML"] };
    } else {
      best = { type: "Unknown", score: 0, signals: [] };
    }
  }
// —— 兜底：仍无法识别时，返回 generic-links ——
  if (!best || best.type === "Unknown" || best.score === 0) {
    return { type: "generic-links", confidence: 0, signals: ["fallback_generic"] };
  }
const maxHints =
    (RULES.find((r) => r.type === best.type)?.hints.length || 1) +
    (RULES.find((r) => r.type === best.type)?.dom?.length || 0);

  const confidence = Math.min(1, maxHints ? best.score / maxHints : 0.0);

  return { type: best.type, confidence, signals: best.signals };
}

export default detectStructure;
