
# yunivera-mvp2 Pull Request

---

# What
<!-- One-sentence summary of this change -->

- 

---

# Why
<!-- Why is this change necessary? What problem does it solve? -->

- 

---

# Layer Impact

Select all applicable layers:

- [ ] L1 — Crawl / Parse
- [ ] L2 — Match / Normalize
- [ ] L3 — Reasoning
- [ ] Compression / Manifest
- [ ] Governance / Docs
- [ ] Infra / CI

---

# Change Type

- [ ] feat (new capability)
- [ ] fix (bug fix)
- [ ] refactor (internal restructuring)
- [ ] perf (performance improvement)
- [ ] docs (documentation only)
- [ ] test (tests only)
- [ ] chore (repo / tooling / automation)

---

# Production Impact

- [ ] No production impact (internal / dev only)
- [ ] Production-impacting change

If production-impacting, describe:

- Affected endpoints:
- Schema changes:
- Backward compatibility:
- Migration required:

---

# Risk Assessment

- [ ] Low — isolated logic / no schema change
- [ ] Medium — touches scoring / rule logic
- [ ] High — API / contract / schema change

Explain risk if Medium or High:

-

---

# Technical Details

Describe key implementation points:

- 
- 
- 

---

# Contract / API Verification (if applicable)

- Endpoint(s):
  - 
- Guaranteed response fields:
  - [ ] compressed_bundle
  - [ ] compression_manifest
  - [ ] No `manifest_contract_violation`
- Schema version verified:
  - schemaVersion:

---

# Validation / Testing

## Manual Validation

- [ ] node .\server.js
- [ ] POST /v1/api/match/find
- [ ] POST /v1/api/reason (if applicable)
- [ ] Verified expected fields present
- [ ] Verified confidence / lossPenalty logic

Commands used:

## What
- 

## Layer Impact
- [ ] L1 (Crawl / Parse)
- [ ] L2 (Match / Normalize)
- [ ] L3 (Reasoning)
- [ ] Governance / Docs
- [ ] Infra / CI

## Production Impact
- [ ] No production impact (internal/dev only)
- [ ] Production-impacting change (describe below)

## Risk
- [ ] Low
- [ ] Medium
- [ ] High

## Checklist
- [ ] Scope is limited (small/contained)
- [ ] CI passes (if enabled)
- [ ] Backward compatibility considered (if API related)

