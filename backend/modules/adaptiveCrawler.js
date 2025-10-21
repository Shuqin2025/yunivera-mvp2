// backend/modules/adaptiveCrawler.js
import axios from "axios";

/**
 * 决策：根据上下文返回 { useBrowser, timeout, delay, headers }
 * 这里给出非常轻量的启发式：可按需继续扩展
 */
export function decideFetchStrategy({ url = "", hintType = "", recentStats = {} } = {}) {
  const isLikelyShopify = /cdn\.shopify|\/collections\//i.test(url) || hintType === "shopify";
  const manyTimeouts = (recentStats.timeouts || 0) >= 3;

  return {
    useBrowser: !isLikelyShopify && manyTimeouts,          // 默认直抓；连续超时则切浏览器
    timeout: isLikelyShopify ? 12000 : 18000,              // Shopify 普通直抓更快
    delay: recentStats.lastFail ? 350 : 0,                 // 上次失败则轻微 backoff
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36",
      "Accept-Language": "de,en;q=0.9,zh;q=0.8",
    },
  };
}

/**
 * 直抓 HTML（axios）。若未来需要 Playwright，只需在 useBrowser=true 时改走浏览器分支即可。
 */
export async function fetchHtml({ url, strategy }) {
  const s = strategy || decideFetchStrategy({ url });
  if (s.delay) await new Promise(r => setTimeout(r, s.delay));

  if (!s.useBrowser) {
    const res = await axios.get(url, {
      timeout: s.timeout,
      headers: s.headers,
      maxRedirects: 5,
      validateStatus: c => c >= 200 && c < 400,
    });
    return { html: res.data, status: res.status, used: "axios" };
  }

  // 预留浏览器渲染分支（目前先返回占位，避免引入大依赖）
  return { html: "", status: 501, used: "browser-disabled" };
}
