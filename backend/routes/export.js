// backend/routes/export.js
// Excel 导出（带图片嵌入 + 超链接兜底）

import { Router } from "express";
import ExcelJS from "exceljs";

// Node 18+ 全局已内置 fetch
// 允许的最大图片体积（字节）
const MAX_IMAGE_BYTES = 2_000_000; // 2MB
const IMAGE_TIMEOUT_MS = 12_000;   // 12s
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

const router = Router();

/**
 * 带超时与限流的图片下载
 */
async function fetchImageBuffer(url, timeoutMs = IMAGE_TIMEOUT_MS, maxBytes = MAX_IMAGE_BYTES) {
  if (!url || typeof url !== "string") throw new Error("empty url");
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": UA,
        accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "accept-language": "en",
      },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} when fetching ${url}`);

    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    if (!/^image\//.test(ctype)) throw new Error(`Not image: ${ctype}`);

    // 内容长度初筛
    const clen = Number(res.headers.get("content-length") || "0");
    if (clen && clen > maxBytes) throw new Error(`image too large: ${clen}`);

    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) throw new Error("image too large (stream)");
      chunks.push(value);
    }
    return { buffer: Buffer.concat(chunks.map((u) => Buffer.from(u))), contentType: ctype };
  } finally {
    clearTimeout(t);
  }
}

/**
 * 将 rows 写入 Excel，尝试嵌入图片，并在 G 列创建 “Open Image” 链接
 * body: { source?: string, rows: Array<{title, sku, price, moq, url, img}> }
 */
router.post("/v1/api/export/excel", async (req, res) => {
  try {
    const { source = "", rows = [] } = req.body || {};
    if (!Array.isArray(rows)) {
      return res.status(400).json({ ok: false, error: "rows must be an array" });
    }

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("抓取目录（前 50 条）", {
      properties: { defaultRowHeight: 18 },
      views: [{ state: "frozen", ySplit: 2 }],
    });

    // 列定义
    ws.columns = [
      { header: "#", key: "no", width: 4 },
      { header: "标题/Title", key: "title", width: 52 },
      { header: "SKU", key: "sku", width: 12 },
      { header: "价格/Price", key: "price", width: 12 },
      { header: "MOQ", key: "moq", width: 10 },
      { header: "链接/URL", key: "url", width: 85 },
      { header: "图片/Image", key: "image", width: 22 }, // 放缩略图 + “Open Image” 超链
    ];

    // 顶部来源行
    ws.mergeCells("A1:G1");
    ws.getCell("A1").value = "Source: " + (source || "");
    ws.getCell("A1").font = { italic: true, color: { argb: "FF444444" } };

    // 表头样式（第2行）
    const headerRow = ws.getRow(2);
    headerRow.font = { bold: true };
    headerRow.alignment = { vertical: "middle", horizontal: "center" };
    headerRow.height = 20;

    // 实际数据从第 3 行开始
    const baseRow = 3;

    // 逐行写入
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || {};
      const excelRow = ws.getRow(baseRow + i);

      excelRow.getCell("no").value = i + 1;
      excelRow.getCell("title").value = r.title ?? "";
      excelRow.getCell("sku").value = r.sku ?? "";
      excelRow.getCell("price").value = r.price ?? "";
      excelRow.getCell("moq").value = r.moq ?? "";

      // URL 列：始终写为超链接
      if (r.url) {
        excelRow.getCell("url").value = { text: r.url, hyperlink: r.url };
        excelRow.getCell("url").font = { color: { argb: "FF1155CC" }, underline: true };
      } else {
        excelRow.getCell("url").value = "";
      }

      // 图片列：永远写入 “Open Image” 超链接兜底
      if (r.img) {
        excelRow.getCell("image").value = { text: "Open Image", hyperlink: r.img };
        excelRow.getCell("image").font = { color: { argb: "FF1155CC" }, underline: true };
      } else {
        excelRow.getCell("image").value = "";
      }

      // 行高给到大一些，便于放缩略图
      excelRow.height = 110;
    }

    // 尝试批量抓图并嵌入（失败不影响导出）
    // 将 G 列稍微宽一点以容纳缩略图
    ws.getColumn("image").width = 24;

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || {};
      if (!r.img) continue;

      try {
        const { buffer, contentType } = await fetchImageBuffer(r.img);
        // exceljs 需要 extension
        let ext = "png";
        if (contentType.includes("jpeg") || contentType.includes("jpg")) ext = "jpeg";
        else if (contentType.includes("png")) ext = "png";
        else if (contentType.includes("webp")) ext = "png"; // 转不了，先按 png 放，Excel 仍能识别多数 webp（若不行会抛错被 catch）

        const imgId = wb.addImage({ buffer, extension: ext });

        // 把图放在第 baseRow + i 行的 G 列区域
        // 用 twoCellAnchor 定位靠近单元格，尺寸 140x100（像素）
        const rowIdx = baseRow + i;
        // 左上角（tl）定位到 G 列的稍右侧，避免覆盖“Open Image”文字
        ws.addImage(imgId, {
          tl: { col: 6.15, row: rowIdx - 1 + 0.2 }, // G 列是 index 6，从 0 起算；行从 0 起算所以 -1
          ext: { width: 140, height: 100 },
          editAs: "oneCell",
        });
      } catch (e) {
        // 图片拉取/嵌入失败不报错，保留 Open Image 超链接
        // console.error("embed image failed:", e?.message || e);
      }
    }

    // 细边框（可选，美观）
    const totalRows = rows.length + 2;
    for (let r = 2; r <= totalRows; r++) {
      for (let c = 1; c <= 7; c++) {
        ws.getRow(r).getCell(c).border = {
          top: { style: "thin", color: { argb: "FFE5E5E5" } },
          left: { style: "thin", color: { argb: "FFE5E5E5" } },
          bottom: { style: "thin", color: { argb: "FFE5E5E5" } },
          right: { style: "thin", color: { argb: "FFE5E5E5" } },
        };
      }
    }

    // 响应头：仅 ASCII，避免 header 报错
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="catalog-export.xlsx"');

    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("[/v1/api/export/excel] error:", err?.message || err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

export default router;
