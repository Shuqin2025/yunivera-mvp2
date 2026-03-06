/**
 * Yunivera AI Governance Demo Runner
 *
 * This script demonstrates how the Governance Engine
 * evaluates an input and produces a governance decision.
 */

const fs = require("fs");
const path = require("path");

const policyEngine = require("../lib/governance/policyEngine");

// -------- paths --------

const inputPath = path.join(
  __dirname,
  "examples",
  "demo_normal_input.json"
);

const decisionOutput = path.join(
  __dirname,
  "../runtime/decisions/demo_governance_decision_output.json"
);

const reportOutput = path.join(
  __dirname,
  "../governance/reports/demo_governance_report_output.json"
);


// -------- load input --------

console.log("Loading demo input...");

const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));


// -------- run policy engine --------

console.log("Running Governance Policy Engine...");

const result = policyEngine.evaluate(input);


// -------- save decision --------

fs.writeFileSync(
  decisionOutput,
  JSON.stringify(result.decision, null, 2)
);


// -------- save report --------

fs.writeFileSync(
  reportOutput,
  JSON.stringify(result.report, null, 2)
);


console.log("Governance decision saved to:");
console.log(decisionOutput);

console.log("Governance report saved to:");
console.log(reportOutput);

console.log("Demo completed successfully.");