// backend/routes/catalog.js
// 统一目录解析：支持 GET/POST /v1/api/catalog/parse
// - 自动探测并解码页面（UTF-8/GBK/GB2312 → gb18030 兜底）
// - 站点适配（sinotronic-e）+ 通用兜底解析
// - debug=1 时透传详细调试信息，便于核对 DOM

import { Router } from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';
import jschardet from 'jschardet';
import iconv from 'iconv-lite';

// 站点适配器（需存在 ../adapters/sinotronic.js，导出 { test(url), parse($, url, {limit, debug}) }）
import sinotronic from '../adapters/sinotronic.js';

const router = Router();

// -------- 兜底选择器（含你的同事建议） --------
const CONTAINER_FALLBACK = [
  '#productlist',      // ✅ 明确兜底
  '.productlist',
  '.listBox',
  '.list',
  '.products',
  '.product-list',
  'main',
  'body',
];

const ITEM_FALLBACK = [
  '#productlist ul > li',  // ✅ 明确兜底
  'ul.products > li',
  '.product',
  '.product-item',
  '.productItem',
  '.product-box',
  'ul > li',
  'li',
];

// -------- 工具函数 --------
const absolutize = (href, baseUrl) => {
  if (!href) return '';
  try { return new URL(href, baseUrl).href; } catch { return href; }
};

const toBool = (v) =>
  v === 1 || v === '1' || String(v).toLowerCase() === 'true';

// 拉取并解码 HTML（gb 系列统一 gb18030）
async function fetchHtml(url, wantDebug) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 20000,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    validateStatus: () => true,
  });

  const buf = Buffer.from(res.data || []);
  let enc = (jschardet.detect(buf)?.encoding || '').toLowerCase();
  const use = !enc || enc === 'ascii' ? 'utf-8' : (enc.includes('gb') ? 'gb18030' : (iconv.encodingExists(enc) ? enc : 'utf-8'));
  const html = iconv.decode(buf, use);

  return {
    html,
    status: res.status,
    debugFetch: wantDebug ? { detected_encoding: use, http_status: res.status, content_length: buf.length } : undefined,
  };
}

// 通用兜底解析（cheerio）
function genericExtract($, baseUrl, { limit = 50, debug = false } = {}) {
  const tried = { container: [], item: [] };

  // 1) 找容器
  let $container = null;
  for (const sel of CONTAINER_FALLBACK) {
    tried.container.push(sel);
    const hit = $(sel);
    if (hit.length) { $container = hit.first(); break; }
  }
  if (!$container) $container = $('body');

  // 2) 找条目
  let $items = cheerio.load('<i/>')('i'); // 空集
  let itemSelectorUsed = '';
  for (const sel of ITEM_FALLBACK) {
    tried.item.push(sel);
    const hit = $container.find(sel);
    if (hit.length) { $items = hit; itemSelectorUsed = sel; break; }
  }
  if ($items.length === 0) {
    tried.item.push('li');
    $items = $container.find('li');
    itemSelectorUsed = 'li';
  }

  // 3) 抽取
  const items = [];
  $items.each((i, el) => {
    if (items.length >= limit) return false;
    const $$ = $(el);

    // 链接
    const $a = $$.find('a[href]').first();
    const link = absolutize($a.attr('href'), baseUrl);

    // 图片：src / data-src / data-original
    const imgSrc =
      $$.find('img[src]').attr('src') ||
      $$.find('img[data-src]').attr('data-src') ||
      $$.find('img[data-original]').attr('data-original') ||
      '';
    const img = absolutize(imgSrc, baseUrl);

    // 标题：img@alt > h1~h6 > a > 文本
    let title =
      ($$.find('img').attr('alt') || '').trim() ||
      $$.find('h1,h2,h3,h4,h5,h6').first().text().trim() ||
      ($a.text() || '').trim() ||
      $$.text().trim();
    title = title.replace(/\s+/g, ' ').trim();
    const sku = title;

    if (title || link || img) {
      items.push({ sku, desc: title, minQty: '', price: '', img, link });
    }
  });

  const debugPart = debug ? {
    tried,
    container_matched: $container.length,
    item_selector_used: itemSelectorUsed,
    item_count: $items.length,
    first_item_html: $items.first().html() || null,
  } : undefined;

  return { items, debugPart };
}

// 选择适配器→否则兜底
function runExtract(url, html, { limit = 50, debug = false } = {}) {
  const $ = cheerio.load(html, { decodeEntities: false });

  let used = 'generic';
  let items = [];
  let debugPart;

  // 1) 站点适配（如果命中）
  if (sinotronic?.test?.(url)) {
    const out = sinotronic.parse($, url, { limit, debug });
    items = out.items || [];
    if (debug && out.debugPart) debugPart = out.debugPart;
    used = 'sinotronic-e';
  }

  // 2) 如果没抓到，再兜底
  if (items.length === 0) {
    const out = genericExtract($, url, { limit, debug });
    items = out.items || [];
    if (debug && !debugPart) debugPart = out.debugPart;
    used = items.length ? used : 'generic';
  }

  return { items, adapter_used: used, debugPart };
}

// ------------------- 路由 -------------------
router.all('/parse', async (req, res) => {
  try {
    const isGet = req.method === 'GET';
    const url = (isGet ? req.query.url : req.body?.url) || '';

    if (!url) return res.status(400).json({ ok: false, error: 'missing url' });

    const limitRaw = (isGet ? req.query.limit : req.body?.limit);
    const limit = Math.max(1, parseInt(limitRaw ?? 50, 10) || 50);

    const debugWanted = toBool(isGet ? req.query.debug : req.body?.debug);

    // 1) 拉取并解码
    const { html, status, debugFetch } = await fetchHtml(url, debugWanted);
    if (!html || status >= 400) {
      const fail = { ok: false, url, status, error: 'fetch failed' };
      if (debugWanted) fail.debug = { ...(debugFetch || {}), step: 'fetch' };
      return res.status(200).json(fail);
    }

    // 2) 解析
    const { items, adapter_used, debugPart } = runExtract(url, html, { limit, debug: debugWanted });

    // 3) 输出（兼容旧前端：保留 products 字段）
    const payload = {
      ok: true,
      url,
      count: items.length,
      products: [],
      items,
    };

    if (debugWanted) {
      payload.debug = {
        ...(debugFetch || {}),
        adapter_used,
        ...(debugPart || {}),
      };
    }

    return res.status(200).json(payload);
  } catch (err) {
    return res.status(200).json({ ok: false, error: String(err && err.message || err) });
  }
});

export default router;
