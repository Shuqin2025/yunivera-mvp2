// backend/lib/templateParser.js  (ESM-compatible)
//
// This file converts the previous CommonJS implementation to ESM while preserving behavior.
// - Uses `import` instead of `require`
// - Provides both named exports (parse, parseCatalog) AND a default export object
// - Loads sibling modules in a CJS/ESM compatible way (default-or-namespace)

import { load } from "cheerio";

// ---- logger (compatible import) ----
let logger = null;
try {
  const mod = await import("./logger.js").catch(() => ({}));
  logger = mod.default || mod.logger || null;
} catch {}

// ---- structure detector (named export exists in our repo) ----
let detectStructure = null;
try {
  const mod = await import("./structureDetector.js").catch(() => ({}));
  detectStructure = mod.detectStructure || mod.default || null;
} catch {}

// ---- platform parsers (lazy top-level import; support default or namespace) ----
const shopware = (await import("./parsers/shopwareParser.js").catch(() => ({}))).default ?? (await import("./parsers/shopwareParser.js").catch(() => ({})));
const woo      = (await import("./parsers/woocommerceParser.js").catch(() => ({}))).default ?? (await import("./parsers/woocommerceParser.js").catch(() => ({})));
const magento  = (await import("./parsers/magentoParser.js").catch(() => ({}))).default ?? (await import("./parsers/magentoParser.js").catch(() => ({})));
const shopify  = (await import("./parsers/shopifyParser.js").catch(() => ({}))).default ?? (await import("./parsers/shopifyParser.js").catch(() => ({})));
const generic  = (await import("./parsers/genericLinksParser.js").catch(() => ({}))).default ?? (await import("./parsers/genericLinksParser.js").catch(() => ({})));

// ---- helpers: artikel extractor & detail fetcher ----
const artikelMod = await import("./modules/artikelExtractor.js").catch(() => ({}));
const detailsMod = await import("./modules/detailFetcher.js").catch(() => ({}));
const artikel = artikelMod.default || artikelMod;
const details = detailsMod.default || detailsMod;

// --- DEBUG helper (append-only) ---
const __dbgT = (tag, data) => {
  try {
    if (process?.env?.DEBUG) {
      const msg = typeof data === 'string' ? data : JSON.stringify(data);
      console.log(`[templ] ${tag} ${msg}`);
    }
  } catch {}
};
// --- /DEBUG helper ---

// 解析后结果过少的回退策略（命中模板但抓不到 ≥3 个有效产品时返回空）
function withFallback(parseFn, $, url, limit, adapterName) {
  try {
    if (typeof parseFn === "function") {
      const data = parseFn($, url, { limit }) || [];
      const valid = Array.isArray(data) ? data.filter(x => x && x.title && x.url) : [];
      if (valid.length >= 3) return data;
      if (process.env.DEBUG) console.log('[parser.fallback]', { adapter: adapterName, got: valid.length });
    }
  } catch (e) {
    if (process.env.DEBUG) console.log('[parser.fallback.error]', { adapter: adapterName, err: String((e && e.message) || e) });
  }
  // 回退：避免误把导航当商品
  return [];
}

// —— 通用垃圾/站点链接过滤 ——（与 detector 中保持同源词表）
const GENERIC_LINK_BAD = new RegExp(
  [
    'hilfe','support','kundendienst','faq','service',
    'agb','widerruf','widerrufsbelehrung','rueckgabe','retoure',
    'versand','lieferung','payment','zahlungs',
    'datenschutz','privacy','cookies?',
    'kontakt','contact','impressum','about','ueber\\-?uns',
    'newsletter','blog','news','sitemap','rss','login','register','account',
    'warenkorb','cart','checkout','bestellung',
    'note','paypal','gift','gutschein','jobs','karriere',
    '\\.pdf$'
  ].join('|'),
  'i'
);

// —— 极简兜底（最后一道保险）——
// 尽量从“看起来像商品卡片/可点击图片/标题”的节点里收集链接
function fallbackParse($, url, limit = 50) {
  const items = [];
  const seen = new Set();

  const CARD_SEL = [
    '.product, .product-card, .product-item, [class*="product"] a[href]',
    'article a[href]',
    'li a[href]',
    'a[href]'
  ].join(', ');

  $(CARD_SEL).each((_, el) => {
    if (items.length >= limit) return false;

    const $el = $(el);
    const $a = $el.is('a') ? $el : $el.find('a[href]').first();
    const rawHref = ($a.attr('href') || '').trim();
    if (!rawHref) return;

    if (GENERIC_LINK_BAD.test(rawHref)) return;
    if (/add-to-cart|wishlist|compare|mailto:/i.test(rawHref)) return;

    let abs = '';
    try { abs = new URL(rawHref, url).toString(); } catch {}
    if (!abs || seen.has(abs)) return;

    const title =
      ($a.attr('title') || '').trim() ||
      ($el.is('a') ? $a.text() : $el.text() || '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!title) return;

    items.push({
      title,
      url: abs,
      img: '',
      imgs: [],
      price: '',
      sku: '',
      desc: ''
    });
    seen.add(abs);
  });

  return items.slice(0, limit);
}

// —— 模板映射 ——（供优先级选择）
const map = {
  Shopware:    shopware,
  WooCommerce: woo,
  Magento:     magento,
  Shopify:     shopify,
};

// 统一结构
function toUnified(items = []) {
  return items.map(it => ({
    name:        it.title || it.name || '',
    model:       it.model || '',
    sku:         it.sku || '',
    price:       it.price || '',
    image:       (it.imgs && it.imgs[0]) || it.img || '',
    description: it.desc || it.description || '',
    link:        it.url || it.link || '',
  }));
}

function skuMissingOrSuspicious(s) {
  const x = (s || '').trim();
  if (!x) return true;
  if (x.length < 4) return true;
  if (/^\d{1,3}$/.test(x)) return true;
  return false;
}

/**
 * 解析统一入口（Cheerio 路线，保留原有逻辑）
 */
export async function parse(html, url, opts = {}) {
  const {
    limit = 50,
    typeHint = '',
    detail = {}
  } = opts;

  const enableDetail = detail.enable !== false;
  const takeMax      = Math.max(1, detail.takeMax || 20);
  const concurrency  = Math.min(12, Math.max(1, detail.concurrency || 6));

  const $ = load(html);

  // 1) 检测结构 & 平台（用于选择解析路径 + 记录调试信息）
  let structure = { type: '', platform: '' };
  try {
    if (typeof detectStructure === "function") {
      structure = await detectStructure(url, html);
    }
  } catch {}

  const platformFromDetect = structure.platform || '';
  const typeFromDetect     = structure.type || '';
  const type               = typeHint || typeFromDetect;

  if (process.env.DEBUG) {
    console.log('[parser.detect]', JSON.stringify({ url, type, platform: platformFromDetect, debug: structure.debug }));
  }
  __dbgT('choose-adapter.in', { url, platform: structure?.platform, hints: structure });

  // 【新增】在真正挑选适配器之前打一条 pickAdapter 预日志
  logger?.debug?.(`[template] pickAdapter url=${url} -> (pre) platform=${platformFromDetect || '-'} type=${type || '-'}`);

  // 2) 选择解析器：平台 → generic-links → 极简兜底
  let adapterName = '';
  let items = [];

  // 2.1 平台解析（优先）
  const chosenAdapter = platformFromDetect && map[platformFromDetect];
  if (chosenAdapter && typeof chosenAdapter.parse === 'function') {
    items = withFallback(chosenAdapter.parse, $, url, limit, platformFromDetect);
    adapterName = platformFromDetect;
  }

  // 2.2 平台解析拿不到结果：尝试 generic-links（更“懂”目录页里的深层商品锚点）
  //    - 如果 detector 判断是 catalog，优先试 generic-links
  if (!items.length || type === 'catalog' || !adapterName) {
    const reason =
      !items.length && adapterName ? 'no-products'
      : (!adapterName ? 'no-adapter'
      : (type === 'catalog' ? 'type=catalog' : 'unknown'));

    logger?.debug?.(
      `[template] generic-links fallback url=${url} reason=${reason} adapter=${adapterName || '-'}`
    );

    if (generic && typeof generic.parse === 'function') {
      const genericData = withFallback(generic.parse, $, url, limit, 'generic-links');
      if (genericData.length) {
        items = genericData;
        adapterName = 'generic-links';
      }
    }
  }

  // 2.3 仍无结果：极简兜底
  if (!items.length) {
    items = fallbackParse($, url, limit);
    if (!adapterName) adapterName = 'fallback';
    try { if (process.env.DEBUG) console.log('[tpl]', 'deepAnchorFallback HIT'); } catch (_) {}
    logger?.debug?.(`[template] ultimate-fallback (cheerio) url=${url} adapter=${adapterName}`);
  }

  __dbgT('choose-adapter.out', { url, adapter: adapterName || 'generic-links' });
  // 【新增】最终确定适配器后打一条日志
  logger?.debug?.(
    `[template] pickAdapter url=${url} -> ${adapterName || 'fallback'} struct=${safeJson(structure)}`
  );

  // 3) 二次过滤“站点链接”
  items = items.filter(it => {
    const href = it.url || it.link || '';
    if (!href) return false;
    return !GENERIC_LINK_BAD.test(href);
  });

  // 4) 统一结构
  let unified = toUnified(items);

  // 4.1 SKU 轻量补齐
  for (const it of unified) {
    if (!skuMissingOrSuspicious(it.sku)) continue;
    try {
      if (artikel && typeof artikel.extract === "function") {
        const guess = artikel.extract([it.name, it.description].filter(Boolean).join(' '));
        if (guess) it.sku = guess;
      }
    } catch {}
  }

  // 5) 详情页补抓（仅缺失/可疑 SKU）
  if (enableDetail && unified.length) {
    const need = unified
      .filter(x => skuMissingOrSuspicious(x.sku))
      .slice(0, takeMax);

    if (need.length) {
      try {
        if (details && typeof details.fetchDetails === "function") {
          const enriched = await details.fetchDetails(
            need.map(x => x.link),
            { concurrency, timeout: 15000 }
          );
          const byUrl = new Map(unified.map(x => [x.link, x]));
          for (const r of enriched || []) {
            const t = byUrl.get(r.url);
            if (!t) continue;
            if (skuMissingOrSuspicious(t.sku) && r.sku) t.sku = r.sku;
            if (!t.name && r.title) t.name = r.title;
            if (!t.price && r.price) t.price = r.price;
            if (!t.image && r.image) t.image = r.image;
            if (!t.description && r.description) t.description = r.description;
          }
          unified = Array.from(byUrl.values());
        }
      } catch {}
    }
  }

  if (process.env.DEBUG) {
    console.log('[parser.result]', JSON.stringify({
      url, adapter: adapterName || 'fallback', count: unified.length
    }));
  }

  if (!unified.length) {
    try { if (process.env.DEBUG) console.log('[tpl]', 'NoProductFound RETURN'); } catch (_) {}
  }
  return unified.slice(0, limit);
}

/* -------------------------------------------------------------------------- */
/*                  Puppeteer 路线：parseCatalog(page, url, …)                */
/*   进入页面=等待 networkidle0 + 轻滚动触发懒加载 + 等待产品线索                */
/*   evaluate 真正读取渲染后 DOM；失败时可选择截屏；再做去噪与去重              */
/* -------------------------------------------------------------------------- */

const PRODUCT_HINTS = [
  '.product-item', '.product', '.products .item', '.product-card',
  '[data-product-id]', '[data-product]', '[data-item-id]'
];
const WAIT_SELECTOR = PRODUCT_HINTS.join(', ');

/**
 * @param {import('puppeteer').Page} page
 * @param {string} url
 * @param {string} adapterHint 仅用于日志
 * @returns {Promise<{ok: boolean, count: number, products: Array}>}
 */
export async function parseCatalog(page, url, adapterHint) {
  const t0 = Date.now();
  logger?.info?.(`[parseCatalog] ▶️ open ${url} (hint=${adapterHint || '-'})`);

  // 1) 进入页面 + 等待网络空闲（networkidle0）+ 一点点时间给懒加载
  try {
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 60_000 });
  } catch (_) {}
  await page.waitForTimeout(800);

  // 等候产品线索出现；若失败继续走 fallback（不要直接 throw）
  let found = await page.$(WAIT_SELECTOR);
  if (!found) {
    // 轻度滚动触发懒加载
    await autoScroll(page, 1200);
    await page.waitForTimeout(600);
    found = await page.$(WAIT_SELECTOR);
  }

  // 2) evaluate 真正读取“渲染后的 DOM”
  const result = await page.evaluate((HINTS) => {
    const sel = HINTS.join(', ');
    const cards = Array.from(document.querySelectorAll(sel));

    // 如果还没抓到产品卡，降级用“深层 a[href]”兜底（避开 Logo / 顶导航）
    const deepAnchors = (cards.length ? [] : Array.from(
      document.querySelectorAll('main a[href], .content a[href], .page a[href]')
    )).filter(a => {
      const href = (a.getAttribute('href') || '').toLowerCase();
      const txt = (a.textContent || '').trim().toLowerCase();
      // 排除登录/隐私/关于等明显非产品
      if (/login|anmelden|agb|datenschutz|kontakt|impressum|support|widerruf/i.test(href + ' ' + txt)) return false;
      // 仅保留看起来像商品/分类的链接
      return /product|prod|artikel|item|sku|\/p\/|\/dp\/|\/shop\//i.test(href) || /\b(kabel|socken|dell|server|audio)\b/i.test(txt);
    }).slice(0, 120); // 限制数量，防炸

    const nodes = cards.length ? cards : deepAnchors;

    const products = nodes.map((n) => {
      // 兼容 <a> 或 <div.card>
      const root = n.tagName === 'A' ? n : (n.closest('a') || n);
      const find = (s) => root.querySelector(s);

      const imgEl   = find('img');
      const priceEl = find('.price, [class*="price"], .amount, .money, [itemprop="price"]');
      const titleEl = find('h1,h2,h3,.title,[itemprop="name"]') || root;
      const href    = root.getAttribute('href') || root.getAttribute('data-href') || '';

      let abs = href;
      try { abs = href.startsWith('http') ? href : new URL(href, location.href).href; } catch {}

      return {
        sku:   (root.getAttribute('data-sku') || '').trim(),
        title: (titleEl.textContent || '').trim() || 'item',
        url:   abs,
        price: (priceEl?.textContent || '').trim(),
        image: imgEl?.getAttribute('data-src') || imgEl?.getAttribute('src') || '',
      };
    });

    return { products, hintUsed: cards.length ? 'cards' : 'deepAnchors' };
  }, PRODUCT_HINTS);

  // 3) 调试快照（按需打开）
  if (process.env.DEBUG_SNAPSHOT === '1') {
    try {
      await page.screenshot({ path: `debug_${Date.now()}.png`, fullPage: true });
    } catch {}
    logger?.info?.(`[parseCatalog] snapshot saved. hint=${result.hintUsed} count=${result.products.length}`);
  }

  // 去掉明显的“整站页块” & 空标题“item”重复项
  const filtered = dedupeAndFilter(result.products);

  logger?.info?.(
    `[parseCatalog] ✅ parsed=${filtered.length} (raw=${result.products.length}, hint=${result.hintUsed}, ${Date.now()-t0}ms)`
  );

  // 始终返回统一结构
  return {
    ok: true,
    count: filtered.length,
    products: filtered,
  };
}

function dedupeAndFilter(items) {
  const bad = /impressum|agb|datenschutz|kontakt|login|anmelden|widerruf|versand|support|about|über\s*uns/i;
  const seen = new Set();
  const out = [];
  for (const p of items || []) {
    if (!p || !p.url) continue;
    const both = (String(p.url) + ' ' + String(p.title || '')).toLowerCase();
    if (bad.test(both)) continue;

    // 去掉 title === "item" 且 URL 重复的
    const key = (p.url.split('#')[0] || '') + '::' + (p.title || '');
    if (seen.has(key)) continue;
    seen.add(key);

    out.push(p);
  }
  return out.slice(0, 200);
}

async function autoScroll(page, height = 1200) {
  await page.evaluate(async (h) => {
    await new Promise((resolve) => {
      let scrolled = 0;
      const timer = setInterval(() => {
        window.scrollBy(0, 250);
        scrolled += 250;
        if (scrolled >= h) { clearInterval(timer); resolve(); }
      }, 80);
    });
  }, height);
}

function safeJson(obj) {
  try { return JSON.stringify(obj); } catch { return '{}'; }
}

// Provide a default export object for compatibility with `import templateParser from ...`
const __defaultExport = { parse, parseCatalog };
export default __defaultExport;
