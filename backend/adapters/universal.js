import * as cheerio from "cheerio";
import * as http from "../lib/http.js";
import * as images from "../lib/images.js";
import { crawlPages } from "../lib/pagination.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// ---------------- utils ----------------
function abs(base, href) { if (!href) return ""; try { return new URL(href, base).href; } catch { return ""; } }
function text($el) { return ($el.text() || "").replace(/\s+/g, " ").trim(); }
function firstSrcFromSet(ss) {
  if (!ss) return "";
  const cand = ss.split(",").map(s => s.trim().split(/\s+/)[0]).find(s => /^https?:/i.test(s));
  return cand || "";
}
function cleanUrl(u, base) {
  try { const x = new URL(u, base || undefined); x.search = ""; x.hash = ""; return x.href; } catch { return u || ""; }
}

// ---- 兜底取图 ----
function fallbackPickImg($root, base) {
  const $img = $root.find("img").first();
  const src =
    $img.attr("data-src") || $img.attr("data-original") || $img.attr("data-lazy") ||
    $img.attr("data-zoom-image") || firstSrcFromSet($img.attr("srcset")) || $img.attr("src") || "";
  return abs(base, (src || "").split("?")[0]);
}
function pickImg($root, base) {
  if (images && typeof images.pickImage === "function") return images.pickImage($root, base) || "";
  return fallbackPickImg($root, base);
}

function guessSkuFromTitle(title) {
  if (!title) return "";
  const m = title.match(/\b[0-9]{4,}\b/) || title.match(/\b[A-Z0-9][A-Z0-9-]{3,}\b/);
  return m ? m[0] : "";
}
function findPrice($card) {
  let s = text($card.find(".price,.product-price,.amount,.money,.m-price,.price__value,.price-value").first());
  if (!s) {
    const m = ($card.text() || "").match(/\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})\s*(?:€|EUR)/i);
    if (m) s = m[0].replace(/\s+/g, " ");
  }
  return s || null;
}

// ============ 详情覆写（强标签） ============
function looksLikePruef(v) { return v ? /^48\d{6,10}$/.test(String(v).trim()) : false; }

// 只认这些“强标签”
const LABEL_STRONG_FUZZY =
  /(artikel\s*[-–—]?\s*nr\.?|artikelnummer|art\.\s*[-–—]?\s*nr\.?|bestellnummer|item\s*no\.?|sku|mpn)/i;
// 显式排除
const LABEL_BAD = /(prüfziffer|hersteller-?nr\.?|hersteller)/i;
// JSON-LD 键名归一化 + 优先级
const KEY_PRIORITY = ["artikelnummer","artikel-nr","art.-nr","bestellnummer","itemno","sku","mpn"];
function normKey(k){ return String(k||"").toLowerCase().replace(/[\s._-]/g,""); }

// 支持“行内：标签:值”
function extractInlineLabelValue(s) {
  if (!s) return "";
  const reList = [
    /(?:Artikel\s*[-–—]?\s*Nr|Artikelnummer|Art\.\s*[-–—]?\s*Nr)\s*[:#]?\s*([A-Z0-9._\-\/]+)/i,
    /\bBestellnummer\s*[:#]?\s*([A-Z0-9._\-\/]+)/i,
    /\bItem\s*no\.?\s*[:#]?\s*([A-Z0-9._\-\/]+)/i,
    /\bSKU\s*[:#]?\s*([A-Z0-9._\-\/]+)/i,
    /\bMPN\s*[:#]?\s*([A-Z0-9._\-\/]+)/i,
  ];
  for (const re of reList) {
    const m = s.match(re);
    if (m && m[1]) return String(m[1]).trim();
  }
  return "";
}

// -------------- 详情页识别 & 详情抽取 --------------
function isDetailPage($) {
  // 明确信号：OpenGraph Product
  const ogType = $('meta[property="og:type"]').attr("content") || "";
  if (/product/i.test(ogType)) return true;

  // 有明显的商品主标题 + 购买区域
  const hasH1 = !!$("h1").first().text().trim();
  const hasBuy = !!($('form[action*="cart" i], form[action*="warenkorb" i]').length ||
                    $('button, a').filter((_,el) => /in den warenkorb|add to cart/i.test($(el).text())).length);
  if (hasH1 && hasBuy) return true;

  // 面包屑最后一个是当前商品名（许多德站常见）
  const $bcLast = $('.breadcrumb li:last, .breadcrumbs li:last, nav[aria-label="breadcrumb"] li:last').last();
  if ($bcLast.length && $bcLast.find("a").length === 0 && $bcLast.text().trim().length > 0) return true;

  // ★ 新增：只要页面上能抽到一个“强标签 SKU”，也视作详情页（兜底）
  if (extractSkuFromDocument($)) return true;

  return false;
}

function extractSkuFromDocument($) {
  let found = "";

  // Shopware 常见展示
  if (!found) {
    const $blk = $('.entry--sku, .product--ordernumber, .is--ordernumber').first();
    if ($blk.length) {
      const raw = text($blk);
      const inline = extractInlineLabelValue(raw) || raw.replace(/^.*?:\s*/, "");
      if (inline && !LABEL_BAD.test(raw)) found = inline.trim();
    }
  }
  // itemprop / data-sku / meta
  if (!found) {
    const $m = $('[itemprop="sku"],[data-sku],meta[name="sku"],meta[itemprop="sku"]').first();
    if ($m.length) {
      const v = $m.attr("content") || $m.attr("data-sku") || text($m);
      if (v) found = String(v).trim();
    }
  }
  // JSON-LD
  if (!found) {
    $('script[type="application/ld+json"]').each((_i, el) => {
      if (found) return;
      try{
        const raw = $(el).contents().text().trim(); if (!raw) return;
        const data = JSON.parse(raw); const arr = Array.isArray(data) ? data : [data];
        for (const obj of arr) {
          const dict = Object.create(null);
          for (const [k,v] of Object.entries(obj)) {
            if (LABEL_BAD.test(k)) continue;
            dict[normKey(k)] = v;
          }
          for (const want of KEY_PRIORITY) {
            if (dict[want]) { const v = String(dict[want]).trim(); if (v) { found = v; break; } }
          }
          if (found) break;
        }
      }catch{}
    });
  }
  // <dl>/<table>
  if (!found) {
    $("dl").each((_, dl) => {
      if (found) return false;
      $(dl).find("dt").each((_j, dt) => {
        const k = text($(dt));
        if (LABEL_STRONG_FUZZY.test(k) && !LABEL_BAD.test(k)) {
          const v = text($(dt).next("dd"));
          if (v) { found = v; return false; }
          const inline = extractInlineLabelValue(k);
          if (inline) { found = inline; return false; }
        }
      });
    });
  }
  if (!found) {
    $("table").each((_, tb) => {
      if (found) return false;
      $(tb).find("tr").each((_j, tr) => {
        const $cells = $(tr).find("th,td");
        const th = text($cells.first());
        const td = text($cells.last());
        if (LABEL_STRONG_FUZZY.test(th) && !LABEL_BAD.test(th) && td) { found = td; return false; }
        const inline = extractInlineLabelValue(th);
        if (!found && inline) { found = inline; return false; }
      });
    });
  }
  // 全文兜底
  if (!found) {
    const body = $("body").text().replace(/\s+/g," ");
    const reList = [
      /(?:Artikel\s*[-–—]?\s*Nr|Artikelnummer|Art\.\s*[-–—]?\s*Nr)\s*[:#]?\s*([A-Z0-9._\-\/]+)/i,
      /\bBestellnummer\s*[:#]?\s*([A-Z0-9._\-\/]+)/i,
      /\bItem\s*no\.?\s*[:#]?\s*([A-Z0-9._\-\/]+)/i,
      /\bSKU\s*[:#]?\s*([A-Z0-9._\-\/]+)/i,
      /\bMPN\s*[:#]?\s*([A-Z0-9._\-\/]+)/i,
    ];
    for (const re of reList) {
      const m = body.match(re);
      if (m && m[1] && !/^prüfziffer/i.test(m[0]) && !looksLikePruef(m[1])) { found = m[1].trim(); break; }
    }
  }
  return found || "";
}

function pickDetailImage($, base) {
  // 先 og:image
  const og = $('meta[property="og:image"]').attr("content");
  if (og) return abs(base, og.split("?")[0]);
  // 再主图容器
  const $hero = $('.image--container,.product--image,img.product--image,.product-gallery').first();
  if ($hero.length) {
    const $img = $hero.find("img").first();
    const src = $img.attr("data-zoom-image") || $img.attr("data-src") || firstSrcFromSet($img.attr("srcset")) || $img.attr("src");
    if (src) return abs(base, (src || "").split("?")[0]);
  }
  // 兜底
  return fallbackPickImg($("body"), base);
}

function parseDetailPage($, pageUrl) {
  const title =
    text($('h1.product--title, h1[itemprop="name"], h1.entry--name, h1').first()) ||
    text($('meta[property="og:title"]').first()) || "";

  const price =
    text($('.price--content,.price,.product--price,.price--default').first()) ||
    findPrice($("body"));

  const img = pickDetailImage($, pageUrl);
  const sku = extractSkuFromDocument($);

  if (!title && !sku) return null;

  return [{
    sku: sku || guessSkuFromTitle(title),
    title: title || "",
    url: cleanUrl(pageUrl, pageUrl),
    img: img || null,
    price: price || null,
    currency: "",
    moq: ""
  }];
}

// ============ 列表解析 ============
// ★ 扩展“垃圾标题”过滤：避免把详情页里的推荐块当成产品
function titleLooksLikeJunk(t){
  return /^(produkt|zum\s+produkt|weitere|vorschau|versandkosten|technische\b)/i.test((t||"").trim());
}

function parseCards($, base, limit) {
  const items = [], seenUrl = new Set(), seenTitle = new Set();
  const CARD_SEL = [
    'div[class*="product"]','li[class*="product"]','article[class*="product"]',
    ".product-item",".product-card",".prod-item",".good",".goods",".item",".grid__item",
  ].join(", ");
  const BAD_HREF = /add-to-cart|wishlist|compare|login|register|cart|filter|sort|mailto:/i;

  $(CARD_SEL).each((_i, el) => {
    if (items.length >= limit) return false;
    const $card = $(el);

    // 常见「推荐/更多该品牌商品」容器：直接跳过（避免详情页上误抓）
    if (/(recommend|similar|upsell|cross|weitere|brand-products|related)/i.test(($card.attr("class")||""))) return;

    const $a = $card.find("a[href]").filter((_, a) => !BAD_HREF.test(String($(a).attr("href")))).first();
    if (!$a.length) return;

    const href0 = $a.attr("href") || "";
    const href = cleanUrl(abs(base, href0), base);
    if (!href || seenUrl.has(href)) return;

    // 没图也不丢弃，尽量兜底一张
    let img = pickImg($card, base);
    if (!img) {
      const $imgAlt = $card.find("img").first();
      if ($imgAlt.length) img = abs(base, $imgAlt.attr("src") || $imgAlt.attr("data-src") || "");
    }

    const title =
      ($a.attr("title") || "").trim() ||
      text($card.find("h3,h2,.title").first()) ||
      text($a);
    if (!title) return;
    if (titleLooksLikeJunk(title)) return;

    const titleKey = title.toLowerCase().replace(/\s+/g, " ").trim();
    if (seenTitle.has(titleKey)) return;

    const price = findPrice($card);
    items.push({ sku: guessSkuFromTitle(title), title, url: href, img, price, currency: "", moq: "" });
    seenUrl.add(href); seenTitle.add(titleKey);
  });

  return items;
}

function parseWoo($, base, limit) {
  const items = [], seenTitle = new Set(), seenUrl = new Set();
  const $cards = $("ul.products li.product"); if (!$cards.length) return items;

  $cards.each((_i, li) => {
    if (items.length >= limit) return false;
    const $li = $(li);
    const $a = $li.find("a.woocommerce-LoopProduct-link, a[href]").first();

    const href = cleanUrl(abs(base, $a.attr("href") || ""), base);
    const title =
      text($li.find(".woocommerce-loop-product__title").first()) ||
      ($a.attr("title") || "").trim() || text($a);
    if (!href || !title || seenUrl.has(href)) return;
    if (titleLooksLikeJunk(title)) return;

    const titleKey = title.toLowerCase().replace(/\s+/g, " ").trim();
    if (seenTitle.has(titleKey)) return;

    let img = pickImg($li, base);
    if (!img) {
      const $imgAlt = $li.find("img").first();
      if ($imgAlt.length) img = abs(base, $imgAlt.attr("src") || $imgAlt.attr("data-src") || "");
    }
    const price = text($li.find(".price .amount,.price").first()) || null;
    items.push({ sku: guessSkuFromTitle(title), title, url: href, img, price, currency: "", moq: "" });
    seenTitle.add(titleKey); seenUrl.add(href);
  });

  return items;
}

function parseAnchors($, base, limit) {
  const items = [], seenUrl = new Set(), seenTitle = new Set();
  const BAD = /add-to-cart|cart|login|wishlist|compare|filter|sort|mailto:/i;

  $("a[href]").each((_i, a) => {
    if (items.length >= limit) return false;
    const $a = $(a);
    const href = cleanUrl(abs(base, $a.attr("href") || ""), base);
    if (!href || seenUrl.has(href) || BAD.test(href)) return;

    let isDetail = false;
    try {
      const u = new URL(href);
      const p = (u.pathname || "").toLowerCase();
      isDetail = /(product|item|sku|artikel|detail|details|view)/.test(p);
    } catch {}
    if (!isDetail) return;

    // 避免推荐区块
    let $card = $a.closest("li,article,div");
    if (/(recommend|similar|upsell|cross|weitere|brand-products|related)/i.test(($card.attr("class")||""))) return;

    if (!$card.length) $card = $a.parent();

    let img = pickImg($card, base);
    if (!img) {
      const $imgAlt = $card.find("img").first();
      if ($imgAlt.length) img = abs(base, $imgAlt.attr("src") || $imgAlt.attr("data-src") || "");
    }

    const title = ($a.attr("title") || "").trim() || text($card.find("h3,h2").first()) || text($a);
    if (!title) return;
    if (titleLooksLikeJunk(title)) return;

    const titleKey = title.toLowerCase().replace(/\s+/g, " ").trim();
    if (seenTitle.has(titleKey)) return;

    const price = findPrice($card);
    items.push({ sku: guessSkuFromTitle(title), title, url: href, img, price, currency: "", moq: "" });
    seenUrl.add(href); seenTitle.add(titleKey);
  });

  return items;
}

// ============ 导出 ============
export default async function parseUniversal({ url, limit = 60, debug = false } = {}) {
  if (!url) return [];

  const fetchHtml =
    (http && typeof http.fetchHtml === "function")
      ? (u, opt = {}) => http.fetchHtml(u, { headers: { "User-Agent": UA, ...(opt.headers || {}) } })
      : async (u, opt = {}) => (await fetch(u, { headers: { "User-Agent": UA, ...(opt.headers || {}) } })).text();

  const startHtml = await fetchHtml(url);
  const $start = cheerio.load(startHtml);

  // 1) 如果这是详情页：只抽主商品，直接返回
  if (isDetailPage($start)) {
    const detail = parseDetailPage($start, url) || [];
    if (debug) console.log(`[universal] detail-mode items=${detail.length} url=${url}`);
    if (detail.length) return detail;
    // 若极少数站点 detail 识别失败，才继续走列表兜底
  }

  // 2) 目录页：按卡片/woo/锚点三路解析
  const parseOne = ($, pageUrl) => {
    const need = limit;
    let part = parseCards($, pageUrl, need);
    if (part.length < Math.min(3, need)) part = part.concat(parseWoo($, pageUrl, need - part.length));
    if (part.length < need) part = part.concat(parseAnchors($, pageUrl, need - part.length));
    if (debug) console.log(`[universal] parsed=${part.length} url=${pageUrl}`);
    return part;
  };

  const itemsRaw = await crawlPages(startHtml, url, 40, limit, parseOne, fetchHtml, { samePathOnly: true, debug });

  const seenUrl = new Set(), seenTitle = new Set();
  const items = [];

  for (const it of itemsRaw) {
    if (!it?.url || !it?.title) continue;
    if (titleLooksLikeJunk(it.title)) continue;

    const u = cleanUrl(it.url, url);
    const titleKey = it.title.toLowerCase().replace(/\s+/g, " ").trim();
    if (seenUrl.has(u) || seenTitle.has(titleKey)) continue;

    let img = it.img || "";
    if (!img) img = "";

    items.push({
      sku: it.sku || "",
      title: it.title,
      url: u,
      img: img || null,
      price: it.price || null,
      currency: it.currency || "",
      moq: it.moq || ""
    });

    seenUrl.add(u); seenTitle.add(titleKey);
    if (items.length >= limit) break;
  }

  // 3) 进入详情覆写 SKU（强标签），优先修复 Prüfziffer 或短码
  await overwriteSkuFromDetailGeneric(items, {
    takeMax: Math.min(30, limit),
    conc: 6,
    fetchHtml,
    headers: { "User-Agent": UA }
  });

  return items;
}

// -------------- 进入详情覆写（并发+缓存） --------------
async function overwriteSkuFromDetailGeneric(items, { takeMax = 30, conc = 6, fetchHtml, headers = {} } = {}) {
  if (!items?.length || !fetchHtml) return;

  const picked = new Set(), jobs = [];
  for (let i = 0; i < items.length && jobs.length < takeMax; i++) {
    const it = items[i];
    if ((!it.sku || looksLikePruef(it.sku)) && it.url) { jobs.push({ i, url: it.url }); picked.add(i); }
  }
  for (let i = 0; i < items.length && jobs.length < takeMax; i++) {
    if (picked.has(i)) continue;
    const it = items[i];
    if (it?.url) { jobs.push({ i, url: it.url }); picked.add(i); }
  }
  if (!jobs.length) return;

  const cache = (overwriteSkuFromDetailGeneric.__cache ||= new Map());
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.ts > 15 * 60_000) cache.delete(k);

  let p = 0;
  async function worker(){
    while(p < jobs.length){
      const { i, url } = jobs[p++];
      try{
        let html = "";
        const c = cache.get(url);
        if (c && (now - c.ts < 15 * 60_000)) html = c.html;
        else { html = await fetchHtml(url, { headers }); cache.set(url, { html, ts: Date.now() }); }
        if (!html) continue;

        const $ = cheerio.load(html);
        const found = extractSkuFromDocument($);
        if (found) items[i].sku = found;
      }catch{}
    }
  }
  await Promise.all(Array.from({ length: Math.min(conc, jobs.length) }, worker));
}
