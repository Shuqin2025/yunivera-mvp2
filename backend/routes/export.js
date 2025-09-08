// backend/routes/export.js
// Excel 导出（含图片嵌入）

import { Router } from "express";
import ExcelJS from "exceljs";
import { URL } from "url";

const router = Router();

// 常量：UA / 超时 / 图片最大字节（可按需调大）
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const FETCH_TIMEOUT_MS = 15000;
const MAX_IMAGE_BYTES = 3_000_000; // 3MB

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 解析出 referer（优先使用该行产品页 url，其次用图片域名根路径）
function buildReferer(imgUrl, productUrlInRow, sourceUrl) {
  try {
    if (productUrlInRow) return productUrlInRow;
    if (sourceUrl) return sourceUrl;
    const u = new URL(imgUrl);
    return `${u.origin}/`;
  } catch {
    return "https://www.google.com/";
  }
}

async function fetchImageBuffer(imgUrl, { referer }) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(imgUrl, {
      method: "GET",
      redirect: "follow",
      signal: ctl.signal,
      headers: {
        "user-agent": UA,
        accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        referer, // 很多站点需要
      },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const ct = res.headers.get("content-type") || "";
    if (!/^image\//i.test(ct)) {
      throw new Error(`Not image: ${ct || "unknown content-type"}`);
    }

    // 读成 Buffer，并限制大小
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_IMAGE_BYTES) {
        throw new Error(`Image too large: ${total} bytes`);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((u) => Buffer.from(u)));
  } finally {
    clearTimeout(t);
  }
}

function ensureAbsoluteUrl(maybeUrl, baseUrl) {
  try {
    const u = new URL(maybeUrl);
    return u.toString();
  } catch {
    if (!baseUrl) return maybeUrl;
    try {
      const b = new URL(baseUrl);
      return new URL(maybeUrl, b.origin).toString();
    } catch {
      return maybeUrl;
    }
  }
}

router.post("/excel", async (req, res) => {
  try {
    const { source, rows } = req.body || {};
    // rows: [{ title, sku, price, moq, url, img }, ...]

    if (!Array.isArray(rows) || rows.length === 0) {
      return res
        .status(400)
        .json({ ok: false, error: "rows empty or invalid" });
    }

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("抓取目录（前 50 条）");

    // 头部样式
    const th = {
      font: { bold: true },
      alignment: { vertical: "middle", horizontal: "center", wrapText: true },
      border: {
        top: { style: "thin" },
        left: { style: "thin" },
        bottom: { style: "thin" },
        right: { style: "thin" },
      },
    };

    // 列定义：A:序号 B:标题 C:SKU D:价格 E:MOQ F:URL G:图片
    ws.columns = [
      { header: "#", key: "idx", width: 5 },
      { header: "标题/Title", key: "title", width: 48 },
      { header: "SKU", key: "sku", width: 16 },
      { header: "价格/Price", key: "price", width: 14 },
      { header: "MOQ", key: "moq", width: 10 },
      { header: "链接/URL", key: "url", width: 90 },
      { header: "图片/Image", key: "img", width: 22 },
    ];

    // 顶部标题行
    ws.addRow(["Source:", source || ""]).font = { bold: true };
    ws.addRow([]); // 空行
    ws.addRow(ws.columns.map((c) => c.header));
    ws.getRow(3).eachCell((cell) => Object.assign(cell, { style: th }));

    // 正文行
    // 统一的单元格边框
    const borderCell = (cell) => {
      cell.border = {
        top: { style: "hair" },
        left: { style: "hair" },
        bottom: { style: "hair" },
        right: { style: "hair" },
      };
      cell.alignment = { vertical: "top", wrapText: true };
    };

    // 每行高度：给图片留空间
    const ROW_HEIGHT = 26; // 基础
    const PIC_ROW_HEIGHT = 130; // 有图片时

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || {};
      const rowIndex = 4 + i; // 从第 4 行开始
      const productUrlAbs = ensureAbsoluteUrl(r.url || "", source);
      const imgUrlAbs = ensureAbsoluteUrl(r.img || "", source);

      // 添加一行数据
      ws.addRow({
        idx: i + 1,
        title: r.title || "",
        sku: r.sku || "",
        price: r.price ?? "",
        moq: r.moq ?? "",
        url: productUrlAbs || "",
        img: "", // 图片列先空着
      });

      const row = ws.getRow(rowIndex);
      row.height = ROW_HEIGHT;

      row.eachCell(borderCell);

      // URL 变为超链接
      if (productUrlAbs) {
        const cell = ws.getCell(rowIndex, 6); // F 列
        cell.value = {
          text: productUrlAbs,
          hyperlink: productUrlAbs,
        };
        cell.font = { color: { argb: "FF1B73E8" }, underline: true };
      }

      // —— 下载并嵌入图片（如果有 img 字段）——
      if (imgUrlAbs) {
        try {
          const referer = buildReferer(
            imgUrlAbs,
            productUrlAbs || "",
            source || ""
          );

          const buf = await fetchImageBuffer(imgUrlAbs, { referer });

          // 加图片到 workbook
          const ext = imgUrlAbs.toLowerCase().endsWith(".png") ? "png" : "jpeg";
          const imgId = wb.addImage({
            buffer: buf,
            extension: ext,
          });

          // 目标单元格（G 列）
          const col = 7; // G
          const rowTop = rowIndex;

          // 放到 G 列单元格内部，按比例缩放（宽 ≈ 180px，高 ≈ 120px）
          // 注意：exceljs 单位是像素（绝大多数查看器兼容）
          ws.addImage(imgId, {
            tl: { col: col - 1 + 0.15, row: rowTop - 1 + 0.15 },
            ext: { width: 180, height: 120 },
            editAs: "oneCell",
          });

          // 行高拉高，便于展示
          row.height = PIC_ROW_HEIGHT;
        } catch (err) {
          // 失败则兜底：给个“Open Image”超链接
          console.error(
            `[excel] image fetch failed @ row ${i + 1}: ${imgUrlAbs} -> ${
              err?.message || err
            }`
          );
          const cell = ws.getCell(rowIndex, 7); // G 列
          cell.value = { text: "Open Image", hyperlink: imgUrlAbs };
          cell.font = { color: { argb: "FF1B73E8" }, underline: true };
        }
      }

      // 小憩一下，避免触发对方站点速率限制
      await sleep(80);
    }

    // 冻结标题行
    ws.views = [{ state: "frozen", ySplit: 3 }];

    // Content-Disposition：尽量用 ASCII 文件名，避免“Invalid character in header”问题
    const fname = "catalog-export.xlsx";
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);

    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("[excel] export error:", err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

export default router;
