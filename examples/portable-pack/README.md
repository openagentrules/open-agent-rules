# A portable rule pack

Seven rules, across five files, that exercise most of Open Agent Rules 1.1 and are portable in
the sense [`[OAR-DOC-24]`](../../spec/oar/1.1/open-agent-rules.md) records and section 8
defines: every anchor is a core anchor, and every fact comes from the `core` tier or from a
standard profile the rule names in `requires_facts`. They run unchanged on any engine
providing those facts.

Three of the files carry more than one rule, separated by a YAML `---`. That is a *rule set*,
and a member's position in one has no effect on its identity, ordering, or precedence.

They are written in YAML because that is the comfortable authoring form. JSON is the
interchange form, and the mapping is lossless (`[OAR-DOC-1]`).

| File | What it demonstrates |
|------|----------------------|
| [`read-outside-scope.yaml`](read-outside-scope.yaml) | The basic shape: anchor, selector, condition, effect, fail-closed. |
| [`content-safety.yaml`](content-safety.yaml) | The content-safety surface: a registered detector publishes observations, the rule owns every threshold. Two rules over one detector. |
| [`mcp-server-disabled.yaml`](mcp-server-disabled.yaml) | Facts a host may not provide, declared through `requires_facts`. |
| [`reject-run.yaml`](reject-run.yaml) | Escalation over time: the engine counts repeated refusals, the rule owns the threshold. |
| [`destructive-tool.yaml`](destructive-tool.yaml) | Deterministic order and short-circuit: the specific refusal subsumes the general flag. |
| [`profile.yaml`](profile.yaml) | The anchor profile map of the host these rules assume. |
| `fixtures/` | Nine replays against the reference implementation, one per behaviour. |

## What changed since the 1.0 edition of this pack

- `oar:` became `spec_version: "1.1"`, and `anchor:` became `on:` (`[OAR-DOC-3]`,
  `[OAR-SEL-1]`).
- The `copy:` block is gone; `what`, `cause`, `why`, `fix`, `instead`, and `message` are
  fields of the rule itself (`[OAR-DOC-18]`, Appendix B).
- `requires: profiles:` is gone. A rule names the *facts* it needs
  (`[OAR-DOC-23]`), and `profile: portable` records the author's intent without carrying
  behaviour (`[OAR-DOC-24]`).
- `status` is gone; `enforcement` is `enforce` or `monitor` (`[OAR-DOC-11]`) — there is no
  third mode to publish copy under.
- `overrides` is gone. The same outcome falls out of the deterministic order
  (`[OAR-EVAL-1]`) and the short-circuit (`[OAR-EVAL-3]`); see `destructive-tool.yaml`.
- `counter_scope` and `fire_count_of` are gone. A rule reads the engine's counters as
  ordinary facts (`[OAR-FIRE-3]`); see `reject-run.yaml`.
- The capability document is now the anchor profile map (section 8.2); the profiles,
  detectors, and limits it used to carry are the engine's own declarations.
- Path-prefix matching moved into observation functions: `path_outside_scope` is a core
  function (`[OAR-FACT-7]`), so the pack no longer needs a host-side string helper.
- Span-list redaction rules became score-threshold rules. The closed condition language has
  no aggregate over a `list<map<string, dyn>>`, and the draft's content-safety surface is
  built on scores the rule thresholds (`[OAR-OPS-9]`).

## The two things worth reading closely

**The threshold is in the rule.** `content-safety.yaml` says `jailbreak_score > 0.8` and
`reject-run.yaml` says `same_code_reject_run >= 3`. A detector produced the score and the
engine maintains the counter; neither decided what was too much. That is the whole argument
of the format — move either number into the host and the policy becomes unreviewable
(`[OAR-FACT-5]`).

**Ordering is the composition.** `destructive-tool.yaml` needs two rules where it looks like
it needs one, and 1.0 needed `overrides` to make the pair behave. 1.1 instead guarantees the
order: both rules are `policy` kind, so ascending id order evaluates `DELETE_REFUSED` first,
and its block short-circuits the occurrence — a delete is refused outright, and the flag
rule is never reached (`[OAR-EVAL-1]`, `[OAR-EVAL-3]`). `reject-run.yaml` leans on the same
guarantee from the other side: at two rejections the block rule passes and the warn decides.

## Running them

Against the reference implementation:

```bash
node packages/oar-ref/bin/lint-pack.mjs examples/portable-pack
```

That validates every rule document against the published schema and replays every fixture in
`fixtures/` against the reference runner. A rule here that fails to load is a
bug in the pack or the engine, not in the specification — report it either way.
