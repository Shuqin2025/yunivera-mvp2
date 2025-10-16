// Shopware catalog parser (DOM first, JSON-LD fallback, strict filters)
const cheerio = require('cheerio');

function pickText($, el) { return ($(el).text() || '').replace(/\s+/g, ' ').trim(); }
function abs(base, href='') { try { return new URL(href, base).toString(); } catch { return href || ''; } }
function firstSrc(srcset=''){ const x=(srcset||'').split(',')[0]||''; return x.split(/\s+/)[0]||''; }
function cleanTitle(t='') {
  const s = String(t).replace(/\s+/g,' ').trim();
  if (!s) return '';
  if (s === 'item' || s === '{{ title }}' || /^Zu den Bewertungen/i.test(s)) return '';
  return s;
}
const BAD_LINK_PATTERNS = [
  '/cart', '/checkout', '/account', '/wishlist',
  '/kontakt', '/contact', '/hilfe', '/support', '/agb', '/impressum',
  '/privacy', '/datenschutz', '/versand', '/shipping', '/returns'
];
function isBadLink(u=''){ return BAD_LINK_PATTERNS.some(x => u.includes(x)); }
function looksLikeProduct(u=''){ return u.includes('/detail/'); }
function readPriceFromText(txt=''){ const m=String(txt).replace(/\s+/g,' ').match(/(\d+[.,]\d{2})/); return m?m[1].replace(',', '.'):''; }

function collectJsonLdProducts($, baseUrl){
  const out=[];
  $('script[type="application/ld+json"]').each((_i,s)=>{
    let json; try{ json=JSON.parse($(s).contents().text()); }catch{ json=null; }
    if(!json) return;
    const bag=Array.isArray(json)?json:[json];
    for(const node of bag){
      const arr=[];
      if(node && node['@type']==='Product') arr.push(node);
      if(node && Array.isArray(node['@graph'])) node['@graph'].forEach(x=>{ if(x && x['@type']==='Product') arr.push(x); });
      for(const p of arr){
        const title = cleanTitle(p.name || p.title || '');
        const link  = abs(baseUrl, p.url || p['@id'] || '');
        const img   = abs(baseUrl, (Array.isArray(p.image)?p.image[0]:p.image) || '');
        const offers = Array.isArray(p.offers)?p.offers[0]:p.offers;
        const price = offers && (offers.price||'') || '';
        const currency = offers && (offers.priceCurrency||'') || '';
        if(!title || !link || isBadLink(link) || !looksLikeProduct(link)) continue;
        out.push({ title, url: link, link, img, imgs: img?[img]:[], price: String(price||''), currency: String(currency||''), sku: p.sku||p.mpn||'', moq:'', desc: p.description||'' });
      }
    }
  });
  return out;
}

function parse($, url, { limit=50 } = {}){
  const out = [];

  const cards = $([
    '.product-box',          // SW6
    '.product--box',         // SW5
    '[data-product-id]'      // 数据属性
  ].join(','));

  cards.each((_i, el)=>{
    const $el=$(el);
    const a = $el.find('a[href*="/detail/"], a.product-name[href], a[href*="/product/"], a[href]').first();
    const link = abs(url, a.attr('href') || '');
    if (!link || isBadLink(link) || !looksLikeProduct(link)) return;

    const title = cleanTitle(
      pickText($, $el.find('.product-name, .product-name-link, .product--title, h3, h2').first()) ||
      (a.attr('title')||'').trim() ||
      pickText($, a)
    );
    if (!title) return;

    const imgEl = $el.find('img').first();
    const img =
      abs(url, imgEl.attr('data-src') || '') ||
      abs(url, firstSrc(imgEl.attr('data-srcset') || imgEl.attr('srcset') || '')) ||
      abs(url, imgEl.attr('src') || '');

    const price = readPriceFromText(pickText($, $el.find('.product-price, [itemprop="price"], .price--default, .price')));

    out.push({ title, url: link, link, img, imgs: img?[img]:[], price, currency:'', sku:'', moq:'', desc:'' });
  });

  // JSON-LD 回退/增强
  out.push(...collectJsonLdProducts($, url));

  // 去重 + 截断
  const uniq=[]; const seen=new Set();
  for(const it of out){
    const key=it.link||it.url;
    if(!key || seen.has(key)) continue;
    seen.add(key);
    uniq.push(it);
    if(uniq.length>=limit) break;
  }
  return uniq;
}

const api = {
  id: 'shopware',
  test: (_$, u) => /shopware|\/detail\/|\/listing\//i.test(u),
  parse
};

module.exports = api;
module.exports.default = api;
