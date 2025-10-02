// backend/lib/images.js
// 通用图片解析：img/src/srcset/picture/source/data-* 任意属性里的图片链接 + style:background-image
// 统一过滤 loader/placeholder，自动绝对化；可取单图或多图。

const IMG_EXT = /\.(avif|webp|jpe?g|png|gif|bmp|tiff)(\?.*)?$/i;
const BAD_HINT = /(loader\.svg|spacer\.gif|transparent|placeholder|no[-_]?image|dummy|blank)/i;

function abs(base, href) {
  try { return new URL(href, base).href; } catch { return href || ''; }
}

function clean(url) {
  if (!url) return '';
  // 去掉多余空格与引号
  url = String(url).trim().replace(/^['"]|['"]$/g, '');
  return url;
}

function pickFromSrcset(srcset) {
  // e.g. "a.jpg 320w, b.jpg 640w, c.jpg 1200w"
  if (!srcset) return '';
  let best = '', score = -1;
  String(srcset).split(',').forEach(part => {
    const m = part.trim().match(/(\S+)\s+(\d+)(w|x)?$/i);
    const url = m ? m[1] : part.trim().split(/\s+/)[0];
    const s = m ? parseInt(m[2], 10) || 0 : 0;
    if (IMG_EXT.test(url) && s >= score) { best = url; score = s; }
  });
  return best || '';
}

function pickFromStyle(style) {
  if (!style) return '';
  const m = String(style).match(/url\(([^)]+)\)/i);
  return m ? clean(m[1]) : '';
}

function findAnyAttrImage($el) {
  // 在任意属性里找图片链接（常见 data-* / file / data-original 等）
  const attrs = $el.get(0)?.attribs || {};
  for (const k of Object.keys(attrs)) {
    const v = attrs[k];
    if (typeof v === 'string' && IMG_EXT.test(v) && !BAD_HINT.test(v)) return v;
  }
  return '';
}

/**
 * 从一个产品块或 <img> 节点中“尽力而为”找首张清晰图
 * @param {$} $ctx Cheerio 节点
 * @param {string} baseUrl 绝对化基准
 * @returns {string|undefined}
 */
export function pickImage($ctx, baseUrl) {
  if (!$ctx || !$ctx.length) return undefined;

  // 1) 直取 <img>
  let $img = $ctx.is('img') ? $ctx : $ctx.find('img').first();
  if ($img && $img.length) {
    const srcset = $img.attr('srcset') || $img.attr('data-srcset');
    let url =
      pickFromSrcset(srcset) ||
      $img.attr('src') ||
      $img.attr('data-src') ||
      $img.attr('data-original') ||
      $img.attr('data-lazy') ||
      $img.attr('data-image') ||
      $img.attr('data-img') ||
      $img.attr('file') ||
      findAnyAttrImage($img);

    if (!url) {
      const st = $img.attr('style');
      url = pickFromStyle(st);
    }
    if (!url) {
      // 某些站把 url 放上级
      const st2 = $ctx.attr('style');
      url = pickFromStyle(st2);
    }
    if (url && IMG_EXT.test(url) && !BAD_HINT.test(url)) {
      return abs(baseUrl, clean(url));
    }
  }

  // 2) <picture><source srcset>
  const $source = $ctx.find('picture source[srcset], picture source[data-srcset]').first();
  if ($source.length) {
    const url = pickFromSrcset($source.attr('srcset') || $source.attr('data-srcset'));
    if (url && IMG_EXT.test(url) && !BAD_HINT.test(url)) {
      return abs(baseUrl, clean(url));
    }
  }

  // 3) 任意属性里出现图片链接
  let any = findAnyAttrImage($ctx);
  if (any) return abs(baseUrl, clean(any));

  // 4) 后代节点的 style 背景图
  const styleBg = $ctx.find('[style*="background"]').map((_, el) => pickFromStyle(el.attribs?.style)).get().find(u => IMG_EXT.test(u) && !BAD_HINT.test(u));
  if (styleBg) return abs(baseUrl, clean(styleBg));

  return undefined;
}

/**
 * 提取多图（去重），默认上限 8
 * @param {$} $ctx
 * @param {string} baseUrl
 * @param {number} limit
 * @returns {string[]}
 */
export function pickAllImages($ctx, baseUrl, limit = 8) {
  const set = new Set();

  // 主图优先
  const main = pickImage($ctx, baseUrl);
  if (main) set.add(main);

  // 所有 <img> 的 src/srcset/data-*
  $ctx.find('img').each((_, img) => {
    const $img = $ctx.cheerio ? $ctx.cheerio(img) : $ctx.constructor(img);
    const url1 =
      pickFromSrcset($img.attr('srcset') || $img.attr('data-srcset')) ||
      $img.attr('src') || $img.attr('data-src') || $img.attr('data-original') || $img.attr('data-lazy') || '';
    if (url1 && IMG_EXT.test(url1) && !BAD_HINT.test(url1)) set.add(abs(baseUrl, clean(url1)));

    const any = findAnyAttrImage($img);
    if (any) set.add(abs(baseUrl, clean(any)));
  });

  // 所有 <source srcset>
  $ctx.find('source[srcset],source[data-srcset]').each((_, s) => {
    const $s = $ctx.cheerio ? $ctx.cheerio(s) : $ctx.constructor(s);
    const u = pickFromSrcset($s.attr('srcset') || $s.attr('data-srcset'));
    if (u && IMG_EXT.test(u) && !BAD_HINT.test(u)) set.add(abs(baseUrl, clean(u)));
  });

  // 所有 style 背景图
  $ctx.find('[style*="background"]').each((_, el) => {
    const u = pickFromStyle(el.attribs?.style || '');
    if (u && IMG_EXT.test(u) && !BAD_HINT.test(u)) set.add(abs(baseUrl, clean(u)));
  });

  return [...set].slice(0, limit);
}

export default { pickImage, pickAllImages };
