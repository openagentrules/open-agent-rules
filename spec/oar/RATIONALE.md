# Why Open Agent Rules

## The problem

Every agentic system has to bound what happens next — repeatedly, and in ways that keep
changing. That is what working with a nondeterministic generator is. A tool call that
reads outside scope, a secret that must be redacted, a nudge after an ungrounded claim,
a recorded miss, a content filter: the same work. People often call the filter case a
guardrail. The scaffold is larger than the filter.

That work is code today: a callback, a plugin, a predicate over the host's request
object. A reviewer cannot read it, it cannot be diffed, it cannot be tested without the
host, and it cannot be moved.

A rule should cover the scaffold, not only the filter, and it should be a document you
can read, diff, test, and move.

## Observation, not verdict

The idea that makes this work is a division of labour:

> The host produces facts. The rule composes facts. The engine renders effects.

A **fact** is an observation the host publishes about its own state — typed, named, and free
of judgement. `prompt_injection_score` is a fact: it is a number a detector reported, and it
says nothing about whether the content should be delivered. `content_is_unsafe` is *not* a
fact. It is a conclusion, and the moment a host publishes it, the policy has moved back into
the host's code where nobody can read it.

The distinction is not stylistic. The **threshold** and the **composition** are the policy —
they are the parts an operator argues about, tunes, and audits. So they have to live where a
reviewer can see and change them:

```yaml
when: 'prompt_injection_score > 0.8 && tool != "internal_search"'
```

Everything about that line is reviewable. The detector produced a number; the *rule* decided
that 0.8 is the bar and that the internal search tool is exempt. Move the threshold into the
detector and the same policy becomes invisible.

This is why the specification states observation-not-verdict as a requirement on fact
providers rather than as advice. A format whose facts may contain verdicts degenerates into
the callback model with extra syntax.

## One rule, annotated (non-normative)

```yaml
spec_version: "1.0"             # format version
id: READ_OUTSIDE_SCOPE          # stable; the identifier the decision carries
namespace: acme.security        # publisher scope; identity is (namespace, id)
kind: policy                    # fixes evaluation order, nothing else
on: tool.pre_invoke             # a core anchor: before the tool runs
selector:
  tool: [read, grep]            # the clause names the `tool` fact; clauses are AND
requires_facts:                 # what this rule needs the host to provide
  - workspace_root
when: 'path_outside_scope(workspace_root, tool_path)'   # composition of observations
effect: block                   # what the engine does when the condition holds
on_error: fail_closed           # if this cannot be evaluated, block
what: "The call reads outside the declared scope."
fix: "Read inside scope, or widen the scope deliberately."
```

Eight lines carry the whole policy, and the copy fields carry the explanation the caller
sees. Members MAY contain the frozen bindings of Appendix B — `{{ fact }}` and
`{% if fact %}` — so occurrence values reach the prose without a host template
dialect. The engine substitutes after the decision; two rules that differ only
in copy still produce the same decision.
`on` and `selector` say *where*; `when` says *whether*; `effect` and `on_error` say *what
happens*, including when the check itself fails. `requires_facts` is the line that makes
portability computable: a reader can tell from the document alone which engines will run it,
without consulting any of them. Clause references:
[`[OAR-SEL-1]`](https://openagentrules.org/spec/1.0/#3-anchors-and-selection),
[`[OAR-EVAL-4]`](https://openagentrules.org/spec/1.0/#4-evaluation),
[`[OAR-DOC-22]`](https://openagentrules.org/spec/1.0/#2-1-optional-fields),
[`[OAR-OPS-2]`](https://openagentrules.org/spec/1.0/#7-operational-semantics).

## Why not Rego, or Cedar

Rego and Cedar are mature, well-tooled, and more expressive than anything here. They are also
solving a different problem, and the difference is the whole point.

Both evaluate arbitrary policy over arbitrary input. That generality is their strength for
authorisation, and it is exactly what stops a rule from travelling: every deployment
invents its own input document. A Rego policy for one agent runtime reads
`input.request.tool.name`; the next reads `input.action.id`. Both are valid Rego. Neither rule
runs on the other's system, and neither can be tested without that system's input shape.

Open Agent Rules fixes the vocabularies that generality leaves open: the lifecycle moments
(core anchors), the typed observations (the fact tiers), and the
condition language. That is a real loss of expressiveness, and it buys three things nothing
else on the list has — a rule that runs unchanged on another engine, a rule that can be tested
against a published fixture corpus without the host, and a rule whose complete input surface is
enumerable.

What they do better: maturity, tooling, formal analysis (Cedar's decisions are verifiable),
and expressiveness for policies that are not this problem. If your problem is
authorisation over your own resource model, use Cedar. If it is "what may this agent do at
this moment", the vocabularies are the value.

## Why not a plugin or callback API

The incumbent shape in agent gateways and content-safety products is registration: you write a
class or a function, register it under a hook name, and it returns a verdict.

It is the same problem as the first section, aimed at a friendlier surface. The plugin *owns
the verdict*, so the threshold, the exemptions, and the scoping all live inside code. That
makes the policy unreadable to anyone who is not reading the source, untestable without running
the host, and non-portable by construction, since the plugin is written against the host's own
hook signature and request object.

Open Agent Rules does not replace that seam — it inverts it. A detector is still code, and
still a plugin. What changes is that the detector returns *observations* and the rule owns the
decision. You keep the extensibility and get a policy you can read.

## Why not a manifest that wraps a policy engine

A newer shape splits the difference: standardise the harness — the lifecycle hook names, the
verdict vocabulary, the adapter interface — and delegate the condition itself to a pluggable
policy engine. The manifest is portable; the policy inside it is Rego, or Cedar, or whatever
the deployment chose.

This fixes the half of the problem that was never the hard half. Everyone already agreed that
agents have lifecycle moments and that verdicts come in a few flavours; what no two
deployments agree on is the *input document the condition reads*. A manifest that carries a
Rego policy still carries a policy written against one host's input shape, so the rule still
does not travel, still cannot be tested without that host, and still has no enumerable input
surface — the manifest just gives the non-portable part a portable envelope. Open Agent Rules
fixes the other half instead: the condition language and the fact vocabulary are the
specification, which is the part that makes the same document produce the same decision on two
engines that share nothing but this text.

The two shapes are not enemies. A harness standard needs *something* portable to carry, and a
rule document needs hosts with well-named lifecycle moments to anchor to. An engine embedded
behind such a harness can evaluate OAR documents as one of its policy backends.

## Not instructions to the model

The name invites one confusion worth spending a paragraph on. `AGENTS.md`, `CLAUDE.md`, and
editor rules files are *instructions to the model*: prose the agent reads and — being a
model — may misread, deprioritise, or ignore. Open Agent Rules are *rules for the engine*: the
model never sees them, and cannot talk its way past one. Instructions shape what the agent
tries to do; rules bound what the host lets it do. Ship both — they answer different
questions.

---

The sections below explain the format's main design choices and their tradeoffs.

## Fact tiers and the portability contract

A single mandatory fact catalogue would require every conforming engine to provide every fact.
A model gateway with no file system would still have to publish `is_directory`, most likely as
`false` forever. A rule written against it would load, evaluate, and mean nothing while the
operator sees a passing conformance run.

1.0 answers with tiers instead of a catalogue
([`[OAR-FACT-11]`](https://openagentrules.org/spec/1.0/#5-1-fact-tiers)). A `core` fact is one
every conforming engine provides ([`[OAR-FACT-12]`]). A `standard` fact belongs to a named
profile — content safety, MCP — that an engine provides whole or not at all
([`[OAR-FACT-13]`]). A `host` fact is the engine's own observation, published under a
namespace it owns so that two engines cannot collide on a bare name
([`[OAR-FACT-15]`]). Nothing is stubbed, because nothing has to be.

The rule's side of the contract is `requires_facts`
([`[OAR-DOC-22]`]): the rule names the facts it needs, and an engine that does not provide one
of them rejects the rule at load
([`[OAR-CONF-4]`](https://openagentrules.org/spec/1.0/#10-conformance)) rather than failing
condition compilation or evaluating a default. A rule is *portable* — the word the format
commits to — when its anchor is a core anchor and its facts come from the core and standard
tiers ([`[OAR-PROF-5]`](https://openagentrules.org/spec/1.0/#8-portability-profiles)); the
host publishes an anchor profile map saying which core anchors it supports
([`[OAR-PROF-2]`]), so the same negotiation covers the moments, not only the facts.

This is capability negotiation, which is how the Model Context Protocol handles the same
problem: a server advertises what it has, a client asks for what it needs, and the absence of a
capability is something both sides can see rather than a silently degraded call. The closer
analogue for a *document format* is JSON Schema's `$vocabulary` map, which splits declared
vocabularies into required and optional — an implementation that does not recognise a
vocabulary marked required must refuse the schema rather than validate part of it. Both designs
make the same trade: a more complicated handshake, in exchange for never being wrong about what
the other side actually does.

The cost is real. A rule now has to say what it needs, and a rule that omits the declaration
for a fact outside the core tier is rejected. That is one
more line per rule, and it is the line that makes portability a property of the document rather
than a claim about it.

## Selector clauses are fact names

A fixed selector vocabulary such as `principal`, `ledger`, `surface`, `phase`, and `workflow`
would give those clauses no defined relationship to a fact, no declared type, and no sound
behavior on an engine that does not model them. Silently matching such a clause would turn a
scope into a no-op.

Read that again with `principal` in mind. `principal` is the multi-tenant scoping clause — the
one an operator writes to say *this rule applies to that customer's traffic*. On an engine with
no principal model, a rule scoped to one tenant applied to all of them, and a rule scoped to an
administrative principal applied to everybody. Failing open on a scoping clause is not a
cosmetic gap in a specification. It is a security bug that reads, in the configuration file,
exactly like a working scope.

A selector clause names a declared fact, and an engine rejects at load a clause naming a
fact it does not declare
([`[OAR-SEL-3]`](https://openagentrules.org/spec/1.0/#3-anchors-and-selection)). There is no
second vocabulary to keep in sync, no clause without a type, and no way to write a scoping
clause an engine will quietly ignore. The failure moved from runtime silence to a load error
that names the clause, which is the only kind of failure an operator can act on.

## One decision per occurrence

An occurrence gets one decision. Several rules may fire at it; the format says exactly how
they combine, and it does so with three sentences rather than a negotiation mechanism.

The order is fixed: ascending by `kind` in the sequence `schema`, `policy`, `invariant`,
`detector`, then ascending lexicographically by `id`
([`[OAR-EVAL-1]`](https://openagentrules.org/spec/1.0/#4-evaluation)). The first rule that
fires with `block` or `transform` short-circuits the occurrence
([`[OAR-EVAL-3]`]). What survives short-circuit resolves by precedence: `block`, then `nudge`,
then `warn`, then the occurrence is allowed ([`[OAR-EVAL-4]`]).

Composition is therefore *ordering*, and a pack composes two rules by writing them in an order
the format guarantees. The common case is specificity: a specific refusal and a general flag
both match one call, the specific rule's identifier sorts first, its block short-circuits the
occurrence, and the general rule is never evaluated. A 1.0-era `overrides` field existed to
produce exactly this outcome; the deterministic order produces it without a second mechanism to
misconfigure, and without a graph to cycle.

Nothing that fired is silently dropped. Every selected rule leaves its identifier and outcome
— fired, passed, errored, or monitored — on the applied-rules trace
([`[OAR-OPS-7]`](https://openagentrules.org/spec/1.0/#7-operational-semantics)), which is how
an operator audits a decision. The decision names the winner; the trace is the full story.
A `monitor` rule is recorded on the same trace and produces no effect
([`[OAR-OPS-1]`]), which is the rollout path: watch a rule in production before enforcing it.

The same reasoning retired the advisory list. When several nudges and warnings hold of one
occurrence, earlier drafts carried them all on an `advisories` list; 1.0 resolves one decision by
precedence and records the rest on the trace. A consumer that branches on a single identifier
has one; an operator who wants the rest reads the trace. Two surfaces, each doing one job,
instead of one surface doing both.

## Copy is frozen substitution

Copy — `what`, `cause`, `why`, `fix`, `instead`, `message` — is presentation, and the format
freezes its grammar so a rule's words mean the same thing on every engine
([Appendix B](https://openagentrules.org/spec/1.0/#appendix-b-copy-bindings-normative)).
A binding `{{ fact }}` names a declared fact, and a mistyped name is a load failure, never a
runtime default ([`[OAR-COPY-2]`]). A conditional `{% if fact %}…{% else %}…{% endif %}`
branches on the fact's zero value ([`[OAR-COPY-3]`]). An engine rejects at load any binding
or construct the grammar does not derive, so copy cannot grow a host template dialect by
accident.

The zero-value semantics are the part worth reading twice. Every declared fact has a value at
every occurrence ([`[OAR-FACT-25]`](https://openagentrules.org/spec/1.0/#5-5-fact-semantics)),
and a zero value is a value, not an absence ([`[OAR-FACT-24]`]). So a binding at zero
substitutes the zero — "applied 0 redactions", not a gap — and a conditional on an unreported
bool takes its else branch. Copy *reads correctly when empty*: the sentence parses, the member
stays present, and the decision is unchanged ([`[OAR-COPY-7]`],
[`[OAR-COPY-6]`](https://openagentrules.org/spec/1.0/#appendix-b-copy-bindings-normative)).
A fact named in copy is reached through `requires_facts` like any other
([`[OAR-COPY-5]`]) — copy is presentation, not an exemption from the portability contract.

## The hint channel

Some situations a host handles are observed by the host's own machinery, not by the guard
pipeline: a tool output capped before it reached the model, a result truncated at a size
limit, a workflow phase that must exit first, a secret redacted on the way out. The guard
pipeline has no fact for them — they are not observations at a lifecycle moment it evaluates —
so no rule can read them, and neither `enforce` nor `monitor` fits: there is nothing to
enforce. Earlier drafts published such copy as `enforcement: off` rules, which made every
engine carry a rule-shaped object whose only live field was its prose.

1.0 instead makes the channel first-class: the *hint*
([section 9](https://openagentrules.org/spec/1.0/#9-the-hint-channel)). A hint is a document
whose `kind` is `hint` and whose payload is copy
([`[OAR-HINT-1]`](https://openagentrules.org/spec/1.0/#9-the-hint-channel)). Its `id` is the
code the host raises ([`[OAR-HINT-2]`]); its copy is static, because there is no occurrence to
bind against ([`[OAR-HINT-3]`]); and it never evaluates — loading one changes no decision and
no copy ([`[OAR-HINT-6]`]).

The rendering contract is a fallback chain ([`[OAR-HINT-4]`]): when the host raises a code, it
renders the copy of the hint registered under that code; if no hint is registered, it renders
the bare code; and a host that raises nothing renders nothing. The channel is additive at
every step — no host behaviour depends on a hint being present, and a pack that ships hints
alongside rules publishes its remedy copy without pretending the guard pipeline saw the
situation. A hint is validated at load like any document
([`[OAR-HINT-5]`]), so a malformed hint is a load error, not a silent gap.

The dividing line is the fact. When the host *can* publish the observation as a host-tier
fact, a rule binding it is the right vehicle: the threshold is in the rule and the decision is
portable. When the guard pipeline has no fact and the host raises the situation on its own
schedule, the copy is a hint. The example packs show both halves: `portable-pack` binds facts,
`remedy-pack` carries the hints and the rules that bind host facts.

## Disabling, watching, and mandatory rules

A rule pack is written by one party and run by another, and the operator's side of that
relationship needs three answers: watch before enforcing, keep a rule nobody may switch off,
and disable the rest without forking the pack.

Watching is `enforcement: monitor`
([`[OAR-OPS-1]`](https://openagentrules.org/spec/1.0/#7-operational-semantics)): the rule
evaluates, the outcome lands on the trace, and no effect is produced. It is the only mode
besides `enforce` — 1.0's `off` is gone, and its legitimate use split into the two mechanisms
that actually needed it: copy publication became the hint channel, and disabling a rule is
removing it from the loaded set, which an operator can always do to a non-mandatory rule.

Keeping a rule is `mandatory: true`
([`[OAR-OPS-5]`](https://openagentrules.org/spec/1.0/#7-operational-semantics)): an engine
MUST reject a configuration that disables, overrides, or removes it. The line exists because
the rules an operator most wants to switch off mid-incident are the ones the pack author
staked the pack's meaning on.

Disabling the rest needs no format mechanism. A configuration that loads a subset of a pack is
an engine's own feature, and the format's contribution is the property that makes it safe: a
configuration changes whether and how loudly a rule runs, and never what it means. An operator
who needs different logic writes a rule, where the change is reviewable as a rule.

Every mature policy system in this space arrived at the same answers. OPA Gatekeeper gives each
constraint an `enforcementAction` of `deny`, `dryrun`, or `warn`, so a policy can be watched in
production before it refuses anything. Falco ships `override` blocks and `enabled: false`, so
an operator can retune or switch off a shipped rule and still take upstream rule updates. The
OWASP Core Rule Set has `SecRuleRemoveById`, which exists for no other purpose than letting a
site drop one rule out of a pack it does not otherwise maintain.

## Rejecting what it does not know

An engine rejects a document carrying a field this specification does not define
([`[OAR-DOC-19]`](https://openagentrules.org/spec/1.0/#2-1-optional-fields)), and rejects
a document whose `spec_version` major it does not support before any other processing
([`[OAR-CONF-2]`](https://openagentrules.org/spec/1.0/#10-conformance)). This is the opposite
of the usual advice, and the usual advice is usually right.

Protocol Buffers is the cautionary tale in the other direction. proto3 originally dropped
unknown fields, and v3.5 reversed that and restored preservation, because a middle tier that
parsed and re-serialised a message from a newer peer was silently deleting the newer peer's
data. JSON Schema treats an unrecognised keyword as an annotation rather than an error for a
related reason: a schema written against a later draft should still constrain what the current
implementation does understand. Both are correct, and both are solving the problem of carrying
data across versions.

A rule is not carrying data. It is a conjunction, and a field added in a later minor
can *narrow* it — a new selector clause, a new qualifier on a condition, a new restriction on
when the effect applies. An engine that loads such a document while ignoring the field it does
not recognise has not lost information. It has enforced a policy nobody wrote, and reported
success while doing it. There is no log line for the constraint that was skipped, because from
the engine's point of view nothing happened.

Refusing to load is the only failure mode an operator can see. The cost is that one document
cannot target a fleet running mixed minors, which
[`[OAR-DOC-24]`](https://openagentrules.org/spec/1.0/#11-extensibility-and-versioning) bounds
by making every minor revision additive: a document written for an earlier minor of the same
major remains valid. Extension fields that an engine must ignore are spelled `x-`, and
nothing else gets that grace.

## A frozen expression grammar

`when` is written in a small language with a published EBNF grammar, defined by what it
excludes as much as by what it includes: no macros, no comprehensions, no time, no random
source, no field selection, no regular expressions.

Kubernetes did this work for admission control. ValidatingAdmissionPolicy does not say "CEL"
and stop there — it pins an explicit set of CEL libraries, and adds a cost budget so that an
expression cannot be accepted at admission time and then turn out to be too expensive to
evaluate. Cedar publishes an EBNF grammar for the related reason: a policy language whose
accepted inputs are defined by one implementation's parser has exactly one conforming
implementation, whatever the documentation says.

Falco is the counter-example, and it is instructive. Its condition syntax
was described in prose and defined operationally by its own parser, and the result was
long-lived ambiguity about how `and`, `or`, and `not` bind in an unparenthesised condition —
with rules in the wild that meant one thing to their author and another to the engine. Nobody
decided that. It is what happens when the grammar is an implementation detail instead of a
document.

Regular expressions are excluded specifically. Every host language ships a different dialect —
backtracking against RE2, different Unicode property support, different escapes, different
behaviour on the same pattern — so a rule containing a regex would evaluate differently on two
conforming engines. That is precisely the promise this format makes, so the feature that would
break it is not in the language. Where a rule needs matching the operators cannot express, the
host publishes an observation function and the rule composes it, which puts the matching in one
place, under a declared name, with a declared type.

## How to check your implementation

Two commands:

```bash
curl -O https://openagentrules.org/spec/1.0/oar.schema.json
npx @openagentrules/oar-ref https://openagentrules.org/spec/1.0/conformance/manifest.json
```

Given the manifest URL, the reference runner fetches every fixture the manifest names and
runs them, reporting pass, fail, and skip separately — a skipped fixture is not a passed
fixture, and a baseline fixture may not be skipped at all. Point it at a local directory
instead and it fetches nothing.

Read the numbered runner algorithm in
[section 10.1](https://openagentrules.org/spec/1.0/#10-1-the-runner-algorithm) of the
specification, implement it, and run the corpus. Every fixture names the clauses it exercises,
so a failure tells you which sentence you and the specification disagree about. If you conclude
the specification is wrong, open an issue quoting the clause id — that is what they are for.
