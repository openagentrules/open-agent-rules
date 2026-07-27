// The conformance runner: read the published corpus, replay each fixture, and
// report per fixture. Files are read from a local directory — the corpus runs
// offline and in CI, and never fetches anything.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { referenceAnchorProfile, referenceEnvironment } from './env.js';
import { loadRule, type Rule } from './load.js';
import { CounterStore, decide, type Detector, type Occurrence } from './decide.js';
import type { Value } from './eval.js';

export interface Fixture {
  id: string;
  title: string;
  covers: string[];
  rule: unknown;
  input: {
    anchor: string;
    facts: Record<string, Value>;
    recent_tools?: string[];
    session_id?: string;
    /** Overrides this engine's anchor profile map for the fixture. */
    profile?: { oar_profile_version: string; core: Record<string, string>; unsupported: string[] };
  };
  expected: {
    decision?: string;
    code?: string;
    on_fire?: string[];
    applied?: string[];
    counters?: Record<string, Record<string, number>>;
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

/** Replay one fixture and report what, if anything, did not match. */
export function runFixture(fx: Fixture): FixtureResult {
  const base = { id: fx.id, title: fx.title, covers: fx.covers };
  const env = referenceEnvironment();
  // A fixture whose outcome turns on which core anchors a host supports carries
  // its own profile map, so every implementation is asked the same question.
  const fixtureProfile = fx.input?.profile;
  const profile = fixtureProfile
    ? { version: fixtureProfile.oar_profile_version, core: fixtureProfile.core, unsupported: fixtureProfile.unsupported }
    : referenceAnchorProfile();
  const docs = Array.isArray(fx.rule) ? fx.rule : [fx.rule];

  let rules: Rule[] = [];
  let loadError: string | null = null;
  try {
    rules = docs.map((doc) => loadRule(doc, { env, profile, detectors: DETECTOR_REFS }));
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }

  if (fx.expected.error !== undefined) {
    if (loadError === null) {
      return { ...base, pass: false, detail: `expected a load error containing ${JSON.stringify(fx.expected.error)}, the document loaded` };
    }
    if (!loadError.includes(fx.expected.error)) {
      return { ...base, pass: false, detail: `load error ${JSON.stringify(loadError)} does not contain ${JSON.stringify(fx.expected.error)}` };
    }
    return { ...base, pass: true };
  }
  if (loadError !== null) {
    return { ...base, pass: false, detail: `unexpected load error: ${loadError}` };
  }

  const anchor = profile.core[fx.input.anchor] ?? fx.input.anchor;
  const occ: Occurrence = {
    anchor,
    facts: fx.input.facts ?? {},
    recentTools: fx.input.recent_tools ?? [],
    sessionID: fx.input.session_id,
  };
  const result = decide(rules, occ, { env, detectors: RESERVED_DETECTORS }, new CounterStore());

  const exp = fx.expected;
  if (exp.decision !== undefined) {
    const want = exp.decision.toLowerCase();
    if (want === 'none' || want === 'allow') {
      if (result.decision !== null) {
        return { ...base, pass: false, detail: `expected no actionable decision, got ${result.decision.effect} ${result.decision.code}` };
      }
    } else {
      if (result.decision === null) {
        return { ...base, pass: false, detail: `expected decision ${want}, got none` };
      }
      if (result.decision.effect !== want) {
        return { ...base, pass: false, detail: `expected effect ${want}, got ${result.decision.effect} (${result.decision.code})` };
      }
      if (exp.code !== undefined && result.decision.code !== exp.code) {
        return { ...base, pass: false, detail: `expected code ${exp.code}, got ${result.decision.code}` };
      }
      for (const action of exp.on_fire ?? []) {
        if (!result.decision.onFire.includes(action as never)) {
          return { ...base, pass: false, detail: `expected on_fire ${action}, got ${result.decision.onFire.join(', ') || 'none'}` };
        }
      }
    }
  }
  if (exp.applied !== undefined) {
    const got = result.trace.map((e) => `${e.rule}:${e.outcome}`);
    if (got.join(',') !== exp.applied.join(',')) {
      return { ...base, pass: false, detail: `applied trace = [${got.join(', ')}], want [${exp.applied.join(', ')}]` };
    }
  }
  for (const [code, want] of Object.entries(exp.counters ?? {})) {
    for (const [kind, value] of Object.entries(want)) {
      const got = result.counters[code]?.[kind] ?? 0;
      if (got !== value) {
        return { ...base, pass: false, detail: `counter ${code}/${kind} = ${got}, want ${value}` };
      }
    }
  }
  return { ...base, pass: true };
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
