// backend/routes/catalog.js
import { Router } from 'express';
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import { URL as NodeURL } from 'url';

const router = Router();

// —— 工具函数 ——
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const abs = (base, href) => {
  try { return new NodeURL(href, base).toString(); } catch { return href; }
};
const cleanText = (s='') => (s || '').replace(/\s+/g, ' ').trim();

// 价格/币种粗提取
function parsePriceCurrency(txt='') {
  const s = txt.replace(/,/g, '.');
  const m = s.match(/([€$£]|USD|EUR|GBP)?\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (!m) return { price: null, currency: null };
  const sym = (m[1] || '').toUpperCase();
  const price = parseFloat(m[2]);
  let currency = null;
  if (sym === '€' || sym === 'EUR') currency = 'EUR';
  else if (sym === '$' || sym === 'USD') currency = 'USD';
  else if (sym === '£' || sym === 'GBP') currency = 'GBP';
  return { price, currency };
}

// —— 站点适配骨架（优先规则） ——
// 可逐步为 1688/Alibaba/Amazon/OTTO/Hornbach/s-impuls 等添加更精准选择器
const siteAdapters = [
  {
    test: (u) => /s-impuls-shop\.de/.test(u),
    list: ($, base) => {
      // 尝试匹配常见电商卡片
      const items = [];
      const cards = $('.product, .product-item, .product--box, [data-product-id]');
      cards.each((_, el) => {
        const $el = $(el);
        const a = $el.find('a').first();
        const title = cleanText($el.find('.product-title, .product--title, .title, h3, h2, a').first().text()) || cleanText(a.text());
        const url = abs(base, a.attr('href'));
        const priceTxt = cleanText($el.find('.price, .product-price, .product--price').first().text());
        const { price, currency } = parsePriceCurrency(priceTxt);
        if (url && title) items.push({ url, title, price, currency });
      });
      return items;
    },
    next: ($, base) => {
      const a = $('a.next, a[rel=next], .pagination-next a').first();
      return a.length ? abs(base, a.attr('href')) : null;
    },
    detail: ($, base) => {
      const title = cleanText($('.product-title, .product--title, h1').first().text());
      const sku = cleanText($('.sku, .product-number, [itemprop=sku]').first().text());
      const ean = cleanText($('.ean, .gtin, [itemprop=gtin13]').first().text());
      const desc = cleanText($('.product-description, .description, [itemprop=description]').first().text());
      const priceTxt = cleanText($('.price, .product-price, [itemprop=price]').first().text());
      const { price, currency } = parsePriceCurrency(priceTxt);
      const images = [];
      $('img').each((_, img) => {
        const src = $(img).attr('data-src') || $(img).attr('src');
        if (src) images.push(abs(base, src));
      });
      return { title, sku, ean, description: desc, price, currency, images: [...new Set(images)].slice(0, 6) };
    }
  }
  // 其他站点可继续添加 …
];

// —— 通用回退：尽力模式 —— 
const genericAdapter = {
  list: ($, base) => {
    const items = [];
    const cards = $('[data-product-id], .product, .product-item, .product-card, .product--box, li, article');
    cards.each((_, el) => {
      const $el = $(el);
      const a = $el.find('a').first();
      const title = cleanText($el.find('h3, h2, .title, .product-title, .product--title, a').first().text());
      const url = abs(base, a.attr('href'));
      const priceTxt = cleanText($el.find('.price, .product-price').first().text());
      const { price, currency } = parsePriceCurrency(priceTxt);
      if (url && title) items.push({ url, title, price, currency });
    });
    // 如果还抓不到，退而求其次：抓页面前 50 个链接名当标题
    if (items.length < 3) {
      $('a').slice(0, 50).each((_, a) => {
        const $a = $(a);
        const title = cleanText($a.text());
        const url = abs(base, $a.attr('href'));
        if (title && url && /\/(p|prod|artikel|product|item)/i.test(url)) items.push({ url, title });
      });
    }
    return items;
  },
  next: ($, base) => {
    const a = $('a.next, a[rel=next], .pagination a:contains("Next"), .pagination a:contains("Weiter")').first();
    return a.length ? abs(base, a.attr('href')) : null;
  },
  detail: ($, base) => {
    const title = cleanText($('h1, .title, .product-title, .product--title').first().text());
    const sku = cleanText($(' .sku, .product-number, [itemprop=sku]').first().text());
    const ean = cleanText($(' .ean, .gtin, [itemprop=gtin13]').first().text());
    const desc = cleanText($('.description, .product-description, [itemprop=description]').first().text())
      || cleanText($('p').slice(0, 3).text());
    const priceTxt = cleanText($('.price, .product-price, [itemprop=price]').first().text());
    const { price, currency } = parsePriceCurrency(priceTxt);
    const images = [];
    $('img').each((_, img) => {
      const src = $(img).attr('data-src') || $(img).attr('src');
      if (src) images.push(abs(base, src));
    });
    return { title, sku, ean, description: desc, price, currency, images: [...new Set(images)].slice(0, 6) };
  }
};

// 抓取单页 HTML
async function getHTML(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) MVP3Bot/1.0',
      'Accept-Language': 'de,en;q=0.9,zh;q=0.8',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

// 入口：目录抓取
router.post('/', async (req, res) => {
  try {
    const { url, limit = 30, maxPages = 3, delayMs = 600 } = req.body || {};
    if (!url) return res.status(400).json({ ok: false, error: '缺少 url' });

    const adapter = siteAdapters.find(a => a.test?.(url)) || {};
    const listParser = adapter.list || genericAdapter.list;
    const nextParser = adapter.next || genericAdapter.next;
    const detailParser = adapter.detail || genericAdapter.detail;

    let pageUrl = url;
    const collected = [];
    let page = 0;

    while (pageUrl && page < maxPages && collected.length < limit) {
      page++;
      const html = await getHTML(pageUrl);
      const $ = cheerio.load(html);
      const base = pageUrl;

      const items = listParser($, base);
      for (const it of items) {
        if (collected.length >= limit) break;
        // 跟进详情页补齐
        try {
          await sleep(200);
          const h2 = await getHTML(it.url);
          const $2 = cheerio.load(h2);
          const d = detailParser($2, it.url);
          collected.push({
            url: it.url,
            title: d.title || it.title || '',
            price: d.price ?? it.price ?? null,
            currency: d.currency ?? it.currency ?? null,
            sku: d.sku || null,
            ean: d.ean || null,
            description: d.description || '',
            images: d.images || [],
          });
        } catch (e) {
          // 记录失败但不中断
          collected.push({ url: it.url, title: it.title || '', error: String(e) });
        }
        if (delayMs) await sleep(delayMs);
      }

      if (collected.length >= limit) break;
      const next = nextParser($, base);
      if (!next) break;
      pageUrl = next;
      if (delayMs) await sleep(delayMs);
    }

    res.json({ ok: true, count: collected.length, items: collected });
  } catch (err) {
    console.error('[catalog] error:', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

export default router;
