/**
 * manifestBuilder.js (CommonJS)
 * Build Compression Manifest v1.0
 *
 * This file is intentionally dependency-free (only Node built-ins),
 * so you can drop it into your backend repo safely.
 */
const crypto = require("crypto");

/** --------- small helpers --------- */
function sha256Hex(input) {
  return crypto.createHash("sha256").update(String(input), "utf8").digest("hex");
}
function sha256Tag(input) {
  return "sha256:" + sha256Hex(input);
}
function nowIso() {
  return new Date().toISOString();
}

/**
 * Deterministically stringify objects so hashes are stable.
 * (JSON.stringify depends on key order; we sort keys.)
 */
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);

  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }

  const keys = Object.keys(value).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + stableStringify(value[k]))
      .join(",") +
    "}"
  );
}

/**
 * Create a short evidenceId (human readable + stable).
 */
function makeEvidenceId(prefix, seed) {
  return `${prefix}_${sha256Hex(seed).slice(0, 10)}`;
}

/**
 * Build one evidence anchor.
 * Important: we store snippetHash, NOT the snippet itself.
 */
function buildEvidenceAnchor({ evidenceId, source, originUrl, fetchedAt, locator, snippet, confidenceContribution }) {
  return {
    evidenceId,
    source,
    origin: { url: originUrl, fetchedAt },
    locator: locator || { type: "unknown" },
    snippetHash: sha256Tag(snippet || ""),
    confidenceContribution: clamp01(confidenceContribution || 0),
  };
}

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Compute avg loss for an item.
 */
function calcLossTotals(fieldChanges) {
  const sum = fieldChanges.reduce((acc, fc) => acc + (fc?.loss?.score || 0), 0);
  const count = fieldChanges.length;
  return {
    fieldLossScoreSum: Number(sum.toFixed(6)),
    fieldCount: count,
    avgFieldLoss: count ? Number((sum / count).toFixed(6)) : 0,
  };
}

/**
 * MAIN: build manifest v1.0
 *
 * @param {object} params
 * @param {string} params.requestId
 * @param {string} params.schemaVersion
 * @param {string} params.engineVersion
 * @param {object} params.inputBundle - the matched_bundle (before compression)
 * @param {object} params.compressedBundle - the compressed_bundle
 * @param {Array<object>} params.itemManifests - per-item details (fieldChanges + evidenceAnchors)
 * @param {Array<object>} [params.ops] - optional operation logs (default: [])
 */
function buildCompressionManifestV1(params) {
  const {
    requestId,
    schemaVersion,
    engineVersion,
    inputBundle,
    compressedBundle,
    itemManifests,
    ops = [],
  } = params || {};

  if (!requestId) throw new Error("buildCompressionManifestV1: requestId required");
  if (!schemaVersion) throw new Error("buildCompressionManifestV1: schemaVersion required");
  if (!engineVersion) throw new Error("buildCompressionManifestV1: engineVersion required");
  if (!inputBundle) throw new Error("buildCompressionManifestV1: inputBundle required");
  if (!compressedBundle) throw new Error("buildCompressionManifestV1: compressedBundle required");
  if (!Array.isArray(itemManifests)) throw new Error("buildCompressionManifestV1: itemManifests must be an array");

  // Hashes: stable across runs
  const inputBundleHash = sha256Tag(stableStringify(inputBundle));
  const compressedBundleHash = sha256Tag(stableStringify(compressedBundle));

  // Summary stats
  const itemsIn = Array.isArray(inputBundle.items) ? inputBundle.items.length : 0;
  const itemsOut = Array.isArray(compressedBundle.items) ? compressedBundle.items.length : 0;

  let fieldsCanonicalized = 0;
  let conflictsResolved = 0;
  let fieldsDroppedLowConfidence = 0;
  let lossSum = 0;
  let lossCount = 0;

  const items = itemManifests.map((it) => {
    const fieldChanges = Array.isArray(it.fieldChanges) ? it.fieldChanges : [];
    const evidenceAnchors = Array.isArray(it.evidenceAnchors) ? it.evidenceAnchors : [];

    for (const fc of fieldChanges) {
      if (fc.decision === "canonicalize") fieldsCanonicalized += 1;
      if (fc.decision === "conflict_resolve") conflictsResolved += 1;
      if (fc.decision === "drop_low_confidence") fieldsDroppedLowConfidence += 1;
      if (fc.loss && typeof fc.loss.score === "number") {
        lossSum += fc.loss.score;
        lossCount += 1;
      }
    }

    return {
      itemId: it.itemId,
      fieldChanges,
      evidenceAnchors,
      lossTotals: calcLossTotals(fieldChanges),
    };
  });

  const avgLossScore = lossCount ? Number((lossSum / lossCount).toFixed(6)) : 0;

  return {
    manifestVersion: "1.0",
    requestId,
    schemaVersion,
    engineVersion,
    createdAt: nowIso(),
    hashes: { inputBundleHash, compressedBundleHash },
    summary: {
      itemsIn,
      itemsOut,
      fieldsCanonicalized,
      conflictsResolved,
      fieldsDroppedLowConfidence,
      avgLossScore,
    },
    items,
    ops: Array.isArray(ops) ? ops : [],
  };
}

module.exports = {
  buildCompressionManifestV1,
  buildEvidenceAnchor,
  makeEvidenceId,
  stableStringify,
  sha256Tag,
};
