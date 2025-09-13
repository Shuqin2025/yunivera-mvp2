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

// 版本确认（用于快速验证是否已部署新代码）
app.get("/v1/api/__version", (_req, res) => {
  res.json({
    version: "restore-mvp-2025-09-12-2235",
    note: "S-Impuls selectors + ok/products compatibility + logging",
  });
});

// ---------- 工具：HTTP 抓取 ----------
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
// 尝试从标题里抽型号
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

  // 1) 首选：站点自有容器（你截图中显示的结构）
  //   #nx_content -> .listproduct-wrapper -> .listproduct
  //   卡片下通常有 a[href*="/product/"] 与 .image img
  let cardRoots = $("#nx_content .listproduct-wrapper .listproduct");
  // 如果页面结构变化，下面的候选选择器做兜底
  const candidates = [
    { item: ".listproduct .product, .listproduct > div" },
    { item: "div.product-layout, div.product-thumb, div.product-grid .product-layout" },
    { item: ".row .product-layout, .row .product-thumb" },
  ];

  // 收集商品：策略一——直接从列表里的 “指向 /product/ 的链接” 出发
  const items = [];
  function pushItem(aEl) {
    if (items.length >= limit) return;
    const $a = $(aEl);
    const href = $a.attr("href") || "";
    if (!href || !href.includes("/product/")) return;

    // 标题优先用链接文本
    const title =
      ($a.attr("title") || "").trim() || text($a);

    // 找图片：在当前链接所在的卡片容器向上找 img
    // 先在同层/父层找 .image img，再全卡片找第一个 img
    let $card = $a.closest("div");
    if ($card.length === 0) $card = $a.parent();
    const $img =
      $card.find(".image img").first().length
        ? $card.find(".image img").first()
        : $card.find("img").first();

    const imgSrc =
      $img.attr("data-src") || $img.attr("data-original") || $img.attr("src") || "";
    const img = abs(listUrl, (imgSrc || "").split("?")[0]);

    // 价格：列表可能不展示，尽量找常见类名
    const priceTxt =
      text($card.find(".price, .product-price, .amount, .m-price").first()) || "";

    const skuTxt =
      text($card.find(".product-model, .model, .sku").first()) ||
      guessSkuFromTitle(title);

    if (title && href) {
      items.push({
        sku: skuTxt,
        title,
        url: abs(listUrl, href),
        img,
        price: priceTxt || null,
        currency: "", // 此站价格文本可能已带货币符号
        moq: "",
      });
    }
  }

  // 策略一：在主列表容器内寻找 /product/ 链接
  if (cardRoots.length) {
    cardRoots.find('a[href*="/product/"]').each((_i, a) => pushItem(a));
  }

  // 策略二：若还抓不到，尝试一组常见商品卡候选容器
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

  return {
    ok: true,                 // 兼容新版口径
    url: listUrl,
    count: items.length,
    products: items,          // 新版字段
    items,                    // 兼容旧前端
  };
}

// ---------- 总路由 ----------
app.get("/v1/api/catalog/parse", async (req, res) => {
  const listUrl = String(req.query.url || "").trim();
  const limit = Math.max(
    1,
    Math.min(parseInt(String(req.query.limit || "50"), 10) || 50, 200)
  );

  if (!listUrl) {
    return res.status(400).json({ ok: false, error: "missing url" });
  }

  try {
    const u = new URL(listUrl);
    console.log("[parse] target =", listUrl);

    let data;
    if (u.hostname.includes("s-impuls-shop.de")) {
      data = await parseSImpulsCatalog(listUrl, limit);
    } else {
      // 其它站点未适配时，返回空结构（但保持字段一致）
      data = { ok: true, url: listUrl, count: 0, products: [], items: [] };
    }

    res.setHeader("X-Lang", "de");
    res.json(data);
  } catch (err) {
    console.error("[parse] error:", err?.message || err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// ---------- 监听 ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[mvp2-backend] listening on :${PORT}`);
});
