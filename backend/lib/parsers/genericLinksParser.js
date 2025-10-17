// backend/lib/parsers/genericLinksParser.js
// 通用“目录页 -> 产品链接”解析器（带深层 a[href] 兜底）
// 返回结构与现有前端期望保持一致：{ ok, adapter: "generic-links", url, count, products }

const { URL } = require("url");

// --- 可调参数 ---------------------------------------------------------------
const MAX_RESULTS = 200;           // 最多回传多少条
const MIN_PRIMARY_HITS = 6;        // 主选择器命中少于此数则触发 deepAnchorFallback
const NEAR_PRICE_DISTANCE = 160;   // 在同一卡片内查找价格的最大字符距离
// ---------------------------------------------------------------------------

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

// 常见产品容器（先在这些区块里找）
const PRIMARY_AREAS = [
  "main",".main","#main","#content",".content",".container",
  ".product-grid",".products",".product-list",".listing",".catalog",".category",
  "[data-product-id]","[data-product]","[data-qa='product']"
];

// 价格识别（支持欧式小数与多货币）
const PRICE_RE = /(?:^|[^\d])(?:(?:€|CHF|PLN|zł|zł\.?|₺|£|\$)\s*)?\d{1,3}(?:[.\s]\d{3})*(?:[,\.\s]\d{2})\s*(?:€|CHF|PLN|zł|zł\.?|₺|£|\$)?/i;

// 一些导航词，命中则降低评分/剔除
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

  // 去掉导航/动作词
  t = t.replace(/\b(add to cart|in den warenkorb|jetzt kaufen|buy now)\b/ig, "");
  t = t.replace(/\b(home|start|audio|video|strom|multimedia|b-run|solar)\b/ig, " ").replace(/\s+/g, " ").trim();

  // 去掉过长/过短
  if (t.length > 140) t = t.slice(0, 140).trim();
  return t;
}

function pickImg($el) {
  // 取 img 的 data-src/src/srcset
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
  // 卡片内拿到尽可能多的可见文本（用于找价格）
  const txt = $el.text().replace(/\s+/g, " ").trim();
  return txt.slice(0, NEAR_PRICE_DISTANCE);
}

function scoreHref(href, text) {
  let score = 0;
  const sHref = (href || "").toLowerCase();
  const sTxt = (text || "").toLowerCase();

  if (PRODUCTY_HINTS.some(h => sHref.includes(h))) score += 3;
  if (PRICE_RE.test(sTxt)) score += 2;

  // 导航词扣分
  if (includesAny(sTxt, NAV_WORDS)) score -= 2;

  // 详情页路径常见模式
  if (/(?:\/p\/|\/pd\/|\/detail|\/details|\/produkt|\/product)/.test(sHref)) score += 2;

  // 文件/锚点扣分
  if (isAssetHref(sHref) || sHref.startsWith("#")) score -= 3;

  return score;
}

function looksLikeJunk(text, hrefAbs, pageUrl) {
  if (!sameOrigin(pageUrl, hrefAbs)) return true;
  if (isAssetHref(hrefAbs)) return true;

  const lower = (text || "").toLowerCase();
  if (includesAny(lower, JUNK_KEYWORDS)) return true;

  // 典型“首页/法律页”路径关键词
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
  // 只保留 title/url，并裁剪数量
  return products
    .map(p => ({
      sku: p.sku || "",
      title: cleanTitle(p.title || ""),
      url: p.url
    }))
    .filter(p => p.url && p.title)    // 没标题/没链接的丢弃
    .slice(0, MAX_RESULTS);
}

async function parseByPrimaryAreas($, pageUrl, logger) {
  const items = [];
  const areas = PRIMARY_AREAS.join(",");

  $(areas).each((_, area) => {
    const $area = $(area);
    // 常见“卡片”
    const cards = $area.find(`
      .product, .product-card, .card, .product-item, .productbox, 
      li, article, .grid__item, .box, .tile
    `);
    if (!cards.length) return;

    cards.each((__, card) => {
      const $card = $(card);
      // 卡片里最可能的链接
      let $a = $card.find("a[href]").filter((i, a) => {
        const href = $(a).attr("href") || "";
        return !href.startsWith("#");
      }).first();

      if (!$a.length) return;
      const hrefAbs = absUrl(pageUrl, $a.attr("href"));
      if (!hrefAbs) return;

      const title =
        cleanTitle(
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

async function parseByDeepAnchors($, pageUrl, logger) {
  const candidates = [];

  $("a[href]").each((_, a) => {
    const $a = $(a);
    const rawHref = $a.attr("href") || "";
    const hrefAbs = absUrl(pageUrl, rawHref);
    if (!hrefAbs) return;

    const text = cleanTitle(
      $a.attr("title") || $a.text() || $a.find("img").attr("alt") || ""
    );

    if (!text) return;
    if (looksLikeJunk(text, hrefAbs, pageUrl)) return;

    const $card = $a.closest("article, li, .card, .product, .product-card, .productbox, .grid__item, .tile, .box");
    const price = $card.length ? extractPriceFrom($, $card) : "";

    const s = scoreHref(hrefAbs, `${text} ${price}`);
    if (s <= 0) return; // 只收“像产品”的链接

    candidates.push({
      url: hrefAbs,
      title: text,
      price,
      score: s,
      img: pickImg($card.length ? $card : $a)
    });
  });

  // 去重 + 评分排序
  const unique = uniqBy(candidates, it => it.url);
  unique.sort((a, b) => b.score - a.score);

  const top = unique.slice(0, MAX_RESULTS);
  logger.debug?.(`[generic-links] deep anchors extracted: ${top.length}`);
  return top;
}

// 统一入口
module.exports = async function genericLinksParser(ctx) {
  const { $, url: pageUrl } = ctx;
  const logger = getLogger(ctx);

  try {
    let items = await parseByPrimaryAreas($, pageUrl, logger);

    if (items.length < MIN_PRIMARY_HITS) {
      logger.info?.(`[generic-links] primary hits=${items.length} < ${MIN_PRIMARY_HITS}, fallback to deep a[href]…`);
      const deep = await parseByDeepAnchors($, pageUrl, logger);

      // 优先保留 primary，再补充 deep
      const merged = uniqBy([...items, ...deep], it => it.url);
      items = merged;
    }

    // 最终清洗
    const products = finalize(items);
    logger.info?.(`[generic-links] done for ${pageUrl} => ${products.length} items`);

    // “无产品”日志（给你排查时看）
    if (!products.length) {
      logger.warn?.(`[NoProductFound] ${pageUrl} (generic-links)`);
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
