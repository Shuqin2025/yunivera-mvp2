// backend/adapters/universal.js

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
// 规范化 URL：去掉 ? 与 #，用来去重/识别详情
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

/* ============ 详情覆写：只认“强标签”+ 排除 Hersteller ============ */
// 仅在“纯文本兜底”时屏蔽极像 Prüfziffer 的 48xxxxxx…（像 memoryking）
function looksLikePruef(v) { return v ? /^48\d{6,10}$/.test(String(v).trim()) : false; }

// 强标签（白名单）：只从这些里取
const LABEL_STRONG_RE =
  /^(artikel-?nr\.?|artikelnummer|art\.-?nr\.?|bestellnummer|item\s*no\.?|sku|mpn)$/i;
// DOM/文本“包含式”版本
const LABEL_STRONG_FUZZY =
  /(artikel\s*[-–—]?\s*nr\.?|artikelnummer|art\.\s*[-–—]?\s*nr\.?|bestellnummer|item\s*no\.?|sku|mpn)/i;
// 显式排除
const LABEL_BAD = /(prüfziffer|hersteller-?nr\.?|hersteller)/i;

// JSON-LD 键名归一化 + 优先级
const KEY_PRIORITY = [
  "artikelnummer", "artikel-nr", "art.-nr", "bestellnummer", "itemno", "sku", "mpn"
];
function normKey(k) { return String(k || "").toLowerCase().replace(/[\s._-]/g, ""); }

// ✨ 新增：直接从同一节点的“强标签 + 值”里抠出值（处理 “Artikelnummer: 1000028645” 没有邻居节点的情况）
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

async function overwriteSkuFromDetailGeneric(items, { takeMax = 30, conc = 6, fetchHtml, headers = {} } = {}) {
  if (!items?.length || !fetchHtml) return;

  // 选取要进入详情的行：优先“缺/疑似 Prüfziffer”的，再补到 takeMax（即便已有短型号也会进入）
  const picked = new Set();
  const jobs = [];
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

        // (0) 结构化/属性：itemprop=sku / data-sku / meta[name=sku]
        if (!found) {
          const metaSel = [
            '[itemprop="sku"]','[data-sku]','meta[name="sku"]','meta[itemprop="sku"]'
          ].join(",");
          const $m = $(metaSel).first();
          if ($m.length) {
            const v = $m.attr("content") || $m.attr("data-sku") || text($m);
            if (v) found = String(v).trim();
          }
        }

        // (1) JSON-LD（按 KEY_PRIORITY 明确优先级）
        if (!found) {
          $('script[type="application/ld+json"]').each((_i, el) => {
            if (found) return;
            try {
              const raw = $(el).contents().text().trim(); if (!raw) return;
              const data = JSON.parse(raw); const arr = Array.isArray(data) ? data : [data];
              for (const obj of arr) {
                const dict = Object.create(null);
                for (const [k, v] of Object.entries(obj)) {
                  const nk = normKey(k);
                  if (LABEL_BAD.test(k)) continue;
                  dict[nk] = v;
                }
                for (const want of KEY_PRIORITY) {
                  if (dict[want]) { const v = String(dict[want]).trim(); if (v) { found = v; break; } }
                }
                if (found) break;
              }
            } catch {}
          });
        }

        // (2) <dl> / <table>：只认强标签（fuzzy），取紧邻值
        if (!found) {
          $("dl").each((_, dl) => {
            if (found) return false;
            $(dl).find("dt").each((_j, dt) => {
              const k = text($(dt));
              if (LABEL_STRONG_FUZZY.test(k) && !LABEL_BAD.test(k)) {
                const v = text($(dt).next("dd"));
                if (v) { found = v; return false; }
                // ✨ 新增：同节点行内形式
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
              // ✨ 新增：同单元格行内形式
              const inline = extractInlineLabelValue(th);
              if (!found && inline) { found = inline; return false; }
            });
          });
        }

        // (3) 邻近文本（只在强标签附近取“兄弟/同块”）
        if (!found) {
          const $cands = $("*").filter((_, el) => LABEL_STRONG_FUZZY.test(text($(el))) && !LABEL_BAD.test(text($(el))));
          $cands.each((_k, el) => {
            if (found) return false;
            const $el = $(el);
            // 3.1 兄弟节点
            const v1 = text($el.next());
            if (v1) { found = v1; return false; }
            // 3.2 同块紧邻
            const v2 = text($el.parent().children().eq($el.index() + 1));
            if (v2) { found = v2; return false; }
            // 3.3 ✨ 行内“标签+值”
            const inline = extractInlineLabelValue(text($el));
            if (inline) { found = inline; return false; }
          });
        }

        // (4) 文本兜底：只保留“强标签”正则
        if (!found) {
          const body = $("body").text().replace(/\s+/g, " ");
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

        if (found) items[i].sku = found; // ✅ 命中强标签即覆盖
      } catch {}
    }
  }
  await Promise.all(Array.from({ length: Math.min(conc, jobs.length) }, worker));
}

/* ============ 列表解析 ============ */
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
    const $a = $card.find("a[href]").filter((_, a) => !BAD_HREF.test(String($(a).attr("href")))).first();
    if (!$a.length) return;

    const href0 = $a.attr("href") || "";
    const href = cleanUrl(abs(base, href0), base);
    if (!href || seenUrl.has(href)) return;

    const img = pickImg($card, base);
    if (!img) return;

    const title =
      ($a.attr("title") || "").trim() ||
      text($card.find("h3,h2,.title").first()) ||
      text($a);
    if (!title) return;
    if (/^(produkt|zum\s+produkt)\b/i.test(title)) return; // 过滤“纯跳转到产品页”的卡片

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
    if (/^(produkt|zum\s+produkt)\b/i.test(title)) return;

    const titleKey = title.toLowerCase().replace(/\s+/g, " ").trim();
    if (seenTitle.has(titleKey)) return;

    const img = pickImg($li, base);
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

    // 仅抓看起来像详情的 URL
    let isDetail = false;
    try {
      const u = new URL(href);
      const p = (u.pathname || "").toLowerCase();
      isDetail = /(product|item|sku|artikel|detail|details|view)/.test(p);
    } catch {}
    if (!isDetail) return;

    let $card = $a.closest("li,article,div");
    if (!$card.length) $card = $a.parent();

    const img = pickImg($card, base);
    if (!img && !$card.find("img").length) return;

    const title = ($a.attr("title") || "").trim() || text($card.find("h3,h2").first()) || text($a);
    if (!title) return;
    if (/^(produkt|zum\s+produkt)\b/i.test(title)) return;

    const titleKey = title.toLowerCase().replace(/\s+/g, " ").trim();
    if (seenTitle.has(titleKey)) return;

    const price = findPrice($card);
    items.push({ sku: guessSkuFromTitle(title), title, url: href, img, price, currency: "", moq: "" });
    seenUrl.add(href); seenTitle.add(titleKey);
  });
  return items;
}

/* ============ 导出 ============ */
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

  const itemsRaw = await crawlPages(startHtml, url, 40, limit, parseOne, fetchHtml, { samePathOnly: true, debug });

  // ✨ 全局去重（跨通道/跨分页）：按“规范化详情 URL”
  const seen = new Set();
  const items = [];
  for (const it of itemsRaw) {
    const u = cleanUrl(it.url || "", url);
    if (!u || seen.has(u)) continue;
    seen.add(u);
    items.push({ ...it, url: u });
  }

  // 详情覆写（只认强标签）
  await overwriteSkuFromDetailGeneric(items, {
    takeMax: Math.min(30, limit),
    conc: 6,
    fetchHtml,
    headers: { "User-Agent": UA, "Accept-Language": "de,en;q=0.8" }
  });

  return items.slice(0, limit);
}
