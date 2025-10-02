import express from "express";
import cors from "cors";
import axios from "axios";
import * as cheerio from "cheerio";

// ✅ 新增：memoryking 适配器（仅此一行）
import parseMemoryking from "./adapters/memoryking.js";
// ✅ 新增：sinotronic 适配器（仅此一行）
import sino from "./adapters/sinotronic.js";
// ✅ 新增：universal 适配器（仅此一行）
import parseUniversal from "./adapters/universal.js";

const app = express();
app.use(cors({ origin: "*", exposedHeaders: ["X-Lang"] }));

/* ──────────────────────────── health ──────────────────────────── */
app.get(["/", "/healthz", "/health", "/api/health"], (_req, res) =>
  res.type("text/plain").send("ok")
);
// JSON 版健康检查（前端更易用）
app.get("/v1/api/health", (_req, res) => {
  res.json({ ok: true, status: "up", ts: Date.now() });
});

app.get("/v1/api/__version", (_req, res) => {
  res.json({
    version: "mvp-universal-parse-2025-09-16-b64-img+aliases+cards",
    note:
      "Add /v1/api/image64 & parse?img=base64; aliases for /v1/api/catalog*; robust query; add generic card parser for static HTML & PHP/WordPress (div/li[class*=product]).",
  });
});

/* ──────────────────────────── utils ──────────────────────────── */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function fetchHtml(targetUrl) {
  const { data } = await axios.get(targetUrl, {
    headers: {
      "User-Agent": UA,
      "Accept-Language": "de,en;q=0.8,zh;q=0.6",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      Referer: targetUrl,
    },
    timeout: 25000,
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 400,
  });
  return typeof data === "string" ? data : "";
}

function abs(base, maybe) {
  if (!maybe) return "";
  try {
    return new URL(maybe, base).href;
  } catch {
    return "";
  }
}
function text($el) {
  return ($el.text() || "").replace(/\s+/g, " ").trim();
}
function guessSkuFromTitle(title) {
  if (!title) return "";
  const m =
    title.match(/\b[0-9]{4,}\b/) ||
    title.match(/\b[0-9A-Z]{4,}(?:-[0-9A-Z]{2,})*\b/i);
  return m ? m[0] : "";
}

function normalizePrice(str) {
  if (!str) return "";
  const s = String(str).replace(/\s+/g, " ").trim();
  const m =
    s.match(/€\s*\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})/) ||
    s.match(/\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})\s*€/) ||
    s.match(/\d+[.,]\d{2}/);
  if (!m) return s;
  let v = m[0].replace(/\s+/g, " ");
  if (!/[€]/.test(v)) v = "€ " + v;
  return v;
}

function priceFromJsonLd($) {
  let price = "", currency = "€";
  $('script[type="application/ld+json"]').each((_i, el) => {
    try {
      const raw = $(el).contents().text().trim();
      if (!raw) return;
      const data = JSON.parse(raw);
      const arr = Array.isArray(data) ? data : [data];
      for (const obj of arr) {
        if (!obj) continue;
        const t = obj["@type"];
        const isProduct = t === "Product" || (Array.isArray(t) && t.includes("Product"));
        if (!isProduct) continue;
        let offers = obj.offers;
        offers = Array.isArray(offers) ? offers[0] : offers;
        const p = offers?.price ?? offers?.lowPrice ?? offers?.highPrice;
        if (p != null && p !== "") {
          price = String(p);
          currency = offers.priceCurrency || currency;
          break;
        }
      }
    } catch {}
  });
  if (price) {
    if (/eur|€/i.test(currency)) currency = "€";
    return normalizePrice(`${currency} ${price}`);
  }
  return "";
}

/* ──────────────────────────── image proxy ──────────────────────────── */
// 二进制（默认）
app.get("/v1/api/image", async (req, res) => {
  const url = String(req.query.url || "").trim();
  const format = String(req.query.format || "").toLowerCase();
  if (!url) return res.status(400).send("missing url");
  try {
    const r = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 20000,
      headers: {
        "User-Agent": UA,
        Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
        // 有些站点会校验来源域，不要随便带别的站：
        Referer: new URL(url).origin + "/",
      },
      validateStatus: (s) => s >= 200 && s < 400,
    });

    const ct = r.headers["content-type"] || "image/jpeg";
    // 显式 CORS（尽管全局 cors 已处理，加上更稳）
    res.set("Access-Control-Allow-Origin", "*");

    if (format === "base64") {
      const base64 = Buffer.from(r.data).toString("base64");
      return res.json({
        ok: true,
        contentType: ct,
        base64: `data:${ct};base64,${base64}`,
      });
    }

    res.set("Content-Type", ct);
    res.set("Cache-Control", "public, max-age=604800");
    res.send(r.data);
  } catch (e) {
    console.error("[image] fail:", e?.message || e);
    res.status(502).send("image fetch failed");
  }
});

// 显式 base64（和上面等价，便于前端书写）
app.get("/v1/api/image64", async (req, res) => {
  req.query.format = "base64";
  return app._router.handle(req, res, () => {});
});

/* ──────────────────────────── site: auto-schmuck.com ──────────────────────────── */
async function parseAutoSchmuck(listUrl, limit = 50) {
  const html = await fetchHtml(listUrl);
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();

  // 优先从每个卡片上找去详情的 a（避免 “Anzeigen” 按钮）
  $(".artbox, .artbox-inner, .artbox-wrap, .product-wrapper, .product, .isotope-item")
    .add("div,li,article")
    .each((_i, el) => {
      if (items.length >= limit) return false;
      const $card = $(el);
      // 必须要有图片
      const $img = $card.find("img").first();
      if (!$img.length) return;

      // 选择不是 “Anzeigen/查看/按钮类”的链接
      let $a = $card
        .find("a[href]")
        .filter((_, a) => !/anzeigen|anmelden|login|cart|filter/i.test(text($(a))))
        .first();
      if (!$a.length) return;

      const href = abs(listUrl, $a.attr("href") || "");
      if (!href || seen.has(href)) return;

      // 标题优先取 a 的 title/文本，其次取 h3/h2，再兜底 alt
      const title =
        ($a.attr("title") || "").trim() ||
        text($card.find("h3,h2").first()) ||
        text($a) ||
        ($img.attr("alt") || "").trim();
      if (!title) return;

      const srcFromSet = ($img.attr("srcset") || "")
        .split(/\s+/)
        .find((s) => /^https?:/i.test(s));
      const src =
        $img.attr("data-src") ||
        $img.attr("data-original") ||
        srcFromSet ||
        $img.attr("src") ||
        "";
      const img = abs(listUrl, (src || "").split("?")[0]);

      // 价格：卡片内文本或显式 price 类
      let priceTxt = text(
        $card.find(
          ".price,.product-price,.price-tag,.artbox-price,.product-list-price,.amount"
        ).first()
      );
      if (!priceTxt) {
        const m = $card.text().match(
          /\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})\s*(?:€|EUR)/i
        );
        if (m) priceTxt = m[0].replace(/\s+/g, " ");
      }

      items.push({
        sku: guessSkuFromTitle(title),
        title,
        url: href,
        img,
        price: priceTxt || null,
        currency: "",
        moq: "",
      });
    });

  return items.slice(0, limit);
}

/* ──────────────────────────── site: s-impuls-shop.de ──────────────────────────── */
async function parseSImpulsCatalog(listUrl, limit = 50) {
  const html = await fetchHtml(listUrl);
  const $ = cheerio.load(html);

  let cardRoots = $("#nx_content .listproduct-wrapper .listproduct");
  const candidates = [
    { item: ".listproduct .product, .listproduct > div" },
    { item: "div.product-layout, div.product-thumb, div.product-grid .product-layout" },
    { item: ".row .product-layout, .row .product-thumb" },
  ];

  const items = [];
  function pickImg($card) {
    let $img = $card.find(".image img").first().length
      ? $card.find(".image img").first()
      : $card.find("img").first();
    let src =
      $img.attr("data-src") ||
      $img.attr("data-original") ||
      ($img.attr("srcset") || "").split(" ").find((s) => /^https?:/i.test(s)) ||
      $img.attr("src") ||
      "";
    return abs(listUrl, (src || "").split("?")[0]);
  }
  function pushItem(aEl) {
    if (items.length >= limit) return;
    const $a = $(aEl);
    const href = $a.attr("href") || "";
    if (!href || !/\/product\//.test(href)) return;

    const title = ($a.attr("title") || "").trim() || text($a);
    let $card = $a.closest("div");
    if ($card.length === 0) $card = $a.parent();
    const img = pickImg($card);
    const priceTxt =
      text($card.find(".price, .product-price, .amount, .m-price").first()) || "";
    const skuTxt =
      text($card.find(".product-model, .model, .sku").first()) ||
      guessSkuFromTitle(title);

    items.push({
      sku: skuTxt,
      title,
      url: abs(listUrl, href),
      img,
      price: priceTxt || null,
      currency: "",
      moq: "",
    });
  }

  if (cardRoots.length) cardRoots.find('a[href*="/product/"]').each((_i, a) => pushItem(a));
  if (items.length === 0) {
    for (const c of candidates) {
      const $cards = $(c.item);
      if ($cards.length === 0) continue;
      $cards.each((_i, el) =>
        $(el).find('a[href*="/product/"]').each((_j, a) => pushItem(a))
      );
      if (items.length > 0) break;
    }
  }
  return items;
}

/* ──────────────────────────── Generic 卡片解析（新增） ──────────────────────────── */
/** 更贴近“静态 HTML / PHP（织梦/WordPress）”页面结构：
 *  - 直接按“卡片容器”选择：div[class*=product], li[class*=product], article[class*=product]
 *  - 卡片中找第一个指向详情的 <a> 与第一张 <img>
 *  - 价格从常见类名与整卡文本兜底匹配
 */
function parseByCardSelectors($, listUrl, limit = 50) {
  const items = [];
  const seen = new Set();

  // 常见卡片容器
  const CARD_SEL = [
    'div[class*="product"]',
    'li[class*="product"]',
    'article[class*="product"]',
    '.product-item',
    '.product-card',
    '.prod-item',
    '.good, .goods, .item',
  ].join(", ");

  const BAD_LINK = /(add-to-cart|wishlist|compare|login|register|cart|filter|sort)/i;

  $(CARD_SEL).each((_i, el) => {
    if (items.length >= limit) return false;
    const $card = $(el);

    // 图
    const $img = $card.find("img").first();
    let src =
      $img.attr("data-src") ||
      $img.attr("data-original") ||
      ($img.attr("srcset") || "").split(" ").find((s) => /^https?:/i.test(s)) ||
      $img.attr("src") ||
      "";
    const img = abs(listUrl, (src || "").split("?")[0]);

    // 链接：第一个合格的 a[href]
    let $a = $card.find("a[href]").filter((_, a) => !BAD_LINK.test(String($(a).attr("href")))).first();
    if (!$a.length) return; // 没有详情链接不收

    let href = abs(listUrl, $a.attr("href") || "");
    if (!href || seen.has(href)) return;

    // 标题：a 的 title/文本 -> h3/h2/h1 -> img alt
    const title =
      ($a.attr("title") || "").trim() ||
      text($card.find("h3,h2,h1").first()) ||
      text($a) ||
      ($img.attr("alt") || "").trim();

    if (!title) return;

    // 价格：常见类名兜底
    let priceTxt =
      text(
        $card.find(
          ".price,.product-price,.amount,.money,.m-price,.price--default,.price__value"
        ).first()
      ) || "";
    if (!priceTxt) {
      const m = $card.text().match(/\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})\s*(?:€|EUR)/i);
      if (m) priceTxt = m[0].replace(/\s+/g, " ");
    }

    items.push({
      sku: text($card.find(".sku,.product-sku,.model,.product-model").first()) || guessSkuFromTitle(title),
      title,
      url: href,
      img,
      price: priceTxt || null,
      currency: "",
      moq: "",
    });
  });

  return items;
}

/* ──────────────────────────── WooCommerce (保留) ──────────────────────────── */
function parseWooFromHtml($, listUrl, limit = 50) {
  const items = [];
  const $cards = $("ul.products li.product");
  if (!$cards.length) return items;

  $cards.each((_i, li) => {
    if (items.length >= limit) return;

    const $li = $(li);
    const $a = $li.find("a.woocommerce-LoopProduct-link").first().length
      ? $li.find("a.woocommerce-LoopProduct-link").first()
      : $li.find("a[href]").first();

    const href = $a.attr("href") || "";
    const title =
      text($li.find(".woocommerce-loop-product__title").first()) ||
      ($a.attr("title") || "").trim() ||
      text($a) ||
      "";

    const $img = $li.find("img").first();
    const src =
      $img.attr("data-src") ||
      $img.attr("data-original") ||
      ($img.attr("srcset") || "").split(" ").find((s) => /^https?:/i.test(s)) ||
      $img.attr("src") ||
      "";

    const priceTxt =
      text($li.find(".price .amount").first()) || text($li.find(".price").first()) || "";

    if (!href || !title) return;
    items.push({
      sku: guessSkuFromTitle(title),
      title,
      url: abs(listUrl, href),
      img: abs(listUrl, (src || "").split("?")[0]),
      price: priceTxt || null,
      currency: "",
      moq: "",
    });
  });

  return items;
}

/* ──────────────────────────── Generic（原“超通用链接”回退） ──────────────────────────── */
function parseGenericFromHtml($, listUrl, limit = 50) {
  const items = [];
  const seen = new Set();

  const stopWord = /^(EUR|USD|GBP|CHF|CNY|HKD|JPY|AUD|CAD)$/i;

  const anchors = $("a[href]")
    .toArray()
    .filter((a) => {
      const $a = $(a);
      const t = text($a);
      if (!t || t.length <= 2 || stopWord.test(t)) return false;
      const href = $a.attr("href") || "";
      try {
        const u = new URL(href, listUrl);
        const p = (u.pathname || "").toLowerCase();
        const isDetail = /(product|produkt|artikel|item|sku|detail|details|view)/.test(p);
        const isBad =
          /\.(jpg|jpeg|png|webp|gif|svg)$/i.test(p) ||
          /(add-to-cart|cart|login|wishlist|compare|filter)/i.test(u.search + p);
        return isDetail && !isBad;
      } catch {
        return false;
      }
    });

  for (const a of anchors) {
    if (items.length >= limit) break;
    const $a = $(a);
    let href = $a.attr("href") || "";
    try {
      href = new URL(href, listUrl).href;
    } catch {
      continue;
    }

    let $card = $a.closest("li,article,div");
    if (!$card.length) $card = $a.parent();

    const txtAll = $card.text();
    const hasPrice = /\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})\s*(?:€|EUR)/i.test(txtAll);
    const hasImg = $card.find("img").length > 0;
    if (!hasImg && !hasPrice) continue;

    const $img = $card.find("img").first();
    let src =
      $img.attr("data-src") ||
      $img.attr("data-original") ||
      ($img.attr("srcset") || "").split(" ").find((s) => /^https?:/i.test(s)) ||
      $img.attr("src") ||
      "";
    const img = abs(listUrl, (src || "").split("?")[0]);

    const title =
      ($a.attr("title") || "").trim() ||
      text($card.find("h3,h2,a").first()) ||
      text($a);
    const priceTxt =
      text(
        $card
          .find(".price,.product-price,.amount,.money,.price--default")
          .first()
      ) || (txtAll.match(/\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})\s*(?:€|EUR)/i)?.[0] || "");

    if (!title) continue;

    items.push({
      sku: guessSkuFromTitle(title),
      title,
      url: href,
      img,
      price: priceTxt || null,
      currency: "",
      moq: "",
    });
  }

  return items;
}

/* ──────────────────────────── 详情富化（价格/MOQ） ──────────────────────────── */
async function enrichDetail(item) {
  try {
    const html = await fetchHtml(item.url);
    const $ = cheerio.load(html);

    let priceText = priceFromJsonLd($);
    if (!priceText) {
      const sel = [
        "meta[itemprop='price']",
        "[itemprop='price']",
        ".woocommerce-Price-amount",
        ".price .amount",
        ".price .value",
        ".product-price",
        ".price-value",
        ".amount",
        ".price",
      ].join(", ");
      const $node = $(sel).first();
      const raw = ($node.attr("content") || text($node) || "").trim();
      if (raw) priceText = normalizePrice(raw);
    }

    const moqSel =
      ".moq, .min-order, .minimum, .minbestellmenge, .minimum-order, .minimum__value";
    const moqText = text($(moqSel).first());

    if (priceText) item.price = priceText;
    if (moqText) item.moq = moqText;
  } catch {}
}

/* ──────────────────────────── 统一入口 ──────────────────────────── */
async function parseUniversalCatalog(listUrl, limit = 50) {
  try {
    const host = new URL(listUrl).hostname;

    // ✅ memoryking.de
    if (host.includes("memoryking.de")) {
      const html = await fetchHtml(listUrl);
      const $ = cheerio.load(html, { decodeEntities: false });
      return await parseMemoryking({ $, url: listUrl, rawHtml: html, limit });
    }

    // ✅ sinotronic-e.com（自动翻页）
    if (host.includes("sinotronic-e.com")) {
      // 分页样式：/list/?{category}_{page}.html
      const re = /(\?\d+_)(\d+)\.html$/i;
      const makeUrl = (p) => (re.test(listUrl) ? listUrl.replace(re, (_, a) => `${a}${p}.html`) : null);

      const maxPages = 20; // 安全上限
      const seenKey = new Set();
      const out = [];

      // 第 1 页
      const firstHtml = await fetchHtml(listUrl);
      let $ = cheerio.load(firstHtml, { decodeEntities: false });
      let part = sino.parse($, listUrl, { limit });
      for (const it of part || []) {
        const key = it.url || it.img || it.title || "";
        if (!key || seenKey.has(key)) continue;
        seenKey.add(key);
        out.push(it);
        if (out.length >= limit) break;
      }

      // 后续页
      for (let p = 2; p <= maxPages && out.length < limit; p++) {
        const nextUrl = makeUrl(p);
        if (!nextUrl) break;

        const html = await fetchHtml(nextUrl);
        $ = cheerio.load(html, { decodeEntities: false });
        part = sino.parse($, nextUrl, { limit: limit - out.length }) || [];
        if (!part.length) break;

        let add = 0;
        for (const it of part) {
          const key = it.url || it.img || it.title || "";
          if (!key || seenKey.has(key)) continue;
          seenKey.add(key);
          out.push(it);
          add++;
          if (out.length >= limit) break;
        }
        if (!add) break;
      }

      return out;
    }

// ✅ s-impuls-shop.de（自动翻页，健壮版 v2：清洗无值 page 参数 + 收集页码 + 猜测式翻页）
if (host.includes("s-impuls-shop.de")) {
  const maxPages = 50;              // 安全上限
  const out = [];
  const visited = new Set();

  // 0) 清洗：去掉尾部无值的 ?page / &page / ?p / &p，避免出现 xxx/catalog/home-cinema&page 这种无效地址
  listUrl = listUrl.replace(/[?&](page|p)(=[^&]*)?$/i, "");

  // 单页抓取（保持你现有的解析函数）
  const harvest = async (pageUrl) => {
    const html = await fetchHtml(pageUrl);
    const $ = cheerio.load(html, { decodeEntities: false });
    const part = await parseSImpulsCatalog(pageUrl, limit - out.length);
    for (const it of part || []) {
      out.push(it);
      if (out.length >= limit) break;
    }
    return $;
  };

  // 1) 先抓第 1 页
  let $ = await harvest(listUrl);
  if (out.length >= limit) return out;

  // 2) 在分页区域里收集“所有页码链接”，支持 ?page= / ?p= / /page/2 三种
  const pageSet = new Map(); // pageNo -> url
  const addPage = (href) => {
    if (!href) return;
    const full = abs(listUrl, href);
    try {
      const u = new URL(full);
      // 常见 query 参数：page / p / seite
      let n =
        parseInt(
          u.searchParams.get("page") ||
            u.searchParams.get("p") ||
            u.searchParams.get("seite") ||
            "",
          10
        ) || 0;
      // 路由式 /page/2
      if (!n) {
        const m = u.pathname.match(/\/page\/(\d+)/i);
        if (m) n = parseInt(m[1], 10) || 0;
      }
      if (n && n > 1 && !pageSet.has(n)) pageSet.set(n, u.href);
    } catch {}
  };

  // 常见的分页容器/链接
  $(
    ".pagination a[href], nav.pagination a[href], .pager a[href], .page-pagination a[href], .page-numbers a[href]"
  ).each((_i, a) => addPage($(a).attr("href")));

  // 3) 如果没收集到明确页码，用“猜测式翻页”试探：?page=N / ?p=N / /page/N
  const makeCandidates = (base, n) => {
    const u = new URL(base);
    const sep = u.search ? "&" : "?";
    return [
      `${u.origin}${u.pathname}${u.search}${sep}page=${n}${u.hash}`,
      `${u.origin}${u.pathname}${u.search}${sep}p=${n}${u.hash}`,
      `${u.origin}${u.pathname.replace(/\/$/, "")}/page/${n}${u.search}${u.hash}`,
    ];
  };
  const firstKey = (items) => (items?.[0]?.link || items?.[0]?.url || items?.[0]?.href || "").trim();

  if (pageSet.size === 0) {
    let n = 2;
    let lastFirst = firstKey(out);
    while (n <= maxPages && out.length < limit) {
      let advanced = false;
      for (const tryUrl of makeCandidates(listUrl, n)) {
        if (visited.has(tryUrl)) continue;
        let html = "";
        try { html = await fetchHtml(tryUrl); } catch {}
        if (!html) continue;

        const $$ = cheerio.load(html, { decodeEntities: false });
        const part = await parseSImpulsCatalog(tryUrl, limit - out.length);
        if (part && part.length) {
          const fk = firstKey(part);
          // 与上一页首条不同，认为翻页成功（避免同页重复）
          if (!fk || fk !== lastFirst) {
            for (const it of part) {
              out.push(it);
              if (out.length >= limit) break;
            }
            visited.add(tryUrl);
            lastFirst = fk || lastFirst;
            advanced = true;
            break;
          }
        }
      }
      if (!advanced) break; // 三种格式都失败，停止
      n += 1;
    }
    return out;
  }

  // 4) 正常路径：有明确页码链接，按页号升序抓
  const pages = [...pageSet.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, href]) => href)
    .slice(0, maxPages - 1);

  for (const pageUrl of pages) {
    if (out.length >= limit) break;
    if (visited.has(pageUrl)) continue;
    $ = await harvest(pageUrl);
  }

  return out;
}

    if (host.includes("auto-schmuck.com")) {
      return await parseAutoSchmuck(listUrl, limit);
    }
  } catch {}

  // ✅ 新增兜底：尝试外部 universal 适配器（若成功且有数据，直接返回）
  try {
    const uni = await parseUniversal({ url: listUrl, limit });
    if (Array.isArray(uni) && uni.length) return uni;
  } catch {}

  const html = await fetchHtml(listUrl);
  const $ = cheerio.load(html);

  // ① 通用卡片解析
  const cardItems = parseByCardSelectors($, listUrl, limit);
  if (cardItems.length) return cardItems;

  // ② WooCommerce
  const wcCards = $("ul.products li.product");
  if (wcCards.length) return parseWooFromHtml($, listUrl, limit);

  // ③ 超通用回退
  return parseGenericFromHtml($, listUrl, limit);
}

/* ──────────────────────────── API: 解析 ──────────────────────────── */
app.get("/v1/api/catalog/parse", async (req, res) => {
  // 兼容多种参数名（url/u/link/l）
  const listUrl =
    String(req.query.url ?? req.query.u ?? req.query.link ?? req.query.l ?? "").trim();

  const limit = Math.max(
    1,
    Math.min(parseInt(String(req.query.limit || "50"), 10) || 50, 200)
  );

  const enrich = String(req.query.enrich || "").toLowerCase() === "true";
  const enrichCount = Math.min(
    parseInt(String(req.query.enrichCount || "20"), 10) || 20,
    limit
  );

  // 可选：把前 N 张图片直接塞成 base64 一并返回
  const wantImgBase64 = String(req.query.img || "") === "base64";
  const imgCount = Math.min(
    parseInt(String(req.query.imgCount || "0"), 10) || 0,
    limit
  );

  if (!listUrl) return res.status(400).json({ ok: false, error: "missing url" });

  const t0 = Date.now();
  try {
    const items = await parseUniversalCatalog(listUrl, limit);
    if (enrich && items.length) {
      await Promise.all(items.slice(0, enrichCount).map(enrichDetail));
    }

    if (wantImgBase64 && imgCount > 0) {
      await Promise.all(
        items.slice(0, imgCount).map(async (it) => {
          if (!it.img) return;
          try {
            const r = await axios.get(it.img, {
              responseType: "arraybuffer",
              timeout: 15000,
              headers: {
                "User-Agent": UA,
                Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
                Referer: new URL(it.img).origin + "/",
              },
              validateStatus: (s) => s >= 200 && s < 400,
            });
            const ct = r.headers["content-type"] || "image/jpeg";
            it.img_b64 = `data:${ct};base64,${Buffer.from(r.data).toString("base64")}`;
          } catch {}
        })
      );
    }

    res.setHeader("X-Lang", "de");
    res.json({ ok: true, url: listUrl, count: items.length, products: items, items });
    console.log("[parse:done]", {
      url: listUrl,
      count: items.length,
      ms: Date.now() - t0,
      enrich,
      enrichCount,
      wantImgBase64,
      imgCount,
    });
  } catch (err) {
    console.error("[parse:fail]", {
      url: listUrl,
      ms: Date.now() - t0,
      err: String(err?.message || err),
    });
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// 兼容别名：/v1/api/parse
app.get("/v1/api/parse", (req, res) =>
  app._router.handle(
    {
      ...req,
      url:
        "/v1/api/catalog/parse" +
        (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""),
    },
    res,
    () => {}
  )
);

// ✅ 兼容老路径：/v1/api/catalog 与 *.json 变体
app.get(["/v1/api/catalog", "/v1/api/catalog.json", "/v1/api/catalog/parse.json"], (req, res) =>
  app._router.handle(
    {
      ...req,
      url:
        "/v1/api/catalog/parse" +
        (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""),
    },
    res,
    () => {}
  )
);

/* ──────────────────────────── listen ──────────────────────────── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[mvp2-backend] listening on :${PORT}`));
