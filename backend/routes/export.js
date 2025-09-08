// backend/routes/export.js — ESM (with payload normalization)
import { Router } from "express";
import ExcelJS from "exceljs";
import axios from "axios";
import pLimit from "p-limit";

const router = Router();
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

/* ---------- utils: field alias ---------- */
const pickFirst = (obj, keys, fallback = "") => {
  for (const k of keys) {
    if (obj && obj[k] != null && obj[k] !== "") return obj[k];
  }
  return fallback;
};
const toItem = (raw) => {
  // 统一字段：title / price / sku / link / imageUrl
  const title = pickFirst(raw, ["title", "name", "product", "productName"]);
  const price = pickFirst(raw, ["price", "amount", "value"]);
  const sku   = pickFirst(raw, ["sku", "code", "model", "mpn"]);
  const link  = pickFirst(raw, ["link", "url", "href"]);
  const imageUrl = pickFirst(raw, ["imageUrl", "img", "image", "picture", "photo"]);
  return { title, price, sku, link, imageUrl };
};

/* ---------- utils: normalize incoming payload to items[] ---------- */
function normalizeItems(body = {}) {
  // 1) 直接 items 数组
  if (Array.isArray(body.items) && body.items.length) {
    return body.items.map(toItem);
  }
  // 2) 抓取结果常见：products 数组
  if (Array.isArray(body.products) && body.products.length) {
    return body.products.map(toItem);
  }
  // 3) 有 rows + columns（旧版 HTML 导出同形）
  if (Array.isArray(body.rows) && body.rows.length) {
    return body.rows.map(toItem);
  }
  // 4) data / list 等常用命名
  if (Array.isArray(body.data) && body.data.length) {
    return body.data.map(toItem);
  }
  if (Array.isArray(body.list) && body.list.length) {
    return body.list.map(toItem);
  }
  // 5) body 本身就是数组
  if (Array.isArray(body) && body.length) {
    return body.map(toItem);
  }
  return [];
}

/* ---------- image fetch ---------- */
function extFromContentType(ct = "") {
  ct = (ct || "").toLowerCase();
  if (ct.includes("png")) return "png";
  if (ct.includes("jpeg") || ct.includes("jpg")) return "jpeg";
  if (ct.includes("webp")) return "webp";
  if (ct.includes("gif")) return "gif";
  return "png";
}

async function fetchImageBuffer(imgUrl) {
  const origin = (() => { try { return new URL(imgUrl).origin; } catch { return undefined; } })();

  // 1) axios 直连（带 Referer）
  try {
    const resp = await axios.get(imgUrl, {
      responseType: "arraybuffer",
      headers: {
        "User-Agent": UA,
        "Referer": origin || imgUrl,
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
      timeout: 15000,
      validateStatus: s => s >= 200 && s < 400
    });
    const ext = extFromContentType(resp.headers["content-type"]);
    return { buffer: Buffer.from(resp.data), extension: ext };
  } catch { /* continue fallback */ }

  // 2) Playwright 兜底（可选，未安装则直接抛出交由上层忽略该图）
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ userAgent: UA });
      const arrBuf = await page.evaluate(async (url) => {
        const r = await fetch(url, { credentials: "omit" });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const ab = await r.arrayBuffer();
        return Array.from(new Uint8Array(ab));
      }, imgUrl);
      const extGuess = imgUrl.split("?")[0].split(".").pop()?.toLowerCase() || "";
      const ext = ["png","jpg","jpeg","webp","gif"].includes(extGuess) ? extGuess : "png";
      return { buffer: Buffer.from(Uint8Array.from(arrBuf)), extension: ext };
    } finally {
      await browser.close();
    }
  } catch {
    throw new Error("IMAGE_FETCH_FAILED");
  }
}

/* ---------- workbook ---------- */
async function buildWorkbookBuffer(items = []) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Products");

  ws.columns = [
    { header: "Title", key: "title", width: 40 },
    { header: "Price", key: "price", width: 12 },
    { header: "SKU",   key: "sku",   width: 18 },
    { header: "Link",  key: "link",  width: 60 },
    { header: "Image", key: "image", width: 22 },
  ];

  const hasAnyImage = items.some(it => it.imageUrl);

  items.forEach((it) => {
    const row = ws.addRow({
      title: it.title || "",
      price: it.price || "",
      sku:   it.sku   || "",
      link:  it.link  || "",
      image: ""
    });
    if (it.link) {
      const cell = row.getCell("link");
      cell.value = { text: it.link, hyperlink: it.link };
      cell.font  = { color: { argb: "FF1B73E8" }, underline: true };
    }
    if (hasAnyImage) row.height = 100;
  });

  const limit = pLimit(4);
  const tasks = items.map((it, i) =>
    limit(async () => {
      if (!it.imageUrl) return;
      try {
        const { buffer, extension } = await fetchImageBuffer(it.imageUrl);
        const imageId = wb.addImage({ buffer, extension });
        const rowIdx = i + 2; // data starts at row 2
        ws.addImage(imageId, { tl: { col: 4, row: rowIdx - 1 }, ext: { width: 120, height: 90 }, editAs: "oneCell" });
      } catch {
        // 单张失败忽略
      }
    })
  );
  await Promise.all(tasks);

  ws.getRow(1).font = { bold: true };
  ws.getColumn("image").alignment = { vertical: "middle", horizontal: "center" };

  return wb.xlsx.writeBuffer();
}

/* ---------- routes ---------- */
// 接受任意负载形态：items / products / rows...
router.post("/excel", async (req, res) => {
  try {
    const items = normalizeItems(req.body);
    console.log(`[export/excel] normalized items: ${items.length}`);
    const buf = await buildWorkbookBuffer(items);
    res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition",'attachment; filename="products.xlsx"');
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error("[/export/excel] error:", err);
    res.status(500).json({ ok:false, error:String(err?.message||err) });
  }
});

router.post("/xlsx", async (req, res) => {
  try {
    const items = normalizeItems(req.body);
    console.log(`[export/xlsx] normalized items: ${items.length}`);
    const buf = await buildWorkbookBuffer(items);
    res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition",'attachment; filename="products.xlsx"');
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error("[/export/xlsx] error:", err);
    res.status(500).json({ ok:false, error:String(err?.message||err) });
  }
});

export { router };
export default router;
