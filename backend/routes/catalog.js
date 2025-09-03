// backend/routes/catalog.js
import { Router } from "express";
import cheerio from "cheerio";

const router = Router();

/** 小工具：清洗文本 */
function clean(t = "") {
  return String(t)
    .replace(/\s+/g, " ")
    .replace(/\u00A0/g, " ")
    .trim();
}

/** 小工具：绝对化 URL */
function absolutize(href, base) {
  try {
    return new URL(href, base).toString();
  } catch {
    return href || "";
  }
}

/** 下载 HTML（Node18+ 原生 fetch） */
async function fetchHTML(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} when fetching ${url} :: ${text.slice(0, 200)}`);
  }
  return await res.text();
}

/** 适配器：s-impuls-shop.de */
function parseSImpuls($, url) {
  // 尝试多个可能的「商品卡片」容器选择器（Shopware/自研站点常见类名）
  const itemSelList = [
    ".product-box",
    ".product--box",
    ".product-wrapper",
    ".product-item",
    ".product-list-item",
    ".box--minimal",
    ".box--product",
  ];

  // 可能的字段选择器
  const titleSel = [
    ".product-name a",
    ".product--title a",
    ".product-title a",
    ".title a",
    ".product-name",
    ".product--title",
    ".product-title",
  ];
  const skuSel = [
    ".product-number",
    ".product--ordernumber",
    ".ordernumber",
    ".sku",
    ".product-sku",
  ];
  const priceSel = [
    ".price",
    ".product-price",
    ".product--price",
    ".price--default",
    ".price--content",
  ];
  const linkSel = ["a.product-link", ".product-image a", ".product--image a", "a"];
  const imgSel = [".product-image img", ".image--element img", "img"];

  const items = [];
  let containerFound = null;

  for (const itemSel of itemSelList) {
    const found = $(itemSel);
    if (found && found.length > 0) {
      containerFound = itemSel;
      found.each((_, el) => {
        const $el = $(el);
        // 标题
        let title = "";
        for (const s of titleSel) {
          const t = clean($el.find(s).first().text());
          if (t) {
            title = t;
            break;
          }
        }
        // SKU
        let sku = "";
        for (const s of skuSel) {
          const t = clean($el.find(s).first().text());
          if (t) {
            sku = t.replace(/(SKU|Artikel|Art\.?Nr\.?|Artikel-Nr\.?):?\s*/i, "");
            break;
          }
        }
        // 价格
        let price = "";
        for (const s of priceSel) {
          const t = clean($el.find(s).first().text());
          if (t) {
            price = t;
            break;
          }
        }
        // 链接
        let href = "";
        for (const s of linkSel) {
          const a = $el.find(s).first();
          const h = a.attr("href");
          if (h && !h.startsWith("#")) {
            href = absolutize(h, url);
            break;
          }
        }
        // 图片
        let image = "";
        for (const s of imgSel) {
          const im = $el.find(s).first();
          const src = im.attr("data-src") || im.attr("src");
          if (src) {
            image = absolutize(src, url);
            break;
          }
        }

        // 过滤掉明显为空的
        if (title || href) {
          items.push({ title, sku, price, url: href, image });
        }
      });
      break;
    }
  }

  return {
    ok: true,
    site: "s-impuls-shop",
    containerFound,
    count: items.length,
    items,
  };
}

/** 通用回退：从列表页粗略抓取可能的商品链接 */
function parseGeneric($, url) {
  const items = [];
  $("a").each((_, a) => {
    const $a = $(a);
    const href = $a.attr("href");
    const text = clean($a.text());
    if (!href || href.startsWith("#")) return;
    // 简单启发式：有图片 / 或者标题像产品名
    const hasImg = $a.find("img").length > 0;
    if (hasImg || (text && text.length > 8)) {
      items.push({
        title: text,
        url: absolutize(href, url),
        sku: "",
        price: "",
        image: $a.find("img").first().attr("src")
          ? absolutize($a.find("img").first().attr("src"), url)
          : "",
      });
    }
  });
  // 去重（按 url）
  const seen = new Set();
  const uniq = items.filter((x) => {
    if (!x.url) return false;
    if (seen.has(x.url)) return false;
    seen.add(x.url);
    return true;
  });

  return {
    ok: true,
    site: "generic",
    count: uniq.length,
    items: uniq.slice(0, 200),
  };
}

/** 主路由：POST /v1/api/catalog
 * body: { url: string }
 */
router.post("/", async (req, res) => {
  try {
    const { url = "" } = req.body || {};
    if (!url || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ ok: false, error: "参数缺失：url" });
    }

    const html = await fetchHTML(url);
    const $ = cheerio.load(html);

    const hostname = new URL(url).hostname.replace(/^www\./, "");

    let parsed;
    if (hostname.includes("s-impuls-shop.de")) {
      parsed = parseSImpuls($, url);
      // 如果没有命中容器，则回退到通用解析
      if (!parsed?.count) {
        parsed = parseGeneric($, url);
        parsed.note = "fallback:generic";
      }
    } else {
      // 其它站点走通用回退
      parsed = parseGeneric($, url);
    }

    return res.json({
      ok: true,
      url,
      ...parsed,
      fetchedAt: Date.now(),
    });
  } catch (err) {
    console.error("[/v1/api/catalog] ERROR:", err);
    return res.status(500).json({
      ok: false,
      error: String(err?.message || err),
    });
  }
});

export default router;
