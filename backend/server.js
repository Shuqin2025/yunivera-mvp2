// backend/server.js
import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'

import routes from './routes/quote.js'
import scrapeRoutes from './routes/scrape.js'

dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()

// 允许跨域
app.use(cors({ origin: '*' }))
// 解析 JSON，限制 4MB
app.use(express.json({ limit: '4mb' }))

// 静态文件目录：用于存放生成的 PDF /files
const filesDir = path.join(__dirname, 'files')
if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir)
app.use('/files', express.static(filesDir))

// API 路由（原来的报价/推荐语等）
app.use('/v1/api', routes(filesDir))

// 健康检查
app.get('/v1/api/health', (_req, res) => {
  res.json({ ok: true, service: 'quote', ts: Date.now() })
})

// 抓取路由 —— 注意这里挂在 /v1/api（不要再叠加 /scrape）
app.use('/v1/api', scrapeRoutes)

// 根路径提示，防止 “Cannot GET /”
app.get('/', (_req, res) => {
  res.type('text/plain').send('mvp2-backend is running. Try /v1/api/health')
})

const port = process.env.PORT || 5188
const host = '0.0.0.0'

app.listen(port, host, () => {
  console.log(`[mvp2-backend] listening at http://${host}:${port}`)
})
