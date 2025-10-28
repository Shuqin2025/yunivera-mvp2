// backend/lib/parsers/genericLinksParser.js (REVISED)
//
// 变化点：
//  - 支持 rootScope 模式（只解析 smartRootLocator 提供的主容器 DOM）
//  - 保留原始 Heuristics / deepAnchorFallback
//  - 输出格式不变，仍然给 catalog 那边用
//
// 注意：此文件目前仍是 CommonJS 风格（require/module.exports），
// 因为你现有项目里这个文件就是 require 风格。
// 如果你计划把后端整体迁到 ESM，需要同步调整 import/export。

const { URL } = require("url");

// --- DEBUG helper ---------------------------------------------------
let dbg = (...args) => {
  const on = process.env.DEBUG === '1' || process.env.DEBUG === 'true' || !!process.env.DEBUG;
  if (on) { try { console.log(...args); } catch {} }
};
try {
  const maybe = require('../logger.js');
  if (maybe && typeof maybe.dbg === 'function') dbg = maybe.dbg;
} catch { /* ignore */ }
// --------------------------------------------------------------------

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
  // 主容器提示。rootScope 模式下这些选择器仍然有用，
  // 因为有些站点在每个产品卡片内还有一层包裹。
  ".product-grid",".products",".product-list",".listing",".catalog",".category",
  "[data-product-id]","[data-product]","[data-qa='product']",
  ".main",".container",".content","#main","#content","main"
];

const PRICE_RE = /(?:^|[^\d])(?:(?:€|CHF|PLN|zł|zł\.?|₺|£|\$)\s*)?\d{1,3}(?:[.\s]\d{3})*(?:[,\.\s]\d{2})\s*(?:€|CHF|PLN|zł|zł\.?|₺|£|\$)?/i;
const NAV_WORDS = ["home","start","audio","video","strom","multimedia","b-run","solar","computer"];

function getLogger(ctx) {
  return (ctx && ctx.logger) || console;
}

function absUrl(base, href) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function sameOrigin(a, b) {
  try {
    const A = new URL(a), B = new URL(b);
    return A.origin === B.origin;
  } catch { return false; }
}

function isAssetHref(href) {
  return /\.(?:jpg|jpeg|png|webp|gif|svg|pdf|docx?|xlsx?|zip|rar)$/i.test(href);
}

function includesAny(haystack, words) {
  const s = (haystack || "").toLowerCase();
  return words.some(w => s.includes(w));
}

function cleanTitle(txt) {
  if (!txt) return "";
  let t = txt.replace(/\s+/g, " ").trim();

  t = t.replace(/\b(add to cart|in den warenkorb|jetzt kaufen|buy now)\b/ig, "");
  t = t.replace(/\b(home|start|audio|video|strom|multimedia|b-run|solar)\b/ig, " ").replace(/\s+/g, " ").trim();

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
    return $img.attr("data-src") || $img.attr("src") || "";
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

  if (PRODUCTY_HINTS.some(h => sHref.includes(h))) score += 3;
  if (PRICE_RE.test(sTxt)) score += 2;

  if (includesAny(sTxt, NAV_WORDS)) score -= 2;

  if (/(?:\/p\/|\/pd\/|\/detail|\/details|\/produkt|\/product)/.test(sHref)) score += 2;

  if (isAssetHref(sHref) || sHref.startsWith("#")) score -= 3;

  return score;
}

function looksLikeJunk(text, hrefAbs, pageUrl) {
  if (!sameOrigin(pageUrl, hrefAbs)) return true;
  if (isAssetHref(hrefAbs)) return true;

  const lower = (text || "").toLowerCase();
  if (includesAny(lower, JUNK_KEYWORDS)) return true;

  const hp = hrefAbs.toLowerCase();
  if (/(impressum|privacy|datenschutz|agb|terms|policy|kontakt|contact|login|account|register)/.test(hp))
    return true;

  return false;
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
    .map(p => ({
      sku: p.sku || "",
      title: cleanTitle(p.title || ""),
      url: p.url
    }))
    .filter(p => p.url && p.title)
    .slice(0, MAX_RESULTS);
}

// 解析主容器 / 卡片
async function parseByPrimaryAreas($, pageUrl, logger) {
  const items = [];

  // 这里的 areas 是一堆候选容器选择器
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

      let $a = $card.find("a[href]").filter((i, a) => {
        const href = $(a).attr("href") || "";
        return !href.startsWith("#");
      }).first();

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
        img: pickImg($card)
      });
    });
  });

  logger.debug?.(`[generic-links] primary areas extracted: ${items.length}`);
  return items;
}

// 深度 anchor 兜底
async function parseByDeepAnchors($, pageUrl, logger) {
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

    const $card = $a.closest("article, li, .card, .product, .product-card, .productbox, .grid__item, .tile, .box");
    const price = $card.length ? extractPriceFrom($, $card) : "";

    const s = scoreHref(hrefAbs, `${text} ${price}`);
    if (s <= 0) return;

    candidates.push({
      url: hrefAbs,
      title: text,
      price,
      score: s,
      img: pickImg($card.length ? $card : $a)
    });
  });

  const unique = uniqBy(candidates, it => it.url);
  unique.sort((a, b) => b.score - a.score);

  const top = unique.slice(0, MAX_RESULTS);
  getLogger().debug?.(`[generic-links] deep anchors extracted: ${top.length}`);
  return top;
}

// 统一入口：现在允许 scope="rootOnly"
module.exports = async function genericLinksParser(ctx) {
  // ctx:
  //   $         cheerio root (可能是整页，也可能是 smartRootLocator 的 root 片段)
  //   url       pageUrl
  //   scope     "rootOnly" | undefined
  //   logger    optional
  const { $, url: pageUrl, scope } = ctx;
  const logger = getLogger(ctx);

  try {
    // 1. 在 rootOnly 模式下，我们假定 $ 只包含产品主容器片段
    //    这时 parseByPrimaryAreas 的命中率会比全页扫描高很多
    let items = await parseByPrimaryAreas($, pageUrl, logger);

    // 2. 如果产品卡片还不够多，就 fallback deep anchors
    if (items.length < MIN_PRIMARY_HITS) {
      logger.info?.(
        `[generic-links] primary hits=${items.length} < ${MIN_PRIMARY_HITS}, fallback to deep a[href]…`
      );
      logger.debug?.('[links] deepAnchorFallback: entering');

      const deep = await parseByDeepAnchors($, pageUrl, logger);
      const merged = uniqBy([...items, ...deep], it => it.url);
      items = merged;
    }

    // 3. 最终清洗
    const products = finalize(items);
    logger.info?.(
      `[generic-links] done for ${pageUrl} (scope=${scope||"full"}) => ${products.length} items`
    );

    // Debug 输出
    try {
      if (process.env.DEBUG) {
        const totalA = $('a[href]').length;
        console.log(
          '[links]',
          'total_a=', totalA,
          'emitted=', Array.isArray(items) ? items.length : -1,
          'base=', pageUrl,
          'scope=', scope || 'full'
        );
      }
    } catch (_) {}

    // 无产品时的告警
    if (!products.length) {
      logger.warn?.('[links] NoProductFound in generic-links parser');
      logger.warn?.(`[NoProductFound] ${pageUrl} (generic-links scope=${scope||"full"})`);
    }

    return {
      ok: true,
      adapter: "generic-links",
      url: pageUrl,
      count: products.length,
      products
    };
  } catch (e) {
    logger.error?.(`[generic-links] error on ${pageUrl}: ${e.message}`);
    return {
      ok: false,
      adapter: "generic-links",
      url: pageUrl,
      count: 0,
      products: [],
      error: e.message
    };
  }
};
