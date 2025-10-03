// backend/lib/pagination.js
// 通用自动翻页工具：优先找“下一页”选择器；不行就数字翻页；还不行就 ?p=/page= 参数推断。
// 所有返回的链接统一绝对化，避免相对路径循环。

import * as cheerio from "cheerio";

// “下一页”常见词（多语种）
const TEXT_NEXT_RE =
  /(next|weiter|nächste|nächster|more|次へ|下一页|下一頁|下ー步|后页|»|›|»»|››)$/i;

// 常见分页容器选择器
const PAGINATION_CTNS = [
  ".pagination",
  ".pager",
  ".page",
  ".paging",
  ".nav-pages",
  "nav[aria-label*=Pagination i]",
  'ul[role="presentation"]',
];

// 绝对化
function abs(base, href) {
  if (!href) return "";
  try {
    return new URL(href, base).href;
  } catch {
    return "";
  }
}

// ------- 默认的“找下一页”实现 -------
export function defaultFindNext($, currentUrl) {
  // 1) rel=next
  let href =
    $('a[rel="next"]').attr("href") ||
    // 2) 容器内文字匹配（Next / 下一页 / ›› 等）
    $(PAGINATION_CTNS.join(","))
      .find("a")
      .filter((_, a) => TEXT_NEXT_RE.test($(a).text().trim()))
      .first()
      .attr("href");

  if (href) return abs(currentUrl, href);

  // 3) 数字翻页：当前页 + 1
  // 常见：li.active > a 或 .pagination .active a
  const cur =
    parseInt(
      $(
        ".pagination .active a, .pagination li.active a, .pager .active a, .page .active a, .paging .active a"
      )
        .first()
        .text()
        .trim(),
      10
    ) || 0;

  if (cur > 0) {
    // 在容器中找 “等于 cur+1 的页码链接”
    const $a = $(PAGINATION_CTNS.join(","))
      .find("a")
      .filter((_, a) => parseInt($(a).text().trim(), 10) === cur + 1)
      .first();

    if ($a.length) {
      href = $a.attr("href");
      if (href) return abs(currentUrl, href);
    }
  }

  // 4) 参数猜测：?page= 或 ?p=
  try {
    const u = new URL(currentUrl);
    const guessKeys = ["page", "p"];
    for (const k of guessKeys) {
      const v = parseInt(u.searchParams.get(k) || "0", 10);
      if (v > 0) {
        u.searchParams.set(k, String(v + 1));
        return u.href;
      }
    }
  } catch {
    // ignore
  }

  return "";
}

// ------- 核心翻页函数（供 universal.js 调用）-------
/**
 * 跨页抓取工具
 * @param {Object} opts
 * @param {Function} opts.fetchHtml  - async (url) => string
 * @param {string}   opts.startUrl   - 起始列表页 URL
 * @param {number}   [opts.limit=50] - 最多返回的 item 条数
 * @param {number}   [opts.maxPages=50] - 最多翻页次数（保险上限）
 * @param {Function} opts.extractFromPage - async ($, url, remain) => array  从当前页提取 items
 * @param {Function} [opts.findNext] - 自定义“找下一页”函数，默认 defaultFindNext
 * @returns {Promise<Array>} items
 */
export async function crawlPages(opts) {
  const {
    fetchHtml,
    startUrl,
    limit = 50,
    maxPages = 50,
    extractFromPage,
    findNext = defaultFindNext,
  } = opts || {};

  if (!fetchHtml) throw new Error("crawlPages: fetchHtml is required");
  if (!startUrl) throw new Error("crawlPages: startUrl is required");
  if (!extractFromPage) throw new Error("crawlPages: extractFromPage is required");

  const visited = new Set();
  let pageUrl = startUrl;
  const out = [];

  for (let p = 1; p <= maxPages && out.length < limit && pageUrl; p++) {
    if (visited.has(pageUrl)) break;
    visited.add(pageUrl);

    const html = await fetchHtml(pageUrl);
    const $ = cheerio.load(html, { decodeEntities: false });

    const remain = limit - out.length;
    const part = (await extractFromPage($, pageUrl, remain)) || [];
    if (Array.isArray(part) && part.length) out.push(...part.slice(0, remain));

    if (out.length >= limit) break;

    const nextUrl = findNext($, pageUrl);
    if (!nextUrl || visited.has(nextUrl)) break;

    pageUrl = nextUrl;
  }

  return out;
}
