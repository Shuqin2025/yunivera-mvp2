/* generic-links: stronger product-like link extraction with scoring */

function clean(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function abs(base, href) {
  try {
    if (!href) return "";
    if (/^\/\//.test(href)) return "https:" + href;
    if (/^https?:\/\//i.test(href)) return href;
    return new URL(href, base).toString();
  } catch {
    return href || "";
  }
}

function stripHash(u) {
  try {
    const x = new URL(u);
    x.hash = "";
    return x.toString();
  } catch {
    return (u || "").split("#")[0];
  }
}

/** 强排除关键词（文本或 URL 中出现即排除） */
const NAVY_WORDS = [
  "home","startseite","über uns","ueber uns","about","unternehmen",
  "kundenservice","hilfe","support","kontakt","contact","impressum",
  "agb","widerruf","widerrufsbelehrung","rückgabe","rueckgabe",
  "datenschutz","privacy","versand","versandkosten","zahlung","zahlungs",
  "info","blog","news","faq","newsletter",
  "anmelden","login","konto","account","registrieren","signup","warenkorb",
  "cart","checkout","kasse",
];

const NAVY_PATHS = [
  "/impressum","/agb","/widerruf","/datenschutz","/privacy",
  "/kontakt","/contact","/hilfe","/support",
  "/login","/account","/signup","/register",
  "/cart","/checkout","/warenkorb",
];

/** 产品型 URL 的正向特征（命中即加分） */
const PRODUCTY_PATH_CUES = [
  "/products/","/product/","/artikel/","/item/","/detail/",
  "/p/","/sku/","/shop/","/kategorie/","/category/","-p"
];

/** grid/listing 容器特征 */
const GRID_CUES = ["product","grid","listing","catalog","category","tile","card","box","result","item","teaser"];

/** 价格正则 */
const PRICE_RE = /(?:€|eur|£|gbp|\$|usd)\s*\d{1,4}(?:[.,]\d{2})?|\d{1,4}(?:[.,]\d{2})\s*(?:€|eur|£|gbp|\$|usd)/i;

function pickImg($scope, base) {
  const n = $scope.find("img").first();
  if (!n || !n.length) return "";
  const src = n.attr("data-src") || n.attr("data-original") || n.attr("src") || "";
  return abs(base, src);
}

function pickTitle($a, $scope) {
  let t = clean($a.text()) || clean($a.attr("title") || $a.attr("aria-label") || "");
  if (!t && $scope && $scope.length) {
    t = clean(
      $scope.find("[class*=title], [class*=heading], h1, h2, h3, [itemprop='name']").first().text()
    );
  }
  return t;
}

function pickPrice($scope) {
  if (!$scope || !$scope.length) return "";
  const p1 =
    clean(
      $scope
        .find("[class*=price], [class*=Price], price, [itemprop='price'], meta[itemprop='price']")
        .first()
        .text()
    ) || clean($scope.find("meta[itemprop='price']").attr("content") || "");
  if (p1) return p1;

  const txt = clean($scope.text());
  const m = txt.match(PRICE_RE);
  return m ? clean(m[0]) : "";
}

function isHardNav(link, text) {
  const lt = (text || "").toLowerCase();
  if (NAVY_WORDS.some(w => lt.includes(w))) return true;

  try {
    const u = new URL(link.toLowerCase());
    if (NAVY_PATHS.some(p => u.pathname.includes(p))) return true;
  } catch {
    if (NAVY_PATHS.some(p => (link || "").toLowerCase().includes(p))) return true;
  }
  return false;
}

function scoreCandidate($, $a, link) {
  let score = 0;
  const urlL = (link || "").toLowerCase();
  if (PRODUCTY_PATH_CUES.some(c => urlL.includes(c))) score += 3;

  const $scope = $a.closest("article,li,div,section");
  if ($scope && $scope.length) {
    const cls = ($scope.attr("class") || "").toLowerCase();
    if (GRID_CUES.some(c => cls.includes(c))) score += 2;

    const img = pickImg($scope, "");
    if (img) score += 2;

    const price = pickPrice($scope);
    if (price) score += 3;

    const title = pickTitle($a, $scope);
    if (title && title.length >= 4) score += 1;
  }
  if (/[/-]\d{3,}/.test(urlL)) score += 1;
  return score;
}

function parseGenericLinks($, url, { limit = 50 } = {}) {
  const out = [];
  const seen = new Set();

  $("a[href]").each((_, a) => {
    const $a = $(a);
    const link = abs(url, $a.attr("href") || "");
    if (!link) return;

    const text = clean($a.text() || $a.attr("title") || "");
    if (isHardNav(link, text)) return;

    const s = scoreCandidate($, $a, link);
    if (s <= 0) return;

    const $scope = $a.closest("article,li,div,section");
    const img = $scope && $scope.length ? pickImg($scope, url) : "";
    const price = $scope && $scope.length ? pickPrice($scope) : "";
    const title = $scope && $scope.length ? pickTitle($a, $scope) : text;

    const key = stripHash(link);
    if (!key || seen.has(key)) return;
    seen.add(key);

    out.push({
      title: title || "",
      url: link,
      link,
      img,
      imgs: img ? [img] : [],
      price,
      sku: "",
      desc: ""
    });
  });

  // 按得分从高到低（再算一次分避免 DOM 选择器定位不准）
  out.sort((a, b) => {
    const sa = scoreCandidate($, $("a[href='" + (a.url || "").replace(/"/g, '\\"') + "']"), a.url);
    const sb = scoreCandidate($, $("a[href='" + (b.url || "").replace(/"/g, '\\"') + "']"), b.url);
    return sb - sa;
  });

  const top = out.slice(0, limit);

  if (top.length === 0) {
    try {
      const host = new URL(url).host;
      console.debug(`[catalog] NoProductFound in ${host} (generic-links) -> ${url}`);
    } catch {
      console.debug(`[catalog] NoProductFound (generic-links) -> ${url}`);
    }
  }

  return top;
}

module.exports = {
  default: parseGenericLinks,
  parse: parseGenericLinks,
};
