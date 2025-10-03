// backend/adapters/memoryking.js
// 站点：memoryking.de
// 目标：目录页抓基础信息 + 自动进入详情页抓取 Artikel-Nr.（写入 items[].no）
// 说明：保持“标准字段”兼容（no / title / desc / img / price / link…），避免影响既有功能。

import * as cheerio from "cheerio";
import { fetchHtml } from "../lib/http.js";

// —— 小工具 —— //
const toAbs = (base, href) => {
  try {
    return new URL(href, base).toString();
  } catch {
    return href || base;
  }
};

const pick = (txt) => (txt || "").replace(/\s+/g, " ").trim();

const first = ($, el, sels) => {
  for (const s of sels) {
    const v = $(el).find(s).first();
    if (v.length) return v;
  }
  return $(); // empty
};

// 解析价格（容错若干常见 price 容器）
const readPrice = ($root) => {
  const t = pick(
    $root
      .find(
        [
          ".price--default",
          ".price--content",
          ".price--normal",
          ".product--price",
          ".product--price-info",
          ".buybox--price",
          ".price",
        ].join(",")
      )
      .first()
      .text()
  );
  return t || "";
};

// 解析图片（支持懒加载）
const readImg = ($root) => {
  const img = first($root, null, ["img"]);
  if (!img.length) return "";
  const attrs = ["data-src", "data-original", "data-srcset", "srcset", "src"];
  for (const a of attrs) {
    const raw = img.attr(a);
    if (raw) {
      // 如果是 srcset，取第一张
      const m = raw.split(",")[0].trim().split(" ")[0];
      return m || raw;
    }
  }
  return "";
};

// —— 详情页：提取 Artikel-Nr —— //
// 兼容多种结构：
// 1) <span class="entry--label">Artikel-Nr.:</span><span class="entry--content">6695</span>
// 2) "Artikel-Nr.: 6695" 在同一个标签里
// 3) “Art.-Nr”, “Artikel Nr”, “Artikelnummer” 等变体
const readSkuFromDetail = ($d) => {
  const LABEL_RE = /^(artikel(?:nummer)?|art\.?\s*[-–—]?\s*nr\.?)\s*:?\s*$/i;
  const INLINE_RE =
    /artikel(?:nummer)?|art\.?\s*[-–—]?\s*nr\.?/i; // 用于一行内匹配

  // 1) label / value 分离的情形（常见于 Shopware）
  // 在所有可能的 label 节点上做匹配
  $d("span, dt, th, div, li, p").each((_, el) => {
    const text = pick($d(el).text());
    if (LABEL_RE.test(text)) {
      const val =
        pick($d(el).next().text()) ||
        pick($d(el).parent().find(".entry--content, .content, .value").first().text());
      if (val) return (readSkuFromDetail.sku = val);
    }
  });
  if (readSkuFromDetail.sku) return readSkuFromDetail.sku;

  // 2) 同一标签内的“Artikel-Nr.: 6695”
  let sku = "";
  $d("li, p, div, span, td").each((_, el) => {
    const t = pick($d(el).text());
    // 只匹配 Artikel/Art.-Nr，不要误抓 Hersteller
    if (!INLINE_RE.test(t)) return;
    // 取冒号/空格之后的内容
    const m =
      t.match(/(?:Artikel(?:nummer)?|Art\.?\s*[-–—]?\s*Nr\.?)\s*[:：]\s*([^\s].{0,60})$/i) ||
      t.match(/(?:Artikel(?:nummer)?|Art\.?\s*[-–—]?\s*Nr\.?)\s*([\-A-Za-z0-9_./ ]{1,60})$/i);
    if (m && m[1]) {
      sku = pick(m[1]);
      return false; // break
    }
  });
  if (sku) return sku;

  // 3) 兜底：搜索“Artikel-Nr”附近的兄弟文本
  const near = $d(":contains('Artikel')").filter((_, el) =>
    /artikel/i.test($d(el).text())
  );
  for (const node of near) {
    const t = pick($d(node).text());
    const m = t.match(/Artikel(?:nummer)?|Art\.?\s*[-–—]?\s*Nr\.?/i)
      ? t.match(/[:：]\s*([^\s].{0,60})$/i)
      : null;
    if (m && m[1]) return pick(m[1]);
  }

  return ""; // 没找到
};

// —— 详情页：构造成单条 item（用于给单链接也能工作） —— //
const parseDetailPage = async (url, html) => {
  const raw = html || (await fetchHtml(url));
  const $d = cheerio.load(raw, { decodeEntities: false });

  const title =
    pick($d("h1, .product--title, .product--header h1").first().text()) || "";

  const img =
    readImg(
      $d(
        ".image-slider--container, .product--image, .product--media, .image--container, .product--gallery, .image-slider--image"
      ).first()
    ) || readImg($d("body"));

  const price = readPrice($d("body"));

  const no = readSkuFromDetail($d) || "";

  return {
    no,
    title,
    desc: title,
    img,
    price,
    link: url,
  };
};

// —— 目录页 —— //
const parseListPage = ($, pageUrl) => {
  const items = [];

  // Shopware 5/6 常见结构
  const cards = $(
    ".listing--container .product--box, .product--box, .product-box, .product--item, .product-box--row"
  );

  cards.each((_, el) => {
    const a =
      first($, el, [
        "a.product--title",
        ".product--title a",
        ".title--link",
        ".product--info a",
        ".product--image a",
        "a",
      ]) || $(el).find("a").first();

    const href = toAbs(pageUrl, a.attr("href"));
    if (!href) return;

    const title =
      pick($(el).find(".product--title, .title, h3, .product--info a").first().text()) ||
      pick(a.text());

    const img =
      readImg(
        first($, el, [
          ".product--image",
          ".image--container",
          ".product--media",
          ".product--cover",
        ])
      ) || readImg($(el));

    const price = readPrice($(el));

    items.push({
      no: "", // 先占位，随后详情页填充
      title,
      desc: title,
      img,
      price,
      link: href,
    });
  });

  return items;
};

// —— 主入口 —— //
export default async function parseMemoryking(input, limitDefault = 50, debugDefault = false) {
  // 兼容：既可传字符串 URL，也可传 { url, $, rawHtml, limit, debug }
  let url = "", $, rawHtml = "", limit = limitDefault, debug = debugDefault;

  if (typeof input === "string") {
    url = input;
  } else if (input && typeof input === "object") {
    url = input.url || "";
    $ = input.$;
    rawHtml = input.rawHtml || "";
    if (typeof input.limit !== "undefined") limit = input.limit;
    if (typeof input.debug !== "undefined") debug = input.debug;
  }

  // 如果是详情页，直接解析单条
  if (/\/details\//i.test(url)) {
    const single = await parseDetailPage(url, rawHtml);
    return [single];
  }

  // 目录页
  const html = rawHtml || (await fetchHtml(url));
  const $$ = $ || cheerio.load(html, { decodeEntities: false });
  let items = parseListPage($$, url);

  if (limit && items.length > limit) items = items.slice(0, limit);

  // —— 轻量并发进入详情页，补充 Artikel-Nr 到 items[].no —— //
  // 保守并发（3 个），避免对端过载；失败不影响其它条目
  const CONCURRENCY = 3;
  const jobs = [];
  let running = 0, idx = 0;

  const runNext = async () => {
    if (idx >= items.length) return;
    const i = idx++;
    const it = items[i];
    running++;
    try {
      const detail = await parseDetailPage(it.link);
      if (detail.no) it.no = detail.no;
      // 如果目录页缺价，详情页兜底补价
      if (!it.price && detail.price) it.price = detail.price;
      // 目录页缺图也用详情页图兜底
      if (!it.img && detail.img) it.img = detail.img;
    } catch (e) {
      if (debug) console.warn("[memoryking] detail fail:", it.link, e.message);
    } finally {
      running--;
      await runNext();
    }
  };

  for (let k = 0; k < Math.min(CONCURRENCY, items.length); k++) {
    jobs.push(runNext());
  }
  await Promise.all(jobs);

  return items;
}
