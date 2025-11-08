// backend/lib/modules/crawler.js
import axios from 'axios';

/** Make URL absolute against an origin */
export function absolutize(u, origin) {
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith('//')) return 'https:' + u;
  try {
    const o = new URL(origin || 'https://example.com');
    if (u.startsWith('/')) return o.origin + u;
    return o.origin + '/' + u.replace(/^\.?\//, '');
  } catch { return u; }
}

export function splitSrcset(s) {
  return (s || '').split(',').map(x => x.trim().split(/\s+/)[0]).filter(Boolean);
}

/** Prefer jpg/png over webp when multiple sources exist */
export function pickBestImageFromImgNode($, $img, origin) {
  if (!$img || !$img.length) return '';
  const bag = new Set();
  const push = (v) => { if (v) bag.add(absolutize(v, origin)); };

  push($img.attr('data-src'));
  splitSrcset($img.attr('data-srcset')).forEach(push);
  push($img.attr('data-fallbacksrc'));
  splitSrcset($img.attr('srcset')).forEach(push);
  push($img.attr('src'));
  $img.closest('picture').find('source[srcset]').each((_i, el) => {
    splitSrcset(el.attribs?.srcset || '').forEach(push);
  });

  const list = [...bag].filter(u => /\.(?:jpe?g|png|webp)(?:$|\?)/i.test(u) && !/loader\.svg/i.test(u));
  if (!list.length) return '';
  const prefer = list.find(u => /\.(?:jpe?g|png)(?:$|\?)/i.test(u));
  if (prefer) return prefer;
  // try naive extension swap
  const fromWebp = list.find(u => /\.webp(?:$|\?)/i.test(u));
  if (fromWebp) return fromWebp.replace(/\.webp(\?|$)/i, '.jpg$1');
  return list[0];
}

/** Fetch image bytes with JPEG-preferred Accept header (better for Excel embed) */
export async function fetchImagePreferJpeg(url, timeout = 15000) {
  const resp = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
      'Accept': 'image/avif,image/jpeg,image/png,image/*,*/*;q=0.8',
      'Referer': (() => { try { return new URL(url).origin + '/'; } catch { return undefined; } })(),
    },
    validateStatus: s => s >= 200 && s < 400,
  });
  const ct = String(resp.headers['content-type'] || 'application/octet-stream');
  let ext = 'jpeg';
  if (/png/i.test(ct)) ext = 'png';
  else if (/gif/i.test(ct)) ext = 'gif';
  return { buffer: Buffer.from(resp.data), contentType: ct, extension: ext };
}
