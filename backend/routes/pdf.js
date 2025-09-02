// backend/routes/pdf.js
import { Router } from "express";
import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const router = Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 兼容渲染到文件夹（可选）
const filesDir = path.join(__dirname, "..", "files");
if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true });

/**
 * POST /v1/api/pdf
 * body:
 *  - title: string
 *  - content?: string    // 正文
 *  - body?: string       // 也兼容 body 字段
 * query:
 *  - dl=1                // 触发下载；否则 inline 预览
 */
router.post("/", async (req, res) => {
  try {
    const { title = "报价单", content, body } = req.body || {};
    const text =
      typeof content === "string" && content.trim().length
        ? content
        : typeof body === "string"
        ? body
        : "";

    if (!title || !text) {
      return res
        .status(400)
        .json({ ok: false, error: "参数缺失：title 与 content/body 必填" });
    }

    // 下载或内联
    const inline = !("dl" in req.query);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `${inline ? "inline" : "attachment"}; filename="quote.pdf"`
    );

    // 创建 PDF 并直接 pipe 到响应（不会写坏文件，也不需要中间缓存）
    const doc = new PDFDocument({ size: "A4", margin: 56 });
    doc.pipe(res);

    // 尝试中文字体（可选）
    const zhFontPath = path.join(__dirname, "..", "fonts", "NotoSansSC-Regular.ttf");
    if (fs.existsSync(zhFontPath)) {
      try {
        doc.registerFont("zh", zhFontPath);
        doc.font("zh");
      } catch (e) {
        console.warn("[pdf] 注册中文字体失败，将使用默认字体:", e?.message || e);
      }
    }

    // 标题
    doc.fontSize(22).text(title, { align: "center" }).moveDown(1.2);

    // 正文
    doc.fontSize(12).text(text, {
      align: "left",
      lineGap: 4,
    });

    doc.end(); // 结束流
  } catch (err) {
    console.error("[/v1/api/pdf] INTERNAL_ERROR:", err);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: "INTERNAL_ERROR" });
    }
  }
});

export default router;
