// backend/routes/catalog.js
// 统一：GET/POST /v1/api/catalog/parse
// 关键点：gb18030 解码、兜底选择器、把 debug 透传出来；优先命中 sinotronic 适配器

import express from "express";
import axios from "axios";
import { load as cheerioLoad } from "cheerio";
import jschardet from "jschardet";
import iconv from "iconv-lite";
import parseSinotronic from "../adapters/sinotronic.js";

// —— 工具 —— //
const toAbs = (u, base) => { try { return new URL(u, base).href; } catch { return u || ""; } };
const pickAttr = ($el, list) => { for (const k of list) { const v = $el.attr(k); if (v) return v; } return ""; };
const decodeBuffer = (buf) => {
  const head = buf.subarray(0, Math.min(buf.length, 2048));
  const guess = jschardet.detect(head)?.encoding || "";
  const enc = /gb/i.test(guess) ? "gb18030" : "utf-8";
  const html = iconv.decode(buf, enc);
  return { html, encoding: enc, guess };
};

// —— 兜底选择器（含 #productlist） —— //
const CONTAINER_CANDIDATES = [
  "#productlist", ".productlist", ".products-list", ".products",
  ".list-products", "ul.products", "#products", "main .list", "main ul",
];
const ITEM_CANDIDATES = [
  "#productlist ul > li", "li.product", ".product", ".product-item",
  "ul.products > li", ".items > li", "li",
];

// —— 抽取条目 —— //
function extractItems($, base, $items, limit, debug) {
  const items = [];
  $items.each((_, el) => {
    if (items.length >= limit) return;
    const $li = $(el);

    const $img = $li.find("img").first();
    const imgRel = pickAttr($img, ["src", "data-src", "data-original"]);
    const img = toAbs(imgRel, base);

    const $a = $li.find("a").first();
    const link = toAbs($a.attr("href") || "", base);

    const title =
      ($img.attr("alt") || "").trim() ||
      ($a.text() || "").trim() ||
      ($li.text() || "").trim();

    if (!title && !link && !img) return;

    items.push({ sku: title, desc: title, minQty: "", price: "", img, link });

    if (items.length === 1 && debug) {
      debug.first_item_html = $.html($li);
    }
  });
  return items;
}

const router = express.Router();

// 兼容 GET/POST
router.get("/parse", handler);
router.post("/parse", handler);

async function handler(req, res) {
  try {
    const isPost = req.method === "POST";
    const qp = isPost ? (req.body || {}) : (req.query || {});

    const url        = (qp.url || "").trim();
    const limit      = Math.max(1, Math.min(+(qp.limit || 50), 200));
    const wantBase64 = (qp.img || "").toString().toLowerCase() === "base64";
    const imgCount   = +(qp.imgCount || 0);
    const rawDebug   = qp.debug ?? qp.debug1 ?? qp.debug_1;
    const wantDebug  = ["1", "true", "yes", "on"].includes(String(rawDebug ?? "").toLowerCase());

    if (!url) return res.json({ ok: false, error: "missing url" });

    // —— 先看是否命中 sinotronic 专用适配器 —— //
    let host = "";
    try { host = new URL(url).hostname || ""; } catch {}
    if (host.includes("sinotronic-e.com")) {
      const payload = await parseSinotronic(url, { limit, img: qp.img, imgCount, debug: wantDebug ? "1" : "" });
      return res.json(payload);
    }

    // —— 通用解析（作为兜底） —— //
    const resp = await axios.get(url, {
      responseType: "arraybuffer",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    const { html, encoding, guess } = decodeBuffer(Buffer.from(resp.data));
    const $ = cheerioLoad(html, { decodeEntities: false });

    const debug = wantDebug
      ? { tried: { container: [], item: [] }, detected_encoding: encoding, charset_guess: guess || "" }
      : null;

    // 选容器
    let $container = null, containerUsed = "", maxCount = -1;
    for (const sel of CONTAINER_CANDIDATES) {
      const cnt = $(sel).length;
      if (wantDebug) debug.tried.container.push({ selector: sel, matched: cnt });
      if (cnt > 0 && cnt > maxCount) { maxCount = cnt; $container = $(sel).first(); containerUsed = sel; }
    }
    if (!$container || $container.length === 0) { $container = $("body"); containerUsed = "body"; }

    // 选条目
    let itemUsed = "";
    let $items = $();
    for (const sel of ITEM_CANDIDATES) {
      const list = $container.find(sel);
      const cnt = list.length;
      if (wantDebug) debug.tried.item.push({ selector: sel, matched: cnt });
      if (cnt > 0) { itemUsed = sel; $items = list; break; }
    }
    if ($items.length === 0) {
      for (const sel of ITEM_CANDIDATES) {
        const list = $(sel);
        const cnt = list.length;
        if (wantDebug) debug.tried.item.push({ selector: sel, matched: cnt });
        if (cnt > 0) { itemUsed = sel + " (global)"; $items = list; break; }
      }
    }
    if (wantDebug) {
      debug.container_matched = containerUsed;
      debug.item_selector_used = itemUsed;
      debug.item_count = $items.length || 0;
    }

    // 抽取
    const origin = new URL(url).origin + "/";
    let items = extractItems($, origin, $items, limit, debug);

    // 再兜底一次 #productlist
    if (items.length === 0) {
      const fallbackList = $("#productlist ul > li");
      if (fallbackList.length) {
        if (wantDebug && !itemUsed) {
          debug.item_selector_used = "#productlist ul > li (fallback)";
          debug.item_count = fallbackList.length;
        }
        items = extractItems($, origin, fallbackList, limit, debug);
      }
    }

    // 可选：转 base64
    if (wantBase64 && items.length && imgCount > 0) {
      const N = Math.min(imgCount, items.length);
      await Promise.all(
        items.slice(0, N).map(async (it) => {
          if (!it.img) return;
          try {
            const r = await axios.get(it.img, { responseType: "arraybuffer" });
            const b64 = Buffer.from(r.data).toString("base64");
            const ext = (it.img.split(".").pop() || "jpg").toLowerCase();
            it.img = `data:image/${ext};base64,${b64}`;
          } catch { /* ignore */ }
        })
      );
    }

    const payload = { ok: true, url, count: items.length, products: [], items };
    if (wantDebug) payload.debug = debug;
    res.json(payload);

  } catch (err) {
    res.status(200).json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

export default router;
