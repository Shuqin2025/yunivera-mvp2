// backend/adapters/sinotronic.js
// 适配 http://www.sinotronic-e.com/ 这类纯静态 HTML（GBK/GB2312）

import axios from "axios";
import * as cheerio from "cheerio";
import jschardet from "jschardet";
import iconv from "iconv-lite";
import { URL as NodeURL } from "url";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

export function canHandle(inputUrl = "") {
  try {
    const u = new NodeURL(inputUrl);
    return /(^|\.)sinotronic-e\.com$/i.test(u.hostname);
  } catch {
    return false;
  }
}

async function fetchHtmlWithDecode(url) {
  const resp = await axios.get(url, {
    responseType: "arraybuffer",
    headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
    timeout: 20000,
    validateStatus: (s) => s >= 200 && s < 400,
  });

  const buf = Buffer.from(resp.data);
  let enc = "utf-8";
  const det = jschardet.detect(buf);
  if (det?.encoding?.toLowerCase().includes("gb")) enc = "gb18030";
  const html = iconv.decode(buf, enc);
  return { html, encoding: enc, status: resp.status };
}

function abs(origin, href = "") {
  try {
    return new NodeURL(href, origin).href;
  } catch {
    return href || "";
  }
}
const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

/** 适配器主函数：传入 url（路由已经抓调试信息，这里再抓一次最稳） */
export async function parse(inputUrl, options = {}) {
  const { limit = 50, debug = false } = options;

  const dbg = {
    tried: { container: [], item: [] },
    detected_encoding: "",
    container_matched: "",
    item_selector_used: "",
    first_item_html: "",
    item_count: 0,
  };

  const { html, encoding } = await fetchHtmlWithDecode(inputUrl);
  dbg.detected_encoding = encoding;

  const $ = cheerio.load(html, { decodeEntities: false });
  const base = new NodeURL(inputUrl).origin;

  // —— 容器兜底（把你们核对的放前面）——
  const CONTAINERS = [
    "#productlist",
    ".editor#productlist",
    ".productlist",
    "#productList",
    ".product-list",
    ".list",
    ".lists",
    ".contentlist",
    "ul.prolist",
    "ul.products",
  ];

  // —— 条目兜底 ——（优先你给的）
  const ITEM_FALLBACK = [
    "#productlist ul > li",
    "ul > li",
    ".product",
    ".product_item",
    ".product-box",
    ".productbox",
    ".list-item",
    ".pro-item",
    ".item",
  ];

  let $container = null;
  for (const sel of CONTAINERS) {
    dbg.tried.container.push(sel);
    const hit = $(sel);
    if (hit && hit.length) {
      $container = hit.first();
      dbg.container_matched = sel;
      break;
    }
  }
  if (!$container) {
    $container = $("body");
    dbg.container_matched = "body";
  }

  let $items = $();
  for (const isel of ITEM_FALLBACK) {
    dbg.tried.item.push(isel);
    const found = $container.find(isel);
    if (found && found.length) {
      $items = found;
      dbg.item_selector_used = isel;
      break;
    }
  }
  if (!$items || !$items.length) {
    const fallback = $container.find("li");
    if (fallback && fallback.length) {
      $items = fallback;
      dbg.item_selector_used = "li (fallback)";
    }
  }

  const out = [];
  $items.each((i, el) => {
    if (out.length >= Number(limit || 50)) return false;

    const it = $(el);
    if (!dbg.first_item_html) dbg.first_item_html = $.html(it).slice(0, 2000);

    const a = it.find("a[href]").first();
    const href = abs(base, a.attr("href") || "");

    const img = it.find("img").first();
    let imgSrc = img.attr("src") || img.attr("data-src") || img.attr("data-original") || "";
    imgSrc = abs(base, imgSrc);

    const title = norm(
      img.attr("alt") ||
        a.attr("title") ||
        a.text() ||
        it.find("h3,h4,h5").first().text() ||
        it.text()
    );

    if (!title && !href && !imgSrc) return;

    out.push({
      sku: title,
      desc: title,
      minQty: "",
      price: "",
      img: imgSrc,
      link: href || inputUrl,
    });
  });

  dbg.item_count = out.length;

  const payload = { ok: true, url: inputUrl, products: [], items: out };
  if (debug) payload.debug = dbg;
  return payload;
}

// 也提供默认导出（兼容旧写法）
export default { canHandle, parse };
