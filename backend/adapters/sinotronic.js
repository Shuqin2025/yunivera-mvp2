// backend/adapters/sinotronic.js
// 站点适配：sinotronic-e.com 静态 HTML 列表页
// 功能：gb18030 解码 + 兜底选择器 + debug

import axios from "axios";
import { load as cheerioLoad } from "cheerio";
import jschardet from "jschardet";
import iconv from "iconv-lite";

const toAbs = (u, base) => {
  try { return new URL(u, base).href; } catch { return u || ""; }
};

const pickAttr = ($el, list) => {
  for (const k of list) {
    const v = $el.attr(k);
    if (v) return v;
  }
  return "";
};

const decodeBuffer = (buf) => {
  const head = buf.subarray(0, Math.min(buf.length, 2048));
  const guess = jschardet.detect(head)?.encoding || "";
  const enc = /gb/i.test(guess) ? "gb18030" : "utf-8";
  const html = iconv.decode(buf, enc);
  return { html, encoding: enc, guess };
};

const CONTAINER_CANDIDATES = ["#productlist", ".productlist", "main", "body"];
const ITEM_CANDIDATES      = ["#productlist ul > li", ".product", "li"];

function extractItems($, base, $items, limit, debug) {
  const items = [];
  $items.each((_, el) => {
    if (items.length >= limit) return;

    const $li  = $(el);
    const $img = $li.find("img").first();
    const imgRel = pickAttr($img, ["src", "data-src", "data-original"]);
    const img    = toAbs(imgRel, base);

    const $a   = $li.find("a").first();
    const link = toAbs($a.attr("href") || "", base);

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

    if (debug && items.length === 1) {
      debug.first_item_html = $.html($li);
    }
  });
  return items;
}

export default async function parseSinotronic(url, opts = {}) {
  const {
    limit = 50,
    img = "",
    imgCount = 0,
    debug: rawDebug = false,
  } = opts;

  const wantBase64 = String(img).toLowerCase() === "base64";
  const wantDebug  = ["1","true","yes","on", "true"].includes(String(rawDebug).toLowerCase());

  const resp = await axios.get(url, {
    responseType: "arraybuffer",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  const { html, encoding, guess } = decodeBuffer(Buffer.from(resp.data));
  const $ = cheerioLoad(html, { decodeEntities: false });

  const debug = wantDebug ? {
    tried: { container: [], item: [] },
    detected_encoding: encoding,
    charset_guess: guess || ""
  } : null;

  // 选容器
  let $ctn = null;
  let usedCtn = "";
  for (const sel of CONTAINER_CANDIDATES) {
    const cnt = $(sel).length;
    if (wantDebug) debug.tried.container.push({ selector: sel, matched: cnt });
    if (cnt) { $ctn = $(sel).first(); usedCtn = sel; break; }
  }
  if (!$ctn) { $ctn = $("body"); usedCtn = "body"; }

  // 选条目
  let $items = $();
  let usedItemSel = "";
  for (const sel of ITEM_CANDIDATES) {
    const list = $ctn.find(sel);
    const cnt  = list.length;
    if (wantDebug) debug.tried.item.push({ selector: sel, matched: cnt });
    if (cnt) { $items = list; usedItemSel = sel; break; }
  }
  if (!$items.length) {
    const list = $("#productlist ul > li");
    if (list.length) { $items = list; usedItemSel = "#productlist ul > li (fallback)"; }
  }

  if (wantDebug) {
    debug.container_matched  = usedCtn;
    debug.item_selector_used = usedItemSel;
    debug.item_count         = $items.length || 0;
  }

  // 抽取
  const origin = new URL(url).origin + "/";
  let items = extractItems($, origin, $items, limit, debug);

  // 可选：转 base64（默认关闭）
  if (wantBase64 && items.length && imgCount > 0) {
    const N = Math.min(imgCount, items.length);
    await Promise.all(
      items.slice(0, N).map(async (it) => {
        if (!it.img) return;
        try {
          const r = await axios.get(it.img, { responseType: "arraybuffer" });
          const b64 = Buffer.from(r.data).toString("base64");
          const ext = (it.img.split(".").pop() || "jpg").toLowerCase();
          it.img = `data:image/${ext};base64,${b64}`;
        } catch { /* ignore */ }
      })
    );
  }

  const payload = { ok: true, url, count: items.length, products: [], items };
  if (wantDebug) payload.debug = debug;
  return payload;
}
