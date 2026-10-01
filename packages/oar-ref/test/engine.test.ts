// Engine behaviour a conformance fixture cannot reach: the side-effect
// obligation of [OAR-FIRE-9], the purity of the reserved detectors, and the
// portability report of [OAR-PROF-8].

import assert from 'node:assert/strict';
import test from 'node:test';

import { loadCapability, referenceCapabilityDocument, referenceEnvironment } from '../src/capability.js';
import { CounterStore, decide, RESERVED_DETECTOR_IMPLS, type Occurrence } from '../src/decide.js';
import { loadRuleSet, portability } from '../src/load.js';

const env = referenceEnvironment();

function occurrence(over: Partial<Occurrence> = {}): Occurrence {
  return { anchor: 'tool.pre_invoke', facts: {}, recentActivity: [], sessionId: 's1', ...over };
}

test('a side-effect that cannot be applied is routed through on_error', () => {
  // [OAR-FIRE-9] A declared side-effect is an obligation, not a hint. An engine
  // that cannot apply one treats the rule as one that cannot be evaluated and
  // handles it per its on_error. An operator reading a decision reported as
  // applied would otherwise have no way to know the breaker never advanced.
  const set = loadRuleSet(
    [
      {
        oar: '1.0', namespace: 'oar.test', id: 'BREAKER', kind: 'policy',
        anchor: 'tool.pre_invoke', effect: 'warn', on_fire: ['increment_breaker'],
      },
    ],
    env,
  );
  const counters = new CounterStore();
  counters.failOn = new Set(['oar.test/BREAKER']);

  const result = decide(set, occurrence(), { env, counters });
  assert.equal(result.decision?.effect, 'block', 'the default on_error is fail_closed');
  assert.equal(result.decision?.rule, 'oar.test/BREAKER');
  assert.deepEqual(
    result.trace.map((e) => `${e.rule}:${e.outcome}`),
    ['oar.test/BREAKER:errored'],
    'the rule is recorded as one that could not be evaluated',
  );
  assert.deepEqual(result.onFire, [], 'no side-effect is reported as applied');
  assert.equal(result.counters['oar.test/BREAKER'], undefined, 'the breaker never advanced');
});

test('a side-effect failure under fail_open records and continues', () => {
  const set = loadRuleSet(
    [
      {
        oar: '1.0', namespace: 'oar.test', id: 'BREAKER', kind: 'policy',
        anchor: 'tool.pre_invoke', effect: 'warn', on_error: 'fail_open',
        on_fire: ['increment_breaker'],
      },
    ],
    env,
  );
  const counters = new CounterStore();
  counters.failOn = new Set(['oar.test/BREAKER']);
  const result = decide(set, occurrence(), { env, counters });
  assert.equal(result.decision, null);
  assert.deepEqual(result.trace.map((e) => e.outcome), ['errored']);
});

test('the reserved detectors are pure functions of the occurrence', () => {
  // [OAR-CONF-25] None of the three requires a model or a network:
  // detector://noop and detector://fixture report nothing at all, and
  // detector://error always fails, which is how a fixture reaches on_error.
  assert.deepEqual(Object.keys(RESERVED_DETECTOR_IMPLS).sort(), [
    'detector://error',
    'detector://fixture',
    'detector://noop',
  ]);
  const occ = occurrence({ facts: { prompt_injection_score: 0.9 } });
  assert.deepEqual(RESERVED_DETECTOR_IMPLS['detector://noop']!(occ), {});
  assert.deepEqual(
    RESERVED_DETECTOR_IMPLS['detector://fixture']!(occ),
    {},
    'detector://fixture reports no findings of its own, leaving the fixture facts in place',
  );
  // [OAR-CONF-25] With detector_facts supplied, detector://fixture produces
  // them when invoked — and only then.
  const withProduced = occurrence({ detectorFacts: { pii_entities: [{ start: 0, end: 2 }] } });
  assert.deepEqual(RESERVED_DETECTOR_IMPLS['detector://fixture']!(withProduced), {
    pii_entities: [{ start: 0, end: 2 }],
  });
  assert.throws(() => RESERVED_DETECTOR_IMPLS['detector://error']!(occ));
  // Pure: the same occurrence twice gives the same answer, and nothing mutated.
  assert.deepEqual(RESERVED_DETECTOR_IMPLS['detector://noop']!(occ), {});
  assert.deepEqual(occ.facts, { prompt_injection_score: 0.9 });
});

test('the portability report names what stops a rule travelling, and is not a load failure', () => {
  // [OAR-PROF-8] A non-portable rule is legal.
  const base = referenceCapabilityDocument();
  const hostEnv = loadCapability({
    ...base,
    host: 'acme.gateway',
    // [OAR-PROF-5] A host-native anchor loads only when the capability document
    // catalogues it.
    anchors: { ...(base['anchors'] as Record<string, unknown>), host: ['gateway.pre_render'] },
    host_facts: [{ name: 'acme.gateway.tenant_tier', type: 'string' }],
  });
  const set = loadRuleSet(
    [
      {
        oar: '1.0', namespace: 'oar.test', id: 'LOCAL', kind: 'policy',
        anchor: 'gateway.pre_render', effect: 'warn',
        requires: { facts: ['acme.gateway.tenant_tier'] },
        when: 'acme.gateway.tenant_tier == "free"',
        flow: ['read'],
      },
      {
        oar: '1.0', namespace: 'oar.test', id: 'PORTABLE', kind: 'policy',
        anchor: 'tool.pre_invoke', effect: 'warn', when: 'fire_count > 0',
      },
    ],
    hostEnv,
  );
  const [local, portable] = set.rules;
  const reasons = portability(local!, hostEnv);
  assert.ok(reasons.some((r) => r.includes('gateway.pre_render')), reasons.join('; '));
  assert.ok(reasons.some((r) => r.includes('acme.gateway.tenant_tier')), reasons.join('; '));
  assert.ok(reasons.some((r) => r.includes('flow')), reasons.join('; '));
  assert.deepEqual(portability(portable!, hostEnv), []);
});

test('counters are keyed by qualified identifier and session', () => {
  // [OAR-FIRE-5]
  const store = new CounterStore();
  store.apply('s1', 'a/R', 'increment_counter');
  store.apply('s2', 'a/R', 'increment_counter');
  store.apply('s1', 'b/R', 'increment_breaker');
  assert.equal(store.get('s1', 'a/R').fire_count, 1);
  assert.equal(store.get('s2', 'a/R').fire_count, 1);
  assert.equal(store.get('s1', 'b/R').fire_count, 0);
  assert.equal(store.get('s1', 'b/R').breaker_count, 1);
});
