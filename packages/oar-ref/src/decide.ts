// Selection, ordering, evaluation, and the decision for one anchor occurrence.
// This file is the numbered runner algorithm, steps 6 to 12.

import { evaluate, EvalError, factValue, type EvalContext, type Value } from './eval.js';
import type { Environment } from './env.js';
import { renderCopyRecord, CopyRenderError } from './copy.js';
import type { OnFireAction, Rule, Selector } from './load.js';

export type Outcome = 'fired' | 'passed' | 'errored' | 'monitor';

export interface TraceEntry {
  readonly rule: string;
  readonly outcome: Outcome;
}

export interface Decision {
  readonly effect: 'block' | 'warn' | 'nudge' | 'transform';
  readonly code: string;
  readonly onFire: readonly OnFireAction[];
  /** Rendered copy of the rule whose identifier the decision carries ([OAR-COPY-7]). */
  readonly copy?: Readonly<Record<string, string>>;
}

export interface Occurrence {
  readonly anchor: string;
  readonly facts: Readonly<Record<string, Value>>;
  readonly recentTools?: readonly string[];
  readonly sessionID?: string;
}

export interface Result {
  readonly decision: Decision | null;
  readonly trace: readonly TraceEntry[];
  readonly counters: Readonly<Record<string, Record<string, number>>>;
}

// kind fixes evaluation order and nothing else.
const KIND_ORDER: Record<string, number> = {
  schema: 0, policy: 1, invariant: 2, detector: 3,
};

/** A detector reports observations; the rule's condition owns every threshold. */
export type Detector = (occurrence: Occurrence) => Record<string, Value>;

export interface EngineOptions {
  readonly env: Environment;
  readonly detectors?: Readonly<Record<string, Detector>>;
}

export class CounterStore {
  private readonly data = new Map<string, Map<string, number>>();

  get(sessionID: string, code: string, kind: string): number {
    return this.data.get(`${sessionID}\u0000${code}`)?.get(kind) ?? 0;
  }

  apply(sessionID: string, code: string, actions: readonly OnFireAction[]): void {
    const key = `${sessionID}\u0000${code}`;
    let m = this.data.get(key);
    if (!m) {
      m = new Map();
      this.data.set(key, m);
    }
    for (const action of actions) {
      switch (action) {
        case 'increment_counter': m.set('fire_count', (m.get('fire_count') ?? 0) + 1); break;
        case 'reset_counter': m.set('fire_count', 0); break;
        case 'increment_breaker': m.set('breaker_count', (m.get('breaker_count') ?? 0) + 1); break;
        case 'reset_breaker': m.set('breaker_count', 0); break;
        case 'publish_event': break; // observable to the host, not to a rule
      }
    }
  }

  snapshot(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const [key, m] of this.data) {
      const code = key.slice(key.indexOf('\u0000') + 1);
      out[code] = Object.fromEntries(m);
    }
    return out;
  }
}

/** Evaluate one anchor occurrence against a loaded rule set. */
export function decide(
  rules: readonly Rule[],
  occ: Occurrence,
  opts: EngineOptions,
  counters: CounterStore = new CounterStore(),
): Result {
  const selected = rules
    .filter((r) => r.resolvedOn === occ.anchor && selectorMatches(r.selector, occ.facts))
    .sort((a, b) => {
      const ka = KIND_ORDER[a.kind] ?? 99;
      const kb = KIND_ORDER[b.kind] ?? 99;
      return ka !== kb ? ka - kb : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  const trace: TraceEntry[] = [];
  const blocks: Draft[] = [];
  const nudges: Draft[] = [];
  const warns: Draft[] = [];

  for (const rule of selected) {
    let fired: boolean;
    let facts: Record<string, Value> = { ...occ.facts };
    try {
      const r = fires(rule, occ, opts, counters);
      fired = r.fired;
      facts = r.facts;
    } catch (err) {
      trace.push({ rule: rule.id, outcome: 'errored' });
      // [OAR-OPS-11] Monitoring never acts, including on its own failures.
      if (rule.enforcement === 'monitor') continue;
      const handled = onError(rule, err);
      if (handled === null) continue;      // fail_open
      // The block carries the copy of the rule whose identifier it carries:
      // the failed rule itself under fail_closed, the named substitute
      // otherwise ([OAR-COPY-7], [OAR-OPS-4]).
      const carrier = rules.find((r) => r.id === handled.code) ?? null;
      blocks.push({
        decision: handled,
        rule: carrier,
        facts: baseFacts(carrier, occ, counters),
        fromOnError: true,
      });
      break;                                // fail_closed stops the occurrence
    }
    if (!fired) {
      trace.push({ rule: rule.id, outcome: 'passed' });
      continue;
    }
    if (rule.enforcement === 'monitor') {
      // Recorded, but no effect, no side-effect, and no short-circuit.
      trace.push({ rule: rule.id, outcome: 'monitor' });
      continue;
    }
    trace.push({ rule: rule.id, outcome: 'fired' });
    if (occ.sessionID !== undefined && rule.onFire.length > 0) {
      counters.apply(occ.sessionID, rule.id, rule.onFire);
    }
    if (rule.effect === 'allow') continue;
    const draft: Draft = {
      decision: { effect: rule.effect, code: rule.id, onFire: rule.onFire },
      rule,
      facts,
      fromOnError: false,
    };
    if (rule.effect === 'block' || rule.effect === 'transform') {
      blocks.push(draft);
      break; // the first enforced block or transform short-circuits
    }
    if (rule.effect === 'nudge') nudges.push(draft);
    else warns.push(draft);
  }

  const winner = blocks[0] ?? nudges[0] ?? warns[0] ?? null;
  let decision: Decision | null = winner?.decision ?? null;
  if (winner?.rule && Object.keys(winner.rule.copy).length > 0) {
    if (winner.fromOnError) {
      // [OAR-COPY-10] A rendering failure for an on_error block omits the
      // entire copy object; the block and its identifiers stand, and the
      // failure does not start another on_error evaluation.
      try {
        decision = {
          ...winner.decision,
          copy: renderCopyRecord(winner.rule.copy, winner.facts, opts.env),
        };
      } catch (err) {
        // A rendering failure here is a fact-provider failure ([OAR-FACT-23]):
        // an unavailable observation or a wrong runtime type. The block stands
        // without copy; nothing is coerced and no new on_error starts.
        if (!(err instanceof CopyRenderError) && !(err instanceof EvalError)) throw err;
      }
    } else {
      decision = {
        ...winner.decision,
        copy: renderCopyRecord(winner.rule.copy, winner.facts, opts.env),
      };
    }
  }
  return { decision, trace, counters: counters.snapshot() };
}

/** A decision candidate together with the rule and facts it would render from. */
interface Draft {
  readonly decision: Decision;
  readonly rule: Rule | null;
  readonly facts: Readonly<Record<string, Value>>;
  readonly fromOnError: boolean;
}

/**
 * The fact environment available to an on_error block's copy: the occurrence's
 * facts plus the carrier rule's counter facts, without detector observations —
 * the detector is what failed.
 */
function baseFacts(
  rule: Rule | null,
  occ: Occurrence,
  counters: CounterStore,
): Record<string, Value> {
  const facts: Record<string, Value> = { ...occ.facts };
  if (rule && occ.sessionID !== undefined) {
    facts['breaker_count'] = BigInt(counters.get(occ.sessionID, rule.id, 'breaker_count'));
    facts['fire_count'] = BigInt(counters.get(occ.sessionID, rule.id, 'fire_count'));
  }
  return facts;
}

function fires(
  rule: Rule,
  occ: Occurrence,
  opts: EngineOptions,
  counters: CounterStore,
): { fired: boolean; facts: Record<string, Value> } {
  let facts: Record<string, Value> = { ...occ.facts };
  if (occ.sessionID !== undefined) {
    // Counter facts read the state from before this occurrence's own
    // side-effects, so a rule's increment cannot change what it just read.
    facts['breaker_count'] = BigInt(counters.get(occ.sessionID, rule.id, 'breaker_count'));
    facts['fire_count'] = BigInt(counters.get(occ.sessionID, rule.id, 'fire_count'));
  }
  if (rule.kind === 'detector' && rule.detectorRef) {
    const detector = opts.detectors?.[rule.detectorRef];
    if (!detector) throw new EvalError(`detector ${rule.detectorRef} is not registered`);
    facts = { ...facts, ...detector({ ...occ, facts }) };
  }
  if (rule.flow.length > 0 && !flowMatches(occ.recentTools ?? [], rule.flow)) {
    return { fired: false, facts };
  }
  if (rule.ast === null) return { fired: true, facts }; // neither when nor a failed flow
  const ctx: EvalContext = {
    facts,
    env: opts.env,
    functions: observationFunctions(facts, opts.env),
  };
  const v = evaluate(rule.ast, ctx);
  if (typeof v !== 'boolean') throw new EvalError('condition did not evaluate to a boolean');
  return { fired: v, facts };
}

function onError(rule: Rule, err: unknown): Decision | null {
  if (rule.onError === 'fail_open') return null;
  const code = rule.onError === 'fail_closed' || rule.onError === '' ? rule.id : rule.onError;
  void err;
  return { effect: 'block', code, onFire: [] };
}

/**
 * flow matches when its steps appear in order in the recent activity window.
 * The subsequence need not be contiguous.
 */
export function flowMatches(recent: readonly string[], pattern: readonly string[]): boolean {
  let i = 0;
  for (const name of recent) {
    if (name === pattern[i]) {
      i++;
      if (i === pattern.length) return true;
    }
  }
  return pattern.length === 0;
}

// Selector clauses are conjunctive; an omitted clause is permissive; a clause
// naming a dimension the occurrence does not report does not match.
function selectorMatches(sel: Selector, facts: Readonly<Record<string, Value>>): boolean {
  const str = (key: string): string | undefined => {
    const v = facts[key];
    return typeof v === 'string' && v !== '' ? v : undefined;
  };
  if (sel.tools && sel.tools.length > 0) {
    const tool = str('tool');
    if (tool === undefined || !sel.tools.includes(tool)) return false;
  }
  return true;
}

// Observation functions read the same facts as the condition around them.
function observationFunctions(
  facts: Readonly<Record<string, Value>>,
  env: Environment,
): Record<string, (arg: Value) => Value> {
  const ctx: EvalContext = { facts, env, functions: {} };
  const resultMember = (key: Value): unknown => {
    const result = factValue('mcp_result', ctx) as Record<string, unknown>;
    const v = result[String(key)];
    return v === null ? undefined : v;
  };
  return {
    path_outside_scope: (arg) => {
      const tool = facts['tool'];
      if (typeof arg === 'string' && typeof tool === 'string' && arg !== tool) return false;
      const v = facts['path_outside_scope'];
      return v === true;
    },
    // A member of mcp_result read through a typed accessor: absent reads as the
    // zero value, a member of another type is a fact-provider failure.
    mcp_field_bool: (key) => {
      const v = resultMember(key);
      if (v === undefined) return false;
      if (typeof v !== 'boolean') throw new EvalError(`mcp_result.${String(key)} is not a bool`);
      return v;
    },
    mcp_field_int: (key) => {
      const v = resultMember(key);
      if (v === undefined) return 0n;
      if (typeof v === 'bigint') return v;
      if (typeof v !== 'number' || !Number.isInteger(v)) {
        throw new EvalError(`mcp_result.${String(key)} is not an int`);
      }
      return BigInt(v);
    },
  };
}
