/**
 * Memoryking 适配器（鲁棒版 v3.6 / 列表强纠 SKU + 详情兜底）
 *  - 列表：优先从 data-ordernumber / itemprop=sku / 文本“Artikel-Nr”就地读取；严格排除 Prüfziffer/Hersteller
 *  - 列表：对“全部条目”并发进入详情页，用 Artikel-Nr/MPN 强制覆盖（防止拿到 Prüfziffer）
 *  - 详情：图片/价格/sku 全兜底
 */

import * as cheerio from "cheerio";
import { fetchHtml } from "../lib/http.js";

export default async function parseMemoryking(input, limitDefault = 50, debugDefault = false) {
  // ---- 入参自适配（兼容旧式只传 $ ）----
  let $, pageUrl = "", rawHtml = "", limit = limitDefault, debug = debugDefault;
  if (input && typeof input === "object" && (input.$ || input.rawHtml || input.url || input.limit !== undefined || input.debug !== undefined)) {
    $       = input.$ || input;            // 也支持直接传 $
    rawHtml = input.rawHtml || "";
    pageUrl = input.url || "";
    if (input.limit !== undefined) limit = input.limit;
    if (input.debug !== undefined) debug = input.debug;
  } else {
    $ = input; // 旧式：直接传 $
  }

  const items = [];

  // ---------- 工具 ----------
  const origin = (() => {
    try { return pageUrl ? new URL(pageUrl).origin : "https://www.memoryking.de"; }
    catch { return "https://www.memoryking.de"; }
  })();

  const abs = (u) => {
    if (!u) return "";
    if (/^https?:\/\//i.test(u)) return u;
    if (u.startsWith("//")) return "https:" + u;
    return origin + (u.startsWith("/") ? u : "/" + u);
  };

  const fromSrcset = (s) =>
    (s || "").split(",").map(x => x.trim().split(/\s+/)[0]).filter(Boolean);

  const squareSize = (u) => {
    const m = u && u.match(/(\d{2,4})x\1\b/);
    return m ? parseInt(m[1], 10) : 0;
  };

  const scoreImg = (u) => {
    if (!u) return -1e9;
    let s = 0;
    const sz = squareSize(u);
    if (sz) s += Math.min(sz, 1200);
    if (sz >= 600) s += 10;
    if (/600x600|700x700|800x800/i.test(u)) s += 120;
    if (/@2x\b/i.test(u)) s += 150;
    if (/(\?|&)format=webp\b/i.test(u)) s += 5;
    if (/\.webp(?:$|\?)/i.test(u)) s += 5;
    else if (/\.jpe?g(?:$|\?)/i.test(u)) s += 3;
    else if (/\.png(?:$|\?)/i.test(u)) s += 2;
    if (/meinecloud\.io|cloudfront|cdn/i.test(u)) s += 10;
    return s;
  };

  const scrapeUrlsFromHtml = (html) => {
    if (!html) return [];
    const out = new Set();
    const re = /https?:\/\/[^"'()\s<>]+?\.(?:jpe?g|png|webp)(?:\?[^"'()\s<>]*)?/ig;
    let m; while ((m = re.exec(html))) out.add(m[0]);
    return [...out];
  };

  const bestFromImgNode = ($img) => {
    if (!$img || !$img.length) return "";
    const cand = new Set();
    const ds  = $img.attr("data-src");           if (ds) cand.add(ds);
    const dss = $img.attr("data-srcset");        if (dss) fromSrcset(dss).forEach(u => cand.add(u));
    const fb  = $img.attr("data-fallbacksrc");   if (fb) cand.add(fb);
    const ss  = $img.attr("srcset");             if (ss) fromSrcset(ss).forEach(u => cand.add(u));
    const s   = $img.attr("src");                if (s && !/loader\.svg/i.test(s)) cand.add(s);
    const real = [...cand].map(abs).filter(u => /\.(jpe?g|png|webp)(?:$|\?)/i.test(u) && !/loader\.svg/i.test(u));
    if (!real.length) return "";
    real.sort((a, b) => scoreImg(b) - scoreImg(a));
    return real[0];
  };

  const collectBestImg = ($root) => {
    const cand = new Set();

    $root.find("picture source[srcset]").each((_, el) => {
      const ss = el.attribs?.srcset || "";
      fromSrcset(ss).forEach(u => cand.add(u));
    });

    $root.find("img").each((_, el) => {
      const $img = $(el);
      const best = bestFromImgNode($img);
      if (best) cand.add(best);

      const extras = [
        $img.attr("data-src"),
        $img.attr("data-fallbacksrc"),
        $img.attr("src")
      ].filter(Boolean);
      const ss1 = $img.attr("data-srcset") || $img.attr("srcset") || "";
      if (ss1) fromSrcset(ss1).forEach(u => extras.push(u));
      extras.forEach(u => cand.add(u));
    });

    $root.find(".image--element").each((_, el) => {
      const $el = $(el);
      ["data-img-large","data-original","data-img-small","data-zoom-image","data-img","data-src"]
        .forEach(k => { const v = $el.attr(k); if (v) cand.add(v); });
    });

    $root.find("*").each((_, node) => {
      const attrs = node.attribs || {};
      for (const k in attrs) {
        const v = attrs[k] || "";
        if (/\.(jpe?g|png|webp)(?:$|\?)/i.test(v)) cand.add(v);
      }
    });

    const html = $root.html() || "";
    scrapeUrlsFromHtml(html).forEach(u => cand.add(u));

    const real = [...cand].map(abs).filter(u => u && /\.(jpe?g|png|webp)(?:$|\?)/i.test(u) && !/loader\.svg/i.test(u));
    if (!real.length) return "";
    real.sort((a, b) => scoreImg(b) - scoreImg(a));
    return real[0];
  };

  // —— 列表卡片读取（就地尝试 SKU，排除 Prüfziffer）
  const readListBox = ($box) => {
    const title =
      $box.find(".product--title, .product--info a, a[title]").first().text().trim() ||
      $box.find("a").first().attr("title") || "";

    // 详情链接：多模式匹配
    const links = $box.find("a[href]").map((_, a) => ($(a).attr("href") || "").trim()).get().filter(Boolean);
    const firstMatch = (patterns) => links.find(h => patterns.some(p => p.test(h)));

    let href =
      firstMatch([/\/details\//i, /\/detail\//i, /[?&]sArticle=\d+/i, /\/product\//i, /\/prod\//i, /\/artikel\//i]) ||
      $box.attr("data-url") || $box.attr("data-link") || $box.attr("data-href") ||
      $box.find("[data-url],[data-link],[data-href]").attr("data-url") ||
      links.find(h => /^https?:\/\//i.test(h) && !/#/.test(h)) ||
      links.find(h => !/#/.test(h)) ||
      links[0] || "";
    href = abs(href);

    // 图片：先 img，再容器，再源码直扫
    const firstImg = $box.find("img").first();
    let img = bestFromImgNode(firstImg);
    if (!img) img = collectBestImg($box);
    if (!img) {
      const boxHtml = $box.html() || "";
      const best = scrapeUrlsFromHtml(boxHtml)
        .map(abs)
        .filter(u => /\.(jpe?g|png|webp)(?:$|\?)/i.test(u) && !/loader\.svg/i.test(u))
        .sort((a, b) => scoreImg(b) - scoreImg(a))[0];
      img = best || "";
    }
    if (img && /loader\.svg/i.test(img)) img = "";

    const price =
      $box.find('.price--default, .product--price, .price--content, .price--unit, [itemprop="price"]')
        .first().text().replace(/\s+/g, " ").trim() || "";

    // —— 就地尝试 SKU（严格排除 Prüfziffer/Hersteller）
    let sku = "";

    // 1) data-ordernumber / data-sku / itemprop="sku"
    const dataSku =
      $box.attr("data-ordernumber") ||
      $box.find("[data-ordernumber]").attr("data-ordernumber") ||
      $box.attr("data-sku") ||
      $box.find("[data-sku]").attr("data-sku") ||
      $box.find('[itemprop="sku"]').attr("content") ||
      $box.find('[itemprop="sku"]').text();
    if (dataSku && !/Pr[üu]fziffer|Hersteller/i.test(String(dataSku))) sku = String(dataSku).trim();

    // 2) 卡片文本里显式的 “Artikel-Nr:”
    if (!sku) {
      const inline = ($box.text() || "").replace(/\s+/g, " ");
      const m = inline.match(/Artikel\s*[-–—]?\s*Nr\.?\s*[:#]?\s*([A-Za-z0-9._\-\/]+)/i);
      if (m && m[1]) sku = m[1].trim();
    }

    return { sku, title, url: href, img, price, currency: "", moq: "" };
  };

  // ====== 判定是否详情页 ======
  let isDetail =
    /\/details\//i.test(pageUrl || "") ||
    $(".product--detail, .product--details").length > 0 ||
    (String($('meta[property="og:type"]').attr("content") || "").toLowerCase() === "product");

  if (!isDetail) {
    $('script[type="application/ld+json"]').each((_i, el) => {
      try {
        const raw = $(el).contents().text() || "";
        if (!raw) return;
        const data = JSON.parse(raw);
        const check = (obj) => {
          if (!obj) return false;
          const t = obj["@type"];
          if (t === "Product") return true;
          if (Array.isArray(t) && t.includes("Product")) return true;
          if (obj["@graph"]) return Array.isArray(obj["@graph"]) && obj["@graph"].some(check);
          return false;
        };
        if (Array.isArray(data)) {
          if (data.some(check)) isDetail = true;
        } else if (check(data)) {
          isDetail = true;
        }
      } catch {}
    });
  }

  // ---------- ① 列表 ----------
  if (!isDetail) {
    const listSelectors = [
      ".listing--container .product--box",
      ".js--isotope .product--box",
      "#listing .product--box",
      ".product--listing .product--box",
    ];
    const BLACKLIST = [
      ".product--detail", ".product--details", "#detail",
      ".cross-selling", ".crossselling", ".related", ".related--products",
      ".similar--products", ".upselling", ".accessories", ".accessory--slider",
      ".product-slider--container", ".product--slider", ".is--ctl-detail"
    ].join(", ");

    let boxes = [];
    for (const sel of listSelectors) {
      const arr = $(sel).toArray().filter(el => $(el).closest(BLACKLIST).length === 0);
      if (arr.length) { boxes = arr; break; }
    }

    if (boxes.length) {
      boxes.forEach((el) => {
        const row = readListBox($(el));
        if (row.title || row.url || row.img) items.push(row);
      });
    }
  }

  // ---------- ② 详情兜底（单页） ----------
  if (items.length === 0 || isDetail) {
    const $detail = $(".product--details, .product--detail, #content, body");

    const title =
      $detail.find(".product--title").first().text().trim() ||
      $("h1").first().text().trim() || "";

    const url =
      abs($('link[rel="canonical"]').attr("href") || "") ||
      abs(($('meta[property="og:url"]').attr("content") || "").trim()) ||
      (pageUrl || "");

    let img = $('meta[property="og:image"]').attr("content") || "";
    if (!img) img = bestFromImgNode($detail.find("img").first());
    if (!img) img = collectBestImg($detail);
    if (!img) {
      const pageHtml = rawHtml || ($.root().html() || "");
      img = (scrapeUrlsFromHtml(pageHtml)
        .map(abs)
        .filter(u => /\.(jpe?g|png|webp)(?:$|\?)/i.test(u) && !/loader\.svg/i.test(u))
        .sort((a, b) => scoreImg(b) - scoreImg(a))[0]) || "";
    }
    img = abs(img);

    const price =
      $detail.find('.price--default, .product--price, .price--content, .price--unit, [itemprop="price"]').first()
        .text().replace(/\s+/g, " ").trim() || "";

    const sku = extractSkuFromDetail($, $detail, rawHtml);

    const row = { sku, title, url, img, price, currency: "", moq: "" };
    if (row.img && /loader\.svg/i.test(row.img)) row.img = "";
    if (row.title || row.url || row.img) {
      return [row];
    }
  }

  // ---------- ③ 列表并发进入详情页「强制纠正 SKU」 ----------
  const needDeep = items.filter(r => r && r.url);
  await mapWithLimit(needDeep, 4, async (row) => {
    try {
      const html = await fetchHtml(row.url);
      if (!html) return;
      const $$ = cheerio.load(html, { decodeEntities: false });
      const $root = $$(".product--details, .product--detail, #content, body");

      const sku = extractSkuFromDetail($$, $root, html);
      if (sku) row.sku = sku.trim();

      if (!row.price) {
        const p = $root.find('.price--default, .product--price, .price--content, .price--unit, [itemprop="price"]')
          .first().text().replace(/\s+/g, " ").trim();
        if (p) row.price = p;
      }

      if (!row.img || /loader\.svg/i.test(row.img)) {
        let im = $$('meta[property="og:image"]').attr("content") || "";
        if (!im) im = bestFromImgNode($root.find("img").first());
        if (!im) im = collectBestImg($root);
        if (im) row.img = im;
      }
    } catch {/* 单个失败忽略 */}
  });

  const out = items
    .map(r => (r && r.img && /loader\.svg/i.test(r.img) ? { ...r, img: "" } : r))
    .slice(0, limit);

  if (debug) console.log("[memoryking] list=%d first=%o", out.length, out[0]);
  return out;
}

/* -------------------- 辅助方法 -------------------- */

async function mapWithLimit(list, limit, worker) {
  let i = 0;
  const runners = Array(Math.min(limit, list.length)).fill(0).map(async () => {
    while (i < list.length) {
      const cur = list[i++];
      await worker(cur);
    }
  });
  await Promise.all(runners);
}

// 从详情页提取 SKU / MPN / 型号（优先 Artikel-Nr，排除 Prüfziffer/Hersteller）
function extractSkuFromDetail($, $detail, rawHtml = "") {
  let skuStrong = "";
  $detail.find("*").each((_i, el) => {
    const txt = ($(el).text() || "").replace(/\s+/g, " ").trim();
    // 先抓 Artikel-Nr
    let m = txt.match(/Artikel\s*[-–—]?\s*Nr\.?\s*[:#]?\s*([A-Za-z0-9._\-\/]+)/i);
    if (m && m[1]) { skuStrong = m[1].trim(); return false; }
    // 显式排除 Prüfziffer/Hersteller
    if (/Pr[üu]fziffer|Hersteller\b/i.test(txt)) return;
    // 其它可接受标签
    m = txt.match(/\b(?:SKU|MPN|Modell|Model|Herstellernummer)\b[^A-Za-z0-9]*([A-Za-z0-9._\-\/]+)/i);
    if (!skuStrong && m && m[1]) { skuStrong = m[1].trim(); return false; }
  });
  if (skuStrong) return skuStrong;

  // JSON-LD
  let skuFromJson = "";
  $('script[type="application/ld+json"]').each((_i, el) => {
    try {
      const raw = $(el).contents().text() || "";
      if (!raw) return;
      const data = JSON.parse(raw);
      const pick = (obj) => {
        if (!obj || typeof obj !== "object") return "";
        if (obj.sku) return String(obj.sku);
        if (obj.mpn) return String(obj.mpn);
        if (obj.productID || obj.productId) return String(obj.productID || obj.productId);
        if (Array.isArray(obj)) for (const it of obj) { const v = pick(it); if (v) return v; }
        if (obj["@graph"]) return pick(obj["@graph"]);
        if (obj.offers) return pick(obj.offers);
        if (obj.brand) return pick(obj.brand);
        return "";
      };
      const v = pick(data);
      if (v && !skuFromJson) skuFromJson = v.trim();
    } catch {}
  });
  if (skuFromJson) return skuFromJson;

  // 结构化标签
  const LABEL_RE = /(artikel\s*[-–—]?\s*nr|sku|mpn|modell|model|herstellernummer)/i;

  let sku = "";
  $detail.find("dl").each((_, dl) => {
    const $dl = $(dl);
    $dl.find("dt").each((_i2, dt) => {
      const t = $(dt).text().replace(/\s+/g, " ").trim();
      if (LABEL_RE.test(t)) {
        const v = ($(dt).next("dd").text() || "").replace(/\s+/g, " ").trim();
        if (v && !sku) sku = v;
      }
    });
  });
  if (sku) return sku;

  $detail.find("table").each((_, tb) => {
    const $tb = $(tb);
    $tb.find("tr").each((_i2, tr) => {
      const th = $(tr).find("th,td").first().text().replace(/\s+/g, " ").trim();
      const td = $(tr).find("td").last().text().replace(/\s+/g, " ").trim();
      if (LABEL_RE.test(th) && td && !sku) sku = td;
    });
  });
  if (sku) return sku;

  $detail.find("li, .product--properties *, .product--attributes *").each((_i2, el) => {
    const txt = ($(el).text() || "").replace(/\s+/g, " ").trim();
    let m = txt.match(/\b(Artikel\s*[-–—]?\s*Nr\.?|SKU|MPN|Modell|Model|Herstellernummer)\b[^A-Za-z0-9]*([A-Za-z0-9._\-\/]+)/i);
    if (m && m[2] && !sku) { sku = m[2].trim(); return false; }
    if (!sku && LABEL_RE.test(txt)) {
      const next = ($(el).next().text() || "").replace(/\s+/g, " ").trim();
      if (next) { sku = next; return false; }
    }
  });
  if (sku) return sku;

  // 文本兜底
  const scopeText = ($detail.text() || "") + " " + (rawHtml || "");
  const RE_LIST = [
    /Artikel\s*[-–—]?\s*Nr\.?\s*[:#]?\s*([A-Z0-9._\-\/]+)/i,
    /\bSKU\s*[:#]?\s*([A-Z0-9._\-\/]+)/i,
    /\bMPN\s*[:#]?\s*([A-Z0-9._\-\/]+)/i,
    /\b(?:Modell|Model)\s*[:#]?\s*([A-Z0-9._\-\/]+)/i,
    /\bHerstellernummer\s*[:#]?\s*([A-Z0-9._\-\/]+)/i,
  ];
  for (const re of RE_LIST) {
    const m = scopeText.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return "";
}
