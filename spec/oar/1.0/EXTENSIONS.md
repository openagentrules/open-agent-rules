# Extension registry

Open Agent Rules reserves fields whose names match `^x-[a-z0-9]+(-[a-z0-9]+)*$` for
implementations. An engine ignores an `x-` field it does not recognise (`[OAR-DOC-26]`), and an
`x-` field never affects selection, evaluation, ordering, precedence, or the returned decision.
Every other undefined field is rejected at load, naming the field (`[OAR-DOC-27]`), so `x-` is
the only way to carry something this specification does not define.

This file records the extensions implementations have published.

## Registered extensions

| Field | Vendor | What it carries | Documentation |
|-------|--------|-----------------|---------------|
| `x-paintedwolf-emit` | paintedwolf | Presentation channel for a decision (`guard:…`, `rule:…`). Does not affect selection, evaluation, or the returned decision. | [Implementation notes](https://github.com/paintedwolf-ai/paintedwolfcode/blob/main/docs/open-agent-rules.md) |
| `x-paintedwolf-message` | paintedwolf | Optional reject-copy override used by this host's renderer. Presentation only. | same |
| `x-paintedwolf-scenarios` | paintedwolf | Fixture seeds for this host's internal conformance dialect. Not an evaluation input. | same |
| `x-paintedwolf-category` | paintedwolf | Hint-registry category for docs and search. Presentation only. | same |
| `x-paintedwolf-audience` | paintedwolf | Narrows which of this host's agent archetypes a decision's copy is written for. Presentation only. | same |
| `x-paintedwolf-evidence` | paintedwolf | Declares what this host should retry or capture after the decision. Not an evaluation input. | same |

## The convention

Extension names are `x-<vendor>-<name>`:

- `<vendor>` identifies the organisation or project defining the field. Use the same short name
  you use for your host fact namespace, so a reader meets one identifier rather than two.
- `<name>` is what the field carries, in the same lowercase hyphenated style.

So `x-acme-runbook`, `x-paintedwolf-trace-tag`, `x-globex-ticket`. The vendor segment is the whole
point: two organisations that both want to attach a runbook link end up with
`x-acme-runbook` and `x-globex-runbook` rather than two incompatible meanings of `x-runbook`.

A single-segment name like `x-runbook` is a valid document field — the grammar permits it — and
is a bad idea, because the next implementation to want that name has no way to tell yours
apart from its own.

## Registering

Open a pull request against this file adding a row with the field name, the vendor, one
sentence on what the field carries, and a link to your own documentation.

**This is a documented-conventions registry, not a gatekept one.** The model is the way
CloudEvents documents its extension attributes: nobody needs permission to define one, nothing
is rejected for being unregistered, and no review approves an entry. An unregistered `x-` field
is completely legal and behaves identically. Registering yours is a courtesy to the next
implementer, and it costs one pull request.

The registry exists to make collisions visible, not to prevent them by authority.

## What an extension may not do

An `x-` field is data an implementation carries through. It is not a way to add behaviour to
the format.

- It **must not** affect any decision (`[OAR-DOC-26]`). An engine that branches on its own
  `x-` field has forked the format and given the fork a prefix. A rule using that engine's
  extension produces one decision there and a different one everywhere else, which is the
  failure this whole specification exists to prevent.
- It **must not** become normative without a specification change. If an extension turns out to
  be something every engine needs, the path is a proposal against the specification —
  see [`GOVERNANCE.md`](../GOVERNANCE.md) — not wider adoption of the prefix.
- It is **not** the mechanism for host-specific observations. Those are facts, and they live
  under a namespace the host owns, written `<host>.<fact>` (`[OAR-FACT-18]`). A rule that
  composes one is legal and is not portable, and a portability report will say so.
