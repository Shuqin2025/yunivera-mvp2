import React, { useState } from 'react'

// 优先使用环境变量，否则回退到后端线上域名（确保这里是“后端”的域名）
const API =
  (typeof import.meta !== 'undefined' &&
    import.meta.env &&
    import.meta.env.VITE_API_URL) ||
  'https://yunivera-mvp2.onrender.com'

export default function App() {
  const [rows, setRows] = useState([
    {
      name: 'Solar Wall Lamp',
      sku: 'SWL-001',
      price: '12.5',
      moq: '100',
      params: '{"battery":"1200mAh","leds":30}',
    },
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
      return {}
    }
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
      // 过滤“全空”行
      .filter(
        (r) =>
          r.name ||
          r.sku ||
          r.price ||
          r.moq ||
          Object.keys(r.params || {}).length
      )

    return { lang, mode: template, rows: rowsPayload }
  }

  const generate = async () => {
    const payload = buildPayload()
    if (!payload.rows.length) {
      alert('请先填写至少一行产品数据')
      return
    }
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
          if (err && (err.error || err.message)) {
            msg += ` - ${err.error || err.message}`
          }
        } catch {}
        throw new Error(msg)
      }
      const data = await res.json()
      alert('生成成功！\n\n' + JSON.stringify(data, null, 2))
    } catch (e) {
      // 关键：不要留下“console.error(”半句
      console.error('generate failed:', e)
      alert('生成失败：' + e.message)
    } finally {
      setBusy(false)
    }
  }

  // 预留 PDF 按钮（后端打通后即可使用，不影响构建）
  const generatePdf = async () => {
    const payload = buildPayload()
    if (!payload.rows.length) {
      alert('请先填写至少一行产品数据')
      return
    }
    setBusy(true)
    try {
      const res = await fetch(`${API}/v1/api/pdf`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '报价单', ...payload }),
      })
      let data = {}
      try {
        data = await res.json()
      } catch {}
      if (!res.ok) {
        const msg = `HTTP ${res.status}${
          data?.error ? ' - ' + data.error : ''
        }`
        throw new Error(msg)
      }
      if (data?.fileUrl) {
        window.open(`${API}${data.fileUrl}`, '_blank')
      } else {
        alert('已生成，但未返回文件地址')
      }
    } catch (e) {
      console.error('pdf failed:', e)
      alert('生成PDF失败：' + e.message)
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
              <td>
                <input
                  style={{ width: '100%' }}
                  value={r.name}
                  onChange={(e) => onChange(i, 'name', e.target.value)}
                />
              </td>
              <td>
                <input
                  style={{ width: '100%' }}
                  value={r.sku}
                  onChange={(e) => onChange(i, 'sku', e.target.value)}
                />
              </td>
              <td>
                <input
                  style={{ width: '100%' }}
                  value={r.price}
                  onChange={(e) => onChange(i, 'price', e.target.value)}
                />
              </td>
              <td>
                <input
                  style={{ width: '100%' }}
                  value={r.moq}
                  onChange={(e) => onChange(i, 'moq', e.target.value)}
                />
              </td>
              <td>
                <input
                  style={{ width: '100%' }}
                  value={r.params}
                  onChange={(e) => onChange(i, 'params', e.target.value)}
                />
              </td>
              <td>
                <button onClick={() => delRow(i)}>删除</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ marginTop: 8 }}>
        <button onClick={addRow}>新增一行</button>
        <button
          style={{ marginLeft: 8 }}
          onClick={generate}
          disabled={busy}
        >
          {busy ? '生成中…' : '生成报价 & 推荐语'}
        </button>
        <button
          style={{ marginLeft: 8 }}
          onClick={generatePdf}
          disabled={busy}
        >
          {busy ? '生成中…' : '生成 PDF'}
        </button>
        <div style={{ marginTop: 8, color: '#777' }}>API = {API}</div>
      </div>
    </div>
  )
}
