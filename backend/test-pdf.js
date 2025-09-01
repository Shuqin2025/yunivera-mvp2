// backend/test-pdf.js
import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 输出路径
const outputPath = path.join(__dirname, "test.pdf");

// 创建 PDF 文档
const doc = new PDFDocument({ size: "A4", margin: 56 });
const stream = fs.createWriteStream(outputPath);

// 捕获错误
doc.on("error", (err) => {
  console.error("[PDF ERROR]", err);
});
stream.on("error", (err) => {
  console.error("[Stream ERROR]", err);
});
stream.on("finish", () => {
  console.log(`✅ PDF 已生成: ${outputPath}`);
  console.log("👉 请下载 test.pdf 并尝试打开");
});

doc.pipe(stream);

// 中文字体支持（可选，如果你有 backend/fonts/NotoSansSC-Regular.ttf）
const zhFontPath = path.join(__dirname, "fonts", "NotoSansSC-Regular.ttf");
if (fs.existsSync(zhFontPath)) {
  try {
    doc.registerFont("zh", zhFontPath);
    doc.font("zh");
  } catch (e) {
    console.warn("⚠️ 注册中文字体失败，使用默认字体:", e?.message || e);
  }
}

// 内容
doc.fontSize(20).text("测试报价单", { align: "center" });
doc.moveDown();
doc.fontSize(12).text("这是一个由 test-pdf.js 本地生成的 PDF 文件，用于验证 PDFKit 输出是否正常。");
doc.text("如果这个 PDF 可以正常打开，说明 PDFKit 没有问题。");

// 结束
doc.end();
