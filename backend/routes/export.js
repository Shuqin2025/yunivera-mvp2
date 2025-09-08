// backend/routes/export.js
// 导出 Excel（含图片缩略图）
// POST /v1/api/export/excel  body: { source?: string, rows: Array<{title, sku, price, moq, url, img}> }

import { Router } from "express";
import ExcelJS from "exceljs";

const router = Router();

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

function guessExtFrom(ct, url = "") {
  const u = url.toLowerCase();
  if (ct?.includes("png") || u.endsWith(".png")) return "png";
  return "jpeg"; // 默认 jpeg
}

async function fetchImageBuffer(imgUrl, timeoutMs = 15000, maxBytes = 2_500_000) {
  if (!imgUrl) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(imgUrl, {
      headers: { "user-agent": UA, accept: "image/*,*/*;q=0.8" },
      redirect: "follow",
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${imgUrl}`);
    const ct = res.headers.get("content-type") || "";
    if (!/^image\//i.test(ct)) throw new Error(`Not an image: ${ct}`);

    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > maxBytes) throw new Error("Image too large");
      chunks.push(value);
    }
    return {
      buffer: Buffer.concat(chunks.map((u) => Buffer.from(u))),
      ext: guessExtFrom(ct, imgUrl),
    };
  } finally {
    clearTimeout(timer);
  }
}

router.post("/excel", async (req, res) => {
  try {
    const { source = "", rows = [] } = req.body || {};
    const book = new ExcelJS.Workbook();
    const ws = book.addWorksheet("Catalog");

    // 列宽：#, 标题, SKU, 价格, MOQ, URL, 图片
    ws.columns = [
      { header: "#", key: "_no", width: 6 },
      { header: "标题/Title", key: "title", width: 64 },
      { header: "SKU", key: "sku", width: 14 },
      { header: "价格/Price", key: "price", width: 12 },
      { header: "MOQ", key: "moq", width: 10 },
      { header: "链接/URL", key: "url", width: 110 },
      { header: "图片/Image", key: "img", width: 34 },
    ];

    // 顶部标题 + 来源
    ws.mergeCells("A1:G1");
    ws.getCell("A1").value = "【抓取目录（前 50 条）】";
    ws.getCell("A1").font = { bold: true, size: 14 };
    ws.getCell("A1").alignment = { horizontal: "left", vertical: "middle" };

    ws.getCell("A2").value = "Source:";
    ws.getCell("B2").value = source ?? "";
    ws.mergeCells("B2:G2");

    // 表头样式（第3行）
    ws.getRow(3).values = ws.columns.map((c) => c.header);
    ws.getRow(3).font = { bold: true };
    ws.getRow(3).alignment = { horizontal: "center", vertical: "middle" };
    ws.getRow(3).height = 22;

    // 冻结前3行
    ws.views = [{ state: "frozen", ySplit: 3 }];

    const border = {
      top: { style: "thin" },
      left: { style: "thin" },
      bottom: { style: "thin" },
      right: { style: "thin" },
    };

    // 写入数据 & 插图
    let rIndex = 4;
    let No = 1;

    for (const item of rows) {
      const { title = "", sku = "", price = "", moq = "", url = "", img = "" } = item || {};
      ws.getCell(`A${rIndex}`).value = No++;
      ws.getCell(`B${rIndex}`).value = title;
      ws.getCell(`C${rIndex}`).value = sku || null;
      ws.getCell(`D${rIndex}`).value = price || null;
      ws.getCell(`E${rIndex}`).value = moq || null;

      // URL 超链
      if (url) {
        ws.getCell(`F${rIndex}`).value = { text: url, hyperlink: url };
        ws.getCell(`F${rIndex}`).font = { color: { argb: "FF1F4E79" }, underline: true };
      }

      // 单元格样式
      for (const col of ["A", "B", "C", "D", "E", "F", "G"]) {
        const c = ws.getCell(`${col}${rIndex}`);
        c.border = border;
        c.alignment = { vertical: "middle", wrapText: col === "B" };
      }

      // 图片（缩略图）
      if (img) {
        try {
          const got = await fetchImageBuffer(img);
          if (got?.buffer?.length) {
            const imageId = book.addImage({ buffer: got.buffer, extension: got.ext });
            // 适中的缩略图尺寸
            const width = 220;
            const height = 140;
            // 放到第7列（G），当前数据行的可视区；tl 的 row/col 从 0 起
            ws.addImage(imageId, {
              tl: { col: 6, row: rIndex - 1 + 0.15 }, // 第7列索引=6
              ext: { width, height },
              editAs: "oneCell",
            });
            // 为了不挤压外观，设定统一的行高
            ws.getRow(rIndex).height = Math.max(ws.getRow(rIndex).height ?? 0, height + 12);
          }
        } catch {
          // 忽略单条图片失败
        }
      }

      rIndex++;
    }

    // 统一边框美化（数据区）
    for (let r = 4; r < rIndex; r++) {
      for (let c = 1; c <= 7; c++) {
        ws.getRow(r).getCell(c).border = border;
      }
    }

    // 输出为 xlsx
    const buf = await book.xlsx.writeBuffer();
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    // 仅 ASCII 文件名，避免 header 非法字符
    res.setHeader("Content-Disposition", 'attachment; filename="catalog-export.xlsx"');
    res.status(200).send(Buffer.from(buf));
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

export default router;

