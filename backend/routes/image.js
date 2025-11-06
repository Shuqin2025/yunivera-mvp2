// backend/routes/image.js
import express from "express";
import axios from "axios";

const router = express.Router();

async function handler(req, res) {
  const url = String(req.query.url || "").trim();
  const format = String(req.query.format || "raw").toLowerCase();

  if (!url) {
    return res.status(400).json({ ok: false, error: "missing url" });
  }

  try {
    const r = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 20000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "Accept-Language": "de,en;q=0.9,zh;q=0.8",
        Referer: url,
      },
      validateStatus: () => true,
      maxRedirects: 5,
    });

    const buf = Buffer.from(r.data || []);
    const ct = String(r.headers["content-type"] || "application/octet-stream");
    const ok = r.status >= 200 && r.status < 400;

    if (format === "base64") {
      // 给前端 ExcelJS 用的协议
      return res.json({
        ok,
        contentType: ct,
        base64: buf.toString("base64"), // 纯 base64（前端 export-xlsx.js 已会处理 data: 前缀）
        status: r.status,
      });
    }

    // raw：透传图片流
    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    return res.status(r.status || 200).send(buf);
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}

// ✅ 支持 /v1/api/image 与历史 /v1/api/image/image 两种写法
router.get("/", handler);
router.get("/image", handler);

export default router;
