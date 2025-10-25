// backend/scripts/testFlowRunner.js
// 夜间巡航脚本：
// 1. 跑自检 selfCheck.js （现有日报）
// 2. 依次请求我们三家真实站，命中 /v1/catalog?debug=1
// 3. 把结果写入 logs/flowRun/*.json 方便晨检
//
// 注意：这个脚本假设可以直接从后台容器里访问网关URL。
// 如果网关不是内网直通而是公网 https://yunivera-gateway.onrender.com
// 就用下面的 GATEWAY。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import https from 'node:https';

// === 你现在线上网关的地址 ===
const GATEWAY = 'https://yunivera-gateway.onrender.com';

// === 我们要 nightly 观测的真实目录页列表 ===
const TEST_URLS = [
  'https://www.s-impuls-shop.de/catalog/computer',
  'https://www.memoryking.de/tv-hifi/tvsat-zubehoer/',
  'https://www.beamer-discount.de/konferenzraum-c-836.html',
];

// 小工具：spawn 一个 node 脚本并等待完成
function runNode(moduleRelPath, args = []) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [moduleRelPath, ...args], {
      stdio: 'inherit',
      cwd: process.cwd(),
    });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${moduleRelPath} exit ${code}`))));
    p.on('error', reject);
  });
}

// 小工具：对单个 URL 调 /v1/catalog?debug=1
function callCatalogOnce(testUrl, limit = 20, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const enc = encodeURIComponent(testUrl);
    const reqUrl = `${GATEWAY}/v1/catalog?url=${enc}&limit=${limit}&debug=1`;

    const req = https.get(reqUrl, { timeout: timeoutMs }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { buf += chunk; });
      res.on('end', () => {
        resolve({
          ok: true,
          status: res.statusCode,
          bodyRaw: buf.slice(0, 4000), // 不用太长，前4KB足够诊断
          url: testUrl,
        });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        ok: false,
        status: 0,
        error: 'timeout',
        url: testUrl,
      });
    });

    req.on('error', (err) => {
      resolve({
        ok: false,
        status: 0,
        error: String(err && err.message || err),
        url: testUrl,
      });
    });
  });
}

// 写 JSON 文件方便早上看
function writeJsonSafe(dir, filename, data) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  const full = path.join(dir, filename);
  fs.writeFileSync(full, JSON.stringify(data, null, 2), 'utf8');
  return full;
}

async function main() {
  console.log('=== [flow] start ===');

  // 跑旧的自检，这个会生成 dailyReport-* 之类的诊断
  console.log('--- [flow] step1: selfCheck');
  await runNode(path.join('scripts', 'selfCheck.js'));

  // 对三家真实站做 catalog 拉取
  console.log('--- [flow] step2: nightly catalog checks');
  const results = [];
  for (const u of TEST_URLS) {
    /* eslint-disable no-await-in-loop */
    console.log(`[flow]  fetching catalog for ${u} ...`);
    const r = await callCatalogOnce(u, 20, 20000);
    results.push(r);
    /* eslint-enable no-await-in-loop */
  }

  // 汇总
  const summary = {
    ts: new Date().toISOString(),
    gateway: GATEWAY,
    checks: results.map(r => ({
      url: r.url,
      ok: r.ok,
      status: r.status,
      error: r.error || '',
      // 如果后端返回了 {ok:false,error:"crawlPages: fetchHtml is required"}
      // 我们把它也提炼出来方便你早上一扫即知
      hint: (() => {
        try {
          const parsed = JSON.parse(r.bodyRaw || '{}');
          return parsed.error || '';
        } catch {
          return '';
        }
      })()
    })),
  };

  // 落盘
  const outDir = path.join('logs', 'flowRun');
  const stamp = Date.now();
  const fileResults = writeJsonSafe(outDir, `nightlyRaw-${stamp}.json`, results);
  const fileSummary = writeJsonSafe(outDir, `nightlySummary-${stamp}.json`, summary);

  console.log('--- [flow] wrote:');
  console.log('    ', fileResults);
  console.log('    ', fileSummary);

  console.log('=== [flow] done ===');
}

main().catch((err) => {
  console.error('[flow] failed:', err);
  process.exitCode = 1;
});
