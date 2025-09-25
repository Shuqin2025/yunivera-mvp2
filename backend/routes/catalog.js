// backend/routes/catalog.js
// 统一目录解析路由：支持 GET/POST /v1/api/catalog/parse
// - 自动探测并解码页面（UTF-8/GBK/GB2312 → gb18030 兜底）
// - 站点专用适配（sinotronic-e）+ 兜底解析（通用选择器）
// - 返回 debug 信息（debug=1 时）

import { Router } from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';
import jschardet from 'jschardet';
import iconv from 'iconv-lite';

// 站点适配器
import sinotronic from '../adapters/sinotronic.js';

const router = Router();

// 兜底容器/条目选择器（通用）
const CONTAINER_FALLBACK = [
  '#productlist',          // <- 你和同事要求的兜底
  '.productlist',
  '.listBox',
  '.list',
  '.products',
  '.product-list',
  'main',
  'body',
];

const ITEM_FALLBACK = [
  '#productlist ul > li',  // <- 你和同事要求的兜底
  'ul.products > li',
  'ul > li',
  '.product',
  '.product-item',
  '.productItem',
  '.product-box',
  'li',
];

// 拉取并解码 HTML
async function fetchHtml(url, debugWanted) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 20000,
    headers: {
      // 模拟常见浏览器（很多外贸站点会做 UA 简单判断）
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    validateStatus: () => true,
  });

  const buf = Buffer.from(res.data);
  let detected = jschardet.detect(buf)?.encoding || '';
  if (detected) detected = detected.toLowerCase();

  // gb 系列统一用 gb18030 解码最保险
  const useEnc =
    !detected || detected === 'ascii'
      ? 'utf-8'
      : detected.includes('gb')
      ? 'gb18030'
      : iconv.encodingExists(detected)
      ? detected
      : 'utf-8';

  const html = iconv.decode(buf, useEnc);

  const debugPart = debugWanted ? { detected_encoding: useEnc, http_status: res.status } : undefined;

  return { html, detected_encoding: useEnc, status: res.status, debugPart };
}

// 兜底解析（通用 cheerio 规则）
function genericExtract($, baseUrl, { limit = 50, debug = false } = {}) {
  const tried = { container: [], item: [] };

  // 找容器
  let $container = cheerio.load('<div></div>')('div'); // 空占位
  for (const c of CONTAINER_FALLBACK) {
    tried.container.push(c);
    const hit = $(c);
    if (hit.length) {
      $container = hit.first();
      break;
    }
  }
  if ($container.length === 0) $container = $('body');

  // 找条目
  let $items = cheerio.load('<div></div>')('div'); // 空
  let itemSelectorUsed = '';
  for (const s of ITEM_FALLBACK) {
    tried.item.push(s);
    const hit = $container.find(s);
    if (hit.length) {
      $items = hit;
      itemSelectorUsed = s;
      break;
    }
  }
  if ($items.length === 0) {
    // 再次粗暴兜底
    tried.item.push('li');
    $items = $container.find('li');
    itemSelectorUsed = 'li';
  }

  const absolutize = (href) => {
    if (!href) return '';
    try { return new URL(href, baseUrl).href; } catch { return href; }
  };

  const items = [];
  $items.each((i, el) => {
    if (items.length >= limit) return false;

    const $el = $(el);

    // 链接：a[href]
    const $a = $el.find('a[href]').first();
    const link = absolutize($a.attr('href'));

    // 图片：img[src] / 懒加载 data-src / data-original
    let src =
      $el.find('img[src]').attr('src') ||
      $el.find('img[data-src]').attr('data-src') ||
      $el.find('img[data-original]').attr('data-original') ||
      '';
    const img = absolutize(src);

    // 标题：img@alt > h1~h6 > a > 纯文本
    let title =
      ($el.find('img').attr('alt') || '').trim() ||
      $el.find('h1,h2,h3,h4,h5,h6').first().text().trim() ||
      ($a.text() || '').trim() ||
      $el.text().trim();

    title = title.replace(/\s+/g, ' ').trim();
    const sku = title;

    if (title || link || img) {
      items.push({
        sku,
        desc: title,
        minQty: '',
        price: '',
        img,
        link,
      });
    }
  });

  const debugPart = debug
    ? {
        container_matched: $container.length,
        item_selector_used: itemSelectorUsed,
        item_count: $items.length,
        first_item_html: $items.first().html() || null,
        tried,
      }
    : undefined;

  return { items, debugPart };
}

// 主解析：选适配器 -> 否则走通用
function runExtract(url, html, { limit = 50, debug = false } = {}) {
  const $ = cheerio.load(html, { decodeEntities: false });

  let used = 'generic';
  let items = [];
  let debugFromAdapter;

  if (sinotronic.test(url)) {
    const out = sinotronic.parse($, url, { limit, debug });
    items = out.items || [];
    debugFromAdapter = out.debugPart;
    used = 'sinotronic-e';
  }

  if (items.length === 0) {
    const out = genericExtract($, url, { limit, debug });
    if (!items.length) items = out.items || [];
    if (debug && !debugFromAdapter) debugFromAdapter = out.debugPart;
    if (items.length && used === 'generic') used = 'generic';
  }

  return { items, adapter_used: used, debugPart: debug ? debugFromAdapter : undefined };
}

// ------------------- 路由 -------------------

router.all('/parse', async (req, res) => {
  try {
    const isGet = req.method === 'GET';
    const url = (isGet ? req.query.url : req.body?.url) || '';

    if (!url) {
      return res.status(400).json({ ok: false, error: 'missing url' });
    }

    const limitRaw = (isGet ? req.query.limit : req.body?.limit) ?? 50;
    const limit = Math.max(0, parseInt(limitRaw, 10) || 50);

    // debug=1 / true 时开启
    const debugWantedRaw = (isGet ? req.query.debug : req.body?.debug);
    const debugWanted =
      debugWantedRaw === 1 ||
      debugWantedRaw === '1' ||
      String(debugWantedRaw).toLowerCase() === 'true';

    // 拉取 & 解码
    const { html, detected_encoding, status, debugPart: fetchDebug } = await fetchHtml(url, debugWanted);
    if (!html || status >= 400) {
      const resp = { ok: false, url, status, error: 'fetch failed' };
      if (debugWanted) resp.debug = { ...(fetchDebug || {}), step: 'fetch' };
      return res.status(200).json(resp);
    }

    // 解析
    const { items, adapter_used, debugPart } = runExtract(url, html, { limit, debug: debugWanted });

    const payload = {
      ok: true,
     
