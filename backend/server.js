import { detectStructure } from './lib/structureDetector.js';
import express from "express";
import cors from "cors";
import axios from "axios";
// --- UA: single source of truth ---
import * as cheerio from "cheerio";
const UA =
  process.env.SCRAPER_UA ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function fetchHtml(targetUrl) {
  globalThis.fetchHtml = fetchHtml;
  globalThis.cheerio = cheerio;
  const { data } = await axios.get(targetUrl, {
    headers: {
      "User-Agent": UA,
      "Accept-Language": "de,en;q=0.8,zh;q=0.6",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Referer": new URL(targetUrl).origin + "/",
    },
    timeout: 20000,
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 400,
  });
  return typeof data === "string" ? data : "";
}
function normalizeItem(x = {}) {
  return {
    sku: String(x.sku ?? "").trim(),
    title: String(x.title ?? "").trim(),
    url: String(x.url ?? "").trim(),
    img: String(x.img ?? "").trim(),
    price: x.price ?? null,
    currency: String(x.currency ?? ""),
    moq: String(x.moq ?? "")
  };
}

function standardize(payload) {
  if (!payload || !Array.isArray(payload.items)) return payload;
  return { ...payload, items: payload.items.map(normalizeItem) };
}

globalThis.normalizeItem = normalizeItem;
globalThis.standardize = standardize;

// === table normalizer helpers (for frontend compatibility) ===
function normalizeRow(it = {}) {
  const u = String(it.url ?? it.link ?? "");
  return {
    sku:   String(it.sku   ?? ""),
    title: String(it.title ?? ""),
    img:   String(it.img   ?? ""),
    desc:  String(it.desc  ?? ""),
    moq:   String(it.moq   ?? ""),
    // keep price as-is when null/number/string; default to ""
    price: (it.price == null ? "" : (typeof it.price === "number" ? it.price : String(it.price))),
    url:   u,
    link:  u,
  };
}

function toTablePayload({ url = "", items = [], adapter = "generic" } = {}) {
  const rows = Array.isArray(items) ? items.map(normalizeRow) : [];
  return {
    ok: true,
    url,
    count: rows.length,
    adapter,
    items: rows, // alias
    data:  rows, // alias
    list:  rows, // alias
    rows,        // alias
  };
}

globalThis.normalizeRow = normalizeRow;
globalThis.toTablePayload = toTablePayload;
// === end table normalizer helpers ===


// --- app init & middlewares ---
const app = express();
app.use(cors({
  origin: [
    /^(https?:\/\/)?(www\.)?yunivera\.com$/i,
    /^(https?:\/\/)?localhost(:\d+)?$/i,
    /^(https?:\/\/)?[a-z0-9\-]+\.onrender\.com$/i
  ],
  methods: ["GET","POST","OPTIONS"],
  allowedHeaders: ["Content-Type","Accept"],
  credentials: false,
}));
app.options("*", cors());
app.use((_, res, next) => { res.setHeader("Vary", "Origin"); next(); });
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));



// --- 图片代理与 base64 服务 ---
// GET /v1/api/image?url=...&format=raw|base64
// - raw    ：直接二进制透传，前端 <img> 兜底加载
// - base64 ：返回 { ok, base64, contentType }，ExcelJS 用于内嵌
const routerImage = express.Router();

routerImage.get("/image", async (req, res) => {
  const url = String(req.query.url || "").trim();
  const format = String(req.query.format || "raw").toLowerCase();

  if (!url) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(400).json({ ok: false, error: "missing url" });
  }

  try {
    const r = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 20000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "Accept-Language": "de,en;q=0.9,zh;q=0.8",
        "Referer": url,
      },
      validateStatus: () => true,
      maxRedirects: 5,
    });

    const buf = Buffer.from(r.data || []);
    const ct = String(r.headers["content-type"] || "application/octet-stream");

    if (format === "base64") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.json({
        ok: r.status >= 200 && r.status < 400,
        base64: buf.toString("base64"),
        contentType: ct,
        status: r.status,
      });
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", ct || "application/octet-stream");
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    return res.status(r.status || 200).send(buf);
  } catch (e) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
});

// 统一挂载
app.use("/v1/api", routerImage);

// load router lazily to avoid cyclic/declaration issues
// --- legacy aliases: must be registered BEFORE catalogRouter mounts ---
const { default: catalogRouter } = await import("./routes/catalog.js");
app.use("/v1/api/catalog", catalogRouter);
app.use("/v1/api", catalogRouter);

// health check
app.get("/v1/health", (_req, res) => res.status(200).json({ ok: true }));
app.get("/v1/api/health", (_req, res) => res.status(200).json({ ok: true }));

// ---- legacy detect + probe aliases (for old frontends) ----
app.get("/v1/detect", (req, res) => {
  const url = String(req.query.url || "");
  return res.json({ ok: true, url, type: "catalog", adapter: "generic" });
});

app.get("/v1/catalog/_probe", (_req, res) => {
  const rows = [{ sku:"demo", title:"probe ok", url:"#", img:"", desc:"", moq:"", price:"" }];
  return res.json({
    ok: true,
    url: "/_probe",
    count: rows.length,
    adapter: "probe",
    items: rows, data: rows, list: rows, rows
  });
});

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

function priceFromJsonLd(json) {
  try {
    const offer =
      json?.offers ||
      (Array.isArray(json) ? json.find((x) => x && x.offers) : null);

    const take = (v) => {
      if (v == null) return null;
      // 允许 "149,00 €"、"€149.00"、"1.299,95" 等格式，统一提取数字与小数点/逗号
      const m = String(v).match(/-?\d[\d.,]*/);
      if (!m) return null;
      let num = m[0].replace(/\./g, "").replace(",", "."); // 千分位点 -> 空；逗号 -> .
      const n = parseFloat(num);
      return Number.isFinite(n) ? n : null;
    };

    if (Array.isArray(offer)) {
      for (const it of offer) {
        const p = take(it?.price ?? it?.lowPrice ?? it?.highPrice ?? it?.priceSpecification?.price);
        if (p != null) return p;
      }
      return null;
    } else if (offer && typeof offer === "object") {
      return (
        take(offer.price) ??
        take(offer.lowPrice) ??
        take(offer.highPrice) ??
        take(offer.priceSpecification?.price) ??
        null
      );
    }
    return null;
  } catch {
    return null;
  }
}
/* ──────────────────────────── image proxy ──────────────────────────── */
// === structure detect helpers (BEGIN) ===================================
function looksLikeShopify($, html) {
  return /\bcdn\.shopify\.com\b/i.test(html)
      || /\bshopify-section\b/i.test(html)
      || /\bwindow\.Shopify\b/i.test(html)
      || /\bShopify\.theme\b/i.test(html);
}

function looksLikeShopware($, html) {
  return /\bshopware\b/i.test(html)
      || /\bdata-controller="product-listing"/i.test(html)
      || /\bproduct--box\b/i.test(html)
      || $('meta[name="generator"][content*="Shopware"]').length > 0;
}

function looksLikeWoo($, html) {
  return /\bwoocommerce\b/i.test(html)
      || /\bwp-content\b/i.test(html)
      || $('body[class*="woocommerce"]').length > 0
      || $('ul.products li.product').length > 0;
}

function looksLikeMagento($, html) {
  return /\bMagento\b/i.test(html)
      || /\bpagebuilder\b/i.test(html)
      || /\bdata-mage-init\b/i.test(html)
      || $('script[type="text/x-magento-init"]').length > 0;
}
// === structure detect helpers (END) =====================================

// === /v1/api/detect =====================================================

// (image64 alias already defined above)

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
// 只认：Artikel-Nr./Artikelnummer/Art.-Nr./Bestellnummer/Item no./Produktnummer/Hersteller-Nr
// 排除：Prüfziffer / Hersteller（纯品牌）/ EAN / GTIN
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

        // 3) 强化兜底：整页文本里优先拿 Artikel-Nr
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

        // A) 常见位置：技术数据/表格（dt/th + dd/td）
        $("dt,th,.data,.spec,.label,li,div,p").each((_k, el) => {
          if (found) return false;
          const t = text($(el));
          // 同节点：例如 “Artikel-Nr.: 1090066”
          const mInline = t.match(/(Artikel-?Nr\.?|Artikelnummer|Art\.-?Nr\.?|Bestellnummer|Produktnummer|Item\s*(?:No\.?|Number)|Hersteller-?Nr\.?)\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9\-_.\/]{1,})/i);
          if (mInline && !BADLBL.test(mInline[1] || "")) {
            found = mInline[2].trim();
            return false;
          }
          // 分离节点：label 在 el，值在 next()
          if (GOODLBL.test(t) && !BADLBL.test(t)) {
            const v = text($(el).next());
            if (v && !/^\s*(ean|gtin)\b/i.test(v)) {
              found = v;
              return false;
            }
          }
        });

        // B) JSON-LD 键名兜底（有些站把 Artikel-Nr 放到 mpn/sku）
        if (!found) {
          $('script[type="application/ld+json"]').each((_i, el) => {
            if (found) return false;
            try {
              const data = JSON.parse($(el).contents().text().trim());
              const arr = Array.isArray(data) ? data : [data];
              for (const obj of arr) {
                const cand = obj?.mpn || obj?.sku || obj?.productID || "";
                const label = "Artikel-Nr.";
                if (cand && !/^\s*(ean|gtin)\b/i.test(String(cand))) {
                  found = String(cand).trim();
                  break;
                }
              }
            } catch {}
          });
        }

        // C) 全页文本兜底（优先 Artikel-Nr）
        if (!found) {
          const page = $("body").text().replace(/\s+/g, " ");
          const m = page.match(/(Artikel-?Nr\.?|Artikelnummer|Art\.-?Nr\.?|Bestellnummer|Produktnummer|Item\s*(?:No\.?|Number)|Hersteller-?Nr\.?)\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9\-_.\/]{1,})/i);
          if (m && !BADLBL.test(m[1] || "")) found = m[2].trim();
        }

        // 覆写规则：如果找到 Artikel-Nr，则强制覆盖；否则保持原值
        if (found) items[i].sku = found;
        else {
          // 把开头的 "EAN " 去掉，避免“EAN 426…”显示在 Artikel-Nr 列
          items[i].sku = String(initial).replace(/^\s*ean\s*[:：]?\s*/i, "").trim() || initial;
        }
      } catch {}
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, jobs.length) }, worker));
}

/* ──────────────────────────── beamer-discount 详情解析（保持原样供详情页直抓） ──────────────────────────── */
async function parseBeamerDetail(detailUrl) {
  const html = await fetchHtml(detailUrl);
  const $ = cheerio.load(html, { decodeEntities: false });

  const title =
    text($("h1, .product-title").first()) ||
    text($('meta[property="og:title"]').first()) ||
    $("title").text().trim();

  // 价格
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

  // 图片
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

  // SKU（尽量拿 Artikel-Nr）
  const GOOD = /(Artikel-?Nr\.?|Artikelnummer|Art\.-?Nr\.?|Bestellnummer|Produktnummer|Item\s*(?:No\.?|Number)|Hersteller-?Nr\.?)/i;
  const BAD  = /(prüfziffer|ean|gtin|hersteller(?!-?nr))/i;
  let sku = "";

  // A) label 同节点
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

  // B) JSON-LD 候选
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

  // C) 全页兜底
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
      // NOTE: parseMemoryking should exist in your adapters. If absent, generic flow still works.
      const parseMemoryking = (await import("./adapters/memoryking.js")).default;
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
        // 过滤“Zum Produkt …”
        part = (part || []).filter(it => !/^zum\s+produkt/i.test((it.title || "")));

        // 去重
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

      // 第 1 页
      let $ = await harvest(listUrl);

      // 找分页
      const pageSet = new Map(); // n -> url
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

      // 若页面未给出分页链接，主动猜测 ?page=?p=/page/
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

      // 详情覆写 SKU（Artikel-Nr.）
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
      // 'sino' adapter must exist in your project context
      const sino = await import("./adapters/sinotronic.js");
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

      const pageSet = new Map(); // pageNo -> url
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
                break;
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
    const uniMod = await import("./adapters/universal.js");
    const uni = await uniMod.parseUniversal({ url: listUrl, limit });
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
/* moved to routes/compat -> catalog router */

// 兼容别名：/v1/api/parse
// ✅ 兼容老路径：/v1/api/catalog 与 *.json 变体
/* ──────────────────────────── listen ──────────────────────────── */

// ====== CATALOG PARSE ROUTES (compat) ======
// Unified handler
async function __handleCatalogParse(req, res) {
  try {
    const url   = String(req.query.url || "").trim();
    const limit = Math.min(parseInt(req.query.limit || "50", 10) || 50, 200);
    const debug = /^(1|true|yes)$/i.test(String(req.query.debug || ""));
    const detailSku = /^(1|true|yes)$/i.test(String(req.query.detail || ""));

    if (!url) return res.status(400).json({ ok: false, error: "missing url" });

    const { items = [], adapter = "generic" } =
      await parseUniversalCatalog(url, limit, { debug, detailSku });

    const payload = toTablePayload({ url, items, adapter });
    return res.json(payload);
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, error: (e && e.message) ? e.message : String(e) });
  }
}

// Primary path used by the frontend
app.get("/v1/api/catalog/parse", __handleCatalogParse);

// Aliases kept for backward-compatibility
app.get("/v1/api/parse", __handleCatalogParse);
app.get("/v1/api/catalog", __handleCatalogParse);
app.get("/v1/api/catalog.json", __handleCatalogParse);
// --- legacy aliases without /api (some clients/gateway still use these) ---
app.get("/v1/catalog/parse", __handleCatalogParse);
app.get("/v1/catalog", __handleCatalogParse);
app.get("/v1/catalog.json", __handleCatalogParse);

// ====== end compat routes ======

const PORT = Number(process.env.PORT || 10000);

app.listen(PORT, () => console.log(`[mvp2-backend] listening on :${PORT}`));
 


