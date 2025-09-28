/** Memoryking 适配器（支持列表页+详情页，处理懒加载图片） */
export default function parseMemoryking($, limit = 50, debug = false) {
  const items = [];
  const base =
    $('base').attr('href') ||
    'https://www.memoryking.de/';

  const toAbs = (u) => {
    if (!u) return '';
    try { return new URL(u, base).href; } catch { return u; }
  };

  const fromSrcset = (v) => {
    if (!v) return '';
    // 选最后一个（通常分辨率最高），再取第一个空格前的 URL
    const parts = v.split(',').map(s => s.trim());
    if (!parts.length) return '';
    const last = parts[parts.length - 1];
    const url = last.split(/\s+/)[0];
    return url || '';
  };

  const pickFromImg = ($img) => {
    const attr = (a) => ($img.attr(a) || '').trim();
    let cand =
      attr('data-src') ||
      fromSrcset(attr('data-srcset')) ||
      fromSrcset(attr('srcset')) ||
      attr('src');

    // 如果还是 loader.svg，则尝试父元素 data-img-*
    if (!cand || /loader\.svg/i.test(cand)) {
      const $el = $img.closest('.image--element');
      if ($el && $el.length) {
        cand =
          ($el.attr('data-img-large') || '').trim() ||
          ($el.attr('data-image-original') || '').trim() ||
          ($el.attr('data-img-small') || '').trim();
      }
    }

    if (cand && /loader\.svg/i.test(cand)) cand = '';
    if (cand) cand = toAbs(cand);
    return cand;
  };

  const pickText = ($node) => ($node.text() || '').replace(/\s+/g, ' ').trim();

  /** ============ 列表页 ============ */
  $('.product--box').each((_, el) => {
    const $box   = $(el);
    const $title = $box.find('.product--title a, a.product--title').first();
    const url    = toAbs($title.attr('href') || '');
    const title  = pickText($title) || pickText($box.find('.product--title'));

    const price  = pickText($box.find('.price--default, .price--content').first());
    const sku    = pickText($box.find('.product--supplier, .manufacturer--name').first()) || 'deleyCON';

    let img = '';
    const $img = $box.find('.image--media img, .product--image img').first();
    if ($img.length) img = pickFromImg($img);

    if (!img) {
      // 极端兜底：background-image
      const bg = ($box.find('.product--image').css('background-image') || '').trim();
      const m = bg.match(/url\(["']?([^"')]+)["']?\)/i);
      if (m) img = toAbs(m[1]);
    }

    if (url) items.push({ sku, title, url, img, price });
    if (items.length >= limit) return false;
  });

  /** ============ 详情页兜底 ============ */
  if (!items.length) {
    const title = pickText($('h1.product--title, h1[itemprop="name"]').first()) || pickText($('h1').first());
    let img = '';
    const $img = $('span.image--media img, .image-slider--item img, .image--media img').first();
    if ($img.length) img = pickFromImg($img);

    const price = pickText($('.price--default, .product--price .price--content').first());
    const url   = toAbs(($('link[rel="canonical"]').attr('href') || ''));

    if (title) items.push({ sku: 'deleyCON', title, url, img, price });
  }

  // 清洗：把仍为空或仍是 loader.svg 的图片置空（前端会显示占位但不再转圈）
  items.forEach(it => {
    if (!it.img || /loader\.svg/i.test(it.img)) it.img = '';
  });

  const result = { ok: true, items };
  if (debug) result.debugPart = items.slice(0, 3);
  return result;
}
