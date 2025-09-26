// backend/adapters/sinotronic.js
// 站点适配：sinotronic-e.com 静态 HTML 列表页
// 说明：本适配器只做 DOM 解析，不发请求；由 routes/catalog.js 统一抓取与解码

const CONTAINER_CANDIDATES = ["#productlist", ".productlist", "main", "body"];
// 优先相对选择器，避免“容器内再找自己”；随后全局兜底
const ITEM_CANDIDATES = ["ul > li", "li", ".product", "#productlist ul > li"];

const toAbs = (u, base) => {
  if (!u) return "";
  try {
    return new URL(u, base).href;
  } catch {
    return u || "";
  }
};

const pickAttr = ($el, attrs) => {
  for (const k of attrs) {
    const v = $el.attr(k);
    if (v) return v;
  }
  return "";
};

function extractItems($, baseUrl, $items, limit, wantDebug, debugObj) {
  const items = [];

  $items.each((_, li) => {
    if (items.length >= limit) return false;

    const $li = $(li);

    const $img = $li.find("img").first();
    const imgRel = pickAttr($img, ["src", "data-src", "data-original"]);
    const img = toAbs(imgRel, baseUrl);

    const $a = $li.find("a[href]").first();
    const link = toAbs($a.attr("href") || "", baseUrl);

    const title =
      ($img.attr("alt") || "").trim() ||
      ($a.text() || "").trim() ||
      ($li.text() || "").trim();

    if (!title && !img && !link) return;

    items.push({
      sku: title,
      desc: title,
      minQty: "",
      price: "",
      img,
      link,
    });

    if (wantDebug && items.length === 1) {
      debugObj.first_item_html = $.html($li);
    }
  });

  return items;
}

export default {
  test(url) {
    return /https?:\/\/(www\.)?sinotronic-e\.com\//i.test(url);
  },

  /**
   * @param {$} $           cheerio 实例（调用方已抓取并解码）
   * @param {string} url    页面 URL
   * @param {object} opts   { limit?: number, debug?: boolean }
   */
  parse($, url, opts = {}) {
    const { limit = 50, debug: rawDebug = false } = opts;
    const wantDebug =
      rawDebug === 1 ||
      rawDebug === "1" ||
      String(rawDebug).toLowerCase() === "true";

    const debug = wantDebug
      ? { tried: { container: [], item: [] } }
      : undefined;

    // 1) 选容器
    let $ctn = $();
    let usedCtn = "";
    for (const sel of CONTAINER_CANDIDATES) {
      const cnt = $(sel).length;
      if (wantDebug) debug.tried.container.push({ selector: sel, matched: cnt });
      if (cnt) {
        $ctn = $(sel).first();
        usedCtn = sel;
        break;
      }
    }
    if (!$ctn.length) {
      $ctn = $("body");
      usedCtn = "body";
    }

    // 2) 选条目：容器内优先使用相对选择器；若没命中，再全局兜底
    let $items = $();
    let usedItemSel = "";
    for (const sel of ITEM_CANDIDATES) {
      let list = sel.startsWith("#") ? $(sel) : $ctn.find(sel);
      if (!list.length) list = $(sel);
      const cnt = list.length;
      if (wantDebug) debug.tried.item.push({ selector: sel, matched: cnt });
      if (cnt) {
        $items = list;
        usedItemSel = sel;
        break;
      }
    }

    if (wantDebug) {
      debug.container_matched = usedCtn;
      debug.item_selector_used = usedItemSel || "";
      debug.item_count = $items.length || 0;
    }

    // 3) 抽取
    const base = new URL(url).origin + "/";
    const items = extractItems($, base, $items, limit, wantDebug, debug || {});

    return {
      items,
      debugPart: wantDebug ? debug : undefined,
    };
  },
};
