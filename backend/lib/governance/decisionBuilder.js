// backend/lib/governance/decisionBuilder.js

/**
 * buildPolicyDecision
 *
 * Normalizes the internal policy state into the final engine result.
 */
export function buildPolicyDecision(state) {
  return {
    confidence: clamp01(state?.confidence),
    status: state?.status ?? "ok",
    appliedRules: Array.isArray(state?.appliedRules) ? state.appliedRules : [],
    trace: Array.isArray(state?.trace) ? state.trace : []
  };
}

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
