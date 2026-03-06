// backend/lib/governance/conditionMatcher.js

export function matchCondition(condition, ctx) {
  if (!condition || !condition.op) return false;

  switch (condition.op) {
    case "gt":
      return getPath(ctx, condition.path) > condition.value;

    case "eq":
      return getPath(ctx, condition.path) === condition.value;

    case "exists":
      return getPath(ctx, condition.path) !== undefined;

    case "missing":
      return getPath(ctx, condition.path) === undefined;

    default:
      return false;
  }
}

/**
 * Very small JSON-path-like resolver.
 * Supports paths like:
 * $.loss.avgLossScore
 * $.manifest.summary.avgLossScore
 */
function getPath(obj, path) {
  if (!path || typeof path !== "string") return undefined;
  if (!path.startsWith("$.")) return undefined;

  const parts = path.slice(2).split(".");
  let cur = obj;

  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }

  return cur;
}