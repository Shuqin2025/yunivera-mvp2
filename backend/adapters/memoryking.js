/**
 * Memoryking 适配器（鲁棒版 v2）
 * 目标：不执行 JS，仅用 Cheerio 解析初始 HTML，也能拿到“真图片”
 *      覆盖：列表页 + 详情页；srcset / data-srcset / source[srcset] / data-img-*
 *      过滤：loader.svg；统一绝对地址；优先 600x600 清晰图
 *
 * 返回：Array<{sku,title,url,img,price,currency,moq}>
 */
export default function parseMemoryking($, limit = 50, debug = false) {
  const items = [];

  /** 绝对地址 */
  const abs = (u) => {
    if (!u) return '';
    if (/^https?:\/\//i.test(u)) return u;
    if (u.startsWith('//')) return 'https:' + u;
    return 'https://www.memoryking.de' + (u.startsWith('/') ? u : '/' + u);
  };

  /** srcset => [url, …] */
  const fromSrcset = (s) =>
    (s || '')
      .split(',')
      .map((x) => x.trim().split(/\s+/)[0])
      .filter(Boolean);

  /** 候选打分，优先 600x600，再考虑后缀 */
  const score = (u) =>
    (/600x600/.test(u) ? 100 : 0) +
    (/\.webp(?:$|\?)/i.test(u) ? 5 : 0) +
    (/\.jpe?g(?:$|\?)/i.test(u) ? 3 : 0) +
    (/\.png(?:$|\?)/i.test(u) ? 2 : 0);

  /** 在一个作用域下收集尽可能多的“真实图”候选 */
  const collectImgs = ($root) => {
    const cand = new Set();

    // 1) 常见：img[srcset] / data-srcset / data-src / src
    $root.find('img').each((_, el) => {
      const $img = $(el);
      const ss =
        $img.attr('srcset') ||
        $img.attr('data-srcset') ||
        $img.attr('data-sizes') ||
        '';
      if (ss) fromSrcset(ss).forEach((u) => cand.add(u));
      const s = $img.attr('data-src') || $img.attr('src');
      if (s) cand.add(s);
    });

    // 2) <picture> 体系：source[srcset]
    $root.find('picture source[srcset]').each((_, el) => {
      fromSrcset($(el).attr('srcset')).forEach((u) => cand.add(u));
    });

    // 3) Shopware 常见：.image--element 上的 data-img-*
    const $el = $root.find('.image--element').first();
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

    // 4) 兜底：凡是属性里出现 jpg/png/webp 的也记一下（防漏）
    $root.find('*').each((_, node) => {
      const attrs = node.attribs || {};
      for (const k in attrs) {
        const v = attrs[k] || '';
        if (/\.(jpe?g|png|webp)(?:$|\?)/i.test(v)) cand.add(v);
      }
    });

    // 过滤 loader.svg & 相对补全
    const real = [...cand]
      .map(abs)
      .filter(
        (u) =>
          u &&
          !/loader\.svg/i.test(u) &&
          /\.(jpe?g|png|webp)(?:$|\?)/i.test(u)
      );

    // 评分取最优；若无 600x600，也返回第一张真图
    return real.sort((a, b) => score(b) - score(a))[0] || real[0] || '';
  };

  /** 提取单个商品块 */
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
        .find('.price--default, .product--price, .price--content, .price--unit')
        .first()
        .text()
        .replace(/\s+/g, ' ')
        .trim() || '';

    // SKU/品牌（取不到可为空）
    const sku =
      $box.find('.manufacturer--name, .product--supplier').first().text().trim() ||
      ($box.find('.product--info a').first().text().trim() || '').replace(/\s+/g, ' ');

    return {
      sku,
      title,
      url: href,
      img,
      price,
      currency: '',
      moq: '',
    };
  };

  /** ① 列表页优先 */
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
      // 列表允许“无图”记录先进入（后端会兜底 enrich），但 loader.svg 已被过滤
      if (row.title || row.url || row.img) items.push(row);
    });
  }

  /** ② 若列表为空，按“详情页”兜底（至少返回 1 条） */
  if (items.length === 0) {
    const $detail = $('.product--details, body');

    // 标题：H1 / .product--title
    const title =
      $detail.find('.product--title').first().text().trim() ||
      $('h1').first().text().trim() ||
      '';

    // URL：canonical / location
    const url =
      abs($('link[rel="canonical"]').attr('href') || '') ||
      abs(($('meta[property="og:url"]').attr('content') || '').trim());

    // 图片：优先 og:image，再在页面上收集
    const og = $('meta[property="og:image"]').attr('content') || '';
    const img = og ? abs(og) : collectImgs($detail);

    // 价格
    const price =
      $detail
        .find('.price--default, .product--price, .price--content, .price--unit')
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

  // 把明显是占位图的剔除（双保险）
  const out = items.filter((r) => r && r.img ? !/loader\.svg/i.test(r.img) : true).slice(0, limit);

  if (debug) {
    console.log('[memoryking] boxes=%d -> out=%d; first=%o', boxes.length, out.length, out[0]);
  }
  return out;
}
