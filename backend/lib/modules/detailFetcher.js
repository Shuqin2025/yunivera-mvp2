// backend/lib/modules/detailFetcher.js
// 通用详情页补抓：SKU / EAN / 其它字段
//
// 用法：
// const detailFetcher = require('../modules/detailFetcher');
// const enriched = await detailFetcher.fetch(items, { pickSku, concurrency: 3 });
//
// - items: [{ title, url, link, ... }]  —— 目录页产出
// - pickSku($, url, item) => string     —— 可选自定义提取函数（站点特例）
// - 也提供内置 heuristicsSku($) 做兜底
//
// 还提供：shouldFetch(items, {key:'sku', threshold:0.6}) -> boolean

const { load } = require('cheerio');
const http = require('../http'); // 你已有：backend/lib/http.js
const pLimit = require('p-limit');

function text($, sel) {
  return ($(sel).text() || '').replace(/\s+/g, ' ').trim();
}

function heuristicsSku($) {
  // 1) 常见 label/行内字段
  const candidates = [
    '*:contains("Artikel-Nr")',
    '*:contains("Artikelnummer")',
    '*:contains("SKU")',
    '*:contains("Bestellnummer")',
    '*[itemprop="sku"]'
  ];

  for (const sel of candidates) {
    const node = $(sel).first();
    if (node.length) {
      // “Artikel-Nr.: 12345” => 取冒号后的内容
      const t = node.text().replace(/\s+/g, ' ').trim();
      const m = t.match(/[:：#]\s*([A-Za-z0-9._-]{3,})$/) || t.match(/\b([A-Za-z0-9._-]{3,})\b$/);
      if (m && m[1]) return m[1];
    }
  }

  // 2) meta / ld+json
  const metaSku = $('meta[itemprop="sku"]').attr('content') || $('meta[name="sku"]').attr('content');
  if (metaSku) return (metaSku + '').trim();

  // 3) 最后：在整页文本中粗匹配
  const pageText = $('body').text().replace(/\s+/g, ' ');
  const m = pageText.match(/(Artikel[-\s]?Nr\.?|SKU|Bestellnummer)\s*[:：#]?\s*([A-Za-z0-9._-]{3,})/i);
  if (m && m[2]) return m[2];

  return '';
}

function shouldFetch(items, { key = 'sku', threshold = 0.5 } = {}) {
  if (!Array.isArray(items) || !items.length) return false;
  const missing = items.filter(x => !x || !x[key]).length;
  return missing / items.length >= threshold;
}

async function fetch(items, {
  concurrency = 3,
  timeout = 15000,
  pickSku = null,     // 自定义：($, url, item) => string
  merge = (item, extra) => Object.assign(item, extra)
} = {}) {
  if (!Array.isArray(items) || !items.length) return items;

  const limit = pLimit(concurrency);

  const jobs = items.map(item => limit(async () => {
    try {
      // 没有链接无法补抓
      const link = item.link || item.url;
      if (!link) return item;

      // 已有 SKU 则跳过（也可以改为强制刷新）
      if (item.sku) return item;

      const html = await http.get(link, { timeout }); // 你项目的 http.get 应返回 HTML 字符串
      const $ = load(html);

      const sku = typeof pickSku === 'function' ? (pickSku($, link, item) || '') : heuristicsSku($);

      if (sku) {
        merge(item, { sku });
      }
    } catch (e) {
      // 静默失败，避免打断主流程
    }
    return item;
  }));

  return Promise.all(jobs);
}

module.exports = { fetch, shouldFetch, heuristicsSku };
