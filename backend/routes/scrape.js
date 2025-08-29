// backend/routes/scrape.js
import { Router } from 'express'

const router = Router()

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

// 简易工具
const pick = (s, re) => {
  if (!s) return ''
  const m = s.match(re)
  return m ? (m[1] || m[0]).trim() : ''
}
const pickAll = (s, re) => {
  if (!s) return []
  return [...s.matchAll(re)].map(m =>
    (m[1] || m[0]).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
  )
}
const toNumber = v => {
  if (v == null) return null
  const m = String(v).match(/-?\d+(?:[.,]\d+)?/)
  if (!m) return null
  return Number(m[0].replace(',', '.'))
}
const toInt = v => {
  if (v == null) return null
  const m = String(v).match(/\d{1,9}/)
  return m ? parseInt(m[0], 10) : null
}

// 解析 JSON-LD Product
function parseFromJsonLd(html) {
  const blocks = pickAll(html, /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)
  let out = {}
  for (const raw of blocks) {
    try {
      let data = JSON.parse(raw)
      const list = Array.isArray(data) ? data : [data]
      for (const obj of list) {
        const nodes = []
        if (obj && obj['@graph']) nodes.push(...obj['@graph'])
        nodes.push(obj)
        for (const n of nodes) {
          const t = n && n['@type']
          const isProduct = Array.isArray(t) ? t.includes('Product') : t === 'Product'
          if (!isProduct) continue
          // 基本字段
          if (n.name && !out.title) out.title = String(n.name)
          if (n.sku && !out.sku) out.sku = String(n.sku)
          if (n.brand) {
            out.brand = typeof n.brand === 'string' ? n.brand : (n.brand.name || out.brand)
          }
          // 价格与币种
          if (n.offers) {
            const offers = Array.isArray(n.offers) ? n.offers : [n.offers]
            for (const o of offers) {
              const p =
                o?.price ??
                o?.priceSpecification?.price ??
                o?.lowPrice ??
                o?.highPrice
              const c =
                o?.priceCurrency ??
                o?.priceSpecification?.priceCurrency ??
                o?.priceCurrencyCode
              if (p != null && out.price == null) out.price = toNumber(p)
              if (c && !out.currency) out.currency = String(c).toUpperCase()
            }
          }
          // 图片（可选）
          if (n.image && !out.image) {
            out.image = Array.isArray(n.image) ? n.image[0] : n.image
          }
        }
      }
    } catch (e) {
      // 忽略单块异常
    }
  }
  return out
}

// 解析 meta / OpenGraph
function parseFromMeta(html) {
  const getMeta = (prop) =>
    pick(html, new RegExp(`<meta[^>]+(?:name|property)=["']${prop}["'][^>]*content=["']([^"']+)["'][^>]*>`, 'i'))
  const out = {}
  out.title = pick(html, /<title[^>]*>([\s\S]*?)<\/title>/i) || getMeta('og:title') || ''
  const desc =
    getMeta('description') ||
    getMeta('og:description') ||
    getMeta('twitter:description') ||
    ''
  if (desc) out.description = desc
  const price = getMeta('product:price:amount') || getMeta('og:price:amount') || ''
  const currency = getMeta('product:price:currency') || getMeta('og:price:currency') || ''
  if (price) out.price = toNumber(price)
  if (currency) out.currency = currency.toUpperCase()
  const sku = getMeta('product:retailer_item_id') || getMeta('sku') || ''
  if (sku) out.sku = sku
  return out
}

// 解析 H1 & 文本，并尝试猜测 MOQ
function parseH1AndMOQ(html) {
  const h1 = pickAll(html, /<h1[^>]*>([\s\S]*?)<\/h1>/gi)
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  // MOQ 关键词（中/英/德常见）
  const moqHints = [
    /(?:MOQ|Min(?:imum)?\s*Order(?:\s*Qty)?|Min\.?\s*Bestellmenge)\s*[:：]?\s*(\d{1,7})/i,
    /最小(?:起订|订购|订单)[量数]?\s*[:：]?\s*(\d{1,7})/i,
    /起订量\s*[:：]?\s*(\d{1,7})/i,
  ]
  let moq = null
  for (const re of moqHints) {
    const m = text.match(re)
    if (m) { moq = toInt(m[1] || m[0]); break }
  }

  return { h1, approxTextLength: text.length, moq }
}

router.get('/', async (req, res) => {
  try {
    const url = (req.query.url || '').trim()
    if (!/^https?:\/\//i.test(url)) {
      return res.status(400).json({ ok: false, error: 'only http(s) URLs are allowed' })
    }

    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 15000) // 15s 超时
    const resp = await fetch(url, {
      signal: ac.signal,
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
    })
    clearTimeout(timer)

    if (!resp.ok) {
      return res.status(resp.status).json({ ok: false, error: `fetch failed: HTTP ${resp.status}` })
    }
    const html = await resp.text()

    // 三路解析合并：JSON-LD → meta → H1/MOQ
    const a = parseFromJsonLd(html)
    const b = parseFromMeta(html)
    const c = parseH1AndMOQ(html)

    const title = a.title || b.title || ''
    const description = a.description || b.description || ''
    const sku = a.sku || b.sku || ''
    const price = a.price ?? b.price ?? null
    const currency = (a.currency || b.currency || '').toUpperCase() || null
    const moq = c.moq ?? null

    // 预览：裁剪并简单内联样式
    const previewBody = pick(html, /<body[^>]*>([\s\S]*?)<\/body>/i) || html.slice(0, 8000)
    const preview =
      `<div style="font-family: -apple-system,system-ui,Arial; line-height:1.4; max-width:860px; margin:0 auto; padding:8px;">` +
      previewBody.slice(0, 5000) +
      `</div>`

    res.json({
      ok: true,
      url,
      fetchedAt: Date.now(),
      title,
      description,
      h1: c.h1,
      approxTextLength: c.approxTextLength,
      sku: sku || null,
      price: price ?? null,
      currency,
      moq, // 可能为 null（很多站不写 MOQ）
      preview
    })
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err?.name === 'AbortError' ? 'fetch timeout' : (err?.message || 'unknown error'),
    })
  }
})

export default router
