// adapters/memoryking.js
import axios from "axios";
import * as cheerio from "cheerio";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function abs(base, maybe) {
  if (!maybe) return "";
  try { return new URL(maybe, base).href; } catch { return ""; }
}
function text($el) { return ($el.text() || "").replace(/\s+/g, " ").trim(); }

async function fetchHtml(url) {
  const { data } = await axios.get(url, {
    headers: {
      "User-Agent": UA,
      "Accept-Language": "de,en;q=0.8,zh;q=0.6",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      Referer: url,
    },
    timeout: 25000,
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 400,
  });
  return typeof data === "string" ? data : "";
}

/** 选出真实图片：
 *  1) 优先 data-srcset / data-src / data-original / data-lazy
 *  2) 再看 srcset（拆出 URL，优先包含 600x600，其次 200x200）
 *  3) 再看 src
 *  4) 如果仍是 loader.svg，尝试解析 <noscript> 里的 <img>
 */
function pickRealImage($card, listUrl) {
  const $img = $card.find("img").first();
  const candAttrs = [
    "data-srcset",
    "data-src",
    "data-original",
    "data-lazy",
    "data-image",
    "data-large-img",
    "data-img-large",
    "srcset",
    "src",
  ];

  let raw = "";
  for (const a of candAttrs) {
    const v = ($img.attr(a) || "").trim();
    if (v) { raw = v; break; }
  }

  function fromSrcset(v) {
    const parts = v
      .split(",")
      .map(s => s.trim().split(/\s+/)[0])
      .filter(s => /^https?:/i.test(s));
    // 优先 600x600，再退到 200x200，再退第一张
    const p600 = parts.find(u => /600x600/i.test(u));
    const p200 = parts.find(u => /200x200/i.test(u));
    return p600 || p200 || parts[0] || "";
  }

  let url = "";
  if (/,\s*\S+/.test(raw) || /\s+\d+x/.test(raw)) {
    url = fromSrcset(raw);
  } else {
    url = raw;
  }
  url = abs(listUrl, (url || "").split("?")[0]);

  // 如果还是 loader.svg，尝试 noscript
  if (!url || /\.svg$/i.test(url)) {
    const htmlNo = $card.find("noscript").first().html() || "";
    if (htmlNo) {
      try {
        const $_ = cheerio.load(htmlNo);
        const u2 = $_("img").attr("src") || $_("img").attr("data-src") || "";
        if (u2) url = abs(listUrl, (u2 || "").split("?")[0]);
      } catch {}
    }
  }
  return url;
}

function guessSku(title) {
  const m =
    String(title || "").match(/\b[0-9]{4,}\b/) ||
    String(title || "").match(/\b[0-9A-Z]{4,}(?:-[0-9A-Z]{2,})*\b/i);
  return m ? m[0] : "";
}

/** Memoryking 列表解析（Shopware） */
export default async function parseMemoryking(listUrl, limit = 50) {
  const html = await fetchHtml(listUrl);
  const $ = cheerio.load(html);

  const items = [];
  const seen = new Set();

  // Shopware 列表常见卡片：.product--box / .box--minimal / .product-box / .listing .product
  const CARD =
    ".product--box, .box--minimal, .product-box, .listing .product, .product--info";

  $(CARD).each((_i, el) => {
    if (items.length >= limit) return false;
    const $card = $(el);

    // 详情链接（排除购物车/收藏等）
    const BAD = /(add-to-cart|cart|login|wishlist|compare|filter|sort)/i;
    const $a = $card
      .find("a[href]")
      .filter((_, a) => !BAD.test(String($(a).attr("href"))))
      .first();
    if (!$a.length) return;

    const href = abs(listUrl, $a.attr("href") || "");
    if (!href || seen.has(href)) return;

    const title =
      ($a.attr("title") || "").trim() ||
      text($card.find("h3,h2,h1,.product--title").first()) ||
      text($a) ||
      text($card.find("img").first());
    if (!title) return;

    const img = pickRealImage($card, listUrl);

    let price =
      text(
        $card.find(
          ".price, .product--price, .price--default, .price__value, .amount"
        ).first()
      ) || "";
    // 兜底：整卡文本里找 "12,34 € / € 12,34"
    if (!price) {
      const m = $card
        .text()
        .match(/\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})\s*(?:€|EUR)/i);
      if (m) price = m[0].replace(/\s+/g, " ");
    }

    items.push({
      sku: guessSku(title),
      title,
      url: href,
      img,
      price: price || null,
      currency: "",
      moq: "",
    });
    seen.add(href);
  });

  return items.slice(0, limit);
}
