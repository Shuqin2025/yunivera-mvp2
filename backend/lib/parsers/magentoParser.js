// Magento catalog parser (DOM first, JSON-LD fallback, strict filters)
function pickText($, el){ return ($(el).text() || '').replace(/\s+/g,' ').trim(); }
function abs(base, href=''){ try { return new URL(href, base).toString(); } catch { return href || ''; } }
function firstSrc(srcset=''){ const x=(srcset||'').split(',')[0]||''; return x.split(/\s+/)[0]||''; }
function cleanTitle(t=''){
  const s = String(t).replace(/\s+/g,' ').trim();
  if (!s) return '';
  if (s === 'item' || s === '{{ title }}' || /^Zu den Bewertungen/i.test(s)) return '';
  return s;
}
const BAD_LINK_PATTERNS = [
  '/cart', '/checkout', '/customer', '/account', '/wishlist',
  '/kontakt', '/contact', '/hilfe', '/support', '/agb', '/impressum',
  '/privacy', '/datenschutz', '/versand', '/shipping', '/returns', '/search'
];
function isBadLink(u=''){ return BAD_LINK_PATTERNS.some(x=>u.includes(x)); }

// Magento 常见产品详情 URL：以 .html 结尾（多数主题）
// 同时避免类别页（category.html? 不常见），以及 CMS 页
function looksLikeProduct(u=''){
  if (!u) return false;
  if (!u.endsWith('.html')) return false;
  if (u.includes('/category')) return false;
  return true;
}

function readPrice($, scope){
  const txt = pickText($, $(scope).find('[data-price-type="finalPrice"], [data-price-type="basePrice"], .price, [itemprop="price"]'));
  const m = txt.match(/(\d+[.,]\d{2})/);
  return m ? m[1].replace(',', '.') : '';
}

function collectJsonLdProducts($, base){
  const out=[];
  $('script[type="application/ld+json"]').each((_i, s)=>{
    let json; try{ json=JSON.parse($(s).contents().text()); }catch{ json=null; }
    if(!json) return;
    const bag = Array.isArray(json) ? json : [json];
    for(const node of bag){
      const arr=[];
      if(node && node['@type']==='Product') arr.push(node);
      if(node && Array.isArray(node['@graph'])) node['@graph'].forEach(x=>{ if(x && x['@type']==='Product') arr.push(x); });
      for(const p of arr){
        const title = cleanTitle(p.name || p.title || '');
        const link  = abs(base, p.url || p['@id'] || '');
        const img   = abs(base, (Array.isArray(p.image)?p.image[0]:p.image) || '');
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

  // 1) DOM 卡片（Magento Luma/Blank 及多数主题）
  const cards = $([
    '.products-grid .product-item',
    '.product-items .product-item',
    '.product-item-info'
  ].join(','));

  cards.each((_i, el)=>{
    const $el = $(el);

    // 链接
    const a = $el.find('a.product-item-link[href], a[href$=".html"]').first();
    const link = abs(url, a.attr('href') || '');
    if (!link || isBadLink(link) || !looksLikeProduct(link)) return;

    // 标题
    const title = cleanTitle(
      pickText($, $el.find('.product-item-link, .product.name a, .product-item-name a, .product.name, .product-item-name').first()) ||
      (a.attr('title') || '').trim() ||
      pickText($, a)
    );
    if (!title) return;

    // 图片
    const imgEl = $el.find('img').first();
    const img =
      abs(url, imgEl.attr('data-src') || imgEl.attr('data-original') || '') ||
      abs(url, firstSrc(imgEl.attr('data-srcset') || imgEl.attr('srcset') || '')) ||
      abs(url, imgEl.attr('src') || '');

    // 价格
    const price = readPrice($, $el);

    out.push({ title, url: link, link, img, imgs: img?[img]:[], price, currency:'', sku:'', moq:'', desc:'' });
  });

  // 2) JSON-LD 回退/增强
  out.push(...collectJsonLdProducts($, url));

  // 3) 去重 + 截断
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
  id: 'magento',
  test: (_$, u) => /\.html($|\?)/i.test(u) || /magento/i.test(u),
  parse
};

module.exports = api;
module.exports.default = api;
