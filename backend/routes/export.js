// backend/routes/export.js
// 导出 Excel（嵌入图片缩略图）
// POST /v1/api/export/excel  body: { source?: string, rows: Array<{title, sku, price, moq, url, img}> }

import { Router } from "express";
import ExcelJS from "exceljs";

const router = Router();
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

// 仅接受 png/jpeg，其它格式回退为超链接
function pickSupportedExt(contentType = "") {
  if (/png/i.test(contentType)) return "png";
  if (/jpe?g/i.test(contentType)) return "jpeg";
  return null; // 其它一律视为不支持
}

async function fetchImageBuffer(imgUrl, timeoutMs = 12000, maxBytes = 2_000_000) {
  if (!imgUrl) return null;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(imgUrl, {
      headers: { "user-agent": UA, accept: "image/*,*/*;q=0.8" },
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${imgUrl}`);

    const ct = res.headers.get("content-type") || "";
    const ext = pickSupportedExt(ct);
    if (!ext) return null; // 不支持的类型（如 webp/gif），回退到文本链接

    // 读流并限流
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) throw new Error("Image too large");
      chunks.push(value);
    }
    const buf = Buffer.concat(chunks.map((u) => Buffer.from(u)));
    return { buf, ext };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function autoCol(ws, col, width) {
  if (width) ws.getColumn(col).width = width;
}

router.post("/excel", async (req, res) => {
  try {
    const { rows = [], source = "" } = req.body || {};
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ ok: false, error: "EMPTY_ROWS", tip: "rows 不能为空" });
    }

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("导出结果");

    // 顶部标题行
    ws.mergeCells("A1", "L1");
    ws.getCell("A1").value = `Source: ${source || "-"}  |  GeneratedBy: MVP3-Frontend`;
    ws.getCell("A1").font = { bold: true };
    ws.getCell("A1").alignment = { vertical: "middle", wrapText: true };
    ws.getRow(1).height = 18;

    // 表头
    const header = ["#", "标题/Title", "SKU", "价格/Price", "MOQ", "链接/URL", "图片/Image"];
    ws.addRow(header);
    ws.getRow(2).font = { bold: true };
    ws.getRow(2).alignment = { vertical: "middle" };

    // 列宽（加宽图片列，便于缩略图展示）
    autoCol(ws, 1, 5);
    autoCol(ws, 2, 32);
    autoCol(ws, 3, 16);
    autoCol(ws, 4, 14);
    autoCol(ws, 5, 10);
    autoCol(ws, 6, 50);
    autoCol(ws, 7, 24);

    // 冻结表头
    ws.views = [{ state: "frozen", xSplit: 0, ySplit: 2 }];

    // 从第 3 行开始写数据
    const startRow = 3;

    // 先写文本
    rows.forEach((r, i) => {
      const rowIndex = startRow + i;
      const row = ws.getRow(rowIndex);
      row.getCell(1).value = i + 1;
      row.getCell(2).value = r.title || "";
      row.getCell(3).value = r.sku || "";
      row.getCell(4).value = r.price ?? "";
      row.getCell(5).value = r.moq ?? "";

      if (r.url) {
        row.getCell(6).value = { text: r.url, hyperlink: r.url, tooltip: r.url };
        row.getCell(6).font = { color: { argb: "FF1F4E79" }, underline: true };
      }

      // 预设行高，适配缩略图（像素到行高的映射由 Excel 处理；设置高一点更保险）
      row.height = 86;
      row.commit();
    });

    // 串行抓图并插入，使用 { tl, ext } 固定像素尺寸
    // 缩略图统一宽高（像素），你可以按需调整
    const thumbWidth = 140;
    const thumbHeight = 90;

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const rowIndex = startRow + i;
      if (!r.img) continue;

      const imgData = await fetchImageBuffer(r.img);
      if (!imgData) {
        // 回退：写入超链接文本
        ws.getCell(rowIndex, 7).value = { text: r.img, hyperlink: r.img, tooltip: r.img };
        ws.getCell(rowIndex, 7).font = { color: { argb: "FF1F4E79" }, underline: true };
        continue;
      }

      const imageId = wb.addImage({
        buffer: imgData.buf,
        extension: imgData.ext, // 只会是 png/jpeg
      });

      // G 列（索引从 0 算，第 7 列是 6），行索引同理：ExcelJS 用 0-based
      ws.addImage(imageId, {
        tl: { col: 6 + 0.15, row: rowIndex - 1 + 0.15 },
        ext: { width: thumbWidth, height: thumbHeight },
        editAs: "oneCell",
      });
    }

    // 输出 .xlsx
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''export.xlsx`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("[export.excel] error:", err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

export default router;
