// backend/lib/smartRootLocator.js
import logger from "./logger.js";

/**
 * detectRoot(ctx) -> { selector, confidence, reason, probes }
 *
 * ctx 支持两种输入：
 *   A) Cheerio 上下文：{ $ }   （我们后端当前主要就是这个）
 *   B) 浏览器上下文：Playwright/Page 等：{ page }
 */
export default async function detectRoot(ctx, opts = {}) {
  try {
    if (ctx?.$) {
      return detectFromCheerio(ctx.$, opts);
    }
    if (ctx?.page && typeof ctx.page.evaluate === "function") {
      return await detectFromBrowser(ctx.page, opts);
    }
  } catch (e) {
    logger.warn(`[smartRoot] detectRoot error: ${e?.message}`);
  }
  return {
    selector: "body",
    confidence: 0.1,
    reason: "fallback: no ctx.$ or ctx.page",
    probes: []
  };
}

/** 常见电商/框架的容器线索（按优先级从高到低） */
const CANDIDATE_LIST = [
  // Shopify 常见
  ".collection,.collection__products",
  ".grid--uniform,.grid--view-items",
  ".product-grid,.collection-grid",
  "[data-section-type*=collection],[data-products-grid]",
  // WooCommerce
  "ul.products, .woocommerce ul.products, .wc-block-grid__products",
  // Shopware
  ".listing--container, .cms-listing-row, .product-box",
  // Magento 2
  ".products-grid,.products.wrapper.grid",
  "ol.products.list, .product-items",
  // 通用
  "[class*=product][class*=list], [class*=product][class*=grid]",
  "[data-testid*=product]",
  "[class*=catalog][class*=list], [class*=catalog][class*=grid]"
];

function detectFromCheerio($, opts) {
  const probes = [];
  let best = { selector: "body", confidence: 0.1, reason: "default", probes };

  for (const raw of CANDIDATE_LIST) {
    const sel = raw.split(",").map(s => s.trim()).filter(Boolean);
    for (const s of sel) {
      const $nodes = $(s);
      if ($nodes && $nodes.length > 0) {
        // 简单的“像商品卡”的子项统计：是否有 a/img/price-like 文本
        let score = 0.2;
        const items = $nodes.find("li, .product, .product-item, .product-card, .grid__item, .product-box");
        const sample = items.slice(0, 12);

        const priceLikes = sample.filter((_, el) => {
          const t = $(el).text().trim();
          return /(\$|€|£|\d+[.,]\d{2})/.test(t) || /price/i.test(t);
        }).length;

        const linkCount = sample.find("a[href]").length;
        const imgCount  = sample.find("img, [style*='background-image']").length;

        score += Math.min(0.4, priceLikes * 0.04);
        score += Math.min(0.2, linkCount * 0.01);
        score += Math.min(0.2, imgCount  * 0.01);

        probes.push({ selector: s, nodes: $nodes.length, priceLikes, linkCount, imgCount, score: +score.toFixed(2) });

        if (score > best.confidence) {
          best = {
            selector: s,
            confidence: +score.toFixed(2),
            reason: `hit: nodes=${$nodes.length}, priceLikes=${priceLikes}, link=${linkCount}, img=${imgCount}`,
            probes
          };
        }
      } else {
        probes.push({ selector: s, nodes: 0, score: 0 });
      }
    }
  }

  logger.debug(`[smartRoot] selected="${best.selector}" conf=${best.confidence} reason=${best.reason}`);
  return best;
}

async function detectFromBrowser(page, opts) {
  // 浏览器模式：在页面里直接跑与上面类似的启发式（保持选择器一致）
  const res = await page.evaluate((list) => {
    function count(el, sel){ return el.querySelectorAll(sel).length; }
    const probes = [];
    let best = { selector: "body", confidence: 0.1, reason: "default", probes: [] };

    for (const raw of list) {
      const sels = raw.split(",").map(s => s.trim()).filter(Boolean);
      for (const s of sels) {
        const nodes = Array.from(document.querySelectorAll(s));
        if (nodes.length > 0) {
          let score = 0.2;
          // 取前若干容器的前若干“像商品卡”的孩子做采样
          const items = nodes.flatMap(n => Array.from(n.querySelectorAll("li, .product, .product-item, .product-card, .grid__item, .product-box"))).slice(0, 12);

          const priceLikes = items.filter(el => {
            const t = (el.textContent || "").trim();
            return /(\$|€|£|\d+[.,]\d{2})/.test(t) || /price/i.test(t);
          }).length;

          const linkCount = items.reduce((acc, el) => acc + count(el, "a[href]"), 0);
          const imgCount  = items.reduce((acc, el) => acc + count(el, "img, [style*='background-image']"), 0);

          score += Math.min(0.4, priceLikes * 0.04);
          score += Math.min(0.2, linkCount * 0.01);
          score += Math.min(0.2, imgCount  * 0.01);

          probes.push({ selector: s, nodes: nodes.length, priceLikes, linkCount, imgCount, score: +score.toFixed(2) });

          if (score > best.confidence) {
            best = { selector: s, confidence: +score.toFixed(2), reason: `hit: nodes=${nodes.length}, priceLikes=${priceLikes}, link=${linkCount}, img=${imgCount}`, probes };
          }
        } else {
          probes.push({ selector: s, nodes: 0, score: 0 });
        }
      }
    }
    return best;
  }, CANDIDATE_LIST);

  return res || { selector: "body", confidence: 0.1, reason: "fallback(browser)", probes: [] };
}
