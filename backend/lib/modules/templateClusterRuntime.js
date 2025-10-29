// backend/modules/templateClusterRuntime.js
// Minimal runtime predictor (placeholder).
// Reads pre-built families from logs/training/templates/templateFamilies.json if exists.
// Exposes predictFamilySync(sample) -> { familyId, similarityScore }

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ultra-simple similarity on fields + selector token overlap
function tokenizeSelector(sel = "") {
  return String(sel || "")
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter(Boolean);
}

function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  const inter = [...A].filter(x => B.has(x)).length;
  const uni = new Set([...A, ...B]).size || 1;
  return inter / uni;
}

export function predictFamilySync(sample = { site: "", pageType: "", rootSelector: "", fields: [] }) {
  try {
    const famFile = path.join(__dirname, "..", "logs", "training", "templates", "templateFamilies.json");
    if (!fs.existsSync(famFile)) {
      return { familyId: "UNKNOWN", similarityScore: 0 };
    }
    const data = JSON.parse(fs.readFileSync(famFile, "utf-8"));
    const families = Array.isArray(data?.families) ? data.families : [];
    if (!families.length) return { familyId: "UNKNOWN", similarityScore: 0 };

    const selTokens = tokenizeSelector(sample.rootSelector);
    const fields = Array.isArray(sample.fields) ? sample.fields.slice().sort() : [];

    let best = { familyId: "UNKNOWN", similarityScore: 0 };

    for (const fam of families) {
      const fSelTokens = tokenizeSelector(fam.fingerprint || fam.rootSelector || "");
      const fFields = Array.isArray(fam.fields) ? fam.fields.slice().sort() : [];
      const selScore = jaccard(selTokens, fSelTokens); // 0..1
      const fieldOverlap = jaccard(fields, fFields);   // 0..1
      const score = 0.6 * selScore + 0.4 * fieldOverlap; // weighted

      if (score > best.similarityScore) {
        best = { familyId: fam.familyId || fam.id || "FAM-UNK", similarityScore: Number(score.toFixed(3)) };
      }
    }
    return best;
  } catch (e) {
    console.warn("[predictFamilySync] error:", e?.message || e);
    return { familyId: "ERROR", similarityScore: 0 };
  }
}
