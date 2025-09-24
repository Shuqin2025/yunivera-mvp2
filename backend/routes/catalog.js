// backend/routes/catalog.js
import express from "express";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import jschardet from "jschardet";
import { URL as NodeURL } from "url";

// 站点适配器（ESM 导入为命名空间，以便调用 .parse）
import * as sinotronic from "../adapters/sinotronic.js";

const router = express.Router();

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

function abs(origin, href = "") {
  try {
    return new NodeURL(href, origin).href;
  } catch {
    return href || origin;
  }
}

/** 抓取并智能转码（带编码 debug） */
async function fetchHtmlSmart(pageUrl) {
  const u = new NodeURL(pageUrl);
  const origin = `${u.protocol}//${u.host}`;

  const res = await fetch(pageUrl, {
    redirect: "follow",
    headers: {
      "User-Agent": UA,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,de;q=0.7",
      Referer: origin,
      "Cache-Control": "no-cache",
    },
  });
  if (!res.ok) throw new Error(`fetch ${pageUrl} failed: ${res.status}`);

  const buf = Buffer.from(await res.arrayBuffer());

  const ctype = res.headers.get("content-type") || "";
  const m1 = ctype.match(/charset=([^;]+)/i);
  const charsetFromHeader = m1?.[1]?.trim() || "";

  const headLatin1 = buf.slice(0, 4096).toString("latin1");
  const m2 =
    headLatin1.match(/<meta[^>]*charset=["']?([\w-]+)["']?/i) ||
    headLatin1.match(/charset=([\w-]+)/i);
  const charsetFromMeta = m2?.[1]?.trim() || "";

  const det = jschardet.detect(buf);
  const charsetFromJschardet = det?.encoding || "";

  let encoding =
    charsetFromHeader ||
    charsetFromMeta ||
    charsetFromJschardet ||
    (/sinotronic/i.test(u.hostname) ? "gb18030" : "") ||
    "utf-8";

  let html;
  try {
    html = iconv.decode(buf, encoding);
  } catch {
    html = buf.toString("utf-8");
    encoding = "utf-8";
  }

  return {
    html,
    encoding,
    debug: {
      origin,
      host: u.hostname,
      contentType: ctype,
      charsetFromHeader,
      charsetFromMeta,
      charsetFromJschardet,
      finalEncoding: encoding,
      htmlLen: buf.length,
    },
  };
}

/** 一般类站点的兜底提取（防守用） */
function extractCommonProducts($, pageUrl) {
  let cards = $(
    "div.product-layout, div.product-grid .product-thumb, div.product-thumb, .product-list .product-layout"
  );
  if (cards.length === 0) cards = $("div[class*='product']:has(a, img)");

  const out = [];
  cards.each((_, el) => {
    const root = $(el);
    const a = root.find("a[href]").first();
    if (!a.length) return;

    const imgEl = root.find("img").first();
    const title = (imgEl.attr("alt") || a.attr("title") || a.text() || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!title) return;

    out.push({
      sku: title,
      title,
      url: abs(pageUrl, a.attr("href") || ""),
      img: abs(pageUrl, imgEl.attr("src") || ""),
      price: "",
      currency: "",
      moq: "",
    });
  });
  return out;
}

/** GET/POST 共用 */
async function handleParse(req, res) {
  const src = req.method === "GET" ? req.query : req.body || {};
  const targetUrl = String(src.url || "").trim();
  const limit = Math.max(1, Number(src.limit || 50) || 50);
  const imgOpt = String(src.img || "");
  const imgCount = Math.max(0, Number(src.imgCount || 5) || 5);
  const needDebug = String(src.debug || "") !== "";

  if (!targetUrl) return res.status(400).json({ ok: false, error: "missing url" });

  // 1) 抓取 + 解码
  let html, encoding, fetchDbg;
  try {
    const r = await fetchHtmlSmart(targetUrl);
    html = r.html;
    encoding = r.encoding;
    fetchDbg = r.debug;
  } catch (e) {
    return res.status(502).json({ ok: false, error: "fetch failed", detail: String(e.message || e) });
  }

  // 2) 解析
  const $ = cheerio.load(html, { decodeEntities: false });
  const host = new NodeURL(targetUrl).hostname.toLowerCase();

  let items = [];
  let adapterDebug = null;

  if (/sinotronic/i.test(host)) {
    // —— 关键修正：调用命名导出的 parse(url, opts) —— //
    const r = await sinotronic.parse(targetUrl, { limit, debug: needDebug });
    if (Array.isArray(r)) {
      items = r;
    } else if (r && Array.isArray(r.items)) {
      items = r.items;
      adapterDebug = r.debug || null;
    }
  } else {
    items = extractCommonProducts($, targetUrl);
  }

  if (items.length > limit) items = items.slice(0, limit);

  // 3) 可选把前 N 张图片转 base64
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

  // 4) 输出（debug 透传）
  const base = {
    ok: true,
    url: targetUrl,
    count: items.length,
    items,
    products: items,
  };
  if (needDebug) {
    base.debug = {
      ...fetchDbg,
      title: $("title").text(),
      a: $("a").length,
      img: $("img").length,
      li: $("li").length,
      ...(adapterDebug ? { ...adapterDebug } : {}),
      list_found: items.length > 0,
      item_count: items.length,
      first_item: items[0] || null,
      head_sample: html.slice(0, 800),
      encoding,
    };
  }

  res.json(base);
}

router.get("/v1/api/catalog/parse", handleParse);
router.post("/v1/api/catalog/parse", handleParse);

export default router;
