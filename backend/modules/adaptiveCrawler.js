// backend/modules/adaptiveCrawler.js
import axios from "axios";

/**
 * 决策：根据上下文返回 { useBrowser, timeout, delay, headers }
 */
export function decideFetchStrategy({ url = "", hintType = "", recentStats = {} } = {}) {
  const isLikelyShopify =
    /cdn\.shopify|\/collections\//i.test(url) || hintType === "shopify";
  const manyTimeouts = (recentStats.timeouts || 0) >= 3;

  return {
    useBrowser: !isLikelyShopify && manyTimeouts, // 默认直抓；连续超时则切浏览器
    timeout: isLikelyShopify ? 12000 : 18000,     // Shopify 普通直抓更快
    delay: recentStats.lastFail ? 350 : 0,        // 上次失败则轻微 backoff
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36",
      "Accept-Language": "de,en;q=0.9,zh;q=0.8",
    },
  };
}

/**
 * 直抓 HTML（axios）。
 * 增强点：
 *  - OversizedPage guard: 如果页面文本太夸张，判定为站点全览/mega menu，拒绝作为商品页进入后续解析
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

    let html = res.data || "";

    // --- OversizedPage guard (参谋长建议) ---
    // 我们不用 textContent，因为我们拿到的是原始 HTML。
    // 简单策略：如果 HTML 长度超过 200k 字符，直接标记为 oversized。
    // 这样 catalog.js / 上游可以看到 status:"oversized" 并跳过。
    // 不直接 throw，让调用者自己决定是否要丢弃/记录 snapshot。
    const OVERSIZE_LIMIT = 200000;
    if (typeof html === "string" && html.length > OVERSIZE_LIMIT) {
      return {
        html,
        status: res.status,
        used: "axios",
        oversized: true,
        note: "OversizedPageDetected"
      };
    }

    return { html, status: res.status, used: "axios", oversized: false };
  }

  // 预留浏览器渲染分支（目前先返回占位，避免引入大依赖）
  return { html: "", status: 501, used: "browser-disabled", oversized: false };
}
