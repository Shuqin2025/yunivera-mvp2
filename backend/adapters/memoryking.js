/**
 * Memoryking 适配器（鲁棒版 v2.9 / ESM）
 * 修正：
 *  - 详情页（/details/ 或有 .product--detail[s] 或 ld+json: Product）强制返回“主商品 1 条”
 *  - 列表仅匹配真正的 listing 容器；排除 related/cross-selling/accessories/slider 等推荐区
 * 其它：保留 rawHtml 源码直扫兜底、data-* 优先、loader.svg 过滤、清晰度打分
 */

import * as cheerio from 'cheerio';

export default function parseMemoryking(input, limitDefault = 50, debugDefault = false) {
  // ---- 入参自适配 ----
  let $, pageUrl = '', rawHtml = '', limit = limitDefault, debug = debugDefault;
  if (input && typeof input === 'object' && (input.$ || input.rawHtml || input.url || input.limit !== undefined || input.debug !== undefined)) {
    $ = input.$ || input;                 // 兼容：直接传 $
    rawHtml = input.rawHtml || '';
    pageUrl = input.url || '';
    if (input.limit !== undefined) limit = input.limit;
    if (input.debug !== undefined) debug = input.debug;
  } else {
    $ = input; // 旧式
  }

  const items = [];

  // ---------- 工具 ----------
  const origin = (() => {
    try { return pageUrl ? new URL(pageUrl).origin : 'https://www.memoryking.de'; }
    catch { return 'https://www.memoryking.de'; }
  })();

  const abs = (u) => {
    if (!u) return '';
    if (/^https?:\/\//i.test(u)) return u;
    if (u.startsWith('//')) return 'https:' + u;
    return origin + (u.startsWith('/') ? u : '/' + u);
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
    if (/meinecloud\.io|cloudfront|cdn/i.test(u)) s += 10;
    return s;
  };

  const scrapeUrlsFromHtml = (html) => {
    if (!html) return [];
    const out = new Set();
    const re = /https?:\/\/[^"'()\s<>]+?\.(?:jpe?g|png|webp)(?:\?[^"'()\s<>]*)?/ig;
    let m; while ((m = re.exec(html))) out.add(m[0]);
    return [...out];
  };

  const bestFromImgNode = ($img) => {
    if (!$img || !$img.length) return '';
    const cand = new Set();

    const dss = $img.attr('data-srcset'); if (dss) fromSrcset(dss).forEach((u) => cand.add(u));
    const fb  = $img.attr('data-fallbacksrc'); if (fb) cand.add(fb);
    const ds  = $img.attr('data-src'); if (ds) cand.add(ds);
    const ss  = $img.attr('srcset'); if (ss) fromSrcset(ss).forEach((u) => cand.add(u));
    const s   = $img.attr('src'); if (s && !/loader\.svg/i.test(s)) cand.add(s);

    const real = [...cand].map(abs).filter((u) => /\.(jpe?g|png|webp)(?:$|\?)/i.test(u) && !/loader\.svg/i.test(u));
    if (!real.length) return '';
    real.sort((a, b) => score(b) - score(a));
    return real[0];
  };

  const collectImgs = ($root) => {
    const cand = new Set();

    // 1) picture/source
    $root.find('picture source[srcset]').each((_, el) => {
      fromSrcset($(el).attr('srcset')).forEach((u) => cand.add(u));
    });

    // 2) img + bestFromImgNode
    $root.find('img').each((_, el) => {
      const $img = $(el);
      const best = bestFromImgNode($img);
      if (best) cand.add(best);

      const extras = [
        $img.attr('data-src'),
        $img.attr('data-fallbacksrc'),
        $img.attr('src'),
      ].filter(Boolean);
      const ss1 = $img.attr('data-srcset') || $img.attr('srcset') || '';
      if (ss1) fromSrcset(ss1).forEach((u) => extras.push(u));
      extras.forEach((u) => cand.add(u));
    });

    // 3) .image--element data-img-*
    $root.find('.image--element').each((_, el) => {
      const $el = $(el);
      ['data-img-large','data-original','data-img-small','data-zoom-image','data-img','data-src']
        .forEach((k) => { const v = $el.attr(k); if (v) cand.add(v); });
    });

    // 4) 任意属性里含图片扩展
    $root.find('*').each((_, node) => {
      const attrs = node.attribs || {};
      for (const k in attrs) {
        const v = attrs[k] || '';
        if (/\.(jpe?g|png|webp)(?:$|\?)/i.test(v)) cand.add(v);
      }
    });

    // 5) 作用域 HTML 直扫
    const html = $root.html() || '';
    scrapeUrlsFromHtml(html).forEach((u) => cand.add(u));

    const real = [...cand]
      .map(abs)
      .filter((u) => u && /\.(jpe?g|png|webp)(?:$|\?)/i.test(u) && !/loader\.svg/i.test(u));

    if (!real.length) return '';
    real.sort((a, b) => score(b) - score(a));
    return real[0];
  };

  const readBox = ($box) => {
    const title =
      $box.find('.product--title, .product--info a, a[title]').first().text().trim() ||
      $box.find('a').first().attr('title') || '';

    // 详情链接
    let href =
      $box.find('a').map((_, a) => $(a).attr('href') || '').get()
        .find((h) => h && /\/(details|detail)\//i.test(h)) ||
      $box.find('a').first().attr('href') || '';
    href = abs(href);

    // 图片：先从首个 img 的 data-* 强取 → 再 DOM 收集 → 再 box 源码直扫
    const firstImg = $box.find('img').first();
    let img = bestFromImgNode(firstImg);
    if (!img) img = collectImgs($box);
    if (!img) {
      const boxHtml = $box.html() || '';
      const best = scrapeUrlsFromHtml(boxHtml)
        .map(abs)
        .filter((u) => /\.(jpe?g|png|webp)(?:$|\?)/i.test(u) && !/loader\.svg/i.test(u))
        .sort((a, b) => score(b) - score(a))[0];
      img = best || '';
    }

    const price =
      $box.find('.price--default, .product--price, .price--content, .price--unit, [itemprop="price"]')
        .first().text().replace(/\s+/g, ' ').trim() || '';

    const sku =
      $box.find('.manufacturer--name, .product--supplier').first().text().trim() ||
      ($box.find('.product--info a').first().text().trim() || '').replace(/\s+/g, ' ');

    if (img && /loader\.svg/i.test(img)) img = ''; // 阻断占位回填
    return { sku, title, url: href, img, price, currency: '', moq: '' };
  };

  // ====== 关键：判定是否“详情页” ======
  let isDetail =
    /\/details\//i.test(pageUrl || '') ||
    $('.product--detail, .product--details').length > 0 ||
    (String($('meta[property="og:type"]').attr('content') || '').toLowerCase() === 'product');

  // 再从 ld+json 里探测 Product
  if (!isDetail) {
    $('script[type="application/ld+json"]').each((_i, el) => {
      try {
        const raw = $(el).contents().text() || '';
        if (!raw) return;
        const data = JSON.parse(raw);
        const check = (obj) => {
          if (!obj) return false;
          const t = obj['@type'];
          if (t === 'Product') return true;
          if (Array.isArray(t) && t.includes('Product')) return true;
          if (obj['@graph']) return Array.isArray(obj['@graph']) && obj['@graph'].some(check);
          return false;
        };
        if (Array.isArray(data)) {
          if (data.some(check)) isDetail = true;
        } else if (check(data)) {
          isDetail = true;
        }
      } catch {}
    });
  }

  // ---------- ① 列表（仅“非详情页”时；并排除推荐区容器） ----------
  if (!isDetail) {
    const listSelectors = [
      '.listing--container .product--box',
      '.js--isotope .product--box',
      '#listing .product--box',
      '.product--listing .product--box',
    ];

    // 详情页推荐区/滑动区等黑名单容器
    const BLACKLIST = [
      '.product--detail',
      '.product--details',
      '#detail',
      '.cross-selling', '.crossselling',
      '.related', '.related--products', '.similar--products',
      '.upselling',
      '.accessories', '.accessory--slider',
      '.product-slider--container', '.product--slider', '.is--ctl-detail'
    ].join(', ');

    let boxes = [];
    for (const sel of listSelectors) {
      const arr = $(sel).toArray().filter((el) => $(el).closest(BLACKLIST).length === 0);
      if (arr.length) { boxes = arr; break; }
    }

    if (boxes.length) {
      boxes.forEach((el) => {
        const row = readBox($(el));
        if (row.title || row.url || row.img) items.push(row);
      });
    }
  }

  // ---------- ② 详情兜底（列表无结果 或 明确为详情页） ----------
  if (items.length === 0 || isDetail) {
    const $detail = $('.product--details, .product--detail, #content, body');

    const title =
      $detail.find('.product--title').first().text().trim() ||
      $('h1').first().text().trim() || '';

    const url =
      abs($('link[rel="canonical"]').attr('href') || '') ||
      abs(($('meta[property="og:url"]').attr('content') || '').trim()) ||
      (pageUrl || '');

    // 图片：og:image → 主区域收集 → 全页(rawHtml 优先)直扫
    let img = $('meta[property="og:image"]').attr('content') || '';
    if (!img) img = bestFromImgNode($detail.find('img').first());
    if (!img) img = collectImgs($detail);
    if (!img) {
      const pageHtml = rawHtml || ($.root().html() || '');
      img = (scrapeUrlsFromHtml(pageHtml)
        .map(abs)
        .filter((u) => /\.(jpe?g|png|webp)(?:$|\?)/i.test(u) && !/loader\.svg/i.test(u))
        .sort((a, b) => score(b) - score(a))[0]) || '';
    }
    img = abs(img);

    const price =
      $detail.find('.price--default, .product--price, .price--content, .price--unit, [itemprop="price"]').first()
        .text().replace(/\s+/g, ' ').trim() || '';

    const sku =
      $detail.find('.manufacturer--name').first().text().trim() ||
      $detail.find('.product--supplier').first().text().trim() || '';

    const row = { sku, title, url, img, price, currency: '', moq: '' };
    if (row.img && /loader\.svg/i.test(row.img)) row.img = '';
    if (row.title || row.url || row.img) {
      // 详情页：只返回 1 条
      return [row];
    }
  }

  // ---------- 出口 ----------
  const out = items
    .map((r) => (r && r.img && /loader\.svg/i.test(r.img) ? { ...r, img: '' } : r))
    .slice(0, limit);

  if (debug) {
    console.log('[memoryking] isDetail=%s out=%d; first=%o', isDetail, out.length, out[0]);
  }
  return out;
}
