// backend/routes/catalog.js
// ESM 风格（package.json: "type":"module"）
// 作用：/v1/api/catalog/parse —— 目录页解析（支持 GET/POST、debug 透传、GB18030 解码、兜底选择器）
//
// 依赖：axios cheerio iconv-lite jschardet （你已安装）
// 说明：为兼容挂载方式，路由同时注册「/parse」和「/v1/api/catalog/parse」

import express from 'express';
import axios from 'axios';
import * as iconv from 'iconv-lite';
import jschardet from 'jschardet';
import cheerio from 'cheerio';

const router = express.Router();

// —— 兜底容器/条目选择器（含 sinotronic 专用）—————
const CONTAINER_SEL = [
  '#productlist',                                  // ← 目标站必加
  '.product-list', '.product_list', '.productlist',
  '.pro_list', '.plist', '.listing-container', '.productbox', '.productBox',
  '.content-listing', '.products-list', '.product-items', '.productBoxs'
];

const ITEM_SEL = [
  '#productlist ul > li',                          // ← 目标站必加
  '.product-list li', '.product_list li', '.productlist li',
  '.pro_list li', '.plist li', '.listing-container li',
  '.productBox li', '.products-list li', '.product-items li'
];

// 兼容懒加载图片：优先 src，其次 data-* 常见字段
function getImgSrc($el) {
  return (
    $el.attr('src') ||
    $el.attr('data-src') ||
    $el.attr('data-original') ||
    $el.attr('data-lazy') ||
    ''
  );
}

// 补全相对链接/图片为绝对 URL
function toAbs(base, href = '') {
  try {
    if (!href) return '';
    return new URL(href, base).href;
  } catch {
    return href || '';
  }
}

async function handleParse(req, res) {
  try {
    const isPost = req.method === 'POST';
    const url   = isPost ? (req.body?.url || '')   : (req.query?.url || '');
    const limit = +(isPost ? req.body?.limit : req.query?.limit) || 50;
    const wantDebug = !!(isPost ? req.body?.debug : req.query?.debug);

    if (!url) {
      return res.status(200).json({ ok: false, error: 'missing url', count: 0, items: [] });
    }

    // ---------- 1) 抓页面（arraybuffer）并识别编码 ----------
    const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000, headers: {
      // 某些站点更乐意返回 HTML
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
    }});

    const encDetected = (jschardet.detect(resp.data).encoding || 'utf-8').toLowerCase();
    // 遇到 gbk/gb2312/gb18030 等都按 gb18030 解码
    const useGb = /gb/.test(encDetected);
    const html = iconv.decode(Buffer.from(resp.data), useGb ? 'gb18030' : 'utf-8');

    // ---------- 2) 解析 DOM ----------
    const $ = cheerio.load(html, { decodeEntities: false });

    // 找到第一个命中的容器
    const containerSel = CONTAINER_SEL.find(sel => $(sel).length > 0) || null;
    const listFound = !!containerSel;
    const $ctn = containerSel ? $(containerSel).first() : null;

    // 在容器内确定条目选择器
    let itemSel = null;
    if ($ctn) {
      itemSel = ITEM_SEL.find(sel => $ctn.find(sel).length > 0) || ITEM_SEL[0];
    }

    const base = new URL(url).origin;
    const items = [];

    if ($ctn && itemSel) {
      $ctn.find(itemSel).slice(0, limit).each((i, li) => {
        const $li = $(li);
        const $a = $li.find('a').first();
        const $img = $a.find('img').first().length ? $a.find('img').first() : $li.find('img').first();

        const link = toAbs(base, $a.attr('href'));
        const picRel = getImgSrc($img);
        const image = toAbs(base, picRel);

        // 标题优先取图片 alt，其次 a.title；再不行就取 li 文本
        const title = ($img.attr('alt') || $a.attr('title') || $li.text() || '').trim().replace(/\s+/g, ' ');

        if (title || image || link) {
          items.push({
            index: i + 1,
            sku: title,       // 先把标题放在 sku，前端已有映射
            desc: '',         // 静态页一般列表无详细描述，这里空置
            minQty: '',       // 无
            price: '',        // 列表价多数缺失，保持空
            img: image,
            link
          });
        }
      });
    }

    // ---------- 3) 输出 ----------
    const payload = {
      ok: true,
      url,
      count: items.length,
      items
    };

    if (wantDebug) {
      payload.debug = {
        requested_url: url,
        detected_encoding: encDetected,
        used_encoding: useGb ? 'gb18030' : 'utf-8',
        list_found: listFound,
        container_matched: containerSel,
        item_selector_used: itemSel || null,
        tried: {
          container: CONTAINER_SEL,
          item: ITEM_SEL
        },
        item_count: items.length,
        first_item_html: $ctn && itemSel ? $ctn.find(itemSel).first().html()?.slice(0, 300) : null
      };
    }

    return res.status(200).json(payload);
  } catch (err) {
    // 为了前端统一处理，错误也返回 200，但 ok=false
    return res.status(200).json({ ok: false, error: String(err), count: 0, items: [] });
  }
}

// 同时注册两条路径，兼容是否在 server.js 挂载到 /v1/api/catalog
router.all('/parse', handleParse);
router.all('/v1/api/catalog/parse', handleParse);

export default router;
