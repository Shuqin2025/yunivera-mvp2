// backend/routes/reason.js
import express from "express";

const router = express.Router();

/**
 * POST /reason
 *
 * Input (recommended):
 * {
 *   "compressed_bundle": { requestId, schemaVersion, source, items: [ { itemId, normalized, evidence? } ] },
 *   "compression_manifest": { summary: { avgLossScore: 0..1 }, items?: [...] } // optional but recommended
 * }
 *
 * Output:
 * {
 *   requestId,
 *   summary: { status, confidence, decision, reasons, lossPenalty },
 *   items: [ { itemId, conclusion, ruleTrace, validation, loss } ],
 *   guardian: { passed, violations },
 *   meta: { latencyMs }
 * }
 */
router.post("/reason", (req, res) => {
  const t0 = Date.now();

  try {
    const body = req.body || {};
    const bundle = body.compressed_bundle || body.matchedBundle || body.bundle || null;
    const manifest = body.compression_manifest || null;

    if (!bundle || !Array.isArray(bundle.items)) {
      return res.status(400).json({
        error: "invalid_input",
        message: "Expected { compressed_bundle: { items: [...] } }",
      });
    }

    const requestId = bundle.requestId || `reason-${Date.now()}`;

    // ---------------- Loss Penalty (Governance closure) ----------------
    // We use manifest.summary.avgLossScore (0..1) to reduce confidence.
    // Tuning knobs:
    // - alpha: how strongly loss reduces confidence
    // - floor: minimum confidence after penalty (avoid 0 unless truly broken)
    const lossAlpha = 0.60; // 0.60 = fairly strong but not destructive
    const lossFloor = 0.05;

    const avgLossScore = clamp01(
      manifest && manifest.summary && typeof manifest.summary.avgLossScore === "number"
        ? manifest.summary.avgLossScore
        : 0
    );

    const lossPenalty = clamp01(avgLossScore * lossAlpha);

    // Helper: try to find per-item loss if manifest.items exists
    function findItemLoss(itemId) {
      if (!manifest || !Array.isArray(manifest.items)) return null;
      const hit = manifest.items.find((x) => String(x.itemId) === String(itemId));
      if (!hit || !hit.lossTotals) return null;
      const avgFieldLoss =
        typeof hit.lossTotals.avgFieldLoss === "number" ? clamp01(hit.lossTotals.avgFieldLoss) : null;
      return avgFieldLoss;
    }

    // ---------------- L3 Guardian (minimal allowlist / safety) ----------------
    const allowedSuggestionTypes = new Set(["fix_field", "add_field", "needs_review"]);

    // ---------------- Rules (minimal) ----------------
    function applyRules(item) {
      const norm = item.normalized || {};

      const ruleTrace = [];
      const suggestions = [];
      const issues = [];

      // Required: title + url
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

      // Optional: e-commerce price checks
      const priceAmount =
        norm.price && norm.price.amount !== undefined ? Number(norm.price.amount) : null;

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

      // Optional: sku sanity
      if (norm.sku && String(norm.sku).trim().length < 2) {
        ruleTrace.push({ ruleId: "R-SKU-TOO-SHORT", fired: true, severity: "low", score: 0.4 });
        issues.push("SKU suspiciously short");
        suggestions.push({ type: "needs_review", field: "sku", value: norm.sku });
      }

      // Base confidence (simple explainable)
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

      return { label, confidence, suggestions, ruleTrace, issues };
    }

    const results = [];
    const violations = [];

    for (const item of bundle.items) {
      const itemId = item.itemId || item.id || "unknown";

      const base = applyRules(item);

      // Guardian on suggestion types
      for (const s of base.suggestions) {
        if (!allowedSuggestionTypes.has(s.type)) {
          violations.push(`Suggestion type not allowed: ${s.type}`);
        }
      }

      // Apply governance loss penalty
      const perItemLoss = findItemLoss(itemId); // null if not available
      const effectiveLossPenalty = clamp01(
        (typeof perItemLoss === "number" ? perItemLoss * lossAlpha : 0) + lossPenalty
      );

      const adjustedConfidence = clamp01WithFloor(base.confidence - effectiveLossPenalty, lossFloor);

      // If loss is high, we add a trace record so it's auditable
      const ruleTrace = [...base.ruleTrace];
      if (effectiveLossPenalty > 0) {
        ruleTrace.push({
          ruleId: "G-LOSS-PENALTY",
          fired: true,
          severity: effectiveLossPenalty >= 0.25 ? "high" : "medium",
          score: Number(effectiveLossPenalty.toFixed(4)),
          notes: {
            avgLossScore,
            perItemLoss: perItemLoss ?? null,
            lossAlpha,
          },
        });
      }

      // Recompute label if confidence fell due to loss
      let label = base.label;
      if (label === "valid" && adjustedConfidence < 0.6) label = "ambiguous";

      results.push({
        itemId,
        conclusion: {
          label,
          confidence: Number(adjustedConfidence.toFixed(4)),
          suggestions: base.suggestions,
        },
        ruleTrace,
        validation: { passed: base.issues.length === 0, issues: base.issues },
        loss: {
          avgLossScore,
          perItemLoss: perItemLoss ?? null,
          lossPenalty: Number(effectiveLossPenalty.toFixed(4)),
        },
      });
    }

    // ---------------- Summary ----------------
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

    // If loss is meaningful, require review earlier
    if (avgLossScore >= 0.15 && status === "ok") {
      status = "needs_review";
      decision = "partial";
      reasons.push("Compression loss is non-trivial; review recommended.");
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
        lossPenalty: Number(lossPenalty.toFixed(4)),
        avgLossScore: Number(avgLossScore.toFixed(4)),
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

function clamp01WithFloor(x, floor) {
  const n = clamp01(x);
  return Math.max(clamp01(floor), n);
}

export default router;