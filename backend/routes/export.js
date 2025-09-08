// backend/routes/export.js
import { Router } from "express";
import ExcelJS from "exceljs";

// 小工具：拉图（带超时 & 类型校验）
async function fetchImageBuffer(url, timeoutMs = 8000, maxBytes = 2_500_000) {
  const ctl = new AbortController();
  const id = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        accept: "image/*,*/*;q=0.8",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ct = res.headers.get("content-type") || "";
    if (!/^image\//i.test(ct)) throw new Error(`Not image: ${ct}`);

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
    return Buffer.from(chunks.flatMap((u) => Array.from(u)));
  } finally {
    clearTimeout(id);
  }
}

// 真正处理导出的函数
async function handleExport(req, res) {
  try {
    const { source = "", rows = [] } = req.body || {};
    if (!Array.isArray(rows)) {
      return res.status(400).json({ ok: false, error: "rows must be array" });
    }

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("抓取目录（前 50 条）");

    // 头部一行：来源
    ws.getCell("A1").value = "Source:";
    ws.getCell("B1").value = source;

    // 表头
    ws.addRow([]);
    ws.addRow(["#", "标题/Title", "SKU", "价格/Price", "MOQ", "链接/URL", "图片/Image"]);
    ws.getRow(3).font = { bold: true };

    // 每条数据
    let idx = 0;
    for (const it of rows) {
      idx += 1;
      const title = it.title ?? "";
      const sku = it.sku ?? "";
      const price = it.price ?? "";
      const moq = it.moq ?? "";
      const url = it.url ?? "";
      const img = it.img ?? "";

      // 先写基本字段
      const row = ws.addRow([idx, title, sku, price, moq, url, ""]);
      // 链接列设为超链接
      if (url) {
        row.getCell(6).value = { text: url, hyperlink: url };
        row.getCell(6).font = { color: { argb: "FF0563C1" }, underline: true };
      }

      // 尝试嵌图；失败则写“Open Image”超链接兜底
      if (img) {
        try {
          const buf = await fetchImageBuffer(img).catch(() => null);
          if (buf && buf.length) {
            const imgId = wb.addImage({ buffer: buf, extension: "jpeg" }); // 让 ExcelJS 自判格式也行
            const r = row.number;
            // 把图片放到 G 列（第 7 列），行高适当拉一点
            ws.addImage(imgId, {
              tl: { col: 6.1, row: r - 1 + 0.15 },
              br: { col: 6.9, row: r - 1 + 0.85 },
              editAs: "oneCell",
            });
            ws.getRow(r).height = Math.max(ws.getRow(r).height ?? 18, 60);
            ws.getColumn(7).width = Math.max(ws.getColumn(7).width ?? 20, 22);
          } else {
            row.getCell(7).value = { text: "Open Image", hyperlink: img };
            row.getCell(7).font = { color: { argb: "FF0563C1" }, underline: true };
          }
        } catch {
          row.getCell(7).value = { text: "Open Image", hyperlink: img };
          row.getCell(7).font = { color: { argb: "FF0563C1" }, underline: true };
        }
      }
    }

    // 列宽适配
    ws.getColumn(1).width = 5;
    ws.getColumn(2).width = 60;
    ws.getColumn(3).width = 15;
    ws.getColumn(4).width = 14;
    ws.getColumn(5).width = 10;
    ws.getColumn(6).width = 100;
    ws.getColumn(7).width = Math.max(ws.getColumn(7).width ?? 20, 22);

    // 生成并发送
    const buf = await wb.xlsx.writeBuffer();

    // 文件名仅用 ASCII，避免 “invalid character in header content”
    const filename = "catalog-export.xlsx";
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(
        filename
      )}`
    );
    return res.status(200).send(Buffer.from(buf));
  } catch (err) {
    console.error("[/export] excel error:", err?.message || err);
    return res.status(500).json({ ok: false, error: "EXPORT_FAILED" });
  }
}

const router = Router();

// ✅ 同时兼容 /export 和 /export/excel 两种写法
router.post("/", handleExport);
router.post("/excel", handleExport);

export default router;
