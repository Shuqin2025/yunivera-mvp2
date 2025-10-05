// （完整 server.js，含你现有的所有分支；仅按需补充 detailSku / beamer / akkuman 能力）
// === Core & deps =============================================================
import express from "express";
import cors from "cors";
import axios from "axios";
import * as cheerio from "cheerio";

// ✅ 可选翻译（保留）
import * as translate from "./lib/translate.js";

// ✅ 站点适配器（保留）
import parseMemoryking from "./adapters/memoryking.js";
import sino from "./adapters/sinotronic.js";
import parseUniversal from "./adapters/universal.js";

const app = express();
app.use(cors({ origin: "*", exposedHeaders: ["X-Lang", "X-Adapter"] }));

/* ──────────────────────────── health ──────────────────────────── */
app.get(["/", "/healthz", "/health", "/api/health"], (_req, res) => res.type("text/plain").send("ok"));
app.get("/v1/api/health", (_req, res) => { res.json({ ok: true, status: "up", ts: Date.now() }); });

app.get("/v1/api/__version", (_req, res) => {
  res.json({
    version: "mvp-universal-parse-2025-10-05-beamer+akkuman-detailSku",
    note: "Explicit domain routing; akkuman fast-by-default; beamer single-detail support; generic detailSku overwrite; optional translate.",
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
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
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
  try { return new URL(maybe, base).href; } catch { return ""; }
}
function text($el) { return ($el.text() || "").replace(/\s+/g, " ").trim(); }
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

/* ──────────────────────────── image proxy（保留） ──────────────────────────── */
app.get("/v1/api/image", async (req, res) => {
  const url = String(req.query.url || "").trim();
  const format = String(req.query.format || "").toLowerCase();
  if (!url) return res.status(400).send("missing url");
  try {
    const r = await axios.get(url, {
      responseType: "arraybuffer", timeout: 20000,
      headers: { "User-Agent": UA, Accept: "image/avif,image/webp,image/*,*/*;q=0.8", Referer: new URL(url).origin + "/" },
      validateStatus: (s) => s >= 200 && s < 400,
    });
    const ct = r.headers["content-type"] || "image/jpeg";
    res.set("Access-Control-Allow-Origin", "*");
    if (format === "base64") {
      const base64 = Buffer.from(r.data).toString("base64");
      return res.json({ ok: true, contentType: ct, base64: `data:${ct};base64,${base64}` });
    }
    res.set("Content-Type", ct);
    res.set("Cache-Control", "public, max-age=604800");
    res.send(r.data);
  } catch (e) {
    console.error("[image] fail:", e?.message || e);
    res.status(502).send("image fetch failed");
  }
});
app.get("/v1/api/image64", async (req, res) => { req.query.format = "base64"; return app._router.handle(req, res, () => {}); });

/* ──────────────────────────── 辅助：通用卡片解析（保留） ──────────────────────────── */
function parseByCardSelectors($, listUrl, limit = 50) {
  const items = [];
  const seen = new Set();
  const CARD_SEL = [
    'div[class*="product"]','li[class*="product"]','article[class*="product"]',
    '.product-item','.product-card','.prod-item','.good, .goods, .item',
  ].join(", ");
  const BAD_LINK = /(add-to-cart|wishlist|compare|login|register|cart|filter|sort)/i;

  $(CARD_SEL).each((_i, el) => {
    if (items.length >= limit) return false;
    const $card = $(el);
    const $img = $card.find("img").first();
    let src =
      $img.attr("data-src") || $img.attr("data-original") ||
      ($img.attr("srcset") || "").split(" ").find((s) => /^https?:/i.test(s)) ||
      $img.attr("src") || "";
    const img = abs(listUrl, (src || "").split("?")[0]);

    let $a = $card.find("a[href]").filter((_, a) => !BAD_LINK.test(String($(a).attr("href")))).first();
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
      text($card.find(".price,.product-price,.amount,.money,.m-price,.price--default,.price__value").first()) || "";
    if (!priceTxt) {
      const m = $card.text().match(/\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})\s*(?:€|EUR)/i);
      if (m) priceTxt = m[0].replace(/\s+/g, " ");
    }
    items.push({
      sku: text($card.find(".sku,.product-sku,.model,.product-model").first()) || guessSkuFromTitle(title),
      title, url: href, img, price: priceTxt || null, currency: "", moq: "",
    });
  });
  return items;
}

/* ──────────────────────────── WooCommerce 解析（保留） ──────────────────────────── */
function parseWooFromHtml($, listUrl, limit = 50) {
  const items = [];
  const $cards = $("ul.products li.product");
  if (!$cards.length) return items;
  $cards.each((_i, li) => {
    if (items.length >= limit) return;
    const $li = $(li);
    const $a = $li.find("a.woocommerce-LoopProduct-link").first().length
      ? $li.find("a.woocommerce-LoopProduct-link").first() : $li.find("a[href]").first();
    const href = $a.attr("href") || "";
    const title =
      text($li.find(".woocommerce-loop-product__title").first()) ||
      ($a.attr("title") || "").trim() || text($a) || "";
    const $img = $li.find("img").first();
    const src =
      $img.attr("data-src") || $img.attr("data-original") ||
      ($img.attr("srcset") || "").split(" ").find((s) => /^https?:/i.test(s)) ||
      $img.attr("src") || "";
    const priceTxt = text($li.find(".price .amount").first()) || text($li.find(".price").first()) || "";
    if (!href || !title) return;
    items.push({
      sku: guessSkuFromTitle(title),
      title, url: abs(listUrl, href), img: abs(listUrl, (src || "").split("?")[0]),
      price: priceTxt || null, currency: "", moq: "",
    });
  });
  return items;
}

/* ──────────────────────────── 详情富化（保留） ──────────────────────────── */
async function enrichDetail(item) {
  try {
    const html = await fetchHtml(item.url);
    const $ = cheerio.load(html);
    let priceText = priceFromJsonLd($);
    if (!priceText) {
      const sel = [
        "meta[itemprop='price']","[itemprop='price']",".woocommerce-Price-amount",".price .amount",
        ".price .value",".product-price",".price-value",".amount",".price",
      ].join(", ");
      const $node = $(sel).first();
      const raw = ($node.attr("content") || text($node) || "").trim();
      if (raw) priceText = normalizePrice(raw);
    }
    const moqSel = ".moq, .min-order, .minimum, .minbestellmenge, .minimum-order, .minimum__value";
    const moqText = text($(moqSel).first());
    if (priceText) item.price = priceText;
    if (moqText) item.moq = moqText;
  } catch {}
}

/* ──────────────────────────── 通用详情覆写 SKU（标签白名单 + 显式排除） ──────────────────────────── */
async function overwriteSkuFromDetailGeneric(items, maxCount = 30) {
  const LABEL = /^(artikel-?nr\.?|artikelnummer|art\.-?nr\.?|bestellnummer|item\s*(?:no\.?|number)|sku|mpn|modell|model|herstellernummer|hersteller-?nr\.?)$/i;
  const BAD   = /(prüfziffer|hersteller(?!-?nr)|manufacturer|brand)/i; // 显式排除
  const take = Math.min(items.length, maxCount);
  const jobs = [];
  for (let i = 0; i < take; i++) {
    const it = items[i];
    const hasGoodSku = it.sku && /\S{3,}/.test(String(it.sku));
    if (hasGoodSku || !it.url) continue;
    jobs.push({ i, url: it.url });
  }
  if (!jobs.length) return;
  const CONC = 8, TIMEOUT = 10000; // 并发 + 超时
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
        // 1) JSON-LD 尝试
        $('script[type="application/ld+json"]').each((_k, el) => {
          try {
            const raw = $(el).contents().text().trim();
            if (!raw) return;
            const data = JSON.parse(raw);
            const arr  = Array.isArray(data) ? data : [data];
            for (const o of arr) {
              const kv = Object.entries(o).find(([k]) => LABEL.test(k));
              if (kv && !BAD.test(kv[0]) && kv[1]) { found = String(kv[1]); break; }
            }
          } catch {}
        });
        // 2) 可见标签：label → value
        if (!found) {
          const CAND = [
            "*:contains('Artikel')","*:contains('Art.-Nr')","*:contains('Artikelnummer')",
            "*:contains('Bestellnummer')","*:contains('Item')","*:contains('SKU')","*:contains('MPN')",
            "*:contains('Modell')","*:contains('Model')","*:contains('Hersteller-Nr')","*:contains('Herstellernummer')",
          ].join(", ");
          $(CAND).each((_k, el) => {
            const txt = ($(el).text() || "").replace(/\s+/g,' ').trim();
            if (LABEL.test(txt) && !BAD.test(txt)) {
              // 常见结构：<dt>Label</dt><dd>Value</dd> 或 "Label: Value"
              const next = ($(el).next().text() || "").trim();
              const parent = ($(el).parent().text() || "").trim();
              const merged = next || parent.replace(txt, "").replace(/[:：]/, "").trim();
              if (merged && /\S{3,}/.test(merged)) { found = merged; return false; }
            }
          });
        }
        if (found) items[i].sku = String(found).trim();
      } catch {}
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, jobs.length) }, worker));
}

/* ──────────────────────────── Beamer-discount 专用：详情页识别 & 单品解析 ──────────────────────────── */
function isBeamerDetail($) {
  // 该站详情页常见信号：有“Artikel-Nr.”、右侧价格框、“In den Warenkorb”按钮等
  const hasLabel = /artikel-?nr/i.test(($("body").text() || "").replace(/\s+/g, " "));
  const hasBuy = $("button, a").filter((_i, el) => /warenkorb|in den warenkorb/i.test(text(cheerio.load(el)("*")))).length > 0;
  return hasLabel || hasBuy;
}
function pickFirstImgAbs($root, base) {
  const $img = $root.find("img").first();
  const src = $img.attr("data-src") || $img.attr("data-original") ||
              ($img.attr("srcset") || "").split(/\s+/).find(s=>/^https?:/i.test(s)) ||
              $img.attr("src") || "";
  return abs(base, (src||"").split("?")[0]);
}
function pickPrice($) {
  return normalizePrice(
    text($(".price, .price--content, .product-price, .buybox__price, [itemprop='price']").first()) ||
    priceFromJsonLd($) || ""
  );
}
function pickSkuFromDetail($) {
  let sku = "";
  // 1) 显式标签
  $("*, dt, th, b, strong").each((_i, el) => {
    const t = text($(el));
    if (/^artikel-?nr\.?$/i.test(t)) {
      const val = text($(el).next()) || text($(el).parent()).replace(t, "").replace(/[:：]/, "").trim();
      if (val) { sku = val; return false; }
    }
  });
  // 2) 散文文本
  if (!sku) {
    const m = ($("body").text() || "").match(/Artikel-?Nr\.?\s*[:：]?\s*([0-9A-Za-z\-_.\/]+)/i);
    if (m) sku = m[1];
  }
  return sku;
}
async function parseBeamerSingle(detailUrl) {
  const html = await fetchHtml(detailUrl);
  const $ = cheerio.load(html, { decodeEntities: false });
  const title =
    text($("h1.product--title, h1.product-title, h1, .product--title").first()) ||
    ($("title").text() || "").trim();
  const sku = pickSkuFromDetail($) || guessSkuFromTitle(title);
  const price = pickPrice($) || "";
  const img = pickFirstImgAbs($, detailUrl);
  return [{
    sku, title, url: detailUrl, img, price: price || null, currency: "", moq: "",
  }];
}
async function parseBeamerDetail(items, { max = 30 } = {}) {
  const N = Math.min(items.length, max);
  const pool = 8;
  let i = 0;
  async function worker() {
    while (i < N) {
      const idx = i++;
      const it = items[idx];
      try {
        const html = await fetchHtml(it.url);
        const $ = cheerio.load(html, { decodeEntities: false });
        // 仅覆写 SKU + 尝试补价格与主图
        const sku = pickSkuFromDetail($);
        if (sku) it.sku = sku;
        const p = pickPrice($); if (p) it.price = p;
        if (!it.img) it.img = pickFirstImgAbs($, it.url);
      } catch {}
    }
  }
  await Promise.all(Array.from({ length: Math.min(pool, N) }, worker));
}

/* ──────────────────────────── S-Impuls & Auto-Schmuck（保留原实现） ──────────────────────────── */
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
      let $a = $card.find("a[href]").filter((_, a) => !/anzeigen|anmelden|login|cart|filter/i.test(text($(a)))).first();
      if (!$a.length) return;
      const href = abs(listUrl, $a.attr("href") || "");
      if (!href || seen.has(href)) return;
      const title =
        ($a.attr("title") || "").trim() ||
        text($card.find("h3,h2").first()) ||
        text($a) ||
        ($img.attr("alt") || "").trim();
      if (!title) return;
      const srcFromSet = ($img.attr("srcset") || "").split(/\s+/).find((s) => /^https?:/i.test(s));
      const src =
        $img.attr("data-src") || $img.attr("data-original") || srcFromSet || $img.attr("src") || "";
      const img = abs(listUrl, (src || "").split("?")[0]);
      let priceTxt = text($card.find(".price,.product-price,.price-tag,.artbox-price,.product-list-price,.amount").first());
      if (!priceTxt) {
        const m = $card.text().match(/\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})\s*(?:€|EUR)/i);
        if (m) priceTxt = m[0].replace(/\s+/g, " ");
      }
      items.push({
        sku: guessSkuFromTitle(title), title, url: href, img, price: priceTxt || null, currency: "", moq: "",
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
    let $img = $card.find(".image img").first().length ? $card.find(".image img").first() : $card.find("img").first();
    let src =
      $img.attr("data-src") || $img.attr("data-original") ||
      ($img.attr("srcset") || "").split(" ").find((s) => /^https?:/i.test(s)) ||
      $img.attr("src") || "";
    return abs(listUrl, (src || "").split("?")[0]);
  }
  function pushItem(aEl) {
    if (items.length >= limit) return;
    const $a = $(aEl);
    const href = $a.attr("href") || "";
    if (!href || !/\/product\//.test(href)) return;
    const title = ($a.attr("title") || "").trim() || text($a);
    let $card = $a.closest("div"); if ($card.length === 0) $card = $a.parent();
    const img = pickImg($card);
    const priceTxt = text($card.find(".price, .product-price, .amount, .m-price").first()) || "";
    const skuTxt = text($card.find(".product-model, .model, .sku").first()) || guessSkuFromTitle(title);
    items.push({ sku: skuTxt, title, url: abs(listUrl, href), img, price: priceTxt || null, currency: "", moq: "" });
  }
  if (cardRoots.length) cardRoots.find('a[href*="/product/"]').each((_i, a) => pushItem(a));
  if (items.length === 0) {
    for (const c of candidates) {
      const $cards = $(c.item); if ($cards.length === 0) continue;
      $cards.each((_i, el) => $(el).find('a[href*="/product/"]').each((_j, a) => pushItem(a)));
      if (items.length > 0) break;
    }
  }
  return items;
}

/* ──────────────────────────── 统一入口 ──────────────────────────── */
async function parseUniversalCatalog(
  listUrl,
  limit = 50,
  { debug = false, fast = false, detailSku = false, detailSkuMax = 30 } = {}
) {
  let adapter = "generic";
  try {
    const host = new URL(listUrl).hostname;

    // ✅ memoryking.de → 专用适配器（保持）
    if (host.includes("memoryking.de")) {
      adapter = "memoryking/v5.1";
      const html = await fetchHtml(listUrl);
      const $ = cheerio.load(html, { decodeEntities: false });
      const items = await parseMemoryking({ $, url: listUrl, rawHtml: html, limit, debug });
      return { items, adapter };
    }

    // ✅ example newsite（保持）
    if (/(\.|^)newsite\.de$/i.test(host)) {
      adapter = "exampleSite";
      const html = await fetchHtml(listUrl);
      const $ = cheerio.load(html, { decodeEntities: false });
      const parseExample = (await import("./adapters/exampleSite.js")).default;
      const items = await parseExample({ $, url: listUrl, rawHtml: html, limit, debug });
      return { items, adapter };
    }

    // ✅ akkuman.de → 模板适配器；默认 fast（不进详情）；只有 detailSku=1 才覆写
    if (/(\.|^)akkuman\.de$/i.test(host)) {
      adapter = "exampleSite";
      const html = await fetchHtml(listUrl);
      const $ = cheerio.load(html, { decodeEntities: false });
      const parseExample = (await import("./adapters/exampleSite.js")).default;
      const wantsDetail = !!detailSku;
      const fastEffective = !wantsDetail; // 没开 detailSku 就 fast
      const items = await parseExample({ $, url: listUrl, rawHtml: html, limit, debug, fast: fastEffective });
      return { items, adapter };
    }

    // ✅ beamer-discount.de → 新增：详情页单品模式 + 目录 + 可选 detailSku 覆写
    if (host.includes("beamer-discount.de")) {
      adapter = "beamer-discount";
      const html = await fetchHtml(listUrl);
      const $ = cheerio.load(html, { decodeEntities: false });

      // 如果用户直接给的是“商品详情页”，仅返回该商品
      if (isBeamerDetail($)) {
        const single = await parseBeamerSingle(listUrl);
        return { items: single.slice(0, limit), adapter };
      }

      // 否则按目录页解析
      let items = parseByCardSelectors($, listUrl, limit);
      if (detailSku && items.length) {
        // 先跑通用覆写，再跑 Beamer 定制覆写（更稳定）
        await overwriteSkuFromDetailGeneric(items, Math.min(detailSkuMax || 30, limit));
        await parseBeamerDetail(items, { max: Math.min(detailSkuMax || 30, limit) });
        return { items, adapter: adapter + "+detailSku" };
      }
      return { items, adapter };
    }

    // ✅ sinotronic-e.com（保留原自动翻页实现）
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
          out.push(it); add++;
          if (out.length >= limit) break;
        }
        if (!add) break;
      }
      return { items: out, adapter };
    }

    // ✅ s-impuls-shop.de（保留）
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
          let n = parseInt(
            u.searchParams.get("page") || u.searchParams.get("p") || u.searchParams.get("seite") || "", 10
          ) || 0;
          if (!n) {
            const m = u.pathname.match(/\/page\/(\d+)/i);
            if (m) n = parseInt(m[1], 10) || 0;
          }
          if (n && n > 1 && !pageSet.has(n)) pageSet.set(n, u.href);
        } catch {}
      };
      $(".pagination a[href], nav.pagination a[href], .pager a[href], .page-pagination a[href], .page-numbers a[href]")
        .each((_i, a) => addPage($(a).attr("href")));

      const makeCandidates = (base, n) => {
        const u = new URL(base);
        const sep = u.search ? "&" : "?";
        return [
          `${u.origin}${u.pathname}${u.search}${sep}page=${n}${u.hash}`,
          `${u.origin}${u.pathname}${u.search}${sep}p=${n}${u.hash}`,
          `${u.origin}${u.pathname.replace(/\/$/, "")}/page/${n}${u.search}${u.hash}`,
        ];
      };
      const firstKey = (items) => (items?.[0]?.link || items?.[0]?.url || items?.[0]?.href || "").trim();

      if (pageSet.size === 0) {
        let n = 2;
        let lastFirst = firstKey(out);
        while (n <= maxPages && out.length < limit) {
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

      const pages = [...pageSet.entries()].sort((a, b) => a[0] - b[0]).map(([, href]) => href).slice(0, maxPages - 1);
      for (const pageUrl of pages) {
        if (out.length >= limit) break;
        if (visited.has(pageUrl)) continue;
        $ = await harvest(pageUrl);
      }
      return { items: out, adapter };
    }

    if (host.includes("auto-schmuck.com")) {
      adapter = "auto-schmuck";
      const items = await parseAutoSchmuck(listUrl, limit);
      return { items, adapter };
    }
  } catch {}

  // 外部通用适配器（保留）
  try {
    const uni = await parseUniversal({ url: listUrl, limit });
    if (Array.isArray(uni) && uni.length) return { items: uni, adapter: "universal-ext" };
  } catch {}

  // 内置多级回退（保留）
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
  return { items: parseGenericFromHtml($, listUrl, limit), adapter: "generic-links" };
}

// 最后一级超兜底：仅链接解析（保持原风格）
function parseGenericFromHtml($, listUrl, limit = 50) {
  const items = [];
  $("a[href]").each((_i, a) => {
    if (items.length >= limit) return false;
    const href = abs(listUrl, String($(a).attr("href") || ""));
    const title = text($(a));
    if (!href || !title) return;
    items.push({ sku: guessSkuFromTitle(title), title, url: href, img: "", price: null, currency: "", moq: "" });
  });
  return items;
}

/* ──────────────────────────── API: 解析 ──────────────────────────── */
app.get("/v1/api/catalog/parse", async (req, res) => {
  const listUrl = String(req.query.url ?? req.query.u ?? req.query.link ?? req.query.l ?? "").trim();
  const limit = Math.max(1, Math.min(parseInt(String(req.query.limit || "50"), 10) || 50, 200));

  const enrich = String(req.query.enrich || "").toLowerCase() === "true";
  const enrichCount = Math.min(parseInt(String(req.query.enrichCount || "20"), 10) || 20, limit);

  const wantImgBase64 = String(req.query.img || "") === "base64";
  const imgCount = Math.min(parseInt(String(req.query.imgCount || "0"), 10) || 0, limit);

  const targetLang = String(req.query.translate || req.query.t || "").trim().toUpperCase();
  const translateFields = String(req.query.translateFields || "title,desc,description")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const translateCount = Math.min(parseInt(String(req.query.translateCount || String(limit)), 10) || limit, limit);

  // ✅ 新增：debug / fast / detailSku 透传（支持 &detailSku=1）
  const debug = /^(1|true|yes|on)$/i.test(String(req.query.debug || ""));
  const fast  = /^(1|true|yes|on)$/i.test(String(req.query.fast || ""));
  const detailSku = /^(1|true|yes|on)$/i.test(String(req.query.detailSku || ""));
  const detailSkuMax = Math.min(parseInt(String(req.query.detailSkuMax || "30"), 10) || 30, limit);

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
              responseType: "arraybuffer", timeout: 15000,
              headers: { "User-Agent": UA, Accept: "image/avif,image/webp,image/*,*/*;q=0.8", Referer: new URL(it.img).origin + "/" },
              validateStatus: (s) => s >= 200 && s < 400,
            });
            const ct = r.headers["content-type"] || "image/jpeg";
            it.img_b64 = `data:${ct};base64,${Buffer.from(r.data).toString("base64")}`;
          } catch {}
        })
      );
    }

    // ✅ 可选翻译（保留）
    if (items.length && targetLang) {
      const suffix = "_" + targetLang.toLowerCase();
      const translateOne = async (text) => {
        try {
          if (!text) return text;
          if (typeof translate.translateText === "function") return await translate.translateText(text, targetLang);
          if (typeof translate.translateBatch === "function") {
            const out = await translate.translateBatch([text], targetLang);
            return Array.isArray(out) ? out[0] : text;
          }
          if (typeof translate.default === "function") return await translate.default(text, targetLang);
          if (typeof translate.translate === "function") return await translate.translate(text, targetLang);
        } catch (e) { console.warn("[translate:one] fail:", e?.message || e); }
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
          } catch (e) { console.warn(`[translate:field] ${key} fail:`, e?.message || e); }
        }
      }
    }

    res.setHeader("X-Lang", "de");
    res.setHeader("X-Adapter", adapter || "unknown");
    res.json({ ok: true, url: listUrl, count: items.length, adapter, products: items, items });

    console.log("[parse:done]", {
      url: listUrl, adapter, count: items.length, ms: Date.now() - t0,
      enrich, enrichCount, wantImgBase64, imgCount,
      targetLang, translateFields, translateCount,
      debug, fast, detailSku, detailSkuMax,
    });
  } catch (err) {
    console.error("[parse:fail]", { url: listUrl, ms: Date.now() - t0, err: String(err?.message || err) });
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// 兼容别名（保留）
app.get("/v1/api/parse", (req, res) =>
  app._router.handle(
    { ...req, url: "/v1/api/catalog/parse" + (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "") },
    res, () => {}
  )
);
// 兼容老路径（保留）
app.get(["/v1/api/catalog", "/v1/api/catalog.json", "/v1/api/catalog/parse.json"], (req, res) =>
  app._router.handle(
    { ...req, url: "/v1/api/catalog/parse" + (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "") },
    res, () => {}
  )
);

/* ──────────────────────────── listen ──────────────────────────── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[mvp2-backend] listening on :${PORT}`));
