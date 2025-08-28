// backend/routes/quote.js
import express from 'express'
import fs from 'fs'
import path from 'path'
import PDFDocument from 'pdfkit'

/**
 * 路由工厂
 * @param {string} filesDir - backend/files 绝对路径（server.js 传入）
 */
export default function createRoutes(filesDir) {
  const router = express.Router()

  // ========= 小工具 =========
  const normalizeRows = (rows) => {
    if (!Array.isArray(rows)) return []
    return rows.map((r, i) => {
      const name  = String(r?.name ?? '').trim()
      const sku   = String(r?.sku  ?? '').trim()
      const price = Number(String(r?.price ?? '0').replace(',', '.')) || 0
      const moq   = Number(r?.moq ?? 0) || 0
      let params  = r?.params ?? {}
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

  // 在常见三个位置寻找中文字体
  const findCJKFont = () => {
    const candidates = [
      path.resolve(filesDir, '..', 'fonts', 'NotoSansSC-Regular.ttf'),
      path.resolve(process.cwd(), 'backend', 'fonts', 'NotoSansSC-Regular.ttf'),
      path.resolve(process.cwd(), 'fonts', 'NotoSansSC-Regular.ttf'),
    ]
    for (const p of candidates) if (fs.existsSync(p)) return p
    return null
  }

  // ========= 健康检查 & 调试 =========
  router.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'quote', ts: Date.now() })
  })

  // 可选：调试字体是否找到
  router.get('/debug/font', (_req, res) => {
    const p = findCJKFont()
    res.json({ ok: true, fontPath: p, exists: !!p })
  })

  // ========= 报价（复用） =========
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

  // ========= 生成 PDF =========
  router.post('/pdf', async (req, res) => {
    try {
      const { title = '报价单', lang = 'zh', mode = 'A', rows = [] } = req.body || {}
      const data = normalizeRows(rows)
      if (!data.length) return res.status(400).json({ ok: false, error: 'ROWS_REQUIRED' })

      if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true })

      const filename = `quote_${tsName()}.pdf`
      const absPath  = path.join(filesDir, filename)
      const relUrl   = `/files/${filename}`

      const doc    = new PDFDocument({ margin: 40 })
      const stream = fs.createWriteStream(absPath)
      doc.pipe(stream)

      // ★ 中文字体
      const fontPath = findCJKFont()
      if (fontPath) doc.font(fontPath)
      else console.warn('[pdf] CJK font not found. Chinese text may be garbled.')

      // 标题与信息
      doc.fontSize(20).text(title, { align: 'center' })
      doc.moveDown(0.5)
      doc.fontSize(10).text(`Mode: ${mode}   Lang: ${lang}   Rows: ${data.length}`, { align: 'center' })
      doc.moveDown(1)

      // ===== 表头（更好的列宽/对齐） =====
      const headers = ['#', 'Name', 'SKU', 'Price', 'MOQ', 'Params']
      const colW    = [30, 190, 110, 70, 60, 180] // Name/Params 更宽
      const startX  = doc.x
      let y         = doc.y

      doc.fontSize(11).fillColor('#000')
      headers.forEach((h, i) => {
        const off = colW.slice(0, i).reduce((a, b) => a + b, 0)
        doc.text(h, startX + off, y, {
          width: colW[i],
          continued: i < headers.length - 1,
          align: (h === 'Price' || h === 'MOQ') ? 'right' : 'left'
        })
      })
      doc.moveDown(0.6)
      y = doc.y
      doc.moveTo(startX, y)
         .lineTo(startX + colW.reduce((a,b)=>a+b,0), y)
         .strokeColor('#999')
         .stroke()
      doc.moveDown(0.3)

      // ===== 表体（不换行、超长省略；数值右对齐；Params 等宽体） =====
      const baseFont = fontPath || 'Helvetica'
      const monoFont = 'Courier' // 仅用于 ASCII JSON

      data.forEach(r => {
        const paramsStr = JSON.stringify(r.params ?? {})

        let off = 0
        doc.font(baseFont).fontSize(10).fillColor('#000')

        // 1) #
        doc.text(String(r.idx), startX + off, doc.y, {
          width: colW[0], lineBreak: false, continued: true
        })
        off += colW[0]

        // 2) Name
        doc.text(String(r.name || ''), startX + off, doc.y, {
          width: colW[1], lineBreak: false, ellipsis: true, continued: true
        })
        off += colW[1]

        // 3) SKU
        doc.text(String(r.sku || ''), startX + off, doc.y, {
          width: colW[2], lineBreak: false, ellipsis: true, continued: true
        })
        off += colW[2]

        // 4) Price（右对齐）
        doc.text(r.price.toFixed(2), startX + off, doc.y, {
          width: colW[3], align: 'right', lineBreak: false, continued: true
        })
        off += colW[3]

        // 5) MOQ（右对齐）
        doc.text(String(r.moq || 0), startX + off, doc.y, {
          width: colW[4], align: 'right', lineBreak: false, continued: true
        })
        off += colW[4]

        // 6) Params（等宽体，单行省略）
        doc.font(monoFont).text(paramsStr, startX + off, doc.y, {
          width: colW[5], lineBreak: false, ellipsis: true, continued: false
        })
        doc.font(baseFont) // 切回中文字体

        doc.moveDown(0.3)
      })

      // 合计与提示
      doc.moveDown(1)
      const total = data.reduce((s, r) => s + r.price * Math.max(1, r.moq || 1), 0)
      const tip =
        lang === 'de' ? 'Hinweis: Bitte prüfen Sie die Batteriekapazität und LED-Anzahl.'
      : lang === 'en' ? 'Note: Please verify battery capacity and LED count.'
      : '提示：请核对电池容量与LED数量。'

      doc.fontSize(12).text(
        lang === 'de' ? `Zwischensumme (USD)：${total.toFixed(2)}`
      : lang === 'en' ? `Subtotal (USD): ${total.toFixed(2)}`
      : `小计（USD）：${total.toFixed(2)}`
      )
      doc.moveDown(0.3)
      doc.fontSize(10).fillColor('#666').text(tip)

      doc.end()

      stream.on('finish', () => res.json({ ok: true, fileUrl: relUrl, filename }))
      stream.on('error',  (e) => {
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
