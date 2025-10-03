// backend/adapters/memoryking.js
/**
 * Memoryking 目录/详情解析（含详情页补全“货号/型号”）
 * - 分类页：抓标题/链接/价格/图片 → 并发进入详情页 → 提取 Artikel-Nr./EAN/Hersteller 等
 * - 详情页：直接抓当前页信息
 *
 * 输出字段：
 *   - no        : 货号（= Artikel-Nr.）
 *   - sku       : 同 no
 *   - brand     : Hersteller
 *   - mpn       : Herstellernummer
 *   - ean       : EAN/GTIN
 *   - title/desc/link/img/price 等保持不变
 */

import * as cheerio from "cheerio";
import { fetchHtml, abs as absUrl } from "../lib/http.js";

// 并发控制（不要太大，Render 上抓取更稳）
const CONCURRENCY = 4;

// 判断是否详情页：/details/xxx
const isDetailUrl = (u = "") => /\/details\//i.test(String(u));

// 常见价格选择器（Shopware）
const PRICE_SELECTORS = [
  ".price--default .price--content",
  ".price--content",
  ".product--price .price",
  ".product--price",
  ".price"
];

// 分类页 item 容器（尽量宽松，但限定在 listing）
const LIST_ITEM_SEL = [
  ".product--box",
  ".listing--container .product--box",
  ".is--ctl-listing .product--box"
];

// 分类页里跳转详情的链接
const LINK_IN_ITEM_SEL = [
  "a.product--title",
  "a.product--image",
  'a[href*="/details/"]',
  "a"
];

// 图片属性兜底顺序
const IMG_ATTRS = ["data-src", "data-original", "data-lazy", "src", "file"];

/** 从若干候选 selector 中拿到文本 */
function pickText($scope, selectors = []) {
  for (const sel of selectors) {
    const t = $scope.find(sel).first().text().trim();
    if (t) return t;
  }
  return "";
}

/** 取图片 */
function pickImg($scope) {
  const img = $scope.find("img").first();
  for (const a of IMG_ATTRS) {
    const v = (img.attr(a) || "").trim();
    if (v) return v;
  }
  return "";
}

/** 从一个节点下提取 “键: 值” 键值对（覆盖 th/td、dt/dd、li、p 等） */
function scrapeKv($root) {
  const map = new Map();

  // 1) table th/td
  $root.find("table tr").each((_, tr) => {
    const th = cheerio.load(tr)("th").first().text().trim();
    const td = cheerio.load(tr)("td").first().text().trim();
    if (th && td) map.set(normKey(th), td);
  });

  // 2) dl dt/dd
  $root.find("dl").each((_, dl) => {
    const $dl = cheerio.load(dl);
    const dts = $dl("dt");
    const dds = $dl("dd");
    dts.each((i, dt) => {
      const k = cheerio.load(dt)("*").text().trim() || cheerio.load(dt).text().trim();
      const v = cheerio.load(dds[i] || "")("*").text().trim() || cheerio.load(dds[i] || "").text().trim();
      if (k && v) map.set(normKey(k), v);
    });
  });

  // 3) li / p ：尝试按冒号拆分
  $root.find("li, p").each((_, el) => {
    const txt = cheerio.load(el)("*").text().trim() || cheerio.load(el).text().trim();
    // 例如：Artikel-Nr.: 6695
    const m = txt.match(/^([^:：]+)\s*[:：]\s*(.+)$/);
    if (m) {
      const k = normKey(m[1]);
      const v = m[2].trim();
      if (k && v) map.set(k, v);
    }
  });

  return map;
}

function normKey(k = "") {
  return k
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[．。]+/g, ".")
    .replace(/[^a-z0-9äöüß\.\-]/g, "");
}

// 统一从详情页抓取关键字段
function extractDetailFields($) {
  const $scope = $(".product--base-info, .product--properties, .product--details, .product--box, body");
  const kv = scrapeKv($scope);

  // key 兼容：Artikel-Nr / Artikel-Nr. / Artikelnummer / art.-nr.
  const sku =
    kv.get("artikel-nr") ||
    kv.get("artikel-nr.") ||
    kv.get("artikelnummer") ||
    kv.get("art.-nr.") ||
    kv.get("sku") ||
    "";

  const brand =
    kv.get("hersteller") ||
    kv.get("brand") ||
    "";

  const mpn =
    kv.get("herstellernummer") ||
    kv.get("mpn") ||
    "";

  const ean =
    kv.get("ean") ||
    kv.get("gtin") ||
    "";

  return { sku: (sku || "").trim(), brand: (brand || "").trim(), mpn: (mpn || "").trim(), ean: (ean || "").trim() };
}

/** 解析详情页 → 单条 item */
function parseDetailPage($, url) {
  const title =
    $(".product--title").first().text().trim() ||
    $("h1").first().text().trim();

  const price = pickText($, PRICE_SELECTORS);
  const img = pickImg($);

  const { sku, brand, mpn, ean } = extractDetailFields($);

  const item = {
    title,
    desc: title,
    link: url,
    img,
    price,
    no: sku || "",   // “货号”列
    sku: sku || "",
    brand: brand || "",
    mpn: mpn || "",
    ean: ean || ""
  };
  return item;
}

/** 解析分类页 → 列表 items（不含编号），随后并发补齐详情 */
async function parseListingPage($, url, limit, debug) {
  const items = [];
  const host = new URL(url).origin;

  // 找每个 product box
  const boxes = $(LIST_ITEM_SEL.join(",")).toArray();
  for (const box of boxes) {
    if (items.length >= limit) break;

    const $box = $(box);
    // 详情链接（尽量指向 /details/）
    let link = "";
    for (const aSel of LINK_IN_ITEM_SEL) {
      const a = $box.find(aSel).first();
      const href = (a.attr("href") || "").trim();
      if (href) {
        link = absUrl(url, href.includes("http") ? href : href);
        if (/\/details\//i.test(link)) break;
      }
    }
    if (!link) continue; // 没链接就跳

    const title =
      $box.find(".product--title").first().text().trim() ||
      ($box.find("img[alt]").attr("alt") || "").trim() ||
      $box.text().trim();

    // 价格 + 图片
    const price = pickText($box, PRICE_SELECTORS);
    const imgRel = pickImg($box);
    const img = imgRel ? absUrl(url, imgRel) : "";

    items.push({
      title,
      desc: title,
      link,
      img,
      price
    });
  }

  if (debug) {
    console.log("[memoryking:list] found:", items.length);
  }

  // 并发抓详情页补齐
  const filled = await enrichWithDetails(items, limit, debug);

  return filled;
}

/** 并发补齐详情字段 */
async function enrichWithDetails(items, limit, debug) {
  const out = [];
  let idx = 0;

  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= items.length || out.length >= limit) return;

      const it = items[i];
      try {
        const html = await fetchHtml(it.link);
        const $d = cheerio.load(html);
        const det = parseDetailPage($d, it.link);

        out.push({
          ...it,
          ...det,               // 覆盖/补齐：no/sku/brand/mpn/ean
          img: it.img || det.img
        });
      } catch (e) {
        if (debug) console.warn("[memoryking:enrich:error]", it.link, e.message);
        out.push(it); // 至少保留基础信息
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, () => worker());
  await Promise.all(workers);
  return out.slice(0, limit);
}

/** 入口：既支持传 url/rawHtml，也兼容 { $, url, rawHtml, limit, debug } */
export default async function parseMemoryking(input, limitDefault = 50, debugDefault = false) {
  let $, pageUrl = "", rawHtml = "", limit = limitDefault, debug = debugDefault;

  if (input && typeof input === "object" && (input.$ || input.rawHtml || input.url || input.limit !== undefined || input.debug !== undefined)) {
    $ = input.$ || undefined;
    rawHtml = input.rawHtml || "";
    pageUrl = input.url || "";
    if (input.limit !== undefined) limit = input.limit;
    if (input.debug !== undefined) debug = input.debug;
  } else {
    pageUrl = String(input || "");
  }

  if (!$) {
    if (!rawHtml) rawHtml = await fetchHtml(pageUrl);
    $ = cheerio.load(rawHtml);
  }

  if (!pageUrl) pageUrl = $("base").attr("href") || "";

  // 详情页
  if (isDetailUrl(pageUrl)) {
    const item = parseDetailPage($, pageUrl);
    return [item];
  }

  // 分类页
  const list = await parseListingPage($, pageUrl, limit, debug);
  return list;
}
