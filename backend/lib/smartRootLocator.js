// backend/lib/smartRootLocator.js
export default async function detectRoot({ $, debug = false } = {}) {
  try {
    if (!$ || typeof $.root !== "function") {
      return { selector: "body", confidence: 0.1, reason: "no-cheerio" };
    }

    const CANDIDATES = [
      ".product-grid", ".productlist", ".product-list", ".products", ".listing",
      ".listBox", ".category", ".catalog", ".items", ".grid", ".row",
      "#content", "#main", "main", "body"
    ];

    let best = { selector: "body", confidence: 0.1, reason: "fallback-body", probes: [] };

    const scoreNode = (sel) => {
      const $node = $(sel).first();
      if (!$node.length) return { sel, score: 0, found: 0, imgLinks: 0, cardGuess: 0 };

      const imgLinks = $node.find("a[href] img").length;

      const cards = $node.find("li, article, div").filter((_, el) => {
        const $el = $(el);
        if (!$el.find("a[href]").length) return false;
        const txt = $el.text().replace(/\s+/g, " ").toLowerCase();
        return /(€|\$|£|\bpreis\b|\bprice\b|\bsku\b|\bartikel\b)/.test(txt) || $el.find("img").length > 0;
      }).length;

      const aCount = Math.min($node.find("a[href]").length, 800);
      const score = imgLinks * 3 + cards * 2 + Math.floor(aCount / 20);

      return { sel, score, found: $node.length, imgLinks, cardGuess: cards };
    };

    for (const sel of CANDIDATES) {
      const stat = scoreNode(sel);
      best.probes.push(stat);
      if (stat.score > (best.score || 0)) {
        best = { ...best, ...stat, selector: sel, confidence: Math.min(0.95, 0.2 + stat.score / 50), reason: "scored" };
      }
    }

    if (best.selector === "body") {
      let bestChild = best;
      $("body > *").each((_, el) => {
        const tag = el.tagName ? el.tagName.toLowerCase() : null;
        if (!tag) return;
        const s = scoreNode(`body > ${tag}`);
        best.probes.push(s);
        if (s.score > (bestChild.score || 0)) {
          bestChild = { ...bestChild, ...s, selector: `body > ${tag}`, confidence: Math.min(0.9, 0.15 + s.score / 60), reason: "body-child" };
        }
      });
      if (bestChild.selector !== "body") best = bestChild;
    }

    return {
      selector: best.selector || "body",
      confidence: best.confidence || 0.2,
      reason: best.reason || "scored",
      probes: best.probes || []
    };
  } catch (e) {
    return { selector: "body", confidence: 0.1, reason: `error:${e?.message || e}` };
  }
}
