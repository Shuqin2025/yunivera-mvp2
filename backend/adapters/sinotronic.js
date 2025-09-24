// backend/adapters/sinotronic.js
import { URL as NodeURL } from "url";

/**
 * 解析 http://www.sinotronic-e.com/list/?11_1.html 这类静态频道页
 * - 列表容器：#productlist ul > li
 * - a[href] 为详情链接，img[src] 为缩略图
 * - 需要把相对路径补全为绝对 URL
 */
export default function parseSinotronic($, { url, limit = 50 } = {}) {
  const base = (() => {
    try {
      return new NodeURL(url).origin;
    } catch {
      return "http://www.sinotronic-e.com";
    }
  })();

  const abs = (href = "") => {
    try {
      return new NodeURL(href || "", base).href;
    } catch {
      return href || base;
    }
  };

  // 1) 优先使用权威选择器；给一组兜底，避免模板小改就失效
  let $items = $("#productlist ul > li");
  if ($items.length === 0) {
    $items = $(".editor#productlist li, .productlist li, .list li"); // 兜底
  }

  const out = [];
  $items.each((i, li) => {
    if (out.length >= limit) return false; // break

    const $li = $(li);
    const $a = $li.find("a[href]").first();
    if ($a.length === 0) return;

    // 图片：先找 <img src>；常见兜底 data-src / data-original
    const $img = $li.find("img").first();
    const imgRaw =
      $img.attr("src") ||
      $img.attr("data-src") ||
      $img.attr("data-original") ||
      "";
    const hrefRaw = $a.attr("href") || "";

    // 标题/描述：img@alt > a@title > 文本
    let title =
      ($img.attr("alt") || $a.attr("title") || $li.text() || "")
        .replace(/\s+/g, " ")
        .trim();

    if (!title) {
      // 兜底一个可读的 sku
      try {
        const u = new NodeURL(hrefRaw, base);
        title = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "");
      } catch {
        title = hrefRaw || "item";
      }
    }

    out.push({
      sku: title,               // 先用标题顶上
      title,                    // 同步放在 title
      url: abs(hrefRaw),        // 详情链接（绝对）
      img: imgRaw ? abs(imgRaw) : "", // 缩略图（绝对）
      price: "",                // 此站频道页无价，保留空字段
      currency: "",
      moq: ""
    });
  });

  return out;
}
