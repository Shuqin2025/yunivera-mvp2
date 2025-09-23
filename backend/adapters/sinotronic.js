// backend/adapters/sinotronic.js
// ESM 版本：适配 http://www.sinotronic-e.com 的静态目录页
import { URL as NodeURL } from "url";

function abs(base, href) {
  try {
    return new NodeURL(href || "", base).toString();
  } catch {
    return href || "";
  }
}

function pickImg($img) {
  if (!$img || !$img.length) return "";
  const attrs = [
    "src",
    "data-src",
    "data-original",
    "data-echo",
    "data-lazy",
    "data-img",
    "data-url",
  ];
  for (const a of attrs) {
    const v = ($img.attr(a) || "").trim();
    if (v) return v;
  }
  // 兼容 style="background-image:url(...)"
  const m = ($img.attr("style") || "").match(/url\((.*?)\)/i);
  return m && m[1] ? m[1].replace(/['"]/g, "") : "";
}

function normText(txt = "") {
  return String(txt).replace(/\s+/g, " ").replace(/[\r\n\t]/g, " ").trim();
}

function isNavText(t) {
  const x = t.toLowerCase();
  return (
    !x ||
    x === "#" ||
    /^javascript:/i.test(x) ||
    /(首页|尾页|上一页|下一页|more|zurück|weiter|page)/i.test(x)
  );
}

export default function parseSinotronic($, ctx = {}) {
  const out = [];
  const limit = Math.max(1, Number(ctx.limit || 50));
  const base = ctx.url || "";

  // ① 常见产品列表（li / 卡片）
  const selectors = [
    "ul li:has(a)", // 通用 ul>li
    ".list li:has(a)",
    ".prolist li:has(a)",
    ".products li:has(a)",
    ".product-list li:has(a)",
    ".goods-list li:has(a)",
    ".grid li:has(a)",
    "div.product",
    "div.goods",
    ".product-item",
    ".goods-item",
    // 兼容静态表格类列表
    "table tr:has(a)",
  ].join(",");

  $(selectors).each((_, el) => {
    if (out.length >= limit) return false;

    const $el = $(el);
    // 取第一个链接
    const $a = $el.find("a[href]").first();
    const href = abs(base, $a.attr("href"));
    if (!href) return;

    // 候选标题：img@alt > a@title > a.text > 同行/同列文本
    const $img = $el.find("img").first();
    let title =
      normText($img.attr("alt")) ||
      normText($a.attr("title")) ||
      normText($a.text());

    if (!title) {
      // 再往周围找一找
      title =
        normText($el.text()) ||
        normText($el.closest("tr").text()) ||
        normText($a.closest("td").text());
    }
    title = normText(title);
    if (!title || isNavText(title)) return;

    const img = abs(base, pickImg($img));

    out.push({
      sku: title, // 先把标题当货号展示
      desc: title,
      url: href,
      img,
      price: "",
      currency: "",
      moq: "",
    });
  });

  // ② 兜底：全页 a[href]（避免空军）
  if (out.length === 0) {
    $("a[href]").each((_, a) => {
      if (out.length >= limit) return false;
      const $a = $(a);
      const href = ($a.attr("href") || "").trim();
      if (!href || /^(javascript:|#)/i.test(href)) return;

      const text = normText($a.text());
      if (!text || isNavText(text)) return;

      const img = abs(base, pickImg($a.find("img").first()));

      out.push({
        sku: text,
        desc: text,
        url: abs(base, href),
        img,
        price: "",
        currency: "",
        moq: "",
      });
    });
  }

  return out.slice(0, limit);
}
