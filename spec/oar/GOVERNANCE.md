# Governance

How Open Agent Rules changes, and what an implementer can rely on.

## Where the standard lives

**This repository is the source of truth.** The specification prose, the vocabulary registry,
the JSON Schemas, and the conformance corpus are hand-authored here, and everything published
at <https://openagentrules.org/> is built from this tree by `task site:build`.

Changes land here, by pull request. There is no upstream repository that this one follows, and
no engine whose behaviour is definitionally correct. An implementation that disagrees with the
text has found either a bug in itself or a bug in the text; the pull request settles which.

Open an issue to argue about a clause, and quote the clause identifier — that is what they are
for. Open a pull request to change one, and bring the fixture with it.

## Specification quality & test cohesion

Open Agent Rules is developed test-first. Every normative requirement is backed by three cohesive parts:

1. the specification clause,
2. the schema definition, and
3. at least one conformance fixture in the test corpus.

This discipline keeps the corpus honest: an automated build gate (`task spec:coverage:check`) checks that normative MUST clauses are accompanied by fixtures covering them (or carry a documented exemption). Adding an exemption is a signal to re-read the clause: requirements that seem untestable are usually mis-specified.

## Clause identifiers

Clause identifiers are `OAR-<AREA>-<n>`. They are **append-only**: never renumbered, never reused, never recycled with a different meaning. A requirement that is retired is marked obsolete in place and keeps its identifier, so a citation made earlier still resolves.

`spec/oar/<version>/clause-index.json` records released identifiers. The index is updated when clauses are added:

```bash
node scripts/check-clauses.mjs --write
```

## Versions

`oar` is the format marker and the version. Its presence identifies a document as an OAR rule, and its value is `<major>.<minor>`.

**Minor.** Additive only: a new optional field, a new enum member, a new capability profile, a new clause, or wording that does not change what a conforming engine does. A minor revision never removes or renames a field, never narrows an accepted value, and never changes the decision an existing valid document produces (`[OAR-VER-1]`).

**Major.** Anything that breaks a valid document of the current major (`[OAR-VER-2]`). An engine that does not support a major rejects the document and fails closed. It never coerces, downgrades, or guesses.

**Published versions.** Once a version is officially published (recorded in `spec/published.json`), it is treated as immutable (`[OAR-VER-3]`) so validator caches and URL references do not break. During pre-v1 working drafts, the specification remains under active development.

**Multi-engine validation.** To ensure interoperability and eliminate ambiguity early, features are validated against multiple implementations: the TypeScript reference runner in this repository, alongside co-developed Rust and Go implementations. When a formal standards working group is chartered, independent implementation evidence across multiple independent organizations will guide final ratification.

**An engine rejects a greater minor** (`[OAR-DOC-5]`) and accepts every minor less than or equal to its own. This is deliberate and is argued in [`RATIONALE.md`](RATIONALE.md): a rule is a conjunction, so a field added in a later minor may narrow it, and an engine that ignores that field enforces a policy nobody wrote. The consequence for authors is `[OAR-VER-4]` — a pack targeting a mixed fleet is authored to the lowest minor in that fleet, and says so.

**Adding a fact to an existing profile is breaking** (`[OAR-VER-5]`). A profile is provided whole or not at all, so an engine claiming `filesystem` at the older minor no longer provides all of `filesystem` once a fact is added to it. Such a change either bumps the major or introduces a new profile name. New profiles, by contrast, may be added in a minor: an engine that does not provide one simply does not claim it, and a rule requiring it is rejected at load with a message naming the missing profile.

## Capability profile lifecycle

A capability profile is a named bundle of facts and observation functions that an engine provides whole or not at all. The profile list is the part of this standard most likely to grow, and the part where growth is most expensive: a profile is a permanent obligation on every engine that claims it, and one added carelessly becomes a bundle nobody implements and no rule can portably use.

**Profile design criteria.** A profile is a claim that a *shape of host* recurs across the agent ecosystem. Profiles should represent generalizable, recurring agent host capabilities rather than single-host idioms (which belong in the `host` tier under `<host>.<fact>`). Propose profiles by defining the facts, observation functions, and types in `vocabulary.yaml`, adding them to the specification tables, and supplying conformance fixtures.

**Every fact in a profile obeys the fact rules.** It is an observation and not a verdict (`[OAR-FACT-5]`), it bakes in no threshold and composes no other fact in a policy-meaningful way (`[OAR-FACT-7]`), and it has one of the declared types (`[OAR-FACT-22]`). A proposed profile containing a fact that encodes a conclusion is rejected on that ground alone.

**A profile is provided whole or not at all** (`[OAR-FACT-16]`). An engine may not declare a subset of one, and may not declare a fact under a name belonging to a profile it does not claim (`[OAR-FACT-17]`). That is what makes `requires.profiles` a usable promise: a rule naming a profile knows exactly which names are available to its condition.

**Retiring one.** A profile is not removed in a minor. It is marked deprecated in the vocabulary and in the table, keeps working, and is removed only at a major.

## Compatibility classes

**Decision identifiers are agent-public.** The identifier a decision carries is the contract
with everything downstream: agents branch on it, tooling routes on it, dashboards group by it.
Message text is not — it may be reworded at any time, and software that branches on message
text is broken by design, not by the change that broke it.

Changing what an existing identifier *means* is therefore a major version change, exactly as if
a required field had been renamed. Retiring one is not: an identifier that stops being produced
simply stops appearing.

Two publishers may ship the same bare identifier. Rule identity is the pair (`namespace`,
`id`), so those rules coexist; the rendered identifier stays the bare `id`, which is why
publisher scoping did not break the class.

**Fact names are engine-public.** A rule's condition names them, so renaming a fact inside a
profile, or changing its type or its observation meaning, breaks every rule that composes it.
That is a major change. Adding a *new* fact to a profile is also breaking, for the separate
reason given under Versions.

**Anchors are host-public.** The eight core anchor identifiers and their meanings are fixed
(`[OAR-PROF-1]`). A host-native anchor is the host's own business and may change with the host,
which is exactly why a rule bound to one is not portable.

## Extensions

Fields prefixed `x-` are reserved for implementations. Another implementation **ignores** them
rather than rejecting the document (`[OAR-DOC-26]`), and an `x-` field never acquires normative
meaning without a specification change. It must not affect selection, evaluation, ordering,
precedence, or the returned decision — an extension that changes a decision is a fork of the
format wearing a prefix.

Everything else the document model does not define is rejected, naming the field
(`[OAR-DOC-27]`). The alternative is a typo that silently does nothing, which is how a rule
becomes a placebo.

Host-specific observations are not `x-` fields. They live under a namespace the host owns,
written `<host>.<fact>` (`[OAR-FACT-18]`). A rule that uses one is legal and is not portable,
and the specification says so rather than pretending otherwise.

### The extension registry

[`1.0/EXTENSIONS.md`](1.0/EXTENSIONS.md) records the `x-` extensions implementations have
published, so an author who meets `x-acme-runbook` in someone else's pack can find out what it
means, and so two vendors do not independently choose the same name.

**It is a documented-conventions registry, not a gatekept one** — the model is CloudEvents'
extension documentation rather than a standards-body allocation process. Nobody needs
permission to define an `x-` extension, nothing is rejected for being unregistered, and no
review approves an entry. Recording yours is a courtesy to the next implementer that costs one
pull request. The registry exists to make collisions visible, not to prevent them by authority.

To register: open a pull request adding a row with the field name, the vendor, one sentence on
what it carries, and a link to your own documentation.

## Naming conventions

**Rule identifiers** are `SCREAMING_SNAKE`, match `^[A-Z][A-Z0-9_]*$`, and are stable for the
life of the rule. Never reuse one with a different meaning. When rules are stored one per file
the file should be named after the identifier, but no engine derives identity, ordering, or
precedence from a path (`[OAR-DOC-28]`).

**Publisher namespaces** are lowercase, dot-separated, reverse-DNS-ish — `acme.security`,
`globex.policy` — one per publishing organisation. Identity is (`namespace`, `id`); the
rendered identifier stays the bare `id`.

**Fact names** are `lower_snake_case`. A parameterized observation function that would shadow a
plain fact takes a distinguishing suffix — `mcp_provider_configured` is the fact,
`mcp_provider_configured_for` the function — because facts and functions share one namespace
(`[OAR-FACT-2]`).

**Profile names** are lowercase, hyphenated where they need a second word: `tool`, `session`,
`filesystem`, `content-safety`, `mcp`.

**Host fact namespaces** use the host's own short name as the prefix, and are reserved to the
host that publishes them.

**Extension fields** are `x-<vendor>-<name>`, so two implementations' extensions cannot
collide.

**Conformance fixtures** are `lower-kebab-case`, prefixed with the area they exercise (`sel-`,
`eval-`, `ops-`), and the file stem equals the fixture's `id` (`[OAR-CONF-17]`).

## Who decides

One person maintains this specification, publishing through Painted Wolf LLC. There is no working
group, no committee, and no editorial board — issues and pull requests are decided by the
maintainer, in public, on the repository, and this document says so plainly rather than
dressing one person up as a process.

What protects an adopter is therefore not governance machinery but the artifacts: the
licences (CC BY 4.0 prose, Apache-2.0 everything else) already grant everything needed to
fork or continue the work without permission, the published corpus makes every conformance
claim independently checkable, and the freeze gate makes published versions immutable
whoever holds the pen. If the maintainer vanishes, nothing an implementer depends on
vanishes with them.

Implementation is unrestricted. Anyone may implement Open Agent Rules, for any purpose, without
permission, notification, or fee, and Painted Wolf LLC has published an irrevocable patent
non-assertion covenant covering every implementation — see [`PATENTS.md`](PATENTS.md). There
is no certification programme, no trademark licence to obtain, and no
implementer agreement. "Conforming" means passing the published corpus and reporting which
fixtures were skipped and why (`[OAR-CONF-24]`) — a claim an implementer makes and anyone can
check, not one this project grants.

## What Painted Wolf LLC keeps, and what it does not

The line is drawn once, here, so nobody has to guess.

**Kept: the Painted Wolf name and branding.** "Painted Wolf" and the Painted Wolf logos are
trademarks of Painted Wolf LLC. Using them requires permission, except where law allows.
That is the whole reservation.

**Not kept: the standard.** "Open Agent Rules" and "OAR" are not claimed as trademarks.
Anyone may use the name to refer to this specification, to say truthfully that an
implementation conforms to it, to teach it, criticise it, or build a business on it — no
permission, no notice, no fee. What keeps the name meaningful is not a mark but two other
things: the canonical text lives at a single URL (<https://openagentrules.org/>), and the
CC BY 4.0 licence already requires that a modified version be marked as modified and not
presented as the original or as endorsed by its publisher. A fork may take everything and
call itself anything — including a fork of this text under this licence — it just may not
claim to *be* this specification while saying something different.

**Contributions are inbound = outbound.** A pull request to the prose is offered under
CC BY 4.0; one to the schemas, corpus, examples, or code under Apache-2.0 — the same terms
the project publishes under. There is no CLA and no copyright assignment: contributors keep
their copyright, and once outside contributions land, attribution reads "Painted Wolf LLC
and contributors". A standard whose steward can be replaced must not have collected rights
its next steward would lack.

**The intended endgame is a neutral home.** If this specification earns multiple independent
implementations, the maintainer intends to move it to a vendor-neutral home — a foundation —
rather than keep an open standard inside one company indefinitely. The licences and the
patent covenant are written so that the move needs nobody's permission, and so that nothing
an implementer relies on changes when it happens. Painted Wolf LLC would keep its own name
and branding; the standard would take everything else with it.
