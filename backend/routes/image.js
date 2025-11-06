import express from 'express';
import axios from 'axios';

const router = express.Router();

router.get('/image', async (req, res) => {
  const url = String(req.query.url || "").trim();
  const fmt = String(req.query.format || "raw").toLowerCase();
  if (!url) return res.status(400).json({ ok:false, error:'missing url' });

  try {
    const r = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Referer': url
      },
      validateStatus: () => true,
      maxRedirects: 5,
    });

    const buf = Buffer.from(r.data || []);
    const ct = String(r.headers['content-type'] || 'image/jpeg');

    if (fmt === 'base64') {
      return res.json({
        ok: r.status >= 200 && r.status < 400,
        base64: buf.toString('base64'),
        contentType: ct,
        status: r.status,
      });
    }

    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    return res.status(r.status || 200).send(buf);
  } catch (e) {
    return res.status(200).json({ ok:false, error: String(e?.message || e) });
  }
});

export default router;
