// backend/adapters/memoryking.js
// Memoryking 站点适配（v2.10，自补充SKU/Model）
// - 目录页抓基础信息
// - 自动并发进入详情页，解析 Artikel-Nr. / SKU / Model
// - 将结果落到 code / sku / model / mpn 四个字段，确保前端“货号”列可见

import * as cheerio from "cheerio";
import { fetchHtml, abs, pickImg } from "../lib/http.js";

/** 小工具：安全取文本 */
const txt = (el) =>
  (el && (Array.isArray(el) ? el.map((n) => cheerio.load("<x/>").root().text(n)).join(" ") : String(el)))?.trim?.() || "";

/** 从详情页中解析 SKU/Model（尽量鲁棒） */
function extractModelFromDetail($) {
  // 1) 结构化字段
  const sku1 = $('span[itemprop="sku"]').first().text().trim();
  if (sku1) return sku1;

  // 2) 典型表格/定义列表：dt/th 含“Artikel-Nr / SKU / Modell / Model / Herstellernummer”
  const labels = [
    "Artikel", "Artikel-Nr", "Artikel Nr", "SKU", "Modell", "Model", "Herstellernummer", "Hersteller-Nr", "MPN",
  ];
  const selPairs = [
    ["dt", "dd"],
    ["th", "td"],
  ];
  for (const [lh, rh] of selPairs) {
    $(lh).each((_, el) => {
      const k = $(el).text().replace(/\s+/g, " ").trim();
      if (labels.some((kw) => new RegExp(`^${kw}`, "i").test(k))) {
        const v = $(el).next(rh).first().text().replace(/\s+/g, " ").trim();
        if (v) return (extractModelFromDetail.value = v);
      }
    });
    if (extractModelFromDetail.value) return extractModelFromDetail.value;
  }

  // 3) 列表项/段落里含有“Artikel-Nr: 123456”之类
  const textBlks = [
    $(".product--details"),
    $(".short-description"),
    $("#detail"),
    $("main"),
    $("body"),
  ];
  for (const blk of textBlks) {
    const s = blk.text().replace(/\s+/g, " ").trim();
    const m = s.match(/(?:Artikel[-\s]?Nr\.?|SKU|Modell|Model|Herstellernummer|MPN)\s*[:#]?\s*([A-Z0-9][\w\-\.\/]+)/i);
    if (m && m[1]) return m[1].trim();
  }

  return "";
}

/** 并发限制执行器（简单分片并发） */
async function enrichWithDetail(items, chunkSize = 4) {
  for (let i = 0; i < items.length; i += chunkSize) {
    const slice = items.slice(i, i + chunkSize);
    await Promise.all(
      slice.map(async (it) => {
        try {
          if (!it.url) return;
          const html = await fetchHtml(it.url);
          const $ = cheerio.load(html, { decodeEntities: false });

          const model = extractModelFromDetail($);
          if (model) {
            // 同步到多个常用字段，保证前端“货号”列能命中任一字段
            it.code = model;
            it.sku = model;
            it.model = model;
            it.mpn = model;
          }
        } catch {
          /* 忽略单条失败，继续其它 */
        }
      })
    );
  }
}

/** 解析目录页：尽量兼容 Memoryking（Shopware） */
function parseList($, base, limit) {
  const out = [];

  // Shopware 常见卡片
  let cards = $(".product--box");
  if (!cards.length) {
    // 兜底：一些主题 class
    cards = $(".artbox, .product, .product--listing .box--content, li, article");
  }

  cards.each((_, card) => {
    if (out.length >= limit) return;

    const $card = $(card);

    const a =
      $card.find('a.product--image').first().attr("href") ||
      $card.find('.product--title a').first().attr("href") ||
      $card.find('a[href*="/details/"]').first().attr("href");

    if (!a) return;

    const url = abs(base, a);
    const title =
      $card.find(".product--title a, .product--title, .title, h3, h2").first().text().replace(/\s+/g, " ").trim() ||
      $card.find("a").attr("title") ||
      "";

    // 图片（优先 data-src / data-original / lazy）
    const img =
      pickImg($card.find("img").first()) ||
      pickImg($card) ||
      "";

    // 价格
    const priceTxt =
      $card.find(".price, .price--default, .product--price, .box--price").first().text().replace(/\s+/g, " ").trim();

    out.push({
      title,
      url,
      img,
      price: priceTxt || "",
    });
  });

  return out;
}

export default async function parseMemoryking(input, limitDefault = 80, debugDefault = false) {
  // 入参兼容：字符串 / { url, limit, debug, rawhtml }
  let s = typeof input === "string" ? input : (input && (input.url || input.href)) || String(input || "");
  let limit = (typeof input === "object" && input && input.limit) || limitDefault;
  const debug = (typeof input === "object" && input && input.debug) || debugDefault;

  // 取列表页 HTML
  const html = (typeof input === "object" && input && input.rawhtml) || (await fetchHtml(s));
  const $ = cheerio.load(html, { decodeEntities: false });

  const base = new URL(s, s).origin;
  const items = parseList($, base, limit);

  // ✅ 关键：自动详情页补充 SKU/Model
  await enrichWithDetail(items);

  if (debug) {
    // 控制台/日志需要时可打印第一条看看
    // eslint-disable-next-line no-console
    console.debug("[memoryking] sample =>", items[0]);
  }

  return { items };
}
