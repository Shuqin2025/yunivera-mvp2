/**
 * Memoryking 适配器（鲁棒版 v2.2）
 * 目标：无 JS 的情况下抓到“真图”，并过滤占位图 loader.svg
 * 兼容导出：CommonJS + ESM
 * 兼容入参：($, limit, debug) 或 ({ $, url, limit, debug })
 */

function parseMemorykingCompat(input, limitArg = 50, debugArg = false) {
  // --- 入参自适配 ---
  let $, pageUrl = '', limit = limitArg, debug = debugArg;
  if (input && typeof input === 'object' && (input.$ || input.url || input.limit !== undefined)) {
    $ = input.$ || input;
    pageUrl = input.url || '';
    if (input.limit !== undefined) limit = input.limit;
    if (input.debug !== undefined) debug = input.debug;
  } else {
    $ = input; // 旧签名：($, limit, debug)
  }

  const items = [];

  // --- 工具函数 ---
  const baseFromUrl = (() => {
    try {
      if (pageUrl) {
        const u = new URL(pageUrl);
        return u.origin;
      }
    } catch (_) {}
    return 'https://www.memoryking.de';
  })();

  const abs = (u) => {
    if (!u) return '';
    if (/^https?:\/\//i.test(u)) return u;
    if (u.startsWith('//')) return 'https:' + u;
    return baseFromUrl + (u.startsWith('/') ? u : '/' + u);
  };

  const fromSrcset = (s) =>
    (s || '')
      .split(',')
      .map((x) => x.trim().split(/\s+/)[0])
      .filter(Boolean);

  const pickSquareSize = (u) => {
    const m = u && u.match(/(\d{2,4})x\1\b/);
    return m ? parseInt(m[1], 10) : 0;
  };

  const score = (u) => {
    if (!u) return -1e9;
    let s = 0;
    const sz = pickSquareSize(u);
    if (sz) s += Math.min(sz, 1200);
    if (/600x600|700x700|800x800/i.test(u)) s += 120;
    if (/@2x\b/i.test(u)) s += 150;
    if (/(\?|&)format=webp\b/i.test(u)) s += 5;
    if (/\.webp(?:$|\?)/i.test(u)) s += 5;
    else if (/\.jpe?g(?:$|\?)/i.test(u)) s += 3;
    else if (/\.png(?:$|\?)/i.test(u)) s += 2;
    if (/meinecloud\.io/i.test(u)) s += 10; // 站点常见存储
    return s;
  };

  const collectImgs = ($root) => {
    const cand = new Set();

    // 1) <picture><source srcset>
    $root.find('picture source[srcset]').each((_, el) => {
      fromSrcset($(el).attr('srcset')).forEach((u) => cand.add(u));
    });

    // 2) img 上的各种可能
    $root.find('img').each((_, el) => {
      const $img = $(el);
      // srcset 优先（含 data-srcset）
      const ss = $img.attr('data-srcset') || $img.attr('srcset') || '';
      if (ss) fromSrcset(ss).forEach((u) => cand.add(u));

      // data-* 明确优先（ccLazy 常见）
      const ds = $img.attr('data-src');
      if (ds) cand.add(ds);

      const fb = $img.attr('data-fallbacksrc'); // 你自测里出现过
      if (fb) cand.add(fb);

      const s = $img.attr('src');
      if (s) cand.add(s);
    });

    // 3) .image--element 上的 data-img-*（Shopware 常见）
    $root.find('.image--element').each((_, el) => {
      const $el = $(el);
      [
        'data-img-large',
        'data-original',
        'data-img-small',
        'data-zoom-image',
        'data-img',
        'data-src',
      ].forEach((k) => {
        const v = $el.attr(k);
        if (v) cand.add(v);
      });
    });

    // 4) 兜底：任意属性里出现图片扩展的都收
    $root.find('*').each((_, node) => {
      const attrs = node.attribs || {};
      for (const k in attrs) {
        const v = attrs[k] || '';
        if (/\.(jpe?g|png|webp)(?:$|\?)/i.test(v)) cand.add(v);
      }
    });

    // 统一：绝对化 + 过滤 loader.svg + 仅保留图片扩展
    const real = [...cand]
      .map(abs)
      .filter(
        (u) =>
          u &&
          !/loader\.svg/i.test(u) &&
          /\.(jpe?g|png|webp)(?:$|\?)/i.test(u)
      );

    if (!real.length) return '';
    real.sort((a, b) => score(b) - score(a));
    return real[0];
  };

  const readBox = ($box) => {
    const title =
      $box.find('.product--title, .product--info a, a[title]').first().text().trim() ||
      $box.find('a').first().attr('title') ||
      '';

    let href =
      $box
        .find('a')
        .map((_, a) => $(a).attr('href') || '')
        .get()
        .find((h) => h && /\/(details|detail)\//i.test(h)) ||
      $box.find('a').first().attr('href') ||
      '';
    href = abs(href);

    const img = collectImgs($box);

    const price =
      $box
        .find('.price--default, .product--price, .price--content, .price--unit, [itemprop="price"]')
        .first()
        .text()
        .replace(/\s+/g, ' ')
        .trim() || '';

    const sku =
      $box.find('.manufacturer--name, .product--supplier').first().text().trim() ||
      ($box.find('.product--info a').first().text().trim() || '').replace(/\s+/g, ' ');

    return { sku, title, url: href, img, price, currency: '', moq: '' };
  };

  // --- ① 列表解析（多容器并联） ---
  const selectors = [
    '.listing--container .product--box',
    '.product--box',
    '.js--isotope .product--box',
  ];
  let boxes = [];
  for (const sel of selectors) {
    const arr = $(sel).toArray();
    if (arr.length) {
      boxes = arr;
      break;
    }
  }

  if (boxes.length) {
    boxes.forEach((el) => {
      const row = readBox($(el));
      if (row.title || row.url || row.img) items.push(row);
    });
  }

  // --- ② 详情兜底（当列表无结果时） ---
  if (items.length === 0) {
    const $detail = $('.product--details, .product--detail, body');

    const title =
      $detail.find('.product--title').first().text().trim() ||
      $('h1').first().text().trim() ||
      '';

    const url =
      abs($('link[rel="canonical"]').attr('href') || '') ||
      abs(($('meta[property="og:url"]').attr('content') || '').trim());

    let img = $('meta[property="og:image"]').attr('content') || '';

    if (!img) {
      $('script[type="application/ld+json"]').each((_, el) => {
        try {
          const data = JSON.parse($(el).contents().text() || '{}');
          const pic = Array.isArray(data?.image) ? data.image[0] : data?.image;
          if (!img && pic && /\.(jpe?g|png|webp)(?:$|\?)/i.test(pic)) {
            img = pic;
          }
        } catch (_) {}
      });
    }

    if (!img) img = collectImgs($detail);
    img = abs(img);

    const price =
      $detail
        .find('.price--default, .product--price, .price--content, .price--unit, [itemprop="price"]')
        .first()
        .text()
        .replace(/\s+/g, ' ')
        .trim() || '';

    const sku =
      $detail.find('.manufacturer--name').first().text().trim() ||
      $detail.find('.product--supplier').first().text().trim() ||
      '';

    const row = { sku, title, url, img, price, currency: '', moq: '' };
    if (row.title || row.url || row.img) items.push(row);
  }

  // --- 出口：强力过滤占位图，限制数量 ---
  const out = items
    .map((r) => (r && r.img && /loader\.svg/i.test(r.img) ? { ...r, img: '' } : r))
    .slice(0, limit);

  if (debug) {
    console.log(
      '[memoryking] boxes=%d -> out=%d; first=%o',
      boxes.length,
      out.length,
      out[0]
    );
  }
  return out;
}

// --- 兼容导出 ---
function defaultExport(input, limit, debug) {
  return parseMemorykingCompat(input, limit, debug);
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = defaultExport; // CommonJS
}
// ESM 默认导出（若后端支持 ESM）
try { eval('export default defaultExport'); } catch (_) {}
