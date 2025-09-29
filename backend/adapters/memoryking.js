/**
 * Memoryking 适配器（鲁棒版 v2.5 / ESM）
 * 关键点：
 * 1) 列表每个商品优先从“同一个 <img> 的 data-*”直接取真图，避免网关把空值回填为 loader.svg
 * 2) 仍保留 collectImgs 的全域收集与评分；详情页含 og:image / ld+json / 全页兜底
 * 3) 永远过滤 loader.svg；统一补全绝对地址；偏好更清晰图片（@2x、600~800、尺寸越大分越高）
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

  // 解析 <noscript> 里的 HTML 片段，返回新的 cheerio 根（可能为空）
  const parseNoscriptHTML = (html) => {
    try {
      // 在 Node ESM 下可用，若 bundler 替换也兼容
      // eslint-disable-next-line n/no-missing-require
      const cheerio = require("cheerio");
      return cheerio.load(html || "");
    } catch {
      return null;
    }
  };

  // 从“单个 <img> 节点”直接抽取最佳 URL（优先顺序：data-srcset -> data-fallbacksrc -> data-src -> srcset -> src）
  const bestFromImgNode = ($img) => {
    if (!$img || !$img.length) return "";
    const cand = new Set();

    const dss = $img.attr("data-srcset");
    if (dss) fromSrcset(dss).forEach((u) => cand.add(u));

    const fb = $img.attr("data-fallbacksrc");
    if (fb) cand.add(fb);

    const ds = $img.attr("data-src");
    if (ds) cand.add(ds);

    const ss = $img.attr("srcset");
    if (ss) fromSrcset(ss).forEach((u) => cand.add(u));

    const s = $img.attr("src");
    // 仅当不是 loader.svg 才考虑 src
    if (s && !/loader\.svg/i.test(s)) cand.add(s);

    const real = [...cand]
      .map(abs)
      .filter(
        (u) => u && /\.(jpe?g|png|webp)(?:$|\?)/i.test(u) && !/loader\.svg/i.test(u)
      );

    if (!real.length) return "";
    real.sort((a, b) => score(b) - score(a));
    return real[0];
  };

  // 在一个作用域下收集尽可能多候选（含 noscript、任意属性）
  const collectImgs = ($root) => {
    const cand = new Set();

    // 1) <picture><source srcset>
    $root.find("picture source[srcset]").each((_, el) => {
      fromSrcset($(el).attr("srcset")).forEach((u) => cand.add(u));
    });

    // 2) <img> 族：把 bestFromImgNode 的结果也纳入
    $root.find("img").each((_, el) => {
      const $img = $(el);
      const best = bestFromImgNode($img);
      if (best) cand.add(best);

      // 再补充原始属性（防止某些分辨率项丢失）
      const extras = [
        $img.attr("data-src"),
        $img.attr("data-fallbacksrc"),
        $img.attr("src"),
      ].filter(Boolean);
      const ss1 = $img.attr("data-srcset") || $img.attr("srcset") || "";
      if (ss1) fromSrcset(ss1).forEach((u) => extras.push(u));
      extras.forEach((u) => cand.add(u));
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

    // 4) 任意属性里出现 jpg|png|webp
    $root.find("*").each((_, node) => {
      const attrs = node.attribs || {};
      for (const k in attrs) {
        const v = attrs[k] || "";
        if (/\.(jpe?g|png|webp)(?:$|\?)/i.test(v)) cand.add(v);
      }
    });

    // 5) <noscript> 内的 <img>
    $root.find("noscript").each((_, el) => {
      const html = $(el).html() || "";
      const $n = parseNoscriptHTML(html);
      if ($n) {
        $n("img").each((__, img) => {
          const $i = $n(img);
          const best = bestFromImgNode($i);
          if (best) cand.add(best);

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

    const real = [...cand]
      .map(abs)
      .filter(
        (u) => u && /\.(jpe?g|png|webp)(?:$|\?)/i.test(u) && !/loader\.svg/i.test(u)
      );

    if (!real.length) return "";
    real.sort((a, b) => score(b) - score(a));
    return real[0];
  };

  const readBox = ($box) => {
    const title =
      $box.find(".product--title, .product--info a, a[title]").first().text().trim() ||
      $box.find("a").first().attr("title") ||
      "";

    // 详情链接
    let href =
      $box
        .find("a")
        .map((_, a) => $(a).attr("href") || "")
        .get()
        .find((h) => h && /\/(details|detail)\//i.test(h)) ||
      $box.find("a").first().attr("href") ||
      "";
    href = abs(href);

    // ---- 图片：先“就地”取第一个 <img> 的 data-*，确保不给网关留空 ----
    const firstImg = $box.find("img").first();
    let img = bestFromImgNode(firstImg);

    // 若仍为空，再做广域收集
    if (!img) img = collectImgs($box);

    const price =
      $box
        .find(".price--default, .product--price, .price--content, .price--unit, [itemprop='price']")
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
      // 关键：img 若仍是 loader.svg（理论上不会），也置空阻断网关回填
      if (row.img && /loader\.svg/i.test(row.img)) row.img = "";
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
      abs(($('meta[property="og:url"]').attr("content") || "").trim());

    let img = $('meta[property="og:image"]').attr("content") || "";

    if (!img) {
      $('script[type="application/ld+json"]').each((_, el) => {
        try {
          const data = JSON.parse($(el).contents().text() || "{}");
          const pic = Array.isArray(data?.image) ? data.image[0] : data?.image;
          if (!img && pic && /\.(jpe?g|png|webp)(?:$|\?)/i.test(pic)) img = pic;
        } catch {}
      });
    }

    // 详情主图区域优先
    if (!img) img = bestFromImgNode($detail.find("img").first());
    if (!img) img = collectImgs($detail);
    if (!img) img = collectImgs($("body"));
    img = abs(img);

    const price =
      $detail
        .find(".price--default, .product--price, .price--content, .price--unit, [itemprop='price']")
        .first()
        .text()
        .replace(/\s+/g, " ")
        .trim() || "";

    const sku =
      $detail.find(".manufacturer--name").first().text().trim() ||
      $detail.find(".product--supplier").first().text().trim() ||
      "";

    const row = { sku, title, url, img, price, currency: "", moq: "" };
    if (row.img && /loader\.svg/i.test(row.img)) row.img = "";
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
