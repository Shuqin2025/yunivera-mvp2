// backend/server.js — ESM

import express from "express";
import cors from "cors";

// 现有 PDF 路由
import pdfRouter from "./routes/pdf.js";

// 目录抓取路由
import catalogRouter from "./routes/catalog.js";

// 表格 PDF 用到
import PDFDocument from "pdfkit";

const app = express();
const port = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

// 健康检查
app.get("/v1/api/health", (_req, res) => {
  res.type("application/json").send(
    JSON.stringify({
      ok: true,
      service: "quote",
      version: "quote-v3-hf-ellipsis",
      ts: Date.now(),
    })
  );
});

// 现有 PDF（整页）生成
app.use("/v1/api/pdf", pdfRouter);

// 目录抓取
app.use("/v1/api/catalog", catalogRouter);

/**
 * 导出 Excel（Excel 兼容 HTML，无需第三方库）
 * POST /v1/api/export/excel
 * body: { name?, columns: [{key,title,width?}], rows: [{...}], meta? }
 */
app.post("/v1/api/export/excel", (req, res) => {
  try {
    const { name = "export", columns = [], rows = [], meta = {} } = req.body || {};
    if (!Array.isArray(columns) || columns.length === 0) {
      return res.status(400).json({ ok: false, error: "MISSING_COLUMNS" });
    }
    if (!Array.isArray(rows)) {
      return res.status(400).json({ ok: false, error: "MISSING_ROWS" });
    }

    const esc = (s) =>
      String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    const colHtml = columns
      .map(
        (c) =>
          `<th style="border:1px solid #999;padding:4px;background:#eee">${esc(
            c.title || c.key
          )}</th>`
      )
      .join("");

    const rowsHtml = rows
      .map((r, i) => {
        return `<tr>${columns
          .map((c) => {
            const v = c.key === "index" ? i + 1 : r[c.key] ?? "";
            if (c.key === "url" && v) {
              return `<td style="border:1px solid #ccc;padding:4px;"><a href="${esc(
                v
              )}">${esc(v)}</a></td>`;
            }
            if ((c.key === "image" || c.key === "img") && v) {
              return `<td style="border:1px solid #ccc;padding:4px;"><a href="${esc(
                v
              )}">${esc(v)}</a></td>`;
            }
            return `<td style="border:1px solid #ccc;padding:4px;">${esc(v)}</td>`;
          })
          .join("")}</tr>`;
      })
      .join("");

    const subtitle = [
      meta.source ? `Source: ${esc(meta.source)}` : "",
      meta.generatedBy ? `GeneratedBy: ${esc(meta.generatedBy)}` : "",
    ]
      .filter(Boolean)
      .join(" | ");

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8" /><title>${esc(name)}</title></head>
<body>
<h3 style="margin:0 0 6px;">${esc(name)}</h3>
<div style="margin:0 0 10px;color:#666;">${subtitle}</div>
<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;font-size:12px;">
  <thead><tr>${colHtml}</tr></thead>
  <tbody>${rowsHtml}</tbody>
</table>
</body></html>`;

    const safeBase = sanitizeFilename(name);
    const filename = `${safeBase || "export"}.xls`;

    // 关键修正：严格 ASCII 文件名 + UTF-8 扩展名，避免 header 有非法字符
    res.setHeader("Content-Type", "application/vnd.ms-excel; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(
        filename
      )}`
    );
    res.send(html);
  } catch (err) {
    console.error("[/export/excel] error:", err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

/**
 * 导出“表格 PDF”（pdfkit）
 * POST /v1/api/export/table-pdf
 * body: { title?, subtitle?, columns: [{key,title,width?}], rows: [...] }
 */
app.post("/v1/api/export/table-pdf", (req, res) => {
  try {
    const { title = "表格导出", subtitle = "", columns = [], rows = [] } = req.body || {};
    if (!Array.isArray(columns) || columns.length === 0) {
      return res.status(400).json({ ok: false, error: "MISSING_COLUMNS" });
    }
    if (!Array.isArray(rows)) {
      return res.status(400).json({ ok: false, error: "MISSING_ROWS" });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${sanitizeFilename(title)}.pdf"`
    );

    const doc = new PDFDocument({ size: "A4", margin: 36 });
    doc.pipe(res);

    // 标题
    doc.fontSize(16).text(title, { align: "center" }).moveDown(0.3);
    if (subtitle) {
      doc.fontSize(10).fillColor("#666").text(subtitle, { align: "center" }).fillColor("#000");
    }
    doc.moveDown(0.8);

    // 列宽
    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    let totalWidth = 0;
    const widths = columns.map((c) => {
      const w = Number(c.width) > 0 ? Number(c.width) : 20;
      totalWidth += w;
      return w;
    });
    const pxPerUnit = pageWidth / totalWidth;
    const colPx = widths.map((w) => Math.max(30, Math.floor(w * pxPerUnit)));

    // 表头
    let y = doc.y;
    let x = doc.x;
    doc.fontSize(9).fillColor("#000");
    columns.forEach((c, idx) => {
      doc.rect(x, y, colPx[idx], 18).fill("#eee").stroke("#aaa");
      doc.fillColor("#000").text(String(c.title || c.key), x + 3, y + 4, { width: colPx[idx] - 6 });
      doc.fillColor("#000");
      x += colPx[idx];
    });
    y += 18;

    const drawRow = (rowIndex) => {
      const r = rows[rowIndex];
      let localX = doc.x;
      let rowHeight = 16;

      columns.forEach((c, idx) => {
        const val = c.key === "index" ? rowIndex + 1 : r?.[c.key] ?? "";
        const txt = String(val);
        const h = doc.heightOfString(txt, { width: colPx[idx] - 6 });
        rowHeight = Math.max(rowHeight, h + 6);
      });

      if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        y = doc.y;
        localX = doc.x;
        columns.forEach((c, idx) => {
          doc.rect(localX, y, colPx[idx], 18).fill("#eee").stroke("#aaa");
          doc.fillColor("#000").text(String(c.title || c.key), localX + 3, y + 4, {
            width: colPx[idx] - 6,
          });
          doc.fillColor("#000");
          localX += colPx[idx];
        });
        y += 18;
        localX = doc.x;
      }

      localX = doc.x;
      columns.forEach((c, idx) => {
        const val = c.key === "index" ? rowIndex + 1 : r?.[c.key] ?? "";
        doc.rect(localX, y, colPx[idx], rowHeight).stroke("#ddd");
        doc.text(String(val), localX + 3, y + 3, { width: colPx[idx] - 6 });
        localX += colPx[idx];
      });
      y += rowHeight;
    };

    for (let i = 0; i < rows.length; i++) drawRow(i);
    doc.end();
  } catch (err) {
    console.error("[/export/table-pdf] error:", err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// utils
function sanitizeFilename(name) {
  // 只保留安全 ASCII，避免响应头非法字符
  return String(name || "file")
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]+/g, "")      // 去掉非可打印 ASCII
    .replace(/[\\/:*?"<>|]+/g, "_")      // Windows 不允许的字符
    .replace(/\s+/g, "_")
    .slice(0, 120);
}

app.listen(port, () => {
  console.log(`[mvp2-backend] listening at http://0.0.0.0:${port}`);
});
