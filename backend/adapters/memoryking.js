// Memoryking 适配器（处理懒加载图片）
// 列表页与详情页都会尽力从 data-img 系列属性、srcset 或 data-src/src 中取到真正图片
// 只接受 jpg jpeg png webp 四种后缀的真实图片地址，过滤掉 loader.svg

export default function parseMemoryking($, limit = 50, debug = false) {
  const items = [];
  const base =
    $('base').attr('href') ||
    'https://www.memoryking.de/';

  const abs = (u) => {
    if (!u) return '';
    if (/^\/\//i.test(u)) return 'https:' + u;
    if (/^https?:/i.test(u)) return u;
    try {
      return new URL(u, base).href;
    } catch (e) {
      return u;
    }
  };

  const cleanTxt = (t) =>
    (t || '')
      .replace(/\s+/g, ' ')
      .trim();

  const textOf = (scope, sel) =>
    cleanTxt(sel ? scope.find(sel).first().text() : scope.text());

  const pickFromSrcset = (srcset) => {
    if (!srcset) return '';
    // 例子： "https://...600x600.jpg 600w, https://...200x200.jpg 200w"
    const parts = srcset
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!parts.length) return '';

    const scored = parts.map((p) => {
      // 把末尾的 600w、2x 或者文件名里的 600x600 抽成“宽度”
      const endNum = p.match(/(\d+)\s*(w|x|h|px)?\s*$/);
      let w = endNum ? parseInt(endNum[1], 10) : 0;
      if (!w) {
        const m2 = p.match(/(\d{3,4})x(\d{3,4})/);
        if (m2) w = parseInt(m2[1], 10);
      }
      const url = p.replace(/\s+\d.*$/, ''); // 去掉描述，只保留 URL
      return { w, url };
    });

    // 取“最大的那张”
    scored.sort((a, b) => b.w - a.w);
    const chosen = scored[0]?.url || parts[0].replace(/\s+\d.*$/, '');
    return chosen || '';
  };

  const extractRealImage = ($scope) => {
    // 1) memoryking 列表常见：span.image--element 挂 data-img-large / -small / -original 等
    let fromMeta = $scope.find('span.image--element').first();
    let cand =
      fromMeta.attr('data-img-large') ||
      fromMeta.attr('data-image-large') ||
      fromMeta.attr('data-large') ||
      fromMeta.attr('data-img-original') ||
      fromMeta.attr('data-original') ||
      fromMeta.attr('data-img-small') ||
      fromMeta.attr('data-small') ||
      '';

    // 2) 其次尝试 <img> 上的 srcset / data-srcset
    let imgEl = $scope.find('img').first();
    if (!cand) {
      const srcset = imgEl.attr('srcset') || imgEl.attr('data-srcset') || '';
      if (srcset) cand = pickFromSrcset(srcset);
    }

    // 3) 再退化到 data-src / src
    if (!cand) cand = imgEl.attr('data-src') || imgEl.attr('src') || '';

    // 4) 兜底在 scope 上直接搜一遍带图片后缀的 URL
    if (cand && !/\.(jpg|jpeg|png|webp)(\?|#|$)/i.test(cand)) {
      const inText =
        (fromMeta.attr('data-img-small') || '').match(
          /https?:\/\/[^\s'"]+\.(jpg|jpeg|png|webp)[^\s'"]*/i
        ) ||
        cand.match(/https?:\/\/[^\s'"]+\.(jpg|jpeg|png|webp)[^\s'"]*/i);
      if (inText) cand = inText[0];
    }

    // 5) 过滤掉 loader.svg
    if (/loader\.svg/i.test(cand)) cand = '';

    // 6) 绝对化
    if (cand) cand = abs(cand);

    // 7) 最终只接受图片后缀
    if (cand && !/\.(jpg|jpeg|png|webp)(\?|#|$)/i.test(cand)) cand = '';

    return cand;
  };

  const pushItem = (o) => {
    if (!o) return;
    o.title = cleanTxt(o.title);
    if (!o.title) return;
    if (o.url) o.url = abs(o.url);
    items.push(o);
  };

  // 一、列表页
  // 典型结构：.listing--container .product--box
  $('.listing--container .product--box, .product--box').each((i, el) => {
    if (items.length >= limit) return false;

    const $box = $(el);
    const $link =
      $box.find('a.product--image').first() ||
      $box.find('a.product--title').first() ||
      $box.find('a').first();

    const title =
      textOf($box, '.product--title a') ||
      textOf($box, '.product--title') ||
      textOf($box, '.product--info .title');

    const url =
      $link.attr('href') ||
      $box.find('.product--title a').attr('href') ||
      '';

    const price =
      textOf($box, '.price--default .price') ||
      textOf($box, '.product--price .price') ||
      textOf($box, '.price');

    const sku =
      textOf($box, '.product--supplier') ||
      textOf($box, '.manufacturer') ||
      '';

    const img = extractRealImage($box);

    if (title || img) {
      pushItem({
        sku,
        title,
        url,
        img,
        price
      });
    }
  });

  // 二、若仍未取到，按详情页兜底
  if (!items.length) {
    const title =
      textOf($, 'h1.product--title') ||
      textOf($, '.product--title h1') ||
      textOf($, '.product--header h1') ||
      textOf($, '.product--title');

    const url = $('link[rel="canonical"]').attr('href') || '';

    // 详情页图片容器常见：.image--box / .image--container / .image-slider--container
    let img =
      extractRealImage(
        $('.image--box, .image--container, .image-slider--container, .image-gallery, .image-slider')
      ) || '';

    if (!img) {
      // 遍历所有 img 的父容器快速兜底
      $('img').each((_, el) => {
        if (img) return;
        const trial = extractRealImage($(el).parent());
        if (trial) img = trial;
      });
    }

    const price =
      textOf($, '.price--default .price') ||
      textOf($, '.price--content .price') ||
      textOf($, '.product--price .price') ||
      textOf($, '.buybox--price .price');

    const sku =
      textOf($, '[itemprop=brand]') ||
      textOf($, '.product--supplier') ||
      '';

    if (title) {
      pushItem({
        sku,
        title,
        url,
        img,
        price
      });
    }
  }

  if (debug) {
    const first = items[0] || {};
    /* eslint-disable no-console */
    console.log('[memoryking] debug:', {
      sample: items.slice(0, 3),
      total: items.length,
      first
    });
    /* eslint-enable no-console */
  }

  return { ok: true, items };
}
