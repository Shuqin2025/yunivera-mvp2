// backend/routes/export.js
// 生成带内嵌图片的 .xlsx

import Router from "express";
import ExcelJS from "exceljs";

const router = Router();

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

// 拉取图片二进制
async function fetchImageBuffer(url, timeoutMs = 10000, maxBytes = 2_000_000) {
  if (!url) return null;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await axios.get(url, {
      responseType: "arraybuffer",
      headers: { "User-Agent": UA, Accept: "image/*,*/*;q=0.8" },
      signal: ctl.signal,
      maxContentLength: maxBytes,
      maxBodyLength: maxBytes,
      validateStatus: (s) => s >= 200 && s < 300,
    });
    const ct = (res.headers["content-type"] || "").toLowerCase();
    if (!ct.startsWith("image/")) return null;
    return Buffer.from(res.data);
  } finally {
    clearTimeout(t);
  }
}

// 入口：POST /v1/api/export/excel
router.post("/excel", async (req, res) => {
  try {
    const { source = "", rows = [] } = req.body || {};
    // rows: [{title, sku, price, moq, url, img}...]

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("导出结果");

    // 样式与标题
    ws.getRow(1).values = [`【抓取目录（前 50 条）】`];
    ws.mergeCells(1, 1, 1, 11);
    ws.getRow(1).font = { bold: true, size: 14 };
    ws.getRow(2).values = [
      `Source: ${source}`,
      "",
      "",
      "",
      "GeneratedBy: MVP3-Frontend",
    ];
    ws.getRow(2).font = { italic: true, size: 10 };

    // 表头（中德英双语）
    const headerRow = [
      "#",
      "标题/Title",
      "SKU",
      "价格/Price",
      "MOQ",
      "链接/URL",
      "图片/Image",
    ];
    ws.addRow([]);
    ws.addRow(headerRow);
    const hdr = ws.getRow(4);
    hdr.font = { bold: true };
    hdr.alignment = { vertical: "middle", horizontal: "center" };

    // 列宽
    ws.getColumn(1).width = 6;     // #
    ws.getColumn(2).width = 38;    // Title
    ws.getColumn(3).width = 16;    // SKU
    ws.getColumn(4).width = 14;    // Price
    ws.getColumn(5).width = 10;    // MOQ
    ws.getColumn(6).width = 48;    // URL
    ws.getColumn(7).width = 28;    // Image (列宽+行高只影响单元格，不影响真正图片大小)

    // 数据 + 图片
    // 图片我们用固定缩略图尺寸（例如 120x120 px），并贴在第 7 列对应行
    // ExcelJS 图片定位：列/行是从 0 开始计的
    const BASE_ROW = 5; // 数据开始行（第1~4行为标题和表头）
    const THUMB_W = 120;
    const THUMB_H = 120;

    for (let i = 0; i < rows.length; i++) {
      const idx = i + 1;
      const r = rows[i] || {};
      const excelRow = ws.addRow([
        idx,
        r.title || "",
        r.sku || "",
        r.price ?? "",
        r.moq ?? "",
        r.url || "",
        "", // 图片列占位
      ]);
      excelRow.alignment = { vertical: "middle" };
      excelRow.height = 95; // 行高稍微加大，便于显示缩略图

      // URL 做成超链接
      if (r.url) {
        const cell = ws.getCell(excelRow.number, 6);
        cell.value = { text: r.url, hyperlink: r.url, tooltip: r.url };
        cell.font = { color: { argb: "FF0563C1" }, underline: true };
      }

      // 图片嵌入
      if (r.img) {
        try {
          const buf = await fetchImageBuffer(r.img);
          if (buf) {
            // 根据格式选择类型
            let ext = "png";
            const lower = r.img.toLowerCase();
            if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) ext = "jpeg";
            else if (lower.endsWith(".gif")) ext = "gif";

            const imgId = wb.addImage({
              buffer: buf,
              extension: ext,
            });

            // 目标位置：第 7 列（索引从0计数 -> 6），当前数据行（从0计数 -> BASE_ROW-1+i）
            // 微调让图片在单元格中居中一些
            const tl = { col: 6 + 0.15, row: (BASE_ROW - 1 + i) + 0.2 };
            const extPx = { width: THUMB_W, height: THUMB_H };

            ws.addImage(imgId, { tl, ext: extPx });
          }
        } catch (e) {
          // 忽略单图失败
        }
      }
    }

    // 边框（可选）
    const lastRow = ws.lastRow.number;
    for (let r = 4; r <= lastRow; r++) {
      for (let c = 1; c <= 7; c++) {
        ws.getCell(r, c).border = {
          top: { style: "thin", color: { argb: "FFCCCCCC" } },
          left: { style: "thin", color: { argb: "FFCCCCCC" } },
          bottom: { style: "thin", color: { argb: "FFCCCCCC" } },
          right: { style: "thin", color: { argb: "FFCCCCCC" } },
        };
      }
    }

    // 输出
    const filename = "导出结果.xlsx";
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
    );

    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("excel export error:", err);
    res
      .status(500)
      .json({ ok: false, error: err?.message || "excel export failed" });
  }
});

export default router;
