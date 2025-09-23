// backend/routes/catalog.js
import express from "express";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import jschardet from "jschardet";
import { URL as NodeURL } from "url";

// 你的适配器（ESM 默认导出）
import sinotronic from "../adapters/sinotronic.js";

const router = express.Router();

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

/** 智能获取文本：自动处理非 UTF-8 页面（gbk/gb2312 等） */
async function fetchHtmlSmart(pageUrl) {
  const res = await fetch(pageUrl, {
    redirect: "follow",
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Cache-Control": "no-cache",
    },
  });

  if (!res.ok) {
    throw new Error(`fetch ${pageUrl} failed: ${res.status} ${res.statusText}`);
  }

  // node-fetch@3：arrayBuffer
  const buf = Buffer.from(await res.arrayBuffer());

  // 1) Content-Type 里的 charset
  const ctype = res.headers.get("content-type") || "";
  const m = ctype.match(/charset=([^;]+)/i);
  let enc = m && m[1] ? m[1].trim() : "";

  // 2) 没有就自动探测
  if (!enc) {
    const det = jschardet.detect(buf);
    if (det && det.encoding) enc = det.encoding;
  }

  // 3) 兜底 utf-8
  if (!enc) enc = "utf-8";

  try {
    return iconv.decode(buf, enc);
  } catch {
    return buf.toString("utf-8");
  }
}

/** 可选：把图片转 base64（只处理前 N 条，避免过慢） */
async function embedImagesBase64(items, maxCount = 5) {
  const tasks = items.slice(0, maxCount).map(async (it) => {
    if (!it.img) return;
    try {
      const r = await fetch(it.img, { headers: { "User-Agent": UA } });
      if (!r.ok) return;
      const buf = Buffer.from(await r.arrayBuffer());
      const mime = r.headers.get("content-type") || "image/jpeg";
      it.img_b64 = `data:${mime};base64,${buf.toString("base64")}`;
    } catch {
      // 单个失败忽略
    }
  });
  await Promise.allSettled(tasks);
}

/** 统一的解析处理（GET 旧风格 & POST 新风格都会走它） */
async function handleParse(req, res) {
  const isGet = req.method === "GET";
  const url = (isGet ? req.query.url : req.body?.url) || "";
  const limitRaw = (isGet ? req.query.limit : req.body?.limit) ?? 50;
  const imgOpt = (isGet ? req.query.img : req.body?.img) || "";
  const imgCountRaw = (isGet ? req.query.imgCount : req.body?.imgCount) ?? 5;

  const limit = Math.max(1, Number(limitRaw) || 50);
  const imgCount = Math.max(0, Number(imgCountRaw) || 5);

  if (!url) {
    return res.status(400).json({ ok: false, error: "missing url" });
  }

  let html;
  try {
    html = await fetchHtmlSmart(url);
  } catch (e) {
    return res
      .status(502)
      .json({ ok: false, error: "fetch failed", detail: String(e.message) });
  }

  const $ = cheerio.load(html, { decodeEntities: false });
  const host = (() => {
    try {
      return new NodeURL(url).hostname || "";
    } catch {
      return "";
    }
  })();

  // 根据域名选择适配器
  let items = [];
  if (/sinotronic/i.test(host)) {
    // 你的 sinotronic 适配器：函数签名 parse($, { url, limit })
    items = await sinotronic($, { url, limit });
  } else {
    // 其它站点：你可以在这里继续分发到不同适配器
    items = [];
  }

  // 可选：图片转 base64
  if ((imgOpt || "").toLowerCase() === "base64" && items.length) {
    await embedImagesBase64(items, imgCount);
  }

  return res.json({ ok: true, items });
}

// 新风格：POST
router.post("/v1/api/catalog/parse", handleParse);

// 旧前端风格：GET（自动走同一个处理器）
router.get("/v1/api/catalog/parse", handleParse);

export default router;
