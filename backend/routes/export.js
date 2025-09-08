// backend/routes/export.js
// 生成目录 Excel（含图片列，失败则回退为图片链接）

import { Router } from "express";
import ExcelJS from "exceljs";

// Node 20 自带 fetch/AbortController
const router = Router();

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

const IMG_MAX_BYTES = 2_000_000;       // 2MB 上限（避免超大图）
const IMG_TIMEOUT_MS = 12_000;         // 12s 超时
const IMG_W = 120;                     // 嵌入图片像素宽
const IMG_H = 120;                     // 嵌入图片像素高
const COL_IMG_WIDTH = 140;             // G 列宽（像素）
const ROW_HEIGHT = 110;                // 行高（像素）

/** 抓取图片为 Buffer，带 UA/Referer、类型与体积校验、超时与简单重试 */
async function fetchImageBuffer(url, referer) {
  if (!url) throw new Error("empty img url");

  // 简单重试 2 次
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), IMG_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          "user-agent": UA,
          accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          referer: referer || new URL(url).origin,
        },
        signal: ctl.signal,
      });
      clearTimeout(timer);

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const ctype = (res.headers.get("content-type") || "").toLowerCase();
      if (!/image\//.test(ctype)) {
        throw new Error(`not image content-type: ${ctype}`);
      }

      const reader = res.body.getReader();
      const chunks = [];
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > IMG_MAX_BYTES) {
          throw new Error("image too large");
        }
        chunks.push(value);
      }
      const buf = Buffer.concat(chunks.map((u) => Buffer.from(u)));
      return { buf, ctype };
    } catch (err) {
      lastErr = err;
      // 下一轮重试前稍等
      await new Promise((r) => setTimeout(r, 250));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error("fetch image failed");
}

/** 将 MIME 映射为 ExcelJS 支持的扩展名 */
function extFromMime(ctype) {
  if (!ctype) return "jpeg";
  if (ctype.includes("png")) return "png";
  if (ctype.includes("gif")) return "gif";
  // LibreOffice 对 webp 支持较差，统一降级为 jpeg
  return "jpeg";
}

/** 生成 Excel（带图片列），rows: [{ title, sku, price, moq, url, img }] */
router.post("/excel", async (req, res) => {
  try {
    const { source = "", rows = [] } = req.body || {};
    const safeName = "catalog-export.xlsx"; // ASCII 文件名，避免 header 报错

    const wb = new ExcelJS.Workbook();
    wb.creator = "MVP3-Frontend";
    wb.created = new Date();

    const ws = wb.addWorksheet("Catalog");

    // 列设置：A=#, B=Title, C=SKU, D=Price, E=MOQ, F=URL, G=Image
    ws.columns = [
      { header: "#", key: "no", width: 6 },
      { header: "标题/Title", key: "title", width: 48 },
      { header: "SKU", key: "sku", width: 16 },
      { header: "价格/Price", key: "price", width: 14 },
      { header: "MOQ", key: "moq", width: 10 },
      { header: "链接/URL", key: "url", width: 95 },
      { header: "图片/Image", key: "img", width: 20 }, // 宽度先用字符单位，稍后再转像素
    ];

    // 顶部来源行
    ws.mergeCells("A1:G1");
    ws.getCell("A1").value = { richText: [{ text: "Source: ", font: { bold: true } }, { text: source }] };
    ws.getCell("A1").alignment = { vertical: "middle" };
    ws.getRow(1).height = 18;

    // 表头样式
    const headerRow = ws.getRow(2);
    headerRow.eachCell((c) => {
      c.font = { bold: true };
      c.alignment = { vertical: "middle" };
      c.border = {
        top: { style: "thin" },
        bottom: { style: "thin" },
      };
    });
    ws.getRow(2).height = 20;

    // 数据行
    const startRow = 3;
    rows.forEach((r, i) => {
      const rowIdx = startRow + i;
      const row = ws.getRow(rowIdx);
      row.height = ROW_HEIGHT; // 为图片留空间
      ws.getCell(`A${rowIdx}`).value = i + 1;
      ws.getCell(`B${rowIdx}`).value = r.title || "";
      ws.getCell(`C${rowIdx}`).value = r.sku ?? "";
      ws.getCell(`D${rowIdx}`).value = r.price ?? "";
      ws.getCell(`E${rowIdx}`).value = r.moq ?? "";
      ws.getCell(`F${rowIdx}`).value = {
        text: r.url || "",
        hyperlink: r.url || "",
        tooltip: r.url || "",
      };
      // 统一边框，让表格观感更整齐
      row.eachCell((c) => {
        c.alignment = { vertical: "middle", wrapText: true };
        c.border = {
          top: { style: "thin" },
          bottom: { style: "thin" },
        };
      });
    });

    // 把 G 列换成像素宽（ExcelJS 的字符宽和像素并非一一对应；用图片锚点更可靠）
    // 这里用 Drawing Anchor 固定大小：120x120px，并把列宽设得略大些
    // ExcelJS 里无法直接以像素设列宽，这里用一个经验字符宽来接近 140px
    ws.getColumn("G").width = Math.round(COL_IMG_WIDTH / 7); // 粗略换算

    // 逐行抓图并插入（失败就写链接）
    for (let i = 0; i < rows.length; i++) {
      const { img, url } = rows[i] || {};
      const rowIdx = startRow + i;

      if (!img) {
        // 无图时写入链接，避免 G 列空白
        ws.getCell(`G${rowIdx}`).value = url ? { text: "Open Image", hyperlink: url } : "";
        continue;
      }

      try {
        const { buf, ctype } = await fetchImageBuffer(img, url || source);
        const ext = extFromMime(ctype);
        const imgId = wb.addImage({ buffer: buf, extension: ext });
        // 使用 twoCellAnchor 绝对锚点，Calc 兼容性相对更好
        ws.addImage(imgId, {
          tl: { col: 6, row: rowIdx - 1 }, // G 列(0基=6)，当前行(0基=rowIdx-1)
          ext: { width: IMG_W, height: IMG_H },
          editAs: "oneCell", // 或 "twoCell"；这里用 oneCell，避免随单元格缩放
        });
      } catch (err) {
        // 抓图失败：在 G 列写超链接作为退化
        ws.getCell(`G${rowIdx}`).value = img
          ? { text: "Open Image", hyperlink: img }
          : url
          ? { text: "Open Image", hyperlink: url }
          : "";
      }
    }

    // 输出
    const buffer = await wb.xlsx.writeBuffer();

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    // ASCII 文件名，避免 header 无效字符
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    res
      .status(500)
      .json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
});

export default router;
