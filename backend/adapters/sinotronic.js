// backend/adapters/sinotronic.js
// 适配 http://www.sinotronic-e.com/ 这类纯静态 HTML（GBK/GB2312）列表页

const axios = require("axios");
const cheerio = require("cheerio");
const jschardet = require("jschardet");
const iconv = require("iconv-lite");
const { URL } = require("url");

// 让路由判断是否用本适配器
function canHandle(inputUrl = "") {
  try {
    const u = new URL(inputUrl);
    return /(^|\.)sinotronic-e\.com$/i.test(u.hostname);
  } catch {
    return false;
  }
}

async function fetchHtmlWithDecode(url) {
  const resp = await axios.get(url, {
    responseType: "arraybuffer",
    headers: {
      // 有些站按 Accept-Language/UA 做分发，给个常见头更稳
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
    timeout: 20000,
    validateStatus: s => s >= 200 && s < 400,
  });

  const buf = Buffer.from(resp.data);
  let enc = "utf-8";
  const det = jschardet.detect(buf);
  if (det && det.encoding) {
    const e = det.encoding.toLowerCase();
    if (e.includes("gb")) {
      enc = "gb18030"; // 统一用 gb18030 能覆盖 gbk/gb2312
    } else if (e.includes("utf")) {
      enc = "utf-8";
    }
  }
  const html = iconv.decode(buf, enc);
  return { html, encoding: enc, status: resp.status };
}

function absolutize(base, maybe) {
  if (!maybe) return "";
  try {
    return new URL(maybe, base).href;
  } catch {
    return "";
  }
}

function textNorm(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

async function parse(inputUrl, options = {}) {
  const {
    limit = 50,
    img = "url",       // 与现有前端兼容，默认返回图片 URL；若以后要 base64，可在此扩展
    imgCount = 5,      // 预留
    debug = false,
  } = options;

  const dbg = {
    tried: { container: [], item: [] },
    detected_encoding: "",
    container_matched: "",
    item_selector_used: "",
    first_item_html: "",
    item_count: 0,
  };

  const { html, encoding } = await fetchHtmlWithDecode(inputUrl);
  dbg.detected_encoding = encoding;

  const $ = cheerio.load(html, { decodeEntities: false });

  // —— 1) 容器兜底（把你们核对的放在最前）——
  const CONTAINERS = [
    "#productlist",            // 你们实测命中
    ".productlist",
    "#productList",
    ".product-list",
    ".list", ".lists", ".contentlist",
    "ul.prolist", "ul.products",
    ".editor#productlist",     // 防御性再加一条
  ];
  // —— 2) 条目兜底 ——（优先你给的）
  const ITEM_FALLBACK = [
    "#productlist ul > li",    // 你们实测命中
    "ul > li",
    ".product", ".product_item", ".product-box", ".productbox",
    ".list-item", ".pro-item", ".item",
  ];

  // 先找到容器
  let $container = null;
  for (const sel of CONTAINERS) {
    dbg.tried.container.push(sel);
    const hit = $(sel);
    if (hit && hit.length) {
      $container = hit.first();
      dbg.container_matched = sel;
      break;
    }
  }
  // 找不到容器，直接兜底：整个文档
  if (!$container) {
    $container = $("body");
    dbg.container_matched = "body";
  }

  // 在容器内尝试条目
  let $items = $();
  for (const isel of ITEM_FALLBACK) {
    dbg.tried.item.push(isel);
    const found = $container.find(isel);
    if (found && found.length) {
      $items = found;
      dbg.item_selector_used = isel;
      break;
    }
  }
  if (!$items || !$items.length) {
    // 再兜底一层：容器里的所有 li
    const fallback = $container.find("li");
    if (fallback && fallback.length) {
      $items = fallback;
      dbg.item_selector_used = "li (fallback)";
    }
  }

  const out = [];
  const base = new URL(inputUrl).origin;

  $items.each((i, el) => {
    if (out.length >= Number(limit || 50)) return false;

    const $it = $(el);
    if (!dbg.first_item_html) {
      dbg.first_item_html = $.html($it).slice(0, 2000);
    }

    // 链接
    const $a = $it.find("a").first();
    const href = absolutize(base, $a.attr("href") || "");

    // 图片（普通/懒加载）
    const $img = $it.find("img").first();
    let imgSrc =
      $img.attr("src") ||
      $img.attr("data-src") ||
      $img.attr("data-original") ||
      "";
    imgSrc = absolutize(base, imgSrc);

    // 文本/标题/货号
    const title = textNorm(
      $img.attr("alt") ||
      $a.attr("title") ||
      $a.text() ||
      $it.find("h3,h4,h5").first().text() ||
      $it.text()
    );

    // 简单抓价（不保证每站适配）
    const priceMatch = ($it.text() || "").match(
      /([€$]?\s*\d+[.,]?\d*)/ // 简单抠一个示意
    );
    const price = priceMatch ? textNorm(priceMatch[1]) : "";

    // 起订量（留空，避免误判）
    const minQty = "";

    out.push({
      sku: title,
      desc: title,
      minQty,
      price,
      img: imgSrc, // 目前返回 URL
      link: href || inputUrl,
    });
  });

  dbg.item_count = out.length;

  const payload = {
    ok: true,
    url: inputUrl,
    products: [],
    items: out,
  };
  if (debug) payload.debug = dbg;
  return payload;
}

module.exports = {
  canHandle,
  parse: parse,
};
