// backend/routes/image.js
import { Router } from "express";
import axios from "axios";

const router = Router();

// GET /v1/api/image?format=base64&url=...
// GET /v1/api/image?format=raw&url=...
router.get("/", async (req, res) => {
  const url = String(req.query.url || "").trim();
  const format = String(req.query.format || "base64").toLowerCase();
  if (!url) return res.status(400).json({ ok: false, error: "missing url" });

  try {
    // 反防盗链：伪造 Referer 为目标站点 origin
    let referer = "";
    try { referer = new URL(url).origin; } catch {}

    const r = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 15000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
        "Accept":
          "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        ...(referer ? { Referer: referer } : {}),
      },
      validateStatus: () => true,
    });

    if (r.status >= 400 || !r.data) {
      return res.status(502).json({ ok: false, error: `upstream ${r.status}` });
    }

    const ct =
      (r.headers["content-type"] || "").split(";")[0] || "image/jpeg";

    if (format === "raw") {
      res.setHeader("Content-Type", ct);
      return res.status(200).send(Buffer.from(r.data));
    }

    const base64 = Buffer.from(r.data).toString("base64");
    return res.json({ ok: true, contentType: ct, base64 });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, error: e.message || String(e) });
  }
});

export default router;
