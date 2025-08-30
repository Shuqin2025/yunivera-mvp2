// backend/routes/pdf.js
import { Router } from 'express'
import PDFDocument from 'pdfkit'
import fs from 'fs'
import path from 'path'

const router = Router()

// POST /v1/api/pdf
// 需要 body: { title: "xxx", content: "yyy" }
router.post('/', (req, res) => {
  try {
    const { title = 'Untitled PDF', content = '' } = req.body

    // 文件名（用时间戳防止重复）
    const filename = `quote-${Date.now()}.pdf`
    const filepath = path.join(process.cwd(), 'backend', 'files', filename)

    // 生成 PDF
    const doc = new PDFDocument({ font: 'Helvetica', size: 'A4' })
    const stream = fs.createWriteStream(filepath)
    doc.pipe(stream)

    // 标题
    doc.fontSize(18).text(title, { align: 'center' }).moveDown()

    // 正文
    doc.fontSize(12).text(content, { align: 'left' })

    doc.end()

    stream.on('finish', () => {
      res.json({
        ok: true,
        file: `/files/${filename}`,
        filename,
      })
    })
  } catch (err) {
    console.error('[PDF ERROR]', err)
    res.status(500).json({ ok: false, error: 'PDF generation failed' })
  }
})

export default router
