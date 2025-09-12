// backend/server.js  —— ESM
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import * as cheerio from "cheerio"; // ← 修正：cheerio 无 default，必须用 * as

const app = express();
const PORT = process.env.PORT || 10000;

// 允许所有来源调用（前端部署在 Render 的 preview 域名上）
app.use(cors());
app.use(express.json());

// 小工具
const absolutize = (base, maybeUrl) => {
  try {
    return new URL(maybeUrl, base).toString();
  } catch {
    return "";
  }
};

// =============== 站点适配 ===============

// s-impuls-shop.de 列表页解析（以 /catalog/... 为主）
async function parseImpulsCatalog(url, limit = 50) {
  const html = await (await fetch(url, { redirect: "follow" })).text();
  const $ = cheerio.load(html);

  // 做得尽量“鲁棒”：抓取主内容里所有指向 /product/… 的卡片
  const seen = new Set();
  const items = [];

  $('#content a[href*="/product/"]').each((_, a) => {
    if (items.length >= limit) return;
    const href = $(a).attr("href") || "";
    if (!href.includes("/product/")) return;

    const link = absolutize(url, href);
    if (seen.has(link)) return;
    seen.add(link);

    // 标题有时在 a 内部的 .title 或文字节点里
    let title =
      $(a).find(".title").text().trim() ||
      $(a).text().trim().replace(/\s+/g, " ");

    // 有些页面标题只有商品号，或“商品号 + 简短描述”
    // SKU：取标题中第一个“非空白连续片段”（通常就是 30805-MHQ-SLIM 这种）
    const sku = (title.split(/[,\s]/).filter(Boolean)[0] || "").trim();

    // 缩略图：a 里或同级 img；常见 /img/products/thumb/*.jpg
    const $img =
      $(a).find("img").first().attr("src") ||
      $(a).find("img").first().attr("data-src") ||
      "";
    const img = absolutize(url, $img);

    items.push({
      sku,
      title: title || sku,
      url: link,
      img,
      price: "",
      currency: "",
      moq: "",
    });
  });

  return { url, count: items.length, items };
}

// auto-schmuck.com（你之前的类目页）—— 保持可用
async function parseAutoSchmuck(url, limit = 50) {
  const html = await (await fetch(url, { redirect: "follow" })).text();
  const $ = cheerio.load(html);

  const items = [];
  // 兼容其列表结构（标题+链接+首图）
  $("a[href*='.html']").each((_, a) => {
    if (items.length >= limit) return;
    const link = absolutize(url, $(a).attr("href") || "");
    const title =
      ($(a).text() || $(a).attr("title") || "").trim().replace(/\s+/g, " ");
    const img = absolutize(url, $(a).find("img").attr("src") || "");

    // 过滤导航/面包屑等噪声
    if (!title || !/\.html$/.test(link)) return;

    items.push({
      sku: "",
      title,
      url: link,
      img,
      price: "",
      currency: "",
      moq: "",
    });
  });

  return { url, count: items.length, items: items.slice(0, limit) };
}

// 价格 / MOQ 补齐（可选）：对于“详情页”我们再抓一次
// - s-impuls-shop：大多列表页无价；详情页里如有价格/货币/最小起订量则补齐
async function hydrateDetailForImpuls(item) {
  if (!item?.url) return item;
  try {
    const html = await (await fetch(item.url, { redirect: "follow" })).text();
    const $ = cheerio.load(html);

    // 价格（示例选择器，尽量宽松）
    // 常见：.price 或 [itemprop="price"] 等
    const priceText =
      $('[itemprop="price"]').attr("content") ||
      $(".price").first().text().trim() ||
      "";
    // 货币
    const currency =
      $('[itemprop="priceCurrency"]').attr("content") ||
      (/\b(EUR|USD|CNY|RMB|CHF)\b/i.exec(html)?.[1] || "") ||
      "";

    // MOQ（最小起订量），尝试从文案里找“ab x Stück / MOQ x”
    let moq = "";
    const bodyTxt = $("body").text().replace(/\s+/g, " ");
    const m1 = /\bMOQ\s*[:：]?\s*(\d+)/i.exec(bodyTxt);
    const m2 = /\bab\s*(\d+)\s*St(ck|ück)/i.exec(bodyTxt);
    if (m1) moq = m1[1];
    else if (m2) moq = m2[1];

    if (priceText) item.price = priceText;
    if (currency) item.currency = currency;
    if (moq) item.moq = moq;
  } catch {
    // 忽略详情页异常
  }
  return item;
}

// =============== API ===============

// 1) 目录页解析
app.get("/v1/api/catalog/parse", async (req, res) => {
  try {
    const { url, limit: limitStr } = req.query;
    if (!url) return res.status(400).json({ error: "missing url" });
    const limit = Math.min(parseInt(limitStr || "50", 10) || 50, 500);

    const host = new URL(url).hostname;
    let result;

    if (host.includes("s-impuls-shop.de")) {
      result = await parseImpulsCatalog(url, limit);

      // 如果抓到的是“面包屑”而非商品（<= 5 个且标题像 Home/Audio Kabel 之类），就返回空数组避免前端报 “items 不是数组”
      if (result.items.length <= 5 && result.items.every(it => /home|kabel|undefined/i.test(it.title))) {
        result.items = [];
        result.count = 0;
      }

      // 可选：前 N 项补齐价格和 MOQ（控制一下数量与并发）
      const MAX_HYDRATE = Math.min(result.items.length, 20);
      await Promise.all(
        result.items.slice(0, MAX_HYDRATE).map(async (it, idx) => {
          // 仅当价格为空时才抓详情
          if (!it.price) await hydrateDetailForImpuls(it);
        })
      );
    } else if (host.includes("auto-schmuck.com")) {
      result = await parseAutoSchmuck(url, limit);
    } else {
      // 兜底：尝试通用解析（所有 a[href] + img）
      const html = await (await fetch(url, { redirect: "follow" })).text();
      const $ = cheerio.load(html);
      const items = [];
      $("a[href]").each((_, a) => {
        const href = $(a).attr("href") || "";
        const link = absolutize(url, href);
        if (!/https?:/.test(link)) return;
        const title = ($(a).text() || $(a).attr("title") || "").trim();
        const img = absolutize(url, $(a).find("img").attr("src") || "");
        if (title && img) {
          items.push({ sku: "", title, url: link, img, price: "", currency: "", moq: "" });
        }
      });
      result = { url, count: items.length, items: items.slice(0, limit) };
    }

    // 始终返回 items 为数组（即使空数组），避免前端 “items 不是数组”
    if (!Array.isArray(result.items)) result.items = [];
    res.set("Content-Type", "application/json; charset=utf-8");
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// 2) 图片代理（为前端 Excel 内嵌图片准备，解决跨域 & 防盗链）
app.get("/v1/api/proxy-img", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).send("missing url");
    const r = await fetch(url, { redirect: "follow" });
    if (!r.ok) return res.status(502).send("bad upstream");
    const ct = r.headers.get("content-type") || "image/jpeg";
    const buf = Buffer.from(await r.arrayBuffer());
    res.set("Content-Type", ct);
    res.set("Cache-Control", "public, max-age=86400");
    res.set("Access-Control-Allow-Origin", "*");
    res.send(buf);
  } catch {
    res.status(500).send("img proxy error");
  }
});

// 健康检查
app.get("/", (_, res) => {
  res.type("text/plain").send("OK");
});

app.listen(PORT, () => {
  console.log("backend started on port", PORT);
});
