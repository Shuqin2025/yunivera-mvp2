// shopwareParser.js
// 目标：优先从列表 DOM 提取；不稳定时回退 JSON-LD；最后做一次去重 & 截断到 limit
const cheerio = require('cheerio');

function pickText($, el) { return ($(el).text() || '').replace(/\s+/g, ' ').trim(); }
function abs(base, href='') {
  try { return new URL(href, base).toString(); } catch { return href || ''; }
}
function takeFirstUrlFromSrcset(s='') {
  const first = (s || '').split(',')[0] || '';
  return first.split(/\s+/)[0] || '';
}
function readPriceFromText(txt='') {
  const m = String(txt).replace(/\s+/g,' ').match(/(\d+[.,]\d{2})/);
  return m ? m[1].replace(',', '.') : '';
}

function collectJsonLdProducts($, baseUrl) {
  const out = [];
  $('script[type="application/ld+json"]').each((_i, s) => {
    let json;
    try { json = JSON.parse($(s).contents().text()); } catch { json = null; }
    if (!json) return;

    const bag = Array.isArray(json) ? json : [json];
    for (const node of bag) {
      const arr = [];
      if (node && node['@type'] === 'Product') arr.push(node);
      if (node && Array.isArray(node['@graph'])) {
        node['@graph'].forEach(x => { if (x && x['@type']==='Product') arr.push(x); });
      }
      for (const p of arr) {
        const title = p.name || p.title || '';
        const link  = abs(baseUrl, p.url || p['@id'] || '');
        const img   = abs(baseUrl, (Array.isArray(p.image) ? p.image[0] : p.image) || '');
        const price = p.offers && (p.offers.price || (Array.isArray(p.offers) && p.offers[0] && p.offers[0].price)) || '';
        const currency = p.offers && (p.offers.priceCurrency || (Array.isArray(p.offers) && p.offers[0] && p.offers[0].priceCurrency)) || '';
        if (title && link) {
          out.push({
            title, url: link, link,
            img, imgs: img ? [img] : [],
            price: String(price || ''),
            currency: String(currency || ''),
            sku: p.sku || p.mpn || '',
            moq: '', desc: p.description || ''
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

  // 常见 Shopware 卡片：Shopware 5/6 不同主题大多有如下标记
  const cards = $([
    '.product-box',                // SW6 常见
    '.product--box',               // SW5 常见
    '[data-product-id]'            // 数据属性
  ].join(','));

  cards.each((_i, el) => {
    const $el = $(el);
    // 链接
    const a = $el.find('a[href*="/detail/"], a.product-name[href], a[href*="/product/"], a[href]').first();
    const link = abs(base, a.attr('href') || '');

    // 标题
    const title =
      pickText($, $el.find('.product-name, .product-name-link, .product--title, h3, h2').first()) ||
      (a.attr('title') || '').trim() ||
      pickText($, a);

    // 图片（data-src > data-srcset/srcset > src）
    const imgEl = $el.find('img').first();
    const img =
      abs(base, imgEl.attr('data-src') || '') ||
      abs(base, takeFirstUrlFromSrcset(imgEl.attr('data-srcset') || imgEl.attr('srcset') || '')) ||
      abs(base, imgEl.attr('src') || '');

    // 价格
    const price =
      readPriceFromText(pickText($, $el.find('.product-price, [itemprop="price"], .price--default, .price')));

    if (title && link) {
      out.push({
        title, url: link, link,
        img, imgs: img ? [img] : [],
        price, currency: '', sku: '', moq: '', desc: ''
      });
    }
  });

  // JSON-LD 回退（或者增强）
  const jsonld = collectJsonLdProducts($, base);
  out.push(...jsonld);

  // 去重（按链接）
  const uniq = [];
  const seen = new Set();
  for (const it of out) {
    const key = it.link || it.url;
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(it);
    if (uniq.length >= limit) break;
  }

  return uniq;
}

const api = {
  id: 'shopware',
  test: (_$, url) => /shopware|\/detail\/|\/listing\//i.test(url),
  parse
};

module.exports = api;
module.exports.default = api;
