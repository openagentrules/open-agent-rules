// The conformance runner: read the published corpus, replay each fixture, and
// report per fixture. Files are read from a local directory — the corpus runs
// offline and in CI, and never fetches anything.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { referenceAnchorProfile, referenceEnvironment, validateAnchorProfile, withHostFacts, type Environment } from './env.js';
import { loadRuleSet, type Rule } from './load.js';
import { CounterStore, decide, ENGINE_MAINTAINED, type Detector, type Occurrence } from './decide.js';
import type { Value } from './eval.js';

export interface Fixture {
  id: string;
  title: string;
  covers: string[];
  /** One rule document or an array of them. */
  rule: unknown;
  /** Hint documents loaded alongside the rules; they never perturb a decision. */
  hints?: unknown[];
  input: {
    anchor: string;
    facts: Record<string, Value>;
    recent_tools?: string[];
    session_id?: string;
    /** Host-declared facts, name to declared type ([OAR-FACT-19]). */
    host_facts?: Record<string, string>;
    /** Overrides this engine's anchor profile map for the fixture. */
    profile?: { oar_profile_version: string; core: Record<string, string>; unsupported: string[] };
    /** Earlier occurrences, evaluated in order in the same session before this one. */
    occurrences?: { anchor: string; facts: Record<string, Value>; recent_tools?: string[] }[];
  };
  expected: {
    decision?: string;
    code?: string;
    on_fire?: string[];
    applied?: string[];
    counters?: Record<string, Record<string, number>>;
    /** Rendered copy members to assert; `null` asserts the decision carries no copy. */
    copy?: Record<string, string> | null;
    error?: string;
  };
}

export interface Manifest {
  spec_version: string;
  fixtures: { id: string; file: string; title: string; covers: string[] }[];
}

export interface FixtureResult {
  readonly id: string;
  readonly title: string;
  readonly covers: readonly string[];
  readonly pass: boolean;
  readonly detail?: string;
  /** What the engine actually produced, for comparison across engines. */
  readonly actual?: Verdict;
}

export interface Verdict {
  readonly error?: string;
  readonly decision?: string;
  readonly code?: string | null;
  readonly applied?: readonly string[];
  readonly on_fire?: readonly string[];
  readonly counters?: Readonly<Record<string, Record<string, number>>>;
  readonly copy?: Readonly<Record<string, string>> | null;
}

// The three detector references the corpus reserves. None needs a model or a
// network: detector://fixture leaves the facts the fixture supplied in place,
// which is how a fixture proves the rule owns the threshold.
const RESERVED_DETECTORS: Record<string, Detector> = {
  'detector://noop': () => ({}),
  'detector://fixture': () => ({}),
  'detector://error': () => {
    throw new Error('detector://error always fails');
  },
};

const DETECTOR_REFS = Object.keys(RESERVED_DETECTORS);

export async function loadManifest(dir: string): Promise<Manifest> {
  const raw = await readFile(join(dir, 'manifest.json'), 'utf8');
  return JSON.parse(raw) as Manifest;
}

export async function loadFixtures(dir: string): Promise<Fixture[]> {
  const names = (await readdir(dir))
    .filter((n) => n.endsWith('.json') && n !== 'manifest.json' && n !== 'exempt.json')
    .sort();
  const out: Fixture[] = [];
  for (const name of names) {
    const raw = await readFile(join(dir, name), 'utf8');
    out.push(JSON.parse(raw) as Fixture);
  }
  return out;
}

// The closed fixture vocabulary ([OAR-CONF-13], [OAR-CONF-15]).
const FIXTURE_KEYS = new Set(['id', 'title', 'covers', 'rule', 'hints', 'input', 'expected']);
const INPUT_KEYS = new Set(['anchor', 'facts', 'recent_tools', 'session_id', 'host_facts', 'profile', 'occurrences']);
const OCCURRENCE_KEYS = new Set(['anchor', 'facts', 'recent_tools']);
const EXPECTED_KEYS = new Set(['decision', 'code', 'on_fire', 'applied', 'counters', 'copy', 'error']);

/** The first member outside the fixture vocabulary, or null when the shape is closed. */
export function fixtureShapeError(fx: Fixture): string | null {
  const record = fx as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!FIXTURE_KEYS.has(key)) return `fixture carries undefined member ${JSON.stringify(key)}`;
  }
  for (const key of ['input', 'expected']) {
    if (record[key] === undefined) return `fixture is missing ${JSON.stringify(key)}`;
  }
  if (record['rule'] === undefined && record['hints'] === undefined) {
    return 'fixture carries neither "rule" nor "hints"';
  }
  for (const key of Object.keys(fx.input ?? {})) {
    if (!INPUT_KEYS.has(key)) return `input carries undefined member ${JSON.stringify(key)}`;
  }
  for (const key of Object.keys(fx.expected ?? {})) {
    if (!EXPECTED_KEYS.has(key)) return `expected carries undefined key ${JSON.stringify(key)}`;
  }
  for (const occ of fx.input?.occurrences ?? []) {
    for (const key of Object.keys(occ)) {
      if (!OCCURRENCE_KEYS.has(key)) return `occurrence carries undefined member ${JSON.stringify(key)}`;
    }
  }
  // [OAR-CONF-13] Engine-maintained facts are reached through occurrences, never supplied.
  for (const facts of [fx.input?.facts ?? {}, ...(fx.input?.occurrences ?? []).map((o) => o.facts ?? {})]) {
    for (const name of ENGINE_MAINTAINED) {
      if (name in facts) return `facts supply ${name}, which the engine maintains itself [OAR-FIRE-10]`;
    }
  }
  if (fx.input?.occurrences && fx.input.session_id === undefined) {
    return 'occurrences need a session_id to share';
  }
  return null;
}

/** Replay one fixture and report what, if anything, did not match. */
export function runFixture(fx: Fixture): FixtureResult {
  const base = { id: fx.id, title: fx.title, covers: fx.covers };
  // [OAR-CONF-15] An undefined expected key is refused, never passed silently.
  const shapeError = fixtureShapeError(fx);
  if (shapeError !== null) {
    return { ...base, pass: false, detail: shapeError };
  }
  let env: Environment = referenceEnvironment();
  // A fixture whose outcome turns on which core anchors a host supports carries
  // its own profile map, so every implementation is asked the same question.
  const fixtureProfile = fx.input?.profile;
  const ruleDocs = Array.isArray(fx.rule) ? fx.rule : fx.rule !== undefined ? [fx.rule] : [];
  const hintDocs = Array.isArray(fx.hints) ? fx.hints : [];

  let rules: Rule[] = [];
  let profile = referenceAnchorProfile();
  let loadError: string | null = null;
  try {
    if (fixtureProfile) {
      profile = validateAnchorProfile({
        version: fixtureProfile.oar_profile_version,
        core: fixtureProfile.core ?? {},
        unsupported: fixtureProfile.unsupported ?? [],
      });
    }
    if (fx.input?.host_facts) env = withHostFacts(env, fx.input.host_facts);
    rules = loadRuleSet(ruleDocs, hintDocs, { env, profile, detectors: DETECTOR_REFS }).rules;
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }

  if (loadError !== null) {
    const actual: Verdict = { error: loadError };
    if (fx.expected.error === undefined) {
      return { ...base, pass: false, detail: `unexpected load error: ${loadError}`, actual };
    }
    if (!loadError.includes(fx.expected.error)) {
      return { ...base, pass: false, detail: `load error ${JSON.stringify(loadError)} does not contain ${JSON.stringify(fx.expected.error)}`, actual };
    }
    return { ...base, pass: true, actual };
  }
  if (fx.expected.error !== undefined) {
    return { ...base, pass: false, detail: `expected a load error containing ${JSON.stringify(fx.expected.error)}, the document loaded` };
  }

  const toOccurrence = (o: { anchor: string; facts?: Record<string, Value>; recent_tools?: string[] }): Occurrence => ({
    anchor: profile.core[o.anchor] ?? o.anchor,
    facts: o.facts ?? {},
    recentTools: o.recent_tools ?? [],
    sessionID: fx.input.session_id,
  });
  const store = new CounterStore();
  const opts = { env, detectors: RESERVED_DETECTORS };
  let result: ReturnType<typeof decide>;
  try {
    for (const earlier of fx.input.occurrences ?? []) decide(rules, toOccurrence(earlier), opts, store);
    result = decide(rules, toOccurrence(fx.input), opts, store);
  } catch (err) {
    return { ...base, pass: false, detail: `engine error: ${err instanceof Error ? err.message : String(err)}` };
  }

  const actual: Verdict = {
    decision: result.decision?.effect ?? 'none',
    code: result.decision?.code ?? null,
    applied: result.trace.map((e) => `${e.rule}:${e.outcome}`),
    on_fire: result.decision?.onFire ?? [],
    counters: result.counters,
    copy: result.decision?.copy ?? null,
  };
  const check = checkExpected(fx, result);
  return check === null ? { ...base, pass: true, actual } : { ...base, pass: false, detail: check, actual };
}

/** The first way the result misses the fixture's expectation, or null. */
function checkExpected(fx: Fixture, result: ReturnType<typeof decide>): string | null {
  const exp = fx.expected;
  if (exp.decision !== undefined) {
    const want = exp.decision.toLowerCase();
    if (want === 'none' || want === 'allow') {
      if (result.decision !== null) {
        return `expected no actionable decision, got ${result.decision.effect} ${result.decision.code}`;
      }
    } else {
      if (result.decision === null) {
        return `expected decision ${want}, got none`;
      }
      if (result.decision.effect !== want) {
        return `expected effect ${want}, got ${result.decision.effect} (${result.decision.code})`;
      }
      if (exp.code !== undefined && result.decision.code !== exp.code) {
        return `expected code ${exp.code}, got ${result.decision.code}`;
      }
      for (const action of exp.on_fire ?? []) {
        if (!result.decision.onFire.includes(action as never)) {
          return `expected on_fire ${action}, got ${result.decision.onFire.join(', ') || 'none'}`;
        }
      }
    }
  }
  if (exp.applied !== undefined) {
    const got = result.trace.map((e) => `${e.rule}:${e.outcome}`);
    if (got.join(',') !== exp.applied.join(',')) {
      return `applied trace = [${got.join(', ')}], want [${exp.applied.join(', ')}]`;
    }
  }
  if (exp.copy !== undefined) {
    if (result.decision === null) {
      return 'expected rendered copy, got no decision';
    }
    if (exp.copy === null) {
      if (result.decision.copy !== undefined) {
        return `expected no copy, got ${JSON.stringify(result.decision.copy)}`;
      }
    } else {
      for (const [member, want] of Object.entries(exp.copy)) {
        const got = result.decision.copy?.[member];
        if (got !== want) {
          return `copy ${member} = ${JSON.stringify(got ?? null)}, want ${JSON.stringify(want)}`;
        }
      }
    }
  }
  for (const [code, want] of Object.entries(exp.counters ?? {})) {
    for (const [kind, value] of Object.entries(want)) {
      const got = result.counters[code]?.[kind] ?? 0;
      if (got !== value) {
        return `counter ${code}/${kind} = ${got}, want ${value}`;
      }
    }
  }
  return null;
}

export interface RunReport {
  readonly results: readonly FixtureResult[];
  readonly passed: number;
  readonly failed: number;
  readonly clauses: readonly string[];
}

export async function runCorpus(dir: string): Promise<RunReport> {
  const fixtures = await loadFixtures(dir);
  const results = fixtures.map(runFixture);
  const clauses = new Set<string>();
  for (const r of results) for (const c of r.covers) clauses.add(c);
  return {
    results,
    passed: results.filter((r) => r.pass).length,
    failed: results.filter((r) => !r.pass).length,
    clauses: [...clauses].sort(),
  };
}
