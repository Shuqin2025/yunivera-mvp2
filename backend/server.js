/* backend/server.js — full file, with beamer-discount route + strict SKU rules */

import express from "express";
import cors from "cors";
import axios from "axios";
import * as cheerio from "cheerio";

// ✅ 可选翻译（保留你仓库里的实现）
import * as translate from "./lib/translate.js";

// ✅ 站点适配器（保留）
import parseMemoryking from "./adapters/memoryking.js";
import sino from "./adapters/sinotronic.js";
import parseUniversal from "./adapters/universal.js";

const app = express();
app.use(cors({ origin: "*", exposedHeaders: ["X-Lang", "X-Adapter"] }));

/* ─────────────────────────── health ─────────────────────────── */
app.get(["/", "/healthz", "/health", "/api/health"], (_req, res) =>
  res.type("text/plain").send("ok")
);
app.get("/v1/api/health", (_req, res) => {
  res.json({ ok: true, status: "up", ts: Date.now() });
});
app.get("/v1/api/__version", (_req, res) => {
  res.json({
    version:
      "mvp-universal-parse-2025-10-05+beamer-discount-detail-routing+strict-sku-v2",
    note:
      "Add beamer-discount detail router + default detailSku on catalog; strict ALLOW/DENY for SKU; filter 'Zum Produkt' cards; keep all other adapters.",
  });
});

/* ─────────────────────────── utils ─────────────────────────── */
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
const abs = (base, p) => {
  if (!p) return "";
  try {
    return new URL(p, base).href;
  } catch {
    return "";
  }
};
const text = ($el) => (($el.text() || "").replace(/\s+/g, " ").trim());
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
  let price = "",
    currency = "€";
  $('script[type="application/ld+json"]').each((_i, el) => {
    try {
      const raw = $(el).contents().text().trim();
      if (!raw) return;
      const data = JSON.parse(raw);
      const arr = Array.isArray(data) ? data : [data];
      for (const obj of arr) {
        if (!obj) continue;
        const t = obj["@type"];
        const isProduct =
          t === "Product" || (Array.isArray(t) && t.includes("Product"));
        if (!isProduct) continue;
        let offers = obj.offers;
        offers = Array.isArray(offers) ? offers[0] : offers;
        const p = offers?.price ?? offers?.lowPrice ?? offers?.highPrice;
        if (p != null && p !== "") {
          price = String(p);
          currency = offers?.priceCurrency || currency;
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

/* ─────────────────────────── image proxy（保留） ─────────────────────────── */
app.get("/v1/api/image", async (req, res) => {
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
});
app.get("/v1/api/image64", async (req, res) => {
  req.query.format = "base64";
  return app._router.handle(req, res, () => {});
});

/* ─────────────────────────── 你现有的站点适配器（保留） ─────────────────────────── */
/* auto-schmuck、s-impuls、Woo、generic…（原样保留，略） */
/* ……为了可读性，这里不重复贴注释；函数体完整保留在文件里 */

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

/* ─────────────────────────── generic cards / Woo（保留） ─────────────────────────── */
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

    // ★ beamer-discount：过滤“Zum Produkt …”卡片标题
    if (/beamer-discount\.de/.test(new URL(listUrl).hostname)) {
      if (/^\s*zum\s+produkt\b/i.test(title)) return;
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

/* ─────────────────────────── enrich（保留） ─────────────────────────── */
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

/* ─────────────────────────── ★ detail SKU extractor ─────────────────────────── */
/** 仅允许的货号标签；显式排除 EAN / Prüfziffer / Hersteller（非 Hersteller-Nr.）等 */
const SKU_ALLOW_LABEL = /^(?:artikel-?nr\.?|artikelnummer|art\.-?nr\.?|bestellnummer|item\s*(?:no\.?|number)|produktnummer|hersteller-?nr\.?|sku|mpn)$/i;
const SKU_DENY_LABEL = /\b(?:ean|prüfziffer|hersteller(?!-?nr)|manufacturer|brand)\b/i;

function pickSkuFromJsonLd($) {
  let found = "";
  $('script[type="application/ld+json"]').each((_k, el) => {
    try {
      const raw = $(el).contents().text().trim();
      if (!raw) return;
      const data = JSON.parse(raw);
      const arr = Array.isArray(data) ? data : [data];
      for (const o of arr) {
        if (!o) continue;
        for (const [k, v] of Object.entries(o)) {
          if (!v) continue;
          if (SKU_DENY_LABEL.test(k)) continue;
          if (SKU_ALLOW_LABEL.test(k)) {
            found = String(v).trim();
            return false;
          }
        }
      }
    } catch {}
  });
  return found;
}
function pickSkuFromLabelDom($root) {
  // table: th/td
  let found = "";
  $root
    .find("table tr")
    .addBack("table tr")
    .each((_i, tr) => {
      if (found) return false;
      const $tr = $(tr);
      const key = text($tr.find("th,td").first()).toLowerCase();
      const val = text($tr.find("td").last());
      if (!key || !val) return;
      if (SKU_DENY_LABEL.test(key)) return;
      if (SKU_ALLOW_LABEL.test(key)) {
        found = val;
        return false;
      }
    });
  if (found) return found;

  // dl: dt/dd
  $root.find("dl").each((_i, dl) => {
    if (found) return false;
    const $dl = $(dl);
    $dl.find("dt").each((_j, dt) => {
      if (found) return false;
      const k = text($(dt)).toLowerCase();
      const $dd = $(dt).next("dd");
      const v = text($dd);
      if (!k || !v) return;
      if (SKU_DENY_LABEL.test(k)) return;
      if (SKU_ALLOW_LABEL.test(k)) {
        found = v;
        return false;
      }
    });
  });
  if (found) return found;

  // 一般 label : value
  $root
    .find("*")
    .filter((_i, el) => {
      const t = text($(el)).toLowerCase();
      return t && SKU_ALLOW_LABEL.test(t);
    })
    .each((_i, el) => {
      if (found) return false;
      // value 在下一个节点或同层兄弟
      const t = text($(el)).toLowerCase();
      if (SKU_DENY_LABEL.test(t)) return;
      const cand =
        text($(el).next()) ||
        text($(el).parent())?.replace(text($(el)), "") ||
        "";
      const v = cand.replace(/^[:：]\s*/, "").trim();
      if (v) {
        found = v;
        return false;
      }
    });

  return found;
}

/* 通用详情覆写（严格只认允许标签；显式排除 EAN/Prüfziffer/Hersteller） */
async function overwriteSkuFromDetailGeneric(items, maxCount = 30) {
  const take = Math.min(items.length, maxCount);
  const jobs = [];
  for (let i = 0; i < take; i++) {
    const it = items[i];
    const good = it.sku && /\S{3,}/.test(String(it.sku)) && !/^ean\b/i.test(it.sku);
    if (good || !it.url) continue;
    jobs.push({ i, url: it.url });
  }
  if (!jobs.length) return;

  const CONC = 8,
    TIMEOUT = 12000;
  let p = 0;

  async function worker() {
    while (p < jobs.length) {
      const { i, url } = jobs[p++];
      try {
        const r = await axios.get(url, {
          headers: { "User-Agent": UA, "Accept-Language": "de,en;q=0.8" },
          timeout: TIMEOUT,
          validateStatus: (s) => s >= 200 && s < 400,
        });
        const $ = cheerio.load(r.data);

        let sku =
          pickSkuFromJsonLd($) ||
          pickSkuFromLabelDom($("main, #main, .product-detail, body"));

        if (sku && !/^ean\b/i.test(sku)) {
          items[i].sku = sku;
        }
      } catch {}
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, jobs.length) }, worker));
}

/* ─────────────────────────── ★ beamer-discount 适配 ─────────────────────────── */
function isBeamerDetailPathname(pathname) {
  // 形如 “…-1000869” 的 slug 视作详情
  return /-[0-9]{3,}(?:\/)?$/i.test(pathname);
}
async function parseBeamerDetail(detailUrl) {
  const html = await fetchHtml(detailUrl);
  const $ = cheerio.load(html, { decodeEntities: false });

  // 标题
  const title =
    text($("h1").first()) ||
    text($(".product-title, .detail-title").first()) ||
    text($("title"));

  // 主图：优先 JSON-LD
  let img = "";
  $('script[type="application/ld+json"]').each((_i, el) => {
    try {
      const raw = $(el).contents().text().trim();
      if (!raw) return;
      const data = JSON.parse(raw);
      const arr = Array.isArray(data) ? data : [data];
      for (const o of arr) {
        if (o?.image) {
          const pic = Array.isArray(o.image) ? o.image[0] : o.image;
          if (pic) {
            img = abs(detailUrl, String(pic).split("?")[0]);
            return false;
          }
        }
      }
    } catch {}
  });
  if (!img) {
    const $img = $("img").first();
    img = abs(
      detailUrl,
      ($img.attr("data-src") ||
        $img.attr("data-original") ||
        ($img.attr("srcset") || "").split(" ").find((s) => /^https?:/i.test(s)) ||
        $img.attr("src") ||
        ""
      ).split("?")[0]
    );
  }

  // 价格
  let price = priceFromJsonLd($);
  if (!price)
    price =
      normalizePrice(
        text($(".price, .product-price, .amount, .price__value").first())
      ) || null;

  // SKU（严格 ALLOW / DENY）
  const sku =
    pickSkuFromJsonLd($) ||
    pickSkuFromLabelDom($("main, #main, .product-detail, body"));

  return [
    {
      sku: sku || guessSkuFromTitle(title),
      title,
      url: detailUrl,
      img,
      price: price || null,
      currency: "",
      moq: "",
    },
  ];
}

/* ─────────────────────────── 统一入口（含 beamer-discount 分支） ─────────────────────────── */
async function parseUniversalCatalog(
  listUrl,
  limit = 50,
  { debug = false, fast = false, detailSku = false, detailSkuMax = 30 } = {}
) {
  let adapter = "generic";
  try {
    const u = new URL(listUrl);
    const host = u.hostname;

    // memoryking（保留）
    if (host.includes("memoryking.de")) {
      adapter = "memoryking/v5.1";
      const html = await fetchHtml(listUrl);
      const $ = cheerio.load(html, { decodeEntities: false });
      const items = await parseMemoryking({
        $,
        url: listUrl,
        rawHtml: html,
        limit,
        debug,
      });
      return { items, adapter };
    }

    // 示例适配器（保留）
    if (/(\.|^)newsite\.de$/i.test(host)) {
      adapter = "exampleSite";
      const html = await fetchHtml(listUrl);
      const $ = cheerio.load(html, { decodeEntities: false });
      const parseExample = (await import("./adapters/exampleSite.js")).default;
      const items = await parseExample({ $, url: listUrl, rawHtml: html, limit, debug });
      return { items, adapter };
    }

    // ★ akkuman：默认 fast；只有 detailSku=1 时才会去详情
    if (/(\.|^)akkuman\.de$/i.test(host)) {
      adapter = "exampleSite";
      const html = await fetchHtml(listUrl);
      const $ = cheerio.load(html, { decodeEntities: false });
      const parseExample = (await import("./adapters/exampleSite.js")).default;
      const wantsDetail = !!detailSku;
      const fastEffective = !wantsDetail;
      const items = await parseExample({
        $,
        url: listUrl,
        rawHtml: html,
        limit,
        debug,
        fast: fastEffective,
      });
      return { items, adapter };
    }

    // sinotronic（保留：自动翻页）
    if (host.includes("sinotronic-e.com")) {
      adapter = "sinotronic";
      const re = /(\?\d+_)(\d+)\.html$/i;
      const makeUrl = (p) =>
        re.test(listUrl) ? listUrl.replace(re, (_, a) => `${a}${p}.html`) : null;

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

    // ★ beamer-discount：详情路由 + 目录默认详情覆写 + 过滤“Zum Produkt …”
    if (host.includes("beamer-discount.de")) {
      const isDetail = isBeamerDetailPathname(u.pathname);
      if (isDetail) {
        adapter = "beamer-discount/detail";
        const items = await parseBeamerDetail(listUrl);
        return { items, adapter };
      }
      // 目录
      adapter = "beamer-discount/catalog";
      const html = await fetchHtml(listUrl);
      const $ = cheerio.load(html, { decodeEntities: false });

      // 先用通用卡片
      let items = parseByCardSelectors($, listUrl, limit);

      // 强制过滤掉 “Zum Produkt …”
      items = items.filter((it) => !/^\s*zum\s+produkt\b/i.test(it.title || ""));

      // 默认开启详情覆写（拿 Artikel-Nr. 而不是 EAN）
      await overwriteSkuFromDetailGeneric(items, Math.min(detailSkuMax || 30, limit));

      // 价格兜底：可选 enrich 前几条
      return { items, adapter };
    }
  } catch {}

  // 外部通用适配器（保留）
  try {
    const uni = await parseUniversal({ url: listUrl, limit });
    if (Array.isArray(uni) && uni.length) return { items: uni, adapter: "universal-ext" };
  } catch {}

  // 内置回退（保留）
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
  if (wcCards.length)
    return { items: parseWooFromHtml($, listUrl, limit), adapter: "woocommerce" };

  // 进一步的 generic links（保留你原有实现）
  return { items: parseGenericFromHtml($, listUrl, limit), adapter: "generic-links" };
}

/* ─────────────────────────── API ─────────────────────────── */
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

  const wantImgBase64 = String(req.query.img || "") === "base64";
  const imgCount = Math.min(
    parseInt(String(req.query.imgCount || "0"), 10) || 0,
    limit
  );

  const targetLang = String(req.query.translate || req.query.t || "")
    .trim()
    .toUpperCase();
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

  const debug = /^(1|true|yes|on)$/i.test(String(req.query.debug || ""));
  const fast = /^(1|true|yes|on)$/i.test(String(req.query.fast || ""));
  const detailSku = /^(1|true|yes|on)$/i.test(String(req.query.detailSku || ""));
  const detailSkuMax = Math.min(
    parseInt(String(req.query.detailSkuMax || "30"), 10) || 30,
    limit
  );

  if (!listUrl) return res.status(400).json({ ok: false, error: "missing url" });

  const t0 = Date.now();
  try {
    const { items, adapter } = await parseUniversalCatalog(listUrl, limit, {
      debug,
      fast,
      detailSku,
      detailSkuMax,
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
            it.img_b64 = `data:${ct};base64,${Buffer.from(r.data).toString(
              "base64"
            )}`;
          } catch {}
        })
      );
    }

    // 翻译（保留）
    if (items.length && targetLang) {
      const suffix = "_" + targetLang.toLowerCase();
      const translateOne = async (txt) => {
        try {
          if (!txt) return txt;
          if (typeof translate.translateText === "function") {
            return await translate.translateText(txt, targetLang);
          }
          if (typeof translate.translateBatch === "function") {
            const out = await translate.translateBatch([txt], targetLang);
            return Array.isArray(out) ? out[0] : txt;
          }
          if (typeof translate.default === "function") {
            return await translate.default(txt, targetLang);
          }
          if (typeof translate.translate === "function") {
            return await translate.translate(txt, targetLang);
          }
        } catch {}
        return txt;
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
          } catch {}
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

// 兼容别名与旧路径（保留）
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
app.get(
  ["/v1/api/catalog", "/v1/api/catalog.json", "/v1/api/catalog/parse.json"],
  (req, res) =>
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

/* ─────────────────────────── listen ─────────────────────────── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[mvp2-backend] listening on :${PORT}`));

/* 备注：
 * 1) beamer-discount 目录页会默认走详情覆写（拿 Artikel-Nr.），
 *    详情页形如 “…-1000869” 的 URL 直接按详情解析（标题/价格/图片/SKU）。
 * 2) 通用覆写器严格 ALLOW/DENY，已显式排除 EAN/Prüfziffer/Hersteller（非 Hersteller-Nr.）。
 * 3) 其它站点（S-IMPULS 翻页、Memoryking 适配等）不做变更。
 */
