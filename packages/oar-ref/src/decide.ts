// Selection, ordering, evaluation, suppression, and the decision for one anchor
// occurrence. This file is section 10.1's runner algorithm, steps 8 to 16.

import { copyLookup, renderCopy } from './copy.js';
import { codePoints, ConditionRaise, evaluate, zeroValue, validateFactValue, type EvalContext, type Value } from './eval.js';
import type { Environment } from './capability.js';
import { resolveRef, type LoadedRule, type RuleSet, type TransformSpec } from './load.js';
import {
  COUNTER_READERS,
  KIND_ORDER,
  ON_FIRE_WRITES,
  type Effect,
  type Enforcement,
  type FactType,
  type OnFireAction,
} from './vocab.js';

/**
 * [OAR-OPS-9] The seven outcomes an applied-rules trace records. Monitor mode
 * gets three of them rather than one because the whole question it exists to
 * answer is *would this rule have fired?* — a single `monitored` outcome would
 * record that a rule was observed while discarding what was observed.
 */
export type Outcome =
  | 'fired'
  | 'passed'
  | 'errored'
  | 'suppressed'
  | 'monitored_fired'
  | 'monitored_passed'
  | 'monitored_errored';

export interface TraceEntry {
  readonly rule: string;
  readonly outcome: Outcome;
}

export interface Advisory {
  /** [OAR-EVAL-20] The bare id of this advisory. */
  readonly code: string;
  /** [OAR-EVAL-20] The qualified identifier of this advisory. */
  readonly rule: string;
  /** [OAR-COPY-9] Rendered copy of this advisory, independently of the others. */
  readonly copy: Readonly<Record<string, string>>;
}

export interface Decision {
  readonly effect: Exclude<Effect, 'allow'>;
  /** [OAR-EVAL-8] The bare id, for display and coarse routing. */
  readonly code: string;
  /** [OAR-EVAL-8] The qualified identifier, for software that must distinguish publishers. */
  readonly rule: string;
  /** [OAR-EVAL-8] The accumulated transform list, when the effect is transform. */
  readonly transforms: readonly TransformSpec[];
  /**
   * [OAR-EVAL-20] Every enforced rule that fired with the winning advisory
   * effect, in evaluation order. Empty when the decision is block, transform,
   * or none.
   */
  readonly advisories: readonly Advisory[];
  readonly onFire: readonly OnFireAction[];
  /** [OAR-COPY-7] Rendered copy of the rule whose identifiers this decision carries. */
  readonly copy: Readonly<Record<string, string>>;
}

export interface EventRecord {
  readonly rule: string;
  readonly anchor: string;
  readonly effect: Effect;
}

export interface Occurrence {
  /** The core anchor identifier, or a host-native anchor identifier. */
  readonly anchor: string;
  readonly facts: Readonly<Record<string, unknown>>;
  readonly recentActivity: readonly string[];
  readonly sessionId: string;
  /** [OAR-CONF-34] The content at the occurrence, for a content anchor. */
  readonly content?: string;
  /**
   * [OAR-CONF-25] Facts detector://fixture produces when a rule causes it to
   * run. They reach the environment only through the detector's invocation.
   */
  readonly detectorFacts?: Readonly<Record<string, unknown>>;
}

export interface SkippedTransform { readonly rule: string; readonly start: number; readonly end: number; readonly reason: 'overlap'; }

export interface Result {
  readonly skippedTransforms: readonly SkippedTransform[];
  readonly decision: Decision | null;
  readonly trace: readonly TraceEntry[];
  /** [OAR-CONF-21] Side-effects the engine applied, in application order. */
  readonly onFire: readonly OnFireAction[];
  readonly transforms: readonly TransformSpec[];
  /**
   * [OAR-CONF-21], [OAR-CONF-33] The counters this occurrence changed, and only
   * those: an engine enumerating untouched zeroes would compare unequal to one
   * that did not, for the same outcome.
   */
  readonly counters: Readonly<Record<string, CounterPair>>;
  readonly events: readonly EventRecord[];
  /**
   * [OAR-CONF-34] The content after the accumulated transforms were applied,
   * present only when the occurrence carried content.
   */
  readonly content?: string;
}

/**
 * [OAR-CONF-33] How a counter is spelled in a report and in a fixture: the
 * qualified identifier alone for a rule with no `counter_scope`, and
 * `<qualified id>#<scope value>` for a rule that has one. A scoped rule
 * therefore has as many counters as its scope fact has values, and a fixture
 * names the one it means.
 */
export function counterKey(rule: LoadedRule, scope: string): string {
  return rule.counterScope === undefined ? rule.qualified : `${rule.qualified}#${scope}`;
}

export interface CounterPair {
  fire_count: number;
  breaker_count: number;
}

/**
 * [OAR-FIRE-5] A counter is keyed by the qualified identifier of the rule
 * declaring the action, by the session, and by the rule's counter scope value
 * ([OAR-FIRE-10]). A rule with no `counter_scope` has the empty string as its
 * scope value at every occurrence, so its counters are keyed by rule and
 * session alone.
 */
export class CounterStore {
  private readonly data = new Map<string, CounterPair>();
  /** Test seam for [OAR-FIRE-9]: a counter store that refuses the write. */
  failOn: ReadonlySet<string> = new Set();

  private key(session: string, counter: string): string {
    return `${session}\0${counter}`;
  }

  /**
   * [OAR-FIRE-10], [OAR-CONF-33] `counter` is the counter's own identifier: the
   * qualified rule identifier for a rule with no `counter_scope`, and
   * `<qualified id>#<scope value>` for a rule that has one. Whether a rule's
   * counters are scoped is decided by whether the field is present, never by the
   * value it takes — so a rule scoped by a fact that happens to be empty keeps a
   * counter distinct from an unscoped rule's, and the two never merge.
   */
  get(session: string, counter: string): CounterPair {
    return this.data.get(this.key(session, counter)) ?? { fire_count: 0, breaker_count: 0 };
  }

  apply(session: string, counter: string, action: OnFireAction): void {
    if (this.failOn.has(counter) || this.failOn.has(counter.split('#')[0]!)) {
      throw new Error(`counter store refused the write for ${counter}`);
    }
    const field = ON_FIRE_WRITES[action];
    if (field === null) return;
    const key = this.key(session, counter);
    const current = this.data.get(key) ?? { fire_count: 0, breaker_count: 0 };
    // [OAR-FIRE-4] increment adds one; reset sets the value to zero.
    const next = { ...current };
    if (action === "increment_counter" || action === "increment_breaker") next[field] = current[field] + 1;
    else next[field] = 0;
    this.data.set(key, next);
  }
}

/** [OAR-OPS-11] A detector returns observations, never a verdict. */
export type Detector = (occ: Occurrence) => Record<string, unknown>;

/** [OAR-CONF-25] The three detector references the corpus reserves. */
export const RESERVED_DETECTOR_IMPLS: Readonly<Record<string, Detector>> = {
  'detector://noop': () => ({}),
  // Reports the fixture's detector_facts when invoked, and otherwise no
  // findings of its own, leaving the facts the fixture supplied in place —
  // which is how a fixture proves the rule owns the threshold, and how one
  // proves a detector-produced fact reaches everything the invoking rule does
  // with it, the transform target included.
  'detector://fixture': (occ) => ({ ...(occ.detectorFacts ?? {}) }),
  'detector://error': () => {
    throw new Error('detector://error always fails');
  },
};

export interface DecideOptions {
  readonly env: Environment;
  readonly detectors?: Readonly<Record<string, Detector>>;
  readonly counters?: CounterStore;
  /** Enforcement after operator configuration, keyed by qualified identifier. */
  readonly enforcement?: ReadonlyMap<string, Enforcement>;
}

interface Contribution {
  readonly rule: LoadedRule;
  readonly index: number;
  readonly copy: Readonly<Record<string, string>>;
  readonly transformFact: unknown;
}

function renderRuleCopy(
  rule: LoadedRule,
  facts: Readonly<Record<string, unknown>>,
  env: Environment,
): Record<string, string> {
  const types = new Map<string, FactType>();
  for (const [name, decl] of env.facts) types.set(name, decl.type);
  const lookup = copyLookup(facts, types);
  const out: Record<string, string> = {};
  for (const [key, text] of Object.entries(rule.copy)) {
    out[key] = renderCopy(text, lookup);
  }
  return out;
}

function renderErrorCopy(rule: LoadedRule, facts: Readonly<Record<string, unknown>>, env: Environment): Record<string, string> {
  // [OAR-COPY-11] Failed observations cannot be substituted into error copy.
  try { return renderRuleCopy(rule, facts, env); } catch { return {}; }
}

/** Evaluate one anchor occurrence against a loaded rule set. */
export function decide(set: RuleSet, occ: Occurrence, opts: DecideOptions): Result {
  const env = opts.env;
  const counters = opts.counters ?? new CounterStore();
  const detectors = opts.detectors ?? RESERVED_DETECTOR_IMPLS;
  const enforcementOf = (r: LoadedRule): Enforcement => opts.enforcement?.get(r.qualified) ?? r.enforcement;

  // [OAR-CONF-29] The occurrence anchor is the host-local identifier — the
  // value on the right of the capability document's anchors.core map. A rule's
  // own anchor was already resolved through that map at load, so the two are
  // directly comparable.
  const localAnchor = occ.anchor;
  // The core fact `anchor` reports the core anchor identifier of the occurrence
  // being evaluated, so a portable rule reads the same value on every host
  // whatever local name that host gave the moment.
  const coreAnchor = env.coreForLocal.get(occ.anchor) ?? occ.anchor;

  // [OAR-CONF-8] Select the rules whose resolved anchor matches, whose
  // enforcement is not off, and whose selector clauses all match.
  const selected = set.rules.filter(
    (r) =>
      r.resolvedAnchor === localAnchor &&
      // [OAR-EVAL-11] A rule whose enforcement is off is not selected, not
      // evaluated, and not recorded in the trace.
      enforcementOf(r) !== 'off' &&
      selectorMatches(r, occ, env, coreAnchor),
  );

  const order = evaluationOrder(selected, set);

  // [OAR-FIRE-10] A rule's counter scope value at an occurrence is the value of
  // the fact its counter_scope names. A rule with no counter_scope has the empty
  // string at every occurrence, so its counters are keyed by rule and session
  // alone. The value is resolved once per rule per occurrence, so two reads of
  // one rule's counters cannot disagree about which counter they meant.
  const scopeCache = new Map<string, string>();
  const scopeValueOf = (rule: LoadedRule): string => {
    if (rule.counterScope === undefined) return '';
    const cached = scopeCache.get(rule.qualified);
    if (cached !== undefined) return cached;
    const name = rule.counterScope;
    const raw = name === 'anchor' ? coreAnchor : occ.facts[name];
    // Missing scoped facts read as empty strings ([OAR-FACT-25]).
    if (raw !== undefined && typeof raw !== 'string') {
      throw new ConditionRaise(`counter_scope fact ${name} is not a string`);
    }
    const value = raw === undefined ? '' : raw;
    scopeCache.set(rule.qualified, value);
    return value;
  };

  // Conditions share the pre-occurrence counter snapshot ([OAR-FIRE-6]).
  const snapshot = new Map<string, CounterPair>();
  const readCounters = (rule: LoadedRule): CounterPair => {
    const key = counterKey(rule, scopeValueOf(rule));
    const hit = snapshot.get(key);
    if (hit !== undefined) return hit;
    const value = counters.get(occ.sessionId, key);
    snapshot.set(key, value);
    return value;
  };

  const trace: TraceEntry[] = [];
  const traceIndex = new Map<string, number>();
  const contributions: Contribution[] = [];
  const pending: { rule: LoadedRule; index: number }[] = [];
  const suppressed = new Set<string>();
  let errorDecision: Decision | null = null;
  let shortCircuit = false;

  const record = (rule: LoadedRule, outcome: Outcome): number => {
    const index = trace.length;
    trace.push({ rule: rule.qualified, outcome });
    traceIndex.set(rule.qualified, index);
    return index;
  };

  for (const rule of order) {
    // Suppressed rules remain traceable ([OAR-EVAL-14], [OAR-OPS-10]).
    if (suppressed.has(rule.qualified)) {
      record(rule, 'suppressed');
      continue;
    }
    // Every other rule after a short-circuit is omitted from the trace.
    if (shortCircuit) continue;

    let fired: boolean;
    let assembledFacts: Readonly<Record<string, unknown>> = occ.facts;
    let transformFact: unknown;
    try {
      fired = fires(rule, occ, env, detectors, coreAnchor, set, readCounters, (supplied) => {
        assembledFacts = supplied;
        // [OAR-FACT-11] A rule references a fact from its transform target as
        // much as from its condition; keeping the facts assembled for the rule
        // is what lets a detector-supplied span list reach the mutation.
        const target = rule.transform?.target;
        if (target !== undefined && target !== 'content') {
          transformFact = supplied[target];
        }
      });
    } catch (err) {
      // [OAR-OPS-3] A fact provider failure, a detector failure, or a condition
      // raising at run time are the cases in which a rule cannot be evaluated.
      void err;
      // [OAR-EVAL-10] A monitor rule that raises is recorded monitored_errored
      // and its on_error is NOT applied. Were fail_closed to survive monitor
      // mode, the rollout path for an unproven rule could block production
      // traffic — the one thing monitor mode exists to prevent.
      if (enforcementOf(rule) === 'monitor') {
        record(rule, 'monitored_errored');
        continue;
      }
      record(rule, 'errored');
      if (rule.onError === 'fail_open') {
        // [OAR-OPS-4] Record the failure and continue: no decision, no side-effect.
        continue;
      }
      const substitute = set.errorSubstitute.get(rule.qualified);
      const target = substitute !== undefined ? set.byId.get(substitute)! : rule;
      // [OAR-OPS-3], [OAR-OPS-5] Produce a block carrying the rule's — or the
      // substituted rule's — identifiers, and stop evaluating the occurrence.
      errorDecision = {
        effect: 'block',
        code: target.id,
        rule: target.qualified,
        transforms: [],
        advisories: [],
        onFire: [],
        copy: renderErrorCopy(target, occ.facts, env),
      };
      shortCircuit = true;
      continue;
    }

    const enforcement = enforcementOf(rule);
    if (enforcement === 'monitor') {
      // [OAR-EVAL-10], [OAR-OPS-1] Evaluated and recorded, but it contributes no
      // decision, applies no side-effect, suppresses nothing, and does not
      // short-circuit. The outcome still says which way it went, because that
      // is the only question monitor mode exists to answer.
      record(rule, fired ? 'monitored_fired' : 'monitored_passed');
      continue;
    }
    if (!fired) {
      record(rule, 'passed');
      continue;
    }

    const index = record(rule, 'fired');

    // [OAR-EVAL-14] Suppression takes effect the moment the suppressor fires.
    // [OAR-EVAL-15] It does not transit: only the rules this rule names.
    for (const target of set.suppresses.get(rule.qualified) ?? []) {
      suppressed.add(target);
      const at = traceIndex.get(target);
      if (at !== undefined && trace[at]!.outcome !== 'suppressed') {
        trace[at] = { rule: target, outcome: 'suppressed' };
      }
    }

    if (rule.onFire.length > 0) pending.push({ rule, index });
    // [OAR-EVAL-7] A rule firing with allow contributes no decision.
    if (rule.effect !== 'allow') {
      contributions.push({ rule, index, copy: renderRuleCopy(rule, assembledFacts, env), transformFact });
    }

    // [OAR-EVAL-4] The first enforced rule firing with block short-circuits the
    // occurrence. [OAR-EVAL-5] a transform does not.
    if (rule.effect === 'block') shortCircuit = true;
  }

  // [OAR-EVAL-12], [OAR-CONF-15] Apply the on_fire actions of every rule that
  // fired and was enforced and was not suppressed, including rules whose effect
  // lost precedence. Actions of one rule apply in the order listed, and rules
  // apply in the evaluation order of [OAR-EVAL-1] ([OAR-FIRE-8]).
  const applied: OnFireAction[] = [];
  const events: EventRecord[] = [];
  let sideEffectFailure: { rule: LoadedRule } | null = null;
  const failed = new Set<string>();
  // [OAR-CONF-21] Only a counter this occurrence actually changed is reported,
  // under the [OAR-CONF-33] spelling.
  const touched = new Set<string>();
  for (const entry of pending) {
    if (suppressed.has(entry.rule.qualified)) continue;
    for (const action of entry.rule.onFire) {
      try {
        if (action === 'publish_event') {
          // [OAR-FIRE-7] One record to the host's event stream. It writes no
          // fact and is not observable to any condition.
          events.push({ rule: entry.rule.qualified, anchor: occ.anchor, effect: entry.rule.effect });
        } else {
          const key = counterKey(entry.rule, scopeValueOf(entry.rule));
          counters.apply(occ.sessionId, key, action);
          touched.add(key);
        }
        applied.push(action);
      } catch (err) {
        // [OAR-FIRE-9] A declared side-effect is an obligation, not a hint. An
        // engine that cannot apply one treats the rule as one that cannot be
        // evaluated, and handles it per its on_error.
        void err;
        sideEffectFailure = { rule: entry.rule };
        break;
      }
    }
    if (sideEffectFailure !== null) break;
  }

  if (sideEffectFailure !== null) {
    const rule = sideEffectFailure.rule;
    // The rule could not be evaluated, so it contributes nothing either way:
    // [OAR-OPS-4] under fail_open, and [OAR-OPS-3] under fail_closed.
    failed.add(rule.qualified);
    const at = traceIndex.get(rule.qualified);
    if (at !== undefined) trace[at] = { rule: rule.qualified, outcome: 'errored' };
    if (rule.onError !== 'fail_open') {
      const substitute = set.errorSubstitute.get(rule.qualified);
      const target = substitute !== undefined ? set.byId.get(substitute)! : rule;
      errorDecision = {
        effect: 'block',
        code: target.id,
        rule: target.qualified,
        transforms: [],
        advisories: [],
        onFire: [],
        copy: renderErrorCopy(target, occ.facts, env),
      };
    }
  }

  // [OAR-OPS-19] A transform whose spans cannot be read is one the engine cannot
  // apply, so the rule declaring it is handled per its on_error exactly as a
  // failed side-effect is ([OAR-FIRE-9]). Checked before the decision resolves,
  // so a rule that cannot deliver its mutation does not contribute one.
  if (sideEffectFailure === null && occ.content !== undefined) {
    const length = codePoints(occ.content).length;
    for (const entry of contributions) {
      const spec = entry.rule.transform;
      if (spec === undefined || spec.target === 'content') continue;
      if (suppressed.has(entry.rule.qualified) || failed.has(entry.rule.qualified)) continue;
      try {
        readSpans(entry.transformFact, length);
      } catch {
        failed.add(entry.rule.qualified);
        const at = traceIndex.get(entry.rule.qualified);
        if (at !== undefined) trace[at] = { rule: entry.rule.qualified, outcome: 'errored' };
        if (entry.rule.onError !== 'fail_open') {
          const substitute = set.errorSubstitute.get(entry.rule.qualified);
          const target = substitute !== undefined ? set.byId.get(substitute)! : entry.rule;
          errorDecision = {
            effect: 'block',
            code: target.id,
            rule: target.qualified,
            transforms: [],
            advisories: [],
            onFire: [],
            copy: renderErrorCopy(target, occ.facts, env),
          };
        }
        break;
      }
    }
  }

  const report: Record<string, CounterPair> = {};
  for (const key of touched) report[key] = { ...counters.get(occ.sessionId, key) };

  // [OAR-OPS-6] A block produced under [OAR-OPS-3] or [OAR-OPS-5] takes
  // precedence over any effect already recorded at the occurrence.
  if (errorDecision !== null) {
    return {
      skippedTransforms: [],
      decision: errorDecision,
      trace,
      onFire: applied,
      transforms: [],
      counters: report,
      events,
      // [OAR-OPS-17] There is nothing to mutate: the content is not delivered.
      ...(occ.content === undefined ? {} : { content: occ.content }),
    };
  }

  // [OAR-EVAL-6], [OAR-CONF-14] Decision precedence: block, transform, nudge,
  // warn, otherwise none.
  const live = contributions.filter(
    (c) => !suppressed.has(c.rule.qualified) && !failed.has(c.rule.qualified),
  );
  const decision = resolve(live);
  // [OAR-OPS-17] A block discards every accumulated transform, so `resolve`
  // already carries an empty list for one.
  const transforms = decision?.effect === 'transform' ? decision.transforms : [];
  const transformFacts = live
    .filter((entry) => entry.rule.effect === 'transform')
    .map((entry) => entry.transformFact);
  const skippedTransforms: SkippedTransform[] = [];
  const transformedContent = occ.content === undefined ? undefined : applyTransforms(occ.content, transforms, {}, transformFacts, skippedTransforms, live.filter(c => c.rule.effect === "transform").map(c => c.rule.qualified));
  return {
    skippedTransforms,
    decision,
    trace,
    onFire: applied,
    transforms,
    counters: report,
    events,
    ...(occ.content === undefined
      ? {}
      : { content: transformedContent! }),
  };
}

function advisoryOf(c: Contribution): Advisory {
  return { code: c.rule.id, rule: c.rule.qualified, copy: c.copy };
}

function resolve(live: readonly Contribution[]): Decision | null {
  const first = (effect: Effect): Contribution | undefined => live.find((c) => c.rule.effect === effect);

  const blocked = first('block');
  if (blocked !== undefined) {
    // [OAR-OPS-17] A block discards every accumulated transform: the content is
    // not delivered, so there is nothing to mutate.
    return {
      effect: 'block',
      code: blocked.rule.id,
      rule: blocked.rule.qualified,
      transforms: [],
      advisories: [],
      onFire: blocked.rule.onFire,
      copy: blocked.copy,
    };
  }

  // [OAR-OPS-15] Accumulate the transforms of every enforced rule that fired, in
  // evaluation order, and carry the list in the decision.
  const transformers = live.filter((c) => c.rule.effect === 'transform');
  if (transformers.length > 0) {
    const head = transformers[0]!;
    return {
      effect: 'transform',
      code: head.rule.id,
      rule: head.rule.qualified,
      transforms: transformers.map((c) => c.rule.transform!),
      // [OAR-EVAL-20] Transform outranks the advisories; the list is empty.
      advisories: [],
      onFire: head.rule.onFire,
      copy: head.copy,
    };
  }

  for (const effect of ['nudge', 'warn'] as const) {
    // [OAR-EVAL-20] Every enforced rule that fired with this effect, in
    // evaluation order. The first is the named decision ([OAR-EVAL-19]).
    const hits = live.filter((c) => c.rule.effect === effect);
    const head = hits[0];
    if (head !== undefined) {
      return {
        effect,
        code: head.rule.id,
        rule: head.rule.qualified,
        transforms: [],
        advisories: hits.map(advisoryOf),
        onFire: head.rule.onFire,
        copy: head.copy,
      };
    }
  }
  return null;
}

/**
 * [OAR-EVAL-1], [OAR-EVAL-18] The deterministic evaluation order: every selected
 * rule whose `overrides` names another selected rule comes before any rule so
 * named; where that does not constrain two rules, ascending by `kind` then by
 * qualified identifier. The order chosen is the one that disturbs the base
 * ordering least — the lexicographically smallest topological order — so it
 * remains a function of the rule set alone.
 */
export function evaluationOrder(selected: readonly LoadedRule[], set: RuleSet): LoadedRule[] {
  const base = [...selected].sort(compareBase);
  const present = new Set(base.map((r) => r.qualified));

  const indegree = new Map<string, number>();
  const edges = new Map<string, string[]>();
  for (const rule of base) {
    indegree.set(rule.qualified, indegree.get(rule.qualified) ?? 0);
    const targets = (set.suppresses.get(rule.qualified) ?? []).filter((t) => present.has(t));
    edges.set(rule.qualified, targets);
    for (const target of targets) indegree.set(target, (indegree.get(target) ?? 0) + 1);
  }

  const byId = new Map(base.map((r) => [r.qualified, r] as const));
  const remaining = base.map((r) => r.qualified);
  const out: LoadedRule[] = [];
  while (remaining.length > 0) {
    // Take the first ready rule in base order: that is the least disturbance.
    const at = remaining.findIndex((id) => (indegree.get(id) ?? 0) === 0);
    // A cycle is impossible: [OAR-EVAL-16] rejects one at load.
    const pick = at === -1 ? 0 : at;
    const id = remaining.splice(pick, 1)[0]!;
    out.push(byId.get(id)!);
    for (const target of edges.get(id) ?? []) indegree.set(target, (indegree.get(target) ?? 1) - 1);
  }
  return out;
}

function compareBase(a: LoadedRule, b: LoadedRule): number {
  const ka = KIND_ORDER[a.kind];
  const kb = KIND_ORDER[b.kind];
  if (ka !== kb) return ka - kb;
  // Compared by Unicode code point.
  const x = [...a.qualified];
  const y = [...b.qualified];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const p = x[i]!.codePointAt(0)!;
    const q = y[i]!.codePointAt(0)!;
    if (p !== q) return p < q ? -1 : 1;
  }
  return x.length - y.length;
}

function fires(
  rule: LoadedRule,
  occ: Occurrence,
  env: Environment,
  detectors: Readonly<Record<string, Detector>>,
  coreAnchor: string,
  set: RuleSet,
  readCounters: (rule: LoadedRule) => CounterPair,
  /** Receives the facts assembled for this rule, so a transform target reaches them. */
  assembled?: (supplied: Readonly<Record<string, unknown>>) => void,
): boolean {
  // Flow precedes the potentially raising condition ([OAR-EVAL-3]).
  if (rule.hasFlow && !flowMatches(occ.recentActivity, rule.flow)) return false;

  let supplied: Record<string, unknown> = occ.facts;
  const publish = (): void => assembled?.(supplied);

  // Detector facts are assembled after selection and flow ([OAR-FACT-11]).
  if (rule.detectorRef !== undefined) {
    const detector = detectors[rule.detectorRef];
    if (detector === undefined) throw new ConditionRaise(`detector ${rule.detectorRef} is unreachable`);
    supplied = { ...supplied, ...detector(occ) };
  }
  // [OAR-FIRE-5], [OAR-FIRE-10] fire_count and breaker_count are this rule's
  // own counters, read under this rule's own counter scope value.
  const counters = readCounters(rule);
  const facts = factEnvironment(rule, env, supplied, counters, coreAnchor);
  supplied = { ...supplied, ...Object.fromEntries(facts) };
  publish();
  if (rule.when === null) return true;
  const functions = observationFunctions(rule, env, supplied, set, readCounters);
  const ctx: EvalContext = { facts, functions };
  const value = evaluate(rule.when, ctx);
  if (typeof value !== 'boolean') throw new ConditionRaise('the condition did not evaluate to a boolean');
  return value;
}

function factEnvironment(
  rule: LoadedRule,
  env: Environment,
  supplied: Readonly<Record<string, unknown>>,
  counters: { fire_count: number; breaker_count: number },
  coreAnchor: string,
): Map<string, Value> {
  const facts = new Map<string, Value>();
  // [OAR-FACT-11] Only the facts this rule references are produced.
  for (const name of rule.refs) {
    const decl = env.facts.get(name);
    if (decl === undefined) continue;
    if (name === 'anchor') {
      facts.set('anchor', coreAnchor);
      continue;
    }
    if (name === 'fire_count') {
      facts.set('fire_count', BigInt(counters.fire_count));
      continue;
    }
    if (name === 'breaker_count') {
      facts.set('breaker_count', BigInt(counters.breaker_count));
      continue;
    }
    // Missing facts take their declared zero value ([OAR-FACT-25]).
    const raw = supplied[name];
    facts.set(name, raw === undefined ? zeroValue(decl.type) : validateFactValue(raw, decl.type, name));
  }
  return facts;
}

function observationFunctions(
  rule: LoadedRule,
  env: Environment,
  supplied: Readonly<Record<string, unknown>>,
  set: RuleSet,
  readCounters: (rule: LoadedRule) => CounterPair,
): Map<string, (arg: Value) => Value> {
  const out = new Map<string, (arg: Value) => Value>();
  for (const name of rule.refs) {
    const decl = env.functions.get(name);
    if (decl === undefined) continue;
    // Cross-rule counters use the target rule's scope ([OAR-FIRE-11]).
    const counter = COUNTER_READERS[name];
    if (counter !== undefined) {
      out.set(name, (arg) => {
        const target = set.byId.get(resolveRef(String(arg), rule.namespace));
        // Unreachable: [OAR-FIRE-11] resolved every reference at load.
        if (target === undefined) throw new ConditionRaise(`${name} names ${String(arg)}, which is not loaded`);
        return BigInt(readCounters(target)[counter]);
      });
      continue;
    }
    const raw = supplied[name];
    // [OAR-CONF-26] A value supplied under the name of a declared observation
    // function is that function's result for every argument.
    const value = raw === undefined ? zeroValue(decl.sig.ret) : validateFactValue(raw, decl.sig.ret, name);
    out.set(name, () => value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Section 7.2: applying the accumulated transforms to the content.
// ---------------------------------------------------------------------------

/**
 * [OAR-OPS-13] `redact` MAY carry a replacement; when absent an engine MUST
 * substitute exactly these ten code points. The placeholder is fixed by the
 * specification, not an engine's own choice, because [OAR-CONF-34] compares
 * content code point by code point.
 */
export const REDACTION_PLACEHOLDER = '[REDACTED]';

/** [OAR-OPS-19] A span: a half-open range of Unicode code point offsets. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * [OAR-OPS-19] Read the spans a `list<map>` target fact carries. A span MUST
 * carry `start` and `end`, each a non-negative integer, zero-based, `start`
 * inclusive and `end` exclusive, with `start` not exceeding `end`. A span whose
 * range falls outside the content is ignored, and MUST NOT be treated as a rule
 * that cannot be evaluated — so a malformed member is skipped here rather than
 * raising.
 */
export function readSpans(value: unknown, length: number): Span[] {
  if (!Array.isArray(value)) return [];
  const out: Span[] = [];
  for (const member of value) {
    if (typeof member !== 'object' || member === null || Array.isArray(member)) {
      throw new ConditionRaise('a transform span is not an object');
    }
    const start = (member as Record<string, unknown>)['start'];
    const end = (member as Record<string, unknown>)['end'];
    // [OAR-OPS-19] A span MUST carry start and end, each a non-negative integer,
    // with start not exceeding end. A member that does not is not a span the
    // engine can apply, and the rule declaring the transform is therefore one
    // that cannot be evaluated ([OAR-OPS-3]) — not one whose transform is
    // quietly dropped.
    if (typeof start !== 'number' || !Number.isInteger(start) || start < 0) {
      throw new ConditionRaise('a transform span carries no non-negative integer "start"');
    }
    if (typeof end !== 'number' || !Number.isInteger(end) || end < 0) {
      throw new ConditionRaise('a transform span carries no non-negative integer "end"');
    }
    if (start > end) {
      throw new ConditionRaise('a transform span has a start beyond its end');
    }
    // [OAR-OPS-19] A span whose range falls outside the content is ignored, and
    // is explicitly not a rule that cannot be evaluated.
    if (end > length) continue;
    out.push({ start, end });
  }
  return out;
}

/**
 * [OAR-OPS-20] Spans within one transform whose ranges overlap are applied as a
 * single span covering both, rewritten once. Two spans that merely touch —
 * `[0,3)` and `[3,5)` — share no code point and so do not overlap.
 */
export function mergeSpans(spans: readonly Span[]): Span[] {
  const sorted = spans.filter(s => s.start < s.end).sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Span[] = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && span.start < span.end && last.start < last.end && span.start < last.end && last.start < span.end) {
      out[out.length - 1] = { start: Math.min(last.start, span.start), end: Math.max(last.end, span.end) };
      continue;
    }
    out.push(span);
  }
  return [...out, ...spans.filter(s => s.start === s.end)].sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * A piece of the content under construction: either a range of the original
 * code points, or the text a transform put in its place. Keeping the original
 * range on a rewritten piece is what lets a later transform's offsets still
 * refer to the content as it was at the start of the occurrence ([OAR-OPS-20])
 * while still applying to the output of the previous transform ([OAR-OPS-16]).
 */
interface Piece {
  start: number;
  end: number;
  text: string | null;
  /**
   * [OAR-OPS-21] Insertions belong to content beginning at their offset.
   * A rewrite ending there preserves them; one beginning there consumes them.
   */
  insert?: boolean;
}

function pieceText(piece: Piece, original: readonly string[]): string {
  return piece.text ?? original.slice(piece.start, piece.end).join('');
}

/** Introduce a piece boundary at an original offset, when one does not exist. */
function splitAt(pieces: Piece[], at: number): void {
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i]!;
    if (p.text === null && p.start < at && at < p.end) {
      pieces.splice(i, 1, { start: p.start, end: at, text: null }, { start: at, end: p.end, text: null });
      return;
    }
  }
}

function rewrite(
  pieces: Piece[],
  span: Span,
  make: (current: string) => string,
  original: readonly string[],
): void {
  if (span.start === span.end) { insertAt(pieces, span.end, make('')); return; }
  splitAt(pieces, span.start);
  splitAt(pieces, span.end);
  const hit: number[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i]!;
    if (p.start >= span.start && p.start < span.end) hit.push(i);
  }
  if (hit.length === 0) {
    // An empty span covers no code point, so it is an insertion at that offset.
    const at = pieces.findIndex((p) => p.start >= span.end);
    const piece: Piece = { start: span.start, end: span.end, text: make('') };
    pieces.splice(at === -1 ? pieces.length : at, 0, piece);
    return;
  }
  const first = hit[0]!;
  const last = hit[hit.length - 1]!;
  const current = pieces
    .slice(first, last + 1)
    .map((p) => pieceText(p, original))
    .join('');
  pieces.splice(first, last - first + 1, {
    start: Math.min(pieces[first]!.start, span.start),
    end: Math.max(pieces[last]!.end, span.end),
    text: make(current),
  });
}

function replacementFor(spec: TransformSpec): (current: string) => string {
  // Redact uses the standard placeholder by default ([OAR-OPS-21]).
  if (spec.action === 'redact') return () => spec.replacement ?? REDACTION_PLACEHOLDER;
  return () => spec.replacement!;
}

/** Inserts an annotation after an original-content offset ([OAR-OPS-21]). */
function insertAt(pieces: Piece[], at: number, text: string): void {
  splitAt(pieces, at);
  let index = pieces.findIndex((p) => p.start >= at && !(p.insert === true && p.start === at));
  if (index === -1) index = pieces.length;
  pieces.splice(index, 0, { start: at, end: at, text, insert: true });
}

/** Applies occurrence-ordered transforms ([OAR-OPS-16]). */
export function applyTransforms(
  content: string,
  transforms: readonly TransformSpec[],
  facts: Readonly<Record<string, unknown>> = {},
  transformFacts?: readonly unknown[],
  skipped: SkippedTransform[] = [],
  rules: readonly string[] = [],
): string {
  const original = codePoints(content);
  const pieces: Piece[] = [{ start: 0, end: original.length, text: null }];
  // Offsets retain original-content coordinates ([OAR-OPS-16]).
  const rewritten: Span[] = [];

  for (const [index, spec] of transforms.entries()) {
    // Targets resolve to content or reported spans ([OAR-OPS-14]).
    const targetFact = transformFacts !== undefined && index < transformFacts.length
      ? transformFacts[index]
      : facts[spec.target];
    const spans =
      spec.target === 'content'
        ? [{ start: 0, end: original.length }]
        : mergeSpans(readSpans(targetFact, original.length));
    const annotating = spec.action === 'annotate';
    const make = replacementFor(spec);
    const applied: Span[] = [];
    // Spans apply from highest start offset ([OAR-OPS-20]).
    for (const span of [...spans].sort((a, b) => b.start - a.start || b.end - a.end)) {
      // Rewritten spans are skipped; annotations remain zero-width.
      if (!annotating && span.start < span.end && rewritten.some((r) => r.start < r.end && span.start < r.end && r.start < span.end)) {
        skipped.push({ rule: rules[index] ?? '', start: span.start, end: span.end, reason: 'overlap' });
        continue;
      }
      if (annotating) insertAt(pieces, span.end, spec.replacement!);
      else rewrite(pieces, span, make, original);
      applied.push(span);
    }
    // [OAR-OPS-21] `annotate` removes nothing, so the code points it covers are
    // still there for a later transform to act on. It records a zero-width
    // rewritten range at the insertion point instead of the span it annotated:
    // marking the whole span rewritten would make [OAR-OPS-16] silently drop a
    // later redaction of the very text just annotated.
    if (annotating) {
      for (const span of applied) rewritten.push({ start: span.end, end: span.end });
    } else {
      rewritten.push(...applied);
    }
  }
  return pieces.map((p) => pieceText(p, original)).join('');
}

/**
 * [OAR-FACT-12] flow matches when its steps appear, in order, as a subsequence
 * of the recent activity window. The subsequence need not be contiguous.
 */
export function flowMatches(recent: readonly string[], pattern: readonly string[]): boolean {
  if (pattern.length === 0) return true;
  let i = 0;
  for (const step of recent) {
    if (step === pattern[i]) {
      i++;
      if (i === pattern.length) return true;
    }
  }
  return false;
}

/**
 * [OAR-SEL-4] Selector clauses are conjunctive. [OAR-SEL-1] a clause matches
 * when the value of the fact it names is a member of the clause's list;
 * [OAR-SEL-2] a list<string> fact matches on a non-empty intersection.
 * [OAR-SEL-8] selection matches typed machine-observable facts only — there is
 * no prose shape, keyword list, or substring search anywhere in here.
 */
export function selectorMatches(
  rule: LoadedRule,
  occ: Occurrence,
  env: Environment,
  coreAnchor: string = occ.anchor,
): boolean {
  for (const clause of rule.selector) {
    // [OAR-SEL-6] An empty clause matches nothing.
    if (clause.values.length === 0) return false;
    const decl = env.facts.get(clause.fact)!;
    const raw = clause.fact === 'anchor' ? coreAnchor : occ.facts[clause.fact];
    if (decl.type === 'list<string>') {
      // [OAR-FACT-25] An unreported fact reads as the zero value of its type.
      const value = (raw === undefined ? [] : raw) as unknown;
      if (!Array.isArray(value)) return false;
      if (!value.some((v) => typeof v === 'string' && clause.values.includes(v))) return false;
      continue;
    }
    const value = raw === undefined ? '' : raw;
    if (typeof value !== 'string' || !clause.values.includes(value)) return false;
  }
  return true;
}
