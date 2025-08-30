// backend/routes/scrape.js
import express from "express";
import { load as cheerioLoad } from "cheerio";

// Node/undici 的 fetch（Render/Node18+自带）。如需兼容更低版本，可装 node-fetch。
const router = express.Router();

/** ----------------- 小工具 ----------------- */
const normText = (s) =>
  (s || "")
    .replace(/\s+/g, " ")
    .replace(/\u00A0/g, " ")
    .trim();

const pick = (...candidates) => {
  for (const c of candidates) {
    if (c && typeof c === "string" && normText(c)) return normText(c);
  }
  return null;
};

// 从一串文本里提取货币+金额（很宽松，适配 $ 12.34 / 12,34 € / ￥199 等）
const parseMoney = (raw) => {
  if (!raw) return { currency: null, price: null };
  const s = normText(raw);
  // 常见货币符号
  const currencyMatch = s.match(/([$€£¥]|RMB|CNY|USD|EUR|GBP)/i);
  let currency = currencyMatch ? currencyMatch[0].toUpperCase() : null;

  // 取第一个像金额的数字（带 , .）
  const numMatch = s.match(/(\d{1,3}([.,]\d{3})*([.,]\d{1,2})?)/);
  let price = null;
  if (numMatch) {
    // 1. 先把千分位去掉，再把小数点统一为 .
    let n = numMatch[1];
    // 如果同时有 , 和 .，根据位置判断哪一个是千分位
    if (n.includes(",") && n.includes(".")) {
      if (n.lastIndexOf(",") > n.lastIndexOf(".")) {
        // 德式: 1.234,56 => 1234.56
        n = n.replace(/\./g, "").replace(",", ".");
      } else {
        // 美式: 1,234.56 => 1234.56
        n = n.replace(/,/g, "");
      }
    } else {
      // 只有 , 的情况：多半是 1.234 或 1,23 这种
      const parts = n.split(",");
      if (parts.length === 2 && parts[1].length <= 2) {
        // 作为小数分隔
        n = parts[0].replace(/\./g, "") + "." + parts[1];
      } else {
        // 作为千分位
        n = n.replace(/,/g, "");
      }
    }
    const v = Number(n);
    if (!Number.isNaN(v)) price = v;
  }

  return { currency, price };
};

// 把一组 CSS 选择器依次尝试，拿到第一个有值的文本
const pickText = ($, selectors = []) => {
  for (const sel of selectors) {
    const t = normText($(sel).first().text());
    if (t) return t;
  }
  return null;
};

// 取图片 URL
const pickImage = ($, selectors = []) => {
  for (const sel of selectors) {
    const src =
      $(sel).attr("data-old-hires") ||
      $(sel).attr("data-a-dynamic-image") ||
      $(sel).attr("src") ||
      "";
    const val = normText(src);
    if (val) return val;
  }
  return null;
};

// 收集多图
const collectImages = ($, selectors = []) => {
  const out = new Set();
  for (const sel of selectors) {
    $(sel).each((_, el) => {
      const cand =
        $(el).attr("data-old-hires") ||
        $(el).attr("data-a-dynamic-image") ||
        $(el).attr("src") ||
        $(el).attr("data-src") ||
        "";
      const v = normText(cand);
      if (v) out.add(v);
    });
  }
  return Array.from(out);
};

/** ----------------- 站点定制解析 ----------------- */
/**
 * 每个解析器的签名：
 *   parser($, url) => { title, price, currency, moq, sku, images }
 *
 * 注意：这些选择器是“尽量覆盖”的经验值，个别商品页若不匹配，会回落到通用解析。
 */

// 1) 1688 商品详情（detail.1688.com / m.1688.com/detail.html）
const parse1688 = ($) => {
  // 标题
  const title =
    pickText($, [
      ".title-text", // 新版
      ".mod-title h1",
      "h1.title",
      "#mod-detail-title .d-title",
    ]) || null;

  // 价格（可能是区间价/批发价，先取页面上第一个显著的价格）
  const priceRaw =
    pickText($, [
      ".price .value",
      ".mod-detail-price .price",
      ".price-original",
      ".mod-detail-price .unit-detail-content .price",
      ".mod-detail-purchasing .price",
    ]) || null;

  const { currency, price } = parseMoney(priceRaw);

  // MOQ（最小起订量）
  const moqRaw =
    pickText($, [
      ".obj-amount .value",
      ".mod-detail-purchasing .obj-amount",
      ".mod-detail-purchasing .amount",
      ".mod-detail-purchasing .num",
      ".mod-detail-price .unit-detail-content .obj-amount",
    ]) || null;

  // SKU/变体（尝试收集一些属性）
  let sku = null;
  const skuPieces = [];
  $(".mod-detail-attributes .obj-sku, .sku-attr, .attributes .attr")
    .find("li, .item, .prop")
    .each((_, li) => {
      const t = normText($(li).text());
      if (t) skuPieces.push(t);
    });
  if (skuPieces.length) sku = skuPieces.join(" | ");

  // 图片
  const images =
    collectImages($, [
      ".vertical-img img",
      ".tab-content img",
      "#dt-tab img",
      ".image img",
    ]) || [];

  return { title, price, currency, moq: moqRaw, sku, images };
};

// 2) Amazon 商品详情（多个站点通用）
const parseAmazon = ($) => {
  const title =
    pickText($, ["#productTitle", "#title", "#titleSection h1"]) || null;

  const priceRaw =
    pickText($, [
      "#priceblock_ourprice",
      "#priceblock_dealprice",
      "#corePrice_feature_div .a-offscreen",
      ".a-price .a-offscreen",
    ]) || null;

  const { currency, price } = parseMoney(priceRaw);

  // 描述要点（可用于生成报价的副标题）
  const bullets = [];
  $("#feature-bullets li")
    .find("span")
    .each((_, li) => {
      const t = normText($(li).text());
      if (t) bullets.push(t);
    });
  const sku = bullets.length ? bullets.slice(0, 6).join(" • ") : null;

  // 主图/多图
  const mainImage =
    pickImage($, [
      "#landingImage",
      "#imgTagWrapperId img",
      "#main-image-container img",
    ]) || null;

  const images = collectImages($, [
    "#altImages img",
    "#imageBlockThumbs img",
    "#imgTagWrapperId img",
  ]);

  if (mainImage && !images.includes(mainImage)) images.unshift(mainImage);

  // Amazon 页面不展示 MOQ，一般 B2C，置空
  return { title, price, currency, moq: null, sku, images };
};

/** ----------------- 通用兜底解析 ----------------- */
const parseGeneric = ($) => {
  const title = pickText($, ["title", "h1", "h2"]) || null;

  // 试着找页面里第一个像价格的文本
  let money = { currency: null, price: null };
  const guessSelectors = [
    ".price",
    ".product-price",
    ".price .amount",
    ".pricing",
    "[class*=price]",
  ];
  for (const sel of guessSelectors) {
    const t = normText($(sel).first().text());
    if (t) {
      money = parseMoney(t);
      if (money.price != null) break;
    }
  }

  // H1/H2 作为粗略“要点”
  const h1s = [];
  $("h1,h2")
    .slice(0, 5)
    .each((_, el) => {
      const t = normText($(el).text());
      if (t) h1s.push(t);
    });

  // 一些图
  const images = collectImages($, ["img"]);

  return {
    title,
    price: money.price,
    currency: money.currency,
    moq: null,
    sku: h1s.join(" | ") || null,
    images,
  };
};

/** ----------------- 解析分发器 ----------------- */
const SITE_PARSERS = [
  {
    test: (host) =>
      /(^|\.)(detail\.1688\.com|m\.1688\.com)$/i.test(host) ||
      /(^|\.)(1688\.com)$/i.test(host),
    parse: parse1688,
    name: "1688",
  },
  {
    test: (host) => /(^|\.)amazon\./i.test(host),
    parse: parseAmazon,
    name: "amazon",
  },
];

const dispatchParse = ($, url) => {
  let host = null;
  try {
    host = new URL(url).host.toLowerCase();
  } catch (_) {
    //
  }

  if (host) {
    for (const it of SITE_PARSERS) {
      if (it.test(host)) {
        const data = it.parse($, url) || {};
        return { vendor: it.name, ...data };
      }
    }
  }
  return { vendor: "generic", ...parseGeneric($) };
};

/** ----------------- 路由：GET /v1/api/scrape ----------------- */
router.get("/scrape", async (req, res) => {
  const rawUrl = req.query.url || req.query.u;
  if (!rawUrl) {
    return res.status(400).json({ ok: false, error: "参数缺失：url" });
  }

  let finalUrl = rawUrl;
  try {
    // 校正没有协议的情况
    if (!/^https?:\/\//i.test(finalUrl)) {
      finalUrl = "https://" + finalUrl;
    }
    // 仅允许 http/https
    const u = new URL(finalUrl);
    if (!/^https?:$/i.test(u.protocol)) {
      return res.status(400).json({ ok: false, error: "仅支持 http/https" });
    }
  } catch (e) {
    return res.status(400).json({ ok: false, error: "非法 URL" });
  }

  try {
    // 做一点反爬友好：设置通用 UA
    const resp = await fetch(finalUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,de;q=0.7",
        "Cache-Control": "no-cache",
      },
      redirect: "follow",
    });

    if (!resp.ok) {
      return res
        .status(resp.status)
        .json({ ok: false, error: `HTTP ${resp.status}` });
    }

    const html = await resp.text();
    const $ = cheerioLoad(html);

    // 通用字段（原来就有的）
    const titleFallback = normText($("title").first().text());
    const descFallback =
      normText(
        $('meta[name="description"]').attr("content") ||
          $('meta[property="og:description"]').attr("content") ||
          ""
      ) || "";

    const h1s = [];
    $("h1")
      .slice(0, 8)
      .each((_, el) => {
        const t = normText($(el).text());
        if (t) h1s.push(t);
      });

    // 站点定制 / 通用兜底
    const parsed = dispatchParse($, finalUrl);

    // 预览片段（便于调试）
    const preview = (() => {
      const body = $("body").clone();
      // 去掉 script/style，防止太长
      body.find("script,style,noscript").remove();
      const txt = normText(body.text()).slice(0, 800);
      return txt;
    })();

    return res.json({
      ok: true,
      url: finalUrl,
      fetchedAt: Date.now(),
      // 原有字段
      title: parsed.title || titleFallback || null,
      description: descFallback,
      h1: h1s,
      approxTextLength: html.length,
      preview,

      // 新增结构化字段
      vendor: parsed.vendor, // "amazon" | "1688" | "generic"
      price: parsed.price ?? null,
      currency: parsed.currency ?? null,
      moq: parsed.moq ?? null,
      sku: parsed.sku ?? null,
      images: parsed.images ?? [],
    });
  } catch (e) {
    return res.status(502).json({
      ok: false,
      error: "抓取失败：" + (e?.message || String(e)),
    });
  }
});

export default router;
