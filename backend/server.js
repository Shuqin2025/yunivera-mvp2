// backend/server.js
import express from "express";
import cors from "cors";
import axios from "axios";
import * as cheerio from "cheerio";

const app = express();

// CORS：允许前端预览页直连
app.use(cors({ origin: "*", exposedHeaders: ["X-Lang"] }));

// 健康检查
app.get(["/", "/healthz"], (_req, res) => {
  res.type("text/plain").send("ok");
});

// 版本确认
app.get("/v1/api/__version", (_req, res) => {
  res.json({
    version: "restore-mvp-2025-09-13-optim",
    note: "S-Impuls selectors + enrich(price/moq) + image proxy + ok/products compatibility + logging",
  });
});

// ---------- 工具 ----------
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

// ---------- 图片代理（Excel 内嵌图依赖此接口） ----------
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
    const ctype = r.headers["content-type"] || "image/jpeg";
    res.set("Content-Type", ctype);
    res.set("Cache-Control", "public, max-age=604800"); // 7 天
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

  // 首选结构：#nx_content .listproduct-wrapper .listproduct
  let cardRoots = $("#nx_content .listproduct-wrapper .listproduct");
  const candidates = [
    { item: ".listproduct .product, .listproduct > div" },
    { item: "div.product-layout, div.product-thumb, div.product-grid .product-layout" },
    { item: ".row .product-layout, .row .product-thumb" },
  ];

  const items = [];

  function pushItem(aEl) {
    if (items.length >= limit) return;
    const $a = $(aEl);
    const href = $a.attr("href") || "";
    if (!href || !href.includes("/product/")) return;

    const title = ($a.attr("title") || "").trim() || text($a);

    let $card = $a.closest("div");
    if ($card.length === 0) $card = $a.parent();

    const $img =
      $card.find(".image img").first().length
        ? $card.find(".image img").first()
        : $card.find("img").first();

    const imgSrc =
      $img.attr("data-src") || $img.attr("data-original") || $img.attr("src") || "";
    const img = abs(listUrl, (imgSrc || "").split("?")[0]);

    const priceTxt =
      text($card.find(".price, .product-price, .amount, .m-price").first()) || "";

    const skuTxt =
      text($card.find(".product-model, .model, .sku").first()) || guessSkuFromTitle(title);

    if (title && href) {
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
  }

  if (cardRoots.length) {
    cardRoots.find('a[href*="/product/"]').each((_i, a) => pushItem(a));
  }
  if (items.length === 0) {
    for (const c of candidates) {
      const $cards = $(c.item);
      if ($cards.length === 0) continue;
      $cards.each((_i, el) => {
        $(el)
          .find('a[href*="/product/"]')
          .each((_j, a) => pushItem(a));
      });
      if (items.length > 0) break;
    }
  }

  return items;
}

// ---------- 详情页富化（价格/MOQ） ----------
async function enrichDetail(item) {
  try {
    const html = await fetchHtml(item.url);
    const $ = cheerio.load(html);

    // 价格：尽量覆盖多种写法
    const priceSel = ".price, .product-price, [itemprop='price'], .price-value, .price .amount";
    const moqSel =
      ".moq, .min-order, .minimum, .minbestellmenge, .minimum-order, .minimum__value";

    const priceText = text($(priceSel).first());
    const moqText = text($(moqSel).first());

    if (priceText) item.price = priceText;
    if (moqText) item.moq = moqText;

    // 有些站把 MOQ 写在参数表里，做个兜底
    if (!item.moq) {
      const tableText = text($("table").first());
      const m =
        tableText.match(/MOQ[:：]?\s*([0-9]+[^\s]+)/i) ||
        tableText.match(/Min(?:imum)?\s*Order[:：]?\s*([0-9]+[^\s]+)/i) ||
        tableText.match(/Mindestbestellmenge[:：]?\s*([0-9]+[^\s]+)/i);
      if (m) item.moq = m[1];
    }
  } catch (e) {
    // 静默失败，继续其它条
  }
}

// ---------- 解析总路由 ----------
app.get("/v1/api/catalog/parse", async (req, res) => {
  const listUrl = String(req.query.url || "").trim();
  const limit = Math.max(1, Math.min(parseInt(String(req.query.limit || "50"), 10) || 50, 200));
  const enrich = String(req.query.enrich || "").toLowerCase() === "true";

  if (!listUrl) {
    return res.status(400).json({ ok: false, error: "missing url" });
  }

  const t0 = Date.now();
  try {
    const u = new URL(listUrl);
    console.log("[parse:start]", { url: listUrl, limit, enrich });

    let items = [];
    if (u.hostname.includes("s-impuls-shop.de")) {
      items = await parseSImpulsCatalog(listUrl, limit);
    } else {
      // 其它站点：可在这里增加分支；默认返回空结构
      items = [];
    }
