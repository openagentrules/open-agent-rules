# Open Agent Rules

A portable document format for what a host lets an agent do at a lifecycle moment. A rule is
a document — not code — that names the moment, a condition over typed observations, and an
effect. A conforming engine loads the document, evaluates the condition, and renders the
effect. The same document produces the same decision on every engine that provides the
capabilities the document declares it needs.

- **Specification** — <https://openagentrules.org/spec/1.0/>
- **Schemas** — <https://openagentrules.org/spec/1.0/schemas.html>
- **Conformance corpus** — <https://openagentrules.org/spec/1.0/conformance.html>
- **A worked rule pack** — <https://openagentrules.org/examples/portable-pack.html>
- **Converting a moderation policy** — <https://openagentrules.org/examples/moderation-pack.html>

**This repository is the standard.** The specification is hand-authored here, in
[`spec/oar/`](spec/oar/), and the published site is built from it. It is not a mirror of any
engine's source tree, and no implementation defines the format by its behaviour. Changes land
here, by pull request.

You do not need this repository to implement Open Agent Rules. Everything an implementer needs
is at the URLs above.

## How to read it

Start with [`spec/oar/1.0/open-agent-rules.md`](spec/oar/1.0/open-agent-rules.md). It is one
file. Sections 1 to 3 are the document model and how a rule is selected; sections 4 to 7 are
what an engine does with it; section 10.1 is the runner algorithm, numbered so a fixture can
cite each step; Appendix A is the condition language, with a grammar.

Every requirement carries a stable identifier like `[OAR-EVAL-4]`. Quote it in an issue.

Then:

- [`spec/oar/RATIONALE.md`](spec/oar/RATIONALE.md) — why the format exists, why not Rego,
  Cedar, or a callback API, and the reasoning behind its main design choices.
- [`examples/portable-pack/`](examples/portable-pack/) — ten rules that exercise most of the
  format, plus the capability document they assume and an operator configuration.
- [`examples/moderation-pack/`](examples/moderation-pack/) — a hosted moderation policy, of the
  kind the large model platforms ship, rewritten as rules; what maps directly and what does not.
- [`spec/oar/1.0/vocabulary.yaml`](spec/oar/1.0/vocabulary.yaml) — the vocabulary in
  machine-readable form, if you would rather consume it than read it.

## Run the corpus against your own engine

The corpus is language-neutral JSON: one fixture per file, each declaring the rules, the
capability document of the host it assumes, the input, and the decision a conforming engine
must produce.

```bash
curl -O https://openagentrules.org/spec/1.0/conformance/manifest.json
```

Load the manifest, fetch and run each fixture it names through your evaluator against that
fixture's own `input.capability`, and compare against `expected`. Report the fixtures you
skipped and why — a skipped fixture is not a passed fixture (`[OAR-CONF-24]`), and a fixture
the manifest marks `baseline` may not be skipped at all (`[OAR-CONF-35]`). Every fixture lists
the clauses it exercises, so a failure tells you which sentence you and the specification
disagree about.

A reference runner ships here and needs no account and no monorepo. Point it at a local
checkout, or at the published manifest URL and it fetches the fixtures itself:

```bash
npm ci --prefix packages/oar-ref
node packages/oar-ref/bin/oar-conformance.mjs spec/oar/1.0/conformance
```

`packages/oar-ref` is one implementation of the runner, not the definition of it — the
definition is the numbered algorithm in section 10.1.

## Implementations

Anyone may implement this specification, for any purpose, without permission, notification, or
fee. There is no certification programme and no implementer agreement.

| Implementation | Language | Note |
|----------------|----------|------|
| [Painted Wolf Code](https://github.com/paintedwolf-ai/paintedwolfcode) | Go | An agent runtime that embeds an OAR engine. One implementation among others, with no special standing. |
| `oar-gateway` | Rust | An MCP gateway tested against the shared OAR conformance corpus. Its results are compared with the TypeScript implementation by `task differential:check`. |
| `packages/oar-ref` | TypeScript | The corpus runner in this repository. Normative-adjacent but not normative: where it and the specification disagree, the specification is right. |

If you build one, open a pull request adding it to that table.

## Propose a change

Open an issue to discuss a clause or feature; quote the clause identifier if applicable.
Changes are developed test-first: every normative requirement is backed by:

1. the specification clause,
2. the schema definition, and
3. at least one conformance fixture.

A build gate (`task spec:coverage:check`) checks that every normative MUST clause has fixture coverage or a documented exemption. The full governance model is in [`spec/oar/GOVERNANCE.md`](spec/oar/GOVERNANCE.md).

## Working on this repository

Implementers need none of this.

| Tool | Version | Used for |
|------|---------|----------|
| [Node.js](https://nodejs.org/) | 22+ | Every gate, the site build, the reference implementation |
| [Task](https://taskfile.dev) | 3.x | `task check` and every target below |
| [Docker](https://www.docker.com/) | optional | `./dev.sh` default stack |

```bash
./dev.sh          # serve site/ in Docker → http://127.0.0.1:8788
./dev.sh local    # same server, native node (no Docker)
task dev          # same as ./dev.sh
```

Both modes run [`scripts/serve.mjs`](scripts/serve.mjs), which applies
[`static/_headers`](static/_headers). A validator following a `$ref` against the dev server sees the
same media type and CORS grant it will see on openagentrules.org.

### Build and check

One command — the same steps CI runs:

```bash
task check
```

| Task | Role |
|------|------|
| `task spec:vocab:check` | The vocabulary tables in the spec match `vocabulary.yaml` exactly |
| `task spec:clauses:check` | Clause identifiers are unique, dense within an area, and append-only |
| `task schema:check` | Every schema parses, carries its published `$id`, and resolves every `$ref` |
| `task spec:coverage:check` | Every MUST clause is covered by a fixture or a written exemption |
| `task spec:capability:check` | Every fixture declares only the capabilities it exercises |
| `task site:build` | Rebuild `site/` from `spec/oar/` and `static/_headers` |
| `task site:check` | Build `site/` and verify its JSON, links, sitemap, and `_headers` |
| `task conformance` | The reference implementation passes the published corpus |
| `task differential:check` | The Rust and TypeScript engines agree on the corpus fixture by fixture |
| `task install` | `npm ci` for the reference implementation |

Clause identifiers are append-only. Regenerate the index with `task spec:clauses:write` when adding new clauses.

`site/` is generated on demand and is untracked by Git. `task site:build` builds `site/` locally or for deployment; the source of truth for headers and caching policy is [`static/_headers`](static/_headers).

### Continuous integration and deployment

| Workflow | Trigger | Role |
|----------|---------|------|
| [`ci.yml`](.github/workflows/ci.yml) | PR, push to `main` | Every `task check` gate, one job each |
| [`cloudflare-pages.yml`](.github/workflows/cloudflare-pages.yml) | push to `main` | Re-run `task check`, then upload `site/` to Cloudflare Pages |

Deployment needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets plus a
`CLOUDFLARE_PAGES_PROJECT_NAME` variable.

## Licences

| Files | Licence |
|-------|---------|
| Specification prose (`spec/**/*.md`) | CC BY 4.0 — see [`LICENCE-SPEC.md`](LICENCE-SPEC.md) |
| Schemas, vocabulary, conformance corpus, examples, and all code | Apache-2.0 — see [`LICENSE`](LICENSE) |

Anyone may implement this specification, for any purpose, without permission, notification, or
fee. Painted Wolf LLC has published an irrevocable patent non-assertion covenant covering
every implementation ([`spec/oar/PATENTS.md`](spec/oar/PATENTS.md)). "Open Agent Rules" and
"OAR" are not claimed as trademarks — only the Painted Wolf name and branding are reserved;
see the [governance document](spec/oar/GOVERNANCE.md) for the exact line.

The versioned source tree includes `release-manifest.json`, which identifies its
exact file bytes with SHA-256 hashes. After changing a draft, run
`task release:manifest` before rebuilding the site. `task release:check` verifies
that identity; `task release:bundle` produces `dist/oar-1.0.tar` and its checksum.
Archive members have fixed ordering, permissions, ownership, and timestamps.
Consumers pin the source manifest and verify the same bytes before conformance.
Publishing still requires the explicit version freeze; building a draft bundle
does not publish or freeze it.
