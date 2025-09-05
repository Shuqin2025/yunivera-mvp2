// backend/server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

// 路由
import quoteRoutes from "./routes/quote.js";
import scrapeRoutes from "./routes/scrape.js";
import matchRoutes from "./routes/match.js";
import pdfRoutes from "./routes/pdf.js";
import catalogRoutes from "./routes/catalog.js";  // ✅ 目录抓取（已有则保留）

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// CORS
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept"],
  })
);

// JSON 解析
app.use(express.json({ limit: "4mb" }));

// 静态文件（未来可用：/backend/files）—— 现在不要求持久化，也可用于预览
const filesDir = path.join(__dirname, "files");
if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir);
app.use("/files", express.static(filesDir));

/**
 * 路由挂载顺序 —— 重点！
 * 把新路由放在 quoteRoutes 之前，避免被旧接口拦截
 */
app.use("/v1/api/pdf", pdfRoutes);         // ✅ 生成 PDF
app.use("/v1/api/scrape", scrapeRoutes);   // ✅ 抓取单页
app.use("/v1/api/match", matchRoutes);     // ✅ 对比匹配
app.use("/v1/api/catalog", catalogRoutes); // ✅ 抓取目录（若无此路由请忽略）
app.use("/v1/api", quoteRoutes(filesDir)); // 其余老接口仍挂 /v1/api 下

// 健康检查
app.get("/v1/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "quote",
    version: "quote-v3-hf-ellipsis",
    ts: Date.now(),
  });
});

// 根路径兜底
app.get("/", (_req, res) => {
  res.type("text/plain").send("mvp2-backend is running. Try /v1/api/health");
});

const port = process.env.PORT || 5188;
const host = "0.0.0.0";

app.listen(port, host, () => {
  console.log(`[mvp2-backend] listening at http://${host}:${port}`);
});
