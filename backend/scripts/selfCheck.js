// backend/scripts/selfCheck.js
import fs from 'node:fs/promises';
import path from 'node:path';
import axios from 'axios';

const ROOT = path.resolve(process.cwd()); // backend/
const urlsFile = path.join(ROOT, 'cli/seed-urls.txt');
const outDir   = path.join(ROOT, 'logs', 'selfcheck');

// ---- env 开关 ----
const STRICT = process.env.SELF_CHECK_STRICT === '1';         // 严格模式：失败率超阈值则 exit(1)
const MIN_OK = Number(process.env.SELF_CHECK_MIN_OK_RATIO ?? 0.6); // 最低通过率

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

async function readSeedUrls(file) {
  const txt = await fs.readFile(file, 'utf8');
  return txt
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(s => s && !s.startsWith('#'));
}

async function checkOne(url) {
  const startedAt = Date.now();
  try {
    const res = await axios.get(url, {
      timeout: 15000,
      maxRedirects: 5,
      headers: { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.8' },
      validateStatus: () => true, // 我们自己判定
    });

    const ok =
      res.status >= 200 &&
      res.status < 400 &&
      typeof res.data === 'string' &&
      /\<html[\s>]/i.test(res.data);

    return {
      url,
      ok,
      status: res.status,
      timeMs: Date.now() - startedAt,
      note: ok ? 'ok' : 'not html or bad status',
    };
  } catch (err) {
    return {
      url,
      ok: false,
      status: 0,
      timeMs: Date.now() - startedAt,
      note: String(err?.message ?? err),
    };
  }
}

function todayTag() {
  const now = new Date();
  const p2 = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
}

async function main() {
  const urls = await readSeedUrls(urlsFile);
  if (urls.length === 0) {
    console.log('[selfcheck] no urls in cli/seed-urls.txt');
    return 0;
  }

  // 并发适中即可
  const results = [];
  for (const u of urls) {
    /* 也可用 Promise.allSettled 提升并发，这里保持顺序输出 */
    const r = await checkOne(u);
    results.push(r);
    console.log(`- [${r.ok ? 'OK ' : 'BAD'}] ${u}  status=${r.status}  ${r.timeMs}ms  ${r.note}`);
  }

  const ok = results.filter(r => r.ok).length;
  const ratio = ok / results.length;
  const report = {
    date: todayTag(),
    total: results.length,
    ok,
    ratio,
    items: results,
  };

  // 写日报
  await fs.mkdir(outDir, { recursive: true });
  const outfile = path.join(outDir, `dailyReport-${todayTag()}.json`);
  await fs.writeFile(outfile, JSON.stringify(report, null, 2), 'utf8');

  // 控制台汇总（Render Logs 里可直观看）
  console.log(`[selfcheck] ${report.date} ok=${ok}/${results.length} ratio=${ratio.toFixed(2)}`);
  console.log(`[selfcheck] report saved: ${path.relative(ROOT, outfile)}`);

  // 默认不让 Cron 变红；严格模式且低于阈值才非零
  if (STRICT && ratio < MIN_OK) {
    console.log(`[selfcheck] STRICT mode: ratio ${ratio.toFixed(2)} < ${MIN_OK}`);
    return 1;
  }
  return 0;
}

const code = await main().catch(err => {
  console.log('[selfcheck] fatal:', err?.stack || String(err));
  return STRICT ? 1 : 0;
});

process.exit(code);
