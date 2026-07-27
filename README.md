# Open Agent Rules

A portable document format for agent guardrails. A rule is a document — not code — that
names a lifecycle moment, a condition over typed observations, and an effect. A conforming
engine loads the document, evaluates the condition, and renders the effect. The same
document produces the same decision on every conforming engine.

- **Specification** — <https://openagentrules.org/spec/1.1/>
- **Schemas** — <https://openagentrules.org/spec/1.1/schemas.html>
- **Conformance corpus** — <https://openagentrules.org/spec/1.1/conformance.html>

You do not need this repository to implement Open Agent Rules. Everything an implementer
needs is at the URLs above.

## Run the conformance corpus

```bash
npm ci --prefix packages/oar-ref
node packages/oar-ref/bin/oar-conformance.mjs spec/oar/1.1/conformance
```

The corpus is language-neutral JSON. `packages/oar-ref` is one implementation of the
runner, not the definition of it — the definition is the numbered algorithm in the
specification.

## What is generated here

`spec/` and `site/` are **generated** from the engine repository's `spec/oar/` tree by
`cmd/codegen-oar-spec`, and CI fails on drift. Pull requests that edit them are closed
without review: a change to the specification lands in the engine repository, and this
mirror follows.

Issues are the right place to argue about a clause. Quote the clause id.

## Reference implementation

`packages/oar-ref` is a zero-runtime-dependency TypeScript evaluator, native to this
repository and never generated. It is written from the published specification and passes
the whole corpus in CI. It is normative-adjacent but not itself normative: where the two
disagree, the specification is right and the implementation is a bug.

## Licences

| Files | Licence |
|-------|---------|
| Specification prose (`spec/**/*.md`) | CC BY 4.0 — see [`LICENCE-SPEC.md`](LICENCE-SPEC.md) |
| Schemas, conformance corpus, and all code | Apache-2.0 — see [`LICENSE`](LICENSE) |

Anyone may implement this specification, for any purpose, without permission, notification,
or fee.
