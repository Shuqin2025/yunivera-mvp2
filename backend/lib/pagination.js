// backend/lib/pagination.js
import * as cheerio from "cheerio";

/** 绝对化 URL */
export function abs(base, href) {
  if (!href) return "";
  try { return new URL(href, base).href; } catch { return ""; }
}

/** 从 URL / 文本里尽量提取页码（没有就返回 1） */
export function extractPageIndex(u, txt = "") {
  try {
    const url = new URL(u, "http://x/");
    const q = url.searchParams;
    for (const k of ["page", "p", "seite", "pagina", "pg"]) {
      if (q.has(k)) {
        const n = parseInt(q.get(k), 10);
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
    const path = url.pathname || "";
    // /page/3  /p/2  /list_3.html
    let m =
      path.match(/(?:^|\/)(?:page|p|seite|pg)\/(\d+)(?:\/|$)/i) ||
      path.match(/[_-]([1-9]\d*)\.(?:html?|php)$/i);
    if (m) return parseInt(m[1], 10);
  } catch {}
  // 文本是数字也可作为提示
  const m2 = String(txt).trim().match(/^[1-9]\d*$/);
  if (m2) return parseInt(m2[0], 10);
  return 1;
}

/** 通过 DOM 找“下一页” */
export function findNextHref($, currentUrl) {
  let href =
    $('a[rel="next"]').attr("href") ||
    $(".pagination a.next,.pagination .next a,.page-numbers .next a,.pager .next a").attr("href") ||
    $(".pagination .next a,.page-numbers .next,.pager .next").attr("href") ||
    "";

  if (!href) {
    // 当前页 + 1
    const cur =
      extractPageIndex(currentUrl) ||
      extractPageIndex(
        currentUrl,
        $(".pagination .active,.page-numbers .current,.pager .active")
          .first()
          .text()
      );
    if (cur) {
      const $a = $(".pagination a,.page-numbers a,.pager a").filter(
        (_i, a) => extractPageIndex($(a).attr("href") || "", $(a).text()) === cur + 1
      );
      href = $a.first().attr("href") || "";
    }
  }
  href = abs(currentUrl, href);
  if (!href) return "";
  if (href === currentUrl) return "";
  return href;
}

/** 收集分页条上出现过的所有页链接 */
export function collectPagerHrefs($, currentUrl) {
  const set = new Set();
  const SEL =
    ".pagination a, .page-numbers a, .pager a, nav[role='navigation'] a, .paging a, .pages a";
  $(SEL).each((_i, a) => {
    const href = abs(currentUrl, $(a).attr("href") || "");
    const t = ($(a).text() || "").trim();
    if (!href) return;
    // 排除回到顶部/空链接等
    if (/^javascript:|^mailto:|#/.test(href)) return;
    // 必须能提取到正整数页码或与当前不同
    if (extractPageIndex(href, t) >= 1 || href !== currentUrl) set.add(href);
  });
  return Array.from(set);
}

/**
 * 统一分页：给出起始 URL 和抓取函数，按“下一页”滚动，最多 maxPages 页
 * fetchHtml: (url:string)=>Promise<string>
 */
export async function crawlPages(startUrl, fetchHtml, maxPages = 50) {
  const visited = new Set();
  const pages = [];

  let url = startUrl;
  for (let i = 0; i < maxPages && url; i++) {
    if (visited.has(url)) break;
    pages.push(url);
    visited.add(url);

    const html = await fetchHtml(url);
    const $ = cheerio.load(html, { decodeEntities: false });

    // 先尝试 rel=next / 下一页
    let next = findNextHref($, url);

    // 如果没拿到，尝试在分页条里找“更大的页码”
    if (!next) {
      const candidates = collectPagerHrefs($, url);
      const cur = extractPageIndex(url);
      const ordered = candidates
        .map((u) => ({ u, n: extractPageIndex(u) }))
        .sort((a, b) => a.n - b.n);
      const nextOne =
        ordered.find((x) => !visited.has(x.u) && x.n > cur) ||
        ordered.find((x) => !visited.has(x.u));
      next = nextOne ? nextOne.u : "";
    }

    if (!next) break;
    url = next;
  }
  return pages;
}
