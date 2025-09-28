/** Memoryking 列表页适配器（处理懒加载图片） */
module.exports = function parseMemoryking($, limit = 50, debug = false) {
  const items = [];
  const seen = new Set();
  const base = 'https://www.memoryking.de/';

  const abs = (u) => {
    try {
      if (!u) return '';
      if (/^\/\//.test(u)) u = 'https:' + u;               // //host/path → https://host/path
      return new URL(u, base).href;
    } catch { return u || ''; }
  };

  const pickFromSrcset = (v) => {
    if (!v) return '';
    // "url 1x, url2 2x" → 取第一个 url
    return String(v).split(',')[0].trim().split(/\s+/)[0] || '';
  };

  const realImg = ($box) => {
    let src = '';
    const $img = $box.find('img').first();

    // 1) 先看 img 上的 src
    src = $img.attr('src') || '';

    // 如果是 loader.svg 或为空，改从 data-xxx / srcset 里挑
    if (!src || /ccLazyLoader|loader\.svg/i.test(src)) {
      src =
        $img.attr('data-src') ||
        pickFromSrcset($img.attr('data-srcset')) ||
        pickFromSrcset($img.attr('srcset')) ||
        '';
    }

    // 2) 还没有的话，从上层 image--element 的 data-image-* 兜底
    if (!src) {
      const $host = $box.closest('.image--element');
      src =
        ($host && ($host.attr('data-image-small') ||
                   $host.attr('data-image-large') ||
                   $host.attr('data-image-original'))) || '';
    }
    return abs(src);
  };

  // 列表卡片
  $('.product--box').each((_i, el) => {
    if (items.length >= limit) return false;
    const $b = $(el);

    const $a = $b.find('a.product--image, a.product--title').first();
    const href = abs($a.attr('href') || '');
    const title = ($b.find('.product--title').text() || '').replace(/\s+/g, ' ').trim();
    if (!href || !title || seen.has(href)) return;

    const img = realImg($b);

    items.push({ title, href, url: href, img });
    seen.add(href);
  });

  if (debug) return { items, sample: items.slice(0, 3), total: items.length };
  return items;
};
