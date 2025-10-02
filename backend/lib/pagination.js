// backend/lib/pagination.js
// 更鲁棒的自动翻页：支持 ?p=2 / ?page=2 / ?seite=2 / /page/2 / /p/2 / /seite/2
// 并回退到 rel=next / 常见分页容器；默认仅在同一路径下前进，避免串类目

import * as cheerio from "cheerio";

const PAGE_KEYS = ["p", "page", "seite", "pg", "pagina", "sayfa"];

function toAbs(baseUrl, href) {
  if (!href) return "";
  try { return new URL(href, baseUrl).href; } catch { return String(href || ""); }
}

export function extractPageNumber(u) {
  try {
    const url = new URL(u);
    // 1) ?p=2 / ?page=2 / ?seite=2 ...
    for (const k of PAGE_KEYS) {
      const v = url.searchParams.get(k);
      const n = v && /^\d+$/.test(v) ? parseInt(v, 10) : 0;
      if (n > 0) return n;
    }
    // 2) /page/2 / /p/2 / /seite/2
    const m = url.pathname.match(/(?:^|\/)(?:page|p|seite|pg|pagina|sayfa)\/(\d+)(?:\/|$)/i);
    if (m) return parseInt(m[1], 10) || 0;

    return 0;
  } catch {
    return 0;
  }
}

function samePath(u1, u2) {
  try {
    const a = new URL(u1);
    const b = new URL(u2);
    return a.origin === b.origin && a.pathname === b.pathname;
  } catch {
    return false;
  }
}

/**
 * 在当前页面里寻找“下一页”的绝对地址
 */
export function findNextPageUrl($, currentUrl, opts = {}) {
  const { samePathOnly = true, debug = false } = opts;
  const currentNum = extractPageNumber(currentUrl);
  const pathLock = new URL(currentUrl).pathname;

  const log = (...args) => { if (debug) console.log("[pagination]", ...args); };

  // 0) rel=next
  const relNext =
    $('a[rel="next"]').attr("href") ||
    $('link[rel="next"]').attr("href") ||
    "";
  if (relNext) {
    const abs = toAbs(currentUrl, relNext);
    if (!samePathOnly || samePath(abs, currentUrl)) {
      log("rel=next ->", abs);
      return abs;
    }
  }

  // 1) 常见容器
  const CTN = [
    "nav.pagination", ".pagination", ".paging", ".paginator",
    ".page-numbers", ".listing-pagination", ".cms-element-pagination",
    ".pager", ".cate-paging", ".product-pager"
  ].join(", ");

  let containerLinks = [];
  $(CTN).find('a[href]').each((_i, a) => {
    const abs = toAbs(currentUrl, $(a).attr("href"));
    containerLinks.push(abs);
  });

  // 2) 全链路扫描（兜底）
  if (containerLinks.length === 0) {
    $('a[href]').each((_i, a) => {
      const abs = toAbs(currentUrl, $(a).attr("href"));
      containerLinks.push(abs);
    });
  }

  // 3) 把所有链接解析成 (url,pageNum)，过滤不同路径/无页码的
  const candidates = [];
  for (const href of containerLinks) {
    if (!href) continue;
    if (samePathOnly) {
      try {
        if (new URL(href).pathname !== pathLock) continue;
      } catch { continue; }
    }
    const n = extractPageNumber(href);
    if (n > 0) candidates.push({ href, n });
  }

  if (candidates.length === 0) {
    log("no candidates");
    return "";
  }

  // 4) 选择 current+1；若没有 current（=0），则取最小 >=2
  const target = (currentNum > 0)
    ? candidates
        .filter(c => c.n > currentNum)
        .sort((a, b) => a.n - b.n)[0]
    : candidates
        .filter(c => c.n >= 2)
        .sort((a, b) => a.n - b.n)[0];

  if (target) {
    log("next ->", target.n, target.href);
    return target.href;
  }

  log("no next");
  return "";
}

/**
 * 统一的“翻页抓取框架”
 * @param {*} startHtml  首页 HTML
 * @param {*} startUrl   首页 URL
 * @param {*} maxPages   保护上限（默认 15）
 * @param {*} limit      需要的最大条数
 * @param {*} parseFn    ( $, pageUrl ) => items[]
 * @param {*} fetchFn    ( url ) => Promise<html>
 */
export async function crawlPages(startHtml, startUrl, maxPages = 15, limit = 200, parseFn, fetchFn, opts = {}) {
  const out = [];
  const visited = new Set([startUrl]);

  let $ = cheerio.load(startHtml, { decodeEntities: false });
  let pageUrl = startUrl;

  for (let i = 0; i < maxPages && out.length < limit; i++) {
    // 抽取数据（不更改 parseFn 的签名）
    const part = parseFn($, pageUrl) || [];
    for (const it of part) {
      if (out.length >= limit) break;
      out.push(it);
    }
    if (out.length >= limit) break;

    const next = findNextPageUrl($, pageUrl, opts);
    if (!next || visited.has(next)) break;

    visited.add(next);
    const html = await fetchFn(next);
    $ = cheerio.load(html, { decodeEntities: false });
    pageUrl = next;
  }

  return out;
}
