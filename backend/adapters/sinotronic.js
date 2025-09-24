// backend/adapters/sinotronic.js
// 适配 http://www.sinotronic-e.com 等“静态 HTML 目录页”
// 目标：在无脚本、无懒加载执行的情况下，最大化提取 <a> + 可见文本/图片
import { URL as NodeURL } from "url";

function abs(base, href) {
  try {
    return new NodeURL(href || "", base || undefined).toString();
  } catch {
    return href || "";
  }
}

function normText(txt = "") {
  return String(txt).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
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

function isJunkHref(href = "") {
  const h = href.trim();
  return (
    !h ||
    h === "#" ||
    /^javascript:/i.test(h) ||
    /^mailto:/i.test(h) ||
    /^tel:/i.test(h)
  );
}

function isNavText(t = "") {
  const x = normText(t).toLowerCase();
  return (
    !x ||
    x === "#" ||
    /(首页|尾页|上一页|下一页|上一|下一|返回|更多|目录|导航|列表|page|pages|pager|prev|next|zurück|weiter|mehr)/i.test(
      x
    )
  );
}

function push(out, base, text, href, img) {
  const sku = normText(text);
  const url = abs(base, href);
  if (!sku || isNavText(sku) || isJunkHref(url)) return;

  out.push({
    sku,              // 先把标题/可见文本当作 sku
    desc: sku,        // 简单复用为描述（静态页一般无结构化描述）
    url,              // 详情链接
    img: abs(base, img || ""),
    price: "",        // 静态目录多半没有价格，留空
    currency: "",
    moq: "",
  });
}

export default function parseSinotronic($, ctx = {}) {
  const out = [];
  const base = ctx.url || $("base[href]").attr("href") || "";
  const limit = Math.max(1, Number(ctx.limit || 50));

  // —— 1) 首选：常见产品卡片/列表示例（尽量覆盖各类“静态模板”）——
  // 说明：优先在 li/card/table row 级别做提取，更容易拿到干净标题与图片
  const blocks = [
    // 典型 UL/LI、卡片式
    "ul li:has(a)",
    ".list li:has(a)",
    ".lists li:has(a)",
    ".prolist li:has(a)",
    ".products li:has(a)",
    ".product-list li:has(a)",
    ".goods-list li:has(a)",
    ".grid li:has(a)",
    "li.product-item:has(a)",
    "li.goods-item:has(a)",
    "div.product:has(a)",
    "div.goods:has(a)",
    ".product-item:has(a)",
    ".goods-item:has(a)",

    // 典型 DL/DT/DD 结构
    "dl:has(a) dd",
    "dl:has(a) dt",

    // 老式 table 列表页（国内站常见）
    "table tr:has(a)",
    "table.list tr:has(a)",
    "table[border] tr:has(a)",
  ].join(",");

  $(blocks).each((_, el) => {
    if (out.length >= limit) return false;

    const $el = $(el);
    const $a = $el.find("a[href]").first();
    const href = ($a.attr("href") || "").trim();
    if (isJunkHref(href)) return;

    // 标题优先级：img@alt > a@title > a.text > 同行/同列文本
    const $img = $el.find("img").first();
    let title =
      normText($img.attr("alt")) ||
      normText($a.attr("title")) ||
      normText($a.text());

    if (!title) {
      title =
        normText($el.text()) ||
        normText($el.closest("tr").text()) ||
        normText($a.closest("td").text());
    }
    if (!title || isNavText(title)) return;

    const img = pickImg($img);
    push(out, base, title, href, img);
  });

  // —— 2) 强化兜底：主要内容区内的“纯文字链接” ——  
  // 过滤 header/footer/nav/pager 等区域，尽量限定在主内容区
  if (out.length < limit) {
    const forbiddenAncestors =
      "header, nav, footer, .nav, .navbar, .breadcrumb, .breadcrumbs, .footer, .pager, .pagination, .pagebar, .crumb";
    const anchorScope =
      "main, #main, #content, .content, .container, .wrap, .wrapper, .list, .lists, .newslist, .prolist, .products, .product-list, .product, .goods";

    $(`${anchorScope} a[href]`).each((_, a) => {
      if (out.length >= limit) return false;

      const $a = $(a);
      if ($a.closest(forbiddenAncestors).length) return;

      const href = ($a.attr("href") || "").trim();
      if (isJunkHref(href)) return;

      // 就近文本/图片
      const text =
        normText($a.text()) ||
        normText($a.closest("li, tr, dd, dt, p, div").text());
      const img = pickImg($a.find("img").first());
      push(out, base, text, href, img);
    });
  }

  // —— 3) 去重（优先按 url，退而求其次按 sku+img）——
  if (out.length) {
    const seenURL = new Set();
    const seenKey = new Set();
    const uniq = [];
    for (const it of out) {
      const u = it.url || "";
      const k = `${(it.sku || "").toLowerCase()}|${(it.img || "").toLowerCase()}`;
      if (u && !seenURL.has(u)) {
        seenURL.add(u);
        uniq.push(it);
      } else if (!u && !seenKey.has(k)) {
        seenKey.add(k);
        uniq.push(it);
      }
      if (uniq.length >= limit) break;
    }
    return uniq.slice(0, limit);
  }

  return out.slice(0, limit);
}
