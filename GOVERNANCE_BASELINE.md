\# Governance Baseline (v0.1.0)



This repository implements a \*\*Structured Semantic Governance Engine\*\* baseline.

v0.1.0 establishes the minimum non-bypassable guarantees for:

\- manifest contract integrity

\- auditable compression decisions

\- governance-aware reasoning (lossPenalty closure)

\- PR-only, policy-protected main branch



---



\## 1. Scope



This baseline applies to:

\- `/v1/api/match/find` output contract and manifest generation

\- semantic compression module and manifest hashing

\- `/v1/api/reason` governance reasoning output

\- CI enforcement on pull requests to `main`



Non-goals (out of scope for v0.1.0):

\- full product/business logic expansion

\- UI/UX completeness

\- advanced crawler coverage

\- enterprise authentication/authorization



---



\## 2. Key Contracts



\### 2.1 Compression Manifest Contract (Hard Lock)

`compression\_manifest` MUST conform to the JSON Schema:



\- `backend/lib/schemas/compression\_manifest\_v1.schema.json`



Enforcement:

\- Runtime enforcement in `/match/find`:

&nbsp; - if manifest fails schema validation → request is blocked with `manifest\_contract\_violation`

\- CI enforcement on PRs:

&nbsp; - `contract-check` workflow must pass



\### 2.2 Deterministic Hashing

Manifest contains deterministic hashes to support auditability:

\- `inputBundleHash`

\- `compressedBundleHash`

(Exact fields are defined by the manifest schema and generator logic.)



---



\## 3. Governance Reasoning Closure (lossPenalty)



`/v1/api/reason` consumes:

\- `compressed\_bundle`

\- optional `compression\_manifest`



It must incorporate governance loss into confidence:



\- `avgLossScore` (from `compression\_manifest.summary.avgLossScore`)

\- `lossPenalty = avgLossScore \* lossAlpha` (alpha defined in reason logic)

\- confidence is reduced by `lossPenalty`

\- ruleTrace includes `G-LOSS-PENALTY` when penalty is applied



Expected behavior:

\- non-trivial loss triggers `needs\_review` / `partial` decision even if item fields look valid

\- output is fully auditable via `ruleTrace` + `loss` sections



---



\## 4. API Surface (v0.1.0)



\### 4.1 Match

`POST /v1/api/match/find`

Returns:

\- `items` (scored candidates)

\- `compressed\_bundle`

\- `compression\_manifest`



\### 4.2 Reason

`POST /v1/api/reason`

Input:

\- `compressed\_bundle`

\- optional `compression\_manifest`



Output:

\- `summary` (status/decision/confidence + lossPenalty signals)

\- `items\[]` (conclusion + ruleTrace + validation + loss)

\- `guardian`

\- `meta`



---



\## 5. Non-bypassable Main Branch Protections



The `main` branch is protected with:

\- PR-only merges

\- required status checks:

&nbsp; - `contract-check`

&nbsp; - `regression-lossPenalty`

\- signed commits required

\- linear history required

\- branch must be up-to-date before merge



This ensures governance logic cannot regress silently.



---



\## 6. CI Baseline (v0.1.0)



\### 6.1 contract-check (PR required)

Validates:

\- manifest generator can produce a manifest

\- manifest validates against the schema contract

Failing this blocks merging.



\### 6.2 regression-lossPenalty (PR required)

Validates:

\- lossPenalty math and behavior are stable

\- `G-LOSS-PENALTY` appears in ruleTrace

\- status/decision changes as expected under loss



Failing this blocks merging.



---



\## 7. Versioning Policy



\- Repo follows semantic versioning for governance behavior.

\- v0.1.0 is the first governance baseline.

\- Any backward-incompatible schema or reasoning changes require:

&nbsp; - schema/version bump

&nbsp; - migration notes in PR description



---



\## 8. Audit Posture



This baseline provides:

\- machine-enforced contract validation

\- deterministic hashing for traceability

\- governance-aware reasoning output

\- CI guardrails that prevent silent regression



---



\## 9. Roadmap Note



After v0.1.0 baseline is established, the project may prioritize:

\- L2 business capability and platform integration

\- gradual improvements in release automation (P1)

\- ownership governance (P2)



Governance baseline remains mandatory across all future work.

