// backend/routes/compat.js
import { Router } from 'express';
import catalog from './catalog.js';
import match from './match.js';
import exportR from './export.js';
import quote from './quote.js';
import pdf from './pdf.js';
import health from './health.js'; // 你之前加过的 /v1/health

const r = Router();

// 兼容老路径 —— 等价映射到 /v1/api/*
r.use('/catalog', catalog);
r.use('/match', match);
r.use('/export', exportR);
r.use('/quote', quote);
r.use('/pdf', pdf);

// 也顺便暴露一个不带 v1 的健康检查（无伤大雅）
r.use('/health', health);

export default r;


/** ---- legacy aliases ---- */
r.get('/image', (req, res, next) => { req.url = '/api/image' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''); next(); });
r.get('/export-xlsx', (req, res, next) => { req.url = '/api/export-xlsx' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''); next(); });
r.get('/catalog/_probe', (req, res, next) => { req.url = '/api/catalog/_probe'; next(); });
