// backend/routes/catalog.js (REVISED)
// 重点更新：
//  - 引入 smartRootLocator 定位产品主容器
//  - 引入 detectStructure 做 LIST / DETAIL / OTHER 预分流
//  - 增加 OversizedPageDetected 防跑偏保护
//  - genericLinksParser 现在吃 root HTML，而不是整页 body

import { Router } from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import jschardet from "jschardet";
import iconv from "iconv-lite";
import fs from "node:fs";
import path from "node:path";

import sinotronic from "../adapters/sinotronic.js";
import memoryking from "../adapters/memoryking.js";

import { detectStructure } from "../lib/structureDetector.js";
import templateParser from "../lib/templateParser.js";
import universal from "../adapters/universal.js";

import logger from "../lib/logger.js";
import snapshot from "../lib/debugSnapshot.js";

import { decideFetchStrategy, fetchHtml as fetchHtmlAdaptive } from "../modules/adaptiveCrawler.js";
import { classify } from "../modules/templateCluster.js";
import * as errorCollector from "../modules/errorCollector.js";

// === 🔥 新增：智能 root 定位 + 目录解析器 ===
import detectRoot from "../lib/smartRootLocator.js";
import genericLinksParser from "../lib/parsers/genericLinksParser.js";

// === 页面防跑偏阈值（避免整站/站点地图类页面） ===

// NEW: family predictor (optional dynamic load to avoid startup failure)
let predictFamilySync = (sample) => ({ familyId: "UNKNOWN", similarityScore: 0 });
try {
  const __predictMod = await import("../modules/templateClusterRuntime.js");
  if (__predictMod && typeof __predictMod.predictFamilySync === "function") {
    predictFamilySync = __predictMod.predictFamilySync;
  } else {
    console.warn("[catalog] templateClusterRuntime.js found but no predictFamilySync export; using stub.");
  }
} catch (e) {
  console.warn("[catalog] templateClusterRuntime.js missing; family prediction disabled. ", e?.message || e);
}
// === 页面防跑偏阈值（避免整站/站点地图类页面） ===
const MAX_TEXT_LEN = 200000; // 超过视为噪音页，直接拒抓（参谋长建议）

// --------------------------------------------------
// fetchHtml helpers (原样保留)
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

    // OversizedPageDetected 防线: adaptiveCrawler 也可能拉到整站大块
    if (fetched?.html && fetched.html.length > MAX_TEXT_LEN) {
      throw Object.assign(
        new Error("OversizedPageDetected"),
        { code: "OVERSIZED_PAGE" }
      );
    }

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

  if (r.html && r.html.length > MAX_TEXT_LEN) {
    throw Object.assign(
      new Error("OversizedPageDetected"),
      { code: "OVERSIZED_PAGE" }
    );
  }

  return { html: r.html, debugFetch: r.debugFetch };
}

// --------------------------------------------------
// helpers / dbg (原样)
// --------------------------------------------------

// NEW: sample saver for template clustering
import { fileURLToPath } from "url";
const __filename2 = typeof __filename !== "undefined" ? __filename : fileURLToPath(import.meta.url);
const __dirname2  = typeof __dirname  !== "undefined" ? __dirname  : path.dirname(__filename2);

function saveTemplateSample({ url, pageType, rootSelector, fields }) {
  try {
    const outDir = path.join(__dirname2, "..", "..", "logs", "training", "templates", "input_samples");
    fs.mkdirSync(outDir, { recursive: true });
    const site = (() => {
      try { return new URL(url).hostname.replace(/^www\./, ""); }
      catch { return "unknown-site"; }
    })();
    const sample = { site, pageType, rootSelector, fields };
    const outFile = path.join(outDir, `${Date.now()}_${site}.json`);
    fs.writeFileSync(outFile, JSON.stringify(sample, null, 2), "utf-8");
  } catch (e) {
    console.warn("[cluster-sample] failed to save:", e?.message || e);
  }
}
// --------------------------------------------------
// helpers / dbg (原样)
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
// optional Playwright (原样)
// --------------------------------------------------

let chromium = null;
try {
  ({ chromium } = await import("playwright"));
} catch {}

// --------------------------------------------------
// metrics helper (原样)
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
// legacy generic fallback extractor (仍可保留兜底)
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

    // ✅ 这里是修复后的“干净版” title 段
    let title =
      ($el.find("img").attr("alt") || "").trim() ||
      $el.find("h1,h2,h3,h4,h5,h6").first().text().trim() ||
      ($a.text() || "").trim() ||
      $el.text().trim();

    title = title.replace(/\s+/g, " ").trim();
    if (!title && !img && !link) return;

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
// adapter decision helpers (原样)
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

// unify templateParser export styles (原样)
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

// 封装 universal，优先尝试“喂现成 html” (原样)
async function callUniversalWithHtml(url, html, { limit, debug }) {
  try {
    const u1 = await universal({ url, html, limit, debug });
    if (u1 && (Array.isArray(u1) || u1.items || u1.products)) return u1;
  } catch {}
  try {
    const u2 = await universal(url, html, { limit, debug });
    if (u2 && (Array.isArray(u2) || u2.items || u2.products)) return u2;
  } catch {}
  return null;
}

// --------------------------------------------------
// NEW: high-level extraction pipeline for LIST pages
// --------------------------------------------------

async function runExtractListPage({ url, html, limit = 50, debug = false, hintType = "" }) {
  const $full = cheerio.load(html, { decodeEntities: false });

  // 先尝试已有的适配器/模板系统 (保持你原有逻辑顺序)
  let used = "generic";
  let items = [];
  let debugPart;

  // 0) sinotronic
  if (sinotronic.test && sinotronic.test(url)) {
    const out = sinotronic.parse($full, url, { limit, debug });
    items = out.items || [];
    if (debug) debugPart = out.debugPart;
    used = "sinotronic-e";
  }

  // 1) choose adapter
  if (!items.length) {
    const host = (() => {
      try { return new URL(url).host; } catch { return ""; }
    })();
    const which = chooseAdapter({ url, $: $full, html, hintType, host });

    if (which === "memoryking") {
      const out = memoryking.parse($full, url, { limit, debug });
      let mmItems = Array.isArray(out) ? out : out.items || out.products || [];
      if (debug && !debugPart) debugPart = out?.debugPart;

      if (!mmItems || mmItems.length === 0) {
        // fallback template
        const tOut = await callTemplateParse(html, url, { limit, debug });
        mmItems = Array.isArray(tOut) ? tOut : tOut?.items || tOut?.products || [];

        if (!mmItems || mmItems.length === 0) {
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
      // 尝试 template anyway
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
  // 如果这些专用/模板解析器都没拿到结果 ⇒ 进入我们的新策略：
  // detectRoot + genericLinksParser (root-scoped)
  if (!items.length) {
    const rootInfo = await detectRoot({ $: $full });
    const $rootNode = $full(rootInfo.selector).first();
    const rootHtml = $rootNode.length ? $rootNode.html() : "";
    const $rootOnly = cheerio.load(rootHtml || "", { decodeEntities: false });

    const parsedFromRoot = await genericLinksParser({
      $: $rootOnly,
      url,
      scope: "rootOnly",
    });

    if (
      parsedFromRoot &&
      parsedFromRoot.products &&
      parsedFromRoot.products.length
    ) {
      items = parsedFromRoot.products.map((p) => ({
        sku: p.sku || p.title || "",
        title: p.title || "",
        url: p.url || p.link || "",
        link: p.url || p.link || "",
        img: p.img || "",
        price: p.price || "",
        currency: p.currency || "",
        moq: p.moq || "",
        desc: p.desc || "",
      }));

      used = (parsedFromRoot.adapter || "") + "+rootScope";
      debugPart = {
        ...(debugPart || {}),
        rootLocator: {
          selector: rootInfo.selector,
          confidence: rootInfo.confidence,
          reason: rootInfo.reason,
          probes: rootInfo.probes,
        },
      };
    }
  }

  // 最后兜底：如果还没抓到，沿用旧 genericExtract 全页遍历
  if (!items.length) {
    const out = genericExtract($full, url, { limit, debug });
    items = out.items || [];
    if (debug && !debugPart) debugPart = out.debugPart;
    used = "generic-legacy";
  }

  return { items, adapter_used: used, debugPart };
}

// --------------------------------------------------
// parseHandler 主入口（大部分沿用，但插入结构判定）
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

    // ---- 路线 A：Playwright DOM 特殊解析（原逻辑保留）
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

    // ---- 路线 B：Cheerio 默认 + 新 root 流程
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

      // ============== NEW STEP 1: 结构判别 (LIST / DETAIL / OTHER) ==============
      let pageType = "other";
      let structDebug = null;
      try {
        const det = await detectStructure(url, html, hintType || "");

        if (det && det.type) {
          pageType = String(det.type || "").toLowerCase();
        }
        structDebug = det || null;
      } catch (e) {
        console.warn("[catalog] detectStructure error:", e?.message || e);
      }

      try {
        await snapshot("structureDetector", { url, pageType, structDebug });
      } catch {}

      if (html.length > MAX_TEXT_LEN || pageType === "other") {
        logger.warn?.(
          `[catalog] Skip non-list page or oversized page: type=${pageType}, len=${html.length}`
        );
        adapter_used = "skipped-non-list";
        items = [];
      } else if (pageType === "detail") {
        logger.info?.("[catalog] Detected DETAIL page, skip bulk listing parse.");
        adapter_used = "detail-skip";
        items = [];
      } else {
        const ret = await runExtractListPage({
          url,
          html,
          limit,
          debug: wantDebug,
          hintType,
        });
        items = ret.items || [];
        adapter_used = ret.adapter_used || "auto";
        debugPart = ret.debugPart;
      }

      try {
        const preClass = classify(url, html);
        if (!hintType && preClass && preClass.adapterHint) {
          hintType = preClass.platform;
        }
        try { await snapshot("pre-classify", { url, preClass }); } catch {}
      } catch {}
    }

    // ---- 图片转 base64（原逻辑保留）
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

    // ---- 输出结构（基本保持不变）
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

    // Predict family based on rootSelector + fields (if available)
    let familyInfo = { familyId: "UNKNOWN", similarityScore: 0 };
    try {
      const rootSel = debugPart?.rootLocator?.selector || debugPart?.rootLocator?.rootSelector || "";
      const first = products?.[0] || items?.[0] || {};
      const fields = Object.keys(first || {});
      if (rootSel && fields && fields.length) {
        const sampleForPredict = {
          site: new URL(url).hostname.replace(/^www\./, ""),
          pageType: "list",
          rootSelector: rootSel,
          fields,
        };
        familyInfo = predictFamilySync(sampleForPredict);
      }
    } catch (e) {
      console.warn("[catalog-family-predict] failed:", e?.message || e);
    }

    const resp = {
      ok: true,
      url,
      count,
      products,
      items,
      adapter: adapter_used,
      familyId: familyInfo.familyId,
      familyScore: familyInfo.similarityScore,
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
        note: "NoProductFound after pipeline",
      });
    }

    // ====== 仅此处替换为所需返回结构 ======
    // === normalize to frontend-required schema ===
const itemsStd = (Array.isArray(items) ? items : []).map((it) => {
  const link   = it.link || it.url || it.href || "";
  const url    = link; // 同时返回 url & link，兼容前端
  const title  = String(it.title || it.name || it.sku || "").trim();
  const sku    = String(it.sku || it.code || title).trim();
  const img    = it.img || it.image || (Array.isArray(it.imgs) ? it.imgs[0] : "") || "";
  const price  = it.price == null ? "" : String(it.price);
  const minQty = it.minQty || it.moq || "";
  const desc   = it.desc || it.description || "";

  return { sku, title, img, desc, minQty, price, url, link };
}).filter(it => it.title || it.url || it.link); // 允许用 url 或 link 作为有效性判定

return res.json({
  ok: true,
  url,
  count: itemsStd.length,
  items: itemsStd,
  adapter: adapter_used || adapter || ""
});
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
