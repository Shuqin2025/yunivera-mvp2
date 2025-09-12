// backend/server.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import cheerio from "cheerio";
import pLimit from "p-limit";

const app = express();

// 允许所有来源（前端预览页会带 ?api=xxx 跨域访问）
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// 通用获取 HTML
async function getHTML(url) {
  const res = await fetch(url, {
    headers: {
      // 某些站点需要 UA / 语言头才会返回完整 DOM
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36",
      "accept-language": "de,en;q=0.9,zh;q=0.8",
    },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`fetch ${url} failed: ${res.status}`);
  }
  return await res.text();
}

// 规范化为绝对地址
function abs(base, href = "") {
  try {
    return new URL(href, base).href;
  } catch {
    return href || base;
  }
}

// 从 title 里尽力抽取货号（像 30805-MHQ-SLIM）
function guessSkuFromTitle(title = "") {
  const m = title.trim().match(/[A-Z0-9][A-Z0-9\-\.]+/i);
  return m ? m[0] : "";
}

/**
 * 解析 auto-schmuck.de 类站点（我们之前支持的）
 */
function parseAutoSchmuck($, base) {
  const items = [];
  // 典型结构：商品块里有 a 和 img
  $("a").each((_, a) => {
    const href = $(a).attr("href");
    const title = $(a).text().trim();
    const img = $(a).find("img").attr("src");
    if (href && title && img) {
      items.push({
        sku: "",
        title,
        url: abs(base, href),
        img: abs(base, img),
        price: "",
        currency: "",
        moq: "",
      });
    }
  });
  return items;
}

/**
 * 解析 s-impuls-shop.de（OpenCart 风格）
 * 列表页常见结构：
 *   .product-layout 里有 .image img 与 .caption / .name 区域 a
 */
function parseSImpuls($, base) {
  const items = [];

  // 1) 新版/常见：.product-layout .product-thumb
  const blocks =
    $("#content .product-layout, .product-layout, .product-thumb").toArray();

  if (blocks.length) {
    for (const el of blocks) {
      const $el = $(el);

      // 图片
      const img =
        $el.find(".image img").attr("src") ||
        $el.find("img").attr("src") ||
        "";

      // 标题与链接（多主题兼容）
      const a =
        $el.find(".caption a").first()[0] ||
        $el.find(".name a").first()[0] ||
        $el.find("a").first()[0];

      let title = "";
      let href = "";
      if (a) {
        title = $(a).attr("title")?.trim() || $(a).text().trim() || "";
        href = $(a).attr("href") || "";
      }

      if (!title && img) {
        // 有时 title 放在 img 的 alt
        title = $el.find("img").attr("alt")?.trim() || "";
      }

      // 过滤掉明显是面包屑 / 类目卡片
      if (!href || !title) continue;
      if (/index\.php\?path=catalog\/home-cinema\/undefined/i.test(href)) {
        continue;
      }

      items.push({
        sku: guessSkuFromTitle(title),
        title,
        url: abs(base, href),
        img: abs(base, img),
        price: "",
        currency: "",
        moq: "",
      });
    }
  }

  // 2) 兜底：若没抓到，再尝试更宽松的选择器
  if (items.length === 0) {
    $("a").each((_, a) => {
      const href = $(a).attr("href") || "";
      const title = ($(a).attr("title") || $(a).text() || "").trim();
      const img = $(a).find("img").attr("src") || "";

      if (
        href.includes("/product/") &&
        title &&
        img &&
        !/undefined/i.test(href)
      ) {
        items.push({
          sku: guessSkuFromTitle(title),
          title,
          url: abs(base, href),
          img: abs(base, img),
          price: "",
          currency: "",
          moq: "",
        });
      }
    });
  }

  return items;
}

/**
 * 主解析函数：根据域名路由到不同解析器
 */
function parseBySite(html, pageURL) {
  const $ = cheerio.load(html, { decodeEntities: false });

  const host = new URL(pageURL).host;

  if (/s-impuls-shop\.de$/i.test(host)) {
    const items = parseSImpuls($, pageURL);
    return { url: pageURL, count: items.length, items };
  }

  // 默认尝试之前的解析（auto-schmuck 一类）
  const items = parseAutoSchmuck($, pageURL);
  return { url: pageURL, count: items.length, items };
}

app.get("/v1/api/catalog/parse", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "X-Lang");

  try {
    const pageURL = req.query.url;
    const limit = Number(req.query.limit || 50);

    if (!pageURL) {
      return res.status(400).json({ error: "missing url" });
    }

    const html = await getHTML(pageURL);
    let { url, count, items } = parseBySite(html, pageURL);

    // 截断到 limit
    if (Array.isArray(items) && items.length > limit) {
      items = items.slice(0, limit);
    }

    return res.json({ url, count: items.length, items });
  } catch (err) {
    console.error("[parse error]", err);
    return res.status(500).json({ error: String(err) });
  }
});

app.get("/health", (_, res) => res.send("ok"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`[mvp2-backend] listening on ${PORT}`);
});
