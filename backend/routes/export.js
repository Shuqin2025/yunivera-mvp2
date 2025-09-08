// backend/routes/export.js
import { Router } from "express";
import ExcelJS from "exceljs";

const router = Router();

// ===== 抓图：带 Referer，超时与体积保护 =====
async function fetchImageBuffer(imgUrl, productUrl, {
  timeoutMs = 12_000,
  maxBytes = 1_800_000
} = {}) {
  if (!imgUrl) return { ok: false, reason: "no_img" };

  // 组装 Referer：优先商品页；其次图片同域根；最后留空
  let referer = "";
  try {
    if (productUrl) referer = productUrl;
    if (!referer) referer = new URL(imgUrl).origin + "/";
  } catch (_) { /* ignore */ }

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(imgUrl, {
      method: "GET",
      signal: ctrl.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        "accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "referer": referer,
        // 有些站会看这个
        "sec-fetch-mode": "no-cors"
      },
      redirect: "follow"
    });

    if (!res.ok) {
      return { ok: false, reason: `http_${res.status}` };
    }
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (!ct.startsWith("image/")) {
      return { ok: false, reason: `not_image(${ct || "unknown"})` };
    }

    // 流式读取并限制大小
    const reader = res.body.getReader();
    let received = 0;
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) return { ok: false, reason: "too_large" };
      chunks.push(value);
    }
    const buf = Buffer.concat(chunks.map(u => Buffer.from(u)));
    // 推断扩展名
    let ext = "jpeg";
    if (ct.includes("png")) ext = "png";
    else if (ct.includes("gif")) ext = "gif";
    else if (ct.includes("bmp")) ext = "bmp";
    else if (ct.includes("webp")) ext = "png"; // Excel 不直接支持 webp，转成 png 更安全（此处先按 png 标注）

    return { ok: true, buf, ext };
  } catch (e) {
    const msg = (e && e.name === "AbortError") ? "timeout" : (e?.message || "fetch_err");
    return { ok: false, reason: msg };
  } finally {
    clearTimeout(to);
  }
}

// ===== 样式小工具 =====
function thStyle(cell) {
  cell.font = { bold: true };
  cell.alignment = { vertical: "middle", horizontal: "left" };
  cell.border = {
    bottom: { style: "thin", color: { argb: "FF888888" } }
  };
}

router.post("/excel", async (req, res) => {
  try {
    const { source = "", rows = [] } = req.body || {};
    const wb = new ExcelJS.Workbook();
    wb.creator = "MVP3-Frontend";
    const ws = wb.addWorksheet("抓取目录（前 50 条）", {
      properties: { defaultRowHeight: 18 }
    });

    // 表头
    ws.getCell("A1").value = "【抓取目录（前 50 条）】";
    ws.mergeCells("A1:G1");
    ws.getCell("A2").value = "Source:";
    ws.getCell("B2").value = source;

    // 列头
    const headerRowIdx = 3;
    const header = ["#", "标题/Title", "SKU", "价格/Price", "MOQ", "链接/URL", "图片/Image"];
    ws.getRow(headerRowIdx).values = header;
    ws.columns = [
      { key: "idx", width: 5 },
      { key: "title", width: 58 },
      { key: "sku", width: 14 },
      { key: "price", width: 14 },
      { key: "moq", width: 8 },
      { key: "url", width: 110 },
      { key: "img", width: 18 }
    ];
    ws.getRow(headerRowIdx).eachCell(thStyle);

    // 数据起始行
    let r = headerRowIdx + 1;

    // 逐行写入 + 抓图
    for (let i = 0; i < rows.length; i++) {
      const { title = "", sku = "", price = "", moq = "", url = "", img = "" } = rows[i] || {};

      ws.getCell(`A${r}`).value = i + 1;
      ws.getCell(`B${r}`).value = title || "";
      ws.getCell(`C${r}`).value = sku || "";
      ws.getCell(`D${r}`).value = price || "";
      ws.getCell(`E${r}`).value = moq || "";

      // 商品链接超链接
      if (url) {
        ws.getCell(`F${r}`).value = { text: url, hyperlink: url };
        ws.getCell(`F${r}`).font = { color: { argb: "FF0563C1" }, underline: true };
      } else {
        ws.getCell(`F${r}`).value = "";
      }

      // —— 图片抓取（带 Referer）——
      let placed = false;
      if (img) {
        const ret = await fetchImageBuffer(img, url);
        if (ret.ok) {
          try {
            const imgId = wb.addImage({
              buffer: ret.buf,
              extension: ret.ext === "jpg" ? "jpeg" : ret.ext
            });
            // 保持行高以能看到图（可按需调整）
            ws.getRow(r).height = Math.max(ws.getRow(r).height || 18, 110);
            // 把图片放到第 G 列这一行的单元格里（稍留内边距）
            ws.addImage(imgId, {
              tl: { col: 6 + 0.2, row: r - 1 + 0.2 }, // G 列 = 第 7 列，0-based => 6
              br: { col: 6 + 0.2 + 2.6, row: r - 1 + 0.2 + 1.8 } // 大约 260x180 像素
            });
            placed = true;
          } catch (_) {
            placed = false;
          }
        }
      }

      // 抓图失败 → 放“Open Image”占位链接兜底
      if (!placed) {
        if (img) {
          ws.getCell(`G${r}`).value = { text: "Open Image", hyperlink: img };
          ws.getCell(`G${r}`).font = { color: { argb: "FF0563C1" }, underline: true };
        } else {
          ws.getCell(`G${r}`).value = "";
        }
      }

      r++;
    }

    // 输出
    res.setHeader("Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''catalog-export.xlsx; filename="catalog-export.xlsx"`
    );

    const buf = await wb.xlsx.writeBuffer();
    return res.status(200).send(Buffer.from(buf));
  } catch (err) {
    console.error("[/v1/api/export/excel] error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "EXPORT_FAILED" });
  }
});

export default router;
