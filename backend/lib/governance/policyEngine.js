// backend/lib/governance/policyEngine.js

import { buildPolicyContext } from "./policyContextBuilder.js";
import { evaluatePolicyRules } from "./policyEvaluator.js";
import { buildPolicyDecision } from "./decisionBuilder.js";

import { matchCondition } from "./conditionMatcher.js";
import { applyActions } from "./actionExecutor.js";

/**
 * runPolicyEngine
 *
 * Input:
 * - compressedBundle
 * - compressionManifest
 * - ruleset
 *
 * Output:
 * {
 *   confidence,
 *   status,
 *   appliedRules,
 *   trace
 * }
 */
export function runPolicyEngine(compressedBundle, compressionManifest, ruleset) {
  const ctx = buildPolicyContext(compressedBundle, compressionManifest);
  const evaluatedState = evaluatePolicyRules(ctx, ruleset);
  return buildPolicyDecision(evaluatedState);
}

  let state = {
    confidence: ruleset?.defaults?.baseConfidence ?? 1.0,
    status: "ok",
    appliedRules: [],
    trace: []
  };

  for (const rule of ruleset?.rules || []) {
    if (!rule.enabled) continue;

    const matched = matchCondition(rule.when, ctx);
    if (!matched) continue;

    state.appliedRules.push(rule.ruleId);

    // shadow mode: only record trace, do not enforce
    if (rule.mode === "shadow") {
      state.trace.push({
        ruleId: rule.ruleId,
        type: "shadow_match",
        message: "Rule matched in shadow mode"
      });
      continue;
    }

    state = applyActions(rule.then?.actions || [], state, ctx, rule);
  }

  return finalizePolicyState(state);
}

function finalizePolicyState(state) {
  return {
    confidence: clamp01(state.confidence),
    status: state.status,
    appliedRules: state.appliedRules,
    trace: state.trace
  };
}

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}