# Converting a hosted moderation policy

Hosted moderation products — the guardrail features of the large model
platforms, and the standalone content-safety APIs — all ship approximately the
same configuration document: a list of harm categories, a threshold per
category, an action per threshold, and a personal-data policy with an action per
entity type. This pack is that document, rewritten as Open Agent Rules.

The conversion is close to mechanical, and the parts that are *not* mechanical
are the interesting ones.

## What maps directly

| In a hosted policy | Here |
|--------------------|------|
| A harm category with a strength or threshold | `moderation_score("<category>") >= <bar>` in a rule's `when` |
| `BLOCK` / `NONE` action on a filter | `effect: block` / the rule not existing |
| An advisory or "flag only" tier | `effect: warn`, or `enforcement: monitor` while it is being trialled |
| A PII entity action `ANONYMIZE` | `effect: transform` with `action: redact` |
| A PII entity action `BLOCK` | `effect: block` |
| Applying a filter to the prompt or the response | `anchor: model.input` or `anchor: model.output` |
| Turning one filter off without editing the policy | `disable:` in an operator configuration document |

[`content-filters.yaml`](content-filters.yaml) is the category half and
[`pii-redaction.yaml`](pii-redaction.yaml) the personal-data half.
[`capability.yaml`](capability.yaml) is the host: a gateway with no file system
and no tools, which claims `session`, `content`, `pii`, and `moderation` and
declares the other five core anchors unsupported rather than stubbing them.

## What does not map, and is better for it

**The threshold stops being a vendor enum.** A hosted filter offers `LOW` /
`MEDIUM` / `HIGH`, and what those mean is the vendor's business. Here the bar is
a number in a document, so "we tightened the hate filter" is a one-line diff
with a reviewer on it.

**An exemption becomes expressible.** `VIOLENCE_HIGH` exempts an internal
posture in the same line as the threshold. Most hosted policies have nowhere to
put that, so the exemption ends up in whatever calls the API — which is code, in
another repository, reviewed by other people, if it is written down at all.

**Two actions on one payload both apply.** A redaction of personal data and a
refusal for a credential are separate rules over separate observations.
Transforms accumulate ([OAR-OPS-15]) and a `block` discards them
([OAR-OPS-17]), so the pack cannot half-apply.

## What the format still needs from the host

`moderation_score` is an observation function in the `moderation` profile, so
this pack loads only on a host that claims that profile, and is refused by name
on one that does not ([OAR-FACT-19]). The category *names* are the host's, not
the specification's: `hate` here is whatever the registered classifier calls
that category. Two hosts whose classifiers use different category vocabularies
will disagree, and the specification does not pretend otherwise — what it
guarantees is that the disagreement is a load-time refusal or an explicit zero
([OAR-FACT-25]), never a threshold that silently never trips.

## Running it

```bash
node packages/oar-ref/bin/oar-conformance.mjs \
  --capability examples/moderation-pack/capability.yaml \
  examples/moderation-pack
```
