// backend/adapters/universal.js
import * as cheerio from "cheerio";
import * as http from "../lib/http.js";          // fetchHtml（带编码适配）
import * as images from "../lib/images.js";      // 统一取图
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
  // 优先走 images 模块
  if (images && typeof images.pickImage === "function") {
    return images.pickImage($root, base) || "";
  }
  // 兜底
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

/* ---------- 层 1：通用“卡片”解析 ---------- */
function parseCards($, base, limit) {
  const items = [];
  const seen = new Set();
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
    if (!href || seen.has(href)) return;

    const img = pickImg($card, base);
    if (!img) return;

    const title =
      ($a.attr("title") || "").trim() ||
      text($card.find("h3,h2,.title").first()) ||
      text($a);
    if (!title) return;

    const price = findPrice($card);
    items.push({ sku: guessSkuFromTitle(title), title, url: href, img, price, currency: "", moq: "" });
    seen.add(href);
  });
  return items;
}

/* ---------- 层 2：WooCommerce ---------- */
function parseWoo($, base, limit) {
  const items = [];
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

    const img = pickImg($li, base);
    const price = text($li.find(".price .amount,.price").first()) || null;

    items.push({ sku: guessSkuFromTitle(title), title, url: href, img, price, currency: "", moq: "" });
  });
  return items;
}

/* ---------- 层 3：超通用链接兜底 ---------- */
function parseAnchors($, base, limit) {
  const items = [];
  const seen = new Set();
  const BAD = /add-to-cart|cart|login|wishlist|compare|filter|sort|mailto:/i;

  $("a[href]").each((_i, a) => {
    if (items.length >= limit) return false;
    const $a = $(a);
    const href = abs(base, $a.attr("href") || "");
    if (!href || seen.has(href) || BAD.test(href)) return;

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

    const price = findPrice($card);
    items.push({ sku: guessSkuFromTitle(title), title, url: href, img, price, currency: "", moq: "" });
    seen.add(href);
  });

  return items;
}

/* ---------- 导出：通用适配器（支持自动翻页） ---------- */
export default async function parseUniversal({ url, limit = 60, debug = false } = {}) {
  if (!url) return [];
  const fetchHtml =
    (http && typeof http.fetchHtml === "function")
      ? (u) => http.fetchHtml(u, { headers: { "User-Agent": UA } })
      : async (u) => {
          // 极端兜底（不依赖 http 模块），一般用不到
          const res = await (await fetch(u, { headers: { "User-Agent": UA } })).text();
          return res;
        };

  try {
    const pages = await crawlPages(url, fetchHtml, 50); // 最多 50 页
    const out = [];
    for (const pageUrl of pages) {
      if (out.length >= limit) break;
      const html = await fetchHtml(pageUrl);
      const $ = cheerio.load(html, { decodeEntities: false });

      let part = parseCards($, pageUrl, limit - out.length);
      if (part.length < Math.min(3, limit - out.length)) {
        part = part.concat(parseWoo($, pageUrl, (limit - out.length) - part.length));
      }
      if (part.length < (limit - out.length)) {
        part = part.concat(parseAnchors($, pageUrl, (limit - out.length) - part.length));
      }

      for (const it of part) {
        out.push(it);
        if (out.length >= limit) break;
      }

      if (debug) console.log(`[universal] page=${pageUrl} items+=${part.length} total=${out.length}`);
    }
    return out.slice(0, limit);
  } catch (e) {
    if (debug) console.error("[universal] fail:", e?.message || e);
    return [];
  }
}
