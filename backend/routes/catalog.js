// backend/routes/catalog.js
import express from "express";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import jschardet from "jschardet";
import { URL as NodeURL } from "url";

import sinotronic from "../adapters/sinotronic.js";

const router = express.Router();

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

// --------- utils ----------
function abs(base, href) {
  try {
    return new NodeURL(href || "", base).toString();
  } catch {
    return href || "";
  }
}
function norm(t = "") {
  return String(t).replace(/\s+/g, " ").replace(/[\r\n\t]/g, " ").trim();
}
function looksNav(t = "") {
  const x = t.toLowerCase();
  return (
    !x ||
    x === "#" ||
    /^javascript:/i.test(x) ||
    /(首页|尾页|上一页|下一页|more|zurück|weiter|page)/i.test(x)
  );
}

async function fetchHtmlSmart(pageUrl) {
  const r = await fetch(pageUrl, {
    redirect: "follow",
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Cache-Control": "no-cache",
    },
  });
  if (!r.ok) throw new Error(`fetch ${pageUrl} failed: ${r.status} ${r.statusText}`);
  const buf = Buffer.from(await r.arrayBuffer());
  let enc = "";
  const ct = r.headers.get("content-type") || "";
  const m = ct.match(/charset=([^;]+)/i);
  if (m && m[1]) enc = m[1].trim();
  if (!enc) {
    const det = jschardet.detect(buf);
    if (det?.encoding) enc = det.encoding;
  }
  if (!enc) enc = "utf-8";
  try {
    return iconv.decode(buf, enc);
  } catch {
    return buf.toString("utf-8");
  }
}

// 通用兜底：永不空军
function universalExtract($, base, limit = 50) {
  const out = [];

  // 先从 li / tr 容器里抓
  $("li, tr").each((_, el) => {
    if (out.length >= limit) return false;
    const $el = $(el);
    const $a = $el.find("a[href]").first();
    const href = ($a.attr("href") || "").trim();
    if (!href || looksNav(href)) return;
    const text =
      norm($a.attr("title")) ||
      norm($a.text()) ||
      norm($el.text());
    const title = norm(text);
    if (!title || looksNav(title)) return;
    out.push({
      sku: title,
      desc: title,
      url: abs(base, href),
      img: "",
      price: "",
      currency: "",
      moq: "",
    });
  });

  // 还是 0，再全页 a[href]
  if (out.length === 0) {
    $("a[href]").each((_, el) => {
      if (out.length >= limit) return false;
      const $a = $(el);
      const href = ($a.attr("href") || "").trim();
      if (!href || /^(javascript:|#)/i.test(href)) return;
      const title = norm($a.text()) || norm($a.attr("title"));
      if (!title || looksNav(title)) return;
      out.push({
        sku: title,
        desc: title,
        url: abs(base, href),
        img: "",
        price: "",
        currency: "",
        moq: "",
      });
    });
  }

  return out.slice(0, limit);
}

// 探针：统计命中情况
function buildProbe($) {
  const defs = {
    "ul>li a": $("ul li a").length,
    ".list li a": $(".list li a").length,
    ".prolist li a": $(".prolist li a").length,
    "table tr a": $("table tr a").length,
    "all a[href]": $("a[href]").length,
  };
  const samples = [];
  $("a[href]").slice(0, 10).each((_, a) => {
    const $a = $(a);
    samples.push({
      text: norm($a.text()),
      href: $a.attr("href"),
      title: norm($a.attr("title") || ""),
    });
  });
  return { defs, samples };
}

async function handleParse(req, res) {
  const isGet = req.method === "GET";
  const url = (isGet ? req.query.url : req.body?.url) || "";
  const limit = Math.max(1, Number(isGet ? req.query.limit : req.body?.limit) || 50);
  const imgOpt = (isGet ? req.query.img : req.body?.img) || "";
  const imgCount = Math.max(0, Number(isGet ? req.query.imgCount : req.body?.imgCount) || 5);
  const debug = (isGet ? req.query.debug : req.body?.debug) ? true : false;

  if (!url) return res.status(400).json({ ok: false, error: "missing url" });

  let html;
  try {
    html = await fetchHtmlSmart(url);
  } catch (e) {
    return res.status(502).json({ ok: false, error: "fetch failed", detail: String(e.message) });
  }

  const $ = cheerio.load(html, { decodeEntities: false });
  const host = (() => { try { return new NodeURL(url).hostname || ""; } catch { return ""; } })();

  let items = [];
  if (/sinotronic/i.test(host)) {
    items = await sinotronic($, { url, limit });
  }

  // 兜底
  if (!items || items.length === 0) {
    items = universalExtract($, url, limit);
  }

  const payload = { ok: true, items };

  if (debug) {
    payload.probe = buildProbe($);
    payload.meta = {
      host,
      htmlLength: html.length,
      gotItems: items.length,
    };
  }

  return res.json(payload);
}

router.post("/v1/api/catalog/parse", handleParse);
router.get("/v1/api/catalog/parse", handleParse);

export default router;
