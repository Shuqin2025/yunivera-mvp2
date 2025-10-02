// backend/lib/http.js
// 智能抓取：UA 轮换 + 超时 + 重试 + 自动编码识别 +（可选）iconv-lite 解码
// ESM 写法

const UA_POOL = [
  // 常见桌面 UA（尽量新）
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  // 移动 UA 兜底
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
];

function pickUA(userAgent) {
  if (userAgent && String(userAgent).trim()) return userAgent;
  return UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function readHeader(headers, name) {
  if (!headers) return '';
  try {
    // undici/fetch headers 是不区分大小写的
    return headers.get ? (headers.get(name) || '') : (headers[name.toLowerCase()] || headers[name] || '');
  } catch {
    return '';
  }
}

// 在前几 KB 里找 <meta charset="..."> 或 <meta http-equiv="Content-Type" content="text/html; charset=...">
function sniffMetaCharset(buf) {
  const slice = Buffer.from(buf.slice(0, 4096)).toString('ascii').toLowerCase();
  let m = slice.match(/<meta\s+charset=["']?\s*([\w-]+)\s*["']?/i);
  if (m && m[1]) return m[1];
  m = slice.match(/<meta[^>]+content=["'][^"']*charset=([\w-]+)[^"']*["']/i);
  if (m && m[1]) return m[1];
  return '';
}

// 规范编码名
function normalizeEncoding(enc = '') {
  enc = String(enc || '').trim().toLowerCase();
  if (!enc) return '';
  if (enc === 'utf8') return 'utf-8';
  if (enc.includes('gb2312') || enc.includes('gbk')) return 'gbk'; // iconv 统一用 gbk
  if (enc.includes('big5')) return 'big5';
  if (enc.includes('shift_jis')) return 'shift_jis';
  if (enc.includes('windows-1252')) return 'windows-1252';
  if (enc.includes('iso-8859-1')) return 'latin1';
  return enc;
}

async function decodeBuffer(buf, enc) {
  enc = normalizeEncoding(enc) || 'utf-8';
  if (enc === 'utf-8' || enc === 'utf8') {
    // TextDecoder 在 Node 18+ 原生可用
    try {
      return new TextDecoder('utf-8').decode(buf);
    } catch {
      return Buffer.from(buf).toString('utf8');
    }
  }
  // 其他编码，尽量用 iconv-lite（动态导入；没有也兜底为 latin1）
  try {
    const iconv = (await import('iconv-lite')).default || (await import('iconv-lite'));
    if (iconv && iconv.decode) return iconv.decode(Buffer.from(buf), enc);
  } catch (_) {
    /* 忽略，走兜底 */
  }
  // 兜底（可能会乱码，但不报错）
  try {
    return Buffer.from(buf).toString('latin1');
  } catch {
    return Buffer.from(buf).toString();
  }
}

function detectEncodingFromHeaders(headers) {
  const ct = readHeader(headers, 'content-type');
  if (!ct) return '';
  const m = ct.match(/charset\s*=\s*([^\s;]+)/i);
  return m ? normalizeEncoding(m[1]) : '';
}

/**
 * 抓取 HTML（带自动编码识别、超时、重试、UA 轮换）
 * @param {string} url
 * @param {object} opts
 *  - retries: number 重试次数，默认 2（共 3 次）
 *  - timeout: number 每次请求超时 ms，默认 15000
 *  - userAgent: string 自定义 UA
 *  - language: string Accept-Language，默认 zh-CN,zh;q=0.9,en;q=0.8,de;q=0.7
 *  - headers: object 额外请求头
 *  - method/body: fetch 透传
 *  - forceEncoding: string 强制编码（跳过识别）
 * @returns {Promise<{ html:string, finalUrl:string, status:number, headers:any, encoding:string, buffer:Uint8Array }>}
 */
export async function fetchHtml(url, opts = {}) {
  const {
    retries = 2,
    timeout = 15000,
    userAgent,
    language = 'zh-CN,zh;q=0.9,en;q=0.8,de;q=0.7',
    headers = {},
    method,
    body,
    forceEncoding,
  } = opts;

  let lastErr;
  let attempt = 0;

  while (attempt <= retries) {
    attempt += 1;
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), timeout);

    try {
      const res = await fetch(url, {
        method: method || (body ? 'POST' : 'GET'),
        body,
        redirect: 'follow',
        headers: {
          'user-agent': pickUA(userAgent),
          'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': language,
          'cache-control': 'no-cache',
          ...headers,
        },
        signal: controller.signal,
      });

      clearTimeout(to);
      const finalUrl = res.url || url;
      const status = res.status;
      const resHeaders = res.headers;

      const buf = new Uint8Array(await res.arrayBuffer());

      // 编码判定：优先 HTTP 头；其次 HTML <meta>；最后 utf-8
      let encoding = forceEncoding || detectEncodingFromHeaders(resHeaders) || sniffMetaCharset(buf) || 'utf-8';
      const html = await decodeBuffer(buf, encoding);

      if (status >= 500 && attempt <= retries) {
        await sleep(300 + Math.random() * 400);
        continue; // 重试
      }

      return { html, finalUrl, status, headers: resHeaders, encoding, buffer: buf };
    } catch (err) {
      clearTimeout(to);
      lastErr = err;
      if (attempt > retries) break;
      await sleep(300 + Math.random() * 400);
    }
  }

  // 全部失败抛错（尽量保留信息）
  const e = new Error(`fetchHtml failed for ${url}: ${lastErr?.message || lastErr}`);
  e.cause = lastErr;
  throw e;
}

export default { fetchHtml };
