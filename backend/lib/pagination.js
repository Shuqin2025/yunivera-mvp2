// backend/lib/pagination.js
import { URL } from "node:url";

/** 绝对化链接 */
export function abs(baseUrl, href) {
  try {
    if (!href) return "";
    return new URL(href, baseUrl).toString();
  } catch {
    return "";
  }
}

// 常见“下一页”文案/符号（多语言）
const NEXT_TEXT_RE =
  /(next|weiter|nächste|nächst|suivant|seguente|siguiente|дальше|вперёд|التالي|次へ|下一页|下一頁|下一步|下一|›|»)/i;

/** 1) rel=next / <link rel="next"> */
function byRel($) {
  return $('a[rel="next"]').attr("href") || $('link[rel="next"]').attr("href") || "";
}

/** 2) 常见选择器 + 文案判断（含 Shopware: .paging--link.is--next） */
function byCommonSelectors($) {
  const sel =
    ".pagination a.next, .pager a.next, .page-link.next, .paging--link.is--next, \
     .paging .next a, .pagination__next a, .pages-item-next a, .page-nav a.next, \
     .page-item.next a, nav.pagination a.next";
  let href = $(sel).first().attr("href") || "";

  if (!href) {
    href = $(".pagination a, .pager a, .page-link, .paging a, .pagination__link")
      .filter((_, a) => NEXT_TEXT_RE.test($(a).text().trim()))
      .first()
      .attr("href") || "";
  }
  return href;
}

/** 3) 数字页码：取“当前页+1”的 <a> */
function byNumeric($) {
  const activeText =
    $(".pagination .active, .pagination li.active a, .page-item.active a, \
      .paging--item.is--active a, .paging--item.is--active, .page-numbers .current")
      .first()
      .text()
      .trim();

  const cur = parseInt(activeText, 10);
  if (!cur) return "";

  const a = $(".pagination a, .pager a, .page-link, .paging a, .pagination__link, .page-numbers a")
    .filter((_, el) => parseInt($(el).text().trim(), 10) === cur + 1)
    .first();

  return a.attr("href") || "";
}

/** 4) URL 参数兜底：?p=2 / ?page=2 / ?sPage=2 / ?seite=2 */
function bumpPageParam(currentUrl, $) {
  const url = new URL(currentUrl, currentUrl);
  const keys = ["p", "page", "sPage", "Seite", "seite"]; // Shopware / 通用
  for (const k of keys) {
    const v = url.searchParams.get(k);
    if (v) {
      url.searchParams.set(k, String(parseInt(v, 10) + 1));
      return url.toString();
    }
  }
  // 如果有分页容器但没有任何参数，试探性设为 p=2（Shopware 常见）
  const hasPager = $(".pagination, .pager, .paging, .paging--container, .page-numbers").length > 0;
  if (hasPager && !url.searchParams.has("p")) {
    url.searchParams.set("p", "2");
    return url.toString();
  }
  return "";
}

/** 导出：查找下一页的绝对地址；visited 用于去重（Set） */
export function findNextPage($, currentUrl, visited = undefined) {
  let href = byRel($) || byCommonSelectors($);
  if (!href) href = byNumeric($);
  if (!href) href = bumpPageParam(currentUrl, $);
  if (!href) return "";

  const nextAbs = abs(currentUrl, href);
  if (visited && visited.has(nextAbs)) return "";
  return nextAbs;
}
