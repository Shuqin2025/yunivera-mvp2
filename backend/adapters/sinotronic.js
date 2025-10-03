export default {
  test: (u) => /(?:^|\.)sinotronic-e\.com/i.test(u),

  parse($, pageUrl, opts = {}) {
    const limit = Number(opts.limit || 60);

    const toAbs = (u) => {
      try { return new URL(u, pageUrl).href; }
      catch { return String(u || ""); }
    };

    const out = [];
    const seen = new Set();

    // 宽松：按图片走，但仅接收 /upload/product/ 的商品图
    $("img").each((_, el) => {
      if (out.length >= limit) return false;

      const src =
        $(el).attr("src") ||
        $(el).attr("data-src") ||
        $(el).attr("data-original") ||
        "";

      if (!/\/upload\/product\//i.test(src)) return;

      // 找到对应的商品链接
      let a = $(el).closest("a[href]");
      if (!a.length) {
        const li = $(el).closest("li");
        if (li.length) a = li.find("a[href]").first();
      }
      if (!a.length) a = $(el).parent().find("a[href]").first();

      const img = toAbs(src);
      const href = toAbs(a.attr("href") || "");
      if (!img || !href) return;

      const title = (
        $(el).attr("alt") ||
        a.text() ||
        $(el).attr("title") ||
        ""
      ).replace(/\s+/g, " ").trim();

      const key = `${img}|${href}`;
      if (seen.has(key)) return;
      seen.add(key);

      out.push({
        sku: title,
        title,
        url: href,
        img,
        price: "",
        currency: "",
        moq: ""
      });
    });

    return out.slice(0, limit);
  }
};
