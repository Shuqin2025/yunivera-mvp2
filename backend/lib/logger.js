// backend/lib/logger.js  (ESM)
// 轻量日志器：stdout + 按天落盘；支持 DEBUG/LOG_LEVEL 控制 debug 级别
import fs from 'node:fs';
import path from 'node:path';

const LOG_DIR = 'logs';
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function stamp() {
  const d = new Date();
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

function writeLine(level, msg) {
  const line = `[${stamp()}] [${level}] ${msg}\n`;
  // 控制台
  process.stdout.write(line);
  // 按天写文件
  try {
    const file = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.log`);
    fs.appendFileSync(file, line);
  } catch {}
}

// ——— 级别控制：LOG_LEVEL=debug 或 DEBUG=1/true 时打开 debug ———
const envLevel =
  process.env.LOG_LEVEL ||
  ((process.env.DEBUG === '1' || process.env.DEBUG === 'true') ? 'debug' : undefined);

const isDebugOn = String(envLevel || '').toLowerCase() === 'debug';

// ——— 对外导出：logger（命名导出 + default），以及 dbg() 小助手 ———
export const logger = {
  info:  (m) => writeLine('INFO',  m),
  warn:  (m) => writeLine('WARN',  m),
  error: (m) => writeLine('ERROR', m),
  debug: (m) => { if (isDebugOn) writeLine('DEBUG', m); },
};

// === DEBUG helper（append-only）===
// 在 DEBUG 打开时，直接把原始参数打到 stdout（方便快速插桩）
export const dbg = (...args) => {
  const on = isDebugOn || process.env.DEBUG === '1' || process.env.DEBUG === 'true';
  if (on) {
    try { console.log(...args); } catch {}
  }
};

// 兼容 default 导出（避免未来有人用 default 引用）
export default logger;
