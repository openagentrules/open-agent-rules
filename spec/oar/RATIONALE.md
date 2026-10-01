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
of judgement. `secret_matches` is a fact: it is a list of spans a detector reported, and it
says nothing about whether the content should be delivered. `content_is_unsafe` is *not* a
fact. It is a conclusion, and the moment a host publishes it, the policy has moved back into
the host's code where nobody can read it.

The distinction is not stylistic. The **threshold** and the **composition** are the policy —
they are the parts an operator argues about, tunes, and audits. So they have to live where a
reviewer can see and change them:

```yaml
when: 'prompt_injection_score > 0.8 && session_posture != "internal"'
```

Everything about that line is reviewable. The detector produced a number; the *rule* decided
that 0.8 is the bar and that internal sessions are exempt. Move the threshold into the
detector and the same policy becomes invisible.

This is why the specification states observation-not-verdict as a requirement on fact
providers rather than as advice. A format whose facts may contain verdicts degenerates into
the callback model with extra syntax.

## One rule, annotated (non-normative)

```yaml
oar: "1.0"                      # format marker and version
id: READ_OUTSIDE_SCOPE          # stable; the identifier the decision carries
namespace: acme.security        # publisher scope; identity is (namespace, id)
kind: policy                    # fixes evaluation order, nothing else
anchor: tool.pre_invoke         # a core anchor: before the tool runs
selector:
  tool: [read, grep]            # the clause names the `tool` fact; clauses are AND
requires:
  profiles: [tool, filesystem]  # what this rule needs the host to provide
when: 'path_outside_scope(tool)'   # composition of observations
effect: block                   # what the engine does when the condition holds
on_error: fail_closed           # if this cannot be evaluated, block
copy:
  what: "The call reads outside the declared scope."
  fix: "Read inside scope, or widen the scope deliberately."
```

Eight lines carry the whole policy, and `copy` carries the explanation the caller sees.
Members MAY contain the frozen bindings of Appendix C — `{{ fact }}` and
`{% if fact %}` — so occurrence values reach the prose without a host template
dialect. The engine substitutes after the decision; two rules that differ only
in `copy` still produce the same decision.
`anchor` and `selector` say *where*; `when` says *whether*; `effect` and `on_error` say *what
happens*, including when the check itself fails. `requires` is the line that makes portability
computable: a reader can tell from the document alone which engines will run it, without
consulting any of them. Clause references:
[`[OAR-SEL-1]`](https://openagentrules.org/spec/1.0/#3-anchors-and-selection),
[`[OAR-EVAL-4]`](https://openagentrules.org/spec/1.0/#4-evaluation),
[`[OAR-FACT-20]`](https://openagentrules.org/spec/1.0/#5-1-capability-profiles),
[`[OAR-OPS-3]`](https://openagentrules.org/spec/1.0/#7-operational-semantics).

## Why not Rego, or Cedar

Rego and Cedar are mature, well-tooled, and more expressive than anything here. They are also
solving a different problem, and the difference is the whole point.

Both evaluate arbitrary policy over arbitrary input. That generality is their strength for
authorisation, and it is exactly what stops a rule from travelling: every deployment
invents its own input document. A Rego policy for one agent runtime reads
`input.request.tool.name`; the next reads `input.action.id`. Both are valid Rego. Neither rule
runs on the other's system, and neither can be tested without that system's input shape.

Open Agent Rules fixes the vocabularies that generality leaves open: the lifecycle moments
(core anchors), the typed observations (the core tier and the capability profiles), and the
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

## Capability profiles over a mandatory core catalogue

A single mandatory fact catalogue would require every conforming engine to provide every fact.
A model gateway with no file system would still have to publish `is_directory`, most likely as
`false` forever. A rule written against it would load, evaluate, and mean nothing while the
operator sees a passing conformance run.

A capability profile is a named bundle of facts that an engine provides whole or not at all
([`[OAR-FACT-16]`](https://openagentrules.org/spec/1.0/#5-1-capability-profiles)). The engine
declares which profiles it provides; the rule declares which it needs; the engine refuses at
load any rule it cannot serve. Nothing is stubbed, because nothing has to be.

This is capability negotiation, which is how the Model Context Protocol handles the same
problem: a server advertises what it has, a client asks for what it needs, and the absence of a
capability is something both sides can see rather than a silently degraded call. The closer
analogue for a *document format* is JSON Schema's `$vocabulary` map, which splits declared
vocabularies into required and optional — an implementation that does not recognise a
vocabulary marked required must refuse the schema rather than validate part of it. Both designs
make the same trade: a more complicated handshake, in exchange for never being wrong about what
the other side actually does.

The cost is real. A rule now has to say what it needs, and a rule that omits `requires` for a
non-core fact is rejected
([`[OAR-FACT-20]`](https://openagentrules.org/spec/1.0/#5-1-capability-profiles)). That is one
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

## Transforms compose

Short-circuiting `transform` like `block` would prevent independent redactions from applying to
one model response: whichever rule ran first would discard the rest. Content safety commonly
needs several independent redactions over one payload, so transforms accumulate
([`[OAR-OPS-15]`](https://openagentrules.org/spec/1.0/#7-2-transform)) and are applied in
evaluation order, each to the output of the last, never merged and never reordered
([`[OAR-OPS-16]`](https://openagentrules.org/spec/1.0/#7-2-transform)). The ordering is
specified rather than left to the engine because two redactions with overlapping targets produce
different output depending on which runs first, and a portable rule cannot mean two things.

A `block` still discards them all
([`[OAR-OPS-17]`](https://openagentrules.org/spec/1.0/#7-2-transform)): if the content is not
delivered, there is nothing left to mutate.

## Advisories compose

A nudge is addressed to the agent and is meant to change the next step it takes. A warning is
addressed to the operator reading the trace. Either way, several independent ones can hold of
one occurrence: the session is near a spend ceiling *and* the last claim was ungrounded; two
warnings an operator should both see. Naming one and discarding the rest is the same bug
transforms had when they short-circuited.

So when the decision is `nudge` or `warn`, every enforced rule that fired with that effect is
carried on `advisories`, in evaluation order, never merged and never reordered
([`[OAR-EVAL-20]`](https://openagentrules.org/spec/1.0/#4-evaluation)). The decision still
names one rule — the first in that order — so a consumer that branches on a single identifier
has a deterministic primary. The list is what is presented. A suppressed rule, a `monitor`
rule, and a rule that fired with a different effect do not appear. `block` and `transform`
still outrank both, and when they win the list is empty: the occurrence is stopped or
mutated, and the advisory is not the decision.

This is the shape every neighbouring standard arrived at for independent constraints that
share an occurrence. Content Security Policy enforces every policy and adding one can only
restrict further. Gatekeeper and Kyverno report every matching violation, not the first.
XACML accumulates obligations, and a combined decision that would drop them is Indeterminate.
NeMo output rails compose rather than elect a winner. A format whose decision names one
steer and silently drops the others would be the one that failed to learn it.

Copy stays frozen. Each advisory carries that rule's own rendered `copy`; the language is
still a substitution and a conditional
([`[OAR-COPY-9]`](https://openagentrules.org/spec/1.0/#appendix-c-copy-bindings-normative)).
Prompt assembly — persona partials, board layout, spawn assignment — is instructions to the
model, and stays out of the document.

## Declarative suppression, and configuration that is not a fork

Two mechanisms in 1.0 exist because a rule pack is written by one party and run by another.

The first is suppression. A specific rule and the general rule it refines both fire, and the
author wants only the specific one heard. Without a way to say so, authors negate the sibling
rule's whole condition inside their own — which is hard to read the day it is written and wrong
the day either rule changes. `overrides` names the rules a rule silences
([`[OAR-EVAL-13]`](https://openagentrules.org/spec/1.0/#4-1-suppression)), does not compute a
transitive closure, and is rejected at load when it forms a cycle or names a mandatory rule.

The second is operator configuration, and it is the more important of the two. An operator who
cannot disable one rule in a vendor's pack forks the pack, and a forked pack stops receiving
the vendor's updates — so the rules rot in exactly the deployment that was careful enough
to review them.

Every mature policy system in this space arrived at the same answer. OPA Gatekeeper gives each
constraint an `enforcementAction` of `deny`, `dryrun`, or `warn`, so a policy can be watched in
production before it refuses anything. Falco ships `override` blocks and `enabled: false`, so
an operator can retune or switch off a shipped rule and still take upstream rule updates. The
OWASP Core Rule Set has `SecRuleRemoveById`, which exists for no other purpose than letting a
site drop one rule out of a pack it does not otherwise maintain.

Open Agent Rules takes the same shape and draws one line the others leave implicit: a
configuration document changes whether and how loudly a rule runs, and never what it means
([`[OAR-CFG-6]`](https://openagentrules.org/spec/1.0/#9-operator-configuration)). It cannot
edit an anchor, a selector, a condition, an effect, or the copy. An operator who needs
different logic writes a rule, where the change is reviewable as a rule. `enforcement: monitor`
is the rollout path; `enforcement: off` is the supported way to disable something without
deleting it; and a configuration naming a rule that is not loaded is rejected, because a
configuration that silently refers to nothing is indistinguishable from one that works.

## Rejecting a greater minor

An engine rejects a document whose `oar` minor version is higher than its own
([`[OAR-DOC-5]`](https://openagentrules.org/spec/1.0/#2-document-model)). This is the opposite
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
[`[OAR-VER-4]`](https://openagentrules.org/spec/1.0/#11-extensibility-and-versioning) states
plainly: author to the lowest minor in the fleet, and say in the pack which minor it needs.

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
