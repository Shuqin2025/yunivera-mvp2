// backend/lib/modules/detailFetcher.js
// 通用「详情页补抓」：SKU / 价格 / 标题 / 主图 / 描述
//
// 导出：
//   - fetch(items, opts)
//   - fetchDetails(links, opts)
//   - shouldFetch(items, ...)
//   - normalizeUrl(base, href)
//
import { load } from 'cheerio';
import pLimit from 'p-limit';
import http from '../http.js';
import * as artikel from './artikelExtractor.js';

// ---------- 小工具 ----------
const txt = (s) => (s || '').replace(/\s+/g, ' ').trim();
const first = (...vals) => vals.find(v => !!txt(v));

export function normalizeUrl(base, href) {
  const raw = txt(href);
  if (!raw) return '';
  if (/^(mailto:|tel:|javascript:)/i.test(raw)) return '';
  try {
    if (/^https?:\/\//i.test(raw)) return new URL(raw).toString();
    if (base) return new URL(raw, base).toString();
  } catch {}
  return raw;
}

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
  if (og) return normalizeUrl(baseUrl, og);
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
  return normalizeUrl(baseUrl, raw);
}

function pickPrice($) {
  const p1 = $('meta[itemprop="price"]').attr('content');
  if (p1) return txt(p1);
  const priceSel = [
    '.price--content', '.price--default', '.product-price', '.price', '[itemprop="price"]',
    '.product__price', '.price__current', '.product-price__price'
  ].join(', ');
  const raw = $(priceSel).first().text();
  if (raw) return txt(raw);
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
  const metaSku = $('meta[itemprop="sku"]').attr('content') || $('meta[name="sku"]').attr('content');
  if (metaSku && artikel.extract?.(metaSku)) return txt(metaSku);
  const labelLike = [
    '*:contains("Artikel-Nr")','*:contains("Artikelnummer")','*:contains("SKU")',
    '*:contains("Bestellnummer")','*:contains("Part Number")','*[itemprop="sku"]'
  ];
  for (const sel of labelLike) {
    const node = $(sel).first();
    if (!node.length) continue;
    const t = txt(node.text());
    const fromLabel = artikel.extract?.(t);
    if (fromLabel) return fromLabel;
  }
  const page = txt($('body').text());
  const fromPage = artikel.extract?.(page);
  if (fromPage) return fromPage;
  return '';
}

export function shouldFetch(items, { key = 'sku', threshold = 0.5 } = {}) {
  if (!Array.isArray(items) || !items.length) return false;
  const missing = items.filter(x => !x || !txt(x[key])).length;
  return missing / items.length >= threshold;
}

// ---------- 抓取单个详情页并解析 ----------
async function fetchOne(url, { timeout = 15000, fetchHtml } = {}) {
  const html = fetchHtml
    ? await fetchHtml(url, { timeout })
    : await http.get(url, { timeout });
  const $ = load(html);
  const title = txt(pickTitle($));
  const price = txt(pickPrice($));
  const image = txt(pickImage($, url));
  const description = txt(pickDescription($));
  const sku = txt(heuristicsSku($));
  return { url, sku, title, price, image, description };
}

// ---------- 批量：只返回详情字段 ----------
export async function fetchDetails(
  links = [],
  { base, concurrency = 6, timeout = 15000, fetchHtml } = {}
) {
  if (!Array.isArray(links) || !links.length) return [];
  let inferredBase = base;
  const firstAbs = links.find(href => /^https?:\/\//i.test(String(href || '')));
  if (!inferredBase && firstAbs) {
    try { inferredBase = new URL(firstAbs).origin; } catch {}
  }
  const normalized = links.map(href => normalizeUrl(inferredBase, href)).filter(Boolean);
  const limit = pLimit(concurrency);
  const jobs = normalized.map(url => limit(async () => {
    try { return await fetchOne(url, { timeout, fetchHtml }); }
    catch { return { url, sku: '', title: '', price: '', image: '', description: '' }; }
  }));
  return Promise.all(jobs);
}

// ---------- 兼容：传 items 进来，原地合并 ----------
export async function fetch(
  items = [],
  { base, concurrency = 6, timeout = 15000, fetchHtml, merge = (item, extra) => Object.assign(item, extra) } = {}
) {
  if (!Array.isArray(items) || !items.length) return items;
  const links = items.map(x => x.link || x.url).filter(Boolean);
  const res = await fetchDetails(links, { base, concurrency, timeout, fetchHtml });
  const byUrl = new Map(res.map(r => [r.url, r]));
  for (const it of items) {
    const u = normalizeUrl(base, it.link || it.url);
    const r = byUrl.get(u);
    if (!r) continue;
    const badSku = !txt(it.sku) || /^\d{1,3}$/.test(it.sku);
    merge(it, {
      sku: (badSku && txt(r.sku)) ? r.sku : it.sku,
      title: it.title || r.title,
      price: it.price || r.price,
      image: it.image || r.image,
      description: it.description || r.description,
      url: u,
      link: undefined
    });
  }
  return items;
}

export const fetchDetailsAndMerge = fetch;
