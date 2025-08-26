# MVP 2 — 结构化报价 + 自动推荐语（本地可跑 / Mock 模板）

## 功能
- 输入多行产品（名称、SKU、价格、MOQ、参数）
- 选择模板 A/B/C（自动按模板应用折扣或 MOQ 规则）
- 选择语言（zh/en/de），自动生成**推荐语**（可复制）
- 服务端生成 Excel 报价单并提供下载链接

## 快速开始
### 后端
```bash
cd backend
cp .env.example .env
npm install
npm run dev     # http://localhost:5188
```
### 前端
```bash
cd ../frontend
cp .env.example .env    # VITE_API_BASE=http://localhost:5188
npm install
npm run dev             # http://localhost:5176
```

## 接口
- `POST /v1/api/quote/generate` Body: `{ items: [...], template: 'A'|'B'|'C', lang: 'zh'|'en'|'de' }`
  返回：`{ excel: '...', phrases: ['...'] }`
