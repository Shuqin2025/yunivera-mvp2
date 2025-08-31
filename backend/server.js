// backend/server.js
import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'

// 路由
import quoteRoutes from './routes/quote.js'
import scrapeRoutes from './routes/scrape.js'
import matchRoutes from './routes/match.js'
import pdfRoutes from './routes/pdf.js'

dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()

/** -------- CORS --------
 * 生产可改为只允许你的域名：
 * cors({ origin: ['https://www.yunivera.com'] })
 */
app.use(
  cors({
    origin: '*',
  })
)

// 解析 JSON（给 PDF/抓取 POST 用）
app.use(express.json({ limit: '4mb' }))

/** -------- 静态文件（可选）--------
 * 现在 PDF 是“直接流回前端”下载，不强依赖磁盘。
 * 保留 /files 主要为了兼容老逻辑或临时存放资源。
 */
const filesDir = path.join(__dirname, 'files')
try {
  fs.mkdirSync(filesDir, { recursive: true })
} catch (e) {
  // Render 等平台只读也没关系：我们不是必须写磁盘
}
app.use('/files', express.static(filesDir))

/** -------- 路由挂载 --------
 * 兼容：quoteRoutes 既可能是 Router，也可能是工厂函数(filesDir)=>Router
 */
const mountMaybeFactory = (maybeFactory) =>
  typeof maybeFactory === 'function' ? maybeFactory(filesDir) : maybeFactory

app.use('/v1/api', mountMaybeFactory(quoteRoutes)) // 报价/推荐语等
app.use('/v1/api/scrape', scrapeRoutes)            // 抓取
app.use('/v1/api/match', matchRoutes)              // 对比/匹配
app.use('/v1/api/pdf', pdfRoutes)                  // PDF 生成（流式回传）

// 健康检查
app.get('/v1/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'quote',
    version: 'quote-v3-hf-ellipsis',
    ts: Date.now(),
  })
})

// 根路径提示
app.get('/', (_req, res) => {
  res
    .type('text/plain')
    .send('mvp3-backend is running. Try /v1/api/health')
})

const port = process.env.PORT || 5190 // ✅ MVP3 默认 5190
const host = '0.0.0.0'

app.listen(port, host, () => {
  console.log(`[mvp3-backend] listening at http://${host}:${port}`)
})
