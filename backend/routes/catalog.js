// backend/routes/catalog.js
import express from 'express';
import * as cheerio from 'cheerio';
import fetch from 'node-fetch';
import { URL } from 'url';

const router = express.Router();

/** 把相对地址补成绝对地址 */
function toAbsUrl(href, base) {
  try {
    if (!href) return '';
    return new URL(href, base).toString();
  } catch {
    return href || '';
  }
}

/** 去重 */
function uniq(arr) {
  return Array.from(new Set(arr));
}

/** 判断链接像不像商品详情（尽量宽松） */
function looksLikeProductUrl(href) {
  if (!href) return false;
  const h = href.toLowerCase();
  return (
    h.includes('/catalog/') || h.includes('index.php?') || h.includes('/produkt') || h.includes('/product')
  );
}

/** 优先从卡片里挑一个“最像商品”的 a */
function pickBestAnchor($, $card) {
  const anchors = $card.find('a').toArray();
  let best = null;

  for (const a of anchors) {
    const href = $(a).attr('href') || '';
    if (!href) continue;
    if (looksLikeProductUrl(href)) {
      best = a;
      break;
    }
  }
  // 实在没有，就退而求其次：第一个有 href 的链接
  if (!best) {
    best = anchors.find(a => $(a).attr('href')) || null;
  }
  return best;
}

/** 从卡片取图 */
function pickImage($, $card) {
  let src = $card.find('img[src]').first().attr('src') || '';
  if (!src) {
    // 有些站把图片放 data-src
    src = $card.find('img[data-src]').first().attr('data-src') || '';
  }
  return src;
}

/** 解析目录页 */
export async function parseCatalogHandler(req, res) {
  const rawUrl = (req.query.url || '').trim();
  if (!rawUrl) {
    return res.status(400).json({ ok: false, error: 'Missing url' });
  }

  try {
    const response = await fetch(rawUrl, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: 20000,
    });

    if (!response.ok) {
      return res.status(502).json({ ok: false, error: `Upstream ${response.status}` });
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // 多选择器兜底：命中任意一个即可
    const selectorPool = [
      '.product-layout',                 // OpenCart 常见
      '.products-grid .product',         // 常见网店
      '.product-list .product-one',
      'ul.products > li.product',
      '.product-item',
      '.card.product',
      '.catalog-products .catalog-product',
      '.products-listing .product',      // 更多兜底
    ];

    let $cards = $();
    for (const sel of selectorPool) {
      const found = $(sel);
      if (found.length > 0) {
        $cards = found;
        break;
      }
    }

    // 如果还没命中，最后再兜底：页面所有 a[href]，但只挑“像商品”的
    let products = [];
    if ($cards.length === 0) {
      const anchors = $('a[href]')
        .toArray()
        .map(a => $(a).attr('href'))
        .filter(Boolean)
        .map(href => toAbsUrl(href, rawUrl))
        .filter(looksLikeProductUrl);

      const uniqAnchors = uniq(anchors);
      products = uniqAnchors.map(href => ({
        title: '',
        url: href,
        sku: '',
        price: null,
        currency: null,
        img: '',
        preview: '',
      }));
    } else {
      // 从卡片抽取
      $cards.each((_, el) => {
        const $card = $(el);

        const anchor = pickBestAnchor($, $card);
        const href = anchor ? $(anchor).attr('href') : '';
        const absUrl = toAbsUrl(href, rawUrl);
        if (!absUrl) return;

        // 标题：优先 a[title] / a 文本 / 卡片文本里第一句
        let title =
          (anchor && ($(anchor).attr('title') || $(anchor).text().trim())) ||
          $card.find('.product-title, .name, h2, h3, .caption a').first().text().trim() ||
          '';

        // 图片
        const imgSrc = toAbsUrl(pickImage($, $card), rawUrl);

        // 价格 & 货币（尽力匹配）
        let price = null;
        let currency = null;
        const priceText =
          $card.find('.price, .product-price, .price-new, .prices').first().text().replace(/\s+/g, ' ').trim() || '';
        const m = priceText.match(/([€$£])?\s*([\d.,]+)/);
        if (m) {
          price = parseFloat(m[2].replace(/\./g, '').replace(',', '.'));
          currency = m[1] || (priceText.includes('€') ? '€' : null);
        }

        // 预览文案（尽量短）
        const preview =
          $card.find('.description, .product-description, .caption').first().text().replace(/\s+/g, ' ').trim() || '';

        products.push({
          title,
          url: absUrl,
          sku: '',
          price: Number.isFinite(price) ? price : null,
          currency: currency,
          img: imgSrc,
          preview,
        });
      });

      // 去重（按 url）
      const seen = new Set();
      products = products.filter(p => {
        if (!p.url) return false;
        if (seen.has(p.url)) return false;
        seen.add(p.url);
        return true;
      });
    }

    return res.json({
      ok: true,
      source: rawUrl,
      count: products.length,
      products,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[catalog:parse] error', err);
    return res.status(500).json({ ok: false, error: err.message || 'catalog parse error' });
  }
}

// 路由：GET /v1/api/catalog/parse
router.get('/parse', parseCatalogHandler);

export default router;
