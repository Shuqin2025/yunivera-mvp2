// backend/routes/pdf.js
import { Router } from 'express'
import PDFDocument from 'pdfkit'

const router = Router()

// POST /v1/api/pdf
// Body 支持：{ title?: string, content?: string, body?: string, rows?: string[] }
router.post('/', (req, res) => {
  try {
    const { title = '报价单', content, body, rows } = req.body || {}

    // 归一化正文
    const text =
      (typeof content === 'string' && content.trim()) ||
      (typeof body === 'string' && body.trim()) ||
      (Array.isArray(rows) ? rows.filter(Boolean).join('\n') : '')

    if (!text) {
      return res.status(400).json({ ok: false, error: '缺少正文（content/body/rows）' })
    }

    // inline 预览；?dl=1 时下载
    const inline = !('dl' in req.query)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename="quote.pdf"`
    )

    // 生成 PDF（直接写入响应）
    const doc = new PDFDocument({ size: 'A4', margin: 56 }) // 约 2cm 边距
    doc.pipe(res)

    // 标题
    doc.fontSize(22).text(title, { align: 'center' }).moveDown(1.2)
    // 正文
    doc.fontSize(12).text(text, { align: 'left', lineGap: 4 })

    doc.end()
  } catch (err) {
    console.error('[PDF ERROR]', err)
    res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' })
  }
})

export default router
