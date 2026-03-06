// backend/demo/run_governance_demo.js

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { runPolicyEngine } from "../lib/governance/policyEngine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function main() {
  try {
    const modeArg = process.argv[2] || "governance";
    const mode = normalizeMode(modeArg);

    const inputPath = getDemoInputPath(mode);
    const rulesetPath = path.join(
      __dirname,
      "..",
      "governance",
      "rulesets",
      "ruleset_v0.1.0.json"
    );

    const input = JSON.parse(fs.readFileSync(inputPath, "utf-8"));
    const ruleset = JSON.parse(fs.readFileSync(rulesetPath, "utf-8"));

    const compressedBundle = input.compressed_bundle || {};
    const compressionManifest = input.compression_manifest || {};

    // optional override: shadow mode from demo input
    const effectiveRuleset = applyDemoModeOverride(ruleset, input.policyMode);

    // 1) Run policy engine
    const policy = runPolicyEngine(compressedBundle, compressionManifest, effectiveRuleset);

    // 2) Build governance decision
    const decision = buildGovernanceDecision(input, policy);

    // 3) Build governance report
    const report = buildGovernanceReport(input, policy, decision, effectiveRuleset);

    // 4) Output
    const outputDir = path.join(__dirname, "output");
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const decisionOut = path.join(outputDir, `decision_${mode}_${ts}.json`);
    const reportOut = path.join(outputDir, `governance_report_${mode}_${ts}.json`);

    fs.writeFileSync(decisionOut, JSON.stringify(decision, null, 2), "utf-8");
    fs.writeFileSync(reportOut, JSON.stringify(report, null, 2), "utf-8");

    console.log("✅ Governance demo executed successfully");
    console.log("Mode:", mode);
    console.log("Input:", inputPath);
    console.log("Decision output:", decisionOut);
    console.log("Report output:", reportOut);

    console.log("\n--- Decision ---");
    console.log(JSON.stringify(decision, null, 2));

    console.log("\n--- Governance Report ---");
    console.log(JSON.stringify(report, null, 2));
  } catch (e) {
    console.error("❌ Governance demo failed");
    console.error(e);
    process.exit(1);
  }
}

function normalizeMode(modeArg) {
  const m = String(modeArg || "").toLowerCase();
  if (m === "normal") return "normal";
  if (m === "shadow") return "shadow";
  return "governance";
}

function getDemoInputPath(mode) {
  const filenameMap = {
    normal: "demo_normal_input.json",
    governance: "demo_governance_active_input.json",
    shadow: "demo_shadow_mode_input.json"
  };

  return path.join(__dirname, "examples", filenameMap[mode]);
}

function applyDemoModeOverride(ruleset, policyMode) {
  if (policyMode !== "shadow") return ruleset;

  const cloned = JSON.parse(JSON.stringify(ruleset));
  cloned.rules = (cloned.rules || []).map((rule) => ({
    ...rule,
    mode: "shadow"
  }));
  return cloned;
}

function buildGovernanceDecision(input, policy) {
  const inputId = input.compressed_bundle?.requestId || `demo-${Date.now()}`;
  const riskLevel = deriveRiskLevel(policy);

  return {
    decision_version: "1.0",
    decision_id: `dec_${inputId}`,
    timestamp: new Date().toISOString(),
    rules_triggered: policy.appliedRules || [],
    action: deriveAction(policy),
    mode: input.policyMode === "shadow" ? "shadow" : "active",
    risk_level: riskLevel,
    confidence_adjustment: Number(((policy.confidence ?? 1) - 1).toFixed(4)),
    notes: buildDecisionNotes(policy)
  };
}

function buildGovernanceReport(input, policy, decision, ruleset) {
  const inputId = input.compressed_bundle?.requestId || "demo_case_unknown";
  const avgLossScore = Number(input.compression_manifest?.summary?.avgLossScore ?? 0);

  return {
    report_version: "1.0",
    report_id: `gov-report-${inputId}`,
    generated_at: new Date().toISOString(),

    input: {
      input_id: inputId,
      source_url: input.compressed_bundle?.items?.[0]?.normalized?.url || "",
      input_type: "url"
    },

    system_context: {
      engine: "SSGE Demo",
      engine_version: "0.1.0",
      governance_mode: decision.mode,
      ruleset_version: ruleset.ruleSetVersion || "v0.1.0",
      schema_version: input.schemaRef || "semantic_schema_registry_v1"
    },

    risk_assessment: {
      risk_level: decision.risk_level,
      risk_score: deriveRiskScore(policy, avgLossScore),
      reason: buildRiskReason(policy, avgLossScore)
    },

    rules_triggered: (policy.appliedRules || []).map((ruleId) => ({
      rule_id: ruleId,
      description: `Triggered by Policy Engine (${ruleId})`,
      severity: mapSeverity(decision.risk_level)
    })),

    actions_taken: buildActionsTaken(policy, decision),

    governance_trace: {
      trace_id: `trace_${inputId}`,
      manifest_ref: `manifest_${inputId}`,
      ruleset_version: ruleset.ruleSetVersion || "v0.1.0",
      decision_hash: simpleHash(JSON.stringify(decision))
    },

    loss_summary: {
      avg_loss_score: avgLossScore,
      loss_penalty: Number((1 - (policy.confidence ?? 1)).toFixed(4))
    },

    compliance_notes: {
      autonomous_decision_making: false,
      self_learning_runtime: false,
      human_governance_required: true,
      remarks: "This DEMO runs in a controlled environment and uses versioned policy artifacts only."
    }
  };
}

function deriveRiskLevel(policy) {
  const status = policy.status || "ok";
  const confidence = Number(policy.confidence ?? 1);

  if (status === "blocked") return "critical";
  if (status === "needs_review" && confidence < 0.8) return "high";
  if (status === "needs_review") return "medium";
  return "low";
}

function deriveAction(policy) {
  const status = policy.status || "ok";

  if (status === "blocked") return "block_output";
  if (status === "needs_review") return "require_review";
  return "allow";
}

function buildDecisionNotes(policy) {
  if (!policy.appliedRules || policy.appliedRules.length === 0) {
    return "No governance rule triggered.";
  }
  return `Applied rules: ${policy.appliedRules.join(", ")}`;
}

function deriveRiskScore(policy, avgLossScore) {
  const confidence = Number(policy.confidence ?? 1);
  const score = Math.max(avgLossScore, 1 - confidence);
  return Number(score.toFixed(4));
}

function buildRiskReason(policy, avgLossScore) {
  if ((policy.appliedRules || []).length > 0) {
    return `Governance rules triggered with avgLossScore=${avgLossScore}.`;
  }
  return "No material governance risk detected.";
}

function buildActionsTaken(policy, decision) {
  const actions = [];

  if (decision.action === "require_review") {
    actions.push({
      action: "set_status",
      value: "needs_review",
      message: "Manual review required."
    });
  }

  const penalty = Number((1 - (policy.confidence ?? 1)).toFixed(4));
  if (penalty > 0) {
    actions.push({
      action: "penalize_confidence",
      value: penalty
    });
  }

  if ((policy.trace || []).length > 0) {
    actions.push({
      action: "log_trace_event"
    });
  }

  if (actions.length === 0) {
    actions.push({
      action: "none"
    });
  }

  return actions;
}

function mapSeverity(riskLevel) {
  if (riskLevel === "critical") return "critical";
  if (riskLevel === "high") return "high";
  if (riskLevel === "medium") return "medium";
  return "low";
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}

main();