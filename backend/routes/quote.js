// backend/routes/quote.js
import express from 'express'
import fs from 'fs'
import path from 'path'
import PDFDocument from 'pdfkit'

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
      if (typeof params === 'string') {
        try { params = JSON.parse(params) } catch { params = {} }
      }
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

  const loadLogoBuffer = (company = {}) => {
    // 1) dataURL
    if (company.logoDataURL && company.logoDataURL.startsWith('data:image')) {
      try {
        const b64 = company.logoDataURL.split(',')[1]
        return Buffer.from(b64, 'base64')
      } catch {}
    }
    // 2) 路径（绝对/相对）
    const tryPaths = []
    if (company.logoPath) tryPaths.push(company.logoPath)
    tryPaths.push(
      path.resolve(process.cwd(), 'backend', 'assets', 'logo.png'),
      path.resolve(process.cwd(), 'backend', 'public', 'logo.png'),
      path.resolve(process.cwd(), 'backend', 'logo.png'),
    )
    for (const p of tryPaths) {
      try {
        if (fs.existsSync(p)) return fs.readFileSync(p)
      } catch {}
    }
    return null
  }

  const formatParams = (params = {}, lang = 'zh') => {
    const b = params.battery ?? params.Battery ?? params.power ?? ''
    const leds = params.leds ?? params.LEDs ?? params.LED ?? ''
    const parts = []
    if (lang === 'de') {
      if (b) parts.push(`Batterie: ${b}`)
      if (leds !== '' && leds !== null) parts.push(`LEDs: ${leds}`)
      return parts.join('; ') || '-'
    } else if (lang === 'en') {
      if (b) parts.push(`Battery: ${b}`)
      if (leds !== '' && leds !== null) parts.push(`LEDs: ${leds}`)
      return parts.join('; ') || '-'
    }
    if (b) parts.push(`电池: ${b}`)
    if (leds !== '' && leds !== null) parts.push(`LEDs: ${leds} 个`)
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
      lang === 'de'
        ? ['#', 'Name', 'SKU', 'Preis', 'MOQ', 'Parameter']
        : lang === 'en'
        ? ['#', 'Name', 'SKU', 'Price', 'MOQ', 'Params']
        : ['#', '名称', 'SKU', '价格', 'MOQ', '参数'],
  }

  // ============ Health / Debug ============
  router.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'quote', ts: Date.now() })
  })

  router.get('/debug/font', (_req, res) => {
    const p = findCJKFont()
    res.json({ ok: true, fontPath: p, exists: !!p })
  })

  // ============ Quote ============
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
            ? `Empfehlung: Prüfen Sie Batterie ${r.params?.battery ?? 'N/A'} und ${r.params?.leds ?? '?'} LEDs.`
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
  router.post('/quote/generate', handleQuote)

  // ============ Header / Footer 绘制 ============
  const drawHeader = (doc, opts) => {
    const {
      fontPath, company = {}, lang = 'zh',
      pageWidth = doc.page.width, margin = doc.page.margins.left
    } = opts

    // 左：Logo；右：公司名称/信息
    let topY = margin - 10
    const colLeftX = margin
    const colRightX = pageWidth - margin - 330 // 右侧文本列宽约 330

    // 尝试画 Logo（高不超过 42）
    if (company._logoBuffer) {
      try {
        doc.image(company._logoBuffer, colLeftX, topY, { fit: [140, 42], align: 'left', valign: 'center' })
      } catch (e) { console.warn('[pdf] draw logo failed:', e.message) }
    }

    // 公司文字信息
    const name = company.name || 'Your Company'
    const addr = company.address || ''
    const phone= company.phone || ''
    const email= company.email || ''
    const web  = company.website || ''

    doc.font(fontPath || 'Helvetica-Bold').fontSize(14)
       .text(name, colRightX, topY, { width: 330, align: 'right' })
    doc.font(fontPath || 'Helvetica').fontSize(9).fillColor('#666')
    const lines = [addr, phone, email, web].filter(Boolean)
    if (lines.length) {
      doc.text(lines.join('  |  '), colRightX, topY + 18, { width: 330, align: 'right' })
    }
    doc.fillColor('#000')

    // 下划线
    const y = topY + 48
    doc.moveTo(margin, y).lineTo(pageWidth - margin, y).strokeColor('#999').stroke()
    doc.y = y + 10 // 内容起始 y
  }

  const drawFooter = (doc, opts) => {
    const { company = {} } = opts
    const margin = doc.page.margins.left
    const pageWidth = doc.page.width
    const pageHeight = doc.page.height
    const y = pageHeight - margin + 5

    // 上细线
    doc.moveTo(margin, y - 10).lineTo(pageWidth - margin, y - 10).strokeColor('#eee').stroke()

    // 左：时间 & 网站；右：页码
    const now = new Date()
    const stamp = `${now.getFullYear()}-${pad2(now.getMonth()+1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`
    const leftText = [stamp, (company.website || '')].filter(Boolean).join('  |  ')
    doc.fontSize(9).fillColor('#666').text(leftText || stamp, margin, y, { width: 300, align: 'left' })
    doc.text(`Page ${doc.page.number}`, pageWidth - margin - 120, y, { width: 120, align: 'right' })
    doc.fillColor('#000')
  }

  const hookHeaderFooter = (doc, opts) => {
    drawHeader(doc, opts)
    drawFooter(doc, opts)
    doc.on('pageAdded', () => {
      drawHeader(doc, opts)
      drawFooter(doc, opts)
    })
  }

  // ============ PDF ============
  router.post('/pdf', async (req, res) => {
    try {
      const { title, lang = 'zh', mode = 'A', rows = [], company = {} } = req.body || {}
      const data = normalizeRows(rows)
      if (!data.length) return res.status(400).json({ ok: false, error: 'ROWS_REQUIRED' })

      if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir, { recursive: true })
      const filename = `quote_${tsName()}.pdf`
      const absPath  = path.join(filesDir, filename)
      const relUrl   = `/files/${filename}`

      const doc = new PDFDocument({ margin: 52 }) // 给页眉/脚多一点空间
      const stream = fs.createWriteStream(absPath)
      doc.pipe(stream)

      // 字体 & Logo
      const fontPath = findCJKFont()
      if (fontPath) doc.font(fontPath)
      else console.warn('[pdf] CJK font not found. Chinese text may be garbled.')
      company._logoBuffer = loadLogoBuffer(company)

      // Header/Footer
      hookHeaderFooter(doc, { fontPath, company, lang })

      // 标题区（在 header 下方）
      doc.moveDown(0.5)
      doc.fontSize(18).text(title || i18n.title(lang), { align: 'center' })
      doc.moveDown(0.5)
      doc.fontSize(10).text(`Mode: ${mode}   Lang: ${lang}   Rows: ${data.length}`, { align: 'center' })
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
      y = doc.y
      doc.moveTo(startX, y).lineTo(startX + colW.reduce((a,b)=>a+b,0), y).strokeColor('#999').stroke()
      doc.moveDown(0.3)

      // 表体
      const baseFont = fontPath || 'Helvetica'
      const monoFont = 'Courier'
      data.forEach(r => {
        const paramText = formatParams(r.params, lang)
        let off = 0
        doc.font(baseFont).fontSize(10).fillColor('#000')

        doc.text(String(r.idx), startX + off, doc.y, { width: colW[0], lineBreak:false, continued:true }) ; off+=colW[0]
        doc.text(String(r.name || ''), startX + off, doc.y, { width: colW[1], lineBreak:false, ellipsis:true, continued:true }) ; off+=colW[1]
        doc.text(String(r.sku || ''),  startX + off, doc.y, { width: colW[2], lineBreak:false, ellipsis:true, continued:true }) ; off+=colW[2]
        doc.text(r.price.toFixed(2),    startX + off, doc.y, { width: colW[3], align:'right', lineBreak:false, continued:true }) ; off+=colW[3]
        doc.text(String(r.moq || 0),    startX + off, doc.y, { width: colW[4], align:'right', lineBreak:false, continued:true }) ; off+=colW[4]
        doc.font(monoFont).text(paramText, startX + off, doc.y, { width: colW[5], lineBreak:false, ellipsis:true, continued:false })
        doc.font(baseFont)
        doc.moveDown(0.3)
      })

      // 小计 & 提示
      doc.moveDown(1)
      const total = data.reduce((s, r) => s + r.price * Math.max(1, r.moq || 1), 0)
      doc.fontSize(12).text(i18n.subtotal(lang, total))
      doc.moveDown(0.3)
      doc.fontSize(10).fillColor('#666').text(i18n.tip(lang))
      doc.fillColor('#000')

      doc.end()

      stream.on('finish', () => res.json({ ok: true, fileUrl: relUrl, filename }))
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
