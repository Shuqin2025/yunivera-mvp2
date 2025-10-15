// backend/lib/parsers/shopwareParser.js
// 通用 Shopware 列表解析（轻量骨架版）
// - ESM 导出：default / parse / parseShopware
// - 入参既可为 $（cheerio 实例），也可为 html 字符串或 { html, url }

import { load } from "cheerio";

/* ---------------- utils ---------------- */
const pickText = ($, el) => ($(el).text() || "").replace(/\s+/g, " ").trim();

const abs = (base, href) => {
  const s = (href || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("//")) return "https:" + s;
  try {
    const b = new URL(base || "https://localhost");
    if (s.startsWith("/")) return b.origin + s;
    return b.origin + "/" + s.replace(/^\.?\//, "");
  } catch {
    return s;
  }
};

const splitSrcset = (s) =>
  (s || "").split(",").map(x => x.trim().split(/\s+/)[0]).filter(Boolean);

function bestImgFrom($, $root, base) {
  const seen = new Set();
  const push = (u) => { if (u) seen.add(abs(base, u)); };

  const $img = $root.find("img").first();
  if ($img.length) {
    push($img.attr("data-src"));
    splitSrcset($img.attr("data-srcset")).forEach(push);
    push($img.attr("data-fallbacksrc"));
    splitSrcset($img.attr("srcset")).forEach(push);
    push($img.attr("src"));
  }
  $root.closest("picture").find("source[srcset]").each((_i, el) => {
    splitSrcset(el.attribs?.srcset || "").forEach(push);
  });

  // 兜底：从节点 HTML 里扒图
  const html = $root.html() || "";
  const re = /https?:\/\/[^"'()\s<>]+?\.(?:jpe?g|png|webp)(?:\?[^"'()\s<>]*)?/ig;
  let m; while ((m = re.exec(html))) push(m[0]);

  const list = [...seen].filter(u =>
    /\.(?:jpe?g|png|webp)(?:$|\?)/i.test(u) && !/loader\.svg/i.test(u)
  );
  if (!list.length) return "";
  const score = (u) => {
    let s = 0;
    const mm = u.match(/(\d{2,4})x(\d{2,4})/);
    if (mm) s += Math.min(parseInt(mm[1],10), parseInt(mm[2],10));
    if (/800x800|700x700|600x600/.test(u)) s += 100;
    if (/\.webp(?:$|\?)/i.test(u)) s += 5;
    return s;
  };
  return list.sort((a,b)=>score(b)-score(a))[0];
}

function readPrice($, node) {
  const txt =
    pickText($, $(node).find('.price--default, .product--price, .product-price, .product-price-info, [itemprop="price"]')) ||
    pickText($, $(node).find('.product--info .price, .price')) ||
    "";
  // try finding "12,34" or "12.34"
  const m = txt.match(/(\d{1,3}(?:[.,]\d{2}))/);
  return m ? m[1].replace(",", ".") : "";
}

/* ------------ main parse ------------ */
/**
 * parseShopware(input, opts)
 * - input: $
 *       | html string
 *       | { html, url }
 * - opts: { url?, limit?, site?, imageHints?, listSelectors? ... }
 */
async function parseShopware(input, opts = {}) {
  const limit = Number(opts.limit || 50);
  let $, pageUrl = "";

  if (input && typeof input === "object" && input.root && input.find) {
    // 已经是 cheerio $
    $ = input;
    pageUrl = opts.url || opts.pageUrl || "";
  } else if (typeof input === "string") {
    $ = load(input, { decodeEntities: false });
    pageUrl = opts.url || opts.pageUrl || "";
  } else if (input && typeof input === "object") {
    const html = input.html || "";
    pageUrl = input.url || opts.url || "";
    $ = load(html, { decodeEntities: false });
  } else {
    return [];
  }

  const base = (() => {
    try { return pageUrl ? new URL(pageUrl).origin : (new URL($('base[href]').attr('href')||"https://localhost")).origin; }
    catch { return "https://localhost"; }
  })();

  const SELECTORS = opts.listSelectors || [
    ".listing--container .product--box",
    ".product--listing .product--box",
    ".js--isotope .product--box",
    "#listing .product--box",
    ".is--ctl-listing .product--box",
    ".product--box", // 最后兜底,
    ".cms-block-product-listing .product-box",
    ".cms-element-product-listing .product-box",
    ".product-box",
    ".product-card",
    "[data-product-id]",
    "[data-product=\"true\"]",
  ];

  // 黑名单（避免把详情页“相关推荐”等滑块误判为卡片）
  const BLACK = [
    ".product--detail", ".product--details", "#detail",
    ".cross-selling", ".crossselling", ".related", ".related--products",
    ".similar--products", ".upselling", ".accessories", ".accessory--slider",
    ".product-slider--container", ".product--slider", ".is--ctl-detail",
  ].join(", ");

  // 找到列表卡片
  let cards = [];
  for (const sel of SELECTORS) {
    const arr = $(sel).toArray().filter(el => $(el).closest(BLACK).length === 0);
    if (arr.length) { cards = arr; break; }
  }
  if (!cards.length) return [];

  const out = [];
  for (const el of cards) {
    const $el = $(el);
    const $a = $el.find('a[href]').first();

    const title =
      pickText($, $el.find(".product--title, .product--info a, .product--name, [itemprop='name'], .product-box__title, .product-title, .product-name")).trim() ||
      ($a.attr("title") || "").trim();

    const href =
      $el.attr("data-url") || $el.attr("data-link") || $el.attr("data-href") ||
      $a.attr("href") || "";
    const link = abs(base, href);

    const img = bestImgFrom($, $el, base);
    const price = readPrice($, $el);

    // SKU 占位（Shopware 常有 data-ordernumber）
    const sku =
      ($el.attr("data-ordernumber") || "").trim() ||
      ($el.find("[data-ordernumber]").attr("data-ordernumber") || "").trim() ||
      ($el.find("[data-sku]").attr("data-sku") || "").trim() ||
      "";

    if (title && link) {
      out.push({
        title,
        url: link,
        link,
        img,
        imgs: img ? [img] : [],
        sku,
        price,
        currency: "",
        moq: "",
        desc: ""
      });
    }
    if (out.length >= limit) break;
  }

  return out.slice(0, limit);
}

/* —— 导出名兼容 —— */
export default parseShopware;
export { parseShopware, parseShopware as parse };
