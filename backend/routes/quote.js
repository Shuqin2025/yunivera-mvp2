// backend/routes/quote.js
import express from 'express'
import fs from 'fs'
import path from 'path'
import PDFDocument from 'pdfkit'

/**
 * 路由工厂
 * @param {string} filesDir backend/files 绝对路径（由 server.js 传入）
 */
export default function createRoutes(filesDir) {
  const router = express.Router()

  // ========== 小工具 ==========
  const normalizeRows = (rows) => {
    if (!Array.isArray(rows)) return []
    return rows.map((r, i) => {
      const name = String(r?.name ?? '').trim()
      const sku  = String(r?.sku  ?? '').trim()
      const price = Number(String(r?.price ?? '0').replace(',', '.')) || 0
      const moq   = Number(r?.moq ?? 0) || 0
      let params = r?.params ?? {}
      if (typeof params === 'string') {
        try { params = JSON.parse(params) } catch { params = {} }
      }
      return { idx: i + 1, name, sku, price, moq, params }
    })
  }

  const pad2 = (n) => String(n).padStart(2, '0')
  const tsName = () => {
    const d = new Date()
    return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  }

  // 在三个常见位置查找中文字体（NotoSansSC-Regular.ttf）
  const findCJKFont = () => {
    const candidates = [
      path.resolve(filesDir, '..', 'fonts', 'NotoSansSC-Regular.ttf'),
      path.resolve(process.cwd(), 'backend', 'fonts', 'NotoSansSC-Regular.ttf'),
      path.resolve(process.cwd(), 'fonts', 'NotoSansSC-Regular.ttf'),
    ]
    for (const p of candidates) {
      if (fs.existsSync(p)) return p
    }
    return null
  }

  // ========== 健康检查 ==========
  router.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'quote', ts: Date.now() })
  })

  // （可选）调试：查看后端是否能找到字体
  router.get('/debug/font', (_req, res) => {
    const p = findCJKFont()
    res.json({ ok: true, fontPath: p, exists: !!p })
  })

  // ========== 核心报价逻辑（供两个路径复用） ==========
  const handleQuote = async (req, res) => {
    try {
      const { rows = [], lang = 'zh', mode = 'A' } = req.body || {}
      const data = normalizeRows(rows)
      if (!data.length) {
        return res.status(400).json({ ok: false, error: 'ROWS_REQUIRED' })
      }

      const summary = {
        count: data.length,
        currency: 'USD',
        mode, lang,
        total: data.reduce((s, r) => s + r.price * Math.max(1, r.moq || 1), 0),
      }

      const recommendations = data.map(r => ({
        sku: r.sku,
        text:
          lang === 'de'
            ? `Empfehlung: Prüfe Batterie ${r.params?.battery ?? 'N/A'} und ${r.params?.leds ?? '?'} LEDs.`
            : lang === 'en'
            ? `Recommendation: Check battery ${r.params?.battery ?? 'N/A'} and ${r.params?.leds ?? '?'} LEDs.`
            : `推荐语：请核对电池 ${r.params?.battery ?? 'N/A'} 与 ${r.params?.leds ?? '?'} 颗LED。`
      }))

      res.json({ ok: true, data, summary, recommendations })
    } catch (err) {
      console.error('[quote] error:', err)
      res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' })
    }
  }

  router.post('/quote', handleQuote)
  router.post('/quote/generate', handleQuote) // 兼容旧路径

  // ========== 生成 PDF ==========
  router.post('/pdf', async (req, res) => {
    try {
      const { title = '报价单', lang = 'zh', mode = 'A', rows = [] } = req.body || {}
      const data = normalizeRows(rows)
      if (!data.length) {
        return res.status(400).json({ ok: false, error: 'ROWS_REQUIRED' })
      }

      // 确保目录存在
      if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true })

      const filename = `quote_${tsName()}.pdf`
      const absPath = path.join(filesDir, filename)
      const relUrl  = `/files/${filename}`

      // 生成 PDF
      const doc = new PDFDocument({ margin: 40 })
      const stream = fs.createWriteStream(absPath)
      doc.pipe(stream)

      // ★ 关键：加载中文字体（若找到）
      const fontPath = findCJKFont()
      if (fontPath) {
        doc.font(fontPath)
      } else {
        console.warn('[pdf] CJK font not found. Chinese text may be garbled.')
      }

      // 标题与信息
      doc.fontSize(20).text(title, { align: 'center' })
      doc.moveDown(0.5)
      doc.fontSize(10).text(`Mode: ${mode}   Lang: ${lang}   Rows: ${data.length}`, { align: 'center' })
      doc.moveDown(1)

      // 简易表头
      const headers = ['#', 'Name', 'SKU', 'Price', 'MOQ', 'Params']
      const colW = [30, 160, 100, 70, 60, 170]
      const startX = doc.x
      let y = doc.y

      doc.fontSize(11).fillColor('#000')
      headers.forEach((h, i) => {
        const off = colW.slice(0, i).reduce((a, b) => a + b, 0)
        doc.text(h, startX + off, y, { width: colW[i], continued: i < headers.length - 1 })
      })
      doc.moveDown(0.6)
      y = doc.y
      doc.moveTo(startX, y).lineTo(startX + colW.reduce((a, b) => a + b, 0), y).strokeColor('#999').stroke()
      doc.moveDown(0.3)

      // 表体
      data.forEach(r => {
        const paramsStr = JSON.stringify(r.params ?? {})
        const cells = [r.idx, r.name, r.sku, r.price.toFixed(2), r.moq, paramsStr]
        doc.fontSize(10).fillColor('#000')
        cells.forEach((txt, i) => {
          const off = colW.slice(0, i).reduce((a, b) => a + b, 0)
          doc.text(String(txt), startX + off, doc.y, { width: colW[i], continued: i < cells.length - 1 })
        })
        doc.moveDown(0.3)
      })

      doc.moveDown(1)
      const total = data.reduce((s, r) => s + r.price * Math.max(1, r.moq || 1), 0)
      const tip =
        lang === 'de'
          ? 'Hinweis: Bitte prüfen Sie die Batteriekapazität und LED-Anzahl.'
          : lang === 'en'
          ? 'Note: Please verify battery capacity and LED count.'
          : '提示：请核对电池容量与LED数量。'

      doc.fontSize(12).text(
        lang === 'de'
          ? `Zwischensumme (USD): ${total.toFixed(2)}`
          : lang === 'en'
          ? `Subtotal (USD): ${total.toFixed(2)}`
          : `小计（USD）：${total.toFixed(2)}`
      )
      doc.moveDown(0.3)
      doc.fontSize(10).fillColor('#666').text(tip)

      doc.end()

      stream.on('finish', () => {
        res.json({ ok: true, fileUrl: relUrl, filename })
      })
      stream.on('error', (e) => {
        console.error('[pdf] stream error:', e)
        res.status(500).json({ ok: false, error: 'PDF_STREAM_ERROR' })
      })
    } catch (err) {
      console.error('[pdf] error:', err)
      res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' })
    }
  })

  return router
}
