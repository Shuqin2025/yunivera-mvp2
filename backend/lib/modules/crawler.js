// backend/lib/modules/crawler.js
import axios from 'axios';

/** Absolutize URL against an origin */
export function absolutize(u, origin) {
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith('//')) return 'https:' + u;
  try {
    const base = new URL(origin || 'https://example.com');
    if (u.startsWith('/')) return base.origin + u;
    return new URL(u, base).href;
  } catch { return String(u || ''); }
}

export function splitSrcset(s) {
  return (s || '').split(',').map(x => x.trim().split(/\s+/)[0]).filter(Boolean);
}

/** Prefer jpg/png over webp when multiple candidates exist */
export function pickBestImageFromImgNode($, $img, origin) {
  if (!$img || !$img.length) return '';
  const bag = new Set();
  const push = (v) => { if (v) bag.add(absolutize(v, origin)); };

  // lazy attrs first
  push($img.attr('data-src'));
  splitSrcset($img.attr('data-srcset')).forEach(push);
  push($img.attr('data-fallbacksrc'));
  // then standard attrs
  splitSrcset($img.attr('srcset')).forEach(push);
  push($img.attr('src'));
  // <picture><source srcset>
  $img.closest('picture').find('source[srcset]').each((_i, el) => {
    splitSrcset(el.attribs?.srcset || '').forEach(push);
  });

  const list = [...bag].filter(u => /\.(?:jpe?g|png|webp|gif)(?:$|\?)/i.test(u) && !/loader\.svg/i.test(u));
  if (!list.length) return '';
  const prefer = list.find(u => /\.(?:jpe?g|png|gif)(?:$|\?)/i.test(u));
  if (prefer) return prefer;
  const fromWebp = list.find(u => /\.webp(?:$|\?)/i.test(u));
  if (fromWebp) return fromWebp.replace(/\.webp(\?|$)/i, '.jpg$1');
  return list[0];
}

/** Fetch image with JPEG-preferred Accept header; return {buffer, contentType, extension} */
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
