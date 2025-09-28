/* Memoryking 适配器 · 列表/详情抓图修复（懒加载 + 两种详情URL） */
export default async function parseMemoryking($, limit = 50, debug = false) {
  const isDetail  = $('body').is('.is--ctl-detail');       // 详情页
  const isListing = $('body').is('.is--ctl-listing') || $('.listing--container').length > 0; // 列表页

  const pickImgFrom = ($root) => {
    // 1) 直接看 <span class="image--media"><img ...>
    let $img = $root.find('span.image--media img, .image--media img').first();
    let src = ($img.attr('src') || '').trim();
    let srcset = ($img.attr('srcset') || $img.attr('data-srcset') || '').trim();

    // 2) 如果 src 还是 loader.svg，就从 srcset 里取第一个 URL
    if (!/\.(jpe?g|png|webp)(\?|$)/i.test(src) && srcset) {
      const c = srcset.split(',')[0].trim();          // "URL 600w"
      src = c.split(/\s+/)[0];                        // 取 URL
    }

    // 3) 还有可能在 <noscript> 里（Shopware 常见兜底）
    if (!/\.(jpe?g|png|webp)(\?|$)/i.test(src)) {
      const nos = $root.find('noscript').html() || '';
      const m = nos.match(/https?:\/\/[^\s"']+\.(?:jpe?g|png|webp)/i);
      if (m) src = m[0];
    }

    return (src || '').trim();
  };

  const items = [];

  if (isListing) {
    // 列表：每个 .product--box 是一条
    $('.product--box').each((i, el) => {
      if (items.length >= limit) return;
      const $box  = $(el);
      const $link = $box.find('a.product--image, a.product--title, a').first();
      const url   = ($link.attr('href') || '').trim();

      const sku   = ($box.find('.product--manufacturer').text() || 'deleyCON').trim() || 'deleyCON';
      const title = ($box.find('.product--title').text() || '').trim();
      const price = ($box.find('.product--price .price--default').text() || '').trim();

      // 关键：从当前卡片里抠真图（src / srcset / noscript 三选一）
      const img   = pickImgFrom($box);

      if (url) items.push({ sku, title, url, img, price, currency:'', moq:'' });
    });
  }

  if (isDetail) {
    // 详情：从图集/大图区抠 600x600
    const title = ($('.product--title').text() || $('h1').text() || '').trim();
    const price = ($('.price--default').text() || '').trim();
    const sku   = ($('.product--supplier').text() || 'deleyCON').trim() || 'deleyCON';

    // 详情页的大图区域通常在 .image-slider--container
    const img = pickImgFrom($('.image-slider--container, .image--box, .product--image-container'));

    items.push({ sku, title, url: (typeof window !== 'undefined' ? window.location.href : ''), img, price, currency:'', moq:'' });
  }

  // 安全兜底：如果两者都没识别，尝试按老逻辑（防止页面样式偶变）
  if (!isDetail && !isListing && $('.image-slider--container, .listing--container, .product--box').length) {
    // 简化兜底：当作列表处理
    $('.product--box').each((i, el) => {
      if (items.length >= limit) return;
      const $box = $(el);
      const $link = $box.find('a').first();
      const url = ($link.attr('href') || '').trim();
      const title = ($box.text() || '').trim().slice(0, 120);
      const img = pickImgFrom($box);
      if (url) items.push({ sku:'deleyCON', title, url, img, price:'', currency:'', moq:'' });
    });
  }

  return { ok: items.length > 0, items: items.slice(0, limit) };
}
