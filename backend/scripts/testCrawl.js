// scripts/testCrawl.js
// 用法：node scripts/testCrawl.js --url="https://xx.com/category" [--mode=http|local] [--limit=50]
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

const args = Object.fromEntries(
  process.argv.slice(2).map(kv => {
    const [k, ...rest] = kv.replace(/^--/, "").split("=");
    return [k, rest.join("=") || true];
  })
);

const url   = args.url || args.u;
const mode  = (args.mode || "http").toLowerCase();
const limit = Number(args.limit || 50);
const gw    = process.env.GATEWAY_URL || "https://yunivera-gateway.onrender.com";

if (!url) {
  console.error("❌ 请加 --url=目录页URL");
  process.exit(1);
}

console.log(`\n=== testCrawl start ===\nurl=${url}\nmode=${mode}\nlimit=${limit}\n`);

if (mode === "http") {
  await runOverHttp(url, limit, gw);
} else {
  await runLocal(url, limit).catch(async (e) => {
    console.warn(`⚠️ local 模式失败（${e?.message}），回退到 HTTP 模式`);
    await sleep(300);
    await runOverHttp(url, limit, gw);
  });
}

async function runOverHttp(url, limit, gw) {
  const detectEP = `${gw}/v1/api/detect?url=${encodeURIComponent(url)}`;
  const parseEP  = `${gw}/v1/api/catalog/parse?url=${encodeURIComponent(url)}&limit=${limit}&debug=1`;

  const d = await fetchJSON(detectEP);
  console.log(`\n[detect] ->`, d);

  const p = await fetchJSON(parseEP);
  console.log(`\n[parse.summary] ok=${!!p?.ok} adapter=${p?.adapter} count=${p?.items?.length || p?.products?.length || 0}`);

  const items = p?.items || p?.products || [];
  for (const it of items.slice(0, 5)) {
    console.log(` - ${it?.title || it?.name} | ${it?.price || it?.priceText || ""} | ${it?.url || it?.href || ""}`);
  }
}

async function runLocal(url, limit) {
  // 直接 import 你们的模块（路径以你们实际仓库为准）
  const { default: logger }   = await import("../backend/lib/logger.js");
  const { default: snapshot } = await import("../backend/lib/debugSnapshot.js");
  const { default: detect }   = await import("../backend/lib/structureDetector.js");
  const { default: parse }    = await import("../backend/lib/templateParser.js");
  const cheerio               = (await import("cheerio")).default;

  const html = await (await fetch(url, { redirect: "follow" })).text();
  const $ = cheerio.load(html);

  const struct = await detect({ url, $ });
  console.log(`[local.detect]`, struct);
  await snapshot("local.detect.done", { url, struct });

  const out = await parse({ url, $, limit, debug: 1, hints: struct });
  console.log(`[local.parse.summary] adapter=${out?.adapter} count=${out?.products?.length || 0}`);
  await snapshot("local.parse.done", { url, adapter: out?.adapter, count: out?.products?.length || 0 });

  const items = out?.products || [];
  for (const it of items.slice(0, 5)) {
    console.log(` - ${it?.title || it?.name} | ${it?.price || it?.priceText || ""} | ${it?.url || it?.href || ""}`);
  }
}

async function fetchJSON(u) {
  const res = await fetch(u, { redirect: "follow" });
  const txt = await res.text();
  try { return JSON.parse(txt); }
  catch { console.log(txt); return null; }
}
