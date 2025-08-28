import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'
import routes from './routes/quote.js'

dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()

// 建议上线后把 origin 改成你的前端域名数组
app.use(cors())
app.use(express.json({ limit: '4mb' }))

// 静态文件目录：用于存放生成的 PDF
const filesDir = path.join(__dirname, 'files')
if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir)
app.use('/files', express.static(filesDir))

// API 路由（把 filesDir 传给路由工厂）
app.use('/v1/api', routes(filesDir))

// 可选的根路径提示（避免 "Cannot GET /" 误解）
app.get('/', (_req, res) => {
  res.type('text/plain').send('mvp2-backend is running. Try /v1/api/health')
})

const port = process.env.PORT || 5188
const host = '0.0.0.0'

app.listen(port, host, () => {
  console.log(`[mvp2-backend] listening at http://${host}:${port}`)
})
