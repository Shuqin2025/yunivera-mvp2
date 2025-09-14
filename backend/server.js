import express from "express";
import cors from "cors";
import axios from "axios";
import * as cheerio from "cheerio";
import ExcelJS from "exceljs";

const app = express();
app.use(cors({ origin: "*", exposedHeaders: ["X-Lang"] }));

app.get(["/", "/healthz"], (_req, res) => res.type("text/plain").send("ok"));
app.get("/v1/api/__version", (_req, res) => {
  res.json({
    version: "restore-mvp-2025-09-14-xlsx-img",
    note: "S-Impuls catalog parser + image proxy + Excel export (images embedded)",
  });
});

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/* -------------------- 基础工具 -------------------- */
async function fetchHtml(targetUrl) {
  const { data } = await axios.get(targetUrl, {
    headers: {
      "User-Agent": UA,
      "Accept-Language": "de,en;q=0.8,zh;q=0.6",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      Referer: targetUrl,
    },
    timeout: 25000,
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 400,
  });
  return typeof data === "string" ? data : "";
}
function abs(base, maybe) {
  if (!maybe) return "";
  try { return new URL(maybe, base).href; } catch { return ""; }
}
function text($el) { return ($el.text() || "").replace(/\s+/g, " ").trim(); }
function guessSkuFromTitle(title) {
  if (!title) return "";
  const m = title.match(/\b[0-9]{4,}\b/) || title.match(/\b[0-9A-Z]{4,}(?:-[0-9A-Z]{2,})*\b/i);
  return m ? m[0] : "";
}

/* -------------------- 图片代理（给前端用） -------------------- */
app.get("/v1/api/image", async (req, res) => {
  const url = String(req.query.url || "").trim();
  if (!url) return res.status(400).send("missing url");
  try {
    const r = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 20000,
      headers: {
        "User-Agent": UA,
        Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
        Referer: url,
      },
      validateStatus: (s) => s >= 200 && s < 400,
    });
    res.set("Content-Type", r.headers["content-type"] || "image/jpeg");
    res.set("Cache-Control", "public, max-age=604800");
    res.send(r.data);
  } catch (e) {
    console.error("[image] fail:", e?.message || e);
    res.status(502).send("image fetch failed");
  }
});

/* -------------------- 列表解析（S-Impuls） -------------------- */
async function parseSImpulsCatalog(listUrl, limit = 50) {
  const html = await fetchHtml(listUrl);
  const $ = cheerio.load(html);

  let cardRoots = $("#nx_content .listproduct-wrapper .listproduct");
  const candidates = [
    { item: ".listproduct .product, .listproduct > div" },
    { item: "div.product-layout, div.product-thumb, div.product-grid .product-layout" },
    { item: ".row .product-layout, .row .product-thumb" },
  ];

  const items = [];
  function pushItem(aEl) {
    if (items.length >= limit) return;
    const $a = $(aEl);
    const href = $a.attr("href") || "";
    if (!href || !href.includes("/product/")) return;

    const title = ($a.attr("title") || "").trim() || text($a);
    let $card = $a.closest("div");
    if ($card.length === 0) $card = $a.parent();
    const $img = $card.find(".image img").first().length
      ? $card.find(".image img").first()
      : $card.find("img").first();

    const imgSrc =
      $img.attr("data-src") || $img.attr("data-original") || $img.attr("src") || "";
    const img = abs(listUrl, (imgSrc || "").split("?")[0]);
    const priceTxt = text($card.find(".price, .product-price, .amount, .m-price").first()) || "";
    const skuTxt = text($card.find(".product-model, .model, .sku").first()) || guessSkuFromTitle(title);

    items.push({
      sku: skuTxt,
      title,
      url: abs(listUrl, href),
      img,
      price: priceTxt || null,
      currency: "",
      moq: "",
    });
  }

  if (cardRoots.length) cardRoots.find('a[href*="/product/"]').each((_i, a) => pushItem(a));
  if (items.length === 0) {
    for (const c of candidates) {
      const $cards = $(c.item);
      if ($cards.length === 0) continue;
      $cards.each((_i, el) => $(el).find('a[href*="/product/"]').each((_j, a) => pushItem(a)));
      if (items.length > 0) break;
    }
  }
  return items;
}

/* -------------------- 详情页富化（保留能力，可选） -------------------- */
async function enrichDetail(item) {
  try {
    const html = await fetchHtml(item.url);
    const $ = cheerio.load(html);
    const priceSel = ".price, .product-price, [itemprop='price'], .price-value, .price .amount";
    const moqSel = ".moq, .min-order, .minimum, .minbestellmenge, .minimum-order, .minimum__value";
    const priceText = text($(priceSel).first());
    const moqText = text($(moqSel).first());
    if (priceText) item.price = priceText;
    if (moqText) item.moq = moqText;
  } catch { /* ignore */ }
}

/* -------------------- 解析 API -------------------- */
app.get("/v1/api/catalog/parse", async (req, res) => {
  const listUrl = String(req.query.url || "").trim();
  const limit = Math.max(1, Math.min(parseInt(String(req.query.limit || "50"), 10) || 50, 200));
  const enrich = String(req.query.enrich || "").toLowerCase() === "true";
  if (!listUrl) return res.status(400).json({ ok: false, error: "missing url" });

  const t0 = Date.now();
  try {
    const host = new URL(listUrl).hostname;
    console.log("[parse:start]", { host, limit, enrich, url: listUrl });

    let items = [];
    if (host.includes("s-impuls-shop.de")) {
      items = await parseSImpulsCatalog(listUrl, limit);
    }

    if (enrich && items.length) {
      const N = Math.min(items.length, 20);
      await Promise.all(items.slice(0, N).map(enrichDetail));
    }

    const payload = { ok: true, url: listUrl, count: items.length, products: items, items };
    res.setHeader("X-Lang", "de");
    console.log("[parse:done]", { host, count: items.length, ms: Date.now() - t0, enrich });
    res.json(payload);
  } catch (err) {
    console.error("[parse:fail]", { url: listUrl, ms: Date.now() - t0, err: String(err?.message || err) });
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

/* -------------------- 导出 Excel（内嵌图片） -------------------- */
async function fetchImageBuffer(url) {
  if (!url) return null;
  try {
    const r = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 20000,
      headers: { "User-Agent": UA, Accept: "image/avif,image/webp,image/*,*/*;q=0.8", Referer: url },
      validateStatus: (s) => s >= 200 && s < 400,
    });
    const buf = Buffer.from(r.data);
    const ctype = String(r.headers["content-type"] || "").toLowerCase();
    const ext = ctype.includes("png") ? "png" : "jpeg";
    return { buf, ext };
  } catch (e) {
    console.warn("[img skip]", url, e?.message || e);
    return null;
  }
}

app.get("/v1/api/catalog/export", async (req, res) => {
  const listUrl = String(req.query.url || "").trim();
  const limit = Math.max(1, Math.min(parseInt(String(req.query.limit || "50"), 10) || 50, 200));
  if (!listUrl) return res.status(400).send("missing url");

  try {
    const items = await parseSImpulsCatalog(listUrl, limit);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("catalog");

    ws.columns = [
      { header: "Item No.", key: "sku", width: 14 },
      { header: "Picture", key: "picture", width: 16 },
      { header: "Description", key: "title", width: 60 },
      { header: "MOQ", key: "moq", width: 10 },
      { header: "Unit Price", key: "price", width: 16 },
      { header: "Link", key: "link", width: 12 },
    ];

    // 表头居中加粗
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).alignment = { vertical: "middle", horizontal: "center" };

    // 写数据行（先占位，再插图）
    items.forEach((it) => {
      const r = ws.addRow({
        sku: it.sku || "",
        picture: "", // 图片后续插入
        title: it.title || "",
        moq: it.moq || "",
        price: it.price || "",
        link: "链接",
      });
      // 给链接加超链接
      const linkCell = r.getCell("link");
      linkCell.value = { text: "链接", hyperlink: it.url };
      linkCell.font = { color: { argb: "FF0563C1" }, underline: true };
      // 让图片行高稍微高一点
      r.height = 64;
    });

    // 插图（按行）
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const info = await fetchImageBuffer(it.img);
      if (!info) continue;
      const imgId = wb.addImage({ buffer: info.buf, extension: info.ext });
      // B 列是 picture，ExcelJS 坐标以 0 为起点；tl.col=1 表示第 2 列
      ws.addImage(imgId, {
        tl: { col: 1, row: i + 1 },      // i+1 -> 数据行从第 2 行开始
        ext: { width: 64, height: 64 },
        editAs: "oneCell",
      });
    }

    const buf = await wb.xlsx.writeBuffer();
    const filename = `catalog-${Date.now()}.xlsx`;
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(Buffer.from(buf));
  } catch (e) {
    console.error("[export error]", e?.message || e);
    res.status(500).send("export failed");
  }
});

/* -------------------- 启动 -------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[mvp2-backend] listening on :${PORT}`));
