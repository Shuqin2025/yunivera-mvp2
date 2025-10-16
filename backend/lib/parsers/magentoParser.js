// Magento catalog parser (DOM → JSON-LD → deepAnchorFallback)
function pickText($, el){ return ($(el).text()||'').replace(/\s+/g,' ').trim(); }
function abs(base, href=''){ try{ return new URL(href, base).toString(); }catch{ return href||''; } }
function firstSrc(srcset=''){ const x=(srcset||'').split(',')[0]||''; return x.split(/\s+/)[0]||''; }
function cleanTitle(t=''){
  const s=String(t).replace(/\s+/g,' ').trim();
  if(!s) return '';
  if (s === 'item' || s === '{{ title }}' || /^Zu den Bewertungen/i.test(s)) return '';
  return s;
}
const BAD_LINK_PATTERNS=[
  '/cart','/checkout','/customer','/account','/wishlist',
  '/kontakt','/contact','/hilfe','/support','/agb','/impressum',
  '/privacy','/datenschutz','/shipping','/versand','/returns',
  '/search','/catalogsearch'
];
function isBadLink(u=''){ return BAD_LINK_PATTERNS.some(x=>u.includes(x)); }
function looksLikeProduct(u=''){
  // Magento 常见详情：/something.html 或自定义 /product/
  return (u.endsWith('.html') && !u.includes('/category/')) || u.includes('/product/');
}
function readPriceFromText(txt=''){
  const m=String(txt).replace(/\s+/g,' ').match(/(\d+[.,]\d{2})/);
  return m?m[1].replace(',', '.'):''; }

function collectJsonLdProducts($, base){
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
        const title=cleanTitle(p.name||p.title||'');
        const link =abs(base, p.url||p['@id']||'');
        const img  =abs(base, (Array.isArray(p.image)?p.image[0]:p.image)||'');
        const offers=Array.isArray(p.offers)?p.offers[0]:p.offers;
        const price=offers && (offers.price||'') || '';
        const currency=offers && (offers.priceCurrency||'') || '';
        if(!title || !link || isBadLink(link) || !looksLikeProduct(link)) continue;
        out.push({ title, url:link, link, img, imgs:img?[img]:[], price:String(price||''), currency:String(currency||''), sku:p.sku||p.mpn||'', moq:'', desc:p.description||'' });
      }
    }
  });
  return out;
}

function deepAnchorFallback($, url, limit, logger){
  const out=[];
  $('a[href]').each((_i,a)=>{
    const href=abs(url, $(a).attr('href')||'');
    if(!href || isBadLink(href) || !looksLikeProduct(href)) return;
    const title=cleanTitle( (($(a).attr('title')||'').trim()) || pickText($, a) );
    if(!title) return;
    const $card=$(a).closest('li.product, .product-item, .product, [class*="product"]');
    const imgEl=$card.find('img').first();
    const img=  abs(url, imgEl.attr('data-src')||'')
            ||  abs(url, firstSrc(imgEl.attr('data-srcset')||imgEl.attr('srcset')||''))
            ||  abs(url, imgEl.attr('src')||'');
    const price=readPriceFromText(pickText($, $card.find('.price, .price-box [data-price-amount], [itemprop="price"]')));
    out.push({ title, url:href, link:href, img, imgs:img?[img]:[], price, currency:'', sku:'', moq:'', desc:'' });
  });
  if(!out.length) logger?.warn?.(`NoProductFound in ${new URL(url).host} (magento deepAnchorFallback)`);
  const uniq=[]; const seen=new Set();
  for(const it of out){ const key=it.link||it.url; if(!key || seen.has(key)) continue; seen.add(key); uniq.push(it); if(uniq.length>=limit) break; }
  return uniq;
}

function parse($, url, { limit=50, logger } = {}){
  const out=[];
  // 1) DOM
  const cards=$([
    'li.product','.product-item','.item.product','.products .product'
  ].join(','));
  cards.each((_i, el)=>{
    const $el=$(el);
    const a=$el.find('a.product-item-link[href], a[href$=".html"], a[href*="/product/"]').first();
    const link=abs(url, a.attr('href')||'');
    if(!link || isBadLink(link) || !looksLikeProduct(link)) return;

    const title=cleanTitle(
      pickText($, $el.find('.product-item-name, .product.name a, .product-title, h2, h3, [itemprop="name"]').first()) ||
      (a.attr('title')||'').trim() || pickText($, a)
    );
    if(!title) return;

    const imgEl=$el.find('img').first();
    const img=  abs(url, imgEl.attr('data-src')||'')
            ||  abs(url, firstSrc(imgEl.attr('data-srcset')||imgEl.attr('srcset')||''))
            ||  abs(url, imgEl.attr('src')||'');
    const price=readPriceFromText(pickText($, $el.find('.price, .price-box [data-price-amount], [itemprop="price"]')));
    out.push({ title, url:link, link, img, imgs:img?[img]:[], price, currency:'', sku:'', moq:'', desc:'' });
  });

  // 2) JSON-LD
  out.push(...collectJsonLdProducts($, url));

  // 3) 去重
  const uniq=[]; const seen=new Set();
  for(const it of out){ const key=it.link||it.url; if(!key || seen.has(key)) continue; seen.add(key); uniq.push(it); if(uniq.length>=limit) break; }
  if(uniq.length>=1) return uniq;

  // 4) deepAnchorFallback
  return deepAnchorFallback($, url, limit, logger);
}

const api={ id:'magento', test:(_$, u)=>/magento|\.html($|\?)|\/product\//i.test(u), parse };
module.exports=api; module.exports.default=api;
