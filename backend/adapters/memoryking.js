// 适配 Memoryking（列表页/详情页）图片懒加载
// ESM: export default
export default function parseMemoryking($, limit = 50, debug = false) {
  const base =
    $('base').attr('href') ||
    'https://www.memoryking.de/';

  const toAbs = (u) => {
    if (!u) return '';
    try { return new URL(u, base).href; } catch { return u; }
  };

  const pickFromSrcset = (srcset) => {
    if (!srcset) return '';
    // 选择宽度最大的那个 url
    let best = '';
    let bestW = -1;
    srcset.split(',').forEach(part => {
      const m = part.trim().match(/(\S+)\s+(\d+)w/); // url 600w
      if (m) {
        const url = m[1];
        const w = parseInt(m[2], 10);
        if (w > bestW) { bestW = w; best = url; }
      } else {
        // 只有 url 没有宽度时，作为候选
        if (!best) best = part.trim().split(/\s+/)[0];
      }
    });
    return best;
  };

  const isRealImg = (u) => /\.(jpe?g|png|webp)(\?|$)/i.test(u || '');

  // 核心：从商品卡片（或详情页主图容器）里拿真实图片
  const pickImage = ($box) => {
    let src = '';
    let $img = $box.find('img').first();

    // 1) 直接从 <img> 上拿
    if ($img.length) {
      src = $img.attr('data-src') || $img.attr('src') || '';
      const srcset = $img.attr('data-srcset') || $img.attr('srcset') || '';
      const fromSet = pickFromSrcset(srcset);
      if (fromSet) src = fromSet || src;
    }

    // 2) 如果还是 loader.svg，尝试从 noscript 里提取
    if (!isRealImg(src)) {
      const html = ($box.find('noscript').first().html() || '').replace(/\n+/g, ' ');
      const mSet = html.match(/srcset="([^"]+)"/i);
      const mSrc = html.match(/src="([^"]+)"/i);
      if (mSet) src = pickFromSrcset(mSet[1]);
      if (!isRealImg(src) && mSrc) src = mSrc[1];
    }

    // 3) 再尝试从图片容器的 data-* 属性拿
    if (!isRealImg(src)) {
      const $el = $box.find('.image--element, .image--media').first();
      if ($el.length) {
        const candAttrs = [
          'data-srcset', 'data-src',
          'data-image', 'data-image-large', 'data-image-small', 'data-image-original'
        ];
        for (const a of candAttrs) {
          const v = $el.attr(a);
          if (!v) continue;
          let c = v;
          if (/,|\s\d+w/.test(v)) c = pickFromSrcset(v);
          if (isRealImg(c)) { src = c; break; }
        }
      }
    }

    return toAbs(src);
  };

  // —— 解析列表页 ——（每个商品卡片 .product--box）
  const items = [];
  $('.product--box').each((_, el) => {
    if (items.length >= limit) return;
    const $box = $(el);
    const $a = $box.find('a.product--title, a.product--image, a').first();
    const url = toAbs($a.attr('href') || '');
    const title = ($a.text() || '').trim();

    const img = pickImage($box);
    const price = ($box.find('.price--default, .price--content').first().text() || '').trim();
    const sku = ($box.find('.product--supplier').first().text() || 'deleyCON').trim();

    if (url && title) {
      items.push({ sku, title, url, img, price, currency: '', moq: '' });
    }
  });

  // —— 解析详情页（主图容器 .image--media / .image--box）兜底 —— 
  if (items.length === 0) {
    const title = ($('h1.product--title').text() || $('title').text() || '').trim();
    const url = toAbs(location?.href || $('link[rel="canonical"]').attr('href') || '');
    const img = pickImage($('.image--box, .image--media, .image--container').first());
    const price = ($('.price--default, .price--content').first().text() || '').trim();
    const sku = ($('span[itemprop="brand"]').text() || 'deleyCON').trim();
    if (title) items.push({ sku, title, url, img, price, currency: '', moq: '' });
  }

  if (debug) {
    const sample = items.slice(0, 3);
    console.log('[mk] sample:', sample);
  }

  return { ok: true, items };
}
