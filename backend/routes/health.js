import { Router } from 'express';

const router = Router();

// Render / health endpoints for LB and uptime checks
router.get('/v1/health', (_req, res) => {
  res.status(200).json({ ok: true, ts: Date.now() });
});

// Aliases often used by cloud platforms
router.get('/healthz', (_req, res) => res.status(200).send('ok'));
router.get('/livez', (_req, res) => res.status(200).send('ok'));

export default router;
