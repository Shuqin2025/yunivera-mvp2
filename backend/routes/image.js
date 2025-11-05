// backend/routes/image.js
import { Router } from "express";
import axios from "axios";

const router = Router();

// GET /v1/api/image?format=base64&url=...
// GET /v1/api/image?format=raw&url=...
router.get("/", async (req, res) => {
  const url = String(req.query.url || "").trim();
  const format = String(req.query.format || "base64").toLowerCase();

  if (!url) {
    // 统一返回一个 Origin，避免“multiple values”
    const o = req.headers.origin;
    if (o) res.setHeader("Access-Control-Allow-Origin", o);
    res.setHeader("Vary", "Origin");
    return res.status(400).json({ ok: false, error: "missing url" });
  }

  try {
    // 反防盗链：伪造 Referer 为目标站点 origin
    let referer = "";
    try { referer = new URL(url).origin; } catch {}

    const r = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 20000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        ...(referer ? { Referer: referer } : {}),
      },
      validateStatus: () => true,
      maxRedirects: 5,
    });

    const o = req.headers.origin;
    if (o) res.setHeader("Access-Control-Allow-Origin", o);
    res.setHeader("Vary", "Origin");

    if (r.status >= 400 || !r.data) {
      return res.status(200).json({ ok: false, status: r.status, error: "upstream error" });
    }

    const ct = (r.headers["content-type"] || "").split(";")[0] || "image/jpeg";

    if (format === "raw") {
      res.setHeader("Content-Type", ct);
      // 轻缓存
      res.setHeader("Cache-Control", "public, max-age=86400, immutable");
      return res.status(200).send(Buffer.from(r.data));
    }

    const base64 = Buffer.from(r.data).toString("base64");
    return res.json({ ok: true, contentType: ct, base64 });
  } catch (e) {
    const o = req.headers.origin;
    if (o) res.setHeader("Access-Control-Allow-Origin", o);
    res.setHeader("Vary", "Origin");
    return res.status(200).json({ ok: false, error: e?.message || String(e) });
  }
});

export default router;
