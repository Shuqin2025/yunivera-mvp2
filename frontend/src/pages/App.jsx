import React, { useState } from 'react'
const API = import.meta.env.VITE_API_BASE || 'http://localhost:5188'

function emptyRow(){ return { name:'', sku:'', price:0, moq:0, params:'' } }

export default function App(){
  const [rows, setRows] = useState([
    { name:'Solar Wall Lamp', sku:'SWL-001', price:12.5, moq:100, params:'{"battery":"1200mAh","leds":30}' }
  ])
  const [tpl, setTpl] = useState('A')
  const [lang, setLang] = useState('zh')
  const [phrases, setPhrases] = useState([])
  const [excel, setExcel] = useState(null)
  const [loading, setLoading] = useState(false)
  const addRow = ()=> setRows(r=>[...r, emptyRow()])
  const delRow = (i)=> setRows(r=>r.filter((_,idx)=>idx!==i))
  const update = (i, key, val)=> setRows(r=>r.map((it,idx)=> idx===i? {...it, [key]: val}: it))

  const gen = async ()=>{
    setLoading(true); setExcel(null); setPhrases([])
    const items = rows.map(r=> ({
      name: r.name, sku: r.sku,
      price: Number(r.price||0), moq: Number(r.moq||0),
      params: r.params ? JSON.parse(r.params) : {}
    }))
    const res = await fetch(`${API}/v1/api/quote/generate`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ items, template: tpl, lang })
    })
    const data = await res.json()
    setExcel(data.excel); setPhrases(data.phrases||[]); setLoading(false)
  }

  return (
    <div style={{padding:20, fontFamily:'system-ui, -apple-system, Segoe UI, Roboto'}}>
      <h2>结构化报价 + 自动推荐语（MVP2）</h2>
      <div style={{display:'flex', gap:16, marginBottom:12}}>
        <div>模板：
          {['A','B','C'].map(t=>(<label key={t} style={{marginRight:8}}>
            <input type="radio" checked={tpl===t} onChange={()=>setTpl(t)}/> {t}
          </label>))}
        </div>
        <div>语言：
          {['zh','en','de'].map(l=>(<label key={l} style={{marginRight:8}}>
            <input type="radio" checked={lang===l} onChange={()=>setLang(l)}/> {l}
          </label>))}
        </div>
      </div>

      <table border="1" cellPadding="6" style={{borderCollapse:'collapse', width:'100%', marginBottom:12}}>
        <thead><tr><th>Name</th><th>SKU</th><th>Price</th><th>MOQ</th><th>Params(JSON)</th><th></th></tr></thead>
        <tbody>
          {rows.map((r,i)=>(
            <tr key={i}>
              <td><input value={r.name} onChange={e=>update(i,'name',e.target.value)} style={{width:'100%'}}/></td>
              <td><input value={r.sku} onChange={e=>update(i,'sku',e.target.value)} style={{width:'100%'}}/></td>
              <td><input type="number" value={r.price} onChange={e=>update(i,'price',e.target.value)} style={{width:'100%'}}/></td>
              <td><input type="number" value={r.moq} onChange={e=>update(i,'moq',e.target.value)} style={{width:'100%'}}/></td>
              <td><input value={r.params} onChange={e=>update(i,'params',e.target.value)} style={{width:'100%'}}/></td>
              <td><button onClick={()=>delRow(i)}>删除</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button onClick={addRow} style={{marginRight:8}}>新增一行</button>
      <button onClick={gen} disabled={loading}>{loading?'生成中...':'生成报价 & 推荐语'}</button>

      {phrases.length>0 && <div style={{marginTop:16}}>
        <h3>自动推荐语：</h3>
        <ul>{phrases.map((p,i)=>(<li key={i}>{p}</li>))}</ul>
      </div>}
      {excel && <div style={{marginTop:8}}><a href={excel} target="_blank">下载 Excel 报价单</a></div>}
    </div>
  )
}
