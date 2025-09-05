// backend/server.js  —— ESM
import express from "express";
import cors from "cors";

// 现有 PDF 路由（保持不变）
import pdfRouter from "./routes/pdf.js";

// 目录解析路由（见下文的 routes/catalog.js）
import catalogRouter from "./routes/catalog.js";

// 仅供 /v1/api/scrape 简易抓取用
import * as cheerio from "cheerio";

// 导出相关依赖
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

// 健康检查
app.get("/v1/api/health", (req, res) => {
  res.type("application/json").send(
    JSON.stringify({
      ok: true,
      service: "quote",
      version: "quote-v3-hf-ellipsis",
      ts: Date.now(),
    })
  );
});

// ========== 简易单页抓取：/v1/api/scrape ==========
async function fetchHtml(u) {
  const res = await fetch(u, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,de;q=0.7",
    },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Fetch ${res.status} ${res.statusText} | ${t.slice(0, 200)}`);
  }
  return await res.text();
}

app.post("/v1/api/scrape", async (req, res) => {
  try {
    const url = (req.body?.url || "").trim();
    if (!url) return res.status(400).json({ ok: false, error: "MISSING_URL" });

    const html = await fetchHtml(url);
    const $ = cheerio.load(html);
    const title =
      $('meta[property="og:title"]').attr("content") ||
      $("title").text().trim() ||
      $('meta[name="title"]').attr("content") ||
      "";
    const description =
      $('meta[property="og:description"]').attr("content") ||
      $('meta[name="description"]').attr("content") ||
      "";
    const h1 = $("h1")
      .map((_, el) => $(el).text().trim())
      .get()
      .filter(Boolean);

    const approxTextLength = $("body").text().replace(/\s+/g, " ").trim().length;

    res.json({
      ok: true,
      url,
      fetchedAt: Date.now(),
      title,
      description,
      h1,
      approxTextLength,
      preview:
        (description || $("body").text().replace(/\s+/g, " ").trim()).slice(0, 300),
      vendor: "generic",
      price: null,
      currency: null,
      images: $("img")
        .map((_, el) => $(el).attr("src"))
        .get()
        .filter(Boolean)
        .slice(0, 10),
    });
  } catch (err) {
    console.error("[/v1/api/scrape] error:", err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// ========== PDF（既有） ==========
app.use("/v1/api/pdf", pdfRouter);

// ========== 目录解析 ==========
app.use("/v1/api/catalog", catalogRouter);

// ========== 导出：Excel ==========
app.post("/v1/api/export/excel", async (req, res) => {
  try {
    const { name = "export", columns = [], rows = [], meta = {} } = req.body || {};

    const wb = new ExcelJS.Workbook();
    wb.creator = "MVP3 Backend";
    wb.created = new Date();

    const ws = wb.addWorksheet("Sheet1");

    // ExcelJS 列配置
    ws.columns = columns.map((c) => ({
      header: c.title || c.key,
      key: c.key,
      width: c.width || 16,
    }));

    // 写入数据
    rows.forEach((r) => ws.addRow(r));

    // 顶部 metadata（可选）
    if (Object.keys(meta || {}).length) {
      ws.insertRow(1, []);
      ws.insertRow(
        1,
        [`Source: ${meta.source || ""}`, `GeneratedBy: ${meta.generatedBy || ""}`],
        "n"
      );
      ws.mergeCells(1, 1, 1, Math.max(2, columns.length));
    }

    // 边框 & 自动筛选
    const lastRow = ws.lastRow?.number || rows.length + 2;
    const lastCol = columns.length || 1;
    ws.autoFilter = {
      from: { row: 2, column: 1 },
      to: { row: 2, column: lastCol },
    };
    for (let r = 2; r <= lastRow; r++) {
      for (let c = 1; c <= lastCol; c++) {
        ws.getCell(r, c).border = {
          top: { style: "thin" },
          left: { style: "thin" },
          bottom: { style: "thin" },
          right: { style: "thin" },
        };
        ws.getCell(r, c).alignment = { vertical: "middle", wrapText: true };
      }
    }

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader(
      "content-type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "content-disposition",
      `attachment; filename="${encodeURIComponent(`${name}.xlsx`)}"`
    );
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error("[/v1/api/export/excel] error:", err);
    res.status(500).send(String(err?.message || err));
  }
});

// ========== 导出：表格 PDF ==========
app.post("/v1/api/export/table-pdf", async (req, res) => {
  try {
    const { title = "Table", subtitle = "", columns = [], rows = [] } = req.body || {};

    res.setHeader("content-type", "application/pdf");
    res.setHeader(
      "content-disposition",
      `attachment; filename="${encodeURIComponent(`${title}.pdf`)}"`
    );

    const doc = new PDFDocument({ size: "A4", margin: 36 });
    doc.pipe(res);

    // 标题区
    doc.fontSize(18).text(title, { align: "center" });
    if (subtitle) doc.moveDown(0.3).fontSize(10).fillColor("#666").text(subtitle, { align: "center" });
    doc.moveDown(0.6).fillColor("#000");

    // 简易表格布局（按列的 width 权重进行缩放）
    const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right; // ~523
    const totalWeight = (columns.length ? columns : [{ width: 10 }]).reduce(
      (s, c) => s + (Number(c.width) || 10),
      0
    );
    const x0 = doc.x, y0 = doc.y;

    // 表头
    let x = x0;
    columns.forEach((c) => {
      const w = (Number(c.width) || 10) / totalWeight * contentWidth;
      doc.font("Helvetica-Bold").fontSize(10).text(c.title || c.key || "", x, doc.y, {
        width: w,
        continued: false,
      });
      x += w;
    });
    doc.moveDown(0.2);
    doc.moveTo(x0, doc.y).lineTo(x0 + contentWidth, doc.y).strokeColor("#999").stroke();
    doc.strokeColor("#000");

    // 行
    rows.forEach((r) => {
      let xx = x0;
      let rowHeight = 0;
      const yStart = doc.y + 2;

      // 先测量每个单元需要的高度
      const cellHeights = columns.map((c) => {
        const w = (Number(c.width) || 10) / totalWeight * contentWidth;
        const v =
          r[c.key] == null
            ? ""
            : typeof r[c.key] === "string"
            ? r[c.key]
            : String(r[c.key]);
        const { height } = doc
          .font("Helvetica")
          .fontSize(9)
          .heightOfString(v, { width: w });
        return Math.max(height, 12);
      });
      rowHeight = Math.max(...cellHeights) + 6;

      // 真正绘制
      columns.forEach((c, i) => {
        const w = (Number(c.width) || 10) / totalWeight * contentWidth;
        const v =
          r[c.key] == null
            ? ""
            : typeof r[c.key] === "string"
            ? r[c.key]
            : String(r[c.key]);
        doc
          .font("Helvetica")
          .fontSize(9)
          .text(v, xx, yStart, { width: w, height: rowHeight - 4 });
        xx += w;
      });

      doc.moveTo(x0, yStart + rowHeight).lineTo(x0 + contentWidth, yStart + rowHeight).strokeColor("#eee").stroke();
      doc.strokeColor("#000");
      doc.y = yStart + rowHeight; // 下一行
    });

    doc.end();
  } catch (err) {
    console.error("[/v1/api/export/table-pdf] error:", err);
    res.status(500).send(String(err?.message || err));
  }
});

// 兜底
app.get("/", (req, res) => {
  res.type("text/plain").send("mvp2-backend is running. Try /v1/api/health");
});

app.listen(PORT, () => {
  console.log(`[mvp2-backend] listening at http://0.0.0.0:${PORT}`);
});
