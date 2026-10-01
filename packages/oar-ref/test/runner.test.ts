// The conformance runner's own obligations: it must adopt the capability
// document a fixture declares, report a fixture it cannot adopt as skipped
// rather than failed, and refuse an expected key this specification does not
// define.

import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { referenceCapabilityDocument } from '../src/capability.js';
import { runFixture, type Fixture } from '../src/runner.js';

const capability = referenceCapabilityDocument();

test('[OAR-CONF-24] the CLI flushes a complete JSON report through a pipe', () => {
  const cli = fileURLToPath(new URL('../../bin/oar-conformance.mjs', import.meta.url));
  const report = JSON.parse(execFileSync(process.execPath, [cli, '--json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  assert.equal(report.failed, 0);
  assert.equal(report.results.length, report.passed + report.failed + report.skipped);
  assert.ok(report.results.every((result: { pass: boolean; skipped: boolean }) => result.pass || result.skipped));
});

function fixture(over: Partial<Fixture> = {}): Fixture {
  return {
    id: 'synthetic',
    title: 'synthetic',
    covers: ['OAR-CONF-20'],
    rules: [{ oar: '1.0', id: 'R', kind: 'policy', anchor: 'tool.pre_invoke', effect: 'warn' }],
    input: { anchor: 'tool.pre_invoke', capability },
    expected: { decision: 'warn' },
    ...over,
  } as Fixture;
}

test('a fixture carrying an undefined expected key is rejected', () => {
  // [OAR-CONF-22] An engine must reject an expected key this specification does
  // not define, rather than passing it silently.
  const result = runFixture(fixture({ expected: { decision: 'warn', emit: 'anything' } }));
  assert.equal(result.pass, false);
  assert.equal(result.skipped, false);
  assert.match(result.detail ?? '', /undefined key "emit"/);
});

test('a fixture whose capability set cannot be adopted is skipped, not passed', () => {
  // [OAR-CONF-20], [OAR-CONF-24] A skipped fixture is not a passed fixture, and
  // the reason is reported.
  const result = runFixture(
    fixture({
      input: {
        anchor: 'tool.pre_invoke',
        capability: { ...capability, profiles: ['tool', 'telemetry'] },
      },
    }),
  );
  assert.equal(result.skipped, true);
  assert.equal(result.pass, false, 'a skipped fixture must never count as a pass');
  assert.match(result.detail ?? '', /does not implement the capability profile "telemetry"/);
});

test('a fixture with no capability document is a failure, not a fallback to the engine\'s own host', () => {
  // [OAR-CONF-19] Without one, a fixture asks each implementation a different
  // question.
  const result = runFixture(fixture({ input: { anchor: 'tool.pre_invoke' } as Fixture['input'] }));
  assert.equal(result.pass, false);
  assert.equal(result.skipped, false);
  assert.match(result.detail ?? '', /no input\.capability/);
});

test('the runner evaluates against the fixture\'s capability, not its own', () => {
  // [OAR-CONF-20] The reference engine supports every core anchor; the fixture
  // declares one unsupported, and the rule must be refused on that basis.
  const anchors = { ...(capability['anchors'] as { core: Record<string, string> }).core };
  delete anchors['agent.finalize'];
  const result = runFixture(
    fixture({
      rules: [{ oar: '1.0', id: 'R', kind: 'policy', anchor: 'agent.finalize', effect: 'warn' }],
      input: {
        anchor: 'tool.pre_invoke',
        capability: { ...capability, anchors: { core: anchors, unsupported: ['agent.finalize'] } },
      },
      expected: { error: 'declares unsupported' },
    }),
  );
  assert.equal(result.pass, true, result.detail);
});

test('an expected load error matches on substring only', () => {
  // [OAR-CONF-21] An engine is not required to match error wording beyond the
  // substring the fixture gives.
  const result = runFixture(
    fixture({
      rules: [{ oar: '9.0', id: 'R', kind: 'policy', anchor: 'tool.pre_invoke', effect: 'warn' }],
      // [OAR-CONF-30] a single machine token, never a phrase: an engine wording
      // the same defect differently must still pass.
      expected: { error: '9.0' },
    }),
  );
  assert.equal(result.pass, true, result.detail);
  assert.match(result.actual?.error ?? '', /9\.0/);
});
