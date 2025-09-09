// backend/routes/export.js — ESM (6 columns, bigger image 180x135, compact row height)

import { Router } from "express";
import ExcelJS from "exceljs";
import axios from "axios";
import pLimit from "p-limit";

const router = Router();
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

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
    (Array.isArray(body) && body) ||
    [];
  return guessArr.map((r) => {
    const link = pickFirst(r, ["link", "url", "href"]);
    const imageUrl = pickFirst(r, ["imageUrl", "img", "image", "picture", "photo"]);
    const title = pickFirst(r, ["title", "description", "name", "productName"]);
    const rawSku = pickFirst(r, ["sku", "code", "model", "mpn"]);
    const price = pickFirst(r, ["price", "amount", "value"]);
    return { link, imageUrl, title, rawSku, price };
  });
}

// 企业产品编号（Item No.）：优先 rawSku；没有则从链接/标题里匹配 02-22001 这类样式
function deriveItemNo({ rawSku, link = "", title = "" }) {
  if (rawSku) return String(rawSku).trim();
  const m1 = (link || "").match(/(\d{2}-\d{5})(?:\.\w+)?$/);
  if (m1) return m1[1];
  const m2 = (title || "").match(/\b[A-Z0-9]{2,5}-\d{4,6}\b/);
  if (m2) return m2[0];
  return "";
}

// 价格字符串 → 数值（19,90 / €19.90 / 1.234,56 等）
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
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"
      },
      timeout: 15000,
      validateStatus: (s) => s >= 200 && s < 400
    });
    const ext = extFromContentType(resp.headers["content-type"]);
    return { buffer: Buffer.from(resp.data), extension: ext };
  } catch {
    // fallback
  }

  // 2) Playwright 兜底（可选）
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

/* ---------------- workbook (6 columns, bigger picture) ---------------- */

async function buildWorkbookBuffer(rawBody = {}) {
  const rawItems = normalizeItems(rawBody);
  const items = rawItems.map((r) => ({
    itemNo: deriveItemNo(r),
    description: r.title || "",
    moq: "", // 留空，便于后续手工填写；需要默认值可改为 "1"
    unitPrice: parsePriceNumeric(r.price),
    link: r.link || "",
    imageUrl: r.imageUrl || ""
  }));

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");

  ws.columns = [
    { header: "Item No.",    key: "itemNo",    width: 14 },
    { header: "Picture",     key: "picture",   width: 30 }, // 更宽以容纳 180px
    { header: "Description", key: "description", width: 60 },
    { header: "MOQ",         key: "moq",       width: 10 },
    { header: "Unit Price",  key: "unitPrice", width: 14 },
    { header: "Link",        key: "link",      width: 60 }
  ];

  // 样式：表头加粗；Picture 列居中
  ws.getRow(1).font = { bold: true };
  ws.getColumn("picture").alignment = { vertical: "middle", horizontal: "center" };
  ws.getColumn("description").alignment = { wrapText: true, vertical: "top" };
  ws.getColumn("link").alignment = { wrapText: true };

  const hasAnyImage = items.some((it) => it.imageUrl);

  // 写入文本列
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

    // 行高：刚好容纳 135px 图片（≈ 101pt），取 105pt 更安全
    row.height = hasAnyImage ? 105 : 20;
  });

  // 插入图片：B 列（0-based col=1），尺寸 180×135 px
  const limit = pLimit(4);
  await Promise.all(
    items.map((it, i) =>
      limit(async () => {
        if (!it.imageUrl) return;
        try {
          const { buffer, extension } = await fetchImageBuffer(it.imageUrl);
          const id = wb.addImage({ buffer, extension });
          const rowIdx = i + 2; // 数据从第 2 行开始
          ws.addImage(id, {
            tl: { col: 1, row: rowIdx - 1 },
            ext: { width: 180, height: 135 }, // ✅ 更大
            editAs: "oneCell"
          });
        } catch {
          // 单张失败忽略
        }
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
