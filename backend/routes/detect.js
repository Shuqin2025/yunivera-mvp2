// backend/routes/detect.js
// 极简目录识别/探测接口：GET /v1/detect?url=<page url>
import express from 'express';
import fetch from 'node-fetch';

import detectStructure from '../lib/structureDetector.js';   // 已有模块
import parseWithTemplate from '../lib/templateParser.js';    // 已有模块

const router = express.Router();

router.get('/detect', async (req, res) => {
  const url = (req.query.url || '').trim();

  if (!url) {
    return res.status(400).json({ ok: false, error: 'missing url' });
  }

  const t0 = Date.now();
  try {
    // 1) 抓页面
    const r = await fetch(url, { redirect: 'follow' });
    const html = await r.text();

    // 2) 结构检测（轻量）
    const kind = detectStructure(html); // 可能返回 'catalog' | 'detail' | 'unknown' 等
    const result = { ok: true, url, kind, http: r.status };

    // 3) 如果是目录页，做一次非常轻的解析尝试（不持久化，只验证模板是否能跑起来）
    if (kind === 'catalog') {
      try {
        const preview = await parseWithTemplate(html, { sampleOnly: true });
        // 仅回传少量字段，避免 payload 过大
        result.preview = {
          items: Array.isArray(preview?.items) ? preview.items.slice(0, 5) : [],
          total: preview?.total ?? undefined,
        };
      } catch (e) {
        // 解析失败不算致命，记录下来即可
        result.preview = { error: e?.message || String(e) };
      }
    }

    result.duration_ms = Date.now() - t0;
    return res.json(result);
  } catch (err) {
    return res.status(502).json({
      ok: false,
      url,
      error: err?.message || String(err),
      duration_ms: Date.now() - t0,
    });
  }
});

export default router;
