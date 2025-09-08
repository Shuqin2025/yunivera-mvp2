// backend/routes/export.js
// 导出 Excel（含嵌入图片）
import { Router } from "express";
import ExcelJS from "exceljs";

const router = Router();

// 简单 UA，部分站点会拦截默认 UA
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

/**
 * 下载图片为 Buffer（带超时/大小限制/类型校验）
 * @param {string} imgUrl
 * @param {number} timeoutMs
 * @param {number} maxBytes
 * @returns {Promise<{buffer: Buffer, ext: 'png' | 'jpeg'}>}
 */
async function fetchImageBuffer(imgUrl, timeoutMs = 10000, maxBytes = 2_000_000) {
  if (!imgUrl) throw new Error("empty image url");

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(imgUrl, {
      headers: { "user-agent": UA, accept: "image/*" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${imgUrl}`);

    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (!ct.startsWith("image/")) throw new Error(`Not an image: ${ct}`);

    let received = 0;
    const reader = res.body.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) throw new Error("image too large");
      chunks.push(value);
    }
    const buffer = Buffer.concat(chunks.map((u) => Buffer.from(u)));
    const ext = ct.includes("png") ? "png" : "jpeg";
    return { buffer, ext };
  } finally {
    clearTimeout(t);
  }
}

/**
 * 生成 Excel（含图片）
 * body: { source?: string, rows: Array<{title, sku, price, moq, url, img}> }
 */
router.post("/excel", async (req, res) => {
  try {
    const { source = "", rows = [] } = req.body || {};
    if (!Array.isArray(rows)) {
      return res.status(400).json({ ok: false, error: "rows must be an array" });
    }

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("抓取目录（前 50 条）");

    // 列定义：A:#  B:标题  C:SKU  D:价格  E:MOQ  F:URL(超链接)  G:图片
    ws.columns = [
      { header: "#", key: "idx", width: 5 },
      { header: "标题/Title", key: "title", width: 42 },
      { header: "SKU", key: "sku", width: 14 },
      { header: "价格/Price", key: "price", width: 14 },
      { header: "MOQ", key: "moq", width: 10 },
      { header: "链接/URL", key: "url", width: 80 },
      { header: "图片/Image", key: "img", width: 34 }, // 宽一些给图片
    ];

    // 顶部来源行
    ws.addRow(["Source:", source]);
    ws.addRow([]); // 空一行

    // 表头样式
    const headerRow = ws.addRow(
      ws.columns.map((c) => c.header)
    );
    headerRow.font = { bold: true };
    headerRow.alignment = { vertical: "middle", horizontal: "center" };
    headerRow.eachCell((cell) => {
      cell.border = {
        top: { style: "thin" },
        left: { style: "thin" },
        bottom: { style: "thin" },
        right: { style: "thin" },
      };
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFEFEFEF" },
      };
    });

    // 开始插入数据
    // 图片放 G 列（第 7 列，image anchor 使用 0-based 坐标）
    const imgColZeroBased = 6;
    const imageBox = { width: 120, height: 120 }; // 图片显示尺寸
    const dataStartRow = ws.lastRow.number + 1;

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || {};
      const excelRow = ws.addRow({
        idx: i + 1,
        title: r.title ?? "",
        sku: r.sku ?? "",
        price: r.price ?? "",
        moq: r.moq ?? "",
        url: r.url ?? "",
        img: "", // 占位
      });

      // URL 做成超链接
      if (r.url) {
        const c = excelRow.getCell("url");
        c.value = { text: r.url, hyperlink: r.url };
        c.font = { color: { argb: "FF1E78D7" }, underline: true };
      }

      // 行高给图片留空间
      excelRow.height = 95;

      // 尝试下载图片并嵌入
      if (r.img) {
        try {
          const { buffer, ext } = await fetchImageBuffer(r.img);
          const imgId = wb.addImage({ buffer, extension: ext });
          const rowIdx0 = excelRow.number - 1; // 0-based

          ws.addImage(imgId, {
            tl: { col: imgColZeroBased, row: rowIdx0 }, // 左上角
            ext: { width: imageBox.width, height: imageBox.height }, // 尺寸
            // 也可以改成 'editAs: "oneCell"' 以适应单元格
          });
        } catch (e) {
          // 下载失败就忽略，不阻断导出
          // 你也可以把错误写进某列：excelRow.getCell('img').value = 'IMG ERR';
        }
      }

      // 给数据行画个细边框，观感更清爽
      excelRow.eachCell((cell) => {
        cell.alignment = { vertical: "middle" };
        cell.border = {
          top: { style: "thin" },
          left: { style: "thin" },
          bottom: { style: "thin" },
          right: { style: "thin" },
        };
      });
    }

    // 冻结首行标题（数据部分的标题行）
    ws.views = [{ state: "frozen", ySplit: dataStartRow - 1 }];

    // 生成二进制并输出
    const buffer = await wb.xlsx.writeBuffer();
    const filename = "catalog-export.xlsx"; // 只用 ASCII，避免 header 报错

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
    return res.status(200).send(Buffer.from(buffer));
  } catch (err) {
    console.error("EXPORT ERROR:", err);
    return res.status(500).json({ ok: false, error: String(err && err.message || err) });
  }
});

export default router;
