// backend/lib/pagination.js  (ESM)
import * as cheerio from "cheerio";

/** 将相对链接转成绝对链接（不依赖 http.js） */
function absUrl(base, href) {
  if (!href) return "";
  try {
    return new URL(href, base).href;
  } catch {
    return "";
  }
}

/** 常见“下一页”文案（多语言） */
const NEXT_TEXT_RE =
  /(next|weiter|nächste|naechste|siguiente|suivant|следующ|próxima|proxima|volgende|seguinte|下一页|下一頁|下页|下一步|次へ|다음)/i;

/**
 * 在页面中寻找“下一页”的绝对地址
 * @param {cheerio.CheerioAPI} $
 * @param {string} currentUrl
 * @returns {string} next absolute url or "" if not found
 */
export function findNextHref($, currentUrl) {
  // 1) rel="next" / 常见 class
  let href =
    $('a[rel="next"]').attr("href") ||
    $(".pagination a.next, .pager a.next, .page-link.next, .paginator__next, .pagination__next")
      .first()
      .attr("href") ||
    // 2) 文案匹配（多语言）
    $("a")
      .filter((_, a) => NEXT_TEXT_RE.test($(a).text().trim()))
      .first()
      .attr("href");

  // 3) 数字分页兜底（当前页 + 1）
  if (!href) {
    const cur =
      parseInt(
        $(
          ".pagination .active, .pagination li.active a, .page-item.active a, .pages .current, .pager .current, .pagination__link--current"
        )
          .first()
          .text()
          .trim(),
        10
      ) || 0;

    if (cur > 0) {
      const a = $(".pagination a, .pages a, .pager a").filter(
        (_, el) => parseInt($(el).text().trim(), 10) === cur + 1
      );
      if (a.length) href = a.first().attr("href");
    }
  }

  if (!href) return "";
  const url = absUrl(currentUrl, href);
  if (!url || url === currentUrl) return "";
  return url;
}

/**
 * 通用分页抓取
 * @param {string} startUrl
 * @param {number} limit
 * @param {( $:cheerio.CheerioAPI, url:string, push:(item:any)=>void )=>Promise<void>|void} parsePage
 * @param {(url:string)=>Promise<string>} fetchHtml
 * @param {{maxPages?:number}} [opts]
 * @returns {Promise<any[]>}
 */
export async function crawlPages(startUrl, limit, parsePage, fetchHtml, opts = {}) {
  const maxPages = Math.max(1, opts.maxPages ?? 50);
  const visited = new Set();
  const out = [];

  let url = startUrl;
  let page = 0;

  while (url && !visited.has(url) && out.length < limit && page < maxPages) {
    visited.add(url);
    page++;

    const html = await fetchHtml(url);
    const $ = cheerio.load(html, { decodeEntities: false });

    // 解析当前页
    await Promise.resolve(
      parsePage($, url, (item) => {
        if (item && out.length < limit) out.push(item);
      })
    );

    if (out.length >= limit) break;

    // 下一页
    const next = findNextHref($, url);
    if (!next) break;
    url = next;
  }

  return out;
}

// 兼容：既导出具名，也导出默认
export default crawlPages;
