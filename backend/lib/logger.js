// backend/lib/logger.js
// 统一简单 Logger：永远写到 stdout；DEBUG 环境变量可开 debug；LOG_LEVEL 可覆盖默认级别
// 使用方式：
//   DEBUG=1          # 开启 debug
//   LOG_LEVEL=warn   # 仅 warn 以上
// 说明：Render 会自动收集 stdout/stderr，无需写文件

const debugOn = /^(1|true|on|yes)$/i.test(String(process.env.DEBUG || ''));
const envLevel = String(process.env.LOG_LEVEL || (debugOn ? 'debug' : 'info')).toLowerCase();

// 等级优先级（越小越详细）
const LEVEL_ORDER = { debug: 10, info: 20, warn: 30, error: 40 };
const currentLevel = LEVEL_ORDER[envLevel] ?? LEVEL_ORDER.info;

function stamp() {
  return new Date().toISOString();
}

function out(level, msg) {
  const line = `[${stamp()}] [${level.toUpperCase()}] ${msg}`;
  // 永远写到 stdout（Render 会收集）
  process.stdout.write(line + '\n');
}

function shouldLog(level) {
  const lv = LEVEL_ORDER[level] ?? LEVEL_ORDER.info;
  return lv >= currentLevel ? true : false;
}

const logger = {
  debug: (m, ...rest) => {
    if (shouldLog('debug')) out('debug', fmt(m, rest));
  },
  info: (m, ...rest) => {
    if (shouldLog('info')) out('info', fmt(m, rest));
  },
  warn: (m, ...rest) => {
    if (shouldLog('warn')) out('warn', fmt(m, rest));
  },
  error: (m, ...rest) => {
    // error 一律打
    out('error', fmt(m, rest));
  },
};

// 简易格式化（支持 printf 风格和对象）
function fmt(m, rest) {
  if (typeof m === 'string' && rest?.length) {
    // 仅处理最常用的 %s / %d
    let i = 0;
    return m.replace(/%[sd]/g, () => String(rest[i++])).concat(
      rest.slice(i).length ? ' ' + rest.slice(i).map(safeStringify).join(' ') : ''
    );
  }
  if (rest?.length) return [safeStringify(m), ...rest.map(safeStringify)].join(' ');
  return safeStringify(m);
}

function safeStringify(v) {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

// 开机打一行当前日志级别，便于在 Logs 中确认
logger.info(`[logger] level=${envLevel}, DEBUG=${process.env.DEBUG || ''}, LOG_LEVEL=${process.env.LOG_LEVEL || ''}`);

export default logger;

// 方便结构化调试时的别名（与你们代码里可能用到的 dbg 保持一致）
export const dbg = (...args) => {
  if (shouldLog('debug')) {
    process.stdout.write(`[${stamp()}] [DEBUG] ` + args.map(safeStringify).join(' ') + '\n');
  }
};
