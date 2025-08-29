// backend/routes/scrape.js
import { Router } from 'express'

const router = Router()

// 简单的 HTML 提取函数（不依赖 cheerio）
function extractField(html, regex) {
  const m = html.match(regex)
  return m ? m[1].trim() : ''
}

router.get('/', async (req, res) => {
  try {
    const url = (req.query.url || '').trim()

    if (!url) {
      return res.status(400).json({ ok: false, error: 'missing "url" query param' })
    }
    // 安全兜底：必须是 http/https
    if (!/^https?:\/\//i.test(url)) {
      return res.status(400).json({ ok: false, error: 'only http(s) URLs are allowed' })
    }

    // 设定超时，避免 Render 免费实例挂太久
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12000) // 12s

    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    })
    clearTimeout(timer)

    if (!resp.ok) {
      return res.status(resp.status).json({
        ok: false,
        error: `fetch failed: HTTP ${resp.status}`,
      })
    }

    const html = await resp.text()

    // 基础字段：title / meta description / 第一批 <h1>
    const title = extractField(html, /<title[^>]*>([\s\S]*?)<\/title>/i)
    const description =
      extractField(
        html,
        /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i
      ) ||
      extractField(
        html,
        /<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["'][^>]*>/i
      )

    // 提取前几个 H1（简单正则，足够做 MVP）
    const h1Matches = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map(m =>
      m[1]
        .replace(/<[^>]+>/g, '') // 去 HTML 标签
        .replace(/\s+/g, ' ')
        .trim()
    )
    const h1List = h1Matches.slice(0, 5)

    // 纯文本长度估算（非常粗略）
    const textLength = html.replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim().length

    res.json({
      ok: true,
      url,
      fetchedAt: Date.now(),
      title,
      description,
      h1: h1List,
      approxTextLength: textLength,
      // 仅返回摘要预览（避免响应太大）
      preview: html.slice(0, 600),
    })
  } catch (err) {
    // 超时、拒绝、解析等错误
    res.status(500).json({
      ok: false,
      error: err?.name === 'AbortError' ? 'fetch timeout' : (err?.message || 'unknown error'),
    })
  }
})

export default router
