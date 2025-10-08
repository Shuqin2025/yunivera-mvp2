// backend/lib/structureDetector.js
// 轻量级结构识别（Shopify / WooCommerce / Shopware / Magento / Static / Unknown）
import * as cheerio from "cheerio";

// 检测规则：只做必要信号，避免误报；可按需再扩展
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
  },
  {
    type: "WooCommerce",
    hints: [
      /woocommerce/i, // body 类名常见
      /wp-content\/plugins\/woocommerce/i,
      /woocommerce-loop-product/i,
      /add_to_cart_button/i,
    ],
  },
  {
    type: "Shopware",
    hints: [
      /product--box/i,          // Shopware 列表项常见类
      /shopware/i,              // meta / 资源路径等
      /themes\/Frontend/i,     
      /data-variant-id/i,
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
  },
];

// 输入可以是 HTML 字符串或 cheerio 实例
export function detectStructure(input) {
  let $;

  if (typeof input === "string") {
    try {
      $ = cheerio.load(input);
    } catch (e) {
      return { type: "Unknown", confidence: 0, signals: ["load_error"] };
    }
  } else if (input && typeof input.root === "function") {
    // 已经是 cheerio 实例
    $ = input;
  } else {
    return { type: "Unknown", confidence: 0, signals: ["invalid_input"] };
  }

  const html = $.html ? $.html() : String(input);

  // 逐类计算命中数
  const scores = RULES.map((rule) => {
    let hit = 0;
    const matched = [];
    for (const r of rule.hints) {
      if (r.test(html)) {
        hit++;
        matched.push(r.source || String(r));
      }
    }
    return { type: rule.type, score: hit, signals: matched };
  }).sort((a, b) => b.score - a.score);

  let best = scores[0];

  // 若没命中已知平台，尝试 Static 目录页的粗略特征
  if (!best || best.score === 0) {
    const cardCount = $('[class*="product"],[class*="item"]').length;
    const priceLike = (html.match(/€\s?\d|USD|\$\s?\d|Preis|€\d/gi) || []).length;

    if (cardCount > 8 && priceLike > 8) {
      best = { type: "Static", score: 1, signals: ["basic HTML"] };
    } else {
      best = { type: "Unknown", score: 0, signals: [] };
    }
  }

  const maxHints =
    (RULES.find((r) => r.type === best.type)?.hints.length) || 1;
  const confidence = Math.min(1, best.score / maxHints);

  return { type: best.type, confidence, signals: best.signals };
}

export default detectStructure;
