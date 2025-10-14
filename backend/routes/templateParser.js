// backend/lib/templateParser.js
// 作用：
// 1) 接收 url/html/$/limit/debug/hintType
// 2) 调用 structureDetector.js 判型
// 3) 根据类型路由到相应 parser：memoryking 专用 / universal(Shopware|Woo|Magento|Shopify) / 其它留空
// 4) 统一返回：{ items:[...], adapter_used, debugPart }
//
// 注意：此文件不做 “generic 兜底” —— 兜底仍在 routes/catalog.js 里完成。
// 这样职责清晰：templateParser 负责“模板解析”，catalog.js 负责“抓取/解码 + 兜底 + 出口映射”。

import * as cheerio from "cheerio";
import detectStructure from "./structureDetector.js";
import universal from "../adapters/universal.js";     // 默认导出：async ({url,limit,debug}) => arr 或 {items}
import memoryking from "../adapters/memoryking.js";   // 导出对象：.test(url) .parse($, url, {limit,debug})

// ——— 工具：读取 host
function getHost(u) {
  try { return new URL(u).host.toLowerCase(); } catch { return ""; }
}

// ——— 工具：统一 parser 输出（数组 or 对象）为 items[]
function normItems(out) {
  if (!out) return [];
  if (Array.isArray(out)) return out;
  return out.items || out.products || [];
}

/**
 * templateParser
 * @param {Object} args
 * @param {string} args.url
 * @param {string} args.html    // 已解码 HTML
 * @param {cheerio.CheerioAPI} [args.$] // 可复用现成的 $
 * @param {number} [args.limit]
 * @param {boolean} [args.debug]
 * @param {string} [args.hintType]  // 前端传入的 t（shopware/woocommerce/shopify/magento/memoryking等）
 * @returns {Promise<{items: any[], adapter_used: string, debugPart?: any}>}
 */
export default async function templateParser({ url, html, $, limit = 50, debug = false, hintType = "" }) {
  // 1) 先把 hint 统一一下
  const hint = (hintType || "").toString().toLowerCase();
  const host = getHost(url);
  let adapter_used = "";
  let debugPart;

  // 2) 域名强约束（最稳）或 hint 指明 memoryking
  if (/(^|\.)memoryking\.de$/.test(host) || hint === "memoryking") {
    try {
      const $$ = $ || cheerio.load(html, { decodeEntities: false });
      const out = memoryking.parse($$, url, { limit, debug });
      const items = normItems(out);
      adapter_used = items.length ? "memoryking" : "";
      if (debug && out && out.debugPart) debugPart = out.debugPart;
      if (items.length) return { items, adapter_used, debugPart };
      // 未命中则继续往下，用 universal 走 Shopware 通用
    } catch (e) {
      // 忽略错误，继续尝试 universal
    }
  }

  // 3) 自动结构识别
  let det;
  try {
    det = detectStructure(html || $);
  } catch {
    det = null;
  }

  // 4) 针对 Shopware / WooCommerce / Shopify / Magento → 统一走 universal
  const type = (det && det.type) || "";
  const isUniversalType =
    hint === "shopware" || hint === "woocommerce" || hint === "shopify" || hint === "magento" ||
    /^(Shopware|WooCommerce|Shopify|Magento)$/i.test(type);

  if (isUniversalType) {
    // universal 自己会抓取 HTML（内部有请求），不依赖我们传进来的 html/$
    try {
      const ret = await universal({ url, limit, debug });
      const items = normItems(ret);
      adapter_used = items.length ? "universal" : "";
      return { items, adapter_used, debugPart };
    } catch (e) {
      // 失败则留给外层 generic 兜底
      return { items: [], adapter_used: "", debugPart };
    }
  }

  // 5) 其它类型暂不处理（例如 “Static”等），留给外层 generic 兜底
  return { items: [], adapter_used: "", debugPart };
}
