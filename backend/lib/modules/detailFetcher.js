// backend/lib/modules/detailFetcher.js
// 通用「详情页补抓」：SKU / 价格 / 标题 / 主图 / 描述
//
// 导出：
//   - fetch(items, opts)         // 传入 [{link|url, sku?...}]，返回补齐后的 items（原地合并）。
//   - fetchDetails(links, opts)  // 传入 [url...]，返回 [{ url, sku, title, price, image, description }]
//   - shouldFetch(items, ...)    // 判断是否值得触发补抓
//
// 依赖：backend/lib/http.js；modules/artikelExtractor.js

const { load } = require('cheerio');
const pLimit = require('p-limit');
const http = require('../http');
const artikel = require('./artikelExtractor');

// 小工具
const txt = (s) => (s || '').replace(/\s+/g, ' ').trim();
const first = (...vals) => vals.find(v => !!txt(v));

function pickTitle($) {
  return first(
    $('meta[property="og:title"]').attr('content'),
    $('meta[name="twitter:title"]').attr('content'),
    $('h1').first().text(),
    $('title').text()
  ) || '';
}

function pickImage($, baseUrl) {
  const og = $('meta[property="og:image"]').attr('content');
  if (og) return og;

  const imgEl =
    $('img[itemprop="image"]').first()[0] ||
    $('img.product-image, .product__media img, .gallery img, img[data-zoom-image]').first()[0] ||
    $('img').first()[0];

  if (!imgEl) return '';

  const $img = $(imgEl);
  const raw =
    $img.attr('data-src') ||
    $img.attr('data-original') ||
    ($img.attr('srcset') || '').split(/\s+/)[0] ||
    $img.attr('src') ||
    '';

  try { return new URL(raw, baseUrl).toString(); } catch { return raw || ''; }
}

function pickPrice($) {
  // 结构化优先
  const p1 = $('meta[itemprop="price"]').attr('content');
  if (p1) return txt(p1);

  // 常见选择器
  const priceSel = [
    '.price--content', '.price--default', '.product-price', '.price', '[itemprop="price"]',
    '.product__price', '.price__current', '.product-price__price'
  ].join(', ');

  const raw = $(priceSel).first().text();
  if (raw) return txt(raw);

  // 兜底：页面文本找货币
  const body = $('body').text();
  const m = body.match(/([0-9]+[.,][0-9]{2})\s?(€|EUR|CHF|USD|¥|RMB)/i);
  if (m) return `${m[1]} ${m[2]}`;

  return '';
}

function pickDescription($) {
  return first(
    $('meta[name="description"]').attr('content'),
    $('meta[property="og:description"]').attr('content'),
    $('[itemprop="description"]').first().text(),
    $('.product-description, .description, .product__description').first().text()
  ) || '';
}

function heuristicsSku($) {
  // 1) 结构化 & 标签
  const metaSku = $('meta[itemprop="sku"]').attr('content') || $('meta[name="sku"]').attr('content');
  if (metaSku && artikel.extract(metaSku)) return txt(metaSku);

  const labelLike = [
    '*:contains("Artikel-Nr")',
    '*:contains("Artikelnummer")',
    '*:contains("SKU")',
    '*:contains("Bestellnummer")',
    '*:contains("Part Number")',
    '*[itemprop="sku"]'
  ];
  for (const sel of labelLike) {
    const node = $(sel).first();
    if (!node.length) continue;
    const t = txt(node.text());
    const fromLabel = artikel.extract(t);
    if (fromLabel) return fromLabel;
  }

  // 2) 页面全文兜底
  const page = txt($('body').text());
  const fromPage = artikel.extract(page);
  if (fromPage) return fromPage;

  return '';
}

// 是否值得补抓
function shouldFetch(items, { key = 'sku', threshold = 0.5 } = {}) {
  if (!Array.isArray(items) || !items.length) return false;
  const missing = items.filter(x => !x || !txt(x[key])).length;
  return missing / items.length >= threshold;
}

// 核心：抓取单个详情页并解析
async function fetchOne(link, { timeout = 15000 } = {}) {
  const url = link;
  const html = await http.get(url, { timeout });
  const $ = load(html);

  // 字段
  const title = txt(pickTitle($));
  const price = txt(pickPrice($));
  const image = txt(pickImage($, url));
  const description = txt(pickDescription($));

  // SKU：先结构化/标签+正则，再兜底
  const sku = txt(heuristicsSku($));

  return { url, sku, title, price, image, description };
}

// 批量：只返回详情字段，不合并
async function fetchDetails(links = [], { concurrency = 6, timeout = 15000 } = {}) {
  if (!Array.isArray(links) || !links.length) return [];
  const limit = pLimit(concurrency);

  const jobs = links.map(link => limit(async () => {
    try { return await fetchOne(link, { timeout }); }
    catch { return { url: link, sku: '', title: '', price: '', image: '', description: '' }; }
  }));

  return Promise.all(jobs);
}

// 兼容：传 items 进来，原地合并（用于老调用方）
async function fetch(items = [], {
  concurrency = 6,
  timeout = 15000,
  merge = (item, extra) => Object.assign(item, extra),
} = {}) {
  if (!Array.isArray(items) || !items.length) return items;

  const links = items.map(x => x.link || x.url).filter(Boolean);
  const res = await fetchDetails(links, { concurrency, timeout });
  const byUrl = new Map(res.map(r => [r.url, r]));

  for (const it of items) {
    const u = it.link || it.url;
    const r = byUrl.get(u);
    if (!r) continue;
    // 仅补空白；SKU 如果原值缺失/可疑则覆盖
    const badSku = !txt(it.sku) || /^\d{1,3}$/.test(it.sku);
    merge(it, {
      sku: (badSku && txt(r.sku)) ? r.sku : it.sku,
      title: it.title || r.title,
      price: it.price || r.price,
      image: it.image || r.image,
      description: it.description || r.description,
    });
  }
  return items;
}

module.exports = { fetch, fetchDetails, shouldFetch };
