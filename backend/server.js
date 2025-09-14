import express from "express";
import cors from "cors";
import axios from "axios";
import * as cheerio from "cheerio";

const app = express();
app.use(cors({ origin: "*", exposedHeaders: ["X-Lang"] }));

// 健康端点：多路径兼容
app.get(["/", "/healthz", "/health", "/api/health"], (_req, res) =>
  res.type("text/plain").send("ok")
);

app.get("/v1/api/__version", (_req, res) => {
  res.json({
    version: "restore-mvp-2025-09-14-imgprice+ldjson",
    note: "price from JSON-LD + robust selectors; image proxy; S-Impuls parser",
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

// ---------- 图片代理（供 ExcelJS 取图） ----------
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

// ---------- S-Impuls 列表解析 ----------
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
    return abs(listUrl, (src || "").split("?")[0]); // 去掉参数，便于缓存与代理
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

// ---------- 价格标准化 ----------
function normalizePrice(str) {
  if (!str) return "";
  const s = String(str).replace(/\s+/g, " ").trim();
  // 常见：€ 1.234,56 / 1.234,56 € / 12,34
  const m =
    s.match(/€\s*\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})/) ||
    s.match(/\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})\s*€/) ||
    s.match(/\d+[.,]\d{2}/);
  if (!m) return s;
  let v = m[0].replace(/\s+/g, " ");
  if (!/[€]/.test(v)) v = "€ " + v; // 无 € 则补上
  return v;
}

// ---------- 从 JSON-LD 里取价格（优先） ----------
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
        if (!offers) continue;
        offers = Array.isArray(offers) ? offers[0] : offers;
        const p = offers.price ?? offers.lowPrice ?? offers.highPrice;
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

// ---------- 详情页富化（价格 & MOQ） ----------
async function enrichDetail(item) {
  try {
    const html = await fetchHtml(item.url);
    const $ = cheerio.load(html);

    // 1) 先从 JSON-LD 拿
    let priceText = priceFromJsonLd($);

    // 2) JSON-LD 没有再走选择器
    if (!priceText) {
      const priceSel = [
        "meta[itemprop='price']",
        "[itemprop='price']",
        ".woocommerce-Price-amount",
        ".price .amount",
        ".price .value",
        ".product-price",
        ".price-value",
        ".amount",
        ".price" // 兜底
      ].join(", ");
      const $node = $(priceSel).first();
      const raw = ($node.attr("content") || text($node) || "").trim();
      if (raw) priceText = normalizePrice(raw);
    }

    const moqSel = ".moq, .min-order, .minimum, .minbestellmenge, .minimum-order, .minimum__value";
    const moqText = text($(moqSel).first());

    if (priceText) item.price = priceText;
    if (moqText) item.moq = moqText;
  } catch {
    // ignore
  }
}

// ---------- 解析总路由 ----------
app.get("/v1/api/catalog/parse", async (req, res) => {
  const listUrl = String(req.query.url || "").trim();
  const limit = Math.max(1, Math.min(parseInt(String(req.query.limit || "50"), 10) || 50, 200));
  const enrich = String(req.query.enrich || "").toLowerCase() === "true";

  if (!listUrl) return res.status(400).json({ ok: false, error: "missing url" });

  const t0 = Date.now();
  try {
    const u = new URL(listUrl);
    const host = u.hostname;
    console.log("[parse:start]", { host, limit, enrich, url: listUrl });

    let items = [];
    if (host.includes("s-impuls-shop.de")) {
      items = await parseSImpulsCatalog(listUrl, limit);
    } else {
      items = []; // 未来扩展其它站点
    }

    if (enrich && items.length) {
      const N = Math.min(items.length, 20); // 只富化前 N 条，兼顾速度
      await Promise.all(items.slice(0, N).map(enrichDetail));
    }

    const payload = { ok: true, url: listUrl, count: items.length, products: items, items };
    res.setHeader("X-Lang", "de");
    console.log("[parse:done]", { host, count: items.length, ms: Date.now() - t0, enrich });
    res.json(payload);
  } catch (err) {
    console.error("[parse:fail]", { url: listUrl, ms: Date.now() - t0, err: String(err?.message || err) });
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[mvp2-backend] listening on :${PORT}`));
