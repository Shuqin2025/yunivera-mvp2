import { Router } from "express";
import axios from "axios";

const router = Router();

// GET /v1/api/image?format=base64&url=...  或  /v1/api/image?format=raw&url=...
// ⚠️ 路由前缀改为 /image（在 server.js 挂载到 /v1/api），避免 404:contentReference[oaicite:1]{index=1}
router.get("/image", async (req, res) => {
  const url = String(req.query.url || "").trim();
  const fmt = String(req.query.format || "raw").toLowerCase();  // 默认 format=raw:contentReference[oaicite:2]{index=2}
  if (!url) {
    return res.status(400).json({ ok: false, error: "missing url" });
  }

  try {
    // 以目标站点 origin 伪造 Referer，防范防盗链
    let referer = "";
    try {
      referer = new URL(url).origin;
    } catch {}
    const r = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 20000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122 Safari/537.36",
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "Referer": referer || url
      },
      validateStatus: () => true,   // 接受所有状态码，由我们自行判断
      maxRedirects: 5
    });

    const buf = Buffer.from(r.data || []);                        // 图像数据 Buffer
    const ct = String(r.headers["content-type"] || "image/jpeg"); // 内容类型（默认 jpeg）

    if (fmt === "base64") {
      // 返回 Base64 编码字符串（不带 data 前缀），及内容类型:contentReference[oaicite:3]{index=3}
      return res.json({
        ok: r.status >= 200 && r.status < 400,
        base64: buf.toString("base64"),
        contentType: ct,
        status: r.status
      });
    }

    //  format=raw，直接输出图片二进制，并设置内容类型和缓存头
    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    return res.status(r.status || 200).send(buf);
  } catch (e) {
    // 出错容错：返回 JSON，避免 Excel 导出端 fetch 时因 HTTP 错误无法解析响应
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
});

export default router;
