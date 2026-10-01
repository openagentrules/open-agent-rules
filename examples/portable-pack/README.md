# A portable rule pack

Ten rules, across seven files, that exercise most of Open Agent Rules 1.0 and are portable in
the sense [`[OAR-PROF-6]`](../../spec/oar/1.0/open-agent-rules.md) defines: every anchor is a
core anchor, and every fact comes from the `core` tier or from a profile the rule declares in
`requires`. They run unchanged on any engine providing those profiles.

Three of the files carry more than one rule, separated by a YAML `---`. That is a *rule set*
(`[OAR-DOC-31]`), and a member's position in one has no effect on its identity, ordering, or
precedence.

They are written in YAML because that is the comfortable authoring form. JSON is the
interchange form, and the mapping is lossless (`[OAR-DOC-1]`).

| File | What it demonstrates |
|------|----------------------|
| [`read-outside-scope.yaml`](read-outside-scope.yaml) | The basic shape: anchor, selector, condition, effect, fail-closed. |
| [`redact-secrets.yaml`](redact-secrets.yaml) · [`redact-pii.yaml`](redact-pii.yaml) | Two transforms at one anchor, accumulating rather than competing. |
| [`mcp-provider-disabled.yaml`](mcp-provider-disabled.yaml) | A profile a host may not provide, declared through `requires`. |
| [`repeat-loop.yaml`](repeat-loop.yaml) | Escalation over time: one rule counts, two read the count, and the counter is scoped to the call. |
| [`write-outside-workspace.yaml`](write-outside-workspace.yaml) | A path prefix matched with a built-in rather than a regular expression. |
| [`bulk-delete.yaml`](bulk-delete.yaml) | `overrides`: a specific rule silencing the general one it refines. |
| [`capability.yaml`](capability.yaml) | The host these rules assume. |
| [`config.yaml`](config.yaml) | An operator disabling and downgrading rules without forking the pack. |

## The two things worth reading closely

**The threshold is in the rule.** `redact-secrets.yaml` says `size(secret_matches) > 0` and
`repeat-loop.yaml` says `fire_count_of("REPEAT_CALL_TALLY") >= 5`. A detector produced the
spans and the engine maintained the counter; neither decided what was too much. That is the
whole argument of the format — move either number into the host and the policy becomes
unreviewable.

**Counting and gating are different rules.** `repeat-loop.yaml` needs three rules where it
looks like it needs two. A rule's `on_fire` runs only when that rule fires (`[OAR-FIRE-2]`),
so a rule waiting for its own counter to reach two would never fire, never count, and never
reach two. `REPEAT_CALL_TALLY` therefore counts unconditionally and the other two read its
counter through `fire_count_of` (`[OAR-FIRE-11]`). Its `counter_scope` is what makes the pack
about a *repeated* call rather than about traffic in general (`[OAR-FIRE-10]`).

**Two transforms both apply.** `redact-secrets` and `redact-pii` fire at the same
`model.output` occurrence and neither suppresses the other; the engine accumulates both and
applies them in evaluation order (`[OAR-OPS-15]`, `[OAR-OPS-16]`). This is why `transform`
does not short-circuit the way `block` does.

## Running them

Against the reference implementation:

```bash
node packages/oar-ref/bin/oar-conformance.mjs --capability examples/portable-pack/capability.yaml examples/portable-pack
```

A rule here that fails to load is a bug in the pack or the engine, not in the specification —
report it either way.
