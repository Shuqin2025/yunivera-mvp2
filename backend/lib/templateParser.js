// backend/lib/templateParser.js
const { load } = require('cheerio');
const detect = require('./structureDetector');

// 模板解析器
const shopware = require('./parsers/shopwareParser');
const woo      = require('./parsers/woocommerceParser');
const magento  = require('./parsers/magentoParser');
const shopify  = require('./parsers/shopifyParser');

// 智能编号提取 & 详情页补抓
const artikel = require('./modules/artikelExtractor');
const details = require('./modules/detailFetcher');

// —— 通用垃圾/站点链接过滤 ——
// 尽量宽松，但卡住典型“站点级”链接，避免把目录页页眉/页脚链接当作产品。
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

// —— 兜底解析（极简）：从页面上尽量找“像产品”的 a/card ——
// 这里也会套用 GENERIC_LINK_BAD 过滤
function fallbackParse($, url, limit = 50) {
  const items = [];
  const seen = new Set();

  const CARD_SEL = [
    // 先抓明显的卡片，然后退回到所有 a[href]
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

// 模板映射
const map = {
  Shopware:    shopware,
  WooCommerce: woo,
  Magento:     magento,
  Shopify:     shopify,
};

// 统一结构：name, model, sku, price, image, description, link
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

// 判断 SKU 是否“缺失或可疑”
function skuMissingOrSuspicious(s) {
  const x = (s || '').trim();
  if (!x) return true;
  if (x.length < 4) return true;
  if (/^\d{1,3}$/.test(x)) return true;
  return false;
}

/**
 * 解析统一入口
 * @param {string} html
 * @param {string} url
 * @param {{
 *   limit?: number,
 *   typeHint?: string,
 *   detail?: { enable?: boolean, takeMax?: number, concurrency?: number }
 * }} opts
 */
async function parse(html, url, opts = {}) {
  const {
    limit = 50,
    typeHint = '',
    detail = {}
  } = opts;

  const enableDetail = detail.enable !== false; // 默认开启
  const takeMax      = Math.max(1, detail.takeMax || 20);
  const concurrency  = Math.min(12, Math.max(1, detail.concurrency || 6));

  const $ = load(html);

  // 1) 检测结构类型（可用外部 hint 覆盖）
  let type = '';
  if (typeHint) {
    type = typeHint;
  } else {
    try {
      const d = await detect.detectStructure(url, html);
      type = d && (d.type || d.name || '');
    } catch {}
  }

  // 2) 选择模板并解析；失败走兜底
  const norm = (type || '').toLowerCase();
  let key = '';
  if (norm.includes('shopware')) key = 'Shopware';
  else if (norm.includes('woo')) key = 'WooCommerce';
  else if (norm.includes('magento')) key = 'Magento';
  else if (norm.includes('shopify')) key = 'Shopify';

  let items = [];
  try {
    if (key && map[key] && typeof map[key].parse === 'function') {
      items = await map[key].parse($, url, { limit });
    } else {
      items = fallbackParse($, url, limit);
    }
  } catch {
    items = fallbackParse($, url, limit);
  }

  // 3) 过滤“站点链接”类垃圾（双保险，避免模板误收）
  items = items.filter(it => {
    const href = it.url || it.link || '';
    if (!href) return false;
    return !GENERIC_LINK_BAD.test(href);
  });

  // 4) 统一结构
  let unified = toUnified(items);

  // 4.1) 先用「Artikel-Nr 智能提取」在列表级进行一次补齐（从标题/描述中扒）
  for (const it of unified) {
    if (!skuMissingOrSuspicious(it.sku)) continue;
    const guess = artikel.extract([it.name, it.description].filter(Boolean).join(' '));
    if (guess) it.sku = guess;
  }

  // 5) 自动触发：详情页补抓（仅对缺失/可疑 SKU 的条目，限制条数与并发）
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
        // 合并：以详情页返回为主，仅填补空白，不覆盖已存在的更完整信息
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
      } catch {
        // 补抓失败不影响主流程
      }
    }
  }

  return unified.slice(0, limit);
}

module.exports = { parse };
