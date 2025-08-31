// backend/routes/pdf.js
import { Router } from 'express'
import PDFDocument from 'pdfkit'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const router = Router()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * POST /v1/api/pdf
 * body: { title: string, content: string }
 * 说明：直接把 PDF 以流的方式返回给浏览器（Content-Type: application/pdf）
 *      这样前端用 fetch(...).then(r => r.blob()) 就能得到真正的 PDF。
 */
router.post('/', (req, res) => {
  try {
    const { title = 'Untitled PDF', content = '' } = req.body || {}

    // 设置响应头：告诉浏览器是 PDF，并提示下载文件名
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', 'attachment; filename="quote.pdf"')

    // 建立 PDF 文档并直接 pipe 到响应
    const doc = new PDFDocument({ size: 'A4', margin: 56 })
    doc.pipe(res)

    // （可选）中文字体：backend/fonts/NotoSansSC-Regular.ttf
    const zhFontPath = path.join(__dirname, '..', 'fonts', 'NotoSansSC-Regular.ttf')
    if (fs.existsSync(zhFontPath)) {
      try {
        doc.registerFont('zh', zhFontPath)
        doc.font('zh')
      } catch (e) {
        // 字体注册失败则使用内置字体，避免中断
        console.warn('注册中文字体失败，将使用默认字体：', e?.message || e)
      }
    }

    // 标题
    doc.fontSize(20).text(title, { align: 'center' })
    doc.moveDown(1.2)

    // 正文（简单段落、自动换行）
    doc.fontSize(12).text(content, { align: 'left', lineGap: 4 })

    // 结束并把流发给浏览器
    doc.end()
  } catch (err) {
    console.error('[PDF ERROR]', err)
    // 若异常，返回 500 和 JSON 错误
    res.status(500).json({ ok: false, error: 'PDF generation failed' })
  }
})

export default router
