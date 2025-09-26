// backend/routes/catalog.js
// 统一目录解析：GET/POST /v1/api/catalog/parse
// - axios(arraybuffer) + jschardet + iconv-lite 自动探测与解码（gb* → gb18030）
// - 命中站点适配器（sinotronic）否则走通用兜底
// - debug=1 时回传完整调试信息

import { Router } from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import jschardet from "jschardet";
import iconv from "iconv-lite";

// 站点适配器
import sinotronic from "../adapters/sinotronic.js";

const router = Router();

// ---------------- 通用兜底选择器 ----------------
const CONTAINER_FALLBACK = [
  "#productlist", ".productlist", ".listBox", ".products", ".product-list",
  "main", "body",
];

const ITEM_FALLBACK = [
  "#productlist ul > li", "ul.products > li", "ul > li",
  ".product", ".product-item", ".productItem", ".product-box", "li",
];

// ---------------- 抓取并解码 HTML ----------------
async function fetchHtml(url, wantDebug) {
  const res = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 20000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
    validateStatus: () => true,
  });

  const buf = Buffer.from(res.data);
  const guess = (jschardet.detect(buf)?.encoding || "").toLowerCase();
  const useEnc =
    !guess || guess === "ascii" ? "utf-8"
      : guess.includes("gb") ? "gb18030"
      : iconv.encodingExists(guess) ? guess : "utf-8";

  const html = iconv.decode(buf, useEnc);

  const debugFetch = wantDebug
    ? { http_status: res.status, detected_encoding: useEnc }
    : undefined;

  return { html, status: res.status, detected_encoding: useEnc, debugFetch };
}

// ---------------- 通用兜底抽取 ----------------
function genericExtract($, baseUrl, { limit = 50, debug = false } = {}) {
  const tried = { container: [], item: [] };

  // 1) 容器
  let $container = $(), usedContainer = "";
  for (const sel of CONTAINER_FALLBACK) {
    tried.container.push(sel);
    const hit = $(sel);
    if (hit.length) { $container = hit.first(); usedContainer = sel; break; }
  }
  if (!$container.length) { $container = $("body"); usedContainer = "body"; }

  // 2) 条目：容器内相对优先，失败再全局兜底
  let $items = $(), itemSelectorUsed = "";
  for (const sel of ITEM_FALLBACK) {
    let list = sel.startsWith("#") ? $(sel) : $container.find(sel);
    if (!list.length) list = $(sel);
    tried.item.push(sel);
    if (list.length) { $items = list; itemSelectorUsed = sel; break; }
  }
  if (!$items.length) { tried.item.push("li"); $items = $container.find("li"); itemSelectorUsed = "li"; }

  const absolutize = (href) => {
    if (!href) return "";
    try { return new URL(href, baseUrl).href; } catch { return href; }
  };

  const items = [];
  $items.each((_, el) => {
    if (items.length >= limit) return false;
    const $el = $(el);

    const $a = $el.find("a[href]").first();
    const link = absolutize($a.attr("href"));

    const imgRel =
      $el.find("img[src]").attr("src") ||
      $el.find("img[data-src]").attr("data-src") ||
      $el.find("img[data-original]").attr("data-original") || "";
    const img = absolutize(imgRel);

    let title =
      ($el.find("img").attr("alt") || "").trim() ||
      $el.find("h1,h2,h3,h4,h5,h6").first().text().trim() ||
      ($a.text() || "").trim() ||
      $el.text().trim();

    title = title.replace(/\s+/g, " ").trim();
    if (!title && !img && !link) return;

    items.push({ sku: title, desc: title, minQty: "", price: "", img, link });
  });

  const debugPart = debug ? {
    tried,
    container_matched: usedContainer,
    item_selector_used: itemSelectorUsed,
    item_count: $items.length,
    first_item_html: $items.first().html() || null,
  } : undefined;

  return { items, debugPart };
}

// ---------------- 跑适配器/兜底 ----------------
function runExtract(url, html, { limit = 50, debug = false } = {}) {
  const $ = cheerio.load(html, { decodeEntities: false });

  let used = "generic", items = [], debugPart;

  if (sinotronic.test(url)) {
    const out = sinotronic.parse($, url, { limit, debug });
    items = out.items || [];
    if (debug) debugPart = out.debugPart;
    used = "sinotronic-e";
  }

  if (!items.length) {
    const out = genericExtract($, url, { limit, debug });
    items = out.items || [];
    if (debug && !debugPart) debugPart = out.debugPart;
    used = "generic";
  }

  return { items, adapter_used: used, debugPart };
}

// ---------------- 路由 ----------------
router.all("/parse", async (req, res) => {
  try {
    const isGet = req.method === "GET";
    const qp = isGet ? req.query : req.body || {};

    const url = String(qp.url || "").trim();
    if (!url) return res.status(400).json({ ok: false, error: "missing url" });

    const limit = Math.max(1, parseInt(qp.limit ?? 50, 10) || 50);

    const imgMode = String(qp.img || "").toLowerCase();     // "base64" | ""
    const imgCount = Math.max(0, parseInt(qp.imgCount ?? 0, 10) || 0);

    const rawDebug = qp.debug ?? qp.debug1 ?? qp.debug_1;
    const wantDebug = ["1","true","yes","on"].includes(String(rawDebug ?? "").toLowerCase());

    // 1) 抓取 + 解码
    const { html, status, detected_encoding, debugFetch } = await fetchHtml(url, wantDebug);
    if (!html || status >= 400) {
      const payload = { ok: false, url, status, error: "fetch failed" };
      if (wantDebug) payload.debug = { ...(debugFetch || {}), step: "fetch" };
      return res.status(200).json(payload);
    }

    // 2) 解析
    const { items, adapter_used, debugPart } = runExtract(url, html, { limit, debug: wantDebug });

    // 3) 可选：前 N 张图转 base64（不影响主逻辑）
    if (imgMode === "base64" && items.length && imgCount > 0) {
      const N = Math.min(imgCount, items.length);
      await Promise.all(items.slice(0, N).map(async it => {
        if (!it.img) return;
        try {
          const r = await axios.get(it.img, { responseType: "arraybuffer" });
          const ext = (it.img.split(".").pop() || "jpg").toLowerCase();
          it.img = `data:image/${ext};base64,${Buffer.from(r.data).toString("base64")}`;
        } catch {}
      }));
    }

    const resp = { ok: true, url, count: items.length, products: [], items };
    if (wantDebug) resp.debug = { ...(debugFetch || {}), ...(debugPart || {}), adapter_used };
    return res.json(resp);
  } catch (err) {
    return res.status(200).json({ ok: false, error: String(err?.message || err) });
  }
});

export default router;
