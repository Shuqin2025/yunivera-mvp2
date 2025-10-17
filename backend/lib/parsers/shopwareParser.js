// WooCommerce catalog parser (DOM → JSON-LD → deepAnchorFallback)
function pickText($, el){ return ($(el).text()||'').replace(/\s+/g,' ').trim(); }
function abs(base, href=''){ try{ return new URL(href, base).toString(); }catch{ return href||''; } }
function firstSrc(srcset=''){ const x=(srcset||'').split(',')[0]||''; return x.split(/\s+/)[0]||''; }
function cleanTitle(t=''){
  const s=String(t).replace(/\s+/g,' ').trim();
  if(!s) return '';
  const bad=['item','{{ title }}','Zu den Bewertungen für {{ title }}'];
  if(bad.includes(s)) return '';
  if(/^Zu den Bewertungen/i.test(s)) return '';
  return s;
}
const BAD_LINK_PATTERNS=[
  '/cart','/checkout','/account','/my-account','/wishlist',
  '/kontakt','/contact','/hilfe','/support','/agb','/impressum',
  '/privacy','/datenschutz','/versand','/shipping','/returns'
];
function isBadLink(u=''){ return BAD_LINK_PATTERNS.some(x=>u.includes(x)); }
function looksLikeProduct(u=''){
  if(u.includes('/product/')) return true;
  if(u.includes('add-to-cart')) return false;
  return false;
}
function readPrice($, node){
  const txt=pickText($, $(node).find('.price, .amount, [itemprop="price"], .wc-block-grid__product-price'));
  const m=txt.match(/(\d+[.,]\d{2})/);
  return m?m[1].replace(',', '.'):'';
}

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
        let price='', currency='';
        const offers=Array.isArray(p.offers)?p.offers[0]:p.offers;
        if(offers){ price=String(offers.price||''); currency=String(offers.priceCurrency||''); }
        if(!title || !link || isBadLink(link) || !looksLikeProduct(link)) continue;
        out.push({ title, url:link, link, img, imgs:img?[img]:[], price, currency, sku:p.sku||p.mpn||'', moq:'', desc:p.description||'' });
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
    const $card=$(a).closest('li.product, .product, .wc-block-grid__product, [class*="product-card"]');
    const imgEl=$card.find('img').first();
    const img=  abs(url, imgEl.attr('data-src')||'')
            ||  abs(url, firstSrc(imgEl.attr('data-srcset')||imgEl.attr('srcset')||''))
            ||  abs(url, imgEl.attr('src')||'');
    const price=readPrice($, $card);
    out.push({ title, url:href, link:href, img, imgs:img?[img]:[], price, currency:'', sku:'', moq:'', desc:'' });
  });
  if(!out.length) logger?.warn?.(`NoProductFound in ${new URL(url).host} (woocommerce deepAnchorFallback)`);
  const uniq=[]; const seen=new Set();
  for(const it of out){ const key=it.link||it.url; if(!key || seen.has(key)) continue; seen.add(key); uniq.push(it); if(uniq.length>=limit) break; }
  return uniq;
}

function parse($, url, { limit=50, logger } = {}){
  const out=[];
  // 1) DOM
  const cards=$([
    'ul.products li.product','.products .product','.wc-block-grid__product','[class*="product-card"]'
  ].join(','));
  cards.each((_i, el)=>{
    const $el=$(el);
    const a=$el.find('a.woocommerce-LoopProduct-link[href], a.woocommerce-LoopProduct__link[href], a[href*="/product/"], a[href]').first();
    const link=abs(url, a.attr('href')||'');
    if(!link || isBadLink(link) || !looksLikeProduct(link)) return;

    const title=cleanTitle(
      pickText($, $el.find('.woocommerce-loop-product__title, .product-title, .wc-block-grid__product-title, h2, h3, [itemprop="name"]').first()) ||
      (a.attr('title')||'').trim() || pickText($, a)
    );
    if(!title) return;

    const imgEl=$el.find('img').first();
    const img= abs(url, imgEl.attr('data-src')||'')
           ||  abs(url, firstSrc(imgEl.attr('data-srcset')||imgEl.attr('srcset')||''))
           ||  abs(url, imgEl.attr('src')||'');
    const price=readPrice($, $el);
    out.push({ title, url:link, link, img, imgs:img?[img]:[], price, currency:'', sku:'', moq:'', desc:'' });
  });

  // 2) JSON-LD
  out.push(...collectJsonLdProducts($, url));

  // 3) 去重
  const uniq=[]; const seen=new Set();
  for(const it of out){ const key=it.link||it.url; if(!key || seen.has(key)) continue; seen.add(key); uniq.push(it); if(uniq.length>=limit) break; }
  if(uniq.length>=1) return uniq;

  // 4) 先试通用兜底
  try {
    const generic = require('./genericLinksParser');
    if (generic && typeof generic.parse === 'function') {
      const more = generic.parse($, url, { limit, logger, hint: 'woocommerce' }) || [];
      if (Array.isArray(more) && more.length) return more.slice(0, limit);
    }
  } catch {}

  // 5) deepAnchorFallback
  {
    const r = deepAnchorFallback($, url, limit, logger) || [];
    if (Array.isArray(r) && r.length) return r.slice(0, limit);
  }

  // 6) Shopware deepAnchorFallback (addon, last resort)
  try {
    const fallbacks = shopwareDeepAnchorFallback($, url) || [];
    if (fallbacks.length) {
      let title = cleanTitle($('title').text().trim()) || 'item';
      const mapped = fallbacks.map(u => ({ title, url: u, link: u, img: '', imgs: [], price: '', currency: '', sku: '', moq: '', desc: '' }));
      logger?.info?.('[Shopware] deepAnchorFallback used', { count: mapped.length });
      return mapped.slice(0, limit);
    }
  } catch {}
  return [];
}

const api={ id:'woocommerce', test:(_$, u)=>/woocommerce|\/product-category\//i.test(u), parse };
// ======= ADDON: deep anchor fallback for Shopware =======
function shopwareDeepAnchorFallback($, base) {
  const deny = /konto|account|login|warenkorb|cart|agb|datenschutz|impressum|versand|zahlung|kontakt|sitemap|newsletter|hilfe|support|widerruf/i;
  const allow = /detail|produkt|artikel|product|/i;

  const urls = new Set();
  $('a[href]').each((_, a) => {
    const href = String($(a).attr('href') || '').trim();
    if (!href || href.startsWith('#') || deny.test(href)) return;
    // 只留站内链接
    if (/^https?:\/\//i.test(href) && !href.includes(base)) return;

    // 常见 Shopware 商品链接形态
    if (allow.test(href) || /\/detail\/\d+/i.test(href) || /\/Artikel\//i.test(href)) {
      const u = new URL(href, base).toString();
      urls.add(u);
    }
  });
  return [...urls];
}
// ======= /ADDON =======
module.exports=api; module.exports.default=api;
