// backend/scripts/selfCheck.js
// ESM, Node >= 18
// 目标：轻量健康自检 + 日报 + 阈值降级告警（邮件）+ 自动触发 autoLogInspector

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { setTimeout as delay } from 'timers/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fetch from 'node-fetch';
import nodemailer from 'nodemailer';

const pexecFile = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ----------- 路径与常量 -----------
const ROOT = path.resolve(__dirname, '..');        // backend/
const SEED_PATH = path.join(ROOT, 'cli', 'seed-urls.txt');
const LOG_DIR = path.join(ROOT, 'logs', 'selfcheck');
const INSPECTOR = path.join(ROOT, 'modules', 'diagnostics', 'autoLogInspector.js');

// ----------- 阈值 & 选项（可用环境变量覆盖） -----------
const MIN_OK = parseInt(process.env.SELF_CHECK_MIN_OK || '1', 10);
const MIN_RATIO = parseFloat(process.env.SELF_CHECK_MIN_RATIO || '0.6');
const MAX_DROP = parseFloat(process.env.SELF_CHECK_MAX_DROP || '0.1'); // 10%
const EXIT_ON_FAIL = (process.env.EXIT_ON_FAIL || '0') === '1';

// SMTP & 邮件
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const REPORT_TO = process.env.REPORT_TO; // e.g. shuqinamberg@proton.me
const FROM_ADDR = SMTP_USER || `selfcheck@${SMTP_HOST || 'localhost'}`;

// ----------- 小工具 -----------
const fmtDate = (d = new Date()) => d.toISOString().slice(0, 10); // YYYY-MM-DD

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
}

async function readLines(file) {
  const raw = await fs.readFile(file, 'utf8');
  return raw
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(s => s && !s.startsWith('#'));
}

async function saveJSON(file, obj) {
  const content = JSON.stringify(obj, null, 2);
  await fs.writeFile(file, content, 'utf8');
}

async function readJSON(file) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// 轻量测试：只验证「站点可访问且返回 HTML」——不重跑解析/不撞生产
async function probeUrl(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  let ok = false;
  let errMsg = '';
  let status = 0;

  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    status = res.status;
    // Content-Type 里包含 text/html 视为 ok
    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    if (res.ok && ctype.includes('text/html')) {
      ok = true;
    } else {
      errMsg = `bad response: status=${status}, ctype=${ctype}`;
    }
    // 轻读一小块验证有 <html 字样（不强制）
    if (ok) {
      const text = await res.text();
      if (!/<!doctype|<html/i.test(text)) {
        // 仍然算 ok，但记录弱信号
        errMsg = 'html marker not found, but content-type ok';
      }
    }
  } catch (e) {
    errMsg = String(e?.message || e);
  } finally {
    clearTimeout(t);
  }

  return { ok, status, err: errMsg };
}

// 触发 autoLogInspector（独立子进程，防止阻塞）
async function runInspector() {
  try {
    const { stdout, stderr } = await pexecFile(
      process.execPath, // 'node'
      [INSPECTOR, '--since', '1d'],
      { cwd: ROOT, env: process.env }
    );
    return { ok: true, stdout, stderr };
  } catch (e) {
    return { ok: false, stderr: String(e?.stderr || e?.message || e) };
  }
}

// 构造并发送邮件
async function sendMail(subject, text, attachments = []) {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !REPORT_TO) {
    console.warn('[selfcheck] mail skipped: SMTP/REPORT_TO not fully configured');
    return { ok: false, skipped: true };
  }

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465, // 465=SSL
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  await transporter.sendMail({
    from: FROM_ADDR,
    to: REPORT_TO,
    subject,
    text,
    attachments,
  });

  return { ok: true };
}

// ----------- 主流程 -----------
async function main() {
  const today = fmtDate();
  const yesterday = fmtDate(new Date(Date.now() - 86400_000));

  await ensureDir(LOG_DIR);

  // 1) 读取稳定站点清单
  const urls = await readLines(SEED_PATH);
  if (!urls.length) {
    console.log(`[selfcheck] ${today} ok=0/0 ratio=0 (empty seed list)`);
    return;
  }

  // 2) 逐个探测
  const results = [];
  for (const u of urls) {
    const r = await probeUrl(u);
    results.push({ url: u, ...r });
    // 轻量节流，避免瞬时一口气打到站点
    await delay(200);
  }

  const ok = results.filter(r => r.ok).length;
  const total = results.length;
  const ratio = total > 0 ? +(ok / total).toFixed(3) : 0;

  // 3) 写入今日日报
  const report = {
    date: today,
    ok,
    total,
    ratio,
    minOk: MIN_OK,
    minRatio: MIN_RATIO,
    maxDrop: MAX_DROP,
    results,
    meta: { hostname: process.env.RENDER_SERVICE_NAME || 'cron', ts: new Date().toISOString() }
  };
  const reportFile = path.join(LOG_DIR, `dailyReport-${today}.json`);
  await saveJSON(reportFile, report);

  console.log(`[selfcheck] ${today} ok=${ok}/${total} ratio=${ratio} saved=${path.relative(ROOT, reportFile)}`);

  // 4) 读取昨天基线
  const yesterdayFile = path.join(LOG_DIR, `dailyReport-${yesterday}.json`);
  const baseline = await readJSON(yesterdayFile);
  const baselineRatio = baseline?.ratio ?? null;

  // 5) 评估是否降级
  const ratioDrop = baselineRatio != null ? +(baselineRatio - ratio).toFixed(3) : 0;
  const degraded =
    ok < MIN_OK ||
    ratio < MIN_RATIO ||
    (baselineRatio != null && ratioDrop > MAX_DROP);

  // 6) 降级时：跑 inspector + 邮件告警
  if (degraded) {
    console.warn(`[selfcheck] degraded: ok=${ok}, ratio=${ratio}, drop=${ratioDrop} (baseline=${baselineRatio ?? 'n/a'})`);
    const insp = await runInspector();

    let mailText =
`【自检告警】${today}
当前：ok=${ok}/${total}  成功率=${ratio}
昨日：成功率=${baselineRatio ?? 'n/a'}  下降=${ratioDrop}

阈值：
- SELF_CHECK_MIN_OK   = ${MIN_OK}
- SELF_CHECK_MIN_RATIO= ${MIN_RATIO}
- SELF_CHECK_MAX_DROP = ${MAX_DROP}

Inspector: ${insp.ok ? '✅ 已运行' : '❌ 运行失败'}
${insp.ok ? (insp.stdout?.slice(0, 2000) || '') : (insp.stderr?.slice(0, 2000) || '')}

报告文件：${path.relative(ROOT, reportFile)}
`;

    await sendMail(
      `【告警】自检降级 ok=${ok}/${total} ratio=${ratio}`,
      mailText,
      [
        {
          filename: path.basename(reportFile),
          path: reportFile,
          contentType: 'application/json',
        }
      ]
    ).catch(err => console.warn('[selfcheck] mail error:', err?.message || err));

    if (EXIT_ON_FAIL) {
      process.exitCode = 1;
    }
    return;
  }

  // 7) 正常健康：可选发送「每日健康小结」，默认不发，保持静默
  // 如需每日健康邮件，把下方注释去掉即可：
  /*
  await sendMail(
    `【健康】自检通过 ok=${ok}/${total} ratio=${ratio}`,
    `【自检健康】${today}\n当前：ok=${ok}/${total} 成功率=${ratio}\n报告：${path.relative(ROOT, reportFile)}\n`
  ).catch(() => {});
  */
}

main().catch(err => {
  console.error('[selfcheck] fatal:', err);
  // 出错时也尽量不让 Cron 红（除非你设置 EXIT_ON_FAIL=1）
  if (EXIT_ON_FAIL) process.exit(1);
});
