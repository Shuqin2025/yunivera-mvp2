// backend/routes/export.js — ESM (6 columns, bigger image + price fallback by fetching product page)
import { Router } from "express";
import ExcelJS from "exceljs";
import axios from "axios";
import pLimit from "p-limit";

const router = Router();
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

/* ---------------- helpers ---------------- */
const pickFirst = (obj, keys, fallback = "") => {
  for (const k of keys) if (obj && obj[k] != null && obj[k] !== "") return obj[k];
  return fallback;
};

function normalizeItems(body = {}) {
  const guessArr =
    (Array.isArray(body.items) && body.items) ||
    (Array.isArray(body.products) && body.products) ||
    (Array.isArray(body.rows) && body.rows) ||
    (Array.isArray(body.data) && body.data) ||
    (Array.isArray(body.list) && body.list) ||
    (Array.isArray(body) && body) || [];
  return guessArr.map((r) => {
    const link = pickFirst(r, ["link", "url", "href"]);
    const imageUrl = pickFirst(r, ["imageUrl", "img", "image", "picture", "photo"]);
    const title = pickFirst(r, ["title", "description", "name", "productName"]);
    const rawSku = pickFirst(r, ["sku", "code", "model", "mpn"]);
    const price = pickFirst(r, ["price", "amount", "value"]);
    return { link, imageUrl, title, rawSku, price };
  });
}

function deriveItemNo({ rawSku, link = "", title = "" }) {
  if (rawSku) return String(rawSku).trim();
  const m1 = (link || "").match(/(\d{2}-\d{5})(?:\.\w+)?$/);
  if (m1) return m1[1];
  const m2 = (title || "").match(/\b[A-Z0-9]{2,5}-\d{4,6}\b/);
  if (m2) return m2[0];
  return "";
}

// "9,00 EUR" / "€9.00" / "1.234,56"
function parsePriceNumeric(s) {
  if (s == null || s === "") return "";
  let str = String(s).replace(/[^\d.,-]/g, "").trim();
  if (!str) return "";
  const lastDot = str.lastIndexOf(".");
  const lastComma = str.lastIndexOf(",");
  if (lastComma > lastDot) {
    str = str.replace(/\./g, "").replace(",", ".");
  } else {
    str = str.replace(/,/g, "");
  }
  const num = Number(str);
  return Number.isFinite(num) ? num : "";
}

/* ---------- price fallback: fetch product page if missing ---------- */
async function fetchPriceFromPage(url) {
  if (!url) return "";
  try {
    const { data: html } = await axios.get(url, {
      headers: { "User-Agent": UA, "Referer": new URL(url).origin },
      timeout: 12000,
    });
    // 1) OpenGraph / product meta
    let m = html.match(/<meta[^>]+property=["']product:price:amount["'][^>]+content=["']([^"']+)["']/i);
    if (m) return parsePriceNumeric(m[1]);

    // 2) itemprop price
    m = html.match(/itemprop=["']price["'][^>]+content=["']([^"']+)["']/i);
    if (m) return parsePriceNumeric(m[1]);
    m = html.match(/<span[^>]+itemprop=["']price["'][^>]*>([\s\S]*?)<\/span>/i);
    if (m) return parsePriceNumeric(m[1]);

    // 3) JSON-LD "price"
    m = html.match(/"price"\s*:\s*"([^"]+)"/i);
    if (m) return parsePriceNumeric(m[1]);

    // 4) 可见文本：€ 9,00 / 9,00 EUR
    m = html.match(/(?:€|\bEUR\b)\s*([0-9][0-9\.,]*)/i) || html.match(/([0-9][0-9\.,]*)\s*(?:€|\bEUR\b)/i);
    if (m) return parsePriceNumeric(m[1]);

    return "";
  } catch {
    return "";
  }
}

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
  try {
    const resp = await axios.get(imgUrl, {
      responseType: "arraybuffer",
      headers: {
        "User-Agent": UA,
        "Referer": origin || imgUrl,
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"
      },
      timeout: 15000,
      validateStatus: (s) => s >= 200 && s < 400
    });
    const ext = extFromContentType(resp.headers["content-type"]);
    return { buffer: Buffer.from(resp.data), extension: ext };
  } catch {}
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
      const ext = ["png", "jpg", "jpeg", "webp", "gif"].includes(extGuess) ? extGuess : "png";
      return { buffer: Buffer.from(Uint8Array.from(arrBuf)), extension: ext };
    } finally {
      await browser.close();
    }
  } catch {
    throw new Error("IMAGE_FETCH_FAILED");
  }
}

/* ---------------- workbook (6 columns) ---------------- */
async function buildWorkbookBuffer(rawBody = {}) {
  const rawItems = normalizeItems(rawBody);
  // 初步映射
  let items = rawItems.map((r) => ({
    itemNo: deriveItemNo(r),
    description: r.title || "",
    moq: "",
    unitPrice: parsePriceNumeric(r.price),
    link: r.link || "",
    imageUrl: r.imageUrl || ""
  }));

  // 价格兜底：对缺价的，抓商品页解析（并发限制 3）
  const limitPrice = pLimit(3);
  await Promise.all(
    items.map((it, i) =>
      limitPrice(async () => {
        if (it.unitPrice === "" && it.link) {
          const p = await fetchPriceFromPage(it.link);
          if (p !== "") items[i].unitPrice = p;
        }
      })
    )
  );

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");

  ws.columns = [
    { header: "Item No.",    key: "itemNo",    width: 14 },
    { header: "Picture",     key: "picture",   width: 30 },
    { header: "Description", key: "description", width: 60 },
    { header: "MOQ",         key: "moq",       width: 10 },
    { header: "Unit Price",  key: "unitPrice", width: 14 },
    { header: "Link",        key: "link",      width: 60 }
  ];

  ws.getRow(1).font = { bold: true };
  ws.getColumn("picture").alignment = { vertical: "middle", horizontal: "center" };
  ws.getColumn("description").alignment = { wrapText: true, vertical: "top" };
  ws.getColumn("link").alignment = { wrapText: true };

  const hasAnyImage = items.some((it) => it.imageUrl);

  // 文本列
  items.forEach((it) => {
    const row = ws.addRow({
      itemNo: it.itemNo,
      picture: "",
      description: it.description,
      moq: it.moq,
      unitPrice: it.unitPrice === "" ? "" : it.unitPrice,
      link: it.link
    });
    if (it.link) {
      const c = row.getCell("link");
      c.value = { text: it.link, hyperlink: it.link };
      c.font = { color: { argb: "FF1B73E8" }, underline: true };
    }
    if (it.unitPrice !== "") row.getCell("unitPrice").numFmt = '#,##0.00';
    row.height = hasAnyImage ? 105 : 20; // 正好容纳 135px 高图
  });

  // 图片列（B）
  const limitImg = pLimit(4);
  await Promise.all(
    items.map((it, i) =>
      limitImg(async () => {
        if (!it.imageUrl) return;
        try {
          const { buffer, extension } = await fetchImageBuffer(it.imageUrl);
          const id = wb.addImage({ buffer, extension });
          const rowIdx = i + 2;
          ws.addImage(id, {
            tl: { col: 1, row: rowIdx - 1 },
            ext: { width: 180, height: 135 },
            editAs: "oneCell"
          });
        } catch {}
      })
    )
  );

  return wb.xlsx.writeBuffer();
}

/* ---------------- routes ---------------- */
router.post("/excel", async (req, res) => {
  try {
    const buf = await buildWorkbookBuffer(req.body);
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
    const buf = await buildWorkbookBuffer(req.body);
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
