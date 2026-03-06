// backend/routes/reason.js
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { runPolicyEngine } from "../lib/governance/policyEngine.js";

const router = express.Router();

// ---------------- ESM __dirname / __filename ----------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------- Safe RuleSet Loader ----------------
function loadActiveRuleSet() {
  try {
    const ruleSetPath = path.join(
      __dirname,
      "..",
      "governance",
      "rulesets",
      "ruleset_v0.1.0.json"
    );

    if (!fs.existsSync(ruleSetPath)) {
      console.warn("[reason] ruleset file not found, fallback to empty ruleset");
      return {
        defaults: { baseConfidence: 1.0 },
        rules: []
      };
    }

    return JSON.parse(fs.readFileSync(ruleSetPath, "utf-8"));
  } catch (e) {
    console.warn("[reason] failed to load ruleset, fallback to empty ruleset:", e.message);
    return {
      defaults: { baseConfidence: 1.0 },
      rules: []
    };
  }
}

/**
 * POST /reason
 *
 * Input:
 * {
 *   "compressed_bundle": {
 *     requestId,
 *     schemaVersion,
 *     source,
 *     items: [ { itemId, normalized, evidence? } ]
 *   },
 *   "compression_manifest": {
 *     summary: { avgLossScore: 0..1 },
 *     items?: [...]
 *   }
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
        message: "Expected { compressed_bundle: { items: [...] } }"
      });
    }

    const requestId = bundle.requestId || `reason-${Date.now()}`;

    // ---------------- Safe Policy Engine Integration ----------------
    let policy = {
      confidence: 1.0,
      status: "ok",
      appliedRules: [],
      trace: []
    };

    try {
      const activeRuleSet = loadActiveRuleSet();
      policy = runPolicyEngine(bundle, manifest, activeRuleSet);
    } catch (e) {
      console.warn("[reason] policy engine fallback:", e.message);
    }

    // ---------------- Loss Penalty (existing governance closure) ----------------
    const lossAlpha = 0.60;
    const lossFloor = 0.05;

    const avgLossScore = clamp01(
      manifest && manifest.summary && typeof manifest.summary.avgLossScore === "number"
        ? manifest.summary.avgLossScore
        : 0
    );

    const lossPenalty = clamp01(avgLossScore * lossAlpha);

    function findItemLoss(itemId) {
      if (!manifest || !Array.isArray(manifest.items)) return null;
      const hit = manifest.items.find((x) => String(x.itemId) === String(itemId));
      if (!hit || !hit.lossTotals) return null;

      return typeof hit.lossTotals.avgFieldLoss === "number"
        ? clamp01(hit.lossTotals.avgFieldLoss)
        : null;
    }

    // ---------------- L3 Guardian ----------------
    const allowedSuggestionTypes = new Set([
      "fix_field",
      "add_field",
      "needs_review"
    ]);

    // ---------------- Existing reasoning rules ----------------
    function applyRules(item) {
      const norm = item.normalized || {};

      const ruleTrace = [];
      const suggestions = [];
      const issues = [];

      // Required: title + url
      if (!norm.title || String(norm.title).trim() === "") {
        ruleTrace.push({
          ruleId: "R-TITLE-REQUIRED",
          fired: true,
          severity: "high",
          score: 0.9
        });
        issues.push("Missing title");
        suggestions.push({
          type: "fix_field",
          field: "title",
          value: "(missing)"
        });
      }

      if (!norm.url || String(norm.url).trim() === "") {
        ruleTrace.push({
          ruleId: "R-URL-REQUIRED",
          fired: true,
          severity: "high",
          score: 0.9
        });
        issues.push("Missing url");
        suggestions.push({
          type: "fix_field",
          field: "url",
          value: "(missing)"
        });
      }

      // Optional: e-commerce price checks
      const priceAmount =
        norm.price && norm.price.amount !== undefined
          ? Number(norm.price.amount)
          : null;

      if (norm.price && (priceAmount === null || !Number.isFinite(priceAmount))) {
        ruleTrace.push({
          ruleId: "R-PRICE-NUMERIC",
          fired: true,
          severity: "medium",
          score: 0.7
        });
        issues.push("Price amount is not numeric");
        suggestions.push({
          type: "needs_review",
          field: "price.amount",
          value: norm.price.amount
        });
      }

      if (Number.isFinite(priceAmount) && priceAmount <= 0) {
        ruleTrace.push({
          ruleId: "R-PRICE-POSITIVE",
          fired: true,
          severity: "high",
          score: 0.85
        });
        issues.push("Price amount must be > 0");
        suggestions.push({
          type: "needs_review",
          field: "price.amount",
          value: norm.price.amount
        });
      }

      // Optional: sku sanity
      if (norm.sku && String(norm.sku).trim().length < 2) {
        ruleTrace.push({
          ruleId: "R-SKU-TOO-SHORT",
          fired: true,
          severity: "low",
          score: 0.4
        });
        issues.push("SKU suspiciously short");
        suggestions.push({
          type: "needs_review",
          field: "sku",
          value: norm.sku
        });
      }

      let confidence = 1.0;
      for (const r of ruleTrace) {
        if (r.severity === "high") confidence -= 0.15;
        else if (r.severity === "medium") confidence -= 0.08;
        else confidence -= 0.03;
      }
      confidence = clamp01(confidence);

      let label = "valid";
      if (issues.length > 0) label = confidence < 0.6 ? "ambiguous" : "invalid";

      return { label, confidence, suggestions, ruleTrace, issues };
    }

    const results = [];
    const violations = [];

    for (const item of bundle.items) {
      const itemId = item.itemId || item.id || "unknown";
      const base = applyRules(item);

      for (const s of base.suggestions) {
        if (!allowedSuggestionTypes.has(s.type)) {
          violations.push(`Suggestion type not allowed: ${s.type}`);
        }
      }

      const perItemLoss = findItemLoss(itemId);
      const effectiveLossPenalty = clamp01(
        (typeof perItemLoss === "number" ? perItemLoss * lossAlpha : 0) + lossPenalty
      );

      const adjustedConfidence = clamp01WithFloor(
        base.confidence - effectiveLossPenalty,
        lossFloor
      );

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
            lossAlpha
          }
        });
      }

      let label = base.label;
      if (label === "valid" && adjustedConfidence < 0.6) {
        label = "ambiguous";
      }

      results.push({
        itemId,
        conclusion: {
          label,
          confidence: Number(adjustedConfidence.toFixed(4)),
          suggestions: base.suggestions
        },
        ruleTrace,
        validation: {
          passed: base.issues.length === 0,
          issues: base.issues
        },
        loss: {
          avgLossScore,
          perItemLoss: perItemLoss ?? null,
          lossPenalty: Number(effectiveLossPenalty.toFixed(4))
        }
      });
    }

    // ---------------- Summary ----------------
    const worst = results.reduce(
      (m, it) => Math.min(m, it.conclusion.confidence),
      1
    );

    let status = "ok";
    let decision = "exportable";
    const reasons = [];

    const anyInvalid = results.some((it) => it.conclusion.label !== "valid");
    if (anyInvalid) {
      status = worst < 0.6 ? "needs_review" : "ok";
      decision = worst < 0.6 ? "partial" : "exportable";
      reasons.push("Some items need review due to missing/invalid fields.");
    }

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

    // ---------------- Conservative merge with Policy ----------------
    const mergedStatus = policy.status !== "ok" ? policy.status : status;
    const mergedConfidence = Number(
      Math.min(worst, policy.confidence ?? worst).toFixed(4)
    );

    return res.json({
      requestId,
      summary: {
        status: mergedStatus,
        confidence: mergedConfidence,
        decision,
        reasons,
        lossPenalty: Number(lossPenalty.toFixed(4)),
        avgLossScore: Number(avgLossScore.toFixed(4))
      },
      policy: {
        appliedRules: policy.appliedRules,
        trace: policy.trace
      },
      items: results,
      guardian: {
        passed: violations.length === 0,
        violations
      },
      meta: {
        latencyMs: Date.now() - t0
      }
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