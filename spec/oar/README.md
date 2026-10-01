# Open Agent Rules — specification tree

This directory is the standard. Every file here is hand-authored, and everything published at
<https://openagentrules.org/> is built from it by `task site:build`.

## The 1.0 tree

| File | What it is | Licence |
|------|------------|---------|
| [`1.0/open-agent-rules.md`](1.0/open-agent-rules.md) | The normative specification. Every requirement carries a clause identifier. | CC BY 4.0 |
| [`1.0/vocabulary.yaml`](1.0/vocabulary.yaml) | The machine-readable vocabulary: core facts, capability profiles, core anchors, reserved detectors, the `on_fire` actions. The tables in sections 5.3, 5.4 and 8.1 are checked against it. | Apache-2.0 |
| [`1.0/schemas/`](1.0/schemas/) | The four JSON Schemas — rule document, capability document, operator configuration, conformance fixture — carrying their canonical `$id`s. Inter-schema `$ref`s are sibling filenames, so the set resolves from the published URLs and from a local directory alike. | Apache-2.0 |
| [`1.0/conformance/`](1.0/conformance/) | The conformance corpus: one JSON fixture per file, plus `manifest.json` and the `exempt.json` justification list. | Apache-2.0 |
| [`1.0/clause-index.json`](1.0/clause-index.json) | The released clause identifiers, for the append-only guard. Projected from the specification text. | Apache-2.0 |
| [`1.0/EXTENSIONS.md`](1.0/EXTENSIONS.md) | The `x-` extension registry and the naming convention. | CC BY 4.0 |
| [`RATIONALE.md`](RATIONALE.md) | Why the format exists and the reasoning behind its design. | CC BY 4.0 |
| [`GOVERNANCE.md`](GOVERNANCE.md) | Version policy, the one-change rule, clause identifiers, the capability-profile lifecycle, compatibility classes, naming. | CC BY 4.0 |
| [`LICENCE-SPEC.md`](LICENCE-SPEC.md) | Which licence covers which file, and the implementation grant. | CC BY 4.0 |

A worked rule pack lives outside this tree, at
[`examples/portable-pack/`](../../examples/portable-pack/).

## Run the corpus

The corpus is language-neutral JSON. Load `manifest.json`, run each fixture it names through
your evaluator against the capability document the fixture declares, and compare against
`expected`. The numbered algorithm your evaluator must implement is section 10.1 of the
specification.

A reference runner lives in this repository at `packages/oar-ref`:

```bash
node packages/oar-ref/bin/oar-conformance.mjs spec/oar/1.0/conformance
```

It is one implementation of the runner, not the definition of it.

## Editing

Everything here is hand-authored, and this repository is where a change lands — there is no
upstream tree that this one mirrors. Two files are projections of the others and are
regenerated rather than edited:

| File | Regenerate with |
|------|-----------------|
| `1.0/clause-index.json` | `node scripts/check-clauses.mjs --write` |
| `1.0/conformance/manifest.json` | the corpus tooling, from the fixtures present |

Four gates run over this tree, and all of them are in `task check`:

| Gate | What it asserts |
|------|-----------------|
| `task spec:vocab:check` | The section 5.3, 5.4 and 8.1 tables match `vocabulary.yaml` exactly |
| `task spec:clauses:check` | Clause identifiers are unique, dense within an area, and append-only |
| `task schema:check` | Every schema parses, carries its published `$id`, and resolves every `$ref` |
| `task spec:coverage:check` | Every MUST clause is covered by a fixture or carries a written exemption |

A change lands the clause, the schema edit, and at least one fixture together — see
[`GOVERNANCE.md`](GOVERNANCE.md).
