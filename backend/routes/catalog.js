// backend/routes/catalog.js
import express from "express";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import jschardet from "jschardet";
import { URL as NodeURL } from "url";

// 站点适配器
import parseSinotronic from "../adapters/sinotronic.js";

const router = express.Router();

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

/** 智能抓取 HTML：自动补 UA/Referer，自动转码（gbk/gb2312 等） */
async function fetchHtmlSmart(pageUrl) {
  const u = new NodeURL(pageUrl);
  const origin = `${u.protocol}//${u.host}`;

  const res = await fetch(pageUrl, {
    redirect: "follow",
    headers: {
      "User-Agent": UA,
      "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,de;q=0.7",
      "Cache-Control": "no-cache",
      Referer: origin,
    },
  });

  if (!res.ok) {
    throw new Error(`fetch ${pageUrl} failed: ${res.status} ${res.statusText}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());

  // 1) Content-Type -> charset
  const ctype = res.headers.get("content-type") || "";
  const m = ctype.match(/charset=([^;]+)/i);
  let enc = m && m[1] ? m[1].trim() : "";

  // 2) meta charset
  if (!enc) {
    const headSample = buf.slice(0, 4096).toString("latin1");
    const m2 =
      headSample.match(/<meta[^>]*charset=["']?([\w-]+)["']?/i) ||
      headSample.match(/charset=([\w-]+)/i);
    if (m2 && m2[1]) enc = m2[1].trim();
  }

  // 3) jschardet 探测
  if (!enc) {
    const det = jschardet.detect(buf);
    if (det && det.encoding) enc = det.encoding;
  }

  // 4) 按域名兜底（sinotronic 大概率 gbk/gb2312）
  if (!enc && /sinotronic/i.test(u.hostname)) enc = "gbk";

  // 5) 没头绪就 utf-8
  if (!enc) enc = "utf-8";

  let html;
  try {
    html = iconv.decode(buf, enc);
  } catch {
    html = buf.toString("utf-8");
  }

  return { html, encoding: enc };
}

function abs(origin, href = "") {
  try {
    return new NodeURL(href, origin).href;
  } catch {
    return href || origin;
  }
}

// —— 通用解析（OpenCart 等）——
function extractCommonProducts($, pageUrl) {
  let cards = $(
    "div.product-layout, div.product-grid .product-thumb, div.product-thumb, .product-list .product-layout"
  );
  if (cards.length === 0) {
    cards = $("div[class*='product']:has(a, img)");
  }

  const out = [];
  cards.each((_, el) => {
    const root = $(el);
    const a = root.find("a[href]").first();
    if (!a.length) return;

    const imgEl = root.find("img").first();
    const title =
      (imgEl.attr("alt") || a.attr("title") || a.text() || "")
        .replace(/\s+/g, " ")
        .trim();
    if (!title) return;

    const href = abs(pageUrl, a.attr("href") || "");
    const img = abs(pageUrl, imgEl.attr("src") || "");

    out.push({
      sku: title,
      title,
      url: href,
      img,
      price: "",
      currency: "",
      moq: "",
    });
  });

  return out;
}

// —— 主处理器（GET/POST 共用）——
async function handleParse(req, res) {
  const isGet = req.method === "GET";
  const src = isGet ? req.query : (req.body || {});
  const targetUrl = String(src.url || "").trim();
  const limit = Math.max(1, Number(src.limit || 50) || 50);
  const imgOpt = String(src.img || "");
  const imgCount = Math.max(0, Number(src.imgCount || 5) || 5);
  const debug = String(src.debug || "");

  if (!targetUrl) {
    return res.status(400).json({ ok: false, error: "missing url" });
  }

  // 抓取 + 转码
  let html, encoding;
  try {
    const r = await fetchHtmlSmart(targetUrl);
    html = r.html;
    encoding = r.encoding;
  } catch (e) {
    return res
      .status(502)
      .json({ ok: false, error: "fetch failed", detail: String(e.message || e) });
  }

  const $ = cheerio.load(html, { decodeEntities: false });

  // 临时诊断：?debug=1 返回页面统计，便于定位“抓到没”
  if (debug) {
    return res.json({
      ok: true,
      debug: {
        encoding,
        title: $("title").text(),
        a: $("a").length,
        img: $("img").length,
        li: $("li").length,
        tr: $("tr").length,
        sample: html.slice(0, 1200),
      },
    });
  }

  // 适配器优先
  const host = (() => {
    try {
      return new NodeURL(targetUrl).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();

  let items = [];
  if (/sinotronic/i.test(host)) {
    items = await parseSinotronic($, { url: targetUrl, limit });
  } else {
    items = extractCommonProducts($, targetUrl);
  }

  if (items.length > limit) items = items.slice(0, limit);

  // 可选：图片 base64
  if ((imgOpt || "").toLowerCase() === "base64" && items.length) {
    const fetchImg = async (u) => {
      try {
        const r = await fetch(u, { headers: { "User-Agent": UA } });
        if (!r.ok) return "";
        const b = Buffer.from(await r.arrayBuffer());
        const mime = r.headers.get("content-type") || "image/jpeg";
        return `data:${mime};base64,${b.toString("base64")}`;
      } catch {
        return "";
      }
    };
    await Promise.all(
      items.slice(0, imgCount).map(async (it) => {
        if (it.img) it.img_b64 = await fetchImg(it.img);
      })
    );
  }

  return res.json({
    ok: true,
    source: targetUrl,
    count: items.length,
    items,
    products: items,
  });
}

// 统一两个入口
router.get("/v1/api/catalog/parse", handleParse);
router.post("/v1/api/catalog/parse", handleParse);

export default router;
