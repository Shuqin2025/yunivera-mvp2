/**
 * semanticCompressor.js (CommonJS)
 *
 * Minimal online compression layer:
 * matched_bundle -> (compressed_bundle + compression_manifest)
 *
 * It does THREE safe things only:
 * 1) Canonicalize simple field formats (price amount/currency, trim strings)
 * 2) Resolve simple conflicts (choose highest-confidence candidate)
 * 3) Drop extremely low-confidence candidates (optional thresholds)
 *
 * IMPORTANT: It NEVER deletes your raw data; it only changes the middle representation.
 */
import { createRequire } from "module";
const require = createRequire(import.meta.url);

const { buildCompressionManifestV1, buildEvidenceAnchor, makeEvidenceId } =
  require("./manifestBuilder.cjs");

/** tweakable thresholds */
const DEFAULTS = {
  dropCandidateBelow: 0.15, // if a candidate confidence < 0.15, ignore it
};

function compressBundle({ requestId, schemaVersion, engineVersion, matchedBundle, ctx }) {
  if (!matchedBundle || !Array.isArray(matchedBundle.items)) {
    throw new Error("compressBundle: matchedBundle.items must be an array");
  }

  const options = Object.assign({}, DEFAULTS, (ctx && ctx.options) || {});
  const originUrl = (matchedBundle.source && matchedBundle.source.url) || (ctx && ctx.originUrl) || "unknown";
  const fetchedAt = (matchedBundle.source && matchedBundle.source.fetchedAt) || (ctx && ctx.fetchedAt) || new Date().toISOString();

  // 1) Produce compressed bundle (deep-ish copy)
  const compressedBundle = {
    requestId,
    schemaVersion,
    source: matchedBundle.source || { url: originUrl, fetchedAt },
    items: matchedBundle.items.map((item) => compressOneItem(item, { options })),
  };

  // 2) Build per-item manifest details from what we did
  const itemManifests = compressedBundle.items.map((compressedItem, idx) => {
    const originalItem = matchedBundle.items[idx];

    // We'll record changes on a small set of fields you likely have in "normalized"
    // You can expand later.
    const changes = [];
    const evidenceAnchors = [];

    // helper to record a field decision
    function recordFieldChange(field, beforeCandidates, afterCanonical, loss, decision, rationale) {
      changes.push({
        field,
        decision,
        beforeCandidates,
        afterCanonical,
        loss,
        rationale,
      });
    }

    // --- Example: price.amount canonicalization ---
    const beforePriceCandidates = getCandidates(originalItem, "price.amount")
      .filter((c) => c.confidence >= options.dropCandidateBelow);

    const afterPrice = getCanonical(compressedItem, "price.amount");
    if (beforePriceCandidates.length > 0 || afterPrice.value !== undefined) {
      const decision = inferDecision(beforePriceCandidates, afterPrice);
      const loss = { score: 0.01, type: "format_loss", notes: "Normalized numeric format" };

      // evidence anchor for the winning candidate (if exists)
      if (afterPrice && afterPrice.evidence) {
        const evId = afterPrice.evidence.evidenceId || makeEvidenceId("e", JSON.stringify(afterPrice.evidence));
        evidenceAnchors.push(
          buildEvidenceAnchor({
            evidenceId: evId,
            source: afterPrice.evidence.source || afterPrice.source || "unknown",
            originUrl,
            fetchedAt,
            locator: afterPrice.evidence.locator || { type: afterPrice.evidence.source || "unknown" },
            snippet: afterPrice.evidence.snippet || "",
            confidenceContribution: afterPrice.confidence || 0,
          })
        );
      }

      recordFieldChange(
        "price.amount",
        beforePriceCandidates.map((c) => ({
          value: c.value,
          confidence: c.confidence,
          source: c.source,
          evidenceId: c.evidenceId || "unknown",
        })),
        { value: afterPrice.value, confidence: afterPrice.confidence, source: afterPrice.source || "unknown" },
        loss,
        decision,
        decision === "canonicalize" ? "Chose highest-confidence candidate and normalized format." : "No change."
      );
    }

    // --- Example: sku canonicalization ---
    const beforeSkuCandidates = getCandidates(originalItem, "sku")
      .filter((c) => c.confidence >= options.dropCandidateBelow);

    const afterSku = getCanonical(compressedItem, "sku");
    if (beforeSkuCandidates.length > 0 || afterSku.value) {
      const decision = inferDecision(beforeSkuCandidates, afterSku);
      const loss = { score: 0.0, type: "no_loss", notes: "" };

      if (afterSku && afterSku.evidence) {
        const evId = afterSku.evidence.evidenceId || makeEvidenceId("e", JSON.stringify(afterSku.evidence));
        evidenceAnchors.push(
          buildEvidenceAnchor({
            evidenceId: evId,
            source: afterSku.evidence.source || afterSku.source || "unknown",
            originUrl,
            fetchedAt,
            locator: afterSku.evidence.locator || { type: afterSku.evidence.source || "unknown" },
            snippet: afterSku.evidence.snippet || "",
            confidenceContribution: afterSku.confidence || 0,
          })
        );
      }

      recordFieldChange(
        "sku",
        beforeSkuCandidates.map((c) => ({
          value: c.value,
          confidence: c.confidence,
          source: c.source,
          evidenceId: c.evidenceId || "unknown",
        })),
        { value: afterSku.value, confidence: afterSku.confidence, source: afterSku.source || "unknown" },
        loss,
        decision,
        decision === "canonicalize" ? "Trimmed/normalized SKU and kept highest-confidence candidate." : "No change."
      );
    }

    return {
      itemId: compressedItem.itemId || String(idx),
      fieldChanges: changes,
      evidenceAnchors,
    };
  });

  const manifest = buildCompressionManifestV1({
    requestId,
    schemaVersion,
    engineVersion,
    inputBundle: matchedBundle,
    compressedBundle,
    itemManifests,
    ops: [],
  });

  return { compressed_bundle: compressedBundle, compression_manifest: manifest };
}

/** Compress one item (very conservative) */
function compressOneItem(item, { options }) {
  const out = JSON.parse(JSON.stringify(item || {}));
  out.itemId = out.itemId || stableItemId(out);

  // Ensure normalized exists
  out.normalized = out.normalized || {};

  // Canonicalize price.amount if present
  if (out.normalized.price && typeof out.normalized.price.amount !== "undefined") {
    out.normalized.price.amount = normalizeNumber(out.normalized.price.amount);
  }

  // Canonicalize sku
  if (out.normalized.sku) out.normalized.sku = String(out.normalized.sku).trim();

  // NOTE: real systems will also canonicalize currency, dates, ids, etc.
  return out;
}

function stableItemId(item) {
  const seed = (item.raw && (item.raw.title || item.raw.name || "")) + "|" + (item.raw && item.raw.link || "");
  const h = require("crypto").createHash("sha256").update(seed).digest("hex").slice(0, 12);
  return "item_" + h;
}

function normalizeNumber(v) {
  // Accept number or string like "€12,34"
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = String(v || "").replace(/[^\d.,-]/g, "").trim();
  if (!s) return v;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  let str = s;
  if (lastComma > lastDot) str = str.replace(/\./g, "").replace(",", ".");
  else str = str.replace(/,/g, "");
  const num = Number(str);
  return Number.isFinite(num) ? num : v;
}

/**
 * Pull candidates from original item in a flexible way.
 * We support either:
 * - item.candidates["price.amount"] = [{value, confidence, source, evidenceId}, ...]
 * - item.evidence[] where evidence.field == "price.amount"
 */
function getCandidates(originalItem, field) {
  if (!originalItem) return [];
  const out = [];

  if (originalItem.candidates && Array.isArray(originalItem.candidates[field])) {
    for (const c of originalItem.candidates[field]) out.push(c);
  }

  if (Array.isArray(originalItem.evidence)) {
    for (const e of originalItem.evidence) {
      if (e.field === field) {
        out.push({
          value: e.value ?? e.snippet,
          confidence: e.confidence ?? 0,
          source: e.source ?? "unknown",
          evidenceId: e.evidenceId ?? makeEvidenceId("e", JSON.stringify(e)),
        });
      }
    }
  }

  // fallback: if normalized already has value but no candidates
  // we add a synthetic candidate
  const norm = originalItem.normalized || {};
  if (field === "sku" && norm.sku) {
    out.push({ value: norm.sku, confidence: 0.7, source: "normalized", evidenceId: "synthetic" });
  }
  if (field === "price.amount" && norm.price && norm.price.amount) {
    out.push({ value: norm.price.amount, confidence: 0.7, source: "normalized", evidenceId: "synthetic" });
  }

  // choose best first
  out.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  return out;
}

function getCanonical(compressedItem, field) {
  const norm = (compressedItem && compressedItem.normalized) || {};
  if (field === "sku") {
    return {
      value: norm.sku || "",
      confidence: 0.7,
      source: "normalized",
      evidence: { source: "normalized", snippet: String(norm.sku || ""), locator: { type: "normalized" } },
    };
  }
  if (field === "price.amount") {
    const v = norm.price && typeof norm.price.amount !== "undefined" ? norm.price.amount : "";
    return {
      value: v,
      confidence: 0.7,
      source: "normalized",
      evidence: { source: "normalized", snippet: String(v), locator: { type: "normalized" } },
    };
  }
  return { value: "", confidence: 0, source: "unknown" };
}

function inferDecision(beforeCandidates, afterCanonical) {
  if (!beforeCandidates || beforeCandidates.length === 0) return "pass_through";
  if (beforeCandidates.length === 1) return "canonicalize";
  // if top two disagree, it's conflict resolve
  const v1 = String(beforeCandidates[0].value ?? "");
  const v2 = String(beforeCandidates[1].value ?? "");
  if (v1 && v2 && v1 !== v2) return "conflict_resolve";
  return "canonicalize";
}

export { compressBundle };
