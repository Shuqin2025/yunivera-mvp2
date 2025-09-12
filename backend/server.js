// backend/server.js  —— 直接整文件替换

import express from 'express';
import cors from 'cors';
import { load } from 'cheerio';         // ✅ 正确的 ESM 导入
import fetch from 'node-fetch';         // 已在 package.json 里：^2.6.7
import pLimit from 'p-limit';

const app = express();
app.use(cors());

/** 将可能的相对地址 → 绝对地址 */
function abs(u, base) {
  try { return new URL(u, base).href; } catch { return u || ''; }
}

/** 从图片地址里抽取商品编码（如 30821-MHQ.jpg → 30821-MHQ） */
function skuFromImg(imgUrl) {
  try {
    const name = imgUrl.split('/').pop() || '';
    return name.replace(/\.(jpg|jpeg|png|webp|gif)\b.*$/i, '');
  } catch { return ''; }
}

/** 针对 s-impuls-shop 列表页抓取 */
function parseSImpulsList(html, pageUrl) {
  const $ = load(html);
  const items = [];

  // 尝试覆盖常见主题结构
  const cards = $('.product-thumb, .product-layout, .product-grid');
  cards.each((_, el) => {
    const $el = $(el);

    // 链接：优先 caption/name 区域的 a
    const a =
      $el.find('.caption a[href]').first().attr('href') ||
      $el.find('.name a[href]').first().attr('href') ||
      $el.find('a[href]').first().attr('href') ||
      '';

    // 图片：优先 img[data-src] / img[src]
    const img =
      $el.find('img[data-src]').attr('data-src') ||
      $el.find('img[src]').attr('src') ||
      '';

    // 标题：caption/name/h4
    const rawTitle =
      $el.find('.caption a').first().text().trim() ||
      $el.find('.name a').first().text().trim() ||
      $el.find('h4 a, h4').first().text().trim() ||
      '';

    const title = rawTitle.replace(/\s+/g, ' ').trim();

    const absLink = abs(a, pageUrl);
    const absImg = abs(img, pageUrl);
    const sku = skuFromImg(absImg);

    if (absLink || absImg || title) {
      items.push({
        sku,
        title,
        url: absLink,
        img: absImg,
        price: '',
        currency: '',
        moq: ''
      });
    }
  });

  return items;
}

/** 通用入口：按域名分流 */
function parseByHost(html, pageUrl) {
  const host = (() => { try { return new URL(pageUrl).host; } catch { return ''; } })();

  if (/s-impuls-shop\.de$/i.test(host)) {
    const items = parseSImpulsList(html, pageUrl);
    return { url: pageUrl, count: items.length, items };
  }

  // 其它站先返回空数组结构，避免前端报错
  return { url: pageUrl, count: 0, items: [] };
}

app.get('/v1/api/catalog/parse', async (req, res) => {
  const pageUrl = (req.query.url || '').toString().trim();
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit || '50', 10)));

  if (!pageUrl) {
    return res.status(400).json({ error: 'missing url', items: [] });
  }

  try {
    const htmlRes = await fetch(pageUrl, {
      headers: {
        // 降低被判 bot 的概率
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36',
        'accept-language': 'de,en;q=0.9,zh;q=0.8'
      },
      // 不跟踪重定向可换成 'follow'
      redirect: 'follow'
    });

    const html = await htmlRes.text();
    const parsed = parseByHost(html, pageUrl);

    // 截断返回数量（只影响 items，不影响 count）
    const items = Array.isArray(parsed.items) ? parsed.items.slice(0, limit) : [];

    return res.json({
      url: parsed.url || pageUrl,
      count: parsed.count ?? items.length,
      items
    });
  } catch (err) {
    console.error('[parse] error:', err);
    return res.status(500).json({ error: 'fetch_fail', items: [] });
  }
});

// 健康检查
app.get('/healthz', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`[mvp2-backend] listening on ${PORT}`);
});
