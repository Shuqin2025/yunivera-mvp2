/** Memoryking 列表页适配器（处理懒加载图片：优先 noscript，兜底 srcset/data-*，过滤 loader.svg） */
export default function parseMemoryking($, limit = 50, debug = false) {
  const BASE = "https://www.memoryking.de";
  const items = [];
  const seen = new Set();

  const abs = (u) => {
    try {
      if (!u) return "";
      if (/^\/\//.test(u)) u = "https:" + u;        // //host/path → https://host/path
      return new URL(String(u), BASE).href;
    } catch { return String(u || ""); }
  };
  const txt = (t) => String(t || "").replace(/\s+/g, " ").trim();
  const notLoader = (u) => u && !/loader\.svg(?:$|\?)/i.test(u);
  const isReal = (u) => /\.(?:jpe?g|png|webp)(?:$|\?)/i.test(String(u || ""));

  // 从 srcset 里挑一个 URL（取最后一个，一般是最大）
  const pickFromSrcset = (s) => {
    if (!s) return "";
    const last = String(s).split(",").pop().trim();
    return last.split(/\s+/)[0] || "";
  };

  // 200x200 → 600x600（仅对 Memoryking 的云图床命名生效）
  const up600 = (u) => String(u || "").replace(/_(?:200|300)x(?:200|300)(?=\.)/g, "600x600");

  // 列表卡片（尽量通用）
  const cards = $(".product--box, li.product--box, .box--basic, .product--teaser, .product--info");
  cards.each((_, el) => {
    if (items.length >= limit) return false;

    const $el = $(el);
    const a = $el.find("a").filter((_, x) => /\/detail|\/details|\/sArticle\//i.test($(x).attr("href") || "")).first();
    const url = abs(a.attr("href") || "");

    // 同一链接只收一次
    if (!url || seen.has(url)) return;
    seen.add(url);

    const title =
      txt($el.find(".product--title, .title, h3, h2").first().text()) ||
      txt(a.text());

    // 1) 先尝试从 noscript 取真图
    let img = "";
    const nos = $el.find("noscript").first().html() || "";
    if (nos) {
      const m = nos.match(/<img[^>]+src=["']([^"']+\.(?:jpe?g|png|webp)[^"']*)["']/i);
      if (m) img = m[1];
    }

    // 2) 兜底：data-srcset/srcset/data-src/src
    if (!img || !isReal(img)) {
      const $img = $el.find("img").first();
      img =
        pickFromSrcset($img.attr("data-srcset") || $img.attr("data-lazy-srcset") || $img.attr("srcset")) ||
        $img.attr("data-src") || $img.attr("data-original") || $img.attr("src") || "";
    }

    // 过滤 loader.svg & 放大到 600x600
    if (img && notLoader(img)) img = up600(img);

    items.push({
      sku: "",                        // 列表页通常没有 SKU，这里留空
      title,
      url,
      img: abs(img),
      price: "",                      // 价格由通用逻辑或 JSON-LD 兜底
      currency: "",
      moq: ""
    });
  });

  if (debug) {
    console.log("[memoryking] count =", items.length);
    console.log("[memoryking] first =", items[0]);
  }
  return items;
}
