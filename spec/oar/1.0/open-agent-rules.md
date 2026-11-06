# Open Agent Rules

**Version 1.0** · Status: draft · Canonical URL: `https://openagentrules.org/spec/1.0/`

Open Agent Rules (OAR) is a portable document format for what a host lets an agent do at a
lifecycle moment. A rule is a document — not code — that names the moment, a condition over
typed observations, and an effect. A conforming engine loads the document, evaluates the
condition, and renders the effect. The same document produces the same decision on every
engine that provides the capabilities the document declares it needs.

## Implementation grant

Anyone may implement this specification, for any purpose, without permission, notification,
or fee. See [`LICENCE-SPEC.md`](../LICENCE-SPEC.md) for the licence covering this text, and
[`PATENTS.md`](../PATENTS.md) for the patent non-assertion covenant covering every
implementation.

## Conformance language

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY in this document are to be
interpreted as described in BCP 14 (RFC 2119, RFC 8174) when, and only when, they appear in
all capitals, as shown here. Every requirement carries a stable clause identifier
in the form `[OAR-AREA-n]`. Clause identifiers are append-only: they are never renumbered
and never reused. Examples are non-normative unless a clause identifier appears beside them.

---

## 1. Overview

A **rule** is a document with three obligatory parts: *where* it applies (an anchor plus a
selector), *when* it applies (a condition over facts), and *what happens* (an effect, plus
optional engine side-effects). Everything else in the document is metadata, presentation
copy, or provenance.

The division of labour is fixed and is the reason the format stays readable:

> **The host produces facts. The rule composes facts. The engine renders effects.**

A **host** is the system the rules bind — an agent runtime, a model gateway, a tool server.
It publishes typed *observations* of its own state at named lifecycle moments. An **engine**
loads rule documents, selects the ones bound to the moment that just occurred, evaluates
their conditions against the published observations, and applies the resulting decision. A
**rule author** writes documents; they never write host code.

**Portability** in this specification is a precise, checkable claim. The standard fixes three
vocabularies: a set of *core anchors* (lifecycle moments), a set of named *capability
profiles* (bundles of typed observations), and a *condition language* (Appendix A). A rule
declares which profiles it needs. Any engine providing those profiles runs that rule and
produces the same decision. A rule that reaches for a host's own anchors or its own facts is
still a valid OAR document and still loads — it is simply not portable, and the standard says
so rather than pretending otherwise.

---

## 2. Document model

- **[OAR-DOC-1]** A rule document MUST be representable as a JSON object. An engine MAY
  accept other serialisations (YAML is the common authoring form) provided the mapping to
  JSON is lossless; interchange between implementations MUST use JSON.
- **[OAR-DOC-2]** A rule document MUST contain `oar`, `id`, `kind`, `anchor`, and `effect`.
  An engine MUST reject a document missing any of them.
- **[OAR-DOC-3]** `oar` is the format marker and version, a string of the form
  `<major>.<minor>`, each part a decimal integer with no leading zero. Its presence
  identifies the document as an OAR rule. `"01.0"` is not a version, and an engine MUST
  reject it as it rejects any document failing schema validation (`[OAR-CONF-1]`) — two
  engines free to disagree about whether `"01.0"` equals `"1.0"` would disagree about which
  documents load.
- **[OAR-DOC-4]** An engine MUST reject a document whose `oar` major version it does not
  support, and MUST NOT silently downgrade or coerce it.
- **[OAR-DOC-5]** An engine MUST reject a document whose `oar` minor version is greater than
  the highest minor of that major it implements. An engine MUST accept every minor less than
  or equal to its own.

  This is a deliberate divergence from the usual forward-compatibility advice. Protocol
  Buffers dropped unknown fields in proto3 and reversed the decision in v3.5 precisely
  because discarding data a newer peer sent broke forward compatibility; JSON Schema treats
  unrecognised keywords as annotations by default. Both are right for their problem, which is
  carrying data across versions. This format's problem is different: a rule is a conjunction,
  and a field added in a later minor may *narrow* it. An engine that loads such a rule while
  ignoring the narrowing field does not carry less data — it enforces a policy the author
  never wrote, and does so silently. Refusing to load is the only failure mode an operator
  can see. The cost is that a document cannot target a fleet of mixed minors, which
  `[OAR-VER-4]` makes explicit.
- **[OAR-DOC-6]** `id` is a stable identifier matching `^[A-Z][A-Z0-9_]*$`. It MUST NOT be
  reused for a rule with a different meaning once published.
- **[OAR-DOC-7]** `namespace` is an optional publisher scope matching
  `^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$`. It identifies the
  organisation publishing the rule. An absent `namespace` means the loading host's own scope.
- **[OAR-DOC-8]** The identity of a rule is the pair (`namespace`, `id`), written
  `<namespace>/<id>` and called the *qualified identifier*. When `namespace` is absent the
  qualified identifier is the bare `id`, with no separator and no substituted host name — the
  qualified identifier feeds evaluation order, the trace, and every fixture assertion, so it
  MUST be derivable from the document alone and MUST NOT vary with the host that loaded it. Two documents sharing an `id`
  under different namespaces are distinct rules and MUST both load.
- **[OAR-DOC-9]** An engine MUST reject a rule set containing two rules with the same
  qualified identifier.
- **[OAR-DOC-10]** `kind` MUST be one of `schema`, `policy`, `invariant`, `detector`. It
  fixes evaluation order and nothing else — see `[OAR-EVAL-2]`.
- **[OAR-DOC-11]** `effect` MUST be one of `block`, `warn`, `nudge`, `allow`, `transform`.
- **[OAR-DOC-12]** `anchor` MUST name exactly one lifecycle moment. An engine MUST reject a
  document whose `anchor` it cannot resolve, naming the value.
- **[OAR-DOC-13]** `selector` is an optional object narrowing the rule to a subset of the
  occurrences of its anchor (section 3). When absent it imposes no constraint.
- **[OAR-DOC-14]** `when` is an optional condition expression in the language of Appendix A,
  evaluated over the declared fact environment (section 5). When absent, the rule's condition
  is satisfied.
- **[OAR-DOC-15]** `flow` is an optional ordered list of step names, and when present it
  MUST be non-empty. When present, the rule fires only if `flow` matches the recent activity
  window as described in `[OAR-FACT-12]`. An empty list is rejected rather than assigned a
  meaning: a vacuous match and an impossible match are both defensible readings, and a field
  with two defensible readings does not load.
- **[OAR-DOC-16]** `enforcement` is optional, one of `enforce`, `monitor`, `off`. Its default
  MUST be `enforce`.
- **[OAR-DOC-17]** `mandatory` is an optional boolean. Its default MUST be `false`.
- **[OAR-DOC-18]** `on_error` is optional. Its value MUST be `fail_closed`, `fail_open`, or a
  qualified or bare rule identifier to substitute. Its default MUST be `fail_closed`.
- **[OAR-DOC-19]** `on_fire` is an optional list of declared engine side-effects drawn from
  the closed vocabulary in section 6. Its default MUST be the empty list.
- **[OAR-DOC-20]** `overrides` is an optional list of qualified or bare rule identifiers this
  rule suppresses when it fires (section 4.1). Its default MUST be the empty list.
- **[OAR-DOC-21]** `requires` is an optional object with optional members `profiles` (a list
  of capability profile names) and `facts` (a list of fact or function names). It declares
  what the rule needs from the host (section 5.1).
- **[OAR-DOC-22]** `transform` is an object describing a content mutation. A document with
  `effect: transform` MUST carry it; a document with any other `effect` MUST NOT (section
  7.2).
- **[OAR-DOC-23]** `detector` is an object carrying a `ref`. A document with `kind: detector`
  MUST carry it; a document with any other `kind` MUST NOT.
- **[OAR-DOC-24]** `copy` is an optional object carrying presentation text. Its members are
  the closed set `title`, `what`, `cause`, `why`, `fix`, `instead`, each an optional string
  that MAY contain the bindings of Appendix C. A member of `copy` MUST NOT affect selection,
  evaluation, ordering, precedence, or the returned decision. Two rules differing only in
  `copy` MUST produce identical decisions.
- **[OAR-DOC-25]** `references` is an optional object of interoperability taxonomy tags. It
  MUST NOT affect any decision.
- **[OAR-DOC-29]** `status` is optional, one of `experimental`, `test`, `stable`,
  `deprecated`. Its default MUST be `stable`. It records the author's confidence in the rule
  and MUST NOT affect any decision. An operator, not the format, decides what to do with a
  rule that is not yet stable — the mechanism for acting on that decision is `enforcement`
  and the configuration document of section 9.
- **[OAR-DOC-30]** `related` is an optional list of objects, each carrying `id` (a qualified
  or bare rule identifier) and `type`, one of `derived`, `obsolete`, `merged`, `renamed`,
  `similar`. It records rule lineage so a retired identifier stays traceable to the rule that
  replaced it. It MUST NOT affect any decision, and an engine MUST NOT require a `related`
  target to be loaded.
- **[OAR-DOC-26]** A document MAY carry implementation extension fields whose names match
  `^x-[a-z0-9]+(-[a-z0-9]+)*$`. An engine MUST ignore an `x-` field it does not recognise. An
  `x-` field MUST NOT become normative without a specification change, and MUST NOT affect
  selection, evaluation, ordering, precedence, or the returned decision.
- **[OAR-DOC-27]** An engine MUST reject a document carrying any field this specification does
  not define and that is not an `x-` extension, naming the field. A typo that silently does
  nothing is how a rule becomes a placebo.
- **[OAR-DOC-28]** The `id` of a rule MUST NOT be required to correspond to any storage
  location. An implementation storing rules one per file SHOULD name the file after the `id`,
  but an engine MUST NOT derive identity, ordering, or precedence from a file name or path.
- **[OAR-DOC-31]** A *rule set* is a collection of rule documents. An engine MAY accept a rule
  set as a JSON array of rule documents, and MAY accept a multi-document YAML stream in which
  each document is a rule. An engine accepting either MUST treat every member as an
  independent document, validating and rejecting each on its own terms, and MUST NOT let one
  member's position in the collection affect its identity, ordering, or precedence
  (`[OAR-EVAL-1]` orders by `kind` and qualified identifier alone). An engine MUST reject a
  collection containing a member that is not a rule document.
- **[OAR-DOC-32]** `counter_scope` is an optional string naming the declared fact whose value
  keys this rule's counters (`[OAR-FIRE-10]`). When absent, the rule's counters are keyed by
  the rule and the session alone.

### 2.1 Example (non-normative)

```json
{
  "oar": "1.0",
  "id": "READ_OUTSIDE_SCOPE",
  "namespace": "acme.security",
  "kind": "policy",
  "anchor": "tool.pre_invoke",
  "selector": { "tool": ["read"] },
  "requires": { "profiles": ["tool", "filesystem"] },
  "when": "path_outside_scope(\"read\")",
  "effect": "block",
  "on_error": "fail_closed",
  "copy": {
    "what": "The call reads outside the declared scope.",
    "fix": "Read inside scope, or widen the scope deliberately."
  }
}
```

---

## 3. Anchors and selection

An **anchor** names a lifecycle moment at which an engine evaluates rules. A **selector**
narrows a rule to a subset of the occurrences of that moment.

- **[OAR-SEL-1]** A selector clause is named by a fact (section 5). The clause value is a
  list of strings, and the clause matches when the value of the fact it names is a member of
  that list.
- **[OAR-SEL-2]** A selector clause naming a fact of type `list<string>` matches when at
  least one member of the fact's value appears in the clause's list.
- **[OAR-SEL-3]** An engine MUST reject at load a selector clause naming a fact the engine
  does not declare, or naming a fact whose type is neither `string` nor `list<string>`,
  naming the clause. A clause that cannot be evaluated is a load error, never a silent match
  and never a silent non-match.
- **[OAR-SEL-4]** Selector clauses are conjunctive: a rule is selected only when *every*
  clause present in its selector matches.
- **[OAR-SEL-5]** An omitted clause is permissive — it imposes no constraint. An empty
  selector, and an absent selector, therefore match every occurrence of the anchor.
- **[OAR-SEL-6]** A clause whose value is the empty list matches nothing, and so a rule
  carrying one is never selected. An engine MUST load such a rule and SHOULD warn.
- **[OAR-SEL-7]** At an anchor occurrence, an engine MUST select exactly those rules whose
  resolved `anchor` equals that anchor, whose `enforcement` is not `off`, and whose selector
  clauses all match.
- **[OAR-SEL-8]** Selection matches typed machine-observable facts only. Because a clause can
  only name a declared fact, and every fact is typed and machine-produced (`[OAR-FACT-1]`),
  an engine cannot match a selector against natural-language text, and MUST NOT infer a
  clause value from prose shape, keyword lists, or substring search.
- **[OAR-SEL-9]** A selector clause naming a fact outside the `core` tier makes the rule
  non-portable in exactly the way a condition referencing that fact would — see
  `[OAR-PROF-6]`.

Selection is deliberately a special case of the fact environment rather than a second
vocabulary. A fixed selector schema would leave clauses without a declared type or observation
meaning and could let an engine silently ignore a scope it does not model. Deriving clauses
from declared facts makes every selector typed and turns an unavailable observation into a
load error.

---

## 4. Evaluation

- **[OAR-EVAL-1]** An engine MUST evaluate selected rules in a deterministic order: ascending
  by `kind` in the sequence `schema`, `policy`, `invariant`, `detector`, then ascending
  lexicographically by qualified identifier, compared by Unicode code point — amended, when a
  selected rule's `overrides` names another selected rule, exactly as `[OAR-EVAL-18]` directs,
  so that a suppressor is evaluated before each rule it names. `[OAR-EVAL-18]` moves a
  suppressor no earlier than that: a rule that suppresses nothing selected keeps its
  kind-then-identifier place, even when a suppressor of a different `kind` sorts after it.
- **[OAR-EVAL-2]** `kind` carries no evaluation meaning beyond that order. An engine MUST
  NOT derive a threshold, a weight, or a decision from `kind`, and this specification does
  not define a separate priority field.
- **[OAR-EVAL-3]** A rule *fires* when it is selected, its `flow` matches if present, and its
  condition is satisfied. A rule with neither `when` nor `flow` fires whenever it is selected.
  An engine MUST test `flow` before evaluating `when`, and MUST NOT evaluate `when` when
  `flow` did not match. The order is observable, because `when` can raise and `flow` cannot:
  were `when` evaluated first, a rule excluded by its `flow` could still take the occurrence
  down its `on_error` path.
- **[OAR-EVAL-4]** The first rule that fires with effect `block`, and whose `enforcement` is
  `enforce`, MUST short-circuit the anchor occurrence: no later rule in the order is
  evaluated.
- **[OAR-EVAL-5]** A rule firing with effect `transform` MUST NOT short-circuit the
  occurrence. Transforms accumulate — see section 7.2.
- **[OAR-EVAL-6]** An engine MUST resolve the decision for an anchor occurrence by
  precedence: if any enforced rule fired with `block`, the decision is `block`; otherwise if
  any fired with `transform`, the decision is `transform`; otherwise if any fired with
  `nudge`, the decision is `nudge`; otherwise if any fired with `warn`, the decision is
  `warn`; otherwise the occurrence is allowed and the decision is `none`.

  The order is by how much the effect changes what happens next, most first. `block` stops the
  occurrence and `transform` alters what it carries, so both outrank anything advisory.
  `nudge` outranks `warn` because a nudge is addressed to the agent and is meant to change the
  next step it takes, while a warning is addressed to the operator reading the trace: where
  both fired, reporting the warning would drop the one effect of the two that was going to
  alter the run. Precedence picks the *effect*. It does not pick a single advisory: when the
  effect is `nudge` or `warn`, every enforced rule that fired with that effect is part of the
  decision (`[OAR-EVAL-20]`). Rendered `copy` is presentation of that decision, never an input
  to it (`[OAR-COPY-6]`).
- **[OAR-EVAL-7]** A rule firing with `allow` contributes no decision. It records an explicit
  pass and MUST NOT override a `block`, `transform`, `nudge`, or `warn` from another rule.
- **[OAR-EVAL-8]** A decision MUST carry the effect, the bare `id` of the rule that produced
  it, and that rule's qualified identifier. It MUST carry the accumulated transform list when
  the effect is `transform`. It MUST carry the accumulated advisory list when the effect is
  `nudge` or `warn` (`[OAR-EVAL-20]`). It MUST carry the rendered `copy` of that rule
  (`[OAR-COPY-7]`). It MAY carry a data map for host presentation beyond that copy, and the
  list of side-effects that were applied.
- **[OAR-EVAL-9]** The bare `id` a decision carries is the identifier intended for display
  and for coarse routing. Software that must distinguish two publishers' rules MUST branch on
  the qualified identifier. Software consuming a decision MUST NOT branch on any
  human-readable message text.
- **[OAR-EVAL-19]** When more than one enforced rule fired with the effect the decision
  resolved to under `[OAR-EVAL-6]`, the decision MUST carry the identifiers of the first such
  rule in the evaluation order of `[OAR-EVAL-1]`. The trace records every firing; the decision
  names one rule, and which one is part of the format — a consumer branches on the qualified
  identifier (`[OAR-EVAL-9]`), so two engines free to name different winners would route the
  same occurrence differently while reporting the same effect. When that effect is `nudge` or
  `warn`, the other firings are not discarded: they are the rest of `advisories`
  (`[OAR-EVAL-20]`).
- **[OAR-EVAL-20]** When the decision is `nudge` or `warn`, the decision MUST carry
  `advisories`: every enforced rule that fired with that effect, in the evaluation order of
  `[OAR-EVAL-1]`, each with its bare `id`, its qualified identifier, and its rendered `copy`
  (`[OAR-COPY-9]`). An engine MUST NOT drop, merge, or reorder them. A rule that was
  suppressed, whose `enforcement` is `monitor`, or that fired with a different effect MUST
  NOT appear. When the decision is `block`, `transform`, or `none`, `advisories` is empty.

  Several independent steers can hold of one occurrence — a spend ceiling and an ungrounded
  claim, two warnings an operator should both see. Naming one and discarding the rest is the
  same bug `[OAR-OPS-15]` closed for transforms. The decision still names one rule
  (`[OAR-EVAL-19]`), so a consumer that branches on a single identifier has a deterministic
  primary; the list is what is presented.
- **[OAR-EVAL-10]** A rule whose `enforcement` is `monitor` MUST be evaluated and recorded,
  and MUST NOT contribute a decision, apply a side-effect, suppress another rule, or
  short-circuit the occurrence. This holds even when the rule cannot be evaluated: a
  `monitor` rule that raises is recorded `monitored_errored` (`[OAR-OPS-9]`) and its
  `on_error` is NOT applied. Were
  `fail_closed` to survive monitor mode, the rollout path for an unproven rule could block
  production traffic, which is the one thing monitor mode exists to prevent.
- **[OAR-EVAL-11]** A rule whose `enforcement` is `off` MUST NOT be selected, evaluated, or
  recorded in the trace. It remains loaded, so a load-time error in it is still reported.
- **[OAR-EVAL-12]** An engine MUST apply the `on_fire` side-effects of every rule that fired
  and whose `enforcement` is `enforce`, including rules whose effect lost precedence under
  `[OAR-EVAL-6]`. Side-effects of rules never reached because of a short-circuit, and of
  rules suppressed under `[OAR-EVAL-14]`, MUST NOT be applied.

### 4.1 Suppression

Two rules frequently disagree about which of them should speak: a specific rule and the
general rule it refines both fire, and the author wants only the specific one to be heard.
Without a mechanism for saying so, authors encode the exclusion by hand, negating a sibling
rule's whole condition inside their own — which silently breaks the moment either rule
changes.

- **[OAR-EVAL-13]** `overrides` lists the rules a rule suppresses. Each entry is a qualified
  identifier, or a bare `id` resolved within the suppressing rule's own namespace. An engine
  MUST reject at load an `overrides` entry that resolves to no loaded rule, naming it.
- **[OAR-EVAL-14]** When a rule fires and its `enforcement` is `enforce`, every rule it names
  in `overrides` MUST be suppressed for that anchor occurrence: it contributes no decision,
  applies no side-effect, and is recorded with the outcome `suppressed`. A rule already
  evaluated when the suppressing rule fires MUST have its contribution withdrawn.
- **[OAR-EVAL-15]** Suppression does not transit. If A overrides B and B overrides C, A
  firing suppresses B but does not suppress C. An engine MUST NOT compute a transitive
  closure.
- **[OAR-EVAL-16]** An engine MUST reject at load a rule set in which `overrides` forms a
  cycle, naming the rules in it.
- **[OAR-EVAL-17]** A rule whose `mandatory` is `true` MUST NOT be suppressed. An engine MUST
  reject at load an `overrides` entry naming a mandatory rule.
- **[OAR-EVAL-18]** At an occurrence, an engine MUST evaluate every selected rule whose
  `overrides` names another selected rule before it evaluates any rule so named. Because
  `[OAR-EVAL-16]` rejects suppression cycles, such an order always exists, and an engine MUST
  select it by this algorithm, so that two engines produce the same order rather than two
  different valid ones: while any selected rule remains unevaluated, evaluate the rule that
  comes first under `[OAR-EVAL-1]`'s `kind`-then-identifier ordering among those none of whose
  remaining suppressors is still unevaluated.

  Stating the algorithm rather than a preference ensures independent implementations produce
  the same trace for the same rule set. A qualitative ordering rule would permit multiple
  interpretations.

  Without this rule, suppression would silently depend on identifier order: a rule firing
  with `block` short-circuits the occurrence (`[OAR-EVAL-4]`), so a rule that sorted after it
  would never be evaluated and its `overrides` would never be honoured. Renaming a rule would
  then change which of two rules won. Ordering suppressors first makes `overrides` mean the
  same thing wherever the rules happen to sort.

---

## 5. Facts and conditions

- **[OAR-FACT-1]** The fact environment is *closed* and *typed*: an engine MUST declare the
  complete set of fact names, each with a type, before any rule is compiled.
- **[OAR-FACT-2]** Fact names and observation function names share a single namespace. An
  engine MUST NOT declare a fact and a function under the same name. A condition language
  that distinguishes them syntactically is not sufficient, because an engine may be hosted in
  a language that does not.
- **[OAR-FACT-3]** An engine MUST reject at load a rule whose condition references an
  identifier that is not a declared fact or a declared observation function, naming the
  identifier. A mistyped fact name is a load failure, never a runtime default.
- **[OAR-FACT-4]** An engine MUST reject at load a rule whose condition is not type-correct
  against the declared environment, and MUST reject a condition whose result type is not
  boolean. A rejection for a non-boolean result MUST name the type the condition produced and
  the word `bool`, so the author can see what the expression actually is.
- **[OAR-FACT-5]** A fact is an *observation*, never a *verdict*. A fact provider MUST NOT
  publish a value that encodes the conclusion of a rule that reads it.
- **[OAR-FACT-6]** A fact MAY report the outcome of a layer of the host that is not the rule
  engine — an authorisation check, a path sandbox, a schema validator. Such a value is an
  observation of that layer, and `[OAR-FACT-5]` does not forbid it. What `[OAR-FACT-5]`
  forbids is a fact that exists to carry one rule's own conclusion to that same rule.
- **[OAR-FACT-7]** A fact MUST NOT bake in a threshold, and MUST NOT combine other facts in
  a policy-meaningful way. The threshold and the composition are the policy, and they belong
  in the rule where a reviewer can read and change them.
- **[OAR-FACT-8]** An engine MUST render effects only from the rule's declared `effect`,
  `transform`, and `on_fire`. A fact provider or a detector MUST NOT render an effect.
- **[OAR-FACT-9]** An engine MAY declare parameterized *observation functions* alongside
  plain facts, for observations that are only meaningful with an argument. An observation
  function MUST obey `[OAR-FACT-5]` and `[OAR-FACT-7]` exactly as a fact does.
- **[OAR-FACT-10]** Condition evaluation MUST be free of side-effects: a condition MUST NOT
  mutate state and MUST NOT perform input or output. Every state change an engine performs
  is declared by `on_fire`.
- **[OAR-FACT-11]** A fact whose production is expensive, asynchronous, or probabilistic —
  notably a detector-supplied fact — MUST be assembled lazily: an engine MUST NOT produce it
  unless a selected rule references it. A rule *references* a fact from its `when`, from a
  selector clause, from `counter_scope`, from a `transform` `target`, and from a `copy`
  binding or conditional (`[OAR-COPY-5]`). A transform target and a copy binding are easy to
  miss, because neither is part of deciding whether the rule fires — an engine that omits the
  target produces a transform that rewrites nothing and reports success, and an engine that
  omits the binding renders a zero where the author named an observation. Observations a
  detector produces for one rule MUST remain local to that rule's evaluation; they MUST NOT
  become occurrence facts visible to a later rule unless that later rule's own provider
  produces them.
- **[OAR-FACT-12]** `flow` matches when its steps appear, in order, as a subsequence of the
  recent activity window. The window is ordered oldest step first, so `flow` reads in the
  order the steps happened; an engine MUST present it that way. The subsequence need not be
  contiguous. An engine MUST declare the
  size of that window in its profile (`[OAR-PROF-3]`).
- **[OAR-FACT-13]** A rule carrying `flow` is portable only between engines declaring the
  same activity window size. An engine MUST reject at load a rule carrying `flow` when its
  own declared window is smaller than the rule's `flow` length.

### 5.1 Capability profiles

An engine does not implement every observation, and this specification does not pretend
otherwise. A **capability profile** is a named, versioned bundle of facts and functions. An
engine declares the profiles it provides; a rule declares the profiles it needs; the engine
refuses at load any rule it cannot serve. This is capability negotiation. A mandatory
universal catalogue would instead require a host without a file system to publish an
`is_directory` value that has no observation behind it.

- **[OAR-FACT-14]** Every fact and function an engine declares MUST belong to exactly one
  profile, or to the `core` tier, or to the engine's own `host` tier.
- **[OAR-FACT-15]** A conforming engine MUST provide every `core` fact, with the name, type,
  and observation meaning given in section 5.3. The `core` tier is deliberately small: it
  contains only what is meaningful at every anchor of every host.
- **[OAR-FACT-16]** An engine claiming a profile MUST provide every fact and function in that
  profile with the declared name, type, and meaning. A profile is provided whole or not at
  all; an engine MUST NOT declare a subset of one.
- **[OAR-FACT-17]** An engine MUST NOT declare a fact or function under a name belonging to a
  profile it does not claim, and MUST NOT redefine the name, type, or meaning of a `core` or
  profile-tier fact.
- **[OAR-FACT-18]** An engine MUST publish each `host`-tier fact under a namespace it owns,
  written `<host>.<fact>`, where `<host>` matches the `namespace` grammar of `[OAR-DOC-7]`.
  Two engines therefore cannot collide on a bare name.
- **[OAR-FACT-19]** An engine MUST reject at load a rule naming in `requires.profiles` a
  profile it does not provide, or naming in `requires.facts` a fact or function it does not
  provide, naming both the rule and the missing capability.
- **[OAR-FACT-20]** An engine MUST reject at load a rule whose condition, selector, `counter_scope`, `transform.target`, or
  `copy` references a fact outside the `core` tier that the rule does not reach through
  `requires`. Declaring the dependency is what makes a rule's portability computable from the
  document alone, without consulting an engine.
- **[OAR-FACT-21]** An engine MUST publish a machine-readable *capability document* declaring
  all of: its anchor profile map (`[OAR-PROF-2]`), its host-native anchor catalogue
  (`[OAR-PROF-5]`), the profiles it provides, every `host`-tier
  fact with its type, its activity window size (`[OAR-PROF-3]`), the detector references it
  resolves (`[OAR-OPS-12]`), whether it implements content mutation — written
  `supports_transform` — and its condition parse-tree limit, written `expression_nodes_max`
  (`[OAR-EXPR-17]`). A rule author, and a conformance runner, can then determine what will
  load before attempting it. Every one of those is something a rule can be rejected for, so a
  capability document omitting one would leave a load failure that the document cannot predict
  — which is the single thing it exists to make predictable.
- **[OAR-FACT-24]** An engine MUST validate its own capability document before loading any
  rule, and MUST refuse to start when it is invalid — when a fact it declares violates
  `[OAR-FACT-18]` or `[OAR-FACT-22]`, when it claims a profile it does not provide whole, or
  when its anchor map violates `[OAR-PROF-2]`. Every requirement this specification places on
  what a host declares is a requirement the engine enforces against itself; none of them is
  advice to the host's authors. An engine that trusts its own configuration unchecked will
  accept rules against a vocabulary it does not actually provide, and the failure will surface
  as a wrong decision at run time rather than as a refusal to start.

- **[OAR-FACT-25]** A fact an engine declares MUST have a value at every occurrence of every
  anchor at which a rule may reference it. Where the host has nothing to report, the engine
  MUST supply the zero value of the fact's type — `false`, `0`, `0.0`, the empty string, or
  the empty list or map — and MUST NOT treat the absence as a fact-provider failure. The
  profile tables are written to suit this: `arg_validation_errors` is "empty when the
  arguments validated", `mcp_call_ok` is "false before the call". An engine that instead
  raised would send most rules down their `on_error` path at the very occurrences where they
  have nothing to say, which for the default `fail_closed` would block almost everything.

- **[OAR-FACT-26]** Every produced value, including an observation function result,
  MUST be checked against its declared type before a condition, selector, copy,
  counter scope, or transform consumes it. A wrong runtime type is a fact-provider
  failure handled by the consuming rule's `on_error`; it is not a static rule type
  error and MUST NOT panic, silently coerce to another type, or become a zero.
  Absence, explicit provider failure, and undeclared names are distinct cases.
- **[OAR-FACT-27]** Every fact and observation function in `host_facts` MUST occupy
  exactly one entry in the shared symbol environment. A scalar or aggregate `type`
  declares a fact; a signature `(argument_type) -> result_type` declares a function
  with one argument and result, each one of `bool`, `int`, `double`, or `string`.
  Selectors, copy, counter scopes, and transform targets cannot name a function.
  The same environment MUST govern every load-time rule-field check.
- **[OAR-FACT-28]** `tool_args_fingerprint` MUST be the lowercase hexadecimal SHA-256
  digest of the UTF-8 bytes of `oar-tool-1.0` followed by U+0000 and the canonical
  JSON array `[tool, tool_args]`. Canonical JSON has no insignificant whitespace;
  object keys sort lexicographically by Unicode code point; strings emit Unicode
  directly, escaping only quotation mark, backslash, and U+0000 through U+001F
  (the latter as lowercase `\u00xx`); numbers use [OAR-COPY-10]'s decimal form.
  Arrays retain their order. Numbers are finite binary64; an integer supplied by
  a host MUST convert to binary64 without losing its integer value, otherwise
  fingerprint production is a fact-provider failure. An absent tool call has an
  empty fingerprint. The tool name is part of the digest, so identical arguments
  to different tools have different fingerprints.

### 5.2 Fact types

- **[OAR-FACT-22]** A fact's type MUST be one of `bool`, `int`, `double`, `string`,
  `list<string>`, `map<string,string>`, `list<map>`, or `map`. An engine MUST NOT declare a
  fact of any other type.
- **[OAR-FACT-23]** `int` is a 64-bit signed integer. `double` is a *finite* IEEE 754
  binary64: a fact provider MUST NOT publish NaN or an infinity, and an engine MUST treat a
  non-finite `double` from a fact provider as a fact-provider failure (`[OAR-OPS-3]`) — every
  comparison against NaN is false, so a NaN that reached a condition would make a threshold
  rule silently never fire, in whichever direction the author wrote it.
  `string` is a sequence of Unicode code points. An engine MUST NOT silently truncate or
  coerce between them; see Appendix A for the promotion rules the condition language applies.

### 5.3 Core facts

Every conforming engine provides these. They are the observations that exist at every anchor
of every host: the moment itself, and the engine's own counters.

<!-- oar:table core -->
| Name | Type | Observation |
|------|------|-------------|
| `anchor` | `string` | The identifier of the occurrence being evaluated: the core anchor identifier when the occurrence implements one, and the host-native identifier otherwise. It is a property of the occurrence, so every rule evaluated at one observes the same value. |
| `fire_count` | `int` | How many times `increment_counter` has been applied for this rule in this session, before the current occurrence, less any `reset_counter`. It counts declared increments, not firings: a rule that fires at every occurrence and declares no `on_fire` has a `fire_count` of zero. |
| `breaker_count` | `int` | How many times a circuit breaker has been incremented for this rule and session, before the current occurrence. Maintained by `increment_breaker` and `reset_breaker`. |
| `fire_count_of` | `(string) -> int` | The `fire_count` of the rule the argument names, read under that rule's own counter scope at this occurrence. The argument is a string literal naming a loaded rule, bare or qualified. |
| `breaker_count_of` | `(string) -> int` | The `breaker_count` of the rule the argument names, read under that rule's own counter scope at this occurrence. The argument is a string literal naming a loaded rule, bare or qualified. |
<!-- /oar:table -->

### 5.4 Standard profiles

<!-- oar:table profiles -->
**Profile `tool`** — a host that dispatches named tool calls with structured arguments.

| Name | Type | Observation |
|------|------|-------------|
| `tool` | `string` | The name of the tool being invoked at this anchor occurrence. |
| `tool_args` | `map` | The arguments the tool was called with. |
| `tool_args_fingerprint` | `string` | A stable digest of the tool name and arguments, for identifying a repeat of the same call. |
| `arg_validation_errors` | `list<string>` | Machine codes for argument checks that did not pass. Empty when the arguments validated. |
| `arg_validation_reason` | `string` | Human-facing reason the argument check failed. Empty when the arguments validated. |
| `arg_validation_field` | `string` | The argument name the failed check named. Empty when the arguments validated or the check named no field. |
| `permission_profile` | `string` | The permission profile in force for this call. |
| `policy_denied` | `bool` | True when the host's own authorisation layer refused the call. |
| `tool_arg_string` | `(string) -> string` | The named tool argument as a string; empty when absent or not a string. |
| `tool_arg_int` | `(string) -> int` | The named tool argument as an integer; zero when absent or not an integer. |
| `tool_arg_bool` | `(string) -> bool` | The named tool argument as a boolean; false when absent or not a boolean. |

**Profile `session`** — a host with a durable session and an identifiable caller.

| Name | Type | Observation |
|------|------|-------------|
| `session_posture` | `string` | The session's declared posture. |
| `principal` | `string` | The identity on whose behalf the call is made. |
| `principal_roles` | `list<string>` | Roles attributed to the principal by the host. |

**Profile `filesystem`** — a host whose tools address a file system.

| Name | Type | Observation |
|------|------|-------------|
| `is_directory` | `bool` | True when a path argument resolved to a directory. |
| `not_found` | `bool` | True when a path or artifact the call names does not exist. |
| `path_denied` | `bool` | True when a path argument resolved to a location the host's path sandbox refuses. |
| `path_outside_scope` | `(string) -> bool` | True when the named tool's path arguments resolve outside the scope in force for that tool. |

**Profile `content-provenance`** — a host that preserves structured content segments and their provenance.

| Name | Type | Observation |
|------|------|-------------|
| `content_roles` | `list<string>` | Transport-independent roles for the content segments, in segment order: system, developer, user, assistant, tool, or unknown. |
| `content_origins` | `list<string>` | Host-attributed origins for the content segments, in segment order: host, user, model, tool, peer, resource, retrieval, or unknown. |
| `content_authorities` | `list<string>` | Instruction authority attributed by the host to each content segment, in segment order: system, developer, user, delegated, none, or unknown. |
| `content_trust_tiers` | `list<string>` | Host trust classification for each content segment, in segment order: trusted, untrusted, or unknown. Trust does not itself grant instruction authority. |
| `content_sources` | `list<string>` | Host-defined source identifier for each content segment, in segment order; empty when a segment has no source identifier. |
| `content_segment_count` | `int` | Number of structured content segments at this occurrence; equal to the length of every aligned content provenance list. |
| `content_contains_untrusted` | `bool` | True when content_trust_tiers contains untrusted. |

**Profile `content`** — a host that supplies content measurements.

| Name | Type | Observation |
|------|------|-------------|
| `content_length` | `int` | Length in Unicode code points of the content at this anchor. |

**Profile `secrets`** — a host that submits content to a registered secret detector.

| Name | Type | Observation |
|------|------|-------------|
| `secret_matches` | `list<map>` | Credential or secret spans a registered detector reported. Empty when no detector ran. |

**Profile `pii`** — a host that submits content to a registered personal-data detector.

| Name | Type | Observation |
|------|------|-------------|
| `pii_entities` | `list<map>` | Personal-data spans a registered detector reported. Empty when no detector ran. |

**Profile `prompt-injection`** — a host that submits content to a registered injection detector.

| Name | Type | Observation |
|------|------|-------------|
| `prompt_injection_score` | `double` | Injection likelihood from a registered detector, between 0 and 1. |

**Profile `jailbreak`** — a host that submits content to a registered jailbreak detector.

| Name | Type | Observation |
|------|------|-------------|
| `jailbreak_score` | `double` | Jailbreak likelihood from a registered detector, between 0 and 1. |

**Profile `moderation`** — a host that submits content to a classifier scoring it against named categories.

| Name | Type | Observation |
|------|------|-------------|
| `moderation_categories` | `list<string>` | The category names a registered classifier returned a score for. Empty when no classifier ran. |
| `moderation_score` | `(string) -> double` | The score a registered classifier reported for the named category, between 0 and 1; zero when that category was not scored. |

**Profile `mcp`** — a host bridging Model Context Protocol providers.

| Name | Type | Observation |
|------|------|-------------|
| `mcp_provider_id` | `string` | The catalogue provider id for this call, or empty when the call is not a bridged tool call. |
| `mcp_tool_name` | `string` | The unqualified tool name on the bridged server. |
| `mcp_qualified_tool` | `string` | The host-side name of the bridged tool. |
| `mcp_provider_configured` | `bool` | True when the catalogue contains the provider this call is bound to. |
| `mcp_provider_enabled` | `bool` | True when the provider this call is bound to is configured and enabled. |
| `mcp_call_ok` | `bool` | True after a bridged call that returned without error. False before the call. |
| `mcp_error_code` | `string` | The machine error code a failed bridged call reported, never free text. |
| `mcp_schema_matched` | `bool` | True when at least one declared result schema validated the call's result. |
| `mcp_provider_configured_for` | `(string) -> bool` | True when the catalogue contains the given provider id. |
| `mcp_provider_enabled_for` | `(string) -> bool` | True when the given provider is configured and enabled. |
| `mcp_has_field` | `(string) -> bool` | True when the projected result carries the given key. |
| `mcp_field_bool` | `(string) -> bool` | The projected boolean at the given key; false when absent or wrongly typed. |
| `mcp_field_string` | `(string) -> string` | The projected string at the given key; empty when absent. |
| `mcp_field_int` | `(string) -> int` | The projected integer at the given key; zero when absent. |
<!-- /oar:table -->

The `content-provenance` profile describes the host's structured occurrence envelope, not
claims made by the content. Text that calls itself `system`, `trusted`, or any other profile
value does not change these facts. The five list facts are parallel: index *i* describes the
same segment in each list, and their lengths equal `content_segment_count`. An occurrence
with no content segments supplies empty lists, a count of zero, and
`content_contains_untrusted: false` under `[OAR-FACT-25]`. These observations do not
authenticate content or grant authority; they let rules reason over authority the host has
already assigned from structure and host state.

The `mcp` profile's parameterized forms carry the `_for` suffix because `[OAR-FACT-2]`
forbids a fact and a function sharing a name. The suffix keeps
`mcp_provider_configured` and `mcp_provider_configured_for` distinct in the condition
language's single namespace.

---

## 6. Stateful effects

- **[OAR-FIRE-1]** `on_fire` draws from a closed vocabulary: `increment_counter`,
  `reset_counter`, `publish_event`, `increment_breaker`, `reset_breaker`. An engine MUST
  reject a document naming any other side-effect.
- **[OAR-FIRE-2]** An engine MUST apply a rule's `on_fire` actions only when that rule fired
  and its `enforcement` is `enforce`.
- **[OAR-FIRE-3]** Each counter action is bound to exactly one core fact, and an engine MUST
  maintain that binding: `increment_counter` and `reset_counter` write `fire_count`;
  `increment_breaker` and `reset_breaker` write `breaker_count`. A threshold on a counter is
  therefore written in the rule and not in the engine.
- **[OAR-FIRE-4]** `increment_counter` and `increment_breaker` add one. `reset_counter` and
  `reset_breaker` set the value to zero.
- **[OAR-FIRE-5]** A counter MUST be keyed by the qualified identifier of the rule declaring
  the action, by the session, and by the rule's *counter scope value* (`[OAR-FIRE-10]`). An
  engine MAY expose additional counter scopes as `host`-tier facts.
- **[OAR-FIRE-10]** `counter_scope` is an optional rule field naming a declared fact of type
  `string`. A rule's counter scope value at an occurrence is the value of that fact. Whether a
  rule's counters are scoped is decided by whether the field is *present*, never by the value
  it happens to take: a rule declaring `counter_scope` keys its counters by the scope value
  even when that value is the empty string, and a rule declaring none keys by rule and session
  alone. The two are different counters. `[OAR-FACT-25]` makes an unpublished string fact
  empty, so a rule scoped by `tool_args_fingerprint` has an empty scope at every anchor that
  publishes no tool call; were the empty value to collapse it into the unscoped counter, that
  rule's tally would silently merge with an unrelated one. An engine MUST reject at load a
  `counter_scope` naming a fact it does not declare, naming a fact whose type is not `string`,
  or naming a non-`core` fact the rule does not reach through `requires`, in each case naming
  the fact.

  Without a scope, a counter answers only *how often has this rule fired in this session*.
  The question a repeat-detection rule actually asks is *how often has this same call been
  made*, and the observation that identifies "the same call" — `tool_args_fingerprint` — is a
  fact. Naming it here keys the counter by it, and keeps the identity of what is being counted
  in the rule where a reviewer can read it, exactly as `[OAR-FACT-7]` keeps the threshold there.
- **[OAR-FIRE-11]** `fire_count_of` and `breaker_count_of` read the counters of *another* rule.
  Each takes one argument, which MUST be a string literal holding a qualified identifier, or a
  bare `id` resolved within the referencing rule's own namespace. An engine MUST reject at load
  an argument that is not a string literal, and one that resolves to no loaded rule, naming it.
  The counter read is the named rule's, under the named rule's own `counter_scope` evaluated at
  this occurrence, and it observes the same snapshot every other condition at the occurrence
  observes (`[OAR-FIRE-6]`). The target scope is an indirect fact dependency of
  the reader: its provider MUST be reached through the same typed, lazy fact
  mechanism even when the target rule is unselected. Its capability declaration
  belongs to the target rule. Reading the counter does not evaluate that rule.

  A rule cannot both count an occurrence and gate on the count it is keeping: `[OAR-FIRE-2]`
  applies `on_fire` only when the rule fires, and a rule whose condition demands a count it has
  not reached yet never fires, so it never counts, so it never fires. Escalation — warn at two,
  refuse at five — is therefore written as a rule that counts and separate rules that read the
  count. Requiring a literal argument is what lets the reference be resolved, and the
  suppression-cycle and unresolvable-reference errors reported, at load rather than at run time.
- **[OAR-FIRE-6]** Every condition evaluated during one anchor occurrence MUST observe the
  same counter values: those in force before any side-effect of that occurrence is applied.
  A rule's own increment therefore cannot change the value its own condition just read, and
  two rules at one occurrence cannot disagree about a counter's value.
- **[OAR-FIRE-7]** `publish_event` MUST emit one record to the host's event stream carrying, at
  minimum, the qualified identifier of the rule, the anchor, and the effect. It writes no
  fact and is not observable to any condition.
- **[OAR-FIRE-8]** An engine MUST apply the actions of one rule in the order they are listed,
  and MUST apply the actions of different rules in the evaluation order of `[OAR-EVAL-1]`.
- **[OAR-FIRE-9]** A declared side-effect is an obligation, not a hint. An engine that cannot
  apply an action a firing rule declared — a counter store that is unreachable, an event
  stream that refuses the write — MUST treat the rule as one that cannot be evaluated and
  handle it per its `on_error` (`[OAR-OPS-3]`). An engine MUST NOT report a decision as
  applied when a side-effect the rule declared was silently dropped, because an operator
  reading the decision would have no way to know the breaker never advanced.

---

## 7. Operational semantics

- **[OAR-OPS-1]** `enforcement: monitor` MUST evaluate the rule and record the outcome while
  producing no effect and applying no side-effect. It is the rollout path for a rule an
  operator is not yet ready to enforce.
- **[OAR-OPS-2]** `enforcement: off` MUST load the rule and evaluate nothing. It is the
  supported way to disable a rule without deleting it; an author MUST NOT be expected to
  express disablement as an unsatisfiable condition.
- **[OAR-OPS-3]** A rule *cannot be evaluated* in exactly these cases, and in no others: a
  fact provider fails; a detector fails or is unreachable; the condition raises at run time
  under `[OAR-EXPR-13]`, `[OAR-EXPR-14]`, or `[OAR-EXPR-15]`; or a declared side-effect
  cannot be applied (`[OAR-FIRE-9]`). `on_error` is
  the single sink for all of them, so an operator has one dial to reason about rather than
  one per failure class. Malformed documents, unknown identifiers, and type errors are *not*
  in this set: they are load-time rejections under `[OAR-CONF-1]` and `[OAR-CONF-5]`, and an
  engine MUST NOT route them through `on_error`. When a rule cannot be evaluated and its
  `on_error` is `fail_closed`, an engine MUST produce a `block` decision carrying that rule's
  identifiers, and MUST NOT continue evaluating later rules at the occurrence.
- **[OAR-OPS-4]** When a rule cannot be evaluated and its `on_error` is `fail_open`, an
  engine MUST record the failure and continue: the rule contributes no decision and no
  side-effect.
- **[OAR-OPS-5]** When a rule cannot be evaluated and its `on_error` names a rule identifier,
  an engine MUST produce a `block` decision carrying that substituted rule's identifiers
  instead of its own, and MUST NOT continue evaluating later rules at the occurrence. The
  substitution replaces the identifiers only; the effect is `block`. A bare identifier in
  `on_error` is resolved within the failing rule's own namespace, exactly as an `overrides`
  entry is (`[OAR-EVAL-13]`). An engine MUST reject at
  load an `on_error` naming a rule that is not loaded.

  Worked example. Rule `oar.test/A_DETECTOR` has `effect: warn` and
  `on_error: FALLBACK`. Rule `oar.test/FALLBACK` has `effect: nudge` and is loaded in the
  same set. When the detector fails, the occurrence's decision is `block` with
  `code: FALLBACK` and `rule: oar.test/FALLBACK` — not `warn`, not `nudge`, and not
  `A_DETECTOR`'s identifiers. The substituted rule need not itself be selected at this
  anchor: substitution is a reference into the loaded set, resolved at load
  (`[OAR-CONF-6]`), not a second evaluation of `FALLBACK`'s condition. The failing rule is
  still recorded in the applied-rules trace as `errored`; the substituted identifiers appear
  as `fired` on the `block` decision. See
  `ops-on-error-substitutes-another-rules-identifiers` in the conformance corpus.
- **[OAR-OPS-6]** A `block` produced under `[OAR-OPS-3]` or `[OAR-OPS-5]` takes precedence
  over any effect already recorded at that occurrence, as any `block` does under
  `[OAR-EVAL-6]`.
- **[OAR-OPS-7]** A rule with `mandatory: true` MUST NOT be disabled, downgraded, suppressed,
  or removed by a configuration document, a pack, or a caller. An engine MUST reject a
  configuration that attempts it, naming the rule. This protects the loaded rule
  set from overlays; it does not grant a publisher trust or prevent installation
  of a different base rule set. Pack precedence MUST NOT replace a document with
  the same qualified identity; duplicate identities are rejected under [OAR-DOC-9].
- **[OAR-OPS-8]** Evaluation of a content anchor is buffered: an engine evaluates the rule
  once, over the fully assembled content. No partial content may be shown to a
  person, consumed by a model, persisted as delivered content, or acted on before
  the decision and its transforms have been applied. Progress metadata that does
  not contain response content may be published during assembly.
- **[OAR-OPS-9]** An engine MUST record, per anchor occurrence, an applied-rules trace: for
  each selected rule, its qualified identifier and its outcome — one of `fired`, `passed`,
  `errored`, `suppressed`, `monitored_fired`, `monitored_passed`, or `monitored_errored`. The
  trace is how an operator audits a decision.

  Monitor mode gets three outcomes rather than one because the whole question it exists to
  answer is *would this rule have fired?* A single `monitored` outcome records that a rule was
  observed while discarding what was observed, which makes the trace useless for the one
  decision an operator uses it for: whether the rule is ready to enforce.
- **[OAR-OPS-10]** The trace MUST list rules in the evaluation order of `[OAR-EVAL-1]`, and
  MUST omit rules never reached because of a short-circuit — except that a rule suppressed
  under `[OAR-EVAL-14]` MUST be recorded `suppressed` even when a short-circuit meant it was
  never evaluated. Because `[OAR-EVAL-18]` runs suppressors first, a suppressor firing with
  `block` reaches its targets by suppression and the short-circuit together; recording them
  is what distinguishes "this rule was overruled" from "this rule was never considered", and
  an operator auditing a decision needs to tell those apart. See also `[OAR-CONF-13]` (when
  the short-circuit itself fires) and `[OAR-CONF-12]` (when suppression withdraws an earlier
  contribution).

### 7.1 Content safety

Model input and output are anchors like any other, and a content-safety filter is an
ordinary rule: a detector publishes observation facts, and the rule sets the threshold.

- **[OAR-OPS-11]** A detector MUST return observations — scores, spans, entity lists — and
  MUST NOT return a verdict. The rule's condition owns every threshold. This clause is about
  what a detector is allowed to say; it is not about the applied-rules trace
  (`[OAR-OPS-10]`) or about when a detector reference is accepted (`[OAR-OPS-12]`).
- **[OAR-OPS-12]** A detector reference is a URI of the form `detector://<name>`, where
  `<name>` matches `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`. An engine MUST reject at load a
  `kind: detector` rule whose reference it cannot resolve to a registered detector. See also
  `[OAR-OPS-11]`: resolving the reference proves the detector exists; it does not authorise
  the detector to return a verdict.
- **[OAR-OPS-22]** The facts of the `secrets`, `pii`, `prompt-injection`, `jailbreak`, and
  `moderation` profiles are produced
  by registered detectors and classifiers. A host MUST NOT claim any of these profiles in its
  capability document unless its `detectors` list registers at least one reference that
  produces the profile's facts — a moderation classifier is registered like any detector,
  under a `detector://` reference — and an engine MUST treat a capability document claiming
  any of these profiles with an empty `detectors` list as invalid (`[OAR-FACT-24]`), naming the
  profile. A host that merely defaults these facts to
  their zero values provides the names and the types but not the observations: against it,
  `prompt_injection_score > 0.8` is a rule that silently never fires — the placebo
  `[OAR-DOC-27]` names, reached through configuration rather than a typo. `[OAR-FACT-25]`'s
  zero values cover the occurrences where a registered detector had nothing to say, never the
  host where no detector exists to say it.

### 7.2 Transform

A content rule usually needs to redact rather than refuse, and it usually needs to redact
more than one thing. Transforms accumulate so independent rules can redact separate classes of
content in the same occurrence. Only `block` short-circuits the occurrence.

- **[OAR-OPS-13]** A `transform` object MUST carry `action`, one of `redact`, `replace`,
  `annotate`, and `target`, a string naming what the transform applies to. `replace` and `annotate` MUST
  additionally carry `replacement`, a string — an annotation with nothing to annotate with is
  not a transform. `redact` MAY carry `replacement`; when absent an engine MUST substitute
  exactly the ten code points `[REDACTED]`. The placeholder is fixed rather than
  engine-chosen because `[OAR-CONF-34]` compares content code point by code point, and a
  placeholder each engine picked for itself would make every redaction fixture unpassable on
  some conforming engine.
- **[OAR-OPS-21]** `redact` is `replace` carrying a default: with a `replacement` present the
  two actions are identical, and an engine MUST NOT distinguish them. `annotate` differs from
  both — it inserts its `replacement` immediately after the span's `end`, or at the end of the
  content when the target is `content`, and removes nothing. Because it removes nothing, an
  `annotate` MUST record a zero-width rewritten range at that point rather than marking the
  span it annotated as rewritten. The distinction is invisible in isolation and decisive in
  combination: under `[OAR-OPS-16]` a later transform overlapping an already-rewritten range is
  skipped, so an engine that recorded `annotate` as having rewritten `[start, end)` would
  silently drop a subsequent redaction of the very text it had just annotated.

  Two consequences follow, and an engine MUST observe both. Text inserted at offset `E`
  belongs to the content *beginning* at `E`, never to the range ending there. A rewrite
  beginning at `E`, or strictly containing `E`, consumes that insertion; a rewrite ending
  at `E` preserves it. An annotation therefore survives a later rewrite of the span it
  annotated: annotating and then redacting the same
  span yields the redaction followed by the annotation, not the redaction alone. An annotation
  is a remark *about* a span, and a redaction of that span is the case where the remark is most
  worth keeping. And because a zero-width range overlaps nothing, an `annotate` is never
  skipped under `[OAR-OPS-16]` for overlapping an earlier rewrite — redacting a span and then
  annotating it yields both, in that order. Without these two sentences the same pair of rules
  produces three defensible outputs, which is the whole failure this section exists to prevent.
- **[OAR-OPS-14]** `target` MUST name either the whole content, written `content`, or a fact
  of type `list<map>` whose members carry the spans to act on. An engine MUST reject at load a
  `target` naming anything else.
- **[OAR-OPS-19]** A *span* is a member of a `list<map>` fact named as a `target`. It MUST
  carry `start` and `end`, each a non-negative integer, and MAY carry any other member. `start`
  and `end` are offsets in Unicode code points into the content at this anchor, zero-based,
  with `start` inclusive and `end` exclusive; `start` MUST NOT exceed `end`. A span falls *within* the content when
  `0 <= start <= end <= length` in code points, and falls outside it otherwise — a span
  reaching past the end is outside, not clamped to it. An engine MUST ignore a span that falls
  outside the content, and MUST NOT treat it as a rule that cannot be evaluated. A span that does not carry both `start` and `end` as non-negative
  integers with `start` no greater than `end` is a fact-provider failure, and an engine MUST
  handle the rule per its `on_error` (`[OAR-OPS-3]`).

  The two malformations are separated deliberately. A well-formed span pointing past the end of
  the content is something a detector and a truncating host can disagree about innocently, and
  dropping it costs nothing. A span with no range at all is a detector that did not answer the
  question, and the rule that reads it was going to redact a credential — so it takes the
  `on_error` path an operator chose, and by default that refuses. Ignoring it instead would
  deliver the content unredacted and report the transform as applied.

  Without a defined span shape, two conforming engines produce different redacted content from
  the same rule and the same input while both reporting the same decision — the decision is
  portable and the output is not, which is the half of the promise nobody checks. Code points
  rather than bytes or UTF-16 units, because `[OAR-FACT-23]` already defines `string` that way
  and `size()` already counts that way; an engine measuring offsets in its own host language's
  native unit would disagree with another about every span past the first non-ASCII character.
- **[OAR-OPS-20]** An engine MUST apply the spans of one transform from the highest `start` to
  the lowest, so that an earlier span's offsets still refer to the same code points after a
  later one has been rewritten. Spans within one transform whose ranges overlap MUST be
  applied as a single span covering both, rewritten once. Offsets are interpreted against the
  content as it was at the start of the occurrence, never against the output of a previous
  transform in the accumulated list.

  `[OAR-OPS-16]` orders the accumulated transforms; this orders the spans inside one of them.
  Both are specified because a redaction changes the length of the content, so any engine
  choosing its own order silently changes where every subsequent span lands.
- **[OAR-OPS-15]** An engine MUST accumulate the transforms of every enforced rule that fires
  at an occurrence, in the evaluation order of `[OAR-EVAL-1]`, and MUST carry the accumulated
  list in the decision.
- **[OAR-OPS-16]** An engine MUST apply accumulated transforms in the order accumulated. Every
  span offset in every accumulated transform is interpreted against the content as it was at
  the start of the occurrence (`[OAR-OPS-20]`), never against the output of an earlier
  transform, so an engine MUST translate original-coordinate offsets through the edits it has
  already made rather than reinterpreting them. A detector observed the original content and
  reported offsets into it; any other reading would make a span mean something different
  depending on what ran before it. A span that overlaps a range an earlier transform in the
  same occurrence already rewrote MUST NOT be applied, and the engine MUST record it as
  skipped: the text it was reported against no longer exists, and clamping it to a neighbouring
  boundary would rewrite content no detector ever pointed at. Two transforms whose targets overlap MUST be applied in that
  order rather than merged, and an engine MUST NOT reorder them.

  Normative algorithm for applying the accumulated list to occurrence content `C0` (Unicode
  code points). `rewritten` is the set of original-coordinate half-open ranges already
  rewritten. `C` starts as `C0`. For each transform `T` in accumulation order:

  1. If the occurrence decision is already `block`, stop — do not mutate (`[OAR-OPS-17]`).
  2. Resolve `T.target`: when `content`, the single span is `[0, length(C0))` with action
     applied to the whole string; when a `list<map>` fact, collect its members as spans.
  3. Drop any span that falls outside `C0` (`[OAR-OPS-19]`). A span missing well-formed
     `start`/`end` is a fact-provider failure on the owning rule (`[OAR-OPS-3]`), not a skip.
  4. Merge overlapping spans within `T` into covering spans; sort the result by `start`
     descending (`[OAR-OPS-20]`).
  5. For each span `S` in that order: if `S` overlaps any range in `rewritten`, record `S`
     skipped and continue. Otherwise map `S`'s original offsets through the edits already
     applied to `C`, perform `T.action` (`redact` / `replace` / `annotate` per
     `[OAR-OPS-13]` / `[OAR-OPS-21]`), and add the rewritten original-coordinate range to
     `rewritten` — for `annotate`, a zero-width range at the insertion point.

  The result is `C` after every transform, which `[OAR-CONF-34]` compares code point by code
  point.
- **[OAR-OPS-17]** A `block` at an occurrence discards every accumulated transform: the
  content is not delivered, so there is nothing to mutate. An engine MUST NOT apply a
  transform at an occurrence whose decision is `block`.
- **[OAR-OPS-18]** An engine that does not implement content mutation MUST reject a rule with
  `effect: transform` at load, rather than treating it as a `block` or ignoring it.

---

- **[OAR-OPS-23]** An occurrence MUST expose `skipped_transforms`, an ordered list
  of skipped spans. Each entry carries `rule` (qualified identifier), `start`, `end`
  (original code-point offsets), and `reason: "overlap"`. The order is accumulated
  transform order followed by descending span start/end. Zero-width ranges overlap
  nothing, including when strictly inside a nonempty range. A block discards the
  transform list and its skips. Well-formed out-of-content spans are ignored under
  [OAR-OPS-19], not reported as overlap skips.

## 8. Portability

Two things determine whether a rule travels: the **anchors** the host has, and the
**capabilities** it provides.

- **[OAR-PROF-1]** This specification fixes eight *core anchors*. Their identifiers and
  meanings are given in section 8.1 and MUST NOT be redefined by a host.
- **[OAR-PROF-2]** A host MUST publish an *anchor profile map* declaring, for each core
  anchor, either the local anchor that implements it or that it is unsupported. Every core
  anchor MUST appear exactly once across the two declarations; an engine MUST reject a
  profile map that omits one or declares one twice.
- **[OAR-PROF-3]** A host MUST declare its activity window size — the number of recent steps
  `flow` matches against (`[OAR-FACT-12]`) — as part of its capability document. A host that
  does not track recent activity MUST declare zero, and MUST reject any rule carrying `flow`.
- **[OAR-PROF-4]** An engine MUST resolve a rule whose `anchor` is a core anchor through the
  profile map before selection. A rule targeting a core anchor the host declares unsupported
  MUST be rejected at load, naming the anchor.
- **[OAR-PROF-5]** A host MAY accept host-native `anchor` values naming anchors in its own
  catalogue, and MUST declare that catalogue in its capability document (`[OAR-FACT-21]`),
  written `anchors.host`. Rules naming a catalogued anchor are valid OAR documents and MUST
  load; they are not portable. An engine MUST reject at load a rule whose `anchor` is neither
  a core anchor nor in the declared catalogue, naming the value (`[OAR-DOC-12]`) — without
  the catalogue, a misspelled anchor loads and silently never runs, which is the selector
  failure `[OAR-SEL-3]` closed arriving through the other field. A
  host-native anchor identifier MUST NOT collide with a core anchor identifier.
- **[OAR-PROF-6]** A rule is **portable** if and only if its `anchor` is a core anchor, every
  fact and function its condition, selector, and `copy` reference belongs to the `core` tier
  or to a profile named in `requires.profiles`, and it carries no `flow` or a `flow` its
  target engines' declared windows accommodate.
- **[OAR-PROF-7]** This specification promises identical behaviour across engines for a
  portable rule, on any engine providing the profiles that rule declares. It promises nothing
  about a rule referencing `host`-tier facts, and says so rather than pretending otherwise.
- **[OAR-PROF-8]** An engine SHOULD offer a portability report identifying, for a given rule,
  the host-native anchor or host-tier facts that make it non-portable. The report MUST NOT be
  a load failure — a non-portable rule is legal.

- **[OAR-PROF-9]** Activity is tracked per session in the order tool calls are
  admitted. A step is the `tool` name of a call whose `tool.pre_invoke` occurrence
  completed without a `block` decision. Append it immediately after that occurrence;
  its own pre-invocation rules observe only earlier steps. A later handler refusal,
  provider error, cancellation, or out-of-order completion does not remove or reorder
  the admitted step. Other anchors append no step. Retain at most `activity_window`
  steps, oldest first. Hosts MUST implement these boundaries when they advertise a
  nonzero window; fixtures may supply an explicit window for an occurrence.
- **[OAR-PROF-10]** A host accepting rules at an anchor MUST honor its decision before
  crossing the anchor's delivery or execution boundary. A pre-invocation or handler
  block prevents the operation. A post-invocation block withholds the returned
  content, without claiming to undo completed tool effects. A transform delivers
  only the transformed content; every textual segment in the content buffer is
  included. A host MUST NOT accept transforms for a representation it cannot
  faithfully buffer, transform, and deliver.

### 8.1 Core anchors

<!-- oar:table anchors -->
| Core anchor | Lifecycle moment |
|-------------|------------------|
| `tool.pre_invoke` | Before a tool call is dispatched, with the tool name and arguments observable and nothing executed yet. |
| `tool.handler` | Inside the tool's own handler, after argument validation and before the effect it performs. |
| `tool.post_invoke` | After a tool call returns, with the result observable and before it is handed back to the agent. |
| `agent.post_turn` | After an agent produces a turn, with the turn's content observable — the moment a claim can be checked against the evidence for it. |
| `agent.finalize` | After a worker or child agent completes and its summary is available. |
| `model.input` | User and retrieved content assembled for the model, before the model consumes it. |
| `model.output` | A model response, before it is shown to a person or acted on. |
| `model.tool_result` | Content returned by a tool or retrieval step, before the model consumes it. |
<!-- /oar:table -->

### 8.2 Capability document (non-normative example)

```yaml
oar_capability_version: "1.0"
host: acme.gateway
anchors:
  core:
    tool.pre_invoke: tool.pre_invoke
    tool.post_invoke: tool.post_invoke
    model.input: content.input
    model.output: content.output
  unsupported:
    - tool.handler
    - agent.post_turn
    - agent.finalize
    - model.tool_result
  host:
    - gateway.pre_render
profiles: [tool, content, secrets, mcp]
activity_window: 16
supports_transform: true
expression_nodes_max: 1024
host_facts:
  - name: acme.tenant_tier
    type: string
detectors:
  - detector://presidio
```

---

## 9. Operator configuration

A rule pack arrives from a publisher; an operator has to run it. Without a defined way to
disable one rule, or roll one out in monitor mode, an operator forks the pack — and a forked
pack no longer receives the publisher's updates. The configuration document is what keeps the
pack and the operator's local decisions separate.

- **[OAR-CFG-1]** A configuration document is a JSON object carrying `oar_config` (a version
  string of the same form as `oar`) and any of `disable` and `enforcement`. An engine MUST
  reject a configuration carrying any other member, and MUST reject a configuration whose
  `oar_config` major it does not support or whose minor exceeds the highest minor of that
  major it implements, exactly as `[OAR-DOC-4]` and `[OAR-DOC-5]` require of `oar` — a
  configuration written against a later minor may name enforcement machinery this engine
  does not have.
- **[OAR-CFG-2]** `disable` is a list of qualified or bare rule identifiers. An engine MUST
  treat a listed rule as though its `enforcement` were `off`.
- **[OAR-CFG-3]** `enforcement` is a map from qualified or bare rule identifier to one of
  `enforce`, `monitor`, `off`. An engine MUST apply it in place of the rule's own declared
  `enforcement`.
- **[OAR-CFG-4]** An engine MUST reject a configuration naming a rule that is not loaded,
  naming it. A configuration that silently refers to nothing is indistinguishable from one
  that works.
- **[OAR-CFG-5]** An engine MUST reject a configuration that disables or downgrades a rule
  whose `mandatory` is `true`, naming the rule (`[OAR-OPS-7]`).
- **[OAR-CFG-6]** A configuration document MUST NOT alter a rule's `anchor`, `selector`,
  `when`, `effect`, `on_fire`, `overrides`, or `copy`. It changes whether and how loudly a
  rule runs, never what it means. An operator who needs different logic writes a rule.
- **[OAR-CFG-8]** A bare rule identifier in a configuration document is resolved in two
  steps. An engine MUST first look for a loaded rule whose *qualified identifier* equals it
  exactly — which is how an unnamespaced rule is named (`[OAR-DOC-8]`) — and use that rule
  alone if one exists. Only if none does MUST it search every loaded rule regardless of
  namespace, rejecting a reference that then matches more than one, naming them. Without the
  exact-match step an unnamespaced rule would become undisableable the moment any publisher
  shipped a rule sharing its `id`, because the bare form is that rule's only spelling. A configuration is written by the operator running a pack, who has no
  namespace of their own to resolve within; requiring the qualified form only when it is
  actually ambiguous keeps the common case short without letting it silently hit the wrong
  publisher's rule.
- **[OAR-CFG-7]** An engine MAY accept more than one configuration document. When it does, it
  MUST apply them in the order given, and the last statement about a rule wins.

---

## 10. Conformance

### 10.1 The runner algorithm

The requirements below define the evaluation algorithm end to end. Each step is separately
identified so a conformance fixture can cite it.

- **[OAR-CONF-1]** Load each rule document and validate it against the published OAR schema.
  An engine MUST reject a document that fails validation, naming the failing field. A rule set
  (`[OAR-DOC-31]`) is not itself a schema-bearing document: an engine MUST validate each member
  against the rule schema individually, and no separate rule-set schema is published, because a
  collection carries no meaning of its own beyond the documents in it.
- **[OAR-CONF-2]** An engine MUST check `oar` before any other processing of a document, and
  reject an unsupported major or a greater minor (`[OAR-DOC-4]`, `[OAR-DOC-5]`).
- **[OAR-CONF-3]** An engine MUST resolve `anchor`: a core anchor identifier through the
  anchor profile map, any other value against the declared host anchor catalogue
  (`[OAR-PROF-5]`). A value that is neither is a load rejection naming the value
  (`[OAR-DOC-12]`).
- **[OAR-CONF-4]** An engine MUST reject a rule whose `requires` are not all provided by the
  host, and a rule referencing a non-core capability it does not declare in `requires`
  (`[OAR-FACT-19]`, `[OAR-FACT-20]`).
- **[OAR-CONF-5]** An engine MUST type-check `when` against the declared fact environment
  and MUST reject the rule on an unknown identifier or a type error.
- **[OAR-CONF-6]** An engine MUST resolve `overrides` and `on_error` references, and reject
  an unresolvable one or a suppression cycle.
- **[OAR-CONF-7]** An engine MUST apply configuration documents, rejecting one that names an
  unloaded rule or downgrades a mandatory rule.
- **[OAR-CONF-8]** At an anchor occurrence, an engine MUST select the rules whose resolved
  `anchor` matches, whose `enforcement` is not `off`, and whose selector clauses all match.
- **[OAR-CONF-9]** An engine MUST assemble the facts the selected rules reference, lazily
  where `[OAR-FACT-11]` requires it. A fact provider failure MUST be handled per the rule's
  `on_error`.
- **[OAR-CONF-10]** An engine MUST order evaluation as `[OAR-EVAL-1]` requires — by `kind`,
  then by qualified identifier, amended by `[OAR-EVAL-18]` so each suppressor precedes the
  rules it names — and for each selected rule in that order MUST test `flow` before evaluating
  `when` (`[OAR-EVAL-3]`).
- **[OAR-CONF-11]** An engine MUST record but not act on a rule whose `enforcement` is
  `monitor`: no effect, no side-effect, no suppression, no short-circuit.
- **[OAR-CONF-12]** An engine MUST apply suppression when a rule with `overrides` fires,
  withdrawing the contribution of any already-evaluated rule it names. Suppression undoes
  what an earlier rule already contributed; it is not a short-circuit — evaluation continues
  (see `[OAR-CONF-13]`). The suppressed rule is still traced (`[OAR-OPS-10]`).
- **[OAR-CONF-13]** The first enforced rule firing with `block` MUST short-circuit the
  occurrence; a rule firing with `transform` MUST NOT. Short-circuit stops later rules from
  being evaluated at all; suppression (`[OAR-CONF-12]`) withdraws an already-evaluated
  contribution while evaluation continues.
- **[OAR-CONF-14]** An engine MUST apply decision precedence: `block`, then `transform`, then
  `nudge`, then `warn`, otherwise `none`.
- **[OAR-CONF-15]** An engine MUST apply the `on_fire` actions of every rule that fired and
  was enforced and was not suppressed.
- **[OAR-CONF-16]** An engine MUST emit the applied-rules trace of `[OAR-OPS-9]`.

### 10.2 Fixture shape

- **[OAR-CONF-17]** A conformance fixture is a JSON object with `id`, `covers`, `rules`,
  `input`, and `expected`, and an optional `title` describing what it demonstrates. `id` MUST
  equal the fixture's file name stem. `covers` MUST be a non-empty list of clause identifiers
  defined by this specification. `rules` is a list of rule documents.
- **[OAR-CONF-18]** `input` MUST carry `capability`, and MUST carry either `anchor` — the
  single-occurrence spelling, alongside the optional `facts`, `detector_facts`,
  `recent_activity`, `session_id`,
  and `config` — or `occurrences` (`[OAR-CONF-31]`), and MUST NOT carry both spellings.
  `capability` is a capability document (section 8.2) describing the host the fixture assumes.
- **[OAR-CONF-31]** `occurrences` is a non-empty ordered list, each member carrying `anchor`
  and optionally `facts` and `recent_activity`, and optionally its own `expected` asserting
  what that occurrence resolved to. An engine MUST evaluate the members in order, as one
  session against one counter store, applying each occurrence's side-effects before the next is
  evaluated, and MUST take `session_id` and `config` from `input` for all of them. The
  fixture-level `expected` describes the *final* occurrence, and `expected.counters` the
  counter values in force after every occurrence has been evaluated.

  A single occurrence cannot observe a counter, because every counter a rule reads was written
  at an occurrence before it (`[OAR-FIRE-6]`). Without this spelling, section 6 would be a
  vocabulary whose whole purpose — a threshold crossed over time — no fixture could exercise,
  and the corpus would report an engine conformant on the strength of never having asked. This
  guards against an untested mechanism, ensuring behavioral coverage.
- **[OAR-CONF-33]** A key of `expected.counters` is a qualified rule identifier for a rule with
  no `counter_scope`, and is written `<qualified id>#<scope value>` for a rule that has one.
  A rule with a `counter_scope` therefore has as many counters as the scope fact has values,
  and a fixture names the one it means. An engine MUST report its own counters under the same
  spelling.
- **[OAR-CONF-34]** `input.content`, and `content` on a member of `occurrences`, is the content
  at the occurrence, as a string. `expected.content` is that content after the occurrence's
  accumulated transforms have been applied (`[OAR-OPS-16]`, `[OAR-OPS-20]`). An engine MUST
  compare it by code point sequence. A fixture asserting `expected.content` MUST supply
  `content`, and an engine MUST reject one that does not, naming the fixture.

  Without a way to state the content that came out, `transform` would be observable only as
  the *list* of transforms the engine accumulated — which asserts that the engine agreed about
  what to do and never that it did it. Two engines can accumulate an identical transform list
  and emit different strings, and the span rules of `[OAR-OPS-19]` and `[OAR-OPS-20]` exist
  precisely because that is easy to do by accident.
- **[OAR-CONF-32]** Every counter value a fixture asserts or gates on MUST be one the engine
  arrived at through the declared side-effects of the occurrences the fixture lists. A fixture
  MUST NOT supply `fire_count`, `breaker_count`, `fire_count_of`, or `breaker_count_of` in
  `facts`, and a fixture asserting a counter larger than the occurrences it lists could have
  written MUST use `occurrences`. A counter handed to the engine ready-made tests the fixture
  loader; a counter the engine had to arrive at tests the engine.
- **[OAR-CONF-19]** Every fixture MUST carry `input.capability`. Without one, a fixture asks
  each implementation a different question — whether a rule loads depends on which anchors
  and profiles that implementation happens to support — and the corpus promises never to do
  that.
- **[OAR-CONF-20]** An engine running a fixture MUST evaluate it against the fixture's
  declared capability document rather than its own, and MUST otherwise behave exactly as it
  would for its own. An engine that cannot adopt a declared capability set MUST report the
  fixture as skipped rather than failed.
- **[OAR-CONF-21]** `expected` MAY carry any of `decision`, `code`, `rule`, `on_fire`,
  `transforms`, `advisories`, `applied`, `counters`, `events`, `content`, `copy`, and `error`, and a
  fixture asserts only the ones it is about. `decision` is the effect the occurrence resolves
  to, or `none`. `code` is the bare identifier the decision carries; `rule` is the qualified
  identifier. `on_fire` lists the side-effects the engine applied, in application order.
  `transforms` is the accumulated transform list. `advisories` is the accumulated advisory
  list (`[OAR-EVAL-20]`, `[OAR-CONF-37]`). `applied` is the ordered trace, each entry written
  `<qualified id>:<outcome>`. `counters` maps a qualified rule identifier to the counter
  values expected after the occurrence, or after the whole run when the fixture carries
  `occurrences` (`[OAR-CONF-31]`). `events` is the ordered list of `publish_event` records,
  each carrying `rule`, `anchor`, and `effect` as defined by `[OAR-FIRE-7]`. An engine's own
  report carries a counter entry only for a rule
  whose counters changed over that same span — the occurrence, or the run — so that a counter
  advanced by an earlier occurrence is still reported after a later one leaves it untouched,
  and so that the same outcome does not
  compare unequal between two engines merely because one enumerated untouched zeroes. A
  fixture, however, MAY assert a counter is zero, and an asserted zero MUST match an absent
  entry: asserting that a rule's breaker did *not* advance is the negative test that monitor
  mode, suppression, and short-circuit most need, and it MUST remain expressible. `error` asserts a load-time rejection and matches when
  the engine's error contains the given text; an engine MUST NOT be required to match error
  wording beyond that substring.
- **[OAR-CONF-37]** `expected.advisories` is the accumulated advisory list of
  `[OAR-EVAL-20]`. An engine MUST compare it by length and by order. Each item MAY carry
  `code`, `rule`, and `copy`; a fixture asserts only the members it is about, and an engine
  MUST match every member that is present. A fixture that omits `advisories` does not
  constrain the list.
- **[OAR-CONF-22]** An engine MUST reject a fixture carrying an `expected` key this
  specification does not define, rather than passing it silently.
- **[OAR-CONF-29]** `input.anchor` is the *host-local* anchor identifier — the value on the
  right of the capability document's `anchors.core` map, not the core identifier on the left.
  A fixture therefore describes an occurrence as the host would see it, and an engine resolves
  each rule's `anchor` through the map before comparing. Every fixture in the published corpus
  whose capability map is not the identity mapping MUST exercise this, or the distinction goes
  untested and two engines can disagree about which spelling a fixture meant.
- **[OAR-CONF-30]** An `expected.error` substring MUST be a single machine token — a field
  name, an identifier, a clause identifier, or an enum member — and MUST NOT be a phrase or a
  sentence. `[OAR-CONF-21]` frees an engine to word its own diagnostics, and a corpus that
  asserts whole English sentences takes that freedom back: a second implementation reporting
  the same defect, naming the same field, in its own words, fails a fixture it is behaving
  correctly on. A fixture asserts *that the right thing was named*, never how it was phrased.
- **[OAR-CONF-23]** A fixture MUST restrict itself to core anchors and to facts of the `core`
  tier or of a declared profile, except where the clause it covers is itself about host-tier
  behaviour. A fixture exercising host-tier behaviour MUST declare the host facts it uses in
  `input.capability.host_facts`, so it remains self-describing.
- **[OAR-CONF-24]** An implementation claiming conformance MUST pass every fixture in the
  published corpus whose declared capability set it can adopt, and MUST report which fixtures
  it skipped and why. A skipped fixture is not a passed fixture.
- **[OAR-CONF-35]** The published manifest marks a fixture *baseline* exactly when its
  capability document claims no profile, no host fact, no activity window, no content
  mutation, and no detector beyond the three the corpus reserves — a capability set nothing
  conforming lacks, because `[OAR-FACT-15]` and Appendix A already oblige every engine to
  have it. `[OAR-CONF-20]`'s allowance to skip does not extend to a baseline fixture: an
  implementation claiming conformance MUST run every one. Without a floor, `[OAR-CONF-24]`
  admits a claim built entirely of skips — an engine reporting "conforming, everything
  skipped" would be telling the truth, and the corpus exists so that the truth is harder to
  arrange than that.
- **[OAR-CONF-36]** A fixture's capability document MUST declare no capability the fixture
  does not need: a declaration is permitted exactly when removing it would change the
  fixture's outcome. An unused declaration is not inert. `[OAR-CONF-20]` has an engine skip
  any fixture whose capability set it cannot adopt, so a capability the fixture never
  exercises narrows the set of engines that can run it while buying no coverage — and because
  `[OAR-CONF-35]` reads the same declarations, an unused `supports_transform: true` also
  lowers the floor that keeps a conformance claim from being assembled out of skips. The test
  is behavioural rather than structural because in a corpus about capability the declaration
  is often the subject: a fixture proving that a rule requiring an unprovided profile is
  rejected needs that profile to stay unprovided. Removing it and observing the outcome
  distinguishes the two; reading the rules cannot.
- **[OAR-CONF-25]** Three detector references are reserved for the corpus, and an engine
  running it MUST provide all three: `detector://noop` reports no findings; `detector://error`
  always fails, which is how a fixture reaches the `on_error` path; and `detector://fixture`
  reports no findings of its own, leaving the detector facts the fixture supplied in place,
  which is how a fixture proves the rule owns the threshold. None of the three requires a
  model or a network.

  When a fixture carries `detector_facts` — a map of fact name to value, beside `facts` —
  `detector://fixture` instead *produces* those facts when it is invoked, and an engine MUST
  NOT place them in the environment any other way. `facts` states what the host observed
  before evaluation began; `detector_facts` states what the detector reports when a rule
  causes it to run (`[OAR-FACT-11]`). The two spellings exist because they catch different
  failures: a detector-produced value that reaches the condition but never the transform
  target is invisible to every fixture that pre-supplies its facts, and an engine with that
  defect reports a transform decision over content it did not change.
- **[OAR-CONF-26]** When a fixture supplies a value in `input.facts` under the name of a
  declared observation function, that value is the function's result for every argument. This
  is how a fixture exercises a function without the host state behind it.

### 10.3 Coverage

The conformance test corpus exercises the normative clauses of this specification.
Every normative MUST or MUST NOT clause describing engine behavior or document syntax is
cited by the `covers` list of at least one fixture, or documented in the repository's
exemption list (`exempt.json`) where a clause is verified by schema validation or unit tests
rather than runtime fixtures.

- **[OAR-CONF-27]** *(Retired)* Specification test coverage and build verification are managed by repository tooling rather than normative clauses on conforming engines.
- **[OAR-CONF-28]** *(Retired)* Test exemption criteria are managed by repository tooling rather than normative clauses on conforming engines.

---

- **[OAR-CONF-38]** A conformance adapter MUST invoke the implementation's actual
  document loader and evaluator. Another implementation's loader, schema validator,
  or expected result MUST NOT satisfy an expected rejection on its behalf. Adapter
  work is limited to input transport, declared fixture providers, state setup, and
  normalization of actual results. A skipped or unexecuted case is not a pass.
- **[OAR-CONF-39]** When `expected.skipped_transforms` is present, a runner MUST
  compare it by length, order, and every entry's `rule`, `start`, `end`, and `reason`,
  with the shape and ordering of [OAR-OPS-23]. An absent expected member imposes no
  assertion; the actual report still carries the list.
- **[OAR-CONF-40]** An occurrence MAY carry `tool_call`, with `name` (a nonempty
  string) and `arguments` (a JSON object). The fixture host MUST use its production
  tool-observation adapter to supply `tool`, `tool_args`, and `tool_args_fingerprint`
  from it. Explicit `facts` override these observations. Across occurrences, when
  `recent_activity` is absent, the fixture host maintains activity under
  [OAR-PROF-9]; an explicit window replaces it for that occurrence only.

## 11. Extensibility and versioning

- **[OAR-VER-1]** A minor revision MUST be additive: it may add optional fields, enum members,
  profiles, and clauses, and MUST NOT remove or rename a field, change the decision an
  existing valid document produces, or narrow an existing field's accepted values.
- **[OAR-VER-2]** A change that breaks a valid document of the current major version MUST
  bump the major version.
- **[OAR-VER-3]** A published version of this specification is immutable. A correction MUST
  ship as a new version rather than an edit in place.
- **[OAR-VER-4]** Because an engine rejects a greater minor (`[OAR-DOC-5]`), a rule author
  targeting a mixed fleet MUST author to the lowest minor that fleet implements. A publisher
  SHOULD state the minor its pack requires.
- **[OAR-VER-5]** A new capability profile MAY be added in a minor revision. Adding a fact to
  an existing profile is a breaking change to that profile, because an engine claiming the
  profile at the older minor no longer provides all of it; such a change MUST either bump the
  major or introduce a new profile name.

---

## Appendix A — The condition language (normative)

`when` is written in a small, frozen expression language. Its grammar is a subset of CEL's
expression syntax, so a host with a CEL implementation evaluates it by declaring this
vocabulary and the built-ins of A.3 as global functions and rejecting what the grammar below
cannot derive; it is specified independently so a host without one can implement it completely
in a few hundred lines, and so that two engines cannot disagree about what a condition means.

The one place the two shapes differ is worth stating plainly: CEL spells its string operations
as member calls, `s.startsWith(p)`, and this language has no member-call syntax and no field
selection at all, because a dotted name here is the single name of a `host`-tier fact
(`[OAR-FACT-18]`). The built-ins are therefore ordinary calls, `starts_with(s, p)`, in the one
namespace `[OAR-FACT-2]` requires.

The subset is defined by what it excludes as much as by what it includes. It has no macros,
no comprehensions, no regular expressions, no time, no random source, and no field selection.
Regular expressions are excluded because their dialects differ across host languages, which
would make a portable rule evaluate differently on two conforming engines.

### A.1 Grammar

```ebnf
condition   = ternary ;
ternary     = disjunction [ "?" ternary ":" ternary ] ;
disjunction = conjunction { "||" conjunction } ;
conjunction = relation { "&&" relation } ;
relation    = addition [ relop addition ] ;
relop       = "==" | "!=" | "<" | "<=" | ">" | ">=" | "in" ;
addition    = multiplication { ( "+" | "-" ) multiplication } ;
multiplication = unary { ( "*" | "/" | "%" ) unary } ;
unary       = [ "!" | "-" ] postfix ;
postfix     = primary { "[" condition "]" } ;
primary     = literal | call | identifier | "(" condition ")" ;
call        = identifier "(" [ condition { "," condition } ] ")" ;
literal     = "true" | "false" | int | double | string | list ;
list        = "[" [ condition { "," condition } ] "]" ;
identifier  = name { "." name } ;
name        = ( letter | "_" ) { letter | digit | "_" } ;
int         = digit { digit } ;
double      = digit { digit } "." digit { digit } ;
string      = '"' { dquote-char } '"' | "'" { squote-char } "'" ;
dquote-char = escape | ? any Unicode code point except '"', "\" and a line break ? ;
squote-char = escape | ? any Unicode code point except "'", "\" and a line break ? ;
escape      = "\" ( "\" | '"' | "'" | "n" | "r" | "t" | "u" hex hex hex hex ) ;
hex         = digit | "a".."f" | "A".."F" ;
keyword     = "true" | "false" | "in" ;
```

- **[OAR-EXPR-1]** An engine MUST accept every condition this grammar derives and MUST reject
  every condition it does not, naming the offending construct and its offset in the source.
- **[OAR-EXPR-2]** An identifier may contain dots, and a dotted identifier is a single name —
  the name of a `host`-tier fact under `[OAR-FACT-18]`. There is no field-selection operator.
  A member of a `map<string,string>` fact is reached with the index operator; an
  unparameterised `map` such as `tool_args` is not indexable at all (`[OAR-EXPR-19]`).
- **[OAR-EXPR-3]** String literals accept the escapes `\\`, `\"`, `\'`, `\n`, `\r`, `\t`, and
  `\u` followed by exactly four hexadecimal digits. An engine MUST reject any other escape.
- **[OAR-EXPR-4]** Operator precedence, tightest first: index; unary `!` and `-`; `*` `/` `%`;
  `+` `-`; `<` `<=` `>` `>=` `in`; `==` `!=`; `&&`; `||`; ternary. Binary operators of equal
  precedence associate left; the ternary associates right. This table describes how the
  grammar of A.1 groups an expression it derives; it does NOT extend the grammar. Where the
  two appear to differ the grammar governs, and an engine MUST reject what the grammar cannot
  derive. In particular a relation admits at most one relational operator, so `a < b < c` is
  not a valid condition and MUST be rejected rather than grouped by this table.
- **[OAR-EXPR-5]** `&&` and `||` MUST short-circuit: an engine MUST NOT evaluate the right
  operand when the left decides the result. A condition is therefore able to guard an
  expensive or partial sub-expression behind a cheap one.
- **[OAR-EXPR-6]** A comment is not part of the language. An engine MUST reject a condition
  containing one.
- **[OAR-EXPR-24]** `true`, `false`, and `in` are reserved words. An engine MUST lex a
  reserved word as itself and never as an `identifier`, and MUST NOT declare a fact or an
  observation function under one of those names. A name is lexed greedily — the longest run of
  `letter`, `digit`, and `_` beginning at that position — so `international` is one identifier
  and not `in` followed by `ternational`, and `insize` is an identifier rather than a reserved
  word. Whitespace between tokens is not significant and is not otherwise part of the language.
  Two engines that lexed `a in b` and `a inb` alike would disagree about which conditions are
  even well-formed, which is the ambiguity a published grammar exists to remove.

### A.2 Types

- **[OAR-EXPR-7]** The value types are `bool`, `int`, `double`, `string`, and the aggregate
  types of `[OAR-FACT-22]`. There is no null value and no nullable fact type: every declared
  fact has a value at every occurrence (`[OAR-FACT-25]`), so a comparison against null could
  only ever be dead code, and an engine MUST reject `null` as an unknown identifier.
- **[OAR-EXPR-8]** `&&`, `||`, and `!` take and produce `bool`. The ternary condition MUST be
  `bool`, and its two branches MUST have the same type.
- **[OAR-EXPR-9]** `+` `-` `*` `/` `%` take two `int` or two `double` and produce that type.
  `%` MUST take two `int`. `+` additionally takes two `string` and concatenates. An engine
  MUST reject any other arithmetic operand pair at load.
- **[OAR-EXPR-10]** `<` `<=` `>` `>=` take two `int`, two `double`, one of each, or two
  `string`. When mixed, the `int` is promoted to `double` for the comparison only. String
  comparison is by Unicode code point.
- **[OAR-EXPR-11]** `==` and `!=` take two operands of the same type, or one `int` and one
  `double`, and produce `bool`. An engine MUST reject a comparison between unrelated types at
  load rather than returning `false`, because a type-confused comparison is a policy that
  silently never fires.
- **[OAR-EXPR-12]** `in` takes a `string` and a `list<string>`, or a `string` and a `map`, and
  produces `bool`. Against a `map` it tests key presence.
- **[OAR-EXPR-13]** The index operator is typed as follows, and an engine MUST reject any other
  operand pair at load: `map<string,string>` indexed by `string` yields `string`;
  `list<string>` indexed by `int` yields `string`; `list<map>` indexed by `int` yields `map`.
  Indexing with an absent key, or out of range, MUST raise, and the rule is then handled per
  its `on_error`.
- **[OAR-EXPR-19]** A fact of the unparameterised type `map` MUST NOT be indexed. It supports
  only `in`, which tests key presence, and `size()`. Its members are heterogeneously typed, so
  indexing one would yield a value whose type is not known until run time, and a condition
  containing it could not be type-checked at load as `[OAR-FACT-4]` requires. This
  specification has no dynamic type, and gains its load-time guarantee by not having one.

  An engine that wants to expose the members of such a fact declares typed *observation
  functions* for them, as the `tool` and `mcp` profiles do with `tool_arg_string` and
  `mcp_field_string`. The value is reached through a name whose return type is declared, so
  the condition stays statically checkable. Testing presence first is what makes the access
  safe, and `[OAR-EXPR-5]` guarantees the guard short-circuits:
  `"path" in tool_args && tool_arg_string("path") == "/etc/passwd"`.
- **[OAR-EXPR-14]** Division or modulo by zero MUST raise, for `int` and `double` operands
  alike: `1.0 / 0.0` raises, and an engine MUST NOT produce an IEEE infinity or NaN from any
  arithmetic operation. IEEE 754 defines that quotient; a *condition* language does not want
  it, because every comparison against the resulting infinity silently decides one way, and
  `[OAR-FACT-23]` has already excluded non-finite values from the type.
- **[OAR-EXPR-15]** Integer arithmetic that overflows 64 bits MUST raise rather than wrap.

### A.3 Built-in functions

- **[OAR-EXPR-16]** The language defines exactly four built-ins, and an engine MUST NOT define
  a fifth; an observation an engine wants to offer is a declared observation function, which is
  subject to the tier rules.

  | Built-in | Signature | Meaning |
  |----------|-----------|---------|
  | `size(x)` | `(string \| list \| map) -> int` | The number of members, or on a `string` the number of Unicode code points. |
  | `starts_with(s, prefix)` | `(string, string) -> bool` | True when `s` begins with `prefix`. |
  | `ends_with(s, suffix)` | `(string, string) -> bool` | True when `s` ends with `suffix`. |
  | `contains(s, substring)` | `(string, string) -> bool` | True when `substring` occurs anywhere in `s`. |

- **[OAR-EXPR-22]** The three string built-ins compare by Unicode code point, over the code
  point sequence the `string` type defines (`[OAR-FACT-23]`). They apply no normalisation, no
  case folding, and no locale. An engine MUST NOT fold case, because two engines whose host
  languages disagree about the case of a character would then disagree about a decision. An
  empty `prefix`, `suffix`, or `substring` matches every string.

  These three exist because the shapes a rule most often needs — a path prefix, a URL
  scheme, a command name at the head of an argument — are otherwise expressible only as a
  host observation function, which makes the rule non-portable for a comparison every host
  language already agrees about. They are the substring operations whose behaviour does not
  vary by dialect, which is why they are here and why `[OAR-EXPR-23]` is not.
- **[OAR-EXPR-23]** *Reserved.* No built-in matches a regular expression, and an engine MUST
  NOT add one. Regular-expression dialects differ across host languages in backtracking,
  Unicode property support, and escaping, so the same pattern decides differently on two
  conforming engines. Where a rule needs matching these operators cannot express, the host
  publishes an observation function and the rule composes it: the matching then lives in one
  place, under a declared name, with a declared type, and the rule that uses it is
  computably non-portable rather than silently non-deterministic.

### A.4 Limits

- **[OAR-EXPR-17]** An engine MUST accept a condition whose parse tree contains at least 256
  nodes. It MAY reject a larger one, and MUST declare its limit in its capability document.
  A floor lets an author know what will travel; a declared ceiling lets an engine bound its
  own cost.
- **[OAR-EXPR-20]** A *node*, for the purpose of `[OAR-EXPR-17]`, is exactly one of: a
  literal; an identifier; a function call; an index operation; a unary operation; a binary
  operation; or a ternary operation. A function call's arguments, an index operation's
  operand and subscript, and a list literal's members are each counted separately, and the
  list literal itself counts as one node. Parentheses are not nodes, because they do not
  survive parsing. Count the syntactic tree before constant folding, including
  unary minus on the minimum integer. An engine MUST count nodes this way, so that two engines agree on whether
  a given condition is within a given limit; a limit each engine measured differently would
  not be a portability floor at all.
- **[OAR-EXPR-21]** Where two implementations could reasonably differ, this specification
  chooses, and an engine MUST follow: integer division truncates toward zero, so `-7 / 2` is
  `-3` and `-7 % 2` is `-1`; a negative list index raises, as an out-of-range one does; `==`
  and `!=` on two aggregate values are rejected at load, because element-wise equality over a
  `list<map>` is more machinery than a rule condition needs; a `map<string,string>` is a
  map for the purposes of `in` and `size()`; an integer literal that does not fit 64 bits is
  rejected at load, except that the magnitude 9223372036854775808 is admitted as the immediate
  operand of unary minus, without which the least value of the `int` type could not be written
  at all; a `double` literal whose nearest binary64 value is not finite is rejected at load,
  for the same reason `[OAR-EXPR-14]` refuses to produce an infinity; and a list literal is `list<string>` when every member is a
  `string` and `list<map>` when every member is a map, is rejected otherwise — members
  agreeing is necessary but not sufficient, since `[OAR-FACT-22]` defines no other list type —
  and the empty literal `[]` is rejected because its type cannot be inferred.
- **[OAR-EXPR-18]** Evaluation MUST terminate. The grammar has no loop, no recursion, and no
  user-defined function, so a conforming implementation satisfies this structurally.

---

## Appendix B — Change log

| Version | Change |
|---------|--------|
| 1.0 | First version. Publication is recorded in the published register; until 1.0 appears there, this text may still be corrected in place. Copy members MAY contain the frozen bindings of Appendix C; the engine renders them after the decision (`[OAR-COPY-1]`–`[OAR-COPY-9]`). When the decision is `nudge` or `warn`, every enforced rule that fired with that effect is carried on `advisories` (`[OAR-EVAL-20]`). The `tool` profile publishes `arg_validation_reason` and `arg_validation_field`. |

---

## Appendix C — Copy bindings (normative)

`copy` members are presentation strings. They MAY contain bindings that name declared facts.
The engine substitutes those bindings after the decision is resolved, so two engines that
agree on the decision also agree on the prose that explains it. The language is frozen and
small: a substitution, a conditional, and nothing else. It is not the condition language of
Appendix A, and it is not a host template dialect.

```ebnf
copy_text   = { literal | binding | conditional } ;
binding     = "{{" ws identifier ws "}}" ;
conditional = "{%" ws "if" ws [ "not" ws ] identifier ws "%}"
              copy_text
              [ "{%" ws "else" ws "%}" copy_text ]
              "{%" ws "endif" ws "%}" ;
identifier  = name { "." name } ;
name        = ( letter | "_" ) { letter | digit | "_" } ;
ws          = { " " | "\t" | "\n" | "\r" } ;
literal     = ? any run of code points that does not begin "{{" or "{%" ? ;
```

- **[OAR-COPY-1]** After the decision is resolved, the engine MUST render each member of the
  winning rule's `copy` by substituting the bindings of this appendix against the fact
  environment of the occurrence. A decision of `none` carries no copy.
- **[OAR-COPY-2]** A binding `{{ identifier }}` names a declared fact. An engine MUST reject
  at load a copy member whose bindings name an identifier that is not a declared fact, naming
  the identifier. A mistyped fact name in `copy` is a load failure, never a runtime default.
- **[OAR-COPY-3]** A copy member MAY contain `{% if identifier %}…{% endif %}` and
  `{% if identifier %}…{% else %}…{% endif %}`. The `if` branch is taken when the named fact
  is non-zero under `[OAR-FACT-25]`. `{% if not identifier %}` inverts the test. An engine
  MUST reject at load any `{%` or `{{` construct this grammar does not derive, naming the
  construct.
- **[OAR-COPY-4]** `{{ identifier }}` interpolates a `string` as itself; a `bool` as `true` or
  `false`; an `int` as a base-10 integer; a `double` in the canonical decimal form of [OAR-COPY-10]; and a `list<string>` as its members joined
  by `", "` (U+002C U+0020), or the empty string when the list is empty. An engine MUST reject
  at load a binding whose fact's type is not one of those. Observation functions, `map`,
  `map<string,string>`, and `list<map>` cannot be interpolated.
- **[OAR-COPY-5]** A name appearing in a copy binding or conditional is a fact the rule
  *references* for `[OAR-FACT-11]`, `[OAR-FACT-20]`, and `[OAR-PROF-6]`. A non-core fact named
  only in `copy` MUST still be reached through `requires`.
- **[OAR-COPY-6]** Rendered copy MUST NOT affect selection, evaluation, ordering, precedence,
  or the returned effect. Two rules whose `copy` differs only in bindings or prose MUST
  produce identical decisions when their other fields are equal (`[OAR-DOC-24]`).
- **[OAR-COPY-7]** A decision other than `none` MUST carry the rendered `copy` object of the
  rule whose identifiers it carries (`[OAR-EVAL-8]`, `[OAR-EVAL-19]`). Members the rule omitted
  remain absent. A binding whose host has nothing to report substitutes the zero value of the
  fact's type (`[OAR-FACT-25]`). When the decision carries `advisories`, that object is the
  first item's `copy`.
- **[OAR-COPY-9]** Each item of `advisories` MUST carry that rule's rendered `copy` under
  `[OAR-COPY-1]`. Two items MUST NOT share a merged copy object. An engine MUST render each
  item against the fact environment of the occurrence, independently of the others.
- **[OAR-COPY-8]** Whitespace inside `{{ }}` and `{% %}` is permitted and insignificant. An
  engine MUST accept `{{tool}}` and `{{ tool }}` as the same binding.

- **[OAR-COPY-10]** A double MUST render as the shortest decimal significand that
  round-trips to the same finite binary64 value, choosing the closest decimal and
  ties to an even significand. Expand exponent notation into ordinary decimal
  notation, include a leading zero before a fractional value, and append `.0` when
  there is no fractional part. Both signed zeroes render as `0.0`. A negative value
  has one leading minus. For example: `1.0`, `0.0000001`, `-2.5`, and `0.0`.

- **[OAR-COPY-11]** If rendering the copy for an `on_error` block itself fails because
  a required observation is unavailable or has the wrong runtime type, the engine MUST
  omit the entire rendered copy object (or return an empty object), retain the block and
  its rule identifiers, and MUST NOT coerce the failed observation or substitute its zero
  value. This presentation failure MUST NOT start another `on_error` evaluation.
