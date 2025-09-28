/**
 * Memoryking 适配器（处理懒加载图片 + 列表/详情双模式）
 * 目标：把 <img src="...loader.svg"> 从 srcset/data-* 中解析出真实 jpg/webp（优先 600x600）
 */
export default function parseMemoryking($, limit = 50, debug = false) {
  // ─────────────── helpers ───────────────
  const BASE = $('base').attr('href') || 'https://www.memoryking.de/';

  const abs = (u) => {
    if (!u) return '';
    if (u.startsWith('//')) return 'https:' + u;
    try { return new URL(u, BASE).href; } catch { return u; }
  };

  const text = ($el) => (($el && $el.text()) || '').replace(/\s+/g, ' ').trim();

  const pickFromSrcset = (srcset) => {
    if (!srcset) return '';
    const parts = srcset
      .split(',')
      .map(s => (s || '').trim().split(/\s+/)[0])
      .filter(Boolean);

    // 优先 600x600，其次取最后一个（通常分辨率最大），全部过滤 loader.svg
    const filtered = parts.filter(p => !/loader\.svg/i.test(p));
    const prefer600 = filtered.find(p => /600x600\.(jpg|jpeg|png|webp)(\?|$)/i.test(p));
    return prefer600 || filtered[filtered.length - 1] || '';
  };

  // 从 cheerio 的 <source> 集合里挑 srcset
  const pickFromPictureSources = ($pic) => {
    if (!$pic || !$pic.length) return '';
    const urls = [];
    $pic.find('source[srcset]').each((_i, s) => {
      const v = $(s).attr('srcset');
      const u = pickFromSrcset(v);
      if (u) urls.push(u);
    });
    // 还是同样优先 600x600
    const prefer600 = urls.find(u => /600x600\.(jpg|jpeg|png|webp)(\?|$)/i.test(u));
    return prefer600 || urls[urls.length - 1] || '';
  };

  /**
   * 在一个 <img> 元素上解析真实图片：
   * 1) srcset / data-srcset
   * 2) src / data-src / data-original / data-src-large
   * 3) <picture><source srcset>
   * 4) 上层懒加载容器的 data-img-*（极端兜底）
   */
  const pickImgUrl = ($img) => {
    if (!$img || !$img.length) return '';

    const a = (name) => ($img.attr(name) || '').trim();

    // 1) 来自 srcset 的候选
    let cand = pickFromSrcset(a('srcset')) || pickFromSrcset(a('data-srcset'));

    // 2) 直接属性兜底
    if (!cand) {
      const direct = a('src') || a('data-src') || a('data-original') || a('data-src-large') || '';
      if (direct && !/loader\.svg/i.test(direct)) cand = direct;
    }

    // 3) picture > source
    if (!cand) {
      // cheerio 的 closest 可用，但更稳妥用 parents
      const $pic = $img.parents('picture').first();
      const u = pickFromPictureSources($pic);
      if (u) cand = u;
    }

    // 4) 懒加载容器自定义属性（若图片标签没给）
    if (!cand) {
      const $wrap = $img.parents('.image--element, .image--media, .image--box').first();
      const attrs = ['data-img-large', 'data-image-large', 'data-original', 'data-image', 'data-srcset', 'data-src'];
      for (const k of attrs) {
        const v = ($wrap.attr(k) || '').trim();
        if (v && !/loader\.svg/i.test(v)) {
          if (/srcset/i.test(k)) {
            const u2 = pickFromSrcset(v);
            if (u2) { cand = u2; break; }
          } else if (/\.(jpe?g|png|webp)(\?|$)/i.test(v)) {
            cand = v; break;
          }
        }
      }
    }

    if (!cand || /loader\.svg/i.test(cand)) return '';
    return abs(cand);
  };

  // ─────────────── parse list ───────────────
  const items = [];
  const seen = new Set();

  const listBoxes = $('.listing .product--box, .product--box');
  if (listBoxes.length) {
    listBoxes.each((_i, el) => {
      if (items.length >= limit) return false;

      const $box = $(el);
      // 链接/标题
      const $a = $box.find('a[href*="/details/"], a.product--image, .product--title a').first();
      const url = abs($a.attr('href') || '');
      const title = text($box.find('.product--title').first()) || text($a);

      // 价格（尽量不做数值化，以免丢单位/小数）
      const price = text($box.find('.price--content, .price--default, .product--price').first());

      // 图片：从盒子里找第一张 img
      const $img = $box.find('img').first();
      let img = pickImgUrl($img);

      // 极端兜底：尝试读取盒子内的 <picture>
      if (!img) {
        const $pic = $box.find('picture').first();
        img = pickFromPictureSources($pic);
        if (img) img = abs(img);
      }

      // 去重 & 入列
      const key = url || (title + '|' + img);
      if (!key || seen.has(key)) return;
      seen.add(key);
      items.push({ sku: 'deleyCON', title, url, img, price });
    });
  }

  // ─────────────── parse detail (fallback) ───────────────
  if (!items.length && $('.product--detail, .detail--container').length) {
    const title = text($('h1.product--title, .product--header h1, h1').first());
    const canon = abs($('link[rel="canonical"]').attr('href') || '');
    // 主图：优先 detail 区的图片
    const $img = $('.image--box .image--media img, .image-slider--container img, .image--media img').first();
    let img = pickImgUrl($img);
    if (!img) {
      const $pic = $img.parents('picture').first();
      img = pickFromPictureSources($pic);
      if (img) img = abs(img);
    }
    const price = text($('.price--default, .price--content, .price').first());
    if (title) items.push({ sku: 'deleyCON', title, url: canon, img, price });
  }

  // 清洗：保底把 loader.svg 清空（避免前端无限转圈）
  items.forEach(it => {
    if (!it.img || /loader\.svg/i.test(it.img)) it.img = '';
  });

  const out = { ok: true, items };
  if (debug) out.debugPart = { total: items.length, first: items[0] || {} };
  return out;
}
