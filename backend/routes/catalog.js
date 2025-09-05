// backend/routes/catalog.js
// ESM 路由。支持 GET/POST /v1/api/catalog/parse?url=...

import { Router } from "express";
import * as cheerio from "cheerio";

const router = Router();

// 更像浏览器的请求头，很多站需要这个才会返回完整 HTML
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

async function fetchHtml(targetUrl) {
  const res = await fetch(targetUrl, {
    headers: {
      "user-agent": UA,
      "accept-language": "de,en;q=0.8,zh;q=0.7",
      accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} when fetching ${targetUrl}`);
  }
  return await res.text();
}

function abs(origin, href = "") {
  try {
    return new URL(href, origin).href;
  } catch {
    return href || origin;
  }
}

/**
 * 从 s-impuls-shop 的目录页抽取商品
 * 站点模版可能更新，所以选择器做了多备选。
 */
function extractProducts(html, pageUrl) {
  const $ = cheerio.load(html);

  // 常见承载容器（多备选）
  let items = $(
    "div.product-layout, div.product-grid .product-thumb, div.product-thumb, .product-list .product-layout"
  );

  // 兜底：如果外层没命中，再尝试商品卡片内部 class
  if (items.length === 0) {
    items = $("div[class*='product']:has(a, img)");
  }

  const products = [];
  items.each((_, el) => {
    const root = $(el);

    // 名称（多备选）
    const name =
      root.find(".caption a, .name a, .product-name a, a[title]").first().text().trim() ||
      root.find("img[alt]").attr("alt") ||
      root.find("a").first().text().trim();

    // 链接
    const href =
      root.find(".caption a, .name a, .product-name a, a[href*='product_id'], a[href]").first().attr("href") ||
      "";

    // 价格（多备选：price-new / price / .price）
    const priceTxt =
      root.find(".price-new, .price .price-new, .price").first().text().replace(/\s+/g, " ").trim() ||
      "";

    // 图片
    const img =
      root.find("img[data-src]").attr("data-src") ||
      root.find("img[src]").attr("src") ||
      "";

    if (name || href) {
      products.push({
        title: name || "",
        url: abs(pageUrl, href),
        sku: "", // 目录页通常无 SKU，这里留空
        price: priceTxt || null,
        currency: null,
        img: img ? abs(pageUrl, img) : null,
        preview: "",
      });
    }
  });

  // 去重（按 url）
  const seen = new Set();
  const unique = [];
  for (const p of products) {
    const key = p.url || p.title;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
  }

  return unique;
}

async function handleParse(targetUrl) {
  const html = await fetchHtml(targetUrl);
  const products = extractProducts(html, targetUrl);

  return {
    ok: true,
    source: targetUrl,
    count: products.length,
    products,
  };
}

// ---- 路由 ----

// GET /v1/api/catalog/parse?url=...
router.get("/parse", async (req, res) => {
  const url = String(req.query.url || "").trim();
  if (!url) return res.status(400).json({ ok: false, error: "MISSING_URL" });

  try {
    const data = await handleParse(url);
    res.json(data);
  } catch (err) {
    console.error("[catalog.parse][GET] error:", err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// POST /v1/api/catalog/parse  body: { url }
router.post("/parse", async (req, res) => {
  const url = String((req.body && req.body.url) || "").trim();
  if (!url) return res.status(400).json({ ok: false, error: "MISSING_URL" });

  try {
    const data = await handleParse(url);
    res.json(data);
  } catch (err) {
    console.error("[catalog.parse][POST] error:", err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

export default router;
