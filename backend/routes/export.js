// backend/routes/export.js
// 导出 Excel（嵌入图片）
// POST /v1/api/export/excel  body: { source?: string, rows: Array<{title, sku, price, moq, url, img}> }

import { Router } from "express";
import ExcelJS from "exceljs";

const router = Router();

// 伪装浏览器 UA
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

// 拉取图片，带 Referer
async function fetchImageBuffer(imgUrl, referer, timeoutMs = 12000, maxBytes = 3_000_000) {
  if (!imgUrl) throw new Error("No image url");

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);

  try {
    const res = await fetch(imgUrl, {
      headers: {
        "user-agent": UA,
        accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "accept-language": "de,en;q=0.9,zh;q=0.8",
        referer: referer || "https://www.s-impuls-shop.de/",
        "accept-encoding": "identity",
      },
      signal: ctl.signal,
      redirect: "follow",
    });

    if (!res.ok) throw new Error(`HTTP ${res.status} for ${imgUrl}`);

    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (!ct.startsWith("image/") && ct !== "application/octet-stream") {
      throw new Error(`Not an image. content-type=${ct}`);
    }

    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > maxBytes) throw new Error("Image too large");
      chunks.push(value);
    }
    const buf = Buffer.concat(chunks.map((u) => Buffer.from(u)));

    let ext = "jpeg";
    if (ct.includes("png")) ext = "png";
    else if (ct.includes("webp")) ext = "webp";
    else if (ct.includes("gif")) ext = "gif";

    return { buffer: buf, ext };
  } finally {
    clearTimeout(timer);
  }
}

router.post("/excel", async (req, res) => {
  try {
    const { source = "", rows = [] } = req.body || {};
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("导出结果");

    const header = ["#", "标题/Title", "SKU", "价格/Price", "MOQ", "链接/URL", "图片/Image"];
    ws.addRow([`【抓取目录（前 50 条）】`]);
    ws.mergeCells(1, 1, 1, header.length);
    ws.getRow(1).font = { bold: true };

    ws.addRow([
      `Source: ${source || ""}`,
      "",
      "",
      "",
      "",
      "GeneratedBy: MVP3-Frontend",
      "",
    ]);
    ws.mergeCells(2, 1, 2, header.length);

    ws.addRow(header);
    ws.getRow(3).font = { bold: true };

    const colWidths = [6, 52, 14, 14, 10, 64, 28];
    colWidths.forEach((w, i) => (ws.getColumn(i + 1).width = w));

    let rowIdx = 4;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || {};
      const n = i + 1;
      ws.addRow([n, r.title || "", r.sku || "", r.price ?? "", r.moq ?? "", r.url || "", ""]);

      if (r.url) {
        const c = ws.getCell(rowIdx, 6);
        c.value = { text: r.url, hyperlink: r.url };
        c.font = { color: { argb: "FF1B64D1" }, underline: true };
      }

      // 尝试嵌入图片
      let embedded = false;
      if (r.img) {
        try {
          const { buffer, ext } = await fetchImageBuffer(r.img, r.url || source);
          const imgId = wb.addImage({ buffer, extension: ext });

          const targetCol = 7;
          ws.getRow(rowIdx).height = 90;
          ws.mergeCells(rowIdx, targetCol, rowIdx, targetCol);
          ws.addImage(imgId, {
            tl: { col: targetCol - 1 + 0.1, row: rowIdx - 1 + 0.1 },
            br: { col: targetCol - 1 + 1 - 0.1, row: rowIdx - 1 + 1 - 0.1 },
            editAs: "oneCell",
          });
          embedded = true;
        } catch (e) {
          console.warn("[excel] embed image failed:", r.img, String(e));
        }
      }
      if (!embedded && r.img) {
        const c = ws.getCell(rowIdx, 7);
        c.value = { text: r.img, hyperlink: r.img };
        c.font = { color: { argb: "FF1B64D1" }, underline: true };
      }

      rowIdx++;
    }

    // ====== 关键修复：下载文件名用 ASCII 回退 + UTF-8 正式名 ======
    const asciiName = "export.xlsx";
    const utf8Name = encodeURIComponent("导出结果.xlsx");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`
    );
    // =========================================================

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    const buf = await wb.xlsx.writeBuffer();
    res.end(Buffer.from(buf));
  } catch (err) {
    console.error("Export excel error:", err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

export default router;
