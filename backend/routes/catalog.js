// backend/routes/catalog.js
import { Router } from "express";
import * as cheerio from "cheerio"; // ✅ cheerio 在 ESM 下无默认导出
import { URL } from "node:url";

/**
 * 统一取 url（支持 GET ?url=... 和 POST { url }）
 */
function pickUrl(req) {
  const u = (req.method === "GET" ? req.query.url : req.body?.url) || "";
  return typeof u === "string" ? u.trim() : "";
}

/**
 * 以较强的容错抓取 HTML（Node 20+ 自带 fetch）
 */
async function fetchHtml(u) {
  const res = await fetch(u, {
    method: "GET",
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,de;q=0.7",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Fetch ${res.status}: ${res.statusText} | ${text.slice(0, 200)}`);
  }
  return await res.text();
}

/**
 * 把相对链接转为绝对链接
 */
function toAbs(href, base) {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

/**
 * 从一块商品卡片节点里提取字段（做了多套 CSS 选择器，尽量稳）
 */
function extractItem($, node, baseUrl) {
  const $node = $(node);

  // 标题
  let title =
    $node.find(".product-title, .product--title, .title, h3, h2, .name").first().text().trim() ||
    $node.find("a[title]").attr("title") ||
    $node.find("a").first().text().trim();

  // 链接
  let href =
    $node.find("a.product-link, a.product--image, a.product--title, a").first().attr("href") || "";
  href = href ? toAbs(href, baseUrl) : "";

  // SKU / 货号（不同站点叫法不同，兜底找看起来像货号的短数字串）
  let sku =
    $node.find(".product-number, .articlenumber, .sku, .product--ordernumber").first().text().trim() ||
    $node.find("*").filter(function () {
      const t = $(this).text().trim();
      // 纯数字/短横线/不含空格的 3-20 位串，常见货号特征
      return /^[A-Za-z0-9\-_.]{3,20}$/.test(t);
    }).first().text().trim() ||
    "";

  // 价格（如果站点未登录可能拿不到，这里有就取）
  let priceText =
    $node.find(".price, .product--price, .price--default, .product-price").first().text().trim() ||
    "";
  // 提取数值和币种
  let currency = null;
  let price = null;
  if (priceText) {
    const cur = priceText.match(/[€$£]|CNY|USD|EUR|GBP/i);
    if (cur) currency = cur[0].toUpperCase().replace("€", "EUR").replace("$", "USD").replace("£", "GBP");
    const num = priceText.replace(/[^\d.,]/g, "").replace(/\./g, "").replace(",", ".");
    const val = parseFloat(num);
    if (!Number.isNaN(val)) price = val;
  }

  // 图片
  let img =
    $node.find("img.product-image, img.product--image, img").first().attr("src") ||
    $node.find("img").first().attr("data-src") ||
    "";
  img = img ? toAbs(img, baseUrl) : "";

  // 文本摘要（可用于自动回填）
  const preview = $node.text().replace(/\s+/g, " ").trim().slice(0, 500);

  return {
    title,
    url: href,
    sku,
    price,
    currency,
    img,
    preview,
  };
}

/**
 * 针对目录页（列表页）的解析：
 * - 优先使用明显的卡片选择器；
 * - 若未命中，回退到“所有 a 标签”里筛选看起来像商品页的链接；
 */
function parseCatalog(html, pageUrl) {
  const $ = cheerio.load(html);

  // 常见的卡片容器选择器（多给几套，命中率更高）
  const candidates = [
    ".product-list .product-list__item",
    ".product-listing .product-box",
    ".product--list .product--box",
    "article.product, article.teaser, .product",
    ".listing .product, .listing .product--box",
    ".product-grid .product-grid__item",
  ];

  let items = [];
  for (const sel of candidates) {
    const nodes = $(sel);
    if (nodes.length) {
      nodes.each((_, el) => items.push(extractItem($, el, pageUrl)));
      break;
    }
  }

  // 兜底：从所有 a 里挑“像商品页”的
  if (items.length === 0) {
    const links = new Set();
    $("a[href]").each((_, a) => {
      const href = $(a).attr("href");
      if (!href) return;
      const abs = toAbs(href, pageUrl);

      // 对 s-impuls-shop 常见商品/目录路径做一个宽松的白名单
      if (
        /\/artikel\/|\/product\/|\/produkte\/|\/catalog\//i.test(abs) &&
        !links.has(abs)
      ) {
        links.add(abs);
        // 用链接文本做 title（尽量清洗）
        const title =
          $(a).attr("title") ||
          $(a).text().replace(/\s+/g, " ").trim() ||
          abs;
        items.push({
          title,
          url: abs,
          sku: "",
          price: null,
          currency: null,
          img: "",
          preview: "",
        });
      }
    });
  }

  return items;
}

const router = Router();

/**
 * GET /v1/api/catalog/parse?url=...
 * POST /v1/api/catalog/parse  body: { url }
 *
 * 返回：
 * {
 *   ok: true,
 *   source: "https://....",
 *   count: 9,
 *   products: [ { title, url, sku, price, currency, img, preview }, ... ]
 * }
 */
async function handleParse(req, res) {
  try {
    const url = pickUrl(req);
    if (!url) return res.status(400).json({ ok: false, error: "MISSING_URL" });

    const html = await fetchHtml(url);
    const products = parseCatalog(html, url);

    return res.json({
      ok: true,
      source: url,
      count: products.length,
      products,
    });
  } catch (err) {
    console.error("[/catalog/parse] error:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}

router.get("/parse", handleParse);
router.post("/parse", handleParse);

export default router;
