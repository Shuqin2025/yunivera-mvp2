// backend/adapters/sinotronic.js
// 站点专用适配器：sinotronic-e.com（静态 HTML，GB/UTF-8 均可能）
// 使用：由 /routes/catalog.js 调用

/**
 * 适配器对象
 * - test(url): 是否匹配该站点
 * - parse($, baseUrl, { limit, debug }): 解析并返回 { items, debugPart }
 */
const adapter = {
  name: 'sinotronic-e',

  test(url) {
    try {
      const u = new URL(url);
      return /(^|\.)sinotronic-e\.com$/i.test(u.hostname);
    } catch {
      return false;
    }
  },

  /**
   * @param {import('cheerio').CheerioAPI} $
   * @param {string} baseUrl
   * @param {{limit:number, debug:boolean}} options
   */
  parse($, baseUrl, { limit = 50, debug = false } = {}) {
    const tried = { container: [], item: [] };

    // 硬编码站点的首选容器 & 条目选择器
    const CONTAINER = '#productlist';
    const ITEM = '#productlist ul > li';

    tried.container.push(CONTAINER);

    let $container = $(CONTAINER);
    if ($container.length === 0) {
      // 如果意外没命中，也走兜底
      const C_FALLBACK = ['.productlist', '.list', '.listBox', '.products', '.product-list', 'body'];
      for (const c of C_FALLBACK) {
        tried.container.push(c);
        $container = $(c);
        if ($container.length) break;
      }
    }

    tried.item.push(ITEM);
    let $items = $container.find(ITEM);
    if ($items.length === 0) {
      // 兜底条目选择器（尽量泛化）
      const I_FALLBACK = [
        'ul > li',
        'li',
        '.product',
        '.product-item',
        '.productItem',
        '.product-box',
      ];
      for (const s of I_FALLBACK) {
        tried.item.push(s);
        $items = $container.find(s);
        if ($items.length) break;
      }
    }

    const absolutize = (href) => {
      if (!href) return '';
      try { return new URL(href, baseUrl).href; } catch { return href; }
    };

    const items = [];
    $items.each((i, el) => {
      if (items.length >= limit) return false;

      const $el = $(el);

      // 链接：优先第一个 a 的 href
      const $a = $el.find('a').first();
      const link = absolutize($a.attr('href'));

      // 图片：优先 a>img[src]，否则 li 内任意 img[src]
      let $img = $el.find('a img[src]').first();
      if ($img.length === 0) $img = $el.find('img[src]').first();
      const img = absolutize($img.attr('src'));

      // 标题：优先 img@alt，其次 a>h3 文本，再其次第一个 a 的文本
      let title = ($img.attr('alt') || '').trim();
      if (!title) title = ($el.find('a h3').first().text() || '').trim();
      if (!title) title = ($a.text() || '').trim();

      // sku：沿用 title 作为 sku
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
          item_selector_used: tried.item[tried.item.length - 1] || ITEM,
          item_count: $items.length,
          first_item_html: $items.first().html() || null,
          tried,
        }
      : undefined;

    return { items, debugPart };
  },
};

export default adapter;
