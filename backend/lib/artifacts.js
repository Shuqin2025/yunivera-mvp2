import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// backend/lib/artifacts.js -> backend/demo/output
const OUTPUT_ROOT = path.join(__dirname, "..", "demo", "output");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function makeRunId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function normalizeBaseUrl(baseUrl = "") {
  return String(baseUrl || "").replace(/\/+$/, "");
}

export function writeArtifacts({
  inputUrl = "",
  items = [],
  adapter = "generic",
  baseUrl = ""
} = {}) {
  const runId = makeRunId();
  const dir = path.join(OUTPUT_ROOT, runId);
  ensureDir(dir);

  const generatedAt = new Date().toISOString();
  const safeItems = Array.isArray(items) ? items : [];

  const decision = {
    status: "ok",
    action: "allow",
    source: inputUrl,
    adapter,
    itemCount: safeItems.length,
    generatedAt,
    audit: "auto-generated",
    note: "Demo decision artifact generated from catalog parse result."
  };

  const trace = {
    source: inputUrl,
    adapter,
    generatedAt,
    audit: "auto-generated",
    steps: [
      {
        step: 1,
        name: "catalog_fetch_and_parse",
        status: "ok",
        detail: `Parsed ${safeItems.length} items from source catalog.`
      },
      {
        step: 2,
        name: "table_payload_normalization",
        status: "ok",
        detail: "Normalized parsed items into frontend-compatible table payload."
      },
      {
        step: 3,
        name: "demo_artifacts_generation",
        status: "ok",
        detail: "Generated decision.json, trace.json, governance_report.json."
      }
    ],
    sampleItems: safeItems.slice(0, 3).map((it, idx) => ({
      index: idx + 1,
      sku: String(it?.sku ?? ""),
      title: String(it?.title ?? ""),
      url: String(it?.url ?? it?.link ?? ""),
      img: String(it?.img ?? ""),
      price: it?.price ?? ""
    }))
  };

  const governanceReport = {
    source: inputUrl,
    adapter,
    generatedAt,
    summary: {
      status: "ok",
      decision: "allow",
      riskLevel: "low",
      riskScore: 0,
      itemCount: safeItems.length,
      audit: "auto-generated"
    },
    findings: [
      "Catalog parsed successfully.",
      "Structured table payload produced.",
      "Demo governance artifacts generated.",
      "Excel output is available via existing export endpoint."
    ],
    controls: {
      traceable: true,
      auditable: true,
      replayable: false,
      productionGovernance: false,
      mode: "demo"
    }
  };

  const files = {
    decision: "decision.json",
    trace: "trace.json",
    governanceReport: "governance_report.json",
    excelOutput: "excel_output.xlsx"
  };

  fs.writeFileSync(
    path.join(dir, files.decision),
    JSON.stringify(decision, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dir, files.trace),
    JSON.stringify(trace, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dir, files.governanceReport),
    JSON.stringify(governanceReport, null, 2),
    "utf8"
  );

  const cleanBaseUrl = normalizeBaseUrl(baseUrl);

  const urls = {
    decision: `${cleanBaseUrl}/v1/api/demo/artifacts/${runId}/${files.decision}`,
    trace: `${cleanBaseUrl}/v1/api/demo/artifacts/${runId}/${files.trace}`,
    governanceReport: `${cleanBaseUrl}/v1/api/demo/artifacts/${runId}/${files.governanceReport}`,
    excelOutput: `${cleanBaseUrl}/v1/api/export-xlsx?url=${encodeURIComponent(inputUrl)}`
  };

  return {
    runId,
    directory: `backend/demo/output/${runId}`,
    files,
    urls,
    meta: {
      source: inputUrl,
      adapter,
      dataPoints: safeItems.length,
      generatedAt,
      audit: "auto-generated",
      mode: "demo"
    }
  };
}