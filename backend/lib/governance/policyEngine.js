// backend/lib/governance/policyEngine.js

import { buildPolicyContext } from "./policyContextBuilder.js";
import { evaluatePolicyRules } from "./policyEvaluator.js";
import { buildPolicyDecision } from "./decisionBuilder.js";

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
