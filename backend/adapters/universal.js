// backend/adapters/universal.js

import * as cheerio from "cheerio";
import * as http from "../lib/http.js";          // fetchHtml（带编码/重试/UA）
import * as images from "../lib/images.js";      // 统一取图（支持 data-* / srcset 等）
import { crawlPages } from "../lib/pagination.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function abs(base, href) {
  if (!href) return "";
  try { return new URL(href, base).href; } catch { return ""; }
}
function text($el) { return ($el.text() || "").replace(/\s+/g, " ").trim(); }
function firstSrcFromSet(ss) {
  if (!ss) return "";
  const cand = ss.split(",").map(s => s.trim().split(/\s+/)[0]).find(s => /^https?:/i.test(s));
  return cand || "";
}

// —— 最小兜底：从任意 card 里取一张靠谱图
function fallbackPickImg($root, base) {
  const $img = $root.find("img").first();
  const src =
    $img.attr("data-src") ||
    $img.attr("data-original") ||
    $img.attr("data-lazy") ||
    $img.attr("data-zoom-image") ||
    firstSrcFromSet($img.attr("srcset")) ||
    $img.attr("src") || "";
  return abs(base, (src || "").split("?")[0]);
}

function pickImg($root, base) {
  if (images && typeof images.pickImage === "function") {
    return images.pickImage($root, base) || "";
  }
  return fallbackPickImg($root, base);
}

function guessSkuFromTitle(title) {
  if (!title) return "";
  const m =
    title.match(/\b[0-9]{4,}\b/) ||
    title.match(/\b[A-Z0-9][A-Z0-9-]{3,}\b/);
  return m ? m[0] : "";
}

function findPrice($card) {
  let s = text(
    $card.find(".price,.product-price,.amount,.money,.m-price,.price__value,.price-value").first()
  );
  if (!s) {
    const m = ($card.text() || "").match(/\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})\s*(?:€|EUR)/i);
    if (m) s = m[0].replace(/\s+/g, " ");
  }
  return s || null;
}

/* ----------------------------------------------------------------
 * 通用“详情覆写 SKU”（仅标签取值 + 显式排除 Prüfziffer/Hersteller）
 * ---------------------------------------------------------------- */

// 像 Prüfziffer（8+ 位纯数字，或 48 开头 8~10 位）
function looksLikePruef(v) {
  if (!v) return false;
  const s = String(v).trim();
  return /^\d{8,}$/.test(s) || /^48\d{6,10}$/.test(s);
}

// 仅对“sku 为空或疑似 Prüfziffer”的前 takeMax 条优先，若不足再补齐到 takeMax 进行一次标签覆写
async function overwriteSkuFromDetailGeneric(items, {
  takeMax = 12,          // 小样本即可；默认 12
  conc = 6,
  fetchHtml,
  headers = {}
} = {}) {
  if (!items || !items.length || !fetchHtml) return;

  // 先挑“空/疑似 Prüfziffer”
  const picked = new Set();
  const jobs = [];
  for (let i = 0; i < items.length && jobs.length < takeMax; i++) {
    const it = items[i];
    const need = (!it.sku || looksLikePruef(it.sku)) && it.url;
    if (need) { jobs.push({ i, url: it.url }); picked.add(i); }
  }
  // 若不足，再从头部补一些（仅当有 url），用于“尝试用标签覆写”
  for (let i = 0; i < items.length && jobs.length < takeMax; i++) {
    if (picked.has(i)) continue;
    const it = items[i];
    if (it && it.url) { jobs.push({ i, url: it.url }); picked.add(i); }
  }
  if (!jobs.length) return;

  // 标签白名单 + 排除词
  const LABEL = /^(artikel-?nr\.?|artikelnummer|art\.-?nr\.?|bestellnummer|item\s*no\.?|sku|mpn|modell|model|herstellernummer|hersteller-?nr\.?)/i;
  const BAD   = /(prüfziffer|hersteller-?nr\.?|hersteller)/i;

  // 进程内缓存（15 分钟）
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
        if (c && (now - c.ts < 15 * 60_000)) {
          html = c.html;
        } else {
          html = await fetchHtml(url, { headers });
          cache.set(url, { html, ts: Date.now() });
        }
        if (!html) continue;

        const $ = cheerio.load(html);
        let found = "";

        // 1) JSON-LD
        $('script[type="application/ld+json"]').each((_i, el) => {
          if (found) return;
          try {
            const raw = $(el).contents().text().trim();
            if (!raw) return;
            const data = JSON.parse(raw);
            const arr = Array.isArray(data) ? data : [data];
            for (const o of arr) {
              const hit = Object.entries(o).find(([k]) => LABEL.test(k));
              if (hit && !BAD.test(hit[0]) && hit[1]) {
                const v = String(hit[1]).trim();
                if (v && !looksLikePruef(v)) { found = v; break; }
              }
            }
          } catch {}
        });

        // 2) <dl> / <table>
        if (!found) {
          $("dl").each((_, dl) => {
            if (found) return false;
            $(dl).find("dt").each((_j, dt) => {
              const k = text($(dt));
              if (LABEL.test(k) && !BAD.test(k)) {
                const v = text($(dt).next("dd"));
                if (v && !looksLikePruef(v)) { found = v; return false; }
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
              if (LABEL.test(th) && !BAD.test(th) && td && !looksLikePruef(td)) {
                found = td; return false;
              }
            });
          });
        }

        // 3) 文本兜底（标签 : 值）
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
            if (m && m[1] && !looksLikePruef(m[1])) { found = m[1].trim(); break; }
          }
        }

        if (found) items[i].sku = found;
      } catch {}
    }
  }

  await Promise.all(Array.from({ length: Math.min(conc, jobs.length) }, worker));
}

/* ---------- 层 1：通用“卡片”解析（加强“Produkt / Zum Produkt …”过滤 + 标题去重） ---------- */
function parseCards($, base, limit) {
  const items = [];
  const seenUrl = new Set();
  const seenTitle = new Set();

  const CARD_SEL = [
    'div[class*="product"]',
    'li[class*="product"]',
    'article[class*="product"]',
    ".product-item",
    ".product-card",
    ".prod-item",
    ".good",
    ".goods",
    ".item",
    ".grid__item",
  ].join(", ");
  const BAD = /add-to-cart|wishlist|compare|login|register|cart|filter|sort|mailto:/i;

  $(CARD_SEL).each((_i, el) => {
    if (items.length >= limit) return false;
    const $card = $(el);
    const $a = $card.find("a[href]").filter((_, a) => !BAD.test(String($(a).attr("href")))).first();
    if (!$a.length) return;

    const href = abs(base, $a.attr("href") || "");
    if (!href || seenUrl.has(href)) return;

    const img = pickImg($card, base);
    if (!img) return;

    const title =
      ($a.attr("title") || "").trim() ||
      text($card.find("h3,h2,.title").first()) ||
      text($a);
    if (!title) return;

    // 新：过滤“Produkt”以及任何“Zum Produkt …”开头的辅助跳转
    if (/^produkt\b/i.test(title) || /^zum\s+produkt\b/i.test(title)) return;

    const titleKey = title.toLowerCase().replace(/\s+/g, " ").trim();
    if (seenTitle.has(titleKey)) return;

    const price = findPrice($card);
    items.push({ sku: guessSkuFromTitle(title), title, url: href, img, price, currency: "", moq: "" });

    seenUrl.add(href);
    seenTitle.add(titleKey);
  });
  return items;
}

/* ---------- 层 2：WooCommerce ---------- */
function parseWoo($, base, limit) {
  const items = [];
  const seenTitle = new Set();

  const $cards = $("ul.products li.product");
  if (!$cards.length) return items;

  $cards.each((_i, li) => {
    if (items.length >= limit) return false;
    const $li = $(li);
    const $a = $li.find("a.woocommerce-LoopProduct-link, a[href]").first();
    const href = abs(base, $a.attr("href") || "");
    const title =
      text($li.find(".woocommerce-loop-product__title").first()) ||
      ($a.attr("title") || "").trim() ||
      text($a);
    if (!href || !title) return;

    if (/^produkt\b/i.test(title) || /^zum\s+produkt\b/i.test(title)) return;
    const titleKey = title.toLowerCase().replace(/\s+/g, " ").trim();
    if (seenTitle.has(titleKey)) return;

    const img = pickImg($li, base);
    const price = text($li.find(".price .amount,.price").first()) || null;

    items.push({ sku: guessSkuFromTitle(title), title, url: href, img, price, currency: "", moq: "" });
    seenTitle.add(titleKey);
  });
  return items;
}

/* ---------- 层 3：超通用链接兜底（同样加强过滤 + 标题去重） ---------- */
function parseAnchors($, base, limit) {
  const items = [];
  const seenUrl = new Set();
  const seenTitle = new Set();
  const BAD = /add-to-cart|cart|login|wishlist|compare|filter|sort|mailto:/i;

  $("a[href]").each((_i, a) => {
    if (items.length >= limit) return false;
    const $a = $(a);
    const href = abs(base, $a.attr("href") || "");
    if (!href || seenUrl.has(href) || BAD.test(href)) return;

    let isDetail = false;
    try {
      const u = new URL(href, base);
      const p = (u.pathname || "").toLowerCase();
      isDetail = /(product|item|sku|artikel|detail|details|view)/.test(p);
    } catch {}

    if (!isDetail) return;

    let $card = $a.closest("li,article,div");
    if (!$card.length) $card = $a.parent();

    const img = pickImg($card, base);
    if (!img && !$card.find("img").length) return;

    const title =
      ($a.attr("title") || "").trim() ||
      text($card.find("h3,h2").first()) ||
      text($a);
    if (!title) return;

    if (/^produkt\b/i.test(title) || /^zum\s+produkt\b/i.test(title)) return;

    const titleKey = title.toLowerCase().replace(/\s+/g, " ").trim();
    if (seenTitle.has(titleKey)) return;

    const price = findPrice($card);
    items.push({ sku: guessSkuFromTitle(title), title, url: href, img, price, currency: "", moq: "" });

    seenUrl.add(href);
    seenTitle.add(titleKey);
  });

  return items;
}

/* ---------- 导出：通用适配器（自动翻页） ---------- */
export default async function parseUniversal({ url, limit = 60, debug = false } = {}) {
  if (!url) return [];

  // 统一的抓取函数（带 UA / 编码识别 / 重试）
  const fetchHtml =
    (http && typeof http.fetchHtml === "function")
      ? (u, opt = {}) => http.fetchHtml(u, { headers: { "User-Agent": UA, ...(opt.headers || {}) } })
      : async (u, opt = {}) => (await fetch(u, { headers: { "User-Agent": UA, ...(opt.headers || {}) } })).text();

  // 首页 HTML
  const startHtml = await fetchHtml(url);

  // 单页解析函数（供 crawlPages 调用，不改签名）
  const parseOne = ($, pageUrl) => {
    const need = limit; // 交给 crawlPages 控制整体数量
    let part = parseCards($, pageUrl, need);
    if (part.length < Math.min(3, need)) {
      part = part.concat(parseWoo($, pageUrl, need - part.length));
    }
    if (part.length < need) {
      part = part.concat(parseAnchors($, pageUrl, need - part.length));
    }
    if (debug) console.log(`[universal] parsed=${part.length} url=${pageUrl}`);
    return part;
  };

  // 自动翻页：最多 40 页，整体条数上限 limit
  const items = await crawlPages(
    startHtml,
    url,
    40,
    limit,
    parseOne,
    fetchHtml,
    { samePathOnly: true, debug }
  );

  // 轻量详情覆写（仅标签；排除 Prüfziffer/Hersteller；优先“空/Prüfziffer”，不足补齐到 takeMax）
  await overwriteSkuFromDetailGeneric(items, {
    takeMax: Math.min(12, limit),
    conc: 6,
    fetchHtml,
    headers: { "User-Agent": UA, "Accept-Language": "de,en;q=0.8" }
  });

  return items.slice(0, limit);
}
