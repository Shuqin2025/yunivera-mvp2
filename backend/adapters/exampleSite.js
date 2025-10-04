/**
 * exampleSite.js — 通用模板适配器 v1.1 (fix + fast mode)
 * 用途：目录页不含可靠货号，需进入详情页提取 “Artikel-Nr./SKU/MPN” 后覆写。
 * 改动点：
 *  - 修复：详情页检测不再包含 body，避免把目录页误判成详情。
 *  - 新增：fast 模式（并发↑10，重试↓1，间隔↓60–120ms，超时↓9s），默认仍是稳健参数。
 */
import * as cheerio from "cheerio";
import { fetchHtml } from "../lib/http.js";

/* ---------------- ① 站点特有配置（按站点改） ---------------- */

// 用于绝对化 URL 的回退域名（改成你的站）
const SITE_ORIGIN_FALLBACK = "https://example.com";

// 目录页卡片容器选择器（按站点挑一个能稳定命中的）
const LIST_CARD_SELECTORS = [
  ".product--box",
  ".product-card",
  ".product-item",
  ".product-tile",
  ".product",
  ".product-wrapper",
  "li.product",
  ".artbox", // 兼容常见主题
];

// 不要误抓关联/推荐等区块
const LIST_BLACKLIST = [
  ".related",
  ".cross-selling",
  ".upsell",
  ".accessories",
  ".is--ctl-detail",
].join(", ");

// 详情页主容器（⚠️ 不能包含 body，否则所有页面都会命中）
const DETAIL_ROOT =
  ".product--detail, .product--details, .product-detail, .product-page, .product-single, .detail-main, .product-view, #content .product--details";

// 识别“Artikel-Nr. / SKU / MPN / Modell / Herstellernummer”的关键词
const LABEL_RE =
  /(artikel\s*[-–—]?\s*nr|artikelnummer|art\.\s*[-–—]?\s*nr|sku|mpn|modell|model|herstellernummer)/i;

/* ---------------- ② 速度档位（新增） ---------------- */
const SPEED = {
  normal: { CONC: 3, RETRY: 3, DELAY_MIN: 220, DELAY_MAX: 440, TIMEOUT: 18000 },
  fast:   { CONC:10, RETRY: 1, DELAY_MIN:  60, DELAY_MAX: 120, TIMEOUT:  9000 },
};

/* ---------------- ③ 通用工具（通常无需改） ---------------- */

const looksLikePruef = (v) => {
  if (!v) return false;
  const s = String(v).trim();
  // 常见 Prüfziffer：≥8 位纯数字；或 48 开头 8~10 位
  return /^\d{8,}$/.test(s) || /^48\d{6,10}$/.test(s);
};

function absolutize(u, origin) {
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith("//")) return "https:" + u;
  try {
    const o = new URL(origin || SITE_ORIGIN_FALLBACK);
    if (u.startsWith("/")) return o.origin + u;
    return o.origin + "/" + u.replace(/^\.?\//, "");
  } catch {
    return u;
  }
}

const splitSrcset = (s) =>
  (s || "")
    .split(",")
    .map((x) => x.trim().split(/\s+/)[0])
    .filter(Boolean);

function bestFromImgNode($, $img, origin) {
  if (!$img || !$img.length) return "";
  const bag = new Set();
  const push = (v) => v && bag.add(absolutize(v, origin));
  push($img.attr("data-src"));
  splitSrcset($img.attr("data-srcset")).forEach(push);
  push($img.attr("data-fallbacksrc"));
  splitSrcset($img.attr("srcset")).forEach(push);
  push($img.attr("src"));
  $img.closest("picture").find("source[srcset]").each((_i, el) => {
    splitSrcset(el.attribs?.srcset || "").forEach(push);
  });
  const list = [...bag].filter(
    (u) => /\.(?:jpe?g|png|webp)(?:$|\?)/i.test(u) && !/loader\.svg/i.test(u)
  );
  if (!list.length) return "";
  const score = (u) => {
    let s = 0;
    const m = u.match(/(\d{2,4})x(\d{2,4})/);
    if (m) s += Math.min(parseInt(m[1], 10), parseInt(m[2], 10));
    if (/800x800|700x700|600x600/.test(u)) s += 100;
    if (/\.webp(?:$|\?)/i.test(u)) s += 5;
    return s;
  };
  return list.sort((a, b) => score(b) - score(a))[0];
}

function scrapeImgsFromHtml(html, origin) {
  if (!html) return [];
  const out = new Set();
  const re =
    /https?:\/\/[^"'()\s<>]+?\.(?:jpe?g|png|webp)(?:\?[^"'()\s<>]*)?/gi;
  let m;
  while ((m = re.exec(html))) out.add(m[0]);
  return [...out].map((u) => absolutize(u, origin));
}

async function getHtml(url, opts = {}) {
  const res = await fetchHtml(url, opts);
  if (typeof res === "string") return res;
  if (res && typeof res.html === "string") return res.html;
  if (res && res.buffer && typeof res.buffer.toString === "function") {
    try {
      return res.buffer.toString("utf8");
    } catch {}
  }
  return "";
}

/* ---------------- ④ 列表卡片解析（SKU 只是占位，详情覆写） ---------------- */

function readListBox($, $box, origin) {
  const title =
    $box.find(".product--title, .product-title, a[title]").first().text().trim() ||
    $box.find("a").first().attr("title") ||
    "";

  // 详情链接：优先明显的详情 URL，其次任意 <a> 的 href
  const allAs = $box
    .find("a[href]")
    .toArray()
    .map((a) => ($(a).attr("href") || "").trim())
    .filter(Boolean);
  const prefer = (sel) =>
    $box
      .find(sel)
      .toArray()
      .map((a) => ($(a).attr("href") || "").trim())
      .filter(Boolean);
  const pickBy = (arr, pats) => arr.find((h) => pats.some((p) => p.test(h)));
  const pats = [
    /\/details?\//i,
    /\/produkt\//i,
    /\/product\//i,
    /[?&]sArticle=\d+/i,
    /[?&]number=\w+/i,
  ];
  let href =
    pickBy(prefer(".product--image a, .product--info a, .product--title a"), pats) ||
    pickBy(allAs, pats) ||
    $box.attr("data-url") ||
    $box.attr("data-link") ||
    $box.attr("data-href") ||
    $box.find("[data-url],[data-link],[data-href]").attr("data-url") ||
    allAs.find((h) => /^https?:\/\//i.test(h) && !/#/.test(h)) ||
    allAs.find((h) => !/#/.test(h)) ||
    allAs[0] ||
    "";

  const url = absolutize(href, origin);

  // 图片
  let img = bestFromImgNode($, $box.find("img").first(), origin);
  if (!img) {
    const extras = scrapeImgsFromHtml($box.html() || "", origin).filter(
      (u) => !/loader\.svg/i.test(u)
    );
    if (extras.length) img = extras[0];
  }

  // 价格（尽量宽）
  const price =
    $box
      .find(
        '.price--default, .product--price, .price--content, .price--unit, .product-price, [itemprop="price"]'
      )
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim() || "";

  // SKU 仅占位（严格排除 Prüfziffer；真正值由详情覆写）
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

  if (!sku) {
    sku =
      probe($box.find('form[action*="sAdd"] input[name="sAdd"]').attr("value")) ||
      probe($box.find('input[name="sAdd"]').attr("value")) ||
      probe($box.find('a[class*="buy"],button[class*="buy"]').attr("data-ordernumber")) ||
      "";
  }

  if (!sku) {
    const inline = ($box.text() || "").replace(/\s+/g, " ");
    const m =
      inline.match(
        /(?:Artikel\s*[-–—]?\s*Nr|Artikelnummer|Art\.\s*[-–—]?\s*Nr)\.?\s*[:#]?\s*([A-Za-z0-9._\-\/]+)/i
      ) || [];
    if (m[1] && !looksLikePruef(m[1])) sku = m[1].trim();
  }

  return { sku, title, url, img, price, currency: "", moq: "" };
}

/* ---------------- ⑤ 详情页提取：强匹配“Artikel-Nr.”（屏蔽 Prüfziffer） ---------------- */

function extractSkuFromDetail($, $root, rawHtml = "") {
  // 常见 DOM：li.base-info--entry.entry--sku / .product-sku / .entry--sku ...
  const direct =
    $root.find("li.base-info--entry.entry--sku, .product-sku, .entry--sku, .sku")
      .first()
      .text()
      .trim() || "";
  let m =
    direct.match(
      /(?:Artikel\s*[-–—]?\s*Nr|Artikelnummer|Art\.\s*[-–—]?\s*Nr)\.?\s*[:#]?\s*([A-Za-z0-9._\-\/]+)/i
    ) || [];
  if (m[1] && !looksLikePruef(m[1])) return m[1].trim();

  // 遍历文本节点（显式排除含 Prüfziffer/Hersteller 的行）
  let strong = "";
  $root.find("*").each((_i, el) => {
    const txt = ($(el).text() || "").replace(/\s+/g, " ").trim();
    if (!txt) return;
    if (/Pr[üu]fziffer|Hersteller\b/i.test(txt)) return;
    const t =
      txt.match(
        /(?:Artikel\s*[-–—]?\s*Nr|Artikelnummer|Art\.\s*[-–—]?\s*Nr|SKU|MPN|Modell|Model)\.?\s*[:#]?\s*([A-Za-z0-9._\-\/]+)/i
      ) || [];
    if (t[1] && !looksLikePruef(t[1])) {
      strong = t[1].trim();
      return false;
    }
  });
  if (strong) return strong;

  // JSON-LD / Microdata
  let struct = "";
  $('script[type="application/ld+json"]').each((_i, el) => {
    try {
      const data = JSON.parse($(el).contents().text() || "{}");
      const walk = (o) => {
        if (!o || typeof o !== "object") return "";
        const take = (k) => (o[k] ? String(o[k]) : "");
        const v =
          take("sku") || take("mpn") || take("productID") || take("productId");
        if (v) return v;
        if (Array.isArray(o)) for (const it of o) { const r = walk(it); if (r) return r; }
        if (o["@graph"]) return walk(o["@graph"]);
        if (o.offers) return walk(o.offers);
        return "";
      };
      const v = walk(data);
      if (v && !looksLikePruef(v) && !struct) struct = v.trim();
    } catch {}
  });
  if (struct) return struct;

  // 结构化 <dl>/<table>
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
      if (LABEL_RE.test(th) && td && !looksLikePruef(td) && !byStruct)
        byStruct = td;
    });
  });
  if (byStruct) return byStruct;

  // 文本兜底（仍旧排除 Prüfziffer）
  const scope = ($root.text() || "") + " " + (rawHtml || "");
  const RE_LIST = [
    /(?:Artikel\s*[-–—]?\s*Nr|Artikelnummer|Art\.\s*[-–—]?\s*Nr)\.?\s*[:#]?\s*([A-Z0-9._\-\/]+)/i,
    /\bSKU\s*[:#]?\s*([A-Z0-9._\-\/]+)/i,
    /\bMPN\s*[:#]?\s*([A-Z0-9._\-\/]+)/i,
    /\b(?:Modell|Model)\s*[:#]?\s*([A-Z0-9._\-\/]+)/i,
    /\bHerstellernummer\s*[:#]?\s*([A-Z0-9._\-\/]+)/i,
  ];
  for (const re of RE_LIST) {
    const r = scope.match(re);
    if (r && r[1] && !looksLikePruef(r[1])) return r[1].trim();
  }
  return "";
}

// 可选：若站点确实会暴露 Prüfziffer，可用作“兜底以不留空”
function extractPruefFromDetail($, $root, rawHtml = "") {
  const t = ($root.text() || "") + " " + (rawHtml || "");
  let m = t.match(/Pr[üu]fziffer\s*[:#]?\s*(\d{6,})/i);
  if (m && m[1]) return m[1].trim();

  let v = "";
  $('script[type="application/ld+json"]').each((_i, el) => {
    try {
      const data = JSON.parse($(el).contents().text() || "{}");
      const walk = (o) => {
        if (!o || typeof o !== "object") return "";
        const take = (k) => (o[k] ? String(o[k]) : "");
        const s = take("sku") || take("productID") || take("productId");
        if (s) return s;
        if (Array.isArray(o)) for (const it of o) { const r = walk(it); if (r) return r; }
        if (o["@graph"]) return walk(o["@graph"]);
        if (o.offers) return walk(o.offers);
        return "";
      };
      const s = walk(data);
      if (s && looksLikePruef(s) && !v) v = s.trim();
    } catch {}
  });
  return v || "";
}

/* ---------------- ⑥ 并发 + 重试（支持速度档位） ---------------- */

async function mapWithLimit(list, conc, worker, delayMin, delayMax) {
  let i = 0;
  const runners = Array(Math.min(conc, Math.max(list.length, 1)))
    .fill(0)
    .map(async () => {
      while (i < list.length) {
        const cur = list[i++];
        await worker(cur);
        // 控制间隔，避免触发风控
        const d = delayMin + Math.floor(Math.random() * (delayMax - delayMin + 1));
        await new Promise((r) => setTimeout(r, d));
      }
    });
  await Promise.all(runners);
}

async function withRetry(fn, times = 3, delayMin = 220, delayMax = 440) {
  let lastErr;
  for (let i = 0; i <= times; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
    }
    const d = delayMin + Math.floor(Math.random() * (delayMax - delayMin + 1));
    await new Promise((r) => setTimeout(r, d));
  }
  if (lastErr) throw lastErr;
}

/* ---------------- ⑦ 入口（签名与 memoryking.js 保持一致） ---------------- */

export default async function parseExampleSite(input, limitDefault = 50, debugDefault = false) {
  let $, pageUrl = "", rawHtml = "", limit = limitDefault, debug = debugDefault, fast = false;
  if (input && typeof input === "object" && (input.$ || input.rawHtml || input.url || input.limit !== undefined || input.debug !== undefined || input.fast !== undefined)) {
    $       = input.$ || input;
    rawHtml = input.rawHtml || "";
    pageUrl = input.url || "";
    if (input.limit !== undefined) limit = input.limit;
    if (input.debug !== undefined) debug = input.debug;
    if (input.fast  !== undefined) fast  = !!input.fast;
  } else {
    $ = input;
  }

  const origin = (() => {
    try { return pageUrl ? new URL(pageUrl).origin : SITE_ORIGIN_FALLBACK; }
    catch { return SITE_ORIGIN_FALLBACK; }
  })();

  const items = [];

  // 目录/详情判定：不要用 body；用更稳的启发式
  const isDetail =
    /\/(details?|product|produkt)\//i.test(pageUrl || "") ||
    ($(DETAIL_ROOT).length > 0 && $(LIST_CARD_SELECTORS.join(", ")).length <= 2);

  // A) 目录页：只做卡片扫描（SKU 占位）
  if (!isDetail) {
    let boxes = [];
    for (const sel of LIST_CARD_SELECTORS) {
      const arr = $(sel).toArray().filter((el) => $(el).closest(LIST_BLACKLIST).length === 0);
      if (arr.length) { boxes = arr; break; }
    }
    boxes.forEach((el) => {
      const row = readListBox($, $(el), origin);
      if (row.title || row.url || row.img) items.push(row);
    });
  }

  // B) 单条详情：直接返回 1 条
  if (items.length === 0 && isDetail) {
    const $detail = $(DETAIL_ROOT);
    const title =
      $detail.find(".product--title, .product-title").first().text().trim() ||
      $("h1").first().text().trim() ||
      "";

    const url =
      absolutize($('link[rel="canonical"]').attr("href") || "", origin) ||
      absolutize(($('meta[property="og:url"]').attr("content") || "").trim(), origin) ||
      (pageUrl || "");

    let img = $('meta[property="og:image"]').attr("content") || "";
    if (!img) img = bestFromImgNode($, $detail.find("img").first(), origin);
    if (!img) {
      const extras = scrapeImgsFromHtml(rawHtml || ($.root().html() || ""), origin).filter(u => !/loader\.svg/i.test(u));
      if (extras.length) img = extras[0];
    }

    const price =
      $detail
        .find('.price--default, .product--price, .product-price, .price--content, .price--unit, [itemprop="price"]')
        .first()
        .text()
        .replace(/\s+/g, " ")
        .trim() || "";

    let sku = extractSkuFromDetail($, $detail, rawHtml);
    if (!sku) sku = extractPruefFromDetail($, $detail, rawHtml); // 兜底以不留空

    const row = { sku, title, url, img, price, currency: "", moq: "" };
    if (row.title || row.url || row.img) return [row];
  }

  // C) 统一进入详情覆写 SKU（并发 + 重试，按速度档位）
  const mode = fast ? SPEED.fast : SPEED.normal;

  const headers = {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": "de-DE,de;q=0.9,en;q=0.8",
    "accept-encoding": "gzip, deflate, br",
    "upgrade-insecure-requests": "1",
    "cache-control": "no-cache",
    pragma: "no-cache",
    referer: pageUrl || origin,
  };

  await mapWithLimit(
    items,
    mode.CONC,
    async (row) => {
      if (!row || !row.url) return;

      const html = await withRetry(
        () => getHtml(row.url, { headers, timeout: mode.TIMEOUT }),
        mode.RETRY,
        mode.DELAY_MIN,
        mode.DELAY_MAX
      ).catch(() => "");
      if (!html || html.length < 300) return;

      const $$ = cheerio.load(html, { decodeEntities: false });
      const $root = $$(DETAIL_ROOT);

      let sku = extractSkuFromDetail($$, $root, html);
      if (!sku) sku = extractPruefFromDetail($$, $root, html); // 不留空
      if (sku) row.sku = sku.trim();

      if (!row.price) {
        const p = $root
          .find('.price--default, .product--price, .product-price, .price--content, .price--unit, [itemprop="price"]')
          .first()
          .text()
          .replace(/\s+/g, " ")
          .trim();
        if (p) row.price = p;
      }

      if (!row.img || /loader\.svg/i.test(row.img)) {
        let im = $$('meta[property="og:image"]').attr("content") || "";
        if (!im) im = bestFromImgNode($$, $root.find("img").first(), new URL(row.url).origin);
        if (im) row.img = im;
      }
    },
    mode.DELAY_MIN,
    mode.DELAY_MAX
  );

  const out = items.slice(0, limit);
  if (debug) console.log("[exampleSite] mode=%s items=%d sample=%o", fast ? "fast" : "normal", out.length, out[0]);
  return out;
}
