/**
 * Memoryking 适配器（鲁棒版 v2.1）
 * 目标：不执行 JS，仅用 Cheerio 解析初始 HTML，也能拿到“真图片”
 * 覆盖：列表页 + 详情页；srcset / data-srcset / source[srcset] / data-img-* / 任意属性
 * 过滤：loader.svg；统一绝对地址；偏好清晰图（尺寸越大越优，识别 @2x 与 600x600）
 *
 * 返回：Array<{sku,title,url,img,price,currency,moq}>
 */
export default function parseMemoryking($, limit = 50, debug = false) {
  const items = [];

  /** 绝对地址补全（相对 -> https://www.memoryking.de/...；协议相对 // -> https:） */
  const abs = (u) => {
    if (!u) return '';
    if (/^https?:\/\//i.test(u)) return u;
    if (u.startsWith('//')) return 'https:' + u;
    return 'https://www.memoryking.de' + (u.startsWith('/') ? u : '/' + u);
  };

  /** 从 srcset 提取 URL 列表（忽略密度/宽度描述，只取 URL） */
  const fromSrcset = (s) =>
    (s || '')
      .split(',')
      .map((x) => x.trim().split(/\s+/)[0])
      .filter(Boolean);

  /** 尺寸提取：匹配 200x200 / 800x800 等，返回数值（大者优） */
  const pickSquareSize = (u) => {
    const m = u && u.match(/(\d{2,4})x\1\b/);
    return m ? parseInt(m[1], 10) : 0;
  };

  /** 候选打分：优先 600~800 档、@2x，其次看扩展名 */
  const score = (u) => {
    if (!u) return -1e9;
    let s = 0;
    const sz = pickSquareSize(u);
    if (sz) s += Math.min(sz, 1200);          // 尺寸越大越好，上限保护
    if (/600x600|700x700|800x800/i.test(u)) s += 120;
    if (/@2x\b/i.test(u)) s += 150;
    if (/(\?|&)format=webp\b/i.test(u)) s += 5;
    if (/\.webp(?:$|\?)/i.test(u)) s += 5;
    else if (/\.jpe?g(?:$|\?)/i.test(u)) s += 3;
    else if (/\.png(?:$|\?)/i.test(u)) s += 2;
    // 优先常见 CDN
    if (/meinecloud\.io/i.test(u)) s += 10;
    return s;
  };

  /** 在一个作用域下收集尽可能多的“真实图”候选（自动去重、过滤占位） */
  const collectImgs = ($root) => {
    const cand = new Set();

    // 1) <picture> 体系：source[srcset]
    $root.find('picture source[srcset]').each((_, el) => {
      fromSrcset($(el).attr('srcset')).forEach((u) => cand.add(u));
    });

    // 2) 常见 img 变种：srcset / data-srcset / data-src / src / data-fallbacksrc（ccLazy）
    $root.find('img').each((_, el) => {
      const $img = $(el);
      const ss =
        $img.attr('data-srcset') ||
        $img.attr('srcset') ||
        '';
      if (ss) fromSrcset(ss).forEach((u) => cand.add(u));

      // 明确优先 data-*（ccLazy 占位图下 src 往往是 loader.svg）
      const ds = $img.attr('data-src');
      if (ds) cand.add(ds);

      const fb = $img.attr('data-fallbacksrc'); // 自测里命中：...200x200.jpg / ...200x200@2x.jpg
      if (fb) cand.add(fb);

      const s = $img.attr('src');
      if (s) cand.add(s);
    });

    // 3) Shopware 常见：.image--element 上的 data-img-*
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

    // 4) 兜底：任意属性里出现 jpg/png/webp 的也收（防漏）
    $root.find('*').each((_, node) => {
      const attrs = node.attribs || {};
      for (const k in attrs) {
        const v = attrs[k] || '';
        if (/\.(jpe?g|png|webp)(?:$|\?)/i.test(v)) cand.add(v);
      }
    });

    // 过滤 loader.svg & 仅保留图片扩展，统一绝对地址
    const real = [...cand]
      .map(abs)
      .filter(
        (u) =>
          u &&
          !/loader\.svg/i.test(u) &&
          /\.(jpe?g|png|webp)(?:$|\?)/i.test(u)
      );

    if (!real.length) return '';

    // 用打分挑最优
    real.sort((a, b) => score(b) - score(a));
    return real[0];
  };

  /** 提取单个商品块（列表） */
  const readBox = ($box) => {
    const title =
      $box.find('.product--title, .product--info a, a[title]').first().text().trim() ||
      $box.find('a').first().attr('title') ||
      '';

    // 链接：优先指向详情
    let href =
      $box
        .find('a')
        .map((_, a) => $(a).attr('href') || '')
        .get()
        .find((h) => h && /\/(details|detail)\//i.test(h)) || $box.find('a').first().attr('href') || '';
    href = abs(href);

    // 图片：在 box 作用域内收集
    const img = collectImgs($box);

    // 价格
    const price =
      $box
        .find('.price--default, .product--price, .price--content, .price--unit, [itemprop="price"]')
        .first()
        .text()
        .replace(/\s+/g, ' ')
        .trim() || '';

    // SKU/品牌（取不到可为空）
    const sku =
      $box.find('.manufacturer--name, .product--supplier').first().text().trim() ||
      ($box.find('.product--info a').first().text().trim() || '').replace(/\s+/g, ' ');

    return { sku, title, url: href, img, price, currency: '', moq: '' };
  };

  /** ① 列表页优先（多容器并联） */
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
      // 列表允许“无图”记录先进入（后端可能后续 enrich），但 loader.svg 已被过滤
      if (row.title || row.url || row.img) items.push(row);
    });
  }

  /** ② 若列表为空，按“详情页”兜底（至少返回 1 条） */
  if (items.length === 0) {
    const $detail = $('.product--details, .product--detail, body');

    // 标题：H1 / .product--title
    const title =
      $detail.find('.product--title').first().text().trim() ||
      $('h1').first().text().trim() ||
      '';

    // URL：canonical / og:url
    const url =
      abs($('link[rel="canonical"]').attr('href') || '') ||
      abs(($('meta[property="og:url"]').attr('content') || '').trim());

    // 图片：优先 og:image；再 ld+json；最后在页面上收集
    let img = $('meta[property="og:image"]').attr('content') || '';

    if (!img) {
      // ld+json 里 image 字段（字符串或数组）
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

    // 价格
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

  // 双保险：剔除任何 loader.svg；截断到 limit
  const out = items
    .filter((r) => (r && r.img ? !/loader\.svg/i.test(r.img) : true))
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
