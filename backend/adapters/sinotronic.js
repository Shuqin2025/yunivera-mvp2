// adapters/sinotronic.js
import fetch from "node-fetch";
import iconv from "iconv-lite";
import * as cheerio from "cheerio";
import { URL as NodeURL } from "url";

function detectEncoding(headBuf) {
  // 只扫前 2KB 查 meta charset，找不到就默认 utf-8
  const s = headBuf.toString("ascii").toLowerCase();
  const m = s.match(/charset=["']?([\w-]+)/i);
  if (!m) return "utf-8";
  const enc = m[1].replace(/_/g, "-");
  // 常见别名统一
  if (enc === "gb2312" || enc === "gbk") return "gbk";
  return enc;
}

function abs(base, maybe) {
  if (!maybe) return "";
  try {
    return new NodeURL(maybe, base).href;
  } catch {
    return maybe;
  }
}

/**
 * 解析 sinotronic-e 的目录页（也可作为通用静态列表兜底）
 * @param {string} url
 * @param {number} limit
 * @returns {Promise<{items: Array}>}
 */
export async function parse(url, limit = 50) {
  const ua =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
  const res = await fetch(url, {
    headers: {
      "user-agent": ua,
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      "cache-control": "no-cache",
      pragma: "no-cache",
    },
  });
  if (!res.ok) {
    throw new Error(`fetch page ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const enc = detectEncoding(buf.subarray(0, 2048));
  const html = iconv.decode(buf, enc);

  const $ = cheerio.load(html);
  const items = [];

  // 尝试一些常见列表结构
  // 1) 任意带图片的 <a>
  $("a:has(img)").each((_, a) => {
    if (items.length >= limit) return false;
    const $a = $(a);
    const $img = $a.find("img").first();
    const title =
      ($a.attr("title") || $img.attr("alt") || $a.text() || "").trim();
    const href = abs(url, $a.attr("href"));
    const img =
      abs(url, $img.attr("data-src")) || abs(url, $img.attr("src")) || "";
    // 极端情况下 title 为空就跳过
    if (!title && !href) return;
    items.push({
      sku: title,          // 作为“货号/名称”
      desc: "",            // 暂无可用描述就留空
      minQty: "",          // 起订量未知留空
      price: "",           // 单价未知留空
      img,
      link: href,
    });
  });

  // 2) 如果还没抓到，兜底再找带文本的 <li>/<div> 里的链接
  if (items.length === 0) {
    $("li a, .product a, .list a").each((_, a) => {
      if (items.length >= limit) return false;
      const $a = $(a);
      const text = ($a.attr("title") || $a.text() || "").trim();
      const href = abs(url, $a.attr("href"));
      if (!text || !href) return;
      items.push({
        sku: text,
        desc: "",
        minQty: "",
        price: "",
        img: "",
        link: href,
      });
    });
  }

  return { items };
}
