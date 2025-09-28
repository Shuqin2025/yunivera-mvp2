cd /workspaces/yunivera-mvp2/backend

cat > adapters/memoryking.js <<'EOF'
/**
 * Memoryking 适配器（处理懒加载图片 + 列表/详情双模式）
 */
export default function parseMemoryking($, limit = 50, debug = false) {
  const baseHref = $('base').attr('href') || 'https://www.memoryking.de';

  const abs = (u) => {
    if (!u) return '';
    if (u.startsWith('//')) return 'https:' + u;
    try { return new URL(u, baseHref).href; } catch { return u; }
  };

  const fromSrcset = (v) => {
    if (!v) return '';
    // srcset 里按逗号分割，取最后一个（分辨率最高）
    const urls = v.split(',').map(s => s.trim().split(/\s+/)[0]).filter(Boolean);
    const best = urls.filter(p => /\.(jpe?g|png|webp)(\?|$)/i.test(p)).pop();
    return best ? abs(best) : '';
  };

  const pickFromAttrs = (el, names) => {
    for (const n of names) {
      const v = $(el).attr(n);
      if (!v) continue;
      if (/loader\.svg/i.test(v)) continue;

      if (n.includes('srcset')) {
        const u = fromSrcset(v);
        if (u) return u;
      }
      if (/\.(jpe?g|png|webp)(\?|$)/i.test(v)) return abs(v);
    }
    return '';
  };

  const pickImage = (ctx) => {
    // 1) 先看 <img> 本身
    const img = $('img', ctx).get(0);
    if (img) {
      const u = pickFromAttrs(img, ['srcset','data-srcset','data-src','src','data-original']);
      if (u) return u;
    }
    // 2) 常见懒加载容器上的自定义属性
    const wrap = $(ctx).find('.image--element, .image--media, .image--box').get(0) || ctx;
    const u2 = pickFromAttrs(wrap, ['data-img-large','data-image-large','data-original','data-image','data-srcset','data-src']);
    if (u2) return u2;

    // 3) 兜底：在 HTML 片段里直接搜一张可用图片（优先 meinecloud）
    const html = ($(ctx).html() || '');
    const m = html.match(/https?:\/\/[^"' ]+meinecloud[^"' ]+?\.(?:jpe?g|png|webp)/i)
           || html.match(/https?:\/\/[^"' ]+\.(?:jpe?g|png|webp)/i);
    return m ? abs(m[0]) : '';
  };

  const items = [];

  // 列表页
  const listTiles = $('[data-compare-ajax="true"] .product--box, .listing .product--box, .product--box');
  if (listTiles.length) {
    listTiles.each((_, el) => {
      if (items.length >= limit) return false;

      const a = $(el).find('a.product--title, .product--image a, .product--title a').first();
      const url = abs(a.attr('href'));
      const title = (a.text() || $(el).find('.product--title').text() || '').trim();
      const price = ($(el).find('.product--price, .product--price .price--default, .price--content, .price').text() || '').replace(/\s+/g, ' ').trim();
      const img = pickImage(el);

      if (title || url) items.push({ sku: 'deleyCON', title, url, img, price });
    });
  }

  // 详情页（若列表没抓到，再尝试单品）
  if (!items.length && $('.product--detail').length) {
    const title = ($('h1.product--title, .product--header h1, h1').first().text() || '').trim();
    const canon = $('link[rel="canonical"]').attr('href') || '';
    const url = abs(canon);
    const img = pickImage($('.image--box, .image-slider--container, .image--media, .product--image').first());
    const price = ($('.price--default, .price--content, .price').first().text() || '').replace(/\s+/g, ' ').trim();
    if (title) items.push({ sku: 'deleyCON', title, url, img, price });
  }

  const out = { ok: true, items };
  if (debug) out.debugPart = { sample: items.slice(0, 3), total: items.length };
  return out;
}
EOF
