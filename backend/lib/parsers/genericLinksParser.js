// backend/adapters/genericLinksParser.js
// Express 路由模块（ESM），提供 POST /adapters/generic-links
// 请求体：{ url: string, html?: string, scope?: string }
// 若未传 html，则会按 url 抓取页面；最终返回 parseGenericLinks() 的结构化结果。

import express from "express";
import * as cheerio from "cheerio";
import loggerBase from "../logger.js";

// Node 18+ 自带 fetch；兼容性兜底
const fetchFn = globalThis.fetch ?? (await import("node-fetch")).default;
const logger = loggerBase || console;

const router = express.Router();

// ===== 辅助函数（与旧 parser 同源，做了路由化与方法收口） =====

function cleanText(s = "") {
  try {
    return String(s).replace(/\s+/g, " ").replace(/[\u00A0\u200B\u200C\u200D]+/g, " ").trim();
  } catch {
    return s || "";
  }
}

function absolutize(url = "", pageUrl = "") {
  if (!url) return "";
  try {
    if (/^https?:\/\//i.test(url)) return url;
    const base = new URL(pageUrl);
    const abs = new URL(url, base.origin);
    return abs.toString();
  } catch {
    return url;
  }
}

function splitSkuAndName(raw = "") {
  const s = cleanText(raw);
  if (!s) return { sku: "", rest: "" };
  const m = s.match(/^([A-Za-z0-9._\-\/]+)\s+(.+)$/);
  if (m) return { sku: m[1], rest: m[2] };
  return { sku: s, rest: "" };
}

function normalizePrice(str = "") {
  const s = cleanText(str);
  const curMatch = s.match(/(€|\$|£|CHF|EUR|USD|GBP)/i);
  let currency = "";
  if (curMatch) {
    const c = curMatch[1].toUpperCase();
    if (c === "€") currency = "EUR";
    else if (c === "£") currency = "GBP";
    else if (c === "$") currency = "USD";
    else currency = c;
  }
  const numRaw = s.replace(/[^0-9,\.\-]/g, " ");
  const tokens = numRaw.split(/\s+/).filter(Boolean);
  let numeric = "";
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (/^-?\d{1,3}([\.,]\d{3})*([\.,]\d{2})?$/.test(t) || /^-?\d+(\.\d+)?$/.test(t)) {
      numeric = t;
      break;
    }
  }
  if (!numeric && tokens.length) numeric = tokens[tokens.length - 1] || "";
  if (numeric.includes(",") && !numeric.includes(".")) numeric = numeric.replace(",", ".");
  else if ((numeric.match(/\./g) || []).length > 1) numeric = numeric.replace(/\.(?=\d{3}(\D|$))/g, "");
  const final = numeric.match(/-?\d+(\.\d+)?/);
  return { price: final ? final[0] : "", currency: currency || "" };
}

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
const NAV_WORDS = ["home","start","audio","video","strom","multimedia","b-run","solar","computer","about","news","contact","company","message","industry","network","impressum","privacy","datenschutz","agb","catalog","katalog","categories","marken","brands","solutions","services","download","downloads","support","produkte","produkteübersicht"];

function sameOrigin(a, b) {
  try {
    const A = new URL(a); const B = new URL(b);
    return A.origin === B.origin;
  } catch { return false; }
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
    .replace(/\b(home|start|audio|video|strom|multimedia|b-run|solar)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length > 140) t = t.slice(0, 140).trim();
  return t;
}

function pickImg($el) {
  const $img = $el.find("img").first();
  if ($img.length) {
    const srcset = $img.attr("srcset") || $img.attr("data-srcset") || "";
    const list = srcset.split(",").map(s => s.trim().split(/\s+/)[0]).filter(Boolean);
    const ds = $img.attr("data-src") || "";
    const s  = $img.attr("src") || "";
    const cand = [...list, ds, s].filter(Boolean);
    const prefer = cand.find(u => /\.(jpe?g|png|gif)(\?|$)/i.test(u));
    return prefer || cand[0] || "";
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
  if (/(impressum|privacy|datenschutz|agb|terms|policy|kontakt|contact|login|account|register)/.test(hp)) return true;
  return false;
}

function absUrl(base, href) {
  try { return new URL(href, base).toString(); } catch { return null; }
}

function extractPriceFrom($, $scope) {
  const text = nearText($, $scope);
  const m = text.match(PRICE_RE);
  return m ? m[0].trim() : "";
}

function uniqBy(arr, keyFn) {
  const seen = new Set(); const out = [];
  for (const it of arr) {
    const k = keyFn(it);
    if (!seen.has(k)) { seen.add(k); out.push(it); }
  }
  return out;
}

function finalize(products, pageUrl) {
  return products
    .map((p) => {
      const titleClean = cleanText(p.title || "");
      const { sku, rest } = splitSkuAndName(titleClean);
      const priceInfo = normalizePrice(p.price || "");
      const urlAbs = absolutize(p.url || p.link || "", pageUrl);
      const imgAbs = absolutize(p.img || "", pageUrl);
      return {
        sku: sku || "",
        title: rest || titleClean,
        url: urlAbs,
        img: imgAbs || "",
        price: priceInfo.price || "",
        currency: priceInfo.currency || "",
        desc: p.desc || rest || titleClean || "",
      };
    })
    .filter((p) => p.url && (p.title || p.sku))
    .slice(0, MAX_RESULTS);
}

// —— 抽取策略 —— //
async function parseByPrimaryAreas($, pageUrl, log) {
  const items = [];
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

      items.push({ url: hrefAbs, title, price, img: pickImg($card) });
    });
  });
  log.debug?.(`[generic-links] primary areas extracted: ${items.length}`);
  return items;
}

async function parseByDeepAnchors($, pageUrl, log) {
  const candidates = [];
  $("a[href]").each((_, a) => {
    const $a = $(a);
    const rawHref = $a.attr("href") || "";
    const hrefAbs = absUrl(pageUrl, rawHref);
    if (!hrefAbs) return;

    const text = cleanTitle($a.attr("title") || $a.text() || $a.find("img").attr("alt") || "");
    if (!text) return;
    if (looksLikeJunk(text, hrefAbs, pageUrl)) return;

    const $card = $a.closest("article, li, .card, .product, .product-card, .productbox, .grid__item, .tile, .box");
    const price = $card.length ? extractPriceFrom($, $card) : "";
    const s = scoreHref(hrefAbs, `${text} ${price}`);
    if (s <= 0) return;

    candidates.push({ url: hrefAbs, title: text, price, score: s, img: pickImg($card.length ? $card : $a) });
  });

  const unique = uniqBy(candidates, (it) => it.url);
  unique.sort((a, b) => b.score - a.score);
  const top = unique.slice(0, MAX_RESULTS);
  logger.debug?.(`[generic-links] deep anchors extracted: ${top.length}`);
  return top;
}

// —— 核心解析：对外方法 —— //
export async function parseGenericLinks({ html, url: pageUrl, scope }) {
  const log = logger;
  const $ = cheerio.load(html, { decodeEntities: true });
  try {
    let items = await parseByPrimaryAreas($, pageUrl, log);
    if (items.length < MIN_PRIMARY_HITS) {
      log.info?.(`[generic-links] primary hits=${items.length} < ${MIN_PRIMARY_HITS}, fallback to deep a[href]…`);
      const deep = await parseByDeepAnchors($, pageUrl, log);
      items = uniqBy([...items, ...deep], (it) => it.url);
    }
    const products = finalize(items, pageUrl);
    log.info?.(`[generic-links] done for ${pageUrl} (scope=${scope || "full"}) => ${products.length} items`);
    if (!products.length) {
      log.warn?.("[links] NoProductFound in generic-links parser");
      log.warn?.(`[NoProductFound] ${pageUrl} (generic-links scope=${scope || "full"})`);
    }
    return { ok: true, adapter: "generic-links", url: pageUrl, count: products.length, products };
  } catch (e) {
    log.error?.(`[generic-links] error on ${pageUrl}: ${e.message}`);
    return { ok: false, adapter: "generic-links", url: pageUrl, count: 0, products: [], error: e.message };
  }
}

// —— 路由：POST /adapters/generic-links —— //
router.post("/generic-links", express.json({ limit: "1mb" }), async (req, res) => {
  try {
    const { url, html: htmlFromBody, scope } = req.body || {};
    if (!url && !htmlFromBody) {
      return res.status(400).json({ ok: false, error: "url 或 html 至少提供一个" });
    }

    let pageUrl = url;
    let html = htmlFromBody;

    if (!html) {
      if (!/^https?:\/\//i.test(url)) {
        return res.status(400).json({ ok: false, error: "无效的 URL" });
      }
      const r = await fetchFn(url, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
          "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });
      if (!r.ok) {
        return res.status(502).json({ ok: false, error: `抓取失败：HTTP ${r.status}` });
      }
      html = await r.text();
      pageUrl = r.url || url;
    }

    const result = await parseGenericLinks({ html, url: pageUrl, scope });
    res.status(result.ok ? 200 : 500).json(result);
  } catch (err) {
    logger.error?.(`[/adapters/generic-links] ${err?.stack || err?.message}`);
    res.status(500).json({ ok: false, error: err?.message || "UNKNOWN" });
  }
});

export default router;

// —— 可选：让主应用轻松挂载 ——
// 在 app.js 里：
//   import genericLinksRouter from "./adapters/genericLinksParser.js";
//   app.use("/adapters", genericLinksRouter);
