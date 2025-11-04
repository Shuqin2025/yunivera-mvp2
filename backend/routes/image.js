// backend/routes/image.js
import { Router } from "express";
import axios from "axios";

const router = Router();

router.get("/", async (req, res) => {
  const url = String(req.query.url || "").trim();
  const format = String(req.query.format || "raw").toLowerCase();
  if (!url) return res.status(400).json({ ok: false, error: "missing url" });

  try {
    const r = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 15000,
      validateStatus: () => true,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        // 有些站要 Referer 才给图
        "Referer": (() => { try { return new URL(url).origin; } catch { return ""; } })()
      }
    });

    if (format === "raw") {
      res.setHeader("Content-Type", r.headers["content-type"] || "image/jpeg");
      res.status(200).send(Buffer.from(r.data));
      return;
    }

    // base64
    const ct = r.headers["content-type"] || "image/jpeg";
    const base64 = Buffer.from(r.data).toString("base64");
    res.json({ ok: true, contentType: ct, base64 });
  } catch (e) {
    res.status(200).json({ ok: false, error: e?.message || String(e) });
  }
});

export default router;
