import React, { useState } from 'react'

// 优先使用环境变量，否则回退到后端线上域名
const API =
  (typeof import.meta !== 'undefined' &&
    import.meta.env &&
    import.meta.env.VITE_API_URL) ||
  'https://yunivera-mvp2.onrender.com' // ← 确保这是“后端”域名

export default function App() {
  const [rows, setRows] = useState([
    { name: 'Solar Wall Lamp', sku: 'SWL-001', price: '12.5', moq: '100', params: '{"battery":"1200mAh","leds":30}' },
  ])
  const [template, setTemplate] = useState('A') // 对应后端的 mode
  const [lang, setLang] = useState('zh')
  const [busy, setBusy] = useState(false)

  const onChange = (idx, key, v) => {
    const next = rows.slice()
    next[idx] = { ...next[idx], [key]: v }
    setRows(next)
  }

  const addRow = () =>
    setRows([...rows, { name: '', sku: '', price: '', moq: '', params: '' }])

  const delRow = (i) => setRows(rows.filter((_, idx) => idx !== i))

  const parseJSONSafe = (str) => {
    if (!str) return {}
    try { return JSON.parse(str) } catch { return {} }
  }

  const toFloat = (v) => {
    const s = String(v ?? '').trim().replace(',', '.')
    const n = parseFloat(s)
    return Number.isFinite(n) ? n : 0
  }

  const toInt = (v) => {
    const n = parseInt(String(v ?? '').trim(), 10)
    return Number.isFinite(n) ? n : 0
  }

  const buildPayload = () => {
    const rowsPayload = rows
      .map((r) => ({
        name: (r.name || '').trim(),
        sku: (r.sku || '').trim(),
        price: toFloat(r.price),
        moq: toInt(r.moq),
        params: parseJSONSafe(r.params),
      }))
      .filter((r) => r.name || r.sku || r.price || r.moq || Object.keys(r.params).length)

    return { lang, mode: template, rows: rowsPayload }
  }

  const generate = async () => {
    const payload = buildPayload()
    if (!payload.rows.length) { alert('请先填写至少一行产品数据'); return }
    setBusy(true)
    try {
      const res = await fetch(`${API}/v1/api/quote/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        let msg = `HTTP ${res.status}`
        try {
          const err = await res.json()
          if (err && (err.error || err.message)) msg += ` - ${err.error || err.message}`
        } catch {}
        throw new Error(msg)
      }
      const data = await res.json()
      alert('生成成功！\n\n' + JSON.stringify(data, null, 2))
    } catch (e) {
      console.error(e)
      alert('生成失败：' + e.message)
    } finally {
      setBusy(false)
    }
  }

  // 先保留接口，等你打通 PDF 后直接可用（不影响构建）
  const generatePdf = async () => {
    const payload = buildPayload()
    if (!payload.rows.length) { alert('请先填写至少一行产品数据'); return }
    setBusy(true)
    try {
      const res = await fetch(`${API}/v1/api/pdf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '报价单', ...payload })
      })
      let data = {}
      try { data = await res.json() } catch {}
      if (!res.ok) throw new Error(`HTTP ${res.status}${data?.error ? ' - ' + data.error : ''}`)
      if (data?.fileUrl) {
        const url = `${API}${data.fileUrl}`
        window.open(url, '_blank')
      } else {
        alert('已生成，但未返回文件地址')
      }
    } catch (e) {
      console.error(
