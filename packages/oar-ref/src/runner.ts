import { toolFingerprint } from './canonical.js';
// The conformance runner evaluates local fixtures against declared capabilities.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { adoptionObstacle, loadCapability } from './capability.js';
import { applyConfigs } from './config.js';
import { CounterStore, decide, RESERVED_DETECTOR_IMPLS, type Result } from './decide.js';
import { loadRuleSet } from './load.js';
import type { Enforcement } from './vocab.js';

/**
 * [OAR-CONF-31] One member of the multi-occurrence spelling: an anchor, its own
 * facts and activity window, the content at that occurrence, and optionally its
 * own `expected` asserting what that occurrence resolved to.
 */
export interface FixtureOccurrence {
  readonly anchor: string;
  readonly facts?: Record<string, unknown>;
  /** [OAR-CONF-25] Facts detector://fixture produces when a rule invokes it. */
  readonly detector_facts?: Record<string, unknown>;
  readonly recent_activity?: readonly string[];
  readonly tool_call?: { readonly name: string; readonly arguments: Record<string, unknown> };
  readonly content?: string;
  readonly expected?: Record<string, unknown>;
}

export interface Fixture {
  readonly id: string;
  readonly title?: string;
  readonly covers: readonly string[];
  readonly rules: readonly unknown[];
  readonly input: {
    readonly anchor?: string;
    readonly capability: unknown;
    readonly facts?: Record<string, unknown>;
    /** [OAR-CONF-25] Facts detector://fixture produces when a rule invokes it. */
    readonly detector_facts?: Record<string, unknown>;
    readonly recent_activity?: readonly string[];
  readonly tool_call?: { readonly name: string; readonly arguments: Record<string, unknown> };
    readonly session_id?: string;
    readonly config?: readonly unknown[];
    /** [OAR-CONF-34] The content at the occurrence, for a content anchor. */
    readonly content?: string;
    /** [OAR-CONF-31] The multi-occurrence spelling. */
    readonly occurrences?: readonly FixtureOccurrence[];
  };
  readonly expected: Record<string, unknown>;
}

export interface Manifest {
  readonly oar: string;
  readonly fixtures: readonly { id: string; file: string; title: string; covers: string[] }[];
}

/** What the engine actually produced, in the shape `expected` asserts. */
export interface Actual {
  decision?: string;
  code?: string;
  rule?: string;
  applied?: string[];
  on_fire?: string[];
  transforms?: unknown[];
  skipped_transforms?: unknown[];
  counters?: Record<string, Record<string, number>>;
  events?: ActualEvent[];
  /** [OAR-CONF-34] The content after the accumulated transforms were applied. */
  content?: string;
  /** [OAR-COPY-7] Rendered copy of the winning rule. */
  copy?: Record<string, string>;
  /** [OAR-EVAL-20] Accumulated advisories, in evaluation order. */
  advisories?: ActualAdvisory[];
  error?: string;
}

export interface ActualEvent {
  rule: string;
  anchor: string;
  effect: string;
}

export interface ActualAdvisory {
  code?: string;
  rule?: string;
  copy?: Record<string, string>;
}

export interface FixtureResult {
  readonly id: string;
  readonly title: string;
  readonly covers: readonly string[];
  readonly pass: boolean;
  /** [OAR-CONF-20], [OAR-CONF-24] A skipped fixture is not a passed fixture. */
  readonly skipped: boolean;
  readonly detail?: string;
  readonly actual?: Actual;
}

const EXPECTED_KEYS = new Set([
  'decision',
  'code',
  'rule',
  'on_fire',
  'transforms', 'skipped_transforms',
  'advisories',
  'applied',
  'counters',
  'events',
  'content',
  'copy',
  'error',
]);

export async function loadManifest(dir: string): Promise<Manifest> {
  return JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as Manifest;
}

export async function loadFixtures(dir: string): Promise<Fixture[]> {
  const names = (await readdir(dir))
    .filter((n) => n.endsWith('.json') && n !== 'manifest.json' && n !== 'exempt.json')
    .sort();
  const out: Fixture[] = [];
  for (const name of names) {
    out.push(JSON.parse(await readFile(join(dir, name), 'utf8')) as Fixture);
  }
  return out;
}

/** Replay one fixture and report what, if anything, did not match. */
export function runFixture(fx: Fixture): FixtureResult {
  const base = { id: fx.id, title: fx.title ?? fx.id, covers: fx.covers };

  // [OAR-CONF-22] An expected key this specification does not define is a
  // rejection, not a silent pass.
  for (const key of Object.keys(fx.expected)) {
    if (!EXPECTED_KEYS.has(key)) {
      return { ...base, pass: false, skipped: false, detail: `expected carries undefined key ${JSON.stringify(key)}` };
    }
  }

  // [OAR-CONF-19] Every fixture declares the host it assumes.
  if (fx.input?.capability === undefined) {
    return { ...base, pass: false, skipped: false, detail: 'fixture carries no input.capability' };
  }
  // Fixtures supply their capability document ([OAR-CONF-20]).
  const obstacle = adoptionObstacle(fx.input.capability);
  if (obstacle !== null) {
    return { ...base, pass: false, skipped: true, detail: obstacle };
  }

  // [OAR-CONF-31] `occurrences` is the multi-occurrence spelling; a fixture
  // without one describes a single occurrence taken from `input` directly. Both
  // run as one session against one counter store, each occurrence's side-effects
  // applied before the next is evaluated.
  const single: FixtureOccurrence = {
    anchor: fx.input.anchor ?? '',
    ...(fx.input.facts === undefined ? {} : { facts: fx.input.facts }),
    ...(fx.input.detector_facts === undefined ? {} : { detector_facts: fx.input.detector_facts }),
    ...(fx.input.recent_activity === undefined ? {} : { recent_activity: fx.input.recent_activity }),
    ...(fx.input.content === undefined ? {} : { content: fx.input.content }),
    ...(fx.input.tool_call === undefined ? {} : { tool_call: fx.input.tool_call }),
  };
  const occurrences: readonly FixtureOccurrence[] = fx.input.occurrences ?? [single];

  const actual: Actual = {};
  // The fixture-level expected.counters describes the values in force after
  // every occurrence, so per-occurrence reports are merged in order.
  const cumulative: Record<string, Record<string, number>> = {};
  const perOccurrence: { at: number; actual: Actual; expected?: Record<string, unknown> }[] = [];

  try {
    const env = loadCapability(fx.input.capability);
    const set = loadRuleSet(fx.rules, env);
    let enforcement: ReadonlyMap<string, Enforcement> = new Map();
    if (fx.input.config !== undefined) enforcement = applyConfigs(fx.input.config, set);
    const counters = new CounterStore();
    const activity: string[] = [];

    for (let at = 0; at < occurrences.length; at++) {
      const occ = occurrences[at]!;
      const callFacts = occ.tool_call === undefined ? {} : { tool: occ.tool_call.name, tool_args: occ.tool_call.arguments, tool_args_fingerprint: toolFingerprint(occ.tool_call.name, occ.tool_call.arguments) };
      const result: Result = decide(
        set,
        {
          anchor: occ.anchor,
          facts: { ...callFacts, ...occ.facts },
          recentActivity: occ.recent_activity ?? activity,
          sessionId: fx.input.session_id ?? 'fixture',
          ...(occ.content === undefined ? {} : { content: occ.content }),
          ...(occ.detector_facts === undefined ? {} : { detectorFacts: occ.detector_facts }),
        },
        { env, detectors: RESERVED_DETECTOR_IMPLS, counters, enforcement },
      );
      if (env.coreForLocal.get(occ.anchor) === 'tool.pre_invoke' && result.decision?.effect !== 'block' && occ.tool_call !== undefined && env.activityWindow > 0) {
        activity.push(occ.tool_call.name);
        activity.splice(0, Math.max(0, activity.length - env.activityWindow));
      }
      const seen = report(result);
      for (const [key, pair] of Object.entries(seen.counters ?? {})) cumulative[key] = pair;
      perOccurrence.push({ at, actual: seen, ...(occ.expected === undefined ? {} : { expected: occ.expected }) });
    }
  } catch (err) {
    actual.error = err instanceof Error ? err.message : String(err);
    const want = fx.expected['error'];
    if (typeof want !== 'string') {
      return { ...base, pass: false, skipped: false, detail: `unexpected load error: ${actual.error}`, actual };
    }
    // [OAR-CONF-21] `error` matches when the engine's error contains the given
    // text; an engine is not required to match wording beyond that substring.
    if (!actual.error.includes(want)) {
      return {
        ...base,
        pass: false,
        skipped: false,
        detail: `load error ${JSON.stringify(actual.error)} does not contain ${JSON.stringify(want)}`,
        actual,
      };
    }
    return { ...base, pass: true, skipped: false, actual };
  }

  // [OAR-CONF-31] The fixture-level expected describes the final occurrence.
  const last = perOccurrence[perOccurrence.length - 1]!;
  Object.assign(actual, last.actual);
  actual.counters = cumulative;

  if (typeof fx.expected['error'] === 'string') {
    return {
      ...base,
      pass: false,
      skipped: false,
      detail: `expected a load error containing ${JSON.stringify(fx.expected['error'])}, the rule set loaded`,
      actual,
    };
  }

  const fail = (detail: string): FixtureResult => ({ ...base, pass: false, skipped: false, detail, actual });

  // Per-occurrence failures retain their occurrence index.
  for (const entry of perOccurrence) {
    if (entry.expected === undefined) continue;
    const where = `occurrence ${entry.at + 1} of ${perOccurrence.length}: `;
    const detail = compare(entry.actual, entry.expected, occurrences[entry.at]!);
    if (detail !== null) return fail(where + detail);
  }

  const detail = compare({ ...last.actual, counters: cumulative }, fx.expected, occurrences[last.at]!);
  if (detail !== null) return fail(detail);
  return { ...base, pass: true, skipped: false, actual };
}

/** Project one engine result into the shape `expected` asserts. */
function report(result: Result): Actual {
  const counters: Record<string, Record<string, number>> = {};
  for (const [key, pair] of Object.entries(result.counters)) {
    counters[key] = { fire_count: pair.fire_count, breaker_count: pair.breaker_count };
  }
  return {
    decision: result.decision?.effect ?? 'none',
    ...(result.decision === null ? {} : { code: result.decision.code, rule: result.decision.rule }),
    applied: result.trace.map((e) => `${e.rule}:${e.outcome}`),
    on_fire: [...result.onFire],
    transforms: [...result.transforms],
    skipped_transforms: [...result.skippedTransforms],
    counters,
    events: result.events.map((event) => ({ ...event })),
    ...(result.content === undefined ? {} : { content: result.content }),
    ...(result.decision === null || Object.keys(result.decision.copy).length === 0
      ? {}
      : { copy: { ...result.decision.copy } }),
    // [OAR-EVAL-20] Always report the list so a fixture can assert emptiness
    // when the winning effect is not advisory.
    advisories: (result.decision?.advisories ?? []).map((a) => ({
      code: a.code,
      rule: a.rule,
      ...(Object.keys(a.copy).length === 0 ? {} : { copy: { ...a.copy } }),
    })),
  };
}

/** Compare one occurrence's outcome against what a fixture asserted about it. */
function compare(
  actual: Actual,
  expected: Record<string, unknown>,
  occ: FixtureOccurrence,
): string | null {
  if (expected['skipped_transforms'] !== undefined && !isDeepStrictEqual(actual.skipped_transforms, expected['skipped_transforms'])) return 'skipped_transforms differs';
  if (expected['decision'] !== undefined && actual.decision !== expected['decision']) {
    return `decision = ${String(actual.decision)}, want ${String(expected['decision'])}`;
  }
  if (expected['code'] !== undefined && actual.code !== expected['code']) {
    return `code = ${String(actual.code)}, want ${String(expected['code'])}`;
  }
  if (expected['rule'] !== undefined && actual.rule !== expected['rule']) {
    return `rule = ${String(actual.rule)}, want ${String(expected['rule'])}`;
  }
  if (expected['applied'] !== undefined) {
    const want = expected['applied'] as string[];
    const got = actual.applied ?? [];
    if (got.join(',') !== want.join(',')) {
      return `applied = [${got.join(', ')}], want [${want.join(', ')}]`;
    }
  }
  if (expected['on_fire'] !== undefined) {
    const want = expected['on_fire'] as string[];
    const got = actual.on_fire ?? [];
    if (got.join(',') !== want.join(',')) {
      return `on_fire = [${got.join(', ')}], want [${want.join(', ')}]`;
    }
  }
  if (expected['events'] !== undefined) {
    const want = JSON.stringify(expected['events']);
    const got = JSON.stringify(actual.events ?? []);
    if (got !== want) return `events = ${got}, want ${want}`;
  }
  if (expected['transforms'] !== undefined) {
    const want = JSON.stringify(expected['transforms']);
    const got = JSON.stringify(actual.transforms ?? []);
    if (got !== want) return `transforms = ${got}, want ${want}`;
  }
  if (expected['content'] !== undefined) {
    // [OAR-CONF-34] A fixture asserting expected.content must supply content.
    if (occ.content === undefined) {
      return 'asserts expected.content without supplying input.content';
    }
    // Compared by code point sequence.
    const want = [...(expected['content'] as string)].join('');
    const got = [...(actual.content ?? '')].join('');
    if (got !== want) return `content = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`;
  }
  if (expected['copy'] !== undefined) {
    const want = expected['copy'] as Record<string, string>;
    const got = actual.copy ?? {};
    for (const [key, value] of Object.entries(want)) {
      if (got[key] !== value) {
        return `copy.${key} = ${JSON.stringify(got[key])}, want ${JSON.stringify(value)}`;
      }
    }
  }
  if (expected['advisories'] !== undefined) {
    // [OAR-CONF-37] Compare by length and order; a fixture asserts only the
    // members it is about on each item.
    const want = expected['advisories'] as ActualAdvisory[];
    const got = actual.advisories ?? [];
    if (got.length !== want.length) {
      return `advisories length = ${got.length}, want ${want.length}`;
    }
    for (let i = 0; i < want.length; i++) {
      const w = want[i]!;
      const g = got[i]!;
      if (w.code !== undefined && g.code !== w.code) {
        return `advisories[${i}].code = ${JSON.stringify(g.code)}, want ${JSON.stringify(w.code)}`;
      }
      if (w.rule !== undefined && g.rule !== w.rule) {
        return `advisories[${i}].rule = ${JSON.stringify(g.rule)}, want ${JSON.stringify(w.rule)}`;
      }
      if (w.copy !== undefined) {
        const gotCopy = g.copy ?? {};
        for (const [key, value] of Object.entries(w.copy)) {
          if (gotCopy[key] !== value) {
            return `advisories[${i}].copy.${key} = ${JSON.stringify(gotCopy[key])}, want ${JSON.stringify(value)}`;
          }
        }
      }
    }
  }
  if (expected['counters'] !== undefined) {
    for (const [key, wanted] of Object.entries(expected['counters'] as Record<string, Record<string, number>>)) {
      for (const [name, value] of Object.entries(wanted)) {
        // [OAR-CONF-21] An asserted zero matches an absent entry: an engine
        // reports only the counters an occurrence changed.
        const got = actual.counters?.[key]?.[name] ?? 0;
        if (got !== value) return `counter ${key}/${name} = ${got}, want ${value}`;
      }
    }
  }
  return null;
}

export interface RunReport {
  readonly results: readonly FixtureResult[];
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly clauses: readonly string[];
}

export async function runCorpus(dir: string): Promise<RunReport> {
  const results = (await loadFixtures(dir)).map(runFixture);
  const clauses = new Set<string>();
  for (const r of results) if (!r.skipped) for (const c of r.covers) clauses.add(c);
  return {
    results,
    passed: results.filter((r) => r.pass).length,
    failed: results.filter((r) => !r.pass && !r.skipped).length,
    skipped: results.filter((r) => r.skipped).length,
    clauses: [...clauses].sort(),
  };
}
