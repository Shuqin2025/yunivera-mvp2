// backend/lib/templateParser.js
const { load } = require('cheerio');
const { detectStructure } = require('./structureDetector');

// —— 各平台解析器 ——
// 命中平台优先走平台解析器；否则走 generic-links；再不行走极简兜底
const shopware = require('./parsers/shopwareParser');
const woo      = require('./parsers/woocommerceParser');
const magento  = require('./parsers/magentoParser');
const shopify  = require('./parsers/shopifyParser');
const generic  = require('./parsers/genericLinksParser'); // ← 新增

// 智能编号提取 & 详情页补抓
const artikel = require('./modules/artikelExtractor');
const details = require('./modules/detailFetcher');

// 解析后结果过少的回退策略（命中模板但抓不到 ≥3 个有效产品时返回空）
function withFallback(parseFn, $, url, limit, adapterName) {
  try {
    const data = parseFn($, url, { limit }) || [];
    const valid = Array.isArray(data) ? data.filter(x => x && x.title && x.url) : [];
    if (valid.length >= 3) return data;
    if (process.env.DEBUG) console.log('[parser.fallback]', { adapter: adapterName, got: valid.length });
  } catch (e) {
    if (process.env.DEBUG) console.log('[parser.fallback.error]', { adapter: adapterName, err: String((e && e.message) || e) });
  }
  // 回退：避免误把导航当商品
  return [];
}

// —— 通用垃圾/站点链接过滤 ——（与 detector 中保持同源词表）
const GENERIC_LINK_BAD = new RegExp(
  [
    'hilfe','support','kundendienst','faq','service',
    'agb','widerruf','widerrufsbelehrung','rueckgabe','retoure',
    'versand','lieferung','payment','zahlungs',
    'datenschutz','privacy','cookies?',
    'kontakt','contact','impressum','about','ueber\\-?uns',
    'newsletter','blog','news','sitemap','rss','login','register','account',
    'warenkorb','cart','checkout','bestellung',
    'note','paypal','gift','gutschein','jobs','karriere',
    '\\.pdf$'
  ].join('|'),
  'i'
);

// —— 极简兜底（最后一道保险）——
// 尽量从“看起来像商品卡片/可点击图片/标题”的节点里收集链接
function fallbackParse($, url, limit = 50) {
  const items = [];
  const seen = new Set();

  const CARD_SEL = [
    '.product, .product-card, .product-item, [class*="product"] a[href]',
    'article a[href]',
    'li a[href]',
    'a[href]'
  ].join(', ');

  $(CARD_SEL).each((_, el) => {
    if (items.length >= limit) return false;

    const $el = $(el);
    const $a = $el.is('a') ? $el : $el.find('a[href]').first();
    const rawHref = ($a.attr('href') || '').trim();
    if (!rawHref) return;

    if (GENERIC_LINK_BAD.test(rawHref)) return;
    if (/add-to-cart|wishlist|compare|mailto:/i.test(rawHref)) return;

    let abs = '';
    try { abs = new URL(rawHref, url).toString(); } catch {}
    if (!abs || seen.has(abs)) return;

    const title =
      ($a.attr('title') || '').trim() ||
      ($el.is('a') ? $a.text() : $el.text() || '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!title) return;

    items.push({
      title,
      url: abs,
      img: '',
      imgs: [],
      price: '',
      sku: '',
      desc: ''
    });
    seen.add(abs);
  });

  return items.slice(0, limit);
}

// —— 模板映射 ——（供优先级选择）
const map = {
  Shopware:    shopware,
  WooCommerce: woo,
  Magento:     magento,
  Shopify:     shopify,
};

// 统一结构
function toUnified(items = []) {
  return items.map(it => ({
    name:        it.title || it.name || '',
    model:       it.model || '',
    sku:         it.sku || '',
    price:       it.price || '',
    image:       (it.imgs && it.imgs[0]) || it.img || '',
    description: it.desc || it.description || '',
    link:        it.url || it.link || '',
  }));
}

function skuMissingOrSuspicious(s) {
  const x = (s || '').trim();
  if (!x) return true;
  if (x.length < 4) return true;
  if (/^\d{1,3}$/.test(x)) return true;
  return false;
}

/**
 * 解析统一入口
 */
async function parse(html, url, opts = {}) {
  const {
    limit = 50,
    typeHint = '',
    detail = {}
  } = opts;

  const enableDetail = detail.enable !== false;
  const takeMax      = Math.max(1, detail.takeMax || 20);
  const concurrency  = Math.min(12, Math.max(1, detail.concurrency || 6));

  const $ = load(html);

  // 1) 检测结构 & 平台（用于选择解析路径 + 记录调试信息）
  let structure = { type: '', platform: '' };
  try {
    structure = await detectStructure(url, html);
  } catch {}

  const platformFromDetect = structure.platform || '';
  const typeFromDetect     = structure.type || '';
  const type               = typeHint || typeFromDetect;

  if (process.env.DEBUG) {
    console.log('[parser.detect]', JSON.stringify({ url, type, platform: platformFromDetect, debug: structure.debug }));
  }

  // 2) 选择解析器：平台 → generic-links → 极简兜底
  let adapterName = '';
  let items = [];

  // 2.1 平台解析（优先）
  if (platformFromDetect && map[platformFromDetect] && typeof map[platformFromDetect].parse === 'function') {
    items = withFallback(map[platformFromDetect].parse, $, url, limit, platformFromDetect);
    adapterName = platformFromDetect;
  }

  // 2.2 平台解析拿不到结果：尝试 generic-links（更“懂”目录页里的深层商品锚点）
  //    - 如果 detector 判断是 catalog，优先试 generic-links
  if (!items.length || type === 'catalog' || !adapterName) {
    const genericData = withFallback(generic.parse, $, url, limit, 'generic-links');
    if (genericData.length) {
      items = genericData;
      adapterName = 'generic-links';
    }
  }

  // 2.3 仍无结果：极简兜底
  if (!items.length) {
    items = fallbackParse($, url, limit);
    if (!adapterName) adapterName = 'fallback';
  }

  // 3) 二次过滤“站点链接”
  items = items.filter(it => {
    const href = it.url || it.link || '';
    if (!href) return false;
    return !GENERIC_LINK_BAD.test(href);
  });

  // 4) 统一结构
  let unified = toUnified(items);

  // 4.1 SKU 轻量补齐
  for (const it of unified) {
    if (!skuMissingOrSuspicious(it.sku)) continue;
    const guess = artikel.extract([it.name, it.description].filter(Boolean).join(' '));
    if (guess) it.sku = guess;
  }

  // 5) 详情页补抓（仅缺失/可疑 SKU）
  if (enableDetail && unified.length) {
    const need = unified
      .filter(x => skuMissingOrSuspicious(x.sku))
      .slice(0, takeMax);

    if (need.length) {
      try {
        const enriched = await details.fetchDetails(
          need.map(x => x.link),
          { concurrency, timeout: 15000 }
        );
        const byUrl = new Map(unified.map(x => [x.link, x]));
        for (const r of enriched) {
          const t = byUrl.get(r.url);
          if (!t) continue;
          if (skuMissingOrSuspicious(t.sku) && r.sku) t.sku = r.sku;
          if (!t.name && r.title) t.name = r.title;
          if (!t.price && r.price) t.price = r.price;
          if (!t.image && r.image) t.image = r.image;
          if (!t.description && r.description) t.description = r.description;
        }
        unified = Array.from(byUrl.values());
      } catch {}
    }
  }

  if (process.env.DEBUG) {
    console.log('[parser.result]', JSON.stringify({
      url, adapter: adapterName || 'fallback', count: unified.length
    }));
  }

  return unified.slice(0, limit);
}

module.exports = { parse };
