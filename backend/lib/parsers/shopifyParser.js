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

function isProbablyProductLink(link) {
  if (!link) return false;
  const u = link.toLowerCase();
  // 只接受 /products/ 详情，忽略评论等锚点
  if (!u.includes("/products/")) return false;
  if (u.includes("#reviews") || u.includes("reviewssection") || u.includes("/reviews")) return false;
  return true;
}

function isJunkTitle(title = "") {
  const t = title.toLowerCase();
  return (
    t.includes("bewertungen") || // “评价”类
    t.includes("reviews") ||
    t.includes("bewertung") ||
    t.includes("zu den bewertungen") ||
    /\{\{\s*title\s*\}\}/i.test(t) // 模板占位符
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
    // 常见主题的卡片/标题/价格/img
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

// ===== DOM helpers =====
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

/* ==================== 价格兜底（只加不改原逻辑）==================== */
function pickText($el) {
  try { return ($el && $el.text && $el.text().trim()) || ""; } catch { return ""; }
}

function firstMoney($scope) {
  // 常见展示容器（主题差异覆盖）
  const cands = [
    '.price__container .price__regular .price-item .money',
    '.price__container .price__regular .price__current .money',
    '.price__regular .price-item .money',
    '.price .price-item .money',
    '.price [class*="money"]',
    '[data-product-price]',
    '[data-price]',
    '[data-price-min]',
    '[data-price-max]',
  ];
  for (const sel of cands) {
    const t = pickText($scope.find(sel).first());
    if (t) return t;
  }
  // 卡片内直接找 “29,99€” / “€29.99” 等字样
  const raw = pickText($scope);
  const m = raw && raw.match(/(?:€\s?\d[\d.,]*|\d[\d.,]*\s?€)/);
  if (m) return m[0];
  return "";
}

function ldJsonPrice($doc) {
  try {
    const nodes = $doc.find('script[type="application/ld+json"]');
    for (let i = 0; i < nodes.length; i++) {
      const txt = nodes.eq(i).html() || '';
      if (!txt) continue;
      let json;
      try { json = JSON.parse(txt); } catch { continue; }
      const items = Array.isArray(json) ? json : [json];
      for (const it of items) {
        const offer = it && (it.offers || (it.itemOffered && it.itemOffered.offers));
        if (offer && (offer.price || (offer[0] && offer[0].price))) {
          const p = offer.price || offer[0].price;
          const cur = offer.priceCurrency || (offer[0] && offer[0].priceCurrency) || '€';
          return `${p}${cur === 'EUR' ? '€' : ''}`;
        }
      }
    }
  } catch {}
  return "";
}
/* ================== /价格兜底 ================== */

// ===== DOM parsing (card-first) =====
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

      // === 价格兜底补强（仅在原来取不到时触发） ===
      if (!price) {
        price = firstMoney($el) || ldJsonPrice($);
      }

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

  // URL 去 hash 去重
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

// ===== 深层 a[href*="/products/"] 兜底 =====
function deepAnchorFallback($, url, limit = 50) {
  const out = [];
  const $as = $("a[href*='/products/']");
  if (!$as || $as.length === 0) return out;

  $as.each((_, aEl) => {
    try {
      const $a = $(aEl);
      const href = $a.attr("href") || "";
      const link = normalizeUrl(url, href);
      if (!isProbablyProductLink(link)) return;

      // 从 <a> 及其上层容器推标题
      let title =
        cleanText($a.text()) ||
        cleanText($a.attr("title") || $a.attr("aria-label") || "");

      if (!title) {
        const $wrap = $a.closest("article,li,div,section");
        if ($wrap && $wrap.length) {
          title =
            cleanText(
              $wrap
                .find("[class*=title], [class*=heading], h1, h2, h3, [itemprop='name']")
                .first()
                .text()
            ) || "";
        }
      }
      if (isJunkTitle(title)) title = "";

      // 价格
      let price = "";
      const $scope = $a.closest("article,li,div,section");
      if ($scope && $scope.length) {
        price =
          cleanText(
            $scope
              .find(
                "[class*=price], [class*=Price], price, [itemprop='price'], meta[itemprop='price']"
              )
              .first()
              .text()
          ) ||
          cleanText($scope.find("meta[itemprop='price']").attr("content") || "");

        // === 价格兜底补强（仅在取不到时触发） ===
        if (!price) {
          price = firstMoney($scope) || ldJsonPrice($);
        }
      } else {
        // 没有合适 scope 也试试全局 JSON-LD
        if (!price) price = ldJsonPrice($);
      }

      // 图片
      let img = "";
      if ($scope && $scope.length) {
        const n =
          $scope.find("img").first() ||
          $a.find("img").first();
        if (n && n.length) {
          const src = n.attr("data-src") || n.attr("data-original") || n.attr("src") || "";
          img = normalizeUrl(url, src);
        }
      }

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
    } catch {
      /* ignore single node errors */
    }
  });

  // 去重
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
      const type = ((node && node["@type"]) || "").toString().toLowerCase();
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
function parse($, url, { limit = 50, logger } = {}) {
  // 1) DOM 优先
  let dom = fromDom($, url, limit);

  // 2) 必要时补 JSON-LD
  const needJsonLd = dom.length === 0 || dom.filter(x => x.title).length < Math.min(5, dom.length);
  let viaJson = needJsonLd ? fromJsonLd($, url, limit) : [];

  // 3) 再试 deep anchors(深层 a[href])
  if ((dom.length + viaJson.length) === 0 || dom.length < 3) {
    const deep = deepAnchorFallback($, url, limit);
    viaJson = viaJson.length ? viaJson : deep;
    if (viaJson.length === 0 && deep.length > 0) {
      viaJson = deep;
    } else if (viaJson.length && deep.length) {
      const map = new Map(viaJson.map(p => [stripFragment(p.url), p]));
      for (const d of deep) {
        const key = stripFragment(d.url);
        if (!map.has(key)) map.set(key, d);
      }
      viaJson = Array.from(map.values()).slice(0, limit);
    }
  }

  const merged = mergePreferDom(dom, viaJson).slice(0, limit);

  // 4) 如果还没有，就调用 genericLinks 作为最后手段（Cheerio 还在）
  if (!merged.length) {
    try {
      const generic = require('./genericLinksParser');
      if (generic && typeof generic.parse === 'function') {
        const more = generic.parse($, url, { limit, logger, hint: 'shopify' }) || [];
        if (Array.isArray(more) && more.length) return more.slice(0, limit);
      }
    } catch {}
  }

  // 5) 记录空结果
  if (!merged.length) {
    try {
      const host = new URL(url).host;
      console.debug(`[catalog] NoProductFound in ${host} (shopify) -> ${url}`);
    } catch {
      console.debug(`[catalog] NoProductFound (shopify) -> ${url}`);
    }
  }

  return merged;
}

function parseShopify($, url, opts = {}) {
  return parse($, url, opts);
}

module.exports = {
  default: parse,
  parse,
  parseShopify,
};
