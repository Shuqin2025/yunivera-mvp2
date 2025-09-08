// backend/server.js — ESM

import express from "express";
import cors from "cors";

// 整页 PDF
import pdfRouter from "./routes/pdf.js";

// 目录抓取
import catalogRouter from "./routes/catalog.js";

/** 兼容式导入 export.js（默认导出 / 具名导出 / CJS 均可） */
import * as exportNS from "./routes/export.js";
const exportRouter = exportNS.default ?? exportNS.router ?? exportNS;

// 表格 PDF
import PDFDocument from "pdfkit";

const app = express();
const port = process.env.PORT || 10000;

/** CORS & JSON */
app.use(cors());
app.use(express.json({ limit: "2mb" }));

/** 根路径 */
app.get("/", (_req, res) => {
  res
    .type("text/plain")
    .send(
      [
        "mvp2-backend is running. Try /v1/api/health",
        "API:",
        "  - GET  /v1/api/health",
        "  - GET  /v1/api/catalog/parse?url=<catalog-url>",
        "  - POST /v1/api/export/excel         (xlsx with images)",
        "  - POST /v1/api/export/excel-html    (legacy .xls, no images)",
        "  - POST /v1/api/export/table-pdf",
        ""
      ].join("\n")
    );
});

/** 健康检查 */
const healthHandler = (_req, res) => {
  res
    .set("Cache-Control", "no-store, max-age=0")
    .type("application/json")
    .send(
      JSON.stringify({
        ok: true,
        service: "quote",
        version: "quote-v3-hf-ellipsis",
        ts: Date.now()
      })
    );
};
app.get("/v1/api/health", healthHandler);
app.head("/v1/api/health", (_req, res) => {
  res.set("Cache-Control", "no-store, max-age=0").status(200).end();
});

/** 路由挂载 */
app.use("/v1/api/pdf", pdfRouter);
app.use("/v1/api/catalog", catalogRouter);

/** ✅ ExcelJS（含图片嵌入）的导出路由，由 routes/export.js 提供 */
app.use("/v1/api/export", exportRouter);

/** 兼容：HTML 表格导出（不含图片，xls） */
app.post("/v1/api/export/excel-html", (req, res) => {
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
        const tds = columns
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
          .join("");
        return `<tr>${tds}</tr>`;
      })
      .join("");

    const subtitle = [
      meta.source ? `Source: ${esc(meta.source)}` : "",
      meta.generatedBy ? `GeneratedBy: ${esc(meta.generatedBy)}` : ""
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

    const filename = `${sanitizeFilename(name) || "export"}.xls`;
    res.setHeader("Content-Type", "application/vnd.ms-excel; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
    );
    res.send(html);
  } catch (err) {
    console.error("[/export/excel-html] error:", err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

/** 表格 PDF（简版） */
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
    const widths = columns.map((c) => (Number(c.width) > 0 ? Number(c.width) : 20));
    const totalWidth = widths.reduce((a, b) => a + b, 0) || 1;
    const scale = pageWidth / totalWidth;
    const colPx = widths.map((w) => Math.max(30, Math.floor(w * scale)));

    // 表头
    let y = doc.y;
    let x = doc.x;
    doc.fontSize(9);
    columns.forEach((c, idx) => {
      doc.rect(x, y, colPx[idx], 18).fill("#eee").stroke("#aaa");
      doc.fillColor("#000").text(String(c.title || c.key), x + 3, y + 4, { width: colPx[idx] - 6 });
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
          doc.fillColor("#000").text(String(c.title || c.key), localX + 3, y + 4, { width: colPx[idx] - 6 });
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
