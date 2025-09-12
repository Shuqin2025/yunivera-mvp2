// backend/server.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { load as cheerioLoad } from "cheerio";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.set("trust proxy", true);

/** 小工具：绝对化 URL */
function absolutize(href, base) {
  try {
    return new URL(href, base).toString();
  } catch {
    return href || "";
  }
}

/** 从 s-impuls-shop 的商品链接推断 Item No.（SKU） */
function inferSkuFromUrl(itemUrl) {
  try {
    const u = new URL(itemUrl);
    const last = u.pathname.split("/").filter(Boolean).pop() || "";
    const raw = decodeURIComponent(last.replace(/\.html?$/i, ""));
    // 例如：30805-mhq-slim  →  30805-MHQ-SLIM
    if (/^\d/.test(raw)) {
      return raw.replace(/[^0-9a-z-]+/gi, "").replace(/-/g, "-").toUpperCase();
    }
    return "";
  } catch {
    return "";
  }
}

/** 解析 s-impuls-shop 分类页 */
function parseImpulsCategory(html, pageUrl, limit = 50) {
  const $ = cheerioLoad(html);

  // 页面主体所有可能的商品卡片（结构在不同目录有轻微差别，这里穷举一些常见选择器）
  const cards = $(
    // 常见卡片容器里 a[href^="/product/…"]
    '.product-list a[href*="/product/"], \
     .product-box a[href*="/product/"], \
     a.product--image[href*="/product/"], \
     .listing a[href*="/product/"]'
  )
    .filter((i, el) => {
      const href = $(el).attr("href") || "";
      return /\/product\//i.test(href);
    })
    // 同一个卡片里可能匹配到多个 a，这里去重到“卡片级”
    .map((i, el) => $(el).closest("article, .product-box, li, .product--box")[0])
    .toArray()
    .filter(Boolean);

  const items = [];
  for (const card of cards) {
    const $card = $(card);

    // 链接
    let linkEl =
      $card.find('a[href*="/product/"]').get(0) ||
      $card.find("a").get(0);
    const href = linkEl ? $(linkEl).attr("href") || "" : "";
    const url = absolutize(href, pageUrl);

    // 标题（优先标题元素，其次图片 alt，再次链接标题）
    const title =
      ($card.find(".product-title, .product--title, .title, h3, h2").first().text() || "").trim() ||
      ($card.find("img[alt]").attr("alt") || "").trim() ||
      ($(linkEl).attr("title") || "").trim();

    // 图片（优先卡片内 img，其次 data-src/data-original）
    let img =
      $card.find("img").attr("src") ||
      $card.find("img").attr("data-src") ||
      $card.find("img").attr("data-original") ||
      "";
    img = absolutize(img, pageUrl);

    // 价格与货币（如果有）
    let priceText =
      $card.find(".price, .product-price, .amount, .price--default").first().text().trim() || "";
    priceText = priceText.replace(/\s+/g, " ");
    let price = "";
    let currency = "";
    const m = priceText.match(/([€$£])\s*([\d.,]+)/);
    if (m) {
      currency = m[1];
      price = m[2].replace(/\./g, "").replace(",", ".");
    }

    // MOQ（通常目录页没有，这里置空留给将来扩展）
    const moq = "";

    // SKU
    const sku = inferSkuFromUrl(url);

    // 兜底：标题或链接不齐就跳过
    if (!url || !title) continue;

    items.push({ sku, title, url, img, price, currency, moq });
    if (items.length >= Number(limit || 50)) break;
  }

  return items;
}

/** 统一抓取器 */
async function fetchHtml(targetUrl) {
  const res = await fetch(targetUrl, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "de,en;q=0.9,zh;q=0.8",
    },
    redirect: "follow",
    // Render 免费实例偶发超时，设长一点
    timeout: 30000,
  });
  if (!res.ok) {
    throw new Error(`Fetch HTML failed: ${res.status} ${res.statusText}`);
  }
  return await res.text();
}

/** API：解析分类页 */
app.get("/v1/api/catalog/parse", async (req, res) => {
  try {
    const raw = (req.query.url || "").toString();
    const limit = Number(req.query.limit || 50);
    if (!raw) return res.status(400).json({ error: "missing url" });

    const pageUrl = decodeURIComponent(raw);
    const html = await fetchHtml(pageUrl);

    let items = [];
    const host = new URL(pageUrl).hostname;

    if (/s-impuls-shop\.de$/i.test(host)) {
      items = parseImpulsCategory(html, pageUrl, limit);
    } else {
      // 默认兜底：抓取页面上所有 /product/ 链接
      const $ = cheerioLoad(html);
      $("a[href*='/product/']").each((_, a) => {
        const href = $(a).attr("href") || "";
        const url = absolutize(href, pageUrl);
        const title = ($(a).attr("title") || $(a).text() || "").trim();
        const img = absolutize($(a).find("img").attr("src") || "", pageUrl);
        const sku = inferSkuFromUrl(url);
        if (url && title) items.push({ sku, title, url, img, price: "", currency: "", moq: "" });
      });
      items = items.slice(0, limit);
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({
      url: pageUrl,
      count: items.length,
      items,
    });
  } catch (err) {
    res.status(500).json({ error: String(err && err.message || err) });
  }
});

/** 图片代理（用于 Excel 插入真实图片，避免前端跨域） */
app.get("/v1/api/img", async (req, res) => {
  try {
    const raw = (req.query.url || "").toString();
    if (!raw) return res.status(400).send("missing url");
    const imgUrl = decodeURIComponent(raw);

    const r = await fetch(imgUrl, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        referer: new URL(imgUrl).origin + "/",
      },
      redirect: "follow",
      timeout: 30000,
    });
    if (!r.ok) {
      res.status(r.status).send(`fetch image failed: ${r.status}`);
      return;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    const ctype = r.headers.get("content-type") || "image/jpeg";
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.type(ctype).send(buf);
  } catch (e) {
    res.status(500).send(String(e));
  }
});

/** 健康检查 */
app.get("/v1/health", (req, res) => res.json({ ok: true, ts: Date.now() }));

app.listen(PORT, () => {
  console.log(`[mvp2-backend] up on :${PORT}`);
});
