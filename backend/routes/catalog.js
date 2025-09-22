// backend/routes/catalog.js
// 统一支持 GET/POST  /v1/api/catalog/parse
// - 自动选择站点适配器（例如 sinotronic）
// - 通用解析（s-impuls / OpenCart 风格）兜底
// - 返回 { ok, source, count, items: [...] }

import { Router } from "express";
import * as cheerio from "cheerio";

// 站点适配器（按需添加）
import parseSinotronic from "../adapters/sinotronic.js";

const router = Router();

// 更像浏览器的请求头（不少站点需要这个才会返回完整 HTML）
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

// ───────────────────── 适配器选择 ─────────────────────
function pickAdapterByUrl(url) {
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();

  if (/sinotronic/i.test(host)) {
    // 适配 sinotronic-e.com、sinotronic.de 等
    return async ($, pageUrl, { limit = 50 } = {}) => {
      // 约定：适配器返回 items: [{sku,title,url,img,price,moq}]
      const items = await parseSinotronic($, pageUrl, limit);
      return items;
    };
  }

  // 返回 undefined 走通用解析
  return undefined;
}

// ───────────────────── 通用解析（s-impuls 等） ─────────────────────
function extractCommonProducts($, pageUrl) {
  // 常见承载容器（多备选，兼容 OpenCart/OC 洋葱结构）
  let cards = $(
    "div.product-layout, div.product-grid .product-thumb, div.product-thumb, .product-list .product-layout"
  );
  if (cards.length === 0) {
    // 兜底：如果外层没命中，再尝试商品卡片内部 class
    cards = $("div[class*='product']:has(a, img)");
  }

  const out = [];
  cards.each((_, el) => {
    const root = $(el);

    const title =
      root.find(".caption a, .name a, .product-name a, a[title]").first().text().trim() ||
      root.find("img[alt]").attr("alt") ||
      root.find("a").first().text().trim() ||
      "";

    const href =
      root
        .find(".caption a, .name a, .product-name a, a[href*='product_id'], a[href]")
        .first()
        .attr("href") || "";

    const priceTxt =
      root.find(".price-new, .price .price-new, .price").first().text().replace(/\s+/g, " ").trim() ||
      "";

    const img =
      root.find("img[data-src]").attr("data-src") ||
      root.find("img[src]").attr("src") ||
      "";

    if (title || href) {
      out.push({
        sku: "",
        title,
        url: abs(pageUrl, href),
        img: img ? abs(pageUrl, img) : "",
        price: priceTxt || "",
        moq: "",
      });
    }
  });

  // 去重（按 url 或 title）
  const seen = new Set();
  const unique = [];
  for (const p of out) {
    const key = p.url || p.title;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
  }
  return unique;
}

// ───────────────────── 主处理 ─────────────────────
async function handleParse(targetUrl, opts = {}) {
  const html = await fetchHtml(targetUrl);
  const $ = cheerio.load(html);

  // 优先用站点适配器
  const adapter = pickAdapterByUrl(targetUrl);
  let items;
  if (typeof adapter === "function") {
    items = await adapter($, targetUrl, opts);
  } else {
    items = extractCommonProducts($, targetUrl);
  }

  // 截断上限
  const limit = Math.max(1, Math.min(Number(opts.limit || 50) || 50, 500));
  if (items.length > limit) items = items.slice(0, limit);

  return {
    ok: true,
    source: targetUrl,
    count: items.length,
    items, // 统一叫 items；前端也兼容 products
    products: items,
  };
}

// 读取参数（GET 的 query 或 POST 的 body）
function readParams(req) {
  const src = req.method === "GET" ? req.query : (req.body || {});
  const url = String((src && src.url) || "").trim();
  const limit = Number(src && src.limit) || 50;
  const img = String((src && src.img) || "").trim(); // 目前不在后端做 base64（前端导出时会用 /image64）
  const imgCount = Number(src && src.imgCount) || limit;
  return { url, limit, img, imgCount };
}

// ───────────────────── 路由 ─────────────────────

// GET  /v1/api/catalog/parse?url=...
router.get("/parse", async (req, res) => {
  const { url, limit, img, imgCount } = readParams(req);
  if (!url) return res.status(400).json({ ok: false, error: "MISSING_URL" });

  try {
    const data = await handleParse(url, { limit, img, imgCount });
    res.json(data);
  } catch (err) {
    console.error("[catalog.parse][GET] error:", err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// POST /v1/api/catalog/parse   body: { url, limit, img, imgCount }
router.post("/parse", async (req, res) => {
  const { url, limit, img, imgCount } = readParams(req);
  if (!url) return res.status(400).json({ ok: false, error: "MISSING_URL" });

  try {
    const data = await handleParse(url, { limit, img, imgCount });
    res.json(data);
  } catch (err) {
    console.error("[catalog.parse][POST] error:", err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

export default router;
