// backend/lib/modules/artikelExtractor.js
// 统一为 ESM 命名导出；保留 default 做兼容。
// 用法：import { extract } from './artikelExtractor.js'

/**
 * 从文本中提取商品的 Artikel-Nr / SKU / P/N 等编号。
 * 返回命中字符串；没有则返回 null。
 */
export function extract(input) {
  if (input == null) return null;
  const text = String(input).replace(/\s+/g, ' ').trim();
  if (!text) return null;

  // 1) 先匹配常见“标签: 值”的形式
  const labelRules = [
    /(Artikel(?:-?\s*Nr\.?|nummer))\s*[:#\-–—]?\s*([A-Za-z0-9][A-Za-z0-9._\-\/]{3,31})/i,
    /(Bestellnummer)\s*[:#\-–—]?\s*([A-Za-z0-9][A-Za-z0-9._\-\/]{3,31})/i,
    /(SKU)\s*[:#\-–—]?\s*([A-Za-z0-9][A-Za-z0-9._\-\/]{3,31})/i,
    /(?:^|\s)(?:P\/?N|Part\s*Number)\s*[:#\-–—]?\s*([A-Za-z0-9][A-Za-z0-9._\-\/]{3,31})/i,
  ];
  for (const re of labelRules) {
    const m = text.match(re);
    if (m) {
      const value = (m[2] ?? m[1]).replace(/^[#:\-–—\s]+/, '').trim();
      if (isLikelySku(value)) return value;
    }
  }

  // 2) 从全文里挑选“像料号”的 token：含字母数字和 -._/，长度合适，避免纯数字
  const candidates = text
    .split(/[^A-Za-z0-9._\-\/]+/)
    .filter(Boolean)
    .filter(isLikelySku);

  if (candidates.length) {
    // 选更像的：优先含字母的、长度适中、去掉明显价格/小数
    const scored = candidates
      .map(v => ({ v, score: scoreToken(v) }))
      .sort((a, b) => b.score - a.score);
    return scored[0].v;
  }

  return null;
}

// ---------- 工具 ----------

// 判断一个 token 是否“像”SKU/Artikel-Nr
function isLikelySku(token) {
  if (!token) return false;
  const t = String(token).trim();
  if (t.length < 4 || t.length > 32) return false;

  // 过滤纯数字或明显价格（如 12.99）
  if (/^[0-9]+$/.test(t)) return false;
  if (/^[0-9]+\.[0-9]{2}$/.test(t)) return false;

  // 只允许字母数字和常见分隔符
  if (!/^[A-Za-z0-9._\-\/]+$/.test(t)) return false;

  // 不能全是分隔符/点
  if (!/[A-Za-z0-9]/.test(t)) return false;

  return true;
}

// 给 token 打一个“像料号”的分
function scoreToken(t) {
  let s = 0;
  if (/[A-Za-z]/.test(t)) s += 3;        // 含字母更像料号
  if (/-|_|\/|\./.test(t)) s += 1;       // 有结构分隔略加分
  s += Math.max(0, 16 - Math.abs(16 - t.length)); // 长度接近 16 稍加分
  return s;
}

// 兼容：保留 default 导出（老代码可能 import 默认）
export default extract;
