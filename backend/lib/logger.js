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

export const logger = {
  info:  (m) => writeLine('INFO',  m),
  warn:  (m) => writeLine('WARN',  m),
  error: (m) => writeLine('ERROR', m),
  debug: (m) => { if (process.env.DEBUG) writeLine('DEBUG', m); },
};

// === DEBUG helper (append-only) ===
export const dbg = (...args) => {
  const on = process.env.DEBUG === '1' || process.env.DEBUG === 'true';
  if (on) console.log(...args);
};
// === /DEBUG helper ===
