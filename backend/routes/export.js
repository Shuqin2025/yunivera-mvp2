// backend/routes/export.js — Final stable build
// Layout: Item No. | Picture | Description | MOQ | Unit Price | Link
// Features: bigger images (180x135), price fallback, strong Item No. fallback,
// compact layout, Euro price format.

import { Router } from "express";
import ExcelJS from "exceljs";
import axios from "axios";
import pLimit from "p-limit";

const router = Router();
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

/* ---------------- small helpers ---------------- */

const pickFirst = (obj, keys, fallback = "") => {
  for (const k of keys) if (obj && obj[k] != null && obj[k] !== "") return obj[k];
  return fallback;
};

function normalizeItems(body = {}) {
  const arr =
    (Array.isArray(body.items) && body.items) ||
    (Array.isArray(body.products) && body.products) ||
    (Array.isArray(body.rows) && body.rows) ||
    (Array.isArray(body.data) && body.data) ||
    (Array.isArray(body.list) && body.list) ||
    (Array.isArray(body) && body) ||
    [];

  return arr.map((r) => {
    const link = pickFirst(r, ["link", "url", "href"]);
    const imageUrl = pickFirst(r, ["imageUrl", "img", "image", "picture", "photo"]);
    const title = pickFirst(r, ["title", "description", "name", "productName"]);
    const rawSku = pickFirst(r, [
      "sku", "code", "model", "mpn", "itemNo", "item_no", "id", "number",
      "artikelnummer", "artikel_nr", "artnr", "art_no", "artno", "productCode"
    ]);
    const price = pickFirst(r, ["price", "amount", "value"]);
    return { link, imageUrl, title, rawSku, price };
  });
}

// quick local guess (no placeholder if missing)
function deriveItemNoLocal({ rawSku, link = "", title = "" }) {
  if (rawSku) return String(rawSku).trim();
  const m1 = (link || "").match(/(\d{2}-\d{5})(?:\.\w+)?$/); // e.g. 02-22001
  if (m1) return m1[1];
  const m2 = (title || "").match(/\b[A-Z0-9]{2,8}-\d{3,8}\b/); // e.g. PV4-12345
  if (m2) return m2[0];
  return "";
}

// "9,00 EUR" / "€9.00" / "1.234,56" -> numeric
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

/* ---------------- price fallback: fetch product page ---------------- */

async function fetchPriceFromPage(url) {
  if (!url) return "";
  try {
    const { data: html } = await axios.get(url, {
      headers: { "User-Agent": UA, "Referer": new URL(url).origin },
      timeout: 12000
    });

    let m = html.match(/<meta[^>]+property=["']product:price:amount["'][^>]+content=["']([^"']+)["']/i);
    if (m) return parsePriceNumeric(m[1]);

    m = html.match(/itemprop=["']price["'][^>]+content=["']([^"']+)["']/i);
    if (m) return parsePriceNumeric(m[1]);
    m = html.match(/<span[^>]+itemprop=["']price["'][^>]*>([\s\S]*?)<\/span>/i);
    if (m) return parsePriceNumeric(m[1]);

    m = html.match(/"price"\s*:\s*"([^"]+)"/i);
    if (m) return parsePriceNumeric(m[1]);

    m =
      html.match(/(?:€|\bEUR\b)\s*([0-9][0-9\.,]*)/i) ||
      html.match(/([0-9][0-9\.,]*)\s*(?:€|\bEUR\b)/i);
    if (m) return parsePriceNumeric(m[1]);

    return "";
  } catch {
    return "";
  }
}

/* ---------------- item no. fallback: fetch product page ---------------- */

// walk any JSON for sku/mpn
function findSkuInJson(obj) {
  if (!obj || typeof obj !== "object") return "";
  if (typeof obj.sku === "string" && obj.sku.trim()) return obj.sku.trim();
  if (typeof obj.mpn === "string" && obj.mpn.trim()) return obj.mpn.trim();
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === "object") {
      const hit = findSkuInJson(v);
      if (hit) return hit;
    }
  }
  return "";
}

async function fetchItemNoFromPage(url) {
  if (!url) return "";
  try {
    const { data: html } = await axios.get(url, {
      headers: { "User-Agent": UA, "Referer": new URL(url).origin },
      timeout: 12000
    });

    // 1) JSON-LD blocks
    const ldBlocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
    for (const m of ldBlocks) {
      try {
        const data = JSON.parse(m[1]);
        const sku = findSkuInJson(data);
        if (sku) return sku;
      } catch {}
    }

    // 2) microdata/meta: itemprop="sku"
    let m =
      html.match(/itemprop=["']sku["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<[^>]+itemprop=["']sku["'][^>]*>([\s\S]*?)<\/[^>]+>/i);
    if (m && m[1]) return m[1].replace(/<[^>]+>/g, "").trim();

    // 3) visible labels (multi-lingual)
    const labelPatterns = [
      /Art\.?\s*[-\.]?\s*Nr\.?\s*[:#]?\s*([A-Za-z0-9\-_.\/]+)/i,
      /Artikel(?:nummer|-?Nr\.?)\s*[:#]?\s*([A-Za-z0-9\-_.\/]+)/i,
      /Bestell(?:nummer|-?Nr\.?)\s*[:#]?\s*([A-Za-z0-9\-_.\/]+)/i,
      /Hersteller-?Nr\.?\s*[:#]?\s*([A-Za-z0-9\-_.\/]+)/i,
      /\bSKU\s*[:#]?\s*([A-Za-z0-9\-_.\/]+)/i,
      /Product\s*code\s*[:#]?\s*([A-Za-z0-9\-_.\/]+)/i,
      /Model\s*[:#]?\s*([A-Za-z0-9\-_.\/]+)/i
    ];
    for (const re of labelPatterns) {
      const mm = html.match(re);
      if (mm && mm[1]) return mm[1].trim();
    }

    // 4) last try: URL pattern
    m = url.match(/\b([A-Z0-9]{2,8}-\d{3,8})\b/i);
    if (m) return m[1];

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

  // 1) axios direct
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
  // 2) Playwright fallback (optional)
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ userAgent: UA });
      const arr = await page.evaluate(async (url) => {
        const r = await fetch(url, { credentials: "omit" });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const ab = await r.arrayBuffer();
        return Array.from(new Uint8Array(ab));
      }, imgUrl);
      const extGuess = imgUrl.split("?")[0].split(".").pop()?.toLowerCase() || "";
      const extension = ["png","jpg","jpeg","webp","gif"].includes(extGuess) ? extGuess : "png";
      return { buffer: Buffer.from(Uint8Array.from(arr)), extension };
    } finally {
      await browser.close();
    }
  } catch {
    throw new Error("IMAGE_FETCH_FAILED");
  }
}

/* ---------------- workbook builder ---------------- */

async function buildWorkbookBuffer(rawBody = {}) {
  const rawItems = normalizeItems(rawBody);

  let items = rawItems.map((r) => ({
    itemNo: deriveItemNoLocal(r) || "",
    description: r.title || "",
    moq: "",
    unitPrice: parsePriceNumeric(r.price),
    link: r.link || "",
    imageUrl: r.imageUrl || ""
  }));

  // fill missing price & itemNo via product page (concurrency 3)
  const limit = pLimit(3);
  await Promise.all(
    items.map((it, i) =>
      limit(async () => {
        if (it.unitPrice === "" && it.link) {
          const p = await fetchPriceFromPage(it.link);
          if (p !== "") items[i].unitPrice = p;
        }
        if ((!it.itemNo || !String(it.itemNo).trim()) && it.link) {
          const sku = await fetchItemNoFromPage(it.link);
          if (sku) items[i].itemNo = sku;
        }
      })
    )
  );

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");

  // columns & styles
  ws.columns = [
    { header: "Item No.",    key: "itemNo",    width: 18 },
    { header: "Picture",     key: "picture",   width: 30 }, // fit 180px
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

  // rows (text first)
  items.forEach((it) => {
    const row = ws.addRow({
      itemNo: it.itemNo || "",
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
    if (it.unitPrice !== "") row.getCell("unitPrice").numFmt = '#,##0.00 "€"'; // Euro display
    row.height = hasAnyImage ? 105 : 20; // fits 135px image height
  });

  // images in column B (0-based col=1)
  const limitImg = pLimit(4);
  await Promise.all(
    items.map((it, idx) =>
      limitImg(async () => {
        if (!it.imageUrl) return;
        try {
          const { buffer, extension } = await fetchImageBuffer(it.imageUrl);
          const id = wb.addImage({ buffer, extension });
          const rowIdx = idx + 2; // data starts at row 2
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
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", 'attachment; filename="products.xlsx"');
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error("[/export/excel] error:", err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

router.post("/xlsx", async (req, res) => {
  try {
    const buf = await buildWorkbookBuffer(req.body);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", 'attachment; filename="products.xlsx"');
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error("[/export/xlsx] error:", err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

export { router };
export default router;
