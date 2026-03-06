// backend/lib/governance/policyEvaluator.js

import { matchCondition } from "./conditionMatcher.js";
import { applyActions } from "./actionExecutor.js";

/**
 * evaluatePolicyRules
 *
 * Runs all rules in the ruleset against the provided policy context.
 *
 * Returns an intermediate state object:
 * {
 *   confidence,
 *   status,
 *   appliedRules,
 *   trace
 * }
 */
export function evaluatePolicyRules(ctx, ruleset) {
  let state = {
    confidence: ruleset?.defaults?.baseConfidence ?? 1.0,
    status: "ok",
    appliedRules: [],
    trace: []
  };

  for (const rule of ruleset?.rules || []) {
    if (!rule?.enabled) continue;

    const matched = matchCondition(rule.when, ctx);
    if (!matched) continue;

    state.appliedRules.push(rule.ruleId);

    // shadow mode: record only, do not enforce
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

  return state;
}