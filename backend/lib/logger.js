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
  process.stdout.write(line);
  try {
    const file = path.join(LOG_DIR, `${new Date().toISOString().slice(0,10)}.log`);
    fs.appendFileSync(file, line);
  } catch {}
}

/**
 * 计算日志级别（只影响 debug，info 及以上照常输出）
 * - 显式 LOG_LEVEL=debug -> 开 debug
 * - 或 DEBUG=1/true -> 开 debug
 */
const envLevel =
  process.env.LOG_LEVEL ||
  (process.env.DEBUG && (process.env.DEBUG === '1' || process.env.DEBUG === 'true') ? 'debug' : undefined);

export const logger = {
  info:  (m) => writeLine('INFO',  m),
  warn:  (m) => writeLine('WARN',  m),
  error: (m) => writeLine('ERROR', m),
  debug: (m) => {
    // 只有在 debug 级别时才真正输出
    if (envLevel === 'debug' || process.env.DEBUG === '1' || process.env.DEBUG === 'true') {
      writeLine('DEBUG', m);
    }
  },
};

// === DEBUG helper (append-only) ===
export const dbg = (...args) => {
  const on = envLevel === 'debug' || process.env.DEBUG === '1' || process.env.DEBUG === 'true';
  if (on) console.log(...args);
};
// === /DEBUG helper ===
