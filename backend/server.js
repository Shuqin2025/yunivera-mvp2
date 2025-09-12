// backend/server.js
/* eslint-disable no-console */
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");           // v2
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");
const cheerio = require("cheerio");
const { URL } = require("url");

const app = express();
const PORT = process.env.PORT || 3000;

// --- Middlewares ---
app.use(cors({ origin: true }));
app.use(express.json({ limit: "3mb" }));

// --- Utils ---
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchText(url, init = {}) {
  const res = await fetch(url, { ...init, timeout: 20000 });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}
async function fetchBuffer(url, init = {}) {
  const res = await fetch(url, { ...init, timeout: 20000 });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.buffer();
}
function absUrl(base, maybe) {
  try {
    if (!maybe) return "";
    return new URL(maybe, base).toString();
  } catch { return maybe || ""; }
}

// -------- Health --------
app.get("/v1/api/health", (_req, res) => {
  res.type("text/plain").send("OK");
});

// -------- Catalog Parse --------
app.post("/v1/api/catalog/parse", async (req, res) => {
  const { url, limit = 100 } = req.body || {};
  if (!url) return res.status(400).json({ error: "missing url" });

  try {
    const html = await fetchText(url, { headers: { "user-agent": "Mozilla/5.0 MVP3/1.0" } });
    const $ = cheerio.load(html);
    const host = new URL(url).host;

    // site-specific: s-impuls-shop.de
    let items = [];
    if (/s-impuls-shop\.de$/i.test(host)) {
      // 常见列表容器：卡片里通常有 <a href="/product/..."> 与 <img src="/img/products/thumb/xxxx.jpg">
      const cards = $('a[href*="/product/"]').closest("article,li,div");
      cards.each((_, el) => {
        const $el = $(el);
        const a = $el.find('a[href*="/product/"]').first();
        const href = absUrl(url, a.attr("href"));

        // 标题：a 文本 + 旁边的小字
        const title =
          (a.text().trim() ||
           $el.find("h2,h3,.title,.product-title").first().text().trim() || "");

        // SKU：标题起始的一段货号（字母/数字/短横）
        const skuMatch = title.match(/[A-Z0-9]+(?:[-.][A-Z0-9]+)*/i);
        const sku = skuMatch ? skuMatch[0].toUpperCase() : "";

        // 图片：thumb 或者 <img> 的 src
        const img = absUrl(url,
          $el.find('img[src*="/img/"]').attr("src") ||
          a.find("img").attr("src") ||
          ""
        );

        // 列表页多数没有价格 / MOQ，这里留空
        const price =
          $el.find(".price,.product-price,[data-price]").first().text().trim() || "";
        const moq =
          $el.find(".moq,[data-moq]").first().text().trim() || "";

        items.push({
          sku,
          title,
          url: href,
          image: img,
          price,
          moq,
        });
      });
    }

    // fallback 通用解析（尽力而为）
    if (items.length === 0) {
      $('a[href]').each((_, a) => {
        const href = $(a).attr("href") || "";
        if (!/\/product/i.test(href)) return;
        const $a = $(a);
        const card = $a.closest("article,li,div");
        const img = absUrl(url, card.find("img").attr("src") || $a.find("img").attr("src") || "");
        const title = ($a.text() || card.find("h2,h3,.title").first().text() || "").trim();
        const sku = (title.match(/[A-Z0-9]+(?:[-.][A-Z0-9]+)*/i) || [""])[0].toUpperCase();
        items.push({
          sku,
          title,
          url: absUrl(url, href),
          image: img,
          price: "",
          moq: "",
        });
      });
    }

    // 去重 + 截断
    const seen = new Set();
    const out = [];
    for (const it of items) {
      const key = it.url || it.title;
      if (key && !seen.has(key)) { seen.add(key); out.push(it); }
      if (out.length >= limit) break;
    }

    return res.json({ source: url, count: out.length, items: out });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e.message || e) });
  }
});

// -------- Export: Excel (with inline images) --------
app.post("/v1/api/export/excel", async (req, res) => {
  // 允许两种 payload：
  // 1) { columns, rows }（前端自带列配置）
  // 2) { rows } （我们固定列顺序）
  const { rows: rawRows, columns } = req.body || {};
  const rows = Array.isArray(rawRows) ? rawRows : [];

  try {
    const wb = new ExcelJS.Workbook();
    wb.creator = "MVP3";
    wb.created = new Date();

    const ws = wb.addWorksheet("catalog", {
      properties: { defaultRowHeight: 18 },
      views: [{ state: "frozen", ySplit: 1 }],
    });

    // 固定列顺序（Item No. | Picture | Description | MOQ | Unit Price | Link）
    ws.columns = [
      { header: "Item No.",   key: "sku",   width: 18 },
      { header: "Picture",    key: "image", width: 14 },
      { header: "Description",key: "title", width: 60 },
      { header: "MOQ",        key: "moq",   width: 12 },
      { header: "Unit Price", key: "price", width: 14 },
      { header: "Link",       key: "url",   width: 80 }
    ];

    // 表头加粗
    ws.getRow(1).font = { bold: true };

    // 写入行（先写文本，图片稍后盖在单元格上）
    rows.forEach((r) => {
      ws.addRow({
        sku:   r.sku || "",
        image: r.image || "",
        title: r.title || r.name || "",
        moq:   r.moq   ?? "",
        price: r.price ?? "",
        url:   r.url   || r.link || "",
      });
    });

    // 链接超链接化 + 自动换行
    for (let i = 2; i <= ws.rowCount; i++) {
      const urlCell = ws.getCell(i, 6);
      if (urlCell.value) {
        urlCell.value = { text: "链接", hyperlink: String(urlCell.value) };
        urlCell.font = { color: { argb: "FF1F4E79" }, underline: true };
      }
      ws.getCell(i, 3).alignment = { wrapText: true };
      ws.getRow(i).height = 68; // 给图片腾空间
    }

    // 下载并嵌入图片（如果失败就跳过）
    for (let i = 2; i <= ws.rowCount; i++) {
      const url = ws.getCell(i, 2).value; // 第二列是 image url（临时存放）
      if (!url) continue;

      try {
        const buf = await fetchBuffer(url, { headers: { "user-agent": "Mozilla/5.0 MVP3/1.0" } });
        const imgId = wb.addImage({ buffer: buf, extension: "jpeg" /* png 也能识别 */ });

        // 把“真实图片”画到第 i 行第 2 列单元格范围内
        ws.addImage(imgId, {
          tl: { col: 1 + 0.15, row: i - 1 + 0.15 },   // 左上角（列/行从 0 开始）
          ext: { width: 80, height: 60 },             // 图片显示尺寸
          editAs: "oneCell",
        });

        // 把图片列的“原始 URL”改成空字符串，避免显得杂乱
        ws.getCell(i, 2).value = "";
      } catch {
        // 忽略个别图片失败
      }

      // 轻微节流，降低被目标站限速的概率
      if (i % 12 === 0) await sleep(30);
    }

    // 输出
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader("Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition",
      `attachment; filename="catalog-preview-${Date.now()}.xlsx"`);
    return res.send(Buffer.from(buf));
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e.message || e) });
  }
});

// -------- Export: simple PDF (optional, keeps your old button working) --------
app.post("/v1/api/pdf", (req, res) => {
  const { title = "Quote", text = "" } = req.body || {};
  res.setHeader("Content-Type", "application/pdf");
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  doc.pipe(res);
  doc.fontSize(16).text(title, { underline: true });
  doc.moveDown();
  doc.fontSize(11).text(text || "(empty)");
  doc.end();
});

// -------- Start --------
app.listen(PORT, () => {
  console.log(`[mvp3-backend] listening on :${PORT}`);
});
