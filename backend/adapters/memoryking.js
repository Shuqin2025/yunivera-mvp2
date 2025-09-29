/**
 * Memoryking 适配器（稳健取图：列表直接取 + 失败回落到详情页）
 * - 列表：优先从 data-img-*/srcset 抓真图
 * - 仍为 loader.svg 时，最多对前 N 条回落抓详情页的 og:image / image--media
 * - 详情页：直接取 og:image / image--media 的 600x600
 */
export default async function parseMemoryking($, limit = 50, debug = false) {
  const base = $('base').attr('href') || 'https://www.memoryking.de/';
  const abs = (u) => {
    if (!u) return '';
    try { return new URL(u, base).href; } catch { return u; }
  };

  const items = [];
  const pickFromSrcset = (ss) => {
    if (!ss) return '';
    const urls = ss.split(',').map(s => s.trim().split(' ')[0]);
    const p600 = urls.find(u => /600x600/.test(u));
    return p600 || urls.pop() || '';
  };
  const isPlaceholder = (u) => !u || /\.svg(\?|$)/i.test(u);

  const grabImgFromTile = (tile) => {
    const img = tile.find('img').first();
    let src =
      img.attr('data-src') ||
      img.attr('src') ||
      tile.find('.image--element').attr('data-img-medium') ||
      tile.find('.image--element').attr('data-img-large') ||
      tile.find('.image--element').attr('data-img-small') ||
      '';

    if ((!src || isPlaceholder(src))) {
      // 再尝试 srcset
      src =
        img.attr('data-srcset') ||
        img.attr('srcset') ||
        src;
      src = pickFromSrcset(src);
    }
    return abs(src);
  };

  const grabDetailImage = ($$) => {
    let src =
      $$('meta[property="og:image"]').attr('content') ||
      $$('.image--media img').attr('src') ||
      '';

    if (!src) {
      src = pickFromSrcset($$('.image--media img').attr('srcset') || '');
    }
    if (!src) {
      // 少数主题把真图放在 data-img-*
      const el = $$('.image--element');
      src =
        el.attr('data-img-medium') ||
        el.attr('data-img-large') ||
        el.attr('data-img-small') ||
        '';
    }
    return abs(src);
  };

  // 1) 列表页尝试直接抓
  $('.product--box').each((i, el) => {
    if (items.length >= limit) return false;
    const card = $(el);

    const title =
      card.find('.product--title a').text().trim() ||
      card.find('.product--title').text().trim();

    const url =
      card.find('.product--title a, .product--image a').attr('href') ||
      card.find('a').first().attr('href') || '';

    const price =
      card.find('.price--default, .product--price .price--content').first().text().trim();

    const img = grabImgFromTile(card);

    items.push({
      sku: 'deleyCON',
      title,
      url: abs(url),
      img,
      price,
      currency: '',
      moq: ''
    });
  });

  // 若不是列表（如详情页）
  if (items.length === 0) {
    const oneTitle = $('#content h1, .product--title').first().text().trim();
    if (oneTitle) {
      const url =
        $('link[rel=canonical]').attr('href') ||
        $('meta[property="og:url"]').attr('content') || '';
      const img = grabDetailImage($);
      const price =
        $('.price--default, .product--price .price--content').first().text().trim();
      return {
        ok: true,
        items: [{
          sku: 'deleyCON',
          title: oneTitle,
          url: abs(url),
          img,
          price,
          currency: '',
          moq: ''
        }],
        debugPart: { mode: 'detail-only' }
      };
    }
    return { ok: false, items: [], debugPart: { note: 'no items' } };
  }

  // 2) 对仍为 loader.svg 的商品，回落抓详情页取真图（最多 30 条，足够页面首屏/导出）
  let enriched = 0;
  const enrichCap = Math.min(items.length, 30);
  for (let i = 0; i < enrichCap; i++) {
    const it = items[i];
    if (!isPlaceholder(it.img)) continue;
    try {
      const $$ = await $.fetch(it.url);
      const real = grabDetailImage($$);
      if (real && !isPlaceholder(real)) {
        it.img = real;
        enriched++;
      }
    } catch (e) {
      // 忽略个别失败，继续
    }
  }

  return {
    ok: true,
    items,
    debugPart: { enriched, total: items.length }
  };
}
