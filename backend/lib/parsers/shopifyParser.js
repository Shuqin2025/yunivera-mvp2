/* eslint-disable no-useless-escape */

// ===== Common helpers =====
function cleanText(txt) {
  if (!txt) return "";
  return String(txt).replace(/\s+/g, " ").trim();
}

function normalizeUrl(base, href) {
  try {
    if (!href) return "";
    // //cdn.xxx
    if (/^\/\//.test(href)) return "https:" + href;
    // absolute
    if (/^https?:\/\//i.test(href)) return href;
    // relative
    return new URL(href, base).toString();
  } catch {
    return href || "";
  }
}

// 认为是“可能的产品链接”
function isProbablyProductLink(link) {
  if (!link) return false;
  const u = link.toLowerCase();
  // 仅接受 /products/，并排除评论锚点/评论页
  if (!u.includes("/products/")) return false;
  if (u.includes("#reviews") || u.includes("reviewssection") || u.includes("/reviews")) return false;
  return true;
}

// 过滤明显是“去看评价/评论”的标题
function isJunkTitle(title = "") {
  const t = title.toLowerCase();
  return (
    t.includes("bewertungen") || // 德语：评价
    t.includes("reviews") ||
    t.includes("bewertung") ||
    t.includes("zu den bewertungen") ||
    /\{\{\s*title\s*\}\}/i.test(t) // 还没渲染的模板占位
  );
}

function stripFragment(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString();
  } catch {
    return url.split("#")[0];
  }
}

// ===== CSS Selector sets for Shopify themes =====
const SELECTORSETS = [
  {
    // 常见卡片容器
    card: [
      "[class*=product-card]",
      "[class*=ProductItem]",
      ".grid-product",
      ".product-item",
      ".product-grid-item",
      "li[class*=product]",
      "article[class*=product]"
    ].join(","),
    link: "a[href*='/products/']",
    title: [
      "[class*=product-title]",
      "[class*=ProductItem__Title]",
      "[class*=card__heading]",
      "[itemprop='name']",
      "a[title]"
    ].join(","),
    price: [
      "[class*=price]",
      "[class*=Price]",
      "price",
      "[itemprop='price']",
      "meta[itemprop='price']"
    ].join(","),
    img: "img"
  }
];

// ===== DOM parsing =====
function pickFirst($el, sel) {
  try {
    const node = $el.find(sel).first();
    if (!node || node.length === 0) return "";
    if (node[0] && node[0].name === "meta") {
      return cleanText(node.attr("content") || node.attr("value") || "");
    }
    return cleanText(node.text() || node.attr("title") || "");
  } catch {
    return "";
  }
}

function pickImage($el, base, sel = "img") {
  const n = $el.find(sel).first();
  if (!n || n.length === 0) return "";
  const src = n.attr("data-src") || n.attr("data-original") || n.attr("src") || "";
  return normalizeUrl(base, src);
}

function fromDom($, url, limit = 50) {
  const out = [];

  for (const set of SELECTORSETS) {
    const $cards = $(set.card);
    if (!$cards || $cards.length === 0) continue;

    $cards.each((_, el) => {
      const $el = $(el);
      const a = $el.find(set.link).first();
      const href = a.attr("href") || "";
      const link = normalizeUrl(url, href);

      if (!isProbablyProductLink(link)) return;

      let title =
        pickFirst($el, set.title) ||
        cleanText(a.attr("title") || "") ||
        cleanText($el.attr("aria-label") || "");

      if (isJunkTitle(title)) title = "";

      let price =
        pickFirst($el, set.price) ||
        cleanText($el.find("meta[itemprop='price']").attr("content") || "");

      const img = pickImage($el, url, set.img);

      out.push({
        title: title || "",
        url: link,
        link,
        img,
        imgs: img ? [img] : [],
        price: cleanText(price),
        sku: "",
        desc: ""
      });
    });

    if (out.length) break;
  }

  // 去重（按去掉 #fragment 后的 URL）
  const seen = new Set();
  const uniq = out.filter(x => {
    const key = stripFragment(x.url || "");
    if (!key) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return uniq.slice(0, limit);
}

// ===== JSON-LD fallback (ItemList / ListItem) =====
function fromJsonLd($, url, limit = 50) {
  const out = [];
  const scripts = $("script[type='application/ld+json']");

  scripts.each((_, el) => {
    const raw = $(el).contents().text();
    if (!raw) return;
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    const nodes = Array.isArray(data) ? data : [data];
    nodes.forEach(node => {
      const type = (node && node["@type"] || "").toString().toLowerCase();
      if (type !== "itemlist" || !Array.isArray(node.itemListElement)) return;

      node.itemListElement.forEach(item => {
        const cell = item && (item.item || item);
        if (!cell) return;

        const href = cell.url || cell["@id"] || "";
        const link = normalizeUrl(url, href);
        if (!isProbablyProductLink(link)) return;

        let title = cleanText(cell.name || "");
        if (isJunkTitle(title)) title = "";

        let price =
          (cell.offers && (cell.offers.price || cell.offers.lowPrice)) ||
          cell.price ||
          "";

        let img = "";
        if (Array.isArray(cell.image)) img = cell.image[0] || "";
        else if (typeof cell.image === "string") img = cell.image;
        img = normalizeUrl(url, img);

        out.push({
          title: title || "",
          url: link,
          link,
          img,
          imgs: img ? [img] : [],
          price: cleanText(price),
          sku: "",
          desc: ""
        });
      });
    });
  });

  // 去重（按去掉 #fragment 后的 URL）
  const seen = new Set();
  const uniq = out.filter(x => {
    const key = stripFragment(x.url || "");
    if (!key) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return uniq.slice(0, limit);
}

// ===== Merge: DOM first, JSON-LD as supplement =====
function mergePreferDom(domList, jsonldList) {
  if (!domList || domList.length === 0) return jsonldList || [];
  if (!jsonldList || jsonldList.length === 0) return domList;

  const map = new Map(domList.map(p => [stripFragment(p.url), { ...p }]));
  for (const j of jsonldList) {
    const key = stripFragment(j.url);
    if (!key) continue;
    if (!map.has(key)) {
      map.set(key, j);
    } else {
      const d = map.get(key);
      if (!d.title && j.title) d.title = j.title;
      if (!d.price && j.price) d.price = j.price;
      if ((!d.img || d.img === "") && j.img) {
        d.img = j.img;
        d.imgs = j.img ? [j.img] : (d.imgs || []);
      }
    }
  }
  return Array.from(map.values());
}

// ===== Public API =====
function parse($, url, { limit = 50 } = {}) {
  const dom = fromDom($, url, limit);
  const needJsonLd = dom.length === 0 || dom.filter(x => x.title).length < Math.min(5, dom.length);
  const viaJson = needJsonLd ? fromJsonLd($, url, limit) : [];
  const merged = mergePreferDom(dom, viaJson);
  return merged.slice(0, limit);
}

function parseShopify($, url, opts = {}) {
  return parse($, url, opts);
}

module.exports = {
  default: parse,
  parse,
  parseShopify,
};
