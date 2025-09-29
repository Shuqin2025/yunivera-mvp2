/**
 * Memoryking 适配器（鲁棒版：支持懒加载图片，覆盖列表页 & 详情页）
 * 只依赖 Cheerio 注入的 $，不做额外网络请求；若站点将真实图地址放在
 * img[srcset] / img[data-srcset] / img[data-src] / .image--element 的 data-xxx
 * 等地方，都会被兜住；并优先选 600x600 大图，过滤 loader.svg 占位图。
 *
 * 返回值：items: Array<{sku,title,url,img,price,currency,moq}>
 */
export default function parseMemoryking($, limit = 50, debug = false) {
  const items = [];
  const prefer600 = (arr) => {
    if (!arr || !arr.length) return '';
    const byScore = (u) =>
      (/600x600/.test(u) ? 100 : 0) +
      (/\.webp$/i.test(u) ? 5 : 0) +
      (/\.jpe?g$/i.test(u) ? 3 : 0) +
      (/\.png$/i.test(u) ? 2 : 0);
    return arr.slice().sort((a, b) => byScore(b) - byScore(a))[0];
  };
  const abs = (u) => {
    if (!u) return '';
    if (/^https?:\/\//i.test(u)) return u;
    if (u.startsWith('//')) return 'https:' + u;
    return 'https://www.memoryking.de' + (u.startsWith('/') ? u : '/' + u);
  };
  const fromSrcset = (s) =>
    (s || '')
      .split(',')
      .map((x) => x.trim().split(/\s+/)[0])
      .filter(Boolean);

  // 在某个块内，尽可能把能找到的“真实图片 URL 候选”都捞出来
  const pickImageFrom = ($root) => {
    const cand = new Set();

    // 1) 列表 & 详情里最常见：<img srcset="..., ..."> / data-srcset / data-src / src
    $root.find('img').each((_, el) => {
      const $img = $(el);
      const srcset =
        $img.attr('srcset') || $img.attr('data-srcset') || $img.attr('data-sizes');
      if (srcset) fromSrcset(srcset).forEach((u) => cand.add(u));
      const src = $img.attr('data-src') || $img.attr('src');
      if (src) cand.add(src);
    });

    // 2) SW/Shopware 系常见：<span class="image--element" data-img-large/small/original>
    const $el = $root.find('.image--element').first();
    ['data-img-large', 'data-original', 'data-img-small', 'data-zoom-image', 'data-img'].forEach(
      (k) => {
        const v = $el.attr(k);
        if (v) cand.add(v);
      }
    );

    // 3) 兜底：凡是节点 attribute 里出现 jpg/jpeg/png/webp 的也捞一下（保守匹配）
    $root.find('*').each((_, node) => {
      const attrs = node.attribs || {};
      for (const k in attrs) {
        const v = attrs[k] || '';
        if (/\.(jpe?g|png|webp)(\?|$)/i.test(v)) cand.add(v);
      }
    });

    // 过滤无效 & loader.svg，占位图一律丢弃
    const filtered = [...cand]
      .map(abs)
      .filter((u) => u && !/loader\.svg/i.test(u) && /\.(jpe?g|png|webp)(\?|$)/i.test(u));

    return prefer600(filtered) || filtered[0] || '';
  };

  // 读取一个商品块里的字段
  const readBox = ($box) => {
    const title =
      $box.find('.product--title, .product--info a, a[title]').first().text().trim() ||
      $box.find('a').first().attr('title') ||
      '';
    const href =
      $box
        .find('a')
        .map((_, a) => $(a).attr('href') || '')
        .get()
        .find((h) => h && /\/details\/|\/detail\//i.test(h)) || $box.find('a').first().attr('href') || '';
    const url = abs(href);
    const img = pickImageFrom($box);

    // 价格尽量提取，有就要，没有也不影响流程
    const price =
      $box
        .find('.price--default, .product--price, .price--content, .price--unit')
        .first()
        .text()
        .replace(/\s+/g, ' ')
        .trim() || '';
    const currency = '';
    const moq = '';

    // SKU/品牌：站点大多写在厂商名上，取不到就留空
    const sku =
      $box.find('.manufacturer--name, .product--supplier').first().text().trim() ||
      ($box.find('.product--info a').first().text().trim() || '').replace(/\s+/g, ' ');

    return { sku, title, url, img, price, currency, moq };
  };

  // ① 优先按“列表页”读取
  const $boxes =
    $('.listing--container .product--box, .product--box') // 列表容器
      .filter((_, el) => !!$(el).find('a').length);

  $boxes.each((_, el) => {
    const row = readBox($(el));
    if (row.title || row.url || row.img) items.push(row);
  });

  // ② 若列表没读到（或只有 1 条），按“详情页”兜底（只塞 1 条）
  if (items.length === 0) {
    const $detail = $('.product--details, body');
    const row = {
      sku:
        $detail.find('.manufacturer--name').first().text().trim() ||
        $detail.find('.product--supplier').first().text().trim() ||
        '',
      title:
        $detail.find('.product--title').first().text().trim() ||
        $('h1').first().text().trim() ||
        '',
      url: abs($('link[rel="canonical"]').attr('href') || window?.location?.href || ''),
      img: pickImageFrom($detail),
      price:
        $detail
          .find('.price--default, .product--price, .price--content, .price--unit')
          .first()
          .text()
          .replace(/\s+/g, ' ')
          .trim() || '',
      currency: '',
      moq: '',
    };
    if (row.title || row.url || row.img) items.push(row);
  }

  const out = items
    // 把没有取到的 loader.svg/空图片剔除（极端情况）
    .filter((r) => r.img && !/loader\.svg/i.test(r.img))
    .slice(0, limit);

  if (debug) {
    // 方便在 /debug=1 时回看
    // eslint-disable-next-line no-console
    console.log(
      'Memoryking picked',
      out.length,
      'of',
      items.length,
      'items; first.img:',
      out[0]?.img
    );
  }
  return out;
}
