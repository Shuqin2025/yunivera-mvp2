// backend/lib/pagination.js
// 通用自动翻页工具：优先找“下一页”链接；不行就数字翻页；还不行就 ?p=/page= 参数推断。
// 所有返回的链接统一绝对化，避免相对路径循环。

import * as cheerio from "cheerio";
const TEXT_NEXT_RE = /^(next|weiter|nächste|nächster|n\u00E4chste|more|次へ|下一页|下一頁|下一步|后页|›|»|→)$/i;
const PAGINATION_CTNS = [
  ".pagination",
  ".pager",
  ".page",
  ".paging",
  ".nav-pages",
  "nav[aria-label*=Pagination i]",
  "ul[role=presentation]",
];

function abs(base, href) {
  try { return new URL(href, base).href; } catch { return href || ""; }
}

// 1) 直接找 rel=next / 常见“下一页”文案
function findByRelOrText($, baseUrl) {
  const a1 = $("a[rel='next']").attr("href");
  if (a1) return abs(baseUrl, a1);

  const candidates = [];
  PAGINATION_CTNS.forEach(sel => {
    $(sel).find("a").each((_, a) => candidates.push(a));
  });
  if (!candidates.length) $("a").each((_, a) => candidates.push(a));

  for (const a of candidates) {
    const $a = $(a);
    const txt = ($a.text() || $a.attr("aria-label") || "").trim();
    if (TEXT_NEXT_RE.test(txt)) return abs(baseUrl, $a.attr("href"));
  }
  return "";
}

// 2) 数字翻页：当前页数字 + 1
function findByNumber($, baseUrl) {
  // 常见当前页标记
  const currentText =
    $(".pagination .active, .pagination li.active, .pager .active, .page .active, .paging .active, li.is--active, li.active")
      .first()
      .text()
      .trim() || $("li[aria-current='page']").first().text().trim();

  const cur = parseInt(currentText, 10);
  if (!cur || Number.isNaN(cur)) return "";

  // 在同一分页容器里找“cur+1”的链接
  const containers = $(PAGINATION_CTNS.join(", "));
  const scope = containers.length ? containers : $;
  let href = "";
  scope.find("a").each((_, a) => {
    if (href) return;
    const t = ($(a).text() || "").trim();
    if (parseInt(t, 10) === cur + 1) href = $(a).attr("href") || "";
  });
  return href ? abs(baseUrl, href) : "";
}

// 3) 参数推断：?p= / &p= / ?page=
function findByQueryParam($, baseUrl) {
  const paramNames = ["p", "page", "seite", "pg"];
  const url = new URL(baseUrl);

  // 先看看页面里是否存在带这些参数的链接
  const hrefs = new Set();
  $("a[href]").each((_, a) => {
    const h = abs(baseUrl, $(a).attr("href"));
    try {
      const u = new URL(h);
      for (const name of paramNames) {
        if (u.searchParams.has(name)) hrefs.add(name);
      }
    } catch {}
  });

  // 候选（页面里见过的优先；否则通用名也试）
  const tryNames = [...hrefs, ...paramNames];

  for (const name of tryNames) {
    // 以当前 URL 为基准
    const u = new URL(baseUrl);
    const cur = parseInt(u.searchParams.get(name) || "1", 10) || 1;
    u.searchParams.set(name, String(cur + 1));
    // 防止出现重复参数
    const next = u.href.replace(new RegExp(`([?&])${name}=\\d+&${name}=\\d+`), `$1${name}=${cur+1}`);
    return next;
  }
  return "";
}

// 4) 静态文件名推断（list_2.html、_3.html、/page/2/）
function findByPathPattern(baseUrl) {
  const u = new URL(baseUrl);
  const pathname = u.pathname;

  // a) ...list_1.html → list_2.html
  const mList = pathname.match(/(.*?_)(\d+)(\.html?)$/i);
  if (mList) {
    const next = mList[1] + (parseInt(mList[2], 10) + 1) + mList[3];
    u.pathname = next;
    return u.href;
  }

  // b) .../page/1/ → /page/2/
  const mPage = pathname.match(/(.*?\/page\/)(\d+)(\/.*)?$/i);
  if (mPage) {
    u.pathname = `${mPage[1]}${parseInt(mPage[2], 10) + 1}${mPage[3] || ""}`;
    return u.href;
  }

  return "";
}

export function nextPageUrl($, baseUrl) {
  return (
    findByRelOrText($, baseUrl) ||
    findByNumber($, baseUrl) ||
    findByQueryParam($, baseUrl) ||
    findByPathPattern(baseUrl) ||
    ""
  );
}

// 通用自动翻页：传入 fetchHtml 与一个“单页解析器 parsePage($)”。
export async function autoPaginate({ startUrl, limit = 200, fetchHtml, parsePage, cheerioInstance = cheerio }) {
  const visited = new Set();
  const out = [];
  let url = startUrl;

  while (url && !visited.has(url) && out.length < limit) {
    visited.add(url);

    const html = await fetchHtml(url);
    const $ = cheerioInstance.load(html, { decodeEntities: false });

    // 单页解析
    const part = (await parsePage($, url)) || [];
    for (const it of part) {
      if (out.length >= limit) break;
      out.push(it);
    }
    if (out.length >= limit) break;

    // 下一页
    const next = nextPageUrl($, url);
    if (!next || visited.has(next)) break;
    url = next;
  }

  return out.slice(0, limit);
}
