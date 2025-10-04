// backend/adapters/universal.js
import * as cheerio from "cheerio";
import * as http from "../lib/http.js";
import * as images from "../lib/images.js";
import { crawlPages } from "../lib/pagination.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function abs(base, href) { if (!href) return ""; try { return new URL(href, base).href; } catch { return ""; } }
function text($el) { return ($el.text() || "").replace(/\s+/g, " ").trim(); }
function firstSrcFromSet(ss) {
  if (!ss) return "";
  const cand = ss.split(",").map(s => s.trim().split(/\s+/)[0]).find(s => /^https?:/i.test(s));
  return cand || "";
}

// —— 兜底取图
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

/* ================== 详情覆写（增强版） ================== */
// 弱特例：只在“文本兜底”时屏蔽极像 Prüfziffer 的 48xxxxxx…，有明确标签时不屏蔽
function looksLikePruef(v) { return v ? /^48\d{6,10}$/.test(String(v).trim()) : false; }

async function overwriteSkuFromDetailGeneric(items, { takeMax = 30, conc = 6, fetchHtml, headers = {} } = {}) {
  if (!items?.length || !fetchHtml) return;

  const picked = new Set();
  const jobs = [];
  for (let i = 0; i < items.length && jobs.length < takeMax; i++) {
    const it = items[i];
    if ((!it.sku || looksLikePruef(it.sku)) && it.url) { jobs.push({ i, url: it.url }); picked.add(i); }
  }
  for (let i = 0; i < items.length && jobs.length < takeMax; i++) {
    if (picked.has(i)) continue;
    const it = items[i]; if (it?.url) { jobs.push({ i, url: it.url }); picked.add(i); }
  }
  if (!jobs.length) return;

  // 只看“标签”是否命中白名单；显式排除 Prüfziffer / Hersteller / Hersteller-Nr.
  const LABEL = /^(artikel-?nr\.?|artikelnummer|art\.-?nr\.?|bestellnummer|item\s*no\.?|sku|mpn|modell|model|herstellernummer|hersteller-?nr\.?)/i;
  const BAD   = /(prüfziffer|hersteller-?nr\.?|hersteller)/i;

  // 进程内 15 分钟缓存
  const cache = (overwriteSkuFromDetailGeneric.__cache ||= new Map());
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.ts > 15 * 60_000) cache.delete(k);

  let p = 0;
  async function worker() {
    while (p < jobs.length) {
      const { i, url } = jobs[p++];
      try {
        let html = "";
        const c = cache.get(url);
        if (c && (now - c.ts < 15 * 60_000)) html = c.html;
        else { html = await fetchHtml(url, { headers }); cache.set(url, { html, ts: Date.now() }); }
        if (!html) continue;

        const $ = cheerio.load(html);
        let found = "";

        // 1) JSON-LD
        $('script[type="application/ld+json"]').each((_i, el) => {
          if (found) return;
          try {
            const raw = $(el).contents().text().trim(); if (!raw) return;
            const data = JSON.parse(raw); const arr = Array.isArray(data) ? data : [data];
            for (const o of arr) {
              const hit = Object.entries(o).find(([k]) => LABEL.test(k));
              if (hit && !BAD.test(hit[0]) && hit[1]) { const v = String(hit[1]).trim(); if (v) { found = v; break; } }
            }
          } catch {}
        });

        // 2) <dl> / <table>
        if (!found) {
          $("dl").each((_, dl) => {
            if (found) return false;
            $(dl).find("dt").each((_j, dt) => {
              const k = text($(dt)); if (LABEL.test(k) && !BAD.test(k)) {
                const v = text($(dt).next("dd")); if (v) { found = v; return false; }
              }
            });
          });
        }
        if (!found) {
          $("table").each((_, tb) => {
            if (found) return false;
            $(tb).find("tr").each((_j, tr) => {
              const th = text($(tr).find("th,td").first());
              const td = text($(tr).find("td").last());
              if (LABEL.test(th) && !BAD.test(th) && td) { found = td; return false; }
            });
          });
        }

        // 3) 邻近文本（beamer-discount 等常用结构）
        if (!found) {
          const $cands = $("*").filter((_, el) => LABEL.test(text($(el))) && !BAD.test(text($(el))));
          $cands.each((_k, el) => {
            if (found) return false;
            const $el = $(el);

            // 同行/同块：取紧邻兄弟
            const v1 = text($el.next());
            if (v1) { found = v1; return false; }

            // 有些站点是 label/value 两个 span 挨着，再退一步找 “: ” 后面的纯文本
            const m = ($el.parent().text() || "").replace(/\s+/g, " ").match(/:\s*([A-Z0-9._\-\/]+)/i);
            if (m && m[1]) { found = m[1].trim(); return false; }

            // 再往下找接下来的若干兄弟里第一个非空文本
            const near = $el.nextAll().toArray().map(n => text($(n))).find(s => s);
            if (near) { found = near; return false; }
          });
        }

        // 4) 文本兜底（仅当上面都失败时）
        if (!found) {
          const body = $("body").text().replace(/\s+/g, " ");
          const reList = [
            /(?:Artikel\s*[-–—]?\s*Nr|Artikelnummer|Art\.\s*[-–—]?\s*Nr)\s*[:#]?\s*([A-Z0-9._\-\/]+)/i,
            /\bBestellnummer\s*[:#]?\s*([A-Z0-9._\-\/]+)/i,
            /\bItem\s*no\.?\s*[:#]?\s*([A-Z0-9._\-\/]+)/i,
            /\bSKU\s*[:#]?\s*([A-Z0-9._\-\/]+)/i,
            /\bMPN\s*[:#]?\s*([A-Z0-9._\-\/]+)/i,
            /\b(?:Modell|Model)\s*[:#]?\s*([A-Z0-9._\-\/]+)/i,
            /\bHerstellernummer\s*[:#]?\s*([A-Z0-9._\-\/]+)/i,
            /\bHersteller-?Nr\.?\s*[:#]?\s*([A-Z0-9._\-\/]+)/i,
          ];
          for (const re of reList) {
            const m = body.match(re);
            if (m && m[1] && !/^prüfziffer/i.test(m[0]) && !looksLikePruef(m[1])) { found = m[1].trim(); break; }
          }
        }

        if (found) items[i].sku = found;
      } catch {}
    }
  }
  await Promise.all(Array.from({ length: Math.min(conc, jobs.length) }, worker));
}

/* ================== 列表解析（加重“Zum Produkt …”过滤） ================== */
function parseCards($, base, limit) {
  const items = [], seenUrl = new Set(), seenTitle = new Set();
  const CARD_SEL = [
    'div[class*="product"]','li[class*="product"]','article[class*="product"]',
    ".product-item",".product-card",".prod-item",".good",".goods",".item",".grid__item",
  ].join(", ");
  const BAD = /add-to-cart|wishlist|compare|login|register|cart|filter|sort|mailto:/i;

  $(CARD_SEL).each((_i, el) => {
    if (items.length >= limit) return false;
    const $card = $(el);
    const $a = $card.find("a[href]").filter((_, a) => !BAD.test(String($(a).attr("href")))).first();
    if (!$a.length) return;

    const href = abs(base, $a.attr("href") || ""); if (!href || seenUrl.has(href)) return;
    const img = pickImg($card, base); if (!img) return;

    const title = ($a.attr("title") || "").trim() || text($card.find("h3,h2,.title").first()) || text($a);
    if (!title) return;
    if (/^(produkt|zum\s+produkt)\b/i.test(title)) return;          // ← 更狠

    const titleKey = title.toLowerCase().replace(/\s+/g, " ").trim();
    if (seenTitle.has(titleKey)) return;

    const price = findPrice($card);
    items.push({ sku: guessSkuFromTitle(title), title, url: href, img, price, currency: "", moq: "" });
    seenUrl.add(href); seenTitle.add(titleKey);
  });
  return items;
}

function parseWoo($, base, limit) {
  const items = [], seenTitle = new Set();
  const $cards = $("ul.products li.product"); if (!$cards.length) return items;

  $cards.each((_i, li) => {
    if (items.length >= limit) return false;
    const $li = $(li);
    const $a = $li.find("a.woocommerce-LoopProduct-link, a[href]").first();
    const href = abs(base, $a.attr("href") || "");
    const title =
      text($li.find(".woocommerce-loop-product__title").first()) ||
      ($a.attr("title") || "").trim() || text($a);
    if (!href || !title) return;
    if (/^(produkt|zum\s+produkt)\b/i.test(title)) return;

    const titleKey = title.toLowerCase().replace(/\s+/g, " ").trim();
    if (seenTitle.has(titleKey)) return;

    const img = pickImg($li, base);
    const price = text($li.find(".price .amount,.price").first()) || null;
    items.push({ sku: guessSkuFromTitle(title), title, url: href, img, price, currency: "", moq: "" });
    seenTitle.add(titleKey);
  });
  return items;
}

function parseAnchors($, base, limit) {
  const items = [], seenUrl = new Set(), seenTitle = new Set();
  const BAD = /add-to-cart|cart|login|wishlist|compare|filter|sort|mailto:/i;

  $("a[href]").each((_i, a) => {
    if (items.length >= limit) return false;
    const $a = $(a);
    const href = abs(base, $a.attr("href") || "");
    if (!href || seenUrl.has(href) || BAD.test(href)) return;

    let isDetail = false;
    try { const u = new URL(href, base); const p = (u.pathname || "").toLowerCase();
      isDetail = /(product|item|sku|artikel|detail|details|view)/.test(p);
    } catch {}
    if (!isDetail) return;

    let $card = $a.closest("li,article,div"); if (!$card.length) $card = $a.parent();
    const img = pickImg($card, base); if (!img && !$card.find("img").length) return;

    const title = ($a.attr("title") || "").trim() || text($card.find("h3,h2").first()) || text($a);
    if (!title) return;
    if (/^(produkt|zum\s+produkt)\b/i.test(title)) return;

    const titleKey = title.toLowerCase().replace(/\s+/g, " ").trim(); if (seenTitle.has(titleKey)) return;
    const price = findPrice($card);
    items.push({ sku: guessSkuFromTitle(title), title, url: href, img, price, currency: "", moq: "" });
    seenUrl.add(href); seenTitle.add(titleKey);
  });
  return items;
}

/* ================== 导出 ================== */
export default async function parseUniversal({ url, limit = 60, debug = false } = {}) {
  if (!url) return [];

  const fetchHtml =
    (http && typeof http.fetchHtml === "function")
      ? (u, opt = {}) => http.fetchHtml(u, { headers: { "User-Agent": UA, ...(opt.headers || {}) } })
      : async (u, opt = {}) => (await fetch(u, { headers: { "User-Agent": UA, ...(opt.headers || {}) } })).text();

  const startHtml = await fetchHtml(url);

  const parseOne = ($, pageUrl) => {
    const need = limit;
    let part = parseCards($, pageUrl, need);
    if (part.length < Math.min(3, need)) part = part.concat(parseWoo($, pageUrl, need - part.length));
    if (part.length < need) part = part.concat(parseAnchors($, pageUrl, need - part.length));
    if (debug) console.log(`[universal] parsed=${part.length} url=${pageUrl}`);
    return part;
  };

  const items = await crawlPages(startHtml, url, 40, limit, parseOne, fetchHtml, { samePathOnly: true, debug });

  await overwriteSkuFromDetailGeneric(items, {
    takeMax: Math.min(30, limit),
    conc: 6,
    fetchHtml,
    headers: { "User-Agent": UA, "Accept-Language": "de,en;q=0.8" }
  });

  return items.slice(0, limit);
}
