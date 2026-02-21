const { compressBundle } = require("../semanticCompressor");
const fs = require("fs");
const path = require("path");

const matchedBundle = {
  requestId: "demo-001",
  schemaVersion: "1.0",
  source: { url: "https://example.org", fetchedAt: new Date().toISOString() },
  items: [
    {
      itemId: "a",
      normalized: { sku: " ABC-123 ", price: { amount: "€12,34", currency: "EUR" } },
      evidence: [
        { field: "price.amount", source: "meta", snippet: "12.34", confidence: 0.88, locator: { type: "meta", key: "product:price:amount" } },
        { field: "price.amount", source: "regex", snippet: "€12,34", confidence: 0.72, locator: { type: "regex", regexId: "EUR_PRICE" } }
      ]
    }
  ]
};

const { compressed_bundle, compression_manifest } = compressBundle({
  requestId: matchedBundle.requestId,
  schemaVersion: matchedBundle.schemaVersion,
  engineVersion: "semanticCompressor@0.1.0",
  matchedBundle,
  ctx: { options: { dropCandidateBelow: 0.15 } }
});

fs.writeFileSync(path.join(__dirname, "compressed_bundle.json"), JSON.stringify(compressed_bundle, null, 2));
fs.writeFileSync(path.join(__dirname, "compression_manifest.json"), JSON.stringify(compression_manifest, null, 2));
console.log("Wrote examples/compressed_bundle.json and examples/compression_manifest.json");
