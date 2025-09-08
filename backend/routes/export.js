// backend/routes/export.js
// 导出 Excel（嵌入图片）
// POST /v1/api/export/excel  body: { source?: string, rows: Array<{title, sku, price, moq, url, img}> }

import { Router } from "express";
import ExcelJS from "exceljs";

const router = Router();

// 伪装浏览器 UA
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

// 拉取图片，带 Referer
async function fetchImageBuffer(imgUrl, referer, timeoutMs = 12000, maxBytes = 3_000_000) {
  if (!imgUrl) throw new Error("No image url");

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);

  try {
    const res = await fetch(imgUrl, {
      headers: {
        "user-agent": UA,
        // 接受常见图片类型，同时允许 */* 兜底
        accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "accept-language": "de,en;q=0.9,zh;q=0.8",
        // 很多站点要求 Referer 才允许直链
        referer: referer || "https://www.s-impuls-shop.de/",
        // 关闭压缩，避免个别服务器用奇怪的 content-encoding
        "accept-encoding": "identity",
      },
      signal: ctl.signal,
      redirect: "follow",
    });

    if (!res.ok) throw new Error(`HTTP ${res.status} for ${imgUrl}`);

    const ct = (res.headers.get("content-type") || "").toLowerCase();
    // 有些服务器发 application/octet-stream 但内容确实是图片
    if (!ct.startsWith("image/") && ct !== "application/octet-stream") {
      throw new Error(`Not an image. content-type=${ct}`);
    }

    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;

    // 流式读取 + 大小限制
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > maxBytes) throw new Error("Image too large");
      chunks.push(value);
    }
    const buf = Buffer.concat(chunks.map((u) => Buffer.from(u)));
    // 用 content-type 猜扩展名
    let ext = "jpeg";
    if (ct.includes("png")) ext = "png";
    else if (ct.includes("webp")) ext = "webp";
    else if (ct.includes("gif")) ext = "gif";

    return { buffer: buf, ext };
  } finally {
    clearTimeout(timer);
  }
}

router.post("/excel", async (req, res) => {
  try {
    const { source = "", rows = [] } = req.body || {};
    // 创建工作簿
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("导出结果");

    // 标题行
    const header = ["#", "标题/Title", "SKU", "价格/Price", "MOQ", "链接/URL", "图片/Image"];
    ws.addRow([`【抓取目录（前 50 条）】`]);
    ws.mergeCells(1, 1, 1, header.length);
    ws.getRow(1).font = { bold: true };

    ws.addRow([
      `Source: ${source || ""}`,
      "",
      "",
      "",
      "",
      "GeneratedBy: MVP3-Frontend",
      "",
    ]);
    ws.mergeCells(2, 1, 2, header.length);

    ws.addRow(header);
    ws.getRow(3).font = { bold: true };

    // 列宽
    const colWidths = [6, 52, 14, 14, 10, 64, 28];
    colWidths.forEach((w, i) => (ws.getColumn(i + 1).width = w));

    // 从第 4 行开始写数据
    let rowIdx = 4;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || {};
      const n = i + 1;
      ws.addRow([
        n,
        r.title || "",
        r.sku || "",
        r.price ?? "",
        r.moq ?? "",
        r.url || "",
        "", // 图像占位列
      ]);

      // 链接转超链接
      if (r.url) {
        const c = ws.getCell(rowIdx, 6);
        c.value = { text: r.url, hyperlink: r.url };
        c.font = { color: { argb: "FF1B64D1" }, underline: true };
      }

      // 尝试嵌入图片
      let embedded = false;
      if (r.img) {
        try {
          // 用产品页 URL 作为 referer（若有）
          const { buffer, ext } = await fetchImageBuffer(r.img, r.url || source);
          const imgId = wb.addImage({ buffer, extension: ext });
          // 设定图片单元格区域（第 7 列）
          const targetCol = 7;
          const heightPx = 120; // 行高像素
          ws.getRow(rowIdx).height = 90; // Excel 行高是磅，这里经验值让图片合适显示
          ws.mergeCells(rowIdx, targetCol, rowIdx, targetCol);
          ws.addImage(imgId, {
            tl: { col: targetCol - 1 + 0.1, row: rowIdx - 1 + 0.1 },
            br: { col: targetCol - 1 + 1 - 0.1, row: rowIdx - 1 + 1 - 0.1 },
            editAs: "oneCell",
          });
          embedded = true;
        } catch (e) {
          console.warn("[excel] embed image failed:", r.img, String(e));
        }
      }

      // 失败回退：写入图片 URL 文本，避免空白
      if (!embedded && r.img) {
        const c = ws.getCell(rowIdx, 7);
        c.value = { text: r.img, hyperlink: r.img };
        c.font = { color: { argb: "FF1B64D1" }, underline: true };
      }

      rowIdx++;
    }

    // 输出
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="导出结果.xlsx"`);

    const buf = await wb.xlsx.writeBuffer();
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error("Export excel error:", err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

export default router;
