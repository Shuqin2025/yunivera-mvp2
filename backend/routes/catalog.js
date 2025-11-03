// backend/routes/catalog.js
// （与您当前版本一致的整体结构，只在 Memoryking 富化段落做了强化）
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

import detectRoot from "../lib/smartRootLocator.js";
import genericLinksParser from "../lib/parsers/genericLinksParser.js";

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

const MAX_TEXT_LEN = 200000;
const UA_DESKTOP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";

async function fetchHtmlBasic(url, wantDebug) {
  const res = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 20000,
    headers: {
      "User-Agent": UA_DESKTOP,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "de,en;q=0.9,zh;q=0.8",
      Referer: url,
    },
    validateStatus: () => true,
    maxRedirects: 5,
  });

  const buf = Buffer.from(res.data);
  const guess = (jschardet.detect(buf)?.encoding || "").toLowerCase();
  const useEnc =
    !guess || guess === "ascii" ? "utf-8" : guess.includes("gb") ? "gb18030" : iconv.encodingExists(guess) ? guess : "utf-8";
  const html = iconv.decode(buf, useEnc);

  const debugFetch = wantDebug ? { http_status: res.status, detected_encoding: useEnc } : undefined;
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
      return { html: fetched.html, debugFetch: wantDebug ? { used: fetched.used, http_status: fetched.status } : undefined };
    }
  } catch {}
  const r = await fetchHtmlBasic(url, wantDebug);
  if (r.html && r.html.length > MAX_TEXT_LEN) throw Object.assign(new Error("OversizedPageDetected"), { code: "OVERSIZED_PAGE" });
  return { html: r.html, debugFetch: r.debugFetch };
}

import { fileURLToPath } from "url";
const __filename2 = typeof __filename !== "undefined" ? __filename : fileURLToPath(import.meta.url);
const __dirname2 = typeof __dirname !== "undefined" ? __dirname : path.dirname(__filename2);
function saveTemplateSample({ url, pageType, rootSelector, fields }) {
  try {
    const outDir = path.join(__dirname2, "..", "..", "logs", "training", "templates", "input_samples");
    fs.mkdirSync(outDir, { recursive: true });
    const site = (() => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "unknown-site"; } })();
    const sample = { site, pageType, rootSelector, fields };
    const outFile = path.join(outDir, `${Date.now()}_${site}.json`);
    fs.writeFileSync(outFile, JSON.stringify(sample, null, 2), "utf-8");
  } catch (e) {
    console.warn("[cluster-sample] failed to save:", e?.message || e);
  }
}

const __dbgR = (tag, data) => { try { if (process?.env?.DEBUG) console.log(`[route] ${tag} ${JSON.stringify(data)}`); } catch {} };
async function __snap(tag, data) { try { if (typeof snapshot === "function") await snapshot(tag, data || {}); } catch {} }

let chromium = null;
try { ({ chromium } = await import("playwright")); } catch {}

function computeFieldsRate(list) {
  const keys = ["title", "url", "img", "price", "sku", "desc"];
  const n = Array.isArray(list) ? list.length : 0;
  const out = {};
  for (const k of keys) out[k] = n ? list.filter((x) => x && String(x[k] || "").trim()).length / n : 0;
  return out;
}

const CONTAINER_FALLBACK = ["#productlist", ".productlist", ".listBox", ".products", ".product-list", "main", "body"];
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

  let $container = $(),
    usedContainer = "";
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

  let $items = $(),
    itemSelectorUsed = "";
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
      $el.find("img[src]").attr("src") || $el.find("img[data-src]").attr("data-src") || $el.find("img[data-original]").attr("data-original") || "";
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

  const debugPart = debug
    ? { tried, container_matched: usedContainer, item_selector_used: itemSelectorUsed, item_count: $items.length, first_item_html: $items.first().html() || null }
    : undefined;

  return { items, debugPart };
}

function chooseAdapter({ url, $, html, hintType, host }) {
  if (hintType) {
    const t = String(hintType).toLowerCase();
    if (t === "shopware" || t === "woocommerce" || t === "shopify" || t === "magento") return "template";
    if (t === "memoryking") return "memoryking";
  }
  if (/(^|\. )memoryking\.de$/i.test(host)) return "memoryking";

  const det = detectStructure(html || $);
  if (det && det.type) {
    if (det.type === "Shopware" || det.type === "WooCommerce" || det.type === "Shopify" || det.type === "Magento") return "template";
  }
  return "generic";
}

function callTemplateParse(html, url, opts) {
  try {
    if (templateParser && typeof templateParser.parse === "function") return templateParser.parse(loadHtml(html), url, opts);
    if (typeof templateParser === "function") return templateParser({ html, url, ...(opts || {}) });
  } catch {}
  return Promise.resolve([]);
}
function getParseCatalog() {
  return templateParser && typeof templateParser.parseCatalog === "function" ? templateParser.parseCatalog : null;
}
function loadHtml(html) {
  return cheerio.load(html, { decodeEntities: false });
}

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

async function runExtractListPage({ url, html, limit = 50, debug = false, hintType = "" }) {
  const $full = cheerio.load(html, { decodeEntities: false });

  let used = "generic";
  let items = [];
  let debugPart;

  if (sinotronic.test && sinotronic.test(url)) {
    const out = sinotronic.parse($full, url, { limit, debug });
    items = out.items || [];
    if (debug) debugPart = out.debugPart;
    used = "sinotronic-e";
  }

  if (!items.length) {
    const host = (() => {
      try {
        return new URL(url).host;
      } catch {
        return "";
      }
    })();
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
    } else if (which === "template") {
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
    } else if (which === "generic") {
      const tOut = await callTemplateParse(html, url, { limit, debug });
      let tmp = Array.isArray(tOut) ? tOut : tOut?.items || tOut?.products || [];
      if (tmp && tmp.length) {
        items = tmp;
        used = "template-try";
      }

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

  if (!items.length) {
    const rootInfo = await detectRoot({ $: cheerio.load(html, { decodeEntities: false }) });
    const $full2 = cheerio.load(html, { decodeEntities: false });
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
      const debugPart2 = { selector: rootInfo.selector, confidence: rootInfo.confidence, reason: rootInfo.reason, probes: rootInfo.probes };
      debugPart = { ...(debugPart || {}), rootLocator: debugPart2 };
    }
  }

  if (!items.length) {
    const out = genericExtract($full, url, { limit, debug });
    items = out.items || [];
    if (debug && !debugPart) debugPart = out.debugPart;
    used = "generic-legacy";
  }

  return { items, adapter_used: used, debugPart };
}

// ---------- 强化版 Memoryking 详情富化 ----------
async function enrichMemorykingItems(items, { max = 50, timeout = 12000 } = {}) {
  const targets = (Array.isArray(items) ? items : [])
    .filter((x) => /memoryking\.de/i.test(String(x?.url || x?.link || "")))
    .slice(0, max);

  const isWeakImg = (s) => !s || /loader\.svg|placeholder|spacer\.gif/i.test(String(s));
  const absolutize = (href) => {
    if (!href) return "";
    try { return new URL(href, "https://www.memoryking.de").href; } catch { return href; }
  };

  await Promise.allSettled(
    targets.map(async (it) => {
      try {
        const pageUrl = String(it.url || it.link || "");
        if (!pageUrl) return;

        const resp = await axios.get(pageUrl, {
          timeout,
          headers: {
            "User-Agent": UA_DESKTOP,
            "Accept-Language": "de,en;q=0.9,zh;q=0.8",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Referer": pageUrl,
          },
          validateStatus: () => true,
          maxRedirects: 5,
        });

        const $ = cheerio.load(resp.data || "");

        // 1) 主图多来源
        let img =
          $('meta[property="og:image"]').attr("content") ||
          $('meta[name="twitter:image"]').attr("content") ||
          $('link[rel="image_src"]').attr("href") ||
          $('img#productImage, .product-image img, .product-gallery img,[data-zoom-image]').attr("src") ||
          "";

        if (isWeakImg(img)) {
          // 再扫 JSON 里可能的 image
          const scripts = $("script[type='application/ld+json'], script").toArray();
          for (const s of scripts) {
            const txt = $(s).html() || "";
            const m = txt.match(/"image"\s*:\s*"([^"]+)"/i);
            if (m && m[1]) {
              img = m[1];
              break;
            }
          }
        }
        img = absolutize(img);

        // 2) SKU 多来源
        let sku =
          $('[itemprop="sku"]').attr("content") ||
          $('[data-sku]').attr("data-sku") ||
          ( $("body").text().match(/Art(?:ikel)?(?:\-|\s)?(?:Nr\.?|nummer)\s*[:：]?\s*([A-Z0-9\-_.]+)/i) || [] )[1] ||
          "";

        if (!sku) {
          const scripts2 = $("script[type='application/ld+json'], script").toArray();
          for (const s of scripts2) {
            const txt = $(s).html() || "";
            let m = txt.match(/"sku"\s*:\s*"([^"]+)"/i);
            if (m && m[1]) { sku = m[1]; break; }
            m = txt.match(/"gtin\d*"\s*:\s*"([^"]+)"/i);
            if (m && m[1]) { sku = m[1]; break; }
          }
        }
        if (!sku) {
          try {
            const tail = new URL(pageUrl).pathname.split("/").filter(Boolean).pop() || "";
            sku = tail.replace(/\.(html?|php)$/i, "").slice(0, 64);
          } catch {}
        }

        if (img && isWeakImg(it.img)) it.img = img;
        const weakSku = !it.sku || !/\d|[A-Z]/i.test(String(it.sku));
        if (sku && weakSku) it.sku = sku;
      } catch (e) {
        console.warn("[enrichMemoryking] fail:", (it && (it.url || it.link)) || "", String(e).slice(0, 120));
      }
    })
  );

  return items;
}

// ---------------- parse handler ----------------
const router = Router();
const parseHandler = async (req, res) => {
  let hintType = "";
  try {
    const isGet = req.method === "GET";
    const qp = isGet ? req.query : req.body || {};

    const url = String(qp.url || "").trim();
    if (!url) return res.status(400).json({ ok: false, error: "missing url" });

    const limit = Math.max(1, parseInt(qp.limit ?? 50, 10) || 50);
    const imgMode = String(qp.img || "").toLowerCase();
    const imgCount = Math.max(0, parseInt(qp.imgCount ?? 0, 10) || 0);
    const rawDebug = qp.debug ?? qp.debug1 ?? qp.debug_1;
    const wantDebug = ["1", "true", "yes", "on"].includes(String(rawDebug ?? "").toLowerCase());
    hintType = (qp.t || qp.type || "").toString();
    const useBrowser = ["1", "true", "yes", "on"].includes(String(qp.useBrowser || qp.browser || "").toLowerCase());

    let items = [];
    let adapter_used = "";
    let html = "";
    let debugFetch;

    // A) 浏览器解析（可选）
    if (useBrowser && chromium && getParseCatalog()) {
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ userAgent: UA_DESKTOP, viewport: { width: 1366, height: 900 } });
      try {
        const r = await getParseCatalog()(page, url, hintType || "");
        const browProducts = r && Array.isArray(r.products) ? r.products : [];
        if (browProducts.length) {
          items = browProducts.map((p) => ({
            sku: p.sku || "",
            title: p.title || p.name || "",
            url: p.url || p.link || "",
            link: p.link || p.url || "",
            img: p.image || p.img || (Array.isArray(p.imgs) ? p.imgs[0] : ""),
            price: p.price || "",
            currency: p.currency || "",
            moq: p.moq || p.minQty || "",
            desc: p.desc || p.description || "",
          }));
          adapter_used = hintType || "browser-dom";
        }
      } catch {}
      try { await page.close(); } catch {}
      try { await browser.close(); } catch {}
    }

    // B) Cheerio
    if (!items.length) {
      const ensured = await ensureFetchHtml(url, wantDebug, hintType);
      html = ensured.html;
      debugFetch = ensured.debugFetch;

      const det = await detectStructure(url, html, hintType || "");
      const pageType = det?.type ? String(det.type || "").toLowerCase() : "list";

      if (html.length > MAX_TEXT_LEN || pageType === "other") {
        adapter_used = "skipped-non-list";
        items = [];
      } else if (pageType === "detail") {
        adapter_used = "detail-skip";
        items = [];
      } else {
        const ret = await runExtractListPage({ url, html, limit, debug: wantDebug, hintType });
        items = ret.items || [];
        adapter_used = ret.adapter_used || "auto";
      }
    }

    // C) Memoryking 详情富化（核心补图/补 SKU）
    if (/memoryking\.de/i.test(url) && Array.isArray(items) && items.length) {
      try { await enrichMemorykingItems(items, { max: Math.min(items.length, 50), timeout: 12000 }); } catch {}
    }

    // 可选：图片做 base64（仅当显式请求）
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

    // 统一 rows
    const rows = (items || []).map((it) => {
      const link = it.link || it.url || "";
      return {
        sku: it.sku || it.code || "",
        title: it.title || it.desc || "",
        img: it.img || (Array.isArray(it.imgs) ? it.imgs[0] : ""),
        desc: it.desc || "",
        moq: it.moq || it.minQty || "",
        price: it.price || "",
        currency: it.currency || "",
        url: link,
        link,
      };
    });

    return res.json({
      ok: true,
      url,
      count: rows.length,
      adapter: adapter_used,
      items: rows,
      data: rows,
      list: rows,
      rows,
    });
  } catch (err) {
    logger.error(`[route/catalog.parse] ERROR url=${req?.body?.url || req?.query?.url} -> ${err?.message || err}`);
    try { await errorCollector.note(err, { route: "catalog.parse", url: req?.body?.url || req?.query?.url, hintType }); } catch {}
    try { await __snap("parse:error", { url: req?.body?.url || req?.query?.url, error: err?.message || String(err) }); } catch {}
    return res.status(200).json({ ok: false, error: String(err?.message || err) });
  }
};

const router = Router();
router.all("/parse", parseHandler);
router.all("/catalog", parseHandler);
router.all("/api/catalog", parseHandler);
router.get("/_probe", (_req, res) => {
  const rows = [{ sku: "demo", title: "probe ok", url: "#", img: "", desc: "", moq: "", price: "" }];
  res.json({ ok: true, url: "/_probe", count: rows.length, adapter: "probe", items: rows, data: rows, list: rows, rows });
});

export default router;
