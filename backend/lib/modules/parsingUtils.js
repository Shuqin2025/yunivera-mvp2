// backend/modules/parsingUtils.js
// Small, dependency-free helpers used by genericLinksParser & others.
// Functions: absolutize, splitSkuAndName, normalizePrice, cleanText.

export function cleanText(s = "") {
  try {
    return String(s)
      .replace(/\s+/g, " ")
      .replace(/[\u00A0\u200B\u200C\u200D]+/g, " ")
      .trim();
  } catch {
    return s || "";
  }
}

// Turn relative URLs into absolute, based on pageUrl (string URL)
export function absolutize(url = "", pageUrl = "") {
  if (!url) return "";
  try {
    if (/^https?:\/\//i.test(url)) return url;
    const base = new URL(pageUrl);
    const abs = new URL(url, base.origin);
    return abs.toString();
  } catch {
    return url;
  }
}

// Split leading SKU token from a long title/line if present.
// e.g. "78001-3 Druckerkabel 25pol ..." -> { sku: "78001-3", rest: "Druckerkabel 25pol ..." }
export function splitSkuAndName(raw = "") {
  const s = cleanText(raw);
  if (!s) return { sku: "", rest: "" };
  const m = s.match(/^([A-Za-z0-9._\-\/]+)\s+(.+)$/);
  if (m) {
    return { sku: m[1], rest: m[2] };
  }
  return { sku: s, rest: "" };
}

// Extract price number & currency from messy text.
// Returns { price: "9.99", currency: "EUR" } or empty strings when not found.
export function normalizePrice(str = "") {
  const s = cleanText(str);

  // Currency symbol or code
  const curMatch = s.match(/(€|\$|£|CHF|EUR|USD|GBP)/i);
  let currency = "";
  if (curMatch) {
    const c = curMatch[1].toUpperCase();
    if (c === "€") currency = "EUR";
    else if (c === "£") currency = "GBP";
    else if (c === "$") currency = "USD";
    else currency = c;
  }

  // Keep digits, dot, comma and minus for scanning
  const numRaw = s.replace(/[^0-9,\.\-]/g, " ");
  // Prefer the last numeric token (often the actual price)
  const tokens = numRaw.split(/\s+/).filter(Boolean);
  let numeric = "";
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i];
    if (/^-?\d{1,3}([\.,]\d{3})*([\.,]\d{2})?$/.test(t) || /^-?\d+(\.\d+)?$/.test(t)) {
      numeric = t;
      break;
    }
  }
  if (!numeric && tokens.length) numeric = tokens[tokens.length - 1] || "";

  // German/European decimals: convert comma to dot when appropriate
  if (numeric.includes(",") && !numeric.includes(".")) {
    numeric = numeric.replace(",", ".");
  } else if (numeric.count === 0 && (numeric.match(/\./g) || []).length > 1) {
    // Fallback: remove thousand separators if any
    numeric = numeric.replace(/\.(?=\d{3}(\D|$))/g, "");
  }

  // Final sanity
  const final = numeric.match(/-?\d+(\.\d+)?/);
  return {
    price: final ? final[0] : "",
    currency: currency || ""
  };
}
