// backend/routes/pdf.js
import { Router } from 'express'
import PDFDocument from 'pdfkit'
import fs from 'fs'
import path from 'path'

const router = Router()

/**
 * POST /v1/api/pdf
 * 接收两种 Body 之一：
 * 1) { title: string, rows: string[][] }   // ✅ 推荐，二维数组，每行一个数组
 * 2) { title: string, content: string }    // 兼容老格式，纯文本
 *
 * 直接把 PDF 作为二进制流返回（attachment），前端用 fetch -> blob() 下载即可
 */
router.post('/', (req, res) => {
  try {
    const { title = '报价单 / Quote', rows, content } = req.body || {}

    // ====== HTTP 头：直接回传 PDF ======
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="quote-${Date.now()}.pdf"`
    )

    // 生成 PDF（留 2cm 边距）
    const doc = new PDFDocument({ size: 'A4', margin: 56 })
    doc.pipe(res)

    // ====== 中文字体（可选）======
    // 放置在 backend/fonts/NotoSansSC-Regular.ttf
    const zhFont = path.join(process.cwd(), 'backend', 'fonts', 'NotoSansSC-Regular.ttf')
    let hasZh = false
    if (fs.existsSync(zhFont)) {
      try {
        doc.registerFont('zh', zhFont)
        doc.font('zh')
        hasZh = true
      } catch (e) {
        // 字体注册失败则回退到默认字体
        // 不抛错，继续生成
      }
    }

    // ====== 标题 ======
    doc.fontSize(18).text(title, { align: 'center' })
    doc.moveDown(1.2)

    // ====== 正文：优先 rows（二维数组），否则 content（纯文本）======
    const isRowsValid =
      Array.isArray(rows) && rows.length > 0 && rows.every((r) => Array.isArray(r))

    if (isRowsValid) {
      // 用最稳妥的“文本表格”方式画出来（每行拼接为一段）
      doc.fontSize(12)
      rows.forEach((lineArr, idx) => {
        // 允许每行多列，这里用 2~4 个空格拼接
        const line = (lineArr || []).map((c) => String(c ?? '')).join('    ')
        doc.text(line, { align: 'left' })
        // 大段之间留白：如果是空行也照常写入，视觉更自然
        if (idx < rows.length - 1) {
          doc.moveDown(0.15)
        }
      })
    } else {
      // 兼容老格式：content 纯文本
      const txt = typeof content === 'string' && content.trim() ? content : '(空白)'
      doc.fontSize(12).text(txt, {
        align: 'left',
        lineGap: 4,
      })
    }

    doc.end()

    // 重要：错误兜底（例如字体问题）
    doc.on('error', (err) => {
      console.error('[PDFKIT ERROR]', err)
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: 'PDF generation failed' })
      } else {
        // headers 已发，终止连接
        res.end()
      }
    })
  } catch (err) {
    console.error('[PDF ERROR]', err)
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' })
    } else {
      res.end()
    }
  }
})

export default router
