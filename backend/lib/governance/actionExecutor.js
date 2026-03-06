// backend/lib/governance/actionExecutor.js

export function applyActions(actions, state, ctx, rule) {
  const next = {
    ...state,
    trace: [...state.trace]
  };

  for (const action of actions) {
    switch (action.type) {
      case "penalize_confidence":
        next.confidence = (next.confidence ?? 1) - Number(action.value || 0);
        next.trace.push({
          ruleId: rule.ruleId,
          type: "penalize_confidence",
          value: action.value
        });
        break;

      case "set_status":
        next.status = action.value || next.status;
        next.trace.push({
          ruleId: rule.ruleId,
          type: "set_status",
          value: action.value
        });
        break;

      case "emit_trace":
        next.trace.push({
          ruleId: rule.ruleId,
          type: "emit_trace",
          message: action.message || ""
        });
        break;

      case "require_review":
        next.status = "needs_review";
        next.trace.push({
          ruleId: rule.ruleId,
          type: "require_review"
        });
        break;

      default:
        next.trace.push({
          ruleId: rule.ruleId,
          type: "unknown_action",
          message: `Unsupported action: ${action.type}`
        });
        break;
    }
  }

  return next;
}