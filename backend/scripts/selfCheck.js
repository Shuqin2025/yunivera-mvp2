// backend/scripts/selfCheck.js
// type: module
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// 路径助手
const r = (...p) => path.resolve(__dirname, '..', ...p);

// 读取 seed-urls，过滤注释与空行，取前 3 个
async function pickSampleUrls(limit = 3) {
  const seedPath = r('cli', 'seed-urls.txt');
  try {
    const raw = await fs.readFile(seedPath, 'utf-8');
    const urls = raw
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(s => s && !s.startsWith('#'));
    return urls.slice(0, limit);
  } catch (e) {
    // 兜底：万一没读到文件，就给三个占位站点（你可替换成最稳的）
    return [
      'https://snocks.com/collections/socken',
      'https://www.muji.com/de/products/cmdty/section/Tops',
      'https://www.uniqlo.com/de/de/men/tops'
    ].slice(0, limit);
  }
}

// 以子进程方式调用现有 CLI（不侵入你现在的 index.js 逻辑）
function runCliForUrl(url, { snapshot = true } = {}) {
  return new Promise((resolve) => {
    const args = ['cli/index.js', '--url', url];
    if (snapshot) args.push('--snapshot');

    const ps = spawn('node', args, {
      cwd: r(), // backend 根目录
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let out = '';
    let err = '';
    ps.stdout.on('data', d => (out += d.toString()));
    ps.stderr.on('data', d => (err += d.toString()));

    ps.on('close', code => {
      resolve({
        url,
        ok: code === 0,
        code,
        out,
        err
      });
    });
  });
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true }).catch(() => {});
}

// 读取最近一天的报告，作为基线
async function readYesterdayBaseline(dir) {
  try {
    const files = await fs.readdir(dir);
    const jsons = files
      .filter(f => /^dailyReport-\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort(); // 按文件名排序，最后一个是最近的
    if (!jsons.length) return null;
    const last = jsons[jsons.length - 2]; // 昨天（倒数第二个）；若只有一个则返回 null
    if (!last) return null;
    const raw = await fs.readFile(path.join(dir, last), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function maybeRunInspector(since = '1d') {
  return new Promise((resolve) => {
    const ps = spawn('node', ['modules/diagnostics/autoLogInspector.js', '--since', since], {
      cwd: r(),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    ps.stdout.on('data', d => (out += d.toString()));
    ps.stderr.on('data', d => (err += d.toString()));
    ps.on('close', code => resolve({ code, out, err }));
  });
}

async function main() {
  const now = new Date();
  const ymd = now.toISOString().slice(0, 10);
  const logDir = r('logs', 'selfcheck');
  await ensureDir(logDir);

  const urls = await pickSampleUrls(3);

  // 逐个 URL 执行 CLI
  const results = [];
  for (const url of urls) {
    const r = await runCliForUrl(url, { snapshot: true });
    results.push({
      url: r.url,
      ok: r.ok,
      exitCode: r.code,
      // 只保留少量文本，避免日志爆炸
      outTail: r.out.split('\n').slice(-20).join('\n'),
      errTail: r.err.split('\n').slice(-20).join('\n')
    });
  }

  const okCount = results.filter(r => r.ok).length;
  const ratio   = urls.length ? okCount / urls.length : 0;

  // 与昨日基线对比
  const yesterday = await readYesterdayBaseline(logDir);
  let drop = null;
  if (yesterday && typeof yesterday.successRatio === 'number') {
    drop = yesterday.successRatio - ratio; // 正数表示下降
  }

  // 若下降 > 10%，跑一次巡检
  let inspector = null;
  if (drop !== null && drop > 0.1) {
    inspector = await maybeRunInspector('1d');
  }

  // 写入当日报告
  const report = {
    ts: now.toISOString(),
    date: ymd,
    sampleSize: urls.length,
    ok: okCount,
    fail: urls.length - okCount,
    successRatio: Number(ratio.toFixed(3)),
    baseline: yesterday ? Number(yesterday.successRatio.toFixed(3)) : null,
    drop: drop !== null ? Number(drop.toFixed(3)) : null,
    items: results,
    inspector: inspector ? {
      exitCode: inspector.code,
      outTail: inspector.out.split('\n').slice(-50).join('\n'),
      errTail: inspector.err.split('\n').slice(-50).join('\n')
    } : null
  };

  const file = path.join(logDir, `dailyReport-${ymd}.json`);
  await fs.writeFile(file, JSON.stringify(report, null, 2), 'utf-8');

  // 也打印一行到 stdout 方便在 Render Logs 里看见
  console.log(`[selfcheck] ${ymd} ok=${okCount}/${urls.length} ratio=${report.successRatio}` +
              (report.drop !== null ? ` drop=${report.drop}` : ''));
}

main().catch(err => {
  console.error('[selfcheck] fatal:', err);
  process.exit(1);
});
