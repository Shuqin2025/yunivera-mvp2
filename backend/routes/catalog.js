// backend/routes/catalog.js
// 统一目录解析：GET/POST /v1/api/catalog/parse
// - axios(arraybuffer) + jschardet + iconv-lite 自动探测与解码（gb* → gb18030）
// - 命中站点适配器（sinotronic / memoryking / templateParser / universal），否则走通用兜底
// - debug=1 时回传完整调试信息

import { Router } from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import jschardet from "jschardet";
import iconv from "iconv-lite";

// 站点适配器（专用）
import sinotronic from "../adapters/sinotronic.js";
import memoryking from "../adapters/memoryking.js"; // 对象导出：.test / .parse($,url,...)

// 模板解析中枢 + 通用适配器
import detectStructure from "../lib/structureDetector.js";
import templateParser from "../lib/templateParser.js"; // 新增：四大系统模板入口（带 detailFetcher）
import universal from "../adapters/universal.js";      // 默认导出：async function ({url,limit,debug})

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

// ---------------- 过滤“站点通用链接”（generic 兜底时使用） ----------------
const PATH_SKIP_PATTERNS = [
  // 常见德语/英语/泛用站点页面
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

// 关键词黑名单（标题/链接中任意命中即视为站点链接，过滤掉）
const SKIP_WORDS = [
  'login','anmelden','register','konto','account','mein konto','my account',
  'logout','cart','warenkorb','basket','wishlist','wunschliste',
  'agb','impressum','datenschutz','privacy','policy','hilfe','support','kontakt',
  'newsletter','blog','news','service','faq','payment','shipping','versand',
  'returns','widerruf','revocation','cookie','sitemap'
];



function isSiteLink(link = "", title = "") {
  try {
    const u = new URL(link, "http://_/");
    const p = (u.pathname || "").toLowerCase();
    // 路径基于正则的快速判断
    if (PATH_SKIP_PATTERNS.some(re => re.test(p))) return true;
    // 关键词黑名单：路径中直接包含
    if (SKIP_WORDS.some(w => p.includes(w))) return true;
  } catch {}
  const t = (title || "").toLowerCase();
  if (TITLE_SKIP_PATTERNS.some(re => re.test(t))) return true;
  // 关键词黑名单：标题中直接包含
  if (SKIP_WORDS.some(w => t.includes(w))) return true;
  return false;
}
 catch {}
  const t = (title || "").toLowerCase();
  if (TITLE_SKIP_PATTERNS.some(re => re.test(t))) return true;
  return false;
}

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

    // 🔥 小热修：过滤“站点通用链接”（避免 generic 出导航）
    if (isSiteLink(link, title)) return;

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

// ---------------- 适配器选择（前端 hint → 域名直连 → 结构识别） ----------------
function chooseAdapter({ url, $, html, hintType, host }) {
  // 先看前端 hint（支持 &t= 强制）
  if (hintType) {
    const t = String(hintType).toLowerCase();
    if (t === "shopware" || t === "woocommerce" || t === "shopify" || t === "magento") {
      return "template";
    }
    if (t === "memoryking") return "memoryking";
  }

  // 域名专用（最稳）
  if (/(^|\.)memoryking\.de$/i.test(host)) return "memoryking";

  // 结构识别 → 命中四大系统走模板解析
  const det = detectStructure(html || $);
  if (det && det.type) {
    if (det.type === "Shopware" || det.type === "WooCommerce" || det.type === "Shopify" || det.type === "Magento") {
      return "template";
    }
  }

  return "generic";
}

// ---------------- 统一跑适配器/兜底 ----------------
async function runExtract(url, html, { limit = 50, debug = false, hintType = "" } = {}) {
  const $ = cheerio.load(html, { decodeEntities: false });

  let used = "generic", items = [], debugPart;

  // 0) 保留：sinotronic 专用逻辑（你已有）
  if (sinotronic.test(url)) {
    const out = sinotronic.parse($, url, { limit, debug });
    items = out.items || [];
    if (debug) debugPart = out.debugPart;
    used = "sinotronic-e";
  }

  // 1) 根据 hint/域名/结构识别选择适配器
  if (!items.length) {
    const host = (() => { try { return new URL(url).host; } catch { return ""; } })();
    const which = chooseAdapter({ url, $, html, hintType, host });

    if (which === "memoryking") {
      // Memoryking 专用（已验证懒加载图片）
      const out = memoryking.parse($, url, { limit, debug });
      let mmItems = Array.isArray(out) ? out : (out.items || out.products || []);
      if (debug && !debugPart) debugPart = out?.debugPart;

      // 若为空 → 先回到模板解析（Shopware系更稳），再不行再 universal
      if (!mmItems || mmItems.length === 0) {
        const tOut = await templateParser({ html, url, limit, debug });
        mmItems = Array.isArray(tOut) ? tOut : (tOut?.items || tOut?.products || []);
        if (!mmItems || mmItems.length === 0) {
          const u = await universal({ url, limit, debug });
          mmItems = Array.isArray(u) ? u : (u?.items || u?.products || []);
          used  = "universal-fallback";
        } else {
          used = "template-fallback";
        }
      } else {
        used  = "memoryking";
      }
      items = mmItems || [];
    }

    else if (which === "template") {
      // 新增：模板解析优先（内部会根据 detectStructure 选择对应 parser，并可触发 detailFetcher）
      const tOut = await templateParser({ html, url, limit, debug });
      items = Array.isArray(tOut) ? tOut : (tOut?.items || tOut?.products || []);
      used  = "template";

      // 若模板没取到，则回退到 universal（它会自抓）
      if (!items || items.length === 0) {
        const u = await universal({ url, limit, debug });
        items = Array.isArray(u) ? u : (u?.items || u?.products || []);
        used  = "universal-fallback";
      }
    }

    else if (which === "generic") {
      // 先尝试模板（万一识别不准但模板能吃到），再 generic
      const tOut = await templateParser({ html, url, limit, debug });
      let tmp = Array.isArray(tOut) ? tOut : (tOut?.items || tOut?.products || []);
      if (tmp && tmp.length) {
        items = tmp;
        used  = "template-try";
      }
    }

    // 若上面都没命中，再让 universal 试一遍（例如特殊结构）
    if (!items.length) {
      const u = await universal({ url, limit, debug });
      items = Array.isArray(u) ? u : (u?.items || u?.products || []);
      if (items && items.length) used = used === "generic" ? "universal" : used || "universal";
    }
  }

  // 2) 仍不命中则 generic 兜底（最后一道保险）
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

    const imgMode  = String(qp.img || "").toLowerCase();     // "base64" | ""
    const imgCount = Math.max(0, parseInt(qp.imgCount ?? 0, 10) || 0);

    const rawDebug   = qp.debug ?? qp.debug1 ?? qp.debug_1;
    const wantDebug  = ["1","true","yes","on"].includes(String(rawDebug ?? "").toLowerCase());

    // ★ 解析前端 hint（t/type）
    const hintType = (qp.t || qp.type || "").toString();

    // 1) 抓取 + 解码（为专用/模板/兜底服务；universal 会自行再抓）
    const { html, status, detected_encoding, debugFetch } = await fetchHtml(url, wantDebug);
    if (!html || status >= 400) {
      const payload = { ok: false, url, status, error: "fetch failed" };
      if (wantDebug) payload.debug = { ...(debugFetch || {}), step: "fetch" };
      return res.status(200).json(payload);
    }

    // 2) 解析（会根据 hint/域名/结构识别选择 memoryking / templateParser / universal / generic）
    const { items, adapter_used, debugPart } = await runExtract(url, html, {
      limit,
      debug: wantDebug,
      hintType,
    });

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

    // 4) 统一 products 结构（兼容不同适配器返回）
    const products = (items || []).map(it => ({
      sku: it.sku || it.code || "",
      title: it.title || it.desc || "",
      url: it.url || it.link || "",
      link: it.link || it.url || "",
      img: it.img || (Array.isArray(it.imgs) ? it.imgs[0] : null),
      price: it.price || "",
      currency: it.currency || "",
      moq: it.moq || it.minQty || "",
    }));

    const resp = {
      ok: true,
      url,
      count: products.length,
      products,          // 前端直接使用 products
      items,             // 兼容旧字段
      adapter: adapter_used,  // 给前端 toast 显示“来源：xxx”
    };

    if (wantDebug) resp.debug = {
      ...(debugFetch || {}),
      ...(debugPart || {}),
      adapter_used,
      hintType,
    };

    return res.json(resp);
  } catch (err) {
    return res.status(200).json({ ok: false, error: String(err?.message || err) });
  }
});

export default router;
