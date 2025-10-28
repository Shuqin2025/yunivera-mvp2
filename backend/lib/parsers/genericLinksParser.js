// backend/lib/parsers/genericLinksParser.js
// ESM version

import { URL } from "url";

// try to reuse your logger if available, fallback to console
import loggerBase from "../logger.js";

const logger = loggerBase || console;

const MAX_RESULTS = 200;
const MIN_PRIMARY_HITS = 6;
const NEAR_PRICE_DISTANCE = 160;

const JUNK_KEYWORDS = [
  "login","anmelden","account","register","signup","password","passwort",
  "cart","warenkorb","basket","checkout","kasse",
  "help","hilfe","support","kundendienst","kundenservice","faq",
  "about","über uns","ueber uns","impressum","datenschutz","privacy","agb","widerruf",
  "versand","shipping","zahlung","payment","kontakt","contact",
  "newsletter","sitemap","policy","terms","bedingungen",
  "blog","news","rss","social"
];

const PRODUCTY_HINTS = [
  "product","produkt","artikel","item","sku","p/","/p-","/prod","/shop/",
  "/detail","/details","/kaufen","/buy","/add-to-cart"
];

const PRIMARY_AREAS = [
  ".product-grid",".products",".product-list",".listing",".catalog",".category",
  "[data-product-id]","[data-product]","[data-qa='product']",
  ".main",".container",".content","#main","#content","main"
];

const PRICE_RE = /(?:^|[^\d])(?:(?:€|CHF|PLN|zł|zł\.?|₺|£|\$)\s*)?\d{1,3}(?:[.\s]\d{3})*(?:[,\.\s]\d{2})\s*(?:€|CHF|PLN|zł|zł\.?|₺|£|\$)?/i;
const NAV_WORDS = ["home","start","audio","video","strom","multimedia","b-run","solar","computer"];

function sameOrigin(a, b) {
  try {
    const A = new URL(a);
    const B = new URL(b);
    return A.origin === B.origin;
  } catch {
    return false;
  }
}

function isAssetHref(href) {
  return /\.(?:jpg|jpeg|png|webp|gif|svg|pdf|docx?|xlsx?|zip|rar)$/i.test(href);
}

function includesAny(haystack, words) {
  const s = (haystack || "").toLowerCase();
  return words.some((w) => s.includes(w));
}

function cleanTitle(txt) {
  if (!txt) return "";
  let t = txt.replace(/\s+/g, " ").trim();

  t = t.replace(/\b(add to cart|in den warenkorb|jetzt kaufen|buy now)\b/gi, "");
  t = t
    .replace(
      /\b(home|start|audio|video|strom|multimedia|b-run|solar)\b/gi,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();

  if (t.length > 140) t = t.slice(0, 140).trim();
  return t;
}

function pickImg($el) {
  const $img = $el.find("img").first();
  if ($img.length) {
    const srcset = $img.attr("srcset") || $img.attr("data-srcset");
    if (srcset) {
      const first = srcset.split(",")[0].trim().split(/\s+/)[0];
      return first;
    }
    return (
      $img.attr("data-src") ||
      $img.attr("src") ||
      ""
    );
  }
  return "";
}

function nearText($, $el) {
  const txt = $el.text().replace(/\s+/g, " ").trim();
  return txt.slice(0, NEAR_PRICE_DISTANCE);
}

function scoreHref(href, text) {
  let score = 0;
  const sHref = (href || "").toLowerCase();
  const sTxt = (text || "").toLowerCase();

  if (PRODUCTY_HINTS.some((h) => sHref.includes(h))) score += 3;
  if (PRICE_RE.test(sTxt)) score += 2;

  if (includesAny(sTxt, NAV_WORDS)) score -= 2;

  if (/(?:\/p\/|\/pd\/|\/detail|\/details|\/produkt|\/product)/.test(sHref))
    score += 2;

  if (isAssetHref(sHref) || sHref.startsWith("#")) score -= 3;

  return score;
}

function looksLikeJunk(text, hrefAbs, pageUrl) {
  if (!sameOrigin(pageUrl, hrefAbs)) return true;
  if (isAssetHref(hrefAbs)) return true;

  const lower = (text || "").toLowerCase();
  if (includesAny(lower, JUNK_KEYWORDS)) return true;

  const hp = hrefAbs.toLowerCase();
  if (
    /(impressum|privacy|datenschutz|agb|terms|policy|kontakt|contact|login|account|register)/.test(
      hp
    )
  )
    return true;

  return false;
}

function absUrl(base, href) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function extractPriceFrom($, $scope) {
  const text = nearText($, $scope);
  const m = text.match(PRICE_RE);
  return m ? m[0].trim() : "";
}

function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const it of arr) {
    const k = keyFn(it);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(it);
    }
  }
  return out;
}

function finalize(products) {
  return products
    .map((p) => ({
      sku: p.sku || "",
      title: cleanTitle(p.title || ""),
      url: p.url,
      img: p.img || "",
      price: p.price || "",
      currency: p.currency || "",
      desc: p.desc || "",
    }))
    .filter((p) => p.url && p.title)
    .slice(0, MAX_RESULTS);
}

// -- extraction helpers -------------------------------------------------

async function parseByPrimaryAreas($, pageUrl, log) {
  const items = [];

  // 多个候选容器
  const areas = PRIMARY_AREAS.join(",");

  $(areas).each((_, area) => {
    const $area = $(area);

    const cards = $area.find(`
      .product, .product-card, .card, .product-item, .productbox,
      li, article, .grid__item, .box, .tile
    `);

    if (!cards.length) return;

    cards.each((__, card) => {
      const $card = $(card);

      // 挑第一个带 href 的链接
      let $a = $card
        .find("a[href]")
        .filter((i, a) => {
          const href = $(a).attr("href") || "";
          return !href.startsWith("#");
        })
        .first();

      if (!$a.length) return;
      const hrefAbs = absUrl(pageUrl, $a.attr("href"));
      if (!hrefAbs) return;

      const title = cleanTitle(
        $a.attr("title") ||
          $a.text() ||
          $card.find("[itemprop='name']").text() ||
          $card.find(".product-title, .title").text()
      );

      if (!title) return;
      if (looksLikeJunk(title, hrefAbs, pageUrl)) return;

      const price =
        $card.find("[itemprop='price']").attr("content") ||
        $card.find("[data-price]").attr("data-price") ||
        extractPriceFrom($, $card);

      items.push({
        url: hrefAbs,
        title,
        price,
        img: pickImg($card),
      });
    });
  });

  log.debug?.(
    `[generic-links] primary areas extracted: ${items.length}`
  );
  return items;
}

async function parseByDeepAnchors($, pageUrl, log) {
  const candidates = [];

  $("a[href]").each((_, a) => {
    const $a = $(a);
    const rawHref = $a.attr("href") || "";
    const hrefAbs = absUrl(pageUrl, rawHref);
    if (!hrefAbs) return;

    const text = cleanTitle(
      $a.attr("title") ||
        $a.text() ||
        $a.find("img").attr("alt") ||
        ""
    );

    if (!text) return;
    if (looksLikeJunk(text, hrefAbs, pageUrl)) return;

    const $card = $a.closest(
      "article, li, .card, .product, .product-card, .productbox, .grid__item, .tile, .box"
    );
    const price = $card.length ? extractPriceFrom($, $card) : "";

    const s = scoreHref(hrefAbs, `${text} ${price}`);
    if (s <= 0) return;

    candidates.push({
      url: hrefAbs,
      title: text,
      price,
      score: s,
      img: pickImg($card.length ? $card : $a),
    });
  });

  const unique = uniqBy(candidates, (it) => it.url);
  unique.sort((a, b) => b.score - a.score);

  const top = unique.slice(0, MAX_RESULTS);
  logger.debug?.(
    `[generic-links] deep anchors extracted: ${top.length}`
  );
  return top;
}

// -- main export -------------------------------------------------------

export default async function genericLinksParser(ctx) {
  // ctx:
  //   $         cheerio instance (could be full page or rootOnly fragment)
  //   url       pageUrl
  //   scope     "rootOnly" | undefined
  //   logger    optional
  const { $, url: pageUrl, scope } = ctx;
  const log = ctx.logger || logger;

  try {
    // 1. rootOnly 模式下，parseByPrimaryAreas 命中率更高
    let items = await parseByPrimaryAreas($, pageUrl, log);

    // 2. 如果主容器卡片不足，fallback 深层 a[href] 扫描
    if (items.length < MIN_PRIMARY_HITS) {
      log.info?.(
        `[generic-links] primary hits=${items.length} < ${MIN_PRIMARY_HITS}, fallback to deep a[href]…`
      );
      const deep = await parseByDeepAnchors($, pageUrl, log);
      const merged = uniqBy([...items, ...deep], (it) => it.url);
      items = merged;
    }

    // 3. 清洗 & 统一输出格式
    const products = finalize(items);

    log.info?.(
      `[generic-links] done for ${pageUrl} (scope=${scope || "full"}) => ${products.length} items`
    );

    // Debug 输出
    try {
      if (process.env.DEBUG) {
        const totalA = $("a[href]").length;
        console.log(
          "[links]",
          "total_a=",
          totalA,
          "emitted=",
          Array.isArray(items) ? items.length : -1,
          "base=",
          pageUrl,
          "scope=",
          scope || "full"
        );
      }
    } catch (_) {}

    if (!products.length) {
      log.warn?.("[links] NoProductFound in generic-links parser");
      log.warn?.(
        `[NoProductFound] ${pageUrl} (generic-links scope=${scope || "full"})`
      );
    }

    return {
      ok: true,
      adapter: "generic-links",
      url: pageUrl,
      count: products.length,
      products,
    };
  } catch (e) {
    log.error?.(`[generic-links] error on ${pageUrl}: ${e.message}`);
    return {
      ok: false,
      adapter: "generic-links",
      url: pageUrl,
      count: 0,
      products: [],
      error: e.message,
    };
  }
}
