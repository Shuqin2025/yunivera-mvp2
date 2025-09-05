// backend/routes/pdf.js
import { Router } from "express";
import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";

const router = Router();

/**
 * POST /v1/api/pdf
 * body:
 * {
 *   title?: string,
 *   content?: string,   // or body
 *   body?: string,
 *   // 可选：表格数据
 *   rows?: Array<{ sku?:string, title?:string, price?:string|number, currency?:string, url?:string }>,
 *   columns?: Array<string> // 默认 ['#','SKU','Title','Price','Currency','URL']
 * }
 *
 * 查询参数：
 *   ?dl=1   // 下载；否则 inline 预览
 */
router.post("/", async (req, res) => {
  try {
    const {
      title = "报价单 / Quote",
      content,
      body,
      rows = [],
      columns,
    } = req.body || {};

    const text =
      typeof content === "string" && content.trim().length
        ? content
        : typeof body === "string"
        ? body
        : "";

    // inline 预览；?dl=1 下载
    const inline = !("dl" in req.query);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `${inline ? "inline" : "attachment"}; filename="quote.pdf"`
    );

    // === PDF 基本设置 ===
    const doc = new PDFDocument({ size: "A4", margin: 56 }); // 约 2cm
    doc.pipe(res);

    // 中文字体（可选）：backend/fonts/NotoSansSC-Regular.ttf
    const zhFontPath = path.join(
      process.cwd(),
      "backend",
      "fonts",
      "NotoSansSC-Regular.ttf"
    );
    if (fs.existsSync(zhFontPath)) {
      try {
        doc.registerFont("zh", zhFontPath);
        doc.font("zh");
      } catch {
        // 无中文字体时用默认字体兜底
      }
    }

    // 标题
    doc.fontSize(22).text(title, { align: "center" });
    doc.moveDown(1);

    // 正文（可选）
    if (text) {
      doc.fontSize(12).text(text, { align: "left", lineGap: 4 });
      doc.moveDown(1.2);
    }

    // 表格（可选）
    if (Array.isArray(rows) && rows.length > 0) {
      drawTable(doc, rows, columns);
    }

    doc.end();
  } catch (err) {
    console.error("[PDF ERROR]", err);
    res.status(500).json({ ok: false, error: "PDF generation failed" });
  }
});

export default router;

// ===== Helpers =====

function drawTable(doc, rows, columns) {
  const pageWidth = doc.page.width;
  const margin = doc.page.margins.left; // 左右相等
  const usable = pageWidth - margin * 2;
  const startX = margin;
  let y = doc.y;

  const header =
    Array.isArray(columns) && columns.length
      ? columns
      : ["#", "SKU", "Title", "Price", "Currency", "URL"];

  // 每列宽度（按默认 6 列分配；自定义列则等宽）
  const widths =
    header.length === 6
      ? [28, 90, usable - (28 + 90 + 80 + 70 + 80), 80, 70, 80]
      : new Array(header.length).fill(usable / header.length);

  const rowHeight = 18;
  const lineGap = 2;
  const cellPadding = 4;
  const bottomY = doc.page.height - doc.page.margins.bottom;

  const drawHeader = () => {
    doc.fontSize(11).fillColor("#000");
    let x = startX;
    header.forEach((h, i) => {
      doc.text(String(h), x + cellPadding, y + cellPadding, {
        width: widths[i] - cellPadding * 2,
        continued: false,
      });
      x += widths[i];
    });
    y += rowHeight;
    // header bottom line
    doc
      .moveTo(startX, y - lineGap)
      .lineTo(startX + usable, y - lineGap)
      .strokeColor("#999")
      .stroke();
  };

  const ensureSpace = (h) => {
    if (y + h > bottomY) {
      doc.addPage();
      y = doc.y;
      drawHeader();
    }
  };

  // header
  drawHeader();

  doc.fontSize(10).fillColor("#222");
  rows.forEach((r, idx) => {
    ensureSpace(rowHeight + lineGap);

    const cells = header.map((h) => {
      const key = normalizeKey(h);
      if (key === "#") return String(idx + 1);
      const v = r[key];
      return v == null ? "" : String(v);
    });

    let x = startX;
    cells.forEach((c, i) => {
      const isUrl = header[i].toLowerCase().includes("url");
      const text = isUrl ? (c.length > 40 ? c.slice(0, 37) + "..." : c) : c;

      doc.text(text, x + cellPadding, y + cellPadding, {
        width: widths[i] - cellPadding * 2,
        continued: false,
      });

      // URL 点击区域加 link
      if (isUrl && c) {
        const linkW = doc.widthOfString(text);
        const linkH = doc.currentLineHeight();
        doc.link(x + cellPadding, y + cellPadding, linkW, linkH, c);
      }

      x += widths[i];
    });

    y += rowHeight;
    // 行分割线
    doc
      .moveTo(startX, y - lineGap)
      .lineTo(startX + usable, y - lineGap)
      .strokeColor("#eee")
      .stroke();
  });

  // 尾注
  ensureSpace(40);
  doc.moveDown(0.5);
  doc
    .fontSize(9)
    .fillColor("#666")
    .text(`共 ${rows.length} 条。提示：价格与库存以卖家/供应商最终报价为准。`, {
      align: "right",
    });
}

function normalizeKey(h) {
  const k = String(h).toLowerCase();
  if (k === "#" || k === "序号") return "#";
  if (k.includes("sku")) return "sku";
  if (k.includes("title") || k.includes("name")) return "title";
  if (k.includes("price") || k.includes("价格")) return "price";
  if (k.includes("currency") || k.includes("币种")) return "currency";
  if (k.includes("url") || k.includes("链接")) return "url";
  return k;
}
