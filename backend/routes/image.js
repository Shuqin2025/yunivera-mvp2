// backend/routes/image.js
import { Router } from "express";
import axios from "axios";

const router = Router();

/**
 * GET /v1/api/image?format=base64&url=...
 * GET /v1/api/image?format=raw&url=...
 *
 * - 统一 CORS：仅回显请求方 Origin，避免 “multiple Access-Control-Allow-Origin values”
 * - 防盗链：Referer 伪造成目标站点 origin
 * - 支持 302 跟随
 * - format=raw 直接回传图片（可作为 <img src> 使用）
 * - format=base64 回传 { ok, contentType, base64 }
 */
router.get("/", async (req, res) => {
  const url = String(req.query.url || "").trim();
  const format = String(req.query.format || "base64").toLowerCase();

  const setCORS = () => {
    const o = req.headers.origin;
    if (o) res.setHeader("Access-Control-Allow-Origin", o);
    res.setHeader("Vary", "Origin");
  };

  if (!url) {
    setCORS();
    return res.status(400).json({ ok: false, error: "missing url" });
  }

  try {
    let referer = "";
    try { referer = new URL(url).origin; } catch {}

    const r = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 20000,
      maxRedirects: 5,
      validateStatus: () => true,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        ...(referer ? { Referer: referer } : {}),
      },
    });

    setCORS();

    if (r.status >= 400 || !r.data) {
      return res.status(200).json({ ok: false, status: r.status, error: "upstream error" });
    }

    const ct = (r.headers["content-type"] || "").split(";")[0] || "image/jpeg";

    if (format === "raw") {
      res.setHeader("Content-Type", ct);
      res.setHeader("Cache-Control", "public, max-age=86400, immutable");
      return res.status(200).send(Buffer.from(r.data));
    }

    const base64 = Buffer.from(r.data).toString("base64");
    return res.json({ ok: true, contentType: ct, base64 });
  } catch (e) {
    setCORS();
    return res.status(200).json({ ok: false, error: e?.message || String(e) });
  }
});

export default router;
