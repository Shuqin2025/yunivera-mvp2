// backend/routes/pdf.js
import { Router } from 'express'
import PDFDocument from 'pdfkit'
import fs from 'fs'
import path from 'path'

const router = Router()

/**
 * POST /v1/api/pdf
 * body: {
 *   title?: string,
 *   content?: string,
 *   rows?: Array<Array<string|number>>   // 可选：表格数据，第一行可当表头
 * }
 *
 * 直接以 application/pdf 流返回，不再返回 JSON。
 */
router.post('/', (req, res) => {
  try {
    const {
      title = '报价单 / Quote',
      content = '',
      rows = []
    } = req.body ?? {}

    // 准备响应头：告诉浏览器是 PDF，并作为附件下载
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', 'attachment; filename="quote.pdf"')

    // 创建 PDF 文档
    const doc = new PDFDocument({
      size: 'A4',
      margin: 50
    })

    // 选择字体：优先用项目自带中文字体，找不到就回退 Helvetica
    const fontCandidates = [
      path.join(process.cwd(), 'backend', 'fonts', 'NotoSansSC-Regular.otf'),
      path.join(process.cwd(), 'backend', 'fonts', 'NotoSansSC-Regular.ttf'),
      path.join(process.cwd(), 'backend', 'fonts', 'NotoSansCJKsc-Regular.otf'),
    ]
    let bodyFont = null
    for (const f of fontCandidates) {
      if (fs.existsSync(f)) { bodyFont = f; break }
    }

    // 将 PDF 输出直接 pipe 到 HTTP 响应
    doc.pipe(res)

    // 标题
    if (bodyFont) doc.font(bodyFont)
    doc.fontSize(20).text(title, { align: 'center' }).moveDown(1.2)

    // 正文
    if (content && String(content).trim()) {
      if (bodyFont) doc.font(bodyFont)
      doc.fontSize(12).text(String(content), { align: 'left' })
      doc.moveDown(1)
    }

    // 表格（可选）
    if (Array.isArray(rows) && rows.length > 0) {
      const startX = doc.page.margins.left
      let y = doc.y + 10

      // 自动估算每列宽（最多 5 列；多余列按最后一列宽度）
      const MAX_COLS = Math.max(...rows.map(r => r.length))
      const cols = Math.min(MAX_COLS, 5)
      const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right
      const baseWidth = Math.floor(pageWidth / cols)
      const colWidths = Array.from({ length: cols }, () => baseWidth)

      const rowHeight = 24

      const drawRow = (cells, isHeader = false) => {
        let x = startX
        for (let i = 0; i < cols; i++) {
          const text = (cells[i] ?? '').toString()
          const w = colWidths[i]
          // 边框
          doc.rect(x, y, w, rowHeight).stroke()
          // 文本
          if (bodyFont) doc.font(bodyFont)
          doc.fontSize(isHeader ? 12 : 11)
          doc.text(text, x + 6, y + 6, { width: w - 12, ellipsis: true })
          x += w
        }
        y += rowHeight
        // 翻页处理
        if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
          doc.addPage()
          y = doc.page.margins.top
        }
      }

      // 如果第一行就是表头，粗体渲染
      drawRow(rows[0], true)
      for (let i = 1; i < rows.length; i++) drawRow(rows[i], false)

      doc.moveDown(1)
    }

    // 结束并刷新输出
    doc.end()
    // ⚠️ 不要在这里再 res.json(...)；PDF 已经通过流返回
  } catch (err) {
    console.error('[PDF STREAM ERROR]', err)
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: 'PDF_STREAM_FAILED' })
    } else {
      // 流已开始写，安全结束
      try { res.end() } catch (_) {}
    }
  }
})

export default router
