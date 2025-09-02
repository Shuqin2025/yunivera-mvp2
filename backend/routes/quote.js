// backend/routes/quote.js
import express from 'express'
import fs from 'fs'
import path from 'path'
import PDFDocument from 'pdfkit'

const VERSION = 'quote-v3-hf-ellipsis'

export default function createRoutes(filesDir) {
  const router = express.Router()

  // ============ Utils ============
  const pad2 = (n) => String(n).padStart(2, '0')
  const tsName = () => {
    const d = new Date()
    return `${d.getFullYear()}${pad2(d.getMonth()+1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  }

  const normalizeRows = (rows) => {
    if (!Array.isArray(rows)) return []
    return rows.map((r, i) => {
      const name  = String(r?.name ?? '').trim()
      const sku   = String(r?.sku  ?? '').trim()
      const price = Number(String(r?.price ?? '0').replace(',', '.')) || 0
      const moq   = Number(r?.moq ?? 0) || 0
      let params  = r?.params ?? {}
      if (typeof params === 'string') { try { params = JSON.parse(params) } catch { params = {} } }
      return { idx: i + 1, name, sku, price, moq, params }
    })
  }

  const findCJKFont = () => {
    const candidates = [
      path.resolve(filesDir, '..', 'fonts', 'NotoSansSC-Regular.ttf'),
      path.resolve(process.cwd(), 'backend', 'fonts', 'NotoSansSC-Regular.ttf'),
      path.resolve(process.cwd(), 'fonts', 'NotoSansSC-Regular.ttf'),
    ]
    for (const p of candidates) if (fs.existsSync(p)) return p
    return null
  }

  const formatParams = (params = {}, lang = 'zh') => {
    const b = params.battery ?? params.Battery ?? params.power ?? ''
    const leds = params.leds ?? params.LEDs ?? params.LED ?? ''
    const parts = []
    if (lang === 'de') {
      if (b) parts.push(`Batterie: ${b}`)
      if (leds) parts.push(`LEDs: ${leds}`)
      return parts.join('; ') || '-'
    } else if (lang === 'en') {
      if (b) parts.push(`Battery: ${b}`)
      if (leds) parts.push(`LEDs: ${leds}`)
      return parts.join('; ') || '-'
    }
    if (b) parts.push(`电池: ${b}`)
    if (leds) parts.push(`LEDs: ${leds} 个`)
    return parts.join('；') || '-'
  }

  const i18n = {
    title: (lang) => lang === 'de' ? 'Angebot' : lang === 'en' ? 'Quotation' : '报价单',
    subtotal: (lang, total) =>
      lang === 'de' ? `Zwischensumme (USD)：${total.toFixed(2)}`
      : lang === 'en' ? `Subtotal (USD): ${total.toFixed(2)}`
      : `小计（USD）：${total.toFixed(2)}`,
    tip: (lang) =>
      lang === 'de' ? 'Hinweis: Bitte prüfen Sie die Batteriekapazität und LED-Anzahl.'
      : lang === 'en' ? 'Note: Please verify battery capacity and LED count.'
      : '提示：请核对电池容量与LED数量。',
    headers: (lang) =>
      lang === 'de' ? ['#', 'Name', 'SKU', 'Preis', 'MOQ', 'Parameter']
      : lang === 'en' ? ['#', 'Name', 'SKU', 'Price', 'MOQ', 'Params']
      : ['#', '名称', 'SKU', '价格', 'MOQ', '参数'],
  }

  // ============ Health ============
  router.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'quote', version: VERSION, ts: Date.now() })
  })

  // ============ Quote JSON ============
  const handleQuote = async (req, res) => {
    try {
      const { rows = [], lang = 'zh', mode = 'A' } = req.body || {}
      const data = normalizeRows(rows)
      if (!data.length) return res.status(400).json({ ok: false, error: 'ROWS_REQUIRED' })

      const summary = {
        count: data.length,
        currency: 'USD',
        mode, lang,
        total: data.reduce((s, r) => s + r.price * Math.max(1, r.moq || 1), 0),
      }

      res.json({ ok: true, data, summary, version: VERSION })
    } catch (err) {
      console.error('[quote] error:', err)
      res.status(500).json({ ok: false, error: 'INTERNAL_ERROR', version: VERSION })
    }
  }
  router.post('/quote', handleQuote)
  router.post('/quote/generate', handleQuote)

  // ============ Quote → PDF ============
  router.post('/quote/pdf', async (req, res) => {
    try {
      const { title, lang = 'zh', mode = 'A', rows = [] } = req.body || {}
      const data = normalizeRows(rows)
      if (!data.length) return res.status(400).json({ ok: false, error: 'ROWS_REQUIRED' })

      if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true })
      const filename = `quote_${tsName()}.pdf`
      const absPath  = path.join(filesDir, filename)
      const relUrl   = `/files/${filename}`

      const doc = new PDFDocument({ margin: 52 })
      const stream = fs.createWriteStream(absPath)
      doc.pipe(stream)

      const fontPath = findCJKFont()
      if (fontPath) doc.font(fontPath)

      // 标题
      doc.fontSize(18).text(title || i18n.title(lang), { align: 'center' })
      doc.moveDown(1)

      // 表头
      const headers = i18n.headers(lang)
      const colW    = [28, 200, 110, 70, 60, 170]
      const startX  = doc.page.margins.left
      let y         = doc.y

      doc.fontSize(11)
      headers.forEach((h, i) => {
        const off = colW.slice(0, i).reduce((a,b)=>a+b,0)
        doc.text(h, startX + off, y, {
          width: colW[i],
          continued: i < headers.length - 1,
          align: (h === 'Price' || h === 'Preis' || h === 'MOQ') ? 'right' : 'left'
        })
      })
      doc.moveDown(0.6)

      // 表体
      data.forEach(r => {
        let off = 0
        doc.fontSize(10).text(String(r.idx), startX + off, doc.y, { width: colW[0], continued:true }); off+=colW[0]
        doc.text(r.name, startX + off, doc.y, { width: colW[1], continued:true }); off+=colW[1]
        doc.text(r.sku,  startX + off, doc.y, { width: colW[2], continued:true }); off+=colW[2]
        doc.text(r.price.toFixed(2), startX + off, doc.y, { width: colW[3], align:'right', continued:true }); off+=colW[3]
        doc.text(String(r.moq || 0), startX + off, doc.y, { width: colW[4], align:'right', continued:true }); off+=colW[4]
        doc.text(formatParams(r.params, lang), startX + off, doc.y, { width: colW[5] })
        doc.moveDown(0.3)
      })

      // 小计
      const total = data.reduce((s, r) => s + r.price * Math.max(1, r.moq || 1), 0)
      doc.moveDown(1).fontSize(12).text(i18n.subtotal(lang, total))

      doc.end()
      stream.on('finish', () => res.json({ ok: true, fileUrl: relUrl, filename, version: VERSION }))
      stream.on('error',  (e) => res.status(500).json({ ok: false, error: 'PDF_STREAM_ERROR', version: VERSION }))
    } catch (err) {
      console.error('[pdf] error:', err)
      res.status(500).json({ ok: false, error: 'INTERNAL_ERROR', version: VERSION })
    }
  })

  return router
}
