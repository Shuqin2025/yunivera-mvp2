import express from "express";
import cors from "cors";
import axios from "axios";
import * as cheerio from "cheerio";

const app = express();
app.use(cors({ origin: "*", exposedHeaders: ["X-Lang"] }));

app.get(["/", "/healthz", "/health", "/api/health"], (_req, res) =>
  res.type("text/plain").send("ok")
);

app.get("/v1/api/__version", (_req, res) => {
  res.json({
    version: "mvp-universal-parse-2025-09-15-auto-schmuck",
    note: "Add auto-schmuck.com parser; harden generic parser; limit up to 200; JSON-LD price enrich.",
  });
});

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

// ---------- 图片代理 ----------
app.get("/v1/api/image", async (req, res) => {
  const url = String(req.query.url || "").trim();
  if (!url) return res.status(400).send("missing url");
  try {
    const r = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 20000,
      headers: {
        "User-Agent": UA,
        Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
        Referer: url,
      },
      validateStatus: (s) => s >= 200 && s < 400,
    });
    res.set("Content-Type", r.headers["content-type"] || "image/jpeg");
    res.set("Cache-Control", "public, max-age=604800");
    res.send(r.data);
  } catch (e) {
    console.error("[image] fail:", e?.message || e);
    res.status(502).send("image fetch failed");
  }
});

/* =========================
 *  站点专用解析：auto-schmuck.com
 *  ========================= */
async function parseAutoSchmuck(listUrl, limit = 50) {
  const html = await fetchHtml(listUrl);
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  // 1) 优先：卡片上的 “ANZEIGEN” 按钮
  $('a').filter((_, a) => /anzeigen/i.test(text($(a)))).each((_, a) => {
    if (items.length >= limit) return false;
    const $a = $(a);
    let href = $a.attr("href") || "";
    href = abs(listUrl, href);
    if (!href || seen.has(href)) return;

    // 找到包含图片/价格的父卡片
    let $card = $a.closest("div");
    let hop = 0;
    while (hop < 6 && $card.length && !$card.find("img").length) {
      $card = $card.parent();
      hop++;
    }
    if (!$card.length) $card = $a.parent();

    // 图片
    const $img = $card.find("img").first();
    const src =
      $img.attr("data-src") ||
      $img.attr("data-original") ||
      ($img.attr("srcset") || "").split(" ").find((s) => /^https?:/i.test(s)) ||
      $img.attr("src") ||
      "";
    const img = abs(listUrl, (src || "").split("?")[0]);

    // 标题（优先不是按钮本身的 a / 再找 h3/h2）
    const $titleA = $card
      .find('a[href]')
      .filter((_, el) => el !== a && !/anzeigen/i.test(text($(el))))
      .first();
    const title =
      ($titleA.attr("title") || "").trim() ||
      text($titleA) ||
      text($card.find("h3,h2").first()) ||
      text($a); // 兜底

    // 价格（类名或全文匹配）
    let priceTxt =
      text($card.find(".price,.product-price,.price-tag,.artbox-price,.product-list-price").first());
    if (!priceTxt) {
      const m = $card.text().match(/\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})\s*(?:€|EUR)/i);
      if (m) priceTxt = m[0].replace(/\s+/g, " ");
    }

    if (!title || !href) return;
    items.push({
      sku: guessSkuFromTitle(title),
      title,
      url: href,
      img,
      price: priceTxt || null,
      currency: "",
      moq: "",
    });
    seen.add(href);
  });

  // 2) 兜底：扫描含价格样式的块，必须含 img + a[href]
  if (items.length === 0) {
    $("div,li,article").each((_, el) => {
      if (items.length >= limit) return false;
      const $card = $(el);
      const textAll = $card.text();
      if (!/\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})\s*(?:€|EUR)/i.test(textAll)) return;
      if (!$card.find("img").length || !$card.find("a[href]").length) return;

      const $alink = $card
        .find("a[href]")
        .filter((_, al) => {
          const href = $(al).attr("href") || "";
          return !/(anmelden|login|filter|warenkorb|cart)/i.test(href);
        })
        .first();
      const href = abs(listUrl, $alink.attr("href") || "");
      if (!href || seen.has(href)) return;

      const $img = $card.find("img").first();
      const src =
        $img.attr("data-src") ||
        $img.attr("data-original") ||
        ($img.attr("srcset") || "").split(" ").find((s) => /^https?:/i.test(s)) ||
        $img.attr("src") ||
        "";
      const img = abs(listUrl, (src || "").split("?")[0]);

      const title =
        ($alink.attr("title") || "").trim() ||
        text($card.find("h3,h2,a").first());

      const m = textAll.match(/\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})\s*(?:€|EUR)/i);
      const priceTxt = m ? m[0].replace(/\s+/g, " ") : "";

      if (title && href) {
        items.push({
          sku: guessSkuFromTitle(title),
          title,
          url: href,
          img,
          price: priceTxt || null,
          currency: "",
          moq: "",
        });
        seen.add(href);
      }
    });
  }

  return items.slice(0, limit);
}

/* =========================
 *  S-Impuls（保留）
 *  ========================= */
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
    if (!href || !href.includes("/product/")) return;

    const title = ($a.attr("title") || "").trim() || text($a);
    let $card = $a.closest("div"); if ($card.length === 0) $card = $a.parent();
    const img = pickImg($card);
    const priceTxt =
      text($card.find(".price, .product-price, .amount, .m-price").first()) || "";
    const skuTxt =
      text($card.find(".product-model, .model, .sku").first()) || guessSkuFromTitle(title);

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
      const $cards = $(c.item); if ($cards.length === 0) continue;
      $cards.each((_i, el) => $(el).find('a[href*="/product/"]').each((_j, a) => pushItem(a)));
      if (items.length > 0) break;
    }
  }
  return items;
}

/* =========================
 *  WooCommerce（保留）
 *  ========================= */
function parseWooFromHtml($, listUrl, limit = 50) {
  const items = [];
  const $cards = $("ul.products li.product");
  if (!$cards.length) return items;

  $cards.each((_i, li) => {
    if (items.length >= limit) return;

    const $li = $(li);
    const $a =
      $li.find("a.woocommerce-LoopProduct-link").first().length
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
      text($li.find(".price .amount").first()) ||
      text($li.find(".price").first()) ||
      "";

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

/* =========================
 *  通用回退：强化过滤，避免抓到币种/筛选项
 *  ========================= */
function parseGenericFromHtml($, listUrl, limit = 50) {
  const items = [];
  const seen = new Set();

  const stopWord = /^(EUR|USD|GBP|CHF|CNY|HKD|JPY|AUD|CAD)$/i;

  const anchors = $("a[href]").toArray().filter((a) => {
    const $a = $(a);
    const t = text($a);
    if (!t || t.length <= 2 || stopWord.test(t)) return false;
    const href = $a.attr("href") || "";
    try {
      const u = new URL(href, listUrl);
      const p = (u.pathname || "").toLowerCase();
      // 允许更宽泛的详情路由，同时排除明显的过滤/登录/购物车
      const isDetail = /(product|produkt|artikel|item|sku|detail|details|view)/.test(p);
      const isBad = /\.(jpg|jpeg|png|webp|gif|svg)$/i.test(p) ||
                    /(add-to-cart|cart|login|wishlist|compare|filter)/i.test(u.search + p);
      return isDetail && !isBad;
    } catch { return false; }
  });

  for (const a of anchors) {
    if (items.length >= limit) break;
    const $a = $(a);
    let href = $a.attr("href") || "";
    try { href = new URL(href, listUrl).href; } catch { continue; }
    if (seen.has(href)) continue;

    let $card = $a.closest("li,article,div"); if (!$card.length) $card = $a.parent();

    // 必须有图片 or 价格特征，避免误收导航/筛选
    const txtAll = $card.text();
    const hasPrice = /\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})\s*(?:€|EUR)/i.test(txtAll);
    const hasImg = $card.find("img").length > 0;
    if (!hasImg && !hasPrice) continue;

    const $img = $card.find("img").first();
    let src =
      $img.attr("data-src") ||
      $img.attr("data-original") ||
      ($img.attr("srcset") || "").split(" ").find((s) => /^https?:/i.test(s)) ||
      $img.attr("src") || "";
    const img = abs(listUrl, (src || "").split("?")[0]);

    const title = ($a.attr("title") || "").trim() || text($card.find("h3,h2,a").first()) || text($a);
    const priceTxt =
      text($card.find(".price,.product-price,.amount,.money,.price--default").first()) ||
      (txtAll.match(/\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})\s*(?:€|EUR)/i)?.[0] || "");

    if (!title) continue;

    items.push({
      sku: guessSkuFromTitle(title),
      title,
      url: href,
      img,
      price: priceTxt || null,
      currency: "",
      moq: "",
    });
    seen.add(href);
  }

  return items;
}

/* =========================
 *  价格标准化 + JSON-LD
 *  ========================= */
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

    const moqSel = ".moq, .min-order, .minimum, .minbestellmenge, .minimum-order, .minimum__value";
    const moqText = text($(moqSel).first());

    if (priceText) item.price = priceText;
    if (moqText) item.moq = moqText;
  } catch {}
}

/* =========================
 *  统一入口
 *  ========================= */
async function parseUniversalCatalog(listUrl, limit = 50) {
  try {
    const host = new URL(listUrl).hostname;

    if (host.includes("s-impuls-shop.de")) {
      return await parseSImpulsCatalog(listUrl, limit);
    }
    if (host.includes("auto-schmuck.com")) {
      return await parseAutoSchmuck(listUrl, limit);
    }
  } catch {}

  const html = await fetchHtml(listUrl);
  const $ = cheerio.load(html);

  // WooCommerce
  const wcCards = $("ul.products li.product");
  if (wcCards.length) return parseWooFromHtml($, listUrl, limit);

  // 通用回退
  return parseGenericFromHtml($, listUrl, limit);
}

app.get("/v1/api/catalog/parse", async (req, res) => {
  const listUrl = String(req.query.url || "").trim();
  const limit = Math.max(1, Math.min(parseInt(String(req.query.limit || "50"), 10) || 50, 200));
  const enrich = String(req.query.enrich || "").toLowerCase() === "true";
  const enrichCount = Math.min(
    parseInt(String(req.query.enrichCount || "20"), 10) || 20,
    limit
  );

  if (!listUrl) return res.status(400).json({ ok: false, error: "missing url" });

  const t0 = Date.now();
  try {
    const items = await parseUniversalCatalog(listUrl, limit);
    if (enrich && items.length) {
      await Promise.all(items.slice(0, enrichCount).map(enrichDetail));
    }
    res.setHeader("X-Lang", "de");
    res.json({ ok: true, url: listUrl, count: items.length, products: items, items });
    console.log("[parse:done]", { url: listUrl, count: items.length, ms: Date.now() - t0, enrich, enrichCount });
  } catch (err) {
    console.error("[parse:fail]", { url: listUrl, ms: Date.now() - t0, err: String(err?.message || err) });
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[mvp2-backend] listening on :${PORT}`));
