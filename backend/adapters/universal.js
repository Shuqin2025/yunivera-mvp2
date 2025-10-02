export default async function parseUniversal({ url, limit=60, debug=false }) {
  const { html, finalUrl } = await fetchHtml(url);
  const $ = cheerio.load(html, { decodeEntities:false });

  // 1) 先试结构化数据（快）
  const sd = readStructuredData($, finalUrl);
  let items = (sd.list?.length ? sd.list : []) || [];

  // 2) 列表启发式（选常见容器 + 常见 item 卡片）
  if (items.length === 0) {
    const cands = [
      '.product-list, .products, .catalog-list, .listing, .product-grid, .category-products',
      '.product, .product-item, .product-box, .box-product, li.product'
    ];
    const $ctn = $(cands[0]).length ? $(cands[0]) : $('body');
    $ctn.find(cands[1]).each((i, el) => {
      const $it = $(el);
      const link = abs(finalUrl, $it.find('a[href]').first().attr('href') || '');
      const title = ($it.find('h3,h2,.title,.product-title').first().text() || '').trim();
      const img = pickImage($it, finalUrl);
      const priceTxt = $it.find('.price, .product-price, [itemprop=price]').first().text();
      const price = normalizePrice(priceTxt);
      if (link || title) items.push({ link, title, img, price });
    });
  }

  // 3) 分页
  const pages = await enumeratePages($, finalUrl, limit);
  for (let i=1; i<pages.length && items.length<limit; i++) {
    const { html } = await fetchHtml(pages[i]);
    const $$ = cheerio.load(html, { decodeEntities:false });
    // 重复 1)+2) 的过程（可封装成函数）
    items.push(.../* parse page items ... */);
    items = dedupe(items);
  }

  // 4) 详情页富化（缺关键字段时才开）
  if (needEnrich(items)) {
    items = await enrichByDetails(items, { concurrency:4 });
  }

  // 5) 截断 & 返回
  return items.slice(0, limit);
}
