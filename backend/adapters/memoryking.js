/** Memoryking 适配器（分类页 & 详情页，处理懒加载图片） */
import cheerio from "cheerio";
import { absolutize } from "../utils/url.js"; // 如果没有此工具，下面会写一个兜底

function abs(u, base) {
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith("//")) return "https:" + u;
  try { return new URL(u, base).href; } catch { return u; }
}

function pickFromSrcset(s) {
  if (!s) return "";
  // 取 srcset 里的第一个 URL（去掉后面的 " 2x" 等）
  const cand = s.split(",").map(x => x.trim().split(" ")[0]);
  return cand.find(u => /\.(jpe?g|png|webp)(\?|$)/i.test(u)) || "";
}

function findImage($scope, baseUrl) {
  // 1) 优先 data-*（Shopware 常见）
  const holder = $scope.find(".image--element, .image--media, .product--image, .image-slider--slide").first();
  let url =
    holder.attr("data-img-small") ||
    holder.attr("data-img-large") ||
    holder.attr("data-img-original") ||
    "";

  // 2) 再看 <img> + srcset / data-srcset / data-src
  const img = $scope.find("img").first();
  if (!url) url = pickFromSrcset(img.attr("srcset"));
  if (!url) url = pickFromSrcset(holder.attr("srcset"));
  if (!url) url = img.attr("data-src") || img.attr("data-lazy") || "";

  // 3) 兜底正则：整个卡片 HTML 中扫 os*.meinecloud.io 的真图（优先 600x600）
  const html = ($scope.html() || "");
  if (!url || /loader\.svg/i.test(url)) {
    let m =
      html.match(/https?:\/\/[^"' ]+\/image\/[^"' ]+_(?:600x600|500x500|400x400)\.(?:jpe?g|png|webp)/i) ||
      html.match(/https?:\/\/os\d+\.meinecloud\.io\/[^"' ]+_(?:600x600|500x500|200x200)\.(?:jpe?g|png|webp)/i);
    if (m) url = m[0];
  }

  // 4) 最后再试试 <img src>
  if ((!url || /loader\.svg/i.test(url)) && img.attr("src")) url = img.attr("src");

  url = abs(url, baseUrl);
  // 抛掉 loader.svg
  if (/loader\.svg/i.test(url)) return "";
  return url;
}

export default function parseMemoryking($, limit = 60) {
  const base = $("base").attr("href") || "https://www.memoryking.de/";

  // 分类页：.product--box
  const list = [];
  $(".product--box").each((_, el) => {
    const $box = $(el);
    const $a   = $box.find("a.product--title, a.product--image").first();
    const url  = abs($a.attr("href") || "", base);
    const title= ($a.text() || "").replace(/\s+/g, " ").trim();
    const sku  = ($box.find(".product--manufacturer a, .product--vendor a").first().text() || "deleyCON").trim();

    // 价格（多种模板兜底）
    let price = $box.find(".price--default, .price--content, .product--price").first().text().replace(/\s+/g," ").trim();
    price = (price.match(/[\d.,]+ ?€/) || [""])[0] || "";

    const img = findImage($box, base);

    if (url && title) list.push({ sku, title, url, img, price });
  });

  // 详情页（两种路由都适配）
  if (list.length === 0) {
    // 详情页标题
    const title = ($(".product--title, h1.product--title, .product--header h1").first().text() || "").replace(/\s+/g," ").trim();
    const url   = abs(($("link[rel='canonical']").attr("href") || ""), base) || abs((typeof location!=="undefined"?location.href:""), base);
    // 价格
    let price   = $(".price--default, .price--content, .product--price").first().text().replace(/\s+/g," ").trim();
    price       = (price.match(/[\d.,]+ ?€/) || [""])[0] || "";
    // 品牌（没有就固定 deleyCON）
    const sku   = ($(".product--manufacturer a, .manufacturer--link, .product--supplier a").first().text() || "deleyCON").trim();

    // 主图区域
    const $imgScope = $(".product--image-container, .image-slider--container, .image-gallery--image, .image--box").first();
    let img = findImage($imgScope, base);
    if (!img) {
      // 兜底：全页扫一遍
      const html = $.html();
      const m = html.match(/https?:\/\/[^"' ]+\/image\/[^"' ]+_(?:600x600|500x500|400x400)\.(?:jpe?g|png|webp)/i);
      if (m) img = m[0];
    }

    if (title && url) list.push({ sku, title, url, img, price });
  }

  // 限制条数
  return list.slice(0, limit);
}
