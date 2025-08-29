// frontend/src/App.jsx  —— 精简版（单抓取 UI，带端点检测）
// 依赖：React 18 + Vite。环境变量：VITE_API_BASE=https://yunivera-mvp2.onrender.com/v1/api

import React, { useEffect, useMemo, useRef, useState } from "react";

const API_BASE = (import.meta.env.VITE_API_BASE || "").replace(/\/+$/, ""); // 去掉末尾斜杠，防重复
const API = {
  health: `${API_BASE}/health`,
  scrape: `${API_BASE}/scrape`,
  pdf: `${API_BASE}/pdf`, // 只是检测一下是否存在（MVP2 默认用不到）
};

// 一个小的工具：安全 JSON 解析
function safeJSON(v, fallback = null) {
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

export default function App() {
  // === 核心数据：一行产品记录（保持 MVP2 的字段风格） ===
  const [row, setRow] = useState({
    name: "Solar Wall Lamp",
    sku: "SWL-001",
    price: 12.5,
    moq: 100,
    params: '{"battery":"1200mAh","leds":30}',
  });

  // === 抓取相关状态 ===
  const [scrapeUrl, setScrapeUrl] = useState("https://example.com");
  const [scrapeJSON, setScrapeJSON] = useState("");
  const [isFetching, setIsFetching] = useState(false);

  // === 端点检测（health / pdf） ===
  const [healthOK, setHealthOK] = useState(null); // true/false
  const [pdfOK, setPdfOK] = useState(null);       // true/false（MVP2默认不用，仅检测）

  async function ping() {
    try {
      const r = await fetch(API.health);
      setHealthOK(r.ok);
    } catch {
      setHealthOK(false);
    }
    try {
      // 对 /pdf 做一个 OPTIONS/HEAD/GET 的软探测（多数后端是 POST，这里只看是否 404）
      const r = await fetch(API.pdf, { method: "OPTIONS" });
      setPdfOK(r.ok || r.status === 405 /* 方法不允许也说明路由在 */);
    } catch {
      setPdfOK(false);
    }
  }

  useEffect(() => {
    ping(); // 首屏做一次检查
  }, []);

  // === 抓取逻辑 ===
  async function doScrape() {
    if (!scrapeUrl.trim()) return alert("请输入要抓取的 URL");
    setIsFetching(true);
    setScrapeJSON("");
    try {
      const res = await fetch(`${API.scrape}?url=${encodeURIComponent(scrapeUrl)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setScrapeJSON(JSON.stringify(data, null, 2));
    } catch (err) {
      alert(`抓取失败：${err.message || err}`);
    } finally {
      setIsFetching(false);
    }
  }

  // === 一键回填（将抓取结果映射到行：name/sku/price/moq/params） ===
  function fillFromScrape() {
    if (!scrapeJSON) return alert("请先抓取成功，再回填。");
    const data = safeJSON(scrapeJSON, {});
    const next = { ...row };

    // 映射策略：尽量温柔——找到就覆盖，找不到就保留原值
    if (data.title) next.name = data.title;
    if (data.sku) next.sku = data.sku;
    if (typeof data.price !== "undefined" && data.price !== null && data.price !== "") {
      const n = Number(data.price);
      if (!Number.isNaN(n)) next.price = n;
    }
    if (typeof data.moq !== "undefined" && data.moq !== null && data.moq !== "") {
      const n = Number(data.moq);
      if (!Number.isNaN(n)) next.moq = n;
    }

    // params：把抓到的 sku/price/currency/description/h1 等塞进 params 里，方便后续导出或审阅
    const oldParams = safeJSON(next.params, {});
    const merged = {
      ...oldParams,
      scraped: {
        url: data.url || scrapeUrl,
        title: data.title,
        description: data.description,
        h1: data.h1,
        sku: data.sku,
        price: data.price,
        currency: data.currency,
        moq: data.moq,
        approxTextLength: data.approxTextLength,
      },
    };
    next.params = JSON.stringify(merged, null, 0);

    setRow(next);
    alert("一键回填成功！");
  }

  // === 表格输入 ===
  function updateField(key, v) {
    setRow((p) => ({ ...p, [key]: v }));
  }

  // === 导出 / 生成（示意）===
  function onExportExcel() {
    alert("（示意）已触发现有的导出/生成逻辑。你可以继续沿用 MVP2 原有实现。");
  }

  return (
    <div style={{ padding: "16px", fontFamily: "system-ui, -apple-system, Segoe UI, Roboto" }}>
      <h2>结构化报价 + 自动推荐语（MVP2）</h2>

      <div style={{ opacity: healthOK === false ? 0.6 : 1 }}>
        <div style={{ marginBottom: 6 }}>
          <small>
            API_BASE = <code>{API_BASE}</code>{" "}
            {healthOK === null ? "(检测中...)" : healthOK ? "（健康 OK）" : "（健康失败）"}{" "}
            | PDF 端点 {pdfOK === null ? "检测中..." : pdfOK ? "可达/存在" : "不存在（正常）"}
          </small>{" "}
          <button onClick={ping} style={{ marginLeft: 8 }}>重新检测</button>
        </div>

        {/* 单行表格（沿用 MVP2 字段） */}
        <table width="100%" border="1" cellPadding="6" style={{ borderCollapse: "collapse", marginBottom: 10 }}>
          <thead>
            <tr>
              <th width="28%">Name</th>
              <th width="18%">SKU</th>
              <th width="12%">Price</th>
              <th width="12%">MOQ</th>
              <th>Params(JSON)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <input
                  style={{ width: "100%" }}
                  value={row.name}
                  onChange={(e) => updateField("name", e.target.value)}
                />
              </td>
              <td>
                <input
                  style={{ width: "100%" }}
                  value={row.sku}
                  onChange={(e) => updateField("sku", e.target.value)}
                />
              </td>
              <td>
                <input
                  style={{ width: "100%" }}
                  value={row.price}
                  onChange={(e) => updateField("price", e.target.value)}
                />
              </td>
              <td>
                <input
                  style={{ width: "100%" }}
                  value={row.moq}
                  onChange={(e) => updateField("moq", e.target.value)}
                />
              </td>
              <td>
                <input
                  style={{ width: "100%" }}
                  value={row.params}
                  onChange={(e) => updateField("params", e.target.value)}
                />
              </td>
            </tr>
          </tbody>
        </table>

        <div style={{ marginBottom: 16 }}>
          <button onClick={onExportExcel}>导出 Excel（示意）</button>
        </div>

        {/* === 单个 抓取 & 回填 区块（只保留这一份）=== */}
        <section style={{ border: "1px solid #ddd", padding: 10 }}>
          <h3>🔎 网页抓取 & 一键回填（/v1/api/scrape）</h3>

          <div style={{ marginBottom: 8 }}>
            <input
              style={{ width: "60%" }}
              placeholder="https://example.com"
              value={scrapeUrl}
              onChange={(e) => setScrapeUrl(e.target.value)}
            />
            <button style={{ marginLeft: 8 }} disabled={isFetching} onClick={doScrape}>
              {isFetching ? "抓取中..." : "抓取"}
            </button>
            <button style={{ marginLeft: 8 }} onClick={fillFromScrape}>
              一键回填到上方表格
            </button>
          </div>

          <textarea
            style={{ width: "100%", height: 200, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas" }}
            value={scrapeJSON}
            onChange={(e) => setScrapeJSON(e.target.value)}
            placeholder="抓取结果 JSON 会显示在这里（可修改后再回填）"
          />
        </section>
      </div>
    </div>
  );
}
