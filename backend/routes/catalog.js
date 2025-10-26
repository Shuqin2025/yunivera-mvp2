// backend/routes/catalog.js
// 统一目录解析：GET/POST /v1/catalog /v1/api/catalog (/parse)
// - axios(arraybuffer) + jschardet + iconv-lite 自动探测与解码
// - 命中站点适配器（sinotronic / memoryking / templateParser / universal），否则走通用兜底
// - debug=1 时回传完整调试信息
// - useBrowser=1 时优先用 Playwright + templateParser.parseCatalog 抓“渲染后 DOM”

import { Router } from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import jschardet from "jschardet";
import iconv from "iconv-lite";
import fs from "node:fs";
import path from "node:path";

import sinotronic from "../adapters/sinotronic.js";
import memoryking from "../adapters/memoryking.js";

// 模板解析中枢 + 通用适配器
import { detectStructure } from "../lib/structureDetector.js";
import templateParser from "../lib/templateParser.js";
import universal from "../adapters/universal.js";

import logger from "../lib/logger.js";
import snapshot from "../lib/debugSnapshot.js";

import { decideFetchStrategy, fetchHtml as fetchHtmlAdaptive } from "../modules/adaptiveCrawler.js";
import { classify } from "../modules/templateCluster.js";
import * as errorCollector from "../modules/errorCollector.js";

// --------------------------------------------------
// fetchHtml helpers
// --------------------------------------------------

const UA_DESKTOP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

async function fetchHtmlBasic(url, wantDebug) {
  const res = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 20000,
    headers: {
      "User-Agent": UA_DESKTOP,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
    validateStatus: () => true,
  });

  const buf = Buffer.from(res.data);
  const guess = (jschardet.detect(buf)?.encoding || "").toLowerCase();
  const useEnc =
    !guess || guess === "ascii"
      ? "utf-8"
      : guess.includes("gb")
      ? "gb18030"
      : iconv.encodingExists(guess)
      ? guess
      : "utf-8";

  const html = iconv.decode(buf, useEnc);
  const debugFetch = wantDebug
    ? { http_status: res.status, detected_encoding: useEnc }
    : undefined;

  return { html, status: res.status, detected_encoding: useEnc, debugFetch };
}

// 高级：先 adaptiveCrawler -> fallback axios/iconv
async function ensureFetchHtml(url, wantDebug, hintType = "") {
  try {
    const strat = decideFetchStrategy({ url, hintType });
    const fetched = await fetchHtmlAdaptive({ url, strategy: strat });
    if (fetched?.html) {
      return {
        html: fetched.html,
        debugFetch: wantDebug
          ? { used: fetched.used, http_status: fetched.status }
          : undefined,
      };
    }
  } catch {
    /* ignore */
  }

  const r = await fetchHtmlBasic(url, wantDebug);
  return { html: r.html, debugFetch: r.debugFetch };
}

// --------------------------------------------------
// helpers / dbg
// --------------------------------------------------

const __dbgR = (tag, data) => {
  try {
    if (process?.env?.DEBUG) {
      const msg = typeof data === "string" ? data : JSON.stringify(data);
      console.log(`[route] ${tag} ${msg}`);
    }
  } catch {}
};

async function __snap(tag, data) {
  try {
    if (typeof snapshot === "function") {
      await snapshot(tag, data || {});
    }
  } catch {}
}

// --------------------------------------------------
// optional Playwright
// --------------------------------------------------

let chromium = null;
try {
  ({ chromium } = await import("playwright"));
} catch {}

// --------------------------------------------------
// metrics helper
// --------------------------------------------------

function computeFieldsRate(list) {
  const keys = ["title", "url", "img", "price", "sku", "desc"];
  const n = Array.isArray(list) ? list.length : 0;
  const out = {};
  for (const k of keys) {
    out[k] = n
      ? list.filter((x) => x && String(x[k] || "").trim()).length / n
      : 0;
  }
  return out;
}

// --------------------------------------------------
// generic fallback extractor
// --------------------------------------------------

const CONTAINER_FALLBACK = [
  "#productlist",
  ".productlist",
  ".listBox",
  ".products",
  ".product-list",
  "main",
  "body",
];

const ITEM_FALLBACK = [
  "#productlist ul > li",
  "ul.products > li",
  "ul > li",
  ".product",
  ".product-item",
  ".productItem",
  ".product-box",
  "li",
];

const PATH_SKIP_PATTERNS = [
  /(^|\/)(hilfe|support|kontakt|impressum|agb|datenschutz|widerruf|versand|zahlung|news|blog)(\/|$)/i,
  /(^|\/)(login|logout|register|anmelden|abmelden|konto|account|mein-konto|profile)(\/|$)/i,
  /(^|\/)(warenkorb|cart|checkout|order|bestellung|newsletter|sitemap|search|suche|note)(\/|$)/i,
  /(^|\/)(faq|privacy|terms|shipping|payment|returns|refund|about|ueber-uns)(\/|$)/i,
];

const TITLE_SKIP_PATTERNS = [
  /\b(impressum|agb|kontakt|datenschutz|hilfe|support|widerruf|versand|zahlung)\b/i,
  /\b(login|logout|register|anmelden|abmelden|account|konto|newsletter|sitemap|search|suche)\b/i,
  /\b(cart|checkout|warenkorb|order|bestellung|faq|privacy|terms|about)\b/i,
];

const SKIP_WORDS = [
  "login","anmelden","register","konto","account","mein konto","my account","logout",
  "cart","warenkorb","basket","wishlist","wunschliste","agb","impressum","datenschutz",
  "privacy","policy","hilfe","support","kontakt","newsletter","blog","news","service",
  "faq","payment","shipping","versand","returns","widerruf","revocation","cookie","sitemap",
];

function isSiteLink(link = "", title = "") {
  try {
    const u = new URL(link, "http://_/"); // dummy base
    const p = (u.pathname || "").toLowerCase();
    if (PATH_SKIP_PATTERNS.some((re) => re.test(p))) return true;
    if (SKIP_WORDS.some((w) => p.includes(w))) return true;
  } catch {}
  const t = (title || "").toLowerCase();
  if (TITLE_SKIP_PATTERNS.some((re) => re.test(t))) return true;
  if (SKIP_WORDS.some((w) => t.includes(w))) return true;
  return false;
}

function genericExtract($, baseUrl, { limit = 50, debug = false } = {}) {
  const tried = { container: [], item: [] };

  // 1) container
  let $container = $(), usedContainer = "";
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

  // 2) items
  let $items = $(), itemSelectorUsed = "";
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
  $items.each((_, el) => {
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
    if (!title && !img && !link) return;

    if (isSiteLink(link, title)) return;

    items.push({
      sku: title,
      desc: title,
      minQty: "",
      price: "",
      img,
      link,
    });
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

// --------------------------------------------------
// adapter decision helpers
// --------------------------------------------------

function chooseAdapter({ url, $, html, hintType, host }) {
  if (hintType) {
    const t = String(hintType).toLowerCase();
    if (
      t === "shopware" ||
      t === "woocommerce" ||
      t === "shopify" ||
      t === "magento"
    ) {
      return "template";
    }
    if (t === "memoryking") return "memoryking";
  }
  if (/(^|\. )memoryking\.de$/i.test(host)) return "memoryking";

  const det = detectStructure(html || $);
  if (det && det.type) {
    if (
      det.type === "Shopware" ||
      det.type === "WooCommerce" ||
      det.type === "Shopify" ||
      det.type === "Magento"
    ) {
      return "template";
    }
  }
  return "generic";
}

// unify templateParser export styles
function callTemplateParse(html, url, opts) {
  try {
    if (templateParser && typeof templateParser.parse === "function") {
      return templateParser.parse(loadHtml(html), url, opts);
    }
    if (typeof templateParser === "function") {
      return templateParser({ html, url, ...(opts || {}) });
    }
  } catch {}
  return Promise.resolve([]);
}

function getParseCatalog() {
  return templateParser && typeof templateParser.parseCatalog === "function"
    ? templateParser.parseCatalog
    : null;
}

function loadHtml(html) {
  return cheerio.load(html, { decodeEntities: false });
}

// 封装 universal，优先尝试“喂现成 html”
// 如果 universal 这个版本支持 (url, html, opts)，我们用它；
// 如果不支持，我们就直接跳过它，防止它自己触发 crawlPages。
async function callUniversalWithHtml(url, html, { limit, debug }) {
  try {
    // 猜 1：universal({ url, html, limit, debug })
    const u1 = await universal({ url, html, limit, debug });
    if (u1 && (Array.isArray(u1) || u1.items || u1.products)) return u1;
  } catch {}
  try {
    // 猜 2：universal(url, html, { limit, debug })
    const u2 = await universal(url, html, { limit, debug });
    if (u2 && (Array.isArray(u2) || u2.items || u2.products)) return u2;
  } catch {}

  // 最后尝试老签名 universal({ url, limit, debug })
  // 但我们担心它会继续 crawlPages -> fetchHtml is required
  // 所以为了安全，这里就不再 fallback 老签名了，直接返回空
  return null;
}

// --------------------------------------------------
// main extraction for cheerio-route
// --------------------------------------------------

async function runExtract(url, html, { limit = 50, debug = false, hintType = "" } = {}) {
  const $ = cheerio.load(html, { decodeEntities: false });

  let used = "generic";
  let items = [];
  let debugPart;

  // 0) sinotronic
  if (sinotronic.test && sinotronic.test(url)) {
    const out = sinotronic.parse($, url, { limit, debug });
    items = out.items || [];
    if (debug) debugPart = out.debugPart;
    used = "sinotronic-e";
  }

  // 1) choose adapter
  if (!items.length) {
    const host = (() => {
      try { return new URL(url).host; } catch { return ""; }
    })();
    const which = chooseAdapter({ url, $, html, hintType, host });

    if (which === "memoryking") {
      const out = memoryking.parse($, url, { limit, debug });
      let mmItems = Array.isArray(out) ? out : out.items || out.products || [];
      if (debug && !debugPart) debugPart = out?.debugPart;

      if (!mmItems || mmItems.length === 0) {
        // fallback template
        const tOut = await callTemplateParse(html, url, { limit, debug });
        mmItems = Array.isArray(tOut) ? tOut : tOut?.items || tOut?.products || [];

        if (!mmItems || mmItems.length === 0) {
          // fallback universal (safe wrapper)
          const u = await callUniversalWithHtml(url, html, { limit, debug });
          mmItems = Array.isArray(u) ? u : u?.items || u?.products || [];
          used = "universal-fallback";
        } else {
          used = "template-fallback";
        }
      } else {
        used = "memoryking";
      }
      items = mmItems || [];
    }
    else if (which === "template") {
      const tOut = await callTemplateParse(html, url, { limit, debug });
      items = Array.isArray(tOut) ? tOut : tOut?.items || tOut?.products || [];
      used = "template";

      if (!items || items.length === 0) {
        const u = await callUniversalWithHtml(url, html, { limit, debug });
        const cand = Array.isArray(u) ? u : u?.items || u?.products || [];
        if (cand && cand.length) {
          items = cand;
          used = "universal-fallback";
        }
      }
    }
    else if (which === "generic") {
      // try template anyway
      const tOut = await callTemplateParse(html, url, { limit, debug });
      let tmp = Array.isArray(tOut) ? tOut : tOut?.items || tOut?.products || [];
      if (tmp && tmp.length) {
        items = tmp;
        used = "template-try";
      }

      // still empty, try universal (safe)
      if (!items.length) {
        const u = await callUniversalWithHtml(url, html, { limit, debug });
        const cand = Array.isArray(u) ? u : u?.items || u?.products || [];
        if (cand && cand.length) {
          items = cand;
          used = "universal";
        }
      }
    }
  }

  // 2) genericExtract fallback
  if (!items.length) {
    const out = genericExtract($, url, { limit, debug });
    items = out.items || [];
    if (debug && !debugPart) debugPart = out.debugPart;
    used = "generic";
  }

  return { items, adapter_used: used, debugPart };
}

// --------------------------------------------------
// parseHandler (GET/POST)
// --------------------------------------------------

const router = Router();

const parseHandler = async (req, res) => {
  let hintType = "";

  try {
    const isGet = req.method === "GET";
    const qp = isGet ? req.query : req.body || {};

    __dbgR("parse.start", { url: qp?.url });
    const DEBUG_ENV =
      process.env.DEBUG === "1" ||
      process.env.DEBUG === "true";

    const url = String(qp.url || "").trim();
    logger.debug(`[route/catalog.parse] url=${url} size=${qp.size ?? ""}`);
    if (!url) {
      return res.status(400).json({ ok: false, error: "missing url" });
    }

    const limit = Math.max(1, parseInt(qp.limit ?? 50, 10) || 50);

    const imgMode = String(qp.img || "").toLowerCase(); // "base64" | ""
    const imgCount = Math.max(0, parseInt(qp.imgCount ?? 0, 10) || 0);

    const rawDebug = qp.debug ?? qp.debug1 ?? qp.debug_1;
    const wantDebug = ["1", "true", "yes", "on"].includes(
      String(rawDebug ?? "").toLowerCase()
    );

    // 前端 hint
    hintType = (qp.t || qp.type || "").toString();

    // 浏览器渲染
    const useBrowser = ["1", "true", "yes", "on"].includes(
      String(qp.useBrowser || qp.browser || "").toLowerCase()
    );

    await __snap("parse:enter", { url, limit, t: qp.t });
    DEBUG_ENV &&
      console.log("[struct]", "parse:start", { url, hintType, useBrowser });

    let items = [];
    let adapter_used = "";
    let html = "";
    let debugFetch = undefined;
    let debugPart = undefined;

    // ---- 路线 A：Playwright DOM 特殊解析
    if (useBrowser && chromium && getParseCatalog()) {
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({
        userAgent: UA_DESKTOP,
        viewport: { width: 1366, height: 900 },
      });

      try {
        const r = await getParseCatalog()(page, url, hintType || "");
        const browProducts =
          r && Array.isArray(r.products) ? r.products : [];
        if (browProducts.length) {
          items = browProducts.map((p) => ({
            sku:   p.sku || "",
            title: p.title || p.name || "",
            url:   p.url || p.link || "",
            link:  p.link || p.url || "",
            img:   p.image || p.img || (Array.isArray(p.imgs) ? p.imgs[0] : ""),
            price: p.price || "",
            currency: p.currency || "",
            moq:   p.moq || p.minQty || "",
            desc:  p.desc || p.description || "",
          }));
          adapter_used = hintType || "browser-dom";
        }
      } catch {
        /* ignore browser errors */
      }

      try { await page.close(); } catch {}
      try { await browser.close(); } catch {}
    }

    // ---- 路线 B：Cheerio 默认
    if (!items.length) {
      const ensured = await ensureFetchHtml(url, wantDebug, hintType);
      html = ensured.html;
      debugFetch = ensured.debugFetch;

      if (!html) {
        throw Object.assign(
          new Error("crawlPages: fetchHtml is required"),
          { code: "FETCH_EMPTY" }
        );
      }

      try {
        const preClass = classify(url, html);
        if (!hintType && preClass && preClass.adapterHint) {
          hintType = preClass.platform;
        }
        try { await snapshot("pre-classify", { url, preClass }); } catch {}
      } catch {}

      const ret = await runExtract(url, html, {
        limit,
        debug: wantDebug,
        hintType,
      });
      items = ret.items || [];
      adapter_used = ret.adapter_used || "auto";
      debugPart = ret.debugPart;

      await __snap("parse:adapter", {
        adapter: adapter_used,
        platform: hintType || undefined,
        type:
          (debugPart &&
            (debugPart.type ||
              debugPart.platform ||
              debugPart.adapter)) ||
          undefined,
      });
    }

    // ---- 图片转 base64（可选）
    if (imgMode === "base64" && items.length && imgCount > 0) {
      const N = Math.min(imgCount, items.length);
      await Promise.all(
        items.slice(0, N).map(async (it) => {
          if (!it.img) return;
          try {
            const r = await axios.get(it.img, { responseType: "arraybuffer" });
            const ext = (it.img.split(".").pop() || "jpg").toLowerCase();
            it.img = `data:image/${ext};base64,${Buffer.from(
              r.data
            ).toString("base64")}`;
          } catch {}
        })
      );
    }

    // ---- 输出结构
    const products = (items || []).map((it) => ({
      sku: it.sku || it.code || "",
      title: it.title || it.desc || "",
      url: it.url || it.link || "",
      link: it.link || it.url || "",
      img: it.img || (Array.isArray(it.imgs) ? it.imgs[0] : null),
      price: it.price || "",
      currency: it.currency || "",
      moq: it.moq || it.minQty || "",
      desc: it.desc || "",
    }));

    const count = products.length;
    const fieldsRate = computeFieldsRate(products || []);
    const wantMetrics = ["1", "true", "yes", "on"].includes(
      String(qp.metrics || "").toLowerCase()
    );
    const wantSnapshot = ["1", "true", "yes", "on"].includes(
      String(qp.snapshot || qp.debug || "").toLowerCase()
    );

    try {
      const sample =
        (products &&
          products[0] &&
          (products[0].url || products[0].link)) ||
        null;
      logger.debug(
        "[route]",
        "adapter=",
        adapter_used,
        "count=",
        products.length,
        "url=",
        url,
        "sample=",
        sample
      );
    } catch {}

    const resp = {
      ok: true,
      url,
      count,
      products,
      items,
      adapter: adapter_used,
    };

    if (wantDebug) {
      resp.debug = {
        ...(debugFetch || {}),
        ...(debugPart || {}),
        adapter_used,
        hintType,
        useBrowser: !!(useBrowser && chromium && getParseCatalog()),
      };
    }
    if (wantMetrics) {
      resp.fieldsRate = fieldsRate;
    }

    logger.debug(
      `[route/catalog.parse] done url=${url} adapter=${resp?.adapter} count=${resp?.products?.length ?? 0}`
    );

    __dbgR("parse.done", {
      url: qp?.url,
      adapter: resp?.adapter,
      count: resp?.products?.length,
    });
    if ((resp?.products?.length || 0) === 0) {
      __dbgR("parse.empty", {
        url: qp?.url,
        note: "NoProductFound after adapter run",
      });
    }

    return res.json(resp);
  } catch (err) {
    logger.error(
      `[route/catalog.parse] ERROR url=${req?.body?.url || req?.query?.url} -> ${err?.message || err}`
    );
    try {
      await errorCollector.note(err, {
        route: "catalog.parse",
        url: req?.body?.url || req?.query?.url,
        hintType,
      });
    } catch {}
    try {
      await __snap("parse:error", {
        url: req?.body?.url || req?.query?.url,
        error: err?.message || String(err),
      });
    } catch {}

    return res
      .status(200)
      .json({ ok: false, error: String(err?.message || err) });
  }
};

// 旧入口兼容
router.all("/parse", parseHandler);

// 新入口
router.all("/catalog", parseHandler);        // /v1/catalog
router.all("/api/catalog", parseHandler);    // /v1/api/catalog

export default router;
