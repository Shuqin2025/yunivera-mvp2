import ExcelJS from 'exceljs';

// 把远程图片转为 base64 格式
async function fetchImageAsBase64(url) {
  try {
    const resp = await fetch(`${window.API_BASE}/v1/api/image?format=base64&url=${encodeURIComponent(url)}`);
    if (!resp.ok) throw new Error('图片获取失败');
    const data = await resp.json();
    return data.base64 || null;
  } catch (err) {
    console.warn('图片转换失败:', url, err);
    return null;
  }
}

export async function exportToXlsx(items) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('产品列表');

  ws.columns = [
    { header: '#', key: 'index', width: 6 },
    { header: 'Item No.', key: 'name', width: 30 },
    { header: 'Picture', key: 'image', width: 20 },
    { header: 'Description', key: 'desc', width: 40 },
    { header: 'MOQ', key: 'moq', width: 10 },
    { header: 'Unit Price', key: 'price', width: 15 },
    { header: 'Link', key: 'link', width: 40 },
  ];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const row = ws.addRow({
      index: i + 1,
      name: item.name,
      desc: item.desc,
      moq: item.moq,
      price: item.price,
      link: item.link,
    });

    // 加图处理
    if (item.image) {
      const base64 = await fetchImageAsBase64(item.image);
      if (base64) {
        const imgId = wb.addImage({
          base64,
          extension: 'jpeg', // 可选: 可根据图片类型调整
        });
        ws.addImage(imgId, {
          tl: { col: 2, row: i + 1 },
          ext: { width: 80, height: 80 },
        });
      }
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'products.xlsx';
  link.click();
}
