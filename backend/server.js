// ESM 版本：与 package.json 中 "type": "module" 匹配
import express from "express";
import cors from "cors";
import axios from "axios";
import * as cheerio from "cheerio";
import ExcelJS from "exceljs";
import urlLib from "url";

const app = express();
const PORT = process.env.PORT || 10000;

// 允许跨域（含自定义头）
app.use(cors({ origin: true, credentials: false }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Lang");
  next();
});

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0 Safari/537.36";

/** 工具：取绝对地址 */
function absUrl(base, maybe) {
  try {
    return new URL(maybe, base).toString();
  } catch (_) {
    return maybe || "";
  }
}

/** 工具：抓 HTML */
async function fetchHTML(target) {
  const resp = await axios.get(target, {
    headers: { "User-Agent": UA, Referer: target },
    timeout: 20000,
  });
  return resp.data;
}

/** 解析目录页（尽量通用，兼容 s-impuls / auto-schmuck 等） */
async function parseCatalog(listUrl, limit = 50) {
  const html = await fetchHTML(listUrl);
  const $ = cheerio.load(html);
  const items = [];

  // 针对多站点的兜底选择器
  const tiles = $(
    [
      // s-impuls-shop（Shopware）
      "div.product-box, div.product--box, article.product-box, article.product--box, div.product-small",
      // 其它站点常见
      "[itemprop='itemListElement'], li.product, article.product, div.product",
    ].join(",")
  );

  tiles.each((i, el) => {
    if (items.length >= limit) return;

    const $el = $(el);

    // 名称
    const title =
      $el.find("[itemprop='name']").text().trim() ||
      $el.find(".product-name, .product-title, .title, a").first().text().trim() ||
      $el.text().trim().split("\n")[0];

    // 链接
    const href =
      $el.find("a[href]").first().attr("href") ||
      $el.find("link[itemprop='url']").attr("href");
    const url = absUrl(listUrl, href);

    // 图片（src / data-src / data-original 都试一下）
    const imgEl =
      $el.find("img").first() ||
      $el.find("img[data-src]").first() ||
      $el.find("img[data-original]").first();
    const img =
      absUrl(listUrl, imgEl.attr("src")) ||
      absUrl(listUrl, imgEl.attr("data-src")) ||
      absUrl(listUrl, imgEl.attr("data-original"));

    // 价格（欧站普遍：€、EUR）
    let priceText =
      $el
        .find(
          ".price, .product-price, [itemprop='price'], .product-box-price, .price--default"
        )
        .first()
        .text()
        .trim() || "";
    const mPrice = priceText.match(
      /([€$]|EUR|USD)\s*([\d.,]+)|([\d.,]+)\s*(€|EUR|USD)/
    );
    let price = "";
    let currency = "";
    if (mPrice) {
      const num = mPrice[2] || mPrice[3] || "";
      price = num.replace(/\./g, "").replace(/,/g, "."); // 1.234,56 → 1234.56
      currency = (mPrice[1] || mPrice[4] || "").replace(/\s+/g, "");
    }

    // 货号 / SKU：常见是纯数字或“数字-字母组合”
    // 例：30805-MHQ-SLIM、40102-MHQ
    let sku = "";
    const mSku =
      title.match(/\b(\d{4,}[-A-Z0-9]+)\b/i) ||
      title.match(/\b(\d{5,})\b/) ||
      (url && url.match(/\/(\d{4,}[-A-Z0-9]+)\b/i));
    if (mSku) sku = mSku[1];

    if (title && url) {
      items.push({
        sku,
        title,
        url,
        img,
        price,
        currency,
        moq: "", // 目录页大多没有 MOQ，如需从详情页抓可在此扩展
      });
    }
  });

  return { url: listUrl, count: items.length, items };
}

/** API1：解析目录页，返回 JSON */
app.get("/v1/api/catalog/parse", async (req, res) => {
  try {
    const listUrl = req.query.url;
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 500);
    if (!listUrl) return res.status(400).json({ error: "missing url" });

    const data = await parseCatalog(listUrl, limit);
    res.json(data);
  } catch (err) {
    console.error("[parse]", err?.message);
    res.status(500).json({ error: String(err?.message || err) });
  }
});

/** API2：图片代理（前端/Excel 都统一走这里，避免 CORS） */
app.get("/v1/api/img", async (req, res) => {
  try {
    const target = req.query.url;
    if (!target) return res.status(400).send("missing url");

    const resp = await axios.get(target, {
      responseType: "arraybuffer",
      headers: { "User-Agent": UA, Referer: target },
      timeout: 20000,
    });

    const type = resp.headers["content-type"] || "image/jpeg";
    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(resp.data);
  } catch (err) {
    console.error("[img]", err?.message);
    res.status(502).send("bad image");
  }
});

/** API3：一键导出 Excel（服务端用 exceljs 嵌入“真实图片”） */
app.get("/v1/api/catalog/export.xlsx", async (req, res) => {
  try {
    const listUrl = req.query.url;
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 500);
    if (!listUrl) return res.status(400).send("missing url");

    const { items } = await parseCatalog(listUrl, limit);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("catalog");

    // 表头
    ws.columns = [
      { header: "Item No.", key: "sku", width: 20 },
      { header: "Picture", key: "pic", width: 14 },
      { header: "Description", key: "title", width: 60 },
      { header: "MOQ", key: "moq", width: 10 },
      { header: "Unit Price", key: "price", width: 12 },
      { header: "Link", key: "link", width: 80 },
    ];

    // 行高用于放图片
    const ROW_H = 62; // 大约 82px
    ws.getRow(1).height = 22;

    // 逐行写入（图片后置添加）
    let rowStart = 2;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const r = ws.getRow(rowStart + i);
      r.values = {
        sku: it.sku || "",
        pic: "", // 稍后 addImage
        title: it.title || "",
        moq: it.moq || "",
        price: it.price ? `${it.price}${it.currency || ""}` : "",
        link: it.url || "",
      };
      r.height = ROW_H;

      // 链接超链接 & 文本
      const cell = ws.getCell(rowStart + i, 6);
      if (it.url) {
        cell.value = { text: "链接", hyperlink: it.url };
        cell.font = { color: { argb: "FF0000FF" }, underline: true };
      }
    }

    // 嵌入图片
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.img) continue;

      try {
        const imgResp = await axios.get(it.img, {
          responseType: "arraybuffer",
          headers: { "User-Agent": UA, Referer: it.url || listUrl },
          timeout: 20000,
        });
        const ctype = (imgResp.headers["content-type"] || "").toLowerCase();
        let ext = "jpeg";
        if (ctype.includes("png")) ext = "png";
        else if (ctype.includes("webp")) ext = "webp";

        const id = wb.addImage({ buffer: imgResp.data, extension: ext });

        // 图片放在第 2 列（B 列），第 i+2 行这个单元格区域
        const rowIdx = rowStart + i;
        ws.addImage(id, {
          tl: { col: 1 + 0.2, row: rowIdx - 1 + 0.2 }, // 略微内缩
          ext: { width: 80, height: 80 },
        });
      } catch (e) {
        console.warn("[img-embed]", it.img, e.message);
      }
    }

    // 输出
    const filename = `catalog-preview-${new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/[:T]/g, "")}.xlsx`;
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("[export]", err?.message);
    res.status(500).send(String(err?.message || err));
  }
});

app.get("/health", (_, res) => res.send("OK"));

app.listen(PORT, () => {
  console.log(`[mvp2] backend listening on :${PORT}`);
});
