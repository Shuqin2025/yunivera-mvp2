// backend/routes/catalog.js
import { Router } from "express";
import * as cheerio from "cheerio";
import { URL } from "url";

const router = Router();

/** 绝对链接 */
function abs(base, href) {
  try {
    if (!href) return "";
    return new URL(href, base).toString();
  } catch {
    return href || "";
  }
}

/** 针对不同站点的选择器规则（可逐步完善） */
const rulesByHost = {
  // s-impuls-shop.de 目录页的常见结构（先给出较宽松的“命中更高”的组合）
  "s-impuls-shop.de": {
    item:
      ".product, .product-item, .product--box, .product-list-item, li.product, .item", // 容器
    title:
      ".product--title a, .product-title a, .title a, h3 a, h2 a, a.product-title",
    url: "a", // 兜底：容器内第一个 <a>
    price:
      ".price, .product--price, .price--default, .product-price, .price--value",
    sku: "[data-product-ordernumber], .product--sku, .sku, .article-number",
    img: "img",
  },

  // 其它站点可继续加……
};

/** 泛化提取：若没有站点特定规则，就用一个“通用启发式” */
const genericRules = {
  item:
    ".product, .product-item, .product--box, .card, li, .grid-item, .col, .item",
  title:
    ".title a, .product--title a, h3 a, h2 a, a.product-title, .card-title a, .title, h3, h2",
  url: "a",
  price: ".price, .product--price, .price--default, .product-price",
  sku: ".sku, .product--sku, [data-sku], [data-article-number]",
  img: "img",
};

/** 从一段元素中按规则抽取 */
function pick($, el, rule, baseUrl) {
  const $el = $(el);

  const title =
    ($el.find(rule.title).first().text() ||
      $el.find("a[title]").first().attr("title") ||
      $el.find("a").first().text() ||
      $el.text() ||
      "")
      .replace(/\s+/g, " ")
      .trim();

  const url = abs(baseUrl, $el.find(rule.url).first().attr("href"));
  const price = ($el.find(rule.price).first().text() || "")
    .replace(/\s+/g, " ")
    .trim();
  const sku =
    ($el.find(rule.sku).first().text() ||
      $el.find(rule.sku).first().attr("data-product-ordernumber") ||
      $el.find(rule.sku).first().attr("data-sku") ||
      "")
      .replace(/\s+/g, " ")
      .trim();
  const img = abs(
    baseUrl,
    $el.find(rule.img).first().attr("src") ||
      $el.find(rule.img).first().attr("data-src")
  );

  return { title, url, price, sku, img };
}

/**
 * POST /v1/api/catalog
 * body: { url: "https://..." }
 * 返回：{ ok, site, count, items: [...] }
 */
router.post("/", async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) {
      return res
        .status(400)
        .json({ ok: false, error: "参数缺失：url 必填" });
    }

    // Node 18+ 自带 fetch，这里直接用全局 fetch（无需 node-fetch）
    const r = await fetch(url, {
      headers: {
        // 简单 UA，部分站点需要
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
    });

    if (!r.ok) {
      return res
        .status(r.status)
        .json({ ok: false, error: `抓取失败：HTTP ${r.status}` });
    }

    const html = await r.text();
    const $ = cheerio.load(html);

    const host = new URL(url).hostname.replace(/^www\./, "");
    const rule = rulesByHost[host] || genericRules;

    const items = [];
    $(rule.item).each((_, el) => {
      const it = pick($, el, rule, url);
      // 至少要有标题 + 链接
      if (it.title && it.url) items.push(it);
    });

    return res.json({
      ok: true,
      site: host,
      count: items.length,
      items,
    });
  } catch (err) {
    console.error("[/v1/api/catalog] error:", err);
    return res
      .status(500)
      .json({ ok: false, error: String(err?.message || err) });
  }
});

export default router;
