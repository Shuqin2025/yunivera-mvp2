// backend/server.js
import express from "express";
import cors from "cors";
import axios from "axios";
import * as cheerio from "cheerio";

const app = express();

// 允许所有来源，便于预览页直接访问
app.use(cors({ origin: "*", exposedHeaders: ["X-Lang"] }));

// 健康检查
app.get(["/", "/healthz"], (_req, res) => {
  res.type("text/plain").send("ok");
});

// ---------- 工具：HTTP 抓取 ----------
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

async function fetchHtml(targetUrl) {
  const { data } = await axios.get(targetUrl, {
    headers: {
      "User-Agent": UA,
      "Accept-Language": "de,en;q=0.8,zh;q=0.6",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      Referer: targetUrl,
    },
    timeout: 25000,
    // 跟随 301/302；Render 出口在 Cloudflare，下游会正常返回
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

// 尝试从标题里抽型号（4 位以上数字或混合）
function guessSkuFromTitle(title) {
  if (!title) return "";
  const m =
    title.match(/\b[0-9]{4,}\b/) ||
    title.match(/\b[0-9A-Z]{4,}(?:-[0-9A-Z]{2,})*\b/i);
  return m ? m[0] : "";
}

// ---------- 站点解析：S-Impuls 列表页 ----------
async function parseSImpulsCatalog(listUrl, limit = 50) {
  const html = await fetchHtml(listUrl);
  const $ = cheerio.load(html);

  // 商品卡常见结构（OpenCart 模板）
  let cards = $(
    "div.product-layout, div.product-thumb, div.product-grid .product-layout"
  );
  if (cards.length === 0) {
    // 兜底：有些模板把卡片直接放在 .row > .col-*
    cards = $(".row .product-layout, .row .product-thumb");
  }

  const items = [];
  cards.each((i, el) => {
    if (items.length >= limit) return;

    const $card = $(el);

    // 标题/详情页链接：优先 caption/h4/name 区域
    const a =
      $card.find(".caption h4 a").first().attr("href") ||
      $card.find(".caption .name a").first().attr("href") ||
      $card.find("h4 a").first().attr("href") ||
      $card.find(".name a").first().attr("href") ||
      $card.find("a").first().attr("href");

    const title =
      text($card.find(".caption h4 a").first()) ||
      text($card.find(".caption .name a").first()) ||
      text($card.find("h4 a").first()) ||
      text($card.find(".name a").first()) ||
      text($card.find("a").first());

    // 图片：data-src > data-original > src
    const imgEl = $card.find("img").first();
    const imgSrc =
      imgEl.attr("data-src") ||
      imgEl.attr("data-original") ||
      imgEl.attr("src") ||
      "";
    const img = abs(listUrl, (imgSrc || "").split("?")[0]);

    // 价格
    const priceTxt =
      text($card.find("p.price").first()) || text($card.find(".price").first());

    // 型号/sku：有些模板会在 .model/.product-model，抓不到就从标题里猜
    const skuTxt =
      text($card.find(".product-model, .model, .sku").first()) ||
      guessSkuFromTitle(title);

    if (title && a) {
      items.push({
        sku: skuTxt,
        title,
        url: abs(listUrl, a),
        img,
        price: priceTxt,
        currency: "", // 此站点价格字符串里通常已带货币；如果后续需要拆分再做
        moq: "",
      });
    }
  });

  return {
    url: listUrl,
    count: items.length,
    items,
  };
}

// ---------- 总路由 ----------
app.get("/v1/api/catalog/parse", async (req, res) => {
  const listUrl = String(req.query.url || "").trim();
  const limit = Math.max(1, Math.min(parseInt(String(req.query.limit || "50"), 10) || 50, 200));

  if (!listUrl) {
    return res.status(400).json({ error: "missing url" });
  }

  try {
    const u = new URL(listUrl);

    let data;
    if (u.hostname.includes("s-impuls-shop.de")) {
      data = await parseSImpulsCatalog(listUrl, limit);
    } else {
      // 其它站点还没适配时，先返回空结构，前端会提示 0 条
      data = { url: listUrl, count: 0, items: [] };
    }

    // 为了方便排障，顺带在响应头带上语言
    res.setHeader("X-Lang", "de");
    res.json(data);
  } catch (err) {
    console.error("[parse] error:", err?.message || err);
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// ---------- 监听 ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[mvp2-backend] listening on :${PORT}`);
});
