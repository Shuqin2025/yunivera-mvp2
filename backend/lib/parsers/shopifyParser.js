// backend/lib/parsers/shopifyParser.js
/* eslint-disable no-useless-escape */
const SELECTORSETS = [
  // Dawn / Sense 等常见卡片
  {
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

// 价格清洗：去掉符号/空白，只保留原文本（前端展示即可）
function cleanPrice(txt) {
  if (!txt) return "";
  return String(txt).replace(/\s+/g, " ").trim();
}

function normalizeUrl(base, href) {
  try {
    if (!href) return "";
    // 处理 data-src 等无协议的 CDN 链接
    if (/^\/\//.test(href)) return "https:" + href;
    // 已是绝对地址
    if (/^https?:\/\//i.test(href)) return href;
    // 相对路径
    return new URL(href, base).toString();
  } catch (_) {
    return href || "";
  }
}

function pickFirst($el, sel) {
  try {
    const node = $el.find(sel).first();
    if (!node || node.length === 0) return "";
    // meta[itemprop=price] 场景
    const isMeta = node[0] && node[0].name === "meta";
    if (isMeta) {
      const v = node.attr("content") || node.attr("value") || "";
      return (v || "").trim();
    }
    // 常规标签：取 text
    const txt = node.text() || node.attr("title") || "";
    return (txt || "").replace(/\s+/g, " ").trim();
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

      // 有些主题卡片没有直接放标题在卡片内部，回退试多个层级
      let title =
        pickFirst($el, set.title) ||
        (a.attr("title") || "").trim() ||
        $el.attr("aria-label") ||
        "";

      // 价格有两层：显示价 + data/meta 价
      let price =
        pickFirst($el, set.price) ||
        ($el.find("meta[itemprop='price']").attr("content") || "").trim();

      const img = pickImage($el, url, set.img);

      // 如果至少拿到了链接，就先收一个骨架，后续 compare=1 时会详情补齐
      if (link) {
        out.push({
          title: title || "",
          url: link,
          link,
          img,
          imgs: img ? [img] : [],
          price: cleanPrice(price),
          sku: "",
          desc: ""
        });
      }
    });

    if (out.length) break; // 第一套命中就结束
  }

  // 去重（按 URL）
  const seen = new Set();
  const uniq = out.filter(x => {
    if (!x.url) return false;
    if (seen.has(x.url)) return false;
    seen.add(x.url);
    return true;
  });

  return uniq.slice(0, limit);
}

/**
 * JSON-LD 回退：抓取 <script type="application/ld+json"> 里的 ItemList
 * 兼容形如：
 * {
 *   "@type": "ItemList",
 *   "itemListElement": [
 *     {"@type":"ListItem","position":1,"url":"/products/xxx","name":"标题","image":"...","offers":{"price":"34.99","priceCurrency":"EUR"}}
 *   ]
 * }
 */
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

    const listCandidates = Array.isArray(data) ? data : [data];
    listCandidates.forEach(node => {
      // ItemList 结构
      if (node && node["@type"] && String(node["@type"]).toLowerCase() === "itemlist" && Array.isArray(node.itemListElement)) {
        node.itemListElement.forEach(item => {
          // 兼容两种：item 直接是对象，或者 {item:{...}}
          const cell = item.item || item;
          if (!cell) return;
          const href = cell.url || (cell["@id"] || "");
          const link = normalizeUrl(url, href);
          const title = (cell.name || "").trim();
          // 优先 offers.price，其次 price，其次 meta
          const price =
            (cell.offers && (cell.offers.price || cell.offers.lowPrice)) ||
            cell.price ||
            "";
          // 图片：可能是字符串或数组
          let img = "";
          if (Array.isArray(cell.image)) img = cell.image[0] || "";
          else if (typeof cell.image === "string") img = cell.image;
          img = normalizeUrl(url, img);

          if (link) {
            out.push({
              title: title || "",
              url: link,
              link,
              img,
              imgs: img ? [img] : [],
              price: cleanPrice(price),
              sku: "",
              desc: ""
            });
          }
        });
      }
    });
  });

  // 去重 + 截断
  const seen = new Set();
  const uniq = out.filter(x => {
    if (!x.url) return false;
    if (seen.has(x.url)) return false;
    seen.add(x.url);
    return true;
  });

  return uniq.slice(0, limit);
}

function mergePreferDom(domList, jsonldList) {
  if (!domList || domList.length === 0) return jsonldList || [];
  if (!jsonldList || jsonldList.length === 0) return domList;

  const map = new Map(domList.map(p => [p.url, p]));
  for (const j of jsonldList) {
    if (!map.has(j.url)) {
      map.set(j.url, j);
    } else {
      const d = map.get(j.url);
      // 用 JSON-LD 填补空缺字段
      if (!d.title && j.title) d.title = j.title;
      if (!d.price && j.price) d.price = j.price;
      if ((!d.img || d.img === "") && j.img) {
        d.img = j.img;
        d.imgs = j.img ? [j.img] : d.imgs || [];
      }
    }
  }
  return Array.from(map.values());
}

function parse($, url, { limit = 50 } = {}) {
  const dom = fromDom($, url, limit);
  // 如果 DOM 解析出的标题为空或数量很少，尝试 JSON-LD 回退补齐
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
