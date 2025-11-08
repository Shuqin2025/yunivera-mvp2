// backend/lib/modules/artikelExtractor.js
const LABELS = [
  // de
  /artikel[-\s]?nr\.?/i, /art\.\s?nr\.?/i, /hersteller[-\s]?nr\.?/i,
  /bestell[-\s]?nr\.?/i, /teilenummer/i, /lieferanten[-\s]?nr\.?/i,
  // en
  /\bsku\b/i, /\bpart(?:\s*no\.?| number)?\b/i, /\bp\/n\b/i, /\bpn\b/i,
  /\bmanufacturer(?:'s)?\s*no\.?\b/i,
  // universal
  /\bmodel(?:\s*no\.?)?\b/i,
];

const EAN_LABELS = [/\bean[-\s]?13?\b/i, /\bgtin[-\s]?13?\b/i, /\bbarcode\b/i];

const STRIP = v => String(v || '').replace(/\s+/g, ' ').trim();

// ---------- EAN validators ----------
function isDigits(s) { return /^[0-9]+$/.test(s); }

function validateEAN13(code) {
  if (!isDigits(code) || code.length !== 13) return false;
  const digits = code.split('').map(d => +d);
  const sum = digits.slice(0, 12).reduce((acc, d, i) => acc + d * (i % 2 ? 3 : 1), 0);
  const check = (10 - (sum % 10)) % 10;
  return check === digits[12];
}

function validateEAN8(code) {
  if (!isDigits(code) || code.length !== 8) return false;
  const digits = code.split('').map(d => +d);
  const sum = digits.slice(0, 7).reduce((acc, d, i) => acc + d * (i % 2 ? 3 : 1), 0);
  const check = (10 - (sum % 10)) % 10;
  return check === digits[7];
}

// ---------- core extractors ----------
function extractEANs(text) {
  const out = new Set();
  const t = STRIP(text);

  // 1) 带标签的 EAN
  EAN_LABELS.forEach(lbl => {
    const re = new RegExp(`${lbl.source}\\s*[:：]?\\s*([0-9]{8}|[0-9]{13})`, 'ig');
    let m;
    while ((m = re.exec(t))) {
      const c = m[1];
      if ((c.length === 13 && validateEAN13(c)) || (c.length === 8 && validateEAN8(c))) {
        out.add(c);
      }
    }
  });

  // 2) 无标签但像 EAN 的纯数字（谨慎；只接受 13/8 并校验）
  const rePlain = /\b([0-9]{13}|[0-9]{8})\b/g;
  let m2;
  while ((m2 = rePlain.exec(t))) {
    const c = m2[1];
    if ((c.length === 13 && validateEAN13(c)) || (c.length === 8 && validateEAN8(c))) {
      out.add(c);
    }
  }
  return Array.from(out);
}

function extractSKUs(text) {
  const out = new Set();
  const t = STRIP(text);

  // 1) 标签 + 值
  LABELS.forEach(lbl => {
    const re = new RegExp(`${lbl.source}\\s*[:：]?\\s*([A-Za-z0-9._\\-\\/]{3,})`, 'ig');
    let m;
    while ((m = re.exec(t))) {
      const v = m[1].replace(/[,;)\]}]+$/, ''); // 末尾收尾符
      // 过滤纯数字且看起来像价格/邮编等的噪声
      if (/^\d{1,4}$/.test(v)) continue;
      out.add(v);
    }
  });

  // 2) URL 段中的候选（如 /sku/ABC-123 或 ?sku=ABC-123）
  const urlRe = /\b(?:sku|art(?:ikel)?-?nr|pn|p\/n|part(?:no|number)?)=([A-Za-z0-9._\-\/]{3,})/ig;
  let m2;
  while ((m2 = urlRe.exec(t))) out.add(m2[1]);
  return Array.from(out);
}

function extractFromText(text) {
  const eans = extractEANs(text);
  const skus = extractSKUs(text);
  return { eans, skus };
}

function extractFromHtml($, root) {
  // 在 HTML 中找常见位置
  const $root = root ? $(root) : $.root();

  // 组装一个“搜索文本池”
  let bag = [];

  // 1) 常见详情区域
  $root.find(`
    [itemprop="sku"], [itemprop="gtin13"], [itemprop="gtin8"],
    [data-product-sku], .product--suppliernumber, .product--manufacturer, .product--sku,
    .product--details, .product-details, .product-attributes, .product--info,
    .product--description, .pdp-description, .specs, .specification, .attributes,
    .detail--base-info, .detail--product, .base-info, .product--meta
  `).each((_, el) => bag.push($(el).text()));

  // 2) 表格(规格/属性)
  $root.find('table,tr').each((_, el) => bag.push($(el).text()));

  // 3) meta/隐藏
  const metaSku = $('meta[itemprop="sku"]').attr('content');
  if (metaSku) bag.push(`SKU: ${metaSku}`);
  const metaGtin = $('meta[itemprop^="gtin"]').attr('content');
  if (metaGtin) bag.push(`EAN: ${metaGtin}`);

  const text = STRIP(bag.join('\n'));
  return extractFromText(text);
}

// 挑一个“最稳”的唯一编号：优先 EAN(13/8) → SKU(最像料号/含字母或连字符)
function pickBestId({ eans = [], skus = [] } = {}) {
  if (eans.length) return { id: eans[0], type: eans[0].length === 13 ? 'EAN13' : 'EAN8' };
  if (skus.length) {
    // 简单排序：含字母/连字符优先，长度适中优先
    const sorted = skus.slice().sort((a, b) => {
      const score = s => (/[A-Za-z]/.test(s) ? 2 : 0) + (/-|_/.test(s) ? 1 : 0) - Math.abs(10 - s.length) * 0.1;
      return score(b) - score(a);
    });
    return { id: sorted[0], type: 'SKU' };
  }
  return { id: '', type: '' };
}


/** Added named exports to satisfy adapters */
export function extractFromHtml($, $scope) {
  try { return typeof _extractFromHtml === 'function' ? _extractFromHtml($, $scope) : {}; } catch { return {}; }
}
export function pickBestId(candidates = {}) {
  try {
    const arr = Object.entries(candidates).map(([k,v]) => ({ key:k, id:String(v||"").trim() })).filter(x=>x.id);
    arr.sort((a,b)=>b.id.length - a.id.length);
    return arr[0] || { key:"", id:"" };
  } catch { return { key:"", id:"" }; }
}
// ---- ESM exports (added) ----
export { extractFromHtml, extractFromText, pickBestId };
export default { extractFromHtml, extractFromText, pickBestId };
