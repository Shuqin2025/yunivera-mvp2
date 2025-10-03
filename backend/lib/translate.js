// backend/lib/translate.js
const API = "https://api-free.deepl.com/v2/translate"; // 你也可换正式版域名
const KEY = process.env.DEEPL_API_KEY || "";

export async function translateBatch(texts = [], target = "EN") {
  if (!KEY || !Array.isArray(texts) || !texts.length) return texts.map(t => String(t || ""));
  const body = new URLSearchParams();
  texts.forEach(t => body.append("text", String(t || "")));
  body.append("target_lang", target);

  const resp = await fetch(API, {
    method: "POST",
    headers: { "Authorization": "DeepL-Auth-Key " + KEY, "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  if (!resp.ok) return texts.map(t => String(t || ""));
  const data = await resp.json().catch(() => null);
  const arr = data?.translations || [];
  return texts.map((_, i) => arr[i]?.text || texts[i] || "");
}
