// backend/routes/catalog.js
import express from 'express';
import * as cheerio from 'cheerio';
import { URL } from 'node:url';

const router = express.Router();

// 绝对链接工具
function absolutize(base, href) {
  try {
    return new URL(href, base).toString();
  } catch {
    return href || '';
  }
}

// 提取并清洗文本
function clean(t = '') {
  return t.replace(/\s+/g, ' ').trim();
}

// 从价格文本里大致提取数字（保留原币种文本）
function pickPrice(text = '') {
  const m = text.replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

// 针对 s-impuls 等常见电商列表的鲁棒选择器
const PRODUCT_BLOCK_SELECTOR = [
  // 常见 B2B/B2C 列表
  '#content .product-list .product-layout',
  '#content .product-grid .product-layout',
  '.product-list .product-layout',
  '.product-grid .product-layout',
  // 有的主题直接用 col- 栅格项承载商品块
  '#content .product-grid > div[class*=col-]',
  '#content .product-list > div[class*=col-]',
  '.product-grid > div[class*=col-]',
  '.product-list > div[class*=col-]',
].join(', ');

// 尝试从一个商品块中抓取信息
function scrapeItem($, base, el) {
  const $el = $(el);

  // 标题与链接
  const $titleA =
    $el.find('.caption h4 a').first().length
      ? $el.find('.caption h4 a').first()
      : $el.find('h4 a, .product-title a, .title a').first();

  const title = clean($titleA.text());
  const url = absolutize(base, $titleA.attr('href') || '');

  // 图片
  const $img =
    $el.find('.image img').first().length
      ? $el.find('.image img').first()
      : $el.find('img').first();
  const img = absolutize(base, $img.attr('data-src') || $img.attr('src') || '');

  // 价格（如果有）
  const priceText =
    $el.find('.price').first().text() ||
    $el.find('.product-price').first().text() ||
    '';
  const price = pickPrice(priceText);

  // SKU/型号（如果有）
  const sku =
    clean(
      $el.find('.model, .product-model, .sku, .product-sku').first().text()
    ) || '';

  // 简短预览（如果有）
  const preview =
    clean(
      $el
        .find('.description, .product-description, .desc')
        .first()
        .text()
    ) || '';

  // 币种：此处不足为据，仅在存在价格文本时保留原始价钱行以供人工审阅
  const currency = priceText ? null : null;

  return { title, url, sku, price, currency, img, preview };
}

// GET /v1/api/catalog/parse?url=...
router.get('/parse', async (req, res) => {
  const target = (req.query.url || '').toString().trim();
  if (!target) {
    return res.status(400).json({ ok: false, error: 'Missing url' });
  }

  try {
    // Node 18+ 全局 fetch（无需 node-fetch）
    const resp = await fetch(target, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
        accept: 'text/html,application/xhtml+xml',
      },
      // timeout：Render 上可不设，若想严格限制可用 AbortController
    });

    if (!resp.ok) {
      return res
        .status(502)
        .json({ ok: false, error: `Upstream HTTP ${resp.status}` });
    }

    const html = await resp.text();
    const $ = cheerio.load(html);

    // 抓取商品块
    const blocks = $(PRODUCT_BLOCK_SELECTOR).toArray();

    // 兜底：有些站点把每个商品放在 .product-thumb 或 .product-item
    const fallbacks =
      blocks.length > 0
        ? blocks
        : $('.product-thumb, .product-item').toArray();

    const items = (fallbacks.length ? fallbacks : [])
      .map((el) => scrapeItem($, target, el))
      // 排除明显空壳（没有标题也没有链接）
      .filter((it) => it.title || it.url);

    return res.json({
      ok: true,
      source: target,
      count: items.length,
      products: items,
    });
  } catch (err) {
    console.error('[catalog.parse] error:', err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

export default router;
