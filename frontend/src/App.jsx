// frontend/src/App.jsx
import React, { useState } from 'react'

// 优先用部署环境变量，否则回退到线上后端（后端域名）
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
    try {
      return JSON.parse(str)
    } catch {
      return {} // 解析失败就给空对象，避免 400
    }
  }

  const toFloat = (v) => {
    // 允许用户输入逗号小数，统一转成英文小数点
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
      // 过滤空行
      .filter((r) => r.name || r.sku || r.price || r.moq || Object.keys(r.params).length)

    return {
      lang,
      mode: template,   // ← 后端期望的字段名
      rows: rowsPayload // ← 后端期望的字段名
    }
  }

  const generate = async () => {
    const payload = buildPayload()
    if (!payload.rows.length) {
      alert('请先填写至少一行产品数据'); return
    }

    setBusy(true)
    try {
      const res = await fetch(`${API}/v1/api/quote/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      // 更友好的错误提示：尝试读取后端返回的 JSON 错误体
      if (!res.ok) {
        let msg = `HTTP ${res.status}`
        try {
          const err = await res.json()
          if (err && (err.error || err.message)) {
            msg += ` - ${err.error || err.message}`
          }
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

  return (
    <div style={{ padding: 16, fontFamily: 'system-ui, sans-serif' }}>
      <h2>结构化报价 + 自动推荐语（MVP2）</h2>

      <div style={{ marginBottom: 8 }}>
        模板：
        {['A', 'B', 'C'].map((t) => (
          <label key={t} style={{ marginLeft: 8 }}>
            <input
              type="radio"
              name="tpl"
              checked={template === t}
              onChange={() => setTemplate(t)}
            />{' '}
            {t}
          </label>
        ))}
        <span style={{ marginLeft: 16 }}>语言：</span>
        {['zh', 'en', 'de'].map((l) => (
          <label key={l} style={{ marginLeft: 8 }}>
            <input
              type="radio"
              name="lang"
              checked={lang === l}
              onChange={() => setLang(l)}
            />{' '}
            {l}
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
          {busy ? '生成中…' :
