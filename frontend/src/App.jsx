// frontend/src/App.jsx
import React, { useState } from 'react'

// 优先使用部署环境变量，否则回退到线上后端
const API =
  (typeof import.meta !== 'undefined' &&
    import.meta.env &&
    import.meta.env.VITE_API_URL) ||
  'https://yunivera-mvp2.onrender.com'

export default function App() {
  const [rows, setRows] = useState([
    { name: 'Solar Wall Lamp', sku: 'SWL-001', price: '12.5', moq: '100', params: '{"battery":"1200mAh","leds":30}' },
  ])
  const [template, setTemplate] = useState('A')
  const [lang, setLang] = useState('zh')
  const [busy, setBusy] = useState(false)

  const onChange = (idx, key, v) => {
    const next = rows.slice()
    next[idx] = { ...next[idx], [key]: v }
    setRows(next)
  }

  const addRow = () => setRows([...rows, { name: '', sku: '', price: '', moq: '', params: '' }])
  const delRow = (i) => setRows(rows.filter((_, idx) => idx !== i))

  const generate = async () => {
    setBusy(true)
    try {
      const payload = rows.map(r => ({
        name: r.name,
        sku: r.sku,
        price: Number(r.price || 0),
        moq: Number(r.moq || 0),
        params: r.params ? JSON.parse(r.params) : {}
      }))

      const res = await fetch(`${API}/v1/api/quote/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: payload, template, lang })
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()

      alert('生成成功！\n\n' + JSON.stringify(data, null, 2))
    } catch (e) {
      console.error(e)
      alert('生成失败：' + e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ padding: 16, fontFamily: 'system-ui, sans-serif' }}>
      <h2>结构化报价 + 自动推荐语（MVP2）</h2>

      <div style={{ marginBottom: 8 }}>
        模板：
        {['A','B','C'].map(t => (
          <label key={t} style={{ marginLeft: 8 }}>
            <input type="radio" name="tpl" checked={template === t} onChange={() => setTemplate(t)} /> {t}
          </label>
        ))}
        <span style={{ marginLeft: 16 }}>语言：</span>
        {['zh','en','de'].map(l => (
          <label key={l} style={{ marginLeft: 8 }}>
            <input type="radio" name="lang" checked={lang === l} onChange={() => setLang(l)} /> {l}
          </label>
        ))}
      </div>

      <table border="1" cellPadding="6" style={{ width: '100%', maxWidth: 1200 }}>
        <thead>
          <tr>
            <th>Name</th>
            <th>SKU</th>
            <th>Price</th>
            <th>MOQ</th>
            <th>Params(JSON)</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td><input style={{ width: '100%' }} value={r.name} onChange={e => onChange(i,'name',e.target.value)} /></td>
              <td><input style={{ width: '100%' }} value={r.sku} onChange={e => onChange(i,'sku',e.target.value)} /></td>
              <td><input style={{ width: '100%' }} value={r.price} onChange={e => onChange(i,'price',e.target.value)} /></td>
              <td><input style={{ width: '100%' }} value={r.moq} onChange={e => onChange(i,'moq',e.target.value)} /></td>
              <td><input style={{ width: '100%' }} value={r.params} onChange={e => onChange(i,'params',e.target.value)} /></td>
              <td><button onClick={() => delRow(i)}>删除</button></td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ marginTop: 8 }}>
        <button onClick={addRow}>新增一行</button>
        <button style={{ marginLeft: 8 }} onClick={generate} disabled={busy}>
          {busy ? '生成中…' : '生成报价 & 推荐语'}
        </button>
        <div style={{ marginTop: 8, color: '#777' }}>
          API = {API}
        </div>
      </div>
    </div>
  )
}
