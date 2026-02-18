# Contributing (Minimal Workflow)

Yunivera is developed under a governance-aware workflow.
This project is currently in an internal development phase ("Strategic Pause").

Fast iteration is encouraged.
Untracked structural changes are not.

---

## Branching

- Work on feature branches:
  - `feat/*`
  - `fix/*`
  - `chore/*`
  - `docs/*`
  - `refactor/*`
  - `test/*`
  - `ci/*`
  - `wip/*`

- Protected branches require PR:
  - `main`
  - (any designated trunk branch such as `feature/restore-mvp` if applicable)

---

## Pull Requests (PR)

- Keep PRs small and focused.
- Use the PR template (auto-filled).
- Prefer squash merge to keep linear history.
- Clearly indicate the affected layer (L1 / L2 / L3 / Governance).

---

## Commit / PR Title Convention

Use one of the following prefixes:

- `feat:`     New feature
- `fix:`      Bug fix
- `chore:`    Tooling / dependency / config
- `docs:`     Documentation
- `refactor:` Code refactor (no behavior change)
- `test:`     Tests
- `ci:`       CI-related changes

Examples:

- `feat: add directory crawl scheduler`
- `fix: handle empty catalog pages`
- `docs: update Strategic Pause notice`

---

## Architectural Discipline

Yunivera is a layered structural engine.

Changes affecting:
- data flow,
- schema,
- semantic compression,
- reasoning logic,
- governance structure

must be clearly scoped and reviewed via PR.

Structural clarity is more important than development speed.
