// backend/server.js
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { URL } from 'url';

const app = express();
const PORT = process.env.PORT || 10000;

// 允许任意来源（前端预览域名不同步时更省心）
app.use(cors());

// 健康检查
app.get('/healthz', (_, res) => res.send('ok'));

// 工具：把链接 slug 转成 SKU（xxx-yyy.html -> XXX-YYY）
function slugToSku(href = '') {
  try {
    const u = new URL(href, 'https://dummy.invalid');
    const last = u.pathname.split('/').filter(Boolean).pop() || '';
    const base = last.replace(/\.html?$/i, '');
    return base.replace(/[^a-z0-9-]+/ig, '-').replace(/-+/g, '-').toUpperCase();
  } catch {
    const last = (href || '').split('/').filter(Boolean).pop() || '';
    return last.replace(/\.html?$/i, '').replace(/[^a-z0-9-]+/ig, '-').toUpperCase();
  }
}

// 解析 s-impuls-shop.de 分类页商品
function parseSImpulsCatalog(html, base) {
  const $ = cheerio.load(html);

  // 尝试多种常见网店主题的商品卡选择器（容错）
  const candidates = [
    '.product-layout',                 // OpenCart 常见
    '.product-list .product',          // 另一类主题
    '.products-grid .product',         // grid
    '.ty-product-list__item',          // CS-Cart
    '.ty-grid-list__item',             // CS-Cart
    '.prod-box',                       // 通用兜底
  ];

  let cards = [];
  for (const sel of candidates) {
    const found = $(sel);
    if (found.length >= 1) { cards = found.toArray(); break; }
  }

  const items = cards.map(node => {
    const el = $(node);

    // 链接（优先商品标题上的 <a>）
    let a = el.find('a').filter((_, x) => {
      const href = $(x).attr('href') || '';
      return /\/product\/|\.html/i.test(href); // 更像商品链接的 a
    }).first();
    if (!a.length) a = el.find('a').first();

    const href = a.attr('href') || '';
    const url = new URL(href, base).toString();

    // 标题
    const title = (a.text() || el.find('h3, .caption, .name, .ty-grid-list__item-name').text() || '')
      .replace(/\s+/g, ' ')
      .trim();

    // 图片（data-src / data-original / src）
    const imgEl = el.find('img').first();
    const img = new URL(
      imgEl.attr('data-src') || imgEl.attr('data-original') || imgEl.attr('src') || '',
      base
    ).toString();

    // SKU：由 URL 最后一段生成（稳定）
    const sku = slugToSku(url);

    return { sku, title, url, img, price: '', currency: '', moq: '' };
  })
  // 过滤掉没有 sku 或标题/链接的
  .filter(x => x.sku && x.title && x.url);

  return items;
}

app.get('/v1/api/catalog/parse', async (req, res) => {
  try {
    const raw = (req.query.url || '').toString().trim();
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit || '50', 10)));
    if (!raw) return res.status(400).json({ error: 'missing url' });

    const target = new URL(raw);
    // 语言透传：前端会设置 X-Lang（zh/de/en），转成 Accept-Language
    const xLang = (req.get('x-lang') || '').toLowerCase();
    const acceptLanguage = xLang === 'de' ? 'de,de-DE;q=0.9,en;q=0.8'
                         : xLang === 'en' ? 'en,en-GB;q=0.9,de;q=0.8,zh;q=0.7'
                         : 'zh-CN,zh;q=0.9,en;q=0.8,de;q=0.7';

    const resp = await axios.get(target.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept-Language': acceptLanguage,
        'Referer': target.origin + '/',
      },
      timeout: 30000,
      // 避免某些站点压缩差异
      decompress: true,
      validateStatus: s => s >= 200 && s < 400,
    });

    let items = [];
    if (/s-impuls-shop\.de$/i.test(target.hostname)) {
      items = parseSImpulsCatalog(resp.data, target.origin).slice(0, limit);
    } else {
      // 其他站点可在此扩展
      items = [];
    }

    return res.json({
      url: target.toString(),
      count: items.length,
      items
    });
  } catch (err) {
    console.error('[parse error]', err?.message);
    return res.status(500).json({ error: 'parse_failed', message: String(err?.message || err) });
  }
});

// 根路径不暴露页面
app.get('/', (_, res) => res.type('text/plain').send('ok'));

app.listen(PORT, () => {
  console.log(`[mvp2-backend] up on :${PORT}`);
});
