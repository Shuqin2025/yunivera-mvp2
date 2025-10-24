// backend/utils/domAnalyzer.js
/**
 * 轻量 DOM 分析工具（可被模板解析/适配器复用）
 * 这里不引第三方依赖，保持纯函数，便于单元测试。
 */

export function normText(txt = '') {
  return String(txt).replace(/\s+/g, ' ').trim();
}

export function pickText(node) {
  if (!node) return '';
  // 兼容 cheerio / JSDOM / plaintext
  if (typeof node === 'string') return normText(node);
  if (node.text) return normText(node.text());
  if (node.textContent) return normText(node.textContent);
  return '';
}

export function getAttr(node, name) {
  if (!node || !name) return undefined;
  if (node.attr) return node.attr(name);
  if (node.getAttribute) return node.getAttribute(name);
  return undefined;
}

export function isProbablyVisible(node) {
  // 兜底：有文本、不是明显隐藏属性
  const t = pickText(node);
  const style = (getAttr(node, 'style') || '').toLowerCase();
  const hidden = getAttr(node, 'hidden');
  const ariaHidden = getAttr(node, 'aria-hidden');

  if (!t) return false;
  if (hidden != null || ariaHidden === 'true') return false;
  if (style.includes('display:none') || style.includes('visibility:hidden')) return false;
  return true;
}

export function priceCandidates(text = '') {
  const s = normText(text);
  // € 1.234,56 或 1,234.56 或 9.99 之类
  const rex = /(?:€|\$|£)?\s?([0-9]{1,3}(?:[.,\s][0-9]{3})*|[0-9]+)([.,][0-9]{2})?\b/gi;
  const out = [];
  let m;
  while ((m = rex.exec(s))) {
    out.push(m[0]);
  }
  return [...new Set(out)];
}

export function guessUrlFromNode(node) {
  // a[href] 或 img[src]
  const href = getAttr(node, 'href');
  const src = getAttr(node, 'src');
  return href || src || undefined;
}
