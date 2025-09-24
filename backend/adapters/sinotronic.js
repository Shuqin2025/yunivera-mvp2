// backend/adapters/sinotronic.js
import axios from "axios";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import jschardet from "jschardet";

/** 这个适配器是否匹配该域名 */
export function matches(url) {
  return /(^|\.)sinotronic-e\.com/i.test(new URL(url).hostname);
}

function normalizeCharset(s) {
  if (!s) return "utf-8";
  s = s.toLowerCase();
  if (s.includes("gb2312") || s.includes("gbk")) return "gbk";
  if (s.includes("big5")) return "big5";
  return "utf-8";
}

/** 把相对地址转绝对 */
function abs(base, maybeRelative) {
  if (!maybeRelative) return "";
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return maybeRelative;
  }
}

/** 挑一个非空的字段 */
function pick(...xs) {
  for (const x of xs) if (x && String(x).trim()) return String(x).trim();
  return "";
}

/** 取图片字段（兼容懒加载） */
function pickImg($el) {
  return (
    $el.attr("src") ||
    $el.attr("data-src") ||
    $el.attr("data-original") ||
    $el.attr("data-lazy") ||
    ""
  );
}

/** 拉取并自动按 charset 解码为字符串 */
async function fetchHtml(url) {
  const res = await axios.get(url, {
    responseType: "arraybuffer",
    headers: {
      // 给点像浏览器的头，减少被挡的概率
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      Referer: new URL(url).origin + "/",
    },
    // 适度超时，避免长时间挂起
    timeout: 20000,
    validateStatus: () => true,
  });

  const buf = Buffer.from(res.data);
  let charset =
    normalizeCharset(res.headers["content-type"] || "") ||
    normalizeCharset("");

  // headers 没带就用内容探测
  if (charset === "utf-8") {
    try {
      const head = buf.slice(0, 4096).toString("ascii");
      const m =
        head.match(/<meta[^>]+charset=["']?([\w-]+)["']?/i) ||
        head.match(/charset=([\w-]+)/i);
      if (m) charset = normalizeCharset(m[1]);
    } catch {}
  }
  if (charset === "utf-8") {
    // 兜底再探测一次
    try {
      const det = jschardet.detect(buf);
      if (det && det.encoding) charset = normalizeCharset(det.encoding);
    } catch {}
  }

  const html = iconv.decode(buf, charset || "utf-8");
  return { html, status: res.status, charset };
}

/** 解析列表页 */
export async function parse(url, { limit = 50 } = {}) {
  const { html } = await fetchHtml(url);
  const $ = cheerio.load(html, { decodeEntities: false });

  const items = [];

  // 1) 主选择器：官方列表容器
  $("#productlist li").each((_, li) => {
    const $li = $(li);
    const $a = $li.find("a").first();
    const $img = $li.find("img").first();

    const link = abs(url, $a.attr("href"));
    const img = abs(url, pickImg($img));
    const title = pick(
      $img.attr("alt"),
      $img.attr("title"),
      $a.attr("title"),
      $a.text()
    );

    if (title || img || link) {
      items.push({
        sku: title, // SKU/名称：该站并无明确货号，只能用标题
        desc: "", // 该站列表也无描述，保持空
        img,
        link,
        minQty: "",
        price: "",
      });
    }
  });

  // 2) 备选结构（有些频道模板不同）
  if (items.length === 0) {
    $(".productlist li, .proList li, .product_item").each((_, li) => {
      const $li = $(li);
      const $a = $li.find("a").first();
      const $img = $li.find("img").first();

      const link = abs(url, $a.attr("href"));
      const img = abs(url, pickImg($img));
      const title = pick(
        $img.attr("alt"),
        $img.attr("title"),
        $a.attr("title"),
        $a.text(),
        $li.find("h3,h4").first().text()
      );

      if (title || img || link) {
        items.push({
          sku: title,
          desc: "",
          img,
          link,
          minQty: "",
          price: "",
        });
      }
    });
  }

  // 限制数量
  const out = items.slice(0, Math.max(1, Number(limit) || 50));
  return { ok: true, url, count: out.length, items: out };
}

// 统一导出给路由用
export default { matches, parse };
