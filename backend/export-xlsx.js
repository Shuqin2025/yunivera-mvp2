/**
 * export-xlsx.js
 * Drop-in Excel exporter with embedded images via backend proxy.
 * Requires: ExcelJS loaded; window.lastRows provided by ui-enhance.js
 */
(function () {
  const API_BASE = new URLSearchParams(location.search).get("api") || "";
  const log = (...args) => console.info("[export-xlsx]", ...args);

  async function fetchImageBase64(imgUrl) {
    if (!API_BASE || !imgUrl) return null;
    const api = `${API_BASE.replace(/\/$/, "")}/v1/api/image?format=base64&url=${encodeURIComponent(imgUrl)}`;
    try {
      const r = await fetch(api, { mode: "cors" });
      if (!r.ok) return null;
      const data = await r.json();
      if (!data || !data.ok || !data.base64) return null;
      if (String(data.base64).startsWith("data:")) return data.base64;
      const ct = String(data.contentType || "image/jpeg");
      return `data:${ct};base64,${data.base64}`;
    } catch (e) { return null; }
  }

  async function withPool(tasks, size) {
    const ret = new Array(tasks.length);
    let i = 0, active = 0;
    return await new Promise((resolve) => {
      const next = () => {
        if (i >= tasks.length && active === 0) return resolve(ret);
        while (active < size && i < tasks.length) {
          const idx = i++; active++;
          tasks[idx]().then((v) => ret[idx] = v).catch(() => ret[idx] = null).finally(() => { active--; next(); });
        }
      };
      next();
    });
  }

  async function exportXlsx() {
    if (!Array.isArray(window.lastRows) || window.lastRows.length === 0) {
      alert("没有可以导出的数据"); return;
    }
    if (!window.ExcelJS) { alert("ExcelJS 未加载"); return; }

    log("prefetch images via", API_BASE);
    const tasks = window.lastRows.map((r) => () => fetchImageBase64(r.img));
    const imgs = await withPool(tasks, 6);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");
    ws.columns = [
      { header: "#", key: "idx", width: 5 },
      { header: "货号", key: "sku", width: 20 },
      { header: "图片", key: "img", width: 20 },
      { header: "描述", key: "title", width: 50 },
      { header: "起订量", key: "moq", width: 10 },
      { header: "单价", key: "price", width: 15 },
      { header: "链接", key: "link", width: 50 },
    ];

    window.lastRows.forEach((r, i) => {
      ws.addRow({
        idx: i + 1,
        sku: r.sku || "",
        img: "",
        title: r.title || r.desc || "",
        moq: r.moq || "",
        price: r.currency ? `${r.price || ""} ${r.currency}` : (r.price || ""),
        link: r.link || r.url || "",
      });
    });

    imgs.forEach((dataUrl, i) => {
      if (!dataUrl) return;
      const m = String(dataUrl).match(/^data:([\w/+.-]+);base64,/i);
      const ext = m ? (m[1].split("/")[1] || "jpeg") : "jpeg";
      const id = wb.addImage({ base64: dataUrl.split(",")[1], extension: ext });
      const row = i + 2;
      ws.addImage(id, { tl: { col: 2.1, row: row - 0.9 }, ext: { width: 80, height: 80 }, editAs: 'oneCell' });
      const rr = ws.getRow(row); if (rr && (!rr.height || rr.height < 70)) rr.height = 70;
    });

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "catalog.xlsx";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  window.exportXlsx = exportXlsx;
  log("ready");
})();
