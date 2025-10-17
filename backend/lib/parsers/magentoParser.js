// Magento catalog parser (DOM → JSON-LD → deepAnchorFallback)
function pickText($, el){ return ($(el).text()||'').replace(/\s+/g,' ').trim(); }
function abs(base, href=''){ try{ return new URL(href, base).toString(); }catch{ return href||''; } }
function firstSrc(srcset=''){ const x=(srcset||'').split(',')[0]||''; return x.split(/\s+/)[0]||''; }

function cleanTitle(t=''){
  const s=String(t).replace(/\s+/g,' ').trim();
  if(!s) return '';
  if (s === 'item' || s === '{{ title }}') return '';
  if (/^Zu den Bewertungen/i.test(s)) return '';
  return s;
}

const BAD_LINK_PATTERNS=[
  '/cart','/checkout','/customer','/account','/wishlist',
  '/contact','/impressum','/privacy','/datenschutz','/returns','/support','/hilfe'
];
function isBadLink(u=''){ return BAD_LINK_PATTERNS.some(x=>u.includes(x)); }

// 常见 Magento 商品链接：/catalog/product/ 或 站点直出 /<slug>.html
function looksLikeProduct(u=''){
  if (/\/catalog\/product\//i.test(u)) return true;
  if (/\.html(\?|$)/i.test(u)) return true;
  return false;
}

function readPrice($, node){
  // price-box 内有 data-price-amount 或 .price
  const box=$(node).find('.price-box, [data-role="priceBox"], [data-price-amount]').first();
  const data=box.attr('data-price-amount');
  if(data) return String(data);
  const txt=pickText($, box.length ? box : node);
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

    const $card=$(a).closest(
      '.product-item, li.product, .product, .product-item-info, [data-role="product-item"], [class*="product-card"]'
    );
    const imgEl=$card.find('img').first();
    const img=  abs(url, imgEl.attr('data-src')||'')
            ||  abs(url, firstSrc(imgEl.attr('data-srcset')||imgEl.attr('srcset')||''))
            ||  abs(url, imgEl.attr('src')||'');
    const price=readPrice($, $card);
    out.push({ title, url:href, link:href, img, imgs:img?[img]:[], price, currency:'', sku:'', moq:'', desc:'' });
  });

  if(!out.length) logger?.warn?.(`NoProductFound in ${new URL(url).host} (magento deepAnchorFallback)`);
  const uniq=[]; const seen=new Set();
  for(const it of out){ const key=it.link||it.url; if(!key || seen.has(key)) continue; seen.add(key); uniq.push(it); if(uniq.length>=limit) break; }
  return uniq;
}

function parse($, url, { limit=50, logger } = {}){
  const out=[];

  // 1) DOM（Magento 网格/列表）
  const cards=$([
    'li.product','.products-grid .product-item','.product-item','.product-item-info','[data-role="product-item"]'
  ].join(','));
  cards.each((_i, el)=>{
    const $el=$(el);
    const a=$el.find('a.product-item-link[href], a[href*="/catalog/product/"], a[href$=".html"], a[href]').first();
    const link=abs(url, a.attr('href')||'');
    if(!link || isBadLink(link) || !looksLikeProduct(link)) return;

    const title=cleanTitle(
      pickText($, $el.find('.product-item-link, .product.name a, .product-item-name, h2, h3, [itemprop="name"]').first()) ||
      (a.attr('title')||'').trim() || pickText($, a)
    );
    if(!title) return;

    const imgEl=$el.find('img').first();
    const img=  abs(url, imgEl.attr('data-src')||'')
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

  // 4) 先试通用兜底（Cheerio 路线）
  try {
    const generic = require('./genericLinksParser');
    if (generic && typeof generic.parse === 'function') {
      const more = generic.parse($, url, { limit, logger, hint: 'magento' }) || [];
      if (Array.isArray(more) && more.length) return more.slice(0, limit);
    }
  } catch {}

  // 5) deepAnchorFallback
  {
    const r = deepAnchorFallback($, url, limit, logger) || [];
    if (Array.isArray(r) && r.length) return r.slice(0, limit);
  }

  // 6) Magento deepAnchorFallback (addon, last resort)
  try {
    const fallbacks = magentoDeepAnchorFallback($, url) || [];
    if (fallbacks.length) {
      const title = cleanTitle($('title').text().trim()) || 'item';
      const mapped = fallbacks.map(u => ({ title, url:u, link:u, img:'', imgs:[], price:'', currency:'', sku:'', moq:'', desc:'' }));
      logger?.info?.('[Magento] deepAnchorFallback (addon) used', { count: mapped.length });
      return mapped.slice(0, limit);
    }
  } catch {}
  return [];
}



// ======= ADDON: deep anchor fallback for Magento (last resort) =======
function magentoDeepAnchorFallback($, base){
  const deny = /konto|account|login|customer|wishlist|cart|checkout|agb|datenschutz|privacy|impressum|versand|shipping|zahlung|payment|kontakt|contact|sitemap|newsletter|hilfe|support|widerruf|return|suche|search/i;
  // 允许词（放宽，适配换皮）：
  const allow = /product|produkt|artikel|.html/i;

  const urls = new Set();
  $('a[href]').each((_i, a) => {
    const hrefRaw = String($(a).attr('href') || '').trim();
    if (!hrefRaw || hrefRaw.startsWith('#') || deny.test(hrefRaw)) return;
    try{
      const abs = new URL(hrefRaw, base).toString();
      // 只留站内
      const hostBase = new URL(base).host;
      if (/^https?:\/\//i.test(abs) && new URL(abs).host !== hostBase) return;

      // 典型 Magento 商品链接：/catalog/product/ 或以 .html 结尾；或命中允许词
      if (/\/catalog\/product\//i.test(abs) || /\.html(\?|$)/i.test(abs) || allow.test(abs)) {
        urls.add(abs);
        return;
      }
      // 降级判定：带商品卡片容器痕迹也收集
      const $card = $(a).closest('.product-item, .product-item-info, li.product, .product, [data-role="product-item"], [class*="product-card"]');
      if ($card.length) urls.add(abs);
    }catch{}
  });
  return [...urls];
}
// ======= /ADDON =======


// ======= ADDON: deep anchor fallback for Magento =======
function magentoDeepAnchorFallback($, base) {
  const deny = /account|customer|wishlist|cart|checkout|impressum|datenschutz|privacy|agb|hilfe|support|kontakt/i;

  const urls = new Set();
  $('a[href]').each((_, a) => {
    const href = String($(a).attr('href') || '').trim();
    if (!href || href.startsWith('#') || deny.test(href)) return;
    if (/^https?:\/\//i.test(href) && !href.includes(base)) return;

    // Magento 常见：a.product-item-link、/catalog/product/view/、/product/
    if ($(a).is('.product-item-link') || /\/catalog\/product\/view/i.test(href) || /\/product\//i.test(href)) {
      urls.add(new URL(href, base).toString());
    }
  });
  return [...urls];
}
// ======= /ADDON =======
const api={ id:'magento', test:(_$, u)=>/magento|\/catalog\/category\/|\.html(\?|$)/i.test(u), parse };
module.exports=api; module.exports.default=api;
