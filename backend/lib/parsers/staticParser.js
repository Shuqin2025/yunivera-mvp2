// backend/lib/parsers/staticParser.js
// 适用于非四大电商系统的“静态/简单结构”页面：
// - 广义地抓取页面里的内容块/链接，过滤一批明显的站点导航与法律页
// - 尽力提取 title / link / image / price

import { load } from "cheerio";

const NAV_BAD_WORDS = [
  "agb", "datenschutz", "privacy", "impressum", "kontakt", "contact",
  "widerruf", "revocation", "note", "account", "login", "register",
  "sitemap", "shipping", "versand", "returns", "help", "support",
  "paypal", "cart", "basket", "warenkorb", "newsletter", "blog"
];

const PRODUCT_HINT = /(product|produkt|artikel|item|detail|kategorie|category|shop|store)/i;

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

function bestImgNear($, $node, base) {
  const bag = new Set();
  const push = (u) => { if (u) bag.add(abs(base, u)); };

  const $img = $node.find("img").first();
  if ($img.length) {
    push($img.attr("data-src"));
    splitSrcset($img.attr("data-srcset")).forEach(push);
    push($img.attr("data-fallbacksrc"));
    splitSrcset($img.attr("srcset")).forEach(push);
    push($img.attr("src"));
  }
  const html = $node.html() || "";
  const re = /https?:\/\/[^"'()\s<>]+?\.(?:jpe?g|png|webp)(?:\?[^"'()\s<>]*)?/ig;
  let m; while ((m = re.exec(html))) push(m[0]);

  const list = [...bag].filter(u =>
    /\.(?:jpe?g|png|webp)(?:$|\?)/i.test(u) && !/loader\.svg/i.test(u)
  );
  return list[0] || "";
}

function looksLikeNav(url) {
  const u = (url || "").toLowerCase();
  return NAV_BAD_WORDS.some(k => u.includes("/" + k) || u.includes(k + "/") || u.endsWith(k) || u.includes(`?${k}=`));
}

/**
 * parseStatic(input, opts)
 * - input: html string | $ | { html, url }
 * - opts: { url?, limit? }
 */
async function parseStatic(input, opts = {}) {
  const limit = Number(opts.limit || 100);
  let $, pageUrl = "";

  if (input && typeof input === "object" && input.root && input.find) {
    $ = input;
    pageUrl = opts.url || "";
  } else if (typeof input === "string") {
    $ = load(input, { decodeEntities: false });
    pageUrl = opts.url || "";
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

  // 1) 找明显“卡片
  const CARD_SELS = [
    ".card, .product, .product-item, .grid-item, .tile, .teaser, .box",
    ".item, .entry, .list-item, .catalog-item"
  ];
  let boxes = [];
  for (const sel of CARD_SELS) {
    const arr = $(sel).toArray();
    if (arr.length >= 6) { boxes = arr; break; } // 有一定密度才当卡片
  }

  const out = [];

  const pushItem = (title, link, img) => {
    if (!title || !link) return;
    if (looksLikeNav(link)) return;
    if (!PRODUCT_HINT.test(link) && title.length < 3) return;
    out.push({
      title,
      url: link,
      link,
      img,
      imgs: img ? [img] : [],
      sku: "",
      price: "",
      currency: "",
      moq: "",
      desc: ""
    });
  };

  if (boxes.length) {
    for (const el of boxes) {
      const $el = $(el);
      const $a = $el.find("a[href]").first();
      const link = abs(base, $a.attr("href") || "");
      const title =
        pickText($, $el.find(".title, .name, .product-title, h3, h2, a")) ||
        ($a.attr("title") || "").trim();
      const img = bestImgNear($, $el, base);
      pushItem(title, link, img);
      if (out.length >= limit) break;
    }
  } else {
    // 2) 没有明显卡片：遍历所有 a[href]，用启发式过滤
    $("a[href]").each((_i, a) => {
      const href = $(a).attr("href") || "";
      const link = abs(base, href);
      if (!PRODUCT_HINT.test(link)) return;
      const title = ($(a).attr("title") || pickText($, a)).trim();
      if (!title) return;
      const img = bestImgNear($, $(a).closest("li, div, article"), base);
      pushItem(title, link, img);
    });
  }

  return out.slice(0, limit);
}

export default parseStatic;
export { parseStatic, parseStatic as parse };
