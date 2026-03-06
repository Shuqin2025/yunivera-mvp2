// backend/scripts/ci_contract_check.js
import fs from "fs";
import path from "path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// CJS module in ESM script
const require = createRequire(import.meta.url);
const { compressBundle } = require("../lib/modules/semanticCompression/semanticCompressor.js");

// Load schema (draft-07)
const schemaPath = path.join(__dirname, "..", "lib", "schemas", "compression_manifest_v1.schema.json");
if (!fs.existsSync(schemaPath)) {
  console.error(`[contract-check] schema not found: ${schemaPath}`);
  process.exit(1);
}

const schema = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

// Build a deterministic matchedBundle (no randomness)
const matchedBundle = {
  requestId: "ci-contract-0001",
  schemaVersion: "1.0",
  source: { url: "https://example.test", fetchedAt: "2026-01-01T00:00:00.000Z" },
  items: [
    {
      itemId: "item-1",
      raw: { name: "Demo Item", url: "https://example.test/item-1", price: 10 },
      normalized: {
        id: "item-1",
        title: "Demo Item",
        url: "https://example.test/item-1",
        summary: "contract check fixture",
        source: "catalog",
        sku: "SKU-001",
        price: { amount: 10, currency: "EUR" },
      },
      evidence: [
        {
          field: "sku",
          source: "catalog",
          snippet: "SKU-001",
          confidence: 0.7,
          locator: { type: "catalog_field", key: "sku" },
        },
        {
          field: "price.amount",
          source: "catalog",
          snippet: "10",
          confidence: 0.7,
          locator: { type: "catalog_field", key: "price" },
        },
      ],
    },
  ],
};

const { compression_manifest } = compressBundle({
  requestId: matchedBundle.requestId,
  schemaVersion: matchedBundle.schemaVersion,
  engineVersion: "semanticCompressor@0.1.0",
  matchedBundle,
});

// Validate manifest contract
const ok = validate(compression_manifest);
if (!ok) {
  console.error("[contract-check] compression_manifest violates schema:");
  console.error(JSON.stringify(validate.errors || [], null, 2));
  process.exit(1);
}

console.log("[contract-check] PASS: compression_manifest matches v1 schema.");
process.exit(0);