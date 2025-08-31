// backend/routes/scrape.js
import { Router } from 'express';

const router = Router();

/** 共用的抓取函数 */
async function doScrape(targetUrl) {
  // 简单校验
  try {
    new URL(targetUrl);
  } catch {
    return { status: 400, body: { ok: false, error: 'Invalid url' } };
  }

  try {
    const resp = await fetch(targetUrl, { redirect: 'follow' });
    const html = await resp.text();

    // 很简化的抽取逻辑：标题 / h1 / 预览 / 文本长度
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const h1Matches = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map(m =>
      m[1].replace(/<[^>]+>/g, '').trim()
    );
    const textOnly = html.replace(/<script[\s\S]*?<\/script>/gi, '')
                         .replace(/<style[\s\S]*?<\/style>/gi, '')
                         .replace(/<[^>]+>/g, ' ');
    const approxTextLength = textOnly.trim().length;

    // 预览（前 600 字）
    const preview = textOnly.replace(/\s+/g, ' ').trim().slice(0, 600);

    return {
      status: 200,
      body: {
        ok: true,
        url: targetUrl,
        fetchedAt: Date.now(),
        title: titleMatch ? titleMatch[1].trim() : '',
        description: '',
        h1: h1Matches,
        approxTextLength,
        preview,
        vendor: 'generic',
        price: null,
        currency: null,
        moq: null,
        sku: null,
        images: [],
      },
    };
  } catch (e) {
    return { status: 500, body: { ok: false, error: 'FETCH_FAIL', message: String(e) } };
  }
}

/** GET 兼容：/v1/api/scrape?url=... */
router.get('/', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ ok: false, error: 'Missing url' });

  const result = await doScrape(url);
  res.status(result.status).json(result.body);
});

/** POST 推荐：/v1/api/scrape   body: { url } */
router.post('/', async (req, res) => {
  const url = req.body?.url;
  if (!url) return res.status(400).json({ ok: false, error: 'Missing url' });

  const result = await doScrape(url);
  res.status(result.status).json(result.body);
});

export default router;
