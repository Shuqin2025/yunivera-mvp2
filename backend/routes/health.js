import { Router } from 'express';

const router = Router();

// 主健康检查：Render/负载均衡用
router.get('/v1/health', (_req, res) => {
  res.status(200).json({ ok: true, ts: Date.now() });
});

// 兼容一些云平台的默认探针路径
router.get('/healthz',  (_req, res) => res.status(200).send('ok'));
router.get('/livez',    (_req, res) => res.status(200).send('ok'));

export default router;
