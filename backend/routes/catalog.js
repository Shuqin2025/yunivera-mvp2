/// backend/routes/catalog.js
// 统一 /parse 输出结构到 rows/data/list/items（含 link/url）
// 保留适配器 + 兜底，并与 server.js 的 toTablePayload 规范一致

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

// === 新增兜底：智能 root 定位 + 目录解析器 ===
import detectRoot from "../lib/smartRootLocator.js";
import genericLinksParser from "../lib/parsers/genericLinksParser.js";

// family predictor（可选加载，缺失不影响启动）
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

const MAX_TEXT_LEN = 200000; // 超大页面直接跳过

// ---------------- fetchHtml ----------------
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

async function ensureFetchHtml(url, wantDebug, hintType = "") {
  try {
    const strat = decideFetchStrategy({ url, hintType });
    const fetched = await fetchHtmlAdaptive({ url, strategy: strat });

    if (fetched?.html && fetched.html.length > MAX_TEXT_LEN) {
      throw Object.assign(new Error("OversizedPageDetected"), { code: "OVERSIZED_PAGE" });
    }
    if (fetched?.html) {
      return {
        html: fetched.html,
        debugFetch: wantDebug ? { used: fetched.used, http_status: fetched.status } : undefined,
      };
    }
  } catch { /* ignore */ }

  const r = await fetchHtmlBasic(url, wantDebug);
  if (r.html && r.html.length > MAX_TEXT_LEN) {
    throw Object.assign(new Error("OversizedPageDetected"), { code: "OVERSIZED_PAGE" });
  }
  return { html: r.html, debugFetch: r.debugFetch };
}

// ---------------- dbg helpers ----------------
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

// ---------------- optional Playwright ----------------
let chromium = null;
try { ({ chromium } = await import("playwright")); } catch {}

// ---------------- metrics helper ----------------
function computeFieldsRate(list) {
  const keys = ["title", "url", "img", "price", "sku", "desc"];
  const n = Array.isArray(list) ? list.length : 0;
  const out = {};
  for (const k of keys) {
    out[k] = n ? list.filter((x) => x && String(x[k] || "").trim()).length / n : 0;
  }
  return out;
}

// ---------------- legacy generic fallback ----------------
const CONTAINER_FALLBACK = ["#productlist",".productlist",".listBox",".products",".product-list","main","body"];
const ITEM_FALLBACK = ["#productlist ul > li","ul.products > li","ul > li",".product",".product-item",".productItem",".product-box","li"];

function genericExtract($, baseUrl, { limit = 50, debug = false } = {}) {
  const tried = { container: [], item: [] };

  let $container = $(), usedContainer = "";
  for (const sel of CONTAINER_FALLBACK) {
    tried.container.push(sel);
    const hit = $(sel);
    if (hit.length) { $container = hit.first(); usedContainer = sel; break; }
  }
  if (!$container.length) { $container = $("body"); usedContainer = "body"; }

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

    const imgRel = $el.find("img[src]").attr("src")
      || $el.find("img[data-src]").attr("data-src")
      || $el.find("img[data-original]").attr("data-original")
      || "";
    const img = absolutize(imgRel);

    let title =
      ($el.find("img").attr("alt") || "").trim()
      || $el.find("h1,h2,h3,h4,h5,h6").first().text().trim()
      || ($a.text() || "").trim()
      || $el.text().trim();

    title = title.replace(/\s+/g, " ").trim();
    if (!title && !img && !link) return;

    items.push({ sku: title, desc: title, minQty: "", price: "", img, link });
  });

  const debugPart = debug ? {
    tried, container_matched: usedContainer, item_selector_used: itemSelectorUsed,
    item_count: $items.length, first_item_html: $items.first().html() || null
  } : undefined;

  return { items, debugPart };
}

// ---------------- adapter helpers ----------------
function chooseAdapter({ url, $, html, hintType, host }) {
  if (hintType) {
    const t = String(hintType).toLowerCase();
    if (t === "shopware" || t === "woocommerce" || t === "shopify" || t === "magento") return "template";
    if (t === "memoryking") return "memoryking";
  }
  if (/(^|\. )memoryking\.de$/i.test(host)) return "memoryking";

  const det = detectStructure(html || $);
  if (det && det.type) {
    if (det.type === "Shopware" || det.type === "WooCommerce" || det.type === "Shopify" || det.type === "Magento") {
      return "template";
    }
  }
  return "generic";
}

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
function loadHtml(html) { return cheerio.load(html, { decodeEntities: false }); }

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

// ---------------- extraction pipeline for LIST ----------------
async function runExtractListPage({ url, html, limit = 50, debug = false, hintType = "" }) {
  const $full = cheerio.load(html, { decodeEntities: false });

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
    const host = (() => { try { return new URL(url).host; } catch { return ""; } })();
    const which = chooseAdapter({ url, $: $full, html, hintType, host });

    if (which === "memoryking") {
      const out = memoryking.parse($full, url, { limit, debug });
      let mmItems = Array.isArray(out) ? out : out.items || out.products || [];
      if (debug && !debugPart) debugPart = out?.debugPart;

      if (!mmItems || mmItems.length === 0) {
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
        if (cand && cand.length) { items = cand; used = "universal-fallback"; }
      }
    }
    else if (which === "generic") {
      const tOut = await callTemplateParse(html, url, { limit, debug });
      let tmp = Array.isArray(tOut) ? tOut : tOut?.items || tOut?.products || [];
      if (tmp && tmp.length) { items = tmp; used = "template-try"; }

      if (!items.length) {
        const u = await callUniversalWithHtml(url, html, { limit, debug });
        const cand = Array.isArray(u) ? u : u?.items || u?.products || [];
        if (cand && cand.length) { items = cand; used = "universal"; }
      }
    }
  }

  // 2) root-scope 兜底
  if (!items.length) {
    const rootInfo = await detectRoot({ $: cheerio.load(html, { decodeEntities:false }) });
    const $full2 = cheerio.load(html, { decodeEntities:false });
    const $rootNode = $full2(rootInfo.selector).first();
    const rootHtml = $rootNode.length ? $rootNode.html() : "";
    const $rootOnly = cheerio.load(rootHtml || "", { decodeEntities: false });

    const parsedFromRoot = await genericLinksParser({ $: $rootOnly, url, scope: "rootOnly" });
    if (parsedFromRoot && parsedFromRoot.products && parsedFromRoot.products.length) {
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
      let debugPart2 = {
        selector: rootInfo.selector,
        confidence: rootInfo.confidence,
        reason: rootInfo.reason,
        probes: rootInfo.probes,
      };
      debugPart = { ...(debugPart || {}), rootLocator: debugPart2 };
    }
  }

  // 3) 旧 generic 兜底
  if (!items.length) {
    const out = genericExtract($full, url, { limit, debug });
    items = out.items || [];
    if (debug && !debugPart) debugPart = out.debugPart;
    used = "generic-legacy";
  }

  return { items, adapter_used: used, debugPart };
}


// ---------------- memoryking enrichment (detail fetch) ----------------
async function enrichMemorykingItems(items, { max = 50, timeout = 12000 } = {}) {
  const targets = (Array.isArray(items) ? items : []).filter(x => /memoryking\.de/i.test(String(x?.url || x?.link || ""))).slice(0, max);

  await Promise.allSettled(targets.map(async (it) => {
    try {
      const pageUrl = String(it.url || it.link || "");
      if (!pageUrl) return;

      const res = await axios.get(pageUrl, {
        timeout,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
          'Accept-Language': 'de,en;q=0.8,zh;q=0.6',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        validateStatus: () => true,
      });

      const $ = cheerio.load(res.data || "");

      let img = $('meta[property="og:image"]').attr('content')
        || $('img#productImage, .product-image img, .product-slider img, picture img').attr('src')
        || '';
      // MK_SRCSET_FALLBACK
      if (!img) {
        const srcset = $('source[srcset], img[srcset]').attr('srcset') || '';
        if (srcset) {
          const first = srcset.split(',')[0].trim().split(' ')[0];
          if (first) img = first;
        }
      }
      if (img && !/^https?:\/\//i.test(img)) {
        try { img = new URL(img, 'https://www.memoryking.de').toString(); } catch {}
      }

      let sku =
        $('[itemprop="sku"]').attr('content') ||
        $('[data-sku]').attr('data-sku') ||
        ($('table, .product-details, .data, body').text().match(/Artikel(?:nummer|[-\s]?Nr\.?)[\s:：]*([A-Z0-9\-_.]+)/i)?.[1]) ||
        '';

      if (!sku) {
        try {
          const tail = (new URL(pageUrl)).pathname.split('/').filter(Boolean).pop() || '';
          sku = tail.replace(/\.(html?|php)$/i, '').slice(0, 64);
        } catch {}
      }

      const imgIsWeak = !it.img || /loader\.svg|placeholder|spacer\.gif|logo|transparent|imagecache/i.test(String(it.img));
      if (img && imgIsWeak) it.img = img;

      const skuIsWeak = !it.sku || !/\d/.test(String(it.sku));
      if (sku && skuIsWeak) it.sku = sku;

    } catch (e) {
      try { console.warn('[enrichMemoryking] fail:', (it && it.url) || (it && it.link) || '', String(e).slice(0, 120)); } catch {}
    }
  }));

  return items;
}

// ---------------- parseHandler ----------------
const router = Router();

const parseHandler = async (req, res) => {
  let hintType = "";

  try {
    const isGet = req.method === "GET";
    const qp = isGet ? req.query : req.body || {};

    __dbgR("parse.start", { url: qp?.url });
    const DEBUG_ENV = process.env.DEBUG === "1" || process.env.DEBUG === "true";

    const url = String(qp.url || "").trim();
    
    // --- adapter hint fallback by host (when t not provided) ---
    let t = (qp.t || qp.type || "").toString().trim();
    try {
      const urlHost = new URL(url).hostname;
      if (!t) {
        if (/(^|\.)memoryking\.de$/i.test(urlHost)) t = "memoryking";
        else if (/s-impuls-shop\.de$/i.test(urlHost)) t = "generic-cards";
      }
      if (t) hintType = t;
    } catch {}
logger.debug(`[route/catalog.parse] url=${url} size=${qp.size ?? ""}`);
    if (!url) return res.status(400).json({ ok: false, error: "missing url" });

    const limit = Math.max(1, parseInt(qp.limit ?? 50, 10) || 50);
    const imgMode = String(qp.img || "").toLowerCase(); // "base64"
    const imgCount = Math.max(0, parseInt(qp.imgCount ?? 0, 10) || 0);

    const rawDebug = qp.debug ?? qp.debug1 ?? qp.debug_1;
    const wantDebug = ["1","true","yes","on"].includes(String(rawDebug ?? "").toLowerCase());
    hintType = (qp.t || qp.type || "").toString();
    const useBrowser = ["1","true","yes","on"].includes(String(qp.useBrowser || qp.browser || "").toLowerCase());

    await __snap("parse:enter", { url, limit, t: qp.t });
    DEBUG_ENV && console.log("[struct]", "parse:start", { url, hintType, useBrowser });

    let items = [];
    let adapter_used = "";
    let html = "";
    let debugFetch = undefined;
    let debugPart = undefined;

    // A) 浏览器
    if (useBrowser && chromium && getParseCatalog()) {
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ userAgent: UA_DESKTOP, viewport: { width: 1366, height: 900 } });

      try {
        const r = await getParseCatalog()(page, url, hintType || "");
        const browProducts = r && Array.isArray(r.products) ? r.products : [];
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
      } catch { /* ignore */ }

      try { await page.close(); } catch {}
      try { await browser.close(); } catch {}
    }

    // B) Cheerio + root
    if (!items.length) {
      const ensured = await ensureFetchHtml(url, wantDebug, hintType);
      html = ensured.html;
      debugFetch = ensured.debugFetch;

      if (!html) {
        throw Object.assign(new Error("crawlPages: fetchHtml is required"), { code: "FETCH_EMPTY" });
      }

      // Step 1: 结构判别
      let pageType = "other";
      let structDebug = null;
      try {
        const det = await detectStructure(url, html, hintType || "");
        if (det && det.type) pageType = String(det.type || "").toLowerCase();
        structDebug = det || null;
      } catch (e) {
        console.warn("[catalog] detectStructure error:", e?.message || e);
      }

      try { await snapshot("structureDetector", { url, pageType, structDebug }); } catch {}

      if (html.length > MAX_TEXT_LEN || pageType === "other") {
        logger.warn?.(`[catalog] Skip non-list page or oversized page: type=${pageType}, len=${html.length}`);
        adapter_used = "skipped-non-list";
        items = [];
      } else if (pageType === "detail") {
        logger.info?.("[catalog] Detected DETAIL page, skip bulk listing parse.");
        adapter_used = "detail-skip";
        items = [];
      } else {
        const ret = await runExtractListPage({ url, html, limit, debug: wantDebug, hintType });
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

    // （关键）Memoryking 详情富化：在映射 rows 之前做
    if (/memoryking\.de/i.test(url) && Array.isArray(items) && items.length) {
      try {
        await enrichMemorykingItems(items, { max: Math.min(items.length, 50), timeout: 12000 });
      } catch (e) {
        console.warn("[catalog.parse] enrichMemorykingItems failed:", e?.message || e);
      }
    }

    // 图片转 base64（可选）
    if (imgMode === "base64" && items.length && imgCount > 0) {
      const N = Math.min(imgCount, items.length);
      await Promise.all(
        items.slice(0, N).map(async (it) => {
          if (!it.img) return;
          try {
            const r = await axios.get(it.img, { responseType: "arraybuffer" });
            const ext = (it.img.split(".").pop() || "jpg").toLowerCase();
            it.img = `data:image/${ext};base64,${Buffer.from(r.data).toString("base64")}`;
          } catch {}
        })
      );
    }

    // === 统一输出结构（保持 products & items 供调试） ===
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

    const fieldsRate = computeFieldsRate(products || []);
    const wantSnapshot = ["1","true","yes","on"].includes(String(qp.snapshot || qp.debug || "").toLowerCase());

    // === compatibility normalizer for frontend table ===
// 兼容不同源字段名：sku/img/desc/link/url/moq/price
function pickImg(it = {}) {
  return String(
    it.img ??
    it.image ??
    it.thumb ??
    it.picture ??
    it.pic ??
    ""
  );
}

// memoryking 补货号：从 /details/<slug> 提取；失败再试 title 的第一个 token
function deriveSku(it = {}) {
  const u = String(it.url ?? it.link ?? "");
  const t = String(it.title ?? "");
  if (it.sku) return String(it.sku);

  try {
    const host = new URL(u).hostname || "";
    if (host.includes("memoryking.de")) {
      // 例：https://www.memoryking.de/details/deleycon-tv-antennen-...
      const m = u.match(/\/details\/([^\/?#]+)/i);
      if (m && m[1]) return m[1];
    }
  } catch (_) { /* ignore URL parse errors */ }

  // 兜底：用标题第一个非空词作为 sku
  const firstToken = (t.trim().split(/\s+/)[0] || "");
  return firstToken || "";
}

// --- 强化：弱 SKU 与占位图兜底 ---
function normRow(it = {}) {
  const link = String(it.link ?? it.url ?? "");

  // 1) SKU：先取 deriveSku；若不含数字 => 用 URL 尾段；仍弱 => 标题首词
  let sku0 = deriveSku(it);
  if (!/\d/.test(String(sku0 || ""))) {
    try {
      const tail = (new URL(link)).pathname.split('/').filter(Boolean).pop() || "";
      const fromUrl = tail.replace(/\.(html?|php)$/i, "");
      if (fromUrl) sku0 = fromUrl;
    } catch {}
    if (!/\d/.test(String(sku0 || ""))) {
      const first = String(it.title || "").trim().split(/\s+/)[0] || "";
      if (first) sku0 = first;
    }
  }

  // 2) 图片：若是占位图（loader.svg/placeholder/spacer.gif），优先从 imgs[] 里挑第一张非占位
  let img0 = pickImg(it);
  const isPlaceholder = /loader\.svg|placeholder|spacer\.gif|logo|transparent|imagecache/i.test(String(img0 || ""));
  if (isPlaceholder && Array.isArray(it.imgs)) {
    const alt = it.imgs.find(x => x && !/loader\.svg|placeholder|spacer\.gif|logo|transparent|imagecache/i.test(String(x)));
    if (alt) img0 = String(alt);
  }

  return {
    sku:   sku0,
    title: String(it.title ?? ""),
    img:   img0,
    desc:  String(it.desc ?? it.description ?? ""),
    moq:   String(it.moq ?? ""),
    price: String(it.price ?? ""),
    url:   link,
    link, // 前端有时读 link
  };
}

const rows = Array.isArray(items) ? items.map(normRow) : [];

const payload = {
  ok: true,
  url,
  count: rows.length,
  adapter: adapter_used,
  items: rows, // 兼容：items
  data:  rows, // 兼容：data
  list:  rows, // 兼容：list
  rows,        // 兼容：rows
};

return res.json(payload);

  } catch (err) {
    logger.error(`[route/catalog.parse] ERROR url=${req?.body?.url || req?.query?.url} -> ${err?.message || err}`);
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

    return res.status(200).json({ ok: false, error: String(err?.message || err) });
  }
};

// --- 路由注册（**只声明一次 router**）
router.all("/parse", parseHandler);        // /v1/api/catalog/parse
router.all("/catalog", parseHandler);      // /v1/api/catalog 兼容
router.all("/api/catalog", parseHandler);  // /v1/api/catalog 兼容

// 探针：GET /v1/api/catalog/_probe
router.get("/_probe", (_req, res) => {
  const rows = [{ sku:"demo", title:"probe ok", url:"#", img:"", desc:"", moq:"", price:"" }];
  res.json({
    ok:true, url:"/_probe", count:rows.length, adapter:"probe",
    items:rows, data:rows, list:rows, rows
  });
});

export default router;
