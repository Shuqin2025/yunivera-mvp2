// backend/server.js
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import cheerio from 'cheerio';
import pLimit from 'p-limit';

const app = express();
app.use(cors());

// 小工具：绝对地址
const absolutize = (href, base) => {
  try { return new URL(href, base).href; } catch { return href || ''; }
};

// 解析 s-impuls 目录页的“商品卡片”
async function parseImpulsCatalog(listUrl, limit = 50) {
  const ua =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
  const res = await axios.get(listUrl, {
    headers: {
      'User-Agent': ua,
      'Accept-Language': 'de,en;q=0.9',
      // 该站对直接热链/某些请求头比较敏感，这里提供一个 referer
      Referer: listUrl,
    },
    timeout: 20000,
    validateStatus: s => s >= 200 && s < 400,
  });

  const $ = cheerio.load(res.data);

  // 该站的商品列表里，商品图普遍是 /img/products/thumb/xxx.jpg
  const tiles = $('img[src*="/img/products/thumb/"]');
  const items = [];
  tiles.each((i, img) => {
    if (items.length >= limit) return;

    const $img = $(img);
    const imgUrl = absolutize($img.attr('src'), listUrl);

    // 取最近的商品容器，尽量稳健
    const $tile =
      $img.closest('div.product, div.productbox, li, .product-wrapper, .product-list, .artbox')
          .length ? $img.closest('div.product, div.productbox, li, .product-wrapper, .product-list, .artbox')
                  : $img.parent();

    // 商品链接：容器里“最有可能的商品链接”
    const link =
      $tile.find('a[href*="/product/"]').attr('href') ||
      $img.parents('a').attr('href') ||
      '';

    // 标题：容器里的常见类名，兜底 alt
    const title =
      ($tile.find('.pname,.product-name,.name,h2,h3,a[href*="/product/"]').first().text() || $img.attr('alt') || '')
        .replace(/\s+/g, ' ')
        .trim();

    // 从图片文件名推 SKU（如 30805-MHQ-SLIM）
    let sku = '';
    try {
      const pathname = new URL(imgUrl).pathname;
      const fname = pathname.split('/').pop() || '';
      sku = fname.replace(/\.[a-z]+$/i, '');
    } catch { /* noop */ }

    // 过滤误命中的“分类图/广告图”
    if (!sku || !link || !title) return;

    items.push({
      sku,
      title,
      url: absolutize(link, listUrl),
      img: imgUrl,
      price: '',
      currency: '',
      moq: '',
    });
  });

  return { url: listUrl, count: items.length, items };
}

// 目录解析 API
app.get('/v1/api/catalog/parse', async (req, res) => {
  try {
    const listUrl = String(req.query.url || '').trim();
    const limit = Math.max(1, Math.min(500, Number(req.query.limit || 50)));

    if (!listUrl) {
      return res.status(400).json({ error: 'missing url' });
    }

    // 目前你主要抓的是 s-impuls-shop.de；后面要支持别站可以做分发
    const data = await parseImpulsCatalog(listUrl, limit);

    // 前端只接受 items 为数组，这里保证结构正确
    return res.json(data);
  } catch (err) {
    console.error('[parse error]', err?.message);
    return res.status(500).json({ error: 'parse failed', message: err?.message || String(err) });
  }
});

// 图片代理（为预览解决 CORS/防盗链）
app.get('/v1/api/img', async (req, res) => {
  try {
    const src = String(req.query.src || '').trim();
    if (!src) return res.status(400).send('missing src');

    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

    const resp = await axios.get(src, {
      responseType: 'arraybuffer',
      timeout: 20000,
      headers: {
        'User-Agent': ua,
        // 关键：设置 Referer 以通过该站的图片防盗链
        Referer: 'https://www.s-impuls-shop.de/',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
      validateStatus: s => s >= 200 && s < 400,
    });

    const ct = resp.headers['content-type'] || 'image/jpeg';
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(resp.data);
  } catch (err) {
    console.error('[img proxy error]', err?.message);
    res.status(502).send('bad image');
  }
});

app.get('/health', (_, res) => res.send('OK'));

const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log('backend listening on', port);
});
