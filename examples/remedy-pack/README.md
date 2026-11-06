# The hint channel — a remedy pack

The 1.0-native pattern for remedy copy: rules whose copy binds a host fact, and hint
documents a host raises by code. It exists because the guard pipeline decides from typed
facts at lifecycle moments, and some situations a host handles — a capped tool output, a
truncated result, a phase gate, a redaction receipt — are observed by the host's own
machinery, not by the guard pipeline. No fact exists for a rule to read, so neither
`enforce` nor `monitor` fits: there is nothing to enforce. Earlier drafts published such
copy as `enforcement: off` rules; 1.0 removes `off` and makes the channel first-class —
the hint (section 9, [`[OAR-HINT-1]`](../../spec/oar/1.0/open-agent-rules.md)).

| File | What it demonstrates |
|------|----------------------|
| [`rules.yaml`](rules.yaml) | The rule half: a guard-pipeline rule whose copy binds host-tier facts. |
| [`hints.yaml`](hints.yaml) | The hint half: four copy publications keyed by the codes a host raises. |
| [`host-facts.yaml`](host-facts.yaml) | The host catalog convention this pack assumes (host-side, non-normative). |
| `fixtures/` | Seven replays against the reference implementation, including the zero-value and hint-does-not-perturb cases. |

## The rule half: copy that binds a host fact

`rules.yaml` carries one rule, `RETRY_CAP_REFUSED`. The host publishes its own retry
accounting under its namespace — `paintedwolf.attempts`, `paintedwolf.breaker_open`,
`paintedwolf.redaction_count` — as host-tier facts ([`[OAR-FACT-15]`]). The rule names all
three in `requires_facts` ([`[OAR-COPY-5]`]): the declaration is what makes the binding
legal and reviewable, because a reader can see exactly which host observations the copy
depends on before reading a word of it. The copy then interpolates an int
([`[OAR-COPY-4]`]) and branches on a bool ([`[OAR-COPY-3]`]).

This half is for situations the host *can* publish as a fact. When it can, a rule is the
right vehicle: the condition is in the rule, the threshold is reviewable, and the decision
is portable to any engine whose host provides the same facts.

## The hint half: copy keyed by a code

`hints.yaml` carries four hints — the 1.0-native shape of the painted-wolf pack's
enforcement-off units. A hint is a copy publication, not a rule:

- it never evaluates — no `when`, no `effect`, no side-effects ([`[OAR-HINT-1]`]);
- its `id` is the code the host raises ([`[OAR-HINT-2]`]);
- its copy is static — no bindings, because there is no occurrence to bind against
  ([`[OAR-HINT-3]`]).

The host raises the code in its own envelope, at its own moment, from its own observation;
the hint supplies the words. The guard pipeline never sees a hint: loading one changes no
decision and no copy ([`[OAR-HINT-6]`], [`[OAR-COPY-6]`]) — `fixtures/hints-do-not-perturb.json`
pins that the same occurrence evaluates identically with four hints loaded.

## The host catalog convention (host-side, non-normative)

`host-facts.yaml` is the catalog form the host keeps: one line per fact it publishes, name
and type. It is not a rule document and the format does not read it — the format's only
contact with the catalog is [`[OAR-FACT-15]`] (host facts live under a namespace the host
owns) and the fixture input's `host_facts` member ([`[OAR-CONF-13]`]). A host documents its
namespace however it likes; this file is the convention this pack assumes, kept beside the
rules so a reviewer can check every `requires_facts` entry against it.

## The fallback chain

When the host raises a code, it renders, in order:

1. **A registered hint's copy.** If a hint whose `id` is the raised code is registered, the
   host renders that hint's copy — the words the pack's author wrote and reviewed.
2. **Otherwise, the bare code.** An unregistered code renders as the code itself
   ([`[OAR-HINT-4]`]): the envelope stays truthful, and nothing pretends copy exists.

Or, otherwise, the host drops the channel: a host that registers no hints renders bare
codes, and a host that raises nothing renders nothing. The channel is additive at every
step — no host behaviour depends on a hint being present, and no rule's decision depends on
a hint being loaded.

## The copy-reads-correctly-when-empty invariant

Copy that binds a fact must read correctly when the fact is at its zero value or absent:

- A binding at zero substitutes the zero value, not a gap ([`[OAR-COPY-7]`],
  [`[OAR-FACT-25]`]): `paintedwolf.redaction_count` at `0` renders "applied 0 redactions",
  never "applied  redactions". `fixtures/retry-cap-zero-binding.json` pins it.
- A declared fact absent from the occurrence reads as its zero value ([`[OAR-FACT-24]`]),
  so a conditional on an unreported bool takes the else branch and the sentence still
  parses. `fixtures/retry-cap-zero-conditional.json` pins it.
- A zero fact is a value, not an absence: `paintedwolf.attempts` at `0` simply does not
  satisfy `>= 3`, and the rule does not fire. `fixtures/retry-cap-below-threshold.json`
  pins it.

## What makes the pattern legal

- [`[OAR-FACT-11]`] — the fact tiers. The host publishes its own observations as
  host-tier facts under its namespace; the guard pipeline's facts stay in the `core` tier
  and the standard profiles. The rule half stays inside the tiering.
- [`[OAR-FACT-25]`] — zero values are values. A host fact at zero is present, which is why
  the zero-value copy cases are well-defined rather than error paths.
- [`[OAR-COPY-5]`] — a fact named in copy must be reached through `requires_facts`. The
  declaration is what makes both halves reviewable: the rule's bindings and the catalog
  check against the same list.

## Running the pack

From `packages/oar-ref` (after `npm run build`):

```
node bin/lint-pack.mjs ../../examples/remedy-pack
```

Every fixture replays against the reference implementation: the rule fires with rendered
copy, the zero-value cases render correctly, the hints load without perturbing the
decision, and the malformed hints are rejected at load with the clause that forbids them
([`[OAR-HINT-5]`]).
