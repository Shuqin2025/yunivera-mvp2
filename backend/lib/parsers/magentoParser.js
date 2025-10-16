// magentoParser.js
// 目标：优先从 Magento 列表 DOM 提取；支持不同主题的类名；回退 JSON-LD；去重+limit
const cheerio = require('cheerio');

function pickText($, el) { return ($(el).text() || '').replace(/\s+/g, ' ').trim(); }
function abs(base, href='') { try { return new URL(href, base).toString(); } catch { return href || ''; } }
function firstFromSrcset(s=''){ const x=(s||'').split(',')[0]||''; return x.split(/\s+/)[0]||''; }
function priceFrom($, scope) {
  const t = pickText($, $(scope).find('[data-price-amount],[data-price-type], .price, [itemprop="price"], .normal-price, .price-final_price'));
  const m = t.match(/(\d+[.,]\d{2})/);
  return m ? m[1].replace(',', '.') : '';
}

function collectJsonLdProducts($, base) {
  const out = [];
  $('script[type="application/ld+json"]').each((_i, s) => {
    let json; try { json = JSON.parse($(s).contents().text()); } catch { json = null; }
    if (!json) return;

    const bag = Array.isArray(json) ? json : [json];
    for (const node of bag) {
      const arr = [];
      if (node && node['@type'] === 'Product') arr.push(node);
      if (node && Array.isArray(node['@graph'])) node['@graph'].forEach(x => { if (x['@type']==='Product') arr.push(x); });
      for (const p of arr) {
        const title = p.name || p.title || '';
        const link  = abs(base, p.url || p['@id'] || '');
        const img   = abs(base, (Array.isArray(p.image) ? p.image[0] : p.image) || '');
        let price = '';
        let currency = '';
        const offers = Array.isArray(p.offers) ? p.offers[0] : p.offers;
        if (offers) { price = String(offers.price || ''); currency = String(offers.priceCurrency || ''); }
        if (title && link) {
          out.push({
            title, url: link, link,
            img, imgs: img ? [img] : [],
            price, currency,
            sku: p.sku || p.mpn || '', moq: '', desc: p.description || ''
          });
        }
      }
    }
  });
  return out;
}

function parse($, url, { limit = 50 } = {}) {
  const base = url;
  const out = [];

  // 常见 Magento 列表卡片选择器
  const cards = $([
    'li.product-item',
    '.product-item',
    '.products.list.items > .item'
  ].join(','));

  cards.each((_i, el) => {
    const $el = $(el);

    const a = $el.find('a.product-item-link[href], a[href*="/product/"], a[href]').first();
    const link = abs(base, a.attr('href') || '');

    const title =
      (a.attr('title') || '').trim() ||
      pickText($, $el.find('.product-item-link, .product.name a, h2, h3').first()) ||
      pickText($, a);

    const imgEl = $el.find('img').first();
    const img =
      abs(base, imgEl.attr('data-src') || '') ||
      abs(base, firstFromSrcset(imgEl.attr('data-srcset') || imgEl.attr('srcset') || '')) ||
      abs(base, imgEl.attr('src') || '');

    const price =
      priceFrom($, $el) ||
      priceFrom($, $el.find('[data-role="priceBox"], .price-box, .price'));

    if (title && link) {
      out.push({
        title, url: link, link,
        img, imgs: img ? [img] : [],
        price, currency: '', sku: '', moq: '', desc: ''
      });
    }
  });

  // JSON-LD 补充
  out.push(...collectJsonLdProducts($, base));

  // 去重 + 截断
  const uniq = [];
  const seen = new Set();
  for (const it of out) {
    const key = it.link || it.url;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    uniq.push(it);
    if (uniq.length >= limit) break;
  }

  return uniq;
}

const api = {
  id: 'magento',
  test: (_$, url) => /magento|\/product\/|\/catalog\/category\//i.test(url),
  parse
};

module.exports = api;
module.exports.default = api;
