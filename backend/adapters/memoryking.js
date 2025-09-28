/**
 * Memoryking 列表页适配器（处理懒加载图片）
 * - 从 data-srcset / srcset / data-src / data-image-* / noscript 中提取真实图
 * - 过滤 loader.svg
 */
export default function parseMemoryking($, limit = 60, debug = false) {
  const items = [];
  const seen  = new Set();

  const base = ($('base').attr('href') || 'https://www.memoryking.de/').replace(/\/+$/, '/');
  const ABS = (u) => {
    try { return new URL(u || '', base).href; } catch { return u || ''; }
  };

  function pickFromSrcSet(s) {
    if (!s) return '';
    const parts = s.split(',').map(x => x.trim());
    // 取“分辨率最大”的一条（通常在末尾）
    for (let i = parts.length - 1; i >= 0; i--) {
      const m = parts[i].match(/(https?:\/\/[^\s,]+?\.(?:jpg|jpeg|png|webp)(?:\?[^\s,]*)?)/i);
      if (m) return m[1];
    }
    return '';
  }
  function pickFromString(s) {
    if (!s) return '';
    const m = s.match(/(https?:\/\/[^\s,]+?\.(?:jpg|jpeg|png|webp)(?:\?[^\s,]*)?)/i);
    return m ? m[1] : '';
  }

  // 一般卡片：.product--box
  $('.product--box').each((_i, box) => {
    if (items.length >= limit) return false;

    const $box = $(box);
    const $a   = $box.find('a.product--image, a.box--link, a.product--title a, a').first();
    const url  = ABS($a.attr('href') || '');

    const title = (
      $box.find('.product--title, .product--title a, .product--header a').first().text() ||
      $a.attr('title') || ''
    ).replace(/\s+/g, ' ').trim();

    // 取图：srcset / data-srcset / data-src / src / noscript
    let img = '';
    const $img = $box.find('img').first();
    const srcset  = $img.attr('data-srcset') || $img.attr('srcset') || '';
    const datasrc = $img.attr('data-src') || $img.attr('data-image') || $img.attr('src') || '';
    img = pickFromSrcSet(srcset) || pickFromString(datasrc);

    if (!img) {
      const nos = $box.find('noscript').first().html() || '';
      const m = nos.match(/<img[^>]+src=["']([^"']+\.(?:jpg|jpeg|png|webp)[^"']*)/i);
      if (m) img = m[1];
    }

    if (img && /loader\.svg/i.test(img)) img = '';
    if (img) img = ABS(img);

    // 价格（尽量留空格修剪）
    const price = ($box.find('.price--default, .product--price .price, .product--price').first().text() || '')
      .replace(/\s+/g, ' ').trim();

    if (!url || !title || seen.has(url)) return;
    items.push({ sku: $box.find('.product--supplier, .product--sku').first().text().trim() || '—', title, url, img, price, currency: '' });
    seen.add(url);
  });

  if (debug) return { ok: true, items, debugPart: { sample: items.slice(0, 3), total: items.length } };
  return { items };
}
