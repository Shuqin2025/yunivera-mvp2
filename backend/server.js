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
app.use(cors())
app.use(express.json({limit:'4mb'}))

const filesDir = path.join(__dirname, 'files')
if (!fs.existsSync(filesDir)) fs.mkdirSync(filesDir)
app.use('/files', express.static(filesDir))

app.use('/v1/api', routes(filesDir))

const port = process.env.PORT || 5188
app.listen(port, ()=>console.log(`[mvp2-backend] :${port}`))
