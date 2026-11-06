# AGENTS.md — Working on Open Agent Rules

Instructions and guidelines for AI coding assistants and contributors working in this repository.

## 1. Project Context & Status

- **Status:** Open Agent Rules (OAR) is currently a **pre-v1 candidate specification**.
- **Maintainer Model:** Maintained by a solo author (publishing through Painted Wolf LLC) who aims to donate/transition the specification and its assets to a vendor-neutral standards organization (e.g., W3C, IETF, Linux Foundation, or OASIS).
- **Core Philosophy:** **High technical rigor, zero synthetic bureaucracy.** We enforce strict engineering quality (schema validity, comprehensive test fixtures, reference runner, and cross-engine differential validation), but avoid faux-parliamentary review hurdles, artificial multi-party submission barriers, or premature freeze ceremonies.

## 2. Directory Structure & Sources of Truth

- `spec/oar/1.1/`: The canonical, hand-authored specification files for the current version:
  - `open-agent-rules.md`: Normative specification prose.
  - `vocabulary.yaml`: Machine-readable registry of core facts, standard profiles, core anchors, and the reserved detector references.
  - `schemas/`: JSON Schemas defining the document models (`oar.schema.json`, `selector.schema.json`, `oar-profile.schema.json`).
  - `conformance/`: The language-neutral JSON test corpus (one fixture per file) plus `manifest.json` and `exempt.json`.
  - `clause-index.json`: Released clause identifiers list.
- `spec/oar/1.0/`: The published 1.0 tree. **Immutable** — a published version is never edited; a correction ships as a new version.
- `spec/oar/GOVERNANCE.md`: Seed specification guidelines, intellectual property commitments, and standards body transition plan.
- `spec/oar/RATIONALE.md`: Architectural decisions and trade-offs.
- `spec/oar/PATENTS.md`: The patent non-assertion covenant.
- `static/_headers`: Hand-maintained HTTP headers and CORS policies for the documentation site.
- `site/`: Generated static HTML and distribution tree. **Do NOT commit files in `site/` to Git**; it is ignored and built automatically during deployment and checks.
- `packages/oar-ref`: The zero-dependency TypeScript reference runner and test harness.
- `scripts/`: Zero-dependency Node.js and shell verification scripts.
- `examples/`: Worked rule packs (`portable-pack`, `remedy-pack`).

## 3. Engineering Disciplines & Workflow

### The Cohesive Change Discipline
Every normative requirement is developed with three cohesive parts:
1. The specification clause in `open-agent-rules.md`.
2. The schema definition in `schemas/`.
3. At least one conformance fixture in `conformance/` (or an explicit entry in `exempt.json` if tested via schemas or unit tests).

### Adding or Modifying Clauses
1. Clauses use identifiers of the form `[OAR-<AREA>-<n>]` (e.g. `[OAR-DOC-5]`).
2. Update `vocabulary.yaml` if introducing facts, profiles, or actions.
3. Update schemas in `schemas/` if syntax or structure changes.
4. Add or update fixtures in `spec/oar/1.1/conformance/`.
5. Update `clause-index.json` when adding clauses:
   ```bash
   node scripts/check-clauses.mjs --write 1.1
   ```
6. Run `task check` to verify consistency.

## 4. Verification & Testing

Run verification commands through `task` (or directly via Node/npm):

- `task spec:vocab:check` (`node scripts/check-vocab.mjs 1.1`): Vocabulary tables in markdown match `vocabulary.yaml`.
- `task spec:clauses:check` (`node scripts/check-clauses.mjs 1.1`): Clause identifiers are unique and cross-references resolve.
- `task schema:check` (`node scripts/check-schemas.mjs 1.1`): Schemas parse and resolve `$ref`s.
- `task spec:coverage:check` (`node scripts/check-coverage.mjs 1.1`): Every normative MUST clause is covered by a fixture or documented in `exempt.json`.
- `task site:check` (`node scripts/build-site.mjs 1.1 && node scripts/check-site.mjs`): Rebuilds `site/` and validates links/JSON.
- `task ref:test`: Runs unit tests in `packages/oar-ref`.
- `task conformance`: Runs the conformance fixtures against `packages/oar-ref`.
- `task pack:lint`: Lints example rule packs.
- `task differential:check`: Compares reference engine with sibling engines if present.

## 5. What NOT To Do

- **Do NOT commit `site/` artifacts:** The static site is fully generated. Never commit generated HTML files to Git.
- **Do NOT edit `spec/oar/1.0/`:** A published version tree is immutable; corrections ship as a new version.
- **Do NOT re-hash release manifests on routine commits:** `release-manifest.json` and `dist/` tarballs are for tagged releases, not routine drafting commits.
- **Do NOT invent multi-stakeholder submission hurdles:** Avoid phrases like "two independent implementers required before proposing" or "proposals without fixtures will be rejected by the committee." Frame guidelines around software engineering quality and test coverage.
- **Do NOT bypass schema or fixture validation:** When changing engine semantics, always verify against the reference runner and conformance suite.
