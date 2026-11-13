
# Open Agent Rules

**Version 1.0** · Status: published · Canonical URL: `https://openagentrules.org/spec/1.0/`

Open Agent Rules (OAR) is a portable document format for agent guardrails. A rule is a
document — not code — that names a lifecycle moment, a condition over typed observations,
and an effect. A conforming engine loads the document, evaluates the condition, and renders
the effect. The same document produces the same decision on every conforming engine.

## Implementation grant

Anyone may implement this specification, for any purpose, without permission, notification,
or fee. See [`LICENCE-SPEC.md`](../LICENCE-SPEC.md) for the licence covering this text.

## Conformance language

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY in this document are to be
interpreted as described in RFC 2119. Every requirement carries a stable clause identifier
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

A **host** is the system being guarded — an agent runtime, a model gateway, a tool server.
It publishes typed *observations* of its own state at named lifecycle moments. An **engine**
loads rule documents, selects the ones bound to the moment that just occurred, evaluates
their conditions against the published observations, and applies the resulting decision. A
**rule author** writes documents; they never write host code.

**Portability** in this specification is a precise claim, not a marketing one. Two
vocabularies are fixed by the standard: a small set of *core anchors* (lifecycle moments
every conforming host has) and a tiered *fact catalogue* (observations every conforming host
publishes). A rule that uses only those travels unchanged between conforming engines. A rule
that reaches for a host's own anchors or its own facts is still a valid OAR document and is
still loadable — it is simply not portable, and the standard says so rather than pretending
otherwise.

---

## 2. Document model

- **[OAR-DOC-1]** A rule document MUST be representable as a JSON object. An engine MAY
  accept other serialisations (YAML is the common authoring form) provided the mapping to
  JSON is lossless; interchange between implementations MUST use JSON.
- **[OAR-DOC-2]** A rule document MUST contain `spec_version`, `id`, `kind`, `on`,
  `selector`, and `effect`. An engine MUST reject a document missing any of them. A document
  whose `kind` is `hint` is a hint document, not a rule: it MUST contain `spec_version`,
  `id`, and `kind`, MUST NOT contain `on`, `selector`, or `effect`, and is governed by
  section 9.
- **[OAR-DOC-3]** `spec_version` is a string of the form `<major>.<minor>`. An engine MUST
  reject a document whose `spec_version` it does not support, and MUST NOT silently
  downgrade or coerce it.
- **[OAR-DOC-4]** `id` is a stable identifier matching `^[A-Z][A-Z0-9_]*$`. It MUST NOT be
  reused for a rule with a different meaning once published.
- **[OAR-DOC-5]** `title` is an optional human-readable label. It MUST NOT affect any
  decision.
- **[OAR-DOC-6]** `kind` MUST be one of `schema`, `policy`, `invariant`, `detector`, or
  `hint`. For a rule document it fixes evaluation order and nothing else — see
  `[OAR-EVAL-2]`. A document with `kind: hint` is a hint document, which is never selected
  or evaluated — see section 9.
- **[OAR-DOC-7]** `severity` is optional, one of `block`, `warn`, `info`, and is telemetry
  and presentation only. An engine MUST NOT let `severity` affect selection, condition
  evaluation, ordering, precedence, or the returned decision. Two rules differing only in
  `severity` MUST produce identical decisions.
- **[OAR-DOC-8]** `effect` MUST be one of `block`, `warn`, `nudge`, `allow`, `transform`.
- **[OAR-DOC-9]** `when` is an optional condition, written in the language of Appendix C,
  over the declared fact environment (section 5). When absent, the rule's condition is
  satisfied.
- **[OAR-DOC-10]** `flow` is an optional ordered list of step names. When present, the rule
  fires only if `flow` matches the recent activity window as described in
  `[OAR-FACT-10]`.
- **[OAR-DOC-11]** `enforcement` is optional, one of `enforce`, `monitor`. Its default MUST
  be `enforce`.
- **[OAR-DOC-12]** `mandatory` is an optional boolean. Its default MUST be `false`.
- **[OAR-DOC-13]** `on_error` is optional. Its value MUST be `fail_closed`, `fail_open`, or
  a rule identifier to substitute. Its default MUST be `fail_closed`.
- **[OAR-DOC-14]** `on_fire` is an optional list of declared engine side-effects drawn from
  the closed vocabulary in section 6. Its default MUST be the empty list.
- **[OAR-DOC-15]** `stream` is optional, one of `buffered`, `chunk`. Its default MUST be
  `buffered`.
- **[OAR-DOC-16]** `references` is an optional object of interoperability taxonomy tags. It
  MUST NOT affect any decision.
- **[OAR-DOC-17]** `detector` is an object carrying a `ref`. A document with
  `kind: detector` MUST carry it; a document with any other `kind` MUST NOT.
- **[OAR-DOC-18]** A document MAY carry presentation copy describing the finding and the
  remedy, in the members `what`, `cause`, `why`, `fix`, `instead`, and `message`. Copy
  fields MUST NOT affect selection, evaluation, ordering, or precedence. A rule's copy MAY
  bind facts, in the language of Appendix B; a hint's copy is static — see section 9.

### 2.1 Optional fields

Every field in this subsection is optional.

- **[OAR-DOC-19]** `tools` is a deprecated top-level list of tool names retained from
  earlier drafts of this specification. An engine MUST continue to accept it and MUST treat it as equivalent to
  `selector.tools` when `selector.tools` is absent. New documents SHOULD use
  `selector.tools`.
- **[OAR-DOC-20]** A document MAY carry implementation extension fields whose names begin
  with `x-`. An engine MUST ignore an `x-` field it does not recognise, and MUST reject a
  document carrying any other field this specification does not define. An `x-` field MUST
  NOT become normative without a specification change.
- **[OAR-DOC-21]** `namespace` is an optional publisher scope matching
  `^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$`. It identifies the
  organisation publishing the rule.
- **[OAR-DOC-22]** The identity of a rule is the pair (`namespace`, `id`). An absent
  `namespace` means the loading host's own scope. Two documents sharing an `id` under
  different namespaces MUST NOT collide. The identifier an engine renders in its decision,
  and that downstream software branches on, remains the bare `id` — see `[OAR-EVAL-7]`.
- **[OAR-DOC-23]** `requires_facts` is an optional list of fact names the rule needs. An
  engine that does not provide one of them MUST reject the rule at load, naming both the
  rule and the fact, rather than failing condition compilation or evaluating a default
  value.
- **[OAR-DOC-24]** `profile` is an optional informational string, one of `portable` or
  `host`, recording the author's intent. An engine MUST NOT derive behaviour from it; the
  portability of a rule is determined by its anchor and its facts, not by this field.
- **[OAR-DOC-25]** *(obsolete)* `code`, an alias of `id` carried by an earlier draft of this
  specification, is not a field of this document model. A document carrying `code` is
  rejected as carrying a field this specification does not define ([OAR-DOC-20]).
- **[OAR-DOC-29]** `emit` is an optional provenance tag naming the pipeline stage or
  component that produced the finding. It MUST NOT affect selection, evaluation, ordering,
  or precedence, and an engine MUST NOT interpret its value.
- **[OAR-DOC-30]** `category`, `context_schema`, `scenarios`, and `evidence` are optional
  informational fields a publisher MAY attach to a rule: `category` a string tag,
  `context_schema` an object, `scenarios` a list of objects, and `evidence` an object. An
  engine MUST accept them and MUST NOT derive selection, evaluation, ordering, precedence,
  or the returned decision from them. They exist so a document that carries host-side
  guidance metadata remains loadable; their meaning is the publisher's, not the engine's.

### 2.2 Example (non-normative)

```json
{
  "spec_version": "1.0",
  "id": "READ_OUTSIDE_SCOPE",
  "title": "Read outside the declared scope",
  "kind": "policy",
  "on": "tool.pre_invoke",
  "selector": { "tools": ["read"] },
  "when": "path_outside_scope(\"read\")",
  "effect": "block",
  "on_error": "fail_closed"
}
```

---

## 3. Anchors and selection

An **anchor** names a lifecycle moment at which an engine evaluates rules. A **selector**
narrows a rule to a subset of the occurrences of that moment.

- **[OAR-SEL-1]** `on` MUST name exactly one anchor. An engine MUST reject a document whose
  `on` it cannot resolve, naming the value.
- **[OAR-SEL-2]** Selector clauses are conjunctive: a rule is selected only when *every*
  clause present in its selector matches.
- **[OAR-SEL-3]** An omitted clause is permissive — it imposes no constraint. An empty
  selector therefore matches every occurrence of the anchor.
- **[OAR-SEL-4]** At an anchor occurrence, an engine MUST select exactly those rules whose
  resolved `on` equals that anchor and whose selector clauses all match.
- **[OAR-SEL-5]** Selector clauses match machine-observable state only. An engine MUST NOT
  match a selector clause against natural-language text, and MUST NOT infer a clause value
  from prose shape, keyword lists, or substring search.
- **[OAR-SEL-6]** A selector clause naming a dimension the host does not model MUST NOT
  match. The rule is therefore not selected; this is not a load error and not a runtime
  error.
- **[OAR-SEL-7]** The selector vocabulary is closed and published as a schema. An engine
  MUST reject a document carrying a selector clause the schema does not define.

---

## 4. Evaluation

- **[OAR-EVAL-1]** An engine MUST evaluate selected rules in a deterministic order: ascending
  by `kind` in the sequence `schema`, `policy`, `invariant`, `detector`; then ascending
  lexicographically by `id`.
- **[OAR-EVAL-2]** `kind` carries no evaluation meaning beyond that order. An engine MUST
  NOT derive a threshold, a weight, or a decision from `kind`, and this specification does
  not define a separate priority field.
- **[OAR-EVAL-3]** The first selected rule that fires with effect `block` or `transform`
  MUST short-circuit the anchor occurrence: no later rule in the order is evaluated.
- **[OAR-EVAL-4]** An engine MUST resolve the decision for an anchor occurrence by
  precedence: if any rule fired with `block`, the decision is `block`; otherwise if any
  fired with `nudge`, the decision is `nudge`; otherwise if any fired with `warn`, the
  decision is `warn`; otherwise the occurrence is allowed.
- **[OAR-EVAL-5]** A rule firing with `allow` contributes no decision. It records an explicit
  pass and MUST NOT override a `block`, `nudge`, or `warn` from another rule.
- **[OAR-EVAL-6]** A decision MUST carry, at minimum, the effect and the identifier of the
  rule that produced it. It MAY carry a data map for rendering and the list of side-effects
  that were applied.
- **[OAR-EVAL-7]** The identifier carried by a decision MUST be the bare `id` of the rule
  (or the substitute identifier selected by `on_error`). Software consuming a decision MUST
  branch on that identifier and MUST NOT branch on any human-readable message text.
- **[OAR-EVAL-8]** A rule whose `enforcement` is `monitor` MUST NOT short-circuit the anchor
  occurrence, whatever its effect. Evaluation continues with the next rule in the order.
- **[OAR-EVAL-9]** An engine MUST apply the `on_fire` side-effects of every rule that fired
  and was enforced, including rules whose effect lost precedence under `[OAR-EVAL-4]`.
  Side-effects of rules never reached because of a short-circuit MUST NOT be applied.
- **[OAR-EVAL-10]** When more than one enforced rule fired with the effect that wins under
  `[OAR-EVAL-4]`, the decision MUST carry the identifier and the copy of the first of them in
  the order of `[OAR-EVAL-1]`. The others appear only on the applied-rules trace
  (`[OAR-OPS-7]`).
- **[OAR-EVAL-11]** A host applying a decision MUST give each effect this meaning: `block` —
  the action at the occurrence does not proceed; `nudge` — the action proceeds, and the
  decision's copy is delivered to the agent as guidance for its next step; `warn` — the action
  proceeds, and the decision is surfaced as a caution without asking the agent to change
  course; `transform` — the action proceeds with the replacement of `[OAR-OPS-8]`. `allow`
  produces no decision (`[OAR-EVAL-5]`). `nudge` outranks `warn` because it asks the agent to
  act.

---

## 5. Facts and conditions

- **[OAR-FACT-1]** The fact environment is *closed* and *typed*: an engine MUST declare the
  complete set of fact names, each with a type, before any rule is compiled.
- **[OAR-FACT-2]** An engine MUST reject at load a rule whose condition references an
  identifier that is not a declared fact or a declared observation function, naming the
  identifier. A mistyped fact name is a load failure, never a runtime default.
- **[OAR-FACT-3]** An engine MUST reject at load a rule whose condition is not type-correct
  against the declared environment, and MUST reject a condition whose result type is not
  boolean. A rejection for a non-boolean result MUST name the type the condition produced and
  the word `bool`, so the author can see what the expression actually is.
- **[OAR-FACT-4]** A fact is an *observation*, never a *verdict*. A fact provider MUST NOT
  publish a value that encodes a policy conclusion.
- **[OAR-FACT-5]** A fact MUST NOT bake in a threshold, and MUST NOT combine other facts in
  a policy-meaningful way. The threshold and the composition are the policy, and they belong
  in the rule where a reviewer can read and change them.
- **[OAR-FACT-6]** An engine MUST render effects only from the rule's declared `effect` and
  `on_fire`. Neither a fact provider nor a detector may render an effect.
- **[OAR-FACT-7]** An engine MAY declare parameterized *observation functions* alongside
  plain facts, for observations that are only meaningful with an argument. An observation
  function MUST obey `[OAR-FACT-4]` and `[OAR-FACT-5]` exactly as a fact does.
- **[OAR-FACT-8]** Condition evaluation MUST be free of side-effects: a condition MUST NOT
  mutate state and MUST NOT perform input or output. Every state change an engine performs
  is declared by `on_fire`.
- **[OAR-FACT-9]** A fact whose production is expensive, asynchronous, or probabilistic —
  notably a detector-supplied fact — MUST be assembled lazily: an engine MUST NOT produce it
  unless a selected rule references it.
- **[OAR-FACT-10]** `flow` matches when its steps appear, in order, as a subsequence of the
  recent activity window. The subsequence need not be contiguous. An engine MUST state the
  size of that window, in steps, in its conformance report (`[OAR-CONF-16]`).

### 5.1 Fact tiers

- **[OAR-FACT-11]** Every fact an engine declares MUST carry exactly one tier: `core`,
  `standard`, or `host`.
- **[OAR-FACT-12]** A conforming engine MUST provide every `core` fact, with the name, type,
  and observation meaning given in section 5.2.
- **[OAR-FACT-13]** An engine claiming a named *standard profile* MUST provide every fact
  and function in that profile with the declared name, type, and meaning. An engine not
  claiming the profile MUST NOT declare a fact under one of its names.
- **[OAR-FACT-14]** An engine MUST NOT redefine the name, type, or meaning of a `core` or
  `standard` fact.
- **[OAR-FACT-15]** An engine MUST publish each `host`-tier fact under a namespace it owns,
  written `<host>.<fact>`, so that two engines cannot collide on a bare name. An engine MAY
  additionally accept the bare name inside its own deployment; a rule that uses the bare
  name is not portable.

### 5.2 Core facts

Every conforming engine provides these.

<!-- oar:table core-facts -->
| Fact | Type | Observation |
|------|------|-------------|
| `tool` | `string` | The name of the tool being invoked at this anchor occurrence. |
| `tool_args` | `map<string, dyn>` | The arguments the tool was called with, as a map. |
| `session_posture` | `string` | The session's declared posture. |
| `profile` | `string` | The permission profile in force for this call. |
| `arg_validation_errors` | `list<string>` | Machine codes for argument checks that did not pass. Empty when the arguments validated. |
| `tool_args_fingerprint` | `string` | A stable digest of the tool name and arguments, for identifying a repeat of the same call. |
| `breaker_count` | `int` | How many times a circuit breaker has been incremented for this rule and session. |
| `fire_count` | `int` | How many times `increment_counter` has been applied for this rule and session since its last `reset_counter`. |
| `same_code_reject_run` | `int` | How many consecutive rejections carrying the same identifier this session has produced. |
| `is_directory` | `bool` | True when a path argument resolved to a directory. |
| `not_found` | `bool` | True when a path or artifact the call names does not exist. |
| `path_denied` | `bool` | True when a path argument resolved to a location policy refuses. |
| `policy_denied` | `bool` | True when the host's own policy layer refused the call. |
<!-- /oar:table -->

### 5.3 Core observation functions

<!-- oar:table core-functions -->
| Function | Signature | Observation |
|----------|-----------|-------------|
| `path_outside_scope` | `(string) -> bool` | True when the named tool's path arguments resolve outside the scope in force for that tool. |
<!-- /oar:table -->

### 5.4 Standard profiles

A standard profile is an optional, named bundle of facts. An engine declares which profiles
it implements. Rules using a profile's facts are portable between engines that implement
that profile.

<!-- oar:table standard-profiles -->
**Profile `content-safety`**

| Name | Type | Observation |
|------|------|-------------|
| `prompt_injection_score` | `double` | Injection likelihood from a registered detector, between 0 and 1. |
| `jailbreak_score` | `double` | Jailbreak likelihood from a registered detector, between 0 and 1. |
| `pii_entities` | `list<map<string, dyn>>` | Personal-data spans a registered detector reported. Empty when no detector ran. |
| `secret_matches` | `list<map<string, dyn>>` | Credential or secret spans a registered detector reported. Empty when no detector ran. |

**Profile `mcp`**

| Name | Type | Observation |
|------|------|-------------|
| `mcp_server_id` | `string` | The catalogue server id for this call, or empty when the call is not a bridged tool call. |
| `mcp_tool_name` | `string` | The unqualified tool name on the bridged server. |
| `mcp_qualified_tool` | `string` | The host-side name of the bridged tool. |
| `mcp_server_configured` | `bool` | True when the catalogue contains the given server id. |
| `mcp_server_enabled` | `bool` | True when the given server is configured and enabled. |
| `mcp_call_ok` | `bool` | True after a bridged call that returned without error. False before the call. |
| `mcp_error_code` | `string` | The machine error code a failed bridged call reported, never free text. |
| `mcp_schema_matched` | `bool` | True when at least one declared result schema validated the call's result. |
| `mcp_server_configured_for` | `(string) -> bool` | True when the catalogue contains the given server id. |
| `mcp_server_enabled_for` | `(string) -> bool` | True when the given server is configured and enabled. |
| `mcp_has_field` | `(string) -> bool` | True when the projected result carries the given key. |
| `mcp_field_bool` | `(string) -> bool` | The projected boolean at the given key; false when absent or wrongly typed. |
| `mcp_field_string` | `(string) -> string` | The projected string at the given key; empty when absent. |
| `mcp_field_int` | `(string) -> int` | The projected integer at the given key; zero when absent. |
<!-- /oar:table -->

The `mcp` profile's parameterized forms carry the `_for` suffix because `[OAR-FACT-19]`
forbids a fact and a function sharing a name. The suffix keeps `mcp_server_configured` and
`mcp_server_configured_for` distinct in the condition language's single namespace.

### 5.5 Fact semantics

- **[OAR-FACT-16]** The condition language's type vocabulary is closed: `bool`, `int`,
  `double`, `string`, `list<string>`, `map<string, dyn>`, and `list<map<string, dyn>>`, plus
  the function signatures of `[OAR-FACT-7]`. An engine MUST NOT declare a fact under a type
  outside this vocabulary.
- **[OAR-FACT-17]** An `int` is a signed 64-bit integer. A `double` is an IEEE 754
  double-precision value; a `double` fact whose value is not finite — NaN or an infinity —
  is a fact-provider failure under `[OAR-OPS-2]`.
- **[OAR-FACT-18]** An engine MUST check a fact's value against its declared type before the
  condition consumes it. A value that violates its declared type is a fact-provider failure
  under `[OAR-OPS-2]`, not a coercion, a default, or a silent reinterpretation.
- **[OAR-FACT-19]** Fact names and observation function names share a single namespace. An
  engine MUST NOT declare a fact and a function under the same name. A condition language
  that distinguishes them syntactically is not sufficient, because an engine may be hosted
  in a language that does not.
- **[OAR-FACT-20]** `tool_args_fingerprint` is a digest of the tool name and the tool's
  arguments, computed so that the same tool with the same arguments yields the same digest
  and a different tool, different arguments, or a different argument order yields a
  different one. The digest MUST be stable across sessions and across engines claiming the
  core, so a rule keyed on a repeat of the same call behaves identically everywhere.
- **[OAR-FACT-21]** A fact's value is fixed at the occurrence: every rule evaluated at one
  anchor occurrence observes the same value for the same fact, and a rule MUST NOT observe
  a value that differs between two evaluations at the same occurrence.
- **[OAR-FACT-22]** A `map<string, dyn>` carries dynamically typed members: the map's
  declaration fixes the map, not what each member holds. A selection into such a map reads
  the member's value. Because the member's type is not declared, an engine MUST reject at
  load a condition whose use of a selected member does not type-check against the type the
  engine assumes for it.
- **[OAR-FACT-23]** A *fact-provider failure* is a provider raising an error, a value
  violating its declared type under `[OAR-FACT-18]`, or a non-finite `double` under
  `[OAR-FACT-17]`. It is never a value the condition reads: the engine's `on_error`
  behaviour governs the rule instead.
- **[OAR-FACT-24]** A zero value is a value, not an absence. An engine MUST NOT treat a
  fact at its zero value as a fact-provider failure, and MUST NOT substitute a different
  value for it.
- **[OAR-FACT-25]** Every declared fact has a value at every occurrence. When a provider
  has nothing to report, the fact is at its zero value: `false` for `bool`, `0` for `int`,
  `0.0` for `double`, the empty string for `string`, the empty list for `list<string>` and
  `list<map<string, dyn>>`, and the empty map for `map<string, dyn>`. Absence is not a
  fact-provider failure.

---

## 6. Stateful effects

- **[OAR-FIRE-1]** `on_fire` draws from a closed vocabulary: `increment_counter`,
  `reset_counter`, `publish_event`, `increment_breaker`, `reset_breaker`. An engine MUST
  reject a document naming any other side-effect.
- **[OAR-FIRE-2]** An engine MUST apply a rule's `on_fire` actions only when that rule fired
  and its `enforcement` is `enforce`.
- **[OAR-FIRE-3]** Counters maintained by an engine MUST be exposed to rules as ordinary
  facts, so a threshold on a counter is written in the rule and not in the engine.
- **[OAR-FIRE-4]** A counter MUST be keyed by the rule identity and the session. An engine
  MAY expose additional counter scopes as `host`-tier facts.
- **[OAR-FIRE-5]** Counter facts observed while a condition is evaluated MUST reflect the
  state *before* any side-effect of the current anchor occurrence is applied, so that a
  rule's own increment cannot change the value its own condition just read.
- **[OAR-FIRE-6]** `increment_counter` and `reset_counter` maintain the counter the core fact
  `fire_count` reads; `increment_breaker` and `reset_breaker` maintain the one `breaker_count`
  reads. Each is keyed as `[OAR-FIRE-4]` requires, so a rule reads and changes only its own
  counters.
- **[OAR-FIRE-7]** `publish_event` emits one event to the host's audit channel carrying the
  rule identity (`[OAR-DOC-22]`), the anchor, and the rule's effect. It writes no fact, and an
  engine MUST NOT let it affect the decision, the trace, or any counter.

---

## 7. Operational semantics

- **[OAR-OPS-1]** `enforcement: monitor` MUST evaluate the rule and record the outcome while
  producing no effect and applying no side-effect. It is the rollout path for a rule an
  operator is not yet ready to enforce.
- **[OAR-OPS-2]** A rule *cannot be evaluated* when a fact provider fails, a detector fails,
  or its condition raises at run time. When a rule cannot be evaluated and its `on_error` is
  `fail_closed`, an engine MUST produce a `block` decision carrying that rule's identifier,
  and MUST NOT continue evaluating later rules at the occurrence.
- **[OAR-OPS-3]** When a rule cannot be evaluated and its `on_error` is `fail_open`, an engine
  MUST record the failure and continue: the rule contributes no decision and no side-effect.
- **[OAR-OPS-4]** When a rule cannot be evaluated and its `on_error` names a rule identifier,
  an engine MUST produce a `block`
  decision carrying that substituted identifier instead of the rule's own, and MUST NOT
  continue evaluating later rules at the occurrence. The substitution replaces the
  identifier only; the effect is `block`.
- **[OAR-OPS-5]** A rule with `mandatory: true` is evaluated and enforced whenever it is
  selected. Any host mechanism that disables rules, changes their enforcement, or removes
  them from a loaded rule set — an overlay, a pack replacement, a caller option — MUST refuse
  to do so for a mandatory rule, naming the rule.
- **[OAR-OPS-6]** Evaluation of content anchors is buffered by default. An engine MAY
  support `stream: chunk`; one that does not MUST reject a document requesting it rather
  than silently buffering.
- **[OAR-OPS-7]** An engine MUST record, per anchor occurrence, an applied-rules trace: for
  each selected rule, its identifier and its outcome — one of fired, passed, errored, or
  monitored. The trace is how an operator audits a decision.
- **[OAR-OPS-8]** A rule with effect `transform` MUST produce a decision that identifies the
  content to be replaced and the replacement. An engine that does not implement content
  mutation MUST reject such a rule at load rather than treating it as a `block`.
- **[OAR-OPS-11]** A rule whose `enforcement` is `monitor` and that cannot be evaluated MUST
  be recorded as errored and MUST NOT produce a decision, whatever its `on_error`. Monitoring
  never acts, including on its own failures; `on_error` governs only enforced rules.
- **[OAR-OPS-12]** An engine MUST reject at load a document with `mandatory: true` and
  `enforcement: monitor`, naming the rule. A rule cannot be both required and not enforced.

### 7.1 Content-safety surface

Model input and output are anchors like any other, and a content-safety guardrail is an
ordinary rule: a detector publishes observation facts, and the rule sets the threshold.

- **[OAR-OPS-9]** A detector MUST return observations — scores, spans, entity lists — and
  MUST NOT return a verdict. The rule's condition owns every threshold.
- **[OAR-OPS-10]** A detector reference is a URI of the form `detector://<name>`. An engine
  MUST reject a `kind: detector` rule whose reference it cannot resolve.

---

## 8. Portability profiles

Two profiles determine whether a rule travels: the **anchor profile** (which lifecycle
moments a host has) and the **fact profile** (which observations it publishes).

- **[OAR-PROF-1]** This specification fixes eight *core anchors*. Their identifiers and
  meanings are given in section 8.1 and MUST NOT be redefined by a host.
- **[OAR-PROF-2]** A host MUST publish an *anchor profile map* declaring, for each core
  anchor, either the local anchor that implements it or that it is unsupported. Every core
  anchor MUST appear exactly once across the two declarations.
- **[OAR-PROF-3]** An engine MUST resolve a rule whose `on` is a core anchor through the
  profile map before selection. A rule targeting a core anchor the host declares
  unsupported MUST be rejected at load, naming the anchor.
- **[OAR-PROF-4]** A host MAY accept host-native `on` values naming anchors in its own
  catalogue. Such rules are valid OAR documents and MUST load; they are not portable.
- **[OAR-PROF-5]** A rule is **portable** if and only if its `on` is a core anchor and its
  condition references only `core`-tier facts, facts from standard profiles it declares, and
  observation functions of those tiers. This specification promises identical behaviour
  across conforming engines for portable rules only.
- **[OAR-PROF-6]** An engine MUST reject at load any rule listing in `requires_facts` a fact
  it does not provide, naming the rule and the fact.
- **[OAR-PROF-7]** An engine SHOULD offer a portability report identifying, for a given
  rule, the host-native anchor or host-tier facts that make it non-portable. The report MUST
  NOT be a load failure — a non-portable rule is legal.

### 8.1 Core anchors

<!-- oar:table core-anchors -->
| Core anchor | Lifecycle moment |
|-------------|------------------|
| `tool.pre_invoke` | Before a tool call is dispatched, with the tool name and arguments observable and nothing executed yet. |
| `tool.handler` | Inside the tool's own handler, after argument validation and before the effect it performs. |
| `tool.post_invoke` | After a tool call returns, with the result observable and before it is handed back to the agent. |
| `agent.post_turn` | After an agent produces a turn that called no tool — the moment a claim can be checked against evidence. |
| `agent.finalize` | After a worker or child agent completes and its summary is available. |
| `model.input` | User and retrieved content assembled for the model, before the model consumes it. |
| `model.output` | A model response, before it is shown to a person or acted on. |
| `model.tool_result` | Content returned by a tool or retrieval step, before the model consumes it. |
<!-- /oar:table -->

### 8.2 Profile map (non-normative example)

```yaml
oar_profile_version: "1.0"
core:
  tool.pre_invoke: tool.pre_invoke
  tool.handler: tool.handler
  tool.post_invoke: tool.post_invoke
  agent.post_turn: coordinator.post_turn
  agent.finalize: worker.finalize
unsupported:
  - model.input
  - model.output
  - model.tool_result
```

---

## 9. The hint channel

Some situations a host handles are not decisions about an action in flight: a tool's output
was capped, a workflow phase ended, a secret was redacted on the way out. The guard pipeline
has no fact that identifies them — they are observations the host raises on its own, after or
outside the pipeline, and no `when` condition can select them. Publishing their copy as rules
would force either a fact family the format does not have or an enforcement mode that means
"never evaluate". The hint channel is the format's answer: a document class that publishes
presentation copy keyed by a code, and takes no part in evaluation at all.

- **[OAR-HINT-1]** A document whose `kind` is `hint` is a hint document. It MUST contain
  `spec_version`, `id`, and `kind`, and MUST NOT contain `on`, `selector`, `effect`, `when`,
  `flow`, `enforcement`, `mandatory`, `on_error`, `on_fire`, `stream`, `detector`,
  `requires_facts`, `tools`, or `profile`. An engine MUST load hint documents it finds in a
  rule set and MUST NOT select or evaluate them.
- **[OAR-HINT-2]** A hint document's `id` is the code the host raises. It follows the
  identifier grammar of `[OAR-DOC-4]`. A hint MUST carry at least one copy field
  (`[OAR-DOC-18]`): a hint that publishes no copy is not a hint.
- **[OAR-HINT-3]** A hint's copy is static. It MUST NOT carry the bindings of Appendix B:
  the host raising a code has no fact environment, and there is nothing for a binding to
  name. Copy members a hint omits are simply absent.
- **[OAR-HINT-4]** When a host raises a code, it renders the copy of the hint registered
  under that `id` when one is loaded, and otherwise the bare code. A host MAY raise codes
  where no hint channel is loaded at all. Which hints a host loads, and where it keeps them,
  is the host's own convention and is not normative here.
- **[OAR-HINT-5]** A hint document is validated at load like any document: schema, version
  gate, and unknown fields. An engine MUST report a load error in a hint and MUST NOT
  silently ignore it. A hint that failed to load MUST NOT be rendered.
- **[OAR-HINT-6]** A hint MUST NOT affect selection, evaluation, ordering, precedence, or
  any decision, and MUST NOT carry side-effects. Two rule sets differing only in hint
  documents MUST produce identical decisions.

A hint document looks like this (non-normative):

```json
{
  "spec_version": "1.0",
  "id": "TOOL_OUTPUT_SPILL_CAPPED",
  "kind": "hint",
  "title": "Tool output spill capped",
  "severity": "info",
  "what": "The tool's output was capped before it reached the model.",
  "why": "Uncapped output can crowd out the conversation and hide the part that matters.",
  "fix": "Ask for the specific slice you need instead of the whole result."
}
```

---

## 10. Conformance

### 10.1 The runner algorithm

The requirements below define the evaluation algorithm end to end. Each step is separately
identified so a conformance fixture can cite it.

- **[OAR-CONF-1]** Load each rule document and validate it against the published OAR schema.
  An engine MUST reject a document that fails validation, naming the failing field.
- **[OAR-CONF-2]** An engine MUST reject a document whose `spec_version` major is
  unsupported, before any other processing of that document.
- **[OAR-CONF-3]** An engine MUST resolve `on`: a core anchor identifier through the anchor
  profile map, any other value as a host-native anchor identifier.
- **[OAR-CONF-4]** An engine MUST reject a rule whose `requires_facts` are not all provided
  by the host.
- **[OAR-CONF-5]** An engine MUST type-check `when` against the declared fact environment
  and MUST reject the rule on an unknown identifier or a type error.
- **[OAR-CONF-6]** At an anchor occurrence, an engine MUST select the rules whose resolved
  `on` matches and whose selector clauses all match.
- **[OAR-CONF-7]** An engine MUST assemble the facts the selected rules reference. A fact
  provider failure MUST be handled per the rule's `on_error`.
- **[OAR-CONF-8]** An engine MUST evaluate `when`. A rule with neither `when` nor `flow`
  fires whenever it is selected.
- **[OAR-CONF-9]** An engine MUST record but not act on a rule whose `enforcement` is
  `monitor`: no effect, no side-effect, no short-circuit.
- **[OAR-CONF-10]** An engine MUST order evaluation by `kind` then `id`, and the first
  enforced rule firing with `block` or `transform` MUST short-circuit the occurrence.
- **[OAR-CONF-11]** An engine MUST apply decision precedence: `block`, then `nudge`, then
  `warn`, otherwise allow.
- **[OAR-CONF-12]** An engine MUST apply the `on_fire` actions of every rule that fired and
  was enforced.

### 10.2 Fixture shape

- **[OAR-CONF-13]** A conformance fixture is a JSON object with `input` and `expected` and at
  least one of `rule` and `hints`. `rule` is a rule document or a list of rule documents;
  `hints` is a list of hint documents (`[OAR-HINT-1]`) the engine loads and never evaluates.
  `input` carries the `anchor` at which the occurrence happens and a `facts` map, and MAY carry
  `recent_tools` (the recent activity window `flow` matches against), `session_id` (the
  scope counters are keyed by), `host_facts` (a map naming each `host`-tier fact the
  fixture supplies and its declared type, `[OAR-FACT-25]`), and `profile` (an anchor
  profile map). `expected` describes the outcome the engine MUST produce.
- **[OAR-CONF-19]** When `input.profile` is present, an engine running the fixture MUST
  resolve the fixture's `on` values through that map instead of its own, and MUST otherwise
  behave exactly as it would for its own map. A fixture whose outcome depends on which core
  anchors a host supports MUST carry one — without it the fixture asks every implementation a
  different question, which the corpus promises never to do.
- **[OAR-CONF-14]** A fixture MUST carry an `id` equal to its file name stem and a non-empty
  `covers` list of clause identifiers defined by this specification.
- **[OAR-CONF-15]** `expected` MAY carry any of seven keys, and a fixture asserts only the ones
  it is about. `decision` is the effect the occurrence resolves to, or `none` when nothing
  actionable is produced. `code` is the identifier the decision carries. `on_fire` lists the
  side-effects the winning rule declared. `applied` is the ordered applied-rules trace, each
  entry written `<rule id>:<outcome>` with the outcome one of `fired`, `passed`, `errored`,
  `monitor`. `counters` maps a rule identifier to the counter values expected after the
  occurrence. `copy` maps copy members to the rendered text the decision carries
  (`[OAR-COPY-7]`) and asserts only the members it names; `null` asserts that the decision
  carries no copy (`[OAR-COPY-10]`). `error` asserts a load-time rejection and matches when
  the engine's error contains the given text; an engine MUST NOT be required to match error
  wording beyond that substring. An engine MUST reject a fixture carrying any other `expected` key rather than
  passing it silently.
- **[OAR-CONF-16]** An implementation claiming conformance MUST pass every fixture in the
  published corpus whose clauses fall within the profiles it declares, and MUST report which
  fixtures it skipped and why.
- **[OAR-CONF-17]** Every fixture in the published corpus MUST use core anchors and facts of
  `core` or `standard` tier only, so that a fixture can be run by an implementation that
  models no host-specific state.
- **[OAR-CONF-18]** Three detector references are reserved for the corpus, and an engine
  running it MUST provide all three: `detector://noop` reports no findings; `detector://error`
  always fails, which is how a fixture reaches the `on_error` path; and `detector://fixture`
  reports no findings of its own, leaving the detector facts the fixture supplied in place,
  which is how a fixture proves the rule owns the threshold. None of the three requires a
  model or a network.

---

## 11. Extensibility and versioning

- **[OAR-DOC-26]** A minor revision MUST be additive: it may add optional fields and enum
  members, and MUST NOT remove or rename a required field or change the decision an existing
  valid document produces.
- **[OAR-DOC-27]** A change that breaks a valid document of the current major version MUST
  bump the major version.
- **[OAR-DOC-28]** A published version of this specification is immutable. A correction MUST
  ship as a new version rather than an edit in place.

---

## Appendix A — Change log

| Version | Change |
|---------|--------|
| 1.0 | First published document model, selector, evaluation, facts, stateful effects, operational semantics, and conformance fixture shape; core anchors and the anchor profile map, fact tiers and host namespaces, `namespace`, `requires_facts`, `profile`, and the `x-` extension and closed unknown-field policies. Adds the hint channel (`kind: hint`, section 9) for host-raised copy keyed by code, copy bindings (Appendix B), the condition language (Appendix C), and the fact-semantics clauses `[OAR-FACT-16]`–`[OAR-FACT-25]`; the `mcp` profile's parameterized functions take the `_for` suffix. |

An earlier public draft of this version, posted at the same URL before publication, carried
copy-only units as `enforcement: off` rules and used the field names `oar`, `anchor`,
`requires`, and `code`. It was never frozen; this text supersedes it.

---

## Appendix B — Copy bindings (normative)

`copy` members are presentation strings. They MAY contain bindings that name declared facts.
The engine substitutes those bindings after the decision is resolved, so two engines that
agree on the decision also agree on the prose that explains it. The language is frozen and
small: a substitution, a conditional, and nothing else. It is not the condition language of
section 5, and it is not a host template dialect. A hint's copy carries no bindings
(`[OAR-HINT-3]`).

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

- **[OAR-COPY-1]** After the decision is resolved, the engine MUST render each copy member
  (`[OAR-DOC-18]`) of the rule whose identifier the decision carries, substituting the bindings of this appendix against the fact
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
  `false`; an `int` as a base-10 integer; a `double` in the canonical decimal form of
  `[OAR-COPY-9]`; and a `list<string>` as its members joined by `", "` (U+002C U+0020), or
  the empty string when the list is empty. An engine MUST reject at load a binding whose
  fact's type is not one of those. Observation functions, `map<string, dyn>`, and
  `list<map<string, dyn>>` cannot be interpolated.
- **[OAR-COPY-5]** A name appearing in a copy binding or conditional is a fact the rule
  references for `[OAR-FACT-9]` and `[OAR-PROF-5]`. A non-core fact named only in `copy` MUST
  still be reached through `requires_facts` (`[OAR-DOC-23]`): copy is presentation, not an
  exemption from the portability contract.
- **[OAR-COPY-6]** Rendered copy MUST NOT affect selection, evaluation, ordering, precedence,
  or the returned effect. Two rules whose `copy` differs only in bindings or prose MUST
  produce identical decisions when their other fields are equal.
- **[OAR-COPY-7]** A decision other than `none` MUST carry the rendered `copy` object of the
  rule whose identifier it carries (`[OAR-EVAL-6]`). Members the rule omitted remain absent.
  A binding whose fact is at its zero value substitutes that zero value (`[OAR-FACT-24]`,
  `[OAR-FACT-25]`); it does not remove the member or the decision.
- **[OAR-COPY-8]** Whitespace inside `{{ }}` and `{% %}` is permitted and insignificant. An
  engine MUST accept `{{tool}}` and `{{ tool }}` as the same binding.
- **[OAR-COPY-9]** A double MUST render as the shortest decimal significand that round-trips
  to the same finite binary64 value, choosing the closest decimal and ties to an even
  significand. Expand exponent notation into ordinary decimal notation, include a leading
  zero before a fractional value, and append `.0` when there is no fractional part. Both
  signed zeroes render as `0.0`. A negative value has one leading minus. For example: `1.0`,
  `0.0000001`, `-2.5`, and `0.0`. A non-finite `double` never reaches rendering: it is a
  fact-provider failure under `[OAR-FACT-17]` before rendering begins.
- **[OAR-COPY-10]** If rendering the copy for an `on_error` block itself fails because a
  required observation is unavailable or has the wrong runtime type — a fact-provider failure
  under `[OAR-FACT-23]` — the engine MUST omit the entire rendered copy object, retain the
  block and its rule identifiers, and MUST NOT coerce the failed observation or substitute
  its zero value. This presentation failure MUST NOT start another `on_error` evaluation.

---

## Appendix C — The condition language (normative)

`when` is written in a small, frozen expression language. Its syntax is a subset of CEL's, so
a host with a CEL implementation can evaluate it by declaring the fact environment and the
built-ins of C.3 and refusing what the grammar below cannot derive. It is specified on its own
so that a host without CEL can implement it completely, and so that two engines cannot
disagree about what a condition means.

The language is defined as much by what it leaves out: no macros, no comprehensions, no
method calls, no indexing, no regular expressions, no time, no random source, and no null.
Regular expressions are left out because their dialects differ across host languages, which
would make one portable rule decide differently on two conforming engines.

### C.1 Grammar

```ebnf
condition      = disjunction [ "?" condition ":" condition ] ;
disjunction    = conjunction { "||" conjunction } ;
conjunction    = relation { "&&" relation } ;
relation       = addition [ relop addition ] ;
relop          = "==" | "!=" | "<" | "<=" | ">" | ">=" | "in" ;
addition       = multiplication { ( "+" | "-" ) multiplication } ;
multiplication = unary { ( "*" | "/" | "%" ) unary } ;
unary          = ( "!" | "-" ) unary | primary ;
primary        = literal | call | reference | "(" condition ")" ;
call           = name "(" [ condition { "," condition } ] ")" ;
reference      = name [ "." name ] ;
literal        = "true" | "false" | int | double | string | list ;
list           = "[" condition { "," condition } "]" ;
name           = ( letter | "_" ) { letter | digit | "_" } ;
int            = digit { digit } ;
double         = digit { digit } ( fraction [ exponent ] | exponent ) ;
fraction       = "." digit { digit } ;
exponent       = ( "e" | "E" ) [ "+" | "-" ] digit { digit } ;
string         = '"' { dquote-char } '"' | "'" { squote-char } "'" ;
dquote-char    = escape | ? any code point except '"', "\" ? ;
squote-char    = escape | ? any code point except "'", "\" ? ;
escape         = "\" ( "\" | '"' | "'" | "n" | "r" | "t" ) ;
```

- **[OAR-EXPR-1]** An engine MUST accept every condition this grammar derives, subject to
  the type rules of C.2, and MUST reject at load every condition it does not derive, naming
  the offending construct and its offset in the source. A load-time rejection under this
  appendix MUST cite the identifier of the clause it applies, such as `[OAR-EXPR-9]`, so that
  a diagnostic can be checked without matching its wording.
- **[OAR-EXPR-2]** A `reference` with no dot names a declared fact. A `reference` `a.b`
  names the `host`-tier fact `a.b` (`[OAR-FACT-15]`) when one is declared, and otherwise
  selects the member `b` of the `map<string, dyn>` fact `a` (`[OAR-FACT-22]`). Anything else
  MUST be rejected at load as an unknown identifier. An engine MUST NOT declare a `host`-tier
  fact whose namespace is the name of another declared fact, so that a reference never has
  two readings.
- **[OAR-EXPR-3]** A string literal accepts only the escapes `\\`, `\"`, `\'`, `\n`, `\r`,
  and `\t`. An engine MUST reject any other escape.
- **[OAR-EXPR-4]** Precedence, tightest first: unary `!` and `-`; `*` `/` `%`; `+` `-`; the
  relational operators; `&&`; `||`; the ternary. Binary operators of equal precedence
  associate left and the ternary associates right. A `relation` holds at most one relational
  operator, so `a < b < c` and `a == b == c` MUST be rejected rather than grouped.
- **[OAR-EXPR-5]** `&&` and `||` MUST short-circuit: an engine MUST NOT evaluate the right
  operand when the left decides the result, so a cheap guard can protect a sub-expression that
  would raise.
- **[OAR-EXPR-6]** `true`, `false`, and `in` are reserved words, and an engine MUST NOT
  declare a fact or function under one of them. A name is lexed greedily, so `international`
  is one name. Whitespace between tokens is insignificant. A comment is not part of the
  language, and an engine MUST reject a condition containing one.

### C.2 Types

- **[OAR-EXPR-7]** The value types are those of `[OAR-FACT-16]`. There is no null: every
  declared fact has a value at every occurrence (`[OAR-FACT-25]`), and `null` is an unknown
  identifier. A list literal MUST have at least one member, and every member MUST be a
  `string`; the literal is then a `list<string>`. An engine MUST reject any other list
  literal at load.
- **[OAR-EXPR-8]** `&&`, `||`, and `!` take and produce `bool`. A ternary's condition MUST be
  `bool` and its two branches MUST have the same type, which is the ternary's type.
- **[OAR-EXPR-9]** `+` `-` `*` `/` take two `int` or two `double` and produce that type; `%`
  takes two `int`; `+` also takes two `string` and concatenates them. There is no implicit
  conversion between `int` and `double`. Integer division truncates toward zero, so `-7 / 2`
  is `-3` and `-7 % 2` is `-1`. An engine MUST reject any other operand pair at load.
- **[OAR-EXPR-10]** `<` `<=` `>` `>=` take two `int`, two `double`, or two `string`, and
  produce `bool`. Strings compare by Unicode code point. An engine MUST reject any other
  operand pair at load, including an `int` against a `double`: write `0.5`, not `1 / 2`, and
  `1.0`, not `1`, against a score.
- **[OAR-EXPR-11]** `==` and `!=` take two operands of the same type, one of `bool`, `int`,
  `double`, or `string`, and produce `bool`. An engine MUST reject a comparison of unrelated
  types, or of lists or maps, at load rather than returning `false`: a type-confused
  comparison is a policy that silently never fires. Test an aggregate with `size()` or `in`.
- **[OAR-EXPR-12]** `in` takes a `string` on the left and either a `list<string>`, testing
  membership, or a `map<string, dyn>`, testing key presence, on the right, and produces
  `bool`. An engine MUST reject any other operand pair at load.
- **[OAR-EXPR-13]** A member selected from a `map<string, dyn>` (`[OAR-EXPR-2]`) has type
  `string`. A member that is absent reads as the empty string. A member that is present and is
  not a string MUST raise when evaluated, and the rule is then handled per its `on_error`.
- **[OAR-EXPR-14]** Integer division or modulo by zero, integer arithmetic that overflows 64
  bits, and `double` arithmetic whose result is not finite MUST raise, and the rule is then
  handled per its `on_error`. An engine MUST NOT wrap an integer or produce an infinity or NaN.
- **[OAR-EXPR-15]** An `int` literal MUST fit in a signed 64-bit integer and a `double`
  literal MUST have a finite nearest binary64 value. An engine MUST reject any other literal
  at load.

### C.3 Calls and built-in functions

- **[OAR-EXPR-16]** A `call` names a built-in of the table below or a declared observation
  function (`[OAR-FACT-7]`). Its arguments MUST match the declared signature in number and
  type, and an engine MUST reject any other call at load, naming the function.
- **[OAR-EXPR-17]** The language defines exactly these four built-ins. An engine MUST NOT
  define another, and MUST NOT declare a fact or an observation function under one of their
  names. An observation an engine wants to offer is an observation function, subject to the
  tier rules of section 5.

  | Built-in | Signature | Meaning |
  |----------|-----------|---------|
  | `size(x)` | `(string \| list<string> \| list<map<string, dyn>> \| map<string, dyn>) -> int` | The number of members, or for a `string` the number of Unicode code points. |
  | `starts_with(s, prefix)` | `(string, string) -> bool` | True when `s` begins with `prefix`. |
  | `ends_with(s, suffix)` | `(string, string) -> bool` | True when `s` ends with `suffix`. |
  | `contains(s, substring)` | `(string, string) -> bool` | True when `substring` occurs in `s`. |

- **[OAR-EXPR-18]** The string built-ins compare by Unicode code point, with no
  normalisation, no case folding, and no locale. An empty `prefix`, `suffix`, or `substring`
  matches every string.

### C.4 Limits

- **[OAR-EXPR-19]** An engine MUST accept a condition of at least 256 nodes. It MAY reject a
  larger one, and MUST then state its limit in its conformance report (`[OAR-CONF-16]`). A
  node is one literal, reference, call, unary, binary, or ternary operation; a list literal is
  one node plus one per member, and parentheses are not nodes.
- **[OAR-EXPR-20]** Evaluation MUST terminate. The language has no loop, no recursion, and no
  user-defined function, so an implementation of this grammar satisfies this by construction.
