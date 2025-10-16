// backend/lib/parsers/woocommerceParser.js
function pickText($, el) { return ($(el).text() || '').replace(/\s+/g, ' ').trim(); }
function abs(base, href) { try { return new URL(href, base).toString(); } catch { return href || ''; } }
function readPrice($, node) {
  const txt = pickText($, $(node).find('.price, .amount, [itemprop="price"], .wc-block-grid__product-price'));
  const m = txt.match(/(\d+[.,]\d{2})/);
  return m ? m[1].replace(',', '.') : '';
}
function firstFromSrcset(s=''){ const x=(s||'').split(',')[0]||''; return x.split(/\s+/)[0]||''; }

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
        let price = '', currency = '';
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
  const out = [];

  const baseCards = $(
    'ul.products li.product, ' +           // 经典 UL 列表
    '.products .product, ' +               // 通用 products 容器
    '.wc-block-grid__product, ' +          // Block Grid
    '[class*="product-card"]'              // 一些主题的卡片类
  );

  const linkAnchors = $('a.woocommerce-LoopProduct-link, a.woocommerce-LoopProduct__link, a[href*="/product/"]');
  const fromLinks = linkAnchors.closest('li.product, .product, .wc-block-grid__product');

  const cards = baseCards.add(fromLinks);

  cards.each((_, el) => {
    const $el = $(el);

    const a = $el.find('a.woocommerce-LoopProduct-link[href], a.woocommerce-LoopProduct__link[href], a[href*="/product/"], a[href]').first().length
      ? $el.find('a.woocommerce-LoopProduct-link[href], a.woocommerce-LoopProduct__link[href], a[href*="/product/"], a[href]').first()
      : $el.closest('a[href]').first();

    const title =
      pickText($, $el.find('.woocommerce-loop-product__title, .product-title, .wc-block-grid__product-title, h2, h3, [itemprop="name"]').first()) ||
      (a.attr('title') || '').trim() ||
      pickText($, a);

    const link = abs(url, a.attr('href') || '');

    const imgEl = $el.find('img').first();
    const img =
      abs(url, imgEl.attr('data-src') || '') ||
      abs(url, firstFromSrcset(imgEl.attr('data-srcset') || imgEl.attr('srcset') || '')) ||
      abs(url, imgEl.attr('src') || '');

    const price = readPrice($, $el);

    if (title && link) {
      out.push({
        title, url: link, link,
        img, imgs: img ? [img] : [],
        price, currency: '', sku: '', moq: '', desc: ''
      });
    }
  });

  // JSON-LD 回退/补充
  out.push(...collectJsonLdProducts($, url));

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
  id: 'woocommerce',
  test: (_$, url) => /woocommerce|\/product-category\//i.test(url),
  parse
};

module.exports = api;
module.exports.default = api;
