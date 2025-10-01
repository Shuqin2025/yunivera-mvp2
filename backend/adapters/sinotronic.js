/**
 * Sinotronic 列表页适配器 v1.6（ESM）
 * 目标： http://www.sinotronic-e.com/list/?9_1.html 这类静态目录页
 *
 * 思路：
 * 1) 先在 #productlist/.productlist/.editor 容器里找含 <img> 的 <li>
 * 2) 若未命中，兜底：全页扫描 <img>，仅保留 /upload/product/…（大小写不敏感）
 * 3) 近邻/就近寻找 <a href> 作为链接；优先 img.alt / a.text / img.title 作为标题
 * 4) 统一补全绝对地址，按图片去重，返回标准字段
 *
 * 返回：Array<{ sku, title, url, img, price, currency, moq }>
 */
export default {
  test(u) {
    return /https?:\/\/(www\.)?sinotronic-e\.com\//i.test(String(u || ""));
  },

  /**
   * @param {CheerioStatic} $  — 已经加载好 HTML 的 cheerio 根
   * @param {string} pageUrl   — 当前页面 URL，用于补全相对地址
   * @param {object} opts      — { limit?: number, debug?: boolean }
   */
  parse($, pageUrl, opts = {}) {
    const limit = Number(opts.limit || 60);

    const toAbs = (u) => {
      if (!u) return "";
      try { return new URL(u, pageUrl).href; } catch { return String(u || ""); }
    };

    const push = (bag, rec) => {
      if (!rec || !rec.img) return;
      if (seen.has(rec.img)) return;
      seen.add(rec.img);
      bag.push(rec);
    };

    const out = [];
    const seen = new Set();

    // -------------------------
    // 1) 容器优先：只在“像列表”的区域里取
    // -------------------------
    let $ctn = $("#productlist");
    if (!$ctn.length) $ctn = $(".productlist, .editor").first();
    if (!$ctn.length) $ctn = $("body");

    let $lis = $ctn.find("li:has(img)");
    if (!$lis.length) $lis = $ctn.find("li");

    $lis.each((_, li) => {
      if (out.length >= limit) return false;
      const $li  = $(li);
      const $img = $li.find("img").first();
      if (!$img.length) return;

      // 近邻 a[href]
      let $a = $li.find("a[href]").first();
      if (!$a.length) $a = $img.closest("a[href]");

      const img   = toAbs($img.attr("src") || $img.attr("data-src") || $img.attr("data-original") || "");
      const href  = toAbs(($a && $a.attr("href")) || "");
      const title = (
        $img.attr("alt") ||
        ($a && $a.text()) ||
        $img.attr("title") ||
        $li.text() ||
        ""
      ).trim();

      if (!img && !href && !title) return;
      push(out, { sku: title || "", title: title || "", url: href, img, price: "", currency: "", moq: "" });
    });

    // -------------------------
    // 2) 兜底：全页扫描图片，限定 /upload/product/（大小写不敏感）
    // -------------------------
    if (out.length === 0) {
      $("img").each((_, el) => {
        if (out.length >= limit) return false;
        const $img = $(el);
        const src  = $img.attr("src") || $img.attr("data-src") || $img.attr("data-original") || "";
        if (!/\/upload\/product\//i.test(src)) return;

        // a[href]：先最近祖先，再 li 内，再父节点内
        let $a = $img.closest("a[href]");
        if (!$a.length) {
          const $li = $img.closest("li");
          if ($li.length) $a = $li.find("a[href]").first();
        }
        if (!$a.length) $a = $img.parent().find("a[href]").first();

        const img   = toAbs(src);
        const href  = toAbs(($a && $a.attr("href")) || "");
        const title = (
          $img.attr("alt") ||
          ($a && $a.text()) ||
          $img.attr("title") ||
          ""
        ).trim();

        if (!img) return;
        push(out, {
          sku: title || img.split("/").pop(),
          title: title || img.split("/").pop(),
          url: href,
          img,
          price: "",
          currency: "",
          moq: ""
        });
      });
    }

    try {
      console.log("[sinotronic] out=%d first=%s", out.length, out[0]?.img || "");
    } catch {}
    return out.slice(0, limit);
  }
};
