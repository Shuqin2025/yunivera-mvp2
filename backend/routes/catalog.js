// backend/routes/catalog.js
// 统一目录解析：GET/POST /v1/api/catalog/parse
// - axios(arraybuffer) + jschardet + iconv-lite：自动探测，gb* → gb18030 兜底
// - 内置站点适配（sinotronic-e），失败则走通用兜底
// - debug=1 时回传完整 debug 信息，便于排查

import { Router } from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import jschardet from "jschardet";
import iconv from "iconv-lite";

// 站点适配器
import sinotronic from "../adapters/sinotronic.js";

const router = Router();

// ---------- 通用兜底选择器 ----------
const CONTAINER_FALLBACK = [
  "#productlist",     // 你们确认的容器
  ".productlist",
  ".listBox",
  ".products",
  ".product-list",
  "main",
  "body",
];

const ITEM_FALLBACK = [
  "#productlist ul > li", // 你们确认的条目
  "ul.products > li",
  "ul > li",
  ".product",
  ".product-item",
  ".productItem",
  ".product-box",
  "li",
];

// ---------- 拉取并解码 HTML ----------
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
  let encGuess = (jschardet.detect(buf)?.encoding || "").toLowerCase();

  // gb 系列一律用 gb18030 最稳妥；没有就用 utf-8
  const useEnc =
    !encGuess || encGuess === "ascii"
      ? "utf-8"
      : encGuess.includes("gb")
      ? "gb18030"
      : iconv.encodingExists(encGuess)
      ? encGuess
      : "utf-8";

  const html = iconv.decode(buf, useEnc);

  const debugFetch =
    wantDebug ? { http_status: res.status, detected_encoding: useEnc } : undefined;

  return { html, status: res.status, detected_encoding: useEnc, debugFetch };
}

// ---------- 通用兜底提取 ----------
function genericExtract($, baseUrl, { limit = 50, debug = false } = {}) {
  const tried = { container: [], item: [] };

  // 1) 容器
  let $container = $();
  let usedContainer = "";
  for (const sel of CONTAINER_FALLBACK) {
    tried.container.push(sel);
    const hit = $(sel);
    if (hit.length) {
      $container = hit.first();
      usedContainer = sel;
      break;
    }
  }
  if (!$container.length) {
    $container = $("body");
    usedContainer = "body";
  }

  // 2) 条目（优先容器内相对选择器，再全局兜底）
  let $items = $();
  let itemSelectorUsed = "";
  for (const sel of ITEM_FALLBACK) {
    let list = sel.startsWith("#") ? $(sel) : $container.find(sel);
    if (!list.length) list = $(sel);
    tried.item.push(sel);
    if (list.length) {
      $items = list;
      itemSelectorUsed = sel;
      break;
    }
  }
  if (!$items.length) {
    tried.item.push("li");
    $items = $container.find("li");
    itemSelectorUsed = "li";
  }

  const absolutize = (href) => {
    if (!href) return "";
    try {
      return new URL(href, baseUrl).href;
    } catch {
      return href;
    }
  };

  const items = [];
  $items.each((i, el) => {
    if (items.length >= limit) return false;
    const $el = $(el);

    const $a = $el.find("a[href]").first();
    const link = absolutize($a.attr("href"));

    const imgRel =
      $el.find("img[src]").attr("src") ||
      $el.find("img[data-src]").attr("data-src") ||
      $el.find("img[data-original]").attr("data-original") ||
      "";
    const img = absolutize(imgRel);

    let title =
      ($el.find("img").attr("alt") || "").trim() ||
      $el.find("h1,h2,h3,h4,h5,h6").first().text().trim() ||
      ($a.text() || "").trim() ||
      $el.text().trim();

    title = title.replace(/\s+/g, " ").trim();
    const sku = title;

    if (title || link || img) {
      items.push({
        sku,
        desc: title,
        minQty: "",
        price: "",
        img,
        link,
      });
    }
  });

  const debugPart = debug
    ? {
        tried,
        container_matched: usedContainer,
        item_selector_used: itemSelectorUsed,
        item_count: $items.length,
        first_item_html: $items.first().html() || null,
      }
    : undefined;

  return { items, debugPart };
}

// ---------- 运行解析（适配器优先，其次兜底） ----------
function runExtract(url, html, { limit = 50, debug = false } = {}) {
  const $ = cheerio.load(html, { decodeEntities: false });

  let used = "generic";
  let items = [];
  let debugPart;

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

// ---------- 路由 ----------
router.all("/parse", async (req, res) => {
  try {
    const isGet = req.method === "GET";
    const url = (isGet ? req.query.url : req.body?.url) || "";

    if (!url) {
      return res.status(400).json({ ok: false, error: "missing url" });
    }

    const limitRaw = (isGet ? req.query.limit : req.body?.limit) ?? 50;
    const limit = Math.max(0, parseInt(limitRaw, 10) || 50);

    const imgMode = String(isGet ? req.query.img : req.body?.img || "").toLowerCase(); // "base64" | ""
    const imgCount = Math.max(
      0,
      parseInt(isGet ? req.query.imgCount : req.body?.imgCount, 10) || 0
    );

    const debugRaw = isGet ? req.query.debug : req.body?.debug;
    const debug =
      debugRaw === 1 ||
      debugRaw === "1" ||
      String(debugRaw).toLowerCase() === "true";

    // 抓取 & 解码
    const { html, status, detected_encoding, debugFetch } = await fetchHtml(
      url,
      debug
    );
    if (!html || status >= 400) {
      const payload = { ok: false, url, status, error: "fetch failed" };
      if (debug) payload.debug = { ...(debugFetch || {}), step: "fetch" };
      return res.status(200).json(payload);
    }

    // 解析
    const { items, adapter_used, debugPart } = runExtract(url, html, {
      limit,
      debug,
    });

    // 可选：前 N 张图转 base64
    if (imgMode === "base64" && items.length && imgCount > 0) {
      const N = Math.min(imgCount, items.length);
      await Promise.all(
        items.slice(0, N).map(async (it) => {
          if (!it.img) return;
          try {
            const r = await axios.get(it.img, { responseType: "arraybuffer" });
            const ext = (it.img.split(".").pop() || "jpg").toLowerCase();
            it.img = `data:image/${ext};base64,${Buffer.from(r.data).toString(
              "base64"
            )}`;
          } catch {
            // ignore
          }
        })
      );
    }

    const resp = {
      ok: true,
      url,
      count: items.length,
      products: [],
      items,
    };

    if (debug) {
      resp.debug = {
        ...(debugFetch || {}),
        ...(debugPart || {}),
        adapter_used,
      };
    }

    return res.json(resp);
  } catch (err) {
    return res
      .status(200)
      .json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
});

export default router;
