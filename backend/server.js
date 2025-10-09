import express from "express";
import cors from "cors";
import axios from "axios";
import * as cheerio from "cheerio";

// ✅ 可选翻译（保持你原有接口）
import * as translate from "./lib/translate.js";

// ✅ 站点适配器（保持你已有）
import parseMemoryking from "./adapters/memoryking.js";
import sino from "./adapters/sinotronic.js";
import parseUniversal from "./adapters/universal.js";

// ✅ 结构类型检测器（新增）
import { detectStructure } from "./lib/structureDetector.js";

const app = express();
app.use(cors({ origin: "*", exposedHeaders: ["X-Lang", "X-Adapter"] }));

/* ──────────────────────────── health ──────────────────────────── */
app.get(["/", "/healthz", "/health", "/api/health"], (_req, res) =>
  res.type("text/plain").send("ok")
);
app.get("/v1/api/health", (_req, res) => {
  res.json({ ok: true, status: "up", ts: Date.now() });
});

app.get("/v1/api/__version", (_req, res) => {
  res.json({
    version: "mvp-universal-parse-2025-10-07-struct-detector-r1",
    note:
      "新增 /v1/api/detect 结构类型检测API；其余功能不变。",
  });
});

/* ──────────────────────────── utils ──────────────────────────── */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function fetchHtml(targetUrl) {
  const { data } = await axios.get(targetUrl, {
    headers: {
      "User-Agent": UA,
      "Accept-Language": "de,en;q=0.8,zh;q=0.6",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      Referer: targetUrl,
    },
    timeout: 25000,
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 400,
  });
  return typeof data === "string" ? data : "";
}

function abs(base, maybe) {
  if (!maybe) return "";
  try {
    return new URL(maybe, base).href;
  } catch {
    return "";
  }
}
function text($el) {
  return ($el.text() || "").replace(/\s+/g, " ").trim();
}
function guessSkuFromTitle(title) {
  if (!title) return "";
  const m =
    title.match(/\b[0-9]{4,}\b/) ||
    title.match(/\b[0-9A-Z]{4,}(?:-[0-9A-Z]{2,})*\b/i);
  return m ? m[0] : "";
}

function normalizePrice(str) {
  if (!str) return "";
  const s = String(str).replace(/\s+/g, " ").trim();
  const m =
    s.match(/€\s*\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})/) ||
    s.match(/\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})\s*€/) ||
    s.match(/\d+[.,]\d{2}/);
  if (!m) return s;
  let v = m[0].replace(/\s+/g, " ");
  if (!/[€]/.test(v)) v = "€ " + v;
  return v;
}

function priceFromJsonLd($) {
  let price = "", currency = "€";
  $('script[type="application/ld+json"]').each((_i, el) => {
    try {
      const raw = $(el).contents().text().trim();
      if (!raw) return;
      const data = JSON.parse(raw);
      const arr = Array.isArray(data) ? data : [data];
      for (const obj of arr) {
        if (!obj) continue;
        const t = obj["@type"];
        const isProduct = t === "Product" || (Array.isArray(t) && t.includes("Product"));
        if (!isProduct) continue;
        let offers = obj.offers;
        offers = Array.isArray(offers) ? offers[0] : offers;
        const p = offers?.price ?? offers?.lowPrice ?? offers?.highPrice;
        if (p != null && p !== "") {
          price = String(p);
          currency = offers.priceCurrency || currency;
          break;
        }
      }
    } catch {}
  });
  if (price) {
    if (/eur|€/i.test(currency)) currency = "€";
    return normalizePrice(`${currency} ${price}`);
  }
  return "";
}

/* ──────────────────────────── 结构类型检测 API（新增） ──────────────────────────── */
app.get("/v1/api/detect", async (req, res) => {
  const listUrl = String(req.query.url || req.query.u || "").trim();
  if (!listUrl) return res.status(400).json({ ok: false, error: "missing url" });
  try {
    const html = await fetchHtml(listUrl);
    const result = detectStructure(html, listUrl);
    res.json({ ok: true, url: listUrl, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* ──────────────────────────── image proxy ──────────────────────────── */
// 抽成公共处理，避免路由递归
async function handleImage(req, res) {
  const url = String(req.query.url || "").trim();
  const format = String(req.query.format || "").toLowerCase();
  if (!url) return res.status(400).send("missing url");
  try {
    const r = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 20000,
      headers: {
        "User-Agent": UA,
        Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
        Referer: new URL(url).origin + "/",
      },
      validateStatus: (s) => s >= 200 && s < 400,
    });

    const ct = r.headers["content-type"] || "image/jpeg";
    res.set("Access-Control-Allow-Origin", "*");

    if (format === "base64") {
      const base64 = Buffer.from(r.data).toString("base64");
      return res.json({
        ok: true,
        contentType: ct,
        base64: `data:${ct};base64,${base64}`,
      });
    }

    res.set("Content-Type", ct);
    res.set("Cache-Control", "public, max-age=604800");
    res.send(r.data);
  } catch (e) {
    console.error("[image] fail:", e?.message || e);
    res.status(502).send("image fetch failed");
  }
}
app.get("/v1/api/image", handleImage);
// ✅ 修复：不再自我递归，直接调用公共处理
app.get("/v1/api/image64", (req, res) => {
  req.query.format = "base64";
  return handleImage(req, res);
});

/* ──────────────────────────── site: auto-schmuck.com ──────────────────────────── */
async function parseAutoSchmuck(listUrl, limit = 50) {
  const html = await fetchHtml(listUrl);
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  $(".artbox, .artbox-inner, .artbox-wrap, .product-wrapper, .product, .isotope-item")
    .add("div,li,article")
    .each((_i, el) => {
      if (items.length >= limit) return false;
      const $card = $(el);

      const $img = $card.find("img").first();
      if (!$img.length) return;

      let $a = $card
        .find("a[href]")
        .filter((_, a) => !/anzeigen|anmelden|login|cart|filter/i.test(text($(a))))
        .first();
      if (!$a.length) return;

      const href = abs(listUrl, $a.attr("href") || "");
      if (!href || seen.has(href)) return;

      const title =
        ($a.attr("title") || "").trim() ||
        text($card.find("h3,h2").first()) ||
        text($a) ||
        ($img.attr("alt") || "").trim();
      if (!title) return;

      const srcFromSet = ($img.attr("srcset") || "")
        .split(/\s+/)
        .find((s) => /^https?:/i.test(s));
      const src =
        $img.attr("data-src") ||
        $img.attr("data-original") ||
        srcFromSet ||
        $img.attr("src") ||
        "";
      const img = abs(listUrl, (src || "").split("?")[0]);

      let priceTxt = text(
        $card.find(
          ".price,.product-price,.price-tag,.artbox-price,.product-list-price,.amount"
        ).first()
      );
      if (!priceTxt) {
        const m = $card.text().match(
          /\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})\s*(?:€|EUR)/i
        );
        if (m) priceTxt = m[0].replace(/\s+/g, " ");
      }

      items.push({
        sku: guessSkuFromTitle(title),
        title,
        url: href,
        img,
        price: priceTxt || null,
        currency: "",
        moq: "",
      });
    });

  return items.slice(0, limit);
}

/* ──────────────────────────── site: s-impuls-shop.de ──────────────────────────── */
async function parseSImpulsCatalog(listUrl, limit = 50) {
  const html = await fetchHtml(listUrl);
  const $ = cheerio.load(html);

  let cardRoots = $("#nx_content .listproduct-wrapper .listproduct");
  const candidates = [
    { item: ".listproduct .product, .listproduct > div" },
    { item: "div.product-layout, div.product-thumb, div.product-grid .product-layout" },
    { item: ".row .product-layout, .row .product-thumb" },
  ];

  const items = [];
  function pickImg($card) {
    let $img = $card.find(".image img").first().length
      ? $card.find(".image img").first()
      : $card.find("img").first();
    let src =
      $img.attr("data-src") ||
      $img.attr("data-original") ||
      ($img.attr("srcset") || "").split(" ").find((s) => /^https?:/i.test(s)) ||
      $img.attr("src") ||
      "";
    return abs(listUrl, (src || "").split("?")[0]);
  }
  function pushItem(aEl) {
    if (items.length >= limit) return;
    const $a = $(aEl);
    const href = $a.attr("href") || "";
    if (!href || !/\/product\//.test(href)) return;

    const title = ($a.attr("title") || "").trim() || text($a);
    let $card = $a.closest("div");
    if ($card.length === 0) $card = $a.parent();
    const img = pickImg($card);

    const priceTxt =
      text($card.find(".price, .product-price, .amount, .m-price").first()) || "";
    const skuTxt =
      text($card.find(".product-model, .model, .sku").first()) ||
      guessSkuFromTitle(title);

    items.push({
      sku: skuTxt,
      title,
      url: abs(listUrl, href),
      img,
      price: priceTxt || null,
      currency: "",
      moq: "",
    });
  }

  if (cardRoots.length) cardRoots.find('a[href*="/product/"]').each((_i, a) => pushItem(a));
  if (items.length === 0) {
    for (const c of candidates) {
      const $cards = $(c.item);
      if ($cards.length === 0) continue;
      $cards.each((_i, el) =>
        $(el).find('a[href*="/product/"]').each((_j, a) => pushItem(a))
      );
      if (items.length > 0) break;
    }
  }
  return items;
}

/* ──────────────────────────── Generic 卡片解析 ──────────────────────────── */
function parseByCardSelectors($, listUrl, limit = 50) {
  const items = [];
  const seen = new Set();

  const CARD_SEL = [
    'div[class*="product"]',
    'li[class*="product"]',
    'article[class*="product"]',
    '.product-item',
    '.product-card',
    '.prod-item',
    '.good, .goods, .item',
  ].join(", ");

  const BAD_LINK = /(add-to-cart|wishlist|compare|login|register|cart|filter|sort)/i;

  $(CARD_SEL).each((_i, el) => {
    if (items.length >= limit) return false;
    const $card = $(el);

    const $img = $card.find("img").first();
    let src =
      $img.attr("data-src") ||
      $img.attr("data-original") ||
      ($img.attr("srcset") || "").split(" ").find((s) => /^https?:/i.test(s)) ||
      $img.attr("src") ||
      "";
    const img = abs(listUrl, (src || "").split("?")[0]);

    let $a = $card
      .find("a[href]")
      .filter((_, a) => !BAD_LINK.test(String($(a).attr("href"))))
      .first();
    if (!$a.length) return;

    let href = abs(listUrl, $a.attr("href") || "");
    if (!href || seen.has(href)) return;

    const title =
      ($a.attr("title") || "").trim() ||
      text($card.find("h3,h2,h1").first()) ||
      text($a) ||
      ($img.attr("alt") || "").trim();
    if (!title) return;

    let priceTxt =
      text(
        $card.find(
          ".price,.product-price,.amount,.money,.m-price,.price--default,.price__value"
        ).first()
      ) || "";
    if (!priceTxt) {
      const m = $card.text().match(/\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})\s*(?:€|EUR)/i);
      if (m) priceTxt = m[0].replace(/\s+/g, " ");
    }

    items.push({
      sku:
        text($card.find(".sku,.product-sku,.model,.product-model").first()) ||
        guessSkuFromTitle(title),
      title,
      url: href,
      img,
      price: priceTxt || null,
      currency: "",
      moq: "",
    });
  });

  return items;
}

/* ──────────────────────────── Woo ──────────────────────────── */
function parseWooFromHtml($, listUrl, limit = 50) {
  const items = [];
  const $cards = $("ul.products li.product");
  if (!$cards.length) return items;

  $cards.each((_i, li) => {
    if (items.length >= limit) return;

    const $li = $(li);
    const $a = $li.find("a.woocommerce-LoopProduct-link").first().length
      ? $li.find("a.woocommerce-LoopProduct-link").first()
      : $li.find("a[href]").first();

    const href = $a.attr("href") || "";
    const title =
      text($li.find(".woocommerce-loop-product__title").first()) ||
      ($a.attr("title") || "").trim() ||
      text($a) ||
      "";

    const $img = $li.find("img").first();
    const src =
      $img.attr("data-src") ||
      $img.attr("data-original") ||
      ($img.attr("srcset") || "").split(" ").find((s) => /^https?:/i.test(s)) ||
      $img.attr("src") ||
      "";

    const priceTxt =
      text($li.find(".price .amount").first()) || text($li.find(".price").first()) || "";

    if (!href || !title) return;
    items.push({
      sku: guessSkuFromTitle(title),
      title,
      url: abs(listUrl, href),
      img: abs(listUrl, (src || "").split("?")[0]),
      price: priceTxt || null,
      currency: "",
      moq: "",
    });
  });

  return items;
}

/* ──────────────────────────── 详情富化（价格/MOQ） ──────────────────────────── */
async function enrichDetail(item) {
  try {
    const html = await fetchHtml(item.url);
    const $ = cheerio.load(html);

    let priceText = priceFromJsonLd($);
    if (!priceText) {
      const sel = [
        "meta[itemprop='price']",
        "[itemprop='price']",
        ".woocommerce-Price-amount",
        ".price .amount",
        ".price .value",
        ".product-price",
        ".price-value",
        ".amount",
        ".price",
      ].join(", ");
      const $node = $(sel).first();
      const raw = ($node.attr("content") || text($node) || "").trim();
      if (raw) priceText = normalizePrice(raw);
    }

    const moqSel =
      ".moq, .min-order, .minimum, .minbestellmenge, .minimum-order, .minimum__value";
    const moqText = text($(moqSel).first());

    if (priceText) item.price = priceText;
    if (moqText) item.moq = moqText;
  } catch {}
}

/* ──────────────────────────── 通用详情覆写 SKU（可选） ──────────────────────────── */
async function overwriteSkuFromDetailGeneric(items, maxCount = 30) {
  const GOOD = /^(artikel-?nr\.?|artikelnummer|art\.-?nr\.?|bestellnummer|item\s*(?:no\.?|number)|produktnummer|hersteller-?nr\.?)$/i;
  const BAD  = /(prüfziffer|ean|gtin|hersteller(?!-?nr))/i;
  const hasEanPrefix = (s) => /^\s*(ean|gtin)\b/i.test(String(s||""));

  const take = Math.min(items.length, maxCount);
  const jobs = [];
  for (let i = 0; i < take; i++) {
    const it = items[i];
    let raw = String(it.sku || "").trim();
    raw = raw.replace(/^\s*(ean|gtin)\s*[:：]?\s*/i, "");
    const looksLikeGenericId = /\b[0-9A-Z][0-9A-Z\-_.\/]{2,}\b/.test(raw);
    const hasGoodSku = looksLikeGenericId && !hasEanPrefix(it.sku || "");
    if (hasGoodSku || !it.url) continue;
    jobs.push({ i, url: it.url });
  }
  if (!jobs.length) return;

  const CONC = 8, TIMEOUT = 10000;
  let p = 0;

  async function worker() {
    while (p < jobs.length) {
      const { i, url } = jobs[p++];
      try {
        const r = await axios.get(url, {
          headers: { "User-Agent": UA, "Accept-Language": "de,en;q=0.8" },
          timeout: TIMEOUT, validateStatus: s => s >= 200 && s < 400
        });
        const $ = cheerio.load(r.data);
        let found = "";

        // 1) JSON-LD
        $('script[type="application/ld+json"]').each((_k, el) => {
          try {
            const raw = $(el).contents().text().trim();
            if (!raw) return;
            const data = JSON.parse(raw);
            const arr  = Array.isArray(data) ? data : [data];
            for (const o of arr) {
              for (const [k, v] of Object.entries(o)) {
                const key = String(k).toLowerCase();
                if (GOOD.test(key) && !BAD.test(key)) {
                  const val = String(v || "").trim();
                  if (val) { found = val; break; }
                }
              }
              if (found) break;
            }
          } catch {}
        });

        // 2) label → value
        if (!found) {
          $('*, dt, th, .data, .spec, .label').each((_k, el) => {
            const lbl = text($(el)).toLowerCase();
            const isOk =
              (lbl.includes("artikel-nr") || lbl.includes("artikelnr") || lbl.includes("artikelnummer") ||
               lbl.includes("art.-nr") || lbl.includes("bestellnummer") || lbl.includes("item no") ||
               lbl.includes("item number") || lbl.includes("produktnummer") || lbl.includes("hersteller-nr")) &&
              !/(prüfziffer|ean|gtin|hersteller(?!-?nr))/.test(lbl);
            if (!isOk) return;

            const labelText = text($(el));
            const val =
              ($(el).next().text() || $(el).parent().text() || "")
                .replace(labelText, "")
                .replace(/[:：]/, "")
                .trim();
            if (val && /\S{3,}/.test(val)) { found = val; return false; }
          });
        }

        // 3) 强化兜底
        if (!found) {
          const page = $("body").text().replace(/\s+/g, " ");
          const mArt = page.match(/(Artikel-?Nr\.?|Artikelnummer|Art\.-?Nr\.?|Bestellnummer|Item\s*(?:No\.?|Number)|Produktnummer|Hersteller-?Nr\.?)\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9\-_.\/]{1,})/i);
          if (mArt) {
            const label = mArt[1] || "";
            if (!/(prüfziffer|ean|gtin|hersteller(?!-?nr))/i.test(label)) found = mArt[2].trim();
          }
        }

        if (found) items[i].sku = found;
      } catch {}
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, jobs.length) }, worker));
}

/* ──────────────────────────── beamer-discount 专用：详情覆写 SKU ──────────────────────────── */
async function overwriteSkuFromBeamerDetail(items, maxCount = 30) {
  const GOODLBL = /(Artikel-?Nr\.?|Artikelnummer|Art\.-?Nr\.?|Bestellnummer|Produktnummer|Item\s*(?:No\.?|Number)|Hersteller-?Nr\.?)/i;
  const BADLBL  = /(prüfziffer|ean|gtin|hersteller(?!-?nr))/i;

  const take = Math.min(items.length, maxCount);
  const jobs = [];
  for (let i = 0; i < take; i++) {
    const it = items[i];
    if (!it?.url) continue;
    jobs.push({ i, url: it.url, initial: String(it.sku || "") });
  }
  if (!jobs.length) return;

  const CONC = 8, TIMEOUT = 12000;
  let p = 0;

  async function worker() {
    while (p < jobs.length) {
      const { i, url, initial } = jobs[p++];
      try {
        const r = await axios.get(url, {
          headers: { "User-Agent": UA, "Accept-Language": "de,en;q=0.8" },
          timeout: TIMEOUT, validateStatus: s => s >= 200 && s < 400
        });
        const $ = cheerio.load(r.data, { decodeEntities: false });

        let found = "";

        // A) 常见位置
        $("dt,th,.data,.spec,.label,li,div,p").each((_k, el) => {
          if (found) return false;
          const t = text($(el));
          if (!t) return;
          const mInline = t.match(/(Artikel-?Nr\.?|Artikelnummer|Art\.-?Nr\.?|Bestellnummer|Produktnummer|Item\s*(?:No\.?|Number)|Hersteller-?Nr\.?)\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9\-_.\/]{1,})/i);
          if (mInline && !BADLBL.test(mInline[1] || "")) {
            found = mInline[2].trim();
            return false;
          }
          if (GOODLBL.test(t) && !BADLBL.test(t)) {
            const v = text($(el).next());
            if (v && !/^\s*(ean|gtin)\b/i.test(v)) {
              found = v;
              return false;
            }
          }
        });

        // B) JSON-LD
        if (!found) {
          $('script[type="application/ld+json"]').each((_i, el) => {
            if (found) return false;
            try {
              const data = JSON.parse($(el).contents().text().trim());
              const arr = Array.isArray(data) ? data : [data];
              for (const obj of arr) {
                const cand = obj?.mpn || obj?.sku || obj?.productID || "";
                if (cand && !/^\s*(ean|gtin)\b/i.test(String(cand))) {
                  found = String(cand).trim();
                  break;
                }
              }
            } catch {}
          });
        }

        // C) 全页兜底
        if (!found) {
          const page = $("body").text().replace(/\s+/g, " ");
          const m = page.match(/(Artikel-?Nr\.?|Artikelnummer|Art\.-?Nr\.?|Bestellnummer|Produktnummer|Item\s*(?:No\.?|Number)|Hersteller-?Nr\.?)\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9\-_.\/]{1,})/i);
          if (m && !BADLBL.test(m[1] || "")) found = m[2].trim();
        }

        if (found) items[i].sku = found;
        else {
          items[i].sku = String(initial).replace(/^\s*ean\s*[:：]?\s*/i, "").trim() || initial;
        }
      } catch {}
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, jobs.length) }, worker));
}

/* ──────────────────────────── beamer-discount 详情解析（保持原样） ──────────────────────────── */
async function parseBeamerDetail(detailUrl) {
  const html = await fetchHtml(detailUrl);
  const $ = cheerio.load(html, { decodeEntities: false });

  const title =
    text($("h1, .product-title").first()) ||
    text($('meta[property="og:title"]').first()) ||
    $("title").text().trim();

  let price = priceFromJsonLd($);
  if (!price) {
    const sel = [
      ".price, .product-price, .price__value, .price--default",
      ".amount, .price .amount",
      "[itemprop='price'], meta[itemprop='price']",
    ].join(", ");
    const $p = $(sel).first();
    const raw = ($p.attr("content") || text($p) || "").trim();
    if (raw) price = normalizePrice(raw);
  }

  let img = "";
  $('script[type="application/ld+json"]').each((_i, el) => {
    try {
      const data = JSON.parse($(el).contents().text().trim());
      const arr = Array.isArray(data) ? data : [data];
      for (const obj of arr) {
        const t = obj["@type"];
        const isProduct = t === "Product" || (Array.isArray(t) && t.includes("Product"));
        if (!isProduct) continue;
        const im = obj.image;
        if (typeof im === "string") { img = im; break; }
        if (Array.isArray(im) && im.length) { img = im[0]; break; }
      }
    } catch {}
  });
  if (!img) img = $('meta[property="og:image"]').attr("content") || "";
  if (!img) {
    const $pic = $(".product-media img, .gallery img, img").first();
    img = $pic.attr("data-src") || ($pic.attr("srcset")||"").split(" ").find(s=>/^https?:/i.test(s)) || $pic.attr("src") || "";
  }
  img = abs(detailUrl, (img || "").split("?")[0]);

  const GOOD = /(Artikel-?Nr\.?|Artikelnummer|Art\.-?Nr\.?|Bestellnummer|Produktnummer|Item\s*(?:No\.?|Number)|Hersteller-?Nr\.?)/i;
  const BAD  = /(prüfziffer|ean|gtin|hersteller(?!-?nr))/i;
  let sku = "";

  $("dt,th,.data,.spec,.label,li,div,p").each((_k, el) => {
    if (sku) return false;
    const t = text($(el));
    const mInline = t.match(/(Artikel-?Nr\.?|Artikelnummer|Art\.-?Nr\.?|Bestellnummer|Produktnummer|Item\s*(?:No\.?|Number)|Hersteller-?Nr\.?)\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9\-_.\/]{1,})/i);
    if (mInline && !BAD.test(mInline[1] || "")) {
      sku = mInline[2].trim();
      return false;
    }
    if (GOOD.test(t) && !BAD.test(t)) {
      const v = text($(el).next());
      if (v && !/^\s*(ean|gtin)\b/i.test(v)) { sku = v; return false; }
    }
  });

  if (!sku) {
    $('script[type="application/ld+json"]').each((_i, el) => {
      if (sku) return false;
      try {
        const data = JSON.parse($(el).contents().text().trim());
        const arr = Array.isArray(data) ? data : [data];
        for (const o of arr) {
          const cand = o?.mpn || o?.sku || o?.productID || "";
          if (cand && !/^\s*(ean|gtin)\b/i.test(String(cand))) { sku = String(cand).trim(); break; }
        }
      } catch {}
    });
  }

  if (!sku) {
    const page = $("body").text().replace(/\s+/g, " ");
    const m = page.match(/(Artikel-?Nr\.?|Artikelnummer|Art\.-?Nr\.?|Bestellnummer|Produktnummer|Item\s*(?:No\.?|Number)|Hersteller-?Nr\.?)\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9\-_.\/]{1,})/i);
    if (m && !BAD.test(m[1] || "")) sku = m[2].trim();
  }
  if (!sku) sku = guessSkuFromTitle(title);

  return [{
    sku: sku || "",
    title: title || "",
    url: detailUrl,
    img: img || "",
    price: price || null,
    currency: "",
    moq: "",
  }];
}

/* ──────────────────────────── 统一入口 ──────────────────────────── */
async function parseUniversalCatalog(
  listUrl,
  limit = 50,
  { debug = false, fast = false, detailSku = false, detailSkuMax = 30 } = {}
) {
  let adapter = "generic";
  try {
    const u = new URL(listUrl);
    const host = u.hostname;
    const path = u.pathname;

    // ✅ memoryking.de
    if (host.includes("memoryking.de")) {
      adapter = "memoryking/v5.1";
      const html = await fetchHtml(listUrl);
      const $ = cheerio.load(html, { decodeEntities: false });
      const items = await parseMemoryking({ $, url: listUrl, rawHtml: html, limit, debug });
      return { items, adapter };
    }

    // （示例）其它专用适配器保持不动
    if (/(\.|^)newsite\.de$/i.test(host)) {
      adapter = "exampleSite";
      const html = await fetchHtml(listUrl);
      const $ = cheerio.load(html, { decodeEntities: false });
      const parseExample = (await import("./adapters/exampleSite.js")).default;
      const items = await parseExample({ $, url: listUrl, rawHtml: html, limit, debug });
      return { items, adapter };
    }

    // ✅ beamer-discount.de
    if (host.includes("beamer-discount.de")) {
      const isDetail = /-\d+(?:\/|$|\?)/.test(path);
      if (isDetail) {
        const items = await parseBeamerDetail(listUrl);
        return { items, adapter: "beamer-detail" };
      }

      // 目录页：抓取 + 分页 + 去重 + 详情覆写 SKU（Artikel-Nr）
      const out = [];
      const seenUrl = new Set();
      const seenTitle = new Set();

      async function harvest(pageUrl) {
        const html = await fetchHtml(pageUrl);
        const $ = cheerio.load(html);
        let part = parseByCardSelectors($, pageUrl, limit - out.length);
        if (!part.length) {
          const wc = $("ul.products li.product");
          if (wc.length) part = parseWooFromHtml($, pageUrl, limit - out.length);
        }
        part = (part || []).filter(it => !/^zum\s+produkt/i.test((it.title || "")));

        for (const it of part) {
          const keyU = (it.url || "").trim();
          const keyT = (it.title || "").trim().toLowerCase();
          if (!keyU || seenUrl.has(keyU) || (keyT && seenTitle.has(keyT))) continue;
          seenUrl.add(keyU);
          if (keyT) seenTitle.add(keyT);
          out.push(it);
          if (out.length >= limit) break;
        }
        return $;
      }

      let $ = await harvest(listUrl);

      const pageSet = new Map();
      const addPage = (href) => {
        if (!href) return;
        const full = abs(listUrl, href);
        try {
          const u = new URL(full);
          let n =
            parseInt(
              u.searchParams.get("page") ||
                u.searchParams.get("p") ||
                u.searchParams.get("seite") ||
                "",
              10
            ) || 0;
          if (!n) {
            const m = u.pathname.match(/\/page\/(\d+)/i);
            if (m) n = parseInt(m[1], 10) || 0;
          }
          if (n && n > 1 && !pageSet.has(n)) pageSet.set(n, u.href);
        } catch {}
      };
      $(".pagination a[href], nav.pagination a[href], .page-numbers a[href], .pager a[href]").each((_i, a) => addPage($(a).attr("href")));

      const maxPages = 20;
      const visited = new Set();
      const makeCandidates = (base, n) => {
        const u = new URL(base);
        const sep = u.search ? "&" : "?";
        return [
          `${u.origin}${u.pathname}${u.search}${sep}page=${n}${u.hash}`,
          `${u.origin}${u.pathname}${u.search}${sep}p=${n}${u.hash}`,
          `${u.origin}${u.pathname.replace(/\/$/, "")}/page/${n}${u.search}${u.hash}`,
        ];
      };

      if (pageSet.size > 0) {
        const pages = [...pageSet.entries()].sort((a,b)=>a[0]-b[0]).map(([,href])=>href);
        for (const pageUrl of pages) {
          if (out.length >= limit) break;
          if (visited.has(pageUrl)) continue;
          visited.add(pageUrl);
          $ = await harvest(pageUrl);
        }
      } else {
        let n = 2;
        let progressed = true;
        while (n <= maxPages && out.length < limit && progressed) {
          progressed = false;
          for (const tryUrl of makeCandidates(listUrl, n)) {
            if (visited.has(tryUrl)) continue;
            visited.add(tryUrl);
            let html = "";
            try { html = await fetchHtml(tryUrl); } catch {}
            if (!html) continue;
            const $$ = cheerio.load(html);
            let part = parseByCardSelectors($$, tryUrl, limit - out.length);
            if (!part.length) {
              const wc = $$("ul.products li.product");
              if (wc.length) part = parseWooFromHtml($$, tryUrl, limit - out.length);
            }
            part = (part || []).filter(it => !/^zum\s+produkt/i.test((it.title || "")));
            let add = 0;
            for (const it of part) {
              const keyU = (it.url || "").trim();
              const keyT = (it.title || "").trim().toLowerCase();
              if (!keyU || seenUrl.has(keyU) || (keyT && seenTitle.has(keyT))) continue;
              seenUrl.add(keyU);
              if (keyT) seenTitle.add(keyT);
              out.push(it); add++;
              if (out.length >= limit) break;
            }
            if (add) { progressed = true; break; }
          }
          n += 1;
        }
      }

      const n = Math.min(detailSkuMax || 30, limit);
      await overwriteSkuFromBeamerDetail(out, n);

      return { items: out, adapter: "beamer-list+paging+detailSku" };
    }

    // ✅ akkuman.de（保持你的策略）
    if (/(\.|^)akkuman\.de$/i.test(host)) {
      adapter = "exampleSite";
      const html = await fetchHtml(listUrl);
      const $ = cheerio.load(html, { decodeEntities: false });
      const parseExample = (await import("./adapters/exampleSite.js")).default;

      const wantsDetail = !!detailSku;
      const fastEffective = !wantsDetail;

      const items = await parseExample({ $, url: listUrl, rawHtml: html, limit, debug, fast: fastEffective });
      return { items, adapter };
    }

    // ✅ sinotronic-e.com（自动翻页）
    if (host.includes("sinotronic-e.com")) {
      adapter = "sinotronic";
      const re = /(\?\d+_)(\d+)\.html$/i;
      const makeUrl = (p) => (re.test(listUrl) ? listUrl.replace(re, (_, a) => `${a}${p}.html`) : null);

      const maxPages = 20;
      const seenKey = new Set();
      const out = [];

      const firstHtml = await fetchHtml(listUrl);
      let $ = cheerio.load(firstHtml, { decodeEntities: false });
      let part = sino.parse($, listUrl, { limit });
      for (const it of part || []) {
        const key = it.url || it.img || it.title || "";
        if (!key || seenKey.has(key)) continue;
        seenKey.add(key);
        out.push(it);
        if (out.length >= limit) break;
      }

      for (let p = 2; p <= maxPages && out.length < limit; p++) {
        const nextUrl = makeUrl(p);
        if (!nextUrl) break;

        const html = await fetchHtml(nextUrl);
        $ = cheerio.load(html, { decodeEntities: false });
        part = sino.parse($, nextUrl, { limit: limit - out.length }) || [];
        if (!part.length) break;

        let add = 0;
        for (const it of part) {
          const key = it.url || it.img || it.title || "";
          if (!key || seenKey.has(key)) continue;
          seenKey.add(key);
          out.push(it);
          add++;
          if (out.length >= limit) break;
        }
        if (!add) break;
      }

      return { items: out, adapter };
    }

    // ✅ s-impuls-shop.de（保持原逻辑）
    if (host.includes("s-impuls-shop.de")) {
      adapter = "s-impuls-shop";
      const maxPages = 50;
      const out = [];
      const visited = new Set();

      listUrl = listUrl.replace(/[?&](page|p)(=[^&]*)?$/i, "");

      const harvest = async (pageUrl) => {
        const html = await fetchHtml(pageUrl);
        const $ = cheerio.load(html, { decodeEntities: false });
        const part = await parseSImpulsCatalog(pageUrl, limit - out.length);
        for (const it of part || []) {
          out.push(it);
          if (out.length >= limit) break;
        }
        return $;
      };

      let $ = await harvest(listUrl);
      if (out.length >= limit) return { items: out, adapter };

      const pageSet = new Map();
      const addPage = (href) => {
        if (!href) return;
        const full = abs(listUrl, href);
        try {
          const u = new URL(full);
          let n =
            parseInt(
              u.searchParams.get("page") ||
                u.searchParams.get("p") ||
                u.searchParams.get("seite") ||
                "",
              10
            ) || 0;
          if (!n) {
            const m = u.pathname.match(/\/page\/(\d+)/i);
            if (m) n = parseInt(m[1], 10) || 0;
          }
          if (n && n > 1 && !pageSet.has(n)) pageSet.set(n, u.href);
        } catch {}
      };

      $(
        ".pagination a[href], nav.pagination a[href], .pager a[href], .page-pagination a[href], .page-numbers a[href]"
      ).each((_i, a) => addPage($(a).attr("href")));

      const makeCandidates = (base, n) => {
        const u = new URL(base);
        const sep = u.search ? "&" : "?";
        return [
          `${u.origin}${u.pathname}${u.search}${sep}page=${n}${u.hash}`,
          `${u.origin}${u.pathname}${u.search}${sep}p=${n}${u.hash}`,
          `${u.origin}${u.pathname.replace(/\/$/, "")}/page/${n}${u.search}${u.hash}`,
        ];
      };
      const firstKey = (items) =>
        (items?.[0]?.link || items?.[0]?.url || items?.[0]?.href || "").trim();

      if (pageSet.size === 0) {
        let n = 2;
        let lastFirst = firstKey(out);
        while (n <= 50 && out.length < limit) {
          let advanced = false;
          for (const tryUrl of makeCandidates(listUrl, n)) {
            if (visited.has(tryUrl)) continue;
            let html = "";
            try { html = await fetchHtml(tryUrl); } catch {}
            if (!html) continue;

            const $$ = cheerio.load(html, { decodeEntities: false });
            const part = await parseSImpulsCatalog(tryUrl, limit - out.length);
            if (part && part.length) {
              const fk = firstKey(part);
              if (!fk || fk !== lastFirst) {
                for (const it of part) {
                  out.push(it);
                  if (out.length >= limit) break;
                }
                visited.add(tryUrl);
                lastFirst = fk || lastFirst;
                advanced = true;
              }
            }
          }
          if (!advanced) break;
          n += 1;
        }
        return { items: out, adapter };
      }

      const pages = [...pageSet.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, href]) => href)
        .slice(0, maxPages - 1);

      for (const pageUrl of pages) {
        if (out.length >= limit) break;
        if (visited.has(pageUrl)) continue;
        await harvest(pageUrl);
      }

      return { items: out, adapter };
    }

    if (host.includes("auto-schmuck.com")) {
      adapter = "auto-schmuck";
      const items = await parseAutoSchmuck(listUrl, limit);
      return { items, adapter };
    }
  } catch {}

  // 外部通用适配器
  try {
    const uni = await parseUniversal({ url: listUrl, limit });
    if (Array.isArray(uni) && uni.length) return { items: uni, adapter: "universal-ext" };
  } catch {}

  // 内置多级回退
  const html = await fetchHtml(listUrl);
  const $ = cheerio.load(html);

  const cardItems = parseByCardSelectors($, listUrl, limit);
  if (cardItems.length) {
    if (detailSku) {
      await overwriteSkuFromDetailGeneric(cardItems, Math.min(detailSkuMax || 30, limit));
      return { items: cardItems, adapter: "generic-cards+detailSku" };
    }
    return { items: cardItems, adapter: "generic-cards" };
  }

  const wcCards = $("ul.products li.product");
  if (wcCards.length) return { items: parseWooFromHtml($, listUrl, limit), adapter: "woocommerce" };

  // 最后退：简单链接解析
  function parseGenericFromHtml($$, baseUrl, lim) {
    const out = [];
    const seen = new Set();
    $$("a[href]").each((_i, a) => {
      if (out.length >= lim) return false;
      const href = abs(baseUrl, $$(a).attr("href") || "");
      if (!href || seen.has(href)) return;
      const t = ($$(a).attr("title") || "").trim() || text($$(a));
      if (!t) return;
      seen.add(href);
      out.push({ sku: guessSkuFromTitle(t), title: t, url: href, img: "", price: null, currency: "", moq: "" });
    });
    return out;
  }

  return { items: parseGenericFromHtml($, listUrl, limit), adapter: "generic-links" };
}

/* ──────────────────────────── API: 解析 ──────────────────────────── */
app.get("/v1/api/catalog/parse", async (req, res) => {
  const listUrl =
    String(req.query.url ?? req.query.u ?? req.query.link ?? req.query.l ?? "").trim();

  const limit = Math.max(
    1,
    Math.min(parseInt(String(req.query.limit || "50"), 10) || 50, 200)
  );

  const enrich = String(req.query.enrich || "").toLowerCase() === "true";
  const enrichCount = Math.min(
    parseInt(String(req.query.enrichCount || "20"), 10) || 20,
    limit
  );

  // 可选：把前 N 张图片直接塞成 base64 一并返回
  const wantImgBase64 = String(req.query.img || "") === "base64";
  const imgCount = Math.min(
    parseInt(String(req.query.imgCount || "0"), 10) || 0,
    limit
  );

  // ✅ 可选翻译
  const targetLang = String(req.query.translate || req.query.t || "").trim().toUpperCase();
  const translateFields = String(
    req.query.translateFields || "title,desc,description"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const translateCount = Math.min(
    parseInt(String(req.query.translateCount || String(limit)), 10) || limit,
    limit
  );

  // ✅ 新增：debug / fast / detailSku 透传
  const debug = /^(1|true|yes|on)$/i.test(String(req.query.debug || ""));
  const fast  = /^(1|true|yes|on)$/i.test(String(req.query.fast || ""));
  const detailSku = /^(1|true|yes|on)$/i.test(String(req.query.detailSku || ""));
  const detailSkuMax = Math.min(
    parseInt(String(req.query.detailSkuMax || "30"), 10) || 30,
    limit
  );

  if (!listUrl) return res.status(400).json({ ok: false, error: "missing url" });

  const t0 = Date.now();
  try {
    const { items, adapter } = await parseUniversalCatalog(listUrl, limit, {
      debug, fast, detailSku, detailSkuMax
    });

    if (enrich && items.length) {
      await Promise.all(items.slice(0, enrichCount).map(enrichDetail));
    }

    if (wantImgBase64 && imgCount > 0) {
      await Promise.all(
        items.slice(0, imgCount).map(async (it) => {
          if (!it.img) return;
          try {
            const r = await axios.get(it.img, {
              responseType: "arraybuffer",
              timeout: 15000,
              headers: {
                "User-Agent": UA,
                Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
                Referer: new URL(it.img).origin + "/",
              },
              validateStatus: (s) => s >= 200 && s < 400,
            });
            const ct = r.headers["content-type"] || "image/jpeg";
            it.img_b64 = `data:${ct};base64,${Buffer.from(r.data).toString("base64")}`;
          } catch {}
        })
      );
    }

    // ✅ 可选翻译
    if (items.length && targetLang) {
      const suffix = "_" + targetLang.toLowerCase();

      const translateOne = async (text) => {
        try {
          if (!text) return text;
          if (typeof translate.translateText === "function") {
            return await translate.translateText(text, targetLang);
          }
          if (typeof translate.translateBatch === "function") {
            const out = await translate.translateBatch([text], targetLang);
            return Array.isArray(out) ? out[0] : text;
          }
          if (typeof translate.default === "function") {
            return await translate.default(text, targetLang);
          }
          if (typeof translate.translate === "function") {
            return await translate.translate(text, targetLang);
          }
        } catch (e) {
          console.warn("[translate:one] fail:", e?.message || e);
        }
        return text;
      };

      for (let i = 0; i < Math.min(items.length, translateCount); i++) {
        const it = items[i];
        for (const f of translateFields) {
          const key = String(f).trim();
          if (!key || !Object.prototype.hasOwnProperty.call(it, key)) continue;
          try {
            const val = it[key];
            if (val && typeof val === "string") {
              const translated = await translateOne(val);
              it[`${key}${suffix}`] = translated;
            }
          } catch (e) {
            console.warn(`[translate:field] ${key} fail:`, e?.message || e);
          }
        }
      }
    }

    res.setHeader("X-Lang", "de");
    res.setHeader("X-Adapter", adapter || "unknown");
    res.json({ ok: true, url: listUrl, count: items.length, adapter, products: items, items });

    console.log("[parse:done]", {
      url: listUrl,
      adapter,
      count: items.length,
      ms: Date.now() - t0,
      enrich,
      enrichCount,
      wantImgBase64,
      imgCount,
      targetLang,
      translateFields,
      translateCount,
      debug,
      fast,
      detailSku,
      detailSkuMax,
    });
  } catch (err) {
    console.error("[parse:fail]", {
      url: listUrl,
      ms: Date.now() - t0,
      err: String(err?.message || err),
    });
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// 兼容别名：/v1/api/parse
app.get("/v1/api/parse", (req, res) =>
  app._router.handle(
    {
      ...req,
      url:
        "/v1/api/catalog/parse" +
        (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""),
    },
    res,
    () => {}
  )
);

// ✅ 兼容老路径：/v1/api/catalog 与 *.json 变体
app.get(["/v1/api/catalog", "/v1/api/catalog.json", "/v1/api/catalog/parse.json"], (req, res) =>
  app._router.handle(
    {
      ...req,
      url:
        "/v1/api/catalog/parse" +
        (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""),
    },
    res,
    () => {}
  )
);

/* ──────────────────────────── API: 导出 Excel ──────────────────────────── */
/** 分批翻译，避免触发 DeepL free 的并发/配额限制 */
async function translateListInBatches(texts = [], target = "EN", batchSize = 40) {
  const out = new Array(texts.length).fill("");
  if (!Array.isArray(texts) || !texts.length) return out;
  const use = (translate && typeof translate.translateBatch === "function");

  for (let i = 0; i < texts.length; i += batchSize) {
    const slice = texts.slice(i, i + batchSize);
    try {
      const arr = use ? await translate.translateBatch(slice, target) : slice;
      for (let k = 0; k < slice.length; k++) out[i + k] = arr[k] || slice[k] || "";
    } catch (e) {
      console.warn("[translate:batch fail]", target, e?.message || e);
      for (let k = 0; k < slice.length; k++) out[i + k] = slice[k] || "";
    }
  }
  return out;
}

const langLabel = (code) => {
  const c = String(code || "").toUpperCase();
  if (c === "DE") return "Beschreibung (DE)";
  if (c === "EN") return "Description (EN)";
  if (c === "ZH" || c === "CN") return "描述 (CN)";
  return `Text (${c})`;
};
const normalizeLang = (s) => {
  const v = String(s || "").trim().toLowerCase();
  if (!v) return "";
  if (v === "cn" || v === "zh-cn" || v === "zh") return "ZH";
  if (v === "en" || v === "en-us" || v === "en-gb") return "EN";
  if (v === "de") return "DE";
  return v.toUpperCase();
};

/** 根据参数构建 rows（含双语/多语列） */
async function buildRowsWithTranslations(items, { bilingual, translateOne }) {
  const rows = [];
  const desc = items.map((it) => it.title || "");

  const pair = String(bilingual || "").trim().toLowerCase();
  if (pair && pair.includes("-")) {
    const [aRaw, bRaw] = pair.split("-").map(normalizeLang);
    const A = aRaw || "DE";
    const B = bRaw || "EN";

    let colA = [];
    if (A === "DE") colA = desc;
    else colA = await translateListInBatches(desc, A);

    const colB = await translateListInBatches(desc, B);

    rows.push(["#", "Artikel-Nr.", "Bild", langLabel(A), langLabel(B), "MOQ", "Einzelpreis", "Link"]);
    for (let i = 0; i < items.length; i++) {
      const it = items[i] || {};
      rows.push([
        i + 1,
        it.sku || "",
        it.img || "",
        colA[i] || "",
        colB[i] || "",
        it.moq || "",
        it.price || "",
        it.url || "",
      ]);
    }
    return rows;
  }

  const one = normalizeLang(translateOne);
  if (one === "EN" || one === "ZH" || one === "DE") {
    const tArr = await translateListInBatches(desc, one);
    rows.push(["#", "Artikel-Nr.", "Bild", "Beschreibung", langLabel(one), "MOQ", "Einzelpreis", "Link"]);
    for (let i = 0; i < items.length; i++) {
      const it = items[i] || {};
      rows.push([
        i + 1,
        it.sku || "",
        it.img || "",
        desc[i] || "",
        tArr[i] || "",
        it.moq || "",
        it.price || "",
        it.url || "",
      ]);
    }
    return rows;
  }

  rows.push(["#", "Artikel-Nr.", "Bild", "Beschreibung", "MOQ", "Einzelpreis", "Link"]);
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    rows.push([
      i + 1,
      it.sku || "",
      it.img || "",
      desc[i] || "",
      it.moq || "",
      it.price || "",
      it.url || "",
    ]);
  }
  return rows;
}

// 兼容多条导出路径，前端“Excel exportieren (.xlsx)”可直接命中
app.get(
  [
    "/v1/api/catalog/export.xlsx",
    "/v1/api/export.xlsx",
    "/v1/api/catalog/xlsx",
    "/v1/api/xlsx",
    "/v1/api/catalog.xlsx",
  ],
  async (req, res) => {
    const listUrl =
      String(req.query.url ?? req.query.u ?? req.query.link ?? req.query.l ?? "").trim();
    const limit = Math.max(1, Math.min(parseInt(String(req.query.limit || "200"), 10) || 200, 1000));
    const debug = /^(1|true|yes|on)$/i.test(String(req.query.debug || ""));
    const fast  = /^(1|true|yes|on)$/i.test(String(req.query.fast || ""));
    const detailSku = /^(1|true|yes|on)$/i.test(String(req.query.detailSku || "1"));
    const detailSkuMax = Math.min(
      parseInt(String(req.query.detailSkuMax || "30"), 10) || 30,
      limit
    );

    // 新增：翻译相关参数
    const bilingual = String(req.query.bilingual || "").trim(); // e.g. "de-en" / "cn-en"
    const translateOne = String(req.query.translate || req.query.t || "").trim(); // e.g. "en"

    if (!listUrl) return res.status(400).json({ ok: false, error: "missing url" });

    try {
      const { items } = await parseUniversalCatalog(listUrl, limit, {
        debug, fast, detailSku, detailSkuMax
      });

      const rows = await buildRowsWithTranslations(items, { bilingual, translateOne });

      let XLSX;
      try {
        XLSX = await import("xlsx");
      } catch {}

      // === 优先尝试：使用 exceljs 真实嵌入位图（兼容老版 Excel） ===
        try {
          const ExcelJS = await import('exceljs').then(m => m.default || m);
          const wb2 = new ExcelJS.Workbook();
          const ws2 = wb2.addWorksheet('Katalog');

          // 写表头
          const header = rows[0] || [];
          ws2.addRow(header);

          // 列宽设置
          const colWidths = [6,16,22,60,18,14,12,24];
          for (let i = 0; i < colWidths.length; i++) {
            if (!ws2.getColumn(i+1)) continue;
            ws2.getColumn(i+1).width = colWidths[i];
          }

          // 行数据 + 图片嵌入
          const idxImg = 2; // 第3列：图片
          const origin = `${req.protocol}://${req.get('host')}`;
          for (let r = 1; r < rows.length; r++) {
            const row = rows[r];
            ws2.addRow(row);
            const excelRow = ws2.getRow(r+1);
            // 行高加大，便于显示图
            excelRow.height = 84;

            const url = (row[idxImg] || '').toString();
            if (url && /^https?:/i.test(url)) {
              const proxied = `${origin}/v1/api/image?url=${encodeURIComponent(url)}`;
              // 下载图片为 Buffer（通过你的代理，避免防盗链）
              try {
                const resp = await axios.get(proxied, {
                  responseType: 'arraybuffer',
                  timeout: 20000,
                  validateStatus: s => s >= 200 && s < 400,
                  headers: { 'User-Agent': "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36", Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' }
                });
                const buf = Buffer.from(resp.data);
                const ct = (resp.headers && resp.headers['content-type']) || 'image/jpeg';
                const ext = /png/i.test(ct) ? 'png' : 'jpeg';
                const imageId = wb2.addImage({ buffer: buf, extension: ext });
                const colIdx = idxImg + 1; // excel 列号从 1 开始（图片列是第3列）
                ws2.addImage(imageId, {
                  tl: { col: colIdx-1 + 0.1, row: r + 0.1 },
                  br: { col: colIdx-1 + 0.9, row: r + 0.9 },
                  editAs: 'oneCell',
                });
                // 清空单元格原文字，避免和图片重叠
                ws2.getCell(r+1, colIdx).value = '';
              } catch (e) {
                // 插图失败就保留原始 URL 文本作为兜底
              }
            }

            // 链接列做成超链接（如果存在）
            const linkIndex = header.findIndex(h => /link|链接/i.test(String(h||'')));
            if (linkIndex >= 0) {
              const l = (row[linkIndex] || '').toString();
              if (/^https?:/i.test(l)) {
                ws2.getCell(r+1, linkIndex+1).value = { text: '链接', hyperlink: l };
              }
            }
          }

          // 生成 xlsx buffer
          const outBuf = await wb2.xlsx.writeBuffer();
          res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
          res.setHeader('Content-Disposition', 'attachment; filename="catalog.xlsx"');
          res.setHeader('Cache-Control', 'no-store');
          return res.send(Buffer.from(outBuf));
        } catch (e) {
          console.warn('[export:exceljs-embed] not available or failed:', e?.message || e);
        }
        // === 继续 fallback：使用 SheetJS + IMAGE() 公式（新 Excel 可见） ===

        if (XLSX && XLSX.utils && XLSX.write) {
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.aoa_to_sheet(rows);
        
// —— 设置列宽与行高，保证图片可见 ——
ws["!cols"] = ws["!cols"] || [];
ws["!cols"][0] = ws["!cols"][0] || { wch: 6 };   // #
ws["!cols"][1] = ws["!cols"][1] || { wch: 16 };  // Artikel-Nr.
ws["!cols"][2] = ws["!cols"][2] || { wch: 22 };  // Bild/图片
ws["!cols"][3] = ws["!cols"][3] || { wch: 60 };  // 描述

ws["!rows"] = ws["!rows"] || [];
for (let i = 1; i < rows.length; i++) {
  ws["!rows"][i] = ws["!rows"][i] || { hpt: 84 };
}

try {
  const imageColIndex = 2; // 0-based: 0:#,1:Artikel-Nr.,2:Bild
  const linkColIndex  = rows[0].findIndex(h => /link|链接/i.test(String(h || "")));

  const encode = XLSX.utils.encode_cell;
  const origin = `${req.protocol}://${req.get('host')}`;
  for (let r = 1; r < rows.length; r++) {
    // 图片列：通过后端图片代理输出，避免目标站防盗链
    const imgAddr = encode({ r, c: imageColIndex });
    const imgCell = ws[imgAddr];
    const rawUrl  = imgCell && typeof imgCell.v === "string" ? imgCell.v : "";
    if (rawUrl && /^https?:/i.test(rawUrl)) {
      const proxied = `${origin}/v1/api/image?url=${encodeURIComponent(rawUrl)}`;
      const safe = proxied.replace(/"/g, '""');
      ws[imgAddr] = { f: `_xlfn.IMAGE("${safe}")` };
    }

    // 链接列：超链接公式（提升可用性）
    if (linkColIndex >= 0) {
      const lAddr = encode({ r, c: linkColIndex });
      const lCell = ws[lAddr];
      const lUrl  = lCell && typeof lCell.v === "string" ? lCell.v : "";
      if (lUrl && /^https?:/i.test(lUrl)) {
        const safe = lUrl.replace(/"/g, '""');
        ws[lAddr] = { f: `HYPERLINK("${safe}","链接")` };
      }
    }
  }
} catch (e) {
  console.warn("[export:xlsx:image-formula-proxy] skip:", e?.message || e);
}
XLSX.utils.book_append_sheet(wb, ws, "Katalog");
        const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
        res.setHeader(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        res.setHeader("Content-Disposition", 'attachment; filename="catalog.xlsx"');
        res.setHeader("Cache-Control", "no-store");
        return res.send(buf);
      }

      // Fallback: CSV（UTF-8 BOM）
      const toCsv = (arr) =>
        "\uFEFF" +
        arr
          .map((row) =>
            row
              .map((v) => {
                const s = String(v ?? "");
                const needsQuote = /[",;\n\r]/.test(s);
                return needsQuote ? `"${s.replace(/"/g, '""')}"` : s;
              })
              .join(",")
          )
          .join("\r\n");

      const csv = toCsv(rows);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="catalog.csv"');
      res.setHeader("Cache-Control", "no-store");
      return res.send(csv);
    } catch (e) {
      console.error("[export:xlsx] fail:", e?.message || e);
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  }
);

/* ──────────────────────────── listen ──────────────────────────── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[mvp2-backend] listening on :${PORT}`))
