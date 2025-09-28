/** Memoryking 适配器（分类页 + 详情页，处理懒加载图片） */
export default function parseMemoryking($, limit = 50, debug = false) {
  const items = [];
  const base =
    $('base').attr('href') ||
    'https://www.memoryking.de/';

  const abs = (u) => {
    if (!u) return '';
    if (/^https?:\/\//i.test(u)) return u;
    if (u.startsWith('//')) return 'https:' + u;
    try { return new URL(u, base).href; } catch { return u; }
  };

  // 选出 img 的真实地址（优先 data-srcset -> srcset -> data-src -> src）
  const pickImg = ($img) => {
    if (!$img || !$img.length) return '';
    let s = $img.attr('data-srcset') || $img.attr('srcset') || '';
    if (s) {
      // srcset: "url 200w, url 400w, ..." —— 取最后一个（最大）
      const url = s
        .split(',')
        .map(x => x.trim().split(/\s+/)[0])
        .filter(Boolean)
        .pop();
      return abs(url);
    }
    // 兜底
    const u = $img.attr('data-src') || $img.attr('src') || '';
    return abs(u);
  };

  const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();

  // ========== A. 分类/列表页 ==========
  // Shopware 列表容器常见：.listing--container 下 .product--box
  const $listBoxes = $('.listing--container .product--box, .product--box');
  if ($listBoxes.length) {
    $listBoxes.slice(0, limit).each((_, box) => {
      const $box = $(box);
      // 标题
      const title =
        norm($box.find('.product--title, .title--link').first().text()) ||
        norm($box.find('a.product--title').first().text());
      // 链接
      let url =
        $box.find('a.product--image, a.product--title, a.title--link').attr('href') || '';
      url = abs(url);
      // 价格（Shopware 5: .price--default/.price--content）
      const price =
        norm(
          $box.find('.price--default, .price--content, .price').first().text()
        );

      // 图片（懒加载：data-srcset/srcset/data-src）
      const img = pickImg($box.find('span.image--media img, img').first());

      if (title || url || img) {
        items.push({ title, url, price, img });
      }
    });
  }

  // ========== B. 商品详情页 ==========
  // 详情页图片滑块：.image-slider--container / .image--media img
  if (items.length === 0) {
    const $detailImgs = $(
      '.image-slider--container img, .image--box .image--media img, .image-slider--slide img'
    );
    if ($detailImgs.length) {
      // 取第一张大图
      const img = pickImg($detailImgs.first());
      const title =
        norm($('.product--title, h1.product--title').first().text()) ||
        norm($('meta[property="og:title"]').attr('content'));
      const price =
        norm($('.price--content, .price--default, .price').first().text());
      let url =
        $('link[rel="canonical"]').attr('href') ||
        $('meta[property="og:url"]').attr('content') ||
        '';
      url = abs(url || (typeof window !== 'undefined' ? window.location?.href : ''));

      if (title || url || img) {
        items.push({ title, url, price, img });
      }
    }
  }

  // ========== C. JSON-LD 兜底（详情页很多站会放） ==========
  if (items.length === 0) {
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const data = JSON.parse($(el).text());
        const prod = Array.isArray(data) ? data[0] : data;
        if (prod && (prod.image || prod.name)) {
          const img = abs(Array.isArray(prod.image) ? prod.image[0] : prod.image);
          const title = norm(prod.name);
          const price =
            prod.offers && (prod.offers.price || prod.offers.priceSpecification?.price);
          let url = abs(prod.url || '');
          if (title || url || img) items.push({ title, url, price: price ? String(price) : '', img });
        }
      } catch { /* ignore */ }
    });
  }

  // 过滤掉 loader.svg
  const filtered = items.filter(
    it => it.img && !/loader\.svg(?:\?|$)/i.test(it.img)
  );

  if (debug) {
    const sample = filtered.slice(0, 3);
    console.log('debugPart:', { count: filtered.length, sample });
  }
  return { ok: true, items: filtered };
}
