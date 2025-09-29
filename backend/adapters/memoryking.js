/**
 * Memoryking 适配器（鲁棒版 v2.3 / ESM）
 * 目标：无 JS 解析也能拿到“真图”；过滤 loader.svg；统一绝对地址；优先清晰图
 * 导出：ESM 默认导出（server.js 使用：import parseMemoryking from "./adapters/memoryking.js";）
 * 签名：parseMemoryking($, limit=50, debug=false)
 */

export default function parseMemoryking($, limit = 50, debug = false) {
  const items = [];

  // ---------- 工具函数 ----------
  const abs = (u) => {
    if (!u) return "";
    if (/^https?:\/\//i.test(u)) return u;
    if (u.startsWith("//")) return "https:" + u;
    // Memoryking 的域保持为主站；若有 base href，后端会在上层处理，这里做最稳妥兜底
    return "https://www.memoryking.de" + (u.startsWith("/") ? u : "/" + u);
  };

  const fromSrcset = (s) =>
    (s || "")
      .split(",")
      .map((x) => x.trim().split(/\s+/)[0])
      .filter(Boolean);

  const pickSquareSize = (u) => {
    const m = u && u.match(/(\d{2,4})x\1\b/);
    return m ? parseInt(m[1], 10) : 0;
  };

  const score = (u) => {
    if (!u) return -1e9;
    let s = 0;
    const sz = pickSquareSize(u);
    if (sz) s += Math.min(sz, 1200);                 // 大图更优，设上限
    if (/600x600|700x700|800x800/i.test(u)) s += 120;
    if (/@2x\b/i.test(u)) s += 150;
    if (/(\?|&)format=webp\b/i.test(u)) s += 5;
    if (/\.webp(?:$|\?)/i.test(u)) s += 5;
    else if (/\.jpe?g(?:$|\?)/i.test(u)) s += 3;
    else if (/\.png(?:$|\?)/i.test(u)) s += 2;
    if (/meinecloud\.io/i.test(u)) s += 10;          // 站点常用 CDN
    return s;
  };

  const collectImgs = ($root) => {
    const cand = new Set();

    // 1) <picture><source srcset>
    $root.find("picture source[srcset]").each((_, el) => {
      fromSrcset($(el).attr("srcset")).forEach((u) => cand.add(u));
    });

    // 2) img 上的各种可能：优先 data- 系（ccLazy 常见）
    $root.find("img").each((_, el) => {
      const $img = $(el);

      const ss = $img.attr("data-srcset") || $img.attr("srcset") || "";
      if (ss) fromSrcset(ss).forEach((u) => cand.add(u));

      const ds = $img.attr("data-src");
      if (ds) cand.add(ds);

      const fb = $img.attr("data-fallbacksrc");      // 你自测里出现过
      if (fb) cand.add(fb);

      const s = $img.attr("src");
      if (s) cand.add(s);
    });

    // 3) .image--element 上的 data-img-*
    $root.find(".image--element").each((_, el) => {
      const $el = $(el);
      [
        "data-img-large",
        "data-original",
        "data-img-small",
        "data-zoom-image",
        "data-img",
        "data-src",
      ].forEach((k) => {
        const v = $el.attr(k);
        if (v) cand.add(v);
      });
    });

    // 4) 兜底：任意属性里出现 jpg/png/webp 都收
    $root.find("*").each((_, node) => {
      const attrs = node.attribs || {};
      for (const k in attrs) {
        const v = attrs[k] || "";
        if (/\.(jpe?g|png|webp)(?:$|\?)/i.test(v)) cand.add(v);
      }
    });

    // 统一：绝对化 + 过滤 loader.svg + 仅保留图片扩展
    const real = [...cand]
      .map(abs)
      .filter(
        (u) =>
          u &&
          !/loader\.svg/i.test(u) &&
          /\.(jpe?g|png|webp)(?:$|\?)/i.test(u)
      );

    if (!real.length) return "";
    real.sort((a, b) => score(b) - score(a));
    return real[0];
  };

  const readBox = ($box) => {
    const title =
      $box
        .find(".product--title, .product--info a, a[title]")
        .first()
        .text()
        .trim() ||
      $box.find("a").first().attr("title") ||
      "";

    // 链接：优先详情
    let href =
      $box
        .find("a")
        .map((_, a) => $(a).attr("href") || "")
        .get()
        .find((h) => h && /\/(details|detail)\//i.test(h)) ||
      $box.find("a").first().attr("href") ||
      "";
    href = abs(href);

    // 图片：就近作用域收集
    const img = collectImgs($box);

    // 价格
    const price =
      $box
        .find(
          '.price--default, .product--price, .price--content, .price--unit, [itemprop="price"]'
        )
        .first()
        .text()
        .replace(/\s+/g, " ")
        .trim() || "";

    // SKU/品牌（空则留空）
    const sku =
      $box.find(".manufacturer--name, .product--supplier").first().text().trim() ||
      ($box.find(".product--info a").first().text().trim() || "").replace(/\s+/g, " ");

    return { sku, title, url: href, img, price, currency: "", moq: "" };
  };

  // ---------- ① 列表解析（多容器并联） ----------
  const selectors = [
    ".listing--container .product--box",
    ".product--box",
    ".js--isotope .product--box",
  ];
  let boxes = [];
  for (const sel of selectors) {
    const arr = $(sel).toArray();
    if (arr.length) {
      boxes = arr;
      break;
    }
  }

  if (boxes.length) {
    boxes.forEach((el) => {
      const row = readBox($(el));
      if (row.title || row.url || row.img) items.push(row);
    });
  }

  // ---------- ② 详情兜底（当列表无结果时） ----------
  if (items.length === 0) {
    const $detail = $(".product--details, .product--detail, body");

    const title =
      $detail.find(".product--title").first().text().trim() ||
      $("h1").first().text().trim() ||
      "";

    const url =
      abs($('link[rel="canonical"]').attr("href") || "") ||
      abs(($( 'meta[property="og:url"]' ).attr("content") || "").trim());

    let img = $('meta[property="og:image"]').attr("content") || "";

    if (!img) {
      // ld+json 里 image（字符串或数组）
      $('script[type="application/ld+json"]').each((_, el) => {
        try {
          const data = JSON.parse($(el).contents().text() || "{}");
          const pic = Array.isArray(data?.image) ? data.image[0] : data?.image;
          if (!img && pic && /\.(jpe?g|png|webp)(?:$|\?)/i.test(pic)) {
            img = pic;
          }
        } catch (_) {}
      });
    }

    if (!img) img = collectImgs($detail);
    img = abs(img);

    const price =
      $detail
        .find(
          '.price--default, .product--price, .price--content, .price--unit, [itemprop="price"]'
        )
        .first()
        .text()
        .replace(/\s+/g, " ")
        .trim() || "";

    const sku =
      $detail.find(".manufacturer--name").first().text().trim() ||
      $detail.find(".product--supplier").first().text().trim() ||
      "";

    const row = { sku, title, url, img, price, currency: "", moq: "" };
    if (row.title || row.url || row.img) items.push(row);
  }

  // ---------- 出口：过滤占位图，限制数量 ----------
  const out = items
    .map((r) => (r && r.img && /loader\.svg/i.test(r.img) ? { ...r, img: "" } : r))
    .slice(0, limit);

  if (debug) {
    console.log("[memoryking] boxes=%d -> out=%d; first=%o", boxes.length, out.length, out[0]);
  }
  return out;
}
