// backend/routes/quote.js
import { Router } from 'express';

/**
 * 创建路由。保持与 server.js 中 app.use('/v1/api', routes(filesDir)) 的调用方式兼容。
 * @param {string} filesDir - 传入的文件目录路径（本文件中暂时不使用，但保留以兼容调用签名）
 * @returns {import('express').Router}
 */
export default function createRoutes(filesDir) {
  const router = Router();

  // 健康检查：GET /v1/api/health
  router.get('/health', (req, res) => {
    res.json({ ok: true, message: 'OK' });
  });

  /**
   * 生成报价/推荐语的接口（占位实现）
   * 前端如果发送 JSON：{ rows: [...], lang: 'zh', mode: 'A' }，这里直接回传。
   * 如需真实逻辑，再把计算填进去即可。
   */
  router.post('/quote', async (req, res) => {
    try {
      const { rows = [], lang = 'zh', mode = 'A' } = req.body || {};
      // TODO: 在这里做真实的报价与推荐语计算
      res.json({
        ok: true,
        data: {
          mode,
          lang,
          rows,
          tips: '这是占位响应：在此处实现真实的报价与推荐语逻辑。',
        },
      });
    } catch (err) {
      console.error('[quote] error:', err);
      res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
    }
  });

  /**
   * 如果你的前端还有调用 /v1/api/pdf，这里给个占位实现，避免 404。
   * 之后你可以改成真实的 PDF 生成。
   */
  router.post('/pdf', async (req, res) => {
    try {
      const { title = '报价单', content = '内容占位' } = req.body || {};
      res.json({
        ok: true,
        message: 'PDF 占位接口：这里未真正生成 PDF，仅回显请求数据。',
        echo: { title, content },
      });
    } catch (err) {
      console.error('[pdf] error:', err);
      res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
    }
  });

  return router;
}
