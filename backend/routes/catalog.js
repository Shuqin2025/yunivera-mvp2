// backend/routes/catalog.js
const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const jschardet = require("jschardet");
const iconv = require("iconv-lite");
const { URL: NodeURL } = require("url");

const router = express.Router();

// ---------- helpers ----------
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function abs(base, href) {
  try {
    return new NodeURL(href || "", base).toString();
  } catch {
    return href || "";
  }
}

async function downloadPage(url) {
  const res = await axios.get(url, {
    responseType: "arraybuffer",
    headers: {
      "User-Agent": UA,
      "Accept-Language": "zh-CN,zh;q=0.8,en;q=0.7",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    },
    timeout: 20000,
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 400,
  });

  const buf = Buffer.from(res.data);
  let enc = "utf-8";
  try {
    const det = jschardet.detect(buf);
    if (det?.encoding) enc = det.encoding.toLowerCase();
  } catch {}
  if (/gbk|gb2312/.test(enc)) enc = "gb18030";

  let html;
  try {
    html = iconv.decode(buf, enc);
  } catch {
    html = buf.toString();
  }
  return { html, encoding: enc, status: res.status };
}

function pickAttr($el, names) {
  for (const n of names) {
    const v = ($el.attr(n) || "").trim();
    if (v) return v;
  }
  return "";
}

function parseList(html, baseUrl, { limit = 50, debug = false } = {}) {
  const $ = cheerio.load(html, { decodeEntities: false });

  // 兜底容器/条目选择器（按你同事建议）
  const tried = { container: [], item: [] };
  const containerSelectors = [
    "#productlist",
    ".productlist",
    ".listing-container",
    ".products",
    "main",
    "body",
  ];
  let $container = null;
  for (const sel of containerSelectors) {
    tried.container.push(sel);
    const $c = $(sel).first();
    if ($c.length) {
      $container = $c;
      break;
    }
  }
  if (!$container) $container = $("body");

  const itemSelectors = [
    "#productlist ul > li",
    ".product-box, .product, .product__item",
    "ul > li",
    "li",
  ];

  let items = [];
  let itemSelectorUsed = "";
  for (const sel of itemSelectors) {
    tried.item.push(sel);
    const $cands = $container.find(sel);
    if ($cands.length) {
      itemSelectorUsed = sel;
      $cands.slice(0, limit).each((i, el) => {
        const $el = $(el);
        const $a = $el.find("a[href]").first();
        const href = $a.attr("href") || "";
        const $img = $el.find("img").first();
        const imgSrc = pickAttr($img, [
          "src",
          "data-src",
          "data-original",
          "data-lazy",
          "data-img",
        ]);

        const title =
          pickAttr($a, ["title"]) ||
          pickAttr($img, ["alt"]) ||
          $el.find("h3,h4,.title").first().text().trim() ||
          $a.text().trim() ||
          $el.text().trim().split("\n")[0].trim();

        items.push({
          sku: title,
          desc: title,
          minQty: "",
          price: "",
          img: imgSrc ? abs(baseUrl, imgSrc) : "",
          link: href ? abs(baseUrl, href) : abs(baseUrl, $a.attr("href") || ""),
        });
      });
      break;
    }
  }

  const out = {
    ok: true,
    url: baseUrl,
    count: items.length,
    products: [],
    items,
  };

  if (debug) {
    out.debug = {
      container_matched: !!$container?.length,
      item_selector_used: itemSelectorUsed,
      item_count: items.length,
      tried,
      // 方便你肉眼校对
      first_item_html:
        items.length && itemSelectorUsed
          ? $.html($container.find(itemSelectorUsed).first())
          : "",
    };
  }

  return out;
}

// ---------- main handlers ----------
async function handleParse(req, res) {
  try {
    const isPost = req.method === "POST";
    const q = isPost ? req.body || {} : req.query || {};
    const url = (q.url || "").trim();
    const limit = Math.max(
      1,
      Math.min(parseInt(q.limit || "50", 10) || 50, 200),
    );
    const debug =
      q.debug === 1 || q.debug === "1" || q.debug === true || q.debug === "true";

    if (!url) {
      return res.status(400).json({ ok: false, error: "missing url" });
    }

    const t0 = Date.now();
    const { html, encoding } = await downloadPage(url);
    const out = parseList(html, url, { limit, debug });
    out.ms = Date.now() - t0;

    if (debug) {
      out.debug = out.debug || {};
      out.debug.detected_encoding = encoding;
    }

    return res.json(out);
  } catch (err) {
    return res
      .status(500)
      .json({ ok: false, error: err?.message || "parse failed" });
  }
}

router.get("/v1/api/catalog/parse", handleParse);
router.post("/v1/api/catalog/parse", handleParse);

module.exports = router;
