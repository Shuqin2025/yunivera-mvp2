// backend/routes/catalog.js
// 统一的目录抓取入口 + 针对 s-impuls-shop 的专用解析
import express from "express";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { URL } from "url";

const router = express.Router();

function absUrl(base, href) {
  if (!href) return "";
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

function parsePriceText(txt = "") {
  // 例： "€ 19,90", "19,90 €", "EUR 19.90"
  const t = txt.replace(/\s+/g, " ").trim();
  const currency =
    (t.match(/(€|eur|usd|chf|gbp)/i) || [])[1]?.toUpperCase().replace("€", "EUR") ||
    null;
  const num = t
    .replace(/[^\d.,-]/g, "")
    .replace(/\.(?=\d{3}\b)/g, "") // 去掉千分位点
    .replace(",", "."); // 德语小数逗号 -> 点
  const price = num && !isNaN(Number(num)) ? Number(num) : null;
  return { price, currency };
}

/** 仅解析页面中真正的商品卡片（s-impuls-shop 专用） */
function parseSImpulsCatalog(html, pageUrl) {
  const $ = cheerio.load(html);

  // 1) 在主体内容区内查找商品卡片（多套选择器兜底）
  const candidates = $(
    "#content .product-layout, #content .product-grid .product-thumb, .product-layout, .product-thumb"
  );

  const products = [];
  const seen = new Set();

  candidates.each((_, card) => {
    const $card = $(card);

    // a) 链接：优先 h4/name 区域的 a；接受含 product/product、product_id、/produkt/、/product/、/artikel/ 的链接
    let linkEl =
      $card.find("h4 a, .caption .name a, .product-name a").first()[0] ||
      $card.find('a[href*="product_id="]').first()[0] ||
      $card.find('a[href*="/produkt/"], a[href*="/product/"], a[href*="/artikel/"]').first()[0];

    let url = linkEl ? $(linkEl).attr("href") : "";
    url = absUrl(pageUrl, url);

    // 过滤掉分类/筛选链接（index.php?path=...）
    if (!url || /index\.php\?path=/i.test(url)) return;

    // 去重
    const dedupKey = url.split("?")[0];
    if (seen.has(dedupKey)) return;
    seen.add(dedupKey);

    // b) 标题
    const title =
      ($(linkEl).text() || "")
        .replace(/\s+/g, " ")
        .trim() ||
      $card.find(".caption h4, .product-name").text().trim() ||
      null;

    // c) SKU（型号/货号）
    let sku =
      $card.find(".model, .sku, .artnr, .article, .product-code, .code").first().text().trim() ||
      null;

    // d) 价格/币种
    const priceNode =
      $card.find(".price, .product-price, .price-new, .price-old").first().text().trim() || "";
    const { price, currency } = parsePriceText(priceNode);

    // e) 图片
    const img =
      $card.find("img").attr("data-src") ||
      $card.find("img").attr("src") ||
      null;

    // f) 预览（截取一段描述文本）
    const preview =
      $card.find(".description, .desc, .caption p").first().text().replace(/\s+/g, " ").trim() ||
      null;

    products.push({
      title,
      url,
      sku,
      price,
      currency,
      img,
      preview,
    });
  });

  return {
    ok: true,
    source: pageUrl,
    count: products.length,
    products,
  };
}

/** 通用解析：尽量从常见电商模板里提取商品卡片 */
function parseGenericCatalog(html, pageUrl) {
  const $ = cheerio.load(html);
  const products = [];
  const seen = new Set();

  const cards = $(
    ".product, .product-card, .product-item, .product-tile, .product-thumb, .grid-item, .prod, li.product"
  );

  cards.each((_, card) => {
    const $c = $(card);

    let a =
      $c.find("h3 a, h4 a, .title a, .name a, .product-title a").first()[0] ||
      $c.find("a").first()[0];

    let url = a ? $(a).attr("href") : "";
    url = absUrl(pageUrl, url);
    if (!url) return;
    if (seen.has(url)) return;
    seen.add(url);

    const title =
      ($(a).text() || "").replace(/\s+/g, " ").trim() ||
      $c.find(".title, .name, .product-title").first().text().trim() ||
      null;

    const sku =
      $c.find(".sku, .model, .code, .product-code").first().text().trim() || null;

    const priceTxt =
      $c.find(".price, .product-price, .price-new, .price-old").first().text().trim() || "";
    const { price, currency } = parsePriceText(priceTxt);

    const img = $c.find("img").attr("data-src") || $c.find("img").attr("src") || null;

    const preview =
      $c.find(".description, .desc, p").first().text().replace(/\s+/g, " ").trim() || null;

    products.push({ title, url, sku, price, currency, img, preview });
  });

  return { ok: true, source: pageUrl, count: products.length, products };
}

router.get("/v1/api/catalog/parse", async (req, res) => {
  const pageUrl = req.query.url?.toString().trim();
  if (!pageUrl) return res.status(400).json({ ok: false, error: "Missing url" });

  try {
    const r = await fetch(pageUrl, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
      },
      timeout: 20000,
    });

    if (!r.ok) {
      return res
        .status(502)
        .json({ ok: false, error: `Upstream ${r.status} ${r.statusText}` });
    }

    const html = await r.text();
    const host = new URL(pageUrl).hostname;

    let result;
    if (/s-impuls-shop\.de$/i.test(host)) {
      result = parseSImpulsCatalog(html, pageUrl);
    } else {
      result = parseGenericCatalog(html, pageUrl);
    }

    return res.json(result);
  } catch (err) {
    console.error("[catalog.parse] error:", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

export default router;
