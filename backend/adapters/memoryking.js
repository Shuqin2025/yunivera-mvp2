/**
 * Memoryking 适配器（鲁棒版 v4.4）
 * 目标：
 *  1) 列表页不误抓 Prüfziffer（如 48680368），只要 Artikel-Nr.（SKU/MPN/Model 亦可兜底）
 *  2) 无论列表有没有抓到，始终并发进入详情页，把“Artikel-Nr.”回填覆盖到列表行
 *  3) 详情页显式屏蔽 “Prüfziffer / Hersteller” 行，避免串位；新增对 li.base-info--entry.entry--sku 的直取
 */

import * as cheerio from "cheerio";
import { fetchHtml } from "../lib/http.js";

/** 是否疑似 Prüfziffer：8 位及以上纯数字，或以 48 开头的 8~10 位数字 */
const looksLikePruef = (v) => {
  if (!v) return false;
  const s = String(v).trim();
  return (/^\d{8,}$/.test(s) || /^48\d{6,10}$/.test(s));
};

/** 绝对地址 */
function absolutize(u, origin) {
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith("//")) return "https:" + u;
  try {
    const o = new URL(origin || "https://www.memoryking.de");
    if (u.startsWith("/")) return o.origin + u;
    return o.origin + "/" + u.replace(/^\.?\//, "");
  } catch {
    return u;
  }
}

/** srcset 拆分 */
const splitSrcset = (s) =>
  (s || "").split(",").map(x => x.trim().split(/\s+/)[0]).filter(Boolean);

/** 从 <img> 或 <picture> 里挑一张“最像真实商品图”的链接 */
function bestFromImgNode($, $img, origin) {
  if (!$img || !$img.length) return "";
  const bag = new Set();
  const push = (v) => { if (v) bag.add(absolutize(v, origin)); };

  // 常见懒加载属性
  push($img.attr("data-src"));
  splitSrcset($img.attr("data-srcset")).forEach(push);
  push($img.attr("data-fallbacksrc"));
  splitSrcset($img.attr("srcset")).forEach(push);
  push($img.attr("src"));

  // picture/source
  $img.closest("picture").find("source[srcset]").each((_, el) => {
    splitSrcset(el.attribs?.srcset || "").forEach(push);
  });

  const list = [...bag].filter(u =>
    /\.(?:jpe?g|png|webp)(?:$|\?)/i.test(u) && !/loader\.svg/i.test(u)
  );
  if (!list.length) return "";

  // 简单按分辨率/格式打分
  list.sort((a, b) => {
    const score = (u) => {
      let s = 0;
      const m = u.match(/(\d{2,4})x(\d{2,4})/);
      if (m) s += Math.min(parseInt(m[1],10), parseInt(m[2],10));
      if (/800x800|700x700|600x600/.test(u)) s += 100;
      if (/\.webp(?:$|\?)/i.test(u)) s += 5;
      return s;
    };
    return score(b) - score(a);
  });
  return list[0];
}

/** 从任意 html 文本中扫出所有图片 URL（兜底用） */
function scrapeImgsFromHtml(html, origin) {
  if (!html) return [];
  const out = new Set();
  const re = /https?:\/\/[^"'()\s<>]+?\.(?:jpe?g|png|webp)(?:\?[^"'()\s<>]*)?/ig;
  let m; while ((m = re.exec(html))) out.add(m[0]);
  return [...out].map(u => absolutize(u, origin));
}

/** 详情页：提取 SKU/MPN/Model（优先 Artikel-Nr.；显式排除 Prüfziffer/Hersteller） */
function extractSkuFromDetail($, $root, rawHtml = "") {
  // 0) 你截图中的强选择器（Shopware 5 常见）：
  const fromLi = $root.find("li.base-info--entry.entry--sku").first().text().trim();
  let m0 = fromLi.match(/Artikel\s*[-–—]?\s*Nr\.?\s*[:#]?\s*([A-Za-z0-9._\-\/]+)/i);
  if (m0 && m0[1] && !looksLikePruef(m0[1])) return m0[1].trim();

  // A) 整块扫描优先抓 “Artikel-Nr.”，并排除 “Prüfziffer / Hersteller”
  let strong = "";
  $root.find("*").each((_i, el) => {
    const txt = ($(el).text() || "").replace(/\s+/g, " ").trim();

    if (/Pr[üu]fziffer|Hersteller\b/i.test(txt)) return; // 显式屏蔽

    let m = txt.match(/Artikel\s*[-–—]?\s*Nr\.?\s*[:#]?\s*([A-Za-z0-9._\-\/]+)/i);
    if (m && m[1]) { strong = m[1].trim(); return false; }

    m = txt.match(/\b(?:SKU|MPN|Modell|Model|Herstellernummer)\b[^A-Za-z0-9]*([A-Za-z0-9._\-\/]+)/i);
    if (!strong && m && m[1] && !looksLikePruef(m[1])) { strong = m[1].trim(); return false; }
  });
  if (strong) return strong;

  // B) JSON-LD / 结构化数据
  let struct = "";
  $('script[type="application/ld+json"]').each((_i, el) => {
    try {
      const raw = $(el).contents().text() || "";
      if (!raw) return;
      const data = JSON.parse(raw);
      const walk = (obj) => {
        if (!obj || typeof obj !== "object") return "";
        const take = (k) => obj[k] ? String(obj[k]) : "";
        const v = take("sku") || take("mpn") || take("productID") || take("productId");
        if (v) return v;
        if (Array.isArray(obj)) for (const it of obj) { const r = walk(it); if (r) return r; }
        if (obj["@graph"]) return walk(obj["@graph"]);
        if (obj.offers) return walk(obj.offers);
        return "";
      };
      const v = walk(data);
      if (v && !looksLikePruef(v) && !struct) struct = v.trim();
    } catch {}
  });
  if (struct) return struct;

  // C) <dl>/<table> 结构
  const LABEL_RE = /(artikel\s*[-–—]?\s*nr|sku|mpn|modell|model|herstellernummer)/i;
  let byStruct = "";

  $root.find("dl").each((_, dl) => {
    $(dl).find("dt").each((_i2, dt) => {
      const t = $(dt).text().replace(/\s+/g, " ").trim();
      if (LABEL_RE.test(t)) {
        const v = ($(dt).next("dd").text() || "").replace(/\s+/g, " ").trim();
        if (v && !looksLikePruef(v) && !byStruct) byStruct = v;
      }
    });
  });
  if (byStruct) return byStruct;

  $root.find("table").each((_, tb) => {
    $(tb).find("tr").each((_i2, tr) => {
      const th = $(tr).find("th,td").first().text().replace(/\s+/g, " ").trim();
      const td = $(tr).find("td").last().text().replace(/\s+/g, " ").trim();
      if (LABEL_RE.test(th) && td && !looksLikePruef(td) && !byStruct) byStruct = td;
    });
  });
  if (byStruct) return byStruct;

  // D) 文本兜底（仍然屏蔽 Prüfziffer）
  const scope = ($root.text() || "") + " " + (rawHtml || "");
  const RE_LIST = [
    /Artikel\s*[-–—]?\s*Nr\.?\s*[:#]?\s*([A-Z0-9._\-\/]+)/i,
    /\bSKU\s*[:#]?\s*([A-Z0-9._\-\/]+)/i,
    /\bMPN\s*[:#]?\s*([A-Z0-9._\-\/]+)/i,
    /\b(?:Modell|Model)\s*[:#]?\s*([A-Z0-9._\-\/]+)/i,
    /\bHerstellernummer\s*[:#]?\s*([A-Z0-9._\-\/]+)/i,
  ];
  for (const re of RE_LIST) {
    const m = scope.match(re);
    if (m && m[1] && !looksLikePruef(m[1])) return m[1].trim();
  }
  return "";
}

/** 从链接里兜底取参数（?number= / ?sArticle=） */
function skuFromHrefParam(u) {
  try {
    const url = new URL(u);
    const cand = url.searchParams.get("number") || url.searchParams.get("sArticle");
    if (cand && !looksLikePruef(cand)) return cand.trim();
  } catch {}
  return "";
}

/** 列表卡片读取（SKU 只做“安全来源” + 强排除 Prüfziffer；最终由详情页覆盖） */
function readListBox($, $box, origin) {
  // 标题
  const title =
    $box.find(".product--title, .product--info a, a[title]").first().text().trim() ||
    $box.find("a").first().attr("title") || "";

  // 详情链接（放宽匹配，务必拿到）
  const links = $box.find("a[href]").map((_, a) => ($(a).attr("href") || "").trim()).get().filter(Boolean);
  const firstMatch = (patterns) => links.find(h => patterns.some(p => p.test(h)));
  let href =
    firstMatch([/\/details\//i, /\/detail\//i, /\/produkt\//i, /\/product\//i, /[?&]sArticle=\d+/i, /[?&]number=\w+/i]) ||
    $box.attr("data-url") || $box.attr("data-link") || $box.attr("data-href") ||
    $box.find("[data-url],[data-link],[data-href]").attr("data-url") ||
    links.find(h => /^https?:\/\//i.test(h) && !/#/.test(h)) ||
    links.find(h => !/#/.test(h)) ||
    links[0] || "";
  const url = absolutize(href, origin);

  // 图片
  let img = bestFromImgNode($, $box.find("img").first(), origin);
  if (!img) {
    const html = $box.html() || "";
    const extra = scrapeImgsFromHtml(html, origin).filter(u => !/loader\.svg/i.test(u));
    if (extra.length) img = extra[0];
  }

  // 价格（展示用）
  const price =
    $box.find('.price--default, .product--price, .price--content, .price--unit, [itemprop="price"]')
      .first().text().replace(/\s+/g, " ").trim() || "";

  // —— 列表上的“安全 SKU 来源”（严格排除 Prüfziffer）
  const probe = (v) => (v && !looksLikePruef(v) ? String(v).trim() : "");
  let sku =
    probe($box.attr("data-ordernumber")) ||
    probe($box.attr("data-number")) ||
    probe($box.attr("data-sku")) ||
    probe($box.attr("data-product-ordernumber")) ||
    probe($box.find("[data-ordernumber]").attr("data-ordernumber")) ||
    probe($box.find("[data-number]").attr("data-number")) ||
    probe($box.find("[data-sku]").attr("data-sku")) ||
    probe($box.find("[data-product-ordernumber]").attr("data-product-ordernumber")) ||
    "";

  // 购物表单/按钮里的货号
  if (!sku) {
    sku =
      probe($box.find('form[action*="sAdd"] input[name="sAdd"]').attr("value")) ||
      probe($box.find('input[name="sAdd"]').attr("value")) ||
      probe($box.find('a[class*="buy"],button[class*="buy"]').attr("data-ordernumber")) ||
      "";
  }

  // 可见文本里的 “Artikel-Nr.”
  if (!sku) {
    const inline = ($box.text() || "").replace(/\s+/g, " ");
    const m = inline.match(/Artikel\s*[-–—]?\s*Nr\.?\s*[:#]?\s*([A-Za-z0-9._\-\/]+)/i);
    if (m && m[1] && !looksLikePruef(m[1])) sku = m[1].trim();
  }

  // 最后从详情链接参数里兜底
  if (!sku) sku = skuFromHrefParam(url);

  return { sku, title, url, img, price, currency: "", moq: "" };
}

/** 小并发执行器 */
async function mapWithLimit(list, limit, worker) {
  let i = 0;
  const n = Math.min(limit, Math.max(list.length, 1));
  const runners = Array(n).fill(0).map(async () => {
    while (i < list.length) {
      const cur = list[i++];
      await worker(cur);
      // 轻微间隔，降低被风控概率
      await new Promise(r => setTimeout(r, 130 + Math.floor(Math.random()*90)));
    }
  });
  await Promise.all(runners);
}

/** 小重试 */
async function withRetry(fn, times = 2, delayMs = 240) {
  let lastErr;
  for (let i = 0; i <= times; i++) {
    try { return await fn(); }
    catch (e) { lastErr = e; }
    await new Promise(r => setTimeout(r, delayMs));
  }
  if (lastErr) throw lastErr;
}

export default async function parseMemoryking(input, limitDefault = 50, debugDefault = false) {
  // ------- 入参整理 -------
  let $, pageUrl = "", rawHtml = "", limit = limitDefault, debug = debugDefault;

  if (input && typeof input === "object" && (input.$ || input.rawHtml || input.url || input.limit !== undefined || input.debug !== undefined)) {
    $       = input.$ || input;
    rawHtml = input.rawHtml || "";
    pageUrl = input.url || "";
    if (input.limit !== undefined) limit = input.limit;
    if (input.debug !== undefined) debug = input.debug;
  } else {
    $ = input; // 兼容只传 $
  }

  const origin = (() => {
    try { return pageUrl ? new URL(pageUrl).origin : "https://www.memoryking.de"; }
    catch { return "https://www.memoryking.de"; }
  })();

  const items = [];

  // ========== A. 列表页 ==========
  const isDetail =
    /\/details\//i.test(pageUrl || "") ||
    $(".product--detail, .product--details").length > 0;

  if (!isDetail) {
    const SELECTORS = [
      ".listing--container .product--box",
      ".js--isotope .product--box",
      "#listing .product--box",
      ".product--listing .product--box",
      ".is--ctl-listing .product--box",
    ];
    const BLACKLIST = [
      ".product--detail", ".product--details", "#detail",
      ".cross-selling", ".crossselling", ".related", ".related--products",
      ".similar--products", ".upselling", ".accessories", ".accessory--slider",
      ".product-slider--container", ".product--slider", ".is--ctl-detail",
    ].join(", ");

    let boxes = [];
    for (const sel of SELECTORS) {
      const arr = $(sel).toArray().filter(el => $(el).closest(BLACKLIST).length === 0);
      if (arr.length) { boxes = arr; break; }
    }

    boxes.forEach(el => {
      const row = readListBox($, $(el), origin);
      if (row.title || row.url || row.img) items.push(row);
    });
  }

  // ========== B. 详情页（单条） ==========
  if (items.length === 0 && isDetail) {
    const $detail = $(".product--details, .product--detail, #content, body");

    const title =
      $detail.find(".product--title").first().text().trim() ||
      $("h1").first().text().trim() || "";

    const url =
      absolutize($('link[rel="canonical"]').attr("href") || "", origin) ||
      absolutize(($('meta[property="og:url"]').attr("content") || "").trim(), origin) ||
      (pageUrl || "");

    let img = $('meta[property="og:image"]').attr("content") || "";
    if (!img) img = bestFromImgNode($, $detail.find("img").first(), origin);
    if (!img) {
      const html = rawHtml || ($.root().html() || "");
      const extras = scrapeImgsFromHtml(html, origin).filter(u => !/loader\.svg/i.test(u));
      if (extras.length) img = extras[0];
    }

    const price =
      $detail.find('.price--default, .product--price, .price--content, .price--unit, [itemprop="price"]').first()
        .text().replace(/\s+/g, " ").trim() || "";

    const sku = extractSkuFromDetail($, $detail, rawHtml);

    const row = { sku, title, url, img, price, currency: "", moq: "" };
    if (row.title || row.url || row.img) return [row];
  }

  // ========== C. 并发进入详情页，强制用详情页“Artikel-Nr.”覆盖 ==========
  const hdrs = {
    "user-agent"                : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    "accept"                    : "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language"           : "de-DE,de;q=0.9,en;q=0.8",
    "upgrade-insecure-requests" : "1",
    "cache-control"             : "no-cache",
    "pragma"                    : "no-cache",
    "referer"                   : pageUrl || origin,
  };

  // 目录页一定执行回填（哪怕列表已猜到 sku，也以详情页为准）
  await mapWithLimit(items, 4, async (row) => {
    if (!row || !row.url) return;

    // 带重试抓详情
    const html = await withRetry(
      () => fetchHtml(row.url, { headers: hdrs }),
      2, 260
    ).catch(() => "");

    if (!html || html.length < 300) return;

    const $$ = cheerio.load(html, { decodeEntities: false });
    const $root = $$(".product--details, .product--detail, #content, body");

    const sku = extractSkuFromDetail($$, $root, html);
    if (sku) row.sku = sku.trim(); // ← 用详情页“Artikel-Nr.”统一覆盖

    if (!row.price) {
      const p = $root.find('.price--default, .product--price, .price--content, .price--unit, [itemprop="price"]')
        .first().text().replace(/\s+/g, " ").trim();
      if (p) row.price = p;
    }

    if (!row.img || /loader\.svg/i.test(row.img)) {
      let im = $$('meta[property="og:image"]').attr("content") || "";
      if (!im) im = bestFromImgNode($$, $root.find("img").first(), new URL(row.url).origin);
      if (im) row.img = im;
    }
  });

  const out = items.slice(0, limit);
  if (debug) console.log("[memoryking/v4.4] total=%d sample=%o", out.length, out[0]);
  return out;
}
