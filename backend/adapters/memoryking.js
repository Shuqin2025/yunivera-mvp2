/**
 * Memoryking 适配器（鲁棒版 v2.4 / ESM）
 * 关键增强：支持 <noscript> 二次解析；详情全页兜底；占位图回溯替换
 */

export default function parseMemoryking($, limit = 50, debug = false) {
  const items = [];

  // ---------- 工具 ----------
  const abs = (u) => {
    if (!u) return "";
    if (/^https?:\/\//i.test(u)) return u;
    if (u.startsWith("//")) return "https:" + u;
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
    if (sz) s += Math.min(sz, 1200);
    if (/600x600|700x700|800x800/i.test(u)) s += 120;
    if (/@2x\b/i.test(u)) s += 150;
    if (/(\?|&)format=webp\b/i.test(u)) s += 5;
    if (/\.webp(?:$|\?)/i.test(u)) s += 5;
    else if (/\.jpe?g(?:$|\?)/i.test(u)) s += 3;
    else if (/\.png(?:$|\?)/i.test(u)) s += 2;
    if (/meinecloud\.io/i.test(u)) s += 10;
    return s;
  };

  // 解析 <noscript> 里的 HTML 片段，返回新的 cheerio 根
  const parseNoscriptHTML = (html) => {
    try {
      const cheerio = require("cheerio"); // 在 ESM 下由 bundler/Node 处理
      return cheerio.load(html || "");
    } catch {
      return null;
    }
  };

  // 在作用域内收集候选（含 noscript、任意属性）
  const collectImgs = ($root) => {
    const cand = new Set();

    // 1) <picture><source srcset>
    $root.find("picture source[srcset]").each((_, el) => {
      fromSrcset($(el).attr("srcset")).forEach((u) => cand.add(u));
    });

    // 2) <img> 族：优先 data- 系；再 srcset；最后 src
    $root.find("img").each((_, el) => {
      const $img = $(el);
      const ds = $img.attr("data-src");
      if (ds) cand.add(ds);

      const fb = $img.attr("data-fallbacksrc");
      if (fb) cand.add(fb);

      const dss = $img.attr("data-srcset");
      if (dss) fromSrcset(dss).forEach((u) => cand.add(u));

      const ss = $img.attr("srcset");
      if (ss) fromSrcset(ss).forEach((u) => cand.add(u));

      const s = $img.attr("src");
      if (s) cand.add(s);

      // 2.1) 如果 src 是 loader.svg，尝试在同节点上回溯 data- / srcset
      if (s && /loader\.svg/i.test(s)) {
        [ds, fb, dss, ss]
          .filter(Boolean)
          .flatMap((v) => (v.includes(",") ? fromSrcset(v) : [v]))
          .forEach((u) => cand.add(u));
      }
    });

    // 3) .image--element data-img-*
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

    // 4) 任意属性中含 jpg|png|webp
    $root.find("*").each((_, node) => {
      const attrs = node.attribs || {};
      for (const k in attrs) {
        const v = attrs[k] || "";
        if (/\.(jpe?g|png|webp)(?:$|\?)/i.test(v)) cand.add(v);
      }
    });

    // 5) 解析 <noscript> 内的真实 <img>
    $root.find("noscript").each((_, el) => {
      const html = $(el).html() || "";
      const $n = parseNoscriptHTML(html);
      if ($n) {
        $n("img").each((__, img) => {
          const $i = $n(img);
          const list = [
            $i.attr("data-src"),
            $i.attr("data-fallbacksrc"),
            $i.attr("src"),
          ].filter(Boolean);
          const ss = $i.attr("data-srcset") || $i.attr("srcset") || "";
          if (ss) fromSrcset(ss).forEach((u) => list.push(u));
          list.forEach((u) => cand.add(u));
        });
      }
    });

    // 统一规整
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

    let href =
      $box
        .find("a")
        .map((_, a) => $(a).attr("href") || "")
        .get()
        .find((h) => h && /\/(details|detail)\//i.test(h)) ||
      $box.find("a").first().attr("href") ||
      "";
    href = abs(href);

    const img = collectImgs($box);

    const price =
      $box
        .find(
          '.price--default, .product--price, .price--content, .price--unit, [itemprop="price"]'
        )
        .first()
        .text()
        .replace(/\s+/g, " ")
        .trim() || "";

    const sku =
      $box.find(".manufacturer--name, .product--supplier").first().text().trim() ||
      ($box.find(".product--info a").first().text().trim() || "").replace(/\s+/g, " ");

    return { sku, title, url: href, img, price, currency: "", moq: "" };
  };

  // ---------- ① 列表 ----------
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

  // ---------- ② 详情兜底 ----------
  if (items.length === 0) {
    const $detail = $(".product--details, .product--detail, body");

    const title =
      $detail.find(".product--title").first().text().trim() ||
      $("h1").first().text().trim() ||
      "";

    const url =
      abs($('link[rel="canonical"]').attr("href") || "") ||
      abs(($( 'meta[property="og:url"]' ).attr("content") || "").trim());

    // 2.1) og:image → 2.2) ld+json → 2.3) 详情作用域收集 → 2.4) 全页收集
    let img = $('meta[property="og:image"]').attr("content") || "";

    if (!img) {
      $('script[type="application/ld+json"]').each((_, el) => {
        try {
          const data = JSON.parse($(el).contents().text() || "{}");
          const pic = Array.isArray(data?.image) ? data.image[0] : data?.image;
          if (!img && pic && /\.(jpe?g|png|webp)(?:$|\?)/i.test(pic)) {
            img = pic;
          }
        } catch {}
      });
    }

    if (!img) img = collectImgs($detail);
    if (!img) img = collectImgs($("body"));

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

  // ---------- 出口 ----------
  const out = items
    .map((r) => (r && r.img && /loader\.svg/i.test(r.img) ? { ...r, img: "" } : r))
    .slice(0, limit);

  if (debug) {
    console.log("[memoryking] boxes=%d -> out=%d; first=%o", boxes.length, out.length, out[0]);
  }
  return out;
}
