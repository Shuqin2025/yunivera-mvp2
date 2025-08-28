// frontend/src/main.jsx
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'   // 如果你把 App 放在 components 里，请改为 './components/App.jsx'

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
