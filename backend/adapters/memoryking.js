/** 
 * Memoryking 列表页适配器（处理懒加载图片）
 * - 先从列表卡片里拿图（data-src/data-srcset/src 或 noscript 里的 <img>）
 * - 如果还是 loader.svg 或没有真实后缀（jpg/png/webp），兜底抓详情页 .image--media img 的 src/srcset
 * - 如果是 200x200/300x300 小图，尽量替换为 600x600
 */
import * as cheerio from "cheerio";

function text($, el) {
  return ($(el).text() || "").replace(/\s+/g, " ").trim();
}
function pickFromSrcset(srcset) {
  if (!srcset) return "";
  const last = srcset.split(",").pop().trim();
  return last.split(/\s+/)[0];
}
function isRealImage(u) {
  return /\.(jpe?g|png|webp)(\?|$)/i.test(u || "");
}
function upsizeTo600(u) {
  // 末尾形如 "_200x200.jpg" 或 "_300x300.jpg" → "_600x600.jpg"
  return (u || "").replace(/_(?:200|300)x(?:200|300)(\.\w+)(\?|$)/i, `_600x600$1$2`);
}
function abs(u, base) {
  try { return new URL(u || "", base).href; } catch { return u || ""; }
}
async function fetchHtml(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  const res = await fetch(url, { signal: ctl.signal });
  clearTimeout(t);
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
  return await res.text();
}

async function getDetailImage(detailUrl, base) {
  try {
    const html = await fetchHtml(detailUrl);
    const $$ = cheerio.load(html);
    // 详情页常见结构：.image--media img 或 image slider 里的 img
    let src =
      $$(".image--media img").attr("srcset") ||
      $$(".image--media img").attr("src") ||
      $$(".image--box img").attr("srcset") ||
      $$(".image--box img").attr("src") ||
      "";
    if (src && src.includes(",")) src = pickFromSrcset(src);
    src = abs(src, base);
    if (isRealImage(src)) return upsizeTo600(src);
  } catch {}
  return "";
}

export default async function parseMemoryking($, limit = 50, debug = false) {
  const items = [];
  const seen = new Set();

  const base = $("base").attr("href") || "https://www.memoryking.de/";

  $(".listing--container .product--box").each((i, card) => {
    if (items.length >= limit) return false;

    const $card = $(card);
    const $a = $card.find(".product--info .product--title a").first();
    const title = text($, $a);
    const href = abs($a.attr("href") || "", base);
    if (!href || !title || seen.has(href)) return;

    // 1) 列表里直接找
    let img = "";
    const $img = $card.find("img").first();
    img = $img.attr("data-src") || $img.attr("data-srcset") || $img.attr("src") || "";
    if (img && img.includes(",")) img = pickFromSrcset(img);
    img = abs(img, base);

    // 2) 列表 noscript 兜底
    if (/loader\.svg/i.test(img) || !isRealImage(img)) {
      const nsHtml = $card.find("noscript").html() || "";
      if (nsHtml) {
        const $$ = cheerio.load(nsHtml);
        let nsImg =
          $$("img").attr("data-srcset") ||
          $$("img").attr("data-src") ||
          $$("img").attr("src") ||
          "";
        if (nsImg && nsImg.includes(",")) nsImg = pickFromSrcset(nsImg);
        if (nsImg) img = abs(nsImg, base);
      }
    }

    // 3) 放大缩略图
    if (isRealImage(img)) {
      img = upsizeTo600(img);
    }

    items.push({
      sku: "",
      title,
      href,
      url: href,
      img
    });
    seen.add(href);
  });

  // 4) 还存在非真实图的，进入详情页补齐
  for (let k = 0; k < items.length; k++) {
    const it = items[k];
    if (!isRealImage(it.img)) {
      const detailImg = await getDetailImage(it.href, base);
      if (detailImg) it.img = detailImg;
      if (debug) console.log("[mk:detail]", it.href, "->", it.img);
    }
  }

  return { items };
}
