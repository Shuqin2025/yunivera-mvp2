// backend/routes/quote.js
import express from 'express';

/**
 * 路由工厂
 * @param {string} filesDir - 后端 /files 静态目录的绝对路径（来自 server.js 传入）
 * @returns {express.Router}
 */
export default function createRoutes(filesDir) {
  const router = express.Router();

  // --- 工具函数：简单校验 ---
  const normalizeRows = (rows) => {
    if (!Array.isArray(rows)) return [];
    return rows.map((r, i) => {
      const name = String(r?.name || '').trim();
      const sku  = String(r?.sku  || '').trim();
      // 价格用英文小数点
      const price = Number(String(r?.price || '0').replace(',', '.')) || 0;
      const moq   = Number(r?.moq || 0) || 0;
      // params 允许是对象或字符串
      let params = r?.params ?? {};
      if (typeof params === 'string') {
        try { params = JSON.parse(params); } catch { params = {}; }
      }
      return { idx: i, name, sku, price, moq, params };
    });
  };

  // --- 健康检查 ---
  router.get('/health', (req, res) => {
    res.json({ ok: true, service: 'quote', ts: Date.now() });
  });

  // --- 核心处理逻辑（供 /quote 与 /quote/generate 复用） ---
  const handleQuote = async (req, res) => {
    try {
      const { rows = [], lang = 'zh', mode = 'A' } = req.body || {};
      const data = normalizeRows(rows);

      if (!data.length) {
        return res.status(400).json({ ok: false, error: 'ROWS_REQUIRED' });
      }

      // 这里写你的业务逻辑：结构化报价、推荐语等
      // 为了先跑通，我们返回一个示例结果
      const summary = {
        count: data.length,
        currency: 'USD',
        mode,
        lang,
        total: data.reduce((s, r) => s + r.price * Math.max(1, r.moq || 1), 0),
      };

      const recommendations = data.map(r => ({
        sku: r.sku,
        text:
          lang === 'de'
            ? `Empfehlung: Prüfe Batterie ${r.params?.battery ?? 'N/A'} und ${r.params?.leds ?? '?'} LEDs.`
            : lang === 'en'
            ? `Recommendation: Check battery ${r.params?.battery ?? 'N/A'} and ${r.params?.leds ?? '?'} LEDs.`
            : `推荐语：请核对电池 ${r.params?.battery ?? 'N/A'} 与 ${r.params?.leds ?? '?'} 颗LED。`
      }));

      return res.json({
        ok: true,
        data,
        summary,
        recommendations,
      });
    } catch (err) {
      console.error('[quote] error:', err);
      return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
    }
  };

  // --- 主路径 ---
  router.post('/quote', handleQuote);
  // --- 兼容旧前端：/quote/generate 作为别名 ---
  router.post('/quote/generate', handleQuote);

  // --- 预留 PDF 接口（占位实现，先返回 JSON，后续接入真正PDF生成） ---
  router.post('/pdf', async (req, res) => {
    try {
      const { title = '报价单', content = '' } = req.body || {};
      return res.json({
        ok: true,
        message: 'PDF endpoint placeholder',
        hint: '接入真正的 PDF 生成后，返回 /files/<filename>.pdf 的可下载URL',
        echo: { title, content },
      });
    } catch (err) {
      console.error('[pdf] error:', err);
      return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
    }
  });

  return router;
}
