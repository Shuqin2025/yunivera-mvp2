// backend/lib/parsers/genericLinksParser.js
// 强化版：过滤导航/法律页/账号页，只保留“像产品”的链接；从邻域和 JSON-LD 回填价格与图片

import { JSDOM } from "jsdom";

const NAV_BLACKLIST = [
  'kontakt','contact','ueber-uns','über-uns','uber-uns','about',
  'agb','terms','privacy','datenschutz','impressum','widerruf','widerrufsbelehrung',
  'zahlung','payment','versand','shipping','rueckgabe','return','retoure',
  'hilfe','help','support','service','faq','sitemap','newsletter','blog',
  'login','signin','anmelden','logout','account','konto','register','signup',
  'cart','warenkorb','checkout','merkliste','wishlist','compare',
  'home','startseite'
];

const PRODUCT_KEYWORDS = [
  'produkt','produkte','product','products','artikel','artnr','sku','model','mod','item',
  'kaufen','zum-produkt','details','detail','buy','add-to-cart'
];

// 典型产品链接特征：/products/xxx、/produkt/xxx、/artikel/12345、末尾带数字或 .html
const PRODUCT_URL_REGEX = new RegExp(
  [
    '/products?/',
    '/produkt/',
    '/produkte/',
    '/artikel/',
    '/p/',
    'product_id=\\d+',
    'art(ikel)?nr=',
    '\\d{4,}',       // 4+ 连号
    '\\.html?$'
  ].join('|'),
  'i'
);

const CURRENCY_REGEX = /(€|eur|chf|\$|usd|£|gbp)/i;

function isNavLike(href) {
  const h = href.toLowerCase();
  return NAV_BLACKLIST.some(k => h.includes(k));
}

function isProbablyProductUrl(href) {
  if (!href) return false;
  const h = href.toLowerCase();
  if (isNavLike(h)) return false;
  return PRODUCT_URL_REGEX.test(h) || PRODUCT_KEYWORDS.some(k => h.includes(k));
}

function hasPriceText(el) {
  if (!el) return false;
  const t = el.textContent.replace(/\s+/g,' ').trim();
  return /\d[\d\.\,\s]*\d?\s*(€|eur|chf|\$|usd|£|gbp)/i.test(t);
}

function nearestText(el, maxDepth = 3) {
  let cur = el, depth = 0;
  while (cur && depth <= maxDepth) {
    const txt = cur.textContent.replace(/\s+/g,' ').trim();
    if (txt) return txt;
    cur = cur.parentElement;
    depth++;
  }
  return '';
}

function findSiblingPrice(a) {
  // 看自身与周围 2 层里是否带价格文本
  if (hasPriceText(a)) return a.textContent;
  let p = a.parentElement;
  for (let d=0; d<2 && p; d++) {
    const withPrice = p.querySelector('*:not(script):not(style)');
    if (withPrice && hasPriceText(p)) return p.textContent;
    const cand = Array.from(p.querySelectorAll('*')).find(hasPriceText);
    if (cand) return cand.textContent;
    p = p.parentElement;
  }
  return '';
}

function findSiblingImage(a) {
  const selfImg = a.querySelector('img[src]');
  if (selfImg) return selfImg.getAttribute('src');
  let p = a.parentElement;
  for (let d=0; d<2 && p; d++) {
    const img = p.querySelector('img[src]');
    if (img) return img.getAttribute('src');
    p = p.parentElement;
  }
  return '';
}

function scoreAnchor(a) {
  const href = a.getAttribute('href') || '';
  let score = 0;
  if (isProbablyProductUrl(href)) score += 5;
  const text = (a.textContent || '').toLowerCase();
  if (PRODUCT_KEYWORDS.some(k => text.includes(k))) score += 2;
  if (findSiblingImage(a)) score += 1;
  if (findSiblingPrice(a)) score += 2;
  // 列表块里的 a 权重大于 header/footer/nav/aside
  let cur = a;
  while (cur) {
    const tag = (cur.tagName || '').toLowerCase();
    if (['header','footer','nav','aside'].includes(tag)) { score -= 3; break; }
    cur = cur.parentElement;
  }
  return score;
}

function uniqueByUrl(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = (it.url || '').replace(/#.*$/, '');
    if (!seen.has(key)) {
      seen.add(key);
      out.push(it);
    }
  }
  return out;
}

function fromJsonLD(document) {
  try {
    const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
    const items = [];
    for (const s of scripts) {
      let json;
      try { json = JSON.parse(s.textContent); } catch { continue; }
      const objs = Array.isArray(json) ? json : [json];
      for (const obj of objs) {
        const t = (obj['@type'] || obj.type || '').toString();
        if (/product/i.test(t)) {
          const name = obj.name || obj.title || '';
          const url = obj.url || '';
          const img = Array.isArray(obj.image) ? obj.image[0] : obj.image || '';
          let price = '';
          const offers = obj.offers || obj.Offer || null;
          if (offers) {
            const off = Array.isArray(offers) ? offers[0] : offers;
            price = off.priceCurrency && off.price
              ? `${off.price} ${off.priceCurrency}`
              : (off.price || '');
          }
          if (url || name) items.push({ title: name || 'item', url, img, price });
        }
      }
    }
    return items;
  } catch { return []; }
}

export default function genericLinksParser({ url, document, logger }) {
  // 1) 先尝试 JSON-LD（有就直接返回，质量最高）
  const fromLD = fromJsonLD(document);
  if (fromLD.length) {
    logger.debug(`[generic-links] JSON-LD products: ${fromLD.length}`);
    return fromLD.slice(0, 100).map((p, i) => ({
      sku: '',
      title: p.title || 'item',
      url: p.url || url,
      img: p.img || '',
      price: p.price || '',
      currency: '',
      moq: '',
      desc: '',
      rank: i + 1,
    }));
  }

  // 2) 过滤候选 <a>
  const anchors = Array.from(document.querySelectorAll('a[href]'))
    .filter(a => {
      const href = a.getAttribute('href') || '';
      if (!href || href.startsWith('mailto:') || href.startsWith('tel:')) return false;
      const low = href.toLowerCase();
      if (isNavLike(low)) return false;

      // header/footer/nav/aside 里的链接通常不是产品
      let cur = a;
      let penalized = false;
      while (cur) {
        const tag = (cur.tagName || '').toLowerCase();
        if (['header','footer','nav','aside'].includes(tag)) { penalized = true; break; }
        cur = cur.parentElement;
      }
      // 仍允许：如果明显像产品（产品 URL 或者附近有价格/图）
      if (penalized && !isProbablyProductUrl(low) && !findSiblingPrice(a) && !findSiblingImage(a)) {
        return false;
      }

      // 文本太短且无图/无价格 -> 多半是导航/图标
      const text = (a.textContent || '').replace(/\s+/g,' ').trim();
      if (text.length < 2 && !findSiblingImage(a) && !findSiblingPrice(a)) return false;

      return isProbablyProductUrl(low) || findSiblingPrice(a) || PRODUCT_KEYWORDS.some(k => text.toLowerCase().includes(k));
    });

  // 3) 评分、去重、组装
  const scored = anchors
    .map(a => ({ a, score: scoreAnchor(a) }))
    .filter(x => x.score >= 2)                  // 低分干掉
    .sort((x, y) => y.score - x.score);

  const products = uniqueByUrl(scored.map(({ a }) => {
    const href = a.getAttribute('href') || '';
    const abs = href.startsWith('http') ? href : new URL(href, url).toString();
    const title = (a.getAttribute('title') || a.textContent || 'item').replace(/\s+/g,' ').trim() || 'item';
    const img = findSiblingImage(a);
    const priceTxt = findSiblingPrice(a);
    const priceMatch = priceTxt && priceTxt.match(/([\d\.\,]+\s*(€|eur|chf|\$|usd|£|gbp))/i);
    const price = priceMatch ? priceMatch[1] : '';

    return {
      sku: '',
      title,
      url: abs,
      img,
      price,
      currency: '',
      moq: '',
      desc: '',
      rank: 0,
    };
  }));

  // 4) 如果仍然很少，最后再宽一点：选取 /products|produkt|artikel/ 的链接填充到 50 条
  if (products.length < 10) {
    const relaxed = Array.from(document.querySelectorAll('a[href]'))
      .filter(a => {
        const href = a.getAttribute('href') || '';
        const low = href.toLowerCase();
        if (isNavLike(low)) return false;
        return PRODUCT_URL_REGEX.test(low);
      })
      .map(a => {
        const href = a.getAttribute('href') || '';
        const abs = href.startsWith('http') ? href : new URL(href, url).toString();
        const title = (a.getAttribute('title') || a.textContent || 'item').replace(/\s+/g,' ').trim() || 'item';
        return { sku: '', title, url: abs, img: '', price: '', currency: '', moq: '', desc: '', rank: 0 };
      });

    for (const r of relaxed) {
      if (!products.find(p => p.url.replace(/#.*$/,'') === r.url.replace(/#.*$/,''))) {
        products.push(r);
        if (products.length >= 50) break;
      }
    }
  }

  logger.debug(`[generic-links] candidates: ${anchors.length}, selected: ${products.length}`);
  return products.slice(0, 50).map((p, i) => ({ ...p, rank: i + 1 }));
}
