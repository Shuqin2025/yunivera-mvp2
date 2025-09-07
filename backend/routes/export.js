// backend/routes/export.js
// 导出 Excel（嵌入图片缩略图）
// POST /v1/api/export/excel  body: { source?: string, rows: Array<{title, sku, price, moq, url, img}> }

import { Router } from "express";
import ExcelJS from "exceljs";

const router = Router();

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

async function fetchImageBuffer(imgUrl, timeoutMs = 10000, maxBytes = 2_000_000) {
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
    if (!/^image\//i.test(ct)) throw new Error(`Not an image: ${ct}`);

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
    let ext = "jpeg";
    if (/png/i.test(ct)) ext = "png";
    else if (/jpe?g/i.test(ct)) ext = "jpeg";
    else if (/webp/i.test(ct)) ext = "webp";
    else if (/gif/i.test(ct)) ext = "gif";
    return { buf, ext };
  } catch {
    return null; // 失败就返回 null，后面会回退为写入超链接文本
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
      return res
        .status(400)
        .json({ ok: false, error: "EMPTY_ROWS", tip: "rows 不能为空" });
    }

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("导出结果");

    // 顶部标题行
    ws.mergeCells("A1", "L1");
    ws.getCell("A1").value =
      `Source: ${source || "-"}  |  GeneratedBy: MVP3-Frontend`;
    ws.getCell("A1").font = { bold: true };
    ws.getCell("A1").alignment = { vertical: "middle", wrapText: true };
    ws.getRow(1).height = 18;

    // 表头
    const header = ["#", "标题/Title", "SKU", "价格/Price", "MOQ", "链接/URL", "图片/Image"];
    ws.addRow(header);
    ws.getRow(2).font = { bold: true };
    ws.getRow(2).alignment = { vertical: "middle" };

    // 列宽：可按需微调
    autoCol(ws, 1, 5);   // #
    autoCol(ws, 2, 32);  // title
    autoCol(ws, 3, 16);  // sku
    autoCol(ws, 4, 14);  // price
    autoCol(ws, 5, 10);  // moq
    autoCol(ws, 6, 42);  // url
    autoCol(ws, 7, 24);  // image

    // 冻结表头
    ws.views = [{ state: "frozen", xSplit: 0, ySplit: 2 }];

    // 从第 3 行开始写数据
    const startRow = 3;

    // 先写入基础文本数据，提升并发稳定性
    rows.forEach((r, i) => {
      const rowIndex = startRow + i;
      const row = ws.getRow(rowIndex);
      row.getCell(1).value = i + 1;
      row.getCell(2).value = r.title || "";
      row.getCell(3).value = r.sku || "";
      row.getCell(4).value = r.price ?? "";
      row.getCell(5).value = r.moq ?? "";

      // URL 写为可点击超链接
      if (r.url) {
        row.getCell(6).value = { text: r.url, hyperlink: r.url, tooltip: r.url };
        row.getCell(6).font = { color: { argb: "FF1F4E79" }, underline: true };
      } else {
        row.getCell(6).value = "";
      }

      // 给图片列设置一个较高的行高，方便缩略图显示
      row.height = 84;
      row.commit();
    });

    // 逐行抓图并插入（串行，降低被目标站限速/阻断概率）
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const rowIndex = startRow + i;
      if (!r.img) continue;

      const imgData = await fetchImageBuffer(r.img);
      if (!imgData) {
        // 回退：写入超链接文本
        ws.getCell(rowIndex, 7).value = {
          text: r.img,
          hyperlink: r.img,
          tooltip: r.img,
        };
        ws.getCell(rowIndex, 7).font = { color: { argb: "FF1F4E79" }, underline: true };
        continue;
      }

      const imageId = wb.addImage({
        buffer: imgData.buf,
        extension: imgData.ext,
      });

      // 把图片画到 G 列（第 7 列）对应的单元格区域，做成缩略图效果
      // 这里用单元格锚定位置：从 G{row} 到 G{row}（内部加边距）
      ws.addImage(imageId, {
        tl: { col: 6 + 0.15, row: rowIndex - 1 + 0.15 }, // 左上角 (col,row 从 0 计；第7列=>索引6)
        br: { col: 6 + 0.85, row: rowIndex - 1 + 0.85 }, // 右下角
        editAs: "oneCell",
      });
    }

    // 导出 .xlsx
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''export.xlsx`
    );
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("[export.excel] error:", err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

export default router;
