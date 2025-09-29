/**
 * Memoryking 适配器（鲁棒版 v2.7 / ESM）
 * 关键：支持从原始 HTML（rawHtml）做“源码直扫兜底”，即使中途清洗也能拿到真图
 * 调用签名：
 *   parseMemoryking({ $, url, rawHtml, limit, debug })
 *   或兼容旧式：parseMemoryking($, limit, debug)
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

  // 从一段 HTML 源码中直扫全部图片 URL（极限兜底）
  const scrapeUrlsFromHtml = (html) => {
    if (!html) return [];
    const out = new Set();
    const re = /https?:\/\/[^"'()\s<>]+?\.(?:jpe?g|png|webp)(?:\?[^"'()\s<>]*)?/ig;
    let m; while ((m = re.exec(html))) out.add(m[0]);
    return [...out];
  };

  // 解析 <noscript> 片段为 $ 根
  const loadNoscript = (html) => {
    try { return cheerio.load(html || ''); } catch { return null; }
  };

  // 从“单个 <img>”抽取最佳 URL（优先 data-*）
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

  // 作用域收集（含 noscript + 源码直扫）
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

    // 5) noscript 里的 <img>
    $root.find('noscript').each((_, el) => {
      const html = $(el).html() || '';
      const $n = loadNoscript(html);
      if ($n) {
        $n('img').each((__, img) => {
          const $i = $n(img);
          const best = bestFromImgNode($i); if (best) cand.add(best);
          const list = [
            $i.attr('data-src'), $i.attr('data-fallbacksrc'), $i.attr('src')
          ].filter(Boolean);
          const ss = $i.attr('data-srcset') || $i.attr('srcset') || '';
          if (ss) fromSrcset(ss).forEach((u) => list.push(u));
          list.forEach((u) => cand.add(u));
        });
        // noscript 源码直扫（以防写在 style/script 里）
        scrapeUrlsFromHtml(html).forEach((u) => cand.add(u));
      }
    });

    // 6) 该作用域 HTML 直扫
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

    // 图片：先就地取第一个 <img> 的 data-* → 再 DOM 收集 → 再 box 源码直扫
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

  // ---------- ① 列表 ----------
  const selectors = [
    '.listing--container .product--box',
    '.product--box',
    '.js--isotope .product--box',
  ];
  let boxes = [];
  for (const sel of selectors) {
    const arr = $(sel).toArray();
    if (arr.length) { boxes = arr; break; }
  }
  if (boxes.length) {
    boxes.forEach((el) => {
      const row = readBox($(el));
      if (row.title || row.url || row.img) items.push(row);
    });
  }

  // ---------- ② 详情兜底 ----------
  if (items.length === 0) {
    const $detail = $('.product--details, .product--detail, body');

    const title =
      $detail.find('.product--title').first().text().trim() ||
      $('h1').first().text().trim() || '';

    const url =
      abs($('link[rel="canonical"]').attr('href') || '') ||
      abs(($('meta[property="og:url"]').attr('content') || '').trim());

    let img = $('meta[property="og:image"]').attr('content') || '';

    if (!img) {
      $('script[type="application/ld+json"]').each((_, el) => {
        try {
          const data = JSON.parse($(el).contents().text() || '{}');
          const pic = Array.isArray(data?.image) ? data.image[0] : data?.image;
          if (!img && pic && /\.(jpe?g|png|webp)(?:$|\?)/i.test(pic)) img = pic;
        } catch {}
      });
    }

    if (!img) img = bestFromImgNode($detail.find('img').first());
    if (!img) img = collectImgs($detail);

    // —— 全页源码直扫（用 rawHtml 优先；没有则用 $.root().html()）——
    if (!img) {
      const pageHtml = rawHtml || ($.root().html() || '');
      const best = scrapeUrlsFromHtml(pageHtml)
        .map(abs)
        .filter((u) => /\.(jpe?g|png|webp)(?:$|\?)/i.test(u) && !/loader\.svg/i.test(u))
        .sort((a, b) => score(b) - score(a))[0];
      img = best || '';
    }

    img = abs(img);

    const price =
      $detail.find('.price--default, .product--price, .price--content, .price--unit, [itemprop="price"]')
        .first().text().replace(/\s+/g, ' ').trim() || '';

    const sku =
      $detail.find('.manufacturer--name').first().text().trim() ||
      $detail.find('.product--supplier').first().text().trim() || '';

    const row = { sku, title, url, img, price, currency: '', moq: '' };
    if (row.img && /loader\.svg/i.test(row.img)) row.img = '';
    if (row.title || row.url || row.img) items.push(row);
  }

  // ---------- 出口 ----------
  const out = items
    .map((r) => (r && r.img && /loader\.svg/i.test(r.img) ? { ...r, img: '' } : r))
    .slice(0, limit);

  if (debug) {
    const first = out[0] || {};
    console.log('[memoryking] out=%d; first.img=%s title=%s', out.length, first.img, first.title);
  }
  return out;
}
