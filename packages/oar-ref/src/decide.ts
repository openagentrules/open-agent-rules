// Selection, ordering, evaluation, and the decision for one anchor occurrence.
// This file is the numbered runner algorithm, steps 6 to 12.

import { evaluate, EvalError, factValue, type EvalContext, type Value } from './eval.js';
import type { Environment } from './env.js';
import { renderCopyRecord, CopyRenderError } from './copy.js';
import { identity, type OnFireAction, type Rule, type Selector } from './load.js';

export type Outcome = 'fired' | 'passed' | 'errored' | 'monitor';

export interface TraceEntry {
  readonly rule: string;
  readonly outcome: Outcome;
}

export interface Decision {
  readonly effect: 'block' | 'warn' | 'nudge';
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

/** The facts an engine maintains itself and no provider supplies ([OAR-FIRE-10]). */
export const ENGINE_MAINTAINED = ['fire_count', 'breaker_count', 'same_code_reject_run', 'same_call_run'] as const;

/** A detector reports observations; the rule's condition owns every threshold. */
export type Detector = (occurrence: Occurrence) => Record<string, Value>;

export interface EngineOptions {
  readonly env: Environment;
  readonly detectors?: Readonly<Record<string, Detector>>;
}

interface PastOccurrence {
  readonly decision: Decision | null;
  readonly tool: Value;
  readonly toolArgs: Value;
}

/**
 * Session state an engine keeps across occurrences: each rule's counters,
 * keyed by session and rule identity ([OAR-FIRE-4]), and the history the run
 * facts are computed from ([OAR-FIRE-8], [OAR-FIRE-9]).
 */
export class CounterStore {
  private readonly data = new Map<string, Map<string, number>>();
  private readonly past = new Map<string, PastOccurrence[]>();

  get(sessionID: string, ruleIdentity: string, kind: string): number {
    return this.data.get(`${sessionID}\u0000${ruleIdentity}`)?.get(kind) ?? 0;
  }

  apply(sessionID: string, ruleIdentity: string, actions: readonly OnFireAction[]): void {
    const key = `${sessionID}\u0000${ruleIdentity}`;
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

  /** The run facts at a new occurrence, from the earlier ones at the same anchor. */
  runFacts(sessionID: string, anchor: string, tool: Value, toolArgs: Value): { codeRun: number; callRun: number } {
    const history = this.past.get(`${sessionID}\u0000${anchor}`) ?? [];
    let codeRun = 0;
    const latest = history.at(-1)?.decision;
    if (latest && latest.effect === 'block') {
      for (let i = history.length - 1; i >= 0; i--) {
        const d = history[i]!.decision;
        if (!d || d.effect !== 'block' || d.code !== latest.code) break;
        codeRun++;
      }
    }
    let callRun = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      const h = history[i]!;
      if (!jsonEqual(h.tool, tool) || !jsonEqual(h.toolArgs, toolArgs)) break;
      callRun++;
    }
    return { codeRun, callRun };
  }

  record(sessionID: string, anchor: string, entry: PastOccurrence): void {
    const key = `${sessionID}\u0000${anchor}`;
    const history = this.past.get(key) ?? [];
    history.push(entry);
    this.past.set(key, history);
  }

  snapshot(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const [key, m] of this.data) {
      out[key.slice(key.indexOf('\u0000') + 1)] = Object.fromEntries(m);
    }
    return out;
  }
}

/** [OAR-FACT-20] JSON value equality: member order is irrelevant, numbers compare by value. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (typeof a === 'bigint' || typeof b === 'bigint') return Number(a) === Number(b) && typeof Number(a) === 'number';
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    return ka.length === kb.length && ka.every((k) =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return a === b;
}

// Identifiers and namespaces compare by Unicode code point ([OAR-EVAL-1]).
function codePointCompare(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return x.length - y.length;
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
    .sort((a, b) =>
      (KIND_ORDER[a.kind] ?? 99) - (KIND_ORDER[b.kind] ?? 99) ||
      codePointCompare(a.id, b.id) ||
      codePointCompare(a.namespace, b.namespace));

  // Run facts are fixed for the whole occurrence ([OAR-FACT-21]); a provider
  // never supplies them ([OAR-FIRE-10]).
  const run = occ.sessionID !== undefined
    ? counters.runFacts(occ.sessionID, occ.anchor, occ.facts['tool'] ?? '', occ.facts['tool_args'] ?? {})
    : { codeRun: 0, callRun: 0 };
  const shared: Record<string, Value> = {
    ...occ.facts,
    same_code_reject_run: BigInt(run.codeRun),
    same_call_run: BigInt(run.callRun),
  };
  const ctx: OccurrenceContext = { occ, facts: shared, rules, counters };

  const trace: TraceEntry[] = [];
  const pending: Rule[] = [];
  const blocks: Draft[] = [];
  const nudges: Draft[] = [];
  const warns: Draft[] = [];

  for (const rule of selected) {
    let fired: boolean;
    let facts: Record<string, Value> = ruleFacts(rule, ctx);
    try {
      const r = fires(rule, ctx, opts);
      fired = r.fired;
      facts = r.facts;
    } catch (err) {
      trace.push({ rule: identity(rule), outcome: 'errored' });
      // [OAR-OPS-8] Monitoring never acts, including on its own failures.
      if (rule.enforcement === 'monitor') continue;
      const handled = onError(rule, err);
      if (handled === null) continue;      // fail_open
      // The block carries the copy of the rule whose identifier it carries:
      // the failed rule itself under fail_closed, the named substitute in the
      // same namespace otherwise ([OAR-COPY-7], [OAR-OPS-4]).
      const carrier = rules.find((r) => r.id === handled.code && r.namespace === rule.namespace) ?? null;
      blocks.push({
        decision: handled,
        rule: carrier,
        facts: carrier ? ruleFacts(carrier, ctx) : shared,
        fromOnError: true,
      });
      break;                                // fail_closed stops the occurrence
    }
    if (!fired) {
      trace.push({ rule: identity(rule), outcome: 'passed' });
      continue;
    }
    if (rule.enforcement === 'monitor') {
      // Recorded, but no effect, no side-effect, and no short-circuit.
      trace.push({ rule: identity(rule), outcome: 'monitor' });
      continue;
    }
    trace.push({ rule: identity(rule), outcome: 'fired' });
    // Side-effects apply after evaluation, so every rule reads the counters as
    // they stood before this occurrence ([OAR-FIRE-5]).
    if (rule.onFire.length > 0) pending.push(rule);
    if (rule.effect === 'allow') continue;
    const draft: Draft = {
      decision: { effect: rule.effect, code: rule.id, onFire: rule.onFire },
      rule,
      facts,
      fromOnError: false,
    };
    if (rule.effect === 'block') {
      blocks.push(draft);
      break; // the first enforced block short-circuits
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
  if (occ.sessionID !== undefined) {
    for (const rule of pending) counters.apply(occ.sessionID, identity(rule), rule.onFire);
    counters.record(occ.sessionID, occ.anchor, {
      decision, tool: occ.facts['tool'] ?? '', toolArgs: occ.facts['tool_args'] ?? {},
    });
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

interface OccurrenceContext {
  readonly occ: Occurrence;
  /** The occurrence's facts with the run facts filled in. */
  readonly facts: Readonly<Record<string, Value>>;
  readonly rules: readonly Rule[];
  readonly counters: CounterStore;
}

/** The facts one rule sees: the occurrence's, plus its own counters. */
function ruleFacts(rule: Rule, ctx: OccurrenceContext): Record<string, Value> {
  const session = ctx.occ.sessionID;
  const read = (kind: string) => BigInt(session === undefined ? 0 : ctx.counters.get(session, identity(rule), kind));
  return { ...ctx.facts, fire_count: read('fire_count'), breaker_count: read('breaker_count') };
}

function fires(
  rule: Rule,
  ctx: OccurrenceContext,
  opts: EngineOptions,
): { fired: boolean; facts: Record<string, Value> } {
  let facts = ruleFacts(rule, ctx);
  if (rule.kind === 'detector' && rule.detectorRef) {
    const detector = opts.detectors?.[rule.detectorRef];
    if (!detector) throw new EvalError(`detector ${rule.detectorRef} is not registered`);
    facts = { ...facts, ...detector({ ...ctx.occ, facts }) };
  }
  if (rule.flow.length > 0 && !flowMatches(ctx.occ.recentTools ?? [], rule.flow)) {
    return { fired: false, facts };
  }
  if (rule.ast === null) return { fired: true, facts }; // neither when nor a failed flow
  const evalCtx: EvalContext = {
    facts,
    env: opts.env,
    functions: observationFunctions(rule, facts, ctx, opts.env),
  };
  const v = evaluate(rule.ast, evalCtx);
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
  rule: Rule,
  facts: Readonly<Record<string, Value>>,
  occCtx: OccurrenceContext,
  env: Environment,
): Record<string, (arg: Value) => Value> {
  const ctx: EvalContext = { facts, env, functions: {} };
  const resultMember = (key: Value): unknown => {
    const result = factValue('mcp_result', ctx) as Record<string, unknown>;
    const v = result[String(key)];
    return v === null ? undefined : v;
  };
  // [OAR-FIRE-6] Another rule's counters, in the reading rule's namespace.
  const counterOf = (kind: string) => (id: Value): Value => {
    const session = occCtx.occ.sessionID;
    if (session === undefined) return 0n;
    const target = rule.namespace ? `${rule.namespace}/${String(id)}` : String(id);
    return BigInt(occCtx.counters.get(session, target, kind));
  };
  return {
    fire_count_of: counterOf('fire_count'),
    breaker_count_of: counterOf('breaker_count'),
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
      if (typeof v !== 'number' || !Number.isSafeInteger(v)) {
        throw new EvalError(`mcp_result.${String(key)} is not an int`);
      }
      return BigInt(v);
    },
  };
}
