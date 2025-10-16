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
  // 需要 /products/，且排除评论锚点等
  if (!u.includes("/products/")) return false;
  if (u.includes("#reviews") || u.includes("reviewssection") || u.includes("/reviews")) return false;
  return true;
}

function isJunkTitle(title = "") {
  const t = title.toLowerCase();
  return (
    t.includes("bewertungen") || // 德语：评价
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
    // 常见卡片
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

  // 去重（以移除 fragment 的 URL 为键）
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

// ===== 深度兜底：扫描整页 a[href*="/products/"] =====
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

      // 标题：优先 a 文本，其次 title/aria-label，再其次邻近标题节点
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

      // 价格：在最近容器内找 price 相关节点
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
      }
      // 图片：就近找 img
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
function parse($, url, { limit = 50 } = {}) {
  // 1) 先尝试卡片 DOM
  let dom = fromDom($, url, limit);

  // 2) 视情况触发 JSON-LD
  const needJsonLd = dom.length === 0 || dom.filter(x => x.title).length < Math.min(5, dom.length);
  let viaJson = needJsonLd ? fromJsonLd($, url, limit) : [];

  // 3) 如果仍几乎没有结果，再做深度锚点兜底
  if ((dom.length + viaJson.length) === 0 || dom.length < 3) {
    const deep = deepAnchorFallback($, url, limit);
    // 为了避免覆盖已有更完整的数据，这里把 deep 作为“补充”合并进去
    viaJson = viaJson.length ? viaJson : deep;
    if (viaJson.length === 0 && deep.length > 0) {
      viaJson = deep;
    } else if (viaJson.length && deep.length) {
      // 合并去重
      const map = new Map(viaJson.map(p => [stripFragment(p.url), p]));
      for (const d of deep) {
        const key = stripFragment(d.url);
        if (!map.has(key)) map.set(key, d);
      }
      viaJson = Array.from(map.values()).slice(0, limit);
    }
  }

  const merged = mergePreferDom(dom, viaJson).slice(0, limit);

  // 4) 无结果日志
  if (!merged.length) {
    try {
      const host = new URL(url).host;
      // 调试日志，不会影响用户界面
      // 供你排查“页面被误判为目录/主页”或“DOM 结构过深”情况
      // 关键字：NoProductFound
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
