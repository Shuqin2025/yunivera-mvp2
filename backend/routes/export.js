// backend/routes/export.js
// 导出 Excel（带图片嵌入）
// POST /v1/api/excel  body: { source: string, rows: Array<{title, sku, price, moq, url, img}> }

import { Router } from "express";
import ExcelJS from "exceljs";
import fetch from "node-fetch";

const router = Router();

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

async function fetchImageBuffer(imgUrl, timeoutMs = 15000, maxBytes = 3_000_000) {
  if (!imgUrl) return null;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);

  try {
    const res = await fetch(imgUrl, {
      headers: {
        "user-agent": UA,
        accept: "image/*;q=0.8",
      },
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${imgUrl}`);

    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (!ct.startsWith("image/")) throw new Error(`Not an image: ${ct}`);

    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > maxBytes) throw new Error("Image too large");
      chunks.push(value);
    }
    const buf = Buffer.concat(chunks.map((u) => Buffer.from(u)));
    return { buf, ext: (ct.split("/")[1] || "jpeg").split(";")[0] };
  } finally {
    clearTimeout(timer);
  }
}

router.post("/excel", async (req, res) => {
  try {
    const { source = "", rows = [] } = req.body || {};
    const wb = new ExcelJS.Workbook();

    // 元信息
    wb.creator = "MVP3-Frontend";
    wb.created = new Date();

    const ws = wb.addWorksheet("【抓取目录（前 50 条）】");
    // 列宽
    ws.columns = [
      { header: "Source:", key: "_src", width: 120 },
    ];
    ws.addRow({ _src: source || "" });
    ws.addRow([]); // 空行

    ws.columns = [
      { header: "#", key: "_idx", width: 6 },
      { header: "标题/Title", key: "title", width: 45 },
      { header: "SKU", key: "sku", width: 18 },
      { header: "价格/Price", key: "price", width: 14 },
      { header: "MOQ", key: "moq", width: 10 },
      { header: "链接/URL", key: "url", width: 85 },
      { header: "图片/Image", key: "img", width: 28 }, // 这里用于嵌图
    ];

    // 表头加粗
    ws.getRow(ws.lastRow.number + 1).font = { bold: true };

    // 数据行（先写文本/链接）
    const startDataRow = ws.lastRow.number + 1;
    rows.forEach((r, i) => {
      const row = ws.addRow({
        _idx: i + 1,
        title: r.title ?? "",
        sku: r.sku ?? "",
        price: r.price ?? "",
        moq: r.moq ?? "",
        url: r.url ?? "",
        img: "", // 先留空，后面嵌图
      });
      // URL 超链接
      if (r.url) {
        const cell = row.getCell("url");
        cell.value = { text: r.url, hyperlink: r.url };
        cell.font = { color: { argb: "FF1565C0" }, underline: true };
      }
      // 行高为图片留空间（大约 96px）
      row.height = 96;
    });

    // 嵌图：逐行拉取 r.img
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || {};
      const imgUrl = r.img || r.image || r.preview || ""; // 兼容多字段
      if (!imgUrl) continue;

      try {
        const got = await fetchImageBuffer(imgUrl);
        if (!got) continue;

        const imgId = wb.addImage({
          buffer: got.buf,
          extension: got.ext === "jpg" ? "jpeg" : got.ext,
        });

        const excelRow = startDataRow + i;
        const colIdx = ws.getColumn("img").number; // G 列
        // 放到当前行的“图片/Image”单元格范围
        ws.addImage(imgId, {
          tl: { col: colIdx - 1 + 0.1, row: excelRow - 1 + 0.15 }, // 左上（0-based）
          ext: { width: 150, height: 90 }, // 控制显示尺寸
          editAs: "oneCell",
        });
      } catch (e) {
        // 某张图片失败时忽略
        // console.warn("image fail", imgUrl, e.message);
      }
    }

    // 输出 xlsx
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    // 避免非 ASCII 触发 header 错误：用 ASCII 文件名
    res.setHeader("Content-Disposition", `attachment; filename="export.xlsx"`);

    // 直接写入响应流
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("excel error:", err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

export default router;
