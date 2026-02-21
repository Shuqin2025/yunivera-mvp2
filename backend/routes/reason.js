// backend/routes/reason.js
import express from "express";

const router = express.Router();

/**
 * POST /reason
 *
 * Input (recommended):
 * {
 *   "compressed_bundle": { requestId, schemaVersion, source, items: [ { itemId, normalized, evidence? } ] },
 *   "compression_manifest": {... optional ...}
 * }
 *
 * Output:
 * {
 *   requestId,
 *   summary: { status, confidence, decision, reasons },
 *   items: [ { itemId, conclusion, ruleTrace, validation } ],
 *   guardian: { passed, violations },
 *   meta: { latencyMs }
 * }
 */
router.post("/reason", (req, res) => {
  const t0 = Date.now();

  try {
    const body = req.body || {};
    const bundle = body.compressed_bundle || body.matchedBundle || body.bundle || null;

    if (!bundle || !Array.isArray(bundle.items)) {
      return res.status(400).json({
        error: "invalid_input",
        message: "Expected { compressed_bundle: { items: [...] } }",
      });
    }

    const requestId = bundle.requestId || `reason-${Date.now()}`;
    const results = [];
    const violations = [];

    // ---------- L3 Guardian (minimal allowlist / safety) ----------
    // 只允许输出这些字段，避免“推理越界”
    const allowedSuggestionTypes = new Set(["fix_field", "add_field", "needs_review"]);

    // ---------- Rules (minimal) ----------
    // 你可以后续把这些移到 logicRuleBase.json
    function applyRules(item) {
      const norm = item.normalized || {};

      const ruleTrace = [];
      const suggestions = [];
      const issues = [];

      // 基础必填：title + url
      if (!norm.title || String(norm.title).trim() === "") {
        ruleTrace.push({ ruleId: "R-TITLE-REQUIRED", fired: true, severity: "high", score: 0.9 });
        issues.push("Missing title");
        suggestions.push({ type: "fix_field", field: "title", value: "(missing)" });
      }

      if (!norm.url || String(norm.url).trim() === "") {
        ruleTrace.push({ ruleId: "R-URL-REQUIRED", fired: true, severity: "high", score: 0.9 });
        issues.push("Missing url");
        suggestions.push({ type: "fix_field", field: "url", value: "(missing)" });
      }

      // 可选：电商字段（如果有 price 就检查合理性）
      const priceAmount = norm.price && norm.price.amount !== undefined ? Number(norm.price.amount) : null;
      if (norm.price && (priceAmount === null || !Number.isFinite(priceAmount))) {
        ruleTrace.push({ ruleId: "R-PRICE-NUMERIC", fired: true, severity: "medium", score: 0.7 });
        issues.push("Price amount is not numeric");
        suggestions.push({ type: "needs_review", field: "price.amount", value: norm.price.amount });
      }
      if (Number.isFinite(priceAmount) && priceAmount <= 0) {
        ruleTrace.push({ ruleId: "R-PRICE-POSITIVE", fired: true, severity: "high", score: 0.85 });
        issues.push("Price amount must be > 0");
        suggestions.push({ type: "needs_review", field: "price.amount", value: norm.price.amount });
      }

      // SKU（如果有就规范一下）
      if (norm.sku && String(norm.sku).trim().length < 2) {
        ruleTrace.push({ ruleId: "R-SKU-TOO-SHORT", fired: true, severity: "low", score: 0.4 });
        issues.push("SKU suspiciously short");
        suggestions.push({ type: "needs_review", field: "sku", value: norm.sku });
      }

      // 置信度（极简可解释算法）
      let confidence = 1.0;
      for (const r of ruleTrace) {
        if (r.severity === "high") confidence -= 0.15;
        else if (r.severity === "medium") confidence -= 0.08;
        else confidence -= 0.03;
      }
      confidence = clamp01(confidence);

      // label
      let label = "valid";
      if (issues.length > 0) label = confidence < 0.6 ? "ambiguous" : "invalid";

      // 过滤 suggestion types（guardian）
      for (const s of suggestions) {
        if (!allowedSuggestionTypes.has(s.type)) {
          violations.push(`Suggestion type not allowed: ${s.type}`);
        }
      }

      return {
        conclusion: { label, confidence, suggestions },
        ruleTrace,
        validation: { passed: issues.length === 0, issues },
      };
    }

    for (const item of bundle.items) {
      const itemId = item.itemId || item.id || "unknown";
      const out = applyRules(item);

      results.push({
        itemId,
        conclusion: out.conclusion,
        ruleTrace: out.ruleTrace,
        validation: out.validation,
      });
    }

    // ---------- Summary ----------
    const worst = results.reduce((m, it) => Math.min(m, it.conclusion.confidence), 1);
    let status = "ok";
    let decision = "exportable";
    const reasons = [];

    const anyInvalid = results.some((it) => it.conclusion.label !== "valid");
    if (anyInvalid) {
      status = worst < 0.6 ? "needs_review" : "ok";
      decision = worst < 0.6 ? "partial" : "exportable";
      reasons.push("Some items need review due to missing/invalid fields.");
    }

    if (violations.length) {
      status = "blocked";
      decision = "blocked";
      reasons.push("Guardian violations.");
    }

    return res.json({
      requestId,
      summary: {
        status,
        confidence: Number(worst.toFixed(4)),
        decision,
        reasons,
      },
      items: results,
      guardian: { passed: violations.length === 0, violations },
      meta: { latencyMs: Date.now() - t0 },
    });
  } catch (e) {
    console.error("[reason] error:", e);
    return res.status(500).json({ error: "reason_failed" });
  }
});

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export default router;